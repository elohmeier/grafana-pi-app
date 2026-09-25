package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grafana/authlib/authz"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
)

// Make sure App implements required interfaces. This is important to do
// since otherwise we will only get a not implemented error response from plugin in
// runtime. Plugin should not implement all these interfaces - only those which are
// required for a particular task.
var (
	_ backend.CallResourceHandler   = (*App)(nil)
	_ instancemgmt.InstanceDisposer = (*App)(nil)
	_ backend.CheckHealthHandler    = (*App)(nil)
)

// App is an example app plugin with a backend which can respond to data queries.
type App struct {
	backend.CallResourceHandler
	settings             appSettings
	httpClient           *http.Client
	llmProtocolMu        sync.RWMutex
	resolvedLLMProtocols map[string]string
	authzMu              sync.Mutex
	authzToken           string
	authzClient          authz.EnforcementClient
}

type appSettings struct {
	OpenAIBaseURL                   string          `json:"openAIBaseUrl"`
	Models                          []modelSettings `json:"models"`
	AccessMode                      string          `json:"accessMode"`
	AllowedUsers                    []string        `json:"allowedUsers"`
	AllowedPrometheusDatasourceUIDs []string        `json:"allowedPrometheusDatasourceUids"`
	SystemPromptAddendum            string          `json:"systemPromptAddendum"`
	OpenAIAPIKey                    string
	PluginID                        string `json:"pluginId"`
}

type modelSettings struct {
	ID             string `json:"id"`
	Name           string `json:"name,omitempty"`
	Default        bool   `json:"default,omitempty"`
	Protocol       string `json:"protocol,omitempty"`
	ThinkingLevel  string `json:"thinkingLevel,omitempty"`
	ThinkingFormat string `json:"thinkingFormat,omitempty"`
	// ContextWindow is the endpoint's input-plus-output token capacity.
	ContextWindow flexibleInt `json:"contextWindow,omitempty"`
	// MaxOutputTokens bounds the output tokens requested per model call.
	MaxOutputTokens flexibleInt `json:"maxOutputTokens,omitempty"`
}

const (
	defaultContextWindow   = 131072
	minContextWindow       = 4096
	maxContextWindow       = 10_000_000
	defaultMaxOutputTokens = 16384
	minMaxOutputTokens     = 256
)

// flexibleInt accepts JSON numbers and numeric strings; Grafana provisioning
// interpolates environment variables into strings.
type flexibleInt int

func (v *flexibleInt) UnmarshalJSON(data []byte) error {
	text := strings.Trim(strings.TrimSpace(string(data)), `"`)
	if text == "" || text == "null" {
		*v = 0
		return nil
	}
	parsed, err := strconv.Atoi(text)
	if err != nil {
		return fmt.Errorf("expected an integer, got %s", string(data))
	}
	*v = flexibleInt(parsed)
	return nil
}

const (
	openAIProtocolAuto            = "auto"
	openAIProtocolChatCompletions = "chat-completions"
	openAIProtocolResponses       = "responses"

	thinkingLevelOff    = "off"
	thinkingLevelLow    = "low"
	thinkingLevelMedium = "medium"
	thinkingLevelHigh   = "high"
	thinkingLevelXHigh  = "xhigh"

	thinkingFormatOpenAI           = "openai"
	thinkingFormatQwen             = "qwen"
	thinkingFormatQwenChatTemplate = "qwen-chat-template"
)

// NewApp creates a new example *App instance.
func NewApp(_ context.Context, settings backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	app := App{
		settings:             loadSettings(settings),
		httpClient:           &http.Client{Timeout: 10 * time.Minute},
		resolvedLLMProtocols: map[string]string{},
	}

	// Use a httpadapter (provided by the SDK) for resource calls. This allows us
	// to use a *http.ServeMux for resource calls, so we can map multiple routes
	// to CallResource without having to implement extra logic.
	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.CallResourceHandler = httpadapter.New(mux)

	return &app, nil
}

// Dispose here tells plugin SDK that plugin wants to clean up resources when a new instance
// created.
func (a *App) Dispose() {
	// cleanup
}

// CheckHealth handles health checks sent from Grafana to the plugin.
func (a *App) CheckHealth(_ context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	if a.settings.OpenAIAPIKey == "" {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "OpenAI-compatible API key is not configured",
		}, nil
	}
	if len(a.settings.Models) == 0 {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: "No assistant models are configured",
		}, nil
	}

	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: "LLM proxy is configured",
	}, nil
}

