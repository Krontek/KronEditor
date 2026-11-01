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

// IEC 61131-3 §6.1.3: keywords "shall not be used for any other purpose, for
// example, variable names". The 3rd edition has no keyword list of its own —
// these are the terminals of the Annex A grammar that are keywords of the
// language (statements, declarations, operators, literals, elementary and
// generic type names). Standard FB pin names (IN, Q, PT, …) and the
// deprecated IL operators (LD, ST, S, R, …) are NOT keywords of ST and stay
// usable. Compared case-insensitively (keywords are, §6.1.3).
export const IEC_KEYWORDS = new Set([
  'ABSTRACT', 'ACTION', 'END_ACTION', 'AND', 'ARRAY', 'AT', 'BY', 'CASE', 'END_CASE', 'CLASS', 'END_CLASS',
  'CONFIGURATION', 'END_CONFIGURATION', 'CONSTANT', 'CONTINUE', 'DO', 'ELSE', 'ELSIF', 'END_FOR', 'END_FUNCTION',
  'END_FUNCTION_BLOCK', 'END_IF', 'END_INTERFACE', 'END_METHOD', 'END_NAMESPACE', 'END_PROGRAM', 'END_REPEAT',
  'END_RESOURCE', 'END_STEP', 'END_STRUCT', 'END_TRANSITION', 'END_TYPE', 'END_VAR', 'END_WHILE', 'EXIT',
  'EXTENDS', 'F_EDGE', 'FALSE', 'FINAL', 'FOR', 'FROM', 'FUNCTION', 'FUNCTION_BLOCK', 'IF', 'IMPLEMENTS',
  'INITIAL_STEP', 'INTERFACE', 'INTERNAL', 'INTERVAL', 'METHOD', 'MOD', 'NAMESPACE', 'NON_RETAIN', 'NOT', 'NULL',
  'OF', 'ON', 'OR', 'OVERLAP', 'OVERRIDE', 'PRIORITY', 'PRIVATE', 'PROGRAM', 'PROTECTED', 'PUBLIC', 'R_EDGE',
  'READ_ONLY', 'READ_WRITE', 'REF', 'REF_TO', 'REPEAT', 'RESOURCE', 'RETAIN', 'RETURN', 'SINGLE', 'STEP',
  'STRUCT', 'SUPER', 'TASK', 'THEN', 'THIS', 'TO', 'TRANSITION', 'TRUE', 'TYPE', 'UNTIL', 'USING', 'VAR',
  'VAR_ACCESS', 'VAR_CONFIG', 'VAR_EXTERNAL', 'VAR_GLOBAL', 'VAR_IN_OUT', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_TEMP',
  'WHILE', 'WITH', 'XOR',
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL', 'TIME', 'LTIME', 'DATE', 'LDATE', 'TIME_OF_DAY', 'LTIME_OF_DAY', 'TOD', 'LTOD',
  'DATE_AND_TIME', 'LDATE_AND_TIME', 'DT', 'LDT', 'STRING', 'WSTRING', 'CHAR', 'WCHAR',
  'ANY', 'ANY_DERIVED', 'ANY_ELEMENTARY', 'ANY_MAGNITUDE', 'ANY_NUM', 'ANY_REAL', 'ANY_INT', 'ANY_UNSIGNED',
  'ANY_SIGNED', 'ANY_DURATION', 'ANY_BIT', 'ANY_CHARS', 'ANY_STRING', 'ANY_CHAR', 'ANY_DATE',
]);

// A valid IEC 61131-3 identifier (§6.1.2, Table 2): letters, digits and
// underscores, not starting with a digit — and the underscore rules: no
// multiple leading or embedded underscores (`__LIM`, `LIM__SW` are invalid)
// and no trailing one (`LIM_SW5_`). A single leading underscore is valid
// (Table 2 feature 3: `_MAIN`). Every user-entered name (variable, POU,
// data type, member, enumerated value, task) must satisfy this.
export const IEC_IDENTIFIER_RE = /^(?!.*__)(?!.*_$)[A-Za-z_][A-Za-z0-9_]*$/;

// Why `name` is not a usable IEC identifier, or null when it is.
export function iecIdentifierProblem(name) {
  const n = String(name || '').trim();
  if (!n) return 'an empty name';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) return 'only letters, digits and "_" are allowed, not starting with a digit';
  if (n.includes('__')) return 'two underscores in a row are not allowed (IEC 61131-3 §6.1.2)';
  if (n.endsWith('_')) return 'a trailing underscore is not allowed (IEC 61131-3 §6.1.2)';
  if (IEC_KEYWORDS.has(n.toUpperCase())) return `${n.toUpperCase()} is an IEC 61131-3 keyword (§6.1.3)`;
  return null;
}

export function isValidIecIdentifier(name) {
  return iecIdentifierProblem(name) === null;
}

// Normalize a raw name for a PLC identifier: trim surrounding whitespace and
// drop every character that isn't a letter, digit or underscore (spaces and
// punctuation are removed rather than turned into underscores). Useful as an
// as-you-type sanitizer; callers should still validate with
// isValidIecIdentifier (this does not fix a leading digit).
export function sanitizeIecIdentifier(name) {
  return String(name || '').trim().replace(/[^A-Za-z0-9_]/g, '');
}
