package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
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

// Required on every Anthropic REST call (both /v1/messages and /v1/models),
// in API-key and OAuth mode alike.
const anthropicVersion = "2023-06-01"

// DeepSeek's OpenAI-compatible host. Deliberately WITHOUT a version segment:
// both callOpenAI ("/chat/completions") and listOpenAIModels ("/models") append
// their own path, and DeepSeek serves them at the root. (Its docs also accept
// ".../v1", but that "v1" is OpenAI-SDK compatibility, not an API version —
// adding it here would just make the two appended paths inconsistent.)
const deepseekBase = "https://api.deepseek.com"

type aiToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"` // a JSON object
	// Extra is the provider's opaque per-tool-call blob, echoed back VERBATIM on
	// the next turn. ⚠️ Required by Gemini 3: its tool calls carry
	// `extra_content.google.thought_signature`, and replaying the assistant turn
	// without it fails the whole request with
	// 400 "Function call is missing a thought_signature in functionCall parts".
	// Opaque on purpose — never parse or synthesize it, just round-trip it.
	Extra json.RawMessage `json:"extra,omitempty"`
}

// aiImage is a user-turn image attachment (Anthropic + OpenAI-compatible
// providers only — see callAnthropic/buildOpenAIMessages). Data is the raw
// base64 payload with no "data:" URI prefix.
type aiImage struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

type aiMessage struct {
	Role       string       `json:"role"`                 // user | assistant | tool
	Content    string       `json:"content"`              // text (may be empty on tool-only turns)
	Images     []aiImage    `json:"images,omitempty"`     // user-turn image attachments
	ToolCalls  []aiToolCall `json:"toolCalls,omitempty"`  // assistant turns
	ToolCallID string       `json:"toolCallId,omitempty"` // tool-result turns (OpenAI correlation)
	Name       string       `json:"name,omitempty"`       // tool name on tool-result turns
}

type aiTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"` // JSON Schema object
}

type aiChatReq struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	APIKey   string `json:"apiKey"`
	BaseURL  string `json:"baseUrl"`
	System   string `json:"system"`
	// Context carries the VOLATILE project state (board, POU list, globals,
	// open POU). It is kept out of System on purpose: Anthropic prompt caching
	// is a byte-exact prefix match over tools→system→messages, so anything
	// that changes per turn must ride AFTER the cache breakpoints. callAnthropic
	// appends it as a trailing <project-context> block; other providers just
	// get it folded into the system prompt (handleAIChat).
	Context     string      `json:"context"`
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

	// Kept for the log: the fold below clears req.Context, and the folded copy
	// lands at the END of a ~14k-char system prompt that the log truncates at
	// 4k — so the project context (which POUs exist, the board, the open POU)
	// was invisible in every non-Anthropic exchange. That is exactly what you
	// need when diagnosing "why did the agent invent a POU that isn't there".
	projectContext := req.Context

	// Non-Anthropic providers have no cache-placement concern — fold the
	// volatile project context straight into the system prompt for them.
	switch strings.ToLower(strings.TrimSpace(req.Provider)) {
	case "anthropic", "anthropic-oauth", "claude-account":
		// callAnthropic places req.Context after the cache breakpoint itself.
	default:
		if strings.TrimSpace(req.Context) != "" {
			req.System = strings.TrimRight(req.System, "\n") + "\n\n<project-context>\n" + req.Context + "\n</project-context>"
			req.Context = ""
		}
	}

	var (
		msg aiMessage
		err error
	)
	switch strings.ToLower(strings.TrimSpace(req.Provider)) {
	case "anthropic":
		msg, err = callAnthropic(ctx, req, "")
	case "anthropic-oauth", "claude-account":
		// Subscription sign-in: use the stored Bearer token; on a 401 (expired
		// mid-flight) force-refresh once and retry.
		var tok string
		if tok, err = s.anthropicOAuth.accessToken(false); err == nil {
			msg, err = callAnthropic(ctx, req, tok)
			if err != nil && strings.Contains(err.Error(), "HTTP 401") {
				if tok, err = s.anthropicOAuth.accessToken(true); err == nil {
					msg, err = callAnthropic(ctx, req, tok)
				}
			}
		}
	case "openai":
		msg, err = callOpenAI(ctx, req, "https://api.openai.com")
	case "gemini", "google":
		// Gemini exposes an OpenAI-compatible surface (Bearer auth, tool_calls).
		// The base already contains "/v1beta", so callOpenAI appends only
		// "/chat/completions" → .../v1beta/openai/chat/completions.
		msg, err = callOpenAI(ctx, req, "https://generativelanguage.googleapis.com/v1beta/openai")
	case "deepseek":
		// OpenAI-compatible (Bearer auth, tool_calls). The base carries no version
		// segment, so callOpenAI appends "/chat/completions" directly.
		msg, err = callOpenAI(ctx, req, deepseekBase)
	case "custom":
		msg, err = callOpenAI(ctx, req, "") // baseUrl required; OpenAI-compatible
	case "ollama", "":
		msg, err = callOllama(ctx, req)
	default:
		writeError(w, http.StatusBadRequest, "unknown provider: "+req.Provider)
		return
	}
	// Log the exchange (request + raw model output) so failures/odd outputs can
	// be inspected later — see {AppDataDir}/ai-agent.log.
	s.logAIChat(req, projectContext, msg, err)
	if err != nil {
		writeError(w, http.StatusBadGateway, friendlyProviderError(req.Model, err))
		return
	}
	msg.Role = "assistant"
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": msg})
}

