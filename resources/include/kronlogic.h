#ifndef KRONLOGIC_H
#define KRONLOGIC_H

#include <stdbool.h>
#include <stdint.h>
#define __int8_t_defined

/* =========================================================
 * Contacts (stateless combinational elements)
 *
 * Usage in ladder logic:
 *   bool rung = NO_Contact(sensor_A) && NC_Contact(fault_B);
 * ========================================================= */

/* Normally Open: passes true when bit is true */
bool NO_Contact(bool bit);

/* Normally Closed: passes true when bit is false */
bool NC_Contact(bool bit);

/* Invert: inverts the signal (same as NC on power flow) */
bool INV_Contact(bool input);

/* =========================================================
 * Coils (write output bit based on rung state)
 *
 * Usage:
 *   Normal_Coil(rung, &output_bit);
 * ========================================================= */

/* Normal Coil: output follows rung power */
void Normal_Coil(bool rung, bool *output);

/* Set Coil: latches output true when rung is true */
void Set_Coil(bool rung, bool *output);

/* Reset Coil: latches output false when rung is true */
void Reset_Coil(bool rung, bool *output);

/* =========================================================
 * SR Bistable (Set dominant)
 *
 * Truth table:
 *   S1=0, R=0  → Q1 unchanged
 *   S1=0, R=1  → Q1 = false
 *   S1=1, R=0  → Q1 = true
 *   S1=1, R=1  → Q1 = true  (Set dominant)
 * ========================================================= */
typedef struct {
    bool S1;    /* Set input - dominant */
    bool R;     /* Reset input */
    bool Q1;    /* Output */
} SR;

void SR_Call(SR *inst);

/* =========================================================
 * RS Bistable (Reset dominant)
 *
 * Truth table:
 *   S=0, R1=0  → Q1 unchanged
 *   S=0, R1=1  → Q1 = false
 *   S=1, R1=0  → Q1 = true
 *   S=1, R1=1  → Q1 = false  (Reset dominant)
 * ========================================================= */
typedef struct {
    bool S;     /* Set input */
    bool R1;    /* Reset input - dominant */
    bool Q1;    /* Output */
} RS;

void RS_Call(RS *inst);

/* =========================================================
 * Rising Edge Trigger (R_TRIG)
 *
 * Q is true for exactly one scan cycle on the rising edge of CLK.
 * ========================================================= */
typedef struct {
    bool CLK;   /* Clock input */
    bool Q;     /* Output: true for one scan on rising edge */
    bool M;     /* Internal: previous CLK state */
} R_TRIG;

void R_TRIG_Call(R_TRIG *inst);

/* =========================================================
 * Falling Edge Trigger (F_TRIG)
 *
 * Q is true for exactly one scan cycle on the falling edge of CLK.
 * ========================================================= */
typedef struct {
    bool CLK;   /* Clock input */
    bool Q;     /* Output: true for one scan on falling edge */
    bool M;     /* Internal: previous CLK state */
} F_TRIG;

void F_TRIG_Call(F_TRIG *inst);

#endif /* KRONLOGIC_H */
