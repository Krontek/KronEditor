package main

// Library builder — the backend for Settings → Libraries ("Build Libraries",
// "Build SOEM", "Build CANopen", "Build Server").
//
// It clones the Krontek library repos plus the third-party dependencies and
// compiles each into the per-target static archives under
// resources/<triple>/lib/, using the SAME bundled clang the editor compiles
// projects with. This is a DEVELOPER workflow: it needs `git` and network
// access, and it rewrites files that are committed to the repo.
//
// Ported from the pre-host-agent Tauri backend (src-tauri/src/main.rs
// do_update_libraries / do_build_soem / do_build_canopen / do_update_server).
// Three things deliberately DIVERGE from that original — see the ⚠️ notes on
// libraryTargets, stageIncludeDir and the header handling in runUpdateLibraries.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// SSE topics. ⚠️ These strings are the contract with SettingsPage.jsx
// (subscribeProgress) — the library builds share one pair and the server build
// has its own, exactly as the Tauri version emitted them. Renaming either side
// silently leaves the UI spinning forever with an empty log.
const (
	topicLibProgress    = "library-update-progress"
	topicLibDone        = "library-update-done"
	topicServerProgress = "server-update-progress"
	topicServerDone     = "server-update-done"
)

// libBuildMu serialises every build in this file. They all clone into the same
// temp roots and write the same resources/ tree, so two concurrent runs would
// interleave their output and race on the staging swap. The UI disables its
// buttons while one runs, but that is per-browser-tab and cannot be relied on.
var libBuildMu sync.Mutex

// libTarget is one output slot of the build matrix.
type libTarget struct {
	Tag         string // UI-facing tag, e.g. "x86_64/linux" — appears in the log
	ResourceKey string // key for paths.targetResourceKey → resources/<triple>/
	LLVMTarget  string // triple for llvmCompileBaseArgs; "" ⇒ compile for the HOST
	Platform    string // "linux" | "win32" | "macos" — selects OS-conditional flags
}

// libraryTargets returns the build matrix.
//
// ⚠️ TWO deliberate differences from the Tauri original:
//
//  1. The three arm/CortexM/M{0,4,7} bare-metal targets are GONE. Cortex-M
//     boards were removed from the product (CLAUDE.md §9: the whole runtime
//     assumes a Linux userspace, so such a board could only ever simulate),
//     and neither targetResourceKey nor llvmCompileBaseArgs knows arm-none-eabi
//     any more. The stale resources/arm-none-eabi-m*/ trees are left untouched.
//
//  2. macOS is HOST-ONLY. Every other target cross-compiles from anywhere
//     because its sysroot is bundled; Apple's SDK cannot be redistributed, so
//     darwin archives can only be produced ON a Mac (paths.MacOSSDKPath resolves
//     the SDK at run time). This makes the matrix host-dependent for the first
//     time — hence the explicit log line in runUpdateLibraries, so a Linux run
//     does not look like it silently covered macOS too.
func libraryTargets() []libTarget {
	targets := []libTarget{
		{Tag: "x86_64/linux", ResourceKey: "x86_64/linux", LLVMTarget: "x86_64-linux-gnu", Platform: "linux"},
		{Tag: "x86_64/win32", ResourceKey: "x86_64/win32", LLVMTarget: "x86_64-w64-mingw32", Platform: "win32"},
		{Tag: "arm/aarch64", ResourceKey: "arm/aarch64", LLVMTarget: "aarch64-linux-gnu", Platform: "linux"},
		{Tag: "arm/armv7", ResourceKey: "arm/armv7", LLVMTarget: "arm-linux-gnueabihf", Platform: "linux"},
	}
	if runtime.GOOS == "darwin" {
		key := "x86_64/macos"
		if runtime.GOARCH == "arm64" {
			key = "arm64/macos"
		}
		targets = append(targets, libTarget{
			Tag: key, ResourceKey: key, LLVMTarget: "", Platform: "macos",
		})
	}
	return targets
}

