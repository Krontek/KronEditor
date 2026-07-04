package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// anthropic_oauth.go — "Sign in with your Claude account" (Pro/Max subscription)
// instead of an API key. Implements the same public PKCE OAuth flow Claude Code
// uses (client_id below is Claude Code's public client). Tokens are stored under
// AppDataDir and used as `Authorization: Bearer …` against /v1/messages with the
// `anthropic-beta: oauth-2025-04-20` header (see callAnthropic's oauth branch).
//
// CAVEATS (intentional, user opted in): gray-area ToS for a 3rd-party app using
// a subscription; covers ONLY Claude (not GPT/Gemini/DeepSeek); the subscription
// token requires the request to identify as Claude Code (we inject that system
// block); Anthropic can change/revoke this flow at any time.

const (
	anthropicOAuthClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e" // Claude Code's public client
	anthropicAuthorizeURL  = "https://claude.ai/oauth/authorize"
	anthropicTokenURL      = "https://console.anthropic.com/v1/oauth/token"
	// LOOPBACK redirect — verified from VSCode's working request. The Claude Code
	// client requires an `http://localhost:<port>/callback` loopback URI (RFC 8252);
	// the hosted `platform.claude.com/...callback` is REJECTED ("Invalid request
	// format"). The host-agent (already on :7171) serves /callback itself, so the
	// browser redirect lands back here and we exchange the code automatically
	// (no manual paste). Must byte-match in both the authorize URL and the token
	// exchange.
	anthropicRedirectURI = "http://localhost:7171/callback"
	// EXACT scope set from VSCode's working URL — six scopes; missing ANY of them
	// (esp. user:file_upload, which earlier attempts lacked) → "Invalid request format".
	anthropicOAuthScopes = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
	anthropicOAuthBeta   = "oauth-2025-04-20"
)

type anthropicTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresAt    int64  `json:"expires_at"` // unix seconds
}

type AnthropicOAuthState struct {
	mu        sync.Mutex
	verifiers map[string]string // login state → PKCE code_verifier (pending)
	tok       *anthropicTokens
	tokPath   string
}

func NewAnthropicOAuthState(appDataDir string) *AnthropicOAuthState {
	s := &AnthropicOAuthState{verifiers: map[string]string{}, tokPath: filepath.Join(appDataDir, "anthropic_oauth.json")}
	if b, err := os.ReadFile(s.tokPath); err == nil {
		var t anthropicTokens
		if json.Unmarshal(b, &t) == nil && t.AccessToken != "" {
			s.tok = &t
		}
	}
	return s
}

func (s *AnthropicOAuthState) save() {
	if s.tok == nil {
		_ = os.Remove(s.tokPath)
		return
	}
	if b, err := json.MarshalIndent(s.tok, "", "  "); err == nil {
		_ = os.WriteFile(s.tokPath, b, 0o600)
	}
}

func randB64(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func pkcePair() (verifier, challenge string) {
	verifier = randB64(32)
	h := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(h[:])
}

// POST /api/host/anthropic-oauth/start → { authorizeUrl } (also stores the PKCE
// verifier keyed by state for the later exchange).
func (s *Server) handleAnthropicOAuthStart(w http.ResponseWriter, r *http.Request) {
	st := s.anthropicOAuth
	verifier, challenge := pkcePair()
	state := randB64(32) // 32 bytes (43 base64url chars) — match VSCode's state length
	st.mu.Lock()
	if len(st.verifiers) > 8 { // drop stale pending logins
		st.verifiers = map[string]string{}
	}
	st.verifiers[state] = verifier
	st.mu.Unlock()

	// Build the query in VSCode/Claude Code's EXACT parameter ORDER (q.Encode()
	// sorts alphabetically, which claude.ai's authorize appears to reject as
	// "Invalid request format"). url.QueryEscape matches their encoding: %3A
	// colons, `+` spaces in scope; %2F/%3A in redirect_uri.
	params := []string{
		"code=true",
		"client_id=" + anthropicOAuthClientID,
		"response_type=code",
		"redirect_uri=" + url.QueryEscape(anthropicRedirectURI),
		"scope=" + url.QueryEscape(anthropicOAuthScopes),
		"code_challenge=" + challenge,
		"code_challenge_method=S256",
		"state=" + state,
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "authorizeUrl": anthropicAuthorizeURL + "?" + strings.Join(params, "&"), "state": state})
}

// POST /api/host/anthropic-oauth/exchange { code } — `code` is the "code#state"
// string the callback page shows the user to copy.
func (s *Server) handleAnthropicOAuthExchange(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	raw := strings.TrimSpace(req.Code)
	code, state := raw, ""
	if i := strings.IndexByte(raw, '#'); i >= 0 {
		code, state = raw[:i], raw[i+1:]
	}
	st := s.anthropicOAuth
	// Require an EXACT state match — using the single pending verifier for a
	// mismatched state would defeat the CSRF protection state exists for.
	st.mu.Lock()
	verifier := st.verifiers[state]
	st.mu.Unlock()
	if verifier == "" {
		writeError(w, http.StatusBadRequest, "no pending login matching this state — start sign-in again")
		return
	}
	tok, err := st.tokenRequest(url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"state":         {state},
		"client_id":     {anthropicOAuthClientID},
		"redirect_uri":  {anthropicRedirectURI},
		"code_verifier": {verifier},
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	st.mu.Lock()
	st.tok = tok
	delete(st.verifiers, state)
	st.save()
	st.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "connected": true})
}

