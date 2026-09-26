import type { AgentTool } from '@earendil-works/pi-agent-core';
import { config } from '@grafana/runtime';
import { Type } from 'typebox';
import { walkClassicPanels } from '../workspace/dashboardPanels';
import { backendFetch } from './client';
import { textResult, throwIfAborted, truncateText } from './result';
import type { GrafanaToolConfig } from './types';

const ALERT_RULE_GROUP = 'rules.alerting.grafana.app';
const ALERT_RULE_VERSION = 'v0alpha1';
const DASHBOARD_UID_ANNOTATION = '__dashboardUid__';
const PANEL_ID_ANNOTATION = '__panelId__';
const MAX_ALERT_RULES = 250;
const MAX_ALERT_MATCHES = 20;
const MAX_OUTPUT_LENGTH = 120000;

type AlertRuleParams = {
  name: string;
  namespace?: string;
};

type PanelAlertRuleSearchParams = {
  dashboardUid?: string;
  panelId?: number | string;
  panelTitle?: string;
  ruleName?: string;
  query?: string;
  namespace?: string;
  maxRules?: number;
};

type AlertRuleListResponse = {
  items?: AlertRuleResource[];
};

type AlertRuleResource = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    uid?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    resourceVersion?: string;
    creationTimestamp?: string;
  };
  spec?: AlertRuleSpec;
  status?: unknown;
};

type AlertRuleSpec = {
  title?: string;
  paused?: boolean;
  trigger?: {
    interval?: string;
  };
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  for?: string;
  keepFiringFor?: string;
  missingSeriesEvalsToResolve?: number;
  noDataState?: string;
  execErrState?: string;
  notificationSettings?: unknown;
  expressions?: Record<string, AlertExpression>;
  panelRef?: {
    dashboardUID?: string;
    panelID?: number;
  };
};

type AlertExpression = {
  queryType?: string;
  relativeTimeRange?: {
    from?: string;
    to?: string;
  };
  datasourceUID?: string;
  model?: Record<string, any>;
  source?: boolean;
};

type DashboardResponse = {
  dashboard?: Record<string, any>;
  meta?: Record<string, any>;
  spec?: Record<string, any>;
};

type PanelSummary = {
  id?: string;
  title?: string;
  type?: string;
  datasourceUid?: string;
  datasourceType?: string;
  targets: PanelTargetSummary[];
  thresholds?: unknown;
};

type PanelTargetSummary = {
  refId?: string;
  datasourceUid?: string;
  datasourceType?: string;
  query?: string;
  legendFormat?: string;
  hidden?: boolean;
};

type AlertRuleMatch = {
  score: number;
  reasons: string[];
  rule: AlertRuleSummary;
};

type AlertRuleSummary = {
  name: string;
  title: string;
  viewUrl: string;
  apiPath: string;
  folderUid?: string;
  panelRef?: AlertRuleSpec['panelRef'];
  panelLink?: AlertRulePanelLink;
  trigger?: AlertRuleSpec['trigger'];
  for?: string;
  keepFiringFor?: string;
  noDataState?: string;
  execErrState?: string;
  paused?: boolean;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  conditionRef?: string;
  expressions: AlertExpressionSummary[];
  alertCondition?: AlertConditionSummary;
  prometheusChecks: PrometheusCheck[];
};

type AlertRulePanelLink = {
  dashboardUID: string;
  panelID: number;
  source: 'panelRef' | 'annotations' | 'panelRef+annotations';
};

type AlertExpressionSummary = {
  refId: string;
  source?: boolean;
  queryType?: string;
  datasourceUid?: string;
  expressionType?: string;
  expression?: string;
  reducer?: string;
  evaluator?: {
    type?: string;
    params?: unknown[];
  };
  relativeTimeRange?: AlertExpression['relativeTimeRange'];
  model?: Record<string, unknown>;
};

type AlertConditionSummary = {
  sourceRefId?: string;
  expression?: string;
  evaluator?: {
    type?: string;
    params?: unknown[];
  };
  reducer?: string;
};

type PrometheusCheck = {
  refId: string;
  datasourceUid: string;
  query: string;
  type: 'range';
  start?: string;
  end?: string;
  relativeTimeRange?: AlertExpression['relativeTimeRange'];
};

