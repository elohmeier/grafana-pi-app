import { SqlPolicyError, type SqlBroker } from '../sql';
import { compactJson } from './logs';
import {
  json,
  listOption,
  numberOption,
  ok,
  type OptionSpec,
  type ParsedArgs,
  stringOption,
  UsageError,
  type WorkspaceCommandContext,
  type WorkspaceCommandSpec,
} from './registry';

const DS_OPTION: Record<string, OptionSpec> = {
  ds: { type: 'string', description: 'SQL datasource UID or name (default: first configured).' },
};

const QUERY_OPTIONS: Record<string, OptionSpec> = {
  ...DS_OPTION,
  where: {
    type: 'string[]',
    alias: 'w',
    description:
      'Filter COLUMN OP VALUE, OP one of = != < <= > >= ~ (contains) !~; any column, including sensitive ones. Repeat to combine with AND.',
  },
  null: { type: 'string[]', description: 'Column IS NULL. Repeatable.' },
  'not-null': { type: 'string[]', description: 'Column IS NOT NULL. Repeatable.' },
  time: { type: 'string', description: 'Date/time column that --since/--from/--to filter on.' },
  since: { type: 'string', description: 'Time window ending now, such as 15m, 6h, or 2d (needs --time).' },
  from: { type: 'string', description: 'Range start (date math such as now-6h, or ISO UTC); overrides --since.' },
  to: { type: 'string', description: 'Range end (default now).' },
};

export const grafanaSqlCommand: WorkspaceCommandSpec = {
  name: 'grafana-sql',
  summary:
    'Microsoft SQL Server tables through Grafana datasources: schema, counts, and rows with visible columns only (string columns are sensitive unless the admin made them visible).',
  subcommands: {
    sources: {
      summary: 'List SQL datasources, their allowed tables, and the string columns the admin made visible.',
      usage: 'grafana-sql sources',
      effect: 'remote-read',
      async run(_parsed, ctx) {
        return json({ schemaVersion: 1, datasources: requireSql(ctx).datasources() });
      },
    },
    tables: {
      summary: 'List the tables and views available to the assistant as NDJSON {table, type}.',
      usage: 'grafana-sql tables [REGEX] [--ds UID]',
      effect: 'remote-read',
      options: DS_OPTION,
      async run(parsed, ctx) {
        const pattern = parsed.positionals[0];
        const regex = pattern ? safeRegex(pattern, 'i') : undefined;
        const result = await policy(() => requireSql(ctx).tables(stringOption(parsed, 'ds'), ctx.signal));
        const tables = result.tables.filter((table) => !regex || regex.test(table.table));
        return ok(ndjson(tables));
      },
    },
    columns: {
      summary:
        'List the columns of a table as NDJSON {name, type, nullable, visible, time}. Visible columns are returned in rows and usable with --by; time columns with --time. Sensitive columns are usable in --where only.',
      usage: 'grafana-sql columns TABLE [--ds UID] [--visible]',
      effect: 'remote-read',
      options: { ...DS_OPTION, visible: { type: 'boolean', description: 'Only visible columns.' } },
      examples: ['grafana-sql columns dbo.Incidents'],
      async run(parsed, ctx) {
        const result = await policy(() => requireSql(ctx).columns(target(parsed), ctx.signal));
        const columns = result.columns.filter((column) => parsed.options.visible !== true || column.visible);
        const hidden = result.columns.filter((column) => !column.visible).length;
        return ok(
          ndjson(columns),
          `# ${result.table}: ${result.columns.length} columns, ${hidden} sensitive: usable in --where, never returned\n`
        );
      },
    },
    count: {
      summary:
        'Count rows of a table. Prints JSON {total, series: [{time, count}]} with --interval, or {groups: [{key, count, series?}], otherCount} with --by. Series omit buckets without rows.',
      usage:
        'grafana-sql count TABLE [--where COL=VALUE ...] [--time COL --since 6h | --from T --to T] [--by COL [--top N]] [--interval 1h] [--ds UID]',
      effect: 'remote-read',
      options: {
        ...QUERY_OPTIONS,
        by: { type: 'string', description: 'Group by this visible column.' },
        top: { type: 'number', description: 'Number of groups.', default: 10 },
        interval: { type: 'string', description: 'Time bucket such as 15m, 1h, or 1d (needs --time).' },
      },
      examples: [
        'grafana-sql count dbo.Incidents --time OpenedAt --since 6h --by Service --interval 15m',
        "grafana-sql count dbo.Incidents --where 'Priority<=2' --where 'ShortDescription~timeout' --by Host",
      ],
      async run(parsed, ctx) {
        const result = await policy(() =>
          requireSql(ctx).count(
            {
              ...queryParams(parsed),
              by: stringOption(parsed, 'by'),
              top: numberOption(parsed, 'top', 10, 1, 10000),
              interval: stringOption(parsed, 'interval'),
            },
            ctx.signal
          )
        );
        const artifact = ctx.artifacts?.register({
          kind: 'json',
          title: `SQL count: ${result.table}`,
          toolName: 'grafana-sql count',
          data: result,
          summary: `${result.total} rows`,
        });
        return ok(
          compactJson({
            schemaVersion: 1,
            ...result,
            ...(artifact ? { artifact: `/artifacts/${artifact.id}.json` } : {}),
          })
        );
      },
    },
    rows: {
      summary:
        'Print matching rows as NDJSON with their visible columns only, newest first when --time or --order is given.',
      usage:
        'grafana-sql rows TABLE [--where COL=VALUE ...] [--time COL --since 6h] [--columns A,B] [--order COL [--asc]] [--limit N] [--ds UID]',
      effect: 'remote-read',
      options: {
        ...QUERY_OPTIONS,
        columns: { type: 'string', description: 'Comma-separated visible columns (default: all visible).' },
        order: { type: 'string', description: 'Order by this visible column, descending (default: --time column).' },
        asc: { type: 'boolean', description: 'Ascending order.' },
        limit: { type: 'number', description: 'Maximum rows.', default: 100 },
      },
      examples: [
        'grafana-sql rows dbo.Changes --time ImplementedAt --since 1d --columns Number,Service,Host,Version,ImplementedAt',
        "grafana-sql rows dbo.Incidents --where 'State=New' --null ResolvedAt --limit 20 | jq -c '{Number, Service}'",
      ],
      async run(parsed, ctx) {
        const columns = stringOption(parsed, 'columns');
        const result = await policy(() =>
          requireSql(ctx).rows(
            {
              ...queryParams(parsed),
              columns: columns
                ? columns
                    .split(',')
                    .map((column) => column.trim())
                    .filter(Boolean)
                : undefined,
              order: stringOption(parsed, 'order'),
              ascending: parsed.options.asc === true,
              limit: numberOption(parsed, 'limit', 100, 1, Number.MAX_SAFE_INTEGER),
            },
            ctx.signal
          )
        );
        const artifact = ctx.artifacts?.register({
          kind: 'json',
          title: `SQL rows: ${result.table}`,
          toolName: 'grafana-sql rows',
          data: result,
          summary: `${result.rows.length} rows`,
        });
        const stderr = [
          `# ${result.rows.length} of ${result.total} matching rows; ${result.hiddenColumns} columns not returned`,
          artifact ? `; artifact /artifacts/${artifact.id}.json` : '',
          '\n',
        ].join('');
        return ok(ndjson(result.rows), stderr);
      },
    },
  },
};

