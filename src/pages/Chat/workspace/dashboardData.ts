import {
  applyFieldOverrides,
  createTheme,
  dataFrameFromJSON,
  dateMath,
  displayNameOverrideProcessor,
  FieldConfigOptionsRegistry,
  FieldType,
  formattedValueToString,
  getFieldDisplayName,
  identityOverrideProcessor,
  rangeUtil,
  reduceField,
  standardTransformers,
  standardTransformersRegistry,
  transformDataFrame,
  type DataFrame,
  type DataFrameJSON,
  type DataTransformerConfig,
  type Field,
  type FieldConfigPropertyItem,
  type FieldConfigSource,
  type TimeRange,
  type TransformerRegistryItem,
} from '@grafana/data';
import { lastValueFrom } from 'rxjs';
import type { PrometheusDatasourceInfo } from './broker';
import {
  applyVariableOverrides,
  asText,
  collectPanels,
  collectVariables,
  dashboardTime,
  datasourceType,
  datasourceUid,
  DashboardWalkError,
  isObject,
  prepareTargets,
  replaceVariables,
  TemplateValue,
  unresolvedVariables,
  unwrapDashboard,
  type JsonObject,
  type WalkedPanel,
} from './dashboardPanels';

/**
 * Runs dashboard panel queries as the current user and applies the panel's
 * transformations, field overrides, and reducers with @grafana/data, so the
 * result reflects what the panel shows rather than the raw query output.
 * Ported from the grafana-inspect `data` command in the dotfiles repo.
 */

export type DashboardDataQuery = (
  request: { queries: JsonObject[]; from: string; to: string },
  signal?: AbortSignal
) => Promise<unknown>;

export type DashboardDataOptions = {
  panels?: string[];
  panelTypes?: string[];
  vars?: string[];
  from?: string;
  to?: string;
  maxRows: number;
  maxSeries: number;
  maxPanels: number;
  includeHiddenTargets?: boolean;
  includeCollapsed?: boolean;
  datasources: PrometheusDatasourceInfo[];
  query: DashboardDataQuery;
  signal?: AbortSignal;
};

export type PanelDataReport = {
  id: string;
  title: string;
  type: string;
  status: 'ok' | 'empty' | 'error' | 'skipped';
  queries: Array<{ refId: string; datasource?: string; expr?: string; hidden?: boolean }>;
  errors: string[];
  warnings: string[];
  skippedReason?: string;
  /**
   * Queries as the datasource executed them (macros such as $__rate_interval
   * resolved, with the step), for empty or failing panels.
   */
  executedQueries?: string[];
  /** Datasource notices, such as Prometheus warnings. */
  notices?: string[];
  /** Reduced numeric series for graph/stat-like panels, with panel units applied in `display`. */
  series?: Array<{ name: string; calcs: Record<string, unknown>; display: Record<string, string> }>;
  seriesTotal?: number;
  /** Bounded rows after transformations for table-like panels. */
  tables?: Array<{ name: string; refId: string; columns: string[]; rows: string[][]; rowCount: number }>;
};

export type DashboardDataReport = {
  schemaVersion: 1;
  title: string;
  from: string;
  to: string;
  variables: Record<string, string>;
  panels: PanelDataReport[];
  panelsOmitted?: number;
  notes: string[];
};

const QUERY_CONCURRENCY = 4;
const DEFAULT_MAX_DATA_POINTS = 1000;
const MAX_CELL_CHARS = 120;
const EXPRESSION_DATASOURCE = { type: '__expr__', uid: '__expr__' };