// libToolchain is a resolved compiler + archiver for one target.
type libToolchain struct {
	Clang    string
	Ar       string
	BaseArgs []string
	SysIncs  []string // passed as -isystem
}

// resolveToolchain picks the right argument builder for a target. Cross targets
// use the bundled sysroots; the macOS host target has none and must go through
// bundledHostClangArgs, which supplies -isysroot from xcrun.
func (s *Server) resolveToolchain(t libTarget) (*libToolchain, error) {
	ar := s.paths.LLVMBin("llvm-ar")
	if _, err := os.Stat(ar); err != nil {
		return nil, fmt.Errorf("bundled llvm-ar not found: %s", ar)
	}
	if t.LLVMTarget == "" {
		clang, args, err := s.bundledHostClangArgs()
		if err != nil {
			return nil, err
		}
		return &libToolchain{Clang: clang, Ar: ar, BaseArgs: args}, nil
	}
	clang, args, sysIncs, err := s.llvmCompileBaseArgs(t.LLVMTarget)
	if err != nil {
		return nil, err
	}
	return &libToolchain{Clang: clang, Ar: ar, BaseArgs: args, SysIncs: sysIncs}, nil
}

// optFlags are the optimisation/section flags every archive is built with,
// matching what the Tauri builder used (and what compileForTarget expects when
// it later links these archives with --gc-sections).
var optFlags = []string{"-O3", "-ffunction-sections", "-fdata-sections"}

// ── shared helpers ──────────────────────────────────────────────────────────

func (s *Server) libLog(format string, a ...any) {
	s.events.Emit(topicLibProgress, fmt.Sprintf(format, a...))
}

func (s *Server) libDone(success bool, message string) {
	s.events.Emit(topicLibDone, map[string]any{"success": success, "message": message})
}

// gitClone shallow-clones a repo. branch may be empty for the default branch.
//
// ⚠️ Kept as a `git` subprocess rather than an HTTP tarball fetch: the original
// behaved this way, and it keeps private repos / SSH keys / credential helpers
// working. The cost is that `git` must be on PATH — reported here with a clear
// message rather than as a bare exec error.
func gitClone(url, branch, dir string, timeout time.Duration) error {
	args := []string{"clone", "--depth=1", "--quiet"}
	if branch != "" {
		args = append(args, "--branch", branch)
	}
	args = append(args, url, dir)

	cmd := exec.Command("git", args...)
	out, err := runWithTimeout(cmd, timeout)
	if err != nil {
		if _, lookErr := exec.LookPath("git"); lookErr != nil {
			return fmt.Errorf("git not found on PATH — install git to build libraries")
		}
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(out))
	}
	return nil
}

// runWithTimeout runs a command and returns its combined output, killing it if
// it outruns the timeout. A hung clone or a compiler waiting on a credential
// prompt would otherwise pin libBuildMu forever and make every later build
// look dead.
func runWithTimeout(cmd *exec.Cmd, timeout time.Duration) (string, error) {
	// Never let a subprocess ask the user anything: there is no terminal
	// attached, so a prompt is an indefinite hang, not a question.
	//
	// ⚠️ APPEND to whatever the caller already set — do NOT reset to
	// os.Environ(). runUpdateServer builds its environment (GOOS, GOARCH,
	// GOARM, CGO_ENABLED=0) before calling in, and clobbering it here made all
	// three "cross-compiled" server binaries come out as identical dynamically
	// linked host-arch executables — which would then have been deployed to
	// every ARM board.
	base := cmd.Env
	if base == nil {
		base = os.Environ()
	}
	cmd.Env = append(base, "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=echo")
	done := make(chan struct{})
	var out []byte
	var err error
	go func() {
		out, err = cmd.CombinedOutput()
		close(done)
	}()
	select {
	case <-done:
		return string(out), err
	case <-time.After(timeout):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		<-done
		return string(out), fmt.Errorf("timed out after %s", timeout)
	}
}

