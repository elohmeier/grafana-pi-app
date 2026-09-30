import { collectPanels, transformationId, unwrapDashboard, type WalkedPanel } from './dashboardPanels';
import { describeBuilderQuery } from './dashboardQueries';
import { checkDashboardPromql, lezerParser, type PromqlParser } from './promqlCheck';

export const DASHBOARD_API_GROUP = 'dashboard.grafana.app';

export type DashboardFormat = 'v1' | 'v2' | 'unknown';

export type DashboardQueryInfo = {
  refId?: string;
  datasourceUid?: string;
  datasourceType?: string;
  expr?: string;
  /** Query text of non-PromQL targets (query, rawSql, expression, ...), or a description of a builder query. */
  query?: string;
  builder?: boolean;
  legendFormat?: string;
  hidden?: boolean;
};

export type DashboardPanelInfo = {
  key: string;
  id?: number;
  title: string;
  type: string;
  /** Row and tab titles from the outermost layout level inward; empty outside rows. */
  rowPath: string[];
  collapsed?: boolean;
  gridPos?: Record<string, unknown>;
  description?: string;
  libraryPanel?: string;
  repeat?: string;
  datasourceUid?: string;
  queries: DashboardQueryInfo[];
  transformations?: string[];
  /** Compact field config and options: unit, decimals, min/max, thresholds, legend and reduce calcs. */
  display?: Record<string, unknown>;
  links?: string[];
};

export type DashboardVariableInfo = {
  name: string;
  type?: string;
  label?: string;
  datasourceUid?: string;
  query?: string;
  current?: string | string[];
  multi?: boolean;
  includeAll?: boolean;
  options?: string[];
};

export type DashboardInspection = {
  schemaVersion: 1;
  uid?: string;
  apiVersion?: string;
  format: DashboardFormat;
  title?: string;
  tags: string[];
  folderUid?: string;
  time?: { from?: string; to?: string };
  refresh?: string;
  panelCount: number;
  panels: DashboardPanelInfo[];
  variables: DashboardVariableInfo[];
  datasourceUids: string[];
};

export type ValidationLevel = 'json' | 'envelope' | 'structure' | 'queries' | 'policy' | 'server';

export type ValidationDiagnostic = {
  level: ValidationLevel;
  path?: string;
  message: string;
};

export type DashboardValidationReport = {
  schemaVersion: 1;
  ok: boolean;
  format: DashboardFormat;
  levels: Record<ValidationLevel, 'passed' | 'failed' | 'skipped'>;
  /** Parser used for the queries level: the upstream Prometheus parser, or the offline lezer fallback. */
  promqlParser?: PromqlParser['name'];
  errors: ValidationDiagnostic[];
  warnings: ValidationDiagnostic[];
  /** Validation levels that this command does not run; reported so a pass is not over-read. */
  notRun: string[];
};

type AnyRecord = Record<string, any>;

export function dashboardFormat(resource: unknown): DashboardFormat {
  const apiVersion = isRecord(resource) ? String(resource.apiVersion ?? '') : '';
  if (/\/v2/.test(apiVersion)) {
    return 'v2';
  }
  if (/\/v[01]/.test(apiVersion)) {
    return 'v1';
  }
  return 'unknown';
}

