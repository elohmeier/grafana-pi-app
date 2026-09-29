package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// Parity tests for the Chat Completions and Responses translation: the same
// model output must reach Pi as the same proxy events, whichever protocol the
// upstream speaks.

type proxyEvent map[string]any

func (e proxyEvent) str(key string) string {
	value, _ := e[key].(string)
	return value
}

func (e proxyEvent) index() int {
	value, _ := e["contentIndex"].(float64)
	return int(value)
}

func parseProxyEvents(t *testing.T, body string) []proxyEvent {
	t.Helper()
	var events []proxyEvent
	for _, line := range strings.Split(body, "\n") {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			continue
		}
		var event proxyEvent
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			t.Fatalf("invalid proxy event %q: %s", data, err)
		}
		events = append(events, event)
	}
	return events
}

func eventsOfType(events []proxyEvent, eventType string) []proxyEvent {
	var matched []proxyEvent
	for _, event := range events {
		if event.str("type") == eventType {
			matched = append(matched, event)
		}
	}
	return matched
}

func lastEvent(t *testing.T, events []proxyEvent) proxyEvent {
	t.Helper()
	if len(events) == 0 {
		t.Fatal("no proxy events")
	}
	return events[len(events)-1]
}

// assembled is the assistant message a Pi client reconstructs from proxy events.
type assembled struct {
	text      string
	thinking  string
	toolCalls []assembledToolCall
	reason    string
	usage     map[string]any
	errorText string
}

type assembledToolCall struct {
	id        string
	name      string
	arguments string
	final     map[string]any
}

func assemble(t *testing.T, events []proxyEvent) assembled {
	t.Helper()
	var result assembled
	kinds := map[int]string{}
	tools := map[int]*assembledToolCall{}
	var order []int
	for _, event := range events {
		switch event.str("type") {
		case "text_start":
			kinds[event.index()] = "text"
		case "thinking_start":
			kinds[event.index()] = "thinking"
		case "toolcall_start":
			kinds[event.index()] = "toolCall"
			tools[event.index()] = &assembledToolCall{id: event.str("id"), name: event.str("toolName")}
			order = append(order, event.index())
		case "text_delta", "thinking_delta", "toolcall_delta":
			wantKind := strings.TrimSuffix(strings.TrimSuffix(event.str("type"), "_delta"), "call")
			kind, ok := kinds[event.index()]
			if !ok {
				t.Fatalf("delta before start: %v", event)
			}
			switch kind {
			case "text":
				if wantKind != "text" {
					t.Fatalf("%s for text content: %v", event.str("type"), event)
				}
				result.text += event.str("delta")
			case "thinking":
				if wantKind != "thinking" {
					t.Fatalf("%s for thinking content: %v", event.str("type"), event)
				}
				result.thinking += event.str("delta")
			case "toolCall":
				if wantKind != "tool" {
					t.Fatalf("%s for tool call content: %v", event.str("type"), event)
				}
				tools[event.index()].arguments += event.str("delta")
			}
		case "toolcall_end":
			call := tools[event.index()]
			if call == nil {
				t.Fatalf("toolcall_end before start: %v", event)
			}
			if final, ok := event["toolCall"].(map[string]any); ok {
				call.final = final
			}
		case "done":
			result.reason = event.str("reason")
			result.usage, _ = event["usage"].(map[string]any)
		case "error":
			result.reason = event.str("reason")
			result.errorText = event.str("errorMessage")
		}
	}
	for _, index := range order {
		result.toolCalls = append(result.toolCalls, *tools[index])
	}
	return result
}

func sseBody(events ...string) string {
	var body strings.Builder
	for _, event := range events {
		body.WriteString("data: ")
		body.WriteString(event)
		body.WriteString("\n\n")
	}
	return body.String()
}

func newParityApp(t *testing.T, upstreamURL string, models ...modelSettings) *App {
	t.Helper()
	jsonData, err := json.Marshal(appSettings{OpenAIBaseURL: upstreamURL, Models: models})
	if err != nil {
		t.Fatalf("encode settings: %s", err)
	}
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData:                jsonData,
		DecryptedSecureJSONData: map[string]string{"openAIAPIKey": "secret"},
	})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	return inst.(*App)
}

