import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import type { Page } from '@playwright/test';
import {
  appliedDashboardUids,
  bashCalls,
  dashboardExpressions,
  fetchSavedDashboard,
  findBudgetError,
  findFinalAssistantError,
  findFinalAssistantText,
  formatDuration,
  formatLiveEvent,
  formatToolTimeline,
  getRecord,
  hasSuccessfulPromEvidence,
  nonRowPanels,
  numericField,
  promEvidenceText,
  readPositiveInteger,
  stringField,
  summarizeToolCalls,
  summarizeUsage,
  truncateOneLine,
  type BenchmarkEvent,
  type SavedDashboard,
} from './benchmarkOutcomes';

const DEFAULT_TIMEOUT_MS = 240_000;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'dashboard-context-benchmark');
const LOG_PREFIX = 'dashboard-context-benchmark';
const BUDGET = { maxToolCalls: 30 };

type BenchmarkRun = {
  name: 'rich';
  prompt: string;
  events: BenchmarkEvent[];
  finalAnswer: string;
  promptStartedAt: number;
  timeoutMs: number;
  timedOut: boolean;
};

type Outcome = {
  fixed?: SavedDashboard;
  source?: SavedDashboard;
};

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS * 2 + 90_000));

test.describe('dashboard context benchmark', () => {
  test('repairs a stale dashboard using rich dashboard context', async ({ gotoPage, page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const sourceUid = `ctx-bench-stale-${suffix}`;
    const fixedUid = `ctx-bench-rich-${suffix}`;
    const sourceTitle = `Context Benchmark Stale ${suffix}`;
    const fixedTitle = `Context Benchmark Rich ${suffix}`;

    await seedStaleDashboard(page, sourceUid, sourceTitle);

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
      await installBenchmarkRecorder(page);

      const richPrompt = [
        `The dashboard with UID ${sourceUid} shows no data anymore; its queries seem to use outdated metric and label names.`,
        `Check its panels against the demo Prometheus data and save a repaired copy titled "${fixedTitle}" with UID ${fixedUid}. Leave the original dashboard unchanged.`,
        'The repaired copy should show request rate, the HTTP 5xx/error signal, and p95 latency for /render/report over the last 6 hours, using the metric and label names that actually exist.',
      ].join(' ');

      const richRun = await runPrompt({
        page,
        prompt: richPrompt,
        name: 'rich',
        timeoutMs,
      });
      const outcome: Outcome = {
        fixed: await fetchSavedDashboard(page.request, fixedUid),
        source: await fetchSavedDashboard(page.request, sourceUid),
      };

      const report = formatBenchmarkReport(richRun, { sourceUid, fixedUid }, outcome);
      await testInfo.attach('dashboard-context-benchmark-report.txt', {
        body: report,
        contentType: 'text/plain',
      });
      await testInfo.attach('dashboard-context-benchmark-rich-events.json', {
        body: JSON.stringify(richRun.events, null, 2),
        contentType: 'application/json',
      });
      await writeBenchmarkArtifacts(richRun, report);

      console.log(report);

      if (richRun.timedOut) {
        throw new Error(`Rich dashboard context benchmark timed out after ${timeoutMs}ms.`);
      }

      const finalAssistantError = findFinalAssistantError(richRun.events);
      if (finalAssistantError) {
        throw new Error(`Rich dashboard context benchmark ended with assistant error: ${finalAssistantError}`);
      }

      const qualityError = findRichQualityError(richRun, { sourceUid, fixedUid }, outcome);
      if (qualityError) {
        throw new Error(`Rich dashboard context benchmark failed quality gate: ${qualityError}`);
      }
    } finally {
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(sourceUid)}`).catch(() => undefined);
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(fixedUid)}`).catch(() => undefined);
    }
  });
});

