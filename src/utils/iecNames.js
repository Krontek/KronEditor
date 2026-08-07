// IEC 61131-3 identifiers are CASE-INSENSITIVE — helpers for every editor-side
// place that has to match a name the USER TYPED against a DECLARED one.
//
// ⚠️ The rest of the pipeline already agrees on this rule: the transpiler
// resolves names through a lowercase map behind a /gi alternation regex
// (CTranspilerService `varMapLower`) and validation matches `allowedLower`, so
// `var0 := var0 + 1;` against a declared `Var0` compiles, runs and counts up
// correctly. Only the editor used to compare exactly, which broke two ways:
//
//   1. Live-variable KEYS are built from the DECLARED spelling
//      (`prog_<POU>_Var0`), so an exact lookup of the typed spelling found
//      nothing — the ST/ladder overlays drew NO badge and no power flow while
//      the variable table showed a happily incrementing value. That reads as
//      "live view is broken", not as "the casing differs".
//   2. Worse, LD inline auto-declare's exact existence check created a SECOND
//      variable for a case-variant reference. The transpiler then collapsed the
//      two in `varMapLower` (last wins) while emitting two distinct PlcState
//      fields, so ladder and ST silently wired to different storage.
//
// The lowercase index is cached per live-values OBJECT rather than rebuilt per
// lookup: a fresh object arrives on every SSE frame and the overlays resolve one
// key per identifier per line, so scanning per lookup would be
// O(identifiers x variables) every frame. A WeakMap lets superseded frames go.

const hasOwn = Object.prototype.hasOwnProperty;
const lowerIndexCache = new WeakMap();

// Case-insensitive lookup of a declared variable in a list of {name, type, …}.
export function findVarByName(vars, name) {
  if (!vars || !name) return undefined;
  const lower = String(name).toLowerCase();
  return vars.find(v => (v?.name || '').toLowerCase() === lower);
}

// Whether any of `vars` declares `name` (case-insensitively).
export function hasVarNamed(vars, name) {
  return findVarByName(vars, name) !== undefined;
}

// Map of lowercased key -> the key as it actually appears in `live`.
export function liveLowerIndex(live) {
  if (!live || typeof live !== 'object') return null;
  let idx = lowerIndexCache.get(live);
  if (!idx) {
    idx = new Map();
    for (const k of Object.keys(live)) idx.set(k.toLowerCase(), k);
    lowerIndexCache.set(live, idx);
  }
  return idx;
}

// Value for `key`: exact match first, case-insensitive as the fallback.
export function liveGet(live, key) {
  if (!live || key == null) return undefined;
  if (hasOwn.call(live, key)) return live[key];
  const idx = liveLowerIndex(live);
  const real = idx && idx.get(String(key).toLowerCase());
  return real === undefined ? undefined : live[real];
}

// The key as it actually appears in `live`, resolved case-insensitively, or
// undefined if there is none. Needed wherever a key is not just READ but handed
// on — a force-write targets a key by name, so passing the user's spelling would
// write to a slot that does not exist and silently do nothing.
export function liveResolveKey(live, key) {
  if (!live || key == null) return undefined;
  if (hasOwn.call(live, key)) return key;
  const idx = liveLowerIndex(live);
  return idx ? idx.get(String(key).toLowerCase()) : undefined;
}

// Case-insensitive member read for a DECODED composite (FB struct / UDT from the
// local sim's DWARF read). Its member names carry the declared pin/field
// spelling just like the flat SHM keys do, so `blink.q` must find `Q`.
export function memberGet(obj, member) {
  if (!obj || typeof obj !== 'object' || member == null) return undefined;
  if (hasOwn.call(obj, member)) return obj[member];
  const lower = String(member).toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return obj[k];
  }
  return undefined;
}

// Keys of `live` that start with any of `prefixes`, compared case-insensitively,
// as [remainderAfterPrefix, value] pairs. Used by the hover provider to gather a
// composite that the target streams as FLAT keys (`prog_X_blink.Q`, `…_arr[0]`).
export function liveEntriesWithPrefix(live, prefixes) {
  const out = [];
  if (!live) return out;
  const lowers = prefixes.map(p => String(p).toLowerCase());
  for (const k of Object.keys(live)) {
    const kl = k.toLowerCase();
    for (const p of lowers) {
      if (kl.startsWith(p)) { out.push([k.slice(p.length), live[k]]); break; }
    }
  }
  return out;
}
