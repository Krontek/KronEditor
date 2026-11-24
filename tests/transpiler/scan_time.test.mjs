// Scan-start time snapshot under cross-thread interference.
//
// Every task thread used to store its clock reading into the ONE global
// us_tick that all timers read, so a timer saw whichever thread wrote last —
// and a stale store made TP_Call re-anchor and cut a pulse short (seen as ESC
// jitter on a 20 µs bit-bang task). Timers now read the per-thread snapshot
// that plc_task_body_ts_<i>(now) sets (plc.h __kron_scan_us).
//
// This test runs the ESC pattern — a TP triggered for one scan every 1000
// scans on a 20 µs grid — through plc_task_body_ts_0 while a second thread
// hammers us_tick with random values. Every pulse must last exactly the same
// number of scans.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transpileCase, toolchain, workDir, cleanup } from './harness.mjs';

const execFileP = promisify(execFile);
after(cleanup);
const tc = toolchain();

const CASE = {
    vars: ['n : DINT', 'start : BOOL', 'tp : TP', 'q : BOOL'],
    code: 'start := (n MOD 1000) = 0;\nn := n + 1;\ntp(IN := start, PT := T#1490us);\nq := tp.Q;',
};

test('timers ignore a concurrently written us_tick (scan-start snapshot)', { skip: tc.missing || false }, async () => {
    const out = await transpileCase(CASE);
    const v = out.variableTable.programs.Main.variables;
    const q = `S->${v.q.c_symbol}`;
    const dir = path.join(workDir(), 'scan_time');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plc.h'), out.header);
    fs.writeFileSync(path.join(dir, 'plc.c'), out.source);
    fs.writeFileSync(path.join(dir, 'driver.c'), `
#include "plc.c"
#include <pthread.h>
#include <stdatomic.h>
#include <sched.h>
#include <stdio.h>
uint8_t *__plc_shm = 0;
volatile int plc_stop = 0;
volatile uint64_t us_tick = 0;
static atomic_int __noise_stop = 0;
static atomic_int __noise_ready = 0;
static void *noise(void *a) {          /* another "task" storing its own times */
    (void)a; uint64_t x = 88172645463325252ULL;
    us_tick = x;
    atomic_store(&__noise_ready, 1);
    while (!atomic_load(&__noise_stop)) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; us_tick = x >> 24; }
    return 0;
}
int main(void) {
    plc_init_hs();
    pthread_t th;
    if (pthread_create(&th, 0, noise, 0) != 0) return 2;
    while (!atomic_load(&__noise_ready)) sched_yield();
    int width = 0, prev = 0, minw = 1 << 30, maxw = 0, pulses = 0;
    for (long k = 0; k < 200L * 1000; k++) {
        plc_task_body_ts_0(1000000000000ULL + (uint64_t)k * 20ULL);
        int qq = ${q} ? 1 : 0;
        if (qq) width++;
        if (prev && !qq) { if (width < minw) minw = width; if (width > maxw) maxw = width; pulses++; width = 0; }
        prev = qq;
    }
    atomic_store(&__noise_stop, 1);
    if (pthread_join(th, 0) != 0) return 3;
    printf("%d %d %d\\n", pulses, minw, maxw);
    plc_cleanup_hs();
    return 0;
}
`);
    const exe = path.join(dir, 'driver');
    await execFileP(tc.clang, [...tc.args, '-O2', '-I', dir, '-o', exe, path.join(dir, 'driver.c'), ...tc.link], { timeout: 60000, maxBuffer: 16 << 20 });
    const { stdout } = await execFileP(exe, [], { cwd: dir, timeout: 10000 });
    const [pulses, minw, maxw] = stdout.trim().split(' ').map(Number);
    assert.equal(pulses, 200, `expected 200 pulses, got ${pulses}`);
    // PT 1490 µs on a 20 µs grid: Q holds for 75 scans (ET reaches 1500 µs on the 75th).
    assert.equal(minw, 75, `shortest pulse ${minw} scans (want 75) — a timer read another thread's time`);
    assert.equal(maxw, 75, `longest pulse ${maxw} scans (want 75) — a timer read another thread's time`);
});
