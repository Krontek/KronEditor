/**
 * EtherCATEditor.jsx  –  EtherCAT Master configuration editor
 * Only master-level settings (ifname, cycle, DC, state machine).
 * Slaves are managed via the Project Sidebar and open as separate SlaveConfigPage tabs.
 */

import { useState, useCallback, useEffect } from 'react';
import EtherCATIconSrc from '../assets/icons/ethercat.png';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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
  btnSm: {
    background: '#37474f', color: '#ccc', border: 'none', borderRadius: 3,
    padding: '3px 8px', fontSize: 10, cursor: 'pointer',
  },
};

/* ── EtherCAT state machine ──────────────────────────────────────────────── */
const EC_STATES = [
  { id: 'init',   label: 'INIT',    code: 0x01, color: '#37474f', activeColor: '#90a4ae', desc: 'Power-on / Reset — no communication' },
  { id: 'preop',  label: 'PRE-OP',  code: 0x02, color: '#1a237e', activeColor: '#5c6bc0', desc: 'Mailbox (SDO) communication enabled' },
  { id: 'safeop', label: 'SAFE-OP', code: 0x04, color: '#bf360c', activeColor: '#ff7043', desc: 'PDO inputs active, outputs in safe state' },
  { id: 'op',     label: 'OP',      code: 0x08, color: '#1b5e20', activeColor: '#66bb6a', desc: 'Full operation — all PDOs active' },
];

/* ── Default master config (no slaves — slaves live in busConfig.slaves) ─── */
const defaultMasterConfig = () => ({
  ifname:       'eth0',
  cycle_us:     1000,
  dc_enable:    false,
  target_state: 'op',
});

/* ── Main component ──────────────────────────────────────────────────────── */
export default function EtherCATEditor({ busConfig, onChange, isRunning = false }) {
  // Strip slaves from local state — they are managed via SlaveConfigPage tabs
  const [config, setConfig] = useState(() => {
    const { slaves: _slaves, ...rest } = { ...defaultMasterConfig(), ...(busConfig || {}) };
    return rest;
  });
  const [log, setLog] = useState('');
  const [netIfaces, setNetIfaces] = useState([]);
  const [liveEcState, setLiveEcState] = useState(null);

  useEffect(() => {
    invoke('list_network_interfaces').then(setNetIfaces).catch(() => {});
  }, []);

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

  /* Propagate master settings up; preserve existing slaves in parent */
  const update = useCallback((newCfg) => {
    setConfig(newCfg);
    onChange?.(newCfg);
  }, [onChange]);

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

        {/* ── Slaves hint ── */}
        <div style={{ ...S.section, borderStyle: 'dashed', borderColor: '#3a3a3a' }}>
          <div style={{ color: '#555', fontSize: 11, textAlign: 'center', padding: '6px 0' }}>
            Slaves are managed in the Project Sidebar — right-click the Master node to add slaves.
            Each slave opens as a separate tab with PDO, SDO and Axis configuration.
          </div>
        </div>

        {/* ── State Machine ── */}
        <div style={S.section}>
          <div style={S.sectionTitle}>State Machine</div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', paddingBottom: 20 }}>
            {EC_STATES.map((st, idx) => {
              const isTarget = config.target_state === st.id;
              const isLive   = liveEcState === st.id;
              return (
                <div key={st.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {idx > 0 && <span style={{ color: '#444', fontSize: 18, lineHeight: 1 }}>→</span>}
                  <div style={{ position: 'relative' }}>
                    <div
                      title={st.desc}
                      onClick={() => !isRunning && update({ ...config, target_state: st.id })}
                      style={{
                        padding: '7px 14px', borderRadius: 4, fontSize: 11, fontWeight: 'bold',
                        cursor: isRunning ? 'default' : 'pointer',
                        border: isLive ? '2px solid #fff' : isTarget ? `2px solid ${st.activeColor}` : '2px solid #333',
                        background: isLive ? st.activeColor : isTarget ? `${st.color}dd` : '#2a2a2a',
                        color: isLive || isTarget ? '#fff' : '#555',
                        transition: 'all 0.15s',
                        boxShadow: isLive ? `0 0 8px ${st.activeColor}88` : 'none',
                      }}
                    >
                      {st.label}
                    </div>
                    <div style={{
                      position: 'absolute', top: '100%', left: '50%',
                      transform: 'translateX(-50%)', fontSize: 9, marginTop: 3,
                      whiteSpace: 'nowrap',
                      color: isLive ? '#fff' : isTarget ? st.activeColor : '#444',
                    }}>
                      {isLive ? '● live' : isTarget ? '▲ target' : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {isRunning ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              <span style={{ color: '#888', fontSize: 10 }}>Request transition:</span>
              {EC_STATES.map(st => (
                <button key={st.id}
                  style={{ ...S.btnSm, borderLeft: `3px solid ${st.activeColor}`, color: st.activeColor }}
                  onClick={() => handleRequestState(st.id)}
                >
                  → {st.label}
                </button>
              ))}
            </div>
          ) : (
            <p style={{ color: '#555', fontSize: 10, margin: 0 }}>
              Click a state to set the target operational state.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
