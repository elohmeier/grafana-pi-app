package api

// TelemetryRequest is the body of POST /telemetry/events.
type TelemetryRequest struct {
	Events []TelemetryEvent `json:"events"`
}

// TelemetryEvent is one assistant run event, exported as Prometheus metrics.
type TelemetryEvent struct {
	Type                string           `json:"type"`
	ToolName            string           `json:"toolName,omitempty"`
	Status              string           `json:"status,omitempty"`
	Reason              string           `json:"reason,omitempty"`
	MessageRole         string           `json:"messageRole,omitempty"`
	StopReason          string           `json:"stopReason,omitempty"`
	DurationMs          float64          `json:"durationMs,omitempty"`
	ResultBytes         int              `json:"resultBytes,omitempty"`
	ArgsBytes           int              `json:"argsBytes,omitempty"`
	ContentBytes        int              `json:"contentBytes,omitempty"`
	PromptBytes         int              `json:"promptBytes,omitempty"`
	ContextBytes        int              `json:"contextBytes,omitempty"`
	ContextMessageCount int              `json:"contextMessageCount,omitempty"`
	ToolCount           int              `json:"toolCount,omitempty"`
	MessageCount        int              `json:"messageCount,omitempty"`
	ToolResultCount     int              `json:"toolResultCount,omitempty"`
	Phase               string           `json:"phase,omitempty"`
	Skills              []TelemetrySkill `json:"skills,omitempty"`
	Usage               TelemetryUsage   `json:"usage,omitempty"`
}

type TelemetryUsage struct {
	Input       int `json:"input,omitempty"`
	Output      int `json:"output,omitempty"`
	CacheRead   int `json:"cacheRead,omitempty"`
	CacheWrite  int `json:"cacheWrite,omitempty"`
	TotalTokens int `json:"totalTokens,omitempty"`
}

type TelemetrySkill struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Source     string `json:"source" tstype:"'bundled' | 'custom'"`
	Activation string `json:"activation" tstype:"'explicit' | 'auto'"`
}

// TelemetryResponse is the response of POST /telemetry/events.
type TelemetryResponse struct {
	Accepted int `json:"accepted"`
}
