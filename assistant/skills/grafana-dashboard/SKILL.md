---
name: grafana-dashboard
description: Design, generate, review, live-edit, and apply Grafana dashboards through the session filesystem.
---

# Grafana Dashboard Skill

Use this skill when the user asks for a dashboard, panel, row, variable, live dashboard edit, Jsonnet change, dashboard save, bulk dashboard change, or dashboard review.

## Operating Rules

- Treat dashboard generation as a persistent artifact. Only create, update, or live-edit dashboards when the user explicitly asks for a dashboard change.
- Inspect available metrics before selecting panel queries (`grafana-prom metrics`, `grafana-prom series`), and look at how existing dashboards use them (`grafana-usage search --seed METRIC`, `grafana-usage related METRIC`, `grafana-usage dashboard UID`).
- Before filtering on a label value, list the values with the selector the panel will use (`grafana-prom labels service --match 'http_requests_total{namespace=~"team-a-.*"}'`); values seen on other series of the metric may not exist for this scope.
- Check expressions that use dashboard variables with `grafana-prom query EXPR --var NAME=VALUE`, or check the panel with `grafana-dashboard data`; `grafana-prom query` refuses unresolved `$variables`.
- Metric names that are not PromQL identifiers (for example with spaces, as some Telegraf exports produce) are selected by name: `{__name__="win service_state", service="svc a"}`.
- Validate dashboard rate/trend PromQL with a range query (`grafana-prom query EXPR --from now-6h`) matching the dashboard time range. Use instant validation only for current-value stat/table evidence.
- Treat `validationError` or zero-series validation results as unusable panel evidence. Do not apply a dashboard with requested panels silently omitted; report the exact unvalidated signal instead.
- For on-the-fly edits to the currently open dashboard, edit `/live/dashboard/dashboard.json` and run `live apply` when that file exists.
- Durable changes are files: `/grafana/dashboards/<uid>/dashboard.json` is a local working copy of a dashboard resource. Nothing reaches Grafana until an approved `workspace apply`.
- Prefer helper-based Jsonnet for new generated dashboards and direct JSON edits (`edit`, `jq`, `python3`) for changes to existing dashboards.
- Keep generated dashboards focused. A small useful dashboard is better than a broad dashboard with speculative panels.
- For create or update requests, apply after validation unless the user explicitly asks for a draft, preview, live-edit, or no-save workflow.
- Follow-up requests about a dashboard created or changed in this chat ("add a filter", "split 4xx and 5xx") are change requests: edit the working copy or live file and apply; do not answer with manual UI steps.
- Edit existing dashboards in place. Rendering Jsonnet over an existing dashboard replaces it: `jsonnet --resource` refuses when the result drops panels or variables, and `--replace` is only for a rebuild the user asked for. `workspace apply` lists removed panels, queries, transformations, and variables as `removal:` warnings; a removal the user did not ask for is a bug to fix before applying.

## Live Editing Workflow

1. Use live edits only for the currently open dashboard and only when `/live/dashboard/dashboard.json` exists.
2. For a dashboard-wide filter, go straight to `grafana-dashboard label-filter` (step 3) and `live apply`; its output lists every changed query, so no exploration is needed. Otherwise run `grafana-dashboard inspect /live/dashboard/dashboard.json` for exact element names, layout, and variables instead of parsing the file yourself. It is a v2 resource: panels are `spec.elements.<name>`, the layout tree is `spec.layout`, and variables are `spec.variables`.
3. Change panels with `grafana-dashboard set-panel PATH --panel ID [--title] [--unit] [--type] [--ds UID] [--expr EXPR --ref A] [--x --y --w --h]` and add them with `grafana-dashboard add-panel PATH --title T --expr EXPR [--unit U] [--like ID] [--right-of ID | --below ID | --top | --x X --y Y] [--row TITLE]`; they write schema-correct JSON for classic and v2 and move panels that are in the way down (reported as `moved`). `--like ID` copies visualization, options, legend, unit, thresholds, and datasource from a panel the new one should match; `--top --row TITLE` inserts at the start of a row. A full-width anchor leaves no room to its right: narrow it with `set-panel --w` first (the `note` says so). Pass `--ref` for every `--expr` on panels with several queries. Hand-edit JSON (`jq`, `python3`, `edit`) only for changes these commands do not cover; append to arrays (`.transformations += [...]`) instead of assigning them. For a dashboard-wide Prometheus filter, use `grafana-dashboard label-filter /live/dashboard/dashboard.json --label LABEL --variable-query 'label_values(METRIC, LABEL)' [--current VALUE]`; it rewrites every selected query and adds the variable with the selected value.
4. Run `live diff` and then `live apply` once all requested edits are in the file; it validates first, so a separate validate is unnecessary. Edits are not visible in the browser until `live apply` succeeds. `live apply` refuses edits that drop panels, queries, transformations, or variables; pass `--allow-removals` only when the user asked for those removals, otherwise restore them. `live undo` stages the state from before the last `live apply`.
5. After applying, read the file again (element names can be rekeyed) and verify the requested changes; `grafana-dashboard data /live/dashboard/dashboard.json --panel NAME` shows what a panel displays.
6. A variable's selected value must be one of the values its query returns; Grafana resets other values to All or the first option when the variable refreshes. If a value reverts after `live apply`, check it with `grafana-prom labels LABEL --match METRIC` and report the mismatch instead of applying again. If `live apply` fails, fix the file and apply again. If it reports that the browser dashboard changed, run `live discard`, read the file again, and redo the edit.
7. Do not stage or apply saved-dashboard changes for a live-edit request unless the user asks for a durable change. When the user asks to save the open dashboard after live edits, `live apply` and tell them to save in Grafana; do not also apply the working copy, or the browser state and the saved dashboard diverge.

