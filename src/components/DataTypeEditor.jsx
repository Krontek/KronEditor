import React from 'react';
import { DataTypeSelector } from './common/Selectors';
import { useTranslation } from 'react-i18next';

const DataTypeEditor = ({ members = [], onUpdateMembers }) => {
    const { t } = useTranslation();

    const handleAddMember = () => {
        const newMember = {
            id: Date.now(),
            name: `Member${members.length}`,
            type: 'BOOL',
            initialValue: '',
            description: ''
        };
        onUpdateMembers([...members, newMember]);
    };

    const handleDeleteMember = (id) => {
        onUpdateMembers(members.filter(m => m.id !== id));
    };

    const handleUpdate = (id, field, value) => {
        onUpdateMembers(members.map(m => m.id === id ? { ...m, [field]: value } : m));
    };

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#1e1e1e', color: '#ccc' }}>
            <div style={{ padding: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #333' }}>
                <span style={{ fontWeight: 'bold' }}>{t('tables.structMembers')}</span>
                <button
                    onClick={handleAddMember}
                    style={{
                        background: '#007acc',
                        color: 'white',
                        border: 'none',
                        padding: '4px 12px',
                        cursor: 'pointer',
                        borderRadius: '3px'
                    }}
                >
                    + {t('actions.addNew')}
                </button>
            </div>

            <div style={{ flex: 1, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                    <thead style={{ background: '#252526', position: 'sticky', top: 0 }}>
                        <tr>
                            <th style={{ padding: '8px', borderBottom: '1px solid #333' }}>{t('tables.name')}</th>
                            <th style={{ padding: '8px', borderBottom: '1px solid #333', width: '150px' }}>{t('tables.type')}</th>
                            <th style={{ padding: '8px', borderBottom: '1px solid #333' }}>{t('tables.initialValue')}</th>
                            <th style={{ padding: '8px', borderBottom: '1px solid #333' }}>{t('tables.description')}</th>
                            <th style={{ padding: '8px', borderBottom: '1px solid #333', textAlign: 'center', width: '50px' }}>{t('tables.actions')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {members.map(member => (
                            <tr key={member.id} style={{ borderBottom: '1px solid #333' }}>
                                <td style={{ padding: '4px' }}>
                                    <input
                                        value={member.name}
                                        onChange={(e) => handleUpdate(member.id, 'name', e.target.value)}
                                        style={{ background: 'transparent', border: 'none', color: '#9cdcfe', width: '100%', outline: 'none' }}
                                    />
                                </td>
                                <td style={{ padding: '4px' }}>
                                    <DataTypeSelector
                                        value={member.type}
                                        onChange={(val) => handleUpdate(member.id, 'type', val)}
                                    />
                                </td>
                                <td style={{ padding: '4px' }}>
                                    <input
                                        value={member.initialValue}
                                        onChange={(e) => handleUpdate(member.id, 'initialValue', e.target.value)}
                                        style={{ background: 'transparent', border: 'none', color: '#ce9178', width: '100%', outline: 'none' }}
                                    />
                                </td>
                                <td style={{ padding: '4px' }}>
                                    <input
                                        value={member.description}
                                        onChange={(e) => handleUpdate(member.id, 'description', e.target.value)}
                                        style={{ background: 'transparent', border: 'none', color: '#6a9955', width: '100%', outline: 'none' }}
                                    />
                                </td>
                                <td style={{ padding: '4px', textAlign: 'center' }}>
                                    <button
                                        onClick={() => handleDeleteMember(member.id)}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f44336' }}
                                    >
                                        🗑️
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {members.length === 0 && (
                            <tr>
                                <td colSpan="5" style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
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

export default DataTypeEditor;
