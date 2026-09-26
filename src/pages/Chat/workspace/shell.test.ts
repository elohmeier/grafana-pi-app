import { runWorkspaceBash, type WorkspaceShellDeps } from './shell';
import { createJsonnetLibraryMount } from './mounts';
import { createFakeDashboardBroker } from './testUtils';
import { SessionWorkspace } from './workspace';

const PANEL = {
  id: 1,
  type: 'timeseries',
  title: 'Requests',
  gridPos: { x: 0, y: 0, w: 12, h: 8 },
  datasource: { uid: 'prometheus', type: 'prometheus' },
  targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total[$__rate_interval]))' }],
};

function setup(limits = {}) {
  const fake = createFakeDashboardBroker([
    { uid: 'checkout', title: 'Checkout', panels: [PANEL] },
    { uid: 'payments', title: 'Payments', panels: [{ ...PANEL, targets: [{ refId: 'A', expr: 'up' }] }] },
    { uid: 'provisioned', title: 'Provisioned', managedBy: 'file:/etc/dashboards' },
  ]);
  const workspace = new SessionWorkspace(limits);
  workspace.setHydrator((_kind, uid, signal) => fake.broker.dashboards!.get(uid, signal));
  const approvals = { request: jest.fn(async () => ({ approved: true })) };
  const deps: WorkspaceShellDeps = { workspace, broker: fake.broker, approvals };
  const run = (command: string, extra: { timeoutMs?: number; cwd?: string } = {}) =>
    runWorkspaceBash(deps, { command, ...extra });
  return { ...fake, workspace, approvals, run };
}

describe('workspace bash', () => {
  it('supports pipes, redirection, rg, jq, and find over the session filesystem', async () => {
    const { run, workspace } = setup();
    const write = await run(`printf 'alpha\\nbeta\\n' > notes.txt && mkdir -p a/b && echo '{"x":1}' > a/b/data.json`);
    expect(write.exitCode).toBe(0);
    expect(write.changes.map((change) => change.path)).toEqual(['/workspace/a/b/data.json', '/workspace/notes.txt']);

    const search = await run(`rg -n beta /workspace && jq '.x + 1' a/b/data.json && find /workspace -name '*.json'`);
    expect(search.stdout).toBe('/workspace/notes.txt:2:beta\n2\n/workspace/a/b/data.json\n');
    expect(workspace.getScratchFile('/workspace/notes.txt')?.content).toBe('alpha\nbeta\n');
  });

  it('resets shell state per invocation but keeps files', async () => {
    const { run } = setup();
    await run('X=42; cd /tmp; echo $X > x.txt');
    const second = await run('echo "[$X]"; pwd; cat /tmp/x.txt');
    expect(second.stdout).toBe('[]\n/workspace\n42\n');
  });

  it('lazily hydrates dashboards and edits them as local working copies', async () => {
    const { run, workspace, calls } = setup();
    const listBefore = await run('ls /grafana/dashboards');
    expect(listBefore.stdout).toBe('');

    const edit = await run(
      `jq '.spec.title = "Checkout reliability"' /grafana/dashboards/checkout/dashboard.json > /tmp/d.json && mv /tmp/d.json /grafana/dashboards/checkout/dashboard.json`
    );
    expect(edit.exitCode).toBe(0);
    expect(calls).toContain('get:checkout');
    expect(edit.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/grafana/dashboards/checkout/dashboard.json', change: 'modified' }),
      ])
    );
    expect(workspace.status()).toEqual([
      expect.objectContaining({ uid: 'checkout', change: 'modified', resourceVersion: '101' }),
    ]);

    const meta = await run(
      'jq -r .writable,.localChange /grafana/dashboards/checkout/meta.json && ls /grafana/dashboards'
    );
    expect(meta.stdout).toBe('true\nmodified\ncheckout\n');
  });

  it('rejects writes outside writable mounts and to provider-owned files', async () => {
    const { run, workspace } = setup();
    await run('grafana fetch checkout');
    const meta = await run('echo x > /grafana/dashboards/checkout/meta.json');
    expect(meta.exitCode).not.toBe(0);
    expect(meta.stderr).toMatch(/read-only/);

    const root = await run('echo x > /etc-passwd');
    expect(root.exitCode).not.toBe(0);
    expect(root.stderr).toMatch(/read-only/);

    const link = await run('ln -s /workspace /workspace/loop');
    expect(link.exitCode).not.toBe(0);
    expect(workspace.status()).toEqual([]);
  });

  it('keeps managed resources read-only', async () => {
    const { run } = setup();
    const result = await run(`echo '{}' > /grafana/dashboards/provisioned/dashboard.json`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/managed by file:\/etc\/dashboards/);
  });

  it('discards the whole invocation when a quota check fails at commit', async () => {
    const { run, workspace } = setup({ maxFiles: 2 });
    const result = await run('echo 1 > one; echo 2 > two; echo 3 > three');
    expect(result.exitCode).toBe(1);
    expect(result.discardedChanges).toMatch(/file limit/);
    expect(workspace.scratchFiles().size).toBe(0);
  });

  it('enforces per-file byte limits while executing', async () => {
    const { run, workspace } = setup({ maxFileBytes: 16 });
    const result = await run('printf "%040d" 0 > big.txt; echo done');
    expect(result.stderr).toMatch(/EQUOTA/);
    expect(workspace.getScratchFile('/workspace/big.txt')).toBeUndefined();
  });

  it('terminates runaway loops', async () => {
    const { run } = setup();
    const result = await run('while true; do :; done');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/too many/);
  });

  it('stages resource deletion as a tombstone', async () => {
    const { run, workspace } = setup();
    await run('grafana fetch payments');
    const result = await run('rm -r /grafana/dashboards/payments');
    expect(result.exitCode).toBe(0);
    expect(workspace.status()).toEqual([expect.objectContaining({ uid: 'payments', change: 'deleted' })]);
    const listing = await run('ls /grafana/dashboards');
    expect(listing.stdout).toBe('');
  });

  it('prints generated help for registered commands', async () => {
    const { run } = setup();
    const help = await run('grafana --help && workspace plan --help');
    expect(help.stdout).toContain('grafana search [QUERY]');
    expect(help.stdout).toContain('Usage: workspace plan');
    const unknown = await run('grafana nope');
    expect(unknown.exitCode).toBe(2);
  });
});

