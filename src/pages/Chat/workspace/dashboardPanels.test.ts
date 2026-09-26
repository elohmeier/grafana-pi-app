import {
  applyVariableOverrides,
  collectPanels,
  collectVariables,
  prepareTargets,
  unresolvedVariables,
  unwrapDashboard,
  walkClassicPanels,
} from './dashboardPanels';
import { checkDashboardPromql, type PromqlParser } from './promqlCheck';

const classic = {
  apiVersion: 'dashboard.grafana.app/v1',
  kind: 'Dashboard',
  metadata: { name: 'svc' },
  spec: {
    title: 'Service',
    templating: {
      list: [
        { name: 'job', multi: true, current: { value: ['api', 'web.v1'], text: ['api', 'web.v1'] } },
        { name: 'env', current: { value: 'prod "eu"' } },
      ],
    },
    panels: [
      {
        id: 1,
        type: 'timeseries',
        title: 'Requests',
        datasource: { uid: 'prom', type: 'prometheus' },
        targets: [
          { refId: 'A', expr: 'sum(rate(http_requests_total{job=~"$job", env="${env}"}[$__rate_interval]))' },
          { refId: 'B', expr: 'up', hide: true },
          { refId: 'C', datasource: { type: '__expr__', uid: '__expr__' }, type: 'math', expression: '$A * 2' },
        ],
      },
      {
        id: 2,
        type: 'row',
        title: 'Details',
        collapsed: true,
        panels: [{ id: 3, type: 'stat', title: 'Hidden', targets: [{ refId: 'A', expr: 'up{job="$missing"}' }] }],
      },
    ],
  },
};

const clone = (value: unknown): any => JSON.parse(JSON.stringify(value));

