import type { EvidencePresentation } from './commands/evidence';
import type { ExecResult } from 'just-bash/browser';
import type { ArtifactRuntime } from '../domain/artifacts';
import { WorkspaceBashFs } from './bashFs';
import type { WorkspaceApprovalService, WorkspaceBroker } from './broker';
import { WORKSPACE_COMMANDS } from './commands/commands';
import {
  runRegisteredCommand,
  type CommandImage,
  type CommandResult,
  type WorkspaceCommandContext,
  type WorkspaceCommandSpec,
} from './commands/registry';
import { executeShell, type ShellHost } from './execution/engine';
import type { ShellWorker } from './execution/browserRunner';
import { LIVE_DASHBOARD_PATH } from './liveDashboard';
import { normalizeWorkspacePath, truncateUtf8, utf8ByteLength } from './paths';
import type { WorkspaceFileChange } from './types';
import { WorkspaceError, type SessionWorkspace, type WorkspaceTransaction } from './workspace';

let shellWorkers: (() => ShellWorker) | undefined;

/**
 * Runs scripts in workers from `create` instead of browser Web Workers: the
 * assistant host uses worker_threads, so a runaway script can be terminated.
 */
export function setShellWorkerFactory(create: (() => ShellWorker) | undefined) {
  shellWorkers = create;
}

export const DEFAULT_SHELL_CWD = '/workspace';
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
export const MAX_SHELL_TIMEOUT_MS = 120_000;
export const DEFAULT_SHELL_OUTPUT_BYTES = 32 * 1024;
export const MAX_SHELL_IMAGES = 4;

export { WORKSPACE_BUILTIN_COMMANDS } from './execution/engine';

/** Extra shell command backed by the workspace transaction (for example python3). */
export type WorkspaceShellCommand = {
  name: string;
  run: (args: string[], ctx: WorkspaceCommandContext & { env: Record<string, string> }) => Promise<ExecResult>;
};

export type WorkspaceShellDeps = {
  workspace: SessionWorkspace;
  broker: WorkspaceBroker;
  approvals?: WorkspaceApprovalService;
  artifacts?: ArtifactRuntime;
  extraCommands?: WorkspaceShellCommand[];
  commandSpecs?: readonly WorkspaceCommandSpec[];
};

export type WorkspaceBashParams = {
  command: string;
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
};

export type WorkspaceBashResult = {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  /** Local file changes committed by this invocation. */
  changes: WorkspaceFileChange[];
  /** Set when staged changes were discarded (timeout, abort, or failed quota/policy check). */
  discardedChanges?: string;
  /** Images produced by commands (at most MAX_SHELL_IMAGES). */
  images?: CommandImage[];
  presentations?: EvidencePresentation[];
  durationMs: number;
};

/**
 * Runs one non-interactive bash invocation against the session workspace.
 * Shell variables, functions, and cwd reset per call; files persist. All file
 * changes of the invocation form one transaction: they are committed together
 * after the command finishes (regardless of exit status, like a normal shell),
 * and discarded as a unit on timeout, cancellation, or a failed quota check.
 */