describe('workspace commands', () => {
  it('searches with coverage and pipes into jq', async () => {
    const { run } = setup();
    const result = await run(`grafana search check | jq -c '[.results[].uid, .coverage.hasMore]'`);
    expect(result.stdout).toBe('["checkout",false]\n');
  });

  it('inspects and validates dashboards including PromQL syntax', async () => {
    const { run } = setup();
    const inspect = await run(
      `grafana-dashboard inspect /grafana/dashboards/checkout/dashboard.json | jq -c '.panels[0].queries'`
    );
    expect(JSON.parse(inspect.stdout)).toEqual([
      {
        refId: 'A',
        datasourceUid: 'prometheus',
        datasourceType: 'prometheus',
        expr: 'sum(rate(http_requests_total[$__rate_interval]))',
      },
    ]);

    const valid = await run('grafana-dashboard validate /grafana/dashboards/checkout/dashboard.json | jq -c .levels');
    expect(valid.stdout).toBe(
      '{"json":"passed","envelope":"passed","structure":"passed","queries":"passed","policy":"passed","server":"skipped"}\n'
    );

    await run(
      `jq '.spec.panels[0].targets[0].expr = "sum(rate(http_requests_total[5m])" | .spec.panels[0].datasource.uid = "other"' /grafana/dashboards/checkout/dashboard.json > /tmp/x && cp /tmp/x /grafana/dashboards/checkout/dashboard.json`
    );
    const invalid = await run('grafana-dashboard validate /grafana/dashboards/checkout/dashboard.json');
    expect(invalid.exitCode).toBe(1);
    const report = JSON.parse(invalid.stdout);
    expect(report.levels.queries).toBe('failed');
    expect(report.levels.policy).toBe('failed');
  });

  it('plans, requests approval, and applies with revision preconditions', async () => {
    const { run, approvals, store, workspace, calls } = setup();
    await run(
      `jq '.spec.title = "Checkout v2"' /grafana/dashboards/checkout/dashboard.json > /tmp/c && mv /tmp/c /grafana/dashboards/checkout/dashboard.json`
    );
    const plan = await run('workspace plan');
    expect(plan.exitCode).toBe(0);
    const planId = JSON.parse(plan.stdout).planId;

    const apply = await run(`workspace apply ${planId}`);
    expect(apply.exitCode).toBe(0);
    expect((approvals.request.mock.calls[0] as unknown[])[0]).toEqual(
      expect.objectContaining({ planId, diff: expect.stringContaining('+    "title": "Checkout v2"') })
    );
    expect(calls).toContain('update:checkout@101');
    expect(store.get('checkout')?.resource.spec.title).toBe('Checkout v2');
    expect(workspace.status()).toEqual([]);
    expect(workspace.getResource('checkout')?.base?.meta.resourceVersion).toBe(
      String(store.get('checkout')?.resourceVersion)
    );

    // Applying the same plan again is idempotent.
    const again = await run(`workspace apply ${planId}`);
    expect(again.exitCode).toBe(0);
    expect(calls.filter((call) => call.startsWith('update:'))).toHaveLength(1);
  });

  it('invalidates plans when the working copy changes and reports remote conflicts', async () => {
    const { run, touch } = setup();
    await run(`sed -i 's/"Payments"/"Payments 2"/' /grafana/dashboards/payments/dashboard.json`);
    const planId = JSON.parse((await run('workspace plan')).stdout).planId;
    await run(`sed -i 's/"Payments 2"/"Payments 3"/' /grafana/dashboards/payments/dashboard.json`);
    const stale = await run(`workspace apply ${planId}`);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toMatch(/stale/);

    const fresh = JSON.parse((await run('workspace plan')).stdout).planId;
    touch('payments');
    const conflicted = await run(`workspace apply ${fresh}`);
    expect(conflicted.exitCode).toBe(1);
    expect(JSON.parse(conflicted.stdout).results[0]).toEqual(expect.objectContaining({ outcome: 'conflicted' }));
  });

  it('refuses to plan invalid documents and honours denied approvals', async () => {
    const { run, approvals, calls } = setup();
    await run(`echo '{"broken":' > /grafana/dashboards/checkout/dashboard.json`);
    const invalid = await run('workspace plan');
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toMatch(/invalid JSON/);

    await run('workspace discard /grafana/dashboards/checkout/dashboard.json');
    await run(`sed -i 's/"Checkout"/"Checkout!"/' /grafana/dashboards/checkout/dashboard.json`);
    approvals.request.mockResolvedValueOnce({ approved: false });
    const planId = JSON.parse((await run('workspace plan')).stdout).planId;
    const denied = await run(`workspace apply ${planId}`);
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toMatch(/not approved/);
    expect(calls.some((call) => call.startsWith('update:'))).toBe(false);
  });

  it('creates new dashboards from scratch files', async () => {
    const { run, store } = setup();
    const doc = JSON.stringify({
      apiVersion: 'dashboard.grafana.app/v1',
      kind: 'Dashboard',
      metadata: { name: 'new-dash' },
      spec: { title: 'New', panels: [PANEL] },
    });
    await run(`mkdir -p /grafana/dashboards/new-dash && echo '${doc}' > /grafana/dashboards/new-dash/dashboard.json`);
    const plan = JSON.parse((await run('workspace plan')).stdout);
    expect(plan.operations).toEqual([expect.objectContaining({ operation: 'create', uid: 'new-dash' })]);
    const apply = await run(`workspace apply ${plan.planId}`);
    expect(apply.exitCode).toBe(0);
    expect(store.get('new-dash')?.resource.spec.title).toBe('New');
  });

  it('runs Prometheus discovery commands', async () => {
    const { run } = setup();
    const metrics = await run(`grafana-prom metrics '^http_' | wc -l`);
    expect(metrics.stdout.trim()).toBe('2');
    const query = await run(`grafana-prom query 'up' --from now-1h | jq -r .queryType`);
    expect(query.stdout).toBe('range\n');
  });
});

