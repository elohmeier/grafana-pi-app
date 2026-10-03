import { analysisPrompt, decideDelivery, firingFingerprints, formatAlertMessage, type GrafanaWebhook } from './alerts';
import type { AssistantAnswer, AssistantRunProgress, PresentedEvidence } from './assistant';
import type { ChannelFile, ChannelMessage, ChatChannel } from './channel';
import type { HostStore } from './store';

export type Assistant = {
  ask(
    conversation: string,
    chatId: string | undefined,
    text: string,
    onProgress?: (progress: AssistantRunProgress) => void
  ): Promise<AssistantAnswer>;
};

export type ResponderOptions = {
  channel: ChatChannel;
  assistant: Assistant;
  store: HostStore;
  /** Channel the alert notifications go to. */
  alertChannelId?: string;
  /** Channels where mentions are answered, in addition to the alert channel. */
  channelIds: string[];
  allowDirect: boolean;
  log?: (message: string) => void;
  /** Minimum time between progress edits of the placeholder post. */
  progressIntervalMs?: number;
  /** Screenshots of the panels a notification links to; posted in a new alert thread without the model. */
  alertPanels?: (payload: GrafanaWebhook) => Promise<Array<{ title: string; file: ChannelFile }>>;
};

const WORKING = ':hourglass_flowing_sand: Looking into it…';

/**
 * Connects a chat channel to the assistant: posts alert notifications as
 * threads, asks the assistant to investigate them, and answers mentions and
 * direct messages in the thread's own chat.
 */
