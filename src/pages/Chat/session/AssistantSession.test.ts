jest.mock('typebox', () => ({
  Type: Object.fromEntries(
    ['Array', 'Boolean', 'Number', 'Object', 'Optional', 'String'].map((name) => [
      name,
      (...args: unknown[]) => ({ args }),
    ])
  ),
}));

import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type Context } from '@earendil-works/pi-ai';
import { SUMMARIZER_SYSTEM_PROMPT, type CompactionEvent } from '../compaction';
import { AssistantSession, type SessionHost } from './AssistantSession';
import type { StoredSession } from './sessionRecord';
import { createFakeDashboardBroker } from '../workspace/testUtils';

it('keeps catalog caches, artifacts, and pending approvals across view/toolkit changes', async () => {
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
  const listener = jest.fn();
  const unsubscribe = session.approvals.subscribe(listener);
  unsubscribe(); // A view detaches; the next view still sees the same pending decision.
  expect(session.approvals.getSnapshot()).toBe(request);
  session.approvals.settle(true);
  await expect(pending).resolves.toEqual({ approved: true, reason: undefined });
  expect(session.approvals.getSnapshot()).toBeUndefined();
});

it('passes the dashboards the reviewer kept', async () => {
  const session = new AssistantSession();
  const pending = session.approvals.request({
    applyId: 'apply-1',
    digest: '',
    title: '',
    summary: '',
    operations: [],
    groups: [],
    ungroupedChanges: 0,
  });
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

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string, timestamp = Date.now()) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'openai-completions',
    provider: 'test',
    model: 'test',
    usage,
    stopReason: 'stop' as const,
    timestamp,
  };
}

/** A host whose model answers prompts with the next reply and summarizer calls with `summary`. */
function createHost(replies: string[] = [], contextWindow = 100000, summary = '- summary') {
  const records: StoredSession[] = [];
  const requests: Context[] = [];
  const compactions: CompactionEvent[] = [];
  const { broker } = createFakeDashboardBroker([{ uid: 'one', title: 'One' }]);
  const streamFn: StreamFn = (_model, context) => {
    requests.push(context);
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage(
      context.systemPrompt === SUMMARIZER_SYSTEM_PROMPT ? summary : (replies.shift() ?? 'ok')
    );
    queueMicrotask(() => {
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end(message);
    });
    return stream;
  };
  const host: SessionHost = {
    environment: (session) => ({
      streamFn,
      model: { id: session.getState().modelId ?? 'test', contextWindow, maxTokens: 1000 } as never,
      thinkingLevel: 'off',
      broker,
      skills: [],
    }),
    persist: async (record) => {
      records.push(record);
    },
    onCompaction: (event) => compactions.push(event),
  };
  return { host, records, requests, compactions };
}

it('serializes persistence with captured state independently of the view', async () => {
  const session = new AssistantSession({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] });
  const { host, records } = createHost();
  session.attach(host);
  const first = session.workspace.begin();
  await first.writeFile('/session/note', 'first');
  first.commit();
  const saving = session.save();
  const second = session.workspace.begin();
  await second.writeFile('/session/note', 'second');
  second.commit();
  await Promise.all([saving, session.save()]);
  expect(records.map((record) => record.workspace?.files['/session/note']?.content)).toEqual(['first', 'second']);
  expect(session.getState().save).toEqual({ status: 'saved' });
});

it('persists the complete history after a run, not only the run’s new messages', async () => {
  const session = new AssistantSession({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }], timestamp: 1 },
      assistantMessage('first answer', 2),
    ],
  });
  const { host, records } = createHost(['second']);
  session.attach(host);

  await session.prompt('second question');

  expect(records.at(-1)?.messages.map((message) => (message as { role: string }).role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
});

it('titles a new chat from its first prompt and passes launch context only to that prompt', async () => {
  const session = new AssistantSession({
    launch: {
      external: {
        prompt: 'Check this',
        context: [{ node: { title: 'Launch item', data: 'launch-context' } }],
        autoSend: true,
      },
    },
  });
  const { host, requests, records } = createHost(['one', 'two']);
  session.attach(host);
  const states: Array<string | undefined> = [];
  session.subscribeState(() => states.push(session.getState().runStatus?.phase));

  await session.prompt('Why is   the error rate high?');
  expect(session.title).toBe('Why is the error rate high?');
  expect(requests[0].systemPrompt).toContain('Launch item');
  expect(states).toContain('waiting_model');
  expect(session.getState().runStatus).toBeUndefined();

  await session.prompt('And now?');
  expect(requests[1].systemPrompt).not.toContain('Launch item');
  expect(session.title).toBe('Why is the error rate high?');
  expect(records.at(-1)).toMatchObject({ id: session.id, title: 'Why is the error rate high?', modelId: 'test' });
});

it('runs user shell commands into the transcript and saves them', async () => {
  const session = new AssistantSession();
  const { host, records } = createHost();
  session.attach(host);

  await session.runUserShell('echo hello > /workspace/a.txt; cat /workspace/a.txt');

  expect(session.title).toBe('! echo hello > /workspace/a.txt; cat /workspace/a.txt');
  expect(session.messages.at(-1)).toMatchObject({ role: 'userShell', result: { stdout: 'hello\n', exitCode: 0 } });
  expect(records).toHaveLength(1);
  expect(session.getState().shellRunning).toBe(false);
});

it('keeps model choices with the session and restores them with its files', async () => {
  const session = new AssistantSession({ messages: [{ role: 'user', content: 'hi', timestamp: 1 }] });
  const { host, records } = createHost();
  session.attach(host);
  session.setModelSettings({ modelId: 'other', thinkingLevel: 'high' });
  const tx = session.workspace.begin();
  await tx.writeFile('/session/findings.md', 'notes');
  tx.commit();
  await session.save();

  const restored = AssistantSession.restore(records[0]);
  expect(restored.id).toBe(session.id);
  expect(restored.getState()).toMatchObject({ modelId: 'other', thinkingLevel: 'high' });
  expect(restored.workspace.getScratchFile('/session/findings.md')?.content).toBe('notes');

  const imported = AssistantSession.restore(records[0], { id: 'copy', title: 'Copy', trusted: false });
  expect(imported.id).toBe('copy');
  expect(imported.createdAt).toBeUndefined();
});

it('reports summaries and compaction progress while keeping the transcript complete', async () => {
  const long = 'x'.repeat(12000);
  const messages = Array.from({ length: 6 }, (_, index) =>
    index % 2 === 0
      ? { role: 'user' as const, content: `question ${index} ${long}`, timestamp: index + 1 }
      : assistantMessage(`answer ${index} ${long}`, index + 1)
  );
  const session = new AssistantSession({ messages });
  const { host, compactions, requests } = createHost(['final'], 30000, '- summary of earlier work');
  session.attach(host);
  const phases = new Set<string | undefined>();
  session.subscribeState(() => phases.add(session.getState().runStatus?.phase));

  await session.prompt('continue');

  expect(compactions.map((event) => event.kind)).toEqual(['summarizing', 'summarized']);
  expect(phases).toContain('compacting');
  expect(session.getState().compaction).toMatchObject({ summary: '- summary of earlier work', compactions: 1 });
  expect(session.messages).toHaveLength(8);
  expect(JSON.stringify(requests.at(-1)?.messages)).toContain('summary of earlier work');
  expect(session.snapshot().compaction?.coveredMessages).toBe(session.getState().compaction?.coveredMessages);
});
