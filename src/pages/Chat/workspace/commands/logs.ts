import { LogPolicyError, type LogDocument, type LogsBroker } from '../logs';
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

const TARGET_OPTIONS: Record<string, OptionSpec> = {
  ds: { type: 'string', description: 'Log datasource UID or name (default: first configured).' },
  index: { type: 'string', description: 'Index, data stream, or alias (default: all configured indices).' },
};

const QUERY_OPTIONS: Record<string, OptionSpec> = {
  ...TARGET_OPTIONS,
  query: {
    type: 'string[]',
    alias: 'q',
    description: 'Lucene query; may search any field, including message text. Repeat to combine queries with AND.',
  },
  since: { type: 'string', description: 'Time window ending now, such as 15m, 6h, or 2d.', default: '1h' },
  from: { type: 'string', description: 'Range start (date math such as now-6h, or ISO); overrides --since.' },
  to: { type: 'string', description: 'Range end.', default: 'now' },
};

export const grafanaLogsCommand: WorkspaceCommandSpec = {
  name: 'grafana-logs',
  summary:
    'Elasticsearch logs through Grafana datasources: structure, counts, and documents without text fields (messages), except for documents the admin made unrestricted.',
  subcommands: {
    sources: {
      summary: 'List log datasources, their indices, and the conditions for complete (unrestricted) documents.',
      usage: 'grafana-logs sources',
      effect: 'remote-read',
      async run(_parsed, ctx) {
        return json({ schemaVersion: 1, datasources: requireLogs(ctx).datasources() });
      },
    },
    fields: {
      summary:
        'List fields of an index as NDJSON {name, types, searchable, aggregatable, visible}; visible fields are returned in documents and usable with --by.',
      usage: 'grafana-logs fields [REGEX] [--ds UID] [--index INDEX] [--visible]',
      effect: 'remote-read',
      options: {
        ...TARGET_OPTIONS,
        visible: { type: 'boolean', description: 'Only fields returned in documents.' },
      },
      examples: ['grafana-logs fields --index logs-app-prod --visible', "grafana-logs fields '^http\\.'"],
      async run(parsed, ctx) {
        const pattern = parsed.positionals[0];
        const regex = pattern ? safeRegex(pattern) : undefined;
        const result = await policy(() => requireLogs(ctx).fields(target(parsed), ctx.signal));
        const fields = result.fields.filter(
          (field) => (!regex || regex.test(field.name)) && (parsed.options.visible !== true || field.visible)
        );
        const hidden = result.fields.filter((field) => !field.visible).length;
        return ok(
          fields.map((field) => JSON.stringify(field)).join('\n') + (fields.length ? '\n' : ''),
          `# ${result.index}: ${result.fields.length} fields, ${hidden} text fields: searchable with -q, never returned\n`
        );
      },
    },
    count: {
      summary:
        'Count documents matching a time range and query. Prints JSON {total, exact, series: [{time, count}]} with --interval, or {groups: [{key, count, series?}], otherCount} with --by.',
      usage:
        'grafana-logs count [-q QUERY] [--since 1h | --from T --to T] [--by FIELD [--top N]] [--interval 5m] [--ds UID] [--index INDEX]',
      effect: 'remote-read',
      options: {
        ...QUERY_OPTIONS,
        by: { type: 'string', description: 'Group by this visible, aggregatable field.' },
        top: { type: 'number', description: 'Number of groups.', default: 10 },
        interval: { type: 'string', description: 'Time bucket such as 1m, 5m, or 1h.' },
      },
      examples: [
        "grafana-logs count --index logs-app-prod --since 6h -q 'log.level:ERROR' --by error.type --interval 15m",
        'grafana-logs count -q \'message:"timed out"\' --by host.name',
      ],
      async run(parsed, ctx) {
        const result = await policy(() =>
          requireLogs(ctx).count(
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
          title: `Log count: ${result.index}${result.query ? ` ${result.query.slice(0, 60)}` : ''}`,
          toolName: 'grafana-logs count',
          data: result,
          summary: `${result.total} documents${result.exact ? '' : ' (at least)'}`,
        });
        return ok(
          compactJson({
            schemaVersion: 1,
            ...result,
            ...(artifact ? { artifact: `/artifacts/${artifact.id}.json` } : {}),
          }),
          coverageNotice(result.timedOut, result.shards.failed)
        );
      },
    },
    search: {
      summary:
        'Print matching documents as NDJSON, newest first, one {_index, _id, _restricted, "@timestamp", "service.name", ...} object per line with dotted field names. Restricted documents have their visible fields only (no message text); documents matching an unrestricted condition are complete.',
      usage: 'grafana-logs search [-q QUERY] [--since 1h | --from T --to T] [--limit N] [--ds UID] [--index INDEX]',
      effect: 'remote-read',
      options: {
        ...QUERY_OPTIONS,
        limit: { type: 'number', description: 'Maximum documents.', default: 100 },
      },
      examples: [
        'grafana-logs search --index logs-app-prod -q \'error.type:ReportRenderTimeout\' --limit 20 | jq -c \'{"@timestamp", "host.name"}\'',
        "grafana-logs search -q 'service.name:report-renderer' --since 6h | jq -c 'select(._restricted == false)'",
      ],
      async run(parsed, ctx) {
        const result = await policy(() =>
          requireLogs(ctx).search(
            { ...queryParams(parsed), limit: numberOption(parsed, 'limit', 100, 1, Number.MAX_SAFE_INTEGER) },
            ctx.signal
          )
        );
        const artifact = ctx.artifacts?.register({
          kind: 'json',
          title: `Log search: ${result.index}${result.query ? ` ${result.query.slice(0, 60)}` : ''}`,
          toolName: 'grafana-logs search',
          data: result,
          summary: `${result.documents.length} documents`,
        });
        const complete = result.documents.filter((document) => !document.restricted).length;
        const matched = result.total.unrestricted + result.total.restricted;
        const stderr = [
          `# ${result.documents.length} of ${matched}${result.total.exact ? '' : '+'} matching documents (${complete} complete, ${result.documents.length - complete} restricted to visible fields)`,
          artifact ? `; artifact /artifacts/${artifact.id}.json` : '',
          '\n',
          coverageNotice(result.timedOut, result.shardFailures),
          ...(result.notices ?? []).map((notice) => `# ${notice}\n`),
        ].join('');
        return ok(
          result.documents.map((document) => JSON.stringify(documentLine(document))).join('\n') +
            (result.documents.length ? '\n' : ''),
          stderr
        );
      },
    },
  },
};

