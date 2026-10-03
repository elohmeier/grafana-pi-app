# Observability Analyst Architecture

This repository is a Grafana app plugin that embeds a Pi-powered LLM agent for
observability work. The plugin runs inside Grafana, uses Grafana permissions and
datasources, and proxies LLM calls through a Go backend so API keys stay on the
server side.

The app is easiest to understand as four layers:

```text
Grafana plugin shell
  -> React and Grafana Scenes chat UI
  -> Pi Durable harness and session filesystem in the browser, one per chat
  -> Go backend resources for secrets, the LLM proxy, Jsonnet evaluation, and chat logs
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

In this app the loop is the Pi Durable harness (`@earendil-works/pi-durable`).
Each chat is one harness, opened by `AssistantSession`
(`src/pages/Chat/session/AssistantSession.ts`) over the chat's commit log. The
harness runs every model request, tool call, and compaction as a durable task
that stores a checkpoint before it moves on. Its inputs are:

- an extension (`src/pages/Chat/durable/extension.ts`) with the fixed tools and
  the system prompt sections of the current turn, read from the `app.turn`
  document (base prompt with active skills from `systemPrompt.ts`, the session
  filesystem section, launch and page context). The harness stores prompt and
  tool changes as positional system entries and sends only what changed.
- `models`: a pi-ai model collection with one provider, `grafana`
  (`src/pages/Chat/durable/models.ts`), whose catalog is the configured model
  list with each model's `contextWindow` and `maxTokens`, and whose stream is
  a Pi `streamProxy` call to the plugin backend.
- `settings`: compaction thresholds scaled to the chat's model
  (`src/pages/Chat/durable/settings.ts`).
- storage: `LogStorage` (`src/pages/Chat/durable/logStorage.ts`), see
  [Chat Storage](#chat-storage).

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
- `src/pages/Chat/`: Chat UI, session, skills, prompts, typed tools, sidebar
  integration, and tests.
- `src/host/`: the assistant host, a Node service (bundled by
  `scripts/build-host.mjs`, not part of the plugin) that runs the same
  `AssistantSession` for Mattermost threads and Grafana alert notifications.
- `src/pages/Chat/durable/`: The Pi Durable integration: chat log client and
  storage, model provider, extension, documents, harness settings, and the
  transcript projection the UI renders.
- `src/pages/Chat/workspace/`: The session filesystem, its mounts and
  transactions, the `read`/`write`/`edit`/`bash` tools, shell commands
  (`commands/`), direct apply (`apply.ts`), the Grafana broker
  (`grafanaBroker.ts`), and CPython-WASM support (`python/`).
- `src/pages/Chat/domain/`: Domain logic behind the shell commands (dashboard
  metric usage, alerts, navigation, screenshots,
  artifacts) and shared Prometheus helpers.
- `pkg/main.go`: Go backend entry point. Grafana starts this binary as the
  plugin backend process.
- `pkg/chatlog/`: Chat log store on SQLite (default) or PostgreSQL.
- `pkg/plugin/`: Backend resource routes, LLM proxy, chat routes, access checks, stateless
  Jsonnet evaluation and structural repair (`jsonnet_eval.go`,
  `jsonnet_assets.go`, `jsonnet_ast_repair.go`), Jsonnet library browsing
  (`jsonnet_libs.go`), and telemetry metrics.
- `assistant/skills/`: Product skills bundled into the frontend, outside coding-agent discovery
  (`grafana-dashboard`, `grafana-alerting`, `investigation`).
- `scripts/generate-bundled-skills.mjs`: Converts `assistant/skills/**/SKILL.md`
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
- `iam.permissions` grants the plugin service account only
  `users.permissions:read`, which the backend's authz client needs to check
  app access. Dashboard reads and writes run in the browser as the current
  user, so the service account has no dashboard or folder permissions.
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

`src/pages/Chat/chatRunRegistry.ts` keeps sessions whose run continues without a
view, so a chat can move between the full page and the sidebar mid-run.

## Chat And Agent Lifecycle

`session/AssistantSession.ts` is one chat, independent of React. It owns:

- identity and title (a new chat is titled from its first prompt or `!` command),
- the launch context (dashboard panel action or `@grafana/assistant` launch),
  which reaches the model with the first prompt only,
- the chat's harness: opened with the first prompt or command of a new chat, or
  when a stored chat is shown; its conversation, view, and event stream,
- `prompt()` (stores the turn's prompt in `app.turn`, the model choice in
  `pi.agent`, and submits the input), `runUserShell()` (`!command` in the
  composer, appended as an `app.shell` entry), `abort()`, and `stop()`,
- the session filesystem, artifacts, approval channel, and catalog cache,
- the projected transcript (`durable/transcript.ts`): messages from the
  transcript entries, including those before a compaction, the streamed
  partial, tool progress from `pi.live`, the run status, and compaction
  summaries,
- the storage state: new, opening, open, or lost (the chat was opened
  elsewhere, deleted, or could not be stored).

Views read this through `getState()`/`subscribeState()` and run events (shaped
like the Pi coding agent's, from `watchEvents()`, see `agentEvents.ts`) through
`subscribe()`. A view attaches as the session's `SessionHost` (`attach(host)`):
the host supplies the environment for each prompt, tool call, and shell command
(stream function, model, Grafana broker, skills, Python runner, live dashboard
API, page context), the chat log client, and telemetry hooks. The core has no
imports from React, Scenes, or `@grafana/runtime`. React (`ChatSceneObject.tsx`)
owns navigation, the chat list, scrolling, the composer, the leave guard, and
rendering.

The run belongs to the harness, not to the view: a reload or closed tab
interrupts it, and opening the chat again continues it. Page/sidebar handoffs
share the same session instance through `chatRunRegistry.ts`, so a run keeps
going while the view changes. Leaving a chat through the leave guard aborts its
run.

Tools are always `read`, `write`, `edit`, and `bash`. The catalog mount survives
toolkit rebuilds and retains its TTL cache. `/session/context.json` contains the
captured route, dashboard launch, capabilities, and visible Prometheus datasources.
It is read-only, as are `/session/receipts/` and the other generated mounts.

## Chat Storage

Each chat is stored as its commit log in the plugin backend (`pkg/chatlog`,
routes in `pkg/plugin/chats.go`), per Grafana user (identity token verified
against Grafana's signing keys), in an embedded SQLite file by default or in a
PostgreSQL schema for HA deployments. See [chat storage](docs/chat-storage.md).

- `LogStorage` keeps the chat in a Pi Durable `MemoryStorage` and sends every
  commit to `POST /chats/{id}/commits` before applying it. Opening a chat
  replays `GET /chats/{id}/log`.
- `POST /chats/{id}/open` makes the caller the chat's only writer (a new
  epoch); commits from an earlier writer are refused, which stops that view's
  harness. Commits carry the next sequence number and a digest, so a retry after
  a lost response is recognized.
- Rows that supersede earlier ones (task records, submissions, the content of
  latest-only documents such as the streamed partial) carry a replacement key,
  and the backend deletes their predecessors.
- The session filesystem, artifacts, and apply journal are the `app.workspace`
  document, committed after every tool call and shell command.

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
- replays the system messages of the Pi transcript (prompt `content`, named
  `sections`, `toolsAdded`/`toolsRemoved`) into one leading system prompt and
  the current tool list, and still accepts the older `systemPrompt`/`tools`
  request fields,
- translates Pi proxy messages and tool schemas into the selected protocol,
- preserves Responses `call_id`/item IDs and encrypted reasoning items across
  tool turns while keeping `store: false`, and sends only the call ID part of
  those IDs to Chat Completions,
- applies the configured thinking level using Responses `reasoning.effort`, or
  the configured Chat Completions format:
  - OpenAI: `reasoning_effort`,
  - Qwen: `enable_thinking`,
  - Qwen chat template: `chat_template_kwargs.enable_thinking`,
- relays Chat Completions chunks or typed Responses server-sent events back to
  Pi proxy events, with the parsed tool call on `toolcall_end`; upstream error
  chunks and streams that end without a finish reason become `error` events,
  and a canceled request ends as `aborted`,
- records Prometheus metrics for requests, tokens, and proposed tool calls.

`pkg/plugin/llm_protocol_parity_test.go` checks that the same model output
reaches Pi as the same events through either protocol.

This is the main secret boundary. The OpenAI-compatible API key lives in
Grafana `secureJsonData`, is decrypted only for the backend plugin, and is never
put into frontend `jsonData`.

## Tool System

Tools are defined in `workspace/tools.ts` (`WORKSPACE_TOOL_DEFINITIONS`). Each
tool has:

- `name`: what the model calls.
- `label`: human-readable UI label.
- `description`: model-facing instructions for when to call it.
- `parameters`: TypeBox schema used to validate arguments.
- `replay`: whether a call a reload interrupted may run again. Only `read` is
  `safe`; for `write`, `edit`, and `bash` the model is told the call was
  interrupted, because the call may already have changed files or Grafana.
- `execute`: code that runs after validation.

The extension registers them with the harness, which runs each call as a
durable task; the registered tool resolves the session's current toolkit
(`createWorkspaceTools`, bound to the attached view's Grafana capabilities) at
each call and commits the session filesystem after it. The list is the same on
every turn:

- `read`, `write`, `edit`, `bash`: the session filesystem tools from
  `src/pages/Chat/workspace/tools.ts`. Discovery, PromQL queries, dashboard
  editing, validation, Jsonnet, dashboard-derived metric usage
  (`grafana-usage`), alert lookups and validation (`grafana-alert`), the investigation report
  (the Markdown file `/session/report.md`, rendered next to the chat),
  navigation (`grafana open`), screenshots
  (`grafana-dashboard screenshot`), and writes all happen here.
- Nothing else: live dashboard edits are the `live` command over
  `/live/dashboard/dashboard.json` (see [Live Dashboard Editing](#live-dashboard-editing)).

Skills do not add or remove tools.

Commands reach Grafana only through the typed `WorkspaceBroker` capabilities
(`workspace/broker.ts`); the domain logic stays in `src/pages/Chat/domain/`. A
command can return images (`CommandResult.images`); the bash tool attaches
them to its result after the text, so the model sees a screenshot like any
other tool image. Commands with bulky output (`grafana-prom query`,
`grafana-dashboard data`, `grafana-usage`) also register an artifact under
`/artifacts`, readable with `read` and `jq`.

## Session Filesystem

`SessionWorkspace` (`src/pages/Chat/workspace/workspace.ts`) is one persistent
virtual filesystem per chat. It keeps canonical resource snapshots separate
from local overlays and scratch files.

| Path                                          | Kind                                 | Behavior                                                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/grafana/dashboards/<uid>/dashboard.json`    | resource                             | Working copy of the dashboard resource (`{apiVersion, kind, metadata, spec}`). Every visible dashboard is listed; content is fetched on first read through the dashboard App Platform API as the current user. Writes stage an overlay. |
| `/grafana/dashboards/<uid>/meta.json`         | generated, read-only                 | Provider-owned metadata: revision (`resourceVersion`), folder, API version, and managed-by.                                                                                                                                             |
| `/grafana/catalog/dashboards.ndjson`          | generated, read-only                 | Metadata of every dashboard visible to the user (uid, title, folder, tags), cached for 5 minutes. The same listing is the index behind `/grafana/dashboards`.                                                                           |
| `/grafana/catalog/coverage.json`              | generated, read-only                 | Dashboard count and when the listing was loaded.                                                                                                                                                                                        |
| `/grafana/alert-rules/<uid>/rule.json`        | resource                             | Working copy of a Grafana-managed alert rule (`{apiVersion, kind, metadata: {name, folder annotation}, spec}`). Every visible rule is listed and served from one paginated App Platform listing. Writes stage an overlay.               |
| `/grafana/alert-rules/<uid>/meta.json`        | generated, read-only                 | Provider-owned metadata: revision, folder, evaluation group and position, provenance (`managedBy`), and `preconditions: client`.                                                                                                        |
| `/grafana/catalog/alert-rules.ndjson`         | generated, read-only                 | Every visible alert rule (uid, title, folder, group, labels, provenance, linked dashboard and panel), cached for 5 minutes. The same listing is the index behind `/grafana/alert-rules`.                                                |
| `/live/dashboard/dashboard.json`, `info.json` | generated; `dashboard.json` writable | Unsaved state of the dashboard open in the browser as a v2 resource (variant only). Edits stage a non-persisted overlay that `live apply` applies to the browser.                                                                       |
| `/workspace`                                  | scratch, persisted                   | Default working directory.                                                                                                                                                                                                              |
| `/session`                                    | scratch, persisted                   | Durable notes, such as `findings.md`.                                                                                                                                                                                                   |
| `/tmp`                                        | scratch                              | Not persisted and not counted against the stored session budget.                                                                                                                                                                        |
| `/artifacts`                                  | generated, read-only                 | `index.ndjson` and one JSON file per artifact.                                                                                                                                                                                          |
| `/.agents/skills`                             | generated, read-only                 | `SKILL.md` and resources of bundled and custom skills.                                                                                                                                                                                  |

