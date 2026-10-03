import {
  fixDashboardLayout,
  inspectDashboard,
  validateDashboardDocument,
  type DashboardPanelInfo,
  type DashboardValidationReport,
} from '../dashboardModel';
import { collectDashboardData } from '../dashboardData';
import { applyDashboardLabelFilter } from '../dashboardLabelFilter';
import { addPanel, setPanel, type PanelEditReport, type PanelQueryInput } from '../dashboardPanelEdit';
import { LIVE_DASHBOARD_PATH } from '../liveDashboard';
import { DashboardWalkError } from '../dashboardPanels';
import { listDashboardQueries } from '../dashboardQueries';
import { checkScreenshot } from '../screenshotGuard';
import { DASHBOARDS_ROOT, HYDRATION_CONCURRENCY } from '../workspace';
import { dashboardUid } from './alerts';
import { normalizeWorkspacePath } from '../paths';
import {
  fail,
  json,
  listOption,
  numberOption,
  stringOption,
  UsageError,
  type OptionSpec,
  type ParsedArgs,
  type WorkspaceCommandContext,
  type WorkspaceCommandSpec,
} from './registry';

const PANEL_CONTENT_OPTIONS: Record<string, OptionSpec> = {
  title: { type: 'string', description: 'Panel title.' },
  description: { type: 'string', description: 'Panel description.' },
  type: { type: 'string', description: 'Visualization: timeseries, stat, gauge, table, bargauge, barchart, ...' },
  unit: { type: 'string', description: 'Unit such as reqps, s, percentunit, bytes.' },
  expr: { type: 'string[]', alias: 'e', description: 'PromQL expression (repeatable; refIds A, B, ...).' },
  legend: { type: 'string[]', description: 'Legend format for the matching --expr (repeatable).' },
  ds: { type: 'string', description: 'Prometheus datasource UID (default: the one the dashboard uses).' },
  x: { type: 'number', description: 'Grid column, 0-23.' },
  y: { type: 'number', description: 'Grid row.' },
  w: { type: 'number', description: 'Width in grid columns, 1-24 (default 12 for new panels).' },
  h: { type: 'number', description: 'Height in grid rows (default 8 for new panels).' },
};

