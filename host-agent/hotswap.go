package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/krontek/hotswaplib"
)

// hotswap.go — live ("online change") PLC logic update for the local simulation.
//
// The transpiler's plc.c compiled with -DPLC_HOTSWAP is a loadable logic.so; a
// generic loader-host (hotswap_host.c, embedded below) owns PlcState + the
// /dev/shm mirror + the scan threads and dlopen's the logic. Updating the logic
// recompiles only logic_<n>.so, writes its path to <buildDir>/swap_request and
// sends SIGUSR1 — the host swaps it at a scan boundary with the state preserved
// (rolls back on a bad .so). The editor keeps reading live variables from the
// host-owned /dev/shm mirror by variables.json offset throughout.
//
// Generation numbers (logic_<n>.so) are NEVER trusted from an in-memory
// counter — they are always re-derived by scanning the build dir via
// hotswaplib.DiscoverGeneration/NextGeneration, which is what the field-path's
// sibling (server/hotswap.go) does too, so the two can never desync the way
// the old in-memory-counter scheme did. Cleanup of an old .so happens ONLY
// after the loader-host has CONFIRMED (via the swap_result file protocol,
// hotswaplib.PollSwapResult) that the new generation is actually running —
// never optimistically right after a compile.
//
//   POST /api/host/hotswap/build {header, source, variableTable, hal}
//        → writes plc.* + variables.json, compiles the host (once) + logic_0.so
//   POST /api/host/hotswap/run   {}                  → spawns the host, polls SHM
//   POST /api/host/hotswap/swap  {header, source}    → compiles logic_<n>.so, swaps live
//   POST /api/host/hotswap/stop  {}                  → stops the host + poller

//go:embed hotswaphost/host.c
var hotswapHostC string

const hotswapShmName = "/plc_runtime" // matches PLC_SHM_NAME in generated plc.c

// swapResultTimeout bounds how long we wait for the loader-host to report a
// swap/cold-start outcome before giving up and reporting "unknown" (never
// silently assuming success). Swaps are human/agent-paced, not a hot path —
// generous headroom over the sub-100ms cost typically observed.
const swapResultTimeout = 5 * time.Second

type ShmSpec struct {
	Key    string
	Offset uint64
	VType  string
}

// HotSwapState owns the running loader-host process + the SHM poller.
//
// swapMu is DELIBERATELY separate from mu: a swap attempt holds swapMu for
// its whole duration (compile + signal + poll-for-result, up to
// swapResultTimeout) so two concurrent swap requests can never interleave
// their swap_request writes — but Stop() only ever needs mu, briefly, so an
// operator's Stop is never blocked behind a hung swap poll.
type HotSwapState struct {
	mu     sync.Mutex
	swapMu sync.Mutex
	cmd    *exec.Cmd
	pid    int
	specs  []ShmSpec
	stopCh chan struct{}
}

func NewHotSwapState() *HotSwapState { return &HotSwapState{} }

func (h *HotSwapState) Stop() {
	h.mu.Lock()
	cmd, ch := h.cmd, h.stopCh
	h.cmd, h.pid, h.stopCh = nil, 0, nil
	h.mu.Unlock()
	if ch != nil {
		select {
		case <-ch:
		default:
			close(ch)
		}
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}
}

// buildShmSpecs derives the live-read plan from variables.json: every debug
// entry that owns a SHM slot (has an offset) maps its editor key → SHM offset
// + IEC type, which decodeValue understands.
func buildShmSpecs(variableTableJSON string) []ShmSpec {
	var vt map[string]interface{}
	if err := json.Unmarshal([]byte(variableTableJSON), &vt); err != nil {
		return nil
	}
	debug, _ := vt["debugDefaults"].(map[string]interface{})
	var specs []ShmSpec
	for key, e := range debug {
		em, _ := e.(map[string]interface{})
		off, ok := em["offset"].(float64)
		if !ok {
			continue
		}
		vType, _ := em["type"].(string)
		if vType == "" {
			vType = "BOOL"
		}
		specs = append(specs, ShmSpec{Key: key, Offset: uint64(off), VType: vType})
	}
	return specs
}

