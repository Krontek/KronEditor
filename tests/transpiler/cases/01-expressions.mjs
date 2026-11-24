// Expressions: precedence, associativity, arithmetic semantics.
// Expected values: Standards/iec61131-3.md §10.1/§10.2 (T71, Annex A) and
// the §18 test vectors.
export default [
    {
        name: 'precedence: A+B-C*ABS(D)',
        ref: '§7.3.2 ex. 1',
        vars: ['A : INT := 1', 'B : INT := 2', 'C : INT := 3', 'D : INT := 4', 'r1 : INT', 'r2 : INT'],
        code: 'r1 := A+B-C*ABS(D);\nr2 := (A+B-C)*ABS(D);',
        expect: { r1: -9, r2: 0 },
    },
    {
        name: 'unary minus binds tighter than **',
        ref: 'T71 / Annex A',
        vars: ['r : REAL', 'x : REAL := 2.0', 'r2 : REAL'],
        code: 'r := -2.0 ** 2.0;\nr2 := -x ** 2.0;',
        expect: { r: 4.0, r2: 4.0 },
    },
    {
        name: '** is left-associative',
        ref: '§7.3.2 rule 2',
        vars: ['r : REAL'],
        code: 'r := 2.0 ** 3.0 ** 2.0;',
        expect: { r: 64.0 },
    },
    {
        name: '** accepts a unary exponent',
        ref: 'Annex A Power_Expr',
        vars: ['r : REAL'],
        code: 'r := 2.0 ** -1.0;',
        expect: { r: 0.5 },
    },
    {
        name: 'integer division truncates toward zero',
        ref: 'T29 fn. d',
        vars: ['a : INT := 7', 'b : INT := -7', 'q1 : INT', 'q2 : INT'],
        code: 'q1 := a / 3;\nq2 := b / 3;',
        expect: { q1: 2, q2: -2 },
    },
    {
        name: 'MOD takes the sign of the dividend, MOD 0 = 0',
        ref: 'T29 fn. e',
        vars: ['a : INT := 7', 'b : INT := -7', 'z : INT := 0', 'm1 : INT', 'm2 : INT', 'm3 : INT'],
        code: 'm1 := a MOD 3;\nm2 := b MOD 3;\nm3 := 5 MOD z;',
        expect: { m1: 1, m2: -1, m3: 0 },
    },
    {
        name: 'REAL division keeps the fraction',
        vars: ['a : REAL := 7.0', 'r : REAL'],
        code: 'r := a / 2.0;',
        expect: { r: 3.5 },
    },
    {
        name: 'LREAL keeps double precision',
        vars: ['a : LREAL := 1.0', 'r : LREAL'],
        code: 'r := a / 3.0;',
        expect: { r: 1 / 3 },
        tol: 1e-15,
    },
    {
        name: 'AND binds tighter than XOR, XOR tighter than OR',
        ref: 'T71',
        vars: ['a : BOOL := TRUE', 'b : BOOL := FALSE', 'c : BOOL := TRUE', 'd : BOOL := FALSE',
            'r1 : BOOL', 'r2 : BOOL', 'r3 : BOOL'],
        // r1: a OR (b XOR c) = TRUE ; C precedence would give (a|b)^c = FALSE
        // r2: (a AND b) OR (c AND d) = FALSE
        // r3: a XOR (b AND c) = TRUE
        code: 'r1 := a OR b XOR c;\nr2 := a AND b OR c AND d;\nr3 := a XOR b AND c;',
        expect: { r1: true, r2: false, r3: true },
    },
    {
        // Exhaustive: a single input vector can agree under both precedences
        // (C has ^ above &&), so every combination is checked.
        name: 'AND / XOR / OR precedence, full truth table',
        ref: 'T71',
        vars: ['a : BOOL', 'b : BOOL', 'c : BOOL', 'x1 : BOOL', 'x2 : BOOL', 'x3 : BOOL', 'x4 : BOOL'],
        code: 'x1 := a XOR b AND c;\nx2 := a AND b XOR c;\nx3 := a OR b XOR c;\nx4 := a XOR b OR c;',
        steps: [0, 1, 2, 3, 4, 5, 6, 7].map(n => {
            const a = !!(n & 4), b = !!(n & 2), c = !!(n & 1);
            return { set: { a, b, c }, expect: { x1: a !== (b && c), x2: (a && b) !== c, x3: a || (b !== c), x4: (a !== b) || c } };
        }),
    },
    {
        name: '& is AND',
        ref: 'T71',
        vars: ['a : BOOL := TRUE', 'b : BOOL := TRUE', 'r : BOOL'],
        code: 'r := a & b;',
        expect: { r: true },
    },
    {
        name: 'NOT binds tighter than =',
        ref: '§16.7 / T71',
        vars: ['a : BOOL := TRUE', 'b : BOOL := FALSE', 'r : BOOL'],
        code: 'r := NOT a = b;', // (NOT a) = b → TRUE
        expect: { r: true },
    },
    {
        name: 'relational binds tighter than equality',
        ref: 'Annex A, §17',
        vars: ['a : INT := 1', 'b : INT := 2', 'c : INT := 3', 'd : INT := 4', 'r : BOOL'],
        code: 'r := a < b = c < d;', // (1<2) = (3<4) → TRUE
        expect: { r: true },
    },
    {
        name: 'comparison operators',
        vars: ['a : INT := 5', 'b : INT := 7',
            'lt : BOOL', 'le : BOOL', 'gt : BOOL', 'ge : BOOL', 'eq : BOOL', 'ne : BOOL'],
        code: 'lt := a < b; le := a <= 5; gt := a > b; ge := b >= 7; eq := a = b; ne := a <> b;',
        expect: { lt: true, le: true, gt: false, ge: true, eq: false, ne: true },
    },
    {
        name: 'unsigned comparison is unsigned',
        vars: ['a : UDINT := 4000000000', 'b : UDINT := 1', 'r : BOOL'],
        code: 'r := a > b;',
        expect: { r: true },
    },
    {
        name: 'mixed INT/DINT operands widen (F12)',
        ref: '§6.6 F12',
        vars: ['i : INT := 30000', 'd : DINT := 30000', 'r : DINT'],
        code: 'r := i + d;',
        expect: { r: 60000 },
    },
    {
        // (An INT overflow such as a * b here is a known, unreported deviation
        // — docs/CLAUDE.md — so it is deliberately not asserted.)
        name: 'explicit widening before a multiply',
        vars: ['a : INT := 200', 'b : INT := 300', 'w : DINT'],
        code: 'w := INT_TO_DINT(a) * INT_TO_DINT(b);',
        expect: { w: 60000 },
    },
    {
        name: 'unary minus and plus on variables',
        vars: ['a : INT := 5', 'r1 : INT', 'r2 : INT'],
        code: 'r1 := -a;\nr2 := +a;',
        expect: { r1: -5, r2: 5 },
    },
    {
        name: 'parenthesised nested expression',
        vars: ['a : DINT := 3', 'b : DINT := 4', 'r : DINT'],
        code: 'r := ((a + b) * (a - b)) * 2 - (a * (b + 1));',
        expect: { r: -29 },
    },
    {
        name: 'operands are evaluated left to right',
        ref: '§7.3.2 rule 3',
        functions: [{
            name: 'Bump', returnType: 'INT',
            vars: ['INOUT c : INT', 'IN k : INT'],
            code: 'c := c * 10 + k;\nBump := k;',
        }],
        vars: ['cnt : INT := 0', 'r : INT'],
        // Left Bump runs first: cnt = (0*10+1)*10+2 = 12
        code: 'r := Bump(c := cnt, k := 1) - Bump(c := cnt, k := 2);',
        expect: { cnt: 12, r: -1 },
    },
    {
        name: 'TIME arithmetic',
        ref: 'T35',
        vars: ['a : TIME := T#1s', 'b : TIME := T#250ms', 'sum : TIME', 'diff : TIME', 'mul : TIME', 'dv : TIME'],
        code: 'sum := a + b;\ndiff := a - b;\nmul := b * 4;\ndv := a / 4;',
        // TIME is int64 MICROseconds (root CLAUDE.md)
        expect: { sum: 1250000, diff: 750000, mul: 1000000, dv: 250000 },
    },
    {
        name: 'TIME comparison',
        vars: ['a : TIME := T#1s', 'b : TIME := T#999ms', 'r : BOOL'],
        code: 'r := a > b;',
        expect: { r: true },
    },
];
