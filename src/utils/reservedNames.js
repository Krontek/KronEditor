// Identifiers the transpiler/hot-swap loader-host emit at C file scope with NO
// name-mangling (see CTranspilerService.js's PlcState/`S` pointer emission and
// host-agent/hotswaphost/host.c's fixed ABI). A variable sharing one of these
// names collides with the transpiler's own symbol — most concretely, a GLOBAL
// variable named "S" produces a PlcState struct field also named "S" (globals
// get zero prefix), and the file-scope state pointer is itself literally `S`
// (`static PlcState *S = &__plc_state;`), so any member access on it doubles
// up into broken C (`S->S.Roll` instead of `S->Roll`) — only caught at
// compile time. Checked for every variable regardless of scope: locals
// normally get a `prog_<POU>_` prefix that avoids the collision, but some
// transient/LD-local cases stay bare too, so there is no scope where using
// one of these names is actually safe.
const RESERVED_EXACT = new Set([
  's', '__plc_state', 'us_tick', 'plc_stop', '__plc_shm',
  'plc_init', 'plc_cleanup', 'plc_bind', 'plc_state_init',
  'plc_init_hs', 'plc_cleanup_hs', 'plc_task_count', 'plc_task_interval_us',
  'plc_shm_name', 'plc_shm_size', 'plc_state_size', 'plc_state_layout_hash',
]);

const TASK_BODY_RE = /^plc_task_body_\d+$/i;

export function isReservedTranspilerName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  return RESERVED_EXACT.has(n) || TASK_BODY_RE.test(n);
}

// A valid IEC 61131-3 identifier: a letter or underscore, then letters, digits
// or underscores — no spaces (leading, trailing OR internal), no punctuation,
// no leading digit. Every user-entered name (variable, POU/program, data type)
// must satisfy this so the generated C symbol is always well-formed.
export const IEC_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidIecIdentifier(name) {
  return IEC_IDENTIFIER_RE.test(String(name || '').trim());
}

// Normalize a raw name for a PLC identifier: trim surrounding whitespace and
// drop every character that isn't a letter, digit or underscore (spaces and
// punctuation are removed rather than turned into underscores). Useful as an
// as-you-type sanitizer; callers should still validate with
// isValidIecIdentifier (this does not fix a leading digit).
export function sanitizeIecIdentifier(name) {
  return String(name || '').trim().replace(/[^A-Za-z0-9_]/g, '');
}
