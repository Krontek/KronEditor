import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { formatTimeUs, parseTimeUs, isTimeType } from '../../utils/plcStandards';

const INT_TYPES = new Set([
  'INT', 'DINT', 'UINT', 'UDINT', 'LINT', 'ULINT',
  'SINT', 'USINT', 'WORD', 'DWORD', 'LWORD', 'BYTE'
]);
const FLOAT_TYPES = new Set(['REAL', 'LREAL']);

const parseIntAny = (s) => {
  const t = (s || '').trim();
  if (!t) return NaN;
  if (t.startsWith('0x') || t.startsWith('0X')) return parseInt(t, 16);
  if (t.startsWith('0b') || t.startsWith('0B')) return parseInt(t.slice(2), 2);
  if (t.startsWith('0o') || t.startsWith('0O')) return parseInt(t.slice(2), 8);
  return parseInt(t, 10);
};

const formatInt = (n, fmt) => {
  if (!isFinite(n)) return '';
  switch (fmt) {
    case 'hex': return '0x' + (n >>> 0).toString(16).toUpperCase();
    case 'oct': return '0o' + (n >>> 0).toString(8);
    case 'bin': return '0b' + (n >>> 0).toString(2);
    default:    return String(n);
  }
};

const displayValue = (val, isTime = false) => {
  if (val === null || val === undefined) return '---';
  if (isTime && typeof val !== 'object') return formatTimeUs(val);
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
};

/**
 * ForceWriteModal — popup for writing a value to a live simulation variable.
 *
 * Props:
 *  isOpen        boolean
 *  onClose       () => void
 *  varName       string  — display name
 *  varType       string  — PLC type ('BOOL', 'INT', 'REAL', …)
 *  currentValue  any     — current live value (null if unknown)
 *  liveKey       string  — key passed to onConfirm
 *  allowPulse    boolean — offer the Pulse/Force choice (local sim and, since the
 *                force-write mailbox, a remote PLC as well)
 *  onConfirm     (key, value, mode) => void  — mode: 'pulse' | 'force' | 'unforce'
 *                (unforce = Release: value is null, the force is dropped)
 */
