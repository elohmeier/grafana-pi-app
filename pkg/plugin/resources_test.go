package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/grafana/authlib/authz"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/config"
)

type mockCallResourceResponseSender struct {
	responses []*backend.CallResourceResponse
}

func (s *mockCallResourceResponseSender) Send(response *backend.CallResourceResponse) error {
	s.responses = append(s.responses, response)
	return nil
}

type fakeAuthzClient struct {
	allowed bool
}

func (f fakeAuthzClient) Compile(context.Context, string, string, ...string) (authz.Checker, error) {
	return func(...authz.Resource) bool { return f.allowed }, nil
}

func (f fakeAuthzClient) HasAccess(context.Context, string, string, ...authz.Resource) (bool, error) {
	return f.allowed, nil
}

func (f fakeAuthzClient) LookupResources(context.Context, string, string) ([]authz.Resource, error) {
	return nil, nil
}

func adminPluginContext() backend.PluginContext {
	return backend.PluginContext{
		User: &backend.User{
			Login: "admin",
			Email: "admin@example.com",
			Role:  "Admin",
		},
	}
}

func viewerPluginContext(login, email string) backend.PluginContext {
	return backend.PluginContext{
		User: &backend.User{
			Login: login,
			Email: email,
			Role:  "Viewer",
		},
	}
}

func TestResourceAccessDefaultsToAll(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "jsonnet-libs/list",
		Body:   []byte(`{}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}
}

func TestJsonnetLibEndpointsExposeBundledDashboardHelpers(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	var listSender mockCallResourceResponseSender
	listBody := []byte(`{}`)
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-libs/list",
		Body:          listBody,
	}, &listSender)
	if err != nil {
		t.Fatalf("CallResource list error: %s", err)
	}
	if listSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected list 200, got %d: %s", listSender.responses[0].Status, string(listSender.responses[0].Body))
	}
	var listResponse struct {
		BasePath string   `json:"basePath"`
		Result   []string `json:"result"`
	}
	if err := json.Unmarshal(listSender.responses[0].Body, &listResponse); err != nil {
		t.Fatalf("decode list response: %s", err)
	}
	if listResponse.BasePath != "github.com/g42/pi-dashboard" || !containsString(listResponse.Result, "main.libsonnet") {
		t.Fatalf("helper library not listed: %#v", listResponse)
	}

	readBody, _ := json.Marshal(jsonnetLibReadRequest{Path: "github.com/g42/pi-dashboard/main.libsonnet", Offset: 1, Limit: 20})
	var readSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-libs/read",
		Body:          readBody,
	}, &readSender)
	if err != nil {
		t.Fatalf("CallResource read error: %s", err)
	}
	if readSender.responses[0].Status != http.StatusOK || !strings.Contains(string(readSender.responses[0].Body), "refIds") {
		t.Fatalf("helper library not readable, got %d: %s", readSender.responses[0].Status, string(readSender.responses[0].Body))
	}

	searchBody, _ := json.Marshal(jsonnetLibSearchRequest{Pattern: "statStrip"})
	var searchSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-libs/search",
		Body:          searchBody,
	}, &searchSender)
	if err != nil {
		t.Fatalf("CallResource search error: %s", err)
	}
	if searchSender.responses[0].Status != http.StatusOK || !strings.Contains(string(searchSender.responses[0].Body), "main.libsonnet") {
		t.Fatalf("helper library not searchable, got %d: %s", searchSender.responses[0].Status, string(searchSender.responses[0].Body))
	}
}

func TestResourceAccessAdminsModeDeniesViewer(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AccessMode: accessModeAdmins})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: viewerPluginContext("viewer", "viewer@example.com"),
		Method:        http.MethodPost,
		Path:          "jsonnet-libs/list",
		Body:          []byte(`{}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}
}

func TestResourceAccessAllowsConfiguredUser(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{
		AccessMode:   accessModeUsers,
		AllowedUsers: []string{"viewer@example.com"},
	})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: viewerPluginContext("viewer", "viewer@example.com"),
		Method:        http.MethodPost,
		Path:          "jsonnet-libs/list",
		Body:          []byte(`{}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}
}

func TestResourceAccessAllModeHasNoAppGate(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AccessMode: accessModeAll})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodPost,
		Path:   "jsonnet-libs/list",
		Body:   []byte(`{}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}
}

func TestResourceAccessRBACModeDeniesViewerWithoutForwardedIdentity(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AccessMode: accessModeRBAC})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: viewerPluginContext("viewer", "viewer@example.com"),
		Method:        http.MethodPost,
		Path:          "jsonnet-libs/list",
		Body:          []byte(`{}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}
}

func TestResourceAccessRBACModeAllowsViewerWithPermission(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AccessMode: accessModeRBAC})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	app.authzToken = "service-account-token"
	app.authzClient = fakeAuthzClient{allowed: true}
	ctx := config.WithGrafanaConfig(context.Background(), config.NewGrafanaCfg(map[string]string{
		config.AppURL:          "http://grafana.example",
		config.AppClientSecret: "service-account-token",
	}))

	var sender mockCallResourceResponseSender
	err = app.CallResource(ctx, &backend.CallResourceRequest{
		PluginContext: viewerPluginContext("viewer", "viewer@example.com"),
		Method:        http.MethodPost,
		Path:          "jsonnet-libs/list",
		Headers:       map[string][]string{grafanaIDHeader: []string{"id-token"}},
		Body:          []byte(`{}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}
}

