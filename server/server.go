// server.go - HTTP server (ConnectRPC + deploy endpoints)
//
// Endpoints (ConnectRPC — Connect/gRPC/gRPC-Web protocols on /plc.v1.PLCService/):
//   /plc.v1.PLCService/Start
//   /plc.v1.PLCService/Stop
//   /plc.v1.PLCService/WriteVar
//   /plc.v1.PLCService/ClearAllForces
//   /plc.v1.PLCService/StreamVars  ← server streaming, pushes every 50 ms
//
// HTTP endpoints (unchanged):
//   POST /deploy/runtime          → upload runtime.bin
//   POST /deploy/variable-table   → upload variable_table.json
//   GET  /status                  → JSON status report
//
// REST API for addressed variables (password-protected):
//   POST /api/v1/auth              → authenticate, receive bearer token
//   GET  /api/v1/variables         → all addressed variables
//   GET  /api/v1/variables/{name}  → single addressed variable
//   POST /api/v1/variables/{name}  → write addressed variable
//   GET  /api/v1/stream            → SSE stream (addressed only, 50 ms)
//   POST /api/v1/forces/clear      → clear force flags

package main

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	connect "connectrpc.com/connect"
	"encoding/json"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
	plcv1connect "plc-agent/gen/plc/v1/plcv1connect"
)

const maxUploadSize = 128 << 20 // 128 MB

// RuntimeConfig holds settings that persist across restarts (deploy-dir/runtime_config.json).
//
// StreamIntervalMs controls ONLY the /api/v1/stream cadence (addressed
// variables, external clients). Editor-facing streams (gRPC StreamVars
// and /stream/vars) always use the fixed streamInterval constant.
// Zero means "use default" (defaultAPIStreamIntervalMs).
type RuntimeConfig struct {
	AutoRun          bool   `json:"auto_run"`
	StreamIntervalMs uint32 `json:"stream_interval_ms,omitempty"`
	// HMIPort is the TCP port for the dedicated, operator-facing HMI listener
	// (served at the root: http://ip:HMIPort/). 0 = HMI not published on a
	// dedicated port (it remains reachable on the agent port under /hmi/).
	HMIPort uint16 `json:"hmi_port,omitempty"`
}

// runtimeConfigUpdate is the partial-update payload accepted by
// /deploy/config and /api/v1/runtime/config. Pointer fields let callers
// touch only what they care about without resetting other settings.
type runtimeConfigUpdate struct {
	AutoRun          *bool   `json:"auto_run,omitempty"`
	StreamIntervalMs *uint32 `json:"stream_interval_ms,omitempty"`
	HMIPort          *uint16 `json:"hmi_port,omitempty"`
}

// Server handles HTTP and ConnectRPC traffic.
type Server struct {
	cfg     Config
	ipc     *IPCManager
	pm      *ProcessManager
	hmi     *HMIManager
	rtMu    sync.Mutex // guards rtCfg
	rtCfg   RuntimeConfig
	mux     *http.ServeMux
	httpSrv *http.Server

	hmiMu   sync.Mutex   // guards the dedicated HMI listener
	hmiSrv  *http.Server // dedicated operator-facing HMI server (nil if none)
	hmiPort uint16       // port hmiSrv is currently bound to (0 if none)
}

func NewServer(cfg Config, ipc *IPCManager, pm *ProcessManager, hmi *HMIManager) *Server {
	s := &Server{cfg: cfg, ipc: ipc, pm: pm, hmi: hmi, mux: http.NewServeMux()}
	s.loadRuntimeConfig()
	s.loadStoredVariableTable()
	s.registerRoutes()

	// h2c allows HTTP/2 without TLS (required for gRPC protocol).
	// The Connect protocol also works over HTTP/1.1 so this covers all clients.
	h2cHandler := h2c.NewHandler(corsMiddleware(s.mux), &http2.Server{})

	s.httpSrv = &http.Server{
		Addr:        cfg.ListenAddr,
		Handler:     h2cHandler,
		ReadTimeout: 60 * time.Second,
		// WriteTimeout must be 0 for streaming RPCs (server streaming never "finishes").
		WriteTimeout: 0,
		IdleTimeout:  120 * time.Second,
	}
	return s
}

