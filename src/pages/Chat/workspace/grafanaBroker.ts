import {
  config,
  getBackendSrv,
  getDataSourceSrv,
  isFetchError,
  locationService,
  type FetchResponse,
} from '@grafana/runtime';
import { findPanelAlertRules, getAlertRule } from '../domain/alerts';
import {
  getMetricNeighborhood,
  inspectDashboardMetricUsage,
  searchDashboardMetricUsage,
} from '../domain/dashboardMetricContext';
import { renderDashboardScreenshot } from '../domain/dashboards';
import { formatBackendFetchError } from '../domain/client';
import {
  getDatasourceResource,
  getPrometheusDatasource,
  getPrometheusDatasourceSettings,
  runPrometheusQuerySummaryOrValidationError,
} from '../domain/metrics';
import type { GrafanaToolConfig, PrometheusMetadataResponse } from '../domain/types';
import { PLUGIN_ID } from '../../../constants';
import { ALERT_RULE_API_GROUP, alertRuleWriteBody, toAlertRuleSnapshot } from './alertRuleModel';
import type {
  AlertRuleBroker,
  DashboardBroker,
  DashboardDryRunResult,
  DashboardWriteResult,
  JsonnetBroker,
  PrometheusBroker,
  WorkspaceBroker,
} from './broker';
import { DASHBOARD_API_GROUP } from './dashboardModel';
import { createLogsBroker, type FieldCapsResponse } from './logs';
import { sha256Hex } from './hash';
import type { PromqlParser } from './promqlCheck';
import type { WorkspaceResourceMeta, WorkspaceResourceSnapshot } from './types';
import type {
  JsonnetEvalResponse,
  JsonnetFixRequest,
  JsonnetFixResponse,
  JsonnetLibFilesRequest,
  JsonnetLibFilesResponse,
  PromQLParseRequest,
  PromQLParseResponse,
} from '../../../generated/api';

const FOLDER_ANNOTATION = 'grafana.app/folder';
const MANAGED_BY_ANNOTATION = 'grafana.app/managedBy';
const MANAGER_ALLOWS_EDITS_ANNOTATION = 'grafana.app/managerAllowsEdits';
const PREFERRED_VERSIONS = ['v1', 'v1beta1', 'v0alpha1'];
const MAX_QUERY_SERIES = 20;

type K8sResource = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    resourceVersion?: string;
    generation?: number;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
  };
  spec?: Record<string, unknown>;
  status?: { conversion?: { failed?: boolean; storedVersion?: string; error?: string } };
};

type RequestResult<T> = { ok: true; status: number; data: T } | { ok: false; status?: number; message: string };

export function createGrafanaWorkspaceBroker(toolConfig: GrafanaToolConfig): WorkspaceBroker {
  return {
    dashboards: createDashboardBroker(toolConfig),
    prometheus: createPrometheusBroker(toolConfig),
    logs: createLogsBroker(toolConfig.logDatasources, {
      datasources: () =>
        getDataSourceSrv()
          .getList({ type: 'elasticsearch' })
          .map((ds) => ({ uid: ds.uid, name: ds.name, type: ds.type, jsonData: { ...ds.jsonData } })),
      fieldCaps: async (uid, index, signal) =>
        responseData(
          await request<FieldCapsResponse>(
            'GET',
            `/api/datasources/uid/${encodeURIComponent(uid)}/resources/${encodeURIComponent(index)}/_field_caps`,
            undefined,
            signal
          )
        ),
      msearch: async (uid, searches, signal) => {
        const body = searches.map(
          (search) => `${JSON.stringify({ index: search.index })}\n${JSON.stringify(search.body)}\n`
        );
        const response = await request<{ responses?: unknown[] }>(
          'POST',
          `/api/datasources/uid/${encodeURIComponent(uid)}/resources/_msearch`,
          body.join(''),
          signal,
          { 'Content-Type': 'application/x-ndjson' }
        );
        return responseData(response).responses ?? [];
      },
    }),
    datasources: () =>
      getDataSourceSrv()
        .getList({ all: true })
        .map((ds) => ({ uid: ds.uid, name: ds.name, type: ds.type, isDefault: ds.isDefault })),
    jsonnet: createJsonnetBroker(),
    promql: createPromqlParser(),
    alerts: {
      findPanelRules: (params, signal) => findPanelAlertRules(params, toolConfig, signal),
      getRule: (params, signal) => getAlertRule(params, toolConfig, signal),
    },
    alertRules: createAlertRuleBroker(toolConfig),
    metricUsage: {
      inspect: (params, options) => inspectDashboardMetricUsage(params, toolConfig, options),
      search: (params, signal) => searchDashboardMetricUsage(params, toolConfig, signal),
      neighborhood: (params, signal) => getMetricNeighborhood(params, toolConfig, signal),
    },
    ui: {
      navigate: (path) => locationService.push(path),
      screenshot: renderDashboardScreenshot,
    },
  };
}

