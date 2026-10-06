/**
 * @jest-environment node
 */
import { LeaseElector } from './lease';

/** An in-memory Lease API with the API server's optimistic concurrency (resourceVersion). */
function fakeApi() {
  let lease: { metadata: { name: string; resourceVersion: string }; spec: Record<string, unknown> } | undefined;
  let version = 0;
  let down = false;
  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (down) {
      return json(503);
    }
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === 'GET') {
      return lease ? json(200, lease) : json(404, { reason: 'NotFound' });
    }
    if (method === 'POST') {
      if (lease) {
        return json(409, { reason: 'AlreadyExists' });
      }
      lease = { metadata: { name: body.metadata.name, resourceVersion: String(++version) }, spec: body.spec };
      return json(201, lease);
    }
    if (method === 'PUT') {
      if (!lease || body.metadata.resourceVersion !== lease.metadata.resourceVersion) {
        return json(409, { reason: 'Conflict' });
      }
      lease = { metadata: { ...lease.metadata, resourceVersion: String(++version) }, spec: body.spec };
      return json(200, lease);
    }
    return json(405);
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    lease: () => lease,
    setDown: (value: boolean) => (down = value),
  };
}

function elector(api: ReturnType<typeof fakeApi>, identity: string) {
  return new LeaseElector({
    apiUrl: 'https://k8s',
    namespace: 'observability',
    name: 'assistant-host',
    identity,
    token: () => 'token',
    durationSeconds: 3,
    renewSeconds: 1,
    fetch: api.fetch,
  });
}

describe('lease elector', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('elects one leader, hands over on release, and takes over an expired lease', async () => {
    const api = fakeApi();
    const a = elector(api, 'pod-a');
    const b = elector(api, 'pod-b');
    await a.acquire(() => undefined);
    expect(a.isLeader).toBe(true);
    expect(api.lease()?.spec.holderIdentity).toBe('pod-a');

    let bLeads = false;
    void b.acquire(() => undefined).then(() => (bLeads = true));
    await jest.advanceTimersByTimeAsync(2000);
    expect(bLeads).toBe(false);

    // A released lease is taken over at the next attempt.
    await a.release();
    await jest.advanceTimersByTimeAsync(1100);
    expect(bLeads).toBe(true);
    expect(api.lease()?.spec).toMatchObject({ holderIdentity: 'pod-b', leaseTransitions: 1 });

    // pod-b stops renewing (for example, it hangs): pod-c takes over after the lease duration.
    await b.release().catch(() => undefined);
    api.lease()!.spec.holderIdentity = 'pod-b';
    api.lease()!.spec.renewTime = new Date(Date.now()).toISOString();
    api.lease()!.spec.leaseDurationSeconds = 3;
    const c = elector(api, 'pod-c');
    let cLeads = false;
    void c.acquire(() => undefined).then(() => (cLeads = true));
    await jest.advanceTimersByTimeAsync(2000);
    expect(cLeads).toBe(false);
    await jest.advanceTimersByTimeAsync(2500);
    expect(cLeads).toBe(true);
    await c.release();
  });

  it('stops leading at the renew deadline, before a standby can take the lease over', async () => {
    const api = fakeApi();
    const a = elector(api, 'pod-a');
    let lostAt: number | undefined;
    const start = Date.now();
    await a.acquire(() => (lostAt = Date.now() - start));
    // The API server stops answering: renewals fail.
    api.setDown(true);
    await jest.advanceTimersByTimeAsync(1900);
    expect(lostAt).toBeUndefined();
    await jest.advanceTimersByTimeAsync(200);
    // Lost at 2 s (2/3 of the 3 s duration), while the lease is still valid for others until 3 s.
    expect(lostAt).toBeGreaterThanOrEqual(2000);
    expect(lostAt).toBeLessThan(3000);
    expect(a.isLeader).toBe(false);
  });

  it('reports a lost lease at once when another replica holds it', async () => {
    const api = fakeApi();
    const a = elector(api, 'pod-a');
    let lost = false;
    await a.acquire(() => (lost = true));
    // Another replica took the lease in a way pod-a's updates conflict with.
    api.lease()!.metadata.resourceVersion = 'changed-elsewhere';
    api.lease()!.spec.holderIdentity = 'pod-b';
    api.lease()!.spec.renewTime = new Date(Date.now() + 60_000).toISOString();
    await jest.advanceTimersByTimeAsync(1000);
    expect(lost).toBe(true);
    expect(a.isLeader).toBe(false);
  });
});
