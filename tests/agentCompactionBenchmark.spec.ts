import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import pluginJson from '../src/plugin.json';
import {
  findFinalAssistantError,
  findFinalAssistantText,
  formatDuration,
  formatLiveEvent,
  formatToolTimeline,
  readPositiveInteger,
  summarizeToolCalls,
  summarizeUsage,
  truncateOneLine,
  type BenchmarkEvent,
} from './benchmarkOutcomes';

/**
 * Compaction fidelity: a multi-turn session runs with a deliberately small
 * context window, so earlier turns are summarized. The last turn must answer
 * from memory, without tools, with facts that only appeared in early turns:
 * two user-stated facts and every panel title of three seeded dashboards.
 * Turns about three other dashboards grow the conversation in between.
 */

// Summarizer calls add model requests to a turn, which local models answer slowly.
const DEFAULT_TIMEOUT_MS = 480_000;
const OUTPUT_DIR = path.join(process.cwd(), 'test-results', 'compaction-benchmark');
const LOG_PREFIX = 'compaction-benchmark';
const PLUGIN_ID = process.env.E2E_PLUGIN_ID ?? pluginJson.id;
// The system prompt and tool schemas take about 8k tokens. 20k leaves a history
// budget of about 6k, which the conversation outgrows even with tool output elided.
const CONTEXT_WINDOW = readPositiveInteger(process.env.BENCH_COMPACTION_CONTEXT_WINDOW, 20_000);
const MAX_OUTPUT_TOKENS = Math.min(4096, Math.floor(CONTEXT_WINDOW / 2));

// Unusual titles, so the model cannot reconstruct them without remembering them.
const DASHBOARDS = [
  {
    key: 'ledger',
    title: 'Ledger reconciliation',
    panels: ['Quill backlog age', 'Settlement drift by vault', 'Orphaned journal entries', 'Reconciler heartbeat gap'],
  },
  {
    key: 'fleet',
    title: 'Courier fleet',
    panels: ['Dispatch queue saturation', 'Van telemetry dropouts', 'Route solver retries', 'Depot handoff latency'],
  },
  {
    key: 'kiln',
    title: 'Kiln firmware rollout',
    panels: [
      'Firmware canary crash ratio',
      'Kiln thermocouple variance',
      'OTA chunk resend rate',
      'Bootloader rollback count',
    ],
  },
] as const;

// Inspected between the facts and the recall question; not part of the recall.
const NOISE_DASHBOARDS = [
  {
    key: 'noise-billing',
    title: 'Billing exports',
    panels: ['Invoice render time', 'Export queue depth', 'Failed PDF renders', 'Tax service latency'],
  },
  {
    key: 'noise-search',
    title: 'Search indexing',
    panels: ['Indexer lag', 'Shard merge time', 'Query cache hit ratio', 'Rejected bulk requests'],
  },
  {
    key: 'noise-auth',
    title: 'Auth gateway',
    panels: ['Token issue rate', 'MFA challenge failures', 'Session store evictions', 'SSO callback errors'],
  },
] as const;

type Turn = {
  name: string;
  prompt: string;
  events: BenchmarkEvent[];
  finalAnswer: string;
  timedOut: boolean;
};

type Recall = { expected: string[]; missing: string[] };

test.describe.configure({ mode: 'serial' });
test.setTimeout(readPositiveInteger(process.env.BENCH_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS * 6 + 120_000));

