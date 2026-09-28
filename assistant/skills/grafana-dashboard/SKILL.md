---
name: grafana-dashboard
description: Design, generate, review, live-edit, and apply Grafana dashboards through the session filesystem.
---

# Grafana Dashboard Skill

Use this skill when the user asks for a dashboard, panel, row, variable, live dashboard edit, Jsonnet change, dashboard save, bulk dashboard change, or dashboard review.

## Operating Rules

- Treat dashboard generation as a persistent artifact. Only create, update, or live-edit dashboards when the user explicitly asks for a dashboard change.
- Inspect available metrics before selecting panel queries (`grafana-prom metrics`, `grafana-prom series`), and look at how existing dashboards use them (`grafana-usage search`, `grafana-usage related METRIC`, `grafana-usage dashboard UID`).
- Validate dashboard rate/trend PromQL with a range query (`grafana-prom query EXPR --from now-6h`) matching the dashboard time range. Use instant validation only for current-value stat/table evidence.
- Treat `validationError` or zero-series validation results as unusable panel evidence. Do not apply a dashboard with requested panels silently omitted; report the exact unvalidated signal instead.
- When a supervisor task provides explicit panel queries and says they were already validated from tool evidence with non-zero series and no `validationError`, treat that as a validated handoff. Do not redo broad metric discovery or revalidate every query; write, validate, and apply.
- For on-the-fly edits to the currently open dashboard, edit `/live/dashboard/dashboard.json` and run `live apply` when that file exists.
- Durable changes are files: `/grafana/dashboards/<uid>/dashboard.json` is a local working copy of a dashboard resource. Nothing reaches Grafana until an approved `workspace apply`.
- Prefer helper-based Jsonnet for new generated dashboards and direct JSON edits (`edit`, `jq`, `python3`) for changes to existing dashboards.
- Keep generated dashboards focused. A small useful dashboard is better than a broad dashboard with speculative panels.
- For create or update requests, apply after validation unless the user explicitly asks for a draft, preview, live-edit, or no-save workflow.

## Live Editing Workflow

1. Use live edits only for the currently open dashboard and only when `/live/dashboard/dashboard.json` exists.
2. For a dashboard-wide filter, go straight to `grafana-dashboard label-filter` (step 3) and `live apply`; its output lists every changed query, so no exploration is needed. Otherwise run `grafana-dashboard inspect /live/dashboard/dashboard.json` for exact element names, layout, and variables instead of parsing the file yourself. It is a v2 resource: panels are `spec.elements.<name>`, the layout tree is `spec.layout`, and variables are `spec.variables`.
3. Change panels with `grafana-dashboard set-panel PATH --panel ID [--title] [--unit] [--type] [--expr EXPR --ref A] [--x --y --w --h]` and add them with `grafana-dashboard add-panel PATH --title T --expr EXPR [--unit U] [--right-of ID | --below ID | --x X --y Y]`; they write schema-correct JSON for classic and v2. Hand-edit JSON (`jq`, `python3`, `edit`) only for changes these commands do not cover. For a dashboard-wide Prometheus filter, use `grafana-dashboard label-filter /live/dashboard/dashboard.json --label LABEL --variable-query 'label_values(METRIC, LABEL)' [--current VALUE]`; it rewrites every selected query and adds the variable with the selected value.
4. Run `live apply` once all requested edits are in the file; it validates first, so a separate validate is unnecessary. Edits are not visible in the browser until `live apply` succeeds.
5. After applying, read the file again (element names can be rekeyed) and verify the requested changes; `grafana-dashboard data /live/dashboard/dashboard.json --panel NAME` shows what a panel displays.
6. A variable's selected value must be one of the values its query returns; Grafana resets other values to All or the first option when the variable refreshes. If a value reverts after `live apply`, check it with `grafana-prom labels LABEL --match METRIC` and report the mismatch instead of applying again. If `live apply` fails, fix the file and apply again. If it reports that the browser dashboard changed, run `live discard`, read the file again, and redo the edit.
7. Do not stage or apply saved-dashboard changes for a live-edit request unless the user asks for a durable change.

## File Workflow

1. Collect the datasource UID, existing dashboard UID, and intent from the user or page context.
2. Existing dashboards: read `/grafana/dashboards/<uid>/dashboard.json` (fetched on first read; `grafana-dashboard inspect PATH` summarizes it, and `grafana-dashboard data PATH` shows which panels are empty or failing before you change anything), change it with `edit`, `jq`, or `python3`, and keep `metadata.name` unchanged.
3. New dashboards: write `/workspace/<name>.jsonnet`, then render it into a working copy:
   `mkdir -p /grafana/dashboards/<uid> && jsonnet /workspace/<name>.jsonnet --resource <uid> -o /grafana/dashboards/<uid>/dashboard.json`.
   Fix Jsonnet errors with `edit` and re-run; `jsonnet fix FILE` repairs common invalid constructors as a visible edit.
