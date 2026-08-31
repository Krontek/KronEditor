// main.go - PLC Deployment & Debug Agent
// Bridge service for industrial automation systems.
// Static build: CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o plc-agent .

package main

import (
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

// Config carries all service parameters.
// Values are read from CLI flags or environment variables.
type Config struct {
	ListenAddr string // WebSocket/HTTP listen address (e.g. ":7070")
	DeployDir  string // Directory for binary and JSON files (e.g. /opt/plc)
	ShmName    string // Shared memory file name under /dev/shm
	ShmSize    int    // Shared memory size (bytes)
	LogLevel   string // debug | info | warn | error
}

func main() {
	cfg := parseConfig()
	logger := buildLogger(cfg.LogLevel)

	slog.SetDefault(logger)
	slog.Info("Starting PLC Agent",
		"addr", cfg.ListenAddr,
		"deploy_dir", cfg.DeployDir,
		"shm_name", cfg.ShmName,
		"shm_size_bytes", cfg.ShmSize,
	)

	// Initialize shared memory manager.
	ipc, err := NewIPCManager(cfg.ShmName, cfg.ShmSize)
	if err != nil {
		slog.Error("Failed to open shared memory", "err", err)
		os.Exit(1)
	}
	defer func() {
		if cerr := ipc.Close(); cerr != nil {
			slog.Warn("Failed to close shared memory", "err", cerr)
		}
	}()

	// Initialize process manager.
	pm := NewProcessManager(cfg.DeployDir)

	// Initialize HMI manager (authentication + page serving).
	sessions := NewSessionStore()
	users := NewUserStore()
	hmi := NewHMIManager(logger, users, sessions, ipc, cfg.DeployDir)

	// Start HTTP + WebSocket server.
	srv := NewServer(cfg, ipc, pm, hmi)
	// Wire the crash-restart watchdog so it knows when AutoRun is on.
	pm.SetAutoRunGetter(srv.AutoRunEnabled)
	// Everything that must be established between "old runtime stopped" and
	// "new runtime spawned" hangs off this ONE hook, because it is the only
	// point all four start paths share (StartRuntime, the ConnectRPC Start, the
	// AutoRun start below, and the crash-restart watchdog):
	//   • initial values — written here and not earlier, where the dying
	//     runtime's final shm sync would overwrite them;
	//   • the capture-ring segment — sized here and not in StartRuntime, which
	//     three of the four paths bypass (see Server.SizeRingSegment).
	pm.SetPreStartHook(func() {
		ipc.WriteInitialValues()
		srv.SizeRingSegment()
	})

	// Reap any runtime left behind by a previous agent crash. Must run
	// BEFORE the HTTP server starts accepting: a Start RPC arriving in the
	// window between listen and cleanup would get its fresh runtime killed
	// as an "orphan". Also must precede the AutoRun Start() below so two
	// runtimes never contend for the same /dev/shm/plc_runtime mapping.
	pm.CleanupOrphanRuntime()

	if err := srv.Start(); err != nil {
		slog.Error("Failed to start server", "err", err)
		os.Exit(1)
	}

	// AutoRun: if configured, start the PLC runtime automatically
	// (initial values are written by the pre-start hook inside Start).
	if srv.AutoRunEnabled() {
		slog.Info("AutoRun is enabled — starting PLC runtime automatically")
		if err := pm.Start(); err != nil {
			slog.Warn("AutoRun: failed to start PLC runtime", "err", err)
		} else {
			pid, _ := pm.Status()
			slog.Info("AutoRun: PLC runtime started", "pid", pid)
		}
	}

	// Graceful shutdown: wait for SIGTERM or SIGINT.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	sig := <-quit
	slog.Info("Shutdown signal received", "signal", sig)

	// Stop running PLC process safely.
	if stopErr := pm.Stop(); stopErr != nil {
		slog.Warn("Error while stopping PLC process", "err", stopErr)
	}

	slog.Info("PLC Agent stopped")
}

func parseConfig() Config {
	cfg := Config{}
	flag.StringVar(&cfg.ListenAddr, "addr", ":7070", "Listen address (host:port)")
	flag.StringVar(&cfg.DeployDir, "deploy-dir", "/opt/plc", "Directory where binaries are stored")
	flag.StringVar(&cfg.ShmName, "shm-name", "plc_runtime", "Shared memory name under /dev/shm")
	flag.IntVar(&cfg.ShmSize, "shm-size", 65536, "Shared memory size in bytes (default 64 KB)")
	flag.StringVar(&cfg.LogLevel, "log-level", "info", "Log level: debug|info|warn|error")
	flag.Parse()
	return cfg
}

func buildLogger(level string) *slog.Logger {
	var lvl slog.Level
	switch level {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level:     lvl,
		AddSource: true, // File:line details are critical in industrial logs
	}))
}