test.describe('compaction fidelity benchmark', () => {
  test('recalls early facts after earlier turns were summarized', async ({ gotoPage, page }, testInfo) => {
    const timeoutMs = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const suffix = Date.now().toString(36);
    const uid = (key: string) => `compaction-bench-${key}-${suffix}`;
    const ticket = `CHG-${suffix.toUpperCase()}`;
    const maintenanceWindow = '02:40-03:10 UTC';
    const originalSettings = await readPluginSettings(page.request);

    try {
      for (const dashboard of [...DASHBOARDS, ...NOISE_DASHBOARDS]) {
        await seedDashboard(page.request, uid(dashboard.key), `${dashboard.title} ${suffix}`, dashboard.panels);
      }
      await setModelLimits(page.request, originalSettings, CONTEXT_WINDOW, MAX_OUTPUT_TOKENS);

      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
      await installBenchmarkRecorder(page);

      const [ledger, fleet, kiln] = DASHBOARDS.map((dashboard) => uid(dashboard.key));
      const [billing, search, auth] = NOISE_DASHBOARDS.map((dashboard) => uid(dashboard.key));
      const prompts: Array<Pick<Turn, 'name' | 'prompt'>> = [
        {
          name: 'facts and first inspections',
          prompt: [
            `My change ticket is ${ticket} and the maintenance window is ${maintenanceWindow}; remember both.`,
            `Inspect the dashboards ${ledger} and ${fleet} with grafana-dashboard inspect and list every panel title with its dashboard UID.`,
          ].join(' '),
        },
        {
          name: 'third inspection',
          prompt: `Now inspect ${kiln} the same way and list its panel titles with the dashboard UID.`,
        },
        {
          name: 'other dashboards',
          prompt: `Inspect ${billing} and ${search}. For every panel, explain in one sentence what its query measures and what an on-call engineer should check when it looks wrong.`,
        },
        {
          name: 'another dashboard',
          prompt: `Inspect ${auth} the same way.`,
        },
        {
          name: 'recall without tools',
          prompt: [
            'Do not use any tools for this answer; answer from what you already know.',
            `Give me my change ticket, the maintenance window, and a table of every panel title with its dashboard UID for the first three dashboards we inspected (${ledger}, ${fleet}, ${kiln}).`,
          ].join(' '),
        },
      ];

      const turns: Turn[] = [];
      for (const { name, prompt } of prompts) {
        const turn = await runPrompt(page, name, prompt, timeoutMs);
        turns.push(turn);
        if (turn.timedOut || findFinalAssistantError(turn.events)) {
          break;
        }
      }

      const expected = [ticket, maintenanceWindow, ...DASHBOARDS.flatMap((dashboard) => dashboard.panels)];
      const recallTurn = turns.length === prompts.length ? turns.at(-1) : undefined;
      const recall: Recall = {
        expected,
        missing: expected.filter((fact) => !normalize(recallTurn?.finalAnswer ?? '').includes(normalize(fact))),
      };
      const report = formatReport(turns, prompts.length, recall);
      await testInfo.attach('compaction-benchmark-report.txt', { body: report, contentType: 'text/plain' });
      await testInfo.attach('compaction-benchmark-events.json', {
        body: JSON.stringify(
          turns.flatMap((turn) => turn.events),
          null,
          2
        ),
        contentType: 'application/json',
      });
      await writeArtifacts(turns, report);
      console.log(report);

      const qualityError = findQualityError(turns, prompts.length, recall);
      if (qualityError) {
        throw new Error(`Compaction benchmark failed quality gate: ${qualityError}`);
      }
    } finally {
      await restorePluginSettings(page.request, originalSettings);
      for (const dashboard of [...DASHBOARDS, ...NOISE_DASHBOARDS]) {
        await page.request
          .delete(`/api/dashboards/uid/${encodeURIComponent(uid(dashboard.key))}`)
          .catch(() => undefined);
      }
    }
  });
});

type PluginSettings = { enabled: boolean; pinned: boolean; jsonData: Record<string, unknown> };

async function readPluginSettings(request: APIRequestContext): Promise<PluginSettings> {
  const response = await request.get(`/api/plugins/${PLUGIN_ID}/settings`);
  expect(response).toBeOK();
  return response.json();
}

/** Grafana keeps secure fields that an update omits, so the API key survives. */
async function writePluginSettings(request: APIRequestContext, settings: PluginSettings) {
  const response = await request.post(`/api/plugins/${PLUGIN_ID}/settings`, {
    data: { enabled: settings.enabled, pinned: settings.pinned, jsonData: settings.jsonData },
  });
  expect(response).toBeOK();
}

