import { addPanel, setPanel } from './dashboardPanelEdit';

type AnyRecord = Record<string, any>;

const influxTarget = {
  refId: 'A',
  datasource: { type: 'influxdb', uid: 'influx-main' },
  measurement: 'win service',
  select: [
    [
      { type: 'field', params: ['state'] },
      { type: 'max', params: [] },
    ],
  ],
  tags: [{ key: 'service::tag', operator: '=', value: 'svc a' }],
  groupBy: [{ type: 'tag', params: ['hostname'] }],
  policy: 'default',
  resultFormat: 'time_series',
};

function classicWith(panels: AnyRecord[]): AnyRecord {
  return { spec: { title: 'T', panels } };
}

function v2Query(refId: string, group: string, datasource: string, spec: AnyRecord) {
  return {
    kind: 'PanelQuery',
    spec: { refId, query: { kind: 'DataQuery', group, datasource: { name: datasource }, spec } },
  };
}

function v2With(queries: AnyRecord[]): AnyRecord {
  return {
    spec: {
      title: 'T',
      elements: {
        'panel-1': { kind: 'Panel', spec: { id: 1, title: 'P', data: { kind: 'QueryGroup', spec: { queries } } } },
      },
      layout: { kind: 'GridLayout', spec: { items: [] } },
      variables: [],
    },
  };
}

describe('setPanel queries on non-Prometheus targets', () => {
  it('converts a classic InfluxDB target to Prometheus when --ds is given', () => {
    const doc = classicWith([
      {
        id: 1,
        type: 'stat',
        title: 'State',
        datasource: { type: 'influxdb', uid: 'influx-main' },
        targets: [influxTarget],
      },
    ]);
    setPanel(doc, {
      panel: '1',
      datasourceUid: 'prom-main',
      queries: [{ refId: 'A', expr: 'max by (hostname) ({__name__="win service_state", service="svc a"})' }],
    });
    const panel = doc.spec.panels[0];
    expect(panel.datasource).toEqual({ type: 'prometheus', uid: 'prom-main' });
    expect(panel.targets).toEqual([
      {
        refId: 'A',
        expr: 'max by (hostname) ({__name__="win service_state", service="svc a"})',
        datasource: { type: 'prometheus', uid: 'prom-main' },
      },
    ]);
  });

  it('marks the panel mixed when only some inherited InfluxDB targets are converted', () => {
    const { datasource: _datasource, ...inheriting } = influxTarget;
    const doc = classicWith([
      {
        id: 1,
        type: 'stat',
        title: 'State',
        datasource: { type: 'influxdb', uid: 'influx-main' },
        targets: [inheriting, { ...inheriting, refId: 'B' }],
      },
    ]);
    setPanel(doc, { panel: '1', datasourceUid: 'prom-main', queries: [{ refId: 'A', expr: 'up' }] });
    const panel = doc.spec.panels[0];
    expect(panel.datasource).toEqual({ type: 'datasource', uid: '-- Mixed --' });
    expect(panel.targets.map((target: AnyRecord) => target.datasource)).toEqual([
      { type: 'prometheus', uid: 'prom-main' },
      { type: 'influxdb', uid: 'influx-main' },
    ]);
  });

  it('refuses to put PromQL into a non-Prometheus target without a Prometheus datasource', () => {
    const doc = classicWith([
      {
        id: 1,
        type: 'stat',
        title: 'State',
        datasource: { type: 'influxdb', uid: 'influx-main' },
        targets: [influxTarget],
      },
    ]);
    expect(() => setPanel(doc, { panel: '1', queries: [{ refId: 'A', expr: 'up' }] })).toThrow(
      /query A uses influxdb.*--ds/
    );
  });

  it('converts a v2 query to Prometheus and moves an existing Prometheus query to --ds', () => {
    const doc = v2With([
      v2Query('A', 'influxdb', 'influx-main', { measurement: 'win service', select: [] }),
      v2Query('B', 'prometheus', 'prom-old', { expr: 'up', legendFormat: '{{job}}' }),
    ]);
    setPanel(doc, {
      panel: 'panel-1',
      datasourceUid: 'prom-main',
      queries: [
        { refId: 'A', expr: 'max({__name__="win service_state"})' },
        { refId: 'B', expr: 'sum(up)' },
      ],
    });
    const queries = doc.spec.elements['panel-1'].spec.data.spec.queries.map((query: AnyRecord) => query.spec);
    expect(
      queries.map((query: AnyRecord) => [query.refId, query.query.group, query.query.datasource, query.query.spec])
    ).toEqual([
      ['A', 'prometheus', { name: 'prom-main' }, { expr: 'max({__name__="win service_state"})' }],
      ['B', 'prometheus', { name: 'prom-main' }, { expr: 'sum(up)', legendFormat: '{{job}}' }],
    ]);
  });
});

