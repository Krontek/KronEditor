# PLCopen Motion Control Part 1 v2.0 — the motion contract for KronEditor

This file is a **section-by-section digest of "PLCopen TC2 — Function blocks for motion control (formerly Part 1 and Part 2), Version 2.0, Published, March 17, 2011"**, written so the motion library (`resources/krontek-include/kronmotion.h`, `kron_axis.h`, the `.c` in `KrontekLibraries/`), the block definitions (`public/libraries/motion.xml`, `public/libraries/errors/motion_errors.xml`) and the motion codegen in `src/services/CTranspilerService.js` can be checked against it. Every rule cites its section (`§`), table (`T`) or figure (`F`) of the PDF so it can be re-read there.

⚠️ = a rule the library silently breaks if ignored. **B** = Basic pin (mandatory for compliance), **E** = Extended (optional), **V** = vendor-specific (§1.1.4). *impl* = the spec leaves it to the implementer (Kron must choose AND document the choice).

> Read the root [`CLAUDE.md`](../CLAUDE.md) first. Motion library internals: [`resources/krontek-include/CLAUDE.md`](../resources/krontek-include/CLAUDE.md). The language rules (FB call semantics, data types) come from [`iec61131-3.md`](iec61131-3.md).

---

## 0. How to use this file

1. **This spec is the contract of every `MC_*` block.** A change to a motion FB's pins, edge behaviour, outputs, buffering or the axis state machine is checked against the matching section below. If this file and the code disagree, the code is wrong **unless** the point is listed in §10 (Kron decisions) or is marked *impl*.
2. ⚠️ **Conflict protocol — if a developer request contradicts this file, WARN before implementing.** Name the section (e.g. "§3.3: MC_Stop has no `Acceleration` input"), state the conforming alternative, implement the non-conforming variant only after explicit confirmation, and record it in §10.
3. **Open the PDF for anything not quoted here** — never state a PLCopen rule from memory (root `CLAUDE.md`). The PDF lives outside the repo: `~/Documents/KronLibraries/KronMotion/PLCopen_Motion_Control_Part_1_version_2.0.pdf`. Grep: `pdftotext -layout <pdf> - | grep -n MC_Halt`. The figures (state diagram F2 on page 15, timing diagrams) are drawings — render the page (`pdftoppm -f 15 -l 15 -r 110 -png <pdf> /tmp/p`) and read the image.
4. **A missing capability must FAIL LOUDLY** (root `CLAUDE.md`): an unsupported mode/input sets `Error`+`ErrorID`, never silently degrades. A block that behaves differently from the spec must not carry the `MC_` name (§2.4.1 "FB Naming" allows `MC_FBname_SupplierID` only for multiple libraries; a different behaviour needs a different name).
5. **Not covered here:** Part 3 (User Guidelines), Part 4 (Coordinated Motion), Part 5 (Homing — `MC_Home` refers to it for the StepHoming FBs), Part 6 (Fluid Power). Kron implements none of them; open the respective document before claiming anything about them.

---

## 1. What KronMotion implements

Source: `resources/krontek-include/kronmotion.h` (one struct + `MC_Xxx_Call(inst, axis)` per FB, `REAL` → `double`).

| Spec FB (§) | Kron |
|---|---|
| MC_Power (3.1), MC_Home (3.2), MC_Stop (3.3), MC_Halt (3.4) | ✅ |
| MC_MoveAbsolute (3.5), MC_MoveRelative (3.6), MC_MoveAdditive (3.7) | ✅ |
| MC_MoveSuperimposed (3.8), MC_HaltSuperimposed (3.9), MC_MoveVelocity (3.10) | ✅ |
| MC_MoveContinuousAbsolute / Relative (3.11/3.12) | ❌ (§3.11 note: replaceable by MoveAbsolute + MoveVelocity with BufferMode) |
| MC_TorqueControl (3.13) | ❌ |
| MC_PositionProfile / VelocityProfile / AccelerationProfile (3.14–3.16) | ❌ |
| MC_SetPosition (3.17), MC_SetOverride (3.18) | ✅ |
| MC_Read/WriteParameter, MC_Read/WriteBoolParameter (3.19/3.20) | ✅ |
| MC_ReadDigitalInput / ReadDigitalOutput / WriteDigitalOutput (3.21–3.23) | ❌ |
| MC_ReadActualPosition / Velocity / Torque (3.24–3.26) | ✅ |
| MC_ReadStatus (3.27), MC_ReadMotionState (3.28), MC_ReadAxisInfo (3.29), MC_ReadAxisError (3.30) | ✅ |
| MC_Reset (3.31) | ✅ |
| MC_DigitalCamSwitch (3.32), MC_TouchProbe (3.33), MC_AbortTrigger (3.34) | ❌ |
| All multi-axis FBs (ch. 4: CamTableSelect, CamIn/Out, GearIn/Out, GearInPos, PhasingAbsolute/Relative, CombineAxes) | ❌ |

A ❌ FB must not appear in `motion.xml` as if it worked; adding one means implementing the full B pin set of its table below.

---

## 2. The model (§2)

- A **set of command-oriented FBs referencing the axis** (`AXIS_REF`), not one FB per axis (§2). The spec defines the interface ("look-and-feel / proxy"), **not** the internal operation.
- ⚠️ **Motion commands are always taken sequentially**, even on a parallel PLC; they act on the axis state diagram (§2.1).
- A state change is reflected **immediately** when the command is issued (response time system dependent) (§2.1).
- Multi-axis FBs are seen as several single axes in specific states: master e.g. `ContinuousMotion`, slave `SynchronizedMotion`. **Connecting a slave has no influence on the master** (§2.1).

