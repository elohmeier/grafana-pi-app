import type { Model } from '@earendil-works/pi-ai';
import type { PiAppJsonData, PiAppOpenAIProtocol, PiAppThinkingFormat, PiAppThinkingLevel } from '../../types';

export type { PiAppJsonData, PiAppThinkingLevel } from '../../types';

export const DEFAULT_THINKING_LEVEL: PiAppThinkingLevel = 'off';
export const DEFAULT_THINKING_FORMAT: PiAppThinkingFormat = 'openai';
export const DEFAULT_OPENAI_PROTOCOL: PiAppOpenAIProtocol = 'auto';

export type ConfiguredModel = {
  id: string;
  name: string;
  default: boolean;
  protocol: PiAppOpenAIProtocol;
  thinkingLevel: PiAppThinkingLevel;
  thinkingFormat: PiAppThinkingFormat;
};

// Mirrors the backend normalizeModels rules: trim and dedupe by ID, normalize
// per-model settings, and force exactly one default entry.
export function getConfiguredModels(jsonData?: Pick<PiAppJsonData, 'models'>): ConfiguredModel[] {
  const models: ConfiguredModel[] = [];
  const seen = new Set<string>();
  let defaultIndex = -1;
  for (const model of jsonData?.models ?? []) {
    const id = (model?.id ?? '').trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (model?.default && defaultIndex === -1) {
      defaultIndex = models.length;
    }
    models.push({
      id,
      name: (model?.name ?? '').trim() || id,
      default: false,
      protocol: normalizeOpenAIProtocol(model?.protocol),
      thinkingLevel: normalizeThinkingLevel(model?.thinkingLevel),
      thinkingFormat: normalizeThinkingFormat(model?.thinkingFormat),
    });
  }
  if (models.length > 0) {
    models[defaultIndex === -1 ? 0 : defaultIndex].default = true;
  }
  return models;
}

export function getDefaultConfiguredModel(jsonData?: Pick<PiAppJsonData, 'models'>): ConfiguredModel | undefined {
  return getConfiguredModels(jsonData).find((model) => model.default);
}

// Resolves a stored or requested model ID against the configured list, falling
// back to the default model when the ID is missing or no longer configured.
export function resolveConfiguredModel(
  jsonData: Pick<PiAppJsonData, 'models'> | undefined,
  modelId?: string
): ConfiguredModel | undefined {
  const models = getConfiguredModels(jsonData);
  const id = (modelId ?? '').trim();
  if (id) {
    const match = models.find((model) => model.id === id);
    if (match) {
      return match;
    }
  }
  return models.find((model) => model.default);
}

// Placeholder used when no models are configured yet; the chat composer is
// disabled in that state, and the backend rejects requests without models.
const UNCONFIGURED_MODEL: ConfiguredModel = Object.freeze({
  id: '',
  name: 'No model configured',
  default: false,
  protocol: DEFAULT_OPENAI_PROTOCOL,
  thinkingLevel: DEFAULT_THINKING_LEVEL,
  thinkingFormat: DEFAULT_THINKING_FORMAT,
});

export function getActiveModel(jsonData: Pick<PiAppJsonData, 'models'> | undefined, modelId?: string): ConfiguredModel {
  return resolveConfiguredModel(jsonData, modelId) ?? UNCONFIGURED_MODEL;
}

export function createOpenAICompatibleModel(
  jsonData: Pick<PiAppJsonData, 'openAIBaseUrl'> | undefined,
  configured: ConfiguredModel
): Model<'openai-completions'> | Model<'openai-responses'> {
  const base: Omit<Model<'openai-completions'>, 'api' | 'compat'> = {
    id: configured.id,
    name: configured.name,
    provider: 'openai-compatible',
    baseUrl: jsonData?.openAIBaseUrl || 'https://api.openai.com/v1',
    reasoning: configured.thinkingLevel !== 'off',
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
    },
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 4096,
  };

  if (configured.protocol === 'responses') {
    return {
      ...base,
      api: 'openai-responses',
      compat: {
        sendSessionIdHeader: false,
        supportsLongCacheRetention: false,
      },
    };
  }

  return {
    ...base,
    api: 'openai-completions',
    compat: {
      supportsUsageInStreaming: true,
      maxTokensField: 'max_tokens',
      supportsReasoningEffort: configured.thinkingFormat === 'openai',
      thinkingFormat: configured.thinkingFormat,
    },
  };
}

export function normalizeOpenAIProtocol(value?: string): PiAppOpenAIProtocol {
  return value === 'chat-completions' || value === 'responses' ? value : DEFAULT_OPENAI_PROTOCOL;
}

export function normalizeThinkingLevel(value?: string): PiAppThinkingLevel {
  return value === 'low' || value === 'medium' || value === 'high' ? value : DEFAULT_THINKING_LEVEL;
}

export function normalizeThinkingFormat(value?: string): PiAppThinkingFormat {
  return value === 'qwen' || value === 'qwen-chat-template' ? value : DEFAULT_THINKING_FORMAT;
}
