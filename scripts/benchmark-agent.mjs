#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import process, { loadEnvFile } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const LLM_BASE_URL = process.env.BENCH_LLM_BASE_URL ?? process.env.PI_OPENAI_BASE_URL ?? 'http://127.0.0.1:8080/v1';
const GRAFANA_URL = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const GRAFANA_START_TIMEOUT_MS = readPositiveInteger(process.env.GRAFANA_START_TIMEOUT_MS, 120_000);
const LLAMA_START_TIMEOUT_MS = readPositiveInteger(process.env.LLAMA_START_TIMEOUT_MS, 15 * 60_000);
const BENCH_TIMEOUT_MS = readPositiveInteger(process.env.BENCH_TIMEOUT_MS, 180_000);
const BENCH_RUNS = readPositiveInteger(process.env.BENCH_RUNS, 1);
const BENCH_TEST_FILE = process.env.BENCH_TEST_FILE ?? 'tests/agentBenchmark.spec.ts';
const BENCH_TEST_GREP = process.env.BENCH_TEST_GREP;
const BENCH_LABEL = process.env.BENCH_LABEL ?? 'agent benchmark';
const BENCH_LOG_PREFIX = process.env.BENCH_LOG_PREFIX ?? 'agent-benchmark';
const BENCH_DEV_RELOAD_TASK = process.env.BENCH_DEV_RELOAD_TASK ?? 'dev:reload';
const BENCH_SEED_SAMPLES = process.env.BENCH_SEED_SAMPLES === undefined || process.env.BENCH_SEED_SAMPLES !== '0';
const HISTORY_FUTURE_SECONDS = process.env.HISTORY_FUTURE_SECONDS ?? process.env.BENCH_HISTORY_FUTURE_SECONDS ?? '3600';
const MANAGE_LOCAL_LLAMA =
  process.env.BENCH_MANAGE_LLAMA === undefined
    ? isLocalModelEndpoint(LLM_BASE_URL)
    : process.env.BENCH_MANAGE_LLAMA !== '0';

const LLAMA_COMMAND = 'llama-server';
const LLAMA_ARGS = [
  '-hf',
  'ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M',
  '--jinja',
  '--temp',
  '0.6',
  '--top-p',
  '0.95',
  '--top-k',
  '20',
  '--min-p',
  '0.00',
  '--host',
  '0.0.0.0',
  '--port',
  '8080',
];

let llamaProcess;
let llamaProcessError;

installCleanupHandlers();

try {
  log('Resetting Docker Compose demo volumes.');
  // The `logs` and `sql` profiles include seeders, which mount the Prometheus volume; without the
  // profiles, their stopped containers keep that volume from being removed.
  await runCommand('docker', ['compose', '--profile', 'logs', '--profile', 'sql', 'down', '-v', '--remove-orphans']);

  log(`Rebuilding plugin artifacts and starting the local stack with mise run ${BENCH_DEV_RELOAD_TASK}.`);
  await runCommand('mise', ['run', BENCH_DEV_RELOAD_TASK], {
    env: {
      ...process.env,
      HISTORY_FUTURE_SECONDS,
    },
  });
  await waitForGrafana();
  if (BENCH_SEED_SAMPLES) {
    log('Seeding Grafana development samples before benchmark run.');
    await runCommand(process.execPath, ['scripts/seed-dev-samples.mjs'], {
      env: {
        ...process.env,
        GRAFANA_URL,
      },
    });
  }

  if (!MANAGE_LOCAL_LLAMA) {
    log(`Using externally configured OpenAI-compatible endpoint at ${LLM_BASE_URL}; not starting llama-server.`);
  } else if (await isModelServerReady()) {
    log(`Reusing existing local OpenAI-compatible model server at ${LLM_BASE_URL}.`);
  } else {
    log(`Starting llama-server at ${LLM_BASE_URL}.`);
    llamaProcess = spawn(LLAMA_COMMAND, LLAMA_ARGS, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    llamaProcess.once('error', (error) => {
      llamaProcessError = error;
    });
    prefixStream(llamaProcess.stdout, '[llama] ');
    prefixStream(llamaProcess.stderr, '[llama] ');

    await waitForModelServer();
  }

  for (let runIndex = 1; runIndex <= BENCH_RUNS; runIndex++) {
    const runLabel = BENCH_RUNS > 1 ? ` run ${runIndex}/${BENCH_RUNS}` : '';
    log(`Running ${BENCH_LABEL}${runLabel} against ${GRAFANA_URL} with ${BENCH_TIMEOUT_MS}ms agent timeout.`);
    const playwrightArgs = [
      'playwright',
      'test',
      BENCH_TEST_FILE,
      '--project=chromium',
      '--workers=1',
      '--reporter=line',
    ];
    if (BENCH_TEST_GREP) {
      playwrightArgs.push('--grep', BENCH_TEST_GREP);
    }
    await runCommand('npx', playwrightArgs, {
      env: {
        ...process.env,
        RUN_AGENT_BENCHMARKS: '1',
        BENCH_TIMEOUT_MS: String(BENCH_TIMEOUT_MS),
        BENCH_RUN_INDEX: String(runIndex),
        BENCH_LLM_BASE_URL: LLM_BASE_URL,
        GRAFANA_URL,
      },
    });
  }
} finally {
  cleanupLlamaProcess();
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
      ...options,
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(`${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`)
      );
    });
  });
}

