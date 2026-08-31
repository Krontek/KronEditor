#ifndef KRONSYSTEM_H
#define KRONSYSTEM_H

/*===========================================================================
 * kronsystem.h  --  System / RTC / scheduling function blocks
 *                   (SYSTEM and part of the TIMERS library category)
 *
 * HEADER-ONLY ON PURPOSE. Every other standard block is declared here and
 * implemented in a prebuilt libkron*.a, but those archives are built outside
 * this repo. A block whose only implementation lives in an archive cannot be
 * added without a library rebuild, so the blocks in this file are `static
 * inline` and compile straight into plc.c / logic.so.
 *
 * ⚠️ Every kron*.h in this directory is scanned by the transpiler
 * (CTranspilerService.js, transpileToC): each `<Type>_Call(<Type> *inst)` it
 * finds registers <Type> as a function block. Three consequences:
 *   - a struct pointer as the FIRST parameter is what marks it as an FB;
 *   - the parameter list must not contain the literal text "TIME", or the
 *     block is classified as a timer and called with a second tick argument.
 *     The check is case-SENSITIVE, which is why every type here spells it
 *     "Time"/"_T" (Read_System_Time, Cycle_Time_Monitor, Add_T, …). A type
 *     named TIME_SWITCH or ADD_TIME would not compile;
 *   - the scan reads the raw text, comments included, so a call-shaped phrase
 *     written in prose here registers a junk block type. Refer to the pattern
 *     as "<Type> underscore Call", never spelled out with its parentheses.
 *
 * ⚠️ NO NON-ZERO INITIALISERS. An FB instance is a field of PlcState and is
 * zero-filled at cold start; plc_state_init() only writes initials for
 * DECLARED variables, never for struct members. Any block needing a "not yet
 * started" state therefore carries a `__primed` bool (false = unprimed)
 * instead of encoding it as a sentinel value such as -1.
 *
 * ⚠️ TIMEBASE. These blocks read CLOCK_MONOTONIC directly rather than the
 * global `us_tick`, for two reasons: the transpiler emits
 * `extern volatile uint64_t us_tick;` AFTER the #include of this header, so
 * the symbol is not visible here; and its origin differs per platform (since
 * boot on Linux, since process start on Windows). Reading the clock in the
 * block also makes the value exact per task thread — every task thread writes
 * the shared us_tick just before its own body, so on a multi-task project a
 * us_tick read can belong to another thread's scan.
 *
 * Dependencies: stdbool.h, stdint.h, stdio.h, string.h, math.h, time.h, and
 * sys/statvfs.h on POSIX only.
 *===========================================================================*/

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <time.h>

#if defined(__linux__) || defined(__APPLE__)
#include <sys/statvfs.h>
#endif

/* Error codes follow the HAL convention (see HAL/kronhal.h):
 * 0 = OK, 1 = not available on this platform / absent, 2 = open failed,
 * 3 = I/O or parse error. A block that cannot do its job must report one of
 * these and leave its outputs at zero — never fake a plausible reading. */
#define KRON_SYS_OK        0
#define KRON_SYS_ABSENT    1
#define KRON_SYS_OPENFAIL  2
#define KRON_SYS_IOERR     3

/* Host-metric blocks (temperature, load, disk) open and parse a file on every
 * call. At a 1 ms task that would dominate the scan, so each caches its
 * reading for this long. */
#define KRON_SYS_POLL_US   1000000ULL

/* ── Shared helpers ─────────────────────────────────────────────────────── */

/* Monotonic microseconds. See the TIMEBASE note above for why this is not
 * us_tick. Returns 0 if the clock is unavailable, which the callers treat as
 * "time did not advance" rather than as a jump. */
static inline uint64_t __kron_mono_us(void)
{
    struct timespec ts;
#if defined(CLOCK_MONOTONIC)
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
#else
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return 0;
#endif
    return (uint64_t)ts.tv_sec * 1000000ULL + (uint64_t)(ts.tv_nsec / 1000L);
}

/* Reentrant calendar conversion only: several task threads may convert in the
 * same scan, and plain localtime()/gmtime() return a shared static buffer. */
static inline bool __kron_localtime(time_t t, struct tm *out)
{
#if defined(_WIN32)
    return localtime_s(out, &t) == 0;
#else
    return localtime_r(&t, out) != NULL;
#endif
}

static inline bool __kron_gmtime(time_t t, struct tm *out)
{
#if defined(_WIN32)
    return gmtime_s(out, &t) == 0;
#else
    return gmtime_r(&t, out) != NULL;
#endif
}

/* glibc's localtime_r is not required to read TZ itself, so prime the timezone
 * once. The flag resets when a hot-swapped logic.so is reloaded, which only
 * costs one extra tzset(). */
static inline void __kron_tz_prime(void)
{
    static bool tz_ready = false;
    if (!tz_ready) { tzset(); tz_ready = true; }
}

/* Wall clock as epoch seconds + milliseconds. false = clock unavailable. */
static inline bool __kron_wall(time_t *sec, uint16_t *ms)
{
    struct timespec ts;
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return false;
    *sec = (time_t)ts.tv_sec;
    *ms  = (uint16_t)(ts.tv_nsec / 1000000L);
    return true;
}

/* ISO-8601 weekday: 1 = Monday … 7 = Sunday (struct tm uses 0 = Sunday). */
static inline uint8_t __kron_iso_wday(const struct tm *lt)
{
    return (uint8_t)(lt->tm_wday == 0 ? 7 : lt->tm_wday);
}

/* Minutes east of UTC at time t, DST included. struct tm's tm_gmtoff is a
 * glibc/BSD extension absent on Windows, so this differences the local and UTC
 * conversions instead of reading it. */
static inline int __kron_utc_offset_min(time_t t)
{
    struct tm lt, gt;
    int diff, dday;
    if (!__kron_localtime(t, &lt) || !__kron_gmtime(t, &gt)) return 0;
    diff = (lt.tm_hour * 60 + lt.tm_min) - (gt.tm_hour * 60 + gt.tm_min);
    dday = lt.tm_yday - gt.tm_yday;
    if (lt.tm_year != gt.tm_year) dday = (lt.tm_year > gt.tm_year) ? 1 : -1;
    return diff + dday * 1440;
}

/* Seconds since local midnight, from an already-converted struct tm. */
static inline int32_t __kron_sec_of_day(const struct tm *lt)
{
    return (int32_t)(lt->tm_hour * 3600 + lt->tm_min * 60 + lt->tm_sec);
}

/*===========================================================================
 * 1. Real-time clock / calendar
 *===========================================================================*/

