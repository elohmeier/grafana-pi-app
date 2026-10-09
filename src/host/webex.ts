import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
  /**
   * Public URL of the host's `/webex/webhook` route, which Webex calls. Without
   * it, the channel receives messages over a websocket instead (no public URL).
   */
  webhookUrl?: string;
  /** Webhook secret; a random one is used when omitted. */
  webhookSecret?: string;
  /** Webex's service catalog (U2C), which names the device service of the bot's cluster. */
  catalogUrl?: string;
  /** The device service (WDM) base URL; looked up in the catalog when omitted. */
  deviceUrl?: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** Websocket keepalive (Webex's SDK: a ping every 15 s, answered within 14 s). */
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  /** First reconnect delay; it doubles per failed attempt up to 32 s. */
  reconnectDelayMs?: number;
  log?: (message: string) => void;
};

/** A device registration: the bot's endpoint for the event websocket (Mercury). */
type Device = { url: string; name: string; webSocketUrl: string };

/** A conversation activity, as Mercury delivers it. Its content is encrypted and not read. */
type Activity = {
  id: string;
  verb: string;
  actor?: { id?: string };
  target?: { id?: string; url?: string };
};

type MercuryEvent = {
  id?: string;
  type?: string;
  data?: { eventType?: string; activity?: Activity };
};

const WEBHOOK_NAME = 'grafana-assistant';
const CATALOG_URL = 'https://u2c.wbx2.com/u2c/api/v1/catalog';
const DEVICE = {
  deviceName: 'grafana-assistant-host',
  deviceType: 'DESKTOP',
  localizedModel: 'node',
  model: 'node',
  name: 'grafana-assistant-host',
  systemName: 'grafana-assistant-host',
  systemVersion: '1.0',
};
/** Close codes with which Webex refuses a device's websocket: register the device again. */
const DEVICE_REFUSED = new Set([1005, 4400, 4401, 4403, 4404]);
/**
 * A refused handshake (Webex answers 404 for a device it no longer knows) reads
 * as 1006 in the WebSocket API, like a network failure: after this many
 * failures in a row, the device is registered again.
 */
const FAILURES_BEFORE_REGISTERING = 3;
const AUTHORIZE_TIMEOUT_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 32_000;

/**
 * Webex through its REST API as a bot account. Messages arrive either through
 * a messages webhook or, without a public URL, over the websocket Webex's
 * clients use (Mercury). Both only name a message: webhook payloads carry its
 * ID, and websocket activities are encrypted end to end, so the text is
 * fetched with the bot's token, decrypted by Webex. Webex delivers group room
 * messages to a bot only when they mention it.
 */
export class WebexChannel implements ChatChannel {
  readonly name = 'webex';
  // Webex accepts 7439 bytes per message, and 10 edits of it.
  readonly maxMessageLength = 7000;
  readonly maxEdits = 10;
  readonly markdownTables = false;
  private botId = '';
  private botNames: string[] = [];
  private onMessage?: (message: ChannelMessage) => void;
  private readonly url: string;
  private readonly secret: string;
  private rooms = new Map<string, string>();
  private names = new Map<string, string>();
  /** The bot's person UUID, as websocket activities name their actor. */
  private botUuid = '';
  private device?: Device;
  private socket?: WebSocket;
  private stopped = false;
  private pingTimer?: ReturnType<typeof setTimeout>;
  private pongTimer?: ReturnType<typeof setTimeout>;
  /** Activities already delivered: a reconnect can deliver one again. */
  private seen = new Set<string>();

  constructor(private readonly options: WebexOptions) {
    this.url = options.url.replace(/\/$/, '');
    this.secret = options.webhookSecret ?? randomBytes(24).toString('hex');
  }

  measure(text: string) {
    return Buffer.byteLength(text);
  }

