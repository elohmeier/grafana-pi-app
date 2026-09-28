# Observability Analyst

Observability Analyst is a Grafana app plugin that embeds an LLM analyst for observability work. The analyst runs in a Grafana-native React UI, uses the current Grafana user's datasource and dashboard permissions, and calls an OpenAI-compatible LLM through the plugin backend so API keys stay server-side.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the current implementation works, and the [architecture review and roadmap](ROADMAP.md) for the `read`/`write`/`edit`/`bash` redesign status and the remaining work: deliberate evidence presentation, a durable server host, restricted datasource access, and future chat integrations.

The [conversational alerting analysis](docs/alerting-chat-openclaw.md) covers Mattermost/Webex incident conversations, screenshots, silencing, proactive follow-up, and OpenClaw integration or runtime replacement.

## What it does

- Runs one agent with a fixed tool set: `read`, `write`, `edit`, and `bash` over a per-chat session filesystem, with typed capabilities behind the shell commands.
- Discovers Prometheus datasources, metric names, labels, and series, and runs PromQL through Grafana datasource APIs as the current user (`grafana-prom`), returning compact min/max/last/sample summaries.
- Searches dashboards and loads them lazily into the session filesystem as local working copies (`/grafana/dashboards/<uid>/dashboard.json`), so `rg`, `jq`, `yq`, `python3`, and `edit` work on real dashboard JSON.
- Extracts Prometheus metric usage from existing dashboards, including panel co-usage, labels, grouping labels, functions, and related metric neighborhoods.
- Creates new dashboards from model-authored Jsonnet evaluated by the backend with the vendored Grafana libraries, and edits existing dashboards as JSON.
- Writes dashboard changes only through `workspace apply`: the user approves the exact diff, and the browser writes as the current user with revision preconditions.
- Troubleshoots Grafana-managed alert rules linked to dashboard panels, read-only.
- Screenshots dashboards and navigates within Grafana.
- Adds dashboard panel menu actions for contextual Assistant prompts.
- Optionally runs as the `grafana-assistant-app` variant with Grafana's extension sidebar integration enabled.
- In the `grafana-assistant-app` variant, edits the currently open unsaved dashboard as a file: `/live/dashboard/dashboard.json` holds its v2 spec, and `live apply` replaces the browser state through Grafana's restricted dashboard mutation API (`GET_SPEC`/`APPLY_SPEC`).
- Compacts long conversations to fit each model's configured context window.
- Stores chat sessions, including the session filesystem, per Grafana user with plugin user storage.

The assistant can present captured files with `evidence show PATH --view table|json|text|image`; presentation never reruns a query. `/session/context.json` exposes read-only turn context, while `/session/receipts/` exposes save outcomes. Skill packages can include `scripts/` with shell, jq, and Python programs. Run `npm run test:shell-worker` after a frontend build to check the production worker, jq, filesystem RPC, and hard termination without Grafana.

## Plugin variants

The default plugin ID is `g42-pi-app`. This is the normal build and keeps Assistant in the app route at `/a/g42-pi-app/chat`.

Release builds also include an alternate plugin ID asset named `grafana-assistant-app-<version>.zip`. This variant is intended for self-managed Grafana instances whose admins want the extra Grafana extension sidebar behavior. The variant keeps the same Assistant implementation, but changes the plugin ID to `grafana-assistant-app` and adds the extension-sidebar declarations that Grafana requires for the global sidebar.

In the sidebar-capable variant:

- Grafana's topbar shows an `Open Assistant` button on non-Assistant routes.
- Dashboard panel menu actions such as `Explain in Assistant`, `Troubleshoot panel`, and `Suggest improvements` open Assistant in the sidebar with panel context.
- The sidebar can open the same chat on the full Assistant page.
- The full Assistant page has `Dock to side`, which saves the current chat session or dashboard-launch context, returns to the last non-Assistant route, and reopens the same chat in the sidebar.
- The Assistant app route hides its own global sidebar entry, so users do not open Assistant beside Assistant.
- When Grafana exposes `dashboardMutationAPI` to `grafana-assistant-app` with the `GET_SPEC` and `APPLY_SPEC` commands (Grafana 13.2+), the unsaved state of the open dashboard appears as `/live/dashboard/dashboard.json`. Assistant edits it with the same tools as any working copy (`edit`, `jq`, `python3`, `grafana-dashboard label-filter`), checks it with `grafana-dashboard validate|data`, and applies it with `live apply` without a separate approval prompt. `live apply` refuses to overwrite changes the user made in the browser after the file was read, unless `--force`.

