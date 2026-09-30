import { describeDashboardRemovals } from './dashboardChanges';
import { inspectDashboard } from './dashboardModel';
import { listDashboardQueries } from './dashboardQueries';

const query = (refId: string, expr: string) => ({ refId, expr, datasource: { uid: 'prom-main', type: 'prometheus' } });

function classic(panels: unknown[], variables: string[] = []) {
  return {
    apiVersion: 'dashboard.grafana.app/v1',
    kind: 'Dashboard',
    metadata: { name: 'team-a' },
    spec: { title: 'Team A', panels, templating: { list: variables.map((name) => ({ name, type: 'query' })) } },
  };
}

function v2Panel(title: string, refIds: string[], transformations = 0) {
  return {
    kind: 'Panel',
    spec: {
      title,
      data: {
        kind: 'QueryGroup',
        spec: {
          queries: refIds.map((refId) => ({
            kind: 'PanelQuery',
            spec: { refId, query: { kind: 'DataQuery', group: 'prometheus', spec: { expr: 'up' } } },
          })),
          transformations: Array.from({ length: transformations }, (_, index) => ({
            kind: 'calculateField',
            spec: { id: 'calculateField', options: { alias: `f${index}` } },
          })),
        },
      },
    },
  };
}

describe('describeDashboardRemovals', () => {
  it('reports panels, collapsed-row panels, and variables a rewrite drops', () => {
    const before = classic(
      [
        { id: 1, type: 'timeseries', title: 'One', targets: [query('A', 'up')] },
        { id: 2, type: 'row', title: 'Details', collapsed: true, panels: [{ id: 3, type: 'stat', title: 'Two' }] },
        { id: 4, type: 'stat', title: 'Three' },
      ],
      ['namespace', 'env']
    );
    const after = classic([{ id: 1, type: 'timeseries', title: 'One', targets: [query('A', 'up')] }], ['env']);
    expect(describeDashboardRemovals(before, after)).toEqual([
      'removes 2 of 3 panels: "Two", "Three"',
      'removes variable namespace',
    ]);
  });

  it('reports queries and transformations dropped from a v2 panel that stays', () => {
    const before = { spec: { elements: { 'panel-1': v2Panel('Latency', ['A', 'B'], 5) }, variables: [] } };
    const after = { spec: { elements: { 'panel-1': v2Panel('Latency', ['B'], 2) }, variables: [] } };
    expect(describeDashboardRemovals(before, after)).toEqual([
      'panel "Latency" (panel-1) loses query A',
      'panel "Latency" (panel-1) loses 3 of 5 transformations',
    ]);
  });

  it('accepts additions, edits, and panels matched by title after re-keying', () => {
    const before = classic([{ id: 1, type: 'timeseries', title: 'One', targets: [query('A', 'up')] }], ['env']);
    const after = classic(
      [
        { id: 7, type: 'timeseries', title: 'One', targets: [query('A', 'sum(up)'), query('B', 'up')] },
        { id: 8, type: 'stat', title: 'New' },
      ],
      ['env', 'namespace']
    );
    expect(describeDashboardRemovals(before, after)).toEqual([]);
  });

  it('returns nothing for documents it cannot read', () => {
    expect(describeDashboardRemovals('not json', classic([]))).toEqual([]);
    expect(describeDashboardRemovals(classic([{ id: 1, title: 'One' }]), '{"broken"')).toEqual([]);
  });
});

describe('row paths', () => {
  it('always lists a row path, empty outside rows, in inspect and queries', () => {
    const doc = classic([
      { id: 1, type: 'timeseries', title: 'Top', targets: [query('A', 'up')] },
      { id: 2, type: 'row', title: 'Details', collapsed: false, panels: [] },
      { id: 3, type: 'timeseries', title: 'Inner', targets: [query('A', 'up')] },
    ]);
    expect(inspectDashboard(doc).panels.map((panel) => panel.rowPath)).toEqual([[], ['Details']]);
    expect(listDashboardQueries(doc).map((location) => location.rowPath)).toEqual([[], ['Details']]);

    const v2 = {
      apiVersion: 'dashboard.grafana.app/v2',
      spec: {
        elements: { 'panel-1': v2Panel('Latency', ['A']) },
        layout: {
          kind: 'RowsLayout',
          spec: {
            rows: [
              {
                kind: 'RowsLayoutRow',
                spec: {
                  title: 'Ingest',
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
        variables: [],
      },
    };
    expect(listDashboardQueries(v2).map((location) => location.rowPath)).toEqual([['Ingest']]);
  });
});

describe('builder queries', () => {
  const influx = {
    refId: 'A',
    datasource: { type: 'influxdb', uid: 'influx-main' },
    measurement: 'win service',
    select: [
      [
        { type: 'field', params: ['state'] },
        { type: 'max', params: [] },
      ],
    ],
    tags: [
      { key: 'service::tag', operator: '=', value: 'svc a' },
      { condition: 'AND', key: 'env::tag', operator: '=~', value: '/^$env$/' },
    ],
    groupBy: [
      { type: 'time', params: ['$__interval'] },
      { type: 'tag', params: ['hostname'] },
    ],
  };

  it('describes InfluxDB builder queries in inspect and lists them in queries with the target path', () => {
    const doc = classic([{ id: 1, type: 'stat', title: 'State', targets: [influx] }]);
    const sql =
      'SELECT max("state") FROM "win service" WHERE "service::tag" = \'svc a\' AND "env::tag" =~ /^$env$/ GROUP BY time($__interval), "hostname"';
    expect(inspectDashboard(doc).panels[0].queries).toEqual([
      { refId: 'A', datasourceUid: 'influx-main', datasourceType: 'influxdb', query: sql, builder: true },
    ]);
    expect(listDashboardQueries(doc)).toEqual([
      expect.objectContaining({
        key: '1',
        refId: 'A',
        datasource: { uid: 'influx-main', type: 'influxdb' },
        expr: sql,
        builder: true,
        jqPath: '.spec.panels[0].targets[0]',
      }),
    ]);
  });
});

it('does not describe empty Prometheus queries as builder queries', () => {
  const doc = classic([
    {
      id: 1,
      type: 'timeseries',
      title: 'New',
      datasource: { type: 'prometheus', uid: 'prom-main' },
      targets: [{ refId: 'A', range: true, instant: false }],
    },
  ]);
  expect(inspectDashboard(doc).panels[0].queries).toEqual([
    { refId: 'A', datasourceUid: 'prom-main', datasourceType: 'prometheus' },
  ]);
  expect(listDashboardQueries(doc)).toEqual([]);
});
