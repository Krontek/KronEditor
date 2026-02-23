import React, { useState } from 'react';
import { DataTypeSelector, ModernSelect } from './common/Selectors';
import { useTranslation } from 'react-i18next';

const ALL_CLASSES = ['Local', 'Global', 'Input', 'Output', 'InOut', 'Temp'];

// Helper Component for "Save on Enter" logic
const EditableCell = ({ value, onCommit, placeholder = '' }) => {
  const [localValue, setLocalValue] = useState(value);
  const [isEditing, setIsEditing] = useState(false);

  // Sync local state when prop changes (if not editing to avoid overwriting typing)
  React.useEffect(() => {
    if (!isEditing) {
      setLocalValue(value);
    }
  }, [value, isEditing]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      onCommit(localValue);
      setIsEditing(false);
      e.target.blur(); // Remove focus
    } else if (e.key === 'Escape') {
      setLocalValue(value); // Revert
      setIsEditing(false);
      e.target.blur();
    }
  };

  const handleBlur = () => {
    // If Enter wasn't pressed, we revert to original value
    setLocalValue(value);
    setIsEditing(false);
  };

  const handleChange = (e) => {
    setLocalValue(e.target.value);
    setIsEditing(true);
  };

  return (
    <input
      type="text"
      value={localValue}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
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

const VariableManager = ({ variables = [], onDelete, onUpdate, onAdd, allowedClasses = ALL_CLASSES, globalVars = [], derivedTypes = [], userDefinedTypes = [] }) => {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState(null);

  // ... (handlers same as before)
  const handleAddClick = () => {
    const existingNames = [...variables, ...globalVars].map(v => v.name);
    let counter = 0;
    while (existingNames.includes(`Var${counter}`)) {
      counter++;
    }
    const newName = `Var${counter}`;

    const newVar = {
      id: Date.now(),
      name: newName,
      class: allowedClasses[0] || 'Local',
      type: 'BOOL',
      location: '',
      initialValue: '',
      description: ''
    };
    if (onAdd) onAdd(newVar);
  };

  const handleRemoveClick = () => {
    if (selectedId && onDelete) {
      onDelete(selectedId);
      setSelectedId(null);
    }
  };

  const validateAndSaveName = (id, newName) => {
    const trimmed = newName.trim();
    if (!trimmed) {
      // Revert if empty
      return;
    }

    const currentVar = variables.find(v => v.id === id);
    if (!currentVar) return; // Should not happen
    if (currentVar.name === trimmed) return; // No change

    // Check Local (exclude self)
    const existsLocal = variables.some(v => v.id !== id && v.name === trimmed);
    // Check Global
    const existsGlobal = globalVars.some(v => v.name === trimmed);

    if (existsLocal || existsGlobal) {
      // Alert user
      alert(`Variable name '${trimmed}' already exists in this scope!`);
      // function ends, onUpdate is NOT called.
      // EditableCell will exit edit mode, triggering useEffect to reset localValue to original 'value' prop.
      return;
    }

    if (onUpdate) onUpdate(id, 'name', trimmed);
  };

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#252526',
      borderBottom: '2px solid #007acc'
    }}>
      {/* ... (Header same as before) */}
      <div style={{
        padding: '5px 10px',
        background: '#333',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: '1px solid #444'
      }}>
        <span style={{ fontWeight: 'bold', color: '#fff', fontSize: '13px' }}>Variable Table</span>
        <div style={{ display: 'flex', gap: '5px' }}>
          <button
            onClick={handleAddClick}
            style={{ background: '#388E3C', border: 'none', color: 'white', padding: '2px 8px', fontSize: '11px', cursor: 'pointer', borderRadius: '3px' }}
          >
            + {t('common.add')}
          </button>
          <button
            onClick={handleRemoveClick}
            disabled={!selectedId}
            style={{ background: !selectedId ? '#555' : '#D32F2F', border: 'none', color: !selectedId ? '#aaa' : 'white', padding: '2px 8px', fontSize: '11px', cursor: !selectedId ? 'default' : 'pointer', borderRadius: '3px' }}
          >
            - {t('common.delete')}
          </button>
        </div>
      </div>

      {/* TABLO */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', color: '#ccc', fontSize: '11px', textAlign: 'left' }}>
          <thead style={{ background: '#1e1e1e', position: 'sticky', top: 0, zIndex: 10 }}>
            <tr>
              <th style={{ padding: '5px', borderBottom: '1px solid #444' }}>{t('tables.name')}</th>
              <th style={{ padding: '5px', borderBottom: '1px solid #444', minWidth: '80px' }}>{t('tables.class')}</th>
              <th style={{ padding: '5px', borderBottom: '1px solid #444', minWidth: '120px' }}>{t('tables.type')}</th>
              <th style={{ padding: '5px', borderBottom: '1px solid #444' }}>{t('tables.location')}</th>
              <th style={{ padding: '5px', borderBottom: '1px solid #444' }}>{t('tables.initialValue')}</th>
              <th style={{ padding: '5px', borderBottom: '1px solid #444' }}>{t('tables.description')}</th>
            </tr>
          </thead>
          <tbody>
            {variables.map((v) => (
              <tr
                key={v.id}
                onClick={() => setSelectedId(v.id)}
                style={{
                  borderBottom: '1px solid #333',
                  background: selectedId === v.id ? '#0d47a1' : 'transparent',
                  cursor: 'pointer'
                }}
              >
                <td style={{ padding: '5px' }}>
                  <EditableCell
                    value={v.name}
                    onCommit={(val) => validateAndSaveName(v.id, val)}
                  />
                </td>
                <td style={{ padding: '5px' }}>
                  <ModernSelect
                    value={v.class}
                    options={allowedClasses}
                    onChange={(val) => onUpdate && onUpdate(v.id, 'class', val)}
                  />
                </td>
                <td style={{ padding: '5px' }}>
                  <DataTypeSelector
                    value={v.type}
                    onChange={(newType) => onUpdate && onUpdate(v.id, 'type', newType)}
                    derivedTypes={derivedTypes}
                    userDefinedTypes={userDefinedTypes}
                  />
                </td>
                <td style={{ padding: '5px' }}>
                  <EditableCell
                    value={v.location}
                    onCommit={(val) => onUpdate && onUpdate(v.id, 'location', val)}
                  />
                </td>
                <td style={{ padding: '5px' }}>
                  <EditableCell
                    value={v.initialValue}
                    onCommit={(val) => onUpdate && onUpdate(v.id, 'initialValue', val)}
                  />
                </td>
                <td style={{ padding: '5px' }}>
                  <EditableCell
                    value={v.description}
                    onCommit={(val) => onUpdate && onUpdate(v.id, 'description', val)}
                  />
                </td>
              </tr>
            ))}
            {variables.length === 0 && (
              <tr>
                <td colSpan="6" style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                  {t('messages.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default VariableManager;