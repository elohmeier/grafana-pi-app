import type { PiAppLogDatasource } from '../../../types';

/**
 * Restricted Elasticsearch log access for `grafana-logs`.
 *
 * Text fields hold the sensitive log content; keyword, numeric, date, IP, and
 * boolean fields do not. The assistant gets the field structure, counts (with
 * free text search), and documents with their visible fields. Documents that
 * match an admin-defined keyword condition are returned completely.
 *
 * This module builds every Elasticsearch request itself from checked values,
 * so text fields of restricted documents are never requested. See
 * docs/restricted-logs.md.
 */

export type LogCondition = { field: string; values: string[] };

export type LogDatasource = {
  uid: string;
  name: string;
  indices: string[];
  timeField: string;
  unrestricted: LogCondition[];
};

export type FieldCapability = {
  type: string;
  searchable?: boolean;
  aggregatable?: boolean;
  metadata_field?: boolean;
};

export type FieldCapsResponse = {
  indices?: string[];
  fields?: Record<string, Record<string, FieldCapability>>;
};

export type LogField = {
  name: string;
  types: string[];
  searchable: boolean;
  aggregatable: boolean;
  /** Returned in documents and usable with `--by`. */
  visible: boolean;
};

export type ElasticsearchDatasourceSettings = {
  uid: string;
  name: string;
  type: string;
  jsonData?: Record<string, unknown>;
};

/** Calls Elasticsearch through the Grafana datasource as the current user. */
export type LogsTransport = {
  datasources: () => ElasticsearchDatasourceSettings[];
  fieldCaps: (datasourceUid: string, index: string, signal?: AbortSignal) => Promise<FieldCapsResponse>;
  /** One `_msearch` request; returns its `responses`. */
  msearch: (
    datasourceUid: string,
    searches: Array<{ index: string; body: Record<string, unknown> }>,
    signal?: AbortSignal
  ) => Promise<unknown[]>;
};

export type LogTarget = { datasource?: string; index?: string };

export type LogQueryParams = LogTarget & {
  from: string;
  to: string;
  /** Lucene query string; may search any field, including text. */
  query?: string;
};

export type LogCountParams = LogQueryParams & {
  /** Group by this visible, aggregatable field. */
  by?: string;
  top?: number;
  /** date_histogram fixed_interval such as 5m. */
  interval?: string;
};

export type LogSearchParams = LogQueryParams & { limit: number };

export type LogCoverage = {
  /** False when Elasticsearch reports the total as a lower bound. */
  exact: boolean;
  shards: { total: number; successful: number; failed: number };
  timedOut: boolean;
};

export type LogCountResult = LogCoverage & {
  datasourceUid: string;
  index: string;
  from: string;
  to: string;
  query?: string;
  total: number;
  interval?: string;
  by?: string;
  series?: Array<{ time: string; count: number }>;
  groups?: Array<{ key: string | number | boolean; count: number; series?: Array<{ time: string; count: number }> }>;
  /** Documents in groups beyond --top. */
  otherCount?: number;
  notices?: string[];
};

export type LogDocument = {
  index: string;
  id: string;
  /** True when only visible fields are included. */
  restricted: boolean;
  /** Fields by dotted name, such as `service.name`, for both kinds of documents. */
  fields: Record<string, unknown>;
};

export type LogSearchResult = {
  datasourceUid: string;
  index: string;
  from: string;
  to: string;
  query?: string;
  /** Matching documents: complete (unrestricted) and with visible fields only (restricted). */
  total: { unrestricted: number; restricted: number; exact: boolean };
  documents: LogDocument[];
  timedOut: boolean;
  shardFailures: number;
  notices?: string[];
};

export type LogsBroker = {
  datasources: () => LogDatasource[];
  fields: (
    target: LogTarget,
    signal?: AbortSignal
  ) => Promise<{ datasourceUid: string; index: string; fields: LogField[] }>;
  count: (params: LogCountParams, signal?: AbortSignal) => Promise<LogCountResult>;
  search: (params: LogSearchParams, signal?: AbortSignal) => Promise<LogSearchResult>;
};

