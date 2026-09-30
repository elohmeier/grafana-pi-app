import type { ProxyStreamOptions, StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createGrafanaStreamFn } from './grafanaStream';

const model = { id: 'm', api: 'openai-completions', provider: 'openai', maxTokens: 1000 } as never;

function message(stopReason: AssistantMessage['stopReason'], errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant',
    content: stopReason === 'stop' ? [{ type: 'text', text: 'hi' }] : [],
    api: 'openai-completions',
    provider: 'openai',
    model: 'm',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 0,
  } as AssistantMessage;
}

/** A proxy stream that answers with the scripted outcomes in order, like streamProxy does. */
function scripted(outcomes: Array<'ok' | string>) {
  const calls: Array<Record<string, unknown>> = [];
  const stream = (_model: unknown, _context: unknown, options: ProxyStreamOptions) => {
    calls.push({ ...options });
    const outcome = outcomes[calls.length - 1];
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (outcome === 'ok') {
        const done = message('stop');
        events.push({ type: 'start', partial: done });
        events.push({ type: 'done', reason: 'stop', message: done });
        events.end(done);
      } else {
        const failed = message('error', outcome);
        events.push({ type: 'error', reason: 'error', error: failed });
        events.end(failed);
      }
    });
    return events;
  };
  return { stream, calls };
}

async function collect(result: ReturnType<StreamFn>) {
  const events = [];
  for await (const event of await result) {
    events.push(event.type);
  }
  return events;
}

describe('createGrafanaStreamFn', () => {
  it('refreshes the Grafana session and retries once when the proxy request is rejected with 401', async () => {
    const { stream, calls } = scripted(['Proxy error: 401 Unauthorized', 'ok']);
    const refreshSession = jest.fn(async () => undefined);
    const streamFn = createGrafanaStreamFn({ proxyUrl: '/api/plugins/x/resources/llm', refreshSession, stream });

    const events = await collect(streamFn(model, { messages: [] } as never, {}));
    expect(events).toEqual(['start', 'done']);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ authToken: 'grafana', proxyUrl: '/api/plugins/x/resources/llm', maxTokens: 1000 });
  });

  it('passes other errors and a second 401 through without more retries', async () => {
    const other = scripted(['Proxy error: upstream exploded']);
    const refreshSession = jest.fn(async () => undefined);
    const events = await collect(
      createGrafanaStreamFn({ proxyUrl: '/llm', refreshSession, stream: other.stream })(model, {} as never, {})
    );
    expect(events).toEqual(['error']);
    expect(refreshSession).not.toHaveBeenCalled();

    const twice = scripted(['Proxy error: 401 Unauthorized', 'Proxy error: 401 Unauthorized']);
    const stream = createGrafanaStreamFn({ proxyUrl: '/llm', refreshSession, stream: twice.stream });
    const result = await stream(model, {} as never, {});
    expect(await collect(result)).toEqual(['error']);
    expect((await result.result()).errorMessage).toBe('Proxy error: 401 Unauthorized');
    expect(twice.calls).toHaveLength(2);
  });

  it('keeps the original error when the session cannot be refreshed', async () => {
    const { stream, calls } = scripted(['Proxy error: 401 Unauthorized']);
    const refreshSession = jest.fn(async () => {
      throw new Error('login required');
    });
    const result = await createGrafanaStreamFn({ proxyUrl: '/llm', refreshSession, stream })(model, {} as never, {});
    expect(await collect(result)).toEqual(['error']);
    expect(calls).toHaveLength(1);
  });
});
