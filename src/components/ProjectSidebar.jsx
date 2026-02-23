import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import PlcIcon from '../assets/icons/plc-icon.png';

const ProjectSidebar = ({ projectStructure, onSelectItem, activeId, onAddItem, onDeleteItem, onRenameItem, onSettingsClick, onShortcutsClick }) => {
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
                                            item.type === 'Array' ? <span style={{ fontFamily: 'monospace', fontWeight: 'bold', fontSize: '10px' }}>[ ]</span> :
                                                item.type === 'Enumerated' ? <span style={{ fontFamily: 'monospace', fontWeight: 'bold', fontSize: '10px' }}>(E)</span> :
                                                    item.type === 'Structure' ? <span style={{ fontFamily: 'monospace', fontWeight: 'bold', fontSize: '10px' }}>{'{ }'}</span> :
                                                        '📦'}
                                </span>
                                <span>{item.name}</span>
                                {item.type && <span style={{ fontSize: '9px', color: '#666', border: '1px solid #444', padding: '0 2px', borderRadius: 2 }}>{item.type}</span>}
                            </div>

                            {/* Action Buttons */}
                            <div style={{ display: 'flex', gap: '4px' }}>
                                {/* Rename Button */}
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        const newName = window.prompt(t('modals.enterName'), item.name);
                                        if (newName && newName !== item.name) {
                                            onRenameItem && onRenameItem(key, item.id, newName);
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
                                    title={t('common.rename')}
                                >
                                    ✎
                                </button>

                                {/* Delete Button */}
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (confirm(`${t('common.delete')} ${item.name}?`)) {
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
                    gap: '6px'
                }}
                title={t('resources.configuration')}
            >
                <img src={PlcIcon} alt="PLC" style={{ width: '18px', height: '18px', objectFit: 'contain' }} />
                <span>{t('sidebar.resources')}</span>
            </div>
            {renderSection('Data Types', 'dataTypes', projectStructure.dataTypes)}
            {renderSection('Function Blocks', 'functionBlocks', projectStructure.functionBlocks)}
            {renderSection('Functions', 'functions', projectStructure.functions)}
            {renderSection('Programs', 'programs', projectStructure.programs)}
        </div>
    );
};

export default ProjectSidebar;