function createPromqlParser(): PromqlParser {
  return {
    name: 'prometheus',
    async parse(queries, signal) {
      const response = await request<PromQLParseResponse>(
        'POST',
        `/api/plugins/${PLUGIN_ID}/resources/promql/parse`,
        { queries } satisfies PromQLParseRequest,
        signal
      );
      if (!response.ok) {
        throw new Error(`PromQL parser unavailable: ${response.message}`);
      }
      return response.data.results ?? [];
    },
  };
}

let libraryListing: Promise<JsonnetLibFilesResponse> | undefined;
const libraryPackages = new Map<string, Promise<Record<string, string>>>();

function createJsonnetBroker(): JsonnetBroker {
  const resource = async <T>(path: string, data: unknown, signal?: AbortSignal) => {
    const response = await request<T>('POST', `/api/plugins/${PLUGIN_ID}/resources${path}`, data, signal);
    if (!response.ok) {
      throw new Error(jsonnetErrorMessage(response.message));
    }
    return response.data;
  };
  return {
    async evaluate(evalRequest, signal) {
      return (await resource<JsonnetEvalResponse>('/jsonnet/eval', evalRequest, signal)).output;
    },
    fix: (source, signal) =>
      resource<JsonnetFixResponse>('/jsonnet/fix', { source } satisfies JsonnetFixRequest, signal),
    async listLibraryFiles(signal) {
      // The vendored libraries are static for a plugin build; share one listing.
      libraryListing ??= resource<JsonnetLibFilesResponse>(
        '/jsonnet-libs/files',
        {} satisfies JsonnetLibFilesRequest,
        signal
      ).catch((error) => {
        libraryListing = undefined;
        throw error;
      });
      return libraryListing;
    },
    loadLibraryPackage(pkg, signal) {
      let loaded = libraryPackages.get(pkg);
      if (!loaded) {
        loaded = resource<JsonnetLibFilesResponse>(
          '/jsonnet-libs/files',
          { package: pkg } satisfies JsonnetLibFilesRequest,
          signal
        ).then((data) => Object.fromEntries(data.files.map((file) => [file.path, file.content ?? ''])));
        loaded.catch(() => libraryPackages.delete(pkg));
        libraryPackages.set(pkg, loaded);
      }
      return loaded;
    },
  };
}

/** Strips the Grafana request wrapper so Jsonnet diagnostics read like the CLI. */
function jsonnetErrorMessage(message: string) {
  const index = message.indexOf('/jsonnet/eval: ');
  const trimmed = index >= 0 ? message.slice(index + '/jsonnet/eval: '.length) : message;
  return trimmed.replace(/ Trace ID: [a-f0-9]+\.$/, '');
}