export async function runWorkspaceBash(
  deps: WorkspaceShellDeps,
  params: WorkspaceBashParams,
  signal?: AbortSignal,
  /** Called with each host command (for example `grafana-prom query ...`) as it starts. */
  onProgress?: (command: string) => void
): Promise<WorkspaceBashResult> {
  const command = params.command?.trim();
  if (!command) {
    throw new Error('bash command is required');
  }
  const startedAt = Date.now();
  const cwd = normalizeWorkspacePath(params.cwd || DEFAULT_SHELL_CWD);
  const timeoutMs = Math.min(
    Math.max(Math.floor(params.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS), 1000),
    MAX_SHELL_TIMEOUT_MS
  );
  const controller = new AbortController();
  let timedOut = false;
  // The interpreter's own output is lost when a script is stopped, so host commands are recorded here.
  const hostLog = new HostCommandLog();
  let stoppedDuring: HostCommandRecord[] = [];
  const stop = () => {
    stoppedDuring = hostLog.running();
    controller.abort();
  };
  // The execution budget excludes time spent waiting for a human approval.
  const deadline = new PausableDeadline(timeoutMs, () => {
    timedOut = true;
    stop();
  });
  const approvals: WorkspaceApprovalService | undefined = deps.approvals && {
    async request(request) {
      deadline.pause();
      try {
        // Only the user's cancellation ends an approval wait, never the execution timeout.
        return await deps.approvals!.request(request, signal);
      } finally {
        deadline.resume();
      }
    },
  };
  const commandDeps: WorkspaceShellDeps = { ...deps, approvals };
  const forwardAbort = () => stop();
  if (signal?.aborted) {
    controller.abort();
  }
  signal?.addEventListener('abort', forwardAbort, { once: true });

  await deps.workspace.prepareMounts(controller.signal);
  // Fetching dashboards is not execution time: scanning every dashboard must not time out a command.
  const remoteWait = async <T>(pending: Promise<T>) => {
    deadline.pause();
    try {
      return await pending;
    } finally {
      deadline.resume();
    }
  };
  const tx = deps.workspace.begin({ signal: controller.signal, remoteWait });
  try {
    const fs = new WorkspaceBashFs(tx);
    if (!(await fs.exists(cwd))) {
      throw new WorkspaceError('ENOENT', `working directory does not exist: ${cwd}`);
    }
    const images: CommandImage[] = [];
    const presentations: EvidencePresentation[] = [];
    const specs = deps.commandSpecs ?? WORKSPACE_COMMANDS;
    const extras = deps.extraCommands ?? [];
    const host: ShellHost = {
      fs,
      pathsKey: () => tx.pathsKey(),
      async command(call) {
        if (controller.signal.aborted) {
          throw new Error('Shell cancelled');
        }
        const display = formatProgressCommand(call.name, call.args);
        onProgress?.(display);
        return hostLog.record(display, async () => {
          const ctx = commandContext(commandDeps, tx, call.cwd, call.stdin, controller.signal);
          const spec = specs.find((spec) => spec.name === call.name);
          if (spec) {
            const result = await runRegisteredCommand(spec, call.args, ctx);
            images.push(...(result.images ?? []));
            images.splice(0, Math.max(0, images.length - MAX_SHELL_IMAGES));
            presentations.push(...(result.presentations ?? []));
            presentations.splice(0, Math.max(0, presentations.length - 10));
            tx.refreshGeneratedFiles();
            return textResult(result);
          }
          const extra = extras.find((extra) => extra.name === call.name);
          if (!extra) {
            throw new Error(`Unknown command ${call.name}`);
          }
          return extra.run(call.args, { ...ctx, env: call.env });
        });
      },
    };
    const input = {
      command,
      cwd,
      stdin: params.stdin,
      commandNames: [...specs.map((spec) => spec.name), ...extras.map((extra) => extra.name)],
    };
    let exec: { stdout: string; stderr: string; exitCode: number };
    let escapedError: string | undefined;
    try {
      exec =
        typeof Worker === 'undefined' && !shellWorkers
          ? await executeShell(input, host, controller.signal)
          : await (
              await import('./execution/browserRunner')
            ).executeInWorker(input, host, controller.signal, shellWorkers);
    } catch (error) {
      // Some filesystem errors (for example a redirect into a read-only file or
      // a quota violation) escape the interpreter and end the script early.
      if (controller.signal.aborted) {
        exec = { stdout: '', stderr: '', exitCode: timedOut ? 124 : 130 };
      } else {
        if (!(error instanceof WorkspaceError)) {
          throw error;
        }
        escapedError = error.message;
        exec = { stdout: '', stderr: `bash: ${error.message}\n`, exitCode: 1 };
      }
    }

    let stdout = truncateUtf8(exec.stdout ?? '', DEFAULT_SHELL_OUTPUT_BYTES);
    const stderr = truncateUtf8(exec.stderr ?? '', DEFAULT_SHELL_OUTPUT_BYTES);
    let changes: WorkspaceFileChange[] = tx.committedChanges();
    let discardedChanges: string | undefined;
    let exitCode = exec.exitCode;
    let stderrText = stderr.text;
    if (escapedError) {
      tx.abort();
      discardedChanges = escapedError;
      stderrText = appendLine(
        stderrText,
        'bash: script stopped; uncommitted file changes were discarded; earlier apply boundaries remain committed'
      );
    } else if (controller.signal.aborted) {
      tx.abort();
      discardedChanges = timedOut ? `timed out after ${timeoutMs}ms` : 'cancelled';
      exitCode = timedOut ? 124 : 130;
      // A stopped interpreter returns nothing it printed; show what the host commands printed instead.
      const recover = !exec.stdout && !exec.stderr;
      if (recover) {
        stdout = { text: hostLog.transcript(DEFAULT_SHELL_OUTPUT_BYTES, stoppedDuring), truncated: false };
      }
      for (const line of stopMessage({
        timedOut,
        timeoutMs,
        running: stoppedDuring,
        log: hostLog,
        recovered: recover,
      })) {
        stderrText = appendLine(stderrText, line);
      }
    } else {
      try {
        changes = tx.commit();
      } catch (error) {
        tx.abort();
        discardedChanges = error instanceof Error ? error.message : String(error);
        exitCode = exitCode === 0 ? 1 : exitCode;
        stderrText = appendLine(
          stderrText,
          `bash: ${discardedChanges}; uncommitted file changes were discarded; earlier apply boundaries remain committed`
        );
      }
    }

    return {
      command,
      cwd,
      exitCode,
      stdout: stdout.text,
      stderr: stderrText,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut,
      changes,
      discardedChanges,
      ...(images.length > 0 ? { images: images.slice(-MAX_SHELL_IMAGES) } : {}),
      presentations: presentations.slice(-10),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    tx.abort();
    throw error;
  } finally {
    deadline.clear();
    signal?.removeEventListener('abort', forwardAbort);
  }
}

export function formatBashResult(result: Omit<WorkspaceBashResult, 'images'> & { images?: CommandImage[] }) {
  const parts: string[] = [];
  if (result.stdout) {
    parts.push(result.stdout.replace(/\n$/, ''));
    if (result.stdoutTruncated) {
      parts.push('[stdout truncated; redirect to a file and read it in windows]');
    }
  }
  if (result.stderr) {
    parts.push(`[stderr]\n${result.stderr.replace(/\n$/, '')}`);
    if (result.stderrTruncated) {
      parts.push('[stderr truncated]');
    }
  }
  for (const image of result.images ?? []) {
    parts.push(`[image] ${image.title} (attached below)`);
  }
  if (result.changes.some((change) => change.path === LIVE_DASHBOARD_PATH && change.change !== 'deleted')) {
    parts.push(`[live] ${LIVE_DASHBOARD_PATH} has staged edits that the browser does not show yet; run \`live apply\``);
  }
  if (result.changes.length > 0) {
    parts.push(`[files] ${result.changes.map((change) => `${change.change} ${change.path}`).join(', ')}`);
  }
  parts.push(`[exit ${result.exitCode}]`);
  return parts.join('\n');
}

function commandContext(
  deps: WorkspaceShellDeps,
  tx: WorkspaceTransaction,
  cwd: string,
  stdin: string,
  signal: AbortSignal
): WorkspaceCommandContext {
  return {
    workspace: deps.workspace,
    tx,
    cwd,
    stdin,
    signal,
    broker: deps.broker,
    approvals: deps.approvals,
    artifacts: deps.artifacts,
  };
}

function textResult({ stdout, stderr, exitCode }: CommandResult): ExecResult {
  return { stdout, stderr, exitCode, stdoutKind: 'text' };
}

function appendLine(text: string, line: string) {
  return text ? `${text.replace(/\n?$/, '\n')}${line}\n` : `${line}\n`;
}

/** A timeout that can be paused while waiting on something outside the invocation (user approval). */
class PausableDeadline {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private remaining: number;
  private startedAt = 0;
  private pauses = 0;

  constructor(
    budgetMs: number,
    private readonly onExpire: () => void
  ) {
    this.remaining = budgetMs;
    this.start();
  }

  pause() {
    if (this.pauses++ === 0 && this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.remaining -= Date.now() - this.startedAt;
    }
  }

  resume() {
    if (--this.pauses === 0) {
      this.start();
    }
  }

  clear() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = undefined;
    this.pauses = Number.POSITIVE_INFINITY;
  }

  private start() {
    this.startedAt = Date.now();
    this.timer = setTimeout(this.onExpire, Math.max(0, this.remaining));
  }
}

