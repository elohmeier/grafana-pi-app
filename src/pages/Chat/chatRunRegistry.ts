import type { Agent, BeforeToolCallResult } from '@earendil-works/pi-agent-core';
import type { DashboardAssistantLaunch } from './dashboardLaunch';
import type { Artifact } from './grafanaTools';
import type { ChatRunStatus } from './streamingStatus';
import type { CompactionState } from './compaction';
import type { SessionWorkspace } from './workspace';
import type { ToolRunView } from './ToolRenderer';

export type ChatToolConfirmationHandler = (
  toolCallId: string,
  toolName: string,
  args: unknown,
  signal?: AbortSignal
) => Promise<BeforeToolCallResult | undefined>;

export type ChatRunSnapshot = {
  id: string;
  title: string;
  agent: Agent;
  dashboardLaunch?: DashboardAssistantLaunch;
  workspace?: SessionWorkspace;
  compaction?: { state?: CompactionState };
  artifacts: Record<string, Artifact>;
  artifactCounter: number;
  toolRuns: Record<string, ToolRunView>;
  runStatus?: ChatRunStatus;
  requestToolConfirmation?: ChatToolConfirmationHandler;
  updatedAt: number;
};

const liveRuns = new Map<string, ChatRunSnapshot>();

export function storeChatRun(snapshot: Omit<ChatRunSnapshot, 'updatedAt'>): ChatRunSnapshot {
  const stored = {
    ...snapshot,
    updatedAt: Date.now(),
  };
  liveRuns.set(snapshot.id, stored);
  return stored;
}

export function getChatRun(id: string | undefined): ChatRunSnapshot | undefined {
  return id ? liveRuns.get(id) : undefined;
}

export function removeChatRun(id: string | undefined) {
  if (!id) {
    return;
  }
  liveRuns.delete(id);
}

export function isStoredChatRunAgent(id: string | undefined, agent: Agent | undefined) {
  return Boolean(id && agent && liveRuns.get(id)?.agent === agent);
}

export function setChatRunConfirmationHandler(id: string | undefined, handler: ChatToolConfirmationHandler) {
  const run = getChatRun(id);
  if (run) {
    run.requestToolConfirmation = handler;
    run.updatedAt = Date.now();
  }
}