function createDashboardBroker(toolConfig: GrafanaToolConfig): DashboardBroker {
  let versionPromise: Promise<string> | undefined;
  const namespace = () => config.namespace || 'default';
  const preferredVersion = () => {
    versionPromise ??= discoverDashboardVersion().catch((error) => {
      versionPromise = undefined;
      throw error;
    });
    return versionPromise;
  };
  const collection = (version: string) =>
    `/apis/${DASHBOARD_API_GROUP}/${version}/namespaces/${encodeURIComponent(namespace())}/dashboards`;

  const get = async (uid: string, signal?: AbortSignal): Promise<WorkspaceResourceSnapshot | undefined> => {
    const version = await preferredVersion();
    const response = await request<K8sResource>(
      'GET',
      `${collection(version)}/${encodeURIComponent(uid)}`,
      undefined,
      signal
    );
    if (!response.ok) {
      if (response.status === 404 || response.status === 403) {
        return undefined;
      }
      throw new Error(response.message);
    }
    const conversion = response.data.status?.conversion;
    if (conversion?.failed && conversion.storedVersion && conversion.storedVersion !== version) {
      // The dashboard cannot be represented losslessly in the preferred version;
      // edit it in the version Grafana stored it in instead of flattening it.
      const fallback = await request<K8sResource>(
        'GET',
        `${collection(conversion.storedVersion)}/${encodeURIComponent(uid)}`,
        undefined,
        signal
      );
      if (!fallback.ok) {
        throw new Error(fallback.message);
      }
      return toSnapshot(fallback.data, { preferredVersion: version, error: conversion.error || undefined });
    }
    return toSnapshot(response.data);
  };

  const prepareWrite = async (
    method: 'POST' | 'PUT',
    document: unknown,
    resourceVersion: string | undefined,
    signal?: AbortSignal
  ) => {
    const resource = document as K8sResource;
    const uid = resource.metadata?.name;
    const version = apiVersionPath(resource.apiVersion) ?? (await preferredVersion());
    if (!uid) {
      return undefined;
    }
    let annotations = resource.metadata?.annotations ?? {};
    let labels = resource.metadata?.labels;
    if (method === 'PUT') {
      // Merge provider-owned metadata from the base snapshot so round-tripping never drops it.
      const current = await request<K8sResource>(
        'GET',
        `${collection(version)}/${encodeURIComponent(uid)}`,
        undefined,
        signal
      );
      if (current.ok) {
        annotations = { ...(current.data.metadata?.annotations ?? {}), ...annotations };
        labels = { ...(current.data.metadata?.labels ?? {}), ...(labels ?? {}) };
        const folder = resource.metadata?.annotations?.[FOLDER_ANNOTATION];
        if (!folder) {
          delete annotations[FOLDER_ANNOTATION];
        }
      }
    }
    const body: K8sResource = {
      apiVersion: `${DASHBOARD_API_GROUP}/${version}`,
      kind: 'Dashboard',
      metadata: {
        name: uid,
        ...(resourceVersion ? { resourceVersion } : {}),
        annotations,
        ...(labels && Object.keys(labels).length ? { labels } : {}),
      },
      spec: resource.spec,
    };
    const url = method === 'POST' ? collection(version) : `${collection(version)}/${encodeURIComponent(uid)}`;
    return { uid, url, body };
  };

  const write = async (
    method: 'POST' | 'PUT',
    document: unknown,
    resourceVersion: string | undefined,
    signal?: AbortSignal
  ): Promise<DashboardWriteResult> => {
    const prepared = await prepareWrite(method, document, resourceVersion, signal);
    if (!prepared) {
      return { outcome: 'failed', error: 'metadata.name is required' };
    }
    const response = await request<K8sResource>(method, prepared.url, prepared.body, signal);
    if (!response.ok) {
      return writeFailure(response);
    }
    return { outcome: 'applied', snapshot: toSnapshot(response.data), url: dashboardUrl(prepared.uid) };
  };

  const dryRun = async (
    document: unknown,
    resourceVersion: string | undefined,
    signal?: AbortSignal
  ): Promise<DashboardDryRunResult> => {
    const method = resourceVersion ? 'PUT' : 'POST';
    const prepared = await prepareWrite(method, document, resourceVersion, signal);
    if (!prepared) {
      return { ok: false, message: 'metadata.name is required' };
    }
    const response = await request<K8sResource>(
      method,
      `${prepared.url}?dryRun=All&fieldValidation=Strict`,
      prepared.body,
      signal
    );
    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, status: response.status, message: response.message };
  };

  return {
    async search({ query, tags, folderUids, limit, page }, signal) {
      const params = new URLSearchParams({ type: 'dash-db', limit: String(limit), page: String(page) });
      if (query) {
        params.set('query', query);
      }
      tags?.forEach((tag) => params.append('tag', tag));
      folderUids?.forEach((folder) => params.append('folderUIDs', folder));
      const response = await request<Array<Record<string, unknown>>>('GET', `/api/search?${params}`, undefined, signal);
      if (!response.ok) {
        throw new Error(response.message);
      }
      const hits = (response.data ?? []).map((hit) => ({
        uid: String(hit.uid ?? ''),
        title: String(hit.title ?? ''),
        folderUid: typeof hit.folderUid === 'string' ? hit.folderUid : undefined,
        folderTitle: typeof hit.folderTitle === 'string' ? hit.folderTitle : undefined,
        tags: Array.isArray(hit.tags) ? hit.tags.map(String) : [],
        url: typeof hit.url === 'string' ? hit.url : undefined,
      }));
      return { hits, hasMore: hits.length >= limit };
    },
    get,
    create: (document, signal) => write('POST', document, undefined, signal),
    update: (document, resourceVersion, signal) => write('PUT', document, resourceVersion, signal),
    dryRun,
    async delete(uid, resourceVersion, signal) {
      const version = await preferredVersion();
      const response = await request<unknown>(
        'DELETE',
        `${collection(version)}/${encodeURIComponent(uid)}`,
        resourceVersion ? { preconditions: { resourceVersion } } : undefined,
        signal
      );
      return response.ok ? { outcome: 'applied' } : writeFailure(response);
    },
    async version(uid, resourceVersion, apiVersion, signal) {
      const version = apiVersionPath(apiVersion) ?? (await preferredVersion());
      let continueToken: string | undefined;
      do {
        const params = new URLSearchParams({
          labelSelector: 'grafana.app/get-history=true',
          fieldSelector: `metadata.name=${uid}`,
          limit: '100',
        });
        if (continueToken) {
          params.set('continue', continueToken);
        }
        const response = await request<{ items?: K8sResource[]; metadata?: { continue?: string } }>(
          'GET',
          `${collection(version)}?${params}`,
          undefined,
          signal
        );
        if (!response.ok) {
          throw new Error(response.message);
        }
        const match = response.data.items?.find((item) => item.metadata?.resourceVersion === resourceVersion);
        if (match) {
          return toSnapshot(match);
        }
        continueToken = response.data.metadata?.continue || undefined;
      } while (continueToken);
      return undefined;
    },
    async folderExists(uid, signal) {
      const response = await request<unknown>('GET', `/api/folders/${encodeURIComponent(uid)}`, undefined, signal);
      return response.ok;
    },
    allowedDatasourceUids: () => {
      const allowed = (toolConfig.allowedPrometheusDatasourceUids ?? []).filter(Boolean);
      return allowed.length > 0 ? allowed : undefined;
    },
  };
}

