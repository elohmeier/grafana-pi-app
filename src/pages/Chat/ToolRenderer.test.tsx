import React from 'react';
import { render, screen } from '@testing-library/react';
import { structuredPatch } from 'diff';
import { highlightJsonnetLines } from './jsonnetRendering';
import { ContentBlocks, ToolActivityPanel, ToolResultMessageBody } from './ToolRenderer';

jest.mock('./jsonnetRendering', () => {
  const actual = jest.requireActual<typeof import('./jsonnetRendering')>('./jsonnetRendering');
  return { ...actual, highlightJsonnetLines: jest.fn(actual.highlightJsonnetLines) };
});

jest.mock('diff', () => {
  const actual = jest.requireActual<typeof import('diff')>('diff');
  return { ...actual, structuredPatch: jest.fn(actual.structuredPatch) };
});

const alertQuery = 'sum(rate(http_requests_total{status=~"5.."}[5m]))';

function alertRuleFixture(source = 'panelRef+annotations') {
  return {
    name: 'service-5xx-rate',
    title: 'Service 5xx rate',
    viewUrl: '/alerting/grafana/service-5xx-rate/view',
    apiPath: '/apis/rules.alerting.grafana.app/v0alpha1/namespaces/default/alertrules/service-5xx-rate',
    folderUid: 'service-folder',
    panelLink: { dashboardUID: 'service-dashboard', panelID: 2, source },
    for: '1m',
    noDataState: 'NoData',
    execErrState: 'Error',
    labels: { severity: 'warning' },
    annotations: { __dashboardUid__: 'service-dashboard', __panelId__: '2' },
    conditionRef: 'B',
    expressions: [
      {
        refId: 'A',
        datasourceUid: 'prom-b',
        queryType: 'range',
        expressionType: 'prometheus',
        expression: alertQuery,
        relativeTimeRange: { from: 300, to: 0 },
      },
      {
        refId: 'B',
        source: true,
        datasourceUid: '__expr__',
        expressionType: 'threshold',
        expression: 'A',
        reducer: 'last',
        evaluator: { type: 'gt', params: [0] },
      },
    ],
    alertCondition: {
      sourceRefId: 'B',
      reducer: 'last',
      evaluator: { type: 'gt', params: [0] },
    },
    prometheusChecks: [
      {
        refId: 'A',
        datasourceUid: 'prom-b',
        query: alertQuery,
        type: 'range',
        start: 'now-5m',
        end: 'now',
        relativeTimeRange: { from: 300, to: 0 },
      },
    ],
  };
}

function alertSearchResultFixture(source = 'panelRef+annotations') {
  return {
    namespace: 'default',
    query: {
      dashboardUid: 'service-dashboard',
      panelId: '2',
      panelTitle: '5xx rate panel',
    },
    dashboardPanel: {
      id: '2',
      title: '5xx rate panel',
      type: 'timeseries',
      datasourceUid: 'prom-b',
      datasourceType: 'prometheus',
      targets: [
        {
          refId: 'A',
          datasourceUid: 'prom-b',
          datasourceType: 'prometheus',
          query: alertQuery,
          legendFormat: '5xx',
        },
      ],
      thresholds: {
        mode: 'absolute',
        steps: [{ value: 0, color: 'green' }],
      },
    },
    ruleCount: 3,
    matchCount: 1,
    exactPanelMatchCount: 1,
    matches: [
      {
        score: 160,
        reasons: ['panel link exact match', `${source} panelID match`],
        rule: alertRuleFixture(source),
      },
    ],
    guidance: ['Compare alert prometheusChecks against the panel query.'],
  };
}