### 2.1 State diagram (F2, normative)

States: `Disabled` (initial), `Standstill`, `Homing`, `Stopping`, `DiscreteMotion`, `ContinuousMotion`, `SynchronizedMotion`, `ErrorStop`.

Commands that put the axis in each motion state (also allowed when already in it):
- **DiscreteMotion**: MC_MoveAbsolute, MC_MoveRelative, MC_MoveAdditive, MC_PositionProfile, MC_Halt, (MC_MoveSuperimposed)
- **ContinuousMotion**: MC_MoveVelocity, MC_VelocityProfile, MC_AccelerationProfile, MC_TorqueControl, MC_MoveContinuousAbsolute, MC_MoveContinuousRelative
- **SynchronizedMotion** (slave): MC_GearIn, MC_GearInPos, MC_CamIn, MC_CombineAxes
- **Homing**: MC_Home (from Standstill only)
- **Stopping**: MC_Stop

Transitions drawn in F2 (full arrow = command, dashed = command finished / system):
- Standstill → DiscreteMotion / ContinuousMotion / SynchronizedMotion / Homing / Stopping.
- DiscreteMotion ↔ ContinuousMotion ↔ SynchronizedMotion ↔ DiscreteMotion (all three pairs, both directions).
- DiscreteMotion / ContinuousMotion / SynchronizedMotion / Homing → Stopping (MC_Stop).
- DiscreteMotion → Standstill **dashed "Done"**; Homing → Standstill **dashed "Done"**.
- ⚠️ **Homing has no arrow to any motion state** — only to Stopping and (Done) Standstill. ContinuousMotion and SynchronizedMotion have **no Done arrow** to Standstill (they never end by themselves).
- Stopping → Standstill: **Note 6** `MC_Stop.Done = TRUE AND MC_Stop.Execute = FALSE`.
- Any state → ErrorStop: **Note 1** "an error in the axis occurred".
- Any state → Disabled: **Note 2** `MC_Power.Enable = FALSE` and no error in the axis.
- ErrorStop → Disabled: **Note 3** `MC_Reset AND MC_Power.Status = FALSE`.
- ErrorStop → Standstill: **Note 4** `MC_Reset AND MC_Power.Status = TRUE AND MC_Power.Enable = TRUE`.
- Disabled → Standstill: **Note 5** `MC_Power.Enable = TRUE AND MC_Power.Status = TRUE`.

State remarks (§2.1):
- **Disabled** — FBs do not influence movement; power off, no error. MC_Power Enable=TRUE → Standstill; axis feedback is operational *before* Standstill. Enable=FALSE in any state except ErrorStop → Disabled, directly or via another state; ⚠️ **ongoing motion commands are aborted (`CommandAborted`)**.
- **ErrorStop** — highest priority; power may be on or off and changeable via MC_Power, but the state stays ErrorStop while the error is pending. Intention: the axis stops if possible. ⚠️ **No further motion command is accepted until a reset from ErrorStop.** The transition refers to errors of the **axis / axis control, not of FB instances** (an instance error does not necessarily bring the axis to ErrorStop, §2.4.1).
- **Standstill** — power on, no error, no motion command active.
- **MC_Stop** in Standstill → Stopping, back to Standstill when Execute=FALSE; Stopping held while Execute is TRUE; `Done` set when the stop ramp finished.
- **MC_MoveSuperimposed** in Standstill → DiscreteMotion; in any other state the state is not influenced.
- **MC_GearOut / MC_CamOut** change the slave from SynchronizedMotion to ContinuousMotion; issued in any other state → **error**.

FBs **not in the state diagram — calling them never changes the state** (§2.1): MC_ReadStatus, MC_ReadAxisError, MC_ReadParameter, MC_ReadBoolParameter, MC_WriteParameter, MC_WriteBoolParameter, MC_ReadDigitalInput, MC_ReadDigitalOutput, MC_WriteDigitalOutput, MC_ReadActualPosition, MC_ReadActualVelocity, MC_ReadActualTorque, MC_ReadMotionState, MC_SetPosition, MC_SetOverride, MC_AbortTrigger, MC_TouchProbe, MC_DigitalCamSwitch, MC_CamTableSelect, MC_ReadAxisInfo, MC_PhasingRelative, MC_PhasingAbsolute, MC_HaltSuperimposed.

### 2.2 Error handling (§2.2)
- Input checking is inside the FBs, **how is *impl*** — e.g. Velocity 10 000 against MaxVelocity 6 000: "either the system slows down or an error is generated" (§2.2). Whatever Kron picks is documented in §10.
- Centralized (one MC_ReadAxisError) and decentralized (per-instance Error/ErrorID) handling must both be possible (§2.2.1).
- ⚠️ **Buffered commands and ErrorStop (§2.2.2):** all buffered commands are aborted when the axis goes to ErrorStop; the `Error` output of the aborted FBs is SET; subsequent commands are rejected with `Error` (action not allowed). After MC_Reset the axis can be commanded again.
- ⚠️ **An FB's own error does not cancel the queue (§2.2.2 case 2):** if FB1 sets `Error` (e.g. invalid parameters), a buffered FB2 **becomes active and executes immediately afterwards** — the application handles it.
- `Enable` FBs (§2.2.3, F5/F6): an error that clears by itself resets `Valid` while `Busy` stays high, and `Valid` returns after the error; an error that cannot be cleared automatically resets `Busy` and `Valid` and **needs a new rising edge of `Enable`**.

