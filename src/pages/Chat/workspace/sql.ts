import type { PiAppSqlDatasource } from '../../../types';

/**
 * Restricted Microsoft SQL Server access for `grafana-sql`.
 *
 * String and binary columns can hold sensitive content (names, free text,
 * documents); numeric, date/time, bit, and uniqueidentifier columns do not.
 * The admin lists the tables the assistant may use and the string columns that
 * are safe to return. The assistant gets the schema, counts (filtered by any
 * column, grouped by visible columns), and rows with their visible columns.
 *
 * This module builds every query itself from names checked against
 * INFORMATION_SCHEMA and quoted literals, so sensitive columns are never
 * selected. See docs/restricted-sql.md.
 */

export type SqlDatasource = {
  uid: string;
  name: string;
  database?: string;
  /** `schema.table` or `table`; empty means every table and view of the database. */
  tables: string[];
  /** `schema.table.column` or `table.column`. */
  visibleColumns: string[];
};

export type SqlDatasourceSettings = {
  uid: string;
  name: string;
  type: string;
  jsonData?: Record<string, unknown>;
};

export type SqlQuery = { refId: string; rawSql: string };

/** Runs queries through Grafana's `/api/ds/query` as the current user and returns its response. */
export type SqlTransport = {
  datasources: () => SqlDatasourceSettings[];
  query: (
    datasourceUid: string,
    queries: SqlQuery[],
    range: { from: string; to: string },
    signal?: AbortSignal
  ) => Promise<unknown>;
};

export type SqlTable = { table: string; type: 'table' | 'view' };

export type SqlColumn = {
  name: string;
  type: string;
  nullable: boolean;
  /** Returned in rows and usable with `--by`. */
  visible: boolean;
  /** Usable with `--time`. */
  time: boolean;
};

/** `COLUMN OP VALUE` with OP one of = != < <= > >= ~ (contains) !~ (does not contain). */
export type SqlFilter = string;

export type SqlTarget = { datasource?: string; table: string };

export type SqlQueryParams = SqlTarget & {
  where?: SqlFilter[];
  isNull?: string[];
  notNull?: string[];
  /** Date/time column for `from`/`to` and `interval`. */
  time?: string;
  from?: string;
  to?: string;
};

export type SqlCountParams = SqlQueryParams & {
  by?: string;
  top?: number;
  /** Bucket size such as 5m or 1h; needs a time column. */
  interval?: string;
};

export type SqlRowsParams = SqlQueryParams & {
  columns?: string[];
  order?: string;
  ascending?: boolean;
  limit: number;
};

type Bucket = { time: string; count: number };
type GroupKey = string | number | boolean | null;

export type SqlCountResult = {
  datasourceUid: string;
  table: string;
  where?: string[];
  time?: { column: string; from: string; to: string };
  total: number;
  interval?: string;
  by?: string;
  /** Buckets with rows, oldest first; buckets without rows are omitted. */
  series?: Bucket[];
  groups?: Array<{ key: GroupKey; count: number; series?: Bucket[] }>;
  /** Rows in groups beyond --top. */
  otherCount?: number;
};

export type SqlRowsResult = {
  datasourceUid: string;
  table: string;
  where?: string[];
  time?: { column: string; from: string; to: string };
  total: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** Columns of the table that are not returned: sensitive, or not requested with --columns. */
  hiddenColumns: number;
};

export type SqlBroker = {
  datasources: () => SqlDatasource[];
  tables: (
    datasource: string | undefined,
    signal?: AbortSignal
  ) => Promise<{ datasourceUid: string; tables: SqlTable[] }>;
  columns: (
    target: SqlTarget,
    signal?: AbortSignal
  ) => Promise<{ datasourceUid: string; table: string; columns: SqlColumn[] }>;
  count: (params: SqlCountParams, signal?: AbortSignal) => Promise<SqlCountResult>;
  rows: (params: SqlRowsParams, signal?: AbortSignal) => Promise<SqlRowsResult>;
};

