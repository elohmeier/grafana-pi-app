# Observability Analyst Architecture

This repository is a Grafana app plugin that embeds a Pi-powered LLM agent for
observability work. The plugin runs inside Grafana, uses Grafana permissions and
datasources, and proxies LLM calls through a Go backend so API keys stay on the
server side.

The app is easiest to understand as four layers:

```text
Grafana plugin shell
  -> React and Grafana Scenes chat UI
  -> Pi agent runtime in the browser
  -> Go backend resources for secrets, Jsonnet, and dashboard writes
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
class is `Agent`, created in `src/pages/Chat/ChatSceneObject.tsx`. The important
inputs are:

- `systemPrompt`: built from `src/pages/Chat/systemPrompt.ts` plus active
  skills.
- `model`: an OpenAI-compatible model object from `src/pages/Chat/model.ts`.
- `tools`: the tool list selected for the current prompt.
- `streamFn`: a Pi `streamProxy` call that posts to the plugin backend.
- `beforeToolCall`: a hook that can block tool execution before it happens.
- `afterToolCall`: a hook that can transform tool results after they run.

The model never directly touches Grafana, Prometheus, files, or dashboards. It
only emits tool-call JSON. The app decides which tools exist, validates their
arguments, runs the implementation code, and sends back a tool result.

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
- `src/pages/Chat/`: Chat UI, agent setup, skills, prompts, tools, sidebar
  integration, and tests.
- `src/pages/Chat/agentWorkspace/`: Generic external-workspace agent mode for
  the coding agent app contract.
- `pkg/main.go`: Go backend entry point. Grafana starts this binary as the
  plugin backend process.
- `pkg/plugin/`: Backend resource routes, LLM proxy, access checks, Jsonnet
  rendering (`jsonnet_dashboards.go`, `jsonnet_assets.go`), virtual Jsonnet
  files (`virtual_jsonnet_files.go`), structural auto-repair
  (`jsonnet_ast_repair.go`), dashboard validation (`dashboard_validation.go`),
  Jsonnet library browsing (`jsonnet_libs.go`), telemetry metrics, and the
  optional agent contract sample.
- `.agents/skills/`: Repo-local skills bundled into the frontend
  (`grafana-dashboard`, `grafana-alerting`, `investigation`).
- `scripts/generate-bundled-skills.mjs`: Converts `.agents/skills/**/SKILL.md`
  into `src/pages/Chat/skills/bundledSkills.generated.ts`.
- `scripts/package-plugin-variant.mjs`: Builds the `grafana-assistant-app`
  plugin ID variant with extension sidebar declarations.
- `provisioning/`: Local Grafana provisioning for datasources and plugin
  settings.
- `demo/prometheus/`: Synthetic Prometheus demo data.
- `tests/` and `scripts/benchmark-*.mjs`: Playwright and benchmark-style e2e
  tests.
- `docs/coding-agent-app-contract.md`: Protocol for provider apps that hand
  schema-backed resource editing to the assistant.

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
- `iam.permissions` grants the plugin service account enough rights to create,
  read, and write dashboards and folders through Grafana APIs.
- `extensions.addedLinks` declares three dashboard panel menu actions
  (`Explain in Assistant`, `Troubleshoot panel`, `Suggest improvements`).
- `grafanaDependency` is `>=13.0.0`.

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
artifacts, tool runs, approval handler) so a chat can move between the full page
and the sidebar without losing state.

## Chat And Agent Lifecycle

The main file is `src/pages/Chat/ChatSceneObject.tsx`.

On load:

1. The UI reads plugin metadata and configuration with `usePluginMeta()`.
2. It builds OpenAI-compatible Pi model objects from the admin-configured
   model list, using the default entry until the user picks another model.
3. It creates a Pi `streamFn` with `streamProxy`.
4. It creates a new chat session and `Agent`.
5. It loads the saved session index from Grafana plugin user storage.

When a user submits a prompt:

1. `submitPrompt` trims the input and creates a session title if needed.
2. `buildSkillRuntime(prompt)` selects active skills and tool groups.
3. The agent's `systemPrompt`, `tools`, `model`, and `thinkingLevel` are
   replaced in place for this turn, so the model selected in the chat composer
   applies to the next request.
4. `agent.prompt(prompt)` starts the Pi loop.
5. The agent streams model events, tool calls, tool results, and final text.
6. On `agent_end`, the chat session is saved to plugin user storage.

Sessions store:

- agent messages,
- selected model ID (restored into the model selector on load and import),
- virtual Jsonnet file snapshots,
- investigation report state,
- artifacts,
- artifact counter.

Storage is per Grafana user through `usePluginUserStorage()`. The app also
supports chat import and export as JSON.

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

The registry is in `src/pages/Chat/tools/index.ts`.

Tool groups:

- `metrics`: Prometheus datasource discovery, metric metadata, label values,
  series inspection, and summarized PromQL queries.
- `alerts`: read-only Grafana-managed alert rule lookup through the App
  Platform AlertRule API (`find_panel_alert_rules`, `get_alert_rule`).
- `dashboardMetricContext`: read-only dashboard metric usage extraction,
  dashboard corpus search, and seed metric neighborhood ranking.
- `dashboardRead`: list, fetch, screenshot dashboards, and typed dashboard
  context inspection (`inspect_dashboard_context`).
- `liveDashboardEditing`: typed live edits to the currently open dashboard
  through Grafana's restricted dashboard mutation API (variant only).
- `dashboardPlans`: `write_dashboard_plan` for structured plan handoff before
  Jsonnet work.
- `jsonnetFiles`: session virtual Jsonnet write, edit, fix, and read tools
  (selecting this group also pulls in `dashboardPlans`).
- `jsonnetDashboards`: `render_dashboard` and `save_dashboard`.
- `investigation`: update the structured investigation report.
- `subagents`: run focused child agents.
- `skillResources`: read resources attached to active skills.
- `jsonnetLibraries`: browse bundled Jsonnet libraries when enabled.
- `adHocDashboards`: raw dashboard upload/delete when explicitly enabled.
- `artifacts`: `read_artifact`; the artifact tools are appended to every
  selection.

The app does not give every tool to the model all the time. Instead,
`createGrafanaToolsForSkillGroups` selects tools based on active skills and
intent. The raw data-frame query tool `query_prometheus_raw` exists but is only
registered when `includeRawPrometheusQueryTool` is enabled for developer/debug
workflows.

## Skills

Skills are model-facing instructions that activate for a turn.

Bundled skills live under `.agents/skills/`:

- `grafana-dashboard`: dashboard, panel, Jsonnet, render, save, and live-edit
  workflow.
- `grafana-alerting`: read-only troubleshooting of Grafana-managed alert rules,
  especially rules linked to dashboard panels.
- `investigation`: evidence-based incident investigation workflow.

`npm run generate:skills` runs `scripts/generate-bundled-skills.mjs`, which:

- validates each `SKILL.md`,
- reads text resources from `references/`, `templates/`, and `assets/`,
- writes `src/pages/Chat/skills/bundledSkills.generated.ts`.

Skill selection is in `src/pages/Chat/skills/selection.ts`. Tool groups per
bundled skill are assigned in `src/pages/Chat/skills/catalog.ts`.

Activation rules:

- Users can explicitly name a skill with `$skill-name`.
- Dashboard keywords activate `grafana-dashboard`; in the sidebar, being on a
  dashboard plus contextual edit intent also activates it.
- Investigation/root-cause/incident keywords activate `investigation`.
- Alert keywords activate `grafana-alerting`; panel context plus
  firing/warning/alert wording also activates it.
- Admin-configured custom skills can activate by keyword or regex unless they
  are `explicitOnly`.
- A prompt that is an exact specialist delegation sequence forces
  supervisor-only mode (`subagents` group only).

The rendered system prompt lists available skills, includes active skill
content, and exposes active skill resources through `read_skill_resource`.

Custom skills are stored in `jsonData`. They are non-secret configuration and
are sent to the model when active.

## Specialist Subagents

The top-level assistant is a supervisor. It can delegate work to child agents
through subagent tools in `src/pages/Chat/tools/subagents.ts`.

Specialists:

- `run_query_agent`: Prometheus discovery and PromQL validation.
- `run_dashboard_agent`: dashboard design, Jsonnet, render, save, and live-edit
  workflow.
- `run_investigation_agent`: incident/root-cause analysis and report updates.
- `run_alert_agent`: read-only alert-vs-panel troubleshooting through the App
  Platform AlertRule API.
- `run_support_agent`: Grafana and observability explanations.
- `run_navigation_agent`: safe Grafana navigation and link building.

Each specialist is another Pi `Agent` created by
`src/pages/Chat/tools/subagentRunner.ts`, but with:

- a narrow system prompt,
- a narrow tool allow-list,
- the same currently selected model and backend `streamFn`,
- the same write-approval hook,
- a per-specialist child tool-call budget enforced in the child
  `beforeToolCall`.

Tool-call budgets:

- query: 14,
- dashboard: 24,
- investigation: 20,
- alerts: 18,
- support: 6,
- navigation: 4.

Dashboard specialists also get up to three follow-up nudges when a
create/update task has not completed the expected `write_dashboard_plan`,
`write_jsonnet` or `edit_jsonnet`, `render_dashboard`, and `save_dashboard`
sequence (skipped when a live-mutation tool or `save_dashboard` already
succeeded, or the task is review/draft/live-edit only).

This pattern keeps the top-level agent focused and makes broad tasks safer:
specialists can only use the tools needed for their job.

## Metrics And Prometheus Tools

Metrics tools are in `src/pages/Chat/tools/metrics.ts`.

They use Grafana's frontend datasource service, so they run as the current
Grafana user and respect datasource visibility.

Main tools:

- `list_datasources`: list visible and allowed Prometheus datasources.
- `list_metrics`: list metric names, optionally by prefix.
- `list_label_values`: list values for a label, optionally scoped by selector.
- `inspect_metric_series`: inspect label names and example series.
- `query_prometheus`: run instant or range PromQL through Grafana and return a
  compact validation summary.
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
- The default query tool returns min/max/last/sample summaries, not full raw
  data frames.
- Raw Prometheus data frames are behind `query_prometheus_raw`, which is only
  enabled for developer/debug workflows.
- Lists and query results are truncated.
- Range queries use bounded `maxDataPoints`.
- Tool descriptions instruct the model to inspect metrics and labels before
  inventing selectors.

## Alerting Tools

Alert tools are in `src/pages/Chat/tools/alerts.ts` and are strictly read-only:

- `find_panel_alert_rules`: reads AlertRule resources from
  `/apis/rules.alerting.grafana.app/v0alpha1` and links them to a panel through
  `spec.panelRef` and the `__dashboardUid__`/`__panelId__` annotations.
- `get_alert_rule`: reads one AlertRule and returns a normalized expression
  plus `prometheusChecks` PromQL suggestions the model can run through
  `query_prometheus` to compare alert conditions against panel data.

There are no alert create, update, pause, silence, or delete tools. The
`grafana-alerting` skill and the `run_alert_agent` specialist both mandate
read-only troubleshooting.

## Dashboard Architecture

The app supports three dashboard paths:

1. Read-only dashboard inspection.
2. Durable dashboard creation/update through Jsonnet.
3. Ephemeral live edits to the currently open dashboard (variant only, see the
   next section).

Read tools are in `src/pages/Chat/tools/dashboards.ts`:

- `list_dashboards`,
- `get_dashboard`,
- `screenshot_dashboard`,
- `inspect_dashboard_context` (typed panel/layout/variable context from
  `src/pages/Chat/tools/dashboardContext.ts`).

Raw dashboard writes exist but are not part of the default chat toolset:

- `upload_dashboard`,
- `delete_dashboard`.

The preferred durable write path is Jsonnet.

Jsonnet dashboard frontend tools are in
`src/pages/Chat/tools/jsonnetDashboards.ts` and
`src/pages/Chat/tools/dashboardPlans.ts`:

- `write_dashboard_plan`,
- `render_dashboard`,
- `save_dashboard`.

Session virtual Jsonnet files are handled by
`src/pages/Chat/tools/jsonnetFiles.ts`:

- `write_jsonnet`,
- `edit_jsonnet`,
- `fix_jsonnet`,
- `read_jsonnet`.

Backend dashboard resource code is in `pkg/plugin/jsonnet_dashboards.go` and
`pkg/plugin/virtual_jsonnet_files.go`.

Jsonnet dashboard flow:

```text
model asks for dashboard
  -> dashboard skill activates
  -> dashboard specialist validates metrics
  -> write_dashboard_plan records the plan
  -> write_jsonnet creates session dashboard.jsonnet
  -> render_dashboard compiles Jsonnet without saving
  -> save_dashboard saves through the Grafana dashboards API