### 2.3 Value levels (§2.3)
- **Commanded** value — from the FB inputs, input to the profile generator.
- **Set** value — latest profile-generator output about to be sent to the servo loop.
- **Actual** value — latest value from the feedback system.

---

## 3. General FB interface rules (§2.4.1, Table 2) — apply to EVERY MC block

| Topic | Rule |
|---|---|
| Input parameters | `Execute` without `ContinuousUpdate`: inputs latched at the **rising edge** of Execute; to change them, change and re-trigger Execute. With `ContinuousUpdate`: latched at the rising edge, then modifiable continuously while ContinuousUpdate is SET. `Enable`: used at the rising edge and modifiable continuously. |
| Inputs exceeding application limits | the system limits them **or** the instance errors; consequences for the axis are application specific. |
| Missing inputs | per IEC 61131-3, an unconnected input keeps the previous invocation's value; first invocation uses the initial value (§1.1.4 note: "typically 0"). |
| Acceleration/Deceleration/Jerk = 0 | *impl* — error, warning, editor inhibit, take AXIS_REF/drive value, or maximum value are all listed as possible. "Use with caution". |
| ⚠️ Output exclusivity (Execute) | `Busy`, `Done`, `Error`, `CommandAborted` are mutually exclusive; **if Execute is TRUE one of them has to be TRUE**. Only one of `Active`, `Error`, `Done`, `CommandAborted` at a time — **except MC_Stop, where Active and Done may both be set**. |
| Output exclusivity (Enable) | `Valid` and `Error` are mutually exclusive. |
| ⚠️ Output status (Execute) | `Done`, `Error`, `ErrorID`, `CommandAborted` reset with the **falling edge of Execute**; the falling edge **does not stop or influence the execution**. Each of these outputs must be set for **at least one cycle** even if Execute was reset before completion. A new Execute on the same instance before it finished → **no Done/CommandAborted for the previous action**. |
| Output status (Enable) | `Valid`, `Enabled`, `Busy`, `Error`, `ErrorID` reset with the falling edge of Enable "as soon as possible". |
| Done | set when the commanded action completed successfully; an interrupted movement **never sets Done** of the first FB. |
| Busy (Execute) | SET at the rising edge of Execute, RESET when Done, Aborted or Error is set. Keep the FB called while Busy is TRUE. |
| Busy (Enable) | SET at the rising edge of Enable, stays SET while the FB performs any action. |
| ⚠️ InVelocity/InGear/InTorque/InSync ("Inxxx") | different from Done: while the FB is Active, SET when the **set value equals the commanded value**, RESET when they later differ. Updated **even if Execute is low** as long as the FB has control (Active and Busy). Refers to the **internal instantaneous setpoint, not the actual axis value**. Behaviour right after a re-triggered Execute while the condition already holds is *impl* (also §2.5 note). |
| Active | **required on buffered FBs**; set when the FB takes control of the axis. Un-buffered: Active and Busy may have the same value. Per axis several FBs may be Busy but **only one Active** — exceptions: FBs meant to run in parallel (MC_MoveSuperimposed, MC_Phasing*). |
| CommandAborted | set when the motion is interrupted by another motion command; resets like Done; when it occurs the other outputs such as InVelocity are reset. |
| Enable / Valid | Enable is level sensitive; Valid = a valid output set is available while Enable is TRUE; an FB error → Valid FALSE, returns when the error disappears. |
| Position vs distance | Position = value in a coordinate system; Distance = difference between two positions. |
| ⚠️ Sign rules | **Acceleration, Deceleration and Jerk are always positive. Velocity, Position and Distance can be positive and negative.** |
| Error / ErrorID | rising edge of `Error` = an error occurred during execution; `ErrorID` = identification (E). Done and Inxxx are logically exclusive to Error. Error types: FB (parameters out of range, state machine violation), communication, drive. Error outputs reset with the falling edge of Execute/Enable; on Enable FBs they may reset during operation. |
| Naming | multiple libraries: `MC_FBname_SupplierID`. Enum elements carry the `mc` prefix (`mcPositive…`) to avoid clashing with user variables. Short names (§1.1.5: Cmd, Pos, Vel, Acc, Decel, Abs, Rel, Act, SupImp, Add, Par, Cont, RatioNumM1, RatioDenM1) stay compliant but must be listed in the certification. |

F7 (Execute/Done) and F8 (Execute/Inxxx) are the timing diagrams of these rules — render pages 21–22.

### 3.1 Why Execute is edge sensitive (§2.4.5)
A rising edge lets new inputs be commanded while a previous command runs, giving precise control of the instant a command starts; `Done` chains the next FB (F9).

### 3.2 ContinuousUpdate (§2.4.6)
- Extended input on all applicable FBs. If TRUE at the rising edge of Execute, the FB applies the **current** input values to the ongoing movement while it stays TRUE. It does not change the general behaviour or the state diagram; its effect ends when the FB is no longer Busy or ContinuousUpdate goes FALSE.
- FALSE at the rising edge → input changes are ignored for the whole movement.
- ⚠️ It is **not a re-trigger**: re-triggering a finished/aborted FB regains control and changes the state diagram; ContinuousUpdate only affects the ongoing movement.
- ⚠️ **Relative inputs always refer to the initial condition at the rising edge of Execute** — example: MC_MoveRelative from 0, Distance 100 → changed to 130 at position 50 → the axis stops at **130**, sets Done, accepts no new values.

