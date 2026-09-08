import { AppPage } from '@grafana/plugin-e2e';
import type { BrowserContext } from '@playwright/test';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { LoadBrowserSession, verifyLoadSettings } from './loadBrowserSession';
import { runLoadStage, validateLoadConfig, stageBudgetMs } from '../scripts/benchmarks/load.mjs';

test('assistant load benchmark stage', async ({
  browser,
  context,
  page,
  selectors,
  grafanaVersion,
  baseURL,
}, testInfo) => {
  test.skip(process.env.RUN_LOAD_BENCHMARKS !== '1', 'Only benchmark:load explicitly enables load generation');
  const { stage, config: input } = JSON.parse(process.env.BENCH_LOAD_STAGE!);
  const config = validateLoadConfig(input);
  test.setTimeout(stageBudgetMs(config));
  const directory = process.env.BENCH_LOAD_DIR!;
  const expected = JSON.parse(process.env.BENCH_EXPECTED_MODEL!);
  stage.runtimeConfigSha256 = await verifyLoadSettings(page, expected);
  stage.browserVersion = browser.version();
  const auth = await context.storageState();
  const contexts: BrowserContext[] = [];
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error('Interrupted'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const journal = createWriteStream(path.join(directory, 'observations.jsonl'));
  let journalError: Error | undefined;
  journal.on('error', (error) => {
    journalError = error;
    abort.abort(error);
  });
  const record = (value: unknown) => journal.write(JSON.stringify(value) + '\n');
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let cpu = process.cpuUsage();
  let sampledAt = Date.now();
  let sampling = false;
  let sampleTask: Promise<void> | undefined;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const now = Date.now();
      const usage = process.cpuUsage(cpu);
      cpu = process.cpuUsage();
      record({
        kind: 'generator',
        timestamp: now,
        memory: process.memoryUsage(),
        cpuCores: (usage.user + usage.system) / (Math.max(1, now - sampledAt) * 1000),
        eventLoopDelayP95Ms: loopDelay.percentile(95) / 1e6,
      });
      sampledAt = now;
      loopDelay.reset();
      await Promise.all(
        config.metrics.map(async (target: { label: string; url: string; bearerTokenEnv?: string }) => {
          try {
            const token = target.bearerTokenEnv ? process.env[target.bearerTokenEnv] : undefined;
            if (target.bearerTokenEnv && !token) throw new Error('Metrics credential environment variable is unset');
            const response = await fetch(target.url, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            record({ kind: 'endpoint-metrics', label: target.label, timestamp: now, text: await response.text() });
          } catch (error) {
            record({ kind: 'endpoint-metrics', label: target.label, timestamp: now, error: String(error) });
          }
        })
      );
    } finally {
      sampling = false;
    }
  };
  const interval = setInterval(() => {
    if (!sampling) sampleTask = sample();
  }, 5000);
  let writes = Promise.resolve();
  const checkpoint = (state: unknown, session?: { id: string }) => {
    // Snapshot before queueing; all workers share this serialized writer.
    const json = JSON.stringify(session ?? state, null, 2) + '\n';
    const file = session ? path.join(directory, 'sessions', `${session.id}.json`) : path.join(directory, 'stage.json');
    writes = writes.then(async () => {
      await writeFile(`${file}.tmp`, json);
      await rename(`${file}.tmp`, file);
    });
    return writes;
  };
  try {
    await mkdir(path.join(directory, 'sessions'), { recursive: true });
    const drivers: LoadBrowserSession[] = [];
    // Preload before measurement so browser startup does not count as model latency.
    const setupDeadline = Date.now() + config.setupTimeoutMs;
    for (let index = 0; index < stage.concurrency; index++) {
      abort.signal.throwIfAborted();
      const isolated = await browser.newContext({ baseURL, storageState: { cookies: auth.cookies, origins: [] } });
      contexts.push(isolated);
      isolated.setDefaultTimeout(Math.max(1, Math.min(30_000, setupDeadline - Date.now())));
      const sessionPage = await isolated.newPage();
      const navigate = async (target: typeof sessionPage) => {
        const app = new AppPage(
          { page: target, request: isolated.request, selectors, grafanaVersion, testInfo },
          { pluginId: 'grafana-assistant-app' }
        );
        await app.goto({ path: `/${ROUTES.Chat}?piAgentBenchmark=1` });
      };
      const driver = new LoadBrowserSession(sessionPage, expected, config.followUp, record, navigate);
      await driver.install();
      await navigate(sessionPage);
      await driver.ready();
      if (Date.now() > setupDeadline) throw new Error('Browser pool setup timed out');
      drivers.push(driver);
    }
    await sample();
    await runLoadStage({ stage, config, drivers, signal: abort.signal, checkpoint });
    await sampleTask;
    await sample();
    expect(await verifyLoadSettings(page, expected), 'Runtime settings changed during the stage').toBe(
      stage.runtimeConfigSha256
    );
    expect(stage.status, JSON.stringify(stage.errors)).toBe('completed');
    if (journalError) throw journalError;
  } finally {
    clearInterval(interval);
    loopDelay.disable();
    abort.abort(new Error('Stage cleanup'));
    await sampleTask;
    await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
    await writes;
    await new Promise<void>((resolve) => journal.end(resolve));
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
});
