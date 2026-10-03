import { createSqlBroker, describeColumns, literal, type SqlQuery, type SqlTransport } from './sql';
import { runWorkspaceBash } from './shell';
import { SessionWorkspace } from './workspace';

const SENTINEL = 'PI-SENTINEL-SQL-0001';

const SCHEMA: Record<string, Array<[string, string, string]>> = {
  'dbo.Incidents': [
    ['Id', 'int', 'NO'],
    ['Number', 'nvarchar', 'YES'],
    ['OpenedAt', 'datetime2', 'NO'],
    ['ResolvedAt', 'datetime2', 'YES'],
    ['Priority', 'tinyint', 'NO'],
    ['Service', 'nvarchar', 'NO'],
    ['ShortDescription', 'nvarchar', 'NO'],
    ['Attachment', 'varbinary', 'YES'],
  ],
  'dbo.Employees': [
    ['Name', 'nvarchar', 'NO'],
    ['Salary', 'decimal', 'NO'],
  ],
  'ops.Incidents': [['Id', 'int', 'NO']],
};

const INCIDENTS = [
  {
    Id: 1,
    Number: 'INC100001',
    OpenedAt: Date.parse('2026-10-03T09:18:00Z'),
    ResolvedAt: null,
    Priority: 2,
    Service: 'report-renderer',
    ShortDescription: `${SENTINEL} Report download fails`,
    Attachment: SENTINEL,
  },
];

type Frame = { fields: Array<{ name: string; type: string }>; values: unknown[][] };

function frame(rows: Array<Record<string, unknown>>, names: string[], types: Record<string, string> = {}): Frame {
  return {
    fields: names.map((name) => ({ name, type: types[name] ?? 'other' })),
    values: names.map((name) => rows.map((row) => row[name] ?? null)),
  };
}

/** Answers schema queries from SCHEMA and row queries from INCIDENTS, returning only the selected columns. */
function setup(answer?: (query: SqlQuery) => Frame | undefined) {
  const calls: Array<{ uid: string; queries: SqlQuery[]; range: { from: string; to: string } }> = [];
  const transport: SqlTransport = {
    datasources: () => [
      { uid: 'mssql-itsm', name: 'ITSM', type: 'mssql', jsonData: { database: 'itsm' } },
      { uid: 'mssql-hr', name: 'HR', type: 'mssql', jsonData: { database: 'hr' } },
      { uid: 'prometheus', name: 'Prometheus', type: 'prometheus' },
    ],
    query: async (uid, queries, range) => {
      calls.push({ uid, queries, range });
      const results: Record<string, unknown> = {};
      for (const query of queries) {
        const result = answer?.(query) ?? defaultAnswer(query);
        results[query.refId] = {
          frames: [{ schema: { fields: result.fields }, data: { values: result.values } }],
        };
      }
      return { results };
    },
  };
  const broker = createSqlBroker(
    [
      {
        uid: 'mssql-itsm',
        tables: ['dbo.Incidents', 'Employees_typo'],
        visibleColumns: ['dbo.Incidents.Number', 'Incidents.Service'],
      },
      { uid: 'prometheus', tables: [] },
    ],
    transport
  );
  return { broker, calls };
}

function defaultAnswer(query: SqlQuery): Frame {
  if (query.refId === 'tables') {
    const rows = Object.keys(SCHEMA).map((table) => {
      const [s, t] = table.split('.');
      return { s, t, k: 'BASE TABLE' };
    });
    return frame(rows, ['s', 't', 'k']);
  }
  if (query.refId === 'columns') {
    const [, schema, table] = /TABLE_SCHEMA = N'([^']*)' AND TABLE_NAME = N'([^']*)'/.exec(query.rawSql) ?? [];
    const rows = (SCHEMA[`${schema}.${table}`] ?? []).map(([c, t, n]) => ({ c, t, n }));
    return frame(rows, ['c', 't', 'n']);
  }
  if (query.refId === 'total') {
    return frame([{ total: INCIDENTS.length }], ['total']);
  }
  const select = /^SELECT TOP \(\d+\) (.*?) FROM /.exec(query.rawSql);
  if (select) {
    const names = select[1].split(', ').map((name) => name.slice(1, -1));
    return frame(INCIDENTS, names, { OpenedAt: 'time', ResolvedAt: 'time' });
  }
  return frame([], []);
}