function documentLine(document: LogDocument) {
  const { '@timestamp': timestamp, ...fields } = document.fields;
  return {
    _index: document.index,
    _id: document.id,
    _restricted: document.restricted,
    ...(timestamp !== undefined ? { '@timestamp': timestamp } : {}),
    ...Object.fromEntries(Object.entries(fields).sort(([left], [right]) => left.localeCompare(right))),
  };
}

/** JSON with top-level fields on their own lines and each array item (a bucket or group) on one line. */
export function compactJson(value: Record<string, unknown>) {
  const lines = Object.entries(value).map(([key, item]) => {
    const name = JSON.stringify(key);
    if (Array.isArray(item) && item.length > 0) {
      return `  ${name}: [\n${item.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n')}\n  ]`;
    }
    return `  ${name}: ${JSON.stringify(item)}`;
  });
  return `{\n${lines.join(',\n')}\n}\n`;
}

function target(parsed: ParsedArgs) {
  return { datasource: stringOption(parsed, 'ds'), index: stringOption(parsed, 'index') };
}

function queryParams(parsed: ParsedArgs) {
  const since = stringOption(parsed, 'since') ?? '1h';
  if (!/^[1-9]\d*[smhdwMy]$/.test(since)) {
    throw new UsageError(`--since ${JSON.stringify(since)}: use a duration such as 15m, 6h, or 2d`);
  }
  return {
    ...target(parsed),
    from: stringOption(parsed, 'from') ?? `now-${since}`,
    to: stringOption(parsed, 'to') ?? 'now',
    query: combineQueries(listOption(parsed, 'query')),
  };
}

function combineQueries(queries: string[]) {
  const parts = queries.map((query) => query.trim()).filter(Boolean);
  return parts.length > 1 ? parts.map((query) => `(${query})`).join(' AND ') : parts[0];
}

function coverageNotice(timedOut: boolean, failedShards: number) {
  return [
    timedOut ? '# the search timed out: results are partial\n' : '',
    failedShards > 0 ? `# ${failedShards} shards failed: results are partial\n` : '',
  ].join('');
}

/** Policy refusals are usage errors: the model can correct the arguments. */
async function policy<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof LogPolicyError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

function requireLogs(ctx: WorkspaceCommandContext): LogsBroker {
  if (!ctx.broker.logs) {
    throw new Error('log access is not available in this session');
  }
  return ctx.broker.logs;
}

function safeRegex(pattern: string) {
  try {
    return new RegExp(pattern);
  } catch {
    throw new UsageError(`invalid regular expression ${JSON.stringify(pattern)}`);
  }
}
