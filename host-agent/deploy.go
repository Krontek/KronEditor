package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/krontek/hotswaplib"
)

// ── check_server_status ──────────────────────────────────────────────────────

type checkServerReq struct {
	ServerAddr string `json:"serverAddr"`
}

func (s *Server) handleCheckServerStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req checkServerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	url := "http://" + req.ServerAddr + "/status"
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "Connection failed: "+err.Error())
		return
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": string(body)})
}

// ── deploy_to_server ─────────────────────────────────────────────────────────

type deployToServerReq struct {
	ServerAddr string `json:"serverAddr"`
}

func (s *Server) handleDeployToServer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req deployToServerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	buildDir := s.paths.BuildDir()
	runtimeBytes, err := os.ReadFile(filepath.Join(buildDir, "runtime.bin"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read runtime.bin: "+err.Error())
		return
	}
	vtBytes, err := os.ReadFile(filepath.Join(buildDir, "variables.json"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read variables.json: "+err.Error())
		return
	}

	client := &http.Client{Timeout: 60 * time.Second}

	postBinary := func(url, contentType string, body []byte) error {
		resp, err := client.Post(url, contentType, bytes.NewReader(body))
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		return nil
	}

	if err := postBinary("http://"+req.ServerAddr+"/deploy/runtime", "application/octet-stream", runtimeBytes); err != nil {
		writeError(w, http.StatusBadGateway, "runtime deploy: "+err.Error())
		return
	}
	if err := postBinary("http://"+req.ServerAddr+"/deploy/variable-table", "application/json", vtBytes); err != nil {
		writeError(w, http.StatusBadGateway, "variable table deploy: "+err.Error())
		return
	}
	// NOTE: we deliberately do NOT push any logic_*.so here. Build & Send ships
	// a self-contained runtime.bin (compileForTarget), and a hot-swap build in
	// the SAME build dir leaves a cross-compiled logic_*.so behind — uploading
	// that here would wrongly flip KronServer into host mode and start the
	// plain self-contained runtime.bin with a mismatched/extra arg. Hot-swap
	// field deploys go through the dedicated handleHotSwapTargetDeploy below
	// instead, which is structurally separate so the two binary shapes
	// (self-contained vs loader-host+logic) can never be conflated again —
	// that conflation is exactly how the original field hot-swap regression
	// happened.
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "Deployed successfully"})
}

// handleHotSwapTargetDeploy uploads the hot-swap loader-host runtime.bin +
// variables.json + the currently-discovered logic_<gen>.so to a deployed
// KronServer as ONE atomic sequence — kept deliberately separate from
// handleDeployToServer (the plain Build & Send path) so the two binary
// shapes can never again be accidentally conflated (see that handler's
// comment for the regression this caused previously).
func (s *Server) handleHotSwapTargetDeploy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req deployToServerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	buildDir := s.paths.BuildDir()

	// Refuse to upload if the build dir's runtime.bin isn't actually the
	// hot-swap loader-host (e.g. a plain Build & Send ran afterward and
	// overwrote it with the self-contained binary at the same filename).
	kind, err := os.ReadFile(filepath.Join(buildDir, "runtime.bin.kind"))
	if err != nil || strings.TrimSpace(string(kind)) != "hotswap-host" {
		writeError(w, http.StatusBadRequest, "build dir's runtime.bin is not a hot-swap loader-host — run hotswap/target-build first (a plain Build & Send may have overwritten it)")
		return
	}

	runtimeBytes, err := os.ReadFile(filepath.Join(buildDir, "runtime.bin"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read runtime.bin: "+err.Error())
		return
	}
	vtBytes, err := os.ReadFile(filepath.Join(buildDir, "variables.json"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read variables.json: "+err.Error())
		return
	}
	_, logicPath, ok := hotswaplib.DiscoverGeneration(buildDir)
	if !ok {
		writeError(w, http.StatusInternalServerError, "no logic.so found in build dir — run hotswap/target-build first")
		return
	}
	logicBytes, err := os.ReadFile(logicPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read logic.so: "+err.Error())
		return
	}

	client := &http.Client{Timeout: 60 * time.Second}
	postBinary := func(url, contentType string, body []byte) error {
		resp, err := client.Post(url, contentType, bytes.NewReader(body))
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		return nil
	}

	if err := postBinary("http://"+req.ServerAddr+"/deploy/runtime", "application/octet-stream", runtimeBytes); err != nil {
		writeError(w, http.StatusBadGateway, "runtime deploy: "+err.Error())
		return
	}
	if err := postBinary("http://"+req.ServerAddr+"/deploy/variable-table", "application/json", vtBytes); err != nil {
		writeError(w, http.StatusBadGateway, "variable table deploy: "+err.Error())
		return
	}
	if err := postBinary("http://"+req.ServerAddr+"/deploy/logic", "application/octet-stream", logicBytes); err != nil {
		writeError(w, http.StatusBadGateway, "logic deploy: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "Hot-swap runtime deployed successfully"})
}

// deploy_server_to_target is implemented in deploy_ssh.go (SSH/SFTP).
