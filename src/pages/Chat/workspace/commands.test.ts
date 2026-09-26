import type { WorkspaceBroker } from './broker';
import { runWorkspaceBash, type WorkspaceShellDeps } from './shell';
import { createFakeDashboardBroker } from './testUtils';
import { formatBashResult } from './tools';
import { createLiveDashboardMount, LIVE_DASHBOARD_PATH, liveRevision } from './liveDashboard';
import { migrateLegacyInvestigationReport, REPORT_PATH } from './migration';
import { SessionWorkspace } from './workspace';

jest.mock('@grafana/runtime', () => ({ config: { bootData: { user: { orgId: 1 } } } }));
jest.mock('typebox', () => ({
  Type: {
    Array: jest.fn((items, config) => ({ ...config, items })),
    Boolean: jest.fn((config) => config ?? {}),
    Number: jest.fn((config) => config ?? {}),
    Object: jest.fn((properties) => ({ properties })),
    Optional: jest.fn((schema) => schema),
    String: jest.fn((config) => config ?? {}),
  },
}));

const PANEL = {
  id: 1,
  type: 'timeseries',
  title: 'Requests',
  gridPos: { x: 0, y: 0, w: 12, h: 8 },
  datasource: { uid: 'prometheus', type: 'prometheus' },
  targets: [{ refId: 'A', expr: 'sum by (service) (rate(http_requests_total{job="api"}[5m]))' }],
};

function setup(extra: Partial<WorkspaceBroker> = {}) {
  const fake = createFakeDashboardBroker([{ uid: 'checkout', title: 'Checkout', panels: [PANEL] }]);
  const workspace = new SessionWorkspace();
  workspace.setHydrator((_kind, uid, signal) => fake.broker.dashboards!.get(uid, signal));
  const deps: WorkspaceShellDeps = { workspace, broker: { ...fake.broker, ...extra } };
  const run = (command: string) => runWorkspaceBash(deps, { command });
  return { run };
}

describe('grafana-alert command', () => {
  it('passes panel context to the alert broker and accepts working-copy paths', async () => {
    const findPanelRules = jest.fn(async () => ({ matchCount: 1, matches: [{ rule: { name: 'high-5xx' } }] }));
    const getRule = jest.fn(async () => ({ rule: { name: 'high-5xx' } }));
    const { run } = setup({ alerts: { findPanelRules, getRule } });

    const found = await run(
      "grafana-alert find --dashboard /grafana/dashboards/checkout/dashboard.json --panel 1 | jq -r '.matches[].rule.name'"
    );
    expect(found.stdout).toBe('high-5xx\n');
    expect(findPanelRules).toHaveBeenCalledWith(
      expect.objectContaining({ dashboardUid: 'checkout', panelId: '1' }),
      expect.anything()
    );

    const rule = await run('grafana-alert get high-5xx | jq -r .rule.name');
    expect(rule.stdout).toBe('high-5xx\n');

    const empty = await run('grafana-alert find');
    expect(empty.exitCode).toBe(2);
  });
});

describe('grafana-usage command', () => {
  it('extracts metric usage from the local working copy, including unsaved edits', async () => {
    const inspect = jest.fn(async (params: { uid: string }, options: { resource?: Record<string, any> }) => ({
      dashboard: { uid: params.uid, title: options.resource?.spec.title },
      metrics: [{ metric: 'http_requests_total' }],
      usages: [],
    }));
    const { run } = setup({
      metricUsage: { inspect, search: jest.fn(), neighborhood: jest.fn() },
    });

    await run(
      `jq '.spec.title = "Checkout edited"' /grafana/dashboards/checkout/dashboard.json > /tmp/d.json && mv /tmp/d.json /grafana/dashboards/checkout/dashboard.json`
    );
    const result = await run('grafana-usage dashboard checkout | jq -r .dashboard.title');
    expect(result.stdout).toBe('Checkout edited\n');
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'checkout' }),
      expect.objectContaining({ resource: expect.objectContaining({ kind: 'Dashboard' }) })
    );
  });

  it('forwards seed metrics to the related-metrics broker', async () => {
    const neighborhood = jest.fn(async () => ({ seedMetrics: ['up'], neighbors: [{ metric: 'node_load1' }] }));
    const { run } = setup({ metricUsage: { inspect: jest.fn(), search: jest.fn(), neighborhood } });
    const result = await run("grafana-usage related up http_requests_total --tag infra | jq -r '.neighbors[].metric'");
    expect(result.stdout).toBe('node_load1\n');
    expect(neighborhood).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: ['up', 'http_requests_total'], tag: 'infra' }),
      expect.anything()
    );
  });
});

