import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * An in-memory Webex API for tests of the assistant host's Webex adapter: the
 * subset the adapter uses (people, rooms, messages with threads, edits, file
 * uploads, webhooks with X-Spark-Signature) plus a control API under /_test.
 *
 * Behavior follows the Webex REST API as documented: webhook payloads carry
 * the message ID but not its text, bots receive group room messages only when
 * mentioned, a reply's parentId must be a thread root, a message holds at most
 * one uploaded file and 7439 bytes of text, and it can be edited 10 times.
 *
 * The websocket Webex's clients use (Mercury) follows Webex's JavaScript SDK
 * and webex_bot: the service catalog (U2C) names the device service (WDM), a
 * device registration names its websocket, the socket is authorized with an
 * `authorization` message and confirmed with a `mercury.buffer_state` event,
 * pings are answered with pongs, and a second connection of a device replaces
 * the first (close code 4000). Activities name messages by UUID, with content
 * that stands for Webex's encryption; the conversation service maps a UUID to
 * the REST ID. Every activity of a room goes to every member's sockets; what a
 * bot may read is left to the REST API.
 */

export type FakePerson = { id: string; emails: string[]; displayName: string; type: 'person' | 'bot'; token: string };
export type FakeRoom = { id: string; title: string; type: 'direct' | 'group'; members: string[]; created: string };
export type FakeMessage = {
  id: string;
  roomId: string;
  roomType: 'direct' | 'group';
  personId: string;
  personEmail: string;
  text?: string;
  markdown?: string;
  html?: string;
  parentId?: string;
  mentionedPeople?: string[];
  files?: string[];
  created: string;
  updated?: string;
};
type FakeWebhook = {
  id: string;
  name: string;
  targetUrl: string;
  resource: string;
  event: string;
  secret?: string;
  ownerId: string;
  created: string;
};
type FakeFile = { name: string; mimeType: string; data: Buffer };
type FakeDevice = {
  id: string;
  ownerId: string;
  name: string;
  deviceType?: string;
  url: string;
  webSocketUrl: string;
  created: string;
};
/** `origin`: the fake as the client reached it, for the URLs in its events. */
type FakeSocket = { socket: WebSocket; deviceId: string; origin: string; ownerId?: string; sequence: number };
export type Delivery = { webhookId: string; targetUrl: string; status: number | 'error'; body: string };

const MAX_TEXT_BYTES = 7439;
const MAX_EDITS = 10;

export class WebexFake {
  readonly people = new Map<string, FakePerson>();
  readonly rooms = new Map<string, FakeRoom>();
  readonly messages = new Map<string, FakeMessage>();
  readonly deliveries: Delivery[] = [];
  private webhooks = new Map<string, FakeWebhook>();
  private files = new Map<string, FakeFile>();
  private edits = new Map<string, number>();
  readonly devices = new Map<string, FakeDevice>();
  /** Acknowledged websocket event IDs, by device. */
  readonly acks: Array<{ deviceId: string; messageId: string }> = [];
  private sockets = new Set<FakeSocket>();
  /** Whether pings are answered; off, a client's keepalive must notice the dead connection. */
  answerPings = true;
  private websockets = new WebSocketServer({ noServer: true });
  private server?: Server;
  private pending = new Set<Promise<unknown>>();
  baseUrl = '';

