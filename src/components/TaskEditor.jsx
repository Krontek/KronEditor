import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

const TaskEditor = ({ tasks, onUpdate, onDelete, onAdd }) => {
    const { t } = useTranslation();

    // Default Task Object
    const createDefaultTask = (index) => ({
        id: `task_${Date.now()}_${Math.random()}`,
        name: `task${index}`,
        triggering: 'Cyclic', // 'Cyclic' | 'Interrupt'
        interval: 'T#1ms',
        priority: 1
    });

    const handleAdd = () => {
        // Find next available task index
        let i = 0;
        const names = tasks.map(t => t.name);
        while (names.includes(`task${i}`)) i++;
        onAdd(createDefaultTask(i));
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
                    + {t('actions.addTask')}
                </button>
            </div>

            {/* Table */}
            <div style={{ flex: 1, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead style={{ background: '#252526', position: 'sticky', top: 0 }}>
                        <tr>
                            <th style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid #444' }}>{t('tables.name')}</th>
                            <th style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid #444' }}>{t('tables.triggering')}</th>
                            <th style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid #444' }}>{t('tables.interval')}</th>
                            <th style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid #444' }}>{t('tables.priority')}</th>
                            <th style={{ padding: '8px', textAlign: 'center', borderBottom: '1px solid #444', width: '50px' }}>{t('tables.actions')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {tasks.map((task) => (
                            <tr key={task.id} style={{ borderBottom: '1px solid #333' }}>
                                {/* Name */}
                                <td style={{ padding: '4px' }}>
                                    <input
                                        type="text"
                                        value={task.name}
                                        onChange={(e) => onUpdate(task.id, 'name', e.target.value)}
                                        style={{ width: '100%', background: 'transparent', border: 'none', color: '#fff', padding: '4px' }}
                                    />
                                </td>
                                {/* Triggering */}
                                <td style={{ padding: '4px' }}>
                                    <select
                                        value={task.triggering}
                                        onChange={(e) => onUpdate(task.id, 'triggering', e.target.value)}
                                        style={{ width: '100%', background: '#1e1e1e', border: '1px solid #444', color: '#fff', padding: '4px' }}
                                    >
                                        <option value="Cyclic">{t('options.cyclic')}</option>
                                        <option value="Interrupt">{t('options.interrupt')}</option>
                                    </select>
                                </td>
                                {/* Interval */}
                                <td style={{ padding: '4px' }}>
                                    <input
                                        type="text"
                                        value={task.interval}
                                        onChange={(e) => onUpdate(task.id, 'interval', e.target.value)}
                                        style={{ width: '100%', background: 'transparent', border: 'none', color: '#ce9178', padding: '4px' }}
                                    />
                                </td>
                                {/* Priority */}
                                <td style={{ padding: '4px' }}>
                                    <input
                                        type="number"
                                        value={task.priority}
                                        onChange={(e) => onUpdate(task.id, 'priority', parseInt(e.target.value) || 0)}
                                        style={{ width: '100%', background: 'transparent', border: 'none', color: '#b5cea8', padding: '4px' }}
                                    />
                                </td>
                                {/* Action */}
                                <td style={{ padding: '4px', textAlign: 'center' }}>
                                    <button
                                        onClick={() => onDelete(task.id)}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f44336' }}
                                    >
                                        🗑
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {tasks.length === 0 && (
                    <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                        {t('messages.noTasks')}
                    </div>
                )}
            </div>
        </div>
    );
};

export default TaskEditor;
