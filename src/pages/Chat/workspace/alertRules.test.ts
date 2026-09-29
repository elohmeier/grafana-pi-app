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

import { validateAlertRuleDocument, parseDuration, toAlertRuleSnapshot } from './alertRuleModel';
import { createSessionWorkspaceToolkit } from './index';
import { alertRuleResource, createFakeAlertRuleBroker, createFakeDashboardBroker } from './testUtils';
import { SessionWorkspace } from './workspace';

const RULE = '/grafana/alert-rules/high-5xx/rule.json';
const SIBLING = '/grafana/alert-rules/high-latency/rule.json';

function setup(decide: (request: any) => { approved: boolean; paths?: string[] } = () => ({ approved: true })) {
  const dashboards = createFakeDashboardBroker([{ uid: 'checkout', title: 'Checkout' }]);
  const rules = createFakeAlertRuleBroker([
    alertRuleResource('high-5xx', { title: 'High 5xx', group: 'checkout', groupIndex: 0 }),
    alertRuleResource('high-latency', { title: 'High latency', group: 'checkout', groupIndex: 1 }),
    alertRuleResource('standalone', { title: 'Standalone' }),
    alertRuleResource('provisioned', { title: 'Provisioned', provenance: 'file' }),
  ]);
  const workspace = new SessionWorkspace();
  const approvals = { request: jest.fn(async (request: any) => decide(request)) };
  const toolkit = createSessionWorkspaceToolkit({
    workspace,
    broker: { ...dashboards.broker, alertRules: rules.alertRules },
    approvals,
  });
  const run = (command: string) => toolkit.runShell(command);
  const json = async (command: string) => {
    const result = await run(command);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`not JSON (exit ${result.exitCode}): ${result.stdout}${result.stderr}`);
    }
  };
  return { dashboards, rules, workspace, approvals, run, json };
}

const setThreshold = (path: string, value: number) =>
  `jq '.spec.expressions.C.model.conditions[0].evaluator.params = [${value}]' ${path} > /tmp/rule.json && cp /tmp/rule.json ${path}`;

