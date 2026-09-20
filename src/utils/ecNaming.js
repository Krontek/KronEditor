/**
 * ecNaming.js — the SINGLE source of truth for EtherCAT PDO variable names
 * and for the validity of a PDO selection.
 *
 * ⚠️ Why this file exists: the name a selected PDO entry gets used to be
 * computed TWICE — once in the editor (EsiParser.pdoEntriesToGlobalVars, to
 * create the global variable) and once in the transpiler
 * (generateEtherCATConfig.makeUniqueVarName, to emit the GPI member + access
 * macro). Both used a RUNNING COUNTER for collisions, but over different
 * scopes: the editor restarted it per slave, the transpiler ran it across the
 * whole bus. So the moment two entries anywhere on the bus wanted the same
 * base name, the editor declared `ec_X_Status` while the transpiler emitted
 * `ec_X_Status_2` — the global then got a real PlcState/SHM slot instead of
 * the GPI macro and read a constant zero, silently.
 *
 * The fix is not "share the counter" but "have no counter": a name must be a
 * pure function of the ONE entry it belongs to plus the set of entries that
 * claim the same base. Disambiguation therefore appends the entry's identity
 * (slave position + object address), which is unique by construction, and it
 * is applied to EVERY colliding entry — never to "the second one", which is
 * what made the old scheme depend on iteration order.
 */

/** Strip everything that cannot appear in a C/IEC identifier. */
export const sanitizeEcIdent = (raw) =>
  String(raw ?? '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/__+/g, '_')
    .replace(/^_+|_+$/g, '');

/** A sanitized name is only usable if it is a legal IEC/C identifier. */
export const isValidEcIdent = (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ''));

const hex4 = (n) => ((n || 0) >>> 0).toString(16).toUpperCase().padStart(4, '0');
const hex2 = (n) => ((n || 0) & 0xff).toString(16).toUpperCase().padStart(2, '0');

export const ecSlavePosition = (slave, si) => Math.max(1, parseInt(slave?.position) || si + 1);
export const ecSlaveLabel = (slave, si) => slave?.name || `Slave_${ecSlavePosition(slave, si)}`;

/**
 * Flatten every SELECTED PDO entry of a bus into a stable, indexable list.
 * `key` identifies one entry across all of the helpers below.
 */
export const collectSelectedEcEntries = (slaves = []) => {
  const out = [];
  (slaves || []).forEach((slave, si) => {
    (slave?.pdos || []).forEach((pdo, pi) => {
      (pdo?.entries || []).forEach((entry, ei) => {
        if (!entry?.selected) return;
        out.push({ si, pi, ei, slave, pdo, entry, key: `${si}|${pi}|${ei}` });
      });
    });
  });
  return out;
};

/**
 * Map every selected entry to { auto, name, custom }.
 *   auto   — the generated name (what the "auto" placeholder shows)
 *   name   — what is actually emitted (the sanitized custom name, else auto)
 *   custom — whether the user typed it
 *
 * Deterministic and order-independent: pass the WHOLE bus (all slaves) so the
 * editor and the transpiler see the same collision set.
 */
export const buildEcVarNames = (slaves = []) => {
  const sel = collectSelectedEcEntries(slaves);

  const baseOf = ({ slave, si, entry }) =>
    sanitizeEcIdent(`ec_${ecSlaveLabel(slave, si)}_${entry?.name || 'var'}`) || `ec_slave_${si + 1}_var`;

  const counts = new Map();
  sel.forEach((e) => { const b = baseOf(e); counts.set(b, (counts.get(b) || 0) + 1); });

  const map = new Map();
  sel.forEach((e) => {
    const b = baseOf(e);
    // Every entry claiming a contested base gets the suffix, not just the
    // later ones — that is what makes the result independent of iteration
    // order and therefore identical in the editor and in the transpiler.
    const auto = counts.get(b) > 1
      ? `${b}_${ecSlavePosition(e.slave, e.si)}_${hex4(e.entry.index)}_${hex2(e.entry.subindex)}`
      : b;
    const custom = sanitizeEcIdent(e.entry.varName || '');
    map.set(e.key, { auto, name: custom || auto, custom: !!custom });
  });
  return map;
};

/**
 * Validate a PDO selection. Returns [{ level, kind, slaveIndex, keys, message }].
 *
 * ⚠️ `duplicate-object` is the one that used to reach the hardware: an ESI
 * routinely describes SEVERAL mutually exclusive PDO objects that each contain
 * the same CoE object (a CiA402 drive puts 0x6041 Statusword in 0x1A00, 0x1A01
 * and 0x1A02). Selecting it in two of them assigns both PDOs to the same sync
 * manager, which the slave rejects — it simply never reaches OP, with no hint
 * of why in the editor.
 */
