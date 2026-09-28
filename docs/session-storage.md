# PostgreSQL session storage

The assistant can store sessions in PostgreSQL through its existing Go plugin
backend. It needs no additional service, pod, shared filesystem, or sticky sessions.
The browser still runs the agent; saving a history does not make a running agent
survive browser closure.

Use the same PostgreSQL database as Grafana with a dedicated schema and role, or
a separate database. The plugin never reads Grafana's internal database tables.
All replicas must use identical session configuration and Grafana's normal shared
database, encryption settings and public root URL. This implementation is tested
with Grafana 13.2.1 and PostgreSQL 18.

## Configure

Create the role and schema as a database administrator, replacing the password:

```sql
CREATE ROLE pi_sessions LOGIN PASSWORD 'replace-with-a-secret';
-- Connect to the database named in the DSN (for example, grafana).
CREATE SCHEMA grafana_pi AUTHORIZATION pi_sessions;
GRANT CONNECT ON DATABASE grafana TO pi_sessions;
```

The role owns only the assistant schema; it does not need database-wide CREATE,
Grafana table privileges, or a writable `public` schema. Schema/table creation and
version tracking run on first use under a PostgreSQL transaction advisory lock.
Every table reference is explicitly schema-qualified. Schema names must be lowercase
letters, digits and underscores, starting with a letter (maximum 63 characters).
`public`, `information_schema`, and names starting with `pg_` are rejected.

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
      # Unique per independent Grafana deployment; stable across replicas/upgrades.
      sessionNamespace: production-observability
      # Optional internal URL for this Grafana's /api/signing-keys/keys endpoint.
      # Include Grafana's subpath if applicable. Otherwise the public AppURL is used.
      sessionGrafanaUrl: http://localhost:3000/
    secureJsonData:
      sessionPostgresDsn: $__env{PI_SESSION_POSTGRES_DSN}
```

Supply `PI_SESSION_POSTGRES_DSN` to Grafana using a Kubernetes Secret or equivalent:

```text
postgres://pi_sessions:URL_ENCODED_PASSWORD@postgres:5432/grafana?sslmode=verify-full
```

Configure trusted CA/client certificates using pgx connection parameters as needed.
Use `sslmode=disable` only in the isolated local test fixture. For a separate
database, change the database name and create the assistant schema there. Use
`g42-pi-app` instead of `grafana-assistant-app` when deploying the default variant.
Variants have separate data ownership scopes even if they share a schema.

The DSN belongs in **secureJsonData**, never jsonData. The plugin configuration
screen preserves the provisioned session fields when model settings change.
Session settings are provisioned rather than edited on that screen.

The backend also understands `PI_SESSION_POSTGRES_DSN`, `PI_SESSION_SCHEMA`,
`PI_SESSION_NAMESPACE` and `PI_SESSION_GRAFANA_URL` overrides **if** its process
receives them. Recent Grafana versions filter plugin process environments by
default. Prefer provisioning with Grafana's environment expansion, as above;
it works without forwarding the host environment to the plugin.

There are at most four database connections per active plugin instance (normally
per organization and plugin variant), per Grafana replica. Connections are opened
lazily and closed when the SDK disposes the instance. Statements have a 15-second
timeout; session HTTP operations have a 20-second deadline. Health checks include
the database when configured.

## Data and concurrency

- `sessions` holds title, creation/update timestamps, revision and deletion marker.
- `snapshots` holds one JSONB body per session: messages, workspace, artifacts,
  model/thinking settings and compaction state. Maximum body size: 32 MiB.
- `receipts` records successful mutation results for safe retries after lost responses.
- `legacy_imports` records completed imports; `migrations` tracks schema versions.

The backend derives ownership from a verified Grafana-signed identity token and
the SDK request context: deployment namespace, organization, plugin ID and stable
user UID. It validates signature, expiry, audience, issuer and identity type.
Anonymous users and service accounts cannot access personal session storage.
The internal signing-key URL does not change the expected public token issuer.

Lists use an indexed `(scope, updated_at, id)` cursor, returning 30 metadata rows
by default, at most 100. They never read the snapshot table. The full page offers
“Load more sessions”; the sidebar shows the most recent eight and links to that
page. A selected session loads its body separately. Concurrent updates can move
items ahead of an existing cursor; reload the picker to refresh the ordering.

Each mutation transaction atomically updates metadata and body, increments a
revision and records a request ID. Editing a stale revision returns HTTP 409.
The browser serializes writes and retries uncertain requests with the same ID.
Conflicts require reloading; export unsaved changes first. Deletes remove the
body and retain a tombstone so an old client cannot recreate it. Receipts and
tombstones are retained; there is no automatic history expiry or total per-user
storage quota in this first version. Include the schema in database backups and
monitor its size. Do not delete tombstones while stale clients may still write.

“Saving”, “Saved”, and “Not saved” describe write confirmation. Errors are visible,
and navigating away with an unconfirmed save prompts the user. A configured
PostgreSQL outage never switches writes to browser storage. Export remains
available for keeping a copy of unsaved work.

## Rollout and legacy histories

Without a configured DSN, existing Grafana user-storage behavior remains enabled.
Configuring PostgreSQL imports that user's histories on first use. The importer
reads all legacy session bodies, including bodies omitted from the old 50-entry
index, and browser fallback data. It preserves titles and original dates. Existing
PostgreSQL histories and deletion markers take precedence on repeated imports.
Legacy deletion removed only an index entry, so previously deleted chats with
retained bodies can reappear during recovery. Delete those again after import;
PostgreSQL deletion removes the body and prevents re-importing it.
Original legacy data is retained; a failed import is resumable and never marked
complete. Malformed histories require repair/export before the import can finish.

The first import still transfers the old user-storage resource. Later launches
fetch only metadata. Other browsers check their own fallback histories once;
they do not redownload the server legacy resource after its import is complete.
Finish active chats and roll out all replicas together: old plugin clients can
still write legacy storage, which is no longer synchronized after import. Removing
the DSN exposes the retained old histories, not newer PostgreSQL changes; export
those before rolling back. This is a one-way migration, not dual-write replication.

## Reproduce the HA checks

Build the sidebar variant, then start the isolated fixture:

```sh
mise run dev:reload:variant
docker compose -p pi-sessions-ha -f docker-compose.sessions-ha.yaml up -d --wait

