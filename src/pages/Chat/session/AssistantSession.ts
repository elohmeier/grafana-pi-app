import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  AgentDoc,
  createRegistry,
  defineEntry,
  Harness,
  watchEvents,
  type AgentState,
  type Conversation,
  type ConversationView,
  type Cursor,
  type EntryRecord,
  type JsonObject,
  type LiveState,
  type Tx,
} from '@earendil-works/pi-durable';
import type { DashboardMutationAPI } from '@grafana/data';
import type { PiAppJsonData, PiAppThinkingLevel } from '../../../types';
import { createChatEventAdapter, type ChatAgentEvent } from '../agentEvents';
import { userPromptTexts, userShellModelMessage, type ChatMessage } from '../chatMessages';
import { renderDashboardAssistantContextBlock, type DashboardAssistantLaunch } from '../dashboardLaunch';
import { renderExternalAssistantContextBlock, type ExternalAssistantLaunch } from '../externalAssistantLaunch';
import type { ChatLogClient, ChatSummary } from '../durable/chatLogClient';
import {
  SHELL_ENTRY_KIND,
  syncDraft,
  toJson,
  TurnDoc,
  WorkspaceDoc,
  type TurnState,
  type WorkspaceState,
} from '../durable/documents';
import { createAssistantExtension } from '../durable/extension';
import { ChatStorageLost, LogStorage } from '../durable/logStorage';
import { createAssistantModels, modelRef, type AssistantStreamFn } from '../durable/models';
import { assistantHarnessSettings } from '../durable/settings';
import { EMPTY_TRANSCRIPT, projectTranscript, type ChatTranscript } from '../durable/transcript';
import {
  renderAssistantSidebarPageContextBlock,
  sidebarPageContextSkillHints,
  type AssistantSidebarPageContextSnapshot,
} from '../sidebarPageContext';
import { renderGrafanaSystemPrompt, selectGrafanaSkills, type GrafanaSkill } from '../skills';
import type { PromptTelemetryContext } from '../telemetry';
import { createSessionWorkspaceToolkit, type SessionWorkspaceToolkitOptions, SessionWorkspace } from '../workspace';
import type { AlertRuleBroker, DashboardBroker, WorkspaceBroker } from '../workspace/broker';
import {
  createAlertRuleCatalog,
  createDashboardCatalog,
  type AlertRuleCatalog,
  type DashboardCatalog,
} from '../workspace/mounts';
import type { PythonRunner } from '../workspace/python/pythonCommand';
import type { WorkspaceBashResult } from '../workspace/shell';
import type { Artifact } from '../domain/artifacts';
import { ApprovalChannel } from './ApprovalChannel';
import { ArtifactStore } from './artifactStore';
import {
  createSessionId,
  generateTitle,
  NEW_CHAT_TITLE,
  parseStoredThinkingLevel,
  type ChatExport,
} from './chatIdentity';

const context = BACKGROUND_CONTEXT;
const ENTRY_PAGE_SIZE = 500;
const ShellEntry = defineEntry<JsonObject>(SHELL_ENTRY_KIND);

/** Context a chat was opened with. It reaches the model with the first prompt and is then dropped. */
export type SessionLaunch = {
  dashboard?: DashboardAssistantLaunch;
  external?: ExternalAssistantLaunch;
};

/** Capabilities of the place the session currently runs in, resolved again for every prompt, tool call, and shell command. */
export type SessionEnvironment = {
  /** Plugin settings; the configured models form the session's model catalog. */
  jsonData: PiAppJsonData;
  streamFn: AssistantStreamFn;
  /** The chat's model and the thinking level it runs with. */
  model: Model<Api>;
  thinkingLevel: PiAppThinkingLevel;
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
  /** The backend that stores chats. */
  chatLog: ChatLogClient;
  onPromptStart?(context: PromptTelemetryContext): void;
  /** The chat was stored: opened, or changed by a finished run or shell command. */
  onStored?(summary: ChatSummary): void;
};