/* ── Read_System_Time ─────────────────────────────────────────────────────
 * Reads the real-time clock (CLOCK_REALTIME, i.e. the OS wall clock — on a
 * target board that is whatever NTP/the hardware RTC has set).
 *
 * TIME is MILLISECONDS SINCE LOCAL MIDNIGHT: 0 .. 86_399_999, the IEC
 * TIME_OF_DAY reading. It is deliberately not milliseconds since the epoch —
 * that is ~1.7e12 today and does not fit the DINT this pin is declared as.
 * Use Read_Epoch_Time for an absolute timestamp, and an IEC timer (TON/TONR)
 * for elapsed-time measurement; this block is a clock, not a stopwatch, and it
 * steps backwards at midnight and on any NTP correction or DST change.
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
    time_t   secs;
    uint16_t ms;
    struct tm lt;

    inst->ENO = inst->EN;
    if (!inst->EN) return;

    __kron_tz_prime();
    if (!__kron_wall(&secs, &ms)) return;              /* hold last value */
    if (!__kron_localtime(secs, &lt)) return;

    inst->TIME = __kron_sec_of_day(&lt) * 1000 + (int32_t)ms;
}

/* ── Read_System_Date ─────────────────────────────────────────────────────
 * The calendar half of Read_System_Time. Reported in LOCAL time, so the two
 * blocks always describe the same instant.
 *
 * There is no IEC DATE type in this toolchain, so the date is published as
 * separate numeric pins rather than a packed value.
 * Weekday is ISO-8601: 1 = Monday … 7 = Sunday.
 */
typedef struct {
    int16_t  Year;       /* e.g. 2026                              (output) */
    uint8_t  Month;      /* 1..12                                  (output) */
    uint8_t  Day;        /* 1..31                                  (output) */
    uint8_t  Weekday;    /* 1 = Monday … 7 = Sunday                (output) */
    uint16_t DayOfYear;  /* 1..366                                 (output) */
    bool     EN;         /* enable — power flow                    (input)  */
    bool     ENO;        /* echoes EN                              (output) */
} Read_System_Date;

static inline void Read_System_Date_Call(Read_System_Date *inst)
{
    time_t   secs;
    uint16_t ms;
    struct tm lt;

    inst->ENO = inst->EN;
    if (!inst->EN) return;

    __kron_tz_prime();
    if (!__kron_wall(&secs, &ms)) return;
    if (!__kron_localtime(secs, &lt)) return;

    inst->Year      = (int16_t)(lt.tm_year + 1900);
    inst->Month     = (uint8_t)(lt.tm_mon + 1);
    inst->Day       = (uint8_t)lt.tm_mday;
    inst->Weekday   = __kron_iso_wday(&lt);
    inst->DayOfYear = (uint16_t)(lt.tm_yday + 1);
}

/* ── Read_Epoch_Time ──────────────────────────────────────────────────────
 * Absolute UTC timestamp: seconds since 1970-01-01, plus the millisecond part
 * and the local UTC offset. This is the block to use when a value has to be
 * correlated across machines or stored in a log — Read_System_Time's
 * midnight-relative reading cannot express a date.
 *
 * ⚠️ SEC is a UDINT and therefore runs out on 2106-02-07. That is deliberate:
 * a DINT would have overflowed in 2038 and there is no unsigned-64 pin type
 * that the HMI/REST layer renders usefully. For arithmetic past 2106, feed
 * SEC into a LINT variable first.
 */
typedef struct {
    uint32_t SEC;         /* Unix epoch seconds, UTC                (output) */
    uint16_t MS;          /* 0..999                                 (output) */
    int16_t  UTC_Offset;  /* minutes east of UTC, DST included      (output) */
    bool     EN;          /* enable — power flow                    (input)  */
    bool     ENO;         /* echoes EN                              (output) */
} Read_Epoch_Time;

static inline void Read_Epoch_Time_Call(Read_Epoch_Time *inst)
{
    time_t   secs;
    uint16_t ms;

    inst->ENO = inst->EN;
    if (!inst->EN) return;

    __kron_tz_prime();
    if (!__kron_wall(&secs, &ms)) return;

    inst->SEC        = (uint32_t)secs;
    inst->MS         = ms;
    inst->UTC_Offset = (int16_t)__kron_utc_offset_min(secs);
}

/* ── Epoch_To_Date ────────────────────────────────────────────────────────
 * Breaks an absolute timestamp into calendar fields. Pure computation — it
 * never reads the clock, so it also decodes timestamps that arrived from
 * somewhere else (a logged sample, the capture ring, a fieldbus master).
 *
 * LOCAL selects the conversion: true = local time (DST applied), false = UTC.
 */
typedef struct {
    int64_t  EPOCH_MS;     /* milliseconds since 1970-01-01 UTC      (input)  */
    bool     LOCAL;        /* true = local time, false = UTC         (input)  */
    int16_t  Year;         /*                                        (output) */
    uint8_t  Month;        /* 1..12                                  (output) */
    uint8_t  Day;          /* 1..31                                  (output) */
    uint8_t  Hour;         /* 0..23                                  (output) */
    uint8_t  Minute;       /* 0..59                                  (output) */
    uint8_t  Second;       /* 0..60 (60 on a leap second)            (output) */
    uint16_t Millisecond;  /* 0..999                                 (output) */
    uint8_t  Weekday;      /* 1 = Monday … 7 = Sunday                (output) */
    bool     EN;           /* enable — power flow                    (input)  */
    bool     ENO;          /* echoes EN                              (output) */
} Epoch_To_Date;

static inline void Epoch_To_Date_Call(Epoch_To_Date *inst)
{
    int64_t   secs;
    int32_t   rem;
    struct tm t;

    inst->ENO = inst->EN;
    if (!inst->EN) return;

    __kron_tz_prime();

    /* C integer division truncates toward zero, so a pre-1970 timestamp would
     * land on the wrong side of the second. Floor it explicitly. */
    secs = inst->EPOCH_MS / 1000;
    rem  = (int32_t)(inst->EPOCH_MS % 1000);
    if (rem < 0) { rem += 1000; secs -= 1; }

    if (inst->LOCAL) { if (!__kron_localtime((time_t)secs, &t)) return; }
    else             { if (!__kron_gmtime((time_t)secs, &t))    return; }

    inst->Year        = (int16_t)(t.tm_year + 1900);
    inst->Month       = (uint8_t)(t.tm_mon + 1);
    inst->Day         = (uint8_t)t.tm_mday;
    inst->Hour        = (uint8_t)t.tm_hour;
    inst->Minute      = (uint8_t)t.tm_min;
    inst->Second      = (uint8_t)t.tm_sec;
    inst->Millisecond = (uint16_t)rem;
    inst->Weekday     = __kron_iso_wday(&t);
}

/*===========================================================================
 * 2. Clock-driven scheduling
 *===========================================================================*/

