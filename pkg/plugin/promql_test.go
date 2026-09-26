package plugin

import (
	"strings"
	"testing"
)

func TestParsePromQLQueries(t *testing.T) {
	results, err := parsePromQLQueries([]promQLParseQuery{
		{ID: "ok", Expr: `sum by (route) (rate(http_requests_total{job="api"}[5m]))`},
		{ID: "unclosed", Expr: `sum(rate(http_requests_total[5m])`},
		{ID: "escape", Expr: `up{job=~"api\.v1"}`},
		{ID: "label_replace", Expr: `label_replace(up, "x", "$1", "job", "(.*)")`},
		{ID: "experimental", Expr: `sort_by_label(up, "job")`},
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	byID := map[string]promQLParseResult{}
	for _, result := range results {
		byID[result.ID] = result
	}
	if byID["ok"].Error != "" || byID["label_replace"].Error != "" || byID["experimental"].Error != "" {
		t.Fatalf("valid queries rejected: %+v", results)
	}
	if byID["unclosed"].Error == "" || byID["unclosed"].Start == nil {
		t.Fatalf("expected positioned error for unclosed query: %+v", byID["unclosed"])
	}
	if !strings.Contains(byID["escape"].Error, "unknown escape sequence") {
		t.Fatalf("expected escape error, got %+v", byID["escape"])
	}
}

func TestParsePromQLQueriesLimits(t *testing.T) {
	if _, err := parsePromQLQueries(make([]promQLParseQuery, promQLParseMaxQueries+1)); err == nil {
		t.Fatal("expected an error for too many queries")
	}
	results, err := parsePromQLQueries([]promQLParseQuery{{ID: "big", Expr: strings.Repeat("a", promQLParseMaxExprBytes+1)}})
	if err != nil || !strings.Contains(results[0].Error, "too large") {
		t.Fatalf("expected size error, got %+v %v", results, err)
	}
}
