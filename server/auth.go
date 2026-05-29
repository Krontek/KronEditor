package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

// Role represents an access level.  Higher numeric value = more privileges.
type Role int

const (
	RoleViewer     Role = 1 // read-only on permitted pages
	RoleOperator   Role = 2 // read + write on operational pages
	RoleMaintainer Role = 3 // read + write on all pages, no user management
	RoleAdmin      Role = 4 // full access including user management
)

const (
	RoleNameViewer     = "viewer"
	RoleNameOperator   = "operator"
	RoleNameMaintainer = "maintainer"
	RoleNameAdmin      = "admin"
)

func ParseRole(s string) (Role, bool) {
	switch s {
	case RoleNameViewer:
		return RoleViewer, true
	case RoleNameOperator:
		return RoleOperator, true
	case RoleNameMaintainer:
		return RoleMaintainer, true
	case RoleNameAdmin:
		return RoleAdmin, true
	}
	return 0, false
}

func (r Role) String() string {
	switch r {
	case RoleViewer:
		return RoleNameViewer
	case RoleOperator:
		return RoleNameOperator
	case RoleMaintainer:
		return RoleNameMaintainer
	case RoleAdmin:
		return RoleNameAdmin
	}
	return "unknown"
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

type User struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	Role         Role   `json:"role"`
	PasswordHash string `json:"-"` // SHA-256(salt + ":" + password), hex
	Salt         string `json:"-"` // random 16-byte hex
}

func hashPassword(salt, password string) string {
	h := sha256.Sum256([]byte(salt + ":" + password))
	return hex.EncodeToString(h[:])
}

func newSalt() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (u *User) CheckPassword(password string) bool {
	return hashPassword(u.Salt, password) == u.PasswordHash
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const sessionTTL = 8 * time.Hour

type Session struct {
	Token     string
	Username  string
	Role      Role
	ExpiresAt time.Time
}

func (s *Session) Valid() bool {
	return time.Now().Before(s.ExpiresAt)
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

type SessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

func NewSessionStore() *SessionStore {
	ss := &SessionStore{sessions: make(map[string]*Session)}
	go ss.cleanupLoop()
	return ss
}

func (ss *SessionStore) Create(username string, role Role) *Session {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	token := hex.EncodeToString(b)
	s := &Session{
		Token:     token,
		Username:  username,
		Role:      role,
		ExpiresAt: time.Now().Add(sessionTTL),
	}
	ss.mu.Lock()
	ss.sessions[token] = s
	ss.mu.Unlock()
	return s
}

func (ss *SessionStore) Get(token string) (*Session, bool) {
	ss.mu.RLock()
	s, ok := ss.sessions[token]
	ss.mu.RUnlock()
	if !ok || !s.Valid() {
		return nil, false
	}
	return s, true
}

func (ss *SessionStore) Delete(token string) {
	ss.mu.Lock()
	delete(ss.sessions, token)
	ss.mu.Unlock()
}

func (ss *SessionStore) cleanupLoop() {
	for range time.Tick(15 * time.Minute) {
		ss.mu.Lock()
		for token, s := range ss.sessions {
			if !s.Valid() {
				delete(ss.sessions, token)
			}
		}
		ss.mu.Unlock()
	}
}

// ---------------------------------------------------------------------------
// UserStore
// ---------------------------------------------------------------------------

type UserStore struct {
	mu    sync.RWMutex
	users map[string]*User // key = username (lower-cased)
}

func NewUserStore() *UserStore {
	return &UserStore{users: make(map[string]*User)}
}

// LoadUsers replaces all users (called when new HMI config is deployed).
func (us *UserStore) LoadUsers(users []User) {
	us.mu.Lock()
	defer us.mu.Unlock()
	us.users = make(map[string]*User, len(users))
	for i := range users {
		u := users[i]
		us.users[u.Username] = &u
	}
}

func (us *UserStore) Authenticate(username, password string) (*User, bool) {
	us.mu.RLock()
	u, ok := us.users[username]
	us.mu.RUnlock()
	if !ok {
		return nil, false
	}
	if !u.CheckPassword(password) {
		return nil, false
	}
	return u, true
}

func (us *UserStore) GetAll() []User {
	us.mu.RLock()
	defer us.mu.RUnlock()
	out := make([]User, 0, len(us.users))
	for _, u := range us.users {
		out = append(out, User{
			ID:       u.ID,
			Username: u.Username,
			Role:     u.Role,
		})
	}
	return out
}

func (us *UserStore) Count() int {
	us.mu.RLock()
	defer us.mu.RUnlock()
	return len(us.users)
}

// ---------------------------------------------------------------------------
// Middleware helpers
// ---------------------------------------------------------------------------

const sessionCookieName = "kron_session"

// sessionFromRequest extracts and validates the session from the request cookie.
func sessionFromRequest(r *http.Request, ss *SessionStore) (*Session, bool) {
	c, err := r.Cookie(sessionCookieName)
	if err != nil {
		return nil, false
	}
	return ss.Get(c.Value)
}

// requireSession is a middleware that redirects to the login page if no valid session.
// If no users are configured, auth is bypassed entirely (open access).
func requireSession(us *UserStore, ss *SessionStore, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if us.Count() == 0 {
			next(w, r)
			return
		}
		if _, ok := sessionFromRequest(r, ss); !ok {
			http.Redirect(w, r, hmiBase(r)+"/login", http.StatusSeeOther)
			return
		}
		next(w, r)
	}
}

// requireRole is a middleware that returns 403 if the session role < minRole.
func requireRole(ss *SessionStore, minRole Role, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, ok := sessionFromRequest(r, ss)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if s.Role < minRole {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

// jsonError writes a JSON error response.
func jsonError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"error":%q}`, msg)
}
