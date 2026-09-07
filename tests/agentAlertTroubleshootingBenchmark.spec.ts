import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { testIds } from '../src/components/testIds';

const DEFAULT_TIMEOUT_MS = 240_000;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'alert-troubleshooting-benchmark');
const FORBIDDEN_WRITE_TOOLS = new Set([
  'write_jsonnet',
  'edit_jsonnet',
  'fix_jsonnet',
  'render_dashboard',
  'save_dashboard',
  'upload_dashboard',
  'delete_dashboard',
  'apply_live_dashboard_mutation',
  'rename_live_dashboard_panel',
  'update_live_dashboard_panel_query',
  'add_live_dashboard_panel',
  'move_or_resize_live_dashboard_panel',
  'update_live_dashboard_settings',
  'add_live_dashboard_variable',
  'update_live_dashboard_variable',
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
    errorMessage?: unknown;
    content?: unknown;
  };
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
  resultText?: string;
  errorText?: string;
};

type NestedToolCallSummary = {
  name: string;
  status?: string;
  isError?: boolean;
  args?: unknown;
};

type LiveBenchmarkState = {
  toolStarts: Map<string, BenchmarkEvent>;
  toolUpdates: Map<string, string>;
};

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 90_000));

test.describe('alert troubleshooting benchmark', () => {
  test('troubleshoots a panel-linked alert rule read-only from the assistant sidebar', async ({ page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const namespace = await readGrafanaNamespace(page);
    const folderUid = `alert-bench-${suffix}`;
    const dashboardUid = `alert-panel-${suffix}`;
    const ruleName = `alert-panel-${suffix}`;
    const dashboardTitle = `Alert Troubleshooting ${suffix}`;
    const panelTitle = `5xx rate panel ${suffix}`;
    const ruleTitle = `High 5xx alert ${suffix}`;

    await seedFolder(page, folderUid, `Alert Benchmark ${suffix}`);
    await seedDashboard(page, { uid: dashboardUid, title: dashboardTitle, panelTitle, folderUid });
    await seedAlertRule(page, { namespace, folderUid, dashboardUid, ruleName, ruleTitle });

    try {
      await expect
        .poll(async () => {
          const response = await page.request.get(
            `/apis/rules.alerting.grafana.app/v0alpha1/namespaces/${namespace}/alertrules/${ruleName}`
          );
          return response.ok();
        })
        .toBe(true);

      await page.goto(`/d/${dashboardUid}/alert-troubleshooting?orgId=1&viewPanel=1&from=now-1h&to=now`);
      await expect(page.getByText(panelTitle)).toBeVisible();
      const streamedEvents = await installBenchmarkRecorder(page);
      await openAssistantSidebar(page, dashboardUid);
      await expect(page.getByTestId(testIds.chat.composer)).toBeVisible();

      const prompt = [
        'This benchmark validates read-only alert troubleshooting for a dashboard panel.',
        'Use exactly one top-level run_alert_agent call.',
        'Do not call find_panel_alert_rules, get_alert_rule, inspect_dashboard_context, query_prometheus, or dashboard tools directly at top level.',
        `Call run_alert_agent with dashboardUid "${dashboardUid}", panelId "1", and this task:`,
        `"Find the alert rule linked to dashboard UID ${dashboardUid} panel ID 1. Use namespace ${namespace}. Call find_panel_alert_rules, inspect_dashboard_context, and query_prometheus for the alert rule prometheusChecks. Compare the panel visual threshold with the alert threshold and explain why the panel can look below warning while the alert can still fire. Mention the rule title ${ruleTitle}, the query metric http_requests_total, the alert threshold, and the panel threshold. Do not edit alerts or dashboards."`,
        'After the alert agent returns, do not call more tools.',
        'Answer with a concise explanation and end with ALERT_TROUBLESHOOTING_DONE.',
      ].join(' ');

      const promptStartedAt = Date.now();
      const composer = page.getByTestId(testIds.chat.composer);
      const send = page.getByTestId(testIds.chat.send);
      await composer.fill(prompt);
      await expect(send).toBeEnabled();
      await send.click();

      const completion = await waitForBenchmarkCompletion(page, streamedEvents, timeoutMs);
      const events = await readBenchmarkEvents(page, streamedEvents);
      const finalAnswer = findFinalAssistantText(events);
      const report = formatBenchmarkReport(events, {
        dashboardUid,
        ruleName,
        ruleTitle,
        promptStartedAt,
        timeoutMs,
        timedOut: completion.timedOut,
        completedBy: completion.completedBy,
        finalAnswer,
      });
      await testInfo.attach('alert-troubleshooting-benchmark-report.txt', {
        body: report,
        contentType: 'text/plain',
      });
      await testInfo.attach('alert-troubleshooting-benchmark-events.json', {
        body: JSON.stringify(events, null, 2),
        contentType: 'application/json',
      });
      await writeBenchmarkArtifacts(events, report, finalAnswer);
      console.log(report);

      if (completion.timedOut) {
        throw new Error(`Alert troubleshooting benchmark timed out after ${timeoutMs}ms.`);
      }

      const finalAssistantError = findFinalAssistantError(events);
      if (finalAssistantError) {
        throw new Error(`Alert troubleshooting benchmark ended with assistant error: ${finalAssistantError}`);
      }

      const qualityError = findQualityError(events, finalAnswer, ruleTitle);
      if (qualityError) {
        throw new Error(`Alert troubleshooting benchmark failed quality gate: ${qualityError}`);
      }
    } finally {
      await page.request
        .delete(`/apis/rules.alerting.grafana.app/v0alpha1/namespaces/${namespace}/alertrules/${ruleName}`)
        .catch(() => undefined);
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(dashboardUid)}`).catch(() => undefined);
      await page.request.delete(`/api/folders/${encodeURIComponent(folderUid)}`).catch(() => undefined);
    }
  });
});

async function readGrafanaNamespace(page: Page) {
  const response = await page.request.get('/api/frontend/settings');
  expect(response).toBeOK();
  const settings = await response.json();
  return typeof settings.namespace === 'string' && settings.namespace ? settings.namespace : 'default';
}

async function seedFolder(page: Page, uid: string, title: string) {
  const response = await page.request.post('/api/folders', {
    data: { uid, title },
  });
  if (response.status() === 409) {
    return;
  }
  expect(response).toBeOK();
}

async function seedDashboard(
  page: Page,
  params: { uid: string; title: string; panelTitle: string; folderUid: string }
) {
  const response = await page.request.post('/api/dashboards/db', {
    data: {
      folderUid: params.folderUid,
      dashboard: {
        uid: params.uid,
        title: params.title,
        tags: ['alert-troubleshooting-benchmark'],
        timezone: 'browser',
        schemaVersion: 41,
        time: { from: 'now-1h', to: 'now' },
        panels: [
          {
            id: 1,
            title: params.panelTitle,
            type: 'timeseries',
            datasource: { uid: 'prometheus', type: 'prometheus' },
            gridPos: { x: 0, y: 0, w: 24, h: 8 },
            fieldConfig: {
              defaults: {
                unit: 'reqps',
                thresholds: {
                  mode: 'absolute',
                  steps: [
                    { color: 'green', value: null },
                    { color: 'yellow', value: 100 },
                  ],
                },
              },
              overrides: [],
            },
            targets: [
              {
                refId: 'A',
                datasource: { uid: 'prometheus', type: 'prometheus' },
                expr: 'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))',
                legendFormat: '5xx request rate',
              },
            ],
          },
        ],
      },
      overwrite: true,
    },
  });
  expect(response).toBeOK();
}

async function seedAlertRule(
  page: Page,
  params: {
    namespace: string;
    folderUid: string;
    dashboardUid: string;
    ruleName: string;
    ruleTitle: string;
  }
) {
  const response = await page.request.post(
    `/apis/rules.alerting.grafana.app/v0alpha1/namespaces/${params.namespace}/alertrules`,
    {
      data: {
        apiVersion: 'rules.alerting.grafana.app/v0alpha1',
        kind: 'AlertRule',
        metadata: {
          name: params.ruleName,
          annotations: { 'grafana.app/folder': params.folderUid },
        },
        spec: {
          title: params.ruleTitle,
          trigger: { interval: '1m' },
          for: '2m',
          noDataState: 'NoData',
          execErrState: 'Error',
          labels: { severity: 'warning', benchmark: 'alert-troubleshooting' },
          annotations: {
            __dashboardUid__: params.dashboardUid,
            __panelId__: '1',
          },
          panelRef: { dashboardUID: params.dashboardUid, panelID: 1 },
          expressions: {
            A: {
              datasourceUID: 'prometheus',
              queryType: '',
              relativeTimeRange: { from: '600s', to: '0s' },
              model: {
                datasource: { type: 'prometheus', uid: 'prometheus' },
                refId: 'A',
                expr: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
                range: true,
                instant: false,
              },
            },
            B: {
              datasourceUID: '__expr__',
              queryType: '',
              model: { type: 'reduce', reducer: 'last', expression: 'A', refId: 'B' },
            },
            C: {
              datasourceUID: '__expr__',
              queryType: '',
              source: true,
              model: {
                type: 'threshold',
                expression: 'B',
                conditions: [{ evaluator: { type: 'gt', params: [0] }, reducer: { type: 'last' } }],
                refId: 'C',
              },
            },
          },
        },
      },
    }
  );
  if (!response.ok()) {
    throw new Error(`POST alertrules failed: ${response.status()} ${await response.text()}`);
  }
}

async function openAssistantSidebar(page: Page, dashboardUid: string) {
  await page
    .getByRole('button', { name: /^Open (?:Grafana )?Assistant$/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/d/${escapeRegExp(dashboardUid)}/`));
}

async function installBenchmarkRecorder(page: Page) {
  const streamedEvents: BenchmarkEvent[] = [];
  const liveState: LiveBenchmarkState = {
    toolStarts: new Map(),
    toolUpdates: new Map(),
  };

  await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
    streamedEvents.push(event);
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

  return streamedEvents;
}

async function readBenchmarkEvents(page: Page, streamedEvents: BenchmarkEvent[]): Promise<BenchmarkEvent[]> {
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
  const bestFrameEvents = frameEvents.reduce<BenchmarkEvent[]>(
    (best, events) => (events.length > best.length ? events : best),
    []
  );
  return bestFrameEvents.length > 0 ? bestFrameEvents : streamedEvents;
}

async function waitForBenchmarkCompletion(page: Page, streamedEvents: BenchmarkEvent[], timeoutMs: number) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const events = await readBenchmarkEvents(page, streamedEvents);
    if (events.some((event) => event.type === 'agent_end')) {
      return { timedOut: false, completedBy: 'agent_end' as const };
    }
    if (hasCompletedAlertAgentEvidence(events)) {
      return { timedOut: false, completedBy: 'tool_evidence' as const };
    }
    await page.waitForTimeout(500);
  }

  return { timedOut: true, completedBy: 'timeout' as const };
}

