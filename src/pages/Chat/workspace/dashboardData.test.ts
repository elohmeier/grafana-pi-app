import { dateTime, FieldType, type DataFrame, type TimeRange } from '@grafana/data';
import { collectDashboardData, type DashboardDataOptions } from './dashboardData';
import type { JsonObject } from './dashboardPanels';
import {
  goDuration,
  panelPixelWidth,
  panelRequest,
  panelTimeRange,
  resolvePromQuery,
  transformPrometheusFrames,
} from './dashboardPromEmulation';

const HOUR = 3_600_000;
const END = Date.UTC(2026, 0, 1, 12);

function absoluteRange(hours: number): TimeRange {
  const from = dateTime(END - hours * HOUR);
  const to = dateTime(END);
  return { from, to, raw: { from, to } };
}

describe('panel request sizing', () => {
  it('derives maxDataPoints from the panel grid width like the browser', () => {
    // 1920px window: 320px docked menu, 2 x 16px padding, 24 columns with 8px gaps, 18px panel chrome.
    expect(panelPixelWidth(24)).toBe(1550);
    expect(panelPixelWidth(12)).toBe(762);
    expect(panelPixelWidth(8)).toBe(499);
    expect(panelPixelWidth(12, 1440)).toBe(522);
  });

  it('uses the panel pixel width, the panel maxDataPoints, and the panel or datasource min interval', () => {
    const range = absoluteRange(12);
    expect(panelRequest(range, { gridColumns: 12, panelDatasourceInterval: '15s' })).toEqual({
      maxDataPoints: 762,
      maxDataPointsSource: 'width',
      // 12h / 762 = 56.7s, rounded to 1m.
      interval: '1m',
      intervalMs: 60_000,
      minInterval: '15s',
    });
    expect(panelRequest(range, { gridColumns: 12, maxDataPoints: 100, panelDatasourceInterval: '15s' })).toMatchObject({
      maxDataPoints: 100,
      maxDataPointsSource: 'panel',
      intervalMs: 300_000,
    });
    // The panel min interval wins over the datasource scrape interval.
    expect(
      panelRequest(absoluteRange(1), { gridColumns: 24, minInterval: '2m', panelDatasourceInterval: '15s' })
    ).toMatchObject({ intervalMs: 120_000, minInterval: '2m' });
    // Without a timeInterval the Prometheus datasource uses 15s; Mixed panels have no lower limit.
    expect(panelRequest(absoluteRange(1), { gridColumns: 24 })).toMatchObject({ intervalMs: 15_000 });
    expect(panelRequest(absoluteRange(1), { gridColumns: 24, mixed: true })).toMatchObject({ intervalMs: 2000 });
  });
});

describe('Prometheus interval resolution', () => {
  it('resolves $__rate_interval from the request interval and the scrape interval', () => {
    // A 672px panel over 12h: 64s rounds to a 1m interval; max(1m + 15s, 4 x 15s) = 1m15s.
    const resolved = resolvePromQuery('sum(rate(http_requests_total[$__rate_interval]))', {
      intervalMs: 60_000,
      maxDataPoints: 672,
      rangeMs: 12 * HOUR,
      scrapeInterval: '15s',
    });
    expect(resolved).toMatchObject({
      expr: 'sum(rate(http_requests_total[1m15s]))',
      step: '1m0s',
      interval: '1m',
      rateInterval: '1m15s',
    });
  });

  it('substitutes $__interval, $__range, and their alternative forms with the backend step', () => {
    const resolved = resolvePromQuery(
      'increase(http_requests_total[${__interval}]) / $__interval_ms + $__range_s + ${__rate_interval_ms} * 0',
      { intervalMs: 30_000, maxDataPoints: 1550, rangeMs: 6 * HOUR, scrapeInterval: '30s' }
    );
    expect(resolved.expr).toBe('increase(http_requests_total[30s]) / 30000 + 21600 + 120000 * 0');
  });

  it('honours the query min step, $__rate_interval as min step, and the interval factor', () => {
    const base = { intervalMs: 60_000, maxDataPoints: 762, rangeMs: 12 * HOUR, scrapeInterval: '15s' };
    // A query min step replaces the request interval as the lower bound and as the rate scrape interval.
    expect(
      resolvePromQuery('rate(http_requests_total[$__rate_interval])', { ...base, queryInterval: '5m' })
    ).toMatchObject({ step: '5m0s', rateInterval: '20m0s' });
    expect(
      resolvePromQuery('rate(http_requests_total[$__rate_interval])', { ...base, queryInterval: '$__rate_interval' })
    ).toMatchObject({ step: '1m15s', rateInterval: '1m15s' });
    expect(resolvePromQuery('up', { ...base, intervalFactor: 2 })).toMatchObject({ step: '2m0s' });
    // The step never drops below range / 11000.
    expect(
      resolvePromQuery('up', { ...base, intervalMs: 1000, maxDataPoints: 100_000, rangeMs: 30 * 24 * HOUR })
    ).toMatchObject({
      step: '5m0s',
    });
  });

  it('formats durations like Go', () => {
    expect(goDuration(75_000)).toBe('1m15s');
    expect(goDuration(HOUR)).toBe('1h0m0s');
    expect(goDuration(1500)).toBe('1.5s');
    expect(goDuration(500)).toBe('500ms');
  });

  it('applies panel relative time and time shift', () => {
    const relative: TimeRange = {
      from: dateTime(END - 6 * HOUR),
      to: dateTime(END),
      raw: { from: 'now-6h', to: 'now' },
    };
    const overridden = panelTimeRange(relative, { timeFrom: '1h' });
    expect(overridden.range.raw).toEqual({ from: 'now-1h', to: 'now' });
    const shifted = panelTimeRange(absoluteRange(6), { timeShift: '1d' });
    expect(shifted.range.to.valueOf()).toBe(END - 24 * HOUR);
    expect(panelTimeRange(relative, { timeShift: 'yesterday' }).error).toContain('invalid time shift');
  });
});

