package plugin

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

type proxyStreamRequest struct {
	Model   proxyModel   `json:"model"`
	Context proxyContext `json:"context"`
	Options proxyOptions `json:"options"`
}

type proxyModel struct {
	ID string `json:"id"`
}

type proxyOptions struct {
	Temperature *float64 `json:"temperature,omitempty"`
	MaxTokens   *int     `json:"maxTokens,omitempty"`
	Reasoning   string   `json:"reasoning,omitempty"`
}

type proxyContext struct {
	SystemPrompt string         `json:"systemPrompt,omitempty"`
	Messages     []proxyMessage `json:"messages"`
	Tools        []proxyTool    `json:"tools,omitempty"`
}

type proxyMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	ToolCallID string          `json:"toolCallId,omitempty"`
	ToolName   string          `json:"toolName,omitempty"`
	IsError    bool            `json:"isError,omitempty"`
	// System messages of a Pi transcript: named prompt sections (null removes
	// one) and changes to the tool set.
	Sections     promptSections `json:"sections,omitempty"`
	ToolsAdded   []proxyTool    `json:"toolsAdded,omitempty"`
	ToolsRemoved []proxyToolRef `json:"toolsRemoved,omitempty"`
}

// promptSections keeps the order in which a system message declares its
// sections; a nil value removes the section.
type promptSections []promptSection

type promptSection struct {
	name  string
	value *string
}

func (s *promptSections) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if token == nil {
		*s = nil
		return nil
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return errors.New("sections must be an object")
	}
	var sections promptSections
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return err
		}
		var value *string
		if err := decoder.Decode(&value); err != nil {
			return err
		}
		sections = append(sections, promptSection{name: key.(string), value: value})
	}
	*s = sections
	return nil
}

type proxyToolRef struct {
	Name string `json:"name"`
}

type proxyTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type openAIChatRequest struct {
	Thinking           *openAIThinking           `json:"thinking,omitempty"`
	Model              string                    `json:"model"`
	Messages           []openAIMessage           `json:"messages"`
	Tools              []openAITool              `json:"tools,omitempty"`
	Stream             bool                      `json:"stream"`
	StreamOptions      map[string]bool           `json:"stream_options,omitempty"`
	Temperature        *float64                  `json:"temperature,omitempty"`
	MaxTokens          *int                      `json:"max_tokens,omitempty"`
	ReasoningEffort    string                    `json:"reasoning_effort,omitempty"`
	EnableThinking     *bool                     `json:"enable_thinking,omitempty"`
	ChatTemplateKwargs *openAIChatTemplateKwargs `json:"chat_template_kwargs,omitempty"`
}

type openAIThinking struct {
	Type string `json:"type"`
}

type openAIChatTemplateKwargs struct {
	EnableThinking bool `json:"enable_thinking"`
}

type openAIMessage struct {
	ReasoningContent *string          `json:"reasoning_content,omitempty"`
	Role             string           `json:"role"`
	Content          string           `json:"content"`
	ToolCalls        []openAIToolCall `json:"tool_calls,omitempty"`
	ToolCallID       string           `json:"tool_call_id,omitempty"`
	Name             string           `json:"name,omitempty"`
}

type openAITool struct {
	Type     string         `json:"type"`
	Function openAIFunction `json:"function"`
}

type openAIFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters"`
}

type openAIToolCall struct {
	ID       string             `json:"id"`
	Type     string             `json:"type"`
	Function openAIToolFunction `json:"function"`
}

type openAIToolFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type openAIStreamChunk struct {
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			Reasoning        string `json:"reasoning"`
			ReasoningContent string `json:"reasoning_content"`
			ReasoningText    string `json:"reasoning_text"`
			ToolCalls        []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *openAIUsage    `json:"usage,omitempty"`
	Error json.RawMessage `json:"error,omitempty"`
}

