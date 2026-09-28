import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { GrafanaSkill } from './skills';
import { pluginResourceFetch } from './domain/client';

const TELEMETRY_BATCH_SIZE = 50;
const TELEMETRY_FLUSH_MS = 1000;
const CUSTOM_SKILL_FILE_PREFIX = 'plugin-config/customSkills/';

export type AssistantTelemetryEvent = {
  type: string;
  toolName?: string;
  status?: string;
  reason?: string;
  messageRole?: string;
  stopReason?: string;
  durationMs?: number;
  resultBytes?: number;
  argsBytes?: number;
  contentBytes?: number;
  promptBytes?: number;
  contextBytes?: number;
  contextMessageCount?: number;
  toolCount?: number;
  messageCount?: number;
  toolResultCount?: number;
  phase?: string;
  skills?: AssistantTelemetrySkill[];
  usage?: AssistantTelemetryUsage;
};

export type AssistantTelemetrySkill = {
  id: string;
  name: string;
  source: 'bundled' | 'custom';
  activation: 'explicit' | 'auto';
};

export type AssistantTelemetryUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
};

export type PromptTelemetryContext = {
  prompt: string;
  systemPrompt: string;
  messages: readonly AgentMessage[];
  toolCount: number;
  activeSkills: readonly GrafanaSkill[];
  explicitSkillNames: readonly string[];
};

type ToolStart = {
  toolName: string;
  startedAt: number;
  argsBytes: number;
};

type TelemetrySender = (events: AssistantTelemetryEvent[]) => Promise<void>;