describe('setPanel refIds', () => {
  it('requires explicit refIds when fewer expressions than queries are given', () => {
    const doc = classicWith([
      {
        id: 1,
        type: 'timeseries',
        title: 'Latency',
        datasource: { type: 'prometheus', uid: 'prom-main' },
        targets: [
          { refId: 'A', expr: 'histogram_quantile(0.5, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))' },
          { refId: 'B', expr: 'histogram_quantile(0.9, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))' },
        ],
      },
    ]);
    expect(() => setPanel(doc, { panel: '1', queries: [{ refId: 'A', expr: 'up' }], refIdsImplicit: true })).toThrow(
      /queries A, B.*--ref/
    );
    setPanel(doc, { panel: '1', queries: [{ refId: 'B', expr: 'up' }] });
    expect(doc.spec.panels[0].targets.map((target: AnyRecord) => target.expr)).toEqual([
      'histogram_quantile(0.5, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))',
      'up',
    ]);
  });
});

const promQuery = { refId: 'A', expr: 'sum(rate(http_requests_total[$__rate_interval]))' };

function classicRows(): AnyRecord {
  const ds = { type: 'prometheus', uid: 'prom-main' };
  return classicWith([
    { id: 1, type: 'row', title: 'Overview', collapsed: false, gridPos: { x: 0, y: 0, w: 24, h: 1 }, panels: [] },
    {
      id: 2,
      type: 'timeseries',
      title: 'Wide',
      datasource: ds,
      gridPos: { x: 0, y: 1, w: 24, h: 8 },
      targets: [promQuery],
    },
    { id: 3, type: 'stat', title: 'Left', datasource: ds, gridPos: { x: 0, y: 9, w: 12, h: 8 }, targets: [promQuery] },
    {
      id: 4,
      type: 'stat',
      title: 'Right',
      datasource: ds,
      gridPos: { x: 12, y: 9, w: 12, h: 8 },
      targets: [promQuery],
    },
    { id: 5, type: 'row', title: 'Ingest', collapsed: false, gridPos: { x: 0, y: 17, w: 24, h: 1 }, panels: [] },
    {
      id: 6,
      type: 'stat',
      title: 'Fetched',
      datasource: ds,
      gridPos: { x: 0, y: 18, w: 8, h: 6 },
      targets: [promQuery],
    },
  ]);
}

function grid(doc: AnyRecord) {
  return Object.fromEntries(
    doc.spec.panels.map((panel: AnyRecord) => [
      panel.title,
      [panel.gridPos.x, panel.gridPos.y, panel.gridPos.w, panel.gridPos.h],
    ])
  );
}

describe('addPanel placement', () => {
  it('places below a full-width anchor and pushes the panels under it down instead of overlapping them', () => {
    const doc = classicRows();
    const report = addPanel(doc, { title: 'New', queries: [promQuery], rightOf: '2' });
    expect(report.position).toEqual({ x: 0, y: 9, w: 12, h: 8 });
    expect(report.note).toMatch(/no room to the right of 2/);
    expect(grid(doc)).toEqual({
      Overview: [0, 0, 24, 1],
      Wide: [0, 1, 24, 8],
      New: [0, 9, 12, 8],
      Right: [12, 9, 12, 8],
      Left: [0, 17, 12, 8],
      Ingest: [0, 25, 24, 1],
      Fetched: [0, 26, 8, 6],
    });
    expect(report.moved).toEqual(['3', '5', '6']);
    // The new panel stays in the anchor's row section.
    expect(doc.spec.panels.map((panel: AnyRecord) => panel.title)).toEqual([
      'Overview',
      'Wide',
      'New',
      'Left',
      'Right',
      'Ingest',
      'Fetched',
    ]);
  });

  it('inserts at the top of a row with --top and keeps the row panels below it', () => {
    const doc = classicRows();
    const report = addPanel(doc, { title: 'First', queries: [promQuery], row: 'Ingest', top: true, w: 12 });
    expect(report.position).toEqual({ x: 0, y: 18, w: 12, h: 8 });
    expect(grid(doc)).toEqual(expect.objectContaining({ First: [0, 18, 12, 8], Fetched: [0, 26, 8, 6] }));
    // Still inside the Ingest row section.
    expect(doc.spec.panels.map((panel: AnyRecord) => panel.title).slice(4)).toEqual(['Ingest', 'First', 'Fetched']);
  });

  it('pushes v2 grid items down when explicit coordinates collide', () => {
    const item = (name: string, x: number, y: number, width: number, height = 8) => ({
      kind: 'GridLayoutItem',
      spec: { x, y, width, height, element: { kind: 'ElementReference', name } },
    });
    const panel = (id: number) => ({
      kind: 'Panel',
      spec: {
        id,
        title: `P${id}`,
        data: { kind: 'QueryGroup', spec: { queries: [v2Query('A', 'prometheus', 'prom-main', { expr: 'up' })] } },
      },
    });
    const doc: AnyRecord = {
      spec: {
        title: 'T',
        elements: { 'panel-1': panel(1), 'panel-2': panel(2) },
        layout: { kind: 'GridLayout', spec: { items: [item('panel-1', 0, 0, 12), item('panel-2', 12, 0, 12)] } },
        variables: [],
      },
    };
    const report = addPanel(doc, { title: 'Top', queries: [promQuery], x: 0, y: 0, w: 24, h: 4 });
    expect(report.moved).toEqual(['panel-1', 'panel-2']);
    expect(doc.spec.layout.spec.items.map((entry: AnyRecord) => [entry.spec.element.name, entry.spec.y])).toEqual([
      ['panel-1', 4],
      ['panel-2', 4],
      ['panel-3', 0],
    ]);
  });
});

