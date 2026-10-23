import { liveResolveKey } from './iecNames';

// Live key of the ST identifier at a 1-based column of a line — the word under
// (or ending just before) the column; `fb.Q` resolves to the member's flat key
// `prog_<P>_fb.Q`. Used by the ST editors (EditorPane, the inline ST rung editor)
// to open the write dialog from a double-clicked identifier. Resolution goes
// through liveResolveKey, so it is case-insensitive like every IEC name.
// Returns { name, key } (key is undefined when the value is not streamed), or
// null when there is no identifier there.
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