func TestLLMStreamRequiresConfiguredAPIKey(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "llm/stream",
		Body:          []byte(`{"model":{"id":"gpt-test"},"context":{"messages":[]}}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", sender.responses[0].Status)
	}
}

func TestLLMStreamRelaysOpenAICompatibleChunks(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/chat/completions" {
			t.Fatalf("unexpected path: %s", req.URL.Path)
		}
		if req.Header.Get("Authorization") != "Bearer secret" {
			t.Fatalf("missing authorization header")
		}

		var payload openAIChatRequest
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
			t.Fatalf("decode payload: %s", err)
		}
		if payload.Model != "gpt-user-selected" {
			t.Fatalf("expected requested configured model gpt-user-selected, got %s", payload.Model)
		}

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"finish_reason\":\"stop\",\"delta\":{}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4,\"total_tokens\":7}}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer upstream.Close()

	jsonData, _ := json.Marshal(appSettings{OpenAIBaseURL: upstream.URL, Models: []modelSettings{
		{ID: "gpt-default", Default: true},
		{ID: "gpt-user-selected"},
	}})
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

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "llm/stream",
		Body: []byte(`{
			"model":{"id":"gpt-user-selected"},
			"context":{
				"systemPrompt":"You help.",
				"messages":[{"role":"user","content":"Say hello"}]
			},
			"options":{}
		}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	combined := joinBodies(sender.responses)
	for _, expected := range []string{`"type":"start"`, `"type":"text_start"`, `"delta":"hello"`, `"type":"done"`, `"totalTokens":7`} {
		if !strings.Contains(combined, expected) {
			t.Fatalf("expected stream to contain %s, got %s", expected, combined)
		}
	}
}

func TestLLMStreamUsesDefaultModelWhenRequestOmitsModel(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var payload openAIChatRequest
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
			t.Fatalf("decode payload: %s", err)
		}
		if payload.Model != "gpt-default" {
			t.Fatalf("expected default model gpt-default, got %s", payload.Model)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"finish_reason\":\"stop\",\"delta\":{\"content\":\"hi\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer upstream.Close()

	jsonData, _ := json.Marshal(appSettings{OpenAIBaseURL: upstream.URL, Models: []modelSettings{
		{ID: "gpt-other"},
		{ID: "gpt-default", Default: true},
	}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData:                jsonData,
		DecryptedSecureJSONData: map[string]string{"openAIAPIKey": "secret"},
	})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "llm/stream",
		Body:          []byte(`{"context":{"messages":[{"role":"user","content":"hello"}]},"options":{}}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if combined := joinBodies(sender.responses); !strings.Contains(combined, `"type":"done"`) {
		t.Fatalf("expected completed proxy stream, got %s", combined)
	}
}

func TestLLMStreamRejectsUnknownModel(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		t.Fatalf("upstream must not be contacted for unknown models, got %s", req.URL.Path)
	}))
	defer upstream.Close()

	jsonData, _ := json.Marshal(appSettings{OpenAIBaseURL: upstream.URL, Models: []modelSettings{
		{ID: "gpt-default", Default: true},
	}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData:                jsonData,
		DecryptedSecureJSONData: map[string]string{"openAIAPIKey": "secret"},
	})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "llm/stream",
		Body:          []byte(`{"model":{"id":"gpt-unknown"},"context":{"messages":[]}}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 || sender.responses[0].Status != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown model, got %#v", sender.responses)
	}
	if !strings.Contains(string(sender.responses[0].Body), "gpt-unknown") {
		t.Fatalf("expected error to name the rejected model, got %s", string(sender.responses[0].Body))
	}
}

func TestOpenAIRequestAppendsConfiguredSystemPromptAddendum(t *testing.T) {
	app := App{settings: appSettings{SystemPromptAddendum: "Prefer concise incident summaries."}}

	payload := app.buildOpenAIChatRequest(proxyStreamRequest{
		Context: proxyContext{
			SystemPrompt: "You help.",
			Messages: []proxyMessage{
				{Role: "user", Content: json.RawMessage(`"Summarize this incident"`)},
			},
		},
	}, modelSettings{ID: "gpt-default"})

	if len(payload.Messages) != 2 {
		t.Fatalf("expected system and user messages, got %d", len(payload.Messages))
	}
	if payload.Messages[0].Role != "system" {
		t.Fatalf("expected first message to be system, got %q", payload.Messages[0].Role)
	}
	for _, expected := range []string{"You help.", "## Instance instructions", "Prefer concise incident summaries."} {
		if !strings.Contains(payload.Messages[0].Content, expected) {
			t.Fatalf("expected system prompt to contain %q, got %q", expected, payload.Messages[0].Content)
		}
	}
}

func TestOpenAIRequestOmitsThinkingFieldsByDefault(t *testing.T) {
	app := App{}

	payload := app.buildOpenAIChatRequest(proxyStreamRequest{
		Context: proxyContext{
			Messages: []proxyMessage{
				{Role: "user", Content: json.RawMessage(`"Hello"`)},
			},
		},
		Options: proxyOptions{Reasoning: thinkingLevelHigh},
	}, modelSettings{ID: "gpt-default"})

	if payload.ReasoningEffort != "" {
		t.Fatalf("default payload should not include reasoning_effort, got %q", payload.ReasoningEffort)
	}
	if payload.EnableThinking != nil {
		t.Fatalf("default payload should not include enable_thinking")
	}
	if payload.ChatTemplateKwargs != nil {
		t.Fatalf("default payload should not include chat_template_kwargs")
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %s", err)
	}
	for _, unexpected := range []string{"reasoning_effort", "enable_thinking", "chat_template_kwargs"} {
		if bytes.Contains(encoded, []byte(unexpected)) {
			t.Fatalf("default payload should not contain %q: %s", unexpected, encoded)
		}
	}
}

func TestOpenAIRequestAppliesConfiguredThinkingFormat(t *testing.T) {
	tests := []struct {
		name   string
		format string
		assert func(t *testing.T, payload openAIChatRequest)
	}{
		{
			name:   "openai",
			format: thinkingFormatOpenAI,
			assert: func(t *testing.T, payload openAIChatRequest) {
				t.Helper()
				if payload.ReasoningEffort != thinkingLevelMedium {
					t.Fatalf("expected reasoning_effort medium, got %q", payload.ReasoningEffort)
				}
				if payload.EnableThinking != nil || payload.ChatTemplateKwargs != nil {
					t.Fatalf("openai format should not include qwen thinking fields: %#v", payload)
				}
			},
		},
		{
			name:   "qwen",
			format: thinkingFormatQwen,
			assert: func(t *testing.T, payload openAIChatRequest) {
				t.Helper()
				if payload.EnableThinking == nil || !*payload.EnableThinking {
					t.Fatalf("expected enable_thinking true, got %#v", payload.EnableThinking)
				}
				if payload.ReasoningEffort != "" || payload.ChatTemplateKwargs != nil {
					t.Fatalf("qwen format should only include enable_thinking: %#v", payload)
				}
			},
		},
		{
			name:   "qwen chat template",
			format: thinkingFormatQwenChatTemplate,
			assert: func(t *testing.T, payload openAIChatRequest) {
				t.Helper()
				if payload.ChatTemplateKwargs == nil || !payload.ChatTemplateKwargs.EnableThinking {
					t.Fatalf("expected chat_template_kwargs.enable_thinking true, got %#v", payload.ChatTemplateKwargs)
				}
				if payload.ReasoningEffort != "" || payload.EnableThinking != nil {
					t.Fatalf("qwen chat template format should only include chat_template_kwargs: %#v", payload)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			app := App{}

			payload := app.buildOpenAIChatRequest(proxyStreamRequest{
				Context: proxyContext{
					Messages: []proxyMessage{
						{Role: "user", Content: json.RawMessage(`"Hello"`)},
					},
				},
			}, modelSettings{ID: "gpt-default", ThinkingLevel: thinkingLevelMedium, ThinkingFormat: tt.format})

			tt.assert(t, payload)
		})
	}
}

func TestLLMStreamParsesMultilineSSEAndBufferedToolArguments(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[\n"))
		_, _ = w.Write([]byte("data: {\"delta\":{\"content\":\"hello\"}}]}\n\n"))
		_, _ = w.Write([]byte(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"arguments":"{\"query\":"}}]}}]}` + "\n\n"))
		_, _ = w.Write([]byte(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"grafana_query"}}]}}]}` + "\n\n"))
		_, _ = w.Write([]byte(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"up\"}"}}]},"finish_reason":"tool_calls"}]}` + "\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer upstream.Close()

	jsonData, _ := json.Marshal(appSettings{OpenAIBaseURL: upstream.URL, Models: []modelSettings{{ID: "gpt-default", Default: true}}})
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

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "llm/stream",
		Body: []byte(`{
			"context":{
				"messages":[{"role":"user","content":"Query up"}],
				"tools":[{"name":"grafana_query","description":"Query","parameters":{"type":"object"}}]
			},
			"options":{}
		}`),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	combined := joinBodies(sender.responses)
	for _, expected := range []string{`"delta":"hello"`, `"type":"toolcall_start"`, `"toolName":"grafana_query"`, `"type":"toolcall_end"`, `"reason":"toolUse"`} {
		if !strings.Contains(combined, expected) {
			t.Fatalf("expected stream to contain %s, got %s", expected, combined)
		}
	}

	startIndex := strings.Index(combined, `"type":"toolcall_start"`)
	bufferedArgIndex := strings.Index(combined, `"delta":"{\"query\":"`)
	laterArgIndex := strings.Index(combined, `"delta":"\"up\"}"`)
	if startIndex < 0 || bufferedArgIndex < startIndex || laterArgIndex < bufferedArgIndex {
		t.Fatalf("expected buffered tool arguments to be replayed after start and before later args, got %s", combined)
	}
}

func TestLLMStreamRelaysReasoningDeltas(t *testing.T) {
	app := App{}
	recorder := httptest.NewRecorder()
	body := strings.NewReader(
		"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"check\"}}]}\n\n" +
			"data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\n" +
			"data: {\"choices\":[{\"finish_reason\":\"stop\",\"delta\":{}}]}\n\n" +
			"data: [DONE]\n\n",
	)

	if _, _, err := app.relayOpenAIChatStream(body, newProxyEventWriter(recorder, nil)); err != nil {
		t.Fatalf("relay stream: %s", err)
	}

	combined := recorder.Body.String()
	for _, expected := range []string{
		`"type":"thinking_start"`,
		`"delta":"check"`,
		`"type":"thinking_end"`,
		`"type":"text_start"`,
		`"delta":"answer"`,
		`"type":"done"`,
	} {
		if !strings.Contains(combined, expected) {
			t.Fatalf("expected stream to contain %s, got %s", expected, combined)
		}
	}
}

func TestTelemetryEndpointAcceptsAggregateEvents(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	body := []byte(`{
		"events": [
			{
				"type": "prompt_start",
				"promptBytes": 42,
				"contextBytes": 2048,
				"contextMessageCount": 3,
				"toolCount": 12,
				"skills": [
					{
						"id": "plugin-config/customSkills/team-runbook",
						"name": "team-runbook",
						"source": "custom",
						"activation": "explicit"
					}
				]
			},
			{
				"type": "tool_execution_end",
				"toolName": "run_query_agent",
				"status": "completed",
				"durationMs": 1234,
				"argsBytes": 51,
				"resultBytes": 4096,
				"nestedToolCallCount": 2,
				"nestedToolCalls": [
					{"name": "list_metrics", "status": "completed"},
					{"name": "query_prometheus", "status": "completed"}
				]
			},
			{
				"type": "qol_timing",
				"phase": "first_assistant_content",
				"durationMs": 850
			}
		]
	}`)

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "telemetry/events",
		Body:          body,
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource telemetry error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}
	if !strings.Contains(string(sender.responses[0].Body), `"accepted":3`) {
		t.Fatalf("unexpected response: %s", string(sender.responses[0].Body))
	}
}

func TestOpenAIRequestKeepsUserAndToolContentNonEmpty(t *testing.T) {
	app := App{}

	payload := app.buildOpenAIChatRequest(proxyStreamRequest{
		Context: proxyContext{
			Messages: []proxyMessage{
				{Role: "user", Content: json.RawMessage(`""`)},
				{
					Role:       "toolResult",
					ToolCallID: "call_1",
					ToolName:   "list_label_values",
					Content:    json.RawMessage(`[{"type":"text","text":""}]`),
				},
			},
		},
	}, modelSettings{ID: "gpt-default"})

	if len(payload.Messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(payload.Messages))
	}
	if payload.Messages[0].Content == "" {
		t.Fatalf("user content should not be empty")
	}
	if payload.Messages[1].Content != "(empty tool result)" {
		t.Fatalf("unexpected tool fallback content: %q", payload.Messages[1].Content)
	}
	encodedPayload, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %s", err)
	}
	if bytes.Contains(encodedPayload, []byte(`"metadata"`)) {
		t.Fatalf("chat completions payload should not include metadata without store enabled: %s", encodedPayload)
	}
}

func TestOpenAIRequestSerializesEmptyAssistantContentAsString(t *testing.T) {
	app := App{}

	payload := app.buildOpenAIChatRequest(proxyStreamRequest{
		Context: proxyContext{
			Messages: []proxyMessage{
				{Role: "user", Content: json.RawMessage(`"first request"`)},
				{Role: "assistant", Content: json.RawMessage(`null`)},
				{Role: "user", Content: json.RawMessage(`"follow-up after stop"`)},
			},
		},
	}, modelSettings{ID: "gpt-default"})

	encodedPayload, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %s", err)
	}

	var encoded struct {
		Messages []map[string]interface{} `json:"messages"`
	}
	if err := json.Unmarshal(encodedPayload, &encoded); err != nil {
		t.Fatalf("decode encoded payload: %s", err)
	}
	if len(encoded.Messages) != 3 {
		t.Fatalf("expected 3 messages, got %d: %s", len(encoded.Messages), encodedPayload)
	}
	content, ok := encoded.Messages[1]["content"]
	if !ok {
		t.Fatalf("assistant message must include content as an empty string, got %s", encodedPayload)
	}
	if content != "" {
		t.Fatalf("assistant content should be an empty string, got %#v in %s", content, encodedPayload)
	}
}

func TestOpenAIRequestPrefixesFailedToolResults(t *testing.T) {
	app := App{}

	payload := app.buildOpenAIChatRequest(proxyStreamRequest{
		Context: proxyContext{
			Messages: []proxyMessage{
				{
					Role:       "toolResult",
					ToolCallID: "call_1",
					ToolName:   "save_dashboard",
					Content: json.RawMessage(
						`[{"type":"text","text":"Grafana request failed (502 Bad Gateway): PluginAppClientSecret not set in config"}]`,
					),
					IsError: true,
				},
			},
		},
	}, modelSettings{ID: "gpt-default"})

	if len(payload.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(payload.Messages))
	}
	expected := "TOOL ERROR [save_dashboard]: Grafana request failed (502 Bad Gateway): PluginAppClientSecret not set in config"
	if payload.Messages[0].Content != expected {
		t.Fatalf("unexpected failed tool content:\nwant: %q\n got: %q", expected, payload.Messages[0].Content)
	}
}

func TestJsonnetDashboardRenderUsesVendoredJsonnetAndEditableModel(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedPrometheusDatasourceUIDs: []string{"prom-main"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := `local g = import 'github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet';
local target =
  g.query.prometheus.new('prom-main', 'sum(rate(http_requests_total{job="api"}[$__rate_interval]))')
  + g.query.prometheus.withRefId('A')
  + g.query.prometheus.withRange(true)
  + g.query.prometheus.withEditorMode('code');

