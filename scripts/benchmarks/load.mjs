import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { distribution, summarizeRequests } from './core.mjs';

export const loadWorkloads = ['explore-metrics', 'analysis'];

export function validateLoadConfig(value) {
  const config = {
    concurrency: [1, 2, 4, 8, 16],
    workloads: loadWorkloads,
    repetitions: 1,
    rampUpMs: 10_000,
    warmupMs: 30_000,
    durationMs: 300_000,
    drainMs: 180_000,
    sessionTimeoutMs: 180_000,
    setupTimeoutMs: 120_000,
    thinkTimeMs: 0,
    cooldownMs: 5000,
    followUp: false,
    minSessions: 20,
    thresholds: { successRate: 0.95, sessionP95Ms: 180_000, firstContentP95Ms: 10_000 },
    metrics: [],
    ...value,
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Load config must be an object');
  }
  for (const key of Object.keys(value)) {
    if (
      ![
        'concurrency',
        'workloads',
        'repetitions',
        'rampUpMs',
        'warmupMs',
        'durationMs',
        'drainMs',
        'sessionTimeoutMs',
        'setupTimeoutMs',
        'thinkTimeMs',
        'cooldownMs',
        'followUp',
        'minSessions',
        'thresholds',
        'metrics',
      ].includes(key)
    ) {
      throw new Error(`Unknown load configuration field: ${key}`);
    }
  }
  for (const key of ['concurrency', 'workloads']) {
    if (!Array.isArray(config[key]) || !config[key].length || new Set(config[key]).size !== config[key].length) {
      throw new Error(`${key} must be a nonempty list without duplicates`);
    }
  }
  if (config.concurrency.some((n, i, list) => !Number.isSafeInteger(n) || n < 1 || (i > 0 && n <= list[i - 1]))) {
    throw new Error('concurrency must contain increasing positive integers');
  }
  if (config.workloads.some((id) => !loadWorkloads.includes(id))) {
    throw new Error('Unknown load workload');
  }
  for (const key of [
    'repetitions',
    'durationMs',
    'drainMs',
    'sessionTimeoutMs',
    'setupTimeoutMs',
    'minSessions',
    'rampUpMs',
    'warmupMs',
    'thinkTimeMs',
    'cooldownMs',
  ]) {
    const minimum = ['rampUpMs', 'warmupMs', 'thinkTimeMs', 'cooldownMs'].includes(key) ? 0 : 1;
    if (!Number.isSafeInteger(config[key]) || config[key] < minimum) {
      throw new Error(`Invalid ${key}`);
    }
  }
  if (typeof config.followUp !== 'boolean') {
    throw new Error('followUp must be boolean');
  }
  if (!config.thresholds || typeof config.thresholds !== 'object' || Array.isArray(config.thresholds)) {
    throw new Error('thresholds must be an object');
  }
  for (const [key, number] of Object.entries(config.thresholds)) {
    if (
      !['successRate', 'sessionP95Ms', 'firstContentP95Ms'].includes(key) ||
      typeof number !== 'number' ||
      !Number.isFinite(number) ||
      number <= 0 ||
      (key === 'successRate' && number > 1)
    ) {
      throw new Error(`Invalid threshold: ${key}`);
    }
  }
  if (!Object.keys(config.thresholds).length) {
    throw new Error('At least one threshold is required');
  }
  if (!Array.isArray(config.metrics)) {
    throw new Error('metrics must be an array');
  }
  for (const target of config.metrics) {
    if (
      !target ||
      Object.keys(target).some((key) => !['label', 'url', 'bearerTokenEnv'].includes(key)) ||
      typeof target.label !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/.test(target.label)
    ) {
      throw new Error('Invalid metrics target');
    }
    const url = new URL(target.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Metrics URL must be HTTP(S), without credentials, query, or fragment');
    }
    if (target.bearerTokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target.bearerTokenEnv)) {
      throw new Error('Invalid metrics bearerTokenEnv');
    }
  }
  if (new Set(config.metrics.map((target) => target.label)).size !== config.metrics.length) {
    throw new Error('Duplicate metrics labels');
  }
  return structuredClone(config);
}

export function planLoadStages(config) {
  const stages = [];
  for (let repetition = 1; repetition <= config.repetitions; repetition++) {
    for (const workload of config.workloads) {
      for (const concurrency of config.concurrency) {
        stages.push({
          id: `${repetition}-${workload}-${concurrency}`,
          repetition,
          workload,
          concurrency,
          status: 'not-run',
        });
      }
    }
  }
  return stages;
}

export function stageBudgetMs(config) {
  return config.setupTimeoutMs + config.rampUpMs + config.warmupMs + config.durationMs + config.drainMs + 15_000;
}

