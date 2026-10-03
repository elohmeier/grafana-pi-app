import { IdentityService } from './identity';

function service(options: {
  emailMatch?: boolean;
  lookup?: (email: string) => Promise<{ uid: string; login: string } | undefined>;
}) {
  const requests: Array<[string, string, unknown]> = [];
  const links = new Map<string, unknown>();
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    requests.push([method, path, body]);
    if (method === 'GET') {
      if (!links.has(path)) {
        throw { status: 404, data: {}, config: {}, statusText: '', message: 'not found' };
      }
      return links.get(path) as T;
    }
    if (method === 'PUT') {
      const link = { ...(body as object), userLogin: (body as { userLogin: string }).userLogin };
      links.set(path, link);
      return link as T;
    }
    return undefined as T;
  };
  return {
    requests,
    links,
    identity: new IdentityService(request, { emailMatch: options.emailMatch, lookupUser: options.lookup }),
  };
}

describe('identity service', () => {
  it('finds links and caches them', async () => {
    const { identity, links, requests } = service({});
    links.set('/identity/links/webex/p1', { userLogin: 'alice' });
    expect(await identity.resolve('webex', 'p1', 'Alice')).toEqual({ userLogin: 'alice' });
    expect(await identity.resolve('webex', 'p1', 'Alice')).toEqual({ userLogin: 'alice' });
    expect(await identity.resolve('webex', 'p2', 'Bob', 'bob@example.com')).toBeUndefined();
    expect(requests.map(([method, path]) => `${method} ${path}`)).toEqual([
      'GET /identity/links/webex/p1',
      'GET /identity/links/webex/p2',
    ]);
  });

  it('links a verified email to the Grafana user with that email, when enabled', async () => {
    const { identity, requests } = service({
      emailMatch: true,
      lookup: async (email) => (email === 'alice@example.com' ? { uid: 'u-alice', login: 'alice' } : undefined),
    });
    expect(await identity.resolve('webex', 'p1', 'Alice', 'alice@example.com')).toMatchObject({ userLogin: 'alice' });
    expect(requests.at(-1)).toEqual([
      'PUT',
      '/identity/links/webex/p1',
      { displayName: 'Alice', userUid: 'u-alice', userLogin: 'alice', source: 'email' },
    ]);
    // Without a verified email, nothing is matched.
    expect(await identity.resolve('webex', 'p2', 'Bob')).toBeUndefined();
  });

  it('stops matching emails when the service account may not look up users', async () => {
    let lookups = 0;
    const { identity } = service({
      emailMatch: true,
      lookup: async () => {
        lookups++;
        throw { status: 403, data: {}, config: {}, statusText: '', message: 'forbidden' };
      },
    });
    await identity.resolve('webex', 'p1', 'Alice', 'alice@example.com');
    await identity.resolve('webex', 'p2', 'Bob', 'bob@example.com');
    expect(lookups).toBe(1);
  });
});
