import { decideDelivery, formatAlertMessage, type GrafanaWebhook, type GrafanaWebhookAlert } from './alerts';
import type { ChannelFile, ChannelMessage, ChatChannel, ThreadPost } from './channel';
import { formatEvidence, Responder, split, type Assistant, type ResponderOptions } from './responder';
import { alertPanels } from './screenshots';
import type { ChatRef } from './assistant';
import { Metrics } from './metrics';
import { HostStore } from './store';

function alert(fingerprint: string, status: 'firing' | 'resolved' = 'firing'): GrafanaWebhookAlert {
  return {
    status,
    labels: { alertname: 'High 5xx', instance: fingerprint, severity: 'critical' },
    annotations: { summary: 'Too many errors', __dashboardUid__: 'web', __panelId__: '2' },
    startsAt: '2026-10-03T09:18:00.123Z',
    fingerprint,
    generatorURL: 'http://grafana/alerting/grafana/rule-1/view',
    dashboardURL: 'http://grafana/d/web',
    silenceURL: 'http://grafana/alerting/silence/new',
    values: { A: 0.123456 },
  };
}

function notification(status: 'firing' | 'resolved', alerts: GrafanaWebhookAlert[]): GrafanaWebhook {
  return {
    status,
    groupKey: '{}:{alertname="High 5xx"}',
    groupLabels: { alertname: 'High 5xx' },
    commonLabels: { alertname: 'High 5xx' },
    commonAnnotations: { summary: 'Too many errors' },
    alerts,
  };
}

class FakeChannel implements ChatChannel {
  readonly name = 'fake';
  readonly maxMessageLength = 100;
  posts: Array<{ id: string; channelId: string; text: string; threadId?: string; files?: string[] }> = [];
  threadPosts: ThreadPost[] = [];
  async start() {}
  async stop() {}
  async resolveChannel(name: string) {
    return name;
  }
  async post(channelId: string, text: string, threadId?: string) {
    const id = `p${this.posts.length + 1}`;
    this.posts.push({ id, channelId, text, threadId });
    return { id };
  }
  async postFiles(channelId: string, text: string, files: ChannelFile[], threadId?: string) {
    const id = `p${this.posts.length + 1}`;
    this.posts.push({ id, channelId, text, threadId, files: files.map((file) => file.name) });
    return { id };
  }
  async update(postId: string, text: string) {
    this.posts.find((post) => post.id === postId)!.text = text;
  }
  async thread() {
    return this.threadPosts;
  }
}

function setup(
  answer: Assistant['ask'] = async () => ({ chatId: 'chat-1', text: 'The answer.', toolCalls: 1 }),
  options: Partial<ResponderOptions> = {}
) {
  const channel = new FakeChannel();
  const asks: Array<{ conversation: string; chat: ChatRef; text: string; resume?: boolean }> = [];
  const assistant: Assistant = {
    ask: (conversation, chat, text, onProgress, options) => {
      asks.push({ conversation, chat, text, ...(options?.resume ? { resume: true } : {}) });
      return answer(conversation, chat, text, onProgress, options);
    },
  };
  const store = new HostStore();
  const responder = new Responder({
    channel,
    assistant,
    store,
    alertChannelId: 'alerts',
    channelIds: ['ops'],
    allowDirect: true,
    ...options,
  });
  return { channel, asks, store, responder };
}

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channelId: 'ops',
    threadId: 'root',
    postId: 'root',
    userId: 'u1',
    userName: 'alice',
    text: 'why is checkout slow?',
    direct: false,
    mentioned: true,
    createdAt: 1000,
    ...overrides,
  };
}

