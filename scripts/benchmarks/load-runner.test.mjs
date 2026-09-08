import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('load CLI plans without credentials, shares the lock, reports saturation and checkpoints interruption', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-load-runner-'));
  const server = createServer((_req, res) => res.end('{"version":"test"}'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(path.join(directory, 'scripts/benchmarks'), { recursive: true });
    await mkdir(path.join(directory, 'node_modules/@playwright/test'), { recursive: true });
    for (const file of [
      'benchmark-load.mjs',
      'configure-pi-model.mjs',
      ...['core', 'load', 'profile', 'prepare', 'runtime'].map((name) => `benchmarks/${name}.mjs`),
    ]) {
      await copyFile(new URL(`../${file}`, import.meta.url), path.join(directory, 'scripts', file));
    }
    await writeFile(
      path.join(directory, 'config.json'),
      JSON.stringify({
        label: 'mock',
        model: { id: 'mock', provider: 'mock', baseUrl: 'http://model.invalid/v1' },
        hosting: { label: 'mock' },
        apiKeyPi: 'missing-models.json',
      })
    );
    await writeFile(
      path.join(directory, 'load.json'),
      JSON.stringify({ concurrency: [1, 2], workloads: ['analysis'], cooldownMs: 0, minSessions: 1 })
    );
    await writeFile(
      path.join(directory, 'node_modules/@playwright/test/cli.js'),
      `
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  if (process.env.OPENAI_API_KEY !== 'private-load-key') throw new Error('Missing credentials');
  if (process.env.BENCH_UNDECLARED) throw new Error('Inherited workload knob');
  if (process.env.RUN_LOAD_BENCHMARKS !== '1') throw new Error('Missing load opt-in');
  const {stage, config} = JSON.parse(process.env.BENCH_LOAD_STAGE);
  if (process.env.MOCK_INTERRUPT === '1') { process.stdout.write('ready'); setInterval(() => {}, 1000); return; }
  const {summarizeLoadStage} = await import(path.join(process.cwd(), 'scripts/benchmarks/load.mjs'));
  Object.assign(stage, {status:'completed', errors:[], measurementStartedAt:1000, measurementEndedAt:2000,
    sessions:[{startedAt:1100,finishedAt:1500,durationMs:400,status:stage.concurrency===1?'passed':'timedOut',requests:[{startedAt:1100,durationMs:400,state:'completed',firstContentMs:10}]}]});
  stage.summary = summarizeLoadStage(stage, config);
  fs.writeFileSync(path.join(process.env.BENCH_LOAD_DIR,'stage.json'), JSON.stringify(stage));
})();
`
    );
    const runCli = async (args, extraEnv = {}, interrupt = false) => {
      const before = new Set(await readdir(path.join(directory, 'artifacts/benchmark-load-runs')).catch(() => []));
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['scripts/benchmark-load.mjs', '--config', 'config.json', '--load-config', 'load.json', ...args],
          {
            cwd: directory,
            env: {
              ...process.env,
              BENCH_UNDECLARED: 'clear-me',
              GRAFANA_URL: `http://127.0.0.1:${server.address().port}`,
              ...extraEnv,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        let output = '';
        child.stdout.on('data', (data) => {
          output += data;
        });
        child.stderr.on('data', (data) => {
          output += data;
        });
        child.on('error', reject);
        // Wait for the stage child's ready marker in its log before interrupting.
        const timer = interrupt
          ? setInterval(async () => {
              const ids = await readdir(path.join(directory, 'artifacts/benchmark-load-runs')).catch(() => []);
              const id = ids.find((id) => !before.has(id));
              if (!id) {
                return;
              }
              const log = await readFile(
                path.join(directory, 'artifacts/benchmark-load-runs', id, 'stages/1-analysis-1/console.log'),
                'utf8'
              ).catch(() => '');
              if (log.includes('ready')) {
                clearInterval(timer);
                child.kill('SIGINT');
              }
            }, 20)
          : undefined;
        const guard = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('CLI did not terminate'));
        }, 10_000);
        child.on('close', (code) => {
          clearTimeout(guard);
          clearInterval(timer);
          resolve({ code, output });
        });
      });
      const id = (await readdir(path.join(directory, 'artifacts/benchmark-load-runs'))).find((id) => !before.has(id));
      return {
        ...result,
        run: JSON.parse(await readFile(path.join(directory, 'artifacts/benchmark-load-runs', id, 'run.json'))),
      };
    };
    const planned = await runCli(['--dry-run']);
    assert.equal(planned.code, 0, planned.output);
    assert.equal(planned.run.status, 'planned');
    assert.equal(planned.run.stages.length, 2);
    // A comparison runner's lock must prevent even credential resolution.
    await writeFile(path.join(directory, 'artifacts/benchmark-run.lock'), 'other-runner');
    const locked = await runCli(['--reuse-stack']);
    assert.equal(locked.code, 1);
    assert.match(locked.output, /Another benchmark/);
    assert.equal(await readFile(path.join(directory, 'artifacts/benchmark-run.lock'), 'utf8'), 'other-runner');
    await rm(path.join(directory, 'artifacts/benchmark-run.lock'));
    await writeFile(
      path.join(directory, 'missing-models.json'),
      JSON.stringify({ providers: { mock: { apiKey: 'private-load-key', models: [{ id: 'mock' }] } } })
    );
    const measured = await runCli(['--reuse-stack']);
    assert.equal(measured.code, 0, measured.output);
    assert.equal(measured.run.status, 'completed');
    assert.deepEqual(
      measured.run.stages.map((s) => s.summary.acceptance),
      ['passed', 'failed']
    );
    assert.equal(measured.run.capacity[0].highestPassingConcurrency, 1);
    assert.ok(!JSON.stringify(measured.run).includes('private-load-key'));
    assert.ok(!measured.output.includes('private-load-key'));
    const interrupted = await runCli(['--reuse-stack'], { MOCK_INTERRUPT: '1' }, true);
    assert.equal(interrupted.code, 130, interrupted.output);
    assert.equal(interrupted.run.status, 'interrupted');
    assert.equal(interrupted.run.stages[0].status, 'interrupted');
    assert.equal(interrupted.run.stages[1].status, 'not-run');
    assert.ok(!(await readdir(path.join(directory, 'artifacts'))).includes('benchmark-run.lock'));
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
