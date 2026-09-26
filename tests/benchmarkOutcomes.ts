import type { APIRequestContext } from '@playwright/test';

/**
 * Outcome helpers shared by the agent benchmarks. The assistant is a single agent
 * whose main tools are read/write/edit/bash over a session filesystem, so quality
 * gates check observable effects (Grafana resources, PromQL evidence gathered
 * through `grafana-prom query`, final-answer facts, budgets) instead of exact
 * tool routing.
 */

export type BenchmarkEvent = {
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

export type ToolCall = {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  resultText?: string;
};

export type BashCall = ToolCall & {
  command: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
  changes: Array<{ path: string; change: string }>;
  timedOut: boolean;
};

export type PromQueryResult = {
  query?: string;
  totalSeries?: number;
  validationError?: string;
  queryType?: string;
};

export type BenchmarkUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

/** Typed live dashboard tools that change the unsaved browser dashboard. */
export const LIVE_DASHBOARD_WRITE_TOOL_PATTERN =
  /^(rename_live_dashboard_panel|update_live_dashboard_|add_live_dashboard_|move_or_resize_live_dashboard_|apply_live_dashboard_)/;

export function summarizeToolCalls(events: BenchmarkEvent[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const event of events) {
    if (!event.toolCallId || !event.toolName) {
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
      } satisfies ToolCall);
    if (event.type === 'tool_execution_start') {
      calls.set(event.toolCallId, { ...existing, startedAt: event.timestamp, args: event.args ?? existing.args });
    } else if (event.type === 'tool_execution_end') {
      calls.set(event.toolCallId, {
        ...existing,
        status: event.isError ? 'failed' : 'completed',
        endedAt: event.timestamp,
        durationMs: event.timestamp - existing.startedAt,
        isError: event.isError,
        result: event.result,
        resultText: extractResultText(event.result),
      });
    }
  }
  return [...calls.values()].sort((left, right) => left.startedAt - right.startedAt);
}

export function bashCalls(events: BenchmarkEvent[]): BashCall[] {
  return summarizeToolCalls(events)
    .filter((call) => call.name === 'bash')
    .map((call) => {
      const details = getRecord(getRecord(call.result)?.details);
      const command = stringField(details, 'command') ?? stringField(getRecord(call.args), 'command') ?? '';
      const exitCode = details?.exitCode;
      return {
        ...call,
        command,
        exitCode: typeof exitCode === 'number' ? exitCode : undefined,
        stdout: stringField(details, 'stdout') ?? '',
        stderr: stringField(details, 'stderr') ?? '',
        changes: recordsField(details, 'changes').map((change) => ({
          path: stringField(change, 'path') ?? '',
          change: stringField(change, 'change') ?? '',
        })),
        timedOut: details?.timedOut === true,
      };
    });
}

export function isSuccessfulBash(call: BashCall) {
  return call.status === 'completed' && !call.isError && call.exitCode === 0 && !call.timedOut;
}

/** bash calls that ran `grafana-prom query`. */
/** `grafana-dashboard data` calls that reported a panel as empty or failing (exit 1 means a panel errored). */
export function dashboardDataProblemCalls(events: BenchmarkEvent[]) {
  return bashCalls(events).filter(
    (call) =>
      /\bgrafana-dashboard\s+data\b/.test(call.command) &&
      call.status === 'completed' &&
      !call.timedOut &&
      (call.exitCode === 1 || /"status"\s*:\s*"(empty|error)"|^\s*"?(empty|error)"?\s*$/m.test(call.stdout))
  );
}

export function promQueryCalls(events: BenchmarkEvent[]) {
  return bashCalls(events).filter((call) => /\bgrafana-prom\s+query\b/.test(call.command));
}

/**
 * Parses `grafana-prom query` summaries from stdout when the output was not
 * reshaped by a pipe. Returns an empty list when stdout is not the raw JSON.
 */
export function parsePromQueryResults(call: BashCall): PromQueryResult[] {
  const documents: unknown[] = [];
  try {
    documents.push(JSON.parse(call.stdout));
  } catch {
    for (const line of call.stdout.split('\n')) {
      try {
        documents.push(JSON.parse(line));
      } catch {
        // Not JSON; the command output was transformed.
      }
    }
  }
  const results: PromQueryResult[] = [];
  const visit = (value: unknown) => {
    const record = getRecord(value);
    if (!record) {
      return;
    }
    if (Array.isArray(record.results)) {
      record.results.forEach(visit);
      return;
    }
    if (typeof record.query === 'string' || typeof record.totalSeries === 'number') {
      results.push({
        query: stringField(record, 'query'),
        totalSeries: typeof record.totalSeries === 'number' ? record.totalSeries : undefined,
        validationError: stringField(record, 'validationError'),
        queryType: stringField(record, 'queryType'),
      });
    }
  };
  documents.forEach(visit);
  return results;
}

