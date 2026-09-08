import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  validateLoadConfig,
  planLoadStages,
  summarizeLoadStage,
  summarizeCapacity,
  runLoadStage,
  occupancy,
  classifyRequestFailure,
} from './load.mjs';
import { suites } from './core.mjs';
import { workloadQualityError } from './workloads.mjs';

test('load configuration and catalog remain separate, strict and bounded', () => {
  const config = validateLoadConfig({});
  assert.equal(planLoadStages(config).length, 10);
  assert.ok(!suites.some((s) => /load/i.test(s.id)));
  for (const invalid of [
    null,
    [],
    { durationMs: 0 },
    { concurrency: [2, 1] },
    { concurrency: [1, 1] },
    { workloads: ['dashboard-editing'] },
    { concurrency: [1.5] },
    { repetitions: -1 },
    { unknown: true },
    { thresholds: { successRate: 1.1 } },
    { thresholds: {} },
    { followUp: 'yes' },
    { metrics: [{ label: 'bad', url: 'https://user:secret@example.test/metrics' }] },
  ]) {
    assert.throws(() => validateLoadConfig(invalid));
  }
});

const request = (startedAt, durationMs, output = 20) => ({
  startedAt,
  durationMs,
  state: 'completed',
  firstContentMs: 20,
  usage: { reported: true, output, input: 10, totalTokens: output + 10 },
});

test('measurement boundaries preserve overlap and failures without inflating throughput', () => {
  const stage = {
    status: 'completed',
    errors: [],
    measurementStartedAt: 1000,
    measurementEndedAt: 2000,
    sessions: [
      { startedAt: 900, finishedAt: 1200, durationMs: 300, status: 'passed', requests: [request(950, 200, 10)] },
      { startedAt: 1100, finishedAt: 1900, durationMs: 800, status: 'passed', requests: [request(1100, 700)] },
      {
        startedAt: 1200,
        finishedAt: 2500,
        durationMs: 1300,
        status: 'timedOut',
        requests: [{ startedAt: 1200, state: 'running' }],
      },
    ],
  };
  const config = validateLoadConfig({ minSessions: 2, thresholds: { successRate: 0.95 } });
  const summary = summarizeLoadStage(stage, config);
  assert.equal(summary.sessions, 2); // Warmup admission excluded, drained timeout included.
  assert.equal(summary.successRate, 0.5);
  assert.equal(summary.sessionDurationMs.p95, 1300);
  assert.equal(summary.successfulSessionsPerMinute, 120); // Two completions in a one-second window.
  assert.equal(summary.terminalOutputTokensPerSecond, 30); // Aggregate wall time, not sum of per-request rates.
  assert.equal(summary.llm.usageMissingRequests, 1);
  assert.equal(summary.llmRequestsInFlight.peak, 2);
  assert.equal(summary.llmRequestsInFlight.mean, 1.65);
  assert.equal(summary.acceptance, 'failed');
  assert.deepEqual(
    occupancy(
      [
        { startedAt: 0, finishedAt: 10 },
        { startedAt: 10, finishedAt: 20 },
      ],
      0,
      20
    ),
    { peak: 1, mean: 1 }
  );
});

test('capacity requires enough samples and all repetitions at every lower tested level', () => {
  const config = validateLoadConfig({ workloads: ['analysis'], concurrency: [1, 2, 4], repetitions: 2 });
  const stages = planLoadStages(config).map((s) => ({ ...s, status: 'completed', summary: { acceptance: 'passed' } }));
  assert.equal(summarizeCapacity(stages, config)[0].allTestedLevelsPassed, true);
  stages.find((s) => s.concurrency === 2).summary.acceptance = 'insufficient-samples';
  assert.equal(summarizeCapacity(stages, config)[0].highestPassingConcurrency, 1);
});