const ForceWriteModal = ({ isOpen, onClose, varName, varType, currentValue, liveKey, allowPulse, onConfirm }) => {
  // Pulse (write once, logic resumes) works wherever a runtime is live. Callers
  // that know their context pass `allowPulse`; the rest fall back to the flag App
  // publishes on window (mirrors the existing window.stLiveCtx live-context
  // pattern) so every force entry point behaves consistently without threading
  // isSimulationMode through ReactFlow node data.
  const pulseOK = allowPulse !== undefined
    ? allowPulse
    : (typeof window !== 'undefined' && !!window.__kronSimActive);
  const [inputValue, setInputValue] = useState('');
  const [boolSelect, setBoolSelect] = useState('TRUE');
  const [format, setFormat] = useState('dec'); // dec | hex | oct | bin
  const [error, setError] = useState('');
  // 'pulse' = apply for one scan then release (default when offered); 'force' =
  // hold the value every scan. When pulse isn't offered, always force.
  const [mode, setMode] = useState('pulse');

  const type = (varType || '').toUpperCase();
  const isBool  = type === 'BOOL';
  const isInt   = INT_TYPES.has(type);
  const isFloat = FLOAT_TYPES.has(type);
  // TIME/LTIME: signed 64-bit MICROseconds. Entered as an IEC duration
  // (T#2h, -5s, 1m30s) or a bare integer µs count, sent as the exact µs count.
  const isTime  = isTimeType(type);

  // Reset state when modal opens
  useEffect(() => {
    if (!isOpen) return;
    setError('');
    setFormat('dec');
    setMode(pulseOK ? 'pulse' : 'force');
    if (isBool) {
      setBoolSelect(currentValue === true ? 'TRUE' : 'FALSE');
    } else if (isTime && currentValue !== null && currentValue !== undefined && typeof currentValue !== 'object') {
      setInputValue(formatTimeUs(currentValue));
    } else if (currentValue !== null && currentValue !== undefined) {
      setInputValue(String(currentValue));
    } else {
      setInputValue('');
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFormatChange = (newFmt) => {
    if (!isInt) return;
    const n = parseIntAny(inputValue);
    setFormat(newFmt);
    if (!isNaN(n)) setInputValue(formatInt(n, newFmt));
    setError('');
  };

  const confirm = (value) => {
    if (onConfirm) onConfirm(liveKey, value, pulseOK ? mode : 'force');
    onClose();
  };

  // Release ONE variable: drop its force and hand it back to the program
  // (mailbox UNFORCE with no value). Before this the only way out of a Force
  // was Stop, which also restarts the program and drops every other force.
  // Harmless on a variable that is not forced.
  const release = () => {
    if (onConfirm) onConfirm(liveKey, null, 'unforce');
    onClose();
  };

  const handleSubmit = () => {
    if (isBool) {
      confirm(boolSelect === 'TRUE');
      return;
    }
    const s = inputValue.trim();
    if (!s) { setError('Please enter a value'); return; }
    if (isTime) {
      const us = parseTimeUs(s);
      if (us === null) { setError('Invalid duration — e.g. T#2h, T#-5s, 1m30s, or an integer µs count'); return; }
      // Beyond ±2^53 a JS number would round: send the exact decimal string,
      // which both agents parse as int64.
      const asNum = Number(us);
      confirm(Number.isSafeInteger(asNum) ? asNum : us.toString());
    } else if (isInt) {
      const n = parseIntAny(s);
      if (isNaN(n)) { setError('Invalid integer value'); return; }
      confirm(n);
    } else if (isFloat) {
      const n = parseFloat(s);
      if (isNaN(n)) { setError('Invalid float value'); return; }
      confirm(n);
    } else {
      confirm(s);
    }
  };

  if (!isOpen) return null;

  const inputStyle = {
    width: '100%',
    padding: '7px 10px',
    boxSizing: 'border-box',
    background: '#1e1e1e',
    border: `1px solid ${error ? '#f44336' : '#444'}`,
    color: '#9cdcfe',
    borderRadius: 4,
    fontSize: 13,
    outline: 'none',
    fontFamily: 'Consolas, monospace'
  };

  const sharedKeyDown = (e) => {
    if (e.key === 'Enter') handleSubmit();
    if (e.key === 'Escape') onClose();
  };

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.65)',
        zIndex: 99999,
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: '#252526',
          border: '1px solid #007acc',
          borderRadius: 8,
          padding: '16px 20px',
          minWidth: 300,
          maxWidth: 400,
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)'
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header: variable name + close */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ color: '#9cdcfe', fontSize: 14, fontWeight: 'bold', fontFamily: 'Consolas, monospace' }}>
              {varName}
            </span>
            <span style={{ color: '#555', fontSize: 12 }}>:</span>
            <span style={{ color: '#4ec9b0', fontSize: 12 }}>{varType}</span>
            <span style={{ color: '#00e676', fontSize: 12, fontFamily: 'Consolas, monospace', marginLeft: 4 }}>
              = {displayValue(currentValue, isTime)}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '0 2px', marginLeft: 8 }}
          >×</button>
        </div>

        {/* ── BOOL ── combo box */}
        {isBool && (
          <select
            autoFocus
            value={boolSelect}
            onChange={(e) => setBoolSelect(e.target.value)}
            onKeyDown={sharedKeyDown}
            style={{
              ...inputStyle,
              cursor: 'pointer'
            }}
          >
            <option value="TRUE">TRUE</option>
            <option value="FALSE">FALSE</option>
          </select>
        )}

        {/* ── INTEGER ── format selector + input */}
        {isInt && (
          <>
            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
              {[['dec', 'DEC'], ['hex', 'HEX'], ['oct', 'OCT'], ['bin', 'BIN']].map(([f, label]) => (
                <button
                  key={f}
                  onClick={() => handleFormatChange(f)}
                  style={{
                    flex: 1, padding: '4px 0', fontSize: 11, cursor: 'pointer',
                    fontWeight: format === f ? 'bold' : 'normal',
                    background: format === f ? '#007acc' : '#2d2d2d',
                    border: `1px solid ${format === f ? '#007acc' : '#444'}`,
                    color: format === f ? 'white' : '#999',
                    borderRadius: 3
                  }}
                >{label}</button>
              ))}
            </div>
            <input
              type="text"
              autoFocus
              value={inputValue}
              onChange={(e) => { setInputValue(e.target.value); setError(''); }}
              onKeyDown={sharedKeyDown}
              placeholder={format === 'hex' ? '0xFF' : format === 'oct' ? '0o77' : format === 'bin' ? '0b1010' : '0'}
              style={inputStyle}
            />
          </>
        )}

        {/* ── FLOAT ── */}
        {isFloat && (
          <input
            type="number"
            autoFocus
            step="any"
            value={inputValue}
            onChange={(e) => { setInputValue(e.target.value); setError(''); }}
            onKeyDown={sharedKeyDown}
            placeholder="0.0"
            style={inputStyle}
          />
        )}

        {/* ── TIME / LTIME ── */}
        {isTime && (
          <input
            type="text"
            autoFocus
            value={inputValue}
            onChange={(e) => { setInputValue(e.target.value); setError(''); }}
            onKeyDown={sharedKeyDown}
            placeholder="T#1s500ms, T#-5s, 1h30m, or µs"
            style={inputStyle}
          />
        )}

        {/* ── STRING / other ── */}
        {!isBool && !isInt && !isFloat && !isTime && (
          <input
            type="text"
            autoFocus
            value={inputValue}
            onChange={(e) => { setInputValue(e.target.value); setError(''); }}
            onKeyDown={sharedKeyDown}
            placeholder="value"
            style={inputStyle}
          />
        )}

        {/* Error message */}
        {error && (
          <div style={{ color: '#f44336', fontSize: 11, marginTop: 6 }}>{error}</div>
        )}

        {/* Write mode: Pulse (one scan) vs Force (hold) — sim only */}
        {pulseOK && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {[
                ['pulse', 'Pulse', 'Apply for one scan, then the logic resumes'],
                ['force', 'Force', 'Hold the value every scan (pinned)'],
              ].map(([m, label, tip]) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  title={tip}
                  style={{
                    flex: 1, padding: '5px 0', fontSize: 11, cursor: 'pointer',
                    fontWeight: mode === m ? 'bold' : 'normal',
                    background: mode === m ? (m === 'force' ? '#7a4a12' : '#0e639c') : '#2d2d2d',
                    border: `1px solid ${mode === m ? (m === 'force' ? '#a5641a' : '#007acc') : '#444'}`,
                    color: mode === m ? 'white' : '#999',
                    borderRadius: 3,
                  }}
                >{label}</button>
              ))}
            </div>
            <div style={{ color: '#777', fontSize: 10, marginTop: 5, lineHeight: 1.4 }}>
              {mode === 'pulse'
                ? 'Writes the value for a single scan; the program keeps running from it.'
                : 'Holds the value until you Release it or Stop the run (the program can’t change it).'}
            </div>
          </div>
        )}

        {/* OK / Cancel — for all types */}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={{
            flex: 1, padding: '7px 0', background: 'transparent',
            border: '1px solid #444', color: '#999', borderRadius: 4, cursor: 'pointer', fontSize: 12
          }}>Cancel</button>
          <button onClick={release}
            title="Remove the force on this variable — the program controls it again. Other forces stay."
            style={{
              flex: 1, padding: '7px 0', background: 'transparent',
              border: '1px solid #a5641a', color: '#e0a060', borderRadius: 4, cursor: 'pointer', fontSize: 12
            }}>Release</button>
          <button onClick={handleSubmit} style={{
            flex: 2, padding: '7px 0', background: '#007acc', border: 'none',
            color: 'white', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 'bold'
          }}>OK</button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ForceWriteModal;