async function setModelLimits(
  request: APIRequestContext,
  settings: PluginSettings,
  contextWindow: number,
  maxOutputTokens: number
) {
  const models = Array.isArray(settings.jsonData.models) ? settings.jsonData.models : [];
  if (!models.length) {
    throw new Error('The plugin has no configured models to benchmark.');
  }
  await writePluginSettings(request, {
    ...settings,
    jsonData: {
      ...settings.jsonData,
      models: models.map((model) => ({ ...(model as object), contextWindow, maxOutputTokens })),
    },
  });
}

async function restorePluginSettings(request: APIRequestContext, settings: PluginSettings) {
  await writePluginSettings(request, settings).catch((error) => {
    console.error(`[${LOG_PREFIX}] Could not restore plugin settings: ${error}`);
  });
}

async function seedDashboard(request: APIRequestContext, uid: string, title: string, panels: readonly string[]) {
  const response = await request.post('/api/dashboards/db', {
    data: {
      dashboard: {
        uid,
        title,
        tags: ['compaction-benchmark'],
        schemaVersion: 41,
        time: { from: 'now-6h', to: 'now' },
        panels: panels.map((panelTitle, index) => ({
          id: index + 1,
          title: panelTitle,
          type: 'timeseries',
          // Descriptions make the dashboard JSON bulky, like real dashboards.
          description: `${panelTitle}: ${'Operational context for on-call engineers. '.repeat(8 + index * 4)}`,
          datasource: { uid: 'prometheus', type: 'prometheus' },
          gridPos: { x: (index % 2) * 12, y: Math.floor(index / 2) * 8, w: 12, h: 8 },
          targets: [
            {
              refId: 'A',
              datasource: { uid: 'prometheus', type: 'prometheus' },
              expr: `sum by (instance) (rate(up{job="compaction-${index}"}[$__rate_interval]))`,
            },
          ],
        })),
      },
      overwrite: true,
    },
  });
  expect(response).toBeOK();
}

