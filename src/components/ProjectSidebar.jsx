import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ask } from '@tauri-apps/plugin-dialog';
import PlcIcon from '../assets/icons/plc-icon.png';

const ProjectSidebar = ({ projectStructure, onSelectItem, activeId, onAddItem, onDeleteItem, onEditItem, onSettingsClick, onShortcutsClick }) => {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState({
        dataTypes: true,
        functionBlocks: true,
        functions: true,
        programs: true
    });

    const toggle = (key) => {
        setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const renderSection = (title, key, items, allowTypes = []) => (
        <div style={{ marginBottom: 10 }}>
            {/* Header */}
            <div
                style={{
                    padding: '5px 10px',
                    background: '#2d2d2d',
                    color: '#ddd',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                }}
                onClick={() => toggle(key)}
            >
                <span>{expanded[key] ? '▼' : '▶'} {t(`sidebar.${key}`)}</span>
                {key !== 'resources' && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onAddItem(key);
                        }}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: '#fff',
                            cursor: 'pointer',
                            fontSize: '14px',
                            padding: '0 4px'
                        }}
                        title={t('actions.addNew')}
                    >
                        +
                    </button>
                )}
            </div>

            {/* List */}
            {expanded[key] && (
                <div style={{ paddingLeft: 0 }}>
                    {items.map(item => (
                        <div
                            key={item.id}
                            onClick={() => onSelectItem(key, item.id)}
                            style={{
                                padding: '6px 15px',
                                cursor: 'pointer',
                                background: activeId === item.id ? '#37373d' : 'transparent',
                                borderLeft: activeId === item.id ? '3px solid #007acc' : '3px solid transparent',
                                color: activeId === item.id ? '#fff' : '#ccc',
                                fontSize: '12px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between'
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span>
                                    {item.type === 'ST' ? '📄' :
                                        item.type === 'LD' ? '🪜' :
                                            item.type === 'Array' ? <span style={{ fontFamily: 'Consolas, monospace', fontWeight: 'bold', fontSize: '10px', background: '#0e639c', color: '#fff', padding: '2px 4px', borderRadius: '3px', border: '1px solid #1177bb' }}>[ ]</span> :
                                                item.type === 'Enumerated' ? <span style={{ fontFamily: 'Consolas, monospace', fontWeight: 'bold', fontSize: '10px', background: '#68217a', color: '#fff', padding: '2px 4px', borderRadius: '3px', border: '1px solid #8e2fade' }}>(E)</span> :
                                                    item.type === 'Structure' ? <span style={{ fontFamily: 'Consolas, monospace', fontWeight: 'bold', fontSize: '10px', background: '#b87333', color: '#fff', padding: '2px 4px', borderRadius: '3px', border: '1px solid #d9873c' }}>{'{ }'}</span> :
                                                        '📦'}
                                </span>
                                <span>{item.name}</span>
                                {key === 'programs' && item.cycleTime && <span style={{ fontSize: '10px', color: '#888', marginLeft: '4px' }}>[{item.cycleTime}]</span>}
                                {item.type && <span style={{ fontSize: '9px', color: '#666', border: '1px solid #444', padding: '0 2px', borderRadius: 2 }}>{item.type}</span>}
                            </div>

                            {/* Action Buttons */}
                            <div style={{ display: 'flex', gap: '4px' }}>
                                {/* Edit Button */}
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onEditItem && onEditItem(key, item.id);
                                    }}
                                    style={{
                                        background: 'none',
                                        border: 'none',
                                        color: '#666',
                                        cursor: 'pointer',
                                        fontSize: '12px',
                                        opacity: activeId === item.id ? 1 : 0.5
                                    }}
                                    title={t('actions.edit') || 'Edit'}
                                >
                                    ✎
                                </button>

                                {/* Delete Button */}
                                <button
                                    onClick={async (e) => {
                                        e.stopPropagation();
                                        const confirmed = await ask(`${t('common.delete')} ${item.name}?`, {
                                            title: t('common.delete') || 'Delete',
                                            type: 'warning'
                                        });
                                        if (confirmed) {
                                            onDeleteItem(key, item.id);
                                        }
                                    }}
                                    style={{
                                        background: 'none',
                                        border: 'none',
                                        color: '#666',
                                        cursor: 'pointer',
                                        fontSize: '12px',
                                        opacity: activeId === item.id ? 1 : 0.5
                                    }}
                                    title={t('common.delete')}
                                >
                                    🗑️
                                </button>
                            </div>
                        </div>
                    ))}
                    {items.length === 0 && (
                        <div style={{ padding: '5px 15px', color: '#666', fontSize: '11px', fontStyle: 'italic' }}>
                            {t('messages.empty')}
                        </div>
                    )}
                </div>
            )}
        </div>
    );

    return (
        <div style={{ height: '100%', overflowY: 'auto', background: '#252526', borderRight: '1px solid #333' }}>
            <div
                style={{
                    padding: '10px',
                    borderBottom: '1px solid #333',
                    color: '#fff',
                    fontWeight: 'bold',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                }}
            >
                <span>PLC Project</span>
                <div style={{ display: 'flex', gap: '10px' }}>
                    <span
                        onClick={onShortcutsClick}
                        style={{ fontSize: '16px', color: '#ccc', cursor: 'pointer' }}
                        title={t('common.shortcuts') || 'Shortcuts'}
                    >
                        ℹ️
                    </span>
                    <span
                        onClick={onSettingsClick}
                        style={{ fontSize: '16px', color: '#ccc', cursor: 'pointer' }}
                        title={t('common.settings')}
                    >
                        ⚙️
                    </span>
                </div>
            </div>

            {/* Resources (Single Item, Flattened) */}
            <div
                onClick={() => {
                    const configItem = projectStructure.resources[0];
                    if (configItem) {
                        onSelectItem('resources', configItem.id);
                    }
                }}
                style={{
                    padding: '8px 10px',
                    borderBottom: '1px solid #333',
                    background: activeId === (projectStructure.resources[0]?.id) ? '#37373d' : 'transparent',
                    color: activeId === (projectStructure.resources[0]?.id) ? '#fff' : '#ccc',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                }}
                title={t('resources.globalVariables')}
            >
                <span>⚙️</span>
                <span>{t('sidebar.global')}</span>
            </div>
            {renderSection('Data Types', 'dataTypes', projectStructure.dataTypes)}
            {renderSection('Function Blocks', 'functionBlocks', projectStructure.functionBlocks)}
            {renderSection('Functions', 'functions', projectStructure.functions)}
            {renderSection('Programs', 'programs', projectStructure.programs)}
        </div>
    );
};

export default ProjectSidebar;
