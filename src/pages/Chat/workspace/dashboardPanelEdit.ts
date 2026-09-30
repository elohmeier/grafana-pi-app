/**
 * Typed panel edits on a dashboard document (classic JSON, v1 resources with a
 * classic spec, v2 resources or specs), used by `grafana-dashboard add-panel`
 * and `set-panel`. The model states intent (title, queries, unit, position);
 * these functions produce the schema-correct JSON for either format.
 */

import { deepClone } from './dashboardPanels';

type AnyRecord = Record<string, any>;

export type PanelQueryInput = { refId: string; expr: string; legendFormat?: string };

export type PanelPosition = { x?: number; y?: number; w?: number; h?: number };

export type AddPanelOptions = PanelPosition & {
  title: string;
  queries: PanelQueryInput[];
  type?: string;
  unit?: string;
  description?: string;
  /** Prometheus datasource UID; default: the first Prometheus datasource the dashboard uses. */
  datasourceUid?: string;
  /** Place to the right of this panel (same row and height), or below it when it does not fit. */
  rightOf?: string;
  /** Place directly below this panel. */
  below?: string;
  /** Row or tab title to add the panel to (default: the last row or tab). */
  row?: string;
  /** Place at the top of the row or grid (x=0 unless given), pushing the panels there down. */
  top?: boolean;
  /** Copy visualization type, options, field config, and query datasource from this panel. */
  like?: string;
};

export type SetPanelOptions = PanelPosition & {
  panel: string;
  title?: string;
  description?: string;
  type?: string;
  unit?: string;
  /** Queries to set by refId; an unknown refId adds a query. */
  queries?: PanelQueryInput[];
  /** The refIds were assigned by position (A, B, ...), not given explicitly. */
  refIdsImplicit?: boolean;
  /** Prometheus datasource UID for the set queries; converts non-Prometheus queries. */
  datasourceUid?: string;
};

export type PanelEditReport = {
  format: 'classic' | 'v2';
  panel: string;
  title?: string;
  position?: { x: number; y: number; w: number; h: number };
  changed: string[];
  /** Panels pushed down to make room, by id (classic) or element name (v2). */
  moved?: string[];
  note?: string;
};

type GridItem = { x: number; y: number; w: number; h: number };

const GRID_COLUMNS = 24;
const DEFAULT_WIDTH = 12;
const DEFAULT_HEIGHT = 8;

export function addPanel(document: AnyRecord, options: AddPanelOptions): PanelEditReport {
  if (!options.title.trim()) {
    throw new Error('--title is required');
  }
  if (options.queries.length === 0) {
    throw new Error('at least one --expr is required');
  }
  const spec = specOf(document);
  return isV2(spec) ? addV2Panel(spec, options) : addClassicPanel(spec, options);
}

export function setPanel(document: AnyRecord, options: SetPanelOptions): PanelEditReport {
  const spec = specOf(document);
  return isV2(spec) ? setV2Panel(spec, options) : setClassicPanel(spec, options);
}

// Classic -----------------------------------------------------------------