func swapResultPath(buildDir string) string { return filepath.Join(buildDir, "swap_result") }
func swapRequestPath(buildDir string) string { return filepath.Join(buildDir, "swap_request") }

// compileLogic builds logic_<ver>.so from the plc.c already in buildDir. The
// caller decides ver (via hotswaplib.NextGeneration) and is responsible for
// cleanup — this function only compiles, it never deletes anything.
func (s *Server) compileLogic(buildDir string, ver int) (string, string, error) {
	resInclude, err := s.paths.ResourceTargetIncludeDir("x86_64/linux")
	if err != nil {
		return "", "", err
	}
	libDir, err := s.paths.ResourceTargetLibDir("x86_64/linux")
	if err != nil {
		return "", "", err
	}
	compiler, baseArgs, err := s.bundledHostClangArgs()
	if err != nil {
		return "", "", err
	}
	simInc := filepath.Join(s.paths.LLVMSysroot("simulation_env"), "include")
	plcC := filepath.Join(buildDir, "plc.c")
	logicSO := hotswaplib.GenerationPath(buildDir, ver)

	args := append([]string{}, baseArgs...)
	args = append(args,
		"-shared", "-fPIC", "-DPLC_HOTSWAP", "-DKRON_EC_SIM",
		"-I", buildDir, "-I", resInclude,
		"-I", simInc, "-I", filepath.Join(resInclude, "soem/include"),
		"-fuse-ld=lld", "-O2", "-o", logicSO, plcC,
	)
	args = append(args, CollectStaticArchives(libDir)...)
	args = append(args, "-lm")
	if out, err := exec.Command(compiler, args...).CombinedOutput(); err != nil {
		return "", "", fmt.Errorf("logic.so build failed: %v\n%s", err, out)
	}
	return logicSO, "", nil
}

// compileHost builds the loader-host. If host_glue.c is present (HAL-using
// project), the HAL is compiled INTO the host (so its device fds survive a
// swap) and exported via -rdynamic; the host is then board-specific and is
// rebuilt whenever HAL/board/IO changes (a cold-restart case anyway).
func (s *Server) compileHost(buildDir string) (string, error) {
	hostBin := filepath.Join(buildDir, "plc_host")
	if _, err := os.Stat(hostBin); err == nil {
		return hostBin, nil
	}
	compiler, baseArgs, err := s.bundledHostClangArgs()
	if err != nil {
		return "", err
	}
	hostC := filepath.Join(buildDir, "hotswap_host.c")
	if err := os.WriteFile(hostC, []byte(hotswapHostC), 0o644); err != nil {
		return "", err
	}
	args := append([]string{}, baseArgs...)
	args = append(args, "-O2", "-rdynamic", hostC)

	// host_glue.c (HAL trampolines) needs the resource/sim includes + the libs.
	glueC := filepath.Join(buildDir, "host_glue.c")
	if _, err := os.Stat(glueC); err == nil {
		resInclude, e1 := s.paths.ResourceTargetIncludeDir("x86_64/linux")
		libDir, e2 := s.paths.ResourceTargetLibDir("x86_64/linux")
		if e1 != nil || e2 != nil {
			return "", fmt.Errorf("resource paths: %v %v", e1, e2)
		}
		simInc := filepath.Join(s.paths.LLVMSysroot("simulation_env"), "include")
		args = append(args, "-DKRON_EC_SIM",
			"-I", buildDir, "-I", resInclude, "-I", simInc, "-I", filepath.Join(resInclude, "soem/include"),
			glueC)
		args = append(args, CollectStaticArchives(libDir)...)
		args = append(args, "-lm")
	}
	args = append(args, "-lpthread", "-ldl", "-lrt", "-o", hostBin)
	if out, err := exec.Command(compiler, args...).CombinedOutput(); err != nil {
		return "", fmt.Errorf("host build failed: %v\n%s", err, out)
	}
	return hostBin, nil
}

