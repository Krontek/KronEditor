package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Local-simulation binary. DISTINCT from the target/deploy "runtime.bin": the
// sim is a host-arch (x86_64) build with -O0 -g, while compileForTarget /
// hotswap cross-compile "runtime.bin" for the ARM board with -O3 (no -g). They
// MUST NOT share a filename — a Build & Send would clobber the sim binary with a
// wrong-arch, no-DWARF one, breaking local live-variable read (e.g. FB objects
// like blink.Q never resolve). simBin is used only by compileSimulation +
// handleRunSimulation; targets/deploy/hotswap keep the literal "runtime.bin".
const simBin = "sim_runtime.bin"

// ── compile_simulation ───────────────────────────────────────────────────────

func (s *Server) handleCompileSimulation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	outPath, log, err := s.compileSimulation()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error(), "log": log})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "binaryPath": outPath, "log": log})
}

func (s *Server) compileSimulation() (string, string, error) {
	buildDir := s.paths.BuildDir()
	plcC := filepath.Join(buildDir, "plc.c")
	outFile := filepath.Join(buildDir, simBin)

	// Build cache: the bundled clang is ~242 MB, so its cold load (first compile,
	// or after the page cache is evicted) dominates the perceived "compiling…"
	// time — the actual codegen is ~60 ms. When the transpiled inputs (plc.c +
	// plc.h, which fully determine the binary) are byte-identical to the last
	// successful build AND the binary still exists, skip clang entirely. This
	// makes a re-toggle of Simulation (off→on without code changes) near-instant.
	curHash := simInputsHash(buildDir)
	hashFile := outFile + ".hash"
	if curHash != "" {
		if prev, e := os.ReadFile(hashFile); e == nil && string(prev) == curHash {
			if _, e := os.Stat(outFile); e == nil {
				return outFile, "(cached — inputs unchanged, skipped clang)", nil
			}
		}
	}

	resourceTarget := "x86_64/linux"
	if runtime.GOOS == "darwin" {
		resourceTarget = "x86_64/macos"
	}
	resInclude, err := s.paths.ResourceTargetIncludeDir(resourceTarget)
	if err != nil {
		return "", "", err
	}
	hostLibDir, err := s.paths.ResourceTargetLibDir(resourceTarget)
	if err != nil {
		return "", "", err
	}

	compiler, baseArgs, err := s.bundledHostClangArgs()
	if err != nil {
		return "", "", err
	}

	args := append([]string{}, baseArgs...)
	args = append(args,
		"-DKRON_EC_SIM",
		"-I", buildDir,
		"-I", resInclude,
		"-I", filepath.Join(s.paths.LLVMSysroot("simulation_env"), "include"),
		"-I", filepath.Join(resInclude, "soem/include"),
		"-fuse-ld=lld",
		"-ffunction-sections",
		"-fdata-sections",
		// -O0 for the SIMULATION build: it is a correctness/logic test, not a
		// perf target, and -O3 is the dominant compile-time cost on large
		// projects (motion/EtherCAT pull kron_nc.c etc. in as inline headers, and
		// optimizing all of that per sim-start is slow). -O0 compiles much faster
		// and keeps real-time scan timing (driven by us_tick, not CPU speed).
		// (The cross-compiled TARGET/deploy build below stays -O3.)
		"-O0",
		// -g emits DWARF so the agent can resolve PlcState member offsets: all
		// PLC variables are now fields of `PlcState __plc_state` (hot-swap
		// refactor), not standalone globals, so /proc/mem live-read needs the
		// struct layout.
		"-g",
		"-o", outFile,
		plcC,
	)
	if runtime.GOOS != "darwin" {
		args = append(args, "-static")
	}

	archives := CollectStaticArchives(hostLibDir)
	args = append(args, archives...)
	args = append(args, "-lm", "-lpthread")
	if runtime.GOOS != "darwin" {
		args = append(args, "-lrt")
	} else {
		args = append(args, "-framework", "CoreFoundation", "-framework", "IOKit")
	}

	cmd := exec.Command(compiler, args...)
	cmdStr := fmt.Sprintf("%s %s", compiler, strings.Join(args, " "))
	s.events.Emit("build-command", cmdStr)

	out, runErr := cmd.CombinedOutput()
	if runErr != nil {
		return "", string(out), fmt.Errorf("clang simulation build failed: %v", runErr)
	}
	if curHash != "" {
		_ = os.WriteFile(hashFile, []byte(curHash), 0o644) // record for the next build-cache check
	}
	return outFile, string(out), nil
}

