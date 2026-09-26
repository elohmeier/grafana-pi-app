import { escapeRegex } from '@grafana/data';

/**
 * One dashboard walker shared by inspection, validation, and data checks.
 * Handles classic JSON, v1 resources (classic spec), and v2 specs/resources,
 * including collapsed rows, hidden targets, expression dependencies, and saved
 * variable values. Ported from the grafana-inspect tool in the dotfiles repo.
 */

export type JsonObject = Record<string, unknown>;
export type DashboardShape = 'classic' | 'v2';

type VariableValue = string | string[];
type VariableFormatter = (value: VariableValue, variable: TemplateValue) => string;

export class DashboardWalkError extends Error {}

export class TemplateValue {
  constructor(
    readonly values: string[],
    readonly text: string | string[] = '',
    readonly multi = false,
    readonly includeAll = false,
    readonly isAll = false,
    readonly allValue?: string,
    readonly allValues: string[] = [],
    readonly arrayValue = false
  ) {}

  render(fmt?: string, defaultFormatter?: VariableFormatter): string {
    // Grafana passes custom All values through unescaped.
    if (this.isAll && this.allValue !== undefined && fmt !== 'text' && fmt !== 'percentencode') {
      return this.allValue;
    }
    const value = this.isAll
      ? this.allValues
      : this.arrayValue || this.values.length > 1
        ? this.values
        : (this.values[0] ?? '');
    if (!fmt && defaultFormatter) {
      return defaultFormatter(value, this);
    }
    return formatVariableValue(value, fmt, this.isAll ? 'All' : this.text);
  }

  display(): string {
    return this.render('raw');
  }
}

export function formatVariableValue(value: VariableValue, format?: string, text: string | string[] = value): string {
  const [name, ...args] = (format || 'glob').split(':');
  const values = Array.isArray(value) ? value : [value];
  switch (name) {
    case 'raw':
    case 'csv':
      return values.join(',');
    case 'text':
      return Array.isArray(text) ? text.join(' + ') : text;
    case 'regex': {
      const escaped = values.map(escapeRegex);
      return escaped.length > 1 ? `(${escaped.join('|')})` : escaped[0] || '';
    }
    case 'pipe':
      return values.join('|');
    case 'singlequote':
      return values.map((item) => `'${item.replaceAll("'", "\\'")}'`).join(',');
    case 'doublequote':
      return values.map((item) => `"${item.replaceAll('"', '\\"')}"`).join(',');
    case 'sqlstring':
      return values.map((item) => `'${item.replace(/['"]/g, (match) => (match === "'" ? "''" : '\\"'))}'`).join(',');
    case 'percentencode':
      return encodeStrict(encodeURIComponent, Array.isArray(value) ? `{${values.join(',')}}` : value);
    case 'uriencode':
      return encodeStrict(encodeURI, Array.isArray(value) ? `{${values.join(',')}}` : value);
    case 'json':
      return Array.isArray(value) ? JSON.stringify(value) : value;
    case 'join':
      return values.join(args[0] ?? ',');
    case 'glob':
    default:
      return values.length > 1 ? `{${values.join(',')}}` : values[0] || '';
  }
}