## File Workflow

1. Collect the datasource UID, existing dashboard UID, and intent from the user or page context.
2. Existing dashboards: read `/grafana/dashboards/<uid>/dashboard.json` (fetched on first read; `grafana-dashboard inspect PATH` summarizes it, and `grafana-dashboard data PATH` shows which panels are empty or failing before you change anything), change it with `edit`, `jq`, or `python3`, and keep `metadata.name` unchanged.
3. New dashboards: write `/workspace/<name>.jsonnet`, then render it into a working copy:
   `mkdir -p /grafana/dashboards/<uid> && jsonnet /workspace/<name>.jsonnet --resource <uid> -o /grafana/dashboards/<uid>/dashboard.json`.
   Fix Jsonnet errors with `edit` and re-run; `jsonnet fix FILE` repairs common invalid constructors as a visible edit.
4. Run `grafana-dashboard fix PATH` (panel ids and grid layout) and `grafana-dashboard validate PATH`; fix every reported error. Add `--server` to dry-run the save in Grafana (permissions, strict decoding, and whether the dashboard changed since it was fetched).
5. Run `grafana-dashboard data PATH --panel ID` for panels whose queries, variables, or transformations changed. It runs the queries as the user and applies the panel's transformations, units, and reducers; treat `empty`, `error`, or `skipped` as findings to fix or report, not as success. For empty panels, read `executedQueries`: it shows the query as Grafana ran it, for example `$__rate_interval` resolved to a window shorter than the data's sample spacing.
6. Run `workspace apply`. The user reviews the change set, may uncheck dashboards, and approves; report applied, declined, conflicted, failed, or denied per dashboard.
7. Migrating panels from another datasource to Prometheus: `grafana-dashboard queries PATH --ds UID` lists every query of that datasource, builder queries included (InfluxQL shown as `expr`, `builder: true`). Find the Prometheus names (Telegraf exports InfluxDB measurement `m` field `f` as metric `m_f`, tags as labels) with `grafana-prom metrics REGEX` and `grafana-prom series`, then replace each query with `grafana-dashboard set-panel PATH --panel ID --ds PROM_UID --ref A --expr EXPR`, which rebuilds the target for Prometheus. Check with `grafana-dashboard data`, and report panels you could not map. Never ask the user for queries the file already contains.
8. For changes across many dashboards (every panel that uses a metric, datasource, or pattern), follow `/.agents/skills/grafana-dashboard/references/mass-edits.md`: find matches with `grafana-dashboard queries --metric NAME` or `rg` over `/grafana/dashboards` (every visible dashboard is listed and loads on demand), change them with one script, check `workspace diff --stat`, validate, and apply them together in one review.

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
- Valid helper panels are `d.panel.timeseries(title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={})`, `d.panel.stat(...)`, `d.panel.bargauge(...)`, and `d.panel.piechart(...)` with the same parameters, `d.panel.table(title, datasourceUid, targets=[], columns=[], rename={}, transformations=[], unit=null, decimals=null, options={}, fieldConfig={})`, and `d.panel.text(title, content, mode='markdown')` for notes such as data caveats. Use `bargauge` or `piechart` with instant queries for shares and top-N breakdowns.
- Do not pass `span`, `description`, `sortByField`, or `sortDesc` to helper panels.
- Use the selected Prometheus datasource UID directly in panel targets. Do not use datasource variables or unlisted datasource UIDs.
- For tables, use `d.panel.table(..., columns=[...], rename={...})` so the rendered table includes explicit `labelsToFields`, `filterFieldsByName`, and `organize` transformations.
- After writing a Jsonnet file once, use `edit` with exact `oldText` for follow-up changes instead of rewriting the whole file.
- The helper source is `/lib/jsonnet/github.com/g42/pi-dashboard/main.libsonnet`; read it with `cat` or find helpers with `rg -n NAME /lib/jsonnet/github.com/g42`.

## Panel Guidance

- Use time series panels for trends and rates.
- Use stat panels for single current values.
- Use tables for label-rich summaries.
- `percentunit` expects 0-1 values and `percent` 0-100; `grafana-dashboard validate` warns when the expression's scale does not match.
- Add variables only when they reduce duplicated panels or make filtering materially useful.
- Make legends human-readable and stable.
- Avoid panel queries that require labels or metrics you have not verified.

## Safety

- Do not overwrite an existing dashboard without reading it first.
- Do not run `workspace apply` after a draft or preview-only request unless the user explicitly asks to apply or save.
- If `jsonnet` or `grafana-dashboard validate` fails, fix the source before offering the dashboard as complete.
- If apply reports `conflicted`, the dashboard changed in Grafana since it was fetched: run `grafana refresh <uid> --discard`, reapply the change, and run `workspace apply` again.
- If metrics are missing, state the gap instead of fabricating panels.

Use `workspace apply --path PATH` to select files when other unrelated changes are staged. No plan IDs or planning mode are used. Inspect receipts under `/session/receipts/`. `workspace revert APPLY_ID` stages the dashboards of an earlier apply as they were before it; review and save the revert with `workspace apply`.
