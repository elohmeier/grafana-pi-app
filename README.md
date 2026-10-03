# Observability Analyst

Observability Analyst is a Grafana app plugin that embeds an LLM analyst for observability work. The analyst runs in a Grafana-native React UI, uses the current Grafana user's datasource and dashboard permissions, and calls an OpenAI-compatible LLM through the plugin backend so API keys stay server-side.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the current implementation works, and the [roadmap](ROADMAP.md) for the design principles and the next steps: restricted MSSQL access, Mattermost incident conversations on a server host, and silences.

The [conversational alerting design](docs/conversational-alerting.md) covers Mattermost/Webex incident conversations, screenshots, silencing, and proactive follow-up on a Pi server host, with patterns borrowed from OpenClaw.

## What it does

- Runs one agent with a fixed tool set: `read`, `write`, `edit`, and `bash` over a per-chat session filesystem, with typed capabilities behind the shell commands.
- Discovers Prometheus datasources, metric names, labels, and series, and runs PromQL through Grafana datasource APIs as the current user (`grafana-prom`), returning compact min/max/last/sample summaries.
- Investigates Elasticsearch logs without reading their text (`grafana-logs`): field structure, counts with text search, time patterns, groups, and documents with their non-text fields. Documents matching admin-defined keyword conditions, such as deployment events, are returned completely.
- Investigates Microsoft SQL Server tables without reading their sensitive columns (`grafana-sql`): schema, counts filtered by any column, time buckets, groups, and rows with numeric, date, and admin-approved string columns.
- Searches dashboards and loads them lazily into the session filesystem as local working copies (`/grafana/dashboards/<uid>/dashboard.json`), so `rg`, `jq`, `yq`, `python3`, and `edit` work on real dashboard JSON.
- Extracts Prometheus metric usage from existing dashboards, including panel co-usage, labels, grouping labels, functions, and related metric neighborhoods.
- Creates new dashboards from model-authored Jsonnet evaluated by the backend with the vendored Grafana libraries, and edits existing dashboards as JSON.
- Writes dashboard and alert rule changes only through `workspace apply`: the user reviews the change set (repeated replacements, per-resource diffs, checkboxes to leave resources out), and the browser writes as the current user with revision preconditions. `workspace revert` undoes an apply through the same review.
- Edits many dashboards at once: every visible dashboard is listed under `/grafana/dashboards` and loads on demand, `grafana-dashboard queries --metric NAME` finds every panel query that uses a metric (with its jq path), and one script changes them all.
- Troubleshoots Grafana-managed alert rules linked to dashboard panels, and changes alert rules as working copies (`/grafana/alert-rules/<uid>/rule.json`: thresholds, pending periods, labels, queries) through the same reviewed change sets as dashboards. Provisioned rules stay read-only; silences, contact points, and notification policies are not edited.
- Screenshots dashboards and navigates within Grafana.
- Adds dashboard panel menu actions for contextual Assistant prompts.
- Optionally runs as the `grafana-assistant-app` variant with Grafana's extension sidebar integration enabled.
- In the `grafana-assistant-app` variant, edits the currently open unsaved dashboard as a file: `/live/dashboard/dashboard.json` holds its v2 spec, and `live apply` replaces the browser state through Grafana's restricted dashboard mutation API (`GET_SPEC`/`APPLY_SPEC`).
- Runs each chat on a [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) harness: every step is stored before it is shown, a reload in the middle of an answer continues the answer, and long conversations are summarized in the background to fit each model's configured context window.
- Stores chats, including the session filesystem, per Grafana user in the plugin backend: in an embedded SQLite file by default, or in PostgreSQL for HA deployments.
- Posts Grafana alert notifications as Mattermost threads and investigates them there through the assistant host, a Node service that runs the same assistant as a service account; people continue the conversation by mentioning the bot, and open the thread's chat in Grafana to review and apply staged changes as themselves. See [Mattermost incident conversations](docs/mattermost.md). Webex works the same way through the same host ([Webex](docs/webex.md)).

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
  - `thinkingLevel`: Optional model reasoning effort, one of `off`, `low`, `medium`, `high`, `xhigh`, or `max`. `xhigh` and `max` are sent as-is (`reasoning_effort` or `reasoning.effort`), so use them only for models that accept them. Defaults to `off`.
  - `thinkingFormat`: Chat Completions thinking parameter format, one of `openai`, `qwen`, `qwen-chat-template`, or `deepseek`. Responses always uses `reasoning.effort`. Defaults to `openai`.
  - `contextWindow`: The endpoint's input-plus-output token capacity. Defaults to `131072`. The assistant summarizes older conversation history to fit it.
  - `maxOutputTokens`: Output tokens requested per model call. Defaults to `16384` and is capped at half the context window. The backend clamps every request's output budget to this value.

  When no entry is flagged `default`, the first model is the default. All models share the configured base URL and API key.