describe('column rule', () => {
  it('shows numeric, date/time, bit, and GUID columns and listed string columns', () => {
    const columns = describeColumns(
      'dbo.T',
      [
        { name: 'Id', type: 'int', nullable: false },
        { name: 'At', type: 'datetimeoffset', nullable: false },
        { name: 'Flag', type: 'bit', nullable: false },
        { name: 'Ref', type: 'uniqueidentifier', nullable: false },
        { name: 'State', type: 'varchar', nullable: false },
        { name: 'Notes', type: 'nvarchar', nullable: false },
        { name: 'Doc', type: 'xml', nullable: true },
        { name: 'Blob', type: 'varbinary', nullable: true },
        { name: 'Shape', type: 'geography', nullable: true },
      ],
      ['dbo.t.state', 'dbo.T.Doc']
    );
    expect(Object.fromEntries(columns.map((column) => [column.name, column.visible]))).toEqual({
      Id: true,
      At: true,
      Flag: true,
      Ref: true,
      State: true,
      Notes: false,
      // Only string columns can be listed.
      Doc: false,
      Blob: false,
      Shape: false,
    });
    expect(columns.filter((column) => column.time).map((column) => column.name)).toEqual(['At']);
  });
});

describe('policy', () => {
  it('lists only configured MSSQL datasources', () => {
    const { broker } = setup();
    expect(broker.datasources()).toEqual([
      {
        uid: 'mssql-itsm',
        name: 'ITSM',
        database: 'itsm',
        tables: ['dbo.Incidents', 'Employees_typo'],
        visibleColumns: ['dbo.Incidents.Number', 'Incidents.Service'],
      },
    ]);
  });

  it('lists only configured tables', async () => {
    const { broker } = setup();
    expect((await broker.tables(undefined)).tables).toEqual([{ table: 'dbo.Incidents', type: 'table' }]);
  });

  it.each([
    [{ datasource: 'mssql-hr', table: 'dbo.Incidents' }, /not a SQL datasource/],
    [{ datasource: 'prometheus', table: 'dbo.Incidents' }, /not a SQL datasource/],
    [{ table: 'dbo.Employees' }, /not available to the assistant/],
    [{ table: 'ops.Incidents' }, /not available to the assistant/],
  ])('refuses %j', async (target, message) => {
    const { broker, calls } = setup();
    await expect(broker.count(target)).rejects.toThrow(message);
    expect(calls.flatMap((call) => call.queries.map((query) => query.refId))).not.toContain('total');
  });
});