/** At least one PromQL query executed successfully with series (via bash) */
export function hasSuccessfulPromEvidence(events: BenchmarkEvent[]) {
  return promQueryCalls(events).some((call) => {
    if (call.status !== 'completed' || call.isError || call.timedOut) {
      return false;
    }
    const parsed = parsePromQueryResults(call);
    if (parsed.length > 0) {
      return parsed.some((result) => !result.validationError && (result.totalSeries ?? 1) > 0);
    }
    // Output reshaped by a pipe: rely on the exit code (grafana-prom exits 1 on validation errors).
    return call.exitCode === 0 || /"totalSeries"\s*:\s*[1-9]/.test(call.stdout);
  });
}

/** PromQL text used in the grafana-prom query commands, plus parsed query fields. */
export function promEvidenceText(events: BenchmarkEvent[]) {
  return promQueryCalls(events)
    .map((call) => [call.command, ...parsePromQueryResults(call).map((result) => result.query ?? '')].join('\n'))
    .join('\n');
}

export function workspaceApplyCalls(events: BenchmarkEvent[]) {
  return bashCalls(events).filter((call) => /\bworkspace\s+apply\b/.test(call.command));
}

/** UIDs that `workspace apply` reported as applied. */
export function appliedDashboardUids(events: BenchmarkEvent[]) {
  const uids = new Set<string>();
  for (const call of workspaceApplyCalls(events)) {
    const records: unknown[] = [];
    try {
      records.push(JSON.parse(call.stdout));
    } catch {
      for (const match of call.stdout.matchAll(/\{[^{}]*"outcome"\s*:\s*"applied"[^{}]*\}/g)) {
        try {
          records.push({ results: [JSON.parse(match[0])] });
        } catch {
          // Ignore reshaped output.
        }
      }
    }
    for (const record of records) {
      for (const result of recordsField(getRecord(record), 'results')) {
        const uid = stringField(result, 'uid');
        if (uid && result.outcome === 'applied') {
          uids.add(uid);
        }
      }
    }
  }
  return [...uids];
}

/** Durable or live dashboard writes the agent attempted. */
export function dashboardWriteAttempts(events: BenchmarkEvent[]) {
  const live = summarizeToolCalls(events)
    .filter((call) => LIVE_DASHBOARD_WRITE_TOOL_PATTERN.test(call.name))
    .map((call) => call.name);
  const durable = workspaceApplyCalls(events).map((call) => `bash: ${truncateOneLine(call.command, 120)}`);
  return [...live, ...durable];
}

