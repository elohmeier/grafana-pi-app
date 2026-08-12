import React, {
  FormEvent,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { css, cx } from '@emotion/css';
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type StreamFn,
  streamProxy,
} from '@earendil-works/pi-agent-core';
import { SceneComponentProps, SceneObjectBase, SceneObjectState } from '@grafana/scenes';
import {
  Alert,
  Badge,
  Button,
  Dropdown,
  EmptyState,
  Field,
  Icon,
  Menu,
  Modal,
  Spinner,
  TextArea,
  useStyles2,
} from '@grafana/ui';
import { FolderPicker, getBackendSrv, locationService, usePluginUserStorage } from '@grafana/runtime';
import { useRestrictedGrafanaApis, type DashboardMutationAPI, type GrafanaTheme2 } from '@grafana/data';
import { PLUGIN_BASE_URL, PLUGIN_ID } from '../../constants';
import { testIds } from '../../components/testIds';
import { usePluginMeta } from '../../utils/utils.plugin';
import {
  createGrafanaSupervisorTools,
  createGrafanaToolsForSkillGroups,
  createSkillTools,
  artifactByteSize,
  artifactizeToolResult,
  normalizeJsonnetPath,
  type Artifact,
  type DashboardSaveFolderSelection,
  type ArtifactRuntime,
  type GrafanaToolRuntime,
  type InvestigationReport,
  type VirtualJsonnetFileSnapshot,
} from './grafanaTools';
import { formatAssistantError, type AssistantErrorView } from './llmErrors';
import { createOpenAICompatibleModel, getConfiguredThinkingLevel, type PiAppJsonData } from './model';
import { convertChatMessagesToLlm, hasPersistableMessages } from './chatMessages';
import { getGrafanaSkills, renderGrafanaSystemPrompt, selectGrafanaSkills } from './skills';
import { isFailedDashboardMutationResult } from './tools/result';
import {
  ContentBlocks,
  ToolActivityPanel,
  ToolResultMessageBody,
  type DashboardAction,
  type DashboardOpenHandler,
  type ToolRunView,
} from './ToolRenderer';
import {
  buildDashboardAssistantChatUrl,
  consumeDashboardAssistantLaunch,
  consumeDashboardAssistantStoredLaunch,
  dashboardAssistantPrompt,
  dashboardAssistantSessionTitle,
  removeDashboardAssistantLaunchParams,
  renderDashboardAssistantContextBlock,
  storeDashboardAssistantLaunch,
  type DashboardAssistantLaunch,
} from './dashboardLaunch';
import {
  externalAssistantSessionTitle,
  renderExternalAssistantContextBlock,
  type ExternalAssistantLaunch,
} from './externalAssistantLaunch';
import { getAssistantDockRoute, routeFromLocation, storeAssistantSidebarDockRequest } from './sidebarDock';
import {
  buildAssistantSidebarPageContextSnapshot,
  renderAssistantSidebarPageContextBlock,
  sidebarPageContextSkillHints,
} from './sidebarPageContext';
import { createAssistantTelemetryReporter } from './telemetry';
import {
  createInitialRunStatus,
  formatRunElapsed,
  reduceChatRunStatus,
  resolveChatRunStatusFromStreamingMessage,
  runStatusBadgeText,
  runStatusText,
  type ChatRunStatus,
} from './streamingStatus';
import {
  clearDashboardSaveFolderOverride,
  getChatRun,
  getDashboardSaveFolderOverride,
  isStoredChatRunAgent,
  removeChatRun,
  setChatRunConfirmationHandler,
  setDashboardSaveFolderOverride,
  storeChatRun,
  type ChatRunSnapshot,
  type ChatToolConfirmationHandler,
} from './chatRunRegistry';
import {
  agentWorkspaceLaunchFromSearch,
  agentWorkspaceSessionTitle,
  removeAgentWorkspaceLaunchParams,
  renderAgentWorkspaceContextBlock,
  renderAgentWorkspaceSystemPrompt,
} from './agentWorkspace/launch';
import { createAgentWorkspaceState } from './agentWorkspace/providerClient';
import { createAgentWorkspaceTools } from './agentWorkspace/tools';
import type { AgentWorkspaceLaunchPayload, AgentWorkspaceRuntime, AgentWorkspaceState } from './agentWorkspace/types';

type ChatSceneObjectState = SceneObjectState;

type SessionIndexItem = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

type StoredSession = SessionIndexItem & {
  messages: AgentMessage[];
  modelId?: string;
  virtualJsonnetFiles?: Record<string, VirtualJsonnetFileSnapshot>;
  investigationReport?: InvestigationReport;
  artifacts?: Record<string, Artifact>;
  artifactCounter?: number;
};

type ToolRunState = Record<string, ToolRunView>;

type ToolConfirmationView = {
  id: string;
  toolCallId: string;
  toolName: string;
  title: string;
  description: string;
  fields: Array<{ label: string; value: string }>;
  args: unknown;
  saveDashboardFolder?: DashboardSaveFolderSelection;
};

type ChatLeaveGuardAction = {
  title: string;
  description: string;
  confirmLabel: string;
  stopCurrentAgent?: boolean;
};

type ChatAppVariant = 'page' | 'sidebar';

const SESSION_INDEX_KEY = 'sessions:index';
const CHAT_SESSION_EXPORT_KIND = 'g42-pi-app.chat-session';
const LEGACY_CHAT_SESSION_EXPORT_KINDS = ['grafana-pi-app.chat-session'];
const CHAT_SESSION_EXPORT_SCHEMA_VERSION = 1;
const PERSISTENT_WRITE_TOOLS = new Set([
  'save_dashboard',
  'upload_dashboard',
  'delete_dashboard',
  'save_changes',
  'submit_changes',
]);
const ACTIVE_CHAT_LEAVE_MESSAGE =
  'The assistant is still working. Leaving now will stop the run and discard any partial response.';
const DRAFT_CHAT_LEAVE_MESSAGE = 'The current draft message will be discarded.';
const CHAT_SESSION_PARAM = 'session';
const SIDEBAR_SESSION_MENU_LIMIT = 8;
const ASSISTANT_SIDEBAR_PLUGIN_ID = 'grafana-assistant-app';
const GENERAL_FOLDER_TITLE = 'General';
const STREAMING_REVISION_WATCHDOG_MS = 80;
const sessionKey = (id: string) => `sessions:${id}`;

type ChatSessionExport = {
  kind: typeof CHAT_SESSION_EXPORT_KIND;
  schemaVersion: typeof CHAT_SESSION_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  pluginId: string;
  session: StoredSession;
};

type BenchmarkAgentEvent = {
  type: AgentEvent['type'];
  timestamp: number;
  [key: string]: unknown;
};

type PluginSettingsResponse = {
  jsonData?: PiAppJsonData;
};

const BENCHMARK_EVENT_CONSOLE_PREFIX = '__PI_AGENT_BENCHMARK_EVENT__ ';

declare global {
  interface Window {
    __PI_AGENT_BENCHMARK_CAPTURE__?: boolean;
    __PI_AGENT_BENCHMARK_EVENTS__?: BenchmarkAgentEvent[];
    __PI_AGENT_BENCHMARK_RECORD_EVENT__?: (event: BenchmarkAgentEvent) => void;
  }
}

export class ChatSceneObject extends SceneObjectBase<ChatSceneObjectState> {
  static Component = ChatSceneRenderer;
}

function ChatSceneRenderer({ model }: SceneComponentProps<ChatSceneObject>) {
  model.useState();
  return <ChatApp />;
}

