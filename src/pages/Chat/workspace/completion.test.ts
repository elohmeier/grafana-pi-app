import { WORKSPACE_COMMANDS } from './commands/commands';
import { completeShellLine, type CompletionSources } from './completion';

const sources: CompletionSources = {
  commands: WORKSPACE_COMMANDS,
  builtins: ['cat', 'grep', 'jq', 'python3'],
  paths: [
    '/',
    '/grafana',
    '/grafana/dashboards',
    '/grafana/dashboards/checkout',
    '/grafana/dashboards/checkout/dashboard.json',
    '/grafana/dashboards/checkout/meta.json',
    '/grafana/dashboards/checkpoint',
    '/grafana/dashboards/checkpoint/dashboard.json',
    '/workspace',
    '/workspace/notes.md',
    '/workspace/.hidden',
    '/tmp',
  ],
  directories: new Set(['/tmp']),
  cwd: '/workspace',
};

const complete = (line: string, caret = line.length) => completeShellLine(line, caret, sources);

describe('completeShellLine', () => {
  it('completes command names in command position, also after a pipe', () => {
    expect(complete('grafana-d')?.replacement).toBe('grafana-dashboard ');
    expect(complete('grafana')?.candidates.map((candidate) => candidate.value)).toEqual(
      expect.arrayContaining(['grafana', 'grafana-dashboard', 'grafana-prom', 'grafana-usage', 'grafana-alert'])
    );
    expect(complete('cat x | js')?.replacement).toBe('jsonnet ');
  });

  it('completes subcommands and options from the command registry', () => {
    expect(complete('grafana-dashboard que')?.replacement).toBe('queries ');
    expect(complete('workspace diff --st')?.replacement).toBe('--stat ');
    expect(complete('grafana-dashboard queries --m')?.candidates.map((candidate) => candidate.value)).toEqual([
      '--metric',
      '--match',
    ]);
    expect(complete('grafana-dashboard queries --m')?.replacement).toBe('--m');
  });

  it('completes paths relative to the working directory and absolute ones', () => {
    expect(complete('cat no')?.replacement).toBe('notes.md ');
    expect(complete('cat /grafana/dashboards/checkp')?.replacement).toBe('/grafana/dashboards/checkpoint/');
    expect(complete('cat /grafana/dashboards/check')?.replacement).toBe('/grafana/dashboards/check');
    expect(complete('cat /grafana/dashboards/checkout/')?.candidates.map((candidate) => candidate.label)).toEqual([
      'dashboard.json',
      'meta.json',
    ]);
    expect(complete('ls /t')?.replacement).toBe('/tmp/');
    expect(complete('cat ')?.candidates.map((candidate) => candidate.label)).toEqual(['notes.md']);
  });

  it('completes redirect targets and arguments after options as paths', () => {
    expect(complete('echo hi > no')?.replacement).toBe('notes.md ');
    expect(complete('grafana-dashboard inspect /grafana/dashboards/checkp')?.replacement).toBe(
      '/grafana/dashboards/checkpoint/'
    );
  });

  it('completes at the caret, not at the end of the line', () => {
    const result = complete('cat no | wc -l', 6);
    expect(result).toEqual(expect.objectContaining({ start: 4, end: 6, replacement: 'notes.md ' }));
  });

  it('returns nothing when nothing matches', () => {
    expect(complete('zzz')).toBeUndefined();
  });
});
