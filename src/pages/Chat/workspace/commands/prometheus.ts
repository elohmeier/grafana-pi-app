import { dateMath } from '@grafana/data';
import { grafanaTime } from '../../domain/time';
import type { PrometheusTimeWindow } from '../broker';
import {
  applyVariableOverrides,
  DashboardWalkError,
  prometheusVariableFormatter,
  replaceVariables,
  type TemplateValue,
  unresolvedVariables,
} from '../dashboardPanels';
import { mapConcurrent } from '../concurrency';
import { normalizeWorkspacePath } from '../paths';
import {
  json,
  listOption,
  numberOption,
  ok,
  stringOption,
  UsageError,
  type WorkspaceCommandContext,
  type ParsedArgs,
  type WorkspaceCommandSpec,
} from './registry';

/** Expressions of one `grafana-prom query` call that run at the same time. */
const QUERY_CONCURRENCY = 6;
/** Discovery searches a recent window, like Grafana's metrics and label browsers, instead of all retained data. */
const WINDOW_OPTIONS = {
  since: {
    type: 'string',
    description: 'Time window ending now, such as 15m, 6h, or 2d.',
    default: '1h',
  },
  from: { type: 'string', description: 'Window start (date math such as now-6h, or ISO); overrides --since.' },
  to: { type: 'string', description: 'Window end.', default: 'now' },
} as const;
const WINDOW_USAGE = '[--since 1h | --from T --to T]';

