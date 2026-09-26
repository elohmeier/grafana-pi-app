const mockDataSourceSrv = {
  getList: jest.fn(),
  get: jest.fn(),
  getInstanceSettings: jest.fn(),
};

jest.mock('@grafana/runtime', () => ({
  config: {
    bootData: {
      user: {
        orgId: 1,
        timezone: 'browser',
      },
    },
  },
  getBackendSrv: jest.fn(),
  isFetchError: (error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error && 'data' in error),
  getDataSourceSrv: () => mockDataSourceSrv,
  locationService: {
    push: jest.fn(),
  },
}));

jest.mock('typebox', () => ({
  Type: {
    Array: jest.fn((items, config) => ({ ...config, items })),
    Any: jest.fn((config) => config ?? {}),
    Boolean: jest.fn((config) => config ?? {}),
    Literal: jest.fn((value, config) => ({ ...config, const: value })),
    Null: jest.fn((config) => ({ ...config, type: 'null' })),
    Number: jest.fn((config) => config ?? {}),
    Object: jest.fn((properties) => ({ properties })),
    Optional: jest.fn((schema) => schema),
    String: jest.fn((config) => config ?? {}),
    Union: jest.fn((items, config) => ({ ...config, items })),
  },
}));

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { DataFrame, DataSourceInstanceSettings } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { of, throwError } from 'rxjs';
import {
  createGrafanaTools,
  buildNavigationPath,
  extractDashboardMetricUsage,
  filterAllowedPrometheusDatasourceSettings,
  getUnavailableDashboardDatasourceUids,
} from './grafanaTools';
import { createLiveDashboardMutationTools } from './tools';
import {
  getDatasourceResource,
  getPrometheusDatasource,
  getPrometheusDatasourceSettings,
  runPrometheusQuerySummaryOrValidationError,
} from './tools/metrics';

const datasourceSettings = [
  { name: 'Prometheus A', uid: 'prom-a', type: 'prometheus', isDefault: true },
  { name: 'Prometheus B', uid: 'prom-b', type: 'prometheus', isDefault: false },
  { name: 'Loki', uid: 'loki', type: 'loki', isDefault: false },
] as unknown as DataSourceInstanceSettings[];

