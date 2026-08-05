/*
 * agentTools.js — the PLC Agent's action surface over the PLC project.
 *
 * The agent loop (AiAgentPanel) sends TOOL_DEFS to the model. When the model
 * calls a tool, the panel runs it through applyToolCall(), which is a PURE
 * function: it never mutates the project in place — it returns a proposed
 * `next` projectStructure plus a `diff` descriptor the UI shows for approval.
 * On approval the panel commits `next` via setProjectStructure; on rejection it
 * throws the proposal away. This is what makes the "diff göster, onayla" flow
 * possible: every change is computed and previewed before it touches state.
 *
 * Two tool kinds:
 *   - read tools  (mutation:false) — return data, never need approval, the loop
 *     auto-feeds the result back to the model.
 *   - write tools (mutation:true)  — return { next, diff }, gated by the user.
 *
 * The board is deliberately NOT in this surface: the agent gets it as read-only
 * context but cannot change hardware.
 */

import { isReservedTranspilerName } from '../utils/reservedNames';
// Single source of truth for FB power-flow wiring: the transpiler reads the
// trigger pin (power in) and Q pin (power out) from these tables, so the
// ladder the agent authors must use exactly the same pins.
import { FB_TRIGGER_PIN, FB_Q_OUTPUT, FB_OUTPUTS } from './CTranspilerService';
import { GENERIC_FB_DEFS } from '../utils/libraryTree';

const POU_CATEGORIES = ['programs', 'functionBlocks', 'functions'];
const RESOURCE_TYPE = 'RESOURCE_EDITOR';

// ── small immutable helpers ──────────────────────────────────────────────────

// IEC 61131-3 identifier: starts with a letter or underscore, then letters /
// digits / underscores. No spaces or punctuation. Used for POU + variable names.
const IEC_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isValidIecName = (n) => IEC_NAME_RE.test(String(n || '').trim());

// Scalar IEC 61131-3 types the transpiler's mapType() resolves directly
// (CTranspilerService.js's typeMap). Anything NOT in this set must be either
// an existing data-type NAME (Array/Structure/Enumerated, created via
// create_data_type) or an existing FB/function/POU name (an instance type) —
// never an inline literal like "ARRAY[0..31] OF BYTE" typed straight into a
// variable's `type` field, which the transpiler does not parse and which
// silently produces a struct field the rest of the generated code can't find
// (e.g. "no member named prog_X_rxBuffer in struct PlcState").
const SCALAR_IEC_TYPES = new Set([
  'BOOL', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL', 'BYTE', 'WORD', 'DWORD', 'LWORD', 'TIME', 'STRING',
]);

export function findPOU(struct, name) {
  // Trim + case-insensitive so whitespace/case differences never cause a miss.
  const lname = String(name || '').trim().toLowerCase();
  if (!lname || lname === 'undefined' || lname === 'null') return null;
  for (const category of POU_CATEGORIES) {
    const list = struct[category] || [];
    const idx = list.findIndex((p) => (p.name || '').trim().toLowerCase() === lname);
    if (idx >= 0) return { category, index: idx, item: list[idx] };
  }
  return null;
}

// Case-insensitive lookup of a data type by name (mirrors findPOU's pattern).
function findDataType(struct, name) {
  const lname = String(name || '').trim().toLowerCase();
  if (!lname) return null;
  const list = struct.dataTypes || [];
  const idx = list.findIndex((d) => (d.name || '').trim().toLowerCase() === lname);
  return idx >= 0 ? { index: idx, item: list[idx] } : null;
}

// Parses an inline "ARRAY[m..n] OF TYPE" (optionally multi-dim,
// "ARRAY[0..3,0..7] OF TYPE") literal — the one IEC array form that's
// unambiguous enough to auto-recover. Returns { baseType, dimensions:
// [{min,max}, ...] } or null if it doesn't match.
function parseInlineArrayType(typeStr) {
  const m = /^ARRAY\s*\[\s*([0-9\s,.\-]+)\]\s*OF\s+([A-Za-z_]\w*)\s*$/i.exec(String(typeStr || '').trim());
  if (!m) return null;
  const dimensions = [];
  for (const part of m[1].split(',')) {
    const dm = /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(part);
    if (!dm) return null;
    dimensions.push({ min: Number(dm[1]), max: Number(dm[2]) });
  }
  if (dimensions.length === 0) return null;
  return { baseType: m[2].toUpperCase(), dimensions };
}

// Builds a unique data-type name for an auto-recovered inline array, e.g.
// "Array_BYTE_0_31", appending _2/_3/... on collision.
function uniqueArrayTypeName(struct, baseType, dimensions) {
  const dims = dimensions.map((d) => `${d.min}_${d.max}`).join('_');
  const base = `Array_${baseType}_${dims}`;
  if (!findDataType(struct, base)) return base;
  let n = 2;
  while (findDataType(struct, `${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function buildArrayDataType(name, baseType, dimensions) {
  return {
    id: newVarId(),
    name,
    type: 'Array',
    content: {
      baseType,
      dimensions: dimensions.map((d) => ({ id: newVarId(), min: d.min, max: d.max })),
    },
  };
}

// Standard STATEFUL function blocks a variable may be an instance of, keyed by
// UPPERCASE name → the canonical spelling the transpiler expects ('MC_Power',
// not 'MC_POWER'). FB_OUTPUTS is the widest catalogue of known block types; the
// EN-trigger entries are the INLINE math/compare/convert ops (ADD, GT, INT_TO_REAL…)
// which are expressions, not instances, so they are excluded. Without this the
// system prompt's own instruction — "add_variable with type = the FB type name" —
// was rejected for every standard FB, and the agent had to detour through
// set_ladder just to get a TON instance declared.
const STANDARD_FB_TYPES = new Map(
  Object.keys(FB_OUTPUTS)
    .filter((type) => FB_TRIGGER_PIN[type] !== 'EN')
    .map((type) => [type.toUpperCase(), type])
);

// Resolves a variable's requested `type` string into either a known scalar,
// a standard stateful FB type, an existing data-type/FB-instance name, or —
// for the one recoverable inline form (ARRAY[..] OF TYPE) — a newly
// auto-created named Array data type. This
// is the single choke point add_variable/update_variable funnel `type`
// through, so an unrecognized/inline-composite type is caught and either
// fixed transparently (array literal) or REJECTED with actionable guidance,
// instead of silently flowing into broken generated C the way it used to.
// Returns { ok:true, type, newDataType? } or { ok:false, error }.
function resolveVarType(struct, rawType) {
  const t = String(rawType || '').trim();
  if (!t) return { ok: true, type: 'BOOL' };
  const upper = t.toUpperCase();
  if (SCALAR_IEC_TYPES.has(upper)) return { ok: true, type: upper };
  // Project types/POUs win over the standard catalogue: a user FB named "TON"
  // shadows the standard one, exactly as the transpiler resolves it.
  const dt = findDataType(struct, t);
  if (dt) return { ok: true, type: dt.item.name };
  const pou = findPOU(struct, t);
  if (pou) return { ok: true, type: pou.item.name, isInstance: pou.category === 'functionBlocks' };
  // Case-insensitive so "ton"/"Ton" resolve, but store the CANONICAL spelling —
  // the transpiler's FB tables are keyed exactly ('MC_Power', 'R_TRIG').
  if (STANDARD_FB_TYPES.has(upper)) return { ok: true, type: STANDARD_FB_TYPES.get(upper), isInstance: true };
  const arr = parseInlineArrayType(t);
  if (arr) {
    const name = uniqueArrayTypeName(struct, arr.baseType, arr.dimensions);
    return { ok: true, type: name, newDataType: buildArrayDataType(name, arr.baseType, arr.dimensions) };
  }
  // An inline math/compare op reached here only if the model tried to declare it
  // as an instance — name the real fix instead of the generic "unknown type".
  if (FB_TRIGGER_PIN[upper] === 'EN' || FB_TRIGGER_PIN[t] === 'EN') {
    return {
      ok: false,
      error: `"${t}" is an inline math/compare/conversion operation, not a stateful function block — it has no instance to declare. Use it directly in an ST expression (e.g. "result := a + b;") instead of adding a variable of this type.`,
    };
  }
  return {
    ok: false,
    error: `Unknown type "${t}". Scalars are ${[...SCALAR_IEC_TYPES].join(', ')}. Standard function blocks (TON, CTU, R_TRIG, MC_Power, …) may be used as an instance type. For an array/struct/enum, call create_data_type first (kind ARRAY, STRUCT, or ENUM) and reference its NAME here — do not write the array/struct/enum shape inline into a variable's type.`,
  };
}

// Actionable "which POU?" error. A weak model handed `POU "undefined" not found`
// has nothing to act on: the panel's recovery layers can synthesize a call with
// no `pou` at all, and `inferPou` returns null when there is nothing to infer
// from (empty project), so the raw interpolation leaked the JS `undefined`
// straight into the message — after which the model typically gave up entirely.
// Name the actual problem AND the way out, and list what does exist.
function pouTargetError(struct, raw) {
  const names = POU_CATEGORIES.flatMap((c) => (struct[c] || []).map((p) => p.name)).filter(Boolean);
  const have = names.length ? `Existing POUs: ${names.join(', ')}.` : 'This project has no POUs yet.';
  const fix = names.length
    ? 'Retry with one of those names.'
    : 'Call create_pou first, then retry using the name you created.';
  const missing = raw == null || String(raw).trim() === '' || String(raw) === 'undefined';
  return missing
    ? `No POU was named — the "pou" argument is required. ${have} ${fix}`
    : `POU "${raw}" not found. ${have} ${fix}`;
}

// Globals a POU actually mentions — scanned over its ST code and every ladder
// block's variable/pin values. Returned by read_pou so the model can see the
// declaration of a name it meets in the logic instead of assuming it's missing.
function referencedGlobals(struct, pou) {
  const globals = getGlobals(struct);
  if (!globals.length) return undefined;
  const text = [];
  const c = pou.content || {};
  if (typeof c.code === 'string') text.push(c.code);
  for (const r of (c.rungs || [])) {
    if (r.code) text.push(r.code);
    for (const b of (r.blocks || [])) {
      if (b.data?.instanceName) text.push(String(b.data.instanceName));
      for (const v of Object.values(b.data?.values || {})) text.push(String(v));
    }
  }
  const hay = text.join('\n');
  // Word-boundary match so `Motor` doesn't hit inside `MotorRun`.
  const used = globals.filter((g) => g.name && new RegExp(`\\b${g.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay));
  return used.length
    ? used.map((g) => ({ name: g.name, type: g.type, address: g.address || undefined, scope: 'GLOBAL' }))
    : undefined;
}

function configResource(struct) {
  return (struct.resources || []).find((r) => r.type === RESOURCE_TYPE) || null;
}

function getGlobals(struct) {
  const res = configResource(struct);
  return (res && res.content && res.content.globalVars) || [];
}

// Replace one POU's content immutably.
function withPOUContent(struct, category, index, newContent) {
  const list = struct[category].map((p, i) => (i === index ? { ...p, content: newContent } : p));
  return { ...struct, [category]: list };
}

// Replace the global var list immutably.
function withGlobals(struct, newGlobals) {
  const resources = (struct.resources || []).map((r) =>
    r.type === RESOURCE_TYPE ? { ...r, content: { ...r.content, globalVars: newGlobals } } : r
  );
  return { ...struct, resources };
}

function newVarId() {
  return `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function makeVar(scope, { name, type, initialValue = '', address = '', description = '', class: cls, isInstance }) {
  return {
    id: newVarId(),
    name,
    class: cls || (scope === 'global' ? 'Global' : 'Local'),
    type: type || 'BOOL',
    initialValue: initialValue ?? '',
    description: description ?? '',
    address: address ?? '',
    // FB instances are flagged so the ladder editor keeps them out of the
    // scalar pin-suggestion lists (mirrors the editor's own inline declare).
    ...(isInstance ? { _isInstance: true } : {}),
  };
}

// Line-level diff (LCS) → [{ type:'ctx'|'add'|'del', text }]. Used to preview ST edits.
function diffLines(a, b) {
  const A = String(a || '').split('\n');
  const B = String(b || '').split('\n');
  const m = A.length, n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ type: 'ctx', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i] }); i++; }
    else { out.push({ type: 'add', text: B[j] }); j++; }
  }
  while (i < m) out.push({ type: 'del', text: A[i++] });
  while (j < n) out.push({ type: 'add', text: B[j++] });
  return out;
}

