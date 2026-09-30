import { createTwoFilesPatch } from 'diff';
import { describeDashboardRemovals } from '../dashboardChanges';
import { validateDashboardDocument } from '../dashboardModel';
import { LIVE_DASHBOARD_PATH, liveDashboardDocument, liveRevision } from '../liveDashboard';
import { truncateUtf8 } from '../paths';
import { fail, json, ok, type WorkspaceCommandContext, type WorkspaceCommandSpec } from './registry';

const MAX_DIFF_BYTES = 60_000;
/** The browser state before the last `live apply`; /tmp lasts as long as the page, like the unsaved state. */
const LIVE_UNDO_PATH = '/tmp/live/before-apply.json';

export const liveCommand: WorkspaceCommandSpec = {
  name: 'live',
  summary: `Apply edits of ${LIVE_DASHBOARD_PATH} to the unsaved dashboard open in the browser.`,
  subcommands: {
    status: {
      summary: 'Show the open dashboard, whether local edits are staged, and whether the browser state changed since.',
      usage: 'live status',
      effect: 'remote-read',
      async run(_parsed, ctx) {
        const live = requireLive(ctx);
        const current = await live.get(ctx.signal);
        const staged = stagedDocument(ctx);
        return json({
          schemaVersion: 1,
          uid: current.uid,
          title: current.spec.title,
          revision: current.revision,
          staged: Boolean(staged),
          ...(staged
            ? {
                stale: staged.revision !== undefined && staged.revision !== current.revision,
                next: 'staged edits are not visible in the browser yet; run `live apply`',
              }
            : {}),
          path: LIVE_DASHBOARD_PATH,
        });
      },
    },
    diff: {
      summary: `Unified diff from the current browser state to the staged ${LIVE_DASHBOARD_PATH}.`,
      usage: 'live diff',
      effect: 'remote-read',
      async run(_parsed, ctx) {
        const live = requireLive(ctx);
        const staged = stagedDocument(ctx);
        if (!staged) {
          return ok('', `# no staged changes in ${LIVE_DASHBOARD_PATH}\n`);
        }
        const current = liveDashboardDocument(await live.get(ctx.signal));
        const patch = createTwoFilesPatch('a/live', 'b/live', current, staged.content, undefined, undefined, {
          context: 3,
        });
        const limited = truncateUtf8(patch, MAX_DIFF_BYTES);
        return ok(limited.text, limited.truncated ? `# diff truncated at ${MAX_DIFF_BYTES} bytes\n` : '');
      },
    },
    apply: {
      summary:
        'Validate the staged file (no separate validate needed) and replace the unsaved browser dashboard with its spec (APPLY_SPEC). Refuses when the browser state changed since the file was read, unless --force, and when the edit drops panels, queries, transformations, or variables, unless --allow-removals. Nothing is saved; the user saves in Grafana.',
      usage: 'live apply [--force] [--allow-removals]',
      effect: 'remote-write',
      options: {
        force: { type: 'boolean', description: 'Apply even if the browser dashboard changed since the file was read.' },
        'allow-removals': {
          type: 'boolean',
          description: 'Apply even though the edit removes panels, queries, transformations, or variables.',
        },
      },
      async run(parsed, ctx) {
        const live = requireLive(ctx);
        const staged = stagedDocument(ctx);
        if (!staged) {
          return fail(`live apply: no staged changes; edit ${LIVE_DASHBOARD_PATH} first`);
        }
        let document: Record<string, any>;
        try {
          document = JSON.parse(staged.content);
        } catch (error) {
          return fail(
            `live apply: ${LIVE_DASHBOARD_PATH}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        if (!document || typeof document.spec !== 'object' || document.spec === null || Array.isArray(document.spec)) {
          return fail(`live apply: ${LIVE_DASHBOARD_PATH} must be a dashboard resource with a v2 "spec" object`);
        }
        const current = await live.get(ctx.signal);
        const uid = document.metadata?.name;
        if (typeof uid === 'string' && uid && current.uid && uid !== current.uid) {
          return fail(
            `live apply: the staged file belongs to dashboard ${uid}, but ${current.uid} is open now. Run \`live discard\` and read the file again.`
          );
        }
        if (staged.revision && staged.revision !== current.revision && parsed.options.force !== true) {
          return fail(
            'live apply: the dashboard changed in the browser since the file was read (revision mismatch). Run `live diff` to compare, then `live discard` and redo the edit, or apply anyway with --force.'
          );
        }
        // The spec replaces the whole browser state, so an array assignment where an append was meant loses user work.
        const removed = describeDashboardRemovals({ spec: current.spec }, document);
        if (removed.length > 0 && parsed.options['allow-removals'] !== true) {
          return fail(
            `live apply: the edit removes content from the open dashboard:\n  ${removed.join('\n  ')}\nIf the user asked for these removals, run \`live apply --allow-removals\`; otherwise restore them in ${LIVE_DASHBOARD_PATH} (append to arrays instead of replacing them) and apply again.`
          );
        }
        // metadata.resourceVersion is the live revision used above, not a Grafana resource version.
        const { resourceVersion: _revision, ...metadata } = document.metadata ?? {};
        const report = await validateDashboardDocument(JSON.stringify({ ...document, metadata }), {
          allowedDatasourceUids: ctx.broker.dashboards?.allowedDatasourceUids?.(),
          promql: ctx.broker.promql,
          signal: ctx.signal,
        });
        if (!report.ok) {
          return json(
            { schemaVersion: 1, applied: false, validation: report },
            1,
            'live apply: validation failed; nothing was applied\n'
          );
        }
        await ctx.tx.mkdir('/tmp/live', { recursive: true });
        await ctx.tx.writeFile(LIVE_UNDO_PATH, liveDashboardDocument(current));
        // An explicit remote mutation is a commit boundary. Read commands never commit.
        ctx.tx.checkpoint();
        const result = await live.apply(document.spec, ctx.signal);
        await ctx.tx.rm(LIVE_DASHBOARD_PATH, { force: true });
        ctx.tx.forgetGenerated(LIVE_DASHBOARD_PATH);
        ctx.tx.checkpoint();
        return json({
          schemaVersion: 1,
          applied: true,
          uid: current.uid,
          revision: result.spec ? liveRevision(result.spec) : undefined,
          ...(removed.length > 0 ? { removed } : {}),
          warnings: [...report.warnings.map((warning) => warning.message), ...result.warnings],
          undo: 'live undo',
          note: 'Applied to the unsaved dashboard in the browser; the user saves it in Grafana. Element names may be rekeyed; read the file again before further edits.',
        });
      },
    },
    undo: {
      summary: `Stage the browser state from before the last \`live apply\` in ${LIVE_DASHBOARD_PATH}; \`live apply\` then restores it.`,
      usage: 'live undo',
      effect: 'local-stage',
      async run(_parsed, ctx) {
        const live = requireLive(ctx);
        if (!(await ctx.tx.exists(LIVE_UNDO_PATH))) {
          return fail(
            'live undo: nothing to undo in this page session; the user can discard the unsaved changes in Grafana instead'
          );
        }
        const before = JSON.parse(await ctx.tx.readFile(LIVE_UNDO_PATH));
        const current = await live.get(ctx.signal);
        if (before?.metadata?.name && current.uid && before.metadata.name !== current.uid) {
          return fail(
            `live undo: the saved state belongs to dashboard ${before.metadata.name}, but ${current.uid} is open now`
          );
        }
        const removed = describeDashboardRemovals({ spec: current.spec }, before);
        // Stage against the current revision so the restoring apply is not a conflict.
        const staged = { ...before, metadata: { ...before.metadata, resourceVersion: current.revision } };
        await ctx.tx.writeFile(LIVE_DASHBOARD_PATH, `${JSON.stringify(staged, null, 2)}\n`);
        return json({
          schemaVersion: 1,
          staged: true,
          ...(removed.length > 0 ? { removes: removed } : {}),
          next: removed.length > 0 ? 'live diff, then live apply --allow-removals' : 'live diff, then live apply',
        });
      },
    },
    discard: {
      summary: `Drop local edits of ${LIVE_DASHBOARD_PATH}; the next read shows the current browser state.`,
      usage: 'live discard',
      effect: 'local-stage',
      async run(_parsed, ctx) {
        const discarded = Boolean(stagedDocument(ctx));
        await ctx.tx.rm(LIVE_DASHBOARD_PATH, { force: true });
        return json({ schemaVersion: 1, discarded });
      },
    },
  },
};

/** The staged overlay of the live file (from this invocation or committed earlier), if any. */
function stagedDocument(ctx: WorkspaceCommandContext) {
  const content = ctx.tx.stagedFile(LIVE_DASHBOARD_PATH);
  if (content === undefined) {
    return undefined;
  }
  let revision: string | undefined;
  try {
    const value = JSON.parse(content)?.metadata?.resourceVersion;
    revision = typeof value === 'string' && value ? value : undefined;
  } catch {
    revision = undefined;
  }
  return { content, revision };
}

function requireLive(ctx: WorkspaceCommandContext) {
  const live = ctx.broker.live;
  if (!live?.available()) {
    throw new Error(
      'no editable dashboard is open in the browser (live editing needs the sidebar variant with Grafana 13.2+ on a dashboard page)'
    );
  }
  return live;
}
