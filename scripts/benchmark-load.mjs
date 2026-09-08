#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process, { loadEnvFile } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { validateConfig } from './benchmarks/core.mjs';
import { resolveBenchmarkApiKey } from './benchmarks/profile.mjs';
import { ensureModelServer } from './benchmarks/prepare.mjs';
import { prepareStack, git, sourceHash } from './benchmarks/runtime.mjs';
import {
  validateLoadConfig,
  planLoadStages,
  stageBudgetMs,
  summarizeCapacity,
  formatLoadReport,
} from './benchmarks/load.mjs';

if (existsSync('.env')) {
  loadEnvFile('.env');
}
const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    'load-config': { type: 'string' },
    output: { type: 'string', default: 'artifacts/benchmark-load-runs' },
    prepare: { type: 'boolean', default: false },
    'reuse-stack': { type: 'boolean', default: false },
    'start-model-server': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.config || !values['load-config']) {
  console.log(
    'Usage: npm run benchmark:load -- --config MODEL.json --load-config LOAD.json [--prepare | --reuse-stack] [--start-model-server] [--dry-run] [--output DIR]'
  );
  process.exit(values.help ? 0 : 1);
}
if (values.prepare && values['reuse-stack']) {
  throw new Error('Use either --prepare or --reuse-stack');
}
const config = validateConfig(JSON.parse(await readFile(values.config, 'utf8')));
if (config.model.protocol === 'auto') {
  throw new Error('Load testing requires an explicit chat-completions or responses protocol');
}
const load = validateLoadConfig(JSON.parse(await readFile(values['load-config'], 'utf8')));
const grafanaUrl = process.env.GRAFANA_URL ?? 'http://localhost:3001';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BENCH_')));
for (const target of load.metrics) {
  if (target.bearerTokenEnv && process.env[target.bearerTokenEnv] !== undefined) {
    env[target.bearerTokenEnv] = process.env[target.bearerTokenEnv];
  }
}
Object.assign(env, {
  GRAFANA_URL: grafanaUrl,
  E2E_PLUGIN_ID: 'grafana-assistant-app',
  RUN_AGENT_BENCHMARKS: '1',
  RUN_LOAD_BENCHMARKS: '1',
  PI_OPENAI_BASE_URL: config.model.baseUrl,
  PI_DEFAULT_MODEL: config.model.id,
  PI_OPENAI_PROTOCOL: config.model.protocol,
  PI_THINKING_LEVEL: config.model.thinkingLevel,
  PI_THINKING_FORMAT: config.model.thinkingFormat,
  BENCH_EXPECTED_MODEL: JSON.stringify(config.model),
});
const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const directory = path.resolve(values.output, id);
await mkdir(directory, { recursive: true });
const abort = new AbortController();
let child, lock, modelServer;
const lockPath = path.resolve('artifacts/benchmark-run.lock');
const interrupt = () => abort.abort(new Error('Interrupted'));
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const started = Date.now();
const run = {
  schemaVersion: 1,
  kind: 'assistant-load',
  id,
  status: 'running',
  startedAt: new Date(started).toISOString(),
  config,
  load,
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
    driver: 'isolated-browser-context-per-virtual-user',
    model: 'closed',
    retries: 0,
    workloadOrder: 'repetition, workload, increasing concurrency',
    cachePolicy: 'uncontrolled; warmup excluded from latency cohorts',
    latencyScope: 'session admission to agent completion, including Grafana tools and transport',
    requestLatencyScope: 'browser fetch to Grafana proxy terminal event',
    throughputScope:
      'completions in measurement window, including warmup admissions; tokens accounted at terminal event',
    percentileMethod: 'nearest rank',
    modelProfileWorkloadFields: 'suites, repetitions and timeoutMs are ignored; load config defines workload',
  },
  stages: planLoadStages(load),
  errors: [],
};
try {
  await save();
  console.log(
    `[benchmark-load] ${run.stages.length} stages; maximum scheduled browser time ${((run.stages.length * (stageBudgetMs(load) + load.cooldownMs)) / 60000).toFixed(1)} minutes. ${directory}`
  );
  if (values['dry-run']) {
    run.status = 'planned';
  } else {
    await mkdir(path.dirname(lockPath), { recursive: true });
    try {
      lock = await open(lockPath, 'wx');
    } catch {
      throw new Error(
        `Another benchmark may be active. Inspect ${lockPath}; remove it only if its process has stopped.`
      );
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid, directory }));
    const key = await resolveBenchmarkApiKey(config);
    if (key !== undefined) {
      env.OPENAI_API_KEY = key;
    }
    modelServer = await ensureModelServer(
      config,
      env,
      directory,
      abort.signal,
      console.log,
      values['start-model-server']
    );
    run.environment.localModelServer = modelServer.metadata;
    await prepareStack({
      prepare: !values['reuse-stack'],
      values,
      config,
      grafanaUrl,
      run,
      cases: run.stages.map(() => ({ timeoutMs: stageBudgetMs(load) + load.cooldownMs })),
      env,
      abort,
      directory,
      id,
      command,
      save,
    });
    for (const stage of run.stages) {
      abort.signal.throwIfAborted();
      stage.artifacts = `stages/${stage.id}`;
      const stageDir = path.join(directory, stage.artifacts);
      await mkdir(stageDir, { recursive: true });
      stage.status = 'running';
      stage.startedAt = Date.now();
      await save();
      console.log(`[benchmark-load] ${stage.id}: ${stage.concurrency} concurrent ${stage.workload} sessions`);
      try {
        const code = await command(
          process.execPath,
          [
            'node_modules/@playwright/test/cli.js',
            'test',
            '--config=playwright.load.config.ts',
            '--project=chromium',
            '--workers=1',
            '--retries=0',
            '--reporter=line,json',
            '--output',
            path.join(stageDir, 'playwright'),
          ],
          {
            ...env,
            BENCH_LOAD_STAGE: JSON.stringify({ stage, config: load }),
            BENCH_LOAD_DIR: stageDir,
            PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(stageDir, 'playwright.json'),
          },
          path.join(stageDir, 'console.log'),
          stageBudgetMs(load) + 30_000
        );
        Object.assign(stage, JSON.parse(await readFile(path.join(stageDir, 'stage.json'), 'utf8')));
        // Raw sessions remain in their own artifacts. Keep the run index compact.
        delete stage.sessions;
        stage.exitCode = code;
        const baseline = run.stages.find((entry) => entry.status === 'completed' && entry.runtimeConfigSha256);
        if (baseline && baseline.runtimeConfigSha256 !== stage.runtimeConfigSha256) {
          throw new Error('Runtime settings changed between load stages');
        }
        if (code !== 0) {
          stage.status = abort.signal.aborted ? 'interrupted' : 'failed';
        }
      } catch (error) {
        stage.status = abort.signal.aborted ? 'interrupted' : 'failed';
        stage.errors = [{ message: error.message }];
      }
      await save();
      if (stage.status !== 'completed') {
        break;
      } // Infrastructure failure invalidates subsequent stages.
      await delay(load.cooldownMs, undefined, { signal: abort.signal });
    }
    run.status = abort.signal.aborted
      ? 'interrupted'
      : run.stages.every((s) => s.status === 'completed')
        ? 'completed'
        : 'failed';
  }
} catch (error) {
  run.status = abort.signal.aborted ? 'interrupted' : 'failed';
  run.errors.push({ message: error.message });
  console.error(`[benchmark-load] ${error.message}`);
} finally {
  try {
    await modelServer?.stop();
  } finally {
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - started;
    try {
      await save();
    } finally {
      if (lock) {
        await lock.close();
        await unlink(lockPath);
      }
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  }
}
console.log(`[benchmark-load] ${run.status}. Report: ${path.join(directory, 'report.md')}`);
// Saturation is an experimental outcome. Infrastructure failures exit 1; interruption exits 130.
process.exitCode = ['planned', 'completed'].includes(run.status) ? 0 : run.status === 'interrupted' ? 130 : 1;

async function save() {
  run.capacity = summarizeCapacity(run.stages, load);
  await writeFile(path.join(directory, 'run.json.tmp'), JSON.stringify(run, null, 2) + '\n');
  await rename(path.join(directory, 'run.json.tmp'), path.join(directory, 'run.json'));
  await writeFile(path.join(directory, 'report.md'), formatLoadReport(run));
}

function command(executable, args, commandEnv, logPath, timeoutMs = 30 * 60_000) {
  abort.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logPath);
    child = spawn(executable, args, {
      env: commandEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const current = child;
    let escalation;
    const kill = (signal) => {
      try {
        if (process.platform === 'win32') {
          current.kill(signal);
        } else {
          process.kill(-current.pid, signal);
        }
      } catch {
        /* Already stopped. */
      }
    };
    const stop = () => {
      kill('SIGINT');
      escalation ??= setTimeout(() => kill('SIGKILL'), 5000);
    };
    const timer = setTimeout(stop, timeoutMs);
    abort.signal.addEventListener('abort', stop, { once: true });
    current.stdout.on('data', (data) => log.write(data));
    current.stderr.on('data', (data) => log.write(data));
    current.on('error', reject);
    log.on('error', (error) => {
      stop();
      reject(error);
    });
    current.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      abort.signal.removeEventListener('abort', stop);
      child = undefined;
      log.end(() => resolve(code ?? 130));
    });
  });
}
