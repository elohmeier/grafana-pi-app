import type { ExecResult } from 'just-bash/browser';
import { isWithin } from '../paths';
import type { WorkspaceShellCommand } from '../shell';
import { DASHBOARDS_ROOT, SCRATCH_MOUNTS, WorkspaceError, type WorkspaceTransaction } from '../workspace';
import type { PythonRunInput, PythonRunOutput } from './pythonCore';

export type PythonRunner = {
  run: (input: PythonRunInput, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<PythonRunOutput>;
};

const PYTHON_TIMEOUT_MS = 60_000;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
/** Generated mounts copied into the interpreter. Network-backed mounts (catalog, live) are excluded. */
const READ_ONLY_ROOTS = ['/.agents/skills', '/artifacts'];

/**
 * `python3`/`python` backed by CPython compiled to WebAssembly. The program
 * sees a copy of the session filesystem (scratch mounts, hydrated dashboards,
 * skills, artifacts); files it creates, changes, or deletes under writable
 * locations are staged through the same transaction and policy as bash.
 * There is no network access and no JavaScript bridge.
 */
export function createPythonCommands(runner: PythonRunner): WorkspaceShellCommand[] {
  const run: WorkspaceShellCommand['run'] = async (args, ctx) => {
    const tx = ctx.tx;
    const snapshot = await snapshotFiles(tx);
    if (snapshot.bytes > MAX_INPUT_BYTES) {
      return result('', `python: workspace too large to copy into the interpreter (${snapshot.bytes} bytes)\n`, 1);
    }
    let output: PythonRunOutput;
    try {
      output = await runner.run(
        {
          argv: args,
          stdin: ctx.stdin,
          cwd: ctx.cwd,
          env: { HOME: '/workspace', TMPDIR: '/tmp', LANG: 'C.UTF-8', ...pickEnv(ctx.env) },
          files: snapshot.files,
          collectRoots: [...SCRATCH_MOUNTS, DASHBOARDS_ROOT],
          maxOutputBytes: MAX_OUTPUT_BYTES,
          maxFileBytes: tx.workspace.limits.maxFileBytes,
        },
        { timeoutMs: PYTHON_TIMEOUT_MS, signal: ctx.signal }
      );
    } catch (error) {
      if (ctx.signal?.aborted) {
        throw error;
      }
      return result('', `python: ${error instanceof Error ? error.message : String(error)}\n`, 1);
    }
    if (output.timedOut) {
      return result(
        output.stdout,
        `${output.stderr}python: killed after ${PYTHON_TIMEOUT_MS}ms; file changes discarded\n`,
        124
      );
    }

    const warnings: string[] = output.skipped.map((path) => `python: not staged: ${path}`);
    for (const [path, content] of Object.entries(output.files)) {
      if (snapshot.files[path] === content) {
        continue;
      }
      if (!isStageable(path)) {
        warnings.push(`python: not staged: ${path} is read-only`);
        continue;
      }
      try {
        await tx.writeFile(path, content);
      } catch (error) {
        warnings.push(`python: not staged: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const path of snapshot.writable) {
      if (!(path in output.files) && !output.skipped.some((skipped) => skipped.startsWith(`${path} `))) {
        try {
          await tx.rm(path, { force: true });
        } catch (error) {
          warnings.push(`python: delete not staged: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const stderr = output.stderr + (output.stderrTruncated ? 'python: stderr truncated\n' : '');
    return result(
      output.stdout + (output.stdoutTruncated ? '\n[python stdout truncated]\n' : ''),
      warnings.length ? `${stderr}${warnings.join('\n')}\n` : stderr,
      output.exitCode
    );
  };
  return [
    { name: 'python3', run },
    { name: 'python', run },
  ];
}

async function snapshotFiles(tx: WorkspaceTransaction) {
  const files: Record<string, string> = {};
  const writable: string[] = [];
  let bytes = 0;
  for (const path of tx.allPaths()) {
    const stageable = isStageable(path);
    const readOnly = READ_ONLY_ROOTS.some((root) => isWithin(path, root)) || /\/meta\.json$/.test(path);
    if (!stageable && !readOnly) {
      continue;
    }
    if ((await tx.entryType(path)) !== 'file') {
      continue;
    }
    try {
      const content = await tx.readFile(path);
      files[path] = content;
      bytes += content.length;
      if (stageable) {
        writable.push(path);
      }
    } catch (error) {
      if (!(error instanceof WorkspaceError)) {
        throw error;
      }
    }
  }
  return { files, writable, bytes };
}

function isStageable(path: string) {
  return (
    SCRATCH_MOUNTS.some((mount) => isWithin(path, mount)) ||
    /^\/grafana\/dashboards\/[A-Za-z0-9_-]{1,40}\/dashboard\.json$/.test(path)
  );
}

function pickEnv(env: Record<string, string>) {
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!['PATH', 'PWD', 'OLDPWD', 'SHLVL', 'IFS', 'PS1', 'PS2', 'PS4', 'OPTIND'].includes(key)) {
      picked[key] = value;
    }
  }
  return picked;
}

function result(stdout: string, stderr: string, exitCode: number): ExecResult {
  return { stdout, stderr, exitCode, stdoutKind: 'text' };
}
