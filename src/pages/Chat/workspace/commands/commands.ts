import { createTwoFilesPatch } from 'diff';
import {
  fixDashboardLayout,
  inspectDashboard,
  validateDashboardDocument,
  type DashboardValidationReport,
} from '../dashboardModel';
import { jsonnetCommand } from './jsonnet';
import { normalizeWorkspacePath, truncateUtf8 } from '../paths';
import { PlanError, applyWorkspacePlan, createWorkspacePlan } from '../plans';
import { DASHBOARDS_ROOT, isBaseLoaded } from '../workspace';
import {
  fail,
  json,
  listOption,
  numberOption,
  ok,
  stringOption,
  UsageError,
  type ParsedArgs,
  type WorkspaceCommandContext,
  type WorkspaceCommandSpec,
} from './registry';

const MAX_FETCH_PER_CALL = 20;
const MAX_DIFF_BYTES = 60_000;

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
  },
};

export const grafanaDashboardCommand: WorkspaceCommandSpec = {
  name: 'grafana-dashboard',
  summary: 'Inspect and validate dashboard working copies.',
  subcommands: {
    inspect: {
      summary: 'Summarize panels, queries, variables, and datasources of a dashboard file.',
      usage: 'grafana-dashboard inspect PATH',
      effect: 'local-read',
      examples: ['grafana-dashboard inspect /grafana/dashboards/checkout/dashboard.json'],
      async run(parsed, ctx) {
        const path = requirePath(parsed, ctx);
        const content = await ctx.tx.readFile(path);
        let resource: unknown;
        try {
          resource = JSON.parse(content);
        } catch (error) {
          return fail(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        return json({ path, ...inspectDashboard(resource) });
      },
    },
    fix: {
      summary:
        'Explicitly repair classic panel layout: assign missing/duplicate panel ids, complete and clamp gridPos, move overlapping panels. Review with `workspace diff`.',
      usage: 'grafana-dashboard fix PATH',
      effect: 'local-stage',
      async run(parsed, ctx) {
        const path = requirePath(parsed, ctx);
        const content = await ctx.tx.readFile(path);
        let resource: unknown;
        try {
          resource = JSON.parse(content);
        } catch (error) {
          return fail(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        const report = fixDashboardLayout(resource);
        if (report.changed) {
          await ctx.tx.writeFile(path, `${JSON.stringify(resource, null, 2)}\n`);
        }
        return json({ schemaVersion: 1, path, ...report });
      },
    },
    validate: {
      summary: 'Validate JSON, resource envelope, structure, PromQL syntax, and datasource policy. Exit 1 on errors.',
      usage: 'grafana-dashboard validate PATH...',
      effect: 'local-read',
      async run(parsed, ctx) {
        if (parsed.positionals.length === 0) {
          throw new UsageError('at least one PATH is required');
        }
        const reports = [];
        for (const raw of parsed.positionals) {
          const path = normalizeWorkspacePath(raw, ctx.cwd);
          const target = ctx.workspace.classify(path);
          const uid = target.type === 'resource' ? target.uid : undefined;
          const content = await ctx.tx.readFile(path);
          const report = validateDashboardDocument(content, {
            expectedUid: uid,
            allowedDatasourceUids: ctx.broker.dashboards?.allowedDatasourceUids?.(),
            managedBy: uid ? ctx.workspace.getResource(uid)?.base?.meta.managedBy : undefined,
          });
          await checkFolder(content, report, ctx);
          reports.push({ path, ...report });
        }
        const okAll = reports.every((report) => report.ok);
        return json(reports.length === 1 ? reports[0] : { schemaVersion: 1, ok: okAll, reports }, okAll ? 0 : 1);
      },
    },
  },
};

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
      usage: 'grafana-prom metrics [REGEX] [--ds UID] [--limit N]',
      effect: 'remote-read',
      options: {
        ds: { type: 'string', description: 'Prometheus datasource UID (default: first allowed).' },
        limit: { type: 'number', description: 'Maximum names to print, 1-5000.', default: 500 },
      },
      examples: ['grafana-prom metrics "^http_"', 'grafana-prom metrics | rg -c .'],
      async run(parsed, ctx) {
        const limit = numberOption(parsed, 'limit', 500, 1, 5000);
        const pattern = parsed.positionals[0];
        const regex = pattern ? safeRegex(pattern) : undefined;
        const result = await requireProm(ctx).metricNames(stringOption(parsed, 'ds'), ctx.signal);
        const names = regex ? result.names.filter((name) => regex.test(name)) : result.names;
        const shown = names.slice(0, limit);
        const stderr =
          names.length > shown.length
            ? `# ${names.length - shown.length} more metrics omitted (--limit ${limit})\n`
            : '';
        return ok(shown.length ? `${shown.join('\n')}\n` : '', stderr);
      },
    },
    labels: {
      summary: 'List label names (no LABEL) or the values of LABEL, optionally restricted by a series selector.',
      usage: 'grafana-prom labels [LABEL] [--match SELECTOR] [--ds UID] [--limit N]',
      effect: 'remote-read',
      options: {
        match: { type: 'string', description: 'Series selector such as up{job="api"}.' },
        ds: { type: 'string', description: 'Prometheus datasource UID.' },
        limit: { type: 'number', description: 'Maximum values to print.', default: 500 },
      },
      async run(parsed, ctx) {
        const label = parsed.positionals[0];
        const limit = numberOption(parsed, 'limit', 500, 1, 5000);
        if (!label) {
          const names = await requireProm(ctx).labelNames(
            stringOption(parsed, 'ds'),
            stringOption(parsed, 'match'),
            ctx.signal
          );
          return ok(names.names.slice(0, limit).join('\n') + (names.names.length ? '\n' : ''));
        }
        const result = await requireProm(ctx).labelValues(
          stringOption(parsed, 'ds'),
          label,
          stringOption(parsed, 'match'),
          ctx.signal
        );
        const shown = result.values.slice(0, limit);
        const stderr =
          result.values.length > shown.length ? `# ${result.values.length - shown.length} more values omitted\n` : '';
        return ok(shown.length ? `${shown.join('\n')}\n` : '', stderr);
      },
    },
    series: {
      summary: 'List label sets of series matching a selector (NDJSON).',
      usage: 'grafana-prom series SELECTOR [--ds UID] [--limit N]',
      effect: 'remote-read',
      options: {
        ds: { type: 'string', description: 'Prometheus datasource UID.' },
        limit: { type: 'number', description: 'Maximum series, 1-500.', default: 50 },
      },
      async run(parsed, ctx) {
        const match = parsed.positionals.join(' ').trim();
        if (!match) {
          throw new UsageError('SELECTOR is required');
        }
        const limit = numberOption(parsed, 'limit', 50, 1, 500);
        const result = await requireProm(ctx).series(stringOption(parsed, 'ds'), match, limit, ctx.signal);
        const stderr = result.truncated ? `# more than ${limit} series matched; narrow the selector\n` : '';
        return ok(
          result.series.map((series) => JSON.stringify(series)).join('\n') + (result.series.length ? '\n' : ''),
          stderr
        );
      },
    },
    query: {
      summary:
        'Run PromQL and print compact min/max/last summaries (never raw frames). Repeat -e to validate several expressions in one call.',
      usage: 'grafana-prom query EXPR | -e EXPR [-e EXPR]... [--range] [--from now-1h] [--to now] [--ds UID]',
      effect: 'remote-read',
      options: {
        expr: { type: 'string[]', alias: 'e', description: 'PromQL expression (repeatable, max 10).' },
        range: { type: 'boolean', description: 'Run a range query instead of an instant query.' },
        from: { type: 'string', description: 'Range start (implies --range).' },
        to: { type: 'string', description: 'Range end (implies --range).' },
        ds: { type: 'string', description: 'Prometheus datasource UID.' },
      },
      examples: [
        "grafana-prom query 'sum(rate(http_requests_total[5m])) by (service)' --from now-6h",
        "grafana-prom query -e 'up' -e 'sum(rate(http_requests_total[5m]))' --from now-1h | jq '.results[] | {query, totalSeries, validationError}'",
      ],
      async run(parsed, ctx) {
        const expressions = listOption(parsed, 'expr');
        const positional = parsed.positionals.join(' ').trim();
        if (positional) {
          expressions.unshift(positional);
        }
        if (expressions.length === 0) {
          throw new UsageError('EXPR is required');
        }
        if (expressions.length > 10) {
          throw new UsageError('at most 10 expressions per call');
        }
        const from = stringOption(parsed, 'from');
        const to = stringOption(parsed, 'to');
        const type = parsed.options.range === true || from || to ? 'range' : 'instant';
        const summaries = [];
        for (const query of expressions) {
          const summary = await requireProm(ctx).query(
            stringOption(parsed, 'ds'),
            {
              query,
              type,
              start: from ?? (type === 'range' ? 'now-1h' : undefined),
              end: to ?? (type === 'range' ? 'now' : undefined),
            },
            ctx.signal
          );
          const artifact = ctx.artifacts?.register({
            kind: 'json',
            title: `PromQL: ${query.slice(0, 80)}`,
            toolName: 'grafana-prom query',
            data: summary,
            summary: `${type} query, ${String(summary.totalSeries ?? 0)} series`,
          });
          summaries.push(artifact ? { ...summary, artifact: `/artifacts/${artifact.id}.json` } : summary);
        }
        const failed = summaries.filter((summary) => typeof summary.validationError === 'string').length;
        if (summaries.length === 1) {
          return json(summaries[0], failed ? 1 : 0);
        }
        return json({ schemaVersion: 1, queryType: type, failed, results: summaries }, failed ? 1 : 0);
      },
    },
  },
};

export const workspaceCommand: WorkspaceCommandSpec = {
  name: 'workspace',
  summary: 'Inspect local changes and move resource changes through plan -> approval -> apply.',
  subcommands: {
    status: {
      summary: 'List staged resource changes, usage, limits, and pending plans.',
      usage: 'workspace status',
      effect: 'local-read',
      async run(_parsed, ctx) {
        ctx.tx.checkpoint();
        const workspace = ctx.workspace;
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
          plans: workspace
            .listPlans()
            .map((plan) => ({ id: plan.id, createdAt: plan.createdAt, operations: plan.operations.length })),
          note: 'Scratch files under /workspace, /session and /tmp are never applied to Grafana.',
        });
      },
    },
    diff: {
      summary: 'Unified diff of staged resource changes against their fetched base.',
      usage: 'workspace diff [PATH...]',
      effect: 'local-read',
      async run(parsed, ctx) {
        ctx.tx.checkpoint();
        const selected = new Set(parsed.positionals.map((path) => normalizeWorkspacePath(path, ctx.cwd)));
        const patches: string[] = [];
        for (const entry of ctx.workspace.resourceEntries()) {
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
        ctx.tx.checkpoint();
        if (parsed.positionals.length === 0) {
          throw new UsageError('at least one PATH is required');
        }
        const discarded: string[] = [];
        for (const raw of parsed.positionals) {
          if (ctx.workspace.discard(normalizeWorkspacePath(raw, ctx.cwd))) {
            discarded.push(normalizeWorkspacePath(raw, ctx.cwd));
          }
        }
        return json({ schemaVersion: 1, discarded });
      },
    },
    plan: {
      summary: 'Validate staged resource changes and freeze them into an immutable, reviewable plan.',
      usage: 'workspace plan [--path PATH]...',
      effect: 'local-read',
      options: {
        path: { type: 'string[]', description: 'Limit the plan to these resource paths (repeatable).' },
      },
      async run(parsed, ctx) {
        ctx.tx.checkpoint();
        try {
          const plan = createWorkspacePlan(ctx.workspace, {
            paths: listOption(parsed, 'path').map((path) => normalizeWorkspacePath(path, ctx.cwd)),
            allowedDatasourceUids: ctx.broker.dashboards?.allowedDatasourceUids?.(),
          });
          return json({
            schemaVersion: 1,
            planId: plan.id,
            digest: plan.digest,
            operations: plan.operations.map((operation) => ({
              operation: operation.operation,
              uid: operation.uid,
              title: operation.title,
              path: operation.path,
              baseResourceVersion: operation.baseResourceVersion,
              warnings: operation.validation.warnings,
            })),
            next: `workspace apply ${plan.id}`,
            note: 'If the user asked to create, save, update, or apply, run the apply command now: it shows the user the diff and asks for approval, so do not ask for a separate confirmation in chat. Editing any planned file invalidates the plan.',
          });
        } catch (error) {
          if (error instanceof PlanError) {
            return fail(`workspace plan: ${error.message}`);
          }
          throw error;
        }
      },
    },
    apply: {
      summary: 'Request user approval for a plan, then write it to Grafana with revision preconditions.',
      usage: 'workspace apply PLAN_ID',
      effect: 'remote-write',
      async run(parsed, ctx) {
        ctx.tx.checkpoint();
        const planId = parsed.positionals[0];
        if (!planId) {
          throw new UsageError('PLAN_ID is required');
        }
        try {
          const record = await applyWorkspacePlan(ctx.workspace, planId, {
            broker: ctx.broker,
            approvals: ctx.approvals,
            signal: ctx.signal,
          });
          const allApplied = record.results.every((result) => result.outcome === 'applied');
          return json({ schemaVersion: 1, ...record }, allApplied ? 0 : 1);
        } catch (error) {
          if (error instanceof PlanError) {
            return fail(`workspace apply: ${error.message}`);
          }
          throw error;
        }
      },
    },
    plans: {
      summary: 'List plans, or print one plan with its diff.',
      usage: 'workspace plans [PLAN_ID]',
      effect: 'local-read',
      async run(parsed, ctx) {
        ctx.tx.checkpoint();
        const id = parsed.positionals[0];
        if (id) {
          const plan = ctx.workspace.getPlan(id);
          if (!plan) {
            return fail(`workspace plans: unknown plan ${id}`);
          }
          const { documents: _documents, ...rest } = plan;
          return json({ schemaVersion: 1, ...rest });
        }
        return json({
          schemaVersion: 1,
          plans: ctx.workspace.listPlans().map((plan) => ({
            id: plan.id,
            createdAt: plan.createdAt,
            operations: plan.operations.map((operation) => `${operation.operation} ${operation.uid}`),
          })),
          applied: ctx.workspace.applyJournal().map((record) => ({
            planId: record.planId,
            approved: record.approved,
            finishedAt: record.finishedAt,
            outcomes: record.results.map((result) => `${result.uid}: ${result.outcome}`),
          })),
        });
      },
    },
  },
};

