import type { Context } from '@earendil-works/chord';
import {
  MemoryStorage,
  type ConversationId,
  type ConversationQuery,
  type Cursor,
  type DocumentAddress,
  type DocumentId,
  type DocumentPoint,
  type DocumentQuery,
  type EntryId,
  type EntryQuery,
  type Id,
  type Seq,
  type Storage,
  type StorageWrite,
  type SubmissionId,
  type SubmissionQuery,
  type TaskId,
  type TaskQuery,
} from '@earendil-works/pi-durable';
import { ChatLogError, type ChatCommitRow, type ChatLogClient, type OpenedChat } from './chatLogClient';

const LOG_PAGE_SIZE = 5000;
const COMMIT_ATTEMPTS = 4;

/** Thrown once the chat was opened elsewhere or its storage failed; the harness stops and must be reopened. */
export class ChatStorageLost extends Error {
  constructor(
    message: string,
    readonly reason: 'lease' | 'deleted' | 'failed'
  ) {
    super(message);
    this.name = 'ChatStorageLost';
  }
}

export type LogStorageOptions = {
  /** Create the chat when it does not exist; otherwise opening a missing chat fails. Default true. */
  create?: boolean;
  /** Title to store with the next commit; read at every commit. */
  title?: () => string | undefined;
  /** Called once when the storage stops accepting commits. */
  onLost?: (error: ChatStorageLost) => void;
  /** Delay between commit retries after a network failure. */
  retryDelayMs?: (attempt: number) => number;
};

/**
 * Durable storage of one chat. The chat lives in a MemoryStorage, which
 * defines the storage semantics; every commit is first appended to the chat's
 * log in the plugin backend and applied in memory only once the backend
 * confirmed it. Opening a chat replays its log.
 *
 * Opening makes this storage the chat's only writer: the backend refuses
 * commits from a storage that opened the chat earlier. Such a refusal, like
 * any commit whose outcome stays unknown, is fatal for the Session, which
 * then has to be reopened.
 */
export class LogStorage implements Storage {
  private readonly memory = new MemoryStorage();
  private readonly currentOnlyDocuments = new Set<DocumentId>();
  private lost?: ChatStorageLost;
  private titleSent?: string;

  private constructor(
    readonly chatId: string,
    private readonly client: ChatLogClient,
    private readonly opened: OpenedChat,
    private readonly options: LogStorageOptions
  ) {
    this.titleSent = opened.title || undefined;
  }

  /** Opens the chat, creating it when missing, and replays its log. */
  static async open(client: ChatLogClient, chatId: string, options: LogStorageOptions = {}) {
    const opened = await client.open(chatId, { title: options.title?.(), create: options.create });
    const storage = new LogStorage(chatId, client, opened, options);
    await storage.replay();
    return storage;
  }

  get summary() {
    return {
      id: this.opened.id,
      title: this.opened.title,
      createdAt: this.opened.createdAt,
      updatedAt: this.opened.updatedAt,
    };
  }

  get failure() {
    return this.lost;
  }

  private async replay() {
    let cursor: string | undefined;
    let batch: { seq: number; writes: StorageWrite[] } | undefined;
    const apply = () => {
      if (batch) {
        this.track(batch.writes);
        this.memory.prepareCommit(batch.writes, batch.seq as Seq).apply();
      }
    };
    do {
      const page = await this.client.log(this.chatId, { cursor, limit: LOG_PAGE_SIZE });
      for (const row of page.rows) {
        if (batch?.seq !== row.seq) {
          apply();
          batch = { seq: row.seq, writes: [] };
        }
        batch.writes.push(row.body as StorageWrite);
      }
      cursor = page.nextCursor;
    } while (cursor);
    apply();
    // A last commit without rows still consumed its sequence number.
    if (this.opened.lastSeq > (batch?.seq ?? 0)) {
      this.memory.prepareCommit([], this.opened.lastSeq as Seq).apply();
    }
  }

