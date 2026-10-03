import {
  dataFrameFromJSON,
  LoadingState,
  type DataFrameJSON,
  type DataQueryRequest,
  type DataQueryResponse,
} from '@grafana/data';
import { Observable } from 'rxjs';

/**
 * The part of `@grafana/runtime` the chat core uses, for the assistant host in
 * Node. The host bundle aliases `@grafana/runtime` to this module, so the
 * workspace broker, domain code, and chat log client run unchanged and call
 * Grafana's HTTP API with the host's service account token.
 */

export type FetchRequest = {
  url: string;
  method?: string;
  data?: unknown;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  showErrorAlert?: boolean;
  showSuccessAlert?: boolean;
};

export type FetchResponse<T = unknown> = {
  data: T;
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  config: FetchRequest;
};

export type FetchError<T = unknown> = {
  status: number;
  statusText: string;
  data: T;
  message: string;
  config: FetchRequest;
  traceId?: string;
};

type DatasourceSettings = {
  id: number;
  uid: string;
  name: string;
  type: string;
  isDefault: boolean;
  jsonData: Record<string, unknown>;
  meta: { metrics?: boolean };
};

type RuntimeOptions = { url: string; token: string; fetch?: typeof fetch };

let options: RuntimeOptions | undefined;
let datasources: DatasourceSettings[] = [];

export const config = {
  appSubUrl: '',
  namespace: 'default',
  bootData: { user: { orgId: 1, timezone: 'utc', login: '' } },
};

/** Connects the runtime to Grafana and loads what the browser gets at boot: the user and the datasources. */
export async function initGrafanaRuntime(runtime: RuntimeOptions) {
  options = { ...runtime, url: runtime.url.replace(/\/$/, '') };
  const user = await request<{ orgId: number; login: string }>({ url: '/api/user' });
  config.bootData.user.orgId = user.orgId;
  config.bootData.user.login = user.login;
  config.namespace = user.orgId === 1 ? 'default' : `org-${user.orgId}`;
  await refreshDatasources();
}

/** Datasources are listed synchronously, like the browser's preloaded list; the host refreshes them periodically. */
export async function refreshDatasources() {
  const list = await request<Array<Omit<DatasourceSettings, 'meta'>>>({ url: '/api/datasources' });
  datasources = list.map((ds) => ({
    ...ds,
    jsonData: ds.jsonData ?? {},
    meta: { metrics: METRIC_TYPES.has(ds.type) },
  }));
}

const METRIC_TYPES = new Set([
  'prometheus',
  'loki',
  'elasticsearch',
  'mssql',
  'grafana-testdata-datasource',
  'testdata',
]);

async function request<T>(req: FetchRequest, signal?: AbortSignal): Promise<T> {
  return (await send<T>(req, signal)).data;
}

async function send<T>(req: FetchRequest, signal?: AbortSignal): Promise<FetchResponse<T>> {
  if (!options) {
    throw new Error('Grafana runtime is not initialized');
  }
  const url = new URL(options.url + req.url);
  for (const [key, value] of Object.entries(req.params ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null) {
        url.searchParams.append(key, String(item));
      }
    }
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${options.token}`, ...req.headers };
  let body: string | undefined;
  if (req.data !== undefined) {
    body = typeof req.data === 'string' ? req.data : JSON.stringify(req.data);
    headers['Content-Type'] ??= 'application/json';
  }
  const response = await (options.fetch ?? fetch)(url, { method: req.method ?? 'GET', headers, body, signal });
  const text = await response.text();
  let data: unknown = text;
  if (text && (response.headers.get('content-type') ?? '').includes('json')) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data ? String((data as { message: unknown }).message) : text;
    const error: FetchError = {
      status: response.status,
      statusText: response.statusText,
      data,
      message: message || response.statusText,
      config: req,
    };
    throw error;
  }
  return {
    data: data as T,
    status: response.status,
    statusText: response.statusText,
    ok: true,
    url: req.url,
    config: req,
  };
}

export function isFetchError(error: unknown): error is FetchError {
  return Boolean(error && typeof error === 'object' && 'status' in error && 'data' in error && 'config' in error);
}

export function getBackendSrv() {
  return {
    fetch<T>(req: FetchRequest): Observable<FetchResponse<T>> {
      return new Observable((subscriber) => {
        const controller = new AbortController();
        send<T>(req, controller.signal).then(
          (response) => {
            subscriber.next(response);
            subscriber.complete();
          },
          (error) => subscriber.error(error)
        );
        return () => controller.abort();
      });
    },
    get<T>(url: string, params?: Record<string, unknown>) {
      return request<T>({ url, params });
    },
  };
}

type ListFilter = { type?: string; metrics?: boolean; all?: boolean };

export function getDataSourceSrv() {
  return {
    getList(filter: ListFilter = {}) {
      return datasources.filter(
        (ds) => (!filter.type || ds.type === filter.type) && (!filter.metrics || ds.meta.metrics)
      );
    },
    getInstanceSettings(ref: { uid?: string } | string | undefined) {
      const uid = typeof ref === 'string' ? ref : ref?.uid;
      return datasources.find((ds) => ds.uid === uid || ds.name === uid);
    },
    async get(ref: { uid?: string; type?: string } | string) {
      const uid = typeof ref === 'string' ? ref : ref.uid;
      const settings = datasources.find((ds) => ds.uid === uid || ds.name === uid);
      if (!settings) {
        throw new Error(`Datasource ${uid} was not found`);
      }
      return createDatasource(settings);
    },
  };
}

/** A datasource with resource calls and queries through Grafana's backend, as the browser's datasource plugins use. */
function createDatasource(settings: DatasourceSettings) {
  const ref = { uid: settings.uid, type: settings.type };
  return {
    ...settings,
    getRef: () => ref,
    getResource<T>(path: string, params?: Record<string, unknown>) {
      return request<T>({ url: `/api/datasources/uid/${encodeURIComponent(settings.uid)}/resources/${path}`, params });
    },
    async query(req: DataQueryRequest): Promise<DataQueryResponse> {
      try {
        const response = await request<{ results?: Record<string, { error?: string; frames?: DataFrameJSON[] }> }>({
          url: '/api/ds/query',
          method: 'POST',
          data: {
            from: String(req.range.from.valueOf()),
            to: String(req.range.to.valueOf()),
            queries: req.targets.map((target) => ({
              ...target,
              datasource: ref,
              intervalMs: req.intervalMs,
              maxDataPoints: req.maxDataPoints,
            })),
          },
        });
        const results = Object.values(response.results ?? {});
        const error = results.find((result) => result.error)?.error;
        if (error) {
          return { data: [], state: LoadingState.Error, error: { message: error } };
        }
        return {
          data: results.flatMap((result) => (result.frames ?? []).map((frame) => dataFrameFromJSON(frame))),
          state: LoadingState.Done,
        };
      } catch (error) {
        const message = isFetchError(error) ? error.message : error instanceof Error ? error.message : String(error);
        return { data: [], state: LoadingState.Error, error: { message } };
      }
    },
  };
}

/** Navigation has no browser to move; `grafana open` prints its link instead. */
export const locationService = {
  push(_path: string) {},
  getLocation: () => ({ pathname: '/', search: '', hash: '' }),
};
