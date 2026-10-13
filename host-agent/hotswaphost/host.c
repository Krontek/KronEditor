/*
 * Generic hot-swap loader-host for the PLC runtime (Linux).
 *
 * This is the STABLE part of the runtime — compiled once, never changes when
 * the logic changes. It owns: the PlcState arena (host memory → survives a
 * logic swap), the scan-loop threads + timing, us_tick / plc_stop, and the swap
 * machinery. The PLC logic is a separate `logic.so` (the transpiler's plc.c
 * compiled with -DPLC_HOTSWAP) that this host dlopen's and drives via a fixed
 * ABI:
 *
 *   unsigned long plc_state_size(void);          // sizeof(PlcState)
 *   void          plc_bind(void *state);         // adopt the arena (no reset)
 *   void          plc_state_init(void);          // cold init (once, not on swap)
 *   void          plc_init_hs(void);             // PLC_Init (HAL etc.)
 *   void          plc_cleanup_hs(void);
 *   int           plc_task_count(void);
 *   unsigned long plc_task_interval_us(int i);
 *   void          plc_task_body_<i>(void);        // one scan of task i
 *
 * Online change: write the new .so path into ./swap_request, send SIGUSR1. At
 * the next scan boundary all task threads park on a barrier, thread 0 dlopen's
 * the new .so and re-binds the SAME PlcState (state preserved); on any failure
 * it rolls back to the running .so. Build/run via demo.sh.
 *
 * us_tick / plc_stop are defined HERE and exported (-rdynamic) so the logic.so
 * resolves them at load (they are `extern` in plc.h).
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <pthread.h>
#include <time.h>

/* ── Platform shim ───────────────────────────────────────────────────────────
 * The scan engine, the generation/ping-pong logic and the swap protocol are
 * IDENTICAL on all three platforms; only a handful of primitives differ:
 *
 *                     Linux                    | Windows                        | macOS
 *   shared memory     shm_open+ftruncate+mmap  | CreateFileMapping+MapViewOfFile | open+ftruncate+mmap (real file)
 *   dynamic load      dlopen/dlsym/dlclose     | LoadLibrary/GetProcAddress/…    | dlopen/dlsym/dlclose
 *   swap signal       SIGUSR1                  | named auto-reset Event          | SIGUSR1
 *   sleep to deadline clock_nanosleep ABSTIME  | waitable timer                  | mach_wait_until
 *   barrier           hs_barrier (mutex + condvar, stop-aware) — one implementation everywhere
 *
 * Everything else — the scan structure, the swap protocol, the ping-pong slot
 * rules — has exactly ONE implementation. Keep it that way; the barrier/scan
 * logic is the part that must not diverge, which is why the barrier is ONE
 * portable mutex+condvar implementation (hs_barrier_t) rather than a
 * per-platform choice or a second copy of the scan loop.
 *
 * ⚠️ Two "POSIX" primitives are missing on macOS and both fail at COMPILE
 * time, so neither can be discovered late:
 *   - clock_nanosleep() does not exist (no TIMER_ABSTIME sleep at all).
 *   - pthread_barrier_* was never implemented — Apple skipped the optional
 *     POSIX barriers entirely, so _POSIX_BARRIERS is undefined. (The scan
 *     loop no longer uses them anywhere: see hs_barrier_t.)
 * A third difference is silent and therefore worse: macOS has no /dev/shm, and
 * a shm_open'd object is invisible to the filesystem, so the Go agent could
 * never read it back. See mirror_path() below.
 *
 * ⚠️ Windows keeps a LOADED module's file locked, so a slot cannot be
 * overwritten while it is live. The 2-slot ping-pong already guarantees we only
 * ever write the slot that is NOT loaded, and CleanupExcept only deletes the
 * other slot after a confirmed OK (i.e. after FreeLibrary) — so the scheme
 * needs no Windows-specific change. Do not "simplify" it to a single slot.
 * -------------------------------------------------------------------------*/
#if defined(_WIN32)
#include <windows.h>
#include <direct.h>          /* _chdir — main() moves to the build dir itself */
#define chdir _chdir
#define PLC_SWAP_EVENT_NAME "Local\\kron_plc_swap"
typedef HMODULE plc_module_t;
static plc_module_t plc_dlopen(const char *p)              { return LoadLibraryA(p); }
/* See the POSIX twin below. LoadLibrary of an already-loaded path likewise just
 * bumps the refcount of the old module. */
static int          plc_is_loaded(const char *p)           { return GetModuleHandleA(p) != NULL; }
static void        *plc_dlsym(plc_module_t h, const char *n) { return (void *)(uintptr_t)GetProcAddress(h, n); }
static void         plc_dlclose(plc_module_t h)            { if (h) FreeLibrary(h); }
static const char  *plc_dlerror(void) {
    static char b[128];
    snprintf(b, sizeof(b), "Win32 error %lu", (unsigned long)GetLastError());
    return b;
}

/* ⚠️ winpthreads DOES export clock_nanosleep, but its TIMER_ABSTIME mode does
 * NOT block — the scan thread returned instantly and the task ran flat out
 * (measured: a 10 ms task executing ~6 million times per second, so every IEC
 * timer/counter ran millions of times too fast). Windows therefore gets a real
 * waitable timer with a RELATIVE due time, computed from the same absolute
 * deadline so the loop keeps zero long-term drift.
 * CREATE_WAITABLE_TIMER_HIGH_RESOLUTION needs Win10 1803+; the fallback is a
 * plain timer (~15.6 ms granularity), still far better than spinning. */