The alternate release asset name intentionally does not include `sidebar`; the feature is implicit in the `grafana-assistant-app` plugin ID. If you install the alternate asset unsigned in a local or self-managed instance, configure Grafana to allow the `grafana-assistant-app` unsigned plugin ID. Live dashboard editing also requires Grafana's restricted plugin API feature and allow-list entry for `dashboardMutationAPI = grafana-assistant-app`; Grafana 13 defaults include that allow-list, and the local variant Compose service enables the feature toggle.

## Configuration

Configure the app plugin from Grafana's plugin settings page:

- `openAIBaseUrl`: OpenAI-compatible API base URL, for example `https://api.openai.com/v1`.
- `models`: List of models chat users can pick from the assistant model selector. Each entry has an `id` (the upstream model ID), an optional display `name`, an optional `default` flag marking the model preselected for new chats, and per-model request settings:
  - `protocol`: Upstream API protocol, one of `auto`, `chat-completions`, or `responses`. `auto` starts with Chat Completions and switches to Responses only when the provider returns the specific `reasoning_effort` compatibility error that directs the caller to `/v1/responses`. Defaults to `auto`.
  - `thinkingLevel`: Optional model reasoning effort, one of `off`, `low`, `medium`, or `high`. Defaults to `off`.
  - `thinkingFormat`: Chat Completions thinking parameter format, one of `openai`, `qwen`, or `qwen-chat-template`. Responses always uses `reasoning.effort`. Defaults to `openai`.
  - `contextWindow`: The endpoint's input-plus-output token capacity. Defaults to `131072`. The assistant compacts conversation history to fit it.
  - `maxOutputTokens`: Output tokens requested per model call. Defaults to `16384` and is capped at half the context window. The backend clamps every request's output budget to this value.

  When no entry is flagged `default`, the first model is the default. All models share the configured base URL and API key.

- `systemPromptAddendum`: Optional central instructions appended to the built-in system prompt. Do not include secrets because this is stored in `jsonData`.
- `allowedPrometheusDatasourceUids`: Optional list of Prometheus datasource UIDs the assistant may discover, query, and reference in dashboards it validates and saves. Leave empty to allow all Prometheus datasources visible to the current Grafana user.
- `customSkills`: Optional non-secret skill definitions stored in `jsonData`. Users activate explicit custom skills with `$skill-name`; admins can also configure keyword or regex activation.
- `openAIAPIKey`: Secret API key stored in `secureJsonData`.

Chat users pick a model from the selector in the chat composer; the selection is stored per chat session, and new chats start with the configured default model. The backend validates every requested model against the configured list and rejects unknown model IDs, so users cannot reach arbitrary models. Users cannot override the system prompt addendum or datasource allow-list from the assistant page: the backend appends the configured system prompt addendum when proxying LLM requests, and Grafana datasource tools enforce the central allow-list before querying.

For local Docker provisioning, `provisioning/plugins/app.yaml` reads `OPENAI_API_KEY`.
The local demo config points Grafana at `http://host.docker.internal:8080/v1` and configures a single default model entry for the local llama-server model (Ornith-1.5-35B-A3B by default) with the `auto` protocol and medium `qwen-chat-template` thinking, and limits assistant datasource access to the provisioned `prometheus` datasource.
Compose sets the model limits from `PI_CONTEXT_WINDOW` and `PI_MAX_OUTPUT_TOKENS` (defaults `131072` and `16384`).
When `OPENAI_API_KEY` is unset, Compose provides a local dummy key because llama-server only needs a bearer token-shaped value.

Dashboard reads and writes run in the browser as the current Grafana user, so they follow that user's dashboard and folder permissions. `plugin.json` still declares dashboard and folder permissions for the plugin service account, but the backend no longer uses them. In local Docker, `docker-compose.yaml` starts Grafana image rendering so screenshots can run.

## Session filesystem and agent

The assistant is a single agent; there are no specialist subagents or per-skill tool sets. Its tool list is the same on every turn:

