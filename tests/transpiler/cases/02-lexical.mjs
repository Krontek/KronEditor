// Lexical elements and source layout: literals, comments, strings, case
// insensitivity, statements spread over / packed into lines.
// Standards/iec61131-3.md §3 (§6.1–6.3, T1–T8) and src/services/CLAUDE.md
// "ST line handling".
export default [
    // ── numeric literals ────────────────────────────────────────────────────
    {
        name: 'leading zeros are decimal, not octal',
        ref: 'T5',
        vars: ['r : INT'],
        code: 'r := 014;',
        expect: { r: 14 },
    },
    {
        name: 'underscores between digits are ignored',
        ref: 'T5',
        vars: ['r : DINT', 'f : REAL'],
        code: 'r := 1_000_000;\nf := 3.141_59;',
        expect: { r: 1000000, f: 3.14159 },
    },
    {
        name: 'based literals 2# 8# 16#',
        ref: 'T5',
        vars: ['a : WORD', 'b : WORD', 'c : WORD', 'd : WORD'],
        code: 'a := 2#1111_0000;\nb := 8#377;\nc := 16#FF;\nd := 16#ab_cd;',
        expect: { a: 0xF0, b: 255, c: 255, d: 0xABCD },
    },
    {
        name: 'real literals with exponent',
        ref: 'T5',
        vars: ['a : LREAL', 'b : LREAL', 'c : LREAL'],
        code: 'a := 1.0E+6;\nb := -1.34E-12;\nc := 1.5e3;',
        expect: { a: 1e6, b: -1.34e-12, c: 1500 },
        tol: 1e-20,
    },
    {
        name: 'typed literals',
        ref: 'T5',
        vars: ['i : INT', 'w : WORD', 'r : REAL', 'b : BOOL', 'u : UINT'],
        code: 'i := INT#-123;\nw := WORD#16#AFF;\nr := REAL#1.5;\nb := BOOL#1;\nu := UINT#16#89AF;',
        expect: { i: -123, w: 0xAFF, r: 1.5, b: true, u: 0x89AF },
    },
    {
        name: 'BOOL literals TRUE/FALSE/0/1',
        ref: 'T5',
        vars: ['a : BOOL', 'b : BOOL := TRUE', 'c : BOOL', 'd : BOOL'],
        code: 'a := TRUE;\nb := FALSE;\nc := BOOL#TRUE;\nd := BOOL#0;',
        expect: { a: true, b: false, c: true, d: false },
    },
    {
        name: 'duration literals: units, overflow of the leading unit, fraction, sign',
        ref: 'T8',
        vars: ['a : TIME', 'b : TIME', 'c : TIME', 'd : TIME', 'e : TIME', 'f : TIME'],
        code: [
            'a := T#25h_15m;',
            'b := t#1d2h3m4s5ms6us;',
            'c := T#14.7s;',
            'd := TIME#90m;',
            'e := T#-14ms;',
            'f := t#1.5ms;',
        ].join('\n'),
        expect: {
            a: (25 * 3600 + 15 * 60) * 1e6,
            b: ((((1 * 24 + 2) * 60 + 3) * 60 + 4) * 1000 + 5) * 1000 + 6,
            c: 14700000,
            d: 90 * 60 * 1e6,
            e: -14000,
            f: 1500,
        },
    },
    {
        name: 'LTIME literals are nanoseconds',
        ref: 'T10 fn. m',
        vars: ['a : LTIME', 'b : LTIME'],
        code: 'a := LT#1ms;\nb := LTIME#1s2ns;',
        expect: { a: 1000000, b: 1000000002 },
    },

    // ── comments ────────────────────────────────────────────────────────────
    {
        name: 'comments of every kind, nested and inline',
        ref: 'T3',
        vars: ['a : INT', 'b : INT', 'c : INT', 'd : INT'],
        code: [
            '(* block comment *) a := 1; (* trailing *)',
            '// line comment with (* and /* inside',
            'b := 2; // b := 99;',
            '/* C-style',
            '   b := 99; */',
            '(* nested (* inner *) still comment; c := 99; *)',
            'c := 3 (* inside an expression *) + 1;',
            '/* d := 99; */ d := 4;',
        ].join('\n'),
        expect: { a: 1, b: 2, c: 4, d: 4 },
    },
    {
        name: 'nested /* */ comments',
        ref: 'T3 3b',
        todo: 'known issue (docs/CLAUDE.md): stripIecComments nests (* *) but not /* */',
        vars: ['d : INT'],
        code: '/* nested /* inner */ d := 99; */ d := 4;',
        expect: { d: 4 },
    },
    {
        name: 'a keyword inside a comment does not split the statement',
        ref: 'src/services/CLAUDE.md stripIecComments',
        vars: ['a : INT', 'b : INT'],
        code: 'a := 1; (* IF THEN ELSE END_IF *) b := 2; // END_FOR; WHILE',
        expect: { a: 1, b: 2 },
    },

    // ── strings ─────────────────────────────────────────────────────────────
    {
        name: 'string literal containing comment and keyword text',
        ref: 'T6, stripIecComments',
        vars: ['s1 : STRING', 's2 : STRING', 's3 : STRING', 'n : INT'],
        code: "s1 := 'http://x/y';\ns2 := '(* not a comment *)';\ns3 := 'go THEN stop; END_IF';\nn := 7;",
        expect: { s1: 'http://x/y', s2: '(* not a comment *)', s3: 'go THEN stop; END_IF', n: 7 },
    },
    {
        name: 'string $ escapes',
        ref: 'T7',
        vars: ['a : STRING', 'b : STRING', 'c : STRING', 'd : STRING', 'e : STRING'],
        code: "a := 'it$'s';\nb := 'cost $$5';\nc := 'x$Ly';\nd := 'tab$Tend';\ne := '$41$42';",
        expect: { a: "it's", b: 'cost $5', c: 'x\ny', d: 'tab\tend', e: 'AB' },
    },
    {
        name: 'empty string and plain double quote inside single quotes',
        ref: 'T6 1a/1e',
        vars: ['a : STRING := \'xyz\'', 'b : STRING'],
        code: "a := '';\nb := 'say \"hi\"';",
        expect: { a: '', b: 'say "hi"' },
    },
    {
        name: 'a numeric literal next to a string literal is not corrupted',
        ref: 'src/services/CLAUDE.md placeholders',
        vars: ['s : STRING', 'n : DINT'],
        code: "s := 'A'; n := 10203;",
        expect: { s: 'A', n: 10203 },
    },

    // ── identifiers / keywords ──────────────────────────────────────────────
    {
        name: 'identifiers and keywords are case-insensitive',
        ref: 'T1 fn. a',
        vars: ['Counter : INT', 'Flag : BOOL := TRUE'],
        code: 'if flag then COUNTER := counter + 1; EnD_iF;\nCoUnTeR := cOuNtEr + 10;',
        expect: { Counter: 11 },
    },
    {
        name: 'a C keyword is a legal IEC name',
        ref: 'src/services/CLAUDE.md cIdent',
        vars: ['signed : INT', 'double : INT', 'volatile : INT', 'register : INT'],
        code: 'signed := 3;\ndouble := signed * 2;\nvolatile := double + 1;\nregister := volatile;',
        expect: { signed: 3, double: 6, volatile: 7, register: 7 },
    },

    // ── layout ──────────────────────────────────────────────────────────────
    {
        name: 'several statements on one line',
        ref: '§7.3.2 end of line = space',
        vars: ['a : INT', 'b : INT', 'c : INT'],
        code: 'a := 1; b := a + 1; c := b + 1;',
        expect: { a: 1, b: 2, c: 3 },
    },
    {
        name: 'statement continued with a trailing operator',
        vars: ['a : INT := 3', 'b : INT := 4', 'r : INT'],
        code: 'r := a *\n     b +\n     1;',
        expect: { r: 13 },
    },
    {
        name: 'statement continued with a leading operator',
        ref: 'src/services/CLAUDE.md continuation merge',
        vars: ['a : DINT := 2', 'b : DINT := 8', 'r : DINT', 'x : BOOL := TRUE', 'y : BOOL := FALSE', 'q : BOOL'],
        code: 'r := a * 128\n   + b / 2;\nq := x\n   AND NOT y;',
        expect: { r: 260, q: true },
    },
    {
        name: 'call arguments spread over lines',
        vars: ['r : INT'],
        code: 'r := LIMIT(\n  MN := 0,\n  IN := 50,\n  MX := 10);',
        expect: { r: 10 },
    },
    {
        name: 'closing parenthesis on its own line',
        ref: '§7.3.2 end of line = space',
        todo: 'known issue (docs/CLAUDE.md): a line starting with ")" is not merged backward',
        vars: ['r : INT', 'q : INT'],
        code: 'r := LIMIT(\n  MN := 0,\n  IN := 50,\n  MX := 10\n);\nq := (1 +\n  2\n);',
        expect: { r: 10, q: 3 },
    },
    {
        name: 'IF condition spread over lines',
        vars: ['a : INT := 5', 'r : INT'],
        code: 'IF a > 1\n   AND a < 10 THEN\n  r := 1;\nEND_IF;',
        expect: { r: 1 },
    },
    {
        name: 'THEN / DO on the line after the condition',
        ref: '§7.3.2 end of line = space',
        todo: 'known issue (docs/CLAUDE.md): IF/ELSIF/WHILE/FOR headers must end on the THEN/DO line',
        vars: ['a : INT := 5', 'r : INT', 'w : INT', 'i : INT', 'f : INT'],
        code: 'IF a > 1\n   AND a < 10\nTHEN\n  r := 1;\nEND_IF;\n' +
            'WHILE w < 3\nDO w := w + 1; END_WHILE;\n' +
            'FOR i := 1 TO 3\nDO f := f + 1; END_FOR;',
        expect: { r: 1, w: 3, f: 3 },
    },
    {
        name: 'empty statements',
        ref: 'T72 11',
        vars: ['a : INT'],
        code: ';;\na := 1;;\n;',
        expect: { a: 1 },
    },
    {
        name: 'missing ; after END_IF is accepted',
        ref: '§16.4 Kron extension',
        vars: ['a : INT'],
        code: 'IF TRUE THEN a := 1; END_IF\na := a + 1;',
        expect: { a: 2 },
    },
    {
        name: 'tabs and CRLF line endings',
        vars: ['a : INT', 'b : INT'],
        code: 'a\t:=\t1;\r\nIF a = 1 THEN\r\n\tb := 2;\r\nEND_IF;\r\n',
        expect: { a: 1, b: 2 },
    },
];
