import { groupChanges, replacement, replacements } from './changeGroups';
import { listDashboardQueries } from './dashboardQueries';
import { createDashboardCatalog } from './mounts';
import { runWorkspaceBash, type WorkspaceShellDeps } from './shell';
import { createFakeDashboardBroker } from './testUtils';
import { SessionWorkspace } from './workspace';

const DASHBOARDS = 40;

function panel(expr: string) {
  return {
    id: 1,
    type: 'timeseries',
    title: 'Requests',
    gridPos: { x: 0, y: 0, w: 12, h: 8 },
    datasource: { uid: 'prometheus', type: 'prometheus' },
    targets: [{ refId: 'A', expr }],
  };
}

/** 40 dashboards; every fourth one queries http_server_requests_seconds_count with a fixed [5m] window. */
function setup(decide: (request: any) => { approved: boolean; paths?: string[] } = () => ({ approved: true })) {
  const fake = createFakeDashboardBroker(
    Array.from({ length: DASHBOARDS }, (_, index) => ({
      uid: `d${String(index).padStart(2, '0')}`,
      title: `Dashboard ${index}`,
      panels: [
        panel(
          index % 4 === 0
            ? `sum(rate(http_server_requests_seconds_count{job="api-${index}"}[5m]))`
            : `sum(rate(node_cpu_seconds_total[$__rate_interval]))`
        ),
      ],
    }))
  );
  const workspace = new SessionWorkspace();
  const catalog = createDashboardCatalog(fake.broker.dashboards!);
  workspace.setHydrator((_kind, uid, signal) => fake.broker.dashboards!.get(uid, signal));
  workspace.setResourceIndex(catalog.index);
  const approvals = { request: jest.fn(async (request: any) => decide(request)) };
  const deps: WorkspaceShellDeps = { workspace, broker: fake.broker, approvals };
  const run = (command: string) => runWorkspaceBash(deps, { command });
  return { ...fake, workspace, approvals, run };
}

const MATCHING = Array.from({ length: DASHBOARDS / 4 }, (_, index) => `d${String(index * 4).padStart(2, '0')}`);

