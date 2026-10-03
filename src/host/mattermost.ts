import type { ChannelFile, ChannelMessage, ChatChannel, ThreadPost } from './channel';

type Post = {
  id: string;
  channel_id: string;
  root_id?: string;
  user_id: string;
  message: string;
  type?: string;
  create_at: number;
};

type MattermostOptions = {
  url: string;
  /** Bot account access token. */
  token: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  log?: (message: string) => void;
};

/**
 * Mattermost through its REST API and websocket, as a bot account. The bot
 * sees direct messages and the channels it is a member of.
 */
export class MattermostChannel implements ChatChannel {
  readonly name = 'mattermost';
  readonly maxMessageLength = 16000;
  private botId = '';
  private botName = '';
  private socket?: WebSocket;
  private stopped = false;
  private seq = 1;
  private users = new Map<string, string>();
  private readonly url: string;

  constructor(private readonly options: MattermostOptions) {
    this.url = options.url.replace(/\/$/, '');
  }

  get botUserId() {
    return this.botId;
  }

  async start(onMessage: (message: ChannelMessage) => void) {
    const me = await this.api<{ id: string; username: string }>('GET', '/users/me');
    this.botId = me.id;
    this.botName = me.username;
    this.connect(onMessage, 0);
  }

  async stop() {
    this.stopped = true;
    this.socket?.close();
  }

  async resolveChannel(name: string) {
    const [team, channel] = name.split('/');
    if (!team || !channel) {
      throw new Error(`Mattermost channel ${JSON.stringify(name)}: use team/channel`);
    }
    const found = await this.api<{ id: string }>(
      'GET',
      `/teams/name/${encodeURIComponent(team)}/channels/name/${encodeURIComponent(channel)}`
    );
    return found.id;
  }

  async post(channelId: string, text: string, threadId?: string) {
    const post = await this.api<Post>('POST', '/posts', {
      channel_id: channelId,
      message: text,
      ...(threadId ? { root_id: threadId } : {}),
    });
    return { id: post.id };
  }

  async postFiles(channelId: string, text: string, files: ChannelFile[], threadId?: string) {
    const form = new FormData();
    form.append('channel_id', channelId);
    for (const file of files) {
      form.append('files', new Blob([file.data], { type: file.mimeType }), file.name);
    }
    const response = await (this.options.fetch ?? fetch)(`${this.url}/api/v4/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.token}` },
      body: form,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Mattermost file upload failed: ${response.status} ${body.slice(0, 300)}`);
    }
    const uploaded = JSON.parse(body) as { file_infos: Array<{ id: string }> };
    const post = await this.api<Post>('POST', '/posts', {
      channel_id: channelId,
      message: text,
      file_ids: uploaded.file_infos.map((info) => info.id),
      ...(threadId ? { root_id: threadId } : {}),
    });
    return { id: post.id };
  }

  async update(postId: string, text: string) {
    await this.api('PUT', `/posts/${postId}/patch`, { message: text });
  }

  async thread(threadId: string): Promise<ThreadPost[]> {
    const thread = await this.api<{ order: string[]; posts: Record<string, Post> }>('GET', `/posts/${threadId}/thread`);
    const posts = Object.values(thread.posts)
      .filter((post) => !post.type)
      .sort((left, right) => left.create_at - right.create_at);
    return Promise.all(
      posts.map(async (post) => ({
        userId: post.user_id,
        userName: await this.userName(post.user_id),
        text: post.message,
        createdAt: post.create_at,
        fromBot: post.user_id === this.botId,
      }))
    );
  }

  async typing(channelId: string, threadId?: string) {
    this.send('user_typing', { channel_id: channelId, ...(threadId ? { parent_id: threadId } : {}) });
  }

  private connect(onMessage: (message: ChannelMessage) => void, attempt: number) {
    if (this.stopped) {
      return;
    }
    const Socket = this.options.WebSocket ?? WebSocket;
    const socket = new Socket(`${this.url.replace(/^http/, 'ws')}/api/v4/websocket`);
    this.socket = socket;
    socket.addEventListener('open', () => {
      attempt = 0;
      this.send('authentication_challenge', { token: this.options.token });
      this.options.log?.('mattermost: connected');
    });
    socket.addEventListener('message', (event) => {
      void this.handleEvent(String(event.data), onMessage).catch((error) =>
        this.options.log?.(`mattermost: event failed: ${error instanceof Error ? error.message : String(error)}`)
      );
    });
    socket.addEventListener('close', () => {
      if (this.stopped) {
        return;
      }
      const delay = Math.min(30_000, 1000 * 2 ** attempt);
      this.options.log?.(`mattermost: disconnected; reconnecting in ${delay} ms`);
      setTimeout(() => this.connect(onMessage, attempt + 1), delay);
    });
  }

  private async handleEvent(raw: string, onMessage: (message: ChannelMessage) => void) {
    const event = JSON.parse(raw) as { event?: string; data?: Record<string, string> };
    if (event.event !== 'posted' || !event.data?.post) {
      return;
    }
    const post = JSON.parse(event.data.post) as Post;
    if (post.user_id === this.botId || post.type) {
      return;
    }
    const mentions: string[] = event.data.mentions ? JSON.parse(event.data.mentions) : [];
    const mentioned = mentions.includes(this.botId) || new RegExp(`@${this.botName}\\b`, 'i').test(post.message);
    onMessage({
      channelId: post.channel_id,
      threadId: post.root_id || post.id,
      postId: post.id,
      userId: post.user_id,
      userName: await this.userName(post.user_id),
      text: post.message.replace(new RegExp(`@${this.botName}\\b`, 'gi'), '').trim(),
      direct: event.data.channel_type === 'D',
      mentioned,
      createdAt: post.create_at,
    });
  }

  private send(action: string, data: Record<string, unknown>) {
    if (this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify({ seq: this.seq++, action, data }));
    }
  }

  private async userName(userId: string) {
    let name = this.users.get(userId);
    if (!name) {
      const user = await this.api<{ username: string }>('GET', `/users/${userId}`).catch(() => ({ username: userId }));
      name = user.username;
      this.users.set(userId, name);
    }
    return name;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(`${this.url}/api/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Mattermost ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