const ALERT_RULE_LIST_PAGE = 500;

function createAlertRuleBroker(toolConfig: GrafanaToolConfig): AlertRuleBroker {
  const collection = () =>
    `/apis/${ALERT_RULE_API_GROUP}/v0alpha1/namespaces/${encodeURIComponent(config.namespace || 'default')}/alertrules`;
  const notifications = () =>
    `/apis/notifications.alerting.grafana.app/v0alpha1/namespaces/${encodeURIComponent(config.namespace || 'default')}`;
  const ruleUrl = (uid: string) => {
    const base = `${config.appSubUrl ?? ''}/alerting/grafana/${encodeURIComponent(uid)}/view`;
    return typeof window !== 'undefined' ? new URL(base, window.location.origin).toString() : base;
  };
  const snapshot = (resource: K8sResource) =>
    toAlertRuleSnapshot(resource as Record<string, unknown>, { url: ruleUrl(String(resource.metadata?.name ?? '')) });
  const getRaw = async (uid: string, signal?: AbortSignal) =>
    request<K8sResource>('GET', `${collection()}/${encodeURIComponent(uid)}`, undefined, signal);
  const get = async (uid: string, signal?: AbortSignal) => {
    const response = await getRaw(uid, signal);
    if (!response.ok) {
      if (response.status === 404 || response.status === 403) {
        return undefined;
      }
      throw new Error(response.message);
    }
    return snapshot(response.data);
  };
  /**
   * The API accepts writes against any resourceVersion, so compare the stored revision with the
   * base right before writing. A write by someone else between this read and the write is not
   * detected.
   */
  const current = async (uid: string, baseResourceVersion: string | undefined, signal?: AbortSignal) => {
    const response = await getRaw(uid, signal);
    if (!response.ok) {
      return { failure: writeFailure(response) };
    }
    const now = response.data.metadata?.resourceVersion;
    if (baseResourceVersion !== undefined && now !== baseResourceVersion) {
      return {
        failure: {
          outcome: 'conflicted' as const,
          error: `the rule changed in Grafana since it was fetched (revision ${baseResourceVersion}, now ${now}); run \`grafana refresh\` on it and edit again`,
        },
      };
    }
    return { resource: response.data };
  };
  const settle = async (uid: string, signal?: AbortSignal): Promise<DashboardWriteResult> => {
    // Create responses carry no usable resourceVersion; read the stored rule back.
    const stored = await get(uid, signal).catch(() => undefined);
    return stored
      ? { outcome: 'applied', snapshot: stored, url: ruleUrl(uid) }
      : { outcome: 'unknown', error: 'saved, but the rule could not be read back; run `grafana refresh` to check' };
  };

  return {
    async list(signal) {
      const rules: WorkspaceResourceSnapshot[] = [];
      let continueToken: string | undefined;
      do {
        const params = new URLSearchParams({ limit: String(ALERT_RULE_LIST_PAGE) });
        if (continueToken) {
          params.set('continue', continueToken);
        }
        const response = await request<{ items?: K8sResource[]; metadata?: { continue?: string } }>(
          'GET',
          `${collection()}?${params}`,
          undefined,
          signal
        );
        if (!response.ok) {
          throw new Error(response.message);
        }
        rules.push(...(response.data.items ?? []).map(snapshot));
        continueToken = response.data.metadata?.continue || undefined;
      } while (continueToken);
      const folders = await request<Array<{ uid?: string; title?: string }>>(
        'GET',
        '/api/search?type=dash-folder&limit=5000',
        undefined,
        signal
      );
      const folderTitles: Record<string, string> = {};
      if (folders.ok) {
        for (const folder of folders.data ?? []) {
          if (folder.uid && folder.title) {
            folderTitles[folder.uid] = folder.title;
          }
        }
      }
      return { rules, folderTitles };
    },
    get,
    async create(document, signal) {
      const uid = (document as K8sResource).metadata?.name;
      if (!uid) {
        return { outcome: 'failed', error: 'metadata.name is required' };
      }
      const response = await request<K8sResource>(
        'POST',
        collection(),
        alertRuleWriteBody(document as Record<string, any>),
        signal
      );
      return response.ok ? settle(uid, signal) : writeFailure(response);
    },
    async update(document, resourceVersion, signal) {
      const uid = (document as K8sResource).metadata?.name;
      if (!uid) {
        return { outcome: 'failed', error: 'metadata.name is required' };
      }
      const stored = await current(uid, resourceVersion, signal);
      if (stored.failure) {
        return stored.failure;
      }
      const response = await request<K8sResource>(
        'PUT',
        `${collection()}/${encodeURIComponent(uid)}`,
        alertRuleWriteBody(document as Record<string, any>, stored.resource as Record<string, any>),
        signal
      );
      return response.ok
        ? { outcome: 'applied', snapshot: snapshot(response.data), url: ruleUrl(uid) }
        : writeFailure(response);
    },
    async delete(uid, resourceVersion, signal) {
      const stored = await current(uid, resourceVersion, signal);
      if (stored.failure) {
        return stored.failure;
      }
      const response = await request<unknown>(
        'DELETE',
        `${collection()}/${encodeURIComponent(uid)}`,
        undefined,
        signal
      );
      return response.ok ? { outcome: 'applied' } : writeFailure(response);
    },
    async version(uid, resourceVersion, _apiVersion, signal) {
      const params = new URLSearchParams({
        labelSelector: 'grafana.app/get-history=true',
        fieldSelector: `metadata.name=${uid}`,
      });
      const response = await request<{ items?: K8sResource[] }>('GET', `${collection()}?${params}`, undefined, signal);
      if (!response.ok) {
        throw new Error(response.message);
      }
      const match = response.data.items?.find((item) => item.metadata?.resourceVersion === resourceVersion);
      return match ? snapshot({ ...match, metadata: { ...match.metadata, name: uid } }) : undefined;
    },
    async notificationTargets(signal) {
      const list = async <T>(resource: string, pick: (item: T) => unknown) => {
        const response = await request<{ items?: T[] }>('GET', `${notifications()}/${resource}`, undefined, signal);
        if (!response.ok) {
          throw new Error(`${resource}: ${response.message}`);
        }
        return (response.data.items ?? []).map(pick).filter((value): value is string => typeof value === 'string');
      };
      const [receivers, timeIntervals, routingTrees] = await Promise.all([
        list<{ spec?: { title?: string } }>('receivers', (item) => item.spec?.title),
        list<{ spec?: { name?: string } }>('timeintervals', (item) => item.spec?.name),
        list<{ metadata?: { name?: string } }>('routingtrees', (item) => item.metadata?.name),
      ]);
      return { receivers, timeIntervals, routingTrees };
    },
    allowedDatasourceUids: () => {
      const allowed = (toolConfig.allowedPrometheusDatasourceUids ?? []).filter(Boolean);
      return allowed.length > 0 ? allowed : undefined;
    },
    prometheusDatasourceUids: () => getPrometheusDatasourceSettings(toolConfig).map((ds) => ds.uid),
  };
}

