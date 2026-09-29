import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';

/**
 * Browser instrumentation for the agent benchmarks: serialized agent events are
 * pushed to a window hook and logged with a console prefix the Playwright runner reads.
 * Recording never affects chat behavior.
 */

export type BenchmarkAgentEvent = {
  type: AgentEvent['type'] | 'context_compaction';
  timestamp: number;
  [key: string]: unknown;
};

const BENCHMARK_EVENT_CONSOLE_PREFIX = '__PI_AGENT_BENCHMARK_EVENT__ ';

declare global {
  interface Window {
    __PI_AGENT_BENCHMARK_CAPTURE__?: boolean;
    __PI_AGENT_BENCHMARK_EVENTS__?: BenchmarkAgentEvent[];
    __PI_AGENT_BENCHMARK_RECORD_EVENT__?: (event: BenchmarkAgentEvent) => void;
  }
}

export function emitBenchmarkEvent(event: AgentEvent) {
  if (typeof window === 'undefined') {
    return;
  }

  recordSerializedBenchmarkEvent(serializeBenchmarkEvent(event));
}

export function recordSerializedBenchmarkEvent(serialized: BenchmarkAgentEvent) {
  if (typeof window === 'undefined') {
    return;
  }

  let recorded = false;

  try {
    if (typeof window.__PI_AGENT_BENCHMARK_RECORD_EVENT__ === 'function') {
      window.__PI_AGENT_BENCHMARK_RECORD_EVENT__(serialized);
      recorded = true;
    }
  } catch {
    // Benchmark instrumentation must not affect chat behavior.
  }

  try {
    if (!recorded && Array.isArray(window.__PI_AGENT_BENCHMARK_EVENTS__)) {
      window.__PI_AGENT_BENCHMARK_EVENTS__.push(serialized);
    } else if (!recorded && isBenchmarkCaptureEnabled()) {
      window.__PI_AGENT_BENCHMARK_EVENTS__ = [...(window.__PI_AGENT_BENCHMARK_EVENTS__ ?? []), serialized];
    }

    if (isBenchmarkCaptureEnabled()) {
      console.info(`${BENCHMARK_EVENT_CONSOLE_PREFIX}${JSON.stringify(serialized)}`);
    }
  } catch {
    // Benchmark instrumentation must not affect chat behavior.
  }
}

export function emitBenchmarkTranscriptSnapshot(messages: AgentMessage[]) {
  if (typeof window === 'undefined' || !isBenchmarkCaptureEnabled()) {
    return;
  }

  if ((window.__PI_AGENT_BENCHMARK_EVENTS__?.length ?? 0) > 0) {
    return;
  }

  const timestamp = Date.now();
  const toolCalls = benchmarkToolCallsFromTranscript(messages);
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    if (record?.role !== 'toolResult') {
      continue;
    }
    const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : undefined;
    const toolCall = toolCallId ? toolCalls.get(toolCallId) : undefined;
    const toolName = typeof record.toolName === 'string' ? record.toolName : toolCall?.name;
    if (!toolCallId || !toolName) {
      continue;
    }
    recordSerializedBenchmarkEvent({
      type: 'tool_execution_end',
      timestamp,
      toolCallId,
      toolName,
      args: sanitizeBenchmarkValue(toolCall?.args),
      result: sanitizeBenchmarkValue({
        content: record.content,
        details: record.details,
        isError: record.isError,
      }),
      isError: record.isError === true,
    });
  }

  const finalAssistantMessage = [...messages]
    .reverse()
    .find((message) => (message as unknown as Record<string, unknown>)?.role === 'assistant');
  if (finalAssistantMessage) {
    recordSerializedBenchmarkEvent({
      type: 'message_end',
      timestamp,
      message: summarizeBenchmarkMessage(finalAssistantMessage),
    });
  }
  recordSerializedBenchmarkEvent({
    type: 'agent_end',
    timestamp,
    messageCount: messages.length,
    message: finalAssistantMessage ? summarizeBenchmarkMessage(finalAssistantMessage) : undefined,
  });
}

