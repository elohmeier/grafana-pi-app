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
  listLibraries: (path: string | undefined, signal?: AbortSignal) => Promise<{ basePath: string; files: string[] }>;
  readLibrary: (
    path: string,
    window: { offset?: number; limit?: number },
    signal?: AbortSignal
  ) => Promise<{ path: string; totalLines: number; lines: Array<{ line: number; text: string }> }>;
  searchLibraries: (
    pattern: string,
    path: string | undefined,
    signal?: AbortSignal
  ) => Promise<{ matches: Array<{ file: string; line: number; text: string }>; capped: boolean }>;
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
  /** Whether a folder UID exists and is visible to the current user. */
  folderExists?: (uid: string, signal?: AbortSignal) => Promise<boolean>;
  /** Datasource UIDs dashboards may reference, when a central allow-list is configured. */
  allowedDatasourceUids?: () => string[] | undefined;
};

export type PrometheusDatasourceInfo = {
  uid: string;
  name: string;
  isDefault?: boolean;
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
  /** Returns a compact, bounded query summary (never raw frames). */
  query: (
    datasourceUid: string | undefined,
    spec: { query: string; type: 'instant' | 'range'; start?: string; end?: string },
    signal?: AbortSignal
  ) => Promise<Record<string, unknown>>;
};

/** Approval requests go to the authenticated UI, outside model-controlled tools. */
export type WorkspaceApprovalRequest = {
  planId: string;
  digest: string;
  title: string;
  summary: string;
  operations: Array<{ operation: string; uid: string; title?: string; path: string; warnings: number }>;
  diff: string;
};

export type WorkspaceApprovalService = {
  request: (request: WorkspaceApprovalRequest, signal?: AbortSignal) => Promise<{ approved: boolean; reason?: string }>;
};
