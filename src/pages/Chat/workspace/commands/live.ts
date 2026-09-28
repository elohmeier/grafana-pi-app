import { createTwoFilesPatch } from 'diff';
import { validateDashboardDocument } from '../dashboardModel';
import { LIVE_DASHBOARD_PATH, liveDashboardDocument, liveRevision } from '../liveDashboard';
import { truncateUtf8 } from '../paths';
import { fail, json, ok, type WorkspaceCommandContext, type WorkspaceCommandSpec } from './registry';

const MAX_DIFF_BYTES = 60_000;

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
        'Validate the staged file (no separate validate needed) and replace the unsaved browser dashboard with its spec (APPLY_SPEC). Refuses when the browser state changed since the file was read, unless --force. Nothing is saved; the user saves in Grafana.',
      usage: 'live apply [--force]',
      effect: 'remote-write',
      options: {
        force: { type: 'boolean', description: 'Apply even if the browser dashboard changed since the file was read.' },
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
          warnings: [...report.warnings.map((warning) => warning.message), ...result.warnings],
          note: 'Applied to the unsaved dashboard in the browser; the user saves it in Grafana. Element names may be rekeyed; read the file again before further edits.',
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
