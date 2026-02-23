import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

const InstanceEditor = ({ instances, programs, tasks, onUpdate, onDelete, onAdd }) => {
    const { t } = useTranslation();

    // Default Instance Object
    const createDefaultInstance = (index) => ({
        id: `inst_${Date.now()}_${Math.random()}`,
        name: `instance${index}`,
        program: '',
        task: ''
    });

    const handleAdd = () => {
        // Find next available instance index
        let i = 0;
        const names = instances.map(inst => inst.name);
        while (names.includes(`instance${i}`)) i++;
        onAdd(createDefaultInstance(i));
    };

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: '#fff' }}>
            {/* Toolbar */}
            <div style={{ padding: '10px', background: '#333', borderBottom: '1px solid #444', display: 'flex', gap: '10px' }}>
                <button
                    onClick={handleAdd}
                    style={{
                        background: '#2e7d32',
                        color: '#fff',
                        border: 'none',
                        padding: '6px 12px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontWeight: 'bold'
                    }}
                >
                    + {t('actions.addInstance')}
                </button>
            </div>

            {/* Table */}
            <div style={{ flex: 1, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead style={{ background: '#252526', position: 'sticky', top: 0 }}>
                        <tr>
                            <th style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid #444' }}>{t('tables.name')}</th>
                            <th style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid #444' }}>{t('tables.program')}</th>
                            <th style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid #444' }}>{t('tables.task')}</th>
                            <th style={{ padding: '8px', textAlign: 'center', borderBottom: '1px solid #444', width: '50px' }}>{t('tables.actions')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {instances.map((inst) => (
                            <tr key={inst.id} style={{ borderBottom: '1px solid #333' }}>
                                {/* Name */}
                                <td style={{ padding: '4px' }}>
                                    <input
                                        type="text"
                                        value={inst.name}
                                        onChange={(e) => onUpdate(inst.id, 'name', e.target.value)}
                                        style={{ width: '100%', background: 'transparent', border: 'none', color: '#fff', padding: '4px' }}
                                    />
                                </td>
                                {/* Program Selector */}
                                <td style={{ padding: '4px' }}>
                                    <select
                                        value={inst.program}
                                        onChange={(e) => onUpdate(inst.id, 'program', e.target.value)}
                                        style={{ width: '100%', background: '#1e1e1e', border: '1px solid #444', color: '#fff', padding: '4px' }}
                                    >
                                        <option value="" disabled>{t('options.selectProgram')}</option>
                                        {programs.map(p => (
                                            <option key={p} value={p}>{p}</option>
                                        ))}
                                    </select>
                                </td>
                                {/* Task Selector */}
                                <td style={{ padding: '4px' }}>
                                    <select
                                        value={inst.task}
                                        onChange={(e) => onUpdate(inst.id, 'task', e.target.value)}
                                        style={{ width: '100%', background: '#1e1e1e', border: '1px solid #444', color: '#fff', padding: '4px' }}
                                    >
                                        <option value="" disabled>{t('options.selectTask')}</option>
                                        {tasks.map(t => (
                                            <option key={t} value={t}>{t}</option>
                                        ))}
                                    </select>
                                </td>
                                {/* Action */}
                                <td style={{ padding: '4px', textAlign: 'center' }}>
                                    <button
                                        onClick={() => onDelete(inst.id)}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f44336' }}
                                    >
                                        🗑
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {instances.length === 0 && (
                    <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                        {t('messages.noInstances')}
                    </div>
                )}
            </div>
        </div>
    );
};

export default InstanceEditor;