describe('grafana open and screenshot', () => {
  it('navigates to safe destinations only', async () => {
    const navigate = jest.fn();
    const { run } = setup({ ui: { navigate } });
    const ok = await run('grafana open dashboard checkout && grafana open /alerting/list');
    expect(ok.exitCode).toBe(0);
    expect(navigate.mock.calls).toEqual([['/d/checkout/checkout'], ['/alerting/list']]);

    const bad = await run('grafana open https://example.com');
    expect(bad.exitCode).toBe(2);
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('attaches rendered images to the bash result', async () => {
    const screenshot = jest.fn(async () => ({ data: 'aW1n', mimeType: 'image/png', width: 1200, height: 700 }));
    const { run } = setup({ ui: { navigate: jest.fn(), screenshot } });
    const result = await run('grafana-dashboard screenshot checkout --panel 1 | jq -r .panelId');
    expect(result.stdout).toBe('1\n');
    expect(result.images).toEqual([{ data: 'aW1n', mimeType: 'image/png', title: 'Screenshot checkout panel 1' }]);
    expect(formatBashResult(result)).toContain('[image] Screenshot checkout panel 1');
    expect(screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'checkout', panelId: 1 }),
      expect.anything()
    );
  });
});

describe('legacy investigation report migration', () => {
  it('converts a structured report into /session/report.md once', () => {
    const workspace = new SessionWorkspace();
    const legacy = {
      title: 'Checkout 5xx',
      status: 'complete',
      scope: ['checkout-api'],
      evidence: ['error ratio 4%'],
      hypotheses: [],
    };
    expect(migrateLegacyInvestigationReport(workspace, legacy)).toBe(true);
    expect(workspace.getScratchFile(REPORT_PATH)?.content).toBe(
      '# Checkout 5xx\n\nStatus: complete\n\n## Scope\n\n- checkout-api\n\n## Evidence\n\n- error ratio 4%\n'
    );
    expect(migrateLegacyInvestigationReport(workspace, { title: 'Other' })).toBe(false);
  });
});

