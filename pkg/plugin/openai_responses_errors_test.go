package plugin

import (
	"strings"
	"testing"
)

func TestResponsesStreamErrorKeepsCodeAndMessageOfEveryShape(t *testing.T) {
	cases := map[string]struct {
		event string
		want  string
	}{
		"nested error object": {
			event: `{"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model.","param":"input"},"sequence_number":2}`,
			want:  "responses API error context_length_exceeded: Your input exceeds the context window of this model.",
		},
		"top-level fields": {
			event: `{"type":"error","code":"rate_limit_exceeded","message":"slow down"}`,
			want:  "responses API error rate_limit_exceeded: slow down",
		},
		"failed response with code": {
			event: `{"type":"response.failed","response":{"status":"failed","error":{"code":"context_length_exceeded","message":"Your input exceeds the context window of this model."}}}`,
			want:  "responses API error context_length_exceeded: Your input exceeds the context window of this model.",
		},
		"failed response without code": {
			event: `{"type":"response.failed","response":{"status":"failed","error":{"message":"server overloaded"}}}`,
			want:  "responses API error: server overloaded",
		},
		"numeric code": {
			event: `{"type":"error","error":{"code":400,"message":"bad input"}}`,
			want:  "responses API error 400: bad input",
		},
		"code only": {
			event: `{"type":"error","error":{"code":"server_error","message":null}}`,
			want:  "responses API error server_error",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			last := lastEvent(t, relayResponses(t, sseBody(tc.event)))
			if last.str("type") != "error" || last.str("errorMessage") != tc.want {
				t.Fatalf("errorMessage = %q, want %q", last.str("errorMessage"), tc.want)
			}
		})
	}
}

func TestResponsesStreamErrorWithoutDetailsShowsTheEvent(t *testing.T) {
	last := lastEvent(t, relayResponses(t, sseBody(`{"type":"error","error":{"type":"server_error"}}`)))
	if message := last.str("errorMessage"); !strings.Contains(message, `"server_error"`) {
		t.Fatalf("an error without code or message must show the event, got %q", message)
	}
}
