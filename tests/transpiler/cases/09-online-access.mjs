// Ladder data flow and online writes through the write mailbox.
//
// `rungs` makes Main an LD program (same objects as the editor's rung model);
// a step's `write` posts a mailbox command and expects `write:<name>` = the
// runtime's status (2 applied, 5 read-only) — see harness.mjs.

const ST_APPLIED = 2;
const ST_READ_ONLY = 5;

export default [
    {
        name: 'LD: a wired inline result is the value the block computed, not a re-evaluation',
        ref: '§8.1.5.2 (a link carries the value of the output it starts from)',
        // BNOT writes its own operand: re-evaluating `~x` at the consumer used
        // to hand MOVE the complement of the NEW x (y = 1).
        vars: ['x : DWORD := 1', 'y : DWORD'],
        rungs: [{
            id: 'r1', lang: 'LD',
            blocks: [
                { id: 'b1', type: 'BNOT', data: { instanceName: 'BNOT0', values: { IN: 'x', OUT: 'x' } } },
                { id: 'b2', type: 'MOVE', data: { instanceName: 'MOVE0', values: { OUT: 'y' } } },
            ],
            connections: [{ id: 'c1', source: 'b1', sourcePin: 'out_OUT', target: 'b2', targetPin: 'in_IN' }],
        }],
        expect: { x: 4294967294, y: 4294967294 },
    },
    {
        name: 'LD: a wired comparison result is computed once',
        ref: '§8.1.5.2',
        // GT's Q is written into `a`, its own operand; the AND-like consumer
        // (SEL) must see the comparison of the OLD a.
        vars: ['a : DINT := 5', 'r : DINT'],
        rungs: [{
            id: 'r1', lang: 'LD',
            blocks: [
                { id: 'b1', type: 'GT', data: { instanceName: 'GT0', values: { IN1: 'a', IN2: '3', Q: 'a' } } },
                { id: 'b2', type: 'SEL', data: { instanceName: 'SEL0', values: { IN0: '10', IN1: '20', OUT: 'r' } } },
            ],
            connections: [{ id: 'c1', source: 'b1', sourcePin: 'out_Q', target: 'b2', targetPin: 'in_G' }],
        }],
        expect: { a: 1, r: 20 },
    },
    {
        name: 'a CONSTANT refuses an online write, a variable takes it',
        ref: '§6.5.2.2 (modifying a CONSTANT is an error)',
        vars: ['CONST limit : DINT := 10', 'v : DINT := 0', 'r : DINT'],
        code: 'r := limit + v;',
        steps: [{ write: { limit: 99, v: 5 }, scans: 1, expect: { 'write:limit': ST_READ_ONLY, 'write:v': ST_APPLIED, r: 15 } }],
    },
    {
        name: 'a global CONSTANT refuses an online write',
        ref: '§6.5.2.2',
        globals: ['CONST g : INT := 3'],
        vars: ['r : INT'],
        code: 'r := g;',
        steps: [{ write: { g: 7 }, scans: 1, expect: { 'write:g': ST_READ_ONLY, r: 3 } }],
    },
];