export const grafanaPromCommand: WorkspaceCommandSpec = {
  name: 'grafana-prom',
  summary: 'Prometheus discovery and bounded query summaries through Grafana datasources.',
  subcommands: {
    datasources: {
      summary: 'List Prometheus datasources available to the assistant.',
      usage: 'grafana-prom datasources',
      effect: 'remote-read',
      async run(_parsed, ctx) {
        return json({ schemaVersion: 1, datasources: requireProm(ctx).datasources() });
      },
    },
    metrics: {
      summary: 'List metric names, optionally filtered by a regular expression.',
      usage: `grafana-prom metrics [REGEX] ${WINDOW_USAGE} [--ds UID] [--limit N]`,
      effect: 'remote-read',
      options: {
        ds: { type: 'string', description: 'Prometheus datasource UID (default: first allowed).' },
        limit: { type: 'number', description: 'Maximum names to print, 1-5000.', default: 500 },
        ...WINDOW_OPTIONS,
      },
      examples: [
        'grafana-prom metrics "^http_"',
        'grafana-prom metrics "^node_" --since 1d',
        'grafana-prom metrics | rg -c .',
      ],
      async run(parsed, ctx) {
        const limit = numberOption(parsed, 'limit', 500, 1, 5000);
        const pattern = parsed.positionals[0];
        const regex = pattern ? safeRegex(pattern) : undefined;
        const { window, notice } = timeWindow(parsed);
        const result = await requireProm(ctx).metricNames(stringOption(parsed, 'ds'), window, ctx.signal);
        const names = regex ? result.names.filter((name) => regex.test(name)) : result.names;
        const shown = names.slice(0, limit);
        const invalid = names.filter((name) => !METRIC_NAME.test(name));
        const stderr = [
          notice,
          names.length === 0 && pattern ? `# no metric names match ${pattern} in the window\n` : '',
          names.length > shown.length
            ? `# ${names.length - shown.length} more metrics omitted (--limit ${limit})\n`
            : '',
          invalid.length > 0
            ? `# ${invalid.length} names are not PromQL identifiers; select them by name, e.g. {__name__=${JSON.stringify(invalid[0])}}\n`
            : '',
        ].join('');
        return ok(shown.length ? `${shown.join('\n')}\n` : '', stderr);
      },
    },
    labels: {
      summary: 'List label names (no LABEL) or the values of LABEL, optionally restricted by a series selector.',
      usage: `grafana-prom labels [LABEL] [--match SELECTOR] ${WINDOW_USAGE} [--ds UID] [--limit N]`,
      effect: 'remote-read',
      options: {
        match: { type: 'string', description: 'Series selector such as up{job="api"}.' },
        ds: { type: 'string', description: 'Prometheus datasource UID.' },
        limit: { type: 'number', description: 'Maximum values to print.', default: 500 },
        ...WINDOW_OPTIONS,
      },
      examples: [
        "grafana-prom labels job --match 'up'",
        "grafana-prom labels --match 'http_requests_total' --since 6h",
      ],
      async run(parsed, ctx) {
        const label = parsed.positionals[0];
        const limit = numberOption(parsed, 'limit', 500, 1, 5000);
        const { window, notice } = timeWindow(parsed);
        if (!label) {
          const names = await requireProm(ctx).labelNames(
            stringOption(parsed, 'ds'),
            stringOption(parsed, 'match'),
            window,
            ctx.signal
          );
          return ok(
            names.names.slice(0, limit).join('\n') + (names.names.length ? '\n' : ''),
            notice + (names.names.length > limit ? `# ${names.names.length - limit} more labels omitted\n` : '')
          );
        }
        const match = stringOption(parsed, 'match');
        checkSelector(match);
        const result = await requireProm(ctx).labelValues(stringOption(parsed, 'ds'), label, match, window, ctx.signal);
        const shown = result.values.slice(0, limit);
        const stderr =
          result.values.length === 0
            ? `# no values for label ${label}${match ? ` matching ${match}` : ''} in the window\n`
            : result.values.length > shown.length
              ? `# ${result.values.length - shown.length} more values omitted\n`
              : '';
        return ok(shown.length ? `${shown.join('\n')}\n` : '', notice + stderr);
      },
    },
    series: {
      summary: 'List label sets of series matching a selector (NDJSON).',
      usage: `grafana-prom series SELECTOR ${WINDOW_USAGE} [--ds UID] [--limit N]`,
      effect: 'remote-read',
      options: {
        ds: { type: 'string', description: 'Prometheus datasource UID.' },
        limit: { type: 'number', description: 'Maximum series, 1-500.', default: 50 },
        ...WINDOW_OPTIONS,
      },
      examples: [
        `grafana-prom series 'up{job="api"}'`,
        "grafana-prom series 'http_requests_total' --from now-1d --to now-23h",
      ],
      async run(parsed, ctx) {
        const match = parsed.positionals.join(' ').trim();
        if (!match) {
          throw new UsageError('SELECTOR is required');
        }
        checkSelector(match);
        const limit = numberOption(parsed, 'limit', 50, 1, 500);
        const { window, notice } = timeWindow(parsed);
        const result = await requireProm(ctx).series(stringOption(parsed, 'ds'), match, limit, window, ctx.signal);
        const stderr = [
          notice,
          result.series.length === 0 ? `# no series match ${match} in the window\n` : '',
          result.truncated ? `# more than ${limit} series matched; narrow the selector\n` : '',
        ].join('');
        return ok(
          result.series.map((series) => JSON.stringify(series)).join('\n') + (result.series.length ? '\n' : ''),
          stderr
        );
      },
    },
    query: {
      summary:
        'Run PromQL and print {queryType, failed, results: [...]} with compact min/max/last summaries per expression (never raw frames). Repeat -e to run several expressions in one call (in parallel; results keep their order).',
      usage:
        'grafana-prom query EXPR | -e EXPR [-e EXPR]... | --file FILE [--var NAME=VALUE]... [--range] [--from now-1h] [--to now] [--step 1m] [--ds UID]',
      effect: 'remote-read',
      options: {
        file: { type: 'string', alias: 'f', description: 'Read one expression per line from FILE; - reads stdin.' },
        expr: { type: 'string[]', alias: 'e', description: 'PromQL expression (repeatable).' },
        var: {
          type: 'string[]',
          description:
            'Dashboard variable value NAME=VALUE for $NAME in the expressions (repeat a name for several values).',
        },
        range: { type: 'boolean', description: 'Run a range query instead of an instant query.' },
        from: { type: 'string', description: 'Range start (implies --range).' },
        to: { type: 'string', description: 'Range end (implies --range).' },
        step: {
          type: 'string',
          description: 'Range resolution such as 30s or 5m (implies --range; default: derived from the range).',
        },
        ds: { type: 'string', description: 'Prometheus datasource UID.' },
      },
      examples: [
        "grafana-prom query 'sum(rate(http_requests_total[5m])) by (service)' --from now-6h | jq '.results[0].series'",
        "grafana-prom query -e 'up' -e 'sum(rate(http_requests_total[5m]))' --from now-1h | jq '.results[] | {query, totalSeries, validationError}'",
      ],
      async run(parsed, ctx) {
        const expressions = listOption(parsed, 'expr');
        const file = stringOption(parsed, 'file');
        if (file) {
          const content = file === '-' ? ctx.stdin : await ctx.tx.readFile(normalizeWorkspacePath(file, ctx.cwd));
          expressions.push(
            ...content
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line && !line.startsWith('#'))
          );
        }
        const positional = parsed.positionals.join(' ').trim();
        if (positional) {
          expressions.unshift(positional);
        }
        if (expressions.length === 0) {
          throw new UsageError('EXPR is required');
        }
        const queries = substituteVariables(expressions, listOption(parsed, 'var'));
        const from = stringOption(parsed, 'from');
        const to = stringOption(parsed, 'to');
        const step = stringOption(parsed, 'step');
        const type = parsed.options.range === true || from || to || step ? 'range' : 'instant';
        const prom = requireProm(ctx);
        const ds = stringOption(parsed, 'ds');
        // Batches of long range queries against a slow store would run into the bash timeout one after another.
        const results = await mapConcurrent(queries, QUERY_CONCURRENCY, (query) =>
          prom.query(
            ds,
            {
              query,
              type,
              start: from ?? (type === 'range' ? 'now-1h' : undefined),
              end: to ?? (type === 'range' ? 'now' : undefined),
              step,
            },
            ctx.signal
          )
        );
        const summaries = [];
        for (const [index, summary] of results.entries()) {
          const query = queries[index];
          const artifact = ctx.artifacts?.register({
            kind: 'json',
            title: `PromQL: ${query.slice(0, 80)}`,
            toolName: 'grafana-prom query',
            data: summary,
            summary: `${type} query, ${String(summary.totalSeries ?? 0)} series`,
          });
          if (summary.totalSeries === 0 && typeof summary.validationError !== 'string') {
            const notices = Array.isArray(summary.notices) ? summary.notices : [];
            summary.notices = [
              ...notices,
              {
                severity: 'info',
                text: 'no series matched; check metric and label names and values with `grafana-prom series` before treating this as "no data right now"',
              },
            ];
          }
          summaries.push(artifact ? { ...summary, artifact: `/artifacts/${artifact.id}.json` } : summary);
        }
        const failed = summaries.filter((summary) => typeof summary.validationError === 'string').length;
        return json({ schemaVersion: 1, queryType: type, failed, results: summaries }, failed ? 1 : 0);
      },
    },
  },
};

