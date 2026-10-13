package main

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"html"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/krontek/hotswaplib/shmcmd"
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
	if hm.users.LoadUsers(userList) {
		// Users, roles or passwords changed: a session issued under the old
		// set (a removed user, a demoted role) must not live on for its TTL.
		hm.sessions.Clear()
	}

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
	Users     []hmiUserJSON          `json:"users"`
	PagePerms map[string]hmiPermJSON `json:"pagePerms"`
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
		if hm.users.LoadUsers(nil) {
			hm.sessions.Clear()
		}
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
		if hm.users.LoadUsers(nil) {
			hm.sessions.Clear()
		}
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

	// Persist to disk so the config survives server restarts. Atomic (a torn
	// file would drop every user on the next boot) and 0600: it holds the
	// users' password hashes and salts.
	if hm.persistPath != "" {
		if werr := writeFileAtomic(hm.persistPath, data, 0600); werr != nil {
			hm.log.Warn("Failed to persist HMI layout to disk", "path", hm.persistPath, "err", werr)
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

// handleLoginSubmit processes a login: POST {"username":…,"password":…}.
//
// ⚠️ JSON only (415 otherwise). A form-encoded POST is a "simple" request any
// web page can fire cross-site without a preflight; requiring
// application/json forces a preflight that the origin check refuses. The
// login page submits through fetch for that reason.
func (hm *HMIManager) handleLoginSubmit(w http.ResponseWriter, r *http.Request) {
	base := hmiBase(r)
	if !requireJSONBody(w, r) {
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	u, ok := hm.users.Authenticate(body.Username, body.Password)
	if !ok {
		jsonError(w, http.StatusUnauthorized, "Invalid credentials")
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
	jsonOK(w, map[string]any{"ok": true, "redirect": base + "/"})
}

// requireJSONBody answers 415 unless the request declares a JSON body. See
// handleLoginSubmit for why this is a CSRF control and not pedantry.
func requireJSONBody(w http.ResponseWriter, r *http.Request) bool {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		jsonError(w, http.StatusUnsupportedMediaType, "Content-Type must be application/json")
		return false
	}
	return true
}

// hmiOriginGuard is the dedicated HMI listener's version of the main server's
// corsMiddleware (CLAUDE.md): a request carrying an Origin is served only
// when it is the panel's own origin or a local/private one; anything else is
// refused with 403 before the handler runs — on every method, since a simple
// cross-site POST arrives without a preflight. Requests without an Origin
// (curl, native clients) pass. Same-origin is allowed explicitly because the
// operator may reach the panel by a plain DNS name, which
// isAllowedCORSOrigin alone would reject.
func hmiOriginGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Add("Vary", "Origin")
		if !sameOrigin(origin, r) && !isAllowedCORSOrigin(origin) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// sameOrigin reports whether origin names the host this request was sent to.
func sameOrigin(origin string, r *http.Request) bool {
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
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
	if !hm.IsLoaded() {
		jsonError(w, http.StatusServiceUnavailable, "no HMI deployed")
		return
	}
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
	if !hm.IsLoaded() {
		jsonError(w, http.StatusServiceUnavailable, "no HMI deployed")
		return
	}
	// Writes need an identity. With no HMI user defined the panel stays
	// readable (an open display is a legitimate setup), but nobody may force
	// a value through it: an unauthenticated write endpoint on the plant
	// network is a remote control for anyone who can reach the port.
	if hm.users.Count() == 0 {
		jsonError(w, http.StatusForbidden, "HMI writes require at least one HMI user")
		return
	}
	sess, ok := sessionFromRequest(r, hm.sessions)
	if !ok {
		jsonError(w, http.StatusUnauthorized, "not authenticated")
		return
	}
	if sess.Role < RoleOperator {
		jsonError(w, http.StatusForbidden, "insufficient role")
		return
	}
	if !requireJSONBody(w, r) {
		return
	}

	var body struct {
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
		// mode: "force" (default), "pulse" or "unforce". A momentary button
		// sends force TRUE on press and unforce FALSE on release.
		Mode string `json:"mode"`
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
	op, err := shmcmd.ParseOp(body.Mode)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := hm.ipc.WriteVariableMode(body.Key, body.Value, op); err != nil {
		jsonError(w, shmcmd.HTTPStatus(err), err.Error())
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
	// errMsg comes straight from the ?error= query parameter on BOTH
	// listeners — escape it or it is reflected XSS on the login page.
	errText := html.EscapeString(errMsg)
	errHidden := ""
	if errMsg == "" {
		errHidden = " hidden"
	}
	baseJS, _ := json.Marshal(base)
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
  <div class="err" id="err"` + errHidden + `>` + errText + `</div>
  <form id="login" method="POST" action="` + base + `/login">
    <label>Username</label>
    <input name="username" type="text" autocomplete="username" autofocus required>
    <label>Password</label>
    <input name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign In</button>
  </form>
  <p class="logo">KronEditor PLC</p>
</div>
<script>
// The login endpoint accepts JSON only (a CSRF control, see handleLoginSubmit),
// so the form is submitted through fetch instead of a native form POST.
const BASE = ` + string(baseJS) + `;
document.getElementById('login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, err = document.getElementById('err');
  try {
    const r = await fetch(BASE + '/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: f.username.value, password: f.password.value}),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) { window.location.href = BASE + '/'; return; }
    err.textContent = data.error || ('Sign-in failed (HTTP ' + r.status + ')');
  } catch (e) {
    err.textContent = 'Sign-in failed: ' + e;
  }
  err.hidden = false;
});
</script>
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
  if(typeof expr!=='string'||!expr)return null;
  const t=expr.trim();const d=t.indexOf('.');
  if(d>0){const p=t.slice(0,d).replace(/\s+/g,'_');const v=t.slice(d+1).replace(/\s+/g,'_');return 'prog_'+p+'_'+v;}
  return t.replace(/\s+/g,'_');
}
function getVal(expr){const k=resolveVar(expr);return k?variables[k]:undefined;}
// ⚠️ Every component prop comes from /deploy/hmi-layout, an unauthenticated
// upload, so NOTHING from it may reach innerHTML or free-form CSS: text goes
// through textContent, numbers through num()/nz(), colours through the strict
// col() whitelist (a free CSS value carries url(...) beacons), enumerations
// through fixed sets. The DOM is built with createElement only.
const COLOR_RE=/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,30}|(rgb|rgba|hsl|hsla)\(\s*-?[0-9.]+%?(\s*[,\s\/]\s*-?[0-9.]+%?){2,3}\s*\))$/;
function col(v,d){return(typeof v==='string'&&COLOR_RE.test(v.trim()))?v.trim():d;}
function num(v,d){if(v===null||v===undefined||v==='')return d;const n=Number(v);return isFinite(n)?n:d;}
function nz(v,d){return num(v,0)||d;}  // mirrors the old "p.x || default" semantics
function dec(v){return Math.min(20,Math.max(0,Math.floor(num(v,0))));}
function txt(v){return(v===null||v===undefined)?'':String(v);}
function fw(v){const s=txt(v);return/^(normal|bold|bolder|lighter|[1-9]00)$/.test(s)?s:'normal';}
function mk(tag,css,kids){
  const e=document.createElement(tag);
  if(css)for(const k in css){if(css[k]!==undefined&&css[k]!==null)e.style.setProperty(k,String(css[k]));}
  (kids||[]).forEach(c=>{if(c!==null&&c!==undefined&&c!==false)e.appendChild(typeof c==='string'?document.createTextNode(c):c);});
  return e;
}
function span(text,css){return mk('span',css,[txt(text)]);}
function fmtVal(v,d){if(v===null||v===undefined)return'---';if(typeof v==='boolean')return v?'TRUE':'FALSE';const n=Number(v);return isNaN(n)?String(v):n.toFixed(dec(d));}
function isOn(v){return v===true||v===1||v==='TRUE'||v==='1';}

// Writes are SERIALISED PER KEY: a momentary press (force TRUE) and its
// release (unforce FALSE) must reach the PLC in that order, and two fetches in
// flight can complete in either order. The server answers only after the
// runtime applied the command, so chaining on the response is exact.
const writeChains={};
function sendWrite(key,value,mode){
  const prev=writeChains[key]||Promise.resolve();
  const next=prev.then(async()=>{
    try{
      const r=await fetch(BASE+'/api/write',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,value,mode:mode||'force'})});
      if(!r.ok){let m=r.statusText;try{m=(await r.json()).error||m;}catch(e){}console.warn('HMI write '+key+': '+m);}
    }catch(e){console.warn('HMI write '+key+': '+e);}
  });
  writeChains[key]=next;
  next.then(()=>{if(writeChains[key]===next)delete writeChains[key];});
  return next;
}
// Momentary button: press = force TRUE (held while pressed), release = unforce
// writing FALSE once, so the logic owns the bit again. Pointer capture keeps
// the release on this element even when the finger/cursor slides off, and
// pointercancel (touch scroll, alt-tab, lost capture) counts as a release — a
// missed release would leave the bit forced TRUE.
function bindMomentary(btn,lk,onCol,offCol){
  let down=false;
  btn.style.touchAction='none';
  btn.addEventListener('pointerdown',e=>{
    if(down||e.button>0)return;
    down=true;
    try{btn.setPointerCapture(e.pointerId);}catch(_){}
    btn.style.background=onCol;
    sendWrite(lk,true,'force');
  });
  const release=()=>{
    if(!down)return;
    down=false;
    btn.style.background=offCol;
    sendWrite(lk,false,'unforce');
  };
  btn.addEventListener('pointerup',release);
  btn.addEventListener('pointercancel',release);
  btn.addEventListener('lostpointercapture',release);
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
  bar.textContent='';
  pages.forEach((pg,i)=>{
    const btn=document.createElement('button');
    btn.className='ptab'+(i===currentPage?' active':'');
    btn.textContent=txt(pg.name);
    btn.onclick=()=>{currentPage=i;document.querySelectorAll('.ptab').forEach((b,j)=>b.className='ptab'+(j===i?' active':''));renderPage(i);};
    bar.appendChild(btn);
  });
}