export class SqlPolicyError extends Error {}

const NUMERIC_TYPES = new Set([
  'bigint',
  'int',
  'smallint',
  'tinyint',
  'decimal',
  'numeric',
  'money',
  'smallmoney',
  'float',
  'real',
]);
const TIME_TYPES = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset']);
const VISIBLE_TYPES = new Set([...NUMERIC_TYPES, ...TIME_TYPES, 'time', 'bit', 'uniqueidentifier']);
const STRING_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext']);
const TIME_VALUE =
  /^(now([+-]\d+[smhdwMy])*(\/[smhdwMy])?|\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?|\d{10,13})$/;
const INTERVAL = /^([1-9]\d*)(s|m|h|d)$/;
const FILTER = /^\s*([^=!<>~]+?)\s*(<=|>=|!=|!~|=|<|>|~)(.*)$/s;
const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_LITERAL = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** SQL datasources from the policy that exist as MSSQL datasources. */
export function sqlDatasources(
  policy: PiAppSqlDatasource[] | undefined,
  available: SqlDatasourceSettings[]
): SqlDatasource[] {
  const result: SqlDatasource[] = [];
  for (const entry of policy ?? []) {
    const settings = available.find((ds) => ds.uid === entry.uid && ds.type === 'mssql');
    if (!settings) {
      continue;
    }
    const database = typeof settings.jsonData?.database === 'string' ? settings.jsonData.database : undefined;
    result.push({
      uid: settings.uid,
      name: settings.name,
      ...(database ? { database } : {}),
      tables: (entry.tables ?? []).map((table) => table.trim()).filter(Boolean),
      visibleColumns: (entry.visibleColumns ?? []).map((column) => column.trim()).filter(Boolean),
    });
  }
  return result;
}

/** Visible: a non-string, non-binary type, or a string column the admin listed. */
export function describeColumns(
  table: string,
  rows: Array<{ name: string; type: string; nullable: boolean }>,
  visibleColumns: string[]
): SqlColumn[] {
  return rows.map((row) => {
    const type = row.type.toLowerCase();
    const listed =
      STRING_TYPES.has(type) && visibleColumns.some((entry) => qualifiedMatch(entry, `${table}.${row.name}`));
    return {
      name: row.name,
      type,
      nullable: row.nullable,
      visible: VISIBLE_TYPES.has(type) || listed,
      time: TIME_TYPES.has(type),
    };
  });
}

