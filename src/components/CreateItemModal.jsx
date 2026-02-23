import React, { useState, useEffect } from 'react';
import { DataTypeSelector } from './common/Selectors';

const CreateItemModal = ({ isOpen, onClose, onConfirm, category, defaultName }) => {
    const [name, setName] = useState('');
    const [language, setLanguage] = useState('LD');
    const [returnType, setReturnType] = useState('BOOL');

    useEffect(() => {
        if (isOpen) {
            setName(defaultName || '');
            setLanguage(category === 'dataTypes' ? 'UDT' : 'LD');
            setReturnType('BOOL');
        }
    }, [isOpen, defaultName, category]);

    if (!isOpen) return null;

    const isDataType = category === 'dataTypes';
    const isFunction = category === 'functions';
    const title = category === 'dataTypes' ? 'Create Data Type' :
        category === 'programs' ? 'Create Program' :
            category === 'functionBlocks' ? 'Create Function Block' :
                'Create Function';

    const handleConfirm = () => {
        if (!name.trim()) return;
        onConfirm(name, language, returnType);
        onClose();
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
                        onChange={(e) => setName(e.target.value)}
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

                {/* Language Selection */}
                {!isDataType && (
                    <div style={{ marginBottom: '25px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontSize: '12px', color: '#ccc' }}>
                            Language
                        </label>
                        <div style={{ display: 'flex', gap: '20px' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                                <input
                                    type="radio"
                                    name="language"
                                    value="LD"
                                    checked={language === 'LD'}
                                    onChange={(e) => setLanguage(e.target.value)}
                                    style={{ accentColor: '#007acc' }}
                                />
                                <span>Ladder Logic (LD)</span>
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                                <input
                                    type="radio"
                                    name="language"
                                    value="ST"
                                    checked={language === 'ST'}
                                    onChange={(e) => setLanguage(e.target.value)}
                                    style={{ accentColor: '#007acc' }}
                                />
                                <span>Structured Text (ST)</span>
                            </label>
                        </div>
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
                        disabled={!name.trim()}
                        style={{
                            padding: '8px 16px',
                            background: '#0d47a1',
                            border: 'none',
                            color: '#fff',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontWeight: 'bold',
                            opacity: !name.trim() ? 0.5 : 1
                        }}
                    >
                        Create
                    </button>
                </div>
            </div>
        </div>
    );
};

export default CreateItemModal;