g.dashboard.new('API Service RED')
+ g.dashboard.withUid('source-api')
+ g.dashboard.withTags(['service'])
+ g.dashboard.withPanels([
  g.panel.timeSeries.new('Request rate')
  + g.panel.timeSeries.panelOptions.withGridPos(h=8, w=12, x=0, y=0)
  + g.panel.timeSeries.queryOptions.withDatasource('prometheus', 'prom-main')
  + g.panel.timeSeries.queryOptions.withTargets([target])
  + g.panel.timeSeries.standardOptions.withUnit('reqps'),
])`
	body, _ := json.Marshal(jsonnetDashboardRequest{
		DashboardJsonnet: source,
		UID:              "direct-jsonnet-api",
		FolderUID:        "observability",
	})

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/render",
		Body:          body,
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}

	var response jsonnetDashboardRenderResponse
	if err := json.Unmarshal(sender.responses[0].Body, &response); err != nil {
		t.Fatalf("decode response: %s", err)
	}
	if response.Dashboard["title"] != "API Service RED" {
		t.Fatalf("unexpected title: %v", response.Dashboard["title"])
	}
	if response.Dashboard["uid"] != "direct-jsonnet-api" {
		t.Fatalf("unexpected dashboard uid: %s", response.Dashboard["uid"])
	}
	if response.Dashboard["editable"] != true {
		t.Fatalf("Jsonnet-created dashboards should render as editable: %#v", response.Dashboard["editable"])
	}
	if !containsTag(response.Dashboard["tags"], "service") || !containsTag(response.Dashboard["tags"], "genai") {
		t.Fatalf("expected source and genai tags, got %#v", response.Dashboard["tags"])
	}
	if !strings.HasPrefix(response.SourceChecksum, "sha256:") {
		t.Fatalf("missing source checksum: %s", response.SourceChecksum)
	}

	panels, ok := response.Dashboard["panels"].([]any)
	if !ok || len(panels) != 1 {
		t.Fatalf("expected one rendered panel, got %#v", response.Dashboard["panels"])
	}
	firstPanel := panels[0].(map[string]any)
	target := firstPanel["targets"].([]any)[0].(map[string]any)
	datasource := target["datasource"].(map[string]any)
	if datasource["uid"] != "prom-main" {
		t.Fatalf("expected target datasource prom-main, got %#v", datasource)
	}
	expr := target["expr"].(string)
	if !strings.Contains(expr, `http_requests_total{job="api"}`) {
		t.Fatalf("unexpected expression: %s", expr)
	}
}

func TestJsonnetDashboardRenderStoresModelAuthoredDashboard(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedPrometheusDatasourceUIDs: []string{"prom-main"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := `{
  title: 'Custom Prometheus Review',
  uid: 'custom-prometheus-review',
  tags: ['incident'],
  panels: [
    {
      id: 1,
      type: 'text',
      title: 'Review summary',
      gridPos: { x: 0, y: 0, w: 24, h: 5 },
      options: { mode: 'markdown', content: 'CPU saturation on vm-web-01 impacted /render/report.' },
    },
    {
      id: 2,
      type: 'timeseries',
      title: 'HTTP error ratio',
      gridPos: { x: 0, y: 5, w: 12, h: 8 },
      datasource: { type: 'prometheus', uid: 'prom-main' },
      targets: [
        {
          refId: 'A',
          datasource: { type: 'prometheus', uid: 'prom-main' },
          expr: 'sum by (vm, route) (rate(http_requests_total{job="web",status=~"5.."}[$__rate_interval])) / clamp_min(sum by (vm, route) (rate(http_requests_total{job="web"}[$__rate_interval])), 1e-9)',
        },
      ],
      fieldConfig: { defaults: { unit: 'percentunit', decimals: 3 }, overrides: [] },
      options: {},
    },
  ],
}`
	body, _ := json.Marshal(jsonnetDashboardRequest{
		DashboardJsonnet: source,
		Tags:             []string{"reviewable"},
	})

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/render",
		Body:          body,
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}

	var response jsonnetDashboardRenderResponse
	if err := json.Unmarshal(sender.responses[0].Body, &response); err != nil {
		t.Fatalf("decode response: %s", err)
	}
	if response.Dashboard["title"] != "Custom Prometheus Review" {
		t.Fatalf("unexpected title: %v", response.Dashboard["title"])
	}
	if response.Dashboard["editable"] != true {
		t.Fatalf("Jsonnet-created dashboards should render as editable: %#v", response.Dashboard["editable"])
	}
	if !containsTag(response.Dashboard["tags"], "incident") || !containsTag(response.Dashboard["tags"], "reviewable") || !containsTag(response.Dashboard["tags"], "genai") {
		t.Fatalf("missing expected tags: %#v", response.Dashboard["tags"])
	}

	panels, ok := response.Dashboard["panels"].([]any)
	if !ok || len(panels) != 2 {
		t.Fatalf("expected two rendered panels, got %#v", response.Dashboard["panels"])
	}
	summaryPanel := panels[0].(map[string]any)
	options := summaryPanel["options"].(map[string]any)
	content := options["content"].(string)
	if !strings.Contains(content, "vm-web-01") || !strings.Contains(content, "/render/report") {
		t.Fatalf("text panel does not include expected review context: %s", content)
	}
	errorPanel := panels[1].(map[string]any)
	errorTarget := errorPanel["targets"].([]any)[0].(map[string]any)
	errorExpr := errorTarget["expr"].(string)
	if !strings.Contains(errorExpr, "clamp_min") || !strings.Contains(errorExpr, "sum by (vm, route)") {
		t.Fatalf("unexpected error ratio expression: %s", errorExpr)
	}
}

func TestJsonnetDashboardRenderUsesBundledDashboardHelpers(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedPrometheusDatasourceUIDs: []string{"prom-main"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := `local d = import 'github.com/g42/pi-dashboard/main.libsonnet';

