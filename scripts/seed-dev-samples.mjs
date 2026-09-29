#!/usr/bin/env node

import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const GRAFANA_URL = (process.env.GRAFANA_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const GRAFANA_USER = process.env.GRAFANA_USER ?? 'admin';
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD ?? 'admin';
const ALERT_NAMESPACE = process.env.ALERT_NAMESPACE ?? 'default';
const PROMETHEUS_UID = process.env.PROMETHEUS_UID ?? 'prometheus';
const FOLDER_UID = process.env.DEV_SAMPLE_FOLDER_UID ?? 'assistant-dev-samples';
const FOLDER_TITLE = process.env.DEV_SAMPLE_FOLDER_TITLE ?? 'Assistant Dev Samples';
const ENTERPRISE_PROFILE_ENABLED = readBooleanEnv(
  process.env.DEV_SAMPLE_ENTERPRISE_PROFILE ?? process.env.DEV_SAMPLE_PRODUCTION_PROFILE,
  true
);
const ENTERPRISE_FOLDER_COUNT = readPositiveInteger(process.env.DEV_SAMPLE_ENTERPRISE_FOLDERS, 12);
const ENTERPRISE_DASHBOARD_COUNT = readPositiveInteger(process.env.DEV_SAMPLE_ENTERPRISE_DASHBOARDS, 72);
const ENTERPRISE_ALERT_RULE_COUNT = readPositiveInteger(process.env.DEV_SAMPLE_ENTERPRISE_ALERT_RULES, 320);
const ENTERPRISE_PANELS_PER_DASHBOARD = readPositiveInteger(process.env.DEV_SAMPLE_ENTERPRISE_PANELS, 8);
const ENTERPRISE_CONCURRENCY = readPositiveInteger(process.env.DEV_SAMPLE_ENTERPRISE_CONCURRENCY, 8);
const ENTERPRISE_ALERT_CONCURRENCY = readPositiveInteger(process.env.DEV_SAMPLE_ENTERPRISE_ALERT_CONCURRENCY, 1);
const ALERT_WRITE_ATTEMPTS = readPositiveInteger(process.env.DEV_SAMPLE_ALERT_WRITE_ATTEMPTS, 8);

const authHeader = `Basic ${Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASSWORD}`).toString('base64')}`;

const samples = {
  alertDashboardUid: 'alert-troubleshooting-demo',
  alertRuleName: 'alert-troubleshooting-demo-5xx',
  dashboardEditingUid: 'dashboard-editing-demo',
  dashboardContextUid: 'dashboard-context-demo',
  metricServiceUid: 'metric-discovery-service-demo',
  metricInfraUid: 'metric-discovery-infra-demo',
};

const enterpriseServices = [
  { id: 'auth', name: 'Auth', team: 'identity-platform', tier: 'platform' },
  { id: 'checkout', name: 'Checkout', team: 'commerce-checkout', tier: 'critical' },
  { id: 'payments', name: 'Payments', team: 'commerce-payments', tier: 'critical' },
  { id: 'catalog', name: 'Catalog', team: 'catalog-core', tier: 'product' },
  { id: 'search', name: 'Search', team: 'discovery', tier: 'product' },
  { id: 'orders', name: 'Orders', team: 'order-management', tier: 'critical' },
  { id: 'notifications', name: 'Notifications', team: 'messaging', tier: 'supporting' },
  { id: 'fulfillment', name: 'Fulfillment', team: 'supply-chain', tier: 'critical' },
  { id: 'billing', name: 'Billing', team: 'finance-platform', tier: 'critical' },
  { id: 'inventory', name: 'Inventory', team: 'supply-chain', tier: 'product' },
  { id: 'analytics', name: 'Analytics', team: 'data-platform', tier: 'supporting' },
  { id: 'recommendations', name: 'Recommendations', team: 'ml-platform', tier: 'product' },
];
const enterpriseEnvironments = ['prod', 'staging', 'dev'];
const enterpriseRegions = ['us-east-1', 'eu-central-1'];
const enterpriseFolderThemes = [
  { key: 'commerce', title: 'Commerce Operations' },
  { key: 'platform', title: 'Platform Engineering' },
  { key: 'customer', title: 'Customer Experience' },
  { key: 'data', title: 'Data and ML' },
  { key: 'security', title: 'Security and Identity' },
  { key: 'infra', title: 'Infrastructure' },
  { key: 'finance', title: 'Finance Systems' },
  { key: 'supply', title: 'Supply Chain' },
  { key: 'exec', title: 'Executive Reporting' },
  { key: 'regional', title: 'Regional SRE' },
  { key: 'shared', title: 'Shared Services' },
  { key: 'experiments', title: 'Product Experiments' },
];

const ALERT_EDITING_GROUP = 'assistant-rule-editing';
const ALERT_EDITING_RULES = [
  {
    uid: 'assistant-edit-5xx-rate',
    title: 'Checkout 5xx rate (rule editing sample)',
    query: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
    threshold: 1,
  },
  {
    uid: 'assistant-edit-request-rate',
    title: 'Checkout request rate (rule editing sample)',
    query: 'sum(rate(http_requests_total[5m]))',
    threshold: 1000,
  },
];
const ALERT_PROVISIONED_RULE = {
  uid: 'assistant-provisioned-5xx',
  title: 'Provisioned 5xx rate (read-only sample)',
  query: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
  threshold: 5,
};

await main();

async function main() {
  await waitForGrafana();
  await seedFolder(FOLDER_UID, FOLDER_TITLE);
  await seedAlertTroubleshootingSample();
  await seedAlertRuleEditingSamples();
  await seedDashboardEditingSample();
  await seedDashboardContextSample();
  await seedDashboardMetricDiscoverySamples();
  const enterpriseSummary = ENTERPRISE_PROFILE_ENABLED ? await seedEnterpriseSamples() : undefined;
  await verifyPrometheusSample();

  log('Seeded development samples:');
  log(`- Alert troubleshooting: ${dashboardUrl(samples.alertDashboardUid, 'alert-troubleshooting', 'viewPanel=1')}`);
  log(`- Alert rule: ${GRAFANA_URL}/alerting/grafana/${samples.alertRuleName}/view`);
  log(
    `- Alert rule editing: group ${ALERT_EDITING_GROUP} (${ALERT_EDITING_RULES.map((rule) => rule.uid).join(', ')}) and provisioned rule ${ALERT_PROVISIONED_RULE.uid}`
  );
  log(`- Dashboard editing: ${dashboardUrl(samples.dashboardEditingUid, 'dashboard-editing')}`);
  log(`- Dashboard context: ${dashboardUrl(samples.dashboardContextUid, 'dashboard-context')}`);
  log(`- Metric discovery service: ${dashboardUrl(samples.metricServiceUid, 'metric-discovery-service')}`);
  log(`- Metric discovery infra: ${dashboardUrl(samples.metricInfraUid, 'metric-discovery-infra')}`);
  if (enterpriseSummary) {
    log(
      `- Enterprise corpus: ${enterpriseSummary.folders} folders, ${enterpriseSummary.dashboards} dashboards, ${enterpriseSummary.alertRules} alert rules`
    );
  }
}

async function waitForGrafana() {
  const timeoutMs = readPositiveInteger(process.env.GRAFANA_START_TIMEOUT_MS, 120_000);
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await grafanaFetch('/api/health');
      if (response.ok) {
        return;
      }
      lastError = new Error(`Grafana health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(1000);
  }

  throw new Error(`Grafana at ${GRAFANA_URL} did not become healthy: ${lastError?.message ?? 'timed out'}`);
}