async function discoverDashboardVersion() {
  const response = await request<{ versions?: Array<{ version?: string }> }>('GET', `/apis/${DASHBOARD_API_GROUP}`);
  if (!response.ok) {
    throw new Error(`dashboard API discovery failed: ${response.message}`);
  }
  const served = new Set((response.data.versions ?? []).map((entry) => entry.version).filter(Boolean));
  const version = PREFERRED_VERSIONS.find((candidate) => served.has(candidate));
  if (!version) {
    throw new Error(`no supported dashboard API version is served (found ${[...served].join(', ') || 'none'})`);
  }
  return version;
}

function toSnapshot(
  resource: K8sResource,
  conversion?: WorkspaceResourceMeta['conversion']
): WorkspaceResourceSnapshot {
  const metadata = resource.metadata ?? {};
  const annotations = metadata.annotations ?? {};
  const uid = String(metadata.name ?? '');
  const document: K8sResource = {
    apiVersion: resource.apiVersion,
    kind: resource.kind ?? 'Dashboard',
    metadata: {
      name: uid,
      ...(annotations[FOLDER_ANNOTATION]
        ? { annotations: { [FOLDER_ANNOTATION]: annotations[FOLDER_ANNOTATION] } }
        : {}),
      ...(metadata.labels && Object.keys(metadata.labels).length ? { labels: metadata.labels } : {}),
    },
    spec: resource.spec ?? {},
  };
  const content = `${JSON.stringify(document, null, 2)}\n`;
  const managedBy = annotations[MANAGED_BY_ANNOTATION];
  const spec = resource.spec as { title?: unknown } | undefined;
  return {
    content,
    meta: {
      kind: 'dashboard',
      uid,
      apiVersion: String(resource.apiVersion ?? ''),
      namespace: metadata.namespace,
      resourceVersion: metadata.resourceVersion,
      generation: metadata.generation,
      title: typeof spec?.title === 'string' ? spec.title : undefined,
      folderUid: annotations[FOLDER_ANNOTATION],
      url: dashboardUrl(uid),
      managedBy: managedBy && annotations[MANAGER_ALLOWS_EDITS_ANNOTATION] !== 'true' ? managedBy : undefined,
      fetchedAt: new Date().toISOString(),
      annotations,
      labels: metadata.labels,
      contentHash: sha256Hex(content),
      ...(conversion ? { conversion } : {}),
    },
  };
}