async function seedStaleDashboard(page: Page, uid: string, title: string) {
  const response = await page.request.post('/api/dashboards/db', {
    data: {
      dashboard: {
        uid,
        title,
        tags: ['dashboard-context-benchmark', 'stale'],
        timezone: 'browser',
        schemaVersion: 41,
        time: { from: 'now-6h', to: 'now' },
        templating: {
          list: [
            {
              name: 'route',
              type: 'custom',
              query: '/,/api/orders,/render/report',
              current: { text: '/render/report', value: '/render/report' },
              options: [
                { text: '/', value: '/' },
                { text: '/api/orders', value: '/api/orders' },
                { text: '/render/report', value: '/render/report', selected: true },
              ],
            },
          ],
        },
        panels: [
          {
            id: 1,
            title: 'Request rate by path',
            type: 'timeseries',
            description: 'Intentionally stale: metric and path label no longer match demo Prometheus data.',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            gridPos: { x: 0, y: 0, w: 24, h: 8 },
            fieldConfig: { defaults: { unit: 'bytes' }, overrides: [] },
            targets: [
              {
                refId: 'A',
                datasource: { uid: 'prometheus', type: 'prometheus' },
                expr: 'sum by (path) (rate(http_request_total{job="web",path="$route"}[$__rate_interval]))',
                legendFormat: '{{path}}',
              },
            ],
          },
          {
            id: 2,
            title: 'HTTP error ratio by path',
            type: 'timeseries',
            description: 'Intentionally stale: status_code/path labels are wrong for the demo data.',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            gridPos: { x: 0, y: 8, w: 24, h: 8 },
            fieldConfig: { defaults: { unit: 'percentunit' }, overrides: [] },
            targets: [
              {
                refId: 'A',
                datasource: { uid: 'prometheus', type: 'prometheus' },
                expr: 'sum by (vm,path) (rate(http_request_total{job="web",path="$route",status_code=~"5.."}[$__rate_interval])) / clamp_min(sum by (vm,path) (rate(http_request_total{job="web",path="$route"}[$__rate_interval])), 1e-9)',
                legendFormat: '{{vm}} {{path}}',
              },
            ],
          },
          {
            id: 3,
            title: 'p95 latency',
            type: 'timeseries',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            gridPos: { x: 0, y: 16, w: 24, h: 8 },
            fieldConfig: { defaults: { unit: 's' }, overrides: [] },
            targets: [
              {
                refId: 'A',
                datasource: { uid: 'prometheus', type: 'prometheus' },
                expr: 'histogram_quantile(0.95, sum by (le, vm, route) (rate(http_request_duration_seconds_bucket{job="web",route="$route"}[$__rate_interval])))',
                legendFormat: '{{vm}} {{route}}',
              },
            ],
          },
        ],
      },
      overwrite: true,
    },
  });
  expect(response).toBeOK();
}

async function installBenchmarkRecorder(page: Page) {
  await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
    const line = formatLiveEvent(LOG_PREFIX, event);
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
  await page.evaluate(installRecorder);

  await resetBenchmarkEvents(page);
}

async function runPrompt({
  page,
  prompt,
  name,
  timeoutMs,
}: {
  page: Page;
  prompt: string;
  name: BenchmarkRun['name'];
  timeoutMs: number;
}): Promise<BenchmarkRun> {
  await resetBenchmarkEvents(page);
  const composer = page.getByTestId(testIds.chat.composer);
  const send = page.getByTestId(testIds.chat.send);
  await composer.fill(prompt);
  await expect(send).toBeEnabled();

  const promptStartedAt = Date.now();
  await send.click();

  let timedOut = false;
  let benchmarkFinished = false;
  const approvalTask = autoApproveToolConfirmations(page, () => benchmarkFinished);
  try {
    await page.waitForFunction(
      () => {
        const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: Array<{ type: string }> };
        return benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__?.some((event) => event.type === 'agent_end') ?? false;
      },
      undefined,
      { timeout: timeoutMs }
    );
  } catch {
    timedOut = true;
    await page
      .getByRole('button', { name: /Stop/i })
      .click({ timeout: 1000 })
      .catch(() => undefined);
  } finally {
    benchmarkFinished = true;
    await approvalTask;
  }

  const events = await readBenchmarkEvents(page);
  return {
    name,
    prompt,
    events,
    finalAnswer: findFinalAssistantText(events),
    promptStartedAt,
    timeoutMs,
    timedOut,
  };
}

