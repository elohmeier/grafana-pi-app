import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { configureGrafana, listModels, modelConfiguration, resolveApiKey, selectModel } from './configure-pi-model.mjs';

const exec = promisify(execFile);
const model = { id: 'org/model:Q4', name: 'Local model', reasoning: true };
const settings = {
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:8080/v1',
  apiKey: 'test-key',
  models: [model],
};
const config = { providers: { local: settings } };

test('selects exact provider/model IDs and refuses ambiguous or unknown selections', () => {
  const multiple = { providers: { local: settings, second: settings, builtin: { modelOverrides: { other: {} } } } };
  assert.equal(listModels(multiple).length, 2);
  assert.equal(selectModel(multiple, { provider: 'second', model: model.id }).provider, 'second');
  assert.throws(() => selectModel(multiple, { model: model.id }), /found 2/);
  assert.throws(() => selectModel(config, { model: 'missing' }), /found 0/);
  assert.throws(() => listModels(null), /providers/);
  assert.throws(() => listModels({ providers: { bad: { models: [{}] } } }), /Missing model ID/);
});

test('maps protocols, Docker addresses and inherited thinking compatibility', () => {
  const selected = { settings: { ...settings, compat: { thinkingFormat: 'qwen' } }, model };
  const mapped = modelConfiguration(selected);
  assert.equal(mapped.openAIBaseUrl, 'http://host.docker.internal:8080/v1');
  assert.deepEqual(mapped.models[0], {
    id: model.id,
    name: model.name,
    default: true,
    protocol: 'chat-completions',
    thinkingLevel: 'medium',
    thinkingFormat: 'qwen',
  });
});

test('honors model API/compatibility overrides, exact URLs, and unsupported reasoning effort', () => {
  const provider = { ...settings, compat: { supportsReasoningEffort: false, thinkingFormat: 'qwen' } };
  const selected = { settings: provider, model: { ...model, compat: { thinkingFormat: 'openai' } } };
  assert.equal(modelConfiguration(selected).models[0].thinkingLevel, 'off');
  assert.throws(() => modelConfiguration(selected, { thinking: 'high' }), /does not support/);
  const responses = modelConfiguration(
    { ...selected, model: { ...model, api: 'openai-responses' } },
    { 'base-url': 'http://localhost:9090/v1/', thinking: 'high' }
  );
  assert.equal(responses.openAIBaseUrl, 'http://localhost:9090/v1');
  assert.equal(responses.models[0].protocol, 'responses');
  assert.equal(responses.models[0].thinkingFormat, 'openai');
  assert.equal(responses.models[0].thinkingLevel, 'high');
  assert.equal(
    modelConfiguration({ settings: { ...settings, baseUrl: 'http://[::1]:8080/v1' }, model }).openAIBaseUrl,
    'http://host.docker.internal:8080/v1'
  );
});

test('rejects incompatible transports, headers, thinking mappings and secret-bearing URLs', () => {
  for (const changes of [
    { api: 'anthropic-messages' },
    { api: 'toString' },
    { headers: { 'x-secret': 'secret' } },
    { oauth: 'radius' },
    { baseUrl: 'https://user:secret@example.test/v1' },
    { baseUrl: 'https://example.test/v1?key=secret' },
    { compat: { thinkingFormat: 'deepseek' } },
  ]) {
    assert.throws(() => modelConfiguration({ settings: { ...settings, ...changes }, model }));
  }
  assert.throws(
    () => modelConfiguration({ settings, model: { ...model, thinkingLevelMap: { medium: 'high' } } }),
    /remapped/
  );
  assert.throws(
    () => modelConfiguration({ settings, model: { ...model, thinkingLevelMap: { off: null } } }, { thinking: 'off' }),
    /disabled/
  );
  assert.equal(modelConfiguration({ settings, model }, { thinking: 'xhigh' }).models[0].thinkingLevel, 'xhigh');
});

test('resolves Pi literals, interpolation, escapes and commands without exposing failed commands', () => {
  assert.equal(resolveApiKey('MY_KEY', { MY_KEY: 'secret' }), 'MY_KEY');
  assert.equal(resolveApiKey('${PREFIX}_$KEY', { PREFIX: 'prefix', KEY: 'secret' }), 'prefix_secret');
  assert.equal(resolveApiKey('$$KEY-$!literal-${NOT-VALID}', {}), '$KEY-!literal-${NOT-VALID}');
  assert.equal(resolveApiKey('!printf test-secret'), 'test-secret');
  assert.throws(() => resolveApiKey('$MISSING', {}), /Missing API key environment variable: MISSING/);
  assert.throws(() => resolveApiKey('${EMPTY}', { EMPTY: '' }), /empty value/);
  assert.throws(
    () => resolveApiKey('!printf private-output; exit 1'),
    (error) => !/private-output|printf/.test(error.message)
  );
  assert.throws(() => resolveApiKey(undefined), /No API key/);
});