describe('workspace persistence', () => {
  it('round-trips scratch files, overlays, and plans but drops /tmp and unmodified bases', async () => {
    const { run, workspace } = setup();
    await run('echo keep > /workspace/a.txt; echo drop > /tmp/b.txt; echo plan > /session/plan.md');
    await run('grafana fetch payments');
    await run(`sed -i 's/"Checkout"/"Checkout!"/' /grafana/dashboards/checkout/dashboard.json`);
    await run('workspace plan');

    const persisted = JSON.parse(JSON.stringify(workspace.serialize()));
    const payments = persisted.resources.find((resource: { uid: string }) => resource.uid === 'payments');
    expect(payments.base.content).toBeUndefined();

    const restored = SessionWorkspace.restore(persisted);
    expect(restored.getScratchFile('/workspace/a.txt')?.content).toBe('keep\n');
    expect(restored.getScratchFile('/session/plan.md')?.content).toBe('plan\n');
    expect(restored.getScratchFile('/tmp/b.txt')).toBeUndefined();
    expect(restored.status()).toEqual([expect.objectContaining({ uid: 'checkout', change: 'modified' })]);
    expect(restored.listPlans()).toHaveLength(1);
  });
});

describe('jsonnet command', () => {
  function jsonnetSetup() {
    const base = setup();
    const requests: Array<Record<string, any>> = [];
    const packageLoads: string[] = [];
    base.broker.jsonnet = {
      async evaluate(request) {
        requests.push(request);
        const source = request.files[request.entrypoint];
        if (source.includes('error')) {
          throw new Error('RUNTIME ERROR: boom\n\t/workspace/bad.jsonnet:1:1');
        }
        if (source.includes('wrapped')) {
          return JSON.stringify({ dashboard: { metadata: { uid: 'x' }, spec: { panels: [] } } });
        }
        if (source.includes('rows-as-panels')) {
          return JSON.stringify({
            title: 'X',
            panels: [{ title: 'Metrics', collapsed: false, height: 9, panels: [] }],
          });
        }
        return `${JSON.stringify({ id: 7, title: request.extStr?.title ?? 'T', panels: [PANEL] }, null, 3)}\n`;
      },
      async fix(source) {
        return { source: source.replace('span=6', ''), repairs: ['removed span argument'] };
      },
      async listLibraryFiles() {
        return {
          packages: ['github.com/g42/pi-dashboard', 'github.com/jsonnet-libs/xtd'],
          files: [
            { path: 'github.com/g42/pi-dashboard/README.md', size: 10 },
            { path: 'github.com/g42/pi-dashboard/main.libsonnet', size: 40 },
            { path: 'github.com/jsonnet-libs/xtd/main.libsonnet', size: 3 },
          ],
        };
      },
      async loadLibraryPackage(pkg): Promise<Record<string, string>> {
        packageLoads.push(pkg);
        return pkg === 'github.com/g42/pi-dashboard'
          ? {
              'github.com/g42/pi-dashboard/README.md': '# Helpers\n',
              'github.com/g42/pi-dashboard/main.libsonnet': '{\n  panel: {\n    timeseries(title):: {},\n  },\n}\n',
            }
          : { 'github.com/jsonnet-libs/xtd/main.libsonnet': '{}\n' };
      },
    };
    base.workspace.setGeneratedMounts([createJsonnetLibraryMount(base.broker.jsonnet)]);
    return { ...base, requests, packageLoads };
  }

  it('evaluates workspace files CLI-style and sends importable files', async () => {
    const { run, requests } = jsonnetSetup();
    await run(`mkdir -p lib && echo '{}' > lib/x.libsonnet && echo '{}' > dash.jsonnet && echo notes > n.bin`);
    const result = await run(`jsonnet dash.jsonnet -V title=Checkout | jq -r .title`);
    expect(result.stdout).toBe('Checkout\n');
    expect(Object.keys(requests[0].files).sort()).toEqual(['/workspace/dash.jsonnet', '/workspace/lib/x.libsonnet']);
    expect(requests[0].entrypoint).toBe('/workspace/dash.jsonnet');
  });

  it('renders into a dashboard working copy with --resource', async () => {
    const { run, workspace } = jsonnetSetup();
    await run(`echo '{}' > dash.jsonnet`);
    const result = await run(
      'mkdir -p /grafana/dashboards/new-slo && jsonnet dash.jsonnet --resource new-slo -o /grafana/dashboards/new-slo/dashboard.json && grafana-dashboard validate /grafana/dashboards/new-slo/dashboard.json | jq .ok'
    );
    expect(result.stdout).toBe('true\n');
    const doc = JSON.parse(workspace.resourceContent(workspace.getResource('new-slo')!)!);
    expect(doc).toEqual(
      expect.objectContaining({ apiVersion: 'dashboard.grafana.app/v1', metadata: { name: 'new-slo' } })
    );
    expect(doc.spec.id).toBeUndefined();
    expect(doc.spec.uid).toBe('new-slo');
    expect(workspace.status()).toEqual([expect.objectContaining({ uid: 'new-slo', change: 'created' })]);
  });

  it('rejects --resource output that is not a classic dashboard, with the helper usage', async () => {
    const { run, workspace } = jsonnetSetup();
    await run(`echo wrapped > wrapped.jsonnet && echo rows-as-panels > rows.jsonnet && mkdir -p /grafana/dashboards/x`);
    const wrapped = await run('jsonnet wrapped.jsonnet --resource x -o /grafana/dashboards/x/dashboard.json');
    expect(wrapped.exitCode).toBe(1);
    expect(wrapped.stderr).toContain('got top-level keys [dashboard]');
    expect(wrapped.stderr).toContain('d.dashboard.new(');

    const rows = await run('jsonnet rows.jsonnet --resource x -o /grafana/dashboards/x/dashboard.json');
    expect(rows.exitCode).toBe(1);
    expect(rows.stderr).toContain('panels[0] has none');
    expect(workspace.getResource('x')).toBeUndefined();
  });

  it('reports evaluation errors and applies explicit fixes', async () => {
    const { run, workspace } = jsonnetSetup();
    await run(`echo 'error' > bad.jsonnet && echo 'panel(span=6)' > fixme.jsonnet`);
    const bad = await run('jsonnet bad.jsonnet');
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('RUNTIME ERROR: boom');

    const fixed = await run('jsonnet fix fixme.jsonnet | jq -c .repairs');
    expect(fixed.stdout).toBe('["removed span argument"]\n');
    expect(workspace.getScratchFile('/workspace/fixme.jsonnet')?.content).toBe('panel()\n');
  });

  it('mounts vendored libraries read-only at their import paths', async () => {
    const { run, packageLoads } = jsonnetSetup();
    const result = await run(
      'find /lib/jsonnet -name "*.libsonnet" | sort && rg -n "timeseries" /lib/jsonnet/github.com/g42 && head -1 /lib/jsonnet/github.com/g42/pi-dashboard/README.md'
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      [
        '/lib/jsonnet/github.com/g42/pi-dashboard/main.libsonnet',
        '/lib/jsonnet/github.com/jsonnet-libs/xtd/main.libsonnet',
        '/lib/jsonnet/github.com/g42/pi-dashboard/main.libsonnet:3:    timeseries(title):: {},',
        '# Helpers',
        '',
      ].join('\n')
    );
    expect(packageLoads).not.toContain('github.com/jsonnet-libs/xtd');
    expect((await run('ls /lib && ls /lib/jsonnet/github.com')).stdout).toBe('jsonnet\ng42\njsonnet-libs\n');

    const write = await run('echo x > /lib/jsonnet/github.com/g42/pi-dashboard/main.libsonnet');
    expect(write.exitCode).not.toBe(0);
    expect(write.stderr).toMatch(/read-only/);
  });
});

