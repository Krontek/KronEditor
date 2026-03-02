import React, { useState } from 'react';
import { DataTypeSelector, ModernSelect } from './common/Selectors';
import ForceWriteModal from './common/ForceWriteModal';
import { useTranslation } from 'react-i18next';

const ALL_CLASSES = ['Local', 'Global', 'Input', 'Output', 'InOut', 'Temp'];

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
  onForceWrite = null
}) => {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState(null);
  const [forceModal, setForceModal] = useState(null); // { varName, varType, liveKey, liveVal }

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleAddClick = () => {
    const existingNames = [...variables, ...globalVars].map(v => v.name);
    let counter = 0;
    while (existingNames.includes(`Var${counter}`)) counter++;
    if (onAdd) onAdd({
      id: Date.now(),
      name: `Var${counter}`,
      class: allowedClasses[0] || 'Local',
      type: 'BOOL',
      initialValue: '',
      description: ''
    });
  };

  const handleRemoveClick = () => {
    if (selectedId && onDelete) { onDelete(selectedId); setSelectedId(null); }
  };

  const validateAndSaveName = (id, newName) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const currentVar = variables.find(v => v.id === id);
    if (!currentVar || currentVar.name === trimmed) return;
    if (variables.some(v => v.id !== id && v.name === trimmed) || globalVars.some(v => v.name === trimmed)) {
      alert(`Variable name '${trimmed}' already exists in this scope!`);
      return;
    }
    if (onUpdate) onUpdate(id, 'name', trimmed);
  };

  // ── Live value lookup ─────────────────────────────────────────────────────

  /** Returns the correct liveVariables key for a variable name. */
  const getLiveKey = (varName) => {
    if (!liveVariables) return null;
    const safeName    = (varName    || '').trim().replace(/\s+/g, '_');
    const safeProgName = (parentName || '').trim().replace(/\s+/g, '_');
    const progKey    = `prog_${safeProgName}_${safeName}`;
    if (liveVariables[progKey] !== undefined) return progKey;
    const globalKey  = `prog__${safeName}`;
    if (liveVariables[globalKey] !== undefined) return globalKey;
    return progKey; // default even if not found (shows ---)
  };

  const getLiveValue = (varName) => {
    if (!liveVariables) return null;
    const key = getLiveKey(varName);
    return (key && liveVariables[key] !== undefined) ? liveVariables[key] : null;
  };

  const formatLiveDisplay = (val) => {
    if (val === null || val === undefined) return '---';
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    if (typeof val === 'object') {
      if ('Q' in val && 'ET' in val) return `Q=${val.Q ? 'T' : 'F'} ET=${val.ET}ms`;
      if ('Q' in val && 'CV' in val) return `Q=${val.Q ? 'T' : 'F'} CV=${val.CV}`;
      return JSON.stringify(val);
    }
    return String(val);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#252526', borderBottom: '2px solid #007acc' }}>

      {/* Header */}
      <div style={{ padding: '5px 10px', background: '#333', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #444' }}>
        <span style={{ fontWeight: 'bold', color: '#fff', fontSize: '13px' }}>Variable Table</span>
        <div style={{ display: 'flex', gap: '5px' }}>
          <button
            onClick={handleAddClick}
            disabled={disabled || isSimulationMode}
            style={{ background: '#388E3C', border: 'none', color: 'white', padding: '2px 8px', fontSize: '11px', cursor: (disabled || isSimulationMode) ? 'not-allowed' : 'pointer', borderRadius: '3px', opacity: (disabled || isSimulationMode) ? 0.5 : 1 }}
          >+ {t('common.add')}</button>
          <button
            onClick={handleRemoveClick}
            disabled={!selectedId || disabled || isSimulationMode}
            style={{ background: (!selectedId || disabled || isSimulationMode) ? '#555' : '#D32F2F', border: 'none', color: (!selectedId || disabled || isSimulationMode) ? '#aaa' : 'white', padding: '2px 8px', fontSize: '11px', cursor: (!selectedId || disabled || isSimulationMode) ? 'default' : 'pointer', borderRadius: '3px' }}
          >- {t('common.delete')}</button>
        </div>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', color: '#ccc', fontSize: '11px', textAlign: 'left' }}>
          <thead style={{ background: '#1e1e1e', position: 'sticky', top: 0, zIndex: 10 }}>
            <tr>
              <th style={{ padding: '5px', borderBottom: '1px solid #444' }}>{t('tables.name')}</th>
              <th style={{ padding: '5px', borderBottom: '1px solid #444', minWidth: '80px' }}>{t('tables.class')}</th>
              <th style={{ padding: '5px', borderBottom: '1px solid #444', minWidth: '120px' }}>{t('tables.type')}</th>
              <th style={{ padding: '5px', borderBottom: '1px solid #444' }}>{t('tables.initialValue')}</th>
              {liveVariables && (
                <th style={{ padding: '5px', borderBottom: '1px solid #444', color: '#00e676' }}>
                  Live Value {onForceWrite && <span style={{ color: '#888', fontSize: 10, fontWeight: 'normal' }}>(click to set)</span>}
                </th>
              )}
              <th style={{ padding: '5px', borderBottom: '1px solid #444' }}>{t('tables.description')}</th>
            </tr>
          </thead>
          <tbody>
            {variables.map((v) => {
              const liveVal = getLiveValue(v.name);
              const liveKey = getLiveKey(v.name);
              const hasValue = liveVal !== null && liveVal !== undefined;
              const canForce = !!onForceWrite && liveVariables;

              return (
                <tr
                  key={v.id}
                  onClick={() => setSelectedId(v.id)}
                  style={{ borderBottom: '1px solid #333', background: selectedId === v.id ? '#0d47a1' : 'transparent', cursor: 'pointer' }}
                >
                  <td style={{ padding: '5px' }}>
                    <EditableCell value={v.name} onCommit={(val) => !isSimulationMode && !disabled && validateAndSaveName(v.id, val)} />
                  </td>
                  <td style={{ padding: '5px' }}>
                    <ModernSelect
                      value={v.class}
                      options={allowedClasses}
                      onChange={(val) => !isSimulationMode && !disabled && onUpdate && onUpdate(v.id, 'class', val)}
                    />
                  </td>
                  <td style={{ padding: '5px' }}>
                    <DataTypeSelector
                      value={v.type}
                      onChange={(newType) => !isSimulationMode && !disabled && onUpdate && onUpdate(v.id, 'type', newType)}
                      derivedTypes={derivedTypes}
                      userDefinedTypes={userDefinedTypes}
                    />
                  </td>
                  <td style={{ padding: '5px' }}>
                    <EditableCell value={v.initialValue} onCommit={(val) => !disabled && onUpdate && onUpdate(v.id, 'initialValue', val)} />
                  </td>
                  {liveVariables && (
                    <td
                      style={{ padding: '5px', cursor: canForce ? 'pointer' : 'default' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (canForce) setForceModal({ varName: v.name, varType: v.type, liveKey, liveVal });
                      }}
                      title={canForce ? 'Click to force-write value' : ''}
                    >
                      <span style={{
                        color: hasValue ? '#00e676' : '#555',
                        fontWeight: 'bold',
                        fontFamily: 'Consolas, monospace',
                        padding: '1px 6px',
                        borderRadius: 3,
                        background: canForce && hasValue ? 'rgba(0,230,118,0.08)' : 'transparent',
                        border: canForce ? `1px solid ${hasValue ? 'rgba(0,230,118,0.25)' : '#333'}` : 'none',
                        display: 'inline-block'
                      }}>
                        {formatLiveDisplay(liveVal)}
                      </span>
                    </td>
                  )}
                  <td style={{ padding: '5px' }}>
                    <EditableCell value={v.description} onCommit={(val) => !disabled && onUpdate && onUpdate(v.id, 'description', val)} />
                  </td>
                </tr>
              );
            })}
            {variables.length === 0 && (
              <tr>
                <td colSpan={liveVariables ? 6 : 5} style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                  {t('messages.empty')}
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
    </div>
  );
};

export default VariableManager;
