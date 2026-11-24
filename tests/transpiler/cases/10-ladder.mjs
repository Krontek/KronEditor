// IEC 61131-3 digest: Standards/iec61131-3.md §12.3 (T75/T76),
// §8.1.5 evaluation order and §8.1.5.2 rejection of LD wiring cycles.
// These are the editor's saved graph objects, passed to the real transpiler.
const block = (id, type, values, subType) => ({ id, type, data: { instanceName: id, values, ...(subType ? { subType } : {}) } });
const contact = (id, variable, subType = 'NO') => block(id, 'Contact', { var: variable }, subType);
const coil = (id, variable, subType = 'Normal') => block(id, 'Coil', { coil: variable }, subType);
const wire = (source, target, sourcePin = 'out', targetPin = 'in') => ({ source, target, sourcePin, targetPin });
const rail = target => wire('terminal_left', target);
const rung = (blocks, connections) => ({ blocks, connections });

export default [
    {
        name: 'LD series NO/NC contacts implement AND with negation (truth table)',
        ref: '§8.2.4 / T75',
        vars: ['a : BOOL', 'b : BOOL', 'q : BOOL'],
        rungs: [rung([contact('A', 'a'), contact('B', 'b', 'NC'), coil('Q', 'q')], [rail('A'), wire('A', 'B'), wire('B', 'Q')])],
        steps: Array.from({ length: 4 }, (_, n) => {
            const a = !!(n & 1), b = !!(n & 2);
            return { set: { a, b }, expect: { a, b, q: a && !b } };
        }),
    },
    {
        name: 'LD parallel contacts merge with OR before a series interlock',
        ref: '§8.2.3',
        vars: ['a : BOOL', 'b : BOOL', 'permit : BOOL', 'q : BOOL'],
        // Scrambled block storage order: topology, not array order, decides execution.
        rungs: [rung([coil('Q', 'q'), contact('Permit', 'permit'), contact('B', 'b'), contact('A', 'a')],
            [rail('A'), rail('B'), wire('A', 'Permit'), wire('B', 'Permit'), wire('Permit', 'Q')])],
        steps: Array.from({ length: 8 }, (_, n) => {
            const a = !!(n & 1), b = !!(n & 2), permit = !!(n & 4);
            return { set: { a, b, permit }, expect: { q: (a || b) && permit } };
        }),
    },
    {
        name: 'LD a negated coil preserves power flow to the next coil',
        ref: '§8.2.5 / T76',
        vars: ['a : BOOL', 'neg : BOOL', 'normal : BOOL'],
        rungs: [rung([contact('A', 'a'), coil('N', 'neg', 'Negated'), coil('Q', 'normal')], [rail('A'), wire('A', 'N'), wire('N', 'Q')])],
        steps: [false, true, false].map(a => ({ set: { a }, expect: { neg: !a, normal: a } })),
    },
    {
        name: 'LD set/reset coils retain state; later reset rung wins',
        ref: '§8.2.5 / T76, §8.2.7',
        vars: ['setInput : BOOL', 'resetInput : BOOL', 'q : BOOL'],
        rungs: [
            rung([contact('SetInput', 'setInput'), coil('SetQ', 'q', 'Set')], [rail('SetInput'), wire('SetInput', 'SetQ')]),
            rung([contact('ResetInput', 'resetInput'), coil('ResetQ', 'q', 'Reset')], [rail('ResetInput'), wire('ResetInput', 'ResetQ')]),
        ],
        steps: [
            { expect: { q: false } },
            { set: { setInput: true }, expect: { q: true } },
            { set: { setInput: false }, scans: 3, expect: { q: true } },
            { set: { resetInput: true }, expect: { q: false } },
            { set: { resetInput: false }, expect: { q: false } },
            { set: { setInput: true, resetInput: true }, expect: { q: false } },
        ],
    },
    ...['Rising', 'Falling'].map(subType => ({
        name: `LD ${subType} contact pulses for one scan`,
        ref: '§8.2.4 / T75',
        vars: ['x : BOOL', 'q : BOOL'],
        rungs: [rung([contact('Edge', 'x', subType), coil('Q', 'q')], [rail('Edge'), wire('Edge', 'Q')])],
        steps: [
            { expect: { q: false } },
            { set: { x: true }, expect: { q: subType === 'Rising' } },
            { expect: { q: false } },
            { set: { x: false }, expect: { q: subType === 'Falling' } },
            { expect: { q: false } },
        ],
    })),
    ...['Rising', 'Falling'].map(subType => ({
        name: `LD ${subType} coil pulses for one scan`,
        ref: '§8.2.5 / T76',
        vars: ['x : BOOL', 'q : BOOL'],
        rungs: [rung([contact('X', 'x'), coil('EdgeQ', 'q', subType)], [rail('X'), wire('X', 'EdgeQ')])],
        steps: [
            { expect: { q: false } },
            { set: { x: true }, expect: { q: subType === 'Rising' } },
            { expect: { q: false } },
            { set: { x: false }, expect: { q: subType === 'Falling' } },
            { expect: { q: false } },
        ],
    })),
    {
        name: 'LD contact changes while upstream power is off do not create a late edge',
        ref: 'T75 / Standards/iec61131-3.md §16.7 (edge memory updated every scan)',
        vars: ['permit : BOOL', 'x : BOOL', 'q : BOOL'],
        rungs: [rung([contact('Permit', 'permit'), contact('Edge', 'x', 'Rising'), coil('Q', 'q')], [rail('Permit'), wire('Permit', 'Edge'), wire('Edge', 'Q')])],
        steps: [
            { set: { x: true }, expect: { q: false } },
            { set: { permit: true }, expect: { q: false } },
            { set: { x: false }, expect: { q: false } },
            { set: { x: true }, expect: { q: true } },
        ],
    },
    {
        name: 'LD normal coil on the next rung observes the previous rung write',
        ref: '§8.2.7',
        vars: ['a : BOOL', 'middle : BOOL', 'q : BOOL'],
        rungs: [
            rung([contact('A', 'a'), coil('Middle', 'middle')], [rail('A'), wire('A', 'Middle')]),
            rung([contact('ReadMiddle', 'middle'), coil('Q', 'q')], [rail('ReadMiddle'), wire('ReadMiddle', 'Q')]),
        ],
        steps: [true, false, true].map(a => ({ set: { a }, expect: { middle: a, q: a } })),
    },
    {
        name: 'LD REAL math data wire preserves fractions and producer order',
        ref: '§8.1.5 / T29',
        vars: ['a : REAL := 1.25', 'b : REAL := 2.5', 'sum : REAL', 'result : REAL'],
        rungs: [rung([
            block('Multiply', 'MUL', { IN2: '2.0', OUT: 'result' }),
            block('Add', 'ADD', { IN1: 'a', IN2: 'b', OUT: 'sum' }),
        ], [wire('Add', 'Multiply', 'out_OUT', 'in_IN1')])],
        expect: { sum: 3.75, result: 7.5 },
    },
    {
        name: 'LD inline BNOT output wire is the value computed before OUT overwrites IN',
        ref: '§8.1.5',
        vars: ['x : DWORD := 1', 'y : DWORD', 'z : DWORD'],
        rungs: [rung([
            block('Invert', 'BNOT', { IN: 'x', OUT: 'x' }),
            block('CopyY', 'MOVE', { OUT: 'y' }), block('CopyZ', 'MOVE', { OUT: 'z' }),
        ], [wire('Invert', 'CopyY', 'out_OUT', 'in_IN'), wire('Invert', 'CopyZ', 'out_OUT', 'in_IN')])],
        expect: { x: 4294967294, y: 4294967294, z: 4294967294 },
    },
    {
        name: 'LD rejects a contact with no left power connection',
        ref: '§8.2.3 / Kron validation', vars: ['x : BOOL'],
        rungs: [rung([contact('X', 'x')], [])], error: /not connected.*power rail/i,
    },
    {
        name: 'LD rejects a coil with no left power connection',
        ref: '§8.2.3 / Kron validation', vars: ['q : BOOL'],
        rungs: [rung([coil('Q', 'q')], [])], error: /not connected.*power rail/i,
    },
    {
        name: 'LD rejects an explicit wiring cycle',
        ref: '§8.1.5.2', vars: ['a : BOOL', 'b : BOOL'],
        rungs: [rung([contact('A', 'a'), contact('B', 'b')], [rail('A'), wire('A', 'B'), wire('B', 'A')])],
        error: /wiring.*loop|cycle/i,
    },
    {
        name: 'LD rejects a timer with neither a wired nor a literal IN',
        ref: '§8.2.6 / Kron validation', vars: ['timer : TON'],
        rungs: [rung([block('timer', 'TON', { PT: 'T#10ms' })], [])],
        error: /IN.*neither wired nor given/i,
    },
];
