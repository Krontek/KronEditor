/*
 * shm_logger.c — sample variables straight out of the runtime's shared memory
 * on the TARGET at a fixed period (default 1000 us) and write them as CSV to
 * stdout.
 *
 * An out-of-band experiment: it maps /dev/shm/<shm-name> READ-ONLY and never
 * writes anything — no REST, no force, no change to the PLC project. It is C,
 * not Python, because the targets are BusyBox systems without an interpreter;
 * motion_control.py cross-compiles it with the bundled clang and copies it over
 * SSH. Offsets are resolved by the caller from variable_table.json.
 *
 * What it can and cannot see:
 *   - The shm MIRROR is refreshed once per scan of the task that owns the
 *     variable (plc_shm_sync). On a 10 ms task a 1 ms log shows each value
 *     ~10 times; sampling faster adds nothing the mirror does not have.
 *   - Every slot is naturally aligned (server/RING_FORMAT.md § Variable
 *     segment) and read with ONE atomic load of its width, like KronServer's
 *     readers, so an LREAL is never torn.
 *   - A period the loop could not keep is counted as "late" and reported on
 *     stderr at the end, never hidden. It asks for SCHED_FIFO priority 10 —
 *     well below the PLC's own threads — and runs without it if refused.
 *
 * Usage:
 *   shm_logger [--shm /dev/shm/plc_runtime] [--period-us 1000]
 *              [--stop-on-stdin-eof] NAME:OFFSET:TYPE ...
 *   TYPE: bool int8 uint8 int16 uint16 int32 uint32 int64 uint64 float32 float64
 *
 * Stops on SIGINT/SIGTERM, or on stdin EOF with --stop-on-stdin-eof (closing
 * the SSH connection ends it, so a dropped link never leaves it running).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define MAX_COLS 32

typedef enum { T_BOOL, T_I8, T_U8, T_I16, T_U16, T_I32, T_U32, T_I64, T_U64, T_F32, T_F64 } col_type;

static const struct { const char *name; col_type type; unsigned size; } TYPES[] = {
    {"bool", T_BOOL, 1}, {"int8", T_I8, 1},   {"uint8", T_U8, 1},
    {"int16", T_I16, 2}, {"uint16", T_U16, 2}, {"int32", T_I32, 4},
    {"uint32", T_U32, 4}, {"int64", T_I64, 8}, {"uint64", T_U64, 8},
    {"float32", T_F32, 4}, {"float64", T_F64, 8},
};

typedef struct { const char *name; size_t off; col_type type; unsigned size; } column;

static volatile sig_atomic_t g_stop;

static void on_signal(int sig) { (void)sig; g_stop = 1; }

static void *watch_stdin(void *arg) {
    (void)arg;
    char buf[256];
    while (read(0, buf, sizeof buf) > 0) {}
    g_stop = 1;
    return NULL;
}

static int64_t now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static void print_value(FILE *out, const uint8_t *base, const column *c) {
    const uint8_t *p = base + c->off;
    switch (c->size) {
    case 1: {
        uint8_t v = __atomic_load_n(p, __ATOMIC_RELAXED);
        if (c->type == T_I8) fprintf(out, "%d", (int8_t)v);
        else fprintf(out, "%u", c->type == T_BOOL ? (v != 0) : v);
        break;
    }
    case 2: {
        uint16_t v = __atomic_load_n((const uint16_t *)p, __ATOMIC_RELAXED);
        if (c->type == T_I16) fprintf(out, "%d", (int16_t)v);
        else fprintf(out, "%u", v);
        break;
    }
    case 4: {
        uint32_t v = __atomic_load_n((const uint32_t *)p, __ATOMIC_RELAXED);
        if (c->type == T_F32) { float f; memcpy(&f, &v, 4); fprintf(out, "%.9g", f); }
        else if (c->type == T_I32) fprintf(out, "%d", (int32_t)v);
        else fprintf(out, "%u", v);
        break;
    }
    default: {
        uint64_t v = __atomic_load_n((const uint64_t *)p, __ATOMIC_RELAXED);
        if (c->type == T_F64) { double d; memcpy(&d, &v, 8); fprintf(out, "%.17g", d); }
        else if (c->type == T_I64) fprintf(out, "%lld", (long long)(int64_t)v);
        else fprintf(out, "%llu", (unsigned long long)v);
        break;
    }
    }
}

static int parse_column(char *spec, column *c) {
    char *a = strchr(spec, ':');
    char *b = a ? strchr(a + 1, ':') : NULL;
    if (!a || !b) return -1;
    *a = *b = '\0';
    c->name = spec;
    char *end;
    c->off = strtoul(a + 1, &end, 10);
    if (*end) return -1;
    for (size_t i = 0; i < sizeof TYPES / sizeof TYPES[0]; i++) {
        if (strcmp(TYPES[i].name, b + 1) == 0) {
            c->type = TYPES[i].type;
            c->size = TYPES[i].size;
            return c->off % c->size == 0 ? 0 : -2;   /* atomic load needs alignment */
        }
    }
    return -1;
}

