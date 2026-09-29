import { WORKSPACE_COMMANDS } from './commands/commands';
import { renderCommandReference } from './commands/registry';

export function renderWorkspacePromptSection(
  options: { pythonAvailable?: boolean; liveDashboardMounted?: boolean } = {}
) {
  return `## Session Filesystem And Shell
You have four general tools over one persistent per-chat filesystem: read, write, edit, and bash.
Layout:
- /grafana/dashboards/<uid>/dashboard.json: local working copy of a Grafana dashboard resource ({apiVersion, kind, metadata, spec}). Every dashboard the user can see is listed; content is fetched on first read, and scans (rg, grep -r, find, globs) load all of them in parallel. meta.json next to it is provider-owned (revision, folder, managed-by) and read-only; its \`conversion\` field means Grafana could not convert the dashboard, so the file stays in its stored apiVersion and must be edited in that version.
- /grafana/catalog/dashboards.ndjson: metadata of every visible dashboard (uid, title, folder, tags).
${options.liveDashboardMounted ? '- /live/dashboard/dashboard.json: unsaved state of the dashboard open in the browser (v2 resource, editable; `live diff`, then `live apply` updates the browser without saving). info.json next to it is read-only.\n' : ''}- /workspace (default cwd), /session (findings.md, report.md, read-only context.json and receipts/), /tmp: scratch files. /session/report.md is shown to the user next to the chat. /workspace and /session persist with the chat; /tmp does not.
- /session/context.json: read-only context captured for the current turn. /session/receipts: read-only save outcomes and complete diffs. Use \`evidence show PATH --view table|json|text|image\` to present captured results without another query.
- /artifacts: earlier tool results (index.ndjson); /.agents/skills/<name>/SKILL.md: skill instructions and references. Both read-only.
- /lib/jsonnet/<import path>: read-only vendored Jsonnet libraries (github.com/g42/pi-dashboard, github.com/grafana/grafonnet, ...); read them with cat, head, rg, and find.

Rules:
- The save workflow is direct apply. There is no workspace plan command or plan ID. Use workspace apply [--path PATH] after editing.
- Writes to dashboard.json only stage local changes. Nothing reaches Grafana until you run \`workspace apply\`, which opens a review of the change set; the user may uncheck dashboards (reported as declined). Never claim a dashboard was changed before apply reports "applied".
- To find every panel that uses a metric, datasource, or pattern, use \`grafana-dashboard queries --metric NAME\` (NDJSON with jq paths) or \`grep -rlE PATTERN /grafana/dashboards\`; both cover every visible dashboard. Change many dashboards in one script and check \`workspace diff --stat\` before \`workspace apply\`.
- Bash variables and cwd reset between calls; files persist. Each bash call is one transaction: its file changes are committed when it ends and discarded on timeout, except at explicit \`workspace apply\` or \`live apply\` boundaries, which commit earlier writes.
- Prefer edit for small precise changes, jq/python for structured bulk edits, and always run \`grafana-dashboard validate\` before \`workspace apply\`. After changing queries, run \`grafana-dashboard data PATH --panel ID\` to confirm the panels show data.
- Durable dashboard changes always go through these files. Live edits of the dashboard open in the browser go through /live/dashboard/dashboard.json and \`live apply\`.
- New dashboards: write helper-based Jsonnet under /workspace, render with \`jsonnet FILE --resource <uid> -o /grafana/dashboards/<uid>/dashboard.json\`, then \`grafana-dashboard fix\` and \`grafana-dashboard validate\` before applying.

Commands (run \`<command> --help\` for options):
${renderCommandReference(WORKSPACE_COMMANDS)}
- Standard tools: cat, ls, find, rg, grep, sed, awk, jq, yq, diff, sort, uniq, head, tail, wc, xargs, cut, tr, tee${
    options.pythonAvailable ? ', python3 (CPython with stdlib, no network; sees a copy of the filesystem)' : ''
  }.`;
}
