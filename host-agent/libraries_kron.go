package main

// runUpdateLibraries — the "Build Libraries" action.
//
// Clones the selected github.com/Krontek/* repos, installs their headers into
// the shared include tree and compiles each top-level .c into a per-target
// static archive.

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// krontekRepoBase is where the library sources live. Mirrors KRON_REPOS in
// SettingsPage.jsx, which sends the bare repo names.
//
// A var, not a const, so the integration test can point the same code path at
// a local fixture repo — the Krontek repos are private, so the build pipeline
// would otherwise be untestable.
var krontekRepoBase = "https://github.com/Krontek/"

// libSource is one compilation unit: a top-level .c file that becomes
// lib<Name>.a. The Tauri builder derived the archive name from the file stem
// and produced exactly one archive per source file; keeping that means the
// archive names the rest of the toolchain already links (libkronmath.a,
// libkron_nc.a, …) stay byte-for-byte the same set.
type libSource struct {
	Name string // archive stem, e.g. "kronmath" → libkronmath.a
	Path string
	Repo string
}

func (s *Server) runUpdateLibraries(repos []string) error {
	targets := libraryTargets()

	s.libLog("=== Build Libraries ===")
	tags := make([]string, len(targets))
	for i, t := range targets {
		tags[i] = t.Tag
	}
	s.libLog("Targets: %s", strings.Join(tags, ", "))
	// ⚠️ Be explicit that the matrix depends on the host. Silently producing
	// four targets on Linux and five on a Mac is exactly the kind of thing that
	// reads as "everything is covered" when it is not.
	if !hasMacTarget(targets) {
		s.libLog("Note: macOS archives are NOT built here — Apple's SDK cannot be bundled,")
		s.libLog("      so resources/*-apple-darwin/lib must be produced by running this on a Mac.")
	}
	s.libLog("Repos:   %s", strings.Join(repos, ", "))

	tempBase, err := os.MkdirTemp("", "kroneditor_libs_")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tempBase)

	stageInclude := filepath.Join(tempBase, "_stage_include")
	stageLibs := filepath.Join(tempBase, "_stage_lib")
	if err := os.MkdirAll(stageInclude, 0o755); err != nil {
		return err
	}

	// ── 1. Clone + collect ──────────────────────────────────────────────────
	// ⚠️ A repo that fails to clone is WARNED about and SKIPPED, never a hard
	// stop (matching the original Tauri do_update_libraries, which `continue`d
	// past a clone failure rather than aborting). The whole run does still end
	// in failure if anything went wrong — see the failures check below — but
	// every OTHER selected repo is still attempted first, so a bad repo name
	// among ten selections is reported alongside any real compile errors in
	// the same run instead of being whack-a-mole'd one failure at a time.
	var sources []libSource
	var cloneDirs []string
	var headerCount int
	var failures []string

	for _, repo := range repos {
		repo = strings.TrimSpace(repo)
		if repo == "" || strings.ContainsAny(repo, "/\\") {
			return fmt.Errorf("invalid repository name %q", repo)
		}
		dir := filepath.Join(tempBase, repo)
		s.libLog("[%s] cloning...", repo)
		if err := gitClone(krontekRepoBase+repo+".git", "", dir, 5*time.Minute); err != nil {
			msg := fmt.Sprintf("[%s] clone failed: %v", repo, err)
			s.libLog("  ✗ %s", msg)
			failures = append(failures, msg)
			continue
		}
		cloneDirs = append(cloneDirs, dir)

		// ⚠️ KronHAL is NOT a repo any more (there is no "github.com/Krontek/
		// KronHAL" — a run selecting it now just fails to clone, same as any
		// other bad name). This check is kept — never true today — because if
		// the HAL sources ever come back as a fetchable repo under a different
		// name, they still need to land under HAL/, not flat: that is the
		// layout resources/krontek-include/ already has and what the generated
		// kron_hal.h / host_glue.c include by bare name. Until then, the HAL
		// headers are edited directly in resources/krontek-include/HAL/ (and
		// mirrored from KrontekLibraries if present — CLAUDE.md §1).
		isHAL := strings.EqualFold(repo, "KronHAL")
		dst := stageInclude
		if isHAL {
			dst = filepath.Join(stageInclude, "HAL")
		}
		headers := findFilesWithExt(dir, "h")
		for _, h := range headers {
			if err := copyFile(h, filepath.Join(dst, filepath.Base(h))); err != nil {
				return fmt.Errorf("[%s] stage header %s: %w", repo, filepath.Base(h), err)
			}
		}
		headerCount += len(headers)

		// Only TOP-LEVEL .c files are library sources; subdirectories are
		// vendored deps / platform trees that the repos build differently.
		entries, err := os.ReadDir(dir)
		if err != nil {
			return fmt.Errorf("[%s] read clone: %w", repo, err)
		}
		found := 0
		for _, e := range entries {
			if e.IsDir() || filepath.Ext(e.Name()) != ".c" {
				continue
			}
			p := filepath.Join(dir, e.Name())
			if isSkippableSource(p) {
				continue
			}
			sources = append(sources, libSource{
				Name: strings.TrimSuffix(e.Name(), ".c"),
				Path: p,
				Repo: repo,
			})
			found++
		}
		s.libLog("[%s] %d header(s), %d source(s)%s", repo, len(headers), found,
			map[bool]string{true: " → include/HAL/", false: ""}[isHAL])
		if found == 0 && !isHAL {
			s.libLog("[%s] WARN: no top-level .c found — no archive will be produced", repo)
		}
	}

	if len(sources) == 0 {
		if len(failures) > 0 {
			return fmt.Errorf("no repository cloned successfully: %s", strings.Join(dedupeStrings(failures), "; "))
		}
		return fmt.Errorf("no library sources found in the selected repositories")
	}

	// ⚠️ The GitHub clone is NOT written back over a local KrontekLibraries/.
	// The Tauri version did that, but CLAUDE.md §1 makes KrontekLibraries the
	// SOURCE OF TRUTH that is edited first — so copying GitHub state onto it
	// would silently overwrite exactly the local work it is meant to hold.
	if local := localKrontekLibrariesDir(); local != "" {
		s.libLog("Note: local %s left untouched (it is the source of truth; this build uses the GitHub clone).", local)
	}

	// ── 2. Compile every target into staging ────────────────────────────────
	// The include root used for compiling is the STAGED tree, so a build always
	// compiles against the headers it just fetched rather than whatever the
	// previous run installed.
	soemRoot, err := s.paths.ResourceTargetIncludeDir("x86_64/linux")
	if err != nil {
		return err
	}

	// ⚠️ `failures` is NOT re-declared here — it already carries any clone
	// failures from step 1, so a clone error and a compile error in the same
	// run both surface together instead of the compile step silently starting
	// from a clean slate.
	for _, t := range targets {
		s.libLog("--- %s ---", t.Tag)
		tc, err := s.resolveToolchain(t)
		if err != nil {
			msg := fmt.Sprintf("[%s] toolchain unavailable: %v", t.Tag, err)
			s.libLog("  SKIP: %v", err)
			failures = append(failures, msg)
			continue
		}

		stageLibDir := filepath.Join(stageLibs, strings.ReplaceAll(t.Tag, "/", "_"))
		if err := os.MkdirAll(stageLibDir, 0o755); err != nil {
			return err
		}

		includeDirs := append([]string{stageInclude, filepath.Join(stageInclude, "HAL")}, cloneDirs...)

		for _, src := range sources {
			extraFlags, ecIncludes := soemBuildInputs(src.Name, t.Platform, soemRoot)
			objDir := filepath.Join(tempBase, "_obj", strings.ReplaceAll(t.Tag, "/", "_"), src.Name)
			objs, err := s.compileObjects(
				t.Tag, tc, extraFlags, append(includeDirs, ecIncludes...), []string{src.Path}, objDir)
			if err != nil {
				s.libLog("  ✗ lib%s.a — %v", src.Name, err)
				failures = append(failures, err.Error())
				continue
			}
			libPath := filepath.Join(stageLibDir, "lib"+src.Name+".a")
			if err := s.archive(t.Tag, tc.Ar, libPath, objs); err != nil {
				s.libLog("  ✗ lib%s.a — %v", src.Name, err)
				failures = append(failures, err.Error())
				continue
			}
			s.libLog("  ✓ lib%s.a", src.Name)
		}

		// Verify every expected archive actually landed. A missing one used to
		// be discoverable only much later, as a link error in a user project.
		for _, msg := range verifyArchives(t.Tag, stageLibDir, sources) {
			s.libLog("  %s", msg)
			failures = append(failures, msg)
		}
	}

	// ── 3. Install (only now that everything compiled) ──────────────────────
	if len(failures) > 0 {
		s.libLog("Build failed — resources/ left untouched (%d error(s))", len(failures))
		return fmt.Errorf("%s", strings.Join(dedupeStrings(failures), "; "))
	}

	s.libLog("Installing headers and archives...")
	if err := s.installKrontekHeaders(stageInclude); err != nil {
		return fmt.Errorf("install headers: %w", err)
	}
	s.libLog("  %d header(s) → %s", headerCount, mustIncludeDir(s))

	for _, t := range targets {
		libDir, err := s.paths.ResourceTargetLibDir(t.ResourceKey)
		if err != nil {
			return err
		}
		stageLibDir := filepath.Join(stageLibs, strings.ReplaceAll(t.Tag, "/", "_"))
		n, err := installArchives(stageLibDir, libDir)
		if err != nil {
			return fmt.Errorf("[%s] install: %w", t.Tag, err)
		}
		s.libLog("  [%s] %d archive(s) → %s", t.Tag, n, libDir)
	}

	s.libLog("=== Build Libraries complete ===")
	return nil
}

