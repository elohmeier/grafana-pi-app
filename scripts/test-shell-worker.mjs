#!/usr/bin/env node
// Smoke-test the production Web Worker bundle without a server or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const dist = path.resolve('dist');
const map = fs
  .readdirSync(dist)
  .filter((name) => name.endsWith('.js.map'))
  .find((name) => {
    const source = JSON.parse(fs.readFileSync(path.join(dist, name), 'utf8'));
    return source.sources.some((source) => source.endsWith('/execution/shell.worker.ts'));
  });
assert.ok(map, 'Build the frontend before running this check.');
const filename = path.join(dist, map.slice(0, -4));
const workerPrelude = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const vm = require('node:vm');
const { pathToFileURL, fileURLToPath } = require('node:url');
globalThis.self = globalThis;
globalThis.location = { href: pathToFileURL(workerData).href, toString() { return this.href; } };
globalThis.importScripts = (...urls) => { for (const url of urls) { const file = require('node:path').join(require('node:path').dirname(workerData), require('node:path').basename(fileURLToPath(new URL(url, location.href)))); vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file }); } };
globalThis.postMessage = (message) => parentPort.postMessage(message);
parentPort.on('message', (data) => globalThis.onmessage({ data }));
importScripts(location.href);
`;
function run(command, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPrelude, { eval: true, workerData: filename });
    const files = new Map();
    let timer = setTimeout(() => {
      worker.terminate();
      resolve({ timedOut: true, files });
    }, timeoutMs);
    const finish = (callback) => {
      clearTimeout(timer);
      worker.terminate();
      callback();
    };
    worker.on('error', (error) => finish(() => reject(error)));
    const paths = () => ['/workspace', '/tmp', ...files.keys()];
    worker.on('message', async (message) => {
      if (message.type === 'result') {
        finish(() => resolve({ ...message.result, files }));
        return;
      }
      if (message.type === 'error') {
        finish(() => reject(new Error(message.message)));
        return;
      }
      if (message.type !== 'request') {
        return;
      }
      const [file, content] = message.args;
      try {
        let value;
        switch (message.method) {
          case 'exists':
            value = paths().includes(file);
            break;
          case 'stat':
          case 'lstat':
            if (!paths().includes(file)) {
              throw new Error(`ENOENT ${file}`);
            }
            value = {
              isFile: files.has(file),
              isDirectory: !files.has(file),
              isSymbolicLink: false,
              mode: 0o755,
              size: files.get(file)?.length ?? 0,
              mtime: new Date(0),
            };
            break;
          case 'writeFile':
            files.set(file, typeof content === 'string' ? content : new TextDecoder().decode(content));
            break;
          case 'appendFile':
            files.set(file, (files.get(file) ?? '') + content);
            break;
          case 'readFile':
            if (!files.has(file)) {
              throw new Error(`ENOENT ${file}`);
            }
            value = files.get(file);
            break;
          case 'readFileBuffer':
            value = new TextEncoder().encode(files.get(file));
            break;
          case 'mkdir':
            break;
          default:
            throw new Error(`Unexpected method ${message.method}`);
        }
        worker.postMessage({ type: 'reply', id: message.id, value, paths: paths() });
      } catch (error) {
        worker.postMessage({ type: 'reply', id: message.id, error: { message: error.message }, paths: paths() });
      }
    });
    worker.postMessage({ type: 'run', input: { command, cwd: '/workspace', commandNames: [] }, paths: paths() });
  });
}
const result = await run(`echo '{"x":1}' > /workspace/input.json; jq '.x + 1' /workspace/input.json`);
assert.equal(result.exitCode, 0, result.stderr);
assert.equal(result.stdout, '2\n');
assert.equal(result.files.get('/workspace/input.json'), '{"x":1}\n');
const killed = await run(`jq -n 'def loop: loop; loop'`, { timeoutMs: 1500 });
assert.equal(killed.timedOut, true);
console.log('Production shell worker: filesystem RPC, jq WASM, and hard termination passed.');
