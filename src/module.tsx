import React, { Suspense, lazy } from 'react';
import {
  AppPlugin,
  BusEventWithPayload,
  PluginExtensionPoints,
  type AppRootProps,
  type PluginExtensionEventHelpers,
  type PluginExtensionPanelContext,
} from '@grafana/data';
import { initPluginTranslations } from '@grafana/i18n';
import { getAppEvents, locationService } from '@grafana/runtime';
import { loadResources } from '@grafana/scenes';
import { LoadingPlaceholder } from '@grafana/ui';
import type { AppConfigProps } from './components/AppConfig/AppConfig';
import {
  buildDashboardAssistantChatUrl,
  storeDashboardAssistantContext,
  type DashboardAssistantAction,
} from './pages/Chat/dashboardLaunch';
import type { AgentWorkspaceLaunchPayload } from './pages/Chat/agentWorkspace/types';
import {
  consumeAssistantSidebarDockRequest,
  rememberAssistantDockRoute,
  routeFromLocation,
  type AssistantSidebarDockRequest,
} from './pages/Chat/sidebarDock';
import pluginJson from 'plugin.json';

await initPluginTranslations(pluginJson.id, [loadResources]);

const LazyApp = lazy(() => import('./components/App/App'));
const LazyAppConfig = lazy(() => import('./components/AppConfig/AppConfig'));
const LazyAssistantSidebar = lazy(() => import('./pages/Chat/AssistantSidebar'));
const ASSISTANT_PLUGIN_ID = 'grafana-assistant-app';
// The `grafana-assistant-app`-ID build is meant to be a drop-in for the
// official Grafana Assistant so other plugins can integrate with it via the
// `@grafana/assistant` npm package. That package's `isAssistantAvailable()`
// checks the registered ExtensionSidebar component for both the plugin id
// AND an exact title match against `ASSISTANT_PLUGIN_TITLE = 'Grafana
// Assistant'` - so this must match that string for the compat variant, or
// third-party `OpenAssistantButton`/`useAssistant()` consumers silently see
// `isAvailable: false` and the button never renders, even though the
// plugin id itself is correct. Keep the shorter "Assistant" label for the
// default g42-pi-app build, which doesn't need to satisfy that contract.
const ASSISTANT_SIDEBAR_TITLE = pluginJson.id === ASSISTANT_PLUGIN_ID ? 'Grafana Assistant' : 'Assistant';
const ASSISTANT_SIDEBAR_OPEN_RETRY_DELAYS_MS = [0, 100, 300];

type OpenExtensionSidebarPayload = {
  props?: Record<string, unknown>;
  pluginId: string;
  componentTitle: string;
};

class OpenExtensionSidebarEvent extends BusEventWithPayload<OpenExtensionSidebarPayload> {
  static type = 'open-extension-sidebar';
}

declare global {
  interface Window {
    __G42_PI_APP_ASSISTANT_SIDEBAR_DOCKING__?: boolean;
  }
}

const App = (props: AppRootProps) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyApp {...props} />
  </Suspense>
);

const AppConfig = (props: AppConfigProps) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyAppConfig {...props} />
  </Suspense>
);

const AssistantSidebar = (props: {
  action?: DashboardAssistantAction;
  agentWorkspaceLaunch?: AgentWorkspaceLaunchPayload;
  contextId?: string;
  path?: string;
  sessionId?: string;
  // Forwarded verbatim to AssistantSidebar - see the prop-shape comment on
  // AssistantSidebarProps in AssistantSidebar.tsx.
  initialPrompt?: string;
  initialContext?: unknown[];
  initialAutoSend?: boolean;
  origin?: string;
  initialMode?: string;
  chatId?: string;
  appendContext?: boolean;
}) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyAssistantSidebar {...props} />
  </Suspense>
);

let appPlugin = new AppPlugin<{}>()
  .setRootPage(App)
  .addConfigPage({
    title: 'Configuration',
    icon: 'cog',
    body: AppConfig,
    id: 'configuration',
  })
  .addLink<PluginExtensionPanelContext>({
    title: 'Explain in Assistant',
    description: 'Explain what this panel shows',
    targets: [PluginExtensionPoints.DashboardPanelMenu],
    onClick: openDashboardAssistant('explain'),
  })
  .addLink<PluginExtensionPanelContext>({
    title: 'Troubleshoot panel',
    description: 'Diagnose why this panel may be empty, noisy, misleading, or unhealthy',
    targets: [PluginExtensionPoints.DashboardPanelMenu],
    onClick: openDashboardAssistant('troubleshoot'),
  })
  .addLink<PluginExtensionPanelContext>({
    title: 'Suggest improvements',
    description: 'Suggest query, visualization, threshold, and layout improvements for this panel',
    targets: [PluginExtensionPoints.DashboardPanelMenu],
    onClick: openDashboardAssistant('improve'),
  });

