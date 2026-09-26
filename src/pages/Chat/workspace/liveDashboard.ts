import type { DashboardMutationAPI } from '@grafana/data';
import type { LiveDashboardBroker, LiveDashboardSnapshot } from './broker';
import { sha256Hex } from './hash';
import type { GeneratedFile, GeneratedMount } from './types';

export const LIVE_DASHBOARD_ROOT = '/live/dashboard';
export const LIVE_DASHBOARD_PATH = `${LIVE_DASHBOARD_ROOT}/dashboard.json`;
export const LIVE_DASHBOARD_INFO_PATH = `${LIVE_DASHBOARD_ROOT}/info.json`;
const LIVE_API_VERSION = 'dashboard.grafana.app/v2';

/**
 * The dashboard open in the browser through Grafana's restricted dashboard
 * mutation API: GET_SPEC reads the unsaved state as one v2 spec, APPLY_SPEC
 * replaces it. Nothing is saved; the user saves through Grafana.
 */
export function createLiveDashboardBroker(getApi: () => DashboardMutationAPI | undefined): LiveDashboardBroker {
  const execute = async (type: string, payload: Record<string, unknown>) => {
    const api = getApi();
    if (!api) {
      throw new Error('no dashboard is open in the browser');
    }
    const result = await api.execute({ type, payload } as never);
    if (!result.success) {
      throw new Error(result.error ?? `${type} failed`);
    }
    return result;
  };
  return {
    available: () => {
      try {
        const commands = getApi()?.getAvailableCommands().map(String) ?? [];
        return commands.includes('GET_SPEC') && commands.includes('APPLY_SPEC');
      } catch {
        return false;
      }
    },
    async get() {
      const [specResult, infoResult] = await Promise.all([
        execute('GET_SPEC', {}),
        execute('GET_DASHBOARD_INFO', {}).catch(() => undefined),
      ]);
      const spec = (specResult.data as { spec?: Record<string, unknown> } | undefined)?.spec;
      if (!spec) {
        throw new Error('GET_SPEC returned no spec');
      }
      const info = (infoResult?.data ?? {}) as Record<string, unknown>;
      return { uid: typeof info.uid === 'string' ? info.uid : '', info, spec, revision: liveRevision(spec) };
    },
    async apply(spec) {
      const result = await execute('APPLY_SPEC', { spec, validate: true });
      const applied = (result.data as { spec?: Record<string, unknown> } | undefined)?.spec;
      return { spec: applied, warnings: result.warnings ?? [] };
    },
  };
}

/** Revision of a live spec, carried as metadata.resourceVersion for optimistic concurrency. */
export function liveRevision(spec: unknown) {
  return `live-${sha256Hex(JSON.stringify(spec)).slice(0, 16)}`;
}

/** The editable file: a v2 resource envelope, so grafana-dashboard inspect/validate/data work on it. */
export function liveDashboardDocument(snapshot: LiveDashboardSnapshot) {
  return `${JSON.stringify(
    {
      apiVersion: LIVE_API_VERSION,
      kind: 'Dashboard',
      metadata: { name: snapshot.uid, resourceVersion: snapshot.revision },
      spec: snapshot.spec,
    },
    null,
    2
  )}\n`;
}

/**
 * /live/dashboard/dashboard.json is writable: edits stage a local overlay that
 * `live apply` sends to the browser. info.json is read-only.
 */
export function createLiveDashboardMount(live: LiveDashboardBroker): GeneratedMount {
  return {
    root: LIVE_DASHBOARD_ROOT,
    description:
      'Unsaved state of the dashboard open in the browser; dashboard.json is editable, `live apply` applies it.',
    files: () => {
      if (!live.available()) {
        return {};
      }
      const files: Record<string, GeneratedFile> = {
        [LIVE_DASHBOARD_PATH]: {
          writable: true,
          load: async (signal) => liveDashboardDocument(await live.get(signal)),
        },
        [LIVE_DASHBOARD_INFO_PATH]: {
          load: async (signal) => `${JSON.stringify((await live.get(signal)).info, null, 2)}\n`,
        },
      };
      return files;
    },
  };
}