- `read`, `write`, `edit`, `bash` over the session filesystem. Everything else, including alerts, metric usage, navigation, and screenshots, is a shell command. The investigation report is the Markdown file `/session/report.md`, which the chat shows next to the messages.

Each chat has its own filesystem:

| Path                                       | Contents                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/grafana/dashboards/<uid>/dashboard.json` | Local working copy of a dashboard resource. Fetched on first read through Grafana's dashboard App Platform API as the current user. `meta.json` next to it is read-only.                          |
| `/grafana/catalog/dashboards.ndjson`       | Metadata-only catalog of visible dashboards, loaded on first read. `coverage.json` reports whether it is complete.                                                                                |
| `/live/dashboard/dashboard.json`           | Unsaved state of the dashboard open in the browser as a v2 resource (variant with the mutation API only). Editable; `live apply` applies it to the browser. `info.json` next to it is read-only.  |
| `/workspace`, `/session`                   | Scratch files persisted with the chat. `/workspace` is the default working directory; `/session/findings.md` holds durable notes, and `/session/report.md` is shown to the user next to the chat. |
| `/tmp`                                     | Scratch files that are not persisted.                                                                                                                                                             |
| `/artifacts`, `/.agents/skills`            | Read-only earlier tool results and skill files.                                                                                                                                                   |
| `/lib/jsonnet/<import path>`               | Read-only vendored Jsonnet libraries (`pi-dashboard` helpers, Grafonnet, xtd, docsonnet), loaded per package from the backend on first read.                                                      |

Users can run commands in the same shell: composer input that starts with `!` (for example `!ls /grafana/dashboards` or `!grafana-prom metrics http_`) runs in the chat's session filesystem without a model call. The result appears in the transcript, and the agent sees the command and its output as context on the next message.

Each tool call or bash invocation is one transaction with quotas and path checks. Links are not supported. Its file changes are committed together, or discarded on timeout, cancellation, or a quota or policy error. Only explicit `workspace apply` and `live apply` commit earlier writes in the same call. Later failures discard uncommitted changes and report earlier commits.

`bash` runs just-bash (its browser bundle) in a dedicated, terminable Web Worker, with coreutils, `rg`, `grep`, `find`, `sed`, `awk`, `yq`, and `diff`, `jq` (jq 1.8 compiled to WebAssembly, so filters behave like the real jq), and `/dev/null`, plus these commands (run `<command> --help`):

- `grafana search|fetch|refresh|open`: dashboard discovery, working-copy hydration, and opening a dashboard, Explore query, or Grafana path in the browser.
- `grafana-prom datasources|metrics|labels|series|query`: Prometheus discovery and bounded query summaries. `query` accepts several `-e EXPR` in one call.
- `grafana-dashboard inspect|fix|validate|data|add-panel|set-panel|label-filter|screenshot`: dashboard summaries (panels with row path, layout, queries, legend, transformations, units and thresholds; variables with current values), explicit layout repair, validation (structure, PromQL syntax with the upstream Prometheus parser, datasource allow-list, and with `--server` a Grafana dry-run of the save), panel data checks that run a panel's queries and apply its transformations, units, and reducers, `add-panel` and `set-panel`, which add or change panels (title, queries, unit, type, position) with schema-correct JSON for classic and v2 files, `label-filter`, which adds a variable-bound Prometheus label matcher to every selected query of a dashboard file (and optionally the query variable), and `screenshot`, which renders a dashboard or panel with the image renderer and attaches the image to the bash result.
- `grafana-usage dashboard|search|related`: Prometheus metric usage derived from dashboards (metrics, labels, grouping labels, functions, panel co-usage) and metrics related to seed metrics. `dashboard` reads the local working copy, so it sees unsaved edits.
- `grafana-alert find|get`: read-only Grafana-managed alert rules, found through `panelRef` and the `__dashboardUid__`/`__panelId__` annotations, with PromQL checks to run.
- `jsonnet [eval] FILE [-o OUT] [--resource UID]`, `jsonnet fix FILE`: Jsonnet evaluation and repair in the backend. The vendored libraries are files under `/lib/jsonnet`.
- `workspace status|diff|discard|apply|receipts`: staged changes, approved writes, and receipts.
- `live status|diff|apply|discard`: review and apply edits of `/live/dashboard/dashboard.json` to the unsaved dashboard in the browser.
- `python3` / `python`: CPython compiled to WebAssembly, run in a Web Worker per invocation with no network access. It works on a copy of the filesystem; its file changes go through the same transaction.

## Dashboard changes

Existing dashboards are edited in their working copy. For new dashboards, the assistant writes Jsonnet under `/workspace` and renders it into a working copy with `jsonnet FILE --resource <uid> -o /grafana/dashboards/<uid>/dashboard.json`. The backend evaluates Jsonnet statelessly with the libraries vendored under `pkg/plugin/jsonnet/vendor` (same `jsonnet-bundler` layout as `agentic-observability`). `jsonnet fix` rewrites common invalid Grafonnet constructor shapes in place.

Nothing reaches Grafana until the assistant runs:

1. `grafana-dashboard validate` on the changed files.
2. `workspace apply [--path PATH]`, which validates the staged changes and opens the confirmation modal with the complete diff. There is no planning mode, saved plan, or plan ID. Waiting for approval does not count against the bash timeout. After approval, the captured changes are checked again for staleness. The browser then writes each dashboard as the current user with `resourceVersion` preconditions. Concurrent changes return `conflicted`.
3. `workspace receipts` or `/session/receipts/` shows save outcomes and complete diffs.

Every apply is journaled per operation as `applied`, `conflicted`, `failed`, `unknown`, or `not attempted`. Imported chat sessions drop the journal, so approvals do not carry over. Jsonnet files from sessions created with the retired virtual-file tools migrate into `/workspace`.

Live edits (`live apply`) change only the unsaved dashboard open in the browser and do not ask for approval. Saving that state still goes through Grafana's own save flow.

## Context window and compaction

Before each model request, the assistant estimates tokens for the system prompt, tool schemas, and history. The budget is `contextWindow − maxOutputTokens − margin`. Above 80% of it, older bulky tool outputs are elided first. If that is not enough, older turns are summarized by the model into a rolling summary that keeps identifiers, paths, and receipt IDs verbatim. Cuts never separate a tool call from its result, the summary is persisted with the session, and truncation is the fallback. The visible transcript stays complete. For long tasks, the assistant keeps notes in `/session/findings.md`.

## Skills

The Grafana assistant’s bundled instructions live under `assistant/skills/<skill-name>/SKILL.md`. These are product assets, kept outside coding-agent discovery directories so they do not activate while agents develop this repository. `npm run generate:skills` validates those files and bundles them into `src/pages/Chat/skills/bundledSkills.generated.ts` for the frontend.

The bundled skills are `grafana-dashboard`, `grafana-alerting`, and `investigation`. Skills add instructions only; they do not change the tool list. The system prompt lists the available skills and inlines active ones. Dashboard, alert, and investigation wording activates the matching bundled skill, and so does `$skill-name`. Skill files and resources are mounted read-only under `/.agents/skills/<name>/`, and the agent reads them with `read`. New bundled skills can be added by creating another `assistant/skills/<name>/SKILL.md`; add optional text resources under `references/`, `templates/`, `assets/`, or `scripts/`.

Admins can also add small instance-specific custom skills through plugin configuration:

```json
[
  {
    "name": "team-runbook",
    "description": "Use the team incident workflow and dashboard conventions.",
    "content": "# Team Runbook\n\nCheck service SLOs first. Prefer existing dashboards before creating new ones.",
    "activation": {
      "explicitOnly": true
    },
    "resources": [
      {
        "path": "references/team-runbook.md",
        "content": "# Team Runbook\n\nEscalate unresolved paging incidents after 15 minutes."
      }
    ]
  }
]
```

Custom skills are non-secret frontend configuration and are sent to the configured LLM when active. Their resources appear under `/.agents/skills/<name>/` like bundled ones. The optional `toolGroups` field no longer selects tools. It is kept as descriptive metadata, and configurations that name `metrics`, `alerts`, `dashboardMetricContext`, `dashboardRead`, `investigation`, or `skillResources` still validate. So do configurations that name the retired groups `jsonnetFiles`, `jsonnetDashboards`, and `subagents`.

## Development

Install frontend dependencies:

```bash
npm install
```

Install pre-commit hooks with the `pre-commit` CLI:

```bash
pre-commit install
```

Build or watch the frontend:

```bash
npm run build
npm run dev
```

Build the sidebar-capable `grafana-assistant-app` frontend instead:

```bash
npm run build:variant
```

Use the variant build whenever `dist` is mounted into the port-3001 Grafana instance. A plain `npm run build` produces the default `g42-pi-app` manifest.

Build the backend after Go changes:

```bash
mage -v build:linux
```

Run checks:

```bash
npm run typecheck
npm run lint
npm run test:ci
go test ./pkg/...
```

Run Grafana with the plugin mounted:

```bash
npm run server
```

Or rebuild both plugin artifacts and start/reload the local Docker stack:

```bash
mise run dev:reload
```

To build and run the sidebar-capable variant locally on port 3001:

```bash
mise run dev:reload:variant
```

This runs `npm run build:variant`, builds the Linux ARM64 backend for `grafana-assistant-app`, mounts `dist` as `grafana-assistant-app`, starts the `assistant-variant` Compose profile, and reloads the `grafana-assistant-variant` service. Open the variant at http://localhost:3001.

### Import custom skills into the local plugin configuration

The manual import command can copy `jsonData.customSkills` from either a Grafana app provisioning YAML file or a Helm ConfigMap template containing one. Set the private source and generated provisioning file in the repository `.env` file:

```dotenv
PI_SKILLS_CONFIG_SOURCE=/absolute/path/to/configmap-grafana-app-plugin-provisioning.yaml
PI_PLUGIN_PROVISIONING_FILE=./work/dev-provisioning/plugins/app.yaml
```

Import the skills explicitly, then run the normal sidebar development task:

```bash
npm run dev:import:skills
mise run dev:reload:variant
```

The import command extracts the `grafana-assistant-app.yaml` ConfigMap entry, validates its `grafana-assistant-app` custom skill catalog, and merges only `customSkills` into the ignored generated file. Because `PI_PLUGIN_PROVISIONING_FILE` points Compose at that file, the next Grafana start or restart loads the imported catalog. Local model, API key, datasource, and access settings continue to come from `provisioning/plugins/app.yaml` and `.env`.

The import is never run by `npm run server` or a `mise` reload task. Re-run it manually when the source changes. Use `PI_SKILLS_CONFIG_MAP_KEY` or `PI_SKILLS_SOURCE_PLUGIN_ID` when the source uses different names. Remove `PI_PLUGIN_PROVISIONING_FILE` from `.env` to return to the checked-in plugin provisioning on the next reload.

Grafana interpolates dollar expressions in provisioning string values. Escape every literal `$` in source skill content as `$$`, including Grafana macros such as `$$__rate_interval`.

### Import dashboards into the local Grafana instance

Import one dashboard JSON file into the sidebar-capable Grafana instance:

```bash
npm run dev:import:dashboard -- /absolute/path/to/dashboard.json
```

To import an entire dashboard tree, preserving every child directory as a nested Grafana folder, run:

```bash
npm run dev:import:dashboards -- /absolute/path/to/dashboards
```

The directory passed to the command is the import root and is not itself created as a Grafana folder. JSON files directly inside it go into General; use `--folder-uid UID` to place the complete tree below an existing folder instead. Existing folders with the same name under the same parent are reused, and dashboard UIDs are overwritten by default. Classic dashboards use `/api/dashboards/db`; stable v2 specs and resources use `/apis/dashboard.grafana.app/v2` and receive a deterministic UID when their resource metadata does not contain one. Use `--dry-run` to validate the complete tree without changing Grafana, or `--no-overwrite` to reject existing dashboard UIDs. The v2 API namespace defaults to `default` and can be changed with `--namespace` or `GRAFANA_NAMESPACE`.

Both commands default to `GRAFANA_URL=http://localhost:3001` and `admin`/`admin`. Set `GRAFANA_URL=http://localhost:3000` only when intentionally targeting the default plugin stack; authentication can also be supplied through `GRAFANA_TOKEN` or `GRAFANA_USER` and `GRAFANA_PASSWORD`.