/** Mirrors the Prometheus datasource's default interpolation (interpolateQueryExpr). */
export function prometheusVariableFormatter(value: VariableValue, variable: TemplateValue): string {
  if (!variable.multi && !variable.includeAll) {
    const single = Array.isArray(value) ? value.join(',') : value;
    return single.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\\\'");
  }
  const escape = (item: string) => item.replace(/\\/g, '\\\\\\\\').replace(/[$^*{}\[\]'+?.()|]/g, '\\\\$&');
  const escaped = (Array.isArray(value) ? value : [value]).map(escape);
  return escaped.length === 1 ? escaped[0] : `(${escaped.join('|')})`;
}

export type WalkedPanel = {
  /** Stable key: `panel-<id>` for classic panels, the element name for v2. */
  key: string;
  id: string;
  title: string;
  type: string;
  /** Innermost row (classic) or row/tab (v2) title. */
  row?: string;
  /** Row and tab titles from the outermost layout level inward. */
  rowPath: string[];
  /** Inside a collapsed classic row. */
  collapsed?: boolean;
  /** Classic gridPos, or the v2 grid item position in the same {x,y,w,h} shape. */
  gridPos?: JsonObject;
  raw: JsonObject;
  datasource?: JsonObject;
  targets: JsonObject[];
  transformations: JsonObject[];
  fieldConfig: JsonObject;
  options: JsonObject;
  libraryPanel?: string;
  order: number;
  source: DashboardShape;
};

export type WalkOptions = { includeHiddenTargets?: boolean; includeCollapsed?: boolean };

/** Returns the dashboard body, accepting classic JSON, export wrappers, v1/v2 resources, and v2 specs. */
export function unwrapDashboard(payload: unknown): [DashboardShape, JsonObject] {
  if (!isObject(payload)) {
    throw new DashboardWalkError('dashboard JSON root must be an object');
  }
  if (isObject(payload.dashboard)) {
    return unwrapDashboard(payload.dashboard);
  }
  if (isObject(payload.spec)) {
    return isObject(payload.spec.elements) ? ['v2', payload.spec] : ['classic', payload.spec];
  }
  if (isObject(payload.elements)) {
    return ['v2', payload];
  }
  if (Array.isArray(payload.panels) || typeof payload.title === 'string') {
    return ['classic', payload];
  }
  throw new DashboardWalkError('input does not look like a classic dashboard, dashboard resource, or v2 spec');
}

export function collectVariables(shape: DashboardShape, dashboard: JsonObject): Record<string, TemplateValue> {
  const templating = isObject(dashboard.templating) ? dashboard.templating : {};
  const items = shape === 'classic' ? templating.list : dashboard.variables;
  const variables: Record<string, TemplateValue> = {};
  for (const item of Array.isArray(items) ? items : []) {
    if (!isObject(item)) {
      continue;
    }
    const spec = isObject(item.spec) ? item.spec : item;
    const name = asText(spec.name);
    if (name) {
      variables[name] = templateValue(spec);
    }
  }
  return variables;
}

/** Applies `NAME=VALUE` overrides; repeating a name selects several values. */
export function applyVariableOverrides(variables: Record<string, TemplateValue>, items: string[]) {
  const valuesByName = new Map<string, string[]>();
  for (const item of items) {
    const index = item.indexOf('=');
    if (index <= 0) {
      throw new DashboardWalkError(`--var expects NAME=VALUE, got ${JSON.stringify(item)}`);
    }
    const name = item.slice(0, index);
    valuesByName.set(name, [...(valuesByName.get(name) ?? []), item.slice(index + 1)]);
  }
  for (const [name, values] of valuesByName) {
    const existing = variables[name];
    const isAll = values.includes('$__all');
    if (isAll && values.length > 1) {
      throw new DashboardWalkError(`--var ${name} cannot combine $__all with selected values`);
    }
    variables[name] = new TemplateValue(
      values,
      isAll ? 'All' : values,
      existing?.multi ?? values.length > 1,
      existing?.includeAll ?? false,
      isAll,
      existing?.allValue,
      existing?.allValues ?? [],
      Boolean(existing?.multi) || values.length > 1
    );
  }
}

const VAR_RE =
  /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]+))?\}|([A-Za-z_][A-Za-z0-9_]*))|\[\[([A-Za-z_][A-Za-z0-9_]*)(?::([^\]]+))?\]\]/g;

export function replaceVariables(
  value: string,
  variables: Record<string, TemplateValue>,
  defaultFormatter?: VariableFormatter
): string {
  return value.replace(VAR_RE, (match, braced, fmt, named, legacy, legacyFmt) => {
    const variable = variables[braced || named || legacy];
    return variable ? variable.render(fmt || legacyFmt, defaultFormatter) : match;
  });
}

/** Names of `$var`, `${var}`, and `[[var]]` references left in a string. */
export function unresolvedVariables(value: string): string[] {
  return [...value.matchAll(VAR_RE)].map((match) => match[1] || match[3] || match[4]);
}

export function collectPanels(shape: DashboardShape, dashboard: JsonObject, options: WalkOptions = {}): WalkedPanel[] {
  return shape === 'classic'
    ? classicPanels(dashboard, options)
    : v2Panels(dashboard, Boolean(options.includeHiddenTargets));
}

export function dashboardTime(shape: DashboardShape, dashboard: JsonObject): [string, string] {
  const settings = shape === 'classic' ? dashboard.time : dashboard.timeSettings;
  const time = isObject(settings) ? settings : {};
  return [asText(time.from) || 'now-6h', asText(time.to) || 'now'];
}

export function datasourceType(target: JsonObject): string {
  return isObject(target.datasource) ? asText(target.datasource.type) : '';
}

