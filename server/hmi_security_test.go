package main

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestHMI(t *testing.T) *HMIManager {
	t.Helper()
	return NewHMIManager(slog.Default(), NewUserStore(), NewSessionStore(), newTestIPC(65536), t.TempDir())
}

const hmiLayoutNoUsers = `{"pages":[{"id":"p1","name":"Main","components":[]}],"auth":{"users":[]}}`

func hmiLayoutWithUser(hash string) string {
	return `{"pages":[{"id":"p1","name":"Main","components":[]}],"auth":{"users":[` +
		`{"id":"u1","username":"op","passwordHash":"` + hash + `","salt":"s","role":"operator"}]}}`
}

func hmiDo(h http.HandlerFunc, method, body, contentType string, cookie *http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/hmi/api/write", strings.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func TestHMIWriteRules(t *testing.T) {
	hm := newTestHMI(t)

	// Nothing deployed → 503 for the data API.
	if rec := hmiDo(hm.handleAPIWrite, http.MethodPost, `{}`, "application/json", nil); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("write without HMI: %d, want 503", rec.Code)
	}
	if rec := hmiDo(hm.handleAPIVariables, http.MethodGet, "", "", nil); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("read without HMI: %d, want 503", rec.Code)
	}

	// Deployed with no users: reads stay open, writes are refused.
	if err := hm.LoadJSON([]byte(hmiLayoutNoUsers)); err != nil {
		t.Fatal(err)
	}
	if rec := hmiDo(hm.handleAPIVariables, http.MethodGet, "", "", nil); rec.Code != http.StatusOK {
		t.Fatalf("open read: %d, want 200", rec.Code)
	}
	rec := hmiDo(hm.handleAPIWrite, http.MethodPost, `{"key":"x","value":1}`, "application/json", nil)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "at least one HMI user") {
		t.Fatalf("anonymous write: %d %s, want 403", rec.Code, rec.Body.String())
	}

	// With a user: a logged-in operator must still send JSON.
	if err := hm.LoadJSON([]byte(hmiLayoutWithUser(hashPassword("s", "pw")))); err != nil {
		t.Fatal(err)
	}
	sess := hm.sessions.Create("op", RoleOperator)
	ck := &http.Cookie{Name: sessionCookieName, Value: sess.Token}
	if rec := hmiDo(hm.handleAPIWrite, http.MethodPost, `key=x`, "application/x-www-form-urlencoded", ck); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("form-encoded write: %d, want 415", rec.Code)
	}
}

func TestHMILoginRequiresJSON(t *testing.T) {
	hm := newTestHMI(t)
	if err := hm.LoadJSON([]byte(hmiLayoutWithUser(hashPassword("s", "pw")))); err != nil {
		t.Fatal(err)
	}
	post := func(body, ct string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/hmi/login", strings.NewReader(body))
		req.Header.Set("Content-Type", ct)
		rec := httptest.NewRecorder()
		hm.handleLoginSubmit(rec, req)
		return rec
	}
	if rec := post("username=op&password=pw", "application/x-www-form-urlencoded"); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("form login: %d, want 415", rec.Code)
	}
	if rec := post(`{"username":"op","password":"bad"}`, "application/json"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad password: %d, want 401", rec.Code)
	}
	rec := post(`{"username":"op","password":"pw"}`, "application/json; charset=utf-8")
	if rec.Code != http.StatusOK || len(rec.Result().Cookies()) == 0 {
		t.Fatalf("good login: %d cookies=%d", rec.Code, len(rec.Result().Cookies()))
	}
}

// Changing the user set revokes HMI sessions; redeploying the same users does not.
func TestHMISessionsRevokedOnUserChange(t *testing.T) {
	hm := newTestHMI(t)
	if err := hm.LoadJSON([]byte(hmiLayoutWithUser(hashPassword("s", "pw")))); err != nil {
		t.Fatal(err)
	}
	tok := hm.sessions.Create("op", RoleOperator).Token
	if err := hm.LoadJSON([]byte(hmiLayoutWithUser(hashPassword("s", "pw")))); err != nil {
		t.Fatal(err)
	}
	if _, ok := hm.sessions.Get(tok); !ok {
		t.Fatal("session revoked by an identical redeploy")
	}
	if err := hm.LoadJSON([]byte(hmiLayoutWithUser(hashPassword("s", "new")))); err != nil {
		t.Fatal(err)
	}
	if _, ok := hm.sessions.Get(tok); ok {
		t.Fatal("session survived a password change")
	}
}

func TestHMILayoutPersistedPrivately(t *testing.T) {
	dir := t.TempDir()
	hm := NewHMIManager(slog.Default(), NewUserStore(), NewSessionStore(), nil, dir)
	if err := hm.LoadJSON([]byte(hmiLayoutNoUsers)); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dir, "hmi_layout.json"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("hmi_layout.json mode %v, want 0600 (it holds password hashes)", st.Mode().Perm())
	}
}

func TestHMIOriginGuard(t *testing.T) {
	h := hmiOriginGuard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	try := func(origin, host string) int {
		req := httptest.NewRequest(http.MethodPost, "http://"+host+"/api/write", nil)
		req.Host = host
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if c := try("", "panel.example:8080"); c != 204 {
		t.Fatalf("no Origin: %d", c)
	}
	if c := try("http://panel.example:8080", "panel.example:8080"); c != 204 {
		t.Fatalf("same origin by DNS name: %d", c)
	}
	if c := try("http://192.168.1.20:1420", "192.168.1.104:8080"); c != 204 {
		t.Fatalf("private origin: %d", c)
	}
	if c := try("https://evil.example", "panel.example:8080"); c != http.StatusForbidden {
		t.Fatalf("foreign origin: %d, want 403", c)
	}
}