export function createAlertTools(toolConfig: GrafanaToolConfig): AgentTool[] {
  return [makeFindPanelAlertRulesTool(toolConfig), makeGetAlertRuleTool(toolConfig)];
}

function makeFindPanelAlertRulesTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'find_panel_alert_rules',
    label: 'Find panel alert rules',
    description:
      'Read Grafana-managed AlertRule resources from the App Platform API and find rules linked or related to a dashboard panel. This is read-only and uses /apis/rules.alerting.grafana.app/v0alpha1 only.',
    parameters: Type.Object(
      {
        dashboardUid: Type.Optional(Type.String({ description: 'Dashboard UID from sidebar or user context.' })),
        panelId: Type.Optional(
          Type.Union([Type.Number(), Type.String()], {
            description: 'Dashboard panel ID. Prefer this when available.',
          })
        ),
        panelTitle: Type.Optional(Type.String({ description: 'Panel title for fallback matching.' })),
        ruleName: Type.Optional(Type.String({ description: 'Specific AlertRule metadata.name to include.' })),
        query: Type.Optional(Type.String({ description: 'Optional text to match against rule titles and labels.' })),
        namespace: Type.Optional(
          Type.String({ description: 'Grafana App Platform namespace. Defaults to Grafana config.' })
        ),
        maxRules: Type.Optional(
          Type.Number({ description: `Maximum matched rules to return. Defaults to ${MAX_ALERT_MATCHES}.` })
        ),
      },
      { required: [] }
    ),
    async execute(_toolCallId, params, signal) {
      const args = params as PanelAlertRuleSearchParams;
      throwIfAborted(signal);
      const namespace = await resolveAlertNamespace(args.namespace);
      const [rules, panel] = await Promise.all([
        fetchAlertRules(namespace),
        args.dashboardUid ? fetchDashboardPanel(args).catch(() => undefined) : Promise.resolve(undefined),
      ]);
      throwIfAborted(signal);
      const maxRules = clampInt(args.maxRules ?? MAX_ALERT_MATCHES, 1, MAX_ALERT_MATCHES);
      const candidateRules = selectAlertRuleCandidates(rules, args, panel);
      const matches = candidateRules
        .map((rule) => scoreAlertRule(rule, { ...args, panel }, namespace, toolConfig))
        .filter((match) => match.score > 0 || shouldReturnUnscoredRule(args))
        .sort((left, right) => right.score - left.score || left.rule.title.localeCompare(right.rule.title))
        .slice(0, maxRules);
      const exactPanelMatches = matches.filter((match) =>
        match.reasons.some((reason) => reason === 'panel link exact match')
      );
      const result = {
        namespace,
        query: compactRecord({
          dashboardUid: args.dashboardUid,
          panelId: normalizedPanelId(args.panelId),
          panelTitle: args.panelTitle,
          ruleName: args.ruleName,
          query: args.query,
        }),
        dashboardPanel: panel,
        ruleCount: rules.length,
        matchCount: matches.length,
        exactPanelMatchCount: exactPanelMatches.length,
        matches,
        guidance: [
          'Run prometheusChecks with `grafana-prom query` to compare the alert data query against the panel query and time range.',
          `Grafana's dashboard alert-state overlay uses ${DASHBOARD_UID_ANNOTATION}/${PANEL_ID_ANNOTATION} annotations; App Platform panelRef alone can be enough for API lookup but not for the panel indicator.`,
          'Check alertCondition, reducer, relativeTimeRange, for, noDataState, and execErrState before concluding from the panel visualization alone.',
        ],
      };

      return textResult(truncateText(JSON.stringify(result, null, 2), MAX_OUTPUT_LENGTH), {
        namespace,
        dashboardUid: args.dashboardUid,
        panelId: normalizedPanelId(args.panelId),
        ruleCount: rules.length,
        scannedRuleCount: candidateRules.length,
        matchCount: matches.length,
        exactPanelMatchCount: exactPanelMatches.length,
        summarized: true,
      });
    },
  };
}

