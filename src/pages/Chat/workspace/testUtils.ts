import type { DashboardBroker, WorkspaceBroker } from './broker';
import { sha256Hex } from './hash';
import type { WorkspaceResourceSnapshot } from './types';

type StoredDashboard = { resource: Record<string, any>; resourceVersion: number; managedBy?: string };

/** In-memory dashboard API with resourceVersion preconditions, for tests. */
export function createFakeDashboardBroker(
  initial: Array<{ uid: string; title: string; panels?: unknown[]; managedBy?: string }>
) {
  const store = new Map<string, StoredDashboard>();
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
  }

  const snapshot = (uid: string): WorkspaceResourceSnapshot | undefined => {
    const stored = store.get(uid);
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
    folderExists: async (uid) => uid === 'ops',
    allowedDatasourceUids: () => ['prometheus'],
  };

  const broker: WorkspaceBroker = {
    dashboards,
    prometheus: {
      datasources: () => [{ uid: 'prometheus', name: 'Prometheus', isDefault: true }],
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

  return { broker, store, calls, touch };
}
