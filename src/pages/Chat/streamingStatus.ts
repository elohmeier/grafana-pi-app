import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';

export type ChatRunPhase =
  | 'waiting_model'
  | 'compacting'
  | 'thinking'
  | 'generating'
  | 'preparing_tool'
  | 'running_tool';

export type ChatRunStatus = {
  phase: ChatRunPhase;
  detail?: string;
  startedAt: number;
};

export function createInitialRunStatus(now = Date.now()): ChatRunStatus {
  return {
    phase: 'waiting_model',
    startedAt: now,
  };
}

/** Moves a running status to `phase`, keeping its start time. */
export function withRunPhase(current: ChatRunStatus | undefined, phase: ChatRunPhase, now = Date.now()) {
  return nextRunStatus(current, phase, undefined, now);
}

export function reduceChatRunStatus(
  current: ChatRunStatus | undefined,
  event: AgentEvent,
  now = Date.now()
): ChatRunStatus | undefined {
  if (event.type === 'agent_end') {
    return undefined;
  }

  if (event.type === 'agent_start' || event.type === 'turn_start') {
    return nextRunStatus(current, 'waiting_model', undefined, now);
  }

  if (event.type === 'message_start' && event.message.role === 'assistant') {
    return nextRunStatus(current, 'waiting_model', undefined, now);
  }

  if (event.type === 'message_update' && event.message.role === 'assistant') {
    const eventType = stringField(event.assistantMessageEvent, 'type');
    if (eventType?.startsWith('thinking_')) {
      return nextRunStatus(current, 'thinking', undefined, now);
    }
    if (eventType?.startsWith('text_')) {
      return nextRunStatus(current, 'generating', undefined, now);
    }
    if (eventType?.startsWith('toolcall_')) {
      return nextRunStatus(current, 'preparing_tool', latestToolCallName(event.message.content), now);
    }

    const contentStatus = latestAssistantContentStatus(event.message.content);
    if (contentStatus) {
      return nextRunStatus(current, contentStatus.phase, contentStatus.detail, now);
    }
  }

  if (event.type === 'tool_execution_start') {
    return nextRunStatus(current, 'running_tool', event.toolName, now);
  }

  if (event.type === 'tool_execution_update') {
    if (isTerminalToolUpdate(event.partialResult)) {
      return nextRunStatus(current, 'waiting_model', 'Processing tool result', now);
    }
    return nextRunStatus(current, 'running_tool', event.toolName, now);
  }

  if (event.type === 'tool_execution_end') {
    return nextRunStatus(current, 'waiting_model', 'Processing tool result', now);
  }

  return current;
}

export function resolveChatRunStatusFromStreamingMessage(
  current: ChatRunStatus | undefined,
  message: AgentMessage | undefined,
  now = Date.now()
): ChatRunStatus | undefined {
  if (!message || typeof message !== 'object') {
    return current;
  }
  const record = message as unknown as Record<string, unknown>;
  if (record.role !== 'assistant') {
    return current;
  }

  const contentStatus = latestAssistantContentStatus(record.content);
  if (!contentStatus || (current && phaseRank(current.phase) > phaseRank(contentStatus.phase))) {
    return current;
  }

  return nextRunStatus(current, contentStatus.phase, contentStatus.detail, now);
}

export function runStatusBadgeText(status: ChatRunStatus | undefined, pendingApprovalToolName?: string) {
  if (pendingApprovalToolName) {
    return 'Approval';
  }
  switch (status?.phase) {
    case 'waiting_model':
      return 'Waiting';
    case 'compacting':
      return 'Compacting';
    case 'thinking':
      return 'Thinking';
    case 'generating':
      return 'Generating';
    case 'preparing_tool':
      return 'Tool call';
    case 'running_tool':
      return 'Running tool';
    default:
      return 'Streaming';
  }
}

export function runStatusText(status: ChatRunStatus | undefined, pendingApprovalToolName?: string) {
  if (pendingApprovalToolName) {
    return `Waiting for approval: ${formatToolName(pendingApprovalToolName)}`;
  }
  switch (status?.phase) {
    case 'waiting_model':
      return status.detail || 'Waiting for model';
    case 'compacting':
      return 'Summarizing earlier conversation to fit the context window';
    case 'thinking':
      return 'Thinking';
    case 'generating':
      return 'Generating answer';
    case 'preparing_tool':
      return status.detail ? `Preparing ${formatToolName(status.detail)}` : 'Preparing tool call';
    case 'running_tool':
      return status.detail ? `Running ${formatToolName(status.detail)}` : 'Running tool';
    default:
      return 'Working';
  }
}

export function formatRunElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function nextRunStatus(
  current: ChatRunStatus | undefined,
  phase: ChatRunPhase,
  detail: string | undefined,
  now: number
): ChatRunStatus {
  if (current?.phase === phase && current.detail === detail) {
    return current;
  }
  return {
    phase,
    detail,
    startedAt: current?.startedAt ?? now,
  };
}

function phaseRank(phase: ChatRunPhase) {
  switch (phase) {
    case 'waiting_model':
    case 'compacting':
      return 0;
    case 'thinking':
      return 1;
    case 'generating':
      return 2;
    case 'preparing_tool':
      return 3;
    case 'running_tool':
      return 4;
  }
}

function latestAssistantContentStatus(content: unknown): Pick<ChatRunStatus, 'phase' | 'detail'> | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!block || typeof block !== 'object') {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === 'toolCall' && typeof record.name === 'string' && record.name.trim()) {
      return { phase: 'preparing_tool', detail: record.name };
    }
    if (record.type === 'text' && typeof record.text === 'string' && record.text.trim()) {
      return { phase: 'generating', detail: undefined };
    }
    if (record.type === 'thinking' && typeof record.thinking === 'string' && record.thinking.trim()) {
      return { phase: 'thinking', detail: undefined };
    }
  }
  return undefined;
}

function latestToolCallName(content: unknown) {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!block || typeof block !== 'object') {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === 'toolCall' && typeof record.name === 'string' && record.name.trim()) {
      return record.name;
    }
  }
  return undefined;
}

function formatToolName(name: string) {
  return name.replace(/_/g, ' ');
}

function isTerminalToolUpdate(partialResult: { details?: unknown } | undefined) {
  const details = partialResult?.details;
  if (!details || typeof details !== 'object') {
    return false;
  }
  const status = (details as Record<string, unknown>).status;
  return status === 'completed' || status === 'failed';
}

function stringField(value: unknown, field: string) {
  return value && typeof value === 'object' && typeof (value as Record<string, unknown>)[field] === 'string'
    ? ((value as Record<string, string>)[field] as string)
    : undefined;
}
