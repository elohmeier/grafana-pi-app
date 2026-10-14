/**
 * @jest-environment node
 */
import type { ChannelMessage } from './channel';
import { Responder } from './responder';
import { HostStore } from './store';
import { WebexFake } from './testing/webexFake';
import { WebexChannel } from './webex';

/** The adapter against the in-memory Webex API, messages over the fake's Mercury websocket. */
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

describe('Webex adapter', () => {
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
      // Messages are fetched concurrently, so delivery order can differ from posting order.
      expect(received).toEqual(
        expect.arrayContaining([
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
        ])
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toHaveLength(3);
      // Authorization confirmation, 3 posts by Alice, the bot's post, and its edit.
      expect(fake.acks.length).toBeGreaterThanOrEqual(6);
    } finally {
      await close();
    }
  });

  it('reuses its device across restarts, and a new connection replaces the earlier one', async () => {
    const { fake, bot, create, close } = await setupSocket();
    try {
      const restarted = create();
      await restarted.start(() => undefined);
      expect(fake.devices.size).toBe(1);
      await until(() => fake.connections(bot.id).length === 1);
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

  it('posts, edits, and reads threads, and uploads one file per message', async () => {
    const { fake, alice, bot, room, channel, received, close } = await setupSocket();
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
      await until(() => received.some((message) => message.postId === reply.id));
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

  it('answers a mention with presented evidence through the responder', async () => {
    const { fake, alice, bot, room, channel, close } = await setupSocket();
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
      await channel.stop();
      await channel.start((message) => done.push(responder.handleMessage(message)));
      const root = fake.postAs(alice.id, { roomId: room.id, text: 'errors on web?', mentions: [bot.id] });
      await until(() => done.length === 1);
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
    const { fake, alice, bot, room, channel, close } = await setupSocket();
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
      await channel.stop();
      await channel.start((message) => done.push(responder.handleMessage(message)));
      const root = fake.postAs(alice.id, { roomId: room.id, text: 'disk?', mentions: [bot.id] });
      await until(() => done.length === 1);
      await Promise.all(done);
      const replies = fake.roomMessages(room.id).filter((message) => message.parentId === root.id);
      expect(replies.length).toBeGreaterThan(1);
      expect(replies.map((message) => message.markdown).join('\n')).toBe(answer);
    } finally {
      await close();
    }
  });
});

describe('Webex rooms for alert channels', () => {
  it("lists the bot's group rooms and resolves rooms by ID or title, refusing rooms it is not in", async () => {
    const { fake, alice, room, channel, close } = await setupSocket();
    try {
      const outside = fake.addRoom({ title: 'Finance', members: [alice.id] });
      expect(channel.botName).toBe('Grafana Assistant');
      expect(await channel.listChannels()).toEqual([{ id: room.id, name: 'Ops Alerts', title: 'Ops Alerts' }]);
      expect(await channel.resolveChannel(room.id)).toBe(room.id);
      expect(await channel.resolveChannel('Ops Alerts')).toBe(room.id);
      await expect(channel.resolveChannel(outside.id)).rejects.toThrow('not a member of room');
      await expect(channel.resolveChannel('Finance')).rejects.toThrow('not found among');
    } finally {
      await close();
    }
  });
});