describe('live dashboard file', () => {
  function liveSetup() {
    let spec: Record<string, any> = {
      title: 'Live',
      elements: {
        'panel-1': {
          kind: 'Panel',
          spec: {
            id: 1,
            title: 'Requests',
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
                        spec: { expr: 'sum(rate(http_requests_total[5m]))' },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
      layout: { kind: 'GridLayout', spec: { items: [] } },
      variables: [],
    };
    const applied: Array<Record<string, any>> = [];
    const live = {
      available: () => true,
      get: async () => ({
        uid: 'live-uid',
        info: { uid: 'live-uid', title: spec.title },
        spec: JSON.parse(JSON.stringify(spec)),
        revision: liveRevision(spec),
      }),
      apply: async (next: Record<string, any>) => {
        applied.push(next);
        spec = JSON.parse(JSON.stringify(next));
        return { spec, warnings: [] };
      },
    };
    const workspace = new SessionWorkspace();
    workspace.setGeneratedMounts([createLiveDashboardMount(live)]);
    const deps: WorkspaceShellDeps = { workspace, broker: { live } };
    const run = (command: string) => runWorkspaceBash(deps, { command });
    return {
      run,
      applied,
      workspace,
      changeInBrowser: (title: string) => {
        spec = { ...spec, title };
      },
    };
  }

  it('stages edits locally and applies them with live apply', async () => {
    const { run, applied, workspace } = liveSetup();
    const edit = await run(
      `jq '.spec.title = "Edited"' /live/dashboard/dashboard.json > /tmp/d.json && mv /tmp/d.json /live/dashboard/dashboard.json && live status | jq -c '{staged, stale}'`
    );
    expect(edit.stdout).toBe('{"staged":true,"stale":false}\n');
    expect(applied).toHaveLength(0);

    const diff = await run('live diff');
    expect(diff.stdout).toContain('+    "title": "Edited"');

    const apply = await run('live apply | jq -r .applied; jq -r .spec.title /live/dashboard/dashboard.json');
    expect(apply.stderr).toBe('');
    // The read after apply in the same invocation sees the applied browser state, not a cached copy.
    expect(apply.stdout).toBe('true\nEdited\n');
    expect(applied[0].title).toBe('Edited');
    expect(workspace.getScratchFile(LIVE_DASHBOARD_PATH)).toBeUndefined();
    expect((await run('jq -r .spec.title /live/dashboard/dashboard.json')).stdout).toBe('Edited\n');
    expect(workspace.serialize().files).not.toHaveProperty(LIVE_DASHBOARD_PATH);
  });

  it('refuses to overwrite browser changes made after the read unless forced', async () => {
    const { run, applied, changeInBrowser } = liveSetup();
    await run(
      `jq '.spec.title = "Mine"' /live/dashboard/dashboard.json > /tmp/d.json && cp /tmp/d.json /live/dashboard/dashboard.json`
    );
    changeInBrowser('Theirs');
    const conflict = await run('live apply');
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain('changed in the browser');
    expect(applied).toHaveLength(0);

    const forced = await run('live apply --force');
    expect(forced.exitCode).toBe(0);
    expect(applied[0].title).toBe('Mine');
  });

  it('adds a variable-bound label filter to every Prometheus query and discards on request', async () => {
    const { run, applied } = liveSetup();
    const filter = await run(
      "grafana-dashboard label-filter /live/dashboard/dashboard.json --label instance --variable-query 'label_values(up, instance)' | jq -c '{changed: [.changed[].after], variable}'"
    );
    expect(JSON.parse(filter.stdout)).toEqual({
      changed: ['sum(rate(http_requests_total{instance=~"$instance"}[5m]))'],
      variable: { name: 'instance', action: 'added', query: 'label_values(up, instance)' },
    });
    const variable = await run(
      "jq -c '.spec.variables[0].spec | {name, query: .query.spec.query, ds: .query.datasource.name}' /live/dashboard/dashboard.json"
    );
    expect(JSON.parse(variable.stdout)).toEqual({ name: 'instance', query: 'label_values(up, instance)', ds: 'prom' });

    const discard = await run(
      'live discard | jq .discarded && jq -r ".spec.variables | length" /live/dashboard/dashboard.json'
    );
    expect(discard.stdout).toBe('true\n0\n');
    expect(applied).toHaveLength(0);
  });
});

describe('grafana-dashboard label-filter on classic working copies', () => {
  it('rewrites targets in nested rows and adds a classic query variable', async () => {
    const { run } = setup();
    const result = await run(
      "grafana-dashboard label-filter /grafana/dashboards/checkout/dashboard.json --label job --var service --variable-query 'label_values(up, job)' --current api | jq -c '[.changed[].after, .variable.action]'"
    );
    expect(JSON.parse(result.stdout)).toEqual([
      'sum by (service) (rate(http_requests_total{job=~"$service"}[5m]))',
      'added',
    ]);
    const variable = await run(
      "jq -c '.spec.templating.list[0] | {name, type, query: .query.query, ds: .datasource.uid, current: .current.value}' /grafana/dashboards/checkout/dashboard.json"
    );
    expect(JSON.parse(variable.stdout)).toEqual({
      name: 'service',
      type: 'query',
      query: 'label_values(up, job)',
      ds: 'prometheus',
      current: ['api'],
    });
  });
});

describe('shell conveniences', () => {
  it('treats /dev/null as a sink', async () => {
    const { run } = setup();
    const result = await run('echo hidden > /dev/null; ls /missing 2>/dev/null; cat /dev/null; echo visible');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('visible\n');
    expect(result.discardedChanges).toBeUndefined();
  });
});

describe('jq', () => {
  it('uses real jq semantics for parenthesized assignments, files, and options', async () => {
    const { run } = setup();
    const result = await run(
      [
        `echo '{"a":{"b":1},"c":2}' > x.json`,
        `jq -c '(.a.b) = 5' x.json`,
        `jq -c '(.a.b, .c) |= . + 1' x.json`,
        `printf '{"v":1}\\n{"v":2}\\n' > s.ndjson`,
        `jq -n -c --slurpfile all s.ndjson '$all | map(.v)'`,
        `jq -r --arg name world '"hello " + $name' -n`,
        `cat x.json | jq .c`,
        `jq . missing.json`,
      ].join('; ')
    );
    expect(result.stdout).toBe('{"a":{"b":5},"c":2}\n{"a":{"b":2},"c":3}\n[1,2]\nhello world\n2\n');
    expect(result.stderr).toContain('missing.json');
  });
});

describe('grafana-dashboard add-panel and set-panel', () => {
  it('edits a classic working copy', async () => {
    const { run } = setup();
    const path = '/grafana/dashboards/checkout/dashboard.json';
    const result = await run(
      [
        `grafana-dashboard set-panel ${path} --panel 1 --title 'HTTP request rate' --unit reqps --w 12 | jq -c .changed`,
        `grafana-dashboard add-panel ${path} --title 'HTTP 5xx rate' --expr 'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))' --legend 5xx --right-of 1 | jq -c '[.panel, .position]'`,
        `jq -c '[.spec.panels[] | {id, title, gridPos, unit: .fieldConfig.defaults.unit, ds: .targets[0].datasource.uid, legend: .targets[0].legendFormat}]' ${path}`,
        `grafana-dashboard validate ${path} | jq .ok`,
      ].join(' && ')
    );
    expect(result.stderr).toBe('');
    const [changed, added, panels, ok] = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(changed).toEqual(['title', 'unit', 'position']);
    expect(added).toEqual(['2', { x: 12, y: 0, w: 12, h: 8 }]);
    expect(panels).toEqual([
      {
        id: 1,
        title: 'HTTP request rate',
        gridPos: { x: 0, y: 0, w: 12, h: 8 },
        unit: 'reqps',
        ds: null,
        legend: null,
      },
      {
        id: 2,
        title: 'HTTP 5xx rate',
        gridPos: { x: 12, y: 0, w: 12, h: 8 },
        unit: null,
        ds: 'prometheus',
        legend: '5xx',
      },
    ]);
    expect(ok).toBe(true);
  });

  it('edits a v2 file, including queries by refId, and rejects positions outside the grid', async () => {
    const { run } = setup();
    const v2 = {
      apiVersion: 'dashboard.grafana.app/v2',
      kind: 'Dashboard',
      metadata: { name: 'v2dash' },
      spec: {
        title: 'V2',
        elements: {
          'panel-1': {
            kind: 'Panel',
            spec: {
              id: 1,
              title: 'Requests',
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
                          datasource: { name: 'prometheus' },
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
        layout: {
          kind: 'GridLayout',
          spec: {
            items: [
              {
                kind: 'GridLayoutItem',
                spec: { x: 0, y: 0, width: 24, height: 8, element: { kind: 'ElementReference', name: 'panel-1' } },
              },
            ],
          },
        },
        variables: [],
      },
    };
    const path = '/workspace/v2.json';
    const result = await run(
      [
        `echo '${JSON.stringify(v2)}' > ${path}`,
        `grafana-dashboard set-panel ${path} --panel panel-1 --w 12 --expr 'sum(up)' --ref A --expr 'count(up)' --ref B --type stat > /dev/null`,
        `grafana-dashboard add-panel ${path} --title Errors --expr 'sum(rate(errors_total[5m]))' --right-of panel-1 > /dev/null`,
        `jq -c '[.spec.elements | to_entries[] | {name: .key, type: .value.spec.vizConfig.group, exprs: [.value.spec.data.spec.queries[].spec.query.spec.expr], ds: [.value.spec.data.spec.queries[].spec.query.datasource.name]}]' ${path}`,
        `jq -c '[.spec.layout.spec.items[].spec | [.element.name, .x, .y, .width, .height]]' ${path}`,
        `grafana-dashboard validate ${path} | jq .ok`,
      ].join(' && ')
    );
    expect(result.stderr).toBe('');
    const [elements, layout, ok] = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(elements).toEqual([
      { name: 'panel-1', type: 'stat', exprs: ['sum(up)', 'count(up)'], ds: ['prometheus', 'prometheus'] },
      { name: 'panel-2', type: 'timeseries', exprs: ['sum(rate(errors_total[5m]))'], ds: ['prometheus'] },
    ]);
    expect(layout).toEqual([
      ['panel-1', 0, 0, 12, 8],
      ['panel-2', 12, 0, 12, 8],
    ]);
    expect(ok).toBe(true);

    const bad = await run(`grafana-dashboard set-panel ${path} --panel panel-2 --x 20 --w 12`);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('does not fit');
  });
});
