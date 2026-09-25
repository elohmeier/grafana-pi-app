---
name: grafana-dashboard
description: Design, generate, review, live-edit, and apply Grafana dashboards through the session filesystem.
---

# Grafana Dashboard Skill

Use this skill when the user asks for a dashboard, panel, row, variable, live dashboard edit, Jsonnet change, dashboard save, bulk dashboard change, or dashboard review.

## Operating Rules

- Treat dashboard generation as a persistent artifact. Only create, update, or live-edit dashboards when the user explicitly asks for a dashboard change.
- Inspect available metrics before selecting panel queries (`grafana-prom metrics`, `grafana-prom series`), and look at how existing dashboards use them (`search_dashboard_metric_usage`, `get_metric_neighborhood`).
- Validate dashboard rate/trend PromQL with a range query (`grafana-prom query EXPR --from now-6h`) matching the dashboard time range. Use instant validation only for current-value stat/table evidence.
- Treat `validationError` or zero-series validation results as unusable panel evidence. Do not apply a dashboard with requested panels silently omitted; report the exact unvalidated signal instead.
- When a supervisor task provides explicit panel queries and says they were already validated from tool evidence with non-zero series and no `validationError`, treat that as a validated handoff. Do not redo broad metric discovery or revalidate every query; write, validate, plan, and apply.
- Prefer live dashboard mutation tools for small on-the-fly edits to the currently open dashboard when those tools are available.
- Durable changes are files: `/grafana/dashboards/<uid>/dashboard.json` is a local working copy of a dashboard resource. Nothing reaches Grafana until `workspace plan` and an approved `workspace apply <plan-id>`.
- Prefer helper-based Jsonnet for new generated dashboards and direct JSON edits (`edit`, `jq`, `python3`) for changes to existing dashboards.
- Keep generated dashboards focused. A small useful dashboard is better than a broad dashboard with speculative panels.
- For create or update requests, plan and apply after validation unless the user explicitly asks for a draft, preview, live-edit, or no-save workflow.

## Live Editing Workflow

1. Use live edits only for the currently open dashboard and only when live dashboard editing tools are available.
2. Call `list_live_dashboard_panels`, `get_live_dashboard_layout`, `get_live_dashboard_info`, or `list_live_dashboard_variables` before applying changes when you need exact element names, layout paths, dashboard UID, or variable names.
3. Prefer typed live tools: `rename_live_dashboard_panel`, `update_live_dashboard_panel_query`, `update_live_dashboard_panel_queries`, `apply_live_dashboard_prometheus_label_filter`, `add_live_dashboard_panel`, `move_or_resize_live_dashboard_panel`, `update_live_dashboard_settings`, `add_live_dashboard_variable`, and `update_live_dashboard_variable`.
4. Use `apply_live_dashboard_mutation` only for advanced commands that do not have a typed tool.
5. Use `apply_live_dashboard_prometheus_label_filter` for dashboard-wide Prometheus variable filters and `update_live_dashboard_panel_queries` for known multi-panel expression replacements. Use focused single-edit tools for heterogeneous changes.
6. Verify with `list_live_dashboard_panels`, `get_live_dashboard_layout`, `get_live_dashboard_info`, `list_live_dashboard_variables`, or the screenshot attached by layout-affecting live edit tools.
7. If a live mutation fails, inspect panels/layout/variables again and retry with corrected element names or paths before giving up.
8. Do not stage or apply saved-dashboard changes for a live-edit request unless the user asks for a durable change.

## File Workflow

1. Collect the datasource UID, existing dashboard UID, and intent from the user or page context.
2. Existing dashboards: read `/grafana/dashboards/<uid>/dashboard.json` (fetched on first read), change it with `edit`, `jq`, or `python3`, and keep `metadata.name` unchanged.
3. New dashboards: write `/workspace/<name>.jsonnet`, then render it into a working copy:
   `mkdir -p /grafana/dashboards/<uid> && jsonnet /workspace/<name>.jsonnet --resource <uid> -o /grafana/dashboards/<uid>/dashboard.json`.
   Fix Jsonnet errors with `edit` and re-run; `jsonnet fix FILE` repairs common invalid constructors as a visible edit.
4. Run `grafana-dashboard fix PATH` (panel ids and grid layout) and `grafana-dashboard validate PATH`; fix every reported error.
5. Run `workspace plan`, then `workspace apply <plan-id>`. The user approves the exact diff; report applied, conflicted, failed, or denied per dashboard.
6. For several dashboards at once, fetch them with `grafana fetch UID...`, search with `rg`, change them in one script, validate all, and plan them together.

## Jsonnet Rules

- For new dashboards, prefer `local d = import 'github.com/g42/pi-dashboard/main.libsonnet';` and use `d.dashboard.new`, `d.row`, `d.layout.*`, `d.panel.*`, and `d.prom.query`.
- Read `/.agents/skills/grafana-dashboard/references/example.md` or `/.agents/skills/grafana-dashboard/templates/prometheus.md` when you need a concrete helper example before writing Jsonnet.
- Do not import Grafonnet for new dashboards.
- Do not invent or use Grafonnet constructors such as `g.dashboard.new`, `grafana.dashboard.new`, `g.panel.new`, `grafana.panel.new`, `row.new`, or chained `.with_*` methods.
- Valid `d.dashboard.new` named arguments are `title`, `uid`, `tags`, `timezone`, `time`, `refresh`, and `rows`. Use `time={ from: 'now-6h', to: 'now' }`; do not use `timeframe`, `timeFrom`, or `timeTo`.
- Generate a plain object with `title`, stable `uid`, `tags`, `timezone`, `time`, `schemaVersion`, and `panels`.
- Use the helper layout APIs for common 24-column rows: `full`, `twoUp`, `threeUp`, `fourUp`, and `statStrip`. If writing raw panels, include explicit `gridPos` values.
- `d.layout.full` takes one panel object, not an array; `d.layout.twoUp`, `threeUp`, `fourUp`, and `statStrip` take arrays. Do not invent layout helpers.
- Valid helper panels are `d.panel.timeseries(title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={})`, `d.panel.stat(title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={})`, and `d.panel.table(title, datasourceUid, targets=[], columns=[], rename={}, transformations=[], options={}, fieldConfig={})`.
- Do not pass `span`, `description`, `sortByField`, or `sortDesc` to helper panels. Do not pass `unit` or `decimals` to `d.panel.table`; use `fieldConfig` defaults if needed.
- Use the selected Prometheus datasource UID directly in panel targets. Do not use datasource variables or unlisted datasource UIDs.
- For tables, use `d.panel.table(..., columns=[...], rename={...})` so the rendered table includes explicit `labelsToFields`, `filterFieldsByName`, and `organize` transformations.
- After writing a Jsonnet file once, use `edit` with exact `oldText` for follow-up changes instead of rewriting the whole file.
- `jsonnet lib cat github.com/g42/pi-dashboard/main.libsonnet` shows the helper source; `jsonnet lib search NAME` finds helper functions.

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
- If apply reports `conflicted`, the dashboard changed in Grafana since it was fetched: run `grafana refresh <uid> --discard`, reapply the change, and plan again.
- If metrics are missing, state the gap instead of fabricating panels.