To reload the sidebar-capable variant and seed stable manual-test samples:

```bash
mise run dev:reload:variant:seed
```

This also runs `npm run dev:seed:samples`, which upserts an `Assistant Dev Samples` folder with dashboards for alert troubleshooting, live dashboard editing, stale dashboard-context repair, and dashboard metric discovery. By default it also seeds a production-like enterprise corpus with multiple folders, dozens of dashboards, and hundreds of Grafana-managed alert rules so search and discovery tools run against realistic noise. The alert sample includes a Grafana-managed AlertRule linked to the panel through both `panelRef` and the dashboard/panel annotations used by Grafana's panel alert indicator. To seed only the Grafana resources against an already-running stack, run:

```bash
npm run dev:seed:samples
```

The seed script defaults to `GRAFANA_URL=http://localhost:3001`; set `GRAFANA_URL=http://localhost:3000` if you intentionally want to seed the default plugin stack. Set `DEV_SAMPLE_ENTERPRISE_PROFILE=0` to seed only the small stable fixtures, or tune `DEV_SAMPLE_ENTERPRISE_FOLDERS`, `DEV_SAMPLE_ENTERPRISE_DASHBOARDS`, `DEV_SAMPLE_ENTERPRISE_ALERT_RULES`, and `DEV_SAMPLE_ENTERPRISE_PANELS` for larger or smaller local corpora.

