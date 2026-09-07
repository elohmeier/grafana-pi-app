#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const protocols = { 'openai-completions': 'chat-completions', 'openai-responses': 'responses' };
const expandHome = (value) => (value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);

export function listModels(config) {
  if (!config?.providers || typeof config.providers !== 'object' || Array.isArray(config.providers)) {
    throw new Error('Expected a Pi models.json object with providers.');
  }
  return Object.entries(config.providers).flatMap(([provider, settings]) => {
    if (!settings || !Array.isArray(settings.models ?? [])) {
      throw new Error(`Invalid models array for provider ${provider}.`);
    }
    return (settings.models ?? []).map((model) => {
      if (typeof model?.id !== 'string' || !model.id.trim()) {
        throw new Error(`Missing model ID for provider ${provider}.`);
      }
      return { provider, settings, model };
    });
  });
}

export function selectModel(config, options) {
  const matches = listModels(config).filter(
    (entry) =>
      (!options.provider || entry.provider === options.provider) && (!options.model || entry.model.id === options.model)
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one model, found ${matches.length}. Use --list, then --provider and --model.`);
  }
  return matches[0];
}

export function modelConfiguration({ settings, model }, options = {}) {
  const api = model.api ?? settings.api;
  if (!Object.hasOwn(protocols, api)) {
    throw new Error('Only Pi openai-completions and openai-responses APIs are supported.');
  }
  const protocol = protocols[api];
  if (settings.oauth || Object.keys(settings.headers ?? {}).length || Object.keys(model.headers ?? {}).length) {
    throw new Error('This plugin cannot import Pi OAuth or custom headers. Use a provider with an API key.');
  }
  let url;
  try {
    url = new URL(options['base-url'] ?? settings.baseUrl);
  } catch {
    throw new Error('The provider needs a valid baseUrl, or supply --base-url.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('The base URL must use HTTP(S) without credentials, query parameters, or a fragment.');
  }
  // The local Grafana variants run in Docker; localhost inside Grafana is not the host.
  if (!options['base-url'] && ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname)) {
    url.hostname = 'host.docker.internal';
  }
  const compat = { ...settings.compat, ...model.compat };
  const thinkingFormat =
    options['thinking-format'] ?? (protocol === 'responses' ? 'openai' : (compat.thinkingFormat ?? 'openai'));
  if (!['openai', 'qwen', 'qwen-chat-template'].includes(thinkingFormat)) {
    throw new Error(
      `Pi thinking format ${thinkingFormat} is unsupported. Supply --thinking-format only if your endpoint supports it.`
    );
  }
  const reasoningEffortUnsupported =
    protocol === 'chat-completions' && thinkingFormat === 'openai' && compat.supportsReasoningEffort === false;
  const thinkingLevel = options.thinking ?? (model.reasoning && !reasoningEffortUnsupported ? 'medium' : 'off');
  if (!['off', 'low', 'medium', 'high'].includes(thinkingLevel)) {
    throw new Error('--thinking must be off, low, medium, or high.');
  }
  if (thinkingLevel !== 'off' && (model.reasoning === false || reasoningEffortUnsupported)) {
    throw new Error(
      'This Pi model does not support the requested reasoning setting. Use --thinking off or a supported --thinking-format.'
    );
  }
  const mappedLevel = model.thinkingLevelMap?.[thinkingLevel];
  if (mappedLevel === null || (mappedLevel !== undefined && mappedLevel !== thinkingLevel)) {
    throw new Error(
      `Pi thinking level ${thinkingLevel} is disabled or remapped; choose a directly supported --thinking level.`
    );
  }
  return {
    openAIBaseUrl: url.toString().replace(/\/+$/, ''),
    models: [{ id: model.id, name: model.name ?? model.id, default: true, protocol, thinkingLevel, thinkingFormat }],
    isOpenAIAPIKeySet: true,
  };
}

// Mirrors Pi's current config-value syntax. Plain uppercase strings are literals.
// Commands are trusted models.json entries, evaluated only when applying settings.
export function resolveApiKey(value, env = process.env) {
  if (typeof value !== 'string' || !value) {
    throw new Error('No API key in models.json. Use --api-key-env NAME for auth managed outside that file.');
  }
  if (value.startsWith('!')) {
    try {
      const key = execSync(value.slice(1), {
        env,
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (key) {
        return key;
      }
    } catch {
      // Never include a command, its output, or credentials in an error.
    }
    throw new Error('The Pi API key command failed or returned an empty value.');
  }
  const key = value.replace(/\$(\$|!|\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, (match, token) => {
    if (token === '$' || token === '!') {
      return token;
    }
    const name = token.startsWith('{') ? token.slice(1, -1) : token;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return match;
    }
    if (env[name] === undefined) {
      throw new Error(`Missing API key environment variable: ${name}`);
    }
    return env[name];
  });
  if (!key) {
    throw new Error('The Pi API key resolved to an empty value.');
  }
  return key;
}

export async function configureGrafana(grafanaUrl, pluginId, configuration, apiKey, env = process.env) {
  const endpoint = `${grafanaUrl.replace(/\/+$/, '')}/api/plugins/${encodeURIComponent(pluginId)}/settings`;
  const request = async (method, body) => {
    let response;
    try {
      response = await fetch(endpoint, {
        method,
        headers: {
          Authorization: env.GRAFANA_TOKEN
            ? `Bearer ${env.GRAFANA_TOKEN}`
            : `Basic ${Buffer.from(`${env.GRAFANA_USER ?? 'admin'}:${env.GRAFANA_PASSWORD ?? 'admin'}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch {
      throw new Error(`Grafana settings ${method} failed. Check GRAFANA_URL and connectivity.`);
    }
    if (!response.ok) {
      throw new Error(
        `Grafana settings ${method} failed (HTTP ${response.status}). Check the plugin ID and Grafana admin credentials.`
      );
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`Grafana settings ${method} returned invalid JSON.`);
    }
  };
  const current = await request('GET');
  await request('POST', {
    enabled: current.enabled,
    pinned: current.pinned,
    jsonData: { ...current.jsonData, ...configuration },
    secureJsonData: { openAIAPIKey: apiKey },
  });
  const saved = await request('GET');
  if (
    saved.jsonData?.openAIBaseUrl !== configuration.openAIBaseUrl ||
    !isDeepStrictEqual(saved.jsonData?.models, configuration.models)
  ) {
    throw new Error(
      'Grafana accepted the update, but the saved model settings differ. Read the plugin settings before retrying.'
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'models-file': { type: 'string' },
      'base-url': { type: 'string' },
      'api-key-env': { type: 'string' },
      thinking: { type: 'string' },
      'thinking-format': { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(`Usage: npm run dev:model -- --list
       npm run dev:model -- --provider NAME --model ID [--dry-run]

Reads ~/.pi/agent/models.json (or PI_CODING_AGENT_DIR/models.json).
Selects one default model, replacing Grafana's model list and shared endpoint/key.
Options: --models-file PATH, --thinking off|low|medium|high,
         --thinking-format openai|qwen|qwen-chat-template,
         --base-url URL (also disables Docker loopback rewriting), --api-key-env NAME.
Target: GRAFANA_URL=http://localhost:3001, E2E_PLUGIN_ID=grafana-assistant-app.
Auth: GRAFANA_USER/GRAFANA_PASSWORD (admin/admin), or GRAFANA_TOKEN.
Preview/list never resolve API keys, execute Pi key commands, or contact Grafana.
The model server must already be running; Grafana provisioning can overwrite this update on restart.`);
    return;
  }
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envPath)) {
    loadEnvFile(envPath);
  }
  const file = expandHome(
    values['models-file'] ?? path.join(expandHome(process.env.PI_CODING_AGENT_DIR ?? '~/.pi/agent'), 'models.json')
  );
  let config;
  try {
    config = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new Error(`Cannot read valid Pi model JSON from ${file}.`);
  }
  if (values.list || (!values.provider && !values.model)) {
    for (const { provider, settings, model } of listModels(config)) {
      console.log(
        `${provider}\t${model.id}\t${model.api ?? settings.api ?? 'unspecified API'}\t${model.name ?? model.id}`
      );
    }
    return;
  }
  const selected = selectModel(config, values);
  const configuration = modelConfiguration(selected, values);
  const grafanaUrl = process.env.GRAFANA_URL ?? 'http://localhost:3001';
  const pluginId = process.env.E2E_PLUGIN_ID ?? 'grafana-assistant-app';
  console.log(
    JSON.stringify(
      { provider: selected.provider, grafanaUrl, pluginId, ...configuration, apiKey: '(resolved only on apply)' },
      null,
      2
    )
  );
  if (values['dry-run']) {
    return;
  }
  let apiKey;
  if (values['api-key-env']) {
    apiKey = process.env[values['api-key-env']];
    if (!apiKey) {
      throw new Error(`Missing API key environment variable: ${values['api-key-env']}`);
    }
  } else {
    apiKey = resolveApiKey(selected.settings.apiKey);
  }
  await configureGrafana(grafanaUrl, pluginId, configuration, apiKey);
  console.log('Configured Grafana. Refresh the Assistant and start a new chat to use this default model.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
