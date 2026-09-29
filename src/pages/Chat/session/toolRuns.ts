import type { AgentEvent, AgentToolResult } from '@earendil-works/pi-agent-core';

export type ToolRunView = {
  id: string;
  name: string;
  args: unknown;
  status: 'running' | 'completed' | 'failed';
  partialResult?: AgentToolResult<any>;
  result?: AgentToolResult<any>;
  isError?: boolean;
  /** When execution started; absent in runs restored from older snapshots. */
  startedAt?: number;
  updatedAt: number;
};

export type ToolRunState = Record<string, ToolRunView>;

/** Folds tool execution events into per-call progress; returns `state` unchanged for other events. */
export function reduceToolRuns(state: ToolRunState, event: AgentEvent): ToolRunState {
  if (event.type === 'tool_execution_start') {
    return {
      ...state,
      [event.toolCallId]: {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: 'running',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
    };
  }

  if (event.type === 'tool_execution_update') {
    const existing = state[event.toolCallId];
    return {
      ...state,
      [event.toolCallId]: {
        ...existing,
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: toolRunStatusFromPartialResult(event.partialResult),
        partialResult: event.partialResult,
        updatedAt: Date.now(),
      },
    };
  }

  if (event.type === 'tool_execution_end') {
    const existing = state[event.toolCallId];
    return {
      ...state,
      [event.toolCallId]: {
        ...existing,
        id: event.toolCallId,
        name: event.toolName,
        args: existing?.args,
        status: event.isError ? 'failed' : 'completed',
        result: event.result,
        isError: event.isError,
        updatedAt: Date.now(),
      },
    };
  }

  return state;
}

function toolRunStatusFromPartialResult(partialResult: { details?: unknown } | undefined): ToolRunView['status'] {
  const details = partialResult?.details;
  if (!details || typeof details !== 'object') {
    return 'running';
  }
  const status = (details as Record<string, unknown>).status;
  if (status === 'completed' || status === 'failed') {
    return status;
  }
  return 'running';
}
