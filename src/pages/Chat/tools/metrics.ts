import {
  CoreApp,
  dateTime,
  getDefaultTimeRange,
  LoadingState,
  type DataFrame,
  type DataQueryRequest,
  type DataQueryResponse,
  type DataSourceInstanceSettings,
  type TimeRange,
  type Field,
} from '@grafana/data';
import { config, getDataSourceSrv } from '@grafana/runtime';
import { lastValueFrom, type Observable } from 'rxjs';
import { backendFetch, formatBackendFetchError } from './client';
import { throwIfAborted } from './result';
import type { GrafanaToolConfig, PrometheusQuerySpec, ResourceCapableDataSource } from './types';

export function filterAllowedPrometheusDatasourceSettings(
  datasources: DataSourceInstanceSettings[],
  allowedPrometheusDatasourceUids?: string[]
) {
  const allowedUids = new Set((allowedPrometheusDatasourceUids ?? []).filter(Boolean));

  return datasources.filter((ds) => ds.type === 'prometheus' && (allowedUids.size === 0 || allowedUids.has(ds.uid)));
}

export function getAllowedPrometheusDatasourceUids(toolConfig: GrafanaToolConfig) {
  return toolConfig.allowedPrometheusDatasourceUids;
}

export type PrometheusQueryValidationSummary = PrometheusQuerySummary & {
  validationError?: string;
};

export async function runPrometheusQuerySummaryOrValidationError(
  ds: ResourceCapableDataSource,
  querySpec: PrometheusQuerySpec,
  signal?: AbortSignal
): Promise<PrometheusQueryValidationSummary> {
  try {
    return await runPrometheusQuerySummary(ds, querySpec, signal);
  } catch (error) {
    throwIfAborted(signal);
    return failedPrometheusQuerySummary(ds, querySpec, error);
  }
}

async function runPrometheusQuerySummary(
  ds: ResourceCapableDataSource,
  querySpec: PrometheusQuerySpec,
  signal?: AbortSignal
): Promise<PrometheusQuerySummary> {
  const queryType = querySpec.type ?? 'instant';
  const timeRange =
    queryType === 'range' ? makeTimeRange(querySpec.start ?? 'now-1h', querySpec.end ?? 'now') : getDefaultTimeRange();
  const interval = queryType === 'range' ? chooseRangeInterval(timeRange) : '1m';
  try {
    const response = await runPrometheusQuery(ds, querySpec.query, queryType, timeRange, interval, signal);
    const frames = response.data ?? [];
    return summarizePrometheusQuery({
      datasourceUid: ds.uid,
      query: querySpec.query,
      queryType,
      interval,
      timeRange,
      frames,
    });
  } catch (error) {
    throwIfAborted(signal);
    const summary = await runPrometheusResourceQuerySummary(
      ds,
      querySpec.query,
      queryType,
      timeRange,
      interval,
      signal
    ).catch(() => {
      throw error;
    });
    summary.notices.unshift({
      severity: 'info',
      text: `Grafana datasource query failed; used Prometheus resource fallback: ${formatBackendFetchError(error)}`,
    });
    return summary;
  }
}

async function runPrometheusResourceQuerySummary(
  ds: ResourceCapableDataSource,
  query: string,
  queryType: 'instant' | 'range',
  timeRange: TimeRange,
  interval: string,
  signal?: AbortSignal
): Promise<PrometheusQuerySummary> {
  const response =
    queryType === 'range'
      ? await getDatasourceResource<PrometheusQueryApiResponse>(
          ds,
          'api/v1/query_range',
          {
            query,
            start: timeRange.from.toISOString(),
            end: timeRange.to.toISOString(),
            step: String((durationToMs(interval) ?? 60000) / 1000),
          },
          signal
        )
      : await getDatasourceResource<PrometheusQueryApiResponse>(
          ds,
          'api/v1/query',
          {
            query,
            time: timeRange.to.toISOString(),
          },
          signal
        );

  if (response.status && response.status !== 'success') {
    throw new Error(response.error || response.errorType || 'Prometheus resource query failed');
  }

  return summarizePrometheusApiQuery({
    datasourceUid: ds.uid,
    query,
    queryType,
    interval,
    timeRange,
    response,
  });
}

