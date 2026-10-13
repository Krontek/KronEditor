// ── IEC 61131-3 Structured Text EXPRESSIONS: tokenizer, parser, typer, C emitter ──
//
// The statement structure of an ST POU (IF/CASE/FOR/WHILE/REPEAT, assignment
// splitting, FB call statements) stays line-based in CTranspilerService.js.
// Every EXPRESSION it emits — conditions, right-hand sides, call arguments,
// CASE selectors, FOR bounds, array indices, assignment targets — comes from
// here. This replaced a stack of regex rewrites (rewriteOperators,
// rewriteUserFunctionCalls, expandSTSelectionCalls, the STRING-compare regex,
// the `=`→`==` pass, …) that could not see types or precedence:
//   • AND/OR on integers stayed LOGICAL whenever an operand was not a plain
//     known variable (`(a + 1) AND 16#FF` was `&&`);
//   • SHL/SHR went through the archive's uint32 SHL()/SHR() and a count >= the
//     width was undefined behaviour;
//   • `F(a) = F(b)` on a STRING FUNCTION compared one shared buffer with itself;
//   • mixed signed/unsigned comparisons followed C's conversions
//     (`udint_var > -1` was FALSE).
//
// Pipeline: tokenize → Pratt parse (AST) → one typing+emitting walk. The
// walk returns `{ c, t }` per node: `c` is fully parenthesised C, `t` the IEC
// type ('BOOL', 'INT', …, 'STRING', a UDT/FB name), or one of
//   '#INT'  — an untyped integer literal (`.lit` holds its BigInt value); it
//             adopts the type of the other operand when the value fits;
//   '#REAL' — an untyped real literal;
//   null    — UNKNOWN (an AXIS_REF member, a HAL pin no table describes):
//             emitted with plain C semantics, as the regex path always did.
// Identifiers resolve case-insensitively to the declared spelling; an unknown
// identifier, an unknown function and a type error are thrown as
// STExprError, which the caller decorates with the POU / line / statement.
//
// ⚠️ This module owns no transpiler tables: everything it needs (variable
// maps, FB pin types, the KRON_ conversion names, mapIECtoTimeUs, …) arrives
// through `env`, so CTranspilerService stays the single source of truth for
// them and there is no import cycle.

export class STExprError extends Error {}
const fail = (msg) => { throw new STExprError(msg); };

// ── Type classification ─────────────────────────────────────────────────────
const INT_INFO = {
    SINT: [8, true], INT: [16, true], DINT: [32, true], LINT: [64, true],
    USINT: [8, false], UINT: [16, false], UDINT: [32, false], ULINT: [64, false],
    BYTE: [8, false], WORD: [16, false], DWORD: [32, false], LWORD: [64, false],
};
const SIGNED_OF_WIDTH = { 8: 'SINT', 16: 'INT', 32: 'DINT', 64: 'LINT' };
const UNSIGNED_C = { 8: 'uint8_t', 16: 'uint16_t', 32: 'uint32_t', 64: 'uint64_t' };
const ELEMENTARY_C = {
    BOOL: 'bool', SINT: 'int8_t', INT: 'int16_t', DINT: 'int32_t', LINT: 'int64_t',
    USINT: 'uint8_t', UINT: 'uint16_t', UDINT: 'uint32_t', ULINT: 'uint64_t',
    BYTE: 'uint8_t', WORD: 'uint16_t', DWORD: 'uint32_t', LWORD: 'uint64_t',
    REAL: 'float', LREAL: 'double', TIME: 'int64_t', LTIME: 'int64_t',
};
const isIntT = (t) => t === '#INT' || Object.prototype.hasOwnProperty.call(INT_INFO, t);
const isRealT = (t) => t === 'REAL' || t === 'LREAL' || t === '#REAL';
const isTimeT = (t) => t === 'TIME' || t === 'LTIME';
const isStrT = (t) => t === 'STRING' || t === 'WSTRING';
const isBoolT = (t) => t === 'BOOL';
const isNumT = (t) => isIntT(t) || isRealT(t) || isTimeT(t);
const widthOf = (t) => (INT_INFO[t] ? INT_INFO[t][0] : isTimeT(t) ? 64 : 0);
const signedT = (t) => (INT_INFO[t] ? INT_INFO[t][1] : isTimeT(t));
const showT = (t) => (t === '#INT' ? 'integer literal' : t === '#REAL' ? 'real literal' : t === null ? 'unknown type' : t);

const I64_MIN = -(2n ** 63n), I64_MAX = 2n ** 63n - 1n, U64_MAX = 2n ** 64n - 1n;
const rangeOf = (t) => {
    const [w, s] = INT_INFO[t];
    return s ? [-(2n ** BigInt(w - 1)), 2n ** BigInt(w - 1) - 1n] : [0n, 2n ** BigInt(w) - 1n];
};
const litFits = (v, t) => {
    if (isTimeT(t)) return v >= I64_MIN && v <= I64_MAX;
    if (!INT_INFO[t]) return false;
    const [lo, hi] = rangeOf(t);
    return v >= lo && v <= hi;
};
// The smallest of DINT / LINT / ULINT holding a literal on its own.
const literalNaturalType = (v) => (v >= -(2n ** 31n) && v < 2n ** 31n ? 'DINT' : v >= I64_MIN && v <= I64_MAX ? 'LINT' : 'ULINT');

// Common type of two integer types: same signedness → the wider; mixed → a
// signed type wide enough for BOTH ranges (UDINT + DINT → LINT). ULINT/LWORD
// with a signed type has no such type; LINT is used (the IEC answer is a
// compile error — this keeps C's behaviour for values below 2^63).
const commonInt = (a, b) => {
    const [wa, sa] = INT_INFO[a], [wb, sb] = INT_INFO[b];
    if (sa === sb) return wa >= wb ? a : b;
    const [ws, wu] = sa ? [wa, wb] : [wb, wa];
    if (ws > wu) return sa ? a : b;
    return SIGNED_OF_WIDTH[Math.min(64, wu * 2)];
};

// ── Tokenizer ───────────────────────────────────────────────────────────────
const KEYWORD_OPS = new Set(['AND', 'OR', 'XOR', 'NOT', 'MOD', 'BAND', 'BOR', 'BXOR', 'BNOT']);
const STATEMENT_KEYWORDS = new Set(['IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'OF', 'END_CASE',
    'FOR', 'TO', 'BY', 'DO', 'END_FOR', 'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT',
    'RETURN', 'EXIT', 'CONTINUE', 'VAR', 'END_VAR']);
const TYPED_LITERAL_TYPES = new Set(['BOOL', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT',
    'BYTE', 'WORD', 'DWORD', 'LWORD', 'REAL', 'LREAL']);