function makeGetAlertRuleTool(toolConfig: GrafanaToolConfig): AgentTool {
  return {
    name: 'get_alert_rule',
    label: 'Get alert rule',
    description:
      'Read one Grafana-managed AlertRule resource by metadata.name from the App Platform API. This is read-only and returns a normalized expression and PromQL-check summary.',
    parameters: Type.Object({
      name: Type.String({ description: 'AlertRule metadata.name.' }),
      namespace: Type.Optional(
        Type.String({ description: 'Grafana App Platform namespace. Defaults to Grafana config.' })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as AlertRuleParams;
      throwIfAborted(signal);
      const namespace = await resolveAlertNamespace(args.namespace);
      const rule = await fetchAlertRule(namespace, args.name);
      const result = {
        namespace,
        rule: summarizeAlertRule(rule, namespace, toolConfig),
        rawStatus: compactValue(rule.status, 3),
        guidance: [
          'Run prometheusChecks with `grafana-prom query` for current evidence.',
          'Compare the alert condition with any panel thresholds; panel color and alert state can differ when queries, reducers, windows, no-data handling, or pending periods differ.',
        ],
      };

      return textResult(truncateText(JSON.stringify(result, null, 2), MAX_OUTPUT_LENGTH), {
        namespace,
        name: args.name,
        title: result.rule.title,
        prometheusChecks: result.rule.prometheusChecks.length,
        summarized: true,
      });
    },
  };
}

async function resolveAlertNamespace(namespace?: string) {
  if (namespace?.trim()) {
    return namespace.trim();
  }

  const runtimeNamespace =
    stringField(config as unknown as Record<string, unknown>, 'namespace') ??
    stringField(recordField((config as any).bootData, 'settings'), 'namespace');
  if (runtimeNamespace) {
    return runtimeNamespace;
  }

  try {
    const settings = await backendFetch<Record<string, unknown>>('/api/frontend/settings');
    return (
      stringField(settings, 'namespace') ??
      stringField(recordField(settings, 'settings'), 'namespace') ??
      stringField(recordField(recordField(settings, 'bootData'), 'settings'), 'namespace') ??
      'default'
    );
  } catch {
    return 'default';
  }
}

async function fetchAlertRules(namespace: string) {
  const response = await backendFetch<AlertRuleListResponse | AlertRuleResource[]>(
    `${alertRulesApiPath(namespace)}/alertrules`
  );
  if (Array.isArray(response)) {
    return response.filter(isAlertRuleResource);
  }
  return (response.items ?? []).filter(isAlertRuleResource);
}

async function fetchAlertRule(namespace: string, name: string) {
  const rule = await backendFetch<AlertRuleResource>(
    `${alertRulesApiPath(namespace)}/alertrules/${encodeURIComponent(name)}`
  );
  if (!isAlertRuleResource(rule)) {
    throw new Error(`Unexpected AlertRule response for ${name}.`);
  }
  return rule;
}

function alertRulesApiPath(namespace: string) {
  return `/apis/${ALERT_RULE_GROUP}/${ALERT_RULE_VERSION}/namespaces/${encodeURIComponent(namespace)}`;
}

async function fetchDashboardPanel(params: PanelAlertRuleSearchParams): Promise<PanelSummary | undefined> {
  if (!params.dashboardUid) {
    return undefined;
  }

  const response = await backendFetch<DashboardResponse>(
    `/api/dashboards/uid/${encodeURIComponent(params.dashboardUid)}`
  );
  const panel = findDashboardPanel(response, params.panelId, params.panelTitle);
  return panel ? summarizePanel(panel) : undefined;
}

function selectAlertRuleCandidates(rules: AlertRuleResource[], args: PanelAlertRuleSearchParams, panel?: PanelSummary) {
  const highConfidence = rules.filter((rule) => isHighConfidenceAlertCandidate(rule, args, panel));
  const candidates = new Map<string, AlertRuleResource>();

  for (const rule of highConfidence) {
    candidates.set(alertRuleCandidateKey(rule), rule);
  }

  const fallbackLimit = hasSearchContext(args)
    ? Math.min(MAX_ALERT_RULES, Math.max(MAX_ALERT_RULES - candidates.size, 0))
    : MAX_ALERT_RULES;
  for (const rule of rules.slice(0, fallbackLimit)) {
    candidates.set(alertRuleCandidateKey(rule), rule);
  }

  return [...candidates.values()];
}

function isHighConfidenceAlertCandidate(
  rule: AlertRuleResource,
  args: PanelAlertRuleSearchParams,
  panel?: PanelSummary
) {
  const spec = rule.spec ?? {};
  const name = stringField(rule.metadata, 'name');
  const title = spec.title || name || '';
  const panelLink = alertRulePanelLink(spec);
  const wantedPanelId = normalizedPanelId(args.panelId) ?? panel?.id;

  if (args.ruleName && name === args.ruleName) {
    return true;
  }

  if (args.dashboardUid && panelLink?.dashboardUID === args.dashboardUid) {
    return !wantedPanelId || String(panelLink.panelID) === wantedPanelId;
  }

  const searchText = [args.query, args.panelTitle].filter(Boolean).join(' ');
  return scoreTextMatch(searchText, [title, name ?? '', labelsText(spec.labels)]) > 0;
}

function alertRuleCandidateKey(rule: AlertRuleResource) {
  return stringField(rule.metadata, 'name') ?? stringField(rule.metadata, 'uid') ?? JSON.stringify(rule.metadata ?? {});
}

function findDashboardPanel(response: DashboardResponse, panelId?: number | string, panelTitle?: string) {
  const panels = walkClassicPanels(response).map(({ panel }) => panel as Record<string, any>);
  const id = normalizedPanelId(panelId);
  if (id) {
    const panel = panels.find((candidate) => stringOrNumberField(candidate, 'id') === id);
    if (panel) {
      return panel;
    }
  }

  const title = panelTitle?.trim().toLowerCase();
  if (title) {
    return panels.find((panel) => stringField(panel, 'title')?.toLowerCase() === title);
  }

  return undefined;
}

function summarizePanel(panel: Record<string, any>): PanelSummary {
  const panelDatasourceUid = datasourceUid(panel.datasource);
  const panelDatasourceType = datasourceType(panel.datasource);
  const targets = arrayField(panel, 'targets')
    .filter(isRecord)
    .map((target) => {
      const datasource = recordField(target, 'datasource');
      return compactRecord({
        refId: stringField(target, 'refId'),
        datasourceUid: datasourceUid(datasource) ?? panelDatasourceUid,
        datasourceType: datasourceType(datasource) ?? panelDatasourceType,
        query: queryText(target),
        legendFormat: stringField(target, 'legendFormat'),
        hidden: target.hide === true ? true : undefined,
      }) as PanelTargetSummary;
    })
    .filter((target) => target.query);

  const summary = compactRecord({
    id: stringOrNumberField(panel, 'id'),
    title: stringField(panel, 'title'),
    type: stringField(panel, 'type'),
    datasourceUid: panelDatasourceUid,
    datasourceType: panelDatasourceType,
    targets,
    thresholds: compactValue(recordField(recordField(recordField(panel, 'fieldConfig'), 'defaults'), 'thresholds'), 3),
  }) as PanelSummary;
  summary.targets = targets;
  return summary;
}

function scoreAlertRule(
  rule: AlertRuleResource,
  context: PanelAlertRuleSearchParams & { panel?: PanelSummary },
  namespace: string,
  toolConfig: GrafanaToolConfig
): AlertRuleMatch {
  const summary = summarizeAlertRule(rule, namespace, toolConfig);
  const reasons: string[] = [];
  let score = 0;
  const wantedPanelId = normalizedPanelId(context.panelId) ?? context.panel?.id;
  const panelLink = summary.panelLink;

  if (context.ruleName && summary.name === context.ruleName) {
    score += 200;
    reasons.push('exact ruleName match');
  }

  if (context.dashboardUid && panelLink?.dashboardUID === context.dashboardUid) {
    score += 80;
    reasons.push(`${panelLink.source} dashboardUID match`);
    if (wantedPanelId && String(panelLink.panelID) === wantedPanelId) {
      score += 160;
      reasons.push(`${panelLink.source} panelID match`);
      reasons.push('panel link exact match');
    }
  }

  const searchText = [context.query, context.panelTitle].filter(Boolean).join(' ');
  const textScore = scoreTextMatch(searchText, [summary.title, summary.name, labelsText(summary.labels)]);
  if (textScore > 0) {
    score += textScore;
    reasons.push('title or label text match');
  }

  const panelQueries = (context.panel?.targets ?? []).map((target) => target.query).filter(isString);
  const ruleQueries = (summary.prometheusChecks ?? []).map((check) => check.query);
  const queryScore = scoreQueryOverlap(panelQueries, ruleQueries);
  if (queryScore > 0) {
    score += queryScore;
    reasons.push('panel query overlaps alert data query');
  }

  const datasourceScore = scoreDatasourceOverlap(context.panel, summary);
  if (datasourceScore > 0 && score > 0) {
    score += datasourceScore;
    reasons.push('panel datasource overlaps alert datasource');
  }

  if (!hasSearchContext(context)) {
    score += 1;
    reasons.push('unfiltered alert rule');
  }

  return {
    score,
    reasons,
    rule: summary,
  };
}

function summarizeAlertRule(
  rule: AlertRuleResource,
  namespace: string,
  toolConfig: GrafanaToolConfig
): AlertRuleSummary {
  const name = stringField(rule.metadata, 'name') ?? 'unknown';
  const spec = rule.spec ?? {};
  const expressions = summarizeExpressions(spec.expressions ?? {});
  const conditionRef = expressions.find((expression) => expression.source)?.refId;
  const alertCondition = summarizeAlertCondition(expressions, conditionRef);
  const checks = prometheusChecks(expressions, toolConfig);

  const summary = compactRecord({
    name,
    title: spec.title || name,
    viewUrl: `/alerting/grafana/${encodeURIComponent(name)}/view`,
    apiPath: `${alertRulesApiPath(namespace)}/alertrules/${encodeURIComponent(name)}`,
    folderUid: stringField(rule.metadata?.annotations, 'grafana.app/folder'),
    panelRef: spec.panelRef,
    panelLink: alertRulePanelLink(spec),
    trigger: compactRecord(spec.trigger ?? {}),
    for: spec.for,
    keepFiringFor: spec.keepFiringFor,
    noDataState: spec.noDataState,
    execErrState: spec.execErrState,
    paused: spec.paused === true ? true : undefined,
    labels: compactStringRecord(spec.labels),
    annotations: compactStringRecord(spec.annotations),
    conditionRef,
    expressions,
    alertCondition,
    prometheusChecks: checks,
  }) as AlertRuleSummary;
  summary.expressions = expressions;
  summary.prometheusChecks = checks;
  return summary;
}

function alertRulePanelLink(spec: AlertRuleSpec): AlertRulePanelLink | undefined {
  const panelRefLink = panelLinkFromPanelRef(spec.panelRef);
  const annotationLink = panelLinkFromAnnotations(spec.annotations);

  if (panelRefLink && annotationLink) {
    return {
      ...panelRefLink,
      source:
        panelRefLink.dashboardUID === annotationLink.dashboardUID && panelRefLink.panelID === annotationLink.panelID
          ? 'panelRef+annotations'
          : 'panelRef',
    };
  }

  return panelRefLink ?? annotationLink;
}

function panelLinkFromPanelRef(panelRef: AlertRuleSpec['panelRef']): AlertRulePanelLink | undefined {
  const panelID = panelRef?.panelID;
  if (!panelRef?.dashboardUID || typeof panelID !== 'number' || !Number.isFinite(panelID)) {
    return undefined;
  }
  return {
    dashboardUID: panelRef.dashboardUID,
    panelID,
    source: 'panelRef',
  };
}

function panelLinkFromAnnotations(annotations: Record<string, string> | undefined): AlertRulePanelLink | undefined {
  const dashboardUID = annotations?.[DASHBOARD_UID_ANNOTATION]?.trim();
  const panelID = Number(annotations?.[PANEL_ID_ANNOTATION]);
  if (!dashboardUID || !Number.isFinite(panelID)) {
    return undefined;
  }
  return {
    dashboardUID,
    panelID,
    source: 'annotations',
  };
}

function summarizeExpressions(expressions: Record<string, AlertExpression>): AlertExpressionSummary[] {
  return Object.entries(expressions)
    .map(([refId, expression]) => {
      const model = isRecord(expression.model) ? expression.model : {};
      return compactRecord({
        refId,
        source: expression.source === true ? true : undefined,
        queryType: expression.queryType || undefined,
        datasourceUid: expression.datasourceUID,
        expressionType: stringField(model, 'type') ?? expression.queryType,
        expression: queryText(model) ?? stringField(model, 'expression'),
        reducer: stringField(model, 'reducer') ?? reducerFromConditions(model),
        evaluator: evaluatorFromModel(model),
        relativeTimeRange: compactRecord(expression.relativeTimeRange ?? {}),
        model: compactExpressionModel(model),
      }) as AlertExpressionSummary;
    })
    .sort((left, right) => left.refId.localeCompare(right.refId));
}

function summarizeAlertCondition(
  expressions: AlertExpressionSummary[],
  conditionRef: string | undefined
): AlertConditionSummary | undefined {
  const source = expressions.find((expression) => expression.refId === conditionRef);
  if (!source) {
    return undefined;
  }
  return compactRecord({
    sourceRefId: conditionRef,
    expression: source.expression,
    evaluator: source.evaluator,
    reducer: source.reducer,
  }) as AlertConditionSummary;
}

function prometheusChecks(expressions: AlertExpressionSummary[], toolConfig: GrafanaToolConfig): PrometheusCheck[] {
  const allowed = new Set((toolConfig.allowedPrometheusDatasourceUids ?? []).filter(Boolean));
  return expressions
    .filter(
      (expression) => expression.datasourceUid && expression.datasourceUid !== '__expr__' && expression.expression
    )
    .filter((expression) => allowed.size === 0 || allowed.has(expression.datasourceUid!))
    .map(
      (expression) =>
        compactRecord({
          refId: expression.refId,
          datasourceUid: expression.datasourceUid!,
          query: expression.expression!,
          type: 'range',
          start: rangeStart(expression.relativeTimeRange?.from),
          end: rangeEnd(expression.relativeTimeRange?.to),
          relativeTimeRange: expression.relativeTimeRange,
        }) as PrometheusCheck
    );
}

function compactExpressionModel(model: Record<string, any>) {
  return compactValue(
    compactRecord({
      expr: stringField(model, 'expr'),
      expression: stringField(model, 'expression'),
      type: stringField(model, 'type'),
      reducer: stringField(model, 'reducer'),
      conditions: compactValue(model.conditions, 4),
      instant: typeof model.instant === 'boolean' ? model.instant : undefined,
      range: typeof model.range === 'boolean' ? model.range : undefined,
      intervalMs: numberField(model, 'intervalMs'),
      maxDataPoints: numberField(model, 'maxDataPoints'),
    }),
    5
  );
}

function evaluatorFromModel(model: Record<string, any>) {
  const direct = recordField(model, 'evaluator');
  const fromConditions = arrayField(model, 'conditions')
    .map((condition) => recordField(condition, 'evaluator'))
    .find(isRecord);
  const evaluator = direct ?? fromConditions;
  if (!evaluator) {
    return undefined;
  }
  return compactRecord({
    type: stringField(evaluator, 'type'),
    params: arrayField(evaluator, 'params'),
  });
}

function reducerFromConditions(model: Record<string, any>) {
  const reducer = arrayField(model, 'conditions')
    .map((condition) => recordField(condition, 'reducer'))
    .find(isRecord);
  return stringField(reducer, 'type');
}

function scoreTextMatch(searchText: string, candidates: string[]) {
  const tokens = searchTokens(searchText);
  if (tokens.length === 0) {
    return 0;
  }
  const haystack = candidates.join(' ').toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 10 : 0), 0);
}

