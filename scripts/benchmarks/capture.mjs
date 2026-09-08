// Serialized into every browser frame by Playwright. Keep this function self-contained.
export function installLLMCapture() {
  if (window.__PI_COMPARISON_INSTALLED__) {
    return;
  }
  window.__PI_COMPARISON_INSTALLED__ = true;
  window.__PI_AGENT_BENCHMARK_CAPTURE__ = true;
  const originalFetch = window.fetch.bind(window);
  const pending = new Set();
  window.__PI_COMPARISON_FLUSH__ = () => Promise.allSettled([...pending]);

  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!new URL(url, location.href).pathname.endsWith('/resources/llm/api/stream')) {
      return originalFetch(input, init);
    }
    const started = performance.now();
    const record = { id: crypto.randomUUID(), startedAt: Date.now(), state: 'running' };
    const emit = () => window.__PI_COMPARISON_REQUEST__({ ...record }).catch(() => {});
    try {
      const payload = JSON.parse(typeof init?.body === 'string' ? init.body : await input.clone().text());
      record.model = payload.model?.id;
      record.api = payload.model?.api;
      record.reasoning = payload.options?.reasoning ?? 'off';
      record.temperature = payload.options?.temperature ?? null;
      record.maxTokens = payload.options?.maxTokens ?? null;
      record.modelMaxTokens = payload.model?.maxTokens ?? null;
    } catch {
      record.requestMetadataUnavailable = true;
    }
    void emit();
    let response;
    try {
      response = await originalFetch(input, init);
    } catch (error) {
      record.state = 'failed';
      record.error = error.name;
      record.durationMs = performance.now() - started;
      await emit();
      throw error;
    }
    record.httpStatus = response.status;
    record.headersMs = performance.now() - started;
    const observe = async () => {
      try {
        const reader = response.clone().body?.getReader();
        if (!reader) {
          throw new Error('Missing response body');
        }
        const decoder = new TextDecoder();
        let buffer = '';
        let dataLines = [];
        const dispatch = () => {
          if (!dataLines.length) {
            return;
          }
          const data = dataLines.join('\n');
          dataLines = [];
          if (data === '[DONE]') {
            return;
          }
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            record.parseErrors = (record.parseErrors ?? 0) + 1;
            return;
          }
          const elapsed = performance.now() - started;
          if (['text_delta', 'thinking_delta', 'toolcall_delta'].includes(event.type) && event.delta) {
            record.firstContentMs ??= elapsed;
          }
          if (event.type === 'text_delta' && event.delta) {
            record.firstTextMs ??= elapsed;
          }
          if (event.type === 'thinking_delta' && event.delta) {
            record.firstThinkingMs ??= elapsed;
          }
          if (event.type === 'done' || event.type === 'error') {
            record.state = event.type === 'done' ? 'completed' : 'failed';
            record.stopReason = event.reason;
            record.usage = event.usage ?? null;
            record.durationMs = elapsed;
            if (event.type === 'error') {
              record.error = event.errorMessage ?? 'Upstream stream error';
              record.upstreamStatus = event.upstreamStatus ?? null;
            }
            // Preserve usage even if the stream is aborted after its terminal event.
            void emit();
          }
        };
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          record.firstByteMs ??= performance.now() - started;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const raw of lines) {
            const line = raw.replace(/\r$/, '');
            if (line === '') {
              dispatch();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
        }
        if (buffer.startsWith('data:')) {
          dataLines.push(buffer.slice(5).trim());
        }
        dispatch();
        if (record.state === 'running') {
          record.state = 'failed';
          record.error = response.ok ? 'Stream ended without a terminal event' : `HTTP ${response.status}`;
        }
      } catch (error) {
        if (record.state === 'running') {
          record.state = 'failed';
          record.error = error.name;
        }
      } finally {
        record.durationMs ??= performance.now() - started;
        await emit();
      }
    };
    const task = observe();
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return response;
  };
}

export function checkModelSettings(settings, expected) {
  const actual = settings.jsonData;
  const models = actual?.models ?? [];
  const model = models.find((entry) => entry.default) ?? models[0];
  const mismatches = [];
  if (actual?.openAIBaseUrl?.replace(/\/$/, '') !== expected.baseUrl.replace(/\/$/, '')) {
    mismatches.push('baseUrl');
  }
  for (const field of ['id', 'protocol', 'thinkingLevel', 'thinkingFormat']) {
    if (model?.[field] !== expected[field]) {
      mismatches.push(field);
    }
  }
  if (mismatches.length) {
    throw new Error(
      `Benchmark model configuration mismatch: ${mismatches.join(', ')}. Run with --prepare or configure the plugin to match the profile.`
    );
  }
  return { baseUrl: actual.openAIBaseUrl, model };
}
