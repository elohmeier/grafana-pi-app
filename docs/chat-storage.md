# Chat storage

Every chat runs on a [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
harness in the browser. The harness commits every step of a chat (user input,
streamed partial answers, tool calls and their results, compaction summaries,
the session filesystem, and the chat's model choice) before the chat shows it.
The plugin backend stores these commits per Grafana user as the chat's commit
log. Opening a chat replays its log, so the chat continues where it stopped:
an answer that a reload or a closed tab interrupted is requested again, a tool
call that only reads runs again, and a `bash` call is reported to the model as
interrupted instead of being repeated, because it may already have applied
changes.

## How a chat is stored

- **One harness per chat.** The browser opens a harness over an in-memory
  storage (`MemoryStorage`, Pi Durable's reference semantics) when a chat is
  opened or its first prompt is sent. `LogStorage`
  (`src/pages/Chat/durable/logStorage.ts`) sends every commit to the backend
  and applies it in memory only once the backend confirmed it.
- **One writer.** `POST /chats/{id}/open` makes the caller the chat's only
  writer and returns a new epoch. The backend refuses commits that carry an
  older epoch, so opening a chat in another tab or window takes it over. The
  previous view stops, shows that the chat was opened elsewhere, and can take
  it back with **Open here**. Several chats can be open in different tabs at
  once.
- **Exactly-once commits.** A commit is accepted only with the next sequence
  number. A commit whose response was lost is retried with the same sequence
  number and digest, which the backend recognizes. A commit that stays
  uncertain stops the chat's harness; reopening the chat shows what was stored.
- **Bounded logs.** Rows that only hold a superseded value replace their
  predecessors: task records, submissions, and the content of documents that
  keep only their latest value (such as the streamed partial answer). A long
  streamed answer therefore stores a handful of rows, not one per update.
  Transcript entries are never pruned; compaction only changes what the model
  sees.
- **Metadata.** The chat list (`GET /chats`) reads titles and timestamps
  without reading any log. A new chat is stored with its first prompt or `!`
  command and is titled from it.

The session filesystem (`/workspace`, `/session`, working copies with local
changes, the apply journal, and artifacts) is the conversation document
`app.workspace`, committed after every tool call and shell command. The system
prompt of the current turn (active skills, launch and page context) is the
document `app.turn`, so a run resumed after a reload continues with the prompt
it started with.

## Backends

### SQLite (default)

Without PostgreSQL configuration the backend stores chats in an embedded SQLite
database (pure Go, WAL mode). The path is, in order:

1. `sqlite_path` in the plugin's section of `grafana.ini`, which Grafana passes
   to the plugin as `GF_PLUGIN_SQLITE_PATH`:

   ```ini
   [plugin.grafana-assistant-app]
   sqlite_path = /var/lib/grafana/plugin-data/grafana-assistant-app/chats.db
   ```

2. `PI_SESSION_SQLITE_PATH`, if the plugin process receives it.
3. `<parent of the plugins directory>/plugin-data/<plugin ID>/chats.db`, for
   example `/var/lib/grafana/plugin-data/grafana-assistant-app/chats.db` in the
   Grafana container image.

The file lives outside the plugin's own directory, so upgrading the plugin
keeps it. Include it in backups. Each Grafana replica has its own SQLite file;
use PostgreSQL when Grafana runs with more than one replica.

### PostgreSQL (HA)

Use the same PostgreSQL database as Grafana with a dedicated schema and role,
or a separate database. The plugin never reads Grafana's internal tables. All
replicas must use the same configuration.

Create the role and schema as a database administrator, replacing the password:

```sql
CREATE ROLE pi_sessions LOGIN PASSWORD 'replace-with-a-secret';
-- Connect to the database named in the DSN (for example, grafana).
CREATE SCHEMA grafana_pi AUTHORIZATION pi_sessions;
GRANT CONNECT ON DATABASE grafana TO pi_sessions;
```

The role owns only the assistant schema. Table creation and version tracking
run on first use under a PostgreSQL advisory lock, and every table reference is
schema-qualified. Schema names must be lowercase letters, digits and
underscores, starting with a letter (at most 63 characters); `public`,
`information_schema`, and names starting with `pg_` are rejected.

Merge these fields into the app's provisioning on **every replica**:

```yaml
apiVersion: 1
apps:
  - type: grafana-assistant-app
    org_id: 1
    disabled: false
    jsonData:
      # Keep the existing model/access settings here as well.
      sessionSchema: grafana_pi
      # Unique per independent Grafana deployment; stable across replicas and upgrades.
      sessionNamespace: production-observability
      # Optional internal URL for this Grafana's /api/signing-keys/keys endpoint.
      # Include Grafana's subpath if applicable. Otherwise the public AppURL is used.
      sessionGrafanaUrl: http://localhost:3000/
    secureJsonData:
      sessionPostgresDsn: $__env{PI_SESSION_POSTGRES_DSN}
```

Supply `PI_SESSION_POSTGRES_DSN` to Grafana with a Kubernetes Secret or
equivalent, for example
`postgres://pi_sessions:URL_ENCODED_PASSWORD@postgres:5432/grafana?sslmode=verify-full`.
The DSN belongs in `secureJsonData`, never in `jsonData`. Use `g42-pi-app`
instead of `grafana-assistant-app` for the default plugin ID; the two variants
keep separate chats even when they share a schema.

The backend also reads `PI_SESSION_POSTGRES_DSN`, `PI_SESSION_SCHEMA`,
`PI_SESSION_NAMESPACE` and `PI_SESSION_GRAFANA_URL` if its process receives
them. Recent Grafana versions filter plugin process environments, so prefer
provisioning with Grafana's environment expansion.

Each plugin instance (normally one per organization and plugin variant) opens
at most four connections per Grafana replica, lazily. Statements time out after
15 seconds, and chat requests after 20 seconds. The plugin health check reports
which backend stores chats and fails when it is unavailable.

## Identity and data

The backend derives the owner of a chat from the identity token Grafana
forwards with every plugin request and verifies it against Grafana's signing
keys: deployment namespace, organization, plugin ID, and the stable user UID.
Service accounts (the [assistant host](mattermost.md)) store chats in a scope of
their own; anonymous users cannot store chats.

Tables (`chats`, `chat_rows`, `chat_shares`, `chat_share_copies`, `chatlog_migrations`, and the
[identity link](identity.md) tables `host_link_codes` and `host_links`, and the
assistant host's `host_state` ([Kubernetes](kubernetes.md))):

- `chats` holds each chat's title, timestamps, writer epoch, last sequence
  number and digest, stored size, and a deletion marker.
- `chat_rows` holds the log: one row per stored write, keyed by chat, sequence
  number, and position in its commit, with an optional replacement key.
- `chat_shares` holds share tokens: a chat's owner shares it, and any user with
  app access who has the token can copy the chat, as it is at that moment, into
  their own chats under a new ID. The copy is independent of the original. The
  token is the only check, so treat links that contain it like the chat itself.
- `chat_share_copies` holds each user's copy of a shared chat and the sequence
  number it was copied at. Opening the link again opens the same copy; while
  the user has not written to it, it is first brought up to date with the
  original. A new copy is made when the user deleted theirs, or continued it
  while the original moved on as well.

Deleting a chat removes its rows and keeps a tombstone, so a view that still
holds the chat cannot store it again. There is no automatic expiry or per-user
quota; monitor the database size.

There is no migration from the storage of versions up to 5.x (Grafana user
storage and the PostgreSQL session snapshots). Chats from those versions are
not shown.

## API

All routes are plugin resources under `/api/plugins/<plugin ID>/resources`,
require app access, and return errors as `{"error": "..."}`; a conflict adds
`"reason": "lease"` or `"sequence"`.

| Route                                | Purpose                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `GET /chats?limit=&cursor=`          | Chat metadata, newest first.                                               |
| `POST /chats/{id}/open`              | Become the chat's writer; `{"create": false}` opens only an existing chat. |
| `GET /chats/{id}/log?cursor=&limit=` | The chat's log rows in order.                                              |
| `POST /chats/{id}/commits`           | Append one commit: `epoch`, `seq`, `digest`, `rows`, optional `title`.     |
| `PATCH /chats/{id}`                  | Rename.                                                                    |
| `DELETE /chats/{id}`                 | Delete and keep a tombstone.                                               |
| `POST /chats/{id}/share`             | A share token for the caller's chat (the same token each time).            |
| `POST /shares/{token}/copy`          | Copy the shared chat into the caller's chats; returns the caller's copy.   |

## Tests

`src/pages/Chat/durable/logStorage.test.ts` runs Pi Durable's storage
conformance suite against `LogStorage`, directly and with a reopen after every
commit, over an in-memory backend with the semantics of the Go store.
`src/pages/Chat/session/AssistantSession.test.ts` runs chats on that backend
with a scripted model: tool calls, reopening, an answer interrupted by a closed
view, takeover, and compaction.

The Go store tests (`pkg/chatlog`, `pkg/plugin/chats_test.go`) always run
against SQLite. To run them against PostgreSQL too, start the isolated fixture
and pass its DSN:

```sh
docker compose -p pi-sessions-ha -f docker-compose.sessions-ha.yaml up -d --wait postgres
PI_TEST_POSTGRES_DSN='postgres://postgres:postgres-test@localhost:55432/grafana?sslmode=disable' \
go test -race ./pkg/chatlog ./pkg/plugin
docker compose -p pi-sessions-ha -f docker-compose.sessions-ha.yaml down -v
```

The same fixture starts two Grafana replicas on ports 3002 and 3003 that share
the PostgreSQL schema (`mise run dev:reload:variant` builds the image they use).
