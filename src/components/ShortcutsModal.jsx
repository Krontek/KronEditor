import React from 'react';
import { useTranslation } from 'react-i18next';

const ShortcutsModal = ({ isOpen, onClose }) => {
    const { t } = useTranslation();

    if (!isOpen) return null;

    const shortcuts = [
        { key: 'Ctrl + S', desc: t('actions.save') || 'Save Project' },
        { key: 'Ctrl + B', desc: t('actions.compile') || 'Compile Project' },
        { key: 'Ctrl + X', desc: t('actions.start') || 'Start Simulation' },
        { key: 'Ctrl + Z', desc: t('actions.undo') || 'Undo' },
        { key: 'Ctrl + Shift + Z', desc: t('actions.redo') || 'Redo' },
    ];

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000
        }}>
            <div style={{
                background: '#252526',
                width: '400px',
                padding: '20px',
                borderRadius: '8px',
                border: '1px solid #444',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                color: '#fff',
                position: 'relative'
            }}>
                <h3 style={{ margin: '0 0 20px 0', borderBottom: '1px solid #444', paddingBottom: '10px' }}>
                    {t('common.shortcuts') || 'Keyboard Shortcuts'}
                </h3>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {shortcuts.map((s, index) => (
                        <div key={index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ color: '#ccc' }}>{s.desc}</span>
                            <kbd style={{
                                background: '#3e3e42',
                                padding: '4px 8px',
                                borderRadius: '4px',
                                fontFamily: 'Consolas, monospace',
                                fontSize: '12px',
                                border: '1px solid #555'
                            }}>
                                {s.key}
                            </kbd>
                        </div>
                    ))}
                </div>

                <button
                    onClick={onClose}
                    style={{
                        marginTop: '25px',
                        width: '100%',
                        padding: '8px',
                        background: '#007acc',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontWeight: 'bold'
                    }}
                >
                    {t('common.close') || 'Close'}
                </button>
            </div>
        </div>
    );
};

export default ShortcutsModal;
