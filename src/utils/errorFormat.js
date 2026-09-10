/**
 * errorFormat.js — turns raw failures (compiler CombinedOutput dumps, wrapped
 * Go exec errors, plain thrown Errors) into short, human-readable, ONE-LINE
 * log entries, each tagged with the pipeline stage that failed.
 *
 * Why this exists: a clang/gcc failure reaches the frontend as either a
 * separate `.log` field (compile.go: {ok:false, error, log}) or embedded
 * INSIDE `err.message` itself (hotswap.go's compileHost/compileLogic do
 * `fmt.Errorf("...failed: %v\n%s", err, out)`, so `err.message` is the whole
 * multi-line clang dump). Either way the raw text mixes real diagnostics with
 * noise clang always prints alongside them: the source-line snippet, the
 * caret/underline marker, "N error(s) generated.", "In file included from…"
 * chains. The previous behavior split that raw text on '\n' and logged EVERY
 * line as its own error row — so a single real error produced 4-6 unreadable
 * rows and the one line that actually said what broke had no visual priority
 * over the noise around it. See CLAUDE.md §5 compile-gate notes and the
 * host-agent compile.go / hotswap.go comments this mirrors.
 */

// Categories shown as the leading word(s) of every formatted line. Keep these
// in sync with the actual pipeline stage that can throw into each catch site
// (App.jsx handleBuild / handleBuildAndSend / handleToggleSimulation /
// handleStartExecution / handleStopExecution / force-write / stream errors).
export const ERROR_CATEGORY = {
    TRANSPILE: 'Transpile',
    COMPILE: 'Compile',
    DEPLOY: 'Deploy',
    RUNTIME: 'Runtime',
};

// Wrapper prefixes the Go side adds that carry NO diagnostic information on
// their own ("exit status 1" never says what failed — the real reason is in
// the text that follows). Stripped before parsing so they don't get emitted
// as a fallback line ahead of the real error.
const GO_WRAPPER_PREFIX = /^(?:clang cross-compilation failed|clang simulation build failed|host build failed|logic module build failed|logic\.so install failed)\s*:\s*(?:exit status \d+)?\s*/i;

// One real compiler diagnostic: "<path>:<line>:<col>: error|warning|note: <msg>"
const DIAG_LINE = /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning|note)\s*:\s*(.*)$/;

// Lines that are pure noise around a diagnostic — never shown on their own.
const NOISE_LINE = [
    /^\s*$/,                                  // blank
    /^\s*\d+\s*\|/,                           // clang source-context snippet ("724 | ...")
    /^\s*\|[\s~^]*$/,                         // caret/underline marker line
    /^\d+\s+(?:error|warning)s?\s+generated\.?$/i, // boilerplate count — we compute our own
    /^In file included from\b/,               // #include chain trace
    /^(?:gnu)?make(?:\[\d+\])?\s*:/i,         // make recipe noise
    /^collect2\s*:/i,                         // ld driver noise (real reason is earlier)
];

const isNoiseLine = (line) => NOISE_LINE.some((re) => re.test(line));

const shortenPath = (p) => (p || '').split(/[\\/]/).pop() || p;

/**
 * Parse a raw compiler-output blob into real diagnostics.
 * @returns {{diagnostics: Array<{file:string, line:number, severity:string, message:string}>, fallback: string}}
 *   `fallback` is a best-effort single line to use when no diagnostic line
 *   could be matched at all (e.g. a linker error with no file:line:col, or a
 *   crash/signal with no textual diagnostic).
 */
export const parseCompilerLog = (raw) => {
    const text = String(raw || '').replace(GO_WRAPPER_PREFIX, '').trim();
    if (!text) return { diagnostics: [], fallback: '' };

    const diagnostics = [];
    let firstUsefulNoise = '';
    text.split('\n').forEach((line) => {
        const trimmed = line.trim();
        const m = trimmed.match(DIAG_LINE);
        if (m) {
            diagnostics.push({
                file: shortenPath(m[1]),
                line: Number(m[2]),
                severity: m[4].toLowerCase() === 'fatal error' ? 'error' : m[4].toLowerCase(),
                message: m[5].trim(),
            });
            return;
        }
        // A line that clearly names a real failure (ld/linker) but doesn't fit
        // the file:line:col shape — keep the FIRST one as a fallback candidate.
        if (!firstUsefulNoise && !isNoiseLine(trimmed) && /error|undefined reference|multiple definition|cannot find|no such file/i.test(trimmed)) {
            firstUsefulNoise = trimmed;
        }
    });

    return { diagnostics, fallback: firstUsefulNoise || text.split('\n').find((l) => l.trim() && !isNoiseLine(l.trim()))?.trim() || '' };
};

// Cap how many individual diagnostic lines we emit per failure — a project
// with a systemic error (e.g. a missing header) can produce dozens of
// downstream errors; past this point they stop being useful and just scroll
// the log, so the rest are collapsed into one "+N more" line instead.
const MAX_DIAGNOSTIC_LINES = 6;

/**
 * Build ready-to-log {type, msg} entries for a failed build/compile step.
 * @param {string} category - one of ERROR_CATEGORY
 * @param {Error}  err       - the caught error; `.log` (compile.go) or
 *                             `.message` (hotswap.go) may hold the raw
 *                             compiler output.
 */
export const formatCompileFailure = (category, err) => {
    const raw = (err && err.log && String(err.log).trim()) ? err.log : (err?.message || String(err));
    const { diagnostics, fallback } = parseCompilerLog(raw);

    if (diagnostics.length === 0) {
        const line = fallback || String(raw).trim().slice(0, 200) || 'build failed (no output)';
        return [{ type: 'error', msg: `${category} error: ${line}` }];
    }

    const shown = diagnostics.slice(0, MAX_DIAGNOSTIC_LINES);
    const entries = shown.map((d) => ({
        type: d.severity === 'warning' ? 'warning' : 'error',
        msg: `${category} ${d.severity}: ${d.message} (${d.file}:${d.line})`,
    }));
    const omitted = diagnostics.length - shown.length;
    if (omitted > 0) {
        entries.push({ type: 'error', msg: `${category} error: +${omitted} more diagnostic(s) — see build output` });
    }
    return entries;
};

/**
 * Prefix an already-short, single-line message with its pipeline category —
 * for failures that are NOT raw compiler dumps (Transpile throws, Deploy HTTP
 * errors, Runtime start/stop/stream/force-write errors), which are already
 * one line and just need the "what stage failed" context up front. A no-op
 * if the message is already tagged (avoids "Deploy error: Deploy error: …"
 * when a lower-level catch already categorized it).
 */
export const categorize = (category, message) => {
    const msg = String(message ?? '').trim();
    if (new RegExp(`^${category}\\s+(?:error|warning)\\s*:`, 'i').test(msg)) return msg;
    return `${category} error: ${msg}`;
};
