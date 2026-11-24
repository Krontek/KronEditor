// ST/LD transpiler behaviour harness.
//
// One case = one tiny project: a PROGRAM `Main` with ST `code` or LD `rungs`.
// The harness runs the REAL compile path end to end:
//
//   CTranspilerService.transpileToC  (bundled with esbuild, exactly what the
//        │                            browser runs)
//        ▼
//   plc.h + plc.c  ──►  bundled clang (-DPLC_HOTSWAP, -fwrapv, the real
//        │              krontek headers + libkron*.a archives)
//        ▼
//   a test driver that #includes plc.c, runs N scans with a DETERMINISTIC
//   us_tick, and prints the requested PlcState fields
//        ▼
//   the printed values are compared with the case's `expect`.
//
// Every case is built twice (-O0 like the sim and -O2 like the hot-swap
// module) and both must agree with the expectation. Differences can expose
// undefined behaviour; agreement alone does not prove its absence.
//
// The C is never compared textually — only what it DOES. A refactor that
// emits different-but-equivalent C keeps passing; a change of meaning fails.

import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INCLUDE = path.join(REPO, 'resources', 'krontek-include');
const HOST_TRIPLE = 'x86_64-linux-gnu';
const LIB_DIR = path.join(REPO, 'resources', HOST_TRIPLE, 'lib');
const TOOLCHAINS = path.join(REPO, 'toolchains');

// ── Transpiler bundle ───────────────────────────────────────────────────────

let transpilerPromise = null;
let workRoot = null;

export const workDir = () => {
    if (!workRoot) workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kron-st-test-'));
    return workRoot;
};

export const cleanup = () => {
    if (workRoot && !process.env.KRON_TEST_KEEP) fs.rmSync(workRoot, { recursive: true, force: true });
    else if (workRoot) console.log(`[transpiler-test] artefacts kept in ${workRoot}`);
};

export const loadTranspiler = () => {
    if (!transpilerPromise) {
        transpilerPromise = (async () => {
            const out = path.join(workDir(), 'transpiler.mjs');
            await build({
                entryPoints: [path.join(REPO, 'src', 'services', 'CTranspilerService.js')],
                bundle: true, platform: 'node', format: 'esm',
                loader: { '.tpl': 'text' }, outfile: out, logLevel: 'silent',
            });
            return import(pathToFileURL(out).href);
        })();
    }
    return transpilerPromise;
};

// ── Standard headers (what the host agent's /standard-headers serves) ───────

const HAL_IMPL = new Set(['kronhal_rpi.h', 'kronhal_bb.h', 'kronhal_jetson.h', 'kronhal_sim.h']);
let headerCache = null;
export const standardHeaders = () => {
    if (headerCache) return headerCache;
    const list = [];
    const scan = (dir, prefix) => {
        if (!fs.existsSync(dir)) return;
        for (const f of fs.readdirSync(dir).sort()) {
            if (!f.startsWith('kron') || !f.endsWith('.h') || HAL_IMPL.has(f)) continue;
            list.push([prefix + f, fs.readFileSync(path.join(dir, f), 'utf8')]);
        }
    };
    scan(INCLUDE, '');
    scan(path.join(INCLUDE, 'HAL'), 'HAL/');
    headerCache = list;
    return list;
};

// ── Toolchain discovery ─────────────────────────────────────────────────────