// hasMacTarget reports whether the matrix includes a darwin slot.
func hasMacTarget(targets []libTarget) bool {
	for _, t := range targets {
		if t.Platform == "macos" {
			return true
		}
	}
	return false
}

// verifyArchives returns one message per expected-but-missing archive.
func verifyArchives(tag, libDir string, sources []libSource) []string {
	want := map[string]bool{}
	for _, s := range sources {
		want["lib"+s.Name+".a"] = true
	}
	names := make([]string, 0, len(want))
	for n := range want {
		names = append(names, n)
	}
	sort.Strings(names)

	var missing []string
	for _, n := range names {
		if _, err := os.Stat(filepath.Join(libDir, n)); err != nil {
			missing = append(missing, fmt.Sprintf("[%s] missing required archive %s", tag, n))
		}
	}
	return missing
}

// soemBuildInputs returns the extra flags and include dirs a source needs.
//
// ⚠️ Only kronethercatmaster wraps SOEM. When the SOEM headers are not
// installed the source still has to compile, so it falls back to the
// stub-only variant (-DKRON_EC_SIM) exactly as the Tauri builder did — run
// "Build SOEM" first for a real EtherCAT-capable archive.
func soemBuildInputs(libName, platform, soemRoot string) (flags []string, includes []string) {
	if !strings.EqualFold(libName, "kronethercatmaster") {
		return nil, nil
	}
	base := filepath.Join(soemRoot, "soem")
	if _, err := os.Stat(filepath.Join(base, "include")); err != nil {
		return []string{"-DKRON_EC_SIM"}, nil
	}
	switch platform {
	case "win32":
		// EtherCAT on Windows needs the WinPcap headers SOEM vendors.
		return []string{"-DWIN32"}, []string{
			filepath.Join(base, "include"),
			filepath.Join(base, "osal"),
			filepath.Join(base, "osal/win32"),
			filepath.Join(base, "oshw/win32"),
			filepath.Join(base, "oshw/win32/wpcap/Include"),
		}
	case "linux":
		return []string{"-DLINUX"}, []string{
			filepath.Join(base, "include"),
			filepath.Join(base, "osal"),
			filepath.Join(base, "osal/linux"),
			filepath.Join(base, "oshw/linux"),
		}
	case "macos":
		// runBuildSoem (libraries_deps.go) now stages SOEM's unofficial
		// contrib/oshw/macosx + contrib/osal/macosx port (libpcap-based) too,
		// preserving the tree's relative layout — so once "Build SOEM" has
		// run, `base` genuinely contains a contrib/ subtree here, not just on
		// linux/win32. No -D flags: nothing in SOEM's core src/ or the macosx
		// contrib files tests a platform macro (verified against the real
		// v2.0.0 tree); pcap headers/lib come from the system SDK.
		return nil, []string{
			filepath.Join(base, "include"),
			filepath.Join(base, "osal"),
			filepath.Join(base, "contrib/osal/macosx"),
			filepath.Join(base, "contrib/oshw/macosx"),
		}
	default:
		return []string{"-DKRON_EC_SIM"}, nil
	}
}