func callLLMStream(t *testing.T, app *App, body string) []proxyEvent {
	t.Helper()
	var sender mockCallResourceResponseSender
	err := app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: adminPluginContext(),
		Method:        http.MethodPost,
		Path:          "llm/stream",
		Body:          []byte(body),
	}, &sender)
	if err != nil {
		t.Fatalf("CallResource error: %s", err)
	}
	return parseProxyEvents(t, joinBodies(sender.responses))
}

func relayChat(t *testing.T, body string) []proxyEvent {
	t.Helper()
	recorder := httptest.NewRecorder()
	_, _, err := (&App{}).relayOpenAIChatStream(strings.NewReader(body), newProxyEventWriter(recorder, nil))
	events := parseProxyEvents(t, recorder.Body.String())
	if err != nil {
		events = append(events, proxyEvent{"type": "error", "reason": "error", "errorMessage": err.Error()})
	}
	return events
}

func relayResponses(t *testing.T, body string) []proxyEvent {
	t.Helper()
	recorder := httptest.NewRecorder()
	_, _, err := (&App{}).relayOpenAIResponsesStream(strings.NewReader(body), newProxyEventWriter(recorder, nil))
	events := parseProxyEvents(t, recorder.Body.String())
	if err != nil {
		events = append(events, proxyEvent{"type": "error", "reason": "error", "errorMessage": err.Error()})
	}
	return events
}

// The same turn, reasoning then text then two parallel tool calls, in both protocols.
func TestParityReasoningTextAndParallelToolCalls(t *testing.T) {
	chat := sseBody(
		`{"choices":[{"delta":{"reasoning_content":"Need "}}]}`,
		`{"choices":[{"delta":{"reasoning_content":"two queries."}}]}`,
		`{"choices":[{"delta":{"content":"Checking."}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"bash","arguments":""}}]}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"read","arguments":"{\"path\":"}}]}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":\"ls\"}"}}]}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"/a\"}"}}]}}]}`,
		`{"choices":[{"finish_reason":"tool_calls","delta":{}}]}`,
		`{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":40,"total_tokens":140,"prompt_tokens_details":{"cached_tokens":60},"completion_tokens_details":{"reasoning_tokens":12}}}`,
		`[DONE]`,
	)
	responses := sseBody(
		`{"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}`,
		`{"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"Need "}`,
		`{"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"two queries."}`,
		`{"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"Need two queries."}],"encrypted_content":"enc"}}`,
		`{"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}`,
		`{"type":"response.output_text.delta","output_index":1,"delta":"Checking."}`,
		`{"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"Checking."}]}}`,
		`{"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"bash","arguments":""}}`,
		`{"type":"response.output_item.added","output_index":3,"item":{"type":"function_call","id":"fc_b","call_id":"call_b","name":"read","arguments":""}}`,
		`{"type":"response.function_call_arguments.delta","output_index":2,"delta":"{\"command\":\"ls\"}"}`,
		`{"type":"response.function_call_arguments.delta","output_index":3,"delta":"{\"path\":"}`,
		`{"type":"response.function_call_arguments.delta","output_index":3,"delta":"\"/a\"}"}`,
		`{"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"bash","arguments":"{\"command\":\"ls\"}"}}`,
		`{"type":"response.output_item.done","output_index":3,"item":{"type":"function_call","id":"fc_b","call_id":"call_b","name":"read","arguments":"{\"path\":\"/a\"}"}}`,
		`{"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":60},"output_tokens":40,"output_tokens_details":{"reasoning_tokens":12},"total_tokens":140}}}`,
	)

	results := map[string]assembled{
		"chat-completions": assemble(t, relayChat(t, chat)),
		"responses":        assemble(t, relayResponses(t, responses)),
	}
	for protocol, got := range results {
		t.Run(protocol, func(t *testing.T) {
			if got.thinking != "Need two queries." || got.text != "Checking." {
				t.Fatalf("thinking/text: %q %q", got.thinking, got.text)
			}
			if got.reason != "toolUse" {
				t.Fatalf("reason: %q", got.reason)
			}
			if len(got.toolCalls) != 2 {
				t.Fatalf("tool calls: %#v", got.toolCalls)
			}
			wantArgs := []string{`{"command":"ls"}`, `{"path":"/a"}`}
			wantNames := []string{"bash", "read"}
			for i, call := range got.toolCalls {
				if call.name != wantNames[i] || call.arguments != wantArgs[i] {
					t.Fatalf("tool call %d: %#v", i, call)
				}
				if !strings.HasPrefix(call.id, []string{"call_a", "call_b"}[i]) {
					t.Fatalf("tool call %d id: %q", i, call.id)
				}
				if call.final == nil || call.final["id"] != call.id || call.final["name"] != call.name {
					t.Fatalf("toolcall_end must carry the final tool call: %#v", call.final)
				}
				var args map[string]any
				_ = json.Unmarshal([]byte(wantArgs[i]), &args)
				encoded, _ := json.Marshal(call.final["arguments"])
				expected, _ := json.Marshal(args)
				if string(encoded) != string(expected) {
					t.Fatalf("final arguments: %s", encoded)
				}
			}
			usage := got.usage
			if usage["input"] != float64(40) || usage["cacheRead"] != float64(60) || usage["output"] != float64(40) ||
				usage["totalTokens"] != float64(140) || usage["reasoningTokens"] != float64(12) || usage["reported"] != true {
				t.Fatalf("usage: %#v", usage)
			}
		})
	}
}

