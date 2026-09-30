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

describe('validateDashboardDocument display and layout warnings', () => {
  const ds = { type: 'prometheus', uid: 'prom-main' };
  const classic = (panels: unknown[]) =>
    JSON.stringify({
      apiVersion: 'dashboard.grafana.app/v1',
      kind: 'Dashboard',
      metadata: { name: 'team-a' },
      spec: { title: 'Team A', panels },
    });
  const stat = (id: number, unit: string, expr: string, gridPos = { x: (id - 1) * 6, y: 0, w: 6, h: 4 }) => ({
    id,
    type: 'stat',
    title: `S${id}`,
    datasource: ds,
    gridPos,
    fieldConfig: { defaults: { unit }, overrides: [] },
    targets: [{ refId: 'A', expr }],
  });

  it('warns when a percent unit does not match the scale of the expression', async () => {
    const ratio = 'sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))';
    const report = await validateDashboardDocument(
      classic([
        stat(1, 'percentunit', `100 * ${ratio}`),
        stat(2, 'percent', ratio),
        stat(3, 'percentunit', ratio),
        stat(4, 'percent', `${ratio} * 100`),
        stat(5, 'percentunit', `${ratio} * 1000`),
      ])
    );
    expect(report.warnings.map((warning) => [warning.path, warning.message])).toEqual([
      [
        'panel 1 "S1" query A',
        'unit percentunit expects 0-1, but the expression is multiplied by 100; use unit percent or drop the factor',
      ],
      [
        'panel 2 "S2" query A',
        'unit percent expects 0-100, but the expression looks like a 0-1 ratio; use unit percentunit or multiply by 100',
      ],
    ]);
  });

  it('warns about overlapping panels in classic and v2 grids', async () => {
    const overlapping = await validateDashboardDocument(
      classic([
        stat(1, 'short', 'up', { x: 0, y: 0, w: 12, h: 8 }),
        stat(2, 'short', 'up', { x: 6, y: 4, w: 12, h: 8 }),
        stat(3, 'short', 'up', { x: 0, y: 8, w: 6, h: 4 }),
      ])
    );
    expect(overlapping.warnings.map((warning) => warning.message)).toEqual([
      'panel 1 "S1" overlaps panel 2 "S2"; Grafana moves one of them. Fix the gridPos values (grafana-dashboard set-panel moves panels out of the way).',
    ]);

    const item = (name: string, x: number, y: number) => ({
      kind: 'GridLayoutItem',
      spec: { x, y, width: 12, height: 8, element: { kind: 'ElementReference', name } },
    });
    const panel = (title: string) => ({
      kind: 'Panel',
      spec: { title, data: { kind: 'QueryGroup', spec: { queries: [] } } },
    });
    const v2 = await validateDashboardDocument(
      JSON.stringify({
        apiVersion: 'dashboard.grafana.app/v2',
        kind: 'Dashboard',
        metadata: { name: 'live' },
        spec: {
          title: 'Live',
          elements: { 'panel-1': panel('A'), 'panel-2': panel('B') },
          layout: { kind: 'GridLayout', spec: { items: [item('panel-1', 0, 8), item('panel-2', 0, 8)] } },
          variables: [],
        },
      })
    );
    expect(v2.warnings.map((warning) => warning.message)).toEqual([
      'panel panel-1 "A" overlaps panel panel-2 "B"; Grafana moves one of them. Fix the gridPos values (grafana-dashboard set-panel moves panels out of the way).',
    ]);
  });
});