// installKrontekHeaders swaps the staged headers into resources/krontek-include/.
//
// ⚠️ It replaces ONLY what these repos own: the top-level *.h files and the
// HAL/ subdirectory. Sibling subtrees (soem/, canopen/) belong to the other
// build actions and must survive — the Tauri version wiped the whole include
// dir and got away with it only because it rebuilt SOEM in the same pass.
//
// ⚠️ Headers live in ONE place now (CLAUDE.md §1/§3). The original copied them
// into every resources/<triple>/include/; those copies were consolidated
// precisely because drift between them was a recurring bug, so this must not
// grow back into a per-target loop.
// locallyOwnedHeaders are top-level headers that live in the repo rather than
// in a cloned Krontek library, so installKrontekHeaders must never clear them.
var locallyOwnedHeaders = map[string]bool{"kronsystem.h": true}

func (s *Server) installKrontekHeaders(stageInclude string) error {
	dst, err := s.paths.ResourceTargetIncludeDir("x86_64/linux")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}

	// ⚠️ A scope is cleared ONLY if this build actually produced content for
	// it. Clearing unconditionally destroys files the build cannot restore.
	//
	// This is not hypothetical: HAL/ used to be wiped unconditionally, which
	// was harmless while KronHAL was a cloned repo (the wipe was always
	// followed by a fresh copy). The moment KronHAL stopped being a repo,
	// nothing staged HAL/ any more — so a successful "Build Libraries" run
	// silently deleted all five committed kronhal_*.h files, the very headers
	// CLAUDE.md §1 names the source of truth. They only survived because they
	// are tracked in git.
	//
	// Within a scope the replacement is still complete, so a header deleted
	// upstream stops shadowing the new tree.
	// ⚠️ ...and the same trap exists one scope over, for a single file rather
	// than a directory: kronsystem.h is authored in-repo (CLAUDE.md §14), not
	// cloned from any Krontek repo, so nothing ever stages it and the
	// top-level wipe deleted it on every successful run — taking all 25
	// SYSTEM/TIMERS blocks with it. Like the HAL headers, it only survived
	// because git tracks it.
	stagedTop, stagedHAL := stagedScopes(stageInclude)

	if stagedTop {
		entries, err := os.ReadDir(dst)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if e.IsDir() || filepath.Ext(e.Name()) != ".h" || locallyOwnedHeaders[e.Name()] {
				continue
			}
			_ = os.Remove(filepath.Join(dst, e.Name()))
		}
	}
	if stagedHAL {
		_ = os.RemoveAll(filepath.Join(dst, "HAL"))
	}

	return copyTree(stageInclude, dst)
}