export async function collectDashboardData(
  resource: unknown,
  options: DashboardDataOptions
): Promise<DashboardDataReport> {
  ensureStandardTransformers();
  const [shape, dashboard] = unwrapDashboard(resource);
  let panels = collectPanels(shape, dashboard, {
    includeHiddenTargets: options.includeHiddenTargets,
    includeCollapsed: options.includeCollapsed || Boolean(options.panels?.length),
  });
  panels = selectPanels(panels, options.panels ?? [], options.panelTypes ?? []);
  const queryable = panels.filter((panel) => panel.targets.length > 0 || panel.libraryPanel);
  if (queryable.length === 0) {
    throw new DashboardWalkError('no panels with queries matched');
  }
  const selected = queryable.slice(0, options.maxPanels);

  const [defaultFrom, defaultTo] = dashboardTime(shape, dashboard);
  const from = options.from || defaultFrom;
  const to = options.to || defaultTo;
  const range = parseRange(from, to);
  const variables = collectVariables(shape, dashboard);
  applyVariableOverrides(variables, options.vars ?? []);
  const notes = approximateAllValues(variables);

  const reports = await mapConcurrent(selected, QUERY_CONCURRENCY, (panel) =>
    queryPanel(panel, variables, range, options).catch((error): PanelDataReport => {
      if (options.signal?.aborted) {
        throw error;
      }
      return { ...panelIdentity(panel), status: 'error', queries: [], errors: [errorText(error)], warnings: [] };
    })
  );
  return {
    schemaVersion: 1,
    title: asText(dashboard.title) || '(untitled dashboard)',
    from,
    to,
    variables: Object.fromEntries(
      Object.entries(variables)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, value.display()])
    ),
    panels: reports,
    ...(queryable.length > selected.length ? { panelsOmitted: queryable.length - selected.length } : {}),
    notes: [
      ...notes,
      'Values come from the saved dashboard variables and time range unless overridden with --var/--from/--to.',
      'Not emulated: variable queries, repeats, panel plugin rendering, and datasource frontend processing.',
    ],
  };
}

async function queryPanel(
  panel: WalkedPanel,
  variables: Record<string, TemplateValue>,
  range: TimeRange,
  options: DashboardDataOptions
): Promise<PanelDataReport> {
  const identity = panelIdentity(panel);
  if (panel.libraryPanel) {
    return skipped(identity, [], `library panel ${panel.libraryPanel}: queries live in the library element`);
  }
  const targets = prepareTargets(panel, variables);
  const queries = targets.map((target) => ({
    refId: asText(target.refId),
    ...(datasourceUid(target) ? { datasource: datasourceUid(target) } : {}),
    ...(typeof target.expr === 'string' ? { expr: target.expr } : {}),
    ...(target.hide ? { hidden: true } : {}),
  }));
  const resolved: JsonObject[] = [];
  for (const target of targets) {
    const type = datasourceType(target);
    if (type === '__expr__' || datasourceUid(target) === '__expr__') {
      resolved.push({ ...target, datasource: EXPRESSION_DATASOURCE });
      continue;
    }
    if (type && type !== 'prometheus') {
      return skipped(identity, queries, `datasource type ${type} is not available to the assistant`);
    }
    const ds = resolveDatasource(datasourceUid(target), options.datasources);
    if (!ds) {
      return skipped(
        identity,
        queries,
        `datasource ${JSON.stringify(datasourceUid(target) || '(default)')} is not an allowed Prometheus datasource`
      );
    }
    const missing = unresolvedVariables(asText(target.expr)).filter((name) => !name.startsWith('__'));
    if (missing.length > 0) {
      return skipped(identity, queries, `undefined variable ${missing.map((name) => `$${name}`).join(', ')}`);
    }
    const maxDataPoints = Number(target.maxDataPoints) || DEFAULT_MAX_DATA_POINTS;
    // Like Grafana panels: the panel/query min interval, else the datasource scrape interval.
    const interval = rangeUtil.calculateInterval(
      range,
      maxDataPoints,
      asText(target.interval) || ds.timeInterval || undefined
    );
    resolved.push({
      ...target,
      datasource: { type: 'prometheus', uid: ds.uid },
      maxDataPoints,
      intervalMs: interval.intervalMs,
    });
  }
  const visibleRefs = resolved.filter((target) => !target.hide).map((target) => asText(target.refId));
  if (visibleRefs.length === 0) {
    return skipped(identity, queries, 'panel has no visible queries');
  }

  const response = await options.query(
    { queries: resolved, from: String(range.from.valueOf()), to: String(range.to.valueOf()) },
    options.signal
  );
  const [frames, errors] = framesFromResponse(response, visibleRefs);
  const report: PanelDataReport = { ...identity, status: 'ok', queries, errors, warnings: [] };
  const visibleFrames = frames.filter((frame) => !frame.refId || visibleRefs.includes(frame.refId));
  const notices = uniqueTexts(frames.flatMap((frame) => (frame.meta?.notices ?? []).map((notice) => notice.text)));
  if (notices.length > 0) {
    report.notices = notices;
  }
  const withExecuted = () => {
    const executed = uniqueTexts(frames.map((frame) => frame.meta?.executedQueryString));
    if (executed.length > 0) {
      report.executedQueries = executed;
    }
    return report;
  };
  if (errors.length > 0) {
    report.status = 'error';
    return withExecuted();
  }
  if (visibleFrames.length === 0 || visibleFrames.every((frame) => frame.length === 0)) {
    report.status = 'empty';
    return withExecuted();
  }
  const processed = await processFrames(panel, visibleFrames, variables);
  if (processed.length === 0 || processed.every((frame) => frame.length === 0)) {
    report.status = 'empty';
    report.warnings.push('queries returned data, but no rows remain after transformations');
    return report;
  }
  if (panelIsTableLike(panel, processed)) {
    report.tables = processed.map((frame) => tableSummary(frame, processed, options.maxRows));
  } else {
    const series = seriesSummaries(panel, processed);
    report.series = series.slice(0, options.maxSeries);
    report.seriesTotal = series.length;
    if (series.length === 0) {
      report.warnings.push('no numeric fields to reduce');
    }
  }
  return report;
}

