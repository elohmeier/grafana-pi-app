import { parser as promqlParser } from '@prometheus-io/lezer-promql';
import { walkClassicPanels } from '../workspace/dashboardPanels';
import { backendFetch } from './client';
import { throwIfAborted, truncateText } from './result';
import type { DashboardSearchResult, GrafanaToolConfig } from './types';

const MAX_INSPECT_USAGES = 120;
const MAX_SEARCH_DASHBOARDS = 30;
const MAX_SEARCH_USAGES = 160;
const MAX_RESULT_METRICS = 60;
const MAX_RESULT_RELATIONS = 80;

type DashboardResponse = {
  dashboard?: Record<string, any>;
  meta?: Record<string, any>;
  metadata?: Record<string, any>;
  spec?: Record<string, any>;
};

export type DashboardMetricContextParams = {
  uid: string;
  datasourceUid?: string;
  maxUsages?: number;
};

export type DashboardMetricSearchParams = {
  /** Dashboards to analyse (local working copies); without them, dashboards are searched and fetched. */
  dashboards?: Array<{ uid: string; resource: Record<string, any>; meta?: Record<string, any> }>;
  query?: string;
  tag?: string;
  datasourceUid?: string;
  seedMetric?: string;
  seedMetrics?: string[];
  maxDashboards?: number;
  maxUsages?: number;
};

export type MetricNeighborhoodParams = DashboardMetricSearchParams & {
  metric?: string;
  metrics?: string[];
  dashboardUid?: string;
  maxResults?: number;
};

export type DashboardMetricUsage = {
  metric: string;
  selector: string;
  datasourceUid?: string;
  datasourceType?: string;
  dashboardUid: string;
  dashboardTitle: string;
  folderTitle?: string;
  dashboardUrl?: string;
  dashboardTags?: string[];
  panelId?: string;
  panelTitle: string;
  panelType: string;
  rowPath?: string[];
  refId?: string;
  query: string;
  labels: MetricLabelMatcher[];
  groupingLabels: string[];
  functions: string[];
  legendFormat?: string;
  unit?: string;
};

type MetricLabelMatcher = {
  name: string;
  operator: string;
  value: string;
};

type DashboardMetricSummary = {
  metric: string;
  usageCount: number;
  dashboardCount: number;
  panelCount: number;
  labels: string[];
  groupingLabels: string[];
  functions: string[];
  dashboards: Array<{ uid: string; title: string; folderTitle?: string; url?: string }>;
  panels: Array<{ dashboardUid: string; dashboardTitle: string; panelTitle: string; panelType: string }>;
  exampleQueries: string[];
  score?: number;
  reasons?: string[];
};

type MetricRelation = {
  source: string;
  target: string;
  score: number;
  reasons: string[];
};

type MetricUsageAccumulator = {
  usages: DashboardMetricUsage[];
  dashboards: Map<string, DashboardMetricSummary['dashboards'][number]>;
  panels: Map<string, DashboardMetricSummary['panels'][number]>;
  labels: Set<string>;
  groupingLabels: Set<string>;
  functions: Set<string>;
  queries: Set<string>;
};

type ExtractedDashboardMetricUsage = {
  dashboard: {
    uid: string;
    title: string;
    folderTitle?: string;
    url?: string;
    tags?: string[];
  };
  metrics: DashboardMetricSummary[];
  usages: DashboardMetricUsage[];
  relations: MetricRelation[];
  omitted?: {
    usages?: number;
  };
};

type QueryFacts = {
  selectors: Array<{ metric?: string; selector: string; labels: MetricLabelMatcher[] }>;
  bareMetrics: string[];
  groupingLabels: string[];
  functions: string[];
};

const PROMQL_RESERVED_IDENTIFIERS = new Set([
  'abs',
  'absent',
  'absent_over_time',
  'acos',
  'acosh',
  'and',
  'asin',
  'asinh',
  'atan',
  'atanh',
  'avg',
  'avg_over_time',
  'bool',
  'bottomk',
  'by',
  'ceil',
  'changes',
  'clamp',
  'clamp_max',
  'clamp_min',
  'cos',
  'cosh',
  'count',
  'count_over_time',
  'count_values',
  'day_of_month',
  'day_of_week',
  'day_of_year',
  'days_in_month',
  'delta',
  'deriv',
  'exp',
  'floor',
  'group',
  'group_left',
  'group_right',
  'histogram_avg',
  'histogram_count',
  'histogram_fraction',
  'histogram_quantile',
  'histogram_sum',
  'hour',
  'idelta',
  'ignoring',
  'increase',
  'irate',
  'label_join',
  'label_replace',
  'last_over_time',
  'ln',
  'log10',
  'log2',
  'max',
  'max_over_time',
  'min',
  'min_over_time',
  'minute',
  'month',
  'offset',
  'on',
  'or',
  'predict_linear',
  'present_over_time',
  'quantile',
  'quantile_over_time',
  'rate',
  'resets',
  'round',
  'scalar',
  'sgn',
  'sin',
  'sinh',
  'sort',
  'sort_desc',
  'sqrt',
  'stddev',
  'stddev_over_time',
  'stdvar',
  'stdvar_over_time',
  'sum',
  'sum_over_time',
  'tan',
  'tanh',
  'time',
  'timestamp',
  'topk',
  'unless',
  'vector',
  'without',
  'year',
]);