  async listen(port = 0, host = '127.0.0.1') {
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        send(response, 500, { message: error instanceof Error ? error.message : String(error) });
      });
    });
    this.server.on('upgrade', (request, socket, head) => {
      const match = new URL(request.url ?? '/', 'http://fake').pathname.match(/^\/mercury\/([^/]+)$/);
      const device = match && this.devices.get(match[1]);
      if (!device) {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
      }
      this.websockets.handleUpgrade(request, socket, head, (websocket) =>
        this.attach(websocket, device, this.origin(request))
      );
    });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const address = this.server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    this.baseUrl = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`;
    return this;
  }

  async close() {
    await this.settled();
    for (const { socket } of this.sockets) {
      socket.terminate();
    }
    this.websockets.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Authorized websocket connections, by device owner. */
  connections(ownerId?: string) {
    return [...this.sockets].filter((entry) => entry.ownerId && (!ownerId || entry.ownerId === ownerId));
  }

  /** Closes every websocket as a lost connection would (1006 is not sendable; 4000 reads as a server close). */
  dropSockets(code = 1011) {
    for (const { socket } of this.sockets) {
      socket.close(code, 'dropped');
    }
  }

  /** Resolves when every webhook delivery started so far has finished. */
  async settled() {
    while (this.pending.size) {
      await Promise.allSettled([...this.pending]);
    }
  }

  addPerson(input: { email: string; displayName: string; bot?: boolean }): FakePerson {
    const person: FakePerson = {
      id: id('PEOPLE'),
      emails: [input.email],
      displayName: input.displayName,
      type: input.bot ? 'bot' : 'person',
      token: `token-${randomUUID()}`,
    };
    this.people.set(person.id, person);
    return person;
  }

  addRoom(input: { title: string; type?: 'direct' | 'group'; members: string[] }): FakeRoom {
    const room: FakeRoom = {
      id: id('ROOM'),
      title: input.title,
      type: input.type ?? 'group',
      members: input.members.map((member) => this.person(member).id),
      created: now(),
    };
    this.rooms.set(room.id, room);
    return room;
  }

  /** Posts as a person, as the Webex client does: a mention puts the display name in the text. */
  postAs(who: string, input: { roomId: string; text: string; mentions?: string[]; parentId?: string }): FakeMessage {
    const person = this.person(who);
    const mentioned = (input.mentions ?? []).map((mention) => this.person(mention));
    const text = [...mentioned.map((mention) => mention.displayName), input.text].join(' ');
    const markdown = [
      ...mentioned.map((mention) => `<@personId:${mention.id}|${mention.displayName}>`),
      input.text,
    ].join(' ');
    return this.createMessage(person, {
      roomId: input.roomId,
      text,
      markdown,
      parentId: input.parentId,
      mentionedPeople: mentioned.map((mention) => mention.id),
    });
  }

  /** Messages of a room, oldest first, with replies. */
  roomMessages(roomId: string) {
    return [...this.messages.values()].filter((message) => message.roomId === roomId);
  }

  file(url: string) {
    return this.files.get(url.split('/').pop() ?? '');
  }

  private person(ref: string) {
    const person = [...this.people.values()].find(
      (candidate) => candidate.id === ref || candidate.emails.includes(ref)
    );
    if (!person) {
      throw new Error(`no such person ${ref}`);
    }
    return person;
  }

  private createMessage(
    sender: FakePerson,
    input: {
      roomId: string;
      text?: string;
      markdown?: string;
      parentId?: string;
      mentionedPeople?: string[];
      file?: FakeFile;
    }
  ): FakeMessage {
    const room = this.rooms.get(input.roomId);
    if (!room || !room.members.includes(sender.id)) {
      throw new ApiError(404, 'The requested resource could not be found.');
    }
    if (input.parentId) {
      const parent = this.messages.get(input.parentId);
      if (!parent || parent.roomId !== room.id) {
        throw new ApiError(404, 'Parent message not found.');
      }
      if (parent.parentId) {
        throw new ApiError(400, 'Cannot reply to a reply; use the parent of the thread.');
      }
    }
    const body = input.markdown ?? input.text ?? '';
    if (!body && !input.file) {
      throw new ApiError(400, 'Message text, markdown, or a file is required.');
    }
    if (Buffer.byteLength(body) > MAX_TEXT_BYTES) {
      throw new ApiError(400, `Message exceeds the maximum length of ${MAX_TEXT_BYTES} bytes.`);
    }
    const message: FakeMessage = {
      id: id('MESSAGE'),
      roomId: room.id,
      roomType: room.type,
      personId: sender.id,
      personEmail: sender.emails[0],
      ...(input.text !== undefined || input.markdown !== undefined
        ? { text: input.text ?? stripMarkdown(input.markdown ?? '') }
        : {}),
      ...(input.markdown ? { markdown: input.markdown, html: `<p>${input.markdown}</p>` } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.mentionedPeople?.length ? { mentionedPeople: input.mentionedPeople } : {}),
      created: now(),
    };
    if (input.file) {
      const fileId = randomUUID();
      this.files.set(fileId, input.file);
      message.files = [`${this.baseUrl}/v1/contents/${fileId}`];
    }
    this.messages.set(message.id, message);
    this.deliver(message);
    this.publish(message, message.files ? 'share' : 'post');
    return message;
  }

  /** Signed webhook calls for a new message, to every webhook owner who may see it. */
  private deliver(message: FakeMessage) {
    const room = this.rooms.get(message.roomId)!;
    for (const webhook of this.webhooks.values()) {
      if (webhook.resource !== 'messages' || !['created', 'all'].includes(webhook.event)) {
        continue;
      }
      const owner = this.people.get(webhook.ownerId);
      if (!owner || !room.members.includes(owner.id)) {
        continue;
      }
      // Bots see group room messages only when mentioned (their own included).
      if (
        owner.type === 'bot' &&
        room.type === 'group' &&
        message.personId !== owner.id &&
        !message.mentionedPeople?.includes(owner.id)
      ) {
        continue;
      }
      const body = JSON.stringify({
        id: webhook.id,
        name: webhook.name,
        targetUrl: webhook.targetUrl,
        resource: 'messages',
        event: 'created',
        orgId: 'fake-org',
        createdBy: owner.id,
        appId: 'fake-app',
        ownedBy: 'creator',
        status: 'active',
        created: webhook.created,
        actorId: message.personId,
        data: {
          id: message.id,
          roomId: message.roomId,
          roomType: message.roomType,
          personId: message.personId,
          personEmail: message.personEmail,
          created: message.created,
        },
      });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (webhook.secret) {
        headers['X-Spark-Signature'] = createHmac('sha1', webhook.secret).update(body).digest('hex');
      }
      const delivery = fetch(webhook.targetUrl, { method: 'POST', headers, body }).then(
        (response) =>
          this.deliveries.push({ webhookId: webhook.id, targetUrl: webhook.targetUrl, status: response.status, body }),
        () => this.deliveries.push({ webhookId: webhook.id, targetUrl: webhook.targetUrl, status: 'error', body })
      );
      this.pending.add(delivery);
      void delivery.finally(() => this.pending.delete(delivery));
    }
  }

  /** A websocket of a device: authorized by its owner's token, then it receives the owner's activities. */
  private attach(socket: WebSocket, device: FakeDevice, origin: string) {
    const entry: FakeSocket = { socket, deviceId: device.id, origin, sequence: 0 };
    socket.on('message', (raw) => {
      let data: { id?: string; type?: string; messageId?: string; data?: { token?: string } };
      try {
        data = JSON.parse(String(raw));
      } catch {
        socket.close(4400, 'invalid message');
        return;
      }
      if (data.type === 'authorization') {
        const owner = this.people.get(device.ownerId);
        if (!owner || data.data?.token !== `Bearer ${owner.token}`) {
          socket.close(4401, 'authentication failed');
          return;
        }
        // One connection per device: a new one replaces the previous.
        for (const other of this.sockets) {
          if (other !== entry && other.deviceId === device.id) {
            other.socket.close(4000, 'replaced');
            this.sockets.delete(other);
          }
        }
        entry.ownerId = owner.id;
        this.send(entry, { data: { eventType: 'mercury.buffer_state' } });
        return;
      }
      if (data.type === 'ping' && entry.ownerId && this.answerPings) {
        socket.send(JSON.stringify({ id: data.id, type: 'pong' }));
        return;
      }
      if (data.type === 'ack' && data.messageId) {
        this.acks.push({ deviceId: device.id, messageId: data.messageId });
      }
    });
    socket.on('close', () => this.sockets.delete(entry));
    this.sockets.add(entry);
  }

  private send(entry: FakeSocket, event: { data: Record<string, unknown> }) {
    entry.sequence++;
    entry.socket.send(
      JSON.stringify({
        id: randomUUID(),
        ...event,
        timestamp: Date.now(),
        trackingId: `fake_${randomUUID()}`,
        alertType: 'full',
        headers: {},
        sequenceNumber: entry.sequence,
        filterMessage: false,
      })
    );
  }

  /** A conversation activity for a message, to the sockets of the room's members. */
  private publish(message: FakeMessage, verb: 'post' | 'share' | 'update') {
    const room = this.rooms.get(message.roomId)!;
    const sender = this.people.get(message.personId)!;
    const activity = (origin: string) => ({
      id: uuidOf(message.id),
      objectType: 'activity',
      verb,
      actor: { id: uuidOf(sender.id), objectType: 'person', emailAddress: sender.emails[0] },
      // Webex encrypts content; the adapter must fetch the message instead.
      object: { objectType: 'comment', displayName: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..encrypted' },
      target: {
        id: uuidOf(room.id),
        objectType: 'conversation',
        url: `${origin}/conversation/api/v1/conversations/${uuidOf(room.id)}`,
      },
      ...(message.parentId ? { parent: { id: uuidOf(message.parentId), type: 'reply' } } : {}),
      published: message.updated ?? message.created,
      encryptionKeyUrl: 'kms://fake/keys/1',
    });
    for (const entry of this.sockets) {
      if (entry.ownerId && room.members.includes(entry.ownerId)) {
        this.send(entry, { data: { eventType: 'conversation.activity', activity: activity(entry.origin) } });
      }
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://fake');
    const path = url.pathname;
    const raw = await readBody(request);
    try {
      if (path.startsWith('/_test/')) {
        return send(response, 200, this.control(request.method ?? 'GET', path, raw));
      }
      const caller = this.caller(request);
      const method = request.method ?? 'GET';
      let match: RegExpMatchArray | null;
      if (method === 'GET' && path === '/u2c/api/v1/catalog') {
        return send(response, 200, { serviceLinks: { wdm: `${this.origin(request)}/wdm/api/v1` } });
      }
      if (path === '/wdm/api/v1/devices' && method === 'GET') {
        const devices = [...this.devices.values()].filter((device) => device.ownerId === caller.id);
        return send(response, 200, { devices: devices.map(publicDevice) });
      }
      if (path === '/wdm/api/v1/devices' && method === 'POST') {
        const body = JSON.parse(raw.toString('utf8')) as { name?: string; deviceType?: string };
        if (!body.name || !body.deviceType) {
          throw new ApiError(400, 'name and deviceType are required.');
        }
        const deviceId = randomUUID();
        const device: FakeDevice = {
          id: deviceId,
          ownerId: caller.id,
          name: body.name,
          deviceType: body.deviceType,
          url: `${this.origin(request)}/wdm/api/v1/devices/${deviceId}`,
          webSocketUrl: `${this.origin(request).replace(/^http/, 'ws')}/mercury/${deviceId}`,
          created: now(),
        };
        this.devices.set(deviceId, device);
        return send(response, 200, publicDevice(device));
      }
      if (method === 'DELETE' && (match = path.match(/^\/wdm\/api\/v1\/devices\/([^/]+)$/))) {
        const device = this.devices.get(match[1]);
        if (!device || device.ownerId !== caller.id) {
          throw new ApiError(404, 'The requested resource could not be found.');
        }
        this.devices.delete(device.id);
        for (const entry of this.sockets) {
          if (entry.deviceId === device.id) {
            entry.socket.close(4404, 'device deleted');
          }
        }
        response.writeHead(204);
        response.end();
        return;
      }
      // The conversation service names a message by its UUID; the REST ID comes back as `id`.
      if (method === 'GET' && (match = path.match(/^\/conversation\/api\/v1\/messages\/([^/]+)$/))) {
        const message = [...this.messages.values()].find((candidate) => uuidOf(candidate.id) === match![1]);
        if (!message || !this.rooms.get(message.roomId)?.members.includes(caller.id)) {
          throw new ApiError(404, 'The requested resource could not be found.');
        }
        return send(response, 200, { id: message.id, objectType: 'activity', verb: 'post' });
      }
      if (method === 'GET' && path === '/v1/people/me') {
        return send(response, 200, publicPerson(caller));
      }
      if (method === 'GET' && (match = path.match(/^\/v1\/people\/([^/]+)$/))) {
        return send(response, 200, publicPerson(this.person(decodeURIComponent(match[1]))));
      }
      if (method === 'GET' && path === '/v1/rooms') {
        const type = url.searchParams.get('type');
        const items = [...this.rooms.values()].filter(
          (room) => room.members.includes(caller.id) && (!type || room.type === type)
        );
        return send(response, 200, { items: items.map(({ members: _members, ...room }) => room) });
      }
      if (method === 'POST' && path === '/v1/messages') {
        return send(response, 200, await this.postMessage(caller, request, raw));
      }
      if (method === 'GET' && path === '/v1/messages') {
        const roomId = url.searchParams.get('roomId') ?? '';
        const room = this.rooms.get(roomId);
        if (!room || !room.members.includes(caller.id)) {
          throw new ApiError(404, 'The requested resource could not be found.');
        }
        // Bots list group room messages only with mentionedPeople=me or within a thread they can see.
        const parentId = url.searchParams.get('parentId');
        const max = Number(url.searchParams.get('max') ?? 50);
        const items = this.roomMessages(roomId)
          .filter((message) => (parentId ? message.parentId === parentId : true))
          .reverse()
          .slice(0, max);
        return send(response, 200, { items });
      }
      if ((match = path.match(/^\/v1\/messages\/([^/]+)$/))) {
        const message = this.messages.get(decodeURIComponent(match[1]));
        const room = message && this.rooms.get(message.roomId);
        if (!message || !room?.members.includes(caller.id)) {
          throw new ApiError(404, 'The requested resource could not be found.');
        }
        if (method === 'GET') {
          return send(response, 200, message);
        }
        if (method === 'PUT') {
          const body = JSON.parse(raw.toString('utf8')) as { roomId?: string; text?: string; markdown?: string };
          if (message.personId !== caller.id) {
            throw new ApiError(403, 'Only the sender can edit a message.');
          }
          if (body.roomId !== message.roomId) {
            throw new ApiError(400, 'roomId is required and must match the message.');
          }
          const text = body.markdown ?? body.text ?? '';
          if (!text || Buffer.byteLength(text) > MAX_TEXT_BYTES) {
            throw new ApiError(400, 'Message text is missing or too long.');
          }
          const edits = (this.edits.get(message.id) ?? 0) + 1;
          if (edits > MAX_EDITS) {
            throw new ApiError(400, `A message can be edited at most ${MAX_EDITS} times.`);
          }
          this.edits.set(message.id, edits);
          message.markdown = body.markdown;
          message.text = body.text ?? stripMarkdown(body.markdown ?? '');
          message.updated = now();
          this.publish(message, 'update');
          return send(response, 200, message);
        }
      }
      if (method === 'GET' && (match = path.match(/^\/v1\/contents\/([^/]+)$/))) {
        const file = this.files.get(match[1]);
        if (!file) {
          throw new ApiError(404, 'The requested resource could not be found.');
        }
        response.writeHead(200, {
          'Content-Type': file.mimeType,
          'Content-Disposition': `attachment; filename="${file.name}"`,
        });
        response.end(file.data);
        return;
      }
      if (path === '/v1/webhooks' && method === 'GET') {
        return send(response, 200, {
          items: [...this.webhooks.values()].filter((hook) => hook.ownerId === caller.id).map(publicWebhook),
        });
      }
      if (path === '/v1/webhooks' && method === 'POST') {
        const body = JSON.parse(raw.toString('utf8')) as Partial<FakeWebhook>;
        if (!body.name || !body.targetUrl || !body.resource || !body.event) {
          throw new ApiError(400, 'name, targetUrl, resource, and event are required.');
        }
        const webhook: FakeWebhook = {
          id: id('WEBHOOK'),
          name: body.name,
          targetUrl: body.targetUrl,
          resource: body.resource,
          event: body.event,
          ...(body.secret ? { secret: body.secret } : {}),
          ownerId: caller.id,
          created: now(),
        };
        this.webhooks.set(webhook.id, webhook);
        return send(response, 200, publicWebhook(webhook));
      }
      if (method === 'DELETE' && (match = path.match(/^\/v1\/webhooks\/([^/]+)$/))) {
        const webhook = this.webhooks.get(match[1]);
        if (!webhook || webhook.ownerId !== caller.id) {
          throw new ApiError(404, 'The requested resource could not be found.');
        }
        this.webhooks.delete(webhook.id);
        response.writeHead(204);
        response.end();
        return;
      }
      throw new ApiError(404, `no route ${method} ${path}`);
    } catch (error) {
      if (error instanceof ApiError) {
        return send(response, error.status, { message: error.message, errors: [{ description: error.message }] });
      }
      throw error;
    }
  }

  private async postMessage(caller: FakePerson, request: IncomingMessage, raw: Buffer) {
    const type = request.headers['content-type'] ?? '';
    if (type.startsWith('multipart/form-data')) {
      const form = await new Response(new Uint8Array(raw), { headers: { 'Content-Type': type } }).formData();
      const files = form.getAll('files').filter((value): value is File => typeof value !== 'string');
      if (files.length > 1) {
        throw new ApiError(400, 'Only one file can be uploaded per message.');
      }
      const file = files[0];
      return this.createMessage(caller, {
        roomId: String(form.get('roomId') ?? ''),
        ...(form.get('text') ? { text: String(form.get('text')) } : {}),
        ...(form.get('markdown') ? { markdown: String(form.get('markdown')) } : {}),
        ...(form.get('parentId') ? { parentId: String(form.get('parentId')) } : {}),
        ...(file
          ? {
              file: {
                name: file.name,
                mimeType: file.type || 'application/octet-stream',
                data: Buffer.from(await file.arrayBuffer()),
              },
            }
          : {}),
      });
    }
    const body = JSON.parse(raw.toString('utf8')) as {
      roomId?: string;
      toPersonEmail?: string;
      toPersonId?: string;
      text?: string;
      markdown?: string;
      parentId?: string;
    };
    let roomId = body.roomId ?? '';
    // A message to a person goes to the direct room with them, created on first use.
    if (!roomId && (body.toPersonId || body.toPersonEmail)) {
      const other = this.person(body.toPersonId ?? body.toPersonEmail!);
      roomId =
        [...this.rooms.values()].find(
          (room) => room.type === 'direct' && room.members.includes(caller.id) && room.members.includes(other.id)
        )?.id ?? this.addRoom({ title: other.displayName, type: 'direct', members: [caller.id, other.id] }).id;
    }
    return this.createMessage(caller, { roomId, text: body.text, markdown: body.markdown, parentId: body.parentId });
  }

  private control(method: string, path: string, raw: Buffer) {
    const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    if (method === 'POST' && path === '/_test/people') {
      return this.addPerson(body);
    }
    if (method === 'POST' && path === '/_test/rooms') {
      return this.addRoom(body);
    }
    if (method === 'POST' && path === '/_test/messages') {
      return this.postAs(body.as, body);
    }
    if (method === 'GET' && path === '/_test/state') {
      return {
        people: [...this.people.values()],
        rooms: [...this.rooms.values()],
        messages: [...this.messages.values()],
        deliveries: this.deliveries,
        devices: [...this.devices.values()],
        connections: this.connections().map(({ deviceId, ownerId }) => ({ deviceId, ownerId })),
      };
    }
    const room = path.match(/^\/_test\/rooms\/([^/]+)\/messages$/);
    if (method === 'GET' && room) {
      return { items: this.roomMessages(decodeURIComponent(room[1])) };
    }
    throw new ApiError(404, `no control route ${method} ${path}`);
  }

  /** The fake's URL as the client reached it (a Compose service name, not localhost). */
  private origin(request: IncomingMessage) {
    return request.headers.host ? `http://${request.headers.host}` : this.baseUrl;
  }

  private caller(request: IncomingMessage) {
    const token = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const person = [...this.people.values()].find((candidate) => candidate.token === token);
    if (!person) {
      throw new ApiError(401, 'The request requires a valid access token set in the Authorization request header.');
    }
    return person;
  }
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** A REST ID as Webex forms them: base64 of `ciscospark://us/<KIND>/<uuid>` (URL-safe here, for the fake's routes). */
function id(kind: string) {
  return Buffer.from(`ciscospark://us/${kind}/${randomUUID()}`).toString('base64url');
}

function uuidOf(restId: string) {
  return Buffer.from(restId, 'base64url').toString('utf8').split('/').pop() ?? '';
}

function now() {
  return new Date().toISOString();
}

function stripMarkdown(markdown: string) {
  return markdown
    .replace(/<@personId:[^|>]+\|([^>]+)>/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function publicPerson(person: FakePerson) {
  const { token: _token, ...rest } = person;
  return rest;
}

function publicDevice(device: FakeDevice) {
  const { id: _id, ownerId: _ownerId, ...rest } = device;
  return rest;
}

function publicWebhook(webhook: FakeWebhook) {
  const { secret: _secret, ownerId, ...rest } = webhook;
  return { ...rest, createdBy: ownerId, ownedBy: 'creator', status: 'active' };
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}
