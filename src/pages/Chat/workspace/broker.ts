import type { AlertRuleParams, PanelAlertRuleSearchParams } from '../domain/alerts';
import type {
  DashboardMetricContextParams,
  DashboardMetricSearchParams,
  MetricNeighborhoodParams,
} from '../domain/dashboardMetricContext';
import type { ScreenshotParams } from '../domain/types';
import type { PromqlParser } from './promqlCheck';
import type { WorkspaceResourceSnapshot } from './types';

/**
 * Typed capabilities that shell commands may use. Commands never receive
 * credentials, fetch functions, or Grafana services directly; every remote
 * operation goes through one of these methods, which run with the current
 * Grafana user's permissions.
 */
export type WorkspaceBroker = {
  dashboards?: DashboardBroker;
  prometheus?: PrometheusBroker;
  jsonnet?: JsonnetBroker;
  /** Upstream Prometheus parser in the plugin backend. */
  promql?: PromqlParser;
  /** Read-only Grafana-managed alert rules. */
  alerts?: AlertBroker;
  /** Prometheus metric usage derived from visible dashboards. */
  metricUsage?: MetricUsageBroker;
  /** Browser navigation and Grafana image rendering. */
  ui?: UiBroker;
  /** The unsaved dashboard open in the browser (sidebar variant with the mutation API). */
  live?: LiveDashboardBroker;
};

export type LiveDashboardSnapshot = {
  uid: string;
  info: Record<string, unknown>;
  /** v2 DashboardSpec of the unsaved browser state. */
  spec: Record<string, unknown>;
  revision: string;
};

