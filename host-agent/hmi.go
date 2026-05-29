package main

import (
	"encoding/json"
	"net/http"
	"sync"
)

// HmiState is a minimal stand-in for the Tauri HMI server. The Tauri
// implementation runs a separate HTTP server on a configurable port that
// serves an embedded HTML page + variable poll/write JSON endpoints. Porting
// that page (~600 lines of embedded HTML/JS) is deferred — for now the editor
// can still call start/stop/push/poll, but no real HTTP server is launched.

type HmiState struct {
	mu      sync.Mutex
	running bool
	port    uint16
	vars    string
	writes  []hmiWrite
}

type hmiWrite struct {
	Key   string      `json:"key"`
	Value interface{} `json:"value"`
}

func NewHmiState() *HmiState { return &HmiState{} }
func (h *HmiState) Stop() {
	h.mu.Lock()
	h.running = false
	h.mu.Unlock()
}

type startHmiReq struct {
	Port       uint16 `json:"port"`
	LayoutJSON string `json:"layoutJson"`
}

func (s *Server) handleStartHmiServer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req startHmiReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	s.hmi.mu.Lock()
	s.hmi.running = true
	s.hmi.port = req.Port
	s.hmi.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": "HMI server is a stub in host-agent — embedded HTML not yet ported",
	})
}

func (s *Server) handleStopHmiServer(w http.ResponseWriter, r *http.Request) {
	s.hmi.Stop()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type pushHmiReq struct {
	VarsJSON string `json:"varsJson"`
}

func (s *Server) handlePushHmiVariables(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req pushHmiReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.hmi.mu.Lock()
	s.hmi.vars = req.VarsJSON
	s.hmi.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handlePollHmiWrites(w http.ResponseWriter, r *http.Request) {
	s.hmi.mu.Lock()
	writes := s.hmi.writes
	s.hmi.writes = nil
	s.hmi.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "writes": writes})
}
