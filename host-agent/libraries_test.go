package main

// Integration test for the library builder.
//
// The real github.com/Krontek/* repos are private, so the pipeline is driven
// against a LOCAL git fixture instead: git clone accepts a filesystem path as
// a URL, so pointing krontekRepoBase at a temp dir exercises the exact same
// code path (clone → stage headers → compile per target → verify → install)
// with the real bundled clang and the real sysroots.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// newTestServer builds a Server whose resources root is a throwaway dir but
// whose toolchains root is the real one, so compiles are genuine.
func newTestServer(t *testing.T) (*Server, string) {
	t.Helper()

	repoRoot, err := filepath.Abs("..")
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	toolchains := filepath.Join(repoRoot, "toolchains")
	if _, err := os.Stat(filepath.Join(toolchains, "bin", "clang")); err != nil {
		t.Skip("bundled clang not present — run setup_toolchain.py first")
	}

	resources := t.TempDir()
	paths, err := NewPaths(resources, toolchains, t.TempDir())
	if err != nil {
		t.Fatalf("NewPaths: %v", err)
	}
	return &Server{paths: paths, events: NewEvents()}, resources
}

// makeFixtureRepo creates a git repo that looks like a Krontek library:
// one top-level .c (becomes the archive), one header, and decoys that must be
// ignored (a test_*.c and a source in a subdirectory).
//
// ⚠️ The directory is named "<name>.git" because runUpdateLibraries builds the
// clone URL as base+repo+".git" and git does NOT strip that suffix for local
// filesystem paths (it only does so for some remote helpers). Naming it
// otherwise makes every clone fail with "repository does not exist" — which
// looks like a passing test for the failure cases, since they expect an error.
func makeFixtureRepo(t *testing.T, base, name string) {
	t.Helper()
	dir := filepath.Join(base, name+".git")
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	write := func(rel, content string) {
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(name+".h", "#pragma once\nint "+name+"_add(int a, int b);\n")
	write(name+".c", "#include \""+name+".h\"\nint "+name+"_add(int a, int b){ return a+b; }\n")
	// Decoys: neither may produce an archive.
	write("test_"+name+".c", "#error \"test sources must be skipped\"\n")
	write(filepath.Join("sub", "vendored.c"), "#error \"subdirectory sources must be skipped\"\n")

	for _, args := range [][]string{
		{"init", "-q"},
		{"-c", "user.email=t@t", "-c", "user.name=t", "add", "."},
		{"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
}

func TestRunUpdateLibrariesEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	s, resources := newTestServer(t)

	fixtures := t.TempDir()
	makeFixtureRepo(t, fixtures, "kronfixture")

	orig := krontekRepoBase
	krontekRepoBase = fixtures + string(os.PathSeparator)
	defer func() { krontekRepoBase = orig }()

	if err := s.runUpdateLibraries([]string{"kronfixture"}); err != nil {
		t.Fatalf("runUpdateLibraries: %v", err)
	}

	// Headers land in the ONE shared include tree, not per-target copies.
	inc := filepath.Join(resources, "krontek-include")
	if _, err := os.Stat(filepath.Join(inc, "kronfixture.h")); err != nil {
		t.Errorf("header not installed into krontek-include: %v", err)
	}
	for _, stale := range []string{"x86_64-linux-gnu", "aarch64-linux-gnu"} {
		if _, err := os.Stat(filepath.Join(resources, stale, "include")); err == nil {
			t.Errorf("per-target include/ was created under %s — headers must stay consolidated", stale)
		}
	}

	// One archive per target, named from the source stem.
	for _, triple := range []string{
		"x86_64-linux-gnu", "x86_64-w64-mingw32", "aarch64-linux-gnu", "arm-linux-gnueabihf",
	} {
		a := filepath.Join(resources, triple, "lib", "libkronfixture.a")
		st, err := os.Stat(a)
		if err != nil {
			t.Errorf("%s: missing archive: %v", triple, err)
			continue
		}
		if st.Size() == 0 {
			t.Errorf("%s: archive is empty", triple)
		}
	}

	// The decoys must NOT have produced archives.
	for _, bad := range []string{"libtest_kronfixture.a", "libvendored.a"} {
		if _, err := os.Stat(filepath.Join(resources, "x86_64-linux-gnu", "lib", bad)); err == nil {
			t.Errorf("%s was built — test/subdirectory sources must be skipped", bad)
		}
	}
}

// A repo that fails to clone (bad name, deleted repo, network blip) must NOT
// abort the run — the original Tauri builder `continue`d past a clone failure
// so every other selected repo still got attempted. An earlier version of the
// Go port regressed this to a hard `return`, discovered live against a real
// (private) Krontek org where one selected repo no longer exists: the other
// nine had already cloned successfully but were never even compiled, because
// the function returned the instant the tenth clone failed.
func TestRunUpdateLibrariesSkipsBadRepoButTriesRest(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	s, resources := newTestServer(t)

	fixtures := t.TempDir()
	makeFixtureRepo(t, fixtures, "kronok1")
	makeFixtureRepo(t, fixtures, "kronok2")
	// "kronmissing" is deliberately never created — its clone must fail, and
	// it sits BETWEEN the two good repos so a premature return would provably
	// skip kronok2.

	orig := krontekRepoBase
	krontekRepoBase = fixtures + string(os.PathSeparator)
	defer func() { krontekRepoBase = orig }()

	// Capture progress log lines via the real Events broadcaster so we can
	// prove BOTH good repos were attempted, not just that the run failed.
	ch := make(chan eventMsg, 256)
	s.events.mu.Lock()
	s.events.subscribers[ch] = struct{}{}
	s.events.mu.Unlock()
	var mu sync.Mutex
	var lines []string
	done := make(chan struct{})
	go func() {
		defer close(done)
		for msg := range ch {
			if msg.Topic == topicLibProgress {
				mu.Lock()
				lines = append(lines, fmt.Sprint(msg.Data))
				mu.Unlock()
			}
		}
	}()

	err := s.runUpdateLibraries([]string{"kronok1", "kronmissing", "kronok2"})
	s.events.mu.Lock()
	delete(s.events.subscribers, ch)
	s.events.mu.Unlock()
	close(ch)
	<-done

	if err == nil {
		t.Fatal("expected an error — kronmissing cannot be cloned")
	}
	if !strings.Contains(err.Error(), "kronmissing") {
		t.Errorf("error should name the failed repo, got: %v", err)
	}

	// ⚠️ Must match "[<repo>] cloning..." specifically, not just the repo
	// name anywhere in the log — the very first log line lists every
	// SELECTED repo ("Repos: kronok1, kronmissing, kronok2") regardless of
	// whether it is ever actually attempted, which let an earlier, weaker
	// version of this assertion pass against the buggy early-return code
	// too: it "found" kronok2 in that summary line while the real per-repo
	// attempt log for it was never written.
	joined := strings.Join(lines, "\n")
	for _, want := range []string{"[kronok1] cloning", "[kronok2] cloning"} {
		if !strings.Contains(joined, want) {
			t.Errorf("progress log never shows %q — that repo was not attempted after kronmissing failed\nlog:\n%s", want, joined)
		}
	}

	// Atomicity is still the rule: an overall-failed run installs NOTHING,
	// not even archives from repos that individually compiled fine.
	if _, err := os.Stat(filepath.Join(resources, "x86_64-linux-gnu", "lib", "libkronok1.a")); err == nil {
		t.Error("a failed run installed an archive — partial success must not partially install")
	}
}

// A failing source must leave resources/ untouched. This is the staging
// guarantee: the pre-consolidation builder deleted headers up front, so an
// aborted run stripped the tree every project compile depends on.
func TestRunUpdateLibrariesFailureLeavesResourcesUntouched(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	s, resources := newTestServer(t)

	// Seed the include dir with a header the build must not destroy.
	inc := filepath.Join(resources, "krontek-include")
	if err := os.MkdirAll(filepath.Join(inc, "soem", "include"), 0o755); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(inc, "soem", "include", "soem.h")
	if err := os.WriteFile(sentinel, []byte("/* pre-existing */\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	preExisting := filepath.Join(inc, "kronkeepme.h")
	if err := os.WriteFile(preExisting, []byte("/* old */\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	fixtures := t.TempDir()
	makeFixtureRepo(t, fixtures, "kronbroken")
	// Replace the good source with one that cannot compile, so the run fails
	// at the COMPILE stage — the stage the staging guarantee is about.
	if err := os.WriteFile(filepath.Join(fixtures, "kronbroken.git", "kronbroken.c"),
		[]byte("this is not valid C at all;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	commit := exec.Command("git", "-c", "user.email=t@t", "-c", "user.name=t",
		"commit", "-qam", "break it")
	commit.Dir = filepath.Join(fixtures, "kronbroken.git")
	if out, err := commit.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v: %s", err, out)
	}

	orig := krontekRepoBase
	krontekRepoBase = fixtures + string(os.PathSeparator)
	defer func() { krontekRepoBase = orig }()

	err := s.runUpdateLibraries([]string{"kronbroken"})
	if err == nil {
		t.Fatal("expected a build error for invalid C")
	}
	// Guard against the failure coming from an earlier stage (a clone that
	// never happened would satisfy the assertions below for the wrong reason).
	if !strings.Contains(err.Error(), "kronbroken.c") {
		t.Fatalf("expected a COMPILE failure naming the source, got: %v", err)
	}

	if _, err := os.Stat(sentinel); err != nil {
		t.Errorf("a failed build removed the sibling soem/ header tree: %v", err)
	}
	if _, err := os.Stat(preExisting); err != nil {
		t.Errorf("a failed build removed an existing header: %v", err)
	}
	if _, err := os.Stat(filepath.Join(resources, "x86_64-linux-gnu", "lib", "libkronbroken.a")); err == nil {
		t.Error("a failed build installed an archive")
	}
}

// installKrontekHeaders replaces the headers these repos own and must leave
// sibling subtrees (soem/, canopen/) alone — a SOEM build and a library build
// write into the same include root.
func TestInstallKrontekHeadersPreservesSiblingSubtrees(t *testing.T) {
	s, resources := newTestServer(t)
	inc := filepath.Join(resources, "krontek-include")

	mkfile := func(rel, body string) string {
		p := filepath.Join(inc, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	soemHdr := mkfile(filepath.Join("soem", "include", "soem", "soem.h"), "/* soem */")
	canHdr := mkfile(filepath.Join("canopen", "301", "CO_SDO.h"), "/* canopen */")
	oldHdr := mkfile("kronold.h", "/* removed upstream */")
	oldHAL := mkfile(filepath.Join("HAL", "kronhal_old.h"), "/* removed upstream */")

	stage := t.TempDir()
	if err := os.MkdirAll(filepath.Join(stage, "HAL"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "kronnew.h"), []byte("/* new */"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "HAL", "kronhal.h"), []byte("/* new hal */"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := s.installKrontekHeaders(stage); err != nil {
		t.Fatalf("installKrontekHeaders: %v", err)
	}

	for _, keep := range []string{soemHdr, canHdr} {
		if _, err := os.Stat(keep); err != nil {
			t.Errorf("sibling subtree file removed: %s", keep)
		}
	}
	// Within a scope the build DID populate, replacement is complete, so a
	// header removed upstream stops shadowing the new tree.
	for _, gone := range []string{oldHdr, oldHAL} {
		if _, err := os.Stat(gone); err == nil {
			t.Errorf("stale owned header survived: %s", gone)
		}
	}
	for _, want := range []string{"kronnew.h", filepath.Join("HAL", "kronhal.h")} {
		if _, err := os.Stat(filepath.Join(inc, want)); err != nil {
			t.Errorf("new header not installed: %s", want)
		}
	}
}

// ⚠️ A scope the build produced NOTHING for must be left completely alone.
//
// This pins the exact data-loss bug that shipped: HAL/ was wiped
// unconditionally, which was invisible while KronHAL was a cloned repo (the
// wipe was always followed by a fresh copy). Once KronHAL stopped being a repo
// nothing staged HAL/ any more, so a *successful* Build Libraries run silently
// deleted all five committed kronhal_*.h files — the headers CLAUDE.md §1 calls
// the source of truth. They survived only because git tracked them.
func TestInstallKrontekHeadersLeavesUnbuiltScopesAlone(t *testing.T) {
	s, resources := newTestServer(t)
	inc := filepath.Join(resources, "krontek-include")

	// The real situation: hand-maintained HAL headers already on disk...
	halDir := filepath.Join(inc, "HAL")
	if err := os.MkdirAll(halDir, 0o755); err != nil {
		t.Fatal(err)
	}
	halFiles := []string{"kronhal.h", "kronhal_rpi.h", "kronhal_bb.h", "kronhal_jetson.h", "kronhal_sim.h"}
	for _, n := range halFiles {
		if err := os.WriteFile(filepath.Join(halDir, n), []byte("/* hand-maintained */"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// ...and a build whose repos supply only top-level headers (no KronHAL,
	// which is no longer a repo at all).
	stage := t.TempDir()
	if err := os.WriteFile(filepath.Join(stage, "kronmath.h"), []byte("/* built */"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := s.installKrontekHeaders(stage); err != nil {
		t.Fatalf("installKrontekHeaders: %v", err)
	}

	for _, n := range halFiles {
		if _, err := os.Stat(filepath.Join(halDir, n)); err != nil {
			t.Errorf("HAL/%s was deleted by a build that never staged HAL/: %v", n, err)
		}
	}
	if _, err := os.Stat(filepath.Join(inc, "kronmath.h")); err != nil {
		t.Errorf("built header not installed: %v", err)
	}
}

// An EMPTY staged HAL/ must not authorise the wipe either — it would clear the
// directory with nothing to put back.
func TestInstallKrontekHeadersIgnoresEmptyStagedHAL(t *testing.T) {
	s, resources := newTestServer(t)
	inc := filepath.Join(resources, "krontek-include")

	halDir := filepath.Join(inc, "HAL")
	if err := os.MkdirAll(halDir, 0o755); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(halDir, "kronhal.h")
	if err := os.WriteFile(keep, []byte("/* hand-maintained */"), 0o644); err != nil {
		t.Fatal(err)
	}

	stage := t.TempDir()
	if err := os.MkdirAll(filepath.Join(stage, "HAL"), 0o755); err != nil { // empty
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "kronmath.h"), []byte("/* built */"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := s.installKrontekHeaders(stage); err != nil {
		t.Fatalf("installKrontekHeaders: %v", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Errorf("an empty staged HAL/ wiped the real one: %v", err)
	}
}

func TestSoemBuildInputs(t *testing.T) {
	root := t.TempDir()
	// No SOEM headers installed → stub fallback regardless of platform.
	if flags, incs := soemBuildInputs("kronethercatmaster", "linux", root); len(incs) != 0 ||
		len(flags) != 1 || flags[0] != "-DKRON_EC_SIM" {
		t.Errorf("missing SOEM headers should fall back to the stub build, got %v %v", flags, incs)
	}
	// Non-EtherCAT sources never get SOEM flags.
	if flags, incs := soemBuildInputs("kronmath", "linux", root); flags != nil || incs != nil {
		t.Errorf("kronmath must not receive SOEM inputs, got %v %v", flags, incs)
	}

	if err := os.MkdirAll(filepath.Join(root, "soem", "include"), 0o755); err != nil {
		t.Fatal(err)
	}
	flags, incs := soemBuildInputs("KronEtherCATMaster", "linux", root)
	if len(flags) != 1 || flags[0] != "-DLINUX" {
		t.Errorf("linux flags = %v, want -DLINUX (name match must be case-insensitive)", flags)
	}
	if len(incs) != 4 {
		t.Errorf("linux include dirs = %d, want 4", len(incs))
	}
	flags, incs = soemBuildInputs("kronethercatmaster", "win32", root)
	if len(flags) != 1 || flags[0] != "-DWIN32" {
		t.Errorf("win32 flags = %v, want -DWIN32", flags)
	}
	if len(incs) != 5 {
		t.Errorf("win32 include dirs = %d, want 5 (wpcap included)", len(incs))
	}
	// macOS is a development host, never an EtherCAT master.
	if flags, _ := soemBuildInputs("kronethercatmaster", "macos", root); flags[0] != "-DKRON_EC_SIM" {
		t.Errorf("macos flags = %v, want -DKRON_EC_SIM", flags)
	}
}

func TestVerifyArchivesReportsMissing(t *testing.T) {
	dir := t.TempDir()
	sources := []libSource{{Name: "kronmath"}, {Name: "kronlogic"}}
	if err := os.WriteFile(filepath.Join(dir, "libkronmath.a"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	missing := verifyArchives("x86_64/linux", dir, sources)
	if len(missing) != 1 {
		t.Fatalf("missing = %v, want exactly one entry", missing)
	}
	if !strings.Contains(missing[0], "libkronlogic.a") {
		t.Errorf("message %q should name the missing archive", missing[0])
	}
}

// libraryTargets must never silently claim a macOS slot on a non-Mac host:
// Apple's SDK cannot be bundled, so those archives are unbuildable elsewhere.
func TestLibraryTargetsMacOnlyOnDarwin(t *testing.T) {
	targets := libraryTargets()
	if len(targets) < 4 {
		t.Fatalf("expected at least the four cross targets, got %d", len(targets))
	}
	for _, tgt := range targets {
		if tgt.Platform == "macos" && runtime.GOOS != "darwin" {
			t.Errorf("macOS target %s offered on a non-Darwin host", tgt.Tag)
		}
		// Cortex-M was removed with the bare-metal boards.
		if strings.Contains(tgt.Tag, "CortexM") {
			t.Errorf("Cortex-M target %s should no longer be in the matrix", tgt.Tag)
		}
		// Every non-host target must resolve to a real resources/ directory.
		if _, err := targetResourceKey(tgt.ResourceKey); err != nil {
			t.Errorf("target %s has an unresolvable resource key: %v", tgt.Tag, err)
		}
	}
}
