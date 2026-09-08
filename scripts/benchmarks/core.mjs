import { createHash } from 'node:crypto';

// The batch-editing command is a subset of dashboard-editing, not another suite.
export const suites = [
  ['agent', 'agentBenchmark.spec.ts', 180_000],
  ['analysis', 'agentAnalysisBenchmark.spec.ts', 180_000],
  ['artifact-jq', 'agentArtifactJqBenchmark.spec.ts', 180_000],
  ['robust-dashboard', 'agentRobustDashboardBenchmark.spec.ts', 240_000],
  ['thanos-cost-dashboard', 'agentThanosCostDashboardBenchmark.spec.ts', 600_000],
  ['dashboard-plan-handoff', 'agentDashboardPlanHandoffBenchmark.spec.ts', 420_000],
  ['dashboard-context', 'agentDashboardContextBenchmark.spec.ts', 240_000],
  ['dashboard-editing', 'agentDashboardEditingBenchmark.spec.ts', 480_000],
  ['alert-troubleshooting', 'agentAlertTroubleshootingBenchmark.spec.ts', 240_000],
  ['dashboard-metric-discovery', 'agentDashboardMetricDiscoveryBenchmark.spec.ts', 180_000],
  ['agent-contract-sample', 'agentContractSampleBenchmark.spec.ts', 240_000],
  ['explore-metrics', 'agentExploreMetricsBenchmark.spec.ts', 150_000],
].map(([id, file, timeoutMs]) => ({ id, file, timeoutMs }));

