package plugin

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
)

func TestEvaluateWorkspaceJsonnetResolvesWorkspaceAndVendorImports(t *testing.T) {
	output, err := evaluateWorkspaceJsonnet(context.Background(), api.JsonnetEvalRequest{
		Entrypoint: "/workspace/main.jsonnet",
		Files: map[string]string{
			"/workspace/main.jsonnet":         `local lib = import 'lib/panels.libsonnet'; local d = import 'github.com/g42/pi-dashboard/main.libsonnet'; { title: std.extVar('title'), n: lib.n, hasHelper: std.objectHas(d, 'dashboard') }`,
			"/workspace/lib/panels.libsonnet": `{ n: 3 }`,
		},
		ExtStr: map[string]string{"title": "Checkout"},
	})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(output), &decoded); err != nil {
		t.Fatalf("decode %q: %v", output, err)
	}
	if decoded["title"] != "Checkout" || decoded["n"] != float64(3) || decoded["hasHelper"] != true {
		t.Fatalf("unexpected output: %v", decoded)
	}
}

func TestEvaluateWorkspaceJsonnetRejectsUnsafeInput(t *testing.T) {
	cases := []api.JsonnetEvalRequest{
		{Entrypoint: "/workspace/a.jsonnet", Files: map[string]string{"relative.jsonnet": "{}"}},
		{Entrypoint: "/workspace/a.jsonnet", Files: map[string]string{"/workspace/../a.jsonnet": "{}"}},
		{Entrypoint: "/workspace/missing.jsonnet", Files: map[string]string{"/workspace/a.jsonnet": "{}"}},
		{Entrypoint: "/workspace/a.jsonnet", Files: map[string]string{"/workspace/a.jsonnet": "import '/etc/passwd'"}},
		{Entrypoint: "/workspace/a.jsonnet", Files: map[string]string{"/workspace/a.jsonnet": "import '../../pkg/plugin/app.go'"}},
	}
	for index, request := range cases {
		if _, err := evaluateWorkspaceJsonnet(context.Background(), request); err == nil {
			t.Fatalf("case %d: expected an error", index)
		}
	}
}

func TestEvaluateWorkspaceJsonnetStringOutput(t *testing.T) {
	output, err := evaluateWorkspaceJsonnet(context.Background(), api.JsonnetEvalRequest{
		Entrypoint: "/tmp/a.jsonnet",
		Files:      map[string]string{"/tmp/a.jsonnet": `"hello " + std.extVar('who')`},
		ExtStr:     map[string]string{"who": "world"},
		String:     true,
	})
	if err != nil || strings.TrimSpace(output) != "hello world" {
		t.Fatalf("unexpected output %q err %v", output, err)
	}
}