function failedPrometheusQuerySummary(
  ds: ResourceCapableDataSource,
  querySpec: PrometheusQuerySpec,
  error: unknown
): PrometheusQueryValidationSummary {
  const queryType = querySpec.type ?? 'instant';
  const timeRange =
    queryType === 'range' ? makeTimeRange(querySpec.start ?? 'now-1h', querySpec.end ?? 'now') : getDefaultTimeRange();
  const interval = queryType === 'range' ? chooseRangeInterval(timeRange) : '1m';
  const message = error instanceof Error ? error.message : String(error);

  return {
    datasourceUid: ds.uid,
    query: querySpec.query,
    queryType,
    interval,
    range: {
      from: timeRange.from.toISOString(),
      to: timeRange.to.toISOString(),
      raw: timeRange.raw,
    },
    frameCount: 0,
    totalSeries: 0,
    truncatedSeries: false,
    notices: [{ severity: 'error', text: message }],
    executedQueryStrings: [],
    series: [],
    validationError: message,
  };
}

export function getPrometheusDatasourceSettings(toolConfig: GrafanaToolConfig) {
  return filterAllowedPrometheusDatasourceSettings(
    getDataSourceSrv().getList({ metrics: true }),
    getAllowedPrometheusDatasourceUids(toolConfig)
  );
}

export async function getPrometheusDatasource(
  toolConfig: GrafanaToolConfig,
  uid?: string
): Promise<ResourceCapableDataSource> {
  const available = getPrometheusDatasourceSettings(toolConfig);
  const selected = uid ? available.find((ds) => ds.uid === uid) : available[0];

  if (!selected) {
    throw new Error(
      uid
        ? `Datasource is not available to the assistant: ${uid}`
        : 'No Prometheus datasource is available to the assistant'
    );
  }

  return getDataSourceSrv().get({ uid: selected.uid, type: selected.type }) as Promise<ResourceCapableDataSource>;
}

export async function getDatasourceResource<T>(
  ds: ResourceCapableDataSource,
  path: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  try {
    return await withPrometheusRetry({ operation: 'resource request', datasourceUid: ds.uid, signal }, async () => {
      if (typeof ds.getResource === 'function') {
        return await ds.getResource<T>(path, params);
      }

      const settings = getDataSourceSrv().getInstanceSettings(ds.getRef());
      if (!settings?.uid) {
        throw new Error('Datasource does not expose resource calls');
      }

      return await backendFetch<T>(`/api/datasources/uid/${encodeURIComponent(settings.uid)}/resources/${path}`, {
        params,
      });
    });
  } catch (error) {
    throw new Error(
      `Prometheus resource ${path} failed for datasource ${ds.uid ?? 'unknown'}: ${formatBackendFetchError(error)}`
    );
  }
}

async function runPrometheusQuery(
  ds: ResourceCapableDataSource,
  query: string,
  queryType: 'instant' | 'range',
  timeRange: TimeRange,
  interval: string,
  signal?: AbortSignal
): Promise<DataQueryResponse> {
  const intervalMs = durationToMs(interval) ?? 60000;
  const target = {
    refId: 'A',
    datasource: { uid: ds.uid, type: ds.type },
    expr: query,
    range: queryType === 'range',
    instant: queryType === 'instant',
    interval,
    editorMode: 'code',
  } as DataQueryRequest['targets'][number];

  return withPrometheusRetry({ operation: 'Prometheus query', datasourceUid: ds.uid, signal }, async (attempt) => {
    const request: DataQueryRequest = {
      app: CoreApp.Unknown,
      requestId: `observability-query-${Date.now()}-${attempt}`,
      interval,
      intervalMs,
      maxDataPoints: PROMETHEUS_QUERY_MAX_DATA_POINTS,
      range: timeRange,
      rangeRaw: timeRange.raw,
      scopedVars: {},
      targets: [target],
      timezone: config.bootData.user.timezone || 'browser',
      startTime: Date.now(),
    };

    const response = await resolveQueryResponse(ds.query(request));
    if (response.state === LoadingState.Error) {
      throw prometheusQueryResponseError(response);
    }

    return response;
  });
}

