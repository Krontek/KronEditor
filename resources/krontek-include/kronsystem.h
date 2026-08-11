#ifndef KRONSYSTEM_H
#define KRONSYSTEM_H

/*===========================================================================
 * kronsystem.h  --  System / RTC function blocks (SYSTEM library category)
 *
 * HEADER-ONLY ON PURPOSE. Every other standard block is declared here and
 * implemented in a prebuilt libkron*.a, but those archives are built outside
 * this repo. A block whose only implementation lives in an archive cannot be
 * added without a library rebuild, so the blocks in this file are `static
 * inline` and compile straight into plc.c / logic.so.
 *
 * ⚠️ Every kron*.h in this directory is scanned by the transpiler
 * (CTranspilerService.js, transpileToC): each `<Type>_Call(<Type> *inst)` it
 * finds registers <Type> as a function block. Two consequences:
 *   - a struct pointer as the FIRST parameter is what marks it as an FB;
 *   - the parameter list must not contain the literal text "TIME", or the
 *     block is classified as a timer and called as `_Call(&inst, us_tick)`.
 *     (`Read_System_Time` is mixed case, so it does not collide.)
 *
 * Dependencies: stdbool.h, stdint.h, time.h only.
 *===========================================================================*/

#include <stdbool.h>
#include <stdint.h>
#include <time.h>

/* ── Read_System_Time ─────────────────────────────────────────────────────
 * Reads the real-time clock (CLOCK_REALTIME, i.e. the OS wall clock — on a
 * target board that is whatever NTP/the hardware RTC has set).
 *
 * TIME is MILLISECONDS SINCE LOCAL MIDNIGHT: 0 .. 86_399_999, the IEC
 * TIME_OF_DAY reading. It is deliberately not milliseconds since the epoch —
 * that is ~1.7e12 today and does not fit the DINT this pin is declared as.
 * Use an IEC timer (TON/TONR) for elapsed-time measurement; this block is a
 * clock, not a stopwatch, and it steps backwards at midnight and on any NTP
 * correction or DST change.
 *
 * EN gates the read (level, not edge); ENO echoes EN. While EN is false the
 * previous TIME value is held.
 */
typedef struct {
    int32_t TIME;   /* ms since local midnight, 0..86399999   (output) */
    bool    EN;     /* enable — power flow                    (input)  */
    bool    ENO;    /* echoes EN                              (output) */
} Read_System_Time;

static inline void Read_System_Time_Call(Read_System_Time *inst)
{
    inst->ENO = inst->EN;
    if (!inst->EN) return;

    /* glibc's localtime_r is not required to read TZ itself, so prime the
     * timezone once. The flag resets when a hot-swapped logic.so is reloaded,
     * which only costs one extra tzset(). */
    static bool tz_ready = false;
    if (!tz_ready) { tzset(); tz_ready = true; }

    struct timespec ts;
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return;  /* hold last value */

    /* Reentrant conversion only: several task threads may call this in the
     * same scan, and plain localtime() returns a shared static buffer. */
    time_t secs = (time_t)ts.tv_sec;
    struct tm lt;
#if defined(_WIN32)
    if (localtime_s(&lt, &secs) != 0) return;
#else
    if (localtime_r(&secs, &lt) == NULL) return;
#endif

    inst->TIME = (int32_t)((((long)lt.tm_hour * 3600L)
                            + ((long)lt.tm_min * 60L)
                            + (long)lt.tm_sec) * 1000L
                           + (long)(ts.tv_nsec / 1000000L));
}

#endif /* KRONSYSTEM_H */
