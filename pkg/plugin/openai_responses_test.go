package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestBuildOpenAIResponsesRequestConvertsHistoryToolsAndReasoning(t *testing.T) {
	reasoningSignature := `{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"encrypted"}`
	textSignature := `{"v":1,"id":"msg_1","phase":"final_answer"}`
	assistantContent, err := json.Marshal([]map[string]any{
		{
			"type":              "thinking",
			"thinking":          "checked",
			"thinkingSignature": reasoningSignature,
		},
		{
			"type":          "text",
			"text":          "I will query it.",
			"textSignature": textSignature,
		},
		{
			"type":      "toolCall",
			"id":        "call_1|fc_1",
			"name":      "query_prometheus",
			"arguments": map[string]any{"query": "up"},
		},
	})
	if err != nil {
		t.Fatalf("encode assistant content: %s", err)
	}

	app := App{settings: appSettings{
		SystemPromptAddendum: "Prefer concise answers.",
	}}
	model := modelSettings{
		ID:            "gpt-5.6-luna-grafana",
		ThinkingLevel: thinkingLevelMedium,
	}
	payload := app.buildOpenAIResponsesRequest(proxyStreamRequest{
		Context: proxyContext{
			SystemPrompt: "You help.",
			Messages: []proxyMessage{
				{Role: "user", Content: json.RawMessage(`"Inspect up"`)},
				{Role: "assistant", Content: assistantContent},
				{
					Role:       "toolResult",
					ToolCallID: "call_1|fc_1",
					ToolName:   "query_prometheus",
					Content:    json.RawMessage(`[{"type":"text","text":"up = 1"}]`),
				},
			},
			Tools: []proxyTool{{
				Name:        "query_prometheus",
				Description: "Run PromQL",
				Parameters:  json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"}}}`),
			}},
		},
		Options: proxyOptions{MaxTokens: intPtr(2048), Reasoning: thinkingLevelHigh},
	}, model)

	if payload.Model != "gpt-5.6-luna-grafana" || payload.MaxOutputTokens == nil || *payload.MaxOutputTokens != 2048 {
		t.Fatalf("unexpected Responses request settings: %#v", payload)
	}
	if !strings.Contains(payload.Instructions, "You help.") || !strings.Contains(payload.Instructions, "Prefer concise answers.") {
		t.Fatalf("unexpected instructions: %q", payload.Instructions)
	}
	if payload.Reasoning == nil || payload.Reasoning.Effort != thinkingLevelHigh || payload.Reasoning.Summary != "auto" {
		t.Fatalf("unexpected reasoning settings: %#v", payload.Reasoning)
	}
	if len(payload.Include) != 1 || payload.Include[0] != "reasoning.encrypted_content" {
		t.Fatalf("expected encrypted reasoning include, got %#v", payload.Include)
	}
	if len(payload.Tools) != 1 || payload.Tools[0].Name != "query_prometheus" {
		t.Fatalf("unexpected tools: %#v", payload.Tools)
	}
	if len(payload.Input) != 5 {
		t.Fatalf("expected user, reasoning, text, function call, and function output items, got %d", len(payload.Input))
	}

	var reasoning map[string]any
	if err := json.Unmarshal(payload.Input[1], &reasoning); err != nil {
		t.Fatalf("decode reasoning input: %s", err)
	}
	if reasoning["encrypted_content"] != "encrypted" {
		t.Fatalf("reasoning signature was not replayed: %#v", reasoning)
	}

	var functionCall struct {
		Type      string `json:"type"`
		ID        string `json:"id"`
		CallID    string `json:"call_id"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	}
	if err := json.Unmarshal(payload.Input[3], &functionCall); err != nil {
		t.Fatalf("decode function call input: %s", err)
	}
	if functionCall.Type != "function_call" || functionCall.ID != "fc_1" || functionCall.CallID != "call_1" {
		t.Fatalf("unexpected function call linkage: %#v", functionCall)
	}
	if functionCall.Arguments != `{"query":"up"}` {
		t.Fatalf("function arguments must be a JSON-encoded string, got %q", functionCall.Arguments)
	}

	var functionOutput openAIResponsesFunctionOutputItem
	if err := json.Unmarshal(payload.Input[4], &functionOutput); err != nil {
		t.Fatalf("decode function output input: %s", err)
	}
	if functionOutput.CallID != "call_1" || functionOutput.Output != "up = 1" {
		t.Fatalf("unexpected function output: %#v", functionOutput)
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode payload: %s", err)
	}
	if !strings.Contains(string(encoded), `"store":false`) {
		t.Fatalf("Responses requests must explicitly disable storage: %s", encoded)
	}
}

func TestRelayOpenAIResponsesStreamPreservesContentIndexesAndSignatures(t *testing.T) {
	app := App{}
	recorder := httptest.NewRecorder()
	body := strings.NewReader(strings.Join([]string{
		`data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}`,
		"",
		`data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[]}}`,
		"",
		`data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"check"}`,
		"",
		`data: {"type":"response.output_text.delta","output_index":1,"delta":"answer"}`,
		"",
		`data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"check"}],"encrypted_content":"encrypted"}}`,
		"",
		`data: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"query_prometheus","arguments":""}}`,
		"",
		`data: {"type":"response.function_call_arguments.delta","output_index":2,"delta":"{\"query\":\"up\"}"}`,
		"",
		`data: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"query_prometheus","arguments":"{\"query\":\"up\"}"}}`,
		"",
		`data: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg_1","phase":"final_answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":"answer","annotations":[]}]}}`,
		"",
		`data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":2},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":1},"total_tokens":17}}}`,
		"",
	}, "\n"))

	usage, reason, err := app.relayOpenAIResponsesStream(body, newProxyEventWriter(recorder, nil))
	if err != nil {
		t.Fatalf("relay Responses stream: %s", err)
	}
	if reason != "toolUse" || usage.Input != 10 || usage.CacheRead != 2 || usage.Output != 5 || usage.TotalTokens != 17 {
		t.Fatalf("unexpected completion: reason=%q usage=%#v", reason, usage)
	}

	combined := recorder.Body.String()
	for _, expected := range []string{
		`"type":"thinking_start"`,
		`"contentIndex":0`,
		`"delta":"check"`,
		`"contentSignature":"{\"type\":\"reasoning\"`,
		`"type":"text_start"`,
		`"contentIndex":1`,
		`"delta":"answer"`,
		`"toolName":"query_prometheus"`,
		`"id":"call_1|fc_1"`,
		`"contentIndex":2`,
		`"reason":"toolUse"`,
		`"cacheRead":2`,
	} {
		if !strings.Contains(combined, expected) {
			t.Fatalf("expected stream to contain %s, got %s", expected, combined)
		}
	}
}

