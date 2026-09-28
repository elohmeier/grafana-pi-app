import type { AgentMessage } from '@earendil-works/pi-agent-core';

/**
 * Context compaction for one long agent session. The chat transcript (agent
 * state) stays complete; this only shapes what is sent to the model on each
 * request:
 *
 * 1. Under budget: send the transcript unchanged (after any earlier summary).
 * 2. Over the trigger: elide large tool outputs outside the recent window.
 * 3. Still over: summarize older turns into a rolling summary, cut only at
 *    message boundaries that do not separate tool calls from their results.
 *
 * The summary is cached with the session and extended incrementally.
 */

export type CompactionState = {
  version: 1;
  summary: string;
  /** Number of leading transcript messages the summary replaces. */
  coveredMessages: number;
  /** Fingerprint of the last covered message; a mismatch invalidates the summary. */
  anchor: string;
  compactedAt: string;
  compactions: number;
};

export type CompactionBudget = {
  contextWindow: number;
  maxOutputTokens: number;
  /** Tokens used by the system prompt and tool schemas. */
  fixedTokens: number;
};

export type CompactionEvent = {
  kind: 'elided' | 'summarized' | 'truncated';
  estimatedTokens: number;
  budgetTokens: number;
  coveredMessages?: number;
};

export type Summarizer = (
  input: { previousSummary?: string; transcript: string },
  signal?: AbortSignal
) => Promise<string>;

export type ContextCompactorOptions = {
  getBudget: () => CompactionBudget;
  summarize: Summarizer;
  initialState?: CompactionState;
  onStateChange?: (state: CompactionState | undefined) => void;
  onEvent?: (event: CompactionEvent) => void;
  /** Fraction of the history budget at which compaction starts. */
  triggerRatio?: number;
  /** Fraction of the history budget kept verbatim at the end of the transcript. */
  keepRecentRatio?: number;
};

const SAFETY_MARGIN_TOKENS = 2048;
const ELIDE_TOOL_RESULT_CHARS = 1500;
const SUMMARY_CHUNK_CHARS = 60_000;
const TRANSCRIPT_TOOL_ARGS_CHARS = 1500;
const TRANSCRIPT_TOOL_RESULT_CHARS = 3000;
const IMAGE_TOKENS = 1200;

export const SUMMARY_TAG = 'conversation_summary';

export class ContextCompactor {
  private state?: CompactionState;
  private readonly triggerRatio: number;
  private readonly keepRecentRatio: number;

  constructor(private readonly options: ContextCompactorOptions) {
    this.state = isCompactionState(options.initialState) ? options.initialState : undefined;
    this.triggerRatio = options.triggerRatio ?? 0.8;
    this.keepRecentRatio = options.keepRecentRatio ?? 0.35;
  }

  getState() {
    return this.state;
  }

  /** Agent `transformContext` hook. */
  transform = async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    const budget = historyBudget(this.options.getBudget());
    const trigger = Math.floor(budget * this.triggerRatio);
    const keepRecent = Math.floor(budget * this.keepRecentRatio);

    if (this.state && !this.stateMatches(messages)) {
      this.setState(undefined);
    }
    const covered = this.state?.coveredMessages ?? 0;
    const current = this.view(messages, covered, this.state?.summary);
    if (estimateMessagesTokens(current) <= trigger) {
      return current;
    }

    // Stage 1: elide bulky tool output outside the recent window.
    const recentStart = recentWindowStart(messages, covered, keepRecent);
    const elided = this.view(
      messages.map((message, index) => (index < recentStart ? elideToolResult(message) : message)),
      covered,
      this.state?.summary
    );
    const elidedTokens = estimateMessagesTokens(elided);
    if (elidedTokens <= trigger) {
      this.options.onEvent?.({ kind: 'elided', estimatedTokens: elidedTokens, budgetTokens: budget });
      return elided;
    }

    // Stage 2: summarize everything before a safe cut into the rolling summary.
    const cut = safeCutIndex(messages, Math.max(recentStart, covered + 1));
    if (cut > covered) {
      try {
        const summary = await this.summarizeRange(messages.slice(covered, cut), this.state?.summary, budget, signal);
        this.setState({
          version: 1,
          summary,
          coveredMessages: cut,
          anchor: fingerprint(messages[cut - 1]),
          compactedAt: new Date().toISOString(),
          compactions: (this.state?.compactions ?? 0) + 1,
        });
        const view = this.view(
          messages.map((message, index) => (index < recentStart ? elideToolResult(message) : message)),
          cut,
          summary
        );
        const tokens = estimateMessagesTokens(view);
        this.options.onEvent?.({
          kind: 'summarized',
          estimatedTokens: tokens,
          budgetTokens: budget,
          coveredMessages: cut,
        });
        if (tokens <= budget) {
          return view;
        }
        return truncateToBudget(view, budget);
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        // Summarization failed: fall through to truncation rather than overflowing.
      }
    }