if (pluginJson.id === ASSISTANT_PLUGIN_ID) {
  setupAssistantSidebarDocking();
  appPlugin = appPlugin
    .addComponent({
      title: ASSISTANT_SIDEBAR_TITLE,
      description: 'Open Assistant in the Grafana extension sidebar',
      targets: [PluginExtensionPoints.ExtensionSidebar],
      component: AssistantSidebar,
    })
    .addLink<{ path?: string }>({
      title: ASSISTANT_SIDEBAR_TITLE,
      description: 'Show Assistant in the Grafana extension sidebar',
      targets: [PluginExtensionPoints.ExtensionSidebar],
      configure: (context) => {
        const path = typeof context?.path === 'string' ? context.path : currentGrafanaRoute();
        return isAssistantAppPath(path) ? undefined : {};
      },
      onClick: (event, { context, toggleSidebar }) => {
        event?.preventDefault();
        toggleSidebar(ASSISTANT_SIDEBAR_TITLE, {
          path: typeof context?.path === 'string' ? context.path : currentGrafanaRoute(),
        });
      },
    });
}

export const plugin = appPlugin;

function openDashboardAssistant(action: DashboardAssistantAction) {
  return (
    event: React.MouseEvent | undefined,
    { context, openSidebar }: PluginExtensionEventHelpers<PluginExtensionPanelContext>
  ) => {
    event?.preventDefault();

    let contextId: string | undefined;
    if (context) {
      try {
        contextId = storeDashboardAssistantContext(context, action);
      } catch (err) {
        console.warn('Could not store dashboard Assistant context', err);
      }
    }

    if (pluginJson.id === ASSISTANT_PLUGIN_ID) {
      openSidebar(ASSISTANT_SIDEBAR_TITLE, {
        action,
        contextId,
        path: currentGrafanaRoute(),
      });
      return;
    }

    locationService.push(buildDashboardAssistantChatUrl(action, contextId));
  };
}

function isAssistantAppPath(path: string) {
  const appPath = `/a/${ASSISTANT_PLUGIN_ID}`;
  const pathname = routePathname(path);
  return pathname === appPath || pathname.startsWith(`${appPath}/`);
}

function setupAssistantSidebarDocking() {
  if (typeof window === 'undefined' || window.__G42_PI_APP_ASSISTANT_SIDEBAR_DOCKING__) {
    return;
  }

  window.__G42_PI_APP_ASSISTANT_SIDEBAR_DOCKING__ = true;
  const handleLocation = (location: ReturnType<typeof locationService.getLocation>) => {
    const route = routeFromLocation(location);
    if (!route || isAssistantAppPath(location.pathname)) {
      return;
    }

    rememberAssistantDockRoute(route);
    const request = consumeAssistantSidebarDockRequest();
    if (request) {
      openAssistantSidebarWithRetry(request);
    }
  };

  handleLocation(locationService.getLocation());
  locationService.getLocationObservable().subscribe(handleLocation);
}

function openAssistantSidebarWithRetry(request: AssistantSidebarDockRequest) {
  const props = compactRecord({
    action: request.action,
    contextId: request.contextId,
    path: request.path,
    sessionId: request.sessionId,
  });

  for (const delay of ASSISTANT_SIDEBAR_OPEN_RETRY_DELAYS_MS) {
    window.setTimeout(() => {
      getAppEvents().publish(
        new OpenExtensionSidebarEvent({
          pluginId: ASSISTANT_PLUGIN_ID,
          componentTitle: ASSISTANT_SIDEBAR_TITLE,
          props,
        })
      );
    }, delay);
  }
}

function compactRecord<T extends Record<string, unknown>>(record: T) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function currentGrafanaRoute() {
  const location = locationService.getLocation();
  return routeFromLocation(location) ?? location.pathname ?? '/';
}

function routePathname(route: string) {
  try {
    return new URL(route, window.location.origin).pathname;
  } catch {
    return route.split(/[?#]/, 1)[0] || route;
  }
}