describe('approval waits', () => {
  it('does not count time waiting for approval against the bash timeout', async () => {
    const { run, approvals, calls } = setup();
    await run(`sed -i 's/"Checkout"/"Checkout slow"/' /grafana/dashboards/checkout/dashboard.json`);
    const planId = JSON.parse((await run('workspace plan')).stdout).planId;
    approvals.request.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ approved: true }), 1500))
    );
    const result = await run(`workspace apply ${planId}`, { timeoutMs: 1000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(calls).toContain('update:checkout@101');
  });
});

describe('grafana-prom query batches', () => {
  it('validates several expressions in one call', async () => {
    const { run } = setup();
    const result = await run(
      `grafana-prom query -e up -e 'sum(rate(http_requests_total[5m]))' --from now-1h | jq -c '[.queryType, (.results | length)]'`
    );
    expect(result.stdout).toBe('["range",2]\n');
  });
});

describe('grafana-prom labels', () => {
  it('lists label names when no label is given', async () => {
    const { run } = setup();
    const result = await run('grafana-prom labels --match http_requests_total');
    expect(result.stdout).toBe('__name__\njob\nroute\nstatus\n');
  });
});

describe('workspace commands inside one bash call', () => {
  it('see files staged earlier in the same invocation', async () => {
    const { run, store } = setup();
    const doc = JSON.stringify({
      apiVersion: 'dashboard.grafana.app/v1',
      kind: 'Dashboard',
      metadata: { name: 'same-call' },
      spec: { title: 'Same call', panels: [PANEL] },
    });
    const result = await run(
      `mkdir -p /grafana/dashboards/same-call && echo '${doc}' > /grafana/dashboards/same-call/dashboard.json && id=$(workspace plan | jq -r .planId) && workspace apply "$id" | jq -r '.results[0].outcome'`
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('applied\n');
    expect(store.get('same-call')?.resource.spec.title).toBe('Same call');
    expect(result.changes).toEqual([expect.objectContaining({ path: '/grafana/dashboards/same-call/dashboard.json' })]);
  });
});

describe('folder checks', () => {
  it('fails validation for folder annotations that do not resolve', async () => {
    const { run } = setup();
    const ok = await run('grafana-dashboard validate /grafana/dashboards/checkout/dashboard.json | jq .ok');
    expect(ok.stdout).toBe('true\n');
    await run(
      `jq '.metadata.annotations["grafana.app/folder"] = "missing"' /grafana/dashboards/checkout/dashboard.json > /tmp/d && mv /tmp/d /grafana/dashboards/checkout/dashboard.json`
    );
    const bad = await run('grafana-dashboard validate /grafana/dashboards/checkout/dashboard.json');
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout).toContain('folder \\"missing\\" does not exist');
  });
});

