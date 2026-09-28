import type { AgentToolResult } from '@earendil-works/pi-agent-core';

export type TextToolResult<TDetails = Record<string, unknown>> = AgentToolResult<TDetails>;

export function textResult<TDetails extends Record<string, unknown>>(
  text: string,
  details: TDetails
): TextToolResult<TDetails> {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

export function truncateText(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n... (truncated)` : text;
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error('Tool call aborted');
  }
}

export function compactParams(params?: Record<string, unknown>) {
  if (!params) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== ''));
}