func TestParityContentIndexesAreUniqueAndEndOnce(t *testing.T) {
	for protocol, events := range map[string][]proxyEvent{
		"chat-completions": relayChat(t, sseBody(
			`{"choices":[{"delta":{"reasoning":"r"}}]}`,
			`{"choices":[{"delta":{"content":"t"}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"bash","arguments":"{}"}}]}}]}`,
			`{"choices":[{"finish_reason":"tool_calls","delta":{}}]}`,
			`[DONE]`,
		)),
		"responses": relayResponses(t, sseBody(
			`{"type":"response.reasoning_text.delta","output_index":0,"delta":"r"}`,
			`{"type":"response.output_text.delta","output_index":1,"delta":"t"}`,
			`{"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc","call_id":"c","name":"bash","arguments":"{}"}}`,
			`{"type":"response.completed","response":{"status":"completed"}}`,
		)),
	} {
		t.Run(protocol, func(t *testing.T) {
			starts := map[int]string{}
			ends := map[int]int{}
			for _, event := range events {
				eventType := event.str("type")
				switch {
				case strings.HasSuffix(eventType, "_start"):
					if previous, ok := starts[event.index()]; ok {
						t.Fatalf("content index %d started twice (%s, %s)", event.index(), previous, eventType)
					}
					starts[event.index()] = eventType
				case strings.HasSuffix(eventType, "_end"):
					ends[event.index()]++
				}
			}
			if len(starts) != 3 {
				t.Fatalf("expected three content blocks, got %v", starts)
			}
			for index := range starts {
				if ends[index] != 1 {
					t.Fatalf("content index %d ended %d times", index, ends[index])
				}
			}
			if lastEvent(t, events).str("type") != "done" {
				t.Fatalf("stream must end with done: %v", lastEvent(t, events))
			}
		})
	}
}

func TestChatReasoningFieldVariants(t *testing.T) {
	for _, field := range []string{"reasoning_content", "reasoning", "reasoning_text"} {
		t.Run(field, func(t *testing.T) {
			got := assemble(t, relayChat(t, sseBody(
				`{"choices":[{"delta":{"`+field+`":"think"}}]}`,
				`{"choices":[{"delta":{"content":"answer"}}]}`,
				`{"choices":[{"finish_reason":"stop","delta":{}}]}`,
				`[DONE]`,
			)))
			if got.thinking != "think" || got.text != "answer" || got.reason != "stop" {
				t.Fatalf("unexpected message: %#v", got)
			}
		})
	}
}

func TestParityLengthStopReason(t *testing.T) {
	chat := assemble(t, relayChat(t, sseBody(
		`{"choices":[{"delta":{"content":"cut"}}]}`,
		`{"choices":[{"finish_reason":"length","delta":{}}]}`,
		`[DONE]`,
	)))
	responses := assemble(t, relayResponses(t, sseBody(
		`{"type":"response.output_text.delta","output_index":0,"delta":"cut"}`,
		`{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}`,
	)))
	for protocol, got := range map[string]assembled{"chat-completions": chat, "responses": responses} {
		if got.reason != "length" || got.text != "cut" {
			t.Fatalf("%s: %#v", protocol, got)
		}
	}
}

