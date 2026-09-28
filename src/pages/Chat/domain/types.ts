import type { DataSourceApi } from '@grafana/data';
import type { PiAppJsonData } from '../../../types';

export type GrafanaToolConfig = Pick<PiAppJsonData, 'allowedPrometheusDatasourceUids'>;

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
  /** Range query resolution such as 30s or 5m. */
  step?: string;
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
