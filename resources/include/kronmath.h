/*===========================================================================
 * KronMathematic — Integer Math Function Blocks (IEC 61131-3)
 *
 * PLC integer arithmetic. All operations work on int32_t (DINT).
 * Input types (USINT, UINT, UDINT, SINT, INT, DINT) are implicitly
 * promoted to int32_t when assigned to IN fields.
 *
 * Multi-input blocks (ADD, MUL, MIN, MAX) accept up to
 * KRON_MATH_MAX_IN inputs via IN[] array + N count.
 *
 * No external dependencies. C99. PLC / baremetal compatible.
 *===========================================================================*/

#ifndef KRONMATH_H
#define KRONMATH_H

#include <stdbool.h>
#include <stdint.h>
#define __int8_t_defined

/*
 * PLC Integer Type Mapping (IEC 61131-3, 32-bit max):
 *   USINT  → uint8_t   (8-bit unsigned,  0 .. 255)
 *   UINT   → uint16_t  (16-bit unsigned, 0 .. 65535)
 *   UDINT  → uint32_t  (32-bit unsigned, 0 .. 4294967295)
 *   SINT   → int8_t    (8-bit signed,   -128 .. 127)
 *   INT    → int16_t   (16-bit signed,  -32768 .. 32767)
 *   DINT   → int32_t   (32-bit signed,  -2147483648 .. 2147483647)
 *
 * All function blocks use int32_t internally.
 * Assign any of the above types to IN fields; C promotes automatically.
 */

#define KRON_MATH_MAX_IN 32

/* =========================================================
 * ADD — Sum of N inputs
 * OUT = IN[0] + IN[1] + ... + IN[N-1]
 * ========================================================= */
typedef struct {
    int32_t IN[KRON_MATH_MAX_IN]; // Input values (32-bit each)
    uint8_t N;                     // Number of active inputs
    int32_t OUT;                   // Sum result (32-bit)
} ADD;

/* =========================================================
 * SUB — Subtraction
 * OUT = IN1 - IN2
 * ========================================================= */
typedef struct {
    int32_t IN1;    // Minuend (32-bit)
    int32_t IN2;    // Subtrahend (32-bit)
    int32_t OUT;    // Difference (32-bit)
} SUB;

/* =========================================================
 * MUL — Product of N inputs
 * OUT = IN[0] * IN[1] * ... * IN[N-1]
 * ========================================================= */
typedef struct {
    int32_t IN[KRON_MATH_MAX_IN]; // Input values (32-bit each)
    uint8_t N;                     // Number of active inputs
    int32_t OUT;                   // Product result (32-bit)
} MUL;

/* =========================================================
 * DIV — Integer division
 * OUT = IN1 / IN2, ERR = true on division by zero
 * ========================================================= */
typedef struct {
    int32_t IN1;    // Dividend (32-bit)
    int32_t IN2;    // Divisor (32-bit)
    int32_t OUT;    // Quotient (32-bit)
    bool    ERR;    // Error flag: division by zero (1-bit / 8-bit)
} DIV;

/* =========================================================
 * MOD — Integer modulo
 * OUT = IN1 % IN2, ERR = true on division by zero
 * ========================================================= */
typedef struct {
    int32_t IN1;    // Dividend (32-bit)
    int32_t IN2;    // Divisor (32-bit)
    int32_t OUT;    // Remainder (32-bit)
    bool    ERR;    // Error flag: division by zero (1-bit / 8-bit)
} MOD;

/* =========================================================
 * ABS — Absolute value
 * OUT = |IN|
 * ========================================================= */
typedef struct {
    int32_t IN;     // Input (32-bit)
    int32_t OUT;    // |IN| (32-bit)
} ABS_FB;

/* =========================================================
 * NEG — Negation
 * OUT = -IN
 * ========================================================= */
typedef struct {
    int32_t IN;     // Input (32-bit)
    int32_t OUT;    // -IN (32-bit)
} NEG;

/* =========================================================
 * MOVE — Copy value
 * OUT = IN
 * ========================================================= */
typedef struct {
    int32_t IN;     // Input (32-bit)
    int32_t OUT;    // Copy of IN (32-bit)
} MOVE;