describe('ToolRenderer', () => {
  it('renders tool category icons in generic tool call headers', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'navigate',
            arguments: { type: 'dashboard', uid: 'service-red' },
          },
        ]}
      />
    );

    expect(screen.getByTestId('compass')).toBeInTheDocument();
    expect(screen.getByText('navigate')).toBeInTheDocument();
    expect(container.textContent).not.toContain('"uid"');
  });

  it('renders removed specialist and Grafana tool calls as plain JSON without summaries', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          { type: 'toolCall', name: 'run_query_agent', arguments: { task: 'Find CPU metrics.' } },
          { type: 'toolCall', name: 'list_metrics', arguments: { prefix: 'node_' } },
          { type: 'toolCall', name: 'query_prometheus', arguments: { query: 'up' } },
        ]}
      />
    );

    expect(container.textContent).toContain('"task": "Find CPU metrics."');
    expect(container.textContent).toContain('"prefix": "node_"');
    expect(container.textContent).toContain('"query": "up"');
    expect(container.textContent).not.toContain('Run query agent');
    expect(container.textContent).not.toContain('List metric names');
  });

  it('renders running tool activity with structured call summaries and streamed output', () => {
    const { container } = render(
      <ToolActivityPanel
        runs={[
          {
            id: 'run-1',
            name: 'bash',
            args: { command: 'grafana-prom query up' },
            status: 'running',
            partialResult: { content: [{ type: 'text', text: 'partial output' }], details: { type: 'subagent' } },
            updatedAt: 1,
          },
        ]}
      />
    );

    expect(container.textContent).toContain('Run bash');
    expect(container.textContent).toContain('grafana-prom query up');
    expect(container.textContent).toContain('partial output');
    expect(container.textContent).not.toContain('Specialist agent');
  });

  it('renders stored specialist results with the generic tool result view', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="run_query_agent"
        content={[{ type: 'text', text: 'Specialist answer' }]}
        details={{ type: 'subagent', agent: 'query', status: 'completed', task: 'Inspect.', toolCalls: [] }}
      />
    );

    expect(container.textContent).toContain('run_query_agent');
    expect(container.textContent).toContain('Specialist answer');
    expect(container.textContent).not.toContain('Query agent');
    expect(screen.queryByTestId('subagent-result')).not.toBeInTheDocument();
  });

  it('renders dashboard tool calls as summaries', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'screenshot_dashboard',
            arguments: {
              uid: 'service-health',
              width: 1200,
              height: 800,
            },
          },
          {
            type: 'toolCall',
            name: 'inspect_dashboard_metric_usage',
            arguments: {
              uid: 'service-health',
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('Capture dashboard screenshot | service-health');
    expect(container.textContent).toContain('Inspect dashboard metric usage | service-health');
    expect(container.textContent).toContain('1200 x 800');
    expect(container.textContent).not.toContain('"uid"');
  });

  it('renders live dashboard schema tool calls as summaries', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'get_live_dashboard_mutation_schema',
            arguments: {
              command: 'UPDATE_PANEL',
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('Get live dashboard mutation schema | UPDATE_PANEL');
    expect(container.textContent).not.toContain('"command"');
    expect(screen.getByTestId('book')).toBeInTheDocument();
  });

  it('renders live dashboard edit tool calls with audit fields', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'list_live_dashboard_panels',
            arguments: { elements: ['panel-2'], includeStatus: true },
          },
          { type: 'toolCall', name: 'get_live_dashboard_layout', arguments: {} },
          { type: 'toolCall', name: 'get_live_dashboard_info', arguments: {} },
          { type: 'toolCall', name: 'list_live_dashboard_variables', arguments: { parentPath: '/rows/0' } },
          {
            type: 'toolCall',
            name: 'rename_live_dashboard_panel',
            arguments: { elementName: 'panel-2', title: 'Requests', description: 'Updated panel copy' },
          },
          {
            type: 'toolCall',
            name: 'update_live_dashboard_panel_query',
            arguments: {
              elementName: 'panel-2',
              queryExpression: 'sum(rate(http_requests_total[$__rate_interval]))',
              datasourceType: 'prometheus',
              datasourceName: 'prom-prod',
              refId: 'B',
              hidden: true,
            },
          },
          {
            type: 'toolCall',
            name: 'add_live_dashboard_panel',
            arguments: {
              title: 'Errors',
              visualizationType: 'timeseries',
              unit: 'reqps',
              datasourceType: 'prometheus',
              datasourceName: 'prom-prod',
              x: 12,
              y: 8,
              width: 12,
              height: 8,
            },
          },
          {
            type: 'toolCall',
            name: 'move_or_resize_live_dashboard_panel',
            arguments: { elementName: 'panel-2', parentPath: '/', x: 0, y: 8, width: 12, height: 8 },
          },
          {
            type: 'toolCall',
            name: 'update_live_dashboard_settings',
            arguments: {
              title: 'Ops',
              tags: ['service', 'sre'],
              from: 'now-6h',
              to: 'now',
              autoRefresh: '30s',
              timezone: 'browser',
              cursorSync: 'Tooltip',
              editable: false,
              liveNow: true,
              preload: true,
            },
          },
          {
            type: 'toolCall',
            name: 'add_live_dashboard_variable',
            arguments: {
              name: 'env',
              variableType: 'query',
              queryExpression: 'label_values(up, job)',
              datasourceName: 'prom-prod',
              current: 'prod',
              multi: true,
              includeAll: true,
            },
          },
          {
            type: 'toolCall',
            name: 'update_live_dashboard_variable',
            arguments: { name: 'env', newName: 'service', options: ['api', 'worker'], position: 2 },
          },
          {
            type: 'toolCall',
            name: 'apply_live_dashboard_mutation',
            arguments: {
              type: 'REMOVE_PANEL',
              payload: { elements: [{ kind: 'ElementReference', name: 'panel-9' }] },
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('List live dashboard panels | panel-2');
    expect(container.textContent).toContain('Rename live dashboard panel | panel-2');
    expect(container.textContent).toContain('Updated panel copy');
    expect(container.textContent).toContain('Update live dashboard panel query | panel-2');
    expect(container.textContent).toContain('prometheus/prom-prod');
    expect(container.textContent).toContain('Ref ID');
    expect(container.textContent).toContain('B');
    expect(container.textContent).toContain('Add live dashboard panel | Errors');
    expect(container.textContent).toContain('timeseries');
    expect(container.textContent).toContain('reqps');
    expect(container.textContent).toContain('x 12, y 8, width 12, height 8');
    expect(container.textContent).toContain('Update live dashboard settings | Ops');
    expect(container.textContent).toContain('now-6h -> now');
    expect(container.textContent).toContain('30s');
    expect(container.textContent).toContain('Tooltip');
    expect(container.textContent).toContain('service, sre');
    expect(container.textContent).toContain('Add live dashboard variable | env');
    expect(container.textContent).toContain('label_values(up, job)');
    expect(container.textContent).toContain('Update live dashboard variable | env');
    expect(container.textContent).toContain('service');
    expect(container.textContent).toContain('Apply live dashboard mutation | REMOVE_PANEL');
    expect(container.textContent).toContain('panel-9');
  });

  it('renders object-shaped failed tool results as readable errors', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="get_alert_rule"
        content={{ error: { message: 'Alert rule lookup failed' } }}
        details={{ error: { message: 'Alert rule lookup failed' }, name: 'service-5xx-rate' }}
        isError
      />
    );

    expect(screen.getByTestId('tool-error')).toBeInTheDocument();
    expect(container.textContent).toContain('get_alert_rule failed');
    expect(container.textContent).toContain('Alert rule lookup failed');
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('renders alert tool calls as troubleshooting summaries', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'find_panel_alert_rules',
            arguments: {
              dashboardUid: 'service-dashboard',
              panelId: 2,
              panelTitle: '5xx rate panel',
            },
          },
          {
            type: 'toolCall',
            name: 'get_alert_rule',
            arguments: {
              name: 'service-5xx-rate',
              namespace: 'default',
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('Find panel alert rules | dashboard service-dashboard | panel 2');
    expect(container.textContent).toContain('Get alert rule | service-5xx-rate | namespace default');
    expect(container.textContent).not.toContain('"dashboardUid"');
    expect(screen.getAllByTestId('bell').length).toBeGreaterThan(0);
  });

  it('renders panel alert rule matches with link health', () => {
    const content = [{ type: 'text', text: JSON.stringify(alertSearchResultFixture()) }];

    const { container } = render(
      <ToolResultMessageBody
        toolName="find_panel_alert_rules"
        content={content}
        details={{
          namespace: 'default',
          dashboardUid: 'service-dashboard',
          panelId: '2',
          ruleCount: 3,
          matchCount: 1,
          exactPanelMatchCount: 1,
          summarized: true,
        }}
      />
    );

    expect(container.textContent).toContain('1 matched alert rule | 1 exact panel link | 3 scanned');
    expect(container.textContent).toContain('5xx rate panel');
    expect(container.textContent).toContain('Service 5xx rate');
    expect(container.textContent).toContain('properly linked');
    expect(container.textContent).toContain('panel indicator should appear');
    expect(container.textContent).toContain(alertQuery);
    expect(container.textContent).not.toContain('"matches"');
    expect(container.textContent).not.toContain('Compare alert prometheusChecks against the panel query.');
    expect(container.querySelector('table')).not.toBeInTheDocument();
  });

  it('warns when an alert match only has panelRef linkage', () => {
    const content = [{ type: 'text', text: JSON.stringify(alertSearchResultFixture('panelRef')) }];

    const { container } = render(
      <ToolResultMessageBody
        toolName="find_panel_alert_rules"
        content={content}
        details={{
          namespace: 'default',
          ruleCount: 3,
          matchCount: 1,
          exactPanelMatchCount: 1,
          summarized: true,
        }}
      />
    );

    expect(container.textContent).toContain('panelRef only');
    expect(container.textContent).toContain('panel indicator annotations missing');
  });

  it('renders alert rule expression chains and Prometheus checks', () => {
    const content = [
      {
        type: 'text',
        text: JSON.stringify({
          namespace: 'default',
          rule: alertRuleFixture('panelRef'),
          rawStatus: { state: 'firing' },
          guidance: ['Run prometheusChecks with `grafana-prom query` for current evidence.'],
        }),
      },
    ];

    const { container } = render(
      <ToolResultMessageBody
        toolName="get_alert_rule"
        content={content}
        details={{ namespace: 'default', name: 'service-5xx-rate', prometheusChecks: 1, summarized: true }}
      />
    );

    expect(container.textContent).toContain('Alert rule | Service 5xx rate | service-5xx-rate');
    expect(container.textContent).toContain('B last gt 0');
    expect(container.textContent).toContain('Expression chain');
    expect(container.textContent).toContain('Prometheus checks');
    expect(container.textContent).toContain('panel indicator annotations missing');
    expect(container.textContent).toContain(alertQuery);
    expect(container.textContent).not.toContain('"rawStatus"');
  });

  it('renders artifactized tool results as artifact cards', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="query_prometheus"
        content={[{ type: 'text', text: 'Stored artifact [artifact: artifact_1]' }]}
        details={{
          artifactRef: {
            id: 'artifact_1',
            kind: 'json',
            title: 'query_prometheus',
            toolName: 'query_prometheus',
            createdAt: '2026-06-05T00:00:00.000Z',
            bytes: 8192,
            summary: 'Prometheus batch result.',
          },
          artifactPreview: {
            type: 'json',
            data: { results: [{ query: 'up' }] },
            truncated: true,
          },
        }}
      />
    );

    expect(screen.getByTestId('artifact-result')).toBeInTheDocument();
    expect(container.textContent).toContain('artifact_1');
    expect(container.textContent).toContain('Prometheus batch result.');
    expect(container.textContent).toContain('8.0 KiB');
    expect(container.textContent).not.toContain('Stored artifact [artifact: artifact_1]');
  });

  it('renders live dashboard JSON artifacts without dumping raw preview data', () => {
    const rawMarker = `RAW_LIVE_DASHBOARD_JSON_${'x'.repeat(2048)}`;
    const { container } = render(
      <ToolResultMessageBody
        toolName="list_live_dashboard_panels"
        content={[
          {
            type: 'text',
            text: `Stored artifact [artifact: artifact_1]\n${rawMarker}`,
          },
        ]}
        details={{
          artifactRef: {
            id: 'artifact_1',
            kind: 'dashboard',
            title: 'list_live_dashboard_panels',
            toolName: 'list_live_dashboard_panels',
            createdAt: '2026-06-05T00:00:00.000Z',
            bytes: 256000,
            summary: '24 live dashboard panels summarized.',
          },
          artifactPreview: {
            type: 'json',
            data: {
              command: 'LIST_PANELS',
              summary: {
                panelCount: 24,
                panels: [{ elementName: 'panel-1', title: 'Request rate' }],
              },
              data: {
                elements: [
                  {
                    element: {
                      kind: 'Panel',
                      spec: {
                        title: 'Request rate',
                        fieldConfig: { defaults: { custom: { rawMarker } } },
                      },
                    },
                  },
                ],
              },
            },
            truncated: true,
          },
        }}
      />
    );

    expect(screen.getByTestId('artifact-result')).toBeInTheDocument();
    expect(container.textContent).toContain('artifact_1');
    expect(container.textContent).toContain('24 live dashboard panels summarized.');
    expect(container.textContent).toContain('250.0 KiB');
    expect(container.textContent).toContain('read_artifact {"id":"artifact_1"}');
    expect(container.textContent).not.toContain('Stored artifact [artifact: artifact_1]');
    expect(container.textContent).not.toContain(rawMarker);
    expect(container.textContent).not.toContain('"elements"');
  });

  it('renders read_artifact output instead of hiding it behind an artifact card', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="read_artifact"
        content={[{ type: 'text', text: 'selected artifact value' }]}
        details={{
          artifactRead: true,
          mode: 'field',
          path: 'results.0.query',
          artifactRef: {
            id: 'artifact_1',
            kind: 'json',
            title: 'query_prometheus',
            toolName: 'query_prometheus',
            createdAt: '2026-06-05T00:00:00.000Z',
            bytes: 8192,
            summary: 'Prometheus batch result.',
          },
        }}
      />
    );

    expect(screen.queryByTestId('artifact-result')).not.toBeInTheDocument();
    expect(container.textContent).toContain('Artifact read | field | query_prometheus');
    expect(container.textContent).toContain('selected artifact value');
    expect(container.textContent).not.toContain('read_artifact {"id":"artifact_1"}');
  });

  it('renders jq null artifact reads without raw null fallback details', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="read_artifact"
        content={[{ type: 'text', text: 'null' }]}
        details={{
          artifactRead: true,
          mode: 'jq',
          jq: '.elements[0].element.vizConfig.spec.fieldConfig.defaults.thresholds',
          exitCode: 0,
          truncated: false,
          artifactRef: {
            id: 'artifact_1',
            kind: 'dashboard',
            title: 'list_live_dashboard_panels',
            toolName: 'list_live_dashboard_panels',
            createdAt: '2026-07-01T08:44:20.964Z',
            bytes: 5573,
            summary: 'list_live_dashboard_panels returned 1 panel.',
          },
        }}
      />
    );

    expect(container.textContent).toContain('Artifact read | jq | list_live_dashboard_panels');
    expect(container.textContent).toContain('jq result is null.');
    expect(container.textContent).toContain('.elements[0].element.vizConfig.spec.fieldConfig.defaults.thresholds');
    expect(container.textContent).not.toContain('"artifactRead"');
    expect(container.textContent).not.toContain('Details');
  });

  it('renders undefined artifact fields as an empty state', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="read_artifact"
        content={[{ type: 'text', text: 'undefined' }]}
        details={{
          artifactRead: true,
          mode: 'field',
          path: 'data.elements.0.element.vizConfig.spec.fieldConfig.defaults',
          artifactRef: {
            id: 'artifact_1',
            kind: 'dashboard',
            title: 'list_live_dashboard_panels',
            toolName: 'list_live_dashboard_panels',
            createdAt: '2026-07-01T08:44:20.964Z',
            bytes: 5573,
            summary: 'list_live_dashboard_panels returned 1 panel.',
          },
        }}
      />
    );

    expect(container.textContent).toContain('Artifact read | field | list_live_dashboard_panels');
    expect(container.textContent).toContain('Selected artifact field is undefined.');
    expect(container.textContent).toContain('data.elements.0.element.vizConfig.spec.fieldConfig.defaults');
    expect(container.textContent).not.toContain('Details');
  });

  it('collapses full JSON artifact reads behind a dashboard summary', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="read_artifact"
        content={[
          {
            type: 'text',
            text: JSON.stringify({
              command: 'LIST_PANELS',
              success: true,
              data: {
                elements: [
                  {
                    element: {
                      kind: 'Panel',
                      spec: {
                        title: '5xx rate panel',
                        data: { kind: 'QueryGroup', spec: { queries: [{ kind: 'PanelQuery' }] } },
                        vizConfig: { kind: 'VizConfig', group: 'timeseries' },
                      },
                    },
                    layoutItem: { kind: 'GridLayoutItem', spec: { x: 0, y: 0, width: 24, height: 8 } },
                  },
                ],
              },
              availableCommands: ['LIST_PANELS'],
            }),
          },
        ]}
        details={{
          artifactRead: true,
          mode: 'full',
          truncated: false,
          artifactRef: {
            id: 'artifact_1',
            kind: 'dashboard',
            title: 'list_live_dashboard_panels',
            toolName: 'list_live_dashboard_panels',
            createdAt: '2026-07-01T08:44:20.964Z',
            bytes: 5573,
            summary: 'list_live_dashboard_panels returned 1 panel.',
          },
        }}
      />
    );

    const details = screen.getByText('Full artifact JSON').closest('details') as HTMLDetailsElement | null;

    expect(container.textContent).toContain('Artifact read | full | list_live_dashboard_panels');
    expect(container.textContent).toContain('LIST_PANELS');
    expect(container.textContent).toContain('5xx rate panel');
    expect(container.textContent).toContain('24x8 at 0,0');
    expect(details?.open).toBe(false);
  });

  it('renders live dashboard mutation schema results', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="get_live_dashboard_mutation_schema"
        content={[
          {
            type: 'text',
            text: JSON.stringify({
              command: 'UPDATE_PANEL',
              available: true,
              readOnly: false,
              guidance: {
                workflow: ['Use list_live_dashboard_panels first.'],
              },
              availableCommands: ['LIST_PANELS', 'UPDATE_PANEL'],
            }),
          },
        ]}
        details={{
          command: 'UPDATE_PANEL',
          availableCommands: ['LIST_PANELS', 'UPDATE_PANEL'],
          guidanceOnly: true,
        }}
      />
    );

    expect(container.textContent).toContain('Live dashboard mutation schema | UPDATE_PANEL');
    expect(container.textContent).toContain('LIST_PANELS');
    expect(container.textContent).toContain('UPDATE_PANEL');
    expect(container.textContent).toContain('Guidance');
    expect(container.textContent).not.toContain('Details');
  });

  it('renders live dashboard mutation results as structured changes', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="rename_live_dashboard_panel"
        content={[
          {
            type: 'text',
            text: 'Live dashboard mutation UPDATE_PANEL succeeded.\nChanges: 1\n{"previousValue":"Old title"}',
          },
        ]}
        details={{
          command: 'UPDATE_PANEL',
          success: true,
          payload: {
            element: { kind: 'ElementReference', name: 'panel-1' },
            panel: { kind: 'Panel', spec: { title: 'New title' } },
          },
          changes: [{ path: '/elements/panel-1/spec/title', previousValue: 'Old title', newValue: 'New title' }],
          warnings: ['Panel data will refresh after save.'],
          data: { ok: true },
          visualVerification: { status: 'skipped', error: 'Renderer unavailable' },
          availableCommands: ['LIST_PANELS', 'UPDATE_PANEL'],
        }}
      />
    );

    expect(container.textContent).toContain('Live dashboard mutation succeeded');
    expect(container.textContent).toContain('UPDATE_PANEL');
    expect(container.textContent).toContain('panel-1');
    expect(container.textContent).toContain('Panel title');
    expect(container.textContent).toContain('/elements/panel-1/spec/title');
    expect(container.textContent).toContain('Old title');
    expect(container.textContent).toContain('New title');
    expect(container.textContent).toContain('Verification issue');
    expect(container.textContent).toContain('Renderer unavailable');
    expect(container.textContent).toContain('Panel data will refresh after save.');
    expect(container.textContent).not.toContain('"previousValue"');
    const changes = [...container.querySelectorAll('details')].find((details) =>
      details.querySelector('summary')?.textContent?.includes('Changes')
    );
    expect(changes).toBeInTheDocument();
    expect(changes).not.toHaveAttribute('open');
  });

  it('renders read-only live dashboard results as commands', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="list_live_dashboard_panels"
        content={[{ type: 'text', text: 'Live dashboard mutation LIST_PANELS succeeded.' }]}
        details={{
          command: 'LIST_PANELS',
          success: true,
          changes: [],
          data: {
            elements: [
              { element: { kind: 'Panel', spec: { title: 'Requests' } } },
              { element: { kind: 'Panel', spec: { title: 'Errors' } } },
            ],
          },
          availableCommands: ['LIST_PANELS', 'UPDATE_PANEL'],
        }}
      />
    );

    expect(container.textContent).toContain('Live dashboard command succeeded');
    expect(container.textContent).toContain('LIST_PANELS');
    expect(container.textContent).toContain('Panels');
    expect(container.textContent).toContain('2');
    expect(container.textContent).not.toContain('Live dashboard mutation succeeded');
  });

  it('renders session filesystem tool calls as compact summaries', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          {
            type: 'toolCall',
            name: 'bash',
            arguments: {
              command: 'grafana-dashboard validate /grafana/dashboards/abc/dashboard.json',
              timeoutMs: 5000,
            },
          },
          {
            type: 'toolCall',
            name: 'read',
            arguments: { path: '/workspace/notes.txt', offset: 3, limit: 20 },
          },
          {
            type: 'toolCall',
            name: 'write',
            arguments: { path: '/workspace/notes.txt', content: 'hello\n', revision: 'd2a784f1bfa4' },
          },
          {
            type: 'toolCall',
            name: 'edit',
            arguments: {
              path: '/workspace/notes.txt',
              edits: [
                { oldText: 'a', newText: 'b' },
                { oldText: 'c', newText: 'd', replaceAll: true },
              ],
            },
          },
        ]}
      />
    );

    const summaries = Array.from(container.querySelectorAll('details > summary')).map((summary) => summary.textContent);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Run bash'),
        expect.stringContaining('Read file'),
        expect.stringContaining('Write file | 6 B'),
        expect.stringContaining('Edit file | 2 edits'),
      ])
    );
    expect(summaries.some((summary) => summary?.includes('/workspace/notes.txt'))).toBe(false);
    expect(summaries.some((summary) => summary?.includes('grafana-dashboard'))).toBe(false);
    expect(Array.from(container.querySelectorAll('details')).every((details) => !details.hasAttribute('open'))).toBe(
      true
    );
    expect(container.textContent).toContain('/workspace/notes.txt');
    expect(container.textContent).toContain('grafana-dashboard validate /grafana/dashboards/abc/dashboard.json');
    expect(container.textContent).toContain('5.0 s');
    expect(container.textContent).toContain('20 lines');
    expect(container.textContent).toContain('d2a784f1bfa4');
    expect(container.textContent).toContain('Replace all');
    expect(container.textContent).not.toContain('"command"');
    expect(container.textContent).not.toContain('"path"');
  });

  it('renders read results as numbered lines with range and revision', () => {
    (highlightJsonnetLines as jest.Mock).mockClear();
    const { container } = render(
      <ToolResultMessageBody
        toolName="read"
        content={[
          {
            type: 'text',
            text:
              '/workspace/a.txt (revision d2a784f1bfa4, 10 lines, 70 bytes)\n' +
              ' 3\tthird line\n' +
              ' 4\t  indented fourth\n' +
              '[showing lines 3-4 of 10; continue with offset=5]',
          },
        ]}
        details={{
          path: '/workspace/a.txt',
          type: 'file',
          revision: 'd2a784f1bfa4',
          totalLines: 10,
          startLine: 3,
          endLine: 4,
          truncated: true,
        }}
      />
    );

    const summary = Array.from(container.querySelectorAll('details > summary')).find((element) =>
      element.textContent?.includes('/workspace/a.txt | lines 3-4 of 10 | rev d2a784f1bfa4')
    );
    expect(summary).toBeTruthy();
    expect((summary?.parentElement as HTMLDetailsElement | undefined)?.open).toBe(false);
    expect(summary?.textContent).not.toContain('third line');
    const lineNumbers = Array.from(container.querySelectorAll('pre > div')).map(
      (line) => line.firstElementChild?.textContent
    );
    expect(lineNumbers).toEqual(['3', '4']);
    expect(container.textContent).toContain('third line');
    expect(container.textContent).toContain('  indented fourth');
    expect(container.textContent).toContain('continue with offset=5');
    expect(container.textContent).not.toContain('70 bytes');
    expect(highlightJsonnetLines).not.toHaveBeenCalled();
  });

  it('renders read results for directories as a listing', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="read"
        content={[{ type: 'text', text: '/grafana/dashboards/\nabc/\nxyz/\nREADME.md' }]}
        details={{ path: '/grafana/dashboards', type: 'directory', entries: 3 }}
      />
    );

    expect(container.querySelector('details > summary')?.textContent).toContain('/grafana/dashboards/ | 3 entries');
    expect(Array.from(container.querySelectorAll('pre')).length).toBe(0);
    expect(container.textContent).toContain('abc/');
    expect(container.textContent).toContain('xyz/');
    expect(container.textContent).toContain('README.md');
  });

  it('renders write and edit results with diffs and marks dashboard copies as staged', () => {
    const diff = '@@ -1,3 +1,3 @@\n' + ' {\n' + '-  "title": "Old"\n' + '+  "title": "New"\n' + ' }\n';

    const { container } = render(
      <>
        <ToolResultMessageBody
          toolName="edit"
          content={[{ type: 'text', text: `Edited /workspace/a.json (revision 1a2b3c4d5e6f)\n${diff}` }]}
          details={{ path: '/workspace/a.json', revision: '1a2b3c4d5e6f', edits: 1, diff }}
        />
        <ToolResultMessageBody
          toolName="write"
          content={[
            {
              type: 'text',
              text:
                'Updated /grafana/dashboards/abc/dashboard.json (120 bytes, revision 9f8e7d6c5b4a)\n' +
                'Staged locally only. Validate with `grafana-dashboard validate`, then `workspace plan` and `workspace apply <plan-id>` to request approval.',
            },
          ]}
          details={{
            path: '/grafana/dashboards/abc/dashboard.json',
            change: 'modified',
            bytes: 120,
            revision: '9f8e7d6c5b4a',
            diff,
          }}
        />
      </>
    );

    const diffSummaries = Array.from(container.querySelectorAll('details > summary')).filter((summary) =>
      summary.textContent?.includes('Diff | 1 hunk | +1 / -1')
    );
    expect(diffSummaries).toHaveLength(2);
    expect(diffSummaries.every((summary) => (summary.parentElement as HTMLDetailsElement | null)?.open)).toBe(true);
    expect(container.textContent).toContain('-  "title": "Old"');
    expect(container.textContent).toContain('+  "title": "New"');
    expect(container.textContent).not.toContain('Edited /workspace/a.json');
    expect(container.textContent).toContain('staged');
    expect(container.textContent).toContain('Grafana is unchanged');
    expect(container.textContent?.match(/Grafana is unchanged/g)).toHaveLength(1);
  });

  it('renders write results without a diff as the summary line', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="write"
        content={[{ type: 'text', text: 'Created /workspace/new.txt (6 bytes, revision abcdef012345)' }]}
        details={{ path: '/workspace/new.txt', change: 'created', bytes: 6, revision: 'abcdef012345' }}
      />
    );

    expect(container.textContent).toContain('Created /workspace/new.txt (6 bytes, revision abcdef012345)');
    expect(container.textContent).not.toContain('Diff');
    expect(container.textContent).not.toContain('staged');
  });

  it('renders bash results with command output and changed files', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="bash"
        content={[{ type: 'text', text: '{ "ok": true }\n[exit 0]' }]}
        details={{
          command: 'jq . /workspace/a.json > /grafana/dashboards/abc/dashboard.json',
          cwd: '/workspace',
          exitCode: 0,
          stdout: '{ "ok": true }\n',
          stderr: 'note: reformatted\n',
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          changes: [
            {
              path: '/grafana/dashboards/abc/dashboard.json',
              change: 'modified',
              bytes: 2048,
              revision: 'aa11bb22cc33',
            },
            { path: '/workspace/out.txt', change: 'created', bytes: 12, revision: 'dd44ee55ff66' },
          ],
          durationMs: 42,
        }}
      />
    );

    expect(container.textContent).toContain('completed');
    expect(container.textContent).toContain('Exit code');
    expect(container.textContent).toContain('42 ms');
    expect(container.textContent).toContain('jq . /workspace/a.json > /grafana/dashboards/abc/dashboard.json');
    expect(container.textContent).toContain('{ "ok": true }');
    const outputs = Array.from(container.querySelectorAll('details')).filter((details) =>
      ['stdout', 'stderr'].includes(details.querySelector('summary')?.textContent ?? '')
    ) as HTMLDetailsElement[];
    expect(outputs.map((details) => [details.querySelector('summary')?.textContent, details.open])).toEqual([
      ['stdout', true],
      ['stderr', false],
    ]);
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
    );
    expect(rows).toEqual([
      ['/grafana/dashboards/abc/dashboard.json', 'modified staged', '2.0 KiB', 'aa11bb22cc33'],
      ['/workspace/out.txt', 'created', '12 B', 'dd44ee55ff66'],
    ]);
    expect(container.textContent).not.toContain('discarded');
    expect(container.textContent).not.toContain('"stdout"');
    expect(container.textContent).not.toContain('"changes"');
  });

  it('renders timed-out bash results with discarded changes and open stderr', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="bash"
        content={[{ type: 'text', text: '[stderr]\ncommand timed out\n[exit 124]' }]}
        details={{
          command: 'sleep 999',
          cwd: '/workspace',
          exitCode: 124,
          stdout: '',
          stderr: 'command timed out\n',
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: true,
          changes: [],
          discardedChanges: 'timed out after 30000ms',
          durationMs: 30012,
        }}
      />
    );

    expect(container.textContent).toContain('timed out');
    expect(container.textContent).toContain('30.0 s');
    expect(container.textContent).toContain('discarded');
    expect(container.textContent).toContain('timed out after 30000ms');
    const stderr = Array.from(container.querySelectorAll('details')).find(
      (details) => details.querySelector('summary')?.textContent === 'stderr'
    );
    expect(stderr?.open).toBe(true);
    expect(container.querySelectorAll('details > summary')).toHaveLength(1);
    expect(container.querySelector('table')).toBeNull();
  });

  it('opens stderr for failed bash results', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="bash"
        content={[{ type: 'text', text: '[stderr]\nboom\n[exit 2]' }]}
        details={{
          command: 'false',
          cwd: '/workspace',
          exitCode: 2,
          stdout: '',
          stderr: 'boom\n',
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          changes: [],
          durationMs: 3,
        }}
      />
    );

    expect(container.textContent).toContain('failed');
    expect(container.querySelector('details')?.open).toBe(true);
    expect(container.textContent).not.toContain('discarded');
  });
});