func TestChatToolCallWithoutIDGetsStableGeneratedID(t *testing.T) {
	events := relayChat(t, sseBody(
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"bash","arguments":"{\"command\":"}}]}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls\"}"}}]}}]}`,
		`{"choices":[{"finish_reason":"tool_calls","delta":{}}]}`,
		`[DONE]`,
	))
	got := assemble(t, events)
	if len(got.toolCalls) != 1 || got.toolCalls[0].id == "" || got.toolCalls[0].final["id"] != got.toolCalls[0].id {
		t.Fatalf("tool call id: %#v", got.toolCalls)
	}
}

func TestToolCallEndOmitsFinalCallForInvalidArguments(t *testing.T) {
	got := assemble(t, relayChat(t, sseBody(
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"bash","arguments":"{\"command\":"}}]}}]}`,
		`{"choices":[{"finish_reason":"tool_calls","delta":{}}]}`,
		`[DONE]`,
	)))
	if len(got.toolCalls) != 1 || got.toolCalls[0].final != nil {
		t.Fatalf("invalid arguments must leave parsing to the client: %#v", got.toolCalls)
	}
}

// Tool-call IDs from one protocol must survive a later request in the other:
// Responses IDs carry "call|item", Chat Completions IDs are plain.
func TestToolCallIDsRoundTripAcrossProtocols(t *testing.T) {
	history := []proxyMessage{
		{Role: "user", Content: json.RawMessage(`"list"`)},
		{Role: "assistant", Content: json.RawMessage(`[{"type":"toolCall","id":"call_r|fc_r","name":"bash","arguments":{"command":"ls"}},{"type":"toolCall","id":"call_c","name":"read","arguments":{"path":"/a"}}]`)},
		{Role: "toolResult", ToolCallID: "call_r|fc_r", ToolName: "bash", Content: json.RawMessage(`"a"`)},
		{Role: "toolResult", ToolCallID: "call_c", ToolName: "read", Content: json.RawMessage(`"b"`)},
	}
	request := proxyStreamRequest{Context: proxyContext{Messages: history}}
	app := App{}

	chat := app.buildOpenAIChatRequest(request, modelSettings{ID: "m"})
	calls := chat.Messages[1].ToolCalls
	if len(calls) != 2 || calls[0].ID != "call_r" || calls[1].ID != "call_c" {
		t.Fatalf("chat tool call ids: %#v", calls)
	}
	if chat.Messages[2].ToolCallID != "call_r" || chat.Messages[3].ToolCallID != "call_c" {
		t.Fatalf("chat tool result ids: %#v %#v", chat.Messages[2], chat.Messages[3])
	}

	responses := app.buildOpenAIResponsesRequest(request, modelSettings{ID: "m"})
	var items []map[string]any
	for _, raw := range responses.Input {
		var item map[string]any
		_ = json.Unmarshal(raw, &item)
		items = append(items, item)
	}
	if items[1]["call_id"] != "call_r" || items[1]["id"] != "fc_r" || items[2]["call_id"] != "call_c" {
		t.Fatalf("responses function calls: %v", items)
	}
	if items[3]["call_id"] != "call_r" || items[4]["call_id"] != "call_c" {
		t.Fatalf("responses function outputs: %v", items)
	}
}

func TestChatStreamSurfacesUpstreamErrors(t *testing.T) {
	cases := map[string]string{
		"error chunk": sseBody(
			`{"choices":[{"delta":{"content":"par"}}]}`,
			`{"error":{"message":"context length exceeded","type":"invalid_request_error"}}`,
		),
		"stream ends early": sseBody(
			`{"choices":[{"delta":{"content":"par"}}]}`,
		),
		"invalid chunk": "data: {not json\n\n",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			events := relayChat(t, body)
			last := lastEvent(t, events)
			if last.str("type") != "error" || last.str("errorMessage") == "" {
				t.Fatalf("expected an error event, got %v", events)
			}
			if len(eventsOfType(events, "done")) != 0 {
				t.Fatalf("a failed stream must not report done: %v", events)
			}
		})
	}
}

func TestChatStreamWithoutDoneMarkerCompletesAfterFinishReason(t *testing.T) {
	events := relayChat(t, sseBody(
		`{"choices":[{"delta":{"content":"ok"}}]}`,
		`{"choices":[{"finish_reason":"stop","delta":{}}]}`,
	))
	if got := assemble(t, events); got.reason != "stop" || got.text != "ok" {
		t.Fatalf("unexpected message: %#v", got)
	}
}