async function seedFolder(uid, title) {
  const response = await grafanaFetch('/api/folders', {
    method: 'POST',
    body: { uid, title },
  });

  if (response.status === 409 || response.status === 412) {
    log(`Folder ${uid} already exists.`);
    return;
  }

  await expectOk(response, `create folder ${uid}`);
  log(`Seeded folder ${uid}.`);
}

async function seedAlertTroubleshootingSample() {
  const dashboardUid = samples.alertDashboardUid;
  const ruleName = samples.alertRuleName;

  await upsertDashboard({
    folderUid: FOLDER_UID,
    dashboard: {
      uid: dashboardUid,
      title: 'Alert troubleshooting demo',
      tags: ['assistant-dev-sample', 'alert-troubleshooting'],
      timezone: 'browser',
      schemaVersion: 41,
      time: { from: 'now-1h', to: 'now' },
      panels: [
        {
          id: 1,
          title: '5xx rate panel',
          type: 'timeseries',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 0, w: 24, h: 8 },
          fieldConfig: {
            defaults: {
              unit: 'reqps',
              thresholds: {
                mode: 'absolute',
                steps: [
                  { color: 'green', value: null },
                  { color: 'yellow', value: 100 },
                ],
              },
            },
            overrides: [],
          },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
              legendFormat: '5xx request rate',
            },
          ],
        },
      ],
    },
  });

  await deleteAlertRule(ruleName);
  await createAlertRule({
    name: ruleName,
    title: 'High 5xx alert',
    dashboardUid,
    panelId: 1,
    folderUid: FOLDER_UID,
    labels: { severity: 'warning', sample: 'alert-troubleshooting' },
    expressions: {
      A: {
        datasourceUID: PROMETHEUS_UID,
        queryType: '',
        relativeTimeRange: { from: '600s', to: '0s' },
        model: {
          datasource: prometheusDatasource(),
          refId: 'A',
          expr: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
          range: true,
          instant: false,
        },
      },
      B: {
        datasourceUID: '__expr__',
        queryType: '',
        model: { type: 'reduce', reducer: 'last', expression: 'A', refId: 'B' },
      },
      C: {
        datasourceUID: '__expr__',
        queryType: '',
        source: true,
        model: {
          type: 'threshold',
          expression: 'B',
          conditions: [{ evaluator: { type: 'gt', params: [0] }, reducer: { type: 'last' } }],
          refId: 'C',
        },
      },
    },
  });

  log(`Seeded alert troubleshooting sample ${dashboardUid}.`);
}