static void plc_sleep_until(const struct timespec *deadline) {
    static HANDLE tmr = NULL;
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    long long delta_ns = (long long)(deadline->tv_sec - now.tv_sec) * 1000000000LL
                       + (long long)(deadline->tv_nsec - now.tv_nsec);
    if (delta_ns <= 0) return;                 /* already late — run immediately */
    if (!tmr) {
        tmr = CreateWaitableTimerExW(NULL, NULL,
                                     CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
        if (!tmr) tmr = CreateWaitableTimerW(NULL, FALSE, NULL);
        if (!tmr) { Sleep((DWORD)(delta_ns / 1000000LL)); return; }
    }
    LARGE_INTEGER due;
    due.QuadPart = -(delta_ns / 100);          /* negative = relative, 100 ns units */
    if (due.QuadPart == 0) due.QuadPart = -1;
    if (!SetWaitableTimer(tmr, &due, 0, NULL, NULL, FALSE)) {
        Sleep((DWORD)(delta_ns / 1000000LL));
        return;
    }
    WaitForSingleObject(tmr, INFINITE);
}
#else
#include <dlfcn.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>   /* watch_files_thread (file swap/stop triggers) */
#include <sched.h>      /* per-task SCHED_FIFO priority */
/* ⚠️ struct stat's nanosecond mtime is st_mtim on Linux but st_mtimespec on
 * macOS (which has no st_mtim at all — a compile error on the Mac build). */
#if defined(__APPLE__)
#define HS_MTIME_NSEC(st) ((long long)(st).st_mtimespec.tv_nsec)
#else
#define HS_MTIME_NSEC(st) ((long long)(st).st_mtim.tv_nsec)
#endif
typedef void *plc_module_t;
/* ⚠️ RTLD_LOCAL, never RTLD_GLOBAL. A GLOBAL module's definitions (TON_Call and
 * every other archive function linked into it) join the process-wide lookup
 * scope, so the NEXT generation's calls bound to them — which pinned the old
 * module in memory through its dlclose. The dlopen of that same slot path two
 * swaps later then returned the stale, still-mapped handle: every second swap
 * ran the OLD code and still reported OK. The host is -rdynamic, so us_tick,
 * plc_stop, __plc_shm and the __hs_* trampolines resolve without it. */
static plc_module_t plc_dlopen(const char *p)              { return dlopen(p, RTLD_NOW | RTLD_LOCAL); }
/* Is a module with this path still mapped? dlopen would hand back THAT one. */
static int          plc_is_loaded(const char *p) {
#if defined(RTLD_NOLOAD)
    void *h = dlopen(p, RTLD_NOW | RTLD_NOLOAD);
    if (h) { dlclose(h); return 1; }
#else
    (void)p;
#endif
    return 0;
}
static void        *plc_dlsym(plc_module_t h, const char *n) { return dlsym(h, n); }
static void         plc_dlclose(plc_module_t h)            { if (h) dlclose(h); }
static const char  *plc_dlerror(void)                      { return dlerror(); }

#if defined(__APPLE__)
#include <errno.h>
#include <mach/mach_time.h>

/* ⚠️ macOS has NO clock_nanosleep — not a stubbed one, it is simply absent, so
 * this is a compile error rather than a silent no-op. mach_wait_until is the
 * platform's absolute high-resolution sleep and keeps the same zero-drift
 * property: the caller advances `next` by the interval every scan, so any
 * overshoot is absorbed on the following iteration instead of accumulating. */
static void plc_sleep_until(const struct timespec *deadline) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    int64_t delta_ns = ((int64_t)deadline->tv_sec - (int64_t)now.tv_sec) * 1000000000LL
                     + ((int64_t)deadline->tv_nsec - (int64_t)now.tv_nsec);
    if (delta_ns <= 0) return;   /* already late — run the next scan immediately */
    /* Benign race: several task threads may initialise this concurrently, but
     * mach_timebase_info is a constant for the machine, so every writer stores
     * identical values. ⚠️ numer/denom is NOT 1/1 on Apple Silicon (the
     * timebase is 24 MHz), so mach ticks must really be converted — treating
     * them as nanoseconds would make every task run ~41x too fast. */
    static mach_timebase_info_data_t tb;
    if (tb.denom == 0) mach_timebase_info(&tb);
    uint64_t ticks = (uint64_t)delta_ns * (uint64_t)tb.denom / (uint64_t)tb.numer;
    mach_wait_until(mach_absolute_time() + ticks);
}

/* mirror_path maps the POSIX shm name the generated plc.c exports
 * ("/plc_runtime") onto a regular file in this process's working directory
 * (the build dir, set by the agent via cmd.Dir).
 *
 * ⚠️ Why not shm_open, which macOS does have? Because the Go agent has to READ
 * the mirror, and on macOS a shm object has no filesystem presence — the agent
 * would need shm_open itself, i.e. cgo, since neither the stdlib nor
 * x/sys/unix wraps it on darwin. Apple's shm_open also caps names at 31 chars
 * and permits ftruncate exactly ONCE per object, so a second cold start could
 * not resize a surviving segment. An mmap(MAP_SHARED) file gives the identical
 * coherent shared page with none of that.
 *
 * ⚠️ shmmirror_darwin.go's mirrorPath() performs the SAME transformation. If
 * one side changes, the agent reads a file nobody writes and every live value
 * silently freezes at zero — change both together. */
static const char *mirror_path(const char *nm) {
    static char buf[256];
    if (*nm == '/') nm++;
    snprintf(buf, sizeof buf, "./%s.mirror", nm);
    return buf;
}
#else
static void plc_sleep_until(const struct timespec *deadline) {
    clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, deadline, NULL);
}
#endif /* __APPLE__ */
#endif

/* ── EtherCAT master hooks (host_glue.c, Linux only) ──────────────────────
 * The generated glue owns __ec_cfg, the process image and the three bus
 * threads so SOEM's socket survives a dlclose of the logic module. Weak
 * references: a project with no EtherCAT bus emits no glue at all, and a
 * Windows/macOS build never emits these (the sim stays -DKRON_EC_SIM there).
 * ⚠️ Start BEFORE plc_init_hs() — the generated PLC_Init assumes the bus is
 * already up when it initialises the axes. */
#if defined(__linux__)
__attribute__((weak)) void __hs_ec_start(void);
__attribute__((weak)) void __hs_ec_stop(void);
/* The axis engine runs in the glue's bus thread (dt = the fieldbus cycle), but
 * every AXIS_REF is a PlcState field whose offset only the logic module knows.
 * After each bind we hand the module's plc_axis_ptr over so the glue can cache
 * the pointers; both halves are optional, so a project with no axes and an
 * older logic.so both just skip it. */
__attribute__((weak)) void __hs_axis_bind(void *(*getptr)(int));
#endif

