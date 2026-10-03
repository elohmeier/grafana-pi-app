import type { AssistantMessage, Message, ToolCall, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { formatBashResult, type WorkspaceBashResult } from './workspace/shell';

/** A shell command the user ran directly in the session filesystem (`!` in the composer). */
export type UserShellMessage = {
  role: 'userShell';
  /** What the model sees: the command and its formatted output. */
  content: Array<{ type: 'text'; text: string }>;
  result: Omit<WorkspaceBashResult, 'images'>;
  timestamp: number;
};

/** A transcript message as the chat shows it. */
export type ChatMessage = Exclude<Message, { role: 'system' }> | UserShellMessage;

/** Composer input that starts with `!` runs in the session shell instead of prompting the model. */
export function parseUserShellInput(input: string) {
  const trimmed = input.trim();
  return trimmed.startsWith('!') ? trimmed.slice(1).trim() : undefined;
}

export function createUserShellMessage(result: WorkspaceBashResult): UserShellMessage {
  const { images: _images, ...rest } = result;
  return {
    role: 'userShell',
    content: [{ type: 'text', text: userShellText(rest) }],
    result: rest,
    timestamp: Date.now(),
  };
}

/** What the model sees of a user shell command: a user message with the command and its output. */
export function userShellModelMessage(result: WorkspaceBashResult, timestamp = Date.now()): UserMessage {
  const { images: _images, ...rest } = result;
  return { role: 'user', content: [{ type: 'text', text: userShellText(rest) }], timestamp };
}

function userShellText(result: Omit<WorkspaceBashResult, 'images'>) {
  return `The user ran this command in the session shell (not a request; use the output as context):\n$ ${result.command}\n${formatBashResult(result)}`;
}

/** Texts of the prompts the user sent, oldest first (not shell commands). */
export function userPromptTexts(messages: readonly ChatMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role !== 'user') {
      return [];
    }
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    return text.trim() ? [text] : [];
  });
}

function normalizeAssistantContent(message: AssistantMessage): AssistantMessage {
  const content = (message as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return message;
  }
  if (typeof content === 'string') {
    return {
      ...message,
      content: [{ type: 'text', text: content }],
    };
  }

  return {
    ...message,
    content: [],
  };
}

function assistantToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === 'toolCall');
}

/**
 * Maps each tool call ID to its result message, for results whose call appears in
 * an earlier assistant message. The transcript shows those results with their call.
 */
export function pairToolResults(messages: ChatMessage[]): Map<string, ToolResultMessage> {
  const callIds = new Set<string>();
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const toolCall of assistantToolCalls(message)) {
        callIds.add(toolCall.id);
      }
    } else if (message.role === 'toolResult' && callIds.has(message.toolCallId)) {
      results.set(message.toolCallId, message);
    }
  }
  return results;
}

/** Tool-calling steps of a finished turn, collapsed behind one summary line in the transcript. */
export type TurnSteps = {
  /** Index of the first step message. */
  start: number;
  /** Index of the last step message; the turn's answer follows it. */
  end: number;
  toolCalls: number;
  failedToolCalls: number;
  /** Time from the first step to the start of the answer. */
  durationMs?: number;
};

/**
 * Finds the steps of turns that ended with an answer: runs of consecutive
 * assistant messages whose last one stops normally without calling tools.
 * With `isStreaming`, the run ending at the last message is still in progress.
 */
export function finishedTurnSteps(
  messages: ChatMessage[],
  results: ReadonlyMap<string, ToolResultMessage>,
  isStreaming = false
): TurnSteps[] {
  const turns: TurnSteps[] = [];
  let start = 0;
  while (start < messages.length) {
    let end = start;
    while (messages[end].role === 'assistant' && messages[end + 1]?.role === 'assistant') {
      end += 1;
    }
    const answer = messages[end];
    const inProgress = isStreaming && end === messages.length - 1;
    if (
      end > start &&
      !inProgress &&
      answer.role === 'assistant' &&
      answer.stopReason === 'stop' &&
      assistantToolCalls(normalizeAssistantContent(answer)).length === 0
    ) {
      const calls = messages
        .slice(start, end)
        .flatMap((message) =>
          message.role === 'assistant' ? assistantToolCalls(normalizeAssistantContent(message)) : []
        );
      const first = messages[start];
      turns.push({
        start,
        end: end - 1,
        toolCalls: calls.length,
        failedToolCalls: calls.filter((call) => isFailedToolResult(results.get(call.id))).length,
        durationMs:
          'timestamp' in first && answer.timestamp > first.timestamp ? answer.timestamp - first.timestamp : undefined,
      });
    }
    start = end + 1;
  }
  return turns;
}

/** Diagnostic the harness adds to the result of a tool call the user stopped. */
const STOPPED_TOOL_DIAGNOSTIC = /^\[error\] Tool \S+ was aborted$/m;

/** Whether a tool result's content is the harness's note that the user stopped the call. */
export function isStoppedToolContent(content: ReadonlyArray<{ type: string; text?: string }> | undefined) {
  return STOPPED_TOOL_DIAGNOSTIC.test(
    (content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('\n')
  );
}

/** A tool call ended by the user pressing Stop, before or while it ran; not a failure. */
export function isStoppedToolResult(result: ToolResultMessage) {
  const details = result.details as { exitCode?: unknown; discardedChanges?: unknown } | undefined;
  return (
    (result.isError && isStoppedToolContent(result.content)) ||
    (result.toolName === 'bash' && details?.exitCode === 130 && details.discardedChanges === 'cancelled')
  );
}

function isFailedToolResult(result: ToolResultMessage | undefined) {
  if (!result || isStoppedToolResult(result)) {
    return false;
  }
  const details = result.details as { exitCode?: unknown; timedOut?: unknown } | undefined;
  return (
    result.isError ||
    details?.timedOut === true ||
    (result.toolName === 'bash' && typeof details?.exitCode === 'number' && details.exitCode !== 0)
  );
}