async function seedDashboardEditingSample() {
  await upsertDashboard({
    folderUid: FOLDER_UID,
    dashboard: {
      uid: samples.dashboardEditingUid,
      title: 'Dashboard editing demo',
      tags: ['assistant-dev-sample', 'dashboard-editing'],
      timezone: 'browser',
      schemaVersion: 41,
      time: { from: 'now-6h', to: 'now' },
      panels: [
        {
          id: 1,
          title: 'Request rate panel',
          type: 'timeseries',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 0, w: 24, h: 8 },
          fieldConfig: { defaults: { unit: 'reqps' }, overrides: [] },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'sum(rate(http_requests_total[5m]))',
              legendFormat: 'requests',
            },
          ],
        },
      ],
    },
  });

  log(`Seeded dashboard editing sample ${samples.dashboardEditingUid}.`);
}

async function seedDashboardContextSample() {
  await upsertDashboard({
    folderUid: FOLDER_UID,
    dashboard: {
      uid: samples.dashboardContextUid,
      title: 'Dashboard context stale demo',
      tags: ['assistant-dev-sample', 'dashboard-context', 'stale'],
      timezone: 'browser',
      schemaVersion: 41,
      time: { from: 'now-6h', to: 'now' },
      templating: {
        list: [
          {
            name: 'route',
            type: 'custom',
            query: '/,/api/orders,/render/report',
            current: { text: '/render/report', value: '/render/report' },
            options: [
              { text: '/', value: '/' },
              { text: '/api/orders', value: '/api/orders' },
              { text: '/render/report', value: '/render/report', selected: true },
            ],
          },
        ],
      },
      panels: [
        {
          id: 1,
          title: 'Request rate by path',
          type: 'timeseries',
          description: 'Intentionally stale: metric and path label no longer match demo Prometheus data.',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 0, w: 24, h: 8 },
          fieldConfig: { defaults: { unit: 'bytes' }, overrides: [] },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'sum by (path) (rate(http_request_total{job="web",path="$route"}[5m]))',
              legendFormat: '{{path}}',
            },
          ],
        },
        {
          id: 2,
          title: 'HTTP error ratio by path',
          type: 'timeseries',
          description: 'Intentionally stale: status_code/path labels are wrong for the demo data.',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 8, w: 24, h: 8 },
          fieldConfig: { defaults: { unit: 'percentunit' }, overrides: [] },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'sum by (vm,path) (rate(http_request_total{job="web",path="$route",status_code=~"5.."}[5m])) / clamp_min(sum by (vm,path) (rate(http_request_total{job="web",path="$route"}[5m])), 1e-9)',
              legendFormat: '{{vm}} {{path}}',
            },
          ],
        },
        {
          id: 3,
          title: 'p95 latency',
          type: 'timeseries',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 16, w: 24, h: 8 },
          fieldConfig: { defaults: { unit: 's' }, overrides: [] },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'histogram_quantile(0.95, sum by (le, vm, route) (rate(http_request_duration_seconds_bucket{job="web",route="$route"}[5m])))',
              legendFormat: '{{vm}} {{route}}',
            },
          ],
        },
      ],
    },
  });

  log(`Seeded dashboard context sample ${samples.dashboardContextUid}.`);
}

