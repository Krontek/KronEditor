const arr = (name, baseType, dims) => ({ name, type: 'Array', content: { baseType, dimensions: dims.map(([min, max]) => ({ min, max })) } });

// IEC run-time errors: every one goes through __kron_rte / plc_rte_report
// (root CLAUDE.md), which counts (__rte_count), records the code (__rte_code
// = RUNTIME_ERROR_TYPES) and, by the default policy, keeps running or stops.
// Standards/iec61131-3.md §14 (run time) and §15; codes in
// CTranspilerService.js RUNTIME_ERROR_TYPES:
//   1 div0  2 shift  3 mux  4 forStep  5 index  6 overrun
export default [
    {
        name: 'integer division by zero is a run-time error, result 0',
        ref: '§7.3.2 / §14',
        vars: ['a : INT := 10', 'z : INT := 0', 'r : INT := 5'],
        code: 'r := a / z;',
        expect: { r: 0, __rte_count: 1, __rte_code: 1 },
    },
    {
        name: 'MOD 0 is NOT a run-time error',
        ref: 'T29 fn. e',
        vars: ['a : INT := 10', 'z : INT := 0', 'r : INT := 5'],
        code: 'r := a MOD z;',
        expect: { r: 0, __rte_count: 0 },
    },
    {
        name: 'a division by a non-zero variable raises nothing',
        vars: ['a : INT := 10', 'z : INT := 3', 'r : INT'],
        code: 'r := a / z;',
        expect: { r: 3, __rte_count: 0 },
    },
    {
        name: 'negative shift count is a run-time error',
        ref: 'T30 fn. a',
        vars: ['b : BYTE := 16#0F', 'n : INT := -1', 'r : BYTE'],
        code: 'r := SHL(b, n);',
        expect: { __rte_code: 2 },
    },
    {
        name: 'MUX selector out of range is a run-time error, result IN0',
        ref: 'T32 fn. e',
        vars: ['k : INT := 7', 'r : INT'],
        code: 'r := MUX(k, 10, 20, 30);',
        expect: { r: 10, __rte_code: 3 },
    },
    {
        name: 'FOR ... BY 0 at run time is a run-time error, loop skipped',
        ref: '§16.1',
        vars: ['i : INT', 'st : INT := 0', 'n : INT := 0'],
        code: 'FOR i := 1 TO 5 BY st DO n := n + 1; END_FOR;',
        expect: { n: 0, __rte_code: 4 },
    },
    {
        name: 'array index out of range is a run-time error and stops the PLC',
        ref: '§6.4.4.5 / §16.5 30',
        dataTypes: [arr('A13', 'INT', [[1, 3]])],
        vars: ['a : A13', 'b : INT := 77', 'i : INT := 4'],
        code: 'a[i] := 5;',
        expect: { __rte_code: 5, b: 77, 'a[1]': 5 },
        expectStopped: true,
    },
    {
        name: 'index below the lower bound does not touch the neighbouring field',
        ref: 'src/services/CLAUDE.md KRON_IDX',
        dataTypes: [arr('A24', 'INT', [[2, 4]])],
        vars: ['before : INT := 11', 'a : A24', 'after : INT := 22', 'i : INT := 0'],
        code: 'a[i] := 9;',
        expect: { __rte_code: 5, before: 11, after: 22 },
    },
    {
        name: 'each faulting scan counts once more',
        vars: ['z : DINT := 0', 'r : DINT'],
        code: 'r := 1 / z;',
        scans: 5,
        expect: { __rte_count: 5 },
    },
];
