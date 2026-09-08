import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import type { Page } from '@playwright/test';

import { workloadPrompts } from '../scripts/benchmarks/workloads.mjs';

const BENCHMARK_PROMPT = workloadPrompts['explore-metrics'];
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_EXPLORE_MAX_TOOL_MS = 120_000;
const DEFAULT_EXPLORE_MAX_NESTED_CALLS = 14;
const FORBIDDEN_WRITE_TOOLS = new Set([
  'write_jsonnet',
  'edit_jsonnet',
  'fix_jsonnet',
  'render_dashboard',
  'save_dashboard',
  'upload_dashboard',
  'delete_dashboard',
]);

type BenchmarkEvent = {
  type: string;
  timestamp: number;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: {
    role?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    content?: unknown;
    usage?: unknown;
  };
  messageCount?: number;
};

type ToolCallSummary = {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  args?: unknown;
  isError?: boolean;
  nestedToolCalls?: NestedToolCallSummary[];
  errorText?: string;
  resultText?: string;
  resultTextBytes?: number;
};

type NestedToolCallSummary = {
  name: string;
  status?: string;
  isError?: boolean;
  args?: unknown;
};

type BenchmarkUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

type LiveBenchmarkState = {
  toolStarts: Map<string, BenchmarkEvent>;
  toolUpdates: Map<string, string>;
};

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 60_000));

