# Dashboard Jsonnet Workflow

Use this sequence for Jsonnet dashboards:

1. Read `/.agents/skills/grafana-dashboard/references/example.md` or `/.agents/skills/grafana-dashboard/templates/prometheus.md` when you need a concrete helper example.
2. `write` the source to `/workspace/<name>.jsonnet`.
3. `mkdir -p /grafana/dashboards/<uid> && jsonnet /workspace/<name>.jsonnet --resource <uid> -o /grafana/dashboards/<uid>/dashboard.json`
4. `grafana-dashboard fix /grafana/dashboards/<uid>/dashboard.json` and `grafana-dashboard validate /grafana/dashboards/<uid>/dashboard.json`; repair errors in the Jsonnet with `edit` and re-run step 3.
5. `workspace plan`, then `workspace apply <plan-id>` for create or update requests unless the user asked for a draft or preview only.

`jsonnet FILE` without `-o` prints the evaluated JSON, which is useful with `jq` to inspect panels before rendering into the working copy.

For new dashboards, prefer the bundled helper library:

```jsonnet
local d = import 'github.com/g42/pi-dashboard/main.libsonnet';
```

Use `d.dashboard.new(title=..., uid=..., time={ from: 'now-6h', to: 'now' }, rows=[...])`, `d.row`, `d.layout.full`, `d.layout.twoUp`, `d.layout.threeUp`, `d.layout.fourUp`, `d.layout.statStrip`, `d.panel.timeseries`, `d.panel.stat`, `d.panel.table`, and `d.prom.query`.

Valid `d.dashboard.new` named arguments are `title`, `uid`, `tags`, `timezone`, `time`, `refresh`, and `rows`. Do not use `timeframe`, `timeFrom`, or `timeTo`.

`d.layout.full` takes one panel object, for example `d.layout.full(d.panel.table(...), h=10)`. `d.layout.twoUp`, `threeUp`, `fourUp`, and `statStrip` take arrays of panels.

Valid helper panel signatures:

- `d.panel.timeseries(title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={})`
- `d.panel.stat(title, datasourceUid, targets=[], unit=null, decimals=null, options={}, fieldConfig={})`
- `d.panel.table(title, datasourceUid, targets=[], columns=[], rename={}, transformations=[], options={}, fieldConfig={})`

Do not pass `span`, `description`, `sortByField`, or `sortDesc` to helper panels. Do not pass `unit` or `decimals` to `d.panel.table`; use `fieldConfig` defaults if needed.

Do not import Grafonnet and do not use constructor chains such as `grafana.dashboard.new()` or `.with_*` methods. If you write raw panels instead of helper calls, write a plain object with explicit `panels`, `targets`, and `gridPos` fields.

If variables are needed, use a plain Grafana templating object:

```jsonnet
+ {
  templating: {
    list: [
      d.variable.query(
        name='job',
        datasourceUid='prometheus',
        query='label_values(up, job)',
        label='Job',
        includeAll=true,
        multi=true,
      ),
    ],
  },
}
```

For tables, pass explicit `columns=[...]` and `rename={...}` to `d.panel.table` so the generated panel filters and organizes visible columns.

Before writing dashboard panels, validate candidate rate/trend PromQL with a range query (`grafana-prom query EXPR --from ... --to ...`) matching the dashboard time range. Treat `validationError` or zero-series candidates as unusable evidence. If the supervisor task already provides explicit panel queries and says they were validated from tool evidence with non-zero series and no `validationError`, trust that handoff and move directly to writing the Jsonnet.

Prefer short file names that match the dashboard subject, for example `node-overview.jsonnet` or `service-latency.jsonnet`.

When updating a dashboard:

- Read the current Jsonnet file first.
- Preserve the existing style and helper usage.
- Keep edits scoped to the requested panels or variables.
- For block replacements, include `expectedText` from the read window and replace from the first line of the block, not from a nested argument line.
- Render before reporting completion.
