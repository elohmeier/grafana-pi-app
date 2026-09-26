import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from '@earendil-works/pi-ai';
import {
  convertChatMessagesToLlm,
  createUserShellMessage,
  hasPersistableMessages,
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