export function extractDashboardMetricUsage(
  dashboard: Record<string, any>,
  options: {
    meta?: Record<string, any>;
    uid?: string;
    datasourceUid?: string;
    allowedPrometheusDatasourceUids?: string[];
    maxUsages?: number;
  } = {}
): ExtractedDashboardMetricUsage {
  const uid = options.uid ?? stringField(dashboard, 'uid') ?? stringField(options.meta, 'uid') ?? 'unknown';
  const title = stringField(dashboard, 'title') ?? stringField(options.meta, 'slug') ?? uid;
  const tags = stringArrayField(dashboard, 'tags');
  const allowedDatasourceUids = new Set((options.allowedPrometheusDatasourceUids ?? []).filter(Boolean));
  const usages = walkClassicPanels(dashboard)
    .flatMap(({ panel, rowPath }) =>
      extractPanelMetricUsages({
        dashboard,
        meta: options.meta,
        uid,
        title,
        tags,
        panel,
        rowPath,
      })
    )
    .filter((usage) => matchesDatasourceFilters(usage, options.datasourceUid, allowedDatasourceUids));
  const maxUsages = clampInt(options.maxUsages ?? MAX_INSPECT_USAGES, 1, Number.MAX_SAFE_INTEGER);
  const limitedUsages = usages.slice(0, maxUsages);
  const metrics = summarizeMetricUsages(limitedUsages);
  const relations = summarizeMetricRelations(limitedUsages);

  return {
    dashboard: compactRecord({
      uid,
      title,
      folderTitle: stringField(options.meta, 'folderTitle'),
      url: stringField(options.meta, 'url'),
      tags: tags.length > 0 ? tags : undefined,
    }),
    metrics,
    usages: limitedUsages,
    relations,
    omitted: usages.length > limitedUsages.length ? { usages: usages.length - limitedUsages.length } : undefined,
  } as ExtractedDashboardMetricUsage;
}

/**
 * Extracts Prometheus metric usage from one dashboard. `resource` is a local
 * working copy ({spec}) or a legacy API response; without it the dashboard is
 * fetched by UID.
 */
export async function inspectDashboardMetricUsage(
  args: DashboardMetricContextParams,
  toolConfig: GrafanaToolConfig,
  options: { resource?: Record<string, any>; meta?: Record<string, any>; signal?: AbortSignal } = {}
) {
  throwIfAborted(options.signal);
  const response: DashboardResponse = options.resource ?? (await fetchDashboard(args.uid));
  return extractDashboardMetricUsage(dashboardSpecFromResponse(response), {
    meta: options.meta ?? response.meta,
    uid: args.uid,
    datasourceUid: args.datasourceUid,
    allowedPrometheusDatasourceUids: toolConfig.allowedPrometheusDatasourceUids,
    maxUsages: args.maxUsages,
  });
}

/** Searches visible dashboards and returns a ranked Prometheus metric usage corpus. */
export async function searchDashboardMetricUsage(
  args: DashboardMetricSearchParams,
  toolConfig: GrafanaToolConfig,
  signal?: AbortSignal
) {
  throwIfAborted(signal);
  return buildDashboardMetricUsageSearch({ params: args, toolConfig, signal });
}

/** Ranks metrics related to seed metrics by dashboard co-usage, shared panels, and label signatures. */
export async function getMetricNeighborhood(
  args: MetricNeighborhoodParams,
  toolConfig: GrafanaToolConfig,
  signal?: AbortSignal
) {
  throwIfAborted(signal);
  const seedMetrics = normalizeSeedMetrics([args.metric, ...(args.metrics ?? [])]);
  if (seedMetrics.length === 0) {
    throw new Error('at least one seed metric is required');
  }

  const corpus = args.dashboardUid
    ? await metricUsageCorpusForDashboard({ uid: args.dashboardUid, params: args, toolConfig, signal })
    : await buildDashboardMetricUsageSearch({ params: { ...args, seedMetrics }, toolConfig, signal });
  const seedSet = new Set(seedMetrics);
  const maxResults = clampInt(args.maxResults ?? MAX_RESULT_METRICS, 1, Number.MAX_SAFE_INTEGER);
  const neighbors = rankMetricSummaries({
    summaries: corpus.metrics.filter((metric) => !seedSet.has(metric.metric)),
    relations: corpus.relations,
    seedMetrics,
    query: args.query,
  }).slice(0, maxResults);
  return {
    seedMetrics,
    dashboards: corpus.dashboards,
    neighbors,
    relations: corpus.relations
      .filter((relation) => seedSet.has(relation.source) || seedSet.has(relation.target))
      .slice(0, MAX_RESULT_RELATIONS),
    usages: corpus.usages
      .filter((usage) => seedSet.has(usage.metric) || neighbors.some((metric) => metric.metric === usage.metric))
      .slice(0, args.maxUsages ? clampInt(args.maxUsages, 1, Number.MAX_SAFE_INTEGER) : MAX_SEARCH_USAGES),
    omitted: corpus.omitted,
  };
}

