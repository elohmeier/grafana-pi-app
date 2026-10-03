import { checkScreenshot } from './screenshotGuard';

const datasources = [
  { uid: 'prometheus', name: 'Prometheus', type: 'prometheus', isDefault: true },
  { uid: 'other-prom', name: 'Other', type: 'prometheus' },
  { uid: 'es-logs', name: 'Logs', type: 'elasticsearch' },
  { uid: 'testdata', name: 'TestData', type: 'grafana-testdata-datasource' },
];

const prom = { type: 'prometheus', uid: 'prometheus' };
const logs = { type: 'elasticsearch', uid: 'es-logs' };

function dashboard(panels: unknown[], variables: unknown[] = []) {
  return { title: 'Mixed', panels, templating: { list: variables } };
}

function check(resource: unknown, panelId?: number) {
  return checkScreenshot(resource, { panelId, datasources, allowedPrometheusUids: ['prometheus'] });
}

describe('screenshot guard', () => {
  const panels = [
    { id: 1, type: 'timeseries', title: 'Errors', datasource: prom, targets: [{ refId: 'A', expr: 'up' }] },
    { id: 2, type: 'logs', title: 'Error logs', datasource: logs, targets: [{ refId: 'A', query: '*' }] },
    { id: 3, type: 'text', title: 'Notes' },
    {
      id: 4,
      type: 'timeseries',
      title: 'Mixed',
      datasource: { type: 'datasource', uid: '-- Mixed --' },
      targets: [
        { refId: 'A', datasource: prom, expr: 'up' },
        { refId: 'B', datasource: { type: '__expr__', uid: '__expr__' }, expression: '$A' },
      ],
    },
    {
      id: 5,
      type: 'table',
      title: 'Reused logs',
      datasource: { type: 'datasource', uid: '-- Dashboard --' },
      targets: [{ refId: 'A', panelId: 2 }],
    },
    { id: 6, type: 'stat', title: 'Default datasource', targets: [{ refId: 'A', expr: 'up' }] },
    { id: 7, type: 'stat', title: 'Other Prometheus', datasource: { uid: 'other-prom' }, targets: [{ refId: 'A' }] },
    { id: 8, type: 'stat', title: 'Test data', datasource: { uid: 'testdata' }, targets: [{ refId: 'A' }] },
  ];

  it('refuses panels of datasources the assistant may not read', () => {
    const result = check(dashboard(panels));
    expect(result.allowed).toEqual(['1', '3', '4', '6', '8']);
    expect(result.refused).toEqual([
      {
        id: '2',
        title: 'Error logs',
        reason: 'uses elasticsearch datasource Logs (es-logs), which is not available to the assistant',
      },
      {
        id: '5',
        title: 'Reused logs',
        reason: 'uses elasticsearch datasource Logs (es-logs), which is not available to the assistant',
      },
      {
        id: '7',
        title: 'Other Prometheus',
        reason: 'uses prometheus datasource Other (other-prom), which is not available to the assistant',
      },
    ]);
  });

  it('checks only the selected panel', () => {
    expect(check(dashboard(panels), 1)).toEqual({ refused: [], allowed: ['1'] });
    expect(check(dashboard(panels), 2).refused).toHaveLength(1);
  });

  it('resolves datasource variables and refuses unresolved ones', () => {
    const variable = (current: string) => ({
      name: 'ds',
      type: 'datasource',
      current: { text: current, value: current },
    });
    const panel = {
      id: 1,
      type: 'timeseries',
      title: 'By variable',
      datasource: { uid: '${ds}' },
      targets: [{ refId: 'A' }],
    };
    expect(check(dashboard([panel], [variable('es-logs')])).refused).toHaveLength(1);
    expect(check(dashboard([panel], [variable('prometheus')])).refused).toEqual([]);
    expect(check(dashboard([panel])).refused[0].reason).toMatch(/variable without a resolvable value/);
  });

  it('refuses library panels and unknown datasources', () => {
    const result = check(
      dashboard([
        { id: 1, title: 'Library', libraryPanel: { uid: 'lib', name: 'Library' } },
        { id: 2, type: 'stat', title: 'Gone', datasource: { uid: 'deleted' }, targets: [{ refId: 'A' }] },
      ])
    );
    expect(result.refused.map((panel) => panel.reason)).toEqual([
      'library panel lib: its queries cannot be checked',
      'datasource "deleted" is unknown',
    ]);
  });
});
