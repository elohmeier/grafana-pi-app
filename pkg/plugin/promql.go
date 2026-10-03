package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/prometheus/prometheus/promql/parser"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
)

const (
	promQLParseMaxQueries    = 500
	promQLParseMaxExprBytes  = 64 << 10
	promQLParseMaxInputBytes = 4 << 20
)

// handlePromQLParse checks PromQL syntax with the upstream Prometheus parser.
// It accepts experimental syntax so that it never rejects a query a newer
// datasource backend supports; it does not check metric existence.
func (a *App) handlePromQLParse(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body api.PromQLParseRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, promQLParseMaxInputBytes)).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}
	results, err := parsePromQLQueries(body.Queries)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, api.PromQLParseResponse{Results: results})
}

func parsePromQLQueries(queries []api.PromQLParseQuery) ([]api.PromQLParseResult, error) {
	if len(queries) > promQLParseMaxQueries {
		return nil, fmt.Errorf("too many queries (%d > %d)", len(queries), promQLParseMaxQueries)
	}
	p := parser.NewParser(parser.Options{
		EnableExperimentalFunctions:  true,
		ExperimentalDurationExpr:     true,
		EnableExtendedRangeSelectors: true,
		EnableBinopFillModifiers:     true,
	})
	results := make([]api.PromQLParseResult, 0, len(queries))
	for _, query := range queries {
		result := api.PromQLParseResult{ID: query.ID}
		if len(query.Expr) > promQLParseMaxExprBytes {
			result.Error = fmt.Sprintf("expression too large (%d bytes)", len(query.Expr))
		} else if _, err := p.ParseExpr(query.Expr); err != nil {
			result.Error = err.Error()
			var parseErrs parser.ParseErrors
			if errors.As(err, &parseErrs) && len(parseErrs) > 0 {
				start, end := int(parseErrs[0].PositionRange.Start), int(parseErrs[0].PositionRange.End)
				result.Start, result.End = &start, &end
			}
		}
		results = append(results, result)
	}
	return results, nil
}