function addClassicPanel(spec: AnyRecord, options: AddPanelOptions): PanelEditReport {
  spec.panels = Array.isArray(spec.panels) ? spec.panels : [];
  const all = classicPanels(spec.panels);
  const id = Math.max(0, ...all.map((panel) => (typeof panel.id === 'number' ? panel.id : 0))) + 1;
  const reference = referencePanelKey(options);
  const referencePanel = reference ? all.find((panel) => String(panel.id) === reference) : undefined;
  if (options.like && !referencePanel) {
    throw new Error(`no panel with id ${JSON.stringify(options.like)} to copy with --like`);
  }
  const datasourceUid =
    options.datasourceUid ??
    (referencePanel ? classicPrometheusUid([referencePanel]) : undefined) ??
    classicPrometheusUid(all);
  let container: AnyRecord[] = spec.panels;
  let siblings = spec.panels.filter((panel: AnyRecord) => panel?.type !== 'row');
  if (options.row) {
    const row = spec.panels.find((panel: AnyRecord) => panel?.type === 'row' && panel.title === options.row);
    if (!row) {
      throw new Error(`no row titled ${JSON.stringify(options.row)}`);
    }
    if (row.collapsed) {
      row.panels = Array.isArray(row.panels) ? row.panels : [];
      container = row.panels;
      siblings = row.panels;
    } else {
      siblings = classicRowSection(spec.panels, row);
    }
  }
  const { position, note } = place(
    options,
    siblings.map((panel: AnyRecord) => ({ key: String(panel.id), ...classicGrid(panel) })),
    options.row ? classicRowFloor(spec.panels, options.row) : 0
  );
  const like = options.like ? referencePanel : undefined;
  const panel = {
    id,
    type: options.type ?? (like && typeof like.type === 'string' ? like.type : 'timeseries'),
    title: options.title,
    ...(options.description ? { description: options.description } : {}),
    ...(datasourceUid ? { datasource: { type: 'prometheus', uid: datasourceUid } } : {}),
    gridPos: { x: position.x, y: position.y, w: position.w, h: position.h },
    fieldConfig: withUnit(like?.fieldConfig, options.unit),
    options: isRecord(like?.options) ? deepClone(like.options) : {},
    targets: options.queries.map((query) => classicTarget(query, datasourceUid)),
  };
  // Grafana compacts overlapping panels unpredictably; move the ones in the way down instead.
  const moved = makeRoom(
    container.filter(isRecord).map((item: AnyRecord) => ({
      key: String(item.id),
      ...classicGrid(item),
      move: (y: number) => (item.gridPos = { ...item.gridPos, y }),
    })),
    position
  );
  if (container === spec.panels) {
    insertInGridOrder(spec.panels, panel);
  } else {
    container.push(panel);
  }
  return {
    format: 'classic',
    panel: String(id),
    title: options.title,
    position,
    changed: ['added'],
    ...(moved.length ? { moved } : {}),
    ...(note ? { note } : {}),
  };
}

function setClassicPanel(spec: AnyRecord, options: SetPanelOptions): PanelEditReport {
  const panel = classicPanels(Array.isArray(spec.panels) ? spec.panels : []).find(
    (candidate) => String(candidate.id) === options.panel
  );
  if (!panel) {
    throw new Error(`no panel with id ${JSON.stringify(options.panel)}`);
  }
  const changed: string[] = [];
  if (options.title !== undefined) {
    panel.title = options.title;
    changed.push('title');
  }
  if (options.description !== undefined) {
    panel.description = options.description;
    changed.push('description');
  }
  if (options.type !== undefined) {
    panel.type = options.type;
    changed.push('type');
  }
  if (options.unit !== undefined) {
    panel.fieldConfig = isRecord(panel.fieldConfig) ? panel.fieldConfig : { defaults: {}, overrides: [] };
    panel.fieldConfig.defaults = isRecord(panel.fieldConfig.defaults) ? panel.fieldConfig.defaults : {};
    panel.fieldConfig.defaults.unit = options.unit;
    changed.push('unit');
  }
  if (options.queries?.length) {
    panel.targets = Array.isArray(panel.targets) ? panel.targets : [];
    checkImplicitRefIds(
      options,
      panel.targets.map((target: AnyRecord, index: number) => target?.refId ?? String.fromCharCode(65 + index))
    );
    const inherited = isRecord(panel.datasource) ? { ...panel.datasource } : undefined;
    const datasourceUid =
      options.datasourceUid ?? classicPrometheusUid([panel]) ?? classicPrometheusUid(classicPanels(spec.panels));
    for (const query of options.queries) {
      const index = panel.targets.findIndex((candidate: AnyRecord) => (candidate?.refId ?? 'A') === query.refId);
      const target = panel.targets[index];
      const type = target ? classicDatasourceType(target.datasource ?? panel.datasource) : 'prometheus';
      if (target && type !== 'prometheus') {
        // A PromQL expression next to builder fields of another datasource is a broken query; rebuild it.
        panel.targets[index] = {
          ...classicTarget(query, requirePrometheusUid(options.datasourceUid, query.refId, type)),
          ...(target.hide !== undefined ? { hide: target.hide } : {}),
        };
      } else if (target) {
        target.expr = query.expr;
        if (query.legendFormat !== undefined) {
          target.legendFormat = query.legendFormat;
        }
        if (options.datasourceUid) {
          target.datasource = { type: 'prometheus', uid: options.datasourceUid };
        }
      } else {
        panel.targets.push(classicTarget(query, datasourceUid));
      }
      changed.push(`query ${query.refId}`);
    }
    // The panel datasource must match its queries, or Grafana runs them against the old one.
    const effective = panel.targets.map((target: AnyRecord) => target?.datasource ?? inherited);
    const uids = new Set(effective.map((datasource: AnyRecord) => datasource?.uid));
    const types = new Set(effective.map(classicDatasourceType));
    if (types.size > 1) {
      panel.targets.forEach((target: AnyRecord) => (target.datasource ??= inherited));
      panel.datasource = { type: 'datasource', uid: '-- Mixed --' };
    } else if (types.has('prometheus') && uids.size === 1 && typeof [...uids][0] === 'string') {
      panel.datasource = { type: 'prometheus', uid: [...uids][0] };
    }
  }
  let position: GridItem | undefined;
  let moved: string[] = [];
  if (hasPosition(options)) {
    const current = classicGrid(panel);
    position = {
      x: options.x ?? current.x,
      y: options.y ?? current.y,
      w: options.w ?? current.w,
      h: options.h ?? current.h,
    };
    checkBounds(position);
    panel.gridPos = { ...panel.gridPos, ...position };
    changed.push('position');
    const panels: AnyRecord[] = spec.panels;
    const container = panels.includes(panel)
      ? panels
      : (panels.find((row) => Array.isArray(row?.panels) && row.panels.includes(panel))?.panels ?? []);
    moved = makeRoom(
      container
        .filter((item: AnyRecord) => isRecord(item) && item !== panel)
        .map((item: AnyRecord) => ({
          key: String(item.id),
          ...classicGrid(item),
          move: (y: number) => (item.gridPos = { ...item.gridPos, y }),
        })),
      position
    );
    if (container === panels) {
      panels.splice(panels.indexOf(panel), 1);
      insertInGridOrder(panels, panel);
    }
  }
  return {
    format: 'classic',
    panel: options.panel,
    title: panel.title,
    ...(position ? { position } : {}),
    changed,
    ...(moved.length ? { moved } : {}),
  };
}

