import { streamProxy } from '@earendil-works/pi-agent-core';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import path from 'node:path';
import { PLUGIN_ID } from '../constants';
import { grafanaChatLog } from '../pages/Chat/durable/grafanaChatLog';
import { createGrafanaStreamFn } from '../pages/Chat/grafanaStream';
import { renderDashboardScreenshot } from '../pages/Chat/domain/dashboards';
import { createGrafanaWorkspaceBroker } from '../pages/Chat/workspace/grafanaBroker';
import type { WorkspaceBroker } from '../pages/Chat/workspace/broker';
import type { PiAppJsonData } from '../types';
import { isGrafanaWebhook } from './alerts';
import { parseAlertRoute, sameSecret, verifyAlertRequest, type AlertRoute } from './alertRoutes';
import { IdentityService, lookupGrafanaUser, pluginRequest } from './identity';
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
import { backendState } from './backendState';
import { inClusterConfig, labelPod, LeaseElector } from './lease';
import { fileState, HostStore } from './store';

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
// Authenticates alert notifications (HMAC or Bearer) and the plugin backend's channel list.
const webhookToken = setting('ALERT_WEBHOOK_TOKEN');
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

// With several replicas (Kubernetes), one leader holds a Lease and the state lives in the plugin backend.
const leaseName = setting('LEASE_NAME', '');
const cluster = leaseName ? inClusterConfig() : undefined;
const pod = setting('POD_NAME', hostname());
const elector = cluster ? new LeaseElector({ ...cluster, name: leaseName, identity: pod, log }) : undefined;
/** Marks this pod as the leader for the Service, or unmarks it. */
const markLeader = (leader: boolean) => (cluster ? labelPod({ ...cluster, pod }, leader) : Promise.resolve());
const stateBackend = setting('HOST_STATE', leaseName ? 'backend' : 'file') === 'backend';
const store = new HostStore(
  stateBackend
    ? backendState(pluginRequest(PLUGIN_ID), {
        onConflict: () => {
          log('host state was written by another replica; stopping');
          process.exit(1);
        },
      })
    : fileState(path.join(setting('HOST_DATA_DIR', './work/host'), 'state.json'))
);
/** This replica serves: it holds the lease (if any) and its platforms are connected. */
let ready = false;
/** The process works; a standby is healthy too and can take over. */
let initialized = false;