func truncForLog(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + fmt.Sprintf("… (%d more chars)", len(s)-n)
}

// logAIChat appends one agent exchange — the request we sent (system prompt,
// messages, tool names) and the model's raw output (text + tool calls, or the
// error) — to {AppDataDir}/ai-agent.log. Best-effort; never fails the request.
func (s *Server) logAIChat(req aiChatReq, projectContext string, msg aiMessage, callErr error) {
	path := filepath.Join(s.paths.AppDataDir, "ai-agent.log")
	f, e := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if e != nil {
		return
	}
	defer f.Close()

	var b strings.Builder
	fmt.Fprintf(&b, "\n===== %s  %s / %s =====\n", time.Now().Format("2006-01-02 15:04:05"), req.Provider, req.Model)
	fmt.Fprintf(&b, "--- request: system ---\n%s\n", truncForLog(req.System, 4000))
	// Logged from the caller's saved copy, not req.Context: for non-Anthropic
	// providers that field has already been folded into System and cleared.
	if strings.TrimSpace(projectContext) != "" {
		fmt.Fprintf(&b, "--- request: project context ---\n%s\n", truncForLog(projectContext, 2000))
	}
	fmt.Fprintf(&b, "--- request: messages (%d) ---\n", len(req.Messages))
	for _, m := range req.Messages {
		imgNote := ""
		if len(m.Images) > 0 {
			imgNote = fmt.Sprintf(" [+%d image(s), not logged]", len(m.Images))
		}
		fmt.Fprintf(&b, "[%s] %s%s\n", m.Role, truncForLog(m.Content, 1500), imgNote)
		for _, tc := range m.ToolCalls {
			fmt.Fprintf(&b, "   ↳ tool_call %s(%s)\n", tc.Name, truncForLog(string(tc.Arguments), 800))
		}
	}
	toolNames := make([]string, 0, len(req.Tools))
	for _, t := range req.Tools {
		toolNames = append(toolNames, t.Name)
	}
	fmt.Fprintf(&b, "--- request: tools ---\n%s\n", strings.Join(toolNames, ", "))
	if callErr != nil {
		fmt.Fprintf(&b, "--- MODEL ERROR ---\n%v\n", callErr)
	} else {
		fmt.Fprintf(&b, "--- model output: content ---\n%s\n", msg.Content)
		for _, tc := range msg.ToolCalls {
			fmt.Fprintf(&b, "--- model output: tool_call ---\n%s(%s)\n", tc.Name, string(tc.Arguments))
		}
		if len(msg.ToolCalls) == 0 {
			fmt.Fprintf(&b, "(no structured tool_calls — frontend will try to parse tool calls from the content above)\n")
		}
	}
	_, _ = f.WriteString(b.String())
}

