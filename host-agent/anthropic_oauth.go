package main

import (
	"bytes"
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
	anthropicRedirectURI   = "https://console.anthropic.com/oauth/code/callback"
	anthropicOAuthScopes   = "org:create_api_key user:profile user:inference"
	anthropicOAuthBeta     = "oauth-2025-04-20"
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
	state := randB64(16)
	st.mu.Lock()
	if len(st.verifiers) > 8 { // drop stale pending logins
		st.verifiers = map[string]string{}
	}
	st.verifiers[state] = verifier
	st.mu.Unlock()

	q := url.Values{}
	q.Set("code", "true")
	q.Set("client_id", anthropicOAuthClientID)
	q.Set("response_type", "code")
	q.Set("redirect_uri", anthropicRedirectURI)
	q.Set("scope", anthropicOAuthScopes)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("state", state)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "authorizeUrl": anthropicAuthorizeURL + "?" + q.Encode(), "state": state})
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
	st.mu.Lock()
	verifier := st.verifiers[state]
	if verifier == "" && len(st.verifiers) == 1 { // single pending login → use it
		for _, v := range st.verifiers {
			verifier = v
		}
	}
	st.mu.Unlock()
	if verifier == "" {
		writeError(w, http.StatusBadRequest, "no pending login — start sign-in again")
		return
	}
	tok, err := st.tokenRequest(map[string]any{
		"grant_type":    "authorization_code",
		"code":          code,
		"state":         state,
		"client_id":     anthropicOAuthClientID,
		"redirect_uri":  anthropicRedirectURI,
		"code_verifier": verifier,
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

func (st *AnthropicOAuthState) tokenRequest(body map[string]any) (*anthropicTokens, error) {
	buf, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, anthropicTokenURL, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
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
func (st *AnthropicOAuthState) accessToken(force bool) (string, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.tok == nil {
		return "", fmt.Errorf("not signed in to a Claude account")
	}
	if force || st.tok.ExpiresAt-time.Now().Unix() < 60 {
		tok, err := st.tokenRequest(map[string]any{
			"grant_type":    "refresh_token",
			"refresh_token": st.tok.RefreshToken,
			"client_id":     anthropicOAuthClientID,
		})
		if err != nil {
			return "", fmt.Errorf("token refresh failed (sign in again): %w", err)
		}
		st.tok = tok
		st.save()
	}
	return st.tok.AccessToken, nil
}