/**
 * Substitutes --var values like the Prometheus datasource does. A dashboard variable left in the
 * expression reaches Prometheus as a literal `$name` (a regex anchor inside =~), so it matches nothing
 * or fails; refuse instead of reporting zero series. Grafana's own `$__` macros pass through.
 */
function substituteVariables(expressions: string[], items: string[]) {
  const variables: Record<string, TemplateValue> = {};
  try {
    applyVariableOverrides(variables, items);
  } catch (error) {
    if (error instanceof DashboardWalkError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
  const queries = expressions.map((expression) => replaceVariables(expression, variables, prometheusVariableFormatter));
  const missing = [
    ...new Set(queries.flatMap((query) => unresolvedVariables(query)).filter((name) => !name.startsWith('__'))),
  ];
  if (missing.length > 0) {
    throw new UsageError(
      `the expression uses dashboard variables ${missing.map((name) => `$${name}`).join(', ')}, which only a dashboard resolves; pass ${missing.map((name) => `--var ${name}=VALUE`).join(' ')}, or check a panel with \`grafana-dashboard data PATH --panel ID\``
    );
  }
  return queries;
}

const METRIC_NAME = /^[A-Za-z_:][A-Za-z0-9_:]*$/;

/** The --since/--from/--to window of a discovery command in epoch milliseconds, and a line that names it. */
function timeWindow(parsed: ParsedArgs): { window: PrometheusTimeWindow; notice: string } {
  const since = stringOption(parsed, 'since') ?? '1h';
  if (!/^[1-9]\d*[smhdwMy]$/.test(since)) {
    throw new UsageError(`--since ${JSON.stringify(since)}: use a duration such as 15m, 6h, or 2d`);
  }
  const from = stringOption(parsed, 'from') ?? `now-${since}`;
  const to = stringOption(parsed, 'to') ?? 'now';
  const start = resolveTime('from', from, false);
  const end = resolveTime('to', to, true);
  if (start >= end) {
    throw new UsageError(`--from ${from} must be before --to ${to}`);
  }
  const iso = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { window: { start, end }, notice: `# window: ${from} to ${to} (${iso(start)} to ${iso(end)})\n` };
}

function resolveTime(name: string, value: string, roundUp: boolean) {
  const time = grafanaTime(value.trim());
  const resolved =
    time === undefined
      ? undefined
      : /^\d+$/.test(time)
        ? Number(time)
        : dateMath.toDateTime(time, { roundUp })?.valueOf();
  if (resolved === undefined || !Number.isFinite(resolved)) {
    throw new UsageError(
      `--${name} ${JSON.stringify(value)}: use date math such as now-6h, an ISO timestamp, or epoch milliseconds`
    );
  }
  return resolved;
}

/** `name with spaces{...}` is not PromQL; Prometheus answers such selectors with a bare 400. */
function checkSelector(selector: string | undefined) {
  const match = selector?.trim().match(/^([^{}()"=~!]+?)\s*(?:\{(.*)\})?$/s);
  if (!match || METRIC_NAME.test(match[1])) {
    return;
  }
  const matchers = [`__name__=${JSON.stringify(match[1])}`, ...(match[2]?.trim() ? [match[2].trim()] : [])];
  throw new UsageError(
    `${JSON.stringify(match[1])} is not a valid PromQL metric name; select it by name: {${matchers.join(', ')}}`
  );
}

function requireProm(ctx: WorkspaceCommandContext) {
  if (!ctx.broker.prometheus) {
    throw new Error('Prometheus access is not available in this session');
  }
  return ctx.broker.prometheus;
}

function safeRegex(pattern: string) {
  try {
    return new RegExp(pattern);
  } catch {
    throw new UsageError(`invalid regular expression ${JSON.stringify(pattern)}`);
  }
}
