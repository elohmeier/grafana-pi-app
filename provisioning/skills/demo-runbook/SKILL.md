---
name: demo-runbook
description: Incident workflow for the services of the local demo data set. Use when the user asks for the demo runbook.
---

# Demo Runbook

A sample skill from the skills directory (`provisioning/skills`), loaded by the plugin backend. Activate it with `$demo-runbook`.

1. Start with the request rate, error ratio, and latency of the affected service (`grafana-prom query`).
2. Compare the onset with deployments and with saturation of the hosts the service runs on.
3. Follow `references/escalation.md` when the error ratio stays above 5 % for 15 minutes.