const VISIBLE_TYPES = new Set([
  'keyword',
  'constant_keyword',
  'long',
  'integer',
  'short',
  'byte',
  'double',
  'float',
  'half_float',
  'scaled_float',
  'unsigned_long',
  'date',
  'date_nanos',
  'boolean',
  'ip',
]);
const CONTAINER_TYPES = new Set(['object', 'nested']);
const SEARCH_TIMEOUT = '30s';
const TIME_VALUE =
  /^(now([+-]\d+[smhdwMy])*(\/[smhdwMy])?|\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?|\d{10,13})$/;
const INTERVAL = /^[1-9]\d*(ms|s|m|h|d)$/;

export class LogPolicyError extends Error {}

/** Log datasources from the policy that exist as Elasticsearch datasources. */
export function logDatasources(
  policy: PiAppLogDatasource[] | undefined,
  available: ElasticsearchDatasourceSettings[]
): LogDatasource[] {
  const result: LogDatasource[] = [];
  for (const entry of policy ?? []) {
    const settings = available.find((ds) => ds.uid === entry.uid && ds.type === 'elasticsearch');
    if (!settings) {
      continue;
    }
    const configuredIndex = typeof settings.jsonData?.index === 'string' ? settings.jsonData.index.trim() : '';
    const indices = (entry.indices ?? []).map((index) => index.trim()).filter(Boolean);
    if (indices.length === 0 && configuredIndex && !configuredIndex.includes('[')) {
      indices.push(configuredIndex);
    }
    const timeField = typeof settings.jsonData?.timeField === 'string' ? settings.jsonData.timeField : '';
    result.push({
      uid: settings.uid,
      name: settings.name,
      indices,
      timeField: timeField || '@timestamp',
      unrestricted: (entry.unrestricted ?? [])
        .map((condition) => ({
          field: (condition.field ?? '').trim(),
          values: (condition.values ?? []).filter((value) => typeof value === 'string' && value !== ''),
        }))
        .filter((condition) => condition.field && condition.values.length > 0),
    });
  }
  return result;
}

/**
 * Visible fields: every type is non-text, and no parent path is a field of
 * another type. A keyword subfield of a text field (`message.keyword`) holds
 * the text, so it is hidden too.
 */
export function describeFields(caps: FieldCapsResponse): LogField[] {
  const fields = caps.fields ?? {};
  const types = (name: string) => Object.keys(fields[name] ?? {});
  const isVisible = (name: string) => {
    const own = types(name);
    if (name.startsWith('_') || own.length === 0 || !own.every((type) => VISIBLE_TYPES.has(type))) {
      return false;
    }
    const parts = name.split('.');
    for (let i = 1; i < parts.length; i++) {
      if (types(parts.slice(0, i).join('.')).some((type) => !CONTAINER_TYPES.has(type))) {
        return false;
      }
    }
    return true;
  };
  return Object.keys(fields)
    .filter((name) => !name.startsWith('_') && types(name).some((type) => !CONTAINER_TYPES.has(type)))
    .sort()
    .map((name) => {
      const capabilities = Object.values(fields[name]);
      return {
        name,
        types: types(name),
        searchable: capabilities.every((cap) => cap.searchable !== false),
        aggregatable: capabilities.every((cap) => cap.aggregatable === true),
        visible: isVisible(name),
      };
    });
}

