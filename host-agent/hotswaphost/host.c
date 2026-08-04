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
 * The scan engine, the barrier, the generation/ping-pong logic and the swap
 * protocol are IDENTICAL on both platforms; only four primitives differ:
 *
 *      shared memory   shm_open+ftruncate+mmap  |  CreateFileMapping+MapViewOfFile
 *      dynamic load    dlopen/dlsym/dlclose     |  LoadLibrary/GetProcAddress/FreeLibrary
 *      swap signal     SIGUSR1                  |  named auto-reset Event
 *      module suffix   (none — path is given)   |  (none — path is given)
 *
 * pthreads and clock_gettime come from winpthreads (link -lwinpthread), so the
 * barrier and the scan structure have ONE implementation. Keep it that way —
 * the barrier/scan logic is the part that must not diverge. The ONE timing
 * primitive that had to differ is the sleep-until-deadline (see
 * plc_sleep_until: winpthreads' clock_nanosleep does not honour
 * TIMER_ABSTIME and returns immediately).
 *
 * ⚠️ Windows keeps a LOADED module's file locked, so a slot cannot be
 * overwritten while it is live. The 2-slot ping-pong already guarantees we only
 * ever write the slot that is NOT loaded, and CleanupExcept only deletes the
 * other slot after a confirmed OK (i.e. after FreeLibrary) — so the scheme
 * needs no Windows-specific change. Do not "simplify" it to a single slot.
 * -------------------------------------------------------------------------*/
#if defined(_WIN32)
#include <windows.h>
#define PLC_SWAP_EVENT_NAME "Local\\kron_plc_swap"
typedef HMODULE plc_module_t;
static plc_module_t plc_dlopen(const char *p)              { return LoadLibraryA(p); }
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
typedef void *plc_module_t;
static plc_module_t plc_dlopen(const char *p)              { return dlopen(p, RTLD_NOW | RTLD_GLOBAL); }
static void        *plc_dlsym(plc_module_t h, const char *n) { return dlsym(h, n); }
static void         plc_dlclose(plc_module_t h)            { if (h) dlclose(h); }
static const char  *plc_dlerror(void)                      { return dlerror(); }
static void plc_sleep_until(const struct timespec *deadline) {
    clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, deadline, NULL);
}
#endif

volatile uint64_t us_tick = 0;   /* owned + exported for the logic.so */
volatile int plc_stop = 0;
/* The /dev/shm mirror (force flags + monitored values). Host-owned so it
 * survives a logic swap → the editor keeps reading live variables. The logic
 * .so references this (extern) in its plc_shm_pull/sync. */
unsigned char *__plc_shm = NULL;

#define MAXT 16
typedef void (*body_fn)(void);

static plc_module_t   g_handle;
static void          *g_state;
static body_fn        g_body[MAXT];
static unsigned long  g_interval[MAXT];
static int            g_ntask;

/* The layout hash of the FIRST successfully bound .so (cold start). Every
 * later swap is checked against THIS reference, never the previous swap's —
 * so a chain of small "compatible" edits cannot drift into an undetected
 * incompatibility one swap at a time. */
static unsigned long long g_layout_hash = 0;
static int                g_layout_hash_set = 0;

static volatile int      g_swap_req = 0;
static pthread_barrier_t g_barrier;

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
#endif

static uint64_t mono_us(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000000ULL + (uint64_t)t.tv_nsec / 1000ULL;
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
#endif
}

