/**
 * SlaveConfigPage.jsx — Full-page editor for a single EtherCAT slave
 * Opens as a tab when a slave node is clicked in the Project Sidebar.
 */
import { useState } from 'react';
import { pdoEntriesToGlobalVars } from '../services/EsiParser';

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

export default function SlaveConfigPage({ slave, onChange, onAddGlobalVars, isRunning = false, esiLibrary = [] }) {
  const [activeTab, setActiveTab]       = useState('pdo');
  const [showEsiPicker, setShowEsiPicker] = useState(false);
  const [log, setLog]                   = useState('');

  if (!slave) return <div style={{ ...S.root, alignItems: 'center', justifyContent: 'center', color: '#555' }}>No slave selected.</div>;

  /* ── Helpers ── */
  const update = (fields) => onChange?.({ ...slave, ...fields });

  const togglePdo = (pdoIdx, entryIdx, checked) => {
    const s = JSON.parse(JSON.stringify(slave));
    s.pdos[pdoIdx].entries[entryIdx].selected = checked;
    onChange?.(s);
  };

  const updateSdo = (sdoIdx, field, value) => {
    const s = JSON.parse(JSON.stringify(slave));
    s.sdos[sdoIdx][field] = value;
    onChange?.(s);
  };

  const addSdo = () => {
    const s = JSON.parse(JSON.stringify(slave));
    s.sdos = [...(s.sdos || []), { index: 0x6040, subindex: 0, value: 6, byteSize: 2, comment: '' }];
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
    countsPerUnit: 10000,
    velRawPerUnit: 1000,
    simMode: false,
  });

  const updateAxis = (field, value) =>
    onChange?.({ ...slave, axisRef: { ...defaultAxisRef(), ...slave.axisRef, [field]: value } });

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

  const handleAddGlobalVars = () => {
    const selectedEntries = [];
    for (const pdo of (slave.pdos || [])) {
      for (const entry of (pdo.entries || [])) {
        if (entry.selected) selectedEntries.push({ entry, slaveName: slave.name, direction: pdo.direction });
      }
    }
    if (!selectedEntries.length) { setLog('No PDO entries selected.'); return; }
    const vars = pdoEntriesToGlobalVars(selectedEntries);
    const finalVars = vars.map((v, i) => {
      const custom = selectedEntries[i]?.entry?.varName;
      return custom ? { ...v, name: custom } : v;
    });
    onAddGlobalVars?.(finalVars);
    setLog(`Added ${finalVars.length} global variable(s)`);
  };

  const selectedCount = (slave.pdos || []).reduce((acc, pdo) =>
    acc + (pdo.entries || []).filter(e => e.selected).length, 0);

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
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>✔</th>
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
                  (pdo.entries || []).map((entry, ei) => (
                    <tr key={`${pi}-${ei}`}>
                      <td style={S.td}>
                        <input type="checkbox" checked={!!entry.selected} disabled={isRunning}
                          onChange={e => togglePdo(pi, ei, e.target.checked)} />
                      </td>
                      <td style={S.td}>
                        <span style={{ ...S.chip, ...(pdo.direction === 'input' ? S.chipIn : S.chipOut) }}>
                          {pdo.direction === 'input' ? 'IN' : 'OUT'}
                        </span>
                      </td>
                      <td style={{ ...S.td, fontFamily: 'monospace' }}>{hex(entry.index)}</td>
                      <td style={{ ...S.td, fontFamily: 'monospace' }}>{hex(entry.subindex, 2)}</td>
                      <td style={S.td}>{entry.name}</td>
                      <td style={{ ...S.td, color: '#ce9178' }}>{entry.dtype}</td>
                      <td style={S.td}>
                        <input style={{ ...S.input, maxWidth: '100%', flex: 'unset', width: '100%' }}
                          value={entry.varName || ''} disabled={isRunning} placeholder="auto"
                          onChange={e => {
                            const s = JSON.parse(JSON.stringify(slave));
                            s.pdos[pi].entries[ei].varName = e.target.value;
                            onChange?.(s);
                          }} />
                      </td>
                    </tr>
                  ))
                )}
                {(slave.pdos || []).every(p => !(p.entries || []).length) && (
                  <tr>
                    <td colSpan={7} style={{ ...S.td, textAlign: 'center', color: '#555', padding: '20px 0' }}>
                      No PDO entries. Use "Import from Library" or add device data manually.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
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
                          <select style={{ ...S.input, maxWidth: 50 }} value={sdo.byteSize || 1}
                            disabled={isRunning} onChange={e => updateSdo(si, 'byteSize', parseInt(e.target.value))}>
                            <option value={1}>1</option>
                            <option value={2}>2</option>
                            <option value={4}>4</option>
                          </select>
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
                    <span style={S.label}>Counts / Unit</span>
                    <input type="number" min={1} style={{ ...S.input, maxWidth: 120 }}
                      value={slave.axisRef.countsPerUnit ?? 10000} disabled={isRunning}
                      onChange={e => updateAxis('countsPerUnit', parseFloat(e.target.value) || 10000)} />
                    <span style={{ color: '#555', fontSize: 10 }}>encoder counts per user unit</span>
                  </div>
                  <div style={S.row}>
                    <span style={S.label}>Vel Raw / Unit</span>
                    <input type="number" min={1} style={{ ...S.input, maxWidth: 120 }}
                      value={slave.axisRef.velRawPerUnit ?? 1000} disabled={isRunning}
                      onChange={e => updateAxis('velRawPerUnit', parseFloat(e.target.value) || 1000)} />
                    <span style={{ color: '#555', fontSize: 10 }}>raw velocity per user unit</span>
                  </div>
                  <div style={S.row}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!slave.axisRef.simMode} disabled={isRunning}
                        onChange={e => updateAxis('simMode', e.target.checked)} />
                      <span style={{ color: '#999', fontSize: 11 }}>Simulation Mode (no real drive required)</span>
                    </label>
                  </div>

                  {/* Generated code preview */}
                  <div style={{ marginTop: 12, background: '#1a1a1a', borderRadius: 4, padding: '8px 12px', fontFamily: 'monospace', fontSize: 10, color: '#6a9955', lineHeight: 1.6 }}>
                    <div style={{ color: '#555', marginBottom: 4 }}>// Generated in plc.h / plc.c:</div>
                    <div style={{ color: '#9cdcfe' }}>extern AXIS_REF {slave.axisRef.name || `Axis_${slave.position || 1}`};</div>
                    <div style={{ color: '#ce9178', marginTop: 4 }}>
                      {'// PLC_Init():'}<br />
                      {slave.axisRef.name || `Axis_${slave.position || 1}`}.AxisNo = {slave.axisRef.axisNo ?? 0};<br />
                      {slave.axisRef.name || `Axis_${slave.position || 1}`}.slot = &Kron_PI.servo[{slave.axisRef.axisNo ?? 0}];<br />
                      Kron_PI.servo[{slave.axisRef.axisNo ?? 0}].counts_per_unit = {slave.axisRef.countsPerUnit ?? 10000}f;<br />
                      Kron_PI.servo[{slave.axisRef.axisNo ?? 0}].vel_raw_per_unit = {slave.axisRef.velRawPerUnit ?? 1000}f;
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
