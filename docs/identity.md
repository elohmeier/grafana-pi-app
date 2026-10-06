# Linking chat accounts to Grafana users

Implemented 2026-10-03 for the assistant host ([Mattermost](mattermost.md),
[Webex](webex.md)). The host acts as one Grafana service account; a link tells
it which Grafana user a chat account belongs to.

## Linking

1. A user writes `@grafana-assistant link` (or just `link` in a direct
   message).
2. The host creates a one-time code for that chat account
   (`POST /identity/link-codes`, valid 15 minutes) and sends it by direct
   message, never in a channel: `/a/<plugin>/chat?link=CODE`.
3. The user opens it in Grafana, signed in. The chat page shows which account
   the code was made for and asks to confirm
   (`GET /identity/link-codes/{code}`).
4. Confirming (`POST /identity/link-codes/{code}/confirm`) links the chat
   account to the signed-in user's stable UID and login and uses up the code.

The code proves control of the chat account (only its owner receives the
direct message), and confirming in Grafana proves the Grafana user. Whoever
confirms a code is linked, so the message tells people to open it themselves.
Codes are stored as SHA-256 hashes.

`whoami` shows the link, and `unlink` removes it. Grafana users list their
links with `GET /identity/links` and can remove them with
`DELETE /identity/links/{platform}/{user}`.

### Verified email addresses

With `ASSISTANT_EMAIL_MATCH=true`, the host links an account without a code when
the platform verified its email address and a Grafana user has exactly that
email:

- Webex: always (`personEmail` is verified by the user's organization).
- Mattermost: users who sign in with SSO (`auth_service`) or have a verified
  email (`email_verified`).

Matching uses Grafana's user lookup (`/api/users/lookup`), which the service
account may only use with the `users:read` permission. Without it, matching
turns itself off and linking works through codes. Matched links have the
source `email`.

## What a link changes

- With `ASSISTANT_REQUIRE_LINK=true`, only linked users get answers; others
  receive a link code by direct message.
- The prompt names the Grafana user (`@alice (Grafana user alice.g): ...`).
- The link does not change what data the host can read: Grafana cannot let a
  service account act as a user. Every thread uses the service account's
  permissions and the plugin's global settings (datasource allow-list, log and
  SQL policies); there are no per-channel or per-user data policies.

Links are also the basis for actor-bound approvals, such as silences from a
thread.

## Storage

Links live in the plugin backend's chat database (schema version 3):
`identity_link_codes` (code hash, platform account, expiry) and
`identity_links` (platform, platform user, display name, org, Grafana user UID
and login, source, time). Creating codes and reading or setting links for a
platform account are limited to service accounts; confirming codes and listing
one's links are limited to users.