test.describe('agent query specialist benchmark', () => {
  test('uses run_query_agent to discover demo Prometheus metrics', async ({ gotoPage, page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const liveState: LiveBenchmarkState = {
      toolStarts: new Map(),
      toolUpdates: new Map(),
    };

    await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
      const line = formatLiveBenchmarkEvent(event, liveState);
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
      throw new Error(`Agent run_query_agent benchmark timed out after ${timeoutMs}ms.`);
    }

    const finalAssistantError = findFinalAssistantError(events);
    if (finalAssistantError) {
      throw new Error(`Agent run_query_agent benchmark ended with assistant error: ${finalAssistantError}`);
    }

    const qualityError = findExploreMetricsQualityError(events);
    if (qualityError) {
      throw new Error(`Agent run_query_agent benchmark failed quality gate: ${qualityError}`);
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
  throw new Error(`Agent run_query_agent benchmark timed out after ${timeoutMs}ms.`);
}

function formatLiveBenchmarkEvent(event: BenchmarkEvent, state: LiveBenchmarkState) {
  if (event.type === 'tool_execution_start' && event.toolCallId && event.toolName) {
    state.toolStarts.set(event.toolCallId, event);
    return `[query-benchmark:live] tool_start ${event.toolName} args=${summarizeJson(event.args)}`;
  }

  if (event.type === 'tool_execution_update' && event.toolCallId && event.toolName) {
    const nestedCalls = extractNestedToolCallCount(event.partialResult);
    const resultText = truncateOneLine(extractResultText(event.partialResult) ?? '', 240);
    if (nestedCalls === undefined && !resultText) {
      return undefined;
    }

    const updateKey = `${nestedCalls ?? ''}|${resultText}`;
    if (state.toolUpdates.get(event.toolCallId) === updateKey) {
      return undefined;
    }
    state.toolUpdates.set(event.toolCallId, updateKey);

    const parts = [`[query-benchmark:live] tool_update ${event.toolName}`];
    if (nestedCalls !== undefined) {
      parts.push(`nested=${nestedCalls}`);
    }
    if (resultText) {
      parts.push(`text=${resultText}`);
    }
    return parts.join(' ');
  }

  if (event.type === 'tool_execution_end' && event.toolCallId && event.toolName) {
    const start = state.toolStarts.get(event.toolCallId);
    const duration = start ? formatDuration(event.timestamp - start.timestamp) : 'unknown';
    const status = event.isError ? 'failed' : 'completed';
    const nestedCalls = extractNestedToolCallCount(event.result);
    const resultText = truncateOneLine(extractResultText(event.result) ?? '', event.isError ? 600 : 240);
    const parts = [`[query-benchmark:live] tool_end ${event.toolName} ${status} duration=${duration}`];
    if (nestedCalls !== undefined) {
      parts.push(`nested=${nestedCalls}`);
    }
    if (resultText) {
      parts.push(event.isError ? `error=${resultText}` : `text=${resultText}`);
    }
    return parts.join(' ');
  }

  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const error = event.message.errorMessage;
    if (typeof error === 'string' && error) {
      return `[query-benchmark:live] assistant_error ${truncateOneLine(error, 600)}`;
    }
  }

  if (event.type === 'agent_end') {
    return '[query-benchmark:live] agent_end';
  }

  return undefined;
}

function formatBenchmarkReport(
  events: BenchmarkEvent[],
  options: { promptStartedAt: number; timeoutMs: number; timedOut: boolean; finalAnswer: string }
) {
  const agentStart = events.find((event) => event.type === 'agent_start')?.timestamp ?? options.promptStartedAt;
  const agentEnd = [...events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const elapsedMs = (agentEnd ?? Date.now()) - agentStart;
  const toolCalls = summarizeToolCalls(events);
  const exploreCall = toolCalls.find((call) => call.name === 'run_query_agent');
  const toolWallMs = toolCalls.reduce((total, call) => total + (call.durationMs ?? 0), 0);
  const firstToolStart = toolCalls[0]?.startedAt;
  const assistantTurns = events.filter(
    (event) => event.type === 'message_end' && event.message?.role === 'assistant'
  ).length;
  const messageCount = [...events].reverse().find((event) => typeof event.messageCount === 'number')?.messageCount;
  const usage = summarizeUsage(events);
  const finalAssistantError = findFinalAssistantError(events);
  const qualityError = options.timedOut ? undefined : findExploreMetricsQualityError(events);
  const nestedCalls = exploreCall?.nestedToolCalls ?? [];
  const nestedErrors = nestedCalls.filter((call) => call.isError || call.status === 'failed').length;
  const lines = [
    '',
    'Agent run_query_agent benchmark report',
    `Prompt: ${BENCHMARK_PROMPT}`,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3000'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    `Timeout: ${formatDuration(options.timeoutMs)}`,
    `Query agent max duration: ${formatDuration(readPositiveInteger(process.env.BENCH_EXPLORE_MAX_TOOL_MS, DEFAULT_EXPLORE_MAX_TOOL_MS))}`,
    `Query agent max nested calls: ${readPositiveInteger(process.env.BENCH_EXPLORE_MAX_NESTED_CALLS, DEFAULT_EXPLORE_MAX_NESTED_CALLS)}`,
    `Status: ${options.timedOut ? 'timed out' : finalAssistantError ? 'failed' : 'completed'}`,
    `Elapsed: ${formatDuration(elapsedMs)}`,
    `Time to first tool: ${firstToolStart ? formatDuration(firstToolStart - agentStart) : 'none'}`,
    `Tool wall time: ${formatDuration(toolWallMs)}`,
    `Non-tool time: ${formatDuration(Math.max(0, elapsedMs - toolWallMs))}`,
    `Query agent duration: ${exploreCall?.durationMs === undefined ? 'missing' : formatDuration(exploreCall.durationMs)}`,
    `Query agent nested calls: ${nestedCalls.length}`,
    `Query agent nested errors: ${nestedErrors}`,
    `Query agent nested tools: ${formatToolNameCounts(nestedCalls)}`,
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
    lines.push('', 'Tool call timeline');
    for (const [index, call] of toolCalls.entries()) {
      const parts = [
        `${index + 1}. ${call.name}`,
        call.status,
        call.durationMs === undefined ? 'duration pending' : formatDuration(call.durationMs),
      ];
      if (call.nestedToolCalls?.length) {
        parts.push(`${call.nestedToolCalls.length} nested calls`);
      }
      if (call.resultTextBytes !== undefined) {
        parts.push(`${call.resultTextBytes} result bytes`);
      }
      if (call.isError) {
        parts.push('error');
      }

      lines.push(parts.join(' | '));
      lines.push(`   id=${call.id}`);
      lines.push(`   args=${summarizeJson(call.args)}`);
      if (call.nestedToolCalls?.length) {
        lines.push(`   nested=${call.nestedToolCalls.map(formatNestedToolCall).join(', ')}`);
      }
      if (call.errorText) {
        lines.push(`   error=${call.errorText}`);
      }
    }
  }

  if (exploreCall?.resultText?.trim()) {
    lines.push('', 'Query agent result excerpt', truncateReportText(exploreCall.resultText, 2500));
  }

  if (options.finalAnswer.trim()) {
    lines.push('', 'Final answer', truncateReportText(options.finalAnswer, 2000));
  }

  return lines.join('\n');
}

function summarizeToolCalls(events: BenchmarkEvent[]): ToolCallSummary[] {
  const calls = new Map<string, ToolCallSummary>();

  for (const event of events) {
    if (!event.toolCallId || !event.toolName) {
      continue;
    }

    if (event.type === 'tool_execution_start') {
      calls.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        status: 'running',
        startedAt: event.timestamp,
        args: event.args,
      });
      continue;
    }

    const existing =
      calls.get(event.toolCallId) ??
      ({
        id: event.toolCallId,
        name: event.toolName,
        status: 'running',
        startedAt: event.timestamp,
        args: event.args,
      } satisfies ToolCallSummary);

    if (event.type === 'tool_execution_update') {
      calls.set(event.toolCallId, {
        ...existing,
        args: event.args ?? existing.args,
        nestedToolCalls: extractNestedToolCalls(event.partialResult) ?? existing.nestedToolCalls,
      });
      continue;
    }

    if (event.type === 'tool_execution_end') {
      const durationMs = event.timestamp - existing.startedAt;
      const resultText = extractResultText(event.result);
      calls.set(event.toolCallId, {
        ...existing,
        status: event.isError ? 'failed' : 'completed',
        endedAt: event.timestamp,
        durationMs,
        isError: event.isError,
        nestedToolCalls: extractNestedToolCalls(event.result) ?? existing.nestedToolCalls,
        errorText: event.isError ? resultText : undefined,
        resultText,
        resultTextBytes: resultText?.length,
      });
    }
  }

  return [...calls.values()].sort((left, right) => left.startedAt - right.startedAt);
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

function findExploreMetricsQualityError(events: BenchmarkEvent[]) {
  const toolCalls = summarizeToolCalls(events);
  const exploreCalls = toolCalls.filter((call) => call.name === 'run_query_agent');
  if (exploreCalls.length !== 1) {
    return `expected exactly one top-level run_query_agent call, got ${exploreCalls.length}`;
  }

  const unexpectedTopLevelCall = toolCalls.find((call) => call.name !== 'run_query_agent');
  if (unexpectedTopLevelCall) {
    return `unexpected top-level tool call: ${unexpectedTopLevelCall.name}`;
  }

  const exploreCall = exploreCalls[0];
  if (exploreCall.status !== 'completed' || exploreCall.isError) {
    return 'run_query_agent did not complete successfully';
  }

  const maxToolMs = readPositiveInteger(process.env.BENCH_EXPLORE_MAX_TOOL_MS, DEFAULT_EXPLORE_MAX_TOOL_MS);
  if ((exploreCall.durationMs ?? Number.POSITIVE_INFINITY) > maxToolMs) {
    return `run_query_agent exceeded ${formatDuration(maxToolMs)} duration budget`;
  }

  const nestedCalls = exploreCall.nestedToolCalls ?? [];
  const maxNestedCalls = readPositiveInteger(
    process.env.BENCH_EXPLORE_MAX_NESTED_CALLS,
    DEFAULT_EXPLORE_MAX_NESTED_CALLS
  );
  if (nestedCalls.length === 0) {
    return 'run_query_agent did not report nested tool calls';
  }
  if (nestedCalls.length > maxNestedCalls) {
    return `run_query_agent used ${nestedCalls.length} nested calls, over budget ${maxNestedCalls}`;
  }

  const nestedError = nestedCalls.find((call) => call.isError || call.status === 'failed');
  if (nestedError) {
    return `nested tool call failed: ${nestedError.name}`;
  }

  const nestedNames = new Set(nestedCalls.map((call) => call.name));
  for (const required of ['list_metrics', 'inspect_metric_series', 'query_prometheus']) {
    if (!nestedNames.has(required)) {
      return `run_query_agent did not use nested ${required}`;
    }
  }

  const forbidden = findForbiddenToolCall(toolCalls);
  if (forbidden) {
    return `read-only benchmark used dashboard write tool: ${forbidden}`;
  }

  const evidenceText = `${exploreCall.resultText ?? ''}\n${findFinalAssistantText(events)}`;
  const expectations = [
    { label: 'http_requests_total', pattern: /\bhttp_requests_total\b/i },
    { label: 'http_request_duration_seconds_bucket', pattern: /\bhttp_request_duration_seconds_bucket\b/i },
    { label: 'node_load1', pattern: /\bnode_load1\b/i },
    { label: 'node_cpu_seconds_total', pattern: /\bnode_cpu_seconds_total\b/i },
    { label: 'HTTP route/status/vm labels', pattern: /\broute\b[\s\S]*\bstatus\b[\s\S]*\bvm\b/i },
    { label: 'histogram le label', pattern: /\ble\b/i },
    { label: 'CPU mode label', pattern: /\bmode\b/i },
    {
      label: 'demo route values',
      pattern: /\/api\/orders[\s\S]*\/render\/report|\/render\/report[\s\S]*\/api\/orders/i,
    },
    { label: 'HTTP 500 status evidence', pattern: /\bstatus\b[\s\S]*(?:"500"|'500'|500|5xx)/i },
    { label: 'validated PromQL', pattern: /rate\(|histogram_quantile|node_load1\{|\bavg by\b/i },
  ];
  const missing = expectations.filter((expectation) => !expectation.pattern.test(evidenceText));
  if (missing.length > 0) {
    return `run_query_agent evidence is missing ${missing.map((item) => item.label).join(', ')}`;
  }

  return undefined;
}

function findForbiddenToolCall(toolCalls: ToolCallSummary[]) {
  for (const call of toolCalls) {
    if (FORBIDDEN_WRITE_TOOLS.has(call.name)) {
      return call.name;
    }
    for (const nested of call.nestedToolCalls ?? []) {
      if (FORBIDDEN_WRITE_TOOLS.has(nested.name)) {
        return `${call.name} -> ${nested.name}`;
      }
    }
  }
  return undefined;
}

function findFinalAssistantError(events: BenchmarkEvent[]) {
  const finalAssistantMessage = [...events]
    .reverse()
    .find((event) => event.type === 'message_end' && event.message?.role === 'assistant')?.message;
  return typeof finalAssistantMessage?.errorMessage === 'string' ? finalAssistantMessage.errorMessage : undefined;
}

function findFinalAssistantText(events: BenchmarkEvent[]) {
  const finalAssistantMessage = [...events]
    .reverse()
    .find((event) => event.type === 'message_end' && event.message?.role === 'assistant')?.message;
  return extractContentText(finalAssistantMessage?.content);
}

function extractNestedToolCalls(result: unknown): NestedToolCallSummary[] | undefined {
  const details = getRecord(getRecord(result)?.details);
  const toolCalls = details?.toolCalls;
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }

  return toolCalls.map((call) => {
    const record = getRecord(call);
    return {
      name: stringField(record, 'name') ?? 'unknown',
      status: stringField(record, 'status'),
      isError: booleanField(record, 'isError'),
      args: record?.args,
    };
  });
}

function extractNestedToolCallCount(result: unknown) {
  return extractNestedToolCalls(result)?.length;
}

function extractResultText(result: unknown) {
  const content = getRecord(result)?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  return content
    .map((block) => getRecord(block))
    .filter((block): block is Record<string, unknown> => Boolean(block) && block.type === 'text')
    .map((block) => block.text)
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

function extractContentText(content: unknown) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      const record = getRecord(block);
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function summarizeUsage(events: BenchmarkEvent[]): BenchmarkUsage {
  const total = zeroUsage();
  for (const event of events) {
    if (event.type !== 'message_end' || event.message?.role !== 'assistant') {
      continue;
    }
    const usage = getRecord(event.message.usage);
    if (!usage) {
      continue;
    }
    total.input += numericField(usage, 'input');
    total.output += numericField(usage, 'output');
    total.cacheRead += numericField(usage, 'cacheRead');
    total.cacheWrite += numericField(usage, 'cacheWrite');
    total.totalTokens += numericField(usage, 'totalTokens');
    const cost = usage.cost;
    total.cost += typeof cost === 'number' ? cost : numericField(getRecord(cost), 'total');
  }
  if (total.totalTokens === 0) {
    total.totalTokens = total.input + total.output + total.cacheRead + total.cacheWrite;
  }
  return total;
}

function zeroUsage(): BenchmarkUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function numericField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'boolean' ? value : undefined;
}

function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncateOneLine(value: string, maxLength: number) {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}...` : oneLine;
}

function formatNestedToolCall(call: NestedToolCallSummary) {
  return `${call.name}${call.status ? `:${call.status}` : ''}${call.isError ? ':error' : ''}`;
}

function formatToolNameCounts(calls: NestedToolCallSummary[]) {
  if (calls.length === 0) {
    return 'none';
  }

  const counts = new Map<string, number>();
  for (const call of calls) {
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}=${count}`)
    .join(', ');
}

function summarizeJson(value: unknown) {
  if (value === undefined) {
    return 'undefined';
  }

  const json = JSON.stringify(value);
  if (!json) {
    return String(value);
  }
  return json.length > 500 ? `${json.slice(0, 500)}...` : json;
}

function truncateReportText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
