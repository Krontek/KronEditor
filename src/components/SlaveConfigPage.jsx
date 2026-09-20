/**
 * SlaveConfigPage.jsx — Full-page editor for a single EtherCAT slave
 * Opens as a tab when a slave node is clicked in the Project Sidebar.
 */
import { useState } from 'react';
import { buildEcVarNames, findEcIssues, ecGlobalVarsForSlave, sanitizeEcIdent } from '../utils/ecNaming';
import { resolveSdoByteSize } from '../services/CTranspilerService';

const hex = (n, w = 4) => '0x' + (n ?? 0).toString(16).toUpperCase().padStart(w, '0');

const S = {
  root:    { flex: 1, display: 'flex', flexDirection: 'column', background: '#1e1e1e', color: '#ccc', fontSize: 12, overflow: 'hidden' },
  header:  { background: '#252526', borderBottom: '1px solid #333', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  body:    { flex: 1, overflow: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 },
  section: { background: '#252526', border: '1px solid #333', borderRadius: 4, padding: '10px 12px' },
  stitle:  { fontWeight: 'bold', fontSize: 11, color: '#9cdcfe', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  row:     { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  label:   { color: '#999', minWidth: 140, fontSize: 11 },
  input:   { background: '#3c3c3c', color: '#ccc', border: '1px solid #555', borderRadius: 3, padding: '3px 7px', fontSize: 11, outline: 'none', flex: 1, maxWidth: 220 },
  btn:     { background: '#0d47a1', color: '#fff', border: 'none', borderRadius: 3, padding: '4px 10px', fontSize: 11, cursor: 'pointer' },
  btnSm:   { background: '#37474f', color: '#ccc', border: 'none', borderRadius: 3, padding: '3px 8px', fontSize: 10, cursor: 'pointer' },
  btnDanger:  { background: '#5d0000', color: '#ff8a80', border: 'none', borderRadius: 3, padding: '3px 8px', fontSize: 10, cursor: 'pointer' },
  btnSuccess: { background: '#1b5e20', color: '#a5d6a7', border: 'none', borderRadius: 3, padding: '4px 10px', fontSize: 11, cursor: 'pointer' },
  table:   { width: '100%', borderCollapse: 'collapse', fontSize: 11 },
  th:      { background: '#1a1a1a', padding: '4px 6px', textAlign: 'left', borderBottom: '1px solid #444', color: '#888', fontWeight: 'normal' },
  td:      { padding: '3px 6px', borderBottom: '1px solid #2a2a2a', verticalAlign: 'middle' },
  chip:    { display: 'inline-block', padding: '1px 6px', borderRadius: 10, fontSize: 10, fontWeight: 'bold' },
  chipIn:  { background: '#0a3d62', color: '#74b9ff' },
  chipOut: { background: '#3d0a0a', color: '#ff7675' },
};

/* ⚠️ `allSlaves` is the WHOLE bus, not a convenience: PDO variable names are
 * disambiguated against every selected entry on the bus (see utils/ecNaming),
 * so a page that only knew its own slave would generate different names than
 * the transpiler. `slaveIndex` is this slave's position in that array. */
export default function SlaveConfigPage({ slave, allSlaves = null, slaveIndex = 0, onChange, onAddGlobalVars, isRunning = false, esiLibrary = [] }) {
  const [activeTab, setActiveTab]       = useState('pdo');
  const [showEsiPicker, setShowEsiPicker] = useState(false);
  const [log, setLog]                   = useState('');
  // Alternative mappings of an already-selected object are noise once the
  // choice is made, but they must stay REACHABLE (moving an object to another
  // PDO means selecting its row there), so they are collapsed, not removed.
  const [hideAlternates, setHideAlternates] = useState(true);

  if (!slave) return <div style={{ ...S.root, alignItems: 'center', justifyContent: 'center', color: '#555' }}>No slave selected.</div>;

  /* ── Helpers ── */
  const update = (fields) => onChange?.({ ...slave, ...fields });

  /* ⚠️ Selecting an entry can make an ALREADY selected PDO illegal: an ESI
   * declares alternative mappings with <Exclude>, and assigning two excluded
   * PDOs to the same sync manager is rejected by the slave — the bus simply
   * never reaches OP, with nothing in the editor pointing at the cause. So the
   * conflicting PDO's entries are cleared here, loudly, instead of being left
   * for the transpiler (which now also refuses them) or the hardware. */
  const togglePdo = (pdoIdx, entryIdx, checked) => {
    const s = JSON.parse(JSON.stringify(slave));
    s.pdos[pdoIdx].entries[entryIdx].selected = checked;
    if (checked) {
      const mine = s.pdos[pdoIdx];
      const cleared = [];
      s.pdos.forEach((other, oi) => {
        if (oi === pdoIdx) return;
        const conflicts =
          (mine.excludes || []).includes((other.index || 0) >>> 0) ||
          (other.excludes || []).includes((mine.index || 0) >>> 0);
        if (!conflicts) return;
        if (!(other.entries || []).some(e => e.selected)) return;
        other.entries.forEach(e => { e.selected = false; });
        cleared.push(hex(other.index));
      });
      if (cleared.length) setLog(`Deselected ${cleared.join(', ')} — excluded by ${hex(mine.index)}`);
    }
    onChange?.(s);
  };

  const updateSdo = (sdoIdx, field, value) => {
    const s = JSON.parse(JSON.stringify(slave));
    s.sdos[sdoIdx][field] = value;
    // ⚠️ The width belongs to the OBJECT, not to the user: point a row at a
    // different index and its size follows, so a row can never keep the width of
    // the object it used to address. A mis-sized SDO is aborted by the drive and
    // the bus silently never reaches OP.
    if (field === 'index' || field === 'subindex') {
      const row = s.sdos[sdoIdx];
      row.byteSize = resolveSdoByteSize(s, row.index, row.subindex, row.byteSize).size;
    }
    onChange?.(s);
  };

  const addSdo = () => {
    const s = JSON.parse(JSON.stringify(slave));
    const seed = { index: 0x6040, subindex: 0, value: 6, comment: '' };
    seed.byteSize = resolveSdoByteSize(s, seed.index, seed.subindex, 2).size;
    s.sdos = [...(s.sdos || []), seed];
    onChange?.(s);
  };

  const deleteSdo = (sdoIdx) => {
    const s = JSON.parse(JSON.stringify(slave));
    s.sdos.splice(sdoIdx, 1);
    onChange?.(s);
  };

  const defaultAxisRef = () => ({
    enabled: true,
    name: `Axis_${slave.position || 1}`,
    axisNo: 0,
    gearRatio: 1,
    encoderType: 'incremental',
    singleTurnBits: 13,
    multiTurnBits: 12,
    simMode: false,
    // ⚠️ Motion limits default to '' (blank), NOT 0. AXIS_REF_Init installs
    // usable defaults for the windows and the transpiler only emits a field the
    // user actually filled in — a 0 here would either disable a limit or make
    // InPositionWindow so tight that no move ever reports Done.
    maxVelocity: '', maxAcceleration: '', maxDeceleration: '', maxJerk: '',
    inPositionWindow: '', inVelocityWindow: '',
    enableLimitNegative: false, swLimitNegative: 0,
    enableLimitPositive: false, swLimitPositive: 0,
    enablePosLagMonitoring: false, maxPositionLag: '',
  });

  const updateAxis = (field, value) =>
    onChange?.({ ...slave, axisRef: { ...defaultAxisRef(), ...slave.axisRef, [field]: value } });

  const axisCfg = { ...defaultAxisRef(), ...(slave.axisRef || {}) };
  const encRes = Math.pow(2, parseInt(axisCfg.singleTurnBits) || 13);
  const gRatio = parseFloat(axisCfg.gearRatio);
  const countsPerUnit = (encRes > 0 && gRatio > 0) ? encRes / gRatio : encRes;

  const handleImportFromEsi = (device) => {
    onChange?.({
      ...slave,
      name:        device.name,
      vendorId:    device.vendorId,
      productCode: device.productCode,
      revision:    device.revision,
      pdos: (device.allPdos || []).map(pdo => ({
        ...pdo,
        entries: (pdo.entries || []).map(e => ({ ...e, selected: false, varName: '' })),
      })),
      sdos: (device.sdos || []).map(s => ({ ...s })),
    });
    setShowEsiPicker(false);
    setLog(`Imported: ${device.name}`);
  };

  /* The bus this slave belongs to. Names and conflicts are computed over ALL
   * slaves — see the prop comment above and utils/ecNaming. */
  const bus     = allSlaves && allSlaves.length ? allSlaves : [slave];
  const myIndex = allSlaves && allSlaves.length ? slaveIndex : 0;
  const varNames = buildEcVarNames(bus);
  const issues   = findEcIssues(bus);
  const myIssues = issues.filter(i => i.slaveIndex === myIndex);
  const badKeys  = new Set(issues.flatMap(i => i.keys || []));
  const rowKey   = (pi, ei) => `${myIndex}|${pi}|${ei}`;
  // Which PDO already carries each SELECTED object, so the alternative mappings
  // of that same object can be dimmed instead of looking like duplicates.
  const objKey   = (e) => `${(e?.index || 0) >>> 0}|${(e?.subindex || 0) & 0xFF}`;
  const selectedObjectPdo = new Map();
  (slave.pdos || []).forEach(pdo => (pdo.entries || []).forEach(e => {
    if (e.selected) selectedObjectPdo.set(objKey(e), hex(pdo.index));
  }));

  const handleAddGlobalVars = () => {
    if (myIssues.length) { setLog('Fix the PDO mapping problems first.'); return; }
    const vars = ecGlobalVarsForSlave(bus, myIndex);
    if (!vars.length) { setLog('No PDO entries selected.'); return; }
    onAddGlobalVars?.(vars);
    setLog(`Added ${vars.length} global variable(s)`);
  };

  const selectedCount = (slave.pdos || []).reduce((acc, pdo) =>
    acc + (pdo.entries || []).filter(e => e.selected).length, 0);

  const altCount = (slave.pdos || []).reduce((acc, pdo) =>
    acc + (pdo.entries || []).filter(e => !e.selected && selectedObjectPdo.has(objKey(e))).length, 0);

  /* ── Render ── */
  return (
    <div style={S.root}>
      {/* ── Header ── */}
      <div style={S.header}>
        <span style={{ fontSize: 16, flexShrink: 0 }}>🔌</span>
        <input
          style={{ background: 'transparent', border: 'none', outline: 'none', fontWeight: 'bold', fontSize: 14, color: '#9cdcfe', flex: 1, minWidth: 0 }}
          value={slave.name || ''}
          disabled={isRunning}
          placeholder="Slave Name"
          onChange={e => update({ name: e.target.value })}
        />
        {slave.axisRef?.enabled && (
          <span style={{ color: '#ffd54f', fontSize: 11, background: '#3d2e00', padding: '2px 8px', borderRadius: 3, fontWeight: 'bold', flexShrink: 0 }}>
            ⚡ {slave.axisRef.name || 'Axis'}
          </span>
        )}
        <span style={{ color: '#555', fontSize: 10, flexShrink: 0 }}>
          VID:{hex(slave.vendorId)} · PC:{hex(slave.productCode)}
        </span>
        <span style={{ color: '#9cdcfe', fontSize: 10, flexShrink: 0 }}>{selectedCount} PDO</span>
        {esiLibrary.length > 0 && !isRunning && (
          <button style={S.btnSm} onClick={() => setShowEsiPicker(true)}>Import from Library</button>
        )}
        {log && <span style={{ color: '#4caf50', fontSize: 10 }}>{log}</span>}
      </div>

      <div style={S.body}>
        {/* ── Identity ── */}
        <div style={S.section}>
          <div style={S.stitle}>Slave Identity</div>
          <div style={S.row}>
            <span style={S.label}>Position (1-based)</span>
            <input type="number" min={1} style={{ ...S.input, maxWidth: 80 }} value={slave.position || 1}
              disabled={isRunning} onChange={e => update({ position: parseInt(e.target.value) || 1 })} />
          </div>
          <div style={S.row}>
            <span style={S.label}>Vendor ID</span>
            <input style={{ ...S.input, maxWidth: 120, fontFamily: 'monospace' }}
              value={(slave.vendorId >>> 0).toString(16).toUpperCase()}
              placeholder="00000000" disabled={isRunning}
              onChange={e => update({ vendorId: parseInt(e.target.value, 16) || 0 })} />
          </div>
          <div style={S.row}>
            <span style={S.label}>Product Code</span>
            <input style={{ ...S.input, maxWidth: 120, fontFamily: 'monospace' }}
              value={(slave.productCode >>> 0).toString(16).toUpperCase()}
              placeholder="00000000" disabled={isRunning}
              onChange={e => update({ productCode: parseInt(e.target.value, 16) || 0 })} />
          </div>
          <div style={S.row}>
            <span style={S.label}>Revision</span>
            <input style={{ ...S.input, maxWidth: 120, fontFamily: 'monospace' }}
              value={(slave.revision >>> 0).toString(16).toUpperCase()}
              placeholder="00000000" disabled={isRunning}
              onChange={e => update({ revision: parseInt(e.target.value, 16) || 0 })} />
          </div>
        </div>

        {/* ── Tabs: PDO / SDO / Axis ── */}
        <div style={S.section}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 10, borderBottom: '1px solid #333', paddingBottom: 0 }}>
            {[
              { id: 'pdo',  label: 'PDO Mapping' },
              { id: 'sdo',  label: 'SDO Init' },
              { id: 'axis', label: '⚡ Axis (AXIS_REF)' },
            ].map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
                background: activeTab === tab.id ? '#0d47a1' : 'transparent',
                color: activeTab === tab.id ? '#fff'
                     : tab.id === 'axis' && slave.axisRef?.enabled ? '#ffd54f' : '#888',
                border: 'none', borderRadius: '3px 3px 0 0',
                padding: '4px 14px', fontSize: 11, cursor: 'pointer',
              }}>
                {tab.label}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            {activeTab === 'pdo' && !isRunning && (
              <button style={{ ...S.btnSuccess, marginBottom: 4 }} onClick={handleAddGlobalVars}>
                + Add Selected to Globals
              </button>
            )}
          </div>

          {/* PDO */}
          {activeTab === 'pdo' && (
            <>
              {/* ⚠️ Without the PDO column two rows of alternative mappings are
                  literally indistinguishable — same direction, index, subindex,
                  name and type — which is what made a device look like it
                  listed the same variable twice. */}
              {myIssues.length > 0 && (
                <div style={{ background: '#3d0a0a', border: '1px solid #7f1d1d', borderRadius: 4,
                              padding: '7px 10px', marginBottom: 8, color: '#ff8a80', fontSize: 11 }}>
                  <b>PDO mapping problems ({myIssues.length})</b>
                  <ul style={{ margin: '5px 0 0 16px', padding: 0 }}>
                    {myIssues.map((iss, i) => <li key={i} style={{ marginBottom: 2 }}>{iss.message}</li>)}
                  </ul>
                </div>
              )}
              {altCount > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 11, color: '#888' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={hideAlternates}
                      onChange={e => setHideAlternates(e.target.checked)} />
                    Hide alternative mappings of selected objects ({altCount})
                  </label>
                </div>
              )}
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>✔</th>
                    <th style={S.th}>PDO</th>
                    <th style={S.th}>Dir</th>
                    <th style={S.th}>Index</th>
                    <th style={S.th}>Sub</th>
                    <th style={S.th}>Name</th>
                    <th style={S.th}>Type</th>
                    <th style={S.th}>IEC Var Name</th>
                  </tr>
                </thead>
                <tbody>
                  {(slave.pdos || []).flatMap((pdo, pi) =>
                    (pdo.entries || []).map((entry, ei) => {
                      const key     = rowKey(pi, ei);
                      const flagged = badKeys.has(key);
                      // ⚠️ An ESI lists the SAME CoE object in several ALTERNATIVE
                      // PDOs (0x6040 in 0x1600/0x1601/0x1602 here), which reads as
                      // "the import produced duplicates". They are choices, not
                      // copies, and picking two of them is a hard error
                      // (findEcIssues 'duplicate-object'), so a row whose object is
                      // already taken elsewhere is dimmed and says where.
                      const takenIn = (!entry.selected && selectedObjectPdo.get(objKey(entry))) || null;
                      if (takenIn && hideAlternates) return null;
                      const gen     = varNames.get(key);
                      const raw     = entry.varName || '';
                      const badName = !!raw.trim() && sanitizeEcIdent(raw) !== raw.trim();
                      return (
                        <tr key={`${pi}-${ei}`}
                            style={flagged ? { background: '#2a1212' } : takenIn ? { opacity: 0.45 } : undefined}
                            title={takenIn ? `Same object is already selected in PDO ${takenIn} — these are alternative mappings of one object, not two variables.` : undefined}>
                          <td style={S.td}>
                            <input type="checkbox" checked={!!entry.selected} disabled={isRunning}
                              onChange={e => togglePdo(pi, ei, e.target.checked)} />
                          </td>
                          <td style={{ ...S.td, fontFamily: 'monospace', color: '#888', whiteSpace: 'nowrap' }}
                              title={`${pdo.name || ''}${pdo.sm != null ? ` · SM${pdo.sm}` : ''}${(pdo.excludes || []).length ? ` · excludes ${(pdo.excludes || []).map(x => hex(x)).join(', ')}` : ''}`}>
                            {hex(pdo.index)}{pdo.fixed ? ' 🔒' : ''}
                          </td>
                          <td style={S.td}>
                            <span style={{ ...S.chip, ...(pdo.direction === 'input' ? S.chipIn : S.chipOut) }}>
                              {pdo.direction === 'input' ? 'IN' : 'OUT'}
                            </span>
                          </td>
                          <td style={{ ...S.td, fontFamily: 'monospace' }}>{hex(entry.index)}</td>
                          <td style={{ ...S.td, fontFamily: 'monospace' }}>{hex(entry.subindex, 2)}</td>
                          <td style={S.td}>
                            {entry.name}
                            {takenIn && <span style={{ marginLeft: 6, fontSize: 10, color: '#888' }}>· also in {takenIn}</span>}
                          </td>
                          <td style={{ ...S.td, color: '#ce9178' }}>{entry.dtype}</td>
                          <td style={S.td}>
                            <input
                              style={{ ...S.input, maxWidth: '100%', flex: 'unset', width: '100%',
                                       borderColor: (flagged || badName) ? '#c62828' : '#555' }}
                              value={raw} disabled={isRunning}
                              placeholder={gen?.auto || 'auto'}
                              title={badName
                                ? `Will be emitted as "${sanitizeEcIdent(raw)}"`
                                : gen ? `Emitted as "${gen.name}"` : 'Select the entry to generate a name'}
                              onChange={e => {
                                const s = JSON.parse(JSON.stringify(slave));
                                s.pdos[pi].entries[ei].varName = e.target.value;
                                onChange?.(s);
                              }} />
                          </td>
                        </tr>
                      );
                    })
                  )}
                  {(slave.pdos || []).every(p => !(p.entries || []).length) && (
                    <tr>
                      <td colSpan={8} style={{ ...S.td, textAlign: 'center', color: '#555', padding: '20px 0' }}>
                        No PDO entries. Use "Import from Library" or add device data manually.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}

          {/* SDO */}
          {activeTab === 'sdo' && (
            <>
              {(slave.sdos || []).length > 0 ? (
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={S.th}>Index</th>
                      <th style={S.th}>Sub</th>
                      <th style={S.th}>Value (hex)</th>
                      <th style={S.th}>Bytes</th>
                      <th style={S.th}>Comment</th>
                      <th style={S.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {slave.sdos.map((sdo, si) => (
                      <tr key={si}>
                        <td style={S.td}>
                          <input style={{ ...S.input, maxWidth: 70 }} value={sdo.index?.toString(16).toUpperCase() || ''}
                            disabled={isRunning} onChange={e => updateSdo(si, 'index', parseInt(e.target.value, 16) || 0)} />
                        </td>
                        <td style={S.td}>
                          <input style={{ ...S.input, maxWidth: 50 }} value={sdo.subindex ?? 0}
                            type="number" min={0} max={255} disabled={isRunning}
                            onChange={e => updateSdo(si, 'subindex', parseInt(e.target.value) || 0)} />
                        </td>
                        <td style={S.td}>
                          <input style={{ ...S.input, maxWidth: 90 }} value={(sdo.value >>> 0).toString(16).toUpperCase()}
                            disabled={isRunning} onChange={e => updateSdo(si, 'value', parseInt(e.target.value, 16) || 0)} />
                        </td>
                        <td style={S.td}>
                          {(() => {
                            // Derived, not chosen. Only an object nobody can size
                            // (vendor-specific, absent from the ESI and from
                            // CiA402) still offers the manual select.
                            const info = resolveSdoByteSize(slave, sdo.index, sdo.subindex, sdo.byteSize);
                            if (info.source === 'stored') {
                              return (
                                <select style={{ ...S.input, maxWidth: 50 }} value={sdo.byteSize || 1}
                                  title="Unknown object — the ESI does not declare it and it is not a standard CiA402 object, so the size must be entered by hand."
                                  disabled={isRunning} onChange={e => updateSdo(si, 'byteSize', parseInt(e.target.value))}>
                                  <option value={1}>1</option>
                                  <option value={2}>2</option>
                                  <option value={4}>4</option>
                                </select>
                              );
                            }
                            return (
                              <span style={{ fontSize: 11, color: '#888', fontVariantNumeric: 'tabular-nums' }}
                                title={`Size comes from ${info.source}${info.dtype ? ` (${info.dtype})` : ''} — the object defines it, so it is not editable. A mis-sized SDO is aborted by the drive and the bus never reaches OP.`}>
                                {info.size}{info.dtype ? ` · ${info.dtype}` : ` · ${info.source}`}
                              </span>
                            );
                          })()}
                        </td>
                        <td style={S.td}>
                          <input style={{ ...S.input, maxWidth: '100%' }} value={sdo.comment || ''}
                            disabled={isRunning} onChange={e => updateSdo(si, 'comment', e.target.value)} />
                        </td>
                        <td style={S.td}>
                          {!isRunning && (
                            <button style={S.btnDanger} onClick={() => deleteSdo(si)}>✕</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ color: '#555', fontSize: 11, padding: '12px 0' }}>No SDO init commands.</div>
              )}
              {!isRunning && (
                <button style={{ ...S.btnSm, marginTop: 6 }} onClick={addSdo}>+ Add SDO</button>
              )}
            </>
          )}

          {/* Axis */}
          {activeTab === 'axis' && (
            <div>
              <div style={S.row}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!slave.axisRef?.enabled} disabled={isRunning}
                    onChange={e => {
                      if (e.target.checked) updateAxis('enabled', true);
                      else onChange?.({ ...slave, axisRef: { ...defaultAxisRef(), ...slave.axisRef, enabled: false } });
                    }} />
                  <span style={{ color: '#ddd', fontSize: 11 }}>Enable Axis (generates AXIS_REF)</span>
                </label>
              </div>

              {slave.axisRef?.enabled && (
                <div style={{ marginTop: 8 }}>
                  <div style={S.row}>
                    <span style={S.label}>Axis Name</span>
                    <input style={S.input} value={slave.axisRef.name || ''} disabled={isRunning}
                      placeholder={`Axis_${slave.position || 1}`}
                      onChange={e => updateAxis('name', e.target.value)} />
                    <span style={{ color: '#555', fontSize: 10 }}>
                      → AXIS_REF {slave.axisRef.name || `Axis_${slave.position || 1}`};
                    </span>
                  </div>
                  <div style={S.row}>
                    <span style={S.label}>Axis No</span>
                    <input type="number" min={0} max={31} style={{ ...S.input, maxWidth: 80 }}
                      value={slave.axisRef.axisNo ?? 0} disabled={isRunning}
                      onChange={e => updateAxis('axisNo', parseInt(e.target.value) || 0)} />
                    <span style={{ color: '#555', fontSize: 10 }}>
                      → Kron_PI.servo[{slave.axisRef.axisNo ?? 0}]
                    </span>
                  </div>
                  <div style={S.row}>
                    <span style={S.label}>Gear Ratio</span>
                    <input type="number" min={0.000001} step="any" style={{ ...S.input, maxWidth: 120 }}
                      value={axisCfg.gearRatio ?? 1} disabled={isRunning}
                      onChange={e => updateAxis('gearRatio', parseFloat(e.target.value) || 1)} />
                    <span style={{ color: '#555', fontSize: 10 }}>user units per motor revolution (e.g. 5 = 1 rev → 5 mm)</span>
                  </div>
                  <div style={S.row}>
                    <span style={S.label}>Encoder Type</span>
                    <select style={{ ...S.input, maxWidth: 200 }}
                      value={axisCfg.encoderType || 'incremental'} disabled={isRunning}
                      onChange={e => updateAxis('encoderType', e.target.value)}>
                      <option value="incremental">Incremental</option>
                      <option value="absolute_st">Absolute (Single-Turn)</option>
                      <option value="absolute_mt">Absolute (Multi-Turn)</option>
                    </select>
                    <span style={{ color: '#555', fontSize: 10 }}>
                      {axisCfg.encoderType === 'incremental' ? 'Requires homing after power-on' : 'Auto-homed at power-on'}
                    </span>
                  </div>
                  <div style={S.row}>
                    <span style={S.label}>Single-Turn Bits</span>
                    <input type="number" min={1} max={32} style={{ ...S.input, maxWidth: 80 }}
                      value={axisCfg.singleTurnBits ?? 13} disabled={isRunning}
                      onChange={e => updateAxis('singleTurnBits', parseInt(e.target.value) || 13)} />
                    <span style={{ color: '#555', fontSize: 10 }}>{Math.pow(2, axisCfg.singleTurnBits ?? 13)} counts/rev</span>
                  </div>
                  {axisCfg.encoderType === 'absolute_mt' && (
                    <div style={S.row}>
                      <span style={S.label}>Multi-Turn Bits</span>
                      <input type="number" min={1} max={32} style={{ ...S.input, maxWidth: 80 }}
                        value={axisCfg.multiTurnBits ?? 12} disabled={isRunning}
                        onChange={e => updateAxis('multiTurnBits', parseInt(e.target.value) || 12)} />
                      <span style={{ color: '#555', fontSize: 10 }}>{Math.pow(2, axisCfg.multiTurnBits ?? 12)} revolutions range</span>
                    </div>
                  )}
                  <div style={{ ...S.row, color: '#4ec9b0', fontSize: 10, fontFamily: 'monospace' }}>
                    counts/unit = {(encRes / gRatio).toFixed(2)} &nbsp;|&nbsp; vel_raw/unit = {(encRes / gRatio).toFixed(2)} counts/s per u/s
                  </div>
                  <div style={S.row}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!slave.axisRef.simMode} disabled={isRunning}
                        onChange={e => updateAxis('simMode', e.target.checked)} />
                      <span style={{ color: '#999', fontSize: 11 }}>Simulation Mode (no real drive required)</span>
                    </label>
                  </div>

                  {/* ── Motion limits (kron_axis.h AXIS_REF) ───────────────── */}
                  <div style={{ ...S.row, marginTop: 12, color: '#888', fontSize: 11, fontWeight: 600 }}>
                    Motion Limits &amp; Windows
                  </div>
                  <div style={{ ...S.row, color: '#555', fontSize: 10 }}>
                    Leave blank to keep the axis engine's own default. A blank field emits no code.
                  </div>
                  {[
                    ['maxVelocity',      'Max Velocity',       'u/s — 0 or blank: each FB must supply its own'],
                    ['maxAcceleration',  'Max Acceleration',   'u/s²'],
                    ['maxDeceleration',  'Max Deceleration',   'u/s²'],
                    ['maxJerk',          'Max Jerk',           'u/s³ — blank is effectively trapezoidal'],
                    ['inPositionWindow', 'In-Position Window', 'u — a move reports Done inside this'],
                    ['inVelocityWindow', 'In-Velocity Window', 'u/s — InVelocity inside this'],
                  ].map(([key, label, hint]) => (
                    <div style={S.row} key={key}>
                      <span style={S.label}>{label}</span>
                      <input type="number" step="any" style={{ ...S.input, maxWidth: 120 }}
                        value={axisCfg[key] ?? ''} disabled={isRunning}
                        onChange={e => updateAxis(key, e.target.value)} />
                      <span style={{ color: '#555', fontSize: 10 }}>{hint}</span>
                    </div>
                  ))}
                  {/* A software limit of 0.0 is a legitimate coordinate, so the
                      checkbox — never "is the value non-zero" — enables it. */}
                  {[
                    ['enableLimitNegative', 'swLimitNegative', 'Software Limit −'],
                    ['enableLimitPositive', 'swLimitPositive', 'Software Limit +'],
                  ].map(([flag, val, label]) => (
                    <div style={S.row} key={flag}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', minWidth: 150 }}>
                        <input type="checkbox" checked={!!axisCfg[flag]} disabled={isRunning}
                          onChange={e => updateAxis(flag, e.target.checked)} />
                        <span style={{ color: '#999', fontSize: 11 }}>{label}</span>
                      </label>
                      <input type="number" step="any" style={{ ...S.input, maxWidth: 120 }}
                        value={axisCfg[val] ?? 0} disabled={isRunning || !axisCfg[flag]}
                        onChange={e => updateAxis(val, e.target.value)} />
                      <span style={{ color: '#555', fontSize: 10 }}>u</span>
                    </div>
                  ))}
                  <div style={S.row}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', minWidth: 150 }}>
                      <input type="checkbox" checked={!!axisCfg.enablePosLagMonitoring} disabled={isRunning}
                        onChange={e => updateAxis('enablePosLagMonitoring', e.target.checked)} />
                      <span style={{ color: '#999', fontSize: 11 }}>Following Error Monitor</span>
                    </label>
                    <input type="number" step="any" style={{ ...S.input, maxWidth: 120 }}
                      value={axisCfg.maxPositionLag ?? ''} disabled={isRunning || !axisCfg.enablePosLagMonitoring}
                      onChange={e => updateAxis('maxPositionLag', e.target.value)} />
                    <span style={{ color: '#555', fontSize: 10 }}>u — following error that trips the axis</span>
                  </div>

                  {/* Generated code preview */}
                  <div style={{ marginTop: 12, background: '#1a1a1a', borderRadius: 4, padding: '8px 12px', fontFamily: 'monospace', fontSize: 10, color: '#6a9955', lineHeight: 1.6 }}>
                    <div style={{ color: '#555', marginBottom: 4 }}>// Generated in plc.c PLC_Init():</div>
                    <div style={{ color: '#ce9178' }}>
                      {slave.axisRef.name || `Axis_${slave.position || 1}`}.GearRatio = {axisCfg.gearRatio ?? 1};<br />
                      {slave.axisRef.name || `Axis_${slave.position || 1}`}.EncoderType = {
                        ({ incremental: 'KRON_ENC_INCREMENTAL', absolute_st: 'KRON_ENC_ABSOLUTE_ST', absolute_mt: 'KRON_ENC_ABSOLUTE_MT' })[axisCfg.encoderType] || 'KRON_ENC_INCREMENTAL'
                      };<br />
                      Kron_PI.servo[{slave.axisRef.axisNo ?? 0}].counts_per_unit = {countsPerUnit.toFixed(2)}f;<br />
                      Kron_PI.servo[{slave.axisRef.axisNo ?? 0}].vel_raw_per_unit = {countsPerUnit.toFixed(2)}f;
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ESI Picker modal */}
      {showEsiPicker && (
        <>
          <div onClick={() => setShowEsiPicker(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9998 }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            background: '#252526', border: '1px solid #444', borderRadius: 6,
            padding: 16, zIndex: 9999, minWidth: 420, maxWidth: 640, maxHeight: '70vh', overflowY: 'auto',
          }}>
            <div style={{ fontWeight: 'bold', color: '#ddd', marginBottom: 10 }}>
              Select Device from Library ({esiLibrary.length} found)
            </div>
            {esiLibrary.map((dev, i) => (
              <div key={i} onClick={() => handleImportFromEsi(dev)}
                style={{ border: '1px solid #333', borderRadius: 4, padding: '7px 10px', marginBottom: 5,
                  cursor: 'pointer', background: '#2a2a2a', display: 'flex', flexDirection: 'column', gap: 3 }}
                onMouseEnter={e => e.currentTarget.style.background = '#333'}
                onMouseLeave={e => e.currentTarget.style.background = '#2a2a2a'}
              >
                <div style={{ fontWeight: 'bold', color: '#9cdcfe' }}>{dev.name}</div>
                <div style={{ color: '#555', fontSize: 10 }}>
                  {dev.vendorName} · VID:{hex(dev.vendorId)} · PC:{hex(dev.productCode)} · Rev:{hex(dev.revision)}
                </div>
                <div style={{ color: '#888', fontSize: 10 }}>
                  {(dev.txPdos || []).length} TxPDO · {(dev.rxPdos || []).length} RxPDO · {(dev.sdos || []).length} SDO init
                </div>
              </div>
            ))}
            <button style={{ ...S.btnSm, marginTop: 6 }} onClick={() => setShowEsiPicker(false)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
