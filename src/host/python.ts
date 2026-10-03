import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { PythonRunner } from '../pages/Chat/workspace/python/pythonCommand';
import type { PythonRunOutput } from '../pages/Chat/workspace/python/pythonCore';

/**
 * `python3` for the assistant host: CPython-WASM from the plugin's `cpython/`
 * assets, one worker thread per run, terminated on timeout or cancellation.
 */
export function createNodePythonRunner(options: { assets: URL; worker: URL }): PythonRunner {
  let assets: Promise<{ wasmModule: WebAssembly.Module; stdlibZip: Uint8Array }> | undefined;
  const load = () => {
    assets ??= (async () => {
      const [wasm, zip] = await Promise.all([
        readFile(new URL('python.wasm', options.assets)),
        readFile(new URL('python313.zip', options.assets)),
      ]);
      return { wasmModule: await WebAssembly.compile(wasm), stdlibZip: new Uint8Array(zip) };
    })().catch((error) => {
      assets = undefined;
      throw error;
    });
    return assets;
  };
  return {
    async run(input, { timeoutMs, signal }) {
      const { wasmModule, stdlibZip } = await load();
      if (signal?.aborted) {
        throw new Error('python run aborted');
      }
      return new Promise<PythonRunOutput>((resolve, reject) => {
        const worker = new Worker(options.worker);
        let settled = false;
        const finish = (action: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          void worker.terminate();
          action();
        };
        const timer = setTimeout(
          () =>
            finish(() =>
              resolve({
                stdout: '',
                stderr: '',
                exitCode: 124,
                stdoutTruncated: false,
                stderrTruncated: false,
                files: {},
                skipped: [],
                timedOut: true,
              })
            ),
          timeoutMs
        );
        const onAbort = () => finish(() => reject(new Error('python run aborted')));
        signal?.addEventListener('abort', onAbort, { once: true });
        worker.on('message', (message: { ok: boolean; output?: PythonRunOutput; error?: string }) =>
          finish(() =>
            message.ok && message.output ? resolve(message.output) : reject(new Error(message.error ?? 'python failed'))
          )
        );
        worker.on('error', (error) => finish(() => reject(error)));
        worker.on('exit', (code) => finish(() => reject(new Error(`python worker exited with code ${code}`))));
        worker.postMessage({
          input,
          cpythonScript: new URL('python.js', options.assets).pathname,
          wasmModule,
          stdlibZip,
        });
      });
    },
  };
}