/* ── Time_Switch ──────────────────────────────────────────────────────────
 * Weekly time switch: Q is true between ON_H:ON_M and OFF_H:OFF_M on the days
 * selected by the DAYS bit mask.
 *
 *   DAYS  bit0 = Monday, bit1 = Tuesday … bit6 = Sunday.
 *         127 (16#7F) = every day, 31 = Mon–Fri, 96 = weekend, 0 = never.
 *
 * A window whose OFF time is earlier than its ON time wraps past midnight
 * (22:00 → 06:00). The day mask is then evaluated against the day the window
 * STARTED, so a Friday-only 22:00→06:00 window stays on until Saturday 06:00.
 *
 * The window is half-open, [ON, OFF): an ON of 08:00 and an OFF of 08:00 is a
 * zero-length window and Q never goes true. Resolution is one minute; use TON
 * downstream if a finer edge is needed.
 */
typedef struct {
    uint8_t ON_H;    /* 0..23                                    (input)  */
    uint8_t ON_M;    /* 0..59                                    (input)  */
    uint8_t OFF_H;   /* 0..23                                    (input)  */
    uint8_t OFF_M;   /* 0..59                                    (input)  */
    uint8_t DAYS;    /* weekday bit mask, bit0 = Monday          (input)  */
    bool    Q;       /* inside the window                        (output) */
    bool    EN;      /* enable — power flow                      (input)  */
    bool    ENO;     /* echoes EN                                (output) */
} Time_Switch;

static inline void Time_Switch_Call(Time_Switch *inst)
{
    time_t   secs;
    uint16_t ms;
    struct tm lt;
    int on, off, now, wd, prev_wd;

    inst->ENO = inst->EN;
    if (!inst->EN) { inst->Q = false; return; }

    __kron_tz_prime();
    if (!__kron_wall(&secs, &ms)) return;              /* hold last value */
    if (!__kron_localtime(secs, &lt)) return;

    on  = (int)inst->ON_H  * 60 + (int)inst->ON_M;
    off = (int)inst->OFF_H * 60 + (int)inst->OFF_M;
    now = lt.tm_hour * 60 + lt.tm_min;
    wd  = (int)__kron_iso_wday(&lt);                   /* 1..7 */
    prev_wd = (wd == 1) ? 7 : wd - 1;

    if (on == off) {
        inst->Q = false;
    } else if (on < off) {
        inst->Q = (now >= on && now < off)
                  && ((inst->DAYS >> (wd - 1)) & 1u) != 0u;
    } else {
        /* Wraps midnight — the window belongs to the day it started on. */
        if (now >= on)      inst->Q = ((inst->DAYS >> (wd - 1)) & 1u) != 0u;
        else if (now < off) inst->Q = ((inst->DAYS >> (prev_wd - 1)) & 1u) != 0u;
        else                inst->Q = false;
    }
}

/* ── Daily_Trigger ────────────────────────────────────────────────────────
 * Emits a ONE-SCAN pulse on Q when the local clock crosses H:M:S. For daily
 * resets, shift-change counters, report timestamps.
 *
 * Detection is by crossing, not by equality, so the pulse is produced exactly
 * once even on a task whose interval is longer than one second and even if the
 * exact second is never sampled. The midnight wrap is handled.
 *
 * ⚠️ The pulse is missed if the runtime is not running at the crossing, and it
 * fires a second time if the wall clock is stepped backwards over the target
 * (an NTP correction, a DST fall-back for a target inside the repeated hour).
 */
typedef struct {
    uint8_t H;            /* 0..23                                  (input)  */
    uint8_t M;            /* 0..59                                  (input)  */
    uint8_t S;            /* 0..59                                  (input)  */
    bool    Q;            /* one-scan pulse                         (output) */
    int32_t __prev_sod;   /* seconds-of-day at the previous call              */
    bool    __primed;     /* false until the first call has run               */
    bool    EN;           /* enable — power flow                    (input)  */
    bool    ENO;          /* echoes EN                              (output) */
} Daily_Trigger;

static inline void Daily_Trigger_Call(Daily_Trigger *inst)
{
    time_t   secs;
    uint16_t ms;
    struct tm lt;
    int32_t  sod, target;
    bool     crossed;

    inst->Q   = false;
    inst->ENO = inst->EN;
    if (!inst->EN) { inst->__primed = false; return; }

    __kron_tz_prime();
    if (!__kron_wall(&secs, &ms)) return;
    if (!__kron_localtime(secs, &lt)) return;

    sod    = __kron_sec_of_day(&lt);
    target = (int32_t)inst->H * 3600 + (int32_t)inst->M * 60 + (int32_t)inst->S;

    if (!inst->__primed) {
        inst->__primed   = true;
        inst->__prev_sod = sod;
        return;                       /* never fire on the first scan */
    }

    if (sod >= inst->__prev_sod) crossed = (target >  inst->__prev_sod && target <= sod);
    else                         crossed = (target >  inst->__prev_sod || target <= sod);

    inst->__prev_sod = sod;
    inst->Q = crossed;
}

/* ── Astro_Clock ──────────────────────────────────────────────────────────
 * Sunrise and sunset for a geographic position, from the system date. The
 * standard building-automation daylight switch: drive lighting from IS_DAY
 * instead of a fixed schedule that drifts through the year.
 *
 * LAT is degrees north (negative = south), LON degrees EAST (negative = west).
 * SUNRISE_MIN / SUNSET_MIN are minutes since LOCAL midnight, so they can be
 * compared directly against Read_System_Time / Time_Switch values.
 *
 * VALID is false during polar day and polar night, when there is no sunrise or
 * sunset to report; IS_DAY still answers correctly (true all day above the
 * arctic circle in summer, false in winter) and the two MIN outputs hold 0.
 *
 * Accuracy is a minute or two — this is the standard low-precision sunrise
 * equation with a -0.833° horizon (refraction + solar radius), not an
 * ephemeris. Refraction near the horizon varies more than that anyway.
 *
 * The solar geometry is recomputed once per calendar day; IS_DAY is updated
 * every call.
 */
typedef struct {
    float    LAT;          /* degrees north, -90..90                 (input)  */
    float    LON;          /* degrees east, -180..180                (input)  */
    uint16_t SUNRISE_MIN;  /* minutes since local midnight           (output) */
    uint16_t SUNSET_MIN;   /* minutes since local midnight           (output) */
    bool     IS_DAY;       /* sun is above the horizon               (output) */
    bool     VALID;        /* false during polar day / polar night   (output) */
    int16_t  __last_yday;  /* day the geometry was last computed for           */
    bool     __primed;     /* false until the first computation                */
    bool     EN;           /* enable — power flow                    (input)  */
    bool     ENO;          /* echoes EN                              (output) */
} Astro_Clock;

