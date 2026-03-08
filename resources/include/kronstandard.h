#ifndef KRONSTANDARD_H
#define KRONSTANDARD_H

#include <stdbool.h>
#include <stdint.h>
#define __int8_t_defined

#ifdef IN
#undef IN
#endif

// TIME is treated as milliseconds
typedef uint32_t TIME;

// Timer On Delay (TON)
typedef struct {
    TIME PT;        // Preset Time (32-bit)
    TIME ET;        // Elapsed Time (32-bit)
    TIME StartTime; // Internal start time (32-bit)
    bool IN;        // Input (1-bit / 8-bit)
    bool Q;         // Output (1-bit / 8-bit)
    bool M;         // Internal marker (1-bit / 8-bit)
} TON;

// Timer Off Delay (TOF)
typedef struct {
    TIME PT;        // Preset Time (32-bit)
    TIME ET;        // Elapsed Time (32-bit)
    TIME StartTime; // Internal start time (32-bit)
    bool IN;        // Input (1-bit / 8-bit)
    bool Q;         // Output (1-bit / 8-bit)
    bool M;         // Internal marker (1-bit / 8-bit)
} TOF;

// Count Up (CTU)
typedef struct {
    int16_t PV;     // Preset Value (16-bit)
    int16_t CV;     // Current Value (16-bit)
    bool CU;        // Count Up input (1-bit / 8-bit)
    bool RESET;     // Reset input (1-bit / 8-bit)
    bool Q;         // Output (CV >= PV) (1-bit / 8-bit)
    bool M;         // Edge marker (1-bit / 8-bit)
} CTU;

// Timer Pulse (TP)
typedef struct {
    TIME PT;        // Preset Time (32-bit)
    TIME ET;        // Elapsed Time (32-bit)
    TIME StartTime; // Internal start time (32-bit)
    bool IN;        // Input (1-bit / 8-bit)
    bool Q;         // Output (1-bit / 8-bit)
    bool M;         // Internal marker: timer is running (1-bit / 8-bit)
} TP;

// Count Down (CTD)
typedef struct {
    int16_t PV;     // Preset Value (16-bit)
    int16_t CV;     // Current Value (16-bit)
    bool CD;        // Count Down input (1-bit / 8-bit)
    bool LD;        // Load input: loads PV into CV (1-bit / 8-bit)
    bool Q;         // Output (CV <= 0) (1-bit / 8-bit)
    bool M;         // Edge marker (1-bit / 8-bit)
} CTD;

// Count Up/Down (CTUD)
typedef struct {
    int16_t PV;     // Preset Value (16-bit)
    int16_t CV;     // Current Value (16-bit)
    bool CU;        // Count Up input (1-bit / 8-bit)
    bool CD;        // Count Down input (1-bit / 8-bit)
    bool RESET;     // Reset input (1-bit / 8-bit)
    bool LD;        // Load input: loads PV into CV (1-bit / 8-bit)
    bool QU;        // Output Up (CV >= PV) (1-bit / 8-bit)
    bool QD;        // Output Down (CV <= 0) (1-bit / 8-bit)
    bool MU;        // Edge marker for CU (1-bit / 8-bit)
    bool MD;        // Edge marker for CD (1-bit / 8-bit)
} CTUD;

// Timer On Delay Retentive (TONR)
// Accumulates ET across multiple IN=true intervals.
// ET is retained when IN goes false.
// RESET clears ET and Q regardless of IN.
typedef struct {
    TIME PT;        // Preset Time (32-bit)
    TIME ET;        // Elapsed Time – accumulated (32-bit)
    TIME StartTime; // Virtual session start – internal (32-bit)
    bool IN;        // Input (1-bit / 8-bit)
    bool RESET;     // Reset: clears ET and Q (1-bit / 8-bit)
    bool Q;         // Output: true when ET >= PT (1-bit / 8-bit)
    bool M;         // Internal: timer is currently running (1-bit / 8-bit)
} TONR;

// Function Prototypes
void TON_Call (TON  *inst, TIME currentTime);
void TOF_Call (TOF  *inst, TIME currentTime);
void TP_Call  (TP   *inst, TIME currentTime);
void TONR_Call(TONR *inst, TIME currentTime);
void CTU_Call (CTU  *inst);
void CTD_Call (CTD  *inst);
void CTUD_Call(CTUD *inst);

#endif // KRONSTANDARD_H
