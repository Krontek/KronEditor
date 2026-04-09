import React, { useState, useEffect, useRef } from 'react';
import { DataTypeSelector, ModernSelect } from './common/Selectors';
import ForceWriteModal from './common/ForceWriteModal';
import { useTranslation } from 'react-i18next';
import { formatTimeUs } from '../utils/plcStandards';
import { blockConfig } from './RungContainer';

const ALL_CLASSES = ['Local', 'Global', 'Input', 'Output', 'InOut', 'Temp'];

// IEC 61131-3 memory address formatting
const IEC_TYPE_PREFIX = {
  'BOOL': 'X', 'BYTE': 'B', 'SINT': 'B', 'USINT': 'B',
  'INT': 'W', 'UINT': 'W', 'WORD': 'W',
  'DINT': 'D', 'UDINT': 'D', 'DWORD': 'D', 'REAL': 'D', 'TIME': 'D',
  'LINT': 'L', 'ULINT': 'L', 'LWORD': 'L', 'LREAL': 'L',
};

// Convert a number input to IEC address based on variable type
// e.g. type=BOOL, num=1 → %MX0.1; type=INT, num=10 → %MW10
function formatIECAddress(input, varType) {
  const trimmed = (input || '').trim();
  if (!trimmed) return '';
  // If already IEC format, accept as-is
  if (trimmed.startsWith('%')) return trimmed.toUpperCase();
  // Try as number
  const num = parseInt(trimmed, 10);
  if (isNaN(num) || num < 0) return trimmed;
  const prefix = IEC_TYPE_PREFIX[(varType || '').toUpperCase()] || 'W';
  if (prefix === 'X') {
    // Bit addressing: byte.bit
    const byte_ = Math.floor(num / 8);
    const bit = num % 8;
    return `%MX${byte_}.${bit}`;
  }
  return `%M${prefix}${num}`;
}

const InsertZoneRow = ({ colSpan, onInsert }) => {
  const [hovered, setHovered] = useState(false);
  return (
    <tr
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onInsert}
      style={{ cursor: 'pointer', height: hovered ? 22 : 4, transition: 'height 0.1s ease' }}
    >
      <td colSpan={colSpan} style={{ padding: 0, position: 'relative' }}>
        {hovered && (
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 22 }}>
            <div style={{ position: 'absolute', left: 0, right: 0, height: 2, background: '#007acc', borderRadius: 1 }} />
            <div style={{ position: 'relative', zIndex: 1, width: 16, height: 16, background: '#007acc', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, fontWeight: 'bold', lineHeight: 1 }}>+</div>
          </div>
        )}
      </td>
    </tr>
  );
};

// Helper Component for "Save on Enter" logic
const EditableCell = ({ value, onCommit, placeholder = '' }) => {
  const [localValue, setLocalValue] = useState(value);
  const [isEditing, setIsEditing] = useState(false);

  React.useEffect(() => {
    if (!isEditing) setLocalValue(value);
  }, [value, isEditing]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      onCommit(localValue);
      setIsEditing(false);
      e.target.blur();
    } else if (e.key === 'Escape') {
      setLocalValue(value);
      setIsEditing(false);
      e.target.blur();
    }
  };

  return (
    <input
      type="text"
      value={localValue}
      onChange={(e) => { setLocalValue(e.target.value); setIsEditing(true); }}
      onKeyDown={handleKeyDown}
      onBlur={() => { if (isEditing) onCommit(localValue); setIsEditing(false); }}
      placeholder={placeholder}
      style={{
        background: 'transparent',
        border: isEditing ? '1px solid #007acc' : '1px solid transparent',
        color: '#9cdcfe',
        width: '100%',
        outline: 'none',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        padding: '2px 4px',
        borderRadius: '2px'
      }}
    />
  );
};

