# Concurrent assistant load testing

`npm run benchmark:load` measures simultaneous assistant conversations through the actual browser agent, specialists, Grafana tools, and streaming proxy. It is separate from `benchmark:run`, its suite catalog, and ordinary Playwright discovery. Running the comparison benchmarks never starts a load test.

## Run

Use an existing model profile with an explicit `chat-completions` or `responses` protocol. `auto` is rejected to avoid unobserved protocol-discovery requests. Model, endpoint, credentials and thinking settings use the same profile handling as [comparison runs](../README.md). The model profile's `suites`, `repetitions` and `timeoutMs` do not select the load workload.

```bash
# Plan and write run.json/report.md without resolving credentials or contacting services.
npm run benchmark:load -- \
  --config benchmarks/qwen-local.example.json \
  --load-config benchmarks/load/assistant.example.json --dry-run

# With the model server running, prepare Grafana once and execute the sweep.
npm run benchmark:load -- \
  --config benchmarks/qwen-local.example.json \
  --load-config benchmarks/load/assistant.example.json
```

The example runs 1, 2, 4, 8 and 16 concurrent conversations for each of two read-only workloads. Its maximum scheduled browser time is about 110 minutes including browser setup and drain budgets; actual time usually is shorter. Copy the load configuration to choose a smaller sweep first. The example thresholds are starting values for an experiment, not established service guarantees.

`--reuse-stack` uses an already configured stack; `--prepare` forces fresh isolated fixtures. Preparation targets the sidebar-capable `grafana-assistant-app` variant at `http://localhost:3001` and preserves existing Compose volumes. It verifies fixture history for the full planned run. To target another existing installation of that variant, set `GRAFANA_URL` and use `--reuse-stack`.

The model server is externally managed by default. `--start-model-server` explicitly allows starting the profile's `localServer` command. Only a server started by this run is stopped on cleanup. The repository's `artifacts/benchmark-run.lock` is shared with comparison runs to prevent conflicting stack use. Avoid changing plugin settings or running other benchmark commands during the sweep.

## Workload and scheduling

The two workload IDs are `explore-metrics` and `analysis`. They reuse the serial benchmarks' prompts and check successful specialist execution, PromQL evidence, expected metric/incident findings, and a nonempty final answer. Load quality gates omit the serial suites' tool-duration limits; latency is evaluated separately. Persistent write approvals are never accepted by the driver.

Each virtual user owns a browser context and page. Authentication cookies are copied from the plugin-e2e login; browser storage is independent. Users share Grafana's authenticated account and server-side services, so this measures concurrent conversations rather than account-level authorization or login throughput. Each iteration starts a fresh chat. `followUp: true` adds a second turn using the collected evidence, preserving the conversation's history. These workloads run separately, in repetition → workload → increasing-concurrency order.

Pages load before the measurement clock starts. Users start progressively during `rampUpMs`, then continue throughout `warmupMs` and `durationMs`. Finished conversations are replaced independently, after `thinkTimeMs` and resetting the chat. This maintains a closed population of users: new work slows down when responses take longer. It does not simulate a fixed arrival rate or a synchronized burst.

At the end of the measurement window no new conversations are admitted. Outstanding conversations can complete during `drainMs`, subject to their own `sessionTimeoutMs`. Remaining work is cancelled and retained as timed out. A timeout closes the affected page and the worker opens a replacement for its next conversation. Browser reset time and dispatch delay can reduce achieved concurrency; the report includes observed occupancy rather than assuming the requested value was reached. A broken worker or model mismatch invalidates the stage and stops the sweep.

| Load configuration                   | Meaning                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `concurrency`                        | Increasing list of positive virtual-user counts                           |
| `workloads`                          | Nonempty list of the two supported workload IDs                           |
| `repetitions`                        | Complete sweeps, default 1                                                |
| `rampUpMs`, `warmupMs`, `durationMs` | Per-stage ramp, excluded warmup, measurement window                       |
| `drainMs`, `sessionTimeoutMs`        | Drain and per-conversation deadlines                                      |
| `setupTimeoutMs`                     | Browser pool preparation budget                                           |
| `thinkTimeMs`, `cooldownMs`          | Pause between conversations and between stages                            |
| `followUp`                           | Add a second user turn, default false                                     |
| `minSessions`                        | Minimum measured admissions per stage for a capacity claim                |
| `thresholds`                         | Any nonempty subset of `successRate`, `sessionP95Ms`, `firstContentP95Ms` |
| `metrics`                            | Optional Prometheus text endpoint targets, sampled every five seconds     |

## Measurements and interpretation

Latency and success use conversations **admitted during the measurement window**, including outcomes that finish during drain. Warmup admissions are excluded from this cohort even if they finish later. Session duration includes dispatch, model calls, tool execution and an optional follow-up. Timed-out durations are observed time until cancellation, not estimates of how long completion would have taken.

