# Known issues — what Kron still does wrong, on purpose or not yet

Read the root [`CLAUDE.md`](../CLAUDE.md) first. This file is the **register of known bugs and known gaps**: behaviour that is wrong or incomplete, that someone has seen, and that is *not* fixed yet. It is the place to look before calling something "a new bug", and the place to write one down.

**Rules**
- One entry = what is wrong, where (file / function), why it is not fixed yet, and what a fix must respect. Delete the entry in the same change that fixes it.
- A deviation from IEC 61131-3 that is a *decision* (kept deliberately) belongs in [`Standards/iec61131-3.md`](../Standards/iec61131-3.md) §16, not here. An entry here is something that should eventually change.
- ⚠️ Never leave a known wrong behaviour only in a commit message or a chat: if it is not here (or in §16), the next person will think it works.

## Transpiler (ST / LD → C)

- **Integer overflow is neither reproduced nor reported.** IEC 61131-3 §6.6.1.7 ex. 3 and §7.3.2 c: `dint := int1 + int2` is an INT addition and an overflow is an error. Kron emits `(a + b)`: C promotes INT/SINT to `int`, so a sub-int result is computed wide and only narrowed on assignment; DINT/LINT wrap silently (`-fwrapv`). Not reported because a check on every `+ - *` costs scan time. ⚠️ **A fix must not affect speed**: the developer rejected per-operation overflow checks. Candidates: a compile-time range analysis that only flags expressions whose result range exceeds the type, or a debug-build-only `__builtin_*_overflow` mode. Same for `ABS(INT#-32768)`, `-INT_MIN` and `INT_MIN / -1` (which `KRON_DIV` wraps).
- **LD block pins are not type-checked against F11/F12.** ST refuses every implicit conversion the standard forbids (`stExpr.js` `coerce`/`unify`), but an LD variable or wire on a block pin still meets C's conversions (`kindOf`, `adaptExprForInputPin`, the kronmath i32 path): an UDINT/DWORD operand goes into the `int32_t` kronmath structs, a DINT on an INT pin narrows silently. A fix has to give every LD pin an IEC type and run it through the same rules (`canImplicit` in `stExpr.js`).
- **LD math blocks do not report run-time errors through `KRON_RTE`.** `DIV` does (`KRON_DIV`), but the archive-backed i32 path (`kronmath.c`: `MOD`, `EXPT` with a negative exponent, `SQRT` of a negative number, `MUX` K ≥ N) only sets the block's `ERR`, and `KRON_MUX_*` in `kroncompare.c` returns the last input. They should call the same hook (`__kron_rte` / `plc_rte_report`).
- **An LTIME in an LD pin is typed by its literal prefix.** `LT#…` is nanoseconds, `T#…` microseconds; LD has no typed conversion, so `T#1s` on an LTIME pin is 1000 times too short. ST converts (`TIME → LTIME` ×1000). There are also no `TON_LTIME` / `TP_LTIME` / `TOF_LTIME` blocks — the timers take TIME (µs) only.
- **A program run by the background task (no task assigned, §6.8.2 d) does not feed the capture ring** — its addressed variables are not recorded (`generateMainLoop` adds the background task after the ring grouping).
- **Missing standard features (§16.3 of Standards/iec61131-3.md)** — `TO_INT`/`TO_REAL`, `TRUNC_<type>`, `GT(a, b, c)` function forms, STRING ordering, array/struct comparison, incomplete formal function calls, function `=>` outputs, negative array lower bounds, subranges, `REF_TO`, DATE/TOD/DT, `R_EDGE`/`F_EDGE`. Each is a loud error today; the developer has not decided the order yet.
- **`TRUNC` (deprecated) is `(int64_t)x`** — undefined behaviour out of range; should saturate like `KRON_F2I`.

## Runtime

- **`plc_rte_report` sees a site by the ADDRESS of its string.** A hot swap loads new string literals, so a site that faulted before the swap is reported once more after it. Harmless (one extra log line); the counter is exact.
- **A remote PLC's run-time error text stays on the target** (stderr → KronServer). The editor sees only the counter (`prog____rte_count`/`prog____rte_code`, `App.jsx`), i.e. the type of the last error, not its site.
