import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * An in-memory Webex API for tests of the assistant host's Webex adapter: the
 * subset the adapter uses (people, rooms, messages with threads, edits, file
 * uploads, webhooks with X-Spark-Signature) plus a control API under /_test.
 *
 * Behavior follows the Webex REST API as documented: webhook payloads carry
 * the message ID but not its text, bots receive group room messages only when
 * mentioned, a reply's parentId must be a thread root, a message holds at most
 * one uploaded file and 7439 bytes of text.
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
export type Delivery = { webhookId: string; targetUrl: string; status: number | 'error'; body: string };

const MAX_TEXT_BYTES = 7439;
const ID_PREFIX = 'Y2lzY29zcGFyazovL3VzL';

export class WebexFake {
  readonly people = new Map<string, FakePerson>();
  readonly rooms = new Map<string, FakeRoom>();
  readonly messages = new Map<string, FakeMessage>();
  readonly deliveries: Delivery[] = [];
  private webhooks = new Map<string, FakeWebhook>();
  private files = new Map<string, FakeFile>();
  private server?: Server;
  private pending = new Set<Promise<unknown>>();
  baseUrl = '';

  async listen(port = 0, host = '127.0.0.1') {
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        send(response, 500, { message: error instanceof Error ? error.message : String(error) });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const address = this.server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    this.baseUrl = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`;
    return this;
  }

  async close() {
    await this.settled();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
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
          message.markdown = body.markdown;
          message.text = body.text ?? stripMarkdown(body.markdown ?? '');
          message.updated = now();
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
      };
    }
    const room = path.match(/^\/_test\/rooms\/([^/]+)\/messages$/);
    if (method === 'GET' && room) {
      return { items: this.roomMessages(decodeURIComponent(room[1])) };
    }
    throw new ApiError(404, `no control route ${method} ${path}`);
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

function id(kind: string) {
  return `${ID_PREFIX}${Buffer.from(`${kind}/${randomUUID()}`).toString('base64url')}`;
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
