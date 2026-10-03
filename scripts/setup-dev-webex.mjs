#!/usr/bin/env node
// Creates the local Webex fake's bot, people, and rooms (Compose profile `webex`,
// docs/webex.md). The fake keeps everything in memory, so run this after each
// start of its container; `mise run dev:webex` does. Tokens go to work/host/.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secrets = path.join(root, 'work/host');
const fakeUrl = (process.env.WEBEX_FAKE_URL ?? 'http://localhost:8099').replace(/\/$/, '');

async function control(method, url, body) {
  const response = await fetch(`${fakeUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${url}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

for (let attempt = 0; ; attempt++) {
  try {
    await control('GET', '/_test/state');
    break;
  } catch (error) {
    if (attempt > 60) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const bot = await control('POST', '/_test/people', {
  email: 'grafana-assistant@webex.bot',
  displayName: 'Grafana Assistant',
  bot: true,
});
const alice = await control('POST', '/_test/people', { email: 'alice@example.com', displayName: 'Alice Doe' });
const bob = await control('POST', '/_test/people', { email: 'bob@example.com', displayName: 'Bob Roe' });
const members = [bot.id, alice.id, bob.id];
const alerts = await control('POST', '/_test/rooms', { title: 'Alerts', members });
const ops = await control('POST', '/_test/rooms', { title: 'Ops', members });
const direct = await control('POST', '/_test/rooms', {
  title: 'Alice Doe',
  type: 'direct',
  members: [bot.id, alice.id],
});

await mkdir(secrets, { recursive: true });
await writeFile(path.join(secrets, 'webex-token'), `${bot.token}\n`, { mode: 0o600 });
await writeFile(
  path.join(secrets, 'webex-fake.json'),
  `${JSON.stringify({ url: fakeUrl, bot: bot.id, people: { alice: alice.id, bob: bob.id }, rooms: { alerts: alerts.id, ops: ops.id, direct: direct.id } }, null, 2)}\n`,
  { mode: 0o600 }
);
console.log(
  `Webex fake: bot ${bot.displayName}, people Alice Doe and Bob Roe, rooms Alerts and Ops, and a direct room (${fakeUrl})`
);