// findFilesWithExt walks dir and returns every file with the given extension
// (no leading dot). Mirrors the Tauri helper of the same name.
func findFilesWithExt(dir, ext string) []string {
	var out []string
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable subtree — skip, don't abort the whole scan
		}
		if !d.IsDir() && strings.TrimPrefix(filepath.Ext(path), ".") == ext {
			out = append(out, path)
		}
		return nil
	})
	return out
}

// isSkippableSource reports whether a C file is a test/example/debug helper
// rather than library code. Same filter the Tauri builder used.
func isSkippableSource(path string) bool {
	n := strings.ToLower(filepath.Base(path))
	return strings.HasPrefix(n, "test") || strings.HasPrefix(n, "example") || n == "debug.c"
}

// filterSources drops test/example files from a source list.
func filterSources(in []string) []string {
	out := make([]string, 0, len(in))
	for _, p := range in {
		if !isSkippableSource(p) {
			out = append(out, p)
		}
	}
	return out
}

// copyFile copies one file, creating the destination directory.
func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0o644)
}

// copyTree copies src into dst recursively, preserving relative structure.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(path, target)
	})
}

// compileObjects compiles each source to an object file in objDir and returns
// the object paths. Compilation is parallel across sources: the bundled clang
// is ~242 MB and its cold load dominates each invocation (CLAUDE.md §6), so a
// serial matrix of 5 targets × N sources spends most of its wall clock in
// process startup.
func (s *Server) compileObjects(
	tag string, tc *libToolchain, extraFlags, includeDirs, sources []string, objDir string,
) ([]string, error) {
	if len(sources) == 0 {
		return nil, nil
	}
	if err := os.MkdirAll(objDir, 0o755); err != nil {
		return nil, err
	}

	type result struct {
		obj string
		err error
	}
	results := make([]result, len(sources))

	sem := make(chan struct{}, compileConcurrency())
	var wg sync.WaitGroup
	for i, src := range sources {
		wg.Add(1)
		go func(i int, src string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			// Object names include the index: two source dirs can hold the same
			// base name (SOEM's osal/linux/osal.c vs osal/osal.c), and a plain
			// stem would make one silently overwrite the other.
			obj := filepath.Join(objDir, fmt.Sprintf("%03d_%s.o", i,
				strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))))

			args := append([]string{}, tc.BaseArgs...)
			args = append(args, optFlags...)
			args = append(args, extraFlags...)
			for _, inc := range tc.SysIncs {
				if _, err := os.Stat(inc); err == nil {
					args = append(args, "-isystem", inc)
				}
			}
			for _, inc := range includeDirs {
				if _, err := os.Stat(inc); err == nil {
					args = append(args, "-I", inc)
				}
			}
			args = append(args, "-c", src, "-o", obj)

			out, err := runWithTimeout(exec.Command(tc.Clang, args...), 3*time.Minute)
			if err != nil {
				_ = os.Remove(obj)
				results[i] = result{err: fmt.Errorf("[%s] %s: %s",
					tag, filepath.Base(src), strings.TrimSpace(out))}
				return
			}
			results[i] = result{obj: obj}
		}(i, src)
	}
	wg.Wait()

	var objs []string
	var firstErr error
	for _, r := range results {
		if r.err != nil {
			if firstErr == nil {
				firstErr = r.err
			}
			continue
		}
		objs = append(objs, r.obj)
	}
	if firstErr != nil {
		for _, o := range objs {
			_ = os.Remove(o)
		}
		return nil, firstErr
	}
	return objs, nil
}

// compileConcurrency bounds parallel clang processes. Each one peaks around a
// few hundred MB, so this is capped rather than left at NumCPU on a big box.
func compileConcurrency() int {
	n := runtime.NumCPU()
	if n < 1 {
		n = 1
	}
	if n > 8 {
		n = 8
	}
	return n
}

