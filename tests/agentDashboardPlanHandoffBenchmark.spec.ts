import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
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
  nonRowPanels,
  promQueryCalls,
  readPositiveInteger,
  stringField,
  summarizeToolCalls,
  summarizeUsage,
  truncateOneLine,
  workspaceApplyCalls,
  type BenchmarkEvent,
  type SavedDashboard,
} from './benchmarkOutcomes';

const DEFAULT_TIMEOUT_MS = 420_000;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'dashboard-plan-handoff-benchmark');
const LOG_PREFIX = 'dashboard-plan-handoff-benchmark';
const DATASOURCE_UID = 'thanos-prod-db';
const NAMESPACE = 'thanos-prod';
const CLUSTER_SELECTOR = 'cluster="openshift-obs-it-prod"';
const PLAN_PATH = '/session/plan.md';
const REQUIRED_VALID_METRICS = [
  'prometheus_tsdb_storage_blocks_bytes',
  'prometheus_tsdb_wal_storage_size_bytes',
  'thanos_receive_write_samples_sum',
];
const BUDGET = { maxToolCalls: 40 };

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

test.describe('dashboard plan handoff benchmark', () => {
  test('records a dashboard plan before building a dashboard from validated evidence', async ({
    gotoPage,
    page,
  }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const dashboardUid = `plan-handoff-${suffix}`;
    const dashboardTitle = `Dashboard Plan Handoff Benchmark ${suffix}`;

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
      await installBenchmarkRecorder(page);

      const prompt = [
        `Create and save a dashboard titled "${dashboardTitle}" with UID "${dashboardUid}" that shows Thanos storage per tenant, using datasource UID ${DATASOURCE_UID}.`,
        `Before building it, write a short plan to ${PLAN_PATH} listing the candidate queries, whether each returned data, and the panels you will build from the ones that did.`,
        'Candidate queries to check:',
        `1. sum by (tenant) (prometheus_tsdb_storage_blocks_bytes{namespace="${NAMESPACE}"})`,
        `2. sum by (tenant) (prometheus_tsdb_wal_storage_size_bytes{namespace="${NAMESPACE}"})`,
        `3. sum by (tenant) (thanos_receive_write_samples_sum{namespace="${NAMESPACE}"})`,
        `4. sum by (tenant) (prometheus_tsdb_storage_blocks_bytes{${CLUSTER_SELECTOR}, namespace="${NAMESPACE}"})`,
        'Only use queries that return data in the dashboard; leave out any that fail or return no series.',
      ].join('\n');

      const run = await runPrompt({ page, prompt, timeoutMs });
      const saved = await fetchSavedDashboard(page.request, dashboardUid);
      const report = formatBenchmarkReport(run, dashboardUid, saved);

      await testInfo.attach('dashboard-plan-handoff-benchmark-report.txt', {
        body: report,
        contentType: 'text/plain',
      });
      await testInfo.attach('dashboard-plan-handoff-benchmark-events.json', {
        body: JSON.stringify(run.events, null, 2),
        contentType: 'application/json',
      });
      await writeBenchmarkArtifacts(run, report);

      console.log(report);

      if (run.timedOut) {
        throw new Error(`Dashboard plan handoff benchmark timed out after ${timeoutMs}ms.`);
      }

      const finalAssistantError = findFinalAssistantError(run.events);
      if (finalAssistantError) {
        throw new Error(`Dashboard plan handoff benchmark ended with assistant error: ${finalAssistantError}`);
      }

      const qualityError = findDashboardPlanHandoffQualityError(run, dashboardUid, saved);
      if (qualityError) {
        throw new Error(`Dashboard plan handoff benchmark failed quality gate: ${qualityError}`);
      }
    } finally {
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(dashboardUid)}`).catch(() => undefined);
    }
  });
});

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
    return (benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ ?? []) as BenchmarkEvent[];
  });
  return {
    prompt,
    events,
    finalAnswer: findFinalAssistantText(events),
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

/** Earliest timestamp at which the plan file was written (write/edit tool or bash file change). */
function planWrittenAt(events: BenchmarkEvent[]) {
  const times: number[] = [];
  for (const call of summarizeToolCalls(events)) {
    if ((call.name === 'write' || call.name === 'edit') && !call.isError && call.status === 'completed') {
      if (stringField(getRecord(call.args), 'path') === PLAN_PATH) {
        times.push(call.startedAt);
      }
    }
  }
  for (const call of bashCalls(events)) {
    if (call.changes.some((change) => change.path === PLAN_PATH)) {
      times.push(call.startedAt);
    }
  }
  return times.length ? Math.min(...times) : undefined;
}

/** Earliest timestamp at which the dashboard working copy was staged. */
function dashboardStagedAt(events: BenchmarkEvent[], dashboardUid: string) {
  const dashboardPath = `/grafana/dashboards/${dashboardUid}/dashboard.json`;
  const times: number[] = [];
  for (const call of summarizeToolCalls(events)) {
    if ((call.name === 'write' || call.name === 'edit') && !call.isError) {
      if (stringField(getRecord(call.args), 'path') === dashboardPath) {
        times.push(call.startedAt);
      }
    }
  }
  for (const call of bashCalls(events)) {
    if (call.changes.some((change) => change.path === dashboardPath)) {
      times.push(call.startedAt);
    }
  }
  return times.length ? Math.min(...times) : undefined;
}

function findDashboardPlanHandoffQualityError(run: BenchmarkRun, dashboardUid: string, saved?: SavedDashboard) {
  const planAt = planWrittenAt(run.events);
  if (planAt === undefined) {
    return `agent never wrote a plan to ${PLAN_PATH}`;
  }
  const stagedAt = dashboardStagedAt(run.events, dashboardUid);
  if (stagedAt !== undefined && stagedAt < planAt) {
    return `dashboard working copy was staged before ${PLAN_PATH} was written`;
  }

  const applies = workspaceApplyCalls(run.events);
  const firstApply = applies[0]?.startedAt;
  const queriesBeforeApply = promQueryCalls(run.events).filter(
    (call) => firstApply === undefined || call.startedAt < firstApply
  );
  if (!queriesBeforeApply.length) {
    return 'no grafana-prom query evidence was gathered before workspace apply';
  }
  const queriedText = queriesBeforeApply.map((call) => call.command).join('\n');
  for (const metric of REQUIRED_VALID_METRICS) {
    if (!queriedText.includes(metric)) {
      return `candidate metric ${metric} was never validated with grafana-prom query`;
    }
  }

  if (!appliedDashboardUids(run.events).includes(dashboardUid)) {
    return `workspace apply did not report ${dashboardUid} as applied`;
  }
  if (!saved) {
    return `dashboard ${dashboardUid} does not exist in Grafana`;
  }

  const panels = nonRowPanels(saved.dashboard);
  if (panels.length < 3) {
    return `expected at least 3 non-row panels, got ${panels.length}`;
  }
  const expressions = dashboardExpressions(saved.dashboard).join('\n');
  if (expressions.includes(CLUSTER_SELECTOR) || expressions.includes('openshift-obs-it-prod')) {
    return `saved dashboard still contains over-scoped selector ${CLUSTER_SELECTOR}`;
  }
  for (const metric of REQUIRED_VALID_METRICS) {
    if (!expressions.includes(metric)) {
      return `saved dashboard does not include required metric ${metric}`;
    }
  }
  if (!JSON.stringify(saved.dashboard).includes(DATASOURCE_UID)) {
    return `saved dashboard does not reference datasource ${DATASOURCE_UID}`;
  }

  return findBudgetError(run.events, BUDGET);
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

function formatBenchmarkReport(run: BenchmarkRun, dashboardUid: string, saved?: SavedDashboard) {
  const toolCalls = summarizeToolCalls(run.events);
  const agentStart = run.events.find((event) => event.type === 'agent_start')?.timestamp ?? run.promptStartedAt;
  const agentEnd = [...run.events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const usage = summarizeUsage(run.events);
  const quality = run.timedOut
    ? 'not run'
    : (findDashboardPlanHandoffQualityError(run, dashboardUid, saved) ?? 'passed');
  const lines = [
    '',
    'Dashboard plan handoff benchmark report',
    `Dashboard UID: ${dashboardUid}`,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3000'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    '',
    `Status: ${run.timedOut ? 'timed out' : findFinalAssistantError(run.events) ? 'failed' : 'completed'}`,
    `Elapsed: ${formatDuration((agentEnd ?? Date.now()) - agentStart)}`,
    `Time to first tool: ${toolCalls[0] ? formatDuration(toolCalls[0].startedAt - agentStart) : 'none'}`,
    `Tool calls: ${toolCalls.length} (budget ${BUDGET.maxToolCalls})`,
    `Token usage: input=${usage.input}, output=${usage.output}, total=${usage.totalTokens}`,
    `Saved dashboard: ${saved ? `${nonRowPanels(saved.dashboard).length} panels` : 'missing'}`,
    `Assistant error: ${findFinalAssistantError(run.events) ?? 'none'}`,
    `Quality: ${quality}`,
    '',
    'Tool call timeline',
    ...formatToolTimeline(run.events),
  ];
  if (saved) {
    lines.push('', 'Saved dashboard queries', ...dashboardExpressions(saved.dashboard).map((expr) => `- ${expr}`));
  }
  lines.push('', 'Final answer preview', truncateOneLine(run.finalAnswer, 1200));
  return lines.join('\n');
}
