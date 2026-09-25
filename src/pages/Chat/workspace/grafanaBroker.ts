import { config, getBackendSrv, isFetchError, type FetchResponse } from '@grafana/runtime';
import { formatBackendFetchError } from '../tools/client';
import {
  getDatasourceResource,
  getPrometheusDatasource,
  getPrometheusDatasourceSettings,
  runPrometheusQuerySummaryOrValidationError,
} from '../tools/metrics';
import type { GrafanaToolConfig, PrometheusMetadataResponse } from '../tools/types';
import { PLUGIN_ID } from '../../../constants';
import type { DashboardBroker, DashboardWriteResult, JsonnetBroker, PrometheusBroker, WorkspaceBroker } from './broker';
import { DASHBOARD_API_GROUP } from './dashboardModel';
import { sha256Hex } from './hash';
import type { WorkspaceResourceSnapshot } from './types';

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
    jsonnet: createJsonnetBroker(),
  };
}

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
      return (await resource<{ output: string }>('/jsonnet/eval', evalRequest, signal)).output;
    },
    fix: (source, signal) => resource<{ source: string; repairs: string[] }>('/jsonnet/fix', { source }, signal),
    async listLibraries(path, signal) {
      const data = await resource<{ basePath: string; result: string[] }>('/jsonnet-libs/list', { path }, signal);
      return { basePath: data.basePath, files: data.result ?? [] };
    },
    async readLibrary(path, window, signal) {
      const data = await resource<{ path: string; totalLines: number; result: Array<{ line: number; text: string }> }>(
        '/jsonnet-libs/read',
        { path, ...window },
        signal
      );
      return { path: data.path, totalLines: data.totalLines, lines: data.result ?? [] };
    },
    async searchLibraries(pattern, path, signal) {
      const data = await resource<{ result: Array<{ file: string; line: number; text: string }>; capped: boolean }>(
        '/jsonnet-libs/search',
        { pattern, path },
        signal
      );
      return { matches: data.result ?? [], capped: Boolean(data.capped) };
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
    let response = await request<K8sResource>(
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
      response = await request<K8sResource>(
        'GET',
        `${collection(conversion.storedVersion)}/${encodeURIComponent(uid)}`,
        undefined,
        signal
      );
      if (!response.ok) {
        throw new Error(response.message);
      }
    }
    return toSnapshot(response.data);
  };

  const write = async (
    method: 'POST' | 'PUT',
    document: unknown,
    resourceVersion: string | undefined,
    signal?: AbortSignal
  ): Promise<DashboardWriteResult> => {
    const resource = document as K8sResource;
    const uid = resource.metadata?.name;
    const version = apiVersionPath(resource.apiVersion) ?? (await preferredVersion());
    if (!uid) {
      return { outcome: 'failed', error: 'metadata.name is required' };
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
    const response = await request<K8sResource>(method, url, body, signal);
    if (!response.ok) {
      return writeFailure(response);
    }
    return { outcome: 'applied', snapshot: toSnapshot(response.data), url: dashboardUrl(uid) };
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

function toSnapshot(resource: K8sResource): WorkspaceResourceSnapshot {
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

async function request<T>(
  method: string,
  url: string,
  data?: unknown,
  signal?: AbortSignal
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
      getPrometheusDatasourceSettings(toolConfig).map((ds) => ({
        uid: ds.uid,
        name: ds.name,
        isDefault: ds.isDefault,
      })),
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