export function classifyRequestFailure(request) {
  const status = request.upstreamStatus ?? request.httpStatus;
  if (status === 429) {
    return 'rate-limit';
  }
  if (status === 401 || status === 403) {
    return 'authentication';
  }
  if (status === 408 || status === 504 || /timeout|timed out|deadline/i.test(request.error ?? '')) {
    return 'timeout';
  }
  if (status >= 500) {
    return 'upstream';
  }
  if (/abort/i.test(request.error ?? '')) {
    return 'aborted';
  }
  if (status >= 400) {
    return 'request';
  }
  if (request.error === 'TypeError') {
    return 'transport';
  }
  return 'stream';
}

// Time-weighted occupancy, clipped to the measurement window. A running request
// still occupies a slot; requests crossing either boundary must not disappear.
export function occupancy(intervals, start, end) {
  if (!(end > start)) {
    return { mean: null, peak: null };
  }
  const points = [];
  for (const interval of intervals) {
    const a = Math.max(start, interval.startedAt);
    const b = Math.min(end, interval.finishedAt ?? end);
    if (b > a) {
      points.push([a, 1], [b, -1]);
    }
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0,
    peak = 0,
    area = 0,
    previous = start;
  for (const [time, change] of points) {
    area += active * (time - previous);
    active += change;
    peak = Math.max(peak, active);
    previous = time;
  }
  return { mean: area / (end - start), peak };
}

export function summarizeLoadStage(stage, config) {
  const { measurementStartedAt: start, measurementEndedAt: end } = stage;
  const sessions = stage.sessions.filter((s) => s.startedAt >= start && s.startedAt < end);
  const allRequests = stage.sessions.flatMap((s) => s.requests ?? []);
  const requests = allRequests.filter((r) => r.startedAt >= start && r.startedAt < end);
  const llm = summarizeRequests(requests);
  const seconds = (end - start) / 1000;
  const completedInWindow = stage.sessions.filter(
    (s) => s.status === 'passed' && s.finishedAt >= start && s.finishedAt < end
  );
  const terminalRequests = allRequests.filter(
    (r) =>
      r.durationMs !== undefined &&
      r.state !== 'running' &&
      r.startedAt + r.durationMs >= start &&
      r.startedAt + r.durationMs < end
  );
  const usage = summarizeRequests(terminalRequests);
  const passed = sessions.filter((s) => s.status === 'passed').length;
  const firstContent = (s, field) => {
    const times = (s.requests ?? [])
      .filter((r) => typeof r[field] === 'number')
      .map((r) => r.startedAt + r[field] - s.startedAt);
    return times.length ? Math.min(...times) : null;
  };
  const failures = {};
  for (const session of sessions.filter((s) => s.status !== 'passed')) {
    const kind = session.failureKind ?? session.status;
    failures[kind] = (failures[kind] ?? 0) + 1;
  }
  const requestFailures = {};
  for (const request of requests.filter((r) => r.state === 'failed')) {
    const kind = classifyRequestFailure(request);
    requestFailures[kind] = (requestFailures[kind] ?? 0) + 1;
  }
  const summary = {
    sessions: sessions.length,
    passed,
    successRate: sessions.length ? passed / sessions.length : null,
    failures,
    requestFailures,
    sessionDurationMs: distribution(sessions.map((s) => s.durationMs)),
    firstContentMs: distribution(sessions.map((s) => firstContent(s, 'firstContentMs'))),
    firstTextMs: distribution(sessions.map((s) => firstContent(s, 'firstTextMs'))),
    dispatchDelayMs: distribution(sessions.map((s) => s.dispatchDelayMs)),
    requestsPerSession: distribution(sessions.map((s) => s.requests?.length ?? 0)),
    successfulSessionsPerMinute: seconds > 0 ? (completedInWindow.length * 60) / seconds : null,
    terminalOutputTokensPerSecond:
      seconds > 0 && usage.tokens.output.total !== null ? usage.tokens.output.total / seconds : null,
    throughputUsage: usage,
    activeSessions: occupancy(stage.sessions, start, end),
    llmRequestsInFlight: occupancy(
      allRequests.map((r) => ({
        startedAt: r.startedAt,
        finishedAt: r.durationMs === undefined ? undefined : r.startedAt + r.durationMs,
      })),
      start,
      end
    ),
    llm,
  };
  const violations = [];
  for (const [key, limit] of Object.entries(config.thresholds)) {
    const observed =
      key === 'successRate'
        ? summary.successRate
        : key === 'sessionP95Ms'
          ? summary.sessionDurationMs.p95
          : summary.firstContentMs.p95;
    if (observed === null || (key === 'successRate' ? observed < limit : observed > limit)) {
      violations.push(key);
    }
  }
  summary.acceptance =
    stage.errors?.length || stage.status === 'interrupted'
      ? 'invalid'
      : sessions.length < config.minSessions
        ? 'insufficient-samples'
        : violations.length
          ? 'failed'
          : 'passed';
  summary.thresholdViolations = violations;
  return summary;
}

export function summarizeCapacity(stages, config) {
  return config.workloads.map((workload) => {
    let highestPassing = null;
    for (const concurrency of config.concurrency) {
      const group = stages.filter((s) => s.workload === workload && s.concurrency === concurrency);
      if (
        group.length !== config.repetitions ||
        group.some((s) => s.status !== 'completed' || s.summary?.acceptance !== 'passed')
      ) {
        break;
      }
      highestPassing = concurrency;
    }
    return {
      workload,
      highestPassingConcurrency: highestPassing,
      allTestedLevelsPassed: highestPassing === config.concurrency.at(-1),
      interpretation:
        highestPassing === null
          ? 'No supported capacity established'
          : highestPassing === config.concurrency.at(-1)
            ? `At least ${highestPassing} concurrent sessions`
            : `Highest consecutively passing tested level: ${highestPassing}`,
    };
  });
}

// Driver instances own independent browser contexts. Warmup conversations can
// cross the boundary; latency uses start cohorts, throughput uses completions.
export async function runLoadStage({ stage, config, drivers, signal, checkpoint = async () => {} }) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  Object.assign(stage, { status: 'running', sessions: [], errors: [], startedAt: Date.now() });
  stage.measurementStartedAt = stage.startedAt + config.rampUpMs + config.warmupMs;
  stage.measurementEndedAt = stage.measurementStartedAt + config.durationMs;
  const timer = setTimeout(
    () => controller.abort(new Error('Stage drain deadline reached')),
    config.rampUpMs + config.warmupMs + config.durationMs + config.drainMs
  );
  const sleep = (ms) => delay(Math.max(0, ms), undefined, { signal: controller.signal });
  try {
    await checkpoint(stage);
    await Promise.all(
      drivers.map(async (driver, index) => {
        try {
          await sleep(
            stage.startedAt + (drivers.length === 1 ? 0 : (config.rampUpMs * index) / (drivers.length - 1)) - Date.now()
          );
          while (!controller.signal.aborted && Date.now() < stage.measurementEndedAt) {
            const session = {
              id: randomUUID(),
              worker: index,
              workload: stage.workload,
              startedAt: Date.now(),
              status: 'running',
              requests: [],
            };
            stage.sessions.push(session);
            await checkpoint(stage, session);
            const sessionSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.sessionTimeoutMs)]);
            try {
              await driver.run(session, sessionSignal);
            } catch (error) {
              session.status = signal?.aborted ? 'interrupted' : sessionSignal.aborted ? 'timedOut' : 'failed';
              session.failureKind = sessionSignal.aborted ? 'timeout' : 'driver';
              session.error = error.message;
            }
            session.finishedAt = Date.now();
            session.durationMs = session.finishedAt - session.startedAt;
            if (session.status === 'running') {
              session.status = 'failed';
              session.failureKind = 'incomplete';
            }
            await checkpoint(stage, session);
            if (['configuration', 'driver'].includes(session.failureKind)) {
              throw new Error(session.error);
            }
            if (controller.signal.aborted || Date.now() >= stage.measurementEndedAt) {
              break;
            }
            await sleep(config.thinkTimeMs);
            if (Date.now() < stage.measurementEndedAt) {
              await driver.reset(controller.signal);
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            stage.errors.push({ worker: index, message: error.message });
            controller.abort(error); // A missing worker invalidates the target concurrency.
          }
        }
      })
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    stage.status = signal?.aborted ? 'interrupted' : stage.errors.length ? 'failed' : 'completed';
    stage.finishedAt = Date.now();
    stage.summary = summarizeLoadStage(stage, config);
    await checkpoint(stage);
  }
  return stage;
}