const MAX_PROGRESS_COMMAND_LENGTH = 200;

function formatProgressCommand(name: string, args: string[]) {
  const text = [name, ...args.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`))]
    .join(' ')
    .replace(/\s+/g, ' ');
  return text.length > MAX_PROGRESS_COMMAND_LENGTH ? `${text.slice(0, MAX_PROGRESS_COMMAND_LENGTH - 1)}…` : text;
}

type HostCommandRecord = { command: string; startedAt: number; done: boolean; output: string };

/** Output kept per finished host command, and in total, for the report of a stopped script. */
const HOST_RECORD_BYTES = 4 * 1024;
const HOST_LOG_BYTES = 2 * DEFAULT_SHELL_OUTPUT_BYTES;

/**
 * Records host commands (everything that runs outside the interpreter, such as
 * `grafana-prom query`) and what they printed. just-bash collects a script's
 * output in memory and drops it when the script is stopped, and a terminated
 * worker returns nothing, so this is the output that survives a timeout.
 */
class HostCommandLog {
  private records: HostCommandRecord[] = [];
  private retainedBytes = 0;
  private dropped = 0;

  async record(command: string, run: () => Promise<ExecResult>): Promise<ExecResult> {
    const record: HostCommandRecord = { command, startedAt: Date.now(), done: false, output: '' };
    this.records.push(record);
    try {
      const result = await run();
      record.output = recordOutput(result.stdout, result.stderr, result.exitCode);
      return result;
    } catch (error) {
      record.output = recordOutput('', error instanceof Error ? error.message : String(error), 1);
      throw error;
    } finally {
      record.done = true;
      this.retainedBytes += record.output.length;
      while (this.retainedBytes > HOST_LOG_BYTES && this.records[0]?.done) {
        this.retainedBytes -= this.records.shift()!.output.length;
        this.dropped++;
      }
    }
  }

  running() {
    return this.records.filter((record) => !record.done);
  }

  /** Commands that finished, except those still running when the script was stopped. */
  finished(stoppedDuring: HostCommandRecord[] = []) {
    return this.records.filter((record) => record.done && !stoppedDuring.includes(record));
  }

  finishedCount(stoppedDuring: HostCommandRecord[] = []) {
    return this.dropped + this.finished(stoppedDuring).length;
  }

  /** The newest finished commands with their output, within maxBytes. */
  transcript(maxBytes: number, stoppedDuring: HostCommandRecord[]) {
    const finished = this.finished(stoppedDuring);
    const parts: string[] = [];
    let bytes = 0;
    let index = finished.length - 1;
    for (; index >= 0; index--) {
      const part = `$ ${finished[index].command}\n${finished[index].output}`;
      // Leaves room for the omission note.
      if (bytes + utf8ByteLength(part) > maxBytes - 64) {
        break;
      }
      parts.unshift(part);
      bytes += utf8ByteLength(part);
    }
    const omitted = this.dropped + index + 1;
    return (omitted > 0 ? `[${omitted} earlier host commands not shown]\n` : '') + parts.join('');
  }
}

function recordOutput(stdout: string, stderr: string, exitCode: number) {
  const clip = (text: string) => {
    const clipped = truncateUtf8(text, HOST_RECORD_BYTES);
    return clipped.truncated ? `${clipped.text}\n[truncated]\n` : text.replace(/\n?$/, '\n');
  };
  return [
    stdout ? clip(stdout) : '',
    stderr ? `[stderr] ${clip(stderr)}` : '',
    exitCode !== 0 ? `[exit ${exitCode}]\n` : '',
  ].join('');
}

/** Explains a timeout or cancellation: what was running, what output is shown, and what to do next. */
function stopMessage({
  timedOut,
  timeoutMs,
  running,
  log,
  recovered,
}: {
  timedOut: boolean;
  timeoutMs: number;
  running: HostCommandRecord[];
  log: HostCommandLog;
  recovered: boolean;
}) {
  const reason = timedOut ? `timed out after ${timeoutMs}ms` : 'cancelled';
  const now = Date.now();
  const lines: string[] = [];
  if (running.length > 0) {
    const commands = running.map(
      (record) => `\`${record.command}\` (running for ${((now - record.startedAt) / 1000).toFixed(1)}s)`
    );
    lines.push(`bash: ${reason} while running ${commands.join(', ')}`);
  } else {
    const last = log.finished().at(-1);
    lines.push(
      `bash: ${reason} in the script itself, with no host command running` +
        (last ? `; the last one to finish was \`${last.command}\`` : '')
    );
  }
  if (recovered) {
    const finished = log.finishedCount(running);
    lines.push(
      finished > 0
        ? `bash: the script's own output (echo, jq, pipes) is lost when it is stopped; stdout shows what the ${finished} host commands that finished printed, before any pipe or redirect`
        : `bash: the script's own output is lost when it is stopped, and no host command finished`
    );
  }
  lines.push('bash: file changes of this call were discarded; earlier apply boundaries remain committed');
  if (timedOut) {
    lines.push(
      timeoutMs >= MAX_SHELL_TIMEOUT_MS
        ? `bash: ${MAX_SHELL_TIMEOUT_MS}ms is the maximum timeoutMs; split the work into several bash calls (for example fewer queries or dashboards per call)`
        : `bash: raise timeoutMs (up to ${MAX_SHELL_TIMEOUT_MS}) or split the work into several bash calls`
    );
  }
  return lines;
}
