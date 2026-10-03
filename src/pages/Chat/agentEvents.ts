import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import type { AgentEvent as DurableEvent, EntryRecord, MessageChange } from '@earendil-works/pi-durable';
import type { ChatMessage } from './chatMessages';

/**
 * Run events of a chat for telemetry and the benchmark recorder, shaped like
 * the Pi coding agent's events: a run is `agent_start` … `agent_end`, and
 * message and tool events carry whole messages and results.
 */
export type ChatAgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: ChatMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: ChatMessage }
  | { type: 'message_update'; message: AssistantMessage }
  | { type: 'message_end'; message: ChatMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      partialResult: { content: []; details: unknown };
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: { content: ToolResultMessage['content']; details: unknown };
      isError: boolean;
    }
  | { type: 'context_compaction'; kind: 'summarizing' | 'summarized'; reason?: string; blocking?: boolean }
  /** A harness task failed on a bug or malformed data; a failed tool call reaches the model as a missing result. */
  | { type: 'task_failed'; kind: string; message: string };

/** Converts the harness's per-commit event batches of one conversation into chat run events. */
export function createChatEventAdapter() {
  let runMessages: ChatMessage[] = [];
  let turnResults: ToolResultMessage[] = [];
  let partial: AssistantMessage | undefined;

  const entryMessage = (entry: EntryRecord | undefined) => entry?.model?.[0] as ChatMessage | undefined;

  return (events: readonly DurableEvent[]): ChatAgentEvent[] => {
    const out: ChatAgentEvent[] = [];
    for (const event of events) {
      switch (event.type) {
        case 'run_start':
          runMessages = [];
          out.push({ type: 'agent_start' });
          break;
        case 'run_end':
          out.push({ type: 'agent_end', messages: runMessages });
          runMessages = [];
          break;
        case 'turn_start':
          turnResults = [];
          out.push({ type: 'turn_start' });
          break;
        case 'turn_end':
          out.push({ type: 'turn_end', toolResults: turnResults });
          break;
        case 'message_start':
          if (event.message.role === 'assistant') {
            partial = event.message;
          }
          if (event.message.role !== 'system') {
            out.push({ type: 'message_start', message: event.message });
          }
          break;
        case 'message_update':
          if (partial) {
            partial = applyChanges(partial, event.changes);
            out.push({ type: 'message_update', message: partial });
          }
          break;
        case 'message_end': {
          partial = undefined;
          if (event.entry.kind === 'pi.compaction') {
            out.push({ type: 'context_compaction', kind: 'summarized', reason: compactionReason(event.entry) });
            break;
          }
          const message = entryMessage(event.entry);
          if (message && (message.role as string) !== 'system') {
            runMessages.push(message);
            out.push({ type: 'message_end', message });
          }
          break;
        }
        case 'tool_execution_start':
          out.push({
            type: 'tool_execution_start',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          break;
        case 'tool_execution_update':
          if (event.details !== undefined) {
            out.push({
              type: 'tool_execution_update',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              partialResult: { content: [], details: event.details },
            });
          }
          break;
        case 'tool_execution_end': {
          const result = entryMessage(event.entry) as ToolResultMessage | undefined;
          if (result) {
            runMessages.push(result);
            turnResults.push(result);
          }
          out.push({
            type: 'tool_execution_end',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: { content: result?.content ?? [], details: result?.details },
            isError: result ? result.isError : true,
          });
          break;
        }
        case 'task_failed':
          out.push({ type: 'task_failed', kind: event.kind, message: event.message });
          break;
        case 'compaction_start':
          out.push({ type: 'context_compaction', kind: 'summarizing', reason: event.reason, blocking: event.blocking });
          break;
      }
    }
    return out;
  };
}

function compactionReason(entry: EntryRecord) {
  return (entry.data as { reason?: string } | undefined)?.reason;
}

/** Applies streamed changes to the in-flight assistant message. Tool call arguments are taken from completed blocks. */
function applyChanges(message: AssistantMessage, changes: readonly MessageChange[]): AssistantMessage {
  let content = [...message.content];
  let next = message;
  for (const change of changes) {
    switch (change.type) {
      case 'message':
        next = change.message;
        content = [...change.message.content];
        break;
      case 'text_start':
      case 'thinking_start':
      case 'toolcall_start':
      case 'block':
        content[change.contentIndex] = change.block;
        break;
      case 'text_delta': {
        const block = content[change.contentIndex];
        if (block?.type === 'text') {
          content[change.contentIndex] = { ...block, text: block.text + change.delta };
        }
        break;
      }
      case 'thinking_delta': {
        const block = content[change.contentIndex];
        if (block?.type === 'thinking') {
          content[change.contentIndex] = { ...block, thinking: block.thinking + change.delta };
        }
        break;
      }
      case 'toolcall_delta':
        break;
    }
  }
  return { ...next, content };
}
