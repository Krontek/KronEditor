// node --test tests/transpiler/   (or: npm run test:transpiler)
//
// See harness.mjs for the pipeline and README.md for the case format.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transpileCase, compileAndRun, checkRun, toolchain, cleanup, validateCase } from './harness.mjs';

const CASE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cases');
const files = fs.readdirSync(CASE_DIR).filter(f => f.endsWith('.mjs')).sort();
const suites = await Promise.all(files.map(async f => [f.replace(/\.mjs$/, ''), (await import(pathToFileURL(path.join(CASE_DIR, f)).href)).default]));

// Optional filter: KRON_TEST_GREP='MOD' runs only cases whose name matches.
const grep = process.env.KRON_TEST_GREP ? new RegExp(process.env.KRON_TEST_GREP, 'i') : null;
const OPT_LEVELS = (process.env.KRON_TEST_OPT || 'O0,O2').split(',').map(s => s.trim());
assert.ok(OPT_LEVELS.every(s => /^O[0123s]$/.test(s)), 'KRON_TEST_OPT must contain O0/O1/O2/O3/Os');
const concurrency = Number(process.env.KRON_TEST_JOBS || Math.min(4, os.availableParallelism()));
assert.ok(Number.isSafeInteger(concurrency) && concurrency > 0, 'KRON_TEST_JOBS must be a positive integer');

after(cleanup);

const tc = toolchain();
if (tc.missing) console.log(`[transpiler-test] RUN-TIME CASES SKIPPED: ${tc.missing}`);

const label = (c) => (c.ref ? `${c.name}  [${c.ref}]` : c.name);

for (const [suiteName, cases] of suites) {
    describe(suiteName, { concurrency }, () => {
        const seen = new Set();
        for (const c of cases) {
            assert.ok(!seen.has(c.name), `duplicate case name "${c.name}" in ${suiteName}`);
            seen.add(c.name);
            validateCase(c);
            if (grep && !grep.test(c.name)) continue;
            const opts = c.todo ? { todo: c.todo } : {};

            if (c.error) {
                // A program the standard (or a documented Kron decision) rejects:
                // the transpiler must THROW, with a message naming the problem.
                test(label(c), opts, async () => {
                    let out;
                    try { out = await transpileCase(c); } catch (e) {
                        assert.match(e.message, c.error, `rejected, but with an unexpected message:\n${e.message}`);
                        return;
                    }
                    assert.fail(`expected a transpile error matching ${c.error}, but it transpiled (${out.source.length} bytes of C)`);
                });
                continue;
            }

            test(label(c), { ...opts, skip: tc.missing ? tc.missing : false }, async () => {
                let out;
                try { out = await transpileCase(c); } catch (e) {
                    assert.fail(`transpile failed:\n${e.message}`);
                }
                const failures = [];
                for (const opt of OPT_LEVELS) {
                    try {
                        const run = await compileAndRun(c, out, opt);
                        const errs = checkRun(c, run);
                        if (errs.length) failures.push(`-${opt}: ${errs.join('\n       ')}` +
                            (run.stderr ? `\n  runtime stderr:\n${run.stderr}` : '') + `\n  C in ${run.dir}`);
                    } catch (e) {
                        failures.push(`-${opt}: ${e.message}`);
                    }
                }
                assert.equal(failures.length, 0, failures.join('\n'));
            });
        }
    });
}
