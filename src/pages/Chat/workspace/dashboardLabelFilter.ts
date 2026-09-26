import { addPromqlLabelFilter, type ExistingPromqlMatcherStrategy } from '../tools/promqlLabelFilter';

export type DashboardLabelFilterOptions = {
  label: string;
  /** Dashboard variable whose value filters the queries; defaults to the label name. */
  variable?: string;
  operator?: '=~' | '=' | '!=' | '!~';
  existing?: ExistingPromqlMatcherStrategy;
  /** Only these panels: id (classic) or element name (v2). */
  panels?: string[];
  /** Only queries with these refIds. */
  refIds?: string[];
  /** Adds or updates a Prometheus query variable with this query, for example `label_values(up, instance)`. */
  variableQuery?: string;
  /** Datasource UID for the added variable (default: the first filtered query's datasource). */
  variableDatasourceUid?: string;
  multi?: boolean;
  includeAll?: boolean;
  /** Selected value(s) of the variable; default All (or empty without includeAll). */
  current?: string[];
};

export type DashboardLabelFilterChange = {
  panel: string;
  title?: string;
  refId: string;
  before: string;
  after: string;
};

export type DashboardLabelFilterReport = {
  format: 'classic' | 'v2';
  matcher: string;
  changed: DashboardLabelFilterChange[];
  unchanged: Array<{ panel: string; refId: string }>;
  skipped: Array<{ panel: string; refId: string; reason: string }>;
  variable?: { name: string; action: 'added' | 'updated'; query: string };
};

type QueryRef = {
  panel: string;
  title?: string;
  refId: string;
  datasourceType?: string;
  datasourceUid?: string;
  get: () => string | undefined;
  set: (expression: string) => void;
};

const VARIABLE_REF_ID = 'PrometheusVariableQueryEditor-VariableQuery';

/**
 * Adds a Prometheus label matcher bound to a dashboard variable to every
 * selected Prometheus query of a dashboard document, in place. Works on
 * classic JSON, v1 resources ({spec: classic}), and v2 resources or specs.
 */
