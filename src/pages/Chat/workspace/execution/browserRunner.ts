import type { ExecResult } from 'just-bash/browser';
import { WorkspaceError } from '../workspace';
import type { ShellHost, ShellInput } from './engine';

import { FS_METHODS } from './protocol';

/** Host-side RPC keeps every filesystem operation inside the original transaction. */
export function executeInWorker(input: ShellInput, host: ShellHost, signal: AbortSignal): Promise<ExecResult> {
  if (signal.aborted) {
    return Promise.reject(new Error('Shell cancelled'));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./shell.worker.ts', import.meta.url));
    let settled = false;
    const active = new Set<Promise<unknown>>();
    // The worker keeps the last path list it received; send it again only when it may have changed.
    let sentPathsKey: string | undefined;
    const changedPaths = () => {
      const key = host.pathsKey?.();
      if (key !== undefined && key === sentPathsKey) {
        return undefined;
      }
      sentPathsKey = key;
      return host.fs.getAllPaths();
    };
    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
      action();
    };
    const onAbort = () =>
      finish(() => {
        void Promise.allSettled([...active]).then(() => reject(new Error('Shell cancelled')));
      });
    signal.addEventListener('abort', onAbort, { once: true });
    worker.onerror = (event) => finish(() => reject(new Error(event.message || 'Shell worker failed')));
    worker.onmessage = async ({ data }) => {
      if (settled) {
        return;
      }
      if (data.type === 'result') {
        finish(() => resolve(data.result));
        return;
      }
      if (data.type === 'error') {
        finish(() => reject(data.code ? new WorkspaceError(data.code, data.message) : new Error(data.message)));
        return;
      }
      if (data.type !== 'request') {
        return;
      }
      try {
        let value: unknown;
        if (data.kind === 'command') {
          const command = host.command(data.args[0]);
          active.add(command);
          try {
            value = await command;
          } finally {
            active.delete(command);
          }
        } else {
          if (!FS_METHODS.has(data.method)) {
            throw new Error(`Unknown filesystem method ${data.method}`);
          }
          const method = (host.fs as unknown as Record<string, (...args: unknown[]) => unknown>)[data.method];
          value = await method.apply(host.fs, data.args);
        }
        if (!settled) {
          worker.postMessage({ type: 'reply', id: data.id, value, paths: changedPaths() });
        }
      } catch (error) {
        if (!settled) {
          worker.postMessage({
            type: 'reply',
            id: data.id,
            error: {
              message: error instanceof Error ? error.message : String(error),
              code: error instanceof WorkspaceError ? error.code : undefined,
            },
            paths: changedPaths(),
          });
        }
      }
    };
    worker.postMessage({ type: 'run', input, paths: changedPaths() });
  });
}