// Returns { clang, args } or { missing: '<why>' }. Missing pieces SKIP the
// run-time half of the suite visibly — they never make it pass.
let toolchainCache = null;
export const toolchain = () => {
    if (toolchainCache) return toolchainCache;
    if (process.platform !== 'linux' || process.arch !== 'x64') {
        return (toolchainCache = { missing: `run-time cases need a linux/x64 host (this is ${process.platform}/${process.arch})` });
    }
    const clang = process.env.KRON_CLANG || path.join(TOOLCHAINS, 'bin', 'clang');
    if (!fs.existsSync(clang)) return (toolchainCache = { missing: `bundled clang not found at ${clang} (python setup_toolchain.py, or set KRON_CLANG)` });
    if (!fs.existsSync(LIB_DIR)) return (toolchainCache = { missing: `static archives not found at ${LIB_DIR}` });
    const args = [`--target=${HOST_TRIPLE}`];
    const resBase = path.join(TOOLCHAINS, 'lib', 'clang');
    if (!process.env.KRON_CLANG && fs.existsSync(resBase)) {
        const v = fs.readdirSync(resBase).filter(d => fs.statSync(path.join(resBase, d)).isDirectory()).sort();
        if (v.length) args.push('-resource-dir', path.join(resBase, v[v.length - 1]));
    }
    args.push(
        '-DPLC_HOTSWAP', '-DKRON_EC_SIM',
        '-I', INCLUDE, '-I', path.join(INCLUDE, 'HAL'),
        '-I', path.join(TOOLCHAINS, 'sysroots', 'simulation_env', 'include'),
        // host-agent/compile.go plcSemanticsFlags — part of what plc.c MEANS.
        '-fwrapv',
        '-fuse-ld=lld',
    );
    const archives = fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.a')).sort().map(f => path.join(LIB_DIR, f));
    const link = ['-Wl,--start-group', ...archives, '-Wl,--end-group', '-lm', '-lpthread', '-lrt'];
    return (toolchainCache = { clang, args, link });
};

// ── Case → project ──────────────────────────────────────────────────────────

const CLASS_PREFIX = {
    IN: 'Input', OUT: 'Output', INOUT: 'InOut', TEMP: 'Temp',
    CONST: 'Constant', CONSTANT: 'Constant', RETAIN: 'Retain', LOCAL: 'Local',
};

// 'a : INT := -7', 'CONST k : INT := 3', 'IN x : REAL' → variable row.
export const parseDecl = (s, defaultClass = 'Local') => {
    const m = String(s).trim().match(/^(?:([A-Za-z]+)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)(?:\s*:=\s*([\s\S]+))?$/);
    if (!m) throw new Error(`test case: cannot parse declaration "${s}"`);
    let [, cls, name, type, init] = m;
    if (cls && !CLASS_PREFIX[cls.toUpperCase()]) {
        // no class keyword — the first word was the name
        throw new Error(`test case: unknown variable class "${cls}" in "${s}"`);
    }
    return { name, type: type.trim(), class: cls ? CLASS_PREFIX[cls.toUpperCase()] : defaultClass, initialValue: init?.trim() ?? '' };
};

const pou = (p) => {
    return {
        name: p.name,
        type: p.rungs ? 'LD' : (p.lang || 'ST'),
        ...(p.returnType ? { returnType: p.returnType } : {}),
        content: {
            variables: (p.vars || []).map(v => parseDecl(v)), code: p.code || '',
            ...(p.rungs ? { rungs: p.rungs } : {}),
        },
    };
};

export const projectFor = (c) => ({
    resources: [{ id: 'res_config', content: { globalVars: (c.globals || []).map(v => parseDecl(v, 'Var')) } }],
    dataTypes: c.dataTypes || [],
    functions: (c.functions || []).map(pou),
    functionBlocks: (c.functionBlocks || []).map(pou),
    programs: [pou({ name: 'Main', vars: c.vars, code: c.code, rungs: c.rungs })],
    ...(c.taskConfig ? { taskConfig: c.taskConfig } : {}),
});

export const transpileCase = async (c) => {
    const { transpileToC } = await loadTranspiler();
    return transpileToC(projectFor(c), standardHeaders(), null, true, [], {});
};

// ── Driver generation ───────────────────────────────────────────────────────

const steps = (c) => c.steps || [{
    set: c.set, write: c.write, scans: c.scans, expect: c.expect,
    expectStopped: c.expectStopped, expectScans: c.expectScans,
}];

