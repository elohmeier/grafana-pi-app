import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { selectModel } from '../configure-pi-model.mjs';
import { validateConfig } from './core.mjs';
import { createProfile, resolveBenchmarkApiKey } from './profile.mjs';

const exec = promisify(execFile);
const config = {
  providers: {
    azure: {
      api: 'openai-responses',
      baseUrl: 'https://example.test/openai/v1',
      apiKey: '!touch key-command-ran',
      models: [
        { id: 'sol', reasoning: true },
        { id: 'qwen/model:27b', api: 'openai-completions', reasoning: true },
      ],
    },
  },
};

test('creates runnable profiles from inherited and overridden Pi settings without copying credentials', () => {
  for (const [id, protocol] of [
    ['sol', 'responses'],
    ['qwen/model:27b', 'chat-completions'],
  ]) {
    const profile = createProfile(selectModel(config, { model: id }), {}, {});
    assert.deepEqual(profile.model, {
      id,
      provider: 'azure',
      baseUrl: 'https://example.test/openai/v1',
      protocol,
      thinkingLevel: 'medium',
      thinkingFormat: 'openai',
    });
    assert.equal(profile.apiKeyPi, '~/.pi/agent/models.json');
    assert.deepEqual(profile.hosting, { label: 'azure', region: 'unknown', serviceTier: 'unknown' });
    assert.equal(profile.repetitions, 1);
    assert.equal(validateConfig(profile).suites.length, 12);
    assert.ok(!JSON.stringify(profile).includes('touch'));
  }
  const profile = createProfile(selectModel(config, { model: 'sol' }), {
    thinking: 'high',
    label: 'smoke',
    region: 'westeurope',
    'service-tier': 'standard',
    'hosting-label': 'azure-west',
    'api-key-env': 'BENCHMARK_TEST_KEY',
    repetitions: '3',
    suites: 'agent, analysis',
    notes: 'Test notes.',
  });
  assert.equal(profile.model.thinkingLevel, 'high');
  assert.equal(profile.label, 'smoke');
  assert.deepEqual(profile.hosting, { label: 'azure-west', region: 'westeurope', serviceTier: 'standard' });
  assert.equal(profile.apiKeyEnv, 'BENCHMARK_TEST_KEY');
  assert.equal(profile.apiKeyPi, undefined);
  assert.equal(profile.repetitions, 3);
  assert.deepEqual(profile.suites, ['agent', 'analysis']);
  assert.equal(profile.notes, 'Test notes.');
});

test('profile generation preserves Docker mapping, compatibility checks, and workload validation', () => {
  const selected = {
    provider: 'local',
    settings: { api: 'openai-completions', baseUrl: 'http://localhost:8080/v1', compat: { thinkingFormat: 'qwen' } },
    model: { id: 'local', reasoning: true },
  };
  const profile = createProfile(selected);
  assert.equal(profile.model.baseUrl, 'http://host.docker.internal:8080/v1');
  assert.equal(profile.model.thinkingFormat, 'qwen');
  assert.equal(
    createProfile(selected, { 'base-url': 'http://localhost:9090/v1' }).model.baseUrl,
    'http://localhost:9090/v1'
  );
  for (const options of [
    { thinking: 'xhigh' },
    { repetitions: '0' },
    { repetitions: '1.2' },
    { repetitions: 'NaN' },
    { suites: 'missing' },
    { suites: 'agent,agent' },
    { 'api-key-env': '' },
    { 'api-key-env': 'invalid-name' },
  ]) {
    assert.throws(() => createProfile(selected, options));
  }
  assert.throws(() =>
    createProfile({ ...selected, model: { ...selected.model, reasoning: false } }, { thinking: 'high' })
  );
  assert.throws(() => validateConfig({ ...profile, apiKeyEnv: 'KEY' }), /either apiKeyEnv or apiKeyPi/);
  for (const apiKeyPi of ['', true, {}]) {
    assert.throws(() => validateConfig({ ...profile, apiKeyPi }), /apiKeyPi/);
  }
});

test('CLI lists, previews and creates one profile without contacting Grafana or resolving Pi key commands', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-benchmark-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'models.json');
  await writeFile(file, JSON.stringify(config));
  const env = { ...process.env, PI_CODING_AGENT_DIR: directory, GRAFANA_URL: 'http://127.0.0.1:1' };
  const script = new URL('../benchmark-profile.mjs', import.meta.url).pathname;
  const run = (args) => exec(process.execPath, [script, ...args], { cwd: directory, env });
  assert.match((await run(['--list'])).stdout, /azure\tsol\topenai-responses/);
  await assert.rejects(run(['--provider', 'azure']), /found 2/);
  const preview = JSON.parse((await run(['--model', 'sol', '--dry-run'])).stdout);
  assert.equal(preview.apiKeyPi, file);
  assert.equal(preview.model.protocol, 'responses');
  assert.deepEqual(await readdir(directory), ['models.json']);
  const args = ['--model', 'qwen/model:27b', '--region', 'westeurope'];
  const created = await run(args);
  const output = path.join(directory, 'benchmarks/azure-qwen-model-27b-medium.json');
  const saved = await readFile(output, 'utf8');
  assert.equal(validateConfig(JSON.parse(saved)).model.id, 'qwen/model:27b');
  assert.equal(JSON.parse(saved).hosting.region, 'westeurope');
  assert.match(created.stdout, /npm run benchmark:run/);
  await assert.rejects(run(args), /already exists/);
  assert.equal(await readFile(output, 'utf8'), saved);
  await assert.rejects(readFile(path.join(directory, 'key-command-ran')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), config);
  await run([
    '--model',
    'sol',
    '--models-file',
    'models.json',
    '--output',
    'custom/sol.json',
    '--api-key-env',
    'TEST_KEY',
  ]);
  const external = JSON.parse(await readFile(path.join(directory, 'custom/sol.json'), 'utf8'));
  assert.equal(external.apiKeyEnv, 'TEST_KEY');
  assert.equal(external.apiKeyPi, undefined);
});

test('resolves the selected Pi provider key at execution time and supports the environment override', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-benchmark-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'models.json');
  const models = structuredClone(config);
  models.providers.azure.apiKey = '${TEST_KEY}';
  await writeFile(file, JSON.stringify(models));
  const profile = createProfile(selectModel(models, { model: 'sol' }), { 'models-file': file });
  assert.equal(await resolveBenchmarkApiKey(profile, { TEST_KEY: 'first-key' }), 'first-key');
  models.providers.azure.apiKey = 'rotated-key';
  await writeFile(file, JSON.stringify(models));
  assert.equal(await resolveBenchmarkApiKey(profile, {}), 'rotated-key');
  await assert.rejects(resolveBenchmarkApiKey({ ...profile, model: { ...profile.model, id: 'removed' } }), /found 0/);
  await assert.rejects(
    resolveBenchmarkApiKey({ apiKeyEnv: 'MISSING_KEY' }, {}),
    /Missing API key environment variable/
  );
  assert.equal(await resolveBenchmarkApiKey({ apiKeyEnv: 'TEST_KEY' }, { TEST_KEY: 'override' }), 'override');
  assert.equal(await resolveBenchmarkApiKey({}, {}), undefined);
});
