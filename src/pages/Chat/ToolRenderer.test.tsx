import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { structuredPatch } from 'diff';
import { highlightJsonnetLines } from './jsonnetRendering';
import {
  ContentBlocks,
  ToolResultMessageBody,
  ToolTranscriptContext,
  UserShellEntry,
  type ToolTranscript,
} from './ToolRenderer';

jest.mock('./jsonnetRendering', () => {
  const actual = jest.requireActual<typeof import('./jsonnetRendering')>('./jsonnetRendering');
  return { ...actual, highlightJsonnetLines: jest.fn(actual.highlightJsonnetLines) };
});

jest.mock('diff', () => {
  const actual = jest.requireActual<typeof import('diff')>('diff');
  return { ...actual, structuredPatch: jest.fn(actual.structuredPatch) };
});

function bashDetails(overrides: Record<string, unknown>) {
  return {
    command: '',
    cwd: '/workspace',
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    changes: [],
    durationMs: 0,
    ...overrides,
  };
}

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

  it('renders tool calls with their transcript results and run state in one terminal', () => {
    const transcript: ToolTranscript = {
      results: new Map([
        [
          'call-1',
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'bash',
            content: [{ type: 'text', text: '1\n[exit 0]' }],
            details: bashDetails({ command: 'grafana-prom query up', stdout: '1\n', durationMs: 42 }),
            isError: false,
            timestamp: 1,
          },
        ],
      ]),
      runs: {
        'call-2': { id: 'call-2', name: 'bash', args: { command: 'sleep 5' }, status: 'running', updatedAt: 1 },
      },
    };
    const { container } = render(
      <ToolTranscriptContext.Provider value={transcript}>
        <ContentBlocks
          content={[
            { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'grafana-prom query up' } },
            { type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: 'sleep 5' } },
          ]}
        />
      </ToolTranscriptContext.Provider>
    );

    const commands = Array.from(container.querySelectorAll('code.language-bash')).map((code) => code.textContent);
    expect(commands).toEqual(['grafana-prom query up', 'sleep 5']);
    expect(container.querySelector('code.language-bash span')?.textContent).toBe('grafana-prom');
    expect(container.textContent).toContain('42 ms');
    expect(container.textContent).not.toContain('/workspace');
    expect(screen.getAllByTestId('Spinner')).toHaveLength(1);
    expect(container.textContent).not.toContain('Run bash');
    expect(container.textContent).not.toContain('"command"');
  });

  it('renders session filesystem tool calls without results as prompt lines', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          { type: 'toolCall', name: 'bash', arguments: { command: 'ls', cwd: '/tmp' } },
          { type: 'toolCall', name: 'read', arguments: { path: '/workspace/notes.txt', offset: 3, limit: 20 } },
          { type: 'toolCall', name: 'write', arguments: { path: '/workspace/notes.txt', content: 'hello\n' } },
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

    expect(container.textContent).toContain('/tmp $ls');
    expect(container.textContent).toContain('›read /workspace/notes.txt');
    expect(container.textContent).toContain('›write /workspace/notes.txt6 B');
    expect(container.textContent).toContain('›edit /workspace/notes.txt2 edits');
    expect(container.querySelector('details')).toBeNull();
  });

  it('marks tool calls that are still streaming with a cursor', () => {
    const { container } = render(
      <ContentBlocks content={[{ type: 'toolCall', name: 'bash', arguments: { command: 'grafana se' } }]} isStreaming />
    );

    expect(container.textContent).toContain('grafana se');
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('renders read results as a collapsed line with numbered contents', () => {
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

    const summary = container.querySelector('details > summary');
    expect(summary?.textContent).toBe('›read /workspace/a.txtlines 3-4 of 10');
    expect((summary?.parentElement as HTMLDetailsElement | undefined)?.open).toBe(false);
    const lineNumbers = Array.from(container.querySelectorAll('pre > div')).map(
      (line) => line.firstElementChild?.textContent
    );
    expect(lineNumbers).toEqual(['3', '4']);
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

    expect(container.querySelector('details > summary')?.textContent).toBe('›read /grafana/dashboards/3 entries');
    expect(container.querySelector('details pre')?.textContent).toBe('abc/\nxyz/\nREADME.md');
  });

  it('renders write and edit results with inline diffs and marks dashboard copies as staged', () => {
    const diff =
      'Index: /workspace/a.json\n' +
      '--- /workspace/a.json\n' +
      '+++ /workspace/a.json\n' +
      '@@ -1,3 +1,3 @@\n' +
      ' {\n' +
      '-  "title": "Old"\n' +
      '+  "title": "New"\n' +
      ' }\n' +
      '\\ No newline at end of file\n';

    const { container } = render(
      <>
        <ToolResultMessageBody
          toolName="edit"
          content={[{ type: 'text', text: `Edited /workspace/a.json (revision 1a2b3c4d5e6f)\n${diff}` }]}
          details={{ path: '/workspace/a.json', revision: '1a2b3c4d5e6f', edits: 1, diff }}
        />
        <ToolResultMessageBody
          toolName="write"
          content={[{ type: 'text', text: 'Updated /grafana/dashboards/abc/dashboard.json (120 bytes)' }]}
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

    const diffs = Array.from(container.querySelectorAll('pre')).map((pre) =>
      Array.from(pre.children).map((line) => line.textContent)
    );
    expect(diffs).toEqual([
      ['@@ -1,3 +1,3 @@', ' {', '-  "title": "Old"', '+  "title": "New"', ' }'],
      ['@@ -1,3 +1,3 @@', ' {', '-  "title": "Old"', '+  "title": "New"', ' }'],
    ]);
    expect(container.textContent).toContain('›write /grafana/dashboards/abc/dashboard.json120 B');
    expect(container.textContent).not.toContain('Edited /workspace/a.json');
    expect(container.textContent?.match(/Grafana is unchanged/g)).toHaveLength(1);
  });

  it('renders write results without a diff as a single line', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="write"
        content={[{ type: 'text', text: 'Created /workspace/new.txt (6 bytes, revision abcdef012345)' }]}
        details={{ path: '/workspace/new.txt', change: 'created', bytes: 6, revision: 'abcdef012345' }}
      />
    );

    expect(container.textContent).toBe('›write /workspace/new.txt6 B');
  });

  it('renders bash results with output and git-status style file changes', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="bash"
        content={[{ type: 'text', text: '{ "ok": true }\n[exit 0]' }]}
        details={bashDetails({
          command: 'jq . /workspace/a.json > /grafana/dashboards/abc/dashboard.json',
          stdout: '{ "ok": true }\n',
          stderr: 'note: reformatted\n',
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
        })}
      />
    );

    expect(container.querySelector('code.language-bash')?.textContent).toBe(
      'jq . /workspace/a.json > /grafana/dashboards/abc/dashboard.json'
    );
    expect(container.querySelector('code.language-bash span')?.textContent).toBe('jq');
    const outputs = Array.from(container.querySelectorAll('pre')).map((pre) => pre.textContent);
    expect(outputs).toEqual([
      '{ "ok": true }',
      'note: reformatted',
      'M /grafana/dashboards/abc/dashboard.json  2.0 KiB  stagedA /workspace/out.txt  12 B',
    ]);
    expect(
      outputs.slice(0, 2).every((_, index) => container.querySelectorAll('pre')[index].querySelector('span') === null)
    ).toBe(true);
    expect(container.textContent).toContain('42 ms');
    expect(container.textContent).not.toContain('exit');
    expect(container.textContent).not.toContain('discarded');
    expect(container.querySelector('details')).toBeNull();
  });

  it('shows the first lines of long output and expands on request', () => {
    const stdout = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    const { container } = render(
      <ToolResultMessageBody toolName="bash" content={[]} details={bashDetails({ command: 'seq', stdout })} />
    );

    expect(container.querySelector('pre')?.textContent?.split('\n')).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: '… 20 more lines' }));
    expect(container.querySelector('pre')?.textContent?.split('\n')).toHaveLength(30);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders timed-out bash results with discarded changes', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="bash"
        content={[{ type: 'text', text: '[stderr]\ncommand timed out\n[exit 124]' }]}
        details={bashDetails({
          command: 'sleep 999',
          exitCode: 124,
          stderr: 'command timed out\n',
          timedOut: true,
          discardedChanges: 'timed out after 30000ms',
          durationMs: 30012,
        })}
      />
    );

    expect(container.textContent).toContain('timed out · 30.0 s');
    expect(container.textContent).toContain('discarded uncommitted changes: timed out after 30000ms');
    expect(container.textContent).toContain('command timed out');
  });

  it('renders the exit code of failed bash results', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="bash"
        content={[{ type: 'text', text: '[stderr]\nboom\n[exit 2]' }]}
        details={bashDetails({ command: 'false', exitCode: 2, stderr: 'boom\n', durationMs: 3 })}
      />
    );

    expect(container.textContent).toBe('$falseexit 2 · 3 msboom');
  });

  it('renders user shell commands with the user prompt', () => {
    const { container } = render(
      <UserShellEntry result={bashDetails({ command: 'ls', stdout: 'a\n', durationMs: 1 })} />
    );

    expect(container.textContent).toBe('!ls1 msa');
  });

  it('renders thrown tool errors under the prompt line', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="edit"
        content={[{ type: 'text', text: 'oldText not found in /workspace/a.txt.' }]}
        details={{ path: '/workspace/a.txt' }}
        isError
      />
    );

    expect(container.textContent).toBe('›edit /workspace/a.txtoldText not found in /workspace/a.txt.');
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
    expect(container.textContent).toContain('read /artifacts/artifact_1.json');
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
    expect(container.textContent).not.toContain('read /artifacts/artifact_1.json');
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

  it('renders images attached to bash results', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="bash"
        content={[
          { type: 'text', text: '{}\n[image] Screenshot checkout (attached below)\n[exit 0]' },
          { type: 'image', mimeType: 'image/png', data: 'aW1n' },
        ]}
        details={{
          command: 'grafana-dashboard screenshot checkout',
          cwd: '/workspace',
          exitCode: 0,
          stdout: '{}\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          changes: [],
          images: [{ title: 'Screenshot checkout', mimeType: 'image/png' }],
          durationMs: 5,
        }}
      />
    );

    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aW1n');
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

    const lines = Array.from(container.querySelectorAll('pre > div')).map((line) => line.textContent);
    expect(lines).toEqual(['@@ -1,2 +1,2 @@', '---foo', '+++bar', ' context']);
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
