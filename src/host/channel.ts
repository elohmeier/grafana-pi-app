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

export type ChannelFile = { name: string; mimeType: string; data: Uint8Array<ArrayBuffer> };

export type ThreadPost = { userId: string; userName: string; text: string; createdAt: number; fromBot: boolean };

export interface ChatChannel {
  readonly name: string;
  /** Connects and delivers every new message from other users to `onMessage`. */
  start(onMessage: (message: ChannelMessage) => void): Promise<void>;
  stop(): Promise<void>;
  /** Resolves a configured channel name (Mattermost: `team/channel`) to its ID. */
  resolveChannel(name: string): Promise<string>;
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
  /** The longest message the platform accepts. */
  readonly maxMessageLength: number;
}