4. Run `grafana-dashboard fix PATH` (panel ids and grid layout) and `grafana-dashboard validate PATH`; fix every reported error. Add `--server` to dry-run the save in Grafana (permissions, strict decoding, and whether the dashboard changed since it was fetched).
5. Run `grafana-dashboard data PATH --panel ID` for panels whose queries, variables, or transformations changed. It runs the queries as the user and applies the panel's transformations, units, and reducers; treat `empty`, `error`, or `skipped` as findings to fix or report, not as success. For empty panels, read `executedQueries`: it shows the query as Grafana ran it, for example `$__rate_interval` resolved to a window shorter than the data's sample spacing.
6. Run `workspace apply`. The user approves the exact diff; report applied, conflicted, failed, or denied per dashboard.
7. For several dashboards at once, fetch them with `grafana fetch UID...`, search with `rg`, change them in one script, validate all, and apply them together.

## Jsonnet Rules

- For new dashboards, prefer `local d = import 'github.com/g42/pi-dashboard/main.libsonnet';` and use `d.dashboard.new`, `d.row`, `d.layout.*`, `d.panel.*`, and `d.prom.query`.
- Read `/.agents/skills/grafana-dashboard/references/example.md` or `/.agents/skills/grafana-dashboard/templates/prometheus.md` when you need a concrete helper example before writing Jsonnet.
- Do not import Grafonnet for new dashboards.
- Do not invent or use Grafonnet constructors such as `g.dashboard.new`, `grafana.dashboard.new`, `g.panel.new`, `grafana.panel.new`, `row.new`, or chained `.with_*` methods.
- Valid `d.dashboard.new` named arguments are `title`, `uid`, `tags`, `timezone`, `time`, `refresh`, `rows`, `panels`, and `variables`. `rows` takes `d.row(...)` results; `d.layout.*` groups in `rows` or `panels` are laid out without a row header. Use `time={ from: 'now-6h', to: 'now' }`; do not use `timeframe`, `timeFrom`, or `timeTo`.
- Variables go in `variables=[...]`: `d.variable.custom(name, values, current=null, multi=false, includeAll=false)` for fixed values (array or comma-separated string), `d.variable.labelValues(name, label, metric=null, datasourceUid=null, multi=false, includeAll=false, current=null)` for Prometheus label values, `d.variable.query(name, query, datasourceUid)`, `d.variable.constant(name, value)`, and `d.variable.textbox(name, value)`. Reference them in queries as `$name` (use `=~"$name"` for multi-value or All).
- Generate a plain object with `title`, stable `uid`, `tags`, `timezone`, `time`, `schemaVersion`, and `panels`.
- Use the helper layout APIs for common 24-column rows: `full`, `twoUp`, `threeUp`, `fourUp`, and `statStrip`. If writing raw panels, include explicit `gridPos` values.
- `d.layout.full` takes one panel object, not an array; `d.layout.twoUp`, `threeUp`, `fourUp`, and `statStrip` take arrays. Do not invent layout helpers.
- Valid helper panels are `d.panel.timeseries(title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={})`, `d.panel.stat(title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={})`, and `d.panel.table(title, datasourceUid, targets=[], columns=[], rename={}, transformations=[], options={}, fieldConfig={})`.
- Do not pass `span`, `description`, `sortByField`, or `sortDesc` to helper panels. Do not pass `unit` or `decimals` to `d.panel.table`; use `fieldConfig` defaults if needed.
- Use the selected Prometheus datasource UID directly in panel targets. Do not use datasource variables or unlisted datasource UIDs.
- For tables, use `d.panel.table(..., columns=[...], rename={...})` so the rendered table includes explicit `labelsToFields`, `filterFieldsByName`, and `organize` transformations.
- After writing a Jsonnet file once, use `edit` with exact `oldText` for follow-up changes instead of rewriting the whole file.
- The helper source is `/lib/jsonnet/github.com/g42/pi-dashboard/main.libsonnet`; read it with `cat` or find helpers with `rg -n NAME /lib/jsonnet/github.com/g42`.

## Panel Guidance

- Use time series panels for trends and rates.
- Use stat panels for single current values.
- Use tables for label-rich summaries.
- Add variables only when they reduce duplicated panels or make filtering materially useful.
- Make legends human-readable and stable.
- Avoid panel queries that require labels or metrics you have not verified.

## Safety

- Do not overwrite an existing dashboard without reading it first.
- Do not run `workspace apply` after a draft or preview-only request unless the user explicitly asks to apply or save.
- If `jsonnet` or `grafana-dashboard validate` fails, fix the source before offering the dashboard as complete.
- If apply reports `conflicted`, the dashboard changed in Grafana since it was fetched: run `grafana refresh <uid> --discard`, reapply the change, and run `workspace apply` again.
- If metrics are missing, state the gap instead of fabricating panels.

Use `workspace apply --path PATH` to select files when other unrelated changes are staged. No plan IDs or planning mode are used. Inspect receipts under `/session/receipts/`.
