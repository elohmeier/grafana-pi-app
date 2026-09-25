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
  getRecord,
  hasSuccessfulPromEvidence,
  promQueryCalls,
  readPositiveInteger,
  stringField,
  summarizeToolCalls,
  summarizeUsage,
  type BenchmarkEvent,
} from './benchmarkOutcomes';

const QUERIES = [
  'sum by (vm, route) (increase(http_requests_total{status="500"}[6h]))',
  'sum by (vm) (increase(http_requests_total{status="500"}[6h]))',
  'topk(6, sum by (vm, route) (rate(http_requests_total{status="500"}[5m])))',
  'histogram_quantile(0.95, sum by (vm, route, le) (rate(http_request_duration_seconds_bucket[5m])))',
  'histogram_quantile(0.95, sum by (route, le) (rate(http_request_duration_seconds_bucket[5m])))',
  'node_load1{job="node"}',
  'avg_over_time(node_load1{job="node"}[5m])',
  '100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
];
const BENCHMARK_PROMPT = [
  'Run these PromQL queries against the demo Prometheus data for the last 6 hours in one batch:',
  ...QUERIES.map((query, index) => `${index + 1}. ${query}`),
  'The results are stored as artifacts under /artifacts. Extract only the query, validationError, totalSeries, and each series name, labels, and last value from the stored results with jq instead of reading them in full.',
  'Then answer in two short sentences: which vm has the most HTTP 500s, and which route has the highest p95 latency.',
  'Do not create or modify dashboards.',
].join('\n');
const DEFAULT_TIMEOUT_MS = 180_000;
const BUDGET = { maxToolCalls: 12 };

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 60_000));

