import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test, expect } from './fixtures';
import { testIds } from '../src/components/testIds';

const base = '/api/plugins/grafana-assistant-app/resources/sessions';
const replica = process.env.PI_HA_REPLICA_URL || 'http://localhost:3003';
test.skip(process.env.PI_SESSION_HA_TEST !== '1', 'Requires the isolated PostgreSQL HA fixture');

test('session writes survive replica changes, reject stale updates, and delete across replicas', async ({
  request,
}) => {
  const id = randomUUID();
  const write = {
    requestId: randomUUID(),
    revision: 0,
    title: 'HA session',
    snapshot: { messages: [{ role: 'user', content: 'Across replicas' }] },
  };
  const created = await request.put(`${base}/${id}`, { data: write });
  expect(created.status(), await created.text()).toBe(200);
  expect((await created.json()).revision).toBe(1);
  const retry = await request.put(`${replica}${base}/${id}`, { data: write });
  expect(await retry.json()).toEqual(await created.json());
  const loaded = await request.get(`${replica}${base}/${id}`);
  expect((await loaded.json()).snapshot).toEqual(write.snapshot);
  const attempts = await Promise.all([
    request.put(`${base}/${id}`, { data: { ...write, revision: 1, requestId: randomUUID(), title: 'A' } }),
    request.put(`${replica}${base}/${id}`, { data: { ...write, revision: 1, requestId: randomUUID(), title: 'B' } }),
  ]);
  expect(attempts.map((result) => result.status()).sort()).toEqual([200, 409]);
  expect(
    (await request.delete(`${replica}${base}/${id}`, { data: { revision: 2, requestId: randomUUID() } })).status()
  ).toBe(200);
  expect((await request.get(`${base}/${id}`)).status()).toBe(404);
  expect((await request.put(`${base}/${id}`, { data: { ...write, requestId: randomUUID() } })).status()).toBe(409);
});

test('picker pages metadata without downloading snapshots and restores a selected history', async ({
  request,
  page,
  gotoPage,
}) => {
  test.setTimeout(90000);
  const prefix = `History ${randomUUID()}`;
  const ids: string[] = [];
  try {
    // Mark this fixture user's empty legacy import complete to measure steady state.
    expect((await request.post(`${base}/migration`)).status()).toBe(200);
    for (let i = 0; i < 65; i++) {
      const id = randomUUID();
      ids.push(id);
      const result = await request.put(`${base}/${id}`, {
        data: {
          requestId: randomUUID(),
          revision: 0,
          title: `${prefix} ${i}`,
          snapshot: {
            messages: [{ role: 'user', content: `Saved history ${i} ` + 'x'.repeat(64000), timestamp: Date.now() }],
          },
        },
      });
      expect(result.status(), await result.text()).toBe(200);
    }
    const requests: string[] = [];
    page.on('request', (req) => requests.push(req.url()));
    const listing = page.waitForResponse((response) => response.url().includes('/sessions?limit=30'));
    await gotoPage('/chat');
    const response = await listing;
    const metadata = await response.json();
    expect(metadata.items).toHaveLength(30);
    expect((await response.body()).byteLength).toBeLessThan(12000);
    expect(
      requests.filter(
        (url) => url.includes('/user-storage/') && decodeURIComponent(url).includes('grafana-assistant-app:')
      )
    ).toEqual([]);
    expect(requests.some((url) => ids.some((id) => url.endsWith(`/sessions/${id}`)))).toBe(false);
    await page.getByRole('button', { name: 'Load more sessions' }).click();
    await expect(page.getByRole('button', { name: new RegExp(`${prefix} 5`) }).first()).toBeVisible();
    const load = page.waitForResponse((response) => response.url().endsWith(`/sessions/${ids[64]}`));
    await page.getByRole('button', { name: new RegExp(`${prefix} 64`) }).click();
    expect((await load).status()).toBe(200);
    await expect(page.getByRole('heading', { name: `${prefix} 64` })).toBeVisible();
    await expect(page.getByText(/^Saved history 64/)).toBeVisible();
  } finally {
    for (const id of ids) {
      await request.delete(`${base}/${id}`, { data: { revision: 1, requestId: randomUUID() } });
    }
  }
});

