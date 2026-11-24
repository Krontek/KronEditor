// A run-time error code alone does NOT prove that the configured action ran.
// Assert the stop flag and actual scan count as well as the fallback value.
// Policy is a Kron contract: CTranspilerService.js RUNTIME_ERROR_TYPES.
const faults = [
    { key: 'div0', codeId: 1, vars: ['zero : DINT', 'result : DINT'], code: 'result := 12 / zero;', expect: { result: 0 } },
    { key: 'shift', codeId: 2, vars: ['count : INT := -1', 'result : BYTE'], code: 'result := SHL(BYTE#15, count);', expect: { result: 15 } },
    { key: 'mux', codeId: 3, vars: ['index : INT := 3', 'result : INT'], code: 'result := MUX(index, 11, 22);', expect: { result: 11 } },
    { key: 'forStep', codeId: 4, vars: ['stepSize : INT', 'i : INT', 'iterations : INT'], code: 'FOR i := 1 TO 3 BY stepSize DO iterations := iterations + 1; END_FOR;', expect: { iterations: 0 } },
    {
        key: 'index', codeId: 5,
        dataTypes: [{ name: 'SmallArray', type: 'Array', content: { baseType: 'INT', dimensions: [{ min: 1, max: 2 }] } }],
        vars: ['a : SmallArray', 'index : INT := 3'], code: 'a[index] := 7;', expect: { 'a[1]': 7 },
    },
];

export default [
    ...faults.flatMap(f => ['stop', 'report'].map(action => ({
        name: `${f.key} policy ${action}: verify flag and subsequent scan execution`,
        ref: 'src/services/CTranspilerService.js RUNTIME_ERROR_TYPES',
        vars: ['scansSeen : DINT', ...f.vars], dataTypes: f.dataTypes,
        taskConfig: { runtimeErrorPolicy: { [f.key]: action } },
        code: `scansSeen := scansSeen + 1;\n${f.code}`,
        scans: 3,
        expect: { ...f.expect, scansSeen: action === 'stop' ? 1 : 3, __rte_code: f.codeId, __rte_count: action === 'stop' ? 1 : 3 },
        expectStopped: action === 'stop', expectScans: action === 'stop' ? 1 : 3,
    }))),
    {
        name: 'STOP persists across driver steps instead of executing later scans',
        ref: 'runtime outer scan loop checks plc_stop',
        vars: ['zero : INT', 'r : INT', 'scansSeen : DINT'],
        taskConfig: { runtimeErrorPolicy: { div0: 'stop' } },
        code: 'scansSeen := scansSeen + 1; r := 5 / zero;',
        steps: [
            { expect: { scansSeen: 1, __rte_count: 1 }, expectStopped: true, expectScans: 1 },
            { scans: 4, expect: { scansSeen: 1, __rte_count: 1 }, expectStopped: true, expectScans: 1 },
        ],
    },
];
