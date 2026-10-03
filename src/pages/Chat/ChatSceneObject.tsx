import React, {
  SyntheticEvent,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { css, cx } from '@emotion/css';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { SceneComponentProps, SceneObjectBase, SceneObjectState } from '@grafana/scenes';
import {
  Alert,
  Badge,
  Button,
  Combobox,
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
import { getBackendSrv, locationService } from '@grafana/runtime';
import { useRestrictedGrafanaApis, type DashboardMutationAPI, type GrafanaTheme2 } from '@grafana/data';
import { PLUGIN_BASE_URL, PLUGIN_ID } from '../../constants';
import { testIds } from '../../components/testIds';
import { ChangeSetReviewModal } from './ChangeSetReview';
import { HistorySearch } from './HistorySearch';
import { ShellCompletions } from './ShellCompletions';
import {
  completeShellLine,
  workspaceCompletionSources,
  type CompletionCandidate,
  type CompletionResult,
} from './workspace/completion';
import { DEFAULT_SHELL_CWD } from './workspace/shell';
import { navigatePromptHistory, promptHistory, type PromptHistoryState } from './promptHistory';
import { usePluginMeta } from '../../utils/utils.plugin';
import { formatAssistantError, type AssistantErrorView } from './llmErrors';
import { createGrafanaStreamFn } from './grafanaStream';
import { getConfiguredModels, resolveChatModelSettings, type PiAppJsonData, type PiAppThinkingLevel } from './model';
import {
  finishedTurnSteps,
  pairToolResults,
  parseUserShellInput,
  type ChatMessage,
  type TurnSteps,
} from './chatMessages';
import type { ChatAgentEvent } from './agentEvents';
import { getGrafanaSkills } from './skills';
import {
  ContentBlocks,
  ToolResultMessageBody,
  ToolTranscriptContext,
  UserShellEntry,
  type ToolTranscript,
} from './ToolRenderer';
import {
  buildDashboardAssistantChatUrl,
  consumeDashboardAssistantLaunch,
  consumeDashboardAssistantStoredLaunch,
  dashboardAssistantPrompt,
  dashboardAssistantSessionTitle,
  removeDashboardAssistantLaunchParams,
  storeDashboardAssistantLaunch,
  type DashboardAssistantLaunch,
} from './dashboardLaunch';
import { externalAssistantSessionTitle, type ExternalAssistantLaunch } from './externalAssistantLaunch';
import { getAssistantDockRoute, routeFromLocation, storeAssistantSidebarDockRequest } from './sidebarDock';
import { buildAssistantSidebarPageContextSnapshot } from './sidebarPageContext';
import { createAssistantTelemetryReporter } from './telemetry';
import { formatRunElapsed, runStatusBadgeText, runStatusText } from './streamingStatus';
import { getChatRun, isStoredChatRun, removeChatRun, storeChatRun } from './chatRunRegistry';
import { createGrafanaWorkspaceBroker } from './workspace/grafanaBroker';
import { REPORT_PATH } from './workspace/paths';
import { AssistantSession, type SessionEnvironment, type SessionHost } from './session/AssistantSession';
import { chatExportFilename, type ChatExport } from './session/chatIdentity';
import { ChatLogError, type ChatSummary } from './durable/chatLogClient';
import { grafanaChatLog } from './durable/grafanaChatLog';
import type { AssistantStreamFn } from './durable/models';
import type { TranscriptCompaction } from './durable/transcript';
import { emitBenchmarkEvent } from './benchmarkEvents';
import { createBrowserPythonRunner } from './workspace/python/pythonBrowserRunner';
import { CompactionDivider } from './CompactionNotice';

type ChatSceneObjectState = SceneObjectState;

type SessionIndexItem = ChatSummary;

type ChatLeaveGuardAction = {
  title: string;
  description: string;
  confirmLabel: string;
  stopCurrentAgent?: boolean;
};

type ChatAppVariant = 'page' | 'sidebar';

const ACTIVE_CHAT_LEAVE_MESSAGE =
  'The assistant is still working. Leaving now will stop the run and discard any partial response.';
const DRAFT_CHAT_LEAVE_MESSAGE = 'The current draft message will be discarded.';
const CHAT_SESSION_PARAM = 'session';
const SIDEBAR_SESSION_MENU_LIMIT = 8;
const ASSISTANT_SIDEBAR_PLUGIN_ID = 'grafana-assistant-app';
const STREAMING_REVISION_WATCHDOG_MS = 80;
const THINKING_LEVEL_OPTIONS: Array<{
  description: string;
  label: string;
  value: PiAppThinkingLevel;
}> = [
  { label: 'Off', value: 'off', description: 'Do not request model thinking.' },
  { label: 'Low', value: 'low', description: 'Faster responses with a smaller reasoning budget.' },
  { label: 'Medium', value: 'medium', description: 'A balanced reasoning budget.' },
  { label: 'High', value: 'high', description: 'More reasoning that can take longer.' },
  { label: 'Extra high', value: 'xhigh', description: 'Extra high reasoning for models that support it.' },
  { label: 'Max', value: 'max', description: 'Unconstrained reasoning for models that support it.' },
];

type PluginSettingsResponse = {
  jsonData?: PiAppJsonData;
};

export class ChatSceneObject extends SceneObjectBase<ChatSceneObjectState> {
  static Component = ChatSceneRenderer;
}

function ChatSceneRenderer({ model }: SceneComponentProps<ChatSceneObject>) {
  model.useState();
  return <ChatApp />;
}

export function ChatApp({
  variant = 'page',
  launchContextId,
  sidebarRoute,
  sessionId,
  initialPrompt,
  initialContext,
  initialAutoSend,
  initialChatId,
}: {
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
  const { dashboardMutationAPI } = useRestrictedGrafanaApis();
  const liveDashboardEditingAvailable = hasActiveDashboardMutationCommands(dashboardMutationAPI);
  const pluginMeta = usePluginMeta();
  const pluginMetaJsonData = useMemo(() => (pluginMeta?.jsonData ?? {}) as PiAppJsonData, [pluginMeta?.jsonData]);
  const [settingsJsonData, setSettingsJsonData] = useState<PiAppJsonData | null>();
  const jsonData = useMemo(
    () => ({ ...(settingsJsonData ?? {}), ...pluginMetaJsonData }),
    [pluginMetaJsonData, settingsJsonData]
  );
  const configuredModels = useMemo(() => getConfiguredModels(jsonData), [jsonData]);
  // The session in view. Until the first session is loaded, a detached placeholder.
  const [session, setSession] = useState(() => new AssistantSession());
  const sessionRef = useRef(session);
  // The session this view is the host of; the placeholder before the first load has none.
  const [attachedSession, setAttachedSession] = useState<AssistantSession>();
  const sessionState = useSyncExternalStore(session.subscribeState, session.getState);
  const workspace = session.workspace;
  const transcript = sessionState.transcript;
  const storageState = sessionState.storage;
  const isAttached = attachedSession === session;
  const currentSessionId = session.started ? sessionState.id : undefined;
  const currentTitle = sessionState.title;
  const toolRuns = transcript.toolRuns;
  const runStatus = transcript.runStatus;
  const userShellRunning = sessionState.shellRunning;
  const [isModelSettingsOpen, setIsModelSettingsOpen] = useState(false);
  const modelSelectId = useId();
  const thinkingLevelSelectId = useId();
  const { activeModel, thinkingLevel, canCustomizeThinking, usesBinaryThinking } = useMemo(
    () =>
      resolveChatModelSettings(jsonData, { modelId: sessionState.modelId, thinkingLevel: sessionState.thinkingLevel }),
    [jsonData, sessionState.modelId, sessionState.thinkingLevel]
  );
  const thinkingLevelOptions = usesBinaryThinking
    ? [
        { label: 'Off', value: 'off' as const, description: 'Do not request model thinking.' },
        {
          label: 'On',
          value: activeModel.thinkingLevel,
          description: 'Use the thinking mode configured for this model.',
        },
      ]
    : THINKING_LEVEL_OPTIONS;
  const skills = useMemo(() => getGrafanaSkills(jsonData), [jsonData]);
  const assistantTelemetry = useMemo(() => createAssistantTelemetryReporter(), []);
  const streamFn = useMemo<AssistantStreamFn>(
    () =>
      createGrafanaStreamFn({
        proxyUrl: `/api/plugins/${PLUGIN_ID}/resources/llm`,
        // backendSrv renews an expired session token on 401 before failing this request.
        refreshSession: () => getBackendSrv().get('/api/user', undefined, undefined, { showErrorAlert: false }),
      }),
    []
  );
  const subscribeWorkspace = useCallback(
    (listener: () => void) => {
      const unsubscribe = workspace.subscribe(listener);
      return () => {
        unsubscribe();
      };
    },
    [workspace]
  );
  const report = useSyncExternalStore(subscribeWorkspace, () => workspace.getScratchFile(REPORT_PATH));
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
  const { revision, flushRevision, scheduleRevision } = useFrameRevision();
  const [input, setInput] = useState('');
  const pendingApproval = useSyncExternalStore(session.approvals.subscribe, session.approvals.getSnapshot);
  const pendingToolConfirmation = pendingApproval ? { toolName: 'workspace apply' } : undefined;
  const [sessions, setSessions] = useState<SessionIndexItem[]>([]);
  const [nextSessionCursor, setNextSessionCursor] = useState<string>();
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const unsubscribeRef = useRef<() => void>(undefined);
  const sessionsRef = useRef<SessionIndexItem[]>([]);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesContainerRef = useRef<HTMLElement | null>(null);
  const autoScrollRef = useRef(true);
  const sidebarRouteRef = useRef<string | undefined>(sidebarRoute);
  const lastScrollTopRef = useRef(0);
  const touchStartYRef = useRef<number>(undefined);
  const initialLoadStartedRef = useRef(false);
  const isChatDirtyRef = useRef(false);
  const pendingLeaveActionRef = useRef<() => void>(undefined);
  const allowNextLocationChangeRef = useRef(false);
  const [leaveGuardAction, setLeaveGuardAction] = useState<ChatLeaveGuardAction>();
  const [blockedLocation, setBlockedLocation] = useState<ReturnType<typeof locationService.getLocation>>();
  const [isAutoScrollPaused, setIsAutoScrollPaused] = useState(false);

  const displayedError = error;

  const settleToolConfirmation = useCallback(
    (approved: boolean, paths?: string[]) => sessionRef.current.approvals.settle(approved, paths),
    []
  );

  const workspaceBroker = useMemo(() => createGrafanaWorkspaceBroker(jsonData), [jsonData]);
  const pythonRunner = useMemo(() => createBrowserPythonRunner(), []);

  // What this view offers a session: model access, Grafana capabilities, and storage.
  const environment = useCallback(
    (target: AssistantSession): SessionEnvironment => {
      const { model, thinkingLevel } = resolveChatModelSettings(jsonData, target.getState());
      return {
        jsonData,
        streamFn,
        model,
        thinkingLevel,
        broker: workspaceBroker,
        skills,
        python: pythonRunner,
        getDashboardMutationAPI: liveDashboardEditingAvailable ? () => dashboardMutationAPI : undefined,
        page: buildAssistantSidebarPageContextSnapshot(sidebarRouteRef.current, { liveDashboardEditingAvailable }),
        pageInPrompt: isSidebarVariant,
      };
    },
    [
      dashboardMutationAPI,
      isSidebarVariant,
      jsonData,
      liveDashboardEditingAvailable,
      pythonRunner,
      skills,
      streamFn,
      workspaceBroker,
    ]
  );
  // A stored chat moves to the top of the list and into the URL.
  const onStored = useCallback((summary: ChatSummary) => {
    const next = [summary, ...sessionsRef.current.filter((item) => item.id !== summary.id)];
    sessionsRef.current = next;
    setSessions(next);
    if (sessionRef.current.id === summary.id) {
      setChatSessionParamInLocation(summary.id);
    }
  }, []);
  const hostCallbacksRef = useRef({ environment, onStored });
  useLayoutEffect(() => {
    hostCallbacksRef.current = { environment, onStored };
  }, [environment, onStored]);
  const host = useMemo<SessionHost>(
    () => ({
      environment: (target) => hostCallbacksRef.current.environment(target),
      chatLog: grafanaChatLog(),
      onPromptStart: (context) => assistantTelemetry.recordPromptStart(context),
      onStored: (summary) => hostCallbacksRef.current.onStored(summary),
    }),
    [assistantTelemetry]
  );

  const handleAgentEvent = useCallback(
    (event: ChatAgentEvent) => {
      emitBenchmarkEvent(event);
      assistantTelemetry.recordAgentEvent(event);
      if (event.type === 'agent_end') {
        assistantTelemetry.recordTranscriptSnapshot(sessionRef.current.messages);
      }
      if (event.type === 'task_failed') {
        setError(`The assistant's ${event.kind === 'pi.tool' ? 'tool call' : 'task'} failed: ${event.message}`);
      }
      if (shouldBatchRevision(event)) {
        scheduleRevision();
      } else {
        flushRevision();
      }
    },
    [assistantTelemetry, flushRevision, scheduleRevision, setError]
  );

  /** Detaches the view from its session; unless it keeps running for a handoff, the run stops and the chat closes. */
  const detachSession = useCallback((options?: { preserveLiveRun?: boolean }) => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = undefined;
    const current = sessionRef.current;
    if (!options?.preserveLiveRun || !isStoredChatRun(current)) {
      removeChatRun(current.id);
      void current.stop();
    }
  }, []);

  /** Shows `next` in this view: stops the previous session and attaches this view as the new one's host. */
  const activateSession = useCallback(
    (next: AssistantSession, draft = '') => {
      detachSession();
      sessionRef.current = next;
      next.attach(host);
      unsubscribeRef.current = next.subscribe(handleAgentEvent);
      setSession(next);
      setAttachedSession(next);
      autoScrollRef.current = true;
      setIsAutoScrollPaused(false);
      setError(undefined);
      setInput(draft);
      flushRevision();
    },
    [detachSession, flushRevision, handleAgentEvent, host, setError]
  );

  const startNewSession = useCallback(() => {
    clearChatSessionParamFromLocation();
    activateSession(new AssistantSession());
  }, [activateSession]);

  const startDashboardLaunchSession = useCallback(
    (launch: DashboardAssistantLaunch) => {
      activateSession(
        new AssistantSession({ title: dashboardAssistantSessionTitle(launch), launch: { dashboard: launch } }),
        dashboardAssistantPrompt(launch)
      );
    },
    [activateSession]
  );

  const startExternalAssistantLaunchSession = useCallback(
    (launch: ExternalAssistantLaunch) => {
      activateSession(
        new AssistantSession({ title: externalAssistantSessionTitle(launch.prompt), launch: { external: launch } }),
        launch.prompt
      );
    },
    [activateSession]
  );

  const attachLiveRun = useCallback(
    (run: AssistantSession) => {
      activateSession(run);
      return true;
    },
    [activateSession]
  );

  /** Opens a stored chat; a run a reload interrupted continues. */
  const loadSession = useCallback(
    async (id: string) => {
      const title = sessionsRef.current.find((item) => item.id === id)?.title;
      const next = new AssistantSession({ id, title, stored: true });
      activateSession(next);
      try {
        await next.open();
      } catch (err) {
        if (sessionRef.current === next && err instanceof ChatLogError && err.failure === 'not-found') {
          activateSession(new AssistantSession());
          clearChatSessionParamFromLocation();
          setError('Session not found');
        }
        return false;
      }
      setChatSessionParamInLocation(id);
      return true;
    },
    [activateSession, setError]
  );

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
    sessionRef.current.abort();
    flushRevision();
  }, [flushRevision]);

  const isStreaming = transcript.busy;
  const isBusy = isStreaming || userShellRunning;
  const isStorageLost = storageState.status === 'lost';
  const isShellInput = parseUserShellInput(input) !== undefined;
  const hasDraft = Boolean(input.trim());
  const chatLeaveDescription =
    isStreaming || pendingToolConfirmation ? ACTIVE_CHAT_LEAVE_MESSAGE : DRAFT_CHAT_LEAVE_MESSAGE;
  const isChatDirty = isStreaming || Boolean(pendingToolConfirmation) || hasDraft;

  const keepAutoScrollEnabled = useCallback(() => {
    setAutoScrollEnabled(true);
  }, [setAutoScrollEnabled]);

  const historyRef = useRef<PromptHistoryState>(undefined);
  const [historySearch, setHistorySearch] = useState<{ entries: string[] }>();
  const historySearchOpenRef = useRef(false);
  const [completions, setCompletions] = useState<CompletionResult>();
  const handleInputChange = useCallback(
    (value: string) => {
      // Typing ends history browsing and keeps the text as the new draft.
      historyRef.current = undefined;
      setCompletions(undefined);
      setInput(value);
    },
    [setCompletions]
  );

  /** Up/Down recall earlier prompts and shell commands, like the pi coding agent's editor. */
  const handleHistoryKey = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) {
      return false;
    }
    const element = event.currentTarget;
    const browsing = historyRef.current !== undefined;
    let direction: -1 | 1;
    if (event.key === 'ArrowUp') {
      const onFirstLine = element.value.lastIndexOf('\n', element.selectionStart - 1) === -1;
      const empty = element.value.trim() === '' || element.value.trim() === '!';
      if (!(browsing ? onFirstLine : empty)) {
        return false;
      }
      direction = -1;
    } else if (event.key === 'ArrowDown') {
      if (!browsing || element.value.indexOf('\n', element.selectionEnd) !== -1) {
        return false;
      }
      direction = 1;
    } else {
      return false;
    }
    const step = navigatePromptHistory(historyRef.current, sessionRef.current.messages, element.value, direction);
    if (!step) {
      return false;
    }
    event.preventDefault();
    historyRef.current = step.state;
    setInput(step.text);
    // Put the caret at the end, so Up walks a multi-line entry before moving on.
    requestAnimationFrame(() => element.setSelectionRange(step.text.length, step.text.length));
    return true;
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

      const isActive = Boolean(sessionRef.current.isStreaming || sessionRef.current.approvals.getSnapshot());
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
      detachSession();
    }
    flushRevision();

    if (location) {
      allowNextLocationChangeRef.current = true;
      setTimeout(() => locationService.push(location), 10);
      return;
    }

    action?.();
  }, [blockedLocation, detachSession, flushRevision, leaveGuardAction?.stopCurrentAgent]);

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
  const submitPromptText = useCallback(
    async (prompt: string) => {
      const current = sessionRef.current;
      if (!prompt || current.isStreaming) {
        return;
      }

      setInput('');
      setError(undefined);
      keepAutoScrollEnabled();
      try {
        await current.prompt(prompt);
      } catch (err) {
        // A chat that could not be stored is explained by its own notice.
        if (sessionRef.current === current && current.getState().storage.status !== 'lost') {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (sessionRef.current === current) {
          flushRevision();
        }
      }
    },
    [flushRevision, keepAutoScrollEnabled]
  );

  // `!command` runs in the session shell as the user, without a model call. The
  // result is appended to the transcript, so the agent sees it on the next prompt.
  const runUserShellCommand = useCallback(
    async (command: string) => {
      const current = sessionRef.current;
      if (!command || current.isStreaming || current.getState().shellRunning) {
        return;
      }
      setInput('!');
      setError(undefined);
      keepAutoScrollEnabled();
      try {
        await current.runUserShell(command);
      } catch (err) {
        if (sessionRef.current === current && current.getState().storage.status !== 'lost') {
          setError(`Shell command failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        flushRevision();
        // Stay in the composer for the next command, unless the user moved on to another control.
        if (document.activeElement === document.body || document.activeElement === composerRef.current) {
          composerRef.current?.focus();
        }
      }
    },
    [flushRevision, keepAutoScrollEnabled]
  );

  const submitPrompt = async (event: SyntheticEvent) => {
    event.preventDefault();
    const shellCommand = parseUserShellInput(input);
    if (shellCommand !== undefined) {
      await runUserShellCommand(shellCommand);
      return;
    }
    await submitPromptText(input.trim());
  };

  const initialLoadHandlersRef = useRef({
    attachLiveRun,
    loadSession,
    startDashboardLaunchSession,
    startExternalAssistantLaunchSession,
    startNewSession,
    detachSession,
    submitPromptText,
  });
  const initialLaunchPropsRef = useRef({
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
      startDashboardLaunchSession,
      startExternalAssistantLaunchSession,
      startNewSession,
      detachSession,
      submitPromptText,
    };
    initialLaunchPropsRef.current = {
      launchContextId,
      sessionId,
      initialPrompt,
      initialContext,
      initialAutoSend,
      initialChatId,
    };
  }, [
    attachLiveRun,
    launchContextId,
    loadSession,
    sessionId,
    initialPrompt,
    initialContext,
    initialAutoSend,
    initialChatId,
    startDashboardLaunchSession,
    startExternalAssistantLaunchSession,
    startNewSession,
    detachSession,
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
      const page = await grafanaChatLog().list({});
      const parsed = page.items;
      if (!mounted) {
        return;
      }

      sessionsRef.current = parsed;
      setSessions(parsed);
      setNextSessionCursor(page.nextCursor);
      setSessionsLoading(false);

      const location = locationService.getLocation();
      const {
        launchContextId: initialLaunchContextId,
        sessionId: initialSessionProp,
        initialPrompt: externalPrompt,
        initialContext: externalContext,
        initialAutoSend: externalAutoSend,
        initialChatId: externalChatId,
      } = initialLaunchPropsRef.current;
      // Launch from an external plugin via @grafana/assistant's openAssistant()
      // (see AssistantSidebar.tsx / ChatApp's initialPrompt props). autoSend
      // defaults to true per that package's contract.
      if (externalPrompt) {
        const autoSend = externalAutoSend ?? true;
        const attachedExistingChat =
          externalChatId && (await initialLoadHandlersRef.current.loadSession(externalChatId));
        if (attachedExistingChat) {
          // The loaded session has no launch context; attach it just for this
          // follow-up turn so its context still reaches the model (cleared again
          // right after send, same as a fresh launch).
          sessionRef.current.launch = { external: { prompt: externalPrompt, context: externalContext, autoSend } };
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
      setSessionsLoading(false);
    });

    return () => {
      mounted = false;
      initialLoadHandlersRef.current.detachSession({ preserveLiveRun: true });
    };
  }, [initialConfigPending]);

  const showLoadError = (err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  };

  const deleteSession = async (id: string) => {
    try {
      await grafanaChatLog().delete(id);
      const next = sessionsRef.current.filter((session) => session.id !== id);
      sessionsRef.current = next;
      setSessions(next);
      if (id === currentSessionId) {
        startNewSession();
      }
    } catch (err) {
      showLoadError(err);
    }
  };

  const loadMoreSessions = async () => {
    setSessionsLoading(true);
    try {
      const page = await grafanaChatLog().list({ cursor: nextSessionCursor });
      const ids = new Set(sessionsRef.current.map((item) => item.id));
      const next = [...sessionsRef.current, ...page.items.filter((item) => !ids.has(item.id))];
      sessionsRef.current = next;
      setSessions(next);
      setNextSessionCursor(page.nextCursor);
    } catch (err) {
      showLoadError(err);
    } finally {
      setSessionsLoading(false);
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

    requestGuardedAction(() => void loadSession(id).catch(showLoadError), {
      title: 'Switch sessions?',
      description: chatLeaveDescription,
      confirmLabel: 'Discard and switch',
    });
  };

  const openFullPage = useCallback(async () => {
    const current = sessionRef.current;
    let url = `${PLUGIN_BASE_URL}/chat`;

    try {
      if (current.started) {
        url = buildChatSessionUrl(current.id);
      } else if (current.launch.dashboard) {
        const launch = current.launch.dashboard;
        const contextId = storeDashboardAssistantLaunch(launch);
        url = buildDashboardAssistantChatUrl(launch.action, contextId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    allowNextLocationChangeRef.current = true;
    locationService.push(url);
  }, [setError]);

  const requestOpenFullPage = () => {
    const launch = sessionRef.current.launch.dashboard;
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
    const current = sessionRef.current;
    const targetRoute = getAssistantDockRoute() ?? '/';
    const request = { path: targetRoute };

    try {
      if (current.started) {
        if (current.isStreaming) {
          // The run continues without a view; the sidebar attaches to it by session ID.
          storeChatRun(current);
        }
        storeAssistantSidebarDockRequest({
          ...request,
          sessionId: current.id,
        });
      } else if (current.launch.dashboard) {
        const launch = current.launch.dashboard;
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
  }, [setError]);

  const requestDockToSidebar = () => {
    if (!canDockToSidebar || pendingToolConfirmation) {
      return;
    }

    const launch = sessionRef.current.launch.dashboard;
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

      const current = sessionRef.current;
      if (!current.started || current.isStreaming) {
        return;
      }
      current
        .exportChat(PLUGIN_ID)
        .then((file) => {
          downloadJsonFile(file, chatExportFilename(file.chat.title));
          setError(undefined);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    },
    [setError]
  );

  const conversation = transcript.messages;
  const toolResults = useMemo(() => pairToolResults(conversation), [conversation]);
  const toolTranscript = useMemo<ToolTranscript>(
    () => ({ results: toolResults, runs: toolRuns }),
    [toolResults, toolRuns]
  );
  const visibleMessages: VisibleMessage[] = [
    ...conversation
      .map((message, index) => ({ message, index, isStreaming: false }))
      // Results render with their tool call in the assistant message.
      .filter(({ message }) => message.role !== 'toolResult' || toolResults.get(message.toolCallId) !== message),
    ...(transcript.streamingMessage
      ? [{ message: transcript.streamingMessage, index: conversation.length, isStreaming: true }]
      : []),
  ];
  const pendingApprovalToolName = pendingToolConfirmation?.toolName;
  const displayRunStatus = runStatus;
  const runElapsedMs = useRunElapsedMs(Boolean(isStreaming || pendingApprovalToolName), displayRunStatus?.startedAt);
  const streamingStatusText = runStatusText(displayRunStatus, pendingApprovalToolName);
  const streamingBadgeText = runStatusBadgeText(displayRunStatus, pendingApprovalToolName);
  const hasLLMConfig = Boolean(jsonData.isOpenAIAPIKeySet) && configuredModels.length > 0;
  const canSubmit =
    isAttached &&
    !isStorageLost &&
    !isBusy &&
    (isShellInput ? Boolean(parseUserShellInput(input)) : Boolean(input.trim()) && hasLLMConfig);

  /** Replaces the word being completed in the composer and puts the caret after it. */
  const applyCompletion = (value: string, start: number, end: number, replacement: string) => {
    // Offsets are relative to the shell command after the leading `!`.
    const next = `${value.slice(0, start + 1)}${replacement}${value.slice(end + 1)}`;
    const caret = start + 1 + replacement.length;
    historyRef.current = undefined;
    setInput(next);
    requestAnimationFrame(() => composerRef.current?.setSelectionRange(caret, caret));
  };

  /** Tab in shell mode completes commands, subcommands, options, and paths; ambiguous completions list candidates. */
  const completeShellInput = async (element: HTMLTextAreaElement) => {
    const value = element.value;
    const caret = element.selectionStart;
    if (element.selectionEnd !== caret || caret < 1) {
      return;
    }
    const sources = await workspaceCompletionSources(sessionRef.current.workspace, DEFAULT_SHELL_CWD);
    if (composerRef.current?.value !== value) {
      // The user kept typing while the listing loaded.
      return;
    }
    const result = completeShellLine(value.slice(1), caret - 1, sources);
    if (!result) {
      setCompletions(undefined);
      return;
    }
    const word = value.slice(result.start + 1, result.end + 1);
    if (result.replacement !== word) {
      applyCompletion(value, result.start, result.end, result.replacement);
      setCompletions(result.candidates.length > 1 ? result : undefined);
    } else {
      setCompletions(result.candidates.length > 1 ? result : undefined);
    }
  };

  const selectCompletion = (candidate: CompletionCandidate) => {
    const element = composerRef.current;
    if (!element || !completions) {
      return;
    }
    const current = element.value;
    // The word may have grown by the common prefix since the list opened.
    const end = element.selectionStart - 1;
    applyCompletion(
      current,
      completions.start,
      end,
      candidate.kind === 'directory' ? candidate.value : `${candidate.value} `
    );
    setCompletions(undefined);
    element.focus();
  };

  /** Ctrl+R history search, Esc to leave history or shell mode, Ctrl+C in an empty composer to stop the run. */
  const handleReadlineKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    const plainCtrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (
      event.key === 'Tab' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      element.value.startsWith('!')
    ) {
      // In shell mode Tab completes instead of moving focus; elsewhere it keeps its keyboard-navigation role.
      event.preventDefault();
      void completeShellInput(element);
      return true;
    }
    if (plainCtrl && event.key === 'r') {
      // Also keeps Linux and Windows browsers from reloading the page.
      event.preventDefault();
      historySearchOpenRef.current = true;
      setHistorySearch({ entries: promptHistory(sessionRef.current.messages) });
      return true;
    }
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      if (completions) {
        event.preventDefault();
        setCompletions(undefined);
        return true;
      }
      if (historyRef.current) {
        event.preventDefault();
        setInput(historyRef.current.draft);
        historyRef.current = undefined;
        return true;
      }
      if (element.value.trim() === '!') {
        event.preventDefault();
        setInput('');
        return true;
      }
      return false;
    }
    const empty = element.value.trim() === '' || element.value.trim() === '!';
    if (plainCtrl && event.key === 'c' && empty && element.selectionStart === element.selectionEnd && isStreaming) {
      event.preventDefault();
      abortAgent();
      return true;
    }
    return false;
  };

  const closeHistorySearch = (accepted?: string) => {
    // Accepting focuses the composer, which blurs the search input and would cancel a second time.
    if (!historySearchOpenRef.current) {
      return;
    }
    historySearchOpenRef.current = false;
    setHistorySearch(undefined);
    if (accepted !== undefined) {
      historyRef.current = undefined;
      setInput(accepted);
    }
    requestAnimationFrame(() => {
      const element = composerRef.current;
      element?.focus();
      if (element && accepted !== undefined) {
        element.setSelectionRange(accepted.length, accepted.length);
      }
    });
  };
  const hasCurrentMessages = conversation.length > 0;
  const visibleSidebarSessions = sessions.slice(0, SIDEBAR_SESSION_MENU_LIMIT);
  const sidebarSessionMenu = (
    <div className={styles.sidebarSessionMenu}>
      <Menu
        ariaLabel="Assistant sessions"
        className={styles.sidebarSessionMenuContent}
        header={
          <div className={styles.sidebarSessionMenuHeader}>
            <span className={styles.sidebarSessionMenuTitle}>Sessions</span>
            <span className={styles.sidebarSessionMenuMeta}>
              {sessionsLoading ? 'Loading…' : `${sessions.length}${nextSessionCursor ? '+' : ''} saved`}
            </span>
          </div>
        }
      >
        <Menu.Item disabled={isBusy} icon="plus" label="New chat" onClick={requestNewSession} />
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
        {sessions.length === 0 && !sessionsLoading && <Menu.Item disabled label="No saved chats yet" />}
        {(sessions.length > SIDEBAR_SESSION_MENU_LIMIT || nextSessionCursor) && (
          <>
            <Menu.Divider />
            <Menu.Item
              disabled={isBusy}
              icon="external-link-alt"
              label="Open full page for more sessions"
              onClick={requestOpenFullPage}
            />
          </>
        )}
      </Menu>
    </div>
  );
  const modelSettingsLabel = `Chat settings, current model ${activeModel.name}`;

  return (
    <div
      className={cx(styles.container, isSidebarVariant && styles.containerSidebar)}
      data-testid={testIds.chat.container}
    >
      <ChangeSetReviewModal
        request={pendingApproval}
        onApprove={(paths) => settleToolConfirmation(true, paths)}
        onDeny={() => settleToolConfirmation(false)}
      />
      <ChatLeaveGuardModal action={leaveGuardAction} onCancel={cancelLeaveGuard} onConfirm={confirmLeaveGuard} />
      <Modal
        className={styles.modelSettingsModal}
        closeOnEscape
        isOpen={isModelSettingsOpen}
        title="Chat settings"
        onDismiss={() => setIsModelSettingsOpen(false)}
      >
        {configuredModels.length > 0 && (
          <Field
            description={
              configuredModels.length === 1
                ? 'The model configured for this assistant.'
                : 'Used for future responses in this chat.'
            }
            htmlFor={modelSelectId}
            label="Model"
          >
            <Combobox
              disabled={isBusy || !hasLLMConfig || configuredModels.length === 1}
              id={modelSelectId}
              options={configuredModels.map((model) => ({
                description: model.name === model.id ? undefined : model.id,
                label: model.name,
                value: model.id,
              }))}
              value={activeModel.id}
              onChange={(option) => sessionRef.current.setModelSettings({ modelId: option.value })}
            />
          </Field>
        )}
        {canCustomizeThinking && (
          <Field
            description={
              usesBinaryThinking
                ? 'This model format supports turning thinking on or off.'
                : 'Controls reasoning effort for future responses in this chat. Higher levels can take longer.'
            }
            htmlFor={thinkingLevelSelectId}
            label="Thinking level"
          >
            <Combobox<PiAppThinkingLevel>
              disabled={isBusy || !hasLLMConfig}
              id={thinkingLevelSelectId}
              options={thinkingLevelOptions}
              value={thinkingLevel}
              onChange={(option) =>
                sessionRef.current.setModelSettings({ modelId: sessionState.modelId, thinkingLevel: option.value })
              }
            />
          </Field>
        )}
        <Modal.ButtonRow>
          <Button type="button" onClick={() => setIsModelSettingsOpen(false)}>
            Done
          </Button>
        </Modal.ButtonRow>
      </Modal>
      {!isSidebarVariant && (
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <div>
              <div className={styles.sidebarTitle}>Sessions</div>
              <div className={styles.sidebarSubtle}>
                {sessionsLoading ? 'Loading…' : `${sessions.length}${nextSessionCursor ? '+' : ''} saved`}
              </div>
            </div>
            <div className={styles.sidebarActions}>
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
            {sessions.length === 0 && !sessionsLoading && (
              <div className={styles.sidebarSubtle}>No saved chats yet.</div>
            )}
            {nextSessionCursor && (
              <Button disabled={sessionsLoading} variant="secondary" onClick={loadMoreSessions}>
                Load more sessions
              </Button>
            )}
          </div>
        </aside>
      )}

      <main className={styles.main}>
        <div className={cx(styles.toolbar, isSidebarVariant && styles.toolbarSidebar)}>
          <div className={styles.titleGroup}>
            <h2 className={styles.title}>{currentTitle}</h2>
            <Badge text={isStreaming ? streamingBadgeText : 'Ready'} color={isStreaming ? 'blue' : 'green'} />
            {storageState.status === 'opening' && <Badge text="Opening…" color="blue" />}
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
              </>
            )}
            {configuredModels.length > 0 && (
              <Button
                aria-label={modelSettingsLabel}
                data-testid={testIds.chat.modelSelect}
                disabled={isBusy || !hasLLMConfig}
                fill={isSidebarVariant ? undefined : 'text'}
                icon="sliders-v-alt"
                size={isSidebarVariant ? 'sm' : 'md'}
                title={modelSettingsLabel}
                type="button"
                variant="secondary"
                onClick={() => setIsModelSettingsOpen(true)}
              />
            )}
            {isSidebarVariant && (
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
          <Alert severity="warning" title="LLM is not configured">
            Configure the app plugin with an OpenAI-compatible API key and at least one model before sending prompts.
          </Alert>
        )}
        {storageState.status === 'lost' && (
          <Alert
            severity={storageState.reason === 'lease' ? 'info' : 'error'}
            title={storageState.reason === 'lease' ? 'Chat opened elsewhere' : 'Chat unavailable'}
            data-testid={testIds.chat.storageLost}
          >
            <div className={styles.storageLost}>
              <span>
                {storageState.message}
                {storageState.reason === 'lease' && ' This view no longer receives its updates.'}
              </span>
              {storageState.reason !== 'deleted' && (
                <Button size="sm" variant="secondary" onClick={() => void loadSession(sessionState.id)}>
                  Open here
                </Button>
              )}
            </div>
          </Alert>
        )}
        {displayedError && (
          <Alert severity="error" title="Assistant error" onRemove={() => setError(undefined)}>
            {displayedError}
          </Alert>
        )}

        <div
          className={cx(
            styles.messagesFrame,
            report && styles.messagesFrameWithReport,
            report && isSidebarVariant && styles.messagesFrameWithReportSidebar
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
              <ToolTranscriptContext.Provider value={toolTranscript}>
                <Transcript
                  compactions={transcript.compactions}
                  isStreaming={isStreaming}
                  messages={visibleMessages}
                  toolResults={toolResults}
                />
              </ToolTranscriptContext.Provider>
            )}
            {isStreaming && (
              <div className={styles.streaming} role="status" aria-live="polite">
                <Spinner />
                <span className={styles.streamingLabel}>{streamingStatusText}</span>
                <span className={styles.streamingElapsed}>{formatRunElapsed(runElapsedMs)}</span>
              </div>
            )}
          </section>
          {report && <ReportPanel collapsible={isSidebarVariant} markdown={report.content} updatedAt={report.mtime} />}
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
            {completions && isShellInput && (
              <ShellCompletions candidates={completions.candidates} onSelect={selectCompletion} />
            )}
            {historySearch && (
              <HistorySearch
                entries={historySearch.entries}
                onAccept={(text) => closeHistorySearch(text)}
                onCancel={() => closeHistorySearch()}
              />
            )}
            {isShellInput && (
              <div className={styles.composerShellMode} data-testid={testIds.chat.shellMode}>
                <Icon name="brackets-curly" /> Shell mode: runs in this chat&apos;s session filesystem, without the
                model. The agent sees the output on your next message.
              </div>
            )}
            <TextArea
              ref={composerRef}
              className={cx(isShellInput && styles.composerShellInput)}
              spellCheck={!isShellInput}
              data-testid={testIds.chat.composer}
              rows={isSidebarVariant ? 2 : 3}
              value={input}
              // Stays editable while the assistant or a command runs, so focus and the next draft are kept.
              disabled={!isAttached || isStorageLost || (!hasLLMConfig && !isShellInput)}
              placeholder="Ask about metrics, PromQL, or dashboards (! runs a shell command; Shift+Enter for a new line)"
              onChange={(event) => handleInputChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (handleHistoryKey(event) || handleReadlineKey(event)) {
                  return;
                }
                // Enter sends, Shift+Enter inserts a new line; Enter that confirms an IME composition does neither.
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
                  return;
                }
                event.preventDefault();
                if (canSubmit) {
                  historyRef.current = undefined;
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
                icon={isShellInput ? 'play' : 'message'}
                type="submit"
                disabled={!canSubmit}
              >
                {isShellInput ? 'Run' : 'Send'}
              </Button>
            )}
          </div>
        </form>
      </main>
    </div>
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

/** Renders REPORT_PATH; the first `# heading` becomes the panel title. */
function ReportPanel({
  markdown,
  updatedAt,
  collapsible = false,
}: {
  markdown: string;
  updatedAt: number;
  collapsible?: boolean;
}) {
  const styles = useStyles2(getStyles);
  const [isOpen, setIsOpen] = useState(true);
  const bodyId = useId();
  const heading = /^#\s+(.+)$/m.exec(markdown);
  const title = heading?.[1].trim() || 'Report';
  const body = heading ? markdown.replace(heading[0], '').trim() : markdown.trim();

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
          <Icon name="file-alt" />
          <span aria-level={3} role="heading">
            {title}
          </span>
        </span>
      </span>
    </span>
  );

  const content = (
    <div
      aria-label="Report details"
      className={cx(styles.investigationReportBody, collapsible && styles.investigationReportBodyCollapsible)}
      data-testid={testIds.chat.investigationReportScroll}
      id={bodyId}
      role="region"
      tabIndex={0}
    >
      <div className={styles.investigationReportUpdated}>
        <code>{REPORT_PATH}</code> · updated {formatDate(new Date(updatedAt).toISOString())}
      </div>
      <div className={styles.investigationReportSections}>
        <ContentBlocks content={body} />
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
        {isOpen && content}
      </section>
    );
  }

  return (
    <aside className={styles.investigationReport} data-testid={testIds.chat.investigationReport}>
      {header}
      {content}
    </aside>
  );
}

/** `index` is the message's position in the transcript. */
type VisibleMessage = { message: ChatMessage; index: number; isStreaming: boolean };

/**
 * Renders the messages, folding the steps of finished turns behind their summary line.
 * With a compaction summary, a divider precedes the first turn the model still sees verbatim.
 */
function Transcript({
  messages,
  toolResults,
  isStreaming,
  compactions,
}: {
  messages: VisibleMessage[];
  toolResults: ReadonlyMap<string, ToolResultMessage>;
  isStreaming: boolean;
  compactions: TranscriptCompaction[];
}) {
  const turnSteps = finishedTurnSteps(
    messages.map(({ message }) => message),
    toolResults,
    isStreaming
  );
  const stepsByStart = new Map(turnSteps.map((steps) => [steps.start, steps]));
  // Expanded turn steps continue the card that holds their summary line.
  const renderMessage = ({ message, isStreaming }: VisibleMessage, index: number, isTurnStep = false) => (
    <MessageView
      key={messageKey(message, index, isStreaming)}
      message={message}
      isStreaming={isStreaming}
      continuesTurn={isTurnStep || (message.role === 'assistant' && messages[index - 1]?.message.role === 'assistant')}
      continuedInTurn={message.role === 'assistant' && messages[index + 1]?.message.role === 'assistant'}
    />
  );
  const dividers = compactions.map((compaction) => ({
    compaction,
    at: compactionDividerIndex(messages, compaction.index),
  }));
  const views: React.ReactNode[] = [];
  let index = 0;
  while (index < messages.length) {
    const steps = stepsByStart.get(index);
    for (const divider of dividers) {
      if (divider.at >= index && divider.at <= (steps?.end ?? index)) {
        views.push(
          <CompactionDivider compaction={divider.compaction} key={`compaction-${divider.compaction.index}`} />
        );
      }
    }
    if (!steps) {
      views.push(renderMessage(messages[index], index));
      index += 1;
      continue;
    }
    const first = index;
    views.push(
      <TurnStepsView key={`steps-${messageKey(messages[first].message, first, false)}`} steps={steps}>
        {messages.slice(steps.start, steps.end + 1).map((entry, offset) => renderMessage(entry, first + offset, true))}
      </TurnStepsView>
    );
    index = steps.end + 1;
  }
  return <>{views}</>;
}

/**
 * Where the verbatim part of the model's context begins: the first turn after
 * the summarized messages, or the first unsummarized message when the cut is within a turn.
 */
function compactionDividerIndex(messages: VisibleMessage[], coveredMessages: number) {
  const turnStart = messages.findIndex(
    ({ message, index }) => index >= coveredMessages && (message.role === 'user' || message.role === 'userShell')
  );
  return turnStart >= 0 ? turnStart : messages.findIndex(({ index }) => index >= coveredMessages);
}

/** The tool-calling steps of a finished turn, folded into one line above its answer. */
function TurnStepsView({ steps, children }: { steps: TurnSteps; children: React.ReactNode }) {
  const styles = useStyles2(getStyles);
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <article className={cx(styles.message, styles.messageContinuedInTurn)}>
        <div className={styles.messageHeader}>assistant</div>
        <button
          aria-expanded={isOpen}
          className={styles.turnStepsToggle}
          type="button"
          onClick={() => setIsOpen((open) => !open)}
        >
          <Icon aria-hidden name={isOpen ? 'angle-down' : 'angle-right'} />
          <span>
            {steps.toolCalls} tool {steps.toolCalls === 1 ? 'call' : 'calls'}
            {steps.durationMs !== undefined && ` · ${formatTurnDuration(steps.durationMs)}`}
          </span>
          {steps.failedToolCalls > 0 && (
            <span className={styles.turnStepsFailed}>· {steps.failedToolCalls} failed</span>
          )}
        </button>
      </article>
      {isOpen && children}
    </>
  );
}

function formatTurnDuration(ms: number) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

const MessageView = memo(function MessageView({
  message,
  isStreaming,
  continuesTurn,
  continuedInTurn,
}: {
  message: ChatMessage;
  isStreaming?: boolean;
  /** An assistant message that directly follows another one in the same turn. */
  continuesTurn?: boolean;
  /** An assistant message that another assistant message directly follows. */
  continuedInTurn?: boolean;
}) {
  const styles = useStyles2(getStyles);
  const isUser = message.role === 'user';
  const isShell = message.role === 'userShell';
  const isTool = message.role === 'toolResult';
  // The `!` prompt of a user shell entry already says who ran it.
  const roleLabel = isTool || continuesTurn || message.role === 'userShell' ? undefined : message.role;

  return (
    <article
      className={cx(
        styles.message,
        isUser && styles.messageUser,
        isShell && styles.messageShell,
        isTool && styles.messageTool,
        // Consecutive assistant messages of one turn read as one card.
        continuesTurn && styles.messageContinuesTurn,
        continuedInTurn && styles.messageContinuedInTurn,
        isStreaming && styles.messageStreaming
      )}
    >
      {roleLabel && <div className={styles.messageHeader}>{roleLabel}</div>}
      <div className={styles.messageBody}>{renderMessageContent(message, Boolean(isStreaming))}</div>
    </article>
  );
});

function renderMessageContent(message: ChatMessage, isStreaming: boolean) {
  if (message.role === 'user') {
    return <ContentBlocks content={message.content} markdown={false} />;
  }
  if (message.role === 'assistant') {
    if (message.stopReason === 'aborted') {
      // Keep what the model streamed before the user stopped it.
      return (
        <>
          {hasVisibleContent(message.content) && <ContentBlocks content={message.content} />}
          <StoppedNotice />
        </>
      );
    }
    const errorView = formatAssistantError(message.errorMessage, message.stopReason);
    if (errorView) {
      return <AssistantErrorNotice error={errorView} />;
    }

    return <ContentBlocks content={message.content} isStreaming={isStreaming} />;
  }
  if (message.role === 'userShell') {
    return <UserShellEntry result={message.result} />;
  }
  if (message.role === 'toolResult') {
    return (
      <ToolResultMessageBody
        toolName={message.toolName}
        content={message.content}
        details={message.details}
        isError={message.isError}
      />
    );
  }

  return <pre>{JSON.stringify(message, null, 2)}</pre>;
}

function messageKey(message: ChatMessage, index: number, isStreaming: boolean) {
  const timestamp =
    typeof (message as { timestamp?: unknown }).timestamp === 'number'
      ? (message as { timestamp: number }).timestamp
      : 'untimed';
  return `${message.role}-${timestamp}-${index}${isStreaming ? '-streaming' : ''}`;
}

function hasVisibleContent(content: AssistantMessage['content']) {
  return content.some(
    (block) =>
      (block.type === 'text' && block.text.trim() !== '') ||
      (block.type === 'thinking' && block.thinking.trim() !== '') ||
      block.type === 'toolCall'
  );
}

function StoppedNotice() {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.stoppedNotice} data-testid={testIds.chat.stoppedNotice}>
      <Icon name="square-shape" size="xs" /> Stopped
    </div>
  );
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

function hasActiveDashboardMutationCommands(dashboardMutationAPI: DashboardMutationAPI | undefined) {
  if (!dashboardMutationAPI) {
    return false;
  }

  try {
    // Live editing replaces the whole unsaved spec, so both halves of the full-spec surface are required.
    const commands = dashboardMutationAPI.getAvailableCommands().map(String);
    return commands.includes('GET_SPEC') && commands.includes('APPLY_SPEC');
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

function shouldBatchRevision(event: ChatAgentEvent) {
  return event.type === 'tool_execution_update' || event.type === 'message_update';
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
  const frameRef = useRef<ScheduledRevision>(undefined);

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

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function createJsonDownload(data: ChatExport, filename: string) {
  const serialized = JSON.stringify(data, null, 2);
  if (!serialized) {
    throw new Error('Could not serialize the chat export.');
  }

  const blob = new Blob([`${serialized}\n`], { type: 'application/octet-stream;charset=utf-8' });
  return {
    filename,
    url: URL.createObjectURL(blob),
  };
}

function downloadJsonFile(data: ChatExport, filename: string) {
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
  messageContinuesTurn: css({
    marginTop: `-${theme.spacing(1.5)}`,
    paddingTop: 0,
    borderTop: 'none',
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
  }),
  messageContinuedInTurn: css({
    paddingBottom: theme.spacing(0.5),
    borderBottom: 'none',
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  }),
  turnStepsToggle: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    padding: 0,
    border: 'none',
    background: 'none',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    cursor: 'pointer',
    '&:hover': {
      color: theme.colors.text.primary,
    },
  }),
  turnStepsFailed: css({
    color: theme.colors.error.text,
  }),
  messageShell: css({
    padding: 0,
    border: 'none',
    background: 'none',
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
  stoppedNotice: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
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
  composerShellMode: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  composerShellInput: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    borderColor: theme.colors.warning.border,
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
  storageLost: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
  }),
  leaveGuardModal: css({
    width: 'min(500px, calc(100vw - 32px))',
  }),
  modelSettingsModal: css({
    width: 'min(440px, calc(100vw - 32px))',
    maxHeight: 'calc(100vh - 32px)',
    top: '50%',
    transform: 'translateY(-50%)',
  }),
  leaveGuard: css({
    display: 'grid',
    gap: theme.spacing(2),
    color: theme.colors.text.primary,
  }),
});
