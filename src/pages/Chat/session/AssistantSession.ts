import { ApprovalChannel } from './ApprovalChannel';
import {
  Agent,
  type AgentMessage,
  type AgentEvent,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import { convertChatMessagesToLlm } from '../chatMessages';
import {
  ContextCompactor,
  estimateTextTokens,
  buildSummarizerPrompt,
  SUMMARIZER_SYSTEM_PROMPT,
  type CompactionState,
  type CompactionEvent,
} from '../compaction';
import { createSessionWorkspaceToolkit, type SessionWorkspaceToolkitOptions, SessionWorkspace } from '../workspace';
import { createCatalogMount } from '../workspace/mounts';
import type { DashboardBroker } from '../workspace/broker';
import type { GeneratedMount, PersistedWorkspace } from '../workspace/types';
import type { Artifact } from '../domain/artifacts';
import { ArtifactStore } from './artifactStore';

export type SessionSnapshot = {
  messages: AgentMessage[];
  modelId?: string;
  thinkingLevel?: Agent['state']['thinkingLevel'];
  workspace: PersistedWorkspace;
  artifacts: Record<string, Artifact>;
  artifactCounter: number;
  compaction?: CompactionState;
};

/** Owns a conversation independently of its React view. Sidebar handoffs share this instance. */
export class AssistantSession {
  agent?: Agent;
  readonly approvals = new ApprovalChannel();
  readonly artifacts = new ArtifactStore();
  compaction: { state?: CompactionState } = {};
  persist?: (snapshot: SessionSnapshot) => Promise<void>;
  persistenceError?: string;
  private saves: Promise<void> = Promise.resolve();
  private listeners = new Set<(event: AgentEvent, agent: Agent) => void>();
  private unsubscribeAgent?: () => void;
  private catalog?: { broker: DashboardBroker; mount: GeneratedMount };

  constructor(readonly workspace = new SessionWorkspace()) {}

  subscribe(listener: (event: AgentEvent, agent: Agent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(messages = this.agent?.state.messages ?? []): SessionSnapshot {
    return {
      messages,
      modelId: this.agent?.state.model.id,
      thinkingLevel: this.agent?.state.thinkingLevel,
      workspace: this.workspace.serialize(),
      artifacts: this.artifacts.snapshot(),
      artifactCounter: this.artifacts.counter,
      compaction: this.compaction.state,
    };
  }

  save(messages = this.agent?.state.messages ?? []) {
    const snapshot = this.snapshot(messages);
    const persist = this.persist;
    const save = this.saves.then(async () => {
      await persist?.(snapshot);
      this.persistenceError = undefined;
    });
    this.saves = save.catch((error) => {
      this.persistenceError = error instanceof Error ? error.message : String(error);
    });
    return save;
  }

  toolkit(options: SessionWorkspaceToolkitOptions) {
    const dashboards = options.broker.dashboards;
    if (dashboards && this.catalog?.broker !== dashboards) {
      this.catalog = { broker: dashboards, mount: createCatalogMount(dashboards) };
    }
    return createSessionWorkspaceToolkit({ ...options, catalogMount: this.catalog?.mount });
  }

  createAgent(options: {
    messages: AgentMessage[];
    systemPrompt: string;
    tools: AgentTool[];
    model: Agent['state']['model'];
    thinkingLevel: Agent['state']['thinkingLevel'];
    streamFn: StreamFn;
    onCompaction?: (event: CompactionEvent) => void;
  }) {
    const holder = this.compaction;
    let agent: Agent;
    const compactor = new ContextCompactor({
      initialState: holder.state,
      getBudget: () => ({
        contextWindow: agent.state.model.contextWindow,
        maxOutputTokens: agent.state.model.maxTokens,
        fixedTokens: estimateTextTokens(
          agent.state.systemPrompt +
            JSON.stringify(
              agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
            )
        ),
      }),
      summarize: (input, signal) => summarizeWithModel(options.streamFn, agent.state.model, input, signal),
      onStateChange: (state) => {
        holder.state = state;
      },
      onEvent: options.onCompaction,
    });
    agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        messages: options.messages,
        tools: options.tools,
      },
      convertToLlm: convertChatMessagesToLlm,
      transformContext: compactor.transform,
      streamFn: options.streamFn,
    });
    this.unsubscribeAgent?.();
    this.agent = agent;
    this.unsubscribeAgent = agent.subscribe(async (event) => {
      if (event.type === 'agent_end') {
        try {
          await this.save(event.messages);
        } catch {
          /* Exposed as persistenceError for the host. */
        }
      }
      for (const listener of this.listeners) {
        listener(event, agent);
      }
    });
    return agent;
  }
}

async function summarizeWithModel(
  streamFn: StreamFn,
  model: Agent['state']['model'],
  input: { previousSummary?: string; transcript: string },
  signal?: AbortSignal
) {
  const stream = await streamFn(
    model,
    {
      systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildSummarizerPrompt(input), timestamp: Date.now() }],
    },
    { maxTokens: Math.min(4096, model.maxTokens || 4096), signal }
  );
  const message = await stream.result();
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    throw new Error(message.errorMessage || `summarization ${message.stopReason}`);
  }
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}
