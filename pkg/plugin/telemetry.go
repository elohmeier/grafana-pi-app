package plugin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
)

const (
	maxTelemetryRequestBytes = 512 * 1024
	maxTelemetryEvents       = 100
)

func (a *App) handleTelemetryEvents(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var body api.TelemetryRequest
	decoder := json.NewDecoder(io.LimitReader(req.Body, maxTelemetryRequestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}
	if len(body.Events) > maxTelemetryEvents {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("too many telemetry events: max %d", maxTelemetryEvents))
		return
	}

	for _, event := range body.Events {
		recordAssistantTelemetryEvent(event)
	}

	writeJSON(w, http.StatusOK, api.TelemetryResponse{Accepted: len(body.Events)})
}

func recordAssistantTelemetryEvent(event api.TelemetryEvent) {
	eventType := metricLabel(event.Type, metricUnknownLabel)
	assistantTelemetryEventsTotal.WithLabelValues(eventType).Inc()

	switch eventType {
	case "prompt_start":
		assistantPromptsTotal.Inc()
		observePositive(assistantPromptBytes, event.PromptBytes)
		observePositive(assistantPromptContextBytes, event.ContextBytes)
		assistantPromptContextMessages.Observe(float64(maxInt(event.ContextMessageCount, 0)))
		assistantPromptTools.Observe(float64(maxInt(event.ToolCount, 0)))
		assistantPromptActiveSkills.Observe(float64(maxInt(len(event.Skills), 0)))
		recordSkillUsage(event.Skills)
	case "qol_timing":
		phase := metricLabel(event.Phase, metricUnknownLabel)
		if event.DurationMs >= 0 {
			assistantUserWaitDuration.WithLabelValues(phase).Observe(event.DurationMs / float64(time.Second/time.Millisecond))
		}
	case "agent_end":
		status := metricStatus(event.Status, "completed")
		assistantAgentRunsTotal.WithLabelValues(status).Inc()
		observeDuration(assistantAgentRunDuration, []string{status}, event.DurationMs)
		if event.MessageCount > 0 {
			assistantAgentRunMessages.WithLabelValues(status).Observe(float64(event.MessageCount))
		}
	case "message_end":
		role := metricLabel(event.MessageRole, metricUnknownLabel)
		stopReason := metricReason(event.StopReason)
		assistantMessagesTotal.WithLabelValues(role, stopReason).Inc()
		observePositive(assistantMessageContentBytes.WithLabelValues(role, stopReason), event.ContentBytes)
		recordAssistantUsage(assistantMessageTokensTotal, event.Usage)
	case "turn_end":
		assistantToolResultsPerTurn.Observe(float64(maxInt(event.ToolResultCount, 0)))
	case "tool_execution_start":
		toolName := metricLabel(event.ToolName, metricUnknownLabel)
		assistantToolCallsTotal.WithLabelValues(toolName, "started").Inc()
		observePositive(assistantToolCallArgsBytes.WithLabelValues(toolName), event.ArgsBytes)
	case "tool_execution_update":
		toolName := metricLabel(event.ToolName, metricUnknownLabel)
		assistantToolCallUpdatesTotal.WithLabelValues(toolName).Inc()
	case "tool_execution_end":
		toolName := metricLabel(event.ToolName, metricUnknownLabel)
		status := metricStatus(event.Status, "completed")
		assistantToolCallsTotal.WithLabelValues(toolName, status).Inc()
		observeDuration(assistantToolCallDuration, []string{toolName, status}, event.DurationMs)
		observePositive(assistantToolCallArgsBytes.WithLabelValues(toolName), event.ArgsBytes)
		observePositive(assistantToolCallResultBytes.WithLabelValues(toolName, status), event.ResultBytes)
	}
}

func recordSkillUsage(skills []api.TelemetrySkill) {
	for _, skill := range skills {
		id := metricLabel(skill.ID, skill.Name)
		name := metricLabel(skill.Name, metricUnknownLabel)
		source := metricLabel(skill.Source, "bundled")
		activation := metricLabel(skill.Activation, metricUnknownLabel)
		assistantSkillUsageTotal.WithLabelValues(id, name, source, activation).Inc()
	}
}

func recordAssistantUsage(counter *prometheus.CounterVec, usage api.TelemetryUsage) {
	addTokenCounter(counter, "input", usage.Input)
	addTokenCounter(counter, "output", usage.Output)
	addTokenCounter(counter, "cache_read", usage.CacheRead)
	addTokenCounter(counter, "cache_write", usage.CacheWrite)
	addTokenCounter(counter, "total", usage.TotalTokens)
}

func recordLLMRequestMetrics(status string, reason string, model string, duration time.Duration, usage proxyUsage) {
	status = metricStatus(status, "failed")
	reason = metricReason(reason)
	model = metricLabel(model, metricUnknownLabel)
	assistantLLMRequestsTotal.WithLabelValues(status, reason, model).Inc()
	assistantLLMRequestDuration.WithLabelValues(status, reason, model).Observe(duration.Seconds())
	addTokenCounter(assistantLLMTokensTotal, "input", usage.Input)
	addTokenCounter(assistantLLMTokensTotal, "output", usage.Output)
	addTokenCounter(assistantLLMTokensTotal, "cache_read", usage.CacheRead)
	addTokenCounter(assistantLLMTokensTotal, "cache_write", usage.CacheWrite)
	addTokenCounter(assistantLLMTokensTotal, "total", usage.TotalTokens)
}

func recordLLMToolProposal(toolName string) {
	assistantLLMToolProposalsTotal.WithLabelValues(metricLabel(toolName, metricUnknownLabel)).Inc()
}

func maxInt(value int, minimum int) int {
	if value < minimum {
		return minimum
	}
	return value
}
