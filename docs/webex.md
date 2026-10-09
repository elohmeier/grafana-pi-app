# Webex

Implemented 2026-10-03: the assistant host's second chat platform, next to
[Mattermost](mattermost.md). Alert threads, conversations, screenshots, and the
link to continue a thread's chat in Grafana work as in Mattermost; this page
covers what is specific to Webex.

## How it works

`WebexChannel` (`src/host/webex.ts`) uses the Webex REST API with a bot token.
Messages arrive in one of two ways; both only name a message, whose text the
host then fetches with `GET /messages/{id}`:

- **Websocket (default, added 2026-10-09).** The host connects out to the
  websocket Webex's own clients use (Mercury), so it needs no public URL and
  no ingress, only outbound HTTPS to Webex.
- **Webhook.** With `WEBEX_WEBHOOK_URL`, Webex calls the host's
  `POST /webex/webhook` route instead; the host must be reachable from Webex
  over HTTPS.

Common to both:

- Webex delivers group room messages to a bot only when they mention it, and
  every direct message.
- Threads are `parentId` replies to a root message. Answers replace their
  placeholder with `PUT /messages/{id}`.
- Webex takes one uploaded file per message, so screenshots are posted one per
  reply. Webex Markdown has no tables; evidence tables are posted as aligned
  text in a code block.

One host can serve Mattermost and Webex at the same time. Alert notifications
go to both platforms' alert channels, and each platform has its own threads
and investigations of a notification group.

### Websocket

The protocol follows Webex's JavaScript SDK (`internal-plugin-mercury`) and
[webex_bot](https://github.com/fbradyirl/webex_bot):

1. Webex's service catalog (`GET https://u2c.wbx2.com/u2c/api/v1/catalog?format=hostmap`)
   names the device service (`serviceLinks.wdm`) of the bot's cluster.
2. The host registers a device named `grafana-assistant-host`
   (`POST <wdm>/devices`), or reuses the one it registered before; the device
   names the websocket URL. Replicas share the device; only the leader connects.
3. It opens the websocket (`outboundWireFormat=text&bufferStates=true&aliasHttpStatus=true`),
   sends an `authorization` message with the bot token, and waits for the
   `mercury.buffer_state` event that confirms it.
4. Every event is acknowledged (`{"type": "ack", "messageId": ...}`). A ping
   goes out 15 s after each pong; without a pong within 14 s, the socket is
   closed.
5. A `conversation.activity` with the verb `post` (or `share`, with files) from
   someone other than the bot names a new message. Its content is end-to-end
   encrypted and not read: the room's conversation service maps the activity
   ID to the message's REST ID (`target.url` with `conversations/<room>`
   replaced by `messages/<activity>`), and the REST API returns the decrypted
   message. Messages the bot may not read (group messages that do not mention
   it) are skipped.

A closed socket reconnects with exponential backoff (1 s to 32 s). When Webex
refuses the device (close codes 1005 and 4400-4404, or three failed handshakes
in a row, which the WebSocket API reports as 1006), the host deletes it and
registers a new one. Activities seen before a reconnect are delivered once.

Starting in websocket mode removes a webhook left from webhook mode, so Webex
stops calling an address the host no longer serves; `/webex/webhook` answers 404.

Behind an HTTP proxy, Node's `fetch` and `WebSocket` use `HTTPS_PROXY` and
`NO_PROXY` when `NODE_USE_ENV_PROXY=1` is set (Node 22.21+ and 24); `wss://`
connections are tunneled with `CONNECT`. Exclude Grafana and, on Kubernetes,
the API server (`kubernetes.default.svc`) in `NO_PROXY`.

### Webhook

- On start, the host registers one webhook (`resource: messages`,
  `event: created`) named `grafana-assistant` for `WEBEX_WEBHOOK_URL`, the
  public URL of its `POST /webex/webhook` route, and replaces earlier ones.
- Webex signs each call with `X-Spark-Signature`, an HMAC-SHA1 of the body with
  the webhook secret; calls without a valid signature are refused.

## Configuration

| Variable               | Meaning                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `WEBEX_TOKEN`          | Bot access token; Webex is enabled when set.                                                  |
| `WEBEX_API_URL`        | API base (default `https://webexapis.com/v1`).                                                |
| `WEBEX_WEBHOOK_URL`    | Public URL of the host's `/webex/webhook` route; selects webhook mode. Empty: websocket mode. |
| `WEBEX_WEBHOOK_SECRET` | Webhook secret (default: random per start; the webhook is registered again).                  |
| `WEBEX_CATALOG_URL`    | Service catalog for websocket mode (default `https://u2c.wbx2.com/u2c/api/v1/catalog`).       |
| `WEBEX_DEVICE_URL`     | Device service base URL; skips the catalog lookup.                                            |
| `WEBEX_ALERT_ROOM`     | Title or ID of the room for alert notifications.                                              |
| `WEBEX_ROOMS`          | Comma-separated room titles or IDs where mentions are answered.                               |
| `WEBEX_ALLOW_DIRECT`   | `true` (default) to answer direct messages.                                                   |

The bot must be a member of the rooms. Secrets can be read from files named by
`<NAME>_FILE`.

## Local test server

There is no local Webex, so `src/host/testing/webexFake.ts` implements the part
of the API the adapter uses, in memory: people, rooms, messages with threads,
edits, file uploads, signed webhook delivery, and the websocket path (service
catalog, device registration, the Mercury websocket with authorization, pings,
acknowledgements, and replaced connections, activities with placeholder
encrypted content, and the conversation service's message ID lookup). Every
activity of a room goes to the sockets of all its members; what a bot may read
is left to the REST API. It enforces the rules above
(no text in webhook payloads, mentions in group rooms, replies to thread roots
only, one file per message, 7439 bytes per message). A control API under
`/_test` creates people and rooms, posts as a person (a mention puts the bot's
display name in the text, as the Webex client does), and lists messages.

```bash
mise run dev:mattermost   # the host and its Grafana setup
mise run dev:webex        # the fake (port 8099), its bot, people, and rooms; the host with Webex
```

The Compose host uses websocket mode against the fake's catalog; set
`WEBEX_WEBHOOK_URL=http://assistant-host:8080/webex/webhook` to test webhook
mode. `dev:webex` creates the bot `Grafana Assistant`, Alice Doe and Bob Roe, the
rooms `Alerts` and `Ops`, and a direct room with Alice, and writes the bot
token and IDs to `work/host/`. The fake keeps no state across restarts; run
the task again after its container restarts. To talk to the bot as Alice:

```bash
F=work/host/webex-fake.json
curl -s localhost:8099/_test/messages -H 'Content-Type: application/json' -d "$(jq -n --slurpfile f $F \
  '{as: $f[0].people.alice, roomId: $f[0].rooms.ops, text: "which dashboards show errors?", mentions: [$f[0].bot]}')"
curl -s localhost:8099/_test/rooms/$(jq -r .rooms.ops $F)/messages | jq '.items[] | {parentId, markdown}'
```

`src/host/webex.test.ts` runs the adapter against the fake in both modes
(webhooks and signatures; device reuse, reconnects, re-registration, and
missed pongs over the websocket; mentions, threads, edits, uploads, and a
responder round trip);
`tests/assistantHost.spec.ts` checks alert delivery through the running host.

The fake follows the documented API, and for the websocket, the behavior of
Webex's SDK, which Webex does not document; before relying on the adapter, one
session with a real Webex bot should confirm both modes.
