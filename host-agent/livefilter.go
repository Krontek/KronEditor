package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
)

// LiveFilter narrows WHICH debug variables the simulation pollers read out of
// shared memory and stream to the editor.
//
// The editor used to receive every variable of every program on every tick —
// a full project's worth of decode + JSON five times a second, of which the
// user could see a handful. The editor now declares what it is actually
// looking at (the open POU tabs, the watch table, the HMI bindings) and the
// poller reads only that.
//
// ⚠️ An EMPTY filter means EVERYTHING, deliberately: it is the state at sim
// start, before the editor has sent its first subscription, and the state an
// older frontend leaves it in. Narrowing is always an explicit act.
//
// The subscription is expressed as PREFIXES plus explicit NAMES, not as one
// flat key list: a program's keys all share `prog_<Name>_`, and globals share
// `prog__`, so "this tab plus the globals" is two short strings instead of
// thousands of names in a request body.
type LiveFilter struct {
	mu       sync.RWMutex
	gen      uint64 // bumped on every Set — pollers rebuild their plan when it moves
	prefixes []string
	names    map[string]struct{}
}

func NewLiveFilter() *LiveFilter { return &LiveFilter{} }

// Set replaces the subscription and bumps the generation. Passing nothing
// restores "stream everything".
func (f *LiveFilter) Set(prefixes, names []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prefixes = append([]string(nil), prefixes...)
	f.names = make(map[string]struct{}, len(names))
	for _, n := range names {
		f.names[n] = struct{}{}
	}
	f.gen++
}

// Gen is the current subscription generation. A poller compares it against the
// generation its plan was built from.
func (f *LiveFilter) Gen() uint64 {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.gen
}

// Snapshot returns the generation together with a matcher for it, so a poller
// can never build a plan under one subscription and label it with another.
func (f *LiveFilter) Snapshot() (uint64, func(string) bool) {
	f.mu.RLock()
	gen, prefixes, names := f.gen, f.prefixes, f.names
	f.mu.RUnlock()

	if len(prefixes) == 0 && len(names) == 0 {
		return gen, func(string) bool { return true }
	}
	return gen, func(key string) bool {
		if _, ok := names[key]; ok {
			return true
		}
		for _, p := range prefixes {
			if strings.HasPrefix(key, p) {
				return true
			}
		}
		return false
	}
}

// handleLiveSubscribe sets the live-variable subscription for the running
// simulation. It is intentionally independent of the sim lifecycle: the editor
// may send it before, during or after a run, and a poller started later picks
// up whatever is current.
func (s *Server) handleLiveSubscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req struct {
		Prefixes []string `json:"prefixes"`
		Names    []string `json:"names"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	s.live.Set(req.Prefixes, req.Names)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "generation": s.live.Gen()})
}
