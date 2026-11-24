// Standard functions: conversions (T22–T25), numerical (T28/T29), bit strings
// (T30/T31, T17), selection (T32), comparison (T33).
// Standards/iec61131-3.md §6.3, §7.4–§7.8 and the §18 vectors.
export default [
    // ── float → integer ─────────────────────────────────────────────────────
    {
        name: 'REAL_TO_INT rounds half to even',
        ref: 'T22 fn. b',
        vars: ['a : INT', 'b : INT', 'c : INT', 'd : INT', 'e : INT', 'f : INT', 'g : INT', 'h : INT'],
        code: 'a := REAL_TO_INT(2.5); b := REAL_TO_INT(-2.5); c := REAL_TO_INT(1.5); d := REAL_TO_INT(-1.6);\n' +
            'e := REAL_TO_INT(1.6); f := REAL_TO_INT(1.4); g := REAL_TO_INT(-1.4); h := REAL_TO_INT(-1.5);',
        expect: { a: 2, b: -2, c: 2, d: -2, e: 2, f: 1, g: -1, h: -2 },
    },
    {
        name: 'LREAL_TO_DINT rounds a variable operand',
        ref: 'T22 fn. b',
        vars: ['x : LREAL := 3.5', 'y : LREAL := -4.5', 'a : DINT', 'b : DINT'],
        code: 'a := LREAL_TO_DINT(x);\nb := LREAL_TO_DINT(y);',
        expect: { a: 4, b: -4 },
    },
    {
        name: 'TRUNC truncates toward zero',
        ref: 'T22 fn. c',
        // Kron's TRUNC yields LINT (the deprecated overloaded form).
        vars: ['x : REAL := -1.6', 'y : REAL := 1.6', 'a : LINT', 'b : LINT'],
        code: 'a := TRUNC(x);\nb := TRUNC(y);',
        expect: { a: -1, b: 1 },
    },
    // ── numeric ↔ numeric ───────────────────────────────────────────────────
    {
        name: 'implicit widening on assignment (F12)',
        ref: '§6.6 F12',
        vars: ['s : SINT := -5', 'i : INT', 'd : DINT', 'r : REAL', 'l : LREAL', 'u : USINT := 200', 'ui : UINT'],
        code: 'i := s;\nd := i;\nr := i;\nl := d;\nui := u;',
        expect: { i: -5, d: -5, r: -5.0, l: -5.0, ui: 200 },
    },
    {
        name: 'INT_TO_REAL / DINT_TO_LREAL / REAL_TO_LREAL',
        vars: ['i : INT := -300', 'd : DINT := 123456', 'f : REAL := 0.5', 'r : REAL', 'l : LREAL', 'm : LREAL'],
        code: 'r := INT_TO_REAL(i);\nl := DINT_TO_LREAL(d);\nm := REAL_TO_LREAL(f);',
        expect: { r: -300.0, l: 123456.0, m: 0.5 },
    },
    {
        name: 'narrowing conversions DINT_TO_INT / INT_TO_SINT in range',
        vars: ['d : DINT := -1234', 'i : INT := 100', 'a : INT', 'b : SINT'],
        code: 'a := DINT_TO_INT(d);\nb := INT_TO_SINT(i);',
        expect: { a: -1234, b: 100 },
    },
    {
        name: 'BOOL_TO_INT and BOOL source',
        ref: 'T25',
        vars: ['t : BOOL := TRUE', 'a : INT', 'b : INT'],
        code: 'a := BOOL_TO_INT(t);\nb := BOOL_TO_INT(NOT t);',
        expect: { a: 1, b: 0 },
    },

    // ── bit string ↔ numeric: binary transfer ───────────────────────────────
    {
        name: 'INT_TO_DWORD(-1) zero-fills, no sign extension',
        ref: 'T25 rule 2',
        vars: ['i : INT := -1', 'r : DWORD'],
        code: 'r := INT_TO_DWORD(i);',
        expect: { r: 0x0000FFFF },
    },
    {
        name: 'SINT_TO_WORD(18) = 16#0012',
        ref: 'T25 ex. 1',
        vars: ['s : SINT := 18', 'r : WORD'],
        code: 'r := SINT_TO_WORD(s);',
        expect: { r: 0x0012 },
    },
    {
        name: 'REAL_TO_DWORD / DWORD_TO_REAL reinterpret IEEE bits',
        ref: 'T25 binary transfer',
        vars: ['f : REAL := 1.0', 'd : DWORD', 'w : DWORD := 16#40490FDB', 'g : REAL'],
        code: 'd := REAL_TO_DWORD(f);\ng := DWORD_TO_REAL(w);',
        expect: { d: 0x3F800000, g: 3.1415927 },
    },
    {
        name: 'WORD_TO_INT / INT_TO_WORD same width reinterpret',
        ref: 'T25',
        vars: ['w : WORD := 16#FFFF', 'i : INT', 'j : INT := -2', 'v : WORD'],
        code: 'i := WORD_TO_INT(w);\nv := INT_TO_WORD(j);',
        expect: { i: -1, v: 0xFFFE },
    },
    {
        name: 'WORD_TO_BOOL takes the rightmost bit',
        ref: 'T24',
        vars: ['w : WORD := 2', 'v : WORD := 3', 'a : BOOL', 'b : BOOL'],
        code: 'a := WORD_TO_BOOL(w);\nb := WORD_TO_BOOL(v);',
        expect: { a: false, b: true },
    },
    {
        name: 'bit string narrowing keeps the rightmost bytes',
        ref: 'T24',
        vars: ['d : DWORD := 16#12345678', 'w : WORD', 'b : BYTE', 'x : DWORD'],
        code: 'w := DWORD_TO_WORD(d);\nb := DWORD_TO_BYTE(d);\nx := WORD_TO_DWORD(w);',
        expect: { w: 0x5678, b: 0x78, x: 0x5678 },
    },
    {
        name: 'BYTE_TO_INT(16#FF) = 255',
        ref: 'T25',
        vars: ['b : BYTE := 16#FF', 'i : INT'],
        code: 'i := BYTE_TO_INT(b);',
        expect: { i: 255 },
    },

    // ── numerical (T28/T29) ─────────────────────────────────────────────────
    {
        name: 'ABS on INT and REAL',
        ref: 'T28',
        vars: ['i : INT := -7', 'r : REAL := -2.5', 'a : INT', 'b : REAL'],
        code: 'a := ABS(i);\nb := ABS(r);',
        expect: { a: 7, b: 2.5 },
    },
    {
        name: 'SQRT / LN / LOG / EXP',
        ref: 'T28',
        // An untyped real literal is LREAL here (untyped-literal typing is
        // *impl*, §6.6.1.6 rule 8), so the REAL case uses a typed literal.
        vars: ['a : REAL', 'b : LREAL', 'c : LREAL', 'd : LREAL'],
        code: 'a := SQRT(REAL#16.0);\nb := LN(1.0);\nc := LOG(1000.0);\nd := EXP(0.0);',
        expect: { a: 4.0, b: 0.0, c: 3.0, d: 1.0 },
    },
    {
        name: 'trigonometric functions in radians',
        ref: 'T28',
        vars: ['pi : LREAL := 3.141592653589793', 's : LREAL', 'c : LREAL', 't : LREAL', 'a1 : LREAL', 'a2 : LREAL'],
        code: 's := SIN(pi / 2.0);\nc := COS(pi);\nt := TAN(0.0);\na1 := ATAN(1.0) * 4.0;',
        expect: { s: 1.0, c: -1.0, t: 0.0, a1: Math.PI },
        tol: 1e-9,
    },
    {
        name: 'ATAN2(Y, X)',
        ref: 'T28',
        todo: 'known issue (docs/CLAUDE.md): ATAN2 is "unknown function"',
        vars: ['a2 : LREAL'],
        code: 'a2 := ATAN2(Y := 1.0, X := -1.0);',
        expect: { a2: 3 * Math.PI / 4 },
        tol: 1e-9,
    },
    {
        name: 'ASIN / ACOS principal values',
        ref: 'T28',
        vars: ['a : LREAL', 'b : LREAL'],
        code: 'a := ASIN(1.0);\nb := ACOS(1.0);',
        expect: { a: Math.PI / 2, b: 0 },
        tol: 1e-9,
    },
    {
        name: 'EXPT keeps the REAL base type',
        ref: 'T29 fn. f',
        vars: ['b : REAL := 2.0', 'n : INT := 10', 'r : REAL', 'q : REAL'],
        code: 'r := EXPT(b, n);\nq := b ** 0.5;',
        expect: { r: 1024.0, q: Math.SQRT2 },
    },
    {
        name: 'MOVE and ADD/SUB/MUL/DIV/MOD in function form',
        todo: 'known issue (docs/CLAUDE.md): the T29 function forms ADD/SUB/MUL/DIV are "unknown function"',
        ref: 'T29',
        vars: ['a : INT', 'b : INT', 'c : INT', 'd : INT', 'e : INT', 'f : INT'],
        code: 'a := MOVE(5);\nb := ADD(a, 3);\nc := SUB(b, 1);\nd := MUL(c, 2);\ne := DIV(d, 4);\nf := MOD(d, 5);',
        expect: { a: 5, b: 8, c: 7, d: 14, e: 3, f: 4 },
    },
    {
        name: 'extensible ADD / MUL',
        todo: 'known issue (docs/CLAUDE.md): the T29 function forms ADD/SUB/MUL/DIV are "unknown function"',
        ref: 'T29',
        vars: ['a : DINT', 'b : DINT'],
        code: 'a := ADD(1, 2, 3, 4);\nb := MUL(2, 3, 4);',
        expect: { a: 10, b: 24 },
    },

    // ── bit strings ─────────────────────────────────────────────────────────
    {
        name: 'SHL / SHR / ROL / ROR on a BYTE',
        ref: 'T30',
        vars: ['b : BYTE := 2#0001_1001', 'l : BYTE', 'r : BYTE', 'rl : BYTE', 'rr : BYTE'],
        code: 'l := SHL(b, 3);\nr := SHR(b, 3);\nrl := ROL(b, 3);\nrr := ROR(b, 3);',
        expect: { l: 0b11001000, r: 0b00000011, rl: 0b11001000, rr: 0b00100011 },
    },
    {
        name: 'SHR is logical, ROL by the width is identity, SHL by >= width is 0',
        ref: 'T30 / §16.7',
        vars: ['w : WORD := 16#8000', 'b : BYTE := 16#A5', 'r : WORD', 'q : BYTE', 'z : BYTE'],
        code: 'r := SHR(w, 15);\nq := ROL(b, 8);\nz := SHL(b, 8);',
        expect: { r: 1, q: 0xA5, z: 0 },
    },
    {
        name: 'AND / OR / XOR / NOT are bitwise on bit strings',
        ref: 'T31',
        vars: ['a : WORD := 16#F0F0', 'b : WORD := 16#FF00', 'x : WORD', 'y : WORD', 'z : WORD', 'n : WORD', 'nb : BYTE', 'c : BYTE := 16#0F'],
        code: 'x := a AND b;\ny := a OR b;\nz := a XOR b;\nn := NOT a;\nnb := NOT c;',
        expect: { x: 0xF000, y: 0xFFF0, z: 0x0FF0, n: 0x0F0F, nb: 0xF0 },
    },
    {
        name: 'bit access reads bit n of a WORD',
        ref: 'T17',
        vars: ['w : WORD := 16#0005', 'b0 : BOOL', 'b1 : BOOL', 'b2 : BOOL', 'b15 : BOOL', 'v : WORD := 16#8000'],
        code: 'b0 := w.0;\nb1 := w.1;\nb2 := w.2;\nb15 := v.15;',
        expect: { b0: true, b1: false, b2: true, b15: true },
    },
    {
        name: 'bit access with the %X prefix',
        ref: 'T17',
        todo: 'known issue (docs/CLAUDE.md): partial access v.%Xn / v.%Bn / v.%Wn / v.%Dn is not parsed',
        vars: ['w : WORD := 16#0004', 'b2 : BOOL'],
        code: 'b2 := w.%X2;',
        expect: { b2: true },
    },
    {
        name: 'bit access write',
        ref: 'T17 (write = extension)',
        vars: ['w : WORD := 16#0000', 'b : BYTE := 16#FF'],
        code: 'w.3 := TRUE;\nw.15 := TRUE;\nb.0 := FALSE;',
        expect: { w: 0x8008, b: 0xFE },
    },
    {
        name: 'byte / word partial access',
        ref: 'T17',
        todo: 'known issue (docs/CLAUDE.md): partial access v.%Xn / v.%Bn / v.%Wn / v.%Dn is not parsed',
        vars: ['d : DWORD := 16#12345678', 'b1 : BYTE', 'w1 : WORD'],
        code: 'b1 := d.%B1;\nw1 := d.%W1;',
        expect: { b1: 0x56, w1: 0x1234 },
    },
    {
        name: 'BAND / BOR / BXOR / BNOT on integers (vendor extension)',
        ref: '§16.4',
        vars: ['a : INT := 12', 'b : INT := 10', 'x : INT', 'y : INT', 'z : INT', 'n : INT'],
        code: 'x := a BAND b;\ny := a BOR b;\nz := a BXOR b;\nn := BNOT a;',
        expect: { x: 8, y: 14, z: 6, n: -13 },
    },

    // ── selection ───────────────────────────────────────────────────────────
    {
        name: 'SEL formal and non-formal',
        ref: 'T32',
        vars: ['g : BOOL := TRUE', 'a : INT', 'b : INT', 'X : INT := 42'],
        code: 'a := SEL(g, 10, 20);\nb := SEL(G := FALSE, IN0 := X, IN1 := 5);',
        expect: { a: 20, b: 42 },
    },
    {
        name: 'MIN / MAX extensible, REAL and INT',
        ref: 'T32',
        vars: ['a : INT', 'b : INT', 'c : REAL', 'x : INT := -3', 'f : REAL := 1.5'],
        code: 'a := MIN(5, x, 7);\nb := MAX(5, x, 7, 2);\nc := MAX(f, 2.25);',
        expect: { a: -3, b: 7, c: 2.25 },
    },
    {
        name: 'LIMIT clamps (formal)',
        ref: 'T32',
        vars: ['a : INT', 'b : INT', 'c : INT', 'v : INT := -50'],
        code: 'a := LIMIT(MN := 0, IN := v, MX := 10);\nb := LIMIT(MN := 0, IN := 5, MX := 10);\nc := LIMIT(MN := 0, IN := 500, MX := 10);',
        expect: { a: 0, b: 5, c: 10 },
    },
    {
        name: 'MUX selects input K (0-based)',
        ref: 'T32',
        vars: ['B : INT := 11', 'C : INT := 22', 'D : INT := 33', 'k : INT := 2', 'r0 : INT', 'r2 : INT', 'rf : INT'],
        code: 'r0 := MUX(0, B, C, D);\nr2 := MUX(k, B, C, D);\nrf := MUX(K := 1, IN0 := B, IN1 := C, IN2 := D);',
        expect: { r0: 11, r2: 33, rf: 22 },
    },

    // ── comparison functions ────────────────────────────────────────────────
    {
        name: 'bit strings compare unsigned',
        ref: 'T33',
        vars: ['a : WORD := 16#8000', 'b : WORD := 16#0001', 'r : BOOL'],
        code: 'r := a > b;',
        expect: { r: true },
    },
];
