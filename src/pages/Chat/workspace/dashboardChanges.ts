import { collectPanels, collectVariables, unwrapDashboard, type WalkedPanel } from './dashboardPanels';

/**
 * What a new version of a dashboard drops from the old one: panels (matched by
 * key, then by title), queries of kept panels (by refId), transformations of
 * kept panels (by count), and variables. Edits and additions are not reported.
 * Rewrites that replace a whole dashboard or array are the usual way edits lose
 * user work silently, so apply paths surface these lines before writing.
 */
export function describeDashboardRemovals(before: unknown, after: unknown): string[] {
  const old = readDashboard(before);
  const next = readDashboard(after);
  if (!old || !next) {
    return [];
  }
  const removals: string[] = [];
  const byKey = new Map(next.panels.map((panel) => [panel.key, panel]));
  const byTitle = new Map(next.panels.map((panel) => [panel.title, panel]));
  const removedPanels: string[] = [];
  const panelChanges: string[] = [];
  for (const panel of old.panels) {
    const match = byKey.get(panel.key) ?? byTitle.get(panel.title);
    if (!match) {
      removedPanels.push(JSON.stringify(panel.title));
      continue;
    }
    const label = `panel ${JSON.stringify(panel.title)} (${panel.key})`;
    const refIds = new Set(match.targets.map((target) => String(target.refId)));
    const lostQueries = panel.targets.map((target) => String(target.refId)).filter((refId) => !refIds.has(refId));
    if (lostQueries.length > 0) {
      panelChanges.push(`${label} loses ${lostQueries.length === 1 ? 'query' : 'queries'} ${lostQueries.join(', ')}`);
    }
    const lostTransformations = panel.transformations.length - match.transformations.length;
    if (lostTransformations > 0) {
      panelChanges.push(`${label} loses ${lostTransformations} of ${panel.transformations.length} transformations`);
    }
  }
  if (removedPanels.length > 0) {
    removals.push(`removes ${removedPanels.length} of ${old.panels.length} panels: ${removedPanels.join(', ')}`);
  }
  removals.push(...panelChanges);
  const lostVariables = Object.keys(old.variables).filter((name) => !(name in next.variables));
  if (lostVariables.length > 0) {
    removals.push(`removes ${lostVariables.length === 1 ? 'variable' : 'variables'} ${lostVariables.join(', ')}`);
  }
  return removals;
}

function readDashboard(document: unknown): { panels: WalkedPanel[]; variables: Record<string, unknown> } | undefined {
  try {
    const [shape, dashboard] = unwrapDashboard(typeof document === 'string' ? JSON.parse(document) : document);
    return {
      panels: collectPanels(shape, dashboard, { includeCollapsed: true, includeHiddenTargets: true }),
      variables: collectVariables(shape, dashboard),
    };
  } catch {
    return undefined;
  }
}
