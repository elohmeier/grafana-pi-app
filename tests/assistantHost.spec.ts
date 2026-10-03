import { readFileSync } from 'node:fs';
import { test, expect, type APIRequestContext } from '@playwright/test';

const HOST_URL = process.env.ASSISTANT_HOST_URL ?? 'http://localhost:8080';
const MATTERMOST_URL = process.env.MATTERMOST_URL ?? 'http://localhost:8065';

function secret(name: string) {
  try {
    return readFileSync(`work/host/${name}`, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Alert delivery through the assistant host (Compose profile `mattermost`,
 * docs/mattermost.md) without depending on the model: a synthetic Grafana
 * webhook opens one thread, a repeated notification is skipped, and the
 * resolution replies in the same thread. Skipped unless `mise run dev:mattermost` ran.
 */
test.describe('assistant host', () => {
  test('posts alert notifications as one thread per firing episode', async ({ request }) => {
    const webhookToken = secret('alert-webhook-token');
    const health = await request.get(`${HOST_URL}/healthz`).catch(() => undefined);
    test.skip(!health?.ok() || !webhookToken, 'needs the assistant host (mise run dev:mattermost)');

    const mattermost = await mattermostSession(request);
    const channel = await mattermost.get('/teams/name/ops/channels/name/alerts');
    const groupKey = `{}:{alertname="E2E ${Date.now()}"}`;
    const alertname = groupKey.slice(groupKey.indexOf('"') + 1, -2);
    const payload = (status: 'firing' | 'resolved') => ({
      status,
      groupKey,
      groupLabels: { alertname },
      commonLabels: { alertname },
      commonAnnotations: { summary: 'Synthetic alert from the e2e test' },
      alerts: [
        {
          status,
          labels: { alertname, instance: 'vm-web-01' },
          annotations: { summary: 'Synthetic alert from the e2e test' },
          startsAt: new Date().toISOString(),
          fingerprint: 'e2e-1',
          generatorURL: 'http://localhost:3001/alerting/grafana/e2e/view',
        },
      ],
    });
    const send = (body: unknown, token = webhookToken) =>
      request.post(`${HOST_URL}/alerts/grafana`, { data: body, headers: { Authorization: `Bearer ${token}` } });

    expect((await send(payload('firing'), 'wrong')).status()).toBe(401);
    const opened = await send(payload('firing'));
    expect(opened.ok()).toBe(true);
    const { action, threadId } = await opened.json();
    expect(action).toBe('open');
    // Grafana repeats notifications; an unchanged episode is not posted again.
    expect((await (await send(payload('firing'))).json()).action).toBe('skip');
    expect((await (await send(payload('resolved'))).json()).action).toBe('resolve');

    const root = await mattermost.get(`/posts/${threadId}`);
    expect(root.channel_id).toBe(channel.id);
    expect(root.message).toContain(alertname);
    const thread = await mattermost.get(`/posts/${threadId}/thread`);
    const messages = Object.values(thread.posts as Record<string, { message: string }>).map((post) => post.message);
    expect(messages.filter((message) => message.includes(`Resolved: ${alertname}`))).toHaveLength(1);
  });

  test('posts alert notifications to Webex rooms through the fake', async ({ request }) => {
    const webhookToken = secret('alert-webhook-token');
    const fake = (() => {
      try {
        return JSON.parse(readFileSync('work/host/webex-fake.json', 'utf8')) as {
          url: string;
          rooms: { alerts: string };
        };
      } catch {
        return undefined;
      }
    })();
    const health = await request.get(`${HOST_URL}/healthz`).catch(() => undefined);
    const fakeUp = fake ? await request.get(`${fake.url}/_test/state`).catch(() => undefined) : undefined;
    test.skip(
      !health?.ok() || !webhookToken || !fakeUp?.ok(),
      'needs the assistant host with Webex (mise run dev:webex)'
    );

    const alertname = `Webex E2E ${Date.now()}`;
    const payload = (status: 'firing' | 'resolved') => ({
      status,
      groupKey: `{}:{alertname="${alertname}"}`,
      groupLabels: { alertname },
      commonLabels: { alertname },
      alerts: [
        { status, labels: { alertname }, annotations: {}, startsAt: new Date().toISOString(), fingerprint: 'webex-1' },
      ],
    });
    const send = (body: unknown) =>
      request.post(`${HOST_URL}/alerts/grafana`, { data: body, headers: { Authorization: `Bearer ${webhookToken}` } });
    expect((await send(payload('firing'))).ok()).toBe(true);
    expect((await (await send(payload('resolved'))).json()).action).toBe('resolve');

    const messages = (await (await request.get(`${fake!.url}/_test/rooms/${fake!.rooms.alerts}/messages`)).json())
      .items as Array<{
      id: string;
      parentId?: string;
      markdown?: string;
    }>;
    const root = messages.find((message) => !message.parentId && message.markdown?.includes(alertname));
    expect(root).toBeDefined();
    const replies = messages.filter((message) => message.parentId === root!.id).map((message) => message.markdown);
    expect(replies.filter((text) => text?.includes(`Resolved: ${alertname}`))).toHaveLength(1);
  });
});

async function mattermostSession(request: APIRequestContext) {
  const login = await request.post(`${MATTERMOST_URL}/api/v4/users/login`, {
    data: { login_id: 'admin', password: process.env.MATTERMOST_ADMIN_PASSWORD ?? 'Admin-dev1!' },
  });
  expect(login.ok()).toBe(true);
  const token = login.headers()['token'];
  return {
    async get(path: string) {
      const response = await request.get(`${MATTERMOST_URL}/api/v4${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.ok()).toBe(true);
      return response.json();
    },
  };
}
