import { WORKSPACE_COMMANDS } from './commands/commands';
import { renderCommandReference } from './commands/registry';

export function renderWorkspacePromptSection(
  options: { pythonAvailable?: boolean; liveDashboardMounted?: boolean } = {}
) {
  return `## Session Filesystem And Shell
You have four general tools over one persistent per-chat filesystem: read, write, edit, and bash.
Layout:
- /grafana/dashboards/<uid>/dashboard.json: local working copy of a Grafana dashboard resource ({apiVersion, kind, metadata, spec}). Reading it fetches the dashboard on first access. meta.json next to it is provider-owned (revision, folder, managed-by) and read-only.
- /grafana/catalog/dashboards.ndjson and coverage.json: metadata-only dashboard catalog (loaded on first read; check coverage.json before claiming completeness).
${options.liveDashboardMounted ? '- /live/dashboard/*.json: read-only unsaved state of the dashboard open in the browser.\n' : ''}- /workspace (default cwd), /session (plan.md, findings.md), /tmp: scratch files. /workspace and /session persist with the chat; /tmp does not.
- /artifacts: earlier tool results (index.ndjson); /.agents/skills/<name>/SKILL.md: skill instructions and references. Both read-only.
- /lib/jsonnet/<import path>: read-only vendored Jsonnet libraries (github.com/g42/pi-dashboard, github.com/grafana/grafonnet, ...); read them with cat, head, rg, and find.

Rules:
- Writes to dashboard.json only stage local changes. Nothing reaches Grafana until you run \`workspace plan\` and then \`workspace apply <plan-id>\`, which asks the user to approve the exact diff. Never claim a dashboard was changed before apply reports "applied".
- \`rg\`, \`find\`, and \`grep\` only see hydrated dashboards; use \`grafana search\` or the catalog for remote discovery and report coverage honestly.
- Bash variables and cwd reset between calls; files persist. Each bash call is one transaction: its file changes are committed when it ends and discarded on timeout, except that \`workspace\` commands first commit the writes made earlier in the same call.
- Prefer edit for small precise changes, jq/python for structured bulk edits, and always run \`grafana-dashboard validate\` before \`workspace plan\`. After changing queries, run \`grafana-dashboard data PATH --panel ID\` to confirm the panels show data.
- Durable dashboard changes always go through these files. For live edits of the dashboard open in the browser, use the live dashboard tools instead.
- New dashboards: write helper-based Jsonnet under /workspace, render with \`jsonnet FILE --resource <uid> -o /grafana/dashboards/<uid>/dashboard.json\`, then \`grafana-dashboard fix\` and \`grafana-dashboard validate\` before planning.

Commands (run \`<command> --help\` for options):
${renderCommandReference(WORKSPACE_COMMANDS)}
- Standard tools: cat, ls, find, rg, grep, sed, awk, jq, yq, diff, sort, uniq, head, tail, wc, xargs, cut, tr, tee${
    options.pythonAvailable ? ', python3 (CPython with stdlib, no network; sees a copy of the filesystem)' : ''
  }.`;
}