async function resetBenchmarkEvents(page: Page) {
  await page.evaluate(() => {
    const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: unknown[] };
    benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ = [];
  });
}

async function readBenchmarkEvents(page: Page): Promise<BenchmarkEvent[]> {
  return page.evaluate(() => {
    const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: unknown[] };
    return (benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ ?? []) as BenchmarkEvent[];
  });
}

async function autoApproveToolConfirmations(page: Page, isDone: () => boolean) {
  while (!isDone()) {
    try {
      const approve = page.getByTestId(testIds.chat.toolConfirmationApprove);
      if (await approve.isVisible({ timeout: 500 }).catch(() => false)) {
        await approve.click();
        continue;
      }
      await page.waitForTimeout(250);
    } catch {
      if (!isDone()) {
        await page.waitForTimeout(250).catch(() => undefined);
      }
    }
  }
}

function formatBenchmarkReport(run: BenchmarkRun, ids: { sourceUid: string; fixedUid: string }, outcome: Outcome) {
  const toolCalls = summarizeToolCalls(run.events);
  const agentStart = run.events.find((event) => event.type === 'agent_start')?.timestamp ?? run.promptStartedAt;
  const agentEnd = [...run.events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const usage = summarizeUsage(run.events);
  const quality = run.timedOut ? 'not run' : (findRichQualityError(run, ids, outcome) ?? 'passed');
  const lines = [
    '',
    'Dashboard context benchmark report',
    `Source dashboard UID: ${ids.sourceUid}`,
    `Expected output UID: ${ids.fixedUid}`,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3000'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    '',
    'Rich context repair',
    `Prompt: ${run.prompt}`,
    `Status: ${run.timedOut ? 'timed out' : findFinalAssistantError(run.events) ? 'failed' : 'completed'}`,
    `Elapsed: ${formatDuration((agentEnd ?? Date.now()) - agentStart)}`,
    `Time to first tool: ${toolCalls[0] ? formatDuration(toolCalls[0].startedAt - agentStart) : 'none'}`,
    `Tool calls: ${toolCalls.length} (budget ${BUDGET.maxToolCalls})`,
    `Token usage: input=${usage.input}, output=${usage.output}, total=${usage.totalTokens}`,
    `Repaired dashboard: ${outcome.fixed ? `${nonRowPanels(outcome.fixed.dashboard).length} panels` : 'missing'}`,
    `Assistant error: ${findFinalAssistantError(run.events) ?? 'none'}`,
    `Quality: ${quality}`,
    '',
    'Tool call timeline',
    ...formatToolTimeline(run.events),
  ];
  if (outcome.fixed) {
    lines.push(
      '',
      'Repaired dashboard queries',
      ...dashboardExpressions(outcome.fixed.dashboard).map((expr) => `- ${expr}`)
    );
  }

  lines.push('', 'Final answer preview', truncateOneLine(run.finalAnswer, 1600));

  return lines.join('\n');
}

/** The agent inspected the stale source dashboard: typed context, or hydrating/inspecting its working copy. */
function inspectedSourceDashboard(events: BenchmarkEvent[], sourceUid: string) {
  const typed = summarizeToolCalls(events).some(
    (call) => call.name === 'inspect_dashboard_context' && call.status === 'completed' && !call.isError
  );
  const sourcePath = `/grafana/dashboards/${sourceUid}`;
  const read = summarizeToolCalls(events).some(
    (call) => call.name === 'read' && (stringField(getRecord(call.args), 'path') ?? '').startsWith(sourcePath)
  );
  const shell = bashCalls(events).some(
    (call) =>
      call.command.includes(sourceUid) &&
      /\b(grafana\s+fetch|grafana-dashboard\s+inspect|cat|jq|rg|grep)\b/.test(call.command)
  );
  return typed || read || shell;
}

/** Stale queries were recognised: typed context reported failed/zero-series queries, or stale PromQL was run. */
function observedStaleEvidence(events: BenchmarkEvent[]) {
  const typed = summarizeToolCalls(events).some((call) => {
    if (call.name !== 'inspect_dashboard_context') {
      return false;
    }
    const validation = getRecord(getRecord(getRecord(call.result)?.details)?.validation);
    return numericField(validation, 'failedQueries') > 0 || numericField(validation, 'zeroSeriesQueries') > 0;
  });
  return typed || promEvidenceText(events).includes('http_request_total');
}

function findRichQualityError(run: BenchmarkRun, ids: { sourceUid: string; fixedUid: string }, outcome: Outcome) {
  if (!inspectedSourceDashboard(run.events, ids.sourceUid)) {
    return `agent never inspected source dashboard ${ids.sourceUid}`;
  }
  if (!observedStaleEvidence(run.events)) {
    return 'agent did not gather evidence that the stale queries fail or return no series';
  }
  if (!hasSuccessfulPromEvidence(run.events)) {
    return 'agent did not validate replacement PromQL with grafana-prom query';
  }
  if (!promEvidenceText(run.events).includes('http_requests_total')) {
    return 'agent did not validate the corrected http_requests_total metric';
  }
  if (!appliedDashboardUids(run.events).includes(ids.fixedUid)) {
    return `workspace apply did not report ${ids.fixedUid} as applied`;
  }
  if (!outcome.fixed) {
    return `repaired dashboard ${ids.fixedUid} does not exist in Grafana`;
  }

  const panels = nonRowPanels(outcome.fixed.dashboard);
  if (panels.length < 3) {
    return `expected at least 3 repaired panels, got ${panels.length}`;
  }
  const expressions = dashboardExpressions(outcome.fixed.dashboard).join('\n');
  if (expressions.includes('http_request_total')) {
    return 'repaired dashboard still references stale http_request_total metric';
  }
  if (/\bpath\s*=|status_code/.test(expressions)) {
    return 'repaired dashboard still references stale path/status_code labels';
  }
  if (
    !expressions.includes('http_requests_total') ||
    !expressions.includes('route') ||
    !expressions.includes('status')
  ) {
    return 'repaired dashboard does not include corrected HTTP request metric and labels';
  }
  if (!expressions.includes('http_request_duration_seconds_bucket') || !expressions.includes('histogram_quantile')) {
    return 'repaired dashboard does not include p95 latency histogram query';
  }

  const sourceExpressions = outcome.source ? dashboardExpressions(outcome.source.dashboard).join('\n') : '';
  if (!sourceExpressions.includes('http_request_total')) {
    return `original dashboard ${ids.sourceUid} was changed or removed`;
  }

  return findBudgetError(run.events, BUDGET);
}

async function writeBenchmarkArtifacts(run: BenchmarkRun, report: string) {
  const runSuffix = process.env.BENCH_RUN_INDEX ? `-run-${process.env.BENCH_RUN_INDEX}` : '';
  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'latest-report.txt'), report),
    writeFile(path.join(OUTPUT_DIR, 'latest-rich-events.json'), JSON.stringify(run.events, null, 2)),
    writeFile(path.join(OUTPUT_DIR, 'latest-rich-answer.md'), run.finalAnswer),
    writeFile(path.join(OUTPUT_DIR, `report${runSuffix}.txt`), report),
    writeFile(path.join(OUTPUT_DIR, `rich-events${runSuffix}.json`), JSON.stringify(run.events, null, 2)),
  ]);
}