func TestResponsesStreamSurfacesUpstreamErrors(t *testing.T) {
	cases := map[string]string{
		"failed": sseBody(
			`{"type":"response.output_text.delta","output_index":0,"delta":"par"}`,
			`{"type":"response.failed","response":{"status":"failed","error":{"message":"server overloaded"}}}`,
		),
		"error event":       sseBody(`{"type":"error","code":"rate_limit_exceeded","message":"slow down"}`),
		"stream ends early": sseBody(`{"type":"response.output_text.delta","output_index":0,"delta":"par"}`),
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			events := relayResponses(t, body)
			if last := lastEvent(t, events); last.str("type") != "error" || last.str("errorMessage") == "" {
				t.Fatalf("expected an error event, got %v", events)
			}
			if len(eventsOfType(events, "done")) != 0 {
				t.Fatalf("a failed stream must not report done: %v", events)
			}
		})
	}
}

func TestLLMStreamMapsUpstreamHTTPErrors(t *testing.T) {
	for _, protocol := range []string{openAIProtocolChatCompletions, openAIProtocolResponses, openAIProtocolAuto} {
		for _, status := range []int{http.StatusBadRequest, http.StatusUnauthorized, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway} {
			t.Run(protocol+"/"+http.StatusText(status), func(t *testing.T) {
				requests := 0
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					requests++
					w.WriteHeader(status)
					_, _ = w.Write([]byte(`{"error":{"message":"upstream said no","type":"server_error"}}`))
				}))
				defer upstream.Close()
				app := newParityApp(t, upstream.URL, modelSettings{ID: "m", Default: true, Protocol: protocol, ThinkingLevel: thinkingLevelMedium})

				events := callLLMStream(t, app, `{"context":{"messages":[{"role":"user","content":"hi"}]},"options":{"reasoning":"medium"}}`)
				if events[0].str("type") != "start" {
					t.Fatalf("stream must start before the error: %v", events)
				}
				last := lastEvent(t, events)
				if last.str("type") != "error" || !strings.Contains(last.str("errorMessage"), "upstream said no") || last["upstreamStatus"] != float64(status) {
					t.Fatalf("unexpected error event: %v", last)
				}
				if requests != 1 {
					t.Fatalf("only the reasoning_effort compatibility error may switch protocols; got %d requests", requests)
				}
			})
		}
	}
}

func TestLLMStreamReportsUnreachableUpstream(t *testing.T) {
	upstream := httptest.NewServer(http.NotFoundHandler())
	url := upstream.URL
	upstream.Close()
	app := newParityApp(t, url, modelSettings{ID: "m", Default: true})

	events := callLLMStream(t, app, `{"context":{"messages":[{"role":"user","content":"hi"}]}}`)
	if last := lastEvent(t, events); last.str("type") != "error" || last.str("errorMessage") == "" {
		t.Fatalf("expected an error event, got %v", events)
	}
}

