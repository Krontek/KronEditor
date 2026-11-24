// ST statements: IF / CASE / FOR / WHILE / REPEAT / EXIT / CONTINUE / RETURN.
// Standards/iec61131-3.md §10.3–§10.6 (§7.3.3) and the §18 vectors.
export default [
    // ── IF ──────────────────────────────────────────────────────────────────
    {
        name: 'IF / ELSIF / ELSE picks the first true branch',
        ref: '§7.3.3.3',
        vars: ['x : INT', 'r : INT'],
        code: 'IF x < 0 THEN r := -1;\nELSIF x = 0 THEN r := 0;\nELSIF x < 10 THEN r := 1;\nELSE r := 2;\nEND_IF;',
        steps: [
            { set: { x: -5 }, expect: { r: -1 } },
            { set: { x: 0 }, expect: { r: 0 } },
            { set: { x: 5 }, expect: { r: 1 } },
            { set: { x: 50 }, expect: { r: 2 } },
        ],
    },
    {
        name: 'nested IF',
        vars: ['a : BOOL := TRUE', 'b : BOOL := FALSE', 'r : INT'],
        code: 'IF a THEN\n  IF b THEN r := 1; ELSE r := 2; END_IF;\nELSE\n  r := 3;\nEND_IF;',
        expect: { r: 2 },
    },
    {
        name: 'IF ... THEN on one line',
        vars: ['a : INT := 3', 'r : INT'],
        code: 'IF a = 3 THEN r := 30; ELSE r := 0; END_IF;',
        expect: { r: 30 },
    },

    // ── CASE ────────────────────────────────────────────────────────────────
    {
        name: 'CASE: single labels, lists, ranges, ELSE',
        ref: '§7.3.3.3',
        vars: ['x : INT', 'r : INT'],
        code: 'CASE x OF\n  1: r := 10;\n  2, 3: r := 20;\n  4..6, 9: r := 30;\nELSE\n  r := 99;\nEND_CASE;',
        steps: [
            { set: { x: 1 }, expect: { r: 10 } },
            { set: { x: 3 }, expect: { r: 20 } },
            { set: { x: 5 }, expect: { r: 30 } },
            { set: { x: 9 }, expect: { r: 30 } },
            { set: { x: 7 }, expect: { r: 99 } },
        ],
    },
    {
        name: 'CASE: first matching group wins on overlap',
        ref: '§18 / §7.3.3.3.3',
        vars: ['x : INT := 3', 'r : INT'],
        code: 'CASE x OF\n  1..5: r := 1;\n  3: r := 2;\nEND_CASE;',
        expect: { r: 1 },
    },
    {
        name: 'CASE: negative labels and a negative range',
        ref: 'src/services/CLAUDE.md "-1:" label',
        vars: ['x : INT', 'r : INT'],
        code: 'CASE x OF\n  -1: r := 1;\n  -10..-5: r := 2;\n  0: r := 3;\nEND_CASE;',
        steps: [
            { set: { x: -1 }, expect: { r: 1 } },
            { set: { x: -7 }, expect: { r: 2 } },
            { set: { x: 0 }, expect: { r: 3 } },
        ],
    },
    {
        name: 'CASE: no match and no ELSE does nothing',
        vars: ['x : INT := 42', 'r : INT := 5'],
        code: 'CASE x OF 1: r := 1; 2: r := 2; END_CASE;',
        expect: { r: 5 },
    },
    {
        name: 'CASE: selector expression is evaluated once',
        functions: [{ name: 'Next', returnType: 'INT', vars: ['INOUT c : INT'], code: 'c := c + 1;\nNext := c;' }],
        vars: ['cnt : INT := 0', 'r : INT'],
        code: 'CASE Next(c := cnt) OF\n  5: r := 5;\n  6: r := 6;\nELSE r := cnt;\nEND_CASE;',
        expect: { cnt: 1, r: 1 },
    },
    {
        name: 'CASE: CONSTANT labels',
        ref: '§16.1',
        vars: ['CONST IDLE : INT := 0', 'CONST RUN : INT := 1', 'st : INT := 1', 'r : INT'],
        code: 'CASE st OF\n  IDLE: r := 100;\n  RUN: r := 200;\nEND_CASE;',
        expect: { r: 200 },
    },
    {
        name: 'CASE with several statements per branch, multi-line',
        vars: ['x : INT := 2', 'a : INT', 'b : INT'],
        code: 'CASE x OF\n  1:\n    a := 1;\n    b := 1;\n  2:\n    a := 2;\n    b := a * 10;\nEND_CASE;',
        expect: { a: 2, b: 20 },
    },
    {
        name: 'CASE on an enumerated selector',
        dataTypes: [{ name: 'Mode', type: 'Enumerated', content: { values: [{ name: 'Off' }, { name: 'Slow' }, { name: 'Fast' }] } }],
        vars: ['m : Mode := Slow', 'r : INT'],
        code: 'CASE m OF\n  Off: r := 0;\n  Slow: r := 1;\n  Fast: r := 2;\nEND_CASE;',
        expect: { r: 1 },
    },

    // ── FOR ─────────────────────────────────────────────────────────────────
    {
        name: 'FOR sums 1..10',
        vars: ['i : INT', 's : INT'],
        code: 's := 0;\nFOR i := 1 TO 10 DO\n  s := s + i;\nEND_FOR;',
        expect: { s: 55 },
    },
    {
        name: 'FOR with BY and a negative step',
        ref: '§7.3.3.4.2',
        vars: ['i : INT', 'a : INT', 'b : INT', 'n : INT'],
        code: 'a := 0; FOR i := 0 TO 10 BY 3 DO a := a + i; END_FOR;\n' +
            'b := 0; n := 0; FOR i := 3 TO 1 BY -1 DO b := b * 10 + i; n := n + 1; END_FOR;',
        expect: { a: 18, b: 321, n: 3 },
    },
    {
        name: 'FOR whose start is beyond the end runs zero times',
        vars: ['i : INT', 'n : INT := 0'],
        code: 'FOR i := 5 TO 1 DO n := n + 1; END_FOR;',
        expect: { n: 0 },
    },
    {
        name: 'FOR to the type maximum terminates (USINT 255)',
        ref: 'src/services/CLAUDE.md hidden int64 counter',
        vars: ['u : USINT', 'n : DINT := 0'],
        code: 'FOR u := 250 TO 255 DO n := n + 1; END_FOR;',
        expect: { n: 6 },
    },
    {
        name: 'FOR counting down to the type minimum terminates (SINT -128)',
        ref: 'src/services/CLAUDE.md hidden int64 counter',
        vars: ['s : SINT', 'n : DINT := 0'],
        code: 'FOR s := -125 TO -128 BY -1 DO n := n + 1; END_FOR;',
        expect: { n: 4 },
    },
    // The 64-bit cases carry an EXIT guard so a regression fails on `n`
    // instead of hanging the driver.
    {
        name: 'FOR to the LINT maximum terminates',
        ref: '§7.3.3.4.2 (termination test at the start of each iteration)',
        vars: ['i : LINT', 'hi : LINT := 9223372036854775807', 'n : DINT := 0'],
        code: 'FOR i := hi - 1 TO hi DO n := n + 1; IF n > 10 THEN EXIT; END_IF; END_FOR;',
        expect: { n: 2, i: 9223372036854775807n },
    },
    {
        name: 'FOR counting down to the LINT minimum terminates',
        ref: '§7.3.3.4.2',
        vars: ['i : LINT', 'lo : LINT', 'n : DINT := 0'],
        code: 'lo := -9223372036854775807 - 1;\nFOR i := lo + 1 TO lo BY -1 DO n := n + 1; IF n > 10 THEN EXIT; END_IF; END_FOR;',
        expect: { n: 2, i: -9223372036854775808n },
    },
    {
        name: 'FOR with a LINT step larger than the room left stops at the last value',
        ref: '§7.3.3.4.2',
        vars: ['i : LINT', 'hi : LINT := 9223372036854775807', 'n : DINT := 0'],
        code: 'FOR i := 0 TO hi BY 4611686018427387904 DO n := n + 1; IF n > 10 THEN EXIT; END_IF; END_FOR;',
        expect: { n: 2, i: 4611686018427387904n },
    },
    {
        name: 'FOR over ULINT values above 2^63-1',
        ref: '§7.3.3.4.2',
        vars: ['u : ULINT', 'n : DINT := 0'],
        code: 'FOR u := 9223372036854775807 TO 9223372036854775809 DO n := n + 1; IF n > 10 THEN EXIT; END_IF; END_FOR;',
        expect: { n: 3, u: 9223372036854775809n },
    },
    {
        name: 'FOR to the ULINT maximum terminates',
        ref: '§7.3.3.4.2',
        vars: ['u : ULINT', 'n : DINT := 0'],
        code: 'FOR u := 18446744073709551614 TO 18446744073709551615 DO n := n + 1; IF n > 10 THEN EXIT; END_IF; END_FOR;',
        expect: { n: 2, u: 18446744073709551615n },
    },
    {
        name: 'FOR with a run-time negative step and CONTINUE',
        ref: '§7.3.3.4.2, §7.3.3.4.5',
        vars: ['i : DINT', 'st : DINT := -3', 'n : DINT := 0', 'sum : DINT := 0'],
        code: 'FOR i := 10 TO 0 BY st DO n := n + 1; IF i = 7 THEN CONTINUE; END_IF; sum := sum + i; IF n > 10 THEN EXIT; END_IF; END_FOR;',
        expect: { n: 4, sum: 10 + 4 + 1, i: 1 },
    },
    {
        name: 'FOR bounds are expressions evaluated with variables',
        vars: ['i : DINT', 'lo : DINT := 2', 'hi : DINT := 4', 's : DINT := 0'],
        code: 'FOR i := lo * 2 TO hi * 2 BY lo DO s := s + i; END_FOR;',
        expect: { s: 4 + 6 + 8 },
    },
    {
        name: 'nested FOR',
        vars: ['i : INT', 'j : INT', 'n : INT := 0'],
        code: 'FOR i := 1 TO 3 DO\n  FOR j := 1 TO 4 DO\n    n := n + 1;\n  END_FOR;\nEND_FOR;',
        expect: { n: 12 },
    },

    // ── CONTINUE / EXIT (the standard's own examples) ───────────────────────
    ...[[false, 15], [true, 9]].map(([flag, sum]) => ({
        name: `nested FOR + CONTINUE, FLAG = ${flag ? 1 : 0}`,
        ref: '§7.3.3.4.5',
        vars: ['I : INT', 'J : INT', 'SUM : INT', `FLAG : BOOL := ${flag ? 'TRUE' : 'FALSE'}`],
        code: [
            'SUM := 0;',
            'FOR I := 1 TO 3 DO',
            '  FOR J := 1 TO 2 DO',
            '    SUM := SUM + 1;',
            '    IF FLAG THEN CONTINUE; END_IF;',
            '    SUM := SUM + 1;',
            '  END_FOR;',
            '  SUM := SUM + 1;',
            'END_FOR;',
        ].join('\n'),
        expect: { SUM: sum },
    })),
    ...[[false, 15], [true, 6]].map(([flag, sum]) => ({
        name: `nested FOR + EXIT, FLAG = ${flag ? 1 : 0}`,
        ref: '§7.3.3.4.6',
        vars: ['I : INT', 'J : INT', 'SUM : INT', `FLAG : BOOL := ${flag ? 'TRUE' : 'FALSE'}`],
        code: [
            'SUM := 0;',
            'FOR I := 1 TO 3 DO',
            '  FOR J := 1 TO 2 DO',
            '    SUM := SUM + 1;',
            '    IF FLAG THEN EXIT; END_IF;',
            '    SUM := SUM + 1;',
            '  END_FOR;',
            '  SUM := SUM + 1;',
            'END_FOR;',
        ].join('\n'),
        expect: { SUM: sum },
    })),
    {
        name: 'EXIT from inside a CASE leaves the loop, not just the CASE',
        ref: 'src/services/CLAUDE.md goto __exit_N',
        vars: ['i : INT', 'n : INT := 0'],
        code: 'FOR i := 1 TO 10 DO\n  CASE i OF\n    4: EXIT;\n  ELSE\n    n := n + 1;\n  END_CASE;\nEND_FOR;',
        expect: { n: 3 },
    },
    {
        name: 'CONTINUE from inside a CASE',
        vars: ['i : INT', 'n : INT := 0'],
        code: 'FOR i := 1 TO 5 DO\n  CASE i OF\n    2, 4: CONTINUE;\n  END_CASE;\n  n := n + i;\nEND_FOR;',
        expect: { n: 1 + 3 + 5 },
    },

    // ── WHILE / REPEAT ──────────────────────────────────────────────────────
    {
        name: 'WHILE tests first, may run zero times',
        ref: '§7.3.3.4',
        vars: ['i : INT', 'n : INT', 'z : INT'],
        code: 'i := 0; n := 0;\nWHILE i < 5 DO\n  i := i + 1;\n  n := n + 2;\nEND_WHILE;\nz := 0;\nWHILE FALSE DO z := 1; END_WHILE;',
        expect: { i: 5, n: 10, z: 0 },
    },
    {
        name: 'REPEAT runs at least once',
        ref: '§7.3.3.4',
        vars: ['i : INT', 'k : INT'],
        code: 'i := 0;\nREPEAT\n  i := i + 1;\nUNTIL i >= 3\nEND_REPEAT;\nk := 100;\nREPEAT k := k + 1; UNTIL TRUE END_REPEAT;',
        expect: { i: 3, k: 101 },
    },
    {
        name: 'EXIT and CONTINUE work in WHILE and REPEAT',
        ref: 'T72 fn. a',
        vars: ['i : INT', 'a : INT', 'j : INT', 'b : INT'],
        code: [
            'i := 0; a := 0;',
            'WHILE i < 10 DO',
            '  i := i + 1;',
            '  IF i = 2 THEN CONTINUE; END_IF;',
            '  IF i = 5 THEN EXIT; END_IF;',
            '  a := a + i;',
            'END_WHILE;',
            'j := 0; b := 0;',
            'REPEAT',
            '  j := j + 1;',
            '  IF j = 3 THEN CONTINUE; END_IF;',
            '  IF j = 6 THEN EXIT; END_IF;',
            '  b := b + j;',
            'UNTIL j >= 100',
            'END_REPEAT;',
        ].join('\n'),
        expect: { i: 5, a: 1 + 3 + 4, j: 6, b: 1 + 2 + 4 + 5 },
    },

    // ── RETURN ──────────────────────────────────────────────────────────────
    {
        name: 'RETURN leaves the program early',
        ref: 'T72 3',
        vars: ['a : INT', 'b : INT := 7'],
        code: 'a := 1;\nIF a = 1 THEN RETURN; END_IF;\nb := 99;',
        expect: { a: 1, b: 7 },
    },

    // ── state across scans ──────────────────────────────────────────────────
    {
        name: 'program locals keep their value between scans',
        ref: '§6.6.4',
        vars: ['n : DINT'],
        code: 'n := n + 1;',
        scans: 25,
        expect: { n: 25 },
    },
    {
        name: 'VAR_TEMP is re-initialised every scan',
        ref: '§16.1',
        vars: ['TEMP t : INT := 5', 'n : INT'],
        code: 't := t + 1;\nn := t;',
        scans: 3,
        expect: { n: 6 },
    },
];