function scoreQueryOverlap(panelQueries: string[], ruleQueries: string[]) {
  let score = 0;
  for (const panelQuery of panelQueries) {
    const normalizedPanel = normalizeQuery(panelQuery);
    const panelMetrics = metricTokens(panelQuery);
    for (const ruleQuery of ruleQueries) {
      const normalizedRule = normalizeQuery(ruleQuery);
      if (normalizedPanel && normalizedPanel === normalizedRule) {
        score += 80;
        continue;
      }
      const sharedMetrics = intersectionCount(panelMetrics, metricTokens(ruleQuery));
      if (sharedMetrics > 0) {
        score += sharedMetrics * 16;
      }
    }
  }
  return score;
}

function scoreDatasourceOverlap(panel: PanelSummary | undefined, rule: AlertRuleSummary) {
  if (!panel) {
    return 0;
  }
  const panelDatasourceUids = new Set(
    [panel.datasourceUid, ...(panel.targets ?? []).map((target) => target.datasourceUid)].filter(isString)
  );
  const ruleDatasourceUids = new Set(rule.prometheusChecks.map((check) => check.datasourceUid));
  let score = 0;
  for (const datasourceUid of panelDatasourceUids) {
    if (ruleDatasourceUids.has(datasourceUid)) {
      score += 8;
    }
  }
  return score;
}