// ── project snapshot for the model's context ─────────────────────────────────

export function buildProjectOverview(struct, board) {
  const pous = [];
  for (const category of POU_CATEGORIES) {
    for (const p of struct[category] || []) {
      const c = p.content || {};
      pous.push({
        category,
        name: p.name,
        language: p.type,
        returnType: p.returnType || undefined,
        variableCount: (c.variables || []).length,
        rungCount: c.rungs ? c.rungs.length : undefined,
        codeLines: typeof c.code === 'string' ? c.code.split('\n').length : undefined,
      });
    }
  }
  return {
    board: board || null,
    pous,
    globalVariables: getGlobals(struct).map((v) => ({ name: v.name, type: v.type, address: v.address || undefined })),
    dataTypes: (struct.dataTypes || []).map((d) => ({ name: d.name, kind: d.type })),
  };
}

// Derive a user-defined POU's pins from its variable table: Input/InOut → inputs,
// Output → outputs. Mirrors how the transpiler / RungContainer read FB pins.
function pouPins(pou) {
  const vars = pou.content?.variables || [];
  const inputs = vars.filter((v) => v.class === 'Input' || v.class === 'InOut').map((v) => ({ name: v.name, type: v.type }));
  const outputs = vars.filter((v) => v.class === 'Output').map((v) => ({ name: v.name, type: v.type }));
  return { inputs, outputs };
}

// Build the catalog of usable blocks: standard library (from the loaded XML
// libraryData) + the project's own function blocks/functions, each with pins.
// `library` is App's `libraryData` = [{ id, title, blocks:[{blockType, class,
// inputs, outputs, desc}] }]. Returns { standard:[…], project:[…] }.
// Which pin carries POWER FLOW in and out of a block. ⚠️ Single source of truth
// for BOTH the catalogue the model reads and the wiring compileLadderRung
// performs — they must agree, or the catalogue documents pins the compiler
// doesn't use. Same fallback the compiler applies to project FBs with no entry
// in the transpiler's tables (first BOOL input / first BOOL output).
export function powerPins(type, inputs, outputs) {
  const trigger = FB_TRIGGER_PIN[type]
    || ((inputs || []).find((p) => p.type === 'BOOL') || (inputs || [])[0] || {}).name || null;
  const powerOutput = FB_Q_OUTPUT[type]
    || ((outputs || []).find((p) => p.type === 'BOOL') || {}).name || null;
  return { trigger, powerOutput };
}

export function buildBlockCatalog(struct, library, filter) {
  const f = (filter || '').trim().toLowerCase();
  const matches = (type, category) => !f || (type || '').toLowerCase().includes(f) || (category || '').toLowerCase().includes(f);
  const pinList = (arr) => (arr || []).map((p) => ({ name: p.name, type: p.type }));
  // ⚠️ Naming the trigger/power pins is the difference between a model that can
  // wire a rung and one that guesses. set_ladder wires power INTO `trigger` from
  // the contact network and OUT of `powerOutput` to the coils, so the trigger
  // must NOT be passed in fb.inputs — without this the catalogue looked like a
  // flat pin list and models routinely mis-wired or produced coil-less rungs.
  const withPower = (entry, inputs, outputs) => {
    const { trigger, powerOutput } = powerPins(entry.type, inputs, outputs);
    return {
      ...entry,
      ...(trigger ? { triggerPin: trigger, triggerNote: `power flows in via "${trigger}" — do NOT pass it in fb.inputs` } : {}),
      ...(powerOutput ? { powerOutputPin: powerOutput } : {}),
    };
  };

  const standard = [];
  for (const cat of (Array.isArray(library) ? library : [])) {
    for (const b of (cat.blocks || [])) {
      if (!b.blockType || !matches(b.blockType, cat.title)) continue;
      const inputs = pinList(b.inputs);
      const outputs = pinList(b.outputs);
      standard.push(withPower({
        type: b.blockType,
        kind: b.class || 'FunctionBlock',
        category: cat.title,
        description: b.desc || undefined,
        inputs, outputs,
      }, inputs, outputs));
    }
  }

  const project = [];
  for (const category of ['functionBlocks', 'functions']) {
    for (const p of (struct[category] || [])) {
      if (!matches(p.name, category)) continue;
      const { inputs, outputs } = pouPins(p);
      const entry = {
        type: p.name,
        kind: category === 'functions' ? 'Function' : 'FunctionBlock',
        language: p.type,
        returnType: p.returnType || undefined,
        inputs, outputs,
      };
      // Functions are called inline from ST — they have no ladder power flow.
      project.push(category === 'functions' ? entry : withPower(entry, inputs, outputs));
    }
  }
  return { standard, project };
}

// ── tool definitions (sent to the model) ─────────────────────────────────────

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });

