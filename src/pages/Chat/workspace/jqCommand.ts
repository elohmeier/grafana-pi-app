import type { ExecResult } from 'just-bash/browser';
import { normalizeWorkspacePath } from './paths';
import type { WorkspaceShellCommand } from './shell';

type JqModule = typeof import('jq-wasm');

/** Options that take one value and pass through to jq unchanged. */
const ONE_VALUE_OPTIONS = new Set(['--indent']);
/** Options that take a name and a value and pass through unchanged. */
const TWO_VALUE_OPTIONS = new Set(['--arg', '--argjson']);

let jqModule: Promise<JqModule> | undefined;

/**
 * `jq` backed by jq 1.8 compiled to WebAssembly (jq-wasm), so filters behave
 * exactly like the jq models know. Input files and `--slurpfile`/`--rawfile`/
 * `-f` files are read through the workspace transaction; jq itself has no
 * filesystem access.
 */
export const jqCommand: WorkspaceShellCommand = {
  name: 'jq',
  async run(args, ctx) {
    const flags: string[] = [];
    const positionals: string[] = [];
    let filter: string | undefined;
    const readFile = (path: string) => ctx.tx.readFile(normalizeWorkspacePath(path, ctx.cwd));
    try {
      for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--') {
          positionals.push(...args.slice(index + 1));
          break;
        }
        if (arg === '-f' || arg === '--from-file') {
          filter = await readFile(requireValue(args, ++index, arg));
        } else if (arg === '--slurpfile' || arg === '--rawfile') {
          const name = requireValue(args, ++index, arg);
          const content = await readFile(requireValue(args, ++index, arg));
          flags.push(
            arg === '--rawfile' ? '--arg' : '--argjson',
            name,
            arg === '--rawfile' ? content : await slurp(content)
          );
        } else if (TWO_VALUE_OPTIONS.has(arg)) {
          flags.push(arg, requireValue(args, ++index, arg), requireValue(args, ++index, arg));
        } else if (ONE_VALUE_OPTIONS.has(arg)) {
          flags.push(arg, requireValue(args, ++index, arg));
        } else if (arg.startsWith('-') && arg !== '-') {
          flags.push(arg);
        } else {
          positionals.push(arg);
        }
      }
      if (filter === undefined) {
        filter = positionals.shift() ?? '.';
      }
      const inputs = positionals.filter((path) => path !== '-');
      let input = ctx.stdin;
      if (inputs.length > 0) {
        const contents = [];
        for (const path of inputs) {
          contents.push(await readFile(path));
        }
        input = contents.map((content) => (content.endsWith('\n') ? content : `${content}\n`)).join('');
      }
      const jq = await loadJq();
      const output = await jq.raw(input, filter, flags);
      return result(withNewline(output.stdout), withNewline(output.stderr), output.exitCode);
    } catch (error) {
      return result('', `jq: error: ${error instanceof Error ? error.message : String(error)}\n`, 2);
    }
  },
};

function requireValue(args: string[], index: number, option: string) {
  const value = args[index];
  if (value === undefined) {
    throw new Error(`${option} takes a value`);
  }
  return value;
}

/** A stream of JSON texts as one array, like jq's --slurpfile. */
async function slurp(content: string) {
  const output = await (await loadJq()).raw(content, '.', ['-s', '-c']);
  if (output.exitCode !== 0) {
    throw new Error(`--slurpfile: ${output.stderr.trim()}`);
  }
  return output.stdout;
}

function loadJq() {
  return (jqModule ??= import('jq-wasm'));
}

function withNewline(text: string) {
  return text && !text.endsWith('\n') ? `${text}\n` : text;
}

function result(stdout: string, stderr: string, exitCode: number): ExecResult {
  return { stdout, stderr, exitCode, stdoutKind: 'text' } as ExecResult;
}