### 3.3 Data types and units (§1.1.4, §2.4.3, §2.4.4)
- `REAL` may be exchanged for SINT, INT, DINT or LREAL **if consistent for the whole set** of FBs and parameters. Types may be widened keeping the basic type (WORD → DWORD ok, WORD → REAL not).
- Each FB input has a defined initial value, typically 0 (§1.1.4 note).
- **AXIS_REF** is a structure, VAR_IN_OUT of every MC FB; content and refresh rate *impl*, may be empty. Switching the AXIS_REF of an active FB is allowed by IEC but platform dependent and "not encouraged".
- Units: only the length unit `[u]` is specified as coherent with its derivatives — velocity `[u/s]`, acceleration `[u/s²]`, jerk `[u/s³]`; `[u]` itself is manufacturer dependent.

---

## 4. BufferMode (§2.4.2, Table 3, Table 4)

- Non-buffered (default) acts immediately, even if it interrupts another motion; **the buffer is cleared**. Buffered waits until the current FB sets Done (or InPosition, InVelocity, …).

| No. | MC_BUFFER_MODE | Meaning |
|---|---|---|
| 0 | `mcAborting` | start immediately (default); aborts the ongoing motion, buffer cleared |
| 1 | `mcBuffered` | start after the current motion has finished (Done); no blending |
| 2 | `mcBlendingLow` | as Buffered but the axis does not stop; blend with the **lowest** velocity of both FBs at end-position 1 |
| 3 | `mcBlendingPrevious` | blend with the velocity of FB 1 at end-position of FB 1 |
| 4 | `mcBlendingNext` | blend with the velocity of FB 2 at end-position of FB 1 |
| 5 | `mcBlendingHigh` | blend with the **highest** velocity of both FBs at end-position of FB 1 |

These numbers ARE normative (Table 3). Supplier extensions only **after** the defined values.

Table 4 — can it be buffered / can it be followed by a buffered FB / which signal releases the next one:

| FB | Buffered? | Followed by buffered? | Release signal |
|---|---|---|---|
| MC_Power | No | Yes | Status |
| MC_Home | Yes | Yes | Done |
| MC_Stop | No | Yes | **Done AND NOT Execute** |
| MC_Halt | Yes | Yes | Done |
| MC_MoveAbsolute / Relative / Additive | Yes | Yes | Done |
| MC_MoveSuperimposed, MC_HaltSuperimposed | No | No | — |
| MC_MoveVelocity | Yes | Yes | InVelocity |
| MC_MoveContinuousAbsolute / Relative | Yes | Yes | InEndVelocity |
| MC_TorqueControl | Yes | Yes | InTorque |
| MC_Position/Velocity/AccelerationProfile | Yes | Yes | Done |
| MC_CamIn | Yes | Yes (single mode) | EndOfProfile |
| MC_CamOut, MC_GearOut | No | Yes | Done |
| MC_GearIn | Yes | Yes | InGear |
| MC_GearInPos, MC_CombineAxes | Yes | Yes | InSync |
| MC_PhasingRelative / Absolute | Yes | No | — |

- Administrative FBs not listed are basically neither buffered nor followed by a buffered FB; a supplier may support it anyway.
- An abort may leave too little braking distance under deceleration limits. A modulo axis may go to the earliest repetition of the absolute position instead of reversing; a linear axis resolves overshoot by reversing (§2.4.2).
- Appendix A (F56–F63) shows each mode as a timing diagram (render pages 111–117). Note to Example 6: with a 2nd FB being MC_MoveVelocity, **all blending modes should work like BlendingPrevious or create an error**.
- `MC_EXECUTION_MODE` (MC_SetPosition, MC_Write(Bool)Parameter, MC_WriteDigitalOutput, MC_CamTableSelect): `mcImmediately` (default — valid immediately, may influence the ongoing motion but not the state) / `mcQueued` (same as BufferMode Buffered). **No numeric values are given in the spec.**

---

## 5. Single-axis FBs (ch. 3)

Each table lists **B pins** (mandatory) and *E pins* (optional). Every FB has `Axis : AXIS_REF` as VAR_IN_OUT (B). Unless stated, outputs `Error` (B, BOOL) and `ErrorID` (E, WORD) exist, and Execute FBs have `Busy` (E).

### 5.1 MC_Power (§3.1)
- In: **Enable** BOOL; *EnablePositive*, *EnableNegative* BOOL (level sensitive, both may be TRUE; permit motion in that direction as long as Enable is TRUE).
- Out: **Status** BOOL (effective state of the power stage), *Valid*, **Error**, *ErrorID*.
- Enable enables the **power stage in the drive**, not the FB. Enable=TRUE in Disabled → Standstill. Power failure (also during operation) → ErrorStop. ⚠️ **Only one MC_Power per axis.** A timer on Enable AND NOT Status may detect a power-stage hardware problem.

### 5.2 MC_Home (§3.2)
- In: **Execute**, **Position** REAL (absolute position set when the reference signal is detected), *BufferMode*.
- Out: **Done** (reference known and set), *Busy*, *Active*, *CommandAborted*, **Error**, *ErrorID*.
- The search sequence is manufacturer dependent, configured by axis parameters. **Completes at Standstill if it was started in Standstill.** Generic FB; StepHoming FBs are Part 5.

### 5.3 MC_Stop (§3.3)
- In: **Execute**, *Deceleration* REAL, *Jerk* REAL. ⚠️ **No Acceleration, no BufferMode.**
- Out: **Done** (zero velocity reached), *Busy*, *CommandAborted* ("aborted by switching off power — **only possibility to abort**"), **Error**, *ErrorID*.
- Transfers the axis to Stopping and **aborts any ongoing FB**. While Stopping, **no other FB can perform motion** on the axis (F16: MC_MoveVelocity issued during it reports an error). Done is set immediately at zero velocity; the axis stays Stopping while Execute is TRUE or velocity ≠ 0; Done AND NOT Execute → Standstill.
- Notes: primarily for emergency stop / exception situations; Deceleration = 0 is *impl*.