export function applyDashboardLabelFilter(
  document: Record<string, any>,
  options: DashboardLabelFilterOptions
): DashboardLabelFilterReport {
  const spec = isRecord(document.spec) ? document.spec : document;
  const format = isRecord(spec.elements) ? 'v2' : 'classic';
  const variable = options.variable ?? options.label;
  const operator = options.operator ?? '=~';
  const value = `$${variable}`;
  const report: DashboardLabelFilterReport = {
    format,
    matcher: `${options.label}${operator}"${value}"`,
    changed: [],
    unchanged: [],
    skipped: [],
  };
  const wantedPanels = options.panels?.length ? new Set(options.panels) : undefined;
  const wantedRefIds = options.refIds?.length ? new Set(options.refIds) : undefined;
  const queries = format === 'v2' ? v2Queries(spec) : classicQueries(spec);
  if (wantedPanels) {
    const found = new Set(queries.map((query) => query.panel));
    const missing = [...wantedPanels].filter((panel) => !found.has(panel));
    if (missing.length > 0) {
      throw new Error(`no panel ${missing.map((panel) => JSON.stringify(panel)).join(', ')} with queries`);
    }
  }

  // Plan every edit first so a parse failure leaves the document untouched.
  const planned: Array<{ query: QueryRef; after: string }> = [];
  for (const query of queries) {
    if ((wantedPanels && !wantedPanels.has(query.panel)) || (wantedRefIds && !wantedRefIds.has(query.refId))) {
      continue;
    }
    const expression = query.get();
    if (query.datasourceType && query.datasourceType !== 'prometheus') {
      report.skipped.push({ panel: query.panel, refId: query.refId, reason: `${query.datasourceType} query` });
      continue;
    }
    if (!expression?.trim()) {
      report.skipped.push({ panel: query.panel, refId: query.refId, reason: 'no PromQL expression' });
      continue;
    }
    let result;
    try {
      result = addPromqlLabelFilter(expression, options.label, operator, value, options.existing ?? 'replace');
    } catch (error) {
      throw new Error(
        `panel ${query.panel} refId ${query.refId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (result.changed) {
      planned.push({ query, after: result.expression });
    } else {
      report.unchanged.push({ panel: query.panel, refId: query.refId });
    }
  }
  if (planned.length === 0 && report.unchanged.length === 0) {
    throw new Error('no Prometheus queries matched the selected panels and refIds');
  }
  for (const { query, after } of planned) {
    report.changed.push({ panel: query.panel, title: query.title, refId: query.refId, before: query.get()!, after });
    query.set(after);
  }

  if (options.variableQuery) {
    const datasourceUid =
      options.variableDatasourceUid ??
      [...planned.map((entry) => entry.query), ...queries].find((query) => query.datasourceUid)?.datasourceUid;
    const action =
      format === 'v2'
        ? upsertV2Variable(spec, variable, options, datasourceUid)
        : upsertClassicVariable(spec, variable, options, datasourceUid);
    report.variable = { name: variable, action, query: options.variableQuery };
  }
  return report;
}

function classicQueries(spec: Record<string, any>): QueryRef[] {
  const refs: QueryRef[] = [];
  const visit = (panels: unknown) => {
    if (!Array.isArray(panels)) {
      return;
    }
    for (const panel of panels) {
      if (!isRecord(panel)) {
        continue;
      }
      visit(panel.panels);
      if (!Array.isArray(panel.targets)) {
        continue;
      }
      for (const target of panel.targets) {
        if (!isRecord(target)) {
          continue;
        }
        const datasource = isRecord(target.datasource) ? target.datasource : panel.datasource;
        refs.push({
          panel: String(panel.id ?? ''),
          title: typeof panel.title === 'string' ? panel.title : undefined,
          refId: typeof target.refId === 'string' ? target.refId : 'A',
          datasourceType: datasourceType(datasource),
          datasourceUid: isRecord(datasource) && typeof datasource.uid === 'string' ? datasource.uid : undefined,
          get: () => (typeof target.expr === 'string' ? target.expr : undefined),
          set: (expression) => {
            target.expr = expression;
          },
        });
      }
    }
  };
  visit(spec.panels);
  return refs;
}

function v2Queries(spec: Record<string, any>): QueryRef[] {
  const refs: QueryRef[] = [];
  for (const [name, element] of Object.entries(spec.elements as Record<string, any>)) {
    const queries = element?.spec?.data?.spec?.queries;
    if (element?.kind !== 'Panel' || !Array.isArray(queries)) {
      continue;
    }
    for (const panelQuery of queries) {
      const query = panelQuery?.spec?.query;
      if (!isRecord(query) || !isRecord(query.spec)) {
        continue;
      }
      const querySpec = query.spec;
      refs.push({
        panel: name,
        title: typeof element.spec.title === 'string' ? element.spec.title : undefined,
        refId: typeof panelQuery.spec.refId === 'string' ? panelQuery.spec.refId : 'A',
        datasourceType: typeof query.group === 'string' ? query.group : undefined,
        datasourceUid:
          isRecord(query.datasource) && typeof query.datasource.name === 'string' ? query.datasource.name : undefined,
        get: () => (typeof querySpec.expr === 'string' ? querySpec.expr : undefined),
        set: (expression) => {
          querySpec.expr = expression;
        },
      });
    }
  }
  return refs;
}

function upsertClassicVariable(
  spec: Record<string, any>,
  name: string,
  options: DashboardLabelFilterOptions,
  datasourceUid: string | undefined
): 'added' | 'updated' {
  spec.templating = isRecord(spec.templating) ? spec.templating : {};
  const list: Array<Record<string, any>> = Array.isArray(spec.templating.list) ? spec.templating.list : [];
  spec.templating.list = list;
  const query = options.variableQuery!;
  const next = {
    type: 'query',
    name,
    label: name,
    ...(datasourceUid ? { datasource: { type: 'prometheus', uid: datasourceUid } } : {}),
    query: { query, refId: VARIABLE_REF_ID },
    definition: query,
    refresh: 2,
    multi: options.multi ?? true,
    includeAll: options.includeAll ?? true,
    ...((options.includeAll ?? true) ? { allValue: '.*' } : {}),
    current: currentOption(options) ?? ((options.includeAll ?? true) ? { text: 'All', value: '$__all' } : {}),
    options: [],
    sort: 1,
  };
  const index = list.findIndex((variable) => variable?.name === name);
  if (index >= 0) {
    list[index] = { ...list[index], ...next, label: list[index].label ?? name };
    return 'updated';
  }
  list.push(next);
  return 'added';
}

function upsertV2Variable(
  spec: Record<string, any>,
  name: string,
  options: DashboardLabelFilterOptions,
  datasourceUid: string | undefined
): 'added' | 'updated' {
  const variables: Array<Record<string, any>> = Array.isArray(spec.variables) ? spec.variables : [];
  spec.variables = variables;
  const query = options.variableQuery!;
  const includeAll = options.includeAll ?? true;
  const next = {
    kind: 'QueryVariable',
    spec: {
      name,
      label: name,
      current: currentOption(options) ?? (includeAll ? { text: 'All', value: '$__all' } : { text: '', value: '' }),
      hide: 'dontHide',
      refresh: 'onTimeRangeChanged',
      skipUrlSync: false,
      query: {
        kind: 'DataQuery',
        group: 'prometheus',
        version: 'v0',
        ...(datasourceUid ? { datasource: { name: datasourceUid } } : {}),
        spec: { query, refId: VARIABLE_REF_ID },
      },
      regex: '',
      sort: 'alphabeticalAsc',
      definition: query,
      options: [],
      multi: options.multi ?? true,
      includeAll,
      ...(includeAll ? { allValue: '.*' } : {}),
      allowCustomValue: true,
    },
  };
  const index = variables.findIndex((variable) => variable?.spec?.name === name);
  if (index >= 0) {
    const previous = variables[index];
    variables[index] = { ...next, spec: { ...next.spec, label: previous.spec?.label ?? name } };
    return 'updated';
  }
  variables.push(next);
  return 'added';
}

function currentOption(options: DashboardLabelFilterOptions) {
  const values = options.current?.filter(Boolean) ?? [];
  if (values.length === 0) {
    return undefined;
  }
  const value = (options.multi ?? true) ? values : values[0];
  return { text: value, value };
}

function datasourceType(datasource: unknown) {
  return isRecord(datasource) && typeof datasource.type === 'string' ? datasource.type : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
