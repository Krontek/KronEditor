/**
 * EtherCATEditor.jsx  –  EtherCAT Master configuration editor
 *
 * Allows the user to:
 *   1. Set the network interface name (e.g. "eth0") and cycle time
 *   2. Import ESI XML files to discover slaves
 *   3. Select PDO entries from each slave (inputs / outputs)
 *   4. Configure SDO init commands per slave
 *   5. Export the configuration back to the bus state (for CTranspilerService)
 *   6. Add selected PDO variables as global variables
 */

import { useState, useCallback, useEffect } from 'react';
import EtherCATIconSrc from '../assets/icons/ethercat.png';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { pdoEntriesToGlobalVars } from '../services/EsiParser';

/* ── Styles ────────────────────────────────────────────────────────────────── */
const S = {
  root: {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
    background: '#1e1e1e', color: '#ccc', fontSize: 12, overflow: 'hidden',
  },
  header: {
    background: '#252526', borderBottom: '1px solid #333',
    padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 10,
    flexShrink: 0,
  },
  title: { fontWeight: 'bold', fontSize: 13, color: '#ddd', letterSpacing: 0.3 },
  body: { flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 14 },
  section: {
    background: '#252526', border: '1px solid #333', borderRadius: 4, padding: '10px 12px',
  },
  sectionTitle: {
    fontWeight: 'bold', fontSize: 11, color: '#9cdcfe', textTransform: 'uppercase',
    letterSpacing: 0.5, marginBottom: 8,
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  label: { color: '#999', minWidth: 130, fontSize: 11 },
  input: {
    background: '#3c3c3c', color: '#ccc', border: '1px solid #555',
    borderRadius: 3, padding: '3px 7px', fontSize: 11, outline: 'none',
    flex: 1, maxWidth: 200,
  },
  btn: {
    background: '#0d47a1', color: '#fff', border: 'none', borderRadius: 3,
    padding: '4px 10px', fontSize: 11, cursor: 'pointer',
  },
  btnSm: {
    background: '#37474f', color: '#ccc', border: 'none', borderRadius: 3,
    padding: '3px 8px', fontSize: 10, cursor: 'pointer',
  },
  btnDanger: {
    background: '#5d0000', color: '#ff8a80', border: 'none', borderRadius: 3,
    padding: '3px 8px', fontSize: 10, cursor: 'pointer',
  },
  btnSuccess: {
    background: '#1b5e20', color: '#a5d6a7', border: 'none', borderRadius: 3,
    padding: '4px 10px', fontSize: 11, cursor: 'pointer',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11 },
  th: {
    background: '#1a1a1a', padding: '4px 6px', textAlign: 'left',
    borderBottom: '1px solid #444', color: '#888', fontWeight: 'normal',
  },
  td: { padding: '3px 6px', borderBottom: '1px solid #2a2a2a', verticalAlign: 'middle' },
  chip: {
    display: 'inline-block', padding: '1px 6px', borderRadius: 10, fontSize: 10,
    fontWeight: 'bold', marginRight: 2,
  },
  chipIn:  { background: '#0a3d62', color: '#74b9ff' },
  chipOut: { background: '#3d0a0a', color: '#ff7675' },
};

/* ── EtherCAT state machine ──────────────────────────────────────────────── */
const EC_STATES = [
  { id: 'init',   label: 'INIT',    code: 0x01, color: '#37474f', activeColor: '#90a4ae', desc: 'Power-on / Reset — no communication' },
  { id: 'preop',  label: 'PRE-OP',  code: 0x02, color: '#1a237e', activeColor: '#5c6bc0', desc: 'Mailbox (SDO) communication enabled' },
  { id: 'safeop', label: 'SAFE-OP', code: 0x04, color: '#bf360c', activeColor: '#ff7043', desc: 'PDO inputs active, outputs in safe state' },
  { id: 'op',     label: 'OP',      code: 0x08, color: '#1b5e20', activeColor: '#66bb6a', desc: 'Full operation — all PDOs active' },
];

/* ── Default EtherCAT config ─────────────────────────────────────────────── */
const defaultConfig = () => ({
  ifname:       'eth0',
  cycle_us:     1000,        /* 1 ms */
  dc_enable:    false,
  target_state: 'op',        /* desired bus state: 'init'|'preop'|'safeop'|'op' */
  slaves:       [],          /* KRON_EC_Slave[] */
});

/* ── Helper: format index/subindex ──────────────────────────────────────── */
const hex = (n, w = 4) => '0x' + (n ?? 0).toString(16).toUpperCase().padStart(w, '0');

/* ── SlaveRow ────────────────────────────────────────────────────────────── */
function SlaveRow({ slave, slaveIdx, onUpdate, onDelete, isRunning }) {
  const [expanded, setExpanded] = useState(false);

  const togglePdo = (pdoIdx, entryIdx, checked) => {
    const updated = JSON.parse(JSON.stringify(slave));
    updated.pdos[pdoIdx].entries[entryIdx].selected = checked;
    onUpdate(slaveIdx, updated);
  };

  const updateSdo = (sdoIdx, field, value) => {
    const updated = JSON.parse(JSON.stringify(slave));
    updated.sdos[sdoIdx][field] = value;
    onUpdate(slaveIdx, updated);
  };

  const addSdo = () => {
    const updated = JSON.parse(JSON.stringify(slave));
    updated.sdos = [...(updated.sdos || []), { index: 0x6040, subindex: 0, value: 6, byteSize: 2, comment: '' }];
    onUpdate(slaveIdx, updated);
  };

  const deleteSdo = (sdoIdx) => {
    const updated = JSON.parse(JSON.stringify(slave));
    updated.sdos.splice(sdoIdx, 1);
    onUpdate(slaveIdx, updated);
  };

  const selectedCount = (slave.pdos || []).reduce((acc, pdo) =>
    acc + (pdo.entries || []).filter(e => e.selected).length, 0);

  return (
    <div style={{ border: '1px solid #333', borderRadius: 4, marginBottom: 6 }}>
      {/* Slave header */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
                 background: '#2a2a2a', cursor: 'pointer', borderRadius: expanded ? '4px 4px 0 0' : 4 }}
        onClick={() => setExpanded(e => !e)}
      >
        <span style={{ color: '#888', width: 10 }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ fontWeight: 'bold', color: '#ddd', flex: 1 }}>
          [{slave.position}] {slave.name}
        </span>
        <span style={{ color: '#555', fontSize: 10 }}>
          VID:{hex(slave.vendorId)} PC:{hex(slave.productCode)}
        </span>
        <span style={{ color: '#9cdcfe', fontSize: 10 }}>{selectedCount} PDO mapped</span>
        {!isRunning && (
          <button style={S.btnDanger} onClick={e => { e.stopPropagation(); onDelete(slaveIdx); }}>✕</button>
        )}
      </div>

      {expanded && (
        <div style={{ padding: '8px 10px' }}>
          {/* Position */}
          <div style={S.row}>
            <span style={S.label}>Position (1-based)</span>
            <input
              type="number" min={1} value={slave.position}
              style={{ ...S.input, maxWidth: 70 }}
              disabled={isRunning}
              onChange={e => onUpdate(slaveIdx, { ...slave, position: parseInt(e.target.value) || 1 })}
            />
          </div>

          {/* PDO entries */}
          <div style={{ ...S.sectionTitle, marginTop: 8 }}>PDO Mapping</div>
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
              {(slave.pdos || []).map((pdo, pi) =>
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
                      <input
                        style={{ ...S.input, maxWidth: '100%', flex: 'unset', width: '100%' }}
                        value={entry.varName || ''}
                        disabled={isRunning}
                        placeholder="auto"
                        onChange={e => {
                          const updated = JSON.parse(JSON.stringify(slave));
                          updated.pdos[pi].entries[ei].varName = e.target.value;
                          onUpdate(slaveIdx, updated);
                        }}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {/* SDO init commands */}
          <div style={{ ...S.sectionTitle, marginTop: 10 }}>SDO Init Commands</div>
          {(slave.sdos || []).length > 0 && (
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
                        disabled={isRunning}
                        onChange={e => updateSdo(si, 'index', parseInt(e.target.value, 16) || 0)} />
                    </td>
                    <td style={S.td}>
                      <input style={{ ...S.input, maxWidth: 50 }} value={sdo.subindex ?? 0}
                        type="number" min={0} max={255} disabled={isRunning}
                        onChange={e => updateSdo(si, 'subindex', parseInt(e.target.value) || 0)} />
                    </td>
                    <td style={S.td}>
                      <input style={{ ...S.input, maxWidth: 90 }} value={(sdo.value >>> 0).toString(16).toUpperCase()}
                        disabled={isRunning}
                        onChange={e => updateSdo(si, 'value', parseInt(e.target.value, 16) || 0)} />
                    </td>
                    <td style={S.td}>
                      <select style={{ ...S.input, maxWidth: 50 }} value={sdo.byteSize || 1}
                        disabled={isRunning}
                        onChange={e => updateSdo(si, 'byteSize', parseInt(e.target.value))}>
                        <option value={1}>1</option><option value={2}>2</option><option value={4}>4</option>
                      </select>
                    </td>
                    <td style={S.td}>
                      <input style={{ ...S.input, maxWidth: '100%' }} value={sdo.comment || ''}
                        disabled={isRunning}
                        onChange={e => updateSdo(si, 'comment', e.target.value)} />
                    </td>
                    <td style={S.td}>
                      {!isRunning && <button style={S.btnDanger} onClick={() => deleteSdo(si)}>✕</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!isRunning && (
            <button style={{ ...S.btnSm, marginTop: 4 }} onClick={addSdo}>+ SDO</button>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */
export default function EtherCATEditor({ busConfig, onChange, onAddGlobalVars, isRunning = false, esiLibrary = [] }) {
  const [config, setConfig] = useState(() => ({ ...defaultConfig(), ...(busConfig || {}) }));
  const [showEsiPicker, setShowEsiPicker] = useState(false);
  const [log, setLog] = useState('');
  const [netIfaces, setNetIfaces] = useState([]);
  const [liveEcState, setLiveEcState] = useState(null); /* state id string or null */

  useEffect(() => {
    invoke('list_network_interfaces').then(setNetIfaces).catch(() => {});
  }, []);

  /* Subscribe to live EtherCAT state events while simulation is running */
  useEffect(() => {
    if (!isRunning) { setLiveEcState(null); return; }
    let unlisten;
    listen('ec-state-update', (event) => {
      const code = event.payload?.state_code;
      const st = EC_STATES.find(s => s.code === code);
      if (st) setLiveEcState(st.id);
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, [isRunning]);

  const handleRequestState = useCallback(async (stateId) => {
    try {
      await invoke('ec_request_state', { state: stateId });
      setLog(`State transition to ${stateId.toUpperCase()} requested`);
    } catch (e) {
      setLog(`Error: ${e}`);
    }
  }, []);

  /* Propagate changes up */
  const update = useCallback((newCfg) => {
    setConfig(newCfg);
    onChange?.(newCfg);
  }, [onChange]);

  /* ── Open library picker ── */
  const handleOpenLibraryPicker = useCallback(() => {
    setShowEsiPicker(true);
  }, []);

  /* ── Add device from ESI picker ── */
  const handleAddDevice = useCallback((device) => {
    const newSlave = {
      position:    (config.slaves.length + 1),
      name:        device.name,
      vendorId:    device.vendorId,
      productCode: device.productCode,
      revision:    device.revision,
      pdos:        device.allPdos.map(pdo => ({
        ...pdo,
        entries: pdo.entries.map(e => ({
          ...e,
          selected: false,
          varName:  '',
        })),
      })),
      sdos:        device.sdos.map(s => ({ ...s })),
    };
    const newCfg = { ...config, slaves: [...config.slaves, newSlave] };
    update(newCfg);
    setShowEsiPicker(false);
    setLog(`Added slave: ${device.name}`);
  }, [config, update]);

  /* ── Update slave ── */
  const handleUpdateSlave = useCallback((idx, updated) => {
    const slaves = config.slaves.map((s, i) => i === idx ? updated : s);
    update({ ...config, slaves });
  }, [config, update]);

  /* ── Delete slave ── */
  const handleDeleteSlave = useCallback((idx) => {
    const slaves = config.slaves.filter((_, i) => i !== idx);
    update({ ...config, slaves });
  }, [config, update]);

  /* ── Add global vars for selected PDO entries ── */
  const handleAddGlobalVars = useCallback(() => {
    const selectedEntries = [];
    for (const slave of config.slaves) {
      for (const pdo of (slave.pdos || [])) {
        for (const entry of (pdo.entries || [])) {
          if (entry.selected) {
            selectedEntries.push({
              entry: {
                ...entry,
                varName: entry.varName,
              },
              slaveName: slave.name,
              direction: pdo.direction,
            });
          }
        }
      }
    }
    if (!selectedEntries.length) {
      setLog('No PDO entries selected.');
      return;
    }
    const vars = pdoEntriesToGlobalVars(selectedEntries);
    /* Merge custom varName if set */
    const finalVars = vars.map((v, i) => {
      const custom = selectedEntries[i]?.entry?.varName;
      return custom ? { ...v, name: custom } : v;
    });
    onAddGlobalVars?.(finalVars);
    setLog(`Added ${finalVars.length} global variable(s)`);
  }, [config, onAddGlobalVars]);

  return (
    <div style={S.root}>
      {/* ── Header ── */}
      <div style={S.header}>
        <img src={EtherCATIconSrc} height="18" style={{ objectFit: 'contain', flexShrink: 0 }} alt="EtherCAT" />
        <span style={S.title}>Master Configuration</span>
        {log && <span style={{ color: '#4caf50', fontSize: 10, marginLeft: 'auto' }}>{log}</span>}
      </div>

      <div style={S.body}>
        {/* ── Master Settings ── */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Master Settings</div>

          <div style={S.row}>
            <span style={S.label}>Network Interface</span>
            <input
              style={S.input}
              list="net-ifaces-list"
              value={config.ifname}
              disabled={isRunning}
              placeholder="eth0"
              onChange={e => update({ ...config, ifname: e.target.value })}
            />
            <datalist id="net-ifaces-list">
              {netIfaces.map(iface => <option key={iface} value={iface} />)}
            </datalist>
            <span style={{ color: '#555', fontSize: 10 }}>
              {netIfaces.length > 0 ? netIfaces.join(', ') : 'eth0, enp2s0 …'}
            </span>
          </div>

          <div style={S.row}>
            <span style={S.label}>Cycle Time (µs)</span>
            <input
              type="number" min={100} max={100000} step={100}
              style={{ ...S.input, maxWidth: 100 }}
              value={config.cycle_us}
              disabled={isRunning}
              onChange={e => update({ ...config, cycle_us: parseInt(e.target.value) || 1000 })}
            />
            <span style={{ color: '#555', fontSize: 10 }}>
              {config.cycle_us >= 1000
                ? `${(config.cycle_us / 1000).toFixed(3)} ms`
                : `${config.cycle_us} µs`}
            </span>
          </div>

          <div style={S.row}>
            <span style={S.label}>Distributed Clocks</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!!config.dc_enable}
                disabled={isRunning}
                onChange={e => update({ ...config, dc_enable: e.target.checked })}
              />
              <span style={{ color: '#999', fontSize: 11 }}>Enable DC (IEEE 1588 sync)</span>
            </label>
          </div>
        </div>

        {/* ── Slaves ── */}
        <div style={S.section}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={S.sectionTitle}>Slaves ({config.slaves.length})</span>
            {!isRunning && (
              <>
                <button style={S.btn} onClick={handleOpenLibraryPicker} disabled={esiLibrary.length === 0} title={esiLibrary.length === 0 ? 'Load ESI files in Settings → Fieldbus first' : ''}>+ Add from Library</button>
                <button
                  style={S.btnSm}
                  onClick={() => {
                    const s = {
                      position: config.slaves.length + 1,
                      name: `Slave_${config.slaves.length + 1}`,
                      vendorId: 0, productCode: 0, revision: 0,
                      pdos: [], sdos: [],
                    };
                    update({ ...config, slaves: [...config.slaves, s] });
                  }}
                >+ Manual</button>
              </>
            )}
          </div>

          {config.slaves.length === 0 ? (
            <div style={{ color: '#555', fontSize: 11, padding: '12px 0', textAlign: 'center' }}>
              No slaves configured. Add from library or add manually.
            </div>
          ) : (
            config.slaves.map((slave, i) => (
              <SlaveRow
                key={i}
                slave={slave}
                slaveIdx={i}
                onUpdate={handleUpdateSlave}
                onDelete={handleDeleteSlave}
                isRunning={isRunning}
              />
            ))
          )}
        </div>

        {/* ── State Machine ── */}
        <div style={S.section}>
          <div style={S.sectionTitle}>State Machine</div>

          {/* State flow diagram */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', paddingBottom: 20 }}>
            {EC_STATES.map((st, idx) => {
              const isTarget = config.target_state === st.id;
              const isLive   = liveEcState === st.id;
              return (
                <div key={st.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {idx > 0 && (
                    <span style={{ color: '#444', fontSize: 18, lineHeight: 1 }}>→</span>
                  )}
                  <div style={{ position: 'relative' }}>
                    <div
                      title={st.desc}
                      onClick={() => !isRunning && update({ ...config, target_state: st.id })}
                      style={{
                        padding: '7px 14px',
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 'bold',
                        cursor: isRunning ? 'default' : 'pointer',
                        border: isLive
                          ? '2px solid #fff'
                          : isTarget
                            ? `2px solid ${st.activeColor}`
                            : '2px solid #333',
                        background: isLive
                          ? st.activeColor
                          : isTarget
                            ? `${st.color}dd`
                            : '#2a2a2a',
                        color: isLive || isTarget ? '#fff' : '#555',
                        transition: 'all 0.15s',
                        boxShadow: isLive ? `0 0 8px ${st.activeColor}88` : 'none',
                      }}
                    >
                      {st.label}
                    </div>
                    {/* label below box */}
                    <div style={{
                      position: 'absolute', top: '100%', left: '50%',
                      transform: 'translateX(-50%)',
                      fontSize: 9, marginTop: 3, whiteSpace: 'nowrap',
                      color: isLive ? '#fff' : isTarget ? st.activeColor : '#444',
                    }}>
                      {isLive ? '● live' : isTarget ? '▲ target' : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Request state buttons — only when simulation running */}
          {isRunning ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              <span style={{ color: '#888', fontSize: 10 }}>Request transition:</span>
              {EC_STATES.map(st => (
                <button
                  key={st.id}
                  style={{
                    ...S.btnSm,
                    borderLeft: `3px solid ${st.activeColor}`,
                    color: st.activeColor,
                  }}
                  onClick={() => handleRequestState(st.id)}
                >
                  → {st.label}
                </button>
              ))}
            </div>
          ) : (
            <p style={{ color: '#555', fontSize: 10, margin: 0 }}>
              Click a state to set the target operational state. Generated code will bring the bus to this state.
            </p>
          )}
        </div>

        {/* ── Global Variable Integration ── */}
        {config.slaves.length > 0 && (
          <div style={S.section}>
            <div style={S.sectionTitle}>Global Variables</div>
            <p style={{ color: '#888', fontSize: 11, margin: '0 0 8px' }}>
              Select PDO entries in slaves above, then click "Add to Globals" to create
              matching global variables that are wired to the EtherCAT PDO data.
            </p>
            {!isRunning && (
              <button style={S.btnSuccess} onClick={handleAddGlobalVars}>
                + Add Selected PDOs to Global Variables
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── ESI Device Picker modal ── */}
      {showEsiPicker && (
        <>
          <div
            onClick={() => setShowEsiPicker(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9998 }}
          />
          <div style={{
            position: 'fixed', top: '50%', left: '50%',
            transform: 'translate(-50%,-50%)',
            background: '#252526', border: '1px solid #444', borderRadius: 6,
            padding: 16, zIndex: 9999, minWidth: 420, maxWidth: 640,
            maxHeight: '70vh', overflowY: 'auto',
          }}>
            <div style={{ fontWeight: 'bold', color: '#ddd', marginBottom: 10 }}>
              Select Device from Library ({esiLibrary.length} found)
            </div>
            {esiLibrary.map((dev, i) => (
              <div
                key={i}
                style={{
                  border: '1px solid #333', borderRadius: 4, padding: '7px 10px',
                  marginBottom: 5, cursor: 'pointer', background: '#2a2a2a',
                  display: 'flex', flexDirection: 'column', gap: 3,
                }}
                onClick={() => handleAddDevice(dev)}
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
            <button style={{ ...S.btnSm, marginTop: 6 }} onClick={() => setShowEsiPicker(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