### 5.4 MC_Halt (§3.4)
- In: **Execute**, *Deceleration*, *Jerk*, *BufferMode*. ⚠️ **No Acceleration.**
- Out: **Done** (zero velocity reached), *Busy*, *Active*, *CommandAborted*, **Error**, *ErrorID*.
- Controlled stop under **normal** operation: axis goes to **DiscreteMotion** until velocity is zero, then Done → Standstill. ⚠️ Unlike MC_Stop, **another motion command may abort it** during deceleration (non-buffered) and run immediately — the axis may re-accelerate without reaching Standstill (F17).

### 5.5 MC_MoveAbsolute (§3.5)
- In: **Execute**, *ContinuousUpdate*, **Position** REAL (signed), **Velocity** REAL (maximum, not necessarily reached), *Acceleration*, *Deceleration*, *Jerk* (all positive), **Direction** MC_DIRECTION (`mcPositiveDirection`, `mcShortestWay`, `mcNegativeDirection`, `mcCurrentDirection`), *BufferMode*.
- Out: **Done** (commanded position finally reached), *Busy*, *Active*, *CommandAborted*, **Error**, *ErrorID*.
- Completes with velocity zero if nothing further is pending. **Direction is ignored when only one mathematical solution exists** (linear axis). Modulo axis: valid positions `[0, 360[` or the corresponding range; the application may shift into range. `mcShortestWay` decides from the position at command time.
- Note: Direction is **B** here (it is E on MoveVelocity, MoveContinuousAbsolute, TorqueControl).

### 5.6 MC_MoveRelative (§3.6)
- In: **Execute**, *ContinuousUpdate*, **Distance** REAL, *Velocity*, *Acceleration*, *Deceleration*, *Jerk*, *BufferMode*. (No Direction.)
- Out: **Done** (commanded distance reached), *Busy*, *Active*, *CommandAborted*, **Error**, *ErrorID*.
- ⚠️ Distance is relative to the **set position at the time of execution**. F19: aborting at actual position 3250 with Distance 4000 → target **7250** (contrast MoveAdditive).

### 5.7 MC_MoveAdditive (§3.7)
- Pins identical to MC_MoveRelative.
- ⚠️ In DiscreteMotion the distance is added to the **most recent commanded position** (possibly of an aborted MoveAdditive). F20: aborting a move to 6000 with Distance 4000 → target **10000**. In ContinuousMotion it is added to the set position at the time of execution.

### 5.8 MC_MoveSuperimposed (§3.8)
- In: **Execute**, *ContinuousUpdate*, **Distance** REAL, *VelocityDiff* REAL, *Acceleration*, *Deceleration*, *Jerk*. (No BufferMode.)
- Out: **Done**, *Busy*, *CommandAborted*, **Error**, *ErrorID*, *CoveredDistance* REAL (the pin diagram also shows *Active*).
- The existing motion is not interrupted; the additional motion is superimposed.
- ⚠️ Any other command in **aborting** mode (except another MoveSuperimposed) aborts **both** the superimposed and the underlying motion; in any other mode the underlying one is not aborted. A new MoveSuperimposed aborts only the running superimposed one.
- In Standstill it acts like MC_MoveRelative. Acceleration/Deceleration/Jerk are **additional** to the underlying motion, so the underlying FB finishes in the same time. `Active` behaves differently from buffered FBs. It may continue after the underlying discrete motion is finished (F23).

### 5.9 MC_HaltSuperimposed (§3.9)
- In: **Execute**, *Deceleration*, *Jerk*. Out: **Done** (superimposed motion halted), *Busy*, *CommandAborted*, **Error**, *ErrorID* (pin diagram also shows *Active*).
- Halts all superimposed motions; the underlying motion is not interrupted.

### 5.10 MC_MoveVelocity (§3.10)
- In: **Execute**, *ContinuousUpdate*, **Velocity** REAL — ⚠️ **"Can be a signed value"**, *Acceleration*, *Deceleration*, *Jerk*, *Direction* (`mcPositiveDirection`, `mcNegativeDirection`, `mcCurrentDirection`; shortest way not applicable), *BufferMode*.
- Out: **InVelocity**, *Busy*, *Active*, *CommandAborted*, **Error**, *ErrorID*.
- Never-ending; stopped only by another FB. InVelocity is reset when aborted. ⚠️ **"Negative velocity * negative direction = positive velocity."** With MoveSuperimposed, InVelocity stays SET while this FB's contribution equals its commanded velocity.
- F24 note: the 2nd FB in Aborting mode; in Buffered it would first reach 3000.

### 5.11 MC_MoveContinuousAbsolute / MC_MoveContinuousRelative (§3.11/3.12)
- In: **Execute**, *ContinuousUpdate*, **Position** (Abs) / **Distance** (Rel), **EndVelocity** REAL (signed), **Velocity** REAL, *Acceleration*, *Deceleration*, *Jerk*, *Direction* (Abs only, 4 values), *BufferMode*.
- Out: **InEndVelocity** (reached and running at end velocity), *Busy*, *Active*, *CommandAborted*, **Error**, **ErrorID** (B here).
- After reaching the position the axis keeps running at EndVelocity; state **ContinuousMotion**.