func TestLLMStreamAutoFallsBackToResponsesAndRemembersProtocol(t *testing.T) {
	var mu sync.Mutex
	chatRequests := 0
	responsesRequests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch req.URL.Path {
		case "/chat/completions":
			chatRequests++
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"Function tools with reasoning_effort are not supported. Please use /v1/responses instead.","type":"invalid_request_error","param":"reasoning_effort","code":null}}`))
		case "/responses":
			responsesRequests++
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"input_tokens_details\":{\"cached_tokens\":0},\"output_tokens\":1,\"output_tokens_details\":{\"reasoning_tokens\":0},\"total_tokens\":2}}}\n\n"))
		default:
			t.Fatalf("unexpected upstream path: %s", req.URL.Path)
		}
	}))
	defer upstream.Close()

	jsonData, _ := json.Marshal(appSettings{
		OpenAIBaseURL: upstream.URL,
		Models: []modelSettings{{
			ID:             "gpt-5.6-luna-grafana",
			Default:        true,
			Protocol:       openAIProtocolAuto,
			ThinkingLevel:  thinkingLevelMedium,
			ThinkingFormat: thinkingFormatOpenAI,
		}},
	})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData: jsonData,
		DecryptedSecureJSONData: map[string]string{
			"openAIAPIKey": "secret",
		},
	})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	for range 2 {
		var sender mockCallResourceResponseSender
		err = app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: adminPluginContext(),
			Method:        http.MethodPost,
			Path:          "llm/stream",
			Body: []byte(`{
				"context":{
					"messages":[{"role":"user","content":"hello"}],
					"tools":[{"name":"query_prometheus","description":"Run PromQL","parameters":{"type":"object"}}]
				},
				"options":{"reasoning":"medium"}
			}`),
		}, &sender)
		if err != nil {
			t.Fatalf("CallResource error: %s", err)
		}
		if combined := joinBodies(sender.responses); !strings.Contains(combined, `"type":"done"`) {
			t.Fatalf("expected completed proxy stream, got %s", combined)
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if chatRequests != 1 || responsesRequests != 2 {
		t.Fatalf("expected one discovery request and two Responses requests, got chat=%d responses=%d", chatRequests, responsesRequests)
	}
}

func TestShouldRetryWithResponsesIsNarrow(t *testing.T) {
	matching := []byte(`{"error":{"message":"Please use /v1/responses instead.","type":"invalid_request_error","param":"reasoning_effort"}}`)
	if !shouldRetryWithResponses(http.StatusBadRequest, matching) {
		t.Fatal("expected exact reasoning_effort compatibility error to retry")
	}
	for _, test := range []struct {
		status int
		body   string
	}{
		{status: http.StatusUnauthorized, body: string(matching)},
		{status: http.StatusBadRequest, body: `{"error":{"message":"Please use /v1/responses instead.","type":"invalid_request_error","param":"temperature"}}`},
		{status: http.StatusBadRequest, body: `{"error":{"message":"invalid request","type":"invalid_request_error","param":"reasoning_effort"}}`},
		{status: http.StatusBadRequest, body: `not json`},
	} {
		if shouldRetryWithResponses(test.status, []byte(test.body)) {
			t.Fatalf("unexpected retry for status=%d body=%s", test.status, test.body)
		}
	}
}

func TestOpenAIProtocolSelectionRespectsExplicitAndResolvedModes(t *testing.T) {
	tests := []struct {
		name       string
		configured string
		resolved   map[string]string
		expected   string
	}{
		{name: "auto starts with chat completions", configured: openAIProtocolAuto, expected: openAIProtocolChatCompletions},
		{name: "auto remembers responses", configured: openAIProtocolAuto, resolved: map[string]string{"model-a": openAIProtocolResponses}, expected: openAIProtocolResponses},
		{name: "auto ignores responses remembered for another model", configured: openAIProtocolAuto, resolved: map[string]string{"model-b": openAIProtocolResponses}, expected: openAIProtocolChatCompletions},
		{name: "explicit chat ignores remembered responses", configured: openAIProtocolChatCompletions, resolved: map[string]string{"model-a": openAIProtocolResponses}, expected: openAIProtocolChatCompletions},
		{name: "explicit responses", configured: openAIProtocolResponses, expected: openAIProtocolResponses},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := App{resolvedLLMProtocols: test.resolved}
			model := modelSettings{ID: "model-a", Protocol: test.configured}
			if actual := app.openAIProtocolForRequest(model); actual != test.expected {
				t.Fatalf("expected %q, got %q", test.expected, actual)
			}
		})
	}
}

func intPtr(value int) *int {
	return &value
}