  async start(onMessage: (message: ChannelMessage) => void) {
    const me = await this.api<{ id: string; displayName: string }>('GET', '/people/me');
    this.botId = me.id;
    this.botUuid = uuidOf(me.id);
    this.botNames = [me.displayName, me.displayName.split(' ')[0]].filter(Boolean);
    this.onMessage = onMessage;
    this.stopped = false;
    // One webhook per host: replace earlier registrations of this bot. Without a
    // webhook URL, remove them, so Webex stops calling an address no longer used.
    const hooks = await this.api<{ items: Array<{ id: string; name: string }> }>('GET', '/webhooks');
    for (const hook of hooks.items.filter((item) => item.name === WEBHOOK_NAME)) {
      await this.api('DELETE', `/webhooks/${hook.id}`);
    }
    if (!this.options.webhookUrl) {
      this.device = await this.register(false);
      if (!(await this.connect(0))) {
        this.options.log?.('webex: websocket not connected yet; retrying in the background');
      }
      return;
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

  async stop() {
    this.stopped = true;
    this.clearKeepalive();
    this.socket?.close(1000, 'done (forced)');
    this.socket = undefined;
  }

  /**
   * A webhook call: verifies X-Spark-Signature (HMAC-SHA1 of the raw body) and
   * delivers the message it names. Returns the HTTP status to answer with.
   */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<number> {
    if (!this.options.webhookUrl) {
      return 404;
    }
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
    await this.deliver(payload.data.id);
    return 200;
  }

  /** Fetches a message by its ID and passes it on, unless the bot sent it. */
  private async deliver(messageId: string) {
    const message = await this.api<Message>('GET', `/messages/${messageId}`);
    if (message.personId === this.botId) {
      return;
    }
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
      // Webex identities are verified by the user's organization.
      verifiedEmail: message.personEmail,
    });
  }

  /**
   * The bot's device registration, reused across restarts by its name. With
   * `fresh`, the current one is removed and a new one is created, after Webex
   * refused its websocket.
   */
  private async register(fresh: boolean): Promise<Device> {
    const base = (this.options.deviceUrl ?? (await this.deviceService())).replace(/\/$/, '');
    if (fresh && this.device) {
      await this.request('DELETE', this.device.url).catch(() => undefined);
    }
    if (!fresh) {
      const existing = await this.request<{ devices?: Device[] }>('GET', `${base}/devices`);
      const device = existing.devices?.find((item) => item.name === DEVICE.name);
      if (device) {
        return device;
      }
    }
    const device = await this.request<Device>('POST', `${base}/devices`, DEVICE);
    this.options.log?.('webex: device registered');
    return device;
  }

  /** The device service (WDM) of the bot's cluster, from Webex's service catalog. */
  private async deviceService() {
    const catalog = await this.request<{ serviceLinks?: Record<string, string> }>(
      'GET',
      `${this.options.catalogUrl ?? CATALOG_URL}?format=hostmap`
    );
    const url = catalog.serviceLinks?.wdm;
    if (!url) {
      throw new Error('Webex service catalog names no device service (wdm)');
    }
    return url;
  }

