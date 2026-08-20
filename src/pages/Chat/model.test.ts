import {
  createOpenAICompatibleModel,
  getConfiguredModels,
  getDefaultConfiguredModel,
  resolveConfiguredModel,
} from './model';

describe('getConfiguredModels', () => {
  it('trims, dedupes, and normalizes model entries', () => {
    const models = getConfiguredModels({
      models: [
        { id: ' gpt-4.1 ', name: ' GPT-4.1 ', thinkingLevel: 'minimal' as any, thinkingFormat: 'deepseek' as any },
        { id: 'gpt-4.1' },
        { id: '' },
        { id: 'qwen', default: true, protocol: 'responses', thinkingLevel: 'medium' },
      ],
    });

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      default: false,
      protocol: 'auto',
      thinkingLevel: 'off',
      thinkingFormat: 'openai',
    });
    expect(models[1]).toMatchObject({ id: 'qwen', name: 'qwen', default: true, protocol: 'responses' });
  });

  it('makes the first model default when none is flagged', () => {
    const models = getConfiguredModels({ models: [{ id: 'model-a' }, { id: 'model-b' }] });

    expect(models[0].default).toBe(true);
    expect(models[1].default).toBe(false);
    expect(getDefaultConfiguredModel({ models: [{ id: 'model-a' }, { id: 'model-b' }] })?.id).toBe('model-a');
  });

  it('returns an empty list without configured models', () => {
    expect(getConfiguredModels()).toEqual([]);
    expect(getDefaultConfiguredModel({})).toBeUndefined();
  });
});

describe('resolveConfiguredModel', () => {
  const jsonData = { models: [{ id: 'model-a' }, { id: 'model-b', default: true }] };

  it('resolves a configured model by ID', () => {
    expect(resolveConfiguredModel(jsonData, 'model-a')?.id).toBe('model-a');
  });

  it('falls back to the default model for missing or unknown IDs', () => {
    expect(resolveConfiguredModel(jsonData)?.id).toBe('model-b');
    expect(resolveConfiguredModel(jsonData, 'removed-model')?.id).toBe('model-b');
  });
});

describe('createOpenAICompatibleModel', () => {
  it('keeps reasoning disabled by default', () => {
    const [configured] = getConfiguredModels({ models: [{ id: 'gpt-4.1' }] });
    const model = createOpenAICompatibleModel({}, configured);

    expect(model.reasoning).toBe(false);
    expect(model.api).toBe('openai-completions');
    if (model.api !== 'openai-completions') {
      throw new Error('expected Chat Completions model');
    }
    expect(model.compat?.thinkingFormat).toBe('openai');
    expect(model.compat?.supportsReasoningEffort).toBe(true);
  });

  it('enables OpenAI-compatible reasoning metadata when configured', () => {
    const [configured] = getConfiguredModels({
      models: [{ id: 'gpt-4.1', thinkingLevel: 'medium', thinkingFormat: 'openai' }],
    });
    const model = createOpenAICompatibleModel({}, configured);

    expect(model.reasoning).toBe(true);
    if (model.api !== 'openai-completions') {
      throw new Error('expected Chat Completions model');
    }
    expect(model.thinkingLevelMap?.medium).toBe('medium');
    expect(model.compat?.thinkingFormat).toBe('openai');
    expect(model.compat?.supportsReasoningEffort).toBe(true);
  });

  it('uses qwen chat template compatibility without reasoning_effort support', () => {
    const [configured] = getConfiguredModels({
      models: [{ id: 'qwen', thinkingLevel: 'high', thinkingFormat: 'qwen-chat-template' }],
    });
    const model = createOpenAICompatibleModel({}, configured);

    expect(model.reasoning).toBe(true);
    if (model.api !== 'openai-completions') {
      throw new Error('expected Chat Completions model');
    }
    expect(model.compat?.thinkingFormat).toBe('qwen-chat-template');
    expect(model.compat?.supportsReasoningEffort).toBe(false);
  });

  it('declares a Responses model when the per-model protocol is explicit', () => {
    const [configured] = getConfiguredModels({
      models: [{ id: 'gpt-4.1', protocol: 'responses', thinkingLevel: 'medium' }],
    });
    const model = createOpenAICompatibleModel({}, configured);

    expect(model.api).toBe('openai-responses');
    expect(model.reasoning).toBe(true);
    if (model.api !== 'openai-responses') {
      throw new Error('expected Responses model');
    }
    expect(model.compat?.sendSessionIdHeader).toBe(false);
  });

  it('uses the configured display name and base URL', () => {
    const [configured] = getConfiguredModels({ models: [{ id: 'gpt-4.1', name: 'Fast model' }] });
    const model = createOpenAICompatibleModel({ openAIBaseUrl: 'http://llm.local/v1' }, configured);

    expect(model.id).toBe('gpt-4.1');
    expect(model.name).toBe('Fast model');
    expect(model.baseUrl).toBe('http://llm.local/v1');
  });
});