function renderPage(idx){
  const pg=pages[idx];
  const canvas=document.getElementById('hmi-canvas');
  if(!pg){canvas.textContent='';return;}
  canvas.style.width=nz(pg.canvasW,1280)+'px';
  canvas.style.height=nz(pg.canvasH,800)+'px';
  canvas.textContent='';
  (pg.components||[]).forEach(comp=>renderComp(canvas,comp,pg.canWrite||false));
  updateLive();
}

function renderComp(canvas,comp,pageCanWrite){
  const p=(comp.props&&typeof comp.props==='object')?comp.props:{};
  const canWrite=pageCanWrite&&comp.canWrite&&MY_LEVEL>=2;
  const cid=txt(comp.id);
  const W=num(comp.w,0),H=num(comp.h,0);
  const fs=(v,d)=>nz(v,d)+'px';
  const full={width:'100%',height:'100%'};
  const el=mk('div',{left:num(comp.x,0)+'px',top:num(comp.y,0)+'px',width:W+'px',height:H+'px'});
  el.className='hmi-comp';
  el.id='comp_'+cid;

  switch(comp.type){
    case'LED':{
      const s=Math.min(W,H)*0.68;
      const c=mk('div',{width:s+'px',height:s+'px'});c.className='led-circle';c.id='led_'+cid;
      const lbl=(typeof p.label==='string'&&p.label.trim())?span(p.label,{'font-size':fs(p.fontSize,11),color:'#aaa'}):null;
      const w=mk('div',null,[c,lbl]);w.className='led-wrap';
      el.appendChild(w);
      break;}
    case'ALARM':{
      const sz=Math.min(W,H)*0.7;const NS='http://www.w3.org/2000/svg';
      const svg=document.createElementNS(NS,'svg');
      svg.id='alarm_'+cid;svg.setAttribute('width',String(sz));svg.setAttribute('height',String(sz));svg.setAttribute('viewBox','0 0 24 24');
      const path=document.createElementNS(NS,'path');
      path.setAttribute('d','M12 2L1 21h22L12 2z');path.setAttribute('fill',col(p.inactiveColor,'#2a2a2a'));path.setAttribute('stroke','#444');path.setAttribute('stroke-width','1');
      const t=document.createElementNS(NS,'text');
      [['x','12'],['y','17'],['text-anchor','middle'],['fill','#fff'],['font-size','7'],['font-weight','bold']].forEach(a=>t.setAttribute(a[0],a[1]));
      t.textContent='!';
      svg.appendChild(path);svg.appendChild(t);
      let lbl=null;
      if(p.label){lbl=span(p.label,{'font-size':fs(p.fontSize,12),'font-weight':'600'});lbl.id='alarmlbl_'+cid;}
      el.appendChild(mk('div',Object.assign({display:'flex','flex-direction':'column','align-items':'center','justify-content':'center',gap:'4px'},full),[svg,lbl]));
      break;}
    case'NUMERIC_DISPLAY':{
      const f=nz(p.fontSize,24);
      const n=span('---',{'font-size':Math.min(f,H*.7)+'px',color:col(p.color,'#4ec9b0'),'font-weight':'700'});n.id='num_'+cid;
      const u=p.unit?span(p.unit,{'font-size':Math.max(f*.45,10)+'px',color:'#666'}):null;
      const d=mk('div',{background:col(p.background,'#0a0f14'),border:'1px solid '+col(p.borderColor,'#1e2a38')},[n,u]);d.className='num-display';
      el.appendChild(d);
      break;}
    case'PROGRESS':{
      const fill=mk('div',{background:col(p.color,'#007acc'),width:'0%'});fill.className='progress-fill';fill.id='prog_'+cid;
      let pv=null;if(p.showValue){pv=mk('div',null,['0']);pv.className='progress-val';pv.id='progval_'+cid;}
      const bar=mk('div',{flex:'1',background:col(p.background,'#1a1a1a'),border:'1px solid '+col(p.borderColor,'#2a2a2a')},[fill,pv]);bar.className='progress-bar';
      const lbl=p.label?span(p.label,{'font-size':'10px',color:'#777','padding-left':'2px'}):null;
      el.appendChild(mk('div',Object.assign({display:'flex','flex-direction':'column','justify-content':'center',gap:'2px'},full),[lbl,bar]));
      break;}
    case'BUTTON':{
      const disabled=!canWrite;
      const btn=mk('div',{background:col(p.offColor,'#252525'),border:'1px solid '+col(p.borderColor,'#3a3a3a'),'border-radius':nz(p.borderRadius,3)+'px',cursor:disabled?'not-allowed':'pointer',opacity:disabled?'.6':'1'},
        [span(p.label||'Button',{'font-size':fs(p.fontSize,13),color:col(p.textColor,'#fff'),'font-weight':'500','pointer-events':'none'})]);
      btn.className='hmi-btn';btn.id='btn_'+cid;
      el.appendChild(btn);
      if(!disabled){
        const lk=resolveVar(p.variable);
        if(lk){if(p.mode==='toggle'){btn.onclick=()=>sendWrite(lk,!isOn(variables[lk]));}
        else{bindMomentary(btn,lk,col(p.onColor,'#007acc'),col(p.offColor,'#252525'));}
        }
      }break;}
    case'TOGGLE_BUTTON':{
      const disabled=!canWrite;
      const lbl=span(p.labelOff||'OFF',{'font-size':fs(p.fontSize,13),color:col(p.textColor,'#fff'),'font-weight':'600','letter-spacing':'.06em','pointer-events':'none'});lbl.id='tbtnlbl_'+cid;
      const btn=mk('div',{background:col(p.offColor,'#252525'),border:'1px solid '+col(p.borderColor,'#3a3a3a'),'border-radius':nz(p.borderRadius,3)+'px',cursor:disabled?'not-allowed':'pointer',opacity:disabled?'.6':'1'},[lbl]);
      btn.className='hmi-btn';btn.id='tbtn_'+cid;
      el.appendChild(btn);
      if(!disabled){const lk=resolveVar(p.variable);if(lk)btn.onclick=()=>sendWrite(lk,!isOn(variables[lk]));}
      break;}
    case'SWITCH':{
      const tw=Math.min(W*.56,54),th=Math.min(H*.52,28),thumb=th-4;
      const disabled=!canWrite;
      const knob=mk('div',{top:'2px',left:'2px',width:thumb+'px',height:thumb+'px'});knob.className='sw-thumb';knob.id='swt_'+cid;
      const sw=mk('div',{width:tw+'px',height:th+'px',background:col(p.offColor,'#333'),cursor:disabled?'not-allowed':'pointer'},[knob]);sw.className='sw-track';sw.id='sw_'+cid;
      sw.__tw=tw;sw.__thumb=thumb;
      const lbl=p.label?span(p.label,{'font-size':fs(p.fontSize,12),color:'#aaa'}):null;
      el.appendChild(mk('div',Object.assign({display:'flex','align-items':'center','justify-content':'center',gap:'8px'},full),[sw,lbl]));
      if(!disabled){const lk=resolveVar(p.variable);if(lk)sw.onclick=()=>sendWrite(lk,!isOn(variables[lk]));}
      break;}
    case'SLIDER':{
      const disabled=!canWrite;
      const lk=resolveVar(p.variable);
      const mn=nz(p.min,0);
      const sl=mk('input',{width:'100%','accent-color':col(p.thumbColor,'#007acc')});
      sl.id='slider_'+cid;sl.type='range';sl.min=String(mn);sl.max=String(nz(p.max,100));sl.step=String(nz(p.step,1));sl.value=String(mn);sl.disabled=disabled;
      let sv=null;if(p.showValue){sv=span(String(mn),{'font-size':'10px',color:'#888','font-family':'monospace'});sv.id='slv_'+cid;}
      el.appendChild(mk('div',Object.assign({display:'flex','flex-direction':'column','align-items':'center','justify-content':'center',gap:'2px',padding:'0 8px'},full),[sl,sv]));
      if(!disabled&&lk){sl.oninput=e=>{if(sv)sv.textContent=e.target.value;sendWrite(lk,Number(e.target.value));};}
      break;}
    case'LABEL':{
      const lbl=span(p.text,{'font-size':fs(p.fontSize,13),'font-weight':fw(p.fontWeight),color:col(p.color,'#d4d4d4'),'white-space':'nowrap',overflow:'hidden','text-overflow':'ellipsis'});lbl.id='lbl_'+cid;
      const box=mk('div',{background:col(p.background,'transparent'),'justify-content':p.align==='center'?'center':p.align==='right'?'flex-end':'flex-start'},[lbl]);box.className='lbl-comp';
      el.appendChild(box);
      break;}
    case'RECTANGLE':{
      const lbl=p.label?span(p.label,{'font-size':fs(p.fontSize,11),color:col(p.labelColor,'#888'),padding:'2px 6px'}):null;
      el.appendChild(mk('div',Object.assign({background:col(p.background,'transparent'),border:nz(p.borderWidth,1)+'px solid '+col(p.borderColor,'#444'),'border-radius':nz(p.borderRadius,0)+'px'},full),[lbl]));
      break;}
    case'CIRCLE':{
      const sz=Math.min(W,H);
      const c=mk('div',{width:sz+'px',height:sz+'px','border-radius':'50%',background:col(p.background,'transparent'),border:nz(p.borderWidth,1)+'px solid '+col(p.borderColor,'#444')});
      el.appendChild(mk('div',Object.assign({display:'flex','align-items':'center','justify-content':'center'},full),[c]));
      break;}
    case'LINE':{
      const horiz=(p.orientation||'horizontal')==='horizontal';
      const t=nz(p.thickness,1)+'px';
      const l=mk('div',{width:horiz?'100%':t,height:horiz?t:'100%',background:col(p.color,'#444')});
      el.appendChild(mk('div',Object.assign({display:'flex','align-items':'center','justify-content':'center'},full),[l]));
      break;}
    default:
      el.appendChild(mk('div',Object.assign({display:'flex','align-items':'center','justify-content':'center',border:'1px dashed #333',color:'#444','font-size':'11px'},full),[txt(comp.type)]));
  }
  canvas.appendChild(el);
}

