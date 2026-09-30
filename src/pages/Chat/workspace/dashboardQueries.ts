import { isObject, type JsonObject, v2LayoutPlacements } from './dashboardPanels';

/** One query of a dashboard file, with the jq path that addresses its expression. */
export type DashboardQueryLocation = {
  /** Panel or variable. */
  kind: 'panel' | 'variable';
  /** Classic panel id, v2 element name, or variable name. */
  key: string;
  title: string;
  /** Row and tab titles of the panel; empty outside rows and for variables. */
  rowPath?: string[];
  refId?: string;
  datasource?: { uid?: string; type?: string };
  /** The query text: PromQL `expr`, or `query`/`rawSql`/... for other datasources. */
  expr: string;
  /** jq path of the query text, for example `.spec.panels[3].targets[0].expr`. */
  jqPath: string;
  /** Built with a query builder: `expr` describes it, and `jqPath` addresses the whole target. */
  builder?: boolean;
  hidden?: boolean;
};

const QUERY_TEXT_FIELDS = ['expr', 'query', 'rawSql', 'rawQuery', 'queryText', 'target'];

/**
 * Every panel and variable query of a classic or v2 dashboard resource
 * (`{spec}`) with the jq path of its text, so a mass edit can change exactly the
 * matching queries: `jq '(PATH) |= sub("old"; "new")'`.
 */
export function listDashboardQueries(resource: unknown): DashboardQueryLocation[] {
  const spec = isObject(resource) && isObject(resource.spec) ? resource.spec : undefined;
  if (!spec) {
    return [];
  }
  return isObject(spec.elements) ? v2Queries(spec) : classicQueries(spec);
}

function classicQueries(spec: JsonObject): DashboardQueryLocation[] {
  const locations: DashboardQueryLocation[] = [];
  const panel = (item: JsonObject, path: string, rowPath: string[]) => {
    const panelDatasource = datasourceRef(item.datasource);
    (Array.isArray(item.targets) ? item.targets : []).forEach((target, index) => {
      if (!isObject(target)) {
        return;
      }
      const field = queryField(target);
      if (!field) {
        const described = describeBuilderQuery(target, datasourceRef(target.datasource)?.type ?? panelDatasource?.type);
        if (described) {
          locations.push({
            kind: 'panel',
            key: String(item.id ?? ''),
            title: String(item.title ?? ''),
            rowPath,
            refId: typeof target.refId === 'string' ? target.refId : undefined,
            datasource: datasourceRef(target.datasource) ?? panelDatasource,
            expr: described,
            jqPath: `${path}.targets[${index}]`,
            builder: true,
            ...(target.hide ? { hidden: true } : {}),
          });
        }
        return;
      }
      locations.push({
        kind: 'panel',
        key: String(item.id ?? ''),
        title: String(item.title ?? ''),
        rowPath,
        refId: typeof target.refId === 'string' ? target.refId : undefined,
        datasource: datasourceRef(target.datasource) ?? panelDatasource,
        expr: String(target[field]),
        jqPath: `${path}.targets[${index}].${field}`,
        ...(target.hide ? { hidden: true } : {}),
      });
    });
  };
  let row: string[] = [];
  (Array.isArray(spec.panels) ? spec.panels : []).forEach((item, index) => {
    if (!isObject(item)) {
      return;
    }
    const path = `.spec.panels[${index}]`;
    if (item.type !== 'row') {
      panel(item, path, row);
      return;
    }
    row = item.title ? [String(item.title)] : [];
    (Array.isArray(item.panels) ? item.panels : []).forEach((child, childIndex) => {
      if (isObject(child)) {
        panel(child, `${path}.panels[${childIndex}]`, row);
      }
    });
  });
  const variables = isObject(spec.templating) && Array.isArray(spec.templating.list) ? spec.templating.list : [];
  variables.forEach((variable, index) => {
    if (!isObject(variable) || variable.type !== 'query') {
      return;
    }
    let jqPath = `.spec.templating.list[${index}].query`;
    let text: string | undefined;
    if (typeof variable.query === 'string') {
      text = variable.query;
    } else if (isObject(variable.query)) {
      const field = queryField(variable.query);
      if (field) {
        text = String(variable.query[field]);
        jqPath = `${jqPath}.${field}`;
      }
    }
    if (text) {
      locations.push({
        kind: 'variable',
        key: String(variable.name ?? ''),
        title: String(variable.label ?? variable.name ?? ''),
        datasource: datasourceRef(variable.datasource),
        expr: text,
        jqPath,
      });
    }
  });
  return locations;
}