export function inspectDashboard(resource: unknown): DashboardInspection {
  const record = isRecord(resource) ? resource : {};
  const spec: AnyRecord = isRecord(record.spec) ? record.spec : record;
  const format = dashboardFormat(resource);
  const panels = walkPanels(resource);
  const variables = dashboardVariables(format === 'v2' ? spec.variables : spec.templating?.list);
  const time = isRecord(spec.timeSettings) ? spec.timeSettings : isRecord(spec.time) ? spec.time : {};
  const datasourceUids = new Set<string>();
  for (const panel of panels) {
    if (panel.datasourceUid) {
      datasourceUids.add(panel.datasourceUid);
    }
    for (const query of panel.queries) {
      if (query.datasourceUid) {
        datasourceUids.add(query.datasourceUid);
      }
    }
  }
  return {
    schemaVersion: 1,
    uid: stringOrUndefined(record.metadata?.name) ?? stringOrUndefined(spec.uid),
    apiVersion: stringOrUndefined(record.apiVersion),
    format,
    title: stringOrUndefined(spec.title),
    tags: Array.isArray(spec.tags) ? spec.tags.filter((tag: unknown): tag is string => typeof tag === 'string') : [],
    folderUid: stringOrUndefined(record.metadata?.annotations?.['grafana.app/folder']),
    ...(time.from || time.to
      ? { time: compact({ from: stringOrUndefined(time.from), to: stringOrUndefined(time.to) }) }
      : {}),
    ...(stringOrUndefined(spec.refresh ?? time.autoRefresh)
      ? { refresh: stringOrUndefined(spec.refresh ?? time.autoRefresh) }
      : {}),
    panelCount: panels.length,
    panels,
    variables,
    datasourceUids: [...datasourceUids].filter((uid) => !uid.startsWith('$') && !uid.startsWith('-- ')).sort(),
  };
}

