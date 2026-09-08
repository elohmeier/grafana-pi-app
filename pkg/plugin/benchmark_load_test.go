package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestLLMStreamPreservesUpstreamStatusForLoadMeasurements(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"error":"capacity exceeded"}`))
			}))
			defer upstream.Close()
			settings, _ := json.Marshal(appSettings{OpenAIBaseURL: upstream.URL, Models: []modelSettings{{ID: "test", Protocol: "chat-completions", Default: true}}})
			inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: settings, DecryptedSecureJSONData: map[string]string{"openAIAPIKey": "test-key"}})
			if err != nil {
				t.Fatal(err)
			}
			var sender mockCallResourceResponseSender
			err = inst.(*App).CallResource(context.Background(), &backend.CallResourceRequest{
				PluginContext: adminPluginContext(), Method: http.MethodPost, Path: "llm/stream",
				Body: []byte(`{"model":{"id":"test"},"context":{"messages":[{"role":"user","content":"hello"}]}}`),
			}, &sender)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, line := range strings.Split(joinBodies(sender.responses), "\n") {
				if !strings.HasPrefix(line, "data: ") {
					continue
				}
				var event map[string]interface{}
				if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
					t.Fatal(err)
				}
				if event["type"] == "error" {
					found = true
					if event["upstreamStatus"] != float64(status) {
						t.Fatalf("missing status: %v", event)
					}
					if !strings.Contains(event["errorMessage"].(string), "capacity exceeded") {
						t.Fatalf("missing error body: %v", event)
					}
				}
			}
			if !found {
				t.Fatal("missing SSE error event")
			}
		})
	}
}
