import type { CommandName, ExecResult, IFileSystem } from 'just-bash/browser';
import { jqCommand } from '../jqCommand';
import type { WorkspaceCommandContext } from '../commands/registry';

/** Built-in just-bash commands exposed to the agent. No network, process, or link commands. */
export const WORKSPACE_BUILTIN_COMMANDS: CommandName[] = [
  'echo',
  'cat',
  'printf',
  'ls',
  'mkdir',
  'rmdir',
  'touch',
  'rm',
  'cp',
  'mv',
  'pwd',
  'head',
  'tail',
  'wc',
  'stat',
  'grep',
  'fgrep',
  'egrep',
  'rg',
  'sed',
  'awk',
  'sort',
  'uniq',
  'comm',
  'cut',
  'paste',
  'tr',
  'rev',
  'nl',
  'fold',
  'expand',
  'unexpand',
  'column',
  'join',
  'tee',
  'find',
  'basename',
  'dirname',
  'tree',
  'du',
  'env',
  'printenv',
  'xargs',
  'true',
  'false',
  'bash',
  'sh',
  'yq',
  'base64',
  'diff',
  'date',
  'seq',
  'expr',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'file',
  'help',
  'which',
  'tac',
  'od',
];

export type ShellCommandCall = {
  name: string;
  args: string[];
  cwd: string;
  stdin: string;
  env: Record<string, string>;
};
export type ShellInput = { command: string; cwd: string; stdin?: string; commandNames: string[] };
export type ShellHost = { fs: IFileSystem; command: (call: ShellCommandCall) => Promise<ExecResult> };

/** Interpreter-only module: safe to load in a Worker, with no Grafana or React dependencies. */
export async function executeShell(input: ShellInput, host: ShellHost, signal?: AbortSignal): Promise<ExecResult> {
  const { Bash, defineCommand } = await import('just-bash/browser');
  const bash = new Bash({
    fs: host.fs,
    cwd: input.cwd,
    env: { HOME: '/workspace', PWD: input.cwd, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: '/tmp' },
    commands: WORKSPACE_BUILTIN_COMMANDS,
    customCommands: [
      ...input.commandNames.map((name) =>
        defineCommand(name, (args, ctx) =>
          host.command({
            name,
            args,
            cwd: ctx.cwd,
            stdin: stdinText(ctx.stdin),
            env: Object.fromEntries(ctx.env),
          })
        )
      ),
      defineCommand('jq', (args, ctx) =>
        jqCommand.run(args, {
          cwd: ctx.cwd,
          stdin: stdinText(ctx.stdin),
          env: Object.fromEntries(ctx.env),
          signal,
          tx: { readFile: (path: string) => host.fs.readFile(path) },
        } as unknown as WorkspaceCommandContext & { env: Record<string, string> })
      ),
    ],
    python: false,
    javascript: false,
    executionLimits: {
      maxCommandCount: 5000,
      maxLoopIterations: 5000,
      maxCallDepth: 50,
      maxAwkIterations: 100_000,
      maxSedIterations: 100_000,
      maxJqIterations: 100_000,
      maxStringLength: 4 * 1024 * 1024,
      maxHeredocSize: 1024 * 1024,
    },
  });
  return bash.exec(input.command, { cwd: input.cwd, stdin: input.stdin, signal });
}

function stdinText(stdin: unknown) {
  const raw = typeof stdin === 'string' ? stdin : String(stdin ?? '');
  const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0) & 0xff);
  return new TextDecoder().decode(bytes);
}