// An empty or malformed fixture must not silently become a passing test.
export const validateCase = (c) => {
    const hasExpectation = st => Object.keys(st.expect || {}).length || st.expectStopped !== undefined || st.expectScans !== undefined;
    if (c.error) {
        if (!(c.error instanceof RegExp)) throw new Error('test case: error must be a RegExp');
        if (steps(c).some(hasExpectation)) throw new Error('test case: rejection and run-time expectations cannot be combined');
        return;
    }
    if (!steps(c).some(hasExpectation)) throw new Error('test case: at least one run-time expectation is required');
    if (!Number.isSafeInteger(c.cycleUs ?? 10000) || (c.cycleUs ?? 10000) <= 0) throw new Error('test case: cycleUs must be a positive safe integer');
    for (const st of steps(c)) {
        if (!Number.isSafeInteger(st.scans ?? 1) || (st.scans ?? 1) < 0) throw new Error('test case: scans must be a non-negative safe integer');
        if (st.expectStopped !== undefined && typeof st.expectStopped !== 'boolean') throw new Error('test case: expectStopped must be boolean');
        if (st.expectScans !== undefined && (!Number.isSafeInteger(st.expectScans) || st.expectScans < 0)) throw new Error('test case: expectScans must be a non-negative safe integer');
    }
};

// IEC path ('arr[2]', 's.x', 't.Q', '__rte_count') → C lvalue on PlcState.
const cPath = (key, vt) => {
    const m = key.match(/^([A-Za-z_][A-Za-z0-9_]*)(.*)$/);
    if (!m) throw new Error(`test case: bad expectation key "${key}"`);
    const [, root, rest] = m;
    const find = (vars) => vars && Object.entries(vars).find(([n]) => n.toLowerCase() === root.toLowerCase());
    const local = find(vt.programs?.Main?.variables);
    if (local) return `S->${local[1].c_symbol}${rest}`;
    const g = find(vt.globalVars);
    if (g) return `S->${g[1].c_symbol || g[0]}${rest}`;
    if (root.startsWith('__')) return `S->${key}`;
    throw new Error(`test case: "${root}" is not a variable of Main (nor a global)`);
};

export const cLiteral = (v) => {
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (typeof v === 'bigint') {
        if (v < -(1n << 63n) || v >= (1n << 64n)) throw new Error('test case: integer is outside the 64-bit range');
        if (v === -(1n << 63n)) return '(-9223372036854775807LL - 1LL)';
        return `${v}${v >= (1n << 63n) ? 'ULL' : 'LL'}`;
    }
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw new Error('test case: set needs a finite number');
        if (Number.isInteger(v) && !Number.isSafeInteger(v)) throw new Error('test case: use bigint for an exact 64-bit integer');
        return Number.isInteger(v) ? `${v}LL` : `${v}`;
    }
    throw new Error(`test case: cannot set a ${typeof v} (only numbers / booleans)`);
};

const DRIVER_PRELUDE = `
#include "plc.c"
uint8_t *__plc_shm = 0;
volatile int plc_stop = 0;
volatile uint64_t us_tick = 0;

static void kt_u(const char *k, unsigned long long v) { printf("@KRON_TEST\\t%s\\tu\\t%llu\\n", k, v); }
static void kt_i(const char *k, long long v) { printf("@KRON_TEST\\t%s\\ti\\t%lld\\n", k, v); }
static void kt_f(const char *k, double v) { printf("@KRON_TEST\\t%s\\tf\\t%.17g\\n", k, v); }
static void kt_s(const char *k, const char *v) {
    printf("@KRON_TEST\\t%s\\ts\\t", k);
    for (const unsigned char *p = (const unsigned char *)v; *p; p++) printf("%02x", *p);
    printf("\\n");
}
#define KT_OUT(k, x) _Generic((x), \\
    _Bool: kt_u, unsigned char: kt_u, unsigned short: kt_u, unsigned int: kt_u, \\
    unsigned long: kt_u, unsigned long long: kt_u, \\
    signed char: kt_i, char: kt_i, short: kt_i, int: kt_i, long: kt_i, long long: kt_i, \\
    float: kt_f, double: kt_f, \\
    char *: kt_s, const char *: kt_s)(k, x)
`;