export const grafanaDashboardCommand: WorkspaceCommandSpec = {
  name: 'grafana-dashboard',
  summary: 'Inspect and validate dashboard working copies.',
  subcommands: {
    inspect: {
      summary:
        'Summarize a dashboard file: panels (row path, grid position, queries, legend, transformations, unit/thresholds, links), variables with current values, time, and datasources.',
      usage: 'grafana-dashboard inspect PATH [--panel ID]...',
      effect: 'local-read',
      options: {
        panel: { type: 'string[]', description: 'Only these panels: id (classic) or element name (v2); repeatable.' },
      },
      examples: [
        'grafana-dashboard inspect /grafana/dashboards/checkout/dashboard.json',
        "grafana-dashboard inspect /grafana/dashboards/checkout/dashboard.json | jq -c '.panels[] | {id, title, rowPath, queries: [.queries[].expr]}'",
      ],
      async run(parsed, ctx) {
        const path = requirePath(parsed, ctx);
        const content = await ctx.tx.readFile(path);
        let resource: unknown;
        try {
          resource = JSON.parse(content);
        } catch (error) {
          return fail(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        const inspection = inspectDashboard(resource);
        const wanted = listOption(parsed, 'panel');
        if (wanted.length > 0) {
          const matches = (panel: DashboardPanelInfo, id: string) => panel.key === id || String(panel.id) === id;
          const missing = wanted.filter((id) => !inspection.panels.some((panel) => matches(panel, id)));
          if (missing.length > 0) {
            return fail(
              `grafana-dashboard inspect: no panel ${missing.map((id) => JSON.stringify(id)).join(', ')}; available: ${inspection.panels.map((panel) => panel.id ?? panel.key).join(', ')}`
            );
          }
          inspection.panels = inspection.panels.filter((panel) => wanted.some((id) => matches(panel, id)));
        }
        const target = ctx.workspace.classify(path);
        const meta = target.type === 'resource' ? ctx.workspace.getResource(target.uid)?.base?.meta : undefined;
        return json({
          path,
          ...inspection,
          ...(meta
            ? {
                grafana: {
                  url: meta.url,
                  resourceVersion: meta.resourceVersion,
                  ...(meta.managedBy ? { managedBy: meta.managedBy } : {}),
                  ...(meta.conversion ? { conversion: meta.conversion } : {}),
                  fetchedAt: meta.fetchedAt,
                },
              }
            : {}),
        });
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
    'add-panel': {
      summary:
        'Add a Prometheus panel to a dashboard file (working copy or /live/dashboard/dashboard.json) with schema-correct JSON for classic or v2. Placed at the bottom, at the top (--top), next to/below another panel, or at explicit grid coordinates; panels in the way move down (reported as moved). The datasource defaults to the one of the anchor panel; --like also copies its visualization, options, and field config.',
      usage:
        'grafana-dashboard add-panel PATH --title TITLE --expr EXPR [--expr EXPR]... [--legend FMT]... [--type timeseries] [--unit UNIT] [--like ID] [--right-of ID | --below ID | --top | --x X --y Y] [--w 12] [--h 8] [--row TITLE]',
      effect: 'local-stage',
      options: {
        ...PANEL_CONTENT_OPTIONS,
        'right-of': {
          type: 'string',
          description: 'Place to the right of this panel (id or element name), or below it if it does not fit.',
        },
        below: { type: 'string', description: 'Place directly below this panel.' },
        top: { type: 'boolean', description: 'Place at the top of the row or grid; the panels there move down.' },
        like: {
          type: 'string',
          description:
            'Copy visualization type, options, field config (unit, thresholds, legend), and query datasource from this panel; --type/--unit override.',
        },
        row: { type: 'string', description: 'Row or tab title to add the panel to (default: the last one).' },
      },
      examples: [
        "grafana-dashboard add-panel /live/dashboard/dashboard.json --title 'HTTP 5xx rate' --expr 'sum(rate(http_requests_total{status=~\"5..\"}[$__rate_interval]))' --unit reqps --right-of panel-1",
      ],
      async run(parsed, ctx) {
        return editPanelFile(parsed, ctx, (resource) => {
          const title = stringOption(parsed, 'title');
          if (!title) {
            throw new UsageError('--title is required');
          }
          return addPanel(resource, {
            ...panelFields(parsed),
            title,
            queries: panelQueries(parsed),
            rightOf: stringOption(parsed, 'right-of'),
            below: stringOption(parsed, 'below'),
            row: stringOption(parsed, 'row'),
            top: parsed.options.top === true,
            like: stringOption(parsed, 'like'),
          });
        });
      },
    },
    'set-panel': {
      summary:
        'Change a panel in a dashboard file: title, description, visualization type, unit, queries by refId (unknown refIds are added; --ds converts queries of another datasource to PromQL), and grid position or size.',
      usage:
        'grafana-dashboard set-panel PATH --panel ID [--title T] [--type T] [--unit U] [--ds UID] [--expr EXPR [--ref A]]... [--legend FMT]... [--x X] [--y Y] [--w W] [--h H]',
      effect: 'local-stage',
      options: {
        panel: { type: 'string', description: 'Panel id (classic or v2) or v2 element name.' },
        ...PANEL_CONTENT_OPTIONS,
        ref: { type: 'string[]', description: 'refId for the matching --expr (default A, B, ... in order).' },
      },
      examples: [
        "grafana-dashboard set-panel /live/dashboard/dashboard.json --panel panel-1 --title 'HTTP request rate' --x 0 --y 0 --w 12",
      ],
      async run(parsed, ctx) {
        return editPanelFile(parsed, ctx, (resource) => {
          const panel = stringOption(parsed, 'panel');
          if (!panel) {
            throw new UsageError('--panel is required');
          }
          const queries = listOption(parsed, 'expr').length > 0 ? panelQueries(parsed) : undefined;
          return setPanel(resource, {
            panel,
            ...panelFields(parsed),
            ...(queries ? { queries, refIdsImplicit: listOption(parsed, 'ref').length < queries.length } : {}),
          });
        });
      },
    },
    'label-filter': {
      summary:
        'Add a label matcher bound to a dashboard variable to every selected Prometheus query of a dashboard file, in place (PromQL-aware, works for classic and v2). With --variable-query it also adds or updates the query variable.',
      usage:
        'grafana-dashboard label-filter PATH --label LABEL [--var NAME] [--variable-query QUERY] [--panel ID]... [--ref REFID]...',
      effect: 'local-stage',
      options: {
        label: { type: 'string', description: 'Prometheus label to filter on.' },
        var: { type: 'string', description: 'Dashboard variable providing the value (default: the label name).' },
        operator: { type: 'string', description: 'Matcher operator: =~, =, !=, or !~.', default: '=~' },
        existing: {
          type: 'string',
          description: 'Existing matcher for the label: replace, keep, or error.',
          default: 'replace',
        },
        panel: { type: 'string[]', description: 'Only this panel: id (classic) or element name (v2); repeatable.' },
        ref: { type: 'string[]', description: 'Only queries with this refId; repeatable.' },
        'variable-query': {
          type: 'string',
          description: 'Add or update a multi-value Prometheus query variable, e.g. "label_values(up, instance)".',
        },
        'variable-ds': { type: 'string', description: 'Datasource UID for the variable (default: from the queries).' },
        'single-value': { type: 'boolean', description: 'Variable without multi-select and All option.' },
        current: { type: 'string[]', description: 'Selected variable value (repeatable); default All.' },
      },
      examples: [
        "grafana-dashboard label-filter /live/dashboard/dashboard.json --label instance --variable-query 'label_values(up, instance)'",
        'grafana-dashboard label-filter /grafana/dashboards/checkout/dashboard.json --label env --panel 3 --panel 4',
      ],
      async run(parsed, ctx) {
        const path = requirePath(parsed, ctx);
        const label = stringOption(parsed, 'label');
        if (!label) {
          throw new UsageError('--label is required');
        }
        const operator = stringOption(parsed, 'operator') ?? '=~';
        if (!['=~', '=', '!=', '!~'].includes(operator)) {
          throw new UsageError('--operator must be one of =~, =, !=, !~');
        }
        const existing = stringOption(parsed, 'existing') ?? 'replace';
        if (!['replace', 'keep', 'error'].includes(existing)) {
          throw new UsageError('--existing must be replace, keep, or error');
        }
        const content = await ctx.tx.readFile(path);
        let resource: Record<string, any>;
        try {
          resource = JSON.parse(content);
        } catch (error) {
          return fail(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        const singleValue = parsed.options['single-value'] === true;
        const report = applyDashboardLabelFilter(resource, {
          label,
          variable: stringOption(parsed, 'var'),
          operator: operator as '=~',
          existing: existing as 'replace',
          panels: listOption(parsed, 'panel'),
          refIds: listOption(parsed, 'ref'),
          variableQuery: stringOption(parsed, 'variable-query'),
          variableDatasourceUid: stringOption(parsed, 'variable-ds'),
          multi: !singleValue,
          includeAll: !singleValue,
          current: listOption(parsed, 'current'),
        });
        if (report.changed.length > 0 || report.variable) {
          await ctx.tx.writeFile(path, `${JSON.stringify(resource, null, 2)}\n`);
        }
        return json({ schemaVersion: 1, path, ...report });
      },
    },
    queries: {
      summary:
        'List panel and variable queries as NDJSON with the jq path of each query text; every visible dashboard when no PATH is given. The way to find all panels that use a metric, datasource, or pattern before a mass edit.',
      usage: 'grafana-dashboard queries [PATH...] [--metric NAME]... [--match REGEX] [--ds UID] [--variables]',
      effect: 'remote-read',
      options: {
        metric: { type: 'string[]', description: 'Only queries that use this metric name (repeatable).' },
        match: {
          type: 'string',
          description: 'Only queries whose text matches this regular expression (JavaScript syntax).',
        },
        ds: { type: 'string', description: 'Only queries of this datasource UID.' },
        variables: {
          type: 'boolean',
          description: 'Include template variable queries (included when --metric or --match is given).',
        },
      },
      examples: [
        'grafana-dashboard queries --metric http_server_requests_seconds_count > /tmp/q.ndjson; wc -l < /tmp/q.ndjson',
        "grafana-dashboard queries --match '\\[5m\\]' | jq -r '[.path, .jqPath] | @tsv'",
        'grafana-dashboard queries --ds prometheus | jq -r .uid | sort -u | wc -l',
      ],
      async run(parsed, ctx) {
        const metrics = listOption(parsed, 'metric');
        const pattern = stringOption(parsed, 'match');
        const datasource = stringOption(parsed, 'ds');
        let match: RegExp | undefined;
        try {
          match = pattern ? new RegExp(pattern) : undefined;
        } catch (error) {
          throw new UsageError(`--match: ${error instanceof Error ? error.message : String(error)}`);
        }
        const metricPatterns = metrics.map(
          (metric) => new RegExp(`(^|[^A-Za-z0-9_:])${metric.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_:])`)
        );
        const includeVariables = parsed.options.variables === true || metrics.length > 0 || Boolean(match);
        const paths = parsed.positionals.length
          ? parsed.positionals.map((raw) => normalizeWorkspacePath(raw, ctx.cwd))
          : ctx.workspace.indexedUids().map((uid) => `${DASHBOARDS_ROOT}/${uid}/dashboard.json`);
        const uids = paths
          .map((path) => ctx.workspace.classify(path))
          .flatMap((target) => (target.type === 'resource' ? [target.uid] : []));
        await ctx.workspace.prefetch(uids, ctx.signal);
        const lines: string[] = [];
        const errors: string[] = [];
        for (const path of paths) {
          let resource: unknown;
          try {
            resource = JSON.parse(await ctx.tx.readFile(path));
          } catch (error) {
            errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
          const target = ctx.workspace.classify(path);
          const uid = target.type === 'resource' ? target.uid : undefined;
          const title = (resource as { spec?: { title?: unknown } })?.spec?.title;
          for (const query of listDashboardQueries(resource)) {
            if (
              (query.kind === 'variable' && !includeVariables) ||
              (datasource && query.datasource?.uid !== datasource) ||
              (match && !match.test(query.expr)) ||
              (metricPatterns.length && !metricPatterns.some((metric) => metric.test(query.expr)))
            ) {
              continue;
            }
            lines.push(
              JSON.stringify({
                path,
                ...(uid ? { uid } : {}),
                dashboard: typeof title === 'string' ? title : undefined,
                ...query,
              })
            );
          }
        }
        return {
          stdout: lines.length ? `${lines.join('\n')}\n` : '',
          stderr: errors.length ? `${errors.map((error) => `grafana-dashboard queries: ${error}`).join('\n')}\n` : '',
          exitCode: errors.length && !lines.length ? 1 : 0,
        };
      },
    },
    validate: {
      summary:
        'Validate JSON, resource envelope, structure, PromQL syntax (upstream Prometheus parser, saved variable values), and datasource policy. --server also dry-runs the write in Grafana. Exit 1 on errors; for a changed dashboard, errors its fetched version already had are listed as preexistingErrors and do not fail it.',
      usage: 'grafana-dashboard validate PATH... [--server]',
      effect: 'local-read',
      options: {
        server: {
          type: 'boolean',
          description:
            'Also send each document to Grafana as a dry-run update/create (nothing is saved): checks strict decoding, admission, write permission, and whether the dashboard changed since it was fetched.',
        },
      },
      async run(parsed, ctx) {
        if (parsed.positionals.length === 0) {
          throw new UsageError('at least one PATH is required');
        }
        const validateOne = async (raw: string) => {
          const path = normalizeWorkspacePath(raw, ctx.cwd);
          const target = ctx.workspace.classify(path);
          if (target.type === 'resource' && target.kind === 'alertRule') {
            throw new UsageError(`${path} is an alert rule; use grafana-alert validate`);
          }
          const uid = target.type === 'resource' ? target.uid : undefined;
          // Reading first hydrates the resource, so its base revision is known afterwards.
          const content = await ctx.tx.readFile(path);
          const base = uid ? ctx.workspace.getResource(uid)?.base : undefined;
          const options = {
            expectedUid: uid,
            allowedDatasourceUids: ctx.broker.dashboards?.allowedDatasourceUids?.(),
            managedBy: base?.meta.managedBy,
            promql: ctx.broker.promql,
            signal: ctx.signal,
          };
          const report = await validateDashboardDocument(content, options);
          await checkFolder(content, report, ctx);
          if (parsed.options.server === true) {
            await serverDryRun(content, base?.meta.resourceVersion, report, ctx);
          }
          // Like workspace apply, errors the fetched dashboard already had do not fail a changed working copy.
          if (base?.content && base.content !== content && report.errors.length > 0) {
            const key = (error: { level: string; path?: string; message: string }) =>
              `${error.level}|${error.path ?? ''}|${error.message}`;
            const existing = new Set((await validateDashboardDocument(base.content, options)).errors.map(key));
            const preexistingErrors = report.errors.filter((error) => existing.has(key(error)));
            if (preexistingErrors.length > 0) {
              const errors = report.errors.filter((error) => !existing.has(key(error)));
              return { path, ...report, ok: errors.length === 0, errors, preexistingErrors };
            }
          }
          return { path, ...report };
        };
        // Many files validate in parallel; the reports keep the argument order.
        const reports: Array<Awaited<ReturnType<typeof validateOne>>> = new Array(parsed.positionals.length);
        let next = 0;
        const worker = async () => {
          while (next < parsed.positionals.length) {
            const index = next++;
            reports[index] = await validateOne(parsed.positionals[index]);
          }
        };
        await Promise.all(Array.from({ length: Math.min(HYDRATION_CONCURRENCY, parsed.positionals.length) }, worker));
        const okAll = reports.every((report) => report.ok);
        return json(reports.length === 1 ? reports[0] : { schemaVersion: 1, ok: okAll, reports }, okAll ? 0 : 1);
      },
    },
    data: {
      summary:
        'Run panel queries as the current user and apply the panel transformations, overrides, units, and reducers: shows what each panel displays (status ok/empty/error/skipped, reduced series or bounded table rows). Prometheus panels only.',
      usage:
        'grafana-dashboard data PATH [--panel ID]... [--type TYPE]... [--var NAME=VALUE]... [--from now-1h] [--to now]',
      effect: 'remote-read',
      options: {
        panel: { type: 'string[]', description: 'Panel id (classic) or element name (v2); repeatable.' },
        type: { type: 'string[]', description: 'Only panels of this type, e.g. stat or table; repeatable.' },
        var: {
          type: 'string[]',
          description: 'Override a variable; repeat the same NAME to select several values. Default: saved values.',
        },
        from: { type: 'string', description: 'Range start (default: dashboard time).' },
        to: { type: 'string', description: 'Range end (default: dashboard time).' },
        'max-panels': { type: 'number', description: 'Panels to query, 1-30.', default: 10 },
        'max-series': { type: 'number', description: 'Series per panel, 1-200.', default: 10 },
        'max-rows': { type: 'number', description: 'Table rows per frame, 1-200.', default: 10 },
        'include-hidden': { type: 'boolean', description: 'Also run hidden queries.' },
        'include-collapsed': {
          type: 'boolean',
          description: 'Also run panels in collapsed rows (implied by --panel).',
        },
      },
      examples: [
        'grafana-dashboard data /grafana/dashboards/checkout/dashboard.json --panel 3 --from now-30m',
        "grafana-dashboard data /grafana/dashboards/checkout/dashboard.json --var service=api --var service=web | jq '.panels[] | {id, title, status}'",
      ],
      async run(parsed, ctx) {
        const path = requirePath(parsed, ctx);
        const prom = requireProm(ctx);
        if (!prom.queryData) {
          throw new Error('panel data queries are not available in this session');
        }
        const content = await ctx.tx.readFile(path);
        let resource: unknown;
        try {
          resource = JSON.parse(content);
        } catch (error) {
          return fail(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        let report;
        try {
          report = await collectDashboardData(resource, {
            panels: listOption(parsed, 'panel'),
            panelTypes: listOption(parsed, 'type'),
            vars: listOption(parsed, 'var'),
            from: stringOption(parsed, 'from'),
            to: stringOption(parsed, 'to'),
            maxPanels: numberOption(parsed, 'max-panels', 10, 1, 30),
            maxSeries: numberOption(parsed, 'max-series', 10, 1, 200),
            maxRows: numberOption(parsed, 'max-rows', 10, 1, 200),
            includeHiddenTargets: parsed.options['include-hidden'] === true,
            includeCollapsed: parsed.options['include-collapsed'] === true,
            datasources: prom.datasources(),
            query: prom.queryData,
            signal: ctx.signal,
          });
        } catch (error) {
          if (error instanceof DashboardWalkError) {
            return fail(`grafana-dashboard data: ${error.message}`);
          }
          throw error;
        }
        const artifact = ctx.artifacts?.register({
          kind: 'json',
          title: `Panel data: ${report.title}`,
          toolName: 'grafana-dashboard data',
          data: report,
          summary: report.panels.map((panel) => `${panel.title}: ${panel.status}`).join(', '),
        });
        const failed = report.panels.some((panel) => panel.status === 'error');
        const stderr = report.panelsOmitted
          ? `# ${report.panelsOmitted} more panels not queried (--max-panels); select with --panel or --type\n`
          : '';
        return json(
          { path, ...report, ...(artifact ? { artifact: `/artifacts/${artifact.id}.json` } : {}) },
          failed ? 1 : 0,
          stderr
        );
      },
    },
    screenshot: {
      summary:
        'Render the saved dashboard (or one panel) with Grafana image rendering and attach the image to this result. Needs the image renderer.',
      usage:
        'grafana-dashboard screenshot UID|PATH [--panel ID] [--from now-1h] [--to now] [--width 1200] [--height 700]',
      effect: 'remote-read',
      options: {
        panel: { type: 'number', description: 'Render only this panel id.' },
        from: { type: 'string', description: 'Range start.', default: 'now-1h' },
        to: { type: 'string', description: 'Range end.', default: 'now' },
        width: { type: 'number', description: 'Width in pixels, 300-2400.', default: 1200 },
        height: { type: 'number', description: 'Height in pixels, 200-2400.', default: 700 },
        theme: { type: 'string', description: 'dark or light.', default: 'dark' },
      },
      examples: ['grafana-dashboard screenshot checkout --panel 4 --from now-6h'],
      async run(parsed, ctx) {
        const screenshot = ctx.broker.ui?.screenshot;
        if (!screenshot) {
          throw new Error('dashboard rendering is not available in this session');
        }
        const arg = parsed.positionals[0];
        if (!arg) {
          throw new UsageError('UID or PATH is required');
        }
        const uid = dashboardUid(arg);
        const panelId = typeof parsed.options.panel === 'number' ? parsed.options.panel : undefined;
        await checkScreenshotDatasources(uid, panelId, ctx);
        const theme = stringOption(parsed, 'theme') === 'light' ? 'light' : 'dark';
        const image = await screenshot(
          {
            uid,
            panelId,
            from: stringOption(parsed, 'from'),
            to: stringOption(parsed, 'to'),
            width: numberOption(parsed, 'width', 1200, 300, 2400),
            height: numberOption(parsed, 'height', 700, 200, 2400),
            theme,
          },
          ctx.signal
        );
        const title = `Screenshot ${uid}${panelId !== undefined ? ` panel ${panelId}` : ''}`;
        const artifact = ctx.artifacts?.register({
          kind: 'image',
          title,
          toolName: 'grafana-dashboard screenshot',
          data: image.data,
          mimeType: image.mimeType,
          preview: { type: 'image', mimeType: image.mimeType, data: image.data },
          summary: `${image.width}x${image.height} ${image.mimeType}`,
          bytes: Math.floor((image.data.length * 3) / 4),
        });
        return {
          ...json({
            schemaVersion: 1,
            uid,
            ...(panelId !== undefined ? { panelId } : {}),
            width: image.width,
            height: image.height,
            ...(artifact ? { artifact: `/artifacts/${artifact.id}.json` } : {}),
            note: 'The image is attached to this result. It shows the saved dashboard, not local working-copy edits.',
          }),
          images: [{ data: image.data, mimeType: image.mimeType, title }],
        };
      },
    },
  },
};

/** Refuses screenshots that would show data of datasources the assistant may not read (such as log messages). */
async function checkScreenshotDatasources(uid: string, panelId: number | undefined, ctx: WorkspaceCommandContext) {
  const snapshot = await ctx.broker.dashboards?.get(uid, ctx.signal);
  if (!snapshot) {
    throw new Error(`dashboard ${uid} not found; a screenshot is only possible of a saved dashboard`);
  }
  const check = checkScreenshot(JSON.parse(snapshot.content), {
    panelId,
    datasources: ctx.broker.datasources?.() ?? [],
    allowedPrometheusUids: (ctx.broker.prometheus?.datasources() ?? []).map((ds) => ds.uid),
  });
  if (panelId !== undefined && check.refused.length === 0 && check.allowed.length === 0) {
    throw new UsageError(`panel ${panelId} not found in dashboard ${uid}`);
  }
  if (check.refused.length === 0) {
    return;
  }
  const refused = check.refused.map((panel) => `  panel ${panel.id} ${JSON.stringify(panel.title)}: ${panel.reason}`);
  const hint =
    check.allowed.length > 0
      ? `Panels that can be rendered with --panel: ${check.allowed.join(', ')}.`
      : 'No panel of this dashboard can be rendered.';
  throw new Error(
    `refused: the screenshot would show data that is not available to the assistant:\n${refused.join('\n')}\n${hint}`
  );
}

function panelQueries(parsed: ParsedArgs): PanelQueryInput[] {
  const exprs = listOption(parsed, 'expr');
  const legends = listOption(parsed, 'legend');
  const refs = listOption(parsed, 'ref');
  return exprs.map((expr, index) => ({
    refId: refs[index] ?? String.fromCharCode(65 + index),
    expr,
    ...(legends[index] !== undefined ? { legendFormat: legends[index] } : {}),
  }));
}

function panelFields(parsed: ParsedArgs) {
  const number = (name: string) =>
    typeof parsed.options[name] === 'number' ? (parsed.options[name] as number) : undefined;
  return {
    title: stringOption(parsed, 'title'),
    description: stringOption(parsed, 'description'),
    type: stringOption(parsed, 'type'),
    unit: stringOption(parsed, 'unit'),
    datasourceUid: stringOption(parsed, 'ds'),
    x: number('x'),
    y: number('y'),
    w: number('w'),
    h: number('h'),
  };
}

/** Reads a dashboard file, applies one panel edit, and writes it back (local stage only). */
async function editPanelFile(
  parsed: ParsedArgs,
  ctx: WorkspaceCommandContext,
  edit: (resource: Record<string, any>) => PanelEditReport
) {
  const path = requirePath(parsed, ctx);
  const content = await ctx.tx.readFile(path);
  let resource: Record<string, any>;
  try {
    resource = JSON.parse(content);
  } catch (error) {
    return fail(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  let report: PanelEditReport;
  try {
    report = edit(resource);
  } catch (error) {
    if (error instanceof UsageError) {
      throw error;
    }
    return fail(error instanceof Error ? error.message : String(error));
  }
  await ctx.tx.writeFile(path, `${JSON.stringify(resource, null, 2)}\n`);
  const next = path === LIVE_DASHBOARD_PATH ? 'live apply' : 'grafana-dashboard validate, then workspace apply';
  return json({ schemaVersion: 1, path, ...report, next });
}

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

/** Dry-runs the write in Grafana; a revision is sent only for existing dashboards (update vs. create). */
async function serverDryRun(
  content: string,
  resourceVersion: string | undefined,
  report: DashboardValidationReport,
  ctx: WorkspaceCommandContext
) {
  report.notRun = report.notRun.filter((level) => !level.startsWith('server dry-run'));
  const dryRun = ctx.broker.dashboards?.dryRun;
  if (!dryRun || report.levels.json !== 'passed' || report.levels.envelope !== 'passed') {
    report.warnings.push({
      level: 'server',
      message: dryRun
        ? 'server dry-run skipped: fix JSON and envelope errors first'
        : 'server dry-run is not available',
    });
    return;
  }
  const result = await dryRun(JSON.parse(content), resourceVersion, ctx.signal);
  if (result.ok) {
    report.levels.server = 'passed';
    return;
  }
  const status = result.status;
  const message = result.message ?? 'request failed';
  if (status === 409 || status === 412) {
    report.errors.push({
      level: 'server',
      message: `conflict: ${message}. The dashboard changed in Grafana since it was fetched; run \`grafana refresh\` and reapply your edits.`,
    });
  } else if (status === 401 || status === 403) {
    report.errors.push({ level: 'server', message: `not permitted to save this dashboard: ${message}` });
  } else if (status !== undefined && status >= 400 && status < 500) {
    report.errors.push({ level: 'server', message: `rejected by Grafana (HTTP ${status}): ${message}` });
  } else {
    report.warnings.push({ level: 'server', message: `server dry-run unavailable: ${message}` });
    return;
  }
  report.levels.server = 'failed';
  report.ok = false;
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
