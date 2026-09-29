import type { DashboardAssistantAction } from './dashboardLaunch';
import { PLUGIN_ID } from '../../constants';

type StorageLike = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

export type AssistantSidebarDockRequest = {
  action?: DashboardAssistantAction;
  contextId?: string;
  path?: string;
  sessionId?: string;
};

type StoredAssistantSidebarDockRequest = AssistantSidebarDockRequest & {
  schemaVersion: typeof ASSISTANT_SIDEBAR_DOCK_SCHEMA_VERSION;
  createdAt: number;
};

type StoredAssistantDockRoute = {
  schemaVersion: typeof ASSISTANT_SIDEBAR_DOCK_SCHEMA_VERSION;
  createdAt: number;
  route: string;
};

const ASSISTANT_SIDEBAR_DOCK_SCHEMA_VERSION = 1;
const ASSISTANT_SIDEBAR_DOCK_REQUEST_MAX_AGE_MS = 2 * 60 * 1000;
const ASSISTANT_SIDEBAR_LAST_ROUTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ASSISTANT_SIDEBAR_DOCK_REQUEST_KEY = `${PLUGIN_ID}.assistant-sidebar-dock-request`;
const ASSISTANT_SIDEBAR_LAST_ROUTE_KEY = `${PLUGIN_ID}.assistant-sidebar-last-route`;

export function storeAssistantSidebarDockRequest(
  request: AssistantSidebarDockRequest,
  storage: StorageLike | undefined = browserSessionStorage(),
  now = Date.now()
) {
  if (!storage) {
    throw new Error('Browser sessionStorage is not available.');
  }

  const payload: StoredAssistantSidebarDockRequest = {
    schemaVersion: ASSISTANT_SIDEBAR_DOCK_SCHEMA_VERSION,
    createdAt: now,
    ...compactRequest(request),
  };
  storage.setItem(ASSISTANT_SIDEBAR_DOCK_REQUEST_KEY, JSON.stringify(payload));
}

export function consumeAssistantSidebarDockRequest(
  storage: StorageLike | undefined = browserSessionStorage(),
  now = Date.now()
): AssistantSidebarDockRequest | undefined {
  if (!storage) {
    return undefined;
  }

  const raw = storage.getItem(ASSISTANT_SIDEBAR_DOCK_REQUEST_KEY);
  storage.removeItem(ASSISTANT_SIDEBAR_DOCK_REQUEST_KEY);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as StoredAssistantSidebarDockRequest;
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== ASSISTANT_SIDEBAR_DOCK_SCHEMA_VERSION ||
      typeof parsed.createdAt !== 'number' ||
      now - parsed.createdAt > ASSISTANT_SIDEBAR_DOCK_REQUEST_MAX_AGE_MS
    ) {
      return undefined;
    }

    return compactRequest(parsed);
  } catch {
    return undefined;
  }
}

export function rememberAssistantDockRoute(
  route: string | undefined,
  storage: StorageLike | undefined = browserSessionStorage(),
  now = Date.now()
) {
  if (!storage) {
    return;
  }

  const normalized = normalizeRoute(route);
  if (!normalized) {
    return;
  }

  const payload: StoredAssistantDockRoute = {
    schemaVersion: ASSISTANT_SIDEBAR_DOCK_SCHEMA_VERSION,
    createdAt: now,
    route: normalized,
  };
  storage.setItem(ASSISTANT_SIDEBAR_LAST_ROUTE_KEY, JSON.stringify(payload));
}

export function getAssistantDockRoute(
  storage: StorageLike | undefined = browserSessionStorage(),
  now = Date.now()
): string | undefined {
  if (!storage) {
    return undefined;
  }

  const raw = storage.getItem(ASSISTANT_SIDEBAR_LAST_ROUTE_KEY);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as StoredAssistantDockRoute;
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== ASSISTANT_SIDEBAR_DOCK_SCHEMA_VERSION ||
      typeof parsed.createdAt !== 'number' ||
      now - parsed.createdAt > ASSISTANT_SIDEBAR_LAST_ROUTE_MAX_AGE_MS
    ) {
      storage.removeItem(ASSISTANT_SIDEBAR_LAST_ROUTE_KEY);
      return undefined;
    }

    const normalized = normalizeRoute(parsed.route);
    if (!normalized) {
      storage.removeItem(ASSISTANT_SIDEBAR_LAST_ROUTE_KEY);
    }
    return normalized;
  } catch {
    storage.removeItem(ASSISTANT_SIDEBAR_LAST_ROUTE_KEY);
    return undefined;
  }
}

export function routeFromLocation(location: { pathname?: string; search?: string; hash?: string }) {
  return normalizeRoute(`${location.pathname ?? '/'}${location.search ?? ''}${location.hash ?? ''}`);
}

function compactRequest(request: AssistantSidebarDockRequest): AssistantSidebarDockRequest {
  const action = isDashboardAssistantAction(request.action) ? request.action : undefined;
  return compactRecord({
    action,
    contextId: stringValue(request.contextId),
    path: stringValue(request.path),
    sessionId: stringValue(request.sessionId),
  });
}

function normalizeRoute(route: string | undefined) {
  const value = stringValue(route);
  if (!value || !value.startsWith('/') || value.startsWith('//') || isAuthRoute(value)) {
    return undefined;
  }

  return value;
}

// Grafana's sign-in pages are never a place to return to: after login the
// browser has already left them, and docking would land on the login form.
const AUTH_ROUTE_PREFIXES = ['/login', '/logout', '/signup', '/invite', '/verify', '/user/password'];

function isAuthRoute(route: string) {
  const pathname = route.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  return AUTH_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function compactRecord<T extends Record<string, unknown>>(record: T) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function isDashboardAssistantAction(value: unknown): value is DashboardAssistantAction {
  return value === 'explain' || value === 'troubleshoot' || value === 'improve';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function browserSessionStorage() {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : undefined;
  } catch {
    return undefined;
  }
}