export function createAssistantTelemetryReporter(send: TelemetrySender = sendAssistantTelemetryEvents) {
  let queue: AssistantTelemetryEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let promptStartedAt: number | undefined;
  let agentStartedAt: number | undefined;
  let firstAssistantMessageRecorded = false;
  let firstAssistantThinkingRecorded = false;
  let firstAssistantContentRecorded = false;
  let firstToolCallRecorded = false;
  let firstToolResultRecorded = false;
  let agentEndRecorded = false;
  let runCompleteRecorded = false;
  const completedToolCallIds = new Set<string>();
  const toolStarts = new Map<string, ToolStart>();

  const enqueue = (event: AssistantTelemetryEvent) => {
    queue.push(event);
    if (queue.length >= TELEMETRY_BATCH_SIZE) {
      void flush();
      return;
    }
    scheduleFlush();
  };

  const recordWait = (phase: string, timestamp: number) => {
    if (promptStartedAt === undefined || timestamp < promptStartedAt) {
      return;
    }
    enqueue({
      type: 'qol_timing',
      phase,
      durationMs: timestamp - promptStartedAt,
    });
  };

  const resetRun = (timestamp: number) => {
    promptStartedAt = timestamp;
    agentStartedAt = undefined;
    firstAssistantMessageRecorded = false;
    firstAssistantThinkingRecorded = false;
    firstAssistantContentRecorded = false;
    firstToolCallRecorded = false;
    firstToolResultRecorded = false;
    agentEndRecorded = false;
    runCompleteRecorded = false;
    completedToolCallIds.clear();
    toolStarts.clear();
  };

  const recordRunComplete = (timestamp: number) => {
    if (runCompleteRecorded) {
      return;
    }
    runCompleteRecorded = true;
    recordWait('run_complete', timestamp);
  };

  const flush = async () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (queue.length === 0) {
      return;
    }
    const events = queue;
    queue = [];
    try {
      await send(events);
    } catch {
      // Telemetry must never affect assistant behavior.
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      void flush();
    }, TELEMETRY_FLUSH_MS);
  };

  return {
    recordPromptStart(context: PromptTelemetryContext) {
      const timestamp = Date.now();
      resetRun(timestamp);
      const explicitSkillNames = new Set(context.explicitSkillNames);
      enqueue({
        type: 'prompt_start',
        promptBytes: textBytes(context.prompt),
        contextBytes: jsonBytes({
          systemPrompt: context.systemPrompt,
          messages: context.messages,
        }),
        contextMessageCount: context.messages.length,
        toolCount: context.toolCount,
        skills: context.activeSkills.map((skill) => ({
          id: skill.filePath || skill.name,
          name: skill.name,
          source: skill.filePath?.startsWith(CUSTOM_SKILL_FILE_PREFIX) ? 'custom' : 'bundled',
          activation: explicitSkillNames.has(skill.name) ? 'explicit' : 'auto',
        })),
      });
    },

    recordAgentEvent(event: AgentEvent) {
      const timestamp = Date.now();

      if (event.type === 'agent_start') {
        agentStartedAt = timestamp;
        return;
      }

      if (event.type === 'message_start') {
        const message = messageRecord(event.message);
        if (message?.role === 'assistant' && !firstAssistantMessageRecorded) {
          firstAssistantMessageRecorded = true;
          recordWait('first_assistant_message', timestamp);
        }
        return;
      }

      if (event.type === 'message_update') {
        const message = messageRecord(event.message);
        if (message?.role === 'assistant') {
          if (!firstAssistantThinkingRecorded && hasAssistantThinkingContent(message)) {
            firstAssistantThinkingRecorded = true;
            recordWait('first_assistant_thinking', timestamp);
          }
          if (!firstAssistantContentRecorded && hasVisibleAssistantContent(message)) {
            firstAssistantContentRecorded = true;
            recordWait('first_assistant_content', timestamp);
            recordWait('first_visible_assistant_content', timestamp);
          }
        }
        return;
      }

      if (event.type === 'message_end') {
        const message = messageRecord(event.message);
        enqueue({
          type: 'message_end',
          messageRole: stringField(message, 'role'),
          stopReason: stringField(message, 'stopReason') ?? 'unknown',
          contentBytes: jsonBytes(message?.content),
          usage: usageFromMessage(message),
        });
        return;
      }

      if (event.type === 'turn_end') {
        enqueue({
          type: 'turn_end',
          toolResultCount: event.toolResults.length,
        });
        return;
      }

      if (event.type === 'tool_execution_start') {
        const argsBytes = jsonBytes(event.args);
        toolStarts.set(event.toolCallId, {
          toolName: event.toolName,
          startedAt: timestamp,
          argsBytes,
        });
        if (!firstToolCallRecorded) {
          firstToolCallRecorded = true;
          recordWait('first_tool_call', timestamp);
        }
        enqueue({
          type: 'tool_execution_start',
          toolName: event.toolName,
          argsBytes,
        });
        return;
      }

      if (event.type === 'tool_execution_update') {
        enqueue({
          type: 'tool_execution_update',
          toolName: event.toolName,
        });
        return;
      }

      if (event.type === 'tool_execution_end') {
        const start = toolStarts.get(event.toolCallId);
        const durationMs = start ? timestamp - start.startedAt : undefined;
        const status = event.isError ? 'failed' : 'completed';
        completedToolCallIds.add(event.toolCallId);
        if (!firstToolResultRecorded) {
          firstToolResultRecorded = true;
          recordWait('first_tool_result', timestamp);
        }
        enqueue({
          type: 'tool_execution_end',
          toolName: event.toolName,
          status,
          durationMs,
          argsBytes: start?.argsBytes,
          resultBytes: jsonBytes(event.result),
        });
        return;
      }

      if (event.type === 'agent_end') {
        const finalMessage = finalAssistantMessage(event.messages);
        const status = agentStatus(finalMessage);
        agentEndRecorded = true;
        enqueue({
          type: 'agent_end',
          status,
          reason: stringField(messageRecord(finalMessage), 'stopReason') ?? status,
          durationMs: timestamp - (agentStartedAt ?? promptStartedAt ?? timestamp),
          messageCount: event.messages.length,
        });
        recordRunComplete(timestamp);
        void flush();
      }
    },

    recordTranscriptSnapshot(messages: readonly AgentMessage[]) {
      const timestamp = Date.now();
      const toolCalls = toolCallsFromTranscript(messages);
      let syntheticToolResults = 0;

      for (const message of messages) {
        const record = messageRecord(message);
        if (record?.role !== 'toolResult') {
          continue;
        }
        const toolCallId = stringField(record, 'toolCallId');
        if (!toolCallId || completedToolCallIds.has(toolCallId)) {
          continue;
        }
        const toolCall = toolCalls.get(toolCallId);
        const toolName = stringField(record, 'toolName') ?? toolCall?.name;
        if (!toolName) {
          continue;
        }
        const result = {
          content: record.content,
          details: record.details,
          isError: record.isError,
        };
        completedToolCallIds.add(toolCallId);
        syntheticToolResults += 1;
        enqueue({
          type: 'tool_execution_end',
          toolName,
          status: record.isError === true ? 'failed' : 'completed',
          argsBytes: jsonBytes(toolCall?.args),
          resultBytes: jsonBytes(result),
        });
      }

      if (syntheticToolResults > 0) {
        enqueue({
          type: 'turn_end',
          toolResultCount: syntheticToolResults,
        });
      }

      if (!agentEndRecorded) {
        const finalMessage = finalAssistantMessage(messages);
        if (finalMessage) {
          const finalRecord = messageRecord(finalMessage);
          enqueue({
            type: 'message_end',
            messageRole: stringField(finalRecord, 'role'),
            stopReason: stringField(finalRecord, 'stopReason') ?? 'unknown',
            contentBytes: jsonBytes(finalRecord?.content),
            usage: usageFromMessage(finalRecord),
          });
        }
        const status = agentStatus(finalMessage);
        agentEndRecorded = true;
        enqueue({
          type: 'agent_end',
          status,
          reason: stringField(messageRecord(finalMessage), 'stopReason') ?? status,
          durationMs: timestamp - (agentStartedAt ?? promptStartedAt ?? timestamp),
          messageCount: messages.length,
        });
        recordRunComplete(timestamp);
      }

      void flush();
    },

    flush,
  };
}