async function buildDashboardMetricUsageSearch({
  params,
  toolConfig,
  signal,
}: {
  params: DashboardMetricSearchParams;
  toolConfig: GrafanaToolConfig;
  signal?: AbortSignal;
}) {
  const dashboards: ExtractedDashboardMetricUsage[] = [];
  if (params.dashboards) {
    for (const item of params.dashboards) {
      throwIfAborted(signal);
      dashboards.push(
        withErrorContext(`extract dashboard metric usage for ${item.uid}`, () =>
          extractDashboardMetricUsage(dashboardSpecFromResponse(item.resource), {
            meta: item.meta,
            uid: item.uid,
            datasourceUid: params.datasourceUid,
            allowedPrometheusDatasourceUids: toolConfig.allowedPrometheusDatasourceUids,
            maxUsages: Number.MAX_SAFE_INTEGER,
          })
        )
      );
    }
    return withErrorContext('build dashboard metric corpus', () => metricUsageCorpus({ dashboards, params }));
  }
  const maxDashboards = clampInt(params.maxDashboards ?? MAX_SEARCH_DASHBOARDS, 1, MAX_SEARCH_DASHBOARDS);
  const searchResults = await withAsyncErrorContext('search dashboards', () =>
    searchDashboardsForMetricContext(params, maxDashboards)
  );

  for (const item of searchResults.slice(0, maxDashboards)) {
    throwIfAborted(signal);
    if (!item.uid) {
      continue;
    }
    try {
      const response = await fetchDashboard(item.uid);
      dashboards.push(
        withErrorContext(`extract dashboard metric usage for ${item.uid}`, () =>
          extractDashboardMetricUsage(dashboardSpecFromResponse(response), {
            meta: {
              ...response.meta,
              folderTitle: response.meta?.folderTitle ?? item.folderTitle,
              url: response.meta?.url ?? item.url,
            },
            uid: item.uid,
            datasourceUid: params.datasourceUid,
            allowedPrometheusDatasourceUids: toolConfig.allowedPrometheusDatasourceUids,
            maxUsages: Number.MAX_SAFE_INTEGER,
          })
        )
      );
    } catch {
      // Dashboards can disappear or become unreadable between search and fetch.
    }
  }

  return withErrorContext('build dashboard metric corpus', () =>
    metricUsageCorpus({
      dashboards,
      params,
    })
  );
}

async function searchDashboardsForMetricContext(params: DashboardMetricSearchParams, maxDashboards: number) {
  const searchResults = await fetchDashboardSearchResults({
    query: params.query,
    tag: params.tag,
    limit: maxDashboards,
  });
  if (searchResults.length > 0 || !params.query) {
    return searchResults;
  }

  const relaxedQuery = relaxedDashboardSearchQuery(params.query);
  if (!relaxedQuery || relaxedQuery === params.query) {
    return searchResults;
  }

  const relaxedResults = await fetchDashboardSearchResults({
    query: relaxedQuery,
    tag: params.tag,
    limit: Math.min(MAX_SEARCH_DASHBOARDS, Math.max(maxDashboards, maxDashboards * 4)),
  });
  const tokens = searchTokens(params.query);
  const locallyMatched = relaxedResults.filter((result) => dashboardSearchResultMatchesTokens(result, tokens));
  return locallyMatched.length > 0 ? locallyMatched.slice(0, maxDashboards) : relaxedResults.slice(0, maxDashboards);
}

async function fetchDashboardSearchResults(params: { query?: string; tag?: string; limit: number }) {
  const searchResponse = await fetchGrafanaApi<unknown>('/api/search', {
    type: 'dash-db',
    query: params.query,
    tag: params.tag,
    limit: params.limit,
  });
  return withErrorContext('normalize dashboard search results', () => normalizeDashboardSearchResults(searchResponse));
}

async function metricUsageCorpusForDashboard({
  uid,
  params,
  toolConfig,
  signal,
}: {
  uid: string;
  params: MetricNeighborhoodParams;
  toolConfig: GrafanaToolConfig;
  signal?: AbortSignal;
}) {
  throwIfAborted(signal);
  const response = await fetchDashboard(uid);
  return metricUsageCorpus({
    dashboards: [
      extractDashboardMetricUsage(dashboardSpecFromResponse(response), {
        meta: response.meta,
        uid,
        datasourceUid: params.datasourceUid,
        allowedPrometheusDatasourceUids: toolConfig.allowedPrometheusDatasourceUids,
        maxUsages: MAX_SEARCH_USAGES,
      }),
    ],
    params,
  });
}

