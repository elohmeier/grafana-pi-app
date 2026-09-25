// Dedicated worker for one CPython run. The main thread terminates it on
// timeout or cancellation, which is a hard limit (unlike a cooperative abort).
import { runPythonProgram, type CreatePythonModule, type PythonRunInput } from './pythonCore';

type PythonWorkerRequest = {
  input: PythonRunInput;
  cpythonScriptUrl: string;
  wasmModule: WebAssembly.Module;
  stdlibZip: Uint8Array;
};

type PythonWorkerScope = {
  onmessage: ((event: MessageEvent<PythonWorkerRequest>) => void) | null;
  postMessage: (message: unknown) => void;
  importScripts: (...urls: string[]) => void;
  createPythonModule?: CreatePythonModule;
};

const scope = self as unknown as PythonWorkerScope;

scope.onmessage = async (event) => {
  const { input, cpythonScriptUrl, wasmModule, stdlibZip } = event.data;
  try {
    // The Emscripten loader is a classic script that defines a global factory.
    scope.importScripts(cpythonScriptUrl);
    if (typeof scope.createPythonModule !== 'function') {
      throw new Error('CPython loader did not initialize');
    }
    const output = await runPythonProgram(scope.createPythonModule, { wasmModule, stdlibZip }, input);
    scope.postMessage({ ok: true, output });
  } catch (error) {
    scope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
