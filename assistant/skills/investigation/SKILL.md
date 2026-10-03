---
name: investigation
description: Run evidence-based Prometheus investigations and maintain an investigation report in /session/report.md.
---

# Investigation Skill

Use this skill when the user asks to investigate, diagnose, explain why something is happening, find root cause, or analyze an incident, outage, failure, latency spike, error spike, or degradation.

## Workflow

1. Define the scope: affected service, host, route, symptom, datasource UID, and time range when available.
2. Create `/session/report.md` early with `write`, with a `# title` line, the initial scope, and open hypotheses. The user sees this file next to the chat.
3. Gather evidence with metric discovery and PromQL validation in bash (`grafana-prom metrics`, `grafana-prom series`, `grafana-prom query --from ...`). Batch related queries in one bash call, and keep raw notes in /session/findings.md.
   When log datasources are configured (`grafana-logs sources`), use logs as counts next to metrics: `grafana-logs count -q 'log.level:ERROR' --interval 5m` for the time pattern, `--by error.type` or `--by host.name` for the affected scope, and `grafana-logs search` for individual events (without message text). Look for unrestricted events, such as deployments, that precede a change.
4. Update the report after each material finding. Add evidence only when it came from a tool result or user-provided context.
5. Keep hypotheses separate from evidence. Move invalidated ideas to ruled-out causes.
6. End with current finding, confidence, remaining gaps, and next checks or remediation.

For selector-recovery tasks, keep the loop bounded: validate the provided failing selector batch once, inspect labels/series once to identify the bad selector, validate the recovered query batch once, then retry only failed recovered queries once individually. After that, stop querying and summarize the best validated handoff plan with any remaining gaps.

When the investigation leads to a dashboard, PromQL expressions plus datasource UID, totalSeries, validationError status, and key label names are sufficient evidence. Do not read artifacts to extract tenant values or full per-series detail unless the user explicitly requested raw data.

## Report Rules

- Use Markdown sections `## Scope`, `## Evidence`, `## Hypotheses`, `## Ruled out`, `## Next checks`, and `## Remediation` with one bullet per item. Update them with `edit`; the file is ordinary Markdown, so tables and code blocks for PromQL are fine.
- Put a `Status: active` line under the title and change it to `Status: complete` only when the investigation has a defensible answer or a clear handoff state.
- Do not invent dashboard, datasource, metric, label, or host names. Use only values returned by tools or provided by the user.
- If evidence is insufficient, state what was checked and what remains unknown.