/** Whether the chat is stored and accepts changes. */
export type SessionStorageState =
  | { status: 'new' }
  | { status: 'opening' }
  | { status: 'open' }
  | { status: 'lost'; reason: ChatStorageLost['reason'] | 'open-failed'; message: string };

export type SessionState = {
  id: string;
  title: string;
  /** Model and thinking level chosen for this chat; undefined uses the configured default. */
  modelId?: string;
  thinkingLevel?: PiAppThinkingLevel;
  transcript: ChatTranscript;
  shellRunning: boolean;
  storage: SessionStorageState;
};

type SessionInit = {
  id?: string;
  title?: string;
  launch?: SessionLaunch;
  /** The chat exists in storage and is opened on attach. */
  stored?: boolean;
};

/**
 * One chat, independent of any React view. Its transcript, tasks, and
 * session filesystem live in a Pi Durable harness over the chat's log in the
 * plugin backend: every step is stored before it is shown, and a run
 * interrupted by a reload continues when the chat is opened again. Opening
 * the chat elsewhere takes it over; this session then stops accepting work.
 */
export class AssistantSession {
  readonly approvals = new ApprovalChannel();
  readonly artifacts = new ArtifactStore();
  launch: SessionLaunch;
  private currentWorkspace = new SessionWorkspace();
  private state: SessionState;
  private host?: SessionHost;
  private conversation?: Conversation;
  private storage?: LogStorage;
  private opening?: Promise<Conversation>;
  private readonly stored: boolean;
  private readonly entries = new Map<number, EntryRecord>();
  private view?: ConversationView;
  private readonly timing: { runStartedAt?: number; toolStartedAt: Map<string, number> } = {
    toolStartedAt: new Map(),
  };
  private disposers: Array<() => void | Promise<unknown>> = [];
  private stateListeners = new Set<() => void>();
  private listeners = new Set<(event: ChatAgentEvent) => void>();
  private catalog?: { broker: DashboardBroker; catalog: DashboardCatalog };
  private alertRuleCatalog?: { broker: AlertRuleBroker; catalog: AlertRuleCatalog };
  private closed = false;

  constructor(init: SessionInit = {}) {
    this.launch = init.launch ?? {};
    this.stored = Boolean(init.stored);
    this.state = {
      id: init.id ?? createSessionId(),
      title: init.title || NEW_CHAT_TITLE,
      transcript: EMPTY_TRANSCRIPT,
      shellRunning: false,
      storage: { status: 'new' },
    };
  }

  get id() {
    return this.state.id;
  }

  get title() {
    return this.state.title;
  }

  get workspace() {
    return this.currentWorkspace;
  }

  get messages(): ChatMessage[] {
    return this.state.transcript.messages;
  }

  get isStreaming() {
    return this.state.transcript.busy;
  }

  /** Whether the chat has been stored; a new chat is stored with its first prompt or command. */
  get started() {
    return this.state.storage.status !== 'new';
  }

  getState = () => this.state;

  subscribeState = (listener: () => void) => {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  };

  /** Run events of this chat, for telemetry and benchmarks. */
  subscribe(listener: (event: ChatAgentEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setModelSettings(settings: { modelId?: string; thinkingLevel?: PiAppThinkingLevel }) {
    this.update({ modelId: settings.modelId, thinkingLevel: settings.thinkingLevel });
  }

  /** Attaches a host. A stored chat is opened on first attach. */
  attach(host: SessionHost) {
    this.host = host;
    if (this.stored && !this.opening) {
      void this.open().catch(() => {
        // Reported through the storage state.
      });
    }
  }

  /** Stops the run and declines a pending approval. The session stays usable. */
  abort() {
    this.approvals.settle(false);
    const conversation = this.conversation;
    if (conversation && this.state.storage.status === 'open') {
      void conversation.abort(context).catch(() => {
        // A lost storage already stopped the run.
      });
    }
  }

  /** Opens the chat's storage and harness, creating the chat when it is new. */
  open(): Promise<Conversation> {
    this.opening ??= this.openHarness().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.update({
        storage:
          error instanceof ChatStorageLost
            ? { status: 'lost', reason: error.reason, message }
            : { status: 'lost', reason: 'open-failed', message: `The chat could not be opened: ${message}` },
      });
      throw error;
    });
    return this.opening;
  }