function hasCompletedAlertAgentEvidence(events: BenchmarkEvent[]) {
  return summarizeToolCalls(events).some((call) => {
    if (call.name !== 'run_alert_agent' || call.status !== 'completed') {
      return false;
    }
    const nestedNames = new Set((call.nestedToolCalls ?? []).map((nested) => nested.name));
    return (
      nestedNames.has('find_panel_alert_rules') &&
      nestedNames.has('inspect_dashboard_context') &&
      nestedNames.has('query_prometheus')
    );
  });
}

function findQualityError(events: BenchmarkEvent[], finalAnswer: string, ruleTitle: string) {
  if (events.length === 0) {
    return 'benchmark recorder captured no events';
  }

  const toolCalls = summarizeToolCalls(events);
  const alertAgentCalls = toolCalls.filter((call) => call.name === 'run_alert_agent');
  if (alertAgentCalls.length !== 1) {
    return `expected exactly one top-level run_alert_agent call, got ${alertAgentCalls.length}`;
  }

  const unexpectedTopLevelCall = toolCalls.find((call) => call.name !== 'run_alert_agent');
  if (unexpectedTopLevelCall) {
    return `unexpected top-level tool call: ${unexpectedTopLevelCall.name}`;
  }

  const alertAgent = alertAgentCalls[0];
  if (alertAgent.status !== 'completed' || alertAgent.isError) {
    return 'run_alert_agent did not complete successfully';
  }

  const nestedCalls = alertAgent.nestedToolCalls ?? [];
  if (nestedCalls.length === 0) {
    return 'run_alert_agent did not report nested tool calls';
  }

  const nestedError = nestedCalls.find((call) => call.isError || call.status === 'failed');
  if (nestedError) {
    return `nested tool call failed: ${nestedError.name}`;
  }

  const nestedNames = new Set(nestedCalls.map((call) => call.name));
  for (const required of ['find_panel_alert_rules', 'inspect_dashboard_context', 'query_prometheus']) {
    if (!nestedNames.has(required)) {
      return `run_alert_agent did not use ${required}`;
    }
  }

  const forbidden = findForbiddenToolCall(toolCalls);
  if (forbidden) {
    return `read-only benchmark used write tool: ${forbidden}`;
  }

  const evidenceText = `${alertAgent.resultText ?? ''}\n${finalAnswer}`;
  const expectations = [
    { label: 'rule title', pattern: new RegExp(escapeRegExp(ruleTitle), 'i') },
    { label: 'http_requests_total', pattern: /\bhttp_requests_total\b/i },
    { label: 'panel threshold', pattern: /panel.{0,80}threshold|threshold.{0,80}panel/i },
    { label: 'alert threshold', pattern: /alert.{0,80}threshold|threshold.{0,80}alert|gt|greater/i },
    { label: 'linked panel evidence', pattern: /panelRef|linked|panel ID|dashboard UID/i },
    { label: 'Prometheus query evidence', pattern: /query_prometheus|Prometheus|PromQL|rate\(/i },
  ];
  const missing = expectations.filter((expectation) => !expectation.pattern.test(evidenceText));
  if (missing.length > 0) {
    return `evidence is missing ${missing.map((item) => item.label).join(', ')}`;
  }

  return undefined;
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
      const resultText = extractResultText(event.result);
      calls.set(event.toolCallId, {
        ...existing,
        status: event.isError ? 'failed' : 'completed',
        endedAt: event.timestamp,
        durationMs: event.timestamp - existing.startedAt,
        isError: event.isError,
        nestedToolCalls: extractNestedToolCalls(event.result) ?? existing.nestedToolCalls,
        resultText,
        errorText: event.isError ? resultText : undefined,
      });
    }
  }

  return [...calls.values()].sort((left, right) => left.startedAt - right.startedAt);
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

