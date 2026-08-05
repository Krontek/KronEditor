package main

// Third-party dependency builds — "Build SOEM" and "Build CANopen".
//
// Both follow the same shape as runUpdateLibraries: clone → stage headers →
// compile per target → install only on success. They install into their OWN
// subtree of the shared include dir (soem/, canopen/), which is why
// installKrontekHeaders is careful to leave sibling subtrees alone.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	soemRepoURL     = "https://github.com/OpenEtherCATsociety/SOEM.git"
	soemTag         = "v2.0.0"
	canopenRepoURL  = "https://github.com/CANopenNode/CANopenNode.git"
	depCloneTimeout = 5 * time.Minute
)

// ── SOEM ────────────────────────────────────────────────────────────────────

func (s *Server) runBuildSoem() error {
	targets := libraryTargets()
	s.libLog("=== Build SOEM %s ===", soemTag)

	tempBase, err := os.MkdirTemp("", "kroneditor_soem_")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tempBase)

	soemDir := filepath.Join(tempBase, "SOEM")
	s.libLog("[SOEM] cloning %s...", soemTag)
	if err := gitClone(soemRepoURL, soemTag, soemDir, depCloneTimeout); err != nil {
		return fmt.Errorf("[SOEM] clone failed: %w", err)
	}
	s.libLog("[SOEM] cloned OK")

	if err := writeSoemOptionsHeader(soemDir); err != nil {
		return fmt.Errorf("[SOEM] ec_options.h: %w", err)
	}
	s.libLog("[SOEM] ec_options.h written (SOEM %s CMakeLists defaults)", soemTag)

	// SOEM tree layout. v2.x keeps the core in src/; older trees used soem/.
	srcDir := filepath.Join(soemDir, "src")
	legacyLayout := false
	if _, err := os.Stat(srcDir); err != nil {
		srcDir = filepath.Join(soemDir, "soem")
		legacyLayout = true
	}
	repoInc := filepath.Join(soemDir, "include")
	osalDir := filepath.Join(soemDir, "osal")

	core := filterSources(findFilesWithExt(srcDir, "c"))
	if len(core) == 0 {
		return fmt.Errorf("[SOEM] no core C sources under %s — aborting rather than archiving a partial libsoem.a", srcDir)
	}

	// ⚠️ Only LEGACY trees compile osal/*.c from the root; SOEM v2.x builds
	// osal/<platform>/osal.c only, and adding the root file there produces
	// duplicate symbols.
	var osalRoot []string
	if legacyLayout {
		if entries, err := os.ReadDir(osalDir); err == nil {
			for _, e := range entries {
				if !e.IsDir() && filepath.Ext(e.Name()) == ".c" {
					p := filepath.Join(osalDir, e.Name())
					if !isSkippableSource(p) {
						osalRoot = append(osalRoot, p)
					}
				}
			}
		}
	}

	linuxSrc := concat(core,
		filterSources(findFilesWithExt(filepath.Join(soemDir, "oshw", "linux"), "c")),
		osalRoot,
		filterSources(findFilesWithExt(filepath.Join(osalDir, "linux"), "c")))
	win32Src := concat(core,
		filterSources(findFilesWithExt(filepath.Join(soemDir, "oshw", "win32"), "c")),
		osalRoot,
		filterSources(findFilesWithExt(filepath.Join(osalDir, "win32"), "c")))

	if err := patchSoemWin32Osal(filepath.Join(osalDir, "win32", "osal.c")); err != nil {
		s.libLog("[SOEM] WARN: win32 osal patch skipped: %v", err)
	}

	s.libLog("[SOEM] sources: core=%d linux=%d win32=%d", len(core), len(linuxSrc), len(win32Src))

	// Stage the whole header tree, structure preserved — kronethercatmaster
	// includes them as <soem/soem.h>, "osal.h", "nicdrv.h" from these dirs.
	stageInclude := filepath.Join(tempBase, "_stage_soem")
	headers := findFilesWithExt(soemDir, "h")
	for _, h := range headers {
		rel, err := filepath.Rel(soemDir, h)
		if err != nil {
			continue
		}
		if err := copyFile(h, filepath.Join(stageInclude, rel)); err != nil {
			return fmt.Errorf("[SOEM] stage header %s: %w", rel, err)
		}
	}
	s.libLog("[SOEM] staged %d header(s)", len(headers))

	stageLibs := filepath.Join(tempBase, "_stage_lib")
	var failures []string
	built := 0

	for _, t := range targets {
		var sources, includes []string
		var flags []string
		switch t.Platform {
		case "linux":
			sources = linuxSrc
			includes = []string{repoInc, osalDir, filepath.Join(osalDir, "linux"), filepath.Join(soemDir, "oshw", "linux")}
			flags = []string{"-DLINUX", "-pthread"}
		case "win32":
			sources = win32Src
			includes = []string{repoInc, osalDir, filepath.Join(osalDir, "win32"),
				filepath.Join(soemDir, "oshw", "win32"),
				filepath.Join(soemDir, "oshw", "win32", "wpcap", "Include")}
			flags = []string{"-DWIN32", "-D_WIN32"}
		default:
			// ⚠️ SOEM vendors no macOS OSHW/OSAL port, so there is nothing to
			// build. That is not a gap: a Mac is a development host and never
			// an EtherCAT master — kronethercatmaster is compiled stub-only
			// there (see soemBuildInputs).
			s.libLog("[SOEM][%s] skipped — SOEM has no port for this platform (EtherCAT runs on the PLC, not the host)", t.Tag)
			continue
		}

		tc, err := s.resolveToolchain(t)
		if err != nil {
			s.libLog("[SOEM][%s] SKIP: %v", t.Tag, err)
			failures = append(failures, fmt.Sprintf("[SOEM][%s] toolchain unavailable: %v", t.Tag, err))
			continue
		}

		s.libLog("[SOEM][%s] compiling %d source(s)...", t.Tag, len(sources))
		objDir := filepath.Join(tempBase, "_obj", strings.ReplaceAll(t.Tag, "/", "_"))
		objs, err := s.compileObjects(t.Tag, tc, flags, includes, sources, objDir)
		if err != nil {
			s.libLog("[SOEM][%s] ✗ %v", t.Tag, err)
			failures = append(failures, err.Error())
			continue
		}
		stageLibDir := filepath.Join(stageLibs, strings.ReplaceAll(t.Tag, "/", "_"))
		if err := s.archive(t.Tag, tc.Ar, filepath.Join(stageLibDir, "libsoem.a"), objs); err != nil {
			s.libLog("[SOEM][%s] ✗ %v", t.Tag, err)
			failures = append(failures, err.Error())
			continue
		}
		s.libLog("[SOEM][%s] ✓ libsoem.a", t.Tag)
		built++
	}

	if len(failures) > 0 {
		s.libLog("[SOEM] failed — resources/ left untouched")
		return fmt.Errorf("%s", strings.Join(dedupeStrings(failures), "; "))
	}
	if built == 0 {
		return fmt.Errorf("[SOEM] no target produced an archive")
	}

	if err := s.installDepHeaders(stageInclude, "soem"); err != nil {
		return fmt.Errorf("[SOEM] install headers: %w", err)
	}
	if err := s.installDepArchives(stageLibs, targets); err != nil {
		return err
	}
	s.libLog("=== Build SOEM complete ===")
	return nil
}

