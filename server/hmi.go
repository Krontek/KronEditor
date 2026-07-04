package main

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ---------------------------------------------------------------------------
// HMI XML types  (mirrors KronEditor's hmiComponentDefs.js)
// ---------------------------------------------------------------------------

type HMIConfig struct {
	XMLName xml.Name  `xml:"KronHMI"`
	Version string    `xml:"version,attr"`
	Auth    HMIAuth   `xml:"Auth"`
	Pages   []HMIPage `xml:"Pages>Page"`
}

type HMIAuth struct {
	Users       []HMIUserDef  `xml:"Users>User"`
	Permissions []HMIPagePerm `xml:"Permissions>Page"`
}

// HMIUserDef is the XML representation of a user (password is hashed + salted).
type HMIUserDef struct {
	ID           string `xml:"id,attr"`
	Username     string `xml:"username,attr"`
	PasswordHash string `xml:"passwordHash,attr"`
	Salt         string `xml:"salt,attr"`
	Role         string `xml:"role,attr"`
}

// HMIPagePerm defines which roles may read/write a page.
type HMIPagePerm struct {
	PageRef    string `xml:"ref,attr"`
	ReadRoles  string `xml:"readRoles,attr"`  // comma-separated role names
	WriteRoles string `xml:"writeRoles,attr"` // comma-separated role names
}

type HMIPage struct {
	ID         string         `xml:"id,attr"`
	Name       string         `xml:"name,attr"`
	CanvasW    int            `xml:"canvasW,attr"`
	CanvasH    int            `xml:"canvasH,attr"`
	Components []HMIComponent `xml:"Components>Component"`
}

// HMIComponent stores per-component layout; props is a JSON blob.
type HMIComponent struct {
	ID    string `xml:"id,attr"`
	Type  string `xml:"type,attr"`
	X     int    `xml:"x,attr"`
	Y     int    `xml:"y,attr"`
	W     int    `xml:"w,attr"`
	H     int    `xml:"h,attr"`
	Props string `xml:"props,attr"` // raw JSON string
}

// ---------------------------------------------------------------------------
// HMIManager – holds the active HMI config and serves it
// ---------------------------------------------------------------------------

type pagePermCache struct {
	readRoles  map[Role]bool
	writeRoles map[Role]bool
}

type HMIManager struct {
	mu          sync.RWMutex
	config      *HMIConfig
	permMap     map[string]*pagePermCache // pageID → perms
	loaded      bool
	log         *slog.Logger
	users       *UserStore
	sessions    *SessionStore
	ipc         *IPCManager
	persistPath string // file path for disk persistence (empty = no persistence)
}

func NewHMIManager(log *slog.Logger, users *UserStore, sessions *SessionStore, ipc *IPCManager, deployDir string) *HMIManager {
	hm := &HMIManager{
		log:         log,
		users:       users,
		sessions:    sessions,
		ipc:         ipc,
		persistPath: filepath.Join(deployDir, "hmi_layout.json"),
	}
	// Load persisted HMI config from previous deployment (if any).
	if data, err := os.ReadFile(hm.persistPath); err == nil {
		if lerr := hm.LoadJSON(data); lerr != nil {
			log.Warn("Failed to restore HMI layout from disk", "path", hm.persistPath, "err", lerr)
		} else {
			log.Info("HMI layout restored from disk", "path", hm.persistPath)
		}
	}
	return hm
}

// loadConfig builds internal state from a parsed HMIConfig.
// Called by both Load (XML) and LoadJSON.
func (hm *HMIManager) loadConfig(cfg *HMIConfig) {
	userList := make([]User, 0, len(cfg.Auth.Users))
	for _, ud := range cfg.Auth.Users {
		role, ok := ParseRole(ud.Role)
		if !ok {
			role = RoleViewer
		}
		userList = append(userList, User{
			ID:           ud.ID,
			Username:     ud.Username,
			Role:         role,
			PasswordHash: ud.PasswordHash,
			Salt:         ud.Salt,
		})
	}
	hm.users.LoadUsers(userList)

	permMap := make(map[string]*pagePermCache)
	defaultPerm := &pagePermCache{
		readRoles:  map[Role]bool{RoleViewer: true, RoleOperator: true, RoleMaintainer: true, RoleAdmin: true},
		writeRoles: map[Role]bool{RoleOperator: true, RoleMaintainer: true, RoleAdmin: true},
	}
	explicitPerms := make(map[string]*HMIPagePerm)
	for i := range cfg.Auth.Permissions {
		p := &cfg.Auth.Permissions[i]
		explicitPerms[p.PageRef] = p
	}
	for _, pg := range cfg.Pages {
		if ep, ok := explicitPerms[pg.ID]; ok {
			permMap[pg.ID] = &pagePermCache{
				readRoles:  parseRoleSet(ep.ReadRoles),
				writeRoles: parseRoleSet(ep.WriteRoles),
			}
		} else {
			permMap[pg.ID] = defaultPerm
		}
	}

	hm.mu.Lock()
	hm.config = cfg
	hm.permMap = permMap
	hm.loaded = true
	hm.mu.Unlock()

	hm.log.Info("HMI config loaded", "pages", len(cfg.Pages), "users", len(userList))
}

// Load parses and stores a new HMI config from XML bytes.
func (hm *HMIManager) Load(data []byte) error {
	var cfg HMIConfig
	if err := xml.Unmarshal(data, &cfg); err != nil {
		return fmt.Errorf("parse HMI XML: %w", err)
	}
	hm.loadConfig(&cfg)
	return nil
}