describe('ToolRenderer hardening', () => {
  it('renders non-string thinking blocks without crashing', () => {
    const { container } = render(<ContentBlocks content={[{ type: 'thinking', thinking: { nested: true } }]} />);

    expect(container.textContent).toContain('"nested"');
  });

  it('renders non-string tool call names without crashing', () => {
    const { container } = render(
      <ContentBlocks content={[{ type: 'toolCall', name: { bad: true }, arguments: { a: 1 } }]} />
    );

    expect(container.textContent).toContain('"bad"');
  });

  it('counts removed lines starting with dashes as content, not metadata', () => {
    const diff =
      '--- dashboard.jsonnet\n' +
      '+++ dashboard.jsonnet\n' +
      '@@ -1,2 +1,2 @@\n' +
      '---foo\n' +
      '+++bar\n' +
      ' context\n';

    const { container } = render(
      <ToolResultMessageBody
        toolName="edit"
        content={[{ type: 'text', text: 'Edited /workspace/dashboard.jsonnet' }]}
        details={{ path: '/workspace/dashboard.jsonnet', diff }}
      />
    );

    expect(container.textContent).toContain('Diff | 1 hunk | +1 / -1');
  });

  it('does not fabricate hunk positions when the diff header is unparseable', () => {
    const diff =
      '@@ sample diff @@\n' +
      '-{\n' +
      '-  "a": 1,\n' +
      '-  "b": 2,\n' +
      '-  "c": 3\n' +
      '-}\n' +
      '+{\n' +
      '+  "a": 1,\n' +
      '+  "b": 2,\n' +
      '+  "c": 4\n' +
      '+}\n';

    const { container } = render(
      <ToolResultMessageBody
        toolName="edit"
        content={[{ type: 'text', text: 'Edited /workspace/dashboard.jsonnet' }]}
        details={{ path: '/workspace/dashboard.jsonnet', diff }}
      />
    );

    expect(container.textContent).toContain('@@ sample diff @@');
    expect(container.textContent).not.toMatch(/@@ -\d/);
  });

  it('renders alert rule matches with duplicate rule names without duplicate keys', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <ToolResultMessageBody
          toolName="find_panel_alert_rules"
          content={[
            {
              type: 'text',
              text: JSON.stringify({
                ruleCount: 2,
                matchCount: 2,
                exactPanelMatchCount: 0,
                matches: [
                  { score: 1, reasons: [], rule: { name: 'unknown', title: 'Rule A' } },
                  { score: 1, reasons: [], rule: { name: 'unknown', title: 'Rule B' } },
                ],
              }),
            },
          ]}
          details={{ ruleCount: 2, matchCount: 2 }}
        />
      );

      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('falls back to the default error message instead of dumping JSON', () => {
    render(
      <ToolResultMessageBody
        toolName="query_prometheus"
        content={undefined}
        details={{ someField: { nested: true } }}
        isError
      />
    );

    const error = screen.getByTestId('tool-error');
    expect(error.textContent).toContain('Tool failed without a readable error message.');
  });

  it('ignores non-string error primitives like false', () => {
    render(
      <ToolResultMessageBody toolName="query_prometheus" content={undefined} details={{ error: false }} isError />
    );

    const error = screen.getByTestId('tool-error');
    expect(error.textContent).toContain('Tool failed without a readable error message.');
    // The raw details JSON stays inspectable in the Details section, but the
    // headline error message must not be the stringified primitive.
    expect(screen.queryByText('false')).not.toBeInTheDocument();
  });

  it('skips non-primitive label values instead of stringifying them', () => {
    const rule = { ...alertRuleFixture(), labels: { severity: 'warning', bad: { nested: true } } };
    const { container } = render(
      <ToolResultMessageBody
        toolName="get_alert_rule"
        content={[{ type: 'text', text: JSON.stringify({ namespace: 'default', rule }) }]}
        details={{ namespace: 'default', name: 'service-5xx-rate' }}
      />
    );

    expect(container.textContent).toContain('severity');
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('does not render alert rule links with unsafe schemes', () => {
    const result = alertSearchResultFixture();
    result.matches[0].rule.viewUrl = 'javascript:alert(1)';
    render(
      <ToolResultMessageBody
        toolName="find_panel_alert_rules"
        content={[{ type: 'text', text: JSON.stringify(result) }]}
        details={{ namespace: 'default', matchCount: 1 }}
      />
    );

    expect(screen.queryByRole('link', { name: 'Open rule' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Open rule').length).toBeGreaterThan(0);
  });

  it('strips remote images and iframes from rendered markdown', () => {
    const { container } = render(
      <ContentBlocks
        content={'![exfil](https://evil.example/x.png)\n\n<iframe src="https://evil.example"></iframe>\n\nplain text'}
      />
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('plain text');
  });

  it('memoizes jsonnet highlighting across re-renders of the same content', () => {
    const highlightMock = highlightJsonnetLines as jest.Mock;
    highlightMock.mockClear();
    const block = () => (
      <ToolResultMessageBody
        toolName="read"
        content={[
          {
            type: 'text',
            text: '/workspace/dashboard.jsonnet (revision abc, 2 lines, 29 bytes)\n1\tlocal a = 1;\n2\t{ panels: [] }',
          },
        ]}
        details={{ path: '/workspace/dashboard.jsonnet', type: 'file', totalLines: 2, startLine: 1, endLine: 2 }}
      />
    );

    const { rerender } = render(block());
    const callsAfterFirstRender = highlightMock.mock.calls.length;
    expect(callsAfterFirstRender).toBeGreaterThan(0);

    rerender(block());

    expect(highlightMock.mock.calls.length).toBe(callsAfterFirstRender);
  });

  it('memoizes diff optimization across re-renders of the same diff', () => {
    const patchMock = structuredPatch as jest.Mock;
    patchMock.mockClear();
    const diff =
      '@@ -1,5 +1,5 @@\n' +
      '-{\n' +
      '-  "a": 1,\n' +
      '-  "b": 2,\n' +
      '-  "c": 3\n' +
      '-}\n' +
      '+{\n' +
      '+  "a": 1,\n' +
      '+  "b": 2,\n' +
      '+  "c": 4\n' +
      '+}\n';
    const block = () => (
      <ToolResultMessageBody
        toolName="edit"
        content={[{ type: 'text', text: 'Edited /workspace/dashboard.jsonnet' }]}
        details={{ path: '/workspace/dashboard.jsonnet', diff }}
      />
    );

    const { rerender } = render(block());
    const callsAfterFirstRender = patchMock.mock.calls.length;
    expect(callsAfterFirstRender).toBeGreaterThan(0);

    rerender(block());

    expect(patchMock.mock.calls.length).toBe(callsAfterFirstRender);
  });
});
