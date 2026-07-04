import { useState, useEffect } from 'react';
import { DataTypeSelector } from './common/Selectors';

const CreateItemModal = ({ isOpen, onClose, onConfirm, category, defaultName, isEdit, initialData }) => {
    const [name, setName] = useState('');
    // POUs are the unified rung model — the language is chosen PER RUNG in the
    // editor (Ladder or Structured Text), not up front. So programs/FBs/
    // functions are always created as 'SCL' (the internal tag for that model)
    // and there is no language picker for them anymore. Data types use 'UDT'.
    const [language, setLanguage] = useState('SCL');
    const [returnType, setReturnType] = useState('BOOL');

    useEffect(() => {
        if (isOpen) {
            setName(isEdit ? initialData?.name || '' : defaultName || '');
            setLanguage(category === 'dataTypes' ? 'UDT' : 'SCL');
            setReturnType(isEdit ? initialData?.returnType || 'BOOL' : 'BOOL');
        }
    }, [isOpen, defaultName, category, isEdit, initialData]);

    if (!isOpen) return null;

    const isDataType = category === 'dataTypes';
    const isFunction = category === 'functions';
    const title = isEdit ? 'Edit Properties' :
        category === 'dataTypes' ? 'Create Data Type' :
            category === 'programs' ? 'Create Program' :
                category === 'functionBlocks' ? 'Create Function Block' :
                    'Create Function';

    // IEC 61131-3 identifier: letter/underscore start, then letters/digits/_.
    // No spaces or punctuation — required by the C transpiler.
    const nameTrimmed = name.trim();
    const nameValid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(nameTrimmed);

    const handleConfirm = () => {
        if (!nameTrimmed || !nameValid) return;
        const success = onConfirm(name, language, returnType);
        if (success === false) {
            setName(isEdit ? initialData?.name || '' : defaultName || '');
        } else {
            onClose();
        }
    };

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000
        }}>
            <div style={{
                background: '#252526',
                padding: '20px',
                borderRadius: '8px',
                width: '400px',
                border: '1px solid #444',
                boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
                color: '#fff'
            }}>
                <h3 style={{ margin: '0 0 20px 0', borderBottom: '1px solid #444', paddingBottom: '10px' }}>
                    {title}
                </h3>

                {/* Name Input */}
                <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', marginBottom: '8px', fontSize: '12px', color: '#ccc' }}>
                        Name
                    </label>
                    <input
                        type="text"
                        value={name}
                        // Reject invalid IEC-identifier characters as you type: drop
                        // spaces and punctuation; only [A-Za-z0-9_] are kept. A
                        // leading digit is flagged below (not silently dropped).
                        onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
                        autoFocus
                        style={{
                            width: '100%',
                            padding: '10px',
                            background: '#1e1e1e',
                            border: '1px solid #444',
                            color: '#fff',
                            borderRadius: '4px',
                            outline: 'none',
                            fontSize: '14px',
                            boxSizing: 'border-box'
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') handleConfirm();
                            if (e.key === 'Escape') onClose();
                        }}
                    />
                    {nameTrimmed && !nameValid && (
                        <div style={{ marginTop: '6px', fontSize: '11px', color: '#e06c75' }}>
                            Invalid name — use only letters, digits and underscore, no spaces, and don't start with a digit.
                        </div>
                    )}
                </div>

                {/* Return Type Selection (Only for Functions) */}
                {isFunction && (
                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontSize: '12px', color: '#ccc' }}>
                            Return Type
                        </label>
                        <DataTypeSelector
                            value={returnType}
                            onChange={(val) => setReturnType(val)}
                            showArrays={false}
                        />
                    </div>
                )}

                {/* No language picker: a POU is a list of rungs, and each rung's
                    language (Ladder or Structured Text) is chosen inside the
                    editor with the "+ Rung" button. */}
                {!isDataType && !isEdit && (
                    <div style={{ marginBottom: '25px', fontSize: '12px', color: '#9aa', lineHeight: 1.5, background: '#1e1e1e', border: '1px solid #333', borderRadius: 4, padding: '10px 12px' }}>
                        Add <strong>Ladder</strong> or <strong>Structured Text</strong> rungs inside the editor — you can mix both in the same POU.
                    </div>
                )}

                {/* Buttons */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                    <button
                        onClick={onClose}
                        style={{
                            padding: '8px 16px',
                            background: 'transparent',
                            border: '1px solid #666',
                            color: '#fff',
                            borderRadius: '4px',
                            cursor: 'pointer'
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleConfirm}
                        disabled={!nameTrimmed || !nameValid}
                        style={{
                            padding: '8px 16px',
                            background: '#0d47a1',
                            border: 'none',
                            color: '#fff',
                            borderRadius: '4px',
                            cursor: (!nameTrimmed || !nameValid) ? 'default' : 'pointer',
                            fontWeight: 'bold',
                            opacity: (!nameTrimmed || !nameValid) ? 0.5 : 1
                        }}
                    >
                        {isEdit ? 'Save' : 'Create'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default CreateItemModal;
