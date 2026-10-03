#!/usr/bin/env node
// Configures the local Mattermost incident setup (Compose profile `mattermost`,
// docs/mattermost.md). Idempotent; run again after the Grafana or Mattermost
// container was recreated, since neither keeps its database.
//
// Mattermost: admin user, team `ops` with channel `alerts`, bot `grafana-assistant`
// with an access token. Grafana (port 3001): service account `assistant-host`
// (Viewer) with a new token, and a webhook contact point for the assistant host
// with a notification policy route for the alerts of one folder. Secrets are written to
// work/host/, which the assistant host container reads.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secrets = path.join(root, 'work/host');
const grafanaUrl = (process.env.GRAFANA_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const grafanaAuth = `Basic ${Buffer.from(`${process.env.GRAFANA_USER ?? 'admin'}:${process.env.GRAFANA_PASSWORD ?? 'admin'}`).toString('base64')}`;
const mattermostUrl = (process.env.MATTERMOST_URL ?? 'http://localhost:8065').replace(/\/$/, '');
const admin = {
  username: process.env.MATTERMOST_ADMIN_USER ?? 'admin',
  password: process.env.MATTERMOST_ADMIN_PASSWORD ?? 'Admin-dev1!',
  email: 'admin@example.com',
};
// The URL Grafana uses to reach the host, inside the Compose network.
const hostWebhookUrl = process.env.ASSISTANT_HOST_WEBHOOK_URL ?? 'http://assistant-host:8080/alerts/grafana';
const CONTACT_POINT_UID = 'assistant-host';
const alertFolder = process.env.ASSISTANT_ALERT_FOLDER ?? 'Assistant Dev Samples';

async function call(base, method, url, { auth, body, headers = {}, ok = [200, 201], raw = false } = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { ...(auth ? { Authorization: auth } : {}), 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!ok.includes(response.status)) {
    throw new Error(`${method} ${base}${url}: ${response.status} ${text.slice(0, 300)}`);
  }
  return raw ? { response, text } : text ? JSON.parse(text) : undefined;
}

async function waitFor(name, url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(url)).ok) {
        return;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${name} did not become ready at ${url}`);
}

async function setupMattermost() {
  await waitFor('Mattermost', `${mattermostUrl}/api/v4/system/ping`);
  const mm = (method, url, options = {}) => call(mattermostUrl, method, `/api/v4${url}`, options);
  // The first user becomes the system admin.
  await mm('POST', '/users', { body: admin, ok: [201, 400, 403] });
  const login = await mm('POST', '/users/login', {
    body: { login_id: admin.username, password: admin.password },
    raw: true,
  });
  const auth = `Bearer ${login.response.headers.get('token')}`;
  const me = JSON.parse(login.text);

  // Lookups answer 404 with an error object, which has an `id` too.
  const find = async (url) => {
    const found = await mm('GET', url, { auth, ok: [200, 404] });
    return found.status_code ? undefined : found;
  };
  const team =
    (await find('/teams/name/ops')) ??
    (await mm('POST', '/teams', { auth, body: { name: 'ops', display_name: 'Ops', type: 'O' } }));
  const teamId = team.id;
  const findChannel = async (name, displayName) => {
    return (
      (await find(`/teams/${teamId}/channels/name/${name}`)) ??
      mm('POST', '/channels', { auth, body: { team_id: teamId, name, display_name: displayName, type: 'O' } })
    );
  };
  const alerts = await findChannel('alerts', 'Alerts');
  const townSquare = await findChannel('town-square', 'Town Square');

  let bot = await find('/users/username/grafana-assistant');
  if (!bot) {
    const created = await mm('POST', '/bots', {
      auth,
      body: { username: 'grafana-assistant', display_name: 'Grafana Assistant', description: 'Observability Analyst' },
    });
    bot = { id: created.user_id };
  }
  for (const userId of [me.id, bot.id]) {
    await mm('POST', `/teams/${teamId}/members`, { auth, body: { team_id: teamId, user_id: userId }, ok: [201, 200] });
    for (const channel of [alerts, townSquare]) {
      await mm('POST', `/channels/${channel.id}/members`, { auth, body: { user_id: userId }, ok: [201, 200] });
    }
  }
  const token = await mm('POST', `/users/${bot.id}/tokens`, {
    auth,
    body: { description: `dev ${new Date().toISOString()}` },
  });
  await writeFile(path.join(secrets, 'mattermost-token'), `${token.token}\n`, { mode: 0o600 });
  console.log(
    `Mattermost: team ops, channels alerts and town-square, bot @grafana-assistant (log in as ${admin.username} / ${admin.password} at ${mattermostUrl})`
  );
}

async function setupGrafana() {
  await waitFor('Grafana', `${grafanaUrl}/api/health`);
  const gf = (method, url, options = {}) => call(grafanaUrl, method, url, { auth: grafanaAuth, ...options });
  const search = await gf('GET', '/api/serviceaccounts/search?query=assistant-host');
  const account =
    search.serviceAccounts.find((sa) => sa.name === 'assistant-host') ??
    (await gf('POST', '/api/serviceaccounts', { body: { name: 'assistant-host', role: 'Viewer' } }));
  const token = await gf('POST', `/api/serviceaccounts/${account.id}/tokens`, {
    body: { name: `dev-${Date.now()}` },
  });
  await writeFile(path.join(secrets, 'grafana-token'), `${token.key}\n`, { mode: 0o600 });

  const webhookTokenFile = path.join(secrets, 'alert-webhook-token');
  const webhookToken = await readFile(webhookTokenFile, 'utf8').then(
    (value) => value.trim(),
    async () => {
      const value = randomBytes(24).toString('hex');
      await writeFile(webhookTokenFile, `${value}\n`, { mode: 0o600 });
      return value;
    }
  );
  const contactPoint = {
    uid: CONTACT_POINT_UID,
    name: 'Assistant (Mattermost)',
    type: 'webhook',
    settings: {
      url: hostWebhookUrl,
      httpMethod: 'POST',
      authorization_scheme: 'Bearer',
      authorization_credentials: webhookToken,
    },
  };
  const provisioning = { 'X-Disable-Provenance': 'true' };
  const existing = await gf('GET', '/api/v1/provisioning/contact-points');
  if (existing.some((point) => point.uid === CONTACT_POINT_UID)) {
    await gf('PUT', `/api/v1/provisioning/contact-points/${CONTACT_POINT_UID}`, {
      body: contactPoint,
      headers: provisioning,
      ok: [200, 202],
    });
  } else {
    await gf('POST', '/api/v1/provisioning/contact-points', {
      body: contactPoint,
      headers: provisioning,
      ok: [200, 201, 202],
    });
  }
  // Only alerts of one folder go to the assistant; the seeded corpus has hundreds of rules.
  const policy = await gf('GET', '/api/v1/provisioning/policies');
  const route = {
    receiver: contactPoint.name,
    object_matchers: [['grafana_folder', '=', alertFolder]],
    group_by: ['grafana_folder', 'alertname'],
    group_wait: '10s',
    group_interval: '1m',
    repeat_interval: '4h',
    continue: false,
  };
  const routes = (policy.routes ?? []).filter((existing) => existing.receiver !== contactPoint.name);
  await gf('PUT', '/api/v1/provisioning/policies', {
    body: { ...policy, routes: [route, ...routes] },
    headers: provisioning,
    ok: [200, 202],
  });
  console.log(
    `Grafana: service account assistant-host (Viewer), contact point ${contactPoint.name} -> ${hostWebhookUrl} for alerts in folder ${JSON.stringify(alertFolder)}`
  );
}

await mkdir(secrets, { recursive: true });
await setupGrafana();
await setupMattermost();
