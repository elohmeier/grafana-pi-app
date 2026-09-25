import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentTool,
  AgentToolResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import type { DashboardMutationAPI, DataSourceApi } from '@grafana/data';
import type { PiAppJsonData, PiAppThinkingLevel } from '../../../types';
import type { SkillToolGroup } from '../skills/types';
import type { ArtifactRuntime } from './artifacts';

export type GrafanaToolConfig = Pick<PiAppJsonData, 'allowedPrometheusDatasourceUids'>;

export type GrafanaToolRuntime = {
  model: Model<any>;
  streamFn: StreamFn;
  thinkingLevel: PiAppThinkingLevel;
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
  emitToolUpdate?: (update: GrafanaToolRuntimeToolUpdate) => void;
};

export type GrafanaToolRuntimeToolUpdate = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: AgentToolResult<any>;
};

export type InvestigationReportStatus = 'active' | 'complete';

export type InvestigationReport = {
  id: string;
  title: string;
  status: InvestigationReportStatus;
  scope: string[];
  evidence: string[];
  hypotheses: string[];
  ruledOut: string[];
  nextSteps: string[];
  remediation: string[];
  updatedAt: string;
};

export type InvestigationReportPatch = {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
};

export type InvestigationReportRuntime = {
  getReport: () => InvestigationReport | undefined;
  setReport: (report: InvestigationReport) => void;
};

export type CreateGrafanaToolsOptions = GrafanaToolConfig & {
  runtime?: GrafanaToolRuntime;
  dashboardMutation?: DashboardMutationAPI;
  /** Session filesystem tools (read/write/edit/bash). */
  workspaceTools?: AgentTool[];
  investigationReport?: InvestigationReportRuntime;
  artifacts?: ArtifactRuntime;
};

export type ResourceCapableDataSource = DataSourceApi & {
  getResource?: <T = unknown>(path: string, params?: Record<string, unknown>) => Promise<T>;
};

export type PrometheusMetadataResponse<T> = {
  status?: string;
  data?: T;
  error?: string;
};

export type DashboardSearchResult = {
  title: string;
  uid: string;
  url: string;
  folderTitle?: string;
  folderUid?: string;
};

export type PrometheusQuerySpec = {
  query: string;
  type?: 'instant' | 'range';
  start?: string;
  end?: string;
};

export type DashboardUidParams = {
  uid: string;
};

export type ScreenshotParams = DashboardUidParams & {
  panelId?: number;
  from?: string;
  to?: string;
  width?: number;
  height?: number;
  theme?: 'dark' | 'light';
};

export type { SkillToolGroup };