export function metricUsageCorpus({
  dashboards,
  params,
}: {
  dashboards: ExtractedDashboardMetricUsage[];
  params: DashboardMetricSearchParams;
}) {
  const maxUsages = clampInt(params.maxUsages ?? MAX_SEARCH_USAGES, 1, Number.MAX_SAFE_INTEGER);
  const usages = dashboards.flatMap((dashboard) => dashboard.usages);
  const limitedUsages = usages.slice(0, maxUsages);
  const seedMetrics = normalizeSeedMetrics([params.seedMetric, ...(params.seedMetrics ?? [])]);
  // Rankings cover every usage; only the printed usage list is limited.
  const relations = summarizeMetricRelations(usages);
  const summaries = summarizeMetricUsages(usages);
  const used = new Set(summaries.map((summary) => summary.metric));
  const seedsNotFound = seedMetrics.filter((metric) => !used.has(metric));
  const metrics = rankMetricSummaries({
    summaries,
    relations,
    seedMetrics,
    query: params.query,
  }).slice(0, MAX_RESULT_METRICS);

  return {
    seedMetrics: seedMetrics.length > 0 ? seedMetrics : undefined,
    // Without this, rankings of other metrics look like results for a seed no dashboard uses.
    seedsNotFound: seedsNotFound.length > 0 ? seedsNotFound : undefined,
    metrics,
    relations: relations.slice(0, MAX_RESULT_RELATIONS),
    usages: limitedUsages,
    dashboards: dashboards.map((dashboard) => dashboard.dashboard),
    omitted: usages.length > limitedUsages.length ? { usages: usages.length - limitedUsages.length } : undefined,
  } as {
    seedMetrics?: string[];
    seedsNotFound?: string[];
    metrics: DashboardMetricSummary[];
    relations: MetricRelation[];
    usages: DashboardMetricUsage[];
    dashboards: Array<ExtractedDashboardMetricUsage['dashboard']>;
    omitted?: { usages?: number };
  };
}

async function fetchDashboard(uid: string): Promise<DashboardResponse> {
  return fetchGrafanaApi<DashboardResponse>(`/api/dashboards/uid/${encodeURIComponent(uid)}`);
}

function dashboardSpecFromResponse(response: DashboardResponse): Record<string, any> {
  const nestedSpec = recordField(response.dashboard, 'spec');
  if (isDashboardV2Spec(response.dashboard) || isLegacyDashboardSpec(response.dashboard)) {
    return response.dashboard;
  }
  if (isDashboardV2Spec(nestedSpec) || isLegacyDashboardSpec(nestedSpec)) {
    return nestedSpec;
  }
  if (isDashboardV2Spec(response.spec) || isLegacyDashboardSpec(response.spec)) {
    return response.spec;
  }
  if (isDashboardV2Spec(response) || isLegacyDashboardSpec(response)) {
    return response;
  }
  return {};
}

function isDashboardV2Spec(value: unknown): value is Record<string, any> {
  return isRecord(value) && isRecord(value.elements);
}

function isLegacyDashboardSpec(value: unknown): value is Record<string, any> {
  return isRecord(value) && Array.isArray(value.panels);
}

async function fetchGrafanaApi<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  try {
    const result = await backendFetch<T>(url, { params });
    if (result !== undefined && result !== null) {
      return result;
    }
  } catch (backendError) {
    return fetchGrafanaApiWithSameOriginFallback<T>(url, params, backendError);
  }

  return fetchGrafanaApiWithSameOriginFallback<T>(url, params, new Error('Grafana backend fetch returned no data'));
}

