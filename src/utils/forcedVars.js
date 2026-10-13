// The FORCED set — which variables currently have their value held by a force.
//
// Both runtimes report it under the reserved key `__forced` (a sorted array of
// live keys): KronServer inside each /stream/vars event, the local hot-swap sim
// beside `vars` in a simulation-output event. It is sent on a stream's first
// event, whenever it changes (`[]` = nothing forced any more) and at least every
// 2 s; an event WITHOUT the key means "unchanged". It is never a variable, so
// it must be taken out before a payload is merged into liveVariables, and it
// ignores the live subscription (the force list needs every forced variable).

import { liveResolveKey } from './iecNames';

export const FORCED_KEY = '__forced';
export const EMPTY_FORCED = Object.freeze(new Set());

// Split a stream payload into its values and the forced list. `forced` is null
// when the payload does not carry the key (= unchanged). The input object is
// not mutated.
export function splitForcedPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Object.prototype.hasOwnProperty.call(payload, FORCED_KEY)) {
    return { vars: payload, forced: null };
  }
  const { [FORCED_KEY]: raw, ...vars } = payload;
  const forced = Array.isArray(raw) ? raw.filter(k => typeof k === 'string') : [];
  return { vars, forced };
}

// The next forced Set for a received list, or `prev` itself when nothing
// changed (so a state setter keeps its identity and nothing re-renders).
export function nextForcedSet(prev, list) {
  if (!list) return prev;
  if (list.length === 0) return prev && prev.size === 0 ? prev : EMPTY_FORCED;
  if (prev && prev.size === list.length && list.every(k => prev.has(k))) return prev;
  return new Set(list);
}

// Lowercased view, cached per Set — IEC identifiers are case-insensitive (see
// utils/iecNames), and an overlay resolves one key per identifier per line.
const lowerCache = new WeakMap();
function lowerSet(set) {
  let l = lowerCache.get(set);
  if (!l) {
    l = new Set();
    for (const k of set) l.add(String(k).toLowerCase());
    lowerCache.set(set, l);
  }
  return l;
}

// Whether `key` (a live key, any casing) is forced.
export function isKeyForced(forcedSet, key) {
  if (!forcedSet || forcedSet.size === 0 || key == null) return false;
  if (forcedSet.has(key)) return true;
  return lowerSet(forcedSet).has(String(key).toLowerCase());
}

// Whether any forced key lives UNDER `key` — an FB instance or a struct whose
// members are streamed flat (`prog_X_blink.Q`, `prog_X_arr[0]`). Lets a badge
// that shows a whole composite still say "something in here is forced".
export function isAnyMemberForced(forcedSet, key) {
  if (!forcedSet || forcedSet.size === 0 || key == null) return false;
  const base = String(key).toLowerCase();
  for (const k of lowerSet(forcedSet)) {
    if (k === base || k.startsWith(base + '.') || k.startsWith(base + '[')) return true;
  }
  return false;
}

// Human-readable name for a live key: `prog__x` → `x`, `prog_Main_x` →
// `Main.x`, `prog_Main_blink.Q` → `Main.blink.Q`. POU names may contain `_`,
// so the split uses the known POU names when given (longest first), else the
// first `_` after the prefix.
export function displayNameForKey(key, pouNames = []) {
  const s = String(key || '');
  if (s.startsWith('prog__')) return s.slice(6);
  if (!s.startsWith('prog_')) return s;
  const rest = s.slice(5);
  const sorted = [...pouNames].map(n => String(n).trim().replace(/\s+/g, '_'))
    .sort((a, b) => b.length - a.length);
  for (const n of sorted) {
    if (n && rest.toLowerCase().startsWith(n.toLowerCase() + '_')) {
      return `${rest.slice(0, n.length)}.${rest.slice(n.length + 1)}`;
    }
  }
  const i = rest.indexOf('_');
  return i > 0 ? `${rest.slice(0, i)}.${rest.slice(i + 1)}` : rest;
}

// Live key of the ST identifier at a 1-based column of a line — the word under
// (or ending just before) the column; `fb.Q` resolves to the member's flat key
// `prog_<P>_fb.Q`. Used by the ST editors to open the force dialog from a
// clicked force marker. Returns { name, key } (key may be undefined when the
// value is not streamed), or null when there is no identifier there.
export function stLiveKeyAt(line, column, live, safeProgName) {
  const text = String(line || '');
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m;
  let hit = null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + 1;           // 1-based
    const end = start + m[0].length;     // exclusive
    if (column >= start && column <= end) { hit = m; break; }
  }
  if (!hit) return null;
  const word = hit[0];
  let base = null;
  if (hit.index > 0 && text[hit.index - 1] === '.') {
    const before = text.slice(0, hit.index - 1).match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    if (before) base = before[1];
  }
  const name = base ? `${base}.${word}` : word;
  const key = live
    ? (liveResolveKey(live, `prog_${safeProgName}_${name}`) || liveResolveKey(live, `prog__${name}`))
    : undefined;
  return { name, key };
}

// CSS for the ST editors' force marker: Monaco injected text cannot hold a
// React element, so a forced value's badge gets the extra class
// `live-var-forced`, which frames it red and appends the "F" (::after).
export function ensureForcedDecorationStyle() {
  if (typeof document === 'undefined' || document.getElementById('kron-forced-deco-style')) return;
  const style = document.createElement('style');
  style.id = 'kron-forced-deco-style';
  style.textContent = `
    .live-var-forced {
      outline: 1.5px solid #ff1744 !important;
      cursor: pointer !important;
    }
    .live-var-forced::after {
      content: 'F';
      display: inline-block;
      margin-left: 4px;
      padding: 0 2px;
      border: 1.5px solid #ff1744;
      border-radius: 2px;
      background: #2a0a0f;
      color: #ff5252;
      font-weight: 800;
      font-size: 9px;
      line-height: 11px;
      font-family: Consolas, "Cascadia Code", monospace;
    }
  `;
  document.head.appendChild(style);
}