func TestPiDashboardHelperVariables(t *testing.T) {
	output, err := evaluateWorkspaceJsonnet(context.Background(), api.JsonnetEvalRequest{
		Entrypoint: "/workspace/dash.jsonnet",
		Files: map[string]string{"/workspace/dash.jsonnet": `
local d = import 'github.com/g42/pi-dashboard/main.libsonnet';
{
  withVariables: d.dashboard.new(
    title='Routes',
    variables=[
      d.variable.custom('route', '/, /api/orders, /render/report', current='/render/report'),
      d.variable.labelValues('job', 'job', metric='up', datasourceUid='prometheus', multi=true, includeAll=true, current=['api', 'web']),
      d.variable.constant('env', 'prod'),
    ],
  ),
  withTemplatingAlias: d.dashboard.new(title='Alias', templating={ list: [d.variable.textbox('filter', '.*')] }),
  withoutVariables: d.dashboard.new(title='Plain'),
  mixin: d.dashboard.new(title='Mixin') + d.dashboard.withTemplating([d.variable.custom('mode', ['a', 'b'], multi=true)]),
}`},
	})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	var decoded struct {
		WithVariables       map[string]any `json:"withVariables"`
		WithTemplatingAlias map[string]any `json:"withTemplatingAlias"`
		WithoutVariables    map[string]any `json:"withoutVariables"`
		Mixin               map[string]any `json:"mixin"`
	}
	if err := json.Unmarshal([]byte(output), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	variables := func(dashboard map[string]any) []map[string]any {
		templating, _ := dashboard["templating"].(map[string]any)
		list, _ := templating["list"].([]any)
		result := make([]map[string]any, 0, len(list))
		for _, item := range list {
			result = append(result, item.(map[string]any))
		}
		return result
	}

	list := variables(decoded.WithVariables)
	if len(list) != 3 {
		t.Fatalf("expected 3 variables, got %v", list)
	}
	route := list[0]
	if route["type"] != "custom" || route["query"] != "/,/api/orders,/render/report" {
		t.Fatalf("unexpected custom variable: %v", route)
	}
	if current := route["current"].(map[string]any); current["value"] != "/render/report" {
		t.Fatalf("unexpected custom current: %v", current)
	}
	options := route["options"].([]any)
	if len(options) != 3 || options[2].(map[string]any)["selected"] != true || options[0].(map[string]any)["selected"] != false {
		t.Fatalf("unexpected custom options: %v", options)
	}
	job := list[1]
	if job["type"] != "query" || job["query"] != "label_values(up, job)" || job["definition"] != "label_values(up, job)" || job["refresh"] != float64(2) {
		t.Fatalf("unexpected label values variable: %v", job)
	}
	if values, _ := job["current"].(map[string]any)["value"].([]any); len(values) != 2 {
		t.Fatalf("expected multi-value current, got %v", job["current"])
	}
	if list[2]["type"] != "constant" || list[2]["query"] != "prod" {
		t.Fatalf("unexpected constant variable: %v", list[2])
	}
	if alias := variables(decoded.WithTemplatingAlias); len(alias) != 1 || alias[0]["type"] != "textbox" {
		t.Fatalf("templating alias not applied: %v", alias)
	}
	if _, ok := decoded.WithoutVariables["templating"]; ok {
		t.Fatalf("expected no templating without variables: %v", decoded.WithoutVariables)
	}
	mixin := variables(decoded.Mixin)
	if len(mixin) != 1 || mixin[0]["current"].(map[string]any)["value"].([]any)[0] != "a" {
		t.Fatalf("unexpected mixin variables: %v", mixin)
	}
}

func TestPiDashboardHelperPanelKinds(t *testing.T) {
	output, err := evaluateWorkspaceJsonnet(context.Background(), api.JsonnetEvalRequest{
		Entrypoint: "/workspace/dash.jsonnet",
		Files: map[string]string{"/workspace/dash.jsonnet": `
local d = import 'github.com/g42/pi-dashboard/main.libsonnet';
local q = d.prom.query('sum by (namespace) (rate(http_requests_total[$__rate_interval]))', 'prom-main', instant=true);
d.dashboard.new(
  title='Kinds',
  panels=[
    d.layout.twoUp([
      d.panel.table('Share', 'prom-main', [q], unit='percent', decimals=1),
      d.panel.bargauge('Top', 'prom-main', [q], unit='reqps'),
    ]),
    d.layout.twoUp([
      d.panel.piechart('Split', 'prom-main', [q], unit='reqps'),
      d.panel.text('Notes', 'Counts come from the ingest tier.'),
    ]),
  ],
)`},
	})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	var dashboard struct {
		Panels []struct {
			Title       string         `json:"title"`
			Type        string         `json:"type"`
			GridPos     map[string]int `json:"gridPos"`
			Datasource  any            `json:"datasource"`
			Targets     []any          `json:"targets"`
			Options     map[string]any `json:"options"`
			FieldConfig struct {
				Defaults map[string]any `json:"defaults"`
			} `json:"fieldConfig"`
		} `json:"panels"`
	}
	if err := json.Unmarshal([]byte(output), &dashboard); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(dashboard.Panels) != 4 {
		t.Fatalf("panels = %d, want 4: %s", len(dashboard.Panels), output)
	}
	table, bargauge, piechart, text := dashboard.Panels[0], dashboard.Panels[1], dashboard.Panels[2], dashboard.Panels[3]
	if table.Type != "table" || table.FieldConfig.Defaults["unit"] != "percent" || table.FieldConfig.Defaults["decimals"] != float64(1) {
		t.Fatalf("table = %+v", table)
	}
	if bargauge.Type != "bargauge" || bargauge.FieldConfig.Defaults["unit"] != "reqps" || len(bargauge.Targets) != 1 {
		t.Fatalf("bargauge = %+v", bargauge)
	}
	if piechart.Type != "piechart" || piechart.FieldConfig.Defaults["unit"] != "reqps" {
		t.Fatalf("piechart = %+v", piechart)
	}
	if text.Type != "text" || text.Datasource != nil || len(text.Targets) != 0 ||
		text.Options["content"] != "Counts come from the ingest tier." || text.Options["mode"] != "markdown" {
		t.Fatalf("text = %+v", text)
	}
	if text.GridPos["x"] != 12 || text.GridPos["y"] != piechart.GridPos["y"] {
		t.Fatalf("text gridPos = %v, piechart gridPos = %v", text.GridPos, piechart.GridPos)
	}
}

func TestPiDashboardHelperForgivesCommonMistakes(t *testing.T) {
	output, err := evaluateWorkspaceJsonnet(context.Background(), api.JsonnetEvalRequest{
		Entrypoint: "/workspace/dash.jsonnet",
		Files: map[string]string{"/workspace/dash.jsonnet": `
local d = import 'github.com/g42/pi-dashboard/main.libsonnet';
local ts(title) = d.panel.timeseries(title, 'prometheus', [d.prom.query('up', 'prometheus', legendFormat='{{job}}')]);
d.dashboard.new(
  title='Mistakes',
  panels=[d.layout.twoUp([ts('A'), ts('B')])],
  rows=[
    d.layout.full(ts('Bare group')),
    d.row('Details', [d.layout.full(ts('C'))]),
  ],
).withTemplating([d.variable.custom('route', ['/a', '/b'])]).withVariables([d.variable.constant('env', 'prod')])`},
	})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	var dashboard struct {
		Panels []struct {
			ID      int               `json:"id"`
			Title   string            `json:"title"`
			Type    string            `json:"type"`
			GridPos map[string]int    `json:"gridPos"`
			Targets []json.RawMessage `json:"targets"`
		} `json:"panels"`
		Templating struct {
			List []map[string]any `json:"list"`
		} `json:"templating"`
		WithVariables any `json:"withVariables"`
	}
	if err := json.Unmarshal([]byte(output), &dashboard); err != nil {
		t.Fatalf("decode: %v", err)
	}
	type placed struct {
		title, kind string
		y, x        int
	}
	var got []placed
	for _, panel := range dashboard.Panels {
		got = append(got, placed{panel.Title, panel.Type, panel.GridPos["y"], panel.GridPos["x"]})
	}
	want := []placed{
		{"A", "timeseries", 0, 0},
		{"B", "timeseries", 0, 12},
		{"Bare group", "timeseries", 8, 0},
		{"Details", "row", 16, 0},
		{"C", "timeseries", 17, 0},
	}
	if len(got) != len(want) {
		t.Fatalf("unexpected panels: %+v", got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("panel %d: got %+v, want %+v", index, got[index], want[index])
		}
	}
	var target map[string]any
	if err := json.Unmarshal(dashboard.Panels[0].Targets[0], &target); err != nil || target["legendFormat"] != "{{job}}" {
		t.Fatalf("legendFormat alias not applied: %s", dashboard.Panels[0].Targets[0])
	}
	if len(dashboard.Templating.List) != 2 || dashboard.Templating.List[0]["name"] != "route" || dashboard.Templating.List[1]["name"] != "env" {
		t.Fatalf("unexpected chained variables: %v", dashboard.Templating.List)
	}
	if dashboard.WithVariables != nil {
		t.Fatal("chain methods must stay hidden")
	}
}