// The auto fallback resends the same history, so tool-call IDs and reasoning
// stay attached to their calls after the protocol switch.
func TestAutoFallbackResendsHistoryWithStableToolCallIDs(t *testing.T) {
	var mu sync.Mutex
	var responsesInput []map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch req.URL.Path {
		case "/chat/completions":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"Please use /v1/responses instead.","type":"invalid_request_error","param":"reasoning_effort"}}`))
		case "/responses":
			var payload struct {
				Input []map[string]any `json:"input"`
			}
			_ = json.NewDecoder(req.Body).Decode(&payload)
			responsesInput = payload.Input
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte(sseBody(
				`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_2","call_id":"call_2","name":"bash","arguments":""}}`,
				`{"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\"command\":\"pwd\"}"}`,
				`{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_2","call_id":"call_2","name":"bash","arguments":"{\"command\":\"pwd\"}"}}`,
				`{"type":"response.completed","response":{"status":"completed"}}`,
			)))
		}
	}))
	defer upstream.Close()
	app := newParityApp(t, upstream.URL, modelSettings{ID: "m", Default: true, Protocol: openAIProtocolAuto, ThinkingLevel: thinkingLevelMedium})

	events := callLLMStream(t, app, `{
		"context":{"messages":[
			{"role":"user","content":"where am I"},
			{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"ls"}}]},
			{"role":"toolResult","toolCallId":"call_1","toolName":"bash","content":[{"type":"text","text":"a"}]}
		],"tools":[{"name":"bash","description":"Run","parameters":{"type":"object"}}]},
		"options":{"reasoning":"medium"}
	}`)
	got := assemble(t, events)
	if len(got.toolCalls) != 1 || got.toolCalls[0].id != "call_2|fc_2" || got.toolCalls[0].arguments != `{"command":"pwd"}` || got.reason != "toolUse" {
		t.Fatalf("unexpected message: %#v", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(responsesInput) != 3 || responsesInput[1]["call_id"] != "call_1" || responsesInput[2]["call_id"] != "call_1" {
		t.Fatalf("history lost tool call ids: %v", responsesInput)
	}
}

func TestLLMStreamCancellationStopsUpstream(t *testing.T) {
	for _, protocol := range []string{openAIProtocolChatCompletions, openAIProtocolResponses} {
		t.Run(protocol, func(t *testing.T) {
			upstreamCanceled := make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				if protocol == openAIProtocolResponses {
					_, _ = w.Write([]byte(sseBody(`{"type":"response.output_text.delta","output_index":0,"delta":"par"}`)))
				} else {
					_, _ = w.Write([]byte(sseBody(`{"choices":[{"delta":{"content":"par"}}]}`)))
				}
				w.(http.Flusher).Flush()
				<-req.Context().Done()
				close(upstreamCanceled)
			}))
			defer upstream.Close()
			app := newParityApp(t, upstream.URL, modelSettings{ID: "m", Default: true, Protocol: protocol})

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req := httptest.NewRequest(http.MethodPost, "/llm/stream", strings.NewReader(`{"context":{"messages":[{"role":"user","content":"hi"}]}}`)).WithContext(ctx)
			recorder := newSignalingRecorder(`"type":"text_delta"`)
			handlerDone := make(chan struct{})
			go func() {
				app.handleLLMStream(recorder, req)
				close(handlerDone)
			}()

			select {
			case <-recorder.matched:
			case <-time.After(5 * time.Second):
				t.Fatal("the first delta was not relayed")
			}
			cancel()
			select {
			case <-upstreamCanceled:
			case <-time.After(5 * time.Second):
				t.Fatal("client cancellation did not cancel the upstream request")
			}
			select {
			case <-handlerDone:
			case <-time.After(5 * time.Second):
				t.Fatal("handler did not return after cancellation")
			}
			events := parseProxyEvents(t, recorder.body())
			last := lastEvent(t, events)
			if last.str("type") != "error" || last.str("reason") != "aborted" {
				t.Fatalf("a canceled stream must end with an aborted error event, got %v", events)
			}
			if len(eventsOfType(events, "done")) != 0 {
				t.Fatalf("a canceled stream must not report done: %v", events)
			}
		})
	}
}

// signalingRecorder is a concurrency-safe ResponseWriter that signals once
// the relayed body contains a marker.
type signalingRecorder struct {
	mu      sync.Mutex
	header  http.Header
	buffer  strings.Builder
	marker  string
	matched chan struct{}
	once    sync.Once
}

func newSignalingRecorder(marker string) *signalingRecorder {
	return &signalingRecorder{header: http.Header{}, marker: marker, matched: make(chan struct{})}
}

func (r *signalingRecorder) Header() http.Header { return r.header }
func (r *signalingRecorder) WriteHeader(int)     {}
func (r *signalingRecorder) Write(data []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buffer.Write(data)
	if strings.Contains(r.buffer.String(), r.marker) {
		r.once.Do(func() { close(r.matched) })
	}
	return len(data), nil
}

func (r *signalingRecorder) body() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.buffer.String()
}

