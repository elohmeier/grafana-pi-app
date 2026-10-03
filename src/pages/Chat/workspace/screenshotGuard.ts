import type { DatasourceRef } from './broker';
import {
  collectPanels,
  collectVariables,
  datasourceType,
  datasourceUid,
  isObject,
  prepareTargets,
  unwrapDashboard,
  type JsonObject,
  type WalkedPanel,
} from './dashboardPanels';

/**
 * A screenshot shows panel data as pixels, so it must only render panels whose
 * queries use datasources the assistant may read completely: the allowed
 * Prometheus datasources, server-side expressions, test data, and Grafana's
 * built-in datasources. Panels of other datasources (Elasticsearch logs, SQL,
 * Loki, ...) would show content that `grafana-logs` keeps from the assistant.
 * Annotation text is shown only on hover, so annotations are not checked.
 */
export type ScreenshotCheck = {
  /** Panels that cannot be rendered, with the reason. */
  refused: Array<{ id: string; title: string; reason: string }>;
  /** Panels with only allowed datasources. */
  allowed: string[];
};

const TESTDATA_TYPES = new Set(['grafana-testdata-datasource', 'testdata']);
const GRAFANA_BUILTIN_UIDS = new Set(['grafana', '-- Grafana --', '-- Mixed --']);
const DASHBOARD_DATASOURCE_UID = '-- Dashboard --';

export function checkScreenshot(
  resource: unknown,
  options: { panelId?: number; datasources: DatasourceRef[]; allowedPrometheusUids: string[] }
): ScreenshotCheck {
  const [shape, dashboard] = unwrapDashboard(resource);
  const variables = collectVariables(shape, dashboard);
  // Collapsed rows are not rendered in a dashboard screenshot.
  const panels = collectPanels(shape, dashboard, {
    includeHiddenTargets: true,
    includeCollapsed: options.panelId !== undefined,
  });
  const allowedPrometheus = new Set(options.allowedPrometheusUids);
  const byId = new Map(panels.map((panel) => [panel.id, panel]));

  const panelRefusal = (panel: WalkedPanel, seen: Set<string>): string | undefined => {
    if (panel.libraryPanel) {
      return `library panel ${panel.libraryPanel}: its queries cannot be checked`;
    }
    seen.add(panel.id);
    for (const target of prepareTargets(panel, variables)) {
      const reason = targetRefusal(target, seen);
      if (reason) {
        return reason;
      }
    }
    return undefined;
  };

  const targetRefusal = (target: JsonObject, seen: Set<string>): string | undefined => {
    const uid = datasourceUid(target);
    const type = datasourceType(target);
    if (uid === '__expr__' || type === '__expr__') {
      return undefined;
    }
    if (uid.includes('$')) {
      return `datasource ${uid} is a variable without a resolvable value`;
    }
    if (uid === DASHBOARD_DATASOURCE_UID) {
      const source = byId.get(String(isObject(target) ? (target.panelId ?? '') : ''));
      if (!source || seen.has(source.id)) {
        return 'reuses the results of a panel that cannot be checked';
      }
      return panelRefusal(source, seen);
    }
    if (GRAFANA_BUILTIN_UIDS.has(uid)) {
      return undefined;
    }
    const ds = resolveDatasource(uid, options.datasources);
    if (!ds) {
      return `datasource ${JSON.stringify(uid || '(default)')} is unknown`;
    }
    if (TESTDATA_TYPES.has(ds.type) || (ds.type === 'prometheus' && allowedPrometheus.has(ds.uid))) {
      return undefined;
    }
    return `uses ${ds.type} datasource ${ds.name} (${ds.uid}), which is not available to the assistant`;
  };

  const selected =
    options.panelId !== undefined ? panels.filter((panel) => panel.id === String(options.panelId)) : panels;
  const check: ScreenshotCheck = { refused: [], allowed: [] };
  for (const panel of selected) {
    const reason = panelRefusal(panel, new Set());
    if (reason) {
      check.refused.push({ id: panel.id, title: panel.title, reason });
    } else {
      check.allowed.push(panel.id);
    }
  }
  return check;
}

function resolveDatasource(ref: string, datasources: DatasourceRef[]) {
  if (!ref || ref === 'default') {
    return datasources.find((ds) => ds.isDefault);
  }
  return datasources.find((ds) => ds.uid === ref || ds.name === ref);
}
