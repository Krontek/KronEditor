import { useState, useRef, useEffect } from 'react';
import ForceWriteModal from './common/ForceWriteModal';

const LOG_COLORS = {
    info:    '#d4d4d4',
    success: '#4ec9b0',
    warning: '#ce9178',
    error:   '#f44336',
};

// Resolve an expression like "ProgName.varName" or "varName" to a liveKey
const resolveExpression = (expr, projectStructure) => {
    if (!expr || !projectStructure) return { liveKey: null, varType: null };

    const trimmed = expr.trim();
    const dotIdx = trimmed.indexOf('.');

    if (dotIdx > 0) {
        const progName = trimmed.slice(0, dotIdx).trim();
        const varName  = trimmed.slice(dotIdx + 1).trim();
        // Find matching program/FB
        const allPOUs = [
            ...(projectStructure.programs || []),
            ...(projectStructure.functionBlocks || []),
        ];
        const pou = allPOUs.find(p =>
            p.name.trim().replace(/\s+/g, '_') === progName.replace(/\s+/g, '_') ||
            p.name.trim() === progName
        );
        const varEntry = (pou?.content?.variables || []).find(v => v.name === varName);
        const safeProg = progName.replace(/\s+/g, '_');
        const safeVar  = varName.replace(/\s+/g, '_');
        return {
            liveKey: `prog_${safeProg}_${safeVar}`,
            varType: varEntry?.type || null,
        };
    }

    // Simple variable — no program prefix, search all programs
    const allPOUs = [
        ...(projectStructure.programs || []),
        ...(projectStructure.functionBlocks || []),
    ];
    for (const pou of allPOUs) {
        const v = (pou.content?.variables || []).find(vr => vr.name === trimmed);
        if (v) {
            const safeProg = pou.name.trim().replace(/\s+/g, '_');
            return { liveKey: `prog_${safeProg}_${trimmed.replace(/\s+/g, '_')}`, varType: v.type };
        }
    }
    return { liveKey: `${trimmed.replace(/\s+/g, '_')}`, varType: null };
};

