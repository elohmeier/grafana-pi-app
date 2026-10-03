import type { EntryRecord } from '@earendil-works/pi-durable';
import type { PiAppThinkingLevel } from '../../../types';
import type { WorkspaceState } from '../durable/documents';

export const NEW_CHAT_TITLE = 'New chat';

export const CHAT_EXPORT_KIND = 'g42-pi-app.chat';
export const CHAT_EXPORT_SCHEMA_VERSION = 2;

/** A chat as downloaded for inspection: its complete transcript and session filesystem. */
export type ChatExport = {
  kind: typeof CHAT_EXPORT_KIND;
  schemaVersion: typeof CHAT_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  pluginId: string;
  chat: { id: string; title: string };
  /** Every transcript entry in order, including those summarized by compaction. */
  entries: EntryRecord[];
  workspace: WorkspaceState;
};

export function createSessionId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  }

  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function generateTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length > 56 ? `${normalized.slice(0, 53)}...` : normalized;
}

export function parseStoredThinkingLevel(value: unknown): PiAppThinkingLevel | undefined {
  return value === 'off' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : undefined;
}

export function chatExportFilename(title: string) {
  const safeTitle = safeFilenamePart(title) || 'assistant-chat';
  return `${safeTitle}.json`;
}

function safeFilenamePart(value: string) {
  return value
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .toLowerCase();
}