async function fetchGrafanaApiWithSameOriginFallback<T>(
  url: string,
  params: Record<string, unknown> | undefined,
  backendError: unknown
): Promise<T> {
  if (typeof fetch !== 'function') {
    throw backendError;
  }

  try {
    const query = toQueryString(params);
    const response = await fetch(query ? `${url}?${query}` : url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    return (await response.json()) as T;
  } catch (fetchError) {
    throw new Error(
      `${formatUnknownError(backendError)}; same-origin fetch fallback failed: ${formatUnknownError(fetchError)}`
    );
  }
}

function normalizeDashboardSearchResults(value: unknown): DashboardSearchResult[] {
  if (Array.isArray(value)) {
    return value.filter(isDashboardSearchResult);
  }
  if (isRecord(value) && Array.isArray(value.data)) {
    return value.data.filter(isDashboardSearchResult);
  }
  throw new Error(`Unexpected dashboard search response: ${truncateText(formatUnknownJson(value), 1000)}`);
}

function isDashboardSearchResult(value: unknown): value is DashboardSearchResult {
  return isRecord(value) && typeof value.uid === 'string' && value.uid.length > 0;
}

function extractPanelMetricUsages({
  dashboard,
  meta,
  uid,
  title,
  tags,
  panel,
  rowPath,
}: {
  dashboard: Record<string, any>;
  meta?: Record<string, any>;
  uid: string;
  title: string;
  tags: string[];
  panel: Record<string, any>;
  rowPath: string[];
}): DashboardMetricUsage[] {
  const panelDatasourceUid = datasourceUid(panel.datasource);
  const panelDatasourceType = datasourceType(panel.datasource);
  const panelTitle = stringField(panel, 'title') ?? '<No title>';
  const panelType = stringField(panel, 'type') ?? 'unknown';
  const panelId = stringOrNumberField(panel, 'id');
  const unit = stringField(recordField(recordField(panel, 'fieldConfig'), 'defaults'), 'unit');

  return arrayField(panel, 'targets')
    .filter(isRecord)
    .flatMap((target) => {
      const query = targetQueryText(target);
      const queryKind = targetQueryKind(target);
      const targetDatasourceUid = datasourceUid(target.datasource) ?? panelDatasourceUid;
      const targetDatasourceType = datasourceType(target.datasource) ?? panelDatasourceType;

      if (!query || (queryKind !== 'expr' && targetDatasourceType && targetDatasourceType !== 'prometheus')) {
        return [];
      }

      const facts = extractPrometheusQueryFacts(query);
      return facts.selectors
        .filter((selector) => selector.metric)
        .map(
          (selector): DashboardMetricUsage => ({
            metric: selector.metric!,
            selector: selector.selector,
            datasourceUid: targetDatasourceUid,
            datasourceType: targetDatasourceType,
            dashboardUid: uid,
            dashboardTitle: title,
            folderTitle: stringField(meta, 'folderTitle'),
            dashboardUrl: stringField(meta, 'url'),
            dashboardTags: tags.length > 0 ? tags : undefined,
            panelId,
            panelTitle,
            panelType,
            rowPath: rowPath.length > 0 ? rowPath : undefined,
            refId: stringField(target, 'refId'),
            query,
            labels: selector.labels,
            groupingLabels: facts.groupingLabels,
            functions: facts.functions,
            legendFormat: stringField(target, 'legendFormat'),
            unit,
          })
        );
    });
}

function extractPrometheusQueryFacts(query: string): QueryFacts {
  const parsed = extractPrometheusQueryFactsWithLezer(query);
  if (parsed) {
    return parsed;
  }

  const selectors = extractSelectors(query);
  const selectorMetrics = new Set(
    selectors.map((selector) => selector.metric).filter((metric): metric is string => Boolean(metric))
  );
  const bareMetrics = extractBareMetricNames(query).filter((metric) => !selectorMetrics.has(metric));

  for (const metric of bareMetrics) {
    selectors.push({ metric, selector: metric, labels: [] });
  }

  return {
    selectors,
    bareMetrics,
    groupingLabels: extractGroupingLabels(query),
    functions: extractPromqlFunctions(query),
  };
}

function extractPrometheusQueryFactsWithLezer(query: string): QueryFacts | undefined {
  try {
    const tree = promqlParser.parse(query);
    const selectors: QueryFacts['selectors'] = [];
    const groupingLabels = new Set<string>();
    const functions = new Set<string>();

    tree.iterate({
      enter(node) {
        if (node.name === 'VectorSelector') {
          selectors.push(readVectorSelector(query.slice(node.from, node.to)));
          return;
        }

        if (node.name === 'GroupingLabels') {
          for (const label of query.slice(node.from, node.to).matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
            groupingLabels.add(label[0]);
          }
          return;
        }

        if (node.name === 'FunctionIdentifier' || node.name === 'AggregateOp') {
          const name = query.slice(node.from, node.to).trim();
          if (name) {
            functions.add(name);
          }
        }
      },
    });

    return {
      selectors,
      bareMetrics: selectors
        .filter((selector) => selector.labels.length === 0 && selector.metric)
        .map((selector) => selector.metric!),
      groupingLabels: [...groupingLabels].sort(),
      functions: [...functions].sort(),
    };
  } catch {
    return undefined;
  }
}

function readVectorSelector(selector: string): QueryFacts['selectors'][number] {
  const metricPrefix = selector.match(/^\s*([A-Za-z_:][A-Za-z0-9_:]*)/)?.[1];
  const labelStart = selector.indexOf('{');
  const labelEnd = selector.lastIndexOf('}');
  const labels =
    labelStart >= 0 && labelEnd > labelStart ? parseLabelMatchers(selector.slice(labelStart + 1, labelEnd)) : [];
  const metricFromNameMatcher = labels.find((label) => label.name === '__name__' && label.operator === '=')?.value;
  const metric = metricPrefix || metricFromNameMatcher;

  return {
    metric,
    selector,
    labels: labels.filter((label) => label.name !== '__name__'),
  };
}

function extractSelectors(query: string): QueryFacts['selectors'] {
  const selectors: QueryFacts['selectors'] = [];
  const selectorPattern = /([A-Za-z_:][A-Za-z0-9_:]*)?\s*\{([^{}]*)\}/g;

  for (const match of query.matchAll(selectorPattern)) {
    const metricFromPrefix = match[1]?.trim();
    const labelText = match[2] ?? '';
    const labels = parseLabelMatchers(labelText);
    const metricFromNameMatcher = labels.find((label) => label.name === '__name__' && label.operator === '=')?.value;
    const metric = metricFromPrefix || metricFromNameMatcher;
    selectors.push({
      metric,
      selector: `${metricFromPrefix ?? ''}{${labelText}}`,
      labels: labels.filter((label) => label.name !== '__name__'),
    });
  }

  return selectors;
}

function extractBareMetricNames(query: string): string[] {
  const withoutStrings = stripStringLiterals(query);
  const withoutSelectors = withoutStrings.replace(/([A-Za-z_:][A-Za-z0-9_:]*)?\s*\{[^{}]*\}/g, ' ');
  const withoutGrouping = withoutSelectors.replace(/\b(?:by|without)\s*\([^)]*\)/gi, ' ');
  const metrics = new Set<string>();

  for (const match of withoutGrouping.matchAll(/\b[A-Za-z_:][A-Za-z0-9_:]*\b/g)) {
    const token = match[0];
    const next = withoutGrouping.slice(match.index + token.length).trimStart()[0];
    if (next === '(' || PROMQL_RESERVED_IDENTIFIERS.has(token) || token.startsWith('__')) {
      continue;
    }
    metrics.add(token);
  }

  return [...metrics];
}

