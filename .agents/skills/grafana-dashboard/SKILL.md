---
name: grafana-dashboard
description: Design, generate, review, live-edit, and save Grafana dashboards.
---

# Grafana Dashboard Skill

Use this skill when the user asks for a dashboard, panel, row, variable, live dashboard edit, Jsonnet change, dashboard save, or dashboard review.

## Operating Rules

- Treat dashboard generation as a persistent artifact. Only create, update, or live-edit dashboards when the user explicitly asks for a dashboard change.
- For create, update, review, live edit, render, or save work, call `run_dashboard_agent`; it owns the dashboard workflow and can use either live mutation tools or the session virtual Jsonnet file.
- Inspect available metrics before selecting panel queries. Use `run_dashboard_agent` for dashboard-level planning and `run_query_agent` for narrow metric reconnaissance.
- Validate dashboard rate/trend PromQL with `query_prometheus` `type="range"` and explicit start/end matching the dashboard time range. Use instant validation only for current-value stat/table evidence.
- Treat `validationError` or zero-series validation results as unusable panel evidence. Do not save a dashboard with requested panels silently omitted; report the exact unvalidated signal instead.
- When a supervisor task provides explicit panel queries and says they were already validated from tool evidence with non-zero series and no `validationError`, treat that as a validated handoff. Do not redo broad metric discovery or revalidate every query; build the dashboard plan, render, and save.
- Prefer live dashboard mutation tools for small on-the-fly edits to the currently open dashboard when those tools are available.
- Prefer Jsonnet dashboards for durable generated dashboards.
- For new durable dashboards whose panels can each reference validated query evidence, prefer `write_dashboard_plan` over raw `write_jsonnet`. It validates the typed plan, rejects unusable evidence, and writes helper-compatible `dashboard.jsonnet`.
- Use dashboard read tools to inspect existing dashboards before updating them when the user references an existing dashboard.
- Keep generated dashboards focused. A small useful dashboard is better than a broad dashboard with speculative panels.
- For a Jsonnet create or update dashboard request, render and save the dashboard after the Jsonnet compiles unless the user explicitly asks for a draft, preview, live-edit, or no-save workflow.

## Live Editing Workflow

1. Use live edits only for the currently open dashboard and only when live dashboard editing tools are available.
2. Call `list_live_dashboard_panels`, `get_live_dashboard_layout`, `get_live_dashboard_info`, or `list_live_dashboard_variables` before applying changes when you need exact element names, layout paths, dashboard UID, or variable names.
3. Prefer typed live tools: `rename_live_dashboard_panel`, `update_live_dashboard_panel_query`, `update_live_dashboard_panel_queries`, `apply_live_dashboard_prometheus_label_filter`, `add_live_dashboard_panel`, `move_or_resize_live_dashboard_panel`, `update_live_dashboard_settings`, `add_live_dashboard_variable`, and `update_live_dashboard_variable`.
4. Use `apply_live_dashboard_mutation` only for advanced commands that do not have a typed tool.
5. Use `apply_live_dashboard_prometheus_label_filter` for dashboard-wide Prometheus variable filters and `update_live_dashboard_panel_queries` for known multi-panel expression replacements. Use focused single-edit tools for heterogeneous changes.
6. Verify with `list_live_dashboard_panels`, `get_live_dashboard_layout`, `get_live_dashboard_info`, `list_live_dashboard_variables`, or the screenshot attached by layout-affecting live edit tools.
7. If a live mutation fails, inspect panels/layout/variables again and retry with corrected element names or paths before giving up.
8. Do not call `write_jsonnet`, `render_dashboard`, or `save_dashboard` for a live-edit request unless the user asks for a durable Jsonnet dashboard.

## Jsonnet Workflow

1. Call `run_dashboard_agent` with the user task, known datasource UID, existing dashboard UID, and intent when available.
2. Let the dashboard agent inspect metrics and existing dashboards, then write a typed dashboard plan or edit the session virtual Jsonnet file.
3. For new dashboards, the dashboard agent should call `write_dashboard_plan` after validation when the request fits the plan contract. Use raw `write_jsonnet` only when the requested dashboard cannot be expressed by the plan contract.
4. The dashboard agent should render the dashboard after writing.
5. If render returns validation warnings or layout fixes, repair material layout/table issues with `edit_jsonnet`, render again, then save for create or update requests unless the user explicitly asked for a draft or preview only.

## Jsonnet Rules

- For new dashboards, prefer `local d = import 'github.com/g42/pi-dashboard/main.libsonnet';` and use `d.dashboard.new`, `d.row`, `d.layout.*`, `d.panel.*`, and `d.prom.query`.
- Read `references/example.md` or `templates/prometheus.md` when you need a concrete helper example before writing Jsonnet.
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
- After the initial `write_jsonnet` call, do not call `write_jsonnet` again in the same session. Use `edit_jsonnet`, `fix_jsonnet`, or `read_jsonnet` for follow-up repairs.
- Before editing an existing Jsonnet block, use `read_jsonnet` for the relevant line window, include `expectedText`, and replace from the first line of the syntactic block rather than an inner argument line.

## Panel Guidance

- Use time series panels for trends and rates.
- Use stat panels for single current values.
- Use tables for label-rich summaries.
- Add variables only when they reduce duplicated panels or make filtering materially useful.
- Make legends human-readable and stable.
- Avoid panel queries that require labels or metrics you have not verified.

## Safety

- Do not overwrite an existing dashboard without reading it first.
- Do not call save tools after a draft or preview-only request unless the user explicitly asks to apply or save.
- If a render fails, fix the Jsonnet before offering the dashboard as complete.
- If metrics are missing, state the gap instead of fabricating panels.
