import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PiAppThinkingLevel } from '../../../types';
import { hasPersistableMessages } from '../chatMessages';
import { isCompactionState, type CompactionState } from '../compaction';
import type { Artifact } from '../domain/artifacts';
import type { PersistedWorkspace } from '../workspace/types';
import { compactArtifacts } from './artifactStore';
import type { SessionMetadata } from './SessionRepository';

/** A chat session as stored per user and as carried in export files. */
export type StoredSession = SessionMetadata & {
  messages: AgentMessage[];
  modelId?: string;
  thinkingLevel?: PiAppThinkingLevel;
  /** Legacy Jsonnet sources from sessions created before the session filesystem; migrated on load. */
  virtualJsonnetFiles?: unknown;
  /** Legacy structured report from the retired update_report tool; migrated into /session/report.md on load. */
  investigationReport?: unknown;
  artifacts?: Record<string, Artifact>;
  artifactCounter?: number;
  workspace?: PersistedWorkspace;
  compaction?: CompactionState;
};

export const NEW_CHAT_TITLE = 'New chat';

export const CHAT_SESSION_EXPORT_KIND = 'g42-pi-app.chat-session';
const LEGACY_CHAT_SESSION_EXPORT_KINDS = ['grafana-pi-app.chat-session'];
export const CHAT_SESSION_EXPORT_SCHEMA_VERSION = 1;

export type ChatSessionExport = {
  kind: typeof CHAT_SESSION_EXPORT_KIND;
  schemaVersion: typeof CHAT_SESSION_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  pluginId: string;
  session: StoredSession;
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
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
    ? value
    : undefined;
}

export function chatSessionExportFilename(title: string) {
  const safeTitle = safeFilenamePart(title) || 'assistant-chat-session';
  return `${safeTitle}.json`;
}

export function importTitleFromFilename(filename: string) {
  const withoutExtension = filename.replace(/\.json$/i, '').replace(/[-_]+/g, ' ');
  return normalizeSessionTitle(withoutExtension);
}

export function parseChatSessionExport(value: unknown): StoredSession {
  if (!isRecord(value)) {
    throw new Error('Import file must contain a JSON object.');
  }
  if (value.kind !== CHAT_SESSION_EXPORT_KIND && !LEGACY_CHAT_SESSION_EXPORT_KINDS.includes(String(value.kind))) {
    throw new Error('Import file is not an Assistant chat session export.');
  }
  if (value.schemaVersion !== CHAT_SESSION_EXPORT_SCHEMA_VERSION) {
    throw new Error(`Unsupported chat session export version: ${String(value.schemaVersion)}`);
  }
  if (!isRecord(value.session)) {
    throw new Error('Import file is missing a session object.');
  }

  const rawMessages = value.session.messages;
  if (!Array.isArray(rawMessages) || !rawMessages.every(isAgentMessageLike)) {
    throw new Error('Import file session.messages must be an array of chat messages.');
  }

  const messages = rawMessages as AgentMessage[];
  if (!hasPersistableMessages(messages)) {
    throw new Error('Import file does not contain any user or assistant messages.');
  }

  return {
    id: typeof value.session.id === 'string' ? value.session.id : '',
    title: normalizeSessionTitle(value.session.title),
    createdAt: normalizeDateString(value.session.createdAt),
    updatedAt: normalizeDateString(value.session.updatedAt),
    modelId: typeof value.session.modelId === 'string' ? value.session.modelId : undefined,
    thinkingLevel: parseStoredThinkingLevel(value.session.thinkingLevel),
    messages,
    virtualJsonnetFiles: isRecord(value.session.virtualJsonnetFiles) ? value.session.virtualJsonnetFiles : undefined,
    investigationReport: value.session.investigationReport,
    artifacts: parseArtifacts(value.session.artifacts),
    artifactCounter:
      typeof value.session.artifactCounter === 'number' && Number.isFinite(value.session.artifactCounter)
        ? Math.max(0, Math.floor(value.session.artifactCounter))
        : undefined,
    workspace: isRecord(value.session.workspace) ? (value.session.workspace as PersistedWorkspace) : undefined,
    compaction: isCompactionState(value.session.compaction) ? value.session.compaction : undefined,
  };
}

function parseArtifacts(value: unknown): Record<string, Artifact> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Import file session.artifacts must be an object when present.');
  }

  const artifacts: Record<string, Artifact> = {};
  for (const [key, artifact] of Object.entries(value)) {
    if (!isRecord(artifact)) {
      throw new Error(`Imported artifact ${key} must be an object.`);
    }

    const id = typeof artifact.id === 'string' && artifact.id ? artifact.id : key;
    const kind = parseArtifactKind(artifact.kind);
    const title = typeof artifact.title === 'string' && artifact.title ? artifact.title : id;
    const toolName = typeof artifact.toolName === 'string' && artifact.toolName ? artifact.toolName : 'tool';
    const summary = typeof artifact.summary === 'string' ? artifact.summary : `${toolName} result stored as artifact.`;

    artifacts[id] = {
      id,
      kind,
      title,
      toolName,
      createdAt: normalizeDateString(artifact.createdAt),
      bytes: typeof artifact.bytes === 'number' && Number.isFinite(artifact.bytes) ? artifact.bytes : 0,
      summary,
      data: artifact.data,
      preview: parseArtifactPreview(artifact.preview),
      mimeType: typeof artifact.mimeType === 'string' ? artifact.mimeType : undefined,
      toolDetails: artifact.toolDetails,
    };
  }

  return compactArtifacts(artifacts);
}

function parseArtifactKind(value: unknown): Artifact['kind'] {
  return value === 'json' || value === 'table' || value === 'dashboard' || value === 'image' || value === 'text'
    ? value
    : 'json';
}

function parseArtifactPreview(value: unknown): Artifact['preview'] {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type === 'text' && typeof value.text === 'string') {
    return {
      type: 'text',
      text: value.text,
      truncated: value.truncated === true,
    };
  }
  if (value.type === 'json') {
    return {
      type: 'json',
      data: value.data,
      truncated: value.truncated === true,
    };
  }
  if (value.type === 'image' && typeof value.mimeType === 'string' && typeof value.data === 'string') {
    return {
      type: 'image',
      mimeType: value.mimeType,
      data: value.data,
    };
  }
  return undefined;
}

function isAgentMessageLike(value: unknown): value is AgentMessage {
  return isRecord(value) && typeof value.role === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSessionTitle(value: unknown) {
  return typeof value === 'string' ? generateTitle(value) : '';
}

function normalizeDateString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : new Date().toISOString();
}

function safeFilenamePart(value: string) {
  return value
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .toLowerCase();
}
