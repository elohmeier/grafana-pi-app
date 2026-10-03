# Restricted SQL access (Microsoft SQL Server)

Implemented 2026-10-03, following the [restricted log access](restricted-logs.md)
design: `grafana-sql` (`workspace/commands/sql.ts`, `workspace/sql.ts`), the
`sqlDatasources` setting, and the [local fixture](#local-test-setup).

## Design

Sensitive content in SQL tables lives in string and binary columns: names,
e-mail addresses, descriptions, documents. Numeric, date/time, bit, and
uniqueidentifier columns are non-sensitive. Unlike Elasticsearch, SQL Server
has no type that tells a status code from free text, so string columns are
sensitive unless the admin lists them as visible.

- The assistant sees the tables and their columns, counts rows (filtered by any
  column, grouped by visible columns, in time buckets), and reads rows with
  their visible columns.
- Sensitive columns can be filtered on (`--where 'ShortDescription~timeout'`)
  but are never selected. As with free text search in logs, counts are an
  oracle for their content, and that is accepted.

Everything is one shell command, `grafana-sql`, implemented in the frontend like
`grafana-logs`. It builds every query itself and runs it through Grafana's
`/api/ds/query` as the current user. The model supplies only names and values;
there is no raw SQL. There is no backend broker and no redaction logic. The
restriction controls what reaches the model, not what the user sees.

## Policy

The policy is non-secret configuration in `jsonData`, next to `logDatasources`.
A datasource that is not listed is denied.

```yaml
sqlDatasources:
  - uid: mssql-itsm
    tables: [dbo.Incidents, dbo.Changes]
    visibleColumns: [dbo.Incidents.State, dbo.Incidents.Service, dbo.Changes.Version]
```

- `tables`: `schema.table` or `table` (any schema). Empty means every table and
  view of the datasource's database.
- `visibleColumns`: string columns that may be returned, as
  `schema.table.column` or `table.column`. Only `char`, `varchar`, `nchar`,
  `nvarchar`, `text`, and `ntext` columns can be listed.
- Names match case-insensitively, like SQL Server's default collation.
- The datasource credential usually reads more: in the fixture, the login can
  also read `dbo.Employees`, which is not configured.

## Column rule

The command reads `INFORMATION_SCHEMA.COLUMNS` for the table. A column is
visible when its type is numeric (`bigint`, `int`, `smallint`, `tinyint`,
`decimal`, `numeric`, `money`, `smallmoney`, `float`, `real`), date/time
(`date`, `datetime`, `datetime2`, `smalldatetime`, `datetimeoffset`, `time`),
`bit`, or `uniqueidentifier` (an allow-list, so unknown types stay hidden), or
when it is a listed string column. `xml`, binary, spatial, and `sql_variant`
columns are always hidden.

Only visible columns are selected, grouped by, and ordered by.

## Command

```text
grafana-sql sources
grafana-sql tables [REGEX]
grafana-sql columns TABLE [--visible]
grafana-sql count TABLE [--where 'COL OP VALUE' ...] [--null COL] [--not-null COL]
                  [--time COL --since 6h | --from T --to T] [--by COL [--top N]] [--interval 1h]
grafana-sql rows  TABLE [filters] [--columns A,B] [--order COL [--asc]] [--limit N]
```

- Tables and columns are resolved against `INFORMATION_SCHEMA` and the policy,
  then written as bracketed identifiers.
- `--where` takes `=`, `!=`, `<`, `<=`, `>`, `>=`, `~` (contains, `LIKE` with
  escaped wildcards), and `!~`. Values are checked against the column type
  (numbers, ISO dates, GUIDs) so SQL Server never converts a column value in an
  error message, and are written as `N'...'` literals. Grafana's SQL datasources
  have no bind parameters, and Grafana expands `$__macro(...)` anywhere in the
  query text, so a `$` in a value is written as `NCHAR(36)`.
- `--time` filters with Grafana's `$__timeFilter` macro, so `--since`, `--from`,
  and `--to` use Grafana's time parsing (date math or epoch milliseconds; ISO
  timestamps are converted to epoch milliseconds). Times are UTC.
- `count` sends the total, the top groups, and the time buckets in one
  `/api/ds/query` request. Buckets without rows are omitted.
- `rows` prints NDJSON, ordered by `--order` or the `--time` column (newest
  first), and reports the total and the number of columns not returned on
  stderr. `--limit` defaults to 100 and has no fixed maximum.
- Results are registered as artifacts. SQL errors are passed on; they name
  tables, columns, and the command's own literals.

`grafana-dashboard screenshot` refuses panels of MSSQL datasources, like those
of every datasource other than allowed Prometheus and test data.

## Local test setup

The Compose profile `sql` adds SQL Server 2022 (Developer edition, amd64; it
runs under Rosetta on Apple silicon) with an `itsm` database:

- `dbo.Incidents`: 30 days of background incidents across six services, and
  24 incidents for `report-renderer` on `vm-web-01` starting three minutes into
  the Prometheus demo incident.
- `dbo.Changes`: background changes, plus CHG-4711 (report-renderer 3.8.0 on
  vm-web-01, implemented 155 s into the incident) and CHG-4712 (the rollback).
- `dbo.Employees`: readable by the `grafana` login, not in the policy.

Sensitive columns carry sentinel values (`PI-SENTINEL-SQL-...`); visible
columns carry none. The seeder reads the Prometheus timeline like the log
fixture, so incidents line up with the metrics.

```bash
mise run dev:sql          # start SQL Server, seed once (Grafana on port 3001 must run)
mise run dev:sql:reseed   # regenerate for the current Prometheus history
```

Grafana gets the `mssql-itsm` datasource from
`provisioning/datasources/mssql.yaml` and the policy from
`provisioning/plugins/app.yaml`. With `PI_PLUGIN_PROVISIONING_FILE` set, rerun
`npm run dev:import:skills` so the generated file picks up the policy.

`tests/restrictedSql.spec.ts` runs the command against the fixture with a
scripted model and checks that no sentinel reaches a model request or a chat
log commit:

```bash
E2E_PLUGIN_ID=grafana-assistant-app GRAFANA_URL=http://localhost:3001 npx playwright test tests/restrictedSql.spec.ts
```
