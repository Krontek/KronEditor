import React, { useState, useEffect, useRef } from 'react';
import { DataTypeSelector, ModernSelect } from './common/Selectors';
import ForceWriteModal from './common/ForceWriteModal';
import { useTranslation } from 'react-i18next';
import { formatTimeUs, isTimeType, normalizeTimeLiteral } from '../utils/plcStandards';
import { blockConfig } from './RungContainer';
import { writeClipboard, readClipboard, useKronClipboard, CLIP_KIND } from '../utils/kronClipboard';
import { setEditorScope, getEditorScope, EDITOR_SCOPE } from '../utils/editorScope';
import { isReservedTranspilerName, isValidIecIdentifier } from '../utils/reservedNames';

const ALL_CLASSES = ['Local', 'Global', 'Input', 'Output', 'InOut', 'Temp'];

// Excel-like compact grid cell styles (shared header + body)
const hCell = {
  padding: '3px 8px',
  borderBottom: '1px solid #3a3a3a',
  borderRight: '1px solid #333',
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.4px',
  color: '#9a9a9a',
  whiteSpace: 'nowrap',
};
// Body cell: vertical padding is 0 so the row height is driven by the input
// (height 22) — gives a tight, uniform Excel-style row. Vertical grid lines via
// borderRight; horizontal via the row's borderBottom.
const bCell = { padding: '0 2px', borderRight: '1px solid #2c2c2c' };

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
      style={{ cursor: 'pointer', height: hovered ? 18 : 1, transition: 'height 0.1s ease' }}
    >
      <td colSpan={colSpan} style={{ padding: 0, position: 'relative' }}>
        {hovered && (
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 18 }}>
            <div style={{ position: 'absolute', left: 0, right: 0, height: 2, background: '#007acc', borderRadius: 1 }} />
            <div style={{ position: 'relative', zIndex: 1, width: 14, height: 14, background: '#007acc', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 'bold', lineHeight: 1 }}>+</div>
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
        padding: '1px 6px',
        borderRadius: '2px',
        boxSizing: 'border-box',
        height: 22
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
  // Multi-select: set of selected variable ids. anchorId is the last clicked
  // row used as the pivot for Shift-range selection.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [anchorId, setAnchorId] = useState(null);
  const [forceModal, setForceModal] = useState(null); // { varName, varType, liveKey, liveVal }
  const [complexPopup, setComplexPopup] = useState(null); // { variable, anchorRect }
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, variable }
  const ctxMenuRef = useRef(null);
  const [addrWarning, setAddrWarning] = useState(null); // { msg, x, y }
  const addrWarnTimer = useRef(null);

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
    if (!onDelete || selectedIds.size === 0) return;
    // Delete in reverse order so earlier indices stay valid for the parent.
    const toDelete = variables.filter(v => selectedIds.has(v.id)).map(v => v.id);
    toDelete.forEach(id => onDelete(id));
    setSelectedIds(new Set());
    setAnchorId(null);
  };

  // ── Row selection (single / Ctrl-toggle / Shift-range) ────────────────────
  const handleRowSelect = (id, e) => {
    if (e.shiftKey && anchorId) {
      const fromIdx = variables.findIndex(v => v.id === anchorId);
      const toIdx   = variables.findIndex(v => v.id === id);
      if (fromIdx >= 0 && toIdx >= 0) {
        const [a, b] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
        const next = new Set(selectedIds);
        for (let k = a; k <= b; k++) next.add(variables[k].id);
        setSelectedIds(next);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id); else next.add(id);
      setSelectedIds(next);
      setAnchorId(id);
      return;
    }
    setSelectedIds(new Set([id]));
    setAnchorId(id);
  };

  // ── Cross-instance variable clipboard ─────────────────────────────────────
  const clipboardEntry = useKronClipboard();
  const canPasteVariable = clipboardEntry?.kind === CLIP_KIND.VARIABLE;

  // Payload is always an array of variables; legacy single-object payloads
  // are normalized to a one-element array on read.
  const copyVariables = (vars) => {
    if (!vars || vars.length === 0) return;
    const list = vars.map(v => JSON.parse(JSON.stringify(v)));
    writeClipboard(CLIP_KIND.VARIABLE, list);
  };

  const uniqueVarName = (base, taken) => {
    const root = String(base || 'Var0').replace(/_copy\d*$/, '');
    if (!taken.has(base)) return base;
    let n = 1;
    while (taken.has(`${root}_copy${n}`)) n++;
    return `${root}_copy${n}`;
  };

  const pasteVariableAt = async (insertAfterIndex) => {
    if (disabled || isSimulationMode) return;
    const clip = await readClipboard();
    if (!clip) return;
    if (clip.kind === CLIP_KIND.POU) {
        alert('Cannot paste here. The clipboard contains a data type or POU — paste it in the project sidebar.');
        return;
    }
    if (clip.kind !== CLIP_KIND.VARIABLE || !onAdd) return;
    // Accept both array (multi) and legacy single-object payloads
    const list = Array.isArray(clip.payload) ? clip.payload : [clip.payload];
    if (list.length === 0) return;
    // Track names taken so far; updates as we add each pasted variable.
    const taken = new Set([...variables, ...globalVars].map(v => v.name));
    list.forEach((src, i) => {
      const cls = allowedClasses.includes(src.class) ? src.class : (allowedClasses[0] || 'Local');
      const name = uniqueVarName(src.name || 'Var0', taken);
      taken.add(name);
      onAdd({
        id: `${Date.now()}_${Math.random()}_${i}`,
        name,
        class: cls,
        type: src.type || 'BOOL',
        initialValue: src.initialValue || '',
        description: src.description || '',
        // Address is hardware-unique — dropped on paste to avoid duplicates.
        address: '',
      }, insertAfterIndex + i);
    });
  };

  // Ctrl+C / Ctrl+V — scoped to the variable table so it does not race
  // with sidebar or LD editor handlers on the shared OS clipboard.
  useEffect(() => {
    const handler = async (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const ae = document.activeElement;
      if (ae && (
        (ae.tagName === 'INPUT' && ae.type === 'text') ||
        ae.tagName === 'TEXTAREA' ||
        ae.closest?.('.monaco-editor')
      )) return;
      const scope = getEditorScope();
      if (scope !== EDITOR_SCOPE.VARIABLES) return;
      const key = e.key.toLowerCase();
      if (key === 'c') {
        // Preserve table order for the copied set.
        const list = variables.filter(v => selectedIds.has(v.id));
        if (list.length > 0) { e.preventDefault(); copyVariables(list); }
      } else if (key === 'v') {
        e.preventDefault();
        await pasteVariableAt(variables.length - 1);
      } else if (key === 'a') {
        // Select all variables in the current scope.
        e.preventDefault();
        setSelectedIds(new Set(variables.map(v => v.id)));
        setAnchorId(variables[variables.length - 1]?.id || null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedIds, variables, globalVars, allowedClasses, disabled, isSimulationMode, onAdd]);

  const validateAndSaveName = (id, newName) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const currentVar = variables.find(v => v.id === id);
    if (!currentVar || currentVar.name === trimmed) return;
    // Must be a valid IEC identifier — no spaces (incl. internal), no
    // punctuation, no leading digit — else the generated C symbol is broken.
    if (!isValidIecIdentifier(trimmed)) {
      alert(t('errors.invalidVarName', { name: trimmed }));
      return;
    }
    // Block names the transpiler/runtime reserve at C file scope (e.g. "S" is
    // the internal PlcState pointer) — using one produces broken generated C
    // that only fails at compile time (see reservedNames.js for the full list
    // and why).
    if (isReservedTranspilerName(trimmed)) {
      alert(`"${trimmed}" is reserved by the transpiler/runtime and can't be used as a variable name.`);
      return;
    }
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
    // If the right-clicked row is not already part of the selection,
    // make it the only selected row. Otherwise preserve the multi-selection
    // so context-menu actions operate on the whole set.
    if (!selectedIds.has(v.id)) {
      setSelectedIds(new Set([v.id]));
      setAnchorId(v.id);
    }
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
    <div
      onMouseDown={() => setEditorScope(EDITOR_SCOPE.VARIABLES)}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#252526', borderBottom: '2px solid #007acc' }}
    >

      {/* Table */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', color: '#ccc', fontSize: '12px', textAlign: 'left', tableLayout: 'auto' }}>
          <thead style={{ background: '#1e1e1e', position: 'sticky', top: 0, zIndex: 10 }}>
            <tr>
              <th style={hCell}>{t('tables.name')}</th>
              {showClass && <th style={{ ...hCell, minWidth: '70px' }}>{t('tables.class') || 'Class'}</th>}
              <th style={{ ...hCell, minWidth: '120px' }}>{t('tables.type')}</th>
              <th style={hCell}>{t('tables.initialValue')}</th>
              {liveVariables && (
                <th style={{ ...hCell, color: '#00e676' }}>
                  Live {onForceWrite && <span style={{ color: '#888', fontSize: 9, fontWeight: 'normal' }}>(set)</span>}
                </th>
              )}
              <th style={{ ...hCell, minWidth: '80px' }} title="IEC address — expose via REST API">Address</th>
              <th style={hCell}>{t('tables.description')}</th>
              <th style={{ ...hCell, width: 24, borderRight: 'none' }}></th>
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
                  onClick={(e) => handleRowSelect(v.id, e)}
                  onContextMenu={(e) => handleContextMenu(e, v)}
                  style={{ borderBottom: '1px solid #303030', background: selectedIds.has(v.id) ? '#0d47a1' : (index % 2 ? '#2a2a2b' : 'transparent'), cursor: 'pointer' }}
                >
                  <td style={bCell}>
                    <EditableCell value={v.name} onCommit={(val) => !isSimulationMode && !disabled && validateAndSaveName(v.id, val)} />
                  </td>
                  {showClass && (() => {
                    const cls = v.class || allowedClasses[0] || 'Local';
                    const cc = CLASS_COLORS[cls] || CLASS_COLORS.Local;
                    return (
                      <td style={bCell}>
                        <select
                          value={cls}
                          disabled={disabled || isSimulationMode}
                          onChange={(e) => { if (!disabled && !isSimulationMode && onUpdate) onUpdate(v.id, 'class', e.target.value); }}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            background: cc.bg, color: cc.text, border: `1px solid ${cc.border}`,
                            borderRadius: 2, fontSize: 10, fontWeight: 'bold', padding: '0 2px',
                            width: '100%', height: 20, cursor: disabled || isSimulationMode ? 'default' : 'pointer',
                            outline: 'none', boxSizing: 'border-box'
                          }}
                        >
                          {allowedClasses.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                    );
                  })()}
                  <td style={bCell}>
                    <DataTypeSelector
                      compact
                      value={v.type}
                      onChange={(newType) => {
                        if (isSimulationMode || disabled) return;

                        // Block only same-SCOPE collisions: another var in THIS
                        // POU with the same name+type, or a global of the same
                        // name+type. Local variables in DIFFERENT programs are
                        // independently scoped and MAY share a name+type — do not
                        // check across programs (that wrongly rejected e.g. a
                        // second program declaring its own `var1 : INT`).
                        const isDuplicate = variables.some(other => other.id !== v.id && other.name === v.name && other.type === newType) ||
                          globalVars.some(other => other.name === v.name && other.type === newType);
                        if (isDuplicate) {
                          alert(t('errors.varExistsWithType', { name: v.name, type: newType }));
                          return;
                        }

                        if (onUpdate) onUpdate(v.id, 'type', newType);
                      }}
                      derivedTypes={derivedTypes}
                      userDefinedTypes={userDefinedTypes}
                    />
                  </td>
                  <td style={bCell}>
                    <EditableCell value={v.initialValue} onCommit={(val) => !disabled && onUpdate && onUpdate(v.id, 'initialValue', isTimeType(v.type) ? normalizeTimeLiteral(val) : val)} />
                  </td>
                  {liveVariables && (
                    <td
                      style={{ ...bCell, cursor: (canForce || isComplex) ? 'pointer' : 'default' }}
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
                  <td style={bCell}>
                    <EditableCell
                      value={v.address || ''}
                      onCommit={(val, e) => {
                        if (disabled || isSimulationMode) return;
                        const formatted = formatIECAddress(val, v.type);
                        if (formatted) {
                          const allVars = [...variables, ...globalVars];
                          const dup = allVars.find(other => other.id !== v.id && other.address && other.address === formatted);
                          if (dup) {
                            if (addrWarnTimer.current) clearTimeout(addrWarnTimer.current);
                            setAddrWarning(`"${formatted}" is already used by "${dup.name}"`);
                            addrWarnTimer.current = setTimeout(() => setAddrWarning(null), 2000);
                            return;
                          }
                        }
                        if (onUpdate) onUpdate(v.id, 'address', formatted);
                      }}
                      placeholder=""
                    />
                  </td>
                  <td style={bCell}>
                    <EditableCell value={v.description} onCommit={(val) => !disabled && onUpdate && onUpdate(v.id, 'description', val)} />
                  </td>
                  <td style={{ ...bCell, textAlign: 'center', borderRight: 'none' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (!disabled && !isSimulationMode && onDelete) { onDelete(v.id); setSelectedIds(prev => { const n = new Set(prev); n.delete(v.id); return n; }); } }}
                      disabled={disabled || isSimulationMode}
                      title={t('common.delete')}
                      style={{ background: 'transparent', border: 'none', color: disabled || isSimulationMode ? '#444' : '#c62828', cursor: disabled || isSimulationMode ? 'default' : 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}
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
          allowPulse={isSimulationMode}
          onConfirm={(key, val, mode) => { onForceWrite && onForceWrite(key, val, mode); }}
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
            onClick={() => {
              // If the right-clicked row is part of a multi-selection, copy
              // all selected variables (in table order). Otherwise just this one.
              const list = selectedIds.has(ctxMenu.variable.id)
                ? variables.filter(v => selectedIds.has(v.id))
                : [ctxMenu.variable];
              copyVariables(list);
              setCtxMenu(null);
            }}
            style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
            onMouseEnter={e => e.currentTarget.style.background = '#3a3a3a'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <span style={{ fontSize: 13 }}>📋</span>
            {selectedIds.size > 1 && selectedIds.has(ctxMenu.variable.id)
              ? `Copy ${selectedIds.size} Variables`
              : 'Copy Variable'}
          </div>
          {canPasteVariable && !disabled && !isSimulationMode && (
            <div
              onClick={() => { pasteVariableAt(variables.findIndex(v => v.id === ctxMenu.variable.id)); setCtxMenu(null); }}
              style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
              onMouseEnter={e => e.currentTarget.style.background = '#3a3a3a'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ fontSize: 13 }}>📄</span>
              {Array.isArray(clipboardEntry?.payload) && clipboardEntry.payload.length > 1
                ? `Paste ${clipboardEntry.payload.length} Variables`
                : 'Paste Variable'}
            </div>
          )}
          <div
            onClick={() => { navigator.clipboard?.writeText(ctxMenu.variable.name); setCtxMenu(null); }}
            style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
            onMouseEnter={e => e.currentTarget.style.background = '#3a3a3a'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <span style={{ fontSize: 13 }}>✍</span> Copy Name
          </div>
        </div>
      )}

      {/* Duplicate address warning popup */}
      {addrWarning && (
        <div style={{
          position: 'fixed',
          bottom: 32,
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#b71c1c',
          color: '#fff',
          padding: '7px 18px',
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 'bold',
          boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
          zIndex: 99999,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}>
          {addrWarning}
        </div>
      )}
    </div>
  );
};

export default VariableManager;