describe('alert rule working copies', () => {
  it('lists every visible rule and serves rule.json from the listing without further requests', async () => {
    const { run, json, rules } = setup();
    expect((await run('ls /grafana/alert-rules')).stdout.split(/\s+/).filter(Boolean)).toEqual([
      'high-5xx',
      'high-latency',
      'provisioned',
      'standalone',
    ]);
    const rule = await json(`cat ${RULE}`);
    expect(rule).toEqual({
      apiVersion: 'rules.alerting.grafana.app/v0alpha1',
      kind: 'AlertRule',
      metadata: { name: 'high-5xx', annotations: { 'grafana.app/folder': 'ops' } },
      spec: expect.objectContaining({ title: 'High 5xx' }),
    });
    expect((await run('rg -l "5\\.\\." /grafana/alert-rules')).stdout.trim().split('\n')).toHaveLength(4);
    expect(rules.calls).toEqual(['list']);
  });

  it('describes rules in the catalog and provider-owned metadata in meta.json', async () => {
    const { run, json } = setup();
    const catalog = (await run('cat /grafana/catalog/alert-rules.ndjson')).stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(catalog).toContainEqual({
      uid: 'high-5xx',
      title: 'High 5xx',
      folderUid: 'ops',
      folderTitle: 'Operations',
      group: 'checkout',
      labels: { severity: 'warning' },
      writable: true,
      dashboardUid: 'checkout',
      panelId: 1,
      path: RULE,
    });
    expect(catalog).toContainEqual(
      expect.objectContaining({ uid: 'provisioned', provenance: 'file', writable: false })
    );
    expect(await json('cat /grafana/alert-rules/high-5xx/meta.json')).toMatchObject({
      kind: 'alertRule',
      group: 'checkout',
      groupIndex: 0,
      preconditions: 'client',
      writable: true,
    });
  });

  it('keeps provisioned rules read-only', async () => {
    const { run, workspace } = setup();
    const result = await run(setThreshold('/grafana/alert-rules/provisioned/rule.json', 5));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/read-only file system.*provisioning \(provenance file\)/);
    expect((await run('rm -r /grafana/alert-rules/provisioned')).stderr).toMatch(/read-only/);
    expect(workspace.status()).toEqual([]);
  });

  it('stages edits, validates them, and applies a mixed change set in one review', async () => {
    const { run, json, rules, dashboards, approvals, workspace } = setup();
    await run(setThreshold(RULE, 5));
    await run(`sed -i 's/"Checkout"/"Checkout (renamed)"/' /grafana/dashboards/checkout/dashboard.json`);
    expect(workspace.status().map(({ path, resource }) => ({ path, resource }))).toEqual([
      { path: '/grafana/dashboards/checkout/dashboard.json', resource: 'dashboard' },
      { path: RULE, resource: 'alertRule' },
    ]);
    expect(await json('grafana-alert validate')).toEqual(
      expect.objectContaining({ ok: true, reports: [expect.objectContaining({ path: RULE, ok: true })] })
    );
    expect((await json('workspace diff --stat')).alertRules).toEqual([
      expect.objectContaining({ path: RULE, group: 'checkout', additions: 1, deletions: 1 }),
    ]);

    const apply = await run('workspace apply');
    expect(apply.exitCode).toBe(0);
    const request = approvals.request.mock.calls[0][0];
    expect(request.title).toBe('Apply changes to 1 dashboard and 1 alert rule');
    expect(request.operations).toEqual([
      expect.objectContaining({ kind: 'dashboard', path: '/grafana/dashboards/checkout/dashboard.json' }),
      expect.objectContaining({ kind: 'alertRule', path: RULE, group: 'checkout', folderTitle: 'Operations' }),
    ]);
    expect(JSON.parse(apply.stdout).counts).toEqual({ applied: 2 });
    expect(dashboards.store.get('checkout')?.resource.spec.title).toBe('Checkout (renamed)');

    const stored = rules.store.get('high-5xx')!;
    expect(stored.spec.expressions.C.model.conditions[0].evaluator.params).toEqual([5]);
    // Group membership and provider annotations come from the stored rule, not the working copy.
    expect(stored.metadata.labels).toMatchObject({ 'grafana.com/group': 'checkout', 'grafana.com/group-index': '0' });
    expect(stored.metadata.annotations['grafana.com/provenance']).toBe('');
    expect(rules.writes).toHaveLength(1);
    expect(rules.store.get('high-latency')!.metadata.resourceVersion).toBe('1');
    expect(workspace.status()).toEqual([]);
  });

  it('reports a rule changed in Grafana since it was fetched as conflicted', async () => {
    const { run, rules } = setup();
    await run(setThreshold(RULE, 5));
    rules.touch('high-5xx');
    const apply = await run('workspace apply');
    expect(apply.exitCode).toBe(1);
    expect(JSON.parse(apply.stdout).results).toEqual([
      expect.objectContaining({ path: RULE, kind: 'alertRule', outcome: 'conflicted' }),
    ]);
    expect(rules.writes).toEqual([]);
    expect(rules.store.get('high-5xx')!.spec.expressions.C.model.conditions[0].evaluator.params).toEqual([0]);
  });

  it('keeps unchecked rules as working-copy changes', async () => {
    const { run, rules, workspace } = setup((request) => ({
      approved: true,
      paths: request.operations.map((operation: any) => operation.path).filter((path: string) => path !== SIBLING),
    }));
    await run(`${setThreshold(RULE, 5)} && ${setThreshold(SIBLING, 7)}`);
    const receipt = JSON.parse((await run('workspace apply')).stdout);
    expect(receipt.counts).toEqual({ applied: 1, declined: 1 });
    expect(rules.store.get('high-latency')!.spec.expressions.C.model.conditions[0].evaluator.params).toEqual([0]);
    expect(workspace.status().map((change) => change.path)).toEqual([SIBLING]);
  });

  it('rejects changes the single-rule API cannot make before the review', async () => {
    const { run, approvals } = setup();
    await run(`jq '.spec.trigger.interval = "5m"' ${RULE} > /tmp/r && cp /tmp/r ${RULE}`);
    const grouped = await run('workspace apply');
    expect(grouped.exitCode).toBe(1);
    expect(grouped.stderr).toMatch(/evaluation interval belongs to rule group "checkout"/);

    // Ungrouped rules evaluate on their own, so their interval can change.
    await run(`workspace discard ${RULE}`);
    const standalone = '/grafana/alert-rules/standalone/rule.json';
    await run(`jq '.spec.trigger.interval = "5m"' ${standalone} > /tmp/r && cp /tmp/r ${standalone}`);
    expect((await run('grafana-alert validate')).exitCode).toBe(0);

    await run(
      `jq '.metadata.annotations["grafana.app/folder"] = "elsewhere"' ${standalone} > /tmp/r && cp /tmp/r ${standalone}`
    );
    const moved = await run(`grafana-alert validate ${standalone}`);
    expect(moved.exitCode).toBe(1);
    expect(moved.stdout).toMatch(/moving a rule to another folder is not supported here/);
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it('reverts an applied rule change through the same review', async () => {
    const { run, rules, approvals } = setup();
    const { applyId } = JSON.parse((await run(`${setThreshold(RULE, 5)} && workspace apply`)).stdout);
    const staged = JSON.parse((await run(`workspace revert ${applyId}`)).stdout);
    expect(staged.staged).toEqual([RULE]);
    expect((await run('workspace apply')).exitCode).toBe(0);
    expect(approvals.request).toHaveBeenCalledTimes(2);
    expect(rules.store.get('high-5xx')!.spec.expressions.C.model.conditions[0].evaluator.params).toEqual([0]);
  });

  it('reverts in the same invocation that discards a newer local change', async () => {
    const { run, rules } = setup();
    const { applyId } = JSON.parse((await run(`${setThreshold(RULE, 5)} && workspace apply`)).stdout);
    await run(setThreshold(RULE, 9));
    const staged = await run(`workspace discard ${RULE} > /dev/null && workspace revert ${applyId}`);
    expect(JSON.parse(staged.stdout)).toEqual(expect.objectContaining({ staged: [RULE], errors: [] }));
    expect((await run('workspace apply')).exitCode).toBe(0);
    expect(rules.store.get('high-5xx')!.spec.expressions.C.model.conditions[0].evaluator.params).toEqual([0]);
  });

  it('reverts from the rule version history when the receipt lost its diff', async () => {
    const { run, rules, workspace } = setup();
    const { applyId } = JSON.parse((await run(`${setThreshold(RULE, 5)} && workspace apply`)).stdout);
    delete workspace.applyJournal().find((receipt) => receipt.applyId === applyId)!.diff;
    expect(JSON.parse((await run(`workspace revert ${applyId}`)).stdout).staged).toEqual([RULE]);
    expect((await run('workspace apply')).exitCode).toBe(0);
    expect(rules.calls).toContain('version:high-5xx@1');
    expect(rules.store.get('high-5xx')!.spec.expressions.C.model.conditions[0].evaluator.params).toEqual([0]);
  });

  it('creates and deletes rules; reverting a creation deletes the rule', async () => {
    const { run, rules } = setup();
    const created = '/grafana/alert-rules/new-rule/rule.json';
    await run(
      `jq '.metadata.name = "new-rule" | .spec.title = "New rule"' /grafana/alert-rules/standalone/rule.json > /tmp/n && mkdir -p /grafana/alert-rules/new-rule && cp /tmp/n ${created}`
    );
    const apply = JSON.parse((await run('workspace apply')).stdout);
    expect(apply.results).toEqual([
      expect.objectContaining({ path: created, operation: 'create', outcome: 'applied' }),
    ]);
    expect(rules.store.get('new-rule')?.metadata.labels).toBeUndefined();

    expect(JSON.parse((await run(`workspace revert ${apply.applyId}`)).stdout).staged).toEqual([created]);
    expect((await run('workspace apply')).exitCode).toBe(0);
    expect(rules.store.has('new-rule')).toBe(false);

    await run('rm -r /grafana/alert-rules/standalone');
    const deletion = JSON.parse((await run('workspace apply')).stdout);
    expect(deletion.results).toEqual([expect.objectContaining({ operation: 'delete', outcome: 'applied' })]);
    expect(rules.store.has('standalone')).toBe(false);
  });

  it('restores staged rule changes with the session', async () => {
    const { run, workspace } = setup();
    await run(setThreshold(RULE, 5));
    const restored = SessionWorkspace.restore(JSON.parse(JSON.stringify(workspace.serialize())));
    expect(restored.status()).toEqual([expect.objectContaining({ path: RULE, resource: 'alertRule' })]);
    const entry = restored.getResource('high-5xx', 'alertRule')!;
    expect(JSON.parse(entry.overlay!.content!).spec.expressions.C.model.conditions[0].evaluator.params).toEqual([5]);
    expect(entry.base?.meta.group).toBe('checkout');
  });
});

describe('alert rule validation', () => {
  const base = toAlertRuleSnapshot(alertRuleResource('rule', { group: 'g' }));
  const document = () => JSON.parse(base.content);
  const validate = (value: unknown, options: Parameters<typeof validateAlertRuleDocument>[1] = {}) =>
    validateAlertRuleDocument(JSON.stringify(value), {
      expectedUid: 'rule',
      base,
      allowedDatasourceUids: ['prometheus'],
      notificationTargets: { receivers: ['oncall'], timeIntervals: ['weekends'], routingTrees: [] },
      ...options,
    });
  const messages = async (value: unknown, options?: Parameters<typeof validateAlertRuleDocument>[1]) =>
    (await validate(value, options)).errors.map((error) => `${error.level} ${error.path ?? ''}: ${error.message}`);

  it('accepts the fetched rule', async () => {
    const report = await validate(document());
    expect(report).toEqual(expect.objectContaining({ ok: true, errors: [] }));
    expect(report.levels).toEqual(
      expect.objectContaining({
        json: 'passed',
        envelope: 'passed',
        structure: 'passed',
        queries: 'passed',
        policy: 'passed',
      })
    );
  });

  it('checks the expression graph', async () => {
    const rule = document();
    delete rule.spec.expressions.C.source;
    rule.spec.expressions.B.model.expression = 'Z';
    rule.spec.expressions.A.relativeTimeRange = { from: '0s', to: '10m' };
    expect(await messages(rule)).toEqual([
      expect.stringContaining('exactly one expression must be the alert condition'),
      expect.stringMatching(/relativeTimeRange: queries need a relativeTimeRange/),
      expect.stringMatching(/expressions.B.model: refers to "Z"/),
    ]);
  });

  it('checks durations, states, and reserved labels', async () => {
    const rule = document();
    rule.spec.for = 'soon';
    rule.spec.noDataState = 'Maybe';
    rule.spec.labels.__grafana_receiver__ = 'x';
    expect(await messages(rule)).toEqual([
      expect.stringContaining('for must be a duration'),
      expect.stringContaining('noDataState must be one of'),
      expect.stringContaining('label is reserved'),
    ]);
  });

  it('checks PromQL syntax and the datasource allow-list', async () => {
    const rule = document();
    rule.spec.expressions.A.model.expr = 'sum(rate(http_requests_total[5m]';
    expect(await messages(rule)).toEqual([expect.stringMatching(/^queries .*PromQL/)]);
    rule.spec.expressions.A.model.expr = 'up';
    rule.spec.expressions.A.datasourceUID = 'loki';
    rule.spec.expressions.A.model.datasource = { type: 'loki', uid: 'loki' };
    const report = await validate(rule);
    expect(report.errors.map((error) => error.message)).toEqual([
      'datasource UID "loki" is not allowed for the assistant',
    ]);
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ message: 'not checked: no syntax parser for loki' })
    );
  });

  it('checks contact point and time interval references', async () => {
    const rule = document();
    rule.spec.notificationSettings = {
      type: 'SimplifiedRouting',
      receiver: 'nobody',
      muteTimeIntervals: ['weekends', 'holidays'],
    };
    expect(await messages(rule)).toEqual([
      expect.stringContaining('contact point "nobody" does not exist (known: oncall)'),
      expect.stringContaining('time interval "holidays" does not exist'),
    ]);
    rule.spec.notificationSettings.receiver = 'oncall';
    rule.spec.notificationSettings.muteTimeIntervals = ['weekends'];
    expect(await messages(rule)).toEqual([]);
  });

  it('parses Prometheus durations', () => {
    expect([
      parseDuration('2m0s'),
      parseDuration('1h30m'),
      parseDuration('0'),
      parseDuration('90'),
      parseDuration('5 m'),
    ]).toEqual([120, 5400, 0, undefined, undefined]);
  });
});