static inline void Astro_Clock_Call(Astro_Clock *inst)
{
    static const double KRON_PI  = 3.14159265358979323846;
    static const double KRON_D2R = 3.14159265358979323846 / 180.0;

    time_t   secs;
    uint16_t ms;
    struct tm lt;
    int32_t  now_min;

    inst->ENO = inst->EN;
    if (!inst->EN) return;

    __kron_tz_prime();
    if (!__kron_wall(&secs, &ms)) return;
    if (!__kron_localtime(secs, &lt)) return;

    now_min = __kron_sec_of_day(&lt) / 60;

    if (!inst->__primed || inst->__last_yday != (int16_t)lt.tm_yday) {
        /* Low-precision sunrise equation. The published form takes longitude
         * WEST-positive; LON is east-positive here, hence the negation. */
        double lw   = -(double)inst->LON;
        double phi  = (double)inst->LAT * KRON_D2R;
        double jd   = (double)secs / 86400.0 + 2440587.5;
        double n    = floor(jd - 2451545.0 + 0.0008 - lw / 360.0 + 0.5);
        double js   = 2451545.0 + 0.0008 + lw / 360.0 + n;   /* mean solar noon */
        double mdeg = fmod(357.5291 + 0.98560028 * (js - 2451545.0), 360.0);
        double mrad = mdeg * KRON_D2R;
        double ctr  = 1.9148 * sin(mrad) + 0.0200 * sin(2.0 * mrad)
                    + 0.0003 * sin(3.0 * mrad);
        double lam  = fmod(mdeg + ctr + 180.0 + 102.9372, 360.0) * KRON_D2R;
        double jt   = js + 0.0053 * sin(mrad) - 0.0069 * sin(2.0 * lam);
        double sind = sin(lam) * sin(23.44 * KRON_D2R);
        double cosd = sqrt(1.0 - sind * sind);
        double cosw = (sin(-0.833 * KRON_D2R) - sin(phi) * sind)
                    / (cos(phi) * cosd);
        int    off  = __kron_utc_offset_min(secs);

        inst->__primed    = true;
        inst->__last_yday = (int16_t)lt.tm_yday;

        if (cosw > 1.0 || cosw < -1.0 || cosd == 0.0) {
            /* No crossing today: polar night (cosw > 1) or polar day. */
            inst->VALID       = false;
            inst->SUNRISE_MIN = 0;
            inst->SUNSET_MIN  = 0;
        } else {
            double w     = acos(cosw) * 180.0 / KRON_PI;
            double jrise = jt - w / 360.0;
            double jset  = jt + w / 360.0;
            /* Julian day → epoch seconds → minutes since local midnight. */
            long   rmin  = (long)floor(((jrise - 2440587.5) * 86400.0) / 60.0) + off;
            long   smin  = (long)floor(((jset  - 2440587.5) * 86400.0) / 60.0) + off;
            rmin %= 1440L; if (rmin < 0) rmin += 1440L;
            smin %= 1440L; if (smin < 0) smin += 1440L;
            inst->VALID       = true;
            inst->SUNRISE_MIN = (uint16_t)rmin;
            inst->SUNSET_MIN  = (uint16_t)smin;
        }

        if (!inst->VALID) {
            /* Above the horizon all day iff the sun's declination and the
             * latitude share a sign (polar day), below it otherwise. */
            inst->IS_DAY = (cosw < -1.0);
        }
    }

    if (inst->VALID) {
        if (inst->SUNRISE_MIN <= inst->SUNSET_MIN)
            inst->IS_DAY = (now_min >= (int32_t)inst->SUNRISE_MIN
                         && now_min <  (int32_t)inst->SUNSET_MIN);
        else
            /* Sunset falls after local midnight (far east/west of the zone's
             * meridian, or a large UTC offset). */
            inst->IS_DAY = (now_min >= (int32_t)inst->SUNRISE_MIN
                         || now_min <  (int32_t)inst->SUNSET_MIN);
    }
}

/*===========================================================================
 * 3. Runtime diagnostics
 *===========================================================================*/

/* ── Read_Uptime ──────────────────────────────────────────────────────────
 * Time since this block first executed — in practice the runtime's uptime,
 * since the first scan runs it. Deliberately NOT machine uptime and NOT
 * us_tick (whose origin is boot on Linux but process start on Windows); an
 * instance-local origin makes the reading mean the same thing everywhere.
 *
 * A hot swap preserves the origin: the instance is a PlcState field and
 * PlcState survives the swap. A cold restart resets it.
 */
typedef struct {
    uint16_t DAYS;         /*                                        (output) */
    uint8_t  HOURS;        /* 0..23                                  (output) */
    uint8_t  MINUTES;      /* 0..59                                  (output) */
    uint8_t  SECONDS;      /* 0..59                                  (output) */
    uint32_t TOTAL_SEC;    /* whole uptime in seconds                (output) */
    uint64_t __origin_us;  /* monotonic reading at the first call              */
    bool     __primed;     /* false until the origin is captured               */
    bool     EN;           /* enable — power flow                    (input)  */
    bool     ENO;          /* echoes EN                              (output) */
} Read_Uptime;

static inline void Read_Uptime_Call(Read_Uptime *inst)
{
    uint64_t now, secs;

    inst->ENO = inst->EN;
    if (!inst->EN) return;

    now = __kron_mono_us();
    if (!inst->__primed) { inst->__primed = true; inst->__origin_us = now; }
    if (now < inst->__origin_us) inst->__origin_us = now;   /* clock stepped back */

    secs = (now - inst->__origin_us) / 1000000ULL;

    inst->TOTAL_SEC = (secs > 0xFFFFFFFFULL) ? 0xFFFFFFFFu : (uint32_t)secs;
    inst->DAYS      = (uint16_t)(secs / 86400ULL);
    inst->HOURS     = (uint8_t)((secs / 3600ULL) % 24ULL);
    inst->MINUTES   = (uint8_t)((secs / 60ULL) % 60ULL);
    inst->SECONDS   = (uint8_t)(secs % 60ULL);
}

/* ── Cycle_Time_Monitor ───────────────────────────────────────────────────
 * Measures the interval between its OWN consecutive calls, which is the scan
 * period of the task the instance runs in. Answers "is my 10 ms task actually
 * running every 10 ms?" — the one question the exec-time instrumentation
 * (__exec_us_<prog>, which measures body duration, not period) cannot.
 *
 * ⚠️ Every value is MICROseconds, hence the _US suffixes. Put the instance in
 * the task you want to measure; a second instance in another task measures
 * that one independently, because the timebase is read per call rather than
 * from the shared us_tick.
 *
 * RESET clears the statistics and re-primes; the first call after priming
 * produces no sample, since there is no previous timestamp to difference.
 */
