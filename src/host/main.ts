import { streamProxy } from '@earendil-works/pi-agent-core';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { PLUGIN_ID } from '../constants';
import { grafanaChatLog } from '../pages/Chat/durable/grafanaChatLog';
import { createGrafanaStreamFn } from '../pages/Chat/grafanaStream';
import { renderDashboardScreenshot } from '../pages/Chat/domain/dashboards';
import { createGrafanaWorkspaceBroker } from '../pages/Chat/workspace/grafanaBroker';
import type { WorkspaceBroker } from '../pages/Chat/workspace/broker';
import type { PiAppJsonData } from '../types';
import { isGrafanaWebhook } from './alerts';
import { AssistantHost } from './assistant';
import { getBackendSrv, initGrafanaRuntime, refreshDatasources } from './grafanaRuntime';
import { MattermostChannel } from './mattermost';
import { Metrics } from './metrics';
import { Responder } from './responder';
import { renderAlertPanels } from './screenshots';
import { createNodePythonRunner } from './python';
import { nodeShellWorkers } from './shellWorkers';
import { setShellWorkerFactory } from '../pages/Chat/workspace/shell';
import { HostStore } from './store';

/**
 * The assistant host: runs assistant chats outside the browser for Mattermost
 * threads and Grafana alert notifications. See docs/mattermost.md.
 */

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

function setting(name: string, fallback?: string) {
  const file = process.env[`${name}_FILE`];
  const value = file ? readFileSync(file, 'utf8').trim() : process.env[name];
  if (value) {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`${name} (or ${name}_FILE) is required`);
}

const grafanaUrl = setting('GRAFANA_URL').replace(/\/$/, '');
const grafanaToken = setting('GRAFANA_TOKEN');
const webhookToken = setting('ALERT_WEBHOOK_TOKEN', '');
if (!webhookToken && setting('ALERT_WEBHOOK_INSECURE', 'false') !== 'true') {
  throw new Error(
    'ALERT_WEBHOOK_TOKEN is required; set ALERT_WEBHOOK_INSECURE=true to accept unauthenticated notifications'
  );
}
const port = Number(setting('HOST_PORT', '8080'));

// Scripts run in worker threads, so the run timeout and cancellation can terminate them.
setShellWorkerFactory(nodeShellWorkers(new URL('./shell.worker.mjs', import.meta.url)));
await initGrafanaRuntime({ url: grafanaUrl, token: grafanaToken });
setInterval(() => void refreshDatasources().catch((error) => log(`datasource refresh failed: ${error}`)), 60_000);
log(`grafana: connected to ${grafanaUrl} as plugin ${PLUGIN_ID}`);

const jsonData = async () =>
  (await getBackendSrv().get<{ jsonData?: PiAppJsonData }>(`/api/plugins/${PLUGIN_ID}/settings`)).jsonData ?? {};

/** The browser's broker, with screenshots through the image renderer as the service account and no navigation. */
function createBroker(settings: PiAppJsonData): WorkspaceBroker {
  return {
    ...createGrafanaWorkspaceBroker(settings),
    ui: {
      navigate: () => undefined,
      screenshot: (params, signal) =>
        renderDashboardScreenshot(params, signal, {
          origin: grafanaUrl,
          headers: { Authorization: `Bearer ${grafanaToken}` },
        }),
    },
  };
}

const assistant = new AssistantHost({
  jsonData,
  streamFn: createGrafanaStreamFn({
    proxyUrl: `${grafanaUrl}/api/plugins/${PLUGIN_ID}/resources/llm`,
    refreshSession: async () => undefined,
    // The proxy sends the token as a bearer token: the service account's.
    stream: (model, context, options) => streamProxy(model, context, { ...options, authToken: grafanaToken }),
  }),
  broker: createBroker,
  chatLog: grafanaChatLog(),
  concurrency: Number(setting('ASSISTANT_CONCURRENCY', '2')),
  // The plugin's CPython-WASM assets; dist-host is built next to dist.
  python: createNodePythonRunner({
    assets: new URL(
      `${setting('CPYTHON_DIR', new URL('../dist/cpython', import.meta.url).pathname).replace(/\/$/, '')}/`,
      'file://'
    ),
    worker: new URL('./python.worker.mjs', import.meta.url),
  }),
});

// Links people open: Grafana's public URL (root_url), not the address the host uses.
const publicUrl = setting(
  'GRAFANA_PUBLIC_URL',
  (await getBackendSrv().get<{ appUrl?: string }>('/api/frontend/settings')).appUrl ?? grafanaUrl
).replace(/\/$/, '');

const metrics = new Metrics();
metrics.gauge('assistant_host_runs_in_progress', 'Assistant runs using the model now.', () => assistant.load().running);
metrics.gauge('assistant_host_runs_waiting', 'Assistant runs waiting for a turn.', () => assistant.load().waiting);

const store = new HostStore(path.join(setting('HOST_DATA_DIR', './work/host'), 'state.json'));
await store.load();

const channel = new MattermostChannel({ url: setting('MATTERMOST_URL'), token: setting('MATTERMOST_TOKEN'), log });
const alertChannel = setting('MATTERMOST_ALERT_CHANNEL', '');
const channelNames = setting('MATTERMOST_CHANNELS', '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const responder = new Responder({
  channel,
  assistant,
  store,
  alertChannelId: alertChannel ? await channel.resolveChannel(alertChannel) : undefined,
  channelIds: await Promise.all(channelNames.map((name) => channel.resolveChannel(name))),
  allowDirect: setting('MATTERMOST_ALLOW_DIRECT', 'true') !== 'false',
  alertPanels: async (payload) => renderAlertPanels(payload, createBroker(await jsonData()), log),
  metrics,
  sharedChatUrl: (token) => `${publicUrl}/a/${PLUGIN_ID}/chat?share=${encodeURIComponent(token)}`,
  log,
});
await channel.start((message) => {
  void responder
    .handleMessage(message)
    .catch((error) => log(`message ${message.postId} failed: ${error instanceof Error ? error.message : error}`));
});
void responder.recover();

createServer((request, response) => {
  void handle(request, response).catch((error) => {
    log(`request failed: ${error instanceof Error ? error.message : error}`);
    if (!response.headersSent) {
      reply(response, 500, { error: 'internal error' });
    }
  });
}).listen(port, () => log(`listening on :${port}`));

async function handle(request: IncomingMessage, response: ServerResponse) {
  if (request.method === 'GET' && request.url === '/healthz') {
    return reply(response, 200, { status: 'ok' });
  }
  if (request.method === 'GET' && request.url === '/metrics') {
    response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    response.end(metrics.render());
    return;
  }
  if (request.method !== 'POST' || request.url !== '/alerts/grafana') {
    return reply(response, 404, { error: 'not found' });
  }
  if (webhookToken && !sameSecret(request.headers.authorization ?? '', `Bearer ${webhookToken}`)) {
    return reply(response, 401, { error: 'unauthorized' });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return reply(response, 400, { error: 'invalid JSON' });
  }
  if (!isGrafanaWebhook(payload)) {
    return reply(response, 400, { error: 'not a Grafana webhook notification' });
  }
  // Grafana retries failed deliveries; answer once the notification is posted.
  const result = await responder.handleAlert(payload);
  log(`alert ${payload.groupKey}: ${result.action}`);
  return reply(response, 200, result);
}

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sameSecret(actual: string, expected: string) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
