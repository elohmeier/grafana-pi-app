import { parentPort } from 'node:worker_threads';

/**
 * The browser's shell worker (`workspace/execution/shell.worker.ts`) in a
 * worker_threads worker: `self` is mapped to the parent port. Bundled as
 * dist-host/shell.worker.mjs next to the host.
 */
const port = parentPort;
if (!port) {
  throw new Error('shell.worker must run in a worker thread');
}
Object.assign(globalThis, {
  // The browser worker sets webpack's public path for its lazy chunks; the host bundle has none.
  __webpack_public_path__: '',
  self: {
    location: { href: import.meta.url },
    postMessage: (message: unknown) => port.postMessage(message),
    set onmessage(handler: (event: { data: unknown }) => void) {
      port.on('message', (data) => handler({ data }));
    },
  },
});
// Imported after `self` exists.
await import('../pages/Chat/workspace/execution/shell.worker');