Successful conversations/minute counts **completions inside the measurement window**, including warmup admissions. Aggregate output tokens/second similarly accounts for provider usage at terminal request events inside that window. This is a wall-clock aggregate, not a sum of individual token rates or a server decode-speed measurement. Missing usage is disclosed in `throughputUsage` and `llm`; partial observed totals are not complete billing totals.

Request latency starts at browser fetch. First content means the first nonempty text, reasoning or tool-argument delta; first bytes can be only a proxy start event. First text includes generated text from specialists and does not measure DOM paint. Mean/peak requests in flight are calculated from overlapping request intervals, clipped to the measurement window, including warmup and unfinished requests. Session occupancy uses the same interval method. Tools and specialists can make the model-request population differ from the conversation population.

Dispatch delay measures conversation admission to its first observed LLM fetch, including browser scheduling and prompt preparation. It is unavailable when no request was dispatched.

Percentiles use nearest rank and disclose sample counts. Missing timings are excluded, while failed and timed-out conversations remain in the success denominator. A stage can pass, fail its thresholds, have insufficient samples, or be invalid due to infrastructure problems. Capacity requires every repetition and every lower tested level to pass. If the entire sweep passes, the report says **at least** the highest tested concurrency. Sparse results establish no supported capacity.

Saturation is a measured outcome: a completed sweep exits 0 even when thresholds fail. Setup/driver failures exit 1, and interruption exits 130. There are no automatic retries. Inspect `capacity` and stage `summary.acceptance` to apply your own acceptance policy.

## Artifacts and endpoint diagnostics

Results go to `artifacts/benchmark-load-runs/<timestamp>-<uuid>/`; `--output DIR` selects another parent directory.

- `run.json`: versioned `kind: "assistant-load"` run index, model/load configuration, source and environment metadata, stage summaries, capacity interpretation and errors.
- `report.md`: concurrency table and capacity interpretation.
- `stages/<id>/stage.json`: stage window, raw sessions and summary.
- `stages/<id>/sessions/<uuid>.json`: atomic admission and completion checkpoints, including requests, compact terminal agent/tool events, errors and answer.
- `stages/<id>/observations.jsonl`: incremental request updates, agent events, generator samples and optional raw endpoint metrics. Requests emit updates with the same ID; deduplicate by ID rather than adding updates together.
- Per-stage Playwright output and `console.log`, plus setup/model-server logs when relevant.

Ctrl-C stops admission and cancels the active child, preserving available checkpoints. Forced termination can leave a running record; the observation journal and individual session files retain evidence even if the final stage summary was not written. Artifacts include prompts/answers and Grafana data. Credentials are resolved only during execution and are not copied to public run metadata.

For llama-server, a load profile can collect its metrics endpoint:

```json
{
  "metrics": [{ "label": "llama", "url": "http://127.0.0.1:8080/metrics" }]
}
```

Merge this field into the load config. Enable `--metrics` when starting llama-server. `bearerTokenEnv` optionally names an environment variable containing a metrics bearer token; URLs must not contain credentials or query parameters. URLs are resolved from the load-generator host, not from the Grafana container. Metrics failures are recorded without invalidating otherwise valid load measurements.

Record the actual server build, model/quantization, hardware, parallel slots, context limits, batching, cache and speculative-decoding settings in the model profile's hosting metadata. Inspect llama-server's processing/deferred requests or your hosted provider's queue/rate-limit metrics alongside browser observations. Plugin metrics can also be collected by specifying an accessible metrics endpoint. Upstream HTTP status is preserved in new proxy SSE errors; older plugin backends can leave the specific upstream error class unknown.

The built-in generator samples cover the Playwright worker's process memory, CPU usage and event-loop delay, not all Chromium processes or GPU utilization. Running the generator on another machine helps separate its resource consumption from local inference. Caches are uncontrolled; repeated prompts can benefit from shared prefixes. Read-only fixture windows remain relative to the current time. These application measurements alone cannot prove that the model endpoint, rather than Grafana, tools or the generator, is the bottleneck.

## Verification without model traffic

```bash
npm run benchmark:test
GRAFANA_URL=http://localhost:3001 E2E_PLUGIN_ID=grafana-assistant-app \
  npx playwright test tests/loadBrowserSession.spec.ts --project=chromium --retries=0
```

The browser regression test intercepts every model request and verifies overlapping sessions, specialist calls, reset, rate-limit classification and cancellation/recovery through the actual frontend. It does not establish endpoint capacity. The ordinary benchmark catalog and Playwright config exclude `agentLoadBenchmark.spec.ts`; only the separate load config plus `RUN_LOAD_BENCHMARKS=1` can execute it.
