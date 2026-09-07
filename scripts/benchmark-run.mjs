#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process, { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import { ensureModelServer, prepareFixtureEnvironment, inspectPreparedStack } from './benchmarks/prepare.mjs';
import { resolveBenchmarkApiKey } from './benchmarks/profile.mjs';
import {
  suites,
  validateConfig,
  discoverCases,
  summarizeRun,
  summarizeRequests,
  summarizeEvents,
  readCaseResult,
} from './benchmarks/core.mjs';

if (existsSync('.env')) {
  loadEnvFile('.env');
}
const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    output: { type: 'string', default: 'artifacts/benchmark-runs' },
    prepare: { type: 'boolean', default: false },
    'reuse-stack': { type: 'boolean', default: false },
    'start-model-server': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (values.help || !values.config) {
  console.log(
    'Usage: npm run benchmark:run -- --config benchmarks/qwen-local.example.json [--prepare | --reuse-stack] [--start-model-server] [--dry-run] [--output DIR]'
  );
  console.log(
    'Prepares/seeds Grafana as needed. --prepare forces fresh fixtures; --reuse-stack skips preparation. Model startup requires --start-model-server and a localServer profile.'
  );
  process.exit(values.help ? 0 : 1);
}
if (values.prepare && values['reuse-stack']) {
  throw new Error('Use either --prepare or --reuse-stack');
}
const prepare = !values['reuse-stack'];
const config = validateConfig(JSON.parse(await readFile(values.config, 'utf8')));
const selectedSuites = suites
  .filter((suite) => config.suites.includes(suite.id))
  .map((suite) => ({ ...suite, timeoutMs: config.timeoutMs ?? suite.timeoutMs }));
