package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// appVersion is the single-sourced app version. Real builds inject it from
// package.json via -ldflags "-X main.appVersion=$npm_package_version" (see the
// build:host-agent npm script and packaging/*.sh); "dev" is the `go run .`
// fallback.
var appVersion = "dev"

var (
	flagAddr           = flag.String("addr", ":7171", "Listen address")
	flagResourcesRoot  = flag.String("resources-root", "", "Resources root (defaults to ./src-tauri/resources or ./resources)")
	flagToolchainsRoot = flag.String("toolchains-root", "", "LLVM toolchains root (defaults to ./src-tauri/toolchains or ./toolchains)")
	flagAppDataDir     = flag.String("app-data-dir", "", "App data dir for build output (default: ~/.local/share/com.plceditor.app)")
)

type Server struct {
	paths   *Paths
	events  *Events
	sim     *SimState
	hmi     *HmiState
	ollama  *OllamaState
	hotswap *HotSwapState
}

func main() {
	flag.Parse()

	paths, err := NewPaths(*flagResourcesRoot, *flagToolchainsRoot, *flagAppDataDir)
	if err != nil {
		log.Fatalf("paths: %v", err)
	}

	srvState := &Server{
		paths:   paths,
		events:  NewEvents(),
		sim:     NewSimState(),
		hmi:     NewHmiState(),
		ollama:  NewOllamaState(),
		hotswap: NewHotSwapState(),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/host/health", srvState.handleHealth)
	mux.HandleFunc("/api/host/build", handleBuild) // generic compile (PoC, kept)

	// File I/O
	mux.HandleFunc("/api/host/write-plc-files", srvState.handleWritePLCFiles)
	mux.HandleFunc("/api/host/standard-headers", srvState.handleGetStandardHeaders)
	mux.HandleFunc("/api/host/build-dir", srvState.handleGetBuildDir)
	mux.HandleFunc("/api/host/read-file", srvState.handleReadFile)
	mux.HandleFunc("/api/host/write-file", srvState.handleWriteFile)
	mux.HandleFunc("/api/host/list-dir", srvState.handleListDir)

	// Compile
	mux.HandleFunc("/api/host/compile-simulation", srvState.handleCompileSimulation)
	mux.HandleFunc("/api/host/compile-for-target", srvState.handleCompileForTarget)

	// Runtime (simulation)
	mux.HandleFunc("/api/host/run-simulation", srvState.handleRunSimulation)
	mux.HandleFunc("/api/host/stop-simulation", srvState.handleStopSimulation)
	mux.HandleFunc("/api/host/write-variable", srvState.handleWriteVariable)
	mux.HandleFunc("/api/host/plc-variables", srvState.handlePlcVariables) // SSE

	// Deploy
	mux.HandleFunc("/api/host/check-server-status", srvState.handleCheckServerStatus)
	mux.HandleFunc("/api/host/deploy-to-server", srvState.handleDeployToServer)
	mux.HandleFunc("/api/host/deploy-server-to-target", srvState.handleDeployServerToTarget)

	// Library / server updates
	mux.HandleFunc("/api/host/update-libraries", srvState.handleUpdateLibraries)
	mux.HandleFunc("/api/host/update-server", srvState.handleUpdateServer)

	// AI Agent — local model download & setup (Ollama)
	mux.HandleFunc("/api/host/ollama-status", srvState.handleOllamaStatus)
	mux.HandleFunc("/api/host/ollama-setup", srvState.handleOllamaSetup)
	mux.HandleFunc("/api/host/ollama-pull", srvState.handleOllamaPull)
	mux.HandleFunc("/api/host/ollama-runtime", srvState.handleOllamaRuntime)
	mux.HandleFunc("/api/host/ollama-unload", srvState.handleOllamaUnload)

	// AI Agent — provider-agnostic chat proxy with tool-calling
	mux.HandleFunc("/api/host/ai/chat", srvState.handleAIChat)
	mux.HandleFunc("/api/host/ai/log-clear", srvState.handleAILogClear)
	mux.HandleFunc("/api/host/ai/log-save", srvState.handleAILogSave)

	// Hot-swap (online change) — local simulation
	mux.HandleFunc("/api/host/hotswap/build", srvState.handleHotSwapBuild)
	mux.HandleFunc("/api/host/hotswap/run", srvState.handleHotSwapRun)
	mux.HandleFunc("/api/host/hotswap/swap", srvState.handleHotSwapSwap)
	mux.HandleFunc("/api/host/hotswap/stop", srvState.handleHotSwapStop)
	mux.HandleFunc("/api/host/hotswap/target-build", srvState.handleHotSwapTargetBuild)   // cross-compile host+logic.so for the field
	mux.HandleFunc("/api/host/hotswap/target-logic", srvState.handleHotSwapTargetLogic)   // recompile logic.so for an online change
	mux.HandleFunc("/api/host/hotswap/deploy-swap", srvState.handleHotSwapDeploySwap)     // push logic.so to KronServer + swap

	// HMI
	mux.HandleFunc("/api/host/start-hmi-server", srvState.handleStartHmiServer)
	mux.HandleFunc("/api/host/stop-hmi-server", srvState.handleStopHmiServer)
	mux.HandleFunc("/api/host/push-hmi-variables", srvState.handlePushHmiVariables)
	mux.HandleFunc("/api/host/poll-hmi-writes", srvState.handlePollHmiWrites)

	// EtherCAT
	mux.HandleFunc("/api/host/build-soem", srvState.handleBuildSoem)
	mux.HandleFunc("/api/host/build-canopen", srvState.handleBuildCanopen)
	mux.HandleFunc("/api/host/ec-request-state", srvState.handleEcRequestState)
	mux.HandleFunc("/api/host/list-network-interfaces", srvState.handleListNetworkInterfaces)

	// Generic event stream (build progress, library updates, ethercat state)
	mux.HandleFunc("/api/host/events", srvState.events.handleSSE)

	// Serve the embedded Vite build for any non-API path. Vite dev server
	// owns this route in dev mode (port 1420 with proxy to :7171); in
	// production the host-agent is the single origin for both UI and API.
	mux.Handle("/", frontendHandler())

	srv := &http.Server{
		Addr:    *flagAddr,
		Handler: withCORS(mux),
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Printf("kron-host-agent listening on %s", *flagAddr)
		log.Printf("  resources:  %s", paths.ResourcesRoot)
		log.Printf("  toolchains: %s", paths.ToolchainsRoot)
		log.Printf("  app-data:   %s", paths.AppDataDir)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-stop
	log.Println("shutting down...")
	srvState.sim.Stop()
	srvState.hmi.Stop()
	srvState.ollama.Stop()
	srvState.hotswap.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"name":           "kron-host-agent",
		"version":        appVersion,
		"resourcesRoot":  s.paths.ResourcesRoot,
		"toolchainsRoot": s.paths.ToolchainsRoot,
		"appDataDir":     s.paths.AppDataDir,
		"buildDir":       s.paths.BuildDir(),
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": msg})
}

func withCORS(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}
