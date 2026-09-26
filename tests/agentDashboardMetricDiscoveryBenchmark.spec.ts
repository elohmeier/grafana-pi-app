import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import {
  bashCalls,
  dashboardWriteAttempts,
  findBudgetError,
  findFinalAssistantError,
  findFinalAssistantText,
  formatDuration,
  formatLiveEvent,
  formatToolTimeline,
  hasSuccessfulPromEvidence,
  promQueryCalls,
  readPositiveInteger,
  stagedGrafanaPaths,
  summarizeToolCalls,
  summarizeUsage,
  type BenchmarkEvent,
} from './benchmarkOutcomes';

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TOOL_CALLS = 12;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'dashboard-metric-discovery-benchmark');

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 90_000));

test.describe('dashboard metric discovery benchmark', () => {
  test('uses dashboard metric context before validating PromQL', async ({ gotoPage, page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const serviceUid = `metric-context-service-${suffix}`;
    const infraUid = `metric-context-infra-${suffix}`;
    const serviceTitle = `Metric Context Service ${suffix}`;
    const infraTitle = `Metric Context Infra ${suffix}`;

    await seedDashboard(page, serviceUid, serviceTitle, serviceDashboard(serviceUid, serviceTitle));
    await seedDashboard(page, infraUid, infraTitle, infraDashboard(infraUid, infraTitle));

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
      const streamedEvents = await installBenchmarkRecorder(page);

      const prompt = [
        `Our existing "Metric Context ${suffix}" dashboards already chart HTTP errors, latency, host load, and CPU.`,
        'Starting from http_requests_total, use how those dashboards combine metrics to find the related metrics,',
        'then validate PromQL for the HTTP 5xx rate, p95 request latency, node load, and non-idle CPU against the demo Prometheus datasource.',
        'Answer concisely: which related metrics the dashboards revealed (and on which panels), and the validated PromQL results.',
        'Do not create or modify dashboards.',
      ].join(' ');

      const promptStartedAt = Date.now();
      const composer = page.getByTestId(testIds.chat.composer);
      const send = page.getByTestId(testIds.chat.send);
      await composer.fill(prompt);
      await expect(send).toBeEnabled();
      await send.click();

      const timedOut = !(await waitForAgentEnd(page, streamedEvents, timeoutMs));
      if (timedOut) {
        await page
          .getByRole('button', { name: /Stop/i })
          .click({ timeout: 1000 })
          .catch(() => undefined);
      }

      const events = await readBenchmarkEvents(page, streamedEvents);
      const finalAnswer = findFinalAssistantText(events);
      const report = formatBenchmarkReport(events, { prompt, promptStartedAt, timeoutMs, timedOut, finalAnswer });
      await testInfo.attach('dashboard-metric-discovery-benchmark-report.txt', {
        body: report,
        contentType: 'text/plain',
      });
      await testInfo.attach('dashboard-metric-discovery-benchmark-events.json', {
        body: JSON.stringify(events, null, 2),
        contentType: 'application/json',
      });
      await writeBenchmarkArtifacts(events, report, finalAnswer);

      console.log(report);

      if (timedOut) {
        throw new Error(`Dashboard metric discovery benchmark timed out after ${timeoutMs}ms.`);
      }

      const finalAssistantError = findFinalAssistantError(events);
      if (finalAssistantError) {
        throw new Error(`Dashboard metric discovery benchmark ended with assistant error: ${finalAssistantError}`);
      }

      const qualityError = findQualityError(events);
      if (qualityError) {
        throw new Error(`Dashboard metric discovery benchmark failed quality gate: ${qualityError}`);
      }
    } finally {
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(serviceUid)}`).catch(() => undefined);
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(infraUid)}`).catch(() => undefined);
    }
  });
});

async function seedDashboard(page: Page, uid: string, title: string, dashboard: Record<string, unknown>) {
  const response = await page.request.post('/api/dashboards/db', {
    data: {
      dashboard: {
        uid,
        title,
        tags: ['dashboard-metric-discovery-benchmark'],
        timezone: 'browser',
        schemaVersion: 41,
        time: { from: 'now-6h', to: 'now' },
        ...dashboard,
      },
      overwrite: true,
    },
  });
  expect(response).toBeOK();
}