function extractPromqlFunctions(query: string): string[] {
  const functions = new Set<string>();
  const withoutStrings = stripStringLiterals(query);

  for (const match of withoutStrings.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const name = match[1];
    if (PROMQL_RESERVED_IDENTIFIERS.has(name)) {
      functions.add(name);
    }
  }

  return [...functions].sort();
}

function extractGroupingLabels(query: string): string[] {
  const labels = new Set<string>();

  for (const match of query.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/gi)) {
    for (const label of (match[1] ?? '').split(',')) {
      const trimmed = label.trim();
      if (trimmed) {
        labels.add(trimmed);
      }
    }
  }

  return [...labels].sort();
}

function parseLabelMatchers(value: string): MetricLabelMatcher[] {
  return splitMatcherList(value)
    .map((matcher) => matcher.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(!=|=~|!~|=)\s*("(?:\\.|[^"\\])*"|[^,]+)\s*$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      name: match[1],
      operator: match[2],
      value: unquotePromqlString(match[3].trim()),
    }));
}

function splitMatcherList(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      if (current.trim()) {
        result.push(current.trim());
      }
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

function unquotePromqlString(value: string) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\(["'\\])/g, '$1');
  }
  return value;
}

function stripStringLiterals(value: string) {
  return value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ' ');
}

function summarizeMetricUsages(usages: DashboardMetricUsage[]): DashboardMetricSummary[] {
  const byMetric = new Map<string, MetricUsageAccumulator>();

  for (const usage of usages) {
    const summary = byMetric.get(usage.metric) ?? newMetricUsageAccumulator();
    summary.usages.push(usage);
    summary.dashboards.set(usage.dashboardUid, {
      uid: usage.dashboardUid,
      title: usage.dashboardTitle,
      folderTitle: usage.folderTitle,
      url: usage.dashboardUrl,
    });
    summary.panels.set(`${usage.dashboardUid}:${usage.panelId ?? usage.panelTitle}`, {
      dashboardUid: usage.dashboardUid,
      dashboardTitle: usage.dashboardTitle,
      panelTitle: usage.panelTitle,
      panelType: usage.panelType,
    });
    for (const label of usage.labels) {
      summary.labels.add(label.name);
    }
    for (const label of usage.groupingLabels) {
      summary.groupingLabels.add(label);
    }
    for (const fn of usage.functions) {
      summary.functions.add(fn);
    }
    summary.queries.add(usage.query);
    byMetric.set(usage.metric, summary);
  }

  return [...byMetric.entries()]
    .map(([metric, summary]) => ({
      metric,
      usageCount: summary.usages.length,
      dashboardCount: summary.dashboards.size,
      panelCount: summary.panels.size,
      labels: [...summary.labels].sort(),
      groupingLabels: [...summary.groupingLabels].sort(),
      functions: [...summary.functions].sort(),
      dashboards: [...summary.dashboards.values()].slice(0, 8),
      panels: [...summary.panels.values()].slice(0, 12),
      exampleQueries: [...summary.queries].slice(0, 4),
    }))
    .sort((left, right) => right.usageCount - left.usageCount || left.metric.localeCompare(right.metric));
}

