import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

const BlockSettingsModal = ({ isOpen, onClose, blockData, onSave, blockConfig, variables = [], globalVars = [] }) => {
    const { t } = useTranslation();
    const [instanceName, setInstanceName] = useState('');
    const [executionControl, setExecutionControl] = useState(false);
    const [subType, setSubType] = useState('');

    useEffect(() => {
        if (isOpen && blockData) {
            setInstanceName(blockData.instanceName || (blockData.type === 'Contact' ? (blockData.values?.var || '') : (blockData.values?.coil || '')));
            setExecutionControl(!!blockData.executionControl);
            setSubType(blockData.subType || (blockData.type === 'Contact' ? 'NO' : 'Normal'));
        }
    }, [isOpen, blockData]);

    if (!isOpen || !blockData) return null;

    const isContact = blockData.type === 'Contact';
    const isCoil = blockData.type === 'Coil';
    const isFunctionBlock = !isContact && !isCoil;

    let config = blockConfig[blockData.type];

    // Dynamic config for User Defined Blocks
    if (blockData.customData) {
        const variables = blockData.customData.content?.variables || [];
        const inputs = variables
            .filter(v => v.class === 'Input' || v.class === 'InOut')
            .map(v => ({ name: v.name, type: v.type }));
        const outputs = variables
            .filter(v => v.class === 'Output')
            .map(v => ({ name: v.name, type: v.type }));

        if (blockData.customData.returnType) {
            outputs.push({ name: 'OUT', type: blockData.customData.returnType });
        }

        config = {
            label: blockData.customData.name,
            inputs,
            outputs
        };
    }

    if (!config) config = { label: blockData.type, inputs: [], outputs: [] };

    const handleSave = () => {
        const newData = {
            instanceName,
            executionControl: isFunctionBlock ? executionControl : false,
            subType: (isContact || isCoil) ? subType : undefined,
            // Variables for Contact/Coil
            values: {
                ...blockData.values,
                ...(isContact ? { var: instanceName } : {}),
                ...(isCoil ? { coil: instanceName } : {})
            }
        };
        onSave(blockData.id, newData);
        onClose();
    };

    const contactTypes = ['NO', 'NC', 'Rising', 'Falling'];
    const coilTypes = ['Normal', 'Negated', 'Set', 'Reset', 'Rising', 'Falling'];

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
                    {isContact ? t('modals.contactSettings') : isCoil ? t('modals.coilSettings') : `${t('modals.blockSettings')}: ${blockData.type}`}
                </h3>

                {/* Variable Name / Instance Name */}
                <div style={{ marginBottom: '15px' }}>
                    <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', color: '#ccc' }}>
                        {isFunctionBlock ? t('common.instanceName') : t('common.variableName')}
                    </label>
                    <input
                        list="var-suggestions"
                        type="text"
                        value={instanceName}
                        onChange={(e) => {
                            const val = e.target.value.replace(/[🌍🏠]/g, '').trim();
                            setInstanceName(val);
                        }}
                        style={{
                            width: '100%',
                            padding: '8px',
                            background: '#1e1e1e',
                            border: '1px solid #444',
                            color: '#fff',
                            borderRadius: '4px'
                        }}
                    />
                    <datalist id="var-suggestions">
                        {/* 1. LOCAL VARS */}
                        {(variables || []).map(v => (
                            <option key={`local_${v.name}`} value={`🏠 ${v.name}`} />
                        ))}
                        {/* 2. GLOBAL VARS (exclude duplicates if any) */}
                        {(globalVars || []).filter(g => !variables.some(l => l.name === g.name)).map(v => (
                            <option key={`global_${v.name}`} value={`🌍 ${v.name}`} />
                        ))}
                    </datalist>
                </div>

                {/* Type Selection for Contact/Coil */}
                {(isContact || isCoil) && (
                    <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '5px', fontSize: '12px', color: '#ccc' }}>
                            {t('common.type')}
                        </label>
                        <select
                            value={subType}
                            onChange={(e) => setSubType(e.target.value)}
                            style={{
                                width: '100%',
                                padding: '8px',
                                background: '#1e1e1e',
                                border: '1px solid #444',
                                color: '#fff',
                                borderRadius: '4px',
                                cursor: 'pointer'
                            }}
                        >
                            {(isContact ? contactTypes : coilTypes).map(t => (
                                <option key={t} value={t}>{t}</option>
                            ))}
                        </select>
                    </div>
                )}

                {/* Execution Control (Only for Function Blocks) */}
                {isFunctionBlock && (
                    <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <input
                            type="checkbox"
                            id="executionControl"
                            checked={executionControl}
                            onChange={(e) => setExecutionControl(e.target.checked)}
                            style={{ width: '16px', height: '16px' }}
                        />
                        <label htmlFor="executionControl" style={{ fontSize: '14px' }}>
                            {t('common.enableExecutionControl')}
                        </label>
                    </div>
                )}

                {/* Information Table (Only for Function Blocks) */}
                {isFunctionBlock && (
                    <div style={{ marginBottom: '20px' }}>
                        <h4 style={{ fontSize: '12px', color: '#888', textTransform: 'uppercase', marginBottom: '10px' }}>
                            {t('common.pinInformation')}
                        </h4>
                        <div style={{ background: '#1e1e1e', padding: '10px', borderRadius: '4px', fontSize: '12px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '5px', fontWeight: 'bold' }}>
                                <span>{t('common.pin')}</span>
                                <span>{t('common.type')}</span>
                            </div>
                            {config.inputs.map((pin, i) => (
                                <div key={`in_${i}`} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', borderTop: '1px solid #333', padding: '4px 0' }}>
                                    <span style={{ color: '#4CAF50' }}>{pin.name} (In)</span>
                                    <span>{pin.type}</span>
                                </div>
                            ))}
                            {config.outputs.map((pin, i) => (
                                <div key={`out_${i}`} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', borderTop: '1px solid #333', padding: '4px 0' }}>
                                    <span style={{ color: '#FF5722' }}>{pin.name} (Out)</span>
                                    <span>{pin.type}</span>
                                </div>
                            ))}
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
                        {t('common.cancel')}
                    </button>
                    <button
                        onClick={handleSave}
                        style={{
                            padding: '8px 16px',
                            background: '#0d47a1',
                            border: 'none',
                            color: '#fff',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontWeight: 'bold'
                        }}
                    >
                        {t('common.save')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default BlockSettingsModal;