#define RB_OK            0
#define RB_ERR_SYMBOL    1   /* a required export is missing (old/incompatible build) */
#define RB_ERR_TASKCOUNT 2   /* plc_task_count() out of range */
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
    unsigned long long (*lhash)(void)   = (unsigned long long(*)(void)) plc_dlsym(h, "plc_state_layout_hash");
    if (!ssize || !bind || !tcount || !tiv || !lhash) return RB_ERR_SYMBOL;

    /* Hard safety net: refuse a layout-incompatible swap BEFORE touching
     * g_body/g_ntask/the state arena. Skipped only on the very first bind
     * (nothing to compare against yet — that bind itself becomes the
     * reference, set by the caller once this returns RB_OK). */
    if (g_layout_hash_set && lhash() != g_layout_hash) return RB_ERR_LAYOUT;

    int n = tcount();
    if (n < 0 || n > MAXT) return RB_ERR_TASKCOUNT;
    for (int i = 0; i < n; i++) {
        char nm[32]; snprintf(nm, sizeof nm, "plc_task_body_%d", i);
        body_fn b = (body_fn)plc_dlsym(h, nm);
        if (!b) return RB_ERR_SYMBOL;
        g_body[i] = b;
        g_interval[i] = tiv(i);
    }
    g_ntask = n;
    bind(g_state);   /* adopt the SAME arena — preserves all state across swaps */
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
static void do_swap(void) {
    char path[512] = {0};
    /* stdio rather than open()/read(): the request is one short line, and this
     * is the only file read in the loader — keeping it portable avoids an
     * fcntl.h dependency on Windows. */
    FILE *rf = fopen("./swap_request", "rb");
    if (rf) {
        size_t n = fread(path, 1, sizeof path - 1, rf);
        path[n] = 0;
        while (n && (path[n-1] == '\n' || path[n-1] == '\r' || path[n-1] == ' ' || path[n-1] == '\t')) path[--n] = 0;
        fclose(rf);
    }
    if (!path[0]) return;
    int gen = parse_gen_from_path(path);

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
    struct timespec next; clock_gettime(CLOCK_MONOTONIC, &next);
    while (!plc_stop) {
        /* ⚠️ Accumulate the period in 64-bit and split it into whole seconds +
         * remainder BEFORE touching tv_nsec. `long` (and mingw's tv_nsec) is
         * 32 BITS on Windows, so the old `next.tv_nsec += (long)(interval_us *
         * 1000UL)` overflowed for any interval >= ~2.148 s: T#3s produced
         * -1294967296, pushing the deadline BACKWARD, so plc_sleep_until saw
         * delta_ns <= 0, never slept, and the task ran flat out. Measured on
         * Windows: (long)(3000000 * 1000UL) == -1294967296. */
        long long period_ns = (long long)g_interval[idx] * 1000LL;
        next.tv_sec  += (time_t)(period_ns / 1000000000LL);
        next.tv_nsec += (long)(period_ns % 1000000000LL);
        while (next.tv_nsec >= 1000000000L) { next.tv_sec++; next.tv_nsec -= 1000000000L; }

        /* Scan-boundary swap: every thread gathers, thread 0 swaps + clears the
         * request, then all resume against the new (or rolled-back) logic. */
        if (g_swap_req) {
            pthread_barrier_wait(&g_barrier);
            if (idx == 0) { do_swap(); g_swap_req = 0; }
            pthread_barrier_wait(&g_barrier);
        }

        us_tick = mono_us();
        if (g_body[idx]) g_body[idx]();

        plc_sleep_until(&next);
    }
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s logic.so\n", argv[0]); return 1; }
#if defined(_WIN32)
    /* Auto-reset named event; created here (not by the agent) so the agent's
     * OpenEvent succeeds only once the host is genuinely up. */
    g_swap_event = CreateEventA(NULL, FALSE, FALSE, PLC_SWAP_EVENT_NAME);
    if (!g_swap_event) { fprintf(stderr, "CreateEvent: %s\n", plc_dlerror()); return 1; }
    { pthread_t t; pthread_create(&t, NULL, swap_event_thread, NULL); pthread_detach(t); }
#else
    signal(SIGUSR1, on_usr1);
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
#else
        int fd = shm_open(shm_name(), O_CREAT | O_RDWR, 0666);
        if (fd >= 0) {
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
    if (pinit) pinit();      /* PLC_Init (HAL etc.) */

    printf("[host] started: %s  tasks=%d  state=%lu bytes\n", argv[1], g_ntask, ssize());
    fflush(stdout);

    pthread_barrier_init(&g_barrier, NULL, g_ntask > 0 ? g_ntask : 1);
    pthread_t mon;
    if (getenv("HS_MONITOR")) pthread_create(&mon, NULL, monitor_thread, NULL);
    pthread_t th[MAXT];
    for (int i = 0; i < g_ntask; i++) pthread_create(&th[i], NULL, task_thread, (void *)(intptr_t)i);
    for (int i = 0; i < g_ntask; i++) pthread_join(th[i], NULL);
    return 0;
}