describe('dashboard validation with Grafana services', () => {
  it('uses the backend PromQL parser and reports its diagnostics', async () => {
    const { run, broker } = setup();
    const parsed: string[] = [];
    broker.promql = {
      name: 'prometheus',
      async parse(queries) {
        parsed.push(...queries.map((query) => query.expr));
        return queries.map(({ id }) => ({ id, error: '1:5: parse error: unknown escape sequence U+002E' }));
      },
    };
    const result = await run('grafana-dashboard validate /grafana/dashboards/checkout/dashboard.json');
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.promqlParser).toBe('prometheus');
    expect(report.errors[0]).toMatchObject({ level: 'queries', path: 'panel 1 "Requests" query A' });
    expect(report.errors[0].message).toContain('unknown escape sequence');
    expect(parsed).toEqual(['sum(rate(http_requests_total[5m]))']);
  });

  it('falls back to the offline parser when the backend is unavailable', async () => {
    const { run, broker } = setup();
    broker.promql = {
      name: 'prometheus',
      async parse() {
        throw new Error('PromQL parser unavailable: 502');
      },
    };
    const result = await run('grafana-dashboard validate /grafana/dashboards/checkout/dashboard.json');
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.promqlParser).toBe('lezer');
    expect(report.warnings[0].message).toContain('less strict offline parser');
  });

  it('dry-runs updates and new dashboards with --server', async () => {
    const { run, calls, touch } = setup();
    const ok = await run('grafana-dashboard validate --server /grafana/dashboards/checkout/dashboard.json');
    expect(JSON.parse(ok.stdout).levels.server).toBe('passed');
    expect(calls).toContain('dryRun:checkout@101');

    touch('checkout');
    const conflict = await run('grafana-dashboard validate --server /grafana/dashboards/checkout/dashboard.json');
    expect(conflict.exitCode).toBe(1);
    expect(JSON.parse(conflict.stdout).errors[0].message).toMatch(/^conflict: .*grafana refresh/);

    const doc = JSON.stringify({
      apiVersion: 'dashboard.grafana.app/v1',
      kind: 'Dashboard',
      metadata: { name: 'brand-new' },
      spec: { title: 'New', panels: [PANEL] },
    });
    const created = await run(
      `mkdir -p /grafana/dashboards/brand-new && echo '${doc}' > /grafana/dashboards/brand-new/dashboard.json && grafana-dashboard validate --server /grafana/dashboards/brand-new/dashboard.json | jq -r .levels.server`
    );
    expect(created.stdout).toBe('passed\n');
    expect(calls).toContain('dryRun:brand-new@new');
  });
});

