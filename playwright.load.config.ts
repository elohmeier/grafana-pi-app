import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Explicit config plus environment gate: ordinary e2e and benchmark discovery
// never opt into a load test, even when RUN_AGENT_BENCHMARKS=1.
export default defineConfig({
  ...base,
  testIgnore: [],
  grepInvert: undefined,
  retries: 0,
  workers: 1,
  use: { ...base.use, trace: 'off', video: 'off', baseURL: process.env.GRAFANA_URL ?? 'http://localhost:3001' },
  projects: base.projects?.map((project) =>
    project.name === 'chromium'
      ? {
          ...project,
          testMatch: ['**/agentLoadBenchmark.spec.ts'],
          testIgnore: [],
        }
      : project
  ),
});
