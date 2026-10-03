import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A chat thread the assistant takes part in. */
export type ThreadRecord = {
  /** The assistant chat of the thread, once it has one. */
  chatId?: string;
  /** The chat exists in the plugin backend. */
  chatStored?: boolean;
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
  startedAt: number;
  updatedAt: number;
};

export type HostState = {
  threads: Record<string, ThreadRecord>;
  episodes: Record<string, AlertEpisode>;
  /** When an alert rule's notification was last investigated automatically, by alert name. */
  analyses: Record<string, number>;
};

/**
 * The host's own state: which chat belongs to which thread, and which thread
 * belongs to which alert group. One JSON file, written atomically; chats
 * themselves live in the plugin backend.
 */
export class HostStore {
  private state: HostState = { threads: {}, episodes: {}, analyses: {} };
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file?: string) {}

  async load() {
    if (!this.file) {
      return;
    }
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<HostState>;
      this.state = { threads: parsed.threads ?? {}, episodes: parsed.episodes ?? {}, analyses: parsed.analyses ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
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

  private save() {
    const file = this.file;
    if (!file) {
      return Promise.resolve();
    }
    const content = JSON.stringify(this.state, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, content);
      await rename(`${file}.tmp`, file);
    });
    return this.writing;
  }
}
