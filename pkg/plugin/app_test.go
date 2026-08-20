package plugin

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestLoadSettingsReadsPrometheusDatasourceAllowList(t *testing.T) {
	jsonData, _ := json.Marshal(map[string]any{
		"allowedPrometheusDatasourceUids": []string{"prometheus"},
	})

	settings := loadSettings(backend.AppInstanceSettings{JSONData: jsonData})

	if len(settings.AllowedPrometheusDatasourceUIDs) != 1 || settings.AllowedPrometheusDatasourceUIDs[0] != "prometheus" {
		t.Fatalf("expected Prometheus allow-list, got %#v", settings.AllowedPrometheusDatasourceUIDs)
	}
}

func TestLoadSettingsPreservesEmptyPrometheusDatasourceAllowList(t *testing.T) {
	jsonData, _ := json.Marshal(map[string]any{
		"allowedPrometheusDatasourceUids": []string{},
	})

	settings := loadSettings(backend.AppInstanceSettings{JSONData: jsonData})

	if settings.AllowedPrometheusDatasourceUIDs == nil {
		t.Fatal("expected explicit empty Prometheus allow-list to be preserved")
	}
	if len(settings.AllowedPrometheusDatasourceUIDs) != 0 {
		t.Fatalf("expected explicit empty Prometheus allow-list, got %#v", settings.AllowedPrometheusDatasourceUIDs)
	}
}

func TestLoadSettingsNormalizesAccessPolicy(t *testing.T) {
	jsonData, _ := json.Marshal(map[string]any{
		"accessMode":   "Users",
		"allowedUsers": []string{" Alice@example.com ", "alice@example.com", "bob"},
	})

	settings := loadSettings(backend.AppInstanceSettings{JSONData: jsonData})

	if settings.AccessMode != accessModeUsers {
		t.Fatalf("expected users access mode, got %q", settings.AccessMode)
	}
	expected := []string{"alice@example.com", "bob"}
	if strings.Join(settings.AllowedUsers, ",") != strings.Join(expected, ",") {
		t.Fatalf("expected normalized allowed users %#v, got %#v", expected, settings.AllowedUsers)
	}
}

func TestLoadSettingsNormalizesModels(t *testing.T) {
	jsonData, _ := json.Marshal(map[string]any{
		"models": []map[string]any{
			{"id": " gpt-4.1 ", "name": " GPT-4.1 ", "thinkingLevel": "minimal", "thinkingFormat": "deepseek", "protocol": "legacy"},
			{"id": "gpt-4.1"},
			{"id": ""},
			{"id": "qwen", "default": true, "thinkingLevel": "medium", "thinkingFormat": "qwen-chat-template", "protocol": "responses"},
		},
	})

	settings := loadSettings(backend.AppInstanceSettings{JSONData: jsonData})

	if len(settings.Models) != 2 {
		t.Fatalf("expected trimmed and deduped model list, got %#v", settings.Models)
	}
	first := settings.Models[0]
	if first.ID != "gpt-4.1" || first.Name != "GPT-4.1" || first.Default {
		t.Fatalf("expected normalized non-default first model, got %#v", first)
	}
	if first.ThinkingLevel != thinkingLevelOff || first.ThinkingFormat != thinkingFormatOpenAI || first.Protocol != openAIProtocolAuto {
		t.Fatalf("expected invalid per-model settings to fall back to defaults, got %#v", first)
	}
	second := settings.Models[1]
	if second.ID != "qwen" || !second.Default {
		t.Fatalf("expected flagged model to stay default, got %#v", second)
	}
	if second.ThinkingLevel != thinkingLevelMedium || second.ThinkingFormat != thinkingFormatQwenChatTemplate || second.Protocol != openAIProtocolResponses {
		t.Fatalf("expected per-model settings to be preserved, got %#v", second)
	}
}

func TestLoadSettingsDefaultsFirstModelWhenNoDefaultFlagged(t *testing.T) {
	jsonData, _ := json.Marshal(map[string]any{
		"models": []map[string]any{
			{"id": "model-a"},
			{"id": "model-b"},
		},
	})

	settings := loadSettings(backend.AppInstanceSettings{JSONData: jsonData})

	if len(settings.Models) != 2 || !settings.Models[0].Default || settings.Models[1].Default {
		t.Fatalf("expected first model to become the default, got %#v", settings.Models)
	}
}

func TestLoadSettingsKeepsFirstFlaggedDefaultModel(t *testing.T) {
	jsonData, _ := json.Marshal(map[string]any{
		"models": []map[string]any{
			{"id": "model-a"},
			{"id": "model-b", "default": true},
			{"id": "model-c", "default": true},
		},
	})

	settings := loadSettings(backend.AppInstanceSettings{JSONData: jsonData})

	if len(settings.Models) != 3 || settings.Models[0].Default || !settings.Models[1].Default || settings.Models[2].Default {
		t.Fatalf("expected only the first flagged model to stay default, got %#v", settings.Models)
	}
}

func TestLoadSettingsWithoutModels(t *testing.T) {
	settings := loadSettings(backend.AppInstanceSettings{})

	if settings.Models != nil {
		t.Fatalf("expected no configured models, got %#v", settings.Models)
	}
}

func TestResolveRequestModel(t *testing.T) {
	app := &App{settings: appSettings{Models: normalizeModels([]modelSettings{
		{ID: "model-a"},
		{ID: "model-b", Default: true},
	})}}

	model, err := app.resolveRequestModel("")
	if err != nil || model.ID != "model-b" {
		t.Fatalf("expected empty ID to resolve the default model, got %#v (%v)", model, err)
	}
	model, err = app.resolveRequestModel(" model-a ")
	if err != nil || model.ID != "model-a" {
		t.Fatalf("expected trimmed lookup to find model-a, got %#v (%v)", model, err)
	}
	if _, err = app.resolveRequestModel("model-c"); err == nil {
		t.Fatal("expected unknown model to be rejected")
	}

	empty := &App{}
	if _, err = empty.resolveRequestModel(""); err == nil {
		t.Fatal("expected missing model configuration to be rejected")
	}
}

func TestLoadSettingsDefaultsToAllAccess(t *testing.T) {
	settings := loadSettings(backend.AppInstanceSettings{})

	if settings.AccessMode != accessModeAll {
		t.Fatalf("expected all access mode, got %q", settings.AccessMode)
	}
}