func (s *Server) aiLogPath() string { return filepath.Join(s.paths.AppDataDir, "ai-agent.log") }

// handleAILogClear truncates the agent log (called on "New chat").
func (s *Server) handleAILogClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	_ = os.WriteFile(s.aiLogPath(), []byte{}, 0o644) // best-effort; recreated on next request
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleAILogSave snapshots the current agent log to a timestamped file.
func (s *Server) handleAILogSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	data, err := os.ReadFile(s.aiLogPath())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "no log to save: "+err.Error())
		return
	}
	dst := filepath.Join(s.paths.AppDataDir, "ai-agent-"+time.Now().Format("20060102-150405")+".log")
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": dst})
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

// oauthToken != "" switches to subscription OAuth mode: Bearer auth + the
// oauth beta header, and the system prompt is sent as content blocks with a
// Claude-Code identity FIRST (the subscription credential is only authorized for
// Claude Code, so the request must identify as it).
func callAnthropic(ctx context.Context, req aiChatReq, oauthToken string) (aiMessage, error) {
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
			var blocks []block
			for _, img := range m.Images {
				blocks = append(blocks, block{
					"type": "image",
					"source": block{
						"type":       "base64",
						"media_type": img.MimeType,
						"data":       img.Data,
					},
				})
			}
			blocks = append(blocks, block{"type": "text", "text": m.Content})
			push("user", blocks)
		}
	}

	// ── Prompt caching ──
	// The agent loop re-sends tools + system + the whole history on every turn
	// (up to MAX_AGENT_TURNS times per user request). Without cache_control each
	// turn re-bills all of it at full input price — the dominant token cost.
	// Three breakpoints (max is 4): last tool (caches the tool schemas), last
	// system block (caches the system prompt), last history block (caches the
	// conversation incrementally). Cache reads bill ~0.1x; writes 1.25x, so a
	// single reuse already pays for itself.
	cacheMark := block{"type": "ephemeral"}

	// Breakpoint 3: the last content block of the final (stable) history
	// message — the volatile <project-context> block is appended AFTER this.
	if n := len(msgs); n > 0 {
		if c := msgs[n-1].Content; len(c) > 0 {
			c[len(c)-1]["cache_control"] = cacheMark
		}
	}
	// The volatile project state rides after the breakpoint, so a project
	// change between turns re-bills only this small block, not the prefix.
	if strings.TrimSpace(req.Context) != "" {
		ctxBlock := block{"type": "text", "text": "<project-context>\n" + req.Context + "\n</project-context>"}
		if n := len(msgs); n > 0 && msgs[n-1].Role == "user" {
			msgs[n-1].Content = append(msgs[n-1].Content, ctxBlock)
		} else {
			msgs = append(msgs, wireMsg{Role: "user", Content: []block{ctxBlock}})
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
	// Breakpoint 1: tools render first in the prompt; marking the last one
	// caches the whole (static) tool list.
	if len(tools) > 0 {
		tools[len(tools)-1]["cache_control"] = cacheMark
	}

	payload := map[string]any{
		"model":      req.Model,
		"max_tokens": req.MaxTokens,
		"messages":   msgs,
	}
	if oauthToken != "" {
		// Subscription OAuth: system MUST be content blocks led by the Claude
		// Code identity, else the credential is rejected.
		sys := []block{{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}}
		if strings.TrimSpace(req.System) != "" {
			sys = append(sys, block{"type": "text", "text": req.System})
		}
		// Breakpoint 2: caches identity + system prompt.
		sys[len(sys)-1]["cache_control"] = cacheMark
		payload["system"] = sys
	} else if strings.TrimSpace(req.System) != "" {
		payload["system"] = []block{{"type": "text", "text": req.System, "cache_control": cacheMark}}
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
		Usage struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
		} `json:"usage"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	headers := map[string]string{"anthropic-version": anthropicVersion}
	if oauthToken != "" {
		headers["Authorization"] = "Bearer " + oauthToken
		headers["anthropic-beta"] = anthropicOAuthBeta
	} else {
		headers["x-api-key"] = req.APIKey
	}
	if err := httpJSON(ctx, joinURL(base, "/v1/messages"), headers, payload, &out); err != nil {
		return aiMessage{}, err
	}
	if out.Error.Message != "" {
		return aiMessage{}, fmt.Errorf("anthropic: %s", out.Error.Message)
	}
	// Cache effectiveness at a glance: after the first turn of a loop,
	// cache_read should carry most of the prompt and input stay small. A
	// persistent cache_read=0 means a silent prefix invalidator crept in.
	log.Printf("[ai] anthropic usage: input=%d cache_read=%d cache_write=%d output=%d",
		out.Usage.InputTokens, out.Usage.CacheReadInputTokens, out.Usage.CacheCreationInputTokens, out.Usage.OutputTokens)

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
					// Gemini rides its thought_signature here; kept opaque.
					ExtraContent json.RawMessage `json:"extra_content"`
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
			Extra: tc.ExtraContent,
		})
	}
	return msg, nil
}

// buildOpenAIMessages renders the conversation in OpenAI chat format. Ollama's
// /api/chat uses the same envelope EXCEPT tool-call arguments are an object
// (not a JSON string) and tool results carry no tool_call_id — argsAsString
// toggles that. It also gates image attachments: Ollama's /api/chat has its
// own different image scheme (a top-level "images" array of bare base64
// strings, no media type and no "image_url" content part), so when
// argsAsString is false (the Ollama caller) any attached images are silently
// dropped rather than sent in a shape Ollama doesn't understand — the
// frontend already only lets the user attach images for Anthropic/OpenAI-
// compatible providers, this is just a defensive backstop.
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
					// Echo the provider's opaque blob back untouched — Gemini 3
					// rejects the whole request if its thought_signature is
					// missing from a replayed functionCall.
					if len(tc.Extra) > 0 {
						call["extra_content"] = json.RawMessage(tc.Extra)
					}
					calls = append(calls, call)
				}
				am["tool_calls"] = calls
			}
			msgs = append(msgs, am)
		default:
			if argsAsString && len(m.Images) > 0 {
				parts := make([]map[string]any, 0, len(m.Images)+1)
				if strings.TrimSpace(m.Content) != "" {
					parts = append(parts, map[string]any{"type": "text", "text": m.Content})
				}
				for _, img := range m.Images {
					parts = append(parts, map[string]any{
						"type":      "image_url",
						"image_url": map[string]any{"url": "data:" + img.MimeType + ";base64," + img.Data},
					})
				}
				msgs = append(msgs, map[string]any{"role": "user", "content": parts})
			} else {
				msgs = append(msgs, map[string]any{"role": "user", "content": m.Content})
			}
		}
	}
	return msgs
}

// ── Ollama (/api/chat) ───────────────────────────────────────────────────────

func callOllama(ctx context.Context, req aiChatReq) (aiMessage, error) {
	base := normalizeOllamaBase(req.BaseURL)

	msg, err := ollamaChatOnce(ctx, base, req)
	// Some Ollama models (e.g. codellama) have no native tool API — passing
	// `tools` makes the daemon answer HTTP 400 "<model> does not support tools".
	// Fall back to PROMPT-BASED tool calling: drop the tools field, describe the
	// tools in the system prompt and let the model emit tool calls as JSON text,
	// which the frontend's extractInlineToolCalls()/repairJsonBrackets() recover.
	if err != nil && len(req.Tools) > 0 && isUnsupportedToolsErr(err) {
		req.System = strings.TrimRight(req.System, "\n") + "\n\n" + toolPrompt(req.Tools)
		req.Tools = nil
		return ollamaChatOnce(ctx, base, req)
	}
	return msg, err
}

// isUnsupportedToolsErr matches Ollama's "<model> does not support tools" 400.
func isUnsupportedToolsErr(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "does not support tools")
}

// toolPrompt renders the tool list into system-prompt text for models without a
// native tool API. The shape it asks for ({"name","arguments"}) is exactly what
// the frontend's extractInlineToolCalls() parses out of the assistant text.
func toolPrompt(tools []aiTool) string {
	var b strings.Builder
	b.WriteString("TOOL CALLING — this model has no native tool API, so you call tools by writing JSON.\n")
	b.WriteString("To call a tool, output ONLY a JSON object (no markdown fences, no prose) of the form:\n")
	b.WriteString(`{"name": "<tool_name>", "arguments": { ...args... }}` + "\n")
	b.WriteString("Emit one JSON object per tool call (you may emit several, each on its own line). After the tools run you get their results and may call more. When you are finished calling tools and only want to reply to the user, output plain text instead of JSON.\n\n")
	b.WriteString("Available tools:\n")
	for _, t := range tools {
		fmt.Fprintf(&b, "- %s: %s\n  arguments JSON schema: %s\n", t.Name, t.Description, string(orEmptyObj(t.Parameters)))
	}
	return b.String()
}

func ollamaChatOnce(ctx context.Context, base string, req aiChatReq) (aiMessage, error) {
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

// ── Model discovery (/api/host/ai/models) ────────────────────────────────────
//
// The panel's "Connect a model" tab calls this before it renders, so the model
// picker always offers what the provider CURRENTLY serves rather than a list
// hardcoded at build time (which goes stale every time a model ships). Each
// provider exposes a list endpoint; failures are non-fatal — the panel falls
// back to its built-in suggestions and shows the reason.
//
//   POST /api/host/ai/models  { provider, apiKey, baseUrl }
//   → { ok, models: ["claude-opus-5", ...], error? }

type aiModelsReq struct {
	Provider string `json:"provider"`
	APIKey   string `json:"apiKey"`
	BaseURL  string `json:"baseUrl"`
}

func (s *Server) handleAIModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req aiModelsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Short timeout: this gates the settings UI, so a hung provider must not
	// keep the user staring at "Updating…".
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	var (
		models []string
		err    error
	)
	switch strings.ToLower(strings.TrimSpace(req.Provider)) {
	case "anthropic":
		models, err = listAnthropicModels(ctx, req.BaseURL, map[string]string{
			"x-api-key":         req.APIKey,
			"anthropic-version": anthropicVersion,
		})
	case "anthropic-oauth", "claude-account":
		// Subscription sign-in: Bearer + the oauth beta header. Mirrors
		// handleAIChat's 401 force-refresh retry.
		var tok string
		if tok, err = s.anthropicOAuth.accessToken(false); err == nil {
			hdr := func(t string) map[string]string {
				return map[string]string{
					"Authorization":     "Bearer " + t,
					"anthropic-beta":    anthropicOAuthBeta,
					"anthropic-version": anthropicVersion,
				}
			}
			models, err = listAnthropicModels(ctx, req.BaseURL, hdr(tok))
			if err != nil && strings.Contains(err.Error(), "HTTP 401") {
				if tok, err = s.anthropicOAuth.accessToken(true); err == nil {
					models, err = listAnthropicModels(ctx, req.BaseURL, hdr(tok))
				}
			}
		}
	case "openai":
		models, err = listOpenAIModels(ctx, req.BaseURL, "https://api.openai.com", req.APIKey)
	case "gemini", "google":
		// Listing uses Gemini's NATIVE endpoint even though chat goes through its
		// OpenAI-compat surface: the compat /models route 404s without auth (a
		// routing 404 that reads as "endpoint gone" rather than "add a key"), and
		// the native one reports supportedGenerationMethods — the provider's own
		// answer to "can this model chat", which beats guessing from the id.
		models, err = listGeminiModels(ctx, req.BaseURL, req.APIKey)
	case "deepseek":
		models, err = listOpenAIModels(ctx, req.BaseURL, deepseekBase, req.APIKey)
	case "custom":
		models, err = listOpenAIModels(ctx, req.BaseURL, "", req.APIKey)
	case "ollama", "":
		models, err = listOllamaModels(ctx, req.BaseURL)
	default:
		writeError(w, http.StatusBadRequest, "unknown provider: "+req.Provider)
		return
	}
	if err != nil {
		// 200 with an error string: an unreachable provider or a missing key is
		// an expected state in a settings dialog, not a request failure. The
		// panel keeps its built-in suggestions and surfaces the reason inline.
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "models": []string{}, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "models": models})
}

// listAnthropicModels reads GET /v1/models. Auth differs by mode (API key vs
// OAuth Bearer), so the caller supplies the full header set.
func listAnthropicModels(ctx context.Context, baseURL string, headers map[string]string) ([]string, error) {
	base := strings.TrimSpace(baseURL)
	if base == "" {
		base = "https://api.anthropic.com"
	}
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := httpGetJSON(ctx, joinURL(base, "/v1/models?limit=100"), headers, &out); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(out.Data))
	for _, m := range out.Data {
		if m.ID != "" {
			ids = append(ids, m.ID)
		}
	}
	return ids, nil
}

// Model families that are NOT conversational, matched as substrings against a
// lowercased model id. OpenAI's /v1/models returns the whole account catalogue —
// embeddings, speech, image and moderation models included — and a picker for a
// tool-calling agent must not offer them. Kept deliberately conservative: the
// combo box is free-text, so anything wrongly filtered can still be typed, but a
// wrongly OFFERED model fails only later, mid-conversation.
var nonChatModelMarkers = []string{
	"embedding", "embed-",
	"whisper", "-tts", "tts-", "-audio", "-realtime", "-transcribe", "speech",
	"dall-e", "-image", "image-", "imagen", "sora", "veo",
	"moderation", "-rerank", "rerank-", "guard",
	"babbage", "ada-", "curie", "davinci", // legacy completion-only families
}

func isChatModelID(id string) bool {
	l := strings.ToLower(id)
	for _, bad := range nonChatModelMarkers {
		if strings.Contains(l, bad) {
			return false
		}
	}
	return true
}

// listOpenAIModels reads GET {base}/models — the OpenAI list shape, which most
// "custom" gateways also serve. Non-chat families are filtered out and the list
// is ordered newest-first via the `created` timestamp OpenAI returns (its raw
// order is arbitrary, which would bury the current model mid-list).
func listOpenAIModels(ctx context.Context, baseURL, defaultBase, apiKey string) ([]string, error) {
	base := strings.TrimSpace(baseURL)
	if base == "" {
		base = defaultBase
	}
	if base == "" {
		return nil, fmt.Errorf("base URL is required for this provider")
	}
	suffix := "/models"
	// The first-party OpenAI host serves the list under /v1; compat bases
	// (self-hosted gateways) already carry their version segment.
	if strings.Contains(base, "api.openai.com") {
		suffix = "/v1/models"
	}
	headers := map[string]string{}
	if strings.TrimSpace(apiKey) != "" {
		headers["Authorization"] = "Bearer " + apiKey
	}
	var out struct {
		Data []struct {
			ID      string `json:"id"`
			Created int64  `json:"created"`
		} `json:"data"`
	}
	if err := httpGetJSON(ctx, joinURL(base, suffix), headers, &out); err != nil {
		return nil, err
	}
	kept := out.Data[:0]
	for _, m := range out.Data {
		id := strings.TrimPrefix(m.ID, "models/")
		if id != "" && isChatModelID(id) {
			m.ID = id
			kept = append(kept, m)
		}
	}
	// Stable so ids sharing a release timestamp keep the provider's own order.
	sort.SliceStable(kept, func(i, j int) bool { return kept[i].Created > kept[j].Created })
	ids := make([]string, 0, len(kept))
	for _, m := range kept {
		ids = append(ids, m.ID)
	}
	return ids, nil
}

// listGeminiModels reads Gemini's NATIVE GET /v1beta/models (auth via the
// ?key= query param, which is what that surface accepts — not a Bearer header).
// Chat capability comes from the provider: only models advertising
// generateContent can hold a conversation, so embedding/imagen/veo/aqa entries
// drop out without any name guessing.
func listGeminiModels(ctx context.Context, baseURL, apiKey string) ([]string, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("an API key is required to list Gemini models")
	}
	base := strings.TrimSpace(baseURL)
	if base == "" {
		base = "https://generativelanguage.googleapis.com/v1beta"
	}
	var out struct {
		Models []struct {
			Name        string   `json:"name"`
			Methods     []string `json:"supportedGenerationMethods"`
			Description string   `json:"description"`
		} `json:"models"`
	}
	if err := httpGetJSON(ctx, joinURL(base, "/models?pageSize=200&key="+url.QueryEscape(apiKey)), nil, &out); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(out.Models))
	for _, m := range out.Models {
		id := strings.TrimPrefix(m.Name, "models/")
		if id == "" {
			continue
		}
		for _, meth := range m.Methods {
			if meth == "generateContent" {
				ids = append(ids, id)
				break
			}
		}
	}
	return ids, nil
}

// listOllamaModels reads the locally pulled tags from a running daemon.
func listOllamaModels(ctx context.Context, baseURL string) ([]string, error) {
	base := strings.TrimSpace(baseURL)
	if base == "" {
		base = defaultOllamaBase
	}
	var out struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := httpGetJSON(ctx, joinURL(base, "/api/tags"), nil, &out); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(out.Models))
	for _, m := range out.Models {
		if m.Name != "" {
			ids = append(ids, m.Name)
		}
	}
	return ids, nil
}

// httpGetJSON is httpJSON's GET twin — same non-2xx-body-as-error behaviour so
// the panel can show the provider's own message ("invalid x-api-key", …).
func httpGetJSON(ctx context.Context, url string, headers map[string]string, out any) error {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
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
		if len(snippet) > 300 {
			snippet = snippet[:300] + "…"
		}
		return fmt.Errorf("provider HTTP %d: %s", resp.StatusCode, snippet)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

// friendlyProviderError turns a provider's raw HTTP error body into one
// actionable sentence.
//
// ⚠️ Written for the panel, which shows the message verbatim. Google's quota
// body in particular is ~800 characters of repeated per-metric lines
// ("Quota exceeded for metric: …generate_content_free_tier_input_token_count,
// limit: 0, model: gemini-3.1-pro" ×N plus two doc links), which tells the user
// nothing they can act on and buries the one fact that matters: the model needs
// a plan this key doesn't have. The raw text still goes to the agent log — only
// the surfaced message is condensed.
func friendlyProviderError(model string, err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	named := model
	if named == "" {
		named = "this model"
	}
	switch {
	case strings.Contains(msg, "HTTP 429"):
		// `limit: 0` means the plan grants NO quota for this model at all —
		// a different situation from "you've used up today's allowance", and
		// retrying will never help.
		if strings.Contains(msg, "limit: 0") {
			return fmt.Sprintf("%s is not included in this API key's plan (quota limit is 0). Pick a different model — the flash models are the ones available on Gemini's free tier — or enable billing for this key.", named)
		}
		return fmt.Sprintf("Rate limit / quota exceeded for %s. Wait and retry, pick a lighter model, or check your plan's limits.", named)
	case strings.Contains(msg, "HTTP 404") && strings.Contains(strings.ToLower(msg), "no longer available"):
		return fmt.Sprintf("%s has been withdrawn by the provider and can't be used by new keys. Pick a current model from the list (the \"-latest\" aliases always resolve to one).", named)
	case strings.Contains(msg, "HTTP 404"):
		return fmt.Sprintf("%s was not found by the provider. Check the model name, or pick one from the list.", named)
	case strings.Contains(msg, "HTTP 401"), strings.Contains(msg, "HTTP 403"):
		return "The provider rejected the credentials. Re-check the API key (or sign in again) in the agent settings."
	}
	// ⚠️ Not every bad-credential answer is a 401 — Google returns **400**
	// "Please pass a valid API key", so match on the text too or a plain typo in
	// the key surfaces as a raw JSON blob.
	low := strings.ToLower(msg)
	if strings.Contains(low, "api key not valid") || strings.Contains(low, "pass a valid api key") ||
		strings.Contains(low, "invalid api key") || strings.Contains(low, "incorrect api key") {
		return "The provider rejected the API key. Re-check it in the agent settings."
	}
	return msg
}
