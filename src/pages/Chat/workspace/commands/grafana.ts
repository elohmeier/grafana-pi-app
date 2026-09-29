import { buildNavigationPath } from '../../domain/navigation';
import { DASHBOARDS_ROOT, HYDRATION_CONCURRENCY, isBaseLoaded } from '../workspace';
import {
  json,
  listOption,
  numberOption,
  stringOption,
  UsageError,
  type WorkspaceCommandContext,
  type WorkspaceCommandSpec,
} from './registry';

export const grafanaCommand: WorkspaceCommandSpec = {
  name: 'grafana',
  summary: 'Discover Grafana resources and hydrate them into /grafana as local working copies.',
  subcommands: {
    search: {
      summary: 'Remote dashboard search by title, tag, and folder (paginated). Loaded results are marked hydrated.',
      usage: 'grafana search [QUERY] [--tag TAG]... [--folder UID]... [--limit N] [--page N]',
      effect: 'remote-read',
      options: {
        tag: { type: 'string[]', description: 'Require this dashboard tag (repeatable).' },
        folder: { type: 'string[]', description: 'Restrict to a folder UID (repeatable).' },
        limit: { type: 'number', description: 'Results per page, 1-5000.', default: 50 },
        page: { type: 'number', description: 'Result page, starting at 1.', default: 1 },
      },
      examples: ['grafana search checkout', "grafana search --tag genai | jq -r '.results[].uid'"],
      async run(parsed, ctx) {
        const dashboards = requireDashboards(ctx);
        const limit = numberOption(parsed, 'limit', 50, 1, 5000);
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
      summary: `Load dashboards into ${DASHBOARDS_ROOT}/<uid>/ in parallel: by UID, every visible dashboard, a folder, or a title search.`,
      usage: 'grafana fetch UID... | --all | --folder UID... | --query TEXT [--tag TAG]... | - (UIDs on stdin)',
      effect: 'remote-read',
      options: {
        all: { type: 'boolean', description: 'Every dashboard visible to the current user.' },
        folder: { type: 'string[]', description: 'Every dashboard in this folder UID (repeatable).' },
        query: { type: 'string', description: 'Every dashboard matching this title search.' },
        tag: { type: 'string[]', description: 'Every dashboard with this tag (repeatable).' },
      },
      examples: [
        'grafana fetch checkout-overview payments-api',
        'grafana fetch --all',
        'jq -r .uid /grafana/catalog/dashboards.ndjson | grep -i kafka | grafana fetch -',
      ],
      async run(parsed, ctx) {
        const dashboards = requireDashboards(ctx);
        let uids = uniq(parsed.positionals.filter((uid) => uid !== '-'));
        if (parsed.positionals.includes('-')) {
          uids = uniq([...uids, ...ctx.stdin.split(/\s+/)]);
        }
        const folders = listOption(parsed, 'folder');
        const tags = listOption(parsed, 'tag');
        const query = stringOption(parsed, 'query');
        if (parsed.options.all === true) {
          uids = uniq([...uids, ...ctx.workspace.indexedUids()]);
        }
        if (folders.length || tags.length || query) {
          uids = uniq([...uids, ...(await searchAll(dashboards, { query, tags, folderUids: folders }, ctx.signal))]);
        }
        if (uids.length === 0 && parsed.options.all !== true && !folders.length && !tags.length && !query) {
          throw new UsageError('pass UIDs, --all, --folder, --query, --tag, or - to read UIDs from stdin');
        }
        const { failed } = await ctx.workspace.prefetch(uids, ctx.signal);
        const failedUids = new Set(failed.map((failure) => failure.uid));
        const loaded = uids.filter((uid) => !failedUids.has(uid) && ctx.workspace.isResourceLoaded(uid));
        const fetched = loaded.map((uid) => {
          const entry = ctx.workspace.getResource(uid)!;
          return {
            uid,
            path: entry.path,
            title: entry.base?.meta.title,
            folderUid: entry.base?.meta.folderUid,
            apiVersion: entry.base?.meta.apiVersion,
            resourceVersion: entry.base?.meta.resourceVersion,
            managedBy: entry.base?.meta.managedBy,
            localChanges: Boolean(entry.overlay),
          };
        });
        // Many dashboards: print a summary; the paths are listed under /grafana/dashboards anyway.
        const summaryOnly = fetched.length > 50;
        return json(
          {
            schemaVersion: 1,
            requested: uids.length,
            loaded: fetched.length,
            ...(summaryOnly
              ? { note: `${fetched.length} dashboards loaded; search them with rg or grafana-dashboard queries` }
              : { fetched }),
            errors: failed,
          },
          failed.length > 0 && fetched.length === 0 ? 1 : 0
        );
      },
    },
    refresh: {
      summary: 'Re-fetch base snapshots of loaded dashboards (all unmodified ones when no UID is given).',
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
              .filter((entry) => entry.base && !entry.overlay && isBaseLoaded(entry))
              .map((entry) => entry.uid);
        const refreshed: Array<{ uid: string; resourceVersion?: string; changedRemotely: boolean }> = [];
        const errors: Array<{ uid: string; error: string }> = [];
        await mapConcurrent(targets, async (uid) => {
          try {
            const snapshot = await dashboards.get(uid, ctx.signal);
            if (!snapshot) {
              errors.push({ uid, error: 'not found or not readable by the current user' });
              return;
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
        });
        const changed = refreshed.filter((entry) => entry.changedRemotely);
        return json(
          {
            schemaVersion: 1,
            refreshed: refreshed.length,
            changedRemotely: changed.map((entry) => entry.uid),
            ...(refreshed.length <= 50 ? { dashboards: refreshed } : {}),
            errors,
          },
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

/** Every page of a dashboard search. */
async function searchAll(
  dashboards: NonNullable<WorkspaceCommandContext['broker']['dashboards']>,
  query: { query?: string; tags?: string[]; folderUids?: string[] },
  signal?: AbortSignal
) {
  const uids: string[] = [];
  for (let page = 1; ; page++) {
    const result = await dashboards.search({ ...query, limit: 1000, page }, signal);
    uids.push(...result.hits.map((hit) => hit.uid));
    if (!result.hasMore || result.hits.length === 0) {
      return uids;
    }
  }
}

async function mapConcurrent<T>(items: readonly T[], worker: (item: T) => Promise<void>) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      await worker(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(HYDRATION_CONCURRENCY, items.length) }, run));
}

function uniq(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
