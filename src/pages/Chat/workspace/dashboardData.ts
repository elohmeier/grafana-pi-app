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
import { describePrometheusError } from '../domain/prometheusErrors';
import { mapConcurrent } from './concurrency';
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
  panelQueryOptions,
  prepareTargets,
  replaceVariables,
  TemplateValue,
  unresolvedVariables,
  unwrapDashboard,
  type DashboardShape,
  type JsonObject,
  type WalkedPanel,
} from './dashboardPanels';
import {
  gridWidthSource,
  INSTANT_REF_SUFFIX,
  panelRequest,
  panelTimeRange,
  resolvePromQuery,
  transformPrometheusFrames,
  type PanelRequest,
} from './dashboardPromEmulation';

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
  /** Browser window width panel widths (and so maxDataPoints) are derived from. */
  /** Assumed browser window width; overrides measuredGridWidth. */
  browserWidth?: number;
  /** Width of the dashboard grid rendered in the user's browser, when one is open. */
  measuredGridWidth?: number;
  datasources: PrometheusDatasourceInfo[];
  query: DashboardDataQuery;
  signal?: AbortSignal;
};

export type PanelQueryReport = {
  refId: string;
  datasource?: string;
  expr?: string;
  hidden?: boolean;
  /** Prometheus result format: time_series (default), table, or heatmap. */
  format?: string;
  /** range, instant, or both (Grafana runs "Both" as a range query and an instant query `<refId>-Instant`). */
  type?: 'range' | 'instant' | 'both';
  /** Query min step (`interval` of the query), when set. */
  minStep?: string;
  /** Step the Prometheus backend uses, as in executedQueryString. */
  step?: string;
  /** `$__interval` as the backend substitutes it. */
  interval?: string;
  /** `$__rate_interval` as the backend substitutes it. */
  rateInterval?: string;
  /** The expression with $__interval, $__rate_interval, and $__range resolved. */
  executedExpr?: string;
};

export type PanelDataReport = {
  id: string;
  title: string;
  type: string;
  /** `partial`: the queries returned data, but `notes` name something that was not emulated. */
  status: 'ok' | 'partial' | 'empty' | 'error' | 'skipped';
  queries: PanelQueryReport[];
  errors: string[];
  warnings: string[];
  /** What the check could not emulate for this panel; the browser may show something else. */
  notes?: string[];
  skippedReason?: string;
  /** The panel request as the dashboard builds it in the browser. */
  request?: {
    from: string;
    to: string;
    /** Panel relative time / time shift, when set. */
    timeOverride?: string;
    maxDataPoints: number;
    /** `panel`: set in the panel query options; `width`: the panel's pixel width. */
    maxDataPointsSource: 'panel' | 'width';
    /** Request interval (`$__interval` on the dashboard side; the backend may raise it). */
    interval: string;
    intervalMs: number;
    /** Lower limit of the interval: the panel min interval or the datasource scrape interval. */
    minInterval?: string;
  };
  /** Queries as the datasource executed them (`Expr: ...; Step: ...`, macros such as $__rate_interval resolved). */
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

type PanelContext = {
  /** Variables without any value: panels that use them are skipped. */
  unset: Set<string>;
  /** Variables approximated as `.*`. */
  approximated: Set<string>;
  /** Ad hoc filter and group-by variables with values, which Grafana adds to every Prometheus query. */
  adhoc: string[];
};

type PromTarget = { target: JsonObject; ds: PrometheusDatasourceInfo; report: PanelQueryReport };

const QUERY_CONCURRENCY = 4;
const MAX_CELL_CHARS = 120;
const EXPRESSION_DATASOURCE = { type: '__expr__', uid: '__expr__' };
const MIXED_DATASOURCE = '-- Mixed --';

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
  const defaults = resolveUnsetVariables(variables);
  const approximated = approximateAllValues(variables);
  const context: PanelContext = {
    unset: defaults.unset,
    approximated: new Set(approximated),
    adhoc: adhocVariables(shape, dashboard),
  };

  const reports = await mapConcurrent(selected, QUERY_CONCURRENCY, (panel) =>
    queryPanel(panel, variables, range, options, context).catch((error): PanelDataReport => {
      if (options.signal?.aborted) {
        throw error;
      }
      return { ...panelIdentity(panel), status: 'error', queries: [], errors: [errorText(error)], warnings: [] };
    })
  );
  const width = gridWidthSource(options);
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
      ...defaults.notes,
      ...(approximated.length > 0
        ? [
            `Variables ${approximated.map((name) => `$${name}`).join(', ')} are set to All with unknown options and were approximated as .*; pass --var NAME=VALUE for exact values.`,
          ]
        : []),
      'Values come from the saved dashboard variables and time range unless overridden with --var/--from/--to.',
      `Panel requests are sized like the browser's: without a panel maxDataPoints, maxDataPoints is the panel's pixel width in a ${width.gridWidth}px dashboard grid (${width.measured ? 'measured in the open browser window' : `a ${width.browserWidth}px browser window with the docked navigation menu`}); pass --browser-width for another screen. A narrower panel or window means a longer interval and $__rate_interval.`,
      'Queries, intervals, and frames follow Grafana and its Prometheus datasource (format table/time_series/heatmap, range/instant). Not emulated: variable queries, ad hoc filters, panel repeats, time comparison, and panel plugin rendering; affected panels list this in notes and report status partial instead of ok.',
    ],
  };
}

