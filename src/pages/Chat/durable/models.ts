import {
  createModels,
  createProvider,
  type Api,
  type AssistantMessageEventStream,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import type { ModelRef } from '@earendil-works/pi-durable';
import { createOpenAICompatibleModel, getConfiguredModels, type PiAppJsonData } from '../model';

/** Every configured model is served by the plugin backend under this provider ID. */
export const GRAFANA_PROVIDER = 'grafana';

/** A model stream that starts synchronously, as pi-ai providers require. */
export type AssistantStreamFn = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions
) => AssistantMessageEventStream;

export function modelRef(modelId: string): ModelRef {
  return { provider: GRAFANA_PROVIDER, modelId };
}

/**
 * The pi-ai model collection of the assistant: one provider whose catalog is
 * the admin-configured model list and whose requests stream through the
 * plugin backend, which holds the API key and validates the model ID.
 */
export function createAssistantModels(
  jsonData: Pick<PiAppJsonData, 'models' | 'openAIBaseUrl'> | undefined,
  streamFn: () => AssistantStreamFn
): MutableModels {
  const catalog = getConfiguredModels(jsonData).map(
    (configured) => ({ ...createOpenAICompatibleModel(jsonData, configured), provider: GRAFANA_PROVIDER }) as Model<Api>
  );
  // The streams are resolved per request, so a session moved to another view uses that view's stream.
  const stream: AssistantStreamFn = (model, context, options) => streamFn()(model, withSummaryFocus(context), options);
  const models = createModels();
  models.setProvider(
    createProvider({
      id: GRAFANA_PROVIDER,
      name: 'Grafana',
      // The browser holds no credential; the backend authenticates the Grafana user.
      auth: { apiKey: { name: 'Grafana session', resolve: async () => ({ auth: {} }) } },
      models: catalog,
      api: { stream, streamSimple: stream },
    })
  );
  return models;
}

/** How the harness's summarizer system prompt begins; automatic compactions take no instructions of their own. */
const SUMMARIZER_PROMPT_PREFIX = 'You are a context summarization assistant.';

/**
 * What a summary must keep for observability work. The harness's summarizer
 * asks for concise sections and preserves file paths and function names; the
 * assistant's later turns rely on identifiers the user and the tools produced.
 */
export const SUMMARY_FOCUS = `Additional focus: this is an observability assistant working in Grafana. Under Critical Context, list verbatim and completely, not as examples or ranges: every fact or identifier the user stated (tickets, time windows, names), dashboard UIDs and titles with every panel title the conversation listed, datasource UIDs, metric names, label names and values, PromQL expressions, file paths under /grafana, /workspace, and /session, and apply or receipt IDs. Completeness of these lists matters more than brevity.`;

/** Adds the assistant's focus to a summarizer request; other requests pass unchanged. */
export function withSummaryFocus(context: TranscriptContext): TranscriptContext {
  const [first, ...rest] = context.messages;
  const isSummary =
    first?.role === 'system' && typeof first.content === 'string' && first.content.startsWith(SUMMARIZER_PROMPT_PREFIX);
  const last = rest.at(-1);
  if (!isSummary || last?.role !== 'user') {
    return context;
  }
  const content =
    typeof last.content === 'string'
      ? `${last.content}\n\n${SUMMARY_FOCUS}`
      : [...last.content, { type: 'text' as const, text: SUMMARY_FOCUS }];
  return { ...context, messages: [first, ...rest.slice(0, -1), { ...last, content }] };
}