async function seedDashboardMetricDiscoverySamples() {
  await upsertDashboard({
    folderUid: FOLDER_UID,
    dashboard: {
      uid: samples.metricServiceUid,
      title: 'Metric discovery service demo',
      tags: ['assistant-dev-sample', 'dashboard-metric-discovery'],
      timezone: 'browser',
      schemaVersion: 41,
      time: { from: 'now-6h', to: 'now' },
      panels: [
        {
          id: 1,
          title: 'HTTP errors and host load',
          type: 'timeseries',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 0, w: 24, h: 8 },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'sum by (vm, route, status) (rate(http_requests_total{status=~"5.."}[5m]))',
              legendFormat: '{{vm}} {{route}} {{status}}',
            },
            {
              refId: 'B',
              datasource: prometheusDatasource(),
              expr: 'avg by(instance) (node_load1{job="node"})',
              legendFormat: '{{instance}} load',
            },
          ],
        },
        {
          id: 2,
          title: 'Route p95 latency',
          type: 'timeseries',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 8, w: 24, h: 8 },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: 'histogram_quantile(0.95, sum by (le, vm, route) (rate(http_request_duration_seconds_bucket[5m])))',
              legendFormat: '{{vm}} {{route}}',
            },
          ],
        },
      ],
    },
  });

  await upsertDashboard({
    folderUid: FOLDER_UID,
    dashboard: {
      uid: samples.metricInfraUid,
      title: 'Metric discovery infra demo',
      tags: ['assistant-dev-sample', 'dashboard-metric-discovery'],
      timezone: 'browser',
      schemaVersion: 41,
      time: { from: 'now-6h', to: 'now' },
      panels: [
        {
          id: 1,
          title: 'CPU busy by instance',
          type: 'timeseries',
          datasource: prometheusDatasource(),
          gridPos: { x: 0, y: 0, w: 24, h: 8 },
          targets: [
            {
              refId: 'A',
              datasource: prometheusDatasource(),
              expr: '100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
              legendFormat: '{{instance}} CPU busy',
            },
          ],
        },
      ],
    },
  });

  log(`Seeded metric discovery samples ${samples.metricServiceUid} and ${samples.metricInfraUid}.`);
}

async function seedEnterpriseSamples() {
  const folderCount = Math.min(ENTERPRISE_FOLDER_COUNT, enterpriseFolderThemes.length);
  const folders = enterpriseFolderThemes.slice(0, folderCount).map((theme, index) => ({
    uid: `enterprise-${theme.key}`,
    title: `Enterprise ${theme.title}`,
    index,
  }));

  log(
    `Seeding enterprise corpus with ${folders.length} folders, ${ENTERPRISE_DASHBOARD_COUNT} dashboards, ${ENTERPRISE_ALERT_RULE_COUNT} alert rules.`
  );
  await mapLimit(folders, ENTERPRISE_CONCURRENCY, (folder) => seedFolder(folder.uid, folder.title));

  const dashboards = Array.from({ length: ENTERPRISE_DASHBOARD_COUNT }, (_, index) =>
    enterpriseDashboardDefinition(index, folders[index % folders.length])
  );
  await mapLimit(dashboards, ENTERPRISE_CONCURRENCY, ({ folderUid, dashboard }) =>
    upsertDashboard({ folderUid, dashboard })
  );

  const alertRules = Array.from({ length: ENTERPRISE_ALERT_RULE_COUNT }, (_, index) =>
    enterpriseAlertRuleDefinition(index, dashboards[index % dashboards.length])
  );
  await mapLimit(alertRules, ENTERPRISE_ALERT_CONCURRENCY, async (rule) => {
    await deleteAlertRule(rule.name);
    await createAlertRule(rule);
  });

  return {
    folders: folders.length,
    dashboards: dashboards.length,
    alertRules: alertRules.length,
  };
}