// archive runs llvm-ar rcs to bundle objects into libPath, then deletes them.
func (s *Server) archive(tag, arCmd, libPath string, objs []string) error {
	if len(objs) == 0 {
		return fmt.Errorf("[%s] no objects to archive for %s", tag, filepath.Base(libPath))
	}
	if err := os.MkdirAll(filepath.Dir(libPath), 0o755); err != nil {
		return err
	}
	_ = os.Remove(libPath) // `ar rcs` MERGES into an existing archive — stale members would survive
	args := append([]string{"rcs", libPath}, objs...)
	out, err := runWithTimeout(exec.Command(arCmd, args...), time.Minute)
	for _, o := range objs {
		_ = os.Remove(o)
	}
	if err != nil {
		return fmt.Errorf("[%s] archive %s: %v: %s", tag, filepath.Base(libPath), err, strings.TrimSpace(out))
	}
	return nil
}

// installArchives moves every .a from a staging dir into the real lib dir.
//
// ⚠️ This is the "swap" half of build-to-staging. The Tauri original DELETED
// every existing header and .a up front and then compiled in place, so an
// aborted or failing build left resources/ stripped. That was survivable when
// each target had its own header copy; it is not now that a single
// resources/krontek-include/ feeds every compile in the product. Nothing in
// resources/ is touched until the work that produces it has succeeded.
//
// Existing archives NOT produced by this run are left alone (libsoem.a stays
// when only the Krontek repos are rebuilt), and the `EMPTY` git placeholder is
// never removed.
func installArchives(stageDir, libDir string) (int, error) {
	entries, err := os.ReadDir(stageDir)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(libDir, 0o755); err != nil {
		return 0, err
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".a" {
			continue
		}
		src := filepath.Join(stageDir, e.Name())
		dst := filepath.Join(libDir, e.Name())
		b, err := os.ReadFile(src)
		if err != nil {
			return n, err
		}
		// Write via a temp file + rename so a reader (a concurrent project
		// compile) never sees a half-written archive.
		tmp := dst + ".tmp"
		if err := os.WriteFile(tmp, b, 0o644); err != nil {
			return n, err
		}
		if err := os.Rename(tmp, dst); err != nil {
			_ = os.Remove(tmp)
			return n, err
		}
		n++
	}
	return n, nil
}

// ── HTTP handlers ───────────────────────────────────────────────────────────

// startLibJob runs fn on a goroutine under libBuildMu and answers immediately.
// The result travels on the SSE topics, matching how the UI listens: it calls
// the endpoint, then reads progress lines until a *-done event arrives.
func (s *Server) startLibJob(w http.ResponseWriter, name string, progressTopic, doneTopic string, fn func() error) {
	if !libBuildMu.TryLock() {
		writeError(w, http.StatusConflict, "another library build is already running")
		return
	}
	go func() {
		defer libBuildMu.Unlock()
		start := time.Now()
		err := fn()
		if err != nil {
			s.events.Emit(doneTopic, map[string]any{"success": false, "message": err.Error()})
			return
		}
		s.events.Emit(doneTopic, map[string]any{
			"success": true,
			"message": fmt.Sprintf("%s completed in %s", name, time.Since(start).Round(time.Second)),
		})
	}()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "started": true})
}

type updateLibrariesReq struct {
	Repos []string `json:"repos"`
}

func (s *Server) handleUpdateLibraries(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req updateLibrariesReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	if len(req.Repos) == 0 {
		writeError(w, http.StatusBadRequest, "no repositories selected")
		return
	}
	s.startLibJob(w, "Library build", topicLibProgress, topicLibDone, func() error {
		return s.runUpdateLibraries(req.Repos)
	})
}

func (s *Server) handleBuildSoem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	s.startLibJob(w, "SOEM build", topicLibProgress, topicLibDone, s.runBuildSoem)
}

func (s *Server) handleBuildCanopen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	s.startLibJob(w, "CANopen build", topicLibProgress, topicLibDone, s.runBuildCanopen)
}

func (s *Server) handleUpdateServer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	s.startLibJob(w, "Server build", topicServerProgress, topicServerDone, s.runUpdateServer)
}
