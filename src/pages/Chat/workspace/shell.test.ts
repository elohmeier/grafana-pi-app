import { runWorkspaceBash, type WorkspaceShellDeps } from './shell';
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
      '{"json":"passed","envelope":"passed","structure":"passed","queries":"passed","policy":"passed"}\n'
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
    base.broker.jsonnet = {
      async evaluate(request) {
        requests.push(request);
        const source = request.files[request.entrypoint];
        if (source.includes('error')) {
          throw new Error('RUNTIME ERROR: boom\n\t/workspace/bad.jsonnet:1:1');
        }
        return `${JSON.stringify({ id: 7, title: request.extStr?.title ?? 'T', panels: [PANEL] }, null, 3)}\n`;
      },
      async fix(source) {
        return { source: source.replace('span=6', ''), repairs: ['removed span argument'] };
      },
      async listLibraries(path) {
        return { basePath: path ?? 'github.com/g42/pi-dashboard', files: ['main.libsonnet'] };
      },
      async readLibrary(path) {
        return { path, totalLines: 3, lines: [{ line: 1, text: '{' }] };
      },
      async searchLibraries() {
        return { matches: [{ file: 'main.libsonnet', line: 4, text: 'timeseries(' }], capped: false };
      },
    };
    return { ...base, requests };
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

  it('browses vendored libraries', async () => {
    const { run } = jsonnetSetup();
    const result = await run('jsonnet lib ls && jsonnet lib search timeseries');
    expect(result.stdout).toBe('github.com/g42/pi-dashboard/main.libsonnet\nmain.libsonnet:4:timeseries(\n');
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
