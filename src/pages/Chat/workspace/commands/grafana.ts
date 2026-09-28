import { buildNavigationPath } from '../../domain/navigation';
import { DASHBOARDS_ROOT, isBaseLoaded } from '../workspace';
import {
  json,
  listOption,
  numberOption,
  stringOption,
  UsageError,
  type WorkspaceCommandContext,
  type WorkspaceCommandSpec,
} from './registry';

const MAX_FETCH_PER_CALL = 20;

export const grafanaCommand: WorkspaceCommandSpec = {
  name: 'grafana',
  summary: 'Discover Grafana resources and hydrate them into /grafana as local working copies.',
  subcommands: {
    search: {
      summary: 'Bounded remote dashboard search. Reports coverage; hydrated results show their local path.',
      usage: 'grafana search [QUERY] [--tag TAG]... [--folder UID]... [--limit N] [--page N]',
      effect: 'remote-read',
      options: {
        tag: { type: 'string[]', description: 'Require this dashboard tag (repeatable).' },
        folder: { type: 'string[]', description: 'Restrict to a folder UID (repeatable).' },
        limit: { type: 'number', description: 'Results per page, 1-200.', default: 50 },
        page: { type: 'number', description: 'Result page, starting at 1.', default: 1 },
      },
      examples: ['grafana search checkout', "grafana search --tag genai | jq -r '.results[].uid'"],
      async run(parsed, ctx) {
        const dashboards = requireDashboards(ctx);
        const limit = numberOption(parsed, 'limit', 50, 1, 200);
        const page = numberOption(parsed, 'page', 1, 1, 1000);
        const query = parsed.positionals.join(' ').trim() || undefined;
        const result = await dashboards.search(
          { query, tags: listOption(parsed, 'tag'), folderUids: listOption(parsed, 'folder'), limit, page },
          ctx.signal
        );
        return json({
          schemaVersion: 1,
          query: query ?? null,
          results: result.hits.map((hit) => {
            const entry = ctx.workspace.getResource(hit.uid);
            return {
              ...hit,
              path: `${DASHBOARDS_ROOT}/${hit.uid}/dashboard.json`,
              hydrated: Boolean(entry && (entry.overlay || isBaseLoaded(entry))),
            };
          }),
          coverage: {
            scope: 'remote search (Grafana search API, current user permissions)',
            page,
            returned: result.hits.length,
            limit,
            hasMore: result.hasMore,
            nextPage: result.hasMore ? page + 1 : null,
          },
        });
      },
    },
    fetch: {
      summary: `Hydrate dashboards by UID into ${DASHBOARDS_ROOT}/<uid>/ (max ${MAX_FETCH_PER_CALL} per call).`,
      usage: 'grafana fetch UID...',
      effect: 'remote-read',
      examples: ['grafana fetch checkout-overview payments-api'],
      async run(parsed, ctx) {
        requireDashboards(ctx);
        const uids = uniq(parsed.positionals);
        if (uids.length === 0) {
          throw new UsageError('at least one dashboard UID is required');
        }
        if (uids.length > MAX_FETCH_PER_CALL) {
          throw new UsageError(`at most ${MAX_FETCH_PER_CALL} UIDs per call`);
        }
        const fetched: unknown[] = [];
        const errors: Array<{ uid: string; error: string }> = [];
        for (const uid of uids) {
          try {
            const entry = await ctx.workspace.hydrate(uid, ctx.signal);
            if (!entry?.base && !entry?.overlay) {
              errors.push({ uid, error: 'not found or not readable by the current user' });
              continue;
            }
            fetched.push({
              uid,
              path: entry.path,
              title: entry.base?.meta.title,
              folderUid: entry.base?.meta.folderUid,
              apiVersion: entry.base?.meta.apiVersion,
              resourceVersion: entry.base?.meta.resourceVersion,
              managedBy: entry.base?.meta.managedBy,
              localChanges: Boolean(entry.overlay),
            });
          } catch (error) {
            errors.push({ uid, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return json({ schemaVersion: 1, fetched, errors }, errors.length > 0 && fetched.length === 0 ? 1 : 0);
      },
    },
    refresh: {
      summary: 'Re-fetch base snapshots for hydrated dashboards (all unmodified ones when no UID is given).',
      usage: 'grafana refresh [UID...] [--discard]',
      effect: 'remote-read',
      options: {
        discard: { type: 'boolean', description: 'Discard local changes of the listed UIDs before refreshing.' },
      },
      async run(parsed, ctx) {
        const dashboards = requireDashboards(ctx);
        const discard = parsed.options.discard === true;
        const targets = parsed.positionals.length
          ? uniq(parsed.positionals)
          : ctx.workspace
              .resourceEntries()
              .filter((entry) => entry.base && !entry.overlay)
              .map((entry) => entry.uid);
        const refreshed: unknown[] = [];
        const errors: Array<{ uid: string; error: string }> = [];
        for (const uid of targets.slice(0, MAX_FETCH_PER_CALL)) {
          try {
            const snapshot = await dashboards.get(uid, ctx.signal);
            if (!snapshot) {
              errors.push({ uid, error: 'not found or not readable by the current user' });
              continue;
            }
            const before = ctx.workspace.getResource(uid)?.base?.meta.resourceVersion;
            ctx.workspace.setResourceBase(snapshot, { discardOverlay: discard });
            refreshed.push({
              uid,
              resourceVersion: snapshot.meta.resourceVersion,
              changedRemotely: before !== undefined && before !== snapshot.meta.resourceVersion,
            });
          } catch (error) {
            errors.push({ uid, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return json(
          { schemaVersion: 1, refreshed, errors, truncated: targets.length > MAX_FETCH_PER_CALL },
          errors.length > 0 ? 1 : 0
        );
      },
    },
    open: {
      summary:
        "Open a Grafana page in the user's browser: a dashboard, Prometheus Explore with a query, this chat, or a Grafana-relative path.",
      usage:
        'grafana open dashboard UID [--slug S] | explore EXPR [--ds UID] [--from now-1h] [--to now] | chat | /PATH',
      effect: 'remote-read',
      options: {
        slug: { type: 'string', description: 'Dashboard URL slug.' },
        ds: { type: 'string', description: 'Prometheus datasource UID for explore (default: first allowed).' },
        from: { type: 'string', description: 'Explore range start.', default: 'now-1h' },
        to: { type: 'string', description: 'Explore range end.', default: 'now' },
      },
      examples: [
        'grafana open dashboard checkout-overview',
        "grafana open explore 'sum(rate(http_requests_total[5m])) by (service)' --from now-6h",
      ],
      async run(parsed, ctx) {
        const ui = ctx.broker.ui;
        if (!ui) {
          throw new Error('browser navigation is not available in this session');
        }
        const [target, ...rest] = parsed.positionals;
        let path: string;
        try {
          if (target === 'dashboard') {
            path = buildNavigationPath({ type: 'dashboard', uid: rest[0], slug: stringOption(parsed, 'slug') });
          } else if (target === 'explore') {
            const datasourceUid = stringOption(parsed, 'ds') ?? ctx.broker.prometheus?.datasources()[0]?.uid;
            path = buildNavigationPath({
              type: 'prometheus_explore',
              datasourceUid,
              query: rest.join(' '),
              start: stringOption(parsed, 'from'),
              end: stringOption(parsed, 'to'),
            });
          } else if (target === 'chat') {
            path = buildNavigationPath({ type: 'app_chat' });
          } else if (target?.startsWith('/')) {
            path = buildNavigationPath({ type: 'relative', path: target });
          } else {
            throw new UsageError('TARGET must be dashboard, explore, chat, or a path starting with /');
          }
        } catch (error) {
          throw error instanceof UsageError
            ? error
            : new UsageError(error instanceof Error ? error.message : String(error));
        }
        ui.navigate(path);
        return json({ schemaVersion: 1, opened: path });
      },
    },
  },
};

function requireDashboards(ctx: WorkspaceCommandContext) {
  if (!ctx.broker.dashboards) {
    throw new Error('dashboard access is not available in this session');
  }
  return ctx.broker.dashboards;
}

function uniq(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