export async function sendAssistantTelemetryEvents(events: AssistantTelemetryEvent[]) {
  if (events.length === 0) {
    return;
  }
  await pluginResourceFetch('/telemetry/events', {
    method: 'POST',
    data: { events },
  });
}

function finalAssistantMessage(messages: readonly AgentMessage[]) {
  return [...messages].reverse().find((message) => messageRecord(message)?.role === 'assistant');
}

function toolCallsFromTranscript(messages: readonly AgentMessage[]) {
  const toolCalls = new Map<string, { name: string; args: unknown }>();
  for (const message of messages) {
    const record = messageRecord(message);
    if (record?.role !== 'assistant' || !Array.isArray(record.content)) {
      continue;
    }
    for (const block of record.content) {
      const content = recordValue(block);
      if (content?.type !== 'toolCall') {
        continue;
      }
      const id = stringField(content, 'id');
      const name = stringField(content, 'name');
      if (id && name) {
        toolCalls.set(id, { name, args: content.arguments });
      }
    }
  }
  return toolCalls;
}

function agentStatus(finalMessage: AgentMessage | undefined) {
  const stopReason = stringField(messageRecord(finalMessage), 'stopReason');
  if (stopReason === 'aborted') {
    return 'aborted';
  }
  if (stopReason === 'error' || stringField(messageRecord(finalMessage), 'errorMessage')) {
    return 'failed';
  }
  return 'completed';
}

function usageFromMessage(message: Record<string, unknown> | undefined): AssistantTelemetryUsage | undefined {
  const usage = recordField(message, 'usage');
  if (!usage) {
    return undefined;
  }
  const result: AssistantTelemetryUsage = {
    input: numberField(usage, 'input'),
    output: numberField(usage, 'output'),
    cacheRead: numberField(usage, 'cacheRead'),
    cacheWrite: numberField(usage, 'cacheWrite'),
    totalTokens: numberField(usage, 'totalTokens'),
  };
  return Object.values(result).some((value) => value !== undefined && value > 0) ? result : undefined;
}

function hasVisibleAssistantContent(message: Record<string, unknown>) {
  const content = message.content;
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    const record = recordValue(block);
    if (record?.type === 'text') {
      return stringField(record, 'text') !== undefined;
    }
    if (record?.type === 'toolCall') {
      return stringField(record, 'name') !== undefined;
    }
    return false;
  });
}

function hasAssistantThinkingContent(message: Record<string, unknown>) {
  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    const record = recordValue(block);
    return record?.type === 'thinking' && stringField(record, 'thinking') !== undefined;
  });
}

function messageRecord(message: AgentMessage | undefined): Record<string, unknown> | undefined {
  return recordValue(message);
}

function recordField(record: Record<string, unknown> | undefined, field: string): Record<string, unknown> | undefined {
  return recordValue(record?.[field]);
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = record?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function jsonBytes(value: unknown) {
  if (value === undefined) {
    return 0;
  }
  return textBytes(JSON.stringify(value));
}

function textBytes(value: string | undefined) {
  if (!value) {
    return 0;
  }
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    return value.length;
  }
}