// ---------------------------------------------------------------------------
// JSON layout types  (mirrors KronEditor's hmiLayout state)
// ---------------------------------------------------------------------------

type hmiLayoutJSON struct {
	Pages []hmiPageJSON `json:"pages"`
	Auth  hmiAuthJSON   `json:"auth"`
}

type hmiPageJSON struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	CanvasW    int           `json:"canvasW"`
	CanvasH    int           `json:"canvasH"`
	Components []hmiCompJSON `json:"components"`
}

type hmiCompJSON struct {
	ID    string          `json:"id"`
	Type  string          `json:"type"`
	X     int             `json:"x"`
	Y     int             `json:"y"`
	W     int             `json:"w"`
	H     int             `json:"h"`
	Props json.RawMessage `json:"props"`
}

type hmiAuthJSON struct {
	Users     []hmiUserJSON            `json:"users"`
	PagePerms map[string]hmiPermJSON   `json:"pagePerms"`
}

type hmiUserJSON struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"`
	Salt         string `json:"salt"`
	Role         string `json:"role"`
}

type hmiPermJSON struct {
	ReadRoles  []string `json:"readRoles"`
	WriteRoles []string `json:"writeRoles"`
}

// LoadJSON parses the KronEditor JSON layout format.
// Empty payload or zero pages clears the HMI config (loaded = false).
func (hm *HMIManager) LoadJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "{}" {
		hm.mu.Lock()
		hm.loaded = false
		hm.config = nil
		hm.permMap = nil
		hm.mu.Unlock()
		hm.users.LoadUsers(nil)
		hm.log.Info("HMI config cleared (empty layout)")
		return nil
	}

	var layout hmiLayoutJSON
	if err := json.Unmarshal(data, &layout); err != nil {
		return fmt.Errorf("parse HMI JSON: %w", err)
	}

	if len(layout.Pages) == 0 {
		hm.mu.Lock()
		hm.loaded = false
		hm.config = nil
		hm.permMap = nil
		hm.mu.Unlock()
		hm.users.LoadUsers(nil)
		hm.log.Info("HMI config cleared (no pages)")
		return nil
	}

	// Convert JSON layout → HMIConfig (reuses all downstream handler logic)
	cfg := &HMIConfig{Version: "1.0"}
	for _, pg := range layout.Pages {
		page := HMIPage{
			ID: pg.ID, Name: pg.Name,
			CanvasW: pg.CanvasW, CanvasH: pg.CanvasH,
		}
		for _, c := range pg.Components {
			propsStr := "{}"
			if len(c.Props) > 0 {
				propsStr = string(c.Props)
			}
			page.Components = append(page.Components, HMIComponent{
				ID: c.ID, Type: c.Type,
				X: c.X, Y: c.Y, W: c.W, H: c.H,
				Props: propsStr,
			})
		}
		cfg.Pages = append(cfg.Pages, page)
	}
	for _, u := range layout.Auth.Users {
		cfg.Auth.Users = append(cfg.Auth.Users, HMIUserDef{
			ID: u.ID, Username: u.Username,
			PasswordHash: u.PasswordHash, Salt: u.Salt, Role: u.Role,
		})
	}
	for pageID, perm := range layout.Auth.PagePerms {
		cfg.Auth.Permissions = append(cfg.Auth.Permissions, HMIPagePerm{
			PageRef:    pageID,
			ReadRoles:  strings.Join(perm.ReadRoles, ","),
			WriteRoles: strings.Join(perm.WriteRoles, ","),
		})
	}

	hm.loadConfig(cfg)

	// Persist to disk so the config survives server restarts.
	if hm.persistPath != "" {
		if err := os.MkdirAll(filepath.Dir(hm.persistPath), 0755); err == nil {
			if werr := os.WriteFile(hm.persistPath, data, 0644); werr != nil {
				hm.log.Warn("Failed to persist HMI layout to disk", "path", hm.persistPath, "err", werr)
			}
		}
	}

	return nil
}

func (hm *HMIManager) IsLoaded() bool {
	hm.mu.RLock()
	defer hm.mu.RUnlock()
	return hm.loaded
}

// pageCanRead returns true if the given role may read the page.
func (hm *HMIManager) pageCanRead(pageID string, role Role) bool {
	hm.mu.RLock()
	defer hm.mu.RUnlock()
	p, ok := hm.permMap[pageID]
	if !ok {
		return role >= RoleViewer // fallback: allow any logged-in user
	}
	return p.readRoles[role]
}

// pageCanWrite returns true if the given role may write to the page.
func (hm *HMIManager) pageCanWrite(pageID string, role Role) bool {
	hm.mu.RLock()
	defer hm.mu.RUnlock()
	p, ok := hm.permMap[pageID]
	if !ok {
		return role >= RoleOperator
	}
	return p.writeRoles[role]
}

