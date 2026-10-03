import { type ProxyStreamOptions, streamProxy } from '@earendil-works/pi-agent-core';
import type { AssistantStreamFn } from './durable/models';
import {
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Usage,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';

type ProxyStream = (
  model: Parameters<AssistantStreamFn>[0],
  context: Parameters<AssistantStreamFn>[1],
  options: ProxyStreamOptions
) => AssistantMessageEventStream;

type GrafanaStreamOptions = {
  proxyUrl: string;
  /** Lets Grafana renew the session, e.g. a request through backendSrv, which rotates expired tokens. */
  refreshSession: () => Promise<unknown>;
  stream?: ProxyStream;
};

// streamProxy reports a rejected request as `Proxy error: <status> <statusText>` before any other event.
const UNAUTHORIZED = /^Proxy error: 401\b/;

/**
 * The model stream through the plugin backend. It uses plain fetch, which bypasses the session token
 * rotation Grafana's backendSrv performs on 401 responses; long turns then fail once the session token
 * expires. A 401 before any streamed event is retried once after refreshing the session.
 */
export function createGrafanaStreamFn({ proxyUrl, refreshSession, stream = streamProxy }: GrafanaStreamOptions) {
  const streamFn: AssistantStreamFn = (model, context, options) => {
    const request = () =>
      stream(model, context, {
        ...options,
        // Request the configured output budget explicitly; the backend clamps it per model.
        maxTokens: options?.maxTokens ?? model.maxTokens,
        authToken: 'grafana',
        proxyUrl,
      });
    const output = createAssistantMessageEventStream();
    void (async () => {
      let rejected: Extract<AssistantMessageEvent, { type: 'error' }> | undefined;
      for await (const event of request()) {
        if (event.type === 'error' && UNAUTHORIZED.test(event.error.errorMessage ?? '') && !options?.signal?.aborted) {
          rejected = event;
          break;
        }
        output.push(normalizeEventUsage(event));
      }
      if (rejected) {
        const refreshed = await refreshSession().then(
          () => true,
          () => false
        );
        if (!refreshed) {
          output.push(rejected);
          output.end(rejected.error);
          return;
        }
        for await (const event of request()) {
          output.push(normalizeEventUsage(event));
        }
      }
      output.end();
    })();
    return output;
  };
  return streamFn;
}

/**
 * Completes the usage of a final message: the harness sums token and cost fields into the
 * chat's usage, and a missing field would make that sum NaN, which is not storable JSON.
 */
function normalizeEventUsage(event: AssistantMessageEvent): AssistantMessageEvent {
  if (event.type === 'done') {
    return { ...event, message: { ...event.message, usage: normalizeUsage(event.message.usage) } };
  }
  if (event.type === 'error') {
    return { ...event, error: { ...event.error, usage: normalizeUsage(event.error.usage) } };
  }
  return event;
}

function normalizeUsage(usage: Partial<Usage> | undefined): Usage {
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const cost: Partial<Usage['cost']> = usage?.cost ?? {};
  return {
    ...usage,
    input: number(usage?.input),
    output: number(usage?.output),
    cacheRead: number(usage?.cacheRead),
    cacheWrite: number(usage?.cacheWrite),
    totalTokens: number(usage?.totalTokens),
    cost: {
      input: number(cost.input),
      output: number(cost.output),
      cacheRead: number(cost.cacheRead),
      cacheWrite: number(cost.cacheWrite),
      total: number(cost.total),
    },
  };
}