type openAIUsage struct {
	PromptTokens        int `json:"prompt_tokens"`
	CompletionTokens    int `json:"completion_tokens"`
	TotalTokens         int `json:"total_tokens"`
	PromptTokensDetails struct {
		CachedTokens     int `json:"cached_tokens"`
		CacheWriteTokens int `json:"cache_write_tokens"`
	} `json:"prompt_tokens_details"`
	CompletionTokensDetails struct {
		ReasoningTokens *int `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

type proxyUsage struct {
	Reported        bool           `json:"reported"`
	ReasoningTokens *int           `json:"reasoningTokens,omitempty"`
	Input           int            `json:"input"`
	Output          int            `json:"output"`
	CacheRead       int            `json:"cacheRead"`
	CacheWrite      int            `json:"cacheWrite"`
	TotalTokens     int            `json:"totalTokens"`
	Cost            map[string]int `json:"cost"`
}

type streamedToolCall struct {
	contentIndex int
	started      bool
	id           string
	name         string
	arguments    strings.Builder
}

var errOpenAIStreamDone = errors.New("openai stream done")

func (a *App) handleLLMStream(w http.ResponseWriter, req *http.Request) {
	startedAt := time.Now()
	status := "failed"
	reason := "error"
	modelID := ""
	usage := zeroUsage()
	assistantLLMRequestsInFlight.Inc()
	defer func() {
		assistantLLMRequestsInFlight.Dec()
		recordLLMRequestMetrics(status, reason, modelID, time.Since(startedAt), usage)
	}()

	if req.Method != http.MethodPost {
		reason = "method_not_allowed"
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if a.settings.OpenAIAPIKey == "" {
		reason = "bad_request"
		writeJSONError(w, http.StatusBadRequest, "OpenAI-compatible API key is not configured")
		return
	}

	var body proxyStreamRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		reason = "bad_request"
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("invalid request body: %s", err))
		return
	}

	body.Context = collapseSystemMessages(body.Context)

	model, err := a.resolveRequestModel(body.Model.ID)
	if err != nil {
		reason = "bad_request"
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	modelID = model.ID
	body.Options.MaxTokens = clampRequestMaxTokens(body.Options.MaxTokens, model)

	// fail ends the stream with an error, or as aborted when the client went away.
	fail := func(stream proxyEventWriter, err error) {
		if req.Context().Err() != nil {
			status, reason = "aborted", "aborted"
			event := errorEvent("request aborted")
			event["reason"] = "aborted"
			_ = stream.write(event)
			return
		}
		_ = stream.write(errorEvent(err.Error()))
	}

	protocol := a.openAIProtocolForRequest(model)
	upstreamRes, err := a.doOpenAIUpstreamRequest(req.Context(), body, model, protocol)
	if err != nil {
		fail(startProxyStream(w), err)
		return
	}

	var upstreamError []byte
	if normalizeOpenAIProtocol(model.Protocol) == openAIProtocolAuto && protocol == openAIProtocolChatCompletions && !isHTTPSuccess(upstreamRes.StatusCode) {
		upstreamError, _ = io.ReadAll(io.LimitReader(upstreamRes.Body, 32_768))
		_ = upstreamRes.Body.Close()
		if shouldRetryWithResponses(upstreamRes.StatusCode, upstreamError) {
			protocol = openAIProtocolResponses
			a.rememberOpenAIProtocol(model, protocol)
			upstreamRes, err = a.doOpenAIUpstreamRequest(req.Context(), body, model, protocol)
			upstreamError = nil
			if err != nil {
				fail(startProxyStream(w), err)
				return
			}
		}
	}
	defer func() {
		_ = upstreamRes.Body.Close()
	}()

	stream := startProxyStream(w)

	if !isHTTPSuccess(upstreamRes.StatusCode) {
		reason = "upstream_error"
		if upstreamError == nil {
			upstreamError, _ = io.ReadAll(io.LimitReader(upstreamRes.Body, 32_768))
		}
		event := errorEvent(string(upstreamError))
		event["upstreamStatus"] = upstreamRes.StatusCode
		_ = stream.write(event)
		return
	}

	var relayErr error
	if protocol == openAIProtocolResponses {
		usage, reason, relayErr = a.relayOpenAIResponsesStream(upstreamRes.Body, stream)
	} else {
		usage, reason, relayErr = a.relayOpenAIChatStream(upstreamRes.Body, stream)
	}
	if relayErr != nil {
		fail(stream, relayErr)
		return
	}
	status = "completed"
}

// collapseSystemMessages replays the system messages of a Pi transcript into
// the system prompt and tool list, as Pi's getCurrentSystemMessage does: the
// contents are joined in order, sections are patched by name and rendered
// after the content, and tools follow toolsRemoved/toolsAdded. The upstream
// APIs get one leading prompt; later system messages are dropped in place,
// because local chat templates reject system messages after the first turn.
// A legacy request with systemPrompt and tools counts as a leading message.
func collapseSystemMessages(transcript proxyContext) proxyContext {
	var contents []string
	var sectionOrder []string
	sections := map[string]string{}
	var toolOrder []string
	tools := map[string]proxyTool{}
	addTools := func(added []proxyTool) {
		for _, tool := range added {
			if _, ok := tools[tool.Name]; !ok {
				toolOrder = append(toolOrder, tool.Name)
			}
			tools[tool.Name] = tool
		}
	}
	removeTool := func(name string) {
		if _, ok := tools[name]; !ok {
			return
		}
		delete(tools, name)
		for i, existing := range toolOrder {
			if existing == name {
				toolOrder = append(toolOrder[:i], toolOrder[i+1:]...)
				break
			}
		}
	}

	if transcript.SystemPrompt != "" {
		contents = append(contents, transcript.SystemPrompt)
	}
	addTools(transcript.Tools)
	messages := make([]proxyMessage, 0, len(transcript.Messages))
	for _, message := range transcript.Messages {
		if message.Role != "system" {
			messages = append(messages, message)
			continue
		}
		if text := contentText(message.Content); text != "" {
			contents = append(contents, text)
		}
		for _, section := range message.Sections {
			if section.value == nil {
				delete(sections, section.name)
				continue
			}
			if _, ok := sections[section.name]; !ok {
				sectionOrder = append(sectionOrder, section.name)
			}
			sections[section.name] = *section.value
		}
		for _, tool := range message.ToolsRemoved {
			removeTool(tool.Name)
		}
		addTools(message.ToolsAdded)
	}

	parts := make([]string, 0, 1+len(sectionOrder))
	if joined := strings.Join(contents, "\n\n"); joined != "" {
		parts = append(parts, joined)
	}
	for _, name := range sectionOrder {
		if value, ok := sections[name]; ok && value != "" {
			parts = append(parts, value)
		}
	}
	resolvedTools := make([]proxyTool, 0, len(toolOrder))
	for _, name := range toolOrder {
		resolvedTools = append(resolvedTools, tools[name])
	}
	return proxyContext{
		SystemPrompt: strings.Join(parts, "\n\n"),
		Messages:     messages,
		Tools:        resolvedTools,
	}
}

func (a *App) buildOpenAIChatRequest(req proxyStreamRequest, model modelSettings) openAIChatRequest {
	messages := make([]openAIMessage, 0, len(req.Context.Messages)+1)
	if systemPrompt := a.effectiveSystemPrompt(req.Context.SystemPrompt); systemPrompt != "" {
		messages = append(messages, openAIMessage{
			Role:    "system",
			Content: systemPrompt,
		})
	}
	for _, message := range req.Context.Messages {
		converted := convertMessage(message)
		if converted.Role == "assistant" && model.ThinkingFormat == thinkingFormatDeepSeek {
			var blocks []struct {
				Type     string `json:"type"`
				Thinking string `json:"thinking"`
			}
			_ = json.Unmarshal(message.Content, &blocks)
			var reasoning strings.Builder
			for _, block := range blocks {
				if block.Type == "thinking" {
					reasoning.WriteString(block.Thinking)
				}
			}
			content := reasoning.String()
			converted.ReasoningContent = &content
		}
		if converted.Role != "" {
			messages = append(messages, converted)
		}
	}

	tools := make([]openAITool, 0, len(req.Context.Tools))
	for _, tool := range req.Context.Tools {
		tools = append(tools, openAITool{
			Type:     "function",
			Function: openAIFunction(tool),
		})
	}

	payload := openAIChatRequest{
		Model:         model.ID,
		Messages:      messages,
		Tools:         tools,
		Stream:        true,
		StreamOptions: map[string]bool{"include_usage": true},
		Temperature:   req.Options.Temperature,
		MaxTokens:     req.Options.MaxTokens,
	}
	applyThinkingOptions(&payload, model, req.Options.Reasoning)
	return payload
}

func applyThinkingOptions(payload *openAIChatRequest, model modelSettings, requestedLevel string) {
	level := effectiveThinkingLevel(model, requestedLevel)
	if model.ThinkingFormat == thinkingFormatDeepSeek {
		payload.Thinking = &openAIThinking{Type: "disabled"}
		if level != thinkingLevelOff {
			payload.Thinking.Type = "enabled"
		}
	}
	if level == thinkingLevelOff {
		return
	}

	switch normalizeThinkingFormat(model.ThinkingFormat) {
	case thinkingFormatQwen:
		payload.EnableThinking = boolPtr(true)
	case thinkingFormatQwenChatTemplate:
		payload.ChatTemplateKwargs = &openAIChatTemplateKwargs{EnableThinking: true}
	default:
		payload.ReasoningEffort = level
	}
}

func effectiveThinkingLevel(model modelSettings, requestedLevel string) string {
	if normalizeThinkingLevel(model.ThinkingLevel) == thinkingLevelOff {
		return thinkingLevelOff
	}
	return normalizeThinkingLevel(requestedLevel)
}

func (a *App) effectiveSystemPrompt(systemPrompt string) string {
	systemPrompt = strings.TrimSpace(systemPrompt)
	addendum := strings.TrimSpace(a.settings.SystemPromptAddendum)
	if addendum == "" {
		return systemPrompt
	}
	if systemPrompt == "" {
		return "## Instance instructions\n" + addendum
	}
	return systemPrompt + "\n\n## Instance instructions\n" + addendum
}

func (a *App) relayOpenAIChatStream(body io.Reader, stream proxyEventWriter) (proxyUsage, string, error) {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	nextContentIndex := 0
	textStarted := false
	textIndex := -1
	thinkingStarted := false
	thinkingIndex := -1
	toolCalls := map[int]*streamedToolCall{}
	usage := zeroUsage()
	doneReason := "stop"
	finished := false
	dataLines := make([]string, 0, 4)

	processData := func(data string) error {
		data = strings.TrimSpace(data)
		if data == "" {
			return nil
		}
		if data == "[DONE]" {
			finished = true
			return errOpenAIStreamDone
		}

		var chunk openAIStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return fmt.Errorf("invalid upstream stream chunk: %w", err)
		}
		if message := upstreamStreamError(chunk.Error); message != "" {
			return fmt.Errorf("upstream error: %s", message)
		}
		if chunk.Usage != nil {
			usage = usageFromOpenAI(chunk.Usage)
		}

		for _, choice := range chunk.Choices {
			if choice.FinishReason != "" {
				finished = true
			}
			if choice.FinishReason == "length" {
				doneReason = "length"
			}
			if choice.FinishReason == "tool_calls" {
				doneReason = "toolUse"
			}

			if choice.Delta.Content != "" {
				if !textStarted {
					textStarted = true
					textIndex = nextContentIndex
					nextContentIndex++
					if err := stream.write(map[string]interface{}{"type": "text_start", "contentIndex": textIndex}); err != nil {
						return err
					}
				}
				if err := stream.write(map[string]interface{}{"type": "text_delta", "contentIndex": textIndex, "delta": choice.Delta.Content}); err != nil {
					return err
				}
			}

			if delta := reasoningDelta(choice.Delta.ReasoningContent, choice.Delta.Reasoning, choice.Delta.ReasoningText); delta != "" {
				if !thinkingStarted {
					thinkingStarted = true
					thinkingIndex = nextContentIndex
					nextContentIndex++
					if err := stream.write(map[string]interface{}{"type": "thinking_start", "contentIndex": thinkingIndex}); err != nil {
						return err
					}
				}
				if err := stream.write(map[string]interface{}{"type": "thinking_delta", "contentIndex": thinkingIndex, "delta": delta}); err != nil {
					return err
				}
			}

			for _, delta := range choice.Delta.ToolCalls {
				state := toolCalls[delta.Index]
				if state == nil {
					state = &streamedToolCall{contentIndex: nextContentIndex}
					nextContentIndex++
					toolCalls[delta.Index] = state
				}
				if delta.ID != "" {
					state.id = delta.ID
				}
				if delta.Function.Name != "" {
					state.name = delta.Function.Name
				}
				if !state.started && state.name != "" {
					state.started = true
					if state.id == "" {
						state.id = fmt.Sprintf("call_%d", delta.Index)
					}
					if err := stream.write(map[string]interface{}{
						"type":         "toolcall_start",
						"contentIndex": state.contentIndex,
						"id":           state.id,
						"toolName":     state.name,
					}); err != nil {
						return err
					}
					recordLLMToolProposal(state.name)
					if state.arguments.Len() > 0 {
						if err := stream.write(map[string]interface{}{
							"type":         "toolcall_delta",
							"contentIndex": state.contentIndex,
							"delta":        state.arguments.String(),
						}); err != nil {
							return err
						}
					}
					doneReason = "toolUse"
				}
				if delta.Function.Arguments != "" {
					state.arguments.WriteString(delta.Function.Arguments)
					if state.started {
						if err := stream.write(map[string]interface{}{
							"type":         "toolcall_delta",
							"contentIndex": state.contentIndex,
							"delta":        delta.Function.Arguments,
						}); err != nil {
							return err
						}
					}
				}
			}
		}
		return nil
	}

	flushData := func() error {
		if len(dataLines) == 0 {
			return nil
		}
		data := strings.Join(dataLines, "\n")
		dataLines = dataLines[:0]
		return processData(data)
	}

	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" {
			if err := flushData(); err != nil {
				if errors.Is(err, errOpenAIStreamDone) {
					break
				}
				return usage, "error", err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		if data, ok := strings.CutPrefix(line, "data:"); ok {
			dataLines = append(dataLines, strings.TrimPrefix(data, " "))
		}
	}

	if err := scanner.Err(); err != nil {
		return usage, "error", err
	}
	if err := flushData(); err != nil && !errors.Is(err, errOpenAIStreamDone) {
		return usage, "error", err
	}
	if !finished {
		return usage, "error", errors.New("upstream stream ended before a finish reason")
	}
	if textStarted {
		if err := stream.write(map[string]interface{}{"type": "text_end", "contentIndex": textIndex}); err != nil {
			return usage, "error", err
		}
	}
	if thinkingStarted {
		if err := stream.write(map[string]interface{}{"type": "thinking_end", "contentIndex": thinkingIndex}); err != nil {
			return usage, "error", err
		}
	}
	toolCallIndexes := make([]int, 0, len(toolCalls))
	for index := range toolCalls {
		toolCallIndexes = append(toolCallIndexes, index)
	}
	sort.Ints(toolCallIndexes)
	for _, index := range toolCallIndexes {
		state := toolCalls[index]
		if !state.started {
			return usage, "error", errors.New("upstream returned a tool call without a function name")
		}
		if err := stream.write(toolCallEndEvent(state.contentIndex, state.id, state.name, state.arguments.String())); err != nil {
			return usage, "error", err
		}
	}

	if err := stream.write(map[string]interface{}{"type": "done", "reason": doneReason, "usage": usage}); err != nil {
		return usage, "error", err
	}
	return usage, doneReason, nil
}

// toolCallEndEvent ends a streamed tool call. It carries the complete call so
// Pi does not have to rely on its partial-JSON parse; arguments that are not a
// JSON object are left to the client, which reports them to the model.
func toolCallEndEvent(contentIndex int, id string, name string, arguments string) map[string]interface{} {
	event := map[string]interface{}{"type": "toolcall_end", "contentIndex": contentIndex}
	if strings.TrimSpace(arguments) == "" {
		arguments = "{}"
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(arguments), &parsed); err == nil && parsed != nil {
		event["toolCall"] = map[string]any{"type": "toolCall", "id": id, "name": name, "arguments": parsed}
	}
	return event
}

// upstreamStreamError returns the message of an error object or string that
// OpenAI-compatible servers put into a stream chunk instead of choices.
func upstreamStreamError(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var message string
	if err := json.Unmarshal(raw, &message); err == nil {
		return strings.TrimSpace(message)
	}
	var envelope openAIResponsesError
	if err := json.Unmarshal(raw, &envelope); err == nil && strings.TrimSpace(envelope.Message) != "" {
		return strings.TrimSpace(envelope.Message)
	}
	return string(raw)
}

func reasoningDelta(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func convertMessage(message proxyMessage) openAIMessage {
	switch message.Role {
	case "user":
		return openAIMessage{Role: "user", Content: nonEmptyContent(message.Content, " ")}
	case "assistant":
		text, toolCalls := assistantContent(message.Content)
		return openAIMessage{Role: "assistant", Content: text, ToolCalls: toolCalls}
	case "toolResult":
		return openAIMessage{
			Role:       "tool",
			ToolCallID: chatToolCallID(message.ToolCallID),
			Name:       message.ToolName,
			Content:    toolResultContent(message),
		}
	default:
		return openAIMessage{}
	}
}

func toolResultContent(message proxyMessage) string {
	text := nonEmptyContent(message.Content, "(empty tool result)")
	if !message.IsError {
		return text
	}
	name := strings.TrimSpace(message.ToolName)
	if name == "" {
		name = "tool"
	}
	return fmt.Sprintf("TOOL ERROR [%s]: %s", name, text)
}

func nonEmptyContent(raw json.RawMessage, fallback string) string {
	text := contentText(raw)
	if strings.TrimSpace(text) == "" {
		return fallback
	}
	return text
}

func contentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}

	var blocks []map[string]interface{}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return string(raw)
	}

	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if block["type"] == "text" {
			if value, ok := block["text"].(string); ok {
				parts = append(parts, value)
			}
		}
	}
	return strings.Join(parts, "\n")
}

func assistantContent(raw json.RawMessage) (string, []openAIToolCall) {
	if len(raw) == 0 {
		return "", nil
	}

	var blocks []map[string]interface{}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return contentText(raw), nil
	}

	textParts := make([]string, 0, len(blocks))
	toolCalls := make([]openAIToolCall, 0)
	for _, block := range blocks {
		switch block["type"] {
		case "text":
			if value, ok := block["text"].(string); ok {
				textParts = append(textParts, value)
			}
		case "toolCall":
			name, _ := block["name"].(string)
			id, _ := block["id"].(string)
			args, _ := json.Marshal(block["arguments"])
			toolCalls = append(toolCalls, openAIToolCall{
				ID:   chatToolCallID(id),
				Type: "function",
				Function: openAIToolFunction{
					Name:      name,
					Arguments: string(args),
				},
			})
		}
	}
	return strings.Join(textParts, "\n"), toolCalls
}

// chatToolCallID drops the Responses item ID that "call|item" tool-call IDs
// carry, so history written through the Responses API stays valid when a
// later request uses Chat Completions.
func chatToolCallID(id string) string {
	callID, _ := splitResponsesToolCallID(id)
	return callID
}

type proxyEventWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
}

func startProxyStream(w http.ResponseWriter) proxyEventWriter {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	stream := newProxyEventWriter(w, flusher)
	_ = stream.write(map[string]interface{}{"type": "start"})
	return stream
}

func newProxyEventWriter(w http.ResponseWriter, flusher http.Flusher) proxyEventWriter {
	return proxyEventWriter{w: w, flusher: flusher}
}

func (w proxyEventWriter) write(event map[string]interface{}) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w.w, "data: %s\n\n", data); err != nil {
		return err
	}
	if w.flusher != nil {
		w.flusher.Flush()
	}
	return nil
}

func usageFromOpenAI(usage *openAIUsage) proxyUsage {
	if usage == nil {
		return zeroUsage()
	}
	// Cache tokens are subsets of prompt tokens; reasoning is a subset of output.
	input := max(0, usage.PromptTokens-usage.PromptTokensDetails.CachedTokens-usage.PromptTokensDetails.CacheWriteTokens)
	total := usage.TotalTokens
	if total == 0 {
		total = usage.PromptTokens + usage.CompletionTokens
	}
	return proxyUsage{
		Reported:        true,
		ReasoningTokens: usage.CompletionTokensDetails.ReasoningTokens,
		Input:           input,
		Output:          usage.CompletionTokens,
		CacheRead:       usage.PromptTokensDetails.CachedTokens,
		CacheWrite:      usage.PromptTokensDetails.CacheWriteTokens,
		TotalTokens:     total,
		Cost:            zeroCost(),
	}
}

func zeroUsage() proxyUsage {
	return proxyUsage{
		Input:       0,
		Output:      0,
		CacheRead:   0,
		CacheWrite:  0,
		TotalTokens: 0,
		Cost:        zeroCost(),
	}
}

func zeroCost() map[string]int {
	return map[string]int{
		"input":      0,
		"output":     0,
		"cacheRead":  0,
		"cacheWrite": 0,
		"total":      0,
	}
}

func boolPtr(value bool) *bool {
	return &value
}

func errorEvent(message string) map[string]interface{} {
	return map[string]interface{}{
		"type":         "error",
		"reason":       "error",
		"errorMessage": message,
		"usage":        zeroUsage(),
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": strings.TrimSpace(message)})
}

// registerRoutes takes a *http.ServeMux and registers HTTP handlers.
func (a *App) registerRoutes(mux *http.ServeMux) {
	a.registerChatRoutes(mux)
	mux.HandleFunc("/llm/stream", a.withAppAccess(a.handleLLMStream))
	// streamProxy appends /api/stream to proxyUrl; keep this alias so the frontend
	// can use Pi's client-side proxy stream implementation unchanged.
	mux.HandleFunc("/llm/api/stream", a.withAppAccess(a.handleLLMStream))
	mux.HandleFunc("/telemetry/events", a.withAppAccess(a.handleTelemetryEvents))
	mux.HandleFunc("/jsonnet/eval", a.withAppAccess(a.handleJsonnetEval))
	mux.HandleFunc("/jsonnet/fix", a.withAppAccess(a.handleJsonnetFix))
	mux.HandleFunc("/jsonnet-libs/files", a.withAppAccess(a.handleJsonnetLibFiles))
	mux.HandleFunc("/promql/parse", a.withAppAccess(a.handlePromQLParse))
}
