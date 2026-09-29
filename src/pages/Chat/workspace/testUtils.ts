import {
  alertRuleWriteBody,
  GROUP_INDEX_LABEL,
  GROUP_LABEL,
  PROVENANCE_ANNOTATION,
  toAlertRuleSnapshot,
} from './alertRuleModel';
import type { AlertRuleBroker, DashboardBroker, WorkspaceBroker } from './broker';
import { sha256Hex } from './hash';
import type { WorkspaceResourceSnapshot } from './types';

/** A Grafana-managed alert rule on a 5xx rate with a threshold, as the App Platform API returns it. */
export function alertRuleResource(
  uid: string,
  options: {
    title?: string;
    folder?: string;
    group?: string;
    groupIndex?: number;
    provenance?: string;
    threshold?: number;
    expr?: string;
    datasourceUid?: string;
    interval?: string;
  } = {}
) {
  const folder = options.folder ?? 'ops';
  return {
    apiVersion: 'rules.alerting.grafana.app/v0alpha1',
    kind: 'AlertRule',
    metadata: {
      name: uid,
      namespace: 'default',
      resourceVersion: '1',
      labels: {
        'grafana.app/folder': folder,
        ...(options.group
          ? { [GROUP_LABEL]: options.group, [GROUP_INDEX_LABEL]: String(options.groupIndex ?? 0) }
          : {}),
      },
      annotations: {
        'grafana.app/folder': folder,
        'grafana.app/updatedBy': '0',
        [PROVENANCE_ANNOTATION]: options.provenance ?? '',
      },
    },
    spec: {
      title: options.title ?? uid,
      trigger: { interval: options.interval ?? '1m' },
      labels: { severity: 'warning' },
      annotations: { __dashboardUid__: 'checkout', __panelId__: '1' },
      for: '2m0s',
      noDataState: 'NoData',
      execErrState: 'Error',
      expressions: {
        A: {
          relativeTimeRange: { from: '10m0s', to: '0s' },
          datasourceUID: options.datasourceUid ?? 'prometheus',
          model: {
            datasource: { type: 'prometheus', uid: options.datasourceUid ?? 'prometheus' },
            expr: options.expr ?? 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
            refId: 'A',
          },
        },
        B: { model: { expression: 'A', reducer: 'last', refId: 'B', type: 'reduce' } },
        C: {
          model: {
            conditions: [{ evaluator: { params: [options.threshold ?? 0], type: 'gt' } }],
            expression: 'B',
            refId: 'C',
            type: 'threshold',
          },
          source: true,
        },
      },
    },
  };
}

/**
 * In-memory App Platform AlertRule API. Like Grafana's, it does not check resourceVersion on
 * writes; the fake broker compares revisions before writing, as the real one does.
 */