function skipped(
  identity: ReturnType<typeof panelIdentity>,
  queries: PanelDataReport['queries'],
  reason: string
): PanelDataReport {
  return { ...identity, status: 'skipped', queries, errors: [], warnings: [], skippedReason: reason };
}

function panelIdentity(panel: WalkedPanel) {
  return { id: panel.id, title: panel.title, type: panel.type };
}

function resolveDatasource(ref: string, datasources: PrometheusDatasourceInfo[]) {
  if (!ref || ref === 'default') {
    return datasources.find((ds) => ds.isDefault) ?? (datasources.length === 1 ? datasources[0] : undefined);
  }
  return datasources.find((ds) => ds.uid === ref || ds.name === ref);
}

function selectPanels(panels: WalkedPanel[], ids: string[], types: string[]) {
  let selected = panels;
  if (types.length > 0) {
    const wanted = new Set(types.map((type) => type.toLowerCase()));
    selected = selected.filter((panel) => wanted.has(panel.type.toLowerCase()));
  }
  if (ids.length > 0) {
    const missing = ids.filter((id) => !panels.some((panel) => panel.id === id || panel.key === id));
    if (missing.length > 0) {
      throw new DashboardWalkError(
        `no panel with id ${missing.map((id) => JSON.stringify(id)).join(', ')}; available: ${panels.map((panel) => panel.id).join(', ')}`
      );
    }
    selected = selected.filter((panel) => ids.includes(panel.id) || ids.includes(panel.key));
  }
  return selected;
}

/** Query variables saved as All without a custom all value: approximate with `.*` and say so. */
function approximateAllValues(variables: Record<string, TemplateValue>) {
  const approximated: string[] = [];
  for (const [name, variable] of Object.entries(variables)) {
    if (variable.isAll && variable.allValue === undefined && variable.allValues.length === 0) {
      variables[name] = new TemplateValue(
        variable.values,
        'All',
        variable.multi,
        true,
        true,
        '.*',
        [],
        variable.arrayValue
      );
      approximated.push(name);
    }
  }
  return approximated.length > 0
    ? [
        `Variables ${approximated.map((name) => `$${name}`).join(', ')} are set to All with unknown options and were approximated as .*; pass --var NAME=VALUE for exact values.`,
      ]
    : [];
}

function parseRange(from: string, to: string): TimeRange {
  const start = dateMath.toDateTime(from, { roundUp: false });
  const end = dateMath.toDateTime(to, { roundUp: true });
  if (!start?.isValid() || !end?.isValid()) {
    throw new DashboardWalkError(`invalid time range ${from} to ${to}`);
  }
  if (start.valueOf() >= end.valueOf()) {
    throw new DashboardWalkError(`time range start ${from} must be before end ${to}`);
  }
  return { from: start, to: end, raw: { from, to } };
}