volatile uint64_t us_tick = 0;   /* owned + exported for the logic.so */
volatile int plc_stop = 0;
/* The /dev/shm mirror (monitored values + runtime-owned force flags + the
 * force-write command mailbox, SHM layout v2). Host-owned so it survives a
 * logic swap → the editor keeps reading live variables, and a command posted
 * around a swap is neither lost nor applied twice: the mailbox cursors live
 * HERE, not in the module, and no task thread is inside plc_shm_pull while
 * the barrier holds. The logic .so references this (extern) in its
 * plc_shm_pull/sync, and initialises the mailbox once from plc_init_hs —
 * which is why the mirror must be mapped BEFORE pinit() below. */
unsigned char *__plc_shm = NULL;

#define MAXT 16
typedef void (*body_fn)(void);

static plc_module_t   g_handle;
static void          *g_state;
static body_fn        g_body[MAXT];
static unsigned long  g_interval[MAXT];
/* SCHED_FIFO priority per task, from the optional plc_task_priority export.
 * 99 is the value the runtime hardcoded before the field existed, so a logic.so
 * without the symbol keeps behaving exactly as it did. */
static int            g_prio[MAXT];
static int            g_ntask;

/* The layout hash of the FIRST successfully bound .so (cold start). Every
 * later swap is checked against THIS reference, never the previous swap's —
 * so a chain of small "compatible" edits cannot drift into an undetected
 * incompatibility one swap at a time. */
static unsigned long long g_layout_hash = 0;
static int                g_layout_hash_set = 0;

static volatile int      g_swap_req = 0;

/* ── Scan-boundary barrier ────────────────────────────────────────────────
 * Phase-counted mutex+condvar barrier, used on EVERY platform (macOS has no
 * pthread_barrier_* at all, and the standard one cannot be interrupted).
 * Phase counting makes it reusable: a thread sleeps until the phase it entered
 * on advances, so a fast thread cannot lap into the next round and steal a
 * slot from a straggler.
 *
 * ⚠️ STOP-AWARE: a task thread that sees plc_stop leaves its loop without
 * coming to the barrier, so a sibling already parked there for a swap would
 * wait for it forever and the host would never exit (the agent then had to
 * SIGKILL it, losing the final retain flush). Every exiting task thread calls
 * hs_barrier_abort(), which releases all waiters with -1 and makes every later
 * wait return -1 at once. */
typedef struct {
    pthread_mutex_t m;
    pthread_cond_t  c;
    unsigned        count;    /* threads required to trip the barrier */
    unsigned        waiting;
    unsigned        phase;
    int             aborted;
} hs_barrier_t;

static void hs_barrier_init(hs_barrier_t *b, unsigned n) {
    pthread_mutex_init(&b->m, NULL);
    pthread_cond_init(&b->c, NULL);
    b->count = n ? n : 1; b->waiting = 0; b->phase = 0; b->aborted = 0;
}

/* 0 = tripped normally, -1 = aborted (the caller must leave its scan loop). */
static int hs_barrier_wait(hs_barrier_t *b) {
    pthread_mutex_lock(&b->m);
    if (b->aborted) { pthread_mutex_unlock(&b->m); return -1; }
    unsigned phase = b->phase;
    if (++b->waiting == b->count) {
        b->phase++;
        b->waiting = 0;
        pthread_cond_broadcast(&b->c);
        pthread_mutex_unlock(&b->m);
        return 0;
    }
    while (phase == b->phase && !b->aborted) pthread_cond_wait(&b->c, &b->m);
    int rc = (phase == b->phase) ? -1 : 0;   /* phase moved = tripped before the abort */
    pthread_mutex_unlock(&b->m);
    return rc;
}

static void hs_barrier_abort(hs_barrier_t *b) {
    pthread_mutex_lock(&b->m);
    b->aborted = 1;
    pthread_cond_broadcast(&b->c);
    pthread_mutex_unlock(&b->m);
}

static hs_barrier_t g_barrier;

/* ── Retentive variables ──────────────────────────────────────────────────
 * The logic module owns the retain file format and the packing (it is the side
 * that knows PlcState); the host owns the CADENCE, because a thread running
 * inside the module would be dlclose'd out from under itself on every swap.
 * plc_retain_save is OPTIONAL — a project with no retained variable exports it
 * not at all, and the pointer simply stays NULL.
 *
 * ⚠️ g_retain_mu is what makes that safe: the flusher may be executing module
 * code at the exact moment thread 0 swaps, so do_swap holds the same mutex
 * across dlclose + re-resolve. The task threads are parked on the barrier for
 * that whole window anyway, so the extra lock costs nothing in the scan. */
#define RETAIN_INTERVAL_MS 1000
static int             (*g_retain_save)(void) = NULL;
static pthread_mutex_t   g_retain_mu = PTHREAD_MUTEX_INITIALIZER;

static int parse_gen_from_path(const char *path);

#if defined(_WIN32)
/* Windows has no SIGUSR1. The agent signals a named auto-reset Event; this
 * thread turns that into the same g_swap_req flag the Linux handler sets, so
 * the scan loop below is identical on both platforms. */
static HANDLE g_swap_event = NULL;
static void *swap_event_thread(void *arg) {
    (void)arg;
    for (;;) {
        if (WaitForSingleObject(g_swap_event, INFINITE) != WAIT_OBJECT_0) return NULL;
        if (plc_stop) return NULL;
        g_swap_req = 1;
    }
}
#else
static void on_usr1(int s) { (void)s; g_swap_req = 1; }

/* ⚠️ A privileged host cannot be signalled by the unprivileged agent that
 * spawned it (kill(2) compares uids, so SIGUSR1/SIGTERM come back EPERM), and
 * the whole online-change and stop paths hang off exactly those two signals.
 * So both also have a file trigger, polled here:
 *
 *   swap_request  — the agent REWRITES it per swap and nothing ever deletes it,
 *                   so existence means nothing; the trigger is a CHANGE. The
 *                   baseline is taken at startup, or a leftover request from
 *                   the previous run would swap the moment the host comes up.
 *   stop_request  — created by the agent, removed by the host on the way out,
 *                   so plain existence is the right test.
 *
 * The signals stay installed: a runtime started by KronServer (already root)
 * still gets them, and they are the faster path when they work. */
/* Identity of the LAST swap_request that was acted on (or the startup one).
 * Shared between the watcher and do_swap_locked: a swap triggered by SIGUSR1
 * reads the same file the watcher would see changed 10 ms later, and without
 * the hand-over that one request would be swapped TWICE. */
