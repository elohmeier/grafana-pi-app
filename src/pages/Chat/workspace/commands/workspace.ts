import { createTwoFilesPatch } from 'diff';
import { normalizeWorkspacePath, truncateUtf8 } from '../paths';
import { ApplyError, applyWorkspaceChanges } from '../apply';
import { fail, json, listOption, ok, UsageError, type WorkspaceCommandSpec } from './registry';

const MAX_DIFF_BYTES = 60_000;

export const workspaceCommand: WorkspaceCommandSpec = {
  name: 'workspace',
  summary: 'Inspect local changes and validate and apply resource changes with diff approval.',
  subcommands: {
    status: {
      summary: 'List staged resource changes, usage and limits.',
      usage: 'workspace status',
      effect: 'local-read',
      async run(_parsed, ctx) {
        const workspace = ctx.tx.view();
        return json({
          schemaVersion: 1,
          changes: workspace.status(),
          hydrated: workspace
            .resourceEntries()
            .filter((entry) => entry.base)
            .map((entry) => ({
              uid: entry.uid,
              title: entry.base?.meta.title,
              resourceVersion: entry.base?.meta.resourceVersion,
            })),
          usage: workspace.usage(),
          limits: workspace.limits,
          note: 'Scratch files under /workspace, /session and /tmp are never applied to Grafana.',
        });
      },
    },
    diff: {
      summary: 'Unified diff of staged resource changes against their fetched base.',
      usage: 'workspace diff [PATH...]',
      effect: 'local-read',
      async run(parsed, ctx) {
        const selected = new Set(parsed.positionals.map((path) => normalizeWorkspacePath(path, ctx.cwd)));
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
      summary: 'Validate staged changes, request approval of the complete diff, and save with revision preconditions.',
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
          return json(
            { schemaVersion: 1, ...receipt, diffPath: `/session/receipts/${record.applyId}.diff` },
            record.results.every((r) => r.outcome === 'applied') ? 0 : 1
          );
        } catch (error) {
          if (error instanceof ApplyError) {
            return fail(`workspace apply: ${error.message}`);
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