export function datasourceUid(target: JsonObject): string {
  if (typeof target.datasource === 'string') {
    return target.datasource;
  }
  return isObject(target.datasource) ? asText(target.datasource.uid || target.datasource.name) : '';
}

/**
 * Interpolates variables into panel targets. Prometheus targets use the
 * Prometheus datasource escaping; datasource references are substituted raw.
 */
export function prepareTargets(panel: WalkedPanel, variables: Record<string, TemplateValue>): JsonObject[] {
  const data = isObject(panel.raw.data) ? panel.raw.data : {};
  const dataSpec = isObject(data.spec) ? data.spec : {};
  const queryOptions = panel.source === 'v2' && isObject(dataSpec.queryOptions) ? dataSpec.queryOptions : panel.raw;
  return panel.targets.map((original) => {
    const { datasource, ...rest } = original;
    const formatter =
      asText(isObject(datasource) ? datasource.type : '') === 'prometheus'
        ? prometheusVariableFormatter
        : legacyFormatter;
    const target = substituteVars(rest, variables, formatter) as JsonObject;
    if (datasource !== undefined) {
      target.datasource = substituteVars(datasource, variables);
    }
    if (queryOptions.maxDataPoints != null) {
      target.maxDataPoints ??= queryOptions.maxDataPoints;
    }
    if (queryOptions.interval && !target.interval) {
      target.interval = queryOptions.interval;
    }
    return target;
  });
}

function legacyFormatter(value: VariableValue, variable: TemplateValue): string {
  if (Array.isArray(value)) {
    return variable.multi && value.length > 1 ? value.map(escapeRegex).join('|') : value[0] || '';
  }
  return value;
}

function substituteVars(
  value: unknown,
  variables: Record<string, TemplateValue>,
  formatter?: VariableFormatter
): unknown {
  if (typeof value === 'string') {
    return replaceVariables(value, variables, formatter);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteVars(item, variables, formatter));
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, substituteVars(child, variables, formatter)])
    );
  }
  return value;
}

function templateValue(spec: JsonObject): TemplateValue {
  const current = isObject(spec.current) ? spec.current : {};
  const values = asValues(current.value);
  const text = Array.isArray(current.text) ? current.text.map(asText) : asText(current.text);
  const allValues = (Array.isArray(spec.options) ? spec.options : [])
    .filter(isObject)
    .map((option) => asText(option.value))
    .filter((value) => value !== '$__all');
  return new TemplateValue(
    values,
    text,
    Boolean(spec.multi),
    Boolean(spec.includeAll),
    values.includes('$__all'),
    asText(spec.allValue) || undefined,
    allValues,
    Array.isArray(current.value)
  );
}

function classicPanels(dashboard: JsonObject, options: WalkOptions): WalkedPanel[] {
  const panels: WalkedPanel[] = [];
  const push = (item: JsonObject, row: string | undefined, collapsed: boolean) => {
    const libraryPanel = isObject(item.libraryPanel) ? asText(item.libraryPanel.uid) : '';
    panels.push({
      key: `panel-${asText(item.id) || panels.length}`,
      id: asText(item.id),
      title: asText(item.title) || '(untitled)',
      type: asText(item.type) || (libraryPanel ? 'library-panel' : 'unknown'),
      row,
      rowPath: row ? [row] : [],
      ...(collapsed ? { collapsed } : {}),
      ...(isObject(item.gridPos) ? { gridPos: item.gridPos } : {}),
      raw: item,
      datasource: isObject(item.datasource) ? item.datasource : undefined,
      targets: classicTargets(item, Boolean(options.includeHiddenTargets)),
      transformations: Array.isArray(item.transformations) ? item.transformations.filter(isObject) : [],
      fieldConfig: isObject(item.fieldConfig) ? item.fieldConfig : {},
      options: isObject(item.options) ? item.options : {},
      ...(libraryPanel ? { libraryPanel } : {}),
      order: panels.length,
      source: 'classic',
    });
  };
  // Expanded rows own the panels that follow them; collapsed rows nest their panels.
  let currentRow: string | undefined;
  for (const item of Array.isArray(dashboard.panels) ? dashboard.panels : []) {
    if (!isObject(item)) {
      continue;
    }
    if (item.type !== 'row') {
      push(item, currentRow, false);
      continue;
    }
    currentRow = asText(item.title) || undefined;
    const collapsed = Boolean(item.collapsed);
    if (options.includeCollapsed || !collapsed) {
      for (const child of Array.isArray(item.panels) ? item.panels : []) {
        if (isObject(child) && child.type !== 'row') {
          push(child, currentRow, collapsed);
        }
      }
    }
  }
  return panels;
}