  private async openHarness() {
    const host = this.requireHost();
    this.update({ storage: { status: 'opening' } });
    const storage = await LogStorage.open(host.chatLog, this.id, {
      create: !this.stored,
      title: () => (this.state.title === NEW_CHAT_TITLE ? undefined : this.state.title),
      onLost: (error) => this.update({ storage: { status: 'lost', reason: error.reason, message: error.message } }),
    });
    this.storage = storage;
    if (storage.summary.title && this.state.title === NEW_CHAT_TITLE) {
      this.update({ title: storage.summary.title });
    }
    const environment = host.environment(this);
    const models = createAssistantModels(environment.jsonData, () => this.requireHost().environment(this).streamFn);
    const registry = createRegistry();
    registry.install(
      createAssistantExtension({
        tool: (_conversationId, name) => {
          const tool = this.toolkitFor(this.requireHost().environment(this)).tools.find((item) => item.name === name);
          if (!tool) {
            throw new Error(`Unknown tool: ${name}`);
          }
          return tool;
        },
        persist: async (_conversationId, api, toolContext) => {
          try {
            await api.commit((tx) => this.writeWorkspace(tx), toolContext);
          } catch {
            // The invocation ended (for example on abort); store what changed outside it.
            await this.persistWorkspace();
          }
        },
      })
    );
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: assistantHarnessSettings(() => this.host?.environment(this).model),
        onReport: (error) => console.warn('Assistant extension error', error),
      },
      context
    );
    this.disposers.push(() => harness.close(context));
    const conversation = await harness.root(context, {
      agent: { model: modelRef(environment.model.id), thinkingLevel: environment.thinkingLevel },
    });
    this.conversation = conversation;

    const saved = await harness.snapshot(WorkspaceDoc, conversation.id, context);
    this.restoreWorkspace(saved);
    const agent = await harness.snapshot(AgentDoc, conversation.id, context);
    this.update({
      modelId: this.state.modelId ?? agent?.model?.modelId,
      thinkingLevel: this.state.thinkingLevel ?? parseStoredThinkingLevel(agent?.thinkingLevel),
    });

    await this.loadHistory(conversation);
    const view = await conversation.viewState(context);
    this.disposers.push(() => view.dispose());
    this.applyView(view.value);
    this.disposers.push(view.subscribe((value) => this.applyView(value)));

    const adapt = createChatEventAdapter();
    const events = await watchEvents(harness, conversation.id, context);
    this.disposers.push(() => events.stop());
    events.start(async (batch) => {
      for (const event of adapt(batch)) {
        if (event.type === 'agent_end') {
          this.notifyStored();
        }
        for (const listener of this.listeners) {
          listener(event);
        }
      }
    });

    this.update({ storage: { status: 'open' } });
    this.notifyStored();
    // Continue a run a reload interrupted.
    harness.resume();
    return conversation;
  }

  async prompt(text: string) {
    const host = this.host;
    if (!host || !text || this.isStreaming || this.isUnavailable()) {
      return;
    }
    if (this.state.title === NEW_CHAT_TITLE) {
      this.update({ title: generateTitle(text) });
    }
    const conversation = await this.open();
    const environment = host.environment(this);
    const turn = this.buildTurn(text, environment);
    host.onPromptStart?.({
      prompt: text,
      systemPrompt: [turn.state.assistant, turn.state.workspace, turn.state.launch, turn.state.page]
        .filter(Boolean)
        .join('\n\n'),
      messages: this.messages,
      toolCount: turn.toolCount,
      activeSkills: turn.skillSelection.activeSkills,
      explicitSkillNames: turn.skillSelection.explicitSkillNames,
    });
    await this.configureAgent(conversation, environment);
    await conversation.commit(async (tx) => {
      syncDraft(await tx.doc(TurnDoc, conversation.id), toJson(turn.state) as JsonObject);
      await this.writeWorkspace(tx);
    }, context);
    this.launch = {};
    // The run continues in the harness; its progress arrives through the view.
    await conversation.submit({ type: 'input', content: text, whenBusy: 'followUp' }, context);
  }

  /**
   * Runs a command the user typed (`!command`) in the session shell, without a
   * model call. The result joins the transcript, so the agent sees it on the next prompt.
   */
  async runUserShell(command: string) {
    const host = this.host;
    if (!host || !command || this.isStreaming || this.state.shellRunning || this.isUnavailable()) {
      return;
    }
    if (this.state.title === NEW_CHAT_TITLE) {
      this.update({ title: generateTitle(`! ${command.split('\n')[0]}`) });
    }
    this.update({ shellRunning: true });
    try {
      const conversation = await this.open();
      const result: WorkspaceBashResult = await this.toolkitFor(host.environment(this)).runShell(command);
      const { images: _images, ...stored } = result;
      await conversation.commit(async (tx) => {
        await tx.appendEntry(ShellEntry, conversation.id, {
          data: toJson(stored) as unknown as JsonObject,
          model: [userShellModelMessage(result)],
        });
        await this.writeWorkspace(tx);
      }, context);
      this.notifyStored();
    } finally {
      this.update({ shellRunning: false });
    }
  }

  /** The chat as a downloadable file: every entry and the session filesystem. */
  async exportChat(pluginId: string, exportedAt = new Date().toISOString()): Promise<ChatExport> {
    const conversation = await this.open();
    await this.loadHistory(conversation);
    return {
      kind: 'g42-pi-app.chat',
      schemaVersion: 2,
      exportedAt,
      pluginId,
      chat: { id: this.id, title: this.title },
      entries: this.sortedEntries(),
      workspace: this.workspaceState(),
    };
  }

  /** Resolves once no run is going and the view shows it. */
  async idle() {
    const conversation = this.conversation ?? (this.opening ? await this.opening : undefined);
    await conversation?.waitForIdle(context);
    while (this.isStreaming && !this.isUnavailable()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** Stops the run, then closes the chat. */
  async stop() {
    this.approvals.settle(false);
    const conversation = this.conversation;
    if (conversation && this.isStreaming && this.state.storage.status === 'open') {
      await conversation.abort(context).catch(() => {
        // A lost storage already stopped the run.
      });
    }
    await this.close();
  }

  /** Stops observing the chat and closes its harness. A running answer resumes when the chat is opened again. */
  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // A chat that is still opening is closed once its harness exists.
    await this.opening?.catch(() => undefined);
    const disposers = this.disposers.reverse();
    this.disposers = [];
    for (const dispose of disposers) {
      try {
        await dispose();
      } catch {
        // Closing is best effort.
      }
    }
  }

  toolkit(options: SessionWorkspaceToolkitOptions) {
    const dashboards = options.broker.dashboards;
    if (dashboards && this.catalog?.broker !== dashboards) {
      this.catalog = { broker: dashboards, catalog: createDashboardCatalog(dashboards) };
    }
    const alertRules = options.broker.alertRules;
    if (alertRules && this.alertRuleCatalog?.broker !== alertRules) {
      this.alertRuleCatalog = { broker: alertRules, catalog: createAlertRuleCatalog(alertRules) };
    }
    return createSessionWorkspaceToolkit({
      ...options,
      catalog: this.catalog?.catalog,
      alertRuleCatalog: this.alertRuleCatalog?.catalog,
    });
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

  /** The system prompt parts and active skills for the next prompt. */
  private buildTurn(prompt: string, environment: SessionEnvironment) {
    const page = environment.pageInPrompt ? environment.page : undefined;
    const skillSelection = selectGrafanaSkills(prompt, environment.skills, {
      ...sidebarPageContextSkillHints(page),
      previousPrompts: userPromptTexts(this.messages),
    });
    const toolkit = this.toolkitFor(environment);
    const launch = [
      this.launch.dashboard ? renderDashboardAssistantContextBlock(this.launch.dashboard) : undefined,
      this.launch.external ? renderExternalAssistantContextBlock(this.launch.external.context) : undefined,
    ]
      .filter(Boolean)
      .join('\n\n');
    const state: TurnState = {
      assistant: renderGrafanaSystemPrompt({
        skills: environment.skills,
        activeSkillNames: skillSelection.activeSkillNames,
        liveDashboardEditingAvailable: Boolean(environment.getDashboardMutationAPI),
      }),
      workspace: toolkit.promptSection,
      ...(launch ? { launch } : {}),
      ...(page ? { page: renderAssistantSidebarPageContextBlock(page) } : {}),
    };
    return { state, toolCount: toolkit.tools.length, skillSelection };
  }

  /** Stores the chat's model choice; the next request uses it. */
  private async configureAgent(conversation: Conversation, environment: SessionEnvironment) {
    const agent = (this.view?.docs['pi.agent'] ?? {}) as AgentState;
    const model = modelRef(environment.model.id);
    if (agent.model?.modelId !== model.modelId || agent.thinkingLevel !== environment.thinkingLevel) {
      await conversation.configure({ model, thinkingLevel: environment.thinkingLevel }, context);
    }
  }

  private workspaceState(): WorkspaceState {
    return toJson({
      workspace: this.workspace.serialize() as unknown as JsonObject,
      artifacts: this.artifacts.snapshot() as unknown as JsonObject,
      artifactCounter: this.artifacts.counter,
    });
  }

  /** Writes the session filesystem into the transaction. */
  private async writeWorkspace(tx: Tx) {
    const conversation = this.conversation;
    if (conversation) {
      syncDraft(await tx.doc(WorkspaceDoc, conversation.id), this.workspaceState() as JsonObject);
    }
  }

  private async persistWorkspace() {
    const conversation = this.conversation;
    if (conversation && this.state.storage.status === 'open') {
      await conversation
        .commit((tx) => this.writeWorkspace(tx), context)
        .catch(() => {
          // A lost storage is reported through the storage state.
        });
    }
  }

  private restoreWorkspace(saved: WorkspaceState | undefined) {
    if (!saved) {
      return;
    }
    if (saved.workspace) {
      this.currentWorkspace = SessionWorkspace.restore(saved.workspace);
    }
    if (saved.artifacts) {
      this.artifacts.restore(saved.artifacts as unknown as Record<string, Artifact>, saved.artifactCounter);
    }
    // A new state object, so views re-read the replaced workspace.
    this.state = { ...this.state };
    this.emit();
  }

  /** Loads the entries before the active context, which the view does not include. */
  private async loadHistory(conversation: Conversation) {
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({}, ENTRY_PAGE_SIZE, cursor, context);
      for (const entry of page.items) {
        this.entries.set(entry.id, entry);
      }
      cursor = page.next;
    } while (cursor);
  }

  private sortedEntries() {
    return [...this.entries.values()].sort((a, b) => a.id - b.id);
  }

  private applyView(view: ConversationView) {
    this.view = view;
    for (const entry of view.entries) {
      this.entries.set(entry.id, entry);
    }
    const live = (view.docs['pi.live'] ?? {}) as LiveState;
    if (live.run) {
      this.timing.runStartedAt ??= Date.now();
    } else {
      this.timing.runStartedAt = undefined;
      this.timing.toolStartedAt.clear();
    }
    this.update({ transcript: projectTranscript(this.sortedEntries(), view, this.timing) });
  }

  private notifyStored() {
    const summary = this.storage?.summary;
    if (summary) {
      this.host?.onStored?.({ ...summary, title: this.title, updatedAt: new Date().toISOString() });
    }
  }

  private isUnavailable() {
    return this.state.storage.status === 'lost' || this.closed;
  }

  private requireHost() {
    if (!this.host) {
      throw new Error('The session is not attached to a view.');
    }
    return this.host;
  }

  private update(patch: Partial<SessionState>) {
    const changed = (Object.keys(patch) as Array<keyof SessionState>).some((key) => patch[key] !== this.state[key]);
    if (!changed) {
      return;
    }
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit() {
    for (const listener of this.stateListeners) {
      listener();
    }
  }
}
