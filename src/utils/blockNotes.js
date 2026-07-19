// blockNotes.js — resolves the "how it works" note shown at the bottom of the
// block settings modal (double-click on a ladder block). The note TEXTS live in
// the locale files under the "blockNotes" namespace (en/tr/ru — en is the
// i18next fallback, so a missing translation still renders English):
//   blockNotes.Contact.<subType>   contacts, per subType (NO/NC/Rising/Falling)
//   blockNotes.Coil.<subType>      coils, per subType
//   blockNotes.<TYPE>              standard function blocks (TON, CTU, ADD, …)
//   blockNotes.enNote              appended when Execution Control is on
// When adding a new standard block, add its key to ALL THREE locale files.

/**
 * Returns the "how it works" note for a ladder block, or '' when none exists.
 * blockData is the ReactFlow node data ({type, subType, executionControl,
 * customData}); t is the i18next translate function. Standard notes come from
 * the blockNotes.* locale keys; library/user blocks fall back to their XML
 * description (customData.description).
 */
export function getBlockNotes(blockData, t) {
  if (!blockData || typeof t !== 'function') return '';
  const tr = (key) => t(`blockNotes.${key}`, { defaultValue: '' });
  const parts = [];
  if (blockData.type === 'Contact') {
    parts.push(tr(`Contact.${blockData.subType || 'NO'}`) || tr('Contact.NO'));
  } else if (blockData.type === 'Coil') {
    parts.push(tr(`Coil.${blockData.subType || 'Normal'}`) || tr('Coil.Normal'));
  } else {
    const std = tr(blockData.type);
    if (std) parts.push(std);
    // Library blocks carry their XML description — used only when no standard
    // note exists for the type (XML descriptions are not translated).
    const desc = blockData.customData?.description;
    if (desc && !std) parts.push(desc);
    if (blockData.executionControl) parts.push(tr('enNote'));
  }
  return parts.filter(Boolean).join('\n\n');
}