function newMetricUsageAccumulator(): MetricUsageAccumulator {
  return {
    usages: [],
    dashboards: new Map(),
    panels: new Map(),
    labels: new Set(),
    groupingLabels: new Set(),
    functions: new Set(),
    queries: new Set(),
  };
}

function summarizeMetricRelations(usages: DashboardMetricUsage[]): MetricRelation[] {
  const relations = new Map<string, MetricRelation>();
  const panels = groupUsages(usages, (usage) => `${usage.dashboardUid}:${usage.panelId ?? usage.panelTitle}`);
  const dashboards = groupUsages(usages, (usage) => usage.dashboardUid);
  const families = groupUsages(usages, (usage) => metricFamily(usage.metric));

  for (const group of panels.values()) {
    addRelationsForGroup(relations, uniqueMetrics(group), 24, 'same panel');
  }
  for (const group of dashboards.values()) {
    addRelationsForGroup(relations, uniqueMetrics(group), 5, 'same dashboard');
  }
  for (const group of families.values()) {
    addRelationsForGroup(relations, uniqueMetrics(group), 16, 'same metric family');
  }

  const summaries = summarizeMetricUsages(usages);
  for (let leftIndex = 0; leftIndex < summaries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < summaries.length; rightIndex += 1) {
      const sharedLabels = intersectionCount(summaries[leftIndex].labels, summaries[rightIndex].labels);
      if (sharedLabels >= 2) {
        addRelation(
          relations,
          summaries[leftIndex].metric,
          summaries[rightIndex].metric,
          sharedLabels * 3,
          'shared labels'
        );
      }
    }
  }

  return [...relations.values()].sort(
    (left, right) => right.score - left.score || left.source.localeCompare(right.source)
  );
}

function rankMetricSummaries({
  summaries,
  relations,
  seedMetrics,
  query,
}: {
  summaries: DashboardMetricSummary[];
  relations: MetricRelation[];
  seedMetrics: string[];
  query?: string;
}): DashboardMetricSummary[] {
  const seedSet = new Set(seedMetrics);
  const searchTerms = searchTokens(query);
  const relationScoreByMetric = new Map<string, { score: number; reasons: Set<string> }>();

  for (const relation of relations) {
    if (!seedSet.has(relation.source) && !seedSet.has(relation.target)) {
      continue;
    }
    const metric = seedSet.has(relation.source) ? relation.target : relation.source;
    const score = relationScoreByMetric.get(metric) ?? { score: 0, reasons: new Set<string>() };
    score.score += relation.score;
    for (const reason of relation.reasons) {
      score.reasons.add(reason);
    }
    relationScoreByMetric.set(metric, score);
  }

  return summaries
    .map((summary) => {
      const relationScore = relationScoreByMetric.get(summary.metric);
      const queryScore = scoreSummaryForQuery(summary, searchTerms);
      const directSeedScore = seedSet.has(summary.metric) ? 100 : 0;
      const score =
        directSeedScore +
        summary.usageCount * 10 +
        summary.dashboardCount * 6 +
        summary.panelCount * 4 +
        summary.labels.length +
        queryScore +
        (relationScore?.score ?? 0);
      const reasons = [
        seedSet.has(summary.metric) ? 'seed metric' : undefined,
        relationScore ? [...relationScore.reasons].join(', ') : undefined,
        queryScore > 0 ? 'text match' : undefined,
      ].filter((reason): reason is string => Boolean(reason));

      // With seeds, the seeds and the metrics used together with them come first, whatever their usage count.
      const tier = seedSet.size === 0 ? 0 : seedSet.has(summary.metric) ? 0 : relationScore ? 1 : 2;
      return {
        ...summary,
        score,
        tier,
        reasons: reasons.length > 0 ? reasons : undefined,
      };
    })
    .sort(
      (left, right) =>
        left.tier - right.tier || (right.score ?? 0) - (left.score ?? 0) || left.metric.localeCompare(right.metric)
    )
    .map(({ tier: _tier, ...summary }) => summary);
}

function scoreSummaryForQuery(summary: DashboardMetricSummary, searchTerms: string[]) {
  if (searchTerms.length === 0) {
    return 0;
  }
  const haystack = [
    summary.metric,
    ...summary.labels,
    ...summary.groupingLabels,
    ...summary.functions,
    ...summary.panels.flatMap((panel) => [panel.dashboardTitle, panel.panelTitle]),
  ]
    .join(' ')
    .toLowerCase();
  return searchTerms.reduce((score, term) => score + (haystack.includes(term) ? 8 : 0), 0);
}

