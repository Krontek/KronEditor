package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"sync"

	"github.com/krontek/hotswaplib"
)

// hotswap.go — field (on-target) online change.
//
// The editor's hot-swap deploy ships runtime.bin as the loader-host plus
// logic_0.so (see host-agent/deploy.go's handleHotSwapTargetDeploy). To apply
// a code change WITHOUT restarting the machine (state preserved), the editor:
//   POST /deploy/logic   (body = new logic .so)        → saved as logic_<n>.so
//   POST /hotswap/swap   {"logic":"logic_<n>.so"}      → host swaps it live,
//                                                          response blocks
//                                                          until the swap's
//                                                          outcome is CONFIRMED
//
// Generation numbers are discovered from disk (hotswaplib.DiscoverGeneration/
// NextGeneration) instead of an in-memory counter — the in-memory counter
// (starting the first upload at logic_1.so while process.go's startup check
// only ever looked for the literal logic_0.so) was the confirmed root cause
// of field hot-swap never working. Cleanup of an old .so happens only once
// ProcessManager.SwapLogic has POLLED AND CONFIRMED the new generation is
// actually running (see process.go) — never optimistically on upload.
//
// Safety: the loader-host validates (including a PlcState layout-hash check,
// not just symbol presence) and rolls back a bad .so; the swap happens at a
// scan boundary. A LAYOUT-changing edit (new/removed/retyped variable) is
// refused by the loader-host regardless of what the editor's own pre-flight
// guard concluded. On real hardware this path needs the HAL to live in the
// host (so IO state survives a swap) and an operator confirmation before
// applying — see the editor-side guards. This path remains UNVERIFIED on
// physical hardware (compile- and logic-verified only).

// deployLogicMu serializes generation discovery + save in handleDeployLogic:
// two concurrent uploads would otherwise both get the same NextGeneration
// and silently overwrite each other's .so.
var deployLogicMu sync.Mutex

func (s *Server) handleDeployLogic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST is supported", http.StatusMethodNotAllowed)
		return
	}
	deployLogicMu.Lock()
	defer deployLogicMu.Unlock()

	// Two modes, both bounded to the fixed ping-pong slots {0,1} — the number
	// never grows the way the old NextGeneration ("highest+1") scheme did.
	//   ?cold=1  → initial hot-swap deploy: wipe any stale logic_*.so from a
	//              previous session and install exactly logic_0.so, so the next
	//              Start() finds a single unambiguous file and runs generation 0.
	//   default  → online change: place into the slot that is NOT the one the
	//              loader-host is CONFIRMED running (ConfirmedGen), so we are
	//              always certain which generation is live and which is being
	//              sent. When the runtime isn't running yet we fall back to the
	//              cold behavior (fresh slot 0) rather than guessing.
	var gen int
	if r.URL.Query().Get("cold") == "1" {
		_ = hotswaplib.CleanupExcept(s.cfg.DeployDir, -1) // remove every stale slot
		_ = hotswaplib.ClearResultFile(filepath.Join(s.cfg.DeployDir, "swap_result"))
		gen = 0
	} else if cur := s.pm.ConfirmedGen(); cur >= 0 {
		gen = hotswaplib.PingPongGeneration(cur)
	} else {
		_ = hotswaplib.CleanupExcept(s.cfg.DeployDir, -1)
		gen = 0
	}

	dest := hotswaplib.GenerationPath(s.cfg.DeployDir, gen)
	name := filepath.Base(dest)
	// saveUpload writes a temp file then renames atomically, so reusing a slot
	// name can never truncate a .so the running loader-host still has mmap'd.
	if err := s.saveUpload(r, dest, false); err != nil {
		slog.Error("failed to save logic.so", "err", err)
		http.Error(w, "failed to save file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	slog.Info("logic.so uploaded", "dest", dest, "generation", gen)
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
		// Default to whatever is actually on disk — discovered, not an
		// in-memory counter that can desync from reality after a restart.
		_, path, ok := hotswaplib.DiscoverGeneration(s.cfg.DeployDir)
		if !ok {
			http.Error(w, "no logic uploaded — POST /deploy/logic first", http.StatusBadRequest)
			return
		}
		body.Logic = filepath.Base(path)
	}
	status, detail, err := s.pm.SwapLogic(body.Logic)
	if err != nil {
		if errors.Is(err, hotswaplib.ErrTimeout) {
			// Outcome genuinely unknown — never assume success or failure.
			http.Error(w, fmt.Sprintf("hot-swap outcome unknown: %v", err), http.StatusGatewayTimeout)
		} else {
			http.Error(w, fmt.Sprintf("hot-swap request failed: %v", err), http.StatusBadRequest)
		}
		return
	}
	if status != "OK" {
		// The swap was attempted and the loader-host REJECTED it (e.g. a
		// layout mismatch) — the previous generation is still running.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": status, "logic": body.Logic, "reason": detail})
		return
	}
	jsonOK(w, map[string]string{"status": status, "logic": body.Logic, "reason": detail})
}
