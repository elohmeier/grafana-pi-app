# Model comparison runs

`npm run benchmark:run` runs the existing Grafana browser benchmarks for **one model × endpoint/hosting configuration × thinking setting**. A versioned `run.json` contains case outcomes, every captured LLM request, aggregate token counts and latency distributions. Run it again with another profile to create the inputs for a later comparison report.

The initial catalog contains 12 suites and 15 cases. The batch-editing command is already covered by the dashboard-editing suite. Quality gates and prompts remain in `tests/agent*Benchmark.spec.ts`; the runner discovers individual cases through Playwright. Each case runs in its own Playwright invocation, so a failed case in a serial suite cannot skip its siblings. Cases and repetitions run sequentially with retries disabled.

## Running

Copy [qwen-local.example.json](qwen-local.example.json), fill in the hosting details, and set the exact model ID accepted by your endpoint. Model labels are descriptive; they are not a model registry.

```bash
# Inspect all selected cases and write a planned run.json without contacting Grafana or an LLM.
npm run benchmark:run -- --config benchmarks/qwen-local.example.json --dry-run

# With the matching model server already running, prepare/seed Grafana as needed and run all cases.
npm run benchmark:run -- --config benchmarks/qwen-local.example.json

# Reuse an already configured Grafana stack and its fixtures.
npm run benchmark:run -- --config benchmarks/qwen-local.example.json --reuse-stack
```

Run from the repository root with Node dependencies, Docker, mise, and (for the example profile) llama-server installed. The model server must already be running by default. The runner verifies its advertised model ID. To explicitly let the runner launch the profile’s `localServer` command, add `--start-model-server`.

A normal run prepares Grafana and seeds data as needed. It reuses a previously prepared stack when its source fingerprint, model configuration, sample dashboards/alert, and remaining history coverage match. Missing Grafana samples are reseeded. Missing/stale data, changed configuration, or an unverified stack triggers a plugin build/reload through `mise run dev:reload:variant:seed` with fresh six-hour Prometheus history in isolated volumes. `--prepare` forces fresh preparation; `--reuse-stack` skips preparation and seeding. Neither option starts the model server.

Automatic preparation targets `http://localhost:3001` with plugin ID `grafana-assistant-app`. To use another existing installation, set `GRAFANA_URL` and pass `--reuse-stack`. Existing Compose volumes are preserved. Each prepared run writes `compose.fixtures.json` with uniquely named demo/Prometheus volumes, a fixed generation timestamp, and enough future overlap for all selected case timeout budgets. The runner checks that the prepared history contains at least 300 samples per HTTP series over the past six hours before measuring cases. Fixture names, generation parameters, and verification results are recorded in `environment.fixtures`.

Grafana and its generated fixture volumes remain available after the run for inspection; each prepared run consumes additional local disk space. The generated Compose override can be used to manage that stack afterward. A local model process explicitly started with `--start-model-server` is stopped in cleanup, including after setup failures or interruption; a reused server is left running. The old individual benchmark commands retain their existing setup behavior.

The runner checks Grafana's configured default model, endpoint, protocol, and thinking settings before each case. It also checks the model ID and reasoning setting sent in browser LLM requests. A mismatch fails the case. This verifies what the plugin requested; an upstream server can still resolve a model alias to different weights.

Results go to `artifacts/benchmark-runs/<timestamp>-<uuid>/`. Use `--output DIR` to choose another parent directory. The run directory contains:

- `run.json`: comparison data, updated atomically after each case, including failures.
- `discovery.json` and `discovery.log`: the workload Playwright discovered.
- `prepare.log` and `compose.fixtures.json`: stack setup output and the generated fixture volume/environment override.
- `model-server.log`: local model startup and inference output when the runner launched the server.
- `cases/<repetition>-<case-id>/capture.json`: request metrics and compact agent/tool events, also collected during test teardown after failures.
- `cases/.../playwright.json`, `console.log`, and `playwright/`: original assertions, reports, event/answer attachments, and any Playwright artifacts.

The process exits nonzero for failed, skipped, missing, or interrupted cases. Ctrl-C finalizes the available results; cases that did not start remain `not-run`. A forced process kill can leave a `running` case in the last checkpoint. The repository lock at `artifacts/benchmark-run.lock` prevents two comparison runners from changing/using this stack concurrently. Inspect the PID before removing a lock left by a killed process. Avoid using the old benchmark commands or changing plugin settings during a comparison run.