typedef struct { long long ino, sec, nsec, size; } req_id_t;
static req_id_t        g_req_seen = { -1, -1, -1, -1 };
static pthread_mutex_t g_req_mu   = PTHREAD_MUTEX_INITIALIZER;

static req_id_t req_id_of(const struct stat *st) {
    req_id_t r = { (long long)st->st_ino, (long long)st->st_mtime, HS_MTIME_NSEC(*st), (long long)st->st_size };
    return r;
}
static int req_id_eq(req_id_t a, req_id_t b) {
    return a.ino == b.ino && a.sec == b.sec && a.nsec == b.nsec && a.size == b.size;
}

/* A request is COMPLETE when it is one non-empty line ending in '\n' — every
 * writer appends one. ⚠️ A writer that is not atomic (plain write(2) rather
 * than tmp + rename) can be observed mid-write; such a file must neither
 * trigger nor become the baseline, so the watcher fires once the finished file
 * lands instead of swapping a truncated path. */
static int request_complete(void) {
    char buf[512];
    FILE *f = fopen("./swap_request", "rb");
    if (!f) return 0;
    size_t n = fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    if (n < 2 || buf[n - 1] != '\n') return 0;
    buf[n - 1] = 0;
    return parse_gen_from_path(buf) >= 0;
}

static void *watch_files_thread(void *arg) {
    (void)arg;
    struct stat st;
    if (stat("./swap_request", &st) == 0) {
        pthread_mutex_lock(&g_req_mu);
        g_req_seen = req_id_of(&st);
        pthread_mutex_unlock(&g_req_mu);
    }
    while (!plc_stop) {
        struct timespec ts = { 0, 10 * 1000 * 1000 };   /* 10 ms */
        nanosleep(&ts, NULL);
        if (stat("./swap_request", &st) == 0) {
            req_id_t cur = req_id_of(&st);
            pthread_mutex_lock(&g_req_mu);
            int changed = !req_id_eq(cur, g_req_seen);
            pthread_mutex_unlock(&g_req_mu);
            /* Baseline is NOT advanced here: do_swap_locked records the
             * identity of the file it actually read. An incomplete file is
             * simply looked at again on the next poll. */
            if (changed && request_complete()) g_swap_req = 1;
        }
        if (stat("./stop_request", &st) == 0) {
            remove("./stop_request");
            plc_stop = 1;
            return NULL;
        }
    }
    return NULL;
}
/* Graceful stop, so the scan threads unwind and the retain flush below runs.
 * The agent gives us a short grace period before SIGKILL (hotswap.go Stop). */
static void on_term(int s) { (void)s; plc_stop = 1; }
#endif

static uint64_t mono_us(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000000ULL + (uint64_t)t.tv_nsec / 1000ULL;
}

/* Sleeps toward the SAME absolute deadline in slices of at most 50 ms,
 * re-checking plc_stop between slices.
 * ⚠️ A single sleep to the deadline made a stop wait out the whole task
 * interval (a T#10s task took up to 10 s to notice stop_request, far past the
 * agent's grace, so it was SIGKILLed and skipped the final retain flush). The
 * deadline itself is unchanged and each slice goes through plc_sleep_until, so
 * the zero-drift property and the per-platform timing fixes above (64-bit
 * delta, Windows waitable timer, mach timebase) all still apply. */
#define HS_SLEEP_SLICE_NS 50000000LL
static void scan_sleep_until(const struct timespec *deadline) {
    for (;;) {
        if (plc_stop) return;
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long long delta_ns = ((long long)deadline->tv_sec - (long long)now.tv_sec) * 1000000000LL
                           + ((long long)deadline->tv_nsec - (long long)now.tv_nsec);
        if (delta_ns <= 0) return;
        if (delta_ns <= HS_SLEEP_SLICE_NS) { plc_sleep_until(deadline); return; }
        long long t = (long long)now.tv_nsec + HS_SLEEP_SLICE_NS;
        struct timespec slice;
        slice.tv_sec  = now.tv_sec + (time_t)(t / 1000000000LL);
        slice.tv_nsec = (long)(t % 1000000000LL);
        plc_sleep_until(&slice);
    }
}

/* Parses the generation number out of a "<dir>/logic_<N>.so" path. Returns -1
 * if the basename doesn't match that pattern (defensive — should never
 * happen since we only ever write paths we generated ourselves). */
static int parse_gen_from_path(const char *path) {
    const char *base = strrchr(path, '/');
#if defined(_WIN32)
    /* The agent hands us a native path, so the separator may be a backslash. */
    const char *bs = strrchr(path, '\\');
    if (bs && (!base || bs > base)) base = bs;
#endif
    base = base ? base + 1 : path;
    int gen = -1;
    if (sscanf(base, "logic_%d.so", &gen) == 1) return gen;
    return -1;
}

/* Reports a swap/cold-start outcome to the Go supervisor via a small result
 * file, written atomically (write to a .tmp then rename — POSIX rename() is
 * atomic on the same filesystem, so a concurrent poller never observes a
 * half-written file). This is the ONLY way the Go side learns whether a swap
 * actually applied — it must never delete an old/new .so based on anything
 * other than reading this back. */
/* ── Running privileged ────────────────────────────────────────────────────
 * The agent launches this host through pkexec, so it runs as root while the
 * agent stays the desktop user. Everything the host CREATES would then be
 * root-owned, and the agent could no longer read the live-value mirror or
 * clear swap_result. Hand those back to the user who asked for the run.
 *
 * ⚠️ The uid comes from the environment pkexec/sudo set, never from the file
 * system: PKEXEC_UID is the authenticated caller, SUDO_UID the sudo one. With
 * neither (a host started as root directly) there is nobody to hand them to,
 * so the chown is skipped rather than guessed. */
