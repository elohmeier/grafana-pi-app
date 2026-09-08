import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('full CLI retains failed cases, continues serial scenarios and repetitions, and saves durable JSON', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-benchmark-runner-'));
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"version":"test"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(path.join(directory, 'scripts/benchmarks'), { recursive: true });
    await mkdir(path.join(directory, 'node_modules/@playwright/test'), { recursive: true });
    await copyFile(new URL('../benchmark-run.mjs', import.meta.url), path.join(directory, 'scripts/benchmark-run.mjs'));
    await copyFile(new URL('./core.mjs', import.meta.url), path.join(directory, 'scripts/benchmarks/core.mjs'));
    await copyFile(new URL('./runtime.mjs', import.meta.url), path.join(directory, 'scripts/benchmarks/runtime.mjs'));
    await copyFile(new URL('./prepare.mjs', import.meta.url), path.join(directory, 'scripts/benchmarks/prepare.mjs'));
    await copyFile(new URL('./profile.mjs', import.meta.url), path.join(directory, 'scripts/benchmarks/profile.mjs'));
    await copyFile(
      new URL('../configure-pi-model.mjs', import.meta.url),
      path.join(directory, 'scripts/configure-pi-model.mjs')
    );
    await writeFile(
      path.join(directory, 'config.json'),
      JSON.stringify({
        label: 'test',
        model: { id: 'mock', provider: 'mock', baseUrl: 'http://model.invalid/v1' },
        hosting: { label: 'mock' },
        apiKeyPi: 'models.json',
        repetitions: 2,
        suites: ['agent'],
      })
    );
    await writeFile(
      path.join(directory, 'node_modules/@playwright/test/cli.js'),
      `
const fs = require('node:fs');
const path = require('node:path');
const listing = process.argv.includes('--list');
if (!listing && process.env.OPENAI_API_KEY !== 'private-test-key') throw new Error('Pi key was not passed to the benchmark');
const failed = process.argv.some(arg => arg.endsWith(':10'));
const specs = (listing ? [10, 20] : [failed ? 10 : 20]).map(line => ({
  title: 'case ' + line, file: 'agentBenchmark.spec.ts', line,
  tests: [{ projectName: 'chromium', results: listing ? [] : [{status: failed ? 'failed' : 'passed', duration: 123, errors: []}] }],
}));
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({ suites: [{ title: 'benchmark', specs }] }));
if (!listing) fs.writeFileSync(path.join(process.env.BENCH_CASE_DIR, 'capture.json'), JSON.stringify({ events: [], requests: [{state: 'completed', usage: {reported: true, totalTokens: 15}}] }));
process.exitCode = failed ? 1 : 0;
`
    );
    const runCli = (args) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['scripts/benchmark-run.mjs', '--config', 'config.json', ...args], {
          cwd: directory,
          env: { ...process.env, GRAFANA_URL: `http://127.0.0.1:${server.address().port}` },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => (output += chunk));
        child.stderr.on('data', (chunk) => (output += chunk));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, output }));
      });
    // The referenced Pi file does not exist yet: planning must not even read it.
    const preview = await runCli(['--dry-run']);
    assert.equal(preview.code, 0, preview.output);
    const runsDirectory = path.join(directory, 'artifacts/benchmark-runs');
    const [plannedId] = await readdir(runsDirectory);
    const planned = JSON.parse(await readFile(path.join(runsDirectory, plannedId, 'run.json')));
    assert.equal(planned.status, 'planned');
    await writeFile(
      path.join(directory, 'models.json'),
      JSON.stringify({
        providers: { mock: { apiKey: '!printf private-test-key', models: [{ id: 'mock' }] } },
      })
    );
    const result = await runCli(['--reuse-stack']);
    assert.equal(result.code, 1, result.output);
    assert.ok(!result.output.includes('private-test-key'));
    const id = (await readdir(runsDirectory)).find((id) => id !== plannedId);
    const run = JSON.parse(await readFile(path.join(directory, 'artifacts/benchmark-runs', id, 'run.json')));
    assert.ok(!JSON.stringify(run).includes('private-test-key'));
    assert.equal(run.schemaVersion, 1);
    assert.deepEqual(
      run.cases.map((entry) => entry.status),
      ['failed', 'passed', 'failed', 'passed']
    );
    assert.equal(run.summary.llm.tokens.totalTokens.total, 60);
    assert.equal(run.summary.planned, 4);
    assert.equal(run.summary.passed, 2);
    assert.equal(run.summary.failed, 2);
    assert.equal(run.summary.notRun, 0);
    for (const entry of run.cases) {
      assert.ok(await readFile(path.join(directory, 'artifacts/benchmark-runs', id, entry.artifacts, 'capture.json')));
    }
    assert.ok(!(await readdir(path.join(directory, 'artifacts'))).includes('benchmark-run.lock'));
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