/** Expanded rows own the panels that follow them, so top-level panels go in grid order to stay in their row. */
function insertInGridOrder(panels: AnyRecord[], panel: AnyRecord) {
  const position = classicGrid(panel);
  const index = panels.findIndex((item) => {
    if (!isRecord(item)) {
      return false;
    }
    const grid = classicGrid(item);
    return grid.y > position.y || (grid.y === position.y && grid.x > position.x);
  });
  panels.splice(index < 0 ? panels.length : index, 0, panel);
}

function classicPanels(panels: AnyRecord[]): AnyRecord[] {
  return panels.flatMap((panel) =>
    !isRecord(panel) ? [] : [panel, ...(Array.isArray(panel.panels) ? classicPanels(panel.panels) : [])]
  );
}

function classicGrid(panel: AnyRecord): GridItem {
  const grid = isRecord(panel.gridPos) ? panel.gridPos : {};
  return { x: num(grid.x, 0), y: num(grid.y, 0), w: num(grid.w, DEFAULT_WIDTH), h: num(grid.h, DEFAULT_HEIGHT) };
}

/** Panels below a non-collapsed row up to the next row. */
function classicRowSection(panels: AnyRecord[], row: AnyRecord | undefined): AnyRecord[] {
  const start = row ? panels.indexOf(row) : -1;
  if (start < 0) {
    return [];
  }
  const section: AnyRecord[] = [];
  for (const panel of panels.slice(start + 1)) {
    if (panel?.type === 'row') {
      break;
    }
    section.push(panel);
  }
  return section;
}

function classicRowFloor(panels: AnyRecord[], title: string) {
  const row = panels.find((panel) => panel?.type === 'row' && panel.title === title);
  return row ? classicGrid(row).y + 1 : 0;
}

function classicPrometheusUid(panels: AnyRecord[]): string | undefined {
  for (const panel of panels) {
    for (const source of [
      panel.datasource,
      ...(Array.isArray(panel.targets) ? panel.targets.map((t: AnyRecord) => t?.datasource) : []),
    ]) {
      if (
        isRecord(source) &&
        typeof source.uid === 'string' &&
        (source.type === undefined || source.type === 'prometheus')
      ) {
        return source.uid;
      }
    }
  }
  return undefined;
}