func parseRoleSet(s string) map[Role]bool {
	m := make(map[Role]bool)
	for _, name := range strings.Split(s, ",") {
		name = strings.TrimSpace(name)
		if r, ok := ParseRole(name); ok {
			m[r] = true
		}
	}
	return m
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

// hmiBase returns the path prefix the HMI is served under for this request.
// The operator-facing listener serves at the root ("" → http://ip:port/);
// the agent port serves the same UI under "/hmi". Handlers and templates use
// this so links, fetch URLs, redirects and the session cookie path all match
// whichever listener handled the request.
func hmiBase(r *http.Request) string {
	if strings.HasPrefix(r.URL.Path, "/hmi") {
		return "/hmi"
	}
	return ""
}

// hmiCookiePath maps a base prefix to a session-cookie Path. At the root the
// cookie must cover "/" so it is sent for "/", "/api/*" and "/login".
func hmiCookiePath(base string) string {
	if base == "" {
		return "/"
	}
	return base
}

// RegisterHMIRoutes registers all /hmi/* routes on the given mux (agent port).
func RegisterHMIRoutes(mux *http.ServeMux, hm *HMIManager) {
	// Deploy endpoints (called from KronEditor)
	mux.HandleFunc("POST /hmi/deploy", hm.handleDeploy)
	mux.HandleFunc("POST /deploy/hmi-layout", hm.handleDeployHMILayout)

	// Auth endpoints (no session required)
	mux.HandleFunc("GET /hmi/login", hm.handleLoginPage)
	mux.HandleFunc("POST /hmi/login", hm.handleLoginSubmit)
	mux.HandleFunc("POST /hmi/logout", hm.handleLogout)

	// Main HMI page (session required only when users are configured)
	mux.HandleFunc("GET /hmi/", requireSession(hm.users, hm.sessions, hm.handleHMIPage))
	mux.HandleFunc("GET /hmi", requireSession(hm.users, hm.sessions, hm.handleHMIPage))

	// API (session required)
	mux.HandleFunc("GET /hmi/api/session", hm.handleAPISession)
	mux.HandleFunc("GET /hmi/api/layout", hm.handleAPILayout)
	mux.HandleFunc("GET /hmi/api/variables", hm.handleAPIVariables)
	mux.HandleFunc("POST /hmi/api/write", hm.handleAPIWrite)

	// User management (admin only)
	mux.HandleFunc("GET /hmi/api/users", requireRole(hm.sessions, RoleAdmin, hm.handleAPIUsersGet))
}

// RegisterHMIRoutesAtRoot registers the operator-facing HMI at the root path
// on a dedicated listener (http://ip:PORT/). Only the HMI UI + its API are
// exposed here — deploy/RPC endpoints are intentionally absent so the public
// panel URL is isolated from the agent's control surface. Handlers detect the
// root base via hmiBase() (paths here never start with "/hmi").
func RegisterHMIRoutesAtRoot(mux *http.ServeMux, hm *HMIManager) {
	mux.HandleFunc("GET /login", hm.handleLoginPage)
	mux.HandleFunc("POST /login", hm.handleLoginSubmit)
	mux.HandleFunc("POST /logout", hm.handleLogout)

	mux.HandleFunc("GET /api/session", hm.handleAPISession)
	mux.HandleFunc("GET /api/layout", hm.handleAPILayout)
	mux.HandleFunc("GET /api/variables", hm.handleAPIVariables)
	mux.HandleFunc("POST /api/write", hm.handleAPIWrite)
	mux.HandleFunc("GET /api/users", requireRole(hm.sessions, RoleAdmin, hm.handleAPIUsersGet))

	// Catch-all → HMI page (most-specific routes above win in Go 1.22 mux).
	mux.HandleFunc("GET /", requireSession(hm.users, hm.sessions, hm.handleHMIPage))
}

// handleDeployHMILayout receives the JSON HMI layout from KronEditor (sent during Build & Send).
// Empty body or {"pages":[]} clears the HMI config so the server skips HMI serving.
func (hm *HMIManager) handleDeployHMILayout(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	r.Body.Close()
	if err != nil {
		jsonError(w, http.StatusBadRequest, "failed to read body: "+err.Error())
		return
	}
	if err := hm.LoadJSON(data); err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	hm.mu.RLock()
	pages := 0
	if hm.config != nil {
		pages = len(hm.config.Pages)
	}
	loaded := hm.loaded
	hm.mu.RUnlock()
	jsonOK(w, map[string]any{"ok": true, "pages": pages, "loaded": loaded})
}

// deployedPageCount returns the current page count under the manager lock,
// tolerating a nil config (a concurrent LoadJSON may have cleared it).
func (hm *HMIManager) deployedPageCount() int {
	hm.mu.RLock()
	defer hm.mu.RUnlock()
	if hm.config == nil {
		return 0
	}
	return len(hm.config.Pages)
}

// handleDeploy receives the HMI XML from KronEditor.
// Reads are bounded (8 MB, same order as the layout endpoint) — an HMI
// config is small; an unbounded read is a trivial memory-exhaustion DoS.
func (hm *HMIManager) handleDeploy(w http.ResponseWriter, r *http.Request) {
	const maxHMIUpload = 8 << 20 // 8 MB
	r.Body = http.MaxBytesReader(w, r.Body, maxHMIUpload)
	if err := r.ParseMultipartForm(maxHMIUpload); err != nil {
		// Not multipart — try reading as raw body.
		defer r.Body.Close()
		data, rerr := io.ReadAll(r.Body)
		if rerr != nil {
			jsonError(w, http.StatusBadRequest, "failed to read body: "+rerr.Error())
			return
		}
		if err2 := hm.Load(data); err2 != nil {
			jsonError(w, http.StatusBadRequest, err2.Error())
			return
		}
		jsonOK(w, map[string]any{"ok": true, "pages": hm.deployedPageCount()})
		return
	}
	f, _, err := r.FormFile("hmi")
	if err != nil {
		jsonError(w, http.StatusBadRequest, "missing 'hmi' file field")
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxHMIUpload))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "failed to read file: "+err.Error())
		return
	}
	if err := hm.Load(data); err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	jsonOK(w, map[string]any{"ok": true, "pages": hm.deployedPageCount()})
}

