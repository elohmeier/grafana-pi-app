---
name: grafana-alerting
description: Troubleshoot Grafana-managed alert rules, especially alert rules linked or related to dashboard panels.
---

# Grafana Alerting Skill

Use this skill when the user asks why an alert is firing, pending, warning, normal, missing data, or inconsistent with a dashboard panel.

## Operating Rules

- Alert support is read-only. Do not create, edit, pause, silence, delete, or persist alerting resources.
- For alert troubleshooting, call `run_alert_agent`; it owns the alert workflow.
- Use only the App Platform AlertRule tools for Grafana-managed alert rules.
- Compare the alert rule with the panel instead of assuming the panel state and alert state use the same query.

## Workflow

1. Identify the dashboard UID, panel ID, panel title, datasource UID, and time range from sidebar or user context.
2. Use `find_panel_alert_rules` to find linked rules by `spec.panelRef.dashboardUID`/`spec.panelRef.panelID` and by Grafana's dashboard link annotations `__dashboardUid__`/`__panelId__`.
3. If needed, call `get_alert_rule` for the exact rule.
4. Inspect dashboard context when the panel query, field thresholds, transformations, or time range matter.
5. Run the alert rule `prometheusChecks` with `query_prometheus`.
6. Compare alert evidence against panel evidence:
   - datasource UID
   - PromQL expression
   - label grouping and per-series cardinality
   - alert reducer and threshold evaluator
   - alert relative time range versus dashboard visible time range
   - `for` pending period and evaluation interval
   - `noDataState` and `execErrState`
   - panel thresholds and transformations
7. Explain the likely mismatch and give manual edit guidance for Grafana Alerting.

## Common Mismatch Patterns

- The panel uses a different PromQL query or label grouping than the alert rule.
- The panel shows a long visible range, but the alert evaluates only the last few minutes.
- The panel color threshold is visual only; the alert condition uses a reduce and threshold expression.
- The alert fires per label set, while the panel visually aggregates the data.
- `NoData`, `KeepLast`, or `Error` behavior changes state even when the plotted series looks normal.
- A pending `for` period or keep-firing period makes the state lag behind the latest plotted value.
- A rule can be discoverable through `spec.panelRef` but still not show a panel alert-state indicator if the `__dashboardUid__` and `__panelId__` annotations are missing from `spec.annotations`.