// soemIncludeArgs returns the SOEM -I paths (kronethercatmaster.h pulls in
// soem/soem.h even for non-EC projects), mirroring compileForTarget.
func soemIncludeArgs(resInclude string) []string {
	var out []string
	base := filepath.Join(resInclude, "soem")
	for _, p := range []string{"include", "osal", "osal/linux", "oshw/linux"} {
		full := filepath.Join(base, p)
		if st, err := os.Stat(full); err == nil && st.IsDir() {
			out = append(out, "-I", full)
		}
	}
	return out
}

// targetTriples maps a board to (llvmTarget, resourceTarget), mirroring
// compileForTarget. Linux ARM targets only (hot-swap needs dlopen).
func targetTriples(boardID string) (string, string, error) {
	switch {
	case strings.HasPrefix(boardID, "rpi_pico"):
		return "", "", fmt.Errorf("Pico (Cortex-M) cannot hot-swap (no dlopen)")
	case strings.HasPrefix(boardID, "bb_") && !strings.HasPrefix(boardID, "bb_ai64"):
		return "arm-linux-gnueabihf", "arm/armv7", nil
	default:
		return "aarch64-linux-gnu", "arm/aarch64", nil
	}
}

// compileLogicForTarget cross-compiles logic_<ver>.so for the deployed target.
// Used for both the initial deploy (ver 0) and every online change. Caller
// decides ver and owns cleanup, same contract as compileLogic.
func (s *Server) compileLogicForTarget(buildDir, boardID string, ver int) (string, error) {
	llvmTarget, resourceTarget, err := targetTriples(boardID)
	if err != nil {
		return "", err
	}
	resInclude, err := s.paths.ResourceTargetIncludeDir(resourceTarget)
	if err != nil {
		return "", err
	}
	libDir, err := s.paths.ResourceTargetLibDir(resourceTarget)
	if err != nil {
		return "", err
	}
	compiler, baseArgs, sysIncs, err := s.llvmCompileBaseArgs(llvmTarget)
	if err != nil {
		return "", err
	}
	logicSO := hotswaplib.GenerationPath(buildDir, ver)
	args := append([]string{}, baseArgs...)
	args = append(args, "-shared", "-fPIC", "-DPLC_HOTSWAP", "-O2", "-ffunction-sections", "-fdata-sections", "-fuse-ld=lld")
	for _, inc := range sysIncs {
		args = append(args, "-isystem", inc)
	}
	args = append(args, "-I", buildDir, "-I", resInclude)
	args = append(args, soemIncludeArgs(resInclude)...)
	args = append(args, "-o", logicSO, filepath.Join(buildDir, "plc.c"))
	for _, l := range s.paths.LLVMTargetLibraryDirs(llvmTarget) {
		args = append(args, "-L", l)
	}
	args = append(args, CollectStaticArchives(libDir)...)
	args = append(args, "-lm")
	if out, err := exec.Command(compiler, args...).CombinedOutput(); err != nil {
		return "", fmt.Errorf("target logic.so build failed: %v\n%s", err, out)
	}
	return logicSO, nil
}

