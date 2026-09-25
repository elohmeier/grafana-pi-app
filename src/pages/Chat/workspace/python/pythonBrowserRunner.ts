import type { PythonRunner } from './pythonCommand';
import type { PythonRunOutput } from './pythonCore';

declare let __webpack_public_path__: string;

type PythonAssets = { wasmModule: WebAssembly.Module; stdlibZip: Uint8Array; cpythonScriptUrl: string };

let assetsPromise: Promise<PythonAssets> | undefined;

/**
 * Runs CPython-WASM in a fresh dedicated Worker per invocation. Assets are
 * served from the plugin's `cpython/` directory and loaded on first use; the
 * compiled WebAssembly module is cached and shared with each worker.
 */
export function createBrowserPythonRunner(): PythonRunner | undefined {
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
    return undefined;
  }
  return {
    async run(input, { timeoutMs, signal }) {
      const assets = await loadAssets();
      if (signal?.aborted) {
        throw new Error('python run aborted');
      }
      return new Promise<PythonRunOutput>((resolve, reject) => {
        const worker = new Worker(new URL('./python.worker.ts', import.meta.url));
        let settled = false;
        const finish = (action: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          worker.terminate();
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
        worker.onmessage = (event: MessageEvent<{ ok: boolean; output?: PythonRunOutput; error?: string }>) => {
          const message = event.data;
          finish(() =>
            message.ok && message.output ? resolve(message.output) : reject(new Error(message.error ?? 'python failed'))
          );
        };
        worker.onerror = (event) => finish(() => reject(new Error(event.message || 'python worker failed')));
        worker.postMessage({
          input,
          cpythonScriptUrl: assets.cpythonScriptUrl,
          wasmModule: assets.wasmModule,
          stdlibZip: assets.stdlibZip,
        });
      });
    },
  };
}

function loadAssets(): Promise<PythonAssets> {
  assetsPromise ??= (async () => {
    const base = new URL('cpython/', new URL(__webpack_public_path__, document.baseURI));
    const [wasm, zip] = await Promise.all([
      fetchBytes(new URL('python.wasm', base).toString()),
      fetchBytes(new URL('python313.zip', base).toString()),
    ]);
    return {
      wasmModule: await WebAssembly.compile(wasm),
      stdlibZip: new Uint8Array(zip),
      cpythonScriptUrl: new URL('python.cjs', base).toString(),
    };
  })().catch((error) => {
    assetsPromise = undefined;
    throw error;
  });
  return assetsPromise;
}

async function fetchBytes(url: string) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`failed to load Python runtime asset ${url} (${response.status})`);
  }
  return response.arrayBuffer();
}
