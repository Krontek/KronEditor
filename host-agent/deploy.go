package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
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
	// NOTE: we deliberately do NOT push logic_0.so. Build & Send ships a
	// self-contained runtime.bin (compileForTarget), and the sim hot-swap build
	// leaves an x86 logic_0.so in the SAME build dir — uploading that to an ARM
	// target would wrongly flip KronServer into host mode and start the runtime
	// with a mismatched/extra arg. Remote hot reload is disabled (see App.jsx).
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "Deployed successfully"})
}

// deploy_server_to_target is implemented in deploy_ssh.go (SSH/SFTP).