export const TOOL_DEFS = [
  // ⚠️ Handled ENTIRELY by AiAgentPanel (runTurn intercepts it before the
  // applyToolCall dispatch) because it must PAUSE the loop for a human, which a
  // pure struct→struct executor cannot do. It is declared here so it reaches the
  // provider in the same tools array as everything else.
  {
    name: 'ask_user',
    description:
      'Ask the user ONE clarifying question and WAIT for the answer. This is the ONLY way to ask something — never write a question as plain prose, and never number several questions into one message. ' +
      'Whenever the answer is a choice between knowable alternatives, PASS `options`: they render as clickable buttons, so the user answers in one click instead of typing. ' +
      'Only omit `options` when the answer is genuinely open (a number, a name, an address) — then it renders as a text box. ' +
      'You may emit several ask_user calls in one turn; they are presented to the user ONE AT A TIME, in order, and all the answers come back together. ' +
      'No other tool runs in a turn that contains ask_user — ask first, act after the answers.',
    parameters: S({
      question: str('The single question, in the user\'s own language. Short and specific.'),
      options: {
        type: 'array',
        description: 'The choices, when the answer is a choice. 2–5 entries. Omit entirely for a free-text answer.',
        items: S({
          label: str('The choice as the user sees it. A few words.'),
          description: str('Optional one-line explanation of what picking this means.'),
        }, ['label']),
      },
      allowOther: {
        type: 'boolean',
        description: 'Default true. Keeps a free-text "Other…" box under the buttons so the user is never boxed in by your options.',
      },
    }, ['question']),
  },
  {
    name: 'get_project_overview',
    description: 'List every POU (programs, function blocks, functions), their language and variable counts, all global variables, data types, and the selected board. Call this first to understand the project.',
    parameters: S({}),
  },
  {
    name: 'read_pou',
    description: 'Read the full source of one POU: its ST code (or a summary of its ladder rungs) and its complete local variable table.',
    parameters: S({ name: str('POU name') }, ['name']),
  },
  {
    name: 'read_live_variables',
    description: 'Read live values from the running simulation/PLC: both the CURRENT snapshot AND a buffered time-series `history` per variable (last/first/min/max, how many times it changed, flags like "constant"/"oscillating", and a recent down-sampled series). Use the history to diagnose actual runtime behaviour — a value stuck, oscillating, drifting, or out of range — before proposing a code fix. Only returns data while the program is running.',
    parameters: S({}),
  },
  {
    name: 'watch_live_variables',
    description: 'ACTIVELY observe the running simulation/PLC for a real time window, then return a per-variable time-series summary. Unlike read_live_variables (an instant snapshot of whatever was already buffered), this WAITS and lets fresh samples accumulate — and EACH variable can be watched for its OWN duration. Use it to confirm time-dependent behaviour (a timer output toggling every 5 s, a value settling, a ramp rising) and ESPECIALLY to VERIFY a fix after an online change / deploy: watch the relevant variables, compare against the expected behaviour, and report whether it worked. Use the live keys exactly as they appear in read_live_variables (e.g. prog_Main_blink.Q). Only returns data while the program is running; keep durations short (a few seconds) unless a longer observation is genuinely needed.',
    parameters: S({
      variables: {
        type: 'array',
        description: 'Variables to watch, each with its own observation duration in seconds.',
        items: S({
          name: str('Live variable key as seen in read_live_variables (e.g. prog_Main_blink.Q)'),
          seconds: { type: 'number', description: 'How long to observe THIS variable, in seconds (1-60)' },
        }, ['name', 'seconds']),
      },
      maxSeconds: { type: 'number', description: 'Optional hard cap on total wait time in seconds (defaults to the largest per-variable duration; clamped to 60).' },
    }, ['variables']),
  },
  {
    name: 'list_blocks',
    description: 'List the building blocks you can use, EACH WITH ITS INPUT AND OUTPUT PINS: the standard library function blocks & functions (timers TON/TOF, counters CTU/CTD, math, comparison, motion MC_*, communication, conversion, HAL I/O blocks) AND the project\'s own function blocks/functions. ALWAYS call this before using any function block or function in ST so you reference the correct pin names and types. Optionally filter by a name/category substring.',
    parameters: S({ filter: str('Optional case-insensitive substring to match block type or category (optional)') }),
  },
  {
    name: 'create_pou',
    description: 'Create a new, empty POU. Language "ST" = Structured Text (set its body with set_st_code), "LD" = Ladder (set its rungs with set_ladder), "SCL" = mixed (rungs that are each ladder or ST — author with set_ladder and/or set_st_code).',
    parameters: S({
      category: { type: 'string', enum: ['programs', 'functionBlocks', 'functions'] },
      name: str('Unique POU name'),
      language: { type: 'string', enum: ['ST', 'LD', 'SCL'] },
      returnType: str('Return type — only for functions (e.g. BOOL, INT, REAL)'),
    }, ['category', 'name', 'language']),
  },
  {
    name: 'rename_pou',
    description: 'Rename an existing POU.',
    parameters: S({ name: str('Current name'), newName: str('New name') }, ['name', 'newName']),
  },
  {
    name: 'delete_pou',
    description: 'Delete a POU entirely. Destructive — only when explicitly asked.',
    parameters: S({ name: str('POU name to delete') }, ['name']),
  },
  {
    name: 'set_st_code',
    description: 'Replace the entire Structured Text body of an ST (or SCL) POU. Provide complete, valid IEC 61131-3 ST. The variables it uses must already exist (add them with add_variable) or be global.',
    parameters: S({ pou: str('Target ST/SCL POU name'), code: str('The full new ST source') }, ['pou', 'code']),
  },
  {
    name: 'set_ladder',
    description:
      'Replace the ENTIRE ladder (all rungs) of an LD or SCL POU. Express each rung as a boolean network of CONTACTS, optionally through ONE function block (timer/counter/edge/comm/user FB), driving output COILS. ' +
      'A rung = OR of `branches` (each branch is an AND-series of contacts), optionally followed by `seriesAfter` contacts (in series after the OR-merge — e.g. a normally-closed Stop for a seal-in), then an optional `fb`, then `outputs` coils. ' +
      'Power flow: contact network → fb trigger input → fb Q output → coils. ' +
      'Contact subType: "NO" (normally open), "NC" (normally closed), "Rising"/"Falling" (edge). Coil subType: "Normal", "Set", "Reset" or "Negated". ' +
      'Referenced variables that do not exist yet are AUTO-DECLARED (contacts/coils as BOOL, fb.instance as the FB type) and listed in the approval diff — no separate add_variable needed for them. ' +
      'Each rung is an OBJECT (use {…}, never [...]). Examples — ' +
      'Start/Stop seal-in: rungs: [{ "branches": [[{"contact":"Start"}], [{"contact":"Motor"}]], "seriesAfter": [{"contact":"Stop","subType":"NC"}], "outputs": [{"coil":"Motor"}] }]. ' +
      '5s on-delay: rungs: [{ "branches": [[{"contact":"Sensor"}]], "fb": { "type":"TON", "instance":"delayTimer", "inputs": {"PT":"T#5s"}, "outputs": {"ET":"elapsed"} }, "outputs": [{"coil":"Lamp"}] }]. ' +
      'Counter with reset: rungs: [{ "branches": [[{"contact":"PartSensor"}]], "fb": { "type":"CTU", "instance":"partCounter", "inputs": {"PV":"100","R":"ResetBtn"} }, "outputs": [{"coil":"BatchDone"}] }]. ' +
      'Note: inline math/move/compare (ADD, MOVE, GT, …) and motion (MC_*) do NOT go in ladder — write those in an ST rung (set_st_code).',
    parameters: S({
      pou: str('Target LD POU name'),
      rungs: {
        type: 'array',
        description: 'Ordered rungs. Each drives its outputs when its contact network conducts.',
        items: S({
          comment: str('Optional rung comment'),
          branches: {
            type: 'array',
            description: 'Parallel branches (OR). Each branch is a list of contacts in series (AND). A single branch = a simple series. An empty branch = always-true (direct power).',
            items: { type: 'array', items: S({ contact: str('BOOL variable name'), subType: { type: 'string', enum: ['NO', 'NC', 'Rising', 'Falling'] } }, ['contact']) },
          },
          seriesAfter: {
            type: 'array',
            description: 'Contacts placed in series AFTER the branches merge (shared by all branches). Use for the Stop contact in a start/stop seal-in.',
            items: S({ contact: str('BOOL variable name'), subType: { type: 'string', enum: ['NO', 'NC', 'Rising', 'Falling'] } }, ['contact']),
          },
          fb: S({
            type: str('Block type, e.g. TON, TOF, TP, CTU, CTD, R_TRIG, SR, RS, or a project function block name (see list_blocks)'),
            instance: str('Instance variable name (auto-declared with the FB type if missing), e.g. "delayTimer"'),
            inputs: { type: 'object', description: 'Non-trigger input pins by NAME: literal ("T#5s", "100") or a variable name ("ResetBtn"). The trigger pin (IN/CU/…) comes from the rung power flow — do not set it here.', additionalProperties: { type: 'string' } },
            outputs: { type: 'object', description: 'Optional captures: output pin name → variable name to store it into (e.g. {"ET":"elapsed","CV":"count"}).', additionalProperties: { type: 'string' } },
          }, ['type', 'instance']),
          outputs: {
            type: 'array',
            description: 'Output coils driven by the rung (usually one; may be empty if the rung only runs an fb).',
            items: S({ coil: str('BOOL variable name'), subType: { type: 'string', enum: ['Normal', 'Set', 'Reset', 'Negated'] } }, ['coil']),
          },
        }, []),
      },
    }, ['pou', 'rungs']),
  },
  {
    name: 'add_variable',
    description: 'Add a variable. DEFAULT scope is "local" (a variable inside one POU) — pass scope "local" with the pou. Use scope "global" ONLY when the user explicitly asks for a global/shared variable, or when a variable must be shared across multiple POUs. Optionally give an IEC address (e.g. %MW0) to expose it via the REST/HMI API.',
    parameters: S({
      scope: { type: 'string', enum: ['local', 'global'], description: 'Default "local". Use "global" only when explicitly requested or genuinely shared across POUs.' },
      pou: str('POU name — REQUIRED when scope is "local". Pass the exact name of the POU the variable belongs to (e.g. the one you just created with create_pou).'),
      name: str('Variable name'),
      type: str('IEC type, e.g. BOOL, INT, DINT, REAL, TIME, or a UDT/FB type'),
      initialValue: str('Initial value (optional)'),
      address: str('IEC address like %MW0, %MX0.1 (optional)'),
      description: str('Comment (optional)'),
    }, ['scope', 'name', 'type']),
  },
  {
    name: 'update_variable',
    description: 'Change fields of an existing variable (type, initialValue, address, description, or rename).',
    parameters: S({
      scope: { type: 'string', enum: ['local', 'global'] },
      pou: str('POU name (required when scope is local)'),
      name: str('Current variable name'),
      newName: str('New name (optional)'),
      type: str('New IEC type (optional)'),
      initialValue: str('New initial value (optional)'),
      address: str('New IEC address (optional)'),
      description: str('New comment (optional)'),
    }, ['scope', 'name']),
  },
  {
    name: 'remove_variable',
    description: 'Remove a variable from a POU (scope local) or from the project globals (scope global).',
    parameters: S({
      scope: { type: 'string', enum: ['local', 'global'] },
      pou: str('POU name (required when scope is local)'),
      name: str('Variable name to remove'),
    }, ['scope', 'name']),
  },
  // ⚠️ `check_compile` was REMOVED from the agent's tool surface deliberately.
  // It ran a real transpile + bundled-clang compile, and the clang cold load
  // (~242 MB) dominates that cost — the model called it after almost every
  // change, so each edit paid a full build and the agent felt interminably
  // slow. The human still has the toolbar Build button, which is the right
  // place for a compile: an explicit, visible action. Do not re-add it as an
  // agent tool without making it opt-in and bounding how often it can run.
  {
    name: 'create_data_type',
    description:
      'Create a named ARRAY, STRUCT, or ENUM data type under the project\'s Data Types. ' +
      'A variable can then use it by setting its `type` to this NAME (e.g. add_variable type:"RxFrame") — NEVER write the array/struct/enum shape inline into a variable\'s own type field (e.g. never set a variable\'s type to the literal "ARRAY[0..31] OF BYTE"); the transpiler only understands a type that is either a scalar IEC type or the NAME of a data type created here. ' +
      'ARRAY: give baseType + dimensions (one entry per dimension, e.g. [{"min":0,"max":31}] for ARRAY[0..31]). ' +
      'STRUCT: give members (each {name, type, initialValue?} — type can itself be a scalar, another data-type name, or an FB type). ' +
      'ENUM: give values (a list of member names, e.g. ["IDLE","RUNNING","FAULT"]).',
    parameters: S({
      name: str('Unique data type name (e.g. "RxFrame", "MotorState")'),
      kind: { type: 'string', enum: ['ARRAY', 'STRUCT', 'ENUM'] },
      baseType: str('ARRAY only: element type — a scalar (e.g. BYTE, INT) or another data-type/FB name'),
      dimensions: {
        type: 'array',
        description: 'ARRAY only: one entry per dimension, in order.',
        items: S({ min: { type: 'number' }, max: { type: 'number' } }, ['min', 'max']),
      },
      members: {
        type: 'array',
        description: 'STRUCT only: the struct\'s fields, in order.',
        items: S({ name: str('Member name'), type: str('Member type — scalar, data-type name, or FB name'), initialValue: str('Optional initial value') }, ['name', 'type']),
      },
      values: {
        type: 'array',
        description: 'ENUM only: member names, in order (e.g. ["IDLE","RUNNING","FAULT"]).',
        items: { type: 'string' },
      },
    }, ['name', 'kind']),
  },
];

// ── executor ─────────────────────────────────────────────────────────────────
//
// Returns one of:
//   { mutation:false, ok:true, result }                      read tools
//   { mutation:true,  ok:true, summary, diff, next }         write tools
//   { ok:false, error }                                       any failure
//
// `next` is a fresh projectStructure; `struct` is never mutated.

