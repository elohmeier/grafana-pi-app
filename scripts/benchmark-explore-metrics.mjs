#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';

const child = spawn(process.execPath, ['scripts/benchmark-agent.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    BENCH_LABEL: process.env.BENCH_LABEL ?? 'explore metrics benchmark',
    BENCH_LOG_PREFIX: process.env.BENCH_LOG_PREFIX ?? 'query-benchmark',
    BENCH_TEST_FILE: process.env.BENCH_TEST_FILE ?? 'tests/agentExploreMetricsBenchmark.spec.ts',
    BENCH_TIMEOUT_MS: process.env.BENCH_TIMEOUT_MS ?? '150000',
  },
});

child.on('error', (error) => {
  throw error;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
