import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  bashCalls,
  dashboardWriteAttempts,
  findBudgetError,
  findFinalAssistantError,
  findFinalAssistantText,
  formatDuration,
  formatLiveEvent,
  formatToolTimeline,
  isSuccessfulBash,
  readPositiveInteger,
  stagedGrafanaPaths,
  summarizeToolCalls,
  summarizeUsage,
  type BenchmarkEvent,
} from './benchmarkOutcomes';

import { workloadBudgets, workloadPrompts } from '../scripts/benchmarks/workloads.mjs';

const BENCHMARK_PROMPT = workloadPrompts['log-incident'];
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TOOL_CALLS = workloadBudgets['log-incident'].maxToolCalls;
const SENTINEL = /PI-SENTINEL-[A-Z]+-\d+/i;

type Rollout = { timestamp: string };

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 60_000));

/**
 * Investigates the Elasticsearch fixture of the `logs` Compose profile
 * (docs/restricted-logs.md): the report-renderer timeouts on vm-web-01 after
 * the 3.8.0 rollout. Log messages are restricted, deployment events are not.
 */
test.describe('agent log incident benchmark', () => {
  test('finds the incident and the preceding rollout from restricted logs', async ({ gotoPage, page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const rollout = await findFixtureRollout(page.request);

    await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
      const line = formatLiveEvent('log-incident-benchmark', event);
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
    await testInfo.attach('agent-log-incident-benchmark-events.json', {
      body: JSON.stringify(events, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('agent-log-incident-benchmark-answer.md', {
      body: finalAnswer,
      contentType: 'text/markdown',
    });

    const report = formatBenchmarkReport(events, { promptStartedAt, timeoutMs, timedOut, finalAnswer, rollout });
    await testInfo.attach('agent-log-incident-benchmark-report.txt', {
      body: report,
      contentType: 'text/plain',
    });
    await writeBenchmarkArtifacts(events, report, finalAnswer);

    console.log(report);

    if (timedOut) {
      throw new Error(`Agent log incident benchmark timed out after ${timeoutMs}ms.`);
    }

    const finalAssistantError = findFinalAssistantError(events);
    if (finalAssistantError) {
      throw new Error(`Agent log incident benchmark ended with assistant error: ${finalAssistantError}`);
    }

    const qualityError = findLogIncidentQualityError(events, rollout);
    if (qualityError) {
      throw new Error(`Agent log incident benchmark failed quality gate: ${qualityError}`);
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
  throw new Error(`Agent log incident benchmark timed out after ${timeoutMs}ms.`);
}

function formatBenchmarkReport(
  events: BenchmarkEvent[],
  options: { promptStartedAt: number; timeoutMs: number; timedOut: boolean; finalAnswer: string; rollout: Rollout }
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
  const qualityError = options.timedOut ? undefined : findLogIncidentQualityError(events, options.rollout);
  const lines = [
    '',
    'Agent log incident benchmark report',
    `Prompt: ${BENCHMARK_PROMPT}`,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3001'}`,
    `Fixture rollout (CHG-4711): ${options.rollout.timestamp}`,
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
  const outputDir = path.join(process.cwd(), 'test-results', 'log-incident-benchmark');
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
 * The fixture's CHG-4711 rollout, which precedes the incident. Fails when the
 * fixture is missing or the rollout is older than 45 minutes: the incident must
 * be recent, as the prompt says, and lie inside the fixture's data.
 */
async function findFixtureRollout(request: APIRequestContext): Promise<Rollout> {
  const search = {
    size: 1,
    query: {
      bool: { filter: [{ term: { 'labels.change_id': 'CHG-4711' } }, { range: { '@timestamp': { gte: 'now-45m' } } }] },
    },
    sort: [{ '@timestamp': 'asc' }],
  };
  const response = await request.post('/api/datasources/uid/es-logs/resources/_msearch', {
    headers: { 'Content-Type': 'application/x-ndjson' },
    data: `${JSON.stringify({ index: 'logs-app-prod' })}\n${JSON.stringify(search)}\n`,
  });
  const hit = response.ok() ? (await response.json()).responses?.[0]?.hits?.hits?.[0] : undefined;
  if (!hit?._source?.['@timestamp']) {
    throw new Error(
      'The Elasticsearch log fixture is missing or older than 45 minutes; the prompt asks about failures that started recently. Seed it for the current time with `docker compose --profile logs run --rm -e LOGS_FORCE=1 -e TIMELINE_FILE= elasticsearch-seed` (npm run benchmark:log-incident and benchmark:run do this).'
    );
  }
  return { timestamp: hit._source['@timestamp'] };
}

/**
 * Outcome gate: the agent counted logs with `grafana-logs`, stayed read-only and
 * within budget, no log text reached it, and the answer names the affected
 * service, host, error type, the preceding rollout, and an onset time close to
 * the rollout.
 */
function findLogIncidentQualityError(events: BenchmarkEvent[], rollout: Rollout) {
  const budgetError = findBudgetError(events, {
    maxToolCalls: readPositiveInteger(process.env.BENCH_LOG_INCIDENT_MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS),
    maxTotalTokens: readOptionalPositiveInteger(process.env.BENCH_LOG_INCIDENT_MAX_TOKENS),
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

  const leaked = JSON.stringify(events).match(SENTINEL);
  if (leaked) {
    return `restricted log text reached the assistant: ${leaked[0]}`;
  }

  const counts = bashCalls(events).filter(
    (call) => /\bgrafana-logs\s+count\b/.test(call.command) && isSuccessfulBash(call)
  );
  if (counts.length === 0) {
    return 'no successful `grafana-logs count` was found';
  }

  const answer = findFinalAssistantText(events);
  if (!answer.trim()) {
    return 'final assistant answer is empty';
  }
  const expectations = [
    { label: 'affected service report-renderer', pattern: /report-renderer/i },
    { label: 'affected host vm-web-01', pattern: /vm-web-01/i },
    { label: 'error type ReportRenderTimeout', pattern: /ReportRenderTimeout/i },
    { label: 'preceding rollout (3.8.0 or CHG-4711)', pattern: /3\.8\.0|CHG-4711/i },
  ];
  const missing = expectations.filter((expectation) => !expectation.pattern.test(answer));
  if (missing.length > 0) {
    return `final answer is missing ${missing.map((item) => item.label).join(', ')}`;
  }

  // Errors start about two minutes after the rollout; accept an onset within 15 minutes of it.
  const rolloutMinute = minuteOfDay(new Date(rollout.timestamp));
  const times = [...answer.matchAll(/\b([01]\d|2[0-3]):([0-5]\d)\b/g)].map(
    (match) => Number(match[1]) * 60 + Number(match[2])
  );
  if (!times.some((minute) => Math.abs(circularMinutes(minute - rolloutMinute)) <= 15)) {
    return `final answer has no onset time (HH:MM UTC) within 15 minutes of the rollout at ${rollout.timestamp}`;
  }

  return undefined;
}

function minuteOfDay(date: Date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function circularMinutes(delta: number) {
  return ((((delta + 720) % 1440) + 1440) % 1440) - 720;
}

function readOptionalPositiveInteger(value: string | undefined) {
  const parsed = value ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function truncateReportText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
