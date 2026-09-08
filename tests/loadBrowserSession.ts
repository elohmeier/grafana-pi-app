import type { Page } from '@playwright/test';
import { expect } from '@grafana/plugin-e2e';
import { createHash } from 'node:crypto';
import { testIds } from '../src/components/testIds';
import { installLLMCapture, checkModelSettings } from '../scripts/benchmarks/capture.mjs';
import { classifyRequestFailure } from '../scripts/benchmarks/load.mjs';
import {
  workloadPrompts,
  followUpPrompt,
  finalAnswer,
  workloadQualityError,
} from '../scripts/benchmarks/workloads.mjs';

type RequestRecord = {
  id: string;
  startedAt: number;
  state: string;
  durationMs?: number;
  model?: string;
  reasoning?: string;
  error?: string;
  upstreamStatus?: number;
  httpStatus?: number;
};
type BenchmarkEvent = {
  type: string;
  timestamp: number;
  toolName?: string;
  [key: string]: unknown;
};
export type LoadSession = {
  id: string;
  workload: string;
  startedAt: number;
  status: string;
  requests: RequestRecord[];
  events?: BenchmarkEvent[];
  answer?: string;
  error?: string;
  failureKind?: string;
  dispatchDelayMs?: number;
};
type LoadWindow = typeof window & {
  __PI_AGENT_BENCHMARK_CAPTURE__?: boolean;
  __PI_AGENT_BENCHMARK_RECORD_EVENT__?: (event: BenchmarkEvent) => void;
  __PI_AGENT_BENCHMARK_EVENTS__?: BenchmarkEvent[];
  __PI_LOAD_EVENT__?: (event: BenchmarkEvent) => Promise<void>;
  __PI_COMPARISON_FLUSH__?: () => Promise<unknown>;
};

/** The same browser agent/tools as interactive chat, with one conversation per iteration. */
export class LoadBrowserSession {
  private current?: LoadSession;
  private turnEnd?: () => void;
  private events: BenchmarkEvent[] = [];

  constructor(
    private page: Page,
    private expected: { id: string; thinkingLevel: string },
    private followUp: boolean,
    private journal: (record: unknown) => void,
    private navigate: (page: Page) => Promise<void>
  ) {}