    const truncated = truncateToBudget(elided, budget);
    this.options.onEvent?.({
      kind: 'truncated',
      estimatedTokens: estimateMessagesTokens(truncated),
      budgetTokens: budget,
    });
    return truncated;
  };

  private view(messages: AgentMessage[], covered: number, summary: string | undefined): AgentMessage[] {
    if (!summary || covered <= 0) {
      return messages;
    }
    return withSummary(summary, messages.slice(covered));
  }

  private stateMatches(messages: AgentMessage[]) {
    const state = this.state!;
    return (
      messages.length >= state.coveredMessages && fingerprint(messages[state.coveredMessages - 1]) === state.anchor
    );
  }

  private async summarizeRange(
    range: AgentMessage[],
    previousSummary: string | undefined,
    budget: number,
    signal?: AbortSignal
  ) {
    const chunkChars = Math.max(8000, Math.min(SUMMARY_CHUNK_CHARS, Math.floor(budget * 4 * 0.5)));
    let summary = previousSummary;
    for (const chunk of transcriptChunks(range, chunkChars)) {
      summary = (await this.options.summarize({ previousSummary: summary, transcript: chunk }, signal)).trim();
      if (!summary) {
        throw new Error('summarizer returned an empty summary');
      }
    }
    return summary ?? '';
  }

  private setState(state: CompactionState | undefined) {
    this.state = state;
    this.options.onStateChange?.(state);
  }
}

export function historyBudget(budget: CompactionBudget) {
  return Math.max(2048, budget.contextWindow - budget.maxOutputTokens - budget.fixedTokens - SAFETY_MARGIN_TOKENS);
}

/** Conservative token estimate (~4 characters per token). */
export function estimateTextTokens(text: string) {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]) {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export function estimateMessageTokens(message: AgentMessage): number {
  const record = message as unknown as { content?: unknown };
  let tokens = 4;
  const content = record.content;
  if (typeof content === 'string') {
    return tokens + estimateTextTokens(content);
  }
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'image') {
        tokens += IMAGE_TOKENS;
      } else if (block.type === 'text') {
        tokens += estimateTextTokens(String(block.text ?? ''));
      } else if (block.type === 'thinking') {
        tokens += estimateTextTokens(String(block.thinking ?? ''));
      } else if (block.type === 'toolCall') {
        tokens += estimateTextTokens(`${block.name ?? ''}${JSON.stringify(block.arguments ?? {})}`);
      } else {
        tokens += estimateTextTokens(JSON.stringify(block));
      }
    }
    return tokens;
  }
  return tokens + estimateTextTokens(JSON.stringify(message));
}

function withSummary(summary: string, rest: AgentMessage[]): AgentMessage[] {
  const summaryText = `<${SUMMARY_TAG}>\nEarlier parts of this conversation were compacted into this summary. Files under /session and /workspace still hold the full working state; read them when you need details.\n\n${summary}\n</${SUMMARY_TAG}>`;
  const [first, ...others] = rest;
  // Merge into the next user message so roles keep alternating.
  if (first && (first as { role?: string }).role === 'user') {
    const user = first as unknown as { role: 'user'; content: unknown; timestamp: number };
    const content =
      typeof user.content === 'string' ? [{ type: 'text', text: user.content }] : (user.content as unknown[]);
    return [
      { ...user, content: [{ type: 'text', text: summaryText }, ...content] } as unknown as AgentMessage,
      ...others,
    ];
  }
  return [
    { role: 'user', content: [{ type: 'text', text: summaryText }], timestamp: Date.now() } as unknown as AgentMessage,
    ...rest,
  ];
}

function elideToolResult(message: AgentMessage): AgentMessage {
  const record = message as unknown as { role?: string; content?: unknown };
  if (record.role !== 'toolResult' || !Array.isArray(record.content)) {
    return message;
  }
  let changed = false;
  const content = (record.content as Array<Record<string, unknown>>).map((block) => {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > ELIDE_TOOL_RESULT_CHARS) {
      changed = true;
      const head = block.text.slice(0, Math.floor(ELIDE_TOOL_RESULT_CHARS * 0.7));
      const tail = block.text.slice(-Math.floor(ELIDE_TOOL_RESULT_CHARS * 0.2));
      return {
        ...block,
        text: `${head}\n[... ${block.text.length - head.length - tail.length} characters of older tool output omitted; rerun the command or read the file if needed ...]\n${tail}`,
      };
    }
    if (block.type === 'image') {
      changed = true;
      return { type: 'text', text: '[older image omitted]' };
    }
    return block;
  });
  return changed ? ({ ...record, content } as unknown as AgentMessage) : message;
}

/** Index of the first message in the verbatim recent window. */
function recentWindowStart(messages: AgentMessage[], covered: number, keepRecentTokens: number) {
  let tokens = 0;
  let index = messages.length;
  while (index > covered) {
    const next = estimateMessageTokens(messages[index - 1]);
    if (tokens + next > keepRecentTokens && index < messages.length) {
      break;
    }
    tokens += next;
    index--;
  }
  return index;
}

