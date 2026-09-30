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
        'Rank the metrics the panels of visible dashboards use (every dashboard, or those matching a title search or tag), optionally around seed metrics.',
      usage: 'grafana-usage search [QUERY] [--tag TAG] [--seed METRIC]... [--ds UID] [--limit N]',
      effect: 'remote-read',
      options: {
        tag: { type: 'string', description: 'Dashboard tag filter.' },
        seed: { type: 'string[]', description: 'Rank related usage around this metric (repeatable).' },
        ds: { type: 'string', description: 'Only queries of this Prometheus datasource UID.' },
        limit: {
          type: 'number',
          description: 'Usage records to print (the full result is an artifact).',
          default: 160,
        },
      },
      examples: [
        "grafana-usage search checkout | jq -r '.metrics[].metric'",
        "grafana-usage search --seed http_requests_total | jq '.metrics[:10][] | {metric, score, reasons}'",
      ],
      async run(parsed, ctx) {
        const query = parsed.positionals.join(' ').trim() || undefined;
        const tag = stringOption(parsed, 'tag');
        const dashboards = await loadDashboards(ctx, { query, tag });
        const result = await requireUsage(ctx).search(
          {
            dashboards,
            query,
            tag,
            seedMetrics: listOption(parsed, 'seed'),
            datasourceUid: stringOption(parsed, 'ds'),
            maxUsages: numberOption(parsed, 'limit', 160, 1, Number.MAX_SAFE_INTEGER),
          },
          ctx.signal
        );
        const note =
          query && dashboards.length === 0
            ? `no dashboard title matches ${JSON.stringify(query)}; QUERY selects dashboards by title, not metrics. Rank around a metric with --seed METRIC, or find panel queries with \`grafana-dashboard queries --match REGEX\`.`
            : undefined;
        return withArtifact(ctx, 'Dashboard metric usage search', 'grafana-usage search', {
          ...(result as object),
          ...(note ? { note } : {}),
        });
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
        limit: { type: 'number', description: 'Related metrics to print.', default: 60 },
      },
      examples: [
        'grafana-usage related http_requests_total | jq -r \'.neighbors[] | "\\(.metric)\\t\\(.reasons | join("; "))"\'',
      ],
      async run(parsed, ctx) {
        if (parsed.positionals.length === 0) {
          throw new UsageError('at least one METRIC is required');
        }
        const dashboard = stringOption(parsed, 'dashboard');
        const query = stringOption(parsed, 'query');
        const tag = stringOption(parsed, 'tag');
        const result = await requireUsage(ctx).neighborhood(
          {
            metrics: parsed.positionals,
            dashboards: await loadDashboards(ctx, { query, tag, uid: dashboard ? dashboardUid(dashboard) : undefined }),
            query,
            tag,
            datasourceUid: stringOption(parsed, 'ds'),
            maxResults: numberOption(parsed, 'limit', 60, 1, Number.MAX_SAFE_INTEGER),
          },
          ctx.signal
        );
        return withArtifact(ctx, `Related metrics: ${parsed.positionals.join(', ')}`, 'grafana-usage related', result);
      },
    },
  },
};

/**
 * Working copies (unsaved edits included) of every visible dashboard, of those
 * matching a title search or tag, or of one dashboard. Loaded in parallel.
 */
async function loadDashboards(ctx: WorkspaceCommandContext, filter: { query?: string; tag?: string; uid?: string }) {
  let uids: readonly string[];
  if (filter.uid) {
    uids = [filter.uid];
  } else if (filter.query || filter.tag) {
    const dashboards = ctx.broker.dashboards;
    if (!dashboards) {
      throw new Error('dashboard access is not available in this session');
    }
    const found: string[] = [];
    for (let page = 1; ; page++) {
      const result = await dashboards.search(
        { query: filter.query, tags: filter.tag ? [filter.tag] : undefined, limit: 1000, page },
        ctx.signal
      );
      found.push(...result.hits.map((hit) => hit.uid));
      if (!result.hasMore || result.hits.length === 0) {
        break;
      }
    }
    uids = found;
  } else {
    uids = ctx.workspace.indexedUids();
  }
  await ctx.workspace.prefetch(uids, ctx.signal);
  const loaded: Array<{ uid: string; resource: Record<string, any>; meta?: Record<string, any> }> = [];
  for (const uid of uids) {
    try {
      const resource = JSON.parse(await ctx.tx.readFile(`${DASHBOARDS_ROOT}/${uid}/dashboard.json`));
      const meta = ctx.workspace.getResource(uid)?.base?.meta;
      const listing = ctx.workspace.describeIndexed(uid);
      loaded.push({ uid, resource, meta: { title: meta?.title, url: meta?.url, folderTitle: listing?.folderTitle } });
    } catch {
      // Unreadable or invalid dashboards are left out of the usage corpus.
    }
  }
  return loaded;
}

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