export const findEcIssues = (slaves = []) => {
  const issues = [];
  const sel = collectSelectedEcEntries(slaves);
  const names = buildEcVarNames(slaves);
  const push = (level, kind, slaveIndex, keys, message) =>
    issues.push({ level, kind, slaveIndex, keys, message });

  /* 1. The same CoE object selected in more than one PDO of one slave. */
  const dupObjectKeys = new Set();
  const byObject = new Map();
  sel.forEach((e) => {
    const k = `${e.si}|${(e.entry.index || 0) >>> 0}|${(e.entry.subindex || 0) & 0xff}`;
    if (!byObject.has(k)) byObject.set(k, []);
    byObject.get(k).push(e);
  });
  byObject.forEach((group) => {
    if (group.length < 2) return;
    const e = group[0];
    const pdoList = group.map((g) => `0x${hex4(g.pdo?.index)}`).join(', ');
    group.forEach((g) => dupObjectKeys.add(g.key));
    push('error', 'duplicate-object', e.si, group.map((g) => g.key),
      `${ecSlaveLabel(e.slave, e.si)}: object 0x${hex4(e.entry.index)}:${hex2(e.entry.subindex)} ` +
      `(${e.entry.name || '?'}) is selected in ${group.length} PDOs (${pdoList}). ` +
      `These are alternative mappings — select it in exactly one.`);
  });

  /* 2. Two selected PDOs that the ESI declares mutually exclusive. */
  (slaves || []).forEach((slave, si) => {
    const selectedPdos = (slave?.pdos || [])
      .map((pdo, pi) => ({ pdo, pi }))
      .filter(({ pdo }) => (pdo?.entries || []).some((en) => en?.selected));
    selectedPdos.forEach(({ pdo, pi }) => {
      const excludes = (pdo?.excludes || []).map((x) => (x || 0) >>> 0);
      if (!excludes.length) return;
      selectedPdos.forEach(({ pdo: other, pi: opi }) => {
        if (opi <= pi) return; // report each pair once
        if (!excludes.includes((other?.index || 0) >>> 0)) return;
        push('error', 'excluded-pdo', si, [],
          `${ecSlaveLabel(slave, si)}: PDO 0x${hex4(pdo.index)} (${pdo.name || '?'}) and ` +
          `0x${hex4(other.index)} (${other.name || '?'}) are mutually exclusive in the ESI — ` +
          `only one of them may carry selected entries.`);
      });
    });
  });

  /* 3. Two entries resolving to the same variable name (custom-name clash). */
  const byName = new Map();
  sel.forEach((e) => {
    const n = names.get(e.key)?.name;
    if (!n) return;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(e);
  });
  byName.forEach((group, n) => {
    if (group.length < 2) return;
    // The same object selected twice necessarily lands on the same name;
    // reporting it again as a naming clash is noise, not a second problem.
    if (group.every((g) => dupObjectKeys.has(g.key))) return;
    push('error', 'duplicate-name', group[0].si, group.map((g) => g.key),
      `PDO variable name "${n}" is used by ${group.length} entries ` +
      `(${group.map((g) => `${ecSlaveLabel(g.slave, g.si)} 0x${hex4(g.entry.index)}:${hex2(g.entry.subindex)}`).join(', ')}). ` +
      `Give each one its own IEC Var Name.`);
  });

  /* 4. A custom name that cannot become an identifier at all. */
  sel.forEach((e) => {
    const raw = (e.entry.varName || '').trim();
    if (!raw) return;
    const n = names.get(e.key)?.name;
    if (!isValidEcIdent(n)) {
      push('error', 'invalid-name', e.si, [e.key],
        `${ecSlaveLabel(e.slave, e.si)}: IEC Var Name "${raw}" is not a valid IEC identifier ` +
        `(letters, digits and _ only, and it may not start with a digit).`);
    }
  });

  return issues;
};

/**
 * Build the global-variable rows for ONE slave's selected entries.
 * Names come from the whole-bus map, so what the editor declares is exactly
 * what the transpiler emits.
 */
export const ecGlobalVarsForSlave = (slaves = [], slaveIndex = 0) => {
  const names = buildEcVarNames(slaves);
  return collectSelectedEcEntries(slaves)
    .filter((e) => e.si === slaveIndex)
    .map((e) => ({
      name: names.get(e.key).name,
      type: e.entry.iecType || 'USINT',
      direction: e.pdo?.direction === 'input' ? 'input' : 'output',
      kronDtype: e.entry.kronDtype,
      index: e.entry.index,
      subindex: e.entry.subindex,
      bitLen: e.entry.bitLen,
      comment: `EtherCAT ${e.pdo?.direction === 'input' ? 'input' : 'output'}: ` +
               `${ecSlaveLabel(e.slave, e.si)} ${e.entry.name || ''}`.trim(),
    }));
};
