import { FS_METHODS } from './protocol';
import type { IFileSystem } from 'just-bash/browser';
import { normalizeWorkspacePath } from '../paths';
import { executeShell, type ShellInput } from './engine';

type Reply = { id: number; value?: unknown; error?: { message: string; code?: string }; paths: string[] };
const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
let sequence = 0;
let paths: string[] = [];
function request(kind: 'fs' | 'command', method: string, args: unknown[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    self.postMessage({ type: 'request', id, kind, method, args });
  });
}

self.onmessage = async (
  event: MessageEvent<{ type: 'run'; input: ShellInput; paths: string[] } | ({ type: 'reply' } & Reply)>
) => {
  const message = event.data;
  if (message.type === 'reply') {
    const call = pending.get(message.id);
    pending.delete(message.id);
    paths = message.paths;
    if (message.error) {
      call?.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    } else {
      call?.resolve(message.value);
    }
    return;
  }
  paths = message.paths;
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
      return (...args: unknown[]) => request('fs', method, args);
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
