// Data types and variables: elementary widths, arrays, structures, enums,
// STRING, globals, CONSTANT, initial values.
// Standards/iec61131-3.md §4 (§6.4), §5 (§6.5) and the §18 vectors.
const arr = (name, baseType, dims) => ({ name, type: 'Array', content: { baseType, dimensions: dims.map(([min, max]) => ({ min, max })) } });
const struct = (name, members) => ({ name, type: 'Structure', content: { members: members.map(([n, t, init]) => ({ name: n, type: t, ...(init !== undefined ? { initialValue: init } : {}) })) } });
const enumT = (name, values) => ({ name, type: 'Enumerated', content: { values: values.map(v => (Array.isArray(v) ? { name: v[0], value: v[1] } : { name: v })) } });

export default [
    // ── elementary types ────────────────────────────────────────────────────
    {
        name: 'integer types hold their full range',
        ref: 'T10',
        vars: ['s : SINT := -128', 'us : USINT := 255', 'i : INT := -32768', 'ui : UINT := 65535',
            'd : DINT := -2147483648', 'ud : UDINT := 4294967295',
            'l : LINT := -9223372036854775808', 'ul : ULINT := 18446744073709551615'],
        code: ';',
        expect: { s: -128, us: 255, i: -32768, ui: 65535, d: -2147483648, ud: 4294967295,
            l: -9223372036854775808n, ul: 18446744073709551615n },
    },
    {
        name: 'unsigned arithmetic wraps modulo 2^n (defined by -fwrapv / C)',
        vars: ['u : USINT := 255', 'r : USINT', 'w : UINT := 0', 'q : UINT'],
        code: 'r := u + 1;\nq := w - 1;',
        expect: { r: 0, q: 65535 },
    },
    {
        name: 'REAL is single precision, LREAL double',
        ref: 'T10',
        vars: ['r : REAL', 'l : LREAL'],
        code: 'r := REAL#16777217.0;\nl := 16777217.0;',
        // 2^24 + 1 is not representable in binary32
        expect: { r: 16777216, l: 16777217 },
        tol: 0,
    },
    {
        name: 'default initial values are zero / FALSE / empty',
        ref: 'T10',
        vars: ['a : INT', 'b : BOOL', 'c : REAL', 'd : TIME', 'e : STRING', 'f : WORD'],
        code: ';',
        expect: { a: 0, b: false, c: 0, d: 0, e: '', f: 0 },
    },

    // ── arrays ──────────────────────────────────────────────────────────────
    {
        name: 'inline ARRAY declaration (instant type)',
        ref: '§6.5.1 instant type',
        todo: 'known issue (docs/CLAUDE.md): a variable typed "ARRAY[..] OF T" inline is dropped from PlcState; clang reports it',
        vars: ['a : ARRAY[1..5] OF INT', 'r : INT'],
        code: 'a[2] := 4;\nr := a[2];',
        expect: { r: 4 },
    },
    {
        name: 'ARRAY indexed read/write in a FOR loop',
        ref: '§6.4.4.5',
        dataTypes: [arr('A15', 'INT', [[1, 5]])],
        vars: ['a : A15', 'i : INT', 's : INT'],
        code: 'FOR i := 1 TO 5 DO a[i] := i * i; END_FOR;\ns := a[1] + a[5];',
        expect: { s: 26, 'a[3]': 9 },
    },
    {
        name: 'array with a lower bound > 0 keeps raw IEC indices',
        ref: 'src/services/CLAUDE.md [max+1]',
        dataTypes: [arr('A1012', 'DINT', [[10, 12]])],
        vars: ['a : A1012'],
        code: 'a[10] := 1; a[11] := 2; a[12] := 3;',
        expect: { 'a[10]': 1, 'a[11]': 2, 'a[12]': 3 },
    },
    {
        name: 'array initialiser: list, single-value repetition, too few values',
        ref: '§6.4.4.5.2',
        dataTypes: [arr('A05', 'INT', [[0, 5]]), arr('A04', 'INT', [[0, 4]])],
        vars: ['a : A05 := [1, 2(5), 3(0)]', 'b : A04 := [1, 2]'],
        code: ';',
        expect: { 'a[0]': 1, 'a[1]': 5, 'a[2]': 5, 'a[3]': 0, 'a[5]': 0, 'b[1]': 2, 'b[2]': 0, 'b[4]': 0 },
    },
    {
        name: 'array initialiser: multi-value repetition [2(1, 2, 3)]',
        ref: '§6.4.4.5.2 / §18',
        todo: 'known issue (docs/CLAUDE.md): n(a, b, c) is emitted as the C comma expression "x[0] = 1, 2, 3"',
        dataTypes: [arr('A05', 'INT', [[0, 5]])],
        vars: ['a : A05 := [2(1, 2, 3)]'],
        code: ';',
        expect: { 'a[0]': 1, 'a[1]': 2, 'a[2]': 3, 'a[3]': 1, 'a[4]': 2, 'a[5]': 3 },
    },
    {
        name: 'two-dimensional array, row-major initialiser',
        ref: 'T14 3 / §18',
        dataTypes: [arr('T23', 'INT', [[1, 2], [1, 3]])],
        vars: ['TBT : T23 := [9, 8, 3(10), 6]', 'x : INT'],
        code: 'x := TBT[2, 3] + TBT[1, 1];',
        expect: { 'TBT[1][3]': 10, 'TBT[2][1]': 10, 'TBT[2][3]': 6, x: 15 },
    },
    {
        name: 'user ARRAY type and whole-array assignment',
        ref: 'T72 1c / §16.1',
        dataTypes: [arr('Vec3', 'REAL', [[0, 2]])],
        vars: ['a : Vec3', 'b : Vec3'],
        code: 'a[0] := 1.0; a[1] := 2.0; a[2] := 3.0;\nb := a;\na[0] := 99.0;',
        expect: { 'b[0]': 1.0, 'b[2]': 3.0, 'a[0]': 99.0 },
    },
    {
        name: 'array index is an expression',
        dataTypes: [arr('A09', 'INT', [[0, 9]])],
        vars: ['a : A09', 'i : INT := 3', 'r : INT'],
        code: 'a[i * 2 + 1] := 42;\nr := a[7];',
        expect: { r: 42 },
    },

    // ── structures ──────────────────────────────────────────────────────────
    {
        name: 'STRUCT member access, member initial values',
        ref: '§6.4.4.6',
        dataTypes: [struct('Point', [['x', 'REAL', '1.5'], ['y', 'REAL'], ['tag', 'INT', '7']])],
        vars: ['p : Point', 'r : REAL', 't : INT'],
        code: 'p.y := p.x * 2.0;\nr := p.x + p.y;\nt := p.tag;',
        expect: { r: 4.5, t: 7, 'p.y': 3.0 },
    },
    {
        name: 'nested STRUCT and an array of STRUCT',
        dataTypes: [
            struct('Inner', [['v', 'INT']]),
            struct('Outer', [['a', 'Inner'], ['n', 'INT']]),
            arr('Outers', 'Outer', [[0, 2]]),
        ],
        vars: ['o : Outer', 'list : Outers', 'i : INT', 's : INT'],
        code: 'o.a.v := 5;\nFOR i := 0 TO 2 DO list[i].a.v := i * 10; END_FOR;\ns := o.a.v + list[2].a.v;',
        expect: { s: 25, 'list[1].a.v': 10 },
    },
    {
        name: 'STRUCT assignment of the same type copies every member',
        ref: '§6.4.4.6',
        dataTypes: [struct('Pair', [['a', 'INT'], ['b', 'INT']])],
        vars: ['p : Pair', 'q : Pair'],
        code: 'p.a := 1; p.b := 2;\nq := p;\np.a := 9;',
        expect: { 'q.a': 1, 'q.b': 2, 'p.a': 9 },
    },
    {
        name: 'STRUCT declaration initialiser overrides member init',
        ref: '§6.4.4.6 init priority',
        dataTypes: [struct('Cfg', [['lo', 'INT', '1'], ['hi', 'INT', '2']])],
        vars: ['c : Cfg := (hi := 20)'],
        code: ';',
        expect: { 'c.lo': 1, 'c.hi': 20 },
    },

    // ── enumerations ────────────────────────────────────────────────────────
    {
        name: 'enum default is the first value; = / <> compare',
        ref: '§6.4.4.2.2 / §18',
        dataTypes: [enumT('Color', ['Red', 'Amber', 'Green'])],
        vars: ['c : Color', 'isRed : BOOL', 'notGreen : BOOL'],
        code: 'isRed := c = Red;\nnotGreen := c <> Green;',
        expect: { isRed: true, notGreen: true },
    },
    {
        name: 'enum assignment and qualified value Type#Value',
        ref: '§6.4.4.2',
        dataTypes: [enumT('Color', ['Red', 'Amber', 'Green'])],
        vars: ['c : Color', 'ok : BOOL'],
        code: 'c := Color#Green;\nok := c = Green;',
        expect: { ok: true },
    },
    {
        name: 'the same enum value name in two enumerations, qualified',
        ref: '§16.1',
        dataTypes: [enumT('Light', ['Off', 'Lit']), enumT('Pump', ['Off', 'Run'])],
        vars: ['l : Light := Light#Lit', 'p : Pump := Pump#Run', 'a : BOOL', 'b : BOOL'],
        code: 'a := l = Light#Lit;\nb := p = Pump#Off;',
        expect: { a: true, b: false },
    },

    // ── STRING ──────────────────────────────────────────────────────────────
    {
        name: 'STRING assignment copies the value, not a pointer',
        ref: 'src/services/CLAUDE.md STRING is a VALUE',
        vars: ['a : STRING := \'first\'', 'b : STRING'],
        code: "b := a;\na := 'second';",
        expect: { a: 'second', b: 'first' },
    },
    {
        name: 'STRING = / <> compare text, not addresses',
        ref: 'src/services/CLAUDE.md __kron_streq',
        vars: ['a : STRING := \'abc\'', 'b : STRING', 'eq : BOOL', 'ne : BOOL', 'lit : BOOL'],
        code: "b := 'ab';\nb := CONCAT(b, 'c');\neq := a = b;\nne := a <> 'abd';\nlit := a = 'abc';",
        todo: 'known issue (docs/CLAUDE.md): T34 string functions (LEN/LEFT/RIGHT/MID/CONCAT/INSERT/DELETE/REPLACE/FIND) are not available in ST',
        expect: { eq: true, ne: true, lit: true },
    },
    {
        name: 'STRING compare of two separately built buffers',
        ref: 'src/services/CLAUDE.md __kron_streq',
        vars: ['a : STRING', 'b : STRING', 'eq : BOOL', 'ne : BOOL', 'lit : BOOL'],
        code: "a := 'abc';\nb := 'abc';\neq := a = b;\nne := a <> 'abd';\nlit := a = 'abc';",
        expect: { eq: true, ne: true, lit: true },
    },
    {
        name: 'STRING longer than 63 bytes is truncated',
        ref: '§16.5 31',
        vars: ['s : STRING'],
        code: "s := '0123456789012345678901234567890123456789012345678901234567890123456789';",
        expect: { s: '012345678901234567890123456789012345678901234567890123456789012' },
    },
    {
        name: 'INT_TO_STRING / STRING_TO_INT',
        ref: 'T22 fn. e',
        vars: ['s : STRING', 'i : INT', 'v : INT := -42'],
        code: "s := INT_TO_STRING(v);\ni := STRING_TO_INT('123');",
        expect: { s: '-42', i: 123 },
    },
    {
        name: 'T34 string functions',
        ref: 'T34 / §18',
        todo: 'known issue (docs/CLAUDE.md): T34 string functions (LEN/LEFT/RIGHT/MID/CONCAT/INSERT/DELETE/REPLACE/FIND) are not available in ST',
        vars: ['n : INT', 'm : STRING', 'c : STRING', 'f : INT'],
        code: "n := LEN('ASTRING');\nm := MID(IN := 'ASTR', L := 2, P := 2);\nc := CONCAT('AB', 'CD', 'E');\nf := FIND(IN1 := 'ABCBC', IN2 := 'BC');",
        expect: { n: 7, m: 'ST', c: 'ABCDE', f: 2 },
    },

    // ── globals / constants ─────────────────────────────────────────────────
    {
        name: 'global variable read and written from a program',
        ref: '§6.5.2',
        globals: ['gCount : DINT := 10', 'gFlag : BOOL'],
        vars: ['r : DINT'],
        code: 'gCount := gCount + 1;\ngFlag := gCount > 10;\nr := gCount;',
        scans: 2,
        expect: { r: 12, gCount: 12, gFlag: true },
    },
    {
        name: 'global used by a user FUNCTION',
        globals: ['gGain : REAL := 2.5'],
        functions: [{ name: 'Amp', returnType: 'REAL', vars: ['IN x : REAL'], code: 'Amp := x * gGain;' }],
        vars: ['r : REAL'],
        code: 'r := Amp(4.0);',
        expect: { r: 10.0 },
    },
    {
        name: 'CONSTANT in an expression and as a loop bound',
        ref: '§6.5.4',
        dataTypes: [arr('A03', 'INT', [[0, 3]])],
        vars: ['CONST N : INT := 4', 'a : A03', 'i : INT', 's : INT'],
        code: 'FOR i := 0 TO N - 1 DO a[i] := N; END_FOR;\ns := a[0] + a[3];',
        expect: { s: 8 },
    },
    {
        name: 'variables differing only in case are the same name',
        ref: 'T1 fn. a / root CLAUDE.md case-insensitive',
        todo: 'known issue (docs/CLAUDE.md): "B" and "b" in one POU become two PlcState fields; reads of B resolve to b',
        vars: ['B : INT := 11', 'b : INT'],
        error: /B|b|duplicate|already declared/i,
        code: 'b := B;',
    },
];