describe('Prometheus frame shapes', () => {
  const series = (refId: string, labels: Record<string, string>, values: number[], name = 'Value'): DataFrame => ({
    refId,
    length: values.length,
    fields: [
      { name: 'Time', type: FieldType.time, config: {}, values: values.map((_, index) => END + index * 60_000) },
      { name, type: FieldType.number, config: {}, labels, values: [...values] },
    ],
  });

  it('turns table-format results into one table per query with label columns', () => {
    const frames = transformPrometheusFrames(
      [
        series('A', { job: 'api', instance: 'a:9090' }, [5]),
        series('A', { job: 'web', instance: 'w:9090' }, [7]),
        series('B', { job: 'api' }, [1, 2]),
      ],
      [{ refId: 'A', format: 'table' }, { refId: 'B' }]
    );
    // Time series first, then tables, as Grafana orders them.
    expect(frames.map((frame) => [frame.refId, frame.fields.map((field) => field.name)])).toEqual([
      ['B', ['Time', 'Value']],
      ['A', ['Time', 'instance', 'job', 'Value']],
    ]);
    expect(frames[1].fields[2].values).toEqual(['api', 'web']);
    expect(frames[1].fields[3].values).toEqual([5, 7]);
  });

  it('names table values per query when several table queries return data', () => {
    const frames = transformPrometheusFrames(
      [series('A', { job: 'api' }, [5]), series('B', { job: 'api' }, [1])],
      [
        { refId: 'A', format: 'table' },
        { refId: 'B', format: 'table' },
      ]
    );
    expect(frames.map((frame) => frame.fields.map((field) => field.name))).toEqual([
      ['Time', 'job', 'Value #A'],
      ['Time', 'job', 'Value #B'],
    ]);
  });

  it('de-accumulates heatmap buckets', () => {
    const frames = transformPrometheusFrames(
      [series('A', { le: '+Inf' }, [10, 12]), series('A', { le: '0.1' }, [4, 4]), series('A', { le: '0.5' }, [9, 10])],
      [{ refId: 'A', format: 'heatmap' }]
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].fields.map((field) => [field.name, field.values])).toEqual([
      ['Time', [END, END + 60_000]],
      ['0.1', [4, 4]],
      ['0.5', [5, 6]],
      ['+Inf', [1, 2]],
    ]);
  });
});

