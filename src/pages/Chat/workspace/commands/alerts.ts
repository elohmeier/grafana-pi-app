import { DASHBOARDS_ROOT } from '../workspace';
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
  summary: 'Read-only Grafana-managed alert rules (App Platform AlertRule API).',
  subcommands: {
    find: {
      summary:
        'Find alert rules linked to a dashboard panel (panelRef and __dashboardUid__/__panelId__ annotations) or matching text, ranked with reasons and PromQL checks.',
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
        "grafana-alert find --dashboard checkout --panel 4 | jq '.matches[] | {score, reasons, name: .rule.name, condition: .rule.alertCondition}'",
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
        return json(await alerts.findPanelRules(params, ctx.signal));
      },
    },
    get: {
      summary:
        'Print one alert rule by metadata.name: expressions, condition, reducer, evaluation settings, and PromQL checks.',
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
        return json(
          await requireAlerts(ctx).getRule({ name, namespace: stringOption(parsed, 'namespace') }, ctx.signal)
        );
      },
    },
  },
};

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