### 5.12 MC_TorqueControl (§3.13)
- In: **Execute**, *ContinuousUpdate*, **Torque** REAL (signed), *TorqueRamp* REAL [u/s], *Velocity* (absolute limit, always positive), *Acceleration*, *Deceleration*, *Jerk*, *Direction*, *BufferMode*. Out: **InTorque**, *Busy*, *Active*, *CommandAborted*, **Error**, *ErrorID*.
- Positive torque acts in the positive velocity direction. Motion is limited by velocity/acc/dec/jerk or by torque. The axis leaves torque mode when **any motion (not administrative) FB** is accepted on it.

### 5.13 MC_PositionProfile / VelocityProfile / AccelerationProfile (§3.14–3.16)
- VAR_IN_OUT **TimePosition** `MC_TP_REF` / **TimeVelocity** `MC_TV_REF` / **TimeAcceleration** `MC_TA_REF` (supplier-specific; examples use `NumberOfPairs : WORD` + `ARRAY[1..N]` of `{DeltaTime : TIME; Value : REAL}`, MC_TP also `IsAbsolute`).
- In: **Execute**, *ContinuousUpdate*, *TimeScale*, *PositionScale* / *VelocityScale* / *AccelerationScale*, *Offset*, *BufferMode*. Out: **Done** (Position) / **ProfileCompleted** (Velocity, Acceleration), *Busy*, *Active*, *CommandAborted*, **Error**, *ErrorID*.
- Velocity profile keeps the last velocity (ContinuousMotion); acceleration profile ends with acceleration 0, velocity kept (ContinuousMotion). Alternative: CamIn on a virtual master.

### 5.14 MC_SetPosition (§3.17)
- In: **Execute**, **Position** REAL (a distance if Relative), *Relative* BOOL (default FALSE = absolute), *ExecutionMode*. Out: **Done**, *Busy*, **Error**, *ErrorID*.
- Shifts the coordinate system by changing **both set-point and actual position by the same value, causing no movement** (same following error). Usable during motion without changing the commanded position. Relative: Position is **added to the actual position**; absolute: actual position := Position. Not in the state diagram.

### 5.15 MC_SetOverride (§3.18)
- In: **Enable**, **VelFactor** REAL, *AccFactor*, *JerkFactor*. Out: **Enabled**, *Busy*, **Error**, *ErrorID*.
- Factors on commanded velocity, acceleration (both signs) and jerk of the whole axis. Valid until a new override is set; **defaults 1.0**. Range 0.0–1.0; > 1.0 vendor specific; **< 0.0 not allowed; 0.0 not allowed for AccFactor and JerkFactor** (F36 point 4: no change, Error set). ⚠️ VelFactor 0.0 **stops the axis without bringing it to Standstill**. Does not act on slave axes (SynchronizedMotion); does not change the state; VelFactor acts directly on the ongoing motion. Reducing AccFactor/JerkFactor in discrete motion **may overshoot the position**. With Profile FBs: vendor specific. Enable reset → "it should keep the last value".

### 5.16 MC_ReadParameter / MC_ReadBoolParameter / MC_WriteParameter / MC_WriteBoolParameter (§3.19/3.20)
- Read: In **Enable**, **ParameterNumber** INT. Out **Valid**, *Busy*, **Error**, *ErrorID*, **Value** REAL / BOOL. ReadParameter may be implemented as a Function (§1.1.2).
- Write: In **Execute** (write at rising edge), **ParameterNumber** INT, **Value** REAL / BOOL, *ExecutionMode*. Out **Done**, *Busy*, **Error**, *ErrorID*.
- Table 5 (standardized parameters; "suppliers should use these if offering the functionality"):

| PN | Name | Type | B/E | R/W |
|---|---|---|---|---|
| 1 | CommandedPosition | REAL | B | R |
| 2 | SWLimitPos | REAL | E | R/W |
| 3 | SWLimitNeg | REAL | E | R/W |
| 4 | EnableLimitPos | BOOL | E | R/W |
| 5 | EnableLimitNeg | BOOL | E | R/W |
| 6 | EnablePosLagMonitoring | BOOL | E | R/W |
| 7 | MaxPositionLag | REAL | E | R/W |
| 8 | MaxVelocitySystem | REAL | E | R |
| 9 | MaxVelocityAppl | REAL | B | R/W |
| 10 | ActualVelocity | REAL | B | R |
| 11 | CommandedVelocity | REAL | B | R |
| 12 | MaxAccelerationSystem | REAL | E | R |
| 13 | MaxAccelerationAppl | REAL | E | R/W |
| 14 | MaxDecelerationSystem | REAL | E | R |
| 15 | MaxDecelerationAppl | REAL | E | R/W |
| 16 | MaxJerkSystem | REAL | E | R |
| 17 | MaxJerkAppl | REAL | E | R/W |

- **0–999 reserved for the standard; > 999 supplier specific.** Read-only parameters may be writable during initialization (supplier dependent).

### 5.17 Digital I/O (§3.21–3.23)
- MC_ReadDigitalInput: VAR_IN_OUT **Input** `MC_INPUT_REF`; In **Enable**, *InputNumber* INT; Out **Valid**, *Busy*, **Error**, *ErrorID*, **Value** BOOL. A short pulse may be missed between cycles.
- MC_ReadDigitalOutput: VAR_IN_OUT **Output** `MC_OUTPUT_REF`; In **Enable**, *OutputNumber*; Out as above.
- MC_WriteDigitalOutput: VAR_IN_OUT **Output**; In **Execute**, *OutputNumber*, **Value** BOOL, *ExecutionMode*; Out **Done**, *Busy*, **Error**, *ErrorID*. Writes once at the rising edge.

