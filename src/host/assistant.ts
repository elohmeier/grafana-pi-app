import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ChatMessage } from '../pages/Chat/chatMessages';
import type { AssistantStreamFn } from '../pages/Chat/durable/models';
import type { ChatLogClient } from '../pages/Chat/durable/chatLogClient';
import { resolveChatModelSettings } from '../pages/Chat/model';
import { AssistantSession, type SessionHost } from '../pages/Chat/session/AssistantSession';
import { getGrafanaSkills } from '../pages/Chat/skills';
import type { WorkspaceBroker } from '../pages/Chat/workspace/broker';
import type { PiAppJsonData } from '../types';

/** What the model is told about answering outside Grafana. */
export const CHANNEL_PROMPT = `You are answering in a chat thread (Mattermost), not in Grafana.
- You are read-only here: \`workspace apply\`, \`live apply\`, and navigation are not available. Do not stage dashboard or alert rule changes; when a change would help, describe it and say that it can be made in Grafana.
- Screenshots you take (\`grafana-dashboard screenshot UID --panel ID --from ... --to ...\`) are posted below your answer, so take only the ones people should see. Present a small table with \`evidence show FILE --view table\`; other tool output is not shown.
- People read your answer in the thread: lead with the finding, keep it short (at most about 15 lines), use Markdown lists, and include exact numbers, times in UTC, and the names of dashboards, alert rules, and services you checked.
- Earlier messages in the thread reach you as the conversation; the alert notification that started the thread is your starting point.`;

const DECLINED =
  'changes cannot be applied from a chat channel; nobody can review them here. Do not retry: describe the change and say it can be made in Grafana.';

/** The chat of a conversation: `stored` when it exists in the plugin backend. */
export type ChatRef = { id: string; stored: boolean };

export type AssistantRunProgress = { toolCalls: number; lastCommand?: string };

/** Images and `evidence show` presentations of a run, posted with the answer. */
export type PresentedEvidence =
  | { view: 'image'; title: string; mimeType: string; data: string }
  | { view: 'json' | 'text' | 'table'; title: string; data: unknown };

export type AssistantAnswer = {
  chatId: string;
  text: string;
  toolCalls: number;
  evidence?: PresentedEvidence[];
  error?: string;
};

export type AssistantHostOptions = {
  /** Plugin settings as stored in Grafana, read again for every run. */
  jsonData: () => Promise<PiAppJsonData>;
  streamFn: AssistantStreamFn;
  broker: (jsonData: PiAppJsonData) => WorkspaceBroker;
  chatLog: ChatLogClient;
  /** Runs at the same time across conversations; more wait their turn. Bounds the load on the model server. */
  concurrency?: number;
};

/**
 * Runs assistant chats for a chat channel. One chat per conversation (a
 * thread); prompts of one conversation run one after another. Approvals are
 * declined, so the assistant cannot write to Grafana from a channel.
 */