export function formatLoadReport(run) {
  const number = (n) => (n == null ? '—' : Number(n.toFixed(2)).toString());
  return [
    '# Assistant load benchmark',
    '',
    `Status: ${run.status}`,
    '',
    '| Workload | Repeat | Sessions in parallel | Samples | Success | Sessions/min | Session p95 ms | First content p95 ms | LLM in flight mean/peak | Result |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
    ...run.stages.map((s) => {
      const m = s.summary;
      return `| ${s.workload} | ${s.repetition} | ${s.concurrency} | ${m?.sessions ?? 0} | ${number(m?.successRate)} | ${number(m?.successfulSessionsPerMinute)} | ${number(m?.sessionDurationMs.p95)} | ${number(m?.firstContentMs.p95)} | ${number(m?.llmRequestsInFlight.mean)}/${number(m?.llmRequestsInFlight.peak)} | ${m?.acceptance ?? s.status} |`;
    }),
    '',
    ...summarizeCapacity(run.stages, run.load).map((c) => `${c.workload}: ${c.interpretation}.`),
    '',
    'Latency and success use sessions started in the measurement window, including their drained outcomes. Throughput counts completions within the window, including warmup work. Token throughput is terminal-accounted usage, not instantaneous decode speed. Missing usage remains unknown.',
    '',
  ].join('\n');
}
