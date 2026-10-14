/**
 * A chat platform the assistant host talks in (Mattermost now, Webex next).
 * Threads are the unit of conversation: one assistant chat per thread.
 */
export type ChannelMessage = {
  channelId: string;
  /** The thread's root post; a post that starts a thread is its own root. */
  threadId: string;
  postId: string;
  userId: string;
  userName: string;
  text: string;
  /** A direct message to the bot. */
  direct: boolean;
  /** The message mentions the bot. */
  mentioned: boolean;
  createdAt: number;
  /** The sender's email address, only when the platform verified it (Webex; Mattermost SSO or verified email). */
  verifiedEmail?: string;
};

/** `name` is what `resolveChannel` accepts besides the ID: Mattermost `team/channel`, Webex the room title. */
export type ChannelInfo = { id: string; name: string; title: string };

export type ChannelFile = { name: string; mimeType: string; data: Uint8Array<ArrayBuffer> };

export type ThreadPost = { userId: string; userName: string; text: string; createdAt: number; fromBot: boolean };

export interface ChatChannel {
  readonly name: string;
  /** Connects and delivers every new message from other users to `onMessage`. */
  start(onMessage: (message: ChannelMessage) => void): Promise<void>;
  stop(): Promise<void>;
  /**
   * Resolves a channel name (Mattermost: `team/channel`, Webex: a room title) or ID to the ID of a channel
   * the bot can post to; fails for channels the bot is not a member of.
   */
  resolveChannel(name: string): Promise<string>;
  /** Channels the bot is a member of and can post alerts to, for choosing one in Grafana. */
  listChannels(): Promise<ChannelInfo[]>;
  /** The bot's display name, once started. */
  readonly botName: string;
  post(channelId: string, text: string, threadId?: string): Promise<{ id: string }>;
  update(postId: string, text: string): Promise<void>;
  /** Sends a direct message to a user, for example a link code that must not appear in a channel. */
  postDirect(userId: string, text: string): Promise<void>;
  /** Posts files (images) with a message. */
  postFiles(channelId: string, text: string, files: ChannelFile[], threadId?: string): Promise<{ id: string }>;
  /** Posts of a thread, oldest first. */
  thread(channelId: string, threadId: string): Promise<ThreadPost[]>;
  /** Whether Markdown tables render; otherwise tables are posted as aligned text. */
  readonly markdownTables: boolean;
  typing?(channelId: string, threadId?: string): Promise<void>;
  /** The longest message the platform accepts, as counted by `measure` (characters by default). */
  readonly maxMessageLength: number;
  /** The length of a message as the platform counts it, for example in UTF-8 bytes. */
  measure?(text: string): number;
  /** How often the platform lets a post be edited; unlimited when undefined. */
  readonly maxEdits?: number;
}
