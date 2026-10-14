# Alert channels

Implemented 2026-10-14. Grafana alert notifications reach Mattermost channels
and Webex rooms through the [assistant host](mattermost.md), configured in
Grafana: each channel is a webhook contact point, and notification policies
(or an alert rule's contact point) decide which alerts reach which channel.
One bot per platform serves every channel it is a member of.

## Contact point

A webhook integration that names the platform and channel in its URL, and the
options in the query:

```text
POST <host>/alerts/webex/<room ID or title>
POST <host>/alerts/mattermost/<team>/<channel>
     ?investigate=mention|auto|off   (default mention)
     &screenshots=on|off             (default on)
     &format=host|grafana            (default host)
```

| Option        | Effect                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `investigate` | `mention`: the thread says to mention the bot, which investigates then. `auto`: investigate each new episode. `off`: no hint. |
| `screenshots` | Post screenshots of the panels the alerts link to in the new thread.                                                          |
| `format`      | `host`: the host's message with labels, values, and links. `grafana`: the integration's Message template (`message`).         |

Each channel has its own thread per notification group (`groupKey`): updates
and the resolution go there, and repeats are skipped, as described in
[Mattermost incident conversations](mattermost.md#alerts). The same group sent
to two channels has a thread in each. Mentions in an alert thread are answered
in any channel; elsewhere, only in `MATTERMOST_CHANNELS`/`WEBEX_ROOMS`.

Grafana's **Test** button posts a test message to the channel (no thread, no
investigation), which shows that the contact point reaches it. Failures are
answered with an error that Grafana shows in the contact point's delivery
status: an unknown channel or one the bot is not a member of (404), a missing
signature (401), or an unknown option (400).

### Authentication

The host token (`ALERT_WEBHOOK_TOKEN`) authenticates notifications, either as
Grafana's HMAC signature or as a Bearer token:

- HMAC: secret = the token, header `X-Grafana-Alerting-Signature`, timestamp
  header `X-Grafana-Alerting-Timestamp`. Grafana signs
  `<timestamp>:<body>` with HMAC-SHA256; the host refuses timestamps more than
  5 minutes off, so a recorded notification cannot be replayed.
- Bearer: authorization scheme `Bearer`, credentials = the token.

Editors may create contact points, but only admins read their secrets; without
the token, a contact point cannot make the host post.

## Creating contact points in the app settings

With **Assistant host** set in the app's configuration (URL as Grafana
reaches the host, and its token), admins see **Alert channels** below the
settings:

1. Pick the platform and a channel: the list shows the channels the bot is a
   member of (`GET <host>/api/channels`, through the plugin backend).
2. Name the contact point. A new name creates one; an existing name adds the
   integration to that contact point, next to its other integrations (for
   example an existing ticketing webhook).
3. Choose the options and create it.

The plugin backend (`GET /alert-channels`, `POST /alert-channels/webhook`,
organization admins only) lists the channels and returns the webhook settings
with the token; the browser creates the integration with Grafana's
provisioning API as the signed-in admin, without provenance, so it stays
editable under **Alerting › Contact points**. The section lists the contact
points that send to the host and their options.

## Tests

`src/host/alertRoutes.test.ts` covers routes, options, the HMAC signature
(with and without timestamp, replays, other secrets) and the test
notification; `src/host/responder.test.ts` the delivery per channel and
option; `src/host/webex.test.ts` room membership against the Webex fake; and
`pkg/plugin/alertchannels_test.go` the admin routes against a fake host.
