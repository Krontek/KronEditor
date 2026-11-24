// Declaration hover for ST editors (edit mode): hovering a declared variable
// shows its type, class, initial value (+ address / description).
// Shared by the full ST editor (EditorPane) and the SCL inline rung editor
// (RungEditorNew). Names resolve case-insensitively (iecNames.js); locals
// shadow globals.
import { findVarByName } from './iecNames';

// `maskedLine`: the hovered line with comments and string literals blanked
// to spaces (each editor's maskCommentsAndStrings, which also handles block
// comments spanning lines). Returns a Monaco hover or null.
export function declarationHover(monaco, model, position, maskedLine, locals, globals) {
  const wi = model.getWordAtPosition(position);
  if (!wi) return null;
  const lineText = model.getLineContent(position.lineNumber);
  const col = wi.startColumn - 1;
  // Inside a comment or a string literal.
  if (maskedLine !== undefined && maskedLine[col] === ' ' && lineText[col] !== ' ') return null;
  // A member (`fb.Q`, `s.x`, `bno.Device_Address`) is not a top-level
  // variable even when its name happens to match one.
  if (lineText.slice(0, col).trimEnd().endsWith('.')) return null;
  const v = findVarByName(locals, wi.word) || findVarByName(globals, wi.word);
  if (!v) return null;
  const init = String(v.initialValue ?? '').trim();
  const lines = [
    `**${v.name}** : \`${v.type || '?'}\`${v.class ? `  _(${v.class})_` : ''}`,
    `Initial value: ${init ? `\`${init}\`` : '_type default_'}`,
  ];
  if (v.location) lines.push(`Address: \`${v.location}\``);
  if (v.description) lines.push(String(v.description));
  return {
    range: new monaco.Range(position.lineNumber, wi.startColumn, position.lineNumber, wi.endColumn),
    contents: [{ value: lines.join('\n\n') }],
  };
}
