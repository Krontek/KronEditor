/*===========================================================================
 * KronConverter — Type Conversion Functions
 *
 * N = 8 types  →  N*(N-1) = 56 directed conversion functions.
 *
 * Types supported:
 *   BOOL   = bool      (stdbool.h)
 *   UINT8  = uint8_t   (1 byte,  0 .. 255)
 *   UINT16 = uint16_t  (2 bytes, 0 .. 65535)
 *   UINT32 = uint32_t  (4 bytes, 0 .. 4294967295)
 *   INT8   = int8_t    (1 byte, -128 .. 127)
 *   INT16  = int16_t   (2 bytes,-32768 .. 32767)
 *   INT32  = int32_t   (4 bytes,-2147483648 .. 2147483647)
 *   REAL   = float     (IEEE 754 single precision)
 *
 * Conversion semantics:
 *   → BOOL  : zero → false, any non-zero (incl. negative) → true
 *   → INT   : narrowing truncates via C cast (two's complement on ARM)
 *   → REAL  : direct cast; large integers may lose precision
 *   REAL→INT: truncation toward zero (C default)
 *
 * No external dependencies. C99. Baremetal Cortex-M4 compatible.
 *===========================================================================*/

#ifndef KRONCONVERTER_H
#define KRONCONVERTER_H

#include <stdbool.h>
#include <stdint.h>
#define __int8_t_defined

/*===========================================================================
 * FROM BOOL (bool → 7 types)
 *===========================================================================*/
uint8_t  KRON_BOOL_TO_UINT8 (bool v);
uint16_t KRON_BOOL_TO_UINT16(bool v);
uint32_t KRON_BOOL_TO_UINT32(bool v);
int8_t   KRON_BOOL_TO_INT8  (bool v);
int16_t  KRON_BOOL_TO_INT16 (bool v);
int32_t  KRON_BOOL_TO_INT32 (bool v);
float    KRON_BOOL_TO_REAL  (bool v);

/*===========================================================================
 * FROM UINT8 (uint8_t → 7 types)
 *===========================================================================*/
bool     KRON_UINT8_TO_BOOL  (uint8_t v);
uint16_t KRON_UINT8_TO_UINT16(uint8_t v);
uint32_t KRON_UINT8_TO_UINT32(uint8_t v);
int8_t   KRON_UINT8_TO_INT8  (uint8_t v);
int16_t  KRON_UINT8_TO_INT16 (uint8_t v);
int32_t  KRON_UINT8_TO_INT32 (uint8_t v);
float    KRON_UINT8_TO_REAL  (uint8_t v);

/*===========================================================================
 * FROM UINT16 (uint16_t → 7 types)
 *===========================================================================*/
bool     KRON_UINT16_TO_BOOL  (uint16_t v);
uint8_t  KRON_UINT16_TO_UINT8 (uint16_t v);
uint32_t KRON_UINT16_TO_UINT32(uint16_t v);
int8_t   KRON_UINT16_TO_INT8  (uint16_t v);
int16_t  KRON_UINT16_TO_INT16 (uint16_t v);
int32_t  KRON_UINT16_TO_INT32 (uint16_t v);
float    KRON_UINT16_TO_REAL  (uint16_t v);

/*===========================================================================
 * FROM UINT32 (uint32_t → 7 types)
 *===========================================================================*/
bool     KRON_UINT32_TO_BOOL  (uint32_t v);
uint8_t  KRON_UINT32_TO_UINT8 (uint32_t v);
uint16_t KRON_UINT32_TO_UINT16(uint32_t v);
int8_t   KRON_UINT32_TO_INT8  (uint32_t v);
int16_t  KRON_UINT32_TO_INT16 (uint32_t v);
int32_t  KRON_UINT32_TO_INT32 (uint32_t v);
float    KRON_UINT32_TO_REAL  (uint32_t v);

/*===========================================================================
 * FROM INT8 (int8_t → 7 types)
 *===========================================================================*/
bool     KRON_INT8_TO_BOOL  (int8_t v);
uint8_t  KRON_INT8_TO_UINT8 (int8_t v);
uint16_t KRON_INT8_TO_UINT16(int8_t v);
uint32_t KRON_INT8_TO_UINT32(int8_t v);
int16_t  KRON_INT8_TO_INT16 (int8_t v);
int32_t  KRON_INT8_TO_INT32 (int8_t v);
float    KRON_INT8_TO_REAL  (int8_t v);

/*===========================================================================
 * FROM INT16 (int16_t → 7 types)
 *===========================================================================*/
bool     KRON_INT16_TO_BOOL  (int16_t v);
uint8_t  KRON_INT16_TO_UINT8 (int16_t v);
uint16_t KRON_INT16_TO_UINT16(int16_t v);
uint32_t KRON_INT16_TO_UINT32(int16_t v);
int8_t   KRON_INT16_TO_INT8  (int16_t v);
int32_t  KRON_INT16_TO_INT32 (int16_t v);
float    KRON_INT16_TO_REAL  (int16_t v);

/*===========================================================================
 * FROM INT32 (int32_t → 7 types)
 *===========================================================================*/
bool     KRON_INT32_TO_BOOL  (int32_t v);
uint8_t  KRON_INT32_TO_UINT8 (int32_t v);
uint16_t KRON_INT32_TO_UINT16(int32_t v);
uint32_t KRON_INT32_TO_UINT32(int32_t v);
int8_t   KRON_INT32_TO_INT8  (int32_t v);
int16_t  KRON_INT32_TO_INT16 (int32_t v);
float    KRON_INT32_TO_REAL  (int32_t v);

/*===========================================================================
 * FROM REAL (float → 7 types)
 *===========================================================================*/
bool     KRON_REAL_TO_BOOL  (float v);
uint8_t  KRON_REAL_TO_UINT8 (float v);
uint16_t KRON_REAL_TO_UINT16(float v);
uint32_t KRON_REAL_TO_UINT32(float v);
int8_t   KRON_REAL_TO_INT8  (float v);
int16_t  KRON_REAL_TO_INT16 (float v);
int32_t  KRON_REAL_TO_INT32 (float v);

#endif /* KRONCONVERTER_H */
