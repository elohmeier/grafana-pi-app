import { isObject, type JsonObject } from './dashboardPanels';

/** One query of a dashboard file, with the jq path that addresses its expression. */
export type DashboardQueryLocation = {
  /** Panel or variable. */
  kind: 'panel' | 'variable';
  /** Classic panel id, v2 element name, or variable name. */
  key: string;
  title: string;
  /** Row titles above a classic panel. */
  rowPath?: string[];
  refId?: string;
  datasource?: { uid?: string; type?: string };
  /** The query text: PromQL `expr`, or `query`/`rawSql`/... for other datasources. */
  expr: string;
  /** jq path of the query text, for example `.spec.panels[3].targets[0].expr`. */
  jqPath: string;
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
        return;
      }
      locations.push({
        kind: 'panel',
        key: String(item.id ?? ''),
        title: String(item.title ?? ''),
        ...(rowPath.length ? { rowPath } : {}),
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
      if (!querySpec || !query || !text || !field) {
        return;
      }
      locations.push({
        kind: 'panel',
        key: name,
        title: String((element.spec as JsonObject).title ?? ''),
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
