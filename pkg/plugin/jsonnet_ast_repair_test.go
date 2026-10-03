package plugin

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
)

func repairAndEvaluateDashboard(t *testing.T, source string) (string, []string, map[string]any) {
	t.Helper()
	repaired, repairs, err := repairJsonnetDashboardSource(source)
	if err != nil {
		t.Fatalf("repair: %s", err)
	}
	output, err := evaluateWorkspaceJsonnet(context.Background(), api.JsonnetEvalRequest{
		Entrypoint: "/dashboard.jsonnet",
		Files:      map[string]string{"/dashboard.jsonnet": repaired},
	})
	if err != nil {
		t.Fatalf("evaluate repaired source: %s\n%s", err, repaired)
	}
	var dashboard map[string]any
	if err := json.Unmarshal([]byte(output), &dashboard); err != nil {
		t.Fatalf("decode dashboard: %s", err)
	}
	return repaired, repairs, dashboard
}

func TestRepairJsonnetDashboardSourceGenericGrafonnetDashboard(t *testing.T) {
	source := `local g = import 'github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet';

g.dashboard.new(
  title='HTTP Request Rate and Errors',
  uid='http-request-rate-errors',
  tags=['http', 'errors'],
  timezone='browser',
  refresh='5s',
  panels=[
    g.panel.new(
      title='Total request rate',
      id=1,
      gridPos=g.gridPos.to_val(x=0, y=0, w=24, h=8),
      targets=[
        g.target.new(
          datasource='prometheus',
          expr='sum(rate(http_requests_total[5m])) by (job)',
          refId='A',
          legendFormat='{{job}}',
        ),
      ],
      type='timeseries',
      fieldConfigDefaults=g.panel.defaultFieldConfig.setUnit('reqps'),
    ),
    g.panel.new(
      title='Overall error rate %',
      id=2,
      gridPos=g.gridPos.to_val(x=0, y=8, w=12, h=8),
      targets=[
        g.target.new(
          datasource='prometheus',
          expr='sum(rate(http_requests_total{status=~"4..|5.."}[5m])) / sum(rate(http_requests_total[5m])) * 100',
          refId='A',
        ),
      ],
      type='stat',
      fieldConfigDefaults=g.panel.defaultFieldConfig.setUnit('percent'),
    ),
  ],
)`
	repaired, repairs, dashboard := repairAndEvaluateDashboard(t, source)
	if len(repairs) == 0 {
		t.Fatalf("expected repairs")
	}
	if strings.Contains(repaired, "g.panel.new") || !strings.Contains(repaired, "fieldConfig") {
		t.Fatalf("repair did not rewrite panel constructors: %s", repaired)
	}
	if dashboard["uid"] != "http-request-rate-errors" || len(dashboard["panels"].([]any)) != 2 {
		t.Fatalf("unexpected rendered dashboard: %#v", dashboard)
	}
}

func TestRepairJsonnetDashboardSourcePanelsMixinAndLocalPanels(t *testing.T) {
	source := `local g = import 'github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet';
local reqByRoute = g.timeseries.new(
  title='Requests by route',
  id=1,
  span=24,
  datasource=g.target.defaultDatasource('prometheus'),
  targets=[
    g.target.new(
      expr='sum(rate(http_requests_total[5m])) by (route)',
      refId='A',
      legend='{{route}}',
    ),
  ],
  fieldConfig=g.panel.fieldConfig.defaults(unit='reqps'),
);

g.dashboard.new(
  title='HTTP Request Rate and Errors',
  uid='http-request-rate-errors',
  tags=['http', 'errors'],
) + g.dashboard.with_panels([reqByRoute])`
	repaired, _, dashboard := repairAndEvaluateDashboard(t, source)
	if !strings.Contains(repaired, "Requests by route") || strings.Contains(repaired, "with_panels") {
		t.Fatalf("unexpected repaired source: %s", repaired)
	}
	panels := dashboard["panels"].([]any)
	if dashboard["uid"] != "http-request-rate-errors" || len(panels) != 1 || panels[0].(map[string]any)["type"] != "timeseries" {
		t.Fatalf("unexpected rendered dashboard: %#v", dashboard)
	}
}

func TestRepairJsonnetDashboardSourceMinimalPanelConstructor(t *testing.T) {
	source := `local g = import 'github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet';

g.dashboard.new(
  title='HTTP Request Rate and Errors',
  uid='http-request-rate-errors',
  panels=[
    g.panel.new(
      title='Request rate',
      targets=[
        g.target.new(
          datasource='prometheus',
          expr='sum(rate(http_requests_total[5m]))',
          refId='A',
        ),
      ],
      type='timeseries',
    ),
  ],
)`
	repaired, repairs, dashboard := repairAndEvaluateDashboard(t, source)
	if len(repairs) == 0 || strings.Contains(repaired, "g.panel.new") || !strings.Contains(repaired, "Request rate") {
		t.Fatalf("unexpected repair: %v\n%s", repairs, repaired)
	}
	panels := dashboard["panels"].([]any)
	if dashboard["uid"] != "http-request-rate-errors" || len(panels) != 1 || panels[0].(map[string]any)["type"] != "timeseries" {
		t.Fatalf("unexpected rendered dashboard: %#v", dashboard)
	}
}

func TestRepairJsonnetDashboardSourceRejectsUnsupportedSource(t *testing.T) {
	if _, _, err := repairJsonnetDashboardSource("{ title: 'x' }"); err == nil {
		t.Fatalf("expected error for source without g.dashboard.new")
	}
	if _, _, err := repairJsonnetDashboardSource("{ title: "); err == nil {
		t.Fatalf("expected parse error")
	}
}

func TestRepairJsonnetDashboardSourceExplainsHelperSources(t *testing.T) {
	source := `local d = import 'github.com/g42/pi-dashboard/main.libsonnet';
d.dashboard.new(title='Helper', panels=[d.layout.full(d.panel.timeseries('Rate', 'prom-main', []))])`
	_, _, err := repairJsonnetDashboardSource(source)
	if err == nil {
		t.Fatal("expected an error for a pi-dashboard helper source")
	}
	for _, want := range []string{"d.dashboard.new", "pi-dashboard", "edit"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not mention %q", err, want)
		}
	}
}
