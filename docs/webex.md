# Webex

Implemented 2026-10-03: the assistant host's second chat platform, next to
[Mattermost](mattermost.md). Alert threads, conversations, screenshots, and the
link to continue a thread's chat in Grafana work as in Mattermost; this page
covers what is specific to Webex.

## How it works

`WebexChannel` (`src/host/webex.ts`) uses the Webex REST API with a bot token
and a messages webhook:

- On start, the host registers one webhook (`resource: messages`,
  `event: created`) named `grafana-assistant` for `WEBEX_WEBHOOK_URL`, the
  public URL of its `POST /webex/webhook` route, and replaces earlier ones.
- Webex signs each call with `X-Spark-Signature`, an HMAC-SHA1 of the body with
  the webhook secret; calls without a valid signature are refused.
- The payload names a message but does not contain its text, which the host
  fetches with `GET /messages/{id}`. Webex delivers group room messages to a bot
  only when they mention it, and every direct message.
- Threads are `parentId` replies to a root message. Answers replace their
  placeholder with `PUT /messages/{id}`.
- Webex takes one uploaded file per message, so screenshots are posted one per
  reply. Webex Markdown has no tables; evidence tables are posted as aligned
  text in a code block.

The webhook needs the host to be reachable from Webex over HTTPS (an ingress).
Webex's websocket mode, which needs no public URL, requires the Webex SDK to
decrypt messages; it is not implemented.

One host can serve Mattermost and Webex at the same time. Alert notifications
go to both platforms' alert channels, and each platform has its own threads
and investigations of a notification group.

## Configuration

| Variable               | Meaning                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| `WEBEX_TOKEN`          | Bot access token; Webex is enabled when set.                                 |
| `WEBEX_API_URL`        | API base (default `https://webexapis.com/v1`).                               |
| `WEBEX_WEBHOOK_URL`    | Public URL of the host's `/webex/webhook` route.                             |
| `WEBEX_WEBHOOK_SECRET` | Webhook secret (default: random per start; the webhook is registered again). |
| `WEBEX_ALERT_ROOM`     | Title or ID of the room for alert notifications.                             |
| `WEBEX_ROOMS`          | Comma-separated room titles or IDs where mentions are answered.              |
| `WEBEX_ALLOW_DIRECT`   | `true` (default) to answer direct messages.                                  |

The bot must be a member of the rooms. Secrets can be read from files named by
`<NAME>_FILE`.

## Local test server

There is no local Webex, so `src/host/testing/webexFake.ts` implements the part
of the API the adapter uses, in memory: people, rooms, messages with threads,
edits, file uploads, and signed webhook delivery. It enforces the rules above
(no text in webhook payloads, mentions in group rooms, replies to thread roots
only, one file per message, 7439 bytes per message). A control API under
`/_test` creates people and rooms, posts as a person (a mention puts the bot's
display name in the text, as the Webex client does), and lists messages.

```bash
mise run dev:mattermost   # the host and its Grafana setup
mise run dev:webex        # the fake (port 8099), its bot, people, and rooms; the host with Webex
```

`dev:webex` creates the bot `Grafana Assistant`, Alice Doe and Bob Roe, the
rooms `Alerts` and `Ops`, and a direct room with Alice, and writes the bot
token and IDs to `work/host/`. The fake keeps no state across restarts; run
the task again after its container restarts. To talk to the bot as Alice:

```bash
F=work/host/webex-fake.json
curl -s localhost:8099/_test/messages -H 'Content-Type: application/json' -d "$(jq -n --slurpfile f $F \
  '{as: $f[0].people.alice, roomId: $f[0].rooms.ops, text: "which dashboards show errors?", mentions: [$f[0].bot]}')"
curl -s localhost:8099/_test/rooms/$(jq -r .rooms.ops $F)/messages | jq '.items[] | {parentId, markdown}'
```

`src/host/webex.test.ts` runs the adapter against the fake (webhooks,
signatures, mentions, threads, edits, uploads, and a responder round trip);
`tests/assistantHost.spec.ts` checks alert delivery through the running host.

The fake follows the documented API; before relying on the adapter, one session
with a real Webex bot should confirm it.
