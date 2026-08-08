// IEC 61131-3 direct-address (%M…) parsing, validation and type retargeting.
//
// ⚠️ An address is only a LABEL as far as the runtime is concerned — KronServer
// reaches a variable through its offset/size (both derived from the TYPE), and
// treats a non-empty `address` purely as "expose this over REST/HMI"
// (server/ipc.go). So a prefix that disagrees with the type never crashes
// anything; it just makes the editor, the REST feed, the HMI variable picker
// and the addressed-variable CSV all advertise a width the runtime does not
// actually serve. The mismatch therefore surfaces only in the field, when the
// SCADA/Modbus side on the other end reads a word where a bit was published.
// That is why the prefix↔type rule is enforced here, in ONE place, and applied
// by every writer: the Variable Manager (on both address entry and type
// change) and the transpiler's pre-codegen gate — the latter also covers
// projects whose XML was hand-edited or written by the AI agent, which never
// pass through the UI checks.
//
// Keep IEC_TYPE_PREFIX in sync with the transpiler's IEC_TYPE_SIZES /
// IEC_TO_SERVER_TYPE tables (CTranspilerService.js): a new IEC primitive that
// gets a SHM slot but no entry here becomes silently unaddressable.

// IEC size prefix per elementary type. The size letter encodes the WIDTH of
// the addressed location, so it is a function of the type alone.
export const IEC_TYPE_PREFIX = {
  'BOOL': 'X', 'BYTE': 'B', 'SINT': 'B', 'USINT': 'B',
  'INT': 'W', 'UINT': 'W', 'WORD': 'W',
  'DINT': 'D', 'UDINT': 'D', 'DWORD': 'D', 'REAL': 'D', 'TIME': 'D',
  'LINT': 'L', 'ULINT': 'L', 'LWORD': 'L', 'LREAL': 'L',
};

// Human-readable width per size prefix, used only to explain a mismatch.
const PREFIX_WIDTH = { X: '1 bit', B: '8 bit', W: '16 bit', D: '32 bit', L: '64 bit' };

// %<location><size><number>[.<bit>]
// Location I/Q/M are all accepted (all three are IEC 61131-3 direct-address
// locations, and older projects may carry hand-entered %I/%Q). Only %M is ever
// GENERATED — that is the memory area KronServer exposes.
const ADDR_RE = /^%([IQM])([XBWDL])(\d+)(?:\.(\d+))?$/;

/** Size prefix this type must use, or null when the type cannot be addressed. */
export const expectedAddressPrefix = (varType) =>
  IEC_TYPE_PREFIX[(varType || '').trim().toUpperCase()] || null;

/**
 * Parse a direct address into its parts. Returns null when the string is not a
 * well-formed IEC address — the caller decides whether that is an error.
 */
export function parseIECAddress(raw) {
  const s = (raw || '').trim().toUpperCase();
  if (!s) return null;
  const m = ADDR_RE.exec(s);
  if (!m) return null;
  const [, location, size, numStr, bitStr] = m;
  const number = Number(numStr);
  if (!Number.isSafeInteger(number)) return null;
  const bit = bitStr === undefined ? null : Number(bitStr);
  // A .bit suffix is meaningful only on a bit address, and addresses exactly
  // one of the 8 bits in the byte.
  if (size === 'X') {
    if (bit !== null && bit > 7) return null;
  } else if (bit !== null) {
    return null;
  }
  return { location, size, number, bit, canonical: s };
}

/**
 * Validate an address against the variable's type.
 *
 * @returns {{ok: true, address: string}} — canonical (upper-cased) address, or
 *   '' when the input was empty (no address is always valid).
 * @returns {{ok: false, code: string, message: string}} — code is one of
 *   SYNTAX | UNADDRESSABLE_TYPE | TYPE_MISMATCH.
 */