- `systemPromptAddendum`: Optional central instructions appended to the built-in system prompt. Do not include secrets because this is stored in `jsonData`.
- `allowedPrometheusDatasourceUids`: Optional list of Prometheus datasource UIDs the assistant may discover, query, and reference in dashboards it validates and saves. Leave empty to allow all Prometheus datasources visible to the current Grafana user.
- `logDatasources`: Optional list of Elasticsearch datasources for `grafana-logs`, each with a datasource `uid`, `indices` (indices, data streams, aliases, or patterns; empty means the datasource's configured index), and `unrestricted` conditions (`field`, a keyword field, and `values`). The assistant sees field structure, counts, and documents without text fields; documents matching an unrestricted condition are returned completely. Datasources that are not listed are not available, and `grafana-dashboard screenshot` refuses panels that use them. See [restricted log access](docs/restricted-logs.md).
- `sqlDatasources`: Optional list of Microsoft SQL Server datasources for `grafana-sql`, each with a datasource `uid`, `tables` (`schema.table`; empty means every table of the database), and `visibleColumns` (string columns that may be returned, as `schema.table.column`). Numeric, date/time, bit, and uniqueidentifier columns are visible; other string and binary columns can be filtered on but are never returned. Datasources that are not listed are not available. See [restricted SQL access](docs/restricted-sql.md).
- `customSkills`: Optional non-secret skill definitions stored in `jsonData`. Users activate explicit custom skills with `$skill-name`; admins can also configure keyword or regex activation.
- `openAIAPIKey`: Secret API key stored in `secureJsonData`.

Chat users pick a model from the selector in the chat composer; the selection is stored per chat session, and new chats start with the configured default model. The backend validates every requested model against the configured list and rejects unknown model IDs, so users cannot reach arbitrary models. Users cannot override the system prompt addendum or datasource allow-list from the assistant page: the backend appends the configured system prompt addendum when proxying LLM requests, and Grafana datasource tools enforce the central allow-list before querying.

For local Docker provisioning, `provisioning/plugins/app.yaml` reads `OPENAI_API_KEY`.
The local demo config points Grafana at `http://host.docker.internal:8080/v1` and configures a single default model entry for the local llama-server model (Ornith-1.5-35B-A3B by default) with the `auto` protocol and medium `qwen-chat-template` thinking, and limits assistant datasource access to the provisioned `prometheus` datasource.
Compose sets the model limits from `PI_CONTEXT_WINDOW` and `PI_MAX_OUTPUT_TOKENS` (defaults `131072` and `16384`).
When `OPENAI_API_KEY` is unset, Compose provides a local dummy key because llama-server only needs a bearer token-shaped value.

Dashboard reads and writes run in the browser as the current Grafana user, so they follow that user's dashboard and folder permissions. The plugin service account has no dashboard or folder permissions. In local Docker, `docker-compose.yaml` starts Grafana image rendering so screenshots can run.

## Chat storage

Each chat is a Pi Durable harness that runs in the browser over the chat's commit log, which the plugin backend stores per Grafana user. Without configuration the backend keeps the logs in an embedded SQLite file next to the Grafana plugins directory; HA deployments configure a PostgreSQL schema instead. Opening a chat in another tab or window takes it over, and the previous view stops accepting work. See [chat storage](docs/chat-storage.md) for configuration, the commit log, and recovery.

## Session filesystem and agent

The assistant is a single agent; there are no specialist subagents or per-skill tool sets. Its tool list is the same on every turn:

- `read`, `write`, `edit`, `bash` over the session filesystem. Everything else, including alerts, metric usage, navigation, and screenshots, is a shell command. The investigation report is the Markdown file `/session/report.md`, which the chat shows next to the messages.

Each chat has its own filesystem:

| Path                                       | Contents                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/grafana/dashboards/<uid>/dashboard.json` | Local working copy of a dashboard resource. Every visible dashboard is listed; content is fetched on first read (scans load all of them in parallel) through Grafana's dashboard App Platform API as the current user. `meta.json` next to it is read-only. |
| `/grafana/catalog/dashboards.ndjson`       | Metadata of every visible dashboard (uid, title, folder, tags).                                                                                                                                                                                             |
| `/grafana/alert-rules/<uid>/rule.json`     | Local working copy of a Grafana-managed alert rule. Every visible rule is listed and loaded from one App Platform listing. `meta.json` next to it is read-only (revision, evaluation group, provenance).                                                    |
| `/grafana/catalog/alert-rules.ndjson`      | Metadata of every visible alert rule (uid, title, folder, group, labels, provenance, linked dashboard and panel).                                                                                                                                           |
| `/live/dashboard/dashboard.json`           | Unsaved state of the dashboard open in the browser as a v2 resource (variant with the mutation API only). Editable; `live apply` applies it to the browser. `info.json` next to it is read-only.                                                            |
| `/workspace`, `/session`                   | Scratch files persisted with the chat. `/workspace` is the default working directory; `/session/findings.md` holds durable notes, and `/session/report.md` is shown to the user next to the chat.                                                           |
| `/tmp`                                     | Scratch files that are not persisted.                                                                                                                                                                                                                       |
| `/artifacts`, `/.agents/skills`            | Read-only earlier tool results and skill files.                                                                                                                                                                                                             |
| `/lib/jsonnet/<import path>`               | Read-only vendored Jsonnet libraries (`pi-dashboard` helpers, Grafonnet, xtd, docsonnet), loaded per package from the backend on first read.                                                                                                                |

Users can run commands in the same shell: composer input that starts with `!` (for example `!ls /grafana/dashboards` or `!grafana-prom metrics http_`) runs in the chat's session filesystem without a model call. The result appears in the transcript, and the agent sees the command and its output as context on the next message. In the composer, Enter sends and Shift+Enter adds a line; Up and Down recall earlier prompts and commands of the chat (from `!` alone, shell commands only), Ctrl+R searches them, Tab in shell mode completes command names, subcommands, options, and session paths (listing the candidates when several match), Esc leaves history browsing or shell mode, Ctrl+C in an empty composer stops the running reply, and the composer keeps focus after a command, so commands can be run one after another.

Each tool call or bash invocation is one transaction with path checks and a stored-size budget for `/workspace` and `/session`; there are no limits on how many dashboards are read, changed, or applied. Links are not supported. Its file changes are committed together, or discarded on timeout, cancellation, or a quota or policy error. Only explicit `workspace apply` and `live apply` commit earlier writes in the same call. Later failures discard uncommitted changes and report earlier commits.

`bash` runs just-bash (its browser bundle) in a dedicated, terminable Web Worker, with coreutils, `rg`, `grep`, `find`, `sed`, `awk`, `yq`, and `diff`, `jq` (jq 1.8 compiled to WebAssembly, so filters behave like the real jq), and `/dev/null`, plus these commands (run `<command> --help`):

- `grafana search|fetch|refresh|open`: dashboard discovery, parallel loading (`grafana fetch UID...|--all|--folder UID|--query TEXT|-`), and opening a dashboard, Explore query, or Grafana path in the browser.
- `grafana-prom datasources|metrics|labels|series|query`: Prometheus discovery and bounded query summaries. `query` accepts any number of `-e EXPR` in one call, substitutes dashboard variables given with `--var NAME=VALUE`, refuses expressions with unresolved `$variables`, and marks results without series.
- `grafana-logs sources|fields|count|search`: Elasticsearch log datasources from the `logDatasources` policy. `count` counts documents matching a time range and Lucene query (`-q`, which may search message text), as a total, a time series (`--interval`), or groups (`--by`, any non-text aggregatable field); `search` prints documents as NDJSON (`_index`, `_id`, `_restricted`, and dotted field names) with their non-text fields, or completely when they match an unrestricted condition. Without `--index`, both search every configured index, and a query that matches nothing names fields the index does not have. Text fields, including keyword subfields of text fields, are never returned otherwise.
- `grafana-sql sources|tables|columns|count|rows`: Microsoft SQL Server tables from the `sqlDatasources` policy. `count` counts rows matching `--where` filters on any column and a time range (`--time COL --since`), as a total, time buckets (`--interval`), or groups (`--by`, any visible column); `rows` prints rows as NDJSON with their visible columns. There is no raw SQL; sensitive columns are never returned.
- `grafana-dashboard inspect|queries|fix|validate|data|add-panel|set-panel|label-filter|screenshot`: `queries` lists panel and variable queries of every dashboard (or the given files) as NDJSON with the jq path of each query text, filtered by `--metric`, `--match`, or `--ds`; dashboard summaries (panels with row path, layout, queries, legend, transformations, units and thresholds; variables with current values), explicit layout repair, validation (structure, PromQL syntax with the upstream Prometheus parser, datasource allow-list, and with `--server` a Grafana dry-run of the save), panel data checks that run a panel's queries and apply its transformations, units, and reducers, `add-panel` and `set-panel`, which add or change panels (title, queries, unit, type, position) with schema-correct JSON for classic and v2 files, move panels that are in the way down, copy a reference panel's visualization and datasource (`add-panel --like`), and convert queries of another datasource to PromQL (`set-panel --ds`), `label-filter`, which adds a variable-bound Prometheus label matcher to every selected query of a dashboard file (and optionally the query variable), and `screenshot`, which renders a dashboard or panel with the image renderer and attaches the image to the bash result; it refuses panels whose datasources the assistant may not read, such as Elasticsearch logs.
- `grafana-usage dashboard|search|related`: Prometheus metric usage derived from every visible dashboard (or those matching a title search or tag) (metrics, labels, grouping labels, functions, panel co-usage) and metrics related to seed metrics. `dashboard` reads the local working copy, so it sees unsaved edits.
- `grafana-alert find|get|validate`: Grafana-managed alert rules found through `panelRef` and the `__dashboardUid__`/`__panelId__` annotations, with PromQL checks to run and the path of each rule's working copy; `validate` checks changed rule working copies (expression graph, durations, PromQL, contact point and time interval references, datasource allow-list, and changes Grafana would ignore).
- `jsonnet [eval] FILE [-o OUT] [--resource UID]`, `jsonnet fix FILE`: Jsonnet evaluation and repair in the backend. The vendored libraries are files under `/lib/jsonnet`.
- `workspace status|diff|discard|apply|revert|receipts`: staged dashboard and alert rule changes (`diff --stat` summarizes repeated replacements), reviewed writes, reverts, and receipts.
- `live status|diff|apply|undo|discard`: review and apply edits of `/live/dashboard/dashboard.json` to the unsaved dashboard in the browser. `live apply` refuses edits that drop panels, queries, transformations, or variables unless `--allow-removals`; `live undo` stages the state from before the last apply.
- `python3` / `python`: CPython compiled to WebAssembly, run in a Web Worker per invocation with no network access. It works on a copy of the filesystem; its file changes go through the same transaction.

## Dashboard changes

Existing dashboards are edited in their working copy. For new dashboards, the assistant writes Jsonnet under `/workspace` and renders it into a working copy with `jsonnet FILE --resource <uid> -o /grafana/dashboards/<uid>/dashboard.json`. Rendering over an existing dashboard is refused when the result drops its panels or variables, unless `--replace` is passed. The backend evaluates Jsonnet statelessly with the libraries vendored under `pkg/plugin/jsonnet/vendor` (same `jsonnet-bundler` layout as `agentic-observability`). `jsonnet fix` rewrites common invalid Grafonnet constructor shapes in place.

Nothing reaches Grafana until the assistant runs:

1. `grafana-dashboard validate` on the changed files.
2. `workspace apply [--path PATH]`, which validates the staged changes (errors a dashboard already had do not block), lists removed panels, queries, transformations, and variables as warnings, and opens the change-set review: a summary, the replacements repeated across dashboards with an example each, and a folder-grouped dashboard list with per-dashboard diffs and checkboxes. There is no planning mode, saved plan, or plan ID. Waiting for approval does not count against the bash timeout. After approval, the captured changes are checked again for staleness. The browser then writes the checked dashboards as the current user with `resourceVersion` preconditions, several at a time. Concurrent changes return `conflicted`; unchecked dashboards are `declined` and keep their working-copy change.
3. `workspace receipts` or `/session/receipts/` shows save outcomes and complete diffs. `workspace revert APPLY_ID` stages the reverse of an apply for the same review.

Every apply is journaled per operation as `applied`, `declined`, `conflicted`, `failed`, `unknown`, or `not attempted`. A `bash` call interrupted by a reload is not run again when the chat reopens: the model is told the call was interrupted, and `workspace receipts` shows what was applied.

Live edits (`live apply`) change only the unsaved dashboard open in the browser and do not ask for approval. Saving that state still goes through Grafana's own save flow.

## Alert rule changes

Alert rules follow the same workflow: the assistant edits `/grafana/alert-rules/<uid>/rule.json`, runs `grafana-alert validate`, and applies with `workspace apply`; one review can hold dashboards and alert rules, listed in separate sections with rules grouped by folder and evaluation group. The working copy holds the rule's `spec` and folder; its evaluation group and provenance are kept from Grafana on every write.

- Provisioned rules (file, API, or converted Prometheus provenance) are read-only.
- Evaluation intervals belong to the rule group. Grafana ignores interval changes in single-rule updates, so validation rejects them for grouped rules; ungrouped rules can change theirs. Moving rules between folders or groups is not supported.
- Grafana's AlertRule API does not enforce `resourceVersion` on writes, so the assistant compares the stored revision right before each write and reports `conflicted` when the rule changed since it was fetched. A change made in the moment between that check and the write is not detected; the review says so.
- New rules are created from a new directory in no evaluation group; `rm -r /grafana/alert-rules/<uid>` stages a deletion. `workspace revert` restores a rule from the receipt's diff or the rule's version history.

## Context window and compaction

Compaction is Pi Durable's: the harness estimates each request from the last reported token usage plus the messages after it. When the context comes within `backgroundTokens` of `contextWindow − reserveTokens`, a summary of the older messages is written in the background while the chat keeps working, and it is placed at the next turn boundary; a request that would not fit waits for it. A request the provider rejects as too long is compacted and retried once. The thresholds scale with each model: `reserveTokens` is the model's `maxOutputTokens`, about 20% of the window (at most 20k tokens) stays verbatim, and background summaries start 15% of the window (at most 32k tokens) before the blocking point. Older messages stay in storage: the transcript stays complete, a divider marks where the model's verbatim context begins and expands to the summary, and the status reads "Summarizing earlier conversation" while a request waits for one. For long tasks, the assistant keeps notes in `/session/findings.md`.

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

The JSON types of the plugin's resource routes are defined once in `pkg/api`, and [tygo](https://github.com/gzuidhof/tygo) generates their TypeScript counterparts in `src/generated/api.ts`. After changing `pkg/api`, regenerate them (the pre-commit hook does this too, and CI fails when the file is out of date):

```bash
mise run generate:types
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

The directory passed to the command is the import root and is not itself created as a Grafana folder. JSON files directly inside it go into General; use `--folder-uid UID` to place the complete tree below an existing folder instead. Existing folders with the same name under the same parent are reused, and dashboard UIDs are overwritten by default. Classic dashboards use `/api/dashboards/db`; stable v2 specs and resources use `/apis/dashboard.grafana.app/v2` and receive a deterministic UID when their resource metadata does not contain one. Use `--dry-run` to validate the complete tree without changing Grafana, or `--no-overwrite` to reject existing dashboard UIDs. The v2 API namespace defaults to `default` and can be changed with `--namespace` or `GRAFANA_NAMESPACE`. Grafana allows four nested folder levels by default; `--max-folder-depth N` merges deeper directories into their ancestor at that depth. Without `--folder-uid`, a top-level `general` directory is imported into Grafana's General folder, because Grafana reserves that folder name.

Both commands default to `GRAFANA_URL=http://localhost:3001` and `admin`/`admin`. Set `GRAFANA_URL=http://localhost:3000` only when intentionally targeting the default plugin stack; authentication can also be supplied through `GRAFANA_TOKEN` or `GRAFANA_USER` and `GRAFANA_PASSWORD`.

To reload the sidebar-capable variant and seed stable manual-test samples:

```bash
mise run dev:reload:variant:seed
```

This also runs `npm run dev:seed:samples`, which upserts an `Assistant Dev Samples` folder with dashboards for alert troubleshooting, live dashboard editing, stale dashboard-context repair, and dashboard metric discovery. By default it also seeds a production-like enterprise corpus with multiple folders, dozens of dashboards, and hundreds of Grafana-managed alert rules so search and discovery tools run against realistic noise. The alert sample includes a Grafana-managed AlertRule linked to the panel through both `panelRef` and the dashboard/panel annotations used by Grafana's panel alert indicator. For alert rule editing, the folder also holds the rule group `assistant-rule-editing` with two sibling rules and the rule `assistant-provisioned-5xx` with API provenance, which the assistant must treat as read-only. To seed only the Grafana resources against an already-running stack, run:

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
docker compose --profile logs down -v
```

For restricted log access work, the Compose profile `logs` adds a single-node Elasticsearch with synthetic ECS logs that follow the Prometheus demo incident, sentinel values in every text field, deployment events that may be read completely, and an audit stream that must stay denied. Grafana gets the `es-logs` and `es-audit` datasources from `provisioning/datasources/elasticsearch.yaml`:

```bash
mise run dev:logs
```

This starts Elasticsearch on port 9200 (`ELASTICSEARCH_PORT`), seeds it once, and checks the fixture through Grafana on port 3001 with `npm run dev:check:logs`. `mise run dev:logs:reseed` regenerates the logs for the current Prometheus history. See [restricted log access](docs/restricted-logs.md) for the design and the data set.

For restricted SQL access work, the Compose profile `sql` adds SQL Server 2022 (amd64; Rosetta on Apple silicon) with an ITSM database whose incidents and changes follow the Prometheus demo incident, sentinel values in every sensitive column, and a table outside the policy. Grafana gets the `mssql-itsm` datasource from `provisioning/datasources/mssql.yaml`:

```bash
mise run dev:sql
```

This starts SQL Server on port 1433 (`MSSQL_PORT`) and seeds it once; `mise run dev:sql:reseed` regenerates the data for the current Prometheus history. See [restricted SQL access](docs/restricted-sql.md).

For Mattermost incident conversations, the Compose profile `mattermost` adds Mattermost on port 8065 and the assistant host on port 8080. With the sidebar variant running:

```bash
mise run dev:mattermost
```

This builds the host (`npm run build:host`), starts Mattermost, creates the admin `admin` / `Admin-dev1!`, the team `ops` with the channels `alerts` and `town-square`, the bot `@grafana-assistant`, the Grafana service account `assistant-host`, and a webhook contact point for the alerts of the `Assistant Dev Samples` folder, then starts the host. Run it again after the Grafana or Mattermost container was recreated. See [Mattermost incident conversations](docs/mattermost.md).

For a full demo reset that also reseeds Prometheus history with one hour of future overlap for short-window `now` queries, run:

```bash
mise run dev:reload:variant:fresh
```

This task deletes Compose volumes, including the Elasticsearch log fixture, with `docker compose --profile logs down -v --remove-orphans`, rebuilds/reloads the assistant variant, regenerates the Prometheus history, and then seeds the Grafana dashboard and alert samples.

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

For a local DS4 server on port 8000, use these overrides in `.env` before running `mise run dev:reload:variant`:

```dotenv
OPENAI_API_KEY=dsv4-local
PI_OPENAI_BASE_URL=http://host.docker.internal:8000/v1
PI_OPENAI_PROTOCOL=chat-completions
PI_DEFAULT_MODEL=deepseek-v4-flash
PI_THINKING_LEVEL=medium
PI_THINKING_FORMAT=deepseek
PI_CONTEXT_WINDOW=100000
PI_MAX_OUTPUT_TOKENS=16384
```

Start the host server with `./ds4-server --ctx 100000 --kv-disk-dir "$HOME/.cache/ds4/kv" --kv-disk-space-mb 8192`. The `deepseek` format sends explicit thinking controls and replays assistant reasoning during tool calls. For an already-running Grafana instance, `npm run dev:model -- --provider ds4 --model deepseek-v4-flash` imports the corresponding Pi configuration; keep the provisioning overrides above so restarts retain it.

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

To benchmark whether facts survive context compaction, run:

```bash
npm run benchmark:compaction
```

This benchmark seeds three dashboards with unusual panel titles, lowers the configured model's context window to `BENCH_COMPACTION_CONTEXT_WINDOW` (default `20000`, with 4096 output tokens, which leaves about 8k tokens of history next to the system prompt and tool schemas before a summary is required) for the run, and restores the plugin settings afterwards. Over five turns the assistant inspects these dashboards, then three others (explaining what each of their panels measures), and finally answers without tools with the two facts the user stated in the first turn and every panel title of the first three dashboards. It fails when no earlier turn was summarized, when the recall turn uses tools, or when a fact is missing, and writes reports to `test-results/compaction-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`.

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

To benchmark log investigation with restricted Elasticsearch access, run:

```bash
npm run benchmark:log-incident
```

This benchmark reloads the sidebar-capable variant with the `logs` Compose profile fixture and asks the assistant why report downloads started failing. It requires a successful `grafana-logs count`, no writes, a bounded tool-call count, no restricted log text (fixture sentinels) anywhere in the captured events, and an answer that names the affected service, host, error type, the preceding 3.8.0 rollout, and an onset close to it. It writes reports to `test-results/log-incident-benchmark/latest-report.txt`, `latest-answer.md`, and `latest-events.json`. To run it against an already running stack, reseed the logs for the current time with `docker compose --profile logs run --rm -e LOGS_FORCE=1 -e TIMELINE_FILE= elasticsearch-seed` and run `RUN_AGENT_BENCHMARKS=1 E2E_PLUGIN_ID=grafana-assistant-app GRAFANA_URL=http://localhost:3001 npx playwright test tests/agentLogIncidentBenchmark.spec.ts`.

Open Grafana at http://localhost:3000 and navigate to the Observability Analyst app page.
