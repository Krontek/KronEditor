import React, { useState } from 'react';

const VariableSelectionModal = ({ isOpen, onClose, onSelect, variables = [] }) => {
    const [selectedVar, setSelectedVar] = useState('');

    if (!isOpen) return null;

    const handleSelect = (varName) => {
        setSelectedVar(varName);
    };

    const handleConfirm = () => {
        if (selectedVar) {
            onSelect(selectedVar);
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
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000
        }}>
            <div style={{
                background: '#252526',
                border: '1px solid #444',
                borderRadius: '4px',
                width: '300px',
                padding: '16px',
                color: '#fff',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
            }}>
                <h3 style={{ marginTop: 0, marginBottom: '12px', fontSize: '14px' }}>Select Variable</h3>
                <p style={{ fontSize: '12px', color: '#ccc', marginBottom: '10px' }}>
                    Please select a BOOLEAN variable for this block:
                </p>

                <div style={{
                    maxHeight: '200px',
                    overflowY: 'auto',
                    border: '1px solid #333',
                    marginBottom: '10px',
                    background: '#1e1e1e'
                }}>
                    {variables.map(v => (
                        <div
                            key={`${v.scope}_${v.name}`}
                            onClick={() => handleSelect(v.name)}
                            onDoubleClick={() => {
                                onSelect(v.name);
                                onClose();
                            }}
                            style={{
                                padding: '6px 10px',
                                cursor: 'pointer',
                                background: selectedVar === v.name ? '#0d47a1' : 'transparent',
                                borderBottom: '1px solid #333',
                                fontSize: '12px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px'
                            }}
                        >
                            <span>{v.scope === 'Global' ? '🌍' : '🏠'}</span>
                            <span>{v.name}</span>
                        </div>
                    ))}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                    <button
                        onClick={onClose}
                        style={{
                            padding: '6px 12px',
                            background: 'transparent',
                            border: '1px solid #555',
                            color: '#ccc',
                            cursor: 'pointer',
                            borderRadius: '2px'
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleConfirm}
                        disabled={!selectedVar}
                        style={{
                            padding: '6px 12px',
                            background: selectedVar ? '#2e7d32' : '#555',
                            border: 'none',
                            color: 'white',
                            cursor: selectedVar ? 'pointer' : 'not-allowed',
                            borderRadius: '2px'
                        }}
                    >
                        Select
                    </button>
                </div>
            </div>
        </div>
    );
};

export default VariableSelectionModal;
