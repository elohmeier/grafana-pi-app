import { DASHBOARDS_ROOT } from '../workspace';
import { dashboardUid } from './alerts';
import {
  json,
  listOption,
  numberOption,
  stringOption,
  UsageError,
  type CommandResult,
  type WorkspaceCommandContext,
  type WorkspaceCommandSpec,
} from './registry';

export const grafanaUsageCommand: WorkspaceCommandSpec = {
  name: 'grafana-usage',
  summary:
    'Prometheus metric usage derived from existing dashboards: which metrics, labels, and functions they use together.',
  subcommands: {
    dashboard: {
      summary:
        'Metric usage of one dashboard working copy (local edits included): metrics, panel locations, label matchers, grouping labels, functions, and relations.',
      usage: 'grafana-usage dashboard UID|PATH [--ds UID] [--limit N]',
      effect: 'remote-read',
      options: {
        ds: { type: 'string', description: 'Only queries of this Prometheus datasource UID.' },
        limit: { type: 'number', description: 'Maximum usage records, 1-120.', default: 120 },
      },
      examples: ['grafana-usage dashboard checkout | jq -r \'.metrics[] | [.metric, (.labels | join(","))] | @tsv\''],
      async run(parsed, ctx) {
        const usage = requireUsage(ctx);
        const arg = parsed.positionals[0];
        if (!arg) {
          throw new UsageError('UID or PATH is required');
        }
        const uid = dashboardUid(arg);
        const path = `${DASHBOARDS_ROOT}/${uid}/dashboard.json`;
        const content = await ctx.tx.readFile(path);
        let resource: Record<string, any>;
        try {
          resource = JSON.parse(content);
        } catch (error) {
          throw new Error(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        const meta = ctx.workspace.getResource(uid)?.base?.meta;
        const result = await usage.inspect(
          { uid, datasourceUid: stringOption(parsed, 'ds'), maxUsages: numberOption(parsed, 'limit', 120, 1, 120) },
          { resource, meta: meta ? { title: meta.title, url: meta.url } : undefined, signal: ctx.signal }
        );
        return withArtifact(ctx, `Metric usage: ${uid}`, 'grafana-usage dashboard', { path, ...(result as object) });
      },
    },
    search: {
      summary:
        'Search visible dashboards (Grafana search, bounded) and rank the metrics their panels use, optionally around seed metrics.',
      usage: 'grafana-usage search [QUERY] [--tag TAG] [--seed METRIC]... [--ds UID] [--max-dashboards N] [--limit N]',
      effect: 'remote-read',
      options: {
        tag: { type: 'string', description: 'Dashboard tag filter.' },
        seed: { type: 'string[]', description: 'Rank related usage around this metric (repeatable).' },
        ds: { type: 'string', description: 'Only queries of this Prometheus datasource UID.' },
        'max-dashboards': { type: 'number', description: 'Dashboards to inspect, 1-30.', default: 30 },
        limit: { type: 'number', description: 'Maximum usage records, 1-160.', default: 160 },
      },
      examples: [
        "grafana-usage search checkout | jq -r '.metrics[].metric'",
        "grafana-usage search --seed http_requests_total | jq '.metrics[:10][] | {metric, score, reasons}'",
      ],
      async run(parsed, ctx) {
        const result = await requireUsage(ctx).search(
          {
            query: parsed.positionals.join(' ').trim() || undefined,
            tag: stringOption(parsed, 'tag'),
            seedMetrics: listOption(parsed, 'seed'),
            datasourceUid: stringOption(parsed, 'ds'),
            maxDashboards: numberOption(parsed, 'max-dashboards', 30, 1, 30),
            maxUsages: numberOption(parsed, 'limit', 160, 1, 160),
          },
          ctx.signal
        );
        return withArtifact(ctx, 'Dashboard metric usage search', 'grafana-usage search', result);
      },
    },
    related: {
      summary:
        'Metrics related to seed metrics by dashboard co-usage, shared panels, and label signatures (for example the latency and saturation metrics next to a request counter).',
      usage: 'grafana-usage related METRIC... [--dashboard UID|PATH] [--query Q] [--tag TAG] [--ds UID] [--limit N]',
      effect: 'remote-read',
      options: {
        dashboard: { type: 'string', description: 'Only this dashboard instead of a dashboard search.' },
        query: { type: 'string', description: 'Dashboard title search text.' },
        tag: { type: 'string', description: 'Dashboard tag filter.' },
        ds: { type: 'string', description: 'Only queries of this Prometheus datasource UID.' },
        'max-dashboards': { type: 'number', description: 'Dashboards to inspect, 1-30.', default: 30 },
        limit: { type: 'number', description: 'Maximum related metrics, 1-60.', default: 60 },
      },
      examples: [
        'grafana-usage related http_requests_total | jq -r \'.neighbors[] | "\\(.metric)\\t\\(.reasons | join("; "))"\'',
      ],
      async run(parsed, ctx) {
        if (parsed.positionals.length === 0) {
          throw new UsageError('at least one METRIC is required');
        }
        const dashboard = stringOption(parsed, 'dashboard');
        const result = await requireUsage(ctx).neighborhood(
          {
            metrics: parsed.positionals,
            dashboardUid: dashboard ? dashboardUid(dashboard) : undefined,
            query: stringOption(parsed, 'query'),
            tag: stringOption(parsed, 'tag'),
            datasourceUid: stringOption(parsed, 'ds'),
            maxDashboards: numberOption(parsed, 'max-dashboards', 30, 1, 30),
            maxResults: numberOption(parsed, 'limit', 60, 1, 60),
          },
          ctx.signal
        );
        return withArtifact(ctx, `Related metrics: ${parsed.positionals.join(', ')}`, 'grafana-usage related', result);
      },
    },
  },
};

/** Prints the result and keeps it as an artifact, so a truncated stdout can be re-read with jq. */
function withArtifact(ctx: WorkspaceCommandContext, title: string, toolName: string, result: unknown): CommandResult {
  const record = result as Record<string, unknown>;
  const counts = ['metrics', 'neighbors', 'usages', 'dashboards']
    .filter((key) => Array.isArray(record[key]))
    .map((key) => `${(record[key] as unknown[]).length} ${key}`);
  const artifact = ctx.artifacts?.register({ kind: 'json', title, toolName, data: result, summary: counts.join(', ') });
  return json(artifact ? { ...record, artifact: `/artifacts/${artifact.id}.json` } : result);
}

function requireUsage(ctx: WorkspaceCommandContext) {
  if (!ctx.broker.metricUsage) {
    throw new Error('dashboard metric usage is not available in this session');
  }
  return ctx.broker.metricUsage;
}
