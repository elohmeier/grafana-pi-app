import type { Context, JsonValue } from '@earendil-works/chord';
import {
  defineExtension,
  section,
  type ConversationId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import type { ToolResult } from '../domain/result';
import { WORKSPACE_TOOL_DEFINITIONS, type WorkspaceTool } from '../workspace';
import { toJson, TurnDoc, type TurnState } from './documents';

export const ASSISTANT_EXTENSION = 'grafana-assistant';

/**
 * The tools bound their own output (bash 32 KiB per stream, read 48 KiB per
 * window); the harness limit only guards against a tool that does not.
 */
const TOOL_OUTPUT_LIMITS = { maxBytes: 128 * 1024, maxLines: 8000 };

/** What the assistant's tools need from the session that runs them. */
export type AssistantToolHost = {
  /** The session's tool of this name, bound to the Grafana capabilities of the view the session is attached to. */
  tool(conversationId: ConversationId, name: string): WorkspaceTool;
  /** Commits the session filesystem after a tool call, in the tool's invocation. */
  persist(conversationId: ConversationId, api: ToolExecutionApi, context: Context): Promise<void>;
};

/**
 * The assistant as a Pi Durable extension: the fixed `read`, `write`, `edit`,
 * and `bash` tools, and the system prompt captured for the current turn.
 */
export function createAssistantExtension(host: AssistantToolHost) {
  const turnSection = (key: keyof TurnState) =>
    section(
      key,
      async (input, context) => (await input.read.snapshot(TurnDoc, input.conversationId, context))?.[key] || undefined,
      { tag: false }
    );
  return defineExtension({
    name: ASSISTANT_EXTENSION,
    tools: WORKSPACE_TOOL_DEFINITIONS.map(
      (definition): ToolRegistration => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        executionMode: definition.executionMode,
        replay: definition.replay,
        outputLimits: TOOL_OUTPUT_LIMITS,
        execute: async (args, api, context) => {
          const tool = host.tool(api.conversationId, definition.name);
          try {
            const result = await tool.execute(api.callId, args, context.abortSignal, (partial) => {
              void api.details(toJson(partial.details ?? null) as JsonValue, context).catch(() => {
                // Progress is best effort; the result carries the final details.
              });
            });
            return toExecutionResult(result);
          } finally {
            await host.persist(api.conversationId, api, context);
          }
        },
      })
    ),
    sections: [turnSection('assistant'), turnSection('workspace'), turnSection('launch'), turnSection('page')],
  });
}

function toExecutionResult(result: ToolResult): ToolExecutionResult {
  return {
    content: result.content,
    details: toJson(result.details ?? null) as JsonValue,
  };
}