function enterpriseDashboardDefinition(index, folder) {
  const service = enterpriseServices[index % enterpriseServices.length];
  const env = enterpriseEnvironments[Math.floor(index / enterpriseServices.length) % enterpriseEnvironments.length];
  const region =
    enterpriseRegions[
      Math.floor(index / (enterpriseServices.length * enterpriseEnvironments.length)) % enterpriseRegions.length
    ];
  const uid = `ent-${enterpriseServiceSlug(service)}-${enterpriseEnvSlug(env)}-${enterpriseRegionSlug(region)}-${String(index + 1).padStart(3, '0')}`;
  const title = `Enterprise ${service.name} ${env.toUpperCase()} ${region} operations`;
  const panels = enterprisePanels({ service, env, region }).slice(0, clampInt(ENTERPRISE_PANELS_PER_DASHBOARD, 4, 10));

  return {
    folderUid: folder.uid,
    service,
    env,
    region,
    dashboard: {
      uid,
      title,
      tags: ['assistant-enterprise-sample', 'prod-like', service.team, service.tier, env, region, folder.uid],
      timezone: 'browser',
      schemaVersion: 41,
      time: { from: 'now-6h', to: 'now' },
      templating: enterpriseTemplating({ service, env, region }),
      panels,
    },
  };
}

function enterprisePanels({ service, env, region }) {
  const baseSelector = `service="${service.id}",env="${env}",region="${region}"`;
  const requestSelector = `enterprise_http_requests_total{${baseSelector}}`;
  const errorSelector = `enterprise_http_requests_total{${baseSelector},status=~"5.."}`;
  const panelDefs = [
    {
      title: 'Request rate by route',
      type: 'timeseries',
      unit: 'reqps',
      expr: `sum by (route) (rate(${requestSelector}[$__rate_interval]))`,
      legendFormat: '{{route}}',
    },
    {
      title: '5xx error rate',
      type: 'timeseries',
      unit: 'reqps',
      expr: `sum by (route) (rate(${errorSelector}[$__rate_interval]))`,
      legendFormat: '{{route}} 5xx',
    },
    {
      title: 'p95 request latency',
      type: 'timeseries',
      unit: 's',
      expr: `histogram_quantile(0.95, sum by (le, route) (rate(enterprise_request_duration_seconds_bucket{${baseSelector}}[$__rate_interval])))`,
      legendFormat: '{{route}} p95',
    },
    {
      title: 'Queue depth',
      type: 'timeseries',
      unit: 'short',
      expr: `max by (queue) (enterprise_queue_depth{${baseSelector}})`,
      legendFormat: '{{queue}}',
    },
    {
      title: 'Error budget remaining',
      type: 'stat',
      unit: 'percentunit',
      expr: `min(enterprise_slo_error_budget_remaining_ratio{${baseSelector}})`,
      legendFormat: 'remaining',
    },
    {
      title: 'External dependency errors',
      type: 'timeseries',
      unit: 'eps',
      expr: `sum by (dependency) (rate(enterprise_external_dependency_errors_total{${baseSelector}}[$__rate_interval]))`,
      legendFormat: '{{dependency}}',
    },
    {
      title: 'Cache hit ratio',
      type: 'stat',
      unit: 'percentunit',
      expr: `avg(enterprise_cache_hit_ratio{${baseSelector}})`,
      legendFormat: 'cache',
    },
    {
      title: 'Worker restarts',
      type: 'timeseries',
      unit: 'ops',
      expr: `sum by (worker) (rate(enterprise_worker_restarts_total{${baseSelector}}[$__rate_interval]))`,
      legendFormat: '{{worker}}',
    },
    {
      title: 'Database connections',
      type: 'timeseries',
      unit: 'short',
      expr: `max by (pool) (enterprise_db_connections{${baseSelector}})`,
      legendFormat: '{{pool}}',
    },
    {
      title: 'Traffic mix table',
      type: 'table',
      unit: 'reqps',
      expr: `sum by (method, status, route) (rate(${requestSelector}[$__rate_interval]))`,
      legendFormat: '{{method}} {{status}} {{route}}',
    },
  ];

  return panelDefs.map((panel, index) => enterprisePanel(panel, index));
}

