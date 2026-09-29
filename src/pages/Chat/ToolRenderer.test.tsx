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

describe('ToolRenderer', () => {
  it('renders calls of retired tools with their arguments behind the tool name', () => {
    const { container } = render(
      <ContentBlocks
        content={[
          { type: 'toolCall', name: 'run_query_agent', arguments: { task: 'Find CPU metrics.' } },
          { type: 'toolCall', name: 'list_metrics', arguments: {} },
        ]}
      />
    );

    const summaries = Array.from(container.querySelectorAll('details > summary')).map((summary) => summary.textContent);
    expect(summaries).toEqual(['›run_query_agent']);
    expect(container.querySelector('details pre')?.textContent).toContain('"task": "Find CPU metrics."');
    expect(container.textContent).toContain('›list_metrics');
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
        'call-2': {
          id: 'call-2',
          name: 'bash',
          args: { command: 'sleep 5' },
          status: 'running',
          partialResult: { content: [], details: { running: 'grafana-prom query up' } },
          startedAt: Date.now() - 3000,
          updatedAt: 1,
        },
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
    expect(container.textContent).toContain('3 s');
    expect(container.textContent).toContain('↳ grafana-prom query up');
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

  it('renders results of retired tools as their text output', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="run_query_agent"
        content={[{ type: 'text', text: 'Specialist answer' }]}
        details={{ type: 'subagent', agent: 'query', status: 'completed', task: 'Inspect.', toolCalls: [] }}
      />
    );

    expect(container.textContent).toBe('›run_query_agentSpecialist answer');
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

    expect(container.textContent).toBe('›get_alert_ruleAlert rule lookup failed');
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

  it('falls back to the default error message instead of dumping JSON', () => {
    const { container } = render(
      <ToolResultMessageBody
        toolName="query_prometheus"
        content={undefined}
        details={{ someField: { nested: true } }}
        isError
      />
    );

    expect(container.textContent).toBe('›query_prometheusTool failed without a readable error message.');
  });

  it('ignores non-string error primitives like false', () => {
    const { container } = render(
      <ToolResultMessageBody toolName="query_prometheus" content={undefined} details={{ error: false }} isError />
    );

    expect(container.textContent).toBe('›query_prometheusTool failed without a readable error message.');
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
