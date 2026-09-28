import { of, throwError } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import { SessionRepository } from './SessionRepository';

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: jest.fn(),
  config: { namespace: 'default', bootData: { user: { uid: 'user-a', id: 1 } } },
}));

const fetch = jest.fn();
const legacy = { getItem: jest.fn(), setItem: jest.fn() };
const document = {
  id: 'session-a',
  title: 'One',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  messages: [{ role: 'user', content: 'hi' }],
};
const respond = (data: unknown) => of({ data });
beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
  fetch.mockImplementation(({ url }: { url: string }) => {
    if (url.endsWith('/status')) {
      return respond({ enabled: true, importComplete: true });
    }
    return respond({ items: [] });
  });
});

it('lists metadata without initializing legacy storage or loading snapshots', async () => {
  await new SessionRepository(legacy).list();
  expect(fetch.mock.calls.map(([req]) => req.url)).toEqual([
    expect.stringContaining('/sessions/status'),
    expect.stringContaining('/sessions?limit=30'),
  ]);
  expect(legacy.getItem).not.toHaveBeenCalled();
});

it('never silently falls back when the configured store is unavailable', async () => {
  fetch.mockReturnValue(throwError(() => ({ status: 503 })));
  await expect(new SessionRepository(legacy).list()).rejects.toThrow('not been confirmed saved');
  expect(legacy.getItem).not.toHaveBeenCalled();
  expect(legacy.setItem).not.toHaveBeenCalled();
});

it('retains legacy mode only when the backend explicitly disables PostgreSQL', async () => {
  fetch.mockReturnValue(respond({ enabled: false }));
  legacy.getItem.mockResolvedValue(JSON.stringify([document]));
  await expect(new SessionRepository(legacy).list()).resolves.toEqual({ items: [document] });
});

it('serializes writes and retries an uncertain request before advancing its revision', async () => {
  const repo = new SessionRepository(legacy);
  await repo.initialize();
  let lost = true;
  fetch.mockImplementation(({ data }: { data: { revision: number } }) => {
    if (lost) {
      lost = false;
      return throwError(() => ({ status: 503 }));
    }
    return respond({ ...document, revision: data.revision + 1 });
  });
  await expect(repo.save(document)).rejects.toThrow();
  await repo.save({ ...document, title: 'Two' });
  const writes = fetch.mock.calls.slice(1).map(([req]) => req.data);
  expect(writes[0]).toEqual(writes[1]);
  expect(writes[2].revision).toBe(1);
  expect(writes[2].requestId).not.toBe(writes[1].requestId);
});

it('does not refresh an editing revision from newer list metadata', async () => {
  const repo = new SessionRepository(legacy);
  await repo.initialize();
  fetch.mockReturnValueOnce(respond({ ...document, revision: 2, snapshot: document }));
  await repo.get(document.id);
  fetch.mockReturnValueOnce(respond({ items: [{ ...document, revision: 5 }] }));
  await repo.list();
  fetch.mockReturnValueOnce(throwError(() => ({ status: 409, data: { error: 'conflict' } })));
  await expect(repo.save(document)).rejects.toThrow('conflict');
  expect(fetch.mock.calls.at(-1)![0].data.revision).toBe(2);
  await expect(repo.save(document)).rejects.toThrow('Reload the page');
});

it('imports orphan bodies and browser fallback data once without deleting originals', async () => {
  localStorage.setItem('g42-pi-app:user-a:sessions:local', JSON.stringify({ ...document, id: 'local' }));
  fetch.mockImplementation(({ url }: { url: string }) => {
    if (url.endsWith('/status')) {
      return respond({ enabled: true, importComplete: false });
    }
    if (url.includes('/user-storage/')) {
      return respond({
        spec: { data: { 'sessions:index': '[]', 'sessions:orphan': JSON.stringify({ ...document, id: 'orphan' }) } },
      });
    }
    return respond({ ...document, revision: 1 });
  });
  const repo = new SessionRepository(legacy);
  await repo.initialize();
  await repo.initialize();
  const writes = fetch.mock.calls.filter(([req]) => req.method === 'PUT');
  expect(writes.map(([req]) => req.data.snapshot.id)).toEqual(['orphan', 'local']);
  expect(writes.every(([req]) => req.data.import)).toBe(true);
  expect(localStorage.length).toBe(1);
  expect(fetch.mock.calls.filter(([req]) => req.url.endsWith('/migration'))).toHaveLength(1);
});

it('does not mark migration complete after a legacy read failure', async () => {
  fetch.mockImplementation(({ url }: { url: string }) =>
    url.endsWith('/status') ? respond({ enabled: true, importComplete: false }) : throwError(() => ({ status: 500 }))
  );
  await expect(new SessionRepository(legacy).initialize()).rejects.toThrow('Could not read legacy sessions');
  expect(fetch.mock.calls.some(([req]) => req.url.endsWith('/migration'))).toBe(false);
});

it('imports another browser fallback after server import without fetching the legacy blob again', async () => {
  localStorage.setItem('g42-pi-app:user-a:sessions:local', JSON.stringify({ ...document, id: 'local' }));
  fetch.mockImplementation(({ url }: { url: string }) =>
    url.endsWith('/status')
      ? respond({ enabled: true, importComplete: true, scopeKey: 'scope-a' })
      : respond({ ...document, revision: 1 })
  );
  await new SessionRepository(legacy).initialize();
  expect(fetch.mock.calls.filter(([req]) => req.method === 'PUT')).toHaveLength(1);
  await new SessionRepository(legacy).initialize();
  expect(fetch.mock.calls.filter(([req]) => req.method === 'PUT')).toHaveLength(1);
  expect(fetch.mock.calls.some(([req]) => req.url.includes('/user-storage/'))).toBe(false);
});
