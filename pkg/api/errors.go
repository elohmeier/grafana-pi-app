package api

// ErrorResponse is the body of every failed resource request.
type ErrorResponse struct {
	Error string `json:"error"`
	// Reason distinguishes chat commit conflicts: "lease" or "sequence".
	Reason string `json:"reason,omitempty" tstype:"'lease' | 'sequence'"`
}
