import {
  DataFrameType,
  dateMath,
  FieldType,
  getFieldDisplayName,
  rangeUtil,
  sortDataFrame,
  type DataFrame,
  type Field,
  type TimeRange,
} from '@grafana/data';

/**
 * What a Grafana dashboard does around a Prometheus panel query, outside the
 * datasource server: how the panel sizes the request (maxDataPoints from the
 * panel width, interval from the panel/datasource minimum), how the
 * Prometheus backend (promlib) resolves the step and the $__interval /
 * $__rate_interval macros, how panel time overrides change the range, and how
 * the Prometheus frontend turns the returned frames into table, heatmap, or
 * time series frames (`transformV2`) before panel transformations run.
 *
 * Sources: @grafana/scenes SceneQueryRunner.prepareRequests and
 * VizPanelRenderer, grafana-ui PanelChrome, Grafana's PanelTimeRange,
 * pkg/promlib/models/query.go (calculatePrometheusInterval,
 * InterpolateVariables), and packages/grafana-prometheus result_transformer.ts.
 */

/** Field names of Prometheus time series frames (TIME_SERIES_*_FIELD_NAME in @grafana/data). */
const TIME_FIELD_NAME = 'Time';
const VALUE_FIELD_NAME = 'Value';

/** Browser window width the panel widths are derived from, unless overridden. */
export const DEFAULT_BROWSER_WIDTH = 1920;
/** Grafana's docked navigation menu (MegaMenu MENU_WIDTH), docked by default on wide screens. */
const DOCKED_MENU_WIDTH = 320;
/** Dashboard body padding, theme.spacing(2) on each side. */
const DASHBOARD_HORIZONTAL_PADDING = 32;
/** react-grid-layout settings of the dashboard grid. */
const GRID_COLUMN_COUNT = 24;
const GRID_CELL_MARGIN = 8;
/** Prometheus frontend default for `ds.interval` when jsonData.timeInterval is empty. */
const PROMETHEUS_DEFAULT_SCRAPE_INTERVAL = '15s';
/** promlib's safeResolution: the step never drops below range / 11000. */
const PROMLIB_SAFE_RESOLUTION = 11000;
/** intervalv2 DefaultRes when a query has no maxDataPoints. */
const PROMLIB_DEFAULT_RESOLUTION = 1500;
/** Prometheus frontend suffix for the instant half of a "Both" (range + instant) query. */
export const INSTANT_REF_SUFFIX = '-Instant';

export function dashboardGridWidth(browserWidth = DEFAULT_BROWSER_WIDTH) {
  return Math.max(0, browserWidth - DOCKED_MENU_WIDTH - DASHBOARD_HORIZONTAL_PADDING);
}

/** Where panel widths come from: a dashboard grid measured in the browser, or an assumed window width. */
export type GridWidthSource = { gridWidth: number; measured: boolean; browserWidth?: number };

export function gridWidthSource(options: { browserWidth?: number; measuredGridWidth?: number }): GridWidthSource {
  if (options.browserWidth === undefined && options.measuredGridWidth && options.measuredGridWidth > 0) {
    return { gridWidth: options.measuredGridWidth, measured: true };
  }
  const browserWidth = options.browserWidth ?? DEFAULT_BROWSER_WIDTH;
  return { gridWidth: dashboardGridWidth(browserWidth), measured: false, browserWidth };
}

/**
 * The width in pixels Grafana uses as maxDataPoints when the panel does not
 * set one: the grid item width (react-grid-layout calcGridItemPosition).
 * Scenes' VizPanelRenderer measures the whole panel container and passes it to
 * SceneQueryRunner.setContainerWidth, so the panel chrome is not subtracted.
 */
export function panelPixelWidth(gridColumns: number, gridWidth = dashboardGridWidth()) {
  const columns = Math.min(Math.max(gridColumns, 1), GRID_COLUMN_COUNT);
  const colWidth = (gridWidth - GRID_CELL_MARGIN * (GRID_COLUMN_COUNT - 1)) / GRID_COLUMN_COUNT;
  return Math.max(1, Math.round(colWidth * columns + Math.max(0, columns - 1) * GRID_CELL_MARGIN));
}