Invariants:

- Every mutation path (`write`, `edit`, bash, commands, python) goes through a
  copy-on-write `WorkspaceTransaction`. A tool call or bash invocation is one
  transaction: its changes are committed together, or discarded on timeout,
  cancellation, or a failed policy or quota check.
- Read commands inspect `WorkspaceTransaction.view()` without committing. Only
  explicit `workspace apply` and `live apply` cross a checkpoint boundary. A later
  abort discards uncommitted writes and reports any earlier committed changes.
- Paths are normalized and length-limited. Symlinks and hard links are rejected.
- There are no count limits on dashboards, files, or apply batches. The one
  quota (`DEFAULT_WORKSPACE_LIMITS` in `workspace/types.ts`) is 8 MiB for the
  scratch files stored with the session (`/workspace`, `/session`). Unmodified
  dashboards are not stored; working copies are stored as their base plus a
  patch.
- `read` returns a content revision; `write` and `edit` accept it to reject
  concurrent changes. `edit` applies exact-match replacements atomically.
- Every visible dashboard is listed under `/grafana/dashboards` from the catalog
  index, before its content is fetched, so `rg`, `grep -r`, `find`, and globs
  cover all of them. A scan (three unloaded dashboards touched in one
  invocation) fetches the rest in parallel (8 at a time); waiting on fetches does
  not count against the bash timeout. Fetched content stays in memory for the
  chat. The worker receives the path list only when it changes and answers
  lookups of unlisted paths (such as the ignore files `rg` probes) without a
  round trip.
