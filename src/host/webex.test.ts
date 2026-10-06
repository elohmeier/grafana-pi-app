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