const TIME_PREFIXES = new Set(['T', 'TIME', 'LT', 'LTIME']);
const NUM_RE = /(?:(2|8|10|16)#([0-9A-Fa-f_]+)|(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?)/y;
const PUNCT = ['**', '<=', '>=', '<>', ':=', '=>', '*', '/', '+', '-', '<', '>', '=', '&', '(', ')', '[', ']', ',', '.'];

// A numeric literal text (no sign) → { real, c, v }.
const numberToken = (m, H) => {
    if (m[1]) {
        const c = H.iecNumberToC(`${m[1]}#${m[2]}`);
        if (c === null) fail(`malformed number "${m[0]}"`);
        const digits = m[2].replace(/_/g, '');
        const prefix = { 2: '0b', 8: '0o', 10: '', 16: '0x' }[m[1]];
        return { real: false, c, v: BigInt(prefix + digits) };
    }
    const real = !!(m[4] || m[5]);
    const c = H.iecNumberToC(m[0]);
    if (c === null) fail(`malformed number "${m[0]}"`);
    return { real, c, v: real ? null : BigInt(m[3].replace(/_/g, '')) };
};

export const tokenizeST = (text, env) => {
    const H = env.H;
    const s = String(text);
    const toks = [];
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (/\s/.test(ch)) { i++; continue; }
        const pos = i;
        // String literal placeholder from stripIecComments({strTable}).
        if (ch === '\x0e') {
            const m = /^\x0e(\d+)\x0f/.exec(s.slice(i)); // eslint-disable-line no-control-regex
            if (!m) fail('corrupt string placeholder');
            const raw = (env.strTable || [])[+m[1]];
            if (raw === undefined) fail('corrupt string placeholder');
            toks.push({ k: 'str', raw, pos });
            i += m[0].length;
            continue;
        }
        if (ch === "'" || ch === '"') {
            let j = i + 1;
            while (j < s.length && s[j] !== ch) j += s[j] === '$' ? 2 : 1;
            if (j >= s.length) fail('unterminated string literal');
            toks.push({ k: 'str', raw: s.slice(i, j + 1), pos });
            i = j + 1;
            continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            const m = /[A-Za-z_][A-Za-z0-9_]*/y; m.lastIndex = i;
            const word = m.exec(s)[0];
            const up = word.toUpperCase();
            i += word.length;
            if (s[i] === '#') {
                if (TIME_PREFIXES.has(up)) {
                    const tm = /[-+]?(?:[\d._]+(?:MS|US|NS|D|H|M|S))+(?![A-Za-z0-9_])/iy;
                    tm.lastIndex = i + 1;
                    const mm = tm.exec(s);
                    if (!mm) fail(`malformed time literal "${s.slice(pos, pos + 24).split(/[\s,;)]/)[0]}"`);
                    const lit = s.slice(pos, i + 1 + mm[0].length);
                    toks.push({ k: 'time', us: BigInt(H.mapIECtoTimeUs(lit)), type: up.startsWith('L') ? 'LTIME' : 'TIME', raw: lit, pos });
                    i += 1 + mm[0].length;
                    continue;
                }
                if (TYPED_LITERAL_TYPES.has(up)) {
                    let j = i + 1;
                    let sign = '';
                    if (s[j] === '-' || s[j] === '+') { sign = s[j]; j++; }
                    const bm = /TRUE|FALSE/iy; bm.lastIndex = j;
                    const b = bm.exec(s);
                    if (b && !/[A-Za-z0-9_]/.test(s[j + b[0].length] || '')) {
                        if (sign) fail(`malformed typed literal "${s.slice(pos, j + b[0].length)}"`);
                        toks.push({ k: 'typed', type: up, bool: b[0].toUpperCase() === 'TRUE', pos });
                        i = j + b[0].length;
                        continue;
                    }
                    NUM_RE.lastIndex = j;
                    const nm = NUM_RE.exec(s);
                    if (!nm || nm.index !== j) fail(`malformed typed literal "${s.slice(pos, j + 8)}"`);
                    const n = numberToken(nm, H);
                    toks.push({ k: 'typed', type: up, sign, num: n, pos, raw: s.slice(pos, j + nm[0].length) });
                    i = j + nm[0].length;
                    continue;
                }
                if (/^(?:D|DATE|TOD|TIME_OF_DAY|DT|DATE_AND_TIME|LDATE|LTOD|LDT)$/.test(up)) {
                    fail(`${up}# literals are not supported`);
                }
                // Enumerated literal: Type#Member.
                const em = /[A-Za-z_][A-Za-z0-9_]*/y; em.lastIndex = i + 1;
                const mem = em.exec(s);
                if (!mem) fail(`malformed literal "${word}#"`);
                toks.push({ k: 'enumlit', type: word, member: mem[0], pos });
                i += 1 + mem[0].length;
                continue;
            }
            if (KEYWORD_OPS.has(up)) { toks.push({ k: 'op', v: up, pos }); continue; }
            if (up === 'TRUE' || up === 'FALSE') { toks.push({ k: 'bool', v: up === 'TRUE', pos }); continue; }
            if (STATEMENT_KEYWORDS.has(up)) fail(`unexpected keyword ${up} inside an expression`);
            toks.push({ k: 'id', v: word, pos });
            continue;
        }
        if (/\d/.test(ch)) {
            // After `.` this is a bit index (x.3), never a REAL fraction.
            const prev = toks[toks.length - 1];
            if (prev && prev.k === 'op' && prev.v === '.') {
                const dm = /\d+/y; dm.lastIndex = i;
                const d = dm.exec(s)[0];
                toks.push({ k: 'num', real: false, c: d, v: BigInt(d), pos });
                i += d.length;
                continue;
            }
            NUM_RE.lastIndex = i;
            const nm = NUM_RE.exec(s);
            const n = numberToken(nm, H);
            if (/[A-Za-z_]/.test(s[i + nm[0].length] || '')) fail(`malformed number "${s.slice(i, i + nm[0].length + 1)}…"`);
            toks.push({ k: 'num', ...n, pos });
            i += nm[0].length;
            continue;
        }
        const p = PUNCT.find(op => s.startsWith(op, i));
        if (!p) fail(`unexpected character "${ch}"`);
        toks.push({ k: 'op', v: p, pos });
        i += p.length;
    }
    toks.push({ k: 'eof', pos: s.length });
    return toks;
};

// ── Pratt parser ────────────────────────────────────────────────────────────
// IEC 61131-3 (3rd ed., table "Operators of the ST language"), highest first:
//   ( ) and function calls · ** · unary - + NOT · * / MOD · + - ·
//   < > <= >= · = <> · AND & · XOR · OR
// ⚠️ `**` is LEFT-associative here (`2**3**2` = 64): the standard gives no
// right-associativity rule and says operators of equal precedence apply left
// to right; CODESYS does the same, and so did the regex path this replaces.
// `**` binds tighter than unary minus, so `-2**2` is -(2**2) = -4. A unary
// operand is accepted on the RIGHT of `**` (`2 ** -1`) for convenience.
// Comparisons are NON-associative: `a < b < c` is an error, not (a<b)<c.
// The vendor operators BAND/BOR/BXOR/BNOT sit at the AND/OR/XOR/NOT levels
// and are always bitwise.
const BINARY_BP = {
    OR: 10, BOR: 10, XOR: 20, BXOR: 20, AND: 30, '&': 30, BAND: 30,
    '=': 40, '<>': 40, '<': 50, '>': 50, '<=': 50, '>=': 50,
    '+': 60, '-': 60, '*': 70, '/': 70, MOD: 70, '**': 90,
};
const NON_ASSOC = new Set([40, 50]);
const UNARY_BP = 80;