/* =========================================================
 * SQRT — Integer square root (floor)
 * OUT = floor(sqrt(IN)), ERR = true for negative input
 * ========================================================= */
typedef struct {
    int32_t IN;     // Input (32-bit)
    int32_t OUT;    // floor(sqrt(IN)) (32-bit)
    bool    ERR;    // Error flag: negative input (1-bit / 8-bit)
} SQRT_FB;

/* =========================================================
 * EXPT — Integer exponentiation
 * OUT = IN1 ^ IN2, ERR = true for negative exponent
 * ========================================================= */
typedef struct {
    int32_t IN1;    // Base (32-bit)
    int32_t IN2;    // Exponent, must be >= 0 (32-bit)
    int32_t OUT;    // Result (32-bit)
    bool    ERR;    // Error flag: negative exponent (1-bit / 8-bit)
} EXPT;

/* =========================================================
 * MIN — Minimum of N inputs
 * OUT = smallest value among IN[0..N-1]
 * ========================================================= */
typedef struct {
    int32_t IN[KRON_MATH_MAX_IN]; // Input values (32-bit each)
    uint8_t N;                     // Number of active inputs
    int32_t OUT;                   // Minimum value (32-bit)
} MIN_FB;

/* =========================================================
 * MAX — Maximum of N inputs
 * OUT = largest value among IN[0..N-1]
 * ========================================================= */
typedef struct {
    int32_t IN[KRON_MATH_MAX_IN]; // Input values (32-bit each)
    uint8_t N;                     // Number of active inputs
    int32_t OUT;                   // Maximum value (32-bit)
} MAX_FB;

/* =========================================================
 * LIMIT — Clamp value between bounds
 * OUT = MN if IN < MN, MX if IN > MX, else IN
 * ========================================================= */
typedef struct {
    int32_t MN;     // Minimum bound (32-bit)
    int32_t IN;     // Input (32-bit)
    int32_t MX;     // Maximum bound (32-bit)
    int32_t OUT;    // Clamped result (32-bit)
} LIMIT;

/* =========================================================
 * SEL — Binary selector
 * OUT = G ? IN1 : IN0
 * ========================================================= */
typedef struct {
    bool    G;      // Selector (1-bit / 8-bit)
    int32_t IN0;    // Value when G = false (32-bit)
    int32_t IN1;    // Value when G = true (32-bit)
    int32_t OUT;    // Selected value (32-bit)
} SEL;

/* =========================================================
 * MUX — Multiplexer (select from N inputs by index)
 * OUT = IN[K], ERR = true if K >= N
 * ========================================================= */
typedef struct {
    uint8_t K;                     // Selector index
    int32_t IN[KRON_MATH_MAX_IN]; // Input values (32-bit each)
    uint8_t N;                     // Number of active inputs
    int32_t OUT;                   // Selected value (32-bit)
    bool    ERR;                   // Error flag: K out of range (1-bit / 8-bit)
} MUX;

/* =========================================================
 * AVG — Average of N inputs (integer, truncated)
 * OUT = (IN[0] + IN[1] + ... + IN[N-1]) / N
 * ========================================================= */
typedef struct {
    int32_t IN[KRON_MATH_MAX_IN]; // Input values (32-bit each)
    uint8_t N;                     // Number of active inputs
    int32_t OUT;                   // Average result (32-bit)
} AVG;

/* Function Prototypes */
void ADD_Call  (ADD     *inst);
void SUB_Call  (SUB     *inst);
void MUL_Call  (MUL     *inst);
void DIV_Call  (DIV     *inst);
void MOD_Call  (MOD     *inst);
void ABS_Call  (ABS_FB  *inst);
void NEG_Call  (NEG     *inst);
void MOVE_Call (MOVE    *inst);
void SQRT_Call (SQRT_FB *inst);
void EXPT_Call (EXPT    *inst);
void MIN_Call  (MIN_FB  *inst);
void MAX_Call  (MAX_FB  *inst);
void LIMIT_Call(LIMIT   *inst);
void SEL_Call  (SEL     *inst);
void MUX_Call  (MUX     *inst);
void AVG_Call  (AVG     *inst);

#endif /* KRONMATH_H */