typedef struct {
    bool     RESET;        /* clear statistics (level)               (input)  */
    uint32_t LAST_US;      /* most recent interval                   (output) */
    uint32_t MIN_US;       /*                                        (output) */
    uint32_t MAX_US;       /*                                        (output) */
    uint32_t AVG_US;       /* mean over SAMPLES                      (output) */
    uint32_t JITTER_US;    /* MAX_US - MIN_US                        (output) */
    uint32_t SAMPLES;      /* intervals measured since the reset     (output) */
    uint64_t __prev_us;    /* previous call's monotonic reading                */
    uint64_t __sum_us;     /* running sum for the mean                        */
    bool     __primed;     /* false until a previous reading exists           */
    bool     EN;           /* enable — power flow                    (input)  */
    bool     ENO;          /* echoes EN                              (output) */
} Cycle_Time_Monitor;

static inline void Cycle_Time_Monitor_Call(Cycle_Time_Monitor *inst)
{
    uint64_t now, d;

    inst->ENO = inst->EN;

    if (inst->RESET) {
        inst->__primed = false;
        inst->__sum_us = 0;
        inst->SAMPLES  = 0;
        inst->LAST_US = inst->MIN_US = inst->MAX_US = 0;
        inst->AVG_US  = inst->JITTER_US = 0;
    }
    if (!inst->EN) return;

    now = __kron_mono_us();
    if (!inst->__primed || now < inst->__prev_us) {
        inst->__primed  = true;
        inst->__prev_us = now;
        return;                       /* no previous reading to difference */
    }

    d = now - inst->__prev_us;
    inst->__prev_us = now;
    if (d > 0xFFFFFFFFULL) d = 0xFFFFFFFFULL;   /* >71 min — clamp, don't wrap */

    inst->LAST_US = (uint32_t)d;
    if (inst->SAMPLES == 0 || inst->LAST_US < inst->MIN_US) inst->MIN_US = inst->LAST_US;
    if (inst->LAST_US > inst->MAX_US)                       inst->MAX_US = inst->LAST_US;

    /* Halve both before SAMPLES could wrap to 0 — at a 10 µs task that point
     * is reached in about twelve hours, and a divide by zero would follow. The
     * mean simply becomes exponentially weighted from there on. */
    if (inst->SAMPLES == 0xFFFFFFFFu) {
        inst->SAMPLES  /= 2u;
        inst->__sum_us /= 2ULL;
    }
    inst->SAMPLES++;
    inst->__sum_us += d;

    inst->AVG_US    = (uint32_t)(inst->__sum_us / (uint64_t)inst->SAMPLES);
    inst->JITTER_US = inst->MAX_US - inst->MIN_US;
}

/* ── Hour_Meter ───────────────────────────────────────────────────────────
 * Accumulates the time IN has been true: a machine hour meter for maintenance
 * intervals, pump wear, filter changes.
 *
 * Declare the INSTANCE with class Retain to make the count survive a runtime
 * restart (see the RETAIN section in CLAUDE.md — the whole struct is one blob,
 * so the accumulator is carried). RESET clears it.
 *
 * ⚠️ An interval longer than KRON_HM_MAX_GAP_US between two calls is discarded
 * rather than accumulated. That is what stops a retained instance from adding
 * the entire downtime after a restart, when the stored monotonic timestamp
 * belongs to a previous process (or a previous boot). The cost is that a task
 * whose period exceeds the gap never accumulates — put the meter in a task
 * faster than 10 s.
 */
#define KRON_HM_MAX_GAP_US 10000000ULL   /* 10 s */

typedef struct {
    bool     IN;           /* accumulate while true — power flow     (input)  */
    bool     RESET;        /* clear the meter (level)                (input)  */
    uint32_t HOURS;        /* whole hours accumulated                (output) */
    uint32_t SECONDS;      /* whole seconds accumulated              (output) */
    bool     Q;            /* echoes IN                              (output) */
    uint64_t __acc_us;     /* accumulator, microseconds                        */
    uint64_t __prev_us;    /* previous call's monotonic reading                */
    bool     __primed;     /* false until a previous reading exists           */
} Hour_Meter;

static inline void Hour_Meter_Call(Hour_Meter *inst)
{
    uint64_t now, d;

    now = __kron_mono_us();

    if (inst->RESET) inst->__acc_us = 0;

    if (!inst->__primed) {
        inst->__primed  = true;
        inst->__prev_us = now;
        d = 0;
    } else if (now < inst->__prev_us || (now - inst->__prev_us) > KRON_HM_MAX_GAP_US) {
        d = 0;                        /* restart, reboot or a stalled scan */
    } else {
        d = now - inst->__prev_us;
    }
    inst->__prev_us = now;

    if (inst->IN) inst->__acc_us += d;

    inst->SECONDS = (uint32_t)(inst->__acc_us / 1000000ULL);
    inst->HOURS   = inst->SECONDS / 3600u;
    inst->Q       = inst->IN;
}

/* ── Watchdog ─────────────────────────────────────────────────────────────
 * EXPIRED goes true when KICK has not seen a RISING EDGE for PT. Use it to
 * detect a stalled producer: a communication partner that stopped answering, a
 * sequence that never reached its next step, an operator heartbeat.
 *
 * The edge requirement is the point — a level-triggered version would be held
 * happy by a stuck-true signal, which is the failure it exists to catch.
 * ET counts up from the last kick and stops climbing once it reaches PT.
 * A PT of 0 disables the watchdog (EXPIRED stays false).
 */
typedef struct {
    bool     KICK;         /* rising edge feeds the dog — power flow (input)  */
    uint32_t PT;           /* timeout, microseconds (IEC TIME)       (input)  */
    bool     EXPIRED;      /* no kick within PT                      (output) */
    uint32_t ET;           /* since the last kick, capped at PT      (output) */
    uint64_t __last_us;    /* monotonic reading of the last kick               */
    bool     __prev_kick;  /* previous scan's KICK, for the edge               */
    bool     __primed;     /* false until the first call has run               */
} Watchdog;

static inline void Watchdog_Call(Watchdog *inst)
{
    uint64_t now, d;
    bool     rising;

    now = __kron_mono_us();

    if (!inst->__primed) {
        inst->__primed    = true;
        inst->__last_us   = now;
        inst->__prev_kick = inst->KICK;
        inst->ET          = 0;
        inst->EXPIRED     = false;
        return;
    }

    rising = (inst->KICK && !inst->__prev_kick);
    inst->__prev_kick = inst->KICK;

    if (rising || now < inst->__last_us) {
        inst->__last_us = now;
        inst->ET        = 0;
        inst->EXPIRED   = false;
        return;
    }

    if (inst->PT == 0) { inst->ET = 0; inst->EXPIRED = false; return; }

    d = now - inst->__last_us;
    if (d >= (uint64_t)inst->PT) { inst->ET = inst->PT; inst->EXPIRED = true; }
    else                         { inst->ET = (uint32_t)d; inst->EXPIRED = false; }
}