  async commit(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
    if (this.lost) {
      throw this.lost;
    }
    const prepared = this.memory.prepareCommit(writes);
    const rows = prepared.writes.map((write) => this.row(write));
    const title = this.options.title?.();
    const body = JSON.stringify(rows);
    const commit = {
      epoch: this.opened.epoch,
      seq: prepared.seq,
      digest: `${prepared.seq}:${body.length}:${fnv1a(body)}`,
      rows,
      ...(title && title !== this.titleSent ? { title } : {}),
    };
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.commit(this.chatId, commit);
        break;
      } catch (error) {
        const retry =
          error instanceof ChatLogError &&
          !error.definite &&
          attempt < COMMIT_ATTEMPTS &&
          !context.abortSignal?.aborted;
        if (retry) {
          await delay(this.options.retryDelayMs?.(attempt) ?? 250 * 2 ** (attempt - 1));
          continue;
        }
        throw this.lose(error);
      }
    }
    if (commit.title) {
      this.titleSent = commit.title;
    }
    this.track(prepared.writes);
    return prepared.apply();
  }

  private lose(error: unknown) {
    const lost =
      error instanceof ChatLogError && error.failure === 'lease'
        ? new ChatStorageLost('This chat was opened in another tab or window.', 'lease')
        : error instanceof ChatLogError && error.failure === 'deleted'
          ? new ChatStorageLost('This chat was deleted.', 'deleted')
          : new ChatStorageLost(
              `The chat could not be saved: ${error instanceof Error ? error.message : String(error)}`,
              'failed'
            );
    if (!this.lost) {
      this.lost = lost;
      this.options.onLost?.(lost);
    }
    return this.lost;
  }

  /** Remembers which documents keep only their current value; their older content can be pruned. */
  private track(writes: readonly StorageWrite[]) {
    for (const write of writes) {
      if (write.type === 'document.create' && isCurrentOnly(write.record)) {
        this.currentOnlyDocuments.add(write.record.id);
      }
    }
  }

  private row(write: StorageWrite): ChatCommitRow {
    switch (write.type) {
      case 'task':
        return { body: write, key: `task:${write.value.id}`, replace: true };
      case 'submission':
        return { body: write, key: `submission:${write.value.id}`, replace: true };
      case 'document.change':
        if (this.currentOnlyDocuments.has(write.id)) {
          return { body: write, key: `document:${write.id}`, replace: write.content.kind === 'base' };
        }
        return { body: write };
      default:
        return { body: write };
    }
  }

  mintId<I extends Id<string>>(): Promise<I> {
    return this.memory.mintId<I>();
  }

  conversation(id: ConversationId, context: Context) {
    return this.memory.conversation(id, context);
  }

  scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, context: Context) {
    return this.memory.scanConversations(query, limit, cursor, context);
  }

  entry(id: EntryId, context: Context): ReturnType<MemoryStorage['entry']>;
  entry(conversationId: ConversationId, id: EntryId, context: Context): ReturnType<MemoryStorage['entry']>;
  entry(...args: [EntryId, Context] | [ConversationId, EntryId, Context]) {
    return args.length === 2 ? this.memory.entry(args[0], args[1]) : this.memory.entry(args[0], args[1], args[2]);
  }

  findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, context: Context) {
    return this.memory.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context);
  }

  scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, context: Context) {
    return this.memory.scanEntries(query, limit, cursor, context);
  }

  task(id: TaskId, context: Context) {
    return this.memory.task(id, context);
  }

  scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, context: Context) {
    return this.memory.scanTasks(query, limit, cursor, context);
  }

  submission(id: SubmissionId, context: Context) {
    return this.memory.submission(id, context);
  }

  scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, context: Context) {
    return this.memory.scanSubmissions(query, limit, cursor, context);
  }

  submissionByRequest(conversationId: ConversationId, requestId: string, context: Context) {
    return this.memory.submissionByRequest(conversationId, requestId, context);
  }

  findDocument(address: DocumentAddress, at: DocumentPoint, context: Context) {
    return this.memory.findDocument(address, at, context);
  }

  document(id: DocumentId, at: DocumentPoint, context: Context) {
    return this.memory.document(id, at, context);
  }

  scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, context: Context) {
    return this.memory.scanDocuments(query, limit, cursor, context);
  }

  close(context: Context) {
    return this.memory.close(context);
  }
}

function isCurrentOnly(record: { scope: { kind: string }; history?: string }) {
  return record.scope.kind !== 'conversation' || record.history === 'latest';
}

function fnv1a(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
