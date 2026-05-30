import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

const DataTypeCreationModal = ({ isOpen, onClose, onSave, existingNames }) => {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const [type, setType] = useState('Array'); // Default selection
    const [error, setError] = useState('');

    // Generate valid default name based on type
    const generateName = React.useCallback((selectedType) => {
        let prefix = selectedType === 'Array' ? 'array' : (selectedType === 'Enumerated' ? 'enum' : 'struct');
        let index = 0;
        let candidate = `${prefix}${index}`;
        while (existingNames.includes(candidate)) {
            index++;
            candidate = `${prefix}${index}`;
        }
        return candidate;
    }, [existingNames]);

    useEffect(() => {
        if (isOpen) {
            const defaultType = 'Array';
            setType(defaultType);
            setName(generateName(defaultType));
            setError('');
        }
    }, [isOpen, generateName]);

    const handleTypeChange = (e) => {
        const newType = e.target.value;
        setType(newType);

        // Update name if it matches a default pattern or is empty
        const isDefaultName = /^(array|enum|struct|DataType)\d*$/i.test(name) || name === '';
        if (isDefaultName) {
            setName(generateName(newType));
        }
    };

    if (!isOpen) return null;

    const handleSave = () => {
        const trimmed = name.trim();
        if (!trimmed) {
            setError(t('errors.nameRequired') || "Name is required");
            return;
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
            setError("Invalid name — use only letters, digits and underscore, no spaces, and don't start with a digit.");
            return;
        }
        if (existingNames.includes(trimmed)) {
            setError(t('errors.nameExists') || "Name already exists");
            return;
        }
        onSave(trimmed, type);
    };

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 2000,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
            <div style={{
                background: '#252526', padding: '20px', borderRadius: '8px',
                width: '350px', border: '1px solid #444', color: '#fff'
            }}>
                <h3 style={{ marginTop: 0, marginBottom: '20px' }}>{t('modals.createDataType') || "Create Data Type"}</h3>

                {/* Name Input */}
                <div style={{ marginBottom: '15px' }}>
                    <label style={{ display: 'block', fontSize: '12px', marginBottom: '5px', color: '#ccc' }}>
                        {t('common.name') || "Name"}
                    </label>
                    <input
                        type="text"
                        value={name}
                        // IEC identifier only — strip spaces/punctuation as typed.
                        onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
                        style={{
                            width: '100%', padding: '8px', background: '#333',
                            border: '1px solid #555', color: 'white', borderRadius: '4px',
                            boxSizing: 'border-box'
                        }}
                    />
                </div>

                {/* Type Selection */}
                <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', fontSize: '12px', marginBottom: '5px', color: '#ccc' }}>
                        {t('common.type') || "Type"}
                    </label>
                    <select
                        value={type}
                        onChange={handleTypeChange}
                        style={{
                            width: '100%', padding: '8px', background: '#333',
                            border: '1px solid #555', color: 'white', borderRadius: '4px',
                            boxSizing: 'border-box'
                        }}
                    >
                        <option value="Array">Array</option>
                        <option value="Enumerated">Enumerated</option>
                        <option value="Structure">Structure</option>
                    </select>
                </div>

                {error && <div style={{ color: '#ff6b6b', fontSize: '12px', marginBottom: '15px' }}>{error}</div>}

                {/* Actions */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'transparent', border: '1px solid #555',
                            color: '#ccc', padding: '8px 16px', borderRadius: '4px', cursor: 'pointer'
                        }}
                    >
                        {t('common.cancel') || "Cancel"}
                    </button>
                    <button
                        onClick={handleSave}
                        style={{
                            background: '#007acc', border: 'none',
                            color: 'white', padding: '8px 16px', borderRadius: '4px', cursor: 'pointer'
                        }}
                    >
                        {t('common.create') || "Create"}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default DataTypeCreationModal;