func TestLLMStreamClampsMaxTokensForBothProtocols(t *testing.T) {
	cases := []struct {
		name      string
		requested string
		limit     flexibleInt
		want      int
	}{
		{name: "below limit", requested: `"maxTokens":1000,`, limit: 4096, want: 1000},
		{name: "above limit", requested: `"maxTokens":100000,`, limit: 4096, want: 4096},
		{name: "omitted", requested: ``, limit: 4096, want: 4096},
		{name: "zero", requested: `"maxTokens":0,`, limit: 4096, want: 4096},
		{name: "default limit", requested: `"maxTokens":100000,`, limit: 0, want: defaultMaxOutputTokens},
	}
	for _, protocol := range []string{openAIProtocolChatCompletions, openAIProtocolResponses} {
		for _, tc := range cases {
			t.Run(protocol+"/"+tc.name, func(t *testing.T) {
				var got *int
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					var payload struct {
						MaxTokens       *int `json:"max_tokens"`
						MaxOutputTokens *int `json:"max_output_tokens"`
					}
					_ = json.NewDecoder(req.Body).Decode(&payload)
					got = payload.MaxTokens
					if protocol == openAIProtocolResponses {
						got = payload.MaxOutputTokens
					}
					w.WriteHeader(http.StatusInternalServerError)
				}))
				defer upstream.Close()
				model := modelSettings{ID: "m", Default: true, Protocol: protocol, ContextWindow: 1_000_000, MaxOutputTokens: tc.limit}
				app := newParityApp(t, upstream.URL, model)
				app.settings.Models[0].MaxOutputTokens = tc.limit

				callLLMStream(t, app, `{"context":{"messages":[{"role":"user","content":"hi"}]},"options":{`+strings.TrimSuffix(tc.requested, ",")+`}}`)
				if got == nil || *got != tc.want {
					t.Fatalf("expected output budget %d, got %v", tc.want, got)
				}
			})
		}
	}
}

func TestParityUsageWithoutReport(t *testing.T) {
	chat := assemble(t, relayChat(t, sseBody(`{"choices":[{"finish_reason":"stop","delta":{"content":"x"}}]}`, `[DONE]`)))
	responses := assemble(t, relayResponses(t, sseBody(
		`{"type":"response.output_text.delta","output_index":0,"delta":"x"}`,
		`{"type":"response.completed","response":{"status":"completed"}}`,
	)))
	for protocol, got := range map[string]assembled{"chat-completions": chat, "responses": responses} {
		if got.usage["reported"] != false || got.usage["totalTokens"] != float64(0) {
			t.Fatalf("%s: missing usage must be reported as unreported zeros, got %v", protocol, got.usage)
		}
	}
}

func TestResponsesUsageSubtractsCacheWrites(t *testing.T) {
	usage := usageFromOpenAIResponses(&openAIResponsesUsage{InputTokens: 100, OutputTokens: 5, InputTokensDetails: struct {
		CachedTokens     int `json:"cached_tokens"`
		CacheWriteTokens int `json:"cache_write_tokens"`
	}{CachedTokens: 30, CacheWriteTokens: 20}})
	chat := usageFromOpenAI(&openAIUsage{PromptTokens: 100, CompletionTokens: 5, PromptTokensDetails: struct {
		CachedTokens     int `json:"cached_tokens"`
		CacheWriteTokens int `json:"cache_write_tokens"`
	}{CachedTokens: 30, CacheWriteTokens: 20}})
	for _, got := range []proxyUsage{usage, chat} {
		if got.Input != 50 || got.CacheRead != 30 || got.CacheWrite != 20 || got.TotalTokens != 105 || got.ReasoningTokens != nil {
			t.Fatalf("unexpected usage: %#v", got)
		}
	}
}

var errTestWriter = errors.New("client gone")

type failingResponseWriter struct {
	header http.Header
	writes int
}

func (w *failingResponseWriter) Header() http.Header {
	if w.header == nil {
		w.header = http.Header{}
	}
	return w.header
}
func (w *failingResponseWriter) WriteHeader(int) {}
func (w *failingResponseWriter) Write(data []byte) (int, error) {
	w.writes++
	if w.writes > 1 {
		return 0, errTestWriter
	}
	return len(data), nil
}

func TestRelayStopsWhenClientWriteFails(t *testing.T) {
	body := sseBody(
		`{"choices":[{"delta":{"content":"a"}}]}`,
		`{"choices":[{"delta":{"content":"b"}}]}`,
		`[DONE]`,
	)
	writer := &failingResponseWriter{}
	_, reason, err := (&App{}).relayOpenAIChatStream(strings.NewReader(body), newProxyEventWriter(writer, nil))
	if !errors.Is(err, errTestWriter) || reason != "error" {
		t.Fatalf("expected the write error, got %v %q", err, reason)
	}
}