```

Backend behavior:

- Jsonnet is compiled with `go-jsonnet`.
- Vendored Jsonnet libraries are embedded under `pkg/plugin/jsonnet/vendor`;
  imports are confined to that embedded tree.
- Jsonnet source is limited to 200 KiB.
- Virtual Jsonnet file paths must be relative and end with `.jsonnet` or
  `.libsonnet`.
- Edits are transactional, version-aware, line-based, support optional
  `expectedText` checks, and must compile before being committed.
- Common invalid Grafonnet constructor shapes can be auto-repaired
  (`jsonnet_ast_repair.go`); auto-repair only runs when the source came from a
  virtual file.
- Rendered dashboards are classic dashboard JSON (`schemaVersion` 39) saved
  through the Grafana `/api/dashboards/db` HTTP API with the plugin service
  account token.
- The backend requires a title, derives/normalizes the UID, deletes `id`,
  forces `editable: true`, and forces the `genai` tag plus any requested tags.
- `validateAndNormalizeDashboard` assigns panel IDs, normalizes grid layout
  (missing positions, overflow, collisions), and warns on missing panel titles
  and uncontrolled table columns.
- Datasource UIDs in dashboard JSON are checked against the configured allow
  list on the backend before render and save.

## Live Dashboard Editing

In the `grafana-assistant-app` variant, the assistant can apply approved typed
edits to the currently open dashboard through Grafana's restricted
`dashboardMutationAPI`.

The tools are in `src/pages/Chat/tools/dashboardMutation.ts`. The client comes
from `useRestrictedGrafanaApis()` and is only present when Grafana runs with
the `restrictedPluginApis` feature toggle and allow-lists the plugin ID. When
the client is missing or reports no available commands, the tool factory
returns no tools and the assistant falls back to read-only inspection and the
durable Jsonnet path.

Read tools: `list_live_dashboard_panels`, `get_live_dashboard_layout`,
`get_live_dashboard_info`, `list_live_dashboard_variables`,
`get_live_dashboard_mutation_schema`.

Typed write tools (each registered only when its underlying command is
available): `rename_live_dashboard_panel`, `update_live_dashboard_panel_query`,
`add_live_dashboard_panel`, `move_or_resize_live_dashboard_panel`,
`update_live_dashboard_settings`, `add_live_dashboard_variable`,
`update_live_dashboard_variable`, plus a generic
`apply_live_dashboard_mutation` escape hatch that rejects read commands.

Safety flow:

- Live write tools execute without an Assistant approval prompt because they
  change only the currently open unsaved dashboard state. Persisting those
  changes still goes through Grafana's normal dashboard save flow.
- Layout-affecting edits (`add_live_dashboard_panel`,
  `move_or_resize_live_dashboard_panel`) attach screenshot verification: after
  a successful mutation the tool renders the current dashboard through the
  Grafana image renderer and appends the result (or a `skipped` status) to the
  tool output.
- Live edits change the open dashboard in the browser; persisting them still
  goes through Grafana's own save flow or the managed Jsonnet path.

## Agent Workspace And The Coding Agent App Contract

`docs/coding-agent-app-contract.md` defines a browser-first protocol that lets
another "provider app" hand schema-backed resource editing to the assistant.
The provider backend stays authoritative for access checks, schemas,
validation, and persistence; the assistant edits an overlay-based virtual file
system in the browser.

The frontend side is `src/pages/Chat/agentWorkspace/`. When a chat is launched
with an agent workspace reference, `buildSkillRuntime` bypasses the Grafana
skill and tool system entirely and gives the agent only workspace tools
(`workspace_info`, `ls`, `find`, `grep`, `read`, `edit`, `write`, `get_schema`,
`validate_workspace`, `preview_diff`, `save_changes`, optional `bash`).
`save_changes` and `submit_changes` are write-approval gated.

The backend ships an optional in-memory reference provider in
`pkg/plugin/agent_contract_sample.go`. It is disabled by default and enabled
with the `enableAgentContractSample` setting or the `PI_AGENT_CONTRACT_SAMPLE`
environment variable; only then are the `/agent/*` routes registered.

## Guardrails

The app uses several overlapping guardrails. Prompts help guide behavior, but
real safety comes from tool selection, runtime hooks, backend checks, and
Grafana permissions.

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
  protocol, thinking level, and thinking format,
- system prompt addendum.

The backend validates the client-sent model ID against the configured list and
rejects unknown IDs, so the selector cannot reach unconfigured models.

### Tool Least Privilege

Every prompt rebuilds the tool list.

For normal prompts, the base tool groups are `metrics`,
`dashboardMetricContext`, and `subagents`; the artifact tools are always
appended. Direct dashboard read, live-edit, Jsonnet, and alert tools are added
to the parent agent only when the matching skills are active. Before the first
prompt (and in supervisor-only mode) the agent has only subagent and artifact
tools.

The dashboard specialist subagent is available as a delegation route, but it has
its own narrow prompt, tool-call budget, write-approval hook, and backend checks.
Raw dashboard upload and delete tools are not exposed unless the
`adHocDashboards` group is enabled.

### Explicit Write Approval

`beforeToolCall` in `ChatSceneObject.tsx` opens a confirmation modal for
persistent write tools (`PERSISTENT_WRITE_TOOLS`):

- `save_dashboard`,
- `upload_dashboard`,
- `delete_dashboard`,
- `save_changes` and `submit_changes` (agent workspace),
- every live dashboard write tool.

If the user denies the modal, the tool call is blocked and the model receives a
tool error result.

### Datasource Allow-List

Admins can restrict Prometheus datasource UIDs.

The allow-list is enforced in two places:

- frontend metric tools only discover/query allowed Prometheus datasources,
- backend Jsonnet dashboard render and save reject dashboard JSON that
  references disallowed datasource UIDs (built-in UIDs such as `__expr__` and
  `grafana` are exempt).

### Prompt Guardrails

The base system prompt in `src/pages/Chat/systemPrompt.ts` says to:

- use only tool-returned or user-provided datasource UIDs, dashboard UIDs,
  metric names, label keys, and label values,
- prefer focused tool calls over speculation,
- avoid persistent dashboard changes unless explicitly requested,
- present specialist results as concise answers.

Specialist prompts add narrower rules for query, dashboard, investigation,
alert, support, and navigation work. The sidebar page context block instructs
the model to prefer live dashboard tools only when they are available and the
user explicitly asks for on-the-fly edits.

### Data Volume Controls

- Query tools summarize data instead of returning raw frames by default.
- Tool results are truncated.
- Large outputs can be stored as artifacts.
- `read_artifact` lets the model inspect slices, fields, or `jq` results rather
  than re-reading bulky payloads.
- Session artifacts are capped by count and byte size.

### Jsonnet Controls

- Virtual Jsonnet writes require a chat session ID.
- Paths are normalized and restricted.
- Edits can include `baseVersion` and `expectedText`.
- Edited and repaired Jsonnet must compile before being accepted.
- `render_dashboard` previews a dashboard resource without saving.
- `save_dashboard` is the only normal Jsonnet dashboard persistence step.

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
- in-memory session-scoped virtual Jsonnet file store,
- optional agent contract sample store,
- authz enforcement client cache,
- HTTP resource mux.

Routes are registered in `pkg/plugin/resources.go`:

```text
/llm/stream
/llm/api/stream
/telemetry/events
/jsonnet-dashboards/render
/jsonnet-dashboards/save
/jsonnet-dashboards/jsonnet-files/write
/jsonnet-dashboards/jsonnet-files/edit
/jsonnet-dashboards/jsonnet-files/repair
/jsonnet-dashboards/jsonnet-files/read
/jsonnet-libs/search
/jsonnet-libs/read
/jsonnet-libs/list
/agent/capabilities        (only when the contract sample is enabled)
/agent/workspaces          (only when the contract sample is enabled)
/agent/workspaces/...      (only when the contract sample is enabled)
```

The backend uses Grafana's plugin app client secret when it needs server-side
Grafana API access, for example saving dashboards through `/api/dashboards/db`.
That means dashboard saves are controlled by app access, the plugin service
account permissions in `plugin.json`, explicit write approval, and the backend
validation checks. By contrast, frontend tools that call Grafana through
`getBackendSrv()` or `getDataSourceSrv()` run with the current Grafana user's
normal permissions.

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
- Bundler: webpack through `.config/webpack/webpack.config.ts`.

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

- Add new model capabilities as tools, not as direct model access to APIs.
- Give tools tight TypeBox schemas and bounded outputs.
- Put persistent or privileged behavior behind `beforeToolCall` or backend
  checks.
- Keep datasource and dashboard write checks on the backend when possible.
- Add tools to a named tool group, then activate that group through skills or
  specialist agents.
- Keep specialist agents narrow. Give them only the tools needed for the task.
- Prefer Jsonnet-backed dashboards for durable dashboard changes; keep live
  edits typed and verified.
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
5. `src/pages/Chat/ChatSceneObject.tsx`: chat UI, agent lifecycle, sessions,
   approvals.
6. `src/pages/Chat/systemPrompt.ts`: top-level behavior rules.
7. `src/pages/Chat/tools/index.ts`: capability groups.
8. `src/pages/Chat/tools/subagents.ts`: specialist routing.
9. `src/pages/Chat/skills/selection.ts`: skill activation and tool group
   selection.
10. `pkg/plugin/resources.go`: LLM proxy and resource routes.
11. `pkg/plugin/jsonnet_dashboards.go`: dashboard render/save path.
12. `pkg/plugin/access.go`: backend access guard.

## Important Limits

This app reduces risk, but it does not make LLM output inherently trustworthy.
Treat the LLM as a planner that can be wrong. The trustworthy parts are the
checks around it:

- typed tool schemas,
- Grafana user permissions,
- app access checks,
- datasource allow-lists,
- explicit write approvals,
- backend dashboard validation,
- bounded query output,
- render-before-save workflow.

When adding new capabilities, enforce safety in code and backend permissions,
not only in prompts.