function v2Queries(spec: JsonObject): DashboardQueryLocation[] {
  const locations: DashboardQueryLocation[] = [];
  const placements = v2LayoutPlacements(spec.layout);
  for (const [name, element] of Object.entries(spec.elements as JsonObject)) {
    if (!isObject(element) || element.kind !== 'Panel' || !isObject(element.spec)) {
      continue;
    }
    const data = isObject(element.spec.data) && isObject(element.spec.data.spec) ? element.spec.data.spec : {};
    (Array.isArray(data.queries) ? data.queries : []).forEach((item, index) => {
      const querySpec = isObject(item) && isObject(item.spec) ? item.spec : undefined;
      const query = querySpec && isObject(querySpec.query) ? querySpec.query : undefined;
      const text = query && isObject(query.spec) ? query.spec : undefined;
      const field = text ? queryField(text) : undefined;
      const described = text && !field ? describeBuilderQuery(text, String(query?.group ?? '')) : undefined;
      if (querySpec && query && text && described) {
        locations.push({
          kind: 'panel',
          key: name,
          title: String((element.spec as JsonObject).title ?? ''),
          rowPath: placements.get(name)?.rowPath ?? [],
          refId: typeof querySpec.refId === 'string' ? querySpec.refId : undefined,
          datasource: v2Datasource(query),
          expr: described,
          jqPath: `.spec.elements[${JSON.stringify(name)}].spec.data.spec.queries[${index}].spec.query.spec`,
          builder: true,
          ...(querySpec.hidden ? { hidden: true } : {}),
        });
        return;
      }
      if (!querySpec || !query || !text || !field) {
        return;
      }
      locations.push({
        kind: 'panel',
        key: name,
        title: String((element.spec as JsonObject).title ?? ''),
        rowPath: placements.get(name)?.rowPath ?? [],
        refId: typeof querySpec.refId === 'string' ? querySpec.refId : undefined,
        datasource: v2Datasource(query),
        expr: String(text[field]),
        jqPath: `.spec.elements[${JSON.stringify(name)}].spec.data.spec.queries[${index}].spec.query.spec.${field}`,
        ...(querySpec.hidden ? { hidden: true } : {}),
      });
    });
  }
  (Array.isArray(spec.variables) ? spec.variables : []).forEach((variable, index) => {
    if (!isObject(variable) || variable.kind !== 'QueryVariable' || !isObject(variable.spec)) {
      return;
    }
    const query = isObject(variable.spec.query) ? variable.spec.query : undefined;
    const text = query && isObject(query.spec) ? query.spec : undefined;
    const field = text ? queryField(text) : undefined;
    if (query && text && field) {
      locations.push({
        kind: 'variable',
        key: String(variable.spec.name ?? ''),
        title: String(variable.spec.label ?? variable.spec.name ?? ''),
        datasource: v2Datasource(query),
        expr: String(text[field]),
        jqPath: `.spec.variables[${index}].spec.query.spec.${field}`,
      });
    }
  });
  return locations;
}

const TEXT_QUERY_DATASOURCES = new Set(['prometheus', 'loki', '__expr__', 'datasource']);

const QUERY_META_FIELDS = new Set([
  'refId',
  'datasource',
  'hide',
  'key',
  'interval',
  'intervalMs',
  'maxDataPoints',
  'queryType',
  'editorMode',
  'format',
  'resultFormat',
  'legendFormat',
  'alias',
  'rawQuery',
  'policy',
  'orderByTime',
]);