function classicDatasourceType(datasource: unknown): string {
  // A missing type (or a bare UID string) is treated as Prometheus, as in the rest of the dashboard checks.
  return isRecord(datasource) && typeof datasource.type === 'string' ? datasource.type : 'prometheus';
}

function requirePrometheusUid(datasourceUid: string | undefined, refId: string, type: string): string {
  if (!datasourceUid) {
    throw new Error(
      `query ${refId} uses ${type}; pass --ds with a Prometheus datasource UID to replace it with a PromQL query`
    );
  }
  return datasourceUid;
}

/** Positional refIds only make sense when they cover every query; otherwise `--expr X` meant for B overwrites A. */
function checkImplicitRefIds(options: SetPanelOptions, existing: string[]) {
  if (options.refIdsImplicit && existing.length > (options.queries?.length ?? 0)) {
    throw new Error(
      `the panel has queries ${existing.join(', ')}; pass --ref for each --expr to say which query it replaces`
    );
  }
}

function classicTarget(query: PanelQueryInput, datasourceUid: string | undefined) {
  return {
    refId: query.refId,
    expr: query.expr,
    ...(query.legendFormat !== undefined ? { legendFormat: query.legendFormat } : {}),
    ...(datasourceUid ? { datasource: { type: 'prometheus', uid: datasourceUid } } : {}),
  };
}

// v2 ----------------------------------------------------------------------

type V2Grid = { kind: 'GridLayout' | 'AutoGridLayout'; node: AnyRecord };

function addV2Panel(spec: AnyRecord, options: AddPanelOptions): PanelEditReport {
  const elements: AnyRecord = spec.elements;
  const ids = Object.values(elements).map((element: any) =>
    typeof element?.spec?.id === 'number' ? element.spec.id : 0
  );
  const id = Math.max(0, ...ids) + 1;
  let name = `panel-${id}`;
  for (let suffix = 2; name in elements; suffix++) {
    name = `panel-${id}-${suffix}`;
  }
  const anchor = options.rightOf ?? options.below;
  const grid = anchor
    ? (findV2GridOf(spec.layout, anchor) ?? targetV2Grid(spec, options.row))
    : targetV2Grid(spec, options.row);
  const reference = referencePanelKey(options);
  const referenceName = reference ? v2ElementName(elements, reference) : undefined;
  if (options.like && !referenceName) {
    throw new Error(`no panel ${JSON.stringify(options.like)} to copy with --like`);
  }
  const referenceQuery = referenceName
    ? elements[referenceName]?.spec?.data?.spec?.queries?.find(
        (query: AnyRecord) => query?.spec?.query?.group === 'prometheus'
      )?.spec?.query
    : undefined;
  // A reference query without a datasource uses the default datasource; keep it that way.
  const datasourceUid =
    options.datasourceUid ??
    (referenceQuery ? referenceQuery.datasource?.name : undefined) ??
    (referenceQuery ? undefined : v2PrometheusUid(elements));
  const like = options.like && referenceName ? elements[referenceName]?.spec?.vizConfig : undefined;
  const likeSpec = isRecord(like?.spec) ? like.spec : {};
  elements[name] = {
    kind: 'Panel',
    spec: {
      id,
      title: options.title,
      description: options.description ?? '',
      links: [],
      data: {
        kind: 'QueryGroup',
        spec: {
          queries: options.queries.map((query) => v2PanelQuery(query, datasourceUid)),
          transformations: [],
          queryOptions: {},
        },
      },
      vizConfig: {
        kind: 'VizConfig',
        group: options.type ?? (typeof like?.group === 'string' ? like.group : 'timeseries'),
        version: typeof like?.version === 'string' ? like.version : '',
        spec: {
          options: isRecord(likeSpec.options) ? deepClone(likeSpec.options) : {},
          fieldConfig: withUnit(likeSpec.fieldConfig, options.unit),
        },
      },
    },
  };
  const elementReference = { kind: 'ElementReference', name };
  if (grid.kind === 'AutoGridLayout') {
    grid.node.spec.items.push({ kind: 'AutoGridLayoutItem', spec: { element: elementReference } });
    return { format: 'v2', panel: name, title: options.title, changed: ['added'] };
  }
  const items: AnyRecord[] = grid.node.spec.items;
  const { position, note } = place(
    options,
    items.map((item) => ({ key: item.spec?.element?.name, ...v2Grid(item) })),
    0
  );
  const moved = makeRoom(
    items.filter(isRecord).map((item) => ({
      key: String(item.spec?.element?.name),
      ...v2Grid(item),
      move: (y: number) => (item.spec.y = y),
    })),
    position
  );
  items.push({
    kind: 'GridLayoutItem',
    spec: { x: position.x, y: position.y, width: position.w, height: position.h, element: elementReference },
  });
  return {
    format: 'v2',
    panel: name,
    title: options.title,
    position,
    changed: ['added'],
    ...(moved.length ? { moved } : {}),
    ...(note ? { note } : {}),
  };
}