- `grafana-dashboard queries [PATH...] [--metric NAME] [--match REGEX] [--ds UID]`
  lists panel and variable queries of classic and v2 dashboards as NDJSON with
  the jq path of each query text; without PATH it covers every dashboard.

## Bash And Workspace Commands

The user can use the same shell: composer input that starts with `!` runs
through `runShell` from `createSessionWorkspaceToolkit`, with the same commands,
transaction, and approvals, but without a model call. The result is appended
to the transcript as an `app.shell` entry that carries the result for the view
(rendered like a bash result) and a user message for the model, so the agent
sees the command and its output on the next prompt.

`runWorkspaceBash` (`src/pages/Chat/workspace/shell.ts`) runs the just-bash
browser bundle (`just-bash/browser`) against the transaction through
`WorkspaceBashFs`. Shell variables and the working directory reset per call;
files persist. The default timeout is 30 seconds (maximum 120 seconds), output
is truncated at 32 KiB per stream, and just-bash execution limits bound
commands, loops, and `awk`/`sed` iterations. The interpreter and jq WASM run in a dedicated Web Worker. The host terminates
the worker on timeout or cancellation. Filesystem RPC remains inside the host
transaction; domain commands, Python, and approvals execute through host adapters.

Built-in commands include coreutils, `find`, `rg`, `grep`, `sed`, `awk`,
`yq`, `diff`, and `xargs`. There are no network, process, or link commands.
`jq` is not just-bash's reimplementation but jq 1.8 compiled to WebAssembly
(`workspace/jqCommand.ts`, backed by `jq-wasm`); input, `-f`, `--slurpfile`,
and `--rawfile` files are read through the transaction. `WorkspaceBashFs`
treats `/dev/null` as a sink.