## Profiles

Each file describes one experimental condition. For your planned Qwen 3.6/3.8, Gemma 4, and GPT variants, create separate profiles using the IDs and protocol actually supported by the chosen host. The runner does not assume that display names such as Luna/Terra are accepted API IDs, or add a new provider transport. It uses the plugin's existing OpenAI-compatible Chat Completions and Responses paths.

A hosted profile has this structure (replace the placeholder model and hosting values):

```json
{
  "label": "hosted-model-high",
  "model": {
    "id": "MODEL_ID_FROM_YOUR_ENDPOINT",
    "provider": "your-provider",
    "baseUrl": "https://your-endpoint.example/v1",
    "protocol": "responses",
    "thinkingLevel": "high",
    "thinkingFormat": "openai"
  },
  "hosting": {
    "label": "provider-region-tier",
    "region": "your-region",
    "serviceTier": "your-tier"
  },
  "apiKeyEnv": "BENCHMARK_PROVIDER_API_KEY",
  "repetitions": 3,
  "notes": "Describe cache state, fixture setup and any hosting constraints."
}
```

`apiKeyEnv` names an environment variable; its value is never copied into the run metadata. During preparation, it becomes the plugin's `secureJsonData` key through the existing provisioning flow. Keep credentials out of JSON profiles, hosting metadata, URLs, and server arguments. Profiles and their public metadata are copied into the result. Full scenario artifacts contain prompts, answers, and Grafana data.

Optional `localServer` provides a trusted local startup command and argument array, as shown in the Qwen example. `startTimeoutMs` defaults to 900000. The runner probes `/models` and checks the requested ID. With `--start-model-server`, it starts the command if no ready server exists and waits for readiness; otherwise it reports the missing server without launching anything. It does not replace an existing server that advertises a different model. For hosted endpoints, omit `localServer`. `hosting.serverArgs` is descriptive metadata; executable launch settings belong in `localServer.args`.

Optional `suites` selects catalog IDs, for example `"suites": ["analysis", "dashboard-editing"]`. Omit it for all suites. Optional `timeoutMs` overrides the per-suite budget; otherwise the runner preserves each suite command's budget, using 480 seconds for the whole dashboard-editing suite so its large-dashboard case has enough time. Each test gets an additional 90 seconds for setup and cleanup. Inherited `BENCH_*` knobs are cleared to prevent silent workload changes. The profile supplies the comparison configuration.

Thinking settings currently supported by the plugin are `off`, `low`, `medium`, and `high`. Unsupported levels are rejected by the runner. With `qwen` or `qwen-chat-template`, enabled thinking is binary: low/medium/high do not represent three different reasoning budgets. Compare off versus enabled for those formats. A provider may reject or ignore a requested reasoning setting; record the provider behavior when interpreting results. `hosting` is descriptive metadata, not a mechanism for setting server parameters or service tiers.

## JSON contract (schemaVersion 1)

| Field                                                   | Meaning                                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `status`, `startedAt`, `finishedAt`, `durationMs` | Whole run identity and wall time, including discovery/setup/browser startup                                                              |
| `config`                                                | Validated model/host/thinking profile and selected workload                                                                              |
| `environment`                                           | Source revision/checksum, dirty status, runner hardware, Grafana version and URL                                                         |
| `methodology`                                           | Concurrency, retries, ordering, cache policy and measurement scope                                                                       |
| `cases[]`                                               | Stable case ID, suite, repetition, status, timeout, test duration, process wall time, errors, artifact location, capture and LLM summary |
| `summary`                                               | Outcome counts, usage coverage, aggregate tokens and latency distributions                                                               |
| `errors[]`                                              | Run-level setup/discovery errors                                                                                                         |

`cases[].capture.requests[]` is the detailed measurement table. Each request has a unique ID, browser timestamp, requested model/API/reasoning/options, HTTP status, state, stop reason, elapsed timings and terminal proxy usage. All parent and specialist calls are measured at the same boundary; the tool-result usage snapshots are not added again. Backend-internal retries/fallbacks are not separate rows. Aborted requests without terminal usage remain missing; totals are observed usage, not a guarantee of billable usage.

`cases[].capture.eventsSource` identifies whether compact agent/tool events came from the browser console or the scenario's event attachment. Production builds can strip console output, so attachments supply a fallback. If neither is available, event timings remain unreported; LLM request measurements are collected separately.

