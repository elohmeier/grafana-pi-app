import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A chat thread the assistant takes part in. */
export type ThreadRecord = {
  /** The assistant chat of the thread, once it has one. */
  chatId?: string;
  /** The chat exists in the plugin backend. */
  chatStored?: boolean;
  /** Share token of the chat, for the link that copies it into a user's Grafana chats. */
  shareToken?: string;
  /** A run that has not posted its answer yet; resumed when the host starts. */
  pending?: { channelId: string; threadId: string; postId: string; prompt: string; startedAt: number };
  /** Bot posts of the thread are newer than this time (ms); later human posts are context for the next answer. */
  lastAnswerAt?: number;
  createdAt: number;
};

/** One firing period of a Grafana notification group, posted as one thread. */
export type AlertEpisode = {
  channelId: string;
  threadId: string;
  status: 'firing' | 'resolved';
  /** The firing alerts (fingerprints) last posted, to skip repeated notifications. */
  fingerprints: string[];
  /** The last update post, edited by further updates for a while instead of posting again. */
  updatePostId?: string;
  updatePostedAt?: number;
  /** How often the update post was edited, for platforms that limit edits. */
  updateEdits?: number;
  startedAt: number;
  updatedAt: number;
};

export type HostState = {
  threads: Record<string, ThreadRecord>;
  episodes: Record<string, AlertEpisode>;
  /** When an alert rule's notification was last investigated automatically, by alert name. */
  analyses: Record<string, number>;
};

/** Where the state is kept: a file (one host), the plugin backend (replicas), or nowhere (tests). */
export type StatePersistence = {
  load(): Promise<Partial<HostState> | undefined>;
  save(state: HostState): Promise<void>;
};

/** A JSON file, written atomically. */
export function fileState(file: string): StatePersistence {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as Partial<HostState>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    },
    async save(state) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2));
      await rename(`${file}.tmp`, file);
    },
  };
}

/** Threads, episodes, and analyses untouched for this long are forgotten (default 30 days). */
const RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * The host's own state: which chat belongs to which thread, and which thread
 * belongs to which alert group. Chats themselves live in the plugin backend.
 * Old entries are dropped on each write, so the state stays small: a mention in
 * a forgotten thread starts a new chat, and a forgotten alert group a new thread.
 */
export class HostStore {
  private state: HostState = { threads: {}, episodes: {}, analyses: {} };
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence?: StatePersistence,
    private readonly retentionMs = RETENTION_MS
  ) {}

  async load() {
    const parsed = await this.persistence?.load();
    if (parsed) {
      this.state = { threads: parsed.threads ?? {}, episodes: parsed.episodes ?? {}, analyses: parsed.analyses ?? {} };
    }
  }

  threads(): Array<[string, ThreadRecord]> {
    return Object.entries(this.state.threads);
  }

  lastAnalysis(alertname: string): number | undefined {
    return this.state.analyses[alertname];
  }

  async setLastAnalysis(alertname: string, time: number) {
    this.state.analyses[alertname] = time;
    await this.save();
  }

  thread(key: string): ThreadRecord | undefined {
    return this.state.threads[key];
  }

  async setThread(key: string, update: Partial<ThreadRecord>) {
    this.state.threads[key] = { ...(this.state.threads[key] ?? { createdAt: Date.now() }), ...update };
    await this.save();
  }

  episode(groupKey: string): AlertEpisode | undefined {
    return this.state.episodes[groupKey];
  }

  async setEpisode(groupKey: string, episode: AlertEpisode) {
    this.state.episodes[groupKey] = episode;
    await this.save();
  }

  /** Drops entries last used before the retention period; pending runs stay until they are resumed or dropped. */
  private prune(now: number) {
    const before = now - this.retentionMs;
    for (const [key, thread] of Object.entries(this.state.threads)) {
      if (!thread.pending && Math.max(thread.createdAt, thread.lastAnswerAt ?? 0) < before) {
        delete this.state.threads[key];
      }
    }
    for (const [key, episode] of Object.entries(this.state.episodes)) {
      if (episode.updatedAt < before) {
        delete this.state.episodes[key];
      }
    }
    for (const [key, time] of Object.entries(this.state.analyses)) {
      if (time < before) {
        delete this.state.analyses[key];
      }
    }
  }

  private save() {
    this.prune(Date.now());
    const persistence = this.persistence;
    if (!persistence) {
      return Promise.resolve();
    }
    const snapshot = structuredClone(this.state);
    // Writes go out in order; a failed one does not stop the next.
    this.writing = this.writing.catch(() => undefined).then(() => persistence.save(snapshot));
    return this.writing;
  }
}