describe('grafana datasource tool policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDataSourceSrv.getList.mockReturnValue(datasourceSettings);
  });

  it('keeps all visible Prometheus datasources when no allow-list is configured', () => {
    expect(filterAllowedPrometheusDatasourceSettings(datasourceSettings)).toEqual([
      datasourceSettings[0],
      datasourceSettings[1],
    ]);
  });

  it('filters datasource discovery to configured UIDs', () => {
    expect(getPrometheusDatasourceSettings({ allowedPrometheusDatasourceUids: ['prom-b'] })).toEqual([
      datasourceSettings[1],
    ]);
  });

  it('uses the first allowed datasource when no UID is requested', async () => {
    const dataSource = { uid: 'prom-b', type: 'prometheus' };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);

    await expect(getPrometheusDatasource({ allowedPrometheusDatasourceUids: ['prom-b'] })).resolves.toBe(dataSource);
    expect(mockDataSourceSrv.get).toHaveBeenCalledWith({ uid: 'prom-b', type: 'prometheus' });
  });

  it('retries transient datasource resource failures transparently', async () => {
    jest.useFakeTimers();
    try {
      const dataSource = {
        uid: 'prom-b',
        type: 'prometheus',
        getResource: jest
          .fn()
          .mockRejectedValueOnce(
            grafanaFetchError(503, 'Service Unavailable', 'upstream Prometheus is temporarily unavailable')
          )
          .mockResolvedValueOnce({ data: ['up'] }),
      };

      const pending = getDatasourceResource(dataSource as any, 'api/v1/label/__name__/values');
      await runPendingRetryTimers();

      await expect(pending).resolves.toEqual({ data: ['up'] });
      expect(dataSource.getResource).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('normalizes datasource resource failures into readable errors', async () => {
    jest.useFakeTimers();
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      getResource: jest
        .fn()
        .mockRejectedValue(
          grafanaFetchError(502, 'Bad Gateway', 'dial tcp 10.0.0.1:9090: connect: connection refused')
        ),
    };

    try {
      const pending = getDatasourceResource(dataSource as any, 'api/v1/label/__name__/values');
      const expectation = expect(pending).rejects.toThrow(
        'Prometheus resource api/v1/label/__name__/values failed for datasource prom-b: resource request for datasource prom-b failed after 3 attempts: Grafana request failed (502 Bad Gateway) while calling GET api/v1/label/__name__/values: dial tcp 10.0.0.1:9090: connect: connection refused'
      );
      await runPendingRetryTimers();

      await expectation;
      expect(dataSource.getResource).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('derives the range query interval from the time range', async () => {
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      query: jest.fn().mockResolvedValue({ state: 'Done', data: [] }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const summary = await runPrometheusQuerySummaryOrValidationError(dataSource as any, {
      query: 'up',
      type: 'range',
      start: 'now-6h',
      end: 'now',
    });
    const request = dataSource.query.mock.calls[0][0];

    expect(request.interval).toBe('30s');
    expect(request.intervalMs).toBe(30000);
    expect(request.maxDataPoints).toBe(1200);
    expect(summary.interval).toBe('30s');
  });

  it('summarizes range query frames instead of returning raw point arrays', async () => {
    const frame = makePrometheusFrame({
      displayName: 'http_requests_total{route="/render/report",vm="vm-web-01"}',
      labels: { route: '/render/report', vm: 'vm-web-01' },
      times: Array.from({ length: 10 }, (_, index) => Date.UTC(2026, 0, 1, 0, 0, index * 30)),
      values: [1, 2, null, 10, 5, 7, 6, 9, 8, 4],
    });
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      query: jest.fn().mockResolvedValue({ state: 'Done', data: [frame] }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const body = await runPrometheusQuerySummaryOrValidationError(dataSource as any, {
      query: 'http_requests_total',
      type: 'range',
      start: 'now-6h',
      end: 'now',
    });

    expect(JSON.stringify(body)).not.toContain('"values"');
    expect(body).toMatchObject({
      datasourceUid: 'prom-b',
      query: 'http_requests_total',
      queryType: 'range',
      interval: '30s',
      frameCount: 1,
      totalSeries: 1,
      truncatedSeries: false,
      notices: [{ severity: 'info', text: 'demo notice' }],
      executedQueryStrings: ['Expr: http_requests_total\nStep: 30s'],
    });
    expect(body.series[0]).toMatchObject({
      name: 'http_requests_total{route="/render/report",vm="vm-web-01"}',
      labels: { route: '/render/report', vm: 'vm-web-01' },
      points: 10,
      nonNullPoints: 9,
      nullPoints: 1,
      last: { time: '2026-01-01T00:04:30.000Z', value: 4 },
      min: { value: 1 },
      max: { value: 10 },
      mean: 5.777778,
      delta: 3,
      deltaPercent: 300,
      calcs: { lastNotNull: 4, min: 1, max: 10, mean: 5.777778 },
    });
    expect(body.series[0]).not.toHaveProperty('samples');
  });

  it('falls back to Prometheus resource queries when datasource range query fails generically', async () => {
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      query: jest.fn().mockResolvedValue({ state: 'Error', errors: [{}], data: [] }),
      getResource: jest.fn().mockResolvedValue({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { route: '/render/report', status: '500' },
              values: [
                [1782982140, '0.1'],
                [1782982170, '0.2'],
              ],
            },
          ],
        },
      }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const body = await runPrometheusQuerySummaryOrValidationError(dataSource as any, {
      query: 'sum by (route) (rate(http_requests_total{status=~"5.."}[5m]))',
      type: 'range',
      start: 'now-6h',
      end: 'now',
    });

    expect(dataSource.getResource).toHaveBeenCalledWith(
      'api/v1/query_range',
      expect.objectContaining({
        query: 'sum by (route) (rate(http_requests_total{status=~"5.."}[5m]))',
        step: '30',
      })
    );
    expect(body).toMatchObject({
      queryType: 'range',
      frameCount: 1,
      totalSeries: 1,
    });
    expect(body.validationError).toBeUndefined();
    expect(body.notices[0].text).toContain('used Prometheus resource fallback');
    expect(body.series[0]).toMatchObject({
      labels: { route: '/render/report', status: '500' },
      points: 2,
      last: { value: 0.2 },
    });
  });

  it('retries transient Prometheus query failures without exposing retry noise', async () => {
    jest.useFakeTimers();
    try {
      const frame = makePrometheusFrame({
        displayName: 'up{job="api"}',
        labels: { job: 'api' },
        times: [Date.UTC(2026, 0, 1, 0, 0, 0)],
        values: [1],
      });
      const dataSource = {
        uid: 'prom-b',
        type: 'prometheus',
        query: jest
          .fn()
          .mockRejectedValueOnce(
            grafanaFetchError(503, 'Service Unavailable', 'upstream Prometheus is temporarily unavailable')
          )
          .mockResolvedValueOnce({ state: 'Done', data: [frame] }),
      };
      mockDataSourceSrv.get.mockResolvedValue(dataSource);
      const pending = runPrometheusQuerySummaryOrValidationError(dataSource as any, { query: 'up{job="api"}' });
      await runPendingRetryTimers();
      const body = await pending;

      expect(dataSource.query).toHaveBeenCalledTimes(2);
      expect(body.validationError).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('failed after');
      expect(body).toMatchObject({ datasourceUid: 'prom-b', totalSeries: 1 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns PromQL validation errors as query summaries instead of throwing', async () => {
    const dataSource = {
      uid: 'prom-b',
      type: 'prometheus',
      query: jest.fn().mockResolvedValue({
        state: 'Error',
        errors: [{ message: 'bad_data: invalid parameter "query": parse error' }],
      }),
    };
    mockDataSourceSrv.get.mockResolvedValue(dataSource);
    const body = await runPrometheusQuerySummaryOrValidationError(dataSource as any, { query: 'rate(node_load1[5m])' });

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      datasourceUid: 'prom-b',
      query: 'rate(node_load1[5m])',
      frameCount: 0,
      totalSeries: 0,
      validationError: 'bad_data: invalid parameter "query": parse error',
      notices: [{ severity: 'error', text: 'bad_data: invalid parameter "query": parse error' }],
      series: [],
    });
  });

  it('finds App Platform alert rules linked to a dashboard panel', async () => {
    const alertRule = {
      apiVersion: 'rules.alerting.grafana.app/v0alpha1',
      kind: 'AlertRule',
      metadata: {
        name: 'high-error-rate',
        annotations: { 'grafana.app/folder': 'service-folder' },
      },
      spec: {
        title: 'High error rate',
        trigger: { interval: '1m' },
        for: '5m',
        noDataState: 'NoData',
        execErrState: 'Error',
        labels: { severity: 'warning' },
        annotations: { __dashboardUid__: 'service-dashboard', __panelId__: '2' },
        panelRef: { dashboardUID: 'service-dashboard', panelID: 2 },
        expressions: {
          A: {
            datasourceUID: 'prom-b',
            relativeTimeRange: { from: '600s', to: '0s' },
            model: {
              refId: 'A',
              expr: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
              range: true,
            },
          },
          B: {
            model: {
              refId: 'B',
              type: 'reduce',
              expression: 'A',
              reducer: 'last',
            },
          },
          C: {
            source: true,
            model: {
              refId: 'C',
              type: 'threshold',
              expression: 'B',
              conditions: [
                {
                  evaluator: { type: 'gt', params: [0.5] },
                  reducer: { type: 'last' },
                },
              ],
            },
          },
        },
      },
    };
    const fetch = jest.fn((request: { url: string }) => {
      if (request.url === '/apis/rules.alerting.grafana.app/v0alpha1/namespaces/default/alertrules') {
        return of({ data: { items: [alertRule] } });
      }
      if (request.url === '/api/dashboards/uid/service-dashboard') {
        return of({
          data: {
            dashboard: {
              panels: [
                {
                  id: 2,
                  title: '5xx rate',
                  type: 'timeseries',
                  datasource: { uid: 'prom-b', type: 'prometheus' },
                  fieldConfig: {
                    defaults: {
                      thresholds: {
                        mode: 'absolute',
                        steps: [
                          { color: 'green', value: null },
                          { color: 'yellow', value: 0.1 },
                        ],
                      },
                    },
                  },
                  targets: [
                    {
                      refId: 'A',
                      datasource: { uid: 'prom-b', type: 'prometheus' },
                      expr: 'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))',
                    },
                  ],
                },
              ],
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'find_panel_alert_rules');

    const result = await tool.execute(
      'call-alerts',
      { namespace: 'default', dashboardUid: 'service-dashboard', panelId: 2 },
      undefined
    );
    const body = JSON.parse(result.content[0].text);

    expect(result.details).toMatchObject({
      namespace: 'default',
      dashboardUid: 'service-dashboard',
      panelId: '2',
      exactPanelMatchCount: 1,
      matchCount: 1,
    });
    expect(body.dashboardPanel).toMatchObject({
      id: '2',
      title: '5xx rate',
      thresholds: { mode: 'absolute' },
    });
    expect(body.matches[0]).toMatchObject({
      reasons: expect.arrayContaining([
        'panelRef+annotations dashboardUID match',
        'panelRef+annotations panelID match',
        'panel link exact match',
      ]),
      rule: {
        name: 'high-error-rate',
        title: 'High error rate',
        folderUid: 'service-folder',
        conditionRef: 'C',
        panelRef: { dashboardUID: 'service-dashboard', panelID: 2 },
        panelLink: { dashboardUID: 'service-dashboard', panelID: 2, source: 'panelRef+annotations' },
        annotations: { __dashboardUid__: 'service-dashboard', __panelId__: '2' },
        alertCondition: {
          sourceRefId: 'C',
          expression: 'B',
          evaluator: { type: 'gt', params: [0.5] },
          reducer: 'last',
        },
        prometheusChecks: [
          {
            refId: 'A',
            datasourceUid: 'prom-b',
            query: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
            type: 'range',
            start: 'now-600s',
            end: 'now',
          },
        ],
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/apis/rules.alerting.grafana.app/v0alpha1/namespaces/default/alertrules',
        method: 'GET',
      })
    );
  });

  it('finds App Platform alert rules linked through Grafana dashboard annotations', async () => {
    const alertRule = {
      apiVersion: 'rules.alerting.grafana.app/v0alpha1',
      kind: 'AlertRule',
      metadata: {
        name: 'annotated-error-rate',
        annotations: { 'grafana.app/folder': 'service-folder' },
      },
      spec: {
        title: 'Annotated high error rate',
        trigger: { interval: '1m' },
        noDataState: 'NoData',
        execErrState: 'Error',
        annotations: { __dashboardUid__: 'service-dashboard', __panelId__: '2' },
        expressions: {
          A: {
            datasourceUID: 'prom-b',
            relativeTimeRange: { from: '600s', to: '0s' },
            model: {
              refId: 'A',
              expr: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
              range: true,
            },
          },
        },
      },
    };
    const fetch = jest.fn((request: { url: string }) => {
      if (request.url === '/apis/rules.alerting.grafana.app/v0alpha1/namespaces/default/alertrules') {
        return of({ data: { items: [alertRule] } });
      }
      if (request.url === '/api/dashboards/uid/service-dashboard') {
        return of({ data: { dashboard: { panels: [{ id: 2, title: '5xx rate', targets: [] }] } } });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'find_panel_alert_rules');

    const result = await tool.execute(
      'call-alerts',
      { namespace: 'default', dashboardUid: 'service-dashboard', panelId: 2 },
      undefined
    );
    const body = JSON.parse(result.content[0].text);

    expect(result.details).toMatchObject({ exactPanelMatchCount: 1, matchCount: 1 });
    expect(body.matches[0]).toMatchObject({
      reasons: expect.arrayContaining([
        'annotations dashboardUID match',
        'annotations panelID match',
        'panel link exact match',
      ]),
      rule: {
        name: 'annotated-error-rate',
        panelLink: { dashboardUID: 'service-dashboard', panelID: 2, source: 'annotations' },
      },
    });
  });

  it('keeps exact panel-linked alert rules even when they appear after the fallback scan window', async () => {
    const unrelatedRules = Array.from({ length: 260 }, (_, index) => ({
      apiVersion: 'rules.alerting.grafana.app/v0alpha1',
      kind: 'AlertRule',
      metadata: { name: `noise-alert-${index}` },
      spec: {
        title: `Noise alert ${index}`,
        labels: { service: 'background' },
        expressions: {
          A: {
            datasourceUID: 'prom-b',
            model: { refId: 'A', expr: `sum(rate(noise_metric_total{service="background-${index}"}[5m]))` },
          },
        },
      },
    }));
    const linkedRule = {
      apiVersion: 'rules.alerting.grafana.app/v0alpha1',
      kind: 'AlertRule',
      metadata: { name: 'late-panel-alert' },
      spec: {
        title: 'Late panel alert',
        annotations: { __dashboardUid__: 'service-dashboard', __panelId__: '7' },
        panelRef: { dashboardUID: 'service-dashboard', panelID: 7 },
        expressions: {
          A: {
            datasourceUID: 'prom-b',
            model: { refId: 'A', expr: 'sum(rate(http_requests_total{status=~"5.."}[5m]))' },
          },
        },
      },
    };
    const fetch = jest.fn((request: { url: string }) => {
      if (request.url === '/apis/rules.alerting.grafana.app/v0alpha1/namespaces/default/alertrules') {
        return of({ data: { items: [...unrelatedRules, linkedRule] } });
      }
      if (request.url === '/api/dashboards/uid/service-dashboard') {
        return of({
          data: {
            dashboard: {
              panels: [
                {
                  id: 7,
                  title: '5xx rate',
                  type: 'timeseries',
                  datasource: { uid: 'prom-b', type: 'prometheus' },
                  targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))' }],
                },
              ],
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'find_panel_alert_rules');

    const result = await tool.execute(
      'call-alerts',
      { namespace: 'default', dashboardUid: 'service-dashboard', panelId: 7 },
      undefined
    );
    const body = JSON.parse(result.content[0].text);

    expect(result.details).toMatchObject({
      ruleCount: 261,
      scannedRuleCount: 250,
      exactPanelMatchCount: 1,
      matchCount: 1,
    });
    expect(body.matches[0].rule.name).toBe('late-panel-alert');
  });

  it('handles unrelated alert rules without Prometheus checks while scanning panel matches', async () => {
    const unrelatedRule = {
      apiVersion: 'rules.alerting.grafana.app/v0alpha1',
      kind: 'AlertRule',
      metadata: { name: 'log-alert' },
      spec: {
        title: 'Log alert',
        expressions: {
          A: {
            datasourceUID: 'loki',
            model: { refId: 'A', expr: '{job="server"} |= "down"' },
          },
        },
      },
    };
    const linkedRule = {
      apiVersion: 'rules.alerting.grafana.app/v0alpha1',
      kind: 'AlertRule',
      metadata: { name: 'availability-alert' },
      spec: {
        title: 'Availability alert',
        annotations: { __dashboardUid__: 'sample-dashboard', __panelId__: '12' },
        panelRef: { dashboardUID: 'sample-dashboard', panelID: 12 },
        expressions: {
          A: {
            datasourceUID: 'prom-b',
            relativeTimeRange: { from: '300s', to: '0s' },
            model: { refId: 'A', expr: 'avg(sample_availability_state{service="app"})', range: true },
          },
        },
      },
    };
    const fetch = jest.fn((request: { url: string }) => {
      if (request.url === '/apis/rules.alerting.grafana.app/v0alpha1/namespaces/default/alertrules') {
        return of({ data: { items: [unrelatedRule, linkedRule] } });
      }
      if (request.url === '/api/dashboards/uid/sample-dashboard') {
        return of({
          data: {
            dashboard: {
              panels: [
                {
                  id: 12,
                  title: 'Availability',
                  type: 'stat',
                  datasource: { uid: 'prom-b', type: 'prometheus' },
                  targets: [{ refId: 'A', expr: 'avg(sample_availability_state{service="app"})' }],
                },
              ],
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-b'] }), 'find_panel_alert_rules');

    const result = await tool.execute(
      'call-alerts',
      { namespace: 'default', dashboardUid: 'sample-dashboard', panelTitle: 'Availability' },
      undefined
    );
    const body = JSON.parse(result.content[0].text);

    expect(result.details).toMatchObject({ matchCount: 1, exactPanelMatchCount: 1 });
    expect(body.matches[0].rule.name).toBe('availability-alert');
  });

  it('summarizes persistent transient query failures after retries are exhausted', async () => {
    jest.useFakeTimers();
    try {
      const dataSource = {
        uid: 'prom-b',
        type: 'prometheus',
        query: jest.fn().mockResolvedValue({
          state: 'Error',
          errors: [{ status: 503, message: '503 Service Unavailable' }],
        }),
      };
      mockDataSourceSrv.get.mockResolvedValue(dataSource);
      const pending = runPrometheusQuerySummaryOrValidationError(dataSource as any, { query: 'up' });
      await runPendingRetryTimers();
      const body = await pending;

      expect(dataSource.query).toHaveBeenCalledTimes(3);
      expect(body).toMatchObject({
        datasourceUid: 'prom-b',
        query: 'up',
        frameCount: 0,
        totalSeries: 0,
        validationError: 'Prometheus query for datasource prom-b failed after 3 attempts: 503 Service Unavailable',
        notices: [
          {
            severity: 'error',
            text: 'Prometheus query for datasource prom-b failed after 3 attempts: 503 Service Unavailable',
          },
        ],
        series: [],
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects an explicit datasource UID outside the allow-list', async () => {
    await expect(getPrometheusDatasource({ allowedPrometheusDatasourceUids: ['prom-b'] }, 'prom-a')).rejects.toThrow(
      'Datasource is not available to the assistant: prom-a'
    );
    expect(mockDataSourceSrv.get).not.toHaveBeenCalled();
  });

  it('reports dashboard datasource UIDs outside the allow-list', () => {
    const dashboard = {
      title: 'Bad dashboard',
      panels: [
        {
          datasource: { type: 'prometheus', uid: 'prom-a' },
          targets: [{ datasource: { type: 'prometheus', uid: 'prom-b' } }],
        },
        {
          datasource: { type: '__expr__', uid: '__expr__' },
        },
        {
          datasource: { type: 'prometheus', uid: '$datasource' },
        },
      ],
    };

    expect(getUnavailableDashboardDatasourceUids(dashboard, { allowedPrometheusDatasourceUids: ['prom-a'] })).toEqual([
      '$datasource',
      'prom-b',
    ]);
  });

  it('returns one fixed tool list with session filesystem tools and without removed Grafana tools', () => {
    const workspaceTools = ['read', 'write', 'edit', 'bash'].map(
      (name) => ({ name, label: name, description: name, parameters: {}, execute: jest.fn() }) as unknown as AgentTool
    );
    const artifacts = {
      register: jest.fn(),
      get: jest.fn(),
      list: jest.fn(() => []),
    };

    const names = createGrafanaTools({ workspaceTools, artifacts }).map((tool) => tool.name);

    expect(names.slice(0, 4)).toEqual(['read', 'write', 'edit', 'bash']);
    expect(names).toEqual(
      expect.arrayContaining([
        'search_dashboard_metric_usage',
        'get_metric_neighborhood',
        'find_panel_alert_rules',
        'get_alert_rule',
        'update_report',
        'navigate',
        'screenshot_dashboard',
        'read_artifact',
      ])
    );
    expect(new Set(names).size).toBe(names.length);
    for (const removed of [
      'list_datasources',
      'list_metrics',
      'list_label_values',
      'inspect_metric_series',
      'query_prometheus',
      'query_prometheus_raw',
      'list_dashboards',
      'get_dashboard',
      'upload_dashboard',
      'delete_dashboard',
      'run_query_agent',
      'run_dashboard_agent',
      'run_investigation_agent',
      'run_alert_agent',
      'run_support_agent',
      'run_navigation_agent',
    ]) {
      expect(names).not.toContain(removed);
    }
    expect(createGrafanaTools({ workspaceTools, artifacts }).map((tool) => tool.name)).toEqual(names);
  });

  it('builds safe Grafana navigation paths', () => {
    expect(buildNavigationPath({ type: 'dashboard', uid: 'service-red', slug: 'Service RED' })).toBe(
      '/d/service-red/service-red'
    );
    expect(buildNavigationPath({ type: 'relative', path: '/dashboards?query=node' })).toBe('/dashboards?query=node');

    const explorePath = buildNavigationPath({
      type: 'prometheus_explore',
      datasourceUid: 'prom-a',
      query: 'up',
    });
    const left = JSON.parse(decodeURIComponent(explorePath.replace('/explore?left=', '')));
    expect(left).toMatchObject({
      datasource: 'prom-a',
      queries: [
        {
          datasource: { type: 'prometheus', uid: 'prom-a' },
          expr: 'up',
        },
      ],
      range: { from: 'now-1h', to: 'now' },
    });

    expect(() => buildNavigationPath({ type: 'relative', path: 'https://example.com' })).toThrow(
      'navigate relative path must be a Grafana-relative path starting with /.'
    );
    expect(() => buildNavigationPath({ type: 'relative', path: '//example.com' })).toThrow(
      'navigate relative path must be a Grafana-relative path starting with /.'
    );
  });

  it('keeps raw dashboard upload/delete and Jsonnet tools out of the tool list', () => {
    const names = createGrafanaTools().map((tool) => tool.name);

    expect(names).toContain('find_panel_alert_rules');
    expect(names).toContain('get_alert_rule');
    expect(names).not.toContain('inspect_dashboard_context');
    expect(names).toContain('screenshot_dashboard');
    expect(names).not.toContain('apply_live_dashboard_mutation');
    for (const removed of [
      'explore_metrics',
      'design_dashboard',
      'explore_jsonnet',
      'write_dashboard_plan',
      'write_jsonnet',
      'edit_jsonnet',
      'fix_jsonnet',
      'read_jsonnet',
      'render_dashboard',
      'save_dashboard',
      'list_jsonnet_libs',
      'search_jsonnet_libs',
      'read_jsonnet_lib',
      'grafana_list_managed_dashboard_templates',
      'read_managed_dashboard_template',
      'search_grafonnet',
      'read_grafonnet',
      'list_grafonnet',
    ]) {
      expect(names).not.toContain(removed);
    }
  });

  it('exposes live dashboard mutation tools only when Grafana provides the restricted API', async () => {
    const withoutApi = createGrafanaTools().map((tool) => tool.name);
    expect(withoutApi).not.toContain('apply_live_dashboard_mutation');

    const dashboardMutation = {
      execute: jest.fn(async ({ type, payload }: { type: string; payload: unknown }) => ({
        success: true,
        changes: [{ path: '/elements/panel-1', previousValue: null, newValue: { type, payload } }],
        data: { ok: true },
      })),
      getPayloadSchema: jest.fn(() => ({}) as any),
      getAvailableCommands: jest.fn(() => [
        'ADD_PANEL',
        'ADD_VARIABLE',
        'GET_DASHBOARD_INFO',
        'GET_LAYOUT',
        'LIST_PANELS',
        'LIST_VARIABLES',
        'MOVE_PANEL',
        'UPDATE_DASHBOARD_SETTINGS',
        'UPDATE_PANEL',
        'UPDATE_VARIABLE',
      ]),
    };
    const tools = createLiveDashboardMutationTools(dashboardMutation);
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([
      'list_live_dashboard_panels',
      'get_live_dashboard_layout',
      'get_live_dashboard_info',
      'list_live_dashboard_variables',
      'get_live_dashboard_mutation_schema',
      'rename_live_dashboard_panel',
      'update_live_dashboard_panel_query',
      'update_live_dashboard_panel_queries',
      'apply_live_dashboard_prometheus_label_filter',
      'add_live_dashboard_panel',
      'move_or_resize_live_dashboard_panel',
      'update_live_dashboard_settings',
      'add_live_dashboard_variable',
      'update_live_dashboard_variable',
      'apply_live_dashboard_mutation',
    ]);

    const listTool = getTool(tools, 'list_live_dashboard_panels');
    const listResult = await listTool.execute('call-1', { includeStatus: true }, undefined);
    expect(dashboardMutation.execute).toHaveBeenCalledWith({
      type: 'LIST_PANELS',
      payload: { includeStatus: true },
    });
    expect(listResult.content[0].text).toContain('Live dashboard mutation LIST_PANELS succeeded');

    const applyTool = getTool(tools, 'apply_live_dashboard_mutation');
    const result = await applyTool.execute(
      'call-2',
      {
        type: 'UPDATE_PANEL',
        payload: {
          element: { kind: 'ElementReference', name: 'panel-1' },
          panel: { kind: 'Panel', spec: { title: 'Renamed' } },
        },
      },
      undefined
    );
    expect(result.details).toMatchObject({ command: 'UPDATE_PANEL', success: true });

    const renameTool = getTool(tools, 'rename_live_dashboard_panel');
    await renameTool.execute('call-3', { elementName: 'panel-1', title: 'Typed rename' }, undefined);
    expect(dashboardMutation.execute).toHaveBeenLastCalledWith({
      type: 'UPDATE_PANEL',
      payload: {
        element: { kind: 'ElementReference', name: 'panel-1' },
        panel: { kind: 'Panel', spec: { title: 'Typed rename' } },
      },
    });

    const queryTool = getTool(tools, 'update_live_dashboard_panel_query');
    await queryTool.execute(
      'call-4',
      { elementName: 'panel-1', queryExpression: 'sum(rate(http_requests_total[$__rate_interval]))' },
      undefined
    );
    expect(dashboardMutation.execute).toHaveBeenLastCalledWith({
      type: 'UPDATE_PANEL',
      payload: {
        element: { kind: 'ElementReference', name: 'panel-1' },
        panel: {
          kind: 'Panel',
          spec: {
            data: {
              kind: 'QueryGroup',
              spec: {
                queries: [
                  {
                    kind: 'PanelQuery',
                    spec: {
                      refId: 'A',
                      query: {
                        kind: 'DataQuery',
                        group: 'prometheus',
                        spec: { expr: 'sum(rate(http_requests_total[$__rate_interval]))' },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });

    const addTool = getTool(tools, 'add_live_dashboard_panel');
    const addResult = await addTool.execute(
      'call-5',
      {
        title: 'Typed added panel',
        queryExpression: 'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))',
        x: 12,
        y: 8,
        width: 12,
        height: 8,
      },
      undefined
    );
    expect(dashboardMutation.execute).toHaveBeenCalledWith({
      type: 'ADD_PANEL',
      payload: {
        panel: {
          kind: 'Panel',
          spec: {
            title: 'Typed added panel',
            data: {
              kind: 'QueryGroup',
              spec: {
                queries: [
                  {
                    kind: 'PanelQuery',
                    spec: {
                      refId: 'A',
                      query: {
                        kind: 'DataQuery',
                        group: 'prometheus',
                        spec: { expr: 'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))' },
                      },
                    },
                  },
                ],
              },
            },
            vizConfig: {
              kind: 'VizConfig',
              group: 'timeseries',
              spec: {
                fieldConfig: { defaults: {}, overrides: [] },
                options: {},
              },
            },
          },
        },
        layoutItem: { kind: 'GridLayoutItem', spec: { x: 12, y: 8, width: 12, height: 8 } },
      },
    });
    expect(dashboardMutation.execute).toHaveBeenLastCalledWith({ type: 'GET_DASHBOARD_INFO', payload: {} });
    expect(addResult.details).toMatchObject({
      command: 'ADD_PANEL',
      success: true,
      visualVerification: { status: 'skipped' },
    });

    const settingsTool = getTool(tools, 'update_live_dashboard_settings');
    await settingsTool.execute('call-6', { title: 'Typed dashboard', tags: ['typed', 'live'] }, undefined);
    expect(dashboardMutation.execute).toHaveBeenLastCalledWith({
      type: 'UPDATE_DASHBOARD_SETTINGS',
      payload: {
        title: 'Typed dashboard',
        tags: ['typed', 'live'],
      },
    });

    const variableTool = getTool(tools, 'add_live_dashboard_variable');
    await variableTool.execute(
      'call-7',
      { name: 'env', variableType: 'custom', options: ['prod', 'staging'], current: 'prod' },
      undefined
    );
    expect(dashboardMutation.execute).toHaveBeenLastCalledWith({
      type: 'ADD_VARIABLE',
      payload: {
        variable: {
          kind: 'CustomVariable',
          spec: {
            name: 'env',
            current: { text: 'prod', value: 'prod' },
            query: 'prod,staging',
            options: [
              { text: 'prod', value: 'prod' },
              { text: 'staging', value: 'staging' },
            ],
          },
        },
      },
    });
  });

  it('preserves the existing live panel query datasource when editing only the expression', async () => {
    const dashboardMutation = {
      execute: jest.fn(async ({ type, payload }: { type: string; payload: unknown }) => {
        if (type === 'LIST_PANELS') {
          return {
            success: true,
            changes: [],
            data: {
              elements: [
                {
                  element: {
                    kind: 'Panel',
                    spec: {
                      data: {
                        kind: 'QueryGroup',
                        spec: {
                          queries: [
                            {
                              kind: 'PanelQuery',
                              spec: {
                                refId: 'A',
                                hidden: true,
                                query: {
                                  kind: 'DataQuery',
                                  group: 'prometheus',
                                  datasource: { name: 'prom-prod' },
                                  spec: { expr: 'sum(rate(old_metric[$__rate_interval]))' },
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              ],
            },
          };
        }

        return {
          success: true,
          changes: [{ path: '/elements/panel-1', previousValue: null, newValue: { type, payload } }],
          data: { ok: true },
        };
      }),
      getPayloadSchema: jest.fn(() => ({}) as any),
      getAvailableCommands: jest.fn(() => ['LIST_PANELS', 'UPDATE_PANEL']),
    };
    const queryTool = getTool(createLiveDashboardMutationTools(dashboardMutation), 'update_live_dashboard_panel_query');

    await queryTool.execute(
      'call-1',
      { elementName: 'panel-1', queryExpression: 'sum(rate(new_metric[$__rate_interval]))' },
      undefined
    );

    expect(dashboardMutation.execute).toHaveBeenNthCalledWith(1, {
      type: 'LIST_PANELS',
      payload: { elements: ['panel-1'] },
    });
    expect(dashboardMutation.execute).toHaveBeenNthCalledWith(2, {
      type: 'UPDATE_PANEL',
      payload: {
        element: { kind: 'ElementReference', name: 'panel-1' },
        panel: {
          kind: 'Panel',
          spec: {
            data: {
              kind: 'QueryGroup',
              spec: {
                queries: [
                  {
                    kind: 'PanelQuery',
                    spec: {
                      refId: 'A',
                      hidden: true,
                      query: {
                        kind: 'DataQuery',
                        group: 'prometheus',
                        datasource: { name: 'prom-prod' },
                        spec: { expr: 'sum(rate(new_metric[$__rate_interval]))' },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });
  });

  it('does not expose live dashboard mutation tools when no dashboard client is active', async () => {
    const dashboardMutation = {
      execute: jest.fn(),
      getPayloadSchema: jest.fn(() => ({}) as any),
      getAvailableCommands: jest.fn(() => []),
    };
    const names = createLiveDashboardMutationTools(dashboardMutation).map((tool) => tool.name);

    expect(names).not.toContain('rename_live_dashboard_panel');
    expect(names).not.toContain('apply_live_dashboard_mutation');
    expect(dashboardMutation.execute).not.toHaveBeenCalled();
  });

  it('keeps read-only dashboard mutation commands out of the live apply tool', async () => {
    const dashboardMutation = {
      execute: jest.fn(),
      getPayloadSchema: jest.fn(() => ({}) as any),
      getAvailableCommands: jest.fn(() => ['LIST_PANELS']),
    };
    const applyTool = getTool(createLiveDashboardMutationTools(dashboardMutation), 'apply_live_dashboard_mutation');

    await expect(applyTool.execute('call-1', { type: 'LIST_PANELS', payload: {} }, undefined)).rejects.toThrow(
      'LIST_PANELS is read-only'
    );
    expect(dashboardMutation.execute).not.toHaveBeenCalled();
  });

  it('extracts dashboard metric usage with PromQL parser-backed labels and relations', () => {
    const result = extractDashboardMetricUsage(makeDashboardMetricUsageFixture('metric-context', 'Metric Context'), {
      uid: 'metric-context',
      meta: {
        folderTitle: 'Observability',
        url: '/d/metric-context/metric-context',
      },
      allowedPrometheusDatasourceUids: ['prom-a'],
    });

    expect(result.metrics.map((metric) => metric.metric)).toEqual(
      expect.arrayContaining(['http_requests_total', 'http_request_duration_seconds_bucket', 'node_load1'])
    );
    expect(result.metrics.find((metric) => metric.metric === 'http_requests_total')).toMatchObject({
      labels: expect.arrayContaining(['route', 'status']),
      groupingLabels: expect.arrayContaining(['route', 'status', 'vm']),
      functions: expect.arrayContaining(['rate', 'sum']),
      dashboardCount: 1,
    });
    expect(result.usages.find((usage) => usage.metric === 'http_requests_total')).toMatchObject({
      datasourceUid: 'prom-a',
      dashboardUid: 'metric-context',
      panelTitle: 'HTTP errors and host load',
      selector: 'http_requests_total{status=~"5..",route="$route"}',
    });
    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'http_requests_total',
          target: 'node_load1',
          reasons: expect.arrayContaining(['same panel']),
        }),
      ])
    );
  });

  it('preserves empty grouping labels and functions for a labeled selector without aggregation', () => {
    const result = extractDashboardMetricUsage(
      makeSingleQueryDashboardMetricUsageFixture('App_Sold_http_transaction_time_sold{DomainName=~"$Sold_Domain"}'),
      {
        uid: 'metric-context',
        allowedPrometheusDatasourceUids: ['prom-a'],
      }
    );

    expect(result.usages[0]).toMatchObject({
      metric: 'App_Sold_http_transaction_time_sold',
      labels: [{ name: 'DomainName', operator: '=~', value: '$Sold_Domain' }],
      groupingLabels: [],
      functions: [],
    });
    expect(result.metrics[0]).toMatchObject({
      metric: 'App_Sold_http_transaction_time_sold',
      labels: ['DomainName'],
      groupingLabels: [],
      functions: [],
    });
  });

  it('preserves empty metric facts for a bare metric selector', () => {
    const result = extractDashboardMetricUsage(makeSingleQueryDashboardMetricUsageFixture('node_load1'), {
      uid: 'metric-context',
      allowedPrometheusDatasourceUids: ['prom-a'],
    });

    expect(result.usages[0]).toMatchObject({
      metric: 'node_load1',
      labels: [],
      groupingLabels: [],
      functions: [],
    });
    expect(result.metrics[0]).toMatchObject({
      metric: 'node_load1',
      labels: [],
      groupingLabels: [],
      functions: [],
    });
  });

  it('extracts dashboard metric usage from dashboard.grafana.app v2 specs', () => {
    const result = extractDashboardMetricUsage(makeDashboardMetricUsageV2Fixture('Metric Context V2'), {
      uid: 'metric-context-v2',
      meta: {
        folderTitle: 'Observability',
        url: '/d/metric-context-v2/metric-context-v2',
      },
      allowedPrometheusDatasourceUids: ['prom-main'],
    });

    expect(result.dashboard).toMatchObject({
      uid: 'metric-context-v2',
      title: 'Metric Context V2',
      folderTitle: 'Observability',
    });
    expect(result.metrics.map((metric) => metric.metric)).toEqual(
      expect.arrayContaining(['sample_requests_total', 'sample_request_duration_seconds_bucket'])
    );
    expect(result.usages.find((usage) => usage.metric === 'sample_requests_total')).toMatchObject({
      datasourceUid: 'prom-main',
      datasourceType: 'prometheus',
      panelTitle: 'HTTP requests',
      panelType: 'timeseries',
      rowPath: ['Overview'],
      refId: 'A',
      unit: 'reqps',
      selector: 'sample_requests_total{status=~"5..",service="$service"}',
    });
  });

  it('inspects dashboard metric usage from dashboard.grafana.app v2 resource responses', async () => {
    const fetch = jest.fn(({ url }) => {
      if (url === '/api/dashboards/uid/metric-context-v2') {
        return of({
          data: {
            metadata: { name: 'metric-context-v2' },
            spec: makeDashboardMetricUsageV2Fixture('Metric Context V2'),
            meta: {
              folderTitle: 'Observability',
              url: '/d/metric-context-v2/metric-context-v2',
            },
          },
        });
      }

      return throwError(() => new Error(`unexpected fetch: ${url}`));
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    const tool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-main'] }),
      'inspect_dashboard_metric_usage'
    );

    const result = await tool.execute('call-1', { uid: 'metric-context-v2' }, undefined);
    const body = JSON.parse(result.content[0].text);

    expect(body.metrics.map((metric: { metric: string }) => metric.metric)).toContain('sample_requests_total');
    expect(body.usages[0]).toMatchObject({
      dashboardUid: 'metric-context-v2',
      panelTitle: 'HTTP requests',
      datasourceUid: 'prom-main',
    });
    expect(result.details).toMatchObject({
      uid: 'metric-context-v2',
      title: 'Metric Context V2',
      metricCount: 2,
      usageCount: 2,
    });
  });

  it('searches visible dashboards for metric usage and ranks seed metric neighborhoods', async () => {
    const fetch = jest.fn(({ url }) => {
      if (url === '/api/search') {
        return of({
          data: [
            {
              uid: 'metric-context',
              title: 'Metric Context',
              url: '/d/metric-context/metric-context',
              folderTitle: 'Observability',
            },
            {
              uid: 'infra-context',
              title: 'Infra Context',
              url: '/d/infra-context/infra-context',
              folderTitle: 'Observability',
            },
          ],
        });
      }

      if (url === '/api/dashboards/uid/metric-context') {
        return of({
          data: {
            dashboard: makeDashboardMetricUsageFixture('metric-context', 'Metric Context'),
            meta: {
              folderTitle: 'Observability',
              url: '/d/metric-context/metric-context',
            },
          },
        });
      }

      if (url === '/api/dashboards/uid/infra-context') {
        return of({
          data: {
            dashboard: {
              uid: 'infra-context',
              title: 'Infra Context',
              panels: [
                {
                  id: 1,
                  title: 'CPU busy',
                  type: 'timeseries',
                  datasource: { uid: 'prom-a', type: 'prometheus' },
                  targets: [
                    {
                      refId: 'A',
                      expr: '100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval])) * 100)',
                    },
                  ],
                },
              ],
            },
            meta: {
              folderTitle: 'Observability',
              url: '/d/infra-context/infra-context',
            },
          },
        });
      }

      return throwError(() => new Error(`unexpected fetch: ${url}`));
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    const searchTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'search_dashboard_metric_usage'
    );
    const search = await searchTool.execute(
      'call-1',
      { query: 'Context', seedMetric: 'http_requests_total' },
      undefined
    );
    const searchBody = JSON.parse(search.content[0].text);

    expect(searchBody.dashboards).toHaveLength(2);
    expect(searchBody.metrics.map((metric: { metric: string }) => metric.metric)).toEqual(
      expect.arrayContaining([
        'http_requests_total',
        'http_request_duration_seconds_bucket',
        'node_load1',
        'node_cpu_seconds_total',
      ])
    );
    expect(search.details).toMatchObject({
      dashboardCount: 2,
      seedMetrics: ['http_requests_total'],
      summarized: true,
    });

    const neighborhoodTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'get_metric_neighborhood'
    );
    const neighborhood = await neighborhoodTool.execute(
      'call-2',
      { metric: 'http_requests_total', query: 'Context' },
      undefined
    );
    const neighborhoodBody = JSON.parse(neighborhood.content[0].text);

    expect(neighborhoodBody.neighbors.map((metric: { metric: string }) => metric.metric)).toEqual(
      expect.arrayContaining(['http_request_duration_seconds_bucket', 'node_load1'])
    );
    expect(neighborhood.details).toMatchObject({
      seedMetrics: ['http_requests_total'],
      dashboardCount: 2,
      summarized: true,
    });
  });

  it('returns stable empty arrays when dashboard metric search has no matches', async () => {
    const fetch = jest.fn(({ url }) => {
      if (url === '/api/search') {
        return of({ data: [] });
      }

      return throwError(() => new Error(`unexpected fetch: ${url}`));
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    const searchTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'search_dashboard_metric_usage'
    );
    const search = await searchTool.execute(
      'call-1',
      { query: 'Missing Context', seedMetric: 'http_requests_total' },
      undefined
    );
    const searchBody = JSON.parse(search.content[0].text);

    expect(searchBody).toMatchObject({
      seedMetrics: ['http_requests_total'],
      dashboards: [],
      metrics: [],
      usages: [],
      relations: [],
    });
    expect(search.details).toMatchObject({
      dashboardCount: 0,
      metricCount: 0,
      usageCount: 0,
      relationCount: 0,
      seedMetrics: ['http_requests_total'],
    });

    const neighborhoodTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'get_metric_neighborhood'
    );
    const neighborhood = await neighborhoodTool.execute(
      'call-2',
      { metric: 'http_requests_total', query: 'Missing Context' },
      undefined
    );
    const neighborhoodBody = JSON.parse(neighborhood.content[0].text);

    expect(neighborhoodBody).toMatchObject({
      seedMetrics: ['http_requests_total'],
      dashboards: [],
      neighbors: [],
      relations: [],
      usages: [],
    });
    expect(neighborhood.details).toMatchObject({
      seedMetrics: ['http_requests_total'],
      dashboardCount: 0,
      neighborCount: 0,
      relationCount: 0,
    });
  });

  it('relaxes dashboard metric search for non-contiguous dashboard title terms', async () => {
    const fetch = jest.fn(({ url, params }) => {
      if (url === '/api/search' && params?.query === 'Metric Context abc123') {
        return of({ data: [] });
      }

      if (url === '/api/search' && params?.query === 'metric context') {
        return of({
          data: [
            {
              uid: 'metric-context-service-abc123',
              title: 'Metric Context Service abc123',
              url: '/d/metric-context-service-abc123/metric-context-service-abc123',
              folderTitle: 'Observability',
            },
          ],
        });
      }

      if (url === '/api/dashboards/uid/metric-context-service-abc123') {
        return of({
          data: {
            dashboard: makeDashboardMetricUsageFixture(
              'metric-context-service-abc123',
              'Metric Context Service abc123'
            ),
            meta: {
              folderTitle: 'Observability',
              url: '/d/metric-context-service-abc123/metric-context-service-abc123',
            },
          },
        });
      }

      return throwError(() => new Error(`unexpected fetch: ${url}`));
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });

    const searchTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'search_dashboard_metric_usage'
    );
    const search = await searchTool.execute(
      'call-1',
      { query: 'Metric Context abc123', seedMetric: 'http_requests_total' },
      undefined
    );
    const body = JSON.parse(search.content[0].text);

    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/search' }));
    expect(body.dashboards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uid: 'metric-context-service-abc123',
          title: 'Metric Context Service abc123',
        }),
      ])
    );
    expect(body.metrics.map((metric: { metric: string }) => metric.metric)).toContain('http_requests_total');
    expect(search.details).toMatchObject({ dashboardCount: 1, metricCount: expect.any(Number) });
  });

  it('normalizes dashboard metric context tool arguments before validation', () => {
    const searchTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'search_dashboard_metric_usage'
    );
    expect(
      searchTool.prepareArguments?.({
        query: ['Metric', 'Context'],
        seedMetrics: 'http_requests_total',
        maxDashboards: '2',
      })
    ).toMatchObject({
      query: 'Metric Context',
      seedMetrics: ['http_requests_total'],
      maxDashboards: 2,
    });

    const neighborhoodTool = getTool(
      createGrafanaTools({ allowedPrometheusDatasourceUids: ['prom-a'] }),
      'get_metric_neighborhood'
    );
    expect(
      neighborhoodTool.prepareArguments?.({
        seedMetric: 'http_requests_total',
        metrics: 'node_load1,node_cpu_seconds_total',
        uid: 'metric-context',
      })
    ).toMatchObject({
      metric: 'http_requests_total',
      metrics: ['node_load1', 'node_cpu_seconds_total'],
      dashboardUid: 'metric-context',
    });
  });
});

function getTool(tools: AgentTool[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }

  return tool as Omit<AgentTool, 'execute'> & {
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
  };
}

async function runPendingRetryTimers() {
  await Promise.resolve();
  await jest.runAllTimersAsync();
}

function grafanaFetchError(status: number, statusText: string, message: string) {
  return {
    status,
    statusText,
    data: { message },
    config: { method: 'GET', url: 'api/v1/label/__name__/values' },
  };
}

function makeDashboardMetricUsageFixture(uid: string, title: string) {
  return {
    uid,
    title,
    tags: ['metric-context'],
    templating: {
      list: [
        {
          name: 'route',
          type: 'custom',
          current: { text: '/render/report', value: '/render/report' },
          query: '/,/render/report',
        },
      ],
    },
    panels: [
      {
        id: 1,
        title: 'HTTP errors and host load',
        type: 'timeseries',
        datasource: { uid: 'prom-a', type: 'prometheus' },
        fieldConfig: { defaults: { unit: 'reqps' } },
        targets: [
          {
            refId: 'A',
            expr: 'sum by (vm, route, status) (rate(http_requests_total{status=~"5..",route="$route"}[$__rate_interval]))',
            legendFormat: '{{vm}} {{route}} {{status}}',
          },
          {
            refId: 'B',
            expr: 'avg by(instance) (node_load1{job="node"})',
            legendFormat: '{{instance}} load',
          },
        ],
      },
      {
        id: 2,
        title: 'Route p95 latency',
        type: 'timeseries',
        datasource: { uid: 'prom-a', type: 'prometheus' },
        fieldConfig: { defaults: { unit: 's' } },
        targets: [
          {
            refId: 'A',
            expr: 'histogram_quantile(0.95, sum by (le, vm, route) (rate(http_request_duration_seconds_bucket{route="$route"}[$__rate_interval])))',
            legendFormat: '{{vm}} {{route}}',
          },
        ],
      },
    ],
  };
}

function makeSingleQueryDashboardMetricUsageFixture(expr: string) {
  return {
    uid: 'metric-context',
    title: 'Metric Context',
    panels: [
      {
        id: 1,
        title: 'Single query',
        type: 'timeseries',
        datasource: { uid: 'prom-a', type: 'prometheus' },
        targets: [{ refId: 'A', expr }],
      },
    ],
  };
}

function makeDashboardMetricUsageV2Fixture(title: string) {
  return {
    title,
    tags: ['metric-context'],
    timeSettings: { from: 'now-6h', to: 'now', autoRefresh: '1m' },
    elements: {
      'panel-1': {
        kind: 'Panel',
        spec: {
          id: 1,
          title: 'HTTP requests',
          description: 'Sample request volume and errors.',
          data: {
            kind: 'QueryGroup',
            spec: {
              queries: [
                {
                  kind: 'PanelQuery',
                  spec: {
                    refId: 'A',
                    query: {
                      kind: 'DataQuery',
                      group: 'prometheus',
                      datasource: { name: 'prom-main' },
                      spec: {
                        expr: 'sum by (service, status) (rate(sample_requests_total{status=~"5..",service="$service"}[$__rate_interval]))',
                        legendFormat: '{{service}} {{status}}',
                      },
                    },
                  },
                },
                {
                  kind: 'PanelQuery',
                  spec: {
                    refId: 'B',
                    query: {
                      kind: 'DataQuery',
                      group: 'prometheus',
                      datasource: { name: 'prom-main' },
                      spec: {
                        expr: 'histogram_quantile(0.95, sum by (le, service) (rate(sample_request_duration_seconds_bucket{service="$service"}[$__rate_interval])))',
                        legendFormat: '{{service}} p95',
                      },
                    },
                  },
                },
              ],
              transformations: [],
              queryOptions: {},
            },
          },
          vizConfig: {
            kind: 'VizConfig',
            group: 'timeseries',
            spec: {
              fieldConfig: {
                defaults: { unit: 'reqps' },
                overrides: [],
              },
            },
          },
        },
      },
    },
    layout: {
      kind: 'RowsLayout',
      spec: {
        rows: [
          {
            kind: 'RowsLayoutRow',
            spec: {
              title: 'Overview',
              layout: {
                kind: 'GridLayout',
                spec: {
                  items: [
                    {
                      kind: 'GridLayoutItem',
                      spec: {
                        x: 0,
                        y: 0,
                        width: 24,
                        height: 8,
                        element: { kind: 'ElementReference', name: 'panel-1' },
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
    variables: [
      {
        kind: 'QueryVariable',
        spec: {
          name: 'service',
          current: { text: 'app-a', value: 'app-a' },
          query: {
            kind: 'DataQuery',
            group: 'prometheus',
            datasource: { name: 'prom-main' },
            spec: { query: 'label_values(sample_requests_total, service)' },
          },
        },
      },
    ],
  };
}

function makePrometheusFrame(options: {
  displayName: string;
  labels: Record<string, string>;
  times: number[];
  values: Array<number | null>;
}): DataFrame {
  return {
    name: 'A',
    length: options.values.length,
    fields: [
      {
        name: 'Time',
        type: 'time',
        values: options.times,
        config: {},
      },
      {
        name: 'Value',
        type: 'number',
        labels: options.labels,
        values: options.values,
        config: {
          displayNameFromDS: options.displayName,
        },
      },
    ],
    meta: {
      notices: [{ severity: 'info', text: 'demo notice' }],
      executedQueryString: 'Expr: http_requests_total\nStep: 30s',
    },
  } as unknown as DataFrame;
}

type ToolResult = {
  content: Array<{ text: string }>;
  details: Record<string, unknown>;
};