#if !defined(_WIN32)
static uid_t hs_owner_uid(void) {
    const char *e = getenv("PKEXEC_UID");
    if (!e || !*e) e = getenv("SUDO_UID");
    if (!e || !*e) return (uid_t)-1;
    long v = strtol(e, NULL, 10);
    return (v > 0) ? (uid_t)v : (uid_t)-1;
}
static void hs_give_to_owner(const char *path) {
    if (geteuid() != 0) return;
    uid_t u = hs_owner_uid();
    if (u == (uid_t)-1) return;
    (void)chown(path, u, (gid_t)-1);   /* mode stays 0600: owner-only, as before */
}
static void hs_give_fd_to_owner(int fd) {
    if (geteuid() != 0) return;
    uid_t u = hs_owner_uid();
    if (u == (uid_t)-1) return;
    (void)fchown(fd, u, (gid_t)-1);
}
#else
#define hs_give_to_owner(p)    ((void)0)
#define hs_give_fd_to_owner(f) ((void)0)
#endif

static void write_swap_result(const char *status, int gen, const char *detail) {
    FILE *f = fopen("./swap_result.tmp", "w");
    if (!f) return;
    if (detail && detail[0]) fprintf(f, "%s %d %s\n", status, gen, detail);
    else                     fprintf(f, "%s %d\n", status, gen);
    fclose(f);
#if defined(_WIN32)
    /* ⚠️ ISO rename() FAILS on Windows when the destination exists, so the
     * result file would only ever be written once (the cold-start line) and
     * every later swap would look like a timeout to the agent. MoveFileEx with
     * REPLACE_EXISTING is the atomic-overwrite equivalent of POSIX rename. */
    MoveFileExA("./swap_result.tmp", "./swap_result", MOVEFILE_REPLACE_EXISTING);
#else
    rename("./swap_result.tmp", "./swap_result");
    /* The agent truncates this file before every swap (ClearResultFile); a
     * root-owned 0644 would make that fail and every later swap would read the
     * previous outcome. */
    hs_give_to_owner("./swap_result");
#endif
}

#define RB_OK            0
#define RB_ERR_SYMBOL    1   /* a required export is missing (old/incompatible build) */
#define RB_ERR_TASKCOUNT 2   /* plc_task_count() out of range, or changed since cold start */
#define RB_ERR_LAYOUT    3   /* PlcState shape differs from the cold-start reference */

/* Resolve the ABI exports from a loaded handle and re-bind the live state.
 * Returns RB_OK on success, else one of the RB_ERR_* codes above — the
 * specific code becomes the FAIL reason in the swap_result file. Never calls
 * plc_state_init (state must persist). */
static int resolve_and_bind(void *h) {
    unsigned long (*ssize)(void)        = (unsigned long(*)(void))      plc_dlsym(h, "plc_state_size");
    void          (*bind)(void*)        = (void(*)(void*))             plc_dlsym(h, "plc_bind");
    int           (*tcount)(void)       = (int(*)(void))              plc_dlsym(h, "plc_task_count");
    unsigned long (*tiv)(int)           = (unsigned long(*)(int))     plc_dlsym(h, "plc_task_interval_us");
    int           (*tprio)(int)         = (int(*)(int))               plc_dlsym(h, "plc_task_priority");
    unsigned long long (*lhash)(void)   = (unsigned long long(*)(void)) plc_dlsym(h, "plc_state_layout_hash");
    if (!ssize || !bind || !tcount || !tiv || !lhash) return RB_ERR_SYMBOL;

    /* Hard safety net: refuse a layout-incompatible swap BEFORE touching
     * g_body/g_ntask/the state arena. Skipped only on the very first bind
     * (nothing to compare against yet — that bind itself becomes the
     * reference, set by the caller once this returns RB_OK). */
    if (g_layout_hash_set && lhash() != g_layout_hash) return RB_ERR_LAYOUT;

    int n = tcount();
    if (n < 0 || n > MAXT) return RB_ERR_TASKCOUNT;
    /* ⚠️ The task THREADS are created once in main() for the cold-start count
     * and never adjusted, so the count itself is as unswappable as the state
     * layout — and plc_state_layout_hash does NOT cover it (it fingerprints the
     * PlcState field shape only, and removing a task leaves every field intact).
     * Without this check a shrinking swap left g_body[i] for i >= n pointing
     * into the module about to be dlclose'd, and the still-running thread i
     * called into unmapped memory on its very next scan; a growing swap bumped
     * g_ntask for a thread that was never created, so the new task silently
     * never ran while the swap reported OK. Refuse both — the editor turns this
     * into the same rebuild+restart offer as a LAYOUT rejection.
     * The first bind establishes the reference (same condition as the layout
     * hash above), and rejecting BEFORE any global is touched keeps the
     * caller's rollback re-bind exact. Intervals stay swappable: g_interval is
     * read by the running threads every scan. */
    if (g_layout_hash_set && n != g_ntask) return RB_ERR_TASKCOUNT;
    for (int i = 0; i < n; i++) {
        char nm[32]; snprintf(nm, sizeof nm, "plc_task_body_%d", i);
        body_fn b = (body_fn)plc_dlsym(h, nm);
        if (!b) return RB_ERR_SYMBOL;
        g_body[i] = b;
        g_interval[i] = tiv(i);
        /* Optional: absent in a logic.so built before the field. Re-read on
         * every bind, like the interval, so a priority edit swaps live (the
         * thread applies it on its next scan). */
        g_prio[i] = tprio ? tprio(i) : 99;
        if (g_prio[i] < 1 || g_prio[i] > 99) g_prio[i] = 99;
    }
    g_ntask = n;
    bind(g_state);   /* adopt the SAME arena — preserves all state across swaps */
#if defined(__linux__)
    /* ⚠️ AFTER bind(): plc_axis_ptr dereferences the module's file-scope S, which
     * bind() has just pointed at the live arena. Re-done on every swap so the
     * glue never holds a pointer produced by a module that is about to be
     * dlclose'd — the arena itself does not move, and a layout change is already
     * refused above, so the values are in fact stable. */
    {
        void *(*axptr)(int) = (void*(*)(int))plc_dlsym(h, "plc_axis_ptr");
        if (__hs_axis_bind && axptr) __hs_axis_bind(axptr);
    }
#endif
    /* Optional (NULL when the project retains nothing). Re-resolved on every
     * bind: the pointer must never outlive the module it came from. */
    g_retain_save = (int(*)(void))plc_dlsym(h, "plc_retain_save");
    if (!g_layout_hash_set) { g_layout_hash = lhash(); g_layout_hash_set = 1; }
    return RB_OK;
}

