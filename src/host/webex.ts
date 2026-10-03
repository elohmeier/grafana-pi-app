import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ChannelFile, ChannelMessage, ChatChannel, ThreadPost } from './channel';

type Message = {
  id: string;
  roomId: string;
  roomType: 'direct' | 'group';
  personId: string;
  personEmail: string;
  text?: string;
  markdown?: string;
  parentId?: string;
  mentionedPeople?: string[];
  created: string;
};

type WebexOptions = {
  /** API base, `https://webexapis.com/v1` for Webex. */
  url: string;
  /** Bot access token. */
  token: string;
  /** Public URL of the host's `/webex/webhook` route, which Webex calls. */
  webhookUrl: string;
  /** Webhook secret; a random one is used when omitted. */
  webhookSecret?: string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
};

const WEBHOOK_NAME = 'grafana-assistant';

/**
 * Webex through its REST API and a messages webhook, as a bot account. The
 * webhook payload names a message; its text is fetched with the bot's token.
 * Webex delivers group room messages to a bot only when they mention it.
 */
export class WebexChannel implements ChatChannel {
  readonly name = 'webex';
  // Webex accepts 7439 bytes per message.
  readonly maxMessageLength = 7000;
  readonly markdownTables = false;
  private botId = '';
  private botNames: string[] = [];
  private onMessage?: (message: ChannelMessage) => void;
  private readonly url: string;
  private readonly secret: string;
  private rooms = new Map<string, string>();
  private names = new Map<string, string>();

  constructor(private readonly options: WebexOptions) {
    this.url = options.url.replace(/\/$/, '');
    this.secret = options.webhookSecret ?? randomBytes(24).toString('hex');
  }

  async start(onMessage: (message: ChannelMessage) => void) {
    const me = await this.api<{ id: string; displayName: string }>('GET', '/people/me');
    this.botId = me.id;
    this.botNames = [me.displayName, me.displayName.split(' ')[0]].filter(Boolean);
    this.onMessage = onMessage;
    // One webhook per host: replace earlier registrations of this bot.
    const hooks = await this.api<{ items: Array<{ id: string; name: string }> }>('GET', '/webhooks');
    for (const hook of hooks.items.filter((item) => item.name === WEBHOOK_NAME)) {
      await this.api('DELETE', `/webhooks/${hook.id}`);
    }
    await this.api('POST', '/webhooks', {
      name: WEBHOOK_NAME,
      targetUrl: this.options.webhookUrl,
      resource: 'messages',
      event: 'created',
      secret: this.secret,
    });
    this.options.log?.(`webex: webhook registered for ${this.options.webhookUrl}`);
  }

  async stop() {}

  /**
   * A webhook call: verifies X-Spark-Signature (HMAC-SHA1 of the raw body) and
   * delivers the message it names. Returns the HTTP status to answer with.
   */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<number> {
    const expected = createHmac('sha1', this.secret).update(rawBody).digest('hex');
    if (
      !signature ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return 401;
    }
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      resource?: string;
      event?: string;
      data?: { id?: string; personId?: string };
    };
    if (payload.resource !== 'messages' || payload.event !== 'created' || !payload.data?.id) {
      return 200;
    }
    if (payload.data.personId === this.botId) {
      return 200;
    }
    const message = await this.api<Message>('GET', `/messages/${payload.data.id}`);
    this.rooms.set(message.id, message.roomId);
    const mentioned = message.mentionedPeople?.includes(this.botId) ?? false;
    this.onMessage?.({
      channelId: message.roomId,
      threadId: message.parentId || message.id,
      postId: message.id,
      userId: message.personId,
      userName: await this.displayName(message.personId, message.personEmail),
      text: mentioned ? this.withoutMention(message.text ?? '') : (message.text ?? '').trim(),
      direct: message.roomType === 'direct',
      mentioned,
      createdAt: Date.parse(message.created),
    });
    return 200;
  }

  async resolveChannel(name: string) {
    // A room ID, or the title of a group room the bot is in.
    if (/^Y2lzY29zcGFyazovL/.test(name)) {
      return name;
    }
    const rooms = await this.api<{ items: Array<{ id: string; title: string }> }>('GET', '/rooms?type=group&max=1000');
    const room = rooms.items.find((item) => item.title === name);
    if (!room) {
      throw new Error(`Webex room ${JSON.stringify(name)} not found among the bot's rooms`);
    }
    return room.id;
  }

  async post(channelId: string, text: string, threadId?: string) {
    const message = await this.api<Message>('POST', '/messages', {
      roomId: channelId,
      markdown: text,
      ...(threadId ? { parentId: threadId } : {}),
    });
    this.rooms.set(message.id, channelId);
    return { id: message.id };
  }

  async update(postId: string, text: string) {
    const roomId = this.rooms.get(postId) ?? (await this.api<Message>('GET', `/messages/${postId}`)).roomId;
    await this.api('PUT', `/messages/${postId}`, { roomId, markdown: text });
  }

  /** Webex takes one uploaded file per message: the text goes with the first. */
  async postFiles(channelId: string, text: string, files: ChannelFile[], threadId?: string) {
    let first: { id: string } | undefined;
    for (const [index, file] of files.entries()) {
      const form = new FormData();
      form.append('roomId', channelId);
      if (index === 0 && text) {
        form.append('markdown', text);
      }
      if (threadId) {
        form.append('parentId', threadId);
      }
      form.append('files', new Blob([file.data], { type: file.mimeType }), file.name);
      const response = await (this.options.fetch ?? fetch)(`${this.url}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.token}` },
        body: form,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Webex file upload failed: ${response.status} ${body.slice(0, 300)}`);
      }
      const message = JSON.parse(body) as Message;
      this.rooms.set(message.id, channelId);
      first ??= { id: message.id };
    }
    return first ?? this.post(channelId, text, threadId);
  }

  async thread(channelId: string, threadId: string): Promise<ThreadPost[]> {
    const [root, replies] = await Promise.all([
      this.api<Message>('GET', `/messages/${threadId}`),
      this.api<{ items: Message[] }>(
        'GET',
        `/messages?roomId=${encodeURIComponent(channelId)}&parentId=${encodeURIComponent(threadId)}&max=100`
      ),
    ]);
    const messages = [root, ...replies.items].sort(
      (left, right) => Date.parse(left.created) - Date.parse(right.created)
    );
    return Promise.all(
      messages.map(async (message) => ({
        userId: message.personId,
        userName: await this.displayName(message.personId, message.personEmail),
        text: message.text ?? '',
        createdAt: Date.parse(message.created),
        fromBot: message.personId === this.botId,
      }))
    );
  }

  /** The bot's display name starts a message that mentions it; the rest is the request. */
  private withoutMention(text: string) {
    let rest = text.trim();
    for (const name of this.botNames) {
      if (rest.toLowerCase().startsWith(name.toLowerCase())) {
        rest = rest.slice(name.length).trim();
        break;
      }
    }
    return rest;
  }

  private async displayName(personId: string, email: string) {
    let name = this.names.get(personId);
    if (!name) {
      const person = await this.api<{ displayName?: string }>('GET', `/people/${personId}`).catch(() => ({
        displayName: undefined,
      }));
      name = person.displayName || email;
      this.names.set(personId, name);
    }
    return name;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(`${this.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Webex ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