function enterprisePanel(panel, index) {
  const width = panel.type === 'stat' ? 6 : 12;
  const height = panel.type === 'stat' ? 6 : 8;
  const row = Math.floor(index / 2);
  const x = index % 2 === 0 ? 0 : 12;
  const y = row * 8;

  return {
    id: index + 1,
    title: panel.title,
    type: panel.type,
    datasource: prometheusDatasource(),
    gridPos: { x, y, w: width, h: height },
    fieldConfig: { defaults: { unit: panel.unit }, overrides: [] },
    options: panel.type === 'table' ? { showHeader: true } : undefined,
    targets: [
      {
        refId: 'A',
        datasource: prometheusDatasource(),
        expr: panel.expr,
        legendFormat: panel.legendFormat,
        format: panel.type === 'table' ? 'table' : 'time_series',
        instant: panel.type === 'stat',
        range: panel.type !== 'stat',
      },
    ],
  };
}

function enterpriseTemplating({ service, env, region }) {
  return {
    list: [
      customVariable(
        'service',
        enterpriseServices.map((item) => item.id),
        service.id
      ),
      customVariable('env', enterpriseEnvironments, env),
      customVariable('region', enterpriseRegions, region),
    ],
  };
}

function customVariable(name, values, selectedValue) {
  return {
    name,
    type: 'custom',
    query: values.join(','),
    current: { text: selectedValue, value: selectedValue },
    options: values.map((value) => ({ text: value, value, selected: value === selectedValue })),
  };
}

function enterpriseAlertRuleDefinition(index, dashboardEntry) {
  const service = dashboardEntry.service;
  const env = dashboardEntry.env;
  const region = dashboardEntry.region;
  const dashboardUid = dashboardEntry.dashboard.uid;
  const linked = index % 5 !== 0;
  const panelId = [2, 3, 4, 6][index % 4];
  const alertKind = ['5xx', 'latency', 'queue', 'dependency'][index % 4];
  const query = enterpriseAlertQuery({ service, env, region, alertKind });
  const threshold = enterpriseAlertThreshold(alertKind, env);
  const severity = env === 'prod' ? (index % 4 === 0 ? 'critical' : 'warning') : 'info';
  const name = `ent-${String(index + 1).padStart(3, '0')}-${enterpriseServiceSlug(service)}-${enterpriseEnvSlug(env)}-${enterpriseRegionSlug(region)}-${enterpriseAlertKindSlug(alertKind)}`;

  return {
    name,
    title: `${service.name} ${env.toUpperCase()} ${region} ${alertKind} alert`,
    folderUid: dashboardEntry.folderUid,
    dashboardUid: linked ? dashboardUid : undefined,
    panelId: linked ? panelId : undefined,
    labels: {
      severity,
      team: service.team,
      service: service.id,
      env,
      region,
      sample: 'enterprise-prod-like',
    },
    annotations: linked
      ? { runbook_url: `https://runbooks.example.invalid/${service.team}/${service.id}/${alertKind}` }
      : {
          runbook_url: `https://runbooks.example.invalid/${service.team}/${service.id}/${alertKind}`,
          summary: 'Unlinked enterprise seed rule used to stress alert search.',
        },
    expressions: alertExpressions(query, threshold),
  };
}

function enterpriseServiceSlug(service) {
  return service.id.replace(/[^a-z0-9]/g, '').slice(0, 8);
}

function enterpriseEnvSlug(env) {
  return { prod: 'prd', staging: 'stg', dev: 'dev' }[env] ?? env.slice(0, 3);
}

function enterpriseRegionSlug(region) {
  return { 'us-east-1': 'use1', 'eu-central-1': 'euc1' }[region] ?? region.replace(/[^a-z0-9]/g, '').slice(0, 6);
}

function enterpriseAlertKindSlug(alertKind) {
  return { dependency: 'dep', latency: 'lat', queue: 'queue', '5xx': '5xx' }[alertKind] ?? alertKind.slice(0, 5);
}

function enterpriseAlertQuery({ service, env, region, alertKind }) {
  const selector = `service="${service.id}",env="${env}",region="${region}"`;
  switch (alertKind) {
    case 'latency':
      return `histogram_quantile(0.95, sum by (le) (rate(enterprise_request_duration_seconds_bucket{${selector}}[5m])))`;
    case 'queue':
      return `max(enterprise_queue_depth{${selector}})`;
    case 'dependency':
      return `sum(rate(enterprise_external_dependency_errors_total{${selector}}[5m]))`;
    default:
      return `sum(rate(enterprise_http_requests_total{${selector},status=~"5.."}[5m]))`;
  }
}