int main(int argc, char **argv) {
    const char *shm = "/dev/shm/plc_runtime";
    long period_us = 1000;
    int stdin_eof = 0;
    column cols[MAX_COLS];
    int ncols = 0;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--shm") && i + 1 < argc) shm = argv[++i];
        else if (!strcmp(argv[i], "--period-us") && i + 1 < argc) period_us = atol(argv[++i]);
        else if (!strcmp(argv[i], "--stop-on-stdin-eof")) stdin_eof = 1;
        else if (ncols < MAX_COLS) {
            int r = parse_column(argv[i], &cols[ncols]);
            if (r) {
                fprintf(stderr, "shm_logger: bad column '%s'%s\n", argv[i],
                        r == -2 ? " (offset not aligned to its size)" : " (want NAME:OFFSET:TYPE)");
                return 2;
            }
            ncols++;
        }
    }
    if (ncols == 0 || period_us <= 0) {
        fprintf(stderr, "usage: shm_logger [--shm PATH] [--period-us N] [--stop-on-stdin-eof] NAME:OFFSET:TYPE ...\n");
        return 2;
    }

    int fd = open(shm, O_RDONLY);
    if (fd < 0) { fprintf(stderr, "shm_logger: open %s: %s\n", shm, strerror(errno)); return 1; }
    struct stat st;
    if (fstat(fd, &st) < 0) { fprintf(stderr, "shm_logger: stat %s: %s\n", shm, strerror(errno)); return 1; }
    for (int i = 0; i < ncols; i++) {
        if (cols[i].off + cols[i].size > (size_t)st.st_size) {
            fprintf(stderr, "shm_logger: %s at %zu lies outside %s (%lld bytes)\n",
                    cols[i].name, cols[i].off, shm, (long long)st.st_size);
            return 1;
        }
    }
    const uint8_t *base = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_SHARED, fd, 0);
    if (base == MAP_FAILED) { fprintf(stderr, "shm_logger: mmap: %s\n", strerror(errno)); return 1; }

    struct sigaction sa = {0};
    sa.sa_handler = on_signal;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);
    if (stdin_eof) {
        pthread_t t;
        pthread_create(&t, NULL, watch_stdin, NULL);
        pthread_detach(t);
    }
    struct sched_param sp = { .sched_priority = 10 };
    int rt = pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp) == 0;

    static char obuf[1 << 16];
    setvbuf(stdout, obuf, _IOFBF, sizeof obuf);
    fputs("t_us", stdout);
    for (int i = 0; i < ncols; i++) printf(",%s", cols[i].name);
    fputc('\n', stdout);

    const int64_t period_ns = (int64_t)period_us * 1000;
    const int64_t t0 = now_ns();
    int64_t deadline = t0, prev = -1, max_gap = 0;
    unsigned long long samples = 0, late = 0;
    while (!g_stop) {
        int64_t t = now_ns();
        if (prev >= 0 && t - prev > max_gap) max_gap = t - prev;
        prev = t;
        printf("%lld", (long long)((t - t0) / 1000));
        for (int i = 0; i < ncols; i++) {
            fputc(',', stdout);
            print_value(stdout, base, &cols[i]);
        }
        fputc('\n', stdout);
        if (++samples % 100 == 0 && (fflush(stdout) == EOF)) break;   /* reader gone */

        deadline += period_ns;
        if (deadline <= now_ns()) {
            /* Missed the slot: count it and re-anchor instead of bursting to
             * catch up (a burst would log the same mirror value back to back). */
            late++;
            deadline = now_ns();
            continue;
        }
        struct timespec ts = { (time_t)(deadline / 1000000000LL), (long)(deadline % 1000000000LL) };
        while (clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &ts, NULL) == EINTR && !g_stop) {}
    }
    fflush(stdout);
    double dur = (double)(now_ns() - t0) / 1e9;
    fprintf(stderr, "shm_logger: %llu samples in %.2f s (%.0f/s), %llu late, max gap %.2f ms%s\n",
            samples, dur, dur > 0 ? samples / dur : 0.0, late, (double)max_gap / 1e6,
            rt ? "" : ", no SCHED_FIFO");
    return 0;
}
