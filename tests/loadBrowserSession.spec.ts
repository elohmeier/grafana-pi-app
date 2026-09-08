import { AppPage } from '@grafana/plugin-e2e';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test, expect } from './fixtures';
import { LoadBrowserSession, type LoadSession } from './loadBrowserSession';
import { runLoadStage, validateLoadConfig } from '../scripts/benchmarks/load.mjs';

// Exercises real chat/agent/tool wiring, with every model call intercepted.
// This is an ordinary regression test and never generates endpoint load.
test('load driver isolates conversations, captures specialists, resets and cancels', async ({
  browser,
  context,
  page,
  selectors,
  grafanaVersion,
  baseURL,
}, testInfo) => {
  test.setTimeout(90_000);
  const pluginId = process.env.E2E_PLUGIN_ID ?? 'grafana-assistant-app';
  const settings = await (await page.request.get(`/api/plugins/${pluginId}/settings`)).json();
  const expected =
    settings.jsonData.models.find((m: { default?: boolean }) => m.default) ?? settings.jsonData.models[0];
  const auth = await context.storageState();
  const contexts = [];
  const drivers = [];
  const promptLengths: number[] = [];
  let mode: 'normal' | 'rate-limit' | 'hang' = 'normal';
  const usage = { reported: true, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: {} };
  const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const textEvents = [
    { type: 'text_start', contentIndex: 0 },
    {
      type: 'text_delta',
      contentIndex: 0,
      delta:
        'http_requests_total http_request_duration_seconds_bucket node_load1 node_cpu_seconds_total. rate(http_requests_total[5m])',
    },
    { type: 'text_end', contentIndex: 0 },
    { type: 'done', reason: 'stop', usage },
  ];
  try {
    for (let i = 0; i < 2; i++) {
      const isolated = await browser.newContext({ baseURL, storageState: { cookies: auth.cookies, origins: [] } });
      contexts.push(isolated);
      await isolated.route('**/resources/llm/api/stream', async (route) => {
        if (mode === 'hang') return; // Cancellation closes the page with the request outstanding.
        if (mode === 'rate-limit') {
          await route.fulfill({
            contentType: 'text/event-stream',
            body: sse([{ type: 'error', upstreamStatus: 429, errorMessage: 'Too many requests' }]),
          });
          return;
        }
        const { context: chat } = route.request().postDataJSON();
        const parent = chat.tools.some((t: { name: string }) => t.name === 'run_query_agent');
        const hasResult = chat.messages.some((m: { role: string }) => m.role === 'toolResult');
        if (parent && !hasResult) promptLengths.push(chat.messages.length);
        await delay(50);
        const tool = parent ? 'run_query_agent' : 'query_prometheus';
        await route.fulfill({
          contentType: 'text/event-stream',
          body: sse([
            { type: 'start' },
            ...(hasResult
              ? textEvents
              : [
                  { type: 'toolcall_start', contentIndex: 0, id: randomUUID(), toolName: tool },
                  {
                    type: 'toolcall_delta',
                    contentIndex: 0,
                    delta: JSON.stringify(
                      parent ? { task: 'Find HTTP, load and CPU metrics' } : { query: 'vector(1)' }
                    ),
                  },
                  { type: 'toolcall_end', contentIndex: 0 },
                  { type: 'done', reason: 'toolUse', usage },
                ]),
          ]),
        });
      });
      await isolated.route('**/api/ds/query*', (route) =>
        route.fulfill({
          json: {
            results: {
              A: {
                status: 200,
                frames: [
                  {
                    schema: {
                      name: 'test',
                      fields: [
                        { name: 'Time', type: 'time' },
                        { name: 'Value', type: 'number' },
                      ],
                    },
                    data: { values: [[Date.now()], [1]] },
                  },
                ],
              },
            },
          },
        })
      );
      const navigate = async (target: typeof page) => {
        const app = new AppPage(
          { page: target, request: isolated.request, selectors, grafanaVersion, testInfo },
          { pluginId }
        );
        await app.goto({ path: '/chat?piAgentBenchmark=1' });
      };
      const target = await isolated.newPage();
      const driver = new LoadBrowserSession(target, expected, true, () => {}, navigate);
      await driver.install();
      await navigate(target);
      await driver.ready();
      drivers.push(driver);
    }
    const config = validateLoadConfig({
      concurrency: [2],
      workloads: ['explore-metrics'],
      rampUpMs: 0,
      warmupMs: 0,
      durationMs: 500,
      drainMs: 30_000,
      sessionTimeoutMs: 30_000,
      minSessions: 1,
    });
    const stage = await runLoadStage({
      stage: { workload: 'explore-metrics' },
      config,
      drivers,
      signal: new AbortController().signal,
    });
    const stagePath = testInfo.outputPath('mock-load-stage.json');
    await writeFile(stagePath, JSON.stringify(stage, null, 2));
    await testInfo.attach('mock-load-stage.json', { path: stagePath, contentType: 'application/json' });
    expect(stage.status).toBe('completed');
    expect(stage.sessions.length).toBeGreaterThanOrEqual(2);
    expect(
      stage.sessions.every((s: LoadSession) => s.status === 'passed'),
      JSON.stringify(stage.sessions.map((s: LoadSession) => s.error))
    ).toBe(true);
    expect(stage.sessions.every((s: LoadSession) => s.requests.length === 5)).toBe(true);
    expect(stage.summary.llmRequestsInFlight.peak).toBe(2);
    const newSession = (): LoadSession => ({
      id: randomUUID(),
      workload: 'explore-metrics',
      startedAt: Date.now(),
      status: 'running',
      requests: [],
    });
    await drivers[0].reset(new AbortController().signal);
    mode = 'rate-limit';
    const limited = newSession();
    await drivers[0].run(limited, AbortSignal.timeout(10_000));
    expect(limited.failureKind).toBe('rate-limit');
    expect(limited.requests[0].upstreamStatus).toBe(429);
    await drivers[0].reset(new AbortController().signal);
    mode = 'hang';
    await expect(drivers[0].run(newSession(), AbortSignal.timeout(500))).rejects.toBeDefined();
    mode = 'normal';
    await drivers[0].reset(new AbortController().signal);
    const recovered = newSession();
    await drivers[0].run(recovered, AbortSignal.timeout(20_000));
    expect(recovered.status, recovered.error).toBe('passed');
    expect(promptLengths.every((n) => n === promptLengths[0])).toBe(true);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
