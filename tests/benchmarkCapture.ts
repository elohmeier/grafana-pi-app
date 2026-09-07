import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { checkModelSettings, installLLMCapture } from '../scripts/benchmarks/capture.mjs';
import { compactEvents } from '../scripts/benchmarks/core.mjs';

type CapturedRequest = { id: string; model?: string; reasoning?: string; [field: string]: unknown };

/** Automatic fixture shared by the existing scenarios; active only in benchmark:run. */
export async function captureBenchmark(page: Page, testInfo: TestInfo, use: () => Promise<void>) {
  const directory = process.env.BENCH_CASE_DIR;
  if (!directory) {
    return use();
  }
  const expected = JSON.parse(process.env.BENCH_EXPECTED_MODEL!);
  const requests = new Map<string, CapturedRequest>();
  const events: unknown[] = [];
  const capture: Record<string, unknown> = { requests: [], events };
  const onConsole = (message: { text(): string }) => {
    const text = message.text();
    const prefix = '__PI_AGENT_BENCHMARK_EVENT__ ';
    if (!text.startsWith(prefix)) {
      return;
    }
    try {
      const event = JSON.parse(text.slice(prefix.length));
      // Full transcripts remain in the scenario attachments. Avoid retaining repeated text deltas here.
      events.push(...compactEvents([event]));
    } catch {
      /* Other browser console output is not benchmark data. */
    }
  };
  page.on('console', onConsole);
  try {
    const response = await page.request.get(`/api/plugins/${process.env.E2E_PLUGIN_ID}/settings`);
    if (!response.ok()) {
      throw new Error(`Cannot verify benchmark model settings: HTTP ${response.status()}`);
    }
    const settings = await response.json();
    capture.settings = checkModelSettings(settings, expected);
    const runtimeConfig = { ...settings.jsonData };
    for (const field of ['models', 'openAIBaseUrl', 'isOpenAIAPIKeySet']) {
      delete runtimeConfig[field];
    }
    capture.runtimeConfigSha256 = createHash('sha256').update(JSON.stringify(runtimeConfig)).digest('hex');
    await page.exposeFunction('__PI_COMPARISON_REQUEST__', (record: CapturedRequest) => {
      requests.set(record.id, record);
    });
    await page.addInitScript(installLLMCapture);
    await Promise.all(page.frames().map((frame) => frame.evaluate(installLLMCapture)));
    await use();
  } finally {
    await Promise.all(
      page.frames().map((frame) =>
        frame
          .evaluate(async () => {
            await Promise.race([
              (
                window as typeof window & { __PI_COMPARISON_FLUSH__?: () => Promise<unknown> }
              ).__PI_COMPARISON_FLUSH__?.(),
              new Promise((resolve) => setTimeout(resolve, 1000)),
            ]);
          })
          .catch(() => undefined)
      )
    );
    page.off('console', onConsole);
    capture.eventsSource = 'browser-console';
    // Production builds can strip console output. Scenarios also preserve the same
    // events in attachments, including when their quality gate fails.
    if (!events.length) {
      for (const attachment of testInfo.attachments) {
        if (/benchmark.*events\.json$/.test(attachment.name) && attachment.body) {
          events.push(...compactEvents(JSON.parse(attachment.body.toString('utf8'))));
        }
      }
      capture.eventsSource = events.length ? 'scenario-attachments' : 'unavailable';
    }
    capture.requests = [...requests.values()];
    await writeFile(path.join(directory, 'capture.json'), JSON.stringify(capture, null, 2));
    await testInfo.attach('benchmark-capture.json', { body: JSON.stringify(capture), contentType: 'application/json' });
  }
  const mismatched = [...requests.values()].filter(
    (record) => record.model !== expected.id || record.reasoning !== expected.thinkingLevel
  );
  if (mismatched.length) {
    throw new Error(`${mismatched.length} LLM requests did not use the benchmark model/thinking profile`);
  }
  if (!requests.size && testInfo.status === 'passed') {
    throw new Error('Benchmark completed without capturing any LLM requests');
  }
}
