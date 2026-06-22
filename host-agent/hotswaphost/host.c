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
#include <dlfcn.h>
#include <signal.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>

volatile uint64_t us_tick = 0;   /* owned + exported for the logic.so */
volatile int plc_stop = 0;
/* The /dev/shm mirror (force flags + monitored values). Host-owned so it
 * survives a logic swap → the editor keeps reading live variables. The logic
 * .so references this (extern) in its plc_shm_pull/sync. */
unsigned char *__plc_shm = NULL;

#define MAXT 16
typedef void (*body_fn)(void);

static void          *g_handle;
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

static volatile sig_atomic_t g_swap_req = 0;
static pthread_barrier_t     g_barrier;

static void on_usr1(int s) { (void)s; g_swap_req = 1; }

static uint64_t mono_us(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000000ULL + (uint64_t)t.tv_nsec / 1000ULL;
}

/* Parses the generation number out of a "<dir>/logic_<N>.so" path. Returns -1
 * if the basename doesn't match that pattern (defensive — should never
 * happen since we only ever write paths we generated ourselves). */
static int parse_gen_from_path(const char *path) {
    const char *base = strrchr(path, '/');
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
    rename("./swap_result.tmp", "./swap_result");
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
    unsigned long (*ssize)(void)        = (unsigned long(*)(void))      dlsym(h, "plc_state_size");
    void          (*bind)(void*)        = (void(*)(void*))             dlsym(h, "plc_bind");
    int           (*tcount)(void)       = (int(*)(void))              dlsym(h, "plc_task_count");
    unsigned long (*tiv)(int)           = (unsigned long(*)(int))     dlsym(h, "plc_task_interval_us");
    unsigned long long (*lhash)(void)   = (unsigned long long(*)(void)) dlsym(h, "plc_state_layout_hash");
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
        body_fn b = (body_fn)dlsym(h, nm);
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
    int fd = open("./swap_request", O_RDONLY);
    if (fd >= 0) {
        ssize_t n = read(fd, path, sizeof path - 1);
        if (n > 0) { while (n && (path[n-1] == '\n' || path[n-1] == ' ' || path[n-1] == '\t')) path[--n] = 0; }
        close(fd);
    }
    if (!path[0]) return;
    int gen = parse_gen_from_path(path);

    void *nh = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
    if (!nh) {
        fprintf(stderr, "[host] swap dlopen failed: %s (keeping current)\n", dlerror());
        write_swap_result("FAIL", gen, "DLOPEN");
        return;
    }

    void *old = g_handle;
    g_handle = nh;
    int rc = resolve_and_bind(nh);
    if (rc != RB_OK) {            /* validate; roll back on failure */
        const char *reason = rb_reason(rc);
        fprintf(stderr, "[host] swap resolve failed (%s) — rolling back\n", reason);
        dlclose(nh);
        g_handle = old;
        resolve_and_bind(old);    /* old already satisfied the layout check once; this re-bind cannot itself fail on RB_ERR_LAYOUT */
        write_swap_result("FAIL", gen, reason);
        return;
    }
    if (old) dlclose(old);
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
        struct timespec s = { .tv_sec = 0, .tv_nsec = 500 * 1000 * 1000 };
        nanosleep(&s, NULL);
    }
    return NULL;
}

static void *task_thread(void *arg) {
    int idx = (int)(intptr_t)arg;
    struct timespec next; clock_gettime(CLOCK_MONOTONIC, &next);
    while (!plc_stop) {
        next.tv_nsec += (long)(g_interval[idx] * 1000UL);
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

        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, NULL);
    }
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s logic.so\n", argv[0]); return 1; }
    signal(SIGUSR1, on_usr1);

    g_handle = dlopen(argv[1], RTLD_NOW | RTLD_GLOBAL);
    if (!g_handle) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }

    unsigned long (*ssize)(void) = (unsigned long(*)(void))dlsym(g_handle, "plc_state_size");
    void (*sinit)(void)          = (void(*)(void))dlsym(g_handle, "plc_state_init");
    void (*pinit)(void)          = (void(*)(void))dlsym(g_handle, "plc_init_hs");
    if (!ssize) { fprintf(stderr, "missing plc_state_size\n"); return 1; }

    g_state = calloc(1, ssize());
    if (!g_state) { fprintf(stderr, "state calloc failed\n"); return 1; }

    int rc0 = resolve_and_bind(g_handle);
    if (rc0 != RB_OK) {
        fprintf(stderr, "resolve failed (%s)\n", rb_reason(rc0));
        write_swap_result("FAIL", parse_gen_from_path(argv[1]), rb_reason(rc0));
        return 1;
    }
    /* Confirms to the Go supervisor that the FIRST logic module is loaded and
     * bound — handleHotSwapRun polls for this before declaring "started", so
     * a fresh run that can't even bind its initial .so is caught immediately
     * instead of looking like a normal start. */
    write_swap_result("OK", parse_gen_from_path(argv[1]), "COLDSTART");

    /* Open the /dev/shm mirror once (host-owned, survives swaps). The editor /
     * agent reads live variables from here by variables.json offset. */
    const char *(*shm_name)(void)   = (const char*(*)(void))dlsym(g_handle, "plc_shm_name");
    unsigned long (*shm_size)(void) = (unsigned long(*)(void))dlsym(g_handle, "plc_shm_size");
    if (shm_name && shm_size) {
        int fd = shm_open(shm_name(), O_CREAT | O_RDWR, 0666);
        if (fd >= 0) {
            unsigned long sz = shm_size();
            if (ftruncate(fd, (off_t)sz) == 0) {
                void *m = mmap(NULL, sz, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
                if (m != MAP_FAILED) __plc_shm = (unsigned char *)m;
            }
            close(fd);
        }
        printf("[host] shm mirror %s (%lu bytes): %s\n", shm_name(), shm_size(), __plc_shm ? "mapped" : "unavailable");
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