/*===========================================================================
 * 4. Host health
 *
 * These read the operating system, not the process, so they are Linux-only:
 * /proc and /sys do not exist on macOS or Windows and there is no portable
 * substitute worth faking. On those platforms they report ERR_ID = ABSENT and
 * leave the values at zero, per the HAL rule that a missing source must fail
 * visibly rather than return a plausible number.
 *
 * Each caches its reading for KRON_SYS_POLL_US so a fast task does not turn
 * into a file-open loop.
 *===========================================================================*/

/* ── Read_CPU_Temperature ─────────────────────────────────────────────────
 * Hottest thermal zone in °C. On an SBC this is the variable that predicts
 * throttling — a Jetson or a Pi in a sealed enclosure silently loses clock
 * speed long before anything else reports a fault.
 *
 * Several zones exist on most boards (CPU, GPU, SoC, PMIC); the maximum is
 * reported because that is the one that trips. Readings outside -40..150 °C
 * are ignored as bogus — some drivers publish sentinel values for a zone that
 * is present but not wired to a sensor.
 */
typedef struct {
    float    TEMP;        /* °C, hottest zone                        (output) */
    uint8_t  ERR_ID;      /* 0 OK, 1 unavailable, 3 read/parse error (output) */
    uint64_t __next_us;   /* cache deadline                                   */
    bool     __primed;    /* false until the first read                       */
    bool     EN;          /* enable — power flow                     (input)  */
    bool     ENO;         /* echoes EN                               (output) */
} Read_CPU_Temperature;

static inline void Read_CPU_Temperature_Call(Read_CPU_Temperature *inst)
{
    uint64_t now;

    inst->ENO = inst->EN;
    if (!inst->EN) return;

    now = __kron_mono_us();
    if (inst->__primed && now < inst->__next_us) return;      /* cached */
    inst->__primed  = true;
    inst->__next_us = now + KRON_SYS_POLL_US;

#if defined(__linux__)
    {
        char  path[64];
        int   zone, found = 0;
        float best = -1000.0f;

        for (zone = 0; zone < 16; zone++) {
            FILE *f;
            long  milli;
            snprintf(path, sizeof(path),
                     "/sys/class/thermal/thermal_zone%d/temp", zone);
            f = fopen(path, "r");
            if (!f) continue;
            if (fscanf(f, "%ld", &milli) == 1) {
                float c = (float)milli / 1000.0f;
                if (c > -40.0f && c < 150.0f && c > best) { best = c; found = 1; }
            }
            fclose(f);
        }

        if (found) { inst->TEMP = best;  inst->ERR_ID = KRON_SYS_OK; }
        else       { inst->TEMP = 0.0f; inst->ERR_ID = KRON_SYS_ABSENT; }
    }
#else
    inst->TEMP   = 0.0f;
    inst->ERR_ID = KRON_SYS_ABSENT;
#endif
}

/* ── Read_System_Load ─────────────────────────────────────────────────────
 * One-minute load average and available memory. Worth watching on a board that
 * also runs the capture ring: KronServer sizes the ring segment at a
 * percentage of MemAvailable at start, so a board that has quietly filled its
 * memory will get a much smaller ring than expected on the next restart.
 *
 * MEM_FREE_MB is MemAvailable, not MemFree — the kernel's own estimate of what
 * a new allocation could actually get, which counts reclaimable cache. MemFree
 * looks alarming on a healthy Linux box and would be the wrong alarm to raise.
 */
typedef struct {
    float    LOAD_1M;      /* 1-minute load average                  (output) */
    uint32_t MEM_FREE_MB;  /* MemAvailable, MiB                      (output) */
    uint32_t MEM_TOTAL_MB; /* MemTotal, MiB                          (output) */
    uint8_t  ERR_ID;       /* 0 OK, 1 unavailable, 3 read error      (output) */
    uint64_t __next_us;    /* cache deadline                                  */
    bool     __primed;     /* false until the first read                      */
    bool     EN;           /* enable — power flow                    (input)  */
    bool     ENO;          /* echoes EN                              (output) */
} Read_System_Load;

static inline void Read_System_Load_Call(Read_System_Load *inst)
{
    uint64_t now;

    inst->ENO = inst->EN;
    if (!inst->EN) return;

    now = __kron_mono_us();
    if (inst->__primed && now < inst->__next_us) return;      /* cached */
    inst->__primed  = true;
    inst->__next_us = now + KRON_SYS_POLL_US;

#if defined(__linux__)
    {
        FILE *f;
        int   ok = 0;

        f = fopen("/proc/loadavg", "r");
        if (f) {
            double l1;
            if (fscanf(f, "%lf", &l1) == 1) { inst->LOAD_1M = (float)l1; ok = 1; }
            fclose(f);
        }

        f = fopen("/proc/meminfo", "r");
        if (f) {
            char line[128];
            unsigned long kb;
            int got = 0;
            while (got < 2 && fgets(line, sizeof(line), f)) {
                if (sscanf(line, "MemTotal: %lu kB", &kb) == 1) {
                    inst->MEM_TOTAL_MB = (uint32_t)(kb / 1024UL); got++;
                } else if (sscanf(line, "MemAvailable: %lu kB", &kb) == 1) {
                    inst->MEM_FREE_MB = (uint32_t)(kb / 1024UL); got++;
                }
            }
            fclose(f);
            if (got == 2) ok++;
        }

        inst->ERR_ID = (ok == 2) ? KRON_SYS_OK : KRON_SYS_IOERR;
    }
#else
    inst->LOAD_1M      = 0.0f;
    inst->MEM_FREE_MB  = 0;
    inst->MEM_TOTAL_MB = 0;
    inst->ERR_ID       = KRON_SYS_ABSENT;
#endif
}

/* ── Read_Disk_Free ───────────────────────────────────────────────────────
 * Free and total space on the filesystem holding the runtime's working
 * directory — the deploy directory on a target, the build directory for the
 * local simulation. That is where retain.dat, the runtime logs and the
 * deployed binaries live, so a full filesystem there breaks retention and the
 * next deploy.
 *
 * POSIX only (statvfs). Windows reports ERR_ID = ABSENT: the sim runs there,
 * but the disk that matters is the target's.
 */
typedef struct {
    uint32_t FREE_MB;      /* available to an unprivileged writer    (output) */
    uint32_t TOTAL_MB;     /*                                        (output) */
    uint8_t  ERR_ID;       /* 0 OK, 1 unavailable, 3 statvfs failed  (output) */
    uint64_t __next_us;    /* cache deadline                                  */
    bool     __primed;     /* false until the first read                      */
    bool     EN;           /* enable — power flow                    (input)  */
    bool     ENO;          /* echoes EN                              (output) */
} Read_Disk_Free;