describe('collectDashboardData', () => {
  type SentQuery = JsonObject & { refId: string; expr?: string; instant?: boolean };
  type Series = { labels: Record<string, string>; values: number[] };

  /** Backend-like frames: one frame per series, Time + Value with labels on the value field. */
  function frame(refId: string, item: Series, instant: boolean) {
    const values = instant ? item.values.slice(-1) : item.values;
    return {
      schema: {
        refId,
        meta: { custom: { resultType: instant ? 'vector' : 'matrix' } },
        fields: [
          { name: 'Time', type: 'time' },
          { name: 'Value', type: 'number', labels: item.labels },
        ],
      },
      data: { values: [values.map((_, index) => END - (values.length - 1 - index) * 60_000), values] },
    };
  }

  function run(
    dashboard: JsonObject,
    data: (query: SentQuery) => Series[],
    overrides: Partial<DashboardDataOptions> = {}
  ) {
    const requests: Array<{ queries: SentQuery[]; from: string; to: string }> = [];
    const report = collectDashboardData(dashboard, {
      maxRows: 10,
      maxSeries: 10,
      maxPanels: 10,
      from: new Date(END - 12 * HOUR).toISOString(),
      to: new Date(END).toISOString(),
      datasources: [{ uid: 'prom', name: 'Prometheus', isDefault: true, timeInterval: '15s' }],
      query: async (request) => {
        const queries = request.queries as SentQuery[];
        requests.push({ ...request, queries });
        return {
          results: Object.fromEntries(
            queries.map((query) => [
              query.refId,
              { frames: data(query).map((item) => frame(query.refId, item, Boolean(query.instant))) },
            ])
          ),
        };
      },
      ...overrides,
    });
    return { report, requests };
  }

  const DS = { uid: 'prom', type: 'prometheus' };

  it('sizes requests from the panel width and reports resolved intervals and executed queries', async () => {
    const dashboard = {
      title: 'Service',
      panels: [
        {
          id: 1,
          type: 'timeseries',
          title: 'Request rate',
          gridPos: { x: 0, y: 0, w: 8, h: 8 },
          datasource: DS,
          targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total[$__rate_interval]))' }],
        },
        {
          id: 2,
          type: 'timeseries',
          title: 'Fixed points',
          gridPos: { x: 8, y: 0, w: 16, h: 8 },
          datasource: DS,
          interval: '2m',
          maxDataPoints: 300,
          targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total[$__rate_interval]))', interval: '30s' }],
        },
      ],
    };
    const { report, requests } = run(dashboard, () => [{ labels: {}, values: [1, 2, 3] }]);
    const result = await report;
    const [narrow, fixed] = result.panels;

    // 8 columns are 499px: 12h / 499 = 86.6s rounds to 1m.
    expect(requests[0].queries[0]).toMatchObject({
      maxDataPoints: 499,
      intervalMs: 60_000,
      range: true,
      instant: false,
    });
    expect(narrow.request).toMatchObject({ maxDataPoints: 499, maxDataPointsSource: 'width', interval: '1m' });
    expect(narrow.queries[0]).toMatchObject({ step: '1m0s', rateInterval: '1m15s' });
    expect(narrow.executedQueries).toEqual(['Expr: sum(rate(http_requests_total[1m15s])); Step: 1m0s']);
    expect(narrow.status).toBe('ok');

    // The panel interval and maxDataPoints size the request; the query interval stays the query's min step.
    expect(requests[1].queries[0]).toMatchObject({ maxDataPoints: 300, intervalMs: 120_000, interval: '30s' });
    expect(fixed.request).toMatchObject({ maxDataPoints: 300, maxDataPointsSource: 'panel', minInterval: '2m' });
    expect(fixed.queries[0]).toMatchObject({ minStep: '30s', step: '2m0s', rateInterval: '2m30s' });

    expect(result.notes.join('\n')).toContain('1920px browser window');
  });

  it('honours v2 query options and a narrower browser', async () => {
    const dashboard = {
      title: 'Service v2',
      elements: {
        'panel-1': {
          kind: 'Panel',
          spec: {
            id: 1,
            title: 'Request rate',
            vizConfig: { kind: 'timeseries', spec: {} },
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
                        spec: { expr: 'sum(rate(http_requests_total[$__rate_interval]))' },
                      },
                    },
                  },
                ],
                transformations: [],
                queryOptions: { interval: '5m', timeFrom: '2h' },
              },
            },
          },
        },
      },
      layout: {
        kind: 'GridLayout',
        spec: {
          items: [
            {
              kind: 'GridLayoutItem',
              spec: { x: 0, y: 0, width: 12, height: 8, element: { kind: 'ElementReference', name: 'panel-1' } },
            },
          ],
        },
      },
      timeSettings: { from: 'now-12h', to: 'now' },
    };
    const { report, requests } = run(dashboard, () => [{ labels: {}, values: [1] }], {
      from: undefined,
      to: undefined,
      browserWidth: 1440,
    });
    const [panel] = (await report).panels;
    expect(panel.request).toMatchObject({ maxDataPoints: 522, minInterval: '5m', intervalMs: 300_000 });
    expect(panel.request?.timeOverride).toBe('Last 2 hours');
    expect(Number(requests[0].to) - Number(requests[0].from)).toBeCloseTo(2 * HOUR, -4);
    expect(panel.queries[0]).toMatchObject({ rateInterval: '5m15s' });
  });

  it('builds table frames for table-format queries before transformations, like Grafana', async () => {
    const panel = (format: string) => ({
      id: 1,
      type: 'table',
      title: 'Jobs',
      gridPos: { x: 0, y: 0, w: 24, h: 8 },
      datasource: DS,
      targets: [
        { refId: 'A', expr: 'sum by (job) (rate(http_requests_total[5m]))', format, instant: true },
        { refId: 'B', expr: 'sum by (job) (http_requests_in_flight)', format, instant: true },
      ],
      transformations: [
        { id: 'merge', options: {} },
        { id: 'organize', options: { excludeByName: { Time: true } } },
      ],
    });
    const data = (query: SentQuery): Series[] =>
      query.refId === 'A'
        ? [
            { labels: { job: 'api' }, values: [12.5] },
            { labels: { job: 'web' }, values: [3] },
          ]
        : [
            { labels: { job: 'api' }, values: [4] },
            { labels: { job: 'web' }, values: [1] },
          ];

    const table = (await run({ title: 'Jobs', panels: [panel('table')] }, data).report).panels[0];
    expect(table.status).toBe('ok');
    expect(table.queries.map((query) => [query.format, query.type])).toEqual([
      ['table', 'instant'],
      ['table', 'instant'],
    ]);
    expect(table.tables).toHaveLength(1);
    expect(table.tables![0].columns).toEqual(['job', 'Value #A', 'Value #B']);
    expect(table.tables![0].rows).toEqual([
      ['api', '12.5', '4'],
      ['web', '3', '1'],
    ]);

    // Time series frames carry labels on the value field instead of label columns; merge cannot line them up by job.
    const timeSeries = (await run({ title: 'Jobs', panels: [panel('time_series')] }, data).report).panels[0];
    expect(timeSeries.tables![0].columns).not.toContain('job');
    expect(timeSeries.tables![0].columns).not.toContain('Value #A');
  });

  it('runs "Both" queries as a range and an instant query and keeps the instant half a time series', async () => {
    const dashboard = {
      title: 'Both',
      panels: [
        {
          id: 1,
          type: 'timeseries',
          title: 'Requests',
          gridPos: { x: 0, y: 0, w: 24, h: 8 },
          datasource: DS,
          targets: [{ refId: 'A', expr: 'sum(http_requests_total)', format: 'table', range: true, instant: true }],
        },
      ],
    };
    const { report, requests } = run(dashboard, () => [{ labels: { job: 'api' }, values: [1, 2, 3] }]);
    const [panel] = (await report).panels;
    expect(requests[0].queries.map((query) => [query.refId, query.range, query.instant])).toEqual([
      ['A', true, false],
      ['A-Instant', false, true],
    ]);
    expect(panel.queries[0].type).toBe('both');
    expect(panel.executedQueries).toEqual(['Expr: sum(http_requests_total); Step: 30s']);
  });

  it('reports partial instead of ok when the panel uses something it cannot emulate', async () => {
    const dashboard = {
      title: 'Compare',
      templating: {
        list: [{ name: 'filters', type: 'adhoc', filters: [{ key: 'job', operator: '=', value: 'api' }] }],
      },
      panels: [
        {
          id: 1,
          type: 'timeseries',
          title: 'Requests',
          gridPos: { x: 0, y: 0, w: 24, h: 8 },
          datasource: DS,
          timeCompare: '1d',
          targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total[5m]))' }],
        },
      ],
    };
    const [panel] = (await run(dashboard, () => [{ labels: {}, values: [1] }]).report).panels;
    expect(panel.status).toBe('partial');
    expect(panel.notes).toEqual([
      expect.stringContaining('time comparison (1d) is not emulated'),
      expect.stringContaining('ad hoc filters of $filters are not applied'),
    ]);
  });

  it('notes when the datasource ran another expression than the emulation expected', async () => {
    const dashboard = {
      title: 'Mismatch',
      panels: [
        {
          id: 1,
          type: 'timeseries',
          title: 'Requests',
          gridPos: { x: 0, y: 0, w: 24, h: 8 },
          datasource: DS,
          targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total[$__rate_interval]))' }],
        },
      ],
    };
    const [panel] = (
      await collectDashboardData(dashboard, {
        maxRows: 10,
        maxSeries: 10,
        maxPanels: 10,
        from: new Date(END - HOUR).toISOString(),
        to: new Date(END).toISOString(),
        datasources: [{ uid: 'prom', name: 'Prometheus', timeInterval: '15s' }],
        query: async () => ({
          results: {
            A: {
              frames: [
                {
                  schema: {
                    refId: 'A',
                    meta: { executedQueryString: 'Expr: sum(rate(http_requests_total[2m]))\nStep: 15s' },
                    fields: [],
                  },
                  data: { values: [] },
                },
              ],
            },
          },
        }),
      })
    ).panels;
    expect(panel.status).toBe('empty');
    expect(panel.executedQueries).toEqual(['Expr: sum(rate(http_requests_total[2m])); Step: 15s']);
    expect(panel.notes?.[0]).toContain('not the emulated "sum(rate(http_requests_total[1m0s]))"');
  });
});