/** Distinguishes errors inside HTTP 200 responses and missing results from empty data. */
export function framesFromResponse(payload: unknown, expectedRefs: string[]): [DataFrame[], string[]] {
  const results = isObject(payload) && isObject(payload.results) ? payload.results : undefined;
  if (!results) {
    return [[], ['response has no results object']];
  }
  const frames: DataFrame[] = [];
  const errors = expectedRefs
    .filter((refId) => !(refId in results))
    .map((refId) => `${refId}: result missing from response`);
  for (const [refId, result] of Object.entries(results)) {
    if (!isObject(result)) {
      errors.push(`${refId}: malformed query result`);
      continue;
    }
    if (result.error) {
      errors.push(`${refId}: ${asText(result.error)}`);
    }
    if (result.status != null && result.status !== 200 && result.status !== 'success') {
      errors.push(`${refId}: status ${asText(result.status)}`);
    }
    for (const raw of Array.isArray(result.frames) ? result.frames : []) {
      if (!isObject(raw)) {
        continue;
      }
      try {
        const frame = dataFrameFromJSON(raw as DataFrameJSON);
        frame.refId ||= refId;
        frames.push(frame);
      } catch (error) {
        errors.push(`${refId}: could not decode data frame: ${errorText(error)}`);
      }
    }
  }
  return [frames, errors];
}

async function processFrames(panel: WalkedPanel, frames: DataFrame[], variables: Record<string, TemplateValue>) {
  const configs = transformerConfigs(panel.transformations);
  for (const config of configs) {
    if (!config.disabled && !standardTransformersRegistry.getIfExists(config.id)) {
      throw new DashboardWalkError(`unsupported transformation ${JSON.stringify(config.id)}`);
    }
  }
  let processed = configs.length
    ? await lastValueFrom(
        transformDataFrame(configs, frames, { interpolate: (value: string) => replaceVariables(value, variables) })
      )
    : frames;
  processed = applyFieldOverrides({
    data: processed,
    fieldConfig: fieldConfigSource(panel.fieldConfig),
    fieldConfigRegistry: new FieldConfigOptionsRegistry(standardFieldProperties),
    replaceVariables: (value: string) => replaceVariables(value, variables),
    theme: createTheme(),
    timeZone: 'utc',
  });
  return panel.type === 'table' ? applyTableSort(processed, panel.options) : processed;
}

export function transformerConfigs(transformations: JsonObject[]): DataTransformerConfig[] {
  return transformations.map((transformation) => {
    const spec = isObject(transformation.spec) ? transformation.spec : transformation;
    const id = asText(transformation.id || transformation.group || spec.id || spec.group);
    if (!id) {
      throw new DashboardWalkError('transformation has no id');
    }
    const config: DataTransformerConfig = { id, options: isObject(spec.options) ? spec.options : {} };
    if (isObject(spec.filter) && spec.filter.id) {
      config.filter = { id: asText(spec.filter.id), options: spec.filter.options };
    }
    if (typeof spec.disabled === 'boolean') {
      config.disabled = spec.disabled;
    }
    if (typeof spec.topic === 'string') {
      config.topic = spec.topic as DataTransformerConfig['topic'];
    }
    return config;
  });
}

function panelIsTableLike(panel: WalkedPanel, frames: DataFrame[]) {
  if (panel.type === 'table') {
    return true;
  }
  if (
    ['stat', 'timeseries', 'piechart', 'gauge', 'bargauge', 'state-timeline', 'barchart', 'heatmap'].includes(
      panel.type
    )
  ) {
    return false;
  }
  return frames.some(
    (frame) =>
      frame.fields.some((field) => field.type === FieldType.number) &&
      frame.fields.some((field) => field.type !== FieldType.number && field.type !== FieldType.time)
  );
}

function panelCalcs(panel: WalkedPanel): string[] {
  const reduceOptions = isObject(panel.options.reduceOptions) ? panel.options.reduceOptions : {};
  const legend = isObject(panel.options.legend) ? panel.options.legend : {};
  const calcs = Array.isArray(reduceOptions.calcs) && reduceOptions.calcs.length ? reduceOptions.calcs : legend.calcs;
  const list = Array.isArray(calcs) ? calcs.map(asText).filter(Boolean) : [];
  return [...new Set(['lastNotNull', 'min', 'max', ...list])];
}

function seriesSummaries(panel: WalkedPanel, frames: DataFrame[]): NonNullable<PanelDataReport['series']> {
  const calcs = panelCalcs(panel);
  return frames.flatMap((frame) =>
    frame.fields
      .filter((field) => field.type === FieldType.number)
      .map((field) => {
        const reduced = reduceField({ field, reducers: calcs }) as Record<string, unknown>;
        const values: Record<string, unknown> = {};
        const display: Record<string, string> = {};
        for (const calc of calcs) {
          const value = reduced[calc] ?? null;
          values[calc] = typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
          display[calc] = displayText(field, value);
        }
        return { name: getFieldDisplayName(field, frame, frames), calcs: values, display };
      })
  );
}