export type PanelRequestOptions = {
  /** Panel query option maxDataPoints (classic `maxDataPoints`, v2 `queryOptions.maxDataPoints`). */
  maxDataPoints?: number;
  /** Panel min interval (classic `interval`, v2 `queryOptions.interval`), variables resolved. */
  minInterval?: string;
  /** Grid columns of the panel; undefined (full width assumed) when the layout has no grid position. */
  gridColumns?: number;
  /** Datasource `jsonData.timeInterval` of the panel datasource; undefined for mixed panels. */
  panelDatasourceInterval?: string;
  /** The panel datasource is "-- Mixed --", whose `interval` is unset. */
  mixed?: boolean;
  /** Pixel width of the dashboard grid; defaults to the grid of a 1920px window. */
  gridWidth?: number;
};

export type PanelRequest = {
  maxDataPoints: number;
  maxDataPointsSource: 'panel' | 'width';
  /** Request interval as the dashboard computes it (`$__interval` before the backend adjusts it). */
  interval: string;
  intervalMs: number;
  /** Lower limit applied to the interval: the panel min interval or the datasource scrape interval. */
  minInterval?: string;
};

/** SceneQueryRunner.prepareRequests: maxDataPoints and the request interval for a panel. */
export function panelRequest(range: TimeRange, options: PanelRequestOptions): PanelRequest {
  const panelPoints = Number(options.maxDataPoints);
  const fromPanel = Number.isFinite(panelPoints) && panelPoints > 0;
  const maxDataPoints = fromPanel
    ? panelPoints
    : panelPixelWidth(options.gridColumns ?? GRID_COLUMN_COUNT, options.gridWidth);
  // ds.interval of the Prometheus frontend is jsonData.timeInterval || '15s'; the Mixed datasource has none.
  const lowerLimit =
    options.minInterval ||
    (options.mixed ? undefined : options.panelDatasourceInterval || PROMETHEUS_DEFAULT_SCRAPE_INTERVAL);
  const norm = rangeUtil.calculateInterval(range, maxDataPoints, lowerLimit);
  return {
    maxDataPoints,
    maxDataPointsSource: fromPanel ? 'panel' : 'width',
    interval: norm.interval,
    intervalMs: norm.intervalMs,
    ...(lowerLimit ? { minInterval: lowerLimit } : {}),
  };
}

export type ResolvedPromQuery = {
  expr: string;
  stepMs: number;
  /** Step as promlib reports it in executedQueryString (Go duration). */
  step: string;
  rateIntervalMs: number;
  /** `$__rate_interval` as promlib substitutes it (Go duration). */
  rateInterval: string;
  /** `$__interval` as promlib substitutes it. */
  interval: string;
};

const RATE_INTERVAL_VARS = ['$__rate_interval', '${__rate_interval}'];
const INTERVAL_VARS = ['$__interval', '${__interval}'];
const VARIABLE_INTERVALS = new Set([
  ...RATE_INTERVAL_VARS,
  ...INTERVAL_VARS,
  '$__interval_ms',
  '${__interval_ms}',
  '$__rate_interval_ms',
  '${__rate_interval_ms}',
]);

/**
 * promlib Parse: the step (calculatePrometheusInterval) and the expression
 * with $__interval, $__rate_interval, and $__range macros substituted
 * (InterpolateVariables).
 */
