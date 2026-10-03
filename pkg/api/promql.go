package api

// PromQLParseRequest is the body of POST /promql/parse.
type PromQLParseRequest struct {
	Queries []PromQLParseQuery `json:"queries"`
}

type PromQLParseQuery struct {
	ID   string `json:"id"`
	Expr string `json:"expr"`
}

type PromQLParseResult struct {
	ID    string `json:"id"`
	Error string `json:"error,omitempty"`
	// Start and End are byte offsets of the first error in the expression.
	Start *int `json:"start,omitempty"`
	End   *int `json:"end,omitempty"`
}

// PromQLParseResponse is the response of POST /promql/parse.
type PromQLParseResponse struct {
	Results []PromQLParseResult `json:"results"`
}
