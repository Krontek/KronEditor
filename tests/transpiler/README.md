# ST/LD transpiler behaviour tests

```
npm run test:transpiler            # all cases
KRON_TEST_GREP=MOD npm run test:transpiler   # cases whose name matches
KRON_TEST_OPT=O0 …                 # one optimisation level only (default O0,O2)
KRON_TEST_JOBS=2 …                 # concurrent cases per suite (default: up to 4)
KRON_TEST_KEEP=1 …                 # keep the generated C / binaries for inspection
```

Each case is a one-PROGRAM project (`Main`). The harness runs the real `transpileToC`, compiles `plc.c` with the bundled clang against the real headers and archives (`-DPLC_HOTSWAP -fwrapv`, at -O0 **and** -O2), runs a driver that executes N scans with a deterministic clock, and compares the printed `PlcState` values with the case's expectations. What the C *does* is tested, never what it looks like.

Both optimisation levels are attempted even if the first fails. Matching results can reveal regressions but do not prove the absence of undefined behaviour. Each binary runs in its own temporary directory, isolating relative runtime files. To inspect failing C, rerun with `KRON_TEST_KEEP=1`; otherwise temporary files are removed after the run.

## Case format (`cases/*.mjs`, default export = array)

```js
{
  name: 'MOD takes the sign of the dividend',   // unique per file
  ref: 'T29 fn. e',                              // where the expectation comes from
  vars: ['a : INT := -7', 'r : INT', 'CONST K : INT := 3', 'TEMP t : INT'],
  code: 'r := a MOD 3;',
  // For LD use rungs: [{ blocks: [...], connections: [...] }] instead of code.
  expect: { r: -1 },          // number | bigint | boolean | string; 'arr[2]', 's.x', 't.Q', '__rte_code'
  scans: 1, cycleUs: 10000,   // optional; us_tick = 1 s + scan × cycleUs
  expectStopped: false,     // optional: assert plc_stop after this step
  expectScans: 1,           // optional: cumulative scans executed since initialization
  tol: 1e-9,                  // optional float tolerance
  steps: [{ set: { x: true }, scans: 5, expect: { q: false } }, …],   // instead of set/scans/expect
  functions: [{ name, returnType, vars: ['IN x : REAL', 'INOUT y : INT'], code }],
  functionBlocks: [{ name, vars: ['IN …', 'OUT …', 'local : TON'], code }],
  dataTypes: [/* same objects as the project tree */], globals: ['g : DINT := 1'],
  error: /DINT_TO_INT/,       // instead of expect: the transpiler must THROW, matching this
  todo: 'known issue (docs/CLAUDE.md): …',   // a known gap — reported, does not fail the run
}
```

Rules: expectations come from `Standards/iec61131-3.md` (cite it in `ref`), never from what the transpiler happens to emit. A known gap is a `todo` case **and** an entry in `docs/CLAUDE.md`; the fix removes both. Prefer inputs that tell the right and the wrong reading apart (a truth table over one lucky vector).

Use `bigint` for exact integer inputs/expectations outside JavaScript's safe integer range. STRING output is decoded as UTF-8. NaN and infinities compare explicitly; finite floats use an absolute `tol`, or `max(1e-6, abs(expected) * 1e-6)` by default. Cases with no assertions are rejected. Array suffixes in `set`/`expect` refer to **zero-based C storage offsets**, not IEC lower bounds (e.g. the first element of `ARRAY [1..2]` is `a[0]` here).

`set` writes scalar inputs directly into test state before a step. `write` exercises the generated `plc_mb_apply` with a scalar mailbox entry; assert the status using `expect: { 'write:x': 2 }` (applied) or `5` (read-only). This tests the apply handler, not the full server/ring-buffer transport. `steps` replaces the top-level set/write/scans/expect/expectStopped/expectScans fields.

## Coverage and limits

- `01`–`08`: ST expressions, literals, control flow, functions, FBs, types, runtime errors and compile-time rejection, including declared known gaps.
- `09`: LD output reuse and online writes to constants.
- `10`: LD contact truth tables, power branching, coil/edge memory, rung ordering, typed data flow, fan-out and invalid graphs.
- `11`: all five generated runtime-error policies in STOP and report modes. The driver finishes the faulting scan and honors `plc_stop` before starting another; assertions check the flag, diagnostic count and application state. These are not tests of the host scheduler or physical output shutdown.
- `12`: UTF-8 truncation boundaries, exact 64-bit fixture inputs and BOOL short-circuiting with side effects.
- `harness.test.mjs`: the comparison/output-decoding infrastructure itself, including false-pass regressions; runs without the C toolchain.
- `scan_time.test.mjs`: a separate -O2 timer regression under interference from another thread, with synchronized thread startup/shutdown.

The main driver calls task 0 sequentially. Hardware I/O, real multi-task scheduling, hot-swap state migration, restart/retain persistence and browser/editor serialization need separate integration tests. A green result with skipped runtime cases is not a compiled-runtime validation. TODOs also need review: Node reports an unexpectedly passing TODO as TODO, so remove its marker once the fix is verified.

Run-time cases need `toolchains/` and `resources/x86_64-linux-gnu/lib/` on a linux/x64 host; otherwise they are reported as skipped. A failure in a standard-FB case (TOF, F_TRIG, …) with a correct transpiler usually means the local `.a` archives are older than `KronLibraries` — rebuild the libraries.
