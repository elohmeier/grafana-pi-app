import { alertRuleValidationOptions } from '../apply';
import { validateAlertRuleDocument } from '../alertRuleModel';
import { normalizeWorkspacePath } from '../paths';
import { ALERT_RULES_ROOT, DASHBOARDS_ROOT, HYDRATION_CONCURRENCY } from '../workspace';
import {
  json,
  numberOption,
  stringOption,
  UsageError,
  type WorkspaceCommandContext,
  type WorkspaceCommandSpec,
} from './registry';

export const grafanaAlertCommand: WorkspaceCommandSpec = {
  name: 'grafana-alert',
  summary: `Grafana-managed alert rules: find rules linked to panels, print one, and validate working copies under ${ALERT_RULES_ROOT}.`,
  subcommands: {
    find: {
      summary:
        'Find alert rules linked to a dashboard panel (panelRef and __dashboardUid__/__panelId__ annotations) or matching text, ranked with reasons and PromQL checks. Each match names its working copy (path).',
      usage:
        'grafana-alert find [TEXT] [--dashboard UID|PATH] [--panel ID] [--title PANEL_TITLE] [--rule NAME] [--limit N]',
      effect: 'remote-read',
      options: {
        dashboard: { type: 'string', description: 'Dashboard UID or its working-copy path.' },
        panel: { type: 'string', description: 'Panel id.' },
        title: { type: 'string', description: 'Panel title for fallback matching.' },
        rule: { type: 'string', description: 'AlertRule metadata.name to include.' },
        namespace: { type: 'string', description: 'App Platform namespace (default: current org).' },
        limit: { type: 'number', description: 'Maximum matched rules, 1-20.', default: 20 },
      },
      examples: [
        'grafana-alert find --dashboard checkout --panel 4',
        "grafana-alert find --dashboard checkout --panel 4 | jq '.matches[] | {score, reasons, path, condition: .rule.alertCondition}'",
        'grafana-alert find "error budget"',
      ],
      async run(parsed, ctx) {
        const alerts = requireAlerts(ctx);
        const dashboard = stringOption(parsed, 'dashboard');
        const text = parsed.positionals.join(' ').trim() || undefined;
        const params = {
          dashboardUid: dashboard ? dashboardUid(dashboard) : undefined,
          panelId: stringOption(parsed, 'panel'),
          panelTitle: stringOption(parsed, 'title'),
          ruleName: stringOption(parsed, 'rule'),
          query: text,
          namespace: stringOption(parsed, 'namespace'),
          maxRules: numberOption(parsed, 'limit', 20, 1, 20),
        };
        if (!params.dashboardUid && !params.panelTitle && !params.ruleName && !params.query) {
          throw new UsageError('give TEXT, --dashboard, --title, or --rule');
        }
        const result = (await alerts.findPanelRules(params, ctx.signal)) as { matches?: Array<Record<string, any>> };
        if (ctx.broker.alertRules && Array.isArray(result?.matches)) {
          result.matches = result.matches.map((match) => ({ ...match, path: rulePath(match.rule?.name) }));
        }
        return json(result);
      },
    },
    get: {
      summary:
        'Print one alert rule by metadata.name as stored in Grafana: expressions, condition, reducer, evaluation settings, and PromQL checks. Edit its working copy (path) to change it.',
      usage: 'grafana-alert get NAME [--namespace NS]',
      effect: 'remote-read',
      options: {
        namespace: { type: 'string', description: 'App Platform namespace (default: current org).' },
      },
      async run(parsed, ctx) {
        const name = parsed.positionals[0];
        if (!name) {
          throw new UsageError('NAME is required');
        }
        const result = (await requireAlerts(ctx).getRule(
          { name, namespace: stringOption(parsed, 'namespace') },
          ctx.signal
        )) as Record<string, unknown>;
        return json(ctx.broker.alertRules ? { ...result, path: rulePath(name) } : result);
      },
    },
    validate: {
      summary:
        'Validate alert rule working copies: envelope, title and evaluation settings, the expression graph (one condition, references, query time ranges), PromQL syntax, contact point and time interval references, the datasource allow-list, and changes the single-rule API cannot make (folder moves, group intervals, provisioned rules). Without PATH, every changed rule. Exit 1 on errors; errors the fetched rule already had are listed as preexistingErrors and do not fail it.',
      usage: 'grafana-alert validate [PATH...]',
      effect: 'local-read',
      examples: [
        'grafana-alert validate /grafana/alert-rules/high-5xx/rule.json',
        "grafana-alert validate | jq '.reports[] | select(.ok | not) | {path, errors}'",
      ],
      async run(parsed, ctx) {
        const view = ctx.tx.view();
        const paths = parsed.positionals.length
          ? parsed.positionals.map((raw) => normalizeWorkspacePath(raw, ctx.cwd))
          : view
              .resourceEntries('alertRule')
              .filter((entry) => entry.overlay && entry.overlay.content !== null)
              .map((entry) => entry.path);
        if (paths.length === 0) {
          return json({
            schemaVersion: 1,
            ok: true,
            reports: [],
            note: 'No changed alert rules; pass PATH to validate one.',
          });
        }
        const options = await alertRuleValidationOptions(ctx.broker, ctx.signal);
        const validateOne = async (path: string) => {
          const target = ctx.workspace.classify(path);
          if (target.type === 'resource' && target.kind === 'dashboard') {
            throw new UsageError(`${path} is a dashboard; use grafana-dashboard validate`);
          }
          const uid = target.type === 'resource' ? target.uid : undefined;
          // Reading first hydrates the rule, so its base is known afterwards.
          const content = await ctx.tx.readFile(path);
          const base = uid ? ctx.workspace.getResource(uid, 'alertRule')?.base : undefined;
          const validation = {
            expectedUid: uid,
            base,
            ...options,
            promql: ctx.broker.promql,
            signal: ctx.signal,
          };
          const report = await validateAlertRuleDocument(content, validation);
          if (base?.content && base.content !== content && report.errors.length > 0) {
            const key = (error: { level: string; path?: string; message: string }) =>
              `${error.level}|${error.path ?? ''}|${error.message}`;
            const existing = new Set((await validateAlertRuleDocument(base.content, validation)).errors.map(key));
            const preexistingErrors = report.errors.filter((error) => existing.has(key(error)));
            if (preexistingErrors.length > 0) {
              const errors = report.errors.filter((error) => !existing.has(key(error)));
              return { path, ...report, ok: errors.length === 0, errors, preexistingErrors };
            }
          }
          return { path, ...report };
        };
        const reports: Array<Awaited<ReturnType<typeof validateOne>>> = new Array(paths.length);
        let next = 0;
        const worker = async () => {
          while (next < paths.length) {
            const index = next++;
            reports[index] = await validateOne(paths[index]);
          }
        };
        await Promise.all(Array.from({ length: Math.min(HYDRATION_CONCURRENCY, paths.length) }, worker));
        const okAll = reports.every((report) => report.ok);
        return json(
          reports.length === 1 && parsed.positionals.length === 1
            ? reports[0]
            : { schemaVersion: 1, ok: okAll, reports },
          okAll ? 0 : 1
        );
      },
    },
  },
};

function rulePath(name: unknown) {
  return typeof name === 'string' && name ? `${ALERT_RULES_ROOT}/${name}/rule.json` : undefined;
}

/** Accepts a dashboard UID or a working-copy path such as /grafana/dashboards/<uid>/dashboard.json. */
export function dashboardUid(value: string) {
  const prefix = `${DASHBOARDS_ROOT}/`;
  if (value.startsWith(prefix)) {
    const uid = value.slice(prefix.length).split('/')[0];
    if (uid) {
      return uid;
    }
  }
  if (value.includes('/')) {
    throw new UsageError(
      `expected a dashboard UID or ${DASHBOARDS_ROOT}/<uid>/dashboard.json, got ${JSON.stringify(value)}`
    );
  }
  return value;
}

function requireAlerts(ctx: WorkspaceCommandContext) {
  if (!ctx.broker.alerts) {
    throw new Error('alert rules are not available in this session');
  }
  return ctx.broker.alerts;
}