export class AssistantHost {
  private queues = new Map<string, Promise<unknown>>();
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly options: AssistantHostOptions) {}

  /**
   * Sends `text` to the chat and resolves with the final answer. With `resume`, a chat whose last
   * prompt is `text` (the host stopped during its run) is continued instead of prompted again.
   */
  ask(
    conversation: string,
    chat: ChatRef,
    text: string,
    onProgress?: (progress: AssistantRunProgress) => void,
    options: { resume?: boolean } = {}
  ): Promise<AssistantAnswer> {
    const previous = this.queues.get(conversation) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.limited(() => this.run(chat, text, onProgress, options.resume ?? false)));
    this.queues.set(conversation, run);
    void run.finally(() => {
      if (this.queues.get(conversation) === run) {
        this.queues.delete(conversation);
      }
    });
    return run;
  }

  private async limited<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= (this.options.concurrency ?? 2)) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async run(
    chat: ChatRef,
    text: string,
    onProgress: ((progress: AssistantRunProgress) => void) | undefined,
    resume: boolean
  ): Promise<AssistantAnswer> {
    const jsonData = await this.options.jsonData();
    const settings: PiAppJsonData = {
      ...jsonData,
      systemPromptAddendum: [jsonData.systemPromptAddendum, CHANNEL_PROMPT].filter(Boolean).join('\n\n'),
    };
    const broker = this.options.broker(settings);
    const skills = getGrafanaSkills(settings);
    const session = new AssistantSession({ id: chat.id, stored: chat.stored });
    const host: SessionHost = {
      chatLog: this.options.chatLog,
      environment: (target) => {
        const { model, thinkingLevel } = resolveChatModelSettings(settings, target.getState());
        return { jsonData: settings, streamFn: this.options.streamFn, model, thinkingLevel, broker, skills };
      },
    };
    // Nobody can review a change set in a channel.
    const unsubscribeApprovals = session.approvals.subscribe(() => {
      if (session.approvals.getSnapshot()) {
        session.approvals.settle(false, undefined, DECLINED);
      }
    });
    const progress: AssistantRunProgress = { toolCalls: 0 };
    const evidence: PresentedEvidence[] = [];
    const unsubscribeEvents = session.subscribe((event) => {
      if (event.type === 'tool_execution_start') {
        progress.toolCalls++;
        const args = event.args as { command?: unknown; path?: unknown } | undefined;
        const detail =
          typeof args?.command === 'string' ? args.command : typeof args?.path === 'string' ? args.path : '';
        progress.lastCommand = `${event.toolName} ${detail}`.trim().split('\n')[0];
        onProgress?.({ ...progress });
      }
      if (event.type === 'tool_execution_end') {
        for (const item of presentedEvidence(event.result)) {
          // An image presented again with `evidence show` is posted once.
          if (item.view !== 'image' || !evidence.some((seen) => seen.view === 'image' && seen.data === item.data)) {
            evidence.push(item);
          }
        }
      }
    });
    try {
      session.attach(host);
      await session.open();
      let start = session.messages.length;
      const prompted = resume ? lastPromptIndex(session.messages, text) : -1;
      if (prompted >= 0) {
        // The harness continues the interrupted run when the chat opens.
        start = prompted + 1;
      } else {
        await session.prompt(text);
      }
      await session.idle();
      const state = session.getState();
      if (state.storage.status === 'lost') {
        return { chatId: session.id, text: '', toolCalls: progress.toolCalls, error: state.storage.message };
      }
      const answer = lastAssistantMessage(session.messages.slice(start));
      return {
        chatId: session.id,
        text: answer ? messageText(answer) : '',
        toolCalls: progress.toolCalls,
        ...(evidence.length ? { evidence } : {}),
        ...(answer?.stopReason === 'error' ? { error: answer.errorMessage ?? 'the model request failed' } : {}),
      };
    } finally {
      unsubscribeEvents();
      unsubscribeApprovals();
      await session.close();
    }
  }
}

/**
 * What a tool result shows people: its images (screenshots, `evidence show --view image`), as the
 * Grafana chat shows them inline, and `evidence show` presentations.
 */
export function presentedEvidence(result: { content?: unknown; details?: unknown }): PresentedEvidence[] {
  const evidence: PresentedEvidence[] = [];
  const details = result.details as { images?: Array<{ title?: unknown }>; presentations?: unknown } | undefined;
  const images = Array.isArray(result.content)
    ? result.content.filter((part) => part?.type === 'image' && typeof part.data === 'string')
    : [];
  images.forEach((part, index) => {
    const title = details?.images?.[index]?.title;
    evidence.push({
      view: 'image',
      title: typeof title === 'string' ? title : 'Screenshot',
      mimeType: String(part.mimeType ?? 'image/png'),
      data: part.data,
    });
  });
  const presentations = Array.isArray(details?.presentations) ? details.presentations : [];
  for (const item of presentations) {
    if (['json', 'text', 'table'].includes(item?.view)) {
      evidence.push({
        view: item.view,
        title: typeof item.title === 'string' ? item.title : 'Evidence',
        data: item.data,
      });
    }
  }
  return evidence;
}

/** Index of the last user message when its text is `text`, else -1. */
function lastPromptIndex(messages: ChatMessage[], text: string) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user') {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      return content.trim() === text.trim() ? index : -1;
    }
  }
  return -1;
}

function lastAssistantMessage(messages: ChatMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant') {
      return message;
    }
  }
  return undefined;
}

function messageText(message: AssistantMessage) {
  return message.content
    .filter((part): part is Extract<AssistantMessage['content'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}
