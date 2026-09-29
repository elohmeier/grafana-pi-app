import { ApprovalChannel } from './ApprovalChannel';
import {
  Agent,
  type AgentMessage,
  type AgentEvent,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import { createInitialSystemMessage, normalizeContext, toToolDeclaration } from '@earendil-works/pi-ai';
import type { DashboardMutationAPI } from '@grafana/data';
import type { PiAppThinkingLevel } from '../../../types';
import {
  conversationMessages,
  convertChatMessagesToLlm,
  createUserShellMessage,
  hasPersistableMessages,
} from '../chatMessages';
import {
  ContextCompactor,
  estimateTextTokens,
  buildSummarizerPrompt,
  isCompactionState,
  SUMMARIZER_SYSTEM_PROMPT,
  SUMMARY_MAX_OUTPUT_TOKENS,
  type CompactionState,
  type CompactionEvent,
  type SummarizerInput,
} from '../compaction';
import { renderDashboardAssistantContextBlock, type DashboardAssistantLaunch } from '../dashboardLaunch';
import { renderExternalAssistantContextBlock, type ExternalAssistantLaunch } from '../externalAssistantLaunch';
import {
  renderAssistantSidebarPageContextBlock,
  sidebarPageContextSkillHints,
  type AssistantSidebarPageContextSnapshot,
} from '../sidebarPageContext';
import { renderGrafanaSystemPrompt, selectGrafanaSkills, type GrafanaSkill } from '../skills';
import { createInitialRunStatus, reduceChatRunStatus, withRunPhase, type ChatRunStatus } from '../streamingStatus';
import type { PromptTelemetryContext } from '../telemetry';
import { createSessionWorkspaceToolkit, type SessionWorkspaceToolkitOptions, SessionWorkspace } from '../workspace';
import type { DashboardBroker, WorkspaceBroker } from '../workspace/broker';
import { migrateLegacyInvestigationReport, migrateLegacyJsonnetFiles } from '../workspace/migration';
import { createDashboardCatalog, type DashboardCatalog } from '../workspace/mounts';
import type { PythonRunner } from '../workspace/python/pythonCommand';
import type { WorkspaceBashResult } from '../workspace/shell';
import type { PersistedWorkspace } from '../workspace/types';
import type { Artifact } from '../domain/artifacts';
import { ArtifactStore } from './artifactStore';
import {
  createSessionId,
  generateTitle,
  NEW_CHAT_TITLE,
  parseStoredThinkingLevel,
  type StoredSession,
} from './sessionRecord';
import { reduceToolRuns, type ToolRunState } from './toolRuns';

export type SessionSnapshot = {
  messages: AgentMessage[];
  modelId?: string;
  thinkingLevel?: Agent['state']['thinkingLevel'];
  workspace: PersistedWorkspace;
  artifacts: Record<string, Artifact>;
  artifactCounter: number;
  compaction?: CompactionState;
};

/** Context a chat was opened with. It reaches the model with the first prompt and is then dropped. */
export type SessionLaunch = {
  dashboard?: DashboardAssistantLaunch;
  external?: ExternalAssistantLaunch;
};

/** Capabilities of the place the session currently runs in, resolved again for every prompt and shell command. */
export type SessionEnvironment = {
  streamFn: StreamFn;
  model: Agent['state']['model'];
  thinkingLevel: Agent['state']['thinkingLevel'];
  broker: WorkspaceBroker;
  skills: readonly GrafanaSkill[];
  python?: PythonRunner;
  /** Present only when the open dashboard accepts live edits. */
  getDashboardMutationAPI?: () => DashboardMutationAPI | undefined;
  /** The page the user is on, exposed in /session/context.json. */
  page?: AssistantSidebarPageContextSnapshot;
  /** Also adds `page` to the system prompt and skill selection, where the page stays visible next to the chat. */
  pageInPrompt?: boolean;
};

/**
 * The view or service a session is attached to. Only one host is attached at a
 * time; a page/sidebar handoff re-attaches the running session to the new view.
 */
export type SessionHost = {
  environment(session: AssistantSession): SessionEnvironment;
  persist?(record: StoredSession): Promise<void>;
  onPromptStart?(context: PromptTelemetryContext): void;
  onPromptEnd?(messages: AgentMessage[]): void;
  onCompaction?(event: CompactionEvent): void;
};

export type SessionState = {
  id: string;
  title: string;
  /** Model and thinking level chosen for this chat; undefined uses the configured default. */
  modelId?: string;
  thinkingLevel?: PiAppThinkingLevel;
  toolRuns: ToolRunState;
  runStatus?: ChatRunStatus;
  shellRunning: boolean;
  save?: { status: 'saving' | 'saved' | 'error'; error?: string };
  compaction?: CompactionState;
  /** History dropped without a summary during the latest run, because summarizing failed or was not enough. */
  truncation?: CompactionEvent;
};

type SessionInit = {
  id?: string;
  title?: string;
  createdAt?: string;
  launch?: SessionLaunch;
  workspace?: SessionWorkspace;
  messages?: AgentMessage[];
  modelId?: string;
  thinkingLevel?: PiAppThinkingLevel;
  compaction?: CompactionState;
  artifacts?: Record<string, Artifact>;
  artifactCounter?: number;
};

/**
 * One conversation, independent of any React view: its identity, launch
 * context, agent, session filesystem, approvals, run progress, and persistence.
 * Hosts attach to it to supply the model, Grafana capabilities, and storage.
 */
export class AssistantSession {
  agent?: Agent;
  readonly workspace: SessionWorkspace;
  readonly approvals = new ApprovalChannel();
  readonly artifacts = new ArtifactStore();
  launch: SessionLaunch;
  createdAt?: string;
  persistenceError?: string;
  private state: SessionState;
  private host?: SessionHost;
  private saves: Promise<void> = Promise.resolve();
  private saveSequence = 0;
  private stateListeners = new Set<() => void>();
  private listeners = new Set<(event: AgentEvent, agent: Agent) => void>();
  private unsubscribeAgent?: () => void;
  private catalog?: { broker: DashboardBroker; catalog: DashboardCatalog };
  private initialMessages: AgentMessage[];

  constructor(init: SessionInit = {}) {
    this.workspace = init.workspace ?? new SessionWorkspace();
    this.launch = init.launch ?? {};
    this.createdAt = init.createdAt;
    this.initialMessages = init.messages ?? [];
    this.state = {
      id: init.id ?? createSessionId(),
      title: init.title || NEW_CHAT_TITLE,
      modelId: init.modelId,
      thinkingLevel: init.thinkingLevel,
      toolRuns: {},
      shellRunning: false,
      compaction: isCompactionState(init.compaction) ? init.compaction : undefined,
    };
    if (init.artifacts) {
      this.artifacts.restore(init.artifacts, init.artifactCounter);
    }
  }

  /** Rebuilds a stored or imported session. Imported files are untrusted and get a new ID. */
  static restore(stored: StoredSession, options: { id?: string; title?: string; trusted?: boolean } = {}) {
    const workspace = SessionWorkspace.restore(stored.workspace, { trusted: options.trusted ?? true });
    migrateLegacyJsonnetFiles(workspace, stored.virtualJsonnetFiles);
    migrateLegacyInvestigationReport(workspace, stored.investigationReport);
    return new AssistantSession({
      id: options.id ?? stored.id,
      title: options.title ?? stored.title,
      createdAt: options.id ? undefined : stored.createdAt,
      workspace,
      messages: stored.messages,
      modelId: stored.modelId || undefined,
      thinkingLevel: parseStoredThinkingLevel(stored.thinkingLevel),
      compaction: stored.compaction,
      artifacts: stored.artifacts ?? {},
      artifactCounter: stored.artifactCounter,
    });
  }

  get id() {
    return this.state.id;
  }

  get title() {
    return this.state.title;
  }

  /** The conversation, without the system message that leads the agent transcript. */
  get messages(): AgentMessage[] {
    return this.agent ? conversationMessages(this.agent.state.messages) : this.initialMessages;
  }

  get isStreaming() {
    return Boolean(this.agent?.state.isStreaming);
  }

  getState = () => this.state;

  subscribeState = (listener: () => void) => {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  };

  /** Agent events of this session, delivered after the session updated its own state. */
  subscribe(listener: (event: AgentEvent, agent: Agent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setModelSettings(settings: { modelId?: string; thinkingLevel?: PiAppThinkingLevel }) {
    this.update({ modelId: settings.modelId, thinkingLevel: settings.thinkingLevel });
  }

  /** Attaches a host and creates the agent on first attach. */
  attach(host: SessionHost) {
    this.host = host;
    if (!this.agent) {
      const environment = host.environment(this);
      const turn = this.buildTurn('', environment);
      this.createAgent({
        messages: this.initialMessages,
        systemPrompt: turn.systemPrompt,
        tools: turn.tools,
        model: environment.model,
        thinkingLevel: environment.thinkingLevel,
        streamFn: environment.streamFn,
      });
    }
    return this.agent!;
  }

  /** Stops the run and declines a pending approval. The session stays usable. */
  abort() {
    this.approvals.settle(false);
    this.agent?.abort();
  }

  async prompt(text: string) {
    const agent = this.agent;
    const host = this.host;
    if (!agent || !host || !text || agent.state.isStreaming) {
      return;
    }
    if (this.state.title === NEW_CHAT_TITLE) {
      this.update({ title: generateTitle(text) });
    }
    this.update({ runStatus: createInitialRunStatus(), truncation: undefined });
    try {
      const environment = host.environment(this);
      const turn = this.buildTurn(text, environment);
      host.onPromptStart?.({
        prompt: text,
        systemPrompt: turn.systemPrompt,
        messages: this.messages,
        toolCount: turn.tools.length,
        activeSkills: turn.skillSelection.activeSkills,
        explicitSkillNames: turn.skillSelection.explicitSkillNames,
      });
      setTurnSystemMessage(agent, turn.systemPrompt, turn.tools);
      agent.state.model = environment.model;
      agent.state.thinkingLevel = environment.thinkingLevel;
      await agent.prompt(text);
      host.onPromptEnd?.(this.messages);
      await this.flushSaves();
    } finally {
      this.launch = {};
      this.update({ runStatus: undefined });
    }
  }

  /**
   * Runs a command the user typed (`!command`) in the session shell, without a
   * model call. The result joins the transcript, so the agent sees it on the next prompt.
   */
  async runUserShell(command: string) {
    const agent = this.agent;
    const host = this.host;
    if (!agent || !host || !command || agent.state.isStreaming || this.state.shellRunning) {
      return;
    }
    if (this.state.title === NEW_CHAT_TITLE) {
      this.update({ title: generateTitle(`! ${command.split('\n')[0]}`) });
    }
    this.update({ shellRunning: true });
    try {
      const result: WorkspaceBashResult = await this.toolkitFor(host.environment(this)).runShell(command);
      agent.state.messages = [...agent.state.messages, createUserShellMessage(result)];
      await this.save();
    } finally {
      this.update({ shellRunning: false });
    }
  }

  snapshot(messages = this.messages): SessionSnapshot {
    return {
      messages,
      modelId: this.state.modelId ?? this.agent?.state.model.id,
      thinkingLevel: this.state.thinkingLevel ?? this.agent?.state.thinkingLevel,
      workspace: this.workspace.serialize(),
      artifacts: this.artifacts.snapshot(),
      artifactCounter: this.artifacts.counter,
      compaction: this.state.compaction,
    };
  }

  /** The session as stored and exported. */
  record(messages = this.messages, now = new Date().toISOString()): StoredSession {
    const snapshot = this.snapshot(messages);
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt ?? now,
      updatedAt: now,
      ...snapshot,
      thinkingLevel: parseStoredThinkingLevel(snapshot.thinkingLevel),
    };
  }

  /** Queues a save of the current state. Saves run in order; sessions without a user or assistant message are not stored. */
  save(messages = this.messages) {
    if (!hasPersistableMessages(messages)) {
      return this.saves;
    }
    const record = this.record(messages);
    this.createdAt = record.createdAt;
    const persist = this.host?.persist?.bind(this.host);
    const sequence = ++this.saveSequence;
    this.update({ save: { status: 'saving' } });
    const save = this.saves.then(async () => {
      await persist?.(record);
      this.persistenceError = undefined;
      if (sequence === this.saveSequence) {
        this.update({ save: { status: 'saved' } });
      }
    });
    this.saves = save.catch((error) => {
      this.persistenceError = error instanceof Error ? error.message : String(error);
      if (sequence === this.saveSequence) {
        this.update({ save: { status: 'error', error: this.persistenceError } });
      }
    });
    return save;
  }

  async flushSaves() {
    await this.saves;
    if (this.persistenceError) {
      throw new Error(this.persistenceError);
    }
  }

  toolkit(options: SessionWorkspaceToolkitOptions) {
    const dashboards = options.broker.dashboards;
    if (dashboards && this.catalog?.broker !== dashboards) {
      this.catalog = { broker: dashboards, catalog: createDashboardCatalog(dashboards) };
    }
    return createSessionWorkspaceToolkit({ ...options, catalog: this.catalog?.catalog });
  }

  private toolkitFor(environment: SessionEnvironment) {
    const liveDashboardEditingAvailable = Boolean(environment.getDashboardMutationAPI);
    return this.toolkit({
      workspace: this.workspace,
      broker: environment.broker,
      approvals: this.approvals,
      artifacts: this.artifacts,
      skills: environment.skills,
      context: {
        capturedAt: new Date().toISOString(),
        page: environment.page,
        dashboardLaunch: this.launch.dashboard,
        externalLaunch: this.launch.external?.context,
        capabilities: { liveDashboardEditingAvailable, python: Boolean(environment.python) },
        datasources: environment.broker.prometheus?.datasources(),
      },
      python: environment.python,
      getDashboardMutationAPI: environment.getDashboardMutationAPI,
    });
  }

  /** System prompt, tools, and active skills for the next prompt. */
  private buildTurn(prompt: string, environment: SessionEnvironment) {
    const page = environment.pageInPrompt ? environment.page : undefined;
    const skillSelection = selectGrafanaSkills(prompt, environment.skills, sidebarPageContextSkillHints(page));
    const toolkit = this.toolkitFor(environment);
    const systemPrompt = [
      renderGrafanaSystemPrompt({
        skills: environment.skills,
        activeSkillNames: skillSelection.activeSkillNames,
        liveDashboardEditingAvailable: Boolean(environment.getDashboardMutationAPI),
      }),
      toolkit.promptSection,
      this.launch.dashboard ? renderDashboardAssistantContextBlock(this.launch.dashboard) : undefined,
      this.launch.external ? renderExternalAssistantContextBlock(this.launch.external.context) : undefined,
      renderAssistantSidebarPageContextBlock(page),
    ]
      .filter(Boolean)
      .join('\n\n');
    return { systemPrompt, tools: toolkit.tools, skillSelection };
  }

  createAgent(options: {
    messages: AgentMessage[];
    systemPrompt: string;
    tools: AgentTool[];
    model: Agent['state']['model'];
    thinkingLevel: Agent['state']['thinkingLevel'];
    streamFn: StreamFn;
  }) {
    let agent: Agent;
    const compactor = new ContextCompactor({
      initialState: this.state.compaction,
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
      onStateChange: (compaction) => this.update({ compaction }),
      onEvent: (event) => this.handleCompaction(event),
    });
    agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        messages: conversationMessages(options.messages),
        tools: options.tools,
      },
      convertToLlm: convertChatMessagesToLlm,
      // Compaction and its persisted message indexes see only the conversation.
      transformContext: async (messages, signal) => [
        ...messages.filter((message) => message.role === 'system'),
        ...(await compactor.transform(conversationMessages(messages), signal)),
      ],
      streamFn: options.streamFn,
    });
    this.unsubscribeAgent?.();
    this.agent = agent;
    this.unsubscribeAgent = agent.subscribe(async (event) => {
      this.update({
        toolRuns: reduceToolRuns(this.state.toolRuns, event),
        runStatus: reduceChatRunStatus(this.state.runStatus, event),
      });
      if (event.type === 'agent_end') {
        try {
          // `event.messages` holds only this run's new messages; persist the whole history.
          await this.save();
        } catch {
          /* Exposed as persistenceError and the save state. */
        }
      }
      for (const listener of this.listeners) {
        listener(event, agent);
      }
    });
    return agent;
  }

  private handleCompaction(event: CompactionEvent) {
    if (event.kind === 'summarizing') {
      this.update({ runStatus: withRunPhase(this.state.runStatus, 'compacting') });
    } else if (event.kind === 'truncated') {
      this.update({ truncation: event });
    }
    this.host?.onCompaction?.(event);
  }

  private update(patch: Partial<SessionState>) {
    const changed = (Object.keys(patch) as Array<keyof SessionState>).some((key) => patch[key] !== this.state[key]);
    if (!changed) {
      return;
    }
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) {
      listener();
    }
  }
}

/**
 * Replaces the system message that leads the transcript with this turn's prompt
 * and tools. The prompt is rebuilt for every turn (skills, launch and page
 * context), so the transcript keeps one leading system message instead of a
 * history of prompt changes, and Pi finds no tool changes to declare.
 */
function setTurnSystemMessage(agent: Agent, systemPrompt: string, tools: AgentTool[]) {
  const system = createInitialSystemMessage(systemPrompt, tools.map(toToolDeclaration));
  const conversation = conversationMessages(agent.state.messages);
  agent.state.tools = tools;
  agent.state.messages = system ? [system, ...conversation] : conversation;
}

async function summarizeWithModel(
  streamFn: StreamFn,
  model: Agent['state']['model'],
  input: SummarizerInput,
  signal?: AbortSignal
) {
  const stream = await streamFn(
    model,
    normalizeContext({
      systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildSummarizerPrompt(input), timestamp: Date.now() }],
    }),
    { maxTokens: Math.min(SUMMARY_MAX_OUTPUT_TOKENS, model.maxTokens || SUMMARY_MAX_OUTPUT_TOKENS), signal }
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