  async install() {
    // Grafana 13 can show its release splash after the chat has already loaded.
    // Dismiss this known onboarding overlay through its normal UI controls.
    await this.page.addLocatorHandler(
      this.page.getByLabel("What's new in Grafana", { exact: true }),
      async (splash) => {
        await splash.getByRole('button', { name: 'Close', exact: true }).click();
      }
    );
    await this.page.exposeFunction('__PI_COMPARISON_REQUEST__', (record: RequestRecord) => {
      const current = this.current;
      if (!current) return;
      current.dispatchDelayMs ??= record.startedAt - current.startedAt;
      const index = current.requests.findIndex((entry) => entry.id === record.id);
      if (index < 0) current.requests.push(record);
      else current.requests[index] = record;
      this.journal({ kind: 'request', sessionId: current.id, ...record });
    });
    await this.page.exposeFunction('__PI_LOAD_EVENT__', (event: BenchmarkEvent) => {
      if (!this.current) return;
      this.events.push(event);
      this.journal({ kind: 'agent-event', sessionId: this.current.id, ...event });
      if (event.type === 'agent_end') this.turnEnd?.();
    });
    await this.page.addInitScript(installLLMCapture);
    await this.page.addInitScript(() => {
      const w = window as LoadWindow;
      w.__PI_AGENT_BENCHMARK_CAPTURE__ = true;
      w.__PI_AGENT_BENCHMARK_EVENTS__ = [];
      w.__PI_AGENT_BENCHMARK_RECORD_EVENT__ = (event) => {
        // Avoid retaining repeated partial transcripts and nested tool snapshots.
        if (
          ['agent_start', 'agent_end', 'message_end', 'tool_execution_start', 'tool_execution_end'].includes(event.type)
        ) {
          w.__PI_AGENT_BENCHMARK_EVENTS__?.push(event);
          void w.__PI_LOAD_EVENT__?.(event);
        }
      };
      const info = console.info.bind(console);
      console.info = (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('__PI_AGENT_BENCHMARK_EVENT__ ')) return;
        info(...args);
      };
    });
  }

  async ready() {
    await expect(this.page.getByTestId(testIds.chat.composer)).toBeEnabled();
  }

  async reset(signal: AbortSignal) {
    signal.throwIfAborted();
    this.current = undefined;
    this.events = [];
    if (this.page.isClosed()) {
      this.page = await this.page.context().newPage();
      await this.install();
      await this.navigate(this.page);
      await this.ready();
    }
    await this.page.getByRole('button', { name: /^New (chat|session)$/ }).click();
    await this.ready();
    signal.throwIfAborted();
  }

  async run(session: LoadSession, signal: AbortSignal) {
    this.current = session;
    this.events = [];
    try {
      await this.turn(workloadPrompts[session.workload], signal);
      let quality = workloadQualityError(session.workload, this.events);
      if (!quality && this.followUp) {
        const boundary = this.events.length;
        await this.turn(followUpPrompt, signal);
        quality = workloadQualityError(session.workload, this.events.slice(boundary), true);
      }
      session.answer = finalAnswer(this.events);
      session.status = quality ? 'failed' : 'passed';
      if (quality) {
        session.failureKind = 'quality';
        session.error = quality;
      }
    } finally {
      this.turnEnd = undefined;
      if (signal.aborted) {
        await this.page
          .getByRole('button', { name: /^(Abort response|Stop)$/ })
          .click({ timeout: 1000 })
          .catch(() => undefined);
      }
      await Promise.all(
        this.page.frames().map((frame) =>
          frame
            .evaluate(async () => {
              await Promise.race([
                (window as LoadWindow).__PI_COMPARISON_FLUSH__?.(),
                new Promise((resolve) => setTimeout(resolve, 1000)),
              ]);
            })
            .catch(() => undefined)
        )
      );
      session.events = this.events;
      const mismatch = session.requests.some(
        (r) => r.model !== this.expected.id || r.reasoning !== this.expected.thinkingLevel
      );
      const failed = session.requests.find((r) => r.state === 'failed');
      if (mismatch || !session.requests.length) {
        session.status = 'failed';
        session.failureKind = 'configuration';
        session.error = 'Missing requests or model/thinking mismatch';
      } else if (failed) {
        session.status = 'failed';
        session.failureKind = classifyRequestFailure(failed);
        session.error = failed.error;
      } else if (session.requests.some((r) => r.state === 'running')) {
        session.status = 'failed';
        session.failureKind = 'incomplete';
        session.error = 'Request did not reach a terminal event';
      }
      // Closing on cancellation releases the client connections before a worker
      // can be reused. The stage scheduler records the timed-out outcome.
      if (signal.aborted) {
        await this.page.close().catch(() => undefined);
        for (const request of session.requests.filter((r) => r.state === 'running')) {
          request.state = 'failed';
          request.error = 'AbortError';
          request.durationMs = Date.now() - request.startedAt;
          this.journal({ kind: 'request', sessionId: session.id, ...request });
        }
      }
    }
  }

  private async turn(prompt: string, signal: AbortSignal) {
    signal.throwIfAborted();
    await Promise.all(
      this.page.frames().map((frame) =>
        frame.evaluate(() => {
          (window as LoadWindow).__PI_AGENT_BENCHMARK_EVENTS__ = [];
        })
      )
    );
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // Attach immediately: cancellation may happen while Playwright fills/clicks.
    void done.catch(() => undefined);
    const aborted = () => fail(signal.reason);
    this.turnEnd = finish;
    signal.addEventListener('abort', aborted, { once: true });
    try {
      await Promise.race([this.page.getByTestId(testIds.chat.composer).fill(prompt), done]);
      signal.throwIfAborted();
      await Promise.race([this.page.getByTestId(testIds.chat.send).click({ timeout: 10_000 }), done]);
      signal.throwIfAborted();
      await done;
    } finally {
      signal.removeEventListener('abort', aborted);
      this.turnEnd = undefined;
    }
  }
}

export async function verifyLoadSettings(page: Page, expected: unknown) {
  const response = await page.request.get('/api/plugins/grafana-assistant-app/settings');
  if (!response.ok()) throw new Error(`Cannot verify benchmark settings: HTTP ${response.status()}`);
  const settings = await response.json();
  checkModelSettings(settings, expected);
  const runtime = { ...settings.jsonData };
  for (const field of ['models', 'openAIBaseUrl', 'isOpenAIAPIKeySet']) delete runtime[field];
  return createHash('sha256').update(JSON.stringify(runtime)).digest('hex');
}
