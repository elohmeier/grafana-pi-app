import { Worker } from 'node:worker_threads';
import type { ShellWorker } from '../pages/Chat/workspace/execution/browserRunner';

/** worker_threads workers for the shell, adapted to the browser runner's worker interface. */
export function nodeShellWorkers(file: URL): () => ShellWorker {
  return () => {
    const worker = new Worker(file);
    const adapter: ShellWorker = {
      onmessage: null,
      onerror: null,
      postMessage: (message) => worker.postMessage(message),
      terminate: () => void worker.terminate(),
    };
    worker.on('message', (data) => adapter.onmessage?.({ data }));
    worker.on('error', (error) => adapter.onerror?.({ message: error.message }));
    // A worker that exits on its own did not answer; a terminated one is already settled.
    worker.on('exit', (code) => adapter.onerror?.({ message: `shell worker exited with code ${code}` }));
    return adapter;
  };
}