test('shell conversation persists workspace and reloads without a model', async ({ page, gotoPage, request }) => {
  await gotoPage('/chat');
  const composer = page.getByTestId(testIds.chat.composer);
  const marker = `ha-${randomUUID()}`;
  await composer.fill(`!echo ${marker} > /session/ha.txt; cat /session/ha.txt`);
  const saved = page.waitForResponse(
    (response) => response.url().includes('/resources/sessions/') && response.request().method() === 'PUT'
  );
  await composer.press('Control+Enter');
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
  const metadata = await response.json();
  try {
    const stored = await request.get(`${replica}${base}/${metadata.id}`);
    expect((await stored.json()).snapshot.workspace.files['/session/ha.txt'].content).toContain(marker);
    await composer.fill('');
    const restored = page.waitForResponse(
      (result) => result.url().endsWith(`/sessions/${metadata.id}`) && result.request().method() === 'GET'
    );
    await page.reload();
    expect((await (await restored).json()).snapshot.workspace.files['/session/ha.txt'].content).toContain(marker);
    await expect(page.getByRole('heading', { name: metadata.title, exact: true })).toBeVisible();
  } finally {
    await request.delete(`${base}/${metadata.id}`, { data: { revision: metadata.revision, requestId: randomUUID() } });
  }
});

test('session ownership is enforced for two authenticated Grafana users', async ({ request, browser }) => {
  const password = randomUUID();
  const login = `session-test-${randomUUID()}`;
  const created = await request.post('/api/admin/users', {
    data: { name: login, login, email: `${login}@example.test`, password },
  });
  expect(created.status(), await created.text()).toBe(200);
  const user = await created.json();
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    baseURL: 'http://localhost:3002',
  });
  const id = randomUUID();
  try {
    const loggedIn = await context.request.post('/login', { data: { user: login, password } });
    expect(loggedIn.status(), await loggedIn.text()).toBe(200);
    expect((await (await context.request.get('/api/user')).json()).login).toBe(login);
    const data = { requestId: randomUUID(), revision: 0, title: 'Private', snapshot: { messages: [] } };
    expect((await request.put(`${base}/${id}`, { data })).status()).toBe(200);
    expect((await context.request.get(`${base}/${id}`)).status()).toBe(404);
    expect(
      (await context.request.delete(`${base}/${id}`, { data: { revision: 1, requestId: randomUUID() } })).status()
    ).toBe(409);
    expect((await context.request.put(`${base}/${id}`, { data })).status()).toBe(200);
    expect((await request.get(`${replica}${base}/${id}`)).status()).toBe(200);
    await context.request.delete(`${base}/${id}`, { data: { revision: 1, requestId: randomUUID() } });
  } finally {
    await request.delete(`${base}/${id}`, { data: { revision: 1, requestId: randomUUID() } });
    await context.close();
    await request.delete(`/api/admin/users/${user.id}`);
  }
});

test('an unavailable store preserves the draft, shows an error, and supports retry', async ({
  page,
  gotoPage,
  request,
}) => {
  await gotoPage('/chat');
  await page.route('**/resources/sessions/*', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Session database is unavailable' }),
      });
    } else {
      await route.continue();
    }
  });
  const composer = page.getByTestId(testIds.chat.composer);
  await composer.fill('!echo outage-recovery');
  await composer.press('Control+Enter');
  await expect(page.getByText('Not saved', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  await page.unroute('**/resources/sessions/*');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  const id = new URL(page.url()).searchParams.get('session');
  expect(id).toBeTruthy();
  const stored = await request.get(`${replica}${base}/${id}`);
  expect(stored.status()).toBe(200);
  const data = await stored.json();
  expect(data.snapshot.messages[0].result.stdout).toContain('outage-recovery');
  await request.delete(`${base}/${id}`, { data: { revision: data.revision, requestId: randomUUID() } });
});

test('a replica restart and PostgreSQL restart retain saved sessions', async ({ request }) => {
  test.setTimeout(120000);
  const compose = ['compose', '-p', 'pi-sessions-ha', '-f', 'docker-compose.sessions-ha.yaml'];
  const id = randomUUID();
  expect(
    (
      await request.put(`${base}/${id}`, {
        data: { requestId: randomUUID(), revision: 0, title: 'Restart', snapshot: { messages: [] } },
      })
    ).status()
  ).toBe(200);
  try {
    execFileSync('docker', [...compose, 'stop', 'grafana-a']);
    expect((await request.get(`${replica}${base}/${id}`)).status()).toBe(200);
    execFileSync('docker', [...compose, 'start', 'grafana-a']);
    await expect
      .poll(
        async () => {
          try {
            return (await request.get(`${base}/${id}`)).status();
          } catch {
            return 0;
          }
        },
        { timeout: 60000 }
      )
      .toBe(200);
    execFileSync('docker', [...compose, 'restart', 'postgres']);
    await expect
      .poll(
        async () => {
          try {
            return (await request.get(`${replica}${base}/${id}`)).status();
          } catch {
            return 0;
          }
        },
        { timeout: 60000 }
      )
      .toBe(200);
  } finally {
    execFileSync('docker', [...compose, 'start', 'grafana-a', 'postgres']);
    await request.delete(`${base}/${id}`, { data: { revision: 1, requestId: randomUUID() } });
  }
});