static inline void Read_Disk_Free_Call(Read_Disk_Free *inst)
{
    uint64_t now;

    inst->ENO = inst->EN;
    if (!inst->EN) return;

    now = __kron_mono_us();
    if (inst->__primed && now < inst->__next_us) return;      /* cached */
    inst->__primed  = true;
    inst->__next_us = now + KRON_SYS_POLL_US;

#if defined(__linux__) || defined(__APPLE__)
    {
        struct statvfs st;
        if (statvfs(".", &st) == 0) {
            /* f_frsize is the fragment size the block counts are expressed in;
             * f_bsize is the preferred I/O size and is NOT interchangeable. */
            uint64_t unit  = (uint64_t)(st.f_frsize ? st.f_frsize : st.f_bsize);
            uint64_t freeb = (uint64_t)st.f_bavail * unit;
            uint64_t totb  = (uint64_t)st.f_blocks * unit;
            inst->FREE_MB  = (uint32_t)(freeb / (1024ULL * 1024ULL));
            inst->TOTAL_MB = (uint32_t)(totb  / (1024ULL * 1024ULL));
            inst->ERR_ID   = KRON_SYS_OK;
        } else {
            inst->FREE_MB = inst->TOTAL_MB = 0;
            inst->ERR_ID  = KRON_SYS_IOERR;
        }
    }
#else
    inst->FREE_MB  = 0;
    inst->TOTAL_MB = 0;
    inst->ERR_ID   = KRON_SYS_ABSENT;
#endif
}

/*===========================================================================
 * 5. TIME arithmetic and conversion
 *
 * The X_TO_Y conversion blocks cannot cover TIME: the transpiler rewrites that
 * naming pattern to KRON_<src>_TO_<dst>, which resolves in the prebuilt
 * archive, and TIME has no entry there. These blocks fill the gap instead, so
 * their names deliberately avoid the _TO_ spelling.
 *
 * IEC TIME is an UNSIGNED 32-bit count of MICROseconds end to end, which
 * bounds a duration to about 71.6 minutes. Every block below saturates rather
 * than wrapping: a negative result clamps to 0, an overflow to the maximum.
 *===========================================================================*/

#define KRON_T_MAX 0xFFFFFFFFu

/* Clamp a double to the TIME range. */
static inline uint32_t __kron_t_sat(double v)
{
    if (v <= 0.0)                     return 0u;
    if (v >= (double)KRON_T_MAX)      return KRON_T_MAX;
    return (uint32_t)v;
}

/* ── T_To_Ms — TIME to whole milliseconds ─────────────────────────────── */
typedef struct {
    uint32_t IN;    /* duration, microseconds                  (input)  */
    int32_t  OUT;   /* whole milliseconds, truncated           (output) */
    bool     EN;    /* enable — power flow                     (input)  */
    bool     ENO;   /* echoes EN                               (output) */
} T_To_Ms;

static inline void T_To_Ms_Call(T_To_Ms *inst)
{
    inst->ENO = inst->EN;
    if (!inst->EN) return;
    inst->OUT = (int32_t)(inst->IN / 1000u);
}

/* ── Ms_To_T — whole milliseconds to TIME ─────────────────────────────── */
typedef struct {
    int32_t  IN;    /* milliseconds; negative clamps to 0      (input)  */
    uint32_t OUT;   /* duration, microseconds                  (output) */
    bool     EN;    /* enable — power flow                     (input)  */
    bool     ENO;   /* echoes EN                               (output) */
} Ms_To_T;

static inline void Ms_To_T_Call(Ms_To_T *inst)
{
    inst->ENO = inst->EN;
    if (!inst->EN) return;
    inst->OUT = __kron_t_sat((double)inst->IN * 1000.0);
}

/* ── T_To_Sec — TIME to fractional seconds ────────────────────────────── */
typedef struct {
    uint32_t IN;    /* duration, microseconds                  (input)  */
    float    OUT;   /* seconds, fractional                     (output) */
    bool     EN;    /* enable — power flow                     (input)  */
    bool     ENO;   /* echoes EN                               (output) */
} T_To_Sec;

static inline void T_To_Sec_Call(T_To_Sec *inst)
{
    inst->ENO = inst->EN;
    if (!inst->EN) return;
    inst->OUT = (float)((double)inst->IN / 1000000.0);
}

/* ── Sec_To_T — fractional seconds to TIME ────────────────────────────── */
typedef struct {
    float    IN;    /* seconds; negative clamps to 0           (input)  */
    uint32_t OUT;   /* duration, microseconds                  (output) */
    bool     EN;    /* enable — power flow                     (input)  */
    bool     ENO;   /* echoes EN                               (output) */
} Sec_To_T;

static inline void Sec_To_T_Call(Sec_To_T *inst)
{
    inst->ENO = inst->EN;
    if (!inst->EN) return;
    inst->OUT = __kron_t_sat((double)inst->IN * 1000000.0);
}

/* ── Add_T — sum of two durations ─────────────────────────────────────── */
typedef struct {
    uint32_t IN1;   /*                                         (input)  */
    uint32_t IN2;   /*                                         (input)  */
    uint32_t OUT;   /* IN1 + IN2, saturating                   (output) */
    bool     EN;    /* enable — power flow                     (input)  */
    bool     ENO;   /* echoes EN                               (output) */
} Add_T;

static inline void Add_T_Call(Add_T *inst)
{
    inst->ENO = inst->EN;
    if (!inst->EN) return;
    inst->OUT = __kron_t_sat((double)inst->IN1 + (double)inst->IN2);
}

/* ── Sub_T — difference of two durations ──────────────────────────────── */
typedef struct {
    uint32_t IN1;   /*                                         (input)  */
    uint32_t IN2;   /*                                         (input)  */
    uint32_t OUT;   /* IN1 - IN2, clamped at 0                 (output) */
    bool     EN;    /* enable — power flow                     (input)  */
    bool     ENO;   /* echoes EN                               (output) */
} Sub_T;

static inline void Sub_T_Call(Sub_T *inst)
{
    inst->ENO = inst->EN;
    if (!inst->EN) return;
    inst->OUT = (inst->IN1 > inst->IN2) ? (inst->IN1 - inst->IN2) : 0u;
}

/* ── Mul_T — scale a duration ─────────────────────────────────────────── */
typedef struct {
    uint32_t IN;    /*                                         (input)  */
    float    N;     /* scale factor                            (input)  */
    uint32_t OUT;   /* IN * N, saturating                      (output) */
    bool     EN;    /* enable — power flow                     (input)  */
    bool     ENO;   /* echoes EN                               (output) */
} Mul_T;

static inline void Mul_T_Call(Mul_T *inst)
{
    inst->ENO = inst->EN;
    if (!inst->EN) return;
    inst->OUT = __kron_t_sat((double)inst->IN * (double)inst->N);
}