async function withPrometheusRetry<T>(
  options: {
    operation: string;
    datasourceUid?: string;
    signal?: AbortSignal;
  },
  execute: (attempt: number) => Promise<T>
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= PROMETHEUS_TRANSIENT_RETRY_ATTEMPTS; attempt++) {
    throwIfAborted(options.signal);

    try {
      return await execute(attempt);
    } catch (error) {
      throwIfAborted(options.signal);
      lastError = error;

      if (!isRetryablePrometheusError(error)) {
        throw error;
      }

      if (attempt >= PROMETHEUS_TRANSIENT_RETRY_ATTEMPTS) {
        const datasource = options.datasourceUid ? ` for datasource ${options.datasourceUid}` : '';
        throw new Error(
          `${options.operation}${datasource} failed after ${attempt} attempts: ${formatBackendFetchError(error)}`
        );
      }

      await sleep(prometheusRetryDelayMs(attempt), options.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Prometheus request failed'));
}

function prometheusQueryResponseError(response: DataQueryResponse): Error {
  const first = response.errors?.[0] as Record<string, unknown> | undefined;
  const message =
    stringRecordValue(first, 'message') ||
    stringRecordValue(first, 'error') ||
    stringRecordValue(first, 'status') ||
    'Prometheus query failed';
  const error = new Error(message);
  const status = numberRecordValue(first, 'status') ?? numberRecordValue(first, 'statusCode');
  if (status !== undefined) {
    (error as Error & { status?: number }).status = status;
  }
  return error;
}

function isRetryablePrometheusError(error: unknown): boolean {
  const status = httpStatusCode(error);
  if (status !== undefined) {
    return status === 408 || status === 429 || status === 502 || status === 503 || status === 504 || status >= 500;
  }

  const message = formatBackendFetchError(error).toLowerCase();
  return (
    /\b(?:http|status(?: code)?)\s*(?:408|429|5\d\d)\b/.test(message) ||
    /\b(?:408|429|502|503|504)\b/.test(message) ||
    /\b(?:too many requests|bad gateway|service unavailable|gateway timeout)\b/.test(message) ||
    /\b(?:timeout|timed out|network error|connection reset|connection refused|econnreset|econnrefused)\b/.test(message)
  );
}

function httpStatusCode(error: unknown): number | undefined {
  const record = isRecord(error) ? error : undefined;
  return (
    numberRecordValue(record, 'status') ??
    numberRecordValue(record, 'statusCode') ??
    numberRecordValue(recordFieldValue(record, 'response'), 'status') ??
    numberRecordValue(recordFieldValue(record, 'data'), 'status')
  );
}

function prometheusRetryDelayMs(attempt: number): number {
  return Math.min(
    PROMETHEUS_TRANSIENT_RETRY_MAX_DELAY_MS,
    PROMETHEUS_TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(new Error('Tool call aborted'));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function stringRecordValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberRecordValue(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordFieldValue(
  record: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function makeTimeRange(fromRaw: string, toRaw: string): TimeRange {
  const to = parseTime(toRaw) ?? dateTime();
  const from = parseTime(fromRaw) ?? dateTime(to).subtract(1, 'hour');

  return {
    from,
    to,
    raw: {
      from: fromRaw,
      to: toRaw,
    },
  };
}

function parseTime(raw: string) {
  const trimmed = raw.trim();
  if (trimmed === 'now') {
    return dateTime();
  }

  const relative = /^now-(\d+)(ms|s|m|h|d)$/.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unit =
      relative[2] === 'ms'
        ? 'millisecond'
        : relative[2] === 's'
          ? 'second'
          : relative[2] === 'm'
            ? 'minute'
            : relative[2] === 'h'
              ? 'hour'
              : 'day';
    return dateTime().subtract(amount, unit);
  }

  const parsed = dateTime(trimmed);
  return parsed.isValid() ? parsed : undefined;
}

export type PrometheusQuerySummary = {
  datasourceUid: string;
  query: string;
  queryType: 'instant' | 'range';
  interval: string;
  range: {
    from: string;
    to: string;
    raw: TimeRange['raw'];
  };
  frameCount: number;
  totalSeries: number;
  truncatedSeries: boolean;
  seriesSelection?: string;
  omittedSeries?: OmittedSeriesSummary;
  notices: QueryNotice[];
  executedQueryStrings: string[];
  series: SeriesSummary[];
};

type OmittedSeriesSummary = {
  count: number;
  labelValues: Record<string, string[]>;
};

type QueryNotice = {
  severity?: string;
  text?: string;
};

type SeriesSummary = {
  name: string;
  labels: Record<string, string>;
  points: number;
  nonNullPoints: number;
  nullPoints: number;
  last?: SummaryPoint;
  min?: SummaryPoint;
  max?: SummaryPoint;
  mean?: number;
  delta?: number;
  deltaPercent?: number;
};

type SummaryPoint = {
  time?: string;
  value: number | null;
};

type PrometheusQueryApiResponse = {
  status?: string;
  errorType?: string;
  error?: string;
  warnings?: string[];
  data?: {
    resultType?: string;
    result?: PrometheusApiSeries[];
  };
};

type PrometheusApiSeries = {
  metric?: Record<string, string>;
  value?: [number | string, string];
  values?: Array<[number | string, string]>;
};

const MAX_SERIES_SUMMARIES = 8;
const MAX_BATCH_SERIES_SUMMARIES = 3;
const PROMETHEUS_QUERY_MAX_DATA_POINTS = 1200;
const PROMETHEUS_TRANSIENT_RETRY_ATTEMPTS = 3;
const PROMETHEUS_TRANSIENT_RETRY_BASE_DELAY_MS = 250;
const PROMETHEUS_TRANSIENT_RETRY_MAX_DELAY_MS = 1000;

function summarizePrometheusQuery(options: {
  datasourceUid: string;
  query: string;
  queryType: 'instant' | 'range';
  interval: string;
  timeRange: TimeRange;
  frames: DataFrame[];
}): PrometheusQuerySummary {
  const allSeries: SeriesSummary[] = [];

  for (const frame of options.frames) {
    const timeField = frame.fields.find(isTimeField);
    const numberFields = frame.fields.filter(isNumberField);

    for (const field of numberFields) {
      allSeries.push(summarizeNumberField(frame, field, timeField));
    }
  }
  const selected = selectProminentSeries(allSeries, MAX_SERIES_SUMMARIES);

  return {
    datasourceUid: options.datasourceUid,
    query: options.query,
    queryType: options.queryType,
    interval: options.interval,
    range: {
      from: options.timeRange.from.toISOString(),
      to: options.timeRange.to.toISOString(),
      raw: options.timeRange.raw,
    },
    frameCount: options.frames.length,
    totalSeries: allSeries.length,
    truncatedSeries: allSeries.length > MAX_SERIES_SUMMARIES,
    seriesSelection: selected.selection,
    omittedSeries: selected.omittedSeries,
    notices: collectNotices(options.frames),
    executedQueryStrings: collectExecutedQueryStrings(options.frames),
    series: selected.series,
  };
}

function summarizePrometheusApiQuery(options: {
  datasourceUid: string;
  query: string;
  queryType: 'instant' | 'range';
  interval: string;
  timeRange: TimeRange;
  response: PrometheusQueryApiResponse;
}): PrometheusQuerySummary {
  const allSeries = (options.response.data?.result ?? []).map(summarizePrometheusApiSeries);
  const selected = selectProminentSeries(allSeries, MAX_SERIES_SUMMARIES);

  return {
    datasourceUid: options.datasourceUid,
    query: options.query,
    queryType: options.queryType,
    interval: options.interval,
    range: {
      from: options.timeRange.from.toISOString(),
      to: options.timeRange.to.toISOString(),
      raw: options.timeRange.raw,
    },
    frameCount: allSeries.length,
    totalSeries: allSeries.length,
    truncatedSeries: allSeries.length > MAX_SERIES_SUMMARIES,
    seriesSelection: selected.selection,
    omittedSeries: selected.omittedSeries,
    notices: (options.response.warnings ?? []).slice(0, 10).map((text) => ({ severity: 'warning', text })),
    executedQueryStrings:
      options.queryType === 'range'
        ? [`Expr: ${options.query}\nStep: ${options.interval}`]
        : [`Expr: ${options.query}`],
    series: selected.series,
  };
}

function summarizePrometheusApiSeries(series: PrometheusApiSeries): SeriesSummary {
  const labels = stringLabelsFromRecord(series.metric ?? {});
  const points = (series.values ?? (series.value ? [series.value] : [])).map(([rawTime, rawValue]) => ({
    time: prometheusApiTime(rawTime),
    value: finiteNumber(rawValue),
  }));
  const nonNullPoints = points.filter((point) => point.value !== null);
  let min: SummaryPoint | undefined;
  let max: SummaryPoint | undefined;
  let sum = 0;

  for (const point of nonNullPoints) {
    sum += point.value!;
    if (!min || point.value! < min.value!) {
      min = point;
    }
    if (!max || point.value! > max.value!) {
      max = point;
    }
  }

  const first = nonNullPoints[0];
  const last = nonNullPoints.at(-1);
  const summary: SeriesSummary = {
    name: prometheusApiSeriesName(series.metric ?? {}),
    labels,
    points: points.length,
    nonNullPoints: nonNullPoints.length,
    nullPoints: points.length - nonNullPoints.length,
    last,
    min,
    max,
    mean: nonNullPoints.length > 0 ? roundNumber(sum / nonNullPoints.length) : undefined,
  };

  if (first && last && first.value !== null && last.value !== null) {
    summary.delta = roundNumber(last.value - first.value);
    if (first.value !== 0) {
      summary.deltaPercent = roundNumber(((last.value - first.value) / Math.abs(first.value)) * 100);
    }
  }

  return summary;
}

function prometheusApiSeriesName(metric: Record<string, string>) {
  const name = metric.__name__;
  const labels = Object.entries(metric)
    .filter(([key]) => key !== '__name__')
    .sort(([left], [right]) => left.localeCompare(right));
  if (labels.length === 0) {
    return name || 'value';
  }
  const labelText = labels.map(([key, value]) => `${key}="${value}"`).join(',');
  return name ? `${name}{${labelText}}` : `{${labelText}}`;
}

function stringLabelsFromRecord(metric: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metric)
      .filter(([key]) => key !== '__name__')
      .map(([key, value]) => [key, String(value)])
  );
}

function prometheusApiTime(raw: number | string): string | undefined {
  const seconds = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(seconds)) {
    return undefined;
  }
  return new Date(seconds * 1000).toISOString();
}

function summarizeNumberField(frame: DataFrame, field: Field, timeField?: Field): SeriesSummary {
  const points = getFieldLength(field, frame.length ?? 0);
  let first: SummaryPoint | undefined;
  let last: SummaryPoint | undefined;
  let min: SummaryPoint | undefined;
  let max: SummaryPoint | undefined;
  let sum = 0;
  let nonNullPoints = 0;

  for (let index = 0; index < points; index++) {
    const value = finiteNumber(valueAt(field, index));
    if (value === null) {
      continue;
    }

    const point = pointAt(field, timeField, index, value);
    first ??= point;
    last = point;
    if (!min || value < min.value!) {
      min = point;
    }
    if (!max || value > max.value!) {
      max = point;
    }
    sum += value;
    nonNullPoints++;
  }

  const summary: SeriesSummary = {
    name: seriesName(frame, field),
    labels: stringLabels(field.labels),
    points,
    nonNullPoints,
    nullPoints: Math.max(0, points - nonNullPoints),
    last,
    min,
    max,
    mean: nonNullPoints > 0 ? roundNumber(sum / nonNullPoints) : undefined,
  };

  if (first && last && first.value !== null && last.value !== null) {
    summary.delta = roundNumber(last.value - first.value);
    if (first.value !== 0) {
      summary.deltaPercent = roundNumber(((last.value - first.value) / Math.abs(first.value)) * 100);
    }
  }

  return summary;
}

export function compactBatchPrometheusSummary(
  summary: PrometheusQueryValidationSummary
): PrometheusQueryValidationSummary {
  const selected = selectProminentSeries(summary.series, MAX_BATCH_SERIES_SUMMARIES);

  return {
    ...summary,
    truncatedSeries: summary.truncatedSeries || summary.totalSeries > MAX_BATCH_SERIES_SUMMARIES,
    seriesSelection: selected.selection ?? summary.seriesSelection,
    omittedSeries: mergeOmittedSeries(selected.omittedSeries, summary.omittedSeries),
    series: selected.series,
  };
}

function selectProminentSeries(
  allSeries: SeriesSummary[],
  limit: number
): { series: SeriesSummary[]; selection?: string; omittedSeries?: OmittedSeriesSummary } {
  if (allSeries.length <= limit) {
    return { series: allSeries };
  }

  const selectedIndexes = new Set<number>();
  const rankers = [seriesMaxAbs, seriesDeltaPercentAbs, seriesSpikeRatio, seriesLastAbs];

  for (const ranker of rankers) {
    if (selectedIndexes.size >= limit) {
      break;
    }
    const candidate = rankedSeriesIndexes(allSeries, ranker).find((index) => !selectedIndexes.has(index));
    if (candidate !== undefined && ranker(allSeries[candidate]) > 0) {
      selectedIndexes.add(candidate);
    }
  }

  for (const index of rankedSeriesIndexes(allSeries, seriesCompositeScore)) {
    if (selectedIndexes.size >= limit) {
      break;
    }
    selectedIndexes.add(index);
  }

  const selected = [...selectedIndexes]
    .sort(
      (left, right) => seriesCompositeScore(allSeries[right]) - seriesCompositeScore(allSeries[left]) || left - right
    )
    .map((index) => allSeries[index]);
  const omitted = allSeries.filter((_series, index) => !selectedIndexes.has(index));

  return {
    series: selected,
    selection: 'ranked by max, deltaPercent, spike ratio, and last value',
    omittedSeries: summarizeOmittedSeries(omitted),
  };
}

function rankedSeriesIndexes(series: SeriesSummary[], score: (series: SeriesSummary) => number) {
  return series
    .map((item, index) => ({ index, score: score(item) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.index);
}

function seriesCompositeScore(series: SeriesSummary) {
  return Math.max(seriesMaxAbs(series), seriesDeltaPercentAbs(series), seriesSpikeRatio(series), seriesLastAbs(series));
}

function seriesMaxAbs(series: SeriesSummary) {
  return absPointValue(series.max);
}

function seriesLastAbs(series: SeriesSummary) {
  return absPointValue(series.last);
}

function seriesDeltaPercentAbs(series: SeriesSummary) {
  return Math.abs(series.deltaPercent ?? 0);
}

function seriesSpikeRatio(series: SeriesSummary) {
  const max = absPointValue(series.max);
  const mean = Math.abs(series.mean ?? 0);
  return mean > 0 ? (max / mean) * 100 : max;
}

function absPointValue(point?: SummaryPoint) {
  return typeof point?.value === 'number' && Number.isFinite(point.value) ? Math.abs(point.value) : 0;
}

function summarizeOmittedSeries(series: SeriesSummary[]): OmittedSeriesSummary | undefined {
  if (series.length === 0) {
    return undefined;
  }

  const values = new Map<string, Set<string>>();
  for (const item of series) {
    for (const [label, value] of Object.entries(item.labels)) {
      if (!values.has(label)) {
        values.set(label, new Set());
      }
      values.get(label)!.add(value);
    }
  }

  return {
    count: series.length,
    labelValues: Object.fromEntries(
      [...values.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([label, labelValues]) => [label, [...labelValues].sort().slice(0, 20)])
    ),
  };
}

function mergeOmittedSeries(
  left: OmittedSeriesSummary | undefined,
  right: OmittedSeriesSummary | undefined
): OmittedSeriesSummary | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const values = new Map<string, Set<string>>();
  for (const source of [left, right]) {
    for (const [label, labelValues] of Object.entries(source.labelValues)) {
      if (!values.has(label)) {
        values.set(label, new Set());
      }
      for (const value of labelValues) {
        values.get(label)!.add(value);
      }
    }
  }

  return {
    count: left.count + right.count,
    labelValues: Object.fromEntries(
      [...values.entries()]
        .sort(([leftLabel], [rightLabel]) => leftLabel.localeCompare(rightLabel))
        .map(([label, labelValues]) => [label, [...labelValues].sort().slice(0, 20)])
    ),
  };
}

function isTimeField(field: Field) {
  return field.type === 'time';
}

function isNumberField(field: Field) {
  return field.type === 'number';
}

function seriesName(frame: DataFrame, field: Field) {
  const displayName = field.config?.displayNameFromDS || field.config?.displayName || field.name || frame.name;
  return displayName || 'series';
}

function stringLabels(labels: Field['labels']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    result[key] = String(value);
  }
  return result;
}

function pointAt(field: Field, timeField: Field | undefined, index: number, knownValue?: number | null): SummaryPoint {
  const value = knownValue ?? finiteNumber(valueAt(field, index));
  const rawTime = timeField ? valueAt(timeField, index) : undefined;
  const time = formatTime(rawTime);
  return time ? { time, value } : { value };
}

function formatTime(raw: unknown): string | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return new Date(raw).toISOString();
  }
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  if (typeof raw === 'string' && raw.trim()) {
    const date = new Date(raw);
    return Number.isNaN(date.valueOf()) ? raw : date.toISOString();
  }
  return undefined;
}

