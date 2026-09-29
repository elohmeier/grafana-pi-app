---
name: grafana-alerting
description: Troubleshoot and change Grafana-managed alert rules, especially alert rules linked or related to dashboard panels.
---

# Grafana Alerting Skill

Use this skill when the user asks why an alert is firing, pending, warning, normal, missing data, or inconsistent with a dashboard panel, or asks to change an alert rule (threshold, pending period, labels, annotations, query, pause).

## Operating Rules

- Troubleshooting is read-only. Change alert rules only when the user asks for a change.
- Alert rules are files: `/grafana/alert-rules/<uid>/rule.json` is a local working copy of every Grafana-managed rule the user can see; `meta.json` next to it shows its revision, evaluation group, and whether it is provisioned. `/grafana/catalog/alert-rules.ndjson` lists every rule (uid, title, folder, group, labels, linked dashboard and panel).
- Nothing reaches Grafana until `workspace apply`, which shows the user the diff and asks for approval. Dashboards and alert rules can be applied in one review.
- Provisioned rules (provenance `file`, `api`, `converted_prometheus`) are read-only; tell the user to change them in their source.
- A rule's evaluation interval (`spec.trigger.interval`) belongs to its evaluation group and applies to all rules in it. Do not change it for a grouped rule; tell the user to change the group's interval in Grafana. Rules that are in no group can change their own interval.
- Moving rules between folders or groups, silences, contact points, and notification policies cannot be changed here; give manual guidance.
- Compare the alert rule with the panel instead of assuming the panel state and alert state use the same query.

## Troubleshooting Workflow

1. Identify the dashboard UID, panel ID, panel title, datasource UID, and time range from sidebar or user context.
2. Run `grafana-alert find --dashboard UID --panel ID` to find linked rules by `spec.panelRef.dashboardUID`/`spec.panelRef.panelID` and by Grafana's dashboard link annotations `__dashboardUid__`/`__panelId__`. Filter with jq, for example `| jq '.matches[] | {score, reasons, path, condition: .rule.alertCondition}'`. To search every rule instead, use `rg` or `jq` over `/grafana/alert-rules` or the catalog.
3. If needed, run `grafana-alert get NAME` for the exact rule, or read its `rule.json`.
4. Inspect the panel with `grafana-dashboard inspect /grafana/dashboards/<uid>/dashboard.json --panel ID` when the panel query, field thresholds, transformations, or time range matter.
5. Run the alert rule `prometheusChecks` with `grafana-prom query` (use `--from` matching the rule's relative time range).
6. Compare alert evidence against panel evidence:
   - datasource UID
   - PromQL expression
   - label grouping and per-series cardinality
   - alert reducer and threshold evaluator
   - alert relative time range versus dashboard visible time range
   - `for` pending period and evaluation interval
   - `noDataState` and `execErrState`
   - panel thresholds and transformations
7. Explain the likely mismatch. If the user wants it fixed, follow the change workflow.

## Change Workflow

1. Find the rule: `grafana-alert find`, or `jq -c 'select(.title | test("5xx"; "i"))' /grafana/catalog/alert-rules.ndjson`.
2. Edit `rule.json` with jq for structured changes, for example a threshold:
   `jq '.spec.expressions.C.model.conditions[0].evaluator.params = [5]' R/rule.json > /tmp/r && cp /tmp/r R/rule.json`
   The condition is the expression with `"source": true`; `threshold` expressions hold the evaluator, `reduce` expressions the reducer, and queries (with `datasourceUID`) the PromQL in `model.expr` and a `relativeTimeRange`.
3. Run the changed query with `grafana-prom query` when it changed, so the new condition is based on evidence.
4. Run `grafana-alert validate` (all changed rules) and fix every error.
5. Run `workspace apply`. Report the outcome from the receipt: `applied`, `declined` (unchecked in the review), or `conflicted` (the rule changed in Grafana meanwhile: `grafana refresh /grafana/alert-rules/<uid> --discard`, edit again, apply again).
6. To undo, run `workspace revert APPLY_ID`, then `workspace apply`.

New rules go into a new directory `/grafana/alert-rules/<new-uid>/rule.json` (copy an existing rule and change `metadata.name`); they are created in no evaluation group. `rm -r /grafana/alert-rules/<uid>` stages a deletion that the review shows like any other change.

## Common Mismatch Patterns

- The panel uses a different PromQL query or label grouping than the alert rule.
- The panel shows a long visible range, but the alert evaluates only the last few minutes.
- The panel color threshold is visual only; the alert condition uses a reduce and threshold expression.
- The alert fires per label set, while the panel visually aggregates the data.
- `NoData`, `KeepLast`, or `Error` behavior changes state even when the plotted series looks normal.
- A pending `for` period or keep-firing period makes the state lag behind the latest plotted value.
- A rule can be discoverable through `spec.panelRef` but still not show a panel alert-state indicator if the `__dashboardUid__` and `__panelId__` annotations are missing from `spec.annotations`.
