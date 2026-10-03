import type { HostStateDocument } from '../generated/api';
import type { HostState, StatePersistence } from './store';

type Request = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/**
 * Host state in the plugin backend (`/host-state/{key}`), shared by the host's
 * replicas. Each write names the version it replaces; when another replica
 * wrote in between, this one has lost its leadership and `onConflict` runs.
 */
export function backendState(request: Request, options: { key?: string; onConflict: () => void }): StatePersistence {
  const path = `/host-state/${encodeURIComponent(options.key ?? 'state')}`;
  let version = 0;
  return {
    async load() {
      const document = await request<HostStateDocument>('GET', path);
      version = document.version;
      return (document.body ?? undefined) as Partial<HostState> | undefined;
    },
    async save(state) {
      try {
        version = (await request<HostStateDocument>('PUT', path, { version, body: state })).version;
      } catch (error) {
        if ((error as { status?: number })?.status === 409) {
          options.onConflict();
        }
        throw error;
      }
    },
  };
}