function benchmarkToolCallsFromTranscript(messages: AgentMessage[]) {
  const toolCalls = new Map<string, { name: string; args: unknown }>();
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    if (record?.role !== 'assistant' || !Array.isArray(record.content)) {
      continue;
    }
    for (const block of record.content) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      const content = block as Record<string, unknown>;
      if (content.type !== 'toolCall' || typeof content.id !== 'string' || typeof content.name !== 'string') {
        continue;
      }
      toolCalls.set(content.id, { name: content.name, args: content.arguments });
    }
  }
  return toolCalls;
}

function isBenchmarkCaptureEnabled() {
  if (window.__PI_AGENT_BENCHMARK_CAPTURE__ === true) {
    return true;
  }

  try {
    return new URLSearchParams(window.location.search).get('piAgentBenchmark') === '1';
  } catch {
    return false;
  }
}

function serializeBenchmarkEvent(event: AgentEvent): BenchmarkAgentEvent {
  const timestamp = Date.now();

  if (event.type === 'agent_end') {
    const finalAssistantMessage = [...event.messages]
      .reverse()
      .find((message) => (message as unknown as Record<string, unknown>)?.role === 'assistant');
    return {
      type: event.type,
      timestamp,
      messageCount: event.messages.length,
      message: finalAssistantMessage ? summarizeBenchmarkMessage(finalAssistantMessage) : undefined,
    };
  }

  if (event.type === 'message_update') {
    return {
      type: event.type,
      timestamp,
      message: summarizeBenchmarkMessage(event.message),
      assistantMessageEvent: sanitizeBenchmarkValue(event.assistantMessageEvent),
    };
  }

  if (event.type === 'message_start' || event.type === 'message_end') {
    return {
      type: event.type,
      timestamp,
      message: summarizeBenchmarkMessage(event.message),
    };
  }

  if (event.type === 'turn_end') {
    return {
      type: event.type,
      timestamp,
      message: summarizeBenchmarkMessage(event.message),
      toolResultCount: event.toolResults.length,
    };
  }

  if (event.type === 'tool_execution_start') {
    return {
      type: event.type,
      timestamp,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: sanitizeBenchmarkValue(event.args),
    };
  }

  if (event.type === 'tool_execution_update') {
    return {
      type: event.type,
      timestamp,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: sanitizeBenchmarkValue(event.args),
      partialResult: sanitizeBenchmarkValue(event.partialResult),
    };
  }

  if (event.type === 'tool_execution_end') {
    return {
      type: event.type,
      timestamp,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: sanitizeBenchmarkValue(event.result),
      isError: event.isError,
    };
  }

  return { type: event.type, timestamp };
}

function summarizeBenchmarkMessage(message: AgentMessage) {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const record = message as unknown as Record<string, unknown>;
  return {
    role: record.role,
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
    content: summarizeBenchmarkContent(record.content),
    usage: summarizeBenchmarkUsage(record.usage),
  };
}

function summarizeBenchmarkUsage(usage: unknown) {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  return {
    input: numberBenchmarkField(record.input),
    output: numberBenchmarkField(record.output),
    cacheRead: numberBenchmarkField(record.cacheRead),
    cacheWrite: numberBenchmarkField(record.cacheWrite),
    totalTokens: numberBenchmarkField(record.totalTokens),
    cost: record.cost,
  };
}

function numberBenchmarkField(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sanitizeBenchmarkValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return truncateBenchmarkText(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return Number.isFinite(value as number) || typeof value === 'boolean' ? value : String(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  if (depth >= 8) {
    return '[MaxDepth]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeBenchmarkValue(item, seen, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    output[key] = sanitizeBenchmarkValue(entry, seen, depth + 1);
  }
  return output;
}

function summarizeBenchmarkContent(content: unknown) {
  if (typeof content === 'string') {
    return truncateBenchmarkText(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  return content.map((block) => {
    if (!block || typeof block !== 'object') {
      return block;
    }

    const record = block as Record<string, unknown>;
    if (record.type === 'text') {
      return { type: record.type, text: truncateBenchmarkText(record.text) };
    }
    if (record.type === 'toolCall') {
      return {
        type: record.type,
        id: record.id,
        name: record.name,
        arguments: sanitizeBenchmarkValue(record.arguments),
      };
    }

    return { type: record.type };
  });
}

function truncateBenchmarkText(value: unknown) {
  if (typeof value !== 'string') {
    return value;
  }
  return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
}