async function settle() {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('alert delivery', () => {
  it('opens, updates on changed alerts, skips repeats, and resolves', () => {
    const firing = notification('firing', [alert('a')]);
    expect(decideDelivery(firing, undefined)).toEqual({ action: 'open' });
    const episode = {
      channelId: 'alerts',
      threadId: 't',
      status: 'firing' as const,
      fingerprints: ['a'],
      startedAt: 0,
      updatedAt: 0,
    };
    expect(decideDelivery(firing, episode)).toEqual({ action: 'skip' });
    expect(decideDelivery(notification('firing', [alert('a'), alert('b')]), episode).action).toBe('update');
    expect(decideDelivery(notification('resolved', [alert('a', 'resolved')]), episode).action).toBe('resolve');
    expect(decideDelivery(notification('resolved', [alert('a', 'resolved')]), undefined).action).toBe('skip');
    // A new firing period after a resolution is a new thread.
    expect(decideDelivery(firing, { ...episode, status: 'resolved' })).toEqual({ action: 'open' });
  });

  it('formats a message with labels, values, and links', () => {
    expect(formatAlertMessage(notification('firing', [alert('a')]), 'open')).toBe(
      [
        ':rotating_light: **High 5xx** — 1 firing',
        'Too many errors',
        '- instance=a, severity=critical — A=0.1235 since 2026-10-03 09:18:00Z · [dashboard](http://grafana/d/web) · [rule](http://grafana/alerting/grafana/rule-1/view) · [silence](http://grafana/alerting/silence/new)',
      ].join('\n')
    );
  });

  it('posts the notification before the analysis and answers in its thread', async () => {
    let finish!: () => void;
    const { channel, asks, responder } = setup(
      () =>
        new Promise((resolve) => (finish = () => resolve({ chatId: 'chat-1', text: 'Cause: deploy.', toolCalls: 3 })))
    );
    const result = await responder.handleAlert(notification('firing', [alert('a')]));
    expect(result).toEqual({ action: 'open', threadId: 'p1' });
    expect(channel.posts[0].text).toContain('High 5xx');
    await settle();
    expect(asks[0].text).toContain('"__dashboardUid__": "web"');
    finish();
    await settle();
    expect(channel.posts[1]).toEqual({ id: 'p2', channelId: 'alerts', threadId: 'p1', text: 'Cause: deploy.' });

    await responder.handleAlert(notification('resolved', [alert('a', 'resolved')]));
    expect(channel.posts[2]).toMatchObject({ threadId: 'p1', text: expect.stringContaining('Resolved: High 5xx') });
  });

  it('keeps the notification when the model fails', async () => {
    const { channel, responder } = setup(async () => {
      throw new Error('model server down');
    });
    await responder.handleAlert(notification('firing', [alert('a')]));
    await settle();
    expect(channel.posts.map((post) => post.text)).toEqual([
      expect.stringContaining('High 5xx'),
      ':warning: The assistant could not answer: model server down',
    ]);
  });
});

describe('messages', () => {
  it('answers mentions in allowed channels and direct messages only', async () => {
    const { asks, responder } = setup();
    await responder.handleMessage(message({ mentioned: false }));
    await responder.handleMessage(message({ channelId: 'random' }));
    expect(asks).toEqual([]);
    await responder.handleMessage(message({ channelId: 'dm', direct: true, mentioned: false }));
    await responder.handleMessage(message());
    expect(asks.map((ask) => ask.conversation)).toEqual(['fake:dm:root', 'fake:ops:root']);
  });

  it('continues the thread chat with posts since the last answer as context', async () => {
    const { channel, asks, store, responder } = setup();
    await store.setThread('fake:ops:root', { chatId: 'chat-1', chatStored: true, lastAnswerAt: 2000 });
    channel.threadPosts = [
      { userId: 'u1', userName: 'alice', text: 'root question', createdAt: 1000, fromBot: false },
      { userId: 'bot', userName: 'bot', text: 'an answer', createdAt: 2000, fromBot: true },
      { userId: 'u2', userName: 'bob', text: 'it started after the deploy', createdAt: 3000, fromBot: false },
    ];
    await responder.handleMessage(
      message({ postId: 'reply', userName: 'alice', text: 'check that deploy', createdAt: 4000 })
    );
    expect(asks[0]).toEqual({
      conversation: 'fake:ops:root',
      chat: { id: 'chat-1', stored: true },
      text: 'Earlier in the thread:\n- @bob: it started after the deploy\n\n@alice: check that deploy',
    });
  });

  it('splits long answers into several posts', async () => {
    const long = Array.from({ length: 6 }, (_, i) => `line ${i} ${'x'.repeat(10)}`).join('\n');
    const { channel, responder } = setup(async () => ({ chatId: 'c', text: long, toolCalls: 0 }));
    await responder.handleMessage(message());
    // The placeholder post holds the first part.
    const answer = channel.posts.map((post) => post.text);
    expect(answer.length).toBeGreaterThan(1);
    expect(answer.join('\n')).toBe(long);
    expect(split('abc', 50)).toEqual(['abc']);
  });

  it('posts presented evidence below the answer: images as files, tables as Markdown', async () => {
    const { channel, responder } = setup(async () => ({
      chatId: 'c',
      text: 'Errors rose after the deploy.',
      toolCalls: 2,
      evidence: [
        { view: 'image', title: '5xx rate', mimeType: 'image/png', data: Buffer.from('png').toString('base64') },
        { view: 'table', title: 'Top hosts', data: [{ host: 'vm-web-01', errors: 368 }] },
      ],
    }));
    await responder.handleMessage(message());
    expect(channel.posts.map(({ text, files }) => ({ text, files }))).toEqual([
      { text: 'Errors rose after the deploy.', files: undefined },
      { text: '**5xx rate**', files: ['5xx-rate.png'] },
      { text: '**Top hosts**\n\n| host | errors |\n| --- | --- |\n| vm-web-01 | 368 |', files: undefined },
    ]);
  });
});

describe('evidence and screenshots', () => {
  it('formats JSON and text as code blocks and escapes table cells', () => {
    expect(formatEvidence({ view: 'json', title: 'Rule', data: { for: '2m' } })).toBe(
      '**Rule**\n```json\n{\n  "for": "2m"\n}\n```'
    );
    expect(formatEvidence({ view: 'table', title: 'T', data: [{ a: 'x|y\nz' }] })).toContain('| x\\|y z |');
  });

  it('finds the panels firing alerts link to', () => {
    const linked = { ...alert('a'), annotations: { __dashboardUid__: 'web', __panelId__: '2' } };
    expect(
      alertPanels(notification('firing', [linked, { ...linked, fingerprint: 'b' }, alert('c', 'resolved')]))
    ).toEqual([{ dashboardUid: 'web', panelId: 2 }]);
  });

  it('posts alert panel screenshots in the new thread', async () => {
    const { channel, responder } = setup(undefined, {
      alertPanels: async () => [
        { title: 'Panel 2', file: { name: 'web-panel-2.png', mimeType: 'image/png', data: new Uint8Array([1]) } },
      ],
    });
    await responder.handleAlert(notification('firing', [alert('a')]));
    await settle();
    expect(channel.posts.find((post) => post.files)).toMatchObject({
      threadId: 'p1',
      text: '**Panel 2**',
      files: ['web-panel-2.png'],
    });
  });
});

describe('recovery and alert noise', () => {
  it('resumes a pending run into its placeholder post', async () => {
    const { channel, asks, store, responder } = setup();
    await store.setThread('fake:ops:root', {
      chatId: 'chat-9',
      chatStored: true,
      pending: { channelId: 'ops', threadId: 'root', postId: 'p1', prompt: 'why?', startedAt: 1 },
    });
    channel.posts.push({ id: 'p1', channelId: 'ops', threadId: 'root', text: 'Looking into it…' });
    await responder.recover();
    expect(asks).toEqual([
      { conversation: 'fake:ops:root', chat: { id: 'chat-9', stored: true }, text: 'why?', resume: true },
    ]);
    expect(channel.posts).toEqual([{ id: 'p1', channelId: 'ops', threadId: 'root', text: 'The answer.' }]);
    expect(store.thread('fake:ops:root')?.pending).toBeUndefined();
  });

  it('starts a new chat again when it was not stored before the host stopped', async () => {
    const { asks, store, responder } = setup(async (_conversation, chat, _text, _progress, options) => {
      if (options?.resume) {
        throw new Error('chat not found');
      }
      return { chatId: chat.id, text: 'ok', toolCalls: 0 };
    });
    await store.setThread('fake:ops:root', {
      chatId: 'new-chat',
      pending: { channelId: 'ops', threadId: 'root', postId: 'p1', prompt: 'why?', startedAt: 1 },
    });
    await responder.recover();
    expect(asks.map((ask) => [ask.chat, ask.resume ?? false])).toEqual([
      [{ id: 'new-chat', stored: true }, true],
      [{ id: 'new-chat', stored: false }, false],
    ]);
    expect(store.thread('fake:ops:root')).toMatchObject({ chatStored: true });
  });

  it('edits the last update while a group flaps and skips repeated analyses of a rule', async () => {
    const { channel, asks, responder } = setup();
    await responder.handleAlert(notification('firing', [alert('a')]));
    await responder.handleAlert(notification('firing', [alert('a'), alert('b')]));
    await responder.handleAlert(notification('firing', [alert('a')]));
    await responder.handleAlert(notification('firing', [alert('a'), alert('b'), alert('c')]));
    await settle();
    const updates = channel.posts.filter((post) => post.text.includes('Update: High 5xx'));
    expect(updates).toHaveLength(1);
    expect(updates[0].text).toContain('3 firing');
    expect(updates[0].text).toMatch(/updated \d\d:\d\d UTC/);

    await responder.handleAlert(notification('resolved', [alert('a', 'resolved')]));
    await responder.handleAlert(notification('firing', [alert('a')]));
    await settle();
    expect(asks).toHaveLength(1);
    expect(channel.posts.at(-1)?.text).toContain('Not investigated automatically');
  });
});

describe('continuing in Grafana', () => {
  it('links answers to a shared copy of the chat, once shared per thread', async () => {
    let staged = 0;
    const shares: string[] = [];
    const { channel, responder } = setup(
      async (_conversation, chat) => ({ chatId: chat.id, text: 'Done.', toolCalls: 1, stagedChanges: staged }),
      { sharedChatUrl: (token) => `http://grafana/a/app/chat?share=${token}` }
    );
    (responder as unknown as { options: { assistant: Assistant } }).options.assistant.share = async (chatId) => {
      shares.push(chatId);
      return 'tok';
    };
    await responder.handleMessage(message());
    expect(channel.posts[0].text).toBe('Done.\n\n[Continue in Grafana](http://grafana/a/app/chat?share=tok)');
    staged = 2;
    await responder.handleMessage(message({ postId: 'reply', createdAt: 5000 }));
    // The fake channel splits posts at 100 characters.
    expect(
      channel.posts
        .slice(-2)
        .map((post) => post.text)
        .join('')
    ).toBe(
      'Done.\n\n:pencil2: [Review and apply the 2 staged changes in Grafana](http://grafana/a/app/chat?share=tok)'
    );
    expect(shares).toHaveLength(1);
  });
});

describe('operations', () => {
  it('stops the running answer of a thread on "stop"', async () => {
    const stopped: string[] = [];
    const { channel, asks, responder } = setup();
    (responder as unknown as { options: { assistant: Assistant } }).options.assistant.stop = (conversation) => {
      stopped.push(conversation);
      return conversation === 'fake:ops:busy';
    };
    await responder.handleMessage(message({ threadId: 'busy', postId: 'p', text: 'stop' }));
    await responder.handleMessage(message({ threadId: 'idle', postId: 'q', text: 'Stop!' }));
    expect(stopped).toEqual(['fake:ops:busy', 'fake:ops:idle']);
    expect(asks).toEqual([]);
    expect(channel.posts.map((post) => post.text)).toEqual(['Nothing is running in this thread.']);
  });

  it('counts notifications and runs', async () => {
    const metrics = new Metrics();
    metrics.gauge('assistant_host_runs_waiting', 'Waiting runs.', () => 3);
    const { responder } = setup(undefined, { metrics });
    await responder.handleAlert(notification('firing', [alert('a')]));
    await responder.handleAlert(notification('firing', [alert('a')]));
    await settle();
    expect(metrics.render()).toContain('assistant_host_alert_notifications_total{action="open"} 1');
    expect(metrics.render()).toContain('assistant_host_alert_notifications_total{action="skip"} 1');
    expect(metrics.render()).toContain('assistant_host_runs_total{outcome="answered"} 1');
    expect(metrics.render()).toContain('assistant_host_runs_waiting 3');
  });
});
