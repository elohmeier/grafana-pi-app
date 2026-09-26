import { inspectDashboard, validateDashboardDocument } from './dashboardModel';

describe('inspectDashboard', () => {
  it('summarizes v2 resources with variables, row paths, grid positions, and display settings', () => {
    const inspection = inspectDashboard({
      apiVersion: 'dashboard.grafana.app/v2',
      kind: 'Dashboard',
      metadata: { name: 'app-overview' },
      spec: {
        title: 'Application_Overview',
        tags: ['ops'],
        timeSettings: { from: 'now-6h', to: 'now', autoRefresh: '1m' },
        variables: [
          {
            kind: 'QueryVariable',
            spec: {
              name: 'service',
              label: 'Service',
              current: { text: 'app-a', value: 'app-a' },
              query: { kind: 'DataQuery', spec: { query: 'label_values(service)' } },
            },
          },
        ],
        elements: {
          'panel-12': {
            kind: 'Panel',
            spec: {
              id: 12,
              title: 'Availability',
              description: 'Values above zero indicate an availability issue.',
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
                          spec: { expr: 'avg by (service) (sample_availability_state{service=~"$service"})' },
                        },
                      },
                    },
                  ],
                  transformations: [{ kind: 'organize', spec: { id: 'organize', options: {} } }],
                },
              },
              vizConfig: {
                kind: 'VizConfig',
                group: 'timeseries',
                spec: {
                  fieldConfig: {
                    defaults: {
                      unit: 'short',
                      thresholds: {
                        mode: 'absolute',
                        steps: [
                          { color: 'green', value: 0 },
                          { color: 'red', value: 80 },
                        ],
                      },
                    },
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
                            width: 12,
                            height: 8,
                            element: { kind: 'ElementReference', name: 'panel-12' },
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
      },
    });

    expect(inspection).toMatchObject({
      uid: 'app-overview',
      format: 'v2',
      title: 'Application_Overview',
      time: { from: 'now-6h', to: 'now' },
      refresh: '1m',
      datasourceUids: ['prom-main'],
    });
    expect(inspection.variables).toEqual([
      { name: 'service', type: 'QueryVariable', label: 'Service', query: 'label_values(service)', current: 'app-a' },
    ]);
    expect(inspection.panels).toEqual([
      {
        key: 'panel-12',
        id: 12,
        title: 'Availability',
        type: 'timeseries',
        rowPath: ['Overview'],
        gridPos: { x: 0, y: 0, w: 12, h: 8 },
        description: 'Values above zero indicate an availability issue.',
        datasourceUid: 'prom-main',
        queries: [
          {
            refId: 'A',
            datasourceUid: 'prom-main',
            datasourceType: 'prometheus',
            expr: 'avg by (service) (sample_availability_state{service=~"$service"})',
          },
        ],
        transformations: ['organize'],
        display: { unit: 'short', thresholds: ['0:green', '80:red'], thresholdsMode: 'absolute' },
      },
    ]);
  });
});

describe('validateDashboardDocument v2 variables', () => {
  const resource = (variables: unknown[]) =>
    JSON.stringify({
      apiVersion: 'dashboard.grafana.app/v2',
      kind: 'Dashboard',
      metadata: { name: 'live' },
      spec: { title: 'Live', elements: {}, layout: { kind: 'GridLayout', spec: { items: [] } }, variables },
    });

  it('rejects classic templating entries and malformed query variables', async () => {
    const report = await validateDashboardDocument(
      resource([
        { type: 'query', name: 'job', query: 'label_values(up, job)' },
        { kind: 'QueryVariable', spec: { name: 'env', query: 'label_values(up, env)' } },
      ])
    );
    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.path)).toEqual([
      '.spec.variables[0].kind',
      '.spec.variables[1].spec.query',
    ]);
  });

  it('accepts a v2 query variable', async () => {
    const report = await validateDashboardDocument(
      resource([
        {
          kind: 'QueryVariable',
          spec: {
            name: 'job',
            query: { kind: 'DataQuery', group: 'prometheus', spec: { query: 'label_values(up, job)' } },
          },
        },
      ])
    );
    expect(report.errors).toEqual([]);
  });
});
