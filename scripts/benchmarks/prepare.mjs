import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function prepareFixtureEnvironment(directory, id, cases, env, now = Date.now()) {
  const prefix = `pi-bench-${id.toLowerCase()}`;
  const fixtures = {
    mode: 'fresh-isolated-volumes',
    historyHours: 6,
    stepSeconds: 60,
    historyEndTimestamp: Math.floor(now / 1000),
    futureSeconds: Math.max(
      3600,
      Math.ceil(cases.reduce((sum, entry) => sum + entry.timeoutMs + 90_000, 0) / 1000) + 600
    ),
    volumes: { demo: `${prefix}-demo`, prometheus: `${prefix}-prometheus` },
  };
  const overridePath = path.join(directory, 'compose.fixtures.json');
  await writeFile(
    overridePath,
    JSON.stringify(
      {
        services: {
          'history-generator': {
            environment: {
              HISTORY_HOURS: String(fixtures.historyHours),
              HISTORY_STEP_SECONDS: String(fixtures.stepSeconds),
              HISTORY_END_TIMESTAMP: String(fixtures.historyEndTimestamp),
              HISTORY_FUTURE_SECONDS: String(fixtures.futureSeconds),
              INCIDENT_DURATION_SECONDS: '900',
            },
          },
        },
        volumes: {
          'demo-data': { name: fixtures.volumes.demo },
          'prometheus-data': { name: fixtures.volumes.prometheus },
        },
      },
      null,
      2
    )
  );
  const separator = env.COMPOSE_PATH_SEPARATOR || path.delimiter;
  const composeFiles = (env.COMPOSE_FILE || 'docker-compose.yaml').split(separator).map((file) => path.resolve(file));
  return { fixtures, env: { ...env, COMPOSE_FILE: [...composeFiles, overridePath].join(separator) } };
}

function localModelsUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (!['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal', '[::1]'].includes(url.hostname)) {
    return null;
  }
  if (['host.docker.internal', '0.0.0.0'].includes(url.hostname)) {
    url.hostname = '127.0.0.1';
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
  return url;
}