export function resolvePromQuery(
  expr: string,
  options: {
    /** Query `interval` ("Min step"), sent as the query model's interval. */
    queryInterval?: string;
    intervalFactor?: number;
    intervalMs: number;
    maxDataPoints: number;
    rangeMs: number;
    /** Datasource jsonData.timeInterval as the backend reads it. */
    scrapeInterval?: string;
  }
): ResolvedPromQuery {
  const original = options.queryInterval ?? '';
  const scrape = options.scrapeInterval ?? '';
  const queryInterval = VARIABLE_INTERVALS.has(original) ? '' : original;
  const minInterval = intervalFrom(scrape, queryInterval, options.intervalMs, 15_000);
  const resolution = options.maxDataPoints > 0 ? options.maxDataPoints : PROMLIB_DEFAULT_RESOLUTION;
  const raw = Math.trunc(options.rangeMs / resolution);
  const calculated = raw < minInterval ? minInterval : rangeUtil.roundInterval(raw);
  const safe = rangeUtil.roundInterval(Math.trunc(options.rangeMs / PROMLIB_SAFE_RESOLUTION));
  const adjusted = calculated > safe ? calculated : safe;
  const stepMs = RATE_INTERVAL_VARS.includes(original)
    ? rateIntervalMs(adjusted, scrape)
    : adjusted * (options.intervalFactor && options.intervalFactor > 0 ? options.intervalFactor : 1);

  let rateMs: number;
  if (RATE_INTERVAL_VARS.includes(original)) {
    rateMs = stepMs;
  } else {
    let requestedMinStep = original;
    if (INTERVAL_VARS.includes(requestedMinStep)) {
      requestedMinStep = goDuration(stepMs);
    }
    rateMs = rateIntervalMs(options.intervalMs, requestedMinStep || scrape);
  }

  const rangeSeconds = Math.round(options.rangeMs / 1000);
  const replacements: Array<[string, string]> = [
    ['__interval_ms', String(stepMs)],
    ['__interval', formatInterval(stepMs)],
    ['__range_ms', String(options.rangeMs)],
    ['__range_s', String(rangeSeconds)],
    ['__range', `${rangeSeconds}s`],
    ['__rate_interval_ms', String(rateMs)],
    ['__rate_interval', goDuration(rateMs)],
  ];
  let resolved = expr;
  for (const form of [(name: string) => `$${name}`, (name: string) => `\${${name}}`]) {
    for (const [name, value] of replacements) {
      resolved = resolved.replaceAll(form(name), value);
    }
  }
  return {
    expr: resolved,
    stepMs,
    step: goDuration(stepMs),
    rateIntervalMs: rateMs,
    rateInterval: goDuration(rateMs),
    interval: formatInterval(stepMs),
  };
}

/** gtime.GetIntervalFrom: the query min step, else the request interval, else the scrape interval. */
function intervalFrom(dsInterval: string, queryInterval: string, intervalMs: number, fallbackMs: number) {
  let interval = queryInterval === '0s' ? '' : queryInterval;
  if (!interval && intervalMs) {
    return intervalMs;
  }
  interval ||= dsInterval;
  if (!interval) {
    return fallbackMs;
  }
  const parsed = parseDuration(interval);
  if (parsed === undefined) {
    throw new Error(`invalid interval ${JSON.stringify(interval)}`);
  }
  return parsed;
}

/** calculateRateInterval: max(interval + scrape interval, 4 × scrape interval). */
function rateIntervalMs(intervalMs: number, requestedMinStep: string) {
  const scrape = parseDuration(requestedMinStep || PROMETHEUS_DEFAULT_SCRAPE_INTERVAL);
  if (scrape === undefined) {
    return 0;
  }
  return Math.max(intervalMs + scrape, 4 * scrape);
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

/** gtime.ParseIntervalStringToTimeDuration: `<`/`>` prefixes dropped, bare numbers are seconds, d/w/y allowed. */
export function parseDuration(value: string): number | undefined {
  const text = value.replace('<', '').replace('>', '').trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Number(text) * 1000;
  }
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join('') !== text) {
    return undefined;
  }
  return Math.round(parts.reduce((total, [, amount, unit]) => total + Number(amount) * DURATION_UNITS[unit], 0));
}

/** gtime.FormatInterval: the largest whole unit, truncated (90s is "1m"). */
export function formatInterval(ms: number): string {
  for (const unit of ['y', 'd', 'h', 'm', 's', 'ms']) {
    if (ms >= DURATION_UNITS[unit]) {
      return `${Math.floor(ms / DURATION_UNITS[unit])}${unit}`;
    }
  }
  return '1ms';
}

/** Go's time.Duration.String() for millisecond durations, e.g. 1m15s, 2m0s, 1h0m0s, 500ms. */
export function goDuration(ms: number): string {
  if (ms === 0) {
    return '0s';
  }
  const sign = ms < 0 ? '-' : '';
  let rest = Math.abs(ms);
  if (rest < 1000) {
    return `${sign}${rest}ms`;
  }
  const hours = Math.floor(rest / 3_600_000);
  rest -= hours * 3_600_000;
  const minutes = Math.floor(rest / 60_000);
  rest -= minutes * 60_000;
  const seconds = String(Number((rest / 1000).toFixed(3)));
  if (hours > 0) {
    return `${sign}${hours}h${minutes}m${seconds}s`;
  }
  return minutes > 0 ? `${sign}${minutes}m${seconds}s` : `${sign}${seconds}s`;
}

export type PanelTimeOptions = { timeFrom?: string; timeShift?: string };

