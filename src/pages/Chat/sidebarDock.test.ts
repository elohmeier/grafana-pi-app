import {
  consumeAssistantSidebarDockRequest,
  getAssistantDockRoute,
  rememberAssistantDockRoute,
  routeFromLocation,
  storeAssistantSidebarDockRequest,
} from './sidebarDock';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  keys() {
    return [...this.values.keys()];
  }
}

describe('Assistant sidebar dock handoff', () => {
  it('stores and consumes a session dock request once', () => {
    const storage = new MemoryStorage();

    storeAssistantSidebarDockRequest({ sessionId: 'session-1', path: '/d/test' }, storage, 1000);

    expect(consumeAssistantSidebarDockRequest(storage, 1000)).toEqual({
      path: '/d/test',
      sessionId: 'session-1',
    });
    expect(consumeAssistantSidebarDockRequest(storage, 1000)).toBeUndefined();
  });

  it('stores and consumes dashboard launch dock props', () => {
    const storage = new MemoryStorage();

    storeAssistantSidebarDockRequest({ action: 'troubleshoot', contextId: 'ctx-1' }, storage, 1000);

    expect(consumeAssistantSidebarDockRequest(storage, 1000)).toEqual({
      action: 'troubleshoot',
      contextId: 'ctx-1',
    });
  });

  it('expires stale dock requests', () => {
    const storage = new MemoryStorage();

    storeAssistantSidebarDockRequest({ sessionId: 'session-1' }, storage, 1000);

    expect(consumeAssistantSidebarDockRequest(storage, 1000 + 120001)).toBeUndefined();
  });

  it('remembers and normalizes the last non-app route', () => {
    const storage = new MemoryStorage();

    rememberAssistantDockRoute('/d/service?orgId=1#panel-7', storage, 1000);

    expect(getAssistantDockRoute(storage, 1000)).toBe('/d/service?orgId=1#panel-7');
  });

  it('ignores external-looking dock routes', () => {
    const storage = new MemoryStorage();

    rememberAssistantDockRoute('https://example.com/d/service', storage, 1000);

    expect(getAssistantDockRoute(storage, 1000)).toBeUndefined();
  });

  it('keeps the last route when the user passes through sign-in pages', () => {
    const storage = new MemoryStorage();

    rememberAssistantDockRoute('/d/service', storage, 1000);
    rememberAssistantDockRoute('/login', storage, 1000);
    rememberAssistantDockRoute('/user/password/change?forceLogin=true', storage, 1000);

    expect(getAssistantDockRoute(storage, 1000)).toBe('/d/service');
    expect(routeFromLocation({ pathname: '/login/', search: '?redirect=%2F' })).toBeUndefined();
    expect(routeFromLocation({ pathname: '/loginx' })).toBe('/loginx');
  });

  it('drops a stored sign-in route', () => {
    const storage = new MemoryStorage();
    rememberAssistantDockRoute('/d/service', storage, 1000);
    const [key] = storage.keys();
    storage.setItem(key, JSON.stringify({ schemaVersion: 1, createdAt: 1000, route: '/login' }));

    expect(getAssistantDockRoute(storage, 1000)).toBeUndefined();
  });

  it('formats a route from a Grafana location object', () => {
    expect(routeFromLocation({ pathname: '/d/service', search: '?orgId=1', hash: '#panel-7' })).toBe(
      '/d/service?orgId=1#panel-7'
    );
  });
});