export async function validateDashboardDocument(
  content: string,
  options: {
    expectedUid?: string;
    allowedDatasourceUids?: string[];
    managedBy?: string;
    /** Defaults to the offline lezer parser; pass the backend parser for upstream Prometheus syntax. */
    promql?: PromqlParser;
    signal?: AbortSignal;
  } = {}
): Promise<DashboardValidationReport> {
  const errors: ValidationDiagnostic[] = [];
  const warnings: ValidationDiagnostic[] = [];
  const levels: DashboardValidationReport['levels'] = {
    json: 'skipped',
    envelope: 'skipped',
    structure: 'skipped',
    queries: 'skipped',
    policy: 'skipped',
    server: 'skipped',
  };
  const notRun = [
    'version-specific Grafana schema (CUE) validation',
    'server dry-run (use --server)',
    'panel data checks (use grafana-dashboard data)',
    'rendering checks',
  ];
  let promqlParser: PromqlParser['name'] | undefined;
  const finish = (format: DashboardFormat): DashboardValidationReport => ({
    schemaVersion: 1,
    ok: errors.length === 0,
    format,
    levels,
    ...(promqlParser ? { promqlParser } : {}),
    errors,
    warnings,
    notRun,
  });

  let resource: unknown;
  try {
    resource = JSON.parse(content);
    levels.json = 'passed';
  } catch (error) {
    levels.json = 'failed';
    errors.push({ level: 'json', message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` });
    return finish('unknown');
  }

  const record = isRecord(resource) ? resource : undefined;
  const envelopeErrors = errors.length;
  if (!record) {
    errors.push({ level: 'envelope', message: 'document must be a JSON object' });
  } else {
    const apiVersion = String(record.apiVersion ?? '');
    if (!apiVersion.startsWith(`${DASHBOARD_API_GROUP}/`)) {
      errors.push({
        level: 'envelope',
        path: '.apiVersion',
        message: `apiVersion must be ${DASHBOARD_API_GROUP}/<version> (got ${JSON.stringify(record.apiVersion)})`,
      });
    }
    if (record.kind !== 'Dashboard') {
      errors.push({ level: 'envelope', path: '.kind', message: 'kind must be "Dashboard"' });
    }
    if (!isRecord(record.metadata) || typeof record.metadata.name !== 'string' || !record.metadata.name) {
      errors.push({
        level: 'envelope',
        path: '.metadata.name',
        message: 'metadata.name (the dashboard UID) is required',
      });
    } else if (options.expectedUid && record.metadata.name !== options.expectedUid) {
      errors.push({
        level: 'envelope',
        path: '.metadata.name',
        message: `metadata.name ${JSON.stringify(record.metadata.name)} must match the directory UID ${JSON.stringify(options.expectedUid)}; create a new directory to copy a dashboard`,
      });
    }
    if (isRecord(record.metadata) && record.metadata.resourceVersion !== undefined) {
      warnings.push({
        level: 'envelope',
        path: '.metadata.resourceVersion',
        message: 'resourceVersion is provider-owned and ignored; the workspace applies against the fetched revision',
      });
    }
    if (!isRecord(record.spec)) {
      errors.push({ level: 'envelope', path: '.spec', message: 'spec must be an object' });
    }
  }
  levels.envelope = errors.length > envelopeErrors ? 'failed' : 'passed';
  if (!record || !isRecord(record.spec)) {
    return finish(dashboardFormat(resource));
  }

  const format = dashboardFormat(resource);
  const structureErrors = errors.length;
  if (format === 'v2') {
    validateV2Structure(record.spec, errors, warnings);
  } else {
    validateV1Structure(record.spec, errors, warnings);
  }
  levels.structure = errors.length > structureErrors ? 'failed' : 'passed';
  warnings.push(...layoutAndDisplayWarnings(resource));

  const inspection = inspectDashboard(resource);
  const queryErrors = errors.length;
  let promql;
  try {
    promql = await checkDashboardPromql(resource, options.promql ?? lezerParser, options.signal);
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    warnings.push({
      level: 'queries',
      message: `${error instanceof Error ? error.message : String(error)}; checked with the less strict offline parser`,
    });
    promql = await checkDashboardPromql(resource, lezerParser);
  }
  promqlParser = promql.parser;
  for (const diagnostic of promql.errors) {
    errors.push({
      level: 'queries',
      path: `panel ${diagnostic.panel} ${JSON.stringify(diagnostic.title)} query ${diagnostic.refId || '?'}`,
      message: `PromQL: ${diagnostic.message}: ${diagnostic.expr}`,
    });
  }
  for (const skipped of promql.skipped) {
    warnings.push({
      level: 'queries',
      path: `panel ${skipped.panel} ${JSON.stringify(skipped.title)} query ${skipped.refId || '?'}`,
      message: `not checked: ${skipped.reason}`,
    });
  }
  levels.queries =
    promql.checked + promql.errors.length === 0 ? 'skipped' : errors.length > queryErrors ? 'failed' : 'passed';

  const policyErrors = errors.length;
  if (options.managedBy) {
    errors.push({ level: 'policy', message: `dashboard is managed by ${options.managedBy} and is read-only here` });
  }
  if (options.allowedDatasourceUids && options.allowedDatasourceUids.length > 0) {
    const allowed = new Set(options.allowedDatasourceUids);
    for (const uid of inspection.datasourceUids) {
      if (!allowed.has(uid) && !BUILTIN_DATASOURCE_UIDS.has(uid)) {
        errors.push({
          level: 'policy',
          message: `datasource UID ${JSON.stringify(uid)} is not allowed for the assistant`,
        });
      }
    }
  }
  levels.policy = errors.length > policyErrors ? 'failed' : 'passed';
  return finish(format);
}

/** Checks Grafana does not do: overlapping grid items (it rearranges them) and percent units at the wrong scale. */
function layoutAndDisplayWarnings(resource: unknown): ValidationDiagnostic[] {
  let panels: WalkedPanel[];
  try {
    const [shape, dashboard] = unwrapDashboard(resource);
    panels = collectPanels(shape, dashboard, { includeCollapsed: true });
  } catch {
    return [];
  }
  const warnings: ValidationDiagnostic[] = [];
  const label = (panel: WalkedPanel) => `panel ${panel.id} ${JSON.stringify(panel.title)}`;
  const grids = new Map<string, WalkedPanel[]>();
  for (const panel of panels) {
    if (!panel.gridPos) {
      continue;
    }
    // Classic expanded rows share one grid; collapsed rows and v2 rows or tabs have their own.
    const grid = panel.source === 'v2' ? panel.rowPath.join('\u0000') : panel.collapsed ? `row:${panel.row}` : '';
    grids.set(grid, [...(grids.get(grid) ?? []), panel]);
  }
  const box = (panel: WalkedPanel) => {
    const grid = panel.gridPos as Record<string, unknown>;
    const value = (key: string) => (typeof grid[key] === 'number' ? (grid[key] as number) : 0);
    return { x: value('x'), y: value('y'), w: value('w'), h: value('h') };
  };
  for (const members of grids.values()) {
    members.forEach((panel, index) => {
      const a = box(panel);
      for (const other of members.slice(index + 1)) {
        const b = box(other);
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
          warnings.push({
            level: 'structure',
            message: `${label(panel)} overlaps ${label(other)}; Grafana moves one of them. Fix the gridPos values (grafana-dashboard set-panel moves panels out of the way).`,
          });
        }
      }
    });
  }
  for (const panel of panels) {
    const unit = isRecord(panel.fieldConfig.defaults) ? panel.fieldConfig.defaults.unit : undefined;
    if (unit !== 'percent' && unit !== 'percentunit') {
      continue;
    }
    for (const target of panel.targets) {
      const expr = typeof target.expr === 'string' ? target.expr : '';
      const scaled = /(^|[^\w.])100(\.0*)?\s*\*|\*\s*100(\.0*)?(?![\w.])/.test(expr);
      const message =
        unit === 'percentunit' && scaled
          ? 'unit percentunit expects 0-1, but the expression is multiplied by 100; use unit percent or drop the factor'
          : unit === 'percent' && !scaled && /\)\s*\/\s*\(?\s*(sum|count|avg)\b/.test(expr)
            ? 'unit percent expects 0-100, but the expression looks like a 0-1 ratio; use unit percentunit or multiply by 100'
            : undefined;
      if (message) {
        warnings.push({ level: 'queries', path: `${label(panel)} query ${String(target.refId ?? '?')}`, message });
      }
    }
  }
  return warnings;
}

const BUILTIN_DATASOURCE_UIDS = new Set([
  'grafana',
  '-- Grafana --',
  '-- Mixed --',
  '-- Dashboard --',
  'expr',
  '__expr__',
]);

function validateV1Structure(spec: AnyRecord, errors: ValidationDiagnostic[], warnings: ValidationDiagnostic[]) {
  if (typeof spec.title !== 'string' || !spec.title.trim()) {
    errors.push({ level: 'structure', path: '.spec.title', message: 'title is required' });
  }
  if (spec.panels !== undefined && !Array.isArray(spec.panels)) {
    errors.push({ level: 'structure', path: '.spec.panels', message: 'panels must be an array' });
    return;
  }
  const ids = new Map<number, string>();
  const visit = (panels: unknown[], prefix: string) => {
    panels.forEach((panel, index) => {
      const path = `${prefix}[${index}]`;
      if (!isRecord(panel)) {
        errors.push({ level: 'structure', path, message: 'panel must be an object' });
        return;
      }
      if (typeof panel.type !== 'string' || !panel.type) {
        errors.push({ level: 'structure', path: `${path}.type`, message: 'panel type is required' });
      }
      if (typeof panel.id !== 'number' || !Number.isInteger(panel.id)) {
        errors.push({ level: 'structure', path: `${path}.id`, message: 'panel id must be an integer' });
      } else if (ids.has(panel.id)) {
        errors.push({
          level: 'structure',
          path: `${path}.id`,
          message: `duplicate panel id ${panel.id} (also used at ${ids.get(panel.id)})`,
        });
      } else {
        ids.set(panel.id, path);
      }
      const grid = panel.gridPos;
      if (!isRecord(grid)) {
        errors.push({ level: 'structure', path: `${path}.gridPos`, message: 'gridPos {x,y,w,h} is required' });
      } else {
        for (const key of ['x', 'y', 'w', 'h']) {
          if (typeof grid[key] !== 'number' || grid[key] < 0) {
            errors.push({
              level: 'structure',
              path: `${path}.gridPos.${key}`,
              message: `${key} must be a non-negative number`,
            });
          }
        }
        if (typeof grid.x === 'number' && typeof grid.w === 'number' && grid.x + grid.w > 24) {
          errors.push({
            level: 'structure',
            path: `${path}.gridPos`,
            message: 'x + w must not exceed 24 grid columns',
          });
        }
        if (panel.type !== 'row' && (grid.w === 0 || grid.h === 0)) {
          warnings.push({ level: 'structure', path: `${path}.gridPos`, message: 'panel has zero width or height' });
        }
      }
      if (panel.type !== 'row' && !String(panel.title ?? '').trim()) {
        warnings.push({ level: 'structure', path: `${path}.title`, message: 'panel has no title' });
      }
      if (Array.isArray(panel.panels)) {
        visit(panel.panels, `${path}.panels`);
      }
    });
  };
  visit(Array.isArray(spec.panels) ? spec.panels : [], '.spec.panels');

  const variableNames = new Set<string>();
  const list = Array.isArray(spec.templating?.list) ? spec.templating.list : [];
  list.forEach((variable: unknown, index: number) => {
    const name = isRecord(variable) ? variable.name : undefined;
    if (typeof name !== 'string' || !name) {
      errors.push({
        level: 'structure',
        path: `.spec.templating.list[${index}].name`,
        message: 'variable name is required',
      });
    } else if (variableNames.has(name)) {
      errors.push({
        level: 'structure',
        path: `.spec.templating.list[${index}].name`,
        message: `duplicate variable ${name}`,
      });
    } else {
      variableNames.add(name);
    }
  });
}

function validateV2Structure(spec: AnyRecord, errors: ValidationDiagnostic[], warnings: ValidationDiagnostic[]) {
  if (typeof spec.title !== 'string' || !spec.title.trim()) {
    errors.push({ level: 'structure', path: '.spec.title', message: 'title is required' });
  }
  const elements = isRecord(spec.elements) ? spec.elements : undefined;
  if (!elements) {
    errors.push({
      level: 'structure',
      path: '.spec.elements',
      message: 'elements must be an object keyed by element name',
    });
    return;
  }
  for (const [key, element] of Object.entries(elements)) {
    if (!isRecord(element) || typeof element.kind !== 'string') {
      errors.push({ level: 'structure', path: `.spec.elements.${key}`, message: 'element must have a kind' });
    }
  }
  validateV2Variables(spec.variables, errors);
  const referenced = new Set<string>();
  collectElementReferences(spec.layout, referenced);
  for (const name of referenced) {
    if (!(name in elements)) {
      errors.push({
        level: 'structure',
        path: '.spec.layout',
        message: `layout references missing element ${JSON.stringify(name)}`,
      });
    }
  }
  for (const key of Object.keys(elements)) {
    if (!referenced.has(key)) {
      warnings.push({
        level: 'structure',
        path: `.spec.elements.${key}`,
        message: 'element is not placed in the layout',
      });
    }
  }
}

const V2_VARIABLE_KINDS = [
  'QueryVariable',
  'TextVariable',
  'ConstantVariable',
  'DatasourceVariable',
  'IntervalVariable',
  'CustomVariable',
  'GroupByVariable',
  'AdhocVariable',
  'SwitchVariable',
];

/** Checks the v2 variable shape Grafana's schema rejects most often: kind, spec.name, and the query envelope. */
function validateV2Variables(variables: unknown, errors: ValidationDiagnostic[]) {
  if (variables === undefined) {
    return;
  }
  if (!Array.isArray(variables)) {
    errors.push({ level: 'structure', path: '.spec.variables', message: 'variables must be an array' });
    return;
  }
  const names = new Set<string>();
  variables.forEach((variable, index) => {
    const path = `.spec.variables[${index}]`;
    if (!isRecord(variable) || !V2_VARIABLE_KINDS.includes(variable.kind)) {
      errors.push({
        level: 'structure',
        path: `${path}.kind`,
        message: `kind must be one of ${V2_VARIABLE_KINDS.join(', ')} (v2 variables are {kind, spec: {name, ...}}, not classic templating entries)`,
      });
      return;
    }
    const name = isRecord(variable.spec) ? variable.spec.name : undefined;
    if (typeof name !== 'string' || !name) {
      errors.push({ level: 'structure', path: `${path}.spec.name`, message: 'variable name is required' });
    } else if (names.has(name)) {
      errors.push({ level: 'structure', path: `${path}.spec.name`, message: `duplicate variable ${name}` });
    } else {
      names.add(name);
    }
    if (
      variable.kind === 'QueryVariable' &&
      (!isRecord(variable.spec?.query) || variable.spec.query.kind !== 'DataQuery')
    ) {
      errors.push({
        level: 'structure',
        path: `${path}.spec.query`,
        message:
          'query must be {kind: "DataQuery", group: "prometheus", datasource: {name: UID}, spec: {query: "label_values(...)"}}; `grafana-dashboard label-filter --variable-query` writes one',
      });
    }
  });
}

function collectElementReferences(node: unknown, names: Set<string>) {
  if (Array.isArray(node)) {
    node.forEach((child) => collectElementReferences(child, names));
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  if (node.kind === 'ElementReference' && typeof node.name === 'string') {
    names.add(node.name);
  }
  for (const value of Object.values(node)) {
    collectElementReferences(value, names);
  }
}

function walkPanels(resource: unknown): DashboardPanelInfo[] {
  let walked;
  try {
    const [shape, dashboard] = unwrapDashboard(resource);
    walked = collectPanels(shape, dashboard, { includeCollapsed: true, includeHiddenTargets: true });
  } catch {
    return [];
  }
  return walked.map(panelInfo);
}

const QUERY_TEXT_KEYS = ['query', 'rawSql', 'rawQuery', 'luceneQuery', 'target', 'expression'];
const MAX_TEXT = 400;

function panelInfo(panel: WalkedPanel): DashboardPanelInfo {
  const raw: AnyRecord = panel.raw;
  const panelDatasource = datasourceRef(panel.datasource);
  const transformations = panel.transformations.map(transformationId).filter(Boolean);
  const links = (Array.isArray(raw.links) ? raw.links : [])
    .filter(isRecord)
    .map((link: AnyRecord) => [stringOrUndefined(link.title), stringOrUndefined(link.url)].filter(Boolean).join(' -> '))
    .filter(Boolean)
    .slice(0, 8);
  return compact({
    key: panel.key,
    id: /^\d+$/.test(panel.id) ? Number(panel.id) : undefined,
    title: panel.title,
    type: panel.type,
    rowPath: panel.rowPath,
    collapsed: panel.collapsed,
    gridPos: panel.gridPos,
    description: shortText(raw.description),
    libraryPanel: panel.libraryPanel,
    repeat: stringOrUndefined(raw.repeat) ?? stringOrUndefined(raw.repeatOptions?.value),
    datasourceUid: panelDatasource.uid,
    queries: panel.targets.map((target: AnyRecord) => {
      const targetDatasource = datasourceRef(target.datasource);
      const expr = stringOrUndefined(target.expr);
      const queryKey = expr ? undefined : QUERY_TEXT_KEYS.find((key) => typeof target[key] === 'string' && target[key]);
      const builder = expr || queryKey ? undefined : describeBuilderQuery(target, targetDatasource.type);
      return compact({
        refId: stringOrUndefined(target.refId),
        datasourceUid: targetDatasource.uid,
        datasourceType: targetDatasource.type,
        expr,
        query: queryKey ? shortText(target[queryKey]) : builder,
        builder: builder ? true : undefined,
        legendFormat: stringOrUndefined(target.legendFormat),
        hidden: target.hide === true ? true : undefined,
      });
    }),
    transformations: transformations.length ? transformations : undefined,
    display: panelDisplay(panel),
    links: links.length ? links : undefined,
  });
}

function panelDisplay(panel: WalkedPanel) {
  const defaults: AnyRecord = isRecord(panel.fieldConfig.defaults) ? panel.fieldConfig.defaults : {};
  const options: AnyRecord = panel.options;
  const steps = Array.isArray(defaults.thresholds?.steps) ? defaults.thresholds.steps.filter(isRecord) : [];
  const overrides = Array.isArray(panel.fieldConfig.overrides) ? panel.fieldConfig.overrides.length : 0;
  const mappings = Array.isArray(defaults.mappings) ? defaults.mappings.length : 0;
  const legendCalcs = Array.isArray(options.legend?.calcs) ? options.legend.calcs : [];
  const reduceCalcs = Array.isArray(options.reduceOptions?.calcs) ? options.reduceOptions.calcs : [];
  const display = compact({
    unit: stringOrUndefined(defaults.unit),
    decimals: typeof defaults.decimals === 'number' ? defaults.decimals : undefined,
    min: typeof defaults.min === 'number' ? defaults.min : undefined,
    max: typeof defaults.max === 'number' ? defaults.max : undefined,
    thresholds: steps.length
      ? steps.slice(0, 8).map((step: AnyRecord) => `${step.value ?? 'base'}:${step.color ?? '?'}`)
      : undefined,
    thresholdsMode: steps.length ? stringOrUndefined(defaults.thresholds?.mode) : undefined,
    mappings: mappings || undefined,
    overrides: overrides || undefined,
    legendCalcs: legendCalcs.length ? legendCalcs : undefined,
    reduceCalcs: reduceCalcs.length ? reduceCalcs : undefined,
  });
  return Object.keys(display).length ? display : undefined;
}

function dashboardVariables(list: unknown): DashboardVariableInfo[] {
  return (Array.isArray(list) ? list : []).filter(isRecord).map((variable: AnyRecord) => {
    const spec: AnyRecord = isRecord(variable.spec) ? variable.spec : variable;
    const query = spec.query;
    const current = spec.current?.value ?? spec.current?.text;
    const options = (Array.isArray(spec.options) ? spec.options : [])
      .filter(isRecord)
      .map((option: AnyRecord) => String(option.value ?? option.text ?? ''))
      .filter(Boolean);
    return compact({
      name: String(spec.name ?? ''),
      type: stringOrUndefined(isRecord(variable.spec) ? variable.kind : variable.type),
      label: stringOrUndefined(spec.label),
      datasourceUid: datasourceRef(spec.datasource).uid,
      query:
        typeof query === 'string'
          ? shortText(query)
          : shortText(query?.query ?? query?.spec?.expr ?? query?.spec?.query ?? query?.expr),
      current: Array.isArray(current)
        ? current.map(String)
        : current != null && current !== ''
          ? String(current)
          : undefined,
      multi: spec.multi === true ? true : undefined,
      includeAll: spec.includeAll === true ? true : undefined,
      options: options.length ? options.slice(0, 20) : undefined,
    });
  });
}

function shortText(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  return !text ? undefined : text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text;
}

function datasourceRef(value: unknown): { uid?: string; type?: string } {
  if (typeof value === 'string') {
    return { uid: value };
  }
  if (isRecord(value)) {
    return { uid: stringOrUndefined(value.uid) ?? stringOrUndefined(value.name), type: stringOrUndefined(value.type) };
  }
  return {};
}

function compact<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

function stringOrUndefined(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export type DashboardFixReport = {
  changed: boolean;
  fixes: string[];
};

type GridRect = { x: number; y: number; w: number; h: number };

/**
 * Explicit layout repair for classic (v1) dashboard specs: assigns missing or
 * duplicate panel IDs, completes and clamps gridPos, and moves overlapping
 * panels to the next free slot. Mutates `resource`; the caller writes it back
 * so the repair appears in `workspace diff`. Ported from the former implicit
 * save-time normalization.
 */
export function fixDashboardLayout(resource: unknown): DashboardFixReport {
  const record = isRecord(resource) ? resource : {};
  const spec: AnyRecord = isRecord(record.spec) ? record.spec : record;
  const fixes: string[] = [];
  if (dashboardFormat(resource) === 'v2') {
    return { changed: false, fixes: ['v2 dashboards use structural layouts; nothing to fix'] };
  }
  const panels = (Array.isArray(spec.panels) ? spec.panels : []).filter(isRecord) as AnyRecord[];
  const label = (panel: AnyRecord) => `panel ${JSON.stringify(String(panel.title ?? ''))}`;

  const seen = new Set<number>();
  let nextId = 1;
  for (const panel of panels) {
    if (Number.isInteger(panel.id) && panel.id >= nextId) {
      nextId = panel.id + 1;
    }
  }
  for (const panel of panels) {
    if (Number.isInteger(panel.id) && panel.id > 0 && !seen.has(panel.id)) {
      seen.add(panel.id);
      continue;
    }
    while (seen.has(nextId)) {
      nextId++;
    }
    fixes.push(`${label(panel)}: assigned id ${nextId}`);
    panel.id = nextId;
    seen.add(nextId++);
  }

  const occupied: GridRect[] = [];
  let nextY = 0;
  for (const panel of panels) {
    const height = defaultPanelHeight(String(panel.type ?? ''));
    const grid = isRecord(panel.gridPos) ? panel.gridPos : undefined;
    const complete = grid && ['x', 'y', 'w', 'h'].every((key) => Number.isInteger(grid[key]));
    let rect: GridRect = complete
      ? { x: grid!.x, y: grid!.y, w: grid!.w, h: grid!.h }
      : { x: 0, y: nextY, w: 24, h: height };
    if (!complete) {
      fixes.push(`${label(panel)}: assigned missing gridPos`);
    }
    const clamped = clampRect(rect, height);
    if (clamped.x !== rect.x || clamped.y !== rect.y || clamped.w !== rect.w || clamped.h !== rect.h) {
      fixes.push(`${label(panel)}: clamped gridPos to the 24-column grid`);
      rect = clamped;
    }
    if (occupied.some((other) => collides(rect, other))) {
      rect = firstFreeRect(rect.w, rect.h, nextY, occupied);
      fixes.push(`${label(panel)}: moved overlapping panel to y=${rect.y}`);
    }
    panel.gridPos = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    occupied.push(rect);
    nextY = Math.max(nextY, rect.y + rect.h);
  }
  return { changed: fixes.length > 0, fixes };
}

function defaultPanelHeight(type: string) {
  switch (type) {
    case 'row':
      return 1;
    case 'stat':
    case 'gauge':
    case 'bargauge':
    case 'barGauge':
      return 4;
    case 'text':
      return 5;
    default:
      return 8;
  }
}

function clampRect(rect: GridRect, defaultHeight: number): GridRect {
  let { x, y, w, h } = rect;
  w = w <= 0 || w > 24 ? 24 : w;
  h = h <= 0 ? defaultHeight : h;
  x = x < 0 || x > 23 ? 0 : x;
  y = Math.max(0, y);
  if (x + w > 24) {
    x = Math.max(0, 24 - w);
  }
  return { x, y, w, h };
}

function collides(a: GridRect, b: GridRect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function firstFreeRect(width: number, height: number, startY: number, occupied: GridRect[]): GridRect {
  for (let y = Math.max(0, startY); y < startY + 10000; y++) {
    for (let x = 0; x <= 24 - width; x++) {
      const rect = { x, y, w: width, h: height };
      if (!occupied.some((other) => collides(rect, other))) {
        return rect;
      }
    }
  }
  return { x: 0, y: Math.max(0, startY), w: width, h: height };
}