export function createLogsBroker(policy: PiAppLogDatasource[] | undefined, transport: LogsTransport): LogsBroker {
  const datasources = () => logDatasources(policy, transport.datasources());

  const resolve = (target: LogTarget) => {
    const available = datasources();
    const datasource = target.datasource
      ? available.find((ds) => ds.uid === target.datasource || ds.name === target.datasource)
      : available[0];
    if (!datasource) {
      throw new LogPolicyError(
        target.datasource
          ? `datasource ${JSON.stringify(target.datasource)} is not a log datasource available to the assistant`
          : 'no log datasource is available to the assistant'
      );
    }
    return { datasource, index: resolveIndex(datasource, target.index) };
  };

  const fields = async (target: LogTarget, signal?: AbortSignal) => {
    const { datasource, index } = resolve(target);
    const caps = await transport.fieldCaps(datasource.uid, index, signal);
    return { datasource, index, fields: describeFields(caps) };
  };

  return {
    datasources,
    async fields(target, signal) {
      const result = await fields(target, signal);
      return { datasourceUid: result.datasource.uid, index: result.index, fields: result.fields };
    },
    async count(params, signal) {
      const { datasource, index } = resolve(params);
      const filter = queryFilter(datasource, params);
      const histogram = params.interval ? dateHistogram(datasource, params) : undefined;
      let aggs: Record<string, unknown> | undefined = histogram ? { time: histogram } : undefined;
      if (params.by) {
        const described = (await fields(params, signal)).fields;
        const field = described.find((candidate) => candidate.name === params.by);
        if (!field?.visible || !field.aggregatable) {
          throw new LogPolicyError(
            field
              ? `--by ${params.by}: only non-text, aggregatable fields can be grouped by (see \`grafana-logs fields\`)`
              : `--by ${params.by}: no such field in ${index}${fieldSuggestion(params.by, described)}`
          );
        }
        aggs = { groups: { terms: { field: params.by, size: params.top ?? 10 }, ...(aggs ? { aggs } : {}) } };
      }
      const [response] = await transport.msearch(
        datasource.uid,
        [
          {
            index,
            body: {
              size: 0,
              track_total_hits: true,
              timeout: SEARCH_TIMEOUT,
              query: { bool: { filter } },
              ...(aggs ? { aggs } : {}),
            },
          },
        ],
        signal
      );
      const decoded = decodeResponse(response);
      const notices = decoded.total === 0 ? queryFieldNotices(params.query, (await fields(params, signal)).fields) : [];
      return {
        datasourceUid: datasource.uid,
        index,
        from: params.from,
        to: params.to,
        ...(params.query ? { query: params.query } : {}),
        total: decoded.total,
        ...coverage(decoded),
        ...(params.interval ? { interval: params.interval } : {}),
        ...(params.by ? { by: params.by } : {}),
        ...decodeAggregations(decoded.aggregations),
        ...(notices.length ? { notices } : {}),
      };
    },
    async search(params, signal) {
      const { datasource, index, fields: described } = await fields(params, signal);
      const visible = described.filter((field) => field.visible).map((field) => field.name);
      const conditions = unrestrictedConditions(datasource, described);
      const filter = queryFilter(datasource, params);
      const sort = [{ [datasource.timeField]: { order: 'desc' } }];
      const searches: Array<{ index: string; body: Record<string, unknown> }> = [];
      if (conditions.length > 0) {
        searches.push({
          index,
          body: {
            size: params.limit,
            sort,
            track_total_hits: true,
            timeout: SEARCH_TIMEOUT,
            query: { bool: { filter: [...filter, { bool: { should: conditions, minimum_should_match: 1 } }] } },
          },
        });
      }
      searches.push({
        index,
        body: {
          size: params.limit,
          sort,
          track_total_hits: true,
          timeout: SEARCH_TIMEOUT,
          _source: false,
          fields: visible,
          query: { bool: { filter, ...(conditions.length > 0 ? { must_not: conditions } : {}) } },
        },
      });
      const responses = (await transport.msearch(datasource.uid, searches, signal)).map(decodeResponse);
      const unrestricted = conditions.length > 0 ? responses[0] : undefined;
      const restricted = responses[responses.length - 1];
      const visibleSet = new Set(visible);
      const documents = [
        ...(unrestricted?.hits ?? []).map((hit) => ({
          sort: hit.sort,
          document: { index: hit.index, id: hit.id, restricted: false, fields: flatten(hit.source ?? {}) },
        })),
        ...restricted.hits.map((hit) => ({
          sort: hit.sort,
          document: { index: hit.index, id: hit.id, restricted: true, fields: pickFields(hit.fields, visibleSet) },
        })),
      ]
        .sort((left, right) => compareSort(right.sort, left.sort))
        .slice(0, params.limit)
        .map((entry) => entry.document);
      const notices = documents.length === 0 ? queryFieldNotices(params.query, described) : [];
      return {
        datasourceUid: datasource.uid,
        index,
        from: params.from,
        to: params.to,
        ...(params.query ? { query: params.query } : {}),
        total: {
          unrestricted: unrestricted?.total ?? 0,
          restricted: restricted.total,
          exact: responses.every((response) => response.exact),
        },
        documents,
        timedOut: responses.some((response) => response.timedOut),
        shardFailures: responses.reduce((sum, response) => sum + response.shards.failed, 0),
        ...(notices.length ? { notices } : {}),
      };
    },
  };
}

