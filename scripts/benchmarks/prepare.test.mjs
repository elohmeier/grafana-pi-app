import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureModelServer, prepareFixtureEnvironment, inspectPreparedStack } from './prepare.mjs';

test('preparation uses new named volumes and history long enough for the entire workload', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-bench-fixtures-'));
  try {
    const result = await prepareFixtureEnvironment(
      directory,
      'run-123',
      [{ timeoutMs: 3_600_000 }, { timeoutMs: 3_600_000 }],
      {},
      1_000_000
    );
    assert.equal(result.fixtures.historyEndTimestamp, 1000);
    assert.equal(result.fixtures.futureSeconds, 7980);
    const compose = JSON.parse(await readFile(path.join(directory, 'compose.fixtures.json')));
    assert.equal(compose.volumes['prometheus-data'].name, 'pi-bench-run-123-prometheus');
    assert.equal(compose.services['history-generator'].environment.HISTORY_END_TIMESTAMP, '1000');
    assert.ok(result.env.COMPOSE_FILE.endsWith('compose.fixtures.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('starts an absent local server, waits for the requested model and stops only the owned process', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-bench-model-'));
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  let model;
  try {
    const script = path.join(directory, 'model.cjs');
    await writeFile(
      script,
      `require('node:http').createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'test-model'}]}));}).listen(${port}, '127.0.0.1');`
    );
    const config = {
      model: { id: 'test-model', baseUrl: `http://127.0.0.1:${port}/v1` },
      localServer: { command: process.execPath, args: [script], startTimeoutMs: 10_000 },
    };
    await assert.rejects(
      ensureModelServer(config, process.env, directory, new AbortController().signal),
      /Start it externally/
    );
    model = await ensureModelServer(config, process.env, directory, new AbortController().signal, () => {}, true);
    assert.equal(model.metadata.managed, true);
    const reused = await ensureModelServer(config, process.env, directory, new AbortController().signal);
    assert.equal(reused.metadata.reused, true);
    await reused.stop();
    assert.ok((await fetch(config.model.baseUrl + '/models')).ok);
    await assert.rejects(
      ensureModelServer(
        { ...config, model: { ...config.model, id: 'wrong-model' } },
        process.env,
        directory,
        new AbortController().signal
      ),
      /does not advertise/
    );
    await model.stop();
    assert.throws(() => process.kill(model.metadata.pid, 0));
  } finally {
    await model?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reuses verified history, reseeds missing samples, and rebuilds changed or stale setups', async () => {
  const model = {
    id: 'test',
    baseUrl: 'http://localhost:8080/v1',
    protocol: 'chat-completions',
    thinkingLevel: 'off',
    thinkingFormat: 'openai',
  };
  let missingSample = false;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/settings')) {
      res.end(JSON.stringify({ jsonData: { openAIBaseUrl: model.baseUrl, models: [{ ...model, default: true }] } }));
    } else if (req.url.includes('/query')) {
      res.end(JSON.stringify({ data: { result: [{ value: [0, '360'] }] } }));
    } else if (missingSample && req.url.includes('/alertrules/')) {
      res.statusCode = 404;
      res.end('{}');
    } else {
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const state = {
    grafanaUrl: url,
    sourceSha256: 'source',
    fixtures: { historyEndTimestamp: Math.floor(Date.now() / 1000), futureSeconds: 3600 },
  };
  const inspect = (value = state, expected = model) =>
    inspectPreparedStack(value, expected, 'source', url, [{ timeoutMs: 1000 }], {}, new AbortController().signal);
  try {
    assert.deepEqual(await inspect(), { reusable: true, seedSamples: false });
    missingSample = true;
    assert.deepEqual(await inspect(), { reusable: true, seedSamples: true });
    assert.equal((await inspect({ ...state, sourceSha256: 'changed' })).reusable, false);
    assert.equal((await inspect({ ...state, fixtures: { historyEndTimestamp: 0, futureSeconds: 0 } })).reusable, false);
    assert.equal((await inspect(state, { ...model, id: 'other' })).reusable, false);
  } finally {
    server.close();
  }
});
