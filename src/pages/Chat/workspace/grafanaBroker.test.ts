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