export function createFakeAlertRuleBroker(initial: Array<ReturnType<typeof alertRuleResource>>) {
  const store = new Map<string, Record<string, any>>();
  const history = new Map<string, Array<Record<string, any>>>();
  const calls: string[] = [];
  /** Request bodies of writes, as the API received them. */
  const writes: Array<Record<string, any>> = [];
  const remember = (uid: string) => {
    history.set(uid, [...(history.get(uid) ?? []), JSON.parse(JSON.stringify(store.get(uid)))]);
  };
  for (const rule of initial) {
    store.set(rule.metadata.name, JSON.parse(JSON.stringify(rule)));
    remember(rule.metadata.name);
  }
  const snapshot = (resource: Record<string, any> | undefined) =>
    resource ? toAlertRuleSnapshot(resource, { url: `/alerting/grafana/${resource.metadata.name}/view` }) : undefined;
  const conflict = (uid: string, resourceVersion: string | undefined) => {
    const stored = store.get(uid);
    if (!stored) {
      return { outcome: 'failed' as const, error: 'not found' };
    }
    return resourceVersion !== undefined && stored.metadata.resourceVersion !== resourceVersion
      ? {
          outcome: 'conflicted' as const,
          error: `the rule changed (revision ${resourceVersion}, now ${stored.metadata.resourceVersion})`,
        }
      : undefined;
  };

  const alertRules: AlertRuleBroker = {
    async list() {
      calls.push('list');
      return {
        rules: [...store.values()].map((resource) => snapshot(resource)!),
        folderTitles: { ops: 'Operations' },
      };
    },
    async get(uid) {
      calls.push(`get:${uid}`);
      return snapshot(store.get(uid));
    },
    async create(document: any) {
      const uid = document.metadata.name;
      calls.push(`create:${uid}`);
      if (store.has(uid)) {
        return { outcome: 'conflicted', error: 'already exists' };
      }
      const body = alertRuleWriteBody(document);
      writes.push(body);
      store.set(uid, { ...body, metadata: { ...body.metadata, resourceVersion: '1' } });
      remember(uid);
      return { outcome: 'applied', snapshot: snapshot(store.get(uid)) };
    },
    async update(document: any, resourceVersion) {
      const uid = document.metadata.name;
      calls.push(`update:${uid}@${resourceVersion}`);
      const failure = conflict(uid, resourceVersion);
      if (failure) {
        return failure;
      }
      const current = store.get(uid)!;
      const body = alertRuleWriteBody(document, current);
      writes.push(body);
      store.set(uid, {
        ...body,
        metadata: { ...body.metadata, resourceVersion: String(Number(current.metadata.resourceVersion) + 1) },
      });
      remember(uid);
      return { outcome: 'applied', snapshot: snapshot(store.get(uid)) };
    },
    async delete(uid, resourceVersion) {
      calls.push(`delete:${uid}@${resourceVersion}`);
      const failure = conflict(uid, resourceVersion);
      if (failure) {
        return failure;
      }
      store.delete(uid);
      return { outcome: 'applied' };
    },
    async version(uid, resourceVersion) {
      calls.push(`version:${uid}@${resourceVersion}`);
      return snapshot(history.get(uid)?.find((entry) => entry.metadata.resourceVersion === resourceVersion));
    },
    notificationTargets: async () => ({
      receivers: ['oncall'],
      timeIntervals: ['weekends'],
      routingTrees: ['user-defined'],
    }),
    allowedDatasourceUids: () => ['prometheus'],
    prometheusDatasourceUids: () => ['prometheus'],
  };

  /** Simulates a concurrent edit by another user. */
  const touch = (uid: string) => {
    const stored = store.get(uid)!;
    stored.metadata.resourceVersion = String(Number(stored.metadata.resourceVersion) + 1);
  };
  return { alertRules, store, calls, writes, touch };
}

type StoredDashboard = { resource: Record<string, any>; resourceVersion: number; managedBy?: string };