// writeSoemOptionsHeader creates include/soem/ec_options.h.
//
// ⚠️ CMake normally generates this file, so a plain `git clone` does not have
// it and every SOEM source fails on the missing include. Rather than requiring
// cmake on the build host, the defaults are written directly — they match SOEM
// v2.0.0's CMakeLists.txt exactly.
//
// ⚠️ EC_BUFSIZE really is (EC_MAXECATFRAME): that macro comes from ec_type.h,
// which is included AFTER this header, so the preprocessor resolves it lazily
// at the point of use. This is what cmake emits — do not "fix" it to a literal.
func writeSoemOptionsHeader(soemDir string) error {
	const content = `/* ec_options.h — generated defaults matching SOEM v2.0.0 CMakeLists.txt */
#ifndef _ec_options_
#define _ec_options_

#ifdef __cplusplus
extern "C" {
#endif

#define EC_BUFSIZE             (EC_MAXECATFRAME)
#define EC_MAXBUF              16
#define EC_MAXEEPBITMAP        128
#define EC_MAXEEPBUF           (EC_MAXEEPBITMAP << 5)
#define EC_LOGGROUPOFFSET      16
#define EC_MAXELIST            64
#define EC_MAXNAME             40
#define EC_MAXSLAVE            200
#define EC_MAXGROUP            2
#define EC_MAXIOSEGMENTS       64
#define EC_MAXMBX              1486
#define EC_MBXPOOLSIZE         32
#define EC_MAXEEPDO            0x200
#define EC_MAXSM               8
#define EC_MAXFMMU             4
#define EC_MAXLEN_ADAPTERNAME  128
#define EC_MAX_MAPT            1
#define EC_MAXODLIST           1024
#define EC_MAXOELIST           256
#define EC_SOE_MAXNAME         60
#define EC_SOE_MAXMAPPING      64
#define EC_TIMEOUTRET          2000
#define EC_TIMEOUTRET3         (EC_TIMEOUTRET * 3)
#define EC_TIMEOUTSAFE         20000
#define EC_TIMEOUTEEP          20000
#define EC_TIMEOUTTXM          20000
#define EC_TIMEOUTRXM          700000
#define EC_TIMEOUTSTATE        2000000
#define EC_DEFAULTRETRIES      3
#define EC_PRIMARY_MAC_ARRAY   {0x0101, 0x0101, 0x0101}
#define EC_SECONDARY_MAC_ARRAY {0x0404, 0x0404, 0x0404}

#ifdef __cplusplus
}
#endif

#endif /* _ec_options_ */
`
	dst := filepath.Join(soemDir, "include", "soem", "ec_options.h")
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dst, []byte(content), 0o644)
}

