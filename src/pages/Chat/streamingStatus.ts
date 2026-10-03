import type { LiveState } from '@earendil-works/pi-durable';

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

/** What the running answer is doing, from the conversation's live state. */
export function deriveRunStatus(live: LiveState, startedAt: number): ChatRunStatus {
  const status = (phase: ChatRunPhase, detail?: string): ChatRunStatus => ({
    phase,
    ...(detail ? { detail } : {}),
    startedAt,
  });
  if (live.compactions?.some((compaction) => compaction.blocking)) {
    return status('compacting');
  }
  const running = live.tools?.find((slot) => slot.status === 'running');
  if (running) {
    return status('running_tool', running.name);
  }
  const generation = live.generation;
  if (generation?.retry) {
    return status('waiting_model', `Retrying after an error: ${generation.retry.error}`);
  }
  const content = latestAssistantContentStatus(generation?.message?.content);
  if (content) {
    return status(content.phase, content.detail);
  }
  if (!generation && live.tools?.length) {
    return status('waiting_model', 'Processing tool result');
  }
  return status('waiting_model');
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

function formatToolName(name: string) {
  return name.replace(/_/g, ' ');
}