export function createSqlBroker(policy: PiAppSqlDatasource[] | undefined, transport: SqlTransport): SqlBroker {
  const datasources = () => sqlDatasources(policy, transport.datasources());

  const resolveDatasource = (requested: string | undefined) => {
    const available = datasources();
    const datasource = requested ? available.find((ds) => ds.uid === requested || ds.name === requested) : available[0];
    if (!datasource) {
      throw new SqlPolicyError(
        requested
          ? `datasource ${JSON.stringify(requested)} is not a SQL datasource available to the assistant`
          : 'no SQL datasource is available to the assistant'
      );
    }
    return datasource;
  };

  const run = async (
    datasource: SqlDatasource,
    queries: SqlQuery[],
    range: TimeRange | undefined,
    signal?: AbortSignal
  ) =>
    decodeResults(
      await transport.query(datasource.uid, queries, range ?? { from: 'now-1h', to: 'now' }, signal),
      queries.map((query) => query.refId)
    );

  const tables = async (datasource: SqlDatasource, signal?: AbortSignal) => {
    const [rows] = await run(
      datasource,
      [
        {
          refId: 'tables',
          rawSql:
            'SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, TABLE_TYPE AS k FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME',
        },
      ],
      undefined,
      signal
    );
    return rows
      .map((row) => ({
        table: `${String(row.s)}.${String(row.t)}`,
        type: String(row.k).toUpperCase() === 'VIEW' ? ('view' as const) : ('table' as const),
      }))
      .filter(
        (table) =>
          datasource.tables.length === 0 || datasource.tables.some((entry) => qualifiedMatch(entry, table.table))
      );
  };

  const resolveTable = async (target: SqlTarget, signal?: AbortSignal) => {
    const datasource = resolveDatasource(target.datasource);
    const available = await tables(datasource, signal);
    const requested = target.table.trim();
    const matches = available.filter((table) => qualifiedMatch(requested, table.table));
    if (matches.length === 1) {
      return { datasource, table: matches[0].table };
    }
    if (matches.length > 1) {
      throw new SqlPolicyError(
        `table ${JSON.stringify(requested)} is ambiguous; use one of ${matches.map((table) => table.table).join(', ')}`
      );
    }
    throw new SqlPolicyError(
      `table ${JSON.stringify(requested)} is not available to the assistant; list tables with \`grafana-sql tables\``
    );
  };

  const columns = async (target: SqlTarget, signal?: AbortSignal) => {
    const { datasource, table } = await resolveTable(target, signal);
    const [schema, name] = splitTable(table);
    const [rows] = await run(
      datasource,
      [
        {
          refId: 'columns',
          rawSql: `SELECT COLUMN_NAME AS c, DATA_TYPE AS t, IS_NULLABLE AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ${literal(schema)} AND TABLE_NAME = ${literal(name)} ORDER BY ORDINAL_POSITION`,
        },
      ],
      undefined,
      signal
    );
    const described = describeColumns(
      table,
      rows.map((row) => ({ name: String(row.c), type: String(row.t), nullable: String(row.n) === 'YES' })),
      datasource.visibleColumns
    );
    return { datasource, table, columns: described };
  };

  /** The checked table, its columns, and the WHERE clause of a query. */
  const prepare = async (params: SqlQueryParams, signal?: AbortSignal) => {
    const resolved = await columns(params, signal);
    const column = (name: string, option: string) => findColumn(resolved.columns, name, option, resolved.table);
    const conditions: string[] = [];
    for (const filter of params.where ?? []) {
      conditions.push(compileFilter(filter, column));
    }
    for (const name of params.isNull ?? []) {
      conditions.push(`${identifier(column(name, '--null').name)} IS NULL`);
    }
    for (const name of params.notNull ?? []) {
      conditions.push(`${identifier(column(name, '--not-null').name)} IS NOT NULL`);
    }
    let time: { column: SqlColumn; from: string; to: string } | undefined;
    if (params.time) {
      const timeColumn = column(params.time, '--time');
      if (!timeColumn.time) {
        throw new SqlPolicyError(`--time ${timeColumn.name}: not a date/time column (${timeColumn.type})`);
      }
      time = {
        column: timeColumn,
        from: checkTime('from', params.from ?? 'now-1h'),
        to: checkTime('to', params.to ?? 'now'),
      };
      // Grafana expands the macro with the request's time range (UTC).
      conditions.push(`$__timeFilter(${identifier(timeColumn.name)})`);
    }
    return {
      ...resolved,
      from: `FROM ${tableIdentifier(resolved.table)}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}`,
      column,
      time,
      range: time ? { from: requestTime(time.from), to: requestTime(time.to) } : undefined,
      describe: () => ({
        ...(params.where?.length || params.isNull?.length || params.notNull?.length
          ? {
              where: [
                ...(params.where ?? []),
                ...(params.isNull ?? []).map((name) => `${name} IS NULL`),
                ...(params.notNull ?? []).map((name) => `${name} IS NOT NULL`),
              ],
            }
          : {}),
        ...(time ? { time: { column: time.column.name, from: time.from, to: time.to } } : {}),
      }),
    };
  };

  return {
    datasources,
    async tables(datasource, signal) {
      const resolved = resolveDatasource(datasource);
      return { datasourceUid: resolved.uid, tables: await tables(resolved, signal) };
    },
    async columns(target, signal) {
      const result = await columns(target, signal);
      return { datasourceUid: result.datasource.uid, table: result.table, columns: result.columns };
    },
    async count(params, signal) {
      const query = await prepare(params, signal);
      let bucket: string | undefined;
      if (params.interval) {
        if (!query.time) {
          throw new SqlPolicyError('--interval needs a date/time column (--time COLUMN)');
        }
        bucket = bucketExpression(query.time.column.name, params.interval);
      }
      let by: SqlColumn | undefined;
      if (params.by) {
        by = query.column(params.by, '--by');
        if (!by.visible) {
          throw new SqlPolicyError(
            `--by ${by.name}: only visible columns can be grouped by (see \`grafana-sql columns ${query.table}\`)`
          );
        }
      }
      const queries: SqlQuery[] = [{ refId: 'total', rawSql: `SELECT COUNT_BIG(*) AS total ${query.from}` }];
      const key = by ? identifier(by.name) : undefined;
      if (key) {
        queries.push({
          refId: 'groups',
          rawSql: `SELECT TOP (${params.top ?? 10}) ${key} AS k, COUNT_BIG(*) AS c ${query.from} GROUP BY ${key} ORDER BY c DESC`,
        });
      }
      if (bucket) {
        queries.push({
          refId: 'series',
          rawSql: key
            ? `SELECT ${key} AS k, ${bucket} AS b, COUNT_BIG(*) AS c ${query.from} GROUP BY ${key}, ${bucket} ORDER BY b`
            : `SELECT ${bucket} AS b, COUNT_BIG(*) AS c ${query.from} GROUP BY ${bucket} ORDER BY b`,
        });
      }
      const [totalRows, ...rest] = await run(query.datasource, queries, query.range, signal);
      const total = Number(totalRows[0]?.total ?? 0);
      const groupRows = key ? rest[0] : undefined;
      const seriesRows = bucket ? rest[rest.length - 1] : undefined;
      const toBucket = (row: Record<string, unknown>) => ({
        time: new Date(Number(row.b) * 1000).toISOString(),
        count: Number(row.c),
      });
      const result: SqlCountResult = {
        datasourceUid: query.datasource.uid,
        table: query.table,
        ...query.describe(),
        total,
        ...(params.interval ? { interval: params.interval } : {}),
        ...(by ? { by: by.name } : {}),
      };
      if (groupRows) {
        const groups = groupRows.map((row) => ({ key: groupKey(row.k), count: Number(row.c) }));
        result.groups = groups.map((group) =>
          seriesRows
            ? {
                ...group,
                series: seriesRows.filter((row) => sameKey(groupKey(row.k), group.key)).map(toBucket),
              }
            : group
        );
        result.otherCount = total - groups.reduce((sum, group) => sum + group.count, 0);
      } else if (seriesRows) {
        result.series = seriesRows.map(toBucket);
      }
      return result;
    },
    async rows(params, signal) {
      const query = await prepare(params, signal);
      const visible = query.columns.filter((column) => column.visible);
      let selected = visible;
      if (params.columns?.length) {
        selected = params.columns.map((name) => {
          const column = query.column(name, '--columns');
          if (!column.visible) {
            throw new SqlPolicyError(`--columns ${column.name}: sensitive columns are never returned`);
          }
          return column;
        });
      }
      if (selected.length === 0) {
        throw new SqlPolicyError(`${query.table} has no visible columns`);
      }
      const order = params.order ? query.column(params.order, '--order') : query.time?.column;
      if (order && !order.visible) {
        throw new SqlPolicyError(`--order ${order.name}: only visible columns can be ordered by`);
      }
      const orderBy = order ? ` ORDER BY ${identifier(order.name)} ${params.ascending ? 'ASC' : 'DESC'}` : '';
      const [totalRows, rows] = await run(
        query.datasource,
        [
          { refId: 'total', rawSql: `SELECT COUNT_BIG(*) AS total ${query.from}` },
          {
            refId: 'rows',
            rawSql: `SELECT TOP (${params.limit}) ${selected.map((column) => identifier(column.name)).join(', ')} ${query.from}${orderBy}`,
          },
        ],
        query.range,
        signal
      );
      return {
        datasourceUid: query.datasource.uid,
        table: query.table,
        ...query.describe(),
        total: Number(totalRows[0]?.total ?? 0),
        columns: selected.map((column) => column.name),
        rows,
        hiddenColumns: query.columns.length - selected.length,
      };
    },
  };
}

