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
		Path:   "jsonnet-libs/files",
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

func TestJsonnetLibFilesEndpointListsAndLoadsPackages(t *testing.T) {
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	app := inst.(*App)
	call := func(body string) (int, []byte) {
		var sender mockCallResourceResponseSender
		if err := app.CallResource(context.Background(), &backend.CallResourceRequest{
			PluginContext: adminPluginContext(),
			Method:        http.MethodPost,
			Path:          "jsonnet-libs/files",
			Body:          []byte(body),
		}, &sender); err != nil {
			t.Fatalf("CallResource error: %s", err)
		}
		return sender.responses[0].Status, sender.responses[0].Body
	}
	type response struct {
		Files []jsonnetLibFile `json:"files"`
	}

	status, body := call(`{}`)
	var listing response
	if status != http.StatusOK || json.Unmarshal(body, &listing) != nil {
		t.Fatalf("list failed: %d %s", status, body)
	}
	found := false
	for _, file := range listing.Files {
		if file.Content != nil {
			t.Fatalf("listing must not include contents: %s", file.Path)
		}
		found = found || (file.Path == "github.com/g42/pi-dashboard/main.libsonnet" && file.Size > 0)
	}
	if !found || len(listing.Files) < 100 {
		t.Fatalf("helper library not listed (%d files)", len(listing.Files))
	}

	status, body = call(`{"package":"github.com/g42/pi-dashboard"}`)
	var pkg response
	if status != http.StatusOK || json.Unmarshal(body, &pkg) != nil {
		t.Fatalf("package load failed: %d", status)
	}
	var helper *jsonnetLibFile
	for index := range pkg.Files {
		if !strings.HasPrefix(pkg.Files[index].Path, "github.com/g42/pi-dashboard/") {
			t.Fatalf("file outside the requested package: %s", pkg.Files[index].Path)
		}
		if pkg.Files[index].Path == "github.com/g42/pi-dashboard/main.libsonnet" {
			helper = &pkg.Files[index]
		}
	}
	if helper == nil || helper.Content == nil || !strings.Contains(*helper.Content, "statStrip") {
		t.Fatal("helper library content missing")
	}

	if status, _ := call(`{"package":"../../etc"}`); status != http.StatusBadRequest {
		t.Fatalf("expected unknown package to be rejected, got %d", status)
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
		Path:          "jsonnet-libs/files",
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
		Path:          "jsonnet-libs/files",
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
		Path:   "jsonnet-libs/files",
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
		Path:          "jsonnet-libs/files",
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
		Path:          "jsonnet-libs/files",
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

func TestOpenAIRequestUsesRequestedThinkingLevel(t *testing.T) {
	app := App{}
	model := modelSettings{
		ID:             "gpt-default",
		ThinkingLevel:  thinkingLevelMedium,
		ThinkingFormat: thinkingFormatOpenAI,
	}

	overridden := app.buildOpenAIChatRequest(proxyStreamRequest{
		Context: proxyContext{Messages: []proxyMessage{{Role: "user", Content: json.RawMessage(`"Hello"`)}}},
		Options: proxyOptions{Reasoning: thinkingLevelHigh},
	}, model)
	if overridden.ReasoningEffort != thinkingLevelHigh {
		t.Fatalf("expected requested reasoning_effort high, got %q", overridden.ReasoningEffort)
	}

	disabled := app.buildOpenAIChatRequest(proxyStreamRequest{
		Context: proxyContext{Messages: []proxyMessage{{Role: "user", Content: json.RawMessage(`"Hello"`)}}},
	}, model)
	if disabled.ReasoningEffort != "" {
		t.Fatalf("expected omitted request reasoning to turn thinking off, got %q", disabled.ReasoningEffort)
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
				Options: proxyOptions{Reasoning: thinkingLevelMedium},
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

func joinBodies(responses []*backend.CallResourceResponse) string {
	var buffer bytes.Buffer
	for _, response := range responses {
		buffer.Write(response.Body)
	}
	return buffer.String()
}

func TestDeepSeekThinkingAndAssistantReplay(t *testing.T) {
	app := App{}
	model := modelSettings{ID: "deepseek-v4-flash", ThinkingLevel: thinkingLevelMedium, ThinkingFormat: thinkingFormatDeepSeek}
	for _, level := range []string{thinkingLevelOff, thinkingLevelMedium} {
		payload := app.buildOpenAIChatRequest(proxyStreamRequest{
			Context: proxyContext{Messages: []proxyMessage{
				{Role: "assistant", Content: json.RawMessage(`[{"type":"thinking","thinking":"Need a query."},{"type":"toolCall","id":"call_1","name":"query","arguments":{}}]`)},
				{Role: "toolResult", ToolCallID: "call_1", Content: json.RawMessage(`"ok"`)},
				{Role: "assistant", Content: json.RawMessage(`"Done"`)},
			}},
			Options: proxyOptions{Reasoning: level},
		}, model)
		wantType := "enabled"
		if level == thinkingLevelOff {
			wantType = "disabled"
		}
		if payload.Thinking == nil || payload.Thinking.Type != wantType {
			t.Fatalf("wrong thinking control: %#v", payload.Thinking)
		}
		if level == thinkingLevelMedium && payload.ReasoningEffort != level {
			t.Fatalf("missing reasoning effort: %#v", payload)
		}
		if level == thinkingLevelOff && payload.ReasoningEffort != "" {
			t.Fatal("disabled thinking must omit reasoning effort")
		}
		if payload.Messages[0].ReasoningContent == nil || *payload.Messages[0].ReasoningContent != "Need a query." || len(payload.Messages[0].ToolCalls) != 1 {
			t.Fatalf("lost reasoning or tool call: %#v", payload.Messages[0])
		}
		if payload.Messages[1].ReasoningContent != nil {
			t.Fatal("tool results must not carry assistant reasoning")
		}
		if payload.Messages[2].ReasoningContent == nil || *payload.Messages[2].ReasoningContent != "" {
			t.Fatal("assistant replay needs an explicit empty reasoning_content")
		}
	}
}