static const char *rb_reason(int rc) {
    switch (rc) {
        case RB_ERR_LAYOUT:    return "LAYOUT";
        case RB_ERR_TASKCOUNT: return "TASKCOUNT";
        default:                return "SYMBOL";
    }
}

/* Performed by task thread 0 only, with all threads parked on the barrier. */
static void do_swap_locked(void) {
    char path[512] = {0};
    /* stdio rather than open()/read(): the request is one short line, and this
     * is the only file read in the loader — keeping it portable avoids an
     * fcntl.h dependency on Windows. */
    FILE *rf = fopen("./swap_request", "rb");
    if (rf) {
        size_t n = fread(path, 1, sizeof path - 1, rf);
        path[n] = 0;
        while (n && (path[n-1] == '\n' || path[n-1] == '\r' || path[n-1] == ' ' || path[n-1] == '\t')) path[--n] = 0;
#if !defined(_WIN32)
        /* This request is now consumed, whichever trigger fired — the watcher
         * must not fire again for the same file (see g_req_seen). */
        struct stat rst;
        if (path[0] && fstat(fileno(rf), &rst) == 0) {
            pthread_mutex_lock(&g_req_mu);
            g_req_seen = req_id_of(&rst);
            pthread_mutex_unlock(&g_req_mu);
        }
#endif
        fclose(rf);
    }
    if (!path[0]) {
        /* ⚠️ No bare return here: the Go supervisor learns the outcome of a
         * signalled swap ONLY from swap_result (see write_swap_result), so a
         * missing/empty/unreadable request file would burn its whole poll
         * timeout and report the useless "outcome unknown" while this host is
         * alive and happily running the old logic. There is no generation to
         * name here (the number lives in the request path we could not read),
         * so this writes -1 and hotswaplib.PollSwapResult accepts the
         * NOREQUEST reason regardless of the generation it claims — see
         * hotswaplib.DetailNoRequest. */
        fprintf(stderr, "[host] swap signalled but no readable swap_request (keeping current)\n");
        write_swap_result("FAIL", -1, "NOREQUEST");
        return;
    }
    int gen = parse_gen_from_path(path);

    /* ⚠️ A module with this path still mapped means dlopen would return THAT
     * handle — the old code — and the swap would "succeed" without changing
     * anything. RTLD_LOCAL removes the known cause; this turns any other one
     * (a module pinned by something we did not foresee) into a visible
     * failure instead of a silent no-op. Nothing has been touched yet, so
     * there is nothing to roll back. */
    if (plc_is_loaded(path)) {
        fprintf(stderr, "[host] swap refused: %s is still loaded (stale module) — keeping current\n", path);
        write_swap_result("FAIL", gen, "STALE");
        return;
    }

    plc_module_t nh = plc_dlopen(path);
    if (!nh) {
        fprintf(stderr, "[host] swap module load failed: %s (keeping current)\n", plc_dlerror());
        write_swap_result("FAIL", gen, "DLOPEN");
        return;
    }

    void *old = g_handle;
    g_handle = nh;
    int rc = resolve_and_bind(nh);
    if (rc != RB_OK) {            /* validate; roll back on failure */
        const char *reason = rb_reason(rc);
        fprintf(stderr, "[host] swap resolve failed (%s) — rolling back\n", reason);
        plc_dlclose(nh);
        g_handle = old;
        resolve_and_bind(old);    /* old already satisfied the layout check once; this re-bind cannot itself fail on RB_ERR_LAYOUT */
        write_swap_result("FAIL", gen, reason);
        return;
    }
    if (old) plc_dlclose(old);
    printf("[host] >>> HOT-SWAPPED to %s\n", path);
    fflush(stdout);
    write_swap_result("OK", gen, NULL);
}

/* The retain flusher runs OUTSIDE the barrier, so it can be inside the old
 * module's plc_retain_save the instant thread 0 dlclose's it. Serialising the
 * two here is cheaper and far more obvious than teaching the flusher to park. */
static void do_swap(void) {
    pthread_mutex_lock(&g_retain_mu);
    do_swap_locked();
    pthread_mutex_unlock(&g_retain_mu);
}

/* Periodic retain flush. plc_retain_save itself writes nothing when no retained
 * value changed, so an idle machine touches the disk exactly zero times. */
static void *retain_thread(void *arg) {
    (void)arg;
    int ticks = 0;
    while (!plc_stop) {
#if defined(_WIN32)
        Sleep(100);
#else
        struct timespec s = { .tv_sec = 0, .tv_nsec = 100 * 1000 * 1000 };
        nanosleep(&s, NULL);
#endif
        if (++ticks < (RETAIN_INTERVAL_MS / 100)) continue;   /* 100 ms granularity → prompt stop */
        ticks = 0;
        pthread_mutex_lock(&g_retain_mu);
        if (g_retain_save) g_retain_save();
        pthread_mutex_unlock(&g_retain_mu);
    }
    return NULL;
}

/* Demo/debug only (env HS_MONITOR=1): periodically dump the first bytes of the
 * PlcState arena so a swap can be seen to PRESERVE state (counters keep
 * climbing) while behaviour changes. Production reads variables via SHM. */
static void *monitor_thread(void *arg) {
    (void)arg;
    while (!plc_stop) {
        unsigned char *b = (unsigned char *)g_state;
        printf("[state]");
        for (int i = 0; i < 8 && b; i++) printf(" %02x", b[i]);
        /* cnt (int16) typically at offset 2 in this demo's PlcState */
        if (b) printf("   cnt=%d", *(int16_t *)(b + 2));
        printf("\n"); fflush(stdout);
#if defined(_WIN32)
        Sleep(500);
#else
        struct timespec s = { .tv_sec = 0, .tv_nsec = 500 * 1000 * 1000 };
        nanosleep(&s, NULL);
#endif
    }
    return NULL;
}

