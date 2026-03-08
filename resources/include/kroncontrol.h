/*===========================================================================
 * KronControl — Advanced Control Function Blocks
 *
 * Blocks:
 *   PID          — PID controller (anti-windup, derivative on measurement,
 *                  1st-order derivative filter)
 *   LOW_PASS     — 1st-order IIR low-pass  filter
 *   HIGH_PASS    — 1st-order IIR high-pass filter
 *   RATE_LIMITER — Slew rate limiter (rise/fall rates)
 *   DEADBAND     — Dead-zone (stateless)
 *   HYSTERESIS   — Schmitt trigger (on/off with hysteresis band)
 *   MOVING_AVG   — N-sample moving average (circular buffer)
 *   INTEGRATOR   — Discrete integrator with clamp and reset
 *   DIFFERENTIATOR — Finite-difference derivative with 1st-order smoothing
 *
 * Call pattern: XXX_Call(XXX *inst, inputs...)  — IEC 61131-3 style.
 * All structs are zero-initializable as a safe default state.
 *
 * No external dependencies. C99. Baremetal Cortex-M4 compatible.
 *===========================================================================*/

#ifndef KRONCONTROL_H
#define KRONCONTROL_H

#include <stdbool.h>
#include <stdint.h>
#define __int8_t_defined

/*===========================================================================
 * PID — Proportional-Integral-Derivative Controller
 *
 * Features:
 *   • Derivative on measurement (no kick on setpoint step)
 *   • 1st-order derivative low-pass filter  (N = bandwidth in rad/s)
 *   • Integral clamping anti-windup
 *   • Output clamping [OutMin, OutMax]
 *   • Bumpless enable: rising edge of Enable seeds prevFeedback
 *     so the derivative term starts at zero
 *
 * Typical parameter setup:
 *   Kp  = proportional gain
 *   Ki  = integral gain   (Ki = Kp / Ti,  Ti = integral time)
 *   Kd  = derivative gain (Kd = Kp * Td,  Td = derivative time)
 *   DerivFilterCoeff (N): bandwidth of D filter in rad/s.
 *     Typical: 5–20× closed-loop BW.  Set to 0 to disable D term.
 *   OutMin / OutMax: output saturation limits
 *===========================================================================*/
typedef struct {
    /* Parameters */
    float Kp;
    float Ki;
    float Kd;
    float DerivFilterCoeff; /* N [rad/s]; 0 = no derivative */
    float OutMin;
    float OutMax;
    /* Output */
    float Out;
    /* Internal state */
    float _integral;
    float _prevFeedback;
    float _derivFiltered;
    bool  _prevEnable;
} PID;

void PID_Call(PID *inst, bool Enable, float Setpoint, float Feedback, float Dt);

/*===========================================================================
 * LOW_PASS — 1st-order IIR low-pass filter
 *
 *   y[n] = Alpha * x[n] + (1 - Alpha) * y[n-1]
 *
 *   Alpha = 0 → infinite lag (output frozen)
 *   Alpha = 1 → no filtering (output = input)
 *
 * To compute Alpha from cutoff frequency fc [Hz] and sample period Ts [s]:
 *   Alpha = KRON_LP_Alpha(fc, Ts)
 *   which computes: wc*Ts / (1 + wc*Ts),  wc = 2π·fc
 *===========================================================================*/
typedef struct {
    float Alpha; /* filter coefficient [0, 1] */
    float Out;   /* filtered output (also internal state y[n-1]) */
} LOW_PASS;

void  LOW_PASS_Call(LOW_PASS *inst, float In);
float KRON_LP_Alpha(float cutoff_hz, float dt_s); /* helper */

/*===========================================================================
 * HIGH_PASS — 1st-order IIR high-pass filter
 *
 *   y[n] = Alpha * (y[n-1] + x[n] - x[n-1])
 *
 *   Alpha = 1 → pass-through (no attenuation at any frequency)
 *   Alpha → 0 → stronger DC rejection (lower cutoff)
 *
 * To compute Alpha from cutoff frequency fc [Hz] and sample period Ts [s]:
 *   Alpha = KRON_HP_Alpha(fc, Ts)
 *   which computes: 1 / (1 + wc*Ts),  wc = 2π·fc
 *===========================================================================*/