function formatLiveBenchmarkEvent(event: BenchmarkEvent, state: LiveBenchmarkState) {
  if (event.type === 'tool_execution_start' && event.toolCallId && event.toolName) {
    state.toolStarts.set(event.toolCallId, event);
    return `[alert-troubleshooting-benchmark:live] tool_start ${event.toolName} args=${summarizeJson(event.args)}`;
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

    return [
      `[alert-troubleshooting-benchmark:live] tool_update ${event.toolName}`,
      nestedCalls === undefined ? undefined : `nested=${nestedCalls}`,
      resultText ? `text=${resultText}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (event.type === 'tool_execution_end' && event.toolCallId && event.toolName) {
    const start = state.toolStarts.get(event.toolCallId);
    const duration = start ? formatDuration(event.timestamp - start.timestamp) : 'unknown';
    const status = event.isError ? 'failed' : 'completed';
    const nestedCalls = extractNestedToolCallCount(event.result);
    const resultText = truncateOneLine(extractResultText(event.result) ?? '', event.isError ? 600 : 240);
    return [
      `[alert-troubleshooting-benchmark:live] tool_end ${event.toolName} ${status} duration=${duration}`,
      nestedCalls === undefined ? undefined : `nested=${nestedCalls}`,
      resultText ? (event.isError ? `error=${resultText}` : `text=${resultText}`) : undefined,
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (event.type === 'agent_end') {
    return '[alert-troubleshooting-benchmark:live] agent_end';
  }

  return undefined;
}

function formatBenchmarkReport(
  events: BenchmarkEvent[],
  options: {
    dashboardUid: string;
    ruleName: string;
    ruleTitle: string;
    promptStartedAt: number;
    timeoutMs: number;
    timedOut: boolean;
    completedBy: 'agent_end' | 'tool_evidence' | 'timeout';
    finalAnswer: string;
  }
) {
  const agentStart = events.find((event) => event.type === 'agent_start')?.timestamp ?? options.promptStartedAt;
  const agentEnd = [...events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const elapsedMs = (agentEnd ?? Date.now()) - agentStart;
  const toolCalls = summarizeToolCalls(events);
  const qualityError = findQualityError(events, options.finalAnswer, options.ruleTitle);
  const lines = [
    'Alert troubleshooting benchmark',
    `Dashboard UID: ${options.dashboardUid}`,
    `Alert rule: ${options.ruleName}`,
    `Alert title: ${options.ruleTitle}`,
    `Timed out: ${options.timedOut ? 'yes' : 'no'}`,
    `Completed by: ${options.completedBy}`,
    `Agent elapsed: ${formatDuration(elapsedMs)}`,
    `Timeout: ${formatDuration(options.timeoutMs)}`,
    `Quality gate: ${qualityError ?? 'passed'}`,
    '',
    'Tool calls',
  ];

  for (const call of toolCalls) {
    lines.push(
      [
        call.name,
        call.status,
        call.durationMs === undefined ? undefined : formatDuration(call.durationMs),
        call.nestedToolCalls?.length ? `${call.nestedToolCalls.length} nested calls` : undefined,
        call.isError ? 'error' : undefined,
      ]
        .filter(Boolean)
        .join(' | ')
    );
    if (call.nestedToolCalls?.length) {
      lines.push(`  nested=${call.nestedToolCalls.map(formatNestedToolCall).join(', ')}`);
    }
    if (call.errorText) {
      lines.push(`  error=${truncateOneLine(call.errorText, 800)}`);
    }
  }

  if (options.finalAnswer.trim()) {
    lines.push('', 'Final answer', truncateReportText(options.finalAnswer, 2000));
  }

  return lines.join('\n');
}

async function writeBenchmarkArtifacts(events: BenchmarkEvent[], report: string, finalAnswer: string) {
  const runSuffix = process.env.BENCH_RUN_INDEX ? `-run-${process.env.BENCH_RUN_INDEX}` : '';
  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'latest-events.json'), JSON.stringify(events, null, 2)),
    writeFile(path.join(OUTPUT_DIR, 'latest-report.txt'), report),
    writeFile(path.join(OUTPUT_DIR, 'latest-answer.md'), finalAnswer),
    writeFile(path.join(OUTPUT_DIR, `events${runSuffix}.json`), JSON.stringify(events, null, 2)),
    writeFile(path.join(OUTPUT_DIR, `report${runSuffix}.txt`), report),
    writeFile(path.join(OUTPUT_DIR, `answer${runSuffix}.md`), finalAnswer),
  ]);
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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

function truncateReportText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