describe('queries', () => {
  it('selects only visible columns and orders by the time column', async () => {
    const { broker, calls } = setup();
    const result = await broker.rows({ table: 'incidents', time: 'openedat', from: 'now-6h', to: 'now', limit: 5 });
    const rows = calls.at(-1)!.queries.find((query) => query.refId === 'rows')!.rawSql;
    expect(rows).toBe(
      'SELECT TOP (5) [Id], [Number], [OpenedAt], [ResolvedAt], [Priority], [Service] FROM [dbo].[Incidents] WHERE $__timeFilter([OpenedAt]) ORDER BY [OpenedAt] DESC'
    );
    expect(calls.at(-1)!.range).toEqual({ from: 'now-6h', to: 'now' });
    expect(result.rows).toEqual([
      {
        Id: 1,
        Number: 'INC100001',
        OpenedAt: '2026-10-03T09:18:00.000Z',
        ResolvedAt: null,
        Priority: 2,
        Service: 'report-renderer',
      },
    ]);
    expect(result.hiddenColumns).toBe(2);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('refuses sensitive columns in --columns, --by, and --order', async () => {
    const { broker } = setup();
    await expect(broker.rows({ table: 'dbo.Incidents', columns: ['ShortDescription'], limit: 1 })).rejects.toThrow(
      /never returned/
    );
    await expect(broker.count({ table: 'dbo.Incidents', by: 'ShortDescription' })).rejects.toThrow(/only visible/);
    await expect(broker.rows({ table: 'dbo.Incidents', order: 'ShortDescription', limit: 1 })).rejects.toThrow(
      /only visible/
    );
  });

  it('compiles filters on any column with checked, quoted literals', async () => {
    const { broker, calls } = setup();
    await broker.count({
      table: 'dbo.Incidents',
      where: ["Service=o'brien", 'ShortDescription~50%_off [x]', 'Priority<=2', 'Number!=$__timeFilter(x)'],
      isNull: ['ResolvedAt'],
    });
    expect(calls.at(-1)!.queries[0].rawSql).toBe(
      "SELECT COUNT_BIG(*) AS total FROM [dbo].[Incidents] WHERE [Service] = N'o''brien' AND [ShortDescription] LIKE N'%50[%][_]off [[]x]%' AND [Priority] <= 2 AND [Number] <> N'' + NCHAR(36) + N'__timeFilter(x)' AND [ResolvedAt] IS NULL"
    );
  });

  it.each([
    ['Priority=1 OR 1=1', /not a number/],
    ['OpenedAt>yesterday', /not an ISO datetime2 value/],
    ['Attachment=abc', /cannot be compared/],
    ['Priority~1', /contains filters need a string column/],
    ['Nope=1', /no such column/],
    ['Service', /use COLUMN OP VALUE/],
  ])('refuses --where %s', async (filter, message) => {
    const { broker } = setup();
    await expect(broker.count({ table: 'dbo.Incidents', where: [filter] })).rejects.toThrow(message);
  });

  it('counts groups with time series in one request', async () => {
    const { broker, calls } = setup((query) => {
      if (query.refId === 'total') {
        return frame([{ total: 30 }], ['total']);
      }
      if (query.refId === 'groups') {
        return frame(
          [
            { k: 'report-renderer', c: 24 },
            { k: 'catalog', c: 4 },
          ],
          ['k', 'c']
        );
      }
      if (query.refId === 'series') {
        return frame(
          [
            { k: 'report-renderer', b: 1790998200, c: 20 },
            { k: 'Report-Renderer', b: 1791001800, c: 4 },
            { k: 'catalog', b: 1790998200, c: 4 },
            { k: 'search', b: 1790998200, c: 2 },
          ],
          ['k', 'b', 'c']
        );
      }
      return undefined;
    });
    const result = await broker.count({
      table: 'dbo.Incidents',
      by: 'service',
      top: 2,
      time: 'OpenedAt',
      from: '2026-10-03T06:00:00Z',
      to: 'now',
      interval: '1h',
    });
    const last = calls.at(-1)!;
    expect(last.range).toEqual({ from: String(Date.parse('2026-10-03T06:00:00Z')), to: 'now' });
    expect(last.queries.map((query) => query.rawSql)).toEqual([
      'SELECT COUNT_BIG(*) AS total FROM [dbo].[Incidents] WHERE $__timeFilter([OpenedAt])',
      'SELECT TOP (2) [Service] AS k, COUNT_BIG(*) AS c FROM [dbo].[Incidents] WHERE $__timeFilter([OpenedAt]) GROUP BY [Service] ORDER BY c DESC',
      "SELECT [Service] AS k, (DATEDIFF_BIG(second, '19700101', [OpenedAt]) / 3600 * 3600) AS b, COUNT_BIG(*) AS c FROM [dbo].[Incidents] WHERE $__timeFilter([OpenedAt]) GROUP BY [Service], (DATEDIFF_BIG(second, '19700101', [OpenedAt]) / 3600 * 3600) ORDER BY b",
    ]);
    expect(result).toMatchObject({
      total: 30,
      by: 'Service',
      otherCount: 2,
      groups: [
        {
          key: 'report-renderer',
          count: 24,
          series: [
            { time: '2026-10-03T03:30:00.000Z', count: 20 },
            { time: '2026-10-03T04:30:00.000Z', count: 4 },
          ],
        },
        { key: 'catalog', count: 4, series: [{ time: '2026-10-03T03:30:00.000Z', count: 4 }] },
      ],
    });
  });

  it('reports query errors', async () => {
    const transport: SqlTransport = {
      datasources: () => [{ uid: 'mssql-itsm', name: 'ITSM', type: 'mssql' }],
      query: async () => ({ results: { tables: { error: 'login failed' } } }),
    };
    const broker = createSqlBroker([{ uid: 'mssql-itsm' }], transport);
    await expect(broker.tables(undefined)).rejects.toThrow('SQL query failed: login failed');
  });

  it('writes $ outside of literals', () => {
    expect(literal("a$b'c")).toBe("N'a' + NCHAR(36) + N'b''c'");
  });
});

describe('grafana-sql command', () => {
  it('prints visible columns of rows and refuses sensitive ones', async () => {
    const { broker } = setup();
    const deps = { workspace: new SessionWorkspace(), broker: { sql: broker } };
    const run = (command: string) => runWorkspaceBash(deps, { command });
    const rows = await run('grafana-sql rows dbo.Incidents --limit 1');
    expect(rows.exitCode).toBe(0);
    expect(JSON.parse(rows.stdout)).toMatchObject({ Number: 'INC100001', Service: 'report-renderer' });
    expect(rows.stdout + rows.stderr).not.toContain(SENTINEL);
    expect(rows.stderr).toContain('2 columns not returned');

    const columns = await run('grafana-sql columns dbo.Incidents --visible | jq -r .name');
    expect(columns.stdout.trim().split('\n')).toEqual([
      'Id',
      'Number',
      'OpenedAt',
      'ResolvedAt',
      'Priority',
      'Service',
    ]);

    const refused = await run('grafana-sql count dbo.Incidents --since 1h');
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('need --time COLUMN');
  });
});
