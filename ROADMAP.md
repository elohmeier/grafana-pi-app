# Roadmap

Updated 2026-10-03, after release 6.0.0. [ARCHITECTURE.md](ARCHITECTURE.md)
describes the current implementation. The original architecture review
(2026-09-25) is in the history of this file (`git show c8ec4fa:ROADMAP.md`).

## Principles

- **One agent, four tools.** The model has `read`, `write`, `edit`, and `bash`
  over a per-chat session filesystem; Grafana capabilities are shell commands.
  There are no specialist subagents or per-skill tool sets.
- **Pi is the runtime.** Chats run on a Pi Durable harness. A server host, when
  needed, runs the same `AssistantSession`; OpenClaw contributes design patterns
  only.
- **Writes are reviewed change sets.** Dashboards and alert rules change only
  through `workspace apply`, written by the browser as the current user with
  revision preconditions. `live apply` changes only the unsaved dashboard in the
  browser.
- **Restricted data is guarded in the commands.** The model reaches data only
  through shell commands (the workers have no network), so the command code
  enforces the policy over Grafana's existing datasource routes. The restriction
  controls what reaches the model, not what the user sees. There is no query
  broker and no redaction logic. See [restricted log access](docs/restricted-logs.md).
- **No artificial count limits.** Large operations are protected by the review,
  not by caps.
- **Typed edit commands for large JSON** (`add-panel`, `set-panel`,
  `label-filter`), because models break large v2 JSON when editing it by hand.

## Done

- **5.x:** session filesystem and shell (just-bash, jq 1.8, CPython in Web
  Workers), lazy dashboard catalog, domain commands, user shell commands
  (`!command`), dashboard validation and data checks, reviewed change sets with
  an operation journal and revert, the live dashboard file, alert rules as
  change sets, per-model context and output budgets, Pi 0.87 protocol parity.
- **6.0:** Pi Durable chats with server-side chat logs (SQLite or PostgreSQL):
  reloads continue interrupted answers, background compaction, takeover between
  tabs.
- **6.1 (unreleased):** restricted Elasticsearch log access (`grafana-logs`)
  with the screenshot guard and the Compose profile `logs`.

## Next

### 1. Restricted MSSQL access (`grafana-sql`)

The Elasticsearch design applied to MSSQL, kept minimal:

- A `sqlDatasources` policy in `jsonData` next to `logDatasources`: datasource
  UID and the tables the assistant may use. Unlisted datasources are denied.
- A frontend command, `grafana-sql tables|schema|count|rows`, that builds every
  query itself and runs it through `/api/ds/query` as the current user. The
  model supplies only values (table, column, filter values, time range,
  grouping column), checked against the schema read from `INFORMATION_SCHEMA`.
  No raw SQL from the model. Identifiers and literals are quoted by the command,
  because the datasource has no bind parameters.
- String columns (`char`, `varchar`, `nchar`, `nvarchar`, `text`, `ntext`,
  `xml`, binary types) are sensitive unless the admin lists them as visible per
  table; numeric, date, bit, and `uniqueidentifier` columns are visible. This
  replaces Elasticsearch's text/keyword rule.
- The screenshot guard refuses panels that use restricted MSSQL datasources.
- A Compose profile with an MSSQL container and seeded fixture data, with
  sentinel values in sensitive columns; an e2e test and a benchmark like
  `benchmark:log-incident` check that no sentinel reaches the captured events.

### 2. Mattermost

Incident conversations in Mattermost, following the
[conversational alerting design](docs/conversational-alerting.md) but kept as
small as the restricted access work. Mattermost runs in Docker for development
and evaluation.

- A Node host service that runs `AssistantSession` with a server `SessionHost`
  and the same four tools and commands, over the existing chat log storage.
- Mattermost bot identity mapped to Grafana users; one thread per alert episode.
- Grafana contact point ingress with deterministic alert delivery first; the
  model's analysis follows in the thread and never blocks delivery.
- A Compose profile with Mattermost and the host, and an e2e test with a
  synthetic alert round trip.

## Later

- **Silences as reviewed changes** (`grafana-alert silence`, expire), using the
  change-set review and operation journal. Needed for responder actions in
  Mattermost; a repeated create must find the earlier silence instead of
  creating a second one.
- **Approvals from channels**, bound to the actor, the change-set digest, and an
  expiry.
- **Rest of alerting:** rule group operations (interval, reordering, moves),
  contact points, notification policies, and mute timings.
- **Webex**, against the same channel interface as Mattermost.
- **Grafana chats on the server host**, so runs continue while no browser has
  the chat open. The live dashboard bridge stays in the browser.

## Dropped

- Server-side query broker and aggregate-only output policy for SQL and logs.
- `workspace plan` and plan IDs (replaced by direct `workspace apply` with a
  digest-bound review), the `show_evidence` model tool (replaced by
  `evidence show`), specialist subagents and scoped delegation, the OpenClaw
  host, and `fd`.