// simInputsHash returns a SHA-256 over the transpiled inputs (plc.c + plc.h)
// that fully determine the simulation binary. Empty string on any read error
// (caller then just rebuilds — never a false cache hit).
func simInputsHash(buildDir string) string {
	h := sha256.New()
	for _, name := range []string{"plc.c", "plc.h"} {
		b, err := os.ReadFile(filepath.Join(buildDir, name))
		if err != nil {
			return ""
		}
		h.Write([]byte(name))
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// ── compile_for_target ───────────────────────────────────────────────────────

type compileForTargetReq struct {
	Header        string `json:"header"`
	Source        string `json:"source"`
	VariableTable string `json:"variableTable"`
	HAL           string `json:"hal"`
	BoardID       string `json:"boardId"`
	OutputName    string `json:"outputName"`
}

func (s *Server) handleCompileForTarget(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req compileForTargetReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	outPath, log, err := s.compileForTarget(&req)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error(), "log": log})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "binaryPath": outPath, "log": log})
}

func (s *Server) compileForTarget(req *compileForTargetReq) (string, string, error) {
	buildDir := s.paths.BuildDir()

	if err := os.WriteFile(filepath.Join(buildDir, "plc.h"), []byte(req.Header), 0o644); err != nil {
		return "", "", err
	}
	if err := os.WriteFile(filepath.Join(buildDir, "plc.c"), []byte(req.Source), 0o644); err != nil {
		return "", "", err
	}
	if req.HAL != "" {
		if err := os.WriteFile(filepath.Join(buildDir, "kron_hal.h"), []byte(req.HAL), 0o644); err != nil {
			return "", "", err
		}
	}
	if err := os.WriteFile(filepath.Join(buildDir, "variables.json"), []byte(req.VariableTable), 0o644); err != nil {
		return "", "", err
	}

	plcC := filepath.Join(buildDir, "plc.c")
	binName := req.OutputName
	if binName == "" {
		binName = "runtime.bin"
	}
	outFile := filepath.Join(buildDir, binName)

	var llvmTarget, resourceTarget string
	switch {
	// Legacy-project guard: rpi_pico boards were removed (no Linux userspace).
	// Without this a stale saved project would fall through to the aarch64
	// default and silently build a wrong-arch binary.
	case strings.HasPrefix(req.BoardID, "rpi_pico"):
		return "", "", fmt.Errorf("Pico (Cortex-M) boards are no longer supported — reselect a Linux board in Board Config")
	case strings.HasPrefix(req.BoardID, "bb_") && !strings.HasPrefix(req.BoardID, "bb_ai64"):
		llvmTarget, resourceTarget = "arm-linux-gnueabihf", "arm/armv7"
	default:
		llvmTarget, resourceTarget = "aarch64-linux-gnu", "arm/aarch64"
	}

	resInclude, err := s.paths.ResourceTargetIncludeDir(resourceTarget)
	if err != nil {
		return "", "", err
	}
	libDir, err := s.paths.ResourceTargetLibDir(resourceTarget)
	if err != nil {
		return "", "", err
	}

	compiler, baseArgs, sysIncs, err := s.llvmCompileBaseArgs(llvmTarget)
	if err != nil {
		return "", "", err
	}

	args := append([]string{}, baseArgs...)
	args = append(args, "-O3", "-ffunction-sections", "-fdata-sections", "-fuse-ld=lld", "-static", "-Wl,--gc-sections")
	if strings.HasPrefix(req.BoardID, "bb_") && !strings.HasPrefix(req.BoardID, "bb_ai64") {
		args = append(args, "-march=armv7-a")
	}
	if req.BoardID == "rpi_5" {
		args = append(args, `-DKRON_GPIO_CHIP="/dev/gpiochip4"`)
	}
	if strings.HasPrefix(req.BoardID, "jetson_orin") || strings.HasPrefix(req.BoardID, "jetson_agx_orin") {
		args = append(args, "-DKRON_JETSON_ORIN=1")
	}

	needsEC := strings.Contains(req.Source, "kron_ec_init(") ||
		strings.Contains(req.Source, "kron_ec_pdo_read(") ||
		strings.Contains(req.Source, "kron_ec_pdo_write(") ||
		strings.Contains(req.Source, "kron_ec_check_state(") ||
		strings.Contains(req.Source, "kron_ec_process_sdo(")

	hasECLib := false
	hasFullSOEM := false
	if entries, err := os.ReadDir(libDir); err == nil {
		for _, e := range entries {
			n := strings.ToLower(e.Name())
			if strings.Contains(n, "ethercatmaster") || strings.Contains(n, "kronec") {
				hasECLib = true
			}
			if strings.Contains(n, "soem") && strings.HasSuffix(n, ".a") {
				out, err := exec.Command("nm", filepath.Join(libDir, e.Name())).CombinedOutput()
				if err == nil && strings.Contains(string(out), "ecx_init") {
					hasFullSOEM = true
				}
			}
		}
	}
	if needsEC && (!hasECLib || !hasFullSOEM) {
		return "", "", fmt.Errorf("Target build requires real EtherCAT runtime, but SOEM is missing/incomplete. Run Build Libraries and ensure libsoem.a exports ecx_init.")
	}

	for _, inc := range sysIncs {
		args = append(args, "-isystem", inc)
	}
	args = append(args, "-I", buildDir, "-I", resInclude)

	soemBase := filepath.Join(resInclude, "soem")
	soemPaths := []string{
		filepath.Join(soemBase, "include"),
		filepath.Join(soemBase, "osal"),
		filepath.Join(soemBase, "osal/linux"),
		filepath.Join(soemBase, "oshw/linux"),
	}
	for _, p := range soemPaths {
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			args = append(args, "-I", p)
		}
	}

	args = append(args, "-o", outFile, plcC)
	for _, l := range s.paths.LLVMTargetLibraryDirs(llvmTarget) {
		args = append(args, "-L", l)
	}
	args = append(args, CollectStaticArchives(libDir)...)
	args = append(args, "-lm", "-lpthread", "-lrt")

	cmdStr := fmt.Sprintf("%s %s", compiler, strings.Join(args, " "))
	s.events.Emit("build-command", cmdStr)

	out, runErr := exec.Command(compiler, args...).CombinedOutput()
	if runErr != nil {
		return "", string(out), fmt.Errorf("clang cross-compilation failed: %v", runErr)
	}
	return outFile, string(out), nil
}

