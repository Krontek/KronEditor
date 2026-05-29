package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ai.go — provider-agnostic chat proxy with tool-calling for the AI Agent panel.
//
// The agent LOOP lives on the frontend (it owns the project state, the
// diff/approval UI and the tool executors). This endpoint is a STATELESS
// single-turn normalizer: given the conversation so far + the available tools,
// it asks the configured provider for the assistant's next message and returns
// it in ONE normalized shape, regardless of provider.
//
//   POST /api/host/ai/chat
//     {
//       provider: "anthropic"|"openai"|"ollama"|"custom",
//       model, apiKey, baseUrl,            // baseUrl optional for cloud providers
//       system: "system prompt",
//       messages: [ aiMessage... ],
//       tools:    [ aiTool... ],
//       maxTokens?, temperature?
//     }
//   → { ok, message: aiMessage(role:"assistant"), error? }
//
// Normalized message shape (same in both directions):
//   { role: "user"|"assistant"|"tool",
//     content: string,
//     toolCalls: [ { id, name, arguments(JSON object) } ],   // assistant turns
//     toolCallId: string, name: string }                     // tool-result turns
//
// Each provider's wire dialect (auth header, URL, request/response schema, how
// tool calls and tool results are encoded) is contained in its call* function.
// "custom" is treated as an OpenAI-compatible endpoint.

type aiToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"` // a JSON object
}

type aiMessage struct {
	Role       string          `json:"role"`                 // user | assistant | tool
	Content    string          `json:"content"`              // text (may be empty on tool-only turns)
	ToolCalls  []aiToolCall    `json:"toolCalls,omitempty"`  // assistant turns
	ToolCallID string          `json:"toolCallId,omitempty"` // tool-result turns (OpenAI correlation)
	Name       string          `json:"name,omitempty"`       // tool name on tool-result turns
}

type aiTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"` // JSON Schema object
}

type aiChatReq struct {
	Provider    string      `json:"provider"`
	Model       string      `json:"model"`
	APIKey      string      `json:"apiKey"`
	BaseURL     string      `json:"baseUrl"`
	System      string      `json:"system"`
	Messages    []aiMessage `json:"messages"`
	Tools       []aiTool    `json:"tools"`
	MaxTokens   int         `json:"maxTokens"`
	Temperature *float64    `json:"temperature"`
}

func (s *Server) handleAIChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req aiChatReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Model) == "" {
		writeError(w, http.StatusBadRequest, "model is required")
		return
	}
	if req.MaxTokens <= 0 {
		req.MaxTokens = 4096
	}

	// Tool-calling can take a while on a big local model; give it room.
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()

	var (
		msg aiMessage
		err error
	)
	switch strings.ToLower(strings.TrimSpace(req.Provider)) {
	case "anthropic":
		msg, err = callAnthropic(ctx, req)
	case "openai":
		msg, err = callOpenAI(ctx, req, "https://api.openai.com")
	case "custom":
		msg, err = callOpenAI(ctx, req, "") // baseUrl required; OpenAI-compatible
	case "ollama", "":
		msg, err = callOllama(ctx, req)
	default:
		writeError(w, http.StatusBadRequest, "unknown provider: "+req.Provider)
		return
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	msg.Role = "assistant"
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": msg})
}

// httpJSON does a POST with a JSON body and returns the decoded response body,
// surfacing non-2xx bodies as errors so the panel can show provider messages.
func httpJSON(ctx context.Context, url string, headers map[string]string, body any, out any) error {
	buf, _ := json.Marshal(body)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}
	resp, err := (&http.Client{}).Do(httpReq)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet := strings.TrimSpace(string(raw))
		if len(snippet) > 600 {
			snippet = snippet[:600] + "…"
		}
		return fmt.Errorf("provider HTTP %d: %s", resp.StatusCode, snippet)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func joinURL(base, suffix string) string {
	return strings.TrimRight(base, "/") + suffix
}

// ── Anthropic (/v1/messages) ─────────────────────────────────────────────────

