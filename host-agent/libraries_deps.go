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

	// ⚠️ The vendored contrib/osal/macosx/osal.c predates SOEM's current OSAL
	// contract and does not just need a small patch — see writeSoemMacosxOsal
	// for the full account of what is wrong with it. Replace it outright with
	// a correct implementation before macosSrc (below) ever globs for it.
	if err := writeSoemMacosxOsal(soemDir); err != nil {
		return fmt.Errorf("[SOEM] macosx osal.c: %w", err)
	}
	if err := patchSoemMacosxOsalDefs(filepath.Join(soemDir, "contrib", "osal", "macosx", "osal_defs.h")); err != nil {
		s.libLog("[SOEM] WARN: macosx osal_defs patch skipped: %v", err)
	}

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
	// macOS has no OFFICIAL SOEM port (no cmake/macosx.cmake — see the ⚠️ note
	// on the "macos" switch case below), but the real SOEM tree DOES vendor an
	// unofficial one under contrib/, structurally identical to the win32/wpcap
	// pair above: a libpcap-based nicdrv+oshw pair plus its own osal. Verified
	// against the live v2.0.0 tree (no cmake/macosx.cmake exists; contrib/
	// oshw/macosx and contrib/osal/macosx do).
	macosSrc := concat(core,
		filterSources(findFilesWithExt(filepath.Join(soemDir, "contrib", "oshw", "macosx"), "c")),
		osalRoot,
		filterSources(findFilesWithExt(filepath.Join(soemDir, "contrib", "osal", "macosx"), "c")))

	if err := patchSoemWin32Osal(filepath.Join(osalDir, "win32", "osal.c")); err != nil {
		s.libLog("[SOEM] WARN: win32 osal patch skipped: %v", err)
	}

	s.libLog("[SOEM] sources: core=%d linux=%d win32=%d macos=%d", len(core), len(linuxSrc), len(win32Src), len(macosSrc))

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
		case "macos":
			// ⚠️ Unofficial port (contrib/, no cmake/macosx.cmake — verified
			// against the real v2.0.0 tree): a libpcap-based nicdrv+oshw pair,
			// the exact structural analogue of the win32/wpcap case above.
			// Unlike win32 (which vendors its own WinPcap headers under
			// oshw/win32/wpcap/Include), macOS pcap headers/lib come from the
			// system SDK (<pcap/pcap.h>, usr/lib/libpcap.tbd) that
			// bundledHostClangArgs already points -isysroot at — no extra -I
			// needed here, and no extra -L/-lpcap needed to ARCHIVE (that is
			// a final-link concern for whoever links this .a into a binary).
			sources = macosSrc
			includes = []string{
				repoInc, osalDir,
				filepath.Join(soemDir, "contrib", "osal", "macosx"),
				filepath.Join(soemDir, "contrib", "oshw", "macosx"),
			}
			// No -D flags: clang predefines __APPLE__/__MACH__ itself, and
			// (verified) nothing in SOEM's core src/ or the macosx contrib
			// files tests LINUX/WIN32 — those two flags above are consumed
			// only by the vendored WinPcap headers on the win32 side.
			//
			// ⚠️ macosSrc only compiles because writeSoemMacosxOsal (below)
			// already replaced the vendored osal.c and
			// patchSoemMacosxOsalDefs already completed osal_defs.h — the
			// contrib/ port as cloned does NOT compile against SOEM v2.0.0's
			// current OSAL contract (verified by trying it first: 20+ errors,
			// then missing osal_mutex_*/osal_monotonic_sleep at link time).
			// See those two functions for the full account.
		default:
			s.libLog("[SOEM][%s] skipped — unrecognized platform %q", t.Tag, t.Platform)
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

// patchSoemMacosxOsalDefs completes SOEM's unofficial contrib/osal/macosx
// osal_defs.h.
//
// ⚠️ Discovered by actually attempting this build (not by reading the source):
// the contrib/ macOS port predates SOEM v2.0.0's shared osal.h / ec_type.h /
// ec_main.h, which reference two macros every OTHER platform's osal_defs.h
// defines — linux: `struct timespec` / `pthread_mutex_t`; win32: `struct
// timespec` / `CRITICAL_SECTION` — but the macosx one never learned:
// `ec_timet` and `osal_mutext` (sic — that exact spelling is upstream's, not
// a typo introduced here). Without this patch EVERY core SOEM source fails to
// compile on macOS with "unknown type name 'ec_timet'"/"'osal_mutext'".
// macOS is POSIX like Linux for both purposes, so the same definitions apply.
func patchSoemMacosxOsalDefs(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	content := string(b)
	if strings.Contains(content, "ec_timet") {
		return nil // upstream caught up, or already patched — nothing to do
	}
	const addition = "\n#include <time.h>\n" +
		"#define ec_timet            struct timespec\n" +
		"#define osal_mutext         pthread_mutex_t\n"
	idx := strings.LastIndex(content, "#endif")
	if idx < 0 {
		return fmt.Errorf("osal_defs.h has no closing #endif to patch before")
	}
	patched := content[:idx] + addition + content[idx:]
	return os.WriteFile(path, []byte(patched), 0o644)
}