function resolveIndex(datasource: LogDatasource, requested: string | undefined) {
  if (datasource.indices.length === 0) {
    throw new LogPolicyError(`no indices are configured for log datasource ${datasource.uid}`);
  }
  if (!requested) {
    // Every configured index; a field that is text in any of them stays hidden.
    return datasource.indices.join(',');
  }
  if (datasource.indices.includes(requested)) {
    return requested;
  }
  if (!/[*,:\s]/.test(requested) && !/^[-+_]/.test(requested)) {
    const pattern = datasource.indices.find((index) => index.includes('*') && globMatches(index, requested));
    if (pattern) {
      return requested;
    }
  }
  throw new LogPolicyError(
    `index ${JSON.stringify(requested)} is not available to the assistant; use one of ${datasource.indices.join(', ')}`
  );
}

function globMatches(pattern: string, name: string) {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(name);
}

function checkTime(name: string, value: string) {
  if (!TIME_VALUE.test(value)) {
    throw new LogPolicyError(
      `--${name} ${JSON.stringify(value)}: use date math such as now-6h, an ISO timestamp, or epoch milliseconds`
    );
  }
  return value;
}

function queryFilter(datasource: LogDatasource, params: LogQueryParams): Array<Record<string, unknown>> {
  const filter: Array<Record<string, unknown>> = [
    { range: { [datasource.timeField]: { gte: checkTime('from', params.from), lte: checkTime('to', params.to) } } },
  ];
  if (params.query?.trim()) {
    filter.push({ query_string: { query: params.query } });
  }
  return filter;
}

function dateHistogram(datasource: LogDatasource, params: LogCountParams) {
  if (!INTERVAL.test(params.interval ?? '')) {
    throw new LogPolicyError(`--interval ${JSON.stringify(params.interval)}: use a duration such as 30s, 5m, or 1h`);
  }
  return {
    date_histogram: {
      field: datasource.timeField,
      fixed_interval: params.interval,
      min_doc_count: 0,
      extended_bounds: { min: params.from, max: params.to },
    },
  };
}

/** Conditions on fields that exist in the index; a field must be visible, or the policy is rejected. */
function unrestrictedConditions(datasource: LogDatasource, fields: LogField[]) {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const conditions: Array<Record<string, unknown>> = [];
  for (const condition of datasource.unrestricted) {
    const field = byName.get(condition.field);
    if (!field) {
      continue;
    }
    if (!field.visible || !field.types.every((type) => type === 'keyword' || type === 'constant_keyword')) {
      throw new LogPolicyError(
        `the unrestricted condition on ${condition.field} is invalid: conditions must use keyword fields that are not part of a text field; fix the plugin settings`
      );
    }
    conditions.push({ terms: { [condition.field]: condition.values } });
  }
  return conditions;
}

type DecodedHit = {
  index: string;
  id: string;
  sort: unknown[];
  source?: Record<string, unknown>;
  fields?: Record<string, unknown>;
};

type DecodedResponse = {
  total: number;
  exact: boolean;
  timedOut: boolean;
  shards: { total: number; successful: number; failed: number };
  hits: DecodedHit[];
  aggregations?: Record<string, unknown>;
};

function decodeResponse(response: unknown): DecodedResponse {
  const value = asRecord(response);
  const error = asRecord(value.error);
  if (Object.keys(error).length > 0) {
    const cause = asRecord(Array.isArray(error.root_cause) ? error.root_cause[0] : undefined);
    const reason = String(cause.reason ?? error.reason ?? 'request failed');
    throw new Error(`Elasticsearch ${String(cause.type ?? error.type ?? 'error')}: ${reason}`);
  }
  const hits = asRecord(value.hits);
  const total = asRecord(hits.total);
  const shards = asRecord(value._shards);
  return {
    total: Number(total.value ?? 0),
    exact: total.relation !== 'gte',
    timedOut: value.timed_out === true,
    shards: {
      total: Number(shards.total ?? 0),
      successful: Number(shards.successful ?? 0),
      failed: Number(shards.failed ?? 0),
    },
    hits: (Array.isArray(hits.hits) ? hits.hits : []).map((raw) => {
      const hit = asRecord(raw);
      return {
        index: String(hit._index ?? ''),
        id: String(hit._id ?? ''),
        sort: Array.isArray(hit.sort) ? hit.sort : [],
        ...(hit._source !== undefined ? { source: asRecord(hit._source) } : {}),
        ...(hit.fields !== undefined ? { fields: asRecord(hit.fields) } : {}),
      };
    }),
    ...(value.aggregations !== undefined ? { aggregations: asRecord(value.aggregations) } : {}),
  };
}