d.dashboard.new(
  title='Helper Service Overview',
  uid='helper-service-overview',
  tags=['service'],
  rows=[
    d.row('Overview', [
      d.layout.twoUp([
        d.panel.timeseries(
          title='Request rate',
          datasourceUid='prom-main',
          targets=[d.prom.query('sum(rate(http_requests_total[$__rate_interval]))', 'prom-main', legend='requests')],
          unit='reqps',
        ),
        d.panel.stat(
          title='Error ratio',
          datasourceUid='prom-main',
          targets=[d.prom.query('sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))', 'prom-main')],
          unit='percentunit',
        ),
      ]),
      d.layout.statStrip([
        d.panel.stat(
          title='Instances',
          datasourceUid='prom-main',
          targets=[d.prom.query('count(up)', 'prom-main', instant=true)],
        ),
        d.panel.stat(
          title='Down',
          datasourceUid='prom-main',
          targets=[d.prom.query('count(up == 0)', 'prom-main', instant=true)],
        ),
      ]),
    ]),
    d.row('Inventory', [
      d.layout.full(
        d.panel.table(
          title='Targets',
          datasourceUid='prom-main',
          targets=[d.prom.query('up', 'prom-main', instant=true, format='table')],
          columns=['job', 'instance', 'Value'],
          rename={ Value: 'Up' },
        ),
        h=10,
      ),
    ]),
  ],
)`
	body, _ := json.Marshal(jsonnetDashboardRequest{DashboardJsonnet: source})

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/render",
		Body:          body,
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if sender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}

	var response jsonnetDashboardRenderResponse
	if err := json.Unmarshal(sender.responses[0].Body, &response); err != nil {
		t.Fatalf("decode response: %s", err)
	}
	panels := response.Dashboard["panels"].([]any)
	if len(panels) != 7 {
		t.Fatalf("expected two row panels and five content panels, got %#v", panels)
	}
	firstRow := panels[0].(map[string]any)
	if firstRow["type"] != "row" || firstRow["title"] != "Overview" {
		t.Fatalf("unexpected first row panel: %#v", firstRow)
	}
	firstMetric := panels[1].(map[string]any)
	secondMetric := panels[2].(map[string]any)
	firstGrid := firstMetric["gridPos"].(map[string]any)
	secondGrid := secondMetric["gridPos"].(map[string]any)
	if firstGrid["x"] != float64(0) || firstGrid["w"] != float64(12) || firstGrid["y"] != float64(1) {
		t.Fatalf("unexpected first metric grid: %#v", firstGrid)
	}
	if secondGrid["x"] != float64(12) || secondGrid["w"] != float64(12) || secondGrid["y"] != float64(1) {
		t.Fatalf("unexpected second metric grid: %#v", secondGrid)
	}
	firstTarget := firstMetric["targets"].([]any)[0].(map[string]any)
	if firstTarget["refId"] != "A" || firstTarget["legendFormat"] != "requests" {
		t.Fatalf("helper did not assign target fields: %#v", firstTarget)
	}
	tablePanel := panels[6].(map[string]any)
	if tablePanel["type"] != "table" {
		t.Fatalf("expected final table panel, got %#v", tablePanel)
	}
	transformations := tablePanel["transformations"].([]any)
	if len(transformations) != 3 || transformations[0].(map[string]any)["id"] != "labelsToFields" || transformations[1].(map[string]any)["id"] != "filterFieldsByName" || transformations[2].(map[string]any)["id"] != "organize" {
		t.Fatalf("unexpected table transformations: %#v", transformations)
	}
	if response.Validation != nil && len(response.Validation.Warnings) > 0 {
		t.Fatalf("helper dashboard should render without validation warnings, got %#v", response.Validation)
	}
}

func TestJsonnetDashboardRenderReturnsLayoutAndTableValidationWarnings(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedPrometheusDatasourceUIDs: []string{"prom-main"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := `{
  title: 'Needs Layout Repair',
  uid: 'needs-layout-repair',
  panels: [
    {
      id: 1,
      title: 'Left',
      type: 'timeseries',
      gridPos: { x: 0, y: 0, w: 18, h: 8 },
      datasource: { type: 'prometheus', uid: 'prom-main' },
      targets: [{ refId: 'A', datasource: { type: 'prometheus', uid: 'prom-main' }, expr: 'up' }],
    },
    {
      id: 2,
      title: 'Overlaps and overflows',
      type: 'timeseries',
      gridPos: { x: 12, y: 0, w: 18, h: 8 },
      datasource: { type: 'prometheus', uid: 'prom-main' },
      targets: [{ refId: 'A', datasource: { type: 'prometheus', uid: 'prom-main' }, expr: 'up' }],
    },
    {
      id: 3,
      title: 'Uncontrolled table',
      type: 'table',
      datasource: { type: 'prometheus', uid: 'prom-main' },
      targets: [{ refId: 'A', datasource: { type: 'prometheus', uid: 'prom-main' }, expr: 'up', instant: true, format: 'table' }],
    },
  ],
}`
	body, _ := json.Marshal(jsonnetDashboardRequest{DashboardJsonnet: source})

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/render",
		Body:          body,
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if sender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}

	var response jsonnetDashboardRenderResponse
	if err := json.Unmarshal(sender.responses[0].Body, &response); err != nil {
		t.Fatalf("decode response: %s", err)
	}
	if response.Validation == nil || len(response.Validation.Warnings) == 0 || len(response.Validation.LayoutFixes) == 0 {
		t.Fatalf("expected validation warnings and layout fixes, got %#v", response.Validation)
	}
	if !validationHasWarning(response.Validation, "layout_overflow") || !validationHasWarning(response.Validation, "layout_collision") || !validationHasWarning(response.Validation, "table_columns_uncontrolled") {
		t.Fatalf("missing expected validation warning codes: %#v", response.Validation.Warnings)
	}
	panels := response.Dashboard["panels"].([]any)
	secondGrid := panels[1].(map[string]any)["gridPos"].(map[string]any)
	thirdGrid := panels[2].(map[string]any)["gridPos"].(map[string]any)
	if secondGrid["x"] != float64(0) || secondGrid["y"] == float64(0) {
		t.Fatalf("overlapping panel should have been moved below the first row, got %#v", secondGrid)
	}
	if thirdGrid["x"] == nil || thirdGrid["y"] == nil || thirdGrid["w"] == nil || thirdGrid["h"] == nil {
		t.Fatalf("panel without gridPos should receive a grid position, got %#v", thirdGrid)
	}
}

func TestVirtualJsonnetFileWriteEditRead(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := "{\n  title: 'Virtual Dashboard',\n  uid: 'virtual-dashboard',\n  panels: [],\n}\n"
	writeBody, _ := json.Marshal(jsonnetFileWriteRequest{
		SessionID: "session-a",
		Path:      "dashboard.jsonnet",
		Content:   source,
	})

	var writeSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/jsonnet-files/write",
		Body:          writeBody,
	}, &writeSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if writeSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", writeSender.responses[0].Status, string(writeSender.responses[0].Body))
	}
	var writeResponse jsonnetFileResponse
	if err := json.Unmarshal(writeSender.responses[0].Body, &writeResponse); err != nil {
		t.Fatalf("decode write response: %s", err)
	}
	if writeResponse.Version != 1 || writeResponse.LineCount != 5 || writeResponse.DashboardJsonnet != source {
		t.Fatalf("unexpected write response: %#v", writeResponse)
	}

	expectedTitle := "  title: 'Virtual Dashboard',"
	editBody, _ := json.Marshal(jsonnetFileEditRequest{
		SessionID:   "session-a",
		Path:        "dashboard.jsonnet",
		BaseVersion: &writeResponse.Version,
		Edits: []jsonnetLineEdit{
			{StartLine: 2, EndLine: 2, ExpectedText: &expectedTitle, Replacement: "  title: 'Edited Virtual Dashboard',"},
			{StartLine: 4, EndLine: 3, Replacement: "  tags: ['edited'],"},
		},
	})

	var editSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/jsonnet-files/edit",
		Body:          editBody,
	}, &editSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if editSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", editSender.responses[0].Status, string(editSender.responses[0].Body))
	}
	var editResponse jsonnetFileResponse
	if err := json.Unmarshal(editSender.responses[0].Body, &editResponse); err != nil {
		t.Fatalf("decode edit response: %s", err)
	}
	if editResponse.Version != 2 || !strings.Contains(editResponse.DashboardJsonnet, "Edited Virtual Dashboard") || !strings.Contains(editResponse.Diff, "+  tags: ['edited'],") {
		t.Fatalf("unexpected edit response: %#v", editResponse)
	}

	readBody, _ := json.Marshal(jsonnetFileReadRequest{SessionID: "session-a", Path: "dashboard.jsonnet", Offset: 2, Limit: 3})
	var readSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/jsonnet-files/read",
		Body:          readBody,
	}, &readSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	var readResponse jsonnetFileResponse
	if err := json.Unmarshal(readSender.responses[0].Body, &readResponse); err != nil {
		t.Fatalf("decode read response: %s", err)
	}
	if len(readResponse.Lines) != 3 || readResponse.Lines[0].Line != 2 || readResponse.Lines[0].Text != "  title: 'Edited Virtual Dashboard'," {
		t.Fatalf("unexpected read response: %#v", readResponse)
	}
	if readResponse.DashboardJsonnet != "" {
		t.Fatalf("read response should not include full source")
	}
}

func TestJsonnetDashboardRenderSupportsBundledHelperCompatibilityAliases(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedPrometheusDatasourceUIDs: []string{"prometheus"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := `local d = import 'github.com/g42/pi-dashboard/main.libsonnet';