// A step's `write: { name: value }` posts ONE write-mailbox command the way
// KronServer / the host agent would (entry layout: server/RING_FORMAT.md
// § Variable segment) and applies it with the runtime's own plc_mb_apply; the
// returned status is printed as `write:<name>` (2 applied, 5 read-only, …).
const mbIndexOf = (name, vt) => {
    const want = [`prog_main_${name}`, `prog__${name}`].map(k => k.toLowerCase());
    const hit = Object.entries(vt.debugDefaults || {}).find(([k]) => want.includes(k.toLowerCase()));
    if (!hit || hit[1].mb_index === undefined) throw new Error(`test case: "${name}" has no write-mailbox slot`);
    return hit[1].mb_index;
};

export const driverSource = (c, vt) => {
    const cycle = c.cycleUs ?? 10000;
    const lines = [DRIVER_PRELUDE, 'static uint8_t __kt_shm[65536];', 'int main(void) {', '    plc_init_hs();', '    unsigned long long scan = 0;'];
    steps(c).forEach((st, i) => {
        for (const [k, v] of Object.entries(st.set || {})) lines.push(`    ${cPath(k, vt)} = ${cLiteral(v)};`);
        for (const [k, v] of Object.entries(st.write || {})) {
            lines.push(`    { uint8_t e[32] = {0}; uint32_t idx = ${mbIndexOf(k, vt)}u; memcpy(e + 8, &idx, 4); e[16] = 2;`,
                `      __typeof__(${cPath(k, vt)}) v = ${cLiteral(v)}; e[17] = (uint8_t)sizeof v; memcpy(e + 24, &v, sizeof v);`,
                `      __plc_shm = __kt_shm; KT_OUT("${i}:write:${k}", (unsigned)plc_mb_apply(e)); __plc_shm = 0; }`);
        }
        // Finish the faulting scan, but do not start another after a STOP.
        lines.push(`    for (unsigned long long n = 0; n < ${st.scans ?? 1}ULL && !plc_stop; n++) { us_tick = 1000000ULL + scan++ * ${cycle}ULL; plc_task_body_0(); }`);
        for (const k of Object.keys(st.expect || {})) {
            if (!k.startsWith('write:')) lines.push(`    KT_OUT("${i}:${k}", ${cPath(k, vt)});`);
        }
        if (st.expectStopped !== undefined) lines.push(`    KT_OUT("${i}:$stopped", (_Bool)(plc_stop != 0));`);
        if (st.expectScans !== undefined) lines.push(`    KT_OUT("${i}:$scans", scan);`);
    });
    lines.push('    plc_cleanup_hs();', '    return 0;', '}', '');
    return lines.join('\n');
};

// ── Compile + run ───────────────────────────────────────────────────────────