static void *task_thread(void *arg) {
    int idx = (int)(intptr_t)arg;
#if defined(__linux__)
    /* ⚠️ The scan threads never asked for real-time scheduling at all: only the
     * legacy single-binary build and the EtherCAT IO_Bus thread did, so a
     * hot-swap runtime — the default local sim AND what Build & Send deploys —
     * ran its PLC tasks at ordinary desktop priority even as root. The priority
     * is per task (TaskManager), re-read every scan so a swap can change it,
     * and the syscall is made only when it actually differs. */
    int cur_prio = -1;
#endif
    struct timespec next; clock_gettime(CLOCK_MONOTONIC, &next);
    while (!plc_stop) {
        /* ⚠️ Accumulate the period in 64-bit and split it into whole seconds +
         * remainder BEFORE touching tv_nsec. `long` (and mingw's tv_nsec) is
         * 32 BITS on Windows, so the old `next.tv_nsec += (long)(interval_us *
         * 1000UL)` overflowed for any interval >= ~2.148 s: T#3s produced
         * -1294967296, pushing the deadline BACKWARD, so plc_sleep_until saw
         * delta_ns <= 0, never slept, and the task ran flat out. Measured on
         * Windows: (long)(3000000 * 1000UL) == -1294967296. */
#if defined(__linux__)
        if (g_prio[idx] != cur_prio) {
            struct sched_param sp; sp.sched_priority = g_prio[idx];
            if (pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp) == 0) {
                cur_prio = g_prio[idx];
            } else {
                /* Reported once per priority value, not once per scan. */
                if (cur_prio != -2) fprintf(stderr,
                    "[host] task %d: SCHED_FIFO prio %d refused — real-time scheduling unavailable "
                    "(need root or CAP_SYS_NICE); timing will jitter\n", idx, g_prio[idx]);
                cur_prio = -2;
            }
        }
#endif
        long long period_ns = (long long)g_interval[idx] * 1000LL;
        next.tv_sec  += (time_t)(period_ns / 1000000000LL);
        next.tv_nsec += (long)(period_ns % 1000000000LL);
        while (next.tv_nsec >= 1000000000L) { next.tv_sec++; next.tv_nsec -= 1000000000L; }

        /* Scan-boundary swap: every thread gathers, thread 0 swaps + clears the
         * request, then all resume against the new (or rolled-back) logic. */
        if (g_swap_req) {
            /* -1 = a sibling is stopping (see hs_barrier_t): leave, never swap. */
            if (hs_barrier_wait(&g_barrier) != 0) break;
            if (idx == 0) { do_swap(); g_swap_req = 0; }
            if (hs_barrier_wait(&g_barrier) != 0) break;
        }

        us_tick = mono_us();
        if (g_body[idx]) g_body[idx]();

        scan_sleep_until(&next);
    }
    /* Whatever made us leave, nobody may wait for this thread at a barrier. */
    plc_stop = 1;
    hs_barrier_abort(&g_barrier);
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s logic.so [workdir]\n", argv[0]); return 1; }
    /* ⚠️ Every control file below is opened relative to the cwd ("./swap_request",
     * "./swap_result", retain.dat, and on macOS the shm mirror itself), which
     * used to be guaranteed by the agent's cmd.Dir. A privileged launch goes
     * through pkexec, whose treatment of the working directory is not something
     * to bet the swap protocol on, so the agent now passes the build dir
     * explicitly and we move there ourselves. */
    /* ⚠️ Resolve the module path BEFORE moving: a relative argv[1] is relative
     * to the cwd we were STARTED in, and dlopen'ing it after the chdir fails
     * with a bare "cannot open shared object file" that points at nothing.
     * (The agent passes an absolute path today; this keeps a hand-run host and
     * any future caller honest.) */
    static char logic_abs[2048];
    if (argc >= 3 && argv[2] && argv[2][0]) {
        if (argv[1][0] != '/' && !(argv[1][0] && argv[1][1] == ':')) {
            char cwd[1024];
            if (getcwd(cwd, sizeof cwd) &&
                (size_t)snprintf(logic_abs, sizeof logic_abs, "%s/%s", cwd, argv[1]) < sizeof logic_abs) {
                argv[1] = logic_abs;
            }
        }
        if (chdir(argv[2]) != 0) {
            fprintf(stderr, "chdir(%s) failed\n", argv[2]);
            return 1;
        }
    }
#if defined(_WIN32)
    /* Auto-reset named event; created here (not by the agent) so the agent's
     * OpenEvent succeeds only once the host is genuinely up. */
    g_swap_event = CreateEventA(NULL, FALSE, FALSE, PLC_SWAP_EVENT_NAME);
    if (!g_swap_event) { fprintf(stderr, "CreateEvent: %s\n", plc_dlerror()); return 1; }
    { pthread_t t; pthread_create(&t, NULL, swap_event_thread, NULL); pthread_detach(t); }
#else
    signal(SIGUSR1, on_usr1);
    signal(SIGTERM, on_term);
    signal(SIGINT,  on_term);
    /* File triggers beside the signals — the only ones that reach a privileged
     * host from the unprivileged agent. See watch_files_thread. */
    { pthread_t t; pthread_create(&t, NULL, watch_files_thread, NULL); pthread_detach(t); }
#endif

    /* ⚠️ EVERY cold-start failure below must write a swap_result before
     * returning. The Go supervisor learns the outcome ONLY from that file, so a
     * bare `return 1` here is indistinguishable from a host that never started
     * at all: the agent waits out its full timeout and then reports the useless
     * "cold-start outcome unknown (timeout) — host killed", while the real
     * reason (e.g. "dlopen: Win32 error 126" for a logic module with an
     * unresolvable DLL import) goes only to a stderr nobody reads. The loader
     * error is appended to the reason token — readSwapResult joins the trailing
     * fields, so a multi-word detail is safe. */
    int cold_gen = parse_gen_from_path(argv[1]);
    char detail[256];

    g_handle = plc_dlopen(argv[1]);
    if (!g_handle) {
        const char *e = plc_dlerror();
        fprintf(stderr, "dlopen: %s\n", e ? e : "(unknown)");
        snprintf(detail, sizeof detail, "DLOPEN %s", e ? e : "(unknown)");
        write_swap_result("FAIL", cold_gen, detail);
        return 1;
    }

    unsigned long (*ssize)(void) = (unsigned long(*)(void))plc_dlsym(g_handle, "plc_state_size");
    void (*sinit)(void)          = (void(*)(void))plc_dlsym(g_handle, "plc_state_init");
    void (*pinit)(void)          = (void(*)(void))plc_dlsym(g_handle, "plc_init_hs");
    if (!ssize) {
        fprintf(stderr, "missing plc_state_size\n");
        write_swap_result("FAIL", cold_gen, "SYMBOL plc_state_size");
        return 1;
    }

    g_state = calloc(1, ssize());
    if (!g_state) {
        fprintf(stderr, "state calloc failed\n");
        write_swap_result("FAIL", cold_gen, "NOMEM");
        return 1;
    }

    int rc0 = resolve_and_bind(g_handle);
    if (rc0 != RB_OK) {
        fprintf(stderr, "resolve failed (%s)\n", rb_reason(rc0));
        write_swap_result("FAIL", cold_gen, rb_reason(rc0));
        return 1;
    }