d.dashboard.new('Alias Dashboard')
+ d.dashboard.with_template([
  d.templating.list.new(
    name='job',
    datasourceUid='prometheus',
    query='label_values(up, job)',
    label='Job',
    includeAll=true,
    multi=true,
    current='All',
  ),
])`
	body, _ := json.Marshal(jsonnetDashboardRequest{DashboardJsonnet: source})

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/render",
		Body:          body,
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if sender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected render success, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}

	var response jsonnetDashboardRenderResponse
	if err := json.Unmarshal(sender.responses[0].Body, &response); err != nil {
		t.Fatalf("decode response: %s", err)
	}
	if response.Dashboard["uid"] != "alias-dashboard" {
		t.Fatalf("expected generated slug uid, got %#v", response.Dashboard["uid"])
	}
	templating, ok := response.Dashboard["templating"].(map[string]any)
	if !ok {
		t.Fatalf("expected templating object, got %#v", response.Dashboard["templating"])
	}
	list, ok := templating["list"].([]any)
	if !ok || len(list) != 1 {
		t.Fatalf("expected one templating variable, got %#v", templating["list"])
	}
	variable := list[0].(map[string]any)
	if variable["name"] != "job" || variable["query"] != "label_values(up, job)" {
		t.Fatalf("unexpected templating variable: %#v", variable)
	}
}

func TestVirtualJsonnetFileEditRejectsInvalidJsonnet(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := "{\n  title: 'Virtual Dashboard',\n  uid: 'virtual-dashboard',\n  panels: [],\n}\n"
	writeBody, _ := json.Marshal(jsonnetFileWriteRequest{
		SessionID: "session-invalid-edit",
		Content:   source,
	})
	var writeSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/jsonnet-files/write",
		Body:          writeBody,
	}, &writeSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	editBody, _ := json.Marshal(jsonnetFileEditRequest{
		SessionID: "session-invalid-edit",
		Path:      "dashboard.jsonnet",
		Edits: []jsonnetLineEdit{
			{StartLine: 2, EndLine: 2, Replacement: "  title: 'Broken Dashboard'"},
		},
	})
	var editSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/jsonnet-files/edit",
		Body:          editBody,
	}, &editSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if editSender.responses[0].Status != http.StatusBadRequest || !strings.Contains(string(editSender.responses[0].Body), "edited Jsonnet did not compile") {
		t.Fatalf("expected invalid edit rejection, got %d: %s", editSender.responses[0].Status, string(editSender.responses[0].Body))
	}

	readBody, _ := json.Marshal(jsonnetFileReadRequest{SessionID: "session-invalid-edit", Path: "dashboard.jsonnet", Offset: 1, Limit: 5})
	var readSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/jsonnet-files/read",
		Body:          readBody,
	}, &readSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	var readResponse jsonnetFileResponse
	if err := json.Unmarshal(readSender.responses[0].Body, &readResponse); err != nil {
		t.Fatalf("decode read response: %s", err)
	}
	if readResponse.Version != 1 || readResponse.Lines[1].Text != "  title: 'Virtual Dashboard'," {
		t.Fatalf("invalid edit should not have been committed: %#v", readResponse)
	}
}

func TestVirtualJsonnetFileRepairGenericGrafonnetDashboard(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedPrometheusDatasourceUIDs: []string{"prometheus"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
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
	writeBody, _ := json.Marshal(jsonnetFileWriteRequest{
		SessionID: "session-repair",
		Content:   source,
	})
	var writeSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/jsonnet-files/write",
		Body:          writeBody,
	}, &writeSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	repairBody, _ := json.Marshal(jsonnetFileRepairRequest{
		SessionID: "session-repair",
		Path:      "dashboard.jsonnet",
	})
	var repairSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/jsonnet-files/repair",
		Body:          repairBody,
	}, &repairSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if repairSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", repairSender.responses[0].Status, string(repairSender.responses[0].Body))
	}
	var repairResponse jsonnetFileResponse
	if err := json.Unmarshal(repairSender.responses[0].Body, &repairResponse); err != nil {
		t.Fatalf("decode repair response: %s", err)
	}
	if repairResponse.Version != 2 || len(repairResponse.Repairs) == 0 {
		t.Fatalf("unexpected repair response: %#v", repairResponse)
	}
	if strings.Contains(repairResponse.DashboardJsonnet, "g.panel.new") || !strings.Contains(repairResponse.DashboardJsonnet, "fieldConfig") {
		t.Fatalf("repair did not rewrite panel constructors: %s", repairResponse.DashboardJsonnet)
	}

	renderBody, _ := json.Marshal(jsonnetDashboardRequest{
		SessionID: "session-repair",
		Path:      "dashboard.jsonnet",
	})
	var renderSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/render",
		Body:          renderBody,
	}, &renderSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if renderSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected render 200, got %d: %s", renderSender.responses[0].Status, string(renderSender.responses[0].Body))
	}
	var renderResponse jsonnetDashboardRenderResponse
	if err := json.Unmarshal(renderSender.responses[0].Body, &renderResponse); err != nil {
		t.Fatalf("decode render response: %s", err)
	}
	if renderResponse.Dashboard["uid"] != "http-request-rate-errors" || len(renderResponse.Dashboard["panels"].([]any)) != 2 {
		t.Fatalf("unexpected rendered dashboard: %#v", renderResponse.Dashboard)
	}
}

func TestVirtualJsonnetFileRepairDashboardWithPanelsMixinAndLocalPanels(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedPrometheusDatasourceUIDs: []string{"prometheus"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
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
	writeBody, _ := json.Marshal(jsonnetFileWriteRequest{
		SessionID: "session-repair-mixin",
		Content:   source,
	})
	var writeSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/jsonnet-files/write",
		Body:          writeBody,
	}, &writeSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	repairBody, _ := json.Marshal(jsonnetFileRepairRequest{
		SessionID: "session-repair-mixin",
		Path:      "dashboard.jsonnet",
	})
	var repairSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/jsonnet-files/repair",
		Body:          repairBody,
	}, &repairSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if repairSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", repairSender.responses[0].Status, string(repairSender.responses[0].Body))
	}
	var repairResponse jsonnetFileResponse
	if err := json.Unmarshal(repairSender.responses[0].Body, &repairResponse); err != nil {
		t.Fatalf("decode repair response: %s", err)
	}
	if repairResponse.Version != 2 || !strings.Contains(repairResponse.DashboardJsonnet, "Requests by route") || strings.Contains(repairResponse.DashboardJsonnet, "with_panels") {
		t.Fatalf("unexpected repair response: %#v", repairResponse)
	}

	renderBody, _ := json.Marshal(jsonnetDashboardRequest{
		SessionID: "session-repair-mixin",
		Path:      "dashboard.jsonnet",
	})
	var renderSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/render",
		Body:          renderBody,
	}, &renderSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if renderSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected render 200, got %d: %s", renderSender.responses[0].Status, string(renderSender.responses[0].Body))
	}
	var renderResponse jsonnetDashboardRenderResponse
	if err := json.Unmarshal(renderSender.responses[0].Body, &renderResponse); err != nil {
		t.Fatalf("decode render response: %s", err)
	}
	panels := renderResponse.Dashboard["panels"].([]any)
	if renderResponse.Dashboard["uid"] != "http-request-rate-errors" || len(panels) != 1 || panels[0].(map[string]any)["type"] != "timeseries" {
		t.Fatalf("unexpected rendered dashboard: %#v", renderResponse.Dashboard)
	}
}

func TestJsonnetDashboardRenderAutoRepairsVirtualJsonnetFile(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedPrometheusDatasourceUIDs: []string{"prometheus"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
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
	writeBody, _ := json.Marshal(jsonnetFileWriteRequest{
		SessionID: "session-auto-repair",
		Content:   source,
	})
	var writeSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/jsonnet-files/write",
		Body:          writeBody,
	}, &writeSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	renderBody, _ := json.Marshal(jsonnetDashboardRequest{
		SessionID: "session-auto-repair",
		Path:      "dashboard.jsonnet",
	})
	var renderSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/render",
		Body:          renderBody,
	}, &renderSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if renderSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected render 200, got %d: %s", renderSender.responses[0].Status, string(renderSender.responses[0].Body))
	}
	var renderResponse jsonnetDashboardRenderResponse
	if err := json.Unmarshal(renderSender.responses[0].Body, &renderResponse); err != nil {
		t.Fatalf("decode render response: %s", err)
	}
	panels := renderResponse.Dashboard["panels"].([]any)
	if !renderResponse.AutoRepaired || len(renderResponse.Repairs) == 0 || renderResponse.JsonnetFile == nil || renderResponse.JsonnetFile.Version != 2 {
		t.Fatalf("expected auto-repaired virtual file metadata, got %#v", renderResponse)
	}
	if strings.Contains(renderResponse.DashboardJsonnet, "g.panel.new") || !strings.Contains(renderResponse.DashboardJsonnet, "Request rate") {
		t.Fatalf("render did not return repaired source: %s", renderResponse.DashboardJsonnet)
	}
	if renderResponse.Dashboard["uid"] != "http-request-rate-errors" || len(panels) != 1 || panels[0].(map[string]any)["type"] != "timeseries" {
		t.Fatalf("unexpected rendered dashboard: %#v", renderResponse.Dashboard)
	}
}

func TestJsonnetDashboardRenderFromVirtualJsonnetFile(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := "{ title: 'Virtual Render', uid: 'virtual-render', panels: [] }"
	writeBody, _ := json.Marshal(jsonnetFileWriteRequest{
		SessionID: "session-render",
		Content:   source,
	})
	var writeSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/jsonnet-files/write",
		Body:          writeBody,
	}, &writeSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}

	renderBody, _ := json.Marshal(jsonnetDashboardRequest{
		SessionID: "session-render",
		Path:      "dashboard.jsonnet",
	})
	var renderSender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/render",
		Body:          renderBody,
	}, &renderSender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if renderSender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", renderSender.responses[0].Status, string(renderSender.responses[0].Body))
	}

	var response jsonnetDashboardRenderResponse
	if err := json.Unmarshal(renderSender.responses[0].Body, &response); err != nil {
		t.Fatalf("decode response: %s", err)
	}
	if response.JsonnetFile == nil || response.JsonnetFile.Path != "dashboard.jsonnet" {
		t.Fatalf("expected virtual Jsonnet file metadata, got %#v", response.JsonnetFile)
	}
	if response.SourceChecksum != checksumBytes([]byte(source)) {
		t.Fatalf("unexpected source checksum: %s", response.SourceChecksum)
	}
}

func TestJsonnetDashboardRenderRejectsDisallowedDatasource(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedPrometheusDatasourceUIDs: []string{"prom-main"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	source := `{
  title: 'Bad Service RED',
  panels: [
    {
      type: 'timeseries',
      title: 'Bad',
      datasource: { type: 'prometheus', uid: 'prom-other' },
      targets: [{ refId: 'A', datasource: { type: 'prometheus', uid: 'prom-other' }, expr: 'up' }],
    },
  ],
}`
	body, _ := json.Marshal(jsonnetDashboardRequest{DashboardJsonnet: source})

	var sender mockCallResourceResponseSender
	err = app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/render",
		Body:          body,
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", sender.responses[0].Status)
	}
	if !strings.Contains(string(sender.responses[0].Body), "dashboard references datasource UIDs not available to the app: prom-other") {
		t.Fatalf("unexpected response: %s", string(sender.responses[0].Body))
	}
}

func TestJsonnetDashboardDatasourceAllowListRejectsVariables(t *testing.T) {
	jsonData, _ := json.Marshal(appSettings{AllowedPrometheusDatasourceUIDs: []string{"prom-main"}})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)

	disallowed := app.disallowedDatasourceUIDs(map[string]any{
		"panels": []any{
			map[string]any{
				"datasource": map[string]any{"type": "prometheus", "uid": "$datasource"},
			},
		},
	})
	if len(disallowed) != 1 || disallowed[0] != "$datasource" {
		t.Fatalf("expected datasource variable to be disallowed, got %#v", disallowed)
	}
}

func TestJsonnetDashboardSaveWritesEditableDashboard(t *testing.T) {
	var requestedMethod string
	var requestedPath string
	var authHeader string
	var saved map[string]any

	grafana := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		requestedMethod = req.Method
		requestedPath = req.URL.Path
		authHeader = req.Header.Get("Authorization")
		if req.Method != http.MethodPost || req.URL.Path != "/api/dashboards/db" {
			t.Fatalf("unexpected Grafana request: %s %s", req.Method, req.URL.Path)
		}
		if err := json.NewDecoder(req.Body).Decode(&saved); err != nil {
			t.Fatalf("decode saved dashboard: %s", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"uid":    "direct-jsonnet-save",
			"url":    "/d/direct-jsonnet-save/api-service-direct",
			"status": "success",
		})
	}))
	defer grafana.Close()

	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	ctx := config.WithGrafanaConfig(context.Background(), config.NewGrafanaCfg(map[string]string{
		config.AppURL:          grafana.URL,
		config.AppClientSecret: "service-account-token",
	}))
	source := "{ title: 'API Service Direct', uid: 'direct-jsonnet-save', panels: [] }"
	body, _ := json.Marshal(jsonnetDashboardRequest{DashboardJsonnet: source, FolderUID: "observability"})

	var sender mockCallResourceResponseSender
	err = app.CallResource(ctx, &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "jsonnet-dashboards/save",
		Body:          body,
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", sender.responses[0].Status, string(sender.responses[0].Body))
	}
	if requestedMethod != http.MethodPost || requestedPath != "/api/dashboards/db" {
		t.Fatalf("unexpected Grafana request: %s %s", requestedMethod, requestedPath)
	}
	if authHeader != "Bearer service-account-token" {
		t.Fatalf("unexpected auth header: %s", authHeader)
	}
	dashboard, ok := saved["dashboard"].(map[string]any)
	if !ok {
		t.Fatalf("saved payload did not include dashboard: %#v", saved)
	}
	if dashboard["uid"] != "direct-jsonnet-save" || dashboard["editable"] != true {
		t.Fatalf("saved dashboard should be editable with expected UID: %#v", dashboard)
	}
	if metadata, exists := saved["metadata"]; exists {
		t.Fatalf("save payload should not include manager metadata: %#v", metadata)
	}
	if saved["folderUid"] != "observability" || saved["overwrite"] != true {
		t.Fatalf("unexpected save options: %#v", saved)
	}

	var response jsonnetDashboardSaveResponse
	if err := json.Unmarshal(sender.responses[0].Body, &response); err != nil {
		t.Fatalf("decode response: %s", err)
	}
	if response.Status != "success" || response.UID != "direct-jsonnet-save" || response.URL != grafana.URL+"/d/direct-jsonnet-save/api-service-direct" {
		t.Fatalf("unexpected save response: %#v", response)
	}
}

func containsTag(raw any, expected string) bool {
	tags, ok := raw.([]any)
	if !ok {
		return false
	}
	for _, tag := range tags {
		if tag == expected {
			return true
		}
	}
	return false
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func validationHasWarning(report *dashboardValidationReport, code string) bool {
	if report == nil {
		return false
	}
	for _, warning := range report.Warnings {
		if warning.Code == code {
			return true
		}
	}
	return false
}

func joinBodies(responses []*backend.CallResourceResponse) string {
	var buffer bytes.Buffer
	for _, response := range responses {
		buffer.Write(response.Body)
	}
	return buffer.String()
}