### 5.18 Read FBs (§3.24–3.30) — all: In **Enable**; Out **Valid**, *Busy*, **Error**, *ErrorID* plus:
- **MC_ReadActualPosition**: **Position** REAL.
- **MC_ReadActualVelocity**: **Velocity** REAL (signed). Enable reset → data invalid, **all outputs reset**.
- **MC_ReadActualTorque**: **Torque** REAL (signed).
- **MC_ReadStatus**: **ErrorStop**, **Disabled**, **Stopping**, *Homing*, **Standstill**, *DiscreteMotion*, *ContinuousMotion*, *SynchronizedMotion* (BOOL each).
- **MC_ReadMotionState**: In *Source* `MC_SOURCE` (`mcCommandedValue`, `mcSetValue`, `mcActualValue`); Out *ConstantVelocity* (may be 0; window for actual values vendor specific), *Accelerating*, *Decelerating* (of |velocity|), *DirectionPositive*, *DirectionNegative* (position increasing/decreasing).
- **MC_ReadAxisInfo**: *HomeAbsSwitch*, *LimitSwitchPos*, *LimitSwitchNeg*, *Simulation*, *CommunicationReady*, *ReadyForPowerOn*, *PowerOn*, *IsHomed*, *AxisWarning*.
- **MC_ReadAxisError**: **ErrorID** is **B** here; *AxisErrorID* WORD (vendor specific values). Presents axis/drive/communication errors not related to FBs.

### 5.19 MC_Reset (§3.31)
- In: **Execute**. Out: **Done** (Standstill or Disabled reached), *Busy*, **Error**, *ErrorID*.
- ErrorStop → Standstill or Disabled (Notes 3/4 of F2) by resetting all internal axis-related errors; **it does not affect the outputs of the FB instances**. Use in other states than ErrorStop is vendor specific.

### 5.20 MC_DigitalCamSwitch, MC_TouchProbe, MC_AbortTrigger (§3.32–3.34)
- DigitalCamSwitch: VAR_IN_OUT **Switches** `MC_CAMSWITCH_REF`, *Outputs* `MC_OUTPUT_REF` (max 32), *TrackOptions* `MC_TRACK_REF`; In **Enable**, *EnableMask* DWORD, *ValueSource* MC_SOURCE; Out **InOperation**, *Busy*, **Error**, *ErrorID*. Switch elements: **TrackNumber** INT, **FirstOnPosition**, **LastOnPosition** REAL, *AxisDirection* (0 both, 1 pos, 2 neg), *CamSwitchMode* (0 position, 1 time), *Duration* TIME; track: *OnCompensation*, *OffCompensation* TIME (may be negative), *Hysteresis* REAL.
- TouchProbe: VAR_IN_OUT *TriggerInput* `MC_TRIGGER_REF`; In **Execute**, *WindowOnly*, *FirstPosition*, *LastPosition* (both included); Out **Done**, *Busy*, *CommandAborted* (by MC_AbortTrigger), **Error**, *ErrorID*, **RecordedPosition**. Single shot: only the first event after the rising edge counts. Modulo windows with First > Last wrap (F41).
- AbortTrigger: VAR_IN_OUT *TriggerInput*; In **Execute**; Out **Done**, *Busy*, **Error**, *ErrorID*.

---

## 6. Multi-axis FBs (ch. 4) — interfaces only, none implemented

All take **Master** and **Slave** `AXIS_REF` (B; E on CamTableSelect). Open the PDF before implementing any of them.
- **MC_CamTableSelect** (§4.2): VAR_IN_OUT **CamTable** `MC_CAM_REF`; In **Execute**, *Periodic*, *MasterAbsolute*, *SlaveAbsolute*, *ExecutionMode*; Out **Done**, *Busy*, **Error**, *ErrorID*, *CamTableID* `MC_CAM_ID`. Periodic = repeat the profile even if it does not match the modulo; non-periodic = once, slave stays synchronized at the last position (§4.1). Tables strictly monotonic; may be changed while running.
- **MC_CamIn** (§4.3): In **Execute**, *ContinuousUpdate*, *MasterOffset*, *SlaveOffset*, *MasterScaling*, *SlaveScaling* (default 1.0), *MasterStartDistance*, *MasterSyncPosition*, *StartMode* (`mcAbsolute`, `mcRelative`, `mcRampIn`), *MasterValueSource*, *CamTableID*, *BufferMode*; Out **InSync**, *Busy*, *Active*, *CommandAborted*, **Error**, *ErrorID*, *EndOfProfile* (pulse).
- **MC_CamOut** / **MC_GearOut** (§4.4/4.6): Slave only; In **Execute**; Out **Done**, *Busy*, **Error**, *ErrorID*. Default afterwards: maintain last velocity; no FB controls the slave until the next one.
- **MC_GearIn** (§4.5): In **Execute**, *ContinuousUpdate*, **RatioNumerator** INT, **RatioDenominator** UINT, *MasterValueSource*, *Acceleration*, *Deceleration*, *Jerk*, *BufferMode*; Out **InGear**, *Busy*, *Active*, *CommandAborted*, **Error**, *ErrorID*. Lost distance is not caught up; ratio change by a new GearIn without GearOut.
- **MC_GearInPos** (§4.7): adds **MasterSyncPosition**, **SlaveSyncPosition**, *SyncMode*, *MasterStartDistance*, *Velocity*; Out *StartSync*, **InSync**, …
- **MC_PhasingAbsolute / Relative** (§4.8/4.9): In **Execute**, **PhaseShift**, *Velocity*, *Acceleration*, *Deceleration*, *Jerk*, *BufferMode*; Out **Done**, …, *AbsolutePhaseShift* / *CoveredPhaseShift*. Shift is seen by the slave only.
- **MC_CombineAxes** (§4.10): **Master1**, **Master2**, **Slave**; *CombineMode* (`mcAddAxes`, `mcSubAxes`), gear ratios per master, *MasterValueSourceM1/M2*; Out **InSync**, …

