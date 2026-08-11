package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A turn the provider cut short must never be presented as the model's answer.
//
// Measured against the live API (claude-opus-5, subscription OAuth) with the
// old 4096-token default, which is what these tests exist to keep fixed:
//
//   - max_tokens spent entirely on `thinking` → content=[{"type":"thinking"}],
//     no text, no tool_use. The agent panel showed an empty bubble and went
//     quiet mid-task; retrying produced the same empty turn.
//   - max_tokens hit mid tool-call → the tool_use comes back with its input
//     PARTIALLY PARSED, unfinished keys simply gone: a set_st_code arrived as
//     {"pou":"esc_control"} with no `code`. Executed as-is, a half-generated
//     `rungs` array would have replaced a whole POU with the fragment.
//
// Both are indistinguishable from a well-formed response unless stop_reason is
// checked, which is what callAnthropic/callOpenAI now do.

// truncatedAnthropic answers with a partial tool call and stop_reason=max_tokens,
// exactly as the real API does when the budget runs out mid-arguments.
func truncatedAnthropic(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"stop_reason":"max_tokens","content":[
			{"type":"tool_use","id":"tu_1","name":"set_st_code","input":{"pou":"esc_control"}}]}`))
	}))
}

func TestAnthropicTruncatedToolCallIsRejected(t *testing.T) {
	srv := truncatedAnthropic(t)
	defer srv.Close()

	msg, err := callAnthropic(context.Background(), aiChatReq{
		BaseURL:   srv.URL,
		Model:     "claude-opus-5",
		MaxTokens: 4096,
		Messages:  []aiMessage{{Role: "user", Content: "fix esc_control"}},
	}, "")

	if err == nil {
		t.Fatalf("truncated turn was accepted; tool calls returned: %+v", msg.ToolCalls)
	}
	if len(msg.ToolCalls) != 0 {
		t.Errorf("a rejected turn must carry no tool calls, got %d", len(msg.ToolCalls))
	}
	// The message is shown to the user verbatim (friendlyProviderError passes it
	// through), so it has to name the cause, not just fail.
	if !strings.Contains(err.Error(), "cut off") || !strings.Contains(err.Error(), "nothing was applied") {
		t.Errorf("error must explain the truncation and that nothing was applied, got: %v", err)
	}
}

// The thinking-only shape: no text, no tool_use, and only stop_reason says why.
func TestAnthropicThinkingOnlyTurnIsRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"stop_reason":"max_tokens","content":[{"type":"thinking","thinking":""}],
			"usage":{"output_tokens":4096}}`))
	}))
	defer srv.Close()

	if _, err := callAnthropic(context.Background(), aiChatReq{
		BaseURL: srv.URL, Model: "claude-opus-5", MaxTokens: 4096,
		Messages: []aiMessage{{Role: "user", Content: "devam"}},
	}, ""); err == nil {
		t.Fatal("a thinking-only turn is an exhausted budget, not an answer — must fail")
	}
}

// A complete turn must stay unaffected by the guard.
func TestAnthropicCompleteTurnUnaffected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"stop_reason":"tool_use","content":[
			{"type":"text","text":"applying"},
			{"type":"tool_use","id":"tu_1","name":"set_st_code","input":{"pou":"p","code":"x := 1;"}}]}`))
	}))
	defer srv.Close()

	msg, err := callAnthropic(context.Background(), aiChatReq{
		BaseURL: srv.URL, Model: "claude-opus-5", MaxTokens: defaultMaxTokens,
		Messages: []aiMessage{{Role: "user", Content: "go"}},
	}, "")
	if err != nil {
		t.Fatalf("complete turn rejected: %v", err)
	}
	if msg.Content != "applying" || len(msg.ToolCalls) != 1 {
		t.Fatalf("complete turn mangled: content=%q calls=%d", msg.Content, len(msg.ToolCalls))
	}
}

// Raising the default must not strand a model whose own cap is lower: the
// provider names its limit in the 400, so we clamp to it and retry once.
func TestAnthropicClampsToProviderMaxTokens(t *testing.T) {
	var sent []float64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mt, _ := body["max_tokens"].(float64)
		sent = append(sent, mt)
		w.Header().Set("Content-Type", "application/json")
		if mt > 8192 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"type":"error","error":{"type":"invalid_request_error",` +
				`"message":"max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for legacy-model"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"stop_reason":"end_turn","content":[{"type":"text","text":"ok"}]}`))
	}))
	defer srv.Close()

	msg, err := callAnthropic(context.Background(), aiChatReq{
		BaseURL: srv.URL, Model: "legacy-model", MaxTokens: 32000,
		Messages: []aiMessage{{Role: "user", Content: "hi"}},
	}, "")
	if err != nil {
		t.Fatalf("clamped retry failed: %v", err)
	}
	if msg.Content != "ok" {
		t.Fatalf("content = %q, want ok", msg.Content)
	}
	if len(sent) != 2 || sent[0] != 32000 || sent[1] != 8192 {
		t.Fatalf("want one 32000 attempt then a 8192 retry, got %v", sent)
	}
}

// An unrelated 400 must NOT trigger a retry.
func TestAnthropicDoesNotRetryUnrelatedError(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"type":"error","error":{"message":"messages: text content blocks must be non-empty"}}`))
	}))
	defer srv.Close()

	if _, err := callAnthropic(context.Background(), aiChatReq{
		BaseURL: srv.URL, Model: "claude-opus-5", MaxTokens: 32000,
		Messages: []aiMessage{{Role: "user", Content: "hi"}},
	}, ""); err == nil {
		t.Fatal("expected the 400 to surface")
	}
	if calls != 1 {
		t.Fatalf("unrelated 400 must not be retried, got %d calls", calls)
	}
}

// OpenAI-shaped providers spell the same condition "length".
func TestOpenAITruncatedTurnIsRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"length","message":{"content":"","tool_calls":[
			{"id":"c1","function":{"name":"set_ladder","arguments":"{\"pou\":\"esc_control\"}"}}]}}]}`))
	}))
	defer srv.Close()

	msg, err := callOpenAI(context.Background(), aiChatReq{
		Model:    "gpt-4o",
		Messages: []aiMessage{{Role: "user", Content: "fix it"}},
	}, srv.URL)
	if err == nil {
		t.Fatalf("truncated turn accepted; tool calls: %+v", msg.ToolCalls)
	}
	if len(msg.ToolCalls) != 0 {
		t.Errorf("a rejected turn must carry no tool calls, got %d", len(msg.ToolCalls))
	}
}

func TestParseMaxTokensLimit(t *testing.T) {
	cases := []struct {
		in   string
		want int
		ok   bool
	}{
		{"provider HTTP 400: max_tokens: 32000 > 8192, which is the maximum", 8192, true},
		{"provider HTTP 400: max_tokens:32000>128000", 128000, true},
		{"provider HTTP 429: rate limit exceeded", 0, false},
		{"", 0, false},
	}
	for _, c := range cases {
		var err error
		if c.in != "" {
			err = errString(c.in)
		}
		got, ok := parseMaxTokensLimit(err)
		if ok != c.ok || got != c.want {
			t.Errorf("parseMaxTokensLimit(%q) = %d,%v want %d,%v", c.in, got, ok, c.want, c.ok)
		}
	}
	if _, ok := parseMaxTokensLimit(nil); ok {
		t.Error("nil error must not report a limit")
	}
}

type errString string

func (e errString) Error() string { return string(e) }
