## Project knowledge

This repository contains a **Grafana plugin**. You must Read @./.config/AGENTS/instructions.md before doing changes.

## Local development

- Work with the sidebar-capable `grafana-assistant-app` variant first unless the task specifically requires the default `g42-pi-app` plugin ID. When its Docker stack is already running, iterate on frontend-only changes with `npm run build:variant` and refresh http://localhost:3001; `dist` is bind-mounted, so do not run a `mise` reload task for routine frontend changes.
- Use `mise run dev:reload:variant` to start the sidebar-capable stack or when changes affect the Go backend, plugin manifest, provisioning, Docker/Compose configuration, or other runtime state that requires a rebuild or restart.
- Use `mise run dev:reload:variant:seed` when you need the sidebar-capable variant plus stable manual-test fixtures. It reloads http://localhost:3001 and seeds the Assistant Dev Samples folder with dashboard editing, stale dashboard context, dashboard metric discovery, and panel-linked alert troubleshooting samples.
- Use `mise run dev:reload:variant:fresh` when Prometheus demo data must be regenerated too. This runs `docker compose down -v --remove-orphans`, so it deletes local Grafana and Prometheus Compose volumes before rebuilding, reseeding Prometheus history, and reseeding the Grafana samples. Prefer the non-fresh seed task unless you intentionally want to reset local state.
- Use `npm run dev:seed:samples` to reseed only the Grafana dashboard/alert samples against an already-running stack. It defaults to `GRAFANA_URL=http://localhost:3001`; set `GRAFANA_URL=http://localhost:3000` only when intentionally targeting the default plugin stack.
- When intentionally working with the default `g42-pi-app` plugin ID, use `npm run dev` for frontend-only changes against an already-running stack. Use `mise run dev:reload` only to start that stack or when backend or runtime changes require a rebuild or restart; it rebuilds both plugin artifacts and reloads Docker services.
- Use `npm run benchmark:dashboard-editing` to run the local Qwen/sidebar benchmark for approved typed live dashboard edits, failed-edit recovery, and unavailable-runtime fallback through Grafana's restricted dashboard mutation API.
- The default local LLM config expects an OpenAI-compatible llama-server running on the host with Ornith-1.5-35B-A3B (Q4_K_M GGUF) on port 8080. Start or verify that llama-server before local assistant testing, benchmarks, or flows that need model responses. See the `llama-server` invocation in @README.md for the exact flags (model, chat template, sampling, port 8080).
- For local Grafana testing, use the `agent-browser` skill to drive http://localhost:3001: open pages, inspect snapshots, click through sidebar flows, capture screenshots, and verify behavior interactively.

## Reference sources

- Grafana source code is checked out at `$HOME/repos/github.com/grafana/grafana`. Grep or read it when you need to confirm current Grafana API behavior rather than relying on stale training data.

## Commit conventions

Use semantic commit messages following Conventional Commits, for example `fix: escape search PromQL regexes`.