// Pi transcripts carry the prompt and tools as system messages instead of
// context.systemPrompt and context.tools.
func TestCollapseSystemMessagesReplaysPiTranscript(t *testing.T) {
	var request proxyStreamRequest
	err := json.Unmarshal([]byte(`{"context":{"messages":[
		{"role":"system","content":"Base prompt.","sections":{"b":"Section B.","a":"Section A."},"toolsAdded":[
			{"name":"read","description":"Read","parameters":{"type":"object"}},
			{"name":"bash","description":"Run","parameters":{"type":"object"}}
		],"timestamp":0},
		{"role":"user","content":"hi","timestamp":1},
		{"role":"system","content":[{"type":"text","text":"Later instruction."}],"sections":{"b":null,"c":"Section C."},
			"toolsRemoved":[{"name":"read"}],"toolsAdded":[{"name":"edit","description":"Edit","parameters":{"type":"object"}}],"timestamp":2},
		{"role":"assistant","content":[{"type":"text","text":"ok"}],"timestamp":3}
	]}}`), &request)
	if err != nil {
		t.Fatalf("decode: %s", err)
	}

	got := collapseSystemMessages(request.Context)
	if want := "Base prompt.\n\nLater instruction.\n\nSection A.\n\nSection C."; got.SystemPrompt != want {
		t.Fatalf("system prompt:\n%q\nwant\n%q", got.SystemPrompt, want)
	}
	var names []string
	for _, tool := range got.Tools {
		names = append(names, tool.Name)
	}
	if strings.Join(names, ",") != "bash,edit" {
		t.Fatalf("tools: %v", names)
	}
	if len(got.Messages) != 2 || got.Messages[0].Role != "user" || got.Messages[1].Role != "assistant" {
		t.Fatalf("system messages must leave the history: %#v", got.Messages)
	}

	app := App{settings: appSettings{SystemPromptAddendum: "Instance rule."}}
	chat := app.buildOpenAIChatRequest(proxyStreamRequest{Context: got}, modelSettings{ID: "m"})
	if chat.Messages[0].Role != "system" || !strings.HasPrefix(chat.Messages[0].Content, "Base prompt.") ||
		!strings.Contains(chat.Messages[0].Content, "Instance rule.") || len(chat.Tools) != 2 {
		t.Fatalf("chat request: %#v", chat)
	}
	for _, message := range chat.Messages[1:] {
		if message.Role == "system" {
			t.Fatalf("only one leading system message may reach Chat Completions: %#v", chat.Messages)
		}
	}
	responses := app.buildOpenAIResponsesRequest(proxyStreamRequest{Context: got}, modelSettings{ID: "m"})
	if !strings.HasPrefix(responses.Instructions, "Base prompt.") || len(responses.Tools) != 2 || len(responses.Input) != 2 {
		t.Fatalf("responses request: %#v", responses)
	}
}

func TestCollapseSystemMessagesKeepsLegacyContext(t *testing.T) {
	legacy := proxyContext{
		SystemPrompt: "Legacy.",
		Tools:        []proxyTool{{Name: "bash"}},
		Messages:     []proxyMessage{{Role: "user", Content: json.RawMessage(`"hi"`)}},
	}
	got := collapseSystemMessages(legacy)
	if got.SystemPrompt != "Legacy." || len(got.Tools) != 1 || len(got.Messages) != 1 {
		t.Fatalf("legacy context changed: %#v", got)
	}
	if again := collapseSystemMessages(got); again.SystemPrompt != got.SystemPrompt || len(again.Tools) != 1 {
		t.Fatalf("collapsing must be idempotent: %#v", again)
	}
}

func TestLLMStreamSendsTranscriptPromptAndToolsUpstream(t *testing.T) {
	var payload openAIChatRequest
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_ = json.NewDecoder(req.Body).Decode(&payload)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sseBody(`{"choices":[{"finish_reason":"stop","delta":{"content":"ok"}}]}`, `[DONE]`)))
	}))
	defer upstream.Close()
	app := newParityApp(t, upstream.URL, modelSettings{ID: "m", Default: true})

	events := callLLMStream(t, app, `{"model":{"id":"m"},"context":{"messages":[
		{"role":"system","content":"You help.","toolsAdded":[{"name":"bash","description":"Run","parameters":{"type":"object"}}],"timestamp":0},
		{"role":"user","content":"hi","timestamp":1}
	]},"options":{}}`)
	if lastEvent(t, events).str("type") != "done" {
		t.Fatalf("unexpected stream: %v", events)
	}
	if len(payload.Messages) != 2 || payload.Messages[0].Role != "system" || payload.Messages[0].Content != "You help." ||
		payload.Messages[1].Role != "user" || len(payload.Tools) != 1 || payload.Tools[0].Function.Name != "bash" {
		t.Fatalf("upstream payload: %#v", payload)
	}
}