  /**
   * Opens the event websocket and authorizes it with the bot's token. Resolves
   * true once Webex confirmed the authorization, false when the socket closed
   * first; a closed socket reconnects with backoff until `stop`.
   */
  private connect(attempt: number): Promise<boolean> {
    if (this.stopped || !this.device) {
      return Promise.resolve(false);
    }
    const url = new URL(this.device.webSocketUrl);
    url.searchParams.set('outboundWireFormat', 'text');
    url.searchParams.set('bufferStates', 'true');
    url.searchParams.set('aliasHttpStatus', 'true');
    url.searchParams.set('clientTimestamp', String(Date.now()));
    const Socket = this.options.WebSocket ?? WebSocket;
    const socket = new Socket(url.toString());
    this.socket = socket;
    let authorized = false;
    return new Promise<boolean>((resolve) => {
      const authorizeTimer = setTimeout(() => socket.close(4000, 'authorization timeout'), AUTHORIZE_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        this.send(socket, {
          id: randomUUID(),
          type: 'authorization',
          data: { token: `Bearer ${this.options.token}` },
        });
      });
      socket.addEventListener('message', (event) => {
        let data: MercuryEvent;
        try {
          data = JSON.parse(String(event.data)) as MercuryEvent;
        } catch {
          return;
        }
        // Every event is acknowledged, as Webex's SDK does.
        if (data.id) {
          this.send(socket, { messageId: data.id, type: 'ack' });
        }
        if (data.type === 'pong') {
          this.schedulePing(socket);
          return;
        }
        const eventType = data.data?.eventType;
        if (!authorized && (eventType === 'mercury.buffer_state' || eventType === 'mercury.registration_status')) {
          authorized = true;
          clearTimeout(authorizeTimer);
          this.options.log?.('webex: websocket connected');
          this.ping(socket);
          resolve(true);
          return;
        }
        if (eventType === 'conversation.activity' && data.data?.activity) {
          void this.handleActivity(data.data.activity).catch((error) =>
            this.options.log?.(`webex: activity failed: ${error instanceof Error ? error.message : String(error)}`)
          );
        }
      });
      socket.addEventListener('close', (event) => {
        clearTimeout(authorizeTimer);
        if (this.socket === socket) {
          this.clearKeepalive();
          this.socket = undefined;
        }
        resolve(false);
        if (this.stopped || this.socket) {
          return;
        }
        const next = authorized ? 0 : attempt + 1;
        const refused = !authorized && (DEVICE_REFUSED.has(event.code) || next % FAILURES_BEFORE_REGISTERING === 0);
        const delay = Math.min(
          MAX_RECONNECT_DELAY_MS,
          (this.options.reconnectDelayMs ?? 1000) * 2 ** Math.max(0, next - 1)
        );
        this.options.log?.(
          `webex: websocket closed (${event.code}${event.reason ? ` ${event.reason}` : ''}); reconnecting in ${delay} ms`
        );
        setTimeout(() => {
          void (async () => {
            if (this.stopped) {
              return;
            }
            if (refused) {
              this.device = await this.register(true);
            }
            await this.connect(next);
          })().catch((error) => {
            this.options.log?.(
              `webex: reconnect failed: ${error instanceof Error ? error.message : String(error)}; retrying`
            );
            setTimeout(() => void this.connect(next + 1), MAX_RECONNECT_DELAY_MS);
          });
        }, delay);
      });
    });
  }

  /** A new message (`post`, or `share` with files) from someone else: fetched and delivered once. */
  private async handleActivity(activity: Activity) {
    if (!['post', 'share'].includes(activity.verb) || activity.actor?.id === this.botUuid) {
      return;
    }
    if (this.seen.has(activity.id)) {
      return;
    }
    this.seen.add(activity.id);
    if (this.seen.size > 1000) {
      this.seen.delete(this.seen.values().next().value!);
    }
    const messageId = await this.messageId(activity);
    try {
      await this.deliver(messageId);
    } catch (error) {
      // A bot may not read group messages that do not mention it.
      if (!/failed: (403|404)\b/.test(error instanceof Error ? error.message : '')) {
        throw error;
      }
    }
  }

  /**
   * The REST ID of an activity's message. The conversation service of the
   * room's cluster maps it (as Webex's SDK and webex_bot do); the US-cluster
   * form is the fallback.
   */
  private async messageId(activity: Activity) {
    const { url, id } = activity.target ?? {};
    if (url && id) {
      const lookup = url.replace(`conversations/${id}`, `messages/${activity.id}`);
      const message = await this.request<{ id?: string }>('GET', lookup).catch(() => undefined);
      if (message?.id) {
        return message.id;
      }
    }
    return Buffer.from(`ciscospark://us/MESSAGE/${activity.id}`).toString('base64').replace(/=+$/, '');
  }

  /** Pings now; the pong schedules the next ping, and a missing pong closes the socket. */
  private ping(socket: WebSocket) {
    if (socket !== this.socket) {
      return;
    }
    clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => socket.close(4000, 'pong not received'), this.options.pongTimeoutMs ?? 14_000);
    this.send(socket, { id: randomUUID(), type: 'ping' });
  }

  private schedulePing(socket: WebSocket) {
    clearTimeout(this.pongTimer);
    clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => this.ping(socket), this.options.pingIntervalMs ?? 15_000);
  }

  private clearKeepalive() {
    clearTimeout(this.pingTimer);
    clearTimeout(this.pongTimer);
  }

  private send(socket: WebSocket, data: unknown) {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(data));
    }
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

  async postDirect(userId: string, text: string) {
    await this.api('POST', '/messages', { toPersonId: userId, markdown: text });
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

  private api<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, `${this.url}${path}`, body);
  }

  /** A Webex API request with the bot's token; other services than the REST API take absolute URLs. */
  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(url, {
      method,
      headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      const path = url.startsWith(this.url) ? url.slice(this.url.length) : new URL(url).pathname;
      throw new Error(`Webex ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/** The UUID inside a Webex REST ID (base64 of `ciscospark://<cluster>/<TYPE>/<uuid>`). */
function uuidOf(id: string) {
  return Buffer.from(id, 'base64').toString('utf8').split('/').pop() ?? '';
}
