import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type EntryId,
  type Id,
  type Seq,
  type Storage,
  type StorageWrite,
} from '@earendil-works/pi-durable';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { FakeChatLog } from './fakeChatLog';
import { ChatStorageLost, LogStorage } from './logStorage';

const context = BACKGROUND_CONTEXT;
const noDelay = { retryDelayMs: () => 0 };

let chatCounter = 0;
const nextChatId = () => `chat-${++chatCounter}`;

/** Reopens the chat from the backend after every commit, so every read sees replayed state. */
class ReopeningStorage implements Storage {
  private closed = false;

  constructor(
    private current: LogStorage,
    private readonly backend: FakeChatLog,
    private readonly chatId: string
  ) {}

  async commit(writes: readonly StorageWrite[], commitContext: Context): Promise<Seq> {
    if (this.closed) {
      return this.current.commit(writes, commitContext);
    }
    try {
      return await this.current.commit(writes, commitContext);
    } finally {
      await this.current.close(context);
      this.current = await LogStorage.open(this.backend, this.chatId, noDelay);
    }
  }

  mintId<I extends Id<string>>(): Promise<I> {
    return this.current.mintId<I>();
  }
  conversation: Storage['conversation'] = (id, c) => this.current.conversation(id, c);
  scanConversations: Storage['scanConversations'] = (q, l, cursor, c) =>
    this.current.scanConversations(q, l, cursor, c);
  entry(id: EntryId, c: Context): ReturnType<Storage['entry']>;
  entry(conversationId: ConversationId, id: EntryId, c: Context): ReturnType<Storage['entry']>;
  entry(...args: [EntryId, Context] | [ConversationId, EntryId, Context]) {
    return args.length === 2 ? this.current.entry(args[0], args[1]) : this.current.entry(args[0], args[1], args[2]);
  }
  findLatestHeadMarker: Storage['findLatestHeadMarker'] = (id, at, c) => this.current.findLatestHeadMarker(id, at, c);
  scanEntries: Storage['scanEntries'] = (q, l, cursor, c) => this.current.scanEntries(q, l, cursor, c);
  task: Storage['task'] = (id, c) => this.current.task(id, c);
  scanTasks: Storage['scanTasks'] = (q, l, cursor, c) => this.current.scanTasks(q, l, cursor, c);
  submission: Storage['submission'] = (id, c) => this.current.submission(id, c);
  scanSubmissions: Storage['scanSubmissions'] = (q, l, cursor, c) => this.current.scanSubmissions(q, l, cursor, c);
  submissionByRequest: Storage['submissionByRequest'] = (id, r, c) => this.current.submissionByRequest(id, r, c);
  findDocument: Storage['findDocument'] = (address, at, c) => this.current.findDocument(address, at, c);
  document: Storage['document'] = (id, at, c) => this.current.document(id, at, c);
  scanDocuments: Storage['scanDocuments'] = (q, l, cursor, c) => this.current.scanDocuments(q, l, cursor, c);

  async close(closeContext: Context) {
    if (!this.closed) {
      this.closed = true;
      await this.current.close(closeContext);
    }
  }
}

// The suite passes Vitest-style failure messages as a second argument, which Jest's expect rejects.
const runner = { describe, it, expect: (value: unknown) => expect(value) } as unknown as Parameters<
  typeof registerStorageConformance
>[0];

registerStorageConformance(runner, 'LogStorage conformance', async (run) => {
  const storage = await LogStorage.open(new FakeChatLog(), nextChatId(), noDelay);
  try {
    await run(storage);
  } finally {
    await storage.close(context);
  }
});

registerStorageConformance(runner, 'LogStorage conformance across reopen', async (run) => {
  const backend = new FakeChatLog();
  const chatId = nextChatId();
  const storage = new ReopeningStorage(await LogStorage.open(backend, chatId, noDelay), backend, chatId);
  try {
    await run(storage);
  } finally {
    await storage.close(context);
  }
});

const conversation = (): StorageWrite => ({ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } });

describe('LogStorage', () => {
  it('stops accepting commits once the chat was opened elsewhere', async () => {
    const backend = new FakeChatLog();
    const onLost = jest.fn();
    const first = await LogStorage.open(backend, 'chat', { ...noDelay, onLost });
    await first.commit([conversation()], context);

    const second = await LogStorage.open(backend, 'chat', noDelay);
    expect(await second.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });

    const lost = first.commit([{ type: 'conversation', value: { id: 5 as ConversationId } }], context);
    await expect(lost).rejects.toBeInstanceOf(ChatStorageLost);
    await expect(lost).rejects.toMatchObject({ reason: 'lease' });
    expect(onLost).toHaveBeenCalledTimes(1);
    // The refused commit was not applied.
    expect(await first.conversation(5 as ConversationId, context)).toBeUndefined();
  });

  it('retries a commit whose response was lost without committing it twice', async () => {
    const backend = new FakeChatLog();
    const storage = await LogStorage.open(backend, 'chat', noDelay);
    backend.loseNextCommitResponses = 1;
    backend.failNextCommits = 1;
    await storage.commit([conversation()], context);
    expect(backend.commits).toBe(1);
    expect(backend.chats.get('chat')!.rows).toHaveLength(1);
  });

  it('gives up after repeated network failures', async () => {
    const backend = new FakeChatLog();
    const storage = await LogStorage.open(backend, 'chat', noDelay);
    backend.failNextCommits = 10;
    await expect(storage.commit([conversation()], context)).rejects.toMatchObject({ reason: 'failed' });
    await expect(storage.commit([conversation()], context)).rejects.toBeInstanceOf(ChatStorageLost);
  });

  it('stores the title with the next commit and keeps the sequence after empty commits', async () => {
    const backend = new FakeChatLog();
    let title = 'First question';
    const storage = await LogStorage.open(backend, 'chat', { ...noDelay, title: () => title });
    expect(backend.chats.get('chat')!.title).toBe('First question');
    await storage.commit([], context);
    title = 'Renamed';
    await storage.commit([conversation()], context);
    expect(backend.chats.get('chat')!.title).toBe('Renamed');

    await storage.commit([], context);
    const reopened = await LogStorage.open(backend, 'chat', noDelay);
    await reopened.commit([{ type: 'conversation', value: { id: 9 as ConversationId } }], context);
    expect(backend.chats.get('chat')!.lastSeq).toBe(4);
  });
});