func (s *Server) registerRoutes() {
	// Deploy / status (plain HTTP, unchanged).
	s.mux.HandleFunc("/deploy/runtime", s.handleDeployRuntime)
	s.mux.HandleFunc("/deploy/logic", s.handleDeployLogic) // hot-swap logic .so
	s.mux.HandleFunc("/hotswap/swap", s.handleHotSwap)     // apply online change
	s.mux.HandleFunc("/deploy/variable-table", s.handleDeployVariableTable)
	s.mux.HandleFunc("/deploy/project-file", s.handleProjectFile)
	s.mux.HandleFunc("/deploy/config", s.handleDeployConfig)
	s.mux.HandleFunc("/status", s.handleStatus)

	// ConnectRPC service (Connect + gRPC + gRPC-Web protocols).
	svc := NewPLCService(s.ipc, s.pm)
	path, handler := plcv1connect.NewPLCServiceHandler(svc,
		connect.WithCompressMinBytes(1024), // gzip responses ≥ 1 KB
	)
	s.mux.Handle(path, handler)

	// SSE streaming endpoint for live variable data.
	// Used by browser clients (Tauri/WebKit) where fetch streaming is buffered.
	s.mux.HandleFunc("/stream/vars", s.handleSSEVars)

	// HMI web interface (authentication, layout, variable access).
	RegisterHMIRoutes(s.mux, s.hmi)

	// REST API for addressed variables (external access: Python, SCADA, HMI).
	api := NewAPIManager(s.ipc, s)
	RegisterAPIRoutes(s.mux, api)
}

// Start launches the server in background (non-blocking).
func (s *Server) Start() error {
	ln, err := net.Listen("tcp", s.cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("failed to start TCP listener (%s): %w", s.cfg.ListenAddr, err)
	}
	slog.Info("Server listening", "addr", ln.Addr().String())
	go func() {
		if err := s.httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("HTTP server error", "err", err)
		}
	}()

	// Bring up the dedicated HMI listener if one was configured (deployed).
	s.applyHMIPort(s.rtCfg.HMIPort)
	return nil
}

// applyHMIPort (re)binds the dedicated operator-facing HMI listener.
//
//   - port == current bound port → no-op
//   - port == 0                  → tear down any existing listener
//   - otherwise                  → stop the old listener (if any) and serve the
//     HMI at the root on the new port
//
// Bind failures are logged, not fatal: the HMI stays reachable on the agent
// port under /hmi/, and the agent keeps running.
func (s *Server) applyHMIPort(port uint16) {
	s.hmiMu.Lock()
	defer s.hmiMu.Unlock()

	if s.hmiSrv != nil && s.hmiPort == port {
		return
	}
	if s.hmiSrv != nil {
		old := s.hmiSrv
		s.hmiSrv = nil
		s.hmiPort = 0
		go old.Close()
		slog.Info("HMI listener stopped", "port", port)
	}
	if port == 0 {
		return
	}

	mux := http.NewServeMux()
	RegisterHMIRoutesAtRoot(mux, s.hmi)
	srv := &http.Server{
		Handler:     mux,
		ReadTimeout: 60 * time.Second,
		IdleTimeout: 120 * time.Second,
	}
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		slog.Error("failed to start HMI listener", "port", port, "err", err)
		return
	}
	s.hmiSrv = srv
	s.hmiPort = port
	go func() {
		slog.Info("HMI listening", "addr", ln.Addr().String())
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("HMI server error", "err", err)
		}
	}()
}

// corsMiddleware adds permissive CORS headers required by browser-based clients.
// ConnectRPC's browser transport (connect-web) needs these.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers",
			"Content-Type, Connect-Protocol-Version, Connect-Timeout-Ms, "+
				"Grpc-Timeout, X-Grpc-Web, X-User-Agent")
		w.Header().Set("Access-Control-Expose-Headers",
			"Grpc-Status, Grpc-Message, Grpc-Status-Details-Bin")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- Deploy / status endpoints ---

