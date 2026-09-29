import { createTwoFilesPatch } from 'diff';
import { normalizeWorkspacePath, truncateUtf8 } from '../paths';
import { ApplyError, applyWorkspaceChanges, stageRevert } from '../apply';
import { groupChanges } from '../changeGroups';
import { fail, json, listOption, ok, UsageError, type WorkspaceCommandSpec } from './registry';

const MAX_DIFF_BYTES = 60_000;

export const workspaceCommand: WorkspaceCommandSpec = {
  name: 'workspace',
  summary: 'Inspect local changes and validate and apply resource changes with diff approval.',
  subcommands: {
    status: {
      summary: 'List staged resource changes and usage.',
      usage: 'workspace status',
      effect: 'local-read',
      async run(_parsed, ctx) {
        const workspace = ctx.tx.view();
        return json({
          schemaVersion: 1,
          changes: workspace.status(),
          usage: workspace.usage(),
          limits: workspace.limits,
          note: 'Scratch files under /workspace, /session and /tmp are never applied to Grafana.',
        });
      },
    },
    diff: {
      summary:
        'Unified diff of staged resource changes against their fetched base; --stat summarizes changed lines per dashboard and repeated replacements.',
      usage: 'workspace diff [--stat] [PATH...]',
      effect: 'local-read',
      options: {
        stat: {
          type: 'boolean',
          description:
            'Per-dashboard line counts and the replacements repeated across dashboards, instead of the diff.',
        },
      },
      async run(parsed, ctx) {
        const selected = new Set(parsed.positionals.map((path) => normalizeWorkspacePath(path, ctx.cwd)));
        if (parsed.options.stat === true) {
          const entries = ctx.tx
            .view()
            .resourceEntries()
            .filter(
              (entry) =>
                entry.overlay &&
                (selected.size === 0 ||
                  selected.has(entry.path) ||
                  selected.has(entry.path.replace(/\/dashboard\.json$/, '')))
            );
          const inputs = entries.map((entry) => ({
            path: entry.path,
            before: entry.base?.content ?? '',
            after: entry.overlay?.content ?? '',
          }));
          const { groups, ungroupedChanges } = groupChanges(inputs);
          return json({
            schemaVersion: 1,
            dashboards: entries.map((entry) => {
              const patch = createTwoFilesPatch(
                entry.path,
                entry.path,
                entry.base?.content ?? '',
                entry.overlay?.content ?? ''
              );
              const lines = patch.split('\n');
              return {
                path: entry.path,
                title: entry.base?.meta.title,
                change: entry.overlay?.content === null ? 'deleted' : entry.base ? 'modified' : 'created',
                additions: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
                deletions: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
              };
            }),
            groups: groups.map((group) => ({
              before: group.before,
              after: group.after,
              count: group.count,
              dashboards: group.paths.length,
              example: group.example,
            })),
            ungroupedChanges,
          });
        }
        const patches: string[] = [];
        for (const entry of ctx.tx.view().resourceEntries()) {
          if (!entry.overlay) {
            continue;
          }
          if (
            selected.size > 0 &&
            !selected.has(entry.path) &&
            !selected.has(entry.path.replace(/\/dashboard\.json$/, ''))
          ) {
            continue;
          }
          const before = entry.base?.content ?? '';
          const after = entry.overlay.content ?? '';
          patches.push(
            createTwoFilesPatch(
              entry.base ? `a${entry.path}` : '/dev/null',
              entry.overlay.content !== null ? `b${entry.path}` : '/dev/null',
              before,
              after,
              undefined,
              undefined,
              { context: 3 }
            )
          );
        }
        const limited = truncateUtf8(patches.join('\n'), MAX_DIFF_BYTES);
        return ok(
          limited.text,
          limited.truncated ? `# diff truncated at ${MAX_DIFF_BYTES} bytes; pass PATH to narrow\n` : ''
        );
      },
    },
    discard: {
      summary: 'Drop local changes of resource working copies (restores the fetched base).',
      usage: 'workspace discard PATH...',
      effect: 'local-stage',
      async run(parsed, ctx) {
        if (parsed.positionals.length === 0) {
          throw new UsageError('at least one PATH is required');
        }
        const discarded: string[] = [];
        for (const raw of parsed.positionals) {
          if (await ctx.tx.discardResource(normalizeWorkspacePath(raw, ctx.cwd))) {
            discarded.push(normalizeWorkspacePath(raw, ctx.cwd));
          }
        }
        return json({ schemaVersion: 1, discarded });
      },
    },
    apply: {
      summary:
        'Validate staged changes, open the change-set review (the user can uncheck dashboards), and save the approved ones in parallel with revision preconditions.',
      usage: 'workspace apply [--path PATH]...',
      effect: 'remote-write',
      options: {
        path: { type: 'string[]', description: 'Only apply these resource paths (repeatable).' },
      },
      async run(parsed, ctx) {
        if (parsed.positionals.length) {
          throw new UsageError('apply takes no ID; use --path PATH to select changes');
        }
        // Only explicit apply commits earlier writes in the current invocation.
        ctx.tx.checkpoint();
        if (ctx.workspace.status().length === 0 && !listOption(parsed, 'path').length) {
          return json({ schemaVersion: 1, results: [], note: 'No staged resource changes.' });
        }
        try {
          const record = await applyWorkspaceChanges(ctx.workspace, {
            broker: ctx.broker,
            approvals: ctx.approvals,
            signal: ctx.signal,
            paths: listOption(parsed, 'path').map((path) => normalizeWorkspacePath(path, ctx.cwd)),
          });
          const { diff: _diff, ...receipt } = record;
          const counts: Record<string, number> = {};
          record.results.forEach((result) => (counts[result.outcome] = (counts[result.outcome] ?? 0) + 1));
          // Long receipts list only the dashboards that were not applied; the full receipt is a file.
          const results =
            record.results.length > 50
              ? record.results.filter((result) => result.outcome !== 'applied')
              : record.results;
          return json(
            {
              schemaVersion: 1,
              ...receipt,
              counts,
              results,
              ...(results.length < record.results.length
                ? { resultsPath: `/session/receipts/${record.applyId}.json` }
                : {}),
              diffPath: `/session/receipts/${record.applyId}.diff`,
              ...(counts.declined
                ? { note: 'Declined dashboards were unchecked in the review; their working copies keep the change.' }
                : {}),
            },
            record.results.every((r) => r.outcome === 'applied' || r.outcome === 'declined') ? 0 : 1
          );
        } catch (error) {
          if (error instanceof ApplyError) {
            return fail(`workspace apply: ${error.message}`);
          }
          throw error;
        }
      },
    },
    revert: {
      summary:
        'Stage the dashboards of an earlier apply as they were before it (previous versions from Grafana history); review and save them with workspace apply.',
      usage: 'workspace revert APPLY_ID [--path PATH]...',
      effect: 'local-stage',
      options: {
        path: { type: 'string[]', description: 'Only revert these dashboards of the apply (repeatable).' },
      },
      examples: ['workspace revert apply-3f2a9c1b0d4e && workspace apply'],
      async run(parsed, ctx) {
        const applyId = parsed.positionals[0];
        if (!applyId) {
          throw new UsageError('APPLY_ID is required; see workspace receipts');
        }
        const view = ctx.tx.view();
        try {
          const result = await stageRevert(ctx.workspace, {
            broker: ctx.broker,
            applyId,
            paths: listOption(parsed, 'path').map((path) => normalizeWorkspacePath(path, ctx.cwd)),
            signal: ctx.signal,
            write: (path, content) => (content === null ? ctx.tx.rm(path) : ctx.tx.writeFile(path, content)),
            hasLocalChanges: (uid) => {
              const entry = view.getResource(uid);
              return Boolean(entry?.overlay && entry.overlay.content !== entry.base?.content);
            },
          });
          return json(
            {
              schemaVersion: 1,
              ...result,
              next: result.staged.length
                ? 'review with `workspace diff --stat`, then save with `workspace apply`'
                : undefined,
            },
            result.staged.length === 0 ? 1 : 0
          );
        } catch (error) {
          if (error instanceof ApplyError) {
            return fail(`workspace revert: ${error.message}`);
          }
          throw error;
        }
      },
    },
    receipts: {
      summary: 'Print the outcome journal of dashboard saves.',
      usage: 'workspace receipts',
      effect: 'local-read',
      async run(_parsed, ctx) {
        return json({
          schemaVersion: 1,
          applied: ctx.workspace.applyJournal().map(({ diff: _diff, ...receipt }) => receipt),
        });
      },
    },
  },
};
