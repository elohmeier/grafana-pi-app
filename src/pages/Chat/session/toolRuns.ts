import type { ToolResult } from '../domain/result';

/** Progress of one tool call of the running answer. */
export type ToolRunView = {
  id: string;
  name: string;
  args: unknown;
  status: 'running' | 'completed' | 'failed';
  /** What the tool reported while running; `details.running` names the host command a bash call runs. */
  partialResult?: ToolResult<any>;
  result?: ToolResult<any>;
  isError?: boolean;
  /** When execution started, as first seen by this view. */
  startedAt?: number;
  updatedAt: number;
};

export type ToolRunState = Record<string, ToolRunView>;
