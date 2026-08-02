package main

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
// Naming uses the bounded 2-slot ping-pong (logic_0.so <-> logic_1.so): each
// swap targets the slot that is NOT the one we are CERTAIN is running (curGen,
// advanced only on a confirmed OK — never inferred from a directory listing),
// so the generation number never grows. Cleanup of the old slot happens ONLY
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

// hotswapShmName must match PLC_SHM_NAME in the generated plc.c. The two
// platforms name the object differently: POSIX shm names start with "/", while
// a Win32 section lives in the object namespace ("Local\\..." = per session).
var hotswapShmName = func() string {
	if runtime.GOOS == "windows" {
		return `Local\plc_runtime`
	}
	return "/plc_runtime"
}()

// hotswapShmSize must match PLC_SHM_SIZE in the generated plc.c. Only needed on
// Windows (a named section has no size to stat), but kept platform-neutral so
// the two mirror implementations share one signature.
const hotswapShmSize = 65536

// swapResultTimeout bounds how long we wait for the loader-host to report a
// swap/cold-start outcome before giving up and reporting "unknown" (never
// silently assuming success). Swaps are human/agent-paced, not a hot path —
// generous headroom over the sub-100ms cost typically observed.
const swapResultTimeout = 5 * time.Second

type ShmSpec struct {
	Key      string
	Offset   uint64
	VType    string
	ForceOff uint64 // force-flag byte offset (0 = none; real flags live at >= 32768)
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
	done   chan struct{} // closed by the reaper goroutine (the ONLY cmd.Wait caller)

	// curGen is the generation we are CERTAIN the loader-host is running: the
	// gen launched at cold start (always 0) and advanced ONLY when a swap is
	// CONFIRMED "OK". It is never inferred from a directory listing (ambiguous
	// while two ping-pong slots briefly coexist), so we always know exactly
	// which slot is running and which slot the next swap targets
	// (PingPongGeneration(curGen)). Guarded by swapMu (the whole swap holds it)
	// and set under mu at run.
	curGen int
}

func NewHotSwapState() *HotSwapState { return &HotSwapState{} }

// Stop kills the loader-host and waits for its reaper to confirm the process
// is gone. exec.Cmd.Wait must only ever be called once, so Stop never calls
// Wait itself — the reaper spawned in handleHotSwapRun owns Wait and closes
// `done`.
func (h *HotSwapState) Stop() {
	h.mu.Lock()
	cmd, ch, done := h.cmd, h.stopCh, h.done
	h.cmd, h.pid, h.stopCh, h.done = nil, 0, nil, nil
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
		if done != nil {
			select {
			case <-done:
			case <-time.After(5 * time.Second):
			}
		}
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
		forceOff, _ := em["force_flag_offset"].(float64)
		specs = append(specs, ShmSpec{Key: key, Offset: uint64(off), VType: vType, ForceOff: uint64(forceOff)})
	}
	return specs
}

