import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  validateConfig,
  distribution,
  summarizeRequests,
  summarizeRun,
  discoverCases,
  readCaseResult,
  suites,
  summarizeEvents,
  compactEvents,
} from './core.mjs';
import { checkModelSettings } from './capture.mjs';

const example = JSON.parse(await readFile(new URL('../../benchmarks/qwen-local.example.json', import.meta.url)));

test('scenario event attachments retain timing and errors without retaining transcripts or nested usage', () => {
  const events = compactEvents([
    { type: 'agent_start', timestamp: 100 },
    { type: 'message_update', timestamp: 120, message: { content: 'private text' } },
    { type: 'tool_execution_start', timestamp: 150, toolCallId: 't', toolName: 'run_query_agent', args: {} },
    { type: 'tool_execution_end', timestamp: 250, toolCallId: 't', isError: true, result: { usage: 123 } },
    { type: 'agent_end', timestamp: 300, messages: ['private text'] },
  ]);
  assert.equal(events.length, 4);
  assert.ok(!JSON.stringify(events).includes('private text'));
  assert.ok(!JSON.stringify(events).includes('usage'));
  const summary = summarizeEvents(events);
  assert.equal(summary.durationMs.mean, 200);
  assert.equal(summary.firstToolMs.mean, 50);
  assert.equal(summary.toolDurationMs.mean, 100);
  assert.equal(summary.failedTopLevelTools, 1);
});

test('validates profiles without silently normalizing unsupported reasoning levels', () => {
  const config = validateConfig(example);
  assert.equal(config.suites.length, 12);
  assert.equal(
    validateConfig({ ...example, model: { ...example.model, thinkingLevel: 'xhigh' } }).model.thinkingLevel,
    'xhigh'
  );
  for (const thinkingLevel of ['minimal', 'typo']) {
    assert.throws(() => validateConfig({ ...example, model: { ...example.model, thinkingLevel } }));
  }
  assert.throws(() =>
    validateConfig({ ...example, model: { ...example.model, baseUrl: 'https://user:secret@example.org/v1' } })
  );
  assert.throws(() => validateConfig({ ...example, apiKey: 'secret' }));
  assert.throws(() => validateConfig({ ...example, suites: ['agent', 'agent'] }));
  assert.throws(() => validateConfig({ ...example, repetitions: 1.2 }));
});

test('sums each proxy request once, keeps missing usage and reasoning unknown, excludes placeholder costs', () => {
  const requests = [
    {
      state: 'completed',
      durationMs: 100,
      firstContentMs: 25,
      usage: {
        reported: true,
        input: 70,
        output: 40,
        cacheRead: 20,
        cacheWrite: 10,
        totalTokens: 140,
        reasoningTokens: 15,
        cost: { total: 0 },
      },
    },
    {
      state: 'completed',
      durationMs: 200,
      usage: { reported: true, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    },
    { state: 'failed', durationMs: 20, usage: { reported: false, input: 0, totalTokens: 0 } },
    { state: 'running' },
  ];
  const result = summarizeRequests(requests);
  assert.equal(result.tokens.totalTokens.total, 155);
  assert.equal(result.tokens.reasoningTokens.total, 15);
  assert.equal(result.tokens.reasoningTokens.reportedRequests, 1);
  assert.equal(result.usageMissingRequests, 2);
  assert.equal(result.latencyMs.request.count, 3);
  assert.equal(result.latencyMs.firstContent.p50, 25);
  assert.equal(result.cost, null);
  assert.equal(summarizeRequests([]).tokens.input.total, null);
  assert.equal(summarizeRequests([{ usage: { reported: true, totalTokens: 0 } }]).tokens.totalTokens.total, 0);
  assert.equal(summarizeRequests([{ usage: { totalTokens: 0 } }]).usageReportedRequests, 0);
});

test('uses nearest rank percentiles and retains failed attempts in run totals', () => {
  assert.equal(distribution([null, 1, 2, 3, 4, NaN]).p50, 2);
  const result = summarizeRun([
    { status: 'failed', durationMs: 100, capture: { requests: [{ state: 'failed', usage: { totalTokens: 10 } }] } },
    { status: 'passed', durationMs: 200 },
    { status: 'not-run' },
    { status: 'skipped' },
  ]);
  assert.equal(result.failed, 1);
  assert.equal(result.notRun, 1);
  assert.equal(result.capturedCases, 1);
  assert.equal(result.llm.tokens.totalTokens.total, 10);
  assert.equal(result.passedTestDurationMs.mean, 200);
});

test('discovers stable case IDs independently of line numbers and filters auth', () => {
  const report = {
    suites: [
      {
        title: 'agentBenchmark.spec.ts',
        suites: [
          {
            title: 'agent benchmark',
            specs: [
              {
                title: 'creates dashboard',
                file: 'agentBenchmark.spec.ts',
                line: 71,
                tests: [{ projectName: 'chromium', results: [{ status: 'failed' }] }],
              },
              {
                title: 'auth',
                file: 'auth.js',
                line: 1,
                tests: [{ projectName: 'auth', results: [{ status: 'passed' }] }],
              },
            ],
          },
        ],
      },
    ],
  };
  const before = discoverCases(report, suites);
  assert.equal(before.length, 1);
  report.suites[0].suites[0].specs[0].line = 100;
  assert.equal(discoverCases(report, suites)[0].id, before[0].id);
  assert.equal(readCaseResult(report).status, 'failed');
  assert.throws(() => readCaseResult({ suites: [] }));
});

test('refuses to label a run with a different configured model, endpoint or thinking level', () => {
  const expected = example.model;
  const settings = { jsonData: { openAIBaseUrl: expected.baseUrl, models: [{ ...expected, default: true }] } };
  assert.equal(checkModelSettings(settings, expected).model.id, expected.id);
  assert.throws(() => checkModelSettings(settings, { ...expected, thinkingLevel: 'off' }), /thinkingLevel/);
  assert.throws(() => checkModelSettings(settings, { ...expected, baseUrl: 'http://different/v1' }), /baseUrl/);
});

test('reports overlapping tool durations separately from agent wall time', () => {
  const result = summarizeEvents([
    { type: 'agent_start', timestamp: 0 },
    { type: 'tool_execution_start', timestamp: 10, toolCallId: 'a' },
    { type: 'tool_execution_start', timestamp: 15, toolCallId: 'b' },
    { type: 'tool_execution_end', timestamp: 30, toolCallId: 'a' },
    { type: 'tool_execution_end', timestamp: 40, toolCallId: 'b', isError: true },
    { type: 'agent_end', timestamp: 50 },
  ]);
  assert.equal(result.durationMs.mean, 50);
  assert.equal(result.firstToolMs.mean, 10);
  assert.equal(result.toolDurationMs.mean, 22.5);
  assert.equal(result.failedTopLevelTools, 1);
  const incomplete = summarizeRun([
    { status: 'failed', capture: { requests: [], events: [{ type: 'agent_start', timestamp: 100 }] } },
    { status: 'passed', capture: { requests: [], events: [{ type: 'agent_end', timestamp: 200 }] } },
  ]);
  assert.equal(incomplete.agent.completedRuns, 0);
});