export type LiveDashboardBroker = {
  available: () => boolean;
  get: (signal?: AbortSignal) => Promise<LiveDashboardSnapshot>;
  /** Replaces the unsaved dashboard; returns the re-serialized spec (element names may be rekeyed). */
  apply: (
    spec: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<{ spec?: Record<string, unknown>; warnings: string[] }>;
};

export type AlertBroker = {
  findPanelRules: (params: PanelAlertRuleSearchParams, signal?: AbortSignal) => Promise<unknown>;
  getRule: (params: AlertRuleParams, signal?: AbortSignal) => Promise<unknown>;
};

export type MetricUsageBroker = {
  /** `resource` is a local working copy; without it the dashboard is fetched by UID. */
  inspect: (
    params: DashboardMetricContextParams,
    options: { resource?: Record<string, any>; meta?: Record<string, any>; signal?: AbortSignal }
  ) => Promise<unknown>;
  search: (params: DashboardMetricSearchParams, signal?: AbortSignal) => Promise<unknown>;
  neighborhood: (params: MetricNeighborhoodParams, signal?: AbortSignal) => Promise<unknown>;
};

export type DashboardImage = { data: string; mimeType: string; width: number; height: number };

export type UiBroker = {
  /** Opens a Grafana-relative path in the browser. */
  navigate: (path: string) => void;
  screenshot?: (params: ScreenshotParams, signal?: AbortSignal) => Promise<DashboardImage>;
};

/** Stateless Jsonnet evaluation with the plugin's vendored libraries (grafonnet, pi-dashboard helpers). */
export type JsonnetBroker = {
  evaluate: (
    request: {
      entrypoint: string;
      files: Record<string, string>;
      extStr?: Record<string, string>;
      tlaStr?: Record<string, string>;
      string?: boolean;
    },
    signal?: AbortSignal
  ) => Promise<string>;
  /** Structural repair of common invalid dashboard constructors; returns the repaired source. */
  fix: (source: string, signal?: AbortSignal) => Promise<{ source: string; repairs: string[] }>;
  /** Import paths and sizes of the vendored library files, and the packages they belong to. */
  listLibraryFiles: (
    signal?: AbortSignal
  ) => Promise<{ packages: string[]; files: Array<{ path: string; size: number }> }>;
  /** Contents of every file in one vendored package, keyed by import path. */
  loadLibraryPackage: (pkg: string, signal?: AbortSignal) => Promise<Record<string, string>>;
};

export type DashboardSearchHit = {
  uid: string;
  title: string;
  folderUid?: string;
  folderTitle?: string;
  tags: string[];
  url?: string;
};

export type DashboardSearchPage = {
  hits: DashboardSearchHit[];
  /** True when the server may hold more results beyond this page. */
  hasMore: boolean;
};

export type DashboardWriteResult = {
  outcome: 'applied' | 'conflicted' | 'failed' | 'unknown';
  snapshot?: WorkspaceResourceSnapshot;
  url?: string;
  error?: string;
};

export type DashboardDryRunResult = { ok: boolean; status?: number; message?: string };

export type DashboardBroker = {
  search: (
    query: { query?: string; tags?: string[]; folderUids?: string[]; limit: number; page: number },
    signal?: AbortSignal
  ) => Promise<DashboardSearchPage>;
  get: (uid: string, signal?: AbortSignal) => Promise<WorkspaceResourceSnapshot | undefined>;
  /** Creates a dashboard; must fail rather than overwrite an existing UID. */
  create: (document: unknown, signal?: AbortSignal) => Promise<DashboardWriteResult>;
  /** Conditional update against the base resourceVersion. */
  update: (document: unknown, resourceVersion: string, signal?: AbortSignal) => Promise<DashboardWriteResult>;
  /** Conditional delete against the base resourceVersion. */
  delete: (uid: string, resourceVersion: string | undefined, signal?: AbortSignal) => Promise<DashboardWriteResult>;
  /**
   * Sends the document to Grafana with `dryRun=All&fieldValidation=Strict`: the
   * same request as an update (with the resourceVersion precondition) or create,
   * without persisting. Checks decoding, admission, permissions, and conflicts.
   */
  dryRun?: (
    document: unknown,
    resourceVersion: string | undefined,
    signal?: AbortSignal
  ) => Promise<DashboardDryRunResult>;
  /** Whether a folder UID exists and is visible to the current user. */
  folderExists?: (uid: string, signal?: AbortSignal) => Promise<boolean>;
  /** Datasource UIDs dashboards may reference, when a central allow-list is configured. */
  allowedDatasourceUids?: () => string[] | undefined;
};

export type PrometheusDatasourceInfo = {
  uid: string;
  name: string;
  isDefault?: boolean;
  /** Datasource scrape interval (jsonData.timeInterval): the minimum query step, as in Grafana panels. */
  timeInterval?: string;
};

export type PrometheusBroker = {
  datasources: () => PrometheusDatasourceInfo[];
  metricNames: (
    datasourceUid: string | undefined,
    signal?: AbortSignal
  ) => Promise<{ datasourceUid: string; names: string[] }>;
  labelNames: (
    datasourceUid: string | undefined,
    match: string | undefined,
    signal?: AbortSignal
  ) => Promise<{ datasourceUid: string; names: string[] }>;
  labelValues: (
    datasourceUid: string | undefined,
    label: string,
    match: string | undefined,
    signal?: AbortSignal
  ) => Promise<{ datasourceUid: string; values: string[] }>;
  series: (
    datasourceUid: string | undefined,
    match: string,
    limit: number,
    signal?: AbortSignal
  ) => Promise<{ datasourceUid: string; series: Array<Record<string, string>>; truncated: boolean }>;
  /**
   * Runs prepared dashboard targets through /api/ds/query and returns the raw
   * response for bounded processing by the caller. Rejects any datasource other
   * than the allowed Prometheus datasources and server-side expressions.
   */
  queryData?: (
    request: { queries: Array<Record<string, unknown>>; from: string; to: string },
    signal?: AbortSignal
  ) => Promise<unknown>;
  /** Returns a compact, bounded query summary (never raw frames). */
  query: (
    datasourceUid: string | undefined,
    spec: { query: string; type: 'instant' | 'range'; start?: string; end?: string; step?: string },
    signal?: AbortSignal
  ) => Promise<Record<string, unknown>>;
};

/** Approval requests go to the authenticated UI, outside model-controlled tools. */
export type WorkspaceApprovalRequest = {
  applyId: string;
  digest: string;
  title: string;
  summary: string;
  operations: Array<{ operation: string; uid: string; title?: string; path: string; warnings: number }>;
  diff: string;
};

export type WorkspaceApprovalService = {
  request: (request: WorkspaceApprovalRequest, signal?: AbortSignal) => Promise<{ approved: boolean; reason?: string }>;
};
