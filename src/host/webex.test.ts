/**
 * @jest-environment node
 */
import { createServer, type Server } from 'node:http';
import type { ChannelMessage } from './channel';
import { Responder } from './responder';
import { HostStore } from './store';
import { WebexFake } from './testing/webexFake';
import { WebexChannel } from './webex';

/** The adapter against the in-memory Webex API, with webhooks delivered over HTTP. */
async function setup() {
  const fake = await new WebexFake().listen();
  const bot = fake.addPerson({ email: 'assistant@webex.bot', displayName: 'Grafana Assistant', bot: true });
  const alice = fake.addPerson({ email: 'alice@example.com', displayName: 'Alice Doe' });
  const room = fake.addRoom({ title: 'Ops Alerts', members: [bot.id, alice.id] });
  const direct = fake.addRoom({ title: 'Alice Doe', type: 'direct', members: [bot.id, alice.id] });
  let channel!: WebexChannel;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const header = request.headers['x-spark-signature'];
    response.writeHead(
      await channel.handleWebhook(Buffer.concat(chunks), typeof header === 'string' ? header : undefined)
    );
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  channel = new WebexChannel({
    url: `${fake.baseUrl}/v1`,
    token: bot.token,
    webhookUrl: `http://127.0.0.1:${port}/webex/webhook`,
  });
  const received: ChannelMessage[] = [];
  await channel.start((message) => received.push(message));
  const close = async () => {
    await fake.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { fake, bot, alice, room, direct, channel, received, close, port };
}

describe('Webex adapter', () => {
  it('registers one webhook and receives mentions and direct messages, not other group messages', async () => {
    const { fake, alice, bot, room, direct, channel, received, close } = await setup();
    try {
      // A restart replaces the webhook instead of adding one.
      await channel.start(() => undefined);
      await channel.start((message) => received.push(message));
      fake.postAs(alice.id, { roomId: room.id, text: 'who is on call?' });
      const mention = fake.postAs(alice.id, { roomId: room.id, text: 'why is checkout slow?', mentions: [bot.id] });
      const dm = fake.postAs(alice.id, { roomId: direct.id, text: 'hello' });
      await fake.settled();
      // Deliveries are concurrent HTTP calls; their order is not fixed.
      expect(received).toHaveLength(2);
      expect(received).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channelId: room.id,
            threadId: mention.id,
            postId: mention.id,
            userName: 'Alice Doe',
            text: 'why is checkout slow?',
            direct: false,
            mentioned: true,
          }),
          expect.objectContaining({
            channelId: direct.id,
            threadId: dm.id,
            text: 'hello',
            direct: true,
            mentioned: false,
          }),
        ])
      );
      expect(fake.deliveries.filter((delivery) => delivery.status === 200)).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it('refuses webhook calls without a valid signature', async () => {
    const { channel, close, port } = await setup();
    try {
      expect(await channel.handleWebhook(Buffer.from('{}'), undefined)).toBe(401);
      const response = await fetch(`http://127.0.0.1:${port}/webex/webhook`, {
        method: 'POST',
        headers: { 'X-Spark-Signature': '0'.repeat(40) },
        body: '{"resource":"messages","event":"created","data":{"id":"x"}}',
      });
      expect(response.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('posts, edits, and reads threads, and uploads one file per message', async () => {
    const { fake, alice, bot, room, channel, received, close } = await setup();
    try {
      const root = fake.postAs(alice.id, { roomId: room.id, text: 'disk full?', mentions: [bot.id] });
      const placeholder = await channel.post(room.id, '⏳ Looking into it…', root.id);
      await channel.update(placeholder.id, '**/var** is at 97%.');
      const reply = fake.postAs(alice.id, {
        roomId: room.id,
        text: 'which host?',
        mentions: [bot.id],
        parentId: root.id,
      });
      await fake.settled();
      expect(received.at(-1)).toMatchObject({ threadId: root.id, postId: reply.id, text: 'which host?' });
      const thread = await channel.thread(room.id, root.id);
      expect(thread.map((post) => [post.userName, post.text, post.fromBot])).toEqual([
        ['Alice Doe', 'Grafana Assistant disk full?', false],
        ['Grafana Assistant', '/var is at 97%.', true],
        ['Alice Doe', 'Grafana Assistant which host?', false],
      ]);
      await channel.postFiles(
        room.id,
        '**Panels**',
        [
          { name: 'a.png', mimeType: 'image/png', data: new Uint8Array([1, 2]) },
          { name: 'b.png', mimeType: 'image/png', data: new Uint8Array([3]) },
        ],
        root.id
      );
      // Direct messages go to the direct room with the person.
      await channel.postDirect(alice.id, 'Your link code');
      const direct = [...fake.rooms.values()].find((candidate) => candidate.type === 'direct');
      expect(fake.roomMessages(direct!.id).at(-1)?.markdown).toBe('Your link code');
      const uploads = fake.roomMessages(room.id).filter((message) => message.files);
      expect(
        uploads.map((message) => [message.parentId, message.markdown, fake.file(message.files![0])?.name])
      ).toEqual([
        [root.id, '**Panels**', 'a.png'],
        [root.id, undefined, 'b.png'],
      ]);
    } finally {
      await close();
    }
  });

  it('answers a mention in its thread through the responder', async () => {
    const { fake, alice, bot, room, channel, close } = await setup();
    try {
      const store = new HostStore();
      const responder = new Responder({
        channel,
        store,
        channelIds: [room.id],
        allowDirect: true,
        assistant: {
          ask: async (_conversation, chat, text) => ({
            chatId: chat.id,
            text: `Answer to: ${text}`,
            toolCalls: 0,
            evidence: [{ view: 'table', title: 'Hosts', data: [{ host: 'vm-web-01', errors: 368 }] }],
          }),
        },
      });
      const done: Array<Promise<void>> = [];
      await channel.start((message) => done.push(responder.handleMessage(message)));
      const root = fake.postAs(alice.id, { roomId: room.id, text: 'errors on web?', mentions: [bot.id] });
      await fake.settled();
      await Promise.all(done);
      const replies = fake.roomMessages(room.id).filter((message) => message.parentId === root.id);
      expect(replies.map((message) => message.markdown)).toEqual([
        'Answer to: @Alice Doe: errors on web?',
        '**Hosts**\n```\nhost       errors\nvm-web-01  368\n```',
      ]);
      expect(replies[0].updated).toBeDefined();
    } finally {
      await close();
    }
  });

  it('answers long runs within the edit limit and long answers within the byte limit', async () => {
    const { fake, alice, bot, room, channel, close } = await setup();
    // German text is about 1.1 bytes per character, and emoji 2 characters for 4 bytes.
    const answer = Array.from({ length: 400 }, (_, i) => `Zeile ${i}: Größe überschritten 🔥`).join('\n');
    try {
      const responder = new Responder({
        channel,
        store: new HostStore(),
        channelIds: [room.id],
        allowDirect: true,
        progressIntervalMs: 0,
        assistant: {
          ask: async (_conversation, chat, _text, onProgress) => {
            for (let step = 1; step <= 30; step++) {
              onProgress?.({ toolCalls: step });
            }
            return { chatId: chat.id, text: answer, toolCalls: 30 };
          },
        },
      });
      const done: Array<Promise<void>> = [];
      await channel.start((message) => done.push(responder.handleMessage(message)));
      const root = fake.postAs(alice.id, { roomId: room.id, text: 'disk?', mentions: [bot.id] });
      await fake.settled();
      await Promise.all(done);
      const replies = fake.roomMessages(room.id).filter((message) => message.parentId === root.id);
      expect(replies.length).toBeGreaterThan(1);
      expect(replies.map((message) => message.markdown).join('\n')).toBe(answer);
    } finally {
      await close();
    }
  });
});

/** The adapter in websocket mode: no webhook URL, messages over the fake's Mercury websocket. */
async function setupSocket(options: { pingIntervalMs?: number; pongTimeoutMs?: number } = {}) {
  const fake = await new WebexFake().listen();
  const bot = fake.addPerson({ email: 'assistant@webex.bot', displayName: 'Grafana Assistant', bot: true });
  const alice = fake.addPerson({ email: 'alice@example.com', displayName: 'Alice Doe' });
  const room = fake.addRoom({ title: 'Ops Alerts', members: [bot.id, alice.id] });
  const direct = fake.addRoom({ title: 'Alice Doe', type: 'direct', members: [bot.id, alice.id] });
  const logs: string[] = [];
  const create = () =>
    new WebexChannel({
      url: `${fake.baseUrl}/v1`,
      token: bot.token,
      catalogUrl: `${fake.baseUrl}/u2c/api/v1/catalog`,
      reconnectDelayMs: 20,
      ...options,
      log: (message) => logs.push(message),
    });
  const channel = create();
  const received: ChannelMessage[] = [];
  await channel.start((message) => received.push(message));
  const close = async () => {
    await channel.stop();
    await fake.close();
  };
  return { fake, bot, alice, room, direct, channel, received, logs, create, close };
}

async function until(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Webex adapter over the websocket', () => {
  it('receives messages from others, not its own posts and edits, and acknowledges every event', async () => {
    const { fake, alice, bot, room, direct, channel, received, close } = await setupSocket();
    try {
      expect(fake.connections(bot.id)).toHaveLength(1);
      const mention = fake.postAs(alice.id, { roomId: room.id, text: 'why is checkout slow?', mentions: [bot.id] });
      const dm = fake.postAs(alice.id, { roomId: direct.id, text: 'hello' });
      const other = fake.postAs(alice.id, { roomId: room.id, text: 'who is on call?' });
      const own = await channel.post(room.id, '⏳ Looking into it…', mention.id);
      await channel.update(own.id, 'Done.');
      await until(() => received.length === 3);
      // Unmentioned group messages reach the responder, which ignores them, as with Mattermost.
      expect(received).toEqual([
        expect.objectContaining({
          channelId: room.id,
          threadId: mention.id,
          postId: mention.id,
          userName: 'Alice Doe',
          text: 'why is checkout slow?',
          mentioned: true,
          direct: false,
        }),
        expect.objectContaining({ channelId: direct.id, postId: dm.id, text: 'hello', direct: true }),
        expect.objectContaining({ postId: other.id, text: 'who is on call?', mentioned: false }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toHaveLength(3);
      // Authorization confirmation, 3 posts by Alice, the bot's post, and its edit.
      expect(fake.acks.length).toBeGreaterThanOrEqual(6);
    } finally {
      await close();
    }
  });

  it('reuses its device, replaces an earlier webhook, and refuses webhook calls', async () => {
    const { fake, bot, create, channel, close } = await setupSocket();
    try {
      // A host that ran in webhook mode before left a webhook behind.
      const legacy = new WebexChannel({
        url: `${fake.baseUrl}/v1`,
        token: bot.token,
        webhookUrl: 'http://127.0.0.1:9/webex/webhook',
      });
      await legacy.start(() => undefined);
      const restarted = create();
      await restarted.start(() => undefined);
      const state = await (await fetch(`${fake.baseUrl}/_test/state`)).json();
      expect(state.devices).toHaveLength(1);
      // The new connection of the device replaced the earlier one.
      await until(() => fake.connections(bot.id).length === 1);
      const hooks = await fetch(`${fake.baseUrl}/v1/webhooks`, { headers: { Authorization: `Bearer ${bot.token}` } });
      expect((await hooks.json()).items).toEqual([]);
      expect(await channel.handleWebhook(Buffer.from('{}'), undefined)).toBe(404);
      await restarted.stop();
    } finally {
      await close();
    }
  });

  it('reconnects after a lost connection and registers again when its device is refused', async () => {
    const { fake, alice, bot, direct, received, logs, close } = await setupSocket();
    try {
      fake.dropSockets();
      await until(
        () => fake.connections(bot.id).length === 1 && logs.filter((line) => /connected/.test(line)).length === 2
      );
      fake.postAs(alice.id, { roomId: direct.id, text: 'after reconnect' });
      await until(() => received.some((message) => message.text === 'after reconnect'));
      // Webex forgot the device: its socket is refused, and a new device is registered.
      const [device] = fake.devices.values();
      fake.devices.delete(device.id);
      fake.dropSockets();
      await until(() => fake.devices.size === 1 && fake.connections(bot.id).length === 1);
      expect([...fake.devices.values()][0].id).not.toBe(device.id);
      fake.postAs(alice.id, { roomId: direct.id, text: 'new device' });
      await until(() => received.some((message) => message.text === 'new device'));
    } finally {
      await close();
    }
  });

  it('closes and reconnects a connection that stops answering pings', async () => {
    const { fake, bot, logs, close } = await setupSocket({ pingIntervalMs: 20, pongTimeoutMs: 50 });
    try {
      fake.answerPings = false;
      await until(() => logs.some((line) => line.includes('pong not received')));
      fake.answerPings = true;
      await until(
        () => fake.connections(bot.id).length === 1 && logs.filter((line) => /connected/.test(line)).length >= 2
      );
    } finally {
      await close();
    }
  });

  it('answers a mention in its thread through the responder', async () => {
    const { fake, alice, bot, room, channel, close } = await setupSocket();
    try {
      const responder = new Responder({
        channel,
        store: new HostStore(),
        channelIds: [room.id],
        allowDirect: true,
        assistant: {
          ask: async (_conversation, chat, text) => ({ chatId: chat.id, text: `Answer to: ${text}`, toolCalls: 0 }),
        },
      });
      const done: Array<Promise<void>> = [];
      await channel.stop();
      await channel.start((message) => done.push(responder.handleMessage(message)));
      const root = fake.postAs(alice.id, { roomId: room.id, text: 'errors on web?', mentions: [bot.id] });
      fake.postAs(alice.id, { roomId: room.id, text: 'unrelated chatter' });
      await until(() => done.length === 2);
      await Promise.all(done);
      const replies = fake.roomMessages(room.id).filter((message) => message.parentId === root.id);
      expect(replies.map((message) => message.markdown)).toEqual(['Answer to: @Alice Doe: errors on web?']);
    } finally {
      await close();
    }
  });
});
