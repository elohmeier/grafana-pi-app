# Observability Analyst Architecture

This repository is a Grafana app plugin that embeds a Pi-powered LLM agent for
observability work. The plugin runs inside Grafana, uses Grafana permissions and
datasources, and proxies LLM calls through a Go backend so API keys stay on the
server side.

The app is easiest to understand as four layers:

```text
Grafana plugin shell
  -> React and Grafana Scenes chat UI
  -> Pi agent runtime and session filesystem in the browser
  -> Go backend resources for secrets, the LLM proxy, and Jsonnet evaluation
```

## What An Agent Is

An agent is a model loop with tools.

A normal chat app sends messages to an LLM and renders the answer. An agent adds
three more pieces:

- A system prompt: durable instructions that define the assistant's role and
  rules.
- Tools: typed functions the model may ask the app to run.
- A loop: when the model asks for a tool, the app validates the request, runs
  the tool, appends the result to the conversation, and asks the model to
  continue.

In this app the loop is provided by `@earendil-works/pi-agent-core`. The central
class is `Agent`, created in `buildAgent` in
`src/pages/Chat/ChatSceneObject.tsx`. The important inputs are:

- `systemPrompt`: built from `src/pages/Chat/systemPrompt.ts`, the skill
  catalog, active skills, and the session filesystem section.
- `model`: an OpenAI-compatible model object from `src/pages/Chat/model.ts`,
  carrying the configured `contextWindow` and `maxTokens`.