describe('addPanel --like', () => {
  it('copies visualization, field config, options, and the query datasource from the reference panel', () => {
    const doc = classicRows();
    const wide = doc.spec.panels[1];
    wide.datasource = { type: 'prometheus', uid: 'prom-other' };
    wide.fieldConfig = {
      defaults: { unit: 'none', thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }] } },
      overrides: [],
    };
    wide.options = { legend: { displayMode: 'table', placement: 'right' } };
    addPanel(doc, {
      title: 'Active',
      queries: [{ refId: 'A', expr: 'sum(http_requests_active)' }],
      below: '2',
      like: '2',
    });
    const added = doc.spec.panels.find((panel: AnyRecord) => panel.title === 'Active');
    expect(added).toEqual(
      expect.objectContaining({
        type: 'timeseries',
        datasource: { type: 'prometheus', uid: 'prom-other' },
        fieldConfig: wide.fieldConfig,
        options: wide.options,
      })
    );
    expect(added.fieldConfig).not.toBe(wide.fieldConfig);
    expect(added.targets[0].datasource).toEqual({ type: 'prometheus', uid: 'prom-other' });
  });

  it('keeps the reference panel datasource for v2 and lets --unit override the copied unit', () => {
    const doc: AnyRecord = {
      spec: {
        title: 'T',
        elements: {
          'panel-1': {
            kind: 'Panel',
            spec: {
              id: 1,
              title: 'Default ds',
              data: {
                kind: 'QueryGroup',
                spec: {
                  queries: [
                    {
                      kind: 'PanelQuery',
                      spec: { refId: 'A', query: { kind: 'DataQuery', group: 'prometheus', spec: { expr: 'up' } } },
                    },
                  ],
                },
              },
              vizConfig: {
                kind: 'VizConfig',
                group: 'stat',
                spec: { options: { colorMode: 'value' }, fieldConfig: { defaults: { unit: 'none' }, overrides: [] } },
              },
            },
          },
          'panel-2': {
            kind: 'Panel',
            spec: {
              id: 2,
              title: 'Named ds',
              data: {
                kind: 'QueryGroup',
                spec: { queries: [v2Query('A', 'prometheus', 'prom-main', { expr: 'up' })] },
              },
            },
          },
        },
        layout: { kind: 'GridLayout', spec: { items: [] } },
        variables: [],
      },
    };
    addPanel(doc, { title: 'Copy', queries: [promQuery], like: 'panel-1', unit: 'reqps' });
    const added = doc.spec.elements['panel-3'].spec;
    expect(added.vizConfig.group).toBe('stat');
    expect(added.vizConfig.spec).toEqual({
      options: { colorMode: 'value' },
      fieldConfig: { defaults: { unit: 'reqps' }, overrides: [] },
    });
    expect(added.data.spec.queries[0].spec.query.datasource).toBeUndefined();
  });
});

describe('setPanel positions', () => {
  it('moves classic panels in the way down when a panel is moved onto them', () => {
    const doc = classicRows();
    const report = setPanel(doc, { panel: '6', x: 0, y: 1, w: 8, h: 6 });
    expect(report.moved).toEqual(['2', '3', '4', '5']);
    expect(grid(doc)).toEqual(
      expect.objectContaining({
        Fetched: [0, 1, 8, 6],
        Wide: [0, 7, 24, 8],
        Left: [0, 15, 12, 8],
        Ingest: [0, 23, 24, 1],
      })
    );
  });
});