// handleLoginPage serves the login HTML.
func (hm *HMIManager) handleLoginPage(w http.ResponseWriter, r *http.Request) {
	base := hmiBase(r)
	// If already logged in, redirect to HMI
	if _, ok := sessionFromRequest(r, hm.sessions); ok {
		http.Redirect(w, r, base+"/", http.StatusSeeOther)
		return
	}
	errMsg := r.URL.Query().Get("error")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, loginHTML(errMsg, base))
}

// handleLoginSubmit processes the login form.
func (hm *HMIManager) handleLoginSubmit(w http.ResponseWriter, r *http.Request) {
	base := hmiBase(r)
	username := r.FormValue("username")
	password := r.FormValue("password")

	u, ok := hm.users.Authenticate(username, password)
	if !ok {
		http.Redirect(w, r, base+"/login?error=Invalid+credentials", http.StatusSeeOther)
		return
	}

	sess := hm.sessions.Create(u.Username, u.Role)
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sess.Token,
		Path:     hmiCookiePath(base),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
	http.Redirect(w, r, base+"/", http.StatusSeeOther)
}

// handleLogout clears the session cookie.
func (hm *HMIManager) handleLogout(w http.ResponseWriter, r *http.Request) {
	base := hmiBase(r)
	if c, err := r.Cookie(sessionCookieName); err == nil {
		hm.sessions.Delete(c.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:   sessionCookieName,
		Value:  "",
		Path:   hmiCookiePath(base),
		MaxAge: -1,
	})
	http.Redirect(w, r, base+"/login", http.StatusSeeOther)
}

// handleHMIPage serves the main HMI application page.
func (hm *HMIManager) handleHMIPage(w http.ResponseWriter, r *http.Request) {
	if !hm.IsLoaded() {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, noConfigHTML())
		return
	}
	sess, _ := sessionFromRequest(r, hm.sessions)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, mainHMIHTML(sess, hmiBase(r)))
}

// handleAPISession returns the current user's session info.
func (hm *HMIManager) handleAPISession(w http.ResponseWriter, r *http.Request) {
	if hm.users.Count() == 0 {
		jsonOK(w, map[string]any{"username": "guest", "role": RoleAdmin.String(), "noAuth": true})
		return
	}
	sess, ok := sessionFromRequest(r, hm.sessions)
	if !ok {
		jsonError(w, http.StatusUnauthorized, "not authenticated")
		return
	}
	jsonOK(w, map[string]any{
		"username": sess.Username,
		"role":     sess.Role.String(),
	})
}

