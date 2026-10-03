import type { AlertRuleParams, PanelAlertRuleSearchParams } from '../domain/alerts';
import type { AlertNotificationTargets } from './alertRuleModel';
import type {
  DashboardMetricContextParams,
  DashboardMetricSearchParams,
  MetricNeighborhoodParams,
} from '../domain/dashboardMetricContext';
import type { ScreenshotParams } from '../domain/types';
import type { JsonnetEvalRequest, JsonnetFixResponse, JsonnetLibFilesResponse } from '../../../generated/api';
import type { LogsBroker } from './logs';
import type { PromqlParser } from './promqlCheck';
import type { WorkspaceResourceKind, WorkspaceResourceSnapshot } from './types';

/**
 * Typed capabilities that shell commands may use. Commands never receive
 * credentials, fetch functions, or Grafana services directly; every remote
 * operation goes through one of these methods, which run with the current
 * Grafana user's permissions.
 */
export type WorkspaceBroker = {
  dashboards?: DashboardBroker;
  prometheus?: PrometheusBroker;
  /** Restricted Elasticsearch log access (`grafana-logs`). */
  logs?: LogsBroker;
  /** Every datasource visible to the current user, to check what a screenshot would show. */
  datasources?: () => DatasourceRef[];
  jsonnet?: JsonnetBroker;
  /** Upstream Prometheus parser in the plugin backend. */
  promql?: PromqlParser;
  /** Panel-linked alert rule lookup (`grafana-alert find|get`). */
  alerts?: AlertBroker;
  /** Grafana-managed alert rules as working copies under /grafana/alert-rules. */
  alertRules?: AlertRuleBroker;
  /** Prometheus metric usage derived from visible dashboards. */
  metricUsage?: MetricUsageBroker;
  /** Browser navigation and Grafana image rendering. */
  ui?: UiBroker;
  /** The unsaved dashboard open in the browser (sidebar variant with the mutation API). */
  live?: LiveDashboardBroker;
};

export type DatasourceRef = { uid: string; name: string; type: string; isDefault?: boolean };

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
  evaluate: (request: JsonnetEvalRequest, signal?: AbortSignal) => Promise<string>;
  /** Structural repair of common invalid dashboard constructors; returns the repaired source. */
  fix: (source: string, signal?: AbortSignal) => Promise<JsonnetFixResponse>;
  /** Import paths and sizes of the vendored library files, and the packages they belong to. */
  listLibraryFiles: (signal?: AbortSignal) => Promise<JsonnetLibFilesResponse>;
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

/** Reads and conditional writes of one resource kind, used by `workspace apply` and `workspace revert`. */
export type ResourceWriteBroker = {
  get: (uid: string, signal?: AbortSignal) => Promise<WorkspaceResourceSnapshot | undefined>;
  /** Creates a resource; must fail rather than overwrite an existing UID. */
  create: (document: unknown, signal?: AbortSignal) => Promise<DashboardWriteResult>;
  /** Conditional update against the base resourceVersion. */
  update: (document: unknown, resourceVersion: string, signal?: AbortSignal) => Promise<DashboardWriteResult>;
  /** Conditional delete against the base resourceVersion. */
  delete: (uid: string, resourceVersion: string | undefined, signal?: AbortSignal) => Promise<DashboardWriteResult>;
  /** The resource as it was at an earlier resourceVersion, from Grafana's version history. */
  version?: (
    uid: string,
    resourceVersion: string,
    apiVersion: string | undefined,
    signal?: AbortSignal
  ) => Promise<WorkspaceResourceSnapshot | undefined>;
};

/**
 * Grafana-managed alert rules through the App Platform AlertRule API. That API does not
 * enforce resourceVersion preconditions, so update and delete compare the stored revision
 * with the base right before writing and report `conflicted` when it moved.
 */
export type AlertRuleBroker = ResourceWriteBroker & {
  /** Every alert rule visible to the current user, with the titles of their folders. */
  list: (signal?: AbortSignal) => Promise<{ rules: WorkspaceResourceSnapshot[]; folderTitles: Record<string, string> }>;
  /** Contact points, time intervals, and routing trees that notification settings may name. */
  notificationTargets?: (signal?: AbortSignal) => Promise<AlertNotificationTargets>;
  /** Datasource UIDs rules may query, when a central allow-list is configured. */
  allowedDatasourceUids?: () => string[] | undefined;
  /** Prometheus datasource UIDs, to recognize PromQL queries. */
  prometheusDatasourceUids?: () => string[];
};

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
  /** A dashboard as it was at an earlier resourceVersion, from Grafana's version history. */
  version?: (
    uid: string,
    resourceVersion: string,
    apiVersion: string | undefined,
    signal?: AbortSignal
  ) => Promise<WorkspaceResourceSnapshot | undefined>;
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

/** One resource of a change set, as shown in the review. */
export type WorkspaceApprovalOperation = {
  operation: 'create' | 'update' | 'delete';
  /** Missing means a dashboard. */
  kind?: WorkspaceResourceKind;
  uid: string;
  path: string;
  title?: string;
  folderUid?: string;
  folderTitle?: string;
  /** Alert rules: evaluation group. */
  group?: string;
  additions: number;
  deletions: number;
  /** Unified diff of this resource. */
  diff: string;
  warnings: string[];
  /** Validation errors that the fetched resource already had; they do not block the change. */
  preexistingErrors: string[];
};

/**
 * The same textual replacement repeated across the change set, for example
 * `[5m]` → `[$__rate_interval]` in 71 queries of 16 dashboards. Reviewers check
 * one example per group instead of every hunk.
 */
export type WorkspaceChangeGroup = {
  before: string;
  after: string;
  /** Changed lines with this replacement. */
  count: number;
  paths: string[];
  example: { path: string; before: string; after: string };
};

/** Approval requests go to the authenticated UI, outside model-controlled tools. */
export type WorkspaceApprovalRequest = {
  applyId: string;
  digest: string;
  title: string;
  summary: string;
  operations: WorkspaceApprovalOperation[];
  groups: WorkspaceChangeGroup[];
  /** Changed lines that belong to no group of two or more (reviewed per resource). */
  ungroupedChanges: number;
};

export type WorkspaceApprovalDecision = {
  approved: boolean;
  reason?: string;
  /** Operation paths the reviewer kept; undefined applies every operation. */
  paths?: string[];
};

export type WorkspaceApprovalService = {
  request: (request: WorkspaceApprovalRequest, signal?: AbortSignal) => Promise<WorkspaceApprovalDecision>;
};
