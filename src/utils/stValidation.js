// Shared Structured Text identifier/parameter validator used by both the ST
// editor (EditorPane) and the SCL inline rung editor (RungEditorNew).
//
// It does two things per line, in a single forward token scan:
//   1. flags genuinely undefined identifiers (not a declared var, keyword, type,
//      standard FB/function, conversion or member access), and
//   2. validates NAMED ARGUMENTS in a call — `IN := …` inside `TON(…)` — against
//      the called FB's actual pin list, flagging a key ONLY when the target is a
//      known standard FB/function and the key is not one of its pins. Valid pins
//      (IN, PT, …) are therefore never flagged; a typo'd pin (FOO) is.
//
// Returns plain marker objects WITHOUT severity (the caller adds MarkerSeverity
// + the model owner) so this stays Monaco-agnostic and unit-testable.

import { getStandardFBPins } from '../services/CTranspilerService';

// Time/duration literals (T#500ms, TIME#1s) — replaced with same-length spaces
// so they don't read as identifiers and marker columns stay accurate.
const TIME_LITERAL = /\b(?:T|TIME|LT|LTIME)#[0-9smhd._]+/gi;
// IEC typed-radix integer literals (16#FE, 2#1010, 8#777).
const RADIX_LITERAL = /\b\d+#[0-9A-Fa-f_]+\b/g;

export function findStMarkers(code, { allowedLower, conversionPattern, varTypes }) {
  // Resolve a call target (identifier just before `(`) to its FB pin set. The
  // target is either a type name (TON, INT_TO_REAL) or an instance variable
  // whose declared type is the FB (pulse : TON). null ⇒ pins unknown (user FB),
  // in which case named args are not checked.
  const resolvePins = (target) => {
    if (!target) return null;
    let pins = getStandardFBPins(target);
    if (pins) return pins;
    const vt = varTypes && varTypes.get(target.toLowerCase());
    if (vt) { pins = getStandardFBPins(vt); if (pins) return pins; }
    return null;
  };

  const markers = [];
  // Strip whole-text block comments first (keep line count for accurate rows).
  const stripped = String(code || '').replace(/\(\*[\s\S]*?\*\)/g, (m) => '\n'.repeat((m.match(/\n/g) || []).length));
  stripped.split('\n').forEach((rawLine, i) => {
    const line = rawLine
      .replace(/\/\/.*$/, '')
      .replace(/\(\*.*?\*\)/g, '')
      .replace(TIME_LITERAL, (m) => ' '.repeat(m.length))
      .replace(RADIX_LITERAL, (m) => ' '.repeat(m.length));

    const tok = /([A-Za-z_][A-Za-z0-9_]*)|(:=)|(\()|(\))/g;
    const stack = [];                    // { pins, targetName } per call paren, or { grouping:true }
    let m, lastIdent = null, lastIdentEnd = -1;
    const push = (word, idx, message) => markers.push({
      message,
      startLineNumber: i + 1,
      startColumn: idx + 1,
      endLineNumber: i + 1,
      endColumn: idx + 1 + word.length,
    });

    while ((m = tok.exec(line)) !== null) {
      if (m[1]) {                        // identifier
        const word = m[1];
        const idx = m.index;
        let j = tok.lastIndex;           // peek next non-space for `:=`
        while (j < line.length && /\s/.test(line[j])) j++;
        const isNamedArgKey = line.slice(j, j + 2) === ':=';
        const top = stack[stack.length - 1];
        const inCall = top && !top.grouping;
        if (isNamedArgKey && inCall) {
          if (top.pins && !top.pins.has(word.toLowerCase())) {
            push(word, idx, `'${word}' is not a parameter of ${top.targetName}`);
          }
        } else if (line[idx - 1] !== '.') {   // skip member access (x.Q)
          if (!allowedLower.has(word.toLowerCase()) && !conversionPattern.test(word) && isNaN(word)) {
            push(word, idx, `Undefined identifier: '${word}'`);
          }
        }
        lastIdent = word; lastIdentEnd = idx + word.length;
      } else if (m[3]) {                 // '('
        const between = line.slice(lastIdentEnd, m.index);
        if (lastIdent && /^\s*$/.test(between)) {
          stack.push({ pins: resolvePins(lastIdent), targetName: lastIdent });
        } else {
          stack.push({ grouping: true });
        }
        lastIdent = null;
      } else if (m[4]) {                 // ')'
        stack.pop();
        lastIdent = null;
      } else {                           // ':='
        lastIdent = null;
      }
    }
  });
  return markers;
}