Workspace commands are declared in `workspace/commands/commands.ts` and
`workspace/commands/jsonnet.ts`, `alerts.ts`, and `metricUsage.ts` through a small registry
(`commands/registry.ts`) that provides option parsing, `--help`, and a
declared effect (`local-read`, `local-stage`, `remote-read`, `remote-write`).
The system prompt lists them from the same registry.

| Command                                                 | Purpose                                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grafana search [QUERY] [--tag] [--folder]`             | Bounded remote dashboard search that reports coverage.                                                                                                                                                  |
| `grafana fetch UID...`, `grafana refresh [UID...]`      | Hydrate dashboards into working copies, or re-fetch their base.                                                                                                                                         |
| `grafana-prom datasources`                              | Allowed Prometheus datasources.                                                                                                                                                                         |
| `grafana-prom metrics\|labels\|series`                  | Metric names, label names or values, and series label sets.                                                                                                                                             |
| `grafana-prom query EXPR \| -e EXPR... [--range]`       | Instant or range PromQL with compact summaries; several `-e` expressions run in one call. Results are also stored as artifacts.                                                                         |
| `grafana-logs sources\|fields`                          | Log datasources from the policy; fields of an index and which are visible (non-text).                                                                                                                   |
| `grafana-logs count [-q Q] [--by F] [--interval I]`     | Elasticsearch document counts, time series, and groups on visible fields, with exactness and shard coverage.                                                                                            |
| `grafana-logs search [-q Q] [--limit N]`                | Documents as NDJSON: visible fields only, or complete when they match an unrestricted condition.                                                                                                        |
| `grafana-sql sources\|tables\|columns`                  | SQL datasources and tables from the policy; columns of a table and which are visible.                                                                                                                   |
| `grafana-sql count TABLE [--where] [--by] [--interval]` | MSSQL row counts, time buckets, and groups on visible columns, filtered by any column.                                                                                                                  |
| `grafana-sql rows TABLE [--where] [--limit N]`          | Rows as NDJSON with visible columns only.                                                                                                                                                               |
| `grafana-dashboard inspect PATH`                        | Panels, queries, variables, and datasources of a dashboard file.                                                                                                                                        |
| `grafana-dashboard fix PATH`                            | Explicit classic layout repair (panel IDs, `gridPos`, overlaps), reviewable with `workspace diff`.                                                                                                      |
| `grafana-dashboard validate PATH... [--server]`         | JSON, envelope, structure, PromQL syntax (upstream parser), and allow-list checks; `--server` dry-runs the save in Grafana.                                                                             |
| `grafana-dashboard data PATH [--panel ID]...`           | Runs panel queries as the user and applies transformations, overrides, units, and reducers; bounded per-panel status and rows.                                                                          |
| `jsonnet [eval] FILE [-o OUT] [--resource UID]`         | Evaluate workspace Jsonnet in the backend. `--resource` wraps the result in a dashboard resource envelope.                                                                                              |
| `jsonnet fix FILE`                                      | Structural Grafonnet repair in place. The vendored libraries are read-only files under `/lib/jsonnet/<import path>`.                                                                                    |
| `workspace status\|diff\|discard`                       | Staged resource changes, usage, and limits.                                                                                                                                                             |
| `workspace apply\|receipts`                             | Validate, approve, apply changes, and inspect receipts (see [Dashboard Changes](#dashboard-changes-direct-apply)).                                                                                      |
| `grafana open dashboard UID\|explore EXPR\|/PATH`       | Open a dashboard, a Prometheus Explore query, or a Grafana-relative path in the browser.                                                                                                                |
| `grafana-dashboard screenshot UID\|PATH`                | Render the saved dashboard or one panel with the image renderer; the image is attached to the bash result. Refused for panels of datasources other than allowed Prometheus, expressions, and test data. |
| `grafana-dashboard add-panel\|set-panel PATH`           | Typed panel edits on any dashboard file (working copy or live): title, queries by refId, unit, type, position; classic and v2.                                                                          |
| `grafana-usage dashboard\|search\|related`              | Dashboard-derived Prometheus metric usage and related metrics (see [Metrics](#metrics-and-prometheus)).                                                                                                 |
| `grafana-alert find\|get\|validate`                     | Alert rules linked to a panel with PromQL checks, and validation of rule working copies (see [Alert Rules](#alert-rules)).                                                                              |

Commands reach Grafana through the `WorkspaceBroker` in
`workspace/grafanaBroker.ts`: dashboards through `getBackendSrv()` and the
dashboard App Platform API, Prometheus through the frontend datasource
service, and Jsonnet through the plugin backend. All calls run as the current
Grafana user.

Dashboard inspection, validation, and data checks share one walker,
`workspace/dashboardPanels.ts`. It reads classic JSON, v1 resources, v2
specs, and legacy `/api/dashboards/uid` responses. It covers collapsed and
expanded rows, v2 rows and tabs (as a row path with grid positions), hidden
targets that expressions depend on, and saved variable values with Prometheus
escaping. It was ported from the `grafana-inspect` tool in the dotfiles
repository. `grafana-alert find` and `grafana-usage` read panels
through its `walkClassicPanels` view, which maps v2 panels to classic panel
objects.

- PromQL syntax: `workspace/promqlCheck.ts` interpolates saved variables,
  substitutes placeholder values for `$__rate_interval` and other macros, and
  reports undefined variables. It sends the expressions in one batch to the
  backend `/promql/parse` route, which uses the upstream Prometheus parser with
  experimental syntax enabled. When the route is unavailable it falls back to
  the less strict lezer grammar and says so in a warning. Non-Prometheus
  queries are reported as not checked.
- `validate --server` sends the same request that `workspace apply` would
  send, with `dryRun=All&fieldValidation=Strict`: a PUT with the fetched
  `resourceVersion` for existing dashboards, and a POST for new ones. Grafana
  decodes the document strictly, checks permissions and revision conflicts, and
  saves nothing. For v1 resources it does not validate the spec; for v2 it
  checks types but not dangling layout references, which the local structure
  level covers.
- `grafana-dashboard data` resolves each target to an allowed Prometheus
  datasource (or `__expr__`), computes `intervalMs` from the range and
  `maxDataPoints`, and posts to `/api/ds/query`. The broker rejects any other
  datasource. Frames go through Grafana's transformer registry,
  `applyFieldOverrides`, and `reduceField`. The command reports `ok`, `empty`,
  `error` (including errors inside HTTP 200 responses), or `skipped` with a
  reason. Query variables saved as All without known options are approximated
  as `.*`, and the output notes this.

## Evidence Presentation

`evidence show PATH --view table|json|text|image` captures a display value in a
typed presentation event. The chat renders the captured value; display never
queries a datasource or rereads a mutable file. Tables accept up to 100 object
rows and text/JSON views up to 64 KiB; use jq to select a smaller file first.
Images reference existing captured artifacts. Approvals and save outcomes remain
independent of voluntary evidence presentation.

Artifacts are owned by `session/ArtifactStore.ts`, retained by count and byte
budget, and exposed completely through `/artifacts/<id>.json`. Large artifacts
are no longer replaced by placeholder files. The generic read tool still windows
large output, and shell pipelines can select fields before returning them.

## Python

`python3` and `python` (`workspace/python/`) run CPython compiled to
WebAssembly. Webpack copies the interpreter from just-bash's
`vendor/cpython-emscripten` directory to `dist/cpython/`, and the assets are
loaded on first use. Each invocation runs in a fresh dedicated Web Worker that
is terminated on timeout (60 seconds) or cancellation, which is a hard limit.

The program receives a copy of the scratch mounts, loaded dashboard working
copies (`grafana fetch --all` loads every dashboard), skills, and artifacts (the network-backed catalog and live mounts are
excluded). There is no network access and no JavaScript bridge. After the run,
changed or deleted files under writable locations are staged through the same
transaction and policy as bash; read-only paths are reported as not staged.
Python is unavailable when the browser lacks `Worker` or `WebAssembly`.

## Skills

Skills are model-facing instructions. They do not change the tool list.

Bundled skills live under `assistant/skills/`:

- `grafana-dashboard`: dashboard, panel, Jsonnet, validation, direct apply, and
  live-edit workflow.
- `grafana-alerting`: troubleshooting of Grafana-managed alert rules, especially
  rules linked to dashboard panels, and the rule change workflow.
- `investigation`: evidence-based incident investigation workflow.

`npm run generate:skills` runs `scripts/generate-bundled-skills.mjs`, which:

- validates each `SKILL.md`,
- reads text resources from `references/`, `templates/`, `assets/`, and `scripts/`,
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
`src/pages/Chat/domain/metrics.ts`. It uses Grafana's frontend datasource
service, so queries run as the current Grafana user and respect datasource
visibility.

## Logs And Elasticsearch

Log access is the `grafana-logs` command (`workspace/commands/logs.ts`), backed
by `workspace/logs.ts`. It calls the Elasticsearch datasource's resource API
(`_field_caps`, `_msearch`) as the current Grafana user, only for the
datasources and indices in `jsonData.logDatasources`. Text fields hold the
sensitive content: every request is built by the command, counts use
`size: 0`, and `search` asks only for non-text fields (`_source: false` with
`fields`), except for documents matching an admin-defined keyword condition,
which a second search in the same `_msearch` returns completely. A keyword
subfield of a text field counts as text. `grafana-dashboard screenshot`
refuses panels whose datasources the assistant may not read
(`workspace/screenshotGuard.ts`). See [restricted log access](docs/restricted-logs.md).

## SQL And Microsoft SQL Server

SQL access is the `grafana-sql` command (`workspace/commands/sql.ts`), backed by
`workspace/sql.ts`. It runs queries it builds itself through `/api/ds/query` as
the current Grafana user, only for the datasources and tables in
`jsonData.sqlDatasources`. String and binary columns hold the sensitive
content: they are never selected unless the admin lists a string column as
visible, but every column can be filtered on. Names are checked against
`INFORMATION_SCHEMA` and bracketed; values are checked against the column type
and written as `N'...'` literals. See [restricted SQL access](docs/restricted-sql.md).

Dashboard-derived metric context is in
`src/pages/Chat/domain/dashboardMetricContext.ts`, exposed as `grafana-usage`:

- `grafana-usage dashboard UID|PATH`: extract Prometheus metric usage, labels,
  grouping labels, functions, panel locations, and relations from one
  dashboard working copy, including unsaved local edits.
- `grafana-usage search [QUERY]`: search visible dashboards and build a compact
  metric usage corpus.
- `grafana-usage related METRIC...`: rank metrics related to seed metrics using
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

## Assistant Host And Mattermost

`src/host/` runs assistant chats outside the browser. `scripts/build-host.mjs`
bundles it for Node and aliases `@grafana/runtime` to
`src/host/grafanaRuntime.ts`, which implements `getBackendSrv`,
`getDataSourceSrv` (Prometheus queries through `/api/ds/query`), and `config`
with a service account token, so the workspace broker, domain code, and chat
log client run unchanged. `AssistantHost` (`assistant.ts`) gives each thread its
own chat, declines approvals, and adds a channel prompt to the system prompt
addendum. `Responder` connects a `ChatChannel` (`mattermost.ts`) to it: Grafana
webhook notifications are posted before the model runs, one thread per firing
episode, and mentions continue the thread's chat. The plugin backend stores
service account chats in their own scope. See
[Mattermost incident conversations](docs/mattermost.md).

## Alert Rules

Grafana-managed alert rules are resources of the session filesystem, like
dashboards, and use the same change sets.

- Listing: `createAlertRuleCatalog` (`workspace/mounts.ts`) lists every rule
  through `AlertRuleBroker.list` (`GET /apis/rules.alerting.grafana.app/v0alpha1/namespaces/<ns>/alertrules`,
  paginated) plus folder titles, caches the listing for 5 minutes, and serves
  `rule.json` from it, so scanning all rules costs one request.
- Working copy: `toAlertRuleSnapshot` (`workspace/alertRuleModel.ts`) keeps
  `apiVersion`, `kind`, `metadata.name`, the folder annotation, and `spec`. Group
  labels (`grafana.com/group`, `grafana.com/group-index`), provenance
  (`grafana.com/provenance`), and the other provider annotations stay in
  `meta.json`; `alertRuleWriteBody` merges them back from the stored rule on
  every write, so a write never moves a rule out of its group.
- Provisioned rules (non-empty provenance or `grafana.app/managedBy`) are
  read-only: writes and deletions fail with `EROFS`.
- `grafana-alert validate [PATH...]` (all changed rules by default) and
  `workspace apply` run `validateAlertRuleDocument`: envelope and folder,
  title, evaluation interval and durations, no-data and error states, reserved
  labels, the expression graph (exactly one `source`, references of reduce,
  threshold, resample, math, and classic-condition expressions, query time
  ranges), `panelRef` consistency, PromQL syntax through the backend parser,
  contact point, time interval, and routing tree references (listed from the
  `notifications.alerting.grafana.app` API), and the datasource allow-list.
  Against the fetched rule it rejects folder moves and interval changes of
  grouped rules: Grafana's single-rule update silently keeps the group's
  interval (`AlertRuleService.UpdateAlertRule`), so such a change would be
  reported as applied without taking effect.
- Preconditions: the AlertRule API is backed by legacy storage and accepts
  writes and deletes with any `resourceVersion`. `AlertRuleBroker.update` and
  `delete` therefore read the stored rule and return `conflicted` when its
  revision moved since the working copy was fetched. A write by someone else
  between that read and the write is not detected; `meta.json` says
  `preconditions: client`, and the review tells the user.
- Creation: a new directory `/grafana/alert-rules/<uid>/rule.json` creates the
  rule in no evaluation group (Grafana rejects group labels on create).
  `rm -r` stages a deletion. Reverts reverse the receipt's diff or fall back to
  the rule's version history (`grafana.app/get-history`).

`grafana-alert find` and `get` (`src/pages/Chat/domain/alerts.ts`) read the
rules as stored in Grafana and link them to a panel through `spec.panelRef` and
the `__dashboardUid__`/`__panelId__` annotations. They return a normalized
expression summary, `prometheusChecks` for `grafana-prom query`, and the
working-copy `path` of each rule.

Silences, contact points, notification policies, and moving rules between
folders or groups have no commands.

## Dashboard Changes: Direct Apply

The assistant edits `/grafana/dashboards/<uid>/dashboard.json` (and
`/grafana/alert-rules/<uid>/rule.json`, see [Alert Rules](#alert-rules)) and runs
`workspace apply [--path PATH]`. No planning mode or separate plan command exists.
One change set can hold dashboards and alert rules; each kind is validated and
written through its own broker (`resourceWriter` in `workspace/apply.ts`).

`workspace/apply.ts` validates every selected overlay in parallel, captures the
exact contents and base revisions, computes a digest, and requests approval of
the change set. Validation errors that the fetched dashboard already had do not
block; errors the change introduces do. The timeout pauses during approval. After
approval it checks that the working copies and base revisions still match the
captured changes, then writes the dashboards the reviewer kept as the current
Grafana user with resourceVersion preconditions, 8 at a time.

Each operation produces `applied`, `declined` (unchecked in the review; the
working copy keeps the change), `conflicted`, `failed`, `unknown`, or
`not attempted`. Successful writes reconcile the working copy. A repeated apply
with no remaining changes is a no-op; partial retries consider only remaining
staged changes. Apply receipts and full diffs are available under
`/session/receipts/`; the journal has a 16 MiB budget and drops the diffs of the
oldest receipts first. Shell stdout contains outcome counts and a diff path; long
receipts list only the dashboards that were not applied.

`workspace diff --stat` summarizes a change set before apply: changed lines per
dashboard and the replacements repeated across dashboards (`changeGroups.ts`
token-diffs each changed line pair, so `[5m]` → `[$__rate_interval]` in 71
queries is one group). `workspace revert APPLY_ID [--path PATH]` stages the
reverse of an applied change: the receipt's patch is reversed onto the current
dashboard, keeping later edits by others; without a stored diff, the previous
version comes from Grafana's version history. The revert is reviewed and saved
with `workspace apply` like any change.

`workspace status`, `diff`, and `discard` operate on the transaction's staged view.
Only explicit apply crosses a commit boundary. Remote effects cannot be rolled
back by cancelling later shell commands; cancellation reports earlier commits.

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

In the `grafana-assistant-app` variant, the assistant edits the currently open
dashboard as a file. `workspace/liveDashboard.ts` builds a `LiveDashboardBroker`
on Grafana's restricted `dashboardMutationAPI`: `GET_SPEC` reads the whole
unsaved dashboard as one v2 spec, and `APPLY_SPEC` (with `validate: true`)
replaces it. The client comes from `useRestrictedGrafanaApis()` and is only
present when Grafana runs with the `restrictedPluginApis` feature toggle,
allow-lists the plugin ID, and offers both commands (Grafana 13.2+; `APPLY_SPEC`
also needs the default-on `dashboardNewLayouts` toggle). Without it, nothing is
mounted and the assistant falls back to working copies and direct apply.

- `/live/dashboard/dashboard.json` is a v2 resource envelope around the spec.
  `metadata.resourceVersion` carries a hash of the spec it was read from.
  `info.json` next to it (`GET_DASHBOARD_INFO`) is read-only.
- The file is a writable generated file (`GeneratedFile.writable`): writes
  stage a local overlay, stored like a `/tmp` file. It is committed with the
  transaction and not persisted with the session. Reads return the overlay until
  `live apply` or `live discard` drops it.
- `grafana-dashboard inspect|validate|data|label-filter` work on the file like
  on any working copy.
- `live diff` compares the overlay with the current browser state. `live apply`
  refuses when the open dashboard is a different one or when its current spec
  hash differs from the file's revision (the user changed it in the browser),
  unless `--force`. It runs local validation (structure including v2 variables,
  PromQL syntax, datasource allow-list), then `APPLY_SPEC`. It drops the overlay,
  so the next read shows the applied state with rekeyed element names.

Live edits execute without an Assistant approval prompt because they change
only the unsaved dashboard state. Persisting them still goes through Grafana's
normal save flow or the direct-apply path.

## Model Limits And Context Compaction

Each configured model carries `contextWindow` (default 131072) and
`maxOutputTokens` (default 16384). Both the frontend (`normalizeModelLimits`
in `src/pages/Chat/model.ts`) and the backend (`normalizeModelLimits` in
`pkg/plugin/app.go`) clamp them the same way: the window to 4096–10,000,000
tokens and the output to at least 256 tokens and at most half the window. The
model catalog receives them as `contextWindow` and `maxTokens`; the stream
requests `maxTokens` explicitly, and the LLM proxy clamps every request's output
budget to the model's `maxOutputTokens` (`clampRequestMaxTokens`).

The limits are configurable in the plugin settings UI, in provisioning
(`PI_CONTEXT_WINDOW` and `PI_MAX_OUTPUT_TOKENS` in `docker-compose.yaml`), and
through `scripts/configure-pi-model.mjs` and benchmark profiles.

Compaction is Pi Durable's. Before each request the harness estimates the
context from the newest reported usage plus the messages after it. With the
thresholds from `durable/settings.ts`:

- `reserveTokens` is the model's `maxOutputTokens`; a request above
  `contextWindow − reserveTokens` waits for a summary.
- `backgroundTokens` (15% of the window, at most 32k tokens) before that
  point, a summary starts in the background while the chat keeps working, and
  it is placed at the next turn boundary.
- `keepRecentTokens` (20% of the window, at most 20k tokens) stay verbatim.
  Cuts never separate a tool call from its result.
- A request the provider rejects as too long is compacted and retried once.
- The model provider adds an observability focus to the harness's summarizer
  request (`withSummaryFocus` in `durable/models.ts`): user-stated facts,
  dashboard UIDs and panel titles, datasource UIDs, metrics, labels, PromQL,
  paths, and receipt IDs are listed verbatim. The harness's own prompt targets
  coding sessions, and without the focus the compaction benchmark lost the
  panel titles of the first turn.

The summary is a `pi.compaction` entry that starts the model's context; older
entries stay in storage. The transcript shows every message, with a divider
before the first message the model still sees verbatim that expands to the
summary, and the run status reads "Summarizing earlier conversation" while a
request waits for one. `npm run benchmark:compaction` checks that facts from
early turns survive summarization (see `tests/agentCompactionBenchmark.spec.ts`).
The system prompt asks the model to keep `/session/findings.md` for long tasks.

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
- The only remote write paths are `workspace apply` (saved dashboards and
  alert rules, with approval) and `live apply` (the unsaved browser dashboard).
  `write`, `edit`, bash, and Python can only stage local changes.
- Alert lookups and dashboard metric tools are read-only.
- Generated mounts (`meta.json`, the catalog, `/live/dashboard/info.json`,
  `/artifacts`, `/.agents/skills`) are read-only; `/live/dashboard/dashboard.json`
  only stages a local overlay.
- All Grafana calls run as the current user, so Grafana's own dashboard,
  folder, datasource, and alerting permissions apply.

### Explicit Write Approval

`workspace apply` requests approval through the `WorkspaceApprovalService`
(`session/ApprovalChannel.ts`). `ChangeSetReview.tsx` shows the change set: a
summary, the repeated replacements with an example each, and one section each
for dashboards (grouped by folder) and alert rules (grouped by folder and
evaluation group) with line counts, validation badges, per-resource diffs, a
filter, and checkboxes per resource, group, and replacement group. The decision
returns the kept paths. Denying records an unapproved journal entry, and the
command fails without writing anything.

The approval is bound to the change digest, and the captured changes are re-checked for
staleness after approval. It is still a UI callback in the browser, not a
server-side approval bound to actor and expiry (see `ROADMAP.md`).

`live apply` does not require approval because it changes only the unsaved
browser state.

### Datasource Allow-List

Admins can restrict Prometheus datasource UIDs.

The allow-list is enforced in the frontend:

- `grafana-prom` and the dashboard metric context tools only discover and
  query allowed Prometheus datasources,
- `grafana-dashboard validate`, `grafana-alert validate`, and `workspace apply`
  reject dashboards and alert rules that reference disallowed datasource UIDs
  (built-in UIDs such as `__expr__` and `grafana` are exempt).

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
- change alert rules only when the user asks, through the same apply workflow,
  and keep troubleshooting read-only,
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
- `read` and `jq` over `/artifacts` let the model inspect slices or fields
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
/jsonnet-libs/files
/promql/parse
/chats, /chats/{id}, /chats/{id}/open, /chats/{id}/log, /chats/{id}/commits
```