type TimeRange = { from: string; to: string };

/** `schema.table[.column]` against an entry with or without the schema, case-insensitive like SQL Server's default collation. */
function qualifiedMatch(entry: string, qualified: string) {
  const left = entry.toLowerCase();
  const right = qualified.toLowerCase();
  return left === right || right.slice(right.indexOf('.') + 1) === left;
}

function splitTable(table: string) {
  const dot = table.indexOf('.');
  return [table.slice(0, dot), table.slice(dot + 1)];
}

function findColumn(columns: SqlColumn[], name: string, option: string, table: string) {
  const column = columns.find((candidate) => candidate.name.toLowerCase() === name.trim().toLowerCase());
  if (!column) {
    throw new SqlPolicyError(
      `${option} ${name}: no such column in ${table}; list columns with \`grafana-sql columns ${table}\``
    );
  }
  return column;
}

function compileFilter(filter: string, column: (name: string, option: string) => SqlColumn) {
  const match = FILTER.exec(filter);
  if (!match) {
    throw new SqlPolicyError(
      `--where ${JSON.stringify(filter)}: use COLUMN OP VALUE with OP one of = != < <= > >= ~ (contains) !~ (does not contain)`
    );
  }
  const [, name, op, rawValue] = match;
  const target = column(name, '--where');
  const value = rawValue.trim();
  const ref = identifier(target.name);
  if (op === '~' || op === '!~') {
    if (!STRING_TYPES.has(target.type)) {
      throw new SqlPolicyError(`--where ${target.name}${op}: contains filters need a string column (${target.type})`);
    }
    const pattern = `%${value.replace(/[[%_]/g, (char) => `[${char}]`)}%`;
    return `${ref} ${op === '~' ? 'LIKE' : 'NOT LIKE'} ${literal(pattern)}`;
  }
  const sqlOp = op === '!=' ? '<>' : op;
  return `${ref} ${sqlOp} ${typedLiteral(target, value)}`;
}

