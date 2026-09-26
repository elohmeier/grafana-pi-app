import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { DashboardMutationAPI } from '@grafana/data';
import type { GrafanaSkill } from '../skills/types';
import type { ArtifactRuntime } from '../tools/artifacts';
import type { WorkspaceApprovalService, WorkspaceBroker } from './broker';
import { createArtifactsMount, createCatalogMount, createJsonnetLibraryMount, createSkillsMount } from './mounts';
import { createPythonCommands, type PythonRunner } from './python/pythonCommand';
import { renderWorkspacePromptSection } from './prompt';
import { runWorkspaceBash, type WorkspaceBashResult, type WorkspaceShellDeps } from './shell';
import { createLiveDashboardBroker, createLiveDashboardMount } from './liveDashboard';
import { createWorkspaceTools } from './tools';
import type { GeneratedMount } from './types';
import type { SessionWorkspace } from './workspace';

export { SessionWorkspace } from './workspace';
export { formatBashResult, WORKSPACE_TOOL_NAMES } from './tools';
export type { WorkspaceBashResult } from './shell';
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
 * the four model-facing tools, the matching system prompt section, and a
 * runner for shell commands the user types directly (`!` in the composer).
 */
export function createSessionWorkspaceToolkit(options: SessionWorkspaceToolkitOptions): {
  tools: AgentTool[];
  promptSection: string;
  runShell: (command: string, signal?: AbortSignal) => Promise<WorkspaceBashResult>;
} {
  const { workspace } = options;
  const live = options.getDashboardMutationAPI ? createLiveDashboardBroker(options.getDashboardMutationAPI) : undefined;
  const broker: WorkspaceBroker = live ? { ...options.broker, live } : options.broker;
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
  if (broker.jsonnet) {
    mounts.push(createJsonnetLibraryMount(broker.jsonnet));
  }
  const liveDashboardMounted = Boolean(live?.available());
  if (live) {
    mounts.push(createLiveDashboardMount(live));
  }
  workspace.setGeneratedMounts(mounts);

  const deps: WorkspaceShellDeps = {
    workspace,
    broker,
    approvals: options.approvals,
    artifacts: options.artifacts,
    extraCommands: options.python ? createPythonCommands(options.python) : undefined,
  };
  return {
    tools: createWorkspaceTools(deps),
    promptSection: renderWorkspacePromptSection({ pythonAvailable: Boolean(options.python), liveDashboardMounted }),
    runShell: (command, signal) => runWorkspaceBash(deps, { command }, signal),
  };
}