export async function ensureModelServer(config, env, directory, signal, log = () => {}, allowStart = false) {
  const url = localModelsUrl(config.model.baseUrl);
  if (!url) {
    return { metadata: { managed: false, remote: true }, stop: async () => {} };
  }
  const inspect = async () => {
    let response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY || 'local-dev-key'}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      });
    } catch {
      return null;
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Model server rejected authentication (HTTP ${response.status})`);
      }
      return null;
    }
    const models = await response.json();
    const ids = (models.data ?? []).flatMap((model) => [model.id, ...(model.aliases ?? [])]);
    if (!ids.includes(config.model.id)) {
      throw new Error(
        'A model server is already running at this endpoint, but it does not advertise the requested model ID.'
      );
    }
    return { modelIds: [...new Set(ids)] };
  };
  const existing = await inspect();
  if (existing) {
    log('Reusing the running local model server.');
    return { metadata: { ...existing, managed: false, reused: true }, stop: async () => {} };
  }
  if (!allowStart || !config.localServer) {
    throw new Error(
      'Local model server is unavailable. Start it externally, or use --start-model-server with a localServer profile.'
    );
  }
  signal.throwIfAborted();
  log(`Starting ${config.localServer.command}; loading progress is in model-server.log.`);
  const output = createWriteStream(path.join(directory, 'model-server.log'));
  const child = spawn(config.localServer.command, config.localServer.args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  const closed = new Promise((resolve) =>
    child.once('close', () => {
      output.end();
      resolve();
    })
  );
  const kill = (signal) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    try {
      if (process.platform === 'win32') {
        child.kill(signal);
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      /* Already exited. */
    }
  };
  const stop = async () => {
    kill('SIGTERM');
    const timer = delay(5000, 'timeout', { ref: false });
    if ((await Promise.race([closed, timer])) === 'timeout') {
      kill('SIGKILL');
      await closed;
    }
  };
  const started = Date.now();
  try {
    while (Date.now() - started < config.localServer.startTimeoutMs) {
      signal.throwIfAborted();
      if (spawnError) {
        throw spawnError;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Local model server exited during startup; see model-server.log');
      }
      const ready = await inspect();
      if (ready) {
        return {
          metadata: { ...ready, managed: true, reused: false, pid: child.pid, startupMs: Date.now() - started },
          stop,
        };
      }
      await delay(1000, undefined, { signal });
    }
    throw new Error('Local model server startup timed out; see model-server.log');
  } catch (error) {
    await stop();
    throw error;
  }
}

// A previous successful preparation supplies provenance for reusing the running stack.
export async function inspectPreparedStack(state, expected, sourceSha256, grafanaUrl, cases, env, signal) {
  if (!state || state.grafanaUrl !== grafanaUrl) {
    return { reusable: false, reason: 'No matching prepared stack record' };
  }
  if (state.sourceSha256 !== sourceSha256) {
    return { reusable: false, reason: 'Plugin or benchmark sources changed' };
  }
  const budgetSeconds = Math.ceil(cases.reduce((sum, entry) => sum + entry.timeoutMs + 90_000, 0) / 1000);
  if (
    (state.fixtures?.historyEndTimestamp ?? 0) + (state.fixtures?.futureSeconds ?? 0) <
    Date.now() / 1000 + budgetSeconds
  ) {
    return { reusable: false, reason: 'Fixture history does not cover this run’s time budget' };
  }
  const headers = {
    Authorization: `Basic ${Buffer.from(`${env.GRAFANA_USER || 'admin'}:${env.GRAFANA_PASSWORD || 'admin'}`).toString('base64')}`,
  };
  const get = (route) =>
    fetch(`${grafanaUrl}${route}`, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
  try {
    const health = await get('/api/health');
    if (!health.ok) {
      return { reusable: false, reason: 'Grafana is not healthy' };
    }
    const response = await get('/api/plugins/grafana-assistant-app/settings');
    if (!response.ok) {
      return { reusable: false, reason: 'Cannot verify plugin settings' };
    }
    const settings = (await response.json()).jsonData;
    const actual = settings.models?.find((model) => model.default) ?? settings.models?.[0];
    if (
      settings.openAIBaseUrl?.replace(/\/$/, '') !== expected.baseUrl.replace(/\/$/, '') ||
      ['id', 'protocol', 'thinkingLevel', 'thinkingFormat'].some((field) => actual?.[field] !== expected[field])
    ) {
      return { reusable: false, reason: 'Model configuration changed' };
    }
    const query = 'max(count_over_time(http_requests_total[6h]))';
    const metrics = await get(`/api/datasources/proxy/uid/prometheus/api/v1/query?query=${encodeURIComponent(query)}`);
    if (!metrics.ok || Number((await metrics.json()).data?.result?.[0]?.value?.[1] ?? 0) < 300) {
      return { reusable: false, reason: 'Prometheus history is missing or stale' };
    }
    for (const uid of [
      'dashboard-editing-demo',
      'dashboard-context-demo',
      'alert-troubleshooting-demo',
      'metric-discovery-service-demo',
      'metric-discovery-infra-demo',
    ]) {
      if (!(await get(`/api/dashboards/uid/${uid}`)).ok) {
        return { reusable: true, seedSamples: true };
      }
    }
    const namespace = encodeURIComponent(env.ALERT_NAMESPACE || 'default');
    if (
      !(
        await get(
          `/apis/rules.alerting.grafana.app/v0alpha1/namespaces/${namespace}/alertrules/alert-troubleshooting-demo-5xx`
        )
      ).ok
    ) {
      return { reusable: true, seedSamples: true };
    }
    return { reusable: true, seedSamples: false };
  } catch {
    signal.throwIfAborted();
    return { reusable: false, reason: 'Prepared stack is unavailable' };
  }
}