describe('dashboard mass edits', () => {
  it('lists every visible dashboard before fetching any content', async () => {
    const { run, calls } = setup();
    const result = await run('ls /grafana/dashboards | wc -l; ls /grafana/dashboards/d07');
    expect(result.stdout).toBe(`${DASHBOARDS}\ndashboard.json\nmeta.json\n`);
    expect(calls.filter((call) => call.startsWith('get:'))).toHaveLength(0);
  });

  it('finds matching panels with rg across dashboards that were never fetched', async () => {
    const { run, workspace } = setup();
    const result = await run('rg -l "http_server_requests_seconds_count" /grafana/dashboards | sort');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(
      MATCHING.map((uid) => `/grafana/dashboards/${uid}/dashboard.json`)
    );
    expect(workspace.usage().dashboards).toEqual({ visible: DASHBOARDS, loaded: DASHBOARDS, modified: 0 });
  });

  it('loads dashboards by folder, search, stdin, or all at once', async () => {
    const { run, workspace } = setup();
    const piped = await run(`printf 'd01\\nd02\\n' | grafana fetch - | jq -c '[.requested, .loaded]'`);
    expect(piped.stdout).toBe('[2,2]\n');
    const all = await run('grafana fetch --all | jq -c "[.requested, .loaded, .errors]"');
    expect(all.stdout).toBe(`[${DASHBOARDS},${DASHBOARDS},[]]\n`);
    expect(workspace.usage().dashboards.loaded).toBe(DASHBOARDS);
  });

  it('keeps the path list stable while dashboards load, so the worker need not receive it again', async () => {
    const { workspace } = setup();
    await workspace.prepareMounts();
    const tx = workspace.begin();
    const key = tx.pathsKey();
    const before = tx.allPaths();
    await workspace.prefetch();
    expect(tx.pathsKey()).toBe(key);
    expect(tx.allPaths()).toBe(before);
  });

  it('edits every match in one script and applies only the dashboards the reviewer kept', async () => {
    const declined = `/grafana/dashboards/${MATCHING[1]}/dashboard.json`;
    const { run, approvals, store, workspace } = setup((request) => ({
      approved: true,
      paths: request.operations.map((operation: any) => operation.path).filter((path: string) => path !== declined),
    }));
    const edit = await run(
      `rg -l 'http_server_requests_seconds_count.*\\[5m\\]' /grafana/dashboards | xargs sed -i 's/\\[5m\\]/[$__rate_interval]/g'`
    );
    expect(edit).toEqual(expect.objectContaining({ exitCode: 0, stderr: '' }));
    expect(workspace.status()).toHaveLength(MATCHING.length);

    const stat = JSON.parse((await run('workspace diff --stat')).stdout);
    expect(stat.groups).toEqual([
      expect.objectContaining({
        before: '5m',
        after: '$__rate_interval',
        count: MATCHING.length,
        dashboards: MATCHING.length,
      }),
    ]);

    const apply = await run('workspace apply');
    expect(apply.exitCode).toBe(0);
    const request = approvals.request.mock.calls[0][0] as any;
    expect(request.operations).toHaveLength(MATCHING.length);
    expect(request.groups[0]).toEqual(
      expect.objectContaining({ before: '5m', after: '$__rate_interval', count: MATCHING.length })
    );
    expect(request.ungroupedChanges).toBe(0);

    const receipt = JSON.parse(apply.stdout);
    expect(receipt.counts).toEqual({ applied: MATCHING.length - 1, declined: 1 });
    expect(store.get(MATCHING[0])?.resource.spec.panels[0].targets[0].expr).toContain('[$__rate_interval]');
    expect(store.get(MATCHING[1])?.resource.spec.panels[0].targets[0].expr).toContain('[5m]');
    // The declined dashboard keeps its change for a later apply.
    expect(workspace.status().map((change) => change.path)).toEqual([declined]);
  });

  it('does not block changes to dashboards that already had validation errors', async () => {
    const { run, store } = setup();
    // d01 already references a datasource outside the allow-list; the edit only renames it.
    store.get('d01')!.resource.spec.panels[0].datasource.uid = 'other-datasource';
    const result = await run(
      `sed -i 's/"Dashboard 1"/"Dashboard one"/' /grafana/dashboards/d01/dashboard.json && workspace apply`
    );
    expect(result.exitCode).toBe(0);
    expect(store.get('d01')?.resource.spec.title).toBe('Dashboard one');

    const validated = JSON.parse(
      (
        await run(
          `sed -i 's/"Dashboard one"/"Dashboard 1!"/' /grafana/dashboards/d01/dashboard.json && grafana-dashboard validate /grafana/dashboards/d01/dashboard.json`
        )
      ).stdout
    );
    expect(validated).toEqual(
      expect.objectContaining({
        ok: true,
        errors: [],
        preexistingErrors: [expect.objectContaining({ level: 'policy' })],
      })
    );

    const introduced = await run(
      `sed -i 's/"uid": "prometheus"/"uid": "other-datasource"/' /grafana/dashboards/d02/dashboard.json && workspace apply`
    );
    expect(introduced.exitCode).toBe(1);
    expect(introduced.stderr).toMatch(/validation failed for 1 of 2 dashboards/);
  });

  it('reverts exactly the applied change and keeps later edits by others', async () => {
    const { run, store, touch } = setup();
    const edit = await run(
      `sed -i 's/"Dashboard 5"/"Renamed"/' /grafana/dashboards/d05/dashboard.json && workspace apply`
    );
    const { applyId } = JSON.parse(edit.stdout);
    // Someone else changes another line afterwards.
    store.get('d05')!.resource.spec.panels[0].title = 'Edited elsewhere';
    touch('d05');

    const staged = JSON.parse((await run(`workspace revert ${applyId}`)).stdout);
    expect(staged.staged).toEqual(['/grafana/dashboards/d05/dashboard.json']);
    expect((await run('workspace apply')).exitCode).toBe(0);
    expect(store.get('d05')?.resource.spec.title).toBe('Dashboard 5');
    expect(store.get('d05')?.resource.spec.panels[0].title).toBe('Edited elsewhere');
  });

  it('reverts from dashboard history when the receipt no longer holds the diff', async () => {
    const { run, store, approvals, workspace } = setup();
    const edit = await run(
      `sed -i 's/"Dashboard 3"/"Renamed"/' /grafana/dashboards/d03/dashboard.json && workspace apply`
    );
    const { applyId } = JSON.parse(edit.stdout);
    expect(store.get('d03')?.resource.spec.title).toBe('Renamed');

    delete workspace.applyJournal().find((receipt) => receipt.applyId === applyId)!.diff;
    const staged = await run(`workspace revert ${applyId}`);
    expect(JSON.parse(staged.stdout).staged).toEqual(['/grafana/dashboards/d03/dashboard.json']);
    const apply = await run('workspace apply');
    expect(apply.exitCode).toBe(0);
    expect(approvals.request).toHaveBeenCalledTimes(2);
    expect(store.get('d03')?.resource.spec.title).toBe('Dashboard 3');
  });
});

