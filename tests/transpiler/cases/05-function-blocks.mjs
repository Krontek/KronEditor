// Function blocks: the standard FBs (T43–T46, exact bodies in
// Standards/iec61131-3.md §8.5) and user FUNCTION / FUNCTION_BLOCK POUs
// (§6.6.2/§6.6.3, §16.1/§16.7).
//
// Time is deterministic: the driver sets us_tick = 1 s + scan × cycleUs
// before every scan (cycleUs defaults to 10 ms), so a timer's ET is an exact
// multiple of the cycle.
export default [
    // ── timers (F15) ────────────────────────────────────────────────────────
    {
        name: 'TON: Q after PT of continuous IN, ET holds PT, both reset with IN',
        ref: 'T46 / F15',
        vars: ['t : TON', 'start : BOOL', 'q : BOOL', 'et : TIME'],
        code: 't(IN := start, PT := T#50ms);\nq := t.Q;\net := t.ET;',
        steps: [
            { set: { start: true }, scans: 5, expect: { q: false, et: 40000 } },
            { scans: 1, expect: { q: true, et: 50000 } },
            { scans: 3, expect: { q: true, et: 50000 } },
            { set: { start: false }, scans: 1, expect: { q: false, et: 0 } },
        ],
    },
    {
        name: 'TON: IN falling before PT never raises Q',
        ref: 'F15',
        vars: ['t : TON', 'start : BOOL', 'q : BOOL', 'et : TIME'],
        code: 't(IN := start, PT := T#50ms);\nq := t.Q;\net := t.ET;',
        steps: [
            { set: { start: true }, scans: 3, expect: { q: false } },
            { set: { start: false }, scans: 1, expect: { q: false, et: 0 } },
            { set: { start: true }, scans: 5, expect: { q: false, et: 40000 } },
        ],
    },
    {
        name: 'TOF: Q immediately with IN, falls PT after IN falls',
        ref: 'F15',
        vars: ['t : TOF', 'start : BOOL', 'q : BOOL', 'et : TIME'],
        code: 't(IN := start, PT := T#30ms);\nq := t.Q;\net := t.ET;',
        steps: [
            { set: { start: true }, scans: 1, expect: { q: true, et: 0 } },
            { set: { start: false }, scans: 3, expect: { q: true, et: 20000 } },
            { scans: 1, expect: { q: false, et: 30000 } },
            { scans: 2, expect: { q: false, et: 30000 } },
        ],
    },
    {
        name: 'TP: fixed pulse, not retriggerable',
        ref: 'F15',
        vars: ['t : TP', 'trig : BOOL', 'q : BOOL'],
        code: 't(IN := trig, PT := T#40ms);\nq := t.Q;',
        steps: [
            { set: { trig: true }, scans: 1, expect: { q: true } },
            { set: { trig: false }, scans: 1, expect: { q: true } },
            { set: { trig: true }, scans: 1, expect: { q: true } },   // edge during the pulse: ignored
            { set: { trig: false }, scans: 1, expect: { q: true } },  // t = 30 ms
            { scans: 1, expect: { q: false } },                       // t = 40 ms → pulse over
        ],
    },
    {
        name: 'two timers started on the same scan expire on the same scan',
        ref: 'scan-start time snapshot (plc.h __kron_scan_us)',
        // One frozen "now" per scan: order in the code must not matter.
        vars: ['a : TON', 'b : TON', 'qa1 : BOOL', 'qb : BOOL', 'qa2 : BOOL'],
        code: 'a(IN := TRUE, PT := T#30ms);\nqa1 := a.Q;\nb(IN := TRUE, PT := T#30ms);\nqb := b.Q;\na(IN := TRUE, PT := T#30ms);\nqa2 := a.Q;',
        steps: [
            { scans: 3, expect: { qa1: false, qb: false, qa2: false } },  // t = 20 ms
            { scans: 1, expect: { qa1: true, qb: true, qa2: true } },     // t = 30 ms: all together
        ],
    },
    {
        name: 'Read_Live_Time reads the live monotonic clock',
        ref: 'kronsystem.h Read_Live_Time',
        vars: ['lt : Read_Live_Time', 'ok : BOOL', 't1 : TIME', 't2 : TIME'],
        code: 'lt(EN := TRUE);\nt1 := lt.NOW;\nlt(EN := TRUE);\nt2 := lt.NOW;\nok := lt.VALID AND (t1 > T#0s) AND (t2 >= t1);',
        scans: 1,
        expect: { ok: true },
    },
    {
        name: 'self-resetting TON blinker period',
        ref: 'src/services/CLAUDE.md task interval bounds every timer',
        vars: ['t : TON', 'n : INT'],
        code: 't(IN := NOT t.Q, PT := T#50ms);\nIF t.Q THEN n := n + 1; END_IF;',
        scans: 100,
        // Q at scan 5, IN falls the scan after (TON resets), rises again the
        // scan after that → a 7-scan period (PT + 2 scans, as documented);
        // pulses at scans 5, 12, …, 96 → 14.
        expect: { n: 14 },
    },

    // ── counters (T45) ──────────────────────────────────────────────────────
    {
        name: 'CTU counts rising edges of CU, R resets',
        ref: 'T45',
        vars: ['c : CTU', 'pulse : BOOL', 'rst : BOOL', 'q : BOOL', 'cv : INT'],
        code: 'c(CU := pulse, R := rst, PV := 3);\nq := c.Q;\ncv := c.CV;',
        steps: [
            { set: { pulse: true }, scans: 3, expect: { cv: 1, q: false } },  // level, not edge
            { set: { pulse: false }, scans: 1, expect: { cv: 1 } },
            { set: { pulse: true }, scans: 1, expect: { cv: 2 } },
            { set: { pulse: false }, scans: 1 },
            { set: { pulse: true }, scans: 1, expect: { cv: 3, q: true } },
            { set: { rst: true }, scans: 1, expect: { cv: 0, q: false } },
        ],
    },
    {
        name: 'CTD loads PV and counts down to Q',
        ref: 'T45',
        vars: ['c : CTD', 'pulse : BOOL', 'load : BOOL', 'q : BOOL', 'cv : INT'],
        code: 'c(CD := pulse, LD := load, PV := 2);\nq := c.Q;\ncv := c.CV;',
        steps: [
            { set: { load: true }, scans: 1, expect: { cv: 2, q: false } },
            { set: { load: false, pulse: true }, scans: 1, expect: { cv: 1 } },
            { set: { pulse: false }, scans: 1 },
            { set: { pulse: true }, scans: 1, expect: { cv: 0, q: true } },
        ],
    },
    {
        name: 'CTUD: R beats LD, simultaneous edges do nothing',
        ref: 'T45',
        vars: ['c : CTUD', 'up : BOOL', 'dn : BOOL', 'r : BOOL', 'ld : BOOL', 'cv : INT', 'qu : BOOL', 'qd : BOOL'],
        code: 'c(CU := up, CD := dn, R := r, LD := ld, PV := 5);\ncv := c.CV;\nqu := c.QU;\nqd := c.QD;',
        steps: [
            { set: { ld: true }, scans: 1, expect: { cv: 5, qu: true, qd: false } },
            { set: { ld: true, r: true }, scans: 1, expect: { cv: 0, qd: true } },
            { set: { ld: false, r: false, up: true }, scans: 1, expect: { cv: 1 } },
            { set: { up: false }, scans: 1 },
            { set: { up: true, dn: true }, scans: 1, expect: { cv: 1 } },
        ],
    },

    // ── edges and bistables (T43/T44) ───────────────────────────────────────
    {
        name: 'R_TRIG gives one pulse per rising edge',
        ref: 'T44',
        vars: ['e : R_TRIG', 'x : BOOL', 'q : BOOL', 'n : INT'],
        code: 'e(CLK := x);\nq := e.Q;\nIF q THEN n := n + 1; END_IF;',
        steps: [
            { set: { x: true }, scans: 1, expect: { q: true, n: 1 } },
            { scans: 3, expect: { q: false, n: 1 } },
            { set: { x: false }, scans: 1, expect: { q: false } },
            { set: { x: true }, scans: 2, expect: { n: 2 } },
        ],
    },
    {
        name: 'F_TRIG with CLK = FALSE pulses on the first call',
        ref: 'T44 note / §18',
        vars: ['e : F_TRIG', 'x : BOOL', 'q : BOOL'],
        code: 'e(CLK := x);\nq := e.Q;',
        steps: [
            { scans: 1, expect: { q: true } },
            { scans: 1, expect: { q: false } },
            { set: { x: true }, scans: 1, expect: { q: false } },
            { set: { x: false }, scans: 1, expect: { q: true } },
        ],
    },
    {
        name: 'SR is set-dominant, RS is reset-dominant',
        ref: 'T43',
        vars: ['sr1 : SR', 'rs1 : RS', 's : BOOL', 'r : BOOL', 'q1 : BOOL', 'q2 : BOOL'],
        code: 'sr1(S1 := s, R := r);\nrs1(S := s, R1 := r);\nq1 := sr1.Q1;\nq2 := rs1.Q1;',
        steps: [
            { set: { s: true, r: true }, scans: 1, expect: { q1: true, q2: false } },
            { set: { s: false, r: false }, scans: 1, expect: { q1: true, q2: false } },
            { set: { r: true }, scans: 1, expect: { q1: false } },
        ],
    },
    {
        name: 'FB instance with an initial value',
        ref: 'src/services/CLAUDE.md fbInstanceInitLines',
        vars: ['t : TON := (PT := T#20ms)', 'q : BOOL'],
        code: 't(IN := TRUE);\nq := t.Q;',
        scans: 3,
        expect: { q: true },
    },
    {
        name: 'FB inputs not passed keep their last value',
        ref: '§16.7',
        vars: ['c : CTU', 'cv : INT', 'n : INT'],
        code: 'n := n + 1;\nIF n = 1 THEN c(CU := TRUE, PV := 10); ELSE c(); END_IF;\ncv := c.CV;',
        scans: 3,
        expect: { cv: 1 },
    },
    {
        name: 'FB output read with => in the call',
        ref: 'T42',
        vars: ['t : TON', 'q : BOOL', 'e : TIME'],
        code: 't(IN := TRUE, PT := T#20ms, Q => q, ET => e);',
        scans: 2,
        expect: { q: false, e: 10000 },
    },

    // ── user FUNCTION ───────────────────────────────────────────────────────
    {
        name: 'user FUNCTION: formal and non-formal call, used inside an expression',
        ref: '§6.6.2',
        functions: [{
            name: 'Scale', returnType: 'REAL',
            vars: ['IN x : REAL', 'IN k : REAL'],
            code: 'Scale := x * k;',
        }],
        vars: ['a : REAL', 'b : REAL', 'v : REAL := 2.0'],
        code: 'a := Scale(x := v, k := 3.0);\nb := Scale(v, 4.0) + 1.0;',
        expect: { a: 6.0, b: 9.0 },
    },
    {
        name: 'user FUNCTION with IF, local VAR re-initialised per call',
        ref: '§16.7',
        functions: [{
            name: 'Clamp100', returnType: 'INT',
            vars: ['IN v : INT', 'tmp : INT := 0'],
            code: 'tmp := tmp + v;\nIF tmp > 100 THEN Clamp100 := 100; ELSE Clamp100 := tmp; END_IF;',
        }],
        vars: ['a : INT', 'b : INT'],
        code: 'a := Clamp100(v := 30);\nb := Clamp100(v := 500);',
        expect: { a: 30, b: 100 },
    },
    {
        name: 'user FUNCTION: VAR_IN_OUT is written through',
        ref: 'src/services/CLAUDE.md FUNCTION VAR_IN_OUT',
        functions: [{
            name: 'Swap', returnType: 'BOOL',
            vars: ['INOUT a : INT', 'INOUT b : INT', 't : INT'],
            code: 't := a;\na := b;\nb := t;\nSwap := TRUE;',
        }],
        vars: ['x : INT := 1', 'y : INT := 2', 'ok : BOOL'],
        code: 'ok := Swap(a := x, b := y);',
        expect: { x: 2, y: 1, ok: true },
    },
    {
        name: 'user FUNCTION: RETURN keeps the most recent result',
        ref: '§7.3.3.2.3',
        functions: [{
            name: 'Sign', returnType: 'INT',
            vars: ['IN v : INT'],
            code: 'Sign := 0;\nIF v > 0 THEN Sign := 1; RETURN; END_IF;\nIF v < 0 THEN Sign := -1; END_IF;',
        }],
        vars: ['a : INT', 'b : INT', 'c : INT'],
        code: 'a := Sign(5);\nb := Sign(-5);\nc := Sign(0);',
        expect: { a: 1, b: -1, c: 0 },
    },
    {
        name: 'user FUNCTION calling another FUNCTION, nested call arguments',
        functions: [
            { name: 'Sq', returnType: 'DINT', vars: ['IN v : DINT'], code: 'Sq := v * v;' },
            { name: 'SumSq', returnType: 'DINT', vars: ['IN a : DINT', 'IN b : DINT'], code: 'SumSq := Sq(a) + Sq(b);' },
        ],
        vars: ['r : DINT'],
        code: 'r := SumSq(Sq(2), 3);',
        expect: { r: 16 + 9 },
    },

    // ── user FUNCTION_BLOCK ─────────────────────────────────────────────────
    {
        name: 'user FB keeps internal state per instance',
        ref: '§6.6.3',
        functionBlocks: [{
            name: 'Accum',
            vars: ['IN add : INT', 'OUT total : INT', 'sum : INT'],
            code: 'sum := sum + add;\ntotal := sum;',
        }],
        vars: ['a1 : Accum', 'a2 : Accum', 't1 : INT', 't2 : INT'],
        code: 'a1(add := 1);\na2(add := 10);\nt1 := a1.total;\nt2 := a2.total;',
        scans: 4,
        expect: { t1: 4, t2: 40 },
    },
    {
        name: 'user FB containing a standard FB (TON inside)',
        functionBlocks: [{
            name: 'MyDebounce',
            vars: ['IN x : BOOL', 'OUT q : BOOL', 't : TON'],
            code: 't(IN := x, PT := T#30ms);\nq := t.Q;',
        }],
        vars: ['d : MyDebounce', 'q : BOOL'],
        code: 'd(x := TRUE);\nq := d.q;',
        steps: [
            { scans: 3, expect: { q: false } },
            { scans: 1, expect: { q: true } },
        ],
    },
    {
        name: 'user FB named like a library block',
        ref: 'src/services/CLAUDE.md: user FB names win over a standard block',
        todo: 'known issue (docs/CLAUDE.md): a user FB called "Debounce" (also in kronsystem.h) reaches clang as "no member named …"',
        functionBlocks: [{
            name: 'Debounce',
            vars: ['IN x : BOOL', 'OUT q : BOOL'],
            code: 'q := x;',
        }],
        vars: ['d : Debounce', 'q : BOOL'],
        code: 'd(x := TRUE);\nq := d.q;',
        expect: { q: true },
    },
    {
        name: 'user FB VAR_IN_OUT: copy-in / copy-back',
        ref: 'src/services/CLAUDE.md FB VAR_IN_OUT',
        functionBlocks: [{
            name: 'Inc',
            vars: ['INOUT v : DINT', 'IN delta : DINT'],
            code: 'v := v + delta;',
        }],
        vars: ['i : Inc', 'x : DINT := 100'],
        code: 'i(v := x, delta := 5);',
        scans: 3,
        expect: { x: 115 },
    },
    {
        name: 'user FB nested in user FB',
        functionBlocks: [
            { name: 'Cnt', vars: ['OUT n : INT'], code: 'n := n + 1;' },
            { name: 'Twice', vars: ['OUT n : INT', 'c : Cnt'], code: 'c();\nc();\nn := c.n;' },
        ],
        vars: ['t : Twice', 'r : INT'],
        code: 't();\nr := t.n;',
        scans: 3,
        expect: { r: 6 },
    },
];
