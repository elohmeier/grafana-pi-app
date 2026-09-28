import type { UserStorage } from '@grafana/data';
import { config, getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { PLUGIN_ID } from '../../../constants';

export type SessionMetadata = { id: string; title: string; createdAt: string; updatedAt: string; revision?: number };
export type SessionDocument = SessionMetadata & { messages: unknown[] };
type Page = { items: SessionMetadata[]; nextCursor?: string };
type Write = {
  requestId: string;
  revision: number;
  title: string;
  snapshot?: SessionDocument;
  import?: boolean;
  createdAt?: string;
  updatedAt?: string;
};
const indexKey = 'sessions:index';

async function request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  try {
    const result = await lastValueFrom(
      getBackendSrv().fetch<T>({
        url: `/api/plugins/${PLUGIN_ID}/resources/sessions${path}`,
        method,
        data,
        showErrorAlert: false,
      })
    );
    return result.data;
  } catch (error) {
    const failure = error as { status?: number; data?: { error?: string; message?: string } };
    const message =
      failure.data?.error ||
      failure.data?.message ||
      'Session storage could not be reached. Your changes have not been confirmed saved.';
    throw Object.assign(new Error(message), { status: failure.status });
  }
}

/** Revisions belong to this view's loaded documents, never to the list cache. */
export class SessionRepository {
  private ready?: Promise<void>;
  private postgres = false;
  private revisions = new Map<string, number>();
  private queues = new Map<string, Promise<unknown>>();
  private pending = new Map<string, { method: string; body: Write }>();
  private conflicts = new Set<string>();

  constructor(private legacy: UserStorage) {}

  initialize() {
    if (!this.ready) {
      this.ready = this.initializeStorage().catch((error) => {
        this.ready = undefined;
        throw error;
      });
    }
    return this.ready;
  }

  private async initializeStorage() {
    const status = await request<{ enabled: boolean; importComplete?: boolean; scopeKey?: string }>('/status');
    this.postgres = status.enabled;
    if (status.enabled) {
      const marker = status.scopeKey ? `pi-session-local-import:${status.scopeKey}` : undefined;
      if (!status.importComplete || (marker && localStorage.getItem(marker) !== '1')) {
        await this.importLegacy(!status.importComplete);
        if (marker) {
          localStorage.setItem(marker, '1');
        }
      }
    }
  }

