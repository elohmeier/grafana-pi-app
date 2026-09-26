import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { testIds } from '../src/components/testIds';
import {
  alertRulesFingerprint,
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

const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_TOOL_CALLS = 14;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'alert-troubleshooting-benchmark');

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
      const alertRulesBefore = await alertRulesFingerprint(page.request);

      await page.goto(`/d/${dashboardUid}/alert-troubleshooting?orgId=1&viewPanel=1&from=now-1h&to=now`);
      await expect(page.getByText(panelTitle)).toBeVisible();
      const streamedEvents = await installBenchmarkRecorder(page);
      await openAssistantSidebar(page, dashboardUid);
      await expect(page.getByTestId(testIds.chat.composer)).toBeVisible();

      const prompt = [
        `The "${panelTitle}" panel on this dashboard looks below its warning threshold, but its linked alert keeps firing.`,
        'Find the alert rule linked to this panel, compare its query, threshold, and evaluation settings with the panel,',
        'check the current data, and explain why the panel can look fine while the alert still fires.',
        'Name the rule, the metric it queries, the alert threshold, and the panel threshold.',
        'Do not change any alert rules or dashboards.',
      ].join(' ');

      const promptStartedAt = Date.now();
      const composer = page.getByTestId(testIds.chat.composer);
      const send = page.getByTestId(testIds.chat.send);
      await composer.fill(prompt);
      await expect(send).toBeEnabled();
      await send.click();

      const timedOut = !(await waitForAgentEnd(page, streamedEvents, timeoutMs));
      if (timedOut) {
        await page
          .getByRole('button', { name: /Stop/i })
          .click({ timeout: 1000 })
          .catch(() => undefined);
      }
      const events = await readBenchmarkEvents(page, streamedEvents);
      const finalAnswer = findFinalAssistantText(events);
      const alertRulesAfter = await alertRulesFingerprint(page.request).catch((error: unknown) => String(error));
      const alertRulesChanged = alertRulesAfter !== alertRulesBefore;
      const report = formatBenchmarkReport(events, {
        prompt,
        dashboardUid,
        ruleName,
        ruleTitle,
        promptStartedAt,
        timeoutMs,
        timedOut,
        alertRulesChanged,
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

      if (timedOut) {
        throw new Error(`Alert troubleshooting benchmark timed out after ${timeoutMs}ms.`);
      }

      const finalAssistantError = findFinalAssistantError(events);
      if (finalAssistantError) {
        throw new Error(`Alert troubleshooting benchmark ended with assistant error: ${finalAssistantError}`);
      }

      const qualityError = findQualityError(events, { finalAnswer, ruleTitle, alertRulesChanged });
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

  await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
    streamedEvents.push(event);
    const line = formatLiveEvent('alert-troubleshooting-benchmark', event);
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

async function waitForAgentEnd(page: Page, streamedEvents: BenchmarkEvent[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readBenchmarkEvents(page, streamedEvents);
    if (events.some((event) => event.type === 'agent_end')) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * Outcome gate: the linked rule was looked up, its data was checked with PromQL,
 * no alerting resources or dashboards changed, the run stayed within budget, and
 * the answer explains the alert-vs-panel threshold mismatch.
 */
function findQualityError(
  events: BenchmarkEvent[],
  options: { finalAnswer: string; ruleTitle: string; alertRulesChanged: boolean }
) {
  if (events.length === 0) {
    return 'benchmark recorder captured no events';
  }
  if (options.alertRulesChanged) {
    return 'Grafana alert rules changed during a read-only troubleshooting run';
  }

  const writes = dashboardWriteAttempts(events);
  if (writes.length > 0) {
    return `read-only benchmark attempted dashboard writes: ${writes.join(', ')}`;
  }
  const staged = stagedGrafanaPaths(events);
  if (staged.length > 0) {
    return `read-only benchmark staged Grafana resource changes: ${staged.join(', ')}`;
  }

  const budgetError = findBudgetError(events, {
    maxToolCalls: readPositiveInteger(process.env.BENCH_ALERT_MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS),
  });
  if (budgetError) {
    return budgetError;
  }

  const alertLookup = bashCalls(events).some(
    (call) => isSuccessfulBash(call) && /\bgrafana-alert\s+(find|get)\b/.test(call.command)
  );
  if (!alertLookup) {
    return 'the linked alert rule was never looked up (`grafana-alert find` or `grafana-alert get`)';
  }
  if (!hasSuccessfulPromEvidence(events)) {
    return 'no successful `grafana-prom query` evidence was found';
  }

  const expectations = [
    { label: 'rule title', pattern: new RegExp(escapeRegExp(options.ruleTitle), 'i') },
    { label: 'http_requests_total', pattern: /\bhttp_requests_total\b/i },
    { label: 'panel threshold', pattern: /panel.{0,80}threshold|threshold.{0,80}panel/i },
    { label: 'panel threshold value 100', pattern: /\b100\b/ },
    { label: 'alert threshold', pattern: /alert.{0,80}threshold|threshold.{0,80}alert|gt|greater|> ?0\b|above 0/i },
    { label: 'linked panel evidence', pattern: /linked|panelRef|panel ID|dashboard UID/i },
  ];
  const missing = expectations.filter((expectation) => !expectation.pattern.test(options.finalAnswer));
  if (missing.length > 0) {
    return `final answer is missing ${missing.map((item) => item.label).join(', ')}`;
  }

  return undefined;
}

function formatBenchmarkReport(
  events: BenchmarkEvent[],
  options: {
    prompt: string;
    dashboardUid: string;
    ruleName: string;
    ruleTitle: string;
    promptStartedAt: number;
    timeoutMs: number;
    timedOut: boolean;
    alertRulesChanged: boolean;
    finalAnswer: string;
  }
) {
  const agentStart = events.find((event) => event.type === 'agent_start')?.timestamp ?? options.promptStartedAt;
  const agentEnd = [...events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const elapsedMs = (agentEnd ?? Date.now()) - agentStart;
  const usage = summarizeUsage(events);
  const qualityError = options.timedOut ? undefined : findQualityError(events, options);
  const lines = [
    'Alert troubleshooting benchmark',
    `Prompt: ${options.prompt}`,
    `Dashboard UID: ${options.dashboardUid}`,
    `Alert rule: ${options.ruleName}`,
    `Alert title: ${options.ruleTitle}`,
    `Timed out: ${options.timedOut ? 'yes' : 'no'}`,
    `Agent elapsed: ${formatDuration(elapsedMs)}`,
    `Timeout: ${formatDuration(options.timeoutMs)}`,
    `Token usage: input=${usage.input}, output=${usage.output}, total=${usage.totalTokens}`,
    `Tool calls: ${summarizeToolCalls(events).length}`,
    `Alert rules changed: ${options.alertRulesChanged ? 'yes' : 'no'}`,
    `Quality gate: ${options.timedOut ? 'not run' : (qualityError ?? 'passed')}`,
    '',
    'Tool calls',
    ...formatToolTimeline(events),
  ];

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

function truncateReportText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