async function isModelServerReady() {
  try {
    const response = await fetch(`${LLM_BASE_URL}/models`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function isLocalModelEndpoint(rawURL) {
  try {
    const { hostname } = new URL(rawURL);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === 'host.docker.internal'
    );
  } catch {
    return false;
  }
}

async function waitForModelServer() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < LLAMA_START_TIMEOUT_MS) {
    if (llamaProcessError) {
      throw llamaProcessError;
    }

    if (llamaProcess && (llamaProcess.exitCode !== null || llamaProcess.signalCode !== null)) {
      throw new Error(`llama-server exited before becoming ready with code ${llamaProcess.exitCode}.`);
    }

    if (await isModelServerReady()) {
      log(`llama-server is ready after ${Date.now() - startedAt}ms.`);
      return;
    }

    await delay(2000);
  }

  throw new Error(`llama-server did not become ready within ${LLAMA_START_TIMEOUT_MS}ms.`);
}

async function waitForGrafana() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < GRAFANA_START_TIMEOUT_MS) {
    try {
      const response = await fetch(`${GRAFANA_URL}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        log(`Grafana is ready after ${Date.now() - startedAt}ms.`);
        return;
      }
    } catch {
      // Retry until Grafana is ready or the startup timeout expires.
    }

    await delay(1000);
  }

  throw new Error(`Grafana did not become ready within ${GRAFANA_START_TIMEOUT_MS}ms at ${GRAFANA_URL}.`);
}

function prefixStream(stream, prefix) {
  stream.setEncoding('utf8');
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length > 0) {
        process.stdout.write(`${prefix}${line}\n`);
      }
    }
  });
  stream.on('end', () => {
    if (pending.length > 0) {
      process.stdout.write(`${prefix}${pending}\n`);
    }
  });
}

function cleanupLlamaProcess() {
  if (!llamaProcess || !llamaProcess.pid || llamaProcess.exitCode !== null || llamaProcess.signalCode !== null) {
    return;
  }

  log('Stopping llama-server started by this benchmark.');
  try {
    process.kill(-llamaProcess.pid, 'SIGTERM');
  } catch {
    try {
      llamaProcess.kill('SIGTERM');
    } catch {
      // Ignore cleanup failures during process exit.
    }
  }
}

function installCleanupHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      cleanupLlamaProcess();
      process.kill(process.pid, signal);
    });
  }

  process.once('exit', cleanupLlamaProcess);
}

function readPositiveInteger(value, fallback) {
  const parsed = value ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function log(message) {
  process.stdout.write(`[${BENCH_LOG_PREFIX}] ${message}\n`);
}
