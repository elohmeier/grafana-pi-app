package plugin

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// TestLLMSmokeAgainstRealModel sends a Pi 0.87 transcript (system message with
// tools) through the proxy to a real OpenAI-compatible server and checks a
// tool-call round trip. It is skipped unless PI_LLM_SMOKE_URL is set, e.g.
//
//	PI_LLM_SMOKE_URL=http://localhost:8000/v1 PI_LLM_SMOKE_MODEL=deepseek-v4-flash \
//	PI_LLM_SMOKE_THINKING_FORMAT=deepseek go test ./pkg/plugin -run LLMSmoke -v
func TestLLMSmokeAgainstRealModel(t *testing.T) {
	baseURL := os.Getenv("PI_LLM_SMOKE_URL")
	if baseURL == "" {
		t.Skip("set PI_LLM_SMOKE_URL to run against a model server")
	}
	model := modelSettings{
		ID:             os.Getenv("PI_LLM_SMOKE_MODEL"),
		Default:        true,
		Protocol:       envOr("PI_LLM_SMOKE_PROTOCOL", openAIProtocolChatCompletions),
		ThinkingLevel:  envOr("PI_LLM_SMOKE_THINKING_LEVEL", thinkingLevelMedium),
		ThinkingFormat: envOr("PI_LLM_SMOKE_THINKING_FORMAT", thinkingFormatOpenAI),
	}
	app := newParityApp(t, baseURL, model)
	app.settings.OpenAIAPIKey = envOr("PI_LLM_SMOKE_API_KEY", "local")

	system := map[string]any{
		"role":    "system",
		"content": "You are a test assistant. Use the bash tool when asked to run a command.",
		"toolsAdded": []map[string]any{{
			"name":        "bash",
			"description": "Run a shell command.",
			"parameters": map[string]any{
				"type":       "object",
				"properties": map[string]any{"command": map[string]any{"type": "string"}},
				"required":   []string{"command"},
			},
		}},
		"timestamp": 0,
	}
	user := map[string]any{"role": "user", "content": "Run the command `ls /workspace` with the bash tool.", "timestamp": 1}
	request := func(messages ...any) string {
		body, _ := json.Marshal(map[string]any{
			"model":   map[string]any{"id": model.ID},
			"context": map[string]any{"messages": messages},
			"options": map[string]any{"reasoning": thinkingLevelMedium, "maxTokens": 4096},
		})
		return string(body)
	}

	first := assemble(t, callLLMStream(t, app, request(system, user)))
	if first.errorText != "" || first.reason != "toolUse" || len(first.toolCalls) == 0 {
		t.Fatalf("expected a tool call, got %#v", first)
	}
	call := first.toolCalls[0]
	if call.name != "bash" || call.final == nil || !strings.Contains(stringValue(call.final["arguments"]), "ls") {
		t.Fatalf("unexpected tool call: %#v", call)
	}
	t.Logf("tool call %s %s (thinking %d chars)", call.id, call.arguments, len(first.thinking))

	assistant := map[string]any{
		"role": "assistant",
		"content": []map[string]any{
			{"type": "thinking", "thinking": first.thinking},
			{"type": "toolCall", "id": call.id, "name": call.name, "arguments": call.final["arguments"]},
		},
		"stopReason": "toolUse",
		"timestamp":  2,
	}
	result := map[string]any{
		"role":       "toolResult",
		"toolCallId": call.id,
		"toolName":   "bash",
		"content":    []map[string]any{{"type": "text", "text": "notes.md\nreport.md"}},
		"isError":    false,
		"timestamp":  3,
	}
	second := assemble(t, callLLMStream(t, app, request(system, user, assistant, result)))
	if second.errorText != "" || second.reason != "stop" || !strings.Contains(second.text, "notes.md") {
		t.Fatalf("expected an answer naming the files, got %#v", second)
	}
	t.Logf("answer: %s; usage %v", second.text, second.usage)
}

func envOr(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func stringValue(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
