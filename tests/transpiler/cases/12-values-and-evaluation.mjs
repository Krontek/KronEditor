// String limits and BOOL evaluation are documented implementation choices:
// Standards/iec61131-3.md §3.2, §9.2 and §16.7.
const prefix = n => 'a'.repeat(n);

export default [
    {
        name: 'UTF-8 STRING assignment and copy preserve Turkish characters',
        ref: '§6.3.3 / Kron UTF-8 STRING',
        vars: ['s : STRING', 'copy : STRING'],
        code: "s := 'İstanbul, ığüşöç';\ncopy := s;",
        expect: { s: 'İstanbul, ığüşöç', copy: 'İstanbul, ığüşöç' },
    },
    {
        name: 'UTF-8 STRING truncation does not split a character at byte 63',
        ref: '§6.6.1.2.2 / Kron 63-byte UTF-8 truncation',
        vars: ['s : STRING', 'copy : STRING'],
        code: `s := '${prefix(62)}ç';\ncopy := s;`,
        expect: { s: prefix(62), copy: prefix(62) },
    },
    {
        name: 'UTF-8 STRING keeps a whole character ending exactly at byte 63',
        ref: '§6.6.1.2.2 / Kron 63-byte UTF-8 truncation',
        vars: ['s : STRING'],
        code: `s := '${prefix(61)}çZ';`,
        expect: { s: `${prefix(61)}ç` },
    },
    {
        name: 'driver inputs preserve LINT minimum and ULINT maximum exactly',
        ref: 'T10 / fixture precision regression',
        vars: ['signedInput : LINT', 'unsignedInput : ULINT', 'signedCopy : LINT', 'unsignedCopy : ULINT'],
        set: { signedInput: -9223372036854775808n, unsignedInput: 18446744073709551615n },
        code: 'signedCopy := signedInput;\nunsignedCopy := unsignedInput;',
        expect: { signedCopy: -9223372036854775808n, unsignedCopy: 18446744073709551615n },
    },
    ...['AND', 'OR'].map(op => ({
        name: `BOOL ${op} sequences side effects and short-circuits the right operand`,
        ref: '§7.3.2 rules 3–4 / §16.7 Kron short-circuit choice',
        vars: ['left : BOOL', 'right : BOOL', 'trace : DINT', 'result : BOOL'],
        functions: [{
            name: 'Visit', returnType: 'BOOL',
            vars: ['IN value : BOOL', 'IN digit : DINT', 'INOUT log : DINT'],
            code: 'log := log * 10 + digit;\nVisit := value;',
        }],
        code: `trace := 0;\nresult := Visit(left, 1, trace) ${op} Visit(right, 2, trace);`,
        steps: [
            { set: { left: false, right: false }, expect: { result: false, trace: op === 'AND' ? 1 : 12 } },
            { set: { left: false, right: true }, expect: { result: op === 'OR', trace: op === 'AND' ? 1 : 12 } },
            { set: { left: true, right: false }, expect: { result: op === 'OR', trace: op === 'OR' ? 1 : 12 } },
            { set: { left: true, right: true }, expect: { result: true, trace: op === 'OR' ? 1 : 12 } },
        ],
    })),
];