function tableSummary(frame: DataFrame, frames: DataFrame[], maxRows: number) {
  const rows: string[][] = [];
  for (let index = 0; index < Math.min(frame.length, maxRows); index++) {
    rows.push(frame.fields.map((field) => truncate(displayText(field, field.values[index] ?? null))));
  }
  return {
    name: frame.name ?? '',
    refId: frame.refId ?? '',
    columns: frame.fields.map((field) => getFieldDisplayName(field, frame, frames)),
    rows,
    rowCount: frame.length,
  };
}

function applyTableSort(frames: DataFrame[], options: JsonObject): DataFrame[] {
  const first = Array.isArray(options.sortBy) && isObject(options.sortBy[0]) ? options.sortBy[0] : undefined;
  const name = first ? asText(first.displayName || first.field || first.name) : '';
  if (!first || !name) {
    return frames;
  }
  return frames.map((frame) => {
    const index = frame.fields.findIndex((field) => getFieldDisplayName(field, frame, frames) === name);
    if (index < 0) {
      return frame;
    }
    const order = Array.from({ length: frame.length }, (_, row) => row).sort((left, right) => {
      const diff = compareValues(frame.fields[index].values[left], frame.fields[index].values[right]);
      return first.desc ? -diff : diff;
    });
    return {
      ...frame,
      fields: frame.fields.map((field) => ({ ...field, values: order.map((row) => field.values[row]) })),
    };
  });
}

function compareValues(left: unknown, right: unknown) {
  if (left == null || right == null) {
    return left == null ? (right == null ? 0 : 1) : -1;
  }
  return typeof left === 'number' && typeof right === 'number'
    ? left - right
    : asText(left).localeCompare(asText(right));
}

function displayText(field: Field, value: unknown) {
  if (field.display) {
    return formattedValueToString(field.display(value));
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Number(value.toPrecision(6))) : String(value);
  }
  return asText(value);
}

function truncate(text: string) {
  const flat = text.replace(/\n/g, '\\n');
  return flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS - 3)}...` : flat;
}

function fieldConfigSource(value: JsonObject): FieldConfigSource {
  return {
    defaults: isObject(value.defaults) ? value.defaults : {},
    overrides: Array.isArray(value.overrides) ? value.overrides.filter(isObject) : [],
  } as unknown as FieldConfigSource;
}

function standardFieldProperties(): FieldConfigPropertyItem[] {
  const editor = (() => null) as unknown as FieldConfigPropertyItem['editor'];
  const override = (() => null) as unknown as FieldConfigPropertyItem['override'];
  const item = (id: string): FieldConfigPropertyItem => ({
    id,
    path: id,
    name: id,
    editor,
    override,
    process: identityOverrideProcessor,
    shouldApply: () => true,
  });
  return [
    { ...item('displayName'), process: displayNameOverrideProcessor, settings: { expandTemplateVars: true } },
    ...['unit', 'min', 'max', 'fieldMinMax', 'decimals', 'thresholds', 'mappings', 'noValue', 'links', 'color'].map(
      item
    ),
  ];
}

/** Grafana registers transformers at boot; outside Grafana (tests) register the standard set. */
function ensureStandardTransformers() {
  const registry = standardTransformersRegistry as unknown as { initialized?: boolean; init?: unknown };
  if (registry.initialized || registry.init) {
    return;
  }
  standardTransformersRegistry.setInit(() => {
    const items = new Map<string, TransformerRegistryItem>();
    for (const transformer of Object.values(standardTransformers)) {
      for (const id of [transformer.id, ...((transformer as { aliasIds?: string[] }).aliasIds ?? [])]) {
        if (!items.has(id)) {
          const item: TransformerRegistryItem = {
            id,
            name: transformer.name,
            description: transformer.description,
            transformation: () => Promise.resolve(transformer),
            defaultOptions: transformer.defaultOptions,
            editor: (() => null) as unknown as TransformerRegistryItem['editor'],
            imageDark: '',
            imageLight: '',
          };
          items.set(id, item);
        }
      }
    }
    return [...items.values()];
  });
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function uniqueTexts(values: Array<string | undefined>) {
  const texts = values
    .filter((value): value is string => Boolean(value))
    .map((value) => truncate(value.replace(/\s*\n\s*/g, '; ')));
  return [...new Set(texts)].slice(0, 5);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