test('scheduler replaces fast conversations independently and drains every worker', async () => {
  const config = validateLoadConfig({
    concurrency: [2],
    durationMs: 160,
    rampUpMs: 0,
    warmupMs: 30,
    drainMs: 100,
    minSessions: 1,
  });
  const counts = [0, 0];
  let active = 0,
    peak = 0;
  const drivers = [10, 45].map((ms, index) => ({
    reset: async () => {},
    run: async (session, signal) => {
      counts[index]++;
      active++;
      peak = Math.max(peak, active);
      try {
        await delay(ms, undefined, { signal });
        session.status = 'passed';
        session.requests = [request(session.startedAt, ms)];
      } finally {
        active--;
      }
    },
  }));
  const stage = await runLoadStage({
    stage: { workload: 'analysis' },
    config,
    drivers,
    signal: new AbortController().signal,
  });
  assert.equal(peak, 2);
  assert.ok(counts[0] > counts[1]);
  assert.equal(active, 0);
  assert.equal(stage.status, 'completed');
  assert.ok(stage.sessions.every((s) => s.status === 'passed'));
  assert.ok(stage.summary.sessions < stage.sessions.length);
});

test('drain deadline aborts hung work and retains the timeout in the denominator', async () => {
  const config = validateLoadConfig({
    concurrency: [1],
    durationMs: 30,
    rampUpMs: 0,
    warmupMs: 0,
    drainMs: 30,
    minSessions: 1,
  });
  let stopped = false;
  const driver = {
    reset: async () => {},
    run: async (_session, signal) => {
      try {
        await delay(1000, undefined, { signal });
      } finally {
        stopped = true;
      }
    },
  };
  const stage = await runLoadStage({
    stage: { workload: 'analysis' },
    config,
    drivers: [driver],
    signal: new AbortController().signal,
  });
  assert.equal(stopped, true);
  assert.equal(stage.status, 'completed');
  assert.equal(stage.sessions[0].status, 'timedOut');
  assert.equal(stage.summary.successRate, 0);
  assert.equal(stage.summary.acceptance, 'failed');
});

test('interruption checkpoints active sessions; a broken reset invalidates concurrency', async () => {
  const config = validateLoadConfig({ concurrency: [1], durationMs: 100, rampUpMs: 0, warmupMs: 0, drainMs: 30 });
  const controller = new AbortController();
  const driver = {
    reset: async () => {},
    run: async (_s, signal) => {
      controller.abort();
      await delay(10, undefined, { signal });
    },
  };
  const stage = await runLoadStage({
    stage: { workload: 'analysis' },
    config,
    drivers: [driver],
    signal: controller.signal,
  });
  assert.equal(stage.status, 'interrupted');
  assert.equal(stage.sessions[0].status, 'interrupted');
  const broken = await runLoadStage({
    stage: { workload: 'analysis' },
    config,
    signal: new AbortController().signal,
    drivers: [
      {
        run: async (s) => {
          s.status = 'passed';
        },
        reset: async () => {
          throw new Error('Closed browser');
        },
      },
    ],
  });
  assert.equal(broken.status, 'failed');
  assert.equal(broken.summary.acceptance, 'invalid');
});

test('structured upstream errors classify rate limiting even with proxy HTTP 200', () => {
  assert.equal(classifyRequestFailure({ httpStatus: 200, upstreamStatus: 429 }), 'rate-limit');
  assert.equal(classifyRequestFailure({ httpStatus: 200, upstreamStatus: 503 }), 'upstream');
  assert.equal(classifyRequestFailure({ httpStatus: 200, error: 'context deadline exceeded' }), 'timeout');
  assert.equal(classifyRequestFailure({ httpStatus: 200, error: 'unknown' }), 'stream');
});

test('workload gates reject empty and truncated answers, and require successful specialist evidence', () => {
  const events = [
    { type: 'tool_execution_start', toolName: 'run_investigation_agent', toolCallId: 'a' },
    {
      type: 'tool_execution_end',
      toolCallId: 'a',
      result: { details: { toolCalls: [{ name: 'query_prometheus', status: 'completed' }] } },
    },
    {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'vm-web-01 /render/report 500 CPU' }] },
    },
  ];
  assert.equal(workloadQualityError('analysis', events), undefined);
  events[2].message.stopReason = 'length';
  assert.match(workloadQualityError('analysis', events), /length/);
  assert.match(workloadQualityError('analysis', []), /Empty/);
});