let seq = 0;
export const compileAndRun = async (c, out, opt) => {
    const tc = toolchain();
    const dir = path.join(workDir(), `case_${++seq}_${opt}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plc.h'), out.header);
    fs.writeFileSync(path.join(dir, 'plc.c'), out.source);
    fs.writeFileSync(path.join(dir, 'driver.c'), driverSource(c, out.variableTable));
    const exe = path.join(dir, 'driver');
    try {
        await execFileP(tc.clang, [...tc.args, `-${opt}`, '-I', dir, '-o', exe, path.join(dir, 'driver.c'), ...tc.link],
            { timeout: 60000, maxBuffer: 16 << 20 });
    } catch (e) {
        throw new Error(`clang -${opt} failed (C in ${dir}):\n${(e.stderr || e.message).slice(0, 4000)}`);
    }
    let run;
    try {
        // Relative runtime files (e.g. retain.dat) belong to this case only.
        run = await execFileP(exe, [], { cwd: dir, timeout: 10000, maxBuffer: 16 << 20 });
    } catch (e) {
        throw new Error(`driver -${opt} crashed/timed out (${e.signal || e.code}) (C in ${dir}):\n${e.stderr || ''}`);
    }
    const values = parseRunOutput(run.stdout);
    return { values, stderr: run.stderr, dir };
};

export const parseRunOutput = (stdout) => {
    const values = {};
    for (const line of stdout.split('\n')) {
        if (!line.startsWith('@KRON_TEST\t')) continue; // unrelated library diagnostics
        const [, k, t, v, extra] = line.split('\t');
        if (!k || v === undefined || extra !== undefined || !['i', 'u', 'f', 's'].includes(t)) throw new Error(`invalid test output: ${line}`);
        if (Object.hasOwn(values, k)) throw new Error(`duplicate test output: ${k}`);
        if (t === 's') {
            if (!/^(?:[0-9a-f]{2})*$/i.test(v)) throw new Error(`invalid string bytes: ${line}`);
            values[k] = { t, v: Buffer.from(v, 'hex').toString('utf8') };
        } else if (t === 'f') {
            const special = { inf: Infinity, '-inf': -Infinity, nan: NaN, '-nan': NaN };
            const n = Object.hasOwn(special, v) ? special[v] : Number(v);
            if (!Object.hasOwn(special, v) && (!v.trim() || !Number.isFinite(n))) throw new Error(`invalid real output: ${line}`);
            values[k] = { t, v: n };
        } else {
            if (!/^-?\d+$/.test(v) || (t === 'u' && v.startsWith('-'))) throw new Error(`invalid integer output: ${line}`);
            values[k] = { t, v: BigInt(v) };
        }
    }
    return values;
};

// ── Comparison ──────────────────────────────────────────────────────────────

const show = (a) => (a === undefined ? '<not printed>' : a.t === 's' ? JSON.stringify(a.v) : String(a.v));

// Returns null when equal, else a message.
export const compareValue = (key, expected, actual, tol) => {
    if (!actual) return `${key}: not printed`;
    if (typeof expected === 'string') {
        return actual.t === 's' && actual.v === expected ? null : `${key}: expected ${JSON.stringify(expected)}, got ${show(actual)}`;
    }
    if (typeof expected === 'boolean') {
        const ok = actual.t !== 's' && actual.t !== 'f' && actual.v === (expected ? 1n : 0n);
        return ok ? null : `${key}: expected ${expected}, got ${show(actual)}`;
    }
    if (typeof expected === 'bigint' || (typeof expected === 'number' && Number.isInteger(expected) && actual.t !== 'f')) {
        if (typeof expected === 'number' && !Number.isSafeInteger(expected)) throw new Error('test case: use bigint for an exact integer expectation');
        if (actual.t === 's' || actual.t === 'f') return `${key}: expected integer ${expected}, got ${actual.t === 'f' ? 'REAL ' : ''}${show(actual)}`;
        return actual.v === BigInt(expected) ? null : `${key}: expected ${expected}, got ${show(actual)}`;
    }
    if (typeof expected === 'number') {
        if (actual.t === 's') return `${key}: expected ${expected}, got ${show(actual)}`;
        const a = Number(actual.v);
        if (!Number.isFinite(expected)) return Object.is(a, expected) ? null : `${key}: expected ${expected}, got ${a}`;
        const t = tol ?? Math.max(1e-6, Math.abs(expected) * 1e-6);
        if (!Number.isFinite(t) || t < 0) throw new Error('test case: tolerance must be finite and non-negative');
        if (!Number.isFinite(a)) return `${key}: expected ${expected}, got ${a}`;
        return Math.abs(a - expected) <= t ? null : `${key}: expected ${expected} (±${t}), got ${a}`;
    }
    throw new Error(`test case: unsupported expectation for ${key}`);
};

export const checkRun = (c, run) => {
    const errs = [];
    steps(c).forEach((st, i) => {
        for (const [k, exp] of Object.entries(st.expect || {})) {
            const e = compareValue(steps(c).length > 1 ? `step ${i} ${k}` : k, exp, run.values[`${i}:${k}`], c.tol);
            if (e) errs.push(e);
        }
        for (const [field, key] of [['expectStopped', '$stopped'], ['expectScans', '$scans']]) {
            if (st[field] === undefined) continue;
            const e = compareValue(`step ${i} ${field}`, st[field], run.values[`${i}:${key}`], 0);
            if (e) errs.push(e);
        }
    });
    return errs;
};