func (s *Server) handleDeployRuntime(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST is supported", http.StatusMethodNotAllowed)
		return
	}
	dest := filepath.Join(s.cfg.DeployDir, "runtime.bin")
	if err := s.saveUpload(r, dest, true /*executable*/); err != nil {
		slog.Error("failed to save runtime.bin", "err", err)
		http.Error(w, "failed to save file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	slog.Info("runtime.bin uploaded successfully", "dest", dest)
	jsonOK(w, map[string]string{"status": "ok", "path": dest})
}

func (s *Server) handleDeployVariableTable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST is supported", http.StatusMethodNotAllowed)
		return
	}
	dest := filepath.Join(s.cfg.DeployDir, "variable_table.json")
	if err := s.saveUpload(r, dest, false); err != nil {
		slog.Error("failed to save variable_table.json", "err", err)
		http.Error(w, "failed to save file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if err := s.ipc.LoadVariableTable(dest); err != nil {
		slog.Error("failed to parse variable table", "err", err)
		http.Error(w, "failed to parse table: "+err.Error(), http.StatusUnprocessableEntity)
		return
	}
	count := s.ipc.VariableCount()
	slog.Info("variable_table.json loaded", "dest", dest, "variables", count)
	jsonOK(w, map[string]any{"status": "ok", "path": dest, "variable_count": count})
}

// handleProjectFile stores (POST) or returns (GET) the editor project source
// file ({deploy-dir}/project.xml) alongside the deployed runtime. This lets a
// project be pulled back into the editor from the target ("Pull from Target").
// The project file is for the editor only — the runtime does not read it.
func (s *Server) handleProjectFile(w http.ResponseWriter, r *http.Request) {
	dest := filepath.Join(s.cfg.DeployDir, "project.xml")
	switch r.Method {
	case http.MethodPost:
		if err := s.saveUpload(r, dest, false); err != nil {
			slog.Error("failed to save project.xml", "err", err)
			http.Error(w, "failed to save file: "+err.Error(), http.StatusInternalServerError)
			return
		}
		slog.Info("project.xml uploaded successfully", "dest", dest)
		jsonOK(w, map[string]string{"status": "ok", "path": dest})
	case http.MethodGet:
		data, err := os.ReadFile(dest)
		if err != nil {
			http.Error(w, "no project file deployed", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/xml")
		_, _ = w.Write(data)
	default:
		http.Error(w, "only GET and POST are supported", http.StatusMethodNotAllowed)
	}
}

// runtimeConfigPath returns the path to the persisted runtime config file.
func (s *Server) runtimeConfigPath() string {
	return filepath.Join(s.cfg.DeployDir, "runtime_config.json")
}

// loadRuntimeConfig reads runtime_config.json from disk. Missing file = defaults (no autorun).
// Called once at startup before the listener is up, so no locking needed.
func (s *Server) loadRuntimeConfig() {
	data, err := os.ReadFile(s.runtimeConfigPath())
	if err != nil {
		return // File doesn't exist yet — use defaults
	}
	_ = json.Unmarshal(data, &s.rtCfg)
	if s.rtCfg.StreamIntervalMs > 0 {
		s.rtCfg.StreamIntervalMs = SetAPIStreamIntervalMs(s.rtCfg.StreamIntervalMs)
	}
	slog.Info("Runtime config loaded",
		"auto_run", s.rtCfg.AutoRun,
		"stream_interval_ms", uint32(GetAPIStreamInterval()/time.Millisecond),
	)
}

// loadStoredVariableTable rehydrates the in-memory symbol table from
// {deploy-dir}/variable_table.json on agent startup.
//
// Without this, /api/v1/auth would return 503 ("API is not configured")
// after every agent restart until the editor re-deployed the table —
// even though the file was sitting on disk the whole time. Same goes
// for /api/v1/variables, /stream, etc. (API password lives inside this
// file too.) Missing-file is treated as "fresh install" and ignored.
func (s *Server) loadStoredVariableTable() {
	path := filepath.Join(s.cfg.DeployDir, "variable_table.json")
	if _, err := os.Stat(path); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			slog.Warn("variable_table.json stat failed", "path", path, "err", err)
		}
		return
	}
	if err := s.ipc.LoadVariableTable(path); err != nil {
		slog.Warn("Failed to load variable_table.json on startup",
			"path", path, "err", err)
		return
	}
	slog.Info("variable_table.json loaded on startup",
		"path", path, "variables", s.ipc.VariableCount())
}

