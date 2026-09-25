import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import {
  appliedDashboardUids,
  dashboardExpressions,
  fetchSavedDashboard,
  findBudgetError,
  findFinalAssistantError,
  findFinalAssistantText,
  formatDuration,
  formatLiveEvent,
  formatToolTimeline,
  getRecord,
  nonRowPanels,
  parsePromQueryResults,
  promQueryCalls,
  readPositiveInteger,
  stringField,
  summarizeToolCalls,
  summarizeUsage,
  truncateOneLine,
  workspaceApplyCalls,
  type BashCall,
  type BenchmarkEvent,
  type PromQueryResult,
  type SavedDashboard,
} from './benchmarkOutcomes';

const DEFAULT_TIMEOUT_MS = 600_000;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'thanos-cost-dashboard-benchmark');
const DATASOURCE_UID = 'thanos-prod-db';
const NAMESPACE = 'thanos-prod';
const CLUSTER_SELECTOR = 'cluster="openshift-obs-it-prod"';
const BUDGET = { maxToolCalls: 45 };
const REQUIRED_METRIC_GROUPS = [
  ['prometheus_tsdb_storage_blocks_bytes'],
  ['prometheus_tsdb_wal_storage_size_bytes'],
  ['thanos_receive_write_samples_sum'],
  ['thanos_receive_write_timeseries_sum'],
  ['container_cpu_usage_seconds_total'],
  ['container_memory_working_set_bytes', 'container_memory_usage_bytes'],
];
const FORBIDDEN_JSONNET_PATTERNS = [
  { label: 'unsupported oneByThree layout', pattern: /\bd\.layout\.oneByThree\s*\(/ },
  { label: 'unsupported panel description argument', pattern: /\bdescription\s*=/ },
  { label: 'unsupported table sortByField argument', pattern: /\bsortByField\s*=/ },
  { label: 'unsupported table sortDesc argument', pattern: /\bsortDesc\s*=/ },
  { label: 'unsupported dashboard timeframe argument', pattern: /\btimeframe\s*=/ },
  { label: 'unsupported dashboard timeFrom argument', pattern: /\btimeFrom\s*=/ },
  { label: 'unsupported dashboard timeTo argument', pattern: /\btimeTo\s*=/ },
];

type BenchmarkRun = {
  prompt: string;
  events: BenchmarkEvent[];
  finalAnswer: string;
  promptStartedAt: number;
  timeoutMs: number;
  timedOut: boolean;
};

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + 90_000));