export function validateConfig(value) {
  const config = structuredClone(value);
  const required = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${label} must be a nonempty string`);
    }
  };
  required(config.label, 'label');
  required(config.model?.id, 'model.id');
  required(config.model?.provider, 'model.provider');
  required(config.hosting?.label, 'hosting.label');
  const url = new URL(config.model.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('model.baseUrl must be an HTTP(S) URL without credentials, query, or fragment');
  }
  for (const [field, choices, fallback] of [
    ['protocol', ['auto', 'chat-completions', 'responses'], 'chat-completions'],
    ['thinkingLevel', ['off', 'low', 'medium', 'high', 'xhigh'], 'off'],
    ['thinkingFormat', ['openai', 'qwen', 'qwen-chat-template'], 'openai'],
  ]) {
    config.model[field] ??= fallback;
    if (!choices.includes(config.model[field])) {
      throw new Error(`model.${field} must be one of ${choices.join(', ')}`);
    }
  }
  // Copy only declared fields. Credentials stay in environment variables or Pi's config.
  const allowedModel = ['id', 'provider', 'baseUrl', 'protocol', 'thinkingLevel', 'thinkingFormat'];
  for (const key of Object.keys(config.model)) {
    if (!allowedModel.includes(key)) {
      throw new Error(`Unknown model field: ${key}`);
    }
  }
  for (const key of Object.keys(config)) {
    if (
      ![
        'label',
        'model',
        'hosting',
        'localServer',
        'apiKeyEnv',
        'apiKeyPi',
        'repetitions',
        'suites',
        'timeoutMs',
        'notes',
      ].includes(key)
    ) {
      throw new Error(`Unknown configuration field: ${key}`);
    }
  }
  if (config.localServer) {
    required(config.localServer.command, 'localServer.command');
    if (!Array.isArray(config.localServer.args) || !config.localServer.args.every((arg) => typeof arg === 'string')) {
      throw new Error('localServer.args must be an array of command arguments');
    }
    if (!['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal', '[::1]'].includes(url.hostname)) {
      throw new Error('localServer requires a local model.baseUrl');
    }
    config.localServer.startTimeoutMs ??= 900_000;
    if (!Number.isSafeInteger(config.localServer.startTimeoutMs) || config.localServer.startTimeoutMs < 1) {
      throw new Error('localServer.startTimeoutMs must be a positive integer');
    }
  }
  if (config.apiKeyEnv !== undefined) {
    required(config.apiKeyEnv, 'apiKeyEnv');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) {
      throw new Error('Invalid apiKeyEnv');
    }
  }
  if (config.apiKeyPi !== undefined) {
    required(config.apiKeyPi, 'apiKeyPi');
    if (config.apiKeyEnv !== undefined) {
      throw new Error('Use either apiKeyEnv or apiKeyPi');
    }
  }
  config.repetitions ??= 1;
  for (const key of ['repetitions', 'timeoutMs']) {
    if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] < 1)) {
      throw new Error(`${key} must be a positive integer`);
    }
  }
  config.suites ??= suites.map((suite) => suite.id);
  if (!Array.isArray(config.suites) || !config.suites.length || new Set(config.suites).size !== config.suites.length) {
    throw new Error('suites must be a nonempty list without duplicates');
  }
  for (const id of config.suites) {
    if (!suites.some((suite) => suite.id === id)) {
      throw new Error(`Unknown benchmark suite: ${id}`);
    }
  }
  return config;
}

export function discoverCases(report, selectedSuites) {
  const cases = [];
  function visit(suite, titles = []) {
    const path = [...titles, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) {
      const benchmark = selectedSuites.find((entry) => entry.file === spec.file);
      if (!benchmark || !spec.tests.some((test) => test.projectName === 'chromium')) {
        continue;
      }
      const title = [...path, spec.title].join(' > ');
      cases.push({
        id: `${benchmark.id}-${createHash('sha256').update(title).digest('hex').slice(0, 12)}`,
        suite: benchmark.id,
        file: `tests/${spec.file}`,
        line: spec.line,
        title,
        timeoutMs: benchmark.timeoutMs,
      });
    }
    for (const child of suite.suites ?? []) {
      visit(child, path);
    }
  }
  visit(report);
  return cases;
}

export function distribution(values) {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) {
    return { count: 0, mean: null, min: null, p50: null, p95: null, max: null };
  }
  const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return {
    count: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
  };
}

export function summarizeRequests(requests) {
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'reasoningTokens'];
  const hasUsage = (request) =>
    request.usage?.reported === true || (request.usage?.reported === undefined && request.usage?.totalTokens > 0);
  const reported = requests.filter(hasUsage);
  const tokens = Object.fromEntries(
    fields.map((field) => {
      const values = reported.map((r) => r.usage[field]).filter((v) => typeof v === 'number' && Number.isFinite(v));
      return [
        field,
        { total: values.length ? values.reduce((a, b) => a + b, 0) : null, reportedRequests: values.length },
      ];
    })
  );
  return {
    requests: requests.length,
    completedRequests: requests.filter((r) => r.state === 'completed').length,
    failedRequests: requests.filter((r) => r.state === 'failed').length,
    incompleteRequests: requests.filter((r) => r.state === 'running').length,
    usageReportedRequests: reported.length,
    usageMissingRequests: requests.length - reported.length,
    tokens,
    endToEndOutputTokensPerSecond: distribution(
      reported
        .filter((r) => r.state === 'completed' && r.durationMs > 0 && typeof r.usage.output === 'number')
        .map((r) => (r.usage.output * 1000) / r.durationMs)
    ),
    latencyMs: {
      request: distribution(requests.map((r) => r.durationMs)),
      firstByte: distribution(requests.map((r) => r.firstByteMs)),
      firstContent: distribution(requests.map((r) => r.firstContentMs)),
      firstText: distribution(requests.map((r) => r.firstTextMs)),
      firstThinking: distribution(requests.map((r) => r.firstThinkingMs)),
    },
    // The plugin's cost fields are placeholders, not provider billing.
    cost: null,
  };
}

export function summarizeRun(cases) {
  const measured = cases.filter((entry) => entry.capture);
  const requests = measured.flatMap((entry) => entry.capture.requests);
  return {
    planned: cases.length,
    passed: cases.filter((entry) => entry.status === 'passed').length,
    failed: cases.filter((entry) => entry.status === 'failed' || entry.status === 'timedOut').length,
    skipped: cases.filter((entry) => entry.status === 'skipped').length,
    notRun: cases.filter((entry) => entry.status === 'not-run' || entry.status === 'running').length,
    interrupted: cases.filter((entry) => entry.status === 'interrupted').length,
    capturedCases: measured.length,
    testDurationMs: distribution(cases.map((entry) => entry.durationMs)),
    passedTestDurationMs: distribution(
      cases.filter((entry) => entry.status === 'passed').map((entry) => entry.durationMs)
    ),
    agent: summarizeEvents(
      measured.flatMap((entry) => [{ type: 'capture_boundary' }, ...(entry.capture.events ?? [])])
    ),
    llm: summarizeRequests(requests),
  };
}

export function compactEvents(events) {
  return events
    .filter((event) =>
      ['agent_start', 'agent_end', 'tool_execution_start', 'tool_execution_end', 'message_end'].includes(event.type)
    )
    .map((event) => ({
      type: event.type,
      timestamp: event.timestamp,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      role: event.message?.role,
    }));
}

export function summarizeEvents(events) {
  const starts = new Map();
  const tools = [];
  const agentDurations = [];
  const firstTools = [];
  let agentStart;
  let firstTool;
  for (const event of events) {
    // A failed case may have no agent_end; never pair it with another case's events.
    if (event.type === 'capture_boundary') {
      agentStart = undefined;
      firstTool = undefined;
      starts.clear();
    }
    if (event.type === 'agent_start') {
      agentStart = event.timestamp;
      firstTool = undefined;
    }
    if (event.type === 'agent_end' && agentStart !== undefined) {
      agentDurations.push(event.timestamp - agentStart);
      if (firstTool !== undefined) {
        firstTools.push(firstTool - agentStart);
      }
      agentStart = undefined;
    }
    if (event.type === 'tool_execution_start') {
      starts.set(event.toolCallId, event.timestamp);
      firstTool ??= event.timestamp;
    }
    if (event.type === 'tool_execution_end') {
      const start = starts.get(event.toolCallId);
      tools.push({ failed: event.isError === true, durationMs: start === undefined ? null : event.timestamp - start });
      starts.delete(event.toolCallId);
    }
  }
  return {
    completedRuns: agentDurations.length,
    durationMs: distribution(agentDurations),
    firstToolMs: distribution(firstTools),
    completedTopLevelTools: tools.length,
    failedTopLevelTools: tools.filter((tool) => tool.failed).length,
    toolDurationMs: distribution(tools.map((tool) => tool.durationMs)),
  };
}

export function readCaseResult(report) {
  const results = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        if (test.projectName === 'chromium') {
          results.push(...test.results);
        }
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child);
    }
  }
  visit(report);
  if (results.length !== 1) {
    throw new Error(`Expected exactly one benchmark result, received ${results.length}`);
  }
  return results[0];
}