export const WORKSPACE_COMMANDS: readonly WorkspaceCommandSpec[] = [
  grafanaCommand,
  grafanaDashboardCommand,
  grafanaPromCommand,
  jsonnetCommand,
  workspaceCommand,
];

/** Reports a folder annotation that points at a folder the user cannot see (the write would fail). */
async function checkFolder(content: string, report: DashboardValidationReport, ctx: WorkspaceCommandContext) {
  let folder: unknown;
  try {
    folder = JSON.parse(content)?.metadata?.annotations?.['grafana.app/folder'];
  } catch {
    return;
  }
  if (typeof folder !== 'string' || !folder || !ctx.broker.dashboards?.folderExists) {
    return;
  }
  if (!(await ctx.broker.dashboards.folderExists(folder, ctx.signal))) {
    report.errors.push({
      level: 'policy',
      path: '.metadata.annotations["grafana.app/folder"]',
      message: `folder ${JSON.stringify(folder)} does not exist or is not visible; remove the annotation to use the General folder`,
    });
    report.levels.policy = 'failed';
    report.ok = false;
  }
}

function requireDashboards(ctx: WorkspaceCommandContext) {
  if (!ctx.broker.dashboards) {
    throw new Error('dashboard access is not available in this session');
  }
  return ctx.broker.dashboards;
}

function requireProm(ctx: WorkspaceCommandContext) {
  if (!ctx.broker.prometheus) {
    throw new Error('Prometheus access is not available in this session');
  }
  return ctx.broker.prometheus;
}

function requirePath(parsed: ParsedArgs, ctx: WorkspaceCommandContext) {
  const raw = parsed.positionals[0];
  if (!raw) {
    throw new UsageError('PATH is required');
  }
  try {
    return normalizeWorkspacePath(raw, ctx.cwd);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function safeRegex(pattern: string) {
  try {
    return new RegExp(pattern);
  } catch {
    throw new UsageError(`invalid regular expression ${JSON.stringify(pattern)}`);
  }
}

function uniq(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