test('updates only model settings, posts the key securely, verifies reordered JSON, and reports HTTP failures', async (t) => {
  let state = {
    enabled: true,
    pinned: false,
    jsonData: { customSkills: [{ name: 'keep' }], accessMode: 'admins', models: [{ id: 'old' }] },
  };
  let posted;
  let fail = false;
  const calls = [];
  const server = createServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (fail) {
      res.writeHead(403).end(JSON.stringify({ message: 'private-server-detail' }));
      return;
    }
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      posted = JSON.parse(Buffer.concat(chunks).toString());
      state = { ...posted, secureJsonData: undefined };
      state.jsonData.models = state.jsonData.models.map((entry) => Object.fromEntries(Object.entries(entry).sort()));
      res.end('{}');
    } else {
      res.end(JSON.stringify(state));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  await configureGrafana(url, 'grafana-assistant-app', modelConfiguration({ settings, model }), 'private-key', {
    GRAFANA_TOKEN: 'test-token',
  });
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET', 'POST', 'GET']
  );
  assert.ok(
    calls.every(
      (call) => call.url === '/api/plugins/grafana-assistant-app/settings' && call.authorization === 'Bearer test-token'
    )
  );
  assert.equal(posted.enabled, true);
  assert.equal(posted.pinned, false);
  assert.deepEqual(posted.jsonData.customSkills, [{ name: 'keep' }]);
  assert.equal(posted.jsonData.accessMode, 'admins');
  assert.equal(posted.jsonData.models.length, 1);
  assert.deepEqual(posted.secureJsonData, { openAIAPIKey: 'private-key' });
  assert.ok(!JSON.stringify(posted.jsonData).includes('private-key'));
  fail = true;
  await assert.rejects(
    configureGrafana(url, 'grafana-assistant-app', {}, 'private-key', {}),
    (error) => /HTTP 403/.test(error.message) && !/private-server-detail/.test(error.message)
  );
});

test('CLI list and dry-run read PI_CODING_AGENT_DIR without executing key commands or contacting Grafana', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-model-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = { providers: { local: { ...settings, apiKey: '!touch key-command-ran' } } };
  const file = path.join(directory, 'models.json');
  await writeFile(file, JSON.stringify(fixture));
  const env = { ...process.env, PI_CODING_AGENT_DIR: directory, GRAFANA_URL: 'http://127.0.0.1:1' };
  const script = new URL('./configure-pi-model.mjs', import.meta.url).pathname;
  const listing = await exec(process.execPath, [script, '--list'], { env, cwd: directory });
  assert.match(listing.stdout, /org\/model:Q4/);
  const preview = await exec(process.execPath, [script, '--provider', 'local', '--dry-run'], { env, cwd: directory });
  assert.equal(JSON.parse(preview.stdout).models[0].id, model.id);
  assert.ok(!preview.stdout.includes('touch'));
  await assert.rejects(readFile(path.join(directory, 'key-command-ran')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), fixture);
});

test('CLI configures Azure v1 deployment IDs with inherited Responses and per-model Chat Completions', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-azure-model-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseUrl = 'https://test-resource.openai.azure.com/openai/v1';
  const apiKey = 'azure-test-key-not-a-credential';
  const fixture = {
    providers: {
      'azure': {
        baseUrl,
        apiKey,
        api: 'openai-responses',
        models: [
          { id: 'gpt-5.6-terra-grafana', reasoning: true },
          { id: 'gpt-5.6-luna-grafana', reasoning: true },
          { id: 'gpt-5.1-grafana', api: 'openai-completions', reasoning: true },
        ],
      },
    },
  };
  const file = path.join(directory, 'models.json');
  await writeFile(file, JSON.stringify(fixture));
  let state = { enabled: true, pinned: true, jsonData: { systemPromptAddendum: 'Keep existing instructions' } };
  const updates = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const update = JSON.parse(Buffer.concat(chunks).toString());
      updates.push(update);
      const { secureJsonData, ...publicSettings } = update;
      state = publicSettings;
      res.end('{}');
    } else {
      res.end(JSON.stringify(state));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    ...process.env,
    GRAFANA_URL: `http://127.0.0.1:${server.address().port}`,
    E2E_PLUGIN_ID: 'grafana-assistant-app',
  };
  for (const [id, protocol] of [
    ['gpt-5.6-terra-grafana', 'responses'],
    ['gpt-5.6-luna-grafana', 'responses'],
    ['gpt-5.1-grafana', 'chat-completions'],
  ]) {
    const result = await exec(
      process.execPath,
      [
        new URL('./configure-pi-model.mjs', import.meta.url).pathname,
        '--models-file',
        file,
        '--provider',
        'azure',
        '--model',
        id,
      ],
      { env }
    );
    const update = updates.at(-1);
    assert.match(result.stdout, /Configured Grafana/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(apiKey));
    assert.equal(update.jsonData.openAIBaseUrl, baseUrl);
    assert.deepEqual(update.jsonData.models, [
      { id, name: id, default: true, protocol, thinkingLevel: 'medium', thinkingFormat: 'openai' },
    ]);
    assert.equal(update.jsonData.systemPromptAddendum, 'Keep existing instructions');
    assert.deepEqual(update.secureJsonData, { openAIAPIKey: apiKey });
    assert.ok(!JSON.stringify(update.jsonData).includes(apiKey));
  }
  assert.equal(updates.length, 3);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), fixture);
});
