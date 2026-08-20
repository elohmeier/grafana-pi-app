package plugin

import (
	"regexp"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

const metricUnknownLabel = "unknown"

var metricLabelPattern = regexp.MustCompile(`^[A-Za-z0-9_.:/-]{1,128}$`)

var (
	assistantTelemetryEventsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "telemetry_events_total",
			Help:      "Total number of assistant telemetry events accepted by the plugin backend.",
		},
		[]string{"event_type"},
	)
	assistantPromptsTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "prompts_total",
			Help:      "Total number of assistant prompts submitted.",
		},
	)
	assistantPromptBytes = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "prompt_bytes",
			Help:      "Approximate assistant prompt size in bytes.",
			Buckets:   prometheus.ExponentialBuckets(128, 2, 14),
		},
	)
	assistantPromptContextBytes = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "prompt_context_bytes",
			Help:      "Approximate context size in bytes at prompt submission time.",
			Buckets:   prometheus.ExponentialBuckets(1024, 2, 16),
		},
	)
	assistantPromptContextMessages = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "prompt_context_messages",
			Help:      "Number of transcript messages present at prompt submission time.",
			Buckets:   []float64{0, 1, 2, 4, 8, 16, 32, 64, 128},
		},
	)
	assistantPromptTools = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "prompt_tools",
			Help:      "Number of tools available to the assistant at prompt submission time.",
			Buckets:   []float64{0, 1, 2, 4, 8, 16, 32, 64, 128},
		},
	)
	assistantPromptActiveSkills = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "prompt_active_skills",
			Help:      "Number of active skills selected for one assistant prompt.",
			Buckets:   []float64{0, 1, 2, 4, 8, 16, 32},
		},
	)
	assistantSkillUsageTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "skill_usage_total",
			Help:      "Total assistant prompts that activated a skill.",
		},
		[]string{"skill_id", "skill_name", "source", "activation"},
	)
	assistantUserWaitDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "user_wait_duration_seconds",
			Help:      "User-perceived wait duration from prompt submission to assistant milestones.",
			Buckets:   []float64{0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600},
		},
		[]string{"phase"},
	)
	assistantAgentRunsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "agent_runs_total",
			Help:      "Total number of assistant agent runs completed.",
		},
		[]string{"status"},
	)
	assistantAgentRunDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "agent_run_duration_seconds",
			Help:      "Assistant agent run duration in seconds.",
			Buckets:   []float64{0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600},
		},
		[]string{"status"},
	)
	assistantAgentRunMessages = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "agent_run_messages",
			Help:      "Number of transcript messages at agent run completion.",
			Buckets:   []float64{1, 2, 4, 8, 16, 32, 64, 128, 256},
		},
		[]string{"status"},
	)
	assistantMessagesTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "messages_total",
			Help:      "Total assistant transcript messages completed.",
		},
		[]string{"role", "stop_reason"},
	)
	assistantMessageTokensTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "message_tokens_total",
			Help:      "Total model token usage reported by completed assistant messages.",
		},
		[]string{"type"},
	)
	assistantMessageContentBytes = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "message_content_bytes",
			Help:      "Approximate completed message content size in bytes.",
			Buckets:   prometheus.ExponentialBuckets(64, 2, 14),
		},
		[]string{"role", "stop_reason"},
	)
	assistantToolResultsPerTurn = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "tool_results_per_turn",
			Help:      "Number of tool result messages emitted at assistant turn end.",
			Buckets:   []float64{0, 1, 2, 4, 8, 16, 32},
		},
	)
	assistantToolCallsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "tool_calls_total",
			Help:      "Total assistant tool calls by tool and status.",
		},
		[]string{"tool_name", "status"},
	)
	assistantToolCallUpdatesTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "tool_call_updates_total",
			Help:      "Total partial tool execution updates by tool.",
		},
		[]string{"tool_name"},
	)
	assistantToolCallDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "tool_call_duration_seconds",
			Help:      "Tool call execution duration in seconds.",
			Buckets:   []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120},
		},
		[]string{"tool_name", "status"},
	)
	assistantToolCallArgsBytes = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "tool_call_args_bytes",
			Help:      "Approximate serialized tool argument size in bytes.",
			Buckets:   prometheus.ExponentialBuckets(32, 2, 14),
		},
		[]string{"tool_name"},
	)
	assistantToolCallResultBytes = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "tool_call_result_bytes",
			Help:      "Approximate serialized tool result size in bytes.",
			Buckets:   prometheus.ExponentialBuckets(64, 2, 16),
		},
		[]string{"tool_name", "status"},
	)
	assistantNestedToolCallsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "nested_tool_calls_total",
			Help:      "Total nested tool calls reported by subagent-style tool results.",
		},
		[]string{"parent_tool_name", "nested_tool_name", "status"},
	)
	assistantNestedToolCallsPerParent = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "nested_tool_calls_per_parent",
			Help:      "Nested tool call count reported by one parent tool result.",
			Buckets:   []float64{0, 1, 2, 4, 8, 16, 32, 64},
		},
		[]string{"parent_tool_name", "status"},
	)
	assistantLLMRequestsInFlight = promauto.NewGauge(
		prometheus.GaugeOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "llm_requests_in_flight",
			Help:      "OpenAI-compatible LLM stream requests currently in flight.",
		},
	)
	assistantLLMRequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "llm_requests_total",
			Help:      "Total OpenAI-compatible LLM stream requests by status, terminal reason, and model.",
		},
		[]string{"status", "reason", "model"},
	)
	assistantLLMRequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "llm_request_duration_seconds",
			Help:      "OpenAI-compatible LLM stream request duration in seconds.",
			Buckets:   []float64{0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600},
		},
		[]string{"status", "reason", "model"},
	)
	assistantLLMTokensTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "llm_tokens_total",
			Help:      "Total token usage reported by the OpenAI-compatible LLM stream.",
		},
		[]string{"type"},
	)
	assistantLLMToolProposalsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "grafana_plugin",
			Subsystem: "assistant",
			Name:      "llm_tool_call_proposals_total",
			Help:      "Total tool call proposals emitted by the upstream LLM stream.",
		},
		[]string{"tool_name"},
	)
)

func observeDuration(histogram *prometheus.HistogramVec, labelValues []string, durationMs float64) {
	if durationMs < 0 {
		return
	}
	histogram.WithLabelValues(labelValues...).Observe(durationMs / float64(time.Second/time.Millisecond))
}

func observePositive(histogram prometheus.Observer, value int) {
	if value <= 0 {
		return
	}
	histogram.Observe(float64(value))
}

func addTokenCounter(counter *prometheus.CounterVec, tokenType string, value int) {
	if value <= 0 {
		return
	}
	counter.WithLabelValues(tokenType).Add(float64(value))
}

func metricLabel(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		value = fallback
	}
	if value == "" {
		value = metricUnknownLabel
	}
	if !metricLabelPattern.MatchString(value) {
		return "other"
	}
	return value
}

func metricStatus(value string, fallback string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "started", "running":
		return "started"
	case "completed", "ok", "success", "succeeded":
		return "completed"
	case "failed", "error":
		return "failed"
	case "aborted", "cancelled", "canceled":
		return "aborted"
	default:
		return metricLabel(fallback, metricUnknownLabel)
	}
}

func metricReason(value string) string {
	switch strings.TrimSpace(value) {
	case "stop", "toolUse", "length", "error", "upstream_error", "bad_request", "method_not_allowed", "aborted":
		return value
	default:
		return metricLabel(value, metricUnknownLabel)
	}
}
