import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from '@earendil-works/pi-ai';
import {
  convertChatMessagesToLlm,
  createUserShellMessage,
  finishedTurnSteps,
  hasPersistableMessages,
  pairToolResults,
  parseUserShellInput,
} from './chatMessages';

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function user(text: string): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: 1,
  };
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'openai-completions',
    provider: 'openai-compatible',
    model: 'gpt-test',
    usage,
    stopReason: 'stop',
    timestamp: 2,
    ...overrides,
  };
}

function toolResult(toolCallId: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'list_datasources',
    content: [{ type: 'text', text: '[]' }],
    isError: false,
    timestamp: 3,
  };
}

describe('convertChatMessagesToLlm', () => {
  it('drops aborted assistant notices from future LLM context', () => {
    const messages: AgentMessage[] = [
      user('original request'),
      assistant({ content: [], stopReason: 'aborted', errorMessage: 'Request aborted by user' }),
      user('follow-up'),
    ];

    expect(convertChatMessagesToLlm(messages)).toEqual([messages[0], messages[2]]);
  });

  it('drops failed assistant notices from future LLM context', () => {
    const messages: AgentMessage[] = [
      user('original request'),
      assistant({ content: [], stopReason: 'error', errorMessage: 'Invalid value for content' }),
      user('follow-up'),
    ];

    expect(convertChatMessagesToLlm(messages)).toEqual([messages[0], messages[2]]);
  });

  it('keeps valid assistant tool calls with their tool results', () => {
    const toolCallingAssistant = assistant({
      content: [{ type: 'toolCall', id: 'call_1', name: 'list_datasources', arguments: {} }],
      stopReason: 'toolUse',
    });
    const result = toolResult('call_1');

    expect(convertChatMessagesToLlm([user('list datasources'), toolCallingAssistant, result])).toEqual([
      user('list datasources'),
      toolCallingAssistant,
      result,
    ]);
  });

  it('drops orphan tool results when their assistant call is not retained', () => {
    const blockedAssistant = assistant({
      content: [{ type: 'toolCall', id: 'call_1', name: 'list_datasources', arguments: {} }],
      stopReason: 'aborted',
    });

    expect(convertChatMessagesToLlm([user('list datasources'), blockedAssistant, toolResult('call_1')])).toEqual([
      user('list datasources'),
    ]);
  });

  it('normalizes legacy assistant messages with null content', () => {
    const legacyAssistant = assistant({ content: null as unknown as AssistantMessage['content'] });

    expect(convertChatMessagesToLlm([legacyAssistant])).toEqual([{ ...legacyAssistant, content: [] }]);
  });

  it('normalizes legacy assistant messages with string content', () => {
    const legacyAssistant = assistant({ content: 'legacy text' as unknown as AssistantMessage['content'] });

    expect(convertChatMessagesToLlm([legacyAssistant])).toEqual([
      { ...legacyAssistant, content: [{ type: 'text', text: 'legacy text' }] },
    ]);
  });
});

describe('hasPersistableMessages', () => {
  it('keeps aborted assistant notices persistable for the visible chat history', () => {
    expect(hasPersistableMessages([assistant({ content: [], stopReason: 'aborted' })])).toBe(true);
  });
});

describe('pairToolResults', () => {
  it('pairs results with calls from earlier assistant messages only', () => {
    const paired = toolResult('call_1');
    const orphan = toolResult('call_2');
    const early = toolResult('call_3');
    const messages: AgentMessage[] = [
      early,
      assistant({
        content: [
          { type: 'toolCall', id: 'call_1', name: 'bash', arguments: {} },
          { type: 'toolCall', id: 'call_3', name: 'bash', arguments: {} },
        ],
        stopReason: 'toolUse',
      }),
      paired,
      orphan,
      assistant({ content: null as unknown as AssistantMessage['content'] }),
    ];

    expect(pairToolResults(messages)).toEqual(new Map([['call_1', paired]]));
  });
});

describe('finishedTurnSteps', () => {
  const step = (id: string, timestamp: number) =>
    assistant({
      content: [{ type: 'toolCall', id, name: 'bash', arguments: {} }],
      stopReason: 'toolUse',
      timestamp,
    });
  const bashResult = (id: string, exitCode: number): ToolResultMessage => ({
    ...toolResult(id),
    toolName: 'bash',
    details: { exitCode },
  });

  it('summarizes the steps of turns that ended with an answer', () => {
    const messages: AgentMessage[] = [
      user('q1'),
      step('a', 1000),
      step('b', 4000),
      assistant({ timestamp: 13_000 }),
      user('q2'),
      assistant({ timestamp: 20_000 }),
    ];
    const results = new Map([
      ['a', bashResult('a', 0)],
      ['b', bashResult('b', 2)],
    ]);

    expect(finishedTurnSteps(messages, results)).toEqual([
      { start: 1, end: 2, toolCalls: 2, failedToolCalls: 1, durationMs: 12_000 },
    ]);
  });

  it('leaves turns in progress, aborted, or still calling tools expanded', () => {
    const aborted: AgentMessage[] = [user('q'), step('a', 1), assistant({ stopReason: 'aborted', content: [] })];
    const calling: AgentMessage[] = [user('q'), step('a', 1), step('b', 2)];
    const answering: AgentMessage[] = [user('q'), step('a', 1), assistant({ timestamp: 5 })];

    expect(finishedTurnSteps(aborted, new Map())).toEqual([]);
    expect(finishedTurnSteps(calling, new Map())).toEqual([]);
    expect(finishedTurnSteps(answering, new Map(), true)).toEqual([]);
    expect(finishedTurnSteps(answering, new Map())).toHaveLength(1);
  });
});

describe('user shell messages', () => {
  const result = {
    command: 'ls /session',
    cwd: '/workspace',
    exitCode: 0,
    stdout: 'report.md\n',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    changes: [],
    durationMs: 3,
    images: [{ data: 'aW1n', mimeType: 'image/png', title: 'Screenshot' }],
  };

  it('recognizes ! input', () => {
    expect(parseUserShellInput('  !ls -la ')).toBe('ls -la');
    expect(parseUserShellInput('!')).toBe('');
    expect(parseUserShellInput('why is ! here')).toBeUndefined();
  });

  it('shows the command and output to the model as user context, without image data', () => {
    const message = createUserShellMessage(result);
    expect(message.result).not.toHaveProperty('images');
    expect(hasPersistableMessages([message])).toBe(true);
    const [converted] = convertChatMessagesToLlm([message]);
    expect(converted.role).toBe('user');
    const text = (converted as UserMessage).content as Array<{ type: string; text: string }>;
    expect(text[0].text).toContain('$ ls /session');
    expect(text[0].text).toContain('report.md');
    expect(text[0].text).toContain('[exit 0]');
  });
});
