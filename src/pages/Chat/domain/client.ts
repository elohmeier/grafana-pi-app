import { getBackendSrv, isFetchError } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { PLUGIN_ID } from '../../../constants';
import { compactParams } from './result';

export async function backendFetch<T>(
  url: string,
  options: { method?: string; data?: unknown; params?: Record<string, unknown> } = {}
): Promise<T> {
  try {
    const response = await lastValueFrom(
      getBackendSrv().fetch<T>({
        url,
        method: options.method ?? 'GET',
        data: options.data,
        params: compactParams(options.params),
        showErrorAlert: false,
      })
    );
    return response.data;
  } catch (error) {
    throw new Error(formatBackendFetchError(error));
  }
}

export async function pluginResourceFetch<T>(
  path: string,
  options: { method?: string; data?: unknown; params?: Record<string, unknown> } = {}
): Promise<T> {
  return pluginResourceFetchForPlugin<T>(PLUGIN_ID, path, options);
}

export async function pluginResourceFetchForPlugin<T>(
  pluginId: string,
  path: string,
  options: { method?: string; data?: unknown; params?: Record<string, unknown> } = {}
): Promise<T> {
  return backendFetch<T>(`/api/plugins/${encodeURIComponent(pluginId)}/resources${path}`, options);
}

export function formatBackendFetchError(error: unknown): string {
  if (isFetchError(error)) {
    const method = error.config?.method ?? 'GET';
    const target = error.config?.url ? ` while calling ${method} ${error.config.url}` : '';
    const statusText = error.statusText ? ` ${error.statusText}` : '';
    const trace = error.traceId ? ` Trace ID: ${error.traceId}.` : '';
    const message = extractBackendErrorMessage(error.data) ?? error.message ?? 'request failed';

    return `Grafana request failed (${error.status}${statusText})${target}: ${message}${trace}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return stringifyUnknown(error);
}

function extractBackendErrorMessage(data: unknown): string | undefined {
  if (typeof data === 'string') {
    return data.trim() || undefined;
  }
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const record = data as Record<string, unknown>;
  for (const key of ['error', 'message', 'status']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (value && typeof value === 'object') {
      return stringifyUnknown(value);
    }
  }

  return stringifyUnknown(data);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