func loadSettings(settings backend.AppInstanceSettings) appSettings {
	loaded := appSettings{
		OpenAIBaseURL: "https://api.openai.com/v1",
	}

	if len(settings.JSONData) > 0 {
		_ = json.Unmarshal(settings.JSONData, &loaded)
	}

	if loaded.OpenAIBaseURL == "" {
		loaded.OpenAIBaseURL = "https://api.openai.com/v1"
	}
	loaded.OpenAIBaseURL = strings.TrimRight(loaded.OpenAIBaseURL, "/")
	loaded.Models = normalizeModels(loaded.Models)
	loaded.AccessMode = normalizeAccessMode(loaded.AccessMode)
	loaded.AllowedUsers = normalizeAllowedUsers(loaded.AllowedUsers)
	loaded.OpenAIAPIKey = settings.DecryptedSecureJSONData["openAIAPIKey"]
	loaded.PluginID = strings.TrimSpace(loaded.PluginID)
	if envPluginID := strings.TrimSpace(os.Getenv("PI_PLUGIN_ID")); envPluginID != "" {
		loaded.PluginID = envPluginID
	}
	if loaded.PluginID == "" {
		loaded.PluginID = ID()
	}

	return loaded
}

// normalizeModels trims and dedupes model entries, normalizes their per-model
// protocol and thinking settings, and guarantees exactly one default entry
// when the list is non-empty.
func normalizeModels(models []modelSettings) []modelSettings {
	normalized := make([]modelSettings, 0, len(models))
	seen := map[string]bool{}
	defaultIndex := -1
	for _, model := range models {
		model.ID = strings.TrimSpace(model.ID)
		if model.ID == "" || seen[model.ID] {
			continue
		}
		seen[model.ID] = true
		model.Name = strings.TrimSpace(model.Name)
		model.Protocol = normalizeOpenAIProtocol(model.Protocol)
		model.ThinkingLevel = normalizeThinkingLevel(model.ThinkingLevel)
		model.ThinkingFormat = normalizeThinkingFormat(model.ThinkingFormat)
		model.ContextWindow, model.MaxOutputTokens = normalizeModelLimits(model.ContextWindow, model.MaxOutputTokens)
		if model.Default && defaultIndex == -1 {
			defaultIndex = len(normalized)
		}
		model.Default = false
		normalized = append(normalized, model)
	}
	if len(normalized) == 0 {
		return nil
	}
	if defaultIndex == -1 {
		defaultIndex = 0
	}
	normalized[defaultIndex].Default = true
	return normalized
}

// normalizeModelLimits applies defaults and keeps the output budget within half
// of the context window so compaction always has room for history.
func normalizeModelLimits(contextWindow, maxOutputTokens flexibleInt) (flexibleInt, flexibleInt) {
	if contextWindow <= 0 {
		contextWindow = defaultContextWindow
	}
	contextWindow = min(max(contextWindow, minContextWindow), maxContextWindow)
	if maxOutputTokens <= 0 {
		maxOutputTokens = defaultMaxOutputTokens
	}
	maxOutputTokens = min(max(maxOutputTokens, minMaxOutputTokens), contextWindow/2)
	return contextWindow, maxOutputTokens
}

// clampRequestMaxTokens sets the request output budget, bounded by the model's configured maximum.
func clampRequestMaxTokens(requested *int, model modelSettings) *int {
	limit := int(model.MaxOutputTokens)
	if limit <= 0 {
		limit = defaultMaxOutputTokens
	}
	if requested == nil || *requested <= 0 || *requested > limit {
		return &limit
	}
	return requested
}

func (a *App) defaultModelSettings() (modelSettings, bool) {
	for _, model := range a.settings.Models {
		if model.Default {
			return model, true
		}
	}
	return modelSettings{}, false
}

// resolveRequestModel maps a client-provided model ID onto the configured
// model list. An empty ID selects the default model; unknown IDs are rejected.
func (a *App) resolveRequestModel(id string) (modelSettings, error) {
	if len(a.settings.Models) == 0 {
		return modelSettings{}, errors.New("no assistant models are configured")
	}
	id = strings.TrimSpace(id)
	if id == "" {
		model, ok := a.defaultModelSettings()
		if !ok {
			return modelSettings{}, errors.New("no default assistant model is configured")
		}
		return model, nil
	}
	for _, model := range a.settings.Models {
		if model.ID == id {
			return model, nil
		}
	}
	return modelSettings{}, fmt.Errorf("model %q is not configured", id)
}

func normalizeOpenAIProtocol(value string) string {
	switch value {
	case openAIProtocolChatCompletions, openAIProtocolResponses:
		return value
	default:
		return openAIProtocolAuto
	}
}

func normalizeThinkingLevel(value string) string {
	switch value {
	case thinkingLevelLow, thinkingLevelMedium, thinkingLevelHigh, thinkingLevelXHigh:
		return value
	default:
		return thinkingLevelOff
	}
}

func normalizeThinkingFormat(value string) string {
	switch value {
	case thinkingFormatQwen, thinkingFormatQwenChatTemplate:
		return value
	default:
		return thinkingFormatOpenAI
	}
}
