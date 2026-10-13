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
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	connect "connectrpc.com/connect"
	"encoding/json"
	"github.com/krontek/hotswaplib"
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
	// RingRAMPercent sizes the lossless capture ring as a percentage of the
	// device's *available* RAM (clamped to ringMaxRAMPercent). 0 = use the
	// default byte size. Applied at runtime (re)start via createRingSegment.
	RingRAMPercent float64 `json:"ring_ram_percent,omitempty"`
}

// runtimeConfigUpdate is the partial-update payload accepted by
// /deploy/config and /api/v1/runtime/config. Pointer fields let callers
// touch only what they care about without resetting other settings.
type runtimeConfigUpdate struct {
	AutoRun          *bool    `json:"auto_run,omitempty"`
	StreamIntervalMs *uint32  `json:"stream_interval_ms,omitempty"`
	HMIPort          *uint16  `json:"hmi_port,omitempty"`
	RingRAMPercent   *float64 `json:"ring_ram_percent,omitempty"`
	// Restart is a transient ACTION flag (not persisted): when true, the
	// runtime is (re)started with the freshly-deployed binary. Build & Send
	// sets this as its final step so a new push actually takes effect — merely
	// overwriting runtime.bin on disk does NOT swap the code of an
	// already-running process.
	Restart *bool `json:"restart,omitempty"`
}

// Server handles HTTP and ConnectRPC traffic.
type Server struct {
	cfg     Config
	ipc     *IPCManager
	pm      *ProcessManager
	hmi     *HMIManager
	api     *APIManager // owns the shared capture-ring consumer (see SizeRingSegment)
	rtMu    sync.Mutex  // guards rtCfg
	rtCfg   RuntimeConfig
	mux     *http.ServeMux
	httpSrv *http.Server
	ln      net.Listener // claimed by Bind, consumed by Start (main-goroutine only)

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
	api := NewAPIManager(s.ipc, s, s.cfg.ShmName)
	s.api = api
	RegisterAPIRoutes(s.mux, api)
}

// Bind claims the listen address WITHOUT serving yet, so a second agent
// instance loses the port before it can touch shared state.
//
// ⚠️ Bind must happen before ProcessManager.CleanupOrphanRuntime: that reaper
// SIGTERMs whatever the PID file names, and a duplicate agent (a doubled
// supervisor on an image without pkill, say) would otherwise kill the LIVE
// runtime of the agent that legitimately owns the port, every time it
// respawned — observed as "Run stops after ~2 seconds", with the crash
// reported as "exit code -1". Failing the bind first makes the duplicate exit
// harmlessly. Serving still starts only after the reaper has run, so a Start
// RPC can never have its fresh runtime mistaken for an orphan.
func (s *Server) Bind() error {
	if s.ln != nil {
		return nil
	}
	ln, err := net.Listen("tcp", s.cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("failed to start TCP listener (%s): %w", s.cfg.ListenAddr, err)
	}
	slog.Info("Server listening", "addr", ln.Addr().String())
	s.ln = ln
	return nil
}