const grafanaUrl = process.env.GRAFANA_URL ?? 'http://localhost:3001';
// Inherited BENCH_* knobs must not silently change the comparison workload.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BENCH_')));
Object.assign(env, {
  GRAFANA_URL: grafanaUrl,
  E2E_PLUGIN_ID: 'grafana-assistant-app',
  RUN_AGENT_BENCHMARKS: '1',
  PI_OPENAI_BASE_URL: config.model.baseUrl,
  PI_DEFAULT_MODEL: config.model.id,
  PI_OPENAI_PROTOCOL: config.model.protocol,
  PI_THINKING_LEVEL: config.model.thinkingLevel,
  PI_THINKING_FORMAT: config.model.thinkingFormat,
  BENCH_LLM_BASE_URL: config.model.baseUrl,
  BENCH_EXPECTED_MODEL: JSON.stringify(config.model),
});
const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const directory = path.resolve(values.output, id);
await mkdir(directory, { recursive: true });
let child;
let interrupted = false;
let lock;
let modelServer;
const abort = new AbortController();
const lockPath = path.resolve('artifacts/benchmark-run.lock');
const interrupt = () => {
  interrupted = true;
  abort.abort();
  if (child?.pid) {
    try {
      if (process.platform === 'win32') {
        child.kill('SIGINT');
      } else {
        process.kill(-child.pid, 'SIGINT');
      }
    } catch {
      /* The child may have finished between the signal and this handler. */
    }
  }
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const started = Date.now();
const run = {
  schemaVersion: 1,
  id,
  status: 'running',
  startedAt: new Date(started).toISOString(),
  config,
  environment: {
    grafanaUrl,
    pluginId: env.E2E_PLUGIN_ID,
    prepared: false,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    runnerHost: os.hostname(),
    runnerCpu: os.cpus()[0]?.model,
    runnerMemoryBytes: os.totalmem(),
    gitCommit: git(['rev-parse', 'HEAD']),
    gitDirty: Boolean(git(['status', '--porcelain'])),
    sourceSha256: await sourceHash(),
  },
  methodology: {
    workers: 1,
    retries: 0,
    order: 'repetition, suite, case',
    independentBrowserPerCase: true,
    cachePolicy: 'uncontrolled; provider/server caches are not reset',
    latencyScope: 'browser to Grafana LLM proxy, including upstream inference and transport',
    usageScope:
      'all captured proxy calls, including specialists; backend-internal retries are not individually visible',
    percentileMethod: 'nearest rank',
  },
  cases: [],
  errors: [],
};
try {
  if (!values['dry-run']) {
    await mkdir(path.dirname(lockPath), { recursive: true });
    try {
      lock = await open(lockPath, 'wx');
    } catch {
      throw new Error(
        `Another benchmark may be active. Inspect ${lockPath}; remove it only if its process has stopped.`
      );
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid, directory }));
    const apiKey = await resolveBenchmarkApiKey(config);
    if (apiKey !== undefined) {
      env.OPENAI_API_KEY = apiKey;
    }
  }
  const discoveryPath = path.join(directory, 'discovery.json');
  const discovery = await command(
    process.execPath,
    [
      'node_modules/@playwright/test/cli.js',
      'test',
      ...selectedSuites.map((suite) => `tests/${suite.file}`),
      '--project=chromium',
      '--list',
      '--reporter=json',
      '--retries=0',
    ],
    { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: discoveryPath },
    path.join(directory, 'discovery.log')
  );
  if (discovery !== 0) {
    throw new Error('Benchmark discovery failed; see discovery.log');
  }
  const cases = discoverCases(JSON.parse(await readFile(discoveryPath, 'utf8')), selectedSuites);
  for (const suite of selectedSuites) {
    if (!cases.some((entry) => entry.suite === suite.id)) {
      throw new Error(`No cases discovered for ${suite.id}`);
    }
  }
  for (let repetition = 1; repetition <= config.repetitions; repetition++) {
    run.cases.push(...cases.map((entry) => ({ ...entry, repetition, status: 'not-run' })));
  }
  await save();
  console.log(`[benchmark-run] ${run.cases.length} cases; results: ${path.join(directory, 'run.json')}`);
  if (values['dry-run']) {
    run.status = 'planned';
  } else {
    modelServer = await ensureModelServer(
      config,
      env,
      directory,
      abort.signal,
      (message) => console.log(`[benchmark-run] ${message}`),
      values['start-model-server']
    );
    run.environment.localModelServer = modelServer.metadata;
    if (prepare) {
      const grafana = new URL(grafanaUrl);
      if (!['localhost', '127.0.0.1'].includes(grafana.hostname) || grafana.port !== '3001') {
        throw new Error(
          'Automatic stack preparation targets localhost:3001. Use --reuse-stack for another Grafana installation.'
        );
      }
      const statePath = path.resolve('artifacts/benchmark-stack.json');
      let state;
      try {
        state = JSON.parse(await readFile(statePath, 'utf8'));
      } catch {
        /* First prepared run. */
      }
      const reuse = values.prepare
        ? { reusable: false, reason: 'Fresh preparation explicitly requested' }
        : await inspectPreparedStack(
            state,
            config.model,
            run.environment.sourceSha256,
            grafanaUrl,
            run.cases,
            env,
            abort.signal
          );
      if (reuse.reusable) {
        console.log('[benchmark-run] Reusing verified Grafana configuration and valid fixture history.');
        run.environment.fixtures = { ...state.fixtures, reused: true };
        if (reuse.seedSamples) {
          console.log('[benchmark-run] Restoring missing Grafana sample dashboards/alerts.');
          const code = await command(
            process.execPath,
            ['scripts/seed-dev-samples.mjs'],
            env,
            path.join(directory, 'prepare.log')
          );
          if (code !== 0) {
            throw new Error('Grafana sample seeding failed; see prepare.log');
          }
        }
      } else {
        const prepared = await prepareFixtureEnvironment(directory, id, run.cases, env);
        Object.assign(env, prepared.env);
        run.environment.fixtures = { ...prepared.fixtures, reused: false };
        await save();
        console.log(
          `[benchmark-run] ${reuse.reason}. Building and seeding fresh isolated fixtures; progress is in prepare.log.`
        );
        const code = await command(
          'mise',
          ['run', 'dev:reload:variant:seed'],
          env,
          path.join(directory, 'prepare.log')
        );
        if (code !== 0) {
          throw new Error('Stack preparation failed; see prepare.log');
        }
        run.environment.prepared = true;
      }
    }
    const health = await fetch(`${grafanaUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (!health.ok) {
      throw new Error(`Grafana health check failed: HTTP ${health.status}`);
    }
    const { version, commit } = await health.json();
    run.environment.grafana = { version, commit };
    if (prepare) {
      const query = 'max(count_over_time(http_requests_total[6h]))';
      const response = await fetch(`http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(query)}`, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
      });
      const data = await response.json();
      const samples = Number(data.data?.result?.[0]?.value?.[1] ?? 0);
      if (!response.ok || data.status !== 'success' || samples < 300) {
        throw new Error(
          'Prepared Prometheus history is incomplete; expected at least 300 samples per HTTP series over six hours.'
        );
      }
      run.environment.fixtures.validation = { query, samples, checkedAt: new Date().toISOString() };
      const state = { grafanaUrl, sourceSha256: run.environment.sourceSha256, fixtures: run.environment.fixtures };
      await writeFile(path.resolve('artifacts/benchmark-stack.json.tmp'), JSON.stringify(state, null, 2));
      await rename(path.resolve('artifacts/benchmark-stack.json.tmp'), path.resolve('artifacts/benchmark-stack.json'));
    }
    for (const entry of run.cases) {
      if (interrupted) {
        break;
      }
      const relative = `cases/${entry.repetition}-${entry.id}`;
      const caseDir = path.join(directory, relative);
      await mkdir(caseDir, { recursive: true });
      entry.artifacts = relative;
      entry.status = 'running';
      entry.startedAt = new Date().toISOString();
      await save();
      console.log(`[benchmark-run] ${entry.repetition}/${config.repetitions} ${entry.title}`);
      const caseStarted = Date.now();
      try {
        const code = await command(
          process.execPath,
          [
            'node_modules/@playwright/test/cli.js',
            'test',
            `${entry.file}:${entry.line}`,
            '--project=chromium',
            '--workers=1',
            '--retries=0',
            '--max-failures=0',
            '--reporter=line,json',
            '--output',
            path.join(caseDir, 'playwright'),
          ],
          {
            ...env,
            BENCH_CASE_DIR: caseDir,
            BENCH_RUN_INDEX: String(entry.repetition),
            BENCH_TIMEOUT_MS: String(entry.timeoutMs),
            BENCH_TEST_TIMEOUT_MS: String(entry.timeoutMs + 90_000),
            PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(caseDir, 'playwright.json'),
          },
          path.join(caseDir, 'console.log')
        );
        entry.exitCode = code;
        const report = JSON.parse(await readFile(path.join(caseDir, 'playwright.json'), 'utf8'));
        const result = readCaseResult(report);
        entry.status = result.status;
        entry.durationMs = result.duration;
        entry.errors = result.errors;
        if (code !== 0 && entry.status === 'passed') {
          entry.status = 'failed';
        }
      } catch (error) {
        entry.status = interrupted ? 'interrupted' : 'failed';
        entry.errors = [{ message: error.message }];
      } finally {
        entry.wallDurationMs = Date.now() - caseStarted;
        try {
          entry.capture = JSON.parse(await readFile(path.join(caseDir, 'capture.json'), 'utf8'));
          entry.llm = summarizeRequests(entry.capture.requests);
          entry.agent = summarizeEvents(entry.capture.events ?? []);
        } catch {
          entry.captureMissing = true;
          if (entry.status === 'passed') {
            entry.status = 'failed';
          }
        }
        await save();
      }
    }
    run.status = interrupted
      ? 'interrupted'
      : run.cases.every((entry) => entry.status === 'passed')
        ? 'passed'
        : 'failed';
  }
} catch (error) {
  run.status = interrupted ? 'interrupted' : 'failed';
  run.errors.push({ message: error.message });
  console.error(`[benchmark-run] ${error.message}`);
} finally {
  await modelServer?.stop();
  run.finishedAt = new Date().toISOString();
  run.durationMs = Date.now() - started;
  await save();
  if (lock) {
    await lock.close();
    await unlink(lockPath);
  }
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
console.log(
  `[benchmark-run] ${run.status}: ${run.summary.passed}/${run.summary.planned} passed. ${path.join(directory, 'run.json')}`
);
process.exitCode = ['passed', 'planned'].includes(run.status) ? 0 : interrupted ? 130 : 1;

async function save() {
  run.summary = summarizeRun(run.cases);
  const temporary = path.join(directory, 'run.json.tmp');
  await writeFile(temporary, JSON.stringify(run, null, 2) + '\n');
  await rename(temporary, path.join(directory, 'run.json'));
}
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
async function sourceHash() {
  const files = (git(['ls-files', '--cached', '--others', '--exclude-standard']) ?? '')
    .split('\n')
    .filter((file) =>
      /^(src\/|pkg\/|tests\/|scripts\/|provisioning\/|dev\/|\.agents\/skills\/|docker|playwright|package|mise)/.test(
        file
      )
    );
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    hash.update(file);
    try {
      hash.update(await readFile(file));
    } catch {
      hash.update('<missing>');
    }
  }
  return hash.digest('hex');
}
function command(executable, args, commandEnv, logPath) {
  if (interrupted) {
    return Promise.resolve(130);
  }
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logPath);
    child = spawn(executable, args, {
      env: commandEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    child.stdout.on('data', (data) => log.write(data));
    child.stderr.on('data', (data) => log.write(data));
    child.on('error', reject);
    child.on('close', (code) => {
      child = undefined;
      log.end(() => resolve(code ?? 130));
    });
    log.on('error', reject);
  });
}
