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
import type { ChatChannel } from './channel';
import { MattermostChannel } from './mattermost';
import { WebexChannel } from './webex';
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
// A failed delivery or run must not stop the host for every other thread.
process.on('unhandledRejection', (error) =>
  log(`unhandled rejection: ${error instanceof Error ? error.stack : String(error)}`)
);

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

const list = (name: string) =>
  setting(name, '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** One responder per configured platform; they share the assistant, the store, and the alert notifications. */
async function connect(
  channel: ChatChannel,
  config: { alertChannel: string; channels: string[]; allowDirect: boolean }
): Promise<Responder> {
  const responder = new Responder({
    channel,
    assistant,
    store,
    alertChannelId: config.alertChannel ? await channel.resolveChannel(config.alertChannel) : undefined,
    channelIds: await Promise.all(config.channels.map((name) => channel.resolveChannel(name))),
    allowDirect: config.allowDirect,
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
  log(`${channel.name}: ready`);
  return responder;
}

// Listening first: Webex may deliver as soon as its webhook is registered.
createServer((request, response) => {
  void handle(request, response).catch((error) => {
    log(`request failed: ${error instanceof Error ? error.message : error}`);
    if (!response.headersSent) {
      reply(response, 500, { error: 'internal error' });
    }
  });
}).listen(port, () => log(`listening on :${port}`));

const responders: Responder[] = [];
let webex: WebexChannel | undefined;
if (setting('MATTERMOST_URL', '')) {
  const mattermost = new MattermostChannel({ url: setting('MATTERMOST_URL'), token: setting('MATTERMOST_TOKEN'), log });
  responders.push(
    await connect(mattermost, {
      alertChannel: setting('MATTERMOST_ALERT_CHANNEL', ''),
      channels: list('MATTERMOST_CHANNELS'),
      allowDirect: setting('MATTERMOST_ALLOW_DIRECT', 'true') !== 'false',
    })
  );
}
if (setting('WEBEX_TOKEN', '')) {
  webex = new WebexChannel({
    url: setting('WEBEX_API_URL', 'https://webexapis.com/v1'),
    token: setting('WEBEX_TOKEN'),
    webhookUrl: setting('WEBEX_WEBHOOK_URL'),
    webhookSecret: setting('WEBEX_WEBHOOK_SECRET', '') || undefined,
    log,
  });
  responders.push(
    await connect(webex, {
      alertChannel: setting('WEBEX_ALERT_ROOM', ''),
      channels: list('WEBEX_ROOMS'),
      allowDirect: setting('WEBEX_ALLOW_DIRECT', 'true') !== 'false',
    })
  );
}
if (responders.length === 0) {
  throw new Error('no chat platform is configured: set MATTERMOST_URL or WEBEX_TOKEN');
}
for (const responder of responders) {
  void responder.recover();
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  if (request.method === 'GET' && request.url === '/healthz') {
    return reply(response, 200, { status: 'ok' });
  }
  if (request.method === 'GET' && request.url === '/metrics') {
    response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    response.end(metrics.render());
    return;
  }
  if (request.method === 'POST' && request.url === '/webex/webhook' && webex) {
    const status = await webex.handleWebhook(await body(request), header(request, 'x-spark-signature'));
    response.writeHead(status);
    response.end();
    return;
  }
  if (request.method !== 'POST' || request.url !== '/alerts/grafana') {
    return reply(response, 404, { error: 'not found' });
  }
  if (webhookToken && !sameSecret(request.headers.authorization ?? '', `Bearer ${webhookToken}`)) {
    return reply(response, 401, { error: 'unauthorized' });
  }
  let payload: unknown;
  try {
    payload = JSON.parse((await body(request)).toString('utf8'));
  } catch {
    return reply(response, 400, { error: 'invalid JSON' });
  }
  if (!isGrafanaWebhook(payload)) {
    return reply(response, 400, { error: 'not a Grafana webhook notification' });
  }
  // Grafana retries failed deliveries; answer once the notification is posted everywhere.
  const results = await Promise.all(
    responders.filter((responder) => responder.handlesAlerts).map((responder) => responder.handleAlert(payload))
  );
  log(`alert ${payload.groupKey}: ${results.map((result) => result.action).join(', ') || 'no alert channel'}`);
  return reply(response, 200, results[0] ?? { action: 'skip' });
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function header(request: IncomingMessage, name: string) {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
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