// Start launches the server in background (non-blocking).
func (s *Server) Start() error {
	if s.ln == nil {
		if err := s.Bind(); err != nil {
			return err
		}
	}
	ln := s.ln
	s.ln = nil
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
		// Same Origin policy as the agent port (corsMiddleware): this listener
		// is the one operators expose most widely.
		Handler:     hmiOriginGuard(mux),
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

// corsMiddleware adds CORS headers required by browser-based clients
// (ConnectRPC's connect-web transport and the editor's direct fetches).
//
// SECURITY: the previous blanket "*" policy wrapped the whole mux — including
// the unauthenticated /deploy/* endpoints — so ANY web page could deploy and
// (via restart/AutoRun) execute an arbitrary binary as root from a drive-by
// request. Cross-origin browser traffic is therefore restricted to
// local/private origins (the editor runs on localhost or a LAN IP; see
// isAllowedCORSOrigin). Requests WITHOUT an Origin header (curl, the host
// agent's Go HTTP client, native SCADA clients) pass through unchanged —
// this is a browser-abuse defense, not general authentication.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			// Non-browser (or same-origin) request: no CORS involved.
			next.ServeHTTP(w, r)
			return
		}
		// The response varies by Origin regardless of allow/deny.
		w.Header().Add("Vary", "Origin")
		if !isAllowedCORSOrigin(origin) {
			// Reject on ALL methods, not just preflight: simple requests
			// (e.g. a cross-site POST to /deploy/runtime) reach the server
			// without a preflight, so denying only OPTIONS would still let
			// the side effect execute.
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		// Reflect the specific allowed origin instead of "*".
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers",
			"Content-Type, Connect-Protocol-Version, Connect-Timeout-Ms, "+
				"Grpc-Timeout, X-Grpc-Web, X-User-Agent")
		w.Header().Set("Access-Control-Expose-Headers",
			"Grpc-Status, Grpc-Message, Grpc-Status-Details-Bin")
		// Chrome 98+ Private Network Access: requests from http://localhost to a
		// private-range IP (192.168.x.x, 10.x.x.x, …) are blocked unless the
		// server echoes this header in the CORS preflight response. Only sent
		// for allowed (local/private) origins.
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// isAllowedCORSOrigin reports whether a browser Origin is local/private:
// localhost (any port), loopback (127.0.0.0/8, [::1]), RFC1918 / IPv6 ULA
// ranges, link-local addresses, and ".local" mDNS hostnames. Public-internet
// origins are rejected — a drive-by web page must not be able to reach the
// unauthenticated deploy surface.
func isAllowedCORSOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return false
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
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
	s.dropStaleLogicSlots()
	jsonOK(w, map[string]string{"status": "ok", "path": dest})
}

// dropStaleLogicSlots removes every logic_*.so and swap_result after a new
// runtime.bin lands.
//
// ⚠️ spawnRuntime decides "hot-swap loader-host vs plain binary" purely from
// the presence of a logic_<n>.so, so a plain Build & Send onto a device that
// once ran a hot-swap deploy started the NEW self-contained runtime.bin with a
// stale logic path as its argument (and polled for a cold-start result it
// would never write). The upload itself carries no marker, but cleaning here
// is unambiguous anyway: the ONLY flow that wants logic slots after a runtime
// upload — the host agent's hot-swap target deploy — always follows it with
// POST /deploy/logic?cold=1, which wipes every slot and installs logic_0.so
// itself. A loader-host that is still running keeps its unlinked module
// mapped, so removing the file does not disturb it.
func (s *Server) dropStaleLogicSlots() {
	deployLogicMu.Lock()
	defer deployLogicMu.Unlock()
	if err := hotswaplib.CleanupExcept(s.cfg.DeployDir, -1); err != nil {
		slog.Warn("failed to remove stale logic slots", "err", err)
	}
	_ = hotswaplib.ClearResultFile(filepath.Join(s.cfg.DeployDir, "swap_result"))
	s.pm.ForgetLogicGenerations()
}