function shouldReturnUnscoredRule(args: PanelAlertRuleSearchParams) {
  return !hasSearchContext(args);
}

function hasSearchContext(args: PanelAlertRuleSearchParams) {
  return Boolean(args.dashboardUid || args.panelId || args.panelTitle || args.query || args.ruleName);
}

function rangeStart(value: string | undefined) {
  if (!value || isZeroDuration(value)) {
    return undefined;
  }
  return `now-${value}`;
}

function rangeEnd(value: string | undefined) {
  if (!value || isZeroDuration(value)) {
    return 'now';
  }
  return `now-${value}`;
}

function isZeroDuration(value: string) {
  return /^0(?:ms|s|m|h|d)?$/.test(value.trim());
}

function normalizeQuery(query: string | undefined) {
  return (query ?? '')
    .replace(/\$__rate_interval/g, '5m')
    .replace(/\s+/g, '')
    .trim();
}

function metricTokens(query: string) {
  const metrics = new Set<string>();
  for (const match of query.matchAll(/\b[A-Za-z_:][A-Za-z0-9_:]*\b/g)) {
    const token = match[0];
    if (
      /^(?:sum|avg|min|max|rate|irate|increase|histogram_quantile|by|without|on|ignoring|group_left|group_right|le|bool|and|or|unless)$/.test(
        token
      )
    ) {
      continue;
    }
    if (token.startsWith('__') || token.length < 2) {
      continue;
    }
    metrics.add(token);
  }
  return [...metrics];
}

