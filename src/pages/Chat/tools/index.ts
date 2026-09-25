import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createAlertTools } from './alerts';
import { createArtifactTools } from './artifacts';
import { createDashboardContextTools } from './dashboardContext';
import { createDashboardMetricContextTools } from './dashboardMetricContext';
import { createLiveDashboardMutationTools } from './dashboardMutation';
import { createDashboardScreenshotTools } from './dashboards';
import { createInvestigationTools } from './investigation';
import { filterAllowedPrometheusDatasourceSettings } from './metrics';
import { createNavigationTools } from './navigation';
import type { CreateGrafanaToolsOptions } from './types';

export { artifactByteSize, artifactizeToolResult, createArtifactTools, readArtifact } from './artifacts';
export type { Artifact, ArtifactPreview, ArtifactRef, ArtifactRuntime } from './artifacts';
export { createAlertTools } from './alerts';
export { createDashboardMetricContextTools, extractDashboardMetricUsage } from './dashboardMetricContext';
export { getUnavailableDashboardDatasourceUids } from './dashboardPolicy';
export { createLiveDashboardMutationTools, LIVE_DASHBOARD_WRITE_TOOLS } from './dashboardMutation';
export { filterAllowedPrometheusDatasourceSettings };
export { buildNavigationPath } from './navigation';
export type {
  CreateGrafanaToolsOptions,
  GrafanaToolConfig,
  GrafanaToolRuntime,
  InvestigationReport,
  InvestigationReportRuntime,
  SkillToolGroup,
} from './types';

/**
 * The single assistant's fixed tool surface. The session filesystem tools
 * (read/write/edit/bash, including the grafana, grafana-prom,
 * grafana-dashboard, jsonnet, and workspace commands) cover discovery,
 * querying, and resource changes. The remaining typed tools cover
 * capabilities the shell does not provide yet. The list does not change
 * between turns.
 */
export function createGrafanaTools(options: CreateGrafanaToolsOptions = {}): AgentTool[] {
  return dedupeTools([
    ...(options.workspaceTools ?? []),
    ...createDashboardContextTools(options),
    ...createDashboardMetricContextTools(options),
    ...createAlertTools(options),
    ...createLiveDashboardMutationTools(options.dashboardMutation),
    ...createInvestigationTools(options.investigationReport),
    ...createNavigationTools(),
    ...createDashboardScreenshotTools(),
    ...createArtifactTools(options.artifacts),
  ]);
}

function dedupeTools(tools: readonly AgentTool[]) {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (seen.has(tool.name)) {
      return false;
    }
    seen.add(tool.name);
    return true;
  });
}