// writeHotSwapVariable writes a variable into the hot-swap loader-host's
// /dev/shm mirror (the DEFAULT sim runtime). The generated plc_shm_pull only
// copies a slot into PlcState when its force flag is set (and plc_shm_sync
// skips forced slots), so a bare value write would be a no-op — value + flag
// together are exactly what KronServer's WriteVar does on the target.
//
// req.Mode picks the flag value: "force" (default) writes flag 1 so the value
// is re-injected every scan (held constant); "pulse" writes flag 2 so the value
// is applied for a SINGLE scan — plc_shm_pull auto-clears a pulse flag right
// after applying it, so the logic resumes from the injected value (e.g. a
// counter seeded to 0 counts up again next scan).
func (s *Server) writeHotSwapVariable(w http.ResponseWriter, req writeVariableReq) {
	s.hotswap.mu.Lock()
	running := s.hotswap.cmd != nil
	var spec ShmSpec
	found := false
	for _, sp := range s.hotswap.specs {
		if sp.Key == req.Name {
			spec, found = sp, true
			break
		}
	}
	s.hotswap.mu.Unlock()
	if !running {
		writeError(w, http.StatusBadRequest, "No simulation running")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "Variable not found: "+req.Name)
		return
	}
	data, ok := encodeValue(spec.VType, req.Value)
	if !ok {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Cannot encode %q as %s", req.Value, spec.VType))
		return
	}
	m, err := openShmMirror(hotswapShmName, hotswapShmSize, true)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "open shm mirror: "+err.Error())
		return
	}
	defer m.Close()
	if err := m.WriteAt(data, int64(spec.Offset)); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("shm write at 0x%x: %v", spec.Offset, err))
		return
	}
	if spec.ForceOff > 0 {
		flag := byte(1) // FORCE — held every scan
		if req.Mode == "pulse" {
			flag = 2 // PULSE — applied once, then plc_shm_pull auto-clears it
		}
		if err := m.WriteAt([]byte{flag}, int64(spec.ForceOff)); err != nil {
			writeError(w, http.StatusInternalServerError, fmt.Sprintf("shm force flag at 0x%x: %v", spec.ForceOff, err))
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func swapResultPath(buildDir string) string { return filepath.Join(buildDir, "swap_result") }
func swapRequestPath(buildDir string) string { return filepath.Join(buildDir, "swap_request") }

// compileLogic builds logic_<ver>.so from the plc.c already in buildDir. The
// caller decides ver (the ping-pong slot, via hotswaplib.PingPongGeneration off
// the confirmed-running generation) and is responsible for cleanup — this
// function only compiles (atomically: temp file then rename), never deletes.
// ⚠️ resInclude/HAL is a SEPARATE -I: kronhal.h lives only under
// krontek-include/HAL/, and both the generated kron_hal.h and host_glue.c
// include it by bare name. Without this, any project that touches the HAL
// failed to build with "kronhal.h file not found" — on Linux too.
func (s *Server) compileLogic(buildDir string, ver int) (string, string, error) {
	resInclude, err := s.paths.ResourceTargetIncludeDir(hostResourceTarget())
	if err != nil {
		return "", "", err
	}
	libDir, err := s.paths.ResourceTargetLibDir(hostResourceTarget())
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

	// Compile to a temp path then atomically rename onto the real slot: ping-pong
	// REUSES slot names, so writing logic_<ver>.so in place could truncate a .so
	// the running loader-host still has mmap'd. rename swaps the dir entry to a
	// fresh inode while the old inode stays mapped.
	tmpSO := hotswaplib.TempGenerationPath(buildDir, ver)
	args := append([]string{}, baseArgs...)
	args = append(args,
		"-shared", "-fPIC", "-DPLC_HOTSWAP", "-DKRON_EC_SIM",
		"-I", buildDir, "-I", resInclude, "-I", filepath.Join(resInclude, "HAL"),
		"-I", simInc, "-I", filepath.Join(resInclude, "soem/include"),
		"-fuse-ld=lld", "-O2", "-o", tmpSO, plcC,
	)
	args = append(args, CollectStaticArchives(libDir)...)
	args = append(args, "-lm")
	if runtime.GOOS == "windows" {
		// ⚠️ The Windows equivalent of the host's -rdynamic. A PE DLL cannot
		// resolve a symbol from the EXE that loads it the way a .so resolves
		// against a -rdynamic host: every import must be bound at LINK time
		// through an import library. compileHost therefore emits plc_host.lib
		// and the logic DLL links against it — that is what keeps the HAL
		// trampolines (__hs_*) and the host-owned us_tick / plc_stop /
		// __plc_shm in the host, so they survive a swap.
		implib := filepath.Join(buildDir, hostImportLibName)
		if _, e := os.Stat(implib); e != nil {
			return "", "", fmt.Errorf("loader-host import library missing (%s) — build the loader-host first", implib)
		}
		args = append(args, implib, "-lwinpthread")
	}
	if out, err := exec.Command(compiler, args...).CombinedOutput(); err != nil {
		_ = os.Remove(tmpSO)
		return "", "", fmt.Errorf("logic module build failed: %v\n%s", err, out)
	}
	if err := os.Rename(tmpSO, logicSO); err != nil {
		_ = os.Remove(tmpSO)
		return "", "", fmt.Errorf("logic.so install failed: %w", err)
	}
	return logicSO, "", nil
}

// compileHost builds the loader-host. If host_glue.c is present (HAL-using
// project), the HAL is compiled INTO the host (so its device fds survive a
// swap) and exported via -rdynamic; the host is then board-specific and is
// rebuilt whenever HAL/board/IO changes (a cold-restart case anyway).
// hostInputsHash captures everything that determines the local loader-host
// binary: the embedded loader source (changes when the host-agent is upgraded)
// and host_glue.c (changes with the project's HAL usage). It is the cache key
// for plc_host so a stale binary from an earlier build/version is never reused
// (an old loader that doesn't write the cold-start swap_result would otherwise
// make every sim start time out with "cold-start outcome unknown").
// hostBinName is the loader-host executable name. Windows will not execute a
// file without a .exe extension, so it differs by platform.
func hostBinName() string {
	if runtime.GOOS == "windows" {
		return "plc_host.exe"
	}
	return "plc_host"
}

// hostImportLibName is the import library the Windows loader-host emits so the
// logic DLL can bind to its symbols at link time (Windows only).
const hostImportLibName = "plc_host.lib"

func hostInputsHash(buildDir string) string {
	h := sha256.New()
	h.Write([]byte(hotswapHostC))
	if b, err := os.ReadFile(filepath.Join(buildDir, "host_glue.c")); err == nil {
		h.Write([]byte("glue"))
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (s *Server) compileHost(buildDir string) (string, error) {
	hostBin := filepath.Join(buildDir, hostBinName())
	// Cache on the CONTENT of the loader inputs, not mere existence — otherwise a
	// plc_host built by an older host-agent (before the cold-start-result ABI, or
	// with different HAL trampolines) is reused forever.
	curHash := hostInputsHash(buildDir)
	hashFile := hostBin + ".hash"
	if curHash != "" {
		if prev, e := os.ReadFile(hashFile); e == nil && string(prev) == curHash {
			if _, e := os.Stat(hostBin); e == nil {
				return hostBin, nil
			}
		}
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
	args = append(args, "-O2", hostC)
	if runtime.GOOS == "windows" {
		// --export-all-symbols + --out-implib is mingw's stand-in for -rdynamic:
		// it makes the host's symbols linkable from the logic DLL.
		args = append(args,
			"-Wl,--export-all-symbols",
			"-Wl,--out-implib,"+filepath.Join(buildDir, hostImportLibName))
	} else {
		args = append(args, "-rdynamic")
	}

	// host_glue.c (HAL trampolines) needs the resource/sim includes + the libs.
	glueC := filepath.Join(buildDir, "host_glue.c")
	if _, err := os.Stat(glueC); err == nil {
		resInclude, e1 := s.paths.ResourceTargetIncludeDir(hostResourceTarget())
		libDir, e2 := s.paths.ResourceTargetLibDir(hostResourceTarget())
		if e1 != nil || e2 != nil {
			return "", fmt.Errorf("resource paths: %v %v", e1, e2)
		}
		simInc := filepath.Join(s.paths.LLVMSysroot("simulation_env"), "include")
		args = append(args, "-DKRON_EC_SIM",
			"-I", buildDir, "-I", resInclude, "-I", filepath.Join(resInclude, "HAL"),
			"-I", simInc, "-I", filepath.Join(resInclude, "soem/include"),
			glueC)
		args = append(args, CollectStaticArchives(libDir)...)
		args = append(args, "-lm")
	}
	if runtime.GOOS == "windows" {
		args = append(args, hostSimLinkArgs()...) // -lwinpthread; LoadLibrary lives in kernel32
	} else {
		args = append(args, "-lpthread", "-ldl", "-lrt")
	}
	args = append(args, "-o", hostBin)
	if out, err := exec.Command(compiler, args...).CombinedOutput(); err != nil {
		return "", fmt.Errorf("host build failed: %v\n%s", err, out)
	}
	if curHash != "" {
		_ = os.WriteFile(hashFile, []byte(curHash), 0o644)
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
	// Legacy-project guard — rpi_pico boards were removed from the board list.
	case strings.HasPrefix(boardID, "rpi_pico"):
		return "", "", fmt.Errorf("Pico boards are no longer supported — reselect a Linux board in Board Config")
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
	tmpSO := hotswaplib.TempGenerationPath(buildDir, ver) // atomic install — see compileLogic
	args := append([]string{}, baseArgs...)
	args = append(args, "-shared", "-fPIC", "-DPLC_HOTSWAP", "-O2", "-ffunction-sections", "-fdata-sections", "-fuse-ld=lld")
	for _, inc := range sysIncs {
		args = append(args, "-isystem", inc)
	}
	args = append(args, "-I", buildDir, "-I", resInclude, "-I", filepath.Join(resInclude, "HAL"))
	args = append(args, soemIncludeArgs(resInclude)...)
	args = append(args, "-o", tmpSO, filepath.Join(buildDir, "plc.c"))
	for _, l := range s.paths.LLVMTargetLibraryDirs(llvmTarget) {
		args = append(args, "-L", l)
	}
	args = append(args, CollectStaticArchives(libDir)...)
	args = append(args, "-lm")
	if out, err := exec.Command(compiler, args...).CombinedOutput(); err != nil {
		_ = os.Remove(tmpSO)
		return "", fmt.Errorf("target logic.so build failed: %v\n%s", err, out)
	}
	if err := os.Rename(tmpSO, logicSO); err != nil {
		_ = os.Remove(tmpSO)
		return "", fmt.Errorf("target logic.so install failed: %w", err)
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
	args = append(args, "-I", buildDir, "-I", resInclude, "-I", filepath.Join(resInclude, "HAL"), hostC)
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
	// This only STAGES the .so for upload; the target device runs its own
	// ping-pong when it receives it (server handleDeployLogic decides the real
	// slot off ITS confirmed-running generation). So here we just keep the local
	// build dir bounded to a single fresh staging file that deploy-swap's
	// DiscoverGeneration will pick up. Ping-pong off whatever is currently
	// staged so we never grow the number locally either.
	stagedCur, _, ok := hotswaplib.DiscoverGeneration(buildDir)
	if !ok {
		stagedCur = 0
	}
	ver := hotswaplib.PingPongGeneration(stagedCur)
	logicSO, err := s.compileLogicForTarget(buildDir, req.BoardID, ver)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = hotswaplib.CleanupExcept(buildDir, ver) // keep only the freshly staged .so
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
	if resp.StatusCode >= 400 {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("deploy/logic rejected: HTTP %d", resp.StatusCode))
		return
	}
	if up.Logic == "" {
		writeError(w, http.StatusBadGateway, "deploy/logic returned no logic name — aborting swap")
		return
	}
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
	hostBin := filepath.Join(buildDir, hostBinName())
	logicSO := hotswaplib.GenerationPath(buildDir, 0)
	if _, err := os.Stat(hostBin); err != nil {
		writeError(w, http.StatusBadRequest, "not built — call hotswap/build first")
		return
	}

	s.hotswap.mu.Lock()
	if s.hotswap.cmd != nil {
		s.hotswap.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "alreadyRunning": true, "pid": s.hotswap.pid})
		return
	}
	// Fresh mirror each run. This MUST happen after the already-running
	// early-return above: the poller opens the mirror by path each tick, so
	// removing it while a host is live would silently kill the live stream.
	removeShmMirror(hotswapShmName)
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
	done := make(chan struct{})
	s.hotswap.cmd = cmd
	s.hotswap.pid = cmd.Process.Pid
	s.hotswap.stopCh = stopCh
	s.hotswap.done = done
	s.hotswap.curGen = 0 // cold start always launches logic_0.so (see logicSO above)
	specs := s.hotswap.specs
	pid := s.hotswap.pid
	s.hotswap.mu.Unlock()

	// Reaper: the ONLY cmd.Wait caller for this process (Stop() waits on
	// `done`). On an unexpected crash it also closes stopCh so the SHM poller
	// stops instead of streaming frozen values forever (and a later run
	// starting a SECOND poller).
	go func() {
		_ = cmd.Wait()
		close(done)
		s.hotswap.mu.Lock()
		wasCurrent := s.hotswap.cmd == cmd
		var ch chan struct{}
		if wasCurrent {
			s.hotswap.cmd, s.hotswap.pid, s.hotswap.done = nil, 0, nil
			ch = s.hotswap.stopCh
			s.hotswap.stopCh = nil
		}
		s.hotswap.mu.Unlock()
		if ch != nil {
			select {
			case <-ch:
			default:
				close(ch)
			}
		}
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
		// Outcome unknown: don't leave a half-tracked host running with no
		// poller — kill it and clean up so the failure is deterministic.
		s.hotswap.Stop()
		s.events.Emit("simulation-output", map[string]any{"status": "hotswap-unknown", "phase": "coldstart"})
		writeJSON(w, http.StatusGatewayTimeout, map[string]any{"ok": false, "error": "cold-start outcome unknown (timeout) — host killed", "pid": pid, "confirmed": false})
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

	// Ping-pong: target the slot that is NOT the one we are CERTAIN is running
	// (curGen), so the generation number never grows and we always know exactly
	// which slot is live and which we are about to send. curGen is read under mu
	// but only mutated here under swapMu (held for the whole swap), so no other
	// swap can move it mid-operation.
	s.hotswap.mu.Lock()
	cur := s.hotswap.curGen
	s.hotswap.mu.Unlock()
	ver := hotswaplib.PingPongGeneration(cur)
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
		// Outcome unknown — never assume success, never delete anything, and
		// leave curGen unchanged (we stay CERTAIN only of the last confirmed
		// generation). Non-2xx so HostClient's _wrap throws instead of silently
		// resolving "ok".
		s.events.Emit("simulation-output", map[string]any{"status": "hotswap-unknown", "version": ver})
		writeJSON(w, http.StatusGatewayTimeout, map[string]any{"ok": false, "error": "hot-swap outcome unknown (timeout)", "version": ver, "confirmed": false, "reason": "timeout"})
	case status == "OK":
		// CONFIRMED running ver now — advance curGen and delete the OTHER slot.
		s.hotswap.mu.Lock()
		s.hotswap.curGen = ver
		s.hotswap.mu.Unlock()
		_ = hotswaplib.CleanupExcept(buildDir, ver)
		s.events.Emit("simulation-output", map[string]any{"status": "hotswapped", "version": ver})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": ver, "logic": logicSO})
	default: // FAIL — the PREVIOUS generation (curGen) is still running (loader-host already rolled back itself).
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
	time.Sleep(150 * time.Millisecond)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
		mirror, err := openShmMirror(hotswapShmName, hotswapShmSize, false)
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
			if err := mirror.ReadAt(buf, int64(sp.Offset)); err == nil {
				vars[sp.Key] = decodeValue(buf, sp.VType)
				anyOK = true
			}
		}
		mirror.Close()
		if anyOK {
			s.events.Emit("simulation-output", map[string]any{"vars": vars})
			broadcastPlcVars(vars)
		}
	}
}
