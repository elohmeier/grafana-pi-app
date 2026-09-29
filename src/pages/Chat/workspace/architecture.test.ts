import { ArtifactStore } from '../session/artifactStore';
import { createArtifactsMount } from './mounts';
import { runWorkspaceBash } from './shell';
import { createFakeDashboardBroker } from './testUtils';
import { SessionWorkspace } from './workspace';

function setup() {
  const fake = createFakeDashboardBroker([
    { uid: 'one', title: 'One' },
    { uid: 'two', title: 'Two' },
  ]);
  const workspace = new SessionWorkspace();
  workspace.setHydrator((_kind, uid, signal) => fake.broker.dashboards!.get(uid, signal));
  const artifacts = new ArtifactStore();
  workspace.setGeneratedMounts([createArtifactsMount(artifacts)]);
  const approvals = { request: jest.fn(async (_request: any) => ({ approved: true })) };
  const deps = { workspace, broker: fake.broker, artifacts, approvals };
  return { ...fake, ...deps, run: (command: string) => runWorkspaceBash(deps, { command }) };
}

describe('direct apply and composable shell', () => {
  it('status and diff see staged writes without committing on a later policy failure', async () => {
    const { run, workspace } = setup();
    const result = await run(
      `echo note > /session/note; sed -i 's/"One"/"Edited"/' /grafana/dashboards/one/dashboard.json; workspace status; workspace diff; echo forbidden > /etc/forbidden`
    );
    expect(result.exitCode).not.toBe(0);
    expect(workspace.getScratchFile('/session/note')).toBeUndefined();
    expect(workspace.status()).toEqual([]);
    expect(result.changes).toEqual([]);
  });

  it('discard is also rolled back when a later quota check fails', async () => {
    const { run, workspace } = setup();
    await run(`sed -i 's/"One"/"Edited"/' /grafana/dashboards/one/dashboard.json`);
    const result = await run(
      'workspace discard /grafana/dashboards/one/dashboard.json; echo forbidden > /etc/forbidden'
    );
    expect(result.exitCode).not.toBe(0);
    expect(workspace.status()).toHaveLength(1);
  });

  it('approves the complete diff and scopes apply to selected files', async () => {
    const { run, workspace, approvals, calls } = setup();
    const tx = workspace.begin();
    for (const uid of ['one', 'two']) {
      const path = `/grafana/dashboards/${uid}/dashboard.json`;
      const document = JSON.parse(await tx.readFile(path));
      document.spec.description = 'x'.repeat(70000) + 'FINAL-CHANGE';
      await tx.writeFile(path, JSON.stringify(document, null, 2));
    }
    tx.commit();
    const result = await run('workspace apply --path /grafana/dashboards/one/dashboard.json');
    expect(result.exitCode).toBe(0);
    const approval = approvals.request.mock.calls[0][0];
    expect(approval.operations).toHaveLength(1);
    expect(approval.operations[0].diff).toContain('FINAL-CHANGE');
    expect(approval.operations[0].diff.length).toBeGreaterThan(60000);
    expect(approval).not.toHaveProperty('planId');
    expect(calls.filter((call) => call.startsWith('update:'))).toEqual(['update:one@101']);
    expect(workspace.status().map((entry) => entry.uid)).toEqual(['two']);
    expect(workspace.serialize()).not.toHaveProperty('plans');
  });

  it('reports writes committed by apply even when the remaining script fails', async () => {
    const { run, workspace, store } = setup();
    const result = await run(
      `echo keep > /session/keep; sed -i 's/"One"/"Edited"/' /grafana/dashboards/one/dashboard.json; workspace apply; echo drop > /session/drop; echo forbidden > /etc/forbidden`
    );
    expect(store.get('one')?.resource.spec.title).toBe('Edited');
    expect(workspace.getScratchFile('/session/keep')?.content).toBe('keep\n');
    expect(workspace.getScratchFile('/session/drop')).toBeUndefined();
    expect(result.changes.map((change) => change.path)).toContain('/session/keep');
    expect(result.stderr).toContain('earlier apply boundaries remain committed');
  });

  it('reads query batches from stdin', async () => {
    const { run } = setup();
    const result = await run(`printf 'up\nsum(up)\n' | grafana-prom query --file - | jq '.results | length'`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('2\n');
  });

  it('can read a newly captured artifact in the same invocation', async () => {
    const { run } = setup();
    const result = await run(
      `ls /artifacts; grafana-prom query up > /tmp/query.json; file=$(jq -r '.results[0].artifact' /tmp/query.json); jq '.data.query' "$file"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"up"');
  });

  it('keeps large artifact data available through the filesystem', async () => {
    const { artifacts, run } = setup();
    const data = { body: 'x'.repeat(300000), tail: 'retained' };
    const artifact = artifacts.register({ kind: 'json', title: 'Large', toolName: 'test', summary: 'test', data });
    data.tail = 'mutated';
    const result = await run(`jq -r .data.tail /artifacts/${artifact.id}.json`);
    expect(result.stdout).toBe('retained\n');
  });

  it('captures presentation data before later edits, without querying', async () => {
    const { run, calls } = setup();
    const result = await run(
      `echo '[{"service":"api","errors":3}]' > /workspace/evidence.json; evidence show /workspace/evidence.json --view table --title Errors; echo '[]' > /workspace/evidence.json`
    );
    expect(result.exitCode).toBe(0);
    expect(result.presentations).toEqual([
      expect.objectContaining({ title: 'Errors', view: 'table', data: [{ service: 'api', errors: 3 }] }),
    ]);
    expect(calls).toEqual([]);
  });
});