/** PanelTimeRange.getTimeOverride: relative time (`timeFrom`) and time shift (`timeShift`) of a panel. */
export function panelTimeRange(
  parent: TimeRange,
  options: PanelTimeOptions
): { range: TimeRange; info?: string; error?: string } {
  let range = parent;
  const info: string[] = [];
  if (options.timeFrom) {
    const described = rangeUtil.describeTextRange(options.timeFrom);
    if (described.invalid) {
      return { range: parent, error: `invalid relative time ${JSON.stringify(options.timeFrom)}` };
    }
    // Grafana applies the relative time only while the dashboard range is relative.
    if (rangeUtil.isRelativeTimeRange(parent.raw)) {
      const from = dateMath.toDateTime(described.from, {});
      const to = dateMath.toDateTime(described.to, {});
      if (from && to) {
        range = { from, to, raw: { from: described.from, to: described.to } };
        info.push(described.display);
      }
    }
  }
  if (options.timeShift) {
    const described = rangeUtil.describeTextRange(options.timeShift);
    if (described.invalid) {
      return { range, error: `invalid time shift ${JSON.stringify(options.timeShift)}` };
    }
    const shift = `-${options.timeShift}`;
    info.push(`timeshift ${shift}`);
    if (rangeUtil.isRelativeTimeRange(range.raw)) {
      const rawFrom = `${String(range.raw.from)}${shift}`;
      const rawTo = `${String(range.raw.to)}${shift}`;
      const from = dateMath.toDateTime(rawFrom, {});
      const to = dateMath.toDateTime(rawTo, { roundUp: true });
      if (!from || !to) {
        return { range, error: `invalid time shift ${JSON.stringify(options.timeShift)}` };
      }
      range = { from, to, raw: { from: rawFrom, to: rawTo } };
    } else {
      const from = dateMath.parseDateMath(shift, range.from, false);
      const to = dateMath.parseDateMath(shift, range.to, true);
      if (!from || !to) {
        return { range, error: `invalid time shift ${JSON.stringify(options.timeShift)}` };
      }
      range = { from, to, raw: { from, to } };
    }
  }
  return { range, ...(info.length > 0 ? { info: info.join(' + ') } : {}) };
}

export type PromTargetFormat = { refId: string; format?: string; legendFormat?: string };

/**
 * The Prometheus frontend's transformV2: frames of `format: table` queries
 * become one table per query (Time, one column per label, `Value` or
 * `Value #<refId>` when several table queries returned data), `format:
 * heatmap` frames are de-accumulated into heatmap rows, exemplar frames
 * leave the data, and everything else stays one time series frame per
 * series. The order is time series, tables, heatmaps, as in Grafana.
 */
export function transformPrometheusFrames(frames: DataFrame[], targets: PromTargetFormat[]): DataFrame[] {
  const targetFor = (frame: DataFrame) => targets.find((target) => target.refId === frame.refId);
  for (const frame of frames) {
    if (targetFor(frame)?.legendFormat !== '__auto') {
      continue;
    }
    for (const field of frame.fields) {
      if (field.labels?.__name__ && field.labels.__name__ === field.name) {
        const copy = { ...field, name: VALUE_FIELD_NAME };
        field.config = { ...field.config, displayNameFromDS: getFieldDisplayName(copy, frame, frames) };
      }
    }
  }
  const tableFrames = frames.filter((frame) => targetFor(frame)?.format === 'table');
  const rest = frames.filter(
    (frame) => targetFor(frame)?.format !== 'table' && frame.meta?.custom?.resultType !== 'exemplar'
  );
  const heatmapFrames = rest.filter(
    (frame) => frame.meta?.type !== 'heatmap-cells' && targetFor(frame)?.format === 'heatmap'
  );
  const timeSeries = rest
    .filter((frame) => !heatmapFrames.includes(frame))
    .map((frame) => ({ ...frame, meta: { ...frame.meta, preferredVisualisationType: 'graph' as const } }));
  return [...timeSeries, ...transformToTables(tableFrames), ...transformHeatmaps(heatmapFrames)];
}

