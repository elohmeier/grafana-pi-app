import { FS_METHODS } from './protocol';
import type { IFileSystem } from 'just-bash/browser';
import { normalizeWorkspacePath } from '../paths';
import { executeShell, type ShellInput } from './engine';

// Lazy command chunks resolve relative to this worker asset, not the document.
// Grafana's webpack default is a relative plugin path, which would otherwise
// be appended a second time by importScripts inside the worker.
declare let __webpack_public_path__: string;
__webpack_public_path__ = new URL('.', self.location.href).href;

type Reply = { id: number; value?: unknown; error?: { message: string; code?: string }; paths?: string[] };
const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
let sequence = 0;
let paths: string[] = [];
let pathSet = new Set<string>();
/** Methods whose only outcome for a path outside the listing is ENOENT (or false). */
const LOCAL_MISS_METHODS = new Set(['readFile', 'readFileBuffer', 'stat', 'lstat', 'exists']);
const DASHBOARD_FILE = /^\/grafana\/dashboards\/[^/]+\/(dashboard|meta)\.json$/;

function setPaths(next: string[] | undefined) {
  if (next && next !== paths) {
    paths = next;
    pathSet = new Set(next);
  }
}

/**
 * Answers lookups of paths the host does not list without a round trip. Scans
 * probe many files that do not exist (rg reads .gitignore and .ignore in every
 * directory); the listing is current because every reply carries its changes.
 */
function localMiss(method: string, args: unknown[]) {
  const raw = args[0];
  if (!LOCAL_MISS_METHODS.has(method) || typeof raw !== 'string') {
    return undefined;
  }
  let path: string;
  try {
    path = normalizeWorkspacePath(raw, '/', { clampAtRoot: true });
  } catch {
    return undefined;
  }
  // Dashboards created after the listing was loaded are still readable by UID; the host decides.
  if (path === '/dev/null' || pathSet.has(path) || DASHBOARD_FILE.test(path)) {
    return undefined;
  }
  if (method === 'exists') {
    return Promise.resolve(false);
  }
  const verb = method === 'readFile' || method === 'readFileBuffer' ? 'open' : 'stat';
  return Promise.reject(
    Object.assign(new Error(`ENOENT: no such file or directory, ${verb} '${path}'`), { code: 'ENOENT' })
  );
}
function request(kind: 'fs' | 'command', method: string, args: unknown[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    self.postMessage({ type: 'request', id, kind, method, args });
  });
}

self.onmessage = async (
  event: MessageEvent<{ type: 'run'; input: ShellInput; paths?: string[] } | ({ type: 'reply' } & Reply)>
) => {
  const message = event.data;
  if (message.type === 'reply') {
    const call = pending.get(message.id);
    pending.delete(message.id);
    setPaths(message.paths);
    if (message.error) {
      call?.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    } else {
      call?.resolve(message.value);
    }
    return;
  }
  setPaths(message.paths ?? []);
  const fs = new Proxy({} as IFileSystem, {
    get(_target, method: string) {
      if (method === 'getAllPaths') {
        return () => paths;
      }
      if (method === 'resolvePath') {
        return (base: string, path: string) => normalizeWorkspacePath(path, base || '/', { clampAtRoot: true });
      }
      if (!FS_METHODS.has(method)) {
        return undefined;
      }
      return (...args: unknown[]) => localMiss(method, args) ?? request('fs', method, args);
    },
  });
  try {
    const result = await executeShell(message.input, { fs, command: (call) => request('command', 'run', [call]) });
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string })?.code,
    });
  }
};