// compileHostForTarget cross-compiles the loader-host (host.c + host_glue.c) as
// runtime.bin for the target. DYNAMIC (-rdynamic, not -static) so it can dlopen
// logic.so and so logic.so resolves us_tick / HAL trampolines from it.
func (s *Server) compileHostForTarget(buildDir, boardID string) (string, error) {
	llvmTarget, resourceTarget, err := targetTriples(boardID)
	if err != nil {
		return "", err
	}
	resInclude, err := s.paths.ResourceTargetIncludeDir(resourceTarget)
	if err != nil {
		return "", err
	}
	libDir, err := s.paths.ResourceTargetLibDir(resourceTarget)
	if err != nil {
		return "", err
	}
	compiler, baseArgs, sysIncs, err := s.llvmCompileBaseArgs(llvmTarget)
	if err != nil {
		return "", err
	}
	hostC := filepath.Join(buildDir, "hotswap_host.c")
	if err := os.WriteFile(hostC, []byte(hotswapHostC), 0o644); err != nil {
		return "", err
	}
	outFile := filepath.Join(buildDir, "runtime.bin")
	args := append([]string{}, baseArgs...)
	args = append(args, "-O2", "-rdynamic", "-fuse-ld=lld")
	for _, inc := range sysIncs {
		args = append(args, "-isystem", inc)
	}
	args = append(args, "-I", buildDir, "-I", resInclude, hostC)
	args = append(args, soemIncludeArgs(resInclude)...)
	if _, e := os.Stat(filepath.Join(buildDir, "host_glue.c")); e == nil {
		args = append(args, filepath.Join(buildDir, "host_glue.c"))
		for _, l := range s.paths.LLVMTargetLibraryDirs(llvmTarget) {
			args = append(args, "-L", l)
		}
		args = append(args, CollectStaticArchives(libDir)...)
	}
	args = append(args, "-o", outFile, "-lm", "-lpthread", "-ldl", "-lrt")
	if out, err := exec.Command(compiler, args...).CombinedOutput(); err != nil {
		return "", fmt.Errorf("target host build failed: %v\n%s", err, out)
	}
	// Marker so handleHotSwapTargetDeploy can refuse to upload a build dir
	// whose runtime.bin is actually the PLAIN self-contained binary (Build &
	// Send's compileForTarget writes to this SAME path/filename) — the two
	// binary shapes must never be conflated, which is exactly how the
	// original field hot-swap regression happened.
	_ = os.WriteFile(filepath.Join(buildDir, "runtime.bin.kind"), []byte("hotswap-host\n"), 0o644)
	return outFile, nil
}

