import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { DashboardMutationAPI } from '@grafana/data';
import type { GrafanaSkill } from '../skills/types';
import type { ArtifactRuntime } from '../domain/artifacts';
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
  catalogMount?: GeneratedMount;
  context?: Record<string, unknown>;
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
  mounts.push({
    root: '/session/context.json',
    description: 'Read-only context captured for this turn.',
    files: () => ({ '/session/context.json': { content: JSON.stringify(options.context ?? {}, null, 2) + '\n' } }),
  });
  mounts.push({
    root: '/session/receipts',
    description: 'Read-only apply outcome journal.',
    files: () =>
      Object.fromEntries([
        [
          '/session/receipts/index.ndjson',
          {
            content:
              workspace
                .applyJournal()
                .map(({ diff: _diff, ...receipt }) => JSON.stringify(receipt))
                .join('\n') + '\n',
          },
        ],
        ...workspace
          .applyJournal()
          .filter((receipt) => receipt.applyId)
          .flatMap((receipt) => [
            [`/session/receipts/${receipt.applyId}.json`, { content: JSON.stringify(receipt, null, 2) + '\n' }],
            [`/session/receipts/${receipt.applyId}.diff`, { content: receipt.diff ?? '' }],
          ]),
      ]),
  });
  if (options.skills) {
    mounts.push(createSkillsMount(options.skills));
  }
  if (options.artifacts) {
    mounts.push(createArtifactsMount(options.artifacts));
  }
  if (broker.dashboards) {
    mounts.push(options.catalogMount ?? createCatalogMount(broker.dashboards));
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
