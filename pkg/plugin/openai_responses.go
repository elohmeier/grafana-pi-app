package plugin

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
)

type openAIResponsesRequest struct {
	Model           string                    `json:"model"`
	Instructions    string                    `json:"instructions,omitempty"`
	Input           []json.RawMessage         `json:"input"`
	Tools           []openAIResponsesTool     `json:"tools,omitempty"`
	Stream          bool                      `json:"stream"`
	Store           bool                      `json:"store"`
	Temperature     *float64                  `json:"temperature,omitempty"`
	MaxOutputTokens *int                      `json:"max_output_tokens,omitempty"`
	Reasoning       *openAIResponsesReasoning `json:"reasoning,omitempty"`
	Include         []string                  `json:"include,omitempty"`
}

type openAIResponsesReasoning struct {
	Effort  string `json:"effort"`
	Summary string `json:"summary,omitempty"`
}

type openAIResponsesTool struct {
	Type        string          `json:"type"`
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters"`
}

type openAIResponsesContent struct {
	Type        string `json:"type"`
	Text        string `json:"text,omitempty"`
	Refusal     string `json:"refusal,omitempty"`
	Annotations []any  `json:"annotations,omitempty"`
}

type openAIResponsesMessageItem struct {
	Type    string                   `json:"type,omitempty"`
	ID      string                   `json:"id,omitempty"`
	Role    string                   `json:"role"`
	Status  string                   `json:"status,omitempty"`
	Phase   string                   `json:"phase,omitempty"`
	Content []openAIResponsesContent `json:"content"`
}

type openAIResponsesFunctionCallItem struct {
	Type      string `json:"type"`
	ID        string `json:"id,omitempty"`
	CallID    string `json:"call_id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type openAIResponsesFunctionOutputItem struct {
	Type   string `json:"type"`
	CallID string `json:"call_id"`
	Output string `json:"output"`
}

type proxyContentBlock struct {
	Type              string          `json:"type"`
	Text              string          `json:"text,omitempty"`
	Thinking          string          `json:"thinking,omitempty"`
	TextSignature     string          `json:"textSignature,omitempty"`
	ThinkingSignature string          `json:"thinkingSignature,omitempty"`
	ID                string          `json:"id,omitempty"`
	Name              string          `json:"name,omitempty"`
	Arguments         json.RawMessage `json:"arguments,omitempty"`
}

type openAIResponsesStreamEvent struct {
	Type        string          `json:"type"`
	OutputIndex int             `json:"output_index"`
	Delta       string          `json:"delta"`
	Arguments   string          `json:"arguments"`
	Name        string          `json:"name"`
	Code        string          `json:"code"`
	Message     string          `json:"message"`
	Item        json.RawMessage `json:"item"`
	Response    *struct {
		Status            string                `json:"status"`
		Usage             *openAIResponsesUsage `json:"usage"`
		Error             *openAIResponsesError `json:"error"`
		IncompleteDetails *struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details"`
	} `json:"response"`
}

type openAIResponsesOutputItem struct {
	Type      string                   `json:"type"`
	ID        string                   `json:"id"`
	CallID    string                   `json:"call_id"`
	Name      string                   `json:"name"`
	Arguments string                   `json:"arguments"`
	Phase     string                   `json:"phase"`
	Summary   []openAIResponsesContent `json:"summary"`
	Content   []openAIResponsesContent `json:"content"`
}

