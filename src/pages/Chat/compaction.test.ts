import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  buildSummarizerPrompt,
  ContextCompactor,
  estimateMessagesTokens,
  SUMMARY_TAG,
  type CompactionState,
  type SummarizerInput,
} from './compaction';

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
  const summarize = jest.fn(async ({ previousSummary, transcript }: SummarizerInput) => {
    const turns = [...transcript.matchAll(/question (\d+)/g)].map((match) => match[1]);
    return `${previousSummary ? `${previousSummary}; ` : ''}covered questions ${turns.join(',')}`;
  });
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

  it('elides earlier output of the running turn before summarizing, keeping the latest step verbatim', async () => {
    // One long turn whose recent steps alone exceed the history budget.
    const messages: AgentMessage[] = [user('print every dashboard')];
    for (let step = 0; step < 10; step++) {
      messages.push(assistantCall(`cat-${step}`, `cat ${step}.json`));
      messages.push(toolResult(`cat-${step}`, `${step}: `.padEnd(4000, 'x')));
    }
    const events: string[] = [];
    const { instance, summarize } = compactor(10_000, { onEvent: (event) => events.push(event.kind) });
    const view = await instance.transform(messages);
    expect(summarize).not.toHaveBeenCalled();
    expect(events).toEqual(['elided']);
    const texts = view
      .filter((message) => message.role === 'toolResult')
      .map((message) => (message as unknown as { content: Array<{ text: string }> }).content[0].text);
    expect(texts.slice(0, -1).every((text) => text.includes('older tool output omitted'))).toBe(true);
    expect(texts.at(-1)).toBe('9: '.padEnd(4000, 'x'));
  });

  it('clips latest output that alone exceeds the budget instead of summarizing on every step', async () => {
    const messages = [
      ...conversation(2, 200),
      user('print the dashboards'),
      assistantCall('cat', 'cat *.json'),
      toolResult('cat', 'head '.padEnd(60_000, 'x') + ' tail'),
    ];
    const events: string[] = [];
    const { instance, summarize } = compactor(12_000, { onEvent: (event) => events.push(event.kind) });
    const view = await instance.transform(messages);
    expect(summarize).not.toHaveBeenCalled();
    expect(events).toEqual(['clipped']);
    // The call that produced the output stays, so the model knows it already ran it.
    expect(view.at(-2)).toBe(messages.at(-2));
    const text = (view.at(-1) as unknown as { content: Array<{ text: string }> }).content[0].text;
    expect(text.startsWith('head ')).toBe(true);
    expect(text.endsWith(' tail')).toBe(true);
    expect(text).toContain('omitted to fit the context window');
    expect(estimateMessagesTokens(view)).toBeLessThan(12_000 - 1000 - 1000 - 2048);
  });

  it('asks for a summary sized to leave room in the history budget', async () => {
    const messages = conversation(40, 1200);
    const { instance, summarize } = compactor(12_000);
    await instance.transform(messages);
    // Budget: 12000 - 1000 output - 1000 fixed - 2048 margin = 7952 tokens.
    expect(summarize.mock.calls[0][0].targetTokens).toBe(Math.floor(7952 * 0.25));
    expect(buildSummarizerPrompt({ transcript: 't', targetTokens: 1000 })).toContain('under about 750 words');
    expect(buildSummarizerPrompt({ transcript: 't' })).not.toContain('words');
  });

  it('sizes summarizer requests by the window, not by the agent prompt it does not send', async () => {
    // A large system prompt leaves little history budget, but the summarizer can read far more per request.
    const messages = conversation(12, 3000);
    const { instance, summarize } = compactor(24_000, {
      getBudget: () => ({ contextWindow: 24_000, maxOutputTokens: 4096, fixedTokens: 14_000 }),
    });
    await instance.transform(messages);
    expect(summarize).toHaveBeenCalledTimes(1);
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
