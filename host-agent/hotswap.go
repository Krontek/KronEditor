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
//   POST /api/host/hotswap/build {header, source, variableTable, hal}
//        → writes plc.* + variables.json, compiles the host (once) + logic_0.so
//   POST /api/host/hotswap/run   {}                  → spawns the host, polls SHM
//   POST /api/host/hotswap/swap  {header, source}    → compiles logic_<n>.so, swaps live
//   POST /api/host/hotswap/stop  {}                  → stops the host + poller

//go:embed hotswaphost/host.c
var hotswapHostC string

const hotswapShmName = "/plc_runtime" // matches PLC_SHM_NAME in generated plc.c

type ShmSpec struct {
	Key    string
	Offset uint64
	VType  string
}

// HotSwapState owns the running loader-host process + the SHM poller.
type HotSwapState struct {
	mu       sync.Mutex
	cmd      *exec.Cmd
	pid      int
	logicVer int
	specs    []ShmSpec
	stopCh   chan struct{}
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

// compileLogic builds logic_<ver>.so from the plc.c already in buildDir.
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
	logicSO := filepath.Join(buildDir, fmt.Sprintf("logic_%d.so", ver))

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
// Used for both the initial deploy (ver 0) and every online change.
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
	logicSO := filepath.Join(buildDir, fmt.Sprintf("logic_%d.so", ver))
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
	return outFile, nil
}

// handleHotSwapTargetBuild cross-compiles the hot-swap runtime for the deployed
// board: runtime.bin (loader-host) + logic_0.so. The editor then deploys both
// to KronServer (/deploy/runtime + /deploy/logic). Subsequent online changes
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
	s.hotswap.mu.Lock()
	s.hotswap.logicVer = 0
	s.hotswap.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "runtime": hostBin, "logic": logicSO})
}

// handleHotSwapTargetLogic recompiles only logic_<n>.so for the target (an
// online change). The editor uploads it to KronServer /deploy/logic and calls
// /hotswap/swap.
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
	s.hotswap.mu.Lock()
	s.hotswap.logicVer++
	ver := s.hotswap.logicVer
	s.hotswap.mu.Unlock()
	logicSO, err := s.compileLogicForTarget(buildDir, req.BoardID, ver)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": ver, "logic": logicSO})
}

// handleHotSwapDeploySwap pushes the latest logic_<n>.so to a deployed
// KronServer (/deploy/logic) and triggers a live swap (/hotswap/swap). Used by
// the editor/agent to apply an online change to the field.
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
	s.hotswap.mu.Lock()
	ver := s.hotswap.logicVer
	s.hotswap.mu.Unlock()
	logicPath := filepath.Join(s.paths.BuildDir(), fmt.Sprintf("logic_%d.so", ver))
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
	// 2) swap
	body, _ := json.Marshal(map[string]string{"logic": up.Logic})
	resp2, err := client.Post("http://"+req.ServerAddr+"/hotswap/swap", "application/json", bytes.NewReader(body))
	if err != nil {
		writeError(w, http.StatusBadGateway, "hotswap/swap: "+err.Error())
		return
	}
	defer resp2.Body.Close()
	if resp2.StatusCode >= 400 {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("hotswap/swap HTTP %d", resp2.StatusCode))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "logic": up.Logic})
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
	logicSO, _, err := s.compileLogic(buildDir, 0)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hotswap.mu.Lock()
	s.hotswap.logicVer = 0
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
	logicSO := filepath.Join(buildDir, "logic_0.so")
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
	cmd := exec.Command(hostBin, logicSO)
	cmd.Dir = buildDir // so the host reads ./swap_request here
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

	s.events.Emit("simulation-output", map[string]any{"status": "started", "mode": "hotswap"})
	go s.hotswapPoller(specs, stopCh)
	go func() {
		_ = cmd.Wait()
		s.hotswap.mu.Lock()
		if s.hotswap.cmd == cmd {
			s.hotswap.cmd, s.hotswap.pid = nil, 0
		}
		s.hotswap.mu.Unlock()
	}()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "pid": pid})
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
	// New logic source overwrites plc.* (same layout assumed; a layout change is
	// the editor's responsibility to detect → cold restart, not a swap).
	if req.Source != "" {
		if err := os.WriteFile(filepath.Join(buildDir, "plc.c"), []byte(req.Source), 0o644); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if req.Header != "" {
		_ = os.WriteFile(filepath.Join(buildDir, "plc.h"), []byte(req.Header), 0o644)
	}
	s.hotswap.mu.Lock()
	s.hotswap.logicVer++
	ver := s.hotswap.logicVer
	s.hotswap.mu.Unlock()

	logicSO, _, err := s.compileLogic(buildDir, ver)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Signal the running host: write the new .so path, then SIGUSR1.
	if err := os.WriteFile(filepath.Join(buildDir, "swap_request"), []byte(logicSO+"\n"), 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := syscall.Kill(pid, syscall.SIGUSR1); err != nil {
		writeError(w, http.StatusInternalServerError, "signal failed: "+err.Error())
		return
	}
	s.events.Emit("simulation-output", map[string]any{"status": "hotswapped", "version": ver})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": ver, "logic": logicSO})
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
