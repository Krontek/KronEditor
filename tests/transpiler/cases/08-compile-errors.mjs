const arr = (name, baseType, dims) => ({ name, type: 'Array', content: { baseType, dimensions: dims.map(([min, max]) => ({ min, max })) } });

// Programs the transpiler must REJECT at transpile time, with a message that
// names the problem. Each `error` regex is deliberately loose (a keyword of the
// cause) so rewording a message does not break the test, but a silent accept
// — "plausible-but-wrong output", root CLAUDE.md — does.
// Standards/iec61131-3.md §14 (compile time), F11/F12, §16.1, §16.5.
export default [
    // ── F11/F12 implicit conversions ────────────────────────────────────────
    { name: 'INT := DINT needs an explicit conversion', ref: 'F11 / §18', vars: ['i : INT', 'd : DINT'], code: 'i := d;', error: /DINT_TO_INT/ },
    { name: 'WORD := INT needs an explicit conversion', ref: 'F11 / §18', vars: ['w : WORD', 'i : INT'], code: 'w := i;', error: /INT_TO_WORD/ },
    { name: 'REAL := DINT needs an explicit conversion', ref: 'F11 / §18', vars: ['r : REAL', 'd : DINT'], code: 'r := d;', error: /DINT_TO_REAL/ },
    { name: 'INT := REAL needs an explicit conversion', ref: 'F11', vars: ['i : INT', 'r : REAL'], code: 'i := r;', error: /REAL_TO_INT/ },
    { name: 'UINT := INT (signed → unsigned) needs a conversion', ref: 'F11', vars: ['u : UINT', 'i : INT'], code: 'u := i;', error: /INT_TO_UINT/ },
    { name: 'BOOL := INT needs a conversion', ref: 'F11', vars: ['b : BOOL', 'i : INT := 5'], code: 'b := i;', error: /BOOL|INT/ },
    { name: 'STRING := INT needs a conversion', ref: 'F11', vars: ['s : STRING', 'i : INT'], code: 's := i;', error: /_TO_STRING/ },
    { name: 'INT := 2 ** 3 (EXPT base must be REAL)', ref: 'T29 fn. f / §18', vars: ['i : INT'], code: 'i := 2 ** 3;', error: /REAL|EXPT|\*\*/ },
    { name: 'in-out actual must have exactly the formal type', ref: '§14',
        functions: [{ name: 'Inc', returnType: 'BOOL', vars: ['INOUT v : DINT'], code: 'v := v + 1;\nInc := TRUE;' }],
        vars: ['x : INT', 'ok : BOOL'], code: 'ok := Inc(v := x);', error: /DINT|INT|in-out|IN_OUT/i },

    // ── operand types ───────────────────────────────────────────────────────
    { name: 'arithmetic on BOOL', ref: '§14', vars: ['a : BOOL', 'b : BOOL', 'c : BOOL'], code: 'c := a + b;', error: /BOOL|number/i },
    { name: 'AND on INT (bitwise ops need a bit string)', ref: '§16.1', vars: ['a : INT', 'b : INT', 'c : INT'], code: 'c := a AND b;', error: /AND|INT|BAND/ },
    { name: 'MOD on REAL', ref: 'T29', vars: ['a : REAL', 'b : REAL'], code: 'b := a MOD 2.0;', error: /MOD/ },
    { name: 'IF on a non-BOOL condition', ref: '§7.3.3.3', vars: ['a : INT'], code: 'IF a THEN a := 1; END_IF;', error: /BOOL/ },
    { name: 'WHILE on a non-BOOL condition', ref: '§7.3.3.4', vars: ['a : INT'], code: 'WHILE a DO a := a - 1; END_WHILE;', error: /BOOL/ },
    { name: 'arithmetic on an enum value', ref: 'T38',
        dataTypes: [{ name: 'Color', type: 'Enumerated', content: { values: [{ name: 'Red' }, { name: 'Green' }] } }],
        vars: ['c : Color'], code: 'c := c + 1;', error: /enum|Color|arithmetic/i },
    { name: 'ordering compare on an enum', ref: 'T38',
        dataTypes: [{ name: 'Color', type: 'Enumerated', content: { values: [{ name: 'Red' }, { name: 'Green' }] } }],
        vars: ['c : Color', 'b : BOOL'], code: 'b := c < Green;', error: /enum|Color|=|<>/i },
    { name: 'STRING ordering compare', ref: '§16.3', vars: ['a : STRING', 'b : BOOL'], code: "b := a < 'x';", error: /STRING/ },
    { name: 'STRING arithmetic', ref: '§14', vars: ['a : STRING', 'b : STRING'], code: "b := a + 'x';", error: /STRING/ },
    { name: 'bit access on a REAL', ref: 'T17', vars: ['r : REAL', 'b : BOOL'], code: 'b := r.0;', error: /bit|REAL/i },
    { name: 'bit index out of range for the type', ref: 'T17', vars: ['w : BYTE', 'b : BOOL'], code: 'b := w.8;', error: /bit|range|BYTE|8/i },

    // ── names ───────────────────────────────────────────────────────────────
    { name: 'undeclared variable', ref: '§14', vars: ['a : INT'], code: 'a := nope + 1;', error: /nope/ },
    { name: 'unknown function', ref: '§14', vars: ['a : INT'], code: 'a := NoSuchFn(1);', error: /NoSuchFn/ },
    { name: 'keyword used as a variable name', ref: '§6.1.3', vars: ['IF : INT'], code: ';', error: /keyword/i },
    { name: 'invalid identifier: double underscore', ref: '§6.1.2', vars: ['a__b : INT'], code: ';', error: /a__b/ },
    { name: 'invalid identifier: trailing underscore', ref: '§6.1.2', vars: ['ab_ : INT'], code: ';', error: /ab_/ },

    // ── writability ─────────────────────────────────────────────────────────
    { name: 'write to a CONSTANT', ref: '§6.5.2.2', vars: ['CONST K : INT := 3'], code: 'K := 4;', error: /CONSTANT/ },
    { name: 'write to the POU\'s own VAR_INPUT', ref: '§14',
        functionBlocks: [{ name: 'Fb1', vars: ['IN x : INT', 'OUT y : INT'], code: 'x := 1;\ny := x;' }],
        vars: ['f : Fb1'], code: 'f(x := 2);', error: /VAR_INPUT|input|x/i },
    { name: 'write to the FOR control variable inside the loop', ref: '§7.3.3.4.2', vars: ['i : INT'],
        code: 'FOR i := 1 TO 10 DO i := i + 1; END_FOR;', error: /FOR|control/i },
    { name: 'write to an FB output from outside', ref: 'F13',
        vars: ['t : TON'], code: 't.Q := TRUE;', error: /output|Q|F13/i },
    { name: 'read an FB input from outside', ref: 'F13',
        functionBlocks: [{ name: 'Fb2', vars: ['IN x : INT', 'OUT y : INT'], code: 'y := x;' }],
        vars: ['f : Fb2', 'v : INT'], code: 'v := f.x;', error: /input|x|F13/i },
    { name: 'literal on a VAR_IN_OUT', ref: '§14',
        functions: [{ name: 'Inc', returnType: 'BOOL', vars: ['INOUT v : DINT'], code: 'v := v + 1;\nInc := TRUE;' }],
        vars: ['ok : BOOL'], code: 'ok := Inc(v := 5);', error: /in-out|IN_OUT|variable|literal/i },

    // ── statements ──────────────────────────────────────────────────────────
    { name: 'FOR with a literal BY 0', ref: '§7.3.3.4.2', vars: ['i : INT'], code: 'FOR i := 1 TO 3 BY 0 DO ; END_FOR;', error: /BY|0/ },
    { name: 'FOR with a REAL control variable', ref: '§7.3.3.4.2', vars: ['r : REAL'], code: 'FOR r := 1 TO 3 DO ; END_FOR;', error: /INT|REAL|control/i },
    { name: 'chained comparison (Kron decision)', ref: '§16.5 29', vars: ['a : INT', 'b : INT', 'c : INT', 'r : BOOL'], code: 'r := a < b < c;', error: /chain|compar/i },
    { name: ':= inside an expression', ref: 'src/services/CLAUDE.md', vars: ['a : INT', 'b : BOOL'], code: 'b := (a := 1) = 1;', error: /:=/ },
    { name: 'CASE label that is not a constant', ref: '§7.3.3.3', vars: ['x : INT', 'y : INT', 'r : INT'],
        code: 'CASE x OF y: r := 1; END_CASE;', error: /constant|label|y/i },
    { name: 'FUNCTION that never assigns its result', ref: '§7.3.3.2.3',
        functions: [{ name: 'NoRes', returnType: 'INT', vars: ['IN v : INT'], code: ';' }],
        vars: ['a : INT'], code: 'a := NoRes(1);', error: /NoRes|result|assign/i },
    { name: 'non-formal call with the wrong number of arguments', ref: '§14',
        functions: [{ name: 'Two', returnType: 'INT', vars: ['IN a : INT', 'IN b : INT'], code: 'Two := a + b;' }],
        vars: ['r : INT'], code: 'r := Two(1);', error: /argument|Two|parameter/i },
    { name: 'array literal index out of bounds', ref: '§14', dataTypes: [arr('A03', 'INT', [[0, 3]])], vars: ['a : A03'], code: 'a[4] := 1;', error: /4|bound|range|index/i },
    { name: 'unterminated IF', ref: 'Annex A', vars: ['a : INT'], code: 'IF a = 1 THEN a := 2;', error: /END_IF|IF/ },
    { name: 'stray END_FOR', ref: 'Annex A', vars: ['a : INT'], code: 'a := 1;\nEND_FOR;', error: /END_FOR|FOR/,
        todo: 'known issue (docs/CLAUDE.md): an unmatched END_FOR/END_IF/END_WHILE is emitted as a bare "}" and only clang fails' },
    { name: 'block terminators in the wrong order', ref: 'Annex A', vars: ['x : BOOL', 'i : INT', 'a : INT'],
        code: 'IF x THEN\n  FOR i := 1 TO 3 DO a := a + 1;\n  END_IF;\nEND_FOR;', error: /END_IF|END_FOR/ },
    { name: 'unbalanced parentheses', ref: 'Annex A', vars: ['a : INT'], code: 'a := (1 + 2;', error: /\)|paren|unexpected/i },
    { name: 'missing operand', ref: 'Annex A', vars: ['a : INT'], code: 'a := 1 + ;', error: /unexpected|operand|expected/i },
    { name: 'TIME + number is a type error', ref: 'T35', vars: ['t : TIME', 'u : TIME'], code: 'u := t + 5;', error: /TIME/ },
    { name: 'TIME * TIME is a type error', ref: 'T35', vars: ['t : TIME', 'u : TIME'], code: 'u := t * t;', error: /TIME/ },
];
