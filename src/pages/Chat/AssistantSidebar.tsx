import React from 'react';
import { ChatApp } from './ChatSceneObject';
import type { DashboardAssistantAction } from './dashboardLaunch';
import type { AgentWorkspaceLaunchPayload } from './agentWorkspace/types';

export type AssistantSidebarProps = {
  action?: DashboardAssistantAction;
  agentWorkspaceLaunch?: AgentWorkspaceLaunchPayload;
  contextId?: string;
  path?: string;
  sessionId?: string;
  // The remaining props are forwarded by @grafana/assistant's
  // openAssistant()/<OpenAssistantButton> when this plugin runs as the
  // `grafana-assistant-app`-ID variant (see ASSISTANT_SIDEBAR_TITLE in
  // module.tsx). Third-party plugins never render this component directly -
  // Grafana core resolves the ExtensionSidebar target by pluginId +
  // componentTitle and spreads that package's `open-extension-sidebar` event
  // props onto whatever component is registered there, which is this one.
  initialPrompt?: string;
  initialContext?: unknown[];
  initialAutoSend?: boolean;
  origin?: string;
  initialMode?: string;
  chatId?: string;
  appendContext?: boolean;
};

export default function AssistantSidebar({
  action,
  agentWorkspaceLaunch,
  contextId,
  path,
  sessionId,
  initialPrompt,
  initialContext,
  initialAutoSend,
  origin,
  chatId,
  appendContext,
}: AssistantSidebarProps) {
  return (
    <ChatApp
      key={sidebarKey({ action, agentWorkspaceLaunch, contextId, sessionId, chatId, initialPrompt })}
      variant="sidebar"
      agentWorkspaceLaunch={agentWorkspaceLaunch}
      launchContextId={contextId}
      sidebarRoute={path}
      sessionId={sessionId}
      initialPrompt={initialPrompt}
      initialContext={initialContext}
      initialAutoSend={initialAutoSend}
      initialOrigin={origin}
      initialChatId={chatId}
      initialAppendContext={appendContext}
    />
  );
}

function sidebarKey({
  action,
  agentWorkspaceLaunch,
  contextId,
  sessionId,
  chatId,
  initialPrompt,
}: Pick<AssistantSidebarProps, 'action' | 'agentWorkspaceLaunch' | 'contextId' | 'sessionId' | 'chatId' | 'initialPrompt'>) {
  if (sessionId) {
    return sessionId;
  }
  if (agentWorkspaceLaunch) {
    return JSON.stringify({
      sourcePluginId: agentWorkspaceLaunch.sourcePluginId,
      workspaceKind: agentWorkspaceLaunch.workspaceKind,
      workspaceRef: agentWorkspaceLaunch.workspaceRef,
      contextId: agentWorkspaceLaunch.contextId,
    });
  }
  // Each distinct external launch (e.g. a different alert's "Investigate"
  // click) must remount ChatApp so its one-shot initial-load effect reruns -
  // otherwise a second click while the sidebar is already open just reopens
  // the existing chat instead of starting the new prompt.
  if (chatId || initialPrompt) {
    return JSON.stringify({ chatId, initialPrompt });
  }
  return contextId ?? action ?? 'sidebar';
}