// ── Popup for Array/Struct live values ───────────────────────────────────────
const ComplexLivePopup = ({ variable, liveVariables, parentName, dataTypes, anchorRect, onClose }) => {
  const [selectedIdx, setSelectedIdx] = useState(0);

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dtDef = (dataTypes || []).find(dt => dt.name === variable.type);
  if (!dtDef) return null;

  const safeProgName = (parentName || '').trim().replace(/\s+/g, '_');
  const safeName = (variable.name || '').trim().replace(/\s+/g, '_');

  const getLive = (suffix) => {
    const pk = `prog_${safeProgName}_${safeName}${suffix}`;
    const gk = `prog__${safeName}${suffix}`;
    const v = liveVariables[pk] !== undefined ? liveVariables[pk]
            : liveVariables[gk] !== undefined ? liveVariables[gk] : null;
    if (v === null) return '---';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  };

  // Position: below anchor, clamped to viewport
  const top = Math.min((anchorRect?.bottom ?? 100) + 4, window.innerHeight - 200);
  const left = Math.min((anchorRect?.left ?? 100), window.innerWidth - 220);

  const cellStyle = { padding: '3px 8px', borderBottom: '1px solid #2a2a2a', display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11 };
  const labelStyle = { color: '#888' };
  const valStyle = { color: '#00e676', fontFamily: 'Consolas, monospace', fontWeight: 'bold' };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />
      <div style={{
        position: 'fixed', top, left, zIndex: 9999,
        background: '#1e1e1e', border: '1px solid #007acc',
        borderRadius: 4, minWidth: 200, maxWidth: 260,
        boxShadow: '0 4px 16px rgba(0,0,0,0.6)'
      }}>
        <div style={{ padding: '5px 8px', background: '#0d47a1', borderRadius: '3px 3px 0 0', fontSize: 11, fontWeight: 'bold', color: '#fff', display: 'flex', justifyContent: 'space-between' }}>
          <span>{variable.name} <span style={{ opacity: 0.7, fontWeight: 'normal' }}>({variable.type})</span></span>
          <span onClick={onClose} style={{ cursor: 'pointer', opacity: 0.7, lineHeight: 1 }}>✕</span>
        </div>

        {dtDef.type === 'Array' && (() => {
          const dim = dtDef.content.dimensions[0];
          const minIdx = parseInt(dim.min), maxIdx = parseInt(dim.max);
          const indices = Array.from({ length: maxIdx - minIdx + 1 }, (_, i) => minIdx + i);
          return (
            <div style={{ padding: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <select
                  value={selectedIdx}
                  onChange={e => setSelectedIdx(parseInt(e.target.value))}
                  style={{ flex: 1, background: '#2d2d2d', color: '#ccc', border: '1px solid #555', borderRadius: 3, padding: '3px 6px', fontSize: 11 }}
                >
                  {indices.map(i => <option key={i} value={i}>[{i}]</option>)}
                </select>
                <span style={valStyle}>{getLive(`[${selectedIdx}]`)}</span>
              </div>
            </div>
          );
        })()}

        {dtDef.type === 'Structure' && (
          <div style={{ padding: '4px 0' }}>
            {(dtDef.content.members || []).map(member => (
              <div key={member.name} style={cellStyle}>
                <span style={labelStyle}>{member.name} <span style={{ color: '#555' }}>({member.type})</span></span>
                <span style={valStyle}>{getLive(`.${member.name}`)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
};

const VariableManager = ({
  variables = [],
  onDelete,
  onUpdate,
  onAdd,
  allowedClasses = ALL_CLASSES,
  globalVars = [],
  derivedTypes = [],
  userDefinedTypes = [],
  liveVariables = null,
  parentName = "",
  disabled = false,
  isSimulationMode = false,
  onForceWrite = null,
  onAddToWatchTable = null,
  projectStructure = null
}) => {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState(null);
  const [forceModal, setForceModal] = useState(null); // { varName, varType, liveKey, liveVal }
  const [complexPopup, setComplexPopup] = useState(null); // { variable, anchorRect }
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, variable }
  const ctxMenuRef = useRef(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target)) setCtxMenu(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [ctxMenu]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleAddClick = (insertAfterIndex) => {
    const existingNames = [...variables, ...globalVars].map(v => v.name);

    let counter = 0;
    while (existingNames.includes(`Var${counter}`)) counter++;
    if (onAdd) onAdd({
      id: Date.now(),
      name: `Var${counter}`,
      class: allowedClasses[0] || 'Local',
      type: 'BOOL',
      initialValue: '',
      description: '',
      address: ''
    }, insertAfterIndex);
  };

  const handleRemoveClick = () => {
    if (selectedId && onDelete) { onDelete(selectedId); setSelectedId(null); }
  };

  const validateAndSaveName = (id, newName) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const currentVar = variables.find(v => v.id === id);
    if (!currentVar || currentVar.name === trimmed) return;
    // Block duplicate within same scope
    if (variables.some(v => v.id !== id && v.name === trimmed)) {
      alert(t('errors.varExistsScope', { name: trimmed }));
      return;
    }
    // Block same name AND same type as a global variable
    if (globalVars.some(v => v.name === trimmed && v.type === currentVar.type)) {
      alert(t('errors.varExistsScope', { name: trimmed }));
      return;
    }
    if (onUpdate) onUpdate(id, 'name', trimmed);
  };

  // ── Live value lookup ─────────────────────────────────────────────────────

  /** Computes the liveVariables key for a variable without requiring liveVariables to be set. */
  const computeLiveKey = (varName) => {
    const safeName = (varName || '').trim().replace(/\s+/g, '_');
    const safeProgName = (parentName || '').trim().replace(/\s+/g, '_');
    return `prog_${safeProgName}_${safeName}`;
  };

  /** Returns the correct liveVariables key for a variable name. */
  const getLiveKey = (varName) => {
    if (!liveVariables) return computeLiveKey(varName);
    const safeName = (varName || '').trim().replace(/\s+/g, '_');
    const safeProgName = (parentName || '').trim().replace(/\s+/g, '_');
    const progKey = `prog_${safeProgName}_${safeName}`;
    if (liveVariables[progKey] !== undefined) return progKey;
    const globalKey = `prog__${safeName}`;
    if (liveVariables[globalKey] !== undefined) return globalKey;
    return progKey; // default even if not found (shows ---)
  };

  const handleContextMenu = (e, v) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, variable: v });
    setSelectedId(v.id);
  };

  const getLiveValue = (varName) => {
    if (!liveVariables) return null;
    const key = getLiveKey(varName);
    return (key && liveVariables[key] !== undefined) ? liveVariables[key] : null;
  };

  /** For FB instance variables, collect output pin live values from shadow keys. */
  const getFBOutputValues = (varName, varType) => {
    if (!liveVariables) return null;
    const safeName = (varName || '').trim().replace(/\s+/g, '_');
    const safeProgName = (parentName || '').trim().replace(/\s+/g, '_');
    const prefix = `prog_${safeProgName}_out_${safeName}_`;
    const cfg = blockConfig[varType];
    const entries = [];
    for (const key in liveVariables) {
      if (key.startsWith(prefix)) {
        const pin = key.slice(prefix.length);
        const pinType = cfg?.outputs?.find(o => o.name === pin)?.type || null;
        entries.push({ pin, value: liveVariables[key], type: pinType });
      }
    }
    return entries.length > 0 ? entries : null;
  };

  const formatFBOutputs = (entries) => {
    return entries.map(e => {
      const v = e.value;
      let display;
      if (typeof v === 'boolean') display = v ? 'T' : 'F';
      else if (e.type === 'BOOL' && (v === 0 || v === 1)) display = v ? 'T' : 'F';
      else if (e.type === 'TIME') display = formatTimeUs(v);
      else display = String(v ?? '---');
      return `${e.pin}=${display}`;
    }).join(' ');
  };

  const formatLiveDisplay = (val, type) => {
    if (val === null || val === undefined) return '---';
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    if (typeof val === 'object') {
      if ('Q' in val && 'ET' in val) return `Q=${val.Q ? 'T' : 'F'} ET=${formatTimeUs(val.ET)}`;
      if ('Q' in val && 'CV' in val) return `Q=${val.Q ? 'T' : 'F'} CV=${val.CV}`;
      return JSON.stringify(val);
    }
    if (type === 'TIME') return formatTimeUs(val);
    return String(val);
  };

  const AXIS_REF_BUILTIN = {
    name: 'AXIS_REF', type: 'Structure',
    content: { members: [
      { name: 'AxisNo',         type: 'UINT' },
      { name: 'Simulation',     type: 'BOOL' },
      { name: 'ActualPosition', type: 'REAL' },
      { name: 'ActualVelocity', type: 'REAL' },
      { name: 'ActualTorque',   type: 'REAL' },
      { name: 'IsHomed',        type: 'BOOL' },
      { name: 'AxisWarning',    type: 'BOOL' },
      { name: 'AxisErrorID',    type: 'UINT' },
      { name: 'cmd_Seq',        type: 'UINT' },
      { name: 'sts_AckSeq',     type: 'UINT' },
      { name: 'sts_State',      type: 'UINT' },
      { name: 'sts_Busy',       type: 'BOOL' },
      { name: 'sts_Done',       type: 'BOOL' },
      { name: 'sts_Error',      type: 'BOOL' },
      { name: 'sts_ErrorID',    type: 'UINT' },
    ]}
  };
  const dataTypes = [...(projectStructure?.dataTypes || []), AXIS_REF_BUILTIN];
  const isComplexType = (typeName) => dataTypes.some(dt => dt.name === typeName && (dt.type === 'Array' || dt.type === 'Structure'));

  const showClass = allowedClasses.some(c => c === 'Input' || c === 'Output' || c === 'InOut');
  const colCount = 6 + (liveVariables ? 1 : 0) + (showClass ? 1 : 0);

  const CLASS_COLORS = {
    Input:  { bg: '#0e4f7a', border: '#1177bb', text: '#6dbfff' },
    Output: { bg: '#6b3a1f', border: '#b86030', text: '#ffb07a' },
    InOut:  { bg: '#4a2060', border: '#8e2fad', text: '#ce8ff0' },
    Local:  { bg: '#2a2a2a', border: '#555',    text: '#aaa'    },
    Temp:   { bg: '#2a2a2a', border: '#555',    text: '#aaa'    },
    Global: { bg: '#1a3a1a', border: '#3a7a3a', text: '#88cc88' },
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#252526', borderBottom: '2px solid #007acc' }}>

      {/* Table */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', color: '#ccc', fontSize: '11px', textAlign: 'left' }}>
          <thead style={{ background: '#1e1e1e', position: 'sticky', top: 0, zIndex: 10 }}>
            <tr>
              <th style={{ padding: '5px', borderBottom: '1px solid #444' }}>{t('tables.name')}</th>
              {showClass && <th style={{ padding: '5px', borderBottom: '1px solid #444', minWidth: '70px' }}>{t('tables.class') || 'Class'}</th>}
              <th style={{ padding: '5px', borderBottom: '1px solid #444', minWidth: '120px' }}>{t('tables.type')}</th>
              <th style={{ padding: '5px', borderBottom: '1px solid #444' }}>{t('tables.initialValue')}</th>
              {liveVariables && (
                <th style={{ padding: '5px', borderBottom: '1px solid #444', color: '#00e676' }}>
                  Live Value {onForceWrite && <span style={{ color: '#888', fontSize: 10, fontWeight: 'normal' }}>(click to set)</span>}
                </th>
              )}
              <th style={{ padding: '5px', borderBottom: '1px solid #444' }}>{t('tables.description')}</th>
              <th style={{ padding: '5px', borderBottom: '1px solid #444', minWidth: '80px' }} title="IEC address — expose via REST API">Address</th>
              <th style={{ padding: '5px', borderBottom: '1px solid #444', width: 28 }}></th>
            </tr>
          </thead>
          <tbody>
{variables.map((v, index) => {
              const liveVal = getLiveValue(v.name);
              const liveKey = getLiveKey(v.name);
              const hasValue = liveVal !== null && liveVal !== undefined;
              const canForce = !!onForceWrite && liveVariables;
              const isComplex = isComplexType(v.type);

              return (
                <React.Fragment key={v.id}>
                <tr
                  onClick={() => setSelectedId(v.id)}
                  onContextMenu={(e) => handleContextMenu(e, v)}
                  style={{ borderBottom: '1px solid #333', background: selectedId === v.id ? '#0d47a1' : 'transparent', cursor: 'pointer' }}
                >
                  <td style={{ padding: '5px' }}>
                    <EditableCell value={v.name} onCommit={(val) => !isSimulationMode && !disabled && validateAndSaveName(v.id, val)} />
                  </td>
                  {showClass && (() => {
                    const cls = v.class || allowedClasses[0] || 'Local';
                    const cc = CLASS_COLORS[cls] || CLASS_COLORS.Local;
                    return (
                      <td style={{ padding: '3px 5px' }}>
                        <select
                          value={cls}
                          disabled={disabled || isSimulationMode}
                          onChange={(e) => { if (!disabled && !isSimulationMode && onUpdate) onUpdate(v.id, 'class', e.target.value); }}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            background: cc.bg, color: cc.text, border: `1px solid ${cc.border}`,
                            borderRadius: 3, fontSize: 10, fontWeight: 'bold', padding: '1px 3px',
                            width: '100%', cursor: disabled || isSimulationMode ? 'default' : 'pointer',
                            outline: 'none'
                          }}
                        >
                          {allowedClasses.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                    );
                  })()}
                  <td style={{ padding: '5px' }}>
                    <DataTypeSelector
                      value={v.type}
                      onChange={(newType) => {
                        if (isSimulationMode || disabled) return;

                        // User request: if the selected type is the same type and same name as another variable, including global, don't allow the change.
                        const isDuplicate = variables.some(other => other.id !== v.id && other.name === v.name && other.type === newType) ||
                          globalVars.some(other => other.name === v.name && other.type === newType);

                        if (projectStructure) {
                          let isLocalDuplicate = false;
                          ['programs'].forEach(category => {
                            if (projectStructure[category]) {
                              projectStructure[category].forEach(item => {
                                if (item.content && item.content.variables) {
                                  if (item.content.variables.some(other => other.name === v.name && other.type === newType)) {
                                    isLocalDuplicate = true;
                                  }
                                }
                              });
                            }
                          });
                          if (isDuplicate || isLocalDuplicate) {
                            alert(t('errors.varExistsWithType', { name: v.name, type: newType }));
                            return;
                          }
                        } else if (isDuplicate) {
                          alert(t('errors.varExistsWithType', { name: v.name, type: newType }));
                          return;
                        }

                        if (onUpdate) onUpdate(v.id, 'type', newType);
                      }}
                      derivedTypes={derivedTypes}
                      userDefinedTypes={userDefinedTypes}
                    />
                  </td>
                  <td style={{ padding: '5px' }}>
                    <EditableCell value={v.initialValue} onCommit={(val) => !disabled && onUpdate && onUpdate(v.id, 'initialValue', val)} />
                  </td>
                  {liveVariables && (
                    <td
                      style={{ padding: '5px', cursor: (canForce || isComplex) ? 'pointer' : 'default' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isComplex) {
                          setComplexPopup({ variable: v, anchorRect: e.currentTarget.getBoundingClientRect() });
                        } else if (canForce) {
                          setForceModal({ varName: v.name, varType: v.type, liveKey, liveVal });
                        }
                      }}
                      title={isComplex ? 'Click to inspect elements' : canForce ? 'Click to force-write value' : ''}
                    >
                      <span style={{
                        color: isComplex ? '#90caf9' : (hasValue || getFBOutputValues(v.name, v.type) ? '#00e676' : '#555'),
                        fontWeight: 'bold',
                        fontFamily: 'Consolas, monospace',
                        padding: '1px 6px',
                        borderRadius: 3,
                        background: isComplex ? 'rgba(144,202,249,0.08)' : (canForce && hasValue ? 'rgba(0,230,118,0.08)' : 'transparent'),
                        border: isComplex ? '1px solid rgba(144,202,249,0.25)' : (canForce ? `1px solid ${hasValue ? 'rgba(0,230,118,0.25)' : '#333'}` : 'none'),
                        display: 'inline-block'
                      }}>
                        {isComplex ? (() => {
                          const dtDef = dataTypes.find(dt => dt.name === v.type);
                          return dtDef?.type === 'Array' ? '⊞ inspect' : '⊡ inspect';
                        })() : (() => {
                          const fbOuts = getFBOutputValues(v.name, v.type);
                          if (fbOuts) return formatFBOutputs(fbOuts);
                          return formatLiveDisplay(liveVal, v.type);
                        })()}
                      </span>
                    </td>
                  )}
                  <td style={{ padding: '5px' }}>
                    <EditableCell value={v.description} onCommit={(val) => !disabled && onUpdate && onUpdate(v.id, 'description', val)} />
                  </td>
                  <td style={{ padding: '3px' }}>
                    <EditableCell
                      value={v.address || ''}
                      onCommit={(val) => {
                        if (disabled || isSimulationMode) return;
                        const formatted = formatIECAddress(val, v.type);
                        if (onUpdate) onUpdate(v.id, 'address', formatted);
                      }}
                      placeholder="%MW0"
                    />
                  </td>
                  <td style={{ padding: '3px', textAlign: 'center' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (!disabled && !isSimulationMode && onDelete) { onDelete(v.id); setSelectedId(null); } }}
                      disabled={disabled || isSimulationMode}
                      title={t('common.delete')}
                      style={{ background: 'transparent', border: 'none', color: disabled || isSimulationMode ? '#444' : '#c62828', cursor: disabled || isSimulationMode ? 'default' : 'pointer', fontSize: 13, padding: '1px 3px', lineHeight: 1 }}
                    >🗑</button>
                  </td>
                </tr>
                {!disabled && !isSimulationMode && index < variables.length - 1 && (
                  <InsertZoneRow colSpan={colCount} onInsert={() => handleAddClick(index)} />
                )}
                </React.Fragment>
              );
            })}
            {!disabled && !isSimulationMode && (
              <tr>
                <td colSpan={colCount} style={{ padding: '2px 0' }}>
                  <div
                    onClick={() => handleAddClick(variables.length - 1)}
                    style={{ display: 'flex', justifyContent: 'center', padding: '4px 0', cursor: 'pointer', opacity: 0.45 }}
                    onMouseEnter={e => e.currentTarget.style.opacity = 1}
                    onMouseLeave={e => e.currentTarget.style.opacity = 0.45}
                  >
                    <div style={{ width: 18, height: 18, background: '#007acc', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, fontWeight: 'bold', lineHeight: 1 }}>+</div>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Force Write Modal */}
      {forceModal && (
        <ForceWriteModal
          isOpen={true}
          onClose={() => setForceModal(null)}
          varName={forceModal.varName}
          varType={forceModal.varType}
          currentValue={forceModal.liveVal}
          liveKey={forceModal.liveKey}
          onConfirm={(key, val) => { onForceWrite && onForceWrite(key, val); }}
        />
      )}

      {/* Complex Type Live Popup (Array / Struct) */}
      {complexPopup && liveVariables && (
        <ComplexLivePopup
          variable={complexPopup.variable}
          liveVariables={liveVariables}
          parentName={parentName}
          dataTypes={dataTypes}
          anchorRect={complexPopup.anchorRect}
          onClose={() => setComplexPopup(null)}
        />
      )}

      {/* Right-click Context Menu */}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          style={{
            position: 'fixed',
            top: ctxMenu.y,
            left: ctxMenu.x,
            background: '#2d2d2d',
            border: '1px solid #444',
            borderRadius: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            zIndex: 9999,
            minWidth: 170,
            fontSize: 12,
            color: '#ccc',
            overflow: 'hidden',
          }}
        >
          {onAddToWatchTable && (
            <div
              onClick={() => {
                onAddToWatchTable({
                  id: `${Date.now()}_${Math.random()}`,
                  liveKey: computeLiveKey(ctxMenu.variable.name),
                  displayName: parentName ? `${parentName}.${ctxMenu.variable.name}` : ctxMenu.variable.name,
                  varType: ctxMenu.variable.type,
                });
                setCtxMenu(null);
              }}
              style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
              onMouseEnter={e => e.currentTarget.style.background = '#3a3a3a'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ fontSize: 13 }}>👁</span> Add to Watchtable
            </div>
          )}
          {onForceWrite && liveVariables && (
            <div
              onClick={() => {
                const liveKey = getLiveKey(ctxMenu.variable.name);
                const liveVal = liveVariables[liveKey] ?? null;
                setForceModal({ varName: ctxMenu.variable.name, varType: ctxMenu.variable.type, liveKey, liveVal });
                setCtxMenu(null);
              }}
              style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
              onMouseEnter={e => e.currentTarget.style.background = '#3a3a3a'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ fontSize: 13 }}>✎</span> Write Value...
            </div>
          )}
          <div style={{ height: 1, background: '#444', margin: '2px 0' }} />
          <div
            onClick={() => { navigator.clipboard?.writeText(ctxMenu.variable.name); setCtxMenu(null); }}
            style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
            onMouseEnter={e => e.currentTarget.style.background = '#3a3a3a'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <span style={{ fontSize: 13 }}>📋</span> Copy Name
          </div>
        </div>
      )}
    </div>
  );
};

export default VariableManager;