function setV2Panel(spec: AnyRecord, options: SetPanelOptions): PanelEditReport {
  const elements: AnyRecord = spec.elements;
  const name =
    options.panel in elements
      ? options.panel
      : Object.keys(elements).find((key) => String(elements[key]?.spec?.id) === options.panel);
  const element = name ? elements[name] : undefined;
  if (!name || element?.kind !== 'Panel') {
    throw new Error(`no panel ${JSON.stringify(options.panel)}; available: ${Object.keys(elements).join(', ')}`);
  }
  const panel = element.spec;
  const changed: string[] = [];
  if (options.title !== undefined) {
    panel.title = options.title;
    changed.push('title');
  }
  if (options.description !== undefined) {
    panel.description = options.description;
    changed.push('description');
  }
  if (options.type !== undefined || options.unit !== undefined) {
    panel.vizConfig = isRecord(panel.vizConfig)
      ? panel.vizConfig
      : { kind: 'VizConfig', group: 'timeseries', version: '', spec: {} };
    if (options.type !== undefined) {
      panel.vizConfig.group = options.type;
      changed.push('type');
    }
    if (options.unit !== undefined) {
      const vizSpec = (panel.vizConfig.spec = isRecord(panel.vizConfig.spec) ? panel.vizConfig.spec : {});
      vizSpec.fieldConfig = isRecord(vizSpec.fieldConfig) ? vizSpec.fieldConfig : { defaults: {}, overrides: [] };
      vizSpec.fieldConfig.defaults = isRecord(vizSpec.fieldConfig.defaults) ? vizSpec.fieldConfig.defaults : {};
      vizSpec.fieldConfig.defaults.unit = options.unit;
      changed.push('unit');
    }
  }
  if (options.queries?.length) {
    panel.data = isRecord(panel.data)
      ? panel.data
      : { kind: 'QueryGroup', spec: { transformations: [], queryOptions: {} } };
    panel.data.spec.queries = Array.isArray(panel.data.spec.queries) ? panel.data.spec.queries : [];
    const queries: AnyRecord[] = panel.data.spec.queries;
    checkImplicitRefIds(
      options,
      queries.map((query, index) => query?.spec?.refId ?? String.fromCharCode(65 + index))
    );
    const datasourceUid = options.datasourceUid ?? v2PrometheusUid({ [name]: element }) ?? v2PrometheusUid(elements);
    for (const query of options.queries) {
      const index = queries.findIndex((candidate) => (candidate?.spec?.refId ?? 'A') === query.refId);
      const existing = queries[index];
      const group = existing?.spec?.query?.group;
      if (existing && typeof group === 'string' && group !== 'prometheus') {
        const rebuilt = v2PanelQuery(query, requirePrometheusUid(options.datasourceUid, query.refId, group));
        rebuilt.spec.hidden = existing.spec.hidden === true;
        queries[index] = rebuilt;
      } else if (existing && isRecord(existing.spec?.query?.spec)) {
        existing.spec.query.spec.expr = query.expr;
        if (query.legendFormat !== undefined) {
          existing.spec.query.spec.legendFormat = query.legendFormat;
        }
        if (options.datasourceUid) {
          existing.spec.query.datasource = { name: options.datasourceUid };
        }
      } else {
        queries.push(v2PanelQuery(query, datasourceUid));
      }
      changed.push(`query ${query.refId}`);
    }
  }
  let position: GridItem | undefined;
  let moved: string[] = [];
  if (hasPosition(options)) {
    const item = findV2Item(spec.layout, name);
    if (!item) {
      throw new Error(`panel ${name} is not in a grid layout; positions apply to GridLayout items only`);
    }
    const current = v2Grid(item);
    position = {
      x: options.x ?? current.x,
      y: options.y ?? current.y,
      w: options.w ?? current.w,
      h: options.h ?? current.h,
    };
    checkBounds(position);
    Object.assign(item.spec, { x: position.x, y: position.y, width: position.w, height: position.h });
    changed.push('position');
    const items: AnyRecord[] = findV2GridOf(spec.layout, name)?.node.spec.items ?? [];
    moved = makeRoom(
      items
        .filter((entry) => isRecord(entry) && entry !== item)
        .map((entry) => ({
          key: String(entry.spec?.element?.name),
          ...v2Grid(entry),
          move: (y: number) => (entry.spec.y = y),
        })),
      position
    );
  }
  return {
    format: 'v2',
    panel: name,
    title: panel.title,
    ...(position ? { position } : {}),
    changed,
    ...(moved.length ? { moved } : {}),
  };
}