// saveRuntimeConfig persists the current runtime config to disk.
// Caller must hold rtMu.
func (s *Server) saveRuntimeConfig() error {
	if err := os.MkdirAll(s.cfg.DeployDir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s.rtCfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.runtimeConfigPath(), data, 0644)
}

// AutoRunEnabled returns whether autorun is configured. Used by main.go at
// startup before any HTTP traffic; safe without locking but goes through
// the lock for consistency with the live update path.
func (s *Server) AutoRunEnabled() bool {
	s.rtMu.Lock()
	defer s.rtMu.Unlock()
	return s.rtCfg.AutoRun
}

// handleDeployConfig receives runtime configuration from the editor.
// Accepts a partial JSON body — only fields that are present are updated,
// so the editor can push {"auto_run": false} without clobbering an
// API-tuned stream_interval_ms (and vice versa).
//
//	POST /deploy/config
//	Body: {"auto_run": true, "stream_interval_ms": 100}   (both fields optional)
func (s *Server) handleDeployConfig(w http.ResponseWriter, r *http.Request) {
	var u runtimeConfigUpdate
	if err := json.NewDecoder(r.Body).Decode(&u); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	snap := s.UpdateRuntimeConfig(u)
	jsonOK(w, snap)
}

// UpdateRuntimeConfig merges a partial update into rtCfg, persists it,
// pushes side-effects (streaming cadence) into the live atomic, and
// returns the resulting snapshot. Implements RuntimeController.
//
// AutoRun side-effects (only when u.AutoRun is explicitly set):
//   - true  + runtime not running → start runtime immediately
//   - true  + runtime running     → no-op (already serving)
//   - false                       → cancel any pending auto-restart timer;
//     a currently running runtime is left
//     alone (user manually stops if desired)
func (s *Server) UpdateRuntimeConfig(u runtimeConfigUpdate) map[string]any {
	s.rtMu.Lock()
	if u.AutoRun != nil {
		s.rtCfg.AutoRun = *u.AutoRun
	}
	if u.StreamIntervalMs != nil {
		s.rtCfg.StreamIntervalMs = SetAPIStreamIntervalMs(*u.StreamIntervalMs)
	}
	if u.HMIPort != nil {
		s.rtCfg.HMIPort = *u.HMIPort
	}
	if err := s.saveRuntimeConfig(); err != nil {
		slog.Warn("Failed to save runtime config", "err", err)
	}
	snap := s.runtimeConfigSnapshotLocked()
	autoRun := s.rtCfg.AutoRun
	hmiPort := s.rtCfg.HMIPort
	s.rtMu.Unlock()

	// Apply an HMI-port change outside the rtMu lock (it takes its own lock
	// and starts a goroutine). Skip when the request didn't touch the port.
	if u.HMIPort != nil {
		s.applyHMIPort(hmiPort)
	}

	slog.Info("Runtime config updated",
		"auto_run", autoRun,
		"stream_interval_ms", uint32(GetAPIStreamInterval()/time.Millisecond),
	)

	// Side effects of an explicit AutoRun toggle (skip if the request did
	// not touch this field — e.g. a stream-interval-only update from the API).
	if u.AutoRun != nil {
		if autoRun {
			if _, running := s.pm.Status(); !running {
				slog.Info("AutoRun enabled — starting runtime")
				s.ipc.WriteInitialValues()
				if err := s.pm.Start(); err != nil {
					slog.Warn("AutoRun: start failed", "err", err)
				}
			}
		} else {
			// Toggle off: cancel any pending crash-restart. Running runtime
			// is intentionally left alone — user must stop it manually.
			s.pm.CancelPendingRestart()
		}
	}

	return snap
}