// handleHotSwapTargetBuild cross-compiles the hot-swap runtime for the deployed
// board: runtime.bin (loader-host) + logic_0.so. The editor then deploys both
// to KronServer via /api/host/hotswap/target-deploy. Subsequent online changes
// recompile only logic_<n>.so via /api/host/hotswap/target-logic.
func (s *Server) handleHotSwapTargetBuild(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req struct {
		writePLCFilesReq
		BoardID string `json:"boardId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	buildDir := s.paths.BuildDir()
	if err := os.MkdirAll(buildDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for name, content := range map[string]string{
		"plc.h": req.Header, "plc.c": req.Source,
		"variables.json": req.VariableTable, "kron_hal.h": req.HAL, "host_glue.c": req.HostGlue,
	} {
		if content == "" {
			continue
		}
		if err := os.WriteFile(filepath.Join(buildDir, name), []byte(content), 0o644); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	// Cold build = fresh process start downstream: reset to generation 0,
	// wiping any leftover logic_*.so from a previous session (decision: reset
	// on cold build, since there's no dlopen path-cache risk across a process
	// restart — only across dlclose+dlopen WITHIN one running process).
	_ = hotswaplib.CleanupExcept(buildDir, -1)
	_ = hotswaplib.ClearResultFile(swapResultPath(buildDir))
	hostBin, err := s.compileHostForTarget(buildDir, req.BoardID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	logicSO, err := s.compileLogicForTarget(buildDir, req.BoardID, 0)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "runtime": hostBin, "logic": logicSO})
}

// handleHotSwapTargetLogic recompiles only logic_<n>.so for the target (an
// online change). The editor uploads it to KronServer via
// /api/host/hotswap/deploy-swap, which polls for the remote swap's confirmed
// outcome.
func (s *Server) handleHotSwapTargetLogic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req struct {
		Header  string `json:"header"`
		Source  string `json:"source"`
		BoardID string `json:"boardId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	buildDir := s.paths.BuildDir()
	if req.Source != "" {
		_ = os.WriteFile(filepath.Join(buildDir, "plc.c"), []byte(req.Source), 0o644)
	}
	if req.Header != "" {
		_ = os.WriteFile(filepath.Join(buildDir, "plc.h"), []byte(req.Header), 0o644)
	}
	ver := hotswaplib.NextGeneration(buildDir)
	logicSO, err := s.compileLogicForTarget(buildDir, req.BoardID, ver)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": ver, "logic": logicSO})
}

// handleHotSwapDeploySwap pushes the latest logic_<n>.so to a deployed
// KronServer (/deploy/logic) and triggers a live swap (/hotswap/swap),
// surfacing the REMOTE server's confirmed outcome (it now polls its own
// swap_result before responding — see server/hotswap.go) rather than just
// "the HTTP call succeeded".
func (s *Server) handleHotSwapDeploySwap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req struct {
		ServerAddr string `json:"serverAddr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	buildDir := s.paths.BuildDir()
	_, logicPath, ok := hotswaplib.DiscoverGeneration(buildDir)
	if !ok {
		writeError(w, http.StatusBadRequest, "no logic.so built yet — call target-build/target-logic first")
		return
	}
	logicBytes, err := os.ReadFile(logicPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read logic.so: "+err.Error())
		return
	}
	client := &http.Client{Timeout: 60 * time.Second}
	// 1) upload → KronServer returns {"logic":"logic_<n>.so"}
	resp, err := client.Post("http://"+req.ServerAddr+"/deploy/logic", "application/octet-stream", bytes.NewReader(logicBytes))
	if err != nil {
		writeError(w, http.StatusBadGateway, "deploy/logic: "+err.Error())
		return
	}
	var up struct {
		Logic string `json:"logic"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&up)
	resp.Body.Close()
	// 2) swap — the server-side handler now blocks until it has polled its
	// own swap_result, so a non-2xx here (or an "ok":false body) means the
	// swap was actually attempted and REJECTED (e.g. a layout mismatch), not
	// merely that the HTTP request failed.
	body, _ := json.Marshal(map[string]string{"logic": up.Logic})
	resp2, err := client.Post("http://"+req.ServerAddr+"/hotswap/swap", "application/json", bytes.NewReader(body))
	if err != nil {
		writeError(w, http.StatusBadGateway, "hotswap/swap: "+err.Error())
		return
	}
	defer resp2.Body.Close()
	var swapResp map[string]any
	_ = json.NewDecoder(resp2.Body).Decode(&swapResp)
	if resp2.StatusCode >= 400 {
		reason, _ := swapResp["reason"].(string)
		writeError(w, http.StatusBadGateway, fmt.Sprintf("hotswap/swap rejected: HTTP %d %s", resp2.StatusCode, reason))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "logic": up.Logic, "remote": swapResp})
}

