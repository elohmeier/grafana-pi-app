jest.mock('typebox', () => ({
  Type: Object.fromEntries(
    ['Array', 'Boolean', 'Number', 'Object', 'Optional', 'String'].map((name) => [
      name,
      (...args: unknown[]) => ({ args }),
    ])
  ),
}));

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { AssistantSession } from './AssistantSession';
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

it('serializes persistence with captured state independently of the view', async () => {
  const session = new AssistantSession();
  const seen: string[] = [];
  session.persist = async (snapshot) => {
    seen.push(snapshot.workspace.files['/session/note']?.content);
  };
  const first = session.workspace.begin();
  await first.writeFile('/session/note', 'first');
  first.commit();
  const saving = session.save();
  const second = session.workspace.begin();
  await second.writeFile('/session/note', 'second');
  second.commit();
  await Promise.all([saving, session.save()]);
  expect(seen).toEqual(['first', 'second']);
});

it('persists the complete history after a run, not only the run’s new messages', async () => {
  const session = new AssistantSession();
  const saved: unknown[][] = [];
  session.persist = async (snapshot) => {
    saved.push(snapshot.messages);
  };
  const answer = {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'second' }],
    api: 'openai-completions',
    provider: 'test',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as const,
    timestamp: 3,
  };
  const earlier = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'first' }], timestamp: 1 },
    { ...answer, content: [{ type: 'text' as const, text: 'first answer' }], timestamp: 2 },
  ];
  const agent = session.createAgent({
    messages: earlier,
    systemPrompt: '',
    tools: [],
    model: { id: 'test', contextWindow: 100000, maxTokens: 1000 } as never,
    thinkingLevel: 'off',
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'done', reason: 'stop', message: answer });
        stream.end(answer);
      });
      return stream;
    },
  });

  await agent.prompt('second question');
  await session.flushSaves();

  expect(saved.at(-1)?.map((message) => (message as { role: string }).role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
});
