import { analysisPrompt, decideDelivery, firingFingerprints, formatAlertMessage, type GrafanaWebhook } from './alerts';
import { createSessionId } from '../pages/Chat/session/chatIdentity';
import type { AssistantAnswer, AssistantRunProgress, ChatRef, PresentedEvidence } from './assistant';
import type { ChannelFile, ChannelMessage, ChatChannel } from './channel';
import type { IdentityService } from './identity';
import type { Metrics } from './metrics';
import type { HostStore } from './store';

export type Assistant = {
  ask(
    conversation: string,
    chat: ChatRef,
    text: string,
    onProgress?: (progress: AssistantRunProgress) => void,
    options?: { resume?: boolean }
  ): Promise<AssistantAnswer>;
  /** Stops the conversation's run in progress; false when none runs. */
  stop?(conversation: string): boolean;
  /** A share token for the chat; with it, answers link to a copy of the chat in Grafana. */
  share?(chatId: string): Promise<string>;
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
  /** Runs pending for longer are not resumed when the host starts (default 30 minutes). */
  recoverMaxAgeMs?: number;
  /** Minimum time between progress edits of the placeholder post. */
  progressIntervalMs?: number;
  /** Screenshots of the panels a notification links to; posted in a new alert thread without the model. */
  alertPanels?: (payload: GrafanaWebhook) => Promise<Array<{ title: string; file: ChannelFile }>>;
  metrics?: Metrics;
  /** Chat accounts linked to Grafana users (docs/identity.md). */
  identity?: {
    service: Pick<IdentityService, 'resolve' | 'createCode' | 'unlink'>;
    /** Only linked users may ask. */
    require: boolean;
    /** The Grafana URL that confirms a link code. */
    linkUrl: (code: string) => string;
  };
  /** The Grafana URL that copies a shared chat into the user's chats and opens it. */
  sharedChatUrl?: (token: string) => string;
};

const WORKING = '⏳ Looking into it…';
/** Updates of an episode within this time edit the previous update post. */
const UPDATE_COALESCE_MS = 10 * 60_000;
/** A new episode of an alert rule investigated within this time is not investigated again automatically. */
const ANALYSIS_COALESCE_MS = 10 * 60_000;

/**
 * Connects a chat channel to the assistant: posts alert notifications as
 * threads, asks the assistant to investigate them, and answers mentions and
 * direct messages in the thread's own chat.
 */