// handleAPILayout returns the HMI layout filtered by the user's read permissions.
func (hm *HMIManager) handleAPILayout(w http.ResponseWriter, r *http.Request) {
	var role Role
	if hm.users.Count() == 0 {
		role = RoleAdmin // no auth configured: full access
	} else {
		sess, ok := sessionFromRequest(r, hm.sessions)
		if !ok {
			jsonError(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		role = sess.Role
	}

	hm.mu.RLock()
	if !hm.loaded {
		hm.mu.RUnlock()
		jsonError(w, http.StatusServiceUnavailable, "no HMI config loaded")
		return
	}
	cfg := hm.config
	permMap := hm.permMap
	hm.mu.RUnlock()

	// Filter pages by read permission
	type compJSON struct {
		ID       string          `json:"id"`
		Type     string          `json:"type"`
		X        int             `json:"x"`
		Y        int             `json:"y"`
		W        int             `json:"w"`
		H        int             `json:"h"`
		Props    json.RawMessage `json:"props"`
		CanWrite bool            `json:"canWrite"`
	}
	type pageJSON struct {
		ID         string     `json:"id"`
		Name       string     `json:"name"`
		CanvasW    int        `json:"canvasW"`
		CanvasH    int        `json:"canvasH"`
		Components []compJSON `json:"components"`
	}

	var pages []pageJSON
	for _, pg := range cfg.Pages {
		perm, hasPerm := permMap[pg.ID]
		if hasPerm && !perm.readRoles[role] {
			continue // user cannot read this page
		}
		canWritePage := !hasPerm || perm.writeRoles[role]

		comps := make([]compJSON, 0, len(pg.Components))
		for _, c := range pg.Components {
			var rawProps json.RawMessage
			if c.Props != "" {
				rawProps = json.RawMessage(c.Props)
			} else {
				rawProps = json.RawMessage("{}")
			}
			comps = append(comps, compJSON{
				ID:       c.ID,
				Type:     c.Type,
				X:        c.X,
				Y:        c.Y,
				W:        c.W,
				H:        c.H,
				Props:    rawProps,
				CanWrite: canWritePage,
			})
		}
		pages = append(pages, pageJSON{
			ID:         pg.ID,
			Name:       pg.Name,
			CanvasW:    pg.CanvasW,
			CanvasH:    pg.CanvasH,
			Components: comps,
		})
	}

	jsonOK(w, map[string]any{"pages": pages})
}

// handleAPIVariables returns the current value of all variables.
func (hm *HMIManager) handleAPIVariables(w http.ResponseWriter, r *http.Request) {
	if hm.users.Count() > 0 {
		if _, ok := sessionFromRequest(r, hm.sessions); !ok {
			jsonError(w, http.StatusUnauthorized, "not authenticated")
			return
		}
	}
	if hm.ipc == nil {
		jsonOK(w, map[string]any{})
		return
	}
	// HMI widgets may only bind to addressed variables, so the feed is
	// restricted to those — consistent with the REST API and avoiding
	// publishing the full internal variable set to the panel.
	vars, err := hm.ipc.ReadAddressedVariables()
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOK(w, vars)
}

// handleAPIWrite force-writes a variable (operator+ required).
func (hm *HMIManager) handleAPIWrite(w http.ResponseWriter, r *http.Request) {
	if hm.users.Count() > 0 {
		sess, ok := sessionFromRequest(r, hm.sessions)
		if !ok {
			jsonError(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		if sess.Role < RoleOperator {
			jsonError(w, http.StatusForbidden, "insufficient role")
			return
		}
	}

	var body struct {
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	if hm.ipc == nil {
		jsonError(w, http.StatusServiceUnavailable, "IPC not available")
		return
	}
	// HMI writes are restricted to ADDRESSED variables — mirroring the read
	// feed (handleAPIVariables) and the REST API. Without this, any internal
	// variable could be force-written by name from a crafted request.
	//
	// KNOWN GAP: per-page writeRoles are only enforced in the UI (canWrite in
	// the layout response); a server-side variable→page mapping is not
	// maintained (component props are opaque JSON blobs whose variable
	// bindings use editor-side name resolution), so an operator+ session can
	// still write any ADDRESSED variable regardless of which page binds it.
	if !hm.ipc.IsAddressed(body.Key) {
		jsonError(w, http.StatusForbidden, "variable is not addressed (not writable via HMI)")
		return
	}
	if err := hm.ipc.WriteVariable(body.Key, body.Value); err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	jsonOK(w, map[string]bool{"ok": true})
}

// handleAPIUsersGet returns the user list (admin only).
func (hm *HMIManager) handleAPIUsersGet(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, hm.users.GetAll())
}

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

func loginHTML(errMsg, base string) string {
	errBlock := ""
	if errMsg != "" {
		// errMsg comes straight from the ?error= query parameter on BOTH
		// listeners — escape it or it is reflected XSS on the login page.
		errBlock = `<div class="err">` + html.EscapeString(errMsg) + `</div>`
	}
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KronHMI — Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:#d4d4d4;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#161616;border:1px solid #2a2a2a;padding:40px 36px;width:340px;border-radius:2px}
h1{font-size:18px;font-weight:600;margin-bottom:6px;color:#e0e0e0}
.sub{font-size:12px;color:#555;margin-bottom:28px}
label{display:block;font-size:11px;color:#666;margin-bottom:4px;letter-spacing:.05em;text-transform:uppercase}
input{width:100%;background:#1a1a1a;border:1px solid #333;color:#d4d4d4;font-size:14px;padding:8px 10px;margin-bottom:16px;outline:none}
input:focus{border-color:#007acc}
button{width:100%;background:#007acc;color:#fff;border:none;padding:10px;font-size:14px;font-weight:600;cursor:pointer;letter-spacing:.04em}
button:hover{background:#0090ee}
.err{background:rgba(241,76,76,.1);border:1px solid rgba(241,76,76,.3);color:#f14c4c;font-size:12px;padding:8px 10px;margin-bottom:16px}
.logo{font-size:11px;color:#333;text-align:center;margin-top:24px;letter-spacing:.1em;text-transform:uppercase}
</style>
</head>
<body>
<div class="card">
  <h1>KronHMI</h1>
  <p class="sub">Sign in to access the control panel</p>
  ` + errBlock + `
  <form method="POST" action="` + base + `/login">
    <label>Username</label>
    <input name="username" type="text" autocomplete="username" autofocus required>
    <label>Password</label>
    <input name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign In</button>
  </form>
  <p class="logo">KronEditor PLC</p>
</div>
</body>
</html>`
}

func noConfigHTML() string {
	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>KronHMI</title>
<style>body{background:#0d0d0d;color:#555;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:12px}</style>
</head>
<body>
<span style="font-size:40px">📊</span>
<span>No HMI configuration deployed yet.</span>
<span style="font-size:12px">Deploy from KronEditor: Visualization → Deploy to Server</span>
</body>
</html>`
}

func mainHMIHTML(sess *Session, base string) string {
	username := ""
	roleName := ""
	if sess != nil {
		username = sess.Username
		roleName = sess.Role.String()
	}
	// username is attacker-influenced (chosen at HMI-config deploy time) and
	// is interpolated into HTML — escape it. roleName/base are server-derived
	// but escaped/marshalled anyway (defense in depth). For the JS string
	// literals use json.Marshal, which yields a safely quoted JS string.
	usernameHTML := html.EscapeString(username)
	roleHTML := html.EscapeString(roleName)
	roleJS, _ := json.Marshal(roleName)
	baseJS, _ := json.Marshal(base)
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KronHMI</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:#d4d4d4;font-family:Consolas,monospace;overflow:hidden;display:flex;flex-direction:column;height:100vh}
#topbar{display:flex;align-items:center;height:36px;background:#161616;border-bottom:1px solid #222;padding:0 12px;gap:10px;flex-shrink:0}
#topbar-title{font-size:13px;font-weight:600;color:#e0e0e0;margin-right:auto}
#page-tabs{display:flex;gap:1px;height:100%;overflow-x:auto}
.ptab{padding:0 14px;font-size:11px;font-weight:500;letter-spacing:.04em;cursor:pointer;border:none;background:transparent;color:#666;border-bottom:2px solid transparent;white-space:nowrap;height:100%}
.ptab.active{color:#e0e0e0;border-bottom-color:#007acc;background:#1a1a1a}
#user-info{font-size:11px;color:#555;display:flex;align-items:center;gap:8px;flex-shrink:0}
.role-badge{background:#1e2a3a;color:#7eb8f7;padding:2px 7px;font-size:10px;letter-spacing:.06em;text-transform:uppercase}
#logout-btn{background:none;border:1px solid #333;color:#666;font-size:11px;padding:3px 8px;cursor:pointer;font-family:inherit}
#logout-btn:hover{border-color:#555;color:#aaa}
#canvas-wrap{flex:1;overflow:auto;position:relative}
#hmi-canvas{position:relative}
.hmi-comp{position:absolute;overflow:hidden}
/* LED */
.led-wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px}
.led-circle{border-radius:50%;border:2px solid #555;transition:background .1s,box-shadow .1s}
/* Numeric display */
.num-display{width:100%;height:100%;display:flex;align-items:center;justify-content:center;gap:4px;font-family:'Courier New',monospace}
/* Button */
.hmi-btn{width:100%;height:100%;display:flex;align-items:center;justify-content:center;user-select:none;transition:background .08s}
/* Progress */
.progress-bar{position:relative;width:100%;overflow:hidden}
.progress-fill{height:100%;transition:width .15s}
.progress-val{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:10px;font-weight:600;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.8)}
/* Switch */
.sw-track{position:relative;cursor:pointer;border-radius:999px;transition:background .15s}
.sw-thumb{position:absolute;border-radius:50%;background:#e0e0e0;box-shadow:0 1px 4px rgba(0,0,0,.5);transition:left .15s}
/* Label */
.lbl-comp{width:100%;height:100%;display:flex;align-items:center;overflow:hidden;padding:0 4px}
</style>
</head>
<body>
<div id="topbar">
  <span id="topbar-title">KronHMI</span>
  <div id="page-tabs"></div>
  <div id="user-info">
    <span>` + usernameHTML + `</span>
    <span class="role-badge">` + roleHTML + `</span>
    <form method="POST" action="` + base + `/logout" style="display:inline">
      <button id="logout-btn" type="submit">Sign out</button>
    </form>
  </div>
</div>
<div id="canvas-wrap">
  <div id="hmi-canvas"></div>
</div>
<script>
const USER_ROLE_LEVEL = {viewer:1,operator:2,maintainer:3,admin:4};
const MY_ROLE = ` + string(roleJS) + `;
const MY_LEVEL = USER_ROLE_LEVEL[MY_ROLE] || 1;
const BASE = ` + string(baseJS) + `;

let pages = [];
let currentPage = 0;
let variables = {};

function resolveVar(expr){
  if(!expr)return null;
  const t=expr.trim();const d=t.indexOf('.');
  if(d>0){const p=t.slice(0,d).replace(/\s+/g,'_');const v=t.slice(d+1).replace(/\s+/g,'_');return 'prog_'+p+'_'+v;}
  return t.replace(/\s+/g,'_');
}
function getVal(expr){const k=resolveVar(expr);return k?variables[k]:undefined;}
function fmtVal(v,dec){if(v===null||v===undefined)return'---';if(typeof v==='boolean')return v?'TRUE':'FALSE';const n=Number(v);return isNaN(n)?String(v):n.toFixed(Number(dec)||0);}
function isOn(v){return v===true||v===1||v==='TRUE'||v==='1';}

async function sendWrite(key,value){
  try{await fetch(BASE+'/api/write',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,value})});}catch(e){}
}

async function loadLayout(){
  try{
    const r=await fetch(BASE+'/api/layout');
    const data=await r.json();
    pages=data.pages||[];
    buildPageTabs();
    renderPage(currentPage);
  }catch(e){console.error(e);}
}

function buildPageTabs(){
  const bar=document.getElementById('page-tabs');
  bar.innerHTML='';
  pages.forEach((pg,i)=>{
    const btn=document.createElement('button');
    btn.className='ptab'+(i===currentPage?' active':'');
    btn.textContent=pg.name;
    btn.onclick=()=>{currentPage=i;document.querySelectorAll('.ptab').forEach((b,j)=>b.className='ptab'+(j===i?' active':''));renderPage(i);};
    bar.appendChild(btn);
  });
}

function renderPage(idx){
  const pg=pages[idx];
  const canvas=document.getElementById('hmi-canvas');
  canvas.style.width=(pg.canvasW||1280)+'px';
  canvas.style.height=(pg.canvasH||800)+'px';
  canvas.innerHTML='';
  (pg.components||[]).forEach(comp=>renderComp(canvas,comp,pg.canWrite||false));
  updateLive();
}

function renderComp(canvas,comp,pageCanWrite){
  const p=comp.props||{};
  const canWrite=pageCanWrite&&comp.canWrite&&MY_LEVEL>=2;
  const el=document.createElement('div');
  el.className='hmi-comp';
  el.id='comp_'+comp.id;
  el.style.cssText='left:'+comp.x+'px;top:'+comp.y+'px;width:'+comp.w+'px;height:'+comp.h+'px';

  switch(comp.type){
    case'LED':{
      const s=Math.min(comp.w,comp.h)*0.68;
      el.innerHTML='<div class="led-wrap"><div class="led-circle" id="led_'+comp.id+'" style="width:'+s+'px;height:'+s+'px"></div>'+(p.label&&p.label.trim?p.label.trim()?'<span style="font-size:'+(p.fontSize||11)+'px;color:#aaa">'+p.label+'</span>':''  :'' )+'</div>';
      break;}
    case'ALARM':{
      const sz=Math.min(comp.w,comp.h)*0.7;
      el.innerHTML='<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px"><svg id="alarm_'+comp.id+'" width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24"><path d="M12 2L1 21h22L12 2z" fill="'+(p.inactiveColor||'#2a2a2a')+'" stroke="#444" stroke-width="1"/><text x="12" y="17" text-anchor="middle" fill="#fff" font-size="7" font-weight="bold">!</text></svg>'+(p.label?'<span id="alarmlbl_'+comp.id+'" style="font-size:'+(p.fontSize||12)+'px;font-weight:600">'+p.label+'</span>':'')+'</div>';
      break;}
    case'NUMERIC_DISPLAY':{
      el.innerHTML='<div class="num-display" style="background:'+(p.background||'#0a0f14')+';border:1px solid '+(p.borderColor||'#1e2a38')+'"><span id="num_'+comp.id+'" style="font-size:'+Math.min(p.fontSize||24,comp.h*.7)+'px;color:'+(p.color||'#4ec9b0')+';font-weight:700">---</span>'+(p.unit?'<span style="font-size:'+Math.max((p.fontSize||24)*.45,10)+'px;color:#666">'+p.unit+'</span>':'')+'</div>';
      break;}
    case'PROGRESS':{
      el.innerHTML='<div style="width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;gap:2px">'+(p.label?'<span style="font-size:10px;color:#777;padding-left:2px">'+p.label+'</span>':'')+'<div class="progress-bar" style="flex:1;background:'+(p.background||'#1a1a1a')+';border:1px solid '+(p.borderColor||'#2a2a2a')+'"><div id="prog_'+comp.id+'" class="progress-fill" style="background:'+(p.color||'#007acc')+';width:0%"></div>'+(p.showValue?'<div id="progval_'+comp.id+'" class="progress-val">0</div>':'')+'</div></div>';
      break;}
    case'BUTTON':{
      const disabled=!canWrite;
      el.innerHTML='<div class="hmi-btn" id="btn_'+comp.id+'" style="background:'+(p.offColor||'#252525')+';border:1px solid '+(p.borderColor||'#3a3a3a')+';border-radius:'+(p.borderRadius||3)+'px;cursor:'+(disabled?'not-allowed':'pointer')+';opacity:'+(disabled?.6:1)+'"><span style="font-size:'+(p.fontSize||13)+'px;color:'+(p.textColor||'#fff')+';font-weight:500;pointer-events:none">'+(p.label||'Button')+'</span></div>';
      if(!disabled){
        const btn=el.querySelector('#btn_'+comp.id);const lk=resolveVar(p.variable);
        if(lk){if(p.mode==='toggle'){btn.onclick=()=>sendWrite(lk,!isOn(variables[lk]));}
        else{btn.onmousedown=()=>{btn.style.background=p.onColor||'#007acc';sendWrite(lk,true);};btn.onmouseup=btn.onmouseleave=()=>{btn.style.background=p.offColor||'#252525';sendWrite(lk,false);};}
        }
      }break;}
    case'TOGGLE_BUTTON':{
      const disabled=!canWrite;
      el.innerHTML='<div class="hmi-btn" id="tbtn_'+comp.id+'" style="background:'+(p.offColor||'#252525')+';border:1px solid '+(p.borderColor||'#3a3a3a')+';border-radius:'+(p.borderRadius||3)+'px;cursor:'+(disabled?'not-allowed':'pointer')+';opacity:'+(disabled?.6:1)+'"><span id="tbtnlbl_'+comp.id+'" style="font-size:'+(p.fontSize||13)+'px;color:'+(p.textColor||'#fff')+';font-weight:600;letter-spacing:.06em;pointer-events:none">'+(p.labelOff||'OFF')+'</span></div>';
      if(!disabled){const lk=resolveVar(p.variable);if(lk)el.querySelector('#tbtn_'+comp.id).onclick=()=>sendWrite(lk,!isOn(variables[lk]));}
      break;}
    case'SWITCH':{
      const tw=Math.min(comp.w*.56,54),th=Math.min(comp.h*.52,28),thumb=th-4;
      const disabled=!canWrite;
      el.innerHTML='<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;gap:8px"><div id="sw_'+comp.id+'" class="sw-track" style="width:'+tw+'px;height:'+th+'px;background:'+(p.offColor||'#333')+';cursor:'+(disabled?'not-allowed':'pointer')+'"><div id="swt_'+comp.id+'" class="sw-thumb" style="top:2px;left:2px;width:'+thumb+'px;height:'+thumb+'px"></div></div>'+(p.label?'<span style="font-size:'+(p.fontSize||12)+'px;color:#aaa">'+p.label+'</span>':'')+'</div>';
      if(!disabled){const lk=resolveVar(p.variable);const sw=el.querySelector('#sw_'+comp.id);sw.__tw=tw;sw.__thumb=thumb;if(lk)sw.onclick=()=>sendWrite(lk,!isOn(variables[lk]));}
      break;}
    case'SLIDER':{
      const disabled=!canWrite;
      const lk=resolveVar(p.variable);
      el.innerHTML='<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:0 8px"><input id="slider_'+comp.id+'" type="range" min="'+(p.min||0)+'" max="'+(p.max||100)+'" step="'+(p.step||1)+'" value="'+(p.min||0)+'" '+(disabled?'disabled':'')+' style="width:100%;accent-color:'+(p.thumbColor||'#007acc')+';">'+(p.showValue?'<span id="slv_'+comp.id+'" style="font-size:10px;color:#888;font-family:monospace">'+(p.min||0)+'</span>':'')+'</div>';
      if(!disabled&&lk){const sl=el.querySelector('#slider_'+comp.id);sl.oninput=e=>{const sv=document.getElementById('slv_'+comp.id);if(sv)sv.textContent=e.target.value;sendWrite(lk,Number(e.target.value));};}
      break;}
    case'LABEL':{
      el.innerHTML='<div class="lbl-comp" style="background:'+(p.background||'transparent')+';justify-content:'+(p.align==='center'?'center':p.align==='right'?'flex-end':'flex-start')+'"><span id="lbl_'+comp.id+'" style="font-size:'+(p.fontSize||13)+'px;font-weight:'+(p.fontWeight||'normal')+';color:'+(p.color||'#d4d4d4')+';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+(p.text||'')+'</span></div>';
      break;}
    case'RECTANGLE':{
      el.innerHTML='<div style="width:100%;height:100%;background:'+(p.background||'transparent')+';border:'+(p.borderWidth||1)+'px solid '+(p.borderColor||'#444')+';border-radius:'+(p.borderRadius||0)+'px">'+(p.label?'<span style="font-size:'+(p.fontSize||11)+'px;color:'+(p.labelColor||'#888')+';padding:2px 6px">'+p.label+'</span>':'')+'</div>';break;}
    case'CIRCLE':{
      const sz=Math.min(comp.w,comp.h);
      el.innerHTML='<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center"><div style="width:'+sz+'px;height:'+sz+'px;border-radius:50%;background:'+(p.background||'transparent')+';border:'+(p.borderWidth||1)+'px solid '+(p.borderColor||'#444')+'"></div></div>';break;}
    case'LINE':{
      const horiz=(p.orientation||'horizontal')==='horizontal';
      el.innerHTML='<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center"><div style="width:'+(horiz?'100%':(p.thickness||1)+'px')+';height:'+(horiz?(p.thickness||1)+'px':'100%')+';background:'+(p.color||'#444')+'"></div></div>';break;}
    default:
      el.innerHTML='<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;border:1px dashed #333;color:#444;font-size:11px">'+comp.type+'</div>';
  }
  canvas.appendChild(el);
}

function updateLive(){
  const pg=pages[currentPage];if(!pg)return;
  (pg.components||[]).forEach(comp=>{
    const p=comp.props||{};
    const val=getVal(p.variable);
    const on=isOn(val);
    switch(comp.type){
      case'LED':{const c=document.getElementById('led_'+comp.id);if(c){c.style.background=on?(p.onColor||'#00e676'):(p.offColor||'#1a1a1a');c.style.boxShadow=on?'0 0 12px '+(p.onColor||'#00e676')+',0 0 20px '+(p.onColor||'#00e676')+'55':'inset 0 2px 6px rgba(0,0,0,.5)';}break;}
      case'ALARM':{const a=document.getElementById('alarm_'+comp.id);if(a){const path=a.querySelector('path');if(path)path.setAttribute('fill',on?(p.activeColor||'#f14c4c'):(p.inactiveColor||'#2a2a2a'));}const lbl=document.getElementById('alarmlbl_'+comp.id);if(lbl)lbl.style.color=on?(p.activeColor||'#f14c4c'):'#555';break;}
      case'NUMERIC_DISPLAY':{const n=document.getElementById('num_'+comp.id);if(n)n.textContent=fmtVal(val,p.decimals);break;}
      case'PROGRESS':{const mn=Number(p.min)||0,mx=Number(p.max)||100,v=Math.min(mx,Math.max(mn,Number(val)||mn));const pct=mx>mn?((v-mn)/(mx-mn))*100:0;const bar=document.getElementById('prog_'+comp.id);if(bar)bar.style.width=pct+'%';const pv=document.getElementById('progval_'+comp.id);if(pv)pv.textContent=v.toFixed(0);break;}
      case'TOGGLE_BUTTON':{const tb=document.getElementById('tbtn_'+comp.id);const tl=document.getElementById('tbtnlbl_'+comp.id);if(tb)tb.style.background=on?(p.onColor||'#007a4d'):(p.offColor||'#252525');if(tl)tl.textContent=on?(p.labelOn||'ON'):(p.labelOff||'OFF');break;}
      case'BUTTON':{if(p.mode==='toggle'){const btn=document.getElementById('btn_'+comp.id);if(btn)btn.style.background=on?(p.onColor||'#007acc'):(p.offColor||'#252525');}break;}
      case'SWITCH':{const sw=document.getElementById('sw_'+comp.id);const swt=document.getElementById('swt_'+comp.id);if(sw&&swt){sw.style.background=on?(p.onColor||'#007acc'):(p.offColor||'#333');const tw=sw.__tw||54,thumb=sw.__thumb||24;swt.style.left=on?(tw-thumb-2)+'px':'2px';}break;}
      case'SLIDER':{const sl=document.getElementById('slider_'+comp.id);if(sl&&val!==undefined)sl.value=Number(val);const sv=document.getElementById('slv_'+comp.id);if(sv&&val!==undefined)sv.textContent=Number(val).toFixed(0);break;}
      case'LABEL':{const lbl=document.getElementById('lbl_'+comp.id);if(lbl){if(p.variable&&val!==undefined){const n=Number(val);lbl.textContent=isNaN(n)?String(val):n.toFixed(p.decimals||0)+(p.unit?' '+p.unit:'');}else lbl.textContent=p.text||'';}break;}
    }
  });
}

async function pollVars(){
  try{const r=await fetch(BASE+'/api/variables');variables=await r.json();updateLive();}catch(e){}
}

loadLayout();
setInterval(pollVars,400);
</script>
</body>
</html>`
}
