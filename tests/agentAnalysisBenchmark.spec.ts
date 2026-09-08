import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import type { Page } from '@playwright/test';

import { workloadPrompts } from '../scripts/benchmarks/workloads.mjs';

const BENCHMARK_PROMPT = workloadPrompts['analysis'];
const DEFAULT_TIMEOUT_MS = 180_000;
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

test.describe('agent analysis benchmark', () => {
  test('analyzes the demo Prometheus incident without writing dashboards', async ({ gotoPage, page }, testInfo) => {
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

function formatLiveBenchmarkEvent(event: BenchmarkEvent, state: LiveBenchmarkState) {
  if (event.type === 'tool_execution_start' && event.toolCallId && event.toolName) {
    state.toolStarts.set(event.toolCallId, event);
    return `[analysis-benchmark:live] tool_start ${event.toolName} args=${summarizeJson(event.args)}`;
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

    const parts = [`[analysis-benchmark:live] tool_update ${event.toolName}`];
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
    const parts = [`[analysis-benchmark:live] tool_end ${event.toolName} ${status} duration=${duration}`];
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
      return `[analysis-benchmark:live] assistant_error ${truncateOneLine(error, 600)}`;
    }
  }

  if (event.type === 'agent_end') {
    return '[analysis-benchmark:live] agent_end';
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

  if (options.finalAnswer.trim()) {
    lines.push('', 'Final answer', truncateReportText(options.finalAnswer, 3000));
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
      calls.set(event.toolCallId, {
        ...existing,
        status: event.isError ? 'failed' : 'completed',
        endedAt: event.timestamp,
        durationMs,
        isError: event.isError,
        nestedToolCalls: extractNestedToolCalls(event.result) ?? existing.nestedToolCalls,
        errorText: event.isError ? extractResultText(event.result) : undefined,
        resultTextBytes: extractResultText(event.result)?.length,
      });
    }
  }

  return [...calls.values()].sort((left, right) => left.startedAt - right.startedAt);
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

function findAnalysisQualityError(events: BenchmarkEvent[]) {
  const toolCalls = summarizeToolCalls(events);
  const investigationCalls = toolCalls.filter((call) => call.name === 'run_investigation_agent');
  if (investigationCalls.length !== 1) {
    return `expected exactly one top-level run_investigation_agent call, got ${investigationCalls.length}`;
  }

  const unexpectedTopLevelCall = toolCalls.find((call) => call.name !== 'run_investigation_agent');
  if (unexpectedTopLevelCall) {
    return `unexpected top-level tool call: ${unexpectedTopLevelCall.name}`;
  }

  const investigationCall = investigationCalls[0];
  if (investigationCall.status !== 'completed' || investigationCall.isError) {
    return 'run_investigation_agent did not complete successfully';
  }

  const forbidden = findForbiddenToolCall(events);
  if (forbidden) {
    return `read-only benchmark used dashboard write tool: ${forbidden}`;
  }

  if (!hasCompletedPrometheusQuery(events)) {
    return 'no completed query_prometheus evidence was found';
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

function findForbiddenToolCall(events: BenchmarkEvent[]) {
  for (const call of summarizeToolCalls(events)) {
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

function hasCompletedPrometheusQuery(events: BenchmarkEvent[]) {
  for (const call of summarizeToolCalls(events)) {
    if (call.name === 'query_prometheus' && call.status === 'completed' && !call.isError) {
      return true;
    }
    if (call.nestedToolCalls?.some((nested) => nested.name === 'query_prometheus' && nested.status === 'completed')) {
      return true;
    }
  }
  return false;
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
