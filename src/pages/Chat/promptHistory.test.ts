import type { ChatMessage } from './chatMessages';
import {
  navigatePromptHistory,
  promptHistory,
  searchPromptHistory,
  searchPromptHistoryNewer,
  type PromptHistoryState,
} from './promptHistory';

const user = (text: string) => ({ role: 'user', content: text, timestamp: 0 }) as ChatMessage;
const shell = (command: string) =>
  ({ role: 'userShell', content: [], result: { command }, timestamp: 0 }) as unknown as ChatMessage;
const assistant = {
  role: 'assistant',
  content: [{ type: 'text', text: 'answer' }],
  timestamp: 0,
} as unknown as ChatMessage;

describe('promptHistory', () => {
  it('lists prompts and shell commands newest first, without consecutive duplicates', () => {
    const messages = [user('first'), assistant, shell('ls /tmp'), user('second'), user('second')];
    expect(promptHistory(messages)).toEqual(['second', '!ls /tmp', 'first']);
  });
});

describe('navigatePromptHistory', () => {
  const messages = [user('first'), shell('ls'), user('second')];

  function walk(input: string, directions: Array<-1 | 1>) {
    let state: PromptHistoryState | undefined;
    let text = input;
    const shown: Array<string | undefined> = [];
    for (const direction of directions) {
      const step = navigatePromptHistory(state, messages, text, direction);
      shown.push(step?.text);
      if (step) {
        state = step.state;
        text = step.text;
      }
    }
    return shown;
  }

  it('walks back through the history and restores the draft on the way forward', () => {
    expect(walk('', [-1, -1, -1, -1, 1, 1, 1, 1])).toEqual([
      'second',
      '!ls',
      'first',
      undefined,
      '!ls',
      'second',
      '',
      undefined,
    ]);
  });

  it('browses only shell commands from shell mode', () => {
    expect(walk('!', [-1, -1, 1])).toEqual(['!ls', undefined, '!']);
  });
});

describe('searchPromptHistory', () => {
  const entries = ['!grafana fetch --all', 'show error rates', '!grafana search kafka', 'list dashboards'];

  it('finds the newest entry containing the text, then older ones, ignoring case', () => {
    expect(searchPromptHistory(entries, 'GRAFANA')).toBe(0);
    expect(searchPromptHistory(entries, 'grafana', 1)).toBe(2);
    expect(searchPromptHistory(entries, 'grafana', 3)).toBeUndefined();
    expect(searchPromptHistoryNewer(entries, 'grafana', 1)).toBe(0);
  });
});