function coverage(decoded: DecodedResponse): LogCoverage {
  return { exact: decoded.exact, shards: decoded.shards, timedOut: decoded.timedOut };
}

function decodeAggregations(aggregations: Record<string, unknown> | undefined) {
  if (!aggregations) {
    return {};
  }
  const series = (aggregation: unknown) =>
    buckets(aggregation).map((bucket) => ({
      time: new Date(Number(bucket.key)).toISOString(),
      count: Number(bucket.doc_count ?? 0),
    }));
  if (aggregations.groups !== undefined) {
    const groups = asRecord(aggregations.groups);
    return {
      groups: buckets(groups).map((bucket) => ({
        key: groupKey(bucket),
        count: Number(bucket.doc_count ?? 0),
        ...(bucket.time !== undefined ? { series: series(bucket.time) } : {}),
      })),
      otherCount: Number(groups.sum_other_doc_count ?? 0),
    };
  }
  return aggregations.time !== undefined ? { series: series(aggregations.time) } : {};
}

function groupKey(bucket: Record<string, unknown>): string | number | boolean {
  if (typeof bucket.key_as_string === 'string') {
    return bucket.key_as_string;
  }
  const key = bucket.key;
  return typeof key === 'number' || typeof key === 'boolean' ? key : String(key);
}

function buckets(aggregation: unknown): Array<Record<string, unknown>> {
  const value = asRecord(aggregation).buckets;
  return Array.isArray(value) ? value.map(asRecord) : [];
}

/**
 * A query on a field the index does not have matches nothing without an error.
 * Names such fields when a query matched no documents.
 */
function queryFieldNotices(query: string | undefined, fields: LogField[]) {
  if (!query) {
    return [];
  }
  const known = new Set(fields.map((field) => field.name));
  // Field names before `:` outside quoted phrases; wildcard field names are skipped.
  const unquoted = query.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const referenced = [...unquoted.matchAll(/(?:^|[\s(+!-])([A-Za-z_@][\w.@-]*):/g)].map((match) => match[1]);
  const unknown = [...new Set(referenced)].filter((name) => !known.has(name) && !name.startsWith('_'));
  const ranges = [...unquoted.matchAll(/(?:^|[\s(])([A-Za-z_@][\w.@-]*)\s*(>=|<=|>|<)\s*[\w.-]/g)].map(
    (match) => `no documents matched; write a range as ${match[1]}:${match[2]}VALUE (Lucene syntax)`
  );
  return [
    ...unknown.map(
      (name) =>
        `no documents matched, and field ${name} does not exist in this index${fieldSuggestion(name, fields).replace(/^; /, ': ')}`
    ),
    ...ranges,
  ];
}

/** Names a likely intended field, for example `error.type` for `error.type.keyword`. */
function fieldSuggestion(name: string, fields: LogField[]) {
  const groupable = fields.filter((field) => field.visible && field.aggregatable).map((field) => field.name);
  const base = name.replace(/\.keyword$/, '');
  const match =
    groupable.find((candidate) => candidate === base) ??
    groupable.find((candidate) => candidate.endsWith(`.${base}`) || base.endsWith(`.${candidate}`));
  return match ? `; did you mean ${match}?` : '; list fields with `grafana-logs fields --visible`';
}

/** Nested `_source` objects as dotted field names, like the `fields` of restricted documents. */
function flatten(value: Record<string, unknown>, prefix = '', into: Record<string, unknown> = {}) {
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flatten(child as Record<string, unknown>, name, into);
    } else {
      into[name] = child;
    }
  }
  return into;
}

/** Only visible fields, with single values unwrapped. */
function pickFields(fields: Record<string, unknown> | undefined, visible: Set<string>) {
  const document: Record<string, unknown> = {};
  for (const name of Object.keys(fields ?? {}).sort()) {
    if (!visible.has(name)) {
      continue;
    }
    const value = fields![name];
    document[name] = Array.isArray(value) && value.length === 1 ? value[0] : value;
  }
  return document;
}

function compareSort(left: unknown[], right: unknown[]) {
  const a = left[0];
  const b = right[0];
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}