export const parseST = (toks) => {
    let p = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    const isOp = (v) => toks[p].k === 'op' && toks[p].v === v;
    const expectOp = (v) => {
        if (!isOp(v)) fail(`expected "${v}"${describe(peek())}`);
        return next();
    };
    const describe = (t) => (t.k === 'eof' ? ' at end of expression' : ` near ${t.k === 'op' ? `"${t.v}"` : t.k === 'id' ? `"${t.v}"` : t.k}`);

    const parseArgs = () => {
        const args = [];
        if (isOp(')')) { next(); return args; }
        for (;;) {
            if (peek().k === 'id' && toks[p + 1].k === 'op' && (toks[p + 1].v === ':=' || toks[p + 1].v === '=>')) {
                const name = next().v;
                const op = next().v;
                args.push({ name, op, e: parseExpr(0) });
            } else {
                args.push({ name: null, e: parseExpr(0) });
            }
            if (isOp(',')) { next(); continue; }
            expectOp(')');
            return args;
        }
    };

    const parsePostfix = (node) => {
        for (;;) {
            if (isOp('.')) {
                next();
                const t = next();
                if (t.k === 'id') node = { k: 'member', obj: node, name: t.v, pos: t.pos };
                else if (t.k === 'num' && !t.real) node = { k: 'bit', obj: node, bit: Number(t.v), pos: t.pos };
                else fail(`expected a member name after "."${describe(t)}`);
            } else if (isOp('[')) {
                const open = next();
                const idx = [parseExpr(0)];
                while (isOp(',')) { next(); idx.push(parseExpr(0)); }
                expectOp(']');
                node = { k: 'index', obj: node, idx, pos: open.pos };
            } else if (isOp('(')) {
                if (node.k !== 'id') fail('only a function name can be called');
                next();
                node = { k: 'call', name: node.v, args: parseArgs(), pos: node.pos };
            } else {
                return node;
            }
        }
    };

    const parsePrimary = () => {
        const t = next();
        switch (t.k) {
            case 'num': return { k: 'num', real: t.real, c: t.c, v: t.v, pos: t.pos };
            case 'str': return { k: 'str', raw: t.raw, pos: t.pos };
            case 'time': return { k: 'time', us: t.us, type: t.type, pos: t.pos };
            case 'typed': return { k: 'typed', tok: t, pos: t.pos };
            case 'bool': return { k: 'bool', v: t.v, pos: t.pos };
            case 'enumlit': return parsePostfix({ k: 'enumlit', type: t.type, member: t.member, pos: t.pos });
            case 'id': return parsePostfix({ k: 'id', v: t.v, pos: t.pos });
            case 'op':
                if (t.v === '(') {
                    const e = parseExpr(0);
                    expectOp(')');
                    return parsePostfix({ k: 'paren', e, pos: t.pos });
                }
                if (t.v === '-' || t.v === '+' || t.v === 'NOT' || t.v === 'BNOT') {
                    const e = parseExpr(UNARY_BP);
                    // Fold a negated literal so `-1` stays the literal -1.
                    if (t.v === '-' && e.k === 'num') return { ...e, v: e.v === null ? null : -e.v, neg: !e.neg, pos: t.pos };
                    if (t.v === '+' ) return e;
                    return { k: 'un', op: t.v, e, pos: t.pos };
                }
                fail(`unexpected "${t.v}"`);
                break;
            default:
                fail(`expression expected${describe(t)}`);
        }
        return null;
    };

    const parseExpr = (minBp) => {
        let left = parsePrimary();
        let lastNonAssoc = -1;
        for (;;) {
            const t = peek();
            if (t.k !== 'op') break;
            const bp = BINARY_BP[t.v];
            if (bp === undefined || bp <= minBp) break;
            if (NON_ASSOC.has(bp) && lastNonAssoc === bp) {
                fail(`comparison operators do not chain ("… ${t.v} …"); combine them with AND`);
            }
            next();
            // `**` is left-associative: its right operand binds at its own
            // level, but a unary sign is accepted there (`2 ** -1`).
            const right = t.v === '**' && peek().k === 'op' && (peek().v === '-' || peek().v === '+')
                ? parsePrimary()
                : parseExpr(bp);
            left = { k: 'bin', op: t.v, l: left, r: right, pos: t.pos };
            lastNonAssoc = NON_ASSOC.has(bp) ? bp : -1;
        }
        return left;
    };

    const root = parseExpr(0);
    if (peek().k !== 'eof') {
        const t = peek();
        if (t.k === 'op' && t.v === ':=') fail('":=" is an assignment, not an expression (use "=" to compare)');
        fail(`unexpected ${t.k === 'op' ? `"${t.v}"` : t.k === 'id' ? `"${t.v}"` : t.k} after a complete expression`);
    }
    return root;
};

