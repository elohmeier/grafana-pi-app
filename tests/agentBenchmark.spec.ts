import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import type { Page } from '@playwright/test';
import {
  appliedDashboardUids,
  dashboardExpressions,
  fetchSavedDashboard,
  findBudgetError,
  findFinalAssistantError,
  formatDuration,
  formatLiveEvent,
  formatToolTimeline,
  hasSuccessfulPromEvidence,
  nonRowPanels,
  readPositiveInteger,
  summarizeToolCalls,
  summarizeUsage,
  type BenchmarkEvent,
  type SavedDashboard,
} from './benchmarkOutcomes';

const DEFAULT_TIMEOUT_MS = 180_000;
const BUDGET = { maxToolCalls: 30 };

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 60_000));

test.describe('agent benchmark', () => {
  test('creates an HTTP request rate and errors dashboard', async ({ gotoPage, page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const dashboardUid = `http-rate-errors-${Date.now().toString(36)}`;
    const prompt = `Create a dashboard for HTTP request rate and errors with UID "${dashboardUid}"`;

    await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
      const line = formatLiveEvent('agent-benchmark', event);
      if (line) {
        console.log(line);
      }
    });

    const installRecorder = () => {
      const benchmarkWindow = window as typeof window & {
        __PI_AGENT_BENCHMARK_CAPTURE__?: boolean;
        __PI_AGENT_BENCHMARK_EVENTS__?: unknown[];
        __PI_AGENT_BENCHMARK_RECORD_EVENT__?: (event: unknown) => void;
        __PI_AGENT_BENCHMARK_STREAM_EVENT__?: (event: unknown) => Promise<void>;
      };

      benchmarkWindow.__PI_AGENT_BENCHMARK_CAPTURE__ = true;
      benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ = [];
      benchmarkWindow.__PI_AGENT_BENCHMARK_RECORD_EVENT__ = (event: unknown) => {
        benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__?.push(event);
        void benchmarkWindow.__PI_AGENT_BENCHMARK_STREAM_EVENT__?.(event);
      };
    };

    try {
      await page.addInitScript(installRecorder);
      await Promise.all(page.frames().map((frame) => frame.evaluate(installRecorder).catch(() => undefined)));

      await gotoPage(`/${ROUTES.Chat}?piAgentBenchmark=1`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
      await Promise.all(page.frames().map((frame) => frame.evaluate(installRecorder).catch(() => undefined)));

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
        await waitForBenchmarkAgentEnd(page, timeoutMs);
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
      const saved = await fetchSavedDashboard(page.request, dashboardUid);
      await testInfo.attach('agent-benchmark-events.json', {
        body: JSON.stringify(events, null, 2),
        contentType: 'application/json',
      });

      const qualityError = timedOut ? undefined : findDashboardQualityError(events, dashboardUid, saved);
      const report = formatBenchmarkReport(events, {
        prompt,
        dashboardUid,
        promptStartedAt,
        timeoutMs,
        timedOut,
        qualityError,
      });
      await testInfo.attach('agent-benchmark-report.txt', {
        body: report,
        contentType: 'text/plain',
      });
      await writeBenchmarkArtifacts(events, report);

      console.log(report);

      if (timedOut) {
        throw new Error(`Agent benchmark timed out after ${timeoutMs}ms.`);
      }

      const finalAssistantError = findFinalAssistantError(events);
      if (finalAssistantError) {
        throw new Error(`Agent benchmark ended with assistant error: ${finalAssistantError}`);
      }

      if (qualityError) {
        throw new Error(`Agent benchmark failed quality gate: ${qualityError}`);
      }
    } finally {
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(dashboardUid)}`).catch(() => undefined);
    }
  });
});

async function readBenchmarkEvents(page: Page): Promise<BenchmarkEvent[]> {
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

  return frameEvents.flat();
}

async function waitForBenchmarkAgentEnd(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readBenchmarkEvents(page);
    if (events.some((event) => event.type === 'agent_end')) {
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Agent benchmark timed out after ${timeoutMs}ms.`);
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

function findDashboardQualityError(events: BenchmarkEvent[], dashboardUid: string, saved?: SavedDashboard) {
  if (!appliedDashboardUids(events).includes(dashboardUid)) {
    return `workspace apply did not report ${dashboardUid} as applied`;
  }
  if (!saved) {
    return `dashboard ${dashboardUid} does not exist in Grafana after the run`;
  }
  if (!hasSuccessfulPromEvidence(events)) {
    return 'no successful grafana-prom query validation evidence';
  }

  const panelCount = nonRowPanels(saved.dashboard).length;
  if (panelCount < 2) {
    return `expected at least 2 panels, got ${panelCount}`;
  }

  const expressions = dashboardExpressions(saved.dashboard).join('\n').toLowerCase();
  if (!expressions.includes('rate(')) {
    return 'saved dashboard panels do not include a rate() query';
  }
  if (!/error|5\.\.|4\.\.|status/.test(expressions)) {
    return 'saved dashboard panels do not include an error/status signal';
  }

  return findBudgetError(events, BUDGET);
}

function formatBenchmarkReport(
  events: BenchmarkEvent[],
  options: {
    prompt: string;
    dashboardUid: string;
    promptStartedAt: number;
    timeoutMs: number;
    timedOut: boolean;
    qualityError?: string;
  }
) {
  const agentStart = events.find((event) => event.type === 'agent_start')?.timestamp ?? options.promptStartedAt;
  const agentEnd = [...events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const elapsedMs = (agentEnd ?? Date.now()) - agentStart;
  const toolCalls = summarizeToolCalls(events);
  const toolWallMs = toolCalls.reduce((total, call) => total + (call.durationMs ?? 0), 0);
  const firstToolStart = toolCalls[0]?.startedAt;
  const assistantTurns = events.filter(
    (event) => event.type === 'message_end' && event.message?.role === 'assistant'
  ).length;
  const messageCount = [...events].reverse().find((event) => typeof event.messageCount === 'number')?.messageCount;
  const usage = summarizeUsage(events);
  const finalAssistantError = findFinalAssistantError(events);
  const lines = [
    '',
    'Agent benchmark report',
    `Prompt: ${options.prompt}`,
    `Dashboard UID: ${options.dashboardUid}`,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3000'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    `Timeout: ${formatDuration(options.timeoutMs)}`,
    `Status: ${options.timedOut ? 'timed out' : finalAssistantError ? 'failed' : 'completed'}`,
    `Elapsed: ${formatDuration(elapsedMs)}`,
    `Time to first tool: ${firstToolStart ? formatDuration(firstToolStart - agentStart) : 'none'}`,
    `Tool wall time: ${formatDuration(toolWallMs)}`,
    `Non-tool time: ${formatDuration(Math.max(0, elapsedMs - toolWallMs))}`,
    `Assistant turns: ${assistantTurns}`,
    `Messages: ${messageCount ?? 'unknown'}`,
    `Token usage: input=${usage.input}, output=${usage.output}, cacheRead=${usage.cacheRead}, cacheWrite=${usage.cacheWrite}, total=${usage.totalTokens}`,
    `Quality gate: ${options.timedOut ? 'not run' : options.qualityError ? `failed: ${options.qualityError}` : 'passed'}`,
    `Events: ${events.length}`,
    `Tool calls: ${toolCalls.length} (budget ${BUDGET.maxToolCalls})`,
  ];

  if (finalAssistantError) {
    lines.push(`Assistant error: ${finalAssistantError}`);
  }

  if (toolCalls.length > 0) {
    lines.push('', 'Tool call timeline', ...formatToolTimeline(events));
  }

  return lines.join('\n');
}

async function writeBenchmarkArtifacts(events: BenchmarkEvent[], report: string) {
  const outputDir = path.join(process.cwd(), 'test-results', 'agent-benchmark');
  const runSuffix = process.env.BENCH_RUN_INDEX ? `-run-${process.env.BENCH_RUN_INDEX}` : '';
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, 'latest-events.json'), JSON.stringify(events, null, 2)),
    writeFile(path.join(outputDir, 'latest-report.txt'), report),
    writeFile(path.join(outputDir, `events${runSuffix}.json`), JSON.stringify(events, null, 2)),
    writeFile(path.join(outputDir, `report${runSuffix}.txt`), report),
  ]);
}
