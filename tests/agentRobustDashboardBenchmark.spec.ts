import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import {
  appliedDashboardUids,
  dashboardExpressions,
  fetchSavedDashboard,
  findBudgetError,
  findFinalAssistantError,
  findFinalAssistantText,
  formatDuration,
  formatLiveEvent,
  formatToolTimeline,
  nonRowPanels,
  parsePromQueryResults,
  promQueryCalls,
  readPositiveInteger,
  summarizeToolCalls,
  summarizeUsage,
  truncateOneLine,
  workspaceApplyCalls,
  type BashCall,
  type BenchmarkEvent,
  type SavedDashboard,
} from './benchmarkOutcomes';

const DEFAULT_TIMEOUT_MS = 240_000;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'robust-dashboard-benchmark');
const BROKEN_QUERY_CANARY = 'pi_broken_metric_canary';
const BUDGET = { maxToolCalls: 35 };

type BenchmarkRun = {
  prompt: string;
  events: BenchmarkEvent[];
  finalAnswer: string;
  promptStartedAt: number;
  timeoutMs: number;
  timedOut: boolean;
};

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 90_000));

test.describe('robust dashboard benchmark', () => {
  test('excludes failed or zero-series PromQL candidates before rendering and saving', async ({
    gotoPage,
    page,
  }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const dashboardUid = `robust-dash-${suffix}`;
    const dashboardTitle = `Robust Dashboard Benchmark ${suffix}`;

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
      await installBenchmarkRecorder(page);

      const prompt = [
        `Create and save a dashboard titled "${dashboardTitle}" with UID "${dashboardUid}" on the default demo Prometheus datasource, covering the last 6 hours.`,
        'I want panels for request rate by route, HTTP 5xx rate by route, and p95 latency by route.',
        'These are my candidate queries; validate them as range queries over the last 6 hours before building anything:',
        '1. sum by (route) (rate(http_requests_total[5m]))',
        '2. sum by (route) (rate(http_requests_total{status=~"5.."}[5m]))',
        '3. histogram_quantile(0.95, sum by (route, le) (rate(http_request_duration_seconds_bucket[5m])))',
        `4. sum(rate(${BROKEN_QUERY_CANARY}{job="demo"}[5m]))`,
        'Some of these may not work. Leave out any candidate that errors or returns no series, and tell me which ones you excluded.',
      ].join('\n');

      const run = await runPrompt({ page, prompt, timeoutMs });
      const saved = await fetchSavedDashboard(page.request, dashboardUid);
      const qualityError = run.timedOut ? undefined : findRobustDashboardQualityError(run, dashboardUid, saved);
      const report = formatBenchmarkReport(run, dashboardUid, qualityError);

      await testInfo.attach('robust-dashboard-benchmark-report.txt', {
        body: report,
        contentType: 'text/plain',
      });
      await testInfo.attach('robust-dashboard-benchmark-events.json', {
        body: JSON.stringify(run.events, null, 2),
        contentType: 'application/json',
      });
      await writeBenchmarkArtifacts(run, report);

      console.log(report);

      if (run.timedOut) {
        throw new Error(`Robust dashboard benchmark timed out after ${timeoutMs}ms.`);
      }

      const finalAssistantError = findFinalAssistantError(run.events);
      if (finalAssistantError) {
        throw new Error(`Robust dashboard benchmark ended with assistant error: ${finalAssistantError}`);
      }

      if (qualityError) {
        throw new Error(`Robust dashboard benchmark failed quality gate: ${qualityError}`);
      }
    } finally {
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(dashboardUid)}`).catch(() => undefined);
    }
  });
});

async function installBenchmarkRecorder(page: Page) {
  await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
    const line = formatLiveEvent('robust-dashboard-benchmark', event);
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
}

async function runPrompt({
  page,
  prompt,
  timeoutMs,
}: {
  page: Page;
  prompt: string;
  timeoutMs: number;
}): Promise<BenchmarkRun> {
  await page.evaluate(() => {
    const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: unknown[] };
    benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ = [];
  });
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

  const events = await page.evaluate(() => {
    const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: unknown[] };
    return benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ ?? [];
  });
  return {
    prompt,
    events: events as BenchmarkEvent[],
    finalAnswer: findFinalAssistantText(events as BenchmarkEvent[]),
    promptStartedAt,
    timeoutMs,
    timedOut,
  };
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

function findRobustDashboardQualityError(run: BenchmarkRun, dashboardUid: string, saved?: SavedDashboard) {
  const firstApply = workspaceApplyCalls(run.events)[0];
  const validationCalls = promQueryCalls(run.events).filter(
    (call) => !firstApply || call.startedAt < firstApply.startedAt
  );
  const validationError = findQueryValidationQualityError(validationCalls);
  if (validationError) {
    return `before the first workspace apply, ${validationError}`;
  }

  if (!appliedDashboardUids(run.events).includes(dashboardUid)) {
    return `workspace apply did not report ${dashboardUid} as applied`;
  }
  if (!saved) {
    return `dashboard ${dashboardUid} does not exist in Grafana after the run`;
  }

  const panelCount = nonRowPanels(saved.dashboard).length;
  if (panelCount < 3) {
    return `expected at least 3 non-row panels, got ${panelCount}`;
  }

  if (JSON.stringify(saved.dashboard).toLowerCase().includes(BROKEN_QUERY_CANARY)) {
    return `saved dashboard still contains broken canary metric ${BROKEN_QUERY_CANARY}`;
  }

  const expressions = dashboardExpressions(saved.dashboard).join('\n').toLowerCase();
  for (const expected of ['http_requests_total', 'http_request_duration_seconds_bucket']) {
    if (!expressions.includes(expected)) {
      return `saved dashboard does not include expected validated metric ${expected}`;
    }
  }
  if (!/5\.\.|status/.test(expressions)) {
    return 'saved dashboard does not include an HTTP 5xx/status signal';
  }
  if (!expressions.includes('histogram_quantile')) {
    return 'saved dashboard does not include p95 latency query';
  }

  return findBudgetError(run.events, BUDGET);
}

function findQueryValidationQualityError(calls: BashCall[]) {
  if (calls.length === 0) {
    return 'the agent did not validate candidate PromQL with grafana-prom query';
  }

  const canaryCalls = calls.filter((call) => normalizeCommand(call.command).includes(BROKEN_QUERY_CANARY));
  if (canaryCalls.length === 0) {
    return `the agent did not validate the candidate ${BROKEN_QUERY_CANARY} query`;
  }
  if (!canaryCalls.some(isRangeQueryCommand)) {
    return 'candidate validation was not run as a range query (--from/--range)';
  }

  // Parsed summaries are only available when stdout was not reshaped by a pipe.
  const parsed = calls.flatMap((call) => parsePromQueryResults(call));
  const canaryResult = parsed.find((result) => (result.query ?? '').includes(BROKEN_QUERY_CANARY));
  if (canaryResult && !canaryResult.validationError && (canaryResult.totalSeries ?? 0) > 0) {
    return `broken canary ${BROKEN_QUERY_CANARY} unexpectedly returned series`;
  }

  for (const expected of ['http_requests_total', 'http_request_duration_seconds_bucket']) {
    const parsedSuccess = parsed.some(
      (result) => (result.query ?? '').includes(expected) && !result.validationError && (result.totalSeries ?? 0) > 0
    );
    const unparsedSuccess = calls.some(
      (call) =>
        parsePromQueryResults(call).length === 0 &&
        normalizeCommand(call.command).includes(expected) &&
        !call.isError &&
        (call.exitCode === 0 || /"totalSeries"\s*:\s*[1-9]/.test(call.stdout))
    );
    if (!parsedSuccess && !unparsedSuccess) {
      return `grafana-prom query did not validate a successful ${expected} query with data`;
    }
  }

  return undefined;
}

function isRangeQueryCommand(call: BashCall) {
  return /--(from|to|range)\b/.test(call.command);
}

function normalizeCommand(command: string) {
  return command.replace(/\\"/g, '"');
}

function formatBenchmarkReport(run: BenchmarkRun, dashboardUid: string, quality: string | undefined) {
  const agentStart = run.events.find((event) => event.type === 'agent_start')?.timestamp ?? run.promptStartedAt;
  const agentEnd = [...run.events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const toolCalls = summarizeToolCalls(run.events);
  const usage = summarizeUsage(run.events);
  const lines = [
    '',
    'Robust dashboard benchmark report',
    `Dashboard UID: ${dashboardUid}`,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3000'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    '',
    `Prompt: ${run.prompt}`,
    `Status: ${run.timedOut ? 'timed out' : findFinalAssistantError(run.events) ? 'failed' : 'completed'}`,
    `Elapsed: ${formatDuration((agentEnd ?? Date.now()) - agentStart)}`,
    `Time to first tool: ${toolCalls[0] ? formatDuration(toolCalls[0].startedAt - agentStart) : 'none'}`,
    `Tool calls: ${toolCalls.length} (budget ${BUDGET.maxToolCalls})`,
    `Token usage: input=${usage.input}, output=${usage.output}, total=${usage.totalTokens}`,
    `Assistant error: ${findFinalAssistantError(run.events) ?? 'none'}`,
    `Quality: ${run.timedOut ? 'not run' : (quality ?? 'passed')}`,
    '',
    'Tool call timeline',
    ...formatToolTimeline(run.events),
  ];

  lines.push('', 'Final answer preview', truncateOneLine(run.finalAnswer, 1600));
  return lines.join('\n');
}

async function writeBenchmarkArtifacts(run: BenchmarkRun, report: string) {
  const runSuffix = process.env.BENCH_RUN_INDEX ? `-run-${process.env.BENCH_RUN_INDEX}` : '';
  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'latest-report.txt'), report),
    writeFile(path.join(OUTPUT_DIR, 'latest-events.json'), JSON.stringify(run.events, null, 2)),
    writeFile(path.join(OUTPUT_DIR, 'latest-answer.md'), run.finalAnswer),
    writeFile(path.join(OUTPUT_DIR, `report${runSuffix}.txt`), report),
    writeFile(path.join(OUTPUT_DIR, `events${runSuffix}.json`), JSON.stringify(run.events, null, 2)),
  ]);
}