// stagedScopes reports which header scopes the staged tree actually provides:
// top-level *.h files, and the HAL/ subdirectory. installKrontekHeaders clears
// a scope only when the build can refill it.
func stagedScopes(stageInclude string) (top, hal bool) {
	entries, err := os.ReadDir(stageInclude)
	if err != nil {
		return false, false
	}
	for _, e := range entries {
		switch {
		case e.IsDir() && e.Name() == "HAL":
			// An empty HAL/ must not count — it would authorise the wipe
			// without supplying anything to put back.
			if sub, err := os.ReadDir(filepath.Join(stageInclude, "HAL")); err == nil && len(sub) > 0 {
				hal = true
			}
		case !e.IsDir() && filepath.Ext(e.Name()) == ".h":
			top = true
		}
	}
	return top, hal
}

func mustIncludeDir(s *Server) string {
	d, err := s.paths.ResourceTargetIncludeDir("x86_64/linux")
	if err != nil {
		return "resources/krontek-include"
	}
	return d
}

// localKrontekLibrariesDir returns a sibling KrontekLibraries/ checkout if one
// exists next to the repo, else "". Used only to report that it is being left
// alone.
func localKrontekLibrariesDir() string {
	cwd, err := os.Getwd()
	if err != nil {
		return ""
	}
	for _, base := range []string{cwd, filepath.Dir(cwd), filepath.Dir(filepath.Dir(cwd))} {
		p := filepath.Join(filepath.Dir(base), "KrontekLibraries")
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return p
		}
	}
	return ""
}

// dedupeStrings collapses repeated error text so a failure that hits every
// target is reported once per target rather than once per source file.
func dedupeStrings(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	if len(out) > 12 {
		out = append(out[:12], fmt.Sprintf("... and %d more", len(out)-12))
	}
	return out
}
