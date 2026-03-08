/*===========================================================================
 * KronCompare — Comparison, Selection and Range Functions
 *
 * Functions (IEC 61131-3 §2.5.1):
 *   EQ, NE, GT, GE, LT, LE  — comparison   → bool
 *   SEL                      — binary select
 *   MUX                      — n-way multiplexer (array-based)
 *   LIMIT                    — clamp to [MN, MX]
 *   MAX, MIN                 — binary max / min
 *
 * Typed variants:
 *   _F suffix → operates on float   (IEC REAL)
 *   _I suffix → operates on int32_t (IEC DINT; smaller integer types
 *               are implicitly promoted by the compiler)
 *
 * No external dependencies. C99. Baremetal Cortex-M4 compatible.
 *===========================================================================*/

#ifndef KRONCOMPARE_H
#define KRONCOMPARE_H

#include <stdbool.h>
#include <stdint.h>
#define __int8_t_defined

/*===========================================================================
 * COMPARISON  (return bool)
 *===========================================================================*/

bool KRON_EQ_F(float    a, float    b);  /* a == b */
bool KRON_EQ_I(int32_t  a, int32_t  b);

bool KRON_NE_F(float    a, float    b);  /* a != b */
bool KRON_NE_I(int32_t  a, int32_t  b);

bool KRON_GT_F(float    a, float    b);  /* a >  b */
bool KRON_GT_I(int32_t  a, int32_t  b);

bool KRON_GE_F(float    a, float    b);  /* a >= b */
bool KRON_GE_I(int32_t  a, int32_t  b);

bool KRON_LT_F(float    a, float    b);  /* a <  b */
bool KRON_LT_I(int32_t  a, int32_t  b);

bool KRON_LE_F(float    a, float    b);  /* a <= b */
bool KRON_LE_I(int32_t  a, int32_t  b);

/*===========================================================================
 * SELECTION
 *===========================================================================*/

/* SEL(G, IN0, IN1) : G=false → IN0,  G=true → IN1  (IEC §2.5.1.5) */
float   KRON_SEL_F(bool g, float   in0, float   in1);
int32_t KRON_SEL_I(bool g, int32_t in0, int32_t in1);

/* MUX(K, arr, n) : returns arr[K] if K < n, else arr[n-1]  (IEC §2.5.1.6)
 * Array must have at least n elements (n >= 1). */
float   KRON_MUX_F(uint8_t k, const float   *arr, uint8_t n);
int32_t KRON_MUX_I(uint8_t k, const int32_t *arr, uint8_t n);

/*===========================================================================
 * RANGE
 *===========================================================================*/

/* LIMIT(MN, IN, MX) : clamp IN to [MN, MX]  (IEC §2.5.1.4) */
float   KRON_LIMIT_F(float   mn, float   in, float   mx);
int32_t KRON_LIMIT_I(int32_t mn, int32_t in, int32_t mx);

/* MAX / MIN : binary maximum / minimum */
float   KRON_MAX_F(float   a, float   b);
int32_t KRON_MAX_I(int32_t a, int32_t b);

float   KRON_MIN_F(float   a, float   b);
int32_t KRON_MIN_I(int32_t a, int32_t b);

/*===========================================================================
 * Generic macros  (C11 _Generic)
 *
 * Dispatch on the type of the first value argument:
 *   float            → _F
 *   int32_t          → _I
 *   uint32_t/int16_t/uint16_t/int8_t/uint8_t → _I
 *   default          → _F
 *
 * SEL  : dispatch on in0 (second argument)
 * MUX  : dispatch on *arr (element type)
 * LIMIT: dispatch on mn   (first argument)
 *===========================================================================*/

#define _KRON_CMP_DISPATCH(fn, a, b) _Generic((a),  \
    float:    fn##_F,                                \
    int32_t:  fn##_I,                                \
    uint32_t: fn##_I,                                \
    int16_t:  fn##_I,                                \
    uint16_t: fn##_I,                                \
    int8_t:   fn##_I,                                \
    uint8_t:  fn##_I,                                \
    default:  fn##_F                                 \
)((a), (b))

#define KRON_EQ(a, b)  _KRON_CMP_DISPATCH(KRON_EQ, a, b)
#define KRON_NE(a, b)  _KRON_CMP_DISPATCH(KRON_NE, a, b)
#define KRON_GT(a, b)  _KRON_CMP_DISPATCH(KRON_GT, a, b)
#define KRON_GE(a, b)  _KRON_CMP_DISPATCH(KRON_GE, a, b)
#define KRON_LT(a, b)  _KRON_CMP_DISPATCH(KRON_LT, a, b)
#define KRON_LE(a, b)  _KRON_CMP_DISPATCH(KRON_LE, a, b)

/* SEL: dispatch on in0 (2nd arg) */
#define KRON_SEL(g, in0, in1) _Generic((in0),       \
    float:    KRON_SEL_F,                            \
    int32_t:  KRON_SEL_I,                            \
    uint32_t: KRON_SEL_I,                            \
    int16_t:  KRON_SEL_I,                            \
    uint16_t: KRON_SEL_I,                            \
    int8_t:   KRON_SEL_I,                            \
    uint8_t:  KRON_SEL_I,                            \
    default:  KRON_SEL_F                             \
)((g), (in0), (in1))

/* MUX: dispatch on element type via *(arr) */
#define KRON_MUX(k, arr, n) _Generic(*(arr),         \
    float:    KRON_MUX_F,                             \
    int32_t:  KRON_MUX_I,                             \
    uint32_t: KRON_MUX_I,                             \
    int16_t:  KRON_MUX_I,                             \
    uint16_t: KRON_MUX_I,                             \
    int8_t:   KRON_MUX_I,                             \
    uint8_t:  KRON_MUX_I,                             \
    default:  KRON_MUX_F                              \
)((k), (arr), (n))

/* LIMIT: dispatch on mn (1st arg) */
#define KRON_LIMIT(mn, in, mx) _Generic((mn),        \
    float:    KRON_LIMIT_F,                           \
    int32_t:  KRON_LIMIT_I,                           \
    uint32_t: KRON_LIMIT_I,                           \
    int16_t:  KRON_LIMIT_I,                           \
    uint16_t: KRON_LIMIT_I,                           \
    int8_t:   KRON_LIMIT_I,                           \
    uint8_t:  KRON_LIMIT_I,                           \
    default:  KRON_LIMIT_F                            \
)((mn), (in), (mx))

#define KRON_MAX(a, b) _KRON_CMP_DISPATCH(KRON_MAX, a, b)
#define KRON_MIN(a, b) _KRON_CMP_DISPATCH(KRON_MIN, a, b)

#endif /* KRONCOMPARE_H */