function updateLive(){
  const pg=pages[currentPage];if(!pg)return;
  (pg.components||[]).forEach(comp=>{
    const p=(comp.props&&typeof comp.props==='object')?comp.props:{};
    const cid=txt(comp.id);
    const val=getVal(p.variable);
    const on=isOn(val);
    switch(comp.type){
      case'LED':{const c=document.getElementById('led_'+cid);if(c){const oc=col(p.onColor,'#00e676');c.style.background=on?oc:col(p.offColor,'#1a1a1a');c.style.boxShadow=on?'0 0 12px '+oc+',0 0 20px '+oc+'55':'inset 0 2px 6px rgba(0,0,0,.5)';}break;}
      case'ALARM':{const a=document.getElementById('alarm_'+cid);if(a){const path=a.querySelector('path');if(path)path.setAttribute('fill',on?col(p.activeColor,'#f14c4c'):col(p.inactiveColor,'#2a2a2a'));}const lbl=document.getElementById('alarmlbl_'+cid);if(lbl)lbl.style.color=on?col(p.activeColor,'#f14c4c'):'#555';break;}
      case'NUMERIC_DISPLAY':{const n=document.getElementById('num_'+cid);if(n)n.textContent=fmtVal(val,p.decimals);break;}
      case'PROGRESS':{const mn=nz(p.min,0),mx=nz(p.max,100),v=Math.min(mx,Math.max(mn,num(val,mn)));const pct=mx>mn?((v-mn)/(mx-mn))*100:0;const bar=document.getElementById('prog_'+cid);if(bar)bar.style.width=pct+'%';const pv=document.getElementById('progval_'+cid);if(pv)pv.textContent=v.toFixed(0);break;}
      case'TOGGLE_BUTTON':{const tb=document.getElementById('tbtn_'+cid);const tl=document.getElementById('tbtnlbl_'+cid);if(tb)tb.style.background=on?col(p.onColor,'#007a4d'):col(p.offColor,'#252525');if(tl)tl.textContent=on?txt(p.labelOn||'ON'):txt(p.labelOff||'OFF');break;}
      case'BUTTON':{if(p.mode==='toggle'){const btn=document.getElementById('btn_'+cid);if(btn)btn.style.background=on?col(p.onColor,'#007acc'):col(p.offColor,'#252525');}break;}
      case'SWITCH':{const sw=document.getElementById('sw_'+cid);const swt=document.getElementById('swt_'+cid);if(sw&&swt){sw.style.background=on?col(p.onColor,'#007acc'):col(p.offColor,'#333');const tw=sw.__tw||54,thumb=sw.__thumb||24;swt.style.left=on?(tw-thumb-2)+'px':'2px';}break;}
      case'SLIDER':{if(val===null||val===undefined)break;const sl=document.getElementById('slider_'+cid);if(sl)sl.value=String(num(val,0));const sv=document.getElementById('slv_'+cid);if(sv)sv.textContent=num(val,0).toFixed(0);break;}
      case'LABEL':{const lbl=document.getElementById('lbl_'+cid);if(lbl){if(p.variable&&val!==undefined){if(val===null){lbl.textContent='---';}else{const n=Number(val);lbl.textContent=isNaN(n)?String(val):n.toFixed(dec(p.decimals))+(p.unit?' '+txt(p.unit):'');}}else lbl.textContent=txt(p.text);}break;}
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