function intersectionCount(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).length;
}

function searchTokens(value: string | undefined) {
  return (value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_:]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function labelsText(labels: Record<string, string> | undefined) {
  return Object.entries(labels ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function queryText(record: Record<string, any> | undefined) {
  return (
    stringField(record, 'expr') ??
    stringField(record, 'query') ??
    stringField(record, 'expression') ??
    stringField(record, 'rawSql') ??
    stringField(record, 'rawQuery') ??
    stringField(record, 'sqlExpression')
  );
}

function datasourceUid(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return stringField(value, 'uid') ?? stringField(value, 'name');
}

function datasourceType(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return undefined;
  }
  return stringField(isRecord(value) ? value : undefined, 'type');
}

function normalizedPanelId(value: number | string | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function isAlertRuleResource(value: unknown): value is AlertRuleResource {
  return isRecord(value) && isRecord(value.metadata) && isRecord(value.spec);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function recordField(
  record: Record<string, any> | undefined,
  key: string | undefined
): Record<string, any> | undefined {
  const value = key === undefined ? record : record?.[key];
  return isRecord(value) ? value : undefined;
}

function arrayField(record: Record<string, any> | undefined, key: string): any[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function stringField(record: Record<string, any> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, any> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOrNumberField(record: Record<string, any> | undefined, key: string): string | undefined {
  const value = record?.[key];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function compactStringRecord(record: Record<string, string> | undefined) {
  if (!record) {
    return undefined;
  }
  const compact = Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
  );
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function compactRecord<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))
  ) as Partial<T>;
}

function compactValue(value: unknown, depth: number): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (depth <= 0) {
    if (Array.isArray(value)) {
      return `[${value.length} items]`;
    }
    if (isRecord(value)) {
      return '{...}';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => compactValue(item, depth - 1));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .slice(0, 24)
      .map(([key, item]) => [key, compactValue(item, depth - 1)] as const)
      .filter(([, item]) => item !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}