async function queryPanel(
  panel: WalkedPanel,
  variables: Record<string, TemplateValue>,
  dashboardRange: TimeRange,
  options: DashboardDataOptions,
  context: PanelContext
): Promise<PanelDataReport> {
  const identity = panelIdentity(panel);
  if (panel.libraryPanel) {
    return skipped(identity, [], `library panel ${panel.libraryPanel}: queries live in the library element`);
  }
  const notes: string[] = [];
  const panelOptions = panelQueryOptions(panel, variables);
  const timed = panelTimeRange(dashboardRange, panelOptions);
  if (timed.error) {
    notes.push(`${timed.error}: Grafana shows an invalid time override; the dashboard range was queried`);
  }
  const range = timed.range;
  if (panelOptions.timeCompare) {
    notes.push(`time comparison (${panelOptions.timeCompare}) is not emulated; its comparison series are missing`);
  }
  if (panelOptions.repeat) {
    notes.push(
      `the panel repeats by $${panelOptions.repeat}; Grafana shows one narrower panel per value, this ran once with all selected values`
    );
  }

  const targets = prepareTargets(panel, variables);
  const queries: PanelQueryReport[] = targets.map((target) => ({
    refId: asText(target.refId),
    ...(datasourceUid(target) ? { datasource: datasourceUid(target) } : {}),
    ...(typeof target.expr === 'string' ? { expr: target.expr } : {}),
    ...(target.hide ? { hidden: true } : {}),
  }));
  const promTargets: PromTarget[] = [];
  for (const [index, target] of targets.entries()) {
    const type = datasourceType(target);
    if (type === '__expr__' || datasourceUid(target) === '__expr__') {
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
    const noValue = missing.filter((name) => context.unset.has(name));
    if (noValue.length > 0) {
      return skipped(
        identity,
        queries,
        `variable ${noValue.map((name) => `$${name}`).join(', ')} has no value (no saved current value, All option, or options); pass ${noValue.map((name) => `--var ${name}=VALUE`).join(' ')}`
      );
    }
    if (missing.length > 0) {
      return skipped(identity, queries, `undefined variable ${missing.map((name) => `$${name}`).join(', ')}`);
    }
    promTargets.push({ target, ds, report: queries[index] });
  }
  if (targets.every((target) => target.hide)) {
    return skipped(identity, queries, 'panel has no visible queries');
  }

  const usedApproximated = [...context.approximated].filter((name) =>
    panel.targets.some((target) => unresolvedVariables(JSON.stringify(target)).includes(name))
  );
  if (usedApproximated.length > 0) {
    notes.push(
      `${usedApproximated.map((name) => `$${name}`).join(', ')} (All) was approximated as .*; Grafana uses the variable's current options`
    );
  }
  if (promTargets.length > 0 && context.adhoc.length > 0) {
    notes.push(
      `ad hoc filters of ${context.adhoc.map((name) => `$${name}`).join(', ')} are not applied; Grafana adds them to every Prometheus query`
    );
  }

  const panelDatasource = panelDatasourceRef(panel);
  const mixed = panelDatasource === MIXED_DATASOURCE;
  const gridColumns = typeof panel.gridPos?.w === 'number' ? panel.gridPos.w : undefined;
  if (gridColumns === undefined && panelOptions.maxDataPoints === undefined) {
    notes.push(
      'the layout gives no panel width (no grid position); maxDataPoints assumes a full-width panel, so the browser may use a longer interval'
    );
  }
  const request = panelRequest(range, {
    maxDataPoints: panelOptions.maxDataPoints,
    minInterval: panelOptions.interval,
    gridColumns,
    mixed,
    panelDatasourceInterval: mixed
      ? undefined
      : (resolveDatasource(panelDatasource, options.datasources) ?? promTargets[0]?.ds)?.timeInterval,
    gridWidth: gridWidthSource(options).gridWidth,
  });
  const sent = buildQueries(targets, promTargets, request, range.to.valueOf() - range.from.valueOf());
  const visibleRefs = sent.filter((target) => !target.hide).map((target) => asText(target.refId));

  const response = await options.query(
    { queries: sent, from: String(range.from.valueOf()), to: String(range.to.valueOf()) },
    options.signal
  );
  const [rawFrames, errors] = framesFromResponse(response, visibleRefs);
  const report: PanelDataReport = {
    ...identity,
    status: 'ok',
    queries,
    errors,
    warnings: [],
    request: {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      ...(timed.info ? { timeOverride: timed.info } : {}),
      maxDataPoints: request.maxDataPoints,
      maxDataPointsSource: request.maxDataPointsSource,
      interval: request.interval,
      intervalMs: request.intervalMs,
      ...(request.minInterval ? { minInterval: request.minInterval } : {}),
    },
  };
  const executed = executedQueries(sent, promTargets, rawFrames, notes);
  if (executed.length > 0) {
    report.executedQueries = executed;
  }
  const notices = uniqueTexts(rawFrames.flatMap((frame) => (frame.meta?.notices ?? []).map((notice) => notice.text)));
  if (notices.length > 0) {
    report.notices = notices;
  }
  const finish = (status: PanelDataReport['status']) => {
    report.status = status === 'ok' && notes.length > 0 ? 'partial' : status;
    if (notes.length > 0) {
      report.notes = notes;
    }
    return report;
  };
  if (errors.length > 0) {
    return finish('error');
  }
  const visibleFrames = orderByQuery(
    rawFrames.filter((frame) => !frame.refId || visibleRefs.includes(frame.refId)),
    sent
  );
  if (visibleFrames.length === 0 || visibleFrames.every((frame) => frame.length === 0)) {
    return finish('empty');
  }
  // Like the Prometheus frontend, formats are looked up by the panel's own refIds,
  // so the instant half of a "Both" query stays a time series.
  const frames = transformPrometheusFrames(
    visibleFrames,
    promTargets.map(({ target }) => ({
      refId: asText(target.refId),
      format: asText(target.format) || undefined,
      legendFormat: asText(target.legendFormat) || undefined,
    }))
  );
  const processed = await processFrames(panel, frames, variables);
  if (processed.length === 0 || processed.every((frame) => frame.length === 0)) {
    report.warnings.push('queries returned data, but no rows remain after transformations');
    return finish('empty');
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
  return finish('ok');
}

/**
 * The /api/ds/query queries the dashboard sends: every query carries the
 * panel's maxDataPoints and intervalMs; Prometheus queries are range or
 * instant, and "Both" becomes a range query plus `<refId>-Instant`, as the
 * Prometheus frontend sends them. Fills the resolved step, intervals, and
 * expression into each Prometheus query report.
 */
function buildQueries(targets: JsonObject[], promTargets: PromTarget[], request: PanelRequest, rangeMs: number) {
  const sent: JsonObject[] = [];
  for (const target of targets) {
    const common = { maxDataPoints: request.maxDataPoints, intervalMs: request.intervalMs };
    const prom = promTargets.find((item) => item.target === target);
    if (!prom) {
      sent.push({ ...target, datasource: EXPRESSION_DATASOURCE, ...common });
      continue;
    }
    const minStep = asText(target.interval);
    const resolved = resolvePromQuery(asText(target.expr), {
      queryInterval: minStep,
      intervalFactor: Number(target.intervalFactor) || undefined,
      intervalMs: request.intervalMs,
      maxDataPoints: request.maxDataPoints,
      rangeMs,
      scrapeInterval: prom.ds.timeInterval,
    });
    const instant = target.instant === true;
    const ranged = target.range === true || !instant;
    Object.assign(prom.report, {
      format: asText(target.format) || 'time_series',
      type: instant && ranged ? 'both' : instant ? 'instant' : 'range',
      ...(minStep ? { minStep } : {}),
      step: resolved.step,
      interval: resolved.interval,
      rateInterval: resolved.rateInterval,
      executedExpr: resolved.expr,
    } satisfies Partial<PanelQueryReport>);
    // Saved exemplar flags only add annotation frames, which panels do not show as data.
    const query = { ...target, datasource: { type: 'prometheus', uid: prom.ds.uid }, ...common, exemplar: false };
    if (instant && ranged) {
      sent.push(
        { ...query, instant: false, range: true },
        { ...query, refId: `${asText(target.refId)}${INSTANT_REF_SUFFIX}`, instant: true, range: false }
      );
    } else {
      sent.push({ ...query, instant, range: !instant });
    }
  }
  return sent;
}

/** Frames in the order of the panel's queries, as Grafana's toDataQueryResponse returns them. */
function orderByQuery(frames: DataFrame[], sent: JsonObject[]) {
  const order = sent.map((query) => asText(query.refId));
  const rank = (frame: DataFrame) => {
    const index = order.indexOf(frame.refId ?? '');
    return index < 0 ? order.length : index;
  };
  return frames
    .map((frame, index) => ({ frame, index }))
    .sort((left, right) => rank(left.frame) - rank(right.frame) || left.index - right.index)
    .map(({ frame }) => frame);
}

/**
 * `Expr: ...; Step: ...` per visible Prometheus query, as Grafana's backend
 * reports it on the first frame of each result. Results without it (errors,
 * missing results) use the emulated expression; a backend expression that
 * differs from the emulation is noted.
 */
function executedQueries(sent: JsonObject[], promTargets: PromTarget[], frames: DataFrame[], notes: string[]) {
  const reported = new Map<string, string>();
  for (const frame of frames) {
    const text = frame.meta?.executedQueryString;
    if (frame.refId && text && !reported.has(frame.refId)) {
      reported.set(frame.refId, text);
    }
  }
  const result: string[] = [];
  for (const query of sent) {
    const refId = asText(query.refId);
    const prom = promTargets.find(
      ({ target }) => refId === asText(target.refId) || refId === `${asText(target.refId)}${INSTANT_REF_SUFFIX}`
    );
    if (!prom || query.hide) {
      continue;
    }
    const server = reported.get(refId);
    const serverExpr = server?.match(/^Expr: ([\s\S]*?)\nStep: /)?.[1];
    if (serverExpr !== undefined && serverExpr !== prom.report.executedExpr) {
      notes.push(
        `${refId}: the datasource ran ${JSON.stringify(serverExpr)}, not the emulated ${JSON.stringify(prom.report.executedExpr)}`
      );
    }
    result.push(server ?? `Expr: ${prom.report.executedExpr}\nStep: ${prom.report.step}`);
  }
  return uniqueTexts(result, false);
}

/** The panel datasource as Grafana's query runner sees it: the panel's own, else the first query's; v2 panels whose queries differ are Mixed. */
function panelDatasourceRef(panel: WalkedPanel): string {
  const own = panel.source === 'classic' ? panel.raw.datasource : undefined;
  if (own !== undefined && own !== null) {
    return typeof own === 'string' ? own : datasourceUid({ datasource: own });
  }
  const refs = [...new Set(panel.targets.map((target) => datasourceUid(target)))];
  if (panel.source === 'v2' && refs.length > 1) {
    return MIXED_DATASOURCE;
  }
  return refs[0] ?? '';
}

/** Ad hoc filter and group-by variables that have values. */
function adhocVariables(shape: DashboardShape, dashboard: JsonObject): string[] {
  const templating = isObject(dashboard.templating) ? dashboard.templating : {};
  const items = shape === 'classic' ? templating.list : dashboard.variables;
  const names: string[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!isObject(item)) {
      continue;
    }
    const spec = isObject(item.spec) ? item.spec : item;
    const kind = asText(spec.type || item.kind);
    const current = isObject(spec.current) ? spec.current : {};
    const filters = Array.isArray(spec.filters) && spec.filters.length > 0;
    const groupBy = Array.isArray(current.value) ? current.value.length > 0 : Boolean(current.value);
    if ((/^(adhoc|AdhocVariable)$/.test(kind) && filters) || (/^(groupby|GroupByVariable)$/.test(kind) && groupBy)) {
      names.push(asText(spec.name));
    }
  }
  return names;
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

/**
 * Variables saved without a current value (as rendered Jsonnet saves them) get the value Grafana selects
 * on load: All when the variable offers it, else the first saved option. Variables with neither are left
 * unresolved so their panels are skipped instead of querying with an empty matcher.
 */
function resolveUnsetVariables(variables: Record<string, TemplateValue>) {
  const notes: string[] = [];
  const unset = new Set<string>();
  for (const [name, variable] of Object.entries(variables)) {
    if (variable.values.length > 0 || variable.isAll) {
      continue;
    }
    if (variable.includeAll) {
      variables[name] = new TemplateValue(
        ['$__all'],
        'All',
        variable.multi,
        true,
        true,
        variable.allValue,
        variable.allValues,
        variable.multi
      );
      notes.push(`Variable $${name} has no saved value; used All, as Grafana selects on load.`);
    } else if (variable.allValues.length > 0) {
      const first = variable.allValues[0];
      variables[name] = new TemplateValue([first], first, variable.multi, false, false, undefined, variable.allValues);
      notes.push(
        `Variable $${name} has no saved value; used its first option ${JSON.stringify(first)}, as Grafana selects on load.`
      );
    } else {
      delete variables[name];
      unset.add(name);
    }
  }
  return { notes, unset };
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
  return approximated;
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
      errors.push(`${refId}: ${describePrometheusError(asText(result.error))}`);
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

function uniqueTexts(values: Array<string | undefined>, bounded = true) {
  const texts = values
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/\s*\n\s*/g, '; '))
    .map((value) => (bounded ? truncate(value) : value));
  const unique = [...new Set(texts)];
  return bounded ? unique.slice(0, 5) : unique;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