// RuntimeConfigSnapshot returns the live config view (includes the effective
// stream interval, resolved from the atomic). Implements RuntimeController.
func (s *Server) RuntimeConfigSnapshot() map[string]any {
	s.rtMu.Lock()
	defer s.rtMu.Unlock()
	return s.runtimeConfigSnapshotLocked()
}

// runtimeConfigSnapshotLocked must be called with rtMu held.
func (s *Server) runtimeConfigSnapshotLocked() map[string]any {
	return map[string]any{
		"auto_run":           s.rtCfg.AutoRun,
		"stream_interval_ms": uint32(GetAPIStreamInterval() / time.Millisecond),
		"hmi_port":           s.rtCfg.HMIPort,
	}
}

// StartRuntime mirrors the ConnectRPC Start: write initial values, then
// spawn the runtime. Implements RuntimeController.
func (s *Server) StartRuntime() (int, error) {
	s.ipc.WriteInitialValues()
	if err := s.pm.Start(); err != nil {
		return 0, err
	}
	pid, _ := s.pm.Status()
	return pid, nil
}

// StopRuntime gracefully terminates the PLC runtime. Implements RuntimeController.
func (s *Server) StopRuntime() error {
	return s.pm.Stop()
}

// RuntimeStatus returns (pid, running). Implements RuntimeController.
func (s *Server) RuntimeStatus() (int, bool) {
	return s.pm.Status()
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	pid, running := s.pm.Status()
	s.rtMu.Lock()
	autoRun := s.rtCfg.AutoRun
	hmiPort := s.rtCfg.HMIPort
	s.rtMu.Unlock()
	jsonOK(w, map[string]any{
		"running":            running,
		"pid":                pid,
		"variable_count":     s.ipc.VariableCount(),
		"shm_name":           s.cfg.ShmName,
		"deploy_dir":         s.cfg.DeployDir,
		"auto_run":           autoRun,
		"stream_interval_ms": uint32(GetAPIStreamInterval() / time.Millisecond),
		"hmi_port":           hmiPort,
	})
}

// saveUpload writes raw bytes from HTTP body to disk atomically.
func (s *Server) saveUpload(r *http.Request, dest string, executable bool) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}
	r.Body = http.MaxBytesReader(nil, r.Body, maxUploadSize)

	tmp := dest + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("failed to open temp file: %w", err)
	}
	written, err := io.Copy(f, r.Body)
	f.Close()
	if err != nil {
		os.Remove(tmp)
		return fmt.Errorf("failed to write data (%d bytes written): %w", written, err)
	}
	if written == 0 {
		os.Remove(tmp)
		return errors.New("uploaded content is empty")
	}

	perm := os.FileMode(0644)
	if executable {
		perm = 0755
	}
	if err := os.Chmod(tmp, perm); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("failed to set permissions: %w", err)
	}
	if err := os.Rename(tmp, dest); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("atomic move failed: %w", err)
	}
	slog.Debug("File saved", "dest", dest, "bytes", written)
	return nil
}

// handleSSEVars pushes all variable values every streamInterval (50 ms)
// via Server-Sent Events. Used by Tauri/WebKit clients where fetch
// streaming is buffered end-to-end. Cadence is intentionally fixed —
// this is the editor stream, not the user-tunable /api/v1/stream.
func (s *Server) handleSSEVars(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering

	slog.Info("SSE stream started", "remote", r.RemoteAddr)
	ticker := time.NewTicker(streamInterval)
	heartbeat := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			slog.Info("SSE stream ended", "remote", r.RemoteAddr)
			return
		case <-heartbeat.C:
			if _, err := fmt.Fprintf(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			vars, err := s.ipc.ReadAllVariables()
			if err != nil {
				continue
			}
			data, err := json.Marshal(vars)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func jsonOK(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