function serviceDashboard(uid: string, title: string) {
  return {
    uid,
    title,
    panels: [
      {
        id: 1,
        title: 'HTTP errors and host load',
        type: 'timeseries',
        datasource: { uid: 'prometheus', type: 'prometheus' },
        gridPos: { x: 0, y: 0, w: 24, h: 8 },
        targets: [
          {
            refId: 'A',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            expr: 'sum by (vm, route, status) (rate(http_requests_total{status=~"5.."}[$__rate_interval]))',
            legendFormat: '{{vm}} {{route}} {{status}}',
          },
          {
            refId: 'B',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            expr: 'avg by(instance) (node_load1{job="node"})',
            legendFormat: '{{instance}} load',
          },
        ],
      },
      {
        id: 2,
        title: 'Route p95 latency',
        type: 'timeseries',
        datasource: { uid: 'prometheus', type: 'prometheus' },
        gridPos: { x: 0, y: 8, w: 24, h: 8 },
        targets: [
          {
            refId: 'A',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            expr: 'histogram_quantile(0.95, sum by (le, vm, route) (rate(http_request_duration_seconds_bucket[$__rate_interval])))',
            legendFormat: '{{vm}} {{route}}',
          },
        ],
      },
    ],
  };
}

function infraDashboard(uid: string, title: string) {
  return {
    uid,
    title,
    panels: [
      {
        id: 1,
        title: 'CPU busy by instance',
        type: 'timeseries',
        datasource: { uid: 'prometheus', type: 'prometheus' },
        gridPos: { x: 0, y: 0, w: 24, h: 8 },
        targets: [
          {
            refId: 'A',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            expr: '100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval])) * 100)',
            legendFormat: '{{instance}} CPU busy',
          },
        ],
      },
    ],
  };
}

async function installBenchmarkRecorder(page: Page) {
  const streamedEvents: BenchmarkEvent[] = [];

  await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
    streamedEvents.push(event);
    const line = formatLiveEvent('dashboard-metric-discovery-benchmark', event);
    if (line) {
      console.log(line);
    }
  });

  const installRecorder = () => {
    const benchmarkWindow = window as typeof window & {
      __PI_AGENT_BENCHMARK_EVENTS__?: unknown[];
      __PI_AGENT_BENCHMARK_RECORD_EVENT__?: (event: unknown) => void;
      __PI_AGENT_BENCHMARK_STREAM_EVENT__?: (event: unknown) => Promise<void>;
    };

    benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ = [];
    benchmarkWindow.__PI_AGENT_BENCHMARK_RECORD_EVENT__ = (event: unknown) => {
      benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__?.push(event);
      void benchmarkWindow.__PI_AGENT_BENCHMARK_STREAM_EVENT__?.(event);
    };
  };

  await page.addInitScript(installRecorder);
  await Promise.all(page.frames().map((frame) => frame.evaluate(installRecorder).catch(() => undefined)));

  return streamedEvents;
}

async function readBenchmarkEvents(page: Page, streamedEvents: BenchmarkEvent[]): Promise<BenchmarkEvent[]> {
  const frameEvents = await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(() => {
          const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: BenchmarkEvent[] };
          return benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ ?? [];
        })
        .catch(() => [] as BenchmarkEvent[])
    )
  );
  const bestFrameEvents = frameEvents.reduce<BenchmarkEvent[]>(
    (best, events) => (events.length > best.length ? events : best),
    []
  );
  return bestFrameEvents.length > 0 ? bestFrameEvents : streamedEvents;
}

