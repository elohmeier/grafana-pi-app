/** Chat metadata as listed by the backend. */
export type ChatSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatPage = {
  items: ChatSummary[];
  nextCursor?: string;
};

/** The result of opening a chat: the caller is now its only writer, identified by `epoch`. */
export type OpenedChat = ChatSummary & {
  epoch: number;
  lastSeq: number;
};

/** One stored row of a commit. `body` is one serialized storage write. */
export type ChatLogRow = {
  seq: number;
  idx: number;
  body: unknown;
};

export type ChatLogPage = {
  rows: ChatLogRow[];
  nextCursor?: string;
};

/**
 * A row to append. A row with `replace` deletes the stored rows with the same
 * `key` from earlier commits, which drops superseded task records and document
 * content before a new base.
 */
export type ChatCommitRow = {
  body: unknown;
  key?: string;
  replace?: boolean;
};

export type ChatCommit = {
  epoch: number;
  seq: number;
  /** Identifies the commit body, so a retry after a lost response is recognized. */
  digest: string;
  rows: ChatCommitRow[];
  title?: string;
};

/** Why the backend refused a commit or an open. */
export type ChatLogFailure = 'lease' | 'sequence' | 'deleted' | 'not-found' | 'invalid' | 'unavailable';

export class ChatLogError extends Error {
  constructor(
    message: string,
    readonly failure: ChatLogFailure,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ChatLogError';
  }

  /** The request reached the backend and was refused; repeating it cannot succeed. */
  get definite() {
    return this.failure !== 'unavailable';
  }
}

/** The plugin backend's chat log API (`/chats`). */
export interface ChatLogClient {
  list(options: { limit?: number; cursor?: string }): Promise<ChatPage>;
  /** Takes over the chat; `create: false` opens only an existing chat. */
  open(id: string, options?: { title?: string; create?: boolean }): Promise<OpenedChat>;
  log(id: string, options: { cursor?: string; limit?: number }): Promise<ChatLogPage>;
  commit(id: string, commit: ChatCommit): Promise<{ seq: number; updatedAt: string }>;
  rename(id: string, title: string): Promise<ChatSummary>;
  delete(id: string): Promise<void>;
}

export type ChatLogRequest = (request: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  params?: Record<string, string | number | undefined>;
  body?: unknown;
}) => Promise<{ status: number; data: unknown }>;

/** A client over a raw request function. Network failures must reject; HTTP errors must resolve with their status. */
export function createChatLogClient(request: ChatLogRequest): ChatLogClient {
  const send = async <T>(input: Parameters<ChatLogRequest>[0]): Promise<T> => {
    let response: { status: number; data: unknown };
    try {
      response = await request(input);
    } catch (error) {
      throw new ChatLogError(
        `Chat storage is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        'unavailable'
      );
    }
    if (response.status >= 200 && response.status < 300) {
      return response.data as T;
    }
    throw toChatLogError(response.status, response.data);
  };
  const chat = (id: string) => `/chats/${encodeURIComponent(id)}`;
  return {
    list: ({ limit, cursor }) => send({ method: 'GET', path: '/chats', params: { limit, cursor } }),
    open: (id, options) =>
      send({
        method: 'POST',
        path: `${chat(id)}/open`,
        body: { title: options?.title, create: options?.create ?? true },
      }),
    log: (id, { cursor, limit }) => send({ method: 'GET', path: `${chat(id)}/log`, params: { cursor, limit } }),
    commit: (id, commit) => send({ method: 'POST', path: `${chat(id)}/commits`, body: commit }),
    rename: (id, title) => send({ method: 'PATCH', path: chat(id), body: { title } }),
    delete: async (id) => {
      await send({ method: 'DELETE', path: chat(id) });
    },
  };
}

function toChatLogError(status: number, data: unknown) {
  const body =
    data && typeof data === 'object' ? (data as { error?: unknown; message?: unknown; reason?: unknown }) : {};
  const message = String(body.error ?? body.message ?? `Chat storage request failed with status ${status}`);
  if (status === 409) {
    return new ChatLogError(message, body.reason === 'sequence' ? 'sequence' : 'lease', status);
  }
  if (status === 410) {
    return new ChatLogError(message, 'deleted', status);
  }
  if (status === 404) {
    return new ChatLogError(message, 'not-found', status);
  }
  // An expired Grafana session is renewed by the next request.
  if (status === 401) {
    return new ChatLogError(message, 'unavailable', status);
  }
  if (status >= 400 && status < 500) {
    return new ChatLogError(message, 'invalid', status);
  }
  return new ChatLogError(message, 'unavailable', status);
}