test.describe('Thanos cost dashboard benchmark', () => {
  test('turns validated Thanos cost evidence into a saved dashboard without unsupported Jsonnet helper usage', async ({
    gotoPage,
    page,
  }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const dashboardUid = `thanos-cost-${suffix}`;
    const dashboardTitle = `Thanos Tenant Cost Benchmark ${suffix}`;

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
      await installBenchmarkRecorder(page);

      const prompt = [
        `Kannst du auf Grundlage der Thanos Daten mal schauen, welche Datentoepfe in Thanos die groessten sind und welche am meisten Ressourcen und Kosten verursachen. Cool waere auch eine Berechnung, welcher Tenant wie viel CPU und Memory benoetigt. Alles bezogen auf den Namespace ${NAMESPACE} im Cluster openshift-obs-it-prod.`,
        `Die Daten liegen in der Prometheus-Datasource mit UID ${DATASOURCE_UID}. Starte mit diesen Kandidaten-Queries:`,
        `1. sum by (tenant) (prometheus_tsdb_storage_blocks_bytes{${CLUSTER_SELECTOR}, namespace="${NAMESPACE}"})`,
        `2. sum by (tenant) (prometheus_tsdb_wal_storage_size_bytes{${CLUSTER_SELECTOR}, namespace="${NAMESPACE}"})`,
        `3. sum by (tenant) (rate(thanos_receive_write_samples_sum{${CLUSTER_SELECTOR}, namespace="${NAMESPACE}"}[5m]))`,
        `4. sum by (tenant) (rate(thanos_receive_write_timeseries_sum{${CLUSTER_SELECTOR}, namespace="${NAMESPACE}"}[5m]))`,
        `5. topk(10, sum by (pod, tenant_id) (rate(container_cpu_usage_seconds_total{${CLUSTER_SELECTOR}, namespace="${NAMESPACE}"}[5m])))`,
        `6. topk(10, sum by (pod, tenant_id) (container_memory_working_set_bytes{${CLUSTER_SELECTOR}, namespace="${NAMESPACE}"}))`,
        'Falls sie keine Daten liefern, finde heraus warum und passe sie an.',
        `Erstelle danach ein Dashboard "${dashboardTitle}" mit UID "${dashboardUid}" fuer die letzten 6 Stunden mit TSDB-Storage pro Tenant, WAL-Storage pro Tenant, Storage-Trend, Ingest Samples/s, Ingest Series/s, Top-CPU-Pods und Top-Memory-Pods, und speichere es.`,
        'Nimm nur Queries ins Dashboard, die tatsaechlich Daten liefern.',
      ].join('\n');

      const run = await runPrompt({ page, prompt, timeoutMs });
      const saved = await fetchSavedDashboard(page.request, dashboardUid);
      const qualityError = findThanosDashboardQualityError(run, dashboardUid, saved);
      const report = formatBenchmarkReport(run, dashboardUid, qualityError);

      await testInfo.attach('thanos-cost-dashboard-benchmark-report.txt', {
        body: report,
        contentType: 'text/plain',
      });
      await testInfo.attach('thanos-cost-dashboard-benchmark-events.json', {
        body: JSON.stringify(run.events, null, 2),
        contentType: 'application/json',
      });
      await writeBenchmarkArtifacts(run, report);

      console.log(report);

      const finalAssistantError = findFinalAssistantError(run.events);
      if (finalAssistantError) {
        throw new Error(`Thanos cost dashboard benchmark ended with assistant error: ${finalAssistantError}`);
      }

      if (qualityError) {
        throw new Error(`Thanos cost dashboard benchmark failed quality gate: ${qualityError}`);
      }

      if (run.timedOut) {
        throw new Error(`Thanos cost dashboard benchmark timed out after ${timeoutMs}ms.`);
      }
    } finally {
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(dashboardUid)}`).catch(() => undefined);
    }
  });
});

async function installBenchmarkRecorder(page: Page) {
  await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
    const line = formatLiveEvent('thanos-cost-dashboard-benchmark', event);
    if (line) {
      console.log(line);
    }
  });

  const installRecorder = () => {
    const benchmarkWindow = window as typeof window & {
      __PI_AGENT_BENCHMARK_EVENTS__?: unknown[];
      __PI_AGENT_BENCHMARK_RECORD_EVENT__?: (event: unknown) => void;
      __PI_AGENT_BENCHMARK_STREAM_EVENT__?: (event: unknown) => Promise<void>;
    };

    benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ = [];
    benchmarkWindow.__PI_AGENT_BENCHMARK_RECORD_EVENT__ = (event: unknown) => {
      benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__?.push(event);
      void benchmarkWindow.__PI_AGENT_BENCHMARK_STREAM_EVENT__?.(event);
    };
  };

  await page.addInitScript(installRecorder);
  await page.evaluate(installRecorder);
}

async function runPrompt({
  page,
  prompt,
  timeoutMs,
}: {
  page: Page;
  prompt: string;
  timeoutMs: number;
}): Promise<BenchmarkRun> {
  await page.evaluate(() => {
    const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: unknown[] };
    benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ = [];
  });
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
    await page.waitForFunction(
      () => {
        const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: Array<{ type: string }> };
        return benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__?.some((event) => event.type === 'agent_end') ?? false;
      },
      undefined,
      { timeout: timeoutMs }
    );
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

  const events = await page.evaluate(() => {
    const benchmarkWindow = window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: unknown[] };
    return benchmarkWindow.__PI_AGENT_BENCHMARK_EVENTS__ ?? [];
  });
  return {
    prompt,
    events: events as BenchmarkEvent[],
    finalAnswer: findFinalAssistantText(events as BenchmarkEvent[]),
    promptStartedAt,
    timeoutMs,
    timedOut,
  };
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

function findThanosDashboardQualityError(run: BenchmarkRun, dashboardUid: string, saved?: SavedDashboard) {
  const firstApply = workspaceApplyCalls(run.events)[0];
  const validationCalls = promQueryCalls(run.events).filter(
    (call) => !firstApply || call.startedAt < firstApply.startedAt
  );
  const textualEvidence = [...validationCalls.map((call) => call.stdout), run.finalAnswer].join('\n');
  const validationError = findPrometheusEvidenceQualityError(validationCalls, textualEvidence);
  if (validationError) {
    return validationError;
  }

  if (!appliedDashboardUids(run.events).includes(dashboardUid)) {
    return `workspace apply did not report ${dashboardUid} as applied`;
  }
  if (!saved) {
    return `dashboard ${dashboardUid} does not exist in Grafana after the run`;
  }

  const panelCount = nonRowPanels(saved.dashboard).length;
  if (panelCount < 5) {
    return `expected at least 5 non-row panels, got ${panelCount}`;
  }

  const timeFrom = stringField(getRecord(saved.dashboard.time), 'from');
  if (timeFrom !== 'now-6h') {
    return `saved dashboard time range starts at ${timeFrom ?? 'unset'} instead of now-6h`;
  }

  const savedText = JSON.stringify(saved.dashboard);
  if (!savedText.includes(DATASOURCE_UID)) {
    return `saved dashboard does not reference datasource ${DATASOURCE_UID}`;
  }
  if (normalizeQuotes(savedText).includes(CLUSTER_SELECTOR)) {
    return `saved dashboard still contains zero-series over-scoped selector ${CLUSTER_SELECTOR}`;
  }

  const expressions = dashboardExpressions(saved.dashboard).join('\n');
  for (const group of REQUIRED_METRIC_GROUPS) {
    if (!group.some((metric) => expressions.includes(metric))) {
      return `saved dashboard does not include expected metric group ${group.join(' or ')}`;
    }
  }

  const jsonnetSource = latestJsonnetSource(run.events);
  for (const { label, pattern } of FORBIDDEN_JSONNET_PATTERNS) {
    if (pattern.test(jsonnetSource)) {
      return `dashboard Jsonnet contains ${label}`;
    }
  }

  return findBudgetError(run.events, BUDGET);
}

function findPrometheusEvidenceQualityError(calls: BashCall[], textualEvidence: string) {
  if (calls.length === 0) {
    return 'no grafana-prom query validation evidence was collected before the first workspace apply';
  }

  const clusterCalls = calls.filter((call) => normalizeQuotes(call.command).includes(CLUSTER_SELECTOR));
  if (clusterCalls.length === 0) {
    return `the agent did not validate the over-scoped ${CLUSTER_SELECTOR} candidates`;
  }

  const results = calls.flatMap((call) => parsePromQueryResults(call));
  const clusterResults = results.filter((result) => (result.query ?? '').includes(CLUSTER_SELECTOR));
  const clusterUnusable =
    clusterResults.some(isUnusableQueryResult) ||
    clusterCalls.some(
      (call) =>
        parsePromQueryResults(call).length === 0 && (call.exitCode !== 0 || /"totalSeries"\s*:\s*0\b/.test(call.stdout))
    ) ||
    hasTextualClusterZeroSeriesEvidence(textualEvidence);
  if (!clusterUnusable) {
    return `over-scoped ${CLUSTER_SELECTOR} evidence was not observed as validationError or zero-series`;
  }

  for (const group of REQUIRED_METRIC_GROUPS) {
    const namespaceScoped = (query: string) =>
      group.some((metric) => query.includes(metric)) &&
      query.includes(`namespace="${NAMESPACE}"`) &&
      !query.includes(CLUSTER_SELECTOR);
    const parsedSuccess = results.some(
      (result) => namespaceScoped(result.query ?? '') && isSuccessfulQueryResult(result)
    );
    const unparsedSuccess = calls.some(
      (call) =>
        parsePromQueryResults(call).length === 0 &&
        namespaceScoped(normalizeQuotes(call.command)) &&
        !call.isError &&
        (call.exitCode === 0 || /"totalSeries"\s*:\s*[1-9]/.test(call.stdout))
    );
    if (!parsedSuccess && !unparsedSuccess && !hasTextualSuccessfulMetricEvidence(textualEvidence, group)) {
      return `no successful namespace-scoped validation evidence for metric group ${group.join(' or ')}`;
    }
  }

  return undefined;
}

function hasTextualClusterZeroSeriesEvidence(text: string) {
  const normalized = text.toLowerCase();
  const mentionsCluster =
    normalized.includes(CLUSTER_SELECTOR.toLowerCase()) || /\bcluster\b[^.\n]*openshift-obs-it-prod/.test(normalized);
  const mentionsZeroSeries =
    /zero[-\s]?series/.test(normalized) || /0\s+series/.test(normalized) || /totalseries\s*[:=]\s*0/.test(normalized);
  return mentionsCluster && mentionsZeroSeries;
}

function hasTextualSuccessfulMetricEvidence(text: string, metricGroup: string[]) {
  const normalized = text.toLowerCase();
  const terms = [...metricGroup, ...metricGroup.flatMap(metricEvidenceAliases)];
  const mentionsMetric = terms.some((metric) => normalized.includes(metric.toLowerCase()));
  const mentionsNamespace = normalized.includes(`namespace="${NAMESPACE}"`);
  const mentionsSuccess =
    /validated successfully|validierten erfolgreich|totalseries/.test(normalized) &&
    /status|no validationerror|validationerror\s*\|\s*none|validationerror.*none|\u2705/.test(normalized);
  return mentionsMetric && mentionsNamespace && mentionsSuccess;
}

function metricEvidenceAliases(metric: string) {
  switch (metric) {
    case 'prometheus_tsdb_storage_blocks_bytes':
      return ['tsdb storage'];
    case 'prometheus_tsdb_wal_storage_size_bytes':
      return ['wal storage'];
    case 'thanos_receive_write_samples_sum':
      return ['ingest samples', 'samples/sec'];
    case 'thanos_receive_write_timeseries_sum':
      return ['ingest series', 'series/sec'];
    case 'container_cpu_usage_seconds_total':
      return ['top cpu', 'cpu pods'];
    case 'container_memory_working_set_bytes':
    case 'container_memory_usage_bytes':
      return ['top memory', 'memory pods'];
    default:
      return [];
  }
}

function isUnusableQueryResult(result: PromQueryResult) {
  return Boolean(result.validationError) || result.totalSeries === 0;
}

function isSuccessfulQueryResult(result: PromQueryResult) {
  return !result.validationError && (result.totalSeries ?? 0) > 0;
}

function normalizeQuotes(text: string) {
  return text.replace(/\\"/g, '"');
}

/** Latest Jsonnet written through write/edit, per file (edits contribute their replacement text). */
function latestJsonnetSource(events: BenchmarkEvent[]) {
  const sources = new Map<string, string[]>();
  for (const call of summarizeToolCalls(events)) {
    const args = getRecord(call.args);
    const filePath = stringField(args, 'path');
    if (call.isError || call.status !== 'completed' || !filePath || !/\.(jsonnet|libsonnet)$/.test(filePath)) {
      continue;
    }
    if (call.name === 'write') {
      sources.set(filePath, [stringField(args, 'content') ?? '']);
    } else if (call.name === 'edit' && Array.isArray(args?.edits)) {
      const replacements = args.edits.map((edit) => stringField(getRecord(edit), 'newText') ?? '');
      sources.set(filePath, [...(sources.get(filePath) ?? []), ...replacements]);
    }
  }
  return [...sources.values()].flat().join('\n');
}

function formatBenchmarkReport(run: BenchmarkRun, dashboardUid: string, quality: string | undefined) {
  const agentStart = run.events.find((event) => event.type === 'agent_start')?.timestamp ?? run.promptStartedAt;
  const agentEnd = [...run.events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
  const toolCalls = summarizeToolCalls(run.events);
  const usage = summarizeUsage(run.events);
  const lines = [
    '',
    'Thanos cost dashboard benchmark report',
    `Dashboard UID: ${dashboardUid}`,
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3000'}`,
    `Model URL: ${process.env.BENCH_LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1'}`,
    '',
    `Prompt: ${run.prompt}`,
    `Status: ${run.timedOut ? 'timed out' : findFinalAssistantError(run.events) ? 'failed' : 'completed'}`,
    `Elapsed: ${formatDuration((agentEnd ?? Date.now()) - agentStart)}`,
    `Time to first tool: ${toolCalls[0] ? formatDuration(toolCalls[0].startedAt - agentStart) : 'none'}`,
    `Tool calls: ${toolCalls.length} (budget ${BUDGET.maxToolCalls})`,
    `Token usage: input=${usage.input}, output=${usage.output}, total=${usage.totalTokens}`,
    `Assistant error: ${findFinalAssistantError(run.events) ?? 'none'}`,
    `Quality: ${quality ?? 'passed'}`,
    '',
    'Tool call timeline',
    ...formatToolTimeline(run.events),
  ];

  lines.push('', 'Final answer preview', truncateOneLine(run.finalAnswer, 1600));
  return lines.join('\n');
}

async function writeBenchmarkArtifacts(run: BenchmarkRun, report: string) {
  const runSuffix = process.env.BENCH_RUN_INDEX ? `-run-${process.env.BENCH_RUN_INDEX}` : '';
  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'latest-report.txt'), report),
    writeFile(path.join(OUTPUT_DIR, 'latest-events.json'), JSON.stringify(run.events, null, 2)),
    writeFile(path.join(OUTPUT_DIR, 'latest-answer.md'), run.finalAnswer),
    writeFile(path.join(OUTPUT_DIR, `report${runSuffix}.txt`), report),
    writeFile(path.join(OUTPUT_DIR, `events${runSuffix}.json`), JSON.stringify(run.events, null, 2)),
  ]);
}