describe('grafana-dashboard data', () => {
  const frame = (refId: string, labels: Record<string, string>, values: number[]) => ({
    schema: {
      refId,
      fields: [
        { name: 'Time', type: 'time' },
        { name: 'Value', type: 'number', labels },
      ],
    },
    data: { values: [values.map((_, index) => 1_700_000_000_000 + index * 60_000), values] },
  });

  it('queries panels as rendered, with units, transformations, and policy skips', async () => {
    const { run, setDataResponse, dataRequests } = setup();
    const panels = [
      {
        ...PANEL,
        fieldConfig: { defaults: { unit: 'percent' }, overrides: [] },
        targets: [{ refId: 'A', expr: 'sum by (job) (rate(http_requests_total{job=~"$job"}[$__rate_interval]))' }],
      },
      {
        id: 2,
        type: 'table',
        title: 'Top jobs',
        gridPos: { x: 12, y: 0, w: 12, h: 8 },
        datasource: { uid: 'prometheus', type: 'prometheus' },
        targets: [{ refId: 'A', expr: 'up' }],
        transformations: [{ id: 'reduce', options: { reducers: ['max'] } }],
      },
      {
        id: 3,
        type: 'logs',
        title: 'Logs',
        gridPos: { x: 0, y: 8, w: 24, h: 8 },
        datasource: { uid: 'loki', type: 'loki' },
        targets: [{ refId: 'A', expr: '{app="x"}' }],
      },
    ];
    const templating = {
      list: [{ name: 'job', multi: true, includeAll: true, current: { value: ['$__all'], text: ['All'] } }],
    };
    await run(
      `jq '.spec.panels = ${JSON.stringify(panels).replace(/'/g, "'\\''")} | .spec.templating = ${JSON.stringify(templating)}' /grafana/dashboards/checkout/dashboard.json > /tmp/d && mv /tmp/d /grafana/dashboards/checkout/dashboard.json`
    );
    setDataResponse((request) => ({
      results: {
        A:
          request.queries[0].expr === 'up'
            ? { frames: [frame('A', { job: 'api' }, [1, 0, 1]), frame('A', { job: 'web' }, [0, 0, 0])] }
            : { frames: [frame('A', { job: 'api' }, [10, 30, 20])] },
      },
    }));

    const result = await run('grafana-dashboard data /grafana/dashboards/checkout/dashboard.json --from now-1h');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.notes[0]).toContain('$job');
    const [series, table, logs] = report.panels;
    expect(series).toMatchObject({ id: '1', status: 'ok', seriesTotal: 1 });
    expect(series.series[0].calcs).toMatchObject({ lastNotNull: 20, min: 10, max: 30 });
    expect(series.series[0].display.max).toBe('30%');
    expect(table.status).toBe('ok');
    expect(table.tables[0].columns).toEqual(['Field', 'Max']);
    expect(table.tables[0].rowCount).toBe(2);
    expect(logs).toMatchObject({
      status: 'skipped',
      skippedReason: 'datasource type loki is not available to the assistant',
    });

    expect(dataRequests).toHaveLength(2);
    const sent = dataRequests.find((request) => request.queries[0].expr !== 'up')!;
    expect(sent.queries[0]).toMatchObject({
      expr: 'sum by (job) (rate(http_requests_total{job=~".*"}[$__rate_interval]))',
      datasource: { type: 'prometheus', uid: 'prometheus' },
      maxDataPoints: 1000,
      // 1h / 1000 points is below the datasource scrape interval, which bounds the step.
      intervalMs: 60_000,
    });
    expect(Number(sent.to) - Number(sent.from)).toBeCloseTo(3_600_000, -4);
  });

  it('reports errors inside HTTP 200 responses, empty results, and unknown panels', async () => {
    const { run, setDataResponse } = setup();
    setDataResponse(() => ({ results: { A: { status: 400, error: 'bad_data: parse error' } } }));
    const failed = await run('grafana-dashboard data /grafana/dashboards/checkout/dashboard.json --panel 1');
    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(failed.stdout).panels[0]).toMatchObject({
      status: 'error',
      errors: ['A: bad_data: parse error', 'A: status 400'],
    });

    setDataResponse(() => ({
      results: {
        A: {
          frames: [
            {
              schema: {
                refId: 'A',
                meta: {
                  executedQueryString: 'Expr: sum(rate(http_requests_total[25s]))\nStep: 20s',
                  notices: [{ severity: 'warning', text: 'PromQL info: metric might not be a counter' }],
                },
                fields: [
                  { name: 'Time', type: 'time' },
                  { name: 'Value', type: 'number' },
                ],
              },
              data: { values: [[], []] },
            },
          ],
        },
      },
    }));
    const empty = await run('grafana-dashboard data /grafana/dashboards/checkout/dashboard.json | jq -c .panels[0]');
    expect(JSON.parse(empty.stdout)).toMatchObject({
      status: 'empty',
      executedQueries: ['Expr: sum(rate(http_requests_total[25s])); Step: 20s'],
      notices: ['PromQL info: metric might not be a counter'],
    });

    const unknown = await run('grafana-dashboard data /grafana/dashboards/checkout/dashboard.json --panel 9');
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('no panel with id "9"; available: 1');
  });
});

