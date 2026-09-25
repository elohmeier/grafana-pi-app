import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { ContextCompactor, estimateMessagesTokens, SUMMARY_TAG, type CompactionState } from './compaction';

let clock = 1;
const user = (text: string) => ({ role: 'user', content: text, timestamp: clock++ }) as AgentMessage;
const assistantCall = (id: string, command: string) =>
  ({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'bash', arguments: { command } }],
    timestamp: clock++,
  }) as unknown as AgentMessage;
const toolResult = (id: string, text: string) =>
  ({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: clock++,
  }) as unknown as AgentMessage;
const assistantText = (text: string) =>
  ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: clock++ }) as unknown as AgentMessage;

function conversation(turns: number, outputChars: number) {
  const messages: AgentMessage[] = [];
  for (let turn = 0; turn < turns; turn++) {
    messages.push(user(`question ${turn}`));
    messages.push(assistantCall(`call-${turn}`, `grafana-prom query up # ${turn}`));
    messages.push(toolResult(`call-${turn}`, `result ${turn} `.padEnd(outputChars, 'x')));
    messages.push(assistantText(`answer ${turn}`));
  }
  return messages;
}

function compactor(contextWindow: number, overrides: Partial<ConstructorParameters<typeof ContextCompactor>[0]> = {}) {
  const summarize = jest.fn(
    async ({ previousSummary, transcript }: { previousSummary?: string; transcript: string }) => {
      const turns = [...transcript.matchAll(/question (\d+)/g)].map((match) => match[1]);
      return `${previousSummary ? `${previousSummary}; ` : ''}covered questions ${turns.join(',')}`;
    }
  );
  const states: Array<CompactionState | undefined> = [];
  const instance = new ContextCompactor({
    getBudget: () => ({ contextWindow, maxOutputTokens: 1000, fixedTokens: 1000 }),
    summarize,
    onStateChange: (state) => states.push(state),
    ...overrides,
  });
  return { instance, summarize, states };
}

describe('ContextCompactor', () => {
  it('passes small conversations through unchanged', async () => {
    const messages = conversation(3, 100);
    const { instance, summarize } = compactor(100_000);
    await expect(instance.transform(messages)).resolves.toBe(messages);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('elides old tool output before summarizing', async () => {
    const messages = conversation(6, 6000);
    const events: string[] = [];
    const { instance, summarize } = compactor(14_000, { onEvent: (event) => events.push(event.kind) });
    const view = await instance.transform(messages);
    expect(summarize).not.toHaveBeenCalled();
    expect(events).toEqual(['elided']);
    const lastResult = view[view.length - 2] as unknown as { content: Array<{ text: string }> };
    expect(lastResult.content[0].text).not.toContain('omitted');
    const firstResult = view[2] as unknown as { content: Array<{ text: string }> };
    expect(firstResult.content[0].text).toContain('characters of older tool output omitted');
  });

  it('summarizes older turns without splitting tool calls from results and keeps the latest request verbatim', async () => {
    const messages = conversation(40, 1200);
    const { instance, summarize, states } = compactor(20_000);
    const view = await instance.transform(messages);
    expect(summarize).toHaveBeenCalled();
    const state = states.at(-1)!;
    expect(state.coveredMessages).toBeGreaterThan(0);
    expect((messages[state.coveredMessages] as { role: string }).role).not.toBe('toolResult');
    const first = view[0] as unknown as { role: string; content: Array<{ text: string }> };
    expect(first.role).toBe('user');
    expect(first.content[0].text).toContain(`<${SUMMARY_TAG}>`);
    expect(first.content[0].text).toContain('covered questions 0,1');
    expect(view.at(-1)).toBe(messages.at(-1));
    expect(estimateMessagesTokens(view)).toBeLessThanOrEqual(20_000 - 1000 - 1000 - 2048);
  });

  it('reuses the cached summary and extends it incrementally', async () => {
    const messages = conversation(40, 1200);
    const { instance, summarize, states } = compactor(20_000);
    await instance.transform(messages);
    const calls = summarize.mock.calls.length;
    await instance.transform([...messages]);
    expect(summarize.mock.calls.length).toBe(calls);

    const longer = [...messages, ...conversation(30, 1200)];
    await instance.transform(longer);
    expect(summarize.mock.calls.length).toBeGreaterThan(calls);
    expect(summarize.mock.calls.at(-1)![0].previousSummary).toContain('covered questions 0');
    expect(states.at(-1)!.compactions).toBe(2);
  });

  it('restores persisted state and invalidates it when the transcript diverges', async () => {
    const messages = conversation(40, 1200);
    const first = compactor(20_000);
    await first.instance.transform(messages);
    const persisted = JSON.parse(JSON.stringify(first.instance.getState()));

    const restored = compactor(20_000, { initialState: persisted });
    await restored.instance.transform(messages);
    expect(restored.summarize).not.toHaveBeenCalled();

    const diverged = compactor(20_000, { initialState: persisted });
    await diverged.instance.transform(conversation(2, 10));
    expect(diverged.states[0]).toBeUndefined();
  });

  it('falls back to truncation when summarization fails', async () => {
    const messages = conversation(40, 1200);
    const events: string[] = [];
    const { instance } = compactor(20_000, {
      summarize: async () => {
        throw new Error('model unavailable');
      },
      onEvent: (event) => events.push(event.kind),
    });
    const view = await instance.transform(messages);
    expect(events).toContain('truncated');
    expect(view.at(-1)).toBe(messages.at(-1));
    expect((view[0] as { role: string }).role).not.toBe('toolResult');
  });
});