describe('dashboard walker', () => {
  it('walks classic resources, collapsed rows, and hidden targets', () => {
    const [shape, dashboard] = unwrapDashboard(classic);
    expect(shape).toBe('classic');
    expect(collectPanels(shape, dashboard).map((panel) => panel.id)).toEqual(['1']);
    const all = collectPanels(shape, dashboard, { includeCollapsed: true, includeHiddenTargets: true });
    expect(all.map((panel) => [panel.id, panel.row, panel.collapsed])).toEqual([
      ['1', undefined, undefined],
      ['3', 'Details', true],
    ]);
    expect(all[0].targets.map((target) => target.refId)).toEqual(['A', 'B', 'C']);
    expect(all[0].targets[0].datasource).toEqual({ uid: 'prom', type: 'prometheus' });
  });

  it('keeps hidden targets that a visible expression depends on', () => {
    const resource = clone(classic);
    resource.spec.panels[0].targets[0].hide = true;
    const [shape, dashboard] = unwrapDashboard(resource);
    expect(collectPanels(shape, dashboard)[0].targets.map((target) => target.refId)).toEqual(['A', 'C']);
  });

  it('interpolates variables with Prometheus escaping and overrides', () => {
    const [shape, dashboard] = unwrapDashboard(classic);
    const variables = collectVariables(shape, dashboard);
    const [panel] = collectPanels(shape, dashboard);
    expect(prepareTargets(panel, variables)[0].expr).toBe(
      'sum(rate(http_requests_total{job=~"(api|web\\\\.v1)", env="prod \\"eu\\""}[$__rate_interval]))'
    );
    applyVariableOverrides(variables, ['job=checkout']);
    expect(prepareTargets(panel, variables)[0].expr).toContain('job=~"checkout"');
    expect(unresolvedVariables('up{job="$missing"} + label_replace(up, "a", "$1", "b", "(.*)")')).toEqual(['missing']);
  });

  it('walks v2 specs in layout order', () => {
    const [shape, dashboard] = unwrapDashboard({
      spec: {
        title: 'V2',
        elements: {
          b: {
            kind: 'Panel',
            spec: {
              id: 2,
              title: 'Second',
              vizConfig: { group: 'stat' },
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
                          datasource: { name: 'prom' },
                          spec: { expr: 'up' },
                        },
                      },
                    },
                  ],
                  transformations: [{ kind: 'reduce', spec: { id: 'reduce', options: {} } }],
                },
              },
            },
          },
          a: { kind: 'Panel', spec: { id: 1, title: 'First', vizConfig: { group: 'timeseries' } } },
        },
        layout: {
          kind: 'TabsLayout',
          spec: {
            tabs: [
              {
                kind: 'TabsLayoutTab',
                spec: {
                  layout: {
                    kind: 'GridLayout',
                    spec: {
                      items: [{ kind: 'GridLayoutItem', spec: { element: { kind: 'ElementReference', name: 'a' } } }],
                    },
                  },
                },
              },
              {
                kind: 'TabsLayoutTab',
                spec: {
                  layout: {
                    kind: 'GridLayout',
                    spec: {
                      items: [{ kind: 'GridLayoutItem', spec: { element: { kind: 'ElementReference', name: 'b' } } }],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    });
    const panels = collectPanels(shape, dashboard);
    expect(panels.map((panel) => panel.key)).toEqual(['a', 'b']);
    expect(panels[1].targets[0]).toMatchObject({
      refId: 'A',
      expr: 'up',
      datasource: { uid: 'prom', type: 'prometheus' },
    });
    expect(panels[1].transformations).toHaveLength(1);
  });
});

describe('PromQL check', () => {
  it('parses interpolated probes and reports undefined variables and non-PromQL targets', async () => {
    const resource = clone(classic);
    resource.spec.panels.push({
      id: 4,
      type: 'logs',
      title: 'Logs',
      targets: [{ refId: 'A', datasource: { type: 'loki', uid: 'loki' }, expr: '{app="x"} |= "err"' }],
    });
    const seen: string[] = [];
    const parser: PromqlParser = {
      name: 'prometheus',
      async parse(queries) {
        seen.push(...queries.map((query) => query.expr));
        return queries.map(({ id, expr }) => (expr === 'up' ? { id, error: 'boom' } : { id }));
      },
    };
    const report = await checkDashboardPromql(resource, parser);
    expect(seen[0]).toBe('sum(rate(http_requests_total{job=~"(api|web\\\\.v1)", env="prod \\"eu\\""}[5m]))');
    expect(report.checked).toBe(2);
    expect(report.errors.map((error) => [error.panel, error.refId, error.message])).toEqual([
      ['3', 'A', 'undefined dashboard variable $missing'],
      ['1', 'B', 'boom'],
    ]);
    expect(report.skipped).toEqual([{ panel: '4', title: 'Logs', refId: 'A', reason: 'no syntax parser for loki' }]);
  });

  it('falls back to the lezer parser', async () => {
    const resource = clone(classic);
    resource.spec.panels[0].targets[1].expr = 'sum(up';
    const report = await checkDashboardPromql(resource);
    expect(report.parser).toBe('lezer');
    expect(report.errors.map((error) => error.refId)).toEqual(['A', 'B']);
  });
});

describe('typed tool panel view', () => {
  it('assigns expanded classic rows to the panels that follow them and skips row objects', () => {
    const panels = walkClassicPanels({
      dashboard: {
        title: 'Rows',
        panels: [
          { id: 1, type: 'stat', title: 'Top', gridPos: { x: 0, y: 0, w: 6, h: 4 } },
          { id: 2, type: 'row', title: 'Traffic', collapsed: false, panels: [] },
          { id: 3, type: 'timeseries', title: 'Requests', targets: [{ expr: 'up' }], datasource: { uid: 'prom' } },
          {
            id: 4,
            type: 'row',
            title: 'Errors',
            collapsed: true,
            panels: [{ id: 5, type: 'timeseries', title: 'Error rate', targets: [{ refId: 'A', expr: 'x' }] }],
          },
        ],
      },
    });
    expect(panels.map(({ panel, rowPath }) => [panel.id, rowPath])).toEqual([
      [1, []],
      [3, ['Traffic']],
      [5, ['Errors']],
    ]);
    expect(panels[0].gridPos).toEqual({ x: 0, y: 0, w: 6, h: 4 });
    expect(panels[1].panel.targets).toEqual([{ expr: 'up', refId: 'A', datasource: { uid: 'prom' } }]);
  });

  it('maps v2 panels to classic panels with row/tab paths and grid positions', () => {
    const query = (refId: string, expr: string) => ({
      kind: 'PanelQuery',
      spec: { refId, query: { kind: 'DataQuery', group: 'prometheus', datasource: { name: 'prom' }, spec: { expr } } },
    });
    const item = (name: string, x: number) => ({
      kind: 'GridLayoutItem',
      spec: { x, y: 0, width: 12, height: 8, element: { kind: 'ElementReference', name } },
    });
    const panels = walkClassicPanels({
      dashboard: {
        title: 'V2',
        elements: {
          errors: {
            kind: 'Panel',
            spec: {
              id: 7,
              title: 'Errors',
              description: 'Error ratio',
              vizConfig: { group: 'timeseries', spec: { fieldConfig: { defaults: { unit: 'percentunit' } } } },
              data: {
                kind: 'QueryGroup',
                spec: {
                  queries: [query('A', 'errors'), query('B', 'requests')],
                  transformations: [{ kind: 'calculateField', spec: { id: 'calculateField', options: {} } }],
                },
              },
            },
          },
          lib: { kind: 'LibraryPanel', spec: { id: 8, title: 'Shared', libraryPanel: { uid: 'lib-1' } } },
        },
        layout: {
          kind: 'TabsLayout',
          spec: {
            tabs: [
              {
                kind: 'TabsLayoutTab',
                spec: {
                  title: 'Overview',
                  layout: {
                    kind: 'RowsLayout',
                    spec: {
                      rows: [
                        {
                          kind: 'RowsLayoutRow',
                          spec: {
                            title: 'HTTP',
                            layout: { kind: 'GridLayout', spec: { items: [item('errors', 0), item('lib', 12)] } },
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
    expect(panels.map(({ rowPath, gridPos }) => [rowPath, gridPos])).toEqual([
      [['Overview', 'HTTP'], { x: 0, y: 0, w: 12, h: 8 }],
      [['Overview', 'HTTP'], { x: 12, y: 0, w: 12, h: 8 }],
    ]);
    expect(panels[0].panel).toMatchObject({
      id: 7,
      title: 'Errors',
      type: 'timeseries',
      description: 'Error ratio',
      datasource: { uid: 'prom', type: 'prometheus' },
      fieldConfig: { defaults: { unit: 'percentunit' } },
      transformations: [{ id: 'calculateField' }],
    });
    expect((panels[0].panel.targets as unknown[]).length).toBe(2);
    expect(panels[1].panel).toMatchObject({ id: 8, title: 'Shared', type: 'library-panel', targets: [] });
  });

  it('returns no panels for non-dashboard input', () => {
    expect(walkClassicPanels({ message: 'not found' })).toEqual([]);
  });
});
