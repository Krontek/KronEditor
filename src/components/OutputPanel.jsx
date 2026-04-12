import { useState, useRef, useEffect, useCallback } from 'react';
import ForceWriteModal from './common/ForceWriteModal';
import { ErrorCodeService } from '../services/ErrorCodeService';

const LOG_COLORS = {
    info:    '#c8c8c8',
    success: '#4ec9b0',
    warning: '#e5a64a',
    error:   '#f14c4c',
};

const LOG_ICONS = {
    info:    '●',
    success: '●',
    warning: '▲',
    error:   '✖',
};

const LOG_BG_HOVER = {
    info:    'rgba(200,200,200,0.05)',
    success: 'rgba(78,201,176,0.07)',
    warning: 'rgba(229,166,74,0.09)',
    error:   'rgba(241,76,76,0.09)',
};

// Resolve an expression like "ProgName.varName" or "varName" to a liveKey
const resolveExpression = (expr, projectStructure) => {
    if (!expr || !projectStructure) return { liveKey: null, varType: null };

    const trimmed = expr.trim();
    const dotIdx = trimmed.indexOf('.');

    if (dotIdx > 0) {
        const progName = trimmed.slice(0, dotIdx).trim();
        const varName  = trimmed.slice(dotIdx + 1).trim();
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

// Build grouped variable list from project structure + running live vars
const buildGroups = (projectStructure, liveVariables) => {
    const groups = [];

    if (projectStructure) {
        // Global variables group
        const globals = projectStructure.globalVars || [];
        if (globals.length > 0) {
            groups.push({
                label: 'GLOBAL VARIABLES',
                icon: '⬡',
                items: globals.map(v => ({ expr: v.name, type: v.type || null, prog: null })),
            });
        }

        // One group per POU
        const allPOUs = [
            ...(projectStructure.programs || []),
            ...(projectStructure.functionBlocks || []),
        ];
        for (const pou of allPOUs) {
            const vars = pou.content?.variables || [];
            if (vars.length > 0) {
                groups.push({
                    label: pou.name,
                    icon: '◈',
                    items: vars.map(v => ({
                        expr: `${pou.name}.${v.name}`,
                        type: v.type || null,
                        prog: pou.name,
                    })),
                });
            }
        }
    }

    // Add any live keys that aren't already covered
    if (liveVariables) {
        const coveredExprs = new Set(groups.flatMap(g => g.items.map(i => i.expr)));
        const extraItems = [];
        for (const key of Object.keys(liveVariables)) {
            const m = key.match(/^prog_(.+?)_(.+)$/);
            const expr = m ? `${m[1]}.${m[2]}` : key;
            if (!coveredExprs.has(expr)) extraItems.push({ expr, type: null, prog: m ? m[1] : null });
        }
        if (extraItems.length > 0) {
            groups.push({ label: 'LIVE (RUNTIME)', icon: '▶', items: extraItems });
        }
    }

    return groups;
};

// ── WatchVariablePicker — grouped variable browser dropdown ──────────────────
const WatchVariablePicker = ({ projectStructure, liveVariables, watchTable, onAdd, onClose }) => {
    const [search, setSearch] = useState('');
    const [manualExpr, setManualExpr] = useState('');
    const ref = useRef(null);
    const searchRef = useRef(null);

    useEffect(() => {
        searchRef.current?.focus();
        const handler = (e) => {
            if (ref.current && !ref.current.contains(e.target)) onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    const existing = new Set((watchTable || []).map(e => e.displayName));

    const allGroups = buildGroups(projectStructure, liveVariables);
    const q = search.trim().toLowerCase();

    const filteredGroups = q
        ? allGroups
            .map(g => ({
                ...g,
                items: g.items.filter(s =>
                    s.expr.toLowerCase().includes(q) ||
                    (s.type || '').toLowerCase().includes(q) ||
                    (s.prog || '').toLowerCase().includes(q)
                ),
            }))
            .filter(g => g.items.length > 0)
        : allGroups;

    const addEntry = (s) => {
        if (existing.has(s.expr)) return;
        const { liveKey, varType } = resolveExpression(s.expr, projectStructure);
        onAdd({
            id: `watch_${Date.now()}_${Math.random()}`,
            displayName: s.expr,
            liveKey: liveKey || s.expr.replace(/\s+/g, '_'),
            varType: s.type || varType || null,
        });
    };

    const commitManual = () => {
        const expr = manualExpr.trim();
        if (!expr) return;
        const { liveKey, varType } = resolveExpression(expr, projectStructure);
        onAdd({
            id: `watch_${Date.now()}_${Math.random()}`,
            displayName: expr,
            liveKey: liveKey || expr.replace(/\s+/g, '_'),
            varType: varType || null,
        });
        setManualExpr('');
    };

    return (
        <div
            ref={ref}
            style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                width: 300,
                maxHeight: 380,
                background: '#1e1e1e',
                border: '1px solid #3c3c3c',
                borderRadius: 4,
                boxShadow: '0 6px 20px rgba(0,0,0,0.6)',
                zIndex: 200,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
            }}
        >
            {/* Header */}
            <div style={{
                padding: '6px 10px',
                borderBottom: '1px solid #2a2a2a',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: '#252525',
                flexShrink: 0,
            }}>
                <span style={{ color: '#888', fontSize: 10, letterSpacing: '0.08em', fontWeight: '600', textTransform: 'uppercase' }}>
                    Add Variable to Watch
                </span>
                <button
                    onMouseDown={e => { e.preventDefault(); onClose(); }}
                    style={{ background: 'transparent', border: 'none', color: '#555', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 2px' }}
                >✕</button>
            </div>

            {/* Search input */}
            <div style={{ padding: '6px 8px', borderBottom: '1px solid #222', flexShrink: 0 }}>
                <input
                    ref={searchRef}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
                    placeholder="Filter variables…"
                    style={{
                        width: '100%',
                        background: '#141414',
                        border: '1px solid #2a2a2a',
                        borderRadius: 2,
                        color: '#ccc',
                        fontSize: 12,
                        fontFamily: '"Consolas", "Cascadia Code", monospace',
                        padding: '4px 8px',
                        outline: 'none',
                        boxSizing: 'border-box',
                    }}
                />
            </div>

            {/* Variable groups list */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {filteredGroups.length === 0 && (
                    <div style={{ padding: '16px 12px', color: '#444', fontSize: 11, fontStyle: 'italic', textAlign: 'center' }}>
                        No variables found.
                    </div>
                )}
                {filteredGroups.map(g => (
                    <div key={g.label}>
                        {/* Group header */}
                        <div style={{
                            padding: '5px 10px 3px',
                            fontSize: 9,
                            color: '#555',
                            letterSpacing: '0.1em',
                            fontWeight: '600',
                            textTransform: 'uppercase',
                            background: '#1a1a1a',
                            position: 'sticky',
                            top: 0,
                            zIndex: 1,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 5,
                        }}>
                            <span style={{ color: '#444', fontSize: 10 }}>{g.icon}</span>
                            {g.label}
                        </div>
                        {/* Variables */}
                        {g.items.map(s => {
                            const added = existing.has(s.expr);
                            return (
                                <div
                                    key={s.expr}
                                    onMouseDown={e => { e.preventDefault(); addEntry(s); }}
                                    style={{
                                        padding: '4px 10px 4px 18px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        cursor: added ? 'default' : 'pointer',
                                        borderBottom: '1px solid #1a1a1a',
                                        background: 'transparent',
                                        transition: 'background 0.08s',
                                    }}
                                    onMouseEnter={e => { if (!added) e.currentTarget.style.background = '#094771'; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                    <span style={{
                                        color: added ? '#3a5a7a' : '#7eb8f7',
                                        flex: 1,
                                        fontSize: 12,
                                        fontFamily: '"Consolas", "Cascadia Code", monospace',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}>
                                        {s.expr}
                                    </span>
                                    {s.type && (
                                        <span style={{ color: added ? '#4a4a2a' : '#b07040', fontSize: 10, flexShrink: 0 }}>
                                            {s.type}
                                        </span>
                                    )}
                                    {added
                                        ? <span style={{ color: '#4ec9b0', fontSize: 11, flexShrink: 0 }}>✓</span>
                                        : <span style={{ color: '#2a4a6a', fontSize: 11, flexShrink: 0 }}>+</span>
                                    }
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>

            {/* Manual expression input */}
            <div style={{
                borderTop: '1px solid #2a2a2a',
                padding: '5px 8px',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: '#1a1a1a',
                flexShrink: 0,
            }}>
                <input
                    value={manualExpr}
                    onChange={e => setManualExpr(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); commitManual(); }
                        if (e.key === 'Escape') onClose();
                    }}
                    placeholder="Or type expression…  Prog.Var"
                    style={{
                        flex: 1,
                        background: 'transparent',
                        border: 'none',
                        color: '#9cdcfe',
                        fontSize: 11,
                        fontFamily: '"Consolas", "Cascadia Code", monospace',
                        padding: '2px 4px',
                        outline: 'none',
                    }}
                />
                <button
                    onMouseDown={e => { e.preventDefault(); commitManual(); }}
                    title="Add (Enter)"
                    style={{
                        flexShrink: 0,
                        width: 20,
                        height: 20,
                        borderRadius: '50%',
                        border: '1px solid',
                        borderColor: manualExpr.trim() ? '#4ec9b0' : '#2a2a2a',
                        background: manualExpr.trim() ? 'rgba(78,201,176,0.15)' : 'transparent',
                        color: manualExpr.trim() ? '#4ec9b0' : '#333',
                        cursor: manualExpr.trim() ? 'pointer' : 'default',
                        fontSize: 14,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 0,
                        transition: 'all 0.15s',
                    }}
                >+</button>
            </div>
        </div>
    );
};

// Extracts the most relevant part of a compiler/linker error message.
const summarizeMsg = (msg) => {
    if (!msg) return msg;
    const multiDef = msg.match(/multiple definition of [`']([^`']+)[`']/);
    if (multiDef) return `Multiple definition: ${multiDef[1]}`;
    const undefRef = msg.match(/undefined reference to [`']([^`']+)[`']/);
    if (undefRef) return `Undefined reference: ${undefRef[1]}`;
    const gccMsg = msg.match(/:\s*(error|warning|note):\s*(.+)/i);
    if (gccMsg) return `${gccMsg[1].charAt(0).toUpperCase() + gccMsg[1].slice(1)}: ${gccMsg[2].trim()}`;
    const ldMsg = msg.match(/(?:\/[^\s:]+\.(?:c|o|a|h)(?::\d+)?:\s*)+(.+)/);
    if (ldMsg) return ldMsg[1].trim();
    const trimmed = msg.trim();
    if (trimmed.length <= 120) return trimmed;
    return trimmed.slice(0, 117) + '…';
};

const OutputPanel = ({
    logs = [],
    onClearLogs = null,
    watchTable = [],
    onWatchTableUpdate,
    onWatchTableRemove,
    onWatchTableAdd,
    onForceWrite = null,
    liveVariables = null,
    isRunning = false,
    projectStructure = null,
    errorCodeService = null,
}) => {
    const [activeTab, setActiveTab] = useState('messages');
    const [forceModal, setForceModal] = useState(null);
    const [editingId, setEditingId] = useState(null);
    const [editValue, setEditValue] = useState('');
    const [hoveredLog, setHoveredLog] = useState(null);
    const [popupLog, setPopupLog] = useState(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [errorTooltip, setErrorTooltip] = useState(null);
    const logEndRef = useRef(null);
    const editInputRef = useRef(null);
    const addBtnRef = useRef(null);

    useEffect(() => {
        if (['messages', 'warnings', 'errors'].includes(activeTab) && logEndRef.current) {
            logEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs, activeTab]);

    useEffect(() => {
        if (editingId && editInputRef.current) {
            editInputRef.current.focus();
            editInputRef.current.select();
        }
    }, [editingId]);

    // Close picker when switching tabs
    useEffect(() => {
        if (activeTab !== 'watch') setPickerOpen(false);
    }, [activeTab]);

    const filtered = {
        messages: logs.filter(l => l.type === 'info' || l.type === 'success'),
        warnings: logs.filter(l => l.type === 'warning'),
        errors:   logs.filter(l => l.type === 'error'),
    };

    const TABS = [
        { key: 'messages', label: 'Messages', badge: filtered.messages.length, badgeColor: '#4ec9b0' },
        { key: 'warnings', label: 'Warnings', badge: filtered.warnings.length, badgeColor: '#e5a64a' },
        { key: 'errors',   label: 'Errors',   badge: filtered.errors.length,   badgeColor: '#f14c4c' },
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
        padding: '5px 14px',
        background: 'transparent',
        border: 'none',
        borderBottom: activeTab === key ? '2px solid #007acc' : '2px solid transparent',
        color: activeTab === key ? '#e8e8e8' : '#666',
        fontSize: 11,
        fontWeight: activeTab === key ? '600' : '400',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
        outline: 'none',
        transition: 'color 0.15s',
        userSelect: 'none',
    });

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#141414', position: 'relative' }}>

            {/* ── Tab bar ── */}
            <div style={{
                display: 'flex',
                background: '#1a1a1a',
                borderBottom: '1px solid #2a2a2a',
                overflowX: 'auto',
                flexShrink: 0,
                alignItems: 'center',
                position: 'relative',
            }}>
                {TABS.map(tab => (
                    <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={tabStyle(tab.key)}>
                        {tab.label}
                        {tab.badge != null && tab.badge > 0 && (
                            <span style={{
                                background: tab.badgeColor,
                                color: '#fff',
                                borderRadius: 2,
                                padding: '1px 5px',
                                fontSize: 10,
                                fontWeight: '700',
                                lineHeight: '14px',
                                minWidth: 16,
                                textAlign: 'center',
                                display: 'inline-block',
                                letterSpacing: '0',
                            }}>
                                {tab.badge > 999 ? '999+' : tab.badge}
                            </span>
                        )}
                    </button>
                ))}

                {/* Right side actions */}
                <div style={{ marginLeft: 'auto', marginRight: 6, display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>

                    {/* Clear button — log tabs only */}
                    {onClearLogs && ['messages', 'warnings', 'errors'].includes(activeTab) && (
                        <button
                            onClick={() => onClearLogs(activeTab)}
                            title={`Clear ${activeTab}`}
                            style={{
                                background: 'transparent',
                                border: '1px solid #3a3a3a',
                                borderRadius: 3,
                                color: '#666',
                                fontSize: 10,
                                padding: '2px 8px',
                                cursor: 'pointer',
                                letterSpacing: '0.04em',
                                textTransform: 'uppercase',
                                whiteSpace: 'nowrap',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.color = '#ccc'; e.currentTarget.style.borderColor = '#555'; }}
                            onMouseLeave={e => { e.currentTarget.style.color = '#666'; e.currentTarget.style.borderColor = '#3a3a3a'; }}
                        >
                            Clear
                        </button>
                    )}

                    {/* Add variable button — watch tab only */}
                    {activeTab === 'watch' && (
                        <div style={{ position: 'relative' }} ref={addBtnRef}>
                            <button
                                onClick={() => setPickerOpen(o => !o)}
                                title="Add variable to watch"
                                style={{
                                    width: 22,
                                    height: 22,
                                    borderRadius: '50%',
                                    border: 'none',
                                    background: pickerOpen ? '#005fa3' : '#007acc',
                                    color: '#fff',
                                    fontSize: 16,
                                    fontWeight: 'bold',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    padding: 0,
                                    lineHeight: 1,
                                    boxShadow: pickerOpen ? '0 0 0 2px rgba(0,122,204,0.4)' : 'none',
                                    transition: 'background 0.12s, box-shadow 0.12s',
                                    flexShrink: 0,
                                }}
                                onMouseEnter={e => { if (!pickerOpen) e.currentTarget.style.background = '#005fa3'; }}
                                onMouseLeave={e => { if (!pickerOpen) e.currentTarget.style.background = '#007acc'; }}
                            >
                                +
                            </button>

                            {/* Variable picker dropdown */}
                            {pickerOpen && (
                                <WatchVariablePicker
                                    projectStructure={projectStructure}
                                    liveVariables={liveVariables}
                                    watchTable={watchTable}
                                    onAdd={entry => { onWatchTableAdd && onWatchTableAdd(entry); }}
                                    onClose={() => setPickerOpen(false)}
                                />
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* ── Log content ── */}
            {activeTab !== 'watch' && (
                <div style={{
                    flex: 1,
                    overflowY: 'auto',
                    fontFamily: '"Consolas", "Cascadia Code", monospace',
                    fontSize: 12,
                }}>
                    {filtered[activeTab].length === 0 ? (
                        <div style={{
                            color: '#3a3a3a',
                            padding: '12px 12px',
                            fontSize: 11,
                            fontStyle: 'italic',
                            letterSpacing: '0.03em',
                        }}>
                            No {activeTab}.
                        </div>
                    ) : (
                        filtered[activeTab].map((log, i) => {
                            const color = LOG_COLORS[log.type] || '#c8c8c8';
                            const icon  = LOG_ICONS[log.type]  || '●';
                            const bgHov = LOG_BG_HOVER[log.type] || 'rgba(200,200,200,0.05)';
                            const isHovered = hoveredLog === i;
                            const summary = summarizeMsg(log.msg);
                            return (
                                <div
                                    key={i}
                                    title="Double-click to see full message"
                                    onMouseEnter={() => setHoveredLog(i)}
                                    onMouseLeave={() => setHoveredLog(null)}
                                    onDoubleClick={() => setPopupLog(log)}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 7,
                                        padding: '3px 10px',
                                        borderBottom: '1px solid #1e1e1e',
                                        background: isHovered ? bgHov : 'transparent',
                                        cursor: 'default',
                                        transition: 'background 0.1s',
                                        minWidth: 0,
                                    }}
                                >
                                    <span style={{
                                        color,
                                        fontSize: log.type === 'warning' ? 9 : 8,
                                        flexShrink: 0,
                                        lineHeight: 1,
                                    }}>
                                        {icon}
                                    </span>
                                    <span style={{
                                        color,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        flex: 1,
                                        lineHeight: '18px',
                                    }}>
                                        {summary}
                                    </span>
                                </div>
                            );
                        })
                    )}
                    <div ref={logEndRef} />
                </div>
            )}

            {/* ── Watchtable ── */}
            {activeTab === 'watch' && (
                <div style={{ flex: 1, overflowY: 'auto' }}>
                    {watchTable.length === 0 ? (
                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            height: '100%',
                            gap: 12,
                            color: '#3a3a3a',
                            fontFamily: '"Consolas", "Cascadia Code", monospace',
                            fontSize: 12,
                        }}>
                            <span style={{ fontSize: 28, opacity: 0.3 }}>◈</span>
                            <span style={{ fontStyle: 'italic', fontSize: 11 }}>Watch table is empty.</span>
                            <span style={{ fontSize: 10, color: '#2a2a2a' }}>
                                Click the <span style={{ color: '#007acc', fontWeight: 'bold' }}>+</span> button above to add variables from any POU.
                            </span>
                        </div>
                    ) : (
                        <table style={{
                            width: '100%',
                            borderCollapse: 'collapse',
                            fontSize: 12,
                            color: '#ccc',
                            fontFamily: '"Consolas", "Cascadia Code", monospace',
                        }}>
                            <thead>
                                <tr style={{ background: '#1a1a1a', position: 'sticky', top: 0, zIndex: 1 }}>
                                    <th style={{ padding: '5px 10px', borderBottom: '1px solid #2a2a2a', textAlign: 'left', fontWeight: '600', color: '#555', fontSize: 10, letterSpacing: '0.07em', textTransform: 'uppercase' }}>Expression</th>
                                    <th style={{ padding: '5px 10px', borderBottom: '1px solid #2a2a2a', textAlign: 'left', fontWeight: '600', color: '#555', fontSize: 10, letterSpacing: '0.07em', textTransform: 'uppercase' }}>Type</th>
                                    <th style={{ padding: '5px 10px', borderBottom: '1px solid #2a2a2a', textAlign: 'left', fontWeight: '600', color: '#555', fontSize: 10, letterSpacing: '0.07em', textTransform: 'uppercase' }}>Live Value</th>
                                    <th style={{ padding: '5px 4px', borderBottom: '1px solid #2a2a2a', width: 28 }}></th>
                                    <th style={{ padding: '5px 4px', borderBottom: '1px solid #2a2a2a', width: 28 }}></th>
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
                                            borderBottom: '1px solid #1e1e1e',
                                            background: isInvalid ? 'rgba(241,76,76,0.06)' : 'transparent',
                                        }}>
                                            <td style={{ padding: '3px 10px' }}>
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
                                                            background: '#1e1e1e',
                                                            border: '1px solid #007acc',
                                                            color: '#90caf9',
                                                            fontSize: 12,
                                                            fontFamily: 'inherit',
                                                            padding: '1px 5px',
                                                            width: '100%',
                                                            outline: 'none',
                                                            borderRadius: 0,
                                                        }}
                                                    />
                                                ) : (
                                                    <span
                                                        onClick={() => { setEditingId(entry.id); setEditValue(entry.displayName); }}
                                                        title={`${entry.displayName} — click to edit`}
                                                        style={{
                                                            color: isInvalid ? '#f14c4c' : '#7eb8f7',
                                                            cursor: 'text',
                                                            display: 'block',
                                                            overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                            whiteSpace: 'nowrap',
                                                            padding: '1px 0',
                                                        }}
                                                    >
                                                        {entry.displayName}
                                                    </span>
                                                )}
                                            </td>
                                            <td style={{ padding: '3px 10px', color: isInvalid ? '#f14c4c' : '#b07040', whiteSpace: 'nowrap' }}>
                                                {entry.varType || '—'}
                                            </td>
                                            <td style={{ padding: '3px 10px', position: 'relative' }}
                                                onMouseEnter={(e) => {
                                                    if (!errorCodeService || !hasVal || isInvalid) return;
                                                    const numVal = typeof val === 'number' ? val : parseInt(val);
                                                    if (!numVal || numVal === 0) return;
                                                    const errField = ErrorCodeService.getErrorFieldName(entry.displayName);
                                                    if (!errField) return;
                                                    const blockType = ErrorCodeService.resolveBlockType(entry.liveKey, errField, projectStructure);
                                                    if (!blockType) return;
                                                    const info = errorCodeService.lookup(blockType, numVal);
                                                    if (!info) return;
                                                    const rect = e.currentTarget.getBoundingClientRect();
                                                    setErrorTooltip({ x: rect.left, y: rect.top - 4, text: `[${info.name}] ${info.text}`, entryId: entry.id });
                                                }}
                                                onMouseLeave={() => {
                                                    if (errorTooltip?.entryId === entry.id) setErrorTooltip(null);
                                                }}
                                            >
                                                <span style={{
                                                    color: isInvalid ? '#f14c4c' : hasVal ? '#4ec9b0' : '#3a3a3a',
                                                    fontWeight: hasVal && !isInvalid ? '700' : '400',
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
                                                        color: isRunning && onForceWrite && !isInvalid ? '#4fc3f7' : '#333',
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
                                                        color: '#8b2020',
                                                        cursor: 'pointer',
                                                        fontSize: 12,
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

            {/* Error Code Tooltip */}
            {errorTooltip && (
                <div style={{
                    position: 'fixed',
                    left: errorTooltip.x,
                    top: errorTooltip.y,
                    transform: 'translateY(-100%)',
                    background: '#2d2d2d',
                    border: '1px solid #555',
                    borderRadius: 4,
                    padding: '5px 10px',
                    color: '#f0a050',
                    fontSize: 11,
                    fontFamily: '"Consolas", "Cascadia Code", monospace',
                    maxWidth: 400,
                    zIndex: 9999,
                    pointerEvents: 'none',
                    boxShadow: '0 3px 12px rgba(0,0,0,0.5)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                }}>
                    {errorTooltip.text}
                </div>
            )}

            {/* Full Message Popup */}
            {popupLog && (
                <div
                    onClick={() => setPopupLog(null)}
                    style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'rgba(0,0,0,0.6)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 200,
                    }}
                >
                    <div
                        onClick={e => e.stopPropagation()}
                        style={{
                            background: '#1e1e1e',
                            border: '1px solid #3a3a3a',
                            borderRadius: 4,
                            maxWidth: '80%',
                            maxHeight: '60%',
                            display: 'flex',
                            flexDirection: 'column',
                            minWidth: 320,
                        }}
                    >
                        <div style={{
                            padding: '6px 12px',
                            borderBottom: '1px solid #2a2a2a',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                        }}>
                            <span style={{
                                color: LOG_COLORS[popupLog.type] || '#c8c8c8',
                                fontSize: 11,
                                fontWeight: '600',
                                textTransform: 'uppercase',
                                letterSpacing: '0.06em',
                            }}>
                                {popupLog.type}
                            </span>
                            <button
                                onClick={() => setPopupLog(null)}
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: '#666',
                                    cursor: 'pointer',
                                    fontSize: 14,
                                    lineHeight: 1,
                                    padding: '0 2px',
                                }}
                            >✕</button>
                        </div>
                        <pre style={{
                            margin: 0,
                            padding: '10px 14px',
                            overflowY: 'auto',
                            overflowX: 'auto',
                            color: LOG_COLORS[popupLog.type] || '#c8c8c8',
                            fontFamily: '"Consolas", "Cascadia Code", monospace',
                            fontSize: 12,
                            lineHeight: '1.6',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            flex: 1,
                        }}>
                            {popupLog.msg}
                        </pre>
                    </div>
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
