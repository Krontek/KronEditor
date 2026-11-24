// The test oracle must not turn a bad runtime result into a passing test.
// These checks run without clang, headers or static archives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareValue, parseRunOutput, checkRun, cLiteral, validateCase } from './harness.mjs';

const real = v => ({ t: 'f', v });
const integer = v => ({ t: 'i', v: BigInt(v) });

test('finite values and opposite infinity do not satisfy an infinity expectation', () => {
    for (const expected of [Infinity, -Infinity]) {
        assert.equal(compareValue('x', expected, real(expected)), null);
        for (const actual of [0, 123, -expected, NaN]) {
            assert.notEqual(compareValue('x', expected, real(actual)), null);
        }
    }
});

test('NaN matches only NaN; non-finite results fail finite expectations', () => {
    assert.equal(compareValue('x', NaN, real(NaN)), null);
    for (const actual of [0, Infinity, -Infinity]) assert.notEqual(compareValue('x', NaN, real(actual)), null);
    for (const actual of [NaN, Infinity, -Infinity]) assert.notEqual(compareValue('x', 1.5, real(actual)), null);
});

test('zero tolerance is exact and invalid tolerances are rejected', () => {
    assert.equal(compareValue('x', 1.5, real(1.5), 0), null);
    assert.notEqual(compareValue('x', 1.5, real(1.50000001), 0), null);
    assert.equal(compareValue('x', 1.5, real(1.501), 0.01), null);
    for (const tol of [-1, NaN, Infinity]) assert.throws(() => compareValue('x', 1.5, real(1.5), tol), /tolerance/);
});

test('64-bit integer comparison preserves a one-bit difference above 2^53', () => {
    const expected = 18446744073709551615n;
    assert.equal(compareValue('x', expected, { t: 'u', v: expected }), null);
    assert.notEqual(compareValue('x', expected, { t: 'u', v: expected - 1n }), null);
    assert.notEqual(compareValue('x', expected, real(Number(expected))), null);
    assert.throws(() => compareValue('x', Number(expected), integer(expected)), /bigint/);
});

test('missing values and wrong output types fail', () => {
    assert.notEqual(compareValue('x', 0, undefined), null);
    assert.notEqual(compareValue('x', true, real(1)), null);
    assert.notEqual(compareValue('x', true, integer(2)), null);
    assert.notEqual(compareValue('x', '1', integer(1)), null);
});

test('output decoding separates runtime diagnostics and preserves integer precision', () => {
    const values = parseRunOutput('library\tdiagnostic\tignored\n@KRON_TEST\t0:x\tu\t18446744073709551615\n');
    assert.deepEqual(values, { '0:x': { t: 'u', v: 18446744073709551615n } });
});

test('output decoding handles C non-finite spellings and UTF-8 strings', () => {
    const text = 'Türkçe: çığ, şüphe 🟢';
    const values = parseRunOutput([
        '@KRON_TEST\t0:p\tf\tinf', '@KRON_TEST\t0:n\tf\t-inf',
        '@KRON_TEST\t0:q\tf\tnan', '@KRON_TEST\t0:r\tf\t-nan',
        `@KRON_TEST\t0:s\ts\t${Buffer.from(text).toString('hex')}`, '@KRON_TEST\t0:empty\ts\t',
    ].join('\n'));
    assert.equal(values['0:p'].v, Infinity);
    assert.equal(values['0:n'].v, -Infinity);
    assert.ok(Number.isNaN(values['0:q'].v));
    assert.ok(Number.isNaN(values['0:r'].v));
    assert.equal(values['0:s'].v, text);
    assert.equal(values['0:empty'].v, '');
});

test('malformed or duplicate test records fail instead of disappearing', () => {
    for (const record of ['0:x\tf\toops', '0:x\tf\t', '0:x\ti\t1.2', '0:x\tu\t-1', '0:x\ts\t0', '0:x\ts\tzz', '0:x\tz\t0']) {
        assert.throws(() => parseRunOutput(`@KRON_TEST\t${record}`), /invalid/);
    }
    assert.throws(() => parseRunOutput('@KRON_TEST\t0:x\ti\t1\n@KRON_TEST\t0:x\ti\t2'), /duplicate/);
});

test('fixture inputs reject already-rounded integers and non-finite values', () => {
    for (const v of [Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) assert.throws(() => cLiteral(v), /bigint|finite/);
    assert.throws(() => cLiteral(1n << 64n), /64-bit/);
    assert.throws(() => cLiteral(-(1n << 63n) - 1n), /64-bit/);
});

test('empty cases, invalid scan counts and conflicting assertions are rejected', () => {
    for (const c of [{}, { expect: {} }, { steps: [] }, { steps: [{ scans: 3 }] }]) assert.throws(() => validateCase(c), /expectation/);
    for (const scans of [-1, 0.5, NaN]) assert.throws(() => validateCase({ scans, expect: { x: 1 } }), /scans/);
    assert.throws(() => validateCase({ cycleUs: 0, expect: { x: 1 } }), /cycleUs/);
    assert.throws(() => validateCase({ error: /bad/, expect: { x: 1 } }), /combined/);
    assert.throws(() => validateCase({ expectStopped: 1 }), /boolean/);
    assert.doesNotThrow(() => validateCase({ steps: [{ scans: 0 }, { expectStopped: false, expectScans: 1 }] }));
    assert.doesNotThrow(() => validateCase({ error: /bad/ }));
});

test('STOP and executed scan count are mandatory when a case asks for them', () => {
    const c = { expectStopped: true, expectScans: 1 };
    assert.equal(checkRun(c, { values: {} }).length, 2);
    assert.equal(checkRun(c, { values: { '0:$stopped': integer(0), '0:$scans': integer(3) } }).length, 2);
    assert.deepEqual(checkRun(c, { values: { '0:$stopped': integer(1), '0:$scans': integer(1) } }), []);
});
