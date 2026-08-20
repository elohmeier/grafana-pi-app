# Observability Analyst

Observability Analyst is a Grafana app plugin that embeds an LLM analyst for observability work. The analyst runs in a Grafana-native React UI, uses the current Grafana user's datasource and dashboard permissions, and calls an OpenAI-compatible LLM through the plugin backend so API keys stay server-side.

## What it does

- Discovers Prometheus datasources visible to the current user.
- Lists metric names and label values through Grafana datasource resource APIs.
- Runs PromQL through Grafana datasource query APIs, returning compact min/max/last/sample summaries for range queries by default.
- Extracts Prometheus metric usage from existing dashboards, including panel co-usage, labels, grouping labels, functions, and related metric neighborhoods.
- Creates dashboards from model-authored Jsonnet source. The source lives in session-scoped virtual files saved with the chat session, so follow-up prompts can edit the Jsonnet, re-render, and save again through the app.
- Lists, fetches, and screenshots dashboards through Grafana APIs.
- Adds dashboard panel menu actions for contextual Assistant prompts.
- Optionally runs as the `grafana-assistant-app` variant with Grafana's extension sidebar integration enabled.
- In the `grafana-assistant-app` variant, can use Grafana's restricted dashboard mutation API for typed live edits to the currently open unsaved dashboard, including panel rename/query/add/move, dashboard settings, and custom/query variables.
- Keeps broad metric reconnaissance available through a restricted metrics subagent.
- Stores chat sessions per Grafana user with plugin user storage.

## Plugin variants

The default plugin ID is `g42-pi-app`. This is the normal build and keeps Assistant in the app route at `/a/g42-pi-app/chat`.

Release builds also include an alternate plugin ID asset named `grafana-assistant-app-<version>.zip`. This variant is intended for self-managed Grafana instances whose admins want the extra Grafana extension sidebar behavior. The variant keeps the same Assistant implementation, but changes the plugin ID to `grafana-assistant-app` and adds the extension-sidebar declarations that Grafana requires for the global sidebar.

In the sidebar-capable variant:

- Grafana's topbar shows an `Open Assistant` button on non-Assistant routes.
- Dashboard panel menu actions such as `Explain in Assistant`, `Troubleshoot panel`, and `Suggest improvements` open Assistant in the sidebar with panel context.
- The sidebar can open the same chat on the full Assistant page.
- The full Assistant page has `Dock to side`, which saves the current chat session or dashboard-launch context, returns to the last non-Assistant route, and reopens the same chat in the sidebar.
- The Assistant app route hides its own global sidebar entry, so users do not open Assistant beside Assistant.
- When Grafana exposes `dashboardMutationAPI` to `grafana-assistant-app`, Assistant can list the currently open dashboard panels/layout/settings/variables and apply typed live edits such as renaming a panel, changing a query, adding or moving a panel, updating dashboard settings, and adding or updating variables without a separate approval prompt. Layout-affecting typed edits attach screenshot verification when Grafana image rendering is configured.

The alternate release asset name intentionally does not include `sidebar`; the feature is implicit in the `grafana-assistant-app` plugin ID. If you install the alternate asset unsigned in a local or self-managed instance, configure Grafana to allow the `grafana-assistant-app` unsigned plugin ID. Live dashboard editing also requires Grafana's restricted plugin API feature and allow-list entry for `dashboardMutationAPI = grafana-assistant-app`; Grafana 13 defaults include that allow-list, and the local variant Compose service enables the feature toggle.

## Configuration

Configure the app plugin from Grafana's plugin settings page:

- `openAIBaseUrl`: OpenAI-compatible API base URL, for example `https://api.openai.com/v1`.
- `models`: List of models chat users can pick from the assistant model selector. Each entry has an `id` (the upstream model ID), an optional display `name`, an optional `default` flag marking the model preselected for new chats, and per-model request settings:
  - `protocol`: Upstream API protocol, one of `auto`, `chat-completions`, or `responses`. `auto` starts with Chat Completions and switches to Responses only when the provider returns the specific `reasoning_effort` compatibility error that directs the caller to `/v1/responses`. Defaults to `auto`.
  - `thinkingLevel`: Optional model reasoning effort, one of `off`, `low`, `medium`, or `high`. Defaults to `off`.
  - `thinkingFormat`: Chat Completions thinking parameter format, one of `openai`, `qwen`, or `qwen-chat-template`. Responses always uses `reasoning.effort`. Defaults to `openai`.

  When no entry is flagged `default`, the first model is the default. All models share the configured base URL and API key.