  private async importLegacy(includeServer: boolean) {
    // Read the resource directly: UserStorage hides backend failures by falling
    // back to the browser. Never mark a failed legacy read as a completed import.
    const user = config.bootData.user;
    const uid = user.uid || String(user.id);
    const name = `${PLUGIN_ID}:${uid}`;
    let data: Record<string, string> = {};
    if (includeServer) {
      try {
        const result = await lastValueFrom(
          getBackendSrv().fetch<{ spec: { data: Record<string, string> } }>({
            url: `/apis/userstorage.grafana.app/v0alpha1/namespaces/${config.namespace}/user-storage/${encodeURIComponent(name)}`,
            showErrorAlert: false,
          })
        );
        data = result.data.spec.data;
      } catch (error) {
        if ((error as { status?: number }).status !== 404) {
          throw new Error('Could not read legacy sessions. Import will retry; existing histories have been preserved.');
        }
      }
    }
    const candidates = new Map<string, SessionDocument>();
    const consider = (key: string, raw: string | null) => {
      if (!key.startsWith('sessions:') || key === indexKey || !raw) {
        return;
      }
      const parsed = JSON.parse(raw) as SessionDocument;
      if (
        parsed.id !== key.slice('sessions:'.length) ||
        !Array.isArray(parsed.messages) ||
        typeof parsed.title !== 'string'
      ) {
        throw new Error(`Cannot import legacy session ${key}; original data has been preserved.`);
      }
      const old = candidates.get(parsed.id);
      if (!old || parsed.updatedAt > old.updatedAt) {
        candidates.set(parsed.id, parsed);
      }
    };
    for (const [key, value] of Object.entries(data)) {
      consider(key, value);
    }
    // Include bodies omitted by the old 50-entry index and browser fallback data.
    const prefix = `${name}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) {
        consider(key.slice(prefix.length), localStorage.getItem(key));
      }
    }
    for (const session of candidates.values()) {
      await request(`/${encodeURIComponent(session.id)}`, 'PUT', {
        requestId: crypto.randomUUID(),
        revision: 0,
        title: session.title,
        snapshot: session,
        import: true,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    }
    if (includeServer) {
      await request('/migration', 'POST');
    }
  }

  async list(cursor?: string): Promise<Page> {
    await this.initialize();
    if (this.postgres) {
      return request(`?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    }
    const raw = await this.legacy.getItem(indexKey);
    return { items: raw ? JSON.parse(raw) : [] };
  }

  async get<T extends SessionDocument>(id: string): Promise<T | undefined> {
    await this.initialize();
    if (!this.postgres) {
      const raw = await this.legacy.getItem(`sessions:${id}`);
      return raw ? JSON.parse(raw) : undefined;
    }
    const { snapshot, ...metadata } = await request<SessionMetadata & { snapshot: T }>(`/${encodeURIComponent(id)}`);
    this.revisions.set(id, metadata.revision!);
    this.conflicts.delete(id);
    return { ...snapshot, ...metadata };
  }

  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.queues.set(id, task);
    void task
      .finally(() => {
        if (this.queues.get(id) === task) {
          this.queues.delete(id);
        }
      })
      .catch(() => undefined);
    return task;
  }

  private async deliver(id: string) {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    let result: SessionMetadata;
    try {
      result = await request<SessionMetadata>(`/${encodeURIComponent(id)}`, pending.method, pending.body);
    } catch (error) {
      if ((error as { status?: number }).status === 409) {
        this.pending.delete(id);
        this.conflicts.add(id);
      } else if ([400, 413].includes((error as { status?: number }).status ?? 0)) {
        this.pending.delete(id);
      }
      throw error;
    }
    this.revisions.set(id, result.revision!);
    this.pending.delete(id);
    return result;
  }

  save(document: SessionDocument): Promise<SessionMetadata> {
    // Freeze the body before waiting behind another save.
    const snapshot = JSON.parse(JSON.stringify(document)) as SessionDocument;
    return this.enqueue(document.id, async () => {
      await this.initialize();
      if (this.conflicts.has(snapshot.id)) {
        throw new Error('This session changed in another tab. Reload the page before saving, or export your changes.');
      }
      if (!this.postgres) {
        const { items } = await this.list();
        const metadata = {
          id: snapshot.id,
          title: snapshot.title,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
        };
        await this.legacy.setItem(`sessions:${snapshot.id}`, JSON.stringify(snapshot));
        await this.legacy.setItem(
          indexKey,
          JSON.stringify([metadata, ...items.filter((item) => item.id !== snapshot.id)].slice(0, 50))
        );
        return metadata;
      }
      await this.deliver(snapshot.id); // Retry an uncertain write with its original request ID first.
      this.pending.set(snapshot.id, {
        method: 'PUT',
        body: {
          requestId: crypto.randomUUID(),
          revision: this.revisions.get(snapshot.id) ?? 0,
          title: snapshot.title,
          snapshot,
        },
      });
      return (await this.deliver(snapshot.id))!;
    });
  }

  delete(id: string, revision?: number) {
    return this.enqueue(id, async () => {
      await this.initialize();
      if (!this.postgres) {
        const { items } = await this.list();
        // Older Grafana typings expose no deleteItem; remove the retained body too.
        await this.legacy.setItem(`sessions:${id}`, '');
        await this.legacy.setItem(indexKey, JSON.stringify(items.filter((item) => item.id !== id)));
        return;
      }
      await this.deliver(id);
      this.pending.set(id, {
        method: 'DELETE',
        body: { requestId: crypto.randomUUID(), revision: revision ?? this.revisions.get(id) ?? 0, title: '' },
      });
      await this.deliver(id);
    });
  }
}