/** A literal of the column's type, checked first so that conversion errors do not happen in SQL Server. */
function typedLiteral(column: SqlColumn, value: string) {
  if (NUMERIC_TYPES.has(column.type)) {
    if (!NUMBER.test(value)) {
      throw new SqlPolicyError(`--where ${column.name}: ${JSON.stringify(value)} is not a number`);
    }
    return value;
  }
  if (column.type === 'bit') {
    const bit = { '0': 0, '1': 1, false: 0, true: 1 }[value.toLowerCase()];
    if (bit === undefined) {
      throw new SqlPolicyError(`--where ${column.name}: use 0, 1, true, or false`);
    }
    return String(bit);
  }
  if (TIME_TYPES.has(column.type) || column.type === 'time') {
    if (column.type === 'time' ? !/^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value) : !DATE_LITERAL.test(value)) {
      throw new SqlPolicyError(`--where ${column.name}: ${JSON.stringify(value)} is not an ISO ${column.type} value`);
    }
    return literal(value);
  }
  if (column.type === 'uniqueidentifier') {
    if (!GUID.test(value)) {
      throw new SqlPolicyError(`--where ${column.name}: ${JSON.stringify(value)} is not a GUID`);
    }
    return literal(value);
  }
  if (STRING_TYPES.has(column.type)) {
    return literal(value);
  }
  throw new SqlPolicyError(
    `--where ${column.name}: ${column.type} columns cannot be compared; use --null or --not-null`
  );
}