export function applyToolCall(struct, name, args = {}) {
  try {
    switch (name) {
      case 'get_project_overview':
        return { mutation: false, ok: true, result: buildProjectOverview(struct, args.__board) };

      case 'read_live_variables': {
        // The panel injects { current: {name:val}, history: summarizeLiveSamples(...) }.
        const live = args.__live || {};
        const current = live.current || null;
        if (!current || Object.keys(current).length === 0) {
          return { mutation: false, ok: true, result: { running: false, note: 'No live data — the program is not running.' } };
        }
        return {
          mutation: false, ok: true,
          result: { running: true, values: current, history: live.history || null },
        };
      }

      case 'watch_live_variables': {
        // The panel does the actual real-time waiting (the agent loop is async),
        // then injects { running, waitedSeconds, history: summarizeWatch(...) }.
        const w = args.__watch || {};
        if (!w.running) {
          return { mutation: false, ok: true, result: { running: false, note: 'No live data — the program is not running.' } };
        }
        return {
          mutation: false, ok: true,
          result: { running: true, waitedSeconds: w.waitedSeconds, history: w.history || null },
        };
      }

      case 'list_blocks': {
        const cat = buildBlockCatalog(struct, args.__library, args.filter);
        if (cat.standard.length === 0 && cat.project.length === 0) {
          return { mutation: false, ok: true, result: { note: args.filter ? `No blocks match "${args.filter}".` : 'No block library loaded.', standard: [], project: [] } };
        }
        return { mutation: false, ok: true, result: cat };
      }

      case 'read_pou': {
        const hit = findPOU(struct, args.name);
        if (!hit) return { ok: false, error: pouTargetError(struct, args.name) };
        const c = hit.item.content || {};
        // SCL keeps ST in per-rung code; surface it as `code` so the model sees it.
        const sclStCode = (c.rungs || []).filter((r) => r.lang === 'ST').map((r) => r.code || '').filter(Boolean).join('\n');
        return {
          mutation: false, ok: true,
          result: {
            name: hit.item.name, category: hit.category, language: hit.item.type,
            returnType: hit.item.returnType || undefined,
            code: (typeof c.code === 'string' && c.code) ? c.code : (sclStCode || undefined),
            rungCount: c.rungs ? c.rungs.length : undefined,
            // Faithful boolean-logic rendering of the rungs (LD + SCL) so the
            // model can actually read the existing program, not just block names.
            ladder: (c.rungs && (hit.item.type === 'LD' || hit.item.type === 'SCL')) ? renderRungs(c.rungs) : undefined,
            variables: (c.variables || []).map((v) => ({
              name: v.name, type: v.type, class: v.class, initialValue: v.initialValue, address: v.address, description: v.description,
            })),
            // ⚠️ Globals this POU actually references. Without them the model
            // reads logic like `MotorRun := (Start OR MotorRun) AND NOT Stop`
            // with MotorRun declared NOWHERE in sight (it isn't a POU local) —
            // and a weak model "fixes" that by re-declaring it as a local,
            // silently shadowing the global. Scoped to referenced names so a
            // project with many globals doesn't flood the response.
            globals: referencedGlobals(struct, hit.item),
          },
        };
      }

      case 'create_pou': {
        // Default/normalize the category — weak models often omit it or write a
        // singular/variant ("program", "fb"). Programs are the common case.
        const catRaw = String(args.category || '').toLowerCase();
        const category = POU_CATEGORIES.includes(args.category) ? args.category
          : (catRaw.startsWith('functionb') || catRaw === 'fb') ? 'functionBlocks'
          : (catRaw === 'function' || catRaw === 'functions') ? 'functions'
          : 'programs';
        if (!args.name || !args.name.trim()) return { ok: false, error: 'name is required' };
        if (!isValidIecName(args.name)) return { ok: false, error: `invalid name "${args.name}" — POU names must be IEC identifiers (letters, digits, underscore; no spaces; can't start with a digit)` };
        if (isReservedTranspilerName(args.name)) return { ok: false, error: `"${args.name}" is reserved by the transpiler/runtime — pick a different POU name` };
        if (findPOU(struct, args.name)) return { ok: false, error: `a POU named "${args.name}" already exists — edit it directly with set_ladder / set_st_code (read_pou first to see what it contains), or choose a different name.` };
        // Unified rung model: every POU is 'SCL' (a list of rungs, each LD or
        // ST). The requested language is honored PER RUNG — set_ladder adds LD
        // rungs, set_st_code adds an ST rung — so we no longer create distinct
        // LD/ST POU types. (args.language is accepted but only steers which tool
        // the model should call next; it never changes the POU type.)
        const content = { rungs: [], variables: [] };
        const item = {
          id: `${category}_${Date.now()}`,
          name: args.name.trim(),
          type: 'SCL',
          returnType: category === 'functions' ? (args.returnType || 'BOOL') : undefined,
          content,
        };
        const next = { ...struct, [category]: [...struct[category], item] };
        return {
          mutation: true, ok: true,
          summary: `Create ${singular(category)} "${item.name}"`,
          diff: { kind: 'pou-add', target: item.name, lines: [{ type: 'add', text: `${singular(category)}  ${item.name}${item.returnType ? ' : ' + item.returnType : ''}  (rung-based: add LD rungs with set_ladder, ST rungs with set_st_code)` }] },
          next,
        };
      }

      case 'rename_pou': {
        const hit = findPOU(struct, args.name);
        if (!hit) return { ok: false, error: pouTargetError(struct, args.name) };
        if (!args.newName || !args.newName.trim()) return { ok: false, error: 'newName is required' };
        if (!isValidIecName(args.newName)) return { ok: false, error: `invalid name "${args.newName}" — must be an IEC identifier (no spaces; can't start with a digit)` };
        if (isReservedTranspilerName(args.newName)) return { ok: false, error: `"${args.newName}" is reserved by the transpiler/runtime — pick a different name` };
        if (findPOU(struct, args.newName)) return { ok: false, error: `name "${args.newName}" is already taken` };
        const list = struct[hit.category].map((p, i) => (i === hit.index ? { ...p, name: args.newName.trim() } : p));
        let next = { ...struct, [hit.category]: list };
        // Keep taskConfig program references in sync (mirrors handleCreateConfirm).
        if (hit.category === 'programs') {
          const tasks = (struct.taskConfig?.tasks || []).map((t) => ({
            ...t, programs: (t.programs || []).map((p) => (p.program === hit.item.name ? { ...p, program: args.newName.trim() } : p)),
          }));
          next = { ...next, taskConfig: { ...struct.taskConfig, tasks } };
        }
        return {
          mutation: true, ok: true,
          summary: `Rename "${hit.item.name}" → "${args.newName.trim()}"`,
          diff: { kind: 'pou-rename', target: hit.item.name, lines: [{ type: 'del', text: hit.item.name }, { type: 'add', text: args.newName.trim() }] },
          next,
        };
      }

      case 'delete_pou': {
        const hit = findPOU(struct, args.name);
        if (!hit) return { ok: false, error: pouTargetError(struct, args.name) };
        const list = struct[hit.category].filter((_, i) => i !== hit.index);
        const next = { ...struct, [hit.category]: list };
        return {
          mutation: true, ok: true,
          summary: `Delete ${singular(hit.category)} "${hit.item.name}"`,
          diff: { kind: 'pou-delete', target: hit.item.name, lines: [{ type: 'del', text: `${hit.item.type} ${singular(hit.category)}  ${hit.item.name}` }] },
          next,
        };
      }

      case 'set_st_code': {
        const hit = findPOU(struct, args.pou);
        if (!hit) return { ok: false, error: pouTargetError(struct, args.pou) };
        if (hit.item.type === 'LD') return { ok: false, error: `"${args.pou}" is a Ladder POU — edit it with set_ladder, not set_st_code` };
        if (typeof args.code !== 'string') return { ok: false, error: 'code must be a string' };
        // The editor's ST box is BODY-ONLY (variables live in the table). Models
        // often wrap the code in PROGRAM/VAR…END_VAR — strip those so they don't
        // land in the body (where the transpiler would choke on them).
        const code = stripStWrappers(args.code);
        // Safety net: if the model inlined declarations (VAR…END_VAR or bare
        // `name : TYPE;` lines) instead of calling add_variable, recover them so
        // the ST doesn't reference undefined names. Parse from the RAW code
        // (stripStWrappers has since removed the blocks).
        const recovered = extractStDeclarations(args.code);
        const content = hit.item.content || {};
        let oldCode, next;
        if (hit.item.type === 'SCL') {
          // SCL stores logic per-rung (each rung has lang ST|LD + code). The ST
          // body goes into a single ST rung — content.code is NOT read for SCL.
          // set_st_code replaces only the ST rungs; LD rungs (from set_ladder)
          // are preserved untouched — this tool's contract is "entire ST body",
          // not "entire rung list".
          const existingRungs = content.rungs || [];
          const old = existingRungs.filter((r) => r.lang === 'ST').map((r) => r.code || '').join('\n');
          oldCode = old;
          const ldRungs = existingRungs.filter((r) => r.lang !== 'ST');
          const rung = { id: `rung_${Date.now()}_0`, label: '000', lang: 'ST', blocks: [], connections: [], code };
          next = withPOUContent(struct, hit.category, hit.index, { ...content, rungs: [...ldRungs, rung] });
        } else {
          oldCode = content.code || '';
          next = withPOUContent(struct, hit.category, hit.index, { ...content, code });
        }
        // Apply recovered declarations onto `next`, skipping names that already
        // exist (locally or globally). Collect diff lines for the preview.
        const addedVarLines = [];
        if (recovered.length) {
          const localVars = next[hit.category][hit.index].content?.variables || [];
          const localNames = new Set(localVars.map((v) => (v.name || '').toLowerCase()));
          const globalNames = new Set(getGlobals(next).map((v) => (v.name || '').toLowerCase()));
          let nextLocals = localVars;
          for (const d of recovered) {
            const lname = d.name.toLowerCase();
            if (d.scope === 'global') {
              if (globalNames.has(lname)) continue;
              const v = makeVar('global', d);
              next = withGlobals(next, [...getGlobals(next), v]);
              globalNames.add(lname);
              addedVarLines.push({ type: 'add', text: `global  ${varLine(v)}` });
            } else {
              if (localNames.has(lname) || globalNames.has(lname)) continue;
              const v = makeVar('local', d);
              nextLocals = [...nextLocals, v];
              localNames.add(lname);
              addedVarLines.push({ type: 'add', text: `${hit.item.name}.${v.name} : ${v.type}` });
            }
          }
          if (nextLocals !== localVars) {
            // re-locate the POU in `next` (globals edits don't move it, but be safe)
            const reHit = findPOU(next, hit.item.name);
            next = withPOUContent(next, reHit.category, reHit.index, { ...next[reHit.category][reHit.index].content, variables: nextLocals });
          }
        }
        return {
          mutation: true, ok: true,
          summary: addedVarLines.length
            ? `Rewrite ST in "${hit.item.name}" (+${addedVarLines.length} var${addedVarLines.length === 1 ? '' : 's'})`
            : `Rewrite ST in "${hit.item.name}"`,
          diff: { kind: 'st-edit', target: hit.item.name, lines: [...diffLines(oldCode, code), ...addedVarLines] },
          next,
        };
      }

      case 'set_ladder': {
        const hit = findPOU(struct, args.pou);
        if (!hit) return { ok: false, error: pouTargetError(struct, args.pou) };
        // LD POUs are pure ladder; SCL POUs are mixed and accept ladder rungs too
        // (each tagged lang:'LD'). ST POUs cannot hold ladder.
        if (hit.item.type !== 'LD' && hit.item.type !== 'SCL') return { ok: false, error: `"${args.pou}" is not a Ladder/SCL POU — use set_st_code for ST` };
        const dsl = Array.isArray(args.rungs) ? args.rungs : [];
        if (dsl.length === 0) return { ok: false, error: 'rungs must be a non-empty array' };
        const fbVarHints = []; // pin-typed declare candidates from fb.inputs/fb.outputs
        let compiled;
        try { compiled = dsl.map((r, i) => compileLadderRung(r, i, { struct, pou: hit.item, library: args.__library, collect: (h) => fbVarHints.push(h) })); }
        catch (e) { return { ok: false, error: `ladder: ${e.message}` }; }
        // SCL rungs carry a per-rung language tag; ladder rungs are 'LD'.
        if (hit.item.type === 'SCL') compiled = compiled.map((r) => ({ ...r, lang: 'LD' }));

        // ── Auto-declare referenced-but-undeclared variables ──
        // Mirrors the editor's inline declaration: contact/coil names → BOOL,
        // fb instances → the FB type. Every auto-declared variable is surfaced
        // in the approval diff, so a typo'd name is visible to the human
        // instead of silently splitting the logic across two variables.
        const declared = new Set([
          ...(hit.item.content?.variables || []).map((v) => v.name),
          ...getGlobals(struct).map((v) => v.name),
        ]);
        const newVars = [];
        const declare = (name, type, isInstance) => {
          if (!isValidIecName(name) || declared.has(name)) return;
          if (isReservedTranspilerName(name)) return; // compileLadderRung already ran; let the transpiler surface this loudly
          declared.add(name);
          newVars.push({
            id: `var_${Date.now()}_${newVars.length}`, name, class: 'Local', type,
            initialValue: '', description: '', address: '', ...(isInstance ? { _isInstance: true } : {}),
          });
        };
        for (const r of dsl) {
          const contacts = [
            ...(Array.isArray(r.branches) ? r.branches.flat() : []),
            ...(Array.isArray(r.seriesAfter) ? r.seriesAfter : []),
          ];
          for (const c of contacts) if (c && c.contact) declare(String(c.contact), 'BOOL', false);
          for (const o of (Array.isArray(r.outputs) ? r.outputs : [])) if (o && o.coil) declare(String(o.coil), 'BOOL', false);
          if (r.fb && r.fb.instance) declare(String(r.fb.instance), String(r.fb.type), true);
        }
        // Variables referenced inside fb pins (inputs like R:="ResetBtn",
        // captures like ET⇒elapsed) — typed by the PIN, collected during compile.
        for (const h of fbVarHints) declare(h.name, h.type, h.isInstance);

        // set_ladder replaces only the LD rungs; ST rungs (from set_st_code)
        // are preserved untouched — this tool's contract is "entire ladder",
        // not "entire rung list".
        const allOldRungs = hit.item.content?.rungs || [];
        const stRungs = allOldRungs.filter((r) => r.lang === 'ST');
        const oldRungs = allOldRungs.filter((r) => r.lang !== 'ST');
        const next = withPOUContent(struct, hit.category, hit.index, {
          ...hit.item.content,
          rungs: [...stRungs, ...compiled],
          ...(newVars.length ? { variables: [...(hit.item.content?.variables || []), ...newVars] } : {}),
        });
        const lines = [
          ...oldRungs.map((rg, i) => ({ type: 'del', text: `Rung ${i + 1}: ${(rg.blocks || []).map((b) => b.type).join(' ') || '(empty)'}` })),
          ...dsl.map((r, i) => ({ type: 'add', text: `Rung ${i + 1}: ${ladderRungText(r)}` })),
          ...newVars.map((v) => ({ type: 'add', text: `auto-declared  ${v.name} : ${v.type}` })),
        ];
        return {
          mutation: true, ok: true,
          summary: `Set ladder in "${hit.item.name}" (${compiled.length} rung${compiled.length === 1 ? '' : 's'}${newVars.length ? `, declared ${newVars.length} var${newVars.length === 1 ? '' : 's'}` : ''})`,
          diff: { kind: 'ld-edit', target: hit.item.name, lines }, next,
        };
      }

      case 'add_variable': {
        const scope = args.scope === 'global' ? 'global' : 'local';
        if (!args.name || !args.name.trim()) return { ok: false, error: 'name is required' };
        if (!isValidIecName(args.name)) return { ok: false, error: `invalid variable name "${args.name}" — must be an IEC identifier (no spaces; can't start with a digit)` };
        if (isReservedTranspilerName(args.name)) return { ok: false, error: `"${args.name}" is reserved by the transpiler/runtime (e.g. "S" is the internal PlcState pointer) — pick a different name` };
        const resolved = resolveVarType(struct, args.type);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        // An inline "ARRAY[..] OF TYPE" got auto-recovered into a real named
        // data type — fold it into the base struct BEFORE building/placing the
        // variable so both land in the same mutation/diff.
        let base = struct;
        const extraLines = [];
        if (resolved.newDataType) {
          base = { ...struct, dataTypes: [...(struct.dataTypes || []), resolved.newDataType] };
          extraLines.push({ type: 'add', text: `data type  ${resolved.newDataType.name} = ARRAY[${resolved.newDataType.content.dimensions.map((d) => `${d.min}..${d.max}`).join(',')}] OF ${resolved.newDataType.content.baseType}` });
        }
        const v = makeVar(scope, { ...args, name: args.name.trim(), type: resolved.type, isInstance: resolved.isInstance });
        if (scope === 'global') {
          const globals = getGlobals(base);
          if (globals.some((g) => (g.name || '').toLowerCase() === v.name.toLowerCase()))
            return { ok: false, error: `global "${v.name}" already exists` };
          const next = withGlobals(base, [...globals, v]);
          return {
            mutation: true, ok: true, summary: `Add global ${v.name} : ${v.type}`,
            diff: { kind: 'var-add', target: `global ${v.name}`, lines: [...extraLines, { type: 'add', text: varLine(v) }] }, next,
          };
        }
        const hit = findPOU(base, args.pou);
        if (!hit) return { ok: false, error: pouTargetError(base, args.pou) };
        const vars = hit.item.content?.variables || [];
        if (vars.some((x) => (x.name || '').toLowerCase() === v.name.toLowerCase()))
          return { ok: false, error: `"${args.pou}" already has a variable named "${v.name}". Use update_variable to change it, or pick a different name.` };
        // ⚠️ Refuse to SHADOW a global. set_ladder's auto-declare resolves a
        // contact/coil against locals AND globals, so adding a local with a
        // global's name silently re-binds every existing reference to the new
        // local — observed with a BOOL global `counter` followed by a local
        // `counter : INT`, which quietly retargeted the rung's coil.
        const shadowed = getGlobals(base).find((g) => (g.name || '').toLowerCase() === v.name.toLowerCase());
        if (shadowed)
          return { ok: false, error: `a GLOBAL variable named "${shadowed.name}" (${shadowed.type}) already exists — a local with the same name would shadow it and silently re-bind existing references. Use the global directly, or choose a different local name.` };
        const next = withPOUContent(base, hit.category, hit.index, { ...hit.item.content, variables: [...vars, v] });
        return {
          mutation: true, ok: true, summary: `Add ${v.name} : ${v.type} to ${hit.item.name}`,
          diff: { kind: 'var-add', target: `${hit.item.name}.${v.name}`, lines: [...extraLines, { type: 'add', text: varLine(v) }] }, next,
        };
      }

      case 'update_variable': {
        const scope = args.scope === 'global' ? 'global' : 'local';
        const changes = {};
        if (args.newName != null) {
          const newName = String(args.newName).trim();
          if (!isValidIecName(newName)) return { ok: false, error: `invalid variable name "${newName}" — must be an IEC identifier (no spaces; can't start with a digit)` };
          if (isReservedTranspilerName(newName)) return { ok: false, error: `"${newName}" is reserved by the transpiler/runtime (e.g. "S" is the internal PlcState pointer) — pick a different name` };
          changes.name = newName;
        }
        if (args.initialValue != null) changes.initialValue = args.initialValue;
        if (args.address != null) changes.address = args.address;
        if (args.description != null) changes.description = args.description;
        let base = struct;
        const extraLines = [];
        if (args.type != null) {
          const resolved = resolveVarType(struct, args.type);
          if (!resolved.ok) return { ok: false, error: resolved.error };
          changes.type = resolved.type;
          // Retype BOOL→TON (or back) must move the instance flag with it, or a
          // stale flag would keep an ordinary scalar out of the pin suggestions.
          if (resolved.isInstance) changes._isInstance = true;
          else changes._isInstance = undefined;
          if (resolved.newDataType) {
            base = { ...struct, dataTypes: [...(struct.dataTypes || []), resolved.newDataType] };
            extraLines.push({ type: 'add', text: `data type  ${resolved.newDataType.name} = ARRAY[${resolved.newDataType.content.dimensions.map((d) => `${d.min}..${d.max}`).join(',')}] OF ${resolved.newDataType.content.baseType}` });
          }
        }
        if (Object.keys(changes).length === 0) return { ok: false, error: 'no changes provided' };

        if (scope === 'global') {
          const globals = getGlobals(base);
          const idx = globals.findIndex((g) => (g.name || '').toLowerCase() === String(args.name).toLowerCase());
          if (idx < 0) return { ok: false, error: `global "${args.name}" not found` };
          const before = globals[idx];
          const after = { ...before, ...changes };
          const next = withGlobals(base, globals.map((g, i) => (i === idx ? after : g)));
          return {
            mutation: true, ok: true, summary: `Update global ${before.name}`,
            diff: { kind: 'var-update', target: `global ${before.name}`, lines: [...extraLines, { type: 'del', text: varLine(before) }, { type: 'add', text: varLine(after) }] }, next,
          };
        }
        const hit = findPOU(base, args.pou);
        if (!hit) return { ok: false, error: pouTargetError(struct, args.pou) };
        const vars = hit.item.content?.variables || [];
        const idx = vars.findIndex((x) => (x.name || '').toLowerCase() === String(args.name).toLowerCase());
        if (idx < 0) return { ok: false, error: `"${args.pou}" has no variable "${args.name}"` };
        const before = vars[idx];
        const after = { ...before, ...changes };
        const next = withPOUContent(base, hit.category, hit.index, { ...hit.item.content, variables: vars.map((x, i) => (i === idx ? after : x)) });
        return {
          mutation: true, ok: true, summary: `Update ${hit.item.name}.${before.name}`,
          diff: { kind: 'var-update', target: `${hit.item.name}.${before.name}`, lines: [...extraLines, { type: 'del', text: varLine(before) }, { type: 'add', text: varLine(after) }] }, next,
        };
      }

      case 'remove_variable': {
        const scope = args.scope === 'global' ? 'global' : 'local';
        if (scope === 'global') {
          const globals = getGlobals(struct);
          const idx = globals.findIndex((g) => (g.name || '').toLowerCase() === String(args.name).toLowerCase());
          if (idx < 0) return { ok: false, error: `global "${args.name}" not found` };
          const before = globals[idx];
          const next = withGlobals(struct, globals.filter((_, i) => i !== idx));
          return {
            mutation: true, ok: true, summary: `Remove global ${before.name}`,
            diff: { kind: 'var-remove', target: `global ${before.name}`, lines: [{ type: 'del', text: varLine(before) }] }, next,
          };
        }
        const hit = findPOU(struct, args.pou);
        if (!hit) return { ok: false, error: pouTargetError(struct, args.pou) };
        const vars = hit.item.content?.variables || [];
        const idx = vars.findIndex((x) => (x.name || '').toLowerCase() === String(args.name).toLowerCase());
        if (idx < 0) return { ok: false, error: `"${args.pou}" has no variable "${args.name}"` };
        const before = vars[idx];
        const next = withPOUContent(struct, hit.category, hit.index, { ...hit.item.content, variables: vars.filter((_, i) => i !== idx) });
        return {
          mutation: true, ok: true, summary: `Remove ${hit.item.name}.${before.name}`,
          diff: { kind: 'var-remove', target: `${hit.item.name}.${before.name}`, lines: [{ type: 'del', text: varLine(before) }] }, next,
        };
      }

      // Retired tool. It is no longer in TOOL_DEFS, but a model can still name
      // it from an older transcript — answer with a terminal, actionable
      // message so it moves on instead of retrying a tool that will never
      // return a compile result.
      case 'check_compile':
        return {
          ok: false,
          error: 'check_compile has been removed — you cannot compile. Do not attempt to build or verify by compiling. '
            + 'Finish the edit, state briefly what you changed, and let the user press Build in the toolbar when they want a compile.',
        };

      case 'create_data_type': {
        if (!args.name || !args.name.trim()) return { ok: false, error: 'name is required' };
        if (!isValidIecName(args.name)) return { ok: false, error: `invalid data type name "${args.name}" — must be an IEC identifier (no spaces; can't start with a digit)` };
        const trimmedName = args.name.trim();
        if (SCALAR_IEC_TYPES.has(trimmedName.toUpperCase())) return { ok: false, error: `"${trimmedName}" is a reserved scalar IEC type name — pick a different name` };
        if (isReservedTranspilerName(trimmedName)) return { ok: false, error: `"${trimmedName}" is reserved by the transpiler/runtime — pick a different name` };
        if (findDataType(struct, trimmedName)) return { ok: false, error: `a data type named "${trimmedName}" already exists` };

        const kind = String(args.kind || '').toUpperCase();
        let dtType, content, summaryShape;
        if (kind === 'ARRAY') {
          const baseRaw = String(args.baseType || '').trim();
          if (!baseRaw) return { ok: false, error: 'baseType is required for an ARRAY data type' };
          const dims = Array.isArray(args.dimensions) ? args.dimensions : [];
          if (dims.length === 0) return { ok: false, error: 'dimensions is required for an ARRAY data type (e.g. [{"min":0,"max":31}])' };
          for (const d of dims) {
            if (!Number.isFinite(d?.min) || !Number.isFinite(d?.max) || d.min > d.max)
              return { ok: false, error: `invalid dimension ${JSON.stringify(d)} — min/max must be numbers with min <= max` };
          }
          // baseType may itself be a scalar, another data-type name, or an FB name.
          const baseResolved = resolveVarType(struct, baseRaw);
          if (!baseResolved.ok) return { ok: false, error: `baseType: ${baseResolved.error}` };
          dtType = 'Array';
          content = { baseType: baseResolved.type, dimensions: dims.map((d) => ({ id: newVarId(), min: d.min, max: d.max })) };
          summaryShape = `ARRAY[${dims.map((d) => `${d.min}..${d.max}`).join(',')}] OF ${baseResolved.type}`;
        } else if (kind === 'STRUCT') {
          const members = Array.isArray(args.members) ? args.members : [];
          if (members.length === 0) return { ok: false, error: 'members is required for a STRUCT data type' };
          const seen = new Set();
          const builtMembers = [];
          for (const m of members) {
            if (!m?.name || !isValidIecName(m.name)) return { ok: false, error: `invalid struct member name "${m?.name}"` };
            const lname = m.name.trim().toLowerCase();
            if (seen.has(lname)) return { ok: false, error: `duplicate struct member name "${m.name}"` };
            seen.add(lname);
            const memberResolved = resolveVarType(struct, m.type);
            if (!memberResolved.ok) return { ok: false, error: `member "${m.name}": ${memberResolved.error}` };
            builtMembers.push({ id: newVarId(), name: m.name.trim(), type: memberResolved.type, initialValue: m.initialValue ?? '' });
          }
          dtType = 'Structure';
          content = { members: builtMembers };
          summaryShape = `STRUCT { ${builtMembers.map((m) => `${m.name}:${m.type}`).join('; ')} }`;
        } else if (kind === 'ENUM') {
          const values = Array.isArray(args.values) ? args.values : [];
          if (values.length === 0) return { ok: false, error: 'values is required for an ENUM data type' };
          const seen = new Set();
          const builtValues = [];
          for (const raw of values) {
            const vname = String(typeof raw === 'string' ? raw : raw?.name || '').trim();
            if (!vname || !isValidIecName(vname)) return { ok: false, error: `invalid enum member name "${vname}"` };
            const lname = vname.toLowerCase();
            if (seen.has(lname)) return { ok: false, error: `duplicate enum member name "${vname}"` };
            seen.add(lname);
            builtValues.push({ id: newVarId(), name: vname, value: (typeof raw === 'object' && raw?.value != null) ? raw.value : '' });
          }
          dtType = 'Enumerated';
          content = { values: builtValues };
          summaryShape = `ENUM (${builtValues.map((v) => v.name).join(', ')})`;
        } else {
          return { ok: false, error: `kind must be ARRAY, STRUCT, or ENUM (got "${args.kind}")` };
        }

        const entry = { id: newVarId(), name: trimmedName, type: dtType, content };
        const next = { ...struct, dataTypes: [...(struct.dataTypes || []), entry] };
        return {
          mutation: true, ok: true, summary: `Create data type ${trimmedName} = ${summaryShape}`,
          diff: { kind: 'datatype-add', target: trimmedName, lines: [{ type: 'add', text: `${trimmedName} : ${summaryShape}` }] },
          next,
        };
      }

      // ask_user never reaches here — AiAgentPanel intercepts it so the loop can
      // pause for a human. If it does, something bypassed that intercept.
      case 'ask_user':
        return { ok: false, error: 'ask_user is handled by the panel, not the tool executor' };

      default:
        return { ok: false, error: `unknown tool "${name}"` };
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ── formatting helpers ───────────────────────────────────────────────────────

function varLine(v) {
  let s = `${v.name} : ${v.type}`;
  if (v.initialValue !== '' && v.initialValue != null) s += ` := ${v.initialValue}`;
  if (v.address) s += `  AT ${v.address}`;
  if (v.description) s += `  // ${v.description}`;
  return s;
}

function singular(category) {
  return { programs: 'program', functionBlocks: 'function block', functions: 'function' }[category] || category;
}

// The ST editor box holds only the POU BODY — variables live in the variable
// table. Models often wrap the code in declarations/headers a body must not
// contain; strip them deterministically, leaving just the executable statements.
function stripStWrappers(code) {
  let c = String(code || '');
  c = c.replace(/^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION)\b[^\n]*\r?\n/i, '');           // PROGRAM/FUNCTION header
  // CODESYS-style OOP that this editor doesn't model — weak models emit it.
  // METHOD <name> : <type> … END_METHOD: drop the header + END_METHOD so the
  // inner statements survive as the program body (the METHOD-local VARs are
  // recovered by extractStDeclarations; a method-style `RETURN <value>;` is
  // meaningless in a program body so it's dropped — a bare `RETURN;` is kept).
  c = c.replace(/^[ \t]*(METHOD|PROPERTY|ACTION)\b[^\n]*\r?\n/gim, '');               // METHOD/PROPERTY/ACTION header
  c = c.replace(/\r?\n?[ \t]*END_(METHOD|PROPERTY|ACTION)\b\s*;?/gi, '\n');           // their footers
  c = c.replace(/^[ \t]*RETURN[ \t]+[^;\n]+;?[ \t]*$/gim, '');                        // RETURN <value>; (method-style)
  // pseudo-program wrapper  name()\nBEGIN  (only when name() is followed by BEGIN,
  // so legit no-arg FB calls like `pulse();` are never touched).
  c = c.replace(/^[ \t]*[A-Za-z_]\w*[ \t]*\([ \t]*\)[ \t]*\r?\n[ \t]*BEGIN\b[^\n]*\r?\n/gim, '');
  c = c.replace(/\r?\n\s*END_(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s*;?\s*$/i, '\n');     // footer
  c = c.replace(/\bVAR(_INPUT|_OUTPUT|_IN_OUT|_GLOBAL|_TEMP|_EXTERNAL|_CONSTANT)?\b[\s\S]*?\bEND_VAR\b\s*;?/gi, ''); // VAR…END_VAR
  c = c.replace(/^\s*BEGIN\s*$/gim, '');                                             // stray Pascal-ish BEGIN
  c = c.replace(/^\s*END\s*;?\s*$/gim, '');                                          // bare END (not END_IF/END_WHILE/…)
  // Bare declaration lines `name : TYPE [:= value];` (statements use :=, never `: type`).
  c = c.replace(/^\s*[A-Za-z_]\w*\s*:\s*[A-Za-z_]\w*(\s*\[[^\]]*\])?(\s*:=\s*[^;\n]+)?\s*;?\s*$/gim, '');
  return c.replace(/^\s*\n+/, '').replace(/\s+$/, '') + '\n';
}

// Map a VAR-block keyword to the editor's variable `class`. Anything we don't
// recognise (plain VAR, VAR_CONSTANT) becomes a Local.
const VAR_CLASS_MAP = {
  VAR_GLOBAL: 'Global', VAR_INPUT: 'Input', VAR_OUTPUT: 'Output',
  VAR_IN_OUT: 'InOut', VAR_EXTERNAL: 'External', VAR_TEMP: 'Temp',
};

// Weak models routinely inline declarations into set_st_code's body as
// VAR…END_VAR blocks (and bare `name : TYPE;` lines) instead of calling
// add_variable. stripStWrappers throws those away, so the variables would
// silently never reach the table — leaving the ST referencing undefined names.
// This recovers them: parse the declarations the body shouldn't contain and
// hand them back so set_st_code can add them as a safety net.
//
// Returns [{ scope:'local'|'global', name, type, initialValue, class }].
function extractStDeclarations(code) {
  const src = String(code || '');
  const decls = [];
  const seen = new Set();
  const pushDecl = (cls, names, type, init) => {
    const scope = cls === 'Global' ? 'global' : 'local';
    for (const raw of names.split(',')) {
      const name = raw.trim();
      if (!isValidIecName(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      decls.push({ scope, name, type: type.trim(), initialValue: (init || '').trim(), class: cls });
    }
  };
  // 1) Declarations inside VAR…END_VAR blocks (class taken from the keyword).
  const blockRe = /\bVAR(_INPUT|_OUTPUT|_IN_OUT|_GLOBAL|_TEMP|_EXTERNAL|_CONSTANT)?\b([\s\S]*?)\bEND_VAR\b/gi;
  let m;
  while ((m = blockRe.exec(src)) !== null) {
    const kw = ('VAR' + (m[1] || '')).toUpperCase();
    const cls = VAR_CLASS_MAP[kw] || 'Local';
    parseDeclLines(m[2], cls, pushDecl);
  }
  // 2) Bare top-level declaration lines outside any VAR block (also stripped by
    // stripStWrappers). Only count lines that look like a declaration, not a `:=`
    // assignment statement.
  const withoutBlocks = src.replace(blockRe, '');
  parseDeclLines(withoutBlocks, 'Local', pushDecl, /* bareOnly */ true);
  return decls;
}

// Parse `a, b : TYPE := init;` style lines from a chunk of text.
function parseDeclLines(chunk, cls, push, bareOnly = false) {
  for (let line of String(chunk || '').split(/\r?\n/)) {
    line = line.replace(/\/\/.*$/, '').trim();           // drop line comment
    if (!line) continue;
    line = line.replace(/;+\s*$/, '');                   // drop trailing semicolons
    // name[, name…] [AT %addr] : TYPE [:= init]   — `:=` before the `:` means it's a statement.
    const dm = line.match(/^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:AT\s+\S+\s*)?:\s*([A-Za-z_]\w*(?:\s*\[[^\]]*\])?)\s*(?::=\s*(.+))?$/i);
    if (!dm) continue;
    if (/:=/.test(dm[1])) continue;                      // left side had `:=` → assignment, skip
    push(cls, dm[1], dm[2], dm[3]);
  }
}

// ── program "tokenizer": faithful, model-readable rendering of a ladder ───────
//
// summarizeRungs only lists block TYPES — the model can't reason about the
// logic. renderRungs traces each rung's power-flow graph (left rail → contacts/
// FBs → coils) and renders it as boolean logic the model can actually read and
// reason about (and that mirrors set_ladder's DSL): a contact is `var` (NO) or
// `NOT var` (NC); series = AND, parallel/converging edges = OR; a coil becomes
// `coil := <expr>` (with SET/RESET/NOT tags). Rungs containing function blocks
// are still listed structurally (FBs are opaque to pure boolean rendering).

const LEFT_RAIL_ID = 'terminal_left_middle';

function andJoin(terms) {
  const t = terms.filter((x) => x && x !== 'TRUE');
  if (t.length === 0) return 'TRUE';
  if (t.length === 1) return t[0];
  return t.map((x) => (/[ ]OR[ ]| AND /.test(x) ? `(${x})` : x)).join(' AND ');
}
function orJoin(terms) {
  const seen = new Set();
  const t = [];
  for (const x of terms) { if (x && !seen.has(x)) { seen.add(x); t.push(x); } }
  if (t.some((x) => x === 'TRUE')) return 'TRUE';
  if (t.length === 0) return 'TRUE';
  if (t.length === 1) return t[0];
  return t.map((x) => (/ AND /.test(x) ? `(${x})` : x)).join(' OR ');
}

function renderRungs(rungs) {
  return (rungs || []).map((r, i) => {
    // SCL rungs may be ST — surface the code verbatim.
    if (r.lang === 'ST') return { index: i, comment: r.comment || '', lang: 'ST', code: r.code || '' };

    const blocks = r.blocks || [];
    const conns = r.connections || [];
    const byId = {};
    blocks.forEach((b) => { byId[b.id] = b; });
    const incoming = {};
    conns.forEach((c) => { (incoming[c.target] || (incoming[c.target] = [])).push(c.source); });

    const contactLit = (b) => {
      const v = b.data?.values?.var || b.data?.instanceName || '?';
      const sub = b.data?.subType || b.data?.customData?.subType;
      if (sub === 'NC') return `NOT ${v}`;
      if (sub === 'Rising') return `RISING(${v})`;
      if (sub === 'Falling') return `FALLING(${v})`;
      return v;
    };

    const memo = {};
    const exprOf = (id, seen) => {
      if (id === LEFT_RAIL_ID) return 'TRUE';
      if (memo[id] !== undefined) return memo[id];
      if (seen.has(id)) return '/*loop*/';
      const s2 = new Set(seen); s2.add(id);
      const srcs = incoming[id] || [];
      const power = srcs.length ? orJoin(srcs.map((s) => exprOf(s, s2))) : 'TRUE';
      const b = byId[id];
      let res = power;
      if (b && b.type === 'Contact') res = andJoin([power, contactLit(b)]);
      else if (b && b.type !== 'Coil') {
        // FB: downstream power continues from its boolean output pin.
        const q = FB_Q_OUTPUT[b.type] || 'Q';
        res = `${b.data?.instanceName || b.type}.${q}`;
      }
      memo[id] = res;
      return res;
    };

    const coils = blocks.filter((b) => b.type === 'Coil');
    const logic = coils.map((c) => {
      const v = c.data?.values?.coil || c.data?.instanceName || '?';
      const sub = c.data?.subType || c.data?.customData?.subType || 'Normal';
      const drive = exprOf(c.id, new Set());
      const tag = { Set: 'SET when ', Reset: 'RESET when ', Negated: 'NOT (' }[sub] || '';
      const close = sub === 'Negated' ? ')' : '';
      return `${v} := ${tag}${drive}${close}`;
    });

    const out = { index: i, comment: r.comment || '', logic };
    const fbs = blocks.filter((b) => b.type !== 'Contact' && b.type !== 'Coil' && !String(b.id).startsWith('terminal'));
    if (fbs.length) {
      // Faithful FB rendering: the trigger condition (power into the trigger
      // pin), the pin values, and the Q pin downstream logic reads from — so
      // the model can reconstruct the rung, not just know "there's a timer".
      out.functionBlocks = fbs.map((b) => {
        const trig = FB_TRIGGER_PIN[b.type] || null;
        // Power into the FB = OR of its incoming power-flow wires. exprOf(fb)
        // returns the fb's OWN output, so compute the input side directly.
        const powerSrcs = conns
          .filter((c) => c.target === b.id && (!c.targetPin || c.targetPin === 'in' || c.targetPin === 'in_0' || (trig && c.targetPin === `in_${trig}`)))
          .map((c) => exprOf(c.source, new Set()));
        return {
          type: b.type,
          instance: b.data?.instanceName || null,
          triggeredBy: powerSrcs.length ? orJoin(powerSrcs) : 'TRUE',
          pins: b.data?.values && Object.keys(b.data.values).length ? { ...b.data.values } : undefined,
          qOutput: FB_Q_OUTPUT[b.type] || undefined,
        };
      });
    }
    if (logic.length === 0 && fbs.length === 0) out.note = '(empty rung)';
    return out;
  });
}

// ── live-data buffer summarizer (diagnosis aid) ───────────────────────────────
//
// The panel keeps a rolling ring buffer of timestamped live-variable snapshots
// while the program runs. This condenses it into a compact per-variable
// time-series the model can reason about: last/first/min/max, how many times it
// changed, a flag (constant / oscillating), and a short recent (down-sampled)
// series — enough to see a value stuck, oscillating, drifting, or out of range
// WITHOUT shipping hundreds of raw samples. `samples` = [{ t:ms, v:{name:val} }].
// Condense ONE variable's value series into a compact stat block: first/last,
// numeric min/max, change count, a classification flag, and a down-sampled tail.
function summarizeSeries(series, maxRecent = 16) {
  const num = (x) => (typeof x === 'boolean' ? (x ? 1 : 0) : (typeof x === 'number' ? x : Number(x)));
  let min = Infinity, max = -Infinity, changes = 0, prev, prevN;
  let nonDecr = true, nonIncr = true;
  const distinct = new Set();
  for (const raw of series) {
    const n = num(raw);
    if (Number.isFinite(n)) {
      if (n < min) min = n; if (n > max) max = n;
      if (prevN !== undefined) { if (n < prevN) nonDecr = false; if (n > prevN) nonIncr = false; }
      prevN = n;
    }
    if (prev !== undefined && raw !== prev) changes++;
    distinct.add(raw);
    prev = raw;
  }
  // Down-sample the recent tail to at most maxRecent points.
  const step = Math.max(1, Math.ceil(series.length / maxRecent));
  const recent = series.filter((_, k) => k % step === 0).slice(-maxRecent);
  // Classify the trace so the model gets a hint without parsing the series:
  // constant (never changed), oscillating (few distinct values, many flips),
  // or a monotonic rising/falling ramp.
  const flags = [];
  if (changes === 0) flags.push('constant');
  else if (distinct.size <= 3 && changes >= 4) flags.push('oscillating');
  else if (nonDecr) flags.push('rising');
  else if (nonIncr) flags.push('falling');
  return {
    last: series[series.length - 1],
    first: series[0],
    ...(Number.isFinite(min) ? { min, max } : {}),
    changes,
    ...(flags.length ? { flags } : {}),
    recent,
  };
}

export function summarizeLiveSamples(samples, opts = {}) {
  const buf = Array.isArray(samples) ? samples : [];
  if (buf.length === 0) return null;
  const maxRecent = opts.maxRecent || 16;
  const t0 = buf[0].t, t1 = buf[buf.length - 1].t;
  const names = new Set();
  buf.forEach((s) => Object.keys(s.v || {}).forEach((n) => names.add(n)));

  const variables = {};
  for (const name of names) {
    const series = buf.map((s) => s.v?.[name]).filter((x) => x !== undefined && x !== null);
    if (series.length === 0) continue;
    variables[name] = summarizeSeries(series, maxRecent);
  }
  return { windowSeconds: Math.round((t1 - t0) / 100) / 10, samples: buf.length, variables };
}

// Per-variable trailing-window summary for the ACTIVE watch tool. Each spec
// { name, seconds } is summarized over ONLY the last `seconds` of buffered
// samples, so different variables can be observed for different durations in a
// single watch call. The panel does the real-time waiting; this just slices.
export function summarizeWatch(samples, specs, opts = {}) {
  const buf = Array.isArray(samples) ? samples : [];
  if (buf.length === 0) return null;
  const maxRecent = opts.maxRecent || 24;
  const tEnd = buf[buf.length - 1].t;
  const variables = {};
  for (const spec of (Array.isArray(specs) ? specs : [])) {
    const name = spec?.name;
    if (!name) continue;
    const secs = Number(spec.seconds) > 0 ? Number(spec.seconds) : null;
    const since = secs ? tEnd - secs * 1000 : -Infinity;
    const series = buf.filter((s) => s.t >= since)
      .map((s) => s.v?.[name]).filter((x) => x !== undefined && x !== null);
    if (series.length === 0) {
      variables[name] = { watchedSeconds: secs, samples: 0, note: 'no samples in window (name not streamed, or not running)' };
      continue;
    }
    variables[name] = { watchedSeconds: secs, samples: series.length, ...summarizeSeries(series, maxRecent) };
  }
  return { variables };
}

// ── ladder compiler ──────────────────────────────────────────────────────────
//
// Turns a high-level rung DSL into the editor's block/connection graph. Power
// flows left rail → contact network → coils → right rail. OR is encoded as
// multiple branches converging on the same merge point; AND as a series chain
// (the transpiler ORs all incoming power-flow edges and ANDs series). Supports
// contacts + coils only — function blocks need library pin metadata the agent
// doesn't carry, so those stay in ST for now.

const LEFT_RAIL = 'terminal_left_middle';
const RIGHT_RAIL = 'terminal_right_middle';
const LD_COL = 90;   // horizontal spacing between elements
const LD_ROW = 80;   // vertical spacing between parallel branches
const LD_X0 = 60;    // first column x (just right of the left rail)

// ── Vertical placement: sit ON the rung's power line ─────────────────────────
// ⚠️ A block's POWER HANDLE must land on the power line, not the block's top
// edge. The editor draws that line at RungContainer's `MIDDLE_Y` and, on
// drag/drop, snaps a node to `MIDDLE_Y - <handle offset measured from the DOM>`
// (RungContainer `powerHandleOffsetY`, which returns FLOW units — it divides by
// scaleFactor). Agent-authored blocks never travel that path, so they have to
// carry the same arithmetic with the node geometry inlined. These used to all
// be y=0, which parked every contact and coil at the TOP of the rung, ~75px
// above the rail, with every wire running diagonally to reach it.
// Keep in sync with RungContainer: MIN_RUNG_HEIGHT and the node boxes.
const LD_MIDDLE_Y = 75;                                    // = MIN_RUNG_HEIGHT (150) / 2
const LD_CONTACT_Y = LD_MIDDLE_Y - 27 / 2;                 // contact/coil box is 27×27, handle at top:50%
// An FB's power handle is its TRIGGER ROW, not its middle: instance bar (~17)
// + label bar (~21) + body top padding (8) + half a pin row (~9). Approximate
// by nature (row height depends on the pin's controls) — the editor's magnet
// (POWER_SNAP_DRAG = 16px) absorbs the residual, and any drag re-snaps it
// exactly from the DOM.
const LD_FB_Y = LD_MIDDLE_Y - 55;

const CONTACT_SUBS = ['NO', 'NC', 'Rising', 'Falling'];
const COIL_SUBS = ['Normal', 'Set', 'Reset', 'Negated', 'Rising', 'Falling'];
// Comparison/arithmetic names a model reaches for when it wants a COMPARISON but
// only has contacts to work with. Silently normalizing these to "NO" produced a
// program with nothing to do with the request (observed: `{contact:"counter",
// subType:"EQ"}` + `{contact:"10"}` became `counter AND 10`), so they get a
// routing error instead.
const COMPARISON_SUBS = new Set(['EQ', 'NE', 'GT', 'GE', 'LT', 'LE', '=', '<>', '>', '>=', '<', '<=']);

// Lenient variants for DISPLAY only (ladderRungText renders the approval diff
// and must never throw). Compilation uses the strict req* pair below.
function normContactSub(s) { return CONTACT_SUBS.includes(s) ? s : 'NO'; }
function normCoilSub(s) { return COIL_SUBS.includes(s) ? s : 'Normal'; }

// ⚠️ Unknown subTypes ERROR rather than falling back. A silent fallback turns a
// model's misunderstanding into a plausible-looking but wrong program, and the
// model never learns it asked for something ladder can't express.
function reqContactSub(s, idx) {
  if (s == null || s === '') return 'NO';
  if (CONTACT_SUBS.includes(s)) return s;
  if (COMPARISON_SUBS.has(String(s).toUpperCase())) {
    throw new Error(`rung ${idx + 1}: "${s}" is a COMPARISON, not a contact type. Ladder contacts only test a BOOL (${CONTACT_SUBS.join('/')}). Put the comparison in an ST rung (set_st_code), e.g. "IF counter >= 10 THEN …".`);
  }
  throw new Error(`rung ${idx + 1}: unknown contact subType "${s}" — use one of ${CONTACT_SUBS.join(', ')}.`);
}
function reqCoilSub(s, idx) {
  if (s == null || s === '') return 'Normal';
  if (COIL_SUBS.includes(s)) return s;
  throw new Error(`rung ${idx + 1}: unknown coil subType "${s}" — use one of ${COIL_SUBS.join(', ')}.`);
}

// A contact/coil drives BOOLEAN power flow, so its target must be a BOOL. An
// undeclared name is fine (auto-declared as BOOL later); a name already declared
// as something else is not — it silently produced invalid IEC (a coil assigning
// power flow into an INT) that only failed much later, in generated C.
// Member access (`blink.Q`) is allowed through: it addresses an FB output pin.
function checkBoolTarget(ctx, kind, name, idx) {
  if (!isValidIecName(name)) {
    if (String(name).includes('.')) return;  // FB output pin, e.g. blink.Q
    throw new Error(`rung ${idx + 1}: ${kind} "${name}" is not a variable name. Contacts and coils reference BOOL variables — a literal or expression must go in an ST rung (set_st_code).`);
  }
  const struct = ctx.struct;
  if (!struct) return;
  const local = (ctx.pou?.content?.variables || []).find((v) => v.name === name);
  const global = getGlobals(struct).find((v) => v.name === name);
  const found = local || global;
  if (found && String(found.type).toUpperCase() !== 'BOOL') {
    throw new Error(`rung ${idx + 1}: ${kind} "${name}" is ${found.type}, but contacts and coils only work on BOOL. Use a different BOOL variable, or express this in an ST rung (set_st_code).`);
  }
}

// Resolve a function-block type into its pin metadata, searching (in order):
// the standard XML library, the generic comm-FB defs, and the project's own
// function blocks. Returns { inputs, outputs, isUser, customData } or null.
// customData is EXACTLY what the Toolbox drag attaches for the same block, so
// an agent-authored FB block is indistinguishable from a human-dropped one
// (the editor renders pins from customData; the transpiler reads user-FB pins
// from customData.content.variables).
function resolveFbBlockDef(struct, library, type) {
  for (const cat of (Array.isArray(library) ? library : [])) {
    for (const b of (cat.blocks || [])) {
      if (b.blockType === type) {
        return {
          inputs: b.inputs || [], outputs: b.outputs || [], isUser: false,
          customData: { inputs: b.inputs || [], outputs: b.outputs || [], class: b.class || 'FunctionBlock' },
        };
      }
    }
  }
  if (GENERIC_FB_DEFS[type]) {
    const d = GENERIC_FB_DEFS[type];
    return {
      inputs: d.inputs || [], outputs: d.outputs || [], isUser: false,
      customData: { inputs: d.inputs || [], outputs: d.outputs || [], class: d.class || 'FunctionBlock' },
    };
  }
  const userFb = (struct.functionBlocks || []).find((p) => p.name === type);
  if (userFb) {
    const { inputs, outputs } = pouPins(userFb);
    // Mirror the editor's drop path: user-FB blocks carry the whole POU-ish
    // object so the transpiler can read content.variables.
    return { inputs, outputs, isUser: true, customData: { name: userFb.name, type: 'functionBlocks', content: userFb.content } };
  }
  return null;
}

function compileLadderRung(r, idx, ctx = {}) {
  if (!r || typeof r !== 'object') throw new Error(`rung ${idx + 1} is not an object`);
  const outputs = Array.isArray(r.outputs) ? r.outputs : [];
  const fb = r.fb && typeof r.fb === 'object' ? r.fb : null;
  if (outputs.length === 0 && !fb) throw new Error(`rung ${idx + 1} has no output coil (and no fb)`);

  const blocks = [];
  const connections = [];
  let seq = 0;
  const stamp = Date.now();
  const bid = () => `block_${stamp}_${idx}_${seq++}`;
  const cid = () => `conn_${stamp}_${idx}_${seq++}`;
  const connect = (source, target, sourcePin = 'out', targetPin = 'in') =>
    connections.push({ id: cid(), source, target, sourcePin, targetPin });

  const mkContact = (c, x, y) => {
    if (!c || !c.contact) throw new Error(`rung ${idx + 1}: a contact is missing its variable name`);
    const sub = reqContactSub(c.subType, idx);
    checkBoolTarget(ctx, 'contact', String(c.contact), idx);
    const id = bid();
    blocks.push({ id, type: 'Contact', position: { x, y }, data: { label: 'Contact', instanceName: c.contact, customData: { subType: sub }, subType: sub, values: { var: c.contact } } });
    return id;
  };
  const mkCoil = (o, x, y) => {
    if (!o || !o.coil) throw new Error(`rung ${idx + 1}: an output is missing its coil variable name`);
    const sub = reqCoilSub(o.subType, idx);
    checkBoolTarget(ctx, 'coil', String(o.coil), idx);
    const id = bid();
    blocks.push({ id, type: 'Coil', position: { x, y }, data: { label: 'Coil', instanceName: o.coil, customData: { subType: sub }, subType: sub, values: { coil: o.coil } } });
    return id;
  };

  // ── Optional function block (timer/counter/edge/comm/user FB) in the rung ──
  // Power flows: contact network → FB trigger pin → FB Q output → coils.
  // Non-trigger inputs (PT, PV, R, …) and output captures (ET, CV, …) ride in
  // data.values keyed by PIN NAME — exactly how the editor stores them.
  let fbDef = null, fbTrigger = null, fbQ = null, fbValues = {};
  if (fb) {
    if (!fb.type) throw new Error(`rung ${idx + 1}: fb.type is required`);
    if (!fb.instance || !isValidIecName(fb.instance)) throw new Error(`rung ${idx + 1}: fb.instance must be a valid IEC identifier (the instance variable name, e.g. "timer0")`);
    // Inline math/move/compare check FIRST — it is type-table-based and must
    // fire even when the block library isn't loaded/passed.
    if (FB_TRIGGER_PIN[fb.type] === 'EN') throw new Error(`rung ${idx + 1}: "${fb.type}" is an inline math/move/compare operation — express it in an ST rung (set_st_code) instead of ladder`);
    fbDef = resolveFbBlockDef(ctx.struct, ctx.library, fb.type);
    if (!fbDef) throw new Error(`rung ${idx + 1}: unknown block type "${fb.type}" — call list_blocks to see available types`);
    if ((fbDef.inputs || []).some((p) => p.type === 'AXIS_REF')) throw new Error(`rung ${idx + 1}: "${fb.type}" is a motion FB (needs an Axis) — author motion in an ST rung (set_st_code)`);
    const inputNames = (fbDef.inputs || []).map((p) => p.name);
    const outputNames = (fbDef.outputs || []).map((p) => p.name);
    // Shared with buildBlockCatalog so the pins the model is TOLD about are
    // exactly the pins wired here.
    ({ trigger: fbTrigger, powerOutput: fbQ } = powerPins(fb.type, fbDef.inputs, fbDef.outputs));
    if (outputs.length > 0 && !fbQ) throw new Error(`rung ${idx + 1}: "${fb.type}" has no boolean output to drive coils — remove the outputs or use ST`);
    // ctx.collect gathers auto-declare candidates WITH pin-accurate types:
    // an identifier fed to a TIME pin declares as TIME, a CTU.R reference as
    // BOOL, an ET capture as TIME — not a blanket BOOL guess.
    const pinType = (arr, pin) => (arr.find((p) => p.name === pin) || {}).type || 'BOOL';
    const isIdentRef = (v) => isValidIecName(String(v)) && !/^(true|false)$/i.test(String(v));
    for (const [pin, val] of Object.entries(fb.inputs || {})) {
      if (!inputNames.includes(pin)) throw new Error(`rung ${idx + 1}: "${fb.type}" has no input pin "${pin}" (inputs: ${inputNames.join(', ') || 'none'})`);
      fbValues[pin] = String(val);
      if (isIdentRef(val)) ctx.collect?.({ name: String(val), type: pinType(fbDef.inputs, pin), isInstance: false });
    }
    for (const [pin, val] of Object.entries(fb.outputs || {})) {
      if (!outputNames.includes(pin)) throw new Error(`rung ${idx + 1}: "${fb.type}" has no output pin "${pin}" (outputs: ${outputNames.join(', ') || 'none'})`);
      if (!isValidIecName(String(val))) throw new Error(`rung ${idx + 1}: fb.outputs.${pin} must be a variable NAME to store the pin into (got "${val}")`);
      fbValues[pin] = String(val);
      ctx.collect?.({ name: String(val), type: pinType(fbDef.outputs, pin), isInstance: false });
    }
  }

  const branches = (Array.isArray(r.branches) && r.branches.length) ? r.branches : [[]];
  const after = Array.isArray(r.seriesAfter) ? r.seriesAfter : [];
  const maxLen = Math.max(0, ...branches.map((b) => (Array.isArray(b) ? b.length : 0)));

  // Post-merge series chain: seriesAfter contacts → optional FB → output coils.
  let colX = LD_X0 + (maxLen + 1) * LD_COL;
  const chainIds = [];
  const chainInPins = [];  // target pin name for the wire INTO each chain element
  const chainOutPins = []; // source pin name for the wire OUT of each chain element
  for (const c of after) { chainIds.push(mkContact(c, colX, LD_CONTACT_Y)); chainInPins.push('in'); chainOutPins.push('out'); colX += LD_COL; }
  if (fb) {
    const id = bid();
    blocks.push({
      id, type: fb.type, position: { x: colX, y: LD_FB_Y },
      data: { label: fb.type, instanceName: fb.instance, customData: fbDef.customData, values: fbValues },
    });
    chainIds.push(id);
    // Editor handles are name-based (`in_IN`, `out_Q`); the transpiler reads
    // the same names for power flow. User FBs without a boolean output pass
    // power through unconditionally (the transpiler handles sourcePin loosely,
    // but the editor needs a REAL handle to draw the wire).
    chainInPins.push(fbTrigger ? `in_${fbTrigger}` : 'in');
    chainOutPins.push(fbQ ? `out_${fbQ}` : 'out');
    colX += LD_COL * 2; // FB nodes are wider than contacts
  }
  for (const o of outputs) { chainIds.push(mkCoil(o, colX, LD_CONTACT_Y)); chainInPins.push('in'); chainOutPins.push('out'); colX += LD_COL; }
  const mergeTarget = chainIds[0];
  const mergePin = chainInPins[0];

  // Branches (OR): each is an AND-series of contacts from the left rail to the merge point.
  branches.forEach((b, bi) => {
    // Branch 0 rides the power line; extra parallel branches stack below it.
    const y = LD_CONTACT_Y + bi * LD_ROW;
    let prev = LEFT_RAIL;
    (Array.isArray(b) ? b : []).forEach((c, ci) => {
      const id = mkContact(c, LD_X0 + ci * LD_COL, y);
      connect(prev, id);
      prev = id;
    });
    connect(prev, mergeTarget, 'out', mergePin); // empty branch → direct power from the left rail
  });

  // Series-chain the merge target through to the right rail.
  for (let i = 0; i < chainIds.length - 1; i++) connect(chainIds[i], chainIds[i + 1], chainOutPins[i], chainInPins[i + 1]);
  connect(chainIds[chainIds.length - 1], RIGHT_RAIL, chainOutPins[chainIds.length - 1], 'in');

  return {
    id: `rung_${stamp}_${idx}_${Math.floor(Math.random() * 1e6)}`,
    label: String(idx).padStart(3, '0'),
    comment: r.comment || '',
    blocks,
    connections,
    code: '',
  };
}

// Human-readable boolean form of a rung DSL, for the approval diff.
function ladderRungText(r) {
  const contactStr = (c) => {
    const sub = normContactSub(c?.subType);
    const prefix = sub === 'NC' ? '!' : sub === 'Rising' ? '↑' : sub === 'Falling' ? '↓' : '';
    return prefix + (c?.contact || '?');
  };
  const coilStr = (o) => {
    const tag = { Set: ' (S)', Reset: ' (R)', Negated: ' (/)' }[normCoilSub(o?.subType)] || '';
    return (o?.coil || '?') + tag;
  };
  const branches = (Array.isArray(r?.branches) && r.branches.length) ? r.branches : [[]];
  const brTexts = branches.map((b) => (Array.isArray(b) && b.length ? b.map(contactStr).join(' & ') : 'TRUE'));
  let cond = brTexts.length > 1 ? `(${brTexts.join(' | ')})` : brTexts[0];
  const after = Array.isArray(r?.seriesAfter) ? r.seriesAfter : [];
  if (after.length) cond += ' & ' + after.map(contactStr).join(' & ');
  if (r?.fb && r.fb.type) {
    const ins = Object.entries(r.fb.inputs || {}).map(([k, v]) => `${k}:=${v}`);
    const outsMap = Object.entries(r.fb.outputs || {}).map(([k, v]) => `${k}⇒${v}`);
    const params = [...ins, ...outsMap].join(', ');
    cond += `  →  [${r.fb.type} ${r.fb.instance || '?'}${params ? ` (${params})` : ''}]`;
  }
  const outs = (Array.isArray(r?.outputs) ? r.outputs : []).map(coilStr).join(', ');
  return outs ? `${cond}  →  ${outs}` : cond;
}