func (s *Server) handleDeployVariableTable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST is supported", http.StatusMethodNotAllowed)
		return
	}
	dest := filepath.Join(s.cfg.DeployDir, "variable_table.json")
	// Validate the TEMP file before it replaces the deployed one: a rejected
	// table used to be renamed into place first, so the agent kept serving the
	// old table from memory while the file on disk — rehydrated at the next
	// agent start — was the broken one.
	var parsed *parsedVariableTable
	var parseErr error
	err := s.saveUploadChecked(r, dest, false, func(tmp string) error {
		data, rerr := os.ReadFile(tmp)
		if rerr != nil {
			return rerr
		}
		parsed, parseErr = s.ipc.ParseVariableTable(data)
		return parseErr
	})
	if err != nil {
		if parseErr != nil {
			slog.Error("rejected variable table", "err", parseErr)
			http.Error(w, "failed to parse table: "+parseErr.Error(), http.StatusUnprocessableEntity)
			return
		}
		slog.Error("failed to save variable_table.json", "err", err)
		http.Error(w, "failed to save file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	s.ipc.ApplyVariableTable(parsed)
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
	// Whatever force flags survived in /dev/shm were set against this same
	// table, so the first start after an agent restart must keep them.
	s.ipc.MarkTableStarted()
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
	return writeFileAtomic(s.runtimeConfigPath(), data, 0644)
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
	if r.Method != http.MethodPost {
		http.Error(w, "only POST is supported", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // config payload is tiny
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
// Side-effects:
//   - Restart=true                → stop (if running) + start with the deployed
//     binary (Build & Send's final step)
//   - AutoRun=true  + not running  → start runtime (when Restart not set)
//   - AutoRun=true  + running      → no-op (already serving; Restart restarts it)
//   - AutoRun=false               → cancel any pending auto-restart timer;
//     a currently running runtime is left alone (user manually stops if desired)
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
	if u.RingRAMPercent != nil {
		p := *u.RingRAMPercent
		if p < 0 {
			p = 0
		}
		if p > ringMaxRAMPercent {
			p = ringMaxRAMPercent
		}
		s.rtCfg.RingRAMPercent = p
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

	restartRequested := u.Restart != nil && *u.Restart

	// AutoRun toggle side-effects (skip if the request did not touch the field
	// — e.g. a stream-interval-only update from the API).
	if u.AutoRun != nil && !autoRun {
		// Toggle off: cancel any pending crash-restart. A currently running
		// runtime is intentionally left alone — user stops it manually.
		s.pm.CancelPendingRestart()
	}

	// Explicit restart (Build & Send's final step): swap the running runtime to
	// the freshly-deployed binary. pm.Start() stops the current process first
	// (and cancels any pending auto-restart), so this is a clean stop+start with
	// the NEW runtime.bin + variable_table (both already deployed by now).
	// Without this, overwriting runtime.bin on disk does NOT affect the
	// already-running process — the classic "I pushed but it still runs the old
	// code" trap, especially with AutoRun keeping a stale process alive.
	if restartRequested {
		slog.Info("Restart requested — (re)starting runtime with deployed binary")
		if _, err := s.StartRuntime(); err != nil {
			slog.Warn("Restart: start failed", "err", err)
		}
	} else if u.AutoRun != nil && autoRun {
		// AutoRun turned on WITHOUT an explicit restart: start only when idle
		// (don't disturb an already-running runtime).
		if _, running := s.pm.Status(); !running {
			slog.Info("AutoRun enabled — starting runtime")
			if _, err := s.StartRuntime(); err != nil {
				slog.Warn("AutoRun: start failed", "err", err)
			}
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
		"ring_ram_percent":   s.rtCfg.RingRAMPercent,
	}
}

// StartRuntime mirrors the ConnectRPC Start. Initial values AND the capture-ring
// segment are both established by pm's pre-start hook (see main.go) AFTER any
// previous process has stopped and BEFORE the new one spawns. Implements
// RuntimeController.
func (s *Server) StartRuntime() (int, error) {
	if err := s.pm.Start(); err != nil {
		return 0, err
	}
	pid, _ := s.pm.Status()
	return pid, nil
}

// SizeRingSegment (re)creates /dev/shm/<shm>_ring at the resolved size so the
// runtime ADOPTS it instead of falling back to its own 1 MiB default (the
// runtime only ftruncates when the segment is smaller than one record), and no
// env var has to survive a `sudo` reset.
//
// ⚠️ This MUST run from pm's pre-start hook, never from StartRuntime alone.
// StartRuntime is only one of FOUR ways a runtime is spawned — the ConnectRPC
// Start (service.go, i.e. the editor's Run button), AutoRun at agent startup
// (main.go) and the crash-restart watchdog (process.go) all call pm.Start()
// directly. Sizing here from StartRuntime left the editor's own Run button
// producing a 1 MiB ring: 0.43 s of slack at 100 kHz, which trips the
// decimation controller's grow-fast branch within half a second of the first
// client connecting and pins the stride in the thousands. /status happily
// reported the configured size the whole time, because it was computed and
// never applied. pm.preStartHook is the one choke point all four paths share.
//
// Best-effort: a failure must not block starting the runtime.
func (s *Server) SizeRingSegment() {
	bytes, _, _, _, _ := s.resolvedRingBytes()
	resize := func() error { return createRingSegment(s.cfg.ShmName, bytes) }
	if s.api != nil {
		// Through the shared consumer, never a bare ftruncate: it may have the
		// segment mapped, and a shrink under a live mapping is a SIGBUS.
		resize = func() error { return s.api.resizeRing(bytes) }
	}
	if err := resize(); err != nil {
		slog.Warn("Failed to pre-size capture ring; runtime will use its default",
			"err", err, "bytes", bytes)
		return
	}
	slog.Info("Capture ring sized", "bytes", bytes)
}

// resolvedRingBytes returns the byte size the capture ring gets from the
// deployed project's production rate, bounded by the RAM-% ceiling and live
// device memory. Also what /status reports — so the number on screen is the
// number actually applied at the next start.
func (s *Server) resolvedRingBytes() (bytes, memTotal, memAvail uint64, pct, produced float64) {
	s.rtMu.Lock()
	pct = s.rtCfg.RingRAMPercent
	s.rtMu.Unlock()
	if pct <= 0 {
		pct = ringDefaultPercent // report the EFFECTIVE percent (unset → 50%)
	}
	memTotal, memAvail = readMemInfo()
	produced = ringProducedBytesPerSec(s.ipc.RingConfig())
	bytes = ringBytesFor(pct, memAvail, produced)
	return bytes, memTotal, memAvail, pct, produced
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
	ringBytes, memTotal, memAvail, ringPct, ringProduced := s.resolvedRingBytes()
	resp := map[string]any{
		"running":             running,
		"pid":                 pid,
		"variable_count":      s.ipc.VariableCount(),
		"shm_name":            s.cfg.ShmName,
		"deploy_dir":          s.cfg.DeployDir,
		"auto_run":            autoRun,
		"stream_interval_ms":  uint32(GetAPIStreamInterval() / time.Millisecond),
		"hmi_port":            hmiPort,
		"mem_total_bytes":     memTotal,
		"mem_available_bytes": memAvail,
		"ring_ram_percent":    ringPct,
		"ring_bytes":          ringBytes,
		// Ring bytes/s the deployed project writes. Lets the editor show the
		// buffer's real stall tolerance (ring_bytes / this) instead of guessing
		// it from the variable list — a guess that ignored the record header and
		// came out 3x optimistic for a single 8-byte variable.
		"ring_produced_bytes_per_sec": ringProduced,
	}
	// Last swap/cold-start/crash outcome — the editor's existing 3s /status
	// poll is the only channel back from the field side for this (no
	// persistent SSE connection here), so surface it inline rather than
	// adding a new streaming mechanism.
	if ev := s.pm.LastEvent(); ev != nil {
		resp["last_runtime_event"] = ev
	}
	jsonOK(w, resp)
}

// saveUpload writes raw bytes from HTTP body to disk atomically.
func (s *Server) saveUpload(r *http.Request, dest string, executable bool) error {
	return s.saveUploadChecked(r, dest, executable, nil)
}

// saveUploadChecked is saveUpload with a validation step run on the complete
// temp file BEFORE the rename: if check fails the temp file is removed and the
// previously deployed file stays untouched.
func (s *Server) saveUploadChecked(r *http.Request, dest string, executable bool, check func(tmp string) error) error {
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
	if check != nil {
		if err := check(tmp); err != nil {
			os.Remove(tmp)
			return err
		}
	}
	if err := os.Rename(tmp, dest); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("atomic move failed: %w", err)
	}
	slog.Debug("File saved", "dest", dest, "bytes", written)
	return nil
}

// writeFileAtomic replaces path with data via temp file + fsync + rename, so a
// power cut mid-write (routine on a PLC) leaves either the old file or the new
// one — never a truncated config that silently resets AutoRun, or an HMI
// layout that drops every user. The temp file lives in the same directory so
// the rename stays on one filesystem.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	fail := func(err error) error {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Chmod(perm); err != nil {
		return fail(err)
	}
	if _, err := f.Write(data); err != nil {
		return fail(err)
	}
	if err := f.Sync(); err != nil {
		return fail(err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	// Best effort: persist the directory entry too.
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}

// streamVarMatcher builds the per-connection name filter for /stream/vars from
// the query string: `p` is a comma-separated list of key PREFIXES (a POU's keys
// all share `prog_<Name>_`, every global shares `prog__`) and `v` a list of
// explicit names. Both absent — an older editor, or a client that wants the lot
// — means no filter at all, so the endpoint stays backward compatible.
func streamVarMatcher(q url.Values) func(string) bool {
	split := func(raw string) []string {
		out := make([]string, 0, 8)
		for _, part := range strings.Split(raw, ",") {
			if part = strings.TrimSpace(part); part != "" {
				out = append(out, part)
			}
		}
		return out
	}
	prefixes := split(q.Get("p"))
	nameList := split(q.Get("v"))
	if len(prefixes) == 0 && len(nameList) == 0 {
		return nil
	}
	names := make(map[string]struct{}, len(nameList))
	for _, n := range nameList {
		names[n] = struct{}{}
	}
	return func(key string) bool {
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

// forcedStreamKey is the reserved /stream/vars key carrying the forced set:
// a JSON array of variable names (sorted), e.g. "__forced": ["prog__x"]. No
// variable can collide with it — every table name starts with "prog_".
const forcedStreamKey = "__forced"

// forcedResendEvery bounds how stale a client's forced set can be if it missed
// a change event (the key is otherwise sent only when the set changes).
const forcedResendEvery = 2 * time.Second

// forcedTracker decides when a stream carries the forced set: on the first
// event of a connection (so a fresh or reconnected client learns it), whenever
// it changes (an empty list included — that is how a client learns the last
// force was released) and at least every forcedResendEvery.
type forcedTracker struct {
	last     []string
	sent     bool
	lastSent time.Time
}

func (t *forcedTracker) next(cur []string, now time.Time) ([]string, bool) {
	if t.sent && slices.Equal(cur, t.last) && now.Sub(t.lastSent) < forcedResendEvery {
		return nil, false
	}
	if cur == nil {
		cur = []string{}
	}
	t.last, t.sent, t.lastSent = cur, true, now
	return cur, true
}

// handleSSEVars pushes variable values every streamInterval (50 ms) via
// Server-Sent Events. Used by Tauri/WebKit clients where fetch streaming is
// buffered end-to-end. Cadence is intentionally fixed — this is the editor
// stream, not the user-tunable /api/v1/stream. WHICH variables it carries is
// the client's call (see streamVarMatcher); with no filter it is all of them.
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

	match := streamVarMatcher(r.URL.Query())
	var ft forcedTracker
	slog.Info("SSE stream started", "remote", r.RemoteAddr, "filtered", match != nil)
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
			vars, err := s.ipc.ReadVariablesFiltered(match)
			if err != nil {
				continue
			}
			// The editor parses this with JSON.parse (doubles): a 64-bit
			// integer past 2^53 travels as a decimal string instead.
			for k, v := range vars {
				vars[k] = jsonSafe64(v)
			}
			// The forced set ignores the subscription on purpose: the
			// editor's force list must show EVERY forced variable, not
			// only the ones on screen.
			if forced, send := ft.next(s.ipc.ForcedVariables(false), time.Now()); send {
				vars[forcedStreamKey] = forced
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

// jsonOK marshals BEFORE writing anything, so an unencodable value becomes a
// 500 with a reason instead of a 200 with an empty body (the encoder used to
// fail after the status line was already committed, and a client could not
// tell "no variables" from "the response broke").
func jsonOK(w http.ResponseWriter, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		slog.Error("JSON response encoding failed", "err", err)
		jsonError(w, http.StatusInternalServerError, "response encoding failed: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(append(data, '\n'))
}
