import type { Agent } from '@earendil-works/pi-agent-core';
import type { DashboardAssistantLaunch } from './dashboardLaunch';
import type { AssistantSession } from './session/AssistantSession';
import type { ChatRunStatus } from './streamingStatus';
import type { ToolRunView } from './ToolRenderer';

export type ChatRunSnapshot = {
  id: string;
  title: string;
  agent: Agent;
  dashboardLaunch?: DashboardAssistantLaunch;
  session: AssistantSession;
  toolRuns: Record<string, ToolRunView>;
  runStatus?: ChatRunStatus;
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