function v2PanelQuery(query: PanelQueryInput, datasourceUid: string | undefined) {
  return {
    kind: 'PanelQuery',
    spec: {
      query: {
        kind: 'DataQuery',
        group: 'prometheus',
        version: 'v0',
        ...(datasourceUid ? { datasource: { name: datasourceUid } } : {}),
        spec: { expr: query.expr, ...(query.legendFormat !== undefined ? { legendFormat: query.legendFormat } : {}) },
      },
      refId: query.refId,
      hidden: false,
    },
  };
}

function v2Grid(item: AnyRecord): GridItem {
  const spec = isRecord(item.spec) ? item.spec : {};
  return {
    x: num(spec.x, 0),
    y: num(spec.y, 0),
    w: num(spec.width, DEFAULT_WIDTH),
    h: num(spec.height, DEFAULT_HEIGHT),
  };
}

function v2PrometheusUid(elements: AnyRecord): string | undefined {
  for (const element of Object.values(elements)) {
    for (const query of (element as AnyRecord)?.spec?.data?.spec?.queries ?? []) {
      const dataQuery = query?.spec?.query;
      if (dataQuery?.group === 'prometheus' && typeof dataQuery.datasource?.name === 'string') {
        return dataQuery.datasource.name;
      }
    }
  }
  return undefined;
}

/** The grid a new panel goes into: the root grid, or the selected (default: last) row or tab. */
function targetV2Grid(spec: AnyRecord, row: string | undefined): V2Grid {
  spec.layout = isRecord(spec.layout) ? spec.layout : { kind: 'GridLayout', spec: { items: [] } };
  let node: AnyRecord = spec.layout;
  for (let depth = 0; depth < 10; depth++) {
    if (node.kind === 'GridLayout' || node.kind === 'AutoGridLayout') {
      node.spec = isRecord(node.spec) ? node.spec : {};
      node.spec.items = Array.isArray(node.spec.items) ? node.spec.items : [];
      return { kind: node.kind, node };
    }
    const children: AnyRecord[] =
      node.kind === 'RowsLayout' ? (node.spec?.rows ?? []) : node.kind === 'TabsLayout' ? (node.spec?.tabs ?? []) : [];
    if (children.length === 0) {
      throw new Error(`cannot add a panel to layout kind ${JSON.stringify(node.kind)}`);
    }
    const selected = row ? children.find((child) => child?.spec?.title === row) : children[children.length - 1];
    if (!selected) {
      throw new Error(`no row or tab titled ${JSON.stringify(row)}`);
    }
    selected.spec.layout = isRecord(selected.spec.layout)
      ? selected.spec.layout
      : { kind: 'GridLayout', spec: { items: [] } };
    node = selected.spec.layout;
  }
  throw new Error('layout is nested too deeply');
}