To create only the alternate plugin ID zip and checksum:

```bash
PLUGIN_VARIANT_ID=grafana-assistant-app npm run package:variant
```

The generated files are `grafana-assistant-app-<version>.zip` and `grafana-assistant-app-<version>.zip.sha1`. The packaging script temporarily rewrites `src/plugin.json` during the build and restores it before exiting.

The local Compose stack also seeds Prometheus with six hours of synthetic RED/USE, Thanos, and enterprise service metrics derived from the `agentic-observability` demo. The history has one sample per minute (`HISTORY_STEP_SECONDS=60`), and the provisioned Prometheus datasources set `timeInterval: 60s` to match, so `$__rate_interval` covers at least two samples; change both together. To include future overlap for short-window `now` queries during a manual demo, start the stack with `HISTORY_FUTURE_SECONDS=3600`; the default is `0` so live Grafana and plugin scrapes can be ingested immediately. To refresh the generated history after it ages out, remove the demo volumes before starting Grafana again:

```bash
docker compose down -v
```

For a full demo reset that also reseeds Prometheus history with one hour of future overlap for short-window `now` queries, run:

```bash
mise run dev:reload:variant:fresh
```

This task deletes Compose volumes with `docker compose down -v --remove-orphans`, rebuilds/reloads the assistant variant, regenerates the Prometheus history, and then seeds the Grafana dashboard and alert samples.

