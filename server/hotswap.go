package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strconv"
	"sync/atomic"
)

// hotswap.go — field (on-target) online change.
//
// The editor's Build & Send (hot-swap mode) deploys runtime.bin as the
// loader-host plus logic_0.so. To apply a code change WITHOUT restarting the
// machine (state preserved), the editor:
//   POST /deploy/logic   (body = new logic .so)        → saved as logic_<n>.so
//   POST /hotswap/swap   {"logic":"logic_<n>.so"}      → host swaps it live
//
// Safety: the loader-host validates and rolls back a bad .so; the swap happens
// at a scan boundary. A LAYOUT-changing edit (new/removed/retyped variable)
// must NOT be hot-swapped — that is the editor's responsibility to detect and
// fall back to a full redeploy + restart. On real hardware this path needs the
// HAL to live in the host (so IO state survives a swap) and an operator
// confirmation before applying — see the editor-side guards.

// logicVersion counts deployed logic .so files for this agent run.
var logicVersion int64

func (s *Server) handleDeployLogic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST is supported", http.StatusMethodNotAllowed)
		return
	}
	ver := atomic.AddInt64(&logicVersion, 1)
	name := "logic_" + strconv.FormatInt(ver, 10) + ".so"
	dest := filepath.Join(s.cfg.DeployDir, name)
	if err := s.saveUpload(r, dest, false); err != nil {
		slog.Error("failed to save logic.so", "err", err)
		http.Error(w, "failed to save file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	slog.Info("logic.so uploaded", "dest", dest)
	jsonOK(w, map[string]string{"status": "ok", "logic": name, "path": dest})
}

func (s *Server) handleHotSwap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST is supported", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Logic string `json:"logic"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.Logic == "" {
		// Default to the most recently uploaded logic.
		ver := atomic.LoadInt64(&logicVersion)
		if ver == 0 {
			http.Error(w, "no logic uploaded — POST /deploy/logic first", http.StatusBadRequest)
			return
		}
		body.Logic = "logic_" + strconv.FormatInt(ver, 10) + ".so"
	}
	if err := s.pm.SwapLogic(body.Logic); err != nil {
		http.Error(w, fmt.Sprintf("hot-swap failed: %v", err), http.StatusConflict)
		return
	}
	jsonOK(w, map[string]string{"status": "ok", "logic": body.Logic})
}