function findV2GridOf(node: unknown, name: string): V2Grid | undefined {
  if (!isRecord(node)) {
    return undefined;
  }
  if ((node.kind === 'GridLayout' || node.kind === 'AutoGridLayout') && Array.isArray(node.spec?.items)) {
    return node.spec.items.some((item: AnyRecord) => item?.spec?.element?.name === name)
      ? { kind: node.kind, node }
      : undefined;
  }
  for (const child of [...(node.spec?.rows ?? []), ...(node.spec?.tabs ?? [])]) {
    const found = findV2GridOf(child?.spec?.layout, name);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findV2Item(node: unknown, name: string): AnyRecord | undefined {
  const grid = findV2GridOf(node, name);
  return grid?.kind === 'GridLayout'
    ? grid.node.spec.items.find((item: AnyRecord) => item?.spec?.element?.name === name)
    : undefined;
}

// Placement ----------------------------------------------------------------

/**
 * Position for a new panel: explicit coordinates, the top of the grid, next to/below an anchor, or the
 * bottom of the grid. Panels in the way are moved down afterwards (makeRoom).
 */
function place(
  options: AddPanelOptions,
  items: Array<GridItem & { key: string }>,
  floor: number
): { position: GridItem; note?: string } {
  const w = options.w ?? DEFAULT_WIDTH;
  const h = options.h ?? DEFAULT_HEIGHT;
  const bottom = Math.max(floor, ...items.map((item) => item.y + item.h));
  let position: GridItem = { x: options.x ?? 0, y: options.y ?? (options.top ? floor : bottom), w, h };
  let note: string | undefined;
  const anchorKey = options.rightOf ?? options.below;
  if (anchorKey && options.x === undefined && options.y === undefined && !options.top) {
    const anchor = items.find((item) => item.key === anchorKey || item.key === `panel-${anchorKey}`);
    if (!anchor) {
      throw new Error(`no panel ${JSON.stringify(anchorKey)} in the target grid`);
    }
    if (options.rightOf && anchor.x + anchor.w + w <= GRID_COLUMNS) {
      position = { x: anchor.x + anchor.w, y: anchor.y, w, h: options.h ?? anchor.h };
    } else {
      position = { x: anchor.x, y: anchor.y + anchor.h, w, h };
      if (options.rightOf) {
        note = `no room to the right of ${anchorKey} (x=${anchor.x}, w=${anchor.w}); placed below it. To place it beside, narrow ${anchorKey} first (set-panel --w ${GRID_COLUMNS - w}).`;
      }
    }
  }
  checkBounds(position);
  return { position, ...(note ? { note } : {}) };
}

type MovableItem = GridItem & { key: string; move: (y: number) => void };

/**
 * Moves grid items down so none overlaps the new position, cascading like Grafana's grid does.
 * Only items displaced by the new panel or by a moved item move; returns their keys.
 */
function makeRoom(items: MovableItem[], position: GridItem): string[] {
  const overlaps = (a: GridItem, b: GridItem) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const displaced: GridItem[] = [position];
  const moved: string[] = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let y = item.y;
    for (let blocker = displaced.find((rect) => overlaps(rect, { ...item, y })); blocker; ) {
      y = blocker.y + blocker.h;
      blocker = displaced.find((rect) => overlaps(rect, { ...item, y }));
    }
    if (y !== item.y) {
      item.move(y);
      moved.push(item.key);
      displaced.push({ ...item, y });
    }
  }
  return moved;
}

function referencePanelKey(options: AddPanelOptions) {
  return options.like ?? options.rightOf ?? options.below;
}

function v2ElementName(elements: AnyRecord, key: string): string | undefined {
  return key in elements
    ? key
    : Object.keys(elements).find((name) => String(elements[name]?.spec?.id) === key || name === `panel-${key}`);
}

function withUnit(fieldConfig: unknown, unit: string | undefined): AnyRecord {
  const copy: AnyRecord = isRecord(fieldConfig) ? deepClone(fieldConfig) : {};
  copy.defaults = isRecord(copy.defaults) ? copy.defaults : {};
  copy.overrides = Array.isArray(copy.overrides) ? copy.overrides : [];
  if (unit) {
    copy.defaults.unit = unit;
  }
  return copy;
}

function checkBounds(position: GridItem) {
  if (position.x < 0 || position.w < 1 || position.x + position.w > GRID_COLUMNS || position.y < 0 || position.h < 1) {
    throw new Error(`position x=${position.x} w=${position.w} does not fit the ${GRID_COLUMNS}-column grid`);
  }
}

function hasPosition(options: PanelPosition) {
  return [options.x, options.y, options.w, options.h].some((value) => value !== undefined);
}

// Helpers ------------------------------------------------------------------

function specOf(document: AnyRecord): AnyRecord {
  return isRecord(document.spec) ? document.spec : document;
}

function isV2(spec: AnyRecord) {
  return isRecord(spec.elements);
}

function num(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
