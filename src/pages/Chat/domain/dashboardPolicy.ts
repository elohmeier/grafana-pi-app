import { getAllowedPrometheusDatasourceUids } from './metrics';
import type { GrafanaToolConfig } from './types';

const BUILTIN_DASHBOARD_DATASOURCE_UIDS = new Set([
  '__expr__',
  '-- Mixed --',
  '-- Dashboard --',
  'mixed',
  'grafana',
  'dashboard',
  '-100',
]);

export function getUnavailableDashboardDatasourceUids(dashboard: unknown, toolConfig: GrafanaToolConfig): string[] {
  const allowedUids = new Set((getAllowedPrometheusDatasourceUids(toolConfig) ?? []).filter(Boolean));
  if (allowedUids.size === 0) {
    return [];
  }

  return [...collectDashboardDatasourceUids(dashboard)]
    .filter((uid) => !allowedUids.has(uid))
    .sort((left, right) => left.localeCompare(right));
}

function collectDashboardDatasourceUids(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectDashboardDatasourceUids(item, result));
    return result;
  }
  if (!value || typeof value !== 'object') {
    return result;
  }

  const record = value as Record<string, unknown>;
  if ('datasource' in record) {
    addDatasourceUid(record.datasource, result);
  }
  Object.values(record).forEach((item) => collectDashboardDatasourceUids(item, result));

  return result;
}

function addDatasourceUid(datasourceRef: unknown, result: Set<string>) {
  const uid =
    typeof datasourceRef === 'string'
      ? datasourceRef.trim()
      : datasourceRef && typeof datasourceRef === 'object' && !Array.isArray(datasourceRef)
        ? String((datasourceRef as Record<string, unknown>).uid ?? '').trim()
        : '';

  if (!uid || BUILTIN_DASHBOARD_DATASOURCE_UIDS.has(uid)) {
    return;
  }
  result.add(uid);
}