---

## 7. Enumerations and derived types (Appendix B 2)

| Type | Values in the spec | Numeric values? |
|---|---|---|
| MC_BUFFER_MODE | mcAborting, mcBuffered, mcBlendingLow, mcBlendingPrevious, mcBlendingNext, mcBlendingHigh | **yes, 0–5 (T3)** |
| MC_DIRECTION | mcPositiveDirection, mcShortestWay, mcNegativeDirection, mcCurrentDirection | no — *impl* |
| MC_EXECUTION_MODE | mcImmediately, mcQueued | no — *impl* |
| MC_SOURCE | mcCommandedValue, mcSetValue, mcActualValue | no — *impl* |
| MC_START_MODE | mcAbsolute, mcRelative, mcRampIn | no |
| MC_SYNC_MODE | e.g. mcShortest, mcCatchUp, mcSlowDown — vendor specific | no |
| MC_COMBINE_MODE | mcAddAxes, mcSubAxes | no |
| AXIS_REF, MC_TP/TV/TA_REF, MC_CAM_REF, MC_CAM_ID, MC_TRIGGER_REF, MC_INPUT_REF, MC_OUTPUT_REF, MC_CAMSWITCH_REF, MC_TRACK_REF | supplier specific structures | — |

Basic types used: BOOL, INT, WORD, REAL, ENUM, UINT (Table 6). `ErrorID` is WORD everywhere; its values are **not** standardized.

---

## 8. Compliance (§1.1.4, Appendix B)
- Compliance = offering one or more MC FBs with **at least all B inputs and outputs** of their tables. Any subset of E pins may be added; vendor additions are allowed on any FB and are listed as V.
- FBs/inputs removed from older versions may be kept for compatibility.
- The supplier fills the compliance tables (B 2, B 3: per FB "Supported as V1.0/V1.1/V2.0 or Not") and lists every vendor-specific I/O.

---

## 9. Points the spec leaves to the implementer (*impl*)
- Internal FB behaviour, input range checking (limit vs error, §2.2).
- Acceleration / Deceleration / Jerk = 0 (§2.4.1), MC_Stop Deceleration = 0 (§3.3 note 3).
- Inxxx right after a re-triggered Execute (§2.4.1, §2.5).
- AXIS_REF content and refresh rate; switching the AXIS_REF of an active FB (§2.4.3).
- Length unit `[u]` (§2.4.4).
- Homing sequence (§3.2), ramp-in mode (§4.3), position vs velocity locking after InGear (§4.5).
- ErrorID values, AxisErrorID values, enum numeric values other than MC_BUFFER_MODE.
- MC_Reset outside ErrorStop (§3.31); override factors > 1.0 and override on profile FBs (§3.18).

---

## 10. Kron decisions and deviations

Record every *impl* choice and every confirmed deviation here — rule + why. Current state (from `kronmotion.h` / `kron_axis.h` / `resources/krontek-include/CLAUDE.md`):
- **REAL → `double`** (allowed by §1.1.4 as LREAL, consistently for the whole set): a float position accumulator drifts on long travel.
- **MC_DIRECTION numbering** `mcPositiveDirection=1, mcShortestWay=2, mcNegativeDirection=3, mcCurrentDirection=4`; `MC_EXECUTION_MODE` `mcImmediately=0, mcQueued=1`; `MC_SOURCE` `mcCommandedValue=0, mcSetValue=1, mcActualValue=2` — Kron's choice (spec gives none, §7). MC_BUFFER_MODE follows T3 (0–5).
- **ErrorID codes are block-local** (`kron_axis.h`, `public/libraries/errors/motion_errors.xml`): 1 `MC_ERR_PARAM`, 2 `MC_ERR_STATE`, 3 `MC_ERR_NOT_HOMED`, 4 `MC_ERR_QUEUE_FULL`, 5 `MC_ERR_STOP_ACTIVE` (motion rejected while MC_Stop holds the axis, §3.3 note 2), 100+ axis/drive errors.
- **An FB Velocity/Acceleration/Deceleration/Jerk above the axis limit is LIMITED by the system, not an error** (`kron_axis.c pick_limit`; §2.4.1 "inputs exceeding application limits" allows either). A negative Acceleration/Deceleration/Jerk is `MC_ERR_PARAM` (§2.4.1 sign rules).
- ⚠️ **Acceleration/Deceleration = 0 (not given)** (§2.4.1 *impl*): `pick_limit` takes the `AXIS_REF` limit instead; if that is also 0 → `MC_ERR_PARAM`. `KronAxis_Submit` checks the acceleration even for a stop; MC_Stop/MC_Halt/MC_Home therefore fail with ErrorID 1 when the Axis tab limits are blank — see `resources/krontek-include/CLAUDE.md`.
- **MC_ERR_NOT_HOMED on an absolute move of an unreferenced axis** — a Kron safety check, not required by the spec.
- **MC_Reset** drives a rising edge of CiA402 controlword bit 7 and stays Busy until the drive fault clears (`resources/krontek-include/CLAUDE.md`) — the spec only says it resets "all internal axis-related errors" (§3.31).
