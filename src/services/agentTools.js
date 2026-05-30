/*
 * agentTools.js — the AI agent's action surface over the PLC project.
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

const POU_CATEGORIES = ['programs', 'functionBlocks', 'functions'];
const RESOURCE_TYPE = 'RESOURCE_EDITOR';

// ── small immutable helpers ──────────────────────────────────────────────────

// IEC 61131-3 identifier: starts with a letter or underscore, then letters /
// digits / underscores. No spaces or punctuation. Used for POU + variable names.
const IEC_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isValidIecName = (n) => IEC_NAME_RE.test(String(n || '').trim());

function findPOU(struct, name) {
  // Trim + case-insensitive so whitespace/case differences never cause a miss.
  const lname = String(name || '').trim().toLowerCase();
  for (const category of POU_CATEGORIES) {
    const list = struct[category] || [];
    const idx = list.findIndex((p) => (p.name || '').trim().toLowerCase() === lname);
    if (idx >= 0) return { category, index: idx, item: list[idx] };
  }
  return null;
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

function makeVar(scope, { name, type, initialValue = '', address = '', description = '', class: cls }) {
  return {
    id: newVarId(),
    name,
    class: cls || (scope === 'global' ? 'Global' : 'Local'),
    type: type || 'BOOL',
    initialValue: initialValue ?? '',
    description: description ?? '',
    address: address ?? '',
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

// ── tool definitions (sent to the model) ─────────────────────────────────────

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });

export const TOOL_DEFS = [
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
    description: 'Read the CURRENT live values of variables from the running simulation/PLC. Use this to analyze actual runtime behaviour (e.g. a value stuck, oscillating, or out of range) before proposing a code fix. Only returns data while the program is running.',
    parameters: S({}),
  },
  {
    name: 'create_pou',
    description: 'Create a new, empty POU. Use language "ST" for Structured Text or "LD" for Ladder.',
    parameters: S({
      category: { type: 'string', enum: ['programs', 'functionBlocks', 'functions'] },
      name: str('Unique POU name'),
      language: { type: 'string', enum: ['ST', 'LD'] },
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
    description: 'Replace the entire Structured Text body of an ST POU. Provide complete, valid IEC 61131-3 ST. The variables it uses must already exist (add them with add_variable) or be global.',
    parameters: S({ pou: str('Target ST POU name'), code: str('The full new ST source') }, ['pou', 'code']),
  },
  {
    name: 'set_ladder',
    description:
      'Replace the ENTIRE ladder (all rungs) of an LD POU. Express each rung as a boolean network of CONTACTS driving one or more output COILS. ' +
      'A rung = OR of `branches` (each branch is an AND-series of contacts), optionally followed by `seriesAfter` contacts (in series after the OR-merge — e.g. a normally-closed Stop for a seal-in), then `outputs` coils. ' +
      'Contact subType: "NO" (normally open) or "NC" (normally closed). Coil subType: "Normal", "Set", "Reset" or "Negated". ' +
      'Every contact/coil variable must be a BOOL that already exists (add it with add_variable first). ' +
      'Each rung is an OBJECT (use {…}, never [...]). Example — Start/Stop seal-in driving Motor: ' +
      'rungs: [{ "branches": [[{"contact":"Start"}], [{"contact":"Motor"}]], "seriesAfter": [{"contact":"Stop","subType":"NC"}], "outputs": [{"coil":"Motor"}] }]. ' +
      'Simplest rung — coil driven directly from power (no contacts): rungs: [{ "outputs": [{"coil":"mc_power"}] }]. ' +
      'Note: this tool supports contacts and coils only — for timers, counters or other function blocks in ladder, use ST instead.',
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
            items: { type: 'array', items: S({ contact: str('BOOL variable name'), subType: { type: 'string', enum: ['NO', 'NC'] } }, ['contact']) },
          },
          seriesAfter: {
            type: 'array',
            description: 'Contacts placed in series AFTER the branches merge (shared by all branches). Use for the Stop contact in a start/stop seal-in.',
            items: S({ contact: str('BOOL variable name'), subType: { type: 'string', enum: ['NO', 'NC'] } }, ['contact']),
          },
          outputs: {
            type: 'array',
            description: 'Output coils driven by the rung (usually one).',
            items: S({ coil: str('BOOL variable name'), subType: { type: 'string', enum: ['Normal', 'Set', 'Reset', 'Negated'] } }, ['coil']),
          },
        }, ['outputs']),
      },
    }, ['pou', 'rungs']),
  },
  {
    name: 'add_variable',
    description: 'Add a variable. scope "local" needs a pou; scope "global" adds a project global. Optionally give an IEC address (e.g. %MW0) to expose it via the REST/HMI API.',
    parameters: S({
      scope: { type: 'string', enum: ['local', 'global'] },
      pou: str('POU name (required when scope is local)'),
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
        const live = args.__live;
        if (!live || Object.keys(live).length === 0) {
          return { mutation: false, ok: true, result: { running: false, note: 'No live data — the program is not running.' } };
        }
        return { mutation: false, ok: true, result: { running: true, values: live } };
      }

      case 'read_pou': {
        const hit = findPOU(struct, args.name);
        if (!hit) return { ok: false, error: `POU "${args.name}" not found` };
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
            ladder: (c.rungs && hit.item.type !== 'SCL') ? summarizeRungs(c.rungs) : undefined,
            variables: (c.variables || []).map((v) => ({
              name: v.name, type: v.type, class: v.class, initialValue: v.initialValue, address: v.address, description: v.description,
            })),
          },
        };
      }

      case 'create_pou': {
        const category = args.category;
        if (!POU_CATEGORIES.includes(category)) return { ok: false, error: `invalid category "${category}"` };
        if (!args.name || !args.name.trim()) return { ok: false, error: 'name is required' };
        if (!isValidIecName(args.name)) return { ok: false, error: `invalid name "${args.name}" — POU names must be IEC identifiers (letters, digits, underscore; no spaces; can't start with a digit)` };
        if (findPOU(struct, args.name)) return { ok: false, error: `a POU named "${args.name}" already exists` };
        const language = args.language === 'LD' ? 'LD' : 'ST';
        const content = language === 'LD' ? { rungs: [], variables: [] } : { code: '', variables: [] };
        const item = {
          id: `${category}_${Date.now()}`,
          name: args.name.trim(),
          type: language,
          returnType: category === 'functions' ? (args.returnType || 'BOOL') : undefined,
          content,
        };
        const next = { ...struct, [category]: [...struct[category], item] };
        return {
          mutation: true, ok: true,
          summary: `Create ${language} ${singular(category)} "${item.name}"`,
          diff: { kind: 'pou-add', target: item.name, lines: [{ type: 'add', text: `${language} ${singular(category)}  ${item.name}${item.returnType ? ' : ' + item.returnType : ''}` }] },
          next,
        };
      }

      case 'rename_pou': {
        const hit = findPOU(struct, args.name);
        if (!hit) return { ok: false, error: `POU "${args.name}" not found` };
        if (!args.newName || !args.newName.trim()) return { ok: false, error: 'newName is required' };
        if (!isValidIecName(args.newName)) return { ok: false, error: `invalid name "${args.newName}" — must be an IEC identifier (no spaces; can't start with a digit)` };
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
        if (!hit) return { ok: false, error: `POU "${args.name}" not found` };
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
        if (!hit) return { ok: false, error: `POU "${args.pou}" not found` };
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
          const old = (content.rungs || []).filter((r) => r.lang === 'ST').map((r) => r.code || '').join('\n');
          oldCode = old;
          const rung = { id: `rung_${Date.now()}_0`, label: '000', lang: 'ST', blocks: [], connections: [], code };
          next = withPOUContent(struct, hit.category, hit.index, { ...content, rungs: [rung] });
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
        if (!hit) return { ok: false, error: `POU "${args.pou}" not found` };
        if (hit.item.type !== 'LD') return { ok: false, error: `"${args.pou}" is not a Ladder POU — use set_st_code for ST` };
        const dsl = Array.isArray(args.rungs) ? args.rungs : [];
        if (dsl.length === 0) return { ok: false, error: 'rungs must be a non-empty array' };
        let compiled;
        try { compiled = dsl.map((r, i) => compileLadderRung(r, i)); }
        catch (e) { return { ok: false, error: `ladder: ${e.message}` }; }
        const oldRungs = hit.item.content?.rungs || [];
        const next = withPOUContent(struct, hit.category, hit.index, { ...hit.item.content, rungs: compiled });
        const lines = [
          ...oldRungs.map((rg, i) => ({ type: 'del', text: `Rung ${i + 1}: ${(rg.blocks || []).map((b) => b.type).join(' ') || '(empty)'}` })),
          ...dsl.map((r, i) => ({ type: 'add', text: `Rung ${i + 1}: ${ladderRungText(r)}` })),
        ];
        return {
          mutation: true, ok: true, summary: `Set ladder in "${hit.item.name}" (${compiled.length} rung${compiled.length === 1 ? '' : 's'})`,
          diff: { kind: 'ld-edit', target: hit.item.name, lines }, next,
        };
      }

      case 'add_variable': {
        const scope = args.scope === 'global' ? 'global' : 'local';
        if (!args.name || !args.name.trim()) return { ok: false, error: 'name is required' };
        if (!isValidIecName(args.name)) return { ok: false, error: `invalid variable name "${args.name}" — must be an IEC identifier (no spaces; can't start with a digit)` };
        const v = makeVar(scope, { ...args, name: args.name.trim() });
        if (scope === 'global') {
          const globals = getGlobals(struct);
          if (globals.some((g) => (g.name || '').toLowerCase() === v.name.toLowerCase()))
            return { ok: false, error: `global "${v.name}" already exists` };
          const next = withGlobals(struct, [...globals, v]);
          return {
            mutation: true, ok: true, summary: `Add global ${v.name} : ${v.type}`,
            diff: { kind: 'var-add', target: `global ${v.name}`, lines: [{ type: 'add', text: varLine(v) }] }, next,
          };
        }
        const hit = findPOU(struct, args.pou);
        if (!hit) return { ok: false, error: `POU "${args.pou}" not found (required for local scope)` };
        const vars = hit.item.content?.variables || [];
        if (vars.some((x) => (x.name || '').toLowerCase() === v.name.toLowerCase()))
          return { ok: false, error: `"${args.pou}" already has a variable named "${v.name}"` };
        const next = withPOUContent(struct, hit.category, hit.index, { ...hit.item.content, variables: [...vars, v] });
        return {
          mutation: true, ok: true, summary: `Add ${v.name} : ${v.type} to ${hit.item.name}`,
          diff: { kind: 'var-add', target: `${hit.item.name}.${v.name}`, lines: [{ type: 'add', text: varLine(v) }] }, next,
        };
      }

      case 'update_variable': {
        const scope = args.scope === 'global' ? 'global' : 'local';
        const changes = {};
        if (args.newName != null) changes.name = String(args.newName).trim();
        if (args.type != null) changes.type = args.type;
        if (args.initialValue != null) changes.initialValue = args.initialValue;
        if (args.address != null) changes.address = args.address;
        if (args.description != null) changes.description = args.description;
        if (Object.keys(changes).length === 0) return { ok: false, error: 'no changes provided' };

        if (scope === 'global') {
          const globals = getGlobals(struct);
          const idx = globals.findIndex((g) => (g.name || '').toLowerCase() === String(args.name).toLowerCase());
          if (idx < 0) return { ok: false, error: `global "${args.name}" not found` };
          const before = globals[idx];
          const after = { ...before, ...changes };
          const next = withGlobals(struct, globals.map((g, i) => (i === idx ? after : g)));
          return {
            mutation: true, ok: true, summary: `Update global ${before.name}`,
            diff: { kind: 'var-update', target: `global ${before.name}`, lines: [{ type: 'del', text: varLine(before) }, { type: 'add', text: varLine(after) }] }, next,
          };
        }
        const hit = findPOU(struct, args.pou);
        if (!hit) return { ok: false, error: `POU "${args.pou}" not found` };
        const vars = hit.item.content?.variables || [];
        const idx = vars.findIndex((x) => (x.name || '').toLowerCase() === String(args.name).toLowerCase());
        if (idx < 0) return { ok: false, error: `"${args.pou}" has no variable "${args.name}"` };
        const before = vars[idx];
        const after = { ...before, ...changes };
        const next = withPOUContent(struct, hit.category, hit.index, { ...hit.item.content, variables: vars.map((x, i) => (i === idx ? after : x)) });
        return {
          mutation: true, ok: true, summary: `Update ${hit.item.name}.${before.name}`,
          diff: { kind: 'var-update', target: `${hit.item.name}.${before.name}`, lines: [{ type: 'del', text: varLine(before) }, { type: 'add', text: varLine(after) }] }, next,
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
        if (!hit) return { ok: false, error: `POU "${args.pou}" not found` };
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

function summarizeRungs(rungs) {
  return rungs.map((r, i) => ({
    index: i,
    comment: r.comment || '',
    blocks: (r.blocks || []).map((b) => b.type),
  }));
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

function normContactSub(s) {
  return s === 'NC' ? 'NC' : 'NO';
}
function normCoilSub(s) {
  return ['Normal', 'Set', 'Reset', 'Negated'].includes(s) ? s : 'Normal';
}

function compileLadderRung(r, idx) {
  if (!r || typeof r !== 'object') throw new Error(`rung ${idx + 1} is not an object`);
  const outputs = Array.isArray(r.outputs) ? r.outputs : [];
  if (outputs.length === 0) throw new Error(`rung ${idx + 1} has no output coil`);

  const blocks = [];
  const connections = [];
  let seq = 0;
  const stamp = Date.now();
  const bid = () => `block_${stamp}_${idx}_${seq++}`;
  const cid = () => `conn_${stamp}_${idx}_${seq++}`;
  const connect = (source, target) => connections.push({ id: cid(), source, target, sourcePin: 'out', targetPin: 'in' });

  const mkContact = (c, x, y) => {
    if (!c || !c.contact) throw new Error(`rung ${idx + 1}: a contact is missing its variable name`);
    const sub = normContactSub(c.subType);
    const id = bid();
    blocks.push({ id, type: 'Contact', position: { x, y }, data: { label: 'Contact', instanceName: c.contact, customData: { subType: sub }, subType: sub, values: { var: c.contact } } });
    return id;
  };
  const mkCoil = (o, x, y) => {
    if (!o || !o.coil) throw new Error(`rung ${idx + 1}: an output is missing its coil variable name`);
    const sub = normCoilSub(o.subType);
    const id = bid();
    blocks.push({ id, type: 'Coil', position: { x, y }, data: { label: 'Coil', instanceName: o.coil, customData: { subType: sub }, subType: sub, values: { coil: o.coil } } });
    return id;
  };

  const branches = (Array.isArray(r.branches) && r.branches.length) ? r.branches : [[]];
  const after = Array.isArray(r.seriesAfter) ? r.seriesAfter : [];
  const maxLen = Math.max(0, ...branches.map((b) => (Array.isArray(b) ? b.length : 0)));

  // Post-merge series chain: seriesAfter contacts, then output coils, left→right.
  let colX = LD_X0 + (maxLen + 1) * LD_COL;
  const chainIds = [];
  for (const c of after) { chainIds.push(mkContact(c, colX, 0)); colX += LD_COL; }
  for (const o of outputs) { chainIds.push(mkCoil(o, colX, 0)); colX += LD_COL; }
  const mergeTarget = chainIds[0];

  // Branches (OR): each is an AND-series of contacts from the left rail to the merge point.
  branches.forEach((b, bi) => {
    const y = bi * LD_ROW;
    let prev = LEFT_RAIL;
    (Array.isArray(b) ? b : []).forEach((c, ci) => {
      const id = mkContact(c, LD_X0 + ci * LD_COL, y);
      connect(prev, id);
      prev = id;
    });
    connect(prev, mergeTarget); // empty branch → direct power from the left rail
  });

  // Series-chain the merge target through to the right rail.
  for (let i = 0; i < chainIds.length - 1; i++) connect(chainIds[i], chainIds[i + 1]);
  connect(chainIds[chainIds.length - 1], RIGHT_RAIL);

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
  const contactStr = (c) => (normContactSub(c?.subType) === 'NC' ? '!' : '') + (c?.contact || '?');
  const coilStr = (o) => {
    const tag = { Set: ' (S)', Reset: ' (R)', Negated: ' (/)' }[normCoilSub(o?.subType)] || '';
    return (o?.coil || '?') + tag;
  };
  const branches = (Array.isArray(r?.branches) && r.branches.length) ? r.branches : [[]];
  const brTexts = branches.map((b) => (Array.isArray(b) && b.length ? b.map(contactStr).join(' & ') : 'TRUE'));
  let cond = brTexts.length > 1 ? `(${brTexts.join(' | ')})` : brTexts[0];
  const after = Array.isArray(r?.seriesAfter) ? r.seriesAfter : [];
  if (after.length) cond += ' & ' + after.map(contactStr).join(' & ');
  const outs = (Array.isArray(r?.outputs) ? r.outputs : []).map(coilStr).join(', ');
  return `${cond}  →  ${outs}`;
}
