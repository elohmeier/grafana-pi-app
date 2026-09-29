import type { Model } from '@earendil-works/pi-ai';
import type { PiAppJsonData, PiAppOpenAIProtocol, PiAppThinkingFormat, PiAppThinkingLevel } from '../../types';

export type { PiAppJsonData, PiAppThinkingLevel } from '../../types';

export const DEFAULT_THINKING_LEVEL: PiAppThinkingLevel = 'off';
export const DEFAULT_THINKING_FORMAT: PiAppThinkingFormat = 'openai';
export const DEFAULT_OPENAI_PROTOCOL: PiAppOpenAIProtocol = 'auto';
// Mirror the backend normalizeModelLimits defaults and bounds.
export const DEFAULT_CONTEXT_WINDOW = 131072;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
const MIN_CONTEXT_WINDOW = 4096;
const MAX_CONTEXT_WINDOW = 10_000_000;
const MIN_MAX_OUTPUT_TOKENS = 256;

export type ConfiguredModel = {
  id: string;
  name: string;
  default: boolean;
  protocol: PiAppOpenAIProtocol;
  thinkingLevel: PiAppThinkingLevel;
  thinkingFormat: PiAppThinkingFormat;
  contextWindow: number;
  maxOutputTokens: number;
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
      ...normalizeModelLimits(model?.contextWindow, model?.maxOutputTokens),
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
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
});

export function getActiveModel(jsonData: Pick<PiAppJsonData, 'models'> | undefined, modelId?: string): ConfiguredModel {
  return resolveConfiguredModel(jsonData, modelId) ?? UNCONFIGURED_MODEL;
}

/**
 * Resolves a chat's model choice against the configuration. Formats with
 * binary thinking only switch the configured level on or off.
 */
export function resolveChatModelSettings(
  jsonData: Pick<PiAppJsonData, 'models' | 'openAIBaseUrl'> | undefined,
  selection: { modelId?: string; thinkingLevel?: PiAppThinkingLevel }
) {
  const activeModel = getActiveModel(jsonData, selection.modelId);
  const canCustomizeThinking = activeModel.thinkingLevel !== 'off';
  const usesBinaryThinking =
    activeModel.protocol !== 'responses' && ['qwen', 'qwen-chat-template'].includes(activeModel.thinkingFormat);
  const thinkingLevel: PiAppThinkingLevel = !canCustomizeThinking
    ? 'off'
    : usesBinaryThinking
      ? selection.thinkingLevel === 'off'
        ? 'off'
        : activeModel.thinkingLevel
      : (selection.thinkingLevel ?? activeModel.thinkingLevel);
  return {
    activeModel,
    model: createOpenAICompatibleModel(jsonData, activeModel),
    thinkingLevel,
    canCustomizeThinking,
    usesBinaryThinking,
  };
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
      xhigh: 'xhigh',
    },
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: configured.contextWindow,
    maxTokens: configured.maxOutputTokens,
  };

  if (configured.protocol === 'responses') {
    return {
      ...base,
      api: 'openai-responses',
      compat: {
        sessionAffinityFormat: 'openai-nosession',
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
      supportsReasoningEffort: ['openai', 'deepseek'].includes(configured.thinkingFormat),
      ...(configured.thinkingFormat === 'deepseek'
        ? {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsStrictMode: false,
            requiresReasoningContentOnAssistantMessages: true,
          }
        : {}),
      thinkingFormat: configured.thinkingFormat,
    },
  };
}

export function normalizeOpenAIProtocol(value?: string): PiAppOpenAIProtocol {
  return value === 'chat-completions' || value === 'responses' ? value : DEFAULT_OPENAI_PROTOCOL;
}

export function normalizeThinkingLevel(value?: string): PiAppThinkingLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
    ? value
    : DEFAULT_THINKING_LEVEL;
}

export function normalizeThinkingFormat(value?: string): PiAppThinkingFormat {
  return value === 'qwen' || value === 'qwen-chat-template' || value === 'deepseek' ? value : DEFAULT_THINKING_FORMAT;
}

export function normalizeModelLimits(
  contextWindow?: number | string,
  maxOutputTokens?: number | string
): { contextWindow: number; maxOutputTokens: number } {
  const window = clampInt(positiveInt(contextWindow) ?? DEFAULT_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW);
  const output = clampInt(
    positiveInt(maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS,
    MIN_MAX_OUTPUT_TOKENS,
    Math.floor(window / 2)
  );
  return { contextWindow: window, maxOutputTokens: output };
}

function positiveInt(value: number | string | undefined) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function clampInt(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