export function validateIECAddress(raw, varType) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { ok: true, address: '' };

  const type = (varType || '').trim();
  const expected = expectedAddressPrefix(type);
  if (!expected) {
    // Arrays, structures, enums, FB instances and STRING have no single
    // addressable width. The transpiler would hand the SAME address string to
    // every expanded element/member (see the debugDefaults expansion), so the
    // REST feed would publish N distinct variables all claiming one location.
    return {
      ok: false,
      code: 'UNADDRESSABLE_TYPE',
      message: `Type "${type || '(none)'}" cannot carry a direct address — only elementary IEC types (BOOL, INT, REAL, TIME, …) can. Address an individual scalar variable instead.`,
    };
  }

  const parsed = parseIECAddress(trimmed);
  if (!parsed) {
    return {
      ok: false,
      code: 'SYNTAX',
      message: `"${trimmed}" is not a valid IEC address — expected %M${expected}<number>${expected === 'X' ? '.<bit 0-7>' : ''} (e.g. ${exampleAddress(expected)}).`,
    };
  }

  if (parsed.size !== expected) {
    return {
      ok: false,
      code: 'TYPE_MISMATCH',
      message: `Address "${parsed.canonical}" is ${PREFIX_WIDTH[parsed.size]} (%${parsed.location}${parsed.size}) but type ${type.toUpperCase()} is ${PREFIX_WIDTH[expected]} — use %${parsed.location}${expected} (e.g. ${exampleAddress(expected, parsed.location, parsed.number)}).`,
      expected,
    };
  }

  return { ok: true, address: parsed.canonical };
}

function exampleAddress(prefix, location = 'M', number = 0) {
  return prefix === 'X' ? `%${location}X${number}.0` : `%${location}${prefix}${number}`;
}

/**
 * Rewrite an existing address for a NEW type, keeping the numeric location the
 * user chose and swapping only the size prefix (%MW10 + BOOL → %MX10.0).
 *
 * The number is deliberately preserved rather than recomputed: it is the
 * operator-facing register index agreed with whatever is on the other end of
 * the REST/Modbus link, so silently moving it would be a worse surprise than
 * changing the width they can see.
 *
 * @returns {{address: string, changed: boolean, note: string|null}}
 */
export function retargetIECAddress(raw, newType) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { address: '', changed: false, note: null };

  const expected = expectedAddressPrefix(newType);
  if (!expected) {
    return {
      address: '',
      changed: true,
      note: `Address "${trimmed.toUpperCase()}" was removed — type ${(newType || '').toUpperCase()} cannot be addressed.`,
    };
  }

  const parsed = parseIECAddress(trimmed);
  if (!parsed) {
    // Unparseable leftovers (possible in projects saved before addresses were
    // validated) cannot be retargeted meaningfully — drop them and say so
    // rather than carrying a broken string into the new type.
    return {
      address: '',
      changed: true,
      note: `Address "${trimmed}" was removed — it is not a valid IEC address.`,
    };
  }

  if (parsed.size === expected) return { address: parsed.canonical, changed: false, note: null };

  const retargeted = expected === 'X'
    ? `%${parsed.location}X${parsed.number}.0`
    : `%${parsed.location}${expected}${parsed.number}`;
  return {
    address: retargeted,
    changed: true,
    note: `Address updated ${parsed.canonical} → ${retargeted} to match type ${(newType || '').toUpperCase()}.`,
  };
}

/**
 * Turn Variable Manager input into a canonical address.
 * A bare number is expanded using the type's prefix (type=BOOL, 1 → %MX0.1;
 * type=INT, 10 → %MW10); anything else must already be a valid IEC address.
 *
 * @returns {{ok: true, address: string}|{ok: false, code: string, message: string}}
 */
export function formatIECAddress(input, varType) {
  const trimmed = (input || '').trim();
  if (!trimmed) return { ok: true, address: '' };

  // Already an explicit address (or an attempt at one) — validate as written.
  if (trimmed.startsWith('%')) return validateIECAddress(trimmed, varType);

  const prefix = expectedAddressPrefix(varType);
  if (!prefix) return validateIECAddress(trimmed, varType); // reports UNADDRESSABLE_TYPE

  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      code: 'SYNTAX',
      message: `"${trimmed}" is neither a number nor a valid IEC address — enter e.g. 10 or ${exampleAddress(prefix, 'M', 10)}.`,
    };
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num)) {
    return { ok: false, code: 'SYNTAX', message: `"${trimmed}" is out of range.` };
  }

  // Bit addressing: a bare number is a global bit index → byte.bit.
  if (prefix === 'X') return { ok: true, address: `%MX${Math.floor(num / 8)}.${num % 8}` };
  return { ok: true, address: `%M${prefix}${num}` };
}
