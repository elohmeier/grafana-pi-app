import type { AssistantMessage, ToolCall, UserMessage } from '@earendil-works/pi-ai';
import type { ConversationView, EntryRecord, LiveState } from '@earendil-works/pi-durable';
import { createUserShellMessage, type ChatMessage } from '../chatMessages';
import type { ToolRunState, ToolRunView } from '../session/toolRuns';
import { deriveRunStatus, type ChatRunStatus } from '../streamingStatus';
import type { WorkspaceBashResult } from '../workspace/shell';
import { SHELL_ENTRY_KIND } from './documents';

/** A summary that replaced earlier messages in the model's context; the transcript still shows them. */
export type TranscriptCompaction = {
  /** Index into `messages` of the first message the model still sees verbatim. */
  index: number;
  summary: string;
  reason?: string;
};

/** Everything the chat view renders of a conversation. */
export type ChatTranscript = {
  messages: ChatMessage[];
  compactions: TranscriptCompaction[];
  /** The answer being streamed. */
  streamingMessage?: AssistantMessage;
  toolRuns: ToolRunState;
  busy: boolean;
  runStatus?: ChatRunStatus;
  /** Inputs waiting for the running answer. */
  queued: number;
};

export const EMPTY_TRANSCRIPT: ChatTranscript = { messages: [], compactions: [], toolRuns: {}, busy: false, queued: 0 };

/** Wraps the summary text; the summary entry's user message is `<prefix><summary>...</summary>`. */
const SUMMARY_PATTERN = /<summary>\s*([\s\S]*?)\s*<\/summary>/;

/**
 * Projects committed conversation state onto the chat view. `entries` are all
 * entries of the conversation in ID order, including those before the
 * newest compaction, which the model no longer sees.
 */
export function projectTranscript(
  entries: readonly EntryRecord[],
  view: ConversationView | undefined,
  timing: { runStartedAt?: number; toolStartedAt: Map<string, number> }
): ChatTranscript {
  const messages: ChatMessage[] = [];
  const indexByEntry = new Map<number, number>();
  const summaries: Array<{ head: number; summary: string; reason?: string }> = [];
  for (const entry of entries) {
    const message = entryMessage(entry);
    const previous = messages.at(-1);
    if (message?.role === 'assistant' && previous?.role === 'assistant' && previous.stopReason === 'aborted') {
      // A reload interrupted that answer and the run requested it again; keep only the new one.
      messages.pop();
      for (const [id, index] of indexByEntry) {
        if (index === messages.length) {
          indexByEntry.delete(id);
        }
      }
    }
    if (message) {
      indexByEntry.set(entry.id, messages.length);
      messages.push(message);
    }
    if (entry.kind === 'pi.compaction' && entry.head !== undefined) {
      const text = textOf(entry.model?.[0] as UserMessage | undefined);
      const reason = (entry.data as { reason?: string } | undefined)?.reason;
      summaries.push({ head: entry.head, summary: SUMMARY_PATTERN.exec(text)?.[1] ?? text, reason });
    }
  }
  const compactions = summaries.flatMap(({ head, summary, reason }) => {
    const index = indexByEntry.get(head) ?? firstIndexAtOrAfter(entries, indexByEntry, head);
    return index === undefined ? [] : [{ index, summary, reason }];
  });

  const live = (view?.docs['pi.live'] ?? {}) as LiveState;
  const busy = live.run !== undefined;
  const streamingMessage = live.generation?.message as AssistantMessage | undefined;
  const toolRuns = projectToolRuns(live, messages, timing.toolStartedAt);
  const inbox = view?.docs['pi.inbox'] as { items?: unknown[] } | undefined;
  return {
    messages,
    compactions,
    streamingMessage: streamingMessage && hasContent(streamingMessage) ? streamingMessage : undefined,
    toolRuns,
    busy,
    runStatus: busy ? deriveRunStatus(live, timing.runStartedAt ?? Date.now()) : undefined,
    queued: inbox?.items?.length ?? 0,
  };
}

function entryMessage(entry: EntryRecord): ChatMessage | undefined {
  switch (entry.kind) {
    case 'pi.user':
    case 'pi.assistant':
    case 'pi.tool-result':
      return entry.model?.[0] as ChatMessage | undefined;
    case SHELL_ENTRY_KIND: {
      const result = entry.data as unknown as WorkspaceBashResult | undefined;
      const message = result ? createUserShellMessage(result) : undefined;
      const timestamp = (entry.model?.[0] as UserMessage | undefined)?.timestamp;
      return message && timestamp ? { ...message, timestamp } : message;
    }
    default:
      return undefined;
  }
}

function projectToolRuns(live: LiveState, messages: ChatMessage[], startedAt: Map<string, number>): ToolRunState {
  const slots = live.tools ?? [];
  if (slots.length === 0) {
    return {};
  }
  const calls = new Map<string, ToolCall>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'toolCall') {
          calls.set(block.id, block);
        }
      }
      break;
    }
  }
  const now = Date.now();
  const runs: ToolRunState = {};
  for (const slot of slots) {
    if (slot.status === 'pending') {
      continue;
    }
    if (!startedAt.has(slot.callId)) {
      startedAt.set(slot.callId, now);
    }
    const run: ToolRunView = {
      id: slot.callId,
      name: slot.name,
      args: calls.get(slot.callId)?.arguments,
      status: slot.status === 'done' ? 'completed' : 'running',
      ...(slot.details !== undefined ? { partialResult: { content: [], details: slot.details } } : {}),
      startedAt: startedAt.get(slot.callId),
      updatedAt: now,
    };
    runs[slot.callId] = run;
  }
  return runs;
}

function firstIndexAtOrAfter(entries: readonly EntryRecord[], indexByEntry: Map<number, number>, head: number) {
  for (const entry of entries) {
    if (entry.id >= head && indexByEntry.has(entry.id)) {
      return indexByEntry.get(entry.id);
    }
  }
  return undefined;
}

function hasContent(message: AssistantMessage) {
  return Array.isArray(message.content) && message.content.length > 0;
}

function textOf(message: UserMessage | undefined) {
  if (!message) {
    return '';
  }
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}