func (s *Server) handleHotSwapBuild(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req writePLCFilesReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	buildDir := s.paths.BuildDir()
	if err := os.MkdirAll(buildDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	files := map[string]string{
		"plc.h": req.Header, "plc.c": req.Source,
		"variables.json": req.VariableTable, "kron_hal.h": req.HAL,
		"host_glue.c": req.HostGlue, // HAL trampolines (empty if the project uses no HAL)
	}
	for name, content := range files {
		if content == "" {
			continue
		}
		if err := os.WriteFile(filepath.Join(buildDir, name), []byte(content), 0o644); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if _, err := s.compileHost(buildDir); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Cold build resets to generation 0 (see handleHotSwapTargetBuild comment
	// for the reasoning) — wipe any leftover logic_*.so and stale result file
	// from a previous session first.
	_ = hotswaplib.CleanupExcept(buildDir, -1)
	_ = hotswaplib.ClearResultFile(swapResultPath(buildDir))
	logicSO, _, err := s.compileLogic(buildDir, 0)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hotswap.mu.Lock()
	s.hotswap.specs = buildShmSpecs(req.VariableTable)
	s.hotswap.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "logic": logicSO})
}

func (s *Server) handleHotSwapRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	buildDir := s.paths.BuildDir()
	hostBin := filepath.Join(buildDir, "plc_host")
	logicSO := hotswaplib.GenerationPath(buildDir, 0)
	if _, err := os.Stat(hostBin); err != nil {
		writeError(w, http.StatusBadRequest, "not built — call hotswap/build first")
		return
	}
	// Fresh mirror each run.
	_ = os.Remove("/dev/shm" + hotswapShmName)

	s.hotswap.mu.Lock()
	if s.hotswap.cmd != nil {
		s.hotswap.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "alreadyRunning": true, "pid": s.hotswap.pid})
		return
	}
	// Clear any stale result from a previous run BEFORE spawning, so a
	// leftover file can never be misread as THIS run's cold-start outcome.
	_ = hotswaplib.ClearResultFile(swapResultPath(buildDir))
	cmd := exec.Command(hostBin, logicSO)
	cmd.Dir = buildDir // so the host reads ./swap_request (and writes ./swap_result) here
	if err := cmd.Start(); err != nil {
		s.hotswap.mu.Unlock()
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	stopCh := make(chan struct{})
	s.hotswap.cmd = cmd
	s.hotswap.pid = cmd.Process.Pid
	s.hotswap.stopCh = stopCh
	specs := s.hotswap.specs
	pid := s.hotswap.pid
	s.hotswap.mu.Unlock()

	go func() {
		_ = cmd.Wait()
		s.hotswap.mu.Lock()
		wasCurrent := s.hotswap.cmd == cmd
		if wasCurrent {
			s.hotswap.cmd, s.hotswap.pid = nil, 0
		}
		s.hotswap.mu.Unlock()
		if wasCurrent {
			s.events.Emit("simulation-output", map[string]any{"status": "crashed"})
		}
	}()

	// Confirm the loader-host actually bound its first logic module before
	// declaring "started" — a fresh run that can't even bind logic_0.so
	// (e.g. a stale/mismatched build) exits almost immediately; without this
	// poll that would look identical to a normal successful start.
	status, detail, perr := hotswaplib.PollSwapResult(swapResultPath(buildDir), 0, swapResultTimeout)
	if perr != nil {
		s.events.Emit("simulation-output", map[string]any{"status": "hotswap-unknown", "phase": "coldstart"})
		writeJSON(w, http.StatusGatewayTimeout, map[string]any{"ok": false, "error": "cold-start outcome unknown (timeout)", "pid": pid, "confirmed": false})
		return
	}
	if status != "OK" {
		s.events.Emit("simulation-output", map[string]any{"status": "hotswap-failed", "phase": "coldstart", "reason": detail})
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "cold-start failed: " + detail, "pid": pid, "confirmed": true, "reason": detail})
		return
	}
	s.events.Emit("simulation-output", map[string]any{"status": "started", "mode": "hotswap"})
	go s.hotswapPoller(specs, stopCh)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "pid": pid, "confirmed": true})
}

type hotSwapSwapReq struct {
	Header        string `json:"header"`
	Source        string `json:"source"`
	VariableTable string `json:"variableTable"`
}