For the default local LLM config, run an OpenAI-compatible llama-server on the host with [Ornith-1.5-35B-A3B](https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B), a Qwen3.5-MoE derivative tuned for agentic tool use. Use the model's adjusted chat template and the card's recommended sampling for general tasks:

```bash
curl -sLo ornith-chat-template.jinja \
  https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B/raw/main/chat_template.jinja
llama-server -hf ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M \
  --jinja \
  --chat-template-file ornith-chat-template.jinja \
  --host 0.0.0.0 \
  --port 8080 \
  --temp 0.6 \
  --top-p 0.95 \
  --top-k 20 \
  --min-p 0.00
```

The template supports `enable_thinking`, so the existing `qwen-chat-template` thinking format applies. The previous default, `unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL` with `--spec-type draft-mtp`, still works; set `PI_DEFAULT_MODEL` to its ID when using it.

To generate a benchmark profile from a model already configured in Pi, reuse the provider/model IDs from `dev:model -- --list`:

```bash
npm run dev:model -- --list
npm run benchmark:profile -- --provider azure-qwen --model qwen--qwen3.8-27b \
  --region westeurope --output benchmarks/qwen38-azure.json
npm run benchmark:run -- --config benchmarks/qwen38-azure.json --dry-run
npm run benchmark:run -- --config benchmarks/qwen38-azure.json
```

Generate and run each model's profile manually in turn. The generator imports the endpoint, protocol, supported thinking settings, and Pi's `contextWindow`/`maxTokens` model limits, and references Pi credentials for resolution at run time. `--thinking`, `--context-window`, `--max-output-tokens`, `--repetitions`, and hosting metadata flags customize the profile; `--api-key-env NAME` selects separate credentials. Profile creation and dry runs never resolve keys or call the model. Applying `dev:model` beforehand is unnecessary: the benchmark runner configures Grafana during preparation.

