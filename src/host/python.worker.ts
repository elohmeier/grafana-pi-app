import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import {
  runPythonProgram,
  type CreatePythonModule,
  type PythonRunInput,
} from '../pages/Chat/workspace/python/pythonCore';

/**
 * One CPython-WASM run in a worker thread, like the browser's python.worker.
 * The Emscripten loader (`python.js`) supports Node; it is a classic script,
 * so it is evaluated with the CommonJS names it expects.
 */
const port = parentPort;
if (!port) {
  throw new Error('python.worker must run in a worker thread');
}
port.once(
  'message',
  async (message: {
    input: PythonRunInput;
    cpythonScript: string;
    wasmModule: WebAssembly.Module;
    stdlibZip: Uint8Array;
  }) => {
    try {
      const { cpythonScript } = message;
      const load = new Function(
        'require',
        '__filename',
        '__dirname',
        `${readFileSync(cpythonScript, 'utf8')}\nreturn createPythonModule;`
      );
      const createPythonModule = load(
        createRequire(cpythonScript),
        cpythonScript,
        path.dirname(cpythonScript)
      ) as CreatePythonModule;
      const output = await runPythonProgram(
        createPythonModule,
        { wasmModule: message.wasmModule, stdlibZip: message.stdlibZip },
        message.input
      );
      port.postMessage({ ok: true, output });
    } catch (error) {
      port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
);