async function installBenchmarkRecorder(page: Page) {
  await page.exposeFunction('__PI_AGENT_BENCHMARK_STREAM_EVENT__', (event: BenchmarkEvent) => {
    const line = formatLiveEvent(LOG_PREFIX, event);
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

async function runPrompt(page: Page, name: string, prompt: string, timeoutMs: number): Promise<Turn> {
  await page.evaluate(() => {
    (window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: unknown[] }).__PI_AGENT_BENCHMARK_EVENTS__ = [];
  });
  const composer = page.getByTestId(testIds.chat.composer);
  const send = page.getByTestId(testIds.chat.send);
  await composer.fill(prompt);
  await expect(send).toBeEnabled();
  await send.click();

  let timedOut = false;
  try {
    await page.waitForFunction(
      () =>
        (
          window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: Array<{ type: string }> }
        ).__PI_AGENT_BENCHMARK_EVENTS__?.some((event) => event.type === 'agent_end') ?? false,
      undefined,
      { timeout: timeoutMs }
    );
  } catch {
    timedOut = true;
    await page
      .getByRole('button', { name: /Stop/i })
      .first()
      .click({ timeout: 1000 })
      .catch(() => undefined);
  }

  const events = await page.evaluate(
    () =>
      ((window as typeof window & { __PI_AGENT_BENCHMARK_EVENTS__?: unknown[] }).__PI_AGENT_BENCHMARK_EVENTS__ ??
        []) as BenchmarkEvent[]
  );
  return { name, prompt, events, finalAnswer: findFinalAssistantText(events), timedOut };
}

function compactionEvents(turns: Turn[]) {
  return turns.flatMap((turn) =>
    turn.events
      .filter((event) => event.type === 'context_compaction')
      .map((event) => ({ turn: turn.name, ...(event as BenchmarkEvent & { kind?: string; coveredMessages?: number }) }))
  );
}

/** Case, whitespace, and dash style differ between the model's table and the expected facts. */
function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/[*_`|]/g, ' ')
    .replace(/\s+/g, ' ');
}

function findQualityError(turns: Turn[], expectedTurns: number, recall: Recall) {
  const failed = turns.find((turn) => turn.timedOut || findFinalAssistantError(turn.events));
  if (failed) {
    return `turn "${failed.name}" ${failed.timedOut ? 'timed out' : `ended with ${findFinalAssistantError(failed.events)}`}`;
  }
  if (turns.length < expectedTurns) {
    return 'not every turn ran';
  }
  const summarized = compactionEvents(turns).filter((event) => event.kind === 'summarized');
  if (!summarized.length) {
    return `no earlier turns were summarized; lower BENCH_COMPACTION_CONTEXT_WINDOW (now ${CONTEXT_WINDOW})`;
  }
  const recallTurn = turns.at(-1)!;
  const recallTools = summarizeToolCalls(recallTurn.events);
  if (recallTools.length) {
    return `the recall turn used tools (${recallTools.map((call) => call.name).join(', ')}) instead of answering from context`;
  }
  if (recall.missing.length) {
    return `recall missed ${recall.missing.length}/${recall.expected.length} facts: ${recall.missing.join('; ')}`;
  }
  return undefined;
}

function formatReport(turns: Turn[], expectedTurns: number, recall: Recall) {
  const events = turns.flatMap((turn) => turn.events);
  const usage = summarizeUsage(events);
  const compactions = compactionEvents(turns);
  const lines = [
    '',
    'Compaction fidelity benchmark report',
    `Grafana URL: ${process.env.GRAFANA_URL ?? 'http://localhost:3000'}`,
    `Context window: ${CONTEXT_WINDOW} tokens (max output ${MAX_OUTPUT_TOKENS})`,
    `Token usage: input=${usage.input}, output=${usage.output}, total=${usage.totalTokens}`,
    `Compaction events: ${compactions.map((event) => `${event.kind}@${event.turn}`).join(', ') || 'none'}`,
    `Recall: ${recall.expected.length - recall.missing.length}/${recall.expected.length} facts`,
    `Missing: ${recall.missing.join('; ') || 'none'}`,
    `Quality: ${findQualityError(turns, expectedTurns, recall) ?? 'passed'}`,
  ];
  for (const turn of turns) {
    const start = turn.events.find((event) => event.type === 'agent_start')?.timestamp;
    const end = [...turn.events].reverse().find((event) => event.type === 'agent_end')?.timestamp;
    lines.push(
      '',
      `Turn: ${turn.name}`,
      `Prompt: ${turn.prompt}`,
      `Status: ${turn.timedOut ? 'timed out' : findFinalAssistantError(turn.events) ? 'failed' : 'completed'}`,
      `Elapsed: ${start && end ? formatDuration(end - start) : 'unknown'}`,
      'Tool call timeline',
      ...formatToolTimeline(turn.events),
      'Answer preview',
      truncateOneLine(turn.finalAnswer, 1200)
    );
  }
  return lines.join('\n');
}

async function writeArtifacts(turns: Turn[], report: string) {
  const runSuffix = process.env.BENCH_RUN_INDEX ? `-run-${process.env.BENCH_RUN_INDEX}` : '';
  const events = JSON.stringify(
    turns.map((turn) => ({ name: turn.name, events: turn.events })),
    null,
    2
  );
  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'latest-report.txt'), report),
    writeFile(path.join(OUTPUT_DIR, 'latest-events.json'), events),
    writeFile(path.join(OUTPUT_DIR, 'latest-answer.md'), turns.at(-1)?.finalAnswer ?? ''),
    writeFile(path.join(OUTPUT_DIR, `report${runSuffix}.txt`), report),
  ]);
}
