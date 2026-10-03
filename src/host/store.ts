import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A chat thread the assistant takes part in. */
export type ThreadRecord = {
  /** The assistant chat of the thread, once it has one. */
  chatId?: string;
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
  startedAt: number;
  updatedAt: number;
};

export type HostState = {
  threads: Record<string, ThreadRecord>;
  episodes: Record<string, AlertEpisode>;
};

/**
 * The host's own state: which chat belongs to which thread, and which thread
 * belongs to which alert group. One JSON file, written atomically; chats
 * themselves live in the plugin backend.
 */
export class HostStore {
  private state: HostState = { threads: {}, episodes: {} };
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file?: string) {}

  async load() {
    if (!this.file) {
      return;
    }
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<HostState>;
      this.state = { threads: parsed.threads ?? {}, episodes: parsed.episodes ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
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
