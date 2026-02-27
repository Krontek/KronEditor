import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

const SelectTargetModal = ({ isOpen, onClose, onSelect, currentTarget }) => {
    const { t } = useTranslation();

    const targetCategories = [
        {
            name: 'i.MX Series',
            targets: [
                { id: 'imx8m', name: 'i.MX 8M (imx8m)' },
                { id: 'imx6ull', name: 'i.MX 6ULL (imx6ull)' }
            ]
        },
        {
            name: 'ARM Cortex-M',
            targets: [
                { id: 'stm32f4', name: 'STM32F4 (Generic)' },
                { id: 'stm32f7', name: 'STM32F7 (Generic)' }
            ]
        },
        {
            name: 'x86_64',
            targets: [
                { id: 'x86_64_linux', name: 'Generic Linux (x86_64)' }
            ]
        }
    ];

    if (!isOpen) return null;

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
            <div style={{ background: '#252526', width: 400, borderRadius: 6, border: '1px solid #333', overflow: 'hidden' }}>
                <div style={{ padding: '12px 15px', background: '#2d2d2d', borderBottom: '1px solid #333', fontWeight: 'bold' }}>
                    {t('actions.selectTarget') || 'Select Target'}
                </div>

                <div style={{ padding: 15, maxHeight: 300, overflowY: 'auto' }}>
                    {targetCategories.map((category) => (
                        <div key={category.name} style={{ marginBottom: 15 }}>
                            <div style={{ fontSize: '12px', color: '#888', textTransform: 'uppercase', marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid #333' }}>
                                {category.name}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                                {category.targets.map(target => (
                                    <div
                                        key={target.id}
                                        onClick={() => {
                                            onSelect(target.id);
                                            onClose();
                                        }}
                                        style={{
                                            padding: '8px 12px',
                                            background: currentTarget === target.id ? '#007acc' : '#1e1e1e',
                                            border: '1px solid',
                                            borderColor: currentTarget === target.id ? '#007acc' : '#333',
                                            borderRadius: 4,
                                            cursor: 'pointer',
                                            color: '#ccc',
                                            fontSize: '13px',
                                            transition: 'background 0.2s'
                                        }}
                                        onMouseEnter={(e) => {
                                            if (currentTarget !== target.id) e.target.style.background = '#2a2d2e';
                                        }}
                                        onMouseLeave={(e) => {
                                            if (currentTarget !== target.id) e.target.style.background = '#1e1e1e';
                                        }}
                                    >
                                        {currentTarget === target.id && <span style={{ marginRight: 8 }}>✓</span>}
                                        {target.name}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                <div style={{ padding: 15, background: '#1e1e1e', borderTop: '1px solid #333', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'transparent',
                            color: '#ccc',
                            border: '1px solid #555',
                            padding: '6px 15px',
                            cursor: 'pointer',
                            borderRadius: 3
                        }}
                    >
                        {t('common.close') || 'Close'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SelectTargetModal;