export function ChatApp({
  agentWorkspaceLaunch,
  variant = 'page',
  launchContextId,
  sidebarRoute,
  sessionId,
  initialPrompt,
  initialContext,
  initialAutoSend,
  initialChatId,
}: {
  agentWorkspaceLaunch?: AgentWorkspaceLaunchPayload;
  variant?: ChatAppVariant;
  launchContextId?: string;
  sidebarRoute?: string;
  sessionId?: string;
  /** Prompt from an external plugin's @grafana/assistant openAssistant() call. */
  initialPrompt?: string;
  initialContext?: unknown[];
  /** Whether to send `initialPrompt` immediately rather than only prefilling it. Defaults to true. */
  initialAutoSend?: boolean;
  /** When set, sends `initialPrompt` as a follow-up into this existing session instead of starting a new one. */
  initialChatId?: string;
  /** Accepted for forward-compatibility with @grafana/assistant's contract; not yet used - every external launch is treated as appending context. */
  initialAppendContext?: boolean;
  /** Accepted for forward-compatibility with @grafana/assistant's contract; not yet used. */
  initialOrigin?: string;
}) {
  const isSidebarVariant = variant === 'sidebar';
  const canDockToSidebar = !isSidebarVariant && PLUGIN_ID === ASSISTANT_SIDEBAR_PLUGIN_ID;
  const styles = useStyles2(getStyles);
  const storage = usePluginUserStorage();
  const { dashboardMutationAPI } = useRestrictedGrafanaApis();
  const liveDashboardEditingAvailable = hasActiveDashboardMutationCommands(dashboardMutationAPI);
  const pluginMeta = usePluginMeta();
  const pluginMetaJsonData = useMemo(() => (pluginMeta?.jsonData ?? {}) as PiAppJsonData, [pluginMeta?.jsonData]);
  const [settingsJsonData, setSettingsJsonData] = useState<PiAppJsonData | null>();
  const jsonData = useMemo(
    () => ({ ...(settingsJsonData ?? {}), ...pluginMetaJsonData }),
    [pluginMetaJsonData, settingsJsonData]
  );
  const llmModel = useMemo(() => createOpenAICompatibleModel(jsonData), [jsonData]);
  const thinkingLevel = useMemo(() => getConfiguredThinkingLevel(jsonData), [jsonData]);
  const skills = useMemo(() => getGrafanaSkills(jsonData), [jsonData]);
  const assistantTelemetry = useMemo(() => createAssistantTelemetryReporter(), []);
  const streamFn = useCallback<StreamFn>(
    (model, context, options) =>
      streamProxy(model, context, {
        ...options,
        authToken: 'grafana',
        proxyUrl: `/api/plugins/${PLUGIN_ID}/resources/llm`,
      }),
    []
  );
  const sessionIdRef = useRef<string>();
  const virtualJsonnetFilesRef = useRef<Record<string, VirtualJsonnetFileSnapshot>>({});
  const virtualJsonnetHydratedRef = useRef<Record<string, number>>({});
  const investigationReportRef = useRef<InvestigationReport>();
  const artifactsRef = useRef<Record<string, Artifact>>({});
  const artifactCounterRef = useRef(0);
  const dashboardLaunchRef = useRef<DashboardAssistantLaunch>();
  const externalLaunchRef = useRef<ExternalAssistantLaunch>();
  const agentWorkspaceRef = useRef<AgentWorkspaceState>();
  const [investigationReport, setInvestigationReport] = useState<InvestigationReport>();
  useEffect(() => {
    if (pluginMetaJsonData.isOpenAIAPIKeySet) {
      return;
    }

    let mounted = true;
    getBackendSrv()
      .get<PluginSettingsResponse>(`/api/plugins/${PLUGIN_ID}/settings`)
      .then((settings) => {
        if (mounted) {
          setSettingsJsonData(settings.jsonData ?? {});
        }
      })
      .catch(() => {
        if (mounted) {
          setSettingsJsonData(null);
        }
      });

    return () => {
      mounted = false;
    };
  }, [pluginMetaJsonData.isOpenAIAPIKeySet]);
  const setVirtualJsonnetFile = useCallback((file: VirtualJsonnetFileSnapshot, options?: { hydrated?: boolean }) => {
    const path = normalizeJsonnetPath(file.path);
    const snapshot = { ...file, path };
    virtualJsonnetFilesRef.current = {
      ...virtualJsonnetFilesRef.current,
      [path]: snapshot,
    };
    if (options?.hydrated) {
      virtualJsonnetHydratedRef.current[path] = file.version;
    }
  }, []);
  const setInvestigationReportSnapshot = useCallback((report: InvestigationReport) => {
    investigationReportRef.current = report;
    setInvestigationReport(report);
  }, []);
  const virtualJsonnetRuntime = useMemo(
    () => ({
      getSessionId: () => sessionIdRef.current,
      getFile: (path: string) => virtualJsonnetFilesRef.current[normalizeJsonnetPath(path)],
      setFile: setVirtualJsonnetFile,
      isHydrated: (path: string, version: number) =>
        virtualJsonnetHydratedRef.current[normalizeJsonnetPath(path)] === version,
      markHydrated: (path: string, version: number) => {
        virtualJsonnetHydratedRef.current[normalizeJsonnetPath(path)] = version;
      },
    }),
    [setVirtualJsonnetFile]
  );
  const investigationReportRuntime = useMemo(
    () => ({
      getReport: () => investigationReportRef.current,
      setReport: setInvestigationReportSnapshot,
    }),
    [setInvestigationReportSnapshot]
  );
  const agentWorkspaceRuntime = useMemo<AgentWorkspaceRuntime>(
    () => ({
      getState: () => agentWorkspaceRef.current,
      setState: (state) => {
        agentWorkspaceRef.current = state;
      },
    }),
    []
  );
  const setArtifactSnapshots = useCallback((artifacts: Record<string, Artifact>, counter?: number) => {
    const compacted = compactArtifacts(artifacts);
    artifactsRef.current = compacted;
    artifactCounterRef.current = counter ?? nextArtifactCounter(compacted);
  }, []);
  const clearArtifacts = useCallback(() => {
    artifactsRef.current = {};
    artifactCounterRef.current = 0;
  }, []);
  const artifactRuntime = useMemo<ArtifactRuntime>(
    () => ({
      register: (input) => {
        const id = createArtifactId(artifactCounterRef.current + 1);
        artifactCounterRef.current += 1;
        const artifact: Artifact = {
          id,
          kind: input.kind,
          title: input.title,
          toolName: input.toolName,
          createdAt: new Date().toISOString(),
          bytes: input.bytes ?? artifactByteSize(input.data),
          summary: input.summary,
          data: input.data,
          preview: input.preview,
          mimeType: input.mimeType,
          toolDetails: input.toolDetails,
        };
        artifactsRef.current = compactArtifacts({
          ...artifactsRef.current,
          [id]: artifact,
        });
        return artifact;
      },
      get: (id) => artifactsRef.current[id],
      list: () => Object.values(artifactsRef.current).sort(compareArtifactsByCreatedAt),
    }),
    []
  );
  const afterToolCall = useCallback(
    async (context: AfterToolCallContext, signal?: AbortSignal): Promise<AfterToolCallResult | undefined> => {
      if (signal?.aborted || context.isError) {
        return undefined;
      }
      if (isFailedDashboardMutationResult(context.result)) {
        return { isError: true };
      }
      try {
        return artifactizeToolResult(artifactRuntime, context.toolCall.name, context.result);
      } catch {
        return undefined;
      }
    },
    [artifactRuntime]
  );
  const dashboardSaveFolderRuntime = useMemo(
    () => ({
      getFolderOverride: (toolCallId: string) => getDashboardSaveFolderOverride(sessionIdRef.current, toolCallId),
      clearFolderOverride: (toolCallId: string) => clearDashboardSaveFolderOverride(sessionIdRef.current, toolCallId),
    }),
    []
  );
  const [agent, setAgent] = useState<Agent>();
  const agentRef = useRef<Agent>();
  const { revision, flushRevision, scheduleRevision } = useFrameRevision();
  const [input, setInput] = useState('');
  const [pendingToolConfirmation, setPendingToolConfirmationState] = useState<ToolConfirmationView>();
  const pendingToolConfirmationRef = useRef<ToolConfirmationView>();
  const [sessions, setSessions] = useState<SessionIndexItem[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [currentTitle, setCurrentTitle] = useState('New chat');
  const [error, setError] = useState<string>();
  const [toolRuns, setToolRuns] = useState<ToolRunState>({});
  const [runStatus, setRunStatus] = useState<ChatRunStatus>();
  const unsubscribeRef = useRef<() => void>();
  const titleRef = useRef('New chat');
  const sessionsRef = useRef<SessionIndexItem[]>([]);
  const storageRef = useRef(storage);
  const runStatusRef = useRef<ChatRunStatus>();
  const importSessionInputRef = useRef<HTMLInputElement | null>(null);
  const messagesContainerRef = useRef<HTMLElement | null>(null);
  const autoScrollRef = useRef(true);
  const sidebarRouteRef = useRef<string | undefined>(sidebarRoute);
  const lastScrollTopRef = useRef(0);
  const touchStartYRef = useRef<number>();
  const toolConfirmationResolverRef = useRef<(approved: boolean) => void>();
  const initialLoadStartedRef = useRef(false);
  const isChatDirtyRef = useRef(false);
  const pendingLeaveActionRef = useRef<() => void>();
  const allowNextLocationChangeRef = useRef(false);
  const [leaveGuardAction, setLeaveGuardAction] = useState<ChatLeaveGuardAction>();
  const [blockedLocation, setBlockedLocation] = useState<ReturnType<typeof locationService.getLocation>>();
  const [isAutoScrollPaused, setIsAutoScrollPaused] = useState(false);

  const setPendingToolConfirmation = useCallback(
    (
      next:
        | ToolConfirmationView
        | undefined
        | ((current: ToolConfirmationView | undefined) => ToolConfirmationView | undefined)
    ) => {
      setPendingToolConfirmationState((current) => {
        const value = typeof next === 'function' ? next(current) : next;
        pendingToolConfirmationRef.current = value;
        return value;
      });
    },
    []
  );

  const setRunStatusSnapshot = useCallback((next: ChatRunStatus | undefined) => {
    runStatusRef.current = next;
    setRunStatus(next);
  }, []);

  const updateRunStatus = useCallback((event: AgentEvent) => {
    setRunStatus((current) => {
      const next = reduceChatRunStatus(current, event);
      runStatusRef.current = next;
      return next;
    });
  }, []);

  const settleToolConfirmation = useCallback(
    (approved: boolean) => {
      const resolve = toolConfirmationResolverRef.current;
      if (!resolve) {
        setPendingToolConfirmation(undefined);
        return;
      }
      resolve?.(approved);
    },
    [setPendingToolConfirmation]
  );

  const requestToolConfirmation = useCallback<ChatToolConfirmationHandler>(
    (toolCallId: string, toolName: string, args: unknown, signal?: AbortSignal) => {
      const confirmation = buildToolConfirmation(toolCallId, toolName, args);
      if (!confirmation) {
        return Promise.resolve(undefined);
      }

      if (toolConfirmationResolverRef.current) {
        return Promise.resolve({
          block: true,
          reason: `Persistent Grafana write tool ${toolName} was blocked because another approval is pending.`,
        });
      }

      return new Promise((resolve) => {
        let settled = false;
        const finish = (approved: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          signal?.removeEventListener('abort', handleAbort);
          const pending = pendingToolConfirmationRef.current;
          if (approved && pending?.toolCallId === toolCallId && pending.saveDashboardFolder) {
            const sessionId = sessionIdRef.current;
            if (sessionId) {
              setDashboardSaveFolderOverride(sessionId, toolCallId, pending.saveDashboardFolder);
            }
          } else {
            clearDashboardSaveFolderOverride(sessionIdRef.current, toolCallId);
          }
          toolConfirmationResolverRef.current = undefined;
          setPendingToolConfirmation(undefined);
          resolve(
            approved
              ? undefined
              : {
                  block: true,
                  reason: `User denied persistent Grafana write tool ${toolName}.`,
                }
          );
        };
        const handleAbort = () => finish(false);

        toolConfirmationResolverRef.current = finish;
        setPendingToolConfirmation(confirmation);

        if (signal?.aborted) {
          finish(false);
        } else {
          signal?.addEventListener('abort', handleAbort, { once: true });
        }
      });
    },
    [setPendingToolConfirmation]
  );

  const confirmToolCall = useCallback<NonNullable<GrafanaToolRuntime['beforeToolCall']>>(
    ({ toolCall, args }, signal) => {
      const handler = getChatRun(sessionIdRef.current)?.requestToolConfirmation ?? requestToolConfirmation;
      return handler(toolCall.id, toolCall.name, args, signal);
    },
    [requestToolConfirmation]
  );

  const emitRuntimeToolUpdate = useCallback<NonNullable<GrafanaToolRuntime['emitToolUpdate']>>(
    (update) => {
      const event: AgentEvent = {
        type: 'tool_execution_update',
        toolCallId: update.toolCallId,
        toolName: update.toolName,
        args: update.args,
        partialResult: update.partialResult,
      };

      updateRunStatus(event);
      scheduleRevision();
      setToolRuns((value) => {
        const next = reduceToolRuns(value, event);
        const sessionId = sessionIdRef.current;
        const run = getChatRun(sessionId);
        if (run && run.agent === agentRef.current) {
          run.toolRuns = next;
          run.updatedAt = Date.now();
        }
        return next;
      });
    },
    [scheduleRevision, updateRunStatus]
  );

  const handleDashboardFolderChange = useCallback(
    (folderUid: string | undefined, folderTitle: string | undefined) => {
      const uid = folderUid || undefined;
      const title = folderTitle || (uid ? uid : GENERAL_FOLDER_TITLE);
      setPendingToolConfirmation((current) => {
        if (!current?.saveDashboardFolder) {
          return current;
        }
        return {
          ...current,
          saveDashboardFolder: {
            uid,
            title,
          },
        };
      });
    },
    [setPendingToolConfirmation]
  );

  const buildSkillRuntime = useCallback(
    (prompt: string) => {
      const agentWorkspace = agentWorkspaceRef.current;
      if (agentWorkspace) {
        const toolSet = createAgentWorkspaceTools(agentWorkspaceRuntime);
        return {
          systemPrompt: [
            renderAgentWorkspaceSystemPrompt(agentWorkspace),
            renderAgentWorkspaceContextBlock(agentWorkspace),
          ]
            .filter(Boolean)
            .join('\n\n'),
          tools: toolSet.all,
          skillSelection: {
            activeSkills: [],
            activeSkillNames: [],
            toolGroups: [],
            explicitSkillNames: [],
          },
        };
      }

      const sidebarPageContext = isSidebarVariant
        ? buildAssistantSidebarPageContextSnapshot(sidebarRouteRef.current, { liveDashboardEditingAvailable })
        : undefined;
      const selection = selectGrafanaSkills(prompt, skills, sidebarPageContextSkillHints(sidebarPageContext));
      const skillTools = createSkillTools(selection.activeSkills);
      const toolOptions = {
        ...jsonData,
        runtime: {
          model: llmModel,
          streamFn,
          thinkingLevel,
          beforeToolCall: confirmToolCall,
          afterToolCall,
          emitToolUpdate: emitRuntimeToolUpdate,
        },
        virtualJsonnetFiles: virtualJsonnetRuntime,
        dashboardSaveFolders: dashboardSaveFolderRuntime,
        investigationReport: investigationReportRuntime,
        artifacts: artifactRuntime,
        dashboardMutation: dashboardMutationAPI,
        skillTools,
      };
      const tools =
        prompt.trim() === '' || selection.supervisorOnly
          ? createGrafanaSupervisorTools(toolOptions)
          : createGrafanaToolsForSkillGroups(toolOptions, selection.toolGroups);
      const systemPrompt = renderGrafanaSystemPrompt({
        skills,
        activeSkillNames: selection.activeSkillNames,
        liveDashboardEditingAvailable,
      });
      const dashboardLaunchContext = dashboardLaunchRef.current
        ? renderDashboardAssistantContextBlock(dashboardLaunchRef.current)
        : undefined;
      const externalLaunchContext = externalLaunchRef.current
        ? renderExternalAssistantContextBlock(externalLaunchRef.current.context)
        : undefined;
      const sidebarContext = renderAssistantSidebarPageContextBlock(sidebarPageContext);

      return {
        systemPrompt: [systemPrompt, dashboardLaunchContext, externalLaunchContext, sidebarContext]
          .filter(Boolean)
          .join('\n\n'),
        tools,
        skillSelection: selection,
      };
    },
    [
      investigationReportRuntime,
      afterToolCall,
      artifactRuntime,
      confirmToolCall,
      emitRuntimeToolUpdate,
      dashboardMutationAPI,
      dashboardSaveFolderRuntime,
      agentWorkspaceRuntime,
      isSidebarVariant,
      liveDashboardEditingAvailable,
      jsonData,
      llmModel,
      skills,
      streamFn,
      thinkingLevel,
      virtualJsonnetRuntime,
    ]
  );

  const persistIndex = useCallback(
    async (next: SessionIndexItem[]) => {
      sessionsRef.current = next;
      setSessions(next);
      await storage.setItem(SESSION_INDEX_KEY, JSON.stringify(next));
    },
    [storage]
  );

  const saveSession = useCallback(
    async (id: string, title: string, messages: AgentMessage[]) => {
      if (!hasPersistableMessages(messages)) {
        return;
      }

      const now = new Date().toISOString();
      const indexItem: SessionIndexItem = {
        id,
        title,
        createdAt: sessionsRef.current.find((session) => session.id === id)?.createdAt ?? now,
        updatedAt: now,
      };
      const stored: StoredSession = {
        ...indexItem,
        messages,
        modelId: llmModel.id,
        virtualJsonnetFiles: virtualJsonnetFilesRef.current,
        investigationReport: investigationReportRef.current,
        artifacts: artifactsRef.current,
        artifactCounter: artifactCounterRef.current,
      };
      const next = [indexItem, ...sessionsRef.current.filter((session) => session.id !== id)].slice(0, 50);

      await storage.setItem(sessionKey(id), JSON.stringify(stored));
      await persistIndex(next);
    },
    [llmModel.id, persistIndex, storage]
  );

  const handleAgentEvent = useCallback(
    (event: AgentEvent, eventAgent: Agent) => {
      emitBenchmarkEvent(event);
      assistantTelemetry.recordAgentEvent(event);
      updateRunStatus(event);
      if (shouldBatchRevision(event)) {
        scheduleRevision();
      } else {
        flushRevision();
      }
      setToolRuns((value) => {
        const next = reduceToolRuns(value, event);
        const sessionId = sessionIdRef.current;
        const run = getChatRun(sessionId);
        if (run?.agent === eventAgent) {
          run.toolRuns = next;
          run.updatedAt = Date.now();
        }
        return next;
      });
      if (event.type === 'agent_end') {
        const sessionId = sessionIdRef.current;
        if (sessionId) {
          void saveSession(sessionId, titleRef.current, event.messages);
        }
      }
    },
    [assistantTelemetry, flushRevision, saveSession, scheduleRevision, updateRunStatus]
  );

  const stopCurrentAgentForSessionChange = useCallback(
    (options?: { preserveLiveRun?: boolean }) => {
      toolConfirmationResolverRef.current?.(false);
      toolConfirmationResolverRef.current = undefined;
      setPendingToolConfirmation(undefined);
      unsubscribeRef.current?.();
      unsubscribeRef.current = undefined;
      const currentAgent = agentRef.current;
      const currentSessionId = sessionIdRef.current;
      if (!options?.preserveLiveRun || !isStoredChatRunAgent(currentSessionId, currentAgent)) {
        removeChatRun(currentSessionId);
        currentAgent?.abort();
      }
    },
    [setPendingToolConfirmation]
  );

  const buildAgent = useCallback(
    (messages: AgentMessage[] = []) => {
      stopCurrentAgentForSessionChange();
      const runtime = buildSkillRuntime('');
      const nextAgent = new Agent({
        initialState: {
          systemPrompt: runtime.systemPrompt,
          model: llmModel,
          thinkingLevel,
          messages,
          tools: runtime.tools,
        },
        convertToLlm: convertChatMessagesToLlm,
        streamFn,
        afterToolCall,
        beforeToolCall: confirmToolCall,
      });

      unsubscribeRef.current = nextAgent.subscribe((event) => handleAgentEvent(event, nextAgent));

      setAgent(nextAgent);
      agentRef.current = nextAgent;
      flushRevision();
      return nextAgent;
    },
    [
      buildSkillRuntime,
      afterToolCall,
      confirmToolCall,
      flushRevision,
      handleAgentEvent,
      llmModel,
      stopCurrentAgentForSessionChange,
      streamFn,
      thinkingLevel,
    ]
  );

  const startNewSession = useCallback(() => {
    const id = createSessionId();
    stopCurrentAgentForSessionChange();
    dashboardLaunchRef.current = undefined;
    externalLaunchRef.current = undefined;
    agentWorkspaceRef.current = undefined;
    clearChatSessionParamFromLocation();
    sessionIdRef.current = id;
    titleRef.current = 'New chat';
    virtualJsonnetFilesRef.current = {};
    virtualJsonnetHydratedRef.current = {};
    investigationReportRef.current = undefined;
    setRunStatusSnapshot(undefined);
    clearArtifacts();
    autoScrollRef.current = true;
    setIsAutoScrollPaused(false);
    setCurrentSessionId(id);
    setCurrentTitle('New chat');
    setError(undefined);
    setInput('');
    setToolRuns({});
    setInvestigationReport(undefined);
    settleToolConfirmation(false);
    buildAgent([]);
  }, [buildAgent, clearArtifacts, setRunStatusSnapshot, settleToolConfirmation, stopCurrentAgentForSessionChange]);

  const startDashboardLaunchSession = useCallback(
    (launch: DashboardAssistantLaunch) => {
      const id = createSessionId();
      const title = dashboardAssistantSessionTitle(launch);
      stopCurrentAgentForSessionChange();
      dashboardLaunchRef.current = launch;
      externalLaunchRef.current = undefined;
      agentWorkspaceRef.current = undefined;
      sessionIdRef.current = id;
      titleRef.current = title;
      virtualJsonnetFilesRef.current = {};
      virtualJsonnetHydratedRef.current = {};
      investigationReportRef.current = undefined;
      setRunStatusSnapshot(undefined);
      clearArtifacts();
      autoScrollRef.current = true;
      setIsAutoScrollPaused(false);
      setCurrentSessionId(id);
      setCurrentTitle(title);
      setError(undefined);
      setInput(dashboardAssistantPrompt(launch));
      setToolRuns({});
      setInvestigationReport(undefined);
      settleToolConfirmation(false);
      buildAgent([]);
    },
    [buildAgent, clearArtifacts, setRunStatusSnapshot, settleToolConfirmation, stopCurrentAgentForSessionChange]
  );

  const startExternalAssistantLaunchSession = useCallback(
    (launch: ExternalAssistantLaunch) => {
      const id = createSessionId();
      const title = externalAssistantSessionTitle(launch.prompt);
      stopCurrentAgentForSessionChange();
      dashboardLaunchRef.current = undefined;
      externalLaunchRef.current = launch;
      agentWorkspaceRef.current = undefined;
      sessionIdRef.current = id;
      titleRef.current = title;
      virtualJsonnetFilesRef.current = {};
      virtualJsonnetHydratedRef.current = {};
      investigationReportRef.current = undefined;
      setRunStatusSnapshot(undefined);
      clearArtifacts();
      autoScrollRef.current = true;
      setIsAutoScrollPaused(false);
      setCurrentSessionId(id);
      setCurrentTitle(title);
      setError(undefined);
      setInput(launch.prompt);
      setToolRuns({});
      setInvestigationReport(undefined);
      settleToolConfirmation(false);
      buildAgent([]);
    },
    [buildAgent, clearArtifacts, setRunStatusSnapshot, settleToolConfirmation, stopCurrentAgentForSessionChange]
  );

  const startAgentWorkspaceLaunchSession = useCallback(
    (state: AgentWorkspaceState) => {
      const id = createSessionId();
      const title = agentWorkspaceSessionTitle(state);
      stopCurrentAgentForSessionChange();
      dashboardLaunchRef.current = undefined;
      externalLaunchRef.current = undefined;
      agentWorkspaceRef.current = state;
      sessionIdRef.current = id;
      titleRef.current = title;
      virtualJsonnetFilesRef.current = {};
      virtualJsonnetHydratedRef.current = {};
      investigationReportRef.current = undefined;
      setRunStatusSnapshot(undefined);
      clearArtifacts();
      autoScrollRef.current = true;
      setIsAutoScrollPaused(false);
      setCurrentSessionId(id);
      setCurrentTitle(title);
      setError(undefined);
      setInput(state.launch.initialPrompt ?? '');
      setToolRuns({});
      setInvestigationReport(undefined);
      settleToolConfirmation(false);
      buildAgent([]);
    },
    [buildAgent, clearArtifacts, setRunStatusSnapshot, settleToolConfirmation, stopCurrentAgentForSessionChange]
  );

  const preserveCurrentRunForHandoff = useCallback(() => {
    const currentAgent = agentRef.current;
    const id = sessionIdRef.current;
    if (!currentAgent || !id) {
      return false;
    }

    storeChatRun({
      id,
      title: titleRef.current,
      agent: currentAgent,
      dashboardLaunch: dashboardLaunchRef.current,
      virtualJsonnetFiles: { ...virtualJsonnetFilesRef.current },
      virtualJsonnetHydrated: { ...virtualJsonnetHydratedRef.current },
      investigationReport: investigationReportRef.current,
      artifacts: { ...artifactsRef.current },
      artifactCounter: artifactCounterRef.current,
      toolRuns,
      runStatus: runStatusRef.current,
      requestToolConfirmation,
    });
    return true;
  }, [requestToolConfirmation, toolRuns]);

  const attachLiveRun = useCallback(
    (run: ChatRunSnapshot) => {
      stopCurrentAgentForSessionChange();
      setChatRunConfirmationHandler(run.id, requestToolConfirmation);
      dashboardLaunchRef.current = run.dashboardLaunch;
      externalLaunchRef.current = undefined;
      agentWorkspaceRef.current = undefined;
      sessionIdRef.current = run.id;
      titleRef.current = run.title;
      virtualJsonnetFilesRef.current = run.virtualJsonnetFiles;
      virtualJsonnetHydratedRef.current = run.virtualJsonnetHydrated;
      investigationReportRef.current = run.investigationReport;
      setRunStatusSnapshot(run.runStatus ?? (run.agent.state.isStreaming ? createInitialRunStatus() : undefined));
      setArtifactSnapshots(run.artifacts, run.artifactCounter);
      autoScrollRef.current = true;
      setIsAutoScrollPaused(false);
      setCurrentSessionId(run.id);
      setCurrentTitle(run.title);
      setError(undefined);
      setInput('');
      setToolRuns(run.toolRuns);
      setInvestigationReport(run.investigationReport);
      settleToolConfirmation(false);
      unsubscribeRef.current = run.agent.subscribe((event) => handleAgentEvent(event, run.agent));
      agentRef.current = run.agent;
      setAgent(run.agent);
      flushRevision();

      if (!run.agent.state.isStreaming && hasPersistableMessages(run.agent.state.messages)) {
        void saveSession(run.id, run.title, run.agent.state.messages);
      }

      return true;
    },
    [
      flushRevision,
      handleAgentEvent,
      requestToolConfirmation,
      saveSession,
      setArtifactSnapshots,
      setRunStatusSnapshot,
      settleToolConfirmation,
      stopCurrentAgentForSessionChange,
    ]
  );

  useEffect(() => {
    storageRef.current = storage;
  }, [storage]);

  useEffect(() => {
    return () => {
      void assistantTelemetry.flush();
    };
  }, [assistantTelemetry]);

  useEffect(() => {
    if (sidebarRoute) {
      sidebarRouteRef.current = sidebarRoute;
    }
  }, [sidebarRoute]);

  useEffect(() => {
    if (!isSidebarVariant) {
      return undefined;
    }

    const handleLocation = (location: ReturnType<typeof locationService.getLocation>) => {
      const route = routeFromLocation(location);
      if (route && !isAssistantPluginRoute(route)) {
        sidebarRouteRef.current = route;
      }
    };

    handleLocation(locationService.getLocation());
    const subscription = locationService.getLocationObservable().subscribe(handleLocation);
    return () => {
      subscription.unsubscribe();
    };
  }, [isSidebarVariant]);

  const setAutoScrollEnabled = useCallback((enabled: boolean) => {
    autoScrollRef.current = enabled;
    setIsAutoScrollPaused((paused) => {
      const nextPaused = !enabled;
      return paused === nextPaused ? paused : nextPaused;
    });
  }, []);

  const pauseAutoScroll = useCallback(() => {
    setAutoScrollEnabled(false);
  }, [setAutoScrollEnabled]);

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const element = messagesContainerRef.current;
    if (!element) {
      return;
    }

    const top = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTo({ top, behavior });
    if (behavior !== 'smooth') {
      lastScrollTopRef.current = top;
    }
  }, []);

  const jumpToLatest = useCallback(() => {
    setAutoScrollEnabled(true);
    scrollMessagesToBottom('smooth');
  }, [scrollMessagesToBottom, setAutoScrollEnabled]);

  const updateAutoScrollFromPosition = useCallback(() => {
    const element = messagesContainerRef.current;
    if (!element) {
      return;
    }

    const nextScrollTop = element.scrollTop;
    if (isNearBottom(element)) {
      setAutoScrollEnabled(true);
    } else if (nextScrollTop < lastScrollTopRef.current - 1) {
      setAutoScrollEnabled(false);
    }
    lastScrollTopRef.current = nextScrollTop;
  }, [setAutoScrollEnabled]);

  const handleMessagesWheel = useCallback(
    (event: React.WheelEvent<HTMLElement>) => {
      if (event.deltaY < 0) {
        pauseAutoScroll();
      }
    },
    [pauseAutoScroll]
  );

  const handleMessagesTouchStart = useCallback((event: React.TouchEvent<HTMLElement>) => {
    touchStartYRef.current = event.touches[0]?.clientY;
  }, []);

  const handleMessagesTouchMove = useCallback(
    (event: React.TouchEvent<HTMLElement>) => {
      const touchY = event.touches[0]?.clientY;
      if (touchY !== undefined && touchStartYRef.current !== undefined && touchY > touchStartYRef.current + 4) {
        pauseAutoScroll();
      }
    },
    [pauseAutoScroll]
  );

  const handleMessagesKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Home' || event.key === 'PageUp' || event.key === 'ArrowUp') {
        pauseAutoScroll();
        return;
      }
      if (event.key === 'End') {
        setAutoScrollEnabled(true);
      }
    },
    [pauseAutoScroll, setAutoScrollEnabled]
  );

  const abortAgent = useCallback(() => {
    settleToolConfirmation(false);
    agentRef.current?.abort();
    flushRevision();
  }, [flushRevision, settleToolConfirmation]);

  const isStreaming = Boolean(agent?.state.isStreaming);
  const isBusy = isStreaming;
  const hasDraft = Boolean(input.trim());
  const chatLeaveDescription =
    isStreaming || pendingToolConfirmation ? ACTIVE_CHAT_LEAVE_MESSAGE : DRAFT_CHAT_LEAVE_MESSAGE;
  const isChatDirty = isStreaming || Boolean(pendingToolConfirmation) || hasDraft;

  const keepAutoScrollEnabled = useCallback(() => {
    setAutoScrollEnabled(true);
  }, [setAutoScrollEnabled]);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
  }, []);

  useLayoutEffect(() => {
    if (autoScrollRef.current) {
      scrollMessagesToBottom();
    }
  }, [revision, scrollMessagesToBottom]);

  useEffect(() => {
    isChatDirtyRef.current = isChatDirty;
  }, [isChatDirty]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isChatDirtyRef.current) {
        return;
      }

      event.preventDefault();
      // Required by current browsers to trigger the native leave-page prompt.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  useEffect(() => {
    const history = locationService.getHistory();
    const unblock = history.block((location: ReturnType<typeof locationService.getLocation>) => {
      if (allowNextLocationChangeRef.current) {
        allowNextLocationChangeRef.current = false;
        return true;
      }

      if (!isChatDirtyRef.current) {
        return true;
      }

      if (locationService.getLocation().pathname === location.pathname) {
        return true;
      }

      const isActive = Boolean(agentRef.current?.state.isStreaming || toolConfirmationResolverRef.current);
      pendingLeaveActionRef.current = undefined;
      setBlockedLocation(location);
      setLeaveGuardAction({
        title: 'Leave active chat?',
        description: isActive ? ACTIVE_CHAT_LEAVE_MESSAGE : DRAFT_CHAT_LEAVE_MESSAGE,
        confirmLabel: isActive ? 'Stop and leave' : 'Discard and leave',
        stopCurrentAgent: true,
      });
      return false;
    });

    return () => {
      unblock();
    };
  }, []);

  const cancelLeaveGuard = useCallback(() => {
    pendingLeaveActionRef.current = undefined;
    setBlockedLocation(undefined);
    setLeaveGuardAction(undefined);
  }, []);

  const confirmLeaveGuard = useCallback(() => {
    const action = pendingLeaveActionRef.current;
    const location = blockedLocation;
    const shouldStopCurrentAgent = leaveGuardAction?.stopCurrentAgent !== false;
    pendingLeaveActionRef.current = undefined;
    setBlockedLocation(undefined);
    setLeaveGuardAction(undefined);
    setInput('');
    if (shouldStopCurrentAgent) {
      stopCurrentAgentForSessionChange();
    }
    flushRevision();

    if (location) {
      allowNextLocationChangeRef.current = true;
      setTimeout(() => locationService.push(location), 10);
      return;
    }

    action?.();
  }, [blockedLocation, flushRevision, leaveGuardAction?.stopCurrentAgent, stopCurrentAgentForSessionChange]);

  const requestGuardedAction = useCallback(
    (action: () => void, guardAction: ChatLeaveGuardAction) => {
      if (!isChatDirty) {
        action();
        return;
      }

      pendingLeaveActionRef.current = action;
      setBlockedLocation(undefined);
      setLeaveGuardAction(guardAction);
    },
    [isChatDirty]
  );

  // Extracted so an auto-sent external launch (see startExternalAssistantLaunchSession)
  // can submit the prompt it just set synchronously, without waiting on the
  // `input` state update (setState is batched, so reading `input` right
  // after `setInput(...)` would still see the previous value).
  const submitPromptText = useCallback(async (prompt: string) => {
    const currentAgent = agentRef.current;
    if (!currentAgent || !prompt || currentAgent.state.isStreaming) {
      return;
    }

    let sessionId = sessionIdRef.current;
    if (!sessionId) {
      sessionId = createSessionId();
      sessionIdRef.current = sessionId;
      setCurrentSessionId(sessionId);
    }

    if (titleRef.current === 'New chat') {
      const title = generateTitle(prompt);
      titleRef.current = title;
      setCurrentTitle(title);
    }

    setInput('');
    setError(undefined);
    setRunStatusSnapshot(createInitialRunStatus());
    keepAutoScrollEnabled();
    try {
      const runtime = buildSkillRuntime(prompt);
      assistantTelemetry.recordPromptStart({
        prompt,
        systemPrompt: runtime.systemPrompt,
        messages: currentAgent.state.messages,
        toolCount: runtime.tools.length,
        activeSkills: runtime.skillSelection.activeSkills,
        explicitSkillNames: runtime.skillSelection.explicitSkillNames,
      });
      currentAgent.state.systemPrompt = runtime.systemPrompt;
      currentAgent.state.tools = runtime.tools;
      await currentAgent.prompt(prompt);
      assistantTelemetry.recordTranscriptSnapshot(currentAgent.state.messages);
      emitBenchmarkTranscriptSnapshot(currentAgent.state.messages);
      if (agentRef.current === currentAgent && sessionIdRef.current === sessionId) {
        await saveSession(sessionId, titleRef.current, currentAgent.state.messages);
      }
    } catch (err) {
      if (agentRef.current === currentAgent && sessionIdRef.current === sessionId) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (agentRef.current === currentAgent && sessionIdRef.current === sessionId) {
        dashboardLaunchRef.current = undefined;
        externalLaunchRef.current = undefined;
        setRunStatusSnapshot(undefined);
        flushRevision();
      }
    }
  }, [assistantTelemetry, buildSkillRuntime, flushRevision, keepAutoScrollEnabled, saveSession, setRunStatusSnapshot]);

  const submitPrompt = async (event: FormEvent) => {
    event.preventDefault();
    await submitPromptText(input.trim());
  };

  const loadSession = useCallback(
    async (id: string) => {
      const raw = await storage.getItem(sessionKey(id));
      if (!raw) {
        setError('Session not found');
        return false;
      }

      const stored = JSON.parse(raw) as StoredSession;
      stopCurrentAgentForSessionChange();
      dashboardLaunchRef.current = undefined;
      externalLaunchRef.current = undefined;
      agentWorkspaceRef.current = undefined;
      sessionIdRef.current = id;
      titleRef.current = stored.title;
      setChatSessionParamInLocation(id);
      virtualJsonnetFilesRef.current = stored.virtualJsonnetFiles ?? {};
      virtualJsonnetHydratedRef.current = {};
      investigationReportRef.current = stored.investigationReport;
      setRunStatusSnapshot(undefined);
      setArtifactSnapshots(stored.artifacts ?? {}, stored.artifactCounter);
      keepAutoScrollEnabled();
      setCurrentSessionId(id);
      setCurrentTitle(stored.title);
      setError(undefined);
      setInput('');
      setToolRuns({});
      setInvestigationReport(stored.investigationReport);
      settleToolConfirmation(false);
      buildAgent(stored.messages);
      return true;
    },
    [
      buildAgent,
      keepAutoScrollEnabled,
      setArtifactSnapshots,
      setRunStatusSnapshot,
      settleToolConfirmation,
      stopCurrentAgentForSessionChange,
      storage,
    ]
  );

  const initialLoadHandlersRef = useRef({
    attachLiveRun,
    loadSession,
    startAgentWorkspaceLaunchSession,
    startDashboardLaunchSession,
    startExternalAssistantLaunchSession,
    startNewSession,
    stopCurrentAgentForSessionChange,
    submitPromptText,
  });
  const initialLaunchPropsRef = useRef({
    agentWorkspaceLaunch,
    launchContextId,
    sessionId,
    initialPrompt,
    initialContext,
    initialAutoSend,
    initialChatId,
  });
  const initialConfigPending = !pluginMetaJsonData.isOpenAIAPIKeySet && settingsJsonData === undefined;

  useLayoutEffect(() => {
    initialLoadHandlersRef.current = {
      attachLiveRun,
      loadSession,
      startAgentWorkspaceLaunchSession,
      startDashboardLaunchSession,
      startExternalAssistantLaunchSession,
      startNewSession,
      stopCurrentAgentForSessionChange,
      submitPromptText,
    };
    initialLaunchPropsRef.current = {
      agentWorkspaceLaunch,
      launchContextId,
      sessionId,
      initialPrompt,
      initialContext,
      initialAutoSend,
      initialChatId,
    };
  }, [
    agentWorkspaceLaunch,
    attachLiveRun,
    launchContextId,
    loadSession,
    sessionId,
    initialPrompt,
    initialContext,
    initialAutoSend,
    initialChatId,
    startAgentWorkspaceLaunchSession,
    startDashboardLaunchSession,
    startExternalAssistantLaunchSession,
    startNewSession,
    stopCurrentAgentForSessionChange,
    submitPromptText,
  ]);

  useEffect(() => {
    if (initialConfigPending) {
      return undefined;
    }
    if (initialLoadStartedRef.current) {
      return undefined;
    }
    initialLoadStartedRef.current = true;
    let mounted = true;

    async function loadInitialState() {
      const raw = await storageRef.current.getItem(SESSION_INDEX_KEY);
      const parsed = raw ? (JSON.parse(raw) as SessionIndexItem[]) : [];
      if (!mounted) {
        return;
      }

      sessionsRef.current = parsed;
      setSessions(parsed);

      const location = locationService.getLocation();
      const {
        agentWorkspaceLaunch: initialAgentWorkspaceLaunch,
        launchContextId: initialLaunchContextId,
        sessionId: initialSessionProp,
        initialPrompt: externalPrompt,
        initialContext: externalContext,
        initialAutoSend: externalAutoSend,
        initialChatId: externalChatId,
      } = initialLaunchPropsRef.current;
      const launchFromSearch = agentWorkspaceLaunchFromSearch(location.search);
      const workspaceLaunch = initialAgentWorkspaceLaunch ?? launchFromSearch;
      if (workspaceLaunch) {
        const state = await createAgentWorkspaceState(workspaceLaunch);
        if (!mounted) {
          return;
        }
        initialLoadHandlersRef.current.startAgentWorkspaceLaunchSession(state);
        if (launchFromSearch) {
          locationService.partial(removeAgentWorkspaceLaunchParams(), true);
        }
        return;
      }

      // Launch from an external plugin via @grafana/assistant's openAssistant()
      // (see AssistantSidebar.tsx / ChatApp's initialPrompt props). autoSend
      // defaults to true per that package's contract.
      if (externalPrompt) {
        const autoSend = externalAutoSend ?? true;
        const attachedExistingChat = externalChatId && (await initialLoadHandlersRef.current.loadSession(externalChatId));
        if (attachedExistingChat) {
          // loadSession() already reset externalLaunchRef to undefined; restore
          // it just for this one follow-up turn so its context still reaches
          // buildSkillRuntime (cleared again right after send, same as a fresh launch).
          externalLaunchRef.current = { prompt: externalPrompt, context: externalContext, autoSend };
          setInput(externalPrompt);
        } else {
          initialLoadHandlersRef.current.startExternalAssistantLaunchSession({
            prompt: externalPrompt,
            context: externalContext,
            autoSend,
          });
        }
        if (!mounted) {
          return;
        }
        if (autoSend) {
          await initialLoadHandlersRef.current.submitPromptText(externalPrompt);
        }
        return;
      }

      const launch = initialLaunchContextId
        ? consumeDashboardAssistantStoredLaunch(initialLaunchContextId)
        : consumeDashboardAssistantLaunch(location.search);
      if (launch) {
        initialLoadHandlersRef.current.startDashboardLaunchSession(launch);
        if (!initialLaunchContextId) {
          locationService.partial(removeDashboardAssistantLaunchParams(), true);
        }
        return;
      }

      const initialSessionId = initialSessionProp ?? chatSessionIdFromSearch(location.search);
      const liveRun = getChatRun(initialSessionId);
      if (liveRun && initialLoadHandlersRef.current.attachLiveRun(liveRun)) {
        return;
      }
      if (initialSessionId && (await initialLoadHandlersRef.current.loadSession(initialSessionId))) {
        return;
      }

      initialLoadHandlersRef.current.startNewSession();
    }

    loadInitialState().catch((err) => {
      if (!mounted) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      try {
        initialLoadHandlersRef.current.startNewSession();
      } catch {
        // Keep the original startup error visible below.
      }
      setError(message);
    });

    return () => {
      mounted = false;
      initialLoadHandlersRef.current.stopCurrentAgentForSessionChange({ preserveLiveRun: true });
    };
  }, [initialConfigPending]);

  const deleteSession = async (id: string) => {
    const next = sessions.filter((session) => session.id !== id);
    await persistIndex(next);
    if (id === currentSessionId) {
      startNewSession();
    }
  };

  const requestNewSession = () => {
    requestGuardedAction(startNewSession, {
      title: 'Start a new session?',
      description: chatLeaveDescription,
      confirmLabel: 'Discard and start',
    });
  };

  const requestLoadSession = (id: string) => {
    if (id === currentSessionId) {
      return;
    }

    requestGuardedAction(() => void loadSession(id), {
      title: 'Switch sessions?',
      description: chatLeaveDescription,
      confirmLabel: 'Discard and switch',
    });
  };

  const openFullPage = useCallback(async () => {
    const currentAgent = agentRef.current;
    const sessionId = sessionIdRef.current;
    let url = `${PLUGIN_BASE_URL}/chat`;

    if (currentAgent && sessionId && hasPersistableMessages(currentAgent.state.messages)) {
      await saveSession(sessionId, titleRef.current, currentAgent.state.messages);
      url = buildChatSessionUrl(sessionId);
    } else if (dashboardLaunchRef.current) {
      try {
        const launch = dashboardLaunchRef.current;
        const contextId = storeDashboardAssistantLaunch(launch);
        url = buildDashboardAssistantChatUrl(launch.action, contextId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }

    allowNextLocationChangeRef.current = true;
    locationService.push(url);
  }, [saveSession]);

  const requestOpenFullPage = () => {
    const launch = dashboardLaunchRef.current;
    if (launch && input.trim() === dashboardAssistantPrompt(launch)) {
      void openFullPage();
      return;
    }

    requestGuardedAction(() => void openFullPage(), {
      title: 'Open full Assistant page?',
      description: chatLeaveDescription,
      confirmLabel: 'Open full page',
      stopCurrentAgent: false,
    });
  };

  const dockToSidebar = useCallback(async () => {
    const currentAgent = agentRef.current;
    const currentSessionId = sessionIdRef.current;
    const targetRoute = getAssistantDockRoute() ?? '/';
    const request = { path: targetRoute };

    try {
      if (currentAgent && currentSessionId) {
        if (currentAgent.state.isStreaming) {
          preserveCurrentRunForHandoff();
        }
        if (!currentAgent.state.isStreaming && hasPersistableMessages(currentAgent.state.messages)) {
          await saveSession(currentSessionId, titleRef.current, currentAgent.state.messages);
        }
        storeAssistantSidebarDockRequest({
          ...request,
          sessionId: currentSessionId,
        });
      } else if (dashboardLaunchRef.current) {
        const launch = dashboardLaunchRef.current;
        const contextId = storeDashboardAssistantLaunch(launch);
        storeAssistantSidebarDockRequest({
          ...request,
          action: launch.action,
          contextId,
        });
      } else {
        storeAssistantSidebarDockRequest(request);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    allowNextLocationChangeRef.current = true;
    locationService.push(targetRoute);
  }, [preserveCurrentRunForHandoff, saveSession]);

  const handleOpenDashboard = useCallback<DashboardOpenHandler>(
    async (action: DashboardAction) => {
      const targetRoute = dashboardActionRoute(action);
      if (!targetRoute) {
        setError('The dashboard sync result did not include a dashboard URL or UID.');
        return;
      }

      const currentAgent = agentRef.current;
      const currentSessionId = sessionIdRef.current;

      try {
        if (PLUGIN_ID === ASSISTANT_SIDEBAR_PLUGIN_ID && currentAgent && currentSessionId) {
          if (currentAgent.state.isStreaming) {
            preserveCurrentRunForHandoff();
          }
          if (!currentAgent.state.isStreaming && hasPersistableMessages(currentAgent.state.messages)) {
            await saveSession(currentSessionId, titleRef.current, currentAgent.state.messages);
          }
          storeAssistantSidebarDockRequest({
            path: targetRoute,
            sessionId: currentSessionId,
          });
        } else if (currentAgent && currentSessionId && !currentAgent.state.isStreaming) {
          if (hasPersistableMessages(currentAgent.state.messages)) {
            await saveSession(currentSessionId, titleRef.current, currentAgent.state.messages);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }

      allowNextLocationChangeRef.current = true;
      locationService.push(targetRoute);
    },
    [preserveCurrentRunForHandoff, saveSession]
  );

  const requestDockToSidebar = () => {
    if (!canDockToSidebar || pendingToolConfirmation) {
      return;
    }

    const launch = dashboardLaunchRef.current;
    if (launch && input.trim() === dashboardAssistantPrompt(launch)) {
      void dockToSidebar();
      return;
    }

    requestGuardedAction(() => void dockToSidebar(), {
      title: 'Dock Assistant to side?',
      description: chatLeaveDescription,
      confirmLabel: 'Dock to side',
      stopCurrentAgent: false,
    });
  };

  const handleExportDownloadClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();

      const currentAgent = agentRef.current;
      const sessionId = sessionIdRef.current;
      if (!currentAgent || !sessionId || currentAgent.state.isStreaming) {
        return;
      }

      const messages = currentAgent.state.messages;
      if (!hasPersistableMessages(messages)) {
        setError('There are no chat messages to export.');
        return;
      }

      const exportedAt = new Date().toISOString();
      const indexItem = sessionsRef.current.find((session) => session.id === sessionId);
      const title = titleRef.current || indexItem?.title || 'New chat';
      const payload: ChatSessionExport = {
        kind: CHAT_SESSION_EXPORT_KIND,
        schemaVersion: CHAT_SESSION_EXPORT_SCHEMA_VERSION,
        exportedAt,
        pluginId: PLUGIN_ID,
        session: {
          id: sessionId,
          title,
          createdAt: indexItem?.createdAt ?? exportedAt,
          updatedAt: exportedAt,
          modelId: llmModel.id,
          messages,
          virtualJsonnetFiles: virtualJsonnetFilesRef.current,
          investigationReport: investigationReportRef.current,
          artifacts: artifactsRef.current,
          artifactCounter: artifactCounterRef.current,
        },
      };

      try {
        downloadJsonFile(payload, chatSessionExportFilename(title));
        setError(undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [llmModel.id]
  );

  const openImportSessionPicker = useCallback(() => {
    if (agentRef.current?.state.isStreaming) {
      return;
    }

    requestGuardedAction(() => importSessionInputRef.current?.click(), {
      title: 'Import a session?',
      description: chatLeaveDescription,
      confirmLabel: 'Discard and import',
      stopCurrentAgent: false,
    });
  }, [chatLeaveDescription, requestGuardedAction]);

  const importSessionFromFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      input.value = '';
      if (!file) {
        return;
      }

      if (agentRef.current?.state.isStreaming) {
        setError('Cannot import a session while the assistant is streaming.');
        return;
      }

      try {
        const imported = parseChatSessionExport(JSON.parse(await file.text()));
        const id = createSessionId();
        const title = imported.title || importTitleFromFilename(file.name) || 'Imported chat';

        stopCurrentAgentForSessionChange();
        dashboardLaunchRef.current = undefined;
        agentWorkspaceRef.current = undefined;
        sessionIdRef.current = id;
        titleRef.current = title;
        virtualJsonnetFilesRef.current = imported.virtualJsonnetFiles ?? {};
        virtualJsonnetHydratedRef.current = {};
        investigationReportRef.current = imported.investigationReport;
        setRunStatusSnapshot(undefined);
        setArtifactSnapshots(imported.artifacts ?? {}, imported.artifactCounter);
        keepAutoScrollEnabled();
        setCurrentSessionId(id);
        setCurrentTitle(title);
        setError(undefined);
        setInput('');
        setToolRuns({});
        setInvestigationReport(imported.investigationReport);
        settleToolConfirmation(false);
        buildAgent(imported.messages);
        await saveSession(id, title, imported.messages);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Could not import chat session: ${message}`);
      }
    },
    [
      buildAgent,
      keepAutoScrollEnabled,
      saveSession,
      setArtifactSnapshots,
      setRunStatusSnapshot,
      settleToolConfirmation,
      stopCurrentAgentForSessionChange,
    ]
  );

  const visibleMessages = agent
    ? [
        ...agent.state.messages.map((message) => ({ message, isStreaming: false })),
        ...(agent.state.streamingMessage ? [{ message: agent.state.streamingMessage, isStreaming: true }] : []),
      ]
    : [];
  const activeToolRuns = Object.values(toolRuns)
    .filter((run) => run.status === 'running')
    .sort((left, right) => left.updatedAt - right.updatedAt);
  const pendingApprovalToolName = pendingToolConfirmation?.toolName;
  const displayRunStatus = resolveChatRunStatusFromStreamingMessage(runStatus, agent?.state.streamingMessage);
  const runElapsedMs = useRunElapsedMs(Boolean(isStreaming || pendingApprovalToolName), displayRunStatus?.startedAt);
  const streamingStatusText = runStatusText(displayRunStatus, pendingApprovalToolName);
  const streamingBadgeText = runStatusBadgeText(displayRunStatus, pendingApprovalToolName);
  const hasLLMConfig = Boolean(jsonData.isOpenAIAPIKeySet);
  const hasCurrentMessages = hasPersistableMessages(agent?.state.messages ?? []);
  const visibleSidebarSessions = sessions.slice(0, SIDEBAR_SESSION_MENU_LIMIT);
  const sidebarSessionMenu = (
    <div className={styles.sidebarSessionMenu}>
      <Menu
        ariaLabel="Assistant sessions"
        className={styles.sidebarSessionMenuContent}
        header={
          <div className={styles.sidebarSessionMenuHeader}>
            <span className={styles.sidebarSessionMenuTitle}>Sessions</span>
            <span className={styles.sidebarSessionMenuMeta}>{sessions.length} saved</span>
          </div>
        }
      >
        <Menu.Item disabled={isBusy} icon="plus" label="New chat" onClick={requestNewSession} />
        <Menu.Item disabled={isBusy} icon="import" label="Import session" onClick={openImportSessionPicker} />
        <Menu.Divider />
        {visibleSidebarSessions.map((session) => (
          <Menu.Item
            active={session.id === currentSessionId}
            description={formatDate(session.updatedAt)}
            disabled={isBusy}
            icon="comment-alt"
            key={session.id}
            label={session.title}
            onClick={() => requestLoadSession(session.id)}
          />
        ))}
        {sessions.length === 0 && <Menu.Item disabled label="No saved chats yet" />}
        {sessions.length > SIDEBAR_SESSION_MENU_LIMIT && (
          <>
            <Menu.Divider />
            <Menu.Item
              disabled={isBusy}
              icon="external-link-alt"
              label={`Open full page for ${sessions.length - SIDEBAR_SESSION_MENU_LIMIT} more`}
              onClick={requestOpenFullPage}
            />
          </>
        )}
      </Menu>
    </div>
  );

  return (
    <div
      className={cx(styles.container, isSidebarVariant && styles.containerSidebar)}
      data-testid={testIds.chat.container}
    >
      <ToolConfirmationModal
        confirmation={pendingToolConfirmation}
        onFolderChange={handleDashboardFolderChange}
        onApprove={() => settleToolConfirmation(true)}
        onDeny={() => settleToolConfirmation(false)}
      />
      <ChatLeaveGuardModal action={leaveGuardAction} onCancel={cancelLeaveGuard} onConfirm={confirmLeaveGuard} />
      <input
        accept="application/json,.json"
        data-testid={testIds.chat.importInput}
        disabled={isBusy}
        hidden
        ref={importSessionInputRef}
        type="file"
        onChange={importSessionFromFile}
      />
      {!isSidebarVariant && (
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <div>
              <div className={styles.sidebarTitle}>Sessions</div>
              <div className={styles.sidebarSubtle}>{sessions.length} saved</div>
            </div>
            <div className={styles.sidebarActions}>
              <Button
                aria-label="Import session"
                data-testid={testIds.chat.import}
                disabled={isBusy}
                icon="import"
                size="sm"
                title="Import session"
                type="button"
                variant="secondary"
                onClick={openImportSessionPicker}
              />
              <Button icon="plus" size="sm" variant="secondary" onClick={requestNewSession} aria-label="New session" />
            </div>
          </div>
          <div className={styles.sessionList}>
            {sessions.map((session) => (
              <button
                className={cx(styles.sessionButton, session.id === currentSessionId && styles.sessionButtonActive)}
                key={session.id}
                onClick={() => requestLoadSession(session.id)}
                type="button"
              >
                <span className={styles.sessionTitle}>{session.title}</span>
                <span className={styles.sessionDate}>{formatDate(session.updatedAt)}</span>
              </button>
            ))}
            {sessions.length === 0 && <div className={styles.sidebarSubtle}>No saved chats yet.</div>}
          </div>
        </aside>
      )}

      <main className={styles.main}>
        <div className={cx(styles.toolbar, isSidebarVariant && styles.toolbarSidebar)}>
          <div className={styles.titleGroup}>
            <h2 className={styles.title}>{currentTitle}</h2>
            <Badge text={isStreaming ? streamingBadgeText : 'Ready'} color={isStreaming ? 'blue' : 'green'} />
          </div>
          <div className={styles.toolbarActions}>
            {isSidebarVariant && (
              <>
                <Dropdown overlay={sidebarSessionMenu} placement="bottom-start">
                  <Button
                    aria-label="Sessions"
                    disabled={isBusy}
                    icon="history"
                    size="sm"
                    title="Sessions"
                    type="button"
                    variant="secondary"
                  />
                </Dropdown>
                <Button
                  aria-label="New chat"
                  disabled={isBusy}
                  icon="plus"
                  size="sm"
                  title="New chat"
                  type="button"
                  variant="secondary"
                  onClick={requestNewSession}
                />
                <Button
                  aria-label="Open full page"
                  disabled={isBusy}
                  icon="external-link-alt"
                  size="sm"
                  title="Open full page"
                  type="button"
                  variant="secondary"
                  onClick={requestOpenFullPage}
                />
              </>
            )}
            {isStreaming && !isSidebarVariant && (
              <Button
                aria-label="Abort response"
                data-testid={testIds.chat.stop}
                icon="pause"
                type="button"
                variant="secondary"
                onClick={abortAgent}
              >
                Stop
              </Button>
            )}
            {canDockToSidebar && (
              <Button
                aria-label="Dock to side"
                disabled={Boolean(pendingToolConfirmation)}
                fill="text"
                icon="gf-movepane-right"
                title="Dock to side"
                type="button"
                variant="secondary"
                onClick={requestDockToSidebar}
              >
                Dock to side
              </Button>
            )}
            {!isSidebarVariant && currentSessionId && (
              <>
                <Button
                  data-testid={testIds.chat.export}
                  disabled={isBusy || !hasCurrentMessages}
                  fill="text"
                  icon="file-download"
                  type="button"
                  variant="secondary"
                  onClick={handleExportDownloadClick}
                >
                  Export
                </Button>
                <Button
                  icon="trash-alt"
                  variant="secondary"
                  fill="text"
                  disabled={isBusy || !hasCurrentMessages}
                  onClick={() => deleteSession(currentSessionId)}
                >
                  Delete
                </Button>
              </>
            )}
          </div>
        </div>

        {!hasLLMConfig && (
          <Alert severity="warning" title="LLM API key is not configured">
            Configure the app plugin with an OpenAI-compatible API key before sending prompts.
          </Alert>
        )}
        {error && (
          <Alert severity="error" title="Assistant error" onRemove={() => setError(undefined)}>
            {error}
          </Alert>
        )}

        <div
          className={cx(
            styles.messagesFrame,
            investigationReport && styles.messagesFrameWithReport,
            investigationReport && isSidebarVariant && styles.messagesFrameWithReportSidebar
          )}
        >
          <section
            aria-label="Chat messages"
            className={styles.messages}
            data-testid={testIds.chat.messages}
            ref={messagesContainerRef}
            tabIndex={0}
            onKeyDown={handleMessagesKeyDown}
            onScroll={updateAutoScrollFromPosition}
            onTouchMove={handleMessagesTouchMove}
            onTouchStart={handleMessagesTouchStart}
            onWheel={handleMessagesWheel}
          >
            {visibleMessages.length === 0 && !isStreaming ? (
              <EmptyState
                variant="call-to-action"
                message="Ask about metrics, PromQL, or dashboards"
                button={
                  <Button onClick={() => setInput('Create a dashboard for HTTP request rate and errors')}>
                    Use example
                  </Button>
                }
              />
            ) : (
              visibleMessages.map(({ message, isStreaming }, index) => (
                <MessageView
                  key={messageKey(message, index, isStreaming)}
                  message={message}
                  isStreaming={isStreaming}
                  onOpenDashboard={handleOpenDashboard}
                />
              ))
            )}
            <ToolActivityPanel elapsed={formatRunElapsed(runElapsedMs)} runs={activeToolRuns} />
            {isStreaming && activeToolRuns.length === 0 && (
              <div className={styles.streaming} role="status" aria-live="polite">
                <Spinner />
                <span className={styles.streamingLabel}>{streamingStatusText}</span>
                <span className={styles.streamingElapsed}>{formatRunElapsed(runElapsedMs)}</span>
              </div>
            )}
          </section>
          {investigationReport && (
            <InvestigationReportPanel collapsible={isSidebarVariant} report={investigationReport} />
          )}
          {isAutoScrollPaused && visibleMessages.length > 0 && (
            <Button
              className={styles.jumpToLatest}
              data-testid={testIds.chat.jumpToLatest}
              icon="angle-down"
              size="sm"
              type="button"
              variant="secondary"
              onClick={jumpToLatest}
            >
              Jump to latest
            </Button>
          )}
        </div>

        <form
          className={cx(styles.composer, isSidebarVariant ? styles.composerSidebar : styles.composerPage)}
          onSubmit={submitPrompt}
        >
          <div className={styles.composerInputGroup}>
            <TextArea
              data-testid={testIds.chat.composer}
              rows={isSidebarVariant ? 2 : 3}
              value={input}
              disabled={!agent || isBusy || !hasLLMConfig}
              placeholder="Ask about metrics, PromQL, or dashboards..."
              onChange={(event) => handleInputChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  void submitPrompt(event);
                }
              }}
            />
          </div>
          <div className={cx(styles.composerActions, isSidebarVariant && styles.composerActionsSidebar)}>
            {isStreaming && (
              <Button
                aria-label="Abort response"
                data-testid={isSidebarVariant ? testIds.chat.stop : undefined}
                icon="pause"
                type="button"
                variant="secondary"
                onClick={abortAgent}
              >
                Stop
              </Button>
            )}
            {(!isSidebarVariant || !isStreaming) && (
              <Button
                data-testid={testIds.chat.send}
                icon="message"
                type="submit"
                disabled={!agent || !input.trim() || isBusy || !hasLLMConfig}
              >
                Send
              </Button>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}

function ToolConfirmationModal({
  confirmation,
  onFolderChange,
  onApprove,
  onDeny,
}: {
  confirmation?: ToolConfirmationView;
  onFolderChange: (folderUid: string | undefined, folderTitle: string | undefined) => void;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const styles = useStyles2(getStyles);
  const args = useMemo(() => formatConfirmationArgs(confirmation?.args), [confirmation?.args]);

  return (
    <Modal
      title={confirmation?.title ?? 'Approve Grafana write'}
      isOpen={Boolean(confirmation)}
      closeOnEscape
      onDismiss={onDeny}
      className={styles.toolConfirmationModal}
      contentClassName={styles.toolConfirmationModalContent}
    >
      {confirmation && (
        <div className={styles.toolConfirmation} data-testid={testIds.chat.toolConfirmation}>
          <Alert severity="warning" title="Persistent Grafana write">
            {confirmation.description}
          </Alert>
          <dl className={styles.toolConfirmationFields}>
            <div className={styles.toolConfirmationField}>
              <dt>Tool</dt>
              <dd>{confirmation.toolName}</dd>
            </div>
            {confirmation.fields.map((field) => (
              <div className={styles.toolConfirmationField} key={`${field.label}:${field.value}`}>
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
          {confirmation.saveDashboardFolder && (
            <div className={styles.toolConfirmationFolder}>
              <Field noMargin label="Folder">
                <FolderPicker
                  value={confirmation.saveDashboardFolder.uid ?? ''}
                  onChange={onFolderChange}
                  showRootFolder
                />
              </Field>
            </div>
          )}
          <details className={styles.toolConfirmationDetails}>
            <summary>Tool arguments</summary>
            <pre>{args}</pre>
          </details>
          <div className={styles.toolConfirmationActions}>
            <Button
              data-testid={testIds.chat.toolConfirmationDeny}
              icon="times"
              type="button"
              variant="secondary"
              onClick={onDeny}
            >
              Deny
            </Button>
            <Button
              data-testid={testIds.chat.toolConfirmationApprove}
              icon="check"
              type="button"
              variant="primary"
              onClick={onApprove}
            >
              Approve
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ChatLeaveGuardModal({
  action,
  onCancel,
  onConfirm,
}: {
  action?: ChatLeaveGuardAction;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const styles = useStyles2(getStyles);

  return (
    <Modal
      title={action?.title ?? 'Leave chat?'}
      isOpen={Boolean(action)}
      closeOnEscape
      onDismiss={onCancel}
      className={styles.leaveGuardModal}
    >
      {action && (
        <div className={styles.leaveGuard}>
          <div>{action.description}</div>
          <Modal.ButtonRow>
            <Button type="button" variant="secondary" fill="outline" onClick={onCancel}>
              Stay
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirm}>
              {action.confirmLabel}
            </Button>
          </Modal.ButtonRow>
        </div>
      )}
    </Modal>
  );
}

type InvestigationReportArraySection = 'scope' | 'evidence' | 'hypotheses' | 'ruledOut' | 'nextSteps' | 'remediation';

const INVESTIGATION_REPORT_SECTIONS: Array<{ key: InvestigationReportArraySection; title: string }> = [
  { key: 'scope', title: 'Scope' },
  { key: 'evidence', title: 'Evidence' },
  { key: 'hypotheses', title: 'Hypotheses' },
  { key: 'ruledOut', title: 'Ruled out' },
  { key: 'nextSteps', title: 'Next checks' },
  { key: 'remediation', title: 'Remediation' },
];

function InvestigationReportPanel({
  report,
  collapsible = false,
}: {
  report: InvestigationReport;
  collapsible?: boolean;
}) {
  const styles = useStyles2(getStyles);
  const [isOpen, setIsOpen] = useState(true);
  const bodyId = useId();

  const header = (
    <span className={styles.investigationReportHeader}>
      {collapsible && (
        <Icon
          aria-hidden
          className={styles.investigationReportDisclosureIcon}
          name={isOpen ? 'angle-down' : 'angle-right'}
        />
      )}
      <span className={styles.investigationReportHeaderContent}>
        <span className={styles.investigationReportTitleGroup}>
          <Icon name="search" />
          <span aria-level={3} role="heading">
            {report.title}
          </span>
        </span>
        <Badge
          text={report.status === 'complete' ? 'Complete' : 'Active'}
          color={report.status === 'complete' ? 'green' : 'blue'}
        />
      </span>
    </span>
  );

  const body = (
    <div
      aria-label="Investigation report details"
      className={cx(styles.investigationReportBody, collapsible && styles.investigationReportBodyCollapsible)}
      data-testid={testIds.chat.investigationReportScroll}
      id={bodyId}
      role="region"
      tabIndex={0}
    >
      <div className={styles.investigationReportUpdated}>Updated {formatDate(report.updatedAt)}</div>
      <div className={styles.investigationReportSections}>
        {INVESTIGATION_REPORT_SECTIONS.map((section) => {
          const items = report[section.key];
          return (
            <section className={styles.investigationReportSection} key={section.key}>
              <h4>{section.title}</h4>
              {Array.isArray(items) && items.length > 0 ? (
                <ul>
                  {items.map((item, index) => (
                    <li key={`${section.key}:${index}:${item}`}>{item}</li>
                  ))}
                </ul>
              ) : (
                <div className={styles.investigationReportEmpty}>No entries yet.</div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );

  if (collapsible) {
    return (
      <section
        className={cx(styles.investigationReport, styles.investigationReportCollapsible)}
        data-open={isOpen}
        data-testid={testIds.chat.investigationReport}
      >
        <button
          aria-controls={bodyId}
          aria-expanded={isOpen}
          className={styles.investigationReportDisclosure}
          type="button"
          onClick={() => setIsOpen((open) => !open)}
        >
          {header}
        </button>
        {isOpen && body}
      </section>
    );
  }

  return (
    <aside className={styles.investigationReport} data-testid={testIds.chat.investigationReport}>
      {header}
      {body}
    </aside>
  );
}

const MessageView = memo(function MessageView({
  message,
  isStreaming,
  onOpenDashboard,
}: {
  message: AgentMessage;
  isStreaming?: boolean;
  onOpenDashboard?: DashboardOpenHandler;
}) {
  const styles = useStyles2(getStyles);
  const isUser = message.role === 'user';
  const isTool = message.role === 'toolResult';
  const roleLabel = isTool ? undefined : message.role;

  return (
    <article
      className={cx(
        styles.message,
        isUser && styles.messageUser,
        isTool && styles.messageTool,
        isStreaming && styles.messageStreaming
      )}
    >
      {roleLabel && <div className={styles.messageHeader}>{roleLabel}</div>}
      <div className={styles.messageBody}>{renderMessageContent(message, Boolean(isStreaming), onOpenDashboard)}</div>
    </article>
  );
});

function renderMessageContent(message: AgentMessage, isStreaming: boolean, onOpenDashboard?: DashboardOpenHandler) {
  if (message.role === 'user') {
    return <ContentBlocks content={message.content} markdown={false} />;
  }
  if (message.role === 'assistant') {
    const errorView = formatAssistantError(message.errorMessage, message.stopReason);
    if (errorView) {
      return <AssistantErrorNotice error={errorView} />;
    }

    return <ContentBlocks content={message.content} isStreaming={isStreaming} />;
  }
  if (message.role === 'toolResult') {
    return (
      <ToolResultMessageBody
        toolName={message.toolName}
        content={message.content}
        details={message.details}
        isError={message.isError}
        onOpenDashboard={onOpenDashboard}
      />
    );
  }

  return <pre>{JSON.stringify(message, null, 2)}</pre>;
}

function messageKey(message: AgentMessage, index: number, isStreaming: boolean) {
  const timestamp =
    typeof (message as { timestamp?: unknown }).timestamp === 'number'
      ? (message as { timestamp: number }).timestamp
      : 'untimed';
  return `${message.role}-${timestamp}-${index}${isStreaming ? '-streaming' : ''}`;
}

function AssistantErrorNotice({ error }: { error: AssistantErrorView }) {
  const styles = useStyles2(getStyles);

  return (
    <Alert severity={error.severity} title={error.title}>
      <div className={styles.assistantError}>
        <div>{error.message}</div>
        {error.details && (
          <details>
            <summary>Technical details</summary>
            <pre>{error.details}</pre>
          </details>
        )}
      </div>
    </Alert>
  );
}

function buildToolConfirmation(toolCallId: string, toolName: string, args: unknown): ToolConfirmationView | undefined {
  if (!PERSISTENT_WRITE_TOOLS.has(toolName)) {
    return undefined;
  }

  const record = isRecord(args) ? args : {};
  const id = `confirm-${toolCallId || toolName}-${Date.now()}`;

  if (toolName === 'save_dashboard') {
    const folderUid = stringValue(record.folderUid);
    return {
      id,
      toolCallId,
      toolName,
      title: 'Approve dashboard save',
      description:
        'The assistant wants to create or update an editable Grafana dashboard from Jsonnet. Approve only if this is the dashboard change you requested.',
      fields: compactConfirmationFields([
        confirmationField('UID', stringValue(record.uid) ?? 'compiled dashboard UID'),
        confirmationField('Folder UID', folderUid),
        confirmationField('Overwrite', booleanValue(record.overwrite, true)),
        confirmationField('Source path', stringValue(record.path) ?? 'dashboard.jsonnet'),
        confirmationField('Tags', stringArrayValue(record.tags)),
      ]),
      args,
      saveDashboardFolder: folderUid ? undefined : { title: GENERAL_FOLDER_TITLE },
    };
  }

  if (toolName === 'save_changes' || toolName === 'submit_changes') {
    return {
      id,
      toolCallId,
      toolName,
      title: toolName === 'save_changes' ? 'Approve workspace save' : 'Approve workspace submit',
      description:
        'The assistant wants to persist Coding Agent App Contract workspace changes through the provider backend. Approve only if the validation and diff match the change you requested.',
      fields: compactConfirmationFields([
        confirmationField('Action', toolName === 'save_changes' ? 'Save changes' : 'Submit changes'),
      ]),
      args,
    };
  }

  if (toolName === 'upload_dashboard') {
    const dashboard = parseConfirmationDashboard(record.dashboard_json);
    return {
      id,
      toolCallId,
      toolName,
      title: 'Approve dashboard upload',
      description: 'The assistant wants to create or update a raw Grafana dashboard JSON model as the current user.',
      fields: compactConfirmationFields([
        confirmationField('Title', dashboard.title),
        confirmationField('UID', dashboard.uid),
        confirmationField('Folder UID', stringValue(record.folderUid)),
        confirmationField('Overwrite', booleanValue(record.overwrite, true)),
      ]),
      args,
    };
  }

  return {
    id,
    toolCallId,
    toolName,
    title: 'Approve dashboard deletion',
    description: 'The assistant wants to delete a Grafana dashboard. This removes the dashboard by UID.',
    fields: compactConfirmationFields([confirmationField('UID', stringValue(record.uid))]),
    args,
  };
}

function hasActiveDashboardMutationCommands(dashboardMutationAPI: DashboardMutationAPI | undefined) {
  if (!dashboardMutationAPI) {
    return false;
  }

  try {
    return dashboardMutationAPI.getAvailableCommands().length > 0;
  } catch {
    return false;
  }
}

function isAssistantPluginRoute(route: string) {
  try {
    const pathname = new URL(route, window.location.origin).pathname;
    return pathname === PLUGIN_BASE_URL || pathname.startsWith(`${PLUGIN_BASE_URL}/`);
  } catch {
    const pathname = route.split(/[?#]/, 1)[0] || route;
    return pathname === PLUGIN_BASE_URL || pathname.startsWith(`${PLUGIN_BASE_URL}/`);
  }
}

function confirmationField(label: string, value: unknown) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return { label, value: String(value) };
}

function compactConfirmationFields(fields: Array<{ label: string; value: string } | undefined>) {
  return fields.filter((field): field is { label: string; value: string } => Boolean(field));
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join(', ') : undefined;
}

function parseConfirmationDashboard(value: unknown) {
  try {
    const dashboard = typeof value === 'string' ? JSON.parse(value) : value;
    if (!isRecord(dashboard)) {
      return {};
    }
    return {
      title: stringValue(dashboard.title),
      uid: stringValue(dashboard.uid),
    };
  } catch {
    return {};
  }
}

function formatConfirmationArgs(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function dashboardActionRoute(action: DashboardAction) {
  return (
    (action.url ? grafanaRelativePath(action.url) : undefined) ??
    (action.uid ? `/d/${encodeURIComponent(action.uid)}` : undefined)
  );
}

function grafanaRelativePath(rawUrl: string) {
  const value = rawUrl.trim();
  if (!value || value.startsWith('//')) {
    return undefined;
  }

  if (value.startsWith('/')) {
    return value;
  }

  try {
    const parsed = new URL(value, window.location.origin);
    if (!isSafeGrafanaRoute(parsed.pathname)) {
      return undefined;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}

function isSafeGrafanaRoute(pathname: string) {
  return pathname.startsWith('/d/') || pathname === '/dashboards' || pathname.startsWith('/dashboards/');
}

function chatSessionIdFromSearch(search: string) {
  const value = new URLSearchParams(search).get(CHAT_SESSION_PARAM);
  return value?.trim() || undefined;
}

function buildChatSessionUrl(sessionId: string) {
  const params = new URLSearchParams();
  params.set(CHAT_SESSION_PARAM, sessionId);
  return `${PLUGIN_BASE_URL}/chat?${params.toString()}`;
}

function isAssistantChatPath(pathname: string) {
  const chatPath = `${PLUGIN_BASE_URL}/chat`;
  return pathname === chatPath || pathname.startsWith(`${chatPath}/`);
}

function clearChatSessionParamFromLocation() {
  const location = locationService.getLocation();
  if (isAssistantChatPath(location.pathname) && chatSessionIdFromSearch(location.search)) {
    locationService.partial({ [CHAT_SESSION_PARAM]: null }, true);
  }
}

function setChatSessionParamInLocation(sessionId: string) {
  const location = locationService.getLocation();
  if (isAssistantChatPath(location.pathname) && chatSessionIdFromSearch(location.search) !== sessionId) {
    locationService.partial({ [CHAT_SESSION_PARAM]: sessionId }, true);
  }
}

function createSessionId() {
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

const MAX_SESSION_ARTIFACTS = 40;
const MAX_SESSION_ARTIFACT_BYTES = 8 * 1024 * 1024;

function createArtifactId(index: number) {
  return `artifact_${Math.max(1, Math.floor(index))}`;
}

function nextArtifactCounter(artifacts: Record<string, Artifact>) {
  return Object.keys(artifacts).reduce((max, id) => {
    const match = /^artifact_(\d+)$/.exec(id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

function compactArtifacts(artifacts: Record<string, Artifact>) {
  const sorted = Object.values(artifacts).sort(compareArtifactsByCreatedAt);
  const kept: Record<string, Artifact> = {};
  let totalBytes = 0;

  for (const artifact of sorted) {
    if (Object.keys(kept).length >= MAX_SESSION_ARTIFACTS) {
      break;
    }
    const artifactBytes = Math.max(0, artifact.bytes || artifactByteSize(artifact.data));
    if (totalBytes > 0 && totalBytes + artifactBytes > MAX_SESSION_ARTIFACT_BYTES) {
      continue;
    }
    kept[artifact.id] = {
      ...artifact,
      bytes: artifactBytes,
    };
    totalBytes += artifactBytes;
  }

  return kept;
}

function compareArtifactsByCreatedAt(left: Artifact, right: Artifact) {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}

function reduceToolRuns(state: ToolRunState, event: AgentEvent): ToolRunState {
  if (event.type === 'tool_execution_start') {
    return {
      ...state,
      [event.toolCallId]: {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: 'running',
        updatedAt: Date.now(),
      },
    };
  }

  if (event.type === 'tool_execution_update') {
    const existing = state[event.toolCallId];
    return {
      ...state,
      [event.toolCallId]: {
        ...existing,
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: toolRunStatusFromPartialResult(event.partialResult),
        partialResult: event.partialResult,
        updatedAt: Date.now(),
      },
    };
  }

  if (event.type === 'tool_execution_end') {
    const existing = state[event.toolCallId];
    return {
      ...state,
      [event.toolCallId]: {
        ...existing,
        id: event.toolCallId,
        name: event.toolName,
        args: existing?.args,
        status: event.isError ? 'failed' : 'completed',
        result: event.result,
        isError: event.isError,
        updatedAt: Date.now(),
      },
    };
  }

  return state;
}

function toolRunStatusFromPartialResult(partialResult: { details?: unknown } | undefined): ToolRunView['status'] {
  const details = partialResult?.details;
  if (!details || typeof details !== 'object') {
    return 'running';
  }
  const status = (details as Record<string, unknown>).status;
  if (status === 'completed' || status === 'failed') {
    return status;
  }
  return 'running';
}

function shouldBatchRevision(event: AgentEvent) {
  if (event.type === 'tool_execution_update') {
    return true;
  }
  if (event.type !== 'message_update') {
    return false;
  }
  return !isStreamingMessageMilestone(event.assistantMessageEvent);
}

function isStreamingMessageMilestone(event: unknown) {
  if (!event || typeof event !== 'object') {
    return false;
  }
  const type = (event as Record<string, unknown>).type;
  return type === 'thinking_start' || type === 'text_start' || type === 'toolcall_start' || type === 'toolcall_end';
}

function emitBenchmarkEvent(event: AgentEvent) {
  if (typeof window === 'undefined') {
    return;
  }

  recordSerializedBenchmarkEvent(serializeBenchmarkEvent(event));
}

function recordSerializedBenchmarkEvent(serialized: BenchmarkAgentEvent) {
  if (typeof window === 'undefined') {
    return;
  }

  let recorded = false;

  try {
    if (typeof window.__PI_AGENT_BENCHMARK_RECORD_EVENT__ === 'function') {
      window.__PI_AGENT_BENCHMARK_RECORD_EVENT__(serialized);
      recorded = true;
    }
  } catch {
    // Benchmark instrumentation must not affect chat behavior.
  }

  try {
    if (!recorded && Array.isArray(window.__PI_AGENT_BENCHMARK_EVENTS__)) {
      window.__PI_AGENT_BENCHMARK_EVENTS__.push(serialized);
    } else if (!recorded && isBenchmarkCaptureEnabled()) {
      window.__PI_AGENT_BENCHMARK_EVENTS__ = [...(window.__PI_AGENT_BENCHMARK_EVENTS__ ?? []), serialized];
    }

    if (isBenchmarkCaptureEnabled()) {
      console.info(`${BENCHMARK_EVENT_CONSOLE_PREFIX}${JSON.stringify(serialized)}`);
    }
  } catch {
    // Benchmark instrumentation must not affect chat behavior.
  }
}

function emitBenchmarkTranscriptSnapshot(messages: AgentMessage[]) {
  if (typeof window === 'undefined' || !isBenchmarkCaptureEnabled()) {
    return;
  }

  if ((window.__PI_AGENT_BENCHMARK_EVENTS__?.length ?? 0) > 0) {
    return;
  }

  const timestamp = Date.now();
  const toolCalls = benchmarkToolCallsFromTranscript(messages);
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    if (record?.role !== 'toolResult') {
      continue;
    }
    const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : undefined;
    const toolCall = toolCallId ? toolCalls.get(toolCallId) : undefined;
    const toolName = typeof record.toolName === 'string' ? record.toolName : toolCall?.name;
    if (!toolCallId || !toolName) {
      continue;
    }
    recordSerializedBenchmarkEvent({
      type: 'tool_execution_end',
      timestamp,
      toolCallId,
      toolName,
      args: sanitizeBenchmarkValue(toolCall?.args),
      result: sanitizeBenchmarkValue({
        content: record.content,
        details: record.details,
        isError: record.isError,
      }),
      isError: record.isError === true,
    });
  }

  const finalAssistantMessage = [...messages]
    .reverse()
    .find((message) => (message as unknown as Record<string, unknown>)?.role === 'assistant');
  if (finalAssistantMessage) {
    recordSerializedBenchmarkEvent({
      type: 'message_end',
      timestamp,
      message: summarizeBenchmarkMessage(finalAssistantMessage),
    });
  }
  recordSerializedBenchmarkEvent({
    type: 'agent_end',
    timestamp,
    messageCount: messages.length,
    message: finalAssistantMessage ? summarizeBenchmarkMessage(finalAssistantMessage) : undefined,
  });
}

function benchmarkToolCallsFromTranscript(messages: AgentMessage[]) {
  const toolCalls = new Map<string, { name: string; args: unknown }>();
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    if (record?.role !== 'assistant' || !Array.isArray(record.content)) {
      continue;
    }
    for (const block of record.content) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      const content = block as Record<string, unknown>;
      if (content.type !== 'toolCall' || typeof content.id !== 'string' || typeof content.name !== 'string') {
        continue;
      }
      toolCalls.set(content.id, { name: content.name, args: content.arguments });
    }
  }
  return toolCalls;
}

function isBenchmarkCaptureEnabled() {
  if (window.__PI_AGENT_BENCHMARK_CAPTURE__ === true) {
    return true;
  }

  try {
    return new URLSearchParams(window.location.search).get('piAgentBenchmark') === '1';
  } catch {
    return false;
  }
}

function serializeBenchmarkEvent(event: AgentEvent): BenchmarkAgentEvent {
  const timestamp = Date.now();

  if (event.type === 'agent_end') {
    const finalAssistantMessage = [...event.messages]
      .reverse()
      .find((message) => (message as unknown as Record<string, unknown>)?.role === 'assistant');
    return {
      type: event.type,
      timestamp,
      messageCount: event.messages.length,
      message: finalAssistantMessage ? summarizeBenchmarkMessage(finalAssistantMessage) : undefined,
    };
  }

  if (event.type === 'message_update') {
    return {
      type: event.type,
      timestamp,
      message: summarizeBenchmarkMessage(event.message),
      assistantMessageEvent: sanitizeBenchmarkValue(event.assistantMessageEvent),
    };
  }

  if (event.type === 'message_start' || event.type === 'message_end') {
    return {
      type: event.type,
      timestamp,
      message: summarizeBenchmarkMessage(event.message),
    };
  }

  if (event.type === 'turn_end') {
    return {
      type: event.type,
      timestamp,
      message: summarizeBenchmarkMessage(event.message),
      toolResultCount: event.toolResults.length,
    };
  }

  if (event.type === 'tool_execution_start') {
    return {
      type: event.type,
      timestamp,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: sanitizeBenchmarkValue(event.args),
    };
  }

  if (event.type === 'tool_execution_update') {
    return {
      type: event.type,
      timestamp,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: sanitizeBenchmarkValue(event.args),
      partialResult: sanitizeBenchmarkValue(event.partialResult),
    };
  }

  if (event.type === 'tool_execution_end') {
    return {
      type: event.type,
      timestamp,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: sanitizeBenchmarkValue(event.result),
      isError: event.isError,
    };
  }

  return { type: event.type, timestamp };
}

function summarizeBenchmarkMessage(message: AgentMessage) {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const record = message as unknown as Record<string, unknown>;
  return {
    role: record.role,
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
    content: summarizeBenchmarkContent(record.content),
    usage: summarizeBenchmarkUsage(record.usage),
  };
}

function summarizeBenchmarkUsage(usage: unknown) {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  return {
    input: numberBenchmarkField(record.input),
    output: numberBenchmarkField(record.output),
    cacheRead: numberBenchmarkField(record.cacheRead),
    cacheWrite: numberBenchmarkField(record.cacheWrite),
    totalTokens: numberBenchmarkField(record.totalTokens),
    cost: record.cost,
  };
}

function numberBenchmarkField(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sanitizeBenchmarkValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return truncateBenchmarkText(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return Number.isFinite(value as number) || typeof value === 'boolean' ? value : String(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  if (depth >= 8) {
    return '[MaxDepth]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeBenchmarkValue(item, seen, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    output[key] = sanitizeBenchmarkValue(entry, seen, depth + 1);
  }
  return output;
}

function summarizeBenchmarkContent(content: unknown) {
  if (typeof content === 'string') {
    return truncateBenchmarkText(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  return content.map((block) => {
    if (!block || typeof block !== 'object') {
      return block;
    }

    const record = block as Record<string, unknown>;
    if (record.type === 'text') {
      return { type: record.type, text: truncateBenchmarkText(record.text) };
    }
    if (record.type === 'toolCall') {
      return {
        type: record.type,
        id: record.id,
        name: record.name,
        arguments: sanitizeBenchmarkValue(record.arguments),
      };
    }

    return { type: record.type };
  });
}

function truncateBenchmarkText(value: unknown) {
  if (typeof value !== 'string') {
    return value;
  }
  return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
}

type ScheduledFrame = { kind: 'raf'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> };
type ScheduledRevision = {
  frame: ScheduledFrame;
  watchdog: ReturnType<typeof setTimeout>;
};

function useRunElapsedMs(active: boolean, startedAt: number | undefined) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || startedAt === undefined) {
      return undefined;
    }

    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(interval);
    };
  }, [active, startedAt]);

  return active && startedAt !== undefined ? now - startedAt : 0;
}

function useFrameRevision() {
  const [revision, setRevision] = useState(0);
  const frameRef = useRef<ScheduledRevision>();

  const bumpRevision = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);

  const scheduleRevision = useCallback(() => {
    if (frameRef.current) {
      return;
    }
    const finish = () => {
      const scheduled = frameRef.current;
      if (!scheduled) {
        return;
      }
      frameRef.current = undefined;
      cancelScheduledRevision(scheduled);
      bumpRevision();
    };
    frameRef.current = {
      frame: scheduleFrame(finish),
      watchdog: setTimeout(finish, STREAMING_REVISION_WATCHDOG_MS),
    };
  }, [bumpRevision]);

  const flushRevision = useCallback(() => {
    if (frameRef.current) {
      cancelScheduledRevision(frameRef.current);
      frameRef.current = undefined;
    }
    bumpRevision();
  }, [bumpRevision]);

  useEffect(
    () => () => {
      if (frameRef.current) {
        cancelScheduledRevision(frameRef.current);
      }
    },
    []
  );

  return { revision, flushRevision, scheduleRevision };
}

function cancelScheduledRevision(scheduled: ScheduledRevision) {
  cancelFrame(scheduled.frame);
  clearTimeout(scheduled.watchdog);
}

function scheduleFrame(callback: () => void): ScheduledFrame {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return { kind: 'raf', id: globalThis.requestAnimationFrame(callback) };
  }
  return { kind: 'timeout', id: setTimeout(callback, 16) };
}

function cancelFrame(frame: ScheduledFrame) {
  if (frame.kind === 'raf') {
    globalThis.cancelAnimationFrame(frame.id);
    return;
  }
  clearTimeout(frame.id);
}

function isNearBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

function generateTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length > 56 ? `${normalized.slice(0, 53)}...` : normalized;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function createJsonDownload(data: ChatSessionExport, filename: string) {
  const serialized = JSON.stringify(data, null, 2);
  if (!serialized) {
    throw new Error('Could not serialize chat session export.');
  }

  const blob = new Blob([`${serialized}\n`], { type: 'application/octet-stream;charset=utf-8' });
  return {
    filename,
    url: URL.createObjectURL(blob),
  };
}

function downloadJsonFile(data: ChatSessionExport, filename: string) {
  const download = createJsonDownload(data, filename);
  const anchor = document.createElement('a');
  anchor.href = download.url;
  anchor.download = download.filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  anchor.addEventListener('click', stopDownloadClickPropagation, { capture: true });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(download.url), 60000);
}

function stopDownloadClickPropagation(event: MouseEvent) {
  event.stopPropagation();
}

function chatSessionExportFilename(title: string) {
  const safeTitle = safeFilenamePart(title) || 'assistant-chat-session';
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

function importTitleFromFilename(filename: string) {
  const withoutExtension = filename.replace(/\.json$/i, '').replace(/[-_]+/g, ' ');
  return normalizeSessionTitle(withoutExtension);
}

function parseChatSessionExport(value: unknown): StoredSession {
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
    messages,
    virtualJsonnetFiles: parseVirtualJsonnetFiles(value.session.virtualJsonnetFiles),
    investigationReport: parseInvestigationReport(value.session.investigationReport),
    artifacts: parseArtifacts(value.session.artifacts),
    artifactCounter:
      typeof value.session.artifactCounter === 'number' && Number.isFinite(value.session.artifactCounter)
        ? Math.max(0, Math.floor(value.session.artifactCounter))
        : undefined,
  };
}

function parseInvestigationReport(value: unknown): InvestigationReport | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Import file session.investigationReport must be an object when present.');
  }

  return {
    id: typeof value.id === 'string' && value.id ? value.id : createSessionId(),
    title: typeof value.title === 'string' && value.title.trim() ? generateTitle(value.title) : 'Investigation report',
    status: value.status === 'complete' ? 'complete' : 'active',
    scope: parseStringList(value.scope),
    evidence: parseStringList(value.evidence),
    hypotheses: parseStringList(value.hypotheses),
    ruledOut: parseStringList(value.ruledOut),
    nextSteps: parseStringList(value.nextSteps),
    remediation: parseStringList(value.remediation),
    updatedAt: normalizeDateString(value.updatedAt),
  };
}

function parseStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseVirtualJsonnetFiles(value: unknown): Record<string, VirtualJsonnetFileSnapshot> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Import file session.virtualJsonnetFiles must be an object when present.');
  }

  const files: Record<string, VirtualJsonnetFileSnapshot> = {};
  for (const [key, file] of Object.entries(value)) {
    if (!isRecord(file)) {
      throw new Error(`Imported Jsonnet file ${key} must be an object.`);
    }

    const content = file.content;
    const version = file.version;
    if (typeof content !== 'string' || typeof version !== 'number') {
      throw new Error(`Imported Jsonnet file ${key} must include string content and numeric version.`);
    }

    const path = normalizeJsonnetPath(typeof file.path === 'string' ? file.path : key);
    files[path] = {
      path,
      content,
      version,
      checksum: typeof file.checksum === 'string' ? file.checksum : '',
      lineCount: typeof file.lineCount === 'number' ? file.lineCount : countLines(content),
      dashboardJsonnetSize: typeof file.dashboardJsonnetSize === 'number' ? file.dashboardJsonnetSize : content.length,
      ...(typeof file.updatedAt === 'string' ? { updatedAt: file.updatedAt } : {}),
    };
  }

  return files;
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

function countLines(value: string) {
  return value.split('\n').length;
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'grid',
    gridTemplateColumns: '280px minmax(0, 1fr)',
    gridTemplateRows: 'minmax(0, 1fr)',
    height: 'calc(100vh - 190px)',
    minHeight: 420,
    overflow: 'hidden',
    border: `1px solid ${theme.colors.border.weak}`,
    background: theme.colors.background.primary,
    '@media (max-width: 900px)': {
      gridTemplateColumns: '1fr',
      gridTemplateRows: 'auto minmax(0, 1fr)',
    },
  }),
  containerSidebar: css({
    gridTemplateColumns: 'minmax(0, 1fr)',
    height: '100%',
    minHeight: 0,
    border: 0,
  }),
  sidebar: css({
    display: 'grid',
    gridTemplateRows: 'auto minmax(0, 1fr)',
    borderRight: `1px solid ${theme.colors.border.weak}`,
    background: theme.colors.background.secondary,
    minHeight: 0,
    padding: theme.spacing(2),
    '@media (max-width: 900px)': {
      borderRight: 0,
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      maxHeight: 220,
    },
  }),
  sidebarHeader: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(2),
  }),
  sidebarActions: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  sidebarTitle: css({
    fontWeight: theme.typography.fontWeightMedium,
  }),
  sidebarSubtle: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  sessionList: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    minHeight: 0,
    overflow: 'auto',
  }),
  sessionButton: css({
    display: 'grid',
    gridTemplateRows: 'auto auto',
    alignContent: 'center',
    gap: theme.spacing(0.5),
    flexShrink: 0,
    width: '100%',
    minHeight: 60,
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    color: theme.colors.text.primary,
    textAlign: 'left',
    cursor: 'pointer',
    '&:hover': {
      borderColor: theme.colors.border.medium,
    },
  }),
  sessionButtonActive: css({
    borderColor: theme.colors.primary.border,
    boxShadow: `inset 3px 0 0 ${theme.colors.primary.main}`,
  }),
  sessionTitle: css({
    display: 'block',
    minWidth: 0,
    lineHeight: theme.typography.body.lineHeight,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  sessionDate: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: theme.typography.bodySmall.lineHeight,
  }),
  main: css({
    display: 'flex',
    flexDirection: 'column',
    containerType: 'inline-size',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
  }),
  toolbar: css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: theme.spacing(2),
    padding: theme.spacing(2),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    flexWrap: 'wrap',
  }),
  toolbarSidebar: css({
    gap: theme.spacing(1),
    padding: theme.spacing(1),
  }),
  titleGroup: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  title: css({
    margin: 0,
    fontSize: theme.typography.h4.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  toolbarActions: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
  }),
  sidebarSessionMenu: css({
    background: theme.colors.background.secondary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    boxShadow: theme.shadows.z2,
    width: 'min(280px, calc(100vw - 24px))',
    maxHeight: 'min(420px, calc(100vh - 96px))',
    overflowX: 'hidden',
    overflowY: 'auto',
  }),
  sidebarSessionMenuContent: css({
    width: '100%',
    maxWidth: '100%',
    '& [data-role="menuitem"]': {
      width: '100%',
      maxWidth: '100%',
    },
    '& [data-role="menuitem"] > div': {
      minWidth: 0,
    },
    '& [data-role="menuitem"] span': {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  }),
  sidebarSessionMenuHeader: css({
    display: 'grid',
    gap: theme.spacing(0.25),
    minWidth: 0,
    padding: theme.spacing(1, 1.5, 0.5),
  }),
  sidebarSessionMenuTitle: css({
    color: theme.colors.text.primary,
    fontWeight: theme.typography.fontWeightMedium,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  sidebarSessionMenuMeta: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: theme.typography.bodySmall.lineHeight,
  }),
  messagesFrame: css({
    position: 'relative',
    display: 'grid',
    flex: '1 1 auto',
    minHeight: 0,
  }),
  messagesFrameWithReport: css({
    gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 360px)',
    '@container (max-width: 760px)': {
      gridTemplateColumns: '1fr',
      gridTemplateRows: 'minmax(0, 1fr) auto',
    },
  }),
  messagesFrameWithReportSidebar: css({
    gridTemplateColumns: '1fr',
    gridTemplateRows: 'minmax(120px, 1fr) minmax(0, 360px)',
  }),
  messages: css({
    height: '100%',
    minHeight: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    padding: theme.spacing(2, 2, 7),
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1.5),
    outline: 'none',
    '&:focus-visible': {
      boxShadow: `inset 0 0 0 2px ${theme.colors.primary.border}`,
    },
  }),
  investigationReport: css({
    display: 'grid',
    gridTemplateRows: 'auto minmax(0, 1fr)',
    gap: theme.spacing(1.5),
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    borderLeft: `1px solid ${theme.colors.border.weak}`,
    background: theme.colors.background.secondary,
    padding: theme.spacing(2),
    '@container (max-width: 760px)': {
      borderLeft: 0,
      borderTop: `1px solid ${theme.colors.border.weak}`,
      maxHeight: 360,
    },
  }),
  investigationReportCollapsible: css({
    alignSelf: 'end',
    gap: 0,
    maxHeight: 360,
    width: '100%',
    padding: 0,
    borderLeft: 0,
    borderTop: `1px solid ${theme.colors.border.weak}`,
    '&[data-open="false"]': {
      maxHeight: 'none',
    },
    '&[data-open="true"]': {
      alignSelf: 'stretch',
      height: '100%',
    },
  }),
  investigationReportDisclosure: css({
    appearance: 'none',
    width: '100%',
    minWidth: 0,
    padding: theme.spacing(1.5),
    border: 0,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
    textAlign: 'left',
    '&:focus-visible': {
      outline: `2px solid ${theme.colors.primary.border}`,
      outlineOffset: -2,
    },
  }),
  investigationReportHeader: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  investigationReportHeaderContent: css({
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
    minWidth: 0,
    width: '100%',
  }),
  investigationReportDisclosureIcon: css({
    flex: '0 0 auto',
    color: theme.colors.text.secondary,
  }),
  investigationReportTitleGroup: css({
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.spacing(0.75),
    minWidth: 0,
    '& > svg': {
      flex: '0 0 auto',
      marginTop: theme.spacing(0.25),
    },
    '& [role="heading"]': {
      minWidth: 0,
      display: '-webkit-box',
      overflow: 'hidden',
      WebkitBoxOrient: 'vertical',
      WebkitLineClamp: 2,
      fontSize: theme.typography.h5.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
    },
  }),
  investigationReportBody: css({
    minHeight: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    scrollbarGutter: 'stable',
    touchAction: 'pan-y',
    '&:focus-visible': {
      outline: `2px solid ${theme.colors.primary.border}`,
      outlineOffset: -2,
    },
  }),
  investigationReportBodyCollapsible: css({
    padding: theme.spacing(0, 1.5, 1.5),
  }),
  investigationReportUpdated: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginBottom: theme.spacing(1.5),
  }),
  investigationReportSections: css({
    display: 'grid',
    alignContent: 'start',
    gap: theme.spacing(1.5),
    paddingRight: theme.spacing(0.5),
  }),
  investigationReportSection: css({
    display: 'grid',
    gap: theme.spacing(0.75),
    '& h4': {
      margin: 0,
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
      textTransform: 'uppercase',
    },
    '& ul': {
      display: 'grid',
      gap: theme.spacing(0.5),
      margin: 0,
      paddingLeft: theme.spacing(2.25),
    },
    '& li': {
      overflowWrap: 'anywhere',
    },
  }),
  investigationReportEmpty: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  message: css({
    maxWidth: 980,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(1.5),
    background: theme.colors.background.secondary,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    '& pre': {
      margin: `${theme.spacing(1)} 0 0`,
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
    },
    '& img': {
      maxWidth: '100%',
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
    },
  }),
  messageUser: css({
    alignSelf: 'flex-end',
    background: theme.colors.primary.transparent,
  }),
  messageTool: css({
    borderStyle: 'dashed',
  }),
  messageStreaming: css({
    borderColor: theme.colors.primary.border,
    boxShadow: `inset 3px 0 0 ${theme.colors.primary.main}`,
  }),
  messageHeader: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginBottom: theme.spacing(0.5),
    textTransform: 'uppercase',
  }),
  messageBody: css({
    lineHeight: 1.5,
  }),
  assistantError: css({
    display: 'grid',
    gap: theme.spacing(1),
    '& summary': {
      cursor: 'pointer',
      fontWeight: theme.typography.fontWeightMedium,
    },
    '& pre': {
      margin: `${theme.spacing(1)} 0 0`,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    },
  }),
  streaming: css({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: theme.spacing(1),
    color: theme.colors.text.secondary,
  }),
  streamingLabel: css({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: theme.colors.text.primary,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  streamingElapsed: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  }),
  jumpToLatest: css({
    position: 'absolute',
    right: theme.spacing(2),
    bottom: theme.spacing(2),
    zIndex: 1,
    boxShadow: theme.shadows.z2,
  }),
  composer: css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'end',
    gap: theme.spacing(1),
    padding: theme.spacing(2),
    borderTop: `1px solid ${theme.colors.border.weak}`,
  }),
  composerPage: css({
    '@container (max-width: 700px)': {
      gridTemplateColumns: '1fr',
    },
  }),
  composerSidebar: css({
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    padding: theme.spacing(1.5),
    '@container (max-width: 340px)': {
      gridTemplateColumns: '1fr',
    },
  }),
  composerInputGroup: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  composerActions: css({
    display: 'flex',
    justifyContent: 'flex-end',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
  }),
  composerActionsSidebar: css({
    flexWrap: 'nowrap',
  }),
  toolConfirmationModal: css({
    width: 'min(620px, calc(100vw - 32px))',
  }),
  toolConfirmationModalContent: css({
    minHeight: 260,
  }),
  toolConfirmation: css({
    display: 'grid',
    gap: theme.spacing(2),
  }),
  toolConfirmationFields: css({
    display: 'grid',
    gap: theme.spacing(1),
    margin: 0,
  }),
  toolConfirmationField: css({
    display: 'grid',
    gridTemplateColumns: '140px minmax(0, 1fr)',
    gap: theme.spacing(1),
    alignItems: 'start',
    '& dt': {
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    },
    '& dd': {
      margin: 0,
      overflowWrap: 'anywhere',
    },
    '@media (max-width: 520px)': {
      gridTemplateColumns: '1fr',
      gap: theme.spacing(0.25),
    },
  }),
  toolConfirmationFolder: css({
    display: 'grid',
    gap: theme.spacing(0.75),
    '& label': {
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
    },
  }),
  toolConfirmationDetails: css({
    '& summary': {
      cursor: 'pointer',
      fontWeight: theme.typography.fontWeightMedium,
    },
    '& pre': {
      maxHeight: 220,
      overflow: 'auto',
      margin: `${theme.spacing(1)} 0 0`,
      padding: theme.spacing(1),
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
      background: theme.colors.background.secondary,
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    },
  }),
  toolConfirmationActions: css({
    display: 'flex',
    justifyContent: 'flex-end',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
  }),
  leaveGuardModal: css({
    width: 'min(500px, calc(100vw - 32px))',
  }),
  leaveGuard: css({
    display: 'grid',
    gap: theme.spacing(2),
    color: theme.colors.text.primary,
  }),
});
