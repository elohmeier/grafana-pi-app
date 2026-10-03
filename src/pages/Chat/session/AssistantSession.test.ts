import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type JsonObject,
  type ToolResultMessage,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import type { ChatAgentEvent } from '../agentEvents';
import type { ChatMessage } from '../chatMessages';
import { FakeChatLog } from '../durable/fakeChatLog';
import type { AssistantStreamFn } from '../durable/models';
import { GRAFANA_SKILLS } from '../skills/catalog';
import type { GrafanaSkill } from '../skills/types';
import { createFakeDashboardBroker } from '../workspace/testUtils';
import { AssistantSession, type SessionHost } from './AssistantSession';

// AssistantSession on a Pi Durable harness over the fake chat log backend,
// with a scripted model: runs, tools, persistence, reopening, takeover, and compaction.

type Block =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string }
  | { type: 'toolCall'; id: string; name: string; arguments: JsonObject };

type Reply = {
  blocks: Block[];
  /** The stream stops after its first delta and only ends when the request is aborted. */
  hangAfterFirstDelta?: boolean;
};

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** The harness's summarizer request leads with a system message that has content; prompt changes have none. */
function isSummaryRequest(context: TranscriptContext) {
  const first = context.messages[0];
  return first?.role === 'system' && typeof first.content === 'string' && first.content.length > 0;
}

/** A model that streams each scripted reply block by block. Summarizer requests get `summary`. */
function scriptedModel(replies: Reply[], summary = '- summary') {
  const requests: TranscriptContext[] = [];
  const summaries: TranscriptContext[] = [];
  const streamFn: AssistantStreamFn = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const isSummary = isSummaryRequest(context);
    (isSummary ? summaries : requests).push(clone(context));
    const reply: Reply = isSummary
      ? { blocks: [{ type: 'text', text: summary }] }
      : (replies.shift() ?? { blocks: [] });
    const partial: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage,
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    const push = (event: Record<string, unknown>) => stream.push({ ...event, partial } as never);
    void (async () => {
      await Promise.resolve();
      push({ type: 'start' });
      for (const [index, block] of reply.blocks.entries()) {
        if (block.type === 'text' || block.type === 'thinking') {
          const key = block.type === 'text' ? 'text' : 'thinking';
          const value = block.type === 'text' ? block.text : block.thinking;
          partial.content[index] = { type: block.type, [key]: '' } as never;
          push({ type: `${block.type}_start`, contentIndex: index });
          for (const delta of [value.slice(0, 3), value.slice(3)].filter(Boolean)) {
            (partial.content[index] as unknown as Record<string, string>)[key] += delta;
            push({ type: `${block.type}_delta`, contentIndex: index, delta });
            if (reply.hangAfterFirstDelta) {
              await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) {
                  resolve();
                }
                options?.signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              partial.stopReason = 'aborted';
              partial.errorMessage = 'Request aborted by user';
              stream.push({ type: 'error', reason: 'aborted', error: partial });
              stream.end(partial);
              return;
            }
          }
          push({ type: `${block.type}_end`, contentIndex: index, content: value });
        } else {
          partial.content[index] = { ...block };
          push({ type: 'toolcall_start', contentIndex: index });
          push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(block.arguments) });
          push({ type: 'toolcall_end', contentIndex: index, toolCall: partial.content[index] });
        }
      }
      partial.stopReason = reply.blocks.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop';
      stream.push({ type: 'done', reason: partial.stopReason as 'stop' | 'toolUse', message: partial });
      stream.end(partial);
    })();
    return stream;
  };
  return { streamFn, requests, summaries };
}

