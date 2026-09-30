import { type ProxyStreamOptions, type StreamFn, streamProxy } from '@earendil-works/pi-agent-core';
import {
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';

type ProxyStream = (
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
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
  const streamFn: StreamFn = (model, context, options) => {
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
        output.push(event);
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
          output.push(event);
        }
      }
      output.end();
    })();
    return output;
  };
  return streamFn;
}
