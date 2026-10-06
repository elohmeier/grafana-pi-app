import { ChatLogError, type ChatCommit, type ChatLogClient, type ChatLogRow, type ChatSummary } from './chatLogClient';

type FakeChat = ChatSummary & {
  epoch: number;
  lastSeq: number;
  lastDigest: string;
  deleted: boolean;
  rows: Array<ChatLogRow & { key?: string }>;
};

/**
 * An in-memory chat log backend with the semantics of the plugin backend's
 * `/chats` API: open takes over the chat, commits need the current epoch and
 * the next sequence number, replace rows prune earlier rows with their key.
 * Rows are stored as JSON text, like the backend.
 */
export class FakeChatLog implements ChatLogClient {
  readonly chats = new Map<string, FakeChat>();
  commits = 0;
  /** Makes the next commit requests fail before reaching the backend. */
  failNextCommits = 0;
  /** Makes the next commit requests reach the backend but lose their response. */
  loseNextCommitResponses = 0;
  private clock = 0;

  private now() {
    return new Date(Date.UTC(2026, 0, 1) + ++this.clock * 1000).toISOString();
  }

  private chat(id: string) {
    const chat = this.chats.get(id);
    if (!chat) {
      throw new ChatLogError('chat not found', 'not-found', 404);
    }
    if (chat.deleted) {
      throw new ChatLogError('chat was deleted', 'deleted', 410);
    }
    return chat;
  }

  async list({ limit = 30 }: { limit?: number; cursor?: string }) {
    const items = [...this.chats.values()]
      .filter((chat) => !chat.deleted)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));
    return { items };
  }

  async open(id: string, options?: { title?: string; create?: boolean }) {
    let chat = this.chats.get(id);
    if (chat?.deleted) {
      throw new ChatLogError('chat was deleted', 'deleted', 410);
    }
    if (!chat && options?.create === false) {
      throw new ChatLogError('chat not found', 'not-found', 404);
    }
    if (!chat) {
      const now = this.now();
      chat = {
        id,
        title: options?.title ?? '',
        createdAt: now,
        updatedAt: now,
        epoch: 0,
        lastSeq: 0,
        lastDigest: '',
        deleted: false,
        rows: [],
      };
      this.chats.set(id, chat);
    }
    chat.epoch++;
    const { rows, deleted, lastDigest, ...opened } = chat;
    return { ...opened };
  }

  async log(id: string, { cursor, limit = 5000 }: { cursor?: string; limit?: number }) {
    const chat = this.chat(id);
    const start = cursor ? Number(cursor) : 0;
    const rows = chat.rows
      .slice(start, start + limit)
      .map(({ seq, idx, body }) => ({ seq, idx, body: JSON.parse(body as string) }));
    const next = start + limit;
    return { rows, ...(next < chat.rows.length ? { nextCursor: String(next) } : {}) };
  }

  async commit(id: string, commit: ChatCommit) {
    if (this.failNextCommits > 0) {
      this.failNextCommits--;
      throw new ChatLogError('network failure', 'unavailable');
    }
    const chat = this.chat(id);
    if (commit.epoch !== chat.epoch) {
      throw new ChatLogError('chat was opened elsewhere', 'lease', 409);
    }
    if (commit.seq === chat.lastSeq && commit.digest === chat.lastDigest) {
      return { seq: commit.seq, updatedAt: chat.updatedAt };
    }
    if (commit.seq <= chat.lastSeq) {
      throw new ChatLogError('sequence conflict', 'sequence', 409);
    }
    const replaced = new Set(commit.rows.filter((row) => row.replace && row.key).map((row) => row.key));
    chat.rows = chat.rows.filter((row) => !(row.key && replaced.has(row.key)));
    commit.rows.forEach((row, idx) => {
      chat.rows.push({ seq: commit.seq, idx, key: row.key, body: JSON.stringify(row.body) });
    });
    chat.lastSeq = commit.seq;
    chat.lastDigest = commit.digest;
    chat.updatedAt = this.now();
    if (commit.title) {
      chat.title = commit.title;
    }
    this.commits++;
    if (this.loseNextCommitResponses > 0) {
      this.loseNextCommitResponses--;
      throw new ChatLogError('response lost', 'unavailable');
    }
    return { seq: commit.seq, updatedAt: chat.updatedAt };
  }

  async rename(id: string, title: string) {
    const chat = this.chat(id);
    chat.title = title;
    return { id, title, createdAt: chat.createdAt, updatedAt: chat.updatedAt };
  }

  async delete(id: string) {
    const chat = this.chats.get(id);
    if (chat) {
      chat.deleted = true;
      chat.rows = [];
      chat.title = '';
    }
  }

  async share(id: string) {
    this.chat(id);
    return `share-${id}`;
  }

  /** Copies by token, like the backend: one copy, brought up to date while it was not written to. */
  private copies = new Map<string, { id: string; sourceSeq: number }>();

  async copyShared(token: string) {
    const source = this.chat(token.replace(/^share-/, ''));
    const now = this.now();
    const previous = this.copies.get(token);
    const existing = previous && this.chats.get(previous.id);
    if (previous && existing && !existing.deleted) {
      if (source.lastSeq === previous.sourceSeq) {
        return { id: existing.id, title: existing.title, createdAt: existing.createdAt, updatedAt: existing.updatedAt };
      }
      if (existing.lastSeq === previous.sourceSeq) {
        Object.assign(existing, {
          title: source.title,
          lastSeq: source.lastSeq,
          lastDigest: source.lastDigest,
          rows: structuredClone(source.rows),
          updatedAt: now,
        });
        this.copies.set(token, { id: existing.id, sourceSeq: source.lastSeq });
        return { id: existing.id, title: existing.title, createdAt: existing.createdAt, updatedAt: now };
      }
    }
    const id = `copy-${this.chats.size + 1}`;
    this.chats.set(id, {
      ...structuredClone(source),
      id,
      epoch: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.copies.set(token, { id, sourceSeq: source.lastSeq });
    return { id, title: source.title, createdAt: now, updatedAt: now };
  }
}