function classicTargets(panel: JsonObject, includeHidden: boolean): JsonObject[] {
  const targets = (Array.isArray(panel.targets) ? panel.targets : []).flatMap((target, index) => {
    if (!isObject(target)) {
      return [];
    }
    const item = deepClone(target);
    if (item.datasource === undefined && panel.datasource !== undefined) {
      item.datasource = deepClone(panel.datasource);
    }
    item.refId ??= refIdAt(index);
    return [item];
  });
  return filterHiddenTargets(targets, includeHidden);
}

function v2Panels(dashboard: JsonObject, includeHidden: boolean): WalkedPanel[] {
  const elements = isObject(dashboard.elements) ? dashboard.elements : {};
  const placements = v2LayoutPlacements(dashboard.layout);
  const panels: WalkedPanel[] = [];
  for (const [name, element] of Object.entries(elements)) {
    if (!isObject(element) || (element.kind !== 'Panel' && element.kind !== 'LibraryPanel')) {
      continue;
    }
    const spec = isObject(element.spec) ? element.spec : {};
    const vizConfig = isObject(spec.vizConfig) ? spec.vizConfig : {};
    const vizSpec = isObject(vizConfig.spec) ? vizConfig.spec : {};
    const data = isObject(spec.data) ? spec.data : {};
    const dataSpec = isObject(data.spec) ? data.spec : {};
    const libraryPanel =
      element.kind === 'LibraryPanel' && isObject(spec.libraryPanel) ? asText(spec.libraryPanel.uid) : '';
    const targets = (Array.isArray(dataSpec.queries) ? dataSpec.queries : []).flatMap((item, index) => {
      if (!isObject(item)) {
        return [];
      }
      const querySpec = isObject(item.spec) ? item.spec : {};
      const target = v2QueryToTarget(
        isObject(querySpec.query) ? querySpec.query : {},
        asText(querySpec.refId) || refIdAt(index)
      );
      if (querySpec.hidden) {
        target.hide = true;
      }
      return [target];
    });
    const placement = placements.get(name);
    const rowPath = placement?.rowPath ?? [];
    const datasources = new Set(targets.map((target) => JSON.stringify(target.datasource ?? null)));
    panels.push({
      key: name,
      id: asText(spec.id) || name,
      title: asText(spec.title) || '(untitled)',
      type: asText(vizConfig.group || vizConfig.kind) || (libraryPanel ? 'library-panel' : 'unknown'),
      row: rowPath[rowPath.length - 1],
      rowPath,
      ...(placement?.gridPos ? { gridPos: placement.gridPos } : {}),
      raw: spec,
      // v2 panels have no panel datasource; expose the shared query datasource like classic panels.
      datasource: datasources.size === 1 && isObject(targets[0]?.datasource) ? targets[0].datasource : undefined,
      targets: filterHiddenTargets(targets, includeHidden),
      transformations: Array.isArray(dataSpec.transformations) ? dataSpec.transformations.filter(isObject) : [],
      fieldConfig: isObject(vizSpec.fieldConfig) ? vizSpec.fieldConfig : {},
      options: isObject(vizSpec.options) ? vizSpec.options : {},
      ...(libraryPanel ? { libraryPanel } : {}),
      order: placement?.order ?? Number.MAX_SAFE_INTEGER,
      source: 'v2',
    });
  }
  return panels.sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
}

function v2QueryToTarget(query: JsonObject, refId: string): JsonObject {
  const target = deepClone(isObject(query.spec) ? query.spec : {});
  target.refId = refId;
  const datasource = isObject(query.datasource) ? query.datasource : {};
  const uid = asText(datasource.uid || datasource.name);
  const type = asText(datasource.type || query.group);
  if (uid || type) {
    target.datasource = { ...(uid ? { uid } : {}), ...(type ? { type } : {}) };
  }
  if (type === 'prometheus' || type === 'loki') {
    target.instant = Boolean(target.instant);
    target.range ??= !target.instant;
  }
  return target;
}

type V2Placement = { order: number; rowPath: string[]; gridPos?: JsonObject };