export class Responder {
  private alertQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ResponderOptions) {}

  /** A message from the channel; answered when it is direct or mentions the bot in an allowed channel. */
  async handleMessage(message: ChannelMessage) {
    const { channel, store } = this.options;
    const allowed = message.direct
      ? this.options.allowDirect
      : message.mentioned && this.allowedChannels().includes(message.channelId);
    if (!allowed || !message.text) {
      return;
    }
    const key = threadKey(channel.name, message.channelId, message.threadId);
    const record = store.thread(key);
    // Thread posts since the last answer that did not mention the bot are context for this one.
    let context = '';
    if (message.threadId !== message.postId) {
      const posts = await channel.thread(message.threadId).catch(() => []);
      const since = record?.lastAnswerAt ?? 0;
      const earlier = posts.filter(
        (post) => !post.fromBot && post.createdAt > since && post.createdAt < message.createdAt && post.text.trim()
      );
      if (!record?.chatId) {
        // A thread the assistant has not answered in yet: its root post is context too.
        const root = posts[0];
        if (root && !earlier.includes(root)) {
          earlier.unshift(root);
        }
      }
      if (earlier.length) {
        context = `Earlier in the thread:\n${earlier.map((post) => `- @${post.userName}: ${post.text}`).join('\n')}\n\n`;
      }
    }
    await this.answer(message.channelId, message.threadId, `${context}@${message.userName}: ${message.text}`);
  }

  /** A Grafana webhook notification; the alert message is posted before, and independent of, the model. */
  handleAlert(payload: GrafanaWebhook) {
    const previous = this.alertQueues.get(payload.groupKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.deliverAlert(payload));
    this.alertQueues.set(payload.groupKey, next);
    void next.finally(() => {
      if (this.alertQueues.get(payload.groupKey) === next) {
        this.alertQueues.delete(payload.groupKey);
      }
    });
    return next;
  }

  private async deliverAlert(payload: GrafanaWebhook) {
    const { channel, store, alertChannelId } = this.options;
    if (!alertChannelId) {
      throw new Error('no alert channel is configured');
    }
    const delivery = decideDelivery(payload, store.episode(payload.groupKey));
    if (delivery.action === 'skip') {
      return { action: 'skip' as const };
    }
    const now = Date.now();
    if (delivery.action === 'open') {
      const post = await channel.post(alertChannelId, formatAlertMessage(payload, 'open'));
      await store.setEpisode(payload.groupKey, {
        channelId: alertChannelId,
        threadId: post.id,
        status: 'firing',
        fingerprints: firingFingerprints(payload),
        startedAt: now,
        updatedAt: now,
      });
      void this.postAlertPanels(payload, alertChannelId, post.id);
      // The analysis follows in the thread; a model failure does not affect the notification.
      void this.answer(alertChannelId, post.id, analysisPrompt(payload)).catch((error) =>
        this.options.log?.(`alert analysis failed: ${message(error)}`)
      );
      return { action: 'open' as const, threadId: post.id };
    }
    const { episode } = delivery;
    await channel.post(episode.channelId, formatAlertMessage(payload, delivery.action), episode.threadId);
    await store.setEpisode(payload.groupKey, {
      ...episode,
      status: delivery.action === 'resolve' ? 'resolved' : 'firing',
      fingerprints: delivery.action === 'resolve' ? [] : firingFingerprints(payload),
      updatedAt: now,
    });
    return { action: delivery.action, threadId: episode.threadId };
  }

  private async answer(channelId: string, threadId: string, prompt: string) {
    const { channel, store, assistant } = this.options;
    const key = threadKey(channel.name, channelId, threadId);
    const placeholder = await channel.post(channelId, WORKING, threadId);
    void channel.typing?.(channelId, threadId).catch(() => undefined);
    let lastEdit = 0;
    let editing: Promise<void> = Promise.resolve();
    const onProgress = (progress: AssistantRunProgress) => {
      const now = Date.now();
      if (now - lastEdit < (this.options.progressIntervalMs ?? 4000)) {
        return;
      }
      lastEdit = now;
      const command = progress.lastCommand ? `: \`${truncate(progress.lastCommand, 120).replace(/`/g, "'")}\`` : '';
      editing = editing.then(() =>
        channel.update(placeholder.id, `${WORKING} (${progress.toolCalls} steps${command})`).catch(() => undefined)
      );
    };
    let result: AssistantAnswer;
    try {
      result = await assistant.ask(key, store.thread(key)?.chatId, prompt, onProgress);
    } catch (error) {
      result = { chatId: '', text: '', toolCalls: 0, error: message(error) };
    }
    await editing;
    if (result.chatId) {
      await store.setThread(key, { chatId: result.chatId, lastAnswerAt: Date.now() });
    }
    const text = result.error
      ? `:warning: The assistant could not answer: ${result.error}${result.text ? `\n\n${result.text}` : ''}`
      : result.text || ':warning: The assistant finished without an answer.';
    const [first, ...rest] = split(text, channel.maxMessageLength);
    await channel.update(placeholder.id, first);
    for (const part of rest) {
      await channel.post(channelId, part, threadId);
    }
    await this.postEvidence(channelId, threadId, result.evidence ?? []);
    if (result.chatId) {
      await store.setThread(key, { lastAnswerAt: Date.now() });
    }
    return result;
  }

  /** Evidence the assistant presented: images as files, the rest as Markdown. */
  private async postEvidence(channelId: string, threadId: string, evidence: PresentedEvidence[]) {
    const { channel } = this.options;
    const images = evidence.filter((item) => item.view === 'image');
    // Mattermost attaches at most 10 files to a post.
    for (let index = 0; index < images.length; index += 10) {
      const batch = images.slice(index, index + 10);
      await channel.postFiles(
        channelId,
        batch.map((image) => `**${image.title}**`).join(' · '),
        batch.map((image, i) => ({
          name: `${slug(image.title) || `image-${index + i + 1}`}.${image.mimeType.split('/')[1] ?? 'png'}`,
          mimeType: image.mimeType,
          data: Uint8Array.from(Buffer.from(String(image.data), 'base64')),
        })),
        threadId
      );
    }
    for (const item of evidence) {
      if (item.view !== 'image') {
        for (const part of split(formatEvidence(item), channel.maxMessageLength)) {
          await channel.post(channelId, part, threadId);
        }
      }
    }
  }

  private async postAlertPanels(payload: GrafanaWebhook, channelId: string, threadId: string) {
    if (!this.options.alertPanels) {
      return;
    }
    try {
      const panels = await this.options.alertPanels(payload);
      if (panels.length) {
        await this.options.channel.postFiles(
          channelId,
          panels.map((panel) => `**${panel.title}**`).join(' · '),
          panels.map((panel) => panel.file),
          threadId
        );
      }
    } catch (error) {
      this.options.log?.(`alert panel screenshot failed: ${message(error)}`);
    }
  }

  private allowedChannels() {
    return [...this.options.channelIds, ...(this.options.alertChannelId ? [this.options.alertChannelId] : [])];
  }
}

export function threadKey(platform: string, channelId: string, threadId: string) {
  return `${platform}:${channelId}:${threadId}`;
}

/** Tables as Markdown tables, JSON and text as code blocks. */
export function formatEvidence(item: Exclude<PresentedEvidence, { view: 'image' }>) {
  const title = `**${item.title}**`;
  if (item.view === 'table' && Array.isArray(item.data)) {
    const rows = item.data as Array<Record<string, unknown>>;
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const cell = (value: unknown) =>
      (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value))
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ');
    return [
      title,
      '',
      `| ${columns.map(cell).join(' | ')} |`,
      `|${columns.map(() => ' --- ').join('|')}|`,
      ...rows.map((row) => `| ${columns.map((column) => cell(row[column])).join(' | ')} |`),
    ].join('\n');
  }
  const body = item.view === 'text' ? String(item.data) : JSON.stringify(item.data, null, 2);
  return `${title}\n\`\`\`${item.view === 'json' ? 'json' : ''}\n${body}\n\`\`\``;
}

function slug(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** Splits at line breaks where possible. */
export function split(text: string, max: number) {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n', max);
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  parts.push(rest);
  return parts;
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