func (s *Server) handleHotSwapSwap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req hotSwapSwapReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	buildDir := s.paths.BuildDir()
	s.hotswap.mu.Lock()
	pid := s.hotswap.pid
	s.hotswap.mu.Unlock()
	if pid == 0 {
		writeError(w, http.StatusBadRequest, "not running — call hotswap/run first")
		return
	}

	// Hold the swap-serialization lock for the ENTIRE operation (discover →
	// compile → write request → signal → poll for result) — this is what
	// fixes the documented race where two near-simultaneous swap calls could
	// overwrite each other's swap_request. A concurrent Stop() is unaffected
	// (it only ever needs the separate, short-held `mu`).
	s.hotswap.swapMu.Lock()
	defer s.hotswap.swapMu.Unlock()

	// New logic source overwrites plc.* (same layout assumed; a layout
	// change is caught by the editor's pre-flight check AND, unconditionally,
	// by the loader-host's plc_state_layout_hash comparison — see
	// CTranspilerService.js / hotswaphost/host.c).
	if req.Source != "" {
		if err := os.WriteFile(filepath.Join(buildDir, "plc.c"), []byte(req.Source), 0o644); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if req.Header != "" {
		_ = os.WriteFile(filepath.Join(buildDir, "plc.h"), []byte(req.Header), 0o644)
	}

	ver := hotswaplib.NextGeneration(buildDir)
	logicSO, _, err := s.compileLogic(buildDir, ver)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Clear any stale result BEFORE requesting this swap, so a leftover
	// outcome from a PREVIOUS attempt can never be misattributed to this one.
	resultPath := swapResultPath(buildDir)
	_ = hotswaplib.ClearResultFile(resultPath)
	if err := os.WriteFile(swapRequestPath(buildDir), []byte(logicSO+"\n"), 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := sendSwapSignal(pid); err != nil {
		writeError(w, http.StatusInternalServerError, "signal failed: "+err.Error())
		return
	}

	status, detail, perr := hotswaplib.PollSwapResult(resultPath, ver, swapResultTimeout)
	switch {
	case perr != nil:
		// Outcome unknown — never assume success, never delete anything. Non-2xx
		// so HostClient's _wrap throws instead of silently resolving "ok".
		s.events.Emit("simulation-output", map[string]any{"status": "hotswap-unknown", "version": ver})
		writeJSON(w, http.StatusGatewayTimeout, map[string]any{"ok": false, "error": "hot-swap outcome unknown (timeout)", "version": ver, "confirmed": false, "reason": "timeout"})
	case status == "OK":
		_ = hotswaplib.CleanupExcept(buildDir, ver)
		s.events.Emit("simulation-output", map[string]any{"status": "hotswapped", "version": ver})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": ver, "logic": logicSO})
	default: // FAIL — the PREVIOUS generation is still running (loader-host already rolled back itself).
		_ = os.Remove(logicSO) // only the rejected candidate; never touch the still-running old one
		s.events.Emit("simulation-output", map[string]any{"status": "hotswap-failed", "version": ver, "reason": detail})
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "hot-swap rejected: " + detail, "version": ver, "confirmed": true, "reason": detail})
	}
}

func (s *Server) handleHotSwapStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	s.hotswap.Stop()
	s.events.Emit("simulation-output", map[string]any{"status": "stopped"})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// hotswapPoller reads the host-owned /dev/shm mirror by offset and streams live
// variables, identical to the editor's existing simulation-output feed.
func (s *Server) hotswapPoller(specs []ShmSpec, stop <-chan struct{}) {
	shmPath := "/dev/shm" + hotswapShmName
	time.Sleep(150 * time.Millisecond)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
		f, err := os.Open(shmPath)
		if err != nil {
			continue // mirror not up yet
		}
		vars := make(map[string]interface{})
		anyOK := false
		for _, sp := range specs {
			size := typeSize(sp.VType)
			if size == 0 {
				continue
			}
			buf := make([]byte, size)
			if _, err := f.ReadAt(buf, int64(sp.Offset)); err == nil {
				vars[sp.Key] = decodeValue(buf, sp.VType)
				anyOK = true
			}
		}
		f.Close()
		if anyOK {
			s.events.Emit("simulation-output", map[string]any{"vars": vars})
			broadcastPlcVars(vars)
		}
	}
}
