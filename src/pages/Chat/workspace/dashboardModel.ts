import { parser as promqlParser } from '@prometheus-io/lezer-promql';

export const DASHBOARD_API_GROUP = 'dashboard.grafana.app';

export type DashboardFormat = 'v1' | 'v2' | 'unknown';

export type DashboardQueryInfo = {
  refId?: string;
  datasourceUid?: string;
  datasourceType?: string;
  expr?: string;
  hidden?: boolean;
};

export type DashboardPanelInfo = {
  key: string;
  id?: number;
  title: string;
  type: string;
  row?: string;
  datasourceUid?: string;
  queries: DashboardQueryInfo[];
};

export type DashboardInspection = {
  schemaVersion: 1;
  uid?: string;
  apiVersion?: string;
  format: DashboardFormat;
  title?: string;
  tags: string[];
  folderUid?: string;
  panelCount: number;
  panels: DashboardPanelInfo[];
  variables: Array<{ name: string; type?: string; query?: string }>;
  datasourceUids: string[];
};

export type ValidationLevel = 'json' | 'envelope' | 'structure' | 'queries' | 'policy';

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
  const panels = format === 'v2' ? v2Panels(spec) : v1Panels(spec);
  const variables = format === 'v2' ? v2Variables(spec) : v1Variables(spec);
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
    panelCount: panels.length,
    panels,
    variables,
    datasourceUids: [...datasourceUids].filter((uid) => !uid.startsWith('$') && !uid.startsWith('-- ')).sort(),
  };
}

export function validateDashboardDocument(
  content: string,
  options: { expectedUid?: string; allowedDatasourceUids?: string[]; managedBy?: string } = {}
): DashboardValidationReport {
  const errors: ValidationDiagnostic[] = [];
  const warnings: ValidationDiagnostic[] = [];
  const levels: DashboardValidationReport['levels'] = {
    json: 'skipped',
    envelope: 'skipped',
    structure: 'skipped',
    queries: 'skipped',
    policy: 'skipped',
  };
  const notRun = [
    'version-specific Grafana schema (CUE) validation',
    'server dry-run',
    'runtime data checks (use grafana-prom query)',
    'rendering checks',
  ];
  const finish = (format: DashboardFormat): DashboardValidationReport => ({
    schemaVersion: 1,
    ok: errors.length === 0,
    format,
    levels,
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

  const inspection = inspectDashboard(resource);
  const queryErrors = errors.length;
  let promQueries = 0;
  for (const panel of inspection.panels) {
    for (const query of panel.queries) {
      if (!query.expr) {
        continue;
      }
      promQueries++;
      const syntaxError = promqlSyntaxError(query.expr);
      if (syntaxError) {
        errors.push({
          level: 'queries',
          path: `panel ${JSON.stringify(panel.title)} query ${query.refId ?? '?'}`,
          message: `PromQL syntax error ${syntaxError}: ${query.expr}`,
        });
      }
    }
  }
  levels.queries = promQueries === 0 ? 'skipped' : errors.length > queryErrors ? 'failed' : 'passed';

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

const BUILTIN_DATASOURCE_UIDS = new Set([
  'grafana',
  '-- Grafana --',
  '-- Mixed --',
  '-- Dashboard --',
  'expr',
  '__expr__',
]);

/** Returns a short location description for the first PromQL syntax error, or undefined. */
export function promqlSyntaxError(expr: string): string | undefined {
  const masked = maskGrafanaTemplateVariables(expr);
  const tree = promqlParser.parse(masked);
  let errorAt: number | undefined;
  tree.iterate({
    enter(node) {
      if (errorAt === undefined && node.type.isError) {
        errorAt = node.from;
      }
    },
  });
  return errorAt === undefined ? undefined : `near offset ${errorAt}`;
}

/** Replaces Grafana macros and template variables with syntactically neutral placeholders. */
export function maskGrafanaTemplateVariables(expr: string) {
  return expr
    .replace(/\$\{?__(rate_interval|interval|range|interval_ms|range_s|range_ms)(?::[^}]*)?\}?/g, (match) =>
      /ms|_s/.test(match) ? '1' : '5m'
    )
    .replace(
      /\$\{([A-Za-z0-9_]+)(?::[^}]*)?\}|\$([A-Za-z0-9_]+)|\[\[([A-Za-z0-9_]+)(?::[^\]]*)?\]\]/g,
      (_m, a, b, c) => {
        return `var_${a ?? b ?? c}`;
      }
    );
}

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

