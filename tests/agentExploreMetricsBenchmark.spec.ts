import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import type { Page } from '@playwright/test';
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
  isSuccessfulBash,
  readPositiveInteger,
  stagedGrafanaPaths,
  summarizeToolCalls,
  summarizeUsage,
  type BenchmarkEvent,
} from './benchmarkOutcomes';

import { workloadBudgets, workloadPrompts } from '../scripts/benchmarks/workloads.mjs';

const BENCHMARK_PROMPT = workloadPrompts['explore-metrics'];
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOOL_CALLS = workloadBudgets['explore-metrics'].maxToolCalls;

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 60_000));

test.describe('agent explore metrics benchmark', () => {
  test('discovers and validates demo Prometheus metrics without writing dashboards', async ({
    gotoPage,
    page,
  }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

    await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
      const line = formatLiveEvent('explore-metrics-benchmark', event);
      if (line) {
        console.log(line);
      }
    });
    await page.addInitScript(installRecorder);
    await Promise.all(page.frames().map((frame) => frame.evaluate(installRecorder).catch(() => undefined)));

    await gotoPage(`/${ROUTES.Chat}?piAgentBenchmark=1`);
    await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
    await Promise.all(page.frames().map((frame) => frame.evaluate(installRecorder).catch(() => undefined)));

    const composer = page.getByTestId(testIds.chat.composer);
    const send = page.getByTestId(testIds.chat.send);
    await composer.fill(BENCHMARK_PROMPT);
    await expect(send).toBeEnabled();

    const promptStartedAt = Date.now();
    await send.click();

    let timedOut = false;
    try {
      await waitForBenchmarkAgentEnd(page, timeoutMs);
    } catch {
      timedOut = true;
      await page
        .getByRole('button', { name: /Stop/i })
        .click({ timeout: 1000 })
        .catch(() => undefined);
    }

    const events = await readBenchmarkEvents(page);
    const finalAnswer = findFinalAssistantText(events);
    await testInfo.attach('agent-explore-metrics-benchmark-events.json', {
      body: JSON.stringify(events, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('agent-explore-metrics-benchmark-answer.md', {
      body: finalAnswer,
      contentType: 'text/markdown',
    });

    const report = formatBenchmarkReport(events, { promptStartedAt, timeoutMs, timedOut, finalAnswer });
    await testInfo.attach('agent-explore-metrics-benchmark-report.txt', {
      body: report,
      contentType: 'text/plain',
    });
    await writeBenchmarkArtifacts(events, report, finalAnswer);

    console.log(report);

    if (timedOut) {
      throw new Error(`Agent explore metrics benchmark timed out after ${timeoutMs}ms.`);
    }

    const finalAssistantError = findFinalAssistantError(events);
    if (finalAssistantError) {
      throw new Error(`Agent explore metrics benchmark ended with assistant error: ${finalAssistantError}`);
    }

    const qualityError = findExploreMetricsQualityError(events);
    if (qualityError) {
      throw new Error(`Agent explore metrics benchmark failed quality gate: ${qualityError}`);
    }
  });
});

function installRecorder() {
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
}

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
  throw new Error(`Agent explore metrics benchmark timed out after ${timeoutMs}ms.`);
}

function formatBenchmarkReport(
  events: BenchmarkEvent[],
  options: { promptStartedAt: number; timeoutMs: number; timedOut: boolean; finalAnswer: string }
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
  const qualityError = options.timedOut ? undefined : findExploreMetricsQualityError(events);
  const lines = [
    '',
    'Agent explore metrics benchmark report',
    `Prompt: ${BENCHMARK_PROMPT}`,
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
    `Quality gate: ${options.timedOut ? 'not run' : qualityError ? `failed: ${qualityError}` : 'passed'}`,
    `Events: ${events.length}`,
    `Tool calls: ${toolCalls.length}`,
  ];

  if (finalAssistantError) {
    lines.push(`Assistant error: ${finalAssistantError}`);
  }
  if (toolCalls.length > 0) {
    lines.push('', 'Tool call timeline', ...formatToolTimeline(events));
  }
  if (options.finalAnswer.trim()) {
    lines.push('', 'Final answer', truncateReportText(options.finalAnswer, 3000));
  }

  return lines.join('\n');
}

