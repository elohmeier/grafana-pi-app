jest.mock('@grafana/runtime', () => ({
  config: { namespace: 'default' },
  getBackendSrv: jest.fn(),
  getDataSourceSrv: jest.fn(),
  isFetchError: () => false,
  locationService: { push: jest.fn() },
}));

import { getBackendSrv } from '@grafana/runtime';
import { of } from 'rxjs';
import { createGrafanaWorkspaceBroker } from './grafanaBroker';

const DASHBOARDS = '/apis/dashboard.grafana.app';

function mockGrafana(resources: Record<string, unknown>) {
  const fetch = jest.fn(({ url }: { url: string }) => of({ status: 200, data: resources[url] }));
  (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
  return fetch;
}

describe('dashboard broker', () => {
  it('reads unconverted dashboards in their stored version and records the conversion failure', async () => {
    const fetch = mockGrafana({
      [DASHBOARDS]: { versions: [{ version: 'v1' }, { version: 'v2' }] },
      [`${DASHBOARDS}/v1/namespaces/default/dashboards/tabs`]: {
        apiVersion: 'dashboard.grafana.app/v1',
        metadata: { name: 'tabs', resourceVersion: '7' },
        spec: {},
        status: { conversion: { failed: true, storedVersion: 'v2', error: 'tabs layout has no v1 equivalent' } },
      },
      [`${DASHBOARDS}/v2/namespaces/default/dashboards/tabs`]: {
        apiVersion: 'dashboard.grafana.app/v2',
        metadata: { name: 'tabs', resourceVersion: '7' },
        spec: { title: 'Tabs', layout: { kind: 'TabsLayout' } },
      },
    });

    const snapshot = await createGrafanaWorkspaceBroker({}).dashboards!.get('tabs');

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(snapshot?.meta).toMatchObject({
      apiVersion: 'dashboard.grafana.app/v2',
      title: 'Tabs',
      conversion: { preferredVersion: 'v1', error: 'tabs layout has no v1 equivalent' },
    });
    expect(JSON.parse(snapshot!.content).spec.layout.kind).toBe('TabsLayout');
  });

  it('leaves conversion unset for dashboards served in the preferred version', async () => {
    mockGrafana({
      [DASHBOARDS]: { versions: [{ version: 'v1' }] },
      [`${DASHBOARDS}/v1/namespaces/default/dashboards/plain`]: {
        apiVersion: 'dashboard.grafana.app/v1',
        metadata: { name: 'plain', resourceVersion: '3' },
        spec: { title: 'Plain' },
      },
    });

    const snapshot = await createGrafanaWorkspaceBroker({}).dashboards!.get('plain');

    expect(snapshot?.meta.apiVersion).toBe('dashboard.grafana.app/v1');
    expect(snapshot?.meta).not.toHaveProperty('conversion');
  });
});

const RULES = '/apis/rules.alerting.grafana.app/v0alpha1/namespaces/default/alertrules';

describe('alert rule broker', () => {
  const stored = {
    metadata: {
      name: 'high-5xx',
      resourceVersion: '4',
      labels: { 'grafana.app/folder': 'ops', 'grafana.com/group': 'checkout', 'grafana.com/group-index': '2' },
      annotations: { 'grafana.app/folder': 'ops', 'grafana.com/provenance': '' },
    },
    spec: { title: 'High 5xx', trigger: { interval: '1m' }, expressions: {} },
  };

  function mockRules() {
    const fetch = jest.fn(({ url, method, data }: { url: string; method: string; data?: any }) => {
      if (method === 'PUT') {
        return of({ status: 200, data: { ...data, metadata: { ...data.metadata, resourceVersion: '5' } } });
      }
      if (url.startsWith(`${RULES}?`)) {
        const page = url.includes('continue=next')
          ? { items: [{ ...stored, metadata: { ...stored.metadata, name: 'second' } }], metadata: {} }
          : { items: [stored], metadata: { continue: 'next' } };
        return of({ status: 200, data: page });
      }
      if (url.startsWith('/api/search')) {
        return of({ status: 200, data: [{ uid: 'ops', title: 'Operations' }] });
      }
      return of({ status: 200, data: stored });
    });
    (getBackendSrv as jest.Mock).mockReturnValue({ fetch });
    return fetch;
  }

  it('lists every page of rules with their groups and folder titles', async () => {
    mockRules();
    const { rules, folderTitles } = await createGrafanaWorkspaceBroker({}).alertRules!.list();
    expect(rules.map((rule) => rule.meta.uid)).toEqual(['high-5xx', 'second']);
    expect(rules[0].meta).toMatchObject({
      kind: 'alertRule',
      group: 'checkout',
      groupIndex: 2,
      preconditions: 'client',
    });
    expect(JSON.parse(rules[0].content).metadata).toEqual({
      name: 'high-5xx',
      annotations: { 'grafana.app/folder': 'ops' },
    });
    expect(folderTitles).toEqual({ ops: 'Operations' });
  });

  it('writes the working copy with the stored group labels and annotations', async () => {
    const fetch = mockRules();
    const document = {
      metadata: { name: 'high-5xx', annotations: { 'grafana.app/folder': 'ops' } },
      spec: { title: 'Changed' },
    };
    const result = await createGrafanaWorkspaceBroker({}).alertRules!.update(document, '4');
    expect(result).toMatchObject({
      outcome: 'applied',
      snapshot: { meta: { resourceVersion: '5', group: 'checkout' } },
    });
    const put = fetch.mock.calls.find(([options]) => options.method === 'PUT')![0];
    expect(put.data).toEqual({
      apiVersion: 'rules.alerting.grafana.app/v0alpha1',
      kind: 'AlertRule',
      metadata: {
        name: 'high-5xx',
        resourceVersion: '4',
        annotations: stored.metadata.annotations,
        labels: stored.metadata.labels,
      },
      spec: { title: 'Changed' },
    });
  });

  it('refuses to write over a rule that changed since it was fetched, because Grafana would accept it', async () => {
    const fetch = mockRules();
    const broker = createGrafanaWorkspaceBroker({}).alertRules!;
    const result = await broker.update({ metadata: { name: 'high-5xx' }, spec: {} }, '3');
    expect(result).toMatchObject({ outcome: 'conflicted', error: expect.stringContaining('revision 3, now 4') });
    expect((await broker.delete('high-5xx', '3')).outcome).toBe('conflicted');
    expect(fetch.mock.calls.some(([options]) => options.method === 'PUT' || options.method === 'DELETE')).toBe(false);
  });
});