- `systemPromptAddendum`: Optional central instructions appended to the built-in system prompt. Do not include secrets because this is stored in `jsonData`.
- `allowedPrometheusDatasourceUids`: Optional list of Prometheus datasource UIDs the assistant may discover, query, and reference in uploaded dashboards. Leave empty to allow all Prometheus datasources visible to the current Grafana user.
- `customSkills`: Optional non-secret skill definitions stored in `jsonData`. Users activate explicit custom skills with `$skill-name`; admins can also configure keyword or regex activation.
- `openAIAPIKey`: Secret API key stored in `secureJsonData`.

Chat users pick a model from the selector in the chat composer; the selection is stored per chat session, and new chats start with the configured default model. The backend validates every requested model against the configured list and rejects unknown model IDs, so users cannot reach arbitrary models. Users cannot override the system prompt addendum or datasource allow-list from the assistant page: the backend appends the configured system prompt addendum when proxying LLM requests, and Grafana datasource tools enforce the central allow-list before querying.

For local Docker provisioning, `provisioning/plugins/app.yaml` reads `OPENAI_API_KEY`.
The local demo config points Grafana at `http://host.docker.internal:8080/v1` and configures a single default model entry for the Qwen llama-server model with the `auto` protocol and medium `qwen-chat-template` thinking, and limits assistant datasource access to the provisioned `prometheus` datasource.
When `OPENAI_API_KEY` is unset, Compose provides a local dummy key because llama-server only needs a bearer token-shaped value.

Managed dashboard writes use the plugin service account declared in `plugin.json`. In local Docker, `docker-compose.yaml` enables Grafana's external service account support for this and starts Grafana image rendering so screenshot verification can run.

## Managed dashboards

The backend vendors Jsonnet libraries under `pkg/plugin/jsonnet/vendor` using the same `jsonnet-bundler` layout as `agentic-observability`. For new dashboards the assistant writes self-contained plain Jsonnet source to a session-scoped virtual `dashboard.jsonnet` file, applies compact edits to that file, and the backend compiles it with the embedded vendored libraries before saving the dashboard. If a model invents unsupported Grafonnet constructors, `render_dashboard` automatically attempts one transactional structural repair for common bad `g.dashboard.new(...)`, `g.dashboard.with_panels(...)`, panel constructor, and target constructor shapes. `fix_jsonnet` remains available for explicit repair after other render errors.

The assistant can plan, write, render, and save Jsonnet-backed dashboards with:

- `write_dashboard_plan`
- `write_jsonnet`
- `edit_jsonnet`
- `fix_jsonnet`
- `read_jsonnet`
- `render_dashboard`
- `save_dashboard`

Rendered dashboards are saved through the Grafana dashboards API (`/api/dashboards/db`) using the plugin service account. Before saving, the backend requires a title, normalizes the UID and panel layout, forces the `genai` tag, and rejects dashboards that reference datasource UIDs outside the configured allow-list. The Jsonnet source and its checksum stay with the chat session's virtual files, which are persisted in plugin user storage.

The default chat toolset does not expose raw dashboard JSON upload/delete tools, raw Prometheus data-frame output, or direct vendored Jsonnet file browsing. Durable dashboard writes go through the Jsonnet-backed render-and-save path.

## Subagents

The top-level assistant is a supervisor that delegates to specialist subagents, each a nested agent with a narrow system prompt, a narrow tool allow-list, and a per-specialist tool-call budget:

- `run_query_agent`: Prometheus metric discovery and PromQL validation.
- `run_dashboard_agent`: dashboard design, Jsonnet, render, save, and live-edit work.
- `run_investigation_agent`: incident and root-cause analysis with a structured report.
- `run_alert_agent`: read-only troubleshooting of Grafana-managed alert rules, especially panel-linked rules.
- `run_support_agent`: Grafana and observability explanations.
- `run_navigation_agent`: safe Grafana navigation and link building.

Persistent writes from any specialist still require the parent assistant's existing approval flow.

## Skills

Dashboard instructions are split into repo-local skills under `.agents/skills/<skill-name>/SKILL.md`, using the same default `SKILL.md` directory shape as local agent skill installs. `npm run generate:skills` validates those files and bundles them into `src/pages/Chat/skills/bundledSkills.generated.ts` for the frontend.