type openAIResponsesUsage struct {
	InputTokens        int `json:"input_tokens"`
	OutputTokens       int `json:"output_tokens"`
	TotalTokens        int `json:"total_tokens"`
	InputTokensDetails struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"input_tokens_details"`
}

type openAIResponsesError struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Param   string `json:"param"`
	Code    string `json:"code"`
}

type openAIErrorEnvelope struct {
	Error openAIResponsesError `json:"error"`
}

type streamedResponsesItem struct {
	outputIndex  int
	contentIndex int
	kind         string
	started      bool
	ended        bool
	id           string
	callID       string
	name         string
	phase        string
	data         strings.Builder
}

type responseTextSignature struct {
	Version int    `json:"v"`
	ID      string `json:"id"`
	Phase   string `json:"phase,omitempty"`
}

var errOpenAIResponsesStreamDone = errors.New("openai responses stream done")

func (a *App) openAIProtocolForRequest(model modelSettings) string {
	configured := normalizeOpenAIProtocol(model.Protocol)
	if configured != openAIProtocolAuto {
		return configured
	}

	a.llmProtocolMu.RLock()
	resolved := a.resolvedLLMProtocols[model.ID]
	a.llmProtocolMu.RUnlock()
	if resolved == openAIProtocolResponses {
		return resolved
	}
	return openAIProtocolChatCompletions
}

func (a *App) rememberOpenAIProtocol(model modelSettings, protocol string) {
	if normalizeOpenAIProtocol(model.Protocol) != openAIProtocolAuto || protocol != openAIProtocolResponses {
		return
	}
	a.llmProtocolMu.Lock()
	if a.resolvedLLMProtocols == nil {
		a.resolvedLLMProtocols = map[string]string{}
	}
	a.resolvedLLMProtocols[model.ID] = protocol
	a.llmProtocolMu.Unlock()
}

func (a *App) doOpenAIUpstreamRequest(ctx context.Context, req proxyStreamRequest, model modelSettings, protocol string) (*http.Response, error) {
	var payload any
	path := "/chat/completions"
	if protocol == openAIProtocolResponses {
		payload = a.buildOpenAIResponsesRequest(req, model)
		path = "/responses"
	} else {
		payload = a.buildOpenAIChatRequest(req, model)
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode %s request: %w", protocol, err)
	}
	upstreamReq, err := http.NewRequestWithContext(ctx, http.MethodPost, a.settings.OpenAIBaseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	upstreamReq.Header.Set("Authorization", "Bearer "+a.settings.OpenAIAPIKey)
	upstreamReq.Header.Set("Content-Type", "application/json")
	upstreamReq.Header.Set("Accept", "text/event-stream")
	return a.httpClient.Do(upstreamReq)
}

func shouldRetryWithResponses(status int, body []byte) bool {
	if status != http.StatusBadRequest {
		return false
	}
	var envelope openAIErrorEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return false
	}
	errorType := strings.ToLower(strings.TrimSpace(envelope.Error.Type))
	param := strings.ToLower(strings.TrimSpace(envelope.Error.Param))
	message := strings.ToLower(envelope.Error.Message)
	return errorType == "invalid_request_error" &&
		param == "reasoning_effort" &&
		strings.Contains(message, "/v1/responses")
}

func isHTTPSuccess(status int) bool {
	return status >= http.StatusOK && status < http.StatusMultipleChoices
}

func (a *App) buildOpenAIResponsesRequest(req proxyStreamRequest, model modelSettings) openAIResponsesRequest {
	input := make([]json.RawMessage, 0, len(req.Context.Messages)*2)
	messageIndex := 0
	for _, message := range req.Context.Messages {
		switch message.Role {
		case "user":
			input = append(input, marshalResponsesInput(openAIResponsesMessageItem{
				Role: "user",
				Content: []openAIResponsesContent{{
					Type: "input_text",
					Text: nonEmptyContent(message.Content, " "),
				}},
			}))
		case "assistant":
			blocks := responsesContentBlocks(message.Content)
			for _, block := range blocks {
				switch block.Type {
				case "thinking":
					if reasoningItem := validatedReasoningItem(block.ThinkingSignature); reasoningItem != nil {
						input = append(input, reasoningItem)
					}
				case "text":
					id, phase := parseResponseTextSignature(block.TextSignature)
					if !validResponsesItemID(id, "msg_") {
						id = fmt.Sprintf("msg_%d", messageIndex)
					}
					input = append(input, marshalResponsesInput(openAIResponsesMessageItem{
						Type:   "message",
						ID:     id,
						Role:   "assistant",
						Status: "completed",
						Phase:  phase,
						Content: []openAIResponsesContent{{
							Type:        "output_text",
							Text:        block.Text,
							Annotations: []any{},
						}},
					}))
					messageIndex++
				case "toolCall":
					callID, itemID := splitResponsesToolCallID(block.ID)
					if callID == "" {
						callID = fmt.Sprintf("call_%d", messageIndex)
					}
					if !validResponsesItemID(itemID, "fc_") {
						itemID = ""
					}
					arguments := block.Arguments
					if len(arguments) == 0 || string(arguments) == "null" {
						arguments = json.RawMessage(`{}`)
					}
					input = append(input, marshalResponsesInput(openAIResponsesFunctionCallItem{
						Type:      "function_call",
						ID:        itemID,
						CallID:    callID,
						Name:      block.Name,
						Arguments: string(arguments),
					}))
					messageIndex++
				}
			}
		case "toolResult":
			callID, _ := splitResponsesToolCallID(message.ToolCallID)
			if callID == "" {
				callID = message.ToolCallID
			}
			input = append(input, marshalResponsesInput(openAIResponsesFunctionOutputItem{
				Type:   "function_call_output",
				CallID: callID,
				Output: toolResultContent(message),
			}))
		}
	}

	tools := make([]openAIResponsesTool, 0, len(req.Context.Tools))
	for _, tool := range req.Context.Tools {
		tools = append(tools, openAIResponsesTool{
			Type:        "function",
			Name:        tool.Name,
			Description: tool.Description,
			Parameters:  tool.Parameters,
		})
	}

	payload := openAIResponsesRequest{
		Model:           model.ID,
		Instructions:    a.effectiveSystemPrompt(req.Context.SystemPrompt),
		Input:           input,
		Tools:           tools,
		Stream:          true,
		Store:           false,
		Temperature:     req.Options.Temperature,
		MaxOutputTokens: req.Options.MaxTokens,
	}
	if level := effectiveThinkingLevel(model, req.Options.Reasoning); level != thinkingLevelOff {
		payload.Reasoning = &openAIResponsesReasoning{Effort: level, Summary: "auto"}
		payload.Include = []string{"reasoning.encrypted_content"}
	}
	return payload
}

func responsesContentBlocks(raw json.RawMessage) []proxyContentBlock {
	var blocks []proxyContentBlock
	if err := json.Unmarshal(raw, &blocks); err == nil {
		return blocks
	}
	text := contentText(raw)
	if text == "" {
		return nil
	}
	return []proxyContentBlock{{Type: "text", Text: text}}
}

func validatedReasoningItem(signature string) json.RawMessage {
	raw := json.RawMessage(signature)
	if !json.Valid(raw) {
		return nil
	}
	var item struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &item); err != nil || item.Type != "reasoning" {
		return nil
	}
	return raw
}

func marshalResponsesInput(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`null`)
	}
	return encoded
}

func parseResponseTextSignature(signature string) (string, string) {
	if signature == "" {
		return "", ""
	}
	var parsed responseTextSignature
	if strings.HasPrefix(signature, "{") && json.Unmarshal([]byte(signature), &parsed) == nil && parsed.Version == 1 {
		return parsed.ID, parsed.Phase
	}
	return signature, ""
}

func validResponsesItemID(id string, prefix string) bool {
	return strings.HasPrefix(id, prefix) && len(id) <= 64
}

func splitResponsesToolCallID(id string) (string, string) {
	callID, itemID, found := strings.Cut(id, "|")
	if !found {
		return id, ""
	}
	return callID, itemID
}

func responsesToolCallID(callID string, itemID string) string {
	if callID == "" {
		callID = itemID
	}
	if itemID == "" || itemID == callID {
		return callID
	}
	return callID + "|" + itemID
}

func encodeResponseTextSignature(id string, phase string) string {
	if id == "" {
		return ""
	}
	encoded, err := json.Marshal(responseTextSignature{Version: 1, ID: id, Phase: phase})
	if err != nil {
		return id
	}
	return string(encoded)
}

func (a *App) relayOpenAIResponsesStream(body io.Reader, stream proxyEventWriter) (proxyUsage, string, error) {
	items := map[int]*streamedResponsesItem{}
	nextContentIndex := 0
	usage := zeroUsage()
	doneReason := "stop"
	completed := false

	getItem := func(outputIndex int, kind string) *streamedResponsesItem {
		state := items[outputIndex]
		if state == nil {
			state = &streamedResponsesItem{
				outputIndex:  outputIndex,
				contentIndex: nextContentIndex,
				kind:         kind,
			}
			nextContentIndex++
			items[outputIndex] = state
		} else if state.kind == "" {
			state.kind = kind
		}
		return state
	}

	startItem := func(state *streamedResponsesItem) error {
		if state.started {
			return nil
		}
		switch state.kind {
		case "text":
			if err := stream.write(map[string]interface{}{"type": "text_start", "contentIndex": state.contentIndex}); err != nil {
				return err
			}
		case "thinking":
			if err := stream.write(map[string]interface{}{"type": "thinking_start", "contentIndex": state.contentIndex}); err != nil {
				return err
			}
		case "toolCall":
			if state.name == "" {
				return nil
			}
			if err := stream.write(map[string]interface{}{
				"type":         "toolcall_start",
				"contentIndex": state.contentIndex,
				"id":           responsesToolCallID(state.callID, state.id),
				"toolName":     state.name,
			}); err != nil {
				return err
			}
			recordLLMToolProposal(state.name)
		}
		state.started = true
		if state.data.Len() > 0 {
			eventType := state.kind + "_delta"
			if state.kind == "toolCall" {
				eventType = "toolcall_delta"
			}
			if err := stream.write(map[string]interface{}{
				"type":         eventType,
				"contentIndex": state.contentIndex,
				"delta":        state.data.String(),
			}); err != nil {
				return err
			}
		}
		return nil
	}

	appendDelta := func(state *streamedResponsesItem, delta string) error {
		if delta == "" {
			return nil
		}
		state.data.WriteString(delta)
		if !state.started {
			return startItem(state)
		}
		eventType := state.kind + "_delta"
		if state.kind == "toolCall" {
			eventType = "toolcall_delta"
		}
		return stream.write(map[string]interface{}{
			"type":         eventType,
			"contentIndex": state.contentIndex,
			"delta":        delta,
		})
	}

	appendFinalRemainder := func(state *streamedResponsesItem, final string) error {
		current := state.data.String()
		if final == "" || final == current {
			return nil
		}
		if strings.HasPrefix(final, current) {
			return appendDelta(state, final[len(current):])
		}
		if current == "" {
			return appendDelta(state, final)
		}
		return nil
	}

	endItem := func(state *streamedResponsesItem, signature string) error {
		if state.ended {
			return nil
		}
		if err := startItem(state); err != nil {
			return err
		}
		if !state.started {
			return fmt.Errorf("responses stream ended tool call %d without a function name", state.outputIndex)
		}
		eventType := state.kind + "_end"
		if state.kind == "toolCall" {
			eventType = "toolcall_end"
		}
		event := map[string]interface{}{"type": eventType, "contentIndex": state.contentIndex}
		if signature != "" && state.kind != "toolCall" {
			event["contentSignature"] = signature
		}
		if err := stream.write(event); err != nil {
			return err
		}
		state.ended = true
		return nil
	}

	processData := func(data string) error {
		data = strings.TrimSpace(data)
		if data == "" {
			return nil
		}
		if data == "[DONE]" {
			return errOpenAIResponsesStreamDone
		}

		var event openAIResponsesStreamEvent
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			return fmt.Errorf("invalid Responses stream event: %w", err)
		}
		switch event.Type {
		case "response.output_item.added":
			var item openAIResponsesOutputItem
			if err := json.Unmarshal(event.Item, &item); err != nil {
				return fmt.Errorf("invalid Responses output item: %w", err)
			}
			kind := responsesStreamItemKind(item.Type)
			if kind == "" {
				return nil
			}
			state := getItem(event.OutputIndex, kind)
			state.id = item.ID
			state.callID = item.CallID
			state.name = item.Name
			state.phase = item.Phase
			if err := startItem(state); err != nil {
				return err
			}
			if kind == "toolCall" && item.Arguments != "" {
				return appendDelta(state, item.Arguments)
			}
		case "response.output_text.delta", "response.refusal.delta":
			return appendDelta(getItem(event.OutputIndex, "text"), event.Delta)
		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			return appendDelta(getItem(event.OutputIndex, "thinking"), event.Delta)
		case "response.function_call_arguments.delta":
			return appendDelta(getItem(event.OutputIndex, "toolCall"), event.Delta)
		case "response.function_call_arguments.done":
			state := getItem(event.OutputIndex, "toolCall")
			if state.name == "" {
				state.name = event.Name
			}
			return appendFinalRemainder(state, event.Arguments)
		case "response.output_item.done":
			var item openAIResponsesOutputItem
			if err := json.Unmarshal(event.Item, &item); err != nil {
				return fmt.Errorf("invalid completed Responses output item: %w", err)
			}
			kind := responsesStreamItemKind(item.Type)
			if kind == "" {
				return nil
			}
			state := getItem(event.OutputIndex, kind)
			state.id = item.ID
			state.callID = item.CallID
			state.name = item.Name
			state.phase = item.Phase
			switch kind {
			case "text":
				if err := appendFinalRemainder(state, responsesOutputText(item)); err != nil {
					return err
				}
				return endItem(state, encodeResponseTextSignature(item.ID, item.Phase))
			case "thinking":
				if err := appendFinalRemainder(state, responsesReasoningText(item)); err != nil {
					return err
				}
				return endItem(state, string(event.Item))
			case "toolCall":
				doneReason = "toolUse"
				if err := appendFinalRemainder(state, item.Arguments); err != nil {
					return err
				}
				return endItem(state, "")
			}
		case "response.completed", "response.incomplete":
			completed = true
			if event.Response != nil {
				usage = usageFromOpenAIResponses(event.Response.Usage)
				if event.Type == "response.incomplete" || event.Response.Status == "incomplete" {
					doneReason = "length"
				}
			}
		case "response.failed":
			if event.Response != nil && event.Response.Error != nil {
				return fmt.Errorf("responses API error: %s", event.Response.Error.Message)
			}
			return errors.New("responses API request failed")
		case "error":
			return fmt.Errorf("responses API error %s: %s", event.Code, event.Message)
		}
		return nil
	}

	if err := scanResponsesSSE(body, processData); err != nil && !errors.Is(err, errOpenAIResponsesStreamDone) {
		return usage, "error", err
	}

	indexes := make([]int, 0, len(items))
	for index := range items {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	for _, index := range indexes {
		state := items[index]
		if state.ended {
			continue
		}
		if state.kind == "toolCall" {
			doneReason = "toolUse"
		}
		if err := endItem(state, ""); err != nil {
			return usage, "error", err
		}
	}
	if !completed {
		return usage, "error", errors.New("responses stream ended before a completion event")
	}
	if err := stream.write(map[string]interface{}{"type": "done", "reason": doneReason, "usage": usage}); err != nil {
		return usage, "error", err
	}
	return usage, doneReason, nil
}

func responsesStreamItemKind(itemType string) string {
	switch itemType {
	case "message":
		return "text"
	case "reasoning":
		return "thinking"
	case "function_call":
		return "toolCall"
	default:
		return ""
	}
}

func responsesOutputText(item openAIResponsesOutputItem) string {
	parts := make([]string, 0, len(item.Content))
	for _, content := range item.Content {
		switch content.Type {
		case "output_text":
			parts = append(parts, content.Text)
		case "refusal":
			parts = append(parts, content.Refusal)
		}
	}
	return strings.Join(parts, "")
}

func responsesReasoningText(item openAIResponsesOutputItem) string {
	parts := make([]string, 0, len(item.Summary)+len(item.Content))
	for _, summary := range item.Summary {
		if summary.Text != "" {
			parts = append(parts, summary.Text)
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, "\n\n")
	}
	for _, content := range item.Content {
		if content.Text != "" {
			parts = append(parts, content.Text)
		}
	}
	return strings.Join(parts, "\n\n")
}

func usageFromOpenAIResponses(usage *openAIResponsesUsage) proxyUsage {
	if usage == nil {
		return zeroUsage()
	}
	input := usage.InputTokens - usage.InputTokensDetails.CachedTokens
	if input < 0 {
		input = 0
	}
	return proxyUsage{
		Input:       input,
		Output:      usage.OutputTokens,
		CacheRead:   usage.InputTokensDetails.CachedTokens,
		CacheWrite:  0,
		TotalTokens: usage.TotalTokens,
		Cost:        zeroCost(),
	}
}

func scanResponsesSSE(body io.Reader, process func(string) error) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	dataLines := make([]string, 0, 4)

	flush := func() error {
		if len(dataLines) == 0 {
			return nil
		}
		data := strings.Join(dataLines, "\n")
		dataLines = dataLines[:0]
		return process(data)
	}

	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" {
			if err := flush(); err != nil {
				return err
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
		return err
	}
	return flush()
}
