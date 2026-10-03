import type { Draft, JsonValue } from '@earendil-works/chord';
import { defineDoc, type JsonObject } from '@earendil-works/pi-durable';

/** Store a complete value after this many changes, so a reopen replays a bounded delta chain. */
const DELTAS_PER_BASE = 40;

/**
 * The session filesystem and artifacts of a chat, as last committed. The
 * in-memory SessionWorkspace is authoritative while the chat is open; it is
 * restored from here when the chat is opened.
 */
export type WorkspaceState = {
  /** `PersistedWorkspace`. */
  workspace?: JsonObject;
  artifacts?: JsonObject;
  artifactCounter?: number;
};

export const WorkspaceDoc = defineDoc<WorkspaceState>({
  kind: 'app.workspace',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({}),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= DELTAS_PER_BASE,
});

/**
 * What the system prompt says for the current turn, captured when the user
 * submitted it: the prompt with the skills selected for the input, the
 * filesystem section, and the launch and page context. Prompt sections read
 * it, so a run resumed after a reload sees the prompt it started with.
 */
export type TurnState = {
  assistant?: string;
  workspace?: string;
  launch?: string;
  page?: string;
};

export const TurnDoc = defineDoc<TurnState>({
  kind: 'app.turn',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({}),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= DELTAS_PER_BASE,
});

/** A user `!command` and its result, shown like a bash call and given to the model as a user message. */
export const SHELL_ENTRY_KIND = 'app.shell';

/** Plain JSON: drops undefined fields and other values JSON does not represent. */
export function toJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Makes `draft` equal to `next`, changing only what differs, so a commit
 * stores small Chord deltas instead of the whole value.
 */
export function syncDraft(draft: Draft<JsonObject>, next: JsonObject) {
  const target = draft as Record<string, JsonValue>;
  for (const key of Object.keys(target)) {
    if (!(key in next)) {
      delete target[key];
    }
  }
  for (const [key, value] of Object.entries(next)) {
    const current = target[key];
    if (isObject(current) && isObject(value)) {
      syncDraft(current as Draft<JsonObject>, value);
    } else if (!sameJson(current, value)) {
      target[key] = value;
    }
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