function target(parsed: ParsedArgs) {
  const table = parsed.positionals[0];
  if (!table) {
    throw new UsageError('TABLE is required; list tables with `grafana-sql tables`');
  }
  return { datasource: stringOption(parsed, 'ds'), table };
}

function queryParams(parsed: ParsedArgs) {
  const time = stringOption(parsed, 'time');
  const since = stringOption(parsed, 'since');
  const from = stringOption(parsed, 'from');
  const to = stringOption(parsed, 'to');
  if (!time && (since || from || to)) {
    throw new UsageError('--since, --from, and --to need --time COLUMN (a date/time column of the table)');
  }
  if (since && !/^[1-9]\d*[smhdwMy]$/.test(since)) {
    throw new UsageError(`--since ${JSON.stringify(since)}: use a duration such as 15m, 6h, or 2d`);
  }
  return {
    ...target(parsed),
    where: listOption(parsed, 'where'),
    isNull: listOption(parsed, 'null'),
    notNull: listOption(parsed, 'not-null'),
    ...(time ? { time, from: from ?? `now-${since ?? '1h'}`, to: to ?? 'now' } : {}),
  };
}

function ndjson(items: unknown[]) {
  return items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
}

/** Policy refusals are usage errors: the model can correct the arguments. */
async function policy<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SqlPolicyError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

function requireSql(ctx: WorkspaceCommandContext): SqlBroker {
  if (!ctx.broker.sql) {
    throw new Error('SQL access is not available in this session');
  }
  return ctx.broker.sql;
}

function safeRegex(pattern: string, flags?: string) {
  try {
    return new RegExp(pattern, flags);
  } catch {
    throw new UsageError(`invalid regular expression ${JSON.stringify(pattern)}`);
  }
}