function transformToTables(frames: DataFrame[]): DataFrame[] {
  if (frames.length === 0 || (frames.length === 1 && frames[0].length === 0)) {
    return frames;
  }
  const byRefId = new Map<string, DataFrame[]>();
  for (const frame of frames) {
    const refId = String(frame.refId);
    byRefId.set(refId, [...(byRefId.get(refId) ?? []), frame]);
  }
  return [...byRefId.entries()].map(([refId, group]) => {
    const valueField: Field = {
      name: byRefId.size > 1 ? `Value #${refId}` : VALUE_FIELD_NAME,
      type: FieldType.number,
      config: {},
      values: [],
    };
    const timeField: Field = { name: TIME_FIELD_NAME, type: FieldType.time, config: {}, values: [] };
    const labelFields: Field[] = [];
    for (const frame of group) {
      for (const label of Object.keys(frame.fields[1]?.labels ?? {}).sort()) {
        if (!labelFields.some((field) => field.name === label)) {
          labelFields.push({ name: label, type: FieldType.string, config: { filterable: true }, values: [] });
        }
      }
    }
    let previous = -Infinity;
    let needsSort = false;
    for (const frame of group) {
      timeField.config.interval ??= frame.fields[0]?.config.interval;
      for (const time of frame.fields[0]?.values ?? []) {
        timeField.values.push(time);
        needsSort ||= time < previous;
        previous = time;
      }
      const labels = frame.fields[1]?.labels ?? {};
      for (const value of frame.fields[1]?.values ?? []) {
        valueField.values.push(parseSampleValue(value));
        for (const field of labelFields) {
          field.values.push(labels[field.name] ?? '');
        }
      }
    }
    const table: DataFrame = {
      refId,
      fields: [timeField, ...labelFields, valueField],
      meta: { ...group[0].meta, preferredVisualisationType: 'rawPrometheus' },
      length: timeField.values.length,
    };
    return needsSort ? sortDataFrame(table, 0) : table;
  });
}

function transformHeatmaps(frames: DataFrame[]): DataFrame[] {
  for (const frame of frames) {
    const field = frame.fields.find((item) => item.type === FieldType.number);
    const le = field?.labels?.le;
    if (frame.name == null && field && le) {
      frame.name = le;
      field.config = { ...field.config, displayNameFromDS: le };
    }
  }
  const result: DataFrame[] = [];
  const byRefId = new Map<string, DataFrame[]>();
  for (const frame of frames) {
    const refId = String(frame.refId);
    byRefId.set(refId, [...(byRefId.get(refId) ?? []), frame]);
  }
  for (const group of byRefId.values()) {
    const byLabels = new Map<string, DataFrame[]>();
    for (const frame of group) {
      const labels = { ...(frame.fields.find((field) => field.type === FieldType.number)?.labels ?? {}) };
      delete labels.le;
      const key = Object.values(labels).join();
      byLabels.set(key, [...(byLabels.get(key) ?? []), frame]);
    }
    for (const series of byLabels.values()) {
      const sorted = [...series].sort((left, right) => bucketBound(left) - bucketBound(right));
      result.push(...mergeHeatmapFrames(deaccumulate(sorted)));
    }
  }
  return result;
}

function bucketBound(frame: DataFrame) {
  const value = parseSampleValue(frame.name ?? frame.fields[1]?.name ?? '');
  return Number.isNaN(value) ? 0 : value;
}

function deaccumulate(series: DataFrame[]) {
  const copies = series.map((frame) => ({
    ...frame,
    fields: frame.fields.map((field) =>
      field.type === FieldType.number ? { ...field, values: [...field.values] } : field
    ),
  }));
  for (let index = copies.length - 1; index > 0; index--) {
    const top = copies[index].fields.find((field) => field.type === FieldType.number);
    const bottom = copies[index - 1].fields.find((field) => field.type === FieldType.number);
    if (!top || !bottom) {
      throw new Error('Prometheus heatmap transform error: data should be a time series');
    }
    for (let row = 0; row < top.values.length; row++) {
      top.values[row] -= bottom.values[row] || 0;
      if (top.values[row] < 1e-9) {
        top.values[row] = 0;
      }
    }
  }
  return copies;
}

function mergeHeatmapFrames(frames: DataFrame[]): DataFrame[] {
  if (frames.length === 0 || (frames.length === 1 && frames[0].length === 0)) {
    return [];
  }
  const timeField = frames[0].fields.find((field) => field.type === FieldType.time)!;
  const counts = frames.map((frame) => {
    const field = frame.fields.find((item) => item.type === FieldType.number)!;
    return { ...field, name: String(field.config.displayNameFromDS) };
  });
  return [
    { ...frames[0], meta: { ...frames[0].meta, type: DataFrameType.HeatmapRows }, fields: [timeField, ...counts] },
  ];
}

function parseSampleValue(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  const text = String(value);
  if (/^[+-]?inf(?:inity)?$/i.test(text)) {
    return text[0] === '-' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  return parseFloat(text);
}