/** Layout order, row/tab path, and grid position of each referenced element. */
function v2LayoutPlacements(layout: unknown): Map<string, V2Placement> {
  const placements = new Map<string, V2Placement>();
  const walk = (node: unknown, rowPath: string[], gridPos: JsonObject | undefined): void => {
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child, rowPath, gridPos));
      return;
    }
    if (!isObject(node)) {
      return;
    }
    const spec = isObject(node.spec) ? node.spec : {};
    if (node.kind === 'ElementReference') {
      const name = asText(node.name);
      if (name && !placements.has(name)) {
        placements.set(name, { order: placements.size, rowPath, ...(gridPos ? { gridPos } : {}) });
      }
    }
    let childPath = rowPath;
    if ((node.kind === 'RowsLayoutRow' || node.kind === 'TabsLayoutTab') && asText(spec.title)) {
      childPath = [...rowPath, asText(spec.title)];
    }
    let childGrid = gridPos;
    if (node.kind === 'GridLayoutItem') {
      childGrid = Object.fromEntries(
        (
          [
            ['x', spec.x],
            ['y', spec.y],
            ['w', spec.width],
            ['h', spec.height],
          ] as const
        ).filter(([, value]) => typeof value === 'number')
      );
    }
    for (const key of ['items', 'children', 'rows', 'tabs']) {
      if (Array.isArray(node[key])) {
        walk(node[key], childPath, childGrid);
      }
    }
    for (const key of ['spec', 'element', 'layout']) {
      if (isObject(node[key])) {
        walk(node[key], childPath, childGrid);
      }
    }
  };
  walk(layout, [], undefined);
  return placements;
}

/** Hidden targets are dropped unless a visible server-side expression depends on them. */
function filterHiddenTargets(targets: JsonObject[], includeHidden: boolean): JsonObject[] {
  if (includeHidden) {
    return targets;
  }
  const required = new Set<string>();
  for (const target of targets) {
    if (!target.hide && datasourceType(target) === '__expr__') {
      for (const match of asText(target.expression).matchAll(/\$([A-Za-z][A-Za-z0-9_]*)/g)) {
        required.add(match[1]);
      }
    }
  }
  return targets.filter((target) => !target.hide || required.has(asText(target.refId)));
}

/** Transformation id for classic ({id}) and v2 ({kind, spec: {id}}) transformations. */
export function transformationId(transformation: JsonObject): string {
  const spec = isObject(transformation.spec) ? transformation.spec : {};
  return asText(transformation.id || spec.id || transformation.kind || transformation.group || spec.group);
}

/**
 * The panel as a classic panel object (v2 fields mapped to their classic names),
 * for readers that consume classic panel JSON. Targets keep the walker's
 * datasource inheritance and default refIds.
 */
export function classicPanelView(panel: WalkedPanel): JsonObject {
  const base = panel.source === 'classic' ? panel.raw : {};
  const raw = panel.raw;
  return {
    ...base,
    id: panel.source === 'classic' ? raw.id : typeof raw.id === 'number' ? raw.id : panel.id,
    title: panel.title,
    type: panel.type,
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(Array.isArray(raw.links) ? { links: raw.links } : {}),
    ...(panel.datasource ? { datasource: panel.datasource } : {}),
    ...(panel.gridPos ? { gridPos: panel.gridPos } : {}),
    fieldConfig: panel.fieldConfig,
    options: panel.options,
    targets: panel.targets,
    transformations: panel.transformations.map((transformation) =>
      panel.source === 'classic' ? transformation : { id: transformationId(transformation) }
    ),
  };
}

function refIdAt(index: number) {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

export function asText(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

function asValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asText);
  }
  return value == null ? [] : [asText(value)];
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function encodeStrict(encode: (value: string) => string, value: string) {
  return encode(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export type ClassicPanelWithPath = { panel: JsonObject; rowPath: string[]; gridPos?: JsonObject };

/**
 * Every panel of a dashboard (including collapsed rows and hidden targets) as
 * classic panel objects with their row path, for the typed dashboard tools.
 * Returns no panels for input that is not a dashboard.
 */
export function walkClassicPanels(payload: unknown): ClassicPanelWithPath[] {
  let shape: DashboardShape;
  let dashboard: JsonObject;
  try {
    [shape, dashboard] = unwrapDashboard(payload);
  } catch {
    return [];
  }
  return collectPanels(shape, dashboard, { includeCollapsed: true, includeHiddenTargets: true }).map((panel) => ({
    panel: classicPanelView(panel),
    rowPath: panel.rowPath,
    ...(panel.gridPos ? { gridPos: panel.gridPos } : {}),
  }));
}
