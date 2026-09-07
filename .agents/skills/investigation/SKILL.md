---
name: investigation
description: Run evidence-based Prometheus investigations and maintain a structured investigation report.
---

# Investigation Skill

Use this skill when the user asks to investigate, diagnose, explain why something is happening, find root cause, or analyze an incident, outage, failure, latency spike, error spike, or degradation.

## Workflow

1. Define the scope: affected service, host, route, symptom, datasource UID, and time range when available.
2. Use `update_report` early to create a report with the initial scope and open hypotheses.
3. Gather evidence with metric discovery and PromQL validation. Call `run_investigation_agent` for full diagnostic or "what is wrong" analysis; use `run_query_agent` only for narrow follow-up reconnaissance.
4. Update the report after each material finding. Add evidence only when it came from a tool result or user-provided context.
5. Keep hypotheses separate from evidence. Move invalidated ideas to ruled-out causes.
6. End with current finding, confidence, remaining gaps, and next checks or remediation.

For selector-recovery tasks, keep the loop bounded: validate the provided failing selector batch once, inspect labels/series once to identify the bad selector, validate the recovered query batch once, then retry only failed recovered queries once individually. After that, stop querying and summarize the best validated handoff plan with any remaining gaps.

For dashboard handoffs, PromQL expressions plus datasource UID, totalSeries, validationError status, and key label names are sufficient evidence. Do not read artifacts to extract tenant values or full per-series detail unless the user explicitly requested raw data.

## Report Rules

- Use `update_report` JSON Pointer paths such as `/scope/-`, `/evidence/-`, `/hypotheses/-`, `/ruledOut/-`, `/nextSteps/-`, and `/remediation/-`.
- Use `/status` with `complete` only when the investigation has a defensible answer or a clear handoff state.
- Do not invent dashboard, datasource, metric, label, or host names. Use only values returned by tools or provided by the user.
- If evidence is insufficient, state what was checked and what remains unknown.