- `tools`: the fixed tool list (see [Tool System](#tool-system)).
- `streamFn`: a Pi `streamProxy` call that posts to the plugin backend.
- `transformContext`: the context compactor from
  `src/pages/Chat/compaction.ts`.
- `beforeToolCall`: a hook that can block tool execution before it happens.
- `afterToolCall`: a hook that turns large tool results into artifacts.

The model never directly touches Grafana, Prometheus, files, or dashboards. It
only emits tool-call JSON. The app decides which tools exist, validates their
arguments, runs the implementation code, and sends back a tool result.

There is one agent per chat. There are no specialist subagents.

## Repository Map

The main implementation areas are:

- `src/plugin.json`: Grafana plugin manifest. It declares an app plugin with a
  Go backend, one navigable page at `/a/g42-pi-app/chat`, and dashboard panel
  menu extension links.
- `src/module.tsx`: Grafana frontend entry point. It registers the app root
  page, the plugin configuration page, panel menu extension links, and — in the
  `grafana-assistant-app` variant — the extension sidebar component and link.
- `src/components/App/App.tsx`: App shell. It checks app access and mounts a
  `SceneApp`.
- `src/pages/Chat/`: Chat UI, agent setup, compaction, skills, prompts, typed
  tools, sidebar integration, and tests.
- `src/pages/Chat/workspace/`: The session filesystem, its mounts and
  transactions, the `read`/`write`/`edit`/`bash` tools, shell commands
  (`commands/`), plan/apply (`plans.ts`), the Grafana broker
  (`grafanaBroker.ts`), and CPython-WASM support (`python/`).
- `src/pages/Chat/tools/`: Typed tools that the shell does not cover (dashboard
  context, dashboard metric usage, alerts, live dashboard edits, investigation
  report, navigation, screenshots, artifacts) and shared Prometheus helpers.
- `pkg/main.go`: Go backend entry point. Grafana starts this binary as the
  plugin backend process.
- `pkg/plugin/`: Backend resource routes, LLM proxy, access checks, stateless
  Jsonnet evaluation and structural repair (`jsonnet_eval.go`,
  `jsonnet_assets.go`, `jsonnet_ast_repair.go`), Jsonnet library browsing
  (`jsonnet_libs.go`), and telemetry metrics.
- `.agents/skills/`: Repo-local skills bundled into the frontend
  (`grafana-dashboard`, `grafana-alerting`, `investigation`).
- `scripts/generate-bundled-skills.mjs`: Converts `.agents/skills/**/SKILL.md`
  into `src/pages/Chat/skills/bundledSkills.generated.ts`.
- `scripts/package-plugin-variant.mjs`: Builds the `grafana-assistant-app`
  plugin ID variant with extension sidebar declarations.
- `scripts/configure-pi-model.mjs`: Imports a model configured in Pi
  (including its limits) into the local plugin provisioning.
- `provisioning/`: Local Grafana provisioning for datasources and plugin
  settings.
- `demo/prometheus/`: Synthetic Prometheus demo data.
- `tests/` and `scripts/benchmark-*.mjs`: Playwright and benchmark-style e2e
  tests.

Local source lookups used while writing this document:

- `h grafana/grafana` resolves to the local Grafana checkout. It was used to
  confirm `AppPlugin`, `setRootPage`, and `addConfigPage` behavior.
- `h earendil-works/pi` resolves to the local Pi checkout. It was used to
  confirm `Agent`, `streamProxy`, tool execution modes, and tool hooks.

## Grafana Plugin Shell

Grafana discovers the plugin through `src/plugin.json`.

Key manifest choices:

- `"type": "app"` makes this a Grafana app plugin, not a panel or datasource.
- `"backend": true` and `"executable": "gpx_g42_pi_app"` tell Grafana to start
  the Go backend binary.
- `includes` adds the app page to Grafana navigation.
- `roles` defines the `g42-pi-app.app:access` action.
- `iam.permissions` still grants the plugin service account dashboard and
  folder permissions. They are unused now that dashboard reads and writes run
  in the browser as the current user; removing them is an owner decision.
- `extensions.addedLinks` declares three dashboard panel menu actions
  (`Explain in Assistant`, `Troubleshoot panel`, `Suggest improvements`).
- `grafanaDependency` is `>=13.2.0`.

Frontend registration happens in `src/module.tsx`:

- `initPluginTranslations(pluginJson.id, [loadResources])` initializes Grafana
  and Scenes translations before the app loads.
- `LazyApp` is registered with `setRootPage`, so Grafana renders it under
  `/a/<plugin-id>/*`.
- `LazyAppConfig` is registered with `addConfigPage`, so admins can configure
  model, access, datasource, and skill settings.
- Three panel menu links are registered on
  `PluginExtensionPoints.DashboardPanelMenu`. They store panel context through
  `src/pages/Chat/dashboardLaunch.ts` and either open the sidebar (variant) or
  navigate to the chat page (default plugin ID).

## Plugin Variants And Sidebar Integration

The default plugin ID is `g42-pi-app`. Release builds also produce a
`grafana-assistant-app` variant through `scripts/package-plugin-variant.mjs`,
which:

- temporarily rewrites `src/plugin.json` with the variant plugin ID,
- renames the RBAC action to `grafana-assistant-app.app:access`,
- injects `extensions.addedComponents` and `extensions.addedLinks` entries
  targeting `grafana/extension-sidebar/v0-alpha`,
- builds frontend and backend, zips the result, and restores the original
  manifest.

At runtime, `src/module.tsx` checks `pluginJson.id === 'grafana-assistant-app'`
and only then registers:

- the `AssistantSidebar` extension sidebar component
  (`src/pages/Chat/AssistantSidebar.tsx`), which renders `ChatApp` with
  `variant="sidebar"`,
- the sidebar toggle link (hidden while already on an Assistant route),
- sidebar docking (`src/pages/Chat/sidebarDock.ts`): `Dock to side` stores a
  sessionStorage handoff, navigates back to the last non-Assistant route, and
  reopens the sidebar by publishing an `open-extension-sidebar` event with
  retries.

`src/pages/Chat/sidebarPageContext.ts` builds a `<current_grafana_context>`
prompt block from the current route (dashboard UID, panel, time range,
variables, and whether live dashboard editing is available). It also feeds skill
selection hints such as `hasPanelContext`.

`src/pages/Chat/chatRunRegistry.ts` keeps in-memory live run snapshots (agent,
artifacts, tool runs, session workspace, compaction state, approval handler) so a
chat can move between the full page and the sidebar without losing state.

## Chat And Agent Lifecycle

The main file is `src/pages/Chat/ChatSceneObject.tsx`.

On load:

1. The UI reads plugin metadata and configuration with `usePluginMeta()`.
2. It builds OpenAI-compatible Pi model objects from the admin-configured
   model list, using the default entry until the user picks another model.
3. It creates a Pi `streamFn` with `streamProxy`.
4. It creates a new chat session, a `SessionWorkspace`, and an `Agent`.
5. It loads the saved session index from Grafana plugin user storage.

When a user submits a prompt:

1. `submitPrompt` trims the input and creates a session title if needed.
2. `buildSkillRuntime(prompt)` selects active skills, binds the session
   workspace to the current Grafana capabilities
   (`createSessionWorkspaceToolkit`), and builds the system prompt and the
   fixed tool list.
3. The agent's `systemPrompt`, `tools`, `model`, and `thinkingLevel` are
   replaced in place for this turn, so the model selected in the chat composer
   applies to the next request.
4. `agent.prompt(prompt)` starts the Pi loop. Before each model request,
   `transformContext` compacts the history when needed.
5. The agent streams model events, tool calls, tool results, and final text.
6. On `agent_end`, `saveSession` writes the chat session to plugin user
   storage.

Sessions store:

- agent messages (the complete transcript),
- selected model ID and thinking level,
- the serialized session workspace (`/workspace` and `/session` files,
  dashboard working copies with their fetched base, plans, and the apply
  journal),
- the compaction state (rolling summary and how many messages it covers),
- investigation report state,
- artifacts and the artifact counter.

Storage is per Grafana user through `usePluginUserStorage()`, capped at 50
sessions. The app also supports chat import and export as JSON. Imported
sessions are restored with `trusted: false`, which drops plans and the apply
journal so approvals never carry over. Sessions from before the redesign that
contain `virtualJsonnetFiles` have those files migrated into `/workspace`
(`workspace/migration.ts`).

## LLM Streaming Boundary

The browser does not call the LLM provider directly.

`ChatSceneObject.tsx` defines:

```text
streamProxy(..., proxyUrl: /api/plugins/g42-pi-app/resources/llm)
```

Pi's `streamProxy` appends `/api/stream`, so the backend keeps an alias route:

```text
/llm/api/stream -> handleLLMStream (alias of /llm/stream)
```

The backend implementation is in `pkg/plugin/resources.go`.

The backend:

- requires app access through `withAppAccess`,
- rejects requests when the secure API key is missing,
- resolves the client model ID against the configured `models` list,
  rejecting unknown IDs and falling back to the default entry when the
  request omits one,
- appends the admin-configured `systemPromptAddendum` as an
  `## Instance instructions` section the client cannot remove,
- selects the resolved model's OpenAI-compatible protocol (`auto`, Chat
  Completions, or Responses),
- in `auto` mode, retries with Responses only for the exact upstream
  `reasoning_effort` validation error that directs the caller to
  `/v1/responses`, then remembers that protocol per model for the plugin
  instance,
- clamps the request's output budget to the model's `maxOutputTokens`,
- translates Pi proxy messages and tool schemas into the selected protocol,
- preserves Responses `call_id`/item IDs and encrypted reasoning items across
  tool turns while keeping `store: false`,
- applies the configured thinking level using Responses `reasoning.effort`, or
  the configured Chat Completions format:
  - OpenAI: `reasoning_effort`,
  - Qwen: `enable_thinking`,
  - Qwen chat template: `chat_template_kwargs.enable_thinking`,
- relays Chat Completions chunks or typed Responses server-sent events back to
  Pi proxy events and records
  Prometheus metrics for requests, tokens, and proposed tool calls.

This is the main secret boundary. The OpenAI-compatible API key lives in
Grafana `secureJsonData`, is decrypted only for the backend plugin, and is never
put into frontend `jsonData`.

## Tool System

Tools are defined as Pi `AgentTool` objects. Each tool has:

- `name`: what the model calls.
- `label`: human-readable UI label.
- `description`: model-facing instructions for when to call it.
- `parameters`: TypeBox schema used to validate arguments.
- `execute`: code that runs after validation.

The registry is `createGrafanaTools` in `src/pages/Chat/tools/index.ts`. It
returns the same list on every turn:

- `read`, `write`, `edit`, `bash`: the session filesystem tools from
  `src/pages/Chat/workspace/tools.ts`. Discovery, PromQL queries, dashboard
  editing, validation, Jsonnet, and writes all happen here.
- `inspect_dashboard_context`: typed panel, query, layout, field config, and
  variable context for one dashboard, with current-variable-substituted
  queries and best-effort Prometheus validation summaries.
- `inspect_dashboard_metric_usage`, `search_dashboard_metric_usage`,
  `get_metric_neighborhood`: dashboard-derived Prometheus metric context.
- `find_panel_alert_rules`, `get_alert_rule`: read-only alert troubleshooting.
- The live dashboard tools (variant only, when the mutation API is available).
- `update_report`: the structured investigation report.
- `navigate`: safe in-Grafana navigation.
- `screenshot_dashboard`: dashboard screenshots through the image renderer.
- `read_artifact`: slices, fields, or `jq` results from stored artifacts.

The typed tools cover capabilities that the shell does not provide yet. Skills
do not add or remove tools.

`afterToolCall` stores bulky tool results as artifacts and returns a bounded
preview with an artifact reference. Artifacts are listed under `/artifacts`
and readable with `read`, `jq`, or `read_artifact`.

## Session Filesystem

`SessionWorkspace` (`src/pages/Chat/workspace/workspace.ts`) is one persistent
virtual filesystem per chat. It keeps canonical resource snapshots separate
from local overlays and scratch files.

| Path                                                  | Kind                 | Behavior                                                                                                                                                                                           |
| ----------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/grafana/dashboards/<uid>/dashboard.json`            | resource             | Working copy of the dashboard resource (`{apiVersion, kind, metadata, spec}`). Fetched lazily on first access through the dashboard App Platform API as the current user. Writes stage an overlay. |
| `/grafana/dashboards/<uid>/meta.json`                 | generated, read-only | Provider-owned metadata: revision (`resourceVersion`), folder, API version, and managed-by.                                                                                                        |
| `/grafana/catalog/dashboards.ndjson`                  | generated, read-only | Paginated, metadata-only catalog of dashboards visible to the user (up to 5000, cached for 5 minutes). Loaded on first read.                                                                       |
| `/grafana/catalog/coverage.json`                      | generated, read-only | Whether the catalog is complete, and its limit.                                                                                                                                                    |
| `/live/dashboard/{info,panels,layout,variables}.json` | generated, read-only | Unsaved state of the dashboard open in the browser, read through the mutation API (variant only).                                                                                                  |
| `/workspace`                                          | scratch, persisted   | Default working directory.                                                                                                                                                                         |
| `/session`                                            | scratch, persisted   | Durable notes, such as `plan.md` and `findings.md`.                                                                                                                                                |
| `/tmp`                                                | scratch              | Not persisted; separate quota.                                                                                                                                                                     |
| `/artifacts`                                          | generated, read-only | `index.ndjson` and one JSON file per artifact.                                                                                                                                                     |
| `/.agents/skills`                                     | generated, read-only | `SKILL.md` and resources of bundled and custom skills.                                                                                                                                             |

Invariants:

- Every mutation path (`write`, `edit`, bash, commands, python) goes through a
  copy-on-write `WorkspaceTransaction`. A tool call or bash invocation is one
  transaction: its changes are committed together, or discarded on timeout,
  cancellation, or a failed policy or quota check.
- `workspace` subcommands call `checkpoint()` first, so they see and commit the
  writes made earlier in the same bash invocation.
- Paths are normalized and length-limited. Symlinks and hard links are rejected.
- Default quotas (`DEFAULT_WORKSPACE_LIMITS` in `workspace/types.ts`): 512 KiB
  per file, 8 MiB for persisted scratch files plus overlays, 2 MiB for `/tmp`,
  500 files, 100 resources, 4 MiB written per invocation.
- `read` returns a content revision; `write` and `edit` accept it to reject
  concurrent changes. `edit` applies exact-match replacements atomically.
- `rg`, `find`, and `grep` see only hydrated dashboards. Remote discovery goes
  through `grafana search` or the catalog, which reports coverage.

## Bash And Workspace Commands

`runWorkspaceBash` (`src/pages/Chat/workspace/shell.ts`) runs the just-bash
browser bundle (`just-bash/browser`) against the transaction through
`WorkspaceBashFs`. Shell variables and the working directory reset per call;
files persist. The default timeout is 30 seconds (maximum 120 seconds), output
is truncated at 32 KiB per stream, and just-bash execution limits bound
commands, loops, and `awk`/`sed`/`jq` iterations. The interpreter runs on the
main browser thread, so the timeout is a cooperative abort, not a hard kill.

Built-in commands include coreutils, `find`, `rg`, `grep`, `sed`, `awk`, `jq`,
`yq`, `diff`, and `xargs`. There are no network, process, or link commands.

Workspace commands are declared in `workspace/commands/commands.ts` and
`workspace/commands/jsonnet.ts` through a small registry
(`commands/registry.ts`) that provides option parsing, `--help`, and a
declared effect (`local-read`, `local-stage`, `remote-read`, `remote-write`).
The system prompt lists them from the same registry.

| Command                                            | Purpose                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `grafana search [QUERY] [--tag] [--folder]`        | Bounded remote dashboard search that reports coverage.                                                                          |
| `grafana fetch UID...`, `grafana refresh [UID...]` | Hydrate dashboards into working copies, or re-fetch their base.                                                                 |
| `grafana-prom datasources`                         | Allowed Prometheus datasources.                                                                                                 |
| `grafana-prom metrics\|labels\|series`             | Metric names, label names or values, and series label sets.                                                                     |
| `grafana-prom query EXPR \| -e EXPR... [--range]`  | Instant or range PromQL with compact summaries; several `-e` expressions run in one call. Results are also stored as artifacts. |
| `grafana-dashboard inspect PATH`                   | Panels, queries, variables, and datasources of a dashboard file.                                                                |
| `grafana-dashboard fix PATH`                       | Explicit classic layout repair (panel IDs, `gridPos`, overlaps), reviewable with `workspace diff`.                              |
| `grafana-dashboard validate PATH...`               | JSON, resource envelope, structure, PromQL syntax, and datasource allow-list checks.                                            |
| `jsonnet [eval] FILE [-o OUT] [--resource UID]`    | Evaluate workspace Jsonnet in the backend. `--resource` wraps the result in a dashboard resource envelope.                      |
| `jsonnet fix FILE`, `jsonnet lib ls\|cat\|search`  | Structural Grafonnet repair in place; browse the vendored libraries.                                                            |
| `workspace status\|diff\|discard`                  | Staged resource changes, usage, and limits.                                                                                     |
| `workspace plan\|apply\|plans`                     | Freeze, approve, and apply changes (see [Dashboard Changes](#dashboard-changes-plan-and-apply)).                                |

Commands reach Grafana through the `WorkspaceBroker` in
`workspace/grafanaBroker.ts`: dashboards through `getBackendSrv()` and the
dashboard App Platform API, Prometheus through the frontend datasource
service, and Jsonnet through the plugin backend. All calls run as the current
Grafana user.

## Python

`python3` and `python` (`workspace/python/`) run CPython compiled to
WebAssembly. Webpack copies the interpreter from just-bash's
`vendor/cpython-emscripten` directory to `dist/cpython/`, and the assets are
loaded on first use. Each invocation runs in a fresh dedicated Web Worker that
is terminated on timeout (60 seconds) or cancellation, which is a hard limit.

The program receives a copy of the scratch mounts, hydrated dashboard working
copies, skills, and artifacts (the network-backed catalog and live mounts are
excluded). There is no network access and no JavaScript bridge. After the run,
changed or deleted files under writable locations are staged through the same
transaction and policy as bash; read-only paths are reported as not staged.
Python is unavailable when the browser lacks `Worker` or `WebAssembly`.

## Skills

Skills are model-facing instructions. They do not change the tool list.

Bundled skills live under `.agents/skills/`:

- `grafana-dashboard`: dashboard, panel, Jsonnet, validation, plan/apply, and
  live-edit workflow.
- `grafana-alerting`: read-only troubleshooting of Grafana-managed alert rules,
  especially rules linked to dashboard panels.
- `investigation`: evidence-based incident investigation workflow.

`npm run generate:skills` runs `scripts/generate-bundled-skills.mjs`, which:

- validates each `SKILL.md`,
- reads text resources from `references/`, `templates/`, and `assets/`,
- writes `src/pages/Chat/skills/bundledSkills.generated.ts`.

Skill selection is in `src/pages/Chat/skills/selection.ts`. Activation rules:

- Users can explicitly name a skill with `$skill-name`.
- Dashboard keywords activate `grafana-dashboard`; in the sidebar, being on a
  dashboard plus contextual edit intent also activates it.
- Investigation/root-cause/incident keywords activate `investigation`.
- Alert keywords activate `grafana-alerting`; panel context plus
  firing/warning/alert wording also activates it.
- Admin-configured custom skills can activate by keyword or regex unless they
  are `explicitOnly`.

`src/pages/Chat/skills/prompt.ts` renders the skill catalog with each skill's
path (`/.agents/skills/<name>/SKILL.md`) and inlines the content of active
skills. The skills mount (`workspace/mounts.ts`) exposes every skill file and
resource read-only, so the model reads a non-active skill or a reference with
`read`. There is no separate skill resource tool.

Custom skills are stored in `jsonData`. They are non-secret configuration and
are sent to the model when active. Tool groups remain only as descriptive
metadata (`skills/catalog.ts`, `skills/configured.ts`). Custom skill
validation still accepts the current group names and the retired
`jsonnetFiles`, `jsonnetDashboards`, and `subagents` names so that existing
configurations keep working, but no group selects tools.

## Metrics And Prometheus

Prometheus access is the `grafana-prom` command, backed by the Prometheus
broker in `workspace/grafanaBroker.ts` and the helpers in
`src/pages/Chat/tools/metrics.ts`. It uses Grafana's frontend datasource
service, so queries run as the current Grafana user and respect datasource
visibility.

Dashboard-derived metric context is in
`src/pages/Chat/tools/dashboardMetricContext.ts`:

- `inspect_dashboard_metric_usage`: extract Prometheus metric usage, labels,
  grouping labels, functions, panel locations, and relations from one dashboard.
- `search_dashboard_metric_usage`: search visible dashboards and build a compact
  metric usage corpus.
- `get_metric_neighborhood`: rank metrics related to seed metrics using
  dashboard co-usage, shared panels, shared dashboards, metric families, and
  label overlap.

Important safety and cost controls:

- Datasources are filtered by `allowedPrometheusDatasourceUids` when configured.
- Dashboard-derived metric context is read-only and filters extracted usage by
  the same Prometheus datasource allow-list.
- Queries return min/max/last/sample summaries, not raw data frames.
- Lists, series, and query results are truncated; range queries use bounded
  `maxDataPoints`.
- The system prompt requires checking labels with `grafana-prom labels` or
  `series` before using them, and validating PromQL with concrete selectors.

## Alerting Tools

Alert tools are in `src/pages/Chat/tools/alerts.ts` and are strictly read-only:

- `find_panel_alert_rules`: reads AlertRule resources from
  `/apis/rules.alerting.grafana.app/v0alpha1` and links them to a panel through
  `spec.panelRef` and the `__dashboardUid__`/`__panelId__` annotations.
- `get_alert_rule`: reads one AlertRule and returns a normalized expression
  plus `prometheusChecks` PromQL suggestions the model runs with
  `grafana-prom query` to compare alert conditions against panel data.

There are no alert create, update, pause, silence, or delete tools or
commands. The system prompt and the `grafana-alerting` skill both mandate
read-only troubleshooting.

## Dashboard Changes: Plan And Apply

The app supports three dashboard paths:

1. Read-only inspection: working copies with `read`/`rg`/`jq`,
   `grafana-dashboard inspect`, `inspect_dashboard_context`, and
   `screenshot_dashboard`.
2. Durable changes: edit working copies, then plan and apply.
3. Ephemeral live edits to the currently open dashboard (variant only, see
   [Live Dashboard Editing](#live-dashboard-editing)).

Durable flow:

```text
user asks for a dashboard change
  -> edit /grafana/dashboards/<uid>/dashboard.json
     (existing dashboard), or write /workspace/*.jsonnet and run
     jsonnet FILE --resource <uid> -o /grafana/dashboards/<uid>/dashboard.json
     followed by grafana-dashboard fix (new dashboard)
  -> grafana-dashboard validate
  -> workspace plan        (validate + freeze, returns plan ID)
  -> workspace apply <id>  (approval modal with diff, then conditional writes)
```

`workspace plan` (`workspace/plans.ts`):

- collects staged overlays (all, or those selected with `--path`; at most 50
  operations) and classifies each as create, update, or delete,
- runs the dashboard validator (`workspace/dashboardModel.ts`) with the
  datasource allow-list and managed-by policy, and refuses to plan on errors,
- stores the exact documents, the base `resourceVersion`, before/after hashes,
  and a bounded unified diff,
- identifies the plan by a SHA-256 digest of its canonical content. Editing a
  planned file afterwards makes the plan stale.

`workspace apply` (`applyWorkspacePlan`):

1. Rejects unknown or stale plans. An identical plan that was already fully
   applied returns its earlier record.
2. Requests approval through the `WorkspaceApprovalService`. In the UI, this
   opens the existing confirmation modal with the plan summary and diff. The
   bash timeout is paused while waiting; only the user's cancellation ends the
   wait.
3. Re-checks staleness after approval, because the files may have changed
   while the modal was open.
4. Writes each operation from the browser as the current user through
   `/apis/dashboard.grafana.app/<version>/namespaces/<ns>/dashboards` (the
   preferred version is discovered from the API group; dashboards whose stored
   version cannot be converted are edited in that stored version). Updates and
   deletes carry `resourceVersion` preconditions. A 409 or 412 response yields
   `conflicted`; missing responses and 5xx errors yield `unknown`, and other errors yield `failed`.
5. Journals each operation as `applied`, `conflicted`, `failed`, `unknown`, or
   `not attempted`, and reconciles applied working copies with the new
   snapshot.

The Jsonnet backend (`pkg/plugin/jsonnet_eval.go`) is stateless:

- `POST /jsonnet/eval` evaluates with `go-jsonnet`. Imports resolve against the
  workspace files sent with the request first, then the vendored libraries
  embedded under `pkg/plugin/jsonnet/vendor`.
- Requests are limited to 200 files and 4 MiB of input, output is limited to
  4 MiB, and evaluation times out after 20 seconds.
- `POST /jsonnet/fix` rewrites common invalid Grafonnet constructor shapes into
  plain dashboard objects (`jsonnet_ast_repair.go`) and returns the repaired
  source and repair notes.
- Nothing is stored server-side, and the backend never writes dashboards.

## Live Dashboard Editing

In the `grafana-assistant-app` variant, the assistant can apply typed
edits to the currently open dashboard through Grafana's restricted
`dashboardMutationAPI`.

The tools are in `src/pages/Chat/tools/dashboardMutation.ts`. The client comes
from `useRestrictedGrafanaApis()` and is only present when Grafana runs with
the `restrictedPluginApis` feature toggle and allow-lists the plugin ID. When
the client is missing or reports no available commands, the tool factory
returns no tools and the assistant falls back to read-only inspection and the
durable plan/apply path. When the client is present, the session filesystem
also mounts read-only JSON views of the unsaved dashboard under
`/live/dashboard/`.

Read tools: `list_live_dashboard_panels`, `get_live_dashboard_layout`,
`get_live_dashboard_info`, `list_live_dashboard_variables`,
`get_live_dashboard_mutation_schema`.

Typed write tools (each registered only when its underlying command is
available): `rename_live_dashboard_panel`, `update_live_dashboard_panel_query`,
`update_live_dashboard_panel_queries`,
`apply_live_dashboard_prometheus_label_filter`, `add_live_dashboard_panel`, `move_or_resize_live_dashboard_panel`,
`update_live_dashboard_settings`, `add_live_dashboard_variable`,
`update_live_dashboard_variable`, plus a generic
`apply_live_dashboard_mutation` escape hatch that rejects read commands.

Safety flow:

- Live write tools execute without an Assistant approval prompt because they
  change only the currently open unsaved dashboard state. Persisting those
  changes still goes through Grafana's normal dashboard save flow or the
  plan/apply path.
- Layout-affecting edits (`add_live_dashboard_panel`,
  `move_or_resize_live_dashboard_panel`) attach screenshot verification: after
  a successful mutation the tool renders the current dashboard through the
  Grafana image renderer and appends the result (or a `skipped` status) to the
  tool output.

## Model Limits And Context Compaction

Each configured model carries `contextWindow` (default 131072) and
`maxOutputTokens` (default 16384). Both the frontend (`normalizeModelLimits`
in `src/pages/Chat/model.ts`) and the backend (`normalizeModelLimits` in
`pkg/plugin/app.go`) clamp them the same way: the window to 4096–10,000,000
tokens and the output to at least 256 tokens and at most half the window. The
Pi model object receives them as `contextWindow` and `maxTokens`, and the LLM
proxy clamps every request's output budget to the model's `maxOutputTokens`
(`clampRequestMaxTokens`).

The limits are configurable in the plugin settings UI, in provisioning
(`PI_CONTEXT_WINDOW` and `PI_MAX_OUTPUT_TOKENS` in `docker-compose.yaml`), and
through `scripts/configure-pi-model.mjs` and benchmark profiles, which import
Pi's `contextWindow`/`maxTokens` or take `--context-window` and
`--max-output-tokens`.

`ContextCompactor` (`src/pages/Chat/compaction.ts`) is the agent's
`transformContext` hook. It shapes only what is sent to the model; the agent
state and the UI transcript stay complete.

1. The history budget is `contextWindow − maxOutputTokens − fixed tokens
(system prompt and tool schemas) − a 2048-token margin`. Tokens are
   estimated at about four characters per token.
2. Under 80% of the budget, the transcript is sent unchanged, after any
   earlier summary.
3. Over it, large tool results outside the recent window (the last 35% of the
   budget) are elided.
4. If that is still too much, older messages are summarized by the current
   model into a rolling `<conversation_summary>`, extended incrementally. The
   summarizer is told to keep identifiers, paths, queries, and plan IDs
   verbatim. Cuts are placed at message boundaries that do not separate tool
   calls from their results, and the latest message is never summarized.
5. If summarization fails or the result is still too large, the oldest
   messages are dropped.

The compaction state (summary, covered message count, and an anchor
fingerprint that invalidates it when the history changes) is cached per
session, shared across page/sidebar handoff, and persisted with the session.
Compaction events are recorded for benchmarks. The system prompt asks the model
to keep `/session/plan.md` and `/session/findings.md` for long tasks because
those files survive compaction.

## Guardrails

The app uses several overlapping guardrails. Prompts help guide behavior, but
real safety comes from the tool and command surface, transactions, approvals,
and Grafana permissions.

### Access Control

Frontend access is checked in `src/components/App/App.tsx` through
`canUserAccessApp` from `src/utils/access.ts`.

Backend resource access is checked in `pkg/plugin/access.go` with
`withAppAccess`.

Modes:

- `all`: no extra app-level restriction.
- `admins`: org admins only.
- `users`: org admins plus configured logins/emails.
- `rbac`: org admins or users with `g42-pi-app.app:access` (checked through a
  cached authlib enforcement client).

All backend resource routes are wrapped with `withAppAccess`.

### Secret Handling

- API keys are entered with `SecretInput`.
- The key is stored in Grafana `secureJsonData`.
- The frontend only stores `isOpenAIAPIKeySet`.
- The Go backend reads `settings.DecryptedSecureJSONData["openAIAPIKey"]`.
- The browser never sends the provider API key.

### Central Model Configuration

Chat users pick a model from the selector in the chat composer, but only from
the admin-configured list. They cannot choose arbitrary models or base URLs.

Admins configure:

- OpenAI-compatible base URL,
- a model list with one default entry, where each entry carries its own
  protocol, thinking level, thinking format, context window, and maximum
  output tokens,
- system prompt addendum.

The backend validates the client-sent model ID against the configured list and
rejects unknown IDs, so the selector cannot reach unconfigured models.

### Tool Least Privilege

The tool list is fixed and small. Least privilege comes from what the tools
and commands can do, not from per-turn tool selection:

- The shell has no network, process, or link commands, and Python runs in a
  worker with no network access or JavaScript bridge.
- The only remote write path is `workspace apply`. `write`, `edit`, bash, and
  Python can only stage local changes.
- Alert tools and dashboard metric tools are read-only.
- Generated mounts (`meta.json`, the catalog, `/live`, `/artifacts`,
  `/.agents/skills`) are read-only.
- All Grafana calls run as the current user, so Grafana's own dashboard,
  folder, datasource, and alerting permissions apply.

### Explicit Write Approval

`workspace apply` requests approval through the `WorkspaceApprovalService`
wired up in `ChatSceneObject.tsx`. It routes the request to the confirmation
modal (`PERSISTENT_WRITE_TOOLS` contains only this apply approval) and shows the
plan's operations and diff. Denying the modal records an unapproved journal
entry, and the command fails without writing anything.

The approval is bound to the plan digest, and the plan is re-checked for
staleness after approval. It is still a UI callback in the browser, not a
server-side approval bound to actor and expiry (see `ROADMAP.md`).

Live dashboard tools do not require approval because they change only the
unsaved browser state.

### Datasource Allow-List

Admins can restrict Prometheus datasource UIDs.

The allow-list is enforced in the frontend:

- `grafana-prom` and the dashboard metric context tools only discover and
  query allowed Prometheus datasources,
- `grafana-dashboard validate` and `workspace plan` reject dashboards that
  reference disallowed datasource UIDs (built-in UIDs such as `__expr__` and
  `grafana` are exempt).

The backend no longer validates dashboards, so this check is not enforced
server-side.

### Prompt Guardrails

The base system prompt in `src/pages/Chat/systemPrompt.ts` says to:

- use only tool-returned or user-provided datasource UIDs, dashboard UIDs,
  metric names, label keys, and label values,
- validate every PromQL expression with concrete selectors and treat
  `validationError` or zero series as unusable evidence,
- change dashboards only when the user asks, and never claim a change before
  `workspace apply` reports `applied`,
- keep alerting read-only,
- keep durable notes in `/session` for long tasks.

The session filesystem section (`workspace/prompt.ts`) documents the layout,
transaction rules, and command reference. The sidebar page context block and
the dashboard editing capability section tell the model whether live dashboard
tools are available.

### Data Volume Controls

- Query commands summarize data instead of returning raw frames.
- Bash output is truncated at 32 KiB per stream; `read` returns windows of at
  most 2000 lines and 48 KiB.
- Large tool outputs are stored as artifacts with bounded previews.
- `read_artifact`, `read`, and `jq` let the model inspect slices or fields
  instead of re-reading bulky payloads.
- Session artifacts are capped by count and byte size.
- Workspace quotas bound staged files, and context compaction bounds each
  model request.

## Backend Architecture

The backend is a Grafana Go app plugin.

Entry point:

```text
pkg/main.go -> app.Manage(plugin.ID(), plugin.NewApp, ...)
```

The plugin ID defaults to `g42-pi-app` and can be overridden with the
`PI_PLUGIN_ID` environment variable (used by the variant build and Compose
services).

`pkg/plugin/app.go` creates an `App` instance with:

- loaded plugin settings,
- HTTP client (10-minute timeout),
- authz enforcement client cache,
- HTTP resource mux.

Routes are registered in `pkg/plugin/resources.go`:

```text
/llm/stream
/llm/api/stream
/telemetry/events
/jsonnet/eval
/jsonnet/fix
/jsonnet-libs/search
/jsonnet-libs/read
/jsonnet-libs/list
```

The old Jsonnet render/save, virtual-file, and agent-contract routes are gone.
The backend uses Grafana's plugin app client secret only to build the authz
enforcement client for the `rbac` access mode; it no longer calls Grafana
dashboard APIs. Frontend tools that call Grafana through `getBackendSrv()` or
`getDataSourceSrv()`, including dashboard writes, run with the current Grafana
user's normal permissions.

`/telemetry/events` ingests assistant telemetry events (bounded body size and
event count) and exposes them as Prometheus metrics with strict label hygiene.

The health check returns an error when the LLM API key is not configured and OK
when the proxy can be configured.

## Build And Development Tooling

Frontend:

- Node dependency manager: npm.
- Node version: `package.json` requires `>=22`.
- Build: `npm run build`.
- Dev watch: `npm run dev`.
- Typecheck: `npm run typecheck`.
- Lint: `npm run lint`.
- Unit tests: `npm run test:ci`.
- Bundler: webpack through `.config/webpack/webpack.config.ts`, extended by
  `webpack.config.ts`, which also copies the CPython-WASM assets from
  `node_modules/just-bash/vendor/cpython-emscripten` to `dist/cpython/`.

Backend:

- Go module: `go.mod`.
- Grafana plugin SDK build: Mage.
- Linux build scripts:
  - `npm run backend:build:linux-amd64`,
  - `npm run backend:build:linux-arm64`.

Combined/local:

- `mise run dev:reload` rebuilds both artifacts and reloads the default plugin
  ID Docker stack on port 3000.
- `mise run dev:reload:variant` builds the `grafana-assistant-app` variant and
  starts the `assistant-variant` Compose profile on port 3001 (the variant
  service enables the `restrictedPluginApis` feature toggle needed for live
  dashboard editing).
- `mise run dev:reload:variant:seed` additionally seeds manual-test fixtures;
  `mise run dev:reload:variant:fresh` also resets Compose volumes and
  Prometheus demo history.
- `npm run server` runs `docker compose up --build`.
- `npm run validate` packages `dist` and runs the Grafana plugin validator.
- `PLUGIN_VARIANT_ID=grafana-assistant-app npm run package:variant` builds only
  the variant zip and checksum.

Local Docker stack:

- Grafana 13 by default.
- Prometheus with synthetic demo metrics.
- Grafana image renderer for screenshots and live-edit verification.
- Plugin provisioning with a local OpenAI-compatible base URL.
- Prometheus datasource UID `prometheus`.

Benchmarks and e2e tests:

- `npm run benchmark:agent`,
- `npm run benchmark:analysis`,
- `npm run benchmark:dashboard-context`,
- `npm run benchmark:dashboard-editing`,
- `npm run benchmark:dashboard-metric-discovery`,
- `npm run benchmark:alert-troubleshooting`,
- `npm run benchmark:explore-metrics`,
- `npm run e2e`.

## Patterns To Follow When Changing The App

Use these patterns when extending the app:

- Add new Grafana capabilities as workspace commands (with `--help`, a declared
  effect, bounded output, and artifacts for large results) or as files in the
  session filesystem. Add a typed tool only when the shell cannot express the
  capability well.
- Keep the tool list fixed. Use skills for instructions, not for tool selection.
- Keep remote writes behind `workspace plan` and an approved `workspace apply`
  with revision preconditions; everything else only stages local changes.
- Run Grafana calls as the current user through the workspace broker; do not
  add backend paths that write with the plugin service account.
- Prefer JSON working copies for existing dashboards and Jsonnet rendered into
  working copies for new ones; keep live edits typed and verified.
- Keep custom skills non-secret and small enough to fit into model context.
- Regenerate bundled skills after changing `.agents/skills`.
- Use Grafana source or official docs when Grafana API behavior is unclear.
- Use Pi source when agent event, stream, tool hook, or execution behavior is
  unclear.

## First Files To Read

For a quick onboarding path:

1. `README.md`: product behavior and local development.
2. `src/plugin.json`: what Grafana registers.
3. `src/module.tsx`: how the frontend enters Grafana, extension points, and the
   variant gate.
4. `src/components/App/App.tsx`: access check and Scenes app shell.
5. `src/pages/Chat/ChatSceneObject.tsx`: chat UI, agent lifecycle
   (`buildSkillRuntime`, `buildAgent`, `saveSession`), sessions, approvals.
6. `src/pages/Chat/systemPrompt.ts` and `src/pages/Chat/workspace/prompt.ts`:
   top-level behavior rules and the filesystem contract.
7. `src/pages/Chat/tools/index.ts`: the fixed tool list.
8. `src/pages/Chat/workspace/workspace.ts` and `workspace/shell.ts`: the
   session filesystem, transactions, and bash.
9. `src/pages/Chat/workspace/commands/commands.ts` and `workspace/plans.ts`:
   commands and plan/apply.
10. `src/pages/Chat/compaction.ts`: context budgeting.
11. `pkg/plugin/resources.go`: LLM proxy and resource routes.
12. `pkg/plugin/jsonnet_eval.go`: stateless Jsonnet eval and repair routes.
13. `pkg/plugin/access.go`: backend access guard.

## Important Limits

This app reduces risk, but it does not make LLM output inherently trustworthy.
Treat the LLM as a planner that can be wrong. The trustworthy parts are the
checks around it:

- typed tool schemas and a sandboxed shell without network access,
- Grafana user permissions,
- app access checks,
- datasource allow-lists,
- validation before planning,
- explicit approval of an exact, digest-bound plan,
- revision preconditions on every update and delete,
- bounded query output and workspace quotas.

Known gaps: the bash interpreter runs on the main thread (only Python has a
hard kill), approval is a browser callback rather than a server-side binding,
and the datasource allow-list and dashboard validation run only in the
frontend. When adding new capabilities, enforce safety in code and Grafana
permissions, not only in prompts.
