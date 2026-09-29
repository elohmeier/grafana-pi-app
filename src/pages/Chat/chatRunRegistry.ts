import type { AssistantSession } from './session/AssistantSession';

/**
 * Sessions whose run continues while no view shows them, such as during a
 * page-to-sidebar handoff. The next view with the same session ID attaches to it.
 */
const liveRuns = new Map<string, AssistantSession>();

export function storeChatRun(session: AssistantSession) {
  liveRuns.set(session.id, session);
}

export function getChatRun(id: string | undefined): AssistantSession | undefined {
  return id ? liveRuns.get(id) : undefined;
}

export function removeChatRun(id: string | undefined) {
  if (id) {
    liveRuns.delete(id);
  }
}

export function isStoredChatRun(session: AssistantSession | undefined) {
  return Boolean(session && liveRuns.get(session.id) === session);
}