/** In-memory dashboard API with resourceVersion preconditions, for tests. */
export function createFakeDashboardBroker(
  initial: Array<{ uid: string; title: string; panels?: unknown[]; managedBy?: string }>
) {
  const store = new Map<string, StoredDashboard>();
  /** Every stored version per UID, like Grafana's dashboard history. */
  const history = new Map<string, StoredDashboard[]>();
  const remember = (uid: string) => {
    const stored = store.get(uid)!;
    history.set(uid, [
      ...(history.get(uid) ?? []),
      { ...stored, resource: JSON.parse(JSON.stringify(stored.resource)) },
    ]);
  };
  let version = 100;
  const calls: string[] = [];
  for (const dashboard of initial) {
    store.set(dashboard.uid, {
      resourceVersion: ++version,
      managedBy: dashboard.managedBy,
      resource: {
        apiVersion: 'dashboard.grafana.app/v1',
        kind: 'Dashboard',
        metadata: { name: dashboard.uid, annotations: { 'grafana.app/folder': 'ops' } },
        spec: { title: dashboard.title, panels: dashboard.panels ?? [], schemaVersion: 41 },
      },
    });
    remember(dashboard.uid);
  }

  const snapshot = (uid: string, stored = store.get(uid)): WorkspaceResourceSnapshot | undefined => {
    if (!stored) {
      return undefined;
    }
    const content = `${JSON.stringify(stored.resource, null, 2)}\n`;
    return {
      content,
      meta: {
        kind: 'dashboard',
        uid,
        apiVersion: stored.resource.apiVersion,
        resourceVersion: String(stored.resourceVersion),
        title: stored.resource.spec.title,
        folderUid: stored.resource.metadata.annotations?.['grafana.app/folder'],
        managedBy: stored.managedBy,
        fetchedAt: '2026-09-25T00:00:00.000Z',
        contentHash: sha256Hex(content),
      },
    };
  };

  const dashboards: DashboardBroker = {
    async search({ query, limit, page }) {
      calls.push(`search:${query ?? ''}`);
      const hits = [...store.values()]
        .filter((stored) => !query || stored.resource.spec.title.toLowerCase().includes(query.toLowerCase()))
        .map((stored) => ({
          uid: stored.resource.metadata.name,
          title: stored.resource.spec.title,
          tags: [],
          folderUid: 'ops',
        }));
      const start = (page - 1) * limit;
      return { hits: hits.slice(start, start + limit), hasMore: hits.length > start + limit };
    },
    async get(uid) {
      calls.push(`get:${uid}`);
      return snapshot(uid);
    },
    async create(document: any) {
      const uid = document.metadata.name;
      calls.push(`create:${uid}`);
      if (store.has(uid)) {
        return { outcome: 'conflicted', error: 'already exists' };
      }
      store.set(uid, { resource: { ...document, metadata: { ...document.metadata } }, resourceVersion: ++version });
      remember(uid);
      return { outcome: 'applied', snapshot: snapshot(uid) };
    },
    async update(document: any, resourceVersion) {
      const uid = document.metadata.name;
      calls.push(`update:${uid}@${resourceVersion}`);
      const stored = store.get(uid);
      if (!stored) {
        return { outcome: 'failed', error: 'not found' };
      }
      if (String(stored.resourceVersion) !== resourceVersion) {
        return {
          outcome: 'conflicted',
          error: `resourceVersion ${resourceVersion} is stale (current ${stored.resourceVersion})`,
        };
      }
      store.set(uid, { resource: document, resourceVersion: ++version });
      remember(uid);
      return { outcome: 'applied', snapshot: snapshot(uid) };
    },
    async delete(uid, resourceVersion) {
      calls.push(`delete:${uid}@${resourceVersion}`);
      const stored = store.get(uid);
      if (!stored || String(stored.resourceVersion) !== resourceVersion) {
        return { outcome: 'conflicted', error: 'stale' };
      }
      store.delete(uid);
      return { outcome: 'applied' };
    },
    async dryRun(document: any, resourceVersion) {
      const uid = document.metadata.name;
      calls.push(`dryRun:${uid}@${resourceVersion ?? 'new'}`);
      const stored = store.get(uid);
      if (resourceVersion === undefined) {
        return stored ? { ok: false, status: 409, message: 'already exists' } : { ok: true, status: 201 };
      }
      if (!stored || String(stored.resourceVersion) !== resourceVersion) {
        return { ok: false, status: 409, message: 'the object has been modified' };
      }
      return { ok: true, status: 200 };
    },
    async version(uid, resourceVersion) {
      calls.push(`version:${uid}@${resourceVersion}`);
      const stored = history.get(uid)?.find((entry) => String(entry.resourceVersion) === resourceVersion);
      return stored ? snapshot(uid, stored) : undefined;
    },
    folderExists: async (uid) => uid === 'ops',
    allowedDatasourceUids: () => ['prometheus'],
  };

  const dataRequests: Array<{ queries: Array<Record<string, unknown>>; from: string; to: string }> = [];
  let dataResponse: (request: (typeof dataRequests)[number]) => unknown = () => ({ results: {} });
  const setDataResponse = (responder: typeof dataResponse) => {
    dataResponse = responder;
  };

  const broker: WorkspaceBroker = {
    dashboards,
    prometheus: {
      datasources: () => [{ uid: 'prometheus', name: 'Prometheus', isDefault: true, timeInterval: '60s' }],
      async metricNames() {
        return {
          datasourceUid: 'prometheus',
          names: ['http_requests_total', 'http_request_duration_seconds_bucket', 'up'],
        };
      },
      async labelNames() {
        return { datasourceUid: 'prometheus', names: ['__name__', 'job', 'route', 'status'] };
      },
      async labelValues(_ds, label) {
        return { datasourceUid: 'prometheus', values: label === 'job' ? ['api', 'checkout'] : [] };
      },
      async series(_ds, match) {
        return { datasourceUid: 'prometheus', series: [{ __name__: match, job: 'api' }], truncated: false };
      },
      async queryData(request) {
        dataRequests.push(request);
        return dataResponse(request);
      },
      async query(_ds, spec) {
        return {
          datasourceUid: 'prometheus',
          query: spec.query,
          queryType: spec.type,
          totalSeries: 1,
          series: [{ name: 'x', last: 1 }],
        };
      },
    },
  };

  /** Simulates a concurrent edit by another user. */
  const touch = (uid: string) => {
    const stored = store.get(uid)!;
    stored.resourceVersion = ++version;
  };

  return { broker, store, calls, touch, dataRequests, setDataResponse };
}
