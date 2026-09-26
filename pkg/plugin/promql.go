package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/prometheus/prometheus/promql/parser"
)

const (
	promQLParseMaxQueries    = 500
	promQLParseMaxExprBytes  = 64 << 10
	promQLParseMaxInputBytes = 4 << 20
)

type promQLParseRequest struct {
	Queries []promQLParseQuery `json:"queries"`
}

type promQLParseQuery struct {
	ID   string `json:"id"`
	Expr string `json:"expr"`
}

type promQLParseResult struct {
	ID    string `json:"id"`
	Error string `json:"error,omitempty"`
	// Start and End are byte offsets of the first error in the expression.
	Start *int `json:"start,omitempty"`
	End   *int `json:"end,omitempty"`
}

type promQLParseResponse struct {
	Results []promQLParseResult `json:"results"`
}

// handlePromQLParse checks PromQL syntax with the upstream Prometheus parser.
// It accepts experimental syntax so that it never rejects a query a newer
// datasource backend supports; it does not check metric existence.
func (a *App) handlePromQLParse(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body promQLParseRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, promQLParseMaxInputBytes)).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}
	results, err := parsePromQLQueries(body.Queries)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, promQLParseResponse{Results: results})
}

func parsePromQLQueries(queries []promQLParseQuery) ([]promQLParseResult, error) {
	if len(queries) > promQLParseMaxQueries {
		return nil, fmt.Errorf("too many queries (%d > %d)", len(queries), promQLParseMaxQueries)
	}
	p := parser.NewParser(parser.Options{
		EnableExperimentalFunctions:  true,
		ExperimentalDurationExpr:     true,
		EnableExtendedRangeSelectors: true,
		EnableBinopFillModifiers:     true,
	})
	results := make([]promQLParseResult, 0, len(queries))
	for _, query := range queries {
		result := promQLParseResult{ID: query.ID}
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