describe('grafana-dashboard inspect', () => {
  it('reports rows, layout, display settings, variables, and Grafana metadata', async () => {
    const { run } = setup();
    const panels = [
      { id: 9, type: 'row', title: 'Traffic', collapsed: false, gridPos: { x: 0, y: 0, w: 24, h: 1 }, panels: [] },
      {
        ...PANEL,
        gridPos: { x: 0, y: 1, w: 12, h: 8 },
        description: 'Requests  per\nsecond',
        targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total[5m]))', legendFormat: '{{job}}' }],
        transformations: [{ id: 'organize', options: {} }],
        fieldConfig: {
          defaults: {
            unit: 'reqps',
            thresholds: {
              mode: 'absolute',
              steps: [
                { color: 'green', value: null },
                { color: 'red', value: 100 },
              ],
            },
          },
          overrides: [{}],
        },
        options: { legend: { calcs: ['mean'] } },
        links: [{ title: 'Runbook', url: 'https://runbooks/x' }],
      },
      { id: 2, type: 'text', title: 'Notes', gridPos: { x: 12, y: 1, w: 12, h: 8 } },
    ];
    const templating = {
      list: [
        {
          name: 'job',
          type: 'query',
          multi: true,
          query: { query: 'label_values(up, job)' },
          current: { value: ['api', 'web'] },
        },
      ],
    };
    await run(
      `jq '.spec.panels = ${JSON.stringify(panels).replace(/'/g, "'\\''")} | .spec.templating = ${JSON.stringify(templating)} | .spec.time = {"from":"now-6h","to":"now"}' /grafana/dashboards/checkout/dashboard.json > /tmp/d && mv /tmp/d /grafana/dashboards/checkout/dashboard.json`
    );
    const result = await run('grafana-dashboard inspect /grafana/dashboards/checkout/dashboard.json --panel 1');
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.panelCount).toBe(2);
    expect(report.panels).toEqual([
      {
        key: 'panel-1',
        id: 1,
        title: 'Requests',
        type: 'timeseries',
        rowPath: ['Traffic'],
        gridPos: { x: 0, y: 1, w: 12, h: 8 },
        description: 'Requests per second',
        datasourceUid: 'prometheus',
        queries: [
          {
            refId: 'A',
            datasourceUid: 'prometheus',
            datasourceType: 'prometheus',
            expr: 'sum(rate(http_requests_total[5m]))',
            legendFormat: '{{job}}',
          },
        ],
        transformations: ['organize'],
        display: {
          unit: 'reqps',
          thresholds: ['base:green', '100:red'],
          thresholdsMode: 'absolute',
          overrides: 1,
          legendCalcs: ['mean'],
        },
        links: ['Runbook -> https://runbooks/x'],
      },
    ]);
    expect(report.variables).toEqual([
      { name: 'job', type: 'query', query: 'label_values(up, job)', current: ['api', 'web'], multi: true },
    ]);
    expect(report.time).toEqual({ from: 'now-6h', to: 'now' });
    expect(report.grafana).toMatchObject({ resourceVersion: '101' });

    const missing = await run('grafana-dashboard inspect /grafana/dashboards/checkout/dashboard.json --panel 7');
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('no panel "7"; available: 1, 2');
  });
});