/* ── Div_T — divide a duration ────────────────────────────────────────── */
typedef struct {
    uint32_t IN;    /*                                         (input)  */
    float    N;     /* divisor; 0 yields OUT = 0               (input)  */
    uint32_t OUT;   /* IN / N, saturating                      (output) */
    bool     EN;    /* enable — power flow                     (input)  */
    bool     ENO;   /* echoes EN                               (output) */
} Div_T;

static inline void Div_T_Call(Div_T *inst)
{
    inst->ENO = inst->EN;
    if (!inst->EN) return;
    if (inst->N == 0.0f) { inst->OUT = 0u; return; }
    inst->OUT = __kron_t_sat((double)inst->IN / (double)inst->N);
}

/*===========================================================================
 * 6. Signal generation and conditioning  (TIMERS category)
 *===========================================================================*/

/* ── Blink ────────────────────────────────────────────────────────────────
 * Free-running square wave while ENABLE is true: OUT is held true for T_HIGH,
 * then false for T_LOW, and so on. Replaces the two-TON ring every project
 * ends up drawing for a status lamp or a heartbeat bit.
 *
 * OUT starts true. Dropping ENABLE forces OUT false and restarts the phase, so
 * the first high period after re-enabling is always a full one.
 * A dwell of 0 toggles on every scan — that is the literal reading of the
 * request, not a disabled blinker.
 *
 * ⚠️ Resolution is bounded by the task interval, like every timer here: the
 * observed half-period is the dwell rounded up to a multiple of the scan.
 */
typedef struct {
    bool     ENABLE;       /* run — power flow                       (input)  */
    uint32_t T_LOW;        /* low dwell, microseconds (IEC TIME)     (input)  */
    uint32_t T_HIGH;       /* high dwell, microseconds (IEC TIME)    (input)  */
    bool     OUT;          /*                                        (output) */
    uint64_t __change_us;  /* monotonic reading of the last edge               */
    bool     __primed;     /* false while disabled                             */
} Blink;

static inline void Blink_Call(Blink *inst)
{
    uint64_t now;
    uint32_t dwell;

    if (!inst->ENABLE) {
        inst->OUT     = false;
        inst->__primed = false;
        return;
    }

    now = __kron_mono_us();
    if (!inst->__primed) {
        inst->__primed    = true;
        inst->__change_us = now;
        inst->OUT         = true;
        return;
    }
    if (now < inst->__change_us) inst->__change_us = now;   /* clock stepped back */

    dwell = inst->OUT ? inst->T_HIGH : inst->T_LOW;
    if ((now - inst->__change_us) >= (uint64_t)dwell) {
        inst->OUT         = !inst->OUT;
        inst->__change_us = now;
    }
}

/* ── Debounce ─────────────────────────────────────────────────────────────
 * OUT follows IN only once IN has held the same value for PT. The HAL hands
 * raw pin levels to the program with no filtering, so a mechanical contact or
 * a long unshielded run reaches the logic as a burst of edges; this absorbs
 * them symmetrically, on both the rising and the falling side.
 *
 * OUT adopts IN on the first scan rather than defaulting to false, so a switch
 * already closed at start-up is not reported as open for PT.
 * A PT of 0 makes OUT track IN directly.
 */
typedef struct {
    bool     IN;           /* raw signal — power flow                (input)  */
    uint32_t PT;           /* settle time, microseconds (IEC TIME)   (input)  */
    bool     OUT;          /* debounced signal                       (output) */
    uint64_t __since_us;   /* when the candidate value first appeared          */
    bool     __candidate;  /* the value IN currently holds                     */
    bool     __primed;     /* false until the first call has run               */
} Debounce;

static inline void Debounce_Call(Debounce *inst)
{
    uint64_t now = __kron_mono_us();

    if (!inst->__primed) {
        inst->__primed     = true;
        inst->__candidate  = inst->IN;
        inst->OUT          = inst->IN;
        inst->__since_us   = now;
        return;
    }
    if (now < inst->__since_us) inst->__since_us = now;     /* clock stepped back */

    if (inst->IN != inst->__candidate) {
        inst->__candidate = inst->IN;
        inst->__since_us  = now;
        return;                       /* restart the settle window */
    }

    if (inst->__candidate != inst->OUT
        && (now - inst->__since_us) >= (uint64_t)inst->PT) {
        inst->OUT = inst->__candidate;
    }
}

/* ── Gen_Signal ───────────────────────────────────────────────────────────
 * Periodic test waveform: OUT = OFFSET + AMPLITUDE * f(phase), where f swings
 * between -1 and +1. Lets a control loop, a trend view or an HMI page be
 * exercised with no hardware attached and no ladder written for it.
 *
 *   MODE  0 = sine, 1 = square, 2 = triangle, 3 = sawtooth.
 *         An unknown mode falls back to sine.
 *
 * The phase origin is captured when EN goes true, so the waveform always
 * starts at phase 0. A PERIOD of 0 holds OUT at OFFSET.
 */
typedef struct {
    uint8_t  MODE;         /* 0 sine, 1 square, 2 triangle, 3 saw    (input)  */
    uint32_t PERIOD;       /* microseconds (IEC TIME)                (input)  */
    float    AMPLITUDE;    /* peak deviation from OFFSET             (input)  */
    float    OFFSET;       /* centre value                           (input)  */
    float    OUT;          /*                                        (output) */
    uint64_t __origin_us;  /* monotonic reading when EN went true              */
    bool     __primed;     /* false while disabled                            */
    bool     EN;           /* enable — power flow                    (input)  */
    bool     ENO;          /* echoes EN                              (output) */
} Gen_Signal;

static inline void Gen_Signal_Call(Gen_Signal *inst)
{
    static const double KRON_TAU = 6.28318530717958647692;
    uint64_t now;
    double   phase, v;

    inst->ENO = inst->EN;
    if (!inst->EN) { inst->__primed = false; return; }

    now = __kron_mono_us();
    if (!inst->__primed) { inst->__primed = true; inst->__origin_us = now; }
    if (now < inst->__origin_us) inst->__origin_us = now;   /* clock stepped back */

    if (inst->PERIOD == 0u) { inst->OUT = inst->OFFSET; return; }

    phase = (double)((now - inst->__origin_us) % (uint64_t)inst->PERIOD)
          / (double)inst->PERIOD;                            /* 0.0 .. 1.0 */

    switch (inst->MODE) {
        case 1:  v = (phase < 0.5) ? 1.0 : -1.0;                            break;
        case 2:  v = (phase < 0.5) ? (4.0 * phase - 1.0)
                                   : (3.0 - 4.0 * phase);                   break;
        case 3:  v = 2.0 * phase - 1.0;                                     break;
        default: v = sin(KRON_TAU * phase);                                 break;
    }

    inst->OUT = (float)((double)inst->OFFSET + (double)inst->AMPLITUDE * v);
}

#endif /* KRONSYSTEM_H */
