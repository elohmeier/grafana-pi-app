import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { DashboardMutationAPI } from '@grafana/data';
import type { GrafanaSkill } from '../skills/types';
import type { ArtifactRuntime } from '../tools/artifacts';
import type { WorkspaceApprovalService, WorkspaceBroker } from './broker';
import { createArtifactsMount, createCatalogMount, createLiveDashboardMount, createSkillsMount } from './mounts';
import { createPythonCommands, type PythonRunner } from './python/pythonCommand';
import { renderWorkspacePromptSection } from './prompt';
import { createWorkspaceTools } from './tools';
import type { GeneratedMount } from './types';
import type { SessionWorkspace } from './workspace';

export { SessionWorkspace } from './workspace';
export { WORKSPACE_TOOL_NAMES } from './tools';
export type { PersistedWorkspace } from './types';
export type { WorkspaceApprovalRequest, WorkspaceApprovalService, WorkspaceBroker } from './broker';

export type SessionWorkspaceToolkitOptions = {
  workspace: SessionWorkspace;
  broker: WorkspaceBroker;
  approvals?: WorkspaceApprovalService;
  artifacts?: ArtifactRuntime;
  skills?: readonly GrafanaSkill[];
  python?: PythonRunner;
  getDashboardMutationAPI?: () => DashboardMutationAPI | undefined;
};

/**
 * Binds a session workspace to the current Grafana capabilities and returns
 * the four model-facing tools plus the matching system prompt section.
 */
export function createSessionWorkspaceToolkit(options: SessionWorkspaceToolkitOptions): {
  tools: AgentTool[];
  promptSection: string;
} {
  const { workspace, broker } = options;
  const mounts: GeneratedMount[] = [];
  if (options.skills) {
    mounts.push(createSkillsMount(options.skills));
  }
  if (options.artifacts) {
    mounts.push(createArtifactsMount(options.artifacts));
  }
  if (broker.dashboards) {
    mounts.push(createCatalogMount(broker.dashboards));
    const dashboards = broker.dashboards;
    workspace.setHydrator((_kind, uid, signal) => dashboards.get(uid, signal));
  }
  const liveDashboardMounted = Boolean(options.getDashboardMutationAPI?.());
  if (options.getDashboardMutationAPI) {
    mounts.push(createLiveDashboardMount(options.getDashboardMutationAPI));
  }
  workspace.setGeneratedMounts(mounts);

  return {
    tools: createWorkspaceTools({
      workspace,
      broker,
      approvals: options.approvals,
      artifacts: options.artifacts,
      extraCommands: options.python ? createPythonCommands(options.python) : undefined,
    }),
    promptSection: renderWorkspacePromptSection({ pythonAvailable: Boolean(options.python), liveDashboardMounted }),
  };
}