/**
 * Moves a cut forward to a boundary where no tool result is separated from its
 * call: the message at the cut must not be a tool result.
 */
function safeCutIndex(messages: AgentMessage[], desired: number) {
  let cut = Math.min(desired, messages.length);
  while (cut < messages.length && (messages[cut] as { role?: string }).role === 'toolResult') {
    cut++;
  }
  // Never summarize the latest message: the model must see the current request verbatim.
  return Math.min(cut, messages.length - 1);
}

function truncateToBudget(messages: AgentMessage[], budget: number) {
  const result = [...messages];
  // Keep the summary (if any) and the most recent messages; drop from the front.
  const hasSummary = isSummaryMessage(result[0]);
  const start = hasSummary ? 1 : 0;
  while (result.length > start + 1 && estimateMessagesTokens(result) > budget) {
    result.splice(start, 1);
    while (result.length > start + 1 && (result[start] as { role?: string }).role === 'toolResult') {
      result.splice(start, 1);
    }
  }
  return result;
}

function isSummaryMessage(message: AgentMessage | undefined) {
  const content = (message as { content?: unknown } | undefined)?.content;
  const first = Array.isArray(content) ? (content[0] as { text?: unknown }) : undefined;
  return typeof first?.text === 'string' && first.text.startsWith(`<${SUMMARY_TAG}>`);
}

function* transcriptChunks(messages: AgentMessage[], maxChars: number) {
  let chunk = '';
  for (const message of messages) {
    const rendered = renderTranscriptMessage(message);
    if (chunk && chunk.length + rendered.length > maxChars) {
      yield chunk;
      chunk = '';
    }
    chunk += rendered.length > maxChars ? `${rendered.slice(0, maxChars - 100)}\n[truncated]\n` : rendered;
  }
  if (chunk) {
    yield chunk;
  }
}

export function renderTranscriptMessage(message: AgentMessage): string {
  const record = message as unknown as {
    role?: string;
    content?: unknown;
    toolName?: string;
    isError?: boolean;
  };
  const role = record.role ?? 'message';
  const parts: string[] = [];
  const content = typeof record.content === 'string' ? [{ type: 'text', text: record.content }] : record.content;
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text') {
        const text = String(block.text ?? '');
        parts.push(role === 'toolResult' ? clip(text, TRANSCRIPT_TOOL_RESULT_CHARS) : text);
      } else if (block.type === 'toolCall') {
        parts.push(
          `[tool call ${String(block.name)}] ${clip(JSON.stringify(block.arguments ?? {}), TRANSCRIPT_TOOL_ARGS_CHARS)}`
        );
      } else if (block.type === 'image') {
        parts.push('[image]');
      }
    }
  }
  const label =
    role === 'toolResult'
      ? `TOOL RESULT (${record.toolName ?? 'tool'}${record.isError ? ', error' : ''})`
      : role.toUpperCase();
  return `### ${label}\n${parts.join('\n')}\n\n`;
}

export const SUMMARIZER_SYSTEM_PROMPT = `You compact the history of a Grafana observability assistant session so the work can continue with less context.

Write a dense, factual summary in markdown with these sections (omit empty ones):
- User goal and constraints: what the user asked for, explicit requirements, preferences, and decisions.
- State of work: what is done, what is in progress, and the next steps.
- Grafana facts: datasource UIDs, dashboard UIDs and titles, panel titles, metric names, label names/values, validated PromQL (with whether it returned data), time ranges.
- Files and changes: session filesystem paths written or edited, staged dashboard changes, receipt IDs and their status, apply outcomes (applied, conflicted, denied), resource revisions.
- Open issues: errors, unverified assumptions, and pending approvals.

Rules: keep identifiers, paths, queries, and receipt IDs verbatim. Do not invent facts. Prefer bullet points. If a previous summary is given, merge it with the new transcript into one updated summary; do not drop still-relevant facts.`;

export function buildSummarizerPrompt(input: { previousSummary?: string; transcript: string }) {
  return [
    input.previousSummary ? `Previous summary:\n${input.previousSummary}` : '',
    `Transcript to fold into the summary:\n${input.transcript}`,
    'Return only the updated summary.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function isCompactionState(value: unknown): value is CompactionState {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.summary === 'string' &&
    typeof record.coveredMessages === 'number' &&
    record.coveredMessages > 0 &&
    typeof record.anchor === 'string'
  );
}

function fingerprint(message: AgentMessage | undefined) {
  if (!message) {
    return '';
  }
  const record = message as unknown as { role?: string; timestamp?: number; toolCallId?: string };
  const text = JSON.stringify((message as unknown as { content?: unknown }).content ?? '');
  return `${record.role ?? ''}:${record.timestamp ?? ''}:${record.toolCallId ?? ''}:${text.length}:${text.slice(0, 64)}`;
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…[${text.length - max} more chars]` : text;
}