#if !defined(_WIN32)
    /* ⚠️ Our OWN pid, for the agent's last-resort kill. Under `sudo` the agent's
     * cmd.Process is sudo, not us: SIGKILLing that pid (privilegedKill) left
     * this root host running as an orphan, still holding the bus and the shm
     * mirror. Chowned like the other files we create; removed on a clean exit. */
    {
        FILE *pf = fopen("./plc_host.pid", "w");
        if (pf) {
            fprintf(pf, "%ld\n", (long)getpid());
            fclose(pf);
            hs_give_to_owner("./plc_host.pid");
        }
    }
#endif
    /* Confirms to the Go supervisor that the FIRST logic module is loaded and
     * bound — handleHotSwapRun polls for this before declaring "started", so
     * a fresh run that can't even bind its initial .so is caught immediately
     * instead of looking like a normal start. */
    write_swap_result("OK", cold_gen, "COLDSTART");

    /* Open the /dev/shm mirror once (host-owned, survives swaps). The editor /
     * agent reads live variables from here by variables.json offset. */
    const char *(*shm_name)(void)   = (const char*(*)(void))plc_dlsym(g_handle, "plc_shm_name");
    unsigned long (*shm_size)(void) = (unsigned long(*)(void))plc_dlsym(g_handle, "plc_shm_size");
    if (shm_name && shm_size) {
        unsigned long sz = shm_size();
#if defined(_WIN32)
        /* Page-file-backed named section: the Windows analogue of a POSIX shm
         * object — no file on disk, visible to the agent by name. The agent
         * OPENS this mapping (it does not create it), so the host must be the
         * creator and must keep the handle for the process lifetime. */
        HANDLE hm = CreateFileMappingA(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE,
                                       0, (DWORD)sz, shm_name());
        if (hm) {
            void *m = MapViewOfFile(hm, FILE_MAP_ALL_ACCESS, 0, 0, (SIZE_T)sz);
            if (m) __plc_shm = (unsigned char *)m;
        }
#elif defined(__APPLE__)
        /* File-backed mirror in the cwd (= the build dir the agent spawned us
         * in), which is exactly where shmmirror_darwin.go looks. See
         * mirror_path() for why macOS cannot use shm_open here. */
        /* 0600, not 0666: the loader-host CREATES this mirror and the agent
         * that spawned it is the only reader/writer, always the same uid. A
         * world-readable mode published every live PLC variable to any other
         * local account for free. */
        int fd = open(mirror_path(shm_name()), O_CREAT | O_RDWR, 0600);
        if (fd >= 0) {
            hs_give_fd_to_owner(fd);   /* privileged run: the agent still reads it */
            if (ftruncate(fd, (off_t)sz) == 0) {
                void *m = mmap(NULL, sz, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
                if (m != MAP_FAILED) __plc_shm = (unsigned char *)m;
            }
            close(fd);
        }
#else
        int fd = shm_open(shm_name(), O_CREAT | O_RDWR, 0600); /* see the mode note above */
        if (fd >= 0) {
            /* ⚠️ Without this the whole live-value stream dies under a
             * privileged run: root creates /dev/shm/<name> 0600 root:root and
             * the agent's open() gets EACCES — the sim looks alive with every
             * variable frozen at zero. */
            hs_give_fd_to_owner(fd);
            if (ftruncate(fd, (off_t)sz) == 0) {
                void *m = mmap(NULL, sz, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
                if (m != MAP_FAILED) __plc_shm = (unsigned char *)m;
            }
            close(fd);
        }
#endif
        printf("[host] shm mirror %s (%lu bytes): %s\n", shm_name(), sz, __plc_shm ? "mapped" : "unavailable");
        fflush(stdout);
    }

    if (sinit) sinit();      /* cold init ONCE */
#if defined(__linux__)
    if (__hs_ec_start) __hs_ec_start();   /* EtherCAT master + bus threads */
#endif
    if (pinit) pinit();      /* PLC_Init (HAL etc.) */

    printf("[host] started: %s  tasks=%d  state=%lu bytes\n", argv[1], g_ntask, ssize());
    fflush(stdout);

    hs_barrier_init(&g_barrier, g_ntask > 0 ? (unsigned)g_ntask : 1);
    pthread_t mon;
    if (getenv("HS_MONITOR")) pthread_create(&mon, NULL, monitor_thread, NULL);
    pthread_t th[MAXT];
    /* Tied to the task threads' lifetime: with no tasks nothing ever sets
     * plc_stop, so an unconditional flusher would hang the join below forever. */
    pthread_t rt; int rt_started = 0;
    if (g_ntask > 0) { pthread_create(&rt, NULL, retain_thread, NULL); rt_started = 1; }
    for (int i = 0; i < g_ntask; i++) pthread_create(&th[i], NULL, task_thread, (void *)(intptr_t)i);
    for (int i = 0; i < g_ntask; i++) pthread_join(th[i], NULL);
    if (rt_started) pthread_join(rt, NULL);
#if defined(__linux__)
    /* After the task joins: plc_stop is set, so the bus loops are already
     * unwinding — this only joins them and closes the master. */
    if (__hs_ec_stop) __hs_ec_stop();
#endif

    /* Final flush on a graceful stop — captures whatever changed since the last
     * periodic write. On a SIGKILL (or a power cut) this never runs, which is
     * exactly why the periodic flush above exists. */
    pthread_mutex_lock(&g_retain_mu);
    if (g_retain_save) g_retain_save();
    pthread_mutex_unlock(&g_retain_mu);
#if !defined(_WIN32)
    remove("./plc_host.pid");
#endif
    return 0;
}
