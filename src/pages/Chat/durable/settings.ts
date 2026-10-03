import type { Api, Model } from '@earendil-works/pi-ai';
import type { CompactionPolicy, HarnessSettings } from '@earendil-works/pi-durable';

/**
 * Compaction thresholds for a model. Pi Durable's defaults assume a large
 * context window; these scale with the configured window so small windows
 * still leave room to keep recent turns and to compact in the background.
 */
export function compactionPolicy(model: Pick<Model<Api>, 'contextWindow' | 'maxTokens'>): Partial<CompactionPolicy> {
  const window = model.contextWindow;
  return {
    // Room for the answer: requests above `contextWindow - reserveTokens` wait for a summary.
    reserveTokens: Math.min(model.maxTokens, Math.floor(window / 2)),
    keepRecentTokens: Math.min(20_000, Math.floor(window * 0.2)),
    backgroundTokens: Math.min(32_768, Math.floor(window * 0.15)),
  };
}

/** Harness settings read at every use; `model` is the model the attached view resolves for the chat. */
export function assistantHarnessSettings(model: () => Model<Api> | undefined): HarnessSettings {
  return {
    get compaction() {
      const current = model();
      return current ? compactionPolicy(current) : {};
    },
  };
}