// patchSoemWin32Osal replaces SOEM's timespec_get() call with _ftime64_s().
//
// ⚠️ mingw-w64 against the MSVCRT runtime does not expose timespec_get even
// with -std=c11, so osal/win32/osal.c fails to link for the win32 target
// without this. No-op when the file is absent or already patched.
func patchSoemWin32Osal(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	content := string(b)
	if !strings.Contains(content, "timespec_get(") {
		return nil // upstream changed, or already patched — nothing to do
	}
	var out strings.Builder
	out.WriteString("#include <sys/timeb.h>\n#ifndef TIME_UTC\n#define TIME_UTC 1\n#endif\n")
	for _, line := range strings.Split(content, "\n") {
		if strings.Contains(line, "timespec_get(") {
			out.WriteString("   { struct __timeb64 _ftb; _ftime64_s(&_ftb); " +
				"ts.tv_sec=(time_t)_ftb.time; ts.tv_nsec=(long)_ftb.millitm*1000000L; }\n")
			continue
		}
		out.WriteString(line)
		out.WriteString("\n")
	}
	return os.WriteFile(path, []byte(out.String()), 0o644)
}

// ── CANopen ─────────────────────────────────────────────────────────────────

func (s *Server) runBuildCanopen() error {
	targets := libraryTargets()
	s.libLog("=== Build CANopen (CANopenNode) ===")
	// Honest framing: nothing in the editor links this yet.
	s.libLog("Note: no KronEditor component links libcanopen.a today — this produces the")
	s.libLog("      archive and headers for a future KronCANopen driver (see kron_pi.h).")

	tempBase, err := os.MkdirTemp("", "kroneditor_canopen_")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tempBase)

	repoDir := filepath.Join(tempBase, "CANopenNode")
	s.libLog("[CANopen] cloning...")
	if err := gitClone(canopenRepoURL, "", repoDir, depCloneTimeout); err != nil {
		return fmt.Errorf("[CANopen] clone failed: %w", err)
	}
	s.libLog("[CANopen] cloned OK")

	// Stage the header tree with structure preserved (301/, 303/, 305/,
	// socketCAN/ are all included by relative path from CANopen.h).
	stageInclude := filepath.Join(tempBase, "_stage_canopen")
	headers := findFilesWithExt(repoDir, "h")
	for _, h := range headers {
		rel, err := filepath.Rel(repoDir, h)
		if err != nil {
			continue
		}
		if err := copyFile(h, filepath.Join(stageInclude, rel)); err != nil {
			return fmt.Errorf("[CANopen] stage header %s: %w", rel, err)
		}
	}
	s.libLog("[CANopen] staged %d header(s)", len(headers))

	var rootC []string
	if entries, err := os.ReadDir(repoDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() && filepath.Ext(e.Name()) == ".c" {
				p := filepath.Join(repoDir, e.Name())
				if !isSkippableSource(p) {
					rootC = append(rootC, p)
				}
			}
		}
	}
	// CiA 301 core + 303 (indicators) + 305 (LSS) — the same protocol modules
	// the Tauri builder selected. 304/309/storage/extra are upstream options
	// that need extra configuration, and are reported rather than guessed at.
	stack := concat(rootC,
		filterSources(findFilesWithExt(filepath.Join(repoDir, "301"), "c")),
		filterSources(findFilesWithExt(filepath.Join(repoDir, "303"), "c")),
		filterSources(findFilesWithExt(filepath.Join(repoDir, "305"), "c")))
	if len(stack) == 0 {
		return fmt.Errorf("[CANopen] no sources found — upstream layout changed?")
	}

	// ⚠️ CANopenNode does not ship a usable CO_driver_target.h: it is the
	// hardware binding, supplied by whoever ports the stack. The Tauri builder
	// wrote its own hand-rolled stub; upstream's own example/CO_driver_target.h
	// is used instead, so the definitions always match the cloned revision
	// instead of drifting from a copy frozen in our source.
	//
	// ⚠️ Upstream ALSO moved the SocketCAN driver out into a separate repo
	// (CANopenLinux), so the socketCAN/ directory the Tauri version compiled
	// no longer exists. That is why this build produces a protocol-stack
	// archive with a REFERENCE driver binding, not a CAN-capable one — a real
	// KronCANopen driver must rebuild the stack against its own
	// CO_driver_target.h, since the struct layouts come from that header.
	driverInc := filepath.Join(repoDir, "example")
	if _, err := os.Stat(filepath.Join(driverInc, "CO_driver_target.h")); err != nil {
		return fmt.Errorf("[CANopen] upstream layout changed: no example/CO_driver_target.h to bind against (%v)", err)
	}
	s.libLog("[CANopen] %d source(s); driver binding = upstream example/CO_driver_target.h (reference, not CAN-capable)", len(stack))
	for _, opt := range []string{"304", "309", "storage", "extra"} {
		if _, err := os.Stat(filepath.Join(repoDir, opt)); err == nil {
			s.libLog("[CANopen] note: upstream module %s/ exists but is not built (needs its own configuration)", opt)
		}
	}

	stageLibs := filepath.Join(tempBase, "_stage_lib")
	var failures []string
	built := 0

	includes := []string{
		repoDir,
		filepath.Join(repoDir, "301"),
		filepath.Join(repoDir, "303"),
		filepath.Join(repoDir, "305"),
		driverInc,
	}

	// Every target builds: the reference driver binding needs only freestanding
	// C headers, so unlike SOEM there is no platform that must be skipped.
	for _, t := range targets {
		tc, err := s.resolveToolchain(t)
		if err != nil {
			s.libLog("[CANopen][%s] SKIP: %v", t.Tag, err)
			failures = append(failures, fmt.Sprintf("[CANopen][%s] toolchain unavailable: %v", t.Tag, err))
			continue
		}
		s.libLog("[CANopen][%s] compiling %d source(s)...", t.Tag, len(stack))
		objDir := filepath.Join(tempBase, "_obj", strings.ReplaceAll(t.Tag, "/", "_"))
		objs, err := s.compileObjects(t.Tag, tc, nil, includes, stack, objDir)
		if err != nil {
			s.libLog("[CANopen][%s] ✗ %v", t.Tag, err)
			failures = append(failures, err.Error())
			continue
		}
		stageLibDir := filepath.Join(stageLibs, strings.ReplaceAll(t.Tag, "/", "_"))
		if err := s.archive(t.Tag, tc.Ar, filepath.Join(stageLibDir, "libcanopen.a"), objs); err != nil {
			s.libLog("[CANopen][%s] ✗ %v", t.Tag, err)
			failures = append(failures, err.Error())
			continue
		}
		s.libLog("[CANopen][%s] ✓ libcanopen.a", t.Tag)
		built++
	}

	if len(failures) > 0 {
		s.libLog("[CANopen] failed — resources/ left untouched")
		return fmt.Errorf("%s", strings.Join(dedupeStrings(failures), "; "))
	}
	if built == 0 {
		return fmt.Errorf("[CANopen] no target produced an archive")
	}

	if err := s.installDepHeaders(stageInclude, "canopen"); err != nil {
		return fmt.Errorf("[CANopen] install headers: %w", err)
	}
	if err := s.installDepArchives(stageLibs, targets); err != nil {
		return err
	}
	s.libLog("=== Build CANopen complete ===")
	return nil
}