function createHost(
  streamFn: AssistantStreamFn,
  options: {
    backend?: FakeChatLog;
    contextWindow?: number;
    hangDashboardReads?: boolean;
    skills?: GrafanaSkill[];
  } = {}
) {
  const backend = options.backend ?? new FakeChatLog();
  const contextWindow = options.contextWindow ?? 100000;
  const { broker } = createFakeDashboardBroker([{ uid: 'one', title: 'One' }]);
  if (options.hangDashboardReads) {
    // A dashboard fetch that only ends when the request is canceled.
    broker.dashboards!.get = (_uid, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
  }
  const jsonData = { models: [{ id: 'test', default: true, contextWindow, maxOutputTokens: 1000 }] };
  const stored: string[] = [];
  const host: SessionHost = {
    environment: (session) => ({
      jsonData,
      streamFn,
      model: {
        id: session.getState().modelId ?? 'test',
        api: 'openai-completions',
        provider: 'grafana',
        contextWindow,
        maxTokens: 1000,
      } as never,
      thinkingLevel: 'off',
      broker,
      skills: options.skills ?? [],
    }),
    chatLog: backend,
    onStored: (summary) => stored.push(summary.title),
  };
  return { host, backend, stored };
}

async function run(session: AssistantSession, prompt: string) {
  await session.prompt(prompt);
  await session.idle();
}

function roles(messages: ReadonlyArray<{ role: string }>) {
  return messages.map((message) => message.role);
}

async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('condition not met');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sessions: AssistantSession[] = [];
function track(session: AssistantSession) {
  sessions.push(session);
  return session;
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

it('keeps catalog caches, artifacts, and pending approvals across toolkit changes', async () => {
  const session = new AssistantSession();
  const { broker, calls } = createFakeDashboardBroker([{ uid: 'one', title: 'One' }]);
  const options = { workspace: session.workspace, broker, artifacts: session.artifacts };
  const first = session.toolkit({ ...options, context: { route: '/first' } });
  expect((await first.runShell('cat /grafana/catalog/dashboards.ndjson')).exitCode).toBe(0);
  const second = session.toolkit({ ...options, context: { route: '/second' } });
  expect((await second.runShell('cat /grafana/catalog/dashboards.ndjson')).exitCode).toBe(0);
  expect(calls.filter((call) => call.startsWith('search:'))).toHaveLength(1);
  expect(JSON.parse((await second.runShell('cat /session/context.json')).stdout)).toEqual({ route: '/second' });
  expect((await second.runShell('echo forged > /session/context.json')).exitCode).not.toBe(0);

  const request = {
    applyId: 'apply-1',
    digest: 'digest',
    title: 'Save',
    summary: 'One',
    operations: [],
    groups: [],
    ungroupedChanges: 0,
  };
  const pending = session.approvals.request(request);
  expect(session.approvals.getSnapshot()).toBe(request);
  session.approvals.settle(true, ['/grafana/dashboards/a/dashboard.json']);
  await expect(pending).resolves.toEqual({
    approved: true,
    reason: undefined,
    paths: ['/grafana/dashboards/a/dashboard.json'],
  });
  expect(session.approvals.getSnapshot()).toBeUndefined();
});

it('does not retain an approval after cancellation', async () => {
  const session = new AssistantSession();
  const controller = new AbortController();
  const pending = session.approvals.request(
    { applyId: 'apply-1', digest: '', title: '', summary: '', operations: [], groups: [], ungroupedChanges: 0 },
    controller.signal
  );
  controller.abort();
  await expect(pending).resolves.toMatchObject({ approved: false });
  expect(session.approvals.getSnapshot()).toBeUndefined();
});

it('does not store a new chat before its first prompt', async () => {
  const { host, backend } = createHost(scriptedModel([]).streamFn);
  const session = track(new AssistantSession());
  session.attach(host);
  expect(session.started).toBe(false);
  expect(backend.chats.size).toBe(0);
});

it('keeps the skills of earlier prompts active in follow-up turns', async () => {
  const { streamFn } = scriptedModel([
    { blocks: [{ type: 'text', text: 'Done.' }] },
    { blocks: [{ type: 'text', text: 'Done.' }] },
  ]);
  const { host } = createHost(streamFn, { skills: [...GRAFANA_SKILLS] });
  const activeSkills: string[][] = [];
  host.onPromptStart = (start) => activeSkills.push(start.activeSkills.map((skill) => skill.name));
  const session = track(new AssistantSession());
  session.attach(host);

  await run(session, 'Create a dashboard for HTTP request rate for all team-* namespaces');
  await run(session, 'Trenne 4xx und 5xx Fehler und filtere nach Environment');

  expect(activeSkills).toEqual([['grafana-dashboard'], ['grafana-dashboard']]);
});

it('streams an answer and sends the prompt as positional system sections with the fixed tools', async () => {
  const { streamFn, requests } = scriptedModel([
    {
      blocks: [
        { type: 'thinking', thinking: 'Look at the request.' },
        { type: 'text', text: 'Hello there.' },
      ],
    },
  ]);
  const { host, backend, stored } = createHost(streamFn);
  const session = track(new AssistantSession());
  session.attach(host);
  const events: ChatAgentEvent[] = [];
  session.subscribe((event) => events.push(event));

  await run(session, 'Why is   the error rate high?');

  expect(session.title).toBe('Why is the error rate high?');
  expect(backend.chats.get(session.id)?.title).toBe('Why is the error rate high?');
  expect(stored).toContain('Why is the error rate high?');
  const answer = session.messages.at(-1) as AssistantMessage;
  expect(answer.stopReason).toBe('stop');
  expect(answer.content).toEqual([
    { type: 'thinking', thinking: 'Look at the request.' },
    { type: 'text', text: 'Hello there.' },
  ]);
  expect(roles(session.messages)).toEqual(['user', 'assistant']);
  expect(session.getState().transcript.runStatus).toBeUndefined();
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining(['agent_start', 'message_end', 'agent_end'])
  );

  const request = requests[0];
  expect(getCurrentSystemPrompt(request.messages)).toContain('/workspace');
  expect(
    getCurrentTools(request.messages)
      .map((tool) => tool.name)
      .sort()
  ).toEqual(['bash', 'edit', 'read', 'write']);
});

it('runs a tool call, stores its workspace changes, and restores them when the chat is reopened', async () => {
  const { streamFn, requests } = scriptedModel([
    {
      blocks: [
        { type: 'text', text: 'Writing a file.' },
        {
          type: 'toolCall',
          id: 'call_1',
          name: 'bash',
          arguments: { command: 'echo hello > /workspace/a.txt; cat /workspace/a.txt' },
        },
      ],
    },
    { blocks: [{ type: 'text', text: 'Done.' }] },
  ]);
  const { host, backend } = createHost(streamFn);
  const session = track(new AssistantSession());
  session.attach(host);

  await run(session, 'write a file');
  expect(roles(session.messages)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
  const result = session.messages[2] as ToolResultMessage;
  expect(result).toMatchObject({ toolCallId: 'call_1', toolName: 'bash', isError: false });
  expect(JSON.stringify(result.content)).toContain('hello');
  expect(session.workspace.getScratchFile('/workspace/a.txt')?.content).toBe('hello\n');
  const sent = requests[1].messages.find((message) => message.role === 'toolResult') as ToolResultMessage;
  expect(sent.toolCallId).toBe('call_1');
  await session.close();

  const reopened = track(new AssistantSession({ id: session.id, stored: true }));
  reopened.attach(createHost(scriptedModel([]).streamFn, { backend }).host);
  await reopened.open();
  expect(reopened.title).toBe('write a file');
  expect(roles(reopened.messages)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
  expect(reopened.workspace.getScratchFile('/workspace/a.txt')?.content).toBe('hello\n');
});

it('stops a streaming reply on abort and keeps the chat usable', async () => {
  const { streamFn, requests } = scriptedModel([
    { blocks: [{ type: 'text', text: 'Partial answer' }], hangAfterFirstDelta: true },
    { blocks: [{ type: 'text', text: 'Second answer.' }] },
  ]);
  const { host } = createHost(streamFn);
  const session = track(new AssistantSession());
  session.attach(host);

  await session.prompt('first');
  await waitFor(() => Boolean(session.getState().transcript.streamingMessage));
  session.abort();
  await session.idle();

  expect(session.isStreaming).toBe(false);
  expect((session.messages.at(-1) as AssistantMessage).stopReason).toBe('aborted');

  await run(session, 'second');
  expect((session.messages.at(-1) as AssistantMessage).content).toEqual([{ type: 'text', text: 'Second answer.' }]);
  // The aborted reply is not sent to the model again.
  expect(JSON.stringify(requests[1].messages)).not.toContain('Partial answer');
});

it('cancels a running tool call on abort and discards its changes', async () => {
  const { streamFn } = scriptedModel([
    {
      blocks: [
        {
          type: 'toolCall',
          id: 'call_wait',
          name: 'bash',
          arguments: { command: 'echo started > /workspace/partial.txt; cat /grafana/dashboards/one/dashboard.json' },
        },
      ],
    },
  ]);
  const { host } = createHost(streamFn, { hangDashboardReads: true });
  const session = track(new AssistantSession());
  session.attach(host);

  await session.prompt('wait');
  await waitFor(() => Object.values(session.getState().transcript.toolRuns).some((run) => run.status === 'running'));
  session.abort();
  await session.idle();

  const result = session.messages.find((message) => message.role === 'toolResult') as ToolResultMessage;
  expect(result.toolCallId).toBe('call_wait');
  expect(result.isError).toBe(true);
  expect(session.workspace.getScratchFile('/workspace/partial.txt')).toBeUndefined();
});

it('continues an answer that a closed view interrupted when the chat is opened again', async () => {
  const first = scriptedModel([{ blocks: [{ type: 'text', text: 'Partial answer' }], hangAfterFirstDelta: true }]);
  const { host, backend } = createHost(first.streamFn);
  const session = track(new AssistantSession());
  session.attach(host);
  await session.prompt('explain the error rate');
  await waitFor(() => Boolean(session.getState().transcript.streamingMessage));
  // The tab goes away mid-answer: nothing is aborted.
  await session.close();

  const second = scriptedModel([{ blocks: [{ type: 'text', text: 'Full answer.' }] }]);
  const reopened = track(new AssistantSession({ id: session.id, stored: true }));
  reopened.attach(createHost(second.streamFn, { backend }).host);
  await reopened.open();
  await reopened.idle();

  expect(second.requests).toHaveLength(1);
  expect(JSON.stringify(second.requests[0].messages)).toContain('explain the error rate');
  expect((reopened.messages.at(-1) as AssistantMessage).content).toEqual([{ type: 'text', text: 'Full answer.' }]);
  // The interrupted partial is replaced by the answer that was requested again.
  expect(roles(reopened.messages)).toEqual(['user', 'assistant']);
});

it('stops accepting work once the chat is opened in another view', async () => {
  const { streamFn } = scriptedModel([
    { blocks: [{ type: 'text', text: 'one' }] },
    { blocks: [{ type: 'text', text: 'two' }] },
  ]);
  const { host, backend } = createHost(streamFn);
  const session = track(new AssistantSession());
  session.attach(host);
  await run(session, 'first');

  const other = track(new AssistantSession({ id: session.id, stored: true }));
  other.attach(createHost(streamFn, { backend }).host);
  await other.open();

  await expect(session.prompt('second')).rejects.toThrow();
  await waitFor(() => session.getState().storage.status === 'lost');
  expect(session.getState().storage).toMatchObject({ status: 'lost', reason: 'lease' });
  expect(roles(other.messages)).toEqual(['user', 'assistant']);
});

it('runs user shell commands into the transcript, where the model sees them', async () => {
  const { streamFn, requests } = scriptedModel([{ blocks: [{ type: 'text', text: 'Seen.' }] }]);
  const { host } = createHost(streamFn);
  const session = track(new AssistantSession());
  session.attach(host);

  await session.runUserShell('echo hello > /workspace/a.txt; cat /workspace/a.txt');

  expect(session.title).toBe('! echo hello > /workspace/a.txt; cat /workspace/a.txt');
  expect(session.messages.at(-1)).toMatchObject({ role: 'userShell', result: { stdout: 'hello\n', exitCode: 0 } });
  expect(session.getState().shellRunning).toBe(false);

  await run(session, 'what did I do?');
  expect(JSON.stringify(requests[0].messages)).toContain('The user ran this command in the session shell');
});

it('passes launch context only to the first prompt', async () => {
  const { streamFn, requests } = scriptedModel([
    { blocks: [{ type: 'text', text: 'one' }] },
    { blocks: [{ type: 'text', text: 'two' }] },
  ]);
  const { host } = createHost(streamFn);
  const session = track(
    new AssistantSession({
      launch: {
        external: {
          prompt: 'Check this',
          context: [{ node: { title: 'Launch item', data: 'launch-context' } }],
          autoSend: true,
        },
      },
    })
  );
  session.attach(host);

  await run(session, 'Check this');
  expect(getCurrentSystemPrompt(requests[0].messages)).toContain('Launch item');
  await run(session, 'And now?');
  expect(getCurrentSystemPrompt(requests[1].messages)).not.toContain('Launch item');
});

it('keeps the model choice with the chat', async () => {
  const { streamFn, requests } = scriptedModel([{ blocks: [{ type: 'text', text: 'ok' }] }]);
  const { host, backend } = createHost(streamFn);
  const session = track(new AssistantSession());
  session.attach(host);
  session.setModelSettings({ modelId: 'test', thinkingLevel: 'high' });
  await run(session, 'hi');
  expect(requests).toHaveLength(1);
  await session.close();

  const reopened = track(new AssistantSession({ id: session.id, stored: true }));
  reopened.attach(createHost(streamFn, { backend }).host);
  await reopened.open();
  expect(reopened.getState()).toMatchObject({ modelId: 'test' });
});

it('summarizes earlier turns when the context fills and keeps the transcript complete', async () => {
  const long = 'x'.repeat(12000);
  const replies: Reply[] = Array.from({ length: 6 }, (_, index) => ({
    blocks: [{ type: 'text' as const, text: `answer ${index} ${long}` }],
  }));
  const { streamFn, requests, summaries } = scriptedModel(replies, '- summary of earlier work');
  const { host } = createHost(streamFn, { contextWindow: 30000 });
  const session = track(new AssistantSession());
  session.attach(host);
  const events: ChatAgentEvent[] = [];
  session.subscribe((event) => events.push(event));

  for (let index = 0; index < 6; index++) {
    await run(session, `question ${index} ${long}`);
  }
  await waitFor(() => session.getState().transcript.compactions.length > 0, 10000);

  expect(summaries.length).toBeGreaterThan(0);
  expect(events.some((event) => event.type === 'context_compaction' && event.kind === 'summarized')).toBe(true);
  const transcript = session.getState().transcript;
  expect(transcript.compactions[0].summary).toBe('- summary of earlier work');
  expect(transcript.messages.filter((message: ChatMessage) => message.role === 'user')).toHaveLength(6);
  expect(transcript.messages.filter((message: ChatMessage) => message.role === 'assistant')).toHaveLength(6);
  // Requests after the summary no longer carry the first question.
  const later = requests.at(-1)!;
  if (summaries.length > 0 && JSON.stringify(later.messages).includes('summary of earlier work')) {
    expect(JSON.stringify(later.messages)).not.toContain('question 0');
  }
}, 20000);