The bundled skills are `grafana-dashboard`, `grafana-alerting`, and `investigation`. The chat agent always has metric discovery tools, dashboard-derived metric context tools, and the specialist subagent tools available. Dashboard guidance activates when the prompt asks for dashboard, panel, Jsonnet, render, or save work, which also enables the dashboard read, live-edit, and Jsonnet tool groups for that turn; alert wording (or panel context plus a firing/warning mention) activates the alerting skill and its read-only alert tools. New bundled skills can be added by creating another `.agents/skills/<name>/SKILL.md`; add optional text resources under `references/`, `templates/`, or `assets/`.

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
    "toolGroups": ["metrics", "skillResources"],
    "resources": [
      {
        "path": "references/team-runbook.md",
        "content": "# Team Runbook\n\nEscalate unresolved paging incidents after 15 minutes."
      }
    ]
  }
]
```

Custom skills are non-secret frontend configuration and are sent to the configured LLM when active. Supported custom skill tool groups are `metrics`, `alerts`, `dashboardMetricContext`, `dashboardRead`, `jsonnetFiles`, `jsonnetDashboards`, `investigation`, `subagents`, and `skillResources`.
The bundled investigation skill uses the `investigation` tool group to maintain the structured report shown in the chat workspace.

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

The local Compose stack also seeds Prometheus with six hours of synthetic RED/USE, Thanos, and enterprise service metrics derived from the `agentic-observability` demo. To include future overlap for short-window `now` queries during a manual demo, start the stack with `HISTORY_FUTURE_SECONDS=3600`; the default is `0` so live Grafana and plugin scrapes can be ingested immediately. To refresh the generated history after it ages out, remove the demo volumes before starting Grafana again:

```bash
docker compose down -v
```

For a full demo reset that also reseeds Prometheus history with one hour of future overlap for short-window `now` queries, run:

```bash
mise run dev:reload:variant:fresh
```

This task deletes Compose volumes with `docker compose down -v --remove-orphans`, rebuilds/reloads the assistant variant, regenerates the Prometheus history, and then seeds the Grafana dashboard and alert samples.

For the default local LLM config, run an OpenAI-compatible llama-server on the host:

```bash
llama-server -hf unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL \
  --host 0.0.0.0 \
  --port 8080 \
  --temp 1.0 \
  --top-p 0.95 \
  --top-k 20 \
  --presence-penalty 1.5 \
  --min-p 0.00 \
  --spec-type draft-mtp \
  --spec-draft-n-max 2
```

Use a recent llama.cpp build with `draft-mtp` support; older `llama-server` builds reject that `--spec-type` value or fail to load the MTP GGUF.

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

This benchmark seeds a stale dashboard, then runs a rich-context repair that must use `inspect_dashboard_context`, render, and save a managed dashboard copy. It writes the report to `test-results/dashboard-context-benchmark/latest-report.txt` with separate event and answer files for the run.

To benchmark live dashboard editing in the sidebar-capable variant, run:

```bash
npm run benchmark:dashboard-editing
```

This benchmark starts the `grafana-assistant-app` variant on http://localhost:3001 and validates three flows: typed multi-step live edits from a dashboard sidebar, recovery after an intentionally failed typed live edit, and graceful fallback when Assistant is open without an active dashboard mutation client. It writes reports to `test-results/dashboard-editing-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.
If you already have a compatible OpenAI-compatible model server running, set `BENCH_MANAGE_LLAMA=0` so the benchmark reuses it instead of starting `llama-server`.

To benchmark read-only panel-linked alert troubleshooting in the sidebar-capable variant, run:

```bash
npm run benchmark:alert-troubleshooting
```

This benchmark seeds a dashboard panel and a Grafana-managed AlertRule linked through the App Platform AlertRule API, then validates that Assistant uses the alert specialist to find the linked rule, inspect the panel, run PromQL evidence, and explain an alert-vs-panel threshold mismatch without editing alerts or dashboards. It writes reports to `test-results/alert-troubleshooting-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.

To benchmark dashboard-derived metric discovery, run:

```bash
npm run benchmark:dashboard-metric-discovery
```

This benchmark seeds dashboards with overlapping HTTP, latency, node load, and CPU panels. It requires exactly one top-level `run_query_agent` call, checks that the query specialist uses `search_dashboard_metric_usage` or `get_metric_neighborhood` before validating PromQL, and writes reports to `test-results/dashboard-metric-discovery-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.

To benchmark only the `run_query_agent` discovery path, run:

```bash
npm run benchmark:explore-metrics
```

This benchmark requires exactly one top-level `run_query_agent` call, checks the returned metric coverage and nested tool count, and writes reports to `test-results/explore-metrics-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.

Open Grafana at http://localhost:3000 and navigate to the Observability Analyst app page.