function enterpriseAlertThreshold(alertKind, env) {
  const envMultiplier = env === 'prod' ? 1 : 3;
  switch (alertKind) {
    case 'latency':
      return 1.8 * envMultiplier;
    case 'queue':
      return 450 * envMultiplier;
    case 'dependency':
      return 3 * envMultiplier;
    default:
      return 1.5 * envMultiplier;
  }
}

async function upsertDashboard({ folderUid, dashboard }) {
  const response = await grafanaFetch('/api/dashboards/db', {
    method: 'POST',
    body: {
      folderUid,
      overwrite: true,
      dashboard,
    },
  });
  await expectOk(response, `upsert dashboard ${dashboard.uid}`);
}

async function deleteAlertRule(name) {
  for (let attempt = 1; attempt <= ALERT_WRITE_ATTEMPTS; attempt += 1) {
    const response = await grafanaFetch(
      `/apis/rules.alerting.grafana.app/v0alpha1/namespaces/${encodeURIComponent(ALERT_NAMESPACE)}/alertrules/${encodeURIComponent(name)}`,
      { method: 'DELETE' }
    );
    if (response.ok || response.status === 404) {
      return;
    }

    const text = await response.text().catch(() => '');
    if (attempt < ALERT_WRITE_ATTEMPTS && isRetryableGrafanaWriteError(text)) {
      await delay(400 * attempt);
      continue;
    }

    throw new Error(`delete alert rule ${name} failed with HTTP ${response.status}${text ? `: ${text}` : ''}`);
  }
}

async function createAlertRule({ name, title, dashboardUid, panelId, folderUid, labels, annotations, expressions }) {
  for (let attempt = 1; attempt <= ALERT_WRITE_ATTEMPTS; attempt += 1) {
    const response = await grafanaFetch(
      `/apis/rules.alerting.grafana.app/v0alpha1/namespaces/${encodeURIComponent(ALERT_NAMESPACE)}/alertrules`,
      {
        method: 'POST',
        body: {
          apiVersion: 'rules.alerting.grafana.app/v0alpha1',
          kind: 'AlertRule',
          metadata: {
            name,
            annotations: compactRecord({ 'grafana.app/folder': folderUid }),
          },
          spec: {
            title,
            trigger: { interval: '1m' },
            for: '2m',
            noDataState: 'NoData',
            execErrState: 'Error',
            labels,
            annotations: compactRecord({
              ...annotations,
              __dashboardUid__: dashboardUid,
              __panelId__: panelId === undefined ? undefined : String(panelId),
            }),
            panelRef:
              dashboardUid && panelId !== undefined
                ? { dashboardUID: dashboardUid, panelID: Number(panelId) }
                : undefined,
            expressions,
          },
        },
      }
    );

    if (response.ok) {
      return;
    }

    const text = await response.text().catch(() => '');
    if (attempt < ALERT_WRITE_ATTEMPTS && (/folder does not exist/i.test(text) || isRetryableGrafanaWriteError(text))) {
      await delay(400 * attempt);
      continue;
    }

    throw new Error(`create alert rule ${name} failed with HTTP ${response.status}${text ? `: ${text}` : ''}`);
  }
}

/**
 * A rule group with two sibling rules, to check that editing one rule leaves the other and the
 * group interval alone, and a rule with API provenance, which the assistant must treat as read-only.
 */
async function seedAlertRuleEditingSamples() {
  const response = await grafanaFetch(`/api/ruler/grafana/api/v1/rules/${encodeURIComponent(FOLDER_UID)}`, {
    method: 'POST',
    body: {
      name: ALERT_EDITING_GROUP,
      interval: '1m',
      rules: ALERT_EDITING_RULES.map((rule) => ({
        for: '2m',
        labels: { sample: 'alert-rule-editing', severity: 'warning' },
        annotations: { summary: rule.title },
        grafana_alert: {
          uid: rule.uid,
          title: rule.title,
          condition: 'C',
          no_data_state: 'NoData',
          exec_err_state: 'Error',
          data: rulerQueries(alertExpressions(rule.query, rule.threshold)),
        },
      })),
    },
  });
  await expectOk(response, `upsert alert rule group ${ALERT_EDITING_GROUP}`);

  const provisioned = {
    uid: ALERT_PROVISIONED_RULE.uid,
    title: ALERT_PROVISIONED_RULE.title,
    folderUID: FOLDER_UID,
    ruleGroup: 'assistant-provisioned',
    condition: 'C',
    for: '5m',
    noDataState: 'NoData',
    execErrState: 'Error',
    labels: { sample: 'alert-rule-editing', severity: 'critical' },
    data: rulerQueries(alertExpressions(ALERT_PROVISIONED_RULE.query, ALERT_PROVISIONED_RULE.threshold)),
  };
  const path = `/api/v1/provisioning/alert-rules/${encodeURIComponent(provisioned.uid)}`;
  const update = await grafanaFetch(path, { method: 'PUT', body: provisioned });
  if (update.status === 404) {
    await expectOk(
      await grafanaFetch('/api/v1/provisioning/alert-rules', { method: 'POST', body: provisioned }),
      `create provisioned alert rule ${provisioned.uid}`
    );
  } else {
    await expectOk(update, `update provisioned alert rule ${provisioned.uid}`);
  }
  log(`Seeded alert rule editing samples in ${FOLDER_UID}.`);
}