test.describe('agent artifact jq benchmark', () => {
  test('reads a stored Prometheus artifact with jq', async ({ gotoPage, page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

    await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
      const line = formatLiveEvent('artifact-jq-benchmark', event);
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
    const report = formatBenchmarkReport(events, { promptStartedAt, timeoutMs, timedOut, finalAnswer });
    await testInfo.attach('agent-artifact-jq-benchmark-events.json', {
      body: JSON.stringify(events, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('agent-artifact-jq-benchmark-report.txt', {
      body: report,
      contentType: 'text/plain',
    });
    await testInfo.attach('agent-artifact-jq-benchmark-answer.md', {
      body: finalAnswer,
      contentType: 'text/markdown',
    });
    await writeBenchmarkArtifacts(events, report, finalAnswer);

    console.log(report);

    if (timedOut) {
      throw new Error(`Agent artifact jq benchmark timed out after ${timeoutMs}ms.`);
    }

    const finalAssistantError = findFinalAssistantError(events);
    if (finalAssistantError) {
      throw new Error(`Agent artifact jq benchmark ended with assistant error: ${finalAssistantError}`);
    }

    const qualityError = findArtifactJqQualityError(events);
    if (qualityError) {
      throw new Error(`Agent artifact jq benchmark failed quality gate: ${qualityError}`);
    }
  });
});

async function readBenchmarkEvents(page: Page): Promise<BenchmarkEvent[]> {
  const frameEvents = await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(() => {
          const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: unknown[] };
          return (benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ ?? []) as BenchmarkEvent[];
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
  throw new Error(`Agent artifact jq benchmark timed out after ${timeoutMs}ms.`);
}

function formatBenchmarkReport(
  events: BenchmarkEvent[],
  options: { promptStartedAt: number; timeoutMs: number; timedOut: boolean; finalAnswer: string }
) {
  const agentStart = events.find((event) => event.type === 'agent_start')?.timestamp ?? options.promptStartedAt;
  const agentEnd = [...events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const elapsedMs = (agentEnd ?? Date.now()) - agentStart;
  const toolCalls = summarizeToolCalls(events);
  const usage = summarizeUsage(events);
  const qualityError = options.timedOut ? undefined : findArtifactJqQualityError(events);
  const lines = [
    '',
    'Agent artifact jq benchmark report',
    `Prompt: ${BENCHMARK_PROMPT}`,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3000'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    `Timeout: ${formatDuration(options.timeoutMs)}`,
    `Status: ${options.timedOut ? 'timed out' : qualityError ? 'failed' : 'completed'}`,
    `Elapsed: ${formatDuration(elapsedMs)}`,
    `Token usage: input=${usage.input}, output=${usage.output}, total=${usage.totalTokens}`,
    `Quality gate: ${options.timedOut ? 'not run' : qualityError ? `failed: ${qualityError}` : 'passed'}`,
    `Events: ${events.length}`,
    `Tool calls: ${toolCalls.length} (budget ${BUDGET.maxToolCalls})`,
  ];

  if (toolCalls.length > 0) {
    lines.push('', 'Tool call timeline', ...formatToolTimeline(events));
  }

  if (options.finalAnswer.trim()) {
    lines.push('', 'Final answer', truncateReportText(options.finalAnswer, 1500));
  }

  return lines.join('\n');
}

/**
 * Finds the first projection of a stored query artifact that happened after the query ran:
 * jq/read over /artifacts in bash, the read tool on an /artifacts path, or read_artifact.
 */
function findArtifactProjection(events: BenchmarkEvent[], after: number) {
  const bash = bashCalls(events).find(
    (call) =>
      call.startedAt > after &&
      /\/artifacts\b/.test(call.command) &&
      /\bjq\b/.test(call.command) &&
      call.exitCode === 0 &&
      !call.isError
  );
  if (bash) {
    return { kind: 'bash jq', text: bash.stdout };
  }
  for (const call of summarizeToolCalls(events)) {
    if (call.startedAt <= after || call.status !== 'completed' || call.isError) {
      continue;
    }
    const args = getRecord(call.args);
    if (call.name === 'read_artifact' && (args?.mode === 'jq' || typeof args?.jq === 'string')) {
      return { kind: 'read_artifact jq', text: call.resultText ?? '' };
    }
    if (call.name === 'read' && (stringField(args, 'path') ?? '').startsWith('/artifacts/')) {
      return { kind: 'read', text: call.resultText ?? '' };
    }
  }
  return undefined;
}

function findArtifactJqQualityError(events: BenchmarkEvent[]) {
  if (events.length === 0) {
    return 'benchmark recorder captured no events';
  }

  if (!hasSuccessfulPromEvidence(events)) {
    return 'no successful grafana-prom query ran';
  }
  const firstQuery = promQueryCalls(events)[0];
  const queried = promQueryCalls(events)
    .map((call) => call.command)
    .join('\n');
  if (!queried.includes('http_requests_total') || !queried.includes('http_request_duration_seconds_bucket')) {
    return 'grafana-prom query did not cover the HTTP error and latency queries';
  }

  const projection = findArtifactProjection(events, firstQuery.startedAt);
  if (!projection) {
    return 'stored query results under /artifacts were never projected with jq or read';
  }
  if (!/query/.test(projection.text) || !/totalSeries|validationError|series|last/.test(projection.text)) {
    return `${projection.kind} result did not contain projected artifact fields`;
  }

  const writes = dashboardWriteAttempts(events);
  if (writes.length > 0) {
    return `read-only jq benchmark attempted dashboard writes: ${writes.join(', ')}`;
  }

  const answer = findFinalAssistantText(events);
  if (!/vm-web-01/i.test(answer)) {
    return 'final answer does not name vm-web-01 as the vm with the most HTTP 500s';
  }
  if (!/\/\S+/.test(answer)) {
    return 'final answer does not name a route';
  }

  return findBudgetError(events, BUDGET);
}

async function writeBenchmarkArtifacts(events: BenchmarkEvent[], report: string, finalAnswer: string) {
  const outputDir = path.join(process.cwd(), 'test-results', 'artifact-jq-benchmark');
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

function truncateReportText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
