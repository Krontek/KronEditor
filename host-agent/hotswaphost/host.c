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

static volatile sig_atomic_t g_swap_req = 0;
static pthread_barrier_t     g_barrier;

static void on_usr1(int s) { (void)s; g_swap_req = 1; }

static uint64_t mono_us(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000000ULL + (uint64_t)t.tv_nsec / 1000ULL;
}

/* Resolve the ABI exports from a loaded handle and re-bind the live state.
 * Returns 0 on success. Never calls plc_state_init (state must persist). */
static int resolve_and_bind(void *h) {
    unsigned long (*ssize)(void)        = (unsigned long(*)(void))      dlsym(h, "plc_state_size");
    void          (*bind)(void*)        = (void(*)(void*))             dlsym(h, "plc_bind");
    int           (*tcount)(void)       = (int(*)(void))              dlsym(h, "plc_task_count");
    unsigned long (*tiv)(int)           = (unsigned long(*)(int))     dlsym(h, "plc_task_interval_us");
    if (!ssize || !bind || !tcount || !tiv) return -1;

    int n = tcount();
    if (n < 0 || n > MAXT) return -1;
    for (int i = 0; i < n; i++) {
        char nm[32]; snprintf(nm, sizeof nm, "plc_task_body_%d", i);
        body_fn b = (body_fn)dlsym(h, nm);
        if (!b) return -1;
        g_body[i] = b;
        g_interval[i] = tiv(i);
    }
    g_ntask = n;
    bind(g_state);   /* adopt the SAME arena — preserves all state across swaps */
    return 0;
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

    void *nh = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
    if (!nh) { fprintf(stderr, "[host] swap dlopen failed: %s (keeping current)\n", dlerror()); return; }

    void *old = g_handle;
    g_handle = nh;
    if (resolve_and_bind(nh) != 0) {            /* validate; roll back on failure */
        fprintf(stderr, "[host] swap resolve failed — rolling back\n");
        dlclose(nh);
        g_handle = old;
        resolve_and_bind(old);
        return;
    }
    if (old) dlclose(old);
    printf("[host] >>> HOT-SWAPPED to %s\n", path);
    fflush(stdout);
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

    if (resolve_and_bind(g_handle) != 0) { fprintf(stderr, "resolve failed\n"); return 1; }

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