async function waitForAgentEnd(page: Page, streamedEvents: BenchmarkEvent[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readBenchmarkEvents(page, streamedEvents);
    if (events.some((event) => event.type === 'agent_end')) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

function formatBenchmarkReport(
  events: BenchmarkEvent[],
  options: { prompt: string; promptStartedAt: number; timeoutMs: number; timedOut: boolean; finalAnswer: string }
) {
  const agentStart = events.find((event) => event.type === 'agent_start')?.timestamp ?? options.promptStartedAt;
  const agentEnd = [...events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const elapsedMs = (agentEnd ?? Date.now()) - agentStart;
  const usage = summarizeUsage(events);
  const qualityError = options.timedOut ? undefined : findQualityError(events);
  const lines = [
    'Dashboard metric discovery benchmark',
    `Prompt: ${options.prompt}`,
    `Timed out: ${options.timedOut ? 'yes' : 'no'}`,
    `Agent elapsed: ${formatDuration(elapsedMs)}`,
    `Timeout: ${formatDuration(options.timeoutMs)}`,
    `Token usage: input=${usage.input}, output=${usage.output}, total=${usage.totalTokens}`,
    `Tool calls: ${summarizeToolCalls(events).length}`,
    `Quality gate: ${options.timedOut ? 'not run' : (qualityError ?? 'passed')}`,
    '',
    'Tool calls',
    ...formatToolTimeline(events),
  ];

  if (options.finalAnswer.trim()) {
    lines.push('', 'Final answer', truncateReportText(options.finalAnswer, 2000));
  }

  return lines.join('\n');
}

async function writeBenchmarkArtifacts(events: BenchmarkEvent[], report: string, finalAnswer: string) {
  const runSuffix = process.env.BENCH_RUN_INDEX ? `-run-${process.env.BENCH_RUN_INDEX}` : '';
  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'latest-events.json'), JSON.stringify(events, null, 2)),
    writeFile(path.join(OUTPUT_DIR, 'latest-report.txt'), report),
    writeFile(path.join(OUTPUT_DIR, 'latest-answer.md'), finalAnswer),
    writeFile(path.join(OUTPUT_DIR, `events${runSuffix}.json`), JSON.stringify(events, null, 2)),
    writeFile(path.join(OUTPUT_DIR, `report${runSuffix}.txt`), report),
    writeFile(path.join(OUTPUT_DIR, `answer${runSuffix}.md`), finalAnswer),
  ]);
}

/**
 * Outcome gate: dashboard-derived context (typed metric-usage tools, or searching
 * hydrated dashboards from bash) was consulted before PromQL validation, the
 * validation succeeded, the run stayed read-only and within budget, and the
 * answer names the related metrics.
 */
function findQualityError(events: BenchmarkEvent[]) {
  const budgetError = findBudgetError(events, {
    maxToolCalls: readPositiveInteger(process.env.BENCH_METRIC_DISCOVERY_MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS),
  });
  if (budgetError) {
    return budgetError;
  }

  const writes = dashboardWriteAttempts(events);
  if (writes.length > 0) {
    return `read-only benchmark attempted dashboard writes: ${writes.join(', ')}`;
  }
  const staged = stagedGrafanaPaths(events);
  if (staged.length > 0) {
    return `read-only benchmark staged Grafana resource changes: ${staged.join(', ')}`;
  }

  const contextStartedAt = firstDashboardContextStart(events);
  if (contextStartedAt === undefined) {
    return 'dashboard metric context was not consulted (no grafana-usage command or dashboard search/inspection)';
  }
  const firstQuery = promQueryCalls(events)[0];
  if (firstQuery && firstQuery.startedAt < contextStartedAt) {
    return 'PromQL validation started before any dashboard metric context was consulted';
  }
  if (!hasSuccessfulPromEvidence(events)) {
    return 'no successful `grafana-prom query` evidence was found';
  }

  const answer = findFinalAssistantText(events);
  if (/zero related metrics|no matching dashboards|no related metrics|no dashboard-derived/i.test(answer)) {
    return 'dashboard metric context did not find dashboard-derived evidence';
  }
  const expectations = [
    { label: 'http_requests_total', pattern: /\bhttp_requests_total\b/i },
    { label: 'http_request_duration_seconds_bucket', pattern: /\bhttp_request_duration_seconds(_bucket)?\b/i },
    { label: 'node_load1', pattern: /\bnode_load1\b/i },
    { label: 'node_cpu_seconds_total', pattern: /\bnode_cpu_seconds_total\b/i },
    { label: 'dashboard context evidence', pattern: /dashboard|panel|neighbo/i },
    { label: 'validated PromQL', pattern: /rate\(|histogram_quantile|validated/i },
  ];
  const missing = expectations.filter((expectation) => !expectation.pattern.test(answer));
  if (missing.length > 0) {
    return `final answer is missing ${missing.map((item) => item.label).join(', ')}`;
  }

  return undefined;
}

function firstDashboardContextStart(events: BenchmarkEvent[]) {
  const shell = bashCalls(events).filter(
    (call) =>
      call.status === 'completed' &&
      !call.isError &&
      (/\bgrafana-usage\s+(search|related|dashboard)\b/.test(call.command) ||
        /\bgrafana\s+(search|fetch)\b|\bgrafana-dashboard\s+(inspect|data)\b/.test(call.command) ||
        (/\b(rg|grep|jq|cat|find)\b/.test(call.command) && call.command.includes('/grafana/')))
  );
  const starts = shell.map((call) => call.startedAt);
  return starts.length > 0 ? Math.min(...starts) : undefined;
}

function truncateReportText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
