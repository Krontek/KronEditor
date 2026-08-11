package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Anthropic rejects a zero-length text block with
//
//	400 invalid_request_error "messages: text content blocks must be non-empty"
//
// and because the offending turn stays in the caller's history, that 400 then
// repeats for every LATER message — one empty model reply bricks the whole
// conversation instead of failing a single turn. Observed in the field:
// the model returned no text and no tool calls, the panel stored the empty turn,
// and the next user message ("yaptin mi?") 400'd, as did everything after it.
//
// These tests pin the serializer: no request callAnthropic builds may contain an
// empty text block, whatever the history looks like.

// captureAnthropic stands in for the real API: it records the request body and
// answers with a minimal valid completion.
func captureAnthropic(t *testing.T, got *map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"ok"}]}`))
	}))
}

// emptyTextBlocks returns a description of every zero-length text block in the
// serialized messages, so a failure names exactly what would be rejected.
func emptyTextBlocks(t *testing.T, payload map[string]any) []string {
	t.Helper()
	var bad []string
	msgs, _ := payload["messages"].([]any)
	for i, m := range msgs {
		mm, _ := m.(map[string]any)
		role, _ := mm["role"].(string)
		blocks, _ := mm["content"].([]any)
		for j, b := range blocks {
			bb, _ := b.(map[string]any)
			if bb["type"] != "text" {
				continue
			}
			if s, _ := bb["text"].(string); s == "" {
				bad = append(bad, role+" message "+itoa(i)+" block "+itoa(j))
			}
		}
	}
	return bad
}

func itoa(i int) string { return string(rune('0' + i)) }

func TestAnthropicDropsDeadAssistantTurn(t *testing.T) {
	var got map[string]any
	srv := captureAnthropic(t, &got)
	defer srv.Close()

	// The exact shape that bricked the conversation: a dead assistant turn
	// (no text, no tool calls) followed by the user's next message.
	req := aiChatReq{
		Provider: "anthropic",
		Model:    "claude-opus-5",
		APIKey:   "test",
		BaseURL:  srv.URL,
		Messages: []aiMessage{
			{Role: "user", Content: "rewrite esc_control"},
			{Role: "assistant", Content: ""},
			{Role: "user", Content: "yaptin mi?"},
		},
	}
	if _, err := callAnthropic(context.Background(), req, ""); err != nil {
		t.Fatalf("callAnthropic: %v", err)
	}
	if bad := emptyTextBlocks(t, got); len(bad) > 0 {
		t.Fatalf("payload carries empty text block(s) the API rejects: %v", bad)
	}
	// The dead turn must be gone; the two user turns merge into one.
	msgs, _ := got["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1 (dead assistant turn dropped, the two user turns merged)", len(msgs))
	}
	if m, _ := msgs[0].(map[string]any); m["role"] != "user" {
		t.Fatalf("surviving message role = %v, want user", m["role"])
	}
}

// An assistant turn with no text but WITH tool calls is legitimate and must
// still be sent — only the tool_use blocks, never a padding empty text block.
func TestAnthropicToolOnlyAssistantTurnKept(t *testing.T) {
	var got map[string]any
	srv := captureAnthropic(t, &got)
	defer srv.Close()

	req := aiChatReq{
		Provider: "anthropic", Model: "claude-opus-5", APIKey: "test", BaseURL: srv.URL,
		Messages: []aiMessage{
			{Role: "user", Content: "list the timers"},
			{Role: "assistant", Content: "", ToolCalls: []aiToolCall{
				{ID: "t1", Name: "list_blocks", Arguments: json.RawMessage(`{"filter":"Time"}`)},
			}},
			{Role: "tool", ToolCallID: "t1", Name: "list_blocks", Content: `{"standard":[]}`},
		},
	}
	if _, err := callAnthropic(context.Background(), req, ""); err != nil {
		t.Fatalf("callAnthropic: %v", err)
	}
	if bad := emptyTextBlocks(t, got); len(bad) > 0 {
		t.Fatalf("payload carries empty text block(s): %v", bad)
	}
	msgs, _ := got["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3 (user, tool-only assistant, tool result)", len(msgs))
	}
	assistant, _ := msgs[1].(map[string]any)
	blocks, _ := assistant["content"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("tool-only assistant turn has %d blocks, want exactly the 1 tool_use", len(blocks))
	}
	if b, _ := blocks[0].(map[string]any); b["type"] != "tool_use" {
		t.Fatalf("block type = %v, want tool_use", b["type"])
	}
}

// A user turn carrying only an image must keep the image and add no empty text
// block (the old code appended m.Content unconditionally).
func TestAnthropicImageOnlyUserTurnHasNoEmptyText(t *testing.T) {
	var got map[string]any
	srv := captureAnthropic(t, &got)
	defer srv.Close()

	req := aiChatReq{
		Provider: "anthropic", Model: "claude-opus-5", APIKey: "test", BaseURL: srv.URL,
		Messages: []aiMessage{
			{Role: "user", Content: "", Images: []aiImage{{MimeType: "image/png", Data: "aGk="}}},
		},
	}
	if _, err := callAnthropic(context.Background(), req, ""); err != nil {
		t.Fatalf("callAnthropic: %v", err)
	}
	if bad := emptyTextBlocks(t, got); len(bad) > 0 {
		t.Fatalf("payload carries empty text block(s): %v", bad)
	}
	msgs, _ := got["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1", len(msgs))
	}
	m, _ := msgs[0].(map[string]any)
	blocks, _ := m["content"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("image-only turn has %d blocks, want exactly the 1 image", len(blocks))
	}
	if b, _ := blocks[0].(map[string]any); b["type"] != "image" {
		t.Fatalf("block type = %v, want image", b["type"])
	}
}