/**
 * An N'...' literal. `$` is written as NCHAR(36): Grafana expands `$__macro(...)`
 * anywhere in the query text, including inside string literals.
 */
export function literal(value: string) {
  return value
    .split('$')
    .map((part) => `N'${part.replace(/'/g, "''")}'`)
    .join(' + NCHAR(36) + ');
}

/** A bracketed identifier; names come from INFORMATION_SCHEMA. */
export function identifier(name: string) {
  if (name.includes('$')) {
    throw new SqlPolicyError(`column ${JSON.stringify(name)} cannot be queried: its name contains $`);
  }
  return `[${name.replace(/]/g, ']]')}]`;
}

function tableIdentifier(table: string) {
  return splitTable(table).map(identifier).join('.');
}

/** Bucket start in Unix seconds; DATEDIFF_BIG uses UTC for datetimeoffset. */
function bucketExpression(column: string, interval: string) {
  const match = INTERVAL.exec(interval);
  if (!match) {
    throw new SqlPolicyError(`--interval ${JSON.stringify(interval)}: use a duration such as 30s, 5m, 1h, or 1d`);
  }
  const seconds = Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return `(DATEDIFF_BIG(second, '19700101', ${identifier(column)}) / ${seconds} * ${seconds})`;
}

function checkTime(name: string, value: string) {
  if (!TIME_VALUE.test(value)) {
    throw new SqlPolicyError(
      `--${name} ${JSON.stringify(value)}: use date math such as now-6h, an ISO timestamp, or epoch milliseconds`
    );
  }
  return value;
}

/** Grafana parses epoch milliseconds and date math; ISO timestamps are sent as epoch milliseconds. */
function requestTime(value: string) {
  if (value.startsWith('now') || /^\d+$/.test(value)) {
    return /^\d{10}$/.test(value) ? `${value}000` : value;
  }
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) || value.length === 10 ? value : `${value}Z`;
  const time = Date.parse(iso.replace(' ', 'T'));
  if (Number.isNaN(time)) {
    throw new SqlPolicyError(`invalid time ${JSON.stringify(value)}`);
  }
  return String(time);
}

function groupKey(value: unknown): GroupKey {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
}

function sameKey(left: GroupKey, right: GroupKey) {
  return (
    left === right ||
    (typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase())
  );
}

/** Rows of each query's first frame, by refId; time fields as ISO strings. */
export function decodeResults(response: unknown, refIds: string[]): Array<Array<Record<string, unknown>>> {
  const results = asRecord(asRecord(response).results);
  return refIds.map((refId) => {
    const result = asRecord(results[refId]);
    if (typeof result.error === 'string' && result.error) {
      throw new Error(`SQL query failed: ${result.error}`);
    }
    const frame = asRecord(Array.isArray(result.frames) ? result.frames[0] : undefined);
    const fields: Array<Record<string, any>> = Array.isArray(asRecord(frame.schema).fields)
      ? asRecord(frame.schema).fields.map(asRecord)
      : [];
    const values: unknown[][] = Array.isArray(asRecord(frame.data).values) ? asRecord(frame.data).values : [];
    const length = Math.max(0, ...values.map((column) => (Array.isArray(column) ? column.length : 0)));
    const rows: Array<Record<string, unknown>> = [];
    for (let index = 0; index < length; index++) {
      const row: Record<string, unknown> = {};
      fields.forEach((field, column) => {
        const value = values[column]?.[index] ?? null;
        row[String(field.name)] =
          field.type === 'time' && typeof value === 'number' ? new Date(value).toISOString() : value;
      });
      rows.push(row);
    }
    return rows;
  });
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}
