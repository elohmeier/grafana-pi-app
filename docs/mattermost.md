# Mattermost incident conversations

Implemented 2026-10-03 as the first slice of the
[conversational alerting design](conversational-alerting.md), kept minimal:
Grafana alert notifications become Mattermost threads, the assistant
investigates each new one in its thread, and people continue the conversation
there by mentioning the bot. Webex is the next channel adapter.

## How it works

The **assistant host** (`src/host`) is a Node service that runs the same
assistant as the Grafana chat: `AssistantSession`, the Pi Durable harness, the
session filesystem, and every shell command. Only the environment differs:

- `@grafana/runtime` is replaced at bundle time by `src/host/grafanaRuntime.ts`,
  which calls Grafana's HTTP API with a service account token. The workspace
  broker, domain code, and chat log client run unchanged.
- Model requests go through the plugin backend (`/resources/llm`) like the
  browser's, so the API key stays in Grafana and the configured models,
  addendum, and datasource policies apply.
- Chats are stored in the plugin backend as the service account's chats (a
  scope apart from users' chats); the host keeps only which chat belongs to
  which thread (`state.json` in `HOST_DATA_DIR`).
- Bash runs in-process (there is no Web Worker in Node), and `python3` is not
  available.

```text
Grafana alerting --webhook--> assistant host --REST/websocket--> Mattermost
                                   |
                                   +--HTTP (service account token)--> Grafana API, plugin backend (LLM, chat logs)
```

### Identity

The host acts as one Grafana **service account**, so every thread sees what
that account may see: give it the Viewer role and the datasource permissions
the channel audience may use. Datasource policies of the plugin
(`allowedPrometheusDatasourceUids`, `logDatasources`, `sqlDatasources`) apply
as in Grafana. Mattermost users are not mapped to Grafana users; whoever can
talk to the bot uses the service account's access. Restrict that with
`MATTERMOST_CHANNELS` and `MATTERMOST_ALLOW_DIRECT`.

The host is **read-only**: approvals are declined, so `workspace apply` cannot
write, and the model is told to describe changes instead. Changes are made in
Grafana.

### Alerts

A Grafana webhook contact point posts notifications to `POST /alerts/grafana`
(bearer token `ALERT_WEBHOOK_TOKEN`). Each notification group (`groupKey`) has
episodes:

- **firing, no open episode:** the host posts the notification to
  `MATTERMOST_ALERT_CHANNEL` as a new thread, then asks the assistant to
  investigate it there. The notification text is built without the model
  (labels, values, start time, dashboard, panel, rule, and silence links), so a
  model failure never blocks it; the analysis follows in the thread or reports
  the failure.
- **firing, open episode:** posted as an update in the thread when the firing
  alerts changed; repeated notifications without changes are skipped.
- **resolved:** posted in the thread, and the episode closes. The next firing
  notification starts a new thread.

The webhook answers once the notification is posted, so Grafana retries a
notification the host could not deliver.

### Screenshots and evidence

Screenshots use Grafana's image renderer as the service account
(`/render/d-solo/...` with the token), with the same screenshot guard as in
Grafana: a panel with data of a datasource the assistant may not read (logs,
SQL) is not rendered.

- **Alert threads:** for a new episode, the host renders the panels the firing
  alerts link to (`__dashboardUid__`/`__panelId__`), from an hour before the
  first alert started until now, and posts them in the thread. This does not
  involve the model.
- **Answers:** screenshots the assistant takes (`grafana-dashboard screenshot`)
  are posted below its answer, as the Grafana chat shows them inline;
  `evidence show --view table|json|text` presentations are posted as Markdown.
  A model without image input is told that it cannot see the screenshots and
  takes values from queries.

### Conversations

The bot answers direct messages and mentions (`@grafana-assistant`) in the
alert channel and `MATTERMOST_CHANNELS`. Each thread is one assistant chat:
a mention in an alert thread continues the chat that investigated the alert.
Thread posts since the bot's last answer that did not mention it are sent along
as context. While the assistant works, a placeholder post shows its steps; the
answer replaces it.

Runs of one thread are serialized; at most `ASSISTANT_CONCURRENCY` runs (default 2) use the model at the same time.

## Configuration

| Variable                     | Meaning                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `GRAFANA_URL`                | Grafana base URL reachable from the host.                                                 |
| `GRAFANA_TOKEN`              | Service account token.                                                                    |
| `GRAFANA_PLUGIN_ID`          | `grafana-assistant-app` (default) or `g42-pi-app`.                                        |
| `MATTERMOST_URL`             | Mattermost base URL.                                                                      |
| `MATTERMOST_TOKEN`           | Bot account access token.                                                                 |
| `MATTERMOST_ALERT_CHANNEL`   | `team/channel` for alert notifications.                                                   |
| `MATTERMOST_CHANNELS`        | Comma-separated `team/channel` list where mentions are answered (plus the alert channel). |
| `MATTERMOST_ALLOW_DIRECT`    | `true` (default) to answer direct messages.                                               |
| `ALERT_WEBHOOK_TOKEN`        | Bearer token the contact point sends; without it, the webhook accepts any caller.         |
| `ASSISTANT_CONCURRENCY`      | Concurrent assistant runs (default 2).                                                    |
| `HOST_PORT`, `HOST_DATA_DIR` | HTTP port (default 8080) and state directory.                                             |

Every secret can also be read from a file named by `<NAME>_FILE`.

## Local setup

The Compose profile `mattermost` adds Mattermost (`mattermost-preview`, amd64;
Rosetta on Apple silicon) on port 8065 and the host on port 8080, next to the
sidebar variant on port 3001:

```bash
mise run dev:reload:variant:seed   # Grafana on 3001 with the samples
mise run dev:mattermost            # build the host, start Mattermost, configure both, start the host
```

`dev:mattermost` (`scripts/setup-dev-mattermost.mjs`) creates the Mattermost
admin (`admin` / `Admin-dev1!`), the team `ops` with the channels `alerts` and
`town-square`, the bot `grafana-assistant`, the Grafana service account
`assistant-host`, and a webhook contact point with a notification policy route
for the alerts of the `Assistant Dev Samples` folder (`ASSISTANT_ALERT_FOLDER`).
Secrets go to `work/host/`. Neither Grafana nor Mattermost keeps its database
when its container is recreated, so run it again after a reload.

After a host change, run `node scripts/build-host.mjs` and
`docker compose --profile mattermost restart assistant-host`.

`tests/assistantHost.spec.ts` checks alert delivery without the model: one
thread per firing episode, skipped repeats, and the resolution in the same
thread:

```bash
npx playwright test tests/assistantHost.spec.ts --project=chromium --no-deps
```

## Limits and next steps

- **Webex:** a second `ChatChannel` (`src/host/channel.ts`) implementation.
- **Silences** from a thread, as reviewed changes with actor-bound approval.
- Bash in the host cannot be terminated while it computes; a runaway script
  blocks the host until it finishes.
- The host keeps its state in one JSON file and runs as a single instance.
- Links in notifications come from Grafana's `root_url`. The local variant keeps
  the default, so they point at port 3000 instead of 3001.