/** App Platform expressions as ruler/provisioning API queries. */
function rulerQueries(expressions) {
  return Object.entries(expressions).map(([refId, expression]) => ({
    refId,
    queryType: expression.queryType ?? '',
    datasourceUid: expression.datasourceUID,
    relativeTimeRange: expression.relativeTimeRange
      ? { from: Number.parseInt(expression.relativeTimeRange.from, 10), to: 0 }
      : { from: 0, to: 0 },
    model: expression.model,
  }));
}

function isRetryableGrafanaWriteError(text) {
  return /SQLITE_BUSY|database is locked|sqlstore\.max-retries-reached|InternalError/i.test(text);
}

function alertExpressions(query, threshold) {
  return {
    A: {
      datasourceUID: PROMETHEUS_UID,
      queryType: '',
      relativeTimeRange: { from: '600s', to: '0s' },
      model: {
        datasource: prometheusDatasource(),
        refId: 'A',
        expr: query,
        range: true,
        instant: false,
      },
    },
    B: {
      datasourceUID: '__expr__',
      queryType: '',
      model: { type: 'reduce', reducer: 'last', expression: 'A', refId: 'B' },
    },
    C: {
      datasourceUID: '__expr__',
      queryType: '',
      source: true,
      model: {
        type: 'threshold',
        expression: 'B',
        conditions: [{ evaluator: { type: 'gt', params: [threshold] }, reducer: { type: 'last' } }],
        refId: 'C',
      },
    },
  };
}

async function verifyPrometheusSample() {
  const query = 'sum(rate(http_requests_total{status=~"5.."}[5m]))';
  const path = `/api/datasources/uid/${encodeURIComponent(PROMETHEUS_UID)}/resources/api/v1/query?query=${encodeURIComponent(query)}`;
  const response = await grafanaFetch(path);
  if (!response.ok) {
    log(`Prometheus sample query failed with ${response.status}; dashboards were still seeded.`);
    return;
  }

  const body = await response.json();
  const value = body?.data?.result?.[0]?.value?.[1];
  log(
    value === undefined
      ? 'Prometheus sample query returned no current series.'
      : `Prometheus sample query value: ${value}.`
  );
}

async function grafanaFetch(path, options = {}) {
  const headers = {
    Authorization: authHeader,
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...options.headers,
  };

  return fetch(`${GRAFANA_URL}${path}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function expectOk(response, action) {
  if (response.ok) {
    return;
  }
  const text = await response.text().catch(() => '');
  throw new Error(`${action} failed with HTTP ${response.status}${text ? `: ${text}` : ''}`);
}

function prometheusDatasource() {
  return { uid: PROMETHEUS_UID, type: 'prometheus' };
}

function dashboardUrl(uid, slug, extraQuery) {
  const query = ['orgId=1', 'from=now-1h', 'to=now', extraQuery].filter(Boolean).join('&');
  return `${GRAFANA_URL}/d/${uid}/${slug}?${query}`;
}

function readPositiveInteger(rawValue, fallback) {
  const value = Number(rawValue);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readBooleanEnv(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback;
  }
  return !['0', 'false', 'no', 'off'].includes(String(rawValue).trim().toLowerCase());
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.trunc(Number(value) || min)));
}

async function mapLimit(items, limit, worker) {
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async (_, workerIndex) => {
    for (let index = workerIndex; index < items.length; index += limit) {
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

function compactRecord(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

function log(message) {
  console.log(`[seed-dev-samples] ${message}`);
}