`/jsonnet-libs/files` lists the vendored library files, or returns one
package's contents for the `/lib/jsonnet` mount. `/promql/parse` checks
PromQL syntax with the upstream Prometheus parser.

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
- Grafana image renderer for screenshots.
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

- Define the JSON types of a new or changed resource route in `pkg/api` and
  regenerate `src/generated/api.ts` (`mise run generate:types`); the frontend
  imports the generated types instead of declaring its own. The LLM proxy's
  types are the exception: they follow pi-ai's message types.

- Add new Grafana capabilities as workspace commands (with `--help`, a declared
  effect, bounded output, and artifacts for large results) or as files in the
  session filesystem. Add a typed tool only when the shell cannot express the
  capability well.
- Keep the tool list fixed. Use skills for instructions, not for tool selection.
- Keep remote writes behind an approved `workspace apply`
  with revision preconditions; everything else only stages local changes.
- Run Grafana calls as the current user through the workspace broker; do not
  add backend paths that write with the plugin service account.
- Prefer JSON working copies for existing dashboards and Jsonnet rendered into
  working copies for new ones; make live edits in `/live/dashboard/dashboard.json`
  and verify them after `live apply`.
- Keep custom skills non-secret and small enough to fit into model context.
- Regenerate bundled skills after changing `assistant/skills`.
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
5. `src/pages/Chat/session/AssistantSession.ts`: one chat on its Pi Durable
   harness (turns, shell, run state, storage); `src/pages/Chat/durable/`: the
   storage, model provider, extension, and transcript projection;
   `src/pages/Chat/ChatSceneObject.tsx`: the chat view that hosts it, chat
   list, approvals.
6. `src/pages/Chat/systemPrompt.ts` and `src/pages/Chat/workspace/prompt.ts`:
   top-level behavior rules and the filesystem contract.
7. `src/pages/Chat/domain/index.ts`: the fixed tool list.
8. `src/pages/Chat/workspace/workspace.ts` and `workspace/shell.ts`: the
   session filesystem, transactions, and bash.
9. `src/pages/Chat/workspace/commands/commands.ts` and `workspace/apply.ts`:
   commands and direct apply.
10. `pkg/plugin/resources.go`: LLM proxy and resource routes.
11. `pkg/plugin/chats.go` and `pkg/chatlog/`: chat storage routes and store.
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
- validation before applying,
- explicit approval of an exact, digest-bound change set,
- revision preconditions on every update and delete,
- bounded query output and workspace quotas.

Known gaps: live browser verification is still required for the worker host, approval is a browser callback rather than a server-side binding,
and the datasource allow-list and dashboard validation run only in the
frontend. When adding new capabilities, enforce safety in code and Grafana
permissions, not only in prompts.