// ── shared install helpers ──────────────────────────────────────────────────

// installDepHeaders replaces resources/krontek-include/<sub>/ with the staged
// tree. Only that ONE subtree is touched, so a SOEM build cannot disturb the
// Krontek headers next to it (or vice versa).
func (s *Server) installDepHeaders(stageInclude, sub string) error {
	root, err := s.paths.ResourceTargetIncludeDir("x86_64/linux")
	if err != nil {
		return err
	}
	dst := filepath.Join(root, sub)
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	if err := copyTree(stageInclude, dst); err != nil {
		return err
	}
	s.libLog("  headers → %s", dst)
	return nil
}

// installDepArchives copies each staged target dir's archives into place.
// Targets with no staged dir (platform skipped above) are silently ignored.
func (s *Server) installDepArchives(stageLibs string, targets []libTarget) error {
	for _, t := range targets {
		stageLibDir := filepath.Join(stageLibs, strings.ReplaceAll(t.Tag, "/", "_"))
		if _, err := os.Stat(stageLibDir); err != nil {
			continue
		}
		libDir, err := s.paths.ResourceTargetLibDir(t.ResourceKey)
		if err != nil {
			return err
		}
		n, err := installArchives(stageLibDir, libDir)
		if err != nil {
			return fmt.Errorf("[%s] install: %w", t.Tag, err)
		}
		s.libLog("  [%s] %d archive(s) → %s", t.Tag, n, libDir)
	}
	return nil
}

// concat flattens source lists.
func concat(lists ...[]string) []string {
	var out []string
	for _, l := range lists {
		out = append(out, l...)
	}
	return out
}
