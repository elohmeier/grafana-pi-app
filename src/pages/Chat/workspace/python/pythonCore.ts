// Runs one CPython (Emscripten/WASM) program against an in-memory file
// snapshot. Pure with respect to the host: no DOM, no network, no workspace
// access. Used inside the Web Worker and directly by tests.

export type PythonRunInput = {
  argv: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  /** Files made visible to the program, by absolute path. */
  files: Record<string, string>;
  /** Roots whose files are returned after the run (writable mounts). */
  collectRoots: string[];
  maxOutputBytes: number;
  maxFileBytes: number;
};

export type PythonRunOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Files under collectRoots after the run. */
  files: Record<string, string>;
  /** Files under collectRoots that could not be returned (too large or not UTF-8). */
  skipped: string[];
  timedOut?: boolean;
};

export type PythonRuntimeBinaries = {
  /** Precompiled module (preferred; avoids recompiling per run). */
  wasmModule?: WebAssembly.Module;
  wasmBinary?: Uint8Array;
  stdlibZip: Uint8Array;
};

type EmscriptenFS = {
  init: (stdin: () => number | null) => void;
  mkdirTree: (path: string) => void;
  writeFile: (path: string, data: string | Uint8Array) => void;
  readFile: (path: string, options?: { encoding: 'binary' }) => Uint8Array;
  readdir: (path: string) => string[];
  stat: (path: string) => { mode: number; size: number };
  isDir: (mode: number) => boolean;
  isFile: (mode: number) => boolean;
  chdir: (path: string) => void;
  analyzePath: (path: string) => { exists: boolean };
};

type EmscriptenModule = {
  FS: EmscriptenFS;
  ENV: Record<string, string>;
  callMain: (args: string[]) => number;
};

export type CreatePythonModule = (options: Record<string, unknown>) => Promise<EmscriptenModule>;

const IGNORED_STDERR = ['Could not find platform', 'LLVM Profile Error'];

export async function runPythonProgram(
  createPythonModule: CreatePythonModule,
  binaries: PythonRuntimeBinaries,
  input: PythonRunInput
): Promise<PythonRunOutput> {
  const stdout = new BoundedText(input.maxOutputBytes);
  const stderr = new BoundedText(input.maxOutputBytes);
  const stdinBytes = new TextEncoder().encode(input.stdin);
  let stdinOffset = 0;

  const moduleOptions: Record<string, unknown> = {
    noInitialRun: true,
    print: (text: string) => stdout.append(`${text}\n`),
    printErr: (text: string) => {
      if (!IGNORED_STDERR.some((ignored) => text.includes(ignored))) {
        stderr.append(`${text}\n`);
      }
    },
    preRun: [
      (mod: EmscriptenModule) => {
        mod.FS.init(() => (stdinOffset < stdinBytes.length ? stdinBytes[stdinOffset++] : null));
        mod.FS.mkdirTree('/lib');
        mod.FS.writeFile('/lib/python313.zip', binaries.stdlibZip);
        mod.ENV.PYTHONHOME = '/';
        mod.ENV.PYTHONPATH = '/lib/python313.zip';
        mod.ENV.PYTHONDONTWRITEBYTECODE = '1';
        mod.ENV.PYTHONUNBUFFERED = '1';
        mod.ENV.PYTHONIOENCODING = 'utf-8';
        mod.ENV.PYTHON_COLORS = '0';
        mod.ENV.NO_COLOR = '1';
        for (const [key, value] of Object.entries(input.env)) {
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith('PYTHON')) {
            mod.ENV[key] = value;
          }
        }
      },
    ],
  };
  if (binaries.wasmModule) {
    const wasmModule = binaries.wasmModule;
    moduleOptions.instantiateWasm = (
      imports: WebAssembly.Imports,
      receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
    ) => {
      WebAssembly.instantiate(wasmModule, imports).then((instance) => receive(instance, wasmModule));
      return {};
    };
  } else if (binaries.wasmBinary) {
    moduleOptions.wasmBinary = binaries.wasmBinary;
  }

  const mod = await createPythonModule(moduleOptions);
  const FS = mod.FS;
  for (const [path, content] of Object.entries(input.files)) {
    FS.mkdirTree(parentOf(path));
    FS.writeFile(path, content);
  }
  for (const root of input.collectRoots) {
    FS.mkdirTree(root);
  }
  FS.mkdirTree(input.cwd);
  FS.chdir(input.cwd);

  let exitCode: number;
  try {
    exitCode = mod.callMain(input.argv);
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (typeof status === 'number') {
      exitCode = status;
    } else {
      stderr.append(`python: ${error instanceof Error ? error.message : String(error)}\n`);
      exitCode = 1;
    }
  }

  const files: Record<string, string> = {};
  const skipped: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = FS.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === '.' || name === '..') {
        continue;
      }
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
      const stat = FS.stat(path);
      if (FS.isDir(stat.mode)) {
        walk(path);
      } else if (FS.isFile(stat.mode)) {
        if (stat.size > input.maxFileBytes) {
          skipped.push(`${path} (larger than ${input.maxFileBytes} bytes)`);
          continue;
        }
        try {
          files[path] = decoder.decode(FS.readFile(path, { encoding: 'binary' }));
        } catch {
          skipped.push(`${path} (not UTF-8 text)`);
        }
      }
    }
  };
  for (const root of input.collectRoots) {
    walk(root);
  }

  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    files,
    skipped,
  };
}

class BoundedText {
  private chunks: string[] = [];
  private bytes = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(text: string) {
    if (this.truncated) {
      return;
    }
    const size = new TextEncoder().encode(text).length;
    if (this.bytes + size > this.maxBytes) {
      this.truncated = true;
      return;
    }
    this.bytes += size;
    this.chunks.push(text);
  }

  get text() {
    return this.chunks.join('');
  }
}

function parentOf(path: string) {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}