/**
 * A readable form of a query built with a query builder instead of text: InfluxQL for the InfluxDB
 * builder, otherwise the builder fields as JSON. Undefined when the target has no builder fields.
 */
export function describeBuilderQuery(target: JsonObject, datasourceType?: string): string | undefined {
  if (typeof target.measurement === 'string' && target.measurement) {
    return influxQl(target);
  }
  // Text-query datasources without text (a new, empty Prometheus query) have nothing to describe.
  const type = datasourceType ?? (isObject(target.datasource) ? String(target.datasource.type ?? '') : '');
  if (!type || TEXT_QUERY_DATASOURCES.has(type)) {
    return undefined;
  }
  const fields = Object.fromEntries(Object.entries(target).filter(([key]) => !QUERY_META_FIELDS.has(key)));
  return Object.keys(fields).length > 0 ? JSON.stringify(fields) : undefined;
}

function influxQl(target: JsonObject): string {
  const parts = (value: unknown) => (Array.isArray(value) ? value.filter(isObject) : []);
  const params = (part: JsonObject) => (Array.isArray(part.params) ? part.params.map(String) : []);
  const selects = (Array.isArray(target.select) ? target.select : []).map((select) => {
    let expression = '';
    let alias = '';
    for (const part of parts(select)) {
      const type = String(part.type);
      if (type === 'field') {
        expression = `"${params(part)[0] ?? ''}"`;
      } else if (type === 'math') {
        expression += ` ${params(part).join(' ').trim()}`;
      } else if (type === 'alias') {
        alias = ` AS "${params(part)[0] ?? ''}"`;
      } else {
        expression = `${type}(${[expression, ...params(part)].filter(Boolean).join(', ')})`;
      }
    }
    return `${expression}${alias}`;
  });
  const policy = typeof target.policy === 'string' && target.policy !== 'default' ? `"${target.policy}".` : '';
  const conditions = parts(target.tags).map((tag, index) => {
    const operator = String(tag.operator ?? '=');
    const value = String(tag.value ?? '');
    const quoted = operator.includes('~') || /^\/.*\/$/.test(value) ? value : `'${value}'`;
    const condition = index > 0 ? `${String(tag.condition ?? 'AND')} ` : '';
    return `${condition}"${String(tag.key)}" ${operator} ${quoted}`;
  });
  const groups = parts(target.groupBy).map((group) => {
    const type = String(group.type);
    return type === 'tag' ? `"${params(group)[0] ?? ''}"` : `${type}(${params(group).join(', ')})`;
  });
  return [
    `SELECT ${selects.join(', ') || '*'} FROM ${policy}"${String(target.measurement)}"`,
    conditions.length ? `WHERE ${conditions.join(' ')}` : '',
    groups.length ? `GROUP BY ${groups.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function queryField(target: JsonObject) {
  return QUERY_TEXT_FIELDS.find((field) => typeof target[field] === 'string' && target[field] !== '');
}

function datasourceRef(value: unknown): DashboardQueryLocation['datasource'] {
  if (typeof value === 'string' && value) {
    return { uid: value };
  }
  if (!isObject(value)) {
    return undefined;
  }
  const uid = typeof value.uid === 'string' ? value.uid : undefined;
  const type = typeof value.type === 'string' ? value.type : undefined;
  return uid || type ? { ...(uid ? { uid } : {}), ...(type ? { type } : {}) } : undefined;
}

function v2Datasource(query: JsonObject): DashboardQueryLocation['datasource'] {
  const ref = isObject(query.datasource) ? query.datasource : {};
  const uid = typeof ref.uid === 'string' ? ref.uid : typeof ref.name === 'string' ? ref.name : undefined;
  const type = typeof query.group === 'string' ? query.group : undefined;
  return uid || type ? { ...(uid ? { uid } : {}), ...(type ? { type } : {}) } : undefined;
}