// ── Typing + C emission ─────────────────────────────────────────────────────
// env (built by transpileSTLogics):
//   H              — transpiler helpers: iecNumberToC, mapIECtoTimeUs,
//                    iecStringDecode, cEscapeString, cIdent, mapType,
//                    rotateExpr, IEC_KRON_NAME, strConvSymbol, STRING_SHM_BYTES
//   strTable       — string placeholders of the POU
//   lookupVar(n)   — { c, t } of a declared name (any case) or null
//   enumMember(n)  — { name, type } of an enumerated value or null
//   enumTypes      — Map lower → declared name of each enumerated type
//   memberCtx      — { types, arrays } (buildMemberCtx)
//   stdMember(t,m) — { c, t, ptrStr } of a standard block pin, or null when t
//                    is not a standard block
//   isFbTypeName(n), isFbInstance(n)
//   userFunctions  — Map lower → { name, params:[{name,type,inout}], ret }
//   strConv        — { progName, next } (x_TO_STRING buffers) or null
//   seq            — { next } temp counter, shared per POU
//   decls          — array collecting function-scope declarations
//   fnResult       — { name, type, isString } inside a FUNCTION
export const createSTExprCompiler = (env) => {
    const H = env.H;
    const cTypeOf = (t) => {
        if (ELEMENTARY_C[t]) return ELEMENTARY_C[t];
        if (t === '#INT') return 'int64_t';
        if (t === '#REAL') return 'double';
        return null;
    };
    const tmp = () => `__t${env.seq.next++}`;
    // A declared type → the spelling the typer works with. A type nobody
    // describes (a vendor PDO type, a header struct) is UNKNOWN (null) rather
    // than a name that fails every numeric check — except that the name is
    // kept for member access when a standard block or UDT knows it.
    const canonT = (t) => {
        if (t === null || t === undefined) return null;
        const raw = String(t).trim();
        if (!raw) return null;
        const up = raw.toUpperCase();
        if (ELEMENTARY_C[up] || up === 'STRING' || up === 'WSTRING' || up === 'POINTER') return up;
        const l = raw.toLowerCase();
        if (env.memberCtx?.types?.has(l) || env.memberCtx?.arrays?.has(l) || env.enumTypes.has(l)) return raw;
        if (/^ARRAY\s*\[/i.test(raw)) return raw;
        if (env.stdMember(raw, '__probe__') !== null) return raw;
        return null;
    };

    // Literal R → its value adapted to `t` (no cast is needed for a literal
    // that fits); everything else → cast to `t` unless it already is one.
    const castTo = (r, t) => {
        if (t === null || r.t === null || r.t === t) return r.c;
        if (r.t === '#INT' && (litFits(r.lit, t) || isRealT(t))) return r.c;
        if (r.t === '#REAL' && isRealT(t)) return r.c;
        const ct = cTypeOf(t);
        return ct ? `((${ct})${r.c})` : r.c;
    };
    // A literal compared / combined with a typed operand takes that type when
    // its value fits (IEC: an untyped literal is typed by its context).
    const effType = (r, other) => {
        if (r.t === '#INT') {
            if (other && (isIntT(other.t) && other.t !== '#INT' || isTimeT(other.t)) && litFits(r.lit, other.t)) return other.t;
            if (other && isRealT(other.t)) return other.t === '#REAL' ? 'LREAL' : other.t;
            return literalNaturalType(r.lit);
        }
        if (r.t === '#REAL') {
            if (other && (other.t === 'REAL' || other.t === 'LREAL')) return other.t;
            return 'LREAL';
        }
        return r.t;
    };
    // Common numeric type of two operands (null when either is unknown).
    const commonNum = (a, b) => {
        if (a.t === null || b.t === null) return null;
        if (a.t === '#INT' && b.t === '#INT') return '#INT';
        if (a.t === '#REAL' && b.t === '#REAL') return '#REAL';
        const ta = effType(a, b), tb = effType(b, a);
        if (isRealT(ta) || isRealT(tb)) {
            if (isTimeT(ta) || isTimeT(tb)) return isTimeT(ta) ? ta : tb;
            return (ta === 'LREAL' || tb === 'LREAL' || widthOf(ta) === 64 || widthOf(tb) === 64) ? 'LREAL' : 'REAL';
        }
        if (isTimeT(ta) || isTimeT(tb)) return (ta === 'LTIME' || tb === 'LTIME') ? 'LTIME' : 'TIME';
        if (INT_INFO[ta] && INT_INFO[tb]) return commonInt(ta, tb);
        return ta === tb ? ta : null;
    };
    // C performs the WRONG conversion only when signed meets unsigned at or
    // above int rank (and when a negative literal meets an unsigned 32/64-bit
    // operand). Those pairs get explicit casts to the common type; same-sign
    // widenings and int→real are value-preserving in C already.
    const needsSignCast = (a, b, ct) => {
        const ta = effType(a, b), tb = effType(b, a);
        const ints = [ta, tb].every(t => INT_INFO[t] || isTimeT(t));
        if (!ints || ct === null) return false;
        if (signedT(ta) === signedT(tb)) return false;
        return Math.max(widthOf(ta), widthOf(tb)) >= 32;
    };

    const isPureR = (r) => r.pure !== false;
    const intLit = (v, c) => ({ c, t: '#INT', lit: v, pure: true });

    // ── names ──
    const resolveId = (node) => {
        const name = node.v;
        const v = env.lookupVar(name);
        if (v) return { c: v.c, t: canonT(v.t), lval: true, pure: true, ptrStr: false };
        const em = env.enumMember(name);
        if (em) return { c: em.name, t: canonT(em.type), pure: true };
        if (/^NULL$/i.test(name)) return { c: 'NULL', t: 'POINTER', pure: true };
        if (env.userFunctions.has(name.toLowerCase())) fail(`FUNCTION ${name} must be called with parentheses`);
        fail(`unknown identifier "${name}"`);
        return null;
    };

    const arrayInfo = (t) => {
        if (!t) return null;
        const a = env.memberCtx?.arrays?.get(String(t).trim().toLowerCase());
        if (a) return { base: a.baseType, dims: a.dims };
        const m = /^ARRAY\s*\[([^\]]*)\]\s*OF\s+(.+)$/i.exec(String(t).trim());
        if (m) return { base: m[2].trim(), dims: m[1].split(',').length };
        return null;
    };

    const memberAccess = (node) => {
        const base = emitNode(node.obj);
        if (base.pendingDims) fail(`"${node.name}": the array needs ${base.pendingDims} more index(es) first`);
        const t = base.t;
        if (t === null) return { c: `${base.c}.${node.name}`, t: null, lval: base.lval, pure: base.pure };
        const info = env.memberCtx?.types?.get(String(t).trim().toLowerCase());
        if (info) {
            const mem = info.members.get(String(node.name).toLowerCase());
            if (!mem) fail(`${info.name} has no member "${node.name}"`);
            return { c: `${base.c}.${H.cIdent(mem.name)}`, t: canonT(mem.type), lval: base.lval, pure: base.pure };
        }
        const sm = env.stdMember(t, node.name);
        if (sm) return { c: `${base.c}.${sm.c}`, t: canonT(sm.t), ptrStr: !!sm.ptrStr, lval: base.lval, pure: base.pure };
        if (ELEMENTARY_C[t] || isStrT(t)) fail(`"${node.name}" is not a member: ${t} has no members`);
        // A type no table describes (AXIS_REF, a header struct): C names it.
        return { c: `${base.c}.${node.name}`, t: null, lval: base.lval, pure: base.pure };
    };

    const bitAccess = (node) => {
        const base = emitNode(node.obj);
        const w = widthOf(base.t);
        if (base.t !== null && !INT_INFO[base.t]) fail(`bit access ".${node.bit}" needs an integer/bit-string operand, got ${showT(base.t)}`);
        if (w && node.bit >= w) fail(`bit ${node.bit} is out of range for ${base.t} (${w} bits)`);
        const one = (w === 64) ? '1ULL' : '1u';
        return { c: `((bool)((${base.c} >> ${node.bit}) & ${one}))`, t: 'BOOL', pure: base.pure, bitOf: base, bit: node.bit };
    };

    const indexAccess = (node) => {
        const base = emitNode(node.obj);
        let dims = base.pendingDims || 0, elem = base.pendingElem;
        if (!dims) {
            if (base.t === null) {
                const idx = node.idx.map(e => emitNode(e).c);
                return { c: `${base.c}${idx.map(i => `[${i}]`).join('')}`, t: null, lval: base.lval, pure: base.pure };
            }
            const ai = arrayInfo(base.t);
            if (!ai) fail(`${showT(base.t)} is not an ARRAY, it cannot be indexed`);
            dims = ai.dims; elem = ai.base;
        }
        if (node.idx.length > dims) fail(`too many indexes: ${node.idx.length} given, ${dims} left`);
        const parts = node.idx.map(e => {
            const r = emitNode(e);
            if (r.t !== null && !isIntT(r.t) && !env.enumTypes.has(String(r.t).toLowerCase())) fail(`array index must be an integer, got ${showT(r.t)}`);
            return r;
        });
        const left = dims - node.idx.length;
        const pure = base.pure && parts.every(isPureR);
        const c = `${base.c}${parts.map(r => `[${r.c}]`).join('')}`;
        if (left) return { c, t: '#ARRAYPART', pendingDims: left, pendingElem: elem, lval: base.lval, pure };
        return { c, t: canonT(elem), lval: base.lval, pure };
    };

    // ── literals ──
    // C text of an integer literal of value v written as `c` (no sign):
    // a decimal above INT64_MAX needs ULL, and INT64_MIN has no literal.
    const intLitC = (v, c, neg) => {
        if (v > U64_MAX || v < I64_MIN) fail(`integer literal ${neg ? '-' : ''}${c} is out of range`);
        if (v > I64_MAX && !/^0[xbo]/i.test(c)) c += 'ULL';
        if (neg) c = v === I64_MIN ? '(-9223372036854775807LL - 1)' : `-${c}`;
        return c;
    };
    const emitNum = (n) => {
        if (n.real) return { c: n.neg ? `-${n.c}` : n.c, t: '#REAL', pure: true };
        return intLit(n.v, intLitC(n.v, n.c, !!n.neg));
    };
    const emitTyped = (tok) => {
        const T = tok.type, ct = ELEMENTARY_C[T];
        if (tok.bool !== undefined) {
            if (T !== 'BOOL') fail(`${T}#${tok.bool ? 'TRUE' : 'FALSE'} is not a valid literal`);
            return { c: `((bool)(${tok.bool}))`, t: 'BOOL', pure: true };
        }
        const n = tok.num;
        if (T === 'BOOL') {
            if (n.real || (n.v !== 0n && n.v !== 1n) || tok.sign) fail(`BOOL#${n.c} is not a valid literal`);
            return { c: `((bool)(${n.c}))`, t: 'BOOL', pure: true };
        }
        if (INT_INFO[T]) {
            if (n.real) fail(`${tok.raw}: a ${T} literal must be an integer`);
            const v = tok.sign === '-' ? -n.v : n.v;
            if (!litFits(v, T)) fail(`${tok.raw} does not fit in ${T}`);
            return { c: `((${ct})(${intLitC(v, n.c, tok.sign === '-')}))`, t: T, pure: true, lit: v };
        }
        return { c: `((${ct})(${tok.sign === '-' ? '-' : ''}${n.c}))`, t: T, pure: true };
    };
    const emitStr = (raw) => {
        const body = raw.slice(1, -1);
        return { c: '"' + H.cEscapeString(H.iecStringDecode(body)) + '"', t: 'STRING', pure: true, strLit: true };
    };

    // ── operators ──
    const requireBoolish = (r, op) => {
        if (r.t === null || isBoolT(r.t)) return;
        if (r.t === '#INT' && (r.lit === 0n || r.lit === 1n)) return;
        fail(`${op} needs BOOL operands here, got ${showT(r.t)}`);
    };
    const boolC = (r) => (r.t === '#INT' ? (r.lit ? 'true' : 'false') : r.c);

    const emitUnary = (node) => {
        const r = emitNode(node.e);
        if (node.op === '-') {
            if (r.t !== null && !isNumT(r.t)) fail(`unary "-" needs a number, got ${showT(r.t)}`);
            const res = { c: r.c.startsWith('-') ? `(- ${r.c})` : `(-${r.c})`, t: r.t, pure: r.pure };
            if (r.t === '#INT') res.lit = -r.lit;
            return res;
        }
        // NOT / BNOT
        if (r.t === null) return { c: `KRON_NOT_U(${r.c})`, t: null, pure: r.pure };
        if (isBoolT(r.t)) return { c: `(!${r.c})`, t: 'BOOL', pure: r.pure };
        if (isIntT(r.t)) {
            // ⚠️ Masked to the operand's width: C's `~` works on the PROMOTED
            // int, so `NOT BYTE#1` would be -2 (0xFFFFFFFE), not 254.
            const T = r.t === '#INT' ? 'DWORD' : r.t;
            return { c: `((${ELEMENTARY_C[T]})~${castTo(r, T)})`, t: T, pure: r.pure };
        }
        fail(`${node.op} needs a BOOL or an integer/bit-string operand, got ${showT(r.t)}`);
        return null;
    };

    const LOGIC = { AND: ['&&', '&'], '&': ['&&', '&'], OR: ['||', '|'], XOR: ['!=', '^'] };
    const BITWISE = { BAND: '&', BOR: '|', BXOR: '^' };

    const emitBinary = (node) => {
        const op = node.op;
        const a = emitNode(node.l), b = emitNode(node.r);
        const pure = a.pure !== false && b.pure !== false;
        [a, b].forEach(r => { if (r.pendingDims) fail('an array needs all its indexes before it can be used as a value'); });

        if (LOGIC[op] || BITWISE[op]) {
            const opName = op === '&' ? 'AND' : op;
            const boolA = isBoolT(a.t), boolB = isBoolT(b.t);
            const intA = isIntT(a.t), intB = isIntT(b.t);
            if (!BITWISE[op] && (boolA || boolB) && !(intA && a.t !== '#INT') && !(intB && b.t !== '#INT')) {
                // Logical on BOOL. A 0/1 literal is accepted as a BOOL.
                requireBoolish(a, opName); requireBoolish(b, opName);
                const [lc, rc] = [boolC(a), boolC(b)];
                if (op === 'XOR') return { c: `((bool)${lc} != (bool)${rc})`, t: 'BOOL', pure };
                return { c: `(${lc} ${LOGIC[op][0]} ${rc})`, t: 'BOOL', pure };
            }
            if ((intA || a.t === null) && (intB || b.t === null) && (intA || intB)) {
                // Bitwise on integers / bit strings: the result has the common
                // width, and AND/OR/XOR of two in-range values stays in range.
                const ct = commonNum(a, b);
                const cop = BITWISE[op] || LOGIC[op][1];
                const t = ct === '#INT' ? '#INT' : ct;
                const res = { c: `(${a.c} ${cop} ${b.c})`, t, pure };
                if (t === '#INT') res.lit = op === 'XOR' || op === 'BXOR' ? a.lit ^ b.lit : (cop === '&' ? a.lit & b.lit : a.lit | b.lit);
                return res;
            }
            if (a.t === null && b.t === null) {
                // Neither type is known: decided by C's _Generic (plc.h).
                return { c: `KRON_${opName === 'BAND' ? 'AND' : opName === 'BOR' ? 'OR' : opName === 'BXOR' ? 'XOR' : opName}_U(${a.c}, ${b.c})`, t: null, pure };
            }
            if (BITWISE[op] && (boolA || boolB)) {
                requireBoolish(a, opName); requireBoolish(b, opName);
                return { c: `(${boolC(a)} ${BITWISE[op]} ${boolC(b)})`, t: 'BOOL', pure };
            }
            fail(`${opName} cannot combine ${showT(a.t)} and ${showT(b.t)} (both BOOL for a logical, both integer/bit-string for a bitwise ${opName})`);
        }

        if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
            const strA = isStrT(a.t), strB = isStrT(b.t);
            if (strA || strB) {
                if (!(strA || a.t === null) || !(strB || b.t === null)) fail(`cannot compare ${showT(a.t)} with ${showT(b.t)}`);
                // ⚠️ Text compares by CONTENT: C `==` on two char* tests
                // addresses, so equal text in different buffers was "different".
                if (op === '=') return { c: `__kron_streq(${a.c}, ${b.c})`, t: 'BOOL', pure };
                if (op === '<>') return { c: `(!__kron_streq(${a.c}, ${b.c}))`, t: 'BOOL', pure };
                fail(`STRING comparison "${op}" is not supported: only = and <> work on text. ` +
                    'Convert with STRING_TO_DINT / STRING_TO_REAL to order values.');
            }
            const cop = op === '=' ? '==' : op === '<>' ? '!=' : op;
            if (isBoolT(a.t) || isBoolT(b.t)) {
                if (op !== '=' && op !== '<>') fail(`"${op}" does not order BOOL values`);
                requireBoolish(a, op); requireBoolish(b, op);
                return { c: `(${boolC(a)} ${cop} ${boolC(b)})`, t: 'BOOL', pure };
            }
            if (a.t === null || b.t === null) return { c: `(${a.c} ${cop} ${b.c})`, t: 'BOOL', pure };
            if (a.t === 'POINTER' || b.t === 'POINTER') {
                if (a.t !== b.t || (op !== '=' && op !== '<>')) fail(`cannot compare ${showT(a.t)} with ${showT(b.t)} using "${op}"`);
                return { c: `(${a.c} ${cop} ${b.c})`, t: 'BOOL', pure };
            }
            const enumA = env.enumTypes.has(String(a.t).toLowerCase()), enumB = env.enumTypes.has(String(b.t).toLowerCase());
            if (enumA || enumB) {
                if (enumA && enumB && a.t !== b.t) fail(`cannot compare ${a.t} with ${b.t}`);
                const other = enumA ? b : a;
                if (!enumA || !enumB) { if (!isIntT(other.t)) fail(`cannot compare ${showT(a.t)} with ${showT(b.t)}`); }
                return { c: `(${a.c} ${cop} ${b.c})`, t: 'BOOL', pure };
            }
            if (!isNumT(a.t) || !isNumT(b.t)) fail(`cannot compare ${showT(a.t)} with ${showT(b.t)}`);
            if (isTimeT(a.t) !== isTimeT(b.t) && a.t !== '#INT' && b.t !== '#INT') {
                fail(`cannot compare ${showT(a.t)} with ${showT(b.t)} (a TIME compares with a TIME)`);
            }
            // Numeric: both sides in ONE explicit common type whenever C's own
            // conversion would differ (signed vs unsigned, int vs real).
            const ct = commonNum(a, b);
            const ta = effType(a, b), tb = effType(b, a);
            const mixedClass = (isRealT(ta) !== isRealT(tb)) || needsSignCast(a, b, ct);
            const [lc, rc] = mixedClass && ct && ct !== '#INT' && ct !== '#REAL'
                ? [castTo(a, ct), castTo(b, ct)] : [a.c, b.c];
            return { c: `(${lc} ${cop} ${rc})`, t: 'BOOL', pure };
        }

        if (op === '**') {
            if ((a.t !== null && !isNumT(a.t)) || (b.t !== null && !isNumT(b.t))) fail(`** needs numbers, got ${showT(a.t)} and ${showT(b.t)}`);
            return { c: `pow((double)${a.c}, (double)${b.c})`, t: 'LREAL', pure };
        }

        // + - * / MOD
        if ((a.t !== null && !isNumT(a.t)) || (b.t !== null && !isNumT(b.t))) {
            const what = isStrT(a.t) || isStrT(b.t) ? ' (STRING has no arithmetic operators; convert with STRING_TO_DINT / STRING_TO_REAL)' : '';
            fail(`"${op}" needs numbers, got ${showT(a.t)} and ${showT(b.t)}${what}`);
        }
        let ct = commonNum(a, b);
        if ((op === '+' || op === '-') && (isTimeT(a.t) !== isTimeT(b.t)) && a.t !== '#INT' && b.t !== '#INT' && a.t !== null && b.t !== null) {
            fail(`"${op}" cannot combine ${showT(a.t)} and ${showT(b.t)} (TIME ± TIME only; scale a TIME with * or /)`);
        }
        const signCast = needsSignCast(a, b, ct);
        const [lc, rc] = signCast ? [castTo(a, ct), castTo(b, ct)] : [a.c, b.c];
        const intDiv = (ct === null) || (!isRealT(effType(a, b)) && !isRealT(effType(b, a)));
        // Literal folding of the TYPE only (the C text stays as written).
        const litOf = (f) => (ct === '#INT' ? { lit: f() } : {});
        if (op === 'MOD') {
            if (ct !== null && !intDiv) fail(`MOD needs integers, got ${showT(a.t)} and ${showT(b.t)}`);
            return { c: `KRON_IMOD(${lc}, ${rc})`, t: ct, pure, ...litOf(() => (b.lit === 0n ? 0n : a.lit % b.lit)) };
        }
        if (op === '/') {
            // ⚠️ An integer divide by zero (and INT_MIN / -1) is SIGFPE on
            // x86_64: KRON_IDIV yields 0 instead. Unknown operand types also
            // take KRON_IDIV, whose _Generic still divides floats normally.
            if (intDiv) return { c: `KRON_IDIV(${lc}, ${rc})`, t: ct, pure, ...litOf(() => (b.lit === 0n ? 0n : a.lit / b.lit)) };
            if (isTimeT(ct)) return { c: `((int64_t)(${lc} / ${rc}))`, t: ct, pure };
            return { c: `(${lc} / ${rc})`, t: ct, pure };
        }
        const c = `(${lc} ${op} ${rc})`;
        // TIME scaled by a REAL is computed in double; keep it a TIME (int64).
        if (isTimeT(ct) && (isRealT(a.t) || isRealT(b.t))) return { c: `((int64_t)${c})`, t: ct, pure };
        const res = { c, t: ct, pure };
        if (ct === '#INT') res.lit = op === '+' ? a.lit + b.lit : op === '-' ? a.lit - b.lit : a.lit * b.lit;
        return res;
    };

    // ── calls ──
    const positional = (fname, args, order, { min = order.length, max = order.length, variadicPrefix = null } = {}) => {
        if (args.some(a => a.op === '=>')) fail(`${fname}(... ${args.find(a => a.op === '=>').name} => …): output arguments are not supported in an expression`);
        const named = args.filter(a => a.name);
        if (named.length && named.length !== args.length) fail(`call ${fname}(...) mixes named and positional arguments`);
        let list;
        if (named.length) {
            const by = new Map();
            named.forEach(a => {
                const key = a.name.toUpperCase();
                if (by.has(key)) fail(`${fname}(...): argument ${a.name} given twice`);
                by.set(key, a.e);
            });
            if (variadicPrefix) {
                // IN0, IN1, … (MUX) / IN1, IN2, … (MIN/MAX) after the fixed ones.
                const fixed = order.filter(k => by.has(k));
                const rest = [...by.keys()].filter(k => !order.includes(k));
                rest.forEach(k => { if (!new RegExp(`^${variadicPrefix}\\d+$`).test(k)) fail(`${fname} has no input "${k}"`); });
                rest.sort((x, y) => parseInt(x.slice(variadicPrefix.length), 10) - parseInt(y.slice(variadicPrefix.length), 10));
                order.forEach(k => { if (!by.has(k)) fail(`${fname}(...) is missing argument ${k}`); });
                list = [...fixed, ...rest].map(k => by.get(k));
            } else {
                by.forEach((_, k) => { if (!order.includes(k)) fail(`${fname} has no input "${k}" (inputs: ${order.join(', ')})`); });
                const missing = order.slice(0, min).filter(k => !by.has(k));
                if (missing.length) fail(`${fname}(...) is missing argument(s) ${missing.join(', ')}`);
                list = order.filter(k => by.has(k)).map(k => by.get(k));
            }
        } else {
            list = args.map(a => a.e);
        }
        if (list.length < min || list.length > max) {
            fail(`${fname} takes ${min === max ? min : `${min}${max === Infinity ? '+' : `..${max}`}`} argument(s), got ${list.length}`);
        }
        return list;
    };

    // Statement-expression temp for an impure value, so a call inside it is
    // evaluated exactly once; a pure value is used as is.
    const once = (r, ct, decls) => {
        if (r.pure !== false) return r.c;
        const n = tmp();
        decls.push(`${ct || '__auto_type'} ${n} = ${r.c};`);
        return n;
    };
    const stmtExpr = (decls, value) => (decls.length ? `({ ${decls.join(' ')} ${value}; })` : value);

    const numericArgs = (fname, rs) => {
        rs.forEach(r => {
            if (r.t !== null && !isNumT(r.t) && !env.enumTypes.has(String(r.t).toLowerCase())) fail(`${fname} needs numeric arguments, got ${showT(r.t)}`);
        });
        // Fold the common type over the arguments; all-literal → the type
        // the largest literal needs.
        let acc = rs[0];
        for (const r of rs.slice(1)) {
            if (acc.t === null || r.t === null) return null;
            const t = commonNum(acc, r);
            if (t === null) return null;
            acc = t === '#INT' ? { t, lit: (acc.lit < 0n ? -acc.lit : acc.lit) > (r.lit < 0n ? -r.lit : r.lit) ? acc.lit : r.lit } : { t };
        }
        if (acc.t === '#INT') return literalNaturalType(acc.lit);
        if (acc.t === '#REAL') return 'LREAL';
        return acc.t;
    };

    const emitSelection = (U, args) => {
        if (U === 'MIN' || U === 'MAX') {
            const list = positional(U, args, [], { min: 2, max: Infinity, variadicPrefix: 'IN' });
            const rs = list.map(emitNode);
            const t = numericArgs(U, rs);
            const ct = t ? cTypeOf(t) : null;
            const decls = [];
            const vals = rs.map(r => {
                const n = tmp();
                decls.push(`${ct || '__auto_type'} ${n} = ${ct ? castTo(r, t) : r.c};`);
                return n;
            });
            const cmp = U === 'MIN' ? '<' : '>';
            if (vals.length === 2) {
                return { c: stmtExpr(decls, `(${vals[1]} ${cmp} ${vals[0]} ? ${vals[1]} : ${vals[0]})`), t, pure: rs.every(isPureR) };
            }
            // 3+ inputs: a running extreme (linear, not a nested ternary
            // that repeats the accumulated text for every extra input).
            const acc = tmp();
            decls.push(`${ct || '__auto_type'} ${acc} = ${vals[0]};`);
            vals.slice(1).forEach(v => decls.push(`if (${v} ${cmp} ${acc}) ${acc} = ${v};`));
            return { c: stmtExpr(decls, acc), t, pure: rs.every(isPureR) };
        }
        if (U === 'LIMIT') {
            const [mn, iv, mx] = positional(U, args, ['MN', 'IN', 'MX']).map(emitNode);
            const t = numericArgs(U, [mn, iv, mx]);
            const ct = t ? cTypeOf(t) : null;
            const decls = [];
            const [a, b, c] = [mn, iv, mx].map(r => { const n = tmp(); decls.push(`${ct || '__auto_type'} ${n} = ${ct ? castTo(r, t) : r.c};`); return n; });
            return { c: stmtExpr(decls, `(${b} < ${a} ? ${a} : (${b} > ${c} ? ${c} : ${b}))`), t, pure: [mn, iv, mx].every(isPureR) };
        }
        if (U === 'SEL') {
            const [g, in0, in1] = positional(U, args, ['G', 'IN0', 'IN1']).map(emitNode);
            if (g.t !== null && !isBoolT(g.t)) fail(`SEL: G must be BOOL, got ${showT(g.t)}`);
            const strs = [in0, in1].map(r => isStrT(r.t));
            if (strs[0] !== strs[1] && in0.t !== null && in1.t !== null) fail(`SEL: IN0 and IN1 must have the same type (${showT(in0.t)} vs ${showT(in1.t)})`);
            if (strs[0] || strs[1]) return { c: `(${g.c} ? ${in1.c} : ${in0.c})`, t: 'STRING', pure: [g, in0, in1].every(isPureR) };
            if (isBoolT(in0.t) && isBoolT(in1.t)) return { c: `(${g.c} ? ${in1.c} : ${in0.c})`, t: 'BOOL', pure: [g, in0, in1].every(isPureR) };
            const t = numericArgs(U, [in0, in1]);
            return { c: `(${g.c} ? ${t ? castTo(in1, t) : in1.c} : ${t ? castTo(in0, t) : in0.c})`, t, pure: [g, in0, in1].every(isPureR) };
        }
        if (U === 'MUX') {
            const list = positional(U, args, ['K'], { min: 2, max: Infinity, variadicPrefix: 'IN' });
            const [k, ...ins] = list.map(emitNode);
            if (k.t !== null && !isIntT(k.t)) fail(`MUX: K must be an integer, got ${showT(k.t)}`);
            const anyStr = ins.some(r => isStrT(r.t));
            const anyBool = ins.every(r => isBoolT(r.t));
            const t = anyStr ? 'STRING' : anyBool ? 'BOOL' : numericArgs(U, ins);
            if (anyStr && ins.some(r => r.t !== null && !isStrT(r.t))) fail('MUX: all inputs must have the same type');
            const decls = [];
            const kc = once(k, 'int64_t', decls);
            const val = (r) => (t && !anyStr && !anyBool ? castTo(r, t) : r.c);
            // Out-of-range K selects the last input (IEC leaves it undefined).
            const chain = ins.slice(0, -1).reduceRight((acc, r, i) => `(${kc} == ${i} ? ${val(r)} : ${acc})`, val(ins[ins.length - 1]));
            return { c: stmtExpr(decls, chain), t, pure: [k, ...ins].every(isPureR) };
        }
        return null;
    };

    const emitShift = (U, args) => {
        const [x, n] = positional(U, args, ['IN', 'N']).map(emitNode);
        if (x.t !== null && !isIntT(x.t)) fail(`${U}: IN must be an integer/bit-string, got ${showT(x.t)}`);
        if (n.t !== null && !isIntT(n.t)) fail(`${U}: N must be an integer, got ${showT(n.t)}`);
        // The operand's own width decides the result (BYTE 8 … LWORD 64); an
        // untyped literal or an unknown operand is a DWORD (the IEC default and
        // what the archive's uint32 SHL/SHR always did).
        const T = (x.t === null || x.t === '#INT') ? 'DWORD' : x.t;
        const W = widthOf(T), ct = ELEMENTARY_C[T], ut = UNSIGNED_C[W];
        const decls = [];
        const xc = once({ ...x, c: castTo(x, T) }, ct, decls);
        const nc = once(n, 'int64_t', decls);
        if (U === 'SHL' || U === 'SHR') {
            // ⚠️ A count >= the width is undefined behaviour in C (x86 masks
            // it, ARM does not) — IEC shifts every bit out, so the result is 0.
            const wide = W === 64 ? 'uint64_t' : 'uint32_t';
            const sh = U === 'SHL' ? '<<' : '>>';
            return {
                c: stmtExpr(decls, `((uint64_t)${nc} >= ${W}u ? (${ct})0 : (${ct})((${wide})(${ut})${xc} ${sh} (unsigned)${nc}))`),
                t: T, pure: x.pure !== false && n.pure !== false,
            };
        }
        return { c: stmtExpr(decls, `((${ct})${H.rotateExpr(U, xc, nc, W)})`), t: T, pure: x.pure !== false && n.pure !== false };
    };

    const userCall = (fn, args) => {
        const params = fn.params;
        if (args.some(a => a.op === '=>')) {
            const a = args.find(x => x.op === '=>');
            fail(`${fn.name}(... ${a.name} => …): FUNCTION output arguments are not supported.`);
        }
        let list;
        if (args.some(a => a.name)) {
            if (!args.every(a => a.name)) fail(`call ${fn.name}(...) mixes named and positional arguments.`);
            const by = new Map();
            args.forEach(a => {
                const pIdx = params.findIndex(x => x.name.toLowerCase() === a.name.toLowerCase());
                if (pIdx < 0) fail(`FUNCTION ${fn.name} has no input "${a.name}" (inputs: ${params.map(x => x.name).join(', ') || 'none'}).`);
                by.set(pIdx, a.e);
            });
            const missing = params.filter((_, i) => !by.has(i)).map(x => x.name);
            if (missing.length) fail(`call ${fn.name}(...) is missing argument(s) ${missing.join(', ')}.`);
            list = params.map((_, i) => by.get(i));
        } else {
            if (args.length !== params.length) {
                fail(`FUNCTION ${fn.name} takes ${params.length} argument(s) (${params.map(x => x.name).join(', ') || 'none'}), got ${args.length}.`);
            }
            list = args.map(a => a.e);
        }
        const cargs = list.map((e, i) => {
            const p = params[i];
            if (p.inout) {
                const r = emitNode(e);
                if (!r.lval || r.bitOf) fail(`${fn.name}(...) argument "${p.name}" is VAR_IN_OUT and must be a variable.`);
                checkAssignable(p.type, r, `${fn.name}.${p.name}`);
                return `&(${r.c})`;
            }
            const r = emitNode(e);
            checkAssignable(p.type, r, `${fn.name}.${p.name}`);
            return r.c;
        });
        let c;
        if (isStrT(fn.ret)) {
            // ⚠️ Each STRING-returning call site gets its OWN result buffer,
            // declared at function scope (so it outlives the expression): with
            // one shared buffer `F(a) = F(b)` compared F(b) with itself.
            const buf = `__sret${env.seq.next++}`;
            env.decls.push(`kron_string_t ${buf};`);
            c = `${fn.name}(&${buf}${cargs.length ? ', ' : ''}${cargs.join(', ')})`;
        } else {
            c = `${fn.name}(${cargs.join(', ')})`;
        }
        const rt = !fn.ret || /^VOID$/i.test(fn.ret) ? 'VOID' : canonT(fn.ret);
        return { c, t: rt, pure: false };
    };

    const STD_MATH_C = {
        SQRT: 'sqrt', LN: 'log', LOG: 'log10', EXP: 'exp',
        SIN: 'sin', COS: 'cos', TAN: 'tan', ASIN: 'asin', ACOS: 'acos', ATAN: 'atan',
    };

    const emitCall = (node) => {
        const name = node.name, lower = name.toLowerCase(), U = name.toUpperCase();
        const fn = env.userFunctions.get(lower);
        if (fn) return userCall(fn, node.args);
        if (env.isFbTypeName(name)) fail(`${name} is a FUNCTION_BLOCK type: declare an instance and call it as a statement`);
        if (env.isFbInstance(name)) fail(`FB instance ${name}(...) can only be called as a statement, not inside an expression`);

        const one = (pin = 'IN') => emitNode(positional(U, node.args, [pin])[0]);
        const conv = /^([A-Z]+)_TO_([A-Z]+)$/.exec(U);
        if (conv) {
            const [, src, dst] = conv;
            const ks = H.IEC_KRON_NAME[src], kd = H.IEC_KRON_NAME[dst];
            if (!ks || !kd) fail(`${U} is not a supported conversion`);
            const r = one();
            if (r.t !== null && (isStrT(r.t) !== (src === 'STRING'))) fail(`${U} expects a ${src} argument, got ${showT(r.t)}`);
            if (kd === 'STRING') {
                if (!env.strConv) {
                    fail(`${src}_TO_STRING is only available inside a PROGRAM. ` +
                        'A FUNCTION or FUNCTION_BLOCK has no PlcState field to hold the text.');
                }
                const buf = H.strConvSymbol(env.strConv.progName, `st${env.strConv.next++}`);
                return { c: `KRON_${ks}_TO_STRING(${r.c}, S->${buf}, ${H.STRING_SHM_BYTES})`, t: 'STRING', pure: false };
            }
            // Archive-backed (libkronconverter): its rounding is the library's.
            return { c: `KRON_${ks}_TO_${kd}(${r.c})`, t: dst, pure: r.pure };
        }
        if (ELEMENTARY_C[U] && !isTimeT(U)) {
            // INT(x): an integer target ROUNDS (IEC REAL_TO_INT semantics) —
            // KRON_RND passes integers through; REAL(x)/BOOL(x) are C casts.
            const r = one();
            if (r.t !== null && !isNumT(r.t) && !isBoolT(r.t)) fail(`${U}(...) needs a number, got ${showT(r.t)}`);
            if (INT_INFO[U]) return { c: `((${ELEMENTARY_C[U]})KRON_RND(${r.c}))`, t: U, pure: r.pure };
            return { c: `((${ELEMENTARY_C[U]})(${r.c}))`, t: U, pure: r.pure };
        }
        if (STD_MATH_C[U]) {
            const r = one();
            if (r.t !== null && !isNumT(r.t)) fail(`${U} needs a number, got ${showT(r.t)}`);
            return { c: `${STD_MATH_C[U]}(${r.c})`, t: 'LREAL', pure: r.pure };
        }
        switch (U) {
            case 'EXPT': {
                const [a, b] = positional(U, node.args, ['IN1', 'IN2']).map(emitNode);
                [a, b].forEach(r => { if (r.t !== null && !isNumT(r.t)) fail(`EXPT needs numbers, got ${showT(r.t)}`); });
                return { c: `pow((double)${a.c}, (double)${b.c})`, t: 'LREAL', pure: a.pure !== false && b.pure !== false };
            }
            case 'ABS': {
                const r = one();
                if (r.t !== null && !isNumT(r.t)) fail(`ABS needs a number, got ${showT(r.t)}`);
                // plc.h's ABS macro evaluates its argument twice: fine for a
                // side-effect-free one, a temp otherwise.
                if (r.pure !== false) return { c: `ABS(${r.c})`, t: r.t, pure: true };
                const decls = [];
                const x = once(r, cTypeOf(r.t), decls);
                return { c: stmtExpr(decls, `(${x} < 0 ? -${x} : ${x})`), t: r.t, pure: false };
            }
            case 'TRUNC': {
                const r = one();
                if (r.t !== null && !isNumT(r.t)) fail(`TRUNC needs a number, got ${showT(r.t)}`);
                return { c: `((int64_t)${r.c})`, t: 'LINT', pure: r.pure };
            }
            case 'MOVE': return one();
            case 'ADR': {
                const r = one();
                if (!r.lval || r.bitOf) fail('ADR(...) needs a variable');
                return { c: `(&(${r.c}))`, t: 'POINTER', pure: r.pure };
            }
            case 'MIN': case 'MAX': case 'LIMIT': case 'SEL': case 'MUX':
                return emitSelection(U, node.args);
            case 'SHL': case 'SHR': case 'ROL': case 'ROR':
                return emitShift(U, node.args);
            default:
                break;
        }
        if (env.lookupVar(name)) fail(`${name} is a variable, not a function`);
        fail(`unknown function "${name}"`);
        return null;
    };

    const emitNode = (node) => {
        switch (node.k) {
            case 'num': return emitNum(node);
            case 'str': return emitStr(node.raw);
            case 'time': {
                const v = node.us;
                return { c: v < 0n ? `(${v}LL)` : `${v}LL`, t: node.type, pure: true, lit: v, timeLit: true };
            }
            case 'typed': return emitTyped(node.tok);
            case 'bool': return { c: node.v ? 'true' : 'false', t: 'BOOL', pure: true };
            case 'enumlit': {
                const et = env.enumTypes.get(node.type.toLowerCase());
                if (!et) fail(`"${node.type}#${node.member}": ${node.type} is not an enumerated type`);
                const em = env.enumMember(node.member);
                if (!em || em.type.toLowerCase() !== et.toLowerCase()) fail(`${et} has no value "${node.member}"`);
                return { c: em.name, t: em.type, pure: true };
            }
            case 'id': return resolveId(node);
            case 'paren': {
                const r = emitNode(node.e);
                return { ...r, lval: false };
            }
            case 'member': return memberAccess(node);
            case 'bit': return bitAccess(node);
            case 'index': return indexAccess(node);
            case 'call': return emitCall(node);
            case 'un': return emitUnary(node);
            case 'bin': return emitBinary(node);
            default: fail(`internal: unknown node ${node.k}`);
        }
        return null;
    };

    // A value of type r.t may be stored into a `target` slot (assignment,
    // argument)? Only gross mismatches are refused; numeric conversions stay
    // C's (IEC would demand an explicit conversion — the regex path never
    // did, and refusing them now would break working projects).
    const checkAssignable = (target, r, what) => {
        const tt = target ? String(target).trim().toUpperCase() : null;
        if (!tt || r.t === null) return;
        if (r.t === 'VOID') fail(`${what}: the called FUNCTION returns no value`);
        if (isStrT(tt) && !isStrT(r.t)) fail(`${what} is ${tt}, cannot take ${showT(r.t)} (convert with ${r.t === '#INT' ? 'DINT' : r.t}_TO_STRING)`);
        if (!isStrT(tt) && isStrT(r.t) && (ELEMENTARY_C[tt] || isTimeT(tt))) fail(`${what} is ${tt}, cannot take a STRING (convert with STRING_TO_${INT_INFO[tt] || isRealT(tt) ? tt : 'DINT'})`);
    };

    const parseText = (text) => parseST(tokenizeST(text, env));
    const toValue = (r) => {
        if (r.pendingDims) fail('an array needs all its indexes before it can be used as a value');
        return r;
    };

    return {
        // A full expression → { c, t }.
        expr(text) { return toValue(emitNode(parseText(text))); },
        // An assignment target → { c, t, ptrStr, bitOf, bit }.
        lvalue(text) {
            const ast = parseText(text);
            if (!['id', 'member', 'index', 'bit'].includes(ast.k)) fail(`"${String(text).trim()}" is not a variable that can be assigned`);
            const r = emitNode(ast);
            if (!r.lval && !r.bitOf) fail(`"${String(text).trim()}" cannot be assigned`);
            if (r.pendingDims) fail(`"${String(text).trim()}": assigning a whole ARRAY dimension is not supported`);
            return r;
        },
        // A value for a slot of IEC type `targetType` (an FB pin): the
        // expression, with gross type mismatches refused.
        value(text, targetType, what) {
            const R = toValue(emitNode(parseText(text)));
            if (R.t === 'VOID') fail(`"${String(text).trim()}" returns no value`);
            checkAssignable(targetType, R, what);
            return R.c;
        },
        // `target := <already emitted C of IEC type rhsType>` (FB output
        // captures, VAR_IN_OUT copy-back).
        assignC(lhsText, rhsC, rhsType) {
            return this.assignR(lhsText, { c: rhsC, t: rhsType ?? null, pure: true });
        },
        // `target := value` → one C statement (no trailing `;`).
        assign(lhsText, rhsText) {
            return this.assignR(lhsText, toValue(emitNode(parseText(rhsText))), rhsText);
        },
        assignR(lhsText, R, rhsText = '') {
            const L = this.lvalue(lhsText);
            const lt = L.t;
            checkAssignable(L.ptrStr ? null : lt, R, `"${String(lhsText).trim()}"`);
            if (R.t === 'VOID') fail(`"${String(rhsText).trim()}" returns no value`);
            if (isStrT(lt) && !L.ptrStr) {
                // ⚠️ STRING storage is an array: never C `=`, always a bounded copy.
                return `KRON_STRSET(${L.c}, ${R.c})`;
            }
            if (L.bitOf) {
                if (!L.bitOf.lval) fail(`"${String(lhsText).trim()}" cannot be assigned`);
                // Mask arithmetic in an UNSIGNED type: `(int32_t)1 << 31`
                // would overflow a signed int.
                const B = L.bitOf, T = B.t || 'DWORD', ct = ELEMENTARY_C[T] || 'uint32_t', w = widthOf(T) || 32;
                const ut = w === 64 ? 'uint64_t' : 'uint32_t', one = w === 64 ? '1ULL' : '1u';
                return `${B.c} = (${ct})(((${ut})(${UNSIGNED_C[w]})${B.c} & ~(${one} << ${L.bit})) | ((${ut})((${R.c}) ? ${one} : 0u) << ${L.bit}))`;
            }
            return `${L.c} = ${R.c}`;
        },
        // An expression used as a statement: must be a call.
        callStatement(text) {
            const ast = parseText(text);
            if (ast.k !== 'call') {
                fail(`"${String(text).trim()}" is not a statement (an assignment needs ":=", a call needs parentheses)`);
            }
            return emitNode(ast).c;
        },
    };
};