// writeSoemMacosxOsal replaces contrib/osal/macosx/osal.c outright rather than
// patching it.
//
// ⚠️ Discovered by actually attempting this build, not by reading the source:
// the vendored file predates THREE real API changes SOEM's shared osal.h now
// requires, verified against the real v2.0.0 tree:
//  1. ec_timet used to be a bespoke `{sec, usec}` struct; it is now `#define
//     ec_timet struct timespec` (`.tv_sec`/`.tv_nsec`) everywhere, including
//     core/shared src/ec_dc.c — so this is not optional, every platform's
//     osal.c must agree on the CURRENT layout.
//  2. osal_get_monotonic_time / osal_monotonic_sleep are declared in osal.h
//     and called from shared code, but never implemented by the old file —
//     a link-time failure that a compile-only check would miss entirely.
//  3. osal_mutex_create/_destroy/_lock/_unlock (used by shared code) are
//     likewise declared but never implemented by the old file.
// This is written as a small adaptation of osal/linux/osal.c (same POSIX
// primitives, same osal_timespec* helper macros from the shared osal.h)
// rather than a patch, with exactly one real platform difference:
// clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, …) does not exist on
// Darwin at all (verified — it is a Linux/glibc-only POSIX extension; the
// loader-host's hotswap_host.c hit the same gap and used mach_wait_until
// for its high-resolution case, see CLAUDE.md §6 "macOS simulation"). SOEM's
// own sleep is not hard-real-time critical enough to need mach_wait_until,
// so the portable fallback is used instead: convert the absolute monotonic
// deadline to a relative duration against "now" and hand that to nanosleep.
// PTHREAD_PRIO_INHERIT (used by osal_mutex_create) was verified to work on
// this machine's Xcode Command Line Tools clang rather than assumed.
func writeSoemMacosxOsal(soemDir string) error {
	const content = `/*
 * macOS osal.c for the KronEditor SOEM build — see writeSoemMacosxOsal in
 * host-agent/libraries_deps.go for why this replaces the vendored
 * contrib/osal/macosx/osal.c instead of patching it.
 */
#include <osal.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

void osal_get_monotonic_time(ec_timet *ts)
{
   clock_gettime(CLOCK_MONOTONIC, ts);
}

ec_timet osal_current_time(void)
{
   struct timespec ts;
   clock_gettime(CLOCK_REALTIME, &ts);
   return ts;
}

void osal_time_diff(ec_timet *start, ec_timet *end, ec_timet *diff)
{
   osal_timespecsub(end, start, diff);
}

void osal_timer_start(osal_timert *self, uint32 timeout_usec)
{
   struct timespec start_time;
   struct timespec timeout;

   osal_get_monotonic_time(&start_time);
   osal_timespec_from_usec(timeout_usec, &timeout);
   osal_timespecadd(&start_time, &timeout, &self->stop_time);
}

boolean osal_timer_is_expired(osal_timert *self)
{
   struct timespec current_time;
   int is_not_yet_expired;

   osal_get_monotonic_time(&current_time);
   is_not_yet_expired = osal_timespeccmp(&current_time, &self->stop_time, <);

   return is_not_yet_expired == FALSE;
}

int osal_usleep(uint32 usec)
{
   struct timespec ts;
   osal_timespec_from_usec(usec, &ts);
   return nanosleep(&ts, NULL);
}

/* macOS has no clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, ...) — convert
 * the absolute monotonic deadline to a relative duration against "now" and
 * sleep that instead. A deadline already in the past sleeps for zero time
 * rather than underflowing into a huge unsigned duration. */
int osal_monotonic_sleep(ec_timet *ts)
{
   struct timespec now, remain;

   osal_get_monotonic_time(&now);
   if (osal_timespeccmp(ts, &now, <))
   {
      return 0;
   }
   osal_timespecsub(ts, &now, &remain);
   return nanosleep(&remain, NULL) == 0 ? 0 : -1;
}

void *osal_malloc(size_t size)
{
   return malloc(size);
}

void osal_free(void *ptr)
{
   free(ptr);
}

int osal_thread_create(void *thandle, int stacksize, void *func, void *param)
{
   int ret;
   pthread_attr_t attr;
   pthread_t *threadp;

   threadp = thandle;
   pthread_attr_init(&attr);
   pthread_attr_setstacksize(&attr, stacksize);
   ret = pthread_create(threadp, &attr, func, param);
   if (ret < 0)
   {
      return 0;
   }
   return 1;
}

int osal_thread_create_rt(void *thandle, int stacksize, void *func, void *param)
{
   int ret;
   pthread_attr_t attr;
   struct sched_param schparam;
   pthread_t *threadp;

   threadp = thandle;
   pthread_attr_init(&attr);
   pthread_attr_setstacksize(&attr, stacksize);
   ret = pthread_create(threadp, &attr, func, param);
   pthread_attr_destroy(&attr);
   if (ret < 0)
   {
      return 0;
   }
   memset(&schparam, 0, sizeof(schparam));
   schparam.sched_priority = 40;
   ret = pthread_setschedparam(*threadp, SCHED_FIFO, &schparam);
   if (ret < 0)
   {
      return 0;
   }

   return 1;
}

void *osal_mutex_create(void)
{
   pthread_mutexattr_t mutexattr;
   osal_mutext *mutex;
   mutex = (osal_mutext *)osal_malloc(sizeof(osal_mutext));
   if (mutex)
   {
      pthread_mutexattr_init(&mutexattr);
      pthread_mutexattr_setprotocol(&mutexattr, PTHREAD_PRIO_INHERIT);
      pthread_mutex_init(mutex, &mutexattr);
   }
   return (void *)mutex;
}

void osal_mutex_destroy(void *mutex)
{
   pthread_mutex_destroy((osal_mutext *)mutex);
   osal_free(mutex);
}

void osal_mutex_lock(void *mutex)
{
   pthread_mutex_lock((osal_mutext *)mutex);
}

void osal_mutex_unlock(void *mutex)
{
   pthread_mutex_unlock((osal_mutext *)mutex);
}
`
	path := filepath.Join(soemDir, "contrib", "osal", "macosx", "osal.c")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
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
