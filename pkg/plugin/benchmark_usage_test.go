package plugin

import (
	"encoding/json"
	"testing"
)

func TestBenchmarkChatUsage(t *testing.T) {
	var source openAIUsage
	err := json.Unmarshal([]byte(`{"prompt_tokens":100,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":20,"cache_write_tokens":10},"completion_tokens_details":{"reasoning_tokens":15}}`), &source)
	if err != nil {
		t.Fatal(err)
	}
	usage := usageFromOpenAI(&source)
	if !usage.Reported || usage.Input != 70 || usage.CacheRead != 20 || usage.CacheWrite != 10 || usage.Output != 40 || usage.TotalTokens != 140 {
		t.Fatalf("incorrect usage: %#v", usage)
	}
	if usage.ReasoningTokens == nil || *usage.ReasoningTokens != 15 {
		t.Fatalf("missing reasoning tokens: %#v", usage)
	}
}

func TestBenchmarkUsageAvailability(t *testing.T) {
	for _, usage := range []proxyUsage{zeroUsage(), usageFromOpenAI(nil), usageFromOpenAIResponses(nil)} {
		if usage.Reported || usage.ReasoningTokens != nil {
			t.Fatalf("missing usage must remain unknown: %#v", usage)
		}
	}
	for _, usage := range []proxyUsage{usageFromOpenAI(&openAIUsage{}), usageFromOpenAIResponses(&openAIResponsesUsage{})} {
		if !usage.Reported || usage.ReasoningTokens != nil {
			t.Fatalf("reported zero must differ from missing usage: %#v", usage)
		}
	}
	var source openAIResponsesUsage
	if err := json.Unmarshal([]byte(`{"input_tokens":10,"output_tokens":5,"input_tokens_details":{"cached_tokens":4},"output_tokens_details":{"reasoning_tokens":0}}`), &source); err != nil {
		t.Fatal(err)
	}
	usage := usageFromOpenAIResponses(&source)
	if !usage.Reported || usage.Input != 6 || usage.CacheRead != 4 || usage.TotalTokens != 15 || usage.ReasoningTokens == nil || *usage.ReasoningTokens != 0 {
		t.Fatalf("incorrect responses usage: %#v", usage)
	}
}