describe('dashboard queries', () => {
  it('lists matching queries of every dashboard with jq paths that edit exactly those queries', async () => {
    const { run, workspace } = setup();
    const listed = await run(
      'grafana-dashboard queries --metric http_server_requests_seconds_count > /tmp/q.ndjson; wc -l < /tmp/q.ndjson'
    );
    expect(listed.stdout.trim()).toBe(String(MATCHING.length));
    const first = JSON.parse((await run('head -1 /tmp/q.ndjson')).stdout);
    expect(first).toEqual(
      expect.objectContaining({
        uid: 'd00',
        dashboard: 'Dashboard 0',
        kind: 'panel',
        refId: 'A',
        datasource: { uid: 'prometheus', type: 'prometheus' },
        jqPath: '.spec.panels[0].targets[0].expr',
      })
    );
    const edit = await run(
      `jq -r '[.path, .jqPath] | @tsv' /tmp/q.ndjson | while read -r file query; do jq "($query) |= sub(\\"\\\\\\\\[5m\\\\\\\\]\\"; \\"[1m]\\")" "$file" > /tmp/x && cp /tmp/x "$file"; done`
    );
    expect(edit.stderr).toBe('');
    expect(workspace.status()).toHaveLength(MATCHING.length);
    const changed = JSON.parse(workspace.getResource('d04')!.overlay!.content!);
    expect(changed.spec.panels[0].targets[0].expr).toBe(
      'sum(rate(http_server_requests_seconds_count{job="api-4"}[1m]))'
    );
  });

  it('addresses v2 panel and variable queries', () => {
    const locations = listDashboardQueries({
      spec: {
        elements: {
          'panel-1': {
            kind: 'Panel',
            spec: {
              title: 'Latency',
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
                          datasource: { name: 'metrics' },
                          spec: { expr: 'up' },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
        variables: [
          {
            kind: 'QueryVariable',
            spec: {
              name: 'job',
              query: { kind: 'DataQuery', group: 'prometheus', spec: { query: 'label_values(up, job)' } },
            },
          },
        ],
      },
    });
    expect(locations).toEqual([
      expect.objectContaining({
        kind: 'panel',
        key: 'panel-1',
        datasource: { uid: 'metrics', type: 'prometheus' },
        jqPath: '.spec.elements["panel-1"].spec.data.spec.queries[0].spec.query.spec.expr',
      }),
      expect.objectContaining({ kind: 'variable', key: 'job', jqPath: '.spec.variables[0].spec.query.spec.query' }),
    ]);
  });
});

describe('change groups', () => {
  it('reduces a changed line to its replacement, widened to whole words', () => {
    expect(replacement('rate(x{a="b"}[5m])', 'rate(x{a="b"}[1m])')).toEqual(['5m', '1m']);
    expect(replacement('"unit": "short"', '"unit": "reqps"')).toEqual(['short', 'reqps']);
    expect(replacement('old_metric_total{job="a"}', 'new_metric_total{job="a"}')).toEqual([
      'old_metric_total',
      'new_metric_total',
    ]);
  });

  it('splits a line into its token replacements, so two ranges in one query count twice', () => {
    expect(
      replacements(
        'sum(rate(x[5m])) / sum(rate(y[5m]))',
        'sum(rate(x[$__rate_interval])) / sum(rate(y[$__rate_interval]))'
      )
    ).toEqual([
      ['5m', '$__rate_interval'],
      ['5m', '$__rate_interval'],
    ]);
    expect(replacements('"legendFormat": "{{pod}}"', '"legendFormat": "__auto"')).toEqual([['{{pod}}', '__auto']]);
  });

  it('groups repeated replacements and counts the rest as ungrouped', () => {
    const { groups, ungroupedChanges } = groupChanges([
      { path: 'a', before: 'x[5m]\ny\n', after: 'x[1m]\ny\n' },
      { path: 'b', before: 'z[5m]\n', after: 'z[1m]\nadded\n' },
      { path: 'c', before: 'title: A\n', after: 'title: B\n' },
    ]);
    expect(groups).toEqual([expect.objectContaining({ before: '5m', after: '1m', count: 2, paths: ['a', 'b'] })]);
    expect(ungroupedChanges).toBe(2);
  });
});