export class Responder {
  private alertQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ResponderOptions) {}

  /** Whether this responder posts alert notifications (it has an alert channel). */
  get handlesAlerts() {
    return Boolean(this.options.alertChannelId);
  }

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
    if (/^(stop|cancel)[.!]?$/i.test(message.text.trim()) && this.options.assistant.stop) {
      const stopped = this.options.assistant.stop(key);
      if (!stopped) {
        await channel.post(message.channelId, 'Nothing is running in this thread.', message.threadId);
      }
      return;
    }
    const identity = this.options.identity;
    const command = message.text.trim().toLowerCase().replace(/[.!]$/, '');
    if (identity && (command === 'link' || command === 'unlink' || command === 'whoami')) {
      await this.identityCommand(command, message);
      return;
    }
    let asker = `@${message.userName}`;
    if (identity) {
      const link = await identity.service
        .resolve(channel.name, message.userId, message.userName, message.verifiedEmail)
        .catch((error) => {
          this.options.log?.(
            `identity lookup for ${message.userName} failed: ${error instanceof Error ? error.message : error}`
          );
          return undefined;
        });
      if (link) {
        asker = `@${message.userName} (Grafana user ${link.userLogin})`;
      } else if (identity.require) {
        await this.sendLinkCode(message, true);
        return;
      }
    }
    const record = store.thread(key);
    // Thread posts since the last answer that did not mention the bot are context for this one.
    let context = '';
    if (message.threadId !== message.postId) {
      const posts = await channel.thread(message.channelId, message.threadId).catch(() => []);
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
    await this.answer(message.channelId, message.threadId, `${context}${asker}: ${message.text}`);
  }

  private async identityCommand(command: 'link' | 'unlink' | 'whoami', message: ChannelMessage): Promise<void> {
    const { channel, identity } = this.options;
    const reply = async (text: string) => {
      await channel.post(message.channelId, text, message.threadId);
    };
    if (command === 'link') {
      return this.sendLinkCode(message, false);
    }
    if (command === 'unlink') {
      await identity!.service.unlink(channel.name, message.userId);
      return reply(`Your ${platformName(channel.name)} account is no longer linked to a Grafana user.`);
    }
    const link = await identity!.service.resolve(channel.name, message.userId, message.userName, message.verifiedEmail);
    return reply(
      link
        ? `Your ${platformName(channel.name)} account is linked to Grafana user **${link.userLogin}** (${link.source === 'email' ? 'by your verified email address' : 'confirmed in Grafana'}, ${(link.linkedAt ?? '').slice(0, 10)}).`
        : `Your ${platformName(channel.name)} account is not linked to a Grafana user. Write \`link\` to link it.`
    );
  }

  /** Sends a one-time link code by direct message: it must not be opened by anyone else. */
  private async sendLinkCode(message: ChannelMessage, required: boolean) {
    const { channel, identity } = this.options;
    const code = await identity!.service.createCode(channel.name, message.userId, message.userName);
    const until = new Date(code.expiresAt).toISOString().slice(11, 16);
    await channel.postDirect(
      message.userId,
      [
        required
          ? 'To ask me, link your account to your Grafana user first.'
          : 'Link your account to your Grafana user:',
        `[Link ${platformName(channel.name)} account ${message.userName} in Grafana](${identity!.linkUrl(code.code)}) (until ${until} UTC). Open it yourself; it links whoever confirms it.`,
      ].join('\n')
    );
    if (!message.direct) {
      await channel.post(
        message.channelId,
        required
          ? `@${message.userName}, please link your Grafana account first: I sent you a direct message.`
          : 'I sent you a direct message with the link.',
        message.threadId
      );
    }
  }

  /** A Grafana webhook notification; the alert message is posted before, and independent of, the model. */
  handleAlert(payload: GrafanaWebhook) {
    const previous = this.alertQueues.get(payload.groupKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.deliverAlert(payload));
    this.alertQueues.set(payload.groupKey, next);
    // The caller handles a rejection; the cleanup must not raise it again.
    void next
      .catch(() => undefined)
      .finally(() => {
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
    // Each platform has its own threads for a notification group.
    const episodeKey = `${channel.name}:${payload.groupKey}`;
    const delivery = decideDelivery(payload, store.episode(episodeKey));
    this.options.metrics?.inc(
      'assistant_host_alert_notifications_total',
      'Grafana notifications received, by what they did.',
      {
        action: delivery.action,
      }
    );
    if (delivery.action === 'skip') {
      return { action: 'skip' as const };
    }
    const now = Date.now();
    if (delivery.action === 'open') {
      const post = await channel.post(alertChannelId, formatAlertMessage(payload, 'open'));
      await store.setEpisode(episodeKey, {
        channelId: alertChannelId,
        threadId: post.id,
        status: 'firing',
        fingerprints: firingFingerprints(payload),
        startedAt: now,
        updatedAt: now,
      });
      void this.postAlertPanels(payload, alertChannelId, post.id);
      const alertname = payload.commonLabels?.alertname ?? payload.groupLabels?.alertname ?? payload.groupKey;
      const previous = store.lastAnalysis(`${channel.name}:${alertname}`);
      if (previous !== undefined && now - previous < ANALYSIS_COALESCE_MS) {
        // During an alert storm, one investigation per alert rule; people can ask for more.
        await channel.post(
          alertChannelId,
          `Not investigated automatically: **${alertname}** was investigated ${Math.round((now - previous) / 60_000)} min ago. Mention me in this thread to investigate it.`,
          post.id
        );
        return { action: 'open' as const, threadId: post.id };
      }
      await store.setLastAnalysis(`${channel.name}:${alertname}`, now);
      // The analysis follows in the thread; a model failure does not affect the notification.
      void this.answer(alertChannelId, post.id, analysisPrompt(payload)).catch((error) =>
        this.options.log?.(`alert analysis failed: ${message(error)}`)
      );
      return { action: 'open' as const, threadId: post.id };
    }
    const { episode } = delivery;
    const text = formatAlertMessage(payload, delivery.action);
    let update = { updatePostId: episode.updatePostId, updatePostedAt: episode.updatePostedAt };
    if (
      delivery.action === 'update' &&
      episode.updatePostId &&
      episode.updatePostedAt !== undefined &&
      now - episode.updatePostedAt < UPDATE_COALESCE_MS
    ) {
      // A flapping group edits its last update instead of adding a post per change.
      await channel.update(
        episode.updatePostId,
        `${text}\n_(updated ${new Date(now).toISOString().slice(11, 16)} UTC)_`
      );
    } else {
      const post = await channel.post(episode.channelId, text, episode.threadId);
      if (delivery.action === 'update') {
        update = { updatePostId: post.id, updatePostedAt: now };
      }
    }
    await store.setEpisode(episodeKey, {
      ...episode,
      ...update,
      status: delivery.action === 'resolve' ? 'resolved' : 'firing',
      fingerprints: delivery.action === 'resolve' ? [] : firingFingerprints(payload),
      updatedAt: now,
    });
    return { action: delivery.action, threadId: episode.threadId };
  }

  /** Answers runs that were pending when the host stopped: the harness continues each one. */
  async recover() {
    const { store, channel } = this.options;
    const maxAge = this.options.recoverMaxAgeMs ?? 30 * 60_000;
    // This platform's threads only; each platform has its own responder.
    const pending = store
      .threads()
      .filter(([key, record]) => key.startsWith(`${channel.name}:`) && record.pending && record.chatId);
    await Promise.all(
      pending.map(async ([key, record]) => {
        const run = record.pending!;
        if (Date.now() - run.startedAt > maxAge) {
          // An old question is no longer worth answering, and its thread may be gone.
          this.options.log?.(
            `dropping the run in thread ${run.threadId} from ${new Date(run.startedAt).toISOString()}`
          );
          await store.setThread(key, { pending: undefined });
          return;
        }
        this.options.log?.(`resuming the run in thread ${run.threadId}`);
        return this.answer(run.channelId, run.threadId, run.prompt, {
          postId: run.postId,
          resume: true,
          startedAt: run.startedAt,
        }).catch((error) => this.options.log?.(`resuming thread ${run.threadId} failed: ${message(error)}`));
      })
    );
  }

  private async answer(
    channelId: string,
    threadId: string,
    prompt: string,
    resumed?: { postId: string; resume: true; startedAt: number }
  ) {
    const { channel, store, assistant } = this.options;
    const key = threadKey(channel.name, channelId, threadId);
    const record = store.thread(key);
    const chat: ChatRef = { id: record?.chatId ?? createSessionId(), stored: record?.chatStored ?? false };
    const placeholder = resumed ? { id: resumed.postId } : await channel.post(channelId, WORKING, threadId);
    await store.setThread(key, {
      chatId: chat.id,
      // A resumed run keeps its start, so it ages out after restarts.
      pending: { channelId, threadId, postId: placeholder.id, prompt, startedAt: resumed?.startedAt ?? Date.now() },
    });
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
      // A new chat may already be stored when the host stopped during its first run.
      const ref = resumed ? { ...chat, stored: true } : chat;
      result = await assistant.ask(key, ref, prompt, onProgress, { resume: Boolean(resumed) });
    } catch (error) {
      if (resumed && !chat.stored) {
        // It was not: start the chat again.
        result = await assistant
          .ask(key, chat, prompt, onProgress)
          .catch((retry) => ({ chatId: '', text: '', toolCalls: 0, error: message(retry) }));
      } else {
        result = { chatId: '', text: '', toolCalls: 0, error: message(error) };
      }
    }
    await editing;
    this.options.metrics?.inc('assistant_host_runs_total', 'Assistant runs finished, by outcome.', {
      outcome: result.error ? 'failed' : 'answered',
    });
    await store.setThread(key, {
      pending: undefined,
      ...(result.chatId ? { chatStored: true, lastAnswerAt: Date.now() } : {}),
    });
    const answerText = result.error
      ? `⚠️ The assistant could not answer: ${result.error}${result.text ? `\n\n${result.text}` : ''}`
      : result.text || '⚠️ The assistant finished without an answer.';
    const link = result.chatId ? await this.chatLink(key, result) : '';
    const text = link ? `${answerText}\n\n${link}` : answerText;
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

  /**
   * A link to continue the chat in Grafana as oneself: it copies the chat, including staged
   * changes, into the user's chats, where `workspace apply` reviews and writes as that user.
   */
  private async chatLink(key: string, result: AssistantAnswer) {
    const { assistant, store, sharedChatUrl } = this.options;
    if (!assistant.share || !sharedChatUrl) {
      return '';
    }
    try {
      let token = store.thread(key)?.shareToken;
      if (!token) {
        token = await assistant.share(result.chatId);
        await store.setThread(key, { shareToken: token });
      }
      const url = sharedChatUrl(token);
      const staged = result.stagedChanges ?? 0;
      return staged > 0
        ? `✏️ [Review and apply the ${staged === 1 ? 'staged change' : `${staged} staged changes`} in Grafana](${url})`
        : `[Continue in Grafana](${url})`;
    } catch (error) {
      this.options.log?.(`sharing chat ${result.chatId} failed: ${message(error)}`);
      return '';
    }
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
        for (const part of split(formatEvidence(item, channel.markdownTables), channel.maxMessageLength)) {
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
export function formatEvidence(item: Exclude<PresentedEvidence, { view: 'image' }>, markdownTables = true) {
  const title = `**${item.title}**`;
  if (item.view === 'table' && Array.isArray(item.data) && !markdownTables) {
    return `${title}\n\`\`\`\n${alignedTable(item.data as Array<Record<string, unknown>>)}\n\`\`\``;
  }
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

/** A table as fixed-width text, for platforms without Markdown tables. */
function alignedTable(rows: Array<Record<string, unknown>>) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const text = (value: unknown) =>
    (value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
    ).replace(/\n/g, ' ');
  const cells = [columns, ...rows.map((row) => columns.map((column) => text(row[column])))];
  const widths = columns.map((_, index) => Math.max(...cells.map((line) => line[index].length)));
  return cells
    .map((line) =>
      line
        .map((cell, index) => cell.padEnd(widths[index]))
        .join('  ')
        .trimEnd()
    )
    .join('\n');
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

function platformName(name: string) {
  return name === 'webex' ? 'Webex' : name === 'mattermost' ? 'Mattermost' : name;
}