func callAnthropic(ctx context.Context, req aiChatReq) (aiMessage, error) {
	base := req.BaseURL
	if strings.TrimSpace(base) == "" {
		base = "https://api.anthropic.com"
	}

	type block map[string]any
	// Build content-block messages, merging consecutive same-role turns (the API
	// requires user/assistant to alternate; tool results live in a user turn).
	type wireMsg struct {
		Role    string  `json:"role"`
		Content []block `json:"content"`
	}
	var msgs []wireMsg
	push := func(role string, blocks []block) {
		if n := len(msgs); n > 0 && msgs[n-1].Role == role {
			msgs[n-1].Content = append(msgs[n-1].Content, blocks...)
			return
		}
		msgs = append(msgs, wireMsg{Role: role, Content: blocks})
	}
	for _, m := range req.Messages {
		switch m.Role {
		case "tool":
			push("user", []block{{
				"type":        "tool_result",
				"tool_use_id": m.ToolCallID,
				"content":     m.Content,
			}})
		case "assistant":
			var blocks []block
			if strings.TrimSpace(m.Content) != "" {
				blocks = append(blocks, block{"type": "text", "text": m.Content})
			}
			for _, tc := range m.ToolCalls {
				blocks = append(blocks, block{
					"type":  "tool_use",
					"id":    tc.ID,
					"name":  tc.Name,
					"input": json.RawMessage(orEmptyObj(tc.Arguments)),
				})
			}
			if len(blocks) == 0 {
				blocks = []block{{"type": "text", "text": ""}}
			}
			push("assistant", blocks)
		default: // user
			push("user", []block{{"type": "text", "text": m.Content}})
		}
	}

	tools := make([]map[string]any, 0, len(req.Tools))
	for _, t := range req.Tools {
		tools = append(tools, map[string]any{
			"name":         t.Name,
			"description":  t.Description,
			"input_schema": json.RawMessage(orEmptyObj(t.Parameters)),
		})
	}

	payload := map[string]any{
		"model":      req.Model,
		"max_tokens": req.MaxTokens,
		"messages":   msgs,
	}
	if strings.TrimSpace(req.System) != "" {
		payload["system"] = req.System
	}
	if len(tools) > 0 {
		payload["tools"] = tools
	}
	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}

	var out struct {
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	headers := map[string]string{
		"x-api-key":         req.APIKey,
		"anthropic-version": "2023-06-01",
	}
	if err := httpJSON(ctx, joinURL(base, "/v1/messages"), headers, payload, &out); err != nil {
		return aiMessage{}, err
	}
	if out.Error.Message != "" {
		return aiMessage{}, fmt.Errorf("anthropic: %s", out.Error.Message)
	}

	var msg aiMessage
	var text strings.Builder
	for _, b := range out.Content {
		switch b.Type {
		case "text":
			text.WriteString(b.Text)
		case "tool_use":
			msg.ToolCalls = append(msg.ToolCalls, aiToolCall{
				ID: b.ID, Name: b.Name, Arguments: json.RawMessage(orEmptyObj(b.Input)),
			})
		}
	}
	msg.Content = text.String()
	return msg, nil
}

// ── OpenAI-compatible (/v1/chat/completions): openai + custom ────────────────

func callOpenAI(ctx context.Context, req aiChatReq, defaultBase string) (aiMessage, error) {
	base := strings.TrimSpace(req.BaseURL)
	if base == "" {
		base = defaultBase
	}
	if base == "" {
		return aiMessage{}, fmt.Errorf("custom provider requires a base URL")
	}
	// Allow a base that already includes /v1 (common for local OpenAI-compatible
	// servers) without doubling it.
	endpoint := joinURL(base, "/v1/chat/completions")
	if strings.Contains(strings.TrimRight(base, "/"), "/v1") {
		endpoint = joinURL(base, "/chat/completions")
	}

	msgs := buildOpenAIMessages(req, true)

	tools := make([]map[string]any, 0, len(req.Tools))
	for _, t := range req.Tools {
		tools = append(tools, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"parameters":  json.RawMessage(orEmptyObj(t.Parameters)),
			},
		})
	}

	payload := map[string]any{
		"model":    req.Model,
		"messages": msgs,
	}
	if len(tools) > 0 {
		payload["tools"] = tools
	}
	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content   string `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"` // JSON-encoded string
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	headers := map[string]string{}
	if req.APIKey != "" {
		headers["Authorization"] = "Bearer " + req.APIKey
	}
	if err := httpJSON(ctx, endpoint, headers, payload, &out); err != nil {
		return aiMessage{}, err
	}
	if out.Error.Message != "" {
		return aiMessage{}, fmt.Errorf("openai: %s", out.Error.Message)
	}
	if len(out.Choices) == 0 {
		return aiMessage{}, fmt.Errorf("openai: empty response")
	}
	ch := out.Choices[0].Message
	msg := aiMessage{Content: ch.Content}
	for _, tc := range ch.ToolCalls {
		args := tc.Function.Arguments
		if strings.TrimSpace(args) == "" {
			args = "{}"
		}
		msg.ToolCalls = append(msg.ToolCalls, aiToolCall{
			ID: tc.ID, Name: tc.Function.Name, Arguments: json.RawMessage(args),
		})
	}
	return msg, nil
}