`cases[].llm` and `summary.llm` share the same shape. Every token field is `{ "total": number | null, "reportedRequests": number }`. `usageReportedRequests` and `usageMissingRequests` disclose coverage. The backend marks whether upstream usage was reported; older backends can only be treated as reporting usage when their total is positive.

| Token field               | Meaning                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| `input`                   | Uncached input tokens                                                    |
| `cacheRead`, `cacheWrite` | Cached input components; absent provider cache details normalize to zero |
| `output`                  | All output tokens, including reasoning                                   |
| `reasoningTokens`         | Provider-reported subset of output; `null` when not exposed              |
| `totalTokens`             | Input + cached input + output; reasoning must not be added again         |

The proxy preserves the usage breakdown from [Chat Completions usage](https://developers.openai.com/api/reference/java/resources/completions/methods/create) and [Responses usage](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create). `cost` is `null`: the plugin has no billing price table and its existing zero-cost placeholders are not actual prices. Apply a dated provider/hosting price table when generating reports.

All latency values are milliseconds. Distributions contain `count`, `mean`, `min`, `p50`, `p95`, and `max`, using nearest-rank percentiles. Missing measurements are excluded and an empty distribution has null values.

- `latencyMs.request`: start of browser fetch to terminal proxy event/failure.
- `latencyMs.firstByte`: first body bytes, which may just be a proxy start event.
- `latencyMs.firstContent`: first nonempty thinking, text, or tool-argument delta; the closest available measure of time to first generated content.
- `latencyMs.firstText` / `firstThinking`: first nonempty delta of that type.
- `summary.agent.durationMs`: completed agent start-to-end spans, when those browser events are available.
- `summary.agent.firstToolMs` / `toolDurationMs`: top-level tool timings. Overlapping tool durations are not described as wall time.
- `summary.testDurationMs` / `passedTestDurationMs`: Playwright case durations, including fixture and UI work, for all completed attempts and passing attempts respectively.

`endToEndOutputTokensPerSecond` divides reported output tokens by the full request duration for completed requests. It includes prefill and transport overhead and is not a server decode-speed measurement.

These are application-observed timings through Grafana, not server-only prefill/decode timings. The collector observes a clone of each response without delaying delivery of the original stream. Raw requests remain available to derive other metrics later.

## Comparing runs later

Join runs by stable case ID and repetition; group experimental conditions by model ID, provider, hosting configuration, protocol, and thinking settings. Keep source checksum, selected cases, timeout budgets, Grafana version, and fixture preparation comparable. Each capture also includes `runtimeConfigSha256`, a fingerprint of the plugin settings excluding model, endpoint, and key-presence fields; differences can reveal changed custom skills, system prompts, or datasource restrictions. Report pass rate and failure categories alongside latency and token use; include failed requests in resource totals. Compare per-case distributions before producing a cross-suite aggregate, since scenarios have very different workloads.

Inspect failed quality gates before attributing them to a model. Existing scenario evidence can be truncated; for example, the robust-dashboard gate requires parseable query-result JSON to verify its canary. The runner preserves the gate's failure and original attachments instead of converting missing evidence into a pass.

Use multiple repetitions for comparisons; one run is a smoke test. Start with three to five, then increase where differences are noisy. Preserve raw observations so later reports can compute confidence intervals. Do not average percentiles from different runs; recompute them from the request/case rows.

Caches are currently uncontrolled and there is no excluded warmup phase. Record quantization, model revision, server build/arguments, hardware, accelerator count, region, service tier, and cache policy in `hosting` or `notes`. Server load and relative `now-6h` Prometheus windows can change between runs. Normal runs check history coverage and regenerate it in isolated volumes when needed. Keep preparation mode and fixture generation parameters comparable across conditions; `--reuse-stack` deliberately preserves the existing dataset.

Future extensions can add a matrix scheduler, pinned dataset/time snapshots, warmup/cache controls, provider billing reconciliation, and a report generator without changing the existing scenario quality gates. A headless agent-only harness would be a separate measurement track: these benchmarks exercise real Grafana sidebar and dashboard-mutation behavior.

## Testing the runner

```bash
npm run benchmark:test
go test ./pkg/plugin -run 'TestBenchmark|Test.*Responses|Test.*LLM'
```

The Node tests use synthetic streams and a simulated Playwright process; they do not call a model. The runner uses Playwright's [JSON reporter](https://playwright.dev/docs/test-reporters#json-reporter) and the repository's `@grafana/plugin-e2e` fixtures for live runs.
