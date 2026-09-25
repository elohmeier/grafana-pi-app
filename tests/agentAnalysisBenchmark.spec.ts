import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import type { Page } from '@playwright/test';
import {
  dashboardWriteAttempts,
  findBudgetError,
  findFinalAssistantError,
  findFinalAssistantText,
  formatDuration,
  formatLiveEvent,
  formatToolTimeline,
  hasSuccessfulPromEvidence,
  readPositiveInteger,
  stagedGrafanaPaths,
  summarizeToolCalls,
  summarizeUsage,
  type BenchmarkEvent,
} from './benchmarkOutcomes';

import { workloadBudgets, workloadPrompts } from '../scripts/benchmarks/workloads.mjs';

const BENCHMARK_PROMPT = workloadPrompts['analysis'];
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TOOL_CALLS = workloadBudgets['analysis'].maxToolCalls;

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 60_000));

test.describe('agent analysis benchmark', () => {
  test('analyzes the demo Prometheus incident without writing dashboards', async ({ gotoPage, page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

    await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
      const line = formatLiveEvent('analysis-benchmark', event);
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
    await testInfo.attach('agent-analysis-benchmark-events.json', {
      body: JSON.stringify(events, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('agent-analysis-benchmark-answer.md', {
      body: finalAnswer,
      contentType: 'text/markdown',
    });

    const report = formatBenchmarkReport(events, { promptStartedAt, timeoutMs, timedOut, finalAnswer });
    await testInfo.attach('agent-analysis-benchmark-report.txt', {
      body: report,
      contentType: 'text/plain',
    });
    await writeBenchmarkArtifacts(events, report, finalAnswer);

    console.log(report);

    if (timedOut) {
      throw new Error(`Agent analysis benchmark timed out after ${timeoutMs}ms.`);
    }

    const finalAssistantError = findFinalAssistantError(events);
    if (finalAssistantError) {
      throw new Error(`Agent analysis benchmark ended with assistant error: ${finalAssistantError}`);
    }

    const qualityError = findAnalysisQualityError(events);
    if (qualityError) {
      throw new Error(`Agent analysis benchmark failed quality gate: ${qualityError}`);
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
  throw new Error(`Agent analysis benchmark timed out after ${timeoutMs}ms.`);
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
  const qualityError = options.timedOut ? undefined : findAnalysisQualityError(events);
  const lines = [
    '',
    'Agent analysis benchmark report',
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
  const outputDir = path.join(process.cwd(), 'test-results', 'analysis-benchmark');
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
 * Outcome gate: the agent gathered successful PromQL evidence, stayed read-only,
 * stayed within the tool budget, and the final answer names the incident facts.
 */
function findAnalysisQualityError(events: BenchmarkEvent[]) {
  const budgetError = findBudgetError(events, {
    maxToolCalls: readPositiveInteger(process.env.BENCH_ANALYSIS_MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS),
    maxTotalTokens: readOptionalPositiveInteger(process.env.BENCH_ANALYSIS_MAX_TOKENS),
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

  if (!hasSuccessfulPromEvidence(events)) {
    return 'no successful `grafana-prom query` evidence was found';
  }

  const answer = findFinalAssistantText(events);
  if (!answer.trim()) {
    return 'final assistant answer is empty';
  }

  const expectations = [
    { label: 'affected host vm-web-01', pattern: /\bvm-web-01\b/i },
    { label: 'route /render/report', pattern: /\/render\/report/i },
    { label: 'HTTP 500 or 5xx status', pattern: /(500|5xx|5\.\.|status=["']?500)/i },
    { label: 'CPU, load, or latency corroboration', pattern: /(cpu|load|latenc|duration|node_load1|node_cpu)/i },
    {
      label: 'validated PromQL or metric names',
      pattern: /(promql|rate\(|histogram_quantile|http_requests_total|node_load1)/i,
    },
  ];
  const missing = expectations.filter((expectation) => !expectation.pattern.test(answer));
  if (missing.length > 0) {
    return `final answer is missing ${missing.map((item) => item.label).join(', ')}`;
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