function v1Panels(spec: AnyRecord): DashboardPanelInfo[] {
  const panels: DashboardPanelInfo[] = [];
  const visit = (items: unknown[], row?: string) => {
    for (const panel of items) {
      if (!isRecord(panel)) {
        continue;
      }
      if (panel.type === 'row') {
        visit(Array.isArray(panel.panels) ? panel.panels : [], String(panel.title ?? ''));
        continue;
      }
      const panelDatasource = datasourceRef(panel.datasource);
      panels.push({
        key: `panel-${panel.id ?? panels.length}`,
        id: typeof panel.id === 'number' ? panel.id : undefined,
        title: String(panel.title ?? ''),
        type: String(panel.type ?? ''),
        row,
        datasourceUid: panelDatasource.uid,
        queries: (Array.isArray(panel.targets) ? panel.targets : []).filter(isRecord).map((target: AnyRecord) => {
          const targetDatasource = datasourceRef(target.datasource);
          return compact({
            refId: stringOrUndefined(target.refId),
            datasourceUid: targetDatasource.uid ?? panelDatasource.uid,
            datasourceType: targetDatasource.type ?? panelDatasource.type,
            expr: stringOrUndefined(target.expr),
            hidden: target.hide === true ? true : undefined,
          });
        }),
      });
    }
  };
  visit(Array.isArray(spec.panels) ? spec.panels : []);
  return panels;
}

function v2Panels(spec: AnyRecord): DashboardPanelInfo[] {
  const elements = isRecord(spec.elements) ? spec.elements : {};
  return Object.entries(elements)
    .filter(([, element]) => isRecord(element) && element.kind === 'Panel')
    .map(([key, element]: [string, AnyRecord]) => {
      const panel = element.spec ?? {};
      const queries = Array.isArray(panel.data?.spec?.queries) ? panel.data.spec.queries : [];
      return {
        key,
        id: typeof panel.id === 'number' ? panel.id : undefined,
        title: String(panel.title ?? ''),
        type: String(panel.vizConfig?.group ?? panel.vizConfig?.kind ?? ''),
        queries: queries.filter(isRecord).map((query: AnyRecord) => {
          const inner = query.spec?.query ?? {};
          return compact({
            refId: stringOrUndefined(query.spec?.refId),
            datasourceUid: stringOrUndefined(inner.datasource?.name),
            datasourceType: stringOrUndefined(inner.group),
            expr: stringOrUndefined(inner.spec?.expr),
            hidden: query.spec?.hidden === true ? true : undefined,
          });
        }),
      };
    });
}

function v1Variables(spec: AnyRecord) {
  const list = Array.isArray(spec.templating?.list) ? spec.templating.list : [];
  return list.filter(isRecord).map((variable: AnyRecord) =>
    compact({
      name: String(variable.name ?? ''),
      type: stringOrUndefined(variable.type),
      query: typeof variable.query === 'string' ? variable.query : stringOrUndefined(variable.query?.query),
    })
  );
}

function v2Variables(spec: AnyRecord) {
  const list = Array.isArray(spec.variables) ? spec.variables : [];
  return list.filter(isRecord).map((variable: AnyRecord) =>
    compact({
      name: String(variable.spec?.name ?? ''),
      type: stringOrUndefined(variable.kind),
      query:
        typeof variable.spec?.query === 'string'
          ? variable.spec.query
          : stringOrUndefined(variable.spec?.query?.spec?.expr),
    })
  );
}

function datasourceRef(value: unknown): { uid?: string; type?: string } {
  if (typeof value === 'string') {
    return { uid: value };
  }
  if (isRecord(value)) {
    return { uid: stringOrUndefined(value.uid), type: stringOrUndefined(value.type) };
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