function finiteNumber(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(value) ? roundNumber(value) : null;
}

function roundNumber(value: number): number {
  if (value === 0) {
    return 0;
  }
  if (Math.abs(value) >= 1_000_000 || Math.abs(value) < 0.000001) {
    return Number(value.toExponential(6));
  }
  return Number(value.toPrecision(7));
}

function getFieldLength(field: Field, fallback: number): number {
  const values = (field as any).values;
  return Number.isFinite(values?.length) ? values.length : fallback;
}

function valueAt(field: Field, index: number): unknown {
  const values = (field as any).values;
  if (!values) {
    return undefined;
  }
  if (typeof values.get === 'function') {
    return values.get(index);
  }
  return values[index];
}

function collectNotices(frames: DataFrame[]): QueryNotice[] {
  const seen = new Set<string>();
  const notices: QueryNotice[] = [];

  for (const frame of frames) {
    const frameNotices = ((frame.meta as any)?.notices ?? []) as QueryNotice[];
    for (const notice of frameNotices) {
      const key = `${notice.severity ?? ''}:${notice.text ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        notices.push({
          severity: notice.severity,
          text: notice.text,
        });
      }
    }
  }

  return notices.slice(0, 10);
}

function collectExecutedQueryStrings(frames: DataFrame[]): string[] {
  const queries = new Set<string>();
  for (const frame of frames) {
    const executed = (frame.meta as any)?.executedQueryString;
    if (typeof executed === 'string' && executed.trim()) {
      queries.add(executed);
    }
  }
  return Array.from(queries).slice(0, 3);
}

async function resolveQueryResponse(
  result: Promise<DataQueryResponse> | Observable<DataQueryResponse>
): Promise<DataQueryResponse> {
  if (isPromise<DataQueryResponse>(result)) {
    return result;
  }
  return lastValueFrom(result);
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return Boolean(
    value && typeof value === 'object' && 'then' in value && typeof (value as Promise<T>).then === 'function'
  );
}

function durationToMs(duration: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration.trim());
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * multipliers[unit];
}

function chooseRangeInterval(timeRange: TimeRange): string {
  const durationMs = Math.max(0, timeRange.to.valueOf() - timeRange.from.valueOf());
  if (durationMs <= 6 * 60 * 60 * 1000) {
    return '30s';
  }
  if (durationMs <= 24 * 60 * 60 * 1000) {
    return '1m';
  }
  if (durationMs <= 7 * 24 * 60 * 60 * 1000) {
    return '5m';
  }
  return '1h';
}