// GET /callback — the loopback redirect target. claude.ai sends the browser
// here with ?code=…&state=… after the user authorizes. We exchange the code for
// tokens server-side and show a "you can close this tab" page; the panel detects
// the connection via its status poll. No manual code paste.
func (s *Server) handleAnthropicOAuthCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	code, state := q.Get("code"), q.Get("state")
	page := func(title, msg string) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><meta charset=utf-8><title>%s</title><body style="font-family:system-ui;background:#1e1e1e;color:#ddd;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#4ec9b0">%s</h2><p>%s</p></div>`, title, title, msg)
	}
	if errMsg := q.Get("error"); errMsg != "" {
		page("Authorization failed", "Claude returned: "+errMsg+". You can close this tab.")
		return
	}
	if code == "" {
		page("Authorization failed", "No code returned. You can close this tab and try again.")
		return
	}
	st := s.anthropicOAuth
	// Exact state match only (see handleAnthropicOAuthExchange).
	st.mu.Lock()
	verifier := st.verifiers[state]
	st.mu.Unlock()
	if verifier == "" {
		page("Authorization failed", "No pending sign-in matching this request. Start again from KronEditor.")
		return
	}
	tok, err := st.tokenRequest(url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"state":         {state},
		"client_id":     {anthropicOAuthClientID},
		"redirect_uri":  {anthropicRedirectURI},
		"code_verifier": {verifier},
	})
	if err != nil {
		page("Authorization failed", "Token exchange error: "+err.Error())
		return
	}
	st.mu.Lock()
	st.tok = tok
	delete(st.verifiers, state)
	st.save()
	st.mu.Unlock()
	page("Signed in to Claude ✓", "You can close this tab and return to KronEditor.")
}

func (s *Server) handleAnthropicOAuthStatus(w http.ResponseWriter, r *http.Request) {
	st := s.anthropicOAuth
	st.mu.Lock()
	connected := st.tok != nil
	var exp int64
	if st.tok != nil {
		exp = st.tok.ExpiresAt
	}
	st.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "connected": connected, "expiresAt": exp})
}

func (s *Server) handleAnthropicOAuthLogout(w http.ResponseWriter, r *http.Request) {
	st := s.anthropicOAuth
	st.mu.Lock()
	st.tok = nil
	st.save()
	st.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (st *AnthropicOAuthState) tokenRequest(form url.Values) (*anthropicTokens, error) {
	// Anthropic's token endpoint wants form-urlencoded, NOT JSON.
	req, err := http.NewRequest(http.MethodPost, anthropicTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("oauth connect: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet := strings.TrimSpace(string(raw))
		if len(snippet) > 400 {
			snippet = snippet[:400]
		}
		return nil, fmt.Errorf("oauth token HTTP %d: %s", resp.StatusCode, snippet)
	}
	var out struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("oauth decode: %w", err)
	}
	if out.AccessToken == "" {
		return nil, fmt.Errorf("oauth: no access_token in response")
	}
	return &anthropicTokens{AccessToken: out.AccessToken, RefreshToken: out.RefreshToken, ExpiresAt: time.Now().Unix() + out.ExpiresIn}, nil
}

// accessToken returns a currently-valid access token, refreshing if it expires
// within 60s. `force` refreshes unconditionally (used on a 401 retry).
//
// The mutex is NOT held across the (up to 30s) refresh HTTP call — holding it
// would block every OAuth endpoint and chat for the duration. Instead the
// refresh token is snapshotted, the lock dropped for the network round-trip,
// and on re-lock we check whether another goroutine (or a fresh login) already
// stored a different token in the meantime — if so, theirs wins.
func (st *AnthropicOAuthState) accessToken(force bool) (string, error) {
	st.mu.Lock()
	if st.tok == nil {
		st.mu.Unlock()
		return "", fmt.Errorf("not signed in to a Claude account")
	}
	if !force && st.tok.ExpiresAt-time.Now().Unix() >= 60 {
		tok := st.tok.AccessToken
		st.mu.Unlock()
		return tok, nil
	}
	prevAccess := st.tok.AccessToken
	refresh := st.tok.RefreshToken
	st.mu.Unlock()

	tok, err := st.tokenRequest(url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refresh},
		"client_id":     {anthropicOAuthClientID},
	})

	st.mu.Lock()
	defer st.mu.Unlock()
	if st.tok == nil {
		// Logged out while we were on the wire.
		return "", fmt.Errorf("not signed in to a Claude account")
	}
	if st.tok.AccessToken != prevAccess {
		// Someone else refreshed (or re-logged-in) already — use their token
		// and discard ours (refresh tokens may be single-use).
		return st.tok.AccessToken, nil
	}
	if err != nil {
		return "", fmt.Errorf("token refresh failed (sign in again): %w", err)
	}
	st.tok = tok
	st.save()
	return st.tok.AccessToken, nil
}