async function writeBenchmarkArtifacts(events: BenchmarkEvent[], report: string, finalAnswer: string) {
  const outputDir = path.join(process.cwd(), 'test-results', 'explore-metrics-benchmark');
  const runSuffix = process.env.BENCH_RUN_INDEX ? `-run-${process.env.BENCH_RUN_INDEX}` : '';
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, 'latest-events.json'), JSON.stringify(events, null, 2)),
    writeFile(path.join(outputDir, 'latest-report.txt'), report),
    writeFile(path.join(outputDir, 'latest-answer.md'), finalAnswer),
    writeFile(path.join(outputDir, `events${runSuffix}.json`), JSON.stringify(events, null, 2)),
    writeFile(path.join(outputDir, `report${runSuffix}.txt`), report),
    writeFile(path.join(outputDir, `answer${runSuffix}.md`), finalAnswer),
  ]);
}

/**
 * Outcome gate: the agent discovered metrics and labels through the Prometheus
 * discovery commands, validated PromQL successfully, stayed read-only and within
 * budget, and the final answer names the exact metrics, labels, and values.
 */
function findExploreMetricsQualityError(events: BenchmarkEvent[]) {
  const budgetError = findBudgetError(events, {
    maxToolCalls: readPositiveInteger(process.env.BENCH_EXPLORE_MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS),
    maxTotalTokens: readOptionalPositiveInteger(process.env.BENCH_EXPLORE_MAX_TOKENS),
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

  const discovery = bashCalls(events).filter(
    (call) => /\bgrafana-prom\s+(metrics|labels|series)\b/.test(call.command) && isSuccessfulBash(call)
  );
  if (discovery.length === 0) {
    return 'no successful `grafana-prom metrics|labels|series` discovery command was found';
  }
  if (!hasSuccessfulPromEvidence(events)) {
    return 'no successful `grafana-prom query` evidence was found';
  }

  const answer = findFinalAssistantText(events);
  if (!answer.trim()) {
    return 'final assistant answer is empty';
  }

  const expectations = [
    { label: 'http_requests_total', pattern: /\bhttp_requests_total\b/i },
    { label: 'http_request_duration_seconds_bucket', pattern: /\bhttp_request_duration_seconds_bucket\b/i },
    { label: 'node_load1', pattern: /\bnode_load1\b/i },
    { label: 'node_cpu_seconds_total', pattern: /\bnode_cpu_seconds_total\b/i },
    { label: 'HTTP route/status/vm labels', pattern: /\broute\b[\s\S]*\bstatus\b[\s\S]*\bvm\b/i },
    { label: 'histogram le label', pattern: /\ble\b/i },
    { label: 'CPU mode label', pattern: /\bmode\b/i },
    { label: 'HTTP 500 status evidence', pattern: /\bstatus\b[\s\S]*(?:"500"|'500'|500|5xx)/i },
    { label: 'validated PromQL', pattern: /rate\(|histogram_quantile|node_load1\{|\bavg by\b/i },
  ];
  const missing = expectations.filter((expectation) => !expectation.pattern.test(answer));
  if (missing.length > 0) {
    return `final answer is missing ${missing.map((item) => item.label).join(', ')}`;
  }

  // Label values may be summarized in the answer; accept them from discovery output too.
  const evidence = `${answer}\n${discovery.map((call) => call.stdout).join('\n')}`;
  if (!/\/api\/orders[\s\S]*\/render\/report|\/render\/report[\s\S]*\/api\/orders/i.test(evidence)) {
    return 'answer and discovery output are missing the demo route values';
  }

  return undefined;
}

function readOptionalPositiveInteger(value: string | undefined) {
  const parsed = value ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function truncateReportText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
