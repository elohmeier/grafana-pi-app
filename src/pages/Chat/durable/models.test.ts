import type { TranscriptContext } from '@earendil-works/pi-ai';
import { SUMMARY_FOCUS, withSummaryFocus } from './models';

it('adds the observability focus to summarizer requests only', () => {
  const summary = {
    messages: [
      { role: 'system', content: 'You are a context summarization assistant. Your task is ...', timestamp: 1 },
      { role: 'user', content: [{ type: 'text', text: '<conversation>...</conversation>' }], timestamp: 1 },
    ],
  } as TranscriptContext;
  const focused = withSummaryFocus(summary);
  expect(JSON.stringify(focused.messages[1])).toContain(SUMMARY_FOCUS);
  expect(focused.messages[0]).toBe(summary.messages[0]);

  const chat = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] } as TranscriptContext;
  expect(withSummaryFocus(chat)).toBe(chat);
});