const list = (name: string) =>
  setting(name, '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** One responder per configured platform; they share the assistant, the store, and the alert notifications. */
async function connect(channel: ChatChannel, config: { channels: string[]; allowDirect: boolean }): Promise<Responder> {
  const responder = new Responder({
    channel,
    assistant,
    store,
    channelIds: await Promise.all(config.channels.map((name) => channel.resolveChannel(name))),
    allowDirect: config.allowDirect,
    alertPanels: async (payload) => renderAlertPanels(payload, createBroker(await jsonData()), log),
    metrics,
    identity: {
      service: identity,
      require: setting('ASSISTANT_REQUIRE_LINK', 'false') === 'true',
      linkUrl: (code) => `${publicUrl}/a/${PLUGIN_ID}/chat?link=${encodeURIComponent(code)}`,
    },
    sharedChatUrl: (token) => `${publicUrl}/a/${PLUGIN_ID}/chat?share=${encodeURIComponent(token)}`,
    log,
  });
  platforms.set(channel.name, { channel, responder });
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

// Chat accounts linked to Grafana users; verified emails match when the service account may look up users.
const identity = new IdentityService(pluginRequest(PLUGIN_ID), {
  emailMatch: setting('ASSISTANT_EMAIL_MATCH', 'false') === 'true',
  lookupUser: lookupGrafanaUser,
});

// Registered before waiting for the lease, so a standby stops cleanly too.
process.on('SIGTERM', () => {
  log('stopping');
  ready = false;
  void markLeader(false)
    .catch(() => undefined)
    .then(() => elector?.release())
    .finally(() => process.exit(0));
});

if (elector) {
  // A label left from before a restart must not draw traffic to a standby.
  await markLeader(false);
  initialized = true;
  log(`lease ${leaseName}: waiting to lead as ${pod}`);
  await elector.acquire(() => {
    // Another replica may be the leader now: stop taking traffic and restart as a standby.
    log('lost the lease; stopping');
    ready = false;
    // Exits soon even when the API server does not answer the label change.
    setTimeout(() => process.exit(1), 2000).unref();
    void markLeader(false)
      .catch(() => undefined)
      .finally(() => process.exit(1));
  });
}
await store.load();

const responders: Responder[] = [];
/** The platforms by name, for alert channels (`/alerts/<platform>/<channel>`). */
const platforms = new Map<string, { channel: ChatChannel; responder: Responder }>();
if (setting('MATTERMOST_URL', '')) {
  const mattermost = new MattermostChannel({ url: setting('MATTERMOST_URL'), token: setting('MATTERMOST_TOKEN'), log });
  responders.push(
    await connect(mattermost, {
      channels: list('MATTERMOST_CHANNELS'),
      allowDirect: setting('MATTERMOST_ALLOW_DIRECT', 'true') !== 'false',
    })
  );
}
if (setting('WEBEX_TOKEN', '')) {
  const webex = new WebexChannel({
    url: setting('WEBEX_API_URL', 'https://webexapis.com/v1'),
    token: setting('WEBEX_TOKEN'),
    catalogUrl: setting('WEBEX_CATALOG_URL', '') || undefined,
    deviceUrl: setting('WEBEX_DEVICE_URL', '') || undefined,
    log,
  });
  responders.push(
    await connect(webex, {
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
ready = true;
initialized = true;
await markLeader(true);
log('ready');

async function handle(request: IncomingMessage, response: ServerResponse) {
  if (request.method === 'GET' && request.url === '/healthz') {
    return reply(response, 200, { status: 'ok' });
  }
  // Readiness: initialized, standby or leader. The Service selects the leader by its pod label.
  if (request.method === 'GET' && request.url === '/readyz') {
    return reply(response, initialized ? 200 : 503, { ready, leader: elector?.isLeader ?? true });
  }
  if (!ready && request.method === 'POST') {
    // Grafana retries; the leader answers.
    return reply(response, 503, { error: 'not ready' });
  }
  if (request.method === 'GET' && request.url === '/metrics') {
    response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    response.end(metrics.render());
    return;
  }
  if (request.method === 'GET' && request.url === '/api/channels') {
    // For the plugin backend, which lists them to admins creating contact points.
    if (!sameSecret(request.headers.authorization ?? '', `Bearer ${webhookToken}`)) {
      return reply(response, 401, { error: 'unauthorized' });
    }
    return reply(response, 200, { platforms: await listPlatforms() });
  }
  const alertRoute = request.method === 'POST' ? parseAlertRoute(request.url ?? '') : undefined;
  if (alertRoute) {
    return handleAlertChannel(request, response, alertRoute);
  }
  return reply(response, 404, { error: 'not found' });
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** Resolved alert channels, for a while: a room left by the bot fails again after this time. */
const resolvedChannels = new Map<string, { id: string; until: number }>();
const RESOLVED_CHANNEL_TTL_MS = 5 * 60_000;

/** A notification of an alert channel: a Grafana webhook contact point that names its chat channel (docs/alert-channels.md). */
async function handleAlertChannel(
  request: IncomingMessage,
  response: ServerResponse,
  route: AlertRoute | { error: string }
) {
  const raw = await body(request);
  if (!verifyAlertRequest(request.headers, raw, webhookToken)) {
    return reply(response, 401, {
      error: 'unauthorized: sign with the host token (HMAC) or send it as a Bearer token',
    });
  }
  if ('error' in route) {
    return reply(response, 400, { error: route.error });
  }
  const platform = platforms.get(route.platform);
  if (!platform) {
    return reply(response, 404, { error: `${route.platform} is not configured on the assistant host` });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return reply(response, 400, { error: 'invalid JSON' });
  }
  if (!isGrafanaWebhook(payload)) {
    return reply(response, 400, { error: 'not a Grafana webhook notification' });
  }
  const key = `${route.platform}:${route.channel}`;
  const cached = resolvedChannels.get(key);
  let channelId = cached && cached.until > Date.now() ? cached.id : undefined;
  if (!channelId) {
    try {
      channelId = await platform.channel.resolveChannel(route.channel);
    } catch (error) {
      // Grafana shows this in the contact point's delivery status.
      return reply(response, 404, { error: error instanceof Error ? error.message : String(error) });
    }
    resolvedChannels.set(key, { id: channelId, until: Date.now() + RESOLVED_CHANNEL_TTL_MS });
  }
  // Grafana retries failed deliveries; answer once the notification is posted.
  const result = await platform.responder.handleAlert(payload, { channelId, options: route.options });
  log(`alert ${payload.groupKey} to ${key}: ${result.action}`);
  return reply(response, 200, result);
}

/** The channels each platform's bot can post alerts to. */
async function listPlatforms() {
  return Promise.all(
    [...platforms.values()].map(async ({ channel }) => ({
      platform: channel.name,
      bot: channel.botName,
      channels: await channel.listChannels(),
    }))
  );
}
