# Mass edits across dashboards

Every dashboard the user can see is listed under `/grafana/dashboards/<uid>/dashboard.json`. Content loads on first read, and a scan (`rg`, `grep -r`, `find`, a glob, `xargs`) loads the rest in parallel. There is no limit on how many dashboards you read, change, or apply at once; the user reviews the whole change set before anything is saved.

## 1. Find the matches

- Queries by metric, datasource, or pattern, with the jq path of each query text:
  `grafana-dashboard queries --metric http_server_requests_seconds_count > /tmp/q.ndjson`
  `grafana-dashboard queries --ds prometheus --match 'rate\([^)]*\[1m\]' > /tmp/q.ndjson`
  Each line has `path`, `uid`, `dashboard`, `kind` (panel or variable), `key` (panel id or v2 element name), `title`, `refId`, `datasource`, `expr`, and `jqPath`. It handles classic and v2 dashboards, collapsed rows, and variable queries.
- Anything else in the JSON: `grep -rlE PATTERN /grafana/dashboards` (much faster than `rg` over hundreds of dashboards in this shell), or `grep -rnE` for lines.
- Count before changing: `jq -r .uid /tmp/q.ndjson | sort -u | wc -l`. Tell the user how many dashboards and queries match, and show a few examples, before a large change.
- Library panels keep their queries outside the dashboard; report matches in `libraryPanel` references instead of editing them.

## 2. Change them with one script

- Text replacements: `grep -rlE PATTERN /grafana/dashboards | xargs sed -i -E 's/OLD/NEW/g'`. Keep the pattern tight: the dashboard JSON escapes quotes inside queries as `\"`.
- Exactly the listed queries, by jq path:
  `jq -r '[.path, .jqPath] | @tsv' /tmp/q.ndjson | while read -r file query; do jq "($query) |= sub(\"OLD\"; \"NEW\")" "$file" > /tmp/x && cp /tmp/x "$file"; done`
- Structural changes (units, thresholds, panel replacement): a `python3` script over the files. Run `grafana fetch --all` (or `grafana fetch -` with UIDs on stdin) first, because python only sees loaded dashboards.
- Keep `metadata.name` unchanged. Never change dashboards the user did not ask about.

## 3. Check the change set

- `workspace diff --stat`: changed lines per dashboard and the replacements repeated across dashboards. Every intended replacement should appear as one group with the expected count; `ungroupedChanges` should be 0 or explained.
- `grafana-dashboard validate PATH...` accepts many paths. Errors a dashboard already had before your change do not block `workspace apply`; errors you introduced do.
- `grafana-dashboard data PATH --panel ID` on a sample of changed panels.

## 4. Apply and report

- `workspace apply` opens one review for the whole change set: repeated replacements, a folder-grouped dashboard list with per-dashboard diffs, and checkboxes. The user may uncheck dashboards; those are reported as `declined` and keep their working-copy change.
- Report the counts (`applied`, `declined`, `conflicted`, `failed`). For conflicts, `grafana refresh UID --discard`, redo the change for those dashboards, and apply again.
- Undo: `workspace revert APPLY_ID` stages the previous versions from Grafana's history; review and save them with `workspace apply`.
