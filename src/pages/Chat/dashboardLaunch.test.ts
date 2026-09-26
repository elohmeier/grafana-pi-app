import { FieldType, type DataFrame, type PluginExtensionPanelContext } from '@grafana/data';
import {
  captureDashboardAssistantContext,
  consumeDashboardAssistantLaunch,
  consumeDashboardAssistantStoredLaunch,
  dashboardAssistantPrompt,
  dashboardAssistantSessionTitle,
  renderDashboardAssistantContextBlock,
  storeDashboardAssistantLaunch,
  storeDashboardAssistantContext,
  type DashboardAssistantLaunch,
} from './dashboardLaunch';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('dashboard Assistant launch context', () => {
  it('stores a compact panel context and consumes it once', () => {
    const storage = new MemoryStorage();
    const context = panelContext();

    const contextId = storeDashboardAssistantContext(context, 'explain', storage);
    const launch = consumeDashboardAssistantLaunch(`?ctx=${encodeURIComponent(contextId)}&action=explain`, storage);

    expect(launch).toBeDefined();
    expect(launch?.action).toBe('explain');
    expect(launch?.context.dashboard).toEqual({
      uid: 'dash-uid',
      title: 'Service Overview',
      tags: ['service', 'prod'],
    });
    expect(launch?.context.panel).toEqual({
      id: 7,
      title: 'HTTP errors',
      pluginId: 'timeseries',
      panelPathId: 'prod$panel-7',
    });
    expect(launch?.context.targets[0]).toMatchObject({
      refId: 'A',
      datasourceUid: 'prom-main',
      datasourceType: 'prometheus',
      query: 'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))',
      legendFormat: '5xx',
    });
    expect(launch?.context.scopedVars?.service).toEqual({ text: 'api', value: 'api' });
    expect(launch?.context.data?.frames).toHaveLength(1);
    expect(launch?.context.data?.frames[0].fields).toHaveLength(2);

    expect(
      consumeDashboardAssistantLaunch(`?ctx=${encodeURIComponent(contextId)}&action=explain`, storage)
    ).toBeUndefined();
  });

  it('bounds large targets and data frames', () => {
    const hugeQuery = 'up'.repeat(3000);
    const frameCount = 12;
    const fieldCount = 16;
    const context = panelContext({
      targets: [
        {
          refId: 'A',
          expr: hugeQuery,
          datasource: { uid: 'prom-main', type: 'prometheus' },
          extraArray: Array.from({ length: 100 }, (_, index) => `value-${index}`),
        } as unknown as PluginExtensionPanelContext['targets'][number],
      ],
      data: {
        state: 'Done',
        series: Array.from({ length: frameCount }, (_, frameIndex) =>
          frame(
            `frame-${frameIndex}`,
            Array.from({ length: fieldCount }, (_, fieldIndex) => ({
              name: `field-${fieldIndex}`,
              type: FieldType.number,
              values: Array.from({ length: 20 }, (_, valueIndex) => valueIndex),
            }))
          )
        ),
      } as any,
    });

    const snapshot = captureDashboardAssistantContext(context);
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.targets[0].query?.length).toBeLessThanOrEqual(3000);
    expect((snapshot.targets[0].properties?.extraArray as unknown[]).length).toBe(20);
    expect(snapshot.data?.frames).toHaveLength(8);
    expect(snapshot.data?.omittedFrames).toBe(4);
    expect(snapshot.data?.frames[0].fields).toHaveLength(12);
    expect(snapshot.data?.frames[0].omittedFields).toBe(4);
    expect(snapshot.data?.frames[0].fields[0].sampleValues).toHaveLength(5);
    expect(serialized.length).toBeLessThan(30000);
  });

  it('expires stale stored context', () => {
    const storage = new MemoryStorage();
    const createdAt = 1000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(createdAt);
    const contextId = storeDashboardAssistantContext(panelContext(), 'troubleshoot', storage);
    nowSpy.mockRestore();

    expect(
      consumeDashboardAssistantLaunch(
        `?ctx=${encodeURIComponent(contextId)}&action=troubleshoot`,
        storage,
        createdAt + 3600001
      )
    ).toBeUndefined();
  });

  it('consumes stored context by id for sidebar launches', () => {
    const storage = new MemoryStorage();
    const contextId = storeDashboardAssistantContext(panelContext(), 'improve', storage);

    const launch = consumeDashboardAssistantStoredLaunch(contextId, storage);

    expect(launch?.action).toBe('improve');
    expect(launch?.context.panel.title).toBe('HTTP errors');
    expect(consumeDashboardAssistantStoredLaunch(contextId, storage)).toBeUndefined();
  });

  it('stores an existing launch for page handoff', () => {
    const storage = new MemoryStorage();
    const launch: DashboardAssistantLaunch = {
      action: 'explain',
      createdAt: 1,
      context: captureDashboardAssistantContext(panelContext()),
    };

    const contextId = storeDashboardAssistantLaunch(launch, storage, 2000);

    expect(consumeDashboardAssistantStoredLaunch(contextId, storage, 2000)?.context.panel.title).toBe('HTTP errors');
  });

  it('renders action prompt, title, and hidden context block', () => {
    const launch: DashboardAssistantLaunch = {
      action: 'troubleshoot',
      createdAt: 1,
      context: captureDashboardAssistantContext(panelContext()),
    };

    expect(dashboardAssistantPrompt(launch)).toContain('Troubleshoot panel "HTTP errors"');
    expect(dashboardAssistantSessionTitle(launch)).toBe('Troubleshoot: HTTP errors');

    const contextBlock = renderDashboardAssistantContextBlock(launch);
    expect(contextBlock).toContain('<dashboard_launch_context>');
    expect(contextBlock).toContain(
      'grafana-dashboard data /grafana/dashboards/<uid>/dashboard.json --panel <panel.id>'
    );
    expect(contextBlock).toContain('/live/dashboard/dashboard.json');
    expect(contextBlock).toContain('"uid": "dash-uid"');
    expect(contextBlock).toContain('Do not create, sync, upload, delete, or persist dashboards');
  });
});

function panelContext(overrides: Partial<PluginExtensionPanelContext> = {}): PluginExtensionPanelContext {
  return {
    pluginId: 'timeseries',
    id: 7,
    title: 'HTTP errors',
    timeRange: { from: 'now-6h', to: 'now' },
    timeZone: 'browser',
    dashboard: {
      uid: 'dash-uid',
      title: 'Service Overview',
      tags: ['service', 'prod'],
    },
    targets: [
      {
        refId: 'A',
        expr: 'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))',
        legendFormat: '5xx',
        datasource: { uid: 'prom-main', type: 'prometheus' },
      },
    ],
    scopedVars: {
      service: { text: 'api', value: 'api' },
    },
    data: {
      state: 'Done',
      series: [
        frame('errors', [
          {
            name: 'Time',
            type: FieldType.time,
            values: [1, 2, 3],
          },
          {
            name: '5xx',
            type: FieldType.number,
            labels: { service: 'api' },
            values: [0, 1, 2],
          },
        ]),
      ],
    } as any,
    panelPathId: 'prod$panel-7',
    ...overrides,
  } as PluginExtensionPanelContext;
}

function frame(name: string, fields: Array<Partial<DataFrame['fields'][number]>>): DataFrame {
  return {
    name,
    refId: 'A',
    length: 3,
    fields: fields.map((field) => ({
      config: {},
      name: field.name ?? 'value',
      type: field.type ?? 'number',
      values: field.values ?? [1, 2, 3],
      labels: field.labels,
    })),
  } as DataFrame;
}
