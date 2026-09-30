jest.mock('typebox', () => ({
  Type: Object.fromEntries(
    ['Array', 'Boolean', 'Number', 'Object', 'Optional', 'String'].map((name) => [
      name,
      (...args: unknown[]) => ({ args }),
    ])
  ),
}));

import type { AgentEvent, AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type JsonObject,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { SUMMARIZER_SYSTEM_PROMPT } from '../compaction';
import { createFakeDashboardBroker } from '../workspace/testUtils';
import { GRAFANA_SKILLS } from '../skills/catalog';
import type { GrafanaSkill } from '../skills/types';
import { AssistantSession, type SessionHost } from './AssistantSession';
import type { StoredSession } from './sessionRecord';

// Agent-loop behavior of AssistantSession against a scripted model stream:
// streaming, tool round trips, cancellation, and resume.

type Block =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string }
  | { type: 'toolCall'; id: string; name: string; arguments: JsonObject };

type Reply = {
  blocks: Block[];
  /** Resolves before the stream finishes; the stream then waits for the request signal. */
  hangAfterFirstDelta?: boolean;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A model that streams each scripted reply block by block, like streamProxy
 * reconstructing a proxy stream. Summarizer requests get `summary`.
 */
function scriptedModel(replies: Reply[], summary = '- summary') {
  const requests: TranscriptContext[] = [];
  const streamFn: StreamFn = (model, context, options) => {
    requests.push(clone(context));
    const stream = createAssistantMessageEventStream();
    const isSummary = getCurrentSystemPrompt(context.messages) === SUMMARIZER_SYSTEM_PROMPT;
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
      stopReason: 'pending',
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
            (partial.content[index] as Record<string, string>)[key] += delta;
            push({ type: `${block.type}_delta`, contentIndex: index, delta });
            if (reply.hangAfterFirstDelta) {
              await new Promise<void>((resolve) => {
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
  return { streamFn, requests };
}

function createHost(
  streamFn: StreamFn,
  contextWindow = 100000,
  options: { hangDashboardReads?: boolean; skills?: GrafanaSkill[] } = {}
) {
  const records: StoredSession[] = [];
  const { broker } = createFakeDashboardBroker([{ uid: 'one', title: 'One' }]);
  if (options.hangDashboardReads) {
    // A dashboard fetch that only ends when the request is canceled.
    broker.dashboards!.get = (_uid, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
  }
  const host: SessionHost = {
    environment: (session) => ({
      streamFn,
      model: {
        id: session.getState().modelId ?? 'test',
        api: 'openai-completions',
        provider: 'test',
        contextWindow,
        maxTokens: 1000,
      } as never,
      thinkingLevel: 'off',
      broker,
      skills: options.skills ?? [],
    }),
    persist: async (record) => {
      records.push(clone(record));
    },
  };
  return { host, records };
}

function roles(messages: readonly AgentMessage[]) {
  return messages.map((message) => message.role);
}

it('keeps the skills of earlier prompts active in follow-up turns', async () => {
  const { streamFn } = scriptedModel([
    { blocks: [{ type: 'text', text: 'Done.' }] },
    { blocks: [{ type: 'text', text: 'Done.' }] },
  ]);
  const { host } = createHost(streamFn, 100000, { skills: [...GRAFANA_SKILLS] });
  const activeSkills: string[][] = [];
  host.onPromptStart = (start) => activeSkills.push(start.activeSkills.map((skill) => skill.name));
  const session = new AssistantSession();
  session.attach(host);

  await session.prompt('Create a dashboard for HTTP request rate for all team-* namespaces');
  await session.prompt('Trenne 4xx und 5xx Fehler und filtere nach Environment');

  expect(activeSkills).toEqual([['grafana-dashboard'], ['grafana-dashboard']]);
});

it('streams thinking and text into one assistant message', async () => {
  const { streamFn, requests } = scriptedModel([
    {
      blocks: [
        { type: 'thinking', thinking: 'Look at the request.' },
        { type: 'text', text: 'Hello there.' },
      ],
    },
  ]);
  const session = new AssistantSession();
  session.attach(createHost(streamFn).host);
  const deltas: string[] = [];
  session.subscribe((event: AgentEvent) => {
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if (update.type === 'text_delta' || update.type === 'thinking_delta') {
        deltas.push(`${update.type}:${update.delta}`);
      }
    }
  });

  await session.prompt('hi');

  expect(deltas).toEqual([
    'thinking_delta:Loo',
    'thinking_delta:k at the request.',
    'text_delta:Hel',
    'text_delta:lo there.',
  ]);
  const answer = session.messages.at(-1) as AssistantMessage;
  expect(answer.stopReason).toBe('stop');
  expect(answer.content).toEqual([
    { type: 'thinking', thinking: 'Look at the request.' },
    { type: 'text', text: 'Hello there.' },
  ]);

  // Pi 0.87 sends the prompt and tools as the transcript's leading system message.
  const request = requests[0];
  expect(roles(request.messages)).toEqual(['system', 'user']);
  expect(getCurrentSystemPrompt(request.messages)).toContain('/workspace');
  expect(
    getCurrentTools(request.messages)
      .map((tool) => tool.name)
      .sort()
  ).toEqual(['bash', 'edit', 'read', 'write']);
  // The conversation the chat shows and stores has no system message.
  expect(roles(session.messages)).toEqual(['user', 'assistant']);
});

it('runs a tool call and sends its result back with the same call ID', async () => {
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
  const session = new AssistantSession();
  const { host, records } = createHost(streamFn);
  session.attach(host);

  await session.prompt('write a file');

  expect(roles(session.messages)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
  const result = session.messages[2] as Extract<AgentMessage, { role: 'toolResult' }>;
  expect(result).toMatchObject({ toolCallId: 'call_1', toolName: 'bash', isError: false });
  expect(JSON.stringify(result.content)).toContain('hello');
  expect(session.workspace.getScratchFile('/workspace/a.txt')?.content).toBe('hello\n');

  expect(requests).toHaveLength(2);
  expect(roles(requests[1].messages)).toEqual(['system', 'user', 'assistant', 'toolResult']);
  const [, , call, sent] = requests[1].messages as unknown as [
    unknown,
    unknown,
    AssistantMessage,
    { toolCallId: string },
  ];
  expect(call.content.find((block) => block.type === 'toolCall')).toMatchObject({ id: 'call_1', name: 'bash' });
  expect(sent.toolCallId).toBe('call_1');
  // One system message leads every request of the run; no tool changes were declared.
  expect(requests[1].messages.filter((message) => message.role === 'system')).toHaveLength(1);
  expect(records.at(-1)?.messages.some((message) => message.role === 'system')).toBe(false);
});

it('stops a streaming reply on abort and keeps the session usable', async () => {
  const { streamFn, requests } = scriptedModel([
    { blocks: [{ type: 'text', text: 'Partial answer' }], hangAfterFirstDelta: true },
    { blocks: [{ type: 'text', text: 'Second answer.' }] },
  ]);
  const session = new AssistantSession();
  session.attach(createHost(streamFn).host);
  session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      session.abort();
    }
  });

  await session.prompt('first');

  expect(session.isStreaming).toBe(false);
  expect(session.getState().runStatus).toBeUndefined();
  const aborted = session.messages.at(-1) as AssistantMessage;
  expect(aborted.stopReason).toBe('aborted');

  await session.prompt('second');
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
  const session = new AssistantSession();
  session.attach(createHost(streamFn, 100000, { hangDashboardReads: true }).host);
  session.subscribe((event) => {
    if (event.type === 'tool_execution_start') {
      setTimeout(() => session.abort(), 50);
    }
  });

  const started = Date.now();
  await session.prompt('wait');

  expect(Date.now() - started).toBeLessThan(10000);
  expect(session.isStreaming).toBe(false);
  const result = session.messages.find((message) => message.role === 'toolResult') as Extract<
    AgentMessage,
    { role: 'toolResult' }
  >;
  expect(result.toolCallId).toBe('call_wait');
  expect(result.details).toMatchObject({ exitCode: 130, discardedChanges: 'cancelled' });
  expect(session.workspace.getScratchFile('/workspace/partial.txt')).toBeUndefined();
});

it('resumes a stored session with its compaction summary and continues the turn', async () => {
  const long = 'x'.repeat(12000);
  const history: AgentMessage[] = Array.from({ length: 6 }, (_, index) =>
    index % 2 === 0
      ? { role: 'user' as const, content: `question ${index} ${long}`, timestamp: index + 1 }
      : {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: `answer ${index} ${long}` }],
          api: 'openai-completions',
          provider: 'test',
          model: 'test',
          usage: zeroUsage,
          stopReason: 'stop' as const,
          timestamp: index + 1,
        }
  );
  const first = scriptedModel([{ blocks: [{ type: 'text', text: 'first run' }] }], '- the user asked six questions');
  const original = new AssistantSession({ messages: history });
  const { host, records } = createHost(first.streamFn, 30000);
  original.attach(host);
  await original.prompt('continue');
  const stored = records.at(-1)!;
  expect(stored.compaction).toMatchObject({ summary: '- the user asked six questions' });
  expect(stored.messages.some((message) => message.role === 'system')).toBe(false);
  const covered = stored.compaction!.coveredMessages;

  // A new view restores the record and continues without summarizing again.
  const second = scriptedModel([{ blocks: [{ type: 'text', text: 'resumed' }] }], '- should not be used');
  const restored = AssistantSession.restore(clone(stored));
  restored.attach(createHost(second.streamFn, 30000).host);
  expect(restored.messages).toHaveLength(stored.messages.length);
  expect(restored.getState().compaction?.coveredMessages).toBe(covered);

  await restored.prompt('and now?');

  expect((restored.messages.at(-1) as AssistantMessage).content).toEqual([{ type: 'text', text: 'resumed' }]);
  expect(restored.getState().compaction).toMatchObject({ summary: '- the user asked six questions', compactions: 1 });
  const request = second.requests.at(-1)!;
  expect(second.requests).toHaveLength(1);
  expect(request.messages[0].role).toBe('system');
  expect(JSON.stringify(request.messages)).toContain('the user asked six questions');
  expect(JSON.stringify(request.messages)).toContain('and now?');
  expect(JSON.stringify(request.messages)).not.toContain('question 0');
});
