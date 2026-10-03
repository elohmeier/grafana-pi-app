#!/usr/bin/env bash
# Seeds the `itsm` database of the restricted SQL fixture (Compose profile `sql`,
# docs/restricted-sql.md). Incidents and changes follow the Prometheus demo
# incident when its timeline file exists, like the Elasticsearch log fixture.
set -euo pipefail

sqlcmd() {
  /opt/mssql-tools18/bin/sqlcmd -C -b -S "${MSSQL_HOST:-mssql}" -U sa -P "$MSSQL_SA_PASSWORD" "$@"
}

if [[ "${SQL_FORCE:-0}" == "0" ]] &&
  [[ "$(sqlcmd -h -1 -W -Q "SET NOCOUNT ON; SELECT CASE WHEN DB_ID(N'itsm') IS NULL THEN 0 ELSE 1 END")" == "1" ]]; then
  echo "itsm database already exists; skipping (set SQL_FORCE=1 to reseed)."
  exit 0
fi

now=$(date +%s)
incident_start=$((now - ${INCIDENT_DURATION_SECONDS:-900}))
history_end=$now
if [[ -n "${TIMELINE_FILE:-}" && -f "$TIMELINE_FILE" ]]; then
  field() { grep -o "\"$1\": *[0-9]*" "$TIMELINE_FILE" | grep -o '[0-9]*$'; }
  incident_start=$(field incidentStartTimestamp)
  history_end=$(($(field endTimestamp) + $(field futureSeconds)))
  echo "using Prometheus history timeline from $TIMELINE_FILE"
else
  echo "no Prometheus timeline found; the incident ends now and may not line up with existing Prometheus history"
fi

sqlcmd -i "$(dirname "$0")/seed.sql" \
  -v IncidentStart="$incident_start" HistoryEnd="$history_end" GrafanaPassword="$GRAFANA_MSSQL_PASSWORD"
echo "seeded itsm: incident start $(date -u -d "@$incident_start" +%FT%TZ)"