To run all benchmark cases for one model/hosting/thinking configuration and save a versioned JSON result with token usage and latency, you can also use the local example:

```bash
npm run benchmark:run -- --config benchmarks/qwen-local.example.json --dry-run
npm run benchmark:run -- --config benchmarks/qwen-local.example.json
```

See [model comparison runs](benchmarks/README.md) for profiles, repetitions, usage semantics, artifacts, and comparison guidance. With the model server already running, the comparison runner prepares Grafana and seeds data as needed, preserving existing volumes. `--prepare` forces fresh isolated fixtures; `--reuse-stack` skips preparation. Starting a configured local model server requires the explicit `--start-model-server` flag.

To measure simultaneous assistant conversations, use the separate opt-in [load benchmark](benchmarks/load/README.md): `npm run benchmark:load -- --config benchmarks/qwen-local.example.json --load-config benchmarks/load/assistant.example.json --dry-run`. Remove `--dry-run` to execute the configured concurrency sweep. This workload is excluded from the default benchmark set.

Run the local agent benchmark against the configured llama-server with:

```bash
npm run benchmark:agent
```

Set `BENCH_RUNS=5` to repeat the agent run without restarting the model server. Successful runs write inspectable reports to `test-results/agent-benchmark/latest-report.txt` and `latest-events.json`.

To benchmark read-only analysis of the demo Prometheus incident, run:

```bash
npm run benchmark:analysis
```

This benchmark asks the assistant to investigate the six-hour synthetic data set without creating dashboards. It writes reports to `test-results/analysis-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.

To benchmark the typed dashboard context repair path, run:

```bash
npm run benchmark:dashboard-context
```

This benchmark seeds a stale dashboard, then runs a rich-context repair that must inspect the source dashboard's working copy (for example with `grafana-dashboard inspect`), recognize the stale queries (for example from `grafana-dashboard data` reporting empty panels, or failing PromQL), and apply a repaired copy through an approved `workspace apply`. It writes the report to `test-results/dashboard-context-benchmark/latest-report.txt` with separate event and answer files for the run.

To benchmark live dashboard editing in the sidebar-capable variant, run:

```bash
npm run benchmark:dashboard-editing
```

This benchmark starts the `grafana-assistant-app` variant on http://localhost:3001 and validates four flows: adding a variable and filtering every panel on a large dashboard, multi-step live edits from a dashboard sidebar, recovery after an intentionally failed `live apply`, and graceful fallback when Assistant is open without an active dashboard mutation client. It also checks that live edits do not change the saved dashboard version. It writes reports to `test-results/dashboard-editing-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.
If you already have a compatible OpenAI-compatible model server running, set `BENCH_MANAGE_LLAMA=0` so the benchmark reuses it instead of starting `llama-server`.

To benchmark read-only panel-linked alert troubleshooting in the sidebar-capable variant, run:

```bash
npm run benchmark:alert-troubleshooting
```

This benchmark seeds a dashboard panel and a Grafana-managed AlertRule linked through the App Platform AlertRule API, then validates that Assistant looks up the linked rule with `grafana-alert find` or `grafana-alert get`, runs `grafana-prom query` evidence, and explain an alert-vs-panel threshold mismatch without editing alerts or dashboards. It writes reports to `test-results/alert-troubleshooting-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.

To benchmark dashboard-derived metric discovery, run:

```bash
npm run benchmark:dashboard-metric-discovery
```

This benchmark seeds dashboards with overlapping HTTP, latency, node load, and CPU panels. It checks that the assistant consults dashboard-derived context (`grafana-usage`, or `grafana search|fetch`, `grafana-dashboard inspect`, or searches under `/grafana/`) before its first `grafana-prom query`, stays read-only and within the tool-call budget, and names the related metrics. It writes reports to `test-results/dashboard-metric-discovery-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.

To benchmark read-only Prometheus metric discovery, run:

```bash
npm run benchmark:explore-metrics
```

This benchmark requires successful `grafana-prom metrics|labels|series` discovery and `grafana-prom query` evidence, no staged or applied dashboard changes, a bounded tool-call count, and an answer that names the expected metrics and labels. It writes reports to `test-results/explore-metrics-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.

Open Grafana at http://localhost:3000 and navigate to the Observability Analyst app page.
