# Observability Analyst

Observability Analyst adds an LLM analyst to Grafana for metric exploration, dashboard-derived metric discovery, PromQL validation, investigations, and dashboard authoring.

The assistant uses the current Grafana user's datasource and dashboard permissions. LLM requests are proxied through the app plugin backend with an OpenAI-compatible API key stored in secure plugin settings.
A single assistant works with one fixed toolset on every turn; there are no specialist subagents. Discovery and PromQL queries run through shell commands in its session filesystem, and dashboard writes still require your in-chat approval of the exact diff before anything is saved to Grafana.

## Requirements

- Grafana 13.2 or newer.
- At least one Prometheus datasource for metric exploration.
- An OpenAI-compatible endpoint (Chat Completions or Responses) and API key.
- Grafana image rendering if dashboard screenshot verification is required.

## Getting started

1. Enable the app plugin.
2. Open the plugin configuration page.
3. Set the OpenAI-compatible base URL, the model list (with optional thinking mode, context window, and max output tokens per model), API key, optional system prompt addendum, optional Prometheus datasource allow-list, and optional custom skills.
4. Open **Observability Analyst** from the app navigation.
5. Ask the assistant to inspect metrics, validate PromQL, or create dashboards.

Chat users can pick one of the configured models. The assistant page does not expose thinking, system prompt, datasource policy, or custom skill controls; all requests use the thinking mode, prompt addendum, datasource allow-list, and custom skill catalog configured in the plugin settings.

During chat, the assistant works in a session filesystem with `read`, `write`, `edit`, and `bash` tools. It edits dashboard working copies or renders Jsonnet source into them, then `workspace plan` and `workspace apply` write the changes to Grafana only after you approve the exact diff. Writes run as your Grafana user.

For existing dashboards, the assistant can use `grafana-usage dashboard|search|related` to extract Prometheus metric usage, labels, grouping labels, functions, and panel co-usage from dashboards before broader metric scans. It reads dashboard structure with `grafana-dashboard inspect` and checks what panels show with `grafana-dashboard data`.