// buildOpenAIMessages renders the conversation in OpenAI chat format. Ollama's
// /api/chat uses the same envelope EXCEPT tool-call arguments are an object
// (not a JSON string) and tool results carry no tool_call_id — argsAsString
// toggles that.
func buildOpenAIMessages(req aiChatReq, argsAsString bool) []map[string]any {
	var msgs []map[string]any
	if strings.TrimSpace(req.System) != "" {
		msgs = append(msgs, map[string]any{"role": "system", "content": req.System})
	}
	for _, m := range req.Messages {
		switch m.Role {
		case "tool":
			tm := map[string]any{"role": "tool", "content": m.Content}
			if argsAsString && m.ToolCallID != "" {
				tm["tool_call_id"] = m.ToolCallID
			}
			if m.Name != "" {
				tm["name"] = m.Name
			}
			msgs = append(msgs, tm)
		case "assistant":
			am := map[string]any{"role": "assistant", "content": m.Content}
			if len(m.ToolCalls) > 0 {
				calls := make([]map[string]any, 0, len(m.ToolCalls))
				for _, tc := range m.ToolCalls {
					fn := map[string]any{"name": tc.Name}
					if argsAsString {
						fn["arguments"] = string(orEmptyObj(tc.Arguments))
					} else {
						fn["arguments"] = json.RawMessage(orEmptyObj(tc.Arguments))
					}
					call := map[string]any{"type": "function", "function": fn}
					if tc.ID != "" {
						call["id"] = tc.ID
					}
					calls = append(calls, call)
				}
				am["tool_calls"] = calls
			}
			msgs = append(msgs, am)
		default:
			msgs = append(msgs, map[string]any{"role": "user", "content": m.Content})
		}
	}
	return msgs
}

// ── Ollama (/api/chat) ───────────────────────────────────────────────────────

func callOllama(ctx context.Context, req aiChatReq) (aiMessage, error) {
	base := normalizeOllamaBase(req.BaseURL)

	msgs := buildOpenAIMessages(req, false) // object-form arguments, no tool_call_id

	tools := make([]map[string]any, 0, len(req.Tools))
	for _, t := range req.Tools {
		tools = append(tools, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"parameters":  json.RawMessage(orEmptyObj(t.Parameters)),
			},
		})
	}

	// Give the agent a context window large enough for the (compact) system
	// prompt + tool schemas + a few turns, so Ollama doesn't truncate and drop
	// the project map. 8192 is a good balance on a 6 GB GPU once weights are
	// loaded (KV cache stays modest); Ollama clamps to the model's max.
	options := map[string]any{"num_ctx": 8192}
	if req.Temperature != nil {
		options["temperature"] = *req.Temperature
	}
	payload := map[string]any{
		"model":    req.Model,
		"messages": msgs,
		"stream":   false,
		"options":  options,
	}
	if len(tools) > 0 {
		payload["tools"] = tools
	}

	var out struct {
		Message struct {
			Content   string `json:"content"`
			ToolCalls []struct {
				Function struct {
					Name      string          `json:"name"`
					Arguments json.RawMessage `json:"arguments"` // object
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"message"`
		Error string `json:"error"`
	}
	if err := httpJSON(ctx, joinURL(base, "/api/chat"), nil, payload, &out); err != nil {
		return aiMessage{}, err
	}
	if out.Error != "" {
		return aiMessage{}, fmt.Errorf("ollama: %s", out.Error)
	}

	msg := aiMessage{Content: out.Message.Content}
	// Ollama does not assign tool-call IDs; synthesize stable ones so the
	// frontend can correlate the tool results it sends back.
	for i, tc := range out.Message.ToolCalls {
		msg.ToolCalls = append(msg.ToolCalls, aiToolCall{
			ID:        fmt.Sprintf("call_%d", i),
			Name:      tc.Function.Name,
			Arguments: json.RawMessage(orEmptyObj(tc.Function.Arguments)),
		})
	}
	return msg, nil
}

func orEmptyObj(raw json.RawMessage) json.RawMessage {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return json.RawMessage("{}")
	}
	return raw
}
