import { modelConfiguration, piModelsFile, readPiModels, resolveApiKey, selectModel } from '../configure-pi-model.mjs';
import { validateConfig } from './core.mjs';

export function createProfile(selected, options = {}, env = process.env) {
  const configuration = modelConfiguration(selected, options);
  const { id, protocol, thinkingLevel, thinkingFormat } = configuration.models[0];
  const profile = {
    label: options.label ?? `${selected.provider}-${id}-${thinkingLevel}`,
    model: {
      id,
      provider: selected.provider,
      baseUrl: configuration.openAIBaseUrl,
      protocol,
      thinkingLevel,
      thinkingFormat,
    },
    hosting: {
      label: options['hosting-label'] ?? selected.provider,
      region: options.region ?? 'unknown',
      serviceTier: options['service-tier'] ?? 'unknown',
    },
    ...(options['api-key-env'] !== undefined
      ? { apiKeyEnv: options['api-key-env'] }
      : { apiKeyPi: piModelsFile(options['models-file'], env) }),
    repetitions: options.repetitions === undefined ? 1 : Number(options.repetitions),
    notes: options.notes ?? 'Cache state uncontrolled. No excluded warmup.',
    ...(options.suites === undefined ? {} : { suites: options.suites.split(',').map((suite) => suite.trim()) }),
  };
  validateConfig(profile);
  return profile;
}

export async function resolveBenchmarkApiKey(config, env = process.env) {
  if (config.apiKeyEnv) {
    const key = env[config.apiKeyEnv];
    if (!key) {
      throw new Error(`Missing API key environment variable: ${config.apiKeyEnv}`);
    }
    return key;
  }
  if (config.apiKeyPi) {
    const selected = selectModel(await readPiModels(config.apiKeyPi, env), {
      provider: config.model.provider,
      model: config.model.id,
    });
    return resolveApiKey(selected.settings.apiKey, env);
  }
  return undefined;
}