const OutputPanel = ({
    logs = [],
    watchTable = [],
    onWatchTableUpdate,
    onWatchTableRemove,
    onForceWrite = null,
    liveVariables = null,
    isRunning = false,
    projectStructure = null,
}) => {
    const [activeTab, setActiveTab] = useState('all');
    const [forceModal, setForceModal] = useState(null);
    const [editingId, setEditingId] = useState(null);
    const [editValue, setEditValue] = useState('');
    const logEndRef = useRef(null);
    const editInputRef = useRef(null);

    // Auto-scroll log tabs on new messages
    useEffect(() => {
        if (['all', 'messages', 'warnings', 'errors'].includes(activeTab) && logEndRef.current) {
            logEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs, activeTab]);

    // Focus input when editing starts
    useEffect(() => {
        if (editingId && editInputRef.current) {
            editInputRef.current.focus();
            editInputRef.current.select();
        }
    }, [editingId]);

    const filtered = {
        all:      logs,
        messages: logs.filter(l => l.type === 'info' || l.type === 'success'),
        warnings: logs.filter(l => l.type === 'warning'),
        errors:   logs.filter(l => l.type === 'error'),
    };

    const TABS = [
        { key: 'all',      label: 'All' },
        { key: 'messages', label: 'Messages', badge: filtered.messages.length, badgeColor: '#4ec9b0' },
        { key: 'warnings', label: 'Warnings', badge: filtered.warnings.length, badgeColor: '#ce9178' },
        { key: 'errors',   label: 'Errors',   badge: filtered.errors.length,   badgeColor: '#f44336' },
        { key: 'watch',    label: 'Watchtable', badge: watchTable.length,       badgeColor: '#007acc' },
    ];

    const getLiveVal = (liveKey) => {
        if (!liveVariables || !liveKey) return undefined;
        return liveVariables[liveKey];
    };

    const formatVal = (val, type) => {
        if (val === null || val === undefined) return '---';
        if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
        if (type === 'TIME') {
            const us = Number(val);
            if (us >= 1000000 && us % 1000000 === 0) return `${us / 1000000}s`;
            if (us >= 1000 && us % 1000 === 0) return `${us / 1000}ms`;
            return `${us}µs`;
        }
        return String(val);
    };

    const commitEdit = (entry) => {
        if (!editValue.trim() || !onWatchTableUpdate) { setEditingId(null); return; }
        const { liveKey, varType } = resolveExpression(editValue, projectStructure);
        onWatchTableUpdate(entry.id, {
            ...entry,
            displayName: editValue.trim(),
            liveKey: liveKey || entry.liveKey,
            varType: varType || entry.varType,
        });
        setEditingId(null);
    };

    const tabStyle = (key) => ({
        padding: '5px 12px',
        background: 'transparent',
        border: 'none',
        borderBottom: activeTab === key ? '2px solid #007acc' : '2px solid transparent',
        color: activeTab === key ? '#fff' : '#888',
        fontSize: 11,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        whiteSpace: 'nowrap',
        outline: 'none',
    });

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#1e1e1e' }}>

            {/* ── Tab bar ── */}
            <div style={{ display: 'flex', background: '#2d2d2d', borderBottom: '1px solid #333', overflowX: 'auto', flexShrink: 0 }}>
                {TABS.map(tab => (
                    <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={tabStyle(tab.key)}>
                        {tab.label}
                        {tab.badge != null && tab.badge > 0 && (
                            <span style={{
                                background: tab.badgeColor,
                                color: '#fff',
                                borderRadius: 8,
                                padding: '0 5px',
                                fontSize: 10,
                                fontWeight: 'bold',
                                lineHeight: '16px',
                                minWidth: 16,
                                textAlign: 'center',
                                display: 'inline-block',
                            }}>
                                {tab.badge > 999 ? '999+' : tab.badge}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* ── Log content ── */}
            {activeTab !== 'watch' && (
                <div style={{ flex: 1, overflowY: 'auto', padding: '4px 6px', fontFamily: 'Consolas, monospace', fontSize: 12 }}>
                    {filtered[activeTab].length === 0 ? (
                        <div style={{ color: '#555', padding: '8px 4px', fontStyle: 'italic' }}>No {activeTab} messages.</div>
                    ) : (
                        filtered[activeTab].map((log, i) => (
                            <div key={i} style={{ color: LOG_COLORS[log.type] || '#d4d4d4', padding: '1px 0', lineHeight: 1.5 }}>
                                {log.msg}
                            </div>
                        ))
                    )}
                    <div ref={logEndRef} />
                </div>
            )}

            {/* ── Watchtable ── */}
            {activeTab === 'watch' && (
                <div style={{ flex: 1, overflowY: 'auto' }}>
                    {watchTable.length === 0 ? (
                        <div style={{ color: '#555', padding: '12px', fontStyle: 'italic', fontSize: 12, textAlign: 'center' }}>
                            Watch table is empty.<br />
                            <span style={{ fontSize: 11 }}>Right-click a variable in the variable table to add it.</span>
                        </div>
                    ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: '#ccc', fontFamily: 'Consolas, monospace' }}>
                            <thead>
                                <tr style={{ background: '#252526', position: 'sticky', top: 0, zIndex: 1 }}>
                                    <th style={{ padding: '5px 8px', borderBottom: '1px solid #333', textAlign: 'left', fontWeight: 'normal', color: '#888', fontSize: 11 }}>Expression</th>
                                    <th style={{ padding: '5px 8px', borderBottom: '1px solid #333', textAlign: 'left', fontWeight: 'normal', color: '#888', fontSize: 11 }}>Type</th>
                                    <th style={{ padding: '5px 8px', borderBottom: '1px solid #333', textAlign: 'left', fontWeight: 'normal', color: '#888', fontSize: 11 }}>Live Value</th>
                                    <th style={{ padding: '5px 4px', borderBottom: '1px solid #333', width: 28 }}></th>
                                    <th style={{ padding: '5px 4px', borderBottom: '1px solid #333', width: 28 }}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {watchTable.map(entry => {
                                    const val = getLiveVal(entry.liveKey);
                                    const hasVal = val !== undefined;
                                    const isInvalid = isRunning && !hasVal;
                                    const displayVal = formatVal(val, entry.varType);
                                    const isEditing = editingId === entry.id;

                                    return (
                                        <tr key={entry.id} style={{
                                            borderBottom: '1px solid #2a2a2a',
                                            background: isInvalid ? 'rgba(244,67,54,0.07)' : 'transparent',
                                        }}>
                                            <td style={{ padding: '2px 8px' }}>
                                                {isEditing ? (
                                                    <input
                                                        ref={editInputRef}
                                                        value={editValue}
                                                        onChange={e => setEditValue(e.target.value)}
                                                        onBlur={() => commitEdit(entry)}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') commitEdit(entry);
                                                            if (e.key === 'Escape') setEditingId(null);
                                                        }}
                                                        style={{
                                                            background: '#2d2d2d',
                                                            border: '1px solid #007acc',
                                                            color: '#90caf9',
                                                            fontSize: 12,
                                                            fontFamily: 'Consolas, monospace',
                                                            padding: '1px 4px',
                                                            width: '100%',
                                                            outline: 'none',
                                                            borderRadius: 2,
                                                        }}
                                                    />
                                                ) : (
                                                    <span
                                                        onClick={() => { setEditingId(entry.id); setEditValue(entry.displayName); }}
                                                        title="Click to edit expression"
                                                        style={{
                                                            color: isInvalid ? '#f44336' : '#90caf9',
                                                            cursor: 'text',
                                                            display: 'block',
                                                            padding: '1px 0',
                                                        }}
                                                    >
                                                        {entry.displayName}
                                                    </span>
                                                )}
                                            </td>
                                            <td style={{ padding: '4px 8px', color: isInvalid ? '#f44336' : '#ce9178' }}>
                                                {entry.varType || '—'}
                                            </td>
                                            <td style={{ padding: '4px 8px' }}>
                                                <span style={{
                                                    color: isInvalid ? '#f44336' : hasVal ? '#00e676' : '#555',
                                                    fontWeight: hasVal && !isInvalid ? 'bold' : 'normal',
                                                }}>
                                                    {isInvalid ? '? invalid' : displayVal}
                                                </span>
                                            </td>
                                            <td style={{ padding: '3px 4px', textAlign: 'center' }}>
                                                <button
                                                    title="Write value"
                                                    disabled={!isRunning || !onForceWrite || isInvalid}
                                                    onClick={() => setForceModal({
                                                        liveKey: entry.liveKey,
                                                        displayName: entry.displayName,
                                                        varType: entry.varType,
                                                        currentValue: val,
                                                    })}
                                                    style={{
                                                        background: 'transparent',
                                                        border: 'none',
                                                        color: isRunning && onForceWrite && !isInvalid ? '#4fc3f7' : '#444',
                                                        cursor: isRunning && onForceWrite && !isInvalid ? 'pointer' : 'default',
                                                        fontSize: 13,
                                                        padding: '1px 3px',
                                                        lineHeight: 1,
                                                    }}
                                                >✎</button>
                                            </td>
                                            <td style={{ padding: '3px 4px', textAlign: 'center' }}>
                                                <button
                                                    title="Remove from watch"
                                                    onClick={() => onWatchTableRemove && onWatchTableRemove(entry.id)}
                                                    style={{
                                                        background: 'transparent',
                                                        border: 'none',
                                                        color: '#c62828',
                                                        cursor: 'pointer',
                                                        fontSize: 13,
                                                        padding: '1px 3px',
                                                        lineHeight: 1,
                                                    }}
                                                >✕</button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {/* Force Write Modal */}
            {forceModal && (
                <ForceWriteModal
                    isOpen={true}
                    onClose={() => setForceModal(null)}
                    varName={forceModal.displayName}
                    varType={forceModal.varType}
                    currentValue={forceModal.currentValue}
                    liveKey={forceModal.liveKey}
                    onConfirm={(key, val) => { onForceWrite && onForceWrite(key, val); setForceModal(null); }}
                />
            )}
        </div>
    );
};

export default OutputPanel;