PI_TEST_POSTGRES_DSN='postgres://postgres:postgres-test@localhost:55432/grafana?sslmode=disable' \
PI_TEST_RESTRICTED_DSN='postgres://pi_sessions:sessions-test@localhost:55432/grafana?sslmode=disable' \
go test -race ./pkg/sessionstore -v -bench=SessionList -benchtime=100x

PI_SESSION_HA_TEST=1 E2E_PLUGIN_ID=grafana-assistant-app \
GRAFANA_URL=http://localhost:3002 \
npx playwright test tests/sessionStorage.spec.ts --reporter=line
```

The fixture exposes replicas on 3002/3003 and PostgreSQL on 55432, bound to
localhost. Its credentials are disposable test values. Tests create their own
session IDs; restart tests stop only fixture services. It does not mount ordinary
development Grafana/PostgreSQL volumes. Stop it with the same compose file/project
name after testing.

## Validation results (2026-09-28)

- 253 Jest tests passed; TypeScript and targeted ESLint checks passed.
- Go tests passed with the race detector, including real PostgreSQL tests for
  concurrent writers/migrations, pagination ties, schema isolation, restricted
  role privileges, rollback on snapshot failure, retries and tombstones.
- Seven Playwright checks (authentication setup plus six scenarios) passed against
  two Grafana replicas on the same PostgreSQL database: replica routing, concurrent
  writes, metadata-only pagination, workspace reload, user isolation, visible save
  failures/retry, replica restart and database restart.
- Manual browser checks covered legacy mode on port 3001 and PostgreSQL metadata
  pagination on port 3003. The standalone production shell-worker test passed.
- The local store benchmark with 1,000 histories of 64 KB returned a 30-item page
  of 4,353 bytes in about 0.34 ms/op (100 iterations, race detector enabled).
  A browser metadata request with longer fixture titles returned 6,159 bytes in
  about 6 ms through Grafana. These are local measurements, not production SLAs.

The variant build succeeded with the existing Pi dependency and bundle-size
warnings. Browser testing also fixed a shell worker's duplicated chunk URL path,
which had prevented successful workspace shell commands in a production build.