function addRelationsForGroup(
  relations: Map<string, MetricRelation>,
  metrics: string[],
  score: number,
  reason: string
) {
  for (let leftIndex = 0; leftIndex < metrics.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < metrics.length; rightIndex += 1) {
      addRelation(relations, metrics[leftIndex], metrics[rightIndex], score, reason);
    }
  }
}

function addRelation(
  relations: Map<string, MetricRelation>,
  leftMetric: string,
  rightMetric: string,
  score: number,
  reason: string
) {
  if (leftMetric === rightMetric) {
    return;
  }
  const [source, target] = [leftMetric, rightMetric].sort();
  const key = `${source}\0${target}`;
  const current = relations.get(key) ?? { source, target, score: 0, reasons: [] };
  current.score += score;
  if (!current.reasons.includes(reason)) {
    current.reasons.push(reason);
  }
  relations.set(key, current);
}

function groupUsages(usages: DashboardMetricUsage[], getKey: (usage: DashboardMetricUsage) => string) {
  const groups = new Map<string, DashboardMetricUsage[]>();
  for (const usage of usages) {
    const key = getKey(usage);
    groups.set(key, [...(groups.get(key) ?? []), usage]);
  }
  return groups;
}

function uniqueMetrics(usages: DashboardMetricUsage[]) {
  return Array.from(new Set(usages.map((usage) => usage.metric))).sort();
}

function intersectionCount(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).length;
}

function metricFamily(metric: string) {
  return metric.replace(/_(bucket|sum|count|created|total)$/g, '');
}

function searchTokens(value: string | undefined) {
  return (value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_:]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function relaxedDashboardSearchQuery(value: string) {
  const tokens = searchTokens(value);
  return tokens.length >= 3 ? tokens.slice(0, 2).join(' ') : undefined;
}

function dashboardSearchResultMatchesTokens(result: DashboardSearchResult, tokens: string[]) {
  if (tokens.length === 0) {
    return true;
  }
  const haystack = [result.title, result.uid, result.url, result.folderTitle].filter(Boolean).join(' ').toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function normalizeSeedMetrics(values: Array<string | undefined>) {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

function matchesDatasourceFilters(
  usage: DashboardMetricUsage,
  datasourceUid: string | undefined,
  allowedDatasourceUids: Set<string>
) {
  if (datasourceUid && usage.datasourceUid !== datasourceUid) {
    return false;
  }
  if (allowedDatasourceUids.size === 0) {
    return true;
  }
  return Boolean(usage.datasourceUid && allowedDatasourceUids.has(usage.datasourceUid));
}

function targetQueryText(target: Record<string, any>): string | undefined {
  for (const key of ['expr', 'query', 'rawSql', 'rawQuery', 'luceneQuery', 'target', 'expression']) {
    const value = stringField(target, key);
    if (value) {
      return normalizeWhitespace(value);
    }
  }

  const model = recordField(target, 'model');
  return model ? targetQueryText(model) : undefined;
}

function targetQueryKind(target: Record<string, any>) {
  for (const key of ['expr', 'query', 'rawSql', 'rawQuery', 'luceneQuery', 'target', 'expression']) {
    if (stringField(target, key)) {
      return key;
    }
  }
  return undefined;
}

function datasourceUid(ref: unknown): string | undefined {
  if (typeof ref === 'string') {
    return ref;
  }
  return isRecord(ref) ? (stringField(ref, 'uid') ?? stringField(ref, 'name')) : undefined;
}

function datasourceType(ref: unknown): string | undefined {
  return isRecord(ref) ? stringField(ref, 'type') : undefined;
}

function compactRecord<T extends Record<string, unknown> | undefined>(record: T): Record<string, unknown> {
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => {
      if (value === undefined || value === null || value === '') {
        return false;
      }
      if (Array.isArray(value) && value.length === 0) {
        return false;
      }
      if (isRecord(value) && Object.keys(value).length === 0) {
        return false;
      }
      return true;
    })
  );
}

function normalizeWhitespace(value: string | undefined) {
  return value?.replace(/\s+/g, ' ').trim() || undefined;
}

function toQueryString(params: Record<string, unknown> | undefined) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== '') {
          search.append(key, String(item));
        }
      }
      continue;
    }
    search.set(key, String(value));
  }
  return search.toString();
}

function formatUnknownError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function withErrorContext<T>(context: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new Error(`${context}: ${formatUnknownError(error)}`);
  }
}

async function withAsyncErrorContext<T>(context: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(`${context}: ${formatUnknownError(error)}`);
  }
}

function formatUnknownJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringField(record: Record<string, any> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayField(record: Record<string, any> | undefined, key: string) {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];
}

function stringOrNumberField(record: Record<string, any> | undefined, key: string) {
  const value = record?.[key];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function arrayField(record: Record<string, any> | undefined, key: string) {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function recordField(record: Record<string, any> | undefined, key: string): Record<string, any> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
}

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
