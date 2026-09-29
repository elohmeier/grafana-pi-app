import type { AgentMessage } from '@earendil-works/pi-agent-core';

const MAX_HISTORY = 100;

/** Composer history browsing: `index` -1 is the draft, 0 the newest entry. */
export type PromptHistoryState = { index: number; draft: string; entries: string[] };

/**
 * Earlier composer inputs of this chat, newest first, like the prompt history
 * of the pi coding agent: user prompts as typed and shell commands as
 * `!command`. Consecutive duplicates collapse into one entry.
 */
export function promptHistory(messages: readonly AgentMessage[]): string[] {
  const entries: string[] = [];
  for (let index = messages.length - 1; index >= 0 && entries.length < MAX_HISTORY; index--) {
    const text = composerText(messages[index]);
    if (text && text !== entries[entries.length - 1]) {
      entries.push(text);
    }
  }
  return entries;
}

function composerText(message: AgentMessage): string | undefined {
  if (message.role === 'userShell') {
    return `!${message.result.command}`;
  }
  if (message.role !== 'user') {
    return undefined;
  }
  const content = message.content;
  const text =
    typeof content === 'string' ? content : content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  return text.trim() || undefined;
}

/**
 * Moves through the history (`-1` older, `1` newer) and returns the text to
 * show, or undefined when there is nowhere to go. The first step saves the
 * current input as the draft; stepping past the newest entry restores it. A
 * draft of just `!` (shell mode) browses shell commands only.
 */
export function navigatePromptHistory(
  state: PromptHistoryState | undefined,
  messages: readonly AgentMessage[],
  input: string,
  direction: -1 | 1
): { state: PromptHistoryState | undefined; text: string } | undefined {
  const current =
    state ??
    (() => {
      const all = promptHistory(messages);
      const entries = input.trim() === '!' ? all.filter((entry) => entry.startsWith('!')) : all;
      return { index: -1, draft: input, entries };
    })();
  const index = current.index - direction;
  if (index < -1 || index >= current.entries.length || (index === -1 && current.index === -1)) {
    return undefined;
  }
  if (index === -1) {
    return { state: undefined, text: current.draft };
  }
  return { state: { ...current, index }, text: current.entries[index] };
}
