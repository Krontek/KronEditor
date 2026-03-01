#ifndef STANDARDFUNCTION_H
#define STANDARDFUNCTION_H

#include <stdbool.h>
#include <stdint.h>

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

// Function Prototypes
void TON_Call(TON *inst, TIME currentTime);
void TOF_Call(TOF *inst, TIME currentTime);
void CTU_Call(CTU *inst);

#endif // STANDARDFUNCTION_H
