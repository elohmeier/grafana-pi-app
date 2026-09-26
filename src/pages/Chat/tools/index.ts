import type { AgentTool } from '@earendil-works/pi-agent-core';
import { filterAllowedPrometheusDatasourceSettings } from './metrics';
import type { CreateGrafanaToolsOptions } from './types';

export { artifactByteSize } from './artifacts';
export type { Artifact, ArtifactPreview, ArtifactRef, ArtifactRuntime } from './artifacts';
export { extractDashboardMetricUsage } from './dashboardMetricContext';
export { getUnavailableDashboardDatasourceUids } from './dashboardPolicy';
export { filterAllowedPrometheusDatasourceSettings };
export { buildNavigationPath } from './navigation';
export type { CreateGrafanaToolsOptions, GrafanaToolConfig, GrafanaToolRuntime, SkillToolGroup } from './types';

/**
 * The single assistant's fixed tool surface: read, write, edit, and bash over
 * the session filesystem. Discovery, queries, alerts, navigation, screenshots,
 * live dashboard edits, and resource changes are shell commands. The list
 * does not change between turns.
 */
export function createGrafanaTools(options: CreateGrafanaToolsOptions = {}): AgentTool[] {
  return dedupeTools([...(options.workspaceTools ?? [])]);
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