// ── shared LLVM arg builders ────────────────────────────────────────────────

func (s *Server) bundledHostClangArgs() (string, []string, error) {
	clang := s.paths.LLVMBin("clang")
	if _, err := os.Stat(clang); err != nil {
		return "", nil, fmt.Errorf("bundled clang not found: %s", clang)
	}
	clangRes, err := s.paths.LLVMClangResourceDir()
	if err != nil {
		return "", nil, err
	}
	var triple string
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "windows/amd64":
		triple = "x86_64-w64-windows-gnu"
	case "darwin/arm64":
		triple = "aarch64-apple-darwin"
	case "darwin/amd64":
		triple = "x86_64-apple-darwin"
	case "linux/arm64":
		triple = "aarch64-linux-gnu"
	default:
		triple = "x86_64-linux-gnu"
	}
	args := []string{
		"--target=" + triple,
		"-resource-dir", clangRes,
	}
	return clang, args, nil
}

func (s *Server) llvmCompileBaseArgs(target string) (string, []string, []string, error) {
	clang := s.paths.LLVMBin("clang")
	if _, err := os.Stat(clang); err != nil {
		return "", nil, nil, fmt.Errorf("bundled clang not found: %s", clang)
	}
	llvmAr := s.paths.LLVMBin("llvm-ar")
	if _, err := os.Stat(llvmAr); err != nil {
		return "", nil, nil, fmt.Errorf("bundled llvm-ar not found: %s", llvmAr)
	}
	clangRes, err := s.paths.LLVMClangResourceDir()
	if err != nil {
		return "", nil, nil, err
	}
	sysroot := s.paths.LLVMSysroot(target)
	if _, err := os.Stat(sysroot); err != nil {
		return "", nil, nil, fmt.Errorf("bundled sysroot not found: %s", sysroot)
	}

	var triple string
	var archFlags []string
	switch target {
	case "x86_64-linux-gnu":
		triple = "x86_64-linux-gnu"
	case "x86_64-w64-mingw32":
		triple = "x86_64-w64-mingw32"
	case "aarch64-linux-gnu":
		triple = "aarch64-linux-gnu"
		archFlags = []string{"-mcpu=cortex-a72"}
	case "arm-linux-gnueabihf":
		triple = "arm-linux-gnueabihf"
		archFlags = []string{"-mcpu=cortex-a8", "-mfloat-abi=hard", "-mfpu=neon-vfpv4"}
	default:
		return "", nil, nil, fmt.Errorf("unsupported LLVM compile target: %s", target)
	}

	args := []string{
		"--target=" + triple,
		"--sysroot=" + sysroot,
		"-resource-dir", clangRes,
	}
	if target != "x86_64-w64-mingw32" {
		args = append(args, "-nostdinc")
	}
	if target == "aarch64-linux-gnu" || target == "arm-linux-gnueabihf" {
		args = append(args, "--gcc-toolchain="+sysroot)
		// ⚠️ --gcc-toolchain alone is not enough: the sysroots name their GCC
		// dir with a "none" vendor (arm-none-linux-gnueabihf) that clang's
		// candidate list does not match for arm, so -static could not find
		// crtbeginT.o/crtend.o. -B points the driver straight at it.
		if gcc := s.paths.LLVMGCCInstallDir(target); gcc != "" {
			args = append(args, "-B", gcc)
		}
	}
	args = append(args, archFlags...)

	includes, err := s.paths.LLVMTargetIncludeDirs(target)
	if err != nil {
		return "", nil, nil, err
	}
	return clang, args, includes, nil
}