/** Files under /grafana the agent staged (writes via write/edit tools or bash). */
export function stagedGrafanaPaths(events: BenchmarkEvent[]) {
  const paths = new Set<string>();
  for (const call of summarizeToolCalls(events)) {
    if ((call.name === 'write' || call.name === 'edit') && !call.isError) {
      const path = stringField(getRecord(call.args), 'path');
      if (path?.startsWith('/grafana/')) {
        paths.add(path);
      }
    }
  }
  for (const call of bashCalls(events)) {
    for (const change of call.changes) {
      if (change.path.startsWith('/grafana/')) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

export function findFinalAssistantText(events: BenchmarkEvent[]) {
  const message = [...events]
    .reverse()
    .find((event) => event.type === 'message_end' && event.message?.role === 'assistant')?.message;
  return textFromContent(message?.content).trim();
}

export function findFinalAssistantError(events: BenchmarkEvent[]) {
  const message = [...events]
    .reverse()
    .find((event) => event.type === 'message_end' && event.message?.role === 'assistant')?.message;
  if (typeof message?.errorMessage === 'string' && message.errorMessage) {
    return message.errorMessage;
  }
  return message?.stopReason === 'error' || message?.stopReason === 'aborted' || message?.stopReason === 'length'
    ? `assistant stopped: ${String(message.stopReason)}`
    : undefined;
}

export function summarizeUsage(events: BenchmarkEvent[]): BenchmarkUsage {
  const total: BenchmarkUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  for (const event of events) {
    if (event.type !== 'message_end' || event.message?.role !== 'assistant') {
      continue;
    }
    const usage = getRecord(event.message.usage);
    total.input += numericField(usage, 'input');
    total.output += numericField(usage, 'output');
    total.cacheRead += numericField(usage, 'cacheRead');
    total.cacheWrite += numericField(usage, 'cacheWrite');
    total.totalTokens += numericField(usage, 'totalTokens');
  }
  if (total.totalTokens === 0) {
    total.totalTokens = total.input + total.output + total.cacheRead + total.cacheWrite;
  }
  return total;
}

/** Returns an error when tool-call or token budgets are exceeded. Token budgets apply only when usage was reported. */
export function findBudgetError(events: BenchmarkEvent[], budget: { maxToolCalls?: number; maxTotalTokens?: number }) {
  const calls = summarizeToolCalls(events).length;
  if (budget.maxToolCalls !== undefined && calls > budget.maxToolCalls) {
    return `used ${calls} tool calls, budget is ${budget.maxToolCalls}`;
  }
  const usage = summarizeUsage(events);
  if (budget.maxTotalTokens !== undefined && usage.totalTokens > budget.maxTotalTokens) {
    return `used ${usage.totalTokens} tokens, budget is ${budget.maxTotalTokens}`;
  }
  return undefined;
}

export function formatToolTimeline(events: BenchmarkEvent[]) {
  const lines: string[] = [];
  for (const [index, call] of summarizeToolCalls(events).entries()) {
    const parts = [
      `${index + 1}. ${call.name}`,
      call.status,
      call.durationMs === undefined ? 'duration pending' : formatDuration(call.durationMs),
    ];
    if (call.name === 'bash') {
      const details = getRecord(getRecord(call.result)?.details);
      if (typeof details?.exitCode === 'number') {
        parts.push(`exit ${details.exitCode}`);
      }
    }
    if (call.resultText !== undefined) {
      parts.push(`${call.resultText.length} result bytes`);
    }
    lines.push(parts.join(' | '));
    const command = stringField(getRecord(call.args), 'command');
    lines.push(
      `   ${command !== undefined ? `command=${truncateOneLine(command, 500)}` : `args=${summarizeJson(call.args)}`}`
    );
    if (call.isError && call.resultText) {
      lines.push(`   error=${truncateOneLine(call.resultText, 600)}`);
    }
  }
  return lines;
}

/** One-line live progress for a streamed agent event. */
export function formatLiveEvent(prefix: string, event: BenchmarkEvent) {
  if (event.type === 'tool_execution_start' && event.toolName) {
    const command = stringField(getRecord(event.args), 'command');
    return `[${prefix}:live] tool_start ${event.toolName} ${
      command !== undefined ? `command=${truncateOneLine(command, 300)}` : `args=${summarizeJson(event.args)}`
    }`;
  }
  if (event.type === 'tool_execution_end' && event.toolName) {
    const text = truncateOneLine(extractResultText(event.result) ?? '', event.isError ? 600 : 240);
    return `[${prefix}:live] tool_end ${event.toolName} ${event.isError ? 'failed' : 'completed'}${text ? ` text=${text}` : ''}`;
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const error = event.message.errorMessage;
    return typeof error === 'string' && error
      ? `[${prefix}:live] assistant_error ${truncateOneLine(error, 600)}`
      : undefined;
  }
  return event.type === 'agent_end' ? `[${prefix}:live] agent_end` : undefined;
}

// Grafana HTTP API checks run from the test with the admin session.

export type SavedDashboard = {
  dashboard: Record<string, unknown>;
  meta: Record<string, unknown>;
};

export async function fetchSavedDashboard(
  request: APIRequestContext,
  uid: string
): Promise<SavedDashboard | undefined> {
  const response = await request.get(`/api/dashboards/uid/${encodeURIComponent(uid)}`);
  if (!response.ok()) {
    return undefined;
  }
  const body = getRecord(await response.json());
  const dashboard = getRecord(body?.dashboard);
  return dashboard ? { dashboard, meta: getRecord(body?.meta) ?? {} } : undefined;
}

/** All panels including those nested in collapsed rows. */
export function dashboardPanels(dashboard: Record<string, unknown>) {
  const panels: Array<Record<string, unknown>> = [];
  for (const panel of recordsField(dashboard, 'panels')) {
    panels.push(panel);
    panels.push(...recordsField(panel, 'panels'));
  }
  return panels;
}

export function nonRowPanels(dashboard: Record<string, unknown>) {
  return dashboardPanels(dashboard).filter((panel) => panel.type !== 'row');
}

/** Prometheus expressions of all panel targets. */
export function dashboardExpressions(dashboard: Record<string, unknown>) {
  return nonRowPanels(dashboard).flatMap((panel) =>
    recordsField(panel, 'targets')
      .map((target) => stringField(target, 'expr'))
      .filter((expr): expr is string => Boolean(expr))
  );
}

/** Snapshot of Grafana-managed alert rules to prove the agent changed nothing. */
export async function alertRulesFingerprint(request: APIRequestContext) {
  const response = await request.get('/api/v1/provisioning/alert-rules');
  if (!response.ok()) {
    throw new Error(`Cannot list alert rules: HTTP ${response.status()}`);
  }
  const rules = (await response.json()) as unknown;
  return (Array.isArray(rules) ? rules : [])
    .map(getRecord)
    .filter((rule): rule is Record<string, unknown> => Boolean(rule))
    .map((rule) => `${String(rule.uid)}@${String(rule.updated)}:${String(rule.isPaused)}`)
    .sort()
    .join('\n');
}

// Generic helpers.

export function extractResultText(result: unknown) {
  return textFromContent(getRecord(result)?.content) || undefined;
}

export function textFromContent(content: unknown) {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(getRecord)
    .filter((block): block is Record<string, unknown> => Boolean(block) && block?.type === 'text')
    .map((block) => block.text)
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

export function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function stringField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'string' ? value : undefined;
}

export function numericField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function recordsField(record: Record<string, unknown> | undefined, field: string) {
  const value = record?.[field];
  return Array.isArray(value)
    ? value.map(getRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

export function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function formatDuration(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function truncateOneLine(value: string, maxLength: number) {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}...` : oneLine;
}

export function summarizeJson(value: unknown) {
  if (value === undefined) {
    return 'undefined';
  }
  const json = JSON.stringify(value);
  if (!json) {
    return String(value);
  }
  return json.length > 500 ? `${json.slice(0, 500)}...` : json;
}