function apiVersionPath(apiVersion: string | undefined) {
  const match = /^dashboard\.grafana\.app\/(v[0-9a-z]+)$/.exec(apiVersion ?? '');
  return match?.[1];
}

function dashboardUrl(uid: string) {
  const base = `${config.appSubUrl ?? ''}/d/${encodeURIComponent(uid)}`;
  return typeof window !== 'undefined' ? new URL(base, window.location.origin).toString() : base;
}

function writeFailure(response: { status?: number; message: string }): DashboardWriteResult {
  if (response.status === 409 || response.status === 412) {
    return { outcome: 'conflicted', error: response.message };
  }
  if (response.status === undefined || response.status >= 500 || response.status === 0) {
    return { outcome: 'unknown', error: `${response.message} (outcome unknown; run \`grafana refresh\` to check)` };
  }
  return { outcome: 'failed', error: response.message };
}

function responseData<T>(response: RequestResult<T>): T {
  if (!response.ok) {
    throw new Error(response.message);
  }
  return response.data;
}

async function request<T>(
  method: string,
  url: string,
  data?: unknown,
  signal?: AbortSignal,
  headers?: Record<string, string>
): Promise<RequestResult<T>> {
  if (signal?.aborted) {
    throw new Error('request aborted');
  }
  try {
    const response = await new Promise<FetchResponse<T>>((resolve, reject) => {
      // Unsubscribing cancels the underlying HTTP request.
      const subscription = getBackendSrv()
        .fetch<T>({
          url,
          method,
          data,
          headers,
          showErrorAlert: false,
          showSuccessAlert: false,
        })
        .subscribe({ next: resolve, error: reject });
      signal?.addEventListener(
        'abort',
        () => {
          subscription.unsubscribe();
          reject(new Error('request aborted'));
        },
        { once: true }
      );
    });
    return { ok: true, status: response.status, data: response.data };
  } catch (error) {
    if (isFetchError(error)) {
      return { ok: false, status: error.status, message: formatBackendFetchError(error) };
    }
    if (signal?.aborted) {
      throw error;
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function createPrometheusBroker(toolConfig: GrafanaToolConfig): PrometheusBroker {
  return {
    datasources: () =>
      getPrometheusDatasourceSettings(toolConfig).map((ds) => {
        const timeInterval = (ds.jsonData as { timeInterval?: unknown } | undefined)?.timeInterval;
        return {
          uid: ds.uid,
          name: ds.name,
          isDefault: ds.isDefault,
          ...(typeof timeInterval === 'string' && timeInterval ? { timeInterval } : {}),
        };
      }),
    async metricNames(datasourceUid, signal) {
      const ds = await getPrometheusDatasource(toolConfig, datasourceUid);
      const response = await getDatasourceResource<PrometheusMetadataResponse<string[]>>(
        ds,
        'api/v1/label/__name__/values',
        undefined,
        signal
      );
      return { datasourceUid: ds.uid, names: response.data ?? [] };
    },
    async labelNames(datasourceUid, match, signal) {
      const ds = await getPrometheusDatasource(toolConfig, datasourceUid);
      const response = await getDatasourceResource<PrometheusMetadataResponse<string[]>>(
        ds,
        'api/v1/labels',
        match ? { 'match[]': match } : undefined,
        signal
      );
      return { datasourceUid: ds.uid, names: response.data ?? [] };
    },
    async labelValues(datasourceUid, label, match, signal) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) {
        throw new Error(`invalid label name ${JSON.stringify(label)}`);
      }
      const ds = await getPrometheusDatasource(toolConfig, datasourceUid);
      const response = await getDatasourceResource<PrometheusMetadataResponse<string[]>>(
        ds,
        `api/v1/label/${label}/values`,
        match ? { 'match[]': match } : undefined,
        signal
      );
      return { datasourceUid: ds.uid, values: response.data ?? [] };
    },
    async series(datasourceUid, match, limit, signal) {
      const ds = await getPrometheusDatasource(toolConfig, datasourceUid);
      const response = await getDatasourceResource<PrometheusMetadataResponse<Array<Record<string, string>>>>(
        ds,
        'api/v1/series',
        { 'match[]': match, limit: limit + 1 },
        signal
      );
      const series = response.data ?? [];
      return { datasourceUid: ds.uid, series: series.slice(0, limit), truncated: series.length > limit };
    },
    async queryData(body, signal) {
      const allowed = new Set(getPrometheusDatasourceSettings(toolConfig).map((ds) => ds.uid));
      for (const query of body.queries) {
        const ds = (query.datasource ?? {}) as { uid?: string; type?: string };
        const expression = ds.uid === '__expr__' && ds.type === '__expr__';
        if (!expression && !(ds.type === 'prometheus' && ds.uid && allowed.has(ds.uid))) {
          throw new Error(`datasource ${JSON.stringify(ds.uid ?? '')} is not an allowed Prometheus datasource`);
        }
      }
      const response = await request<unknown>('POST', '/api/ds/query', body, signal);
      if (!response.ok) {
        throw new Error(response.message);
      }
      return response.data;
    },
    async query(datasourceUid, spec, signal) {
      const ds = await getPrometheusDatasource(toolConfig, datasourceUid);
      const summary = await runPrometheusQuerySummaryOrValidationError(ds, spec, signal);
      const series = Array.isArray(summary.series) ? summary.series : [];
      return {
        ...summary,
        series: series.slice(0, MAX_QUERY_SERIES),
        truncatedSeries: summary.truncatedSeries || series.length > MAX_QUERY_SERIES,
      } as unknown as Record<string, unknown>;
    },
  };
}