typedef struct {
    float Alpha;  /* filter coefficient [0, 1] */
    float Out;    /* filtered output */
    float _prevIn;
} HIGH_PASS;

void  HIGH_PASS_Call(HIGH_PASS *inst, float In);
float KRON_HP_Alpha(float cutoff_hz, float dt_s); /* helper */

/*===========================================================================
 * RATE_LIMITER — Slew rate limiter
 *
 * Limits the rate of change of the output:
 *   rise: Out increases at most RiseRate [units/s]
 *   fall: Out decreases at most FallRate [units/s]  (positive value)
 *
 * Example: RiseRate = 100.0f, FallRate = 50.0f, Dt = 0.01f
 *   → max step up   = 1.0  units per call
 *   → max step down = 0.5  units per call
 *===========================================================================*/
typedef struct {
    float RiseRate; /* max rate of increase [units/s] */
    float FallRate; /* max rate of decrease [units/s], positive */
    float Out;      /* rate-limited output (also state) */
} RATE_LIMITER;

void RATE_LIMITER_Call(RATE_LIMITER *inst, float In, float Dt);

/*===========================================================================
 * DEADBAND — Dead-zone element (stateless)
 *
 *   |In| <= Width  →  Out = 0
 *   |In| >  Width  →  Out = In
 *
 * Width is the half-width of the dead zone (always positive).
 *===========================================================================*/
float DEADBAND_Call(float In, float Width);

/*===========================================================================
 * HYSTERESIS — Schmitt trigger
 *
 *  State Q = false → switches to true  when In > HiThreshold
 *  State Q = true  → switches to false when In < LoThreshold
 *  Between the thresholds: Q is unchanged
 *
 * Typical: LoThreshold < HiThreshold
 *===========================================================================*/
typedef struct {
    float HiThreshold;
    float LoThreshold;
    bool  Q; /* output state */
} HYSTERESIS;

void HYSTERESIS_Call(HYSTERESIS *inst, float In);

/*===========================================================================
 * MOVING_AVG — N-sample moving average
 *
 *   Out = mean of last N samples of In
 *
 *   N must be in [1, KRON_MA_MAX_SIZE].
 *   Set N before the first call; do not change it during operation
 *   (reset manually by zeroing the struct if N must change).
 *===========================================================================*/
#define KRON_MA_MAX_SIZE 32u

typedef struct {
    uint8_t N;                     /* window size [1, KRON_MA_MAX_SIZE] */
    float   Out;                   /* current average */
    /* Internal */
    float   _buf[KRON_MA_MAX_SIZE];
    uint8_t _head;
    uint8_t _count;
    float   _sum;
} MOVING_AVG;

void MOVING_AVG_Call(MOVING_AVG *inst, float In);

/*===========================================================================
 * INTEGRATOR — Discrete integrator with clamp and reset
 *
 *   Out += In * Dt    (when Enable = true, Reset = false)
 *   Out is clamped to [OutMin, OutMax] after integration.
 *   Reset = true  → Out = 0 immediately (overrides Enable)
 *   Enable = false → Out is held (no integration, no reset)
 *===========================================================================*/
typedef struct {
    float OutMin;
    float OutMax;
    float Out;
} INTEGRATOR;

void INTEGRATOR_Call(INTEGRATOR *inst, bool Enable, bool Reset, float In, float Dt);

/*===========================================================================
 * DIFFERENTIATOR — Finite-difference derivative with smoothing
 *
 *   rawD  = (In - In[n-1]) / Dt
 *   Out   = Alpha * rawD + (1 - Alpha) * Out[n-1]
 *
 *   Alpha = 1 → no smoothing (raw finite difference)
 *   Alpha → 0 → heavily smoothed derivative
 *
 * First call seeds In[n-1] = In and Out = 0 (no output spike).
 *===========================================================================*/
typedef struct {
    float Alpha;  /* smoothing coefficient [0, 1] */
    float Out;    /* smoothed derivative */
    /* Internal */
    float _prevIn;
    bool  _initialized;
} DIFFERENTIATOR;

void DIFFERENTIATOR_Call(DIFFERENTIATOR *inst, float In, float Dt);

#endif /* KRONCONTROL_H */
