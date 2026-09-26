import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message, ToolCall } from '@earendil-works/pi-ai';
import { formatBashResult, type WorkspaceBashResult } from './workspace/shell';

/** A shell command the user ran directly in the session filesystem (`!` in the composer). */
export type UserShellMessage = {
  role: 'userShell';
  /** What the model sees: the command and its formatted output. */
  content: Array<{ type: 'text'; text: string }>;
  result: Omit<WorkspaceBashResult, 'images'>;
  timestamp: number;
};

declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    userShell: UserShellMessage;
  }
}

/** Composer input that starts with `!` runs in the session shell instead of prompting the model. */
export function parseUserShellInput(input: string) {
  const trimmed = input.trim();
  return trimmed.startsWith('!') ? trimmed.slice(1).trim() : undefined;
}

export function createUserShellMessage(result: WorkspaceBashResult): UserShellMessage {
  const { images: _images, ...rest } = result;
  return {
    role: 'userShell',
    content: [
      {
        type: 'text',
        text: `The user ran this command in the session shell (not a request; use the output as context):\n$ ${result.command}\n${formatBashResult(rest)}`,
      },
    ],
    result: rest,
    timestamp: Date.now(),
  };
}

export function convertChatMessagesToLlm(messages: AgentMessage[]): Message[] {
  const pendingToolCallIds = new Set<string>();
  const converted: Message[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      converted.push(message);
      continue;
    }

    if (message.role === 'userShell') {
      converted.push({ role: 'user', content: message.content, timestamp: message.timestamp });
      continue;
    }

    if (message.role === 'assistant') {
      if (shouldHideAssistantFromLlm(message)) {
        continue;
      }

      const assistant = normalizeAssistantContent(message);
      for (const toolCall of assistantToolCalls(assistant)) {
        pendingToolCallIds.add(toolCall.id);
      }
      converted.push(assistant);
      continue;
    }

    if (message.role === 'toolResult') {
      if (!pendingToolCallIds.has(message.toolCallId)) {
        continue;
      }

      pendingToolCallIds.delete(message.toolCallId);
      converted.push(message);
    }
  }

  return converted;
}

export function hasPersistableMessages(messages: AgentMessage[]) {
  return messages.some(
    (message) => message.role === 'user' || message.role === 'assistant' || message.role === 'userShell'
  );
}

function shouldHideAssistantFromLlm(message: AssistantMessage) {
  return message.stopReason === 'aborted' || message.stopReason === 'error';
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
