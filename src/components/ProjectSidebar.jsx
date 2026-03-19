import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ask } from '@tauri-apps/plugin-dialog';
import { getBoardById } from '../utils/boardDefinitions';
import PlcIcon from '../assets/icons/plc-icon.png';

const EMPTY_IMG = new Image();
EMPTY_IMG.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/* ─── Context Menu ─────────────────────────────────────────────────────────── */

const ContextMenu = ({ x, y, items, onClose }) => {
    const ref = useRef(null);

    useEffect(() => {
        const close = (e) => {
            if (ref.current && !ref.current.contains(e.target)) onClose();
        };
        window.addEventListener('mousedown', close);
        window.addEventListener('contextmenu', close);
        return () => {
            window.removeEventListener('mousedown', close);
            window.removeEventListener('contextmenu', close);
        };
    }, [onClose]);

    return (
        <div
            ref={ref}
            style={{
                position: 'fixed', left: x, top: y, zIndex: 9999,
                background: '#2d2d2d', border: '1px solid #555',
                borderRadius: 4, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                minWidth: 160, padding: '4px 0', fontSize: 12,
            }}
        >
            {items.map((item, i) =>
                item === 'sep' ? (
                    <div key={i} style={{ height: 1, background: '#444', margin: '4px 0' }} />
                ) : (
                    <div
                        key={i}
                        onClick={(e) => { e.stopPropagation(); onClose(); item.action(); }}
                        style={{
                            padding: '6px 16px', cursor: item.disabled ? 'default' : 'pointer',
                            color: item.disabled ? '#555' : item.danger ? '#f44747' : '#ccc',
                            display: 'flex', alignItems: 'center', gap: 8,
                            background: 'transparent',
                        }}
                        onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = '#37373d'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                        <span style={{ width: 14, textAlign: 'center', opacity: item.disabled ? 0.4 : 1 }}>{item.icon}</span>
                        <span>{item.label}</span>
                    </div>
                )
            )}
        </div>
    );
};

/* ─── Hover Insert Zone ────────────────────────────────────────────────────── */

const InsertZone = ({ onInsert, onPaste, canPaste, disabled }) => {
    const [hovered, setHovered] = React.useState(false);
    if (disabled) return <div style={{ height: 3 }} />;
    return (
        <div
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                height: hovered ? 20 : 3, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                position: 'relative', transition: 'height 0.1s ease', margin: '0 6px', gap: 4,
            }}
        >
            {hovered && (
                <>
                    <div style={{ position: 'absolute', left: 0, right: 0, height: 2, background: '#007acc', borderRadius: 1 }} />
                    <div
                        onClick={(e) => { e.stopPropagation(); onInsert(); }}
                        style={{ position: 'relative', zIndex: 1, width: 16, height: 16, background: '#007acc', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, fontWeight: 'bold' }}
                        title={t('actions.addNew')}
                    >+</div>
                    {canPaste && (
                        <div
                            onClick={(e) => { e.stopPropagation(); onPaste?.(); }}
                            style={{ position: 'relative', zIndex: 1, width: 16, height: 16, background: '#4caf50', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 10, fontWeight: 'bold', cursor: 'pointer' }}
                            title="Paste"
                        >📋</div>
                    )}
                </>
            )}
        </div>
    );
};

/* ─── Tree Node (collapsible row) ─────────────────────────────────────────── */

const TreeNode = ({ level = 0, icon, label, isOpen, onToggle, active, onClick, onContextMenu, children, endAdornment, dimmed }) => {
    const indent = level * 14;
    return (
        <div>
            <div
                onClick={onClick}
                onContextMenu={onContextMenu}
                style={{
                    display: 'flex', alignItems: 'center',
                    padding: `4px 8px 4px ${8 + indent}px`,
                    cursor: 'pointer', userSelect: 'none',
                    background: active ? '#37373d' : 'transparent',
                    borderLeft: active ? '2px solid #007acc' : '2px solid transparent',
                    color: active ? '#fff' : dimmed ? '#666' : '#ccc',
                    fontSize: 12,
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#2a2d2e'; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
            >
                {/* Collapse triangle */}
                {onToggle ? (
                    <span
                        onClick={(e) => { e.stopPropagation(); onToggle(); }}
                        style={{ marginRight: 4, fontSize: 9, opacity: 0.7, width: 10, display: 'inline-block', textAlign: 'center' }}
                    >
                        {isOpen ? '▼' : '▶'}
                    </span>
                ) : (
                    <span style={{ marginRight: 4, width: 10, display: 'inline-block' }} />
                )}
                {icon && <span style={{ marginRight: 5, fontSize: 13 }}>{icon}</span>}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                {endAdornment}
            </div>
            {isOpen !== false && children && <div>{children}</div>}
        </div>
    );
};

/* ─── Item type icon ───────────────────────────────────────────────────────── */

const itemIcon = (item) => {
    if (item.type === 'ST') return '📄';
    if (item.type === 'LD') return '🪜';
    if (item.type === 'Array') return <span style={{ fontFamily: 'monospace', fontWeight: 'bold', fontSize: 10, background: '#0e639c', color: '#fff', padding: '1px 3px', borderRadius: 3 }}>[ ]</span>;
    if (item.type === 'Enumerated') return <span style={{ fontFamily: 'monospace', fontWeight: 'bold', fontSize: 10, background: '#68217a', color: '#fff', padding: '1px 3px', borderRadius: 3 }}>(E)</span>;
    if (item.type === 'Structure') return <span style={{ fontFamily: 'monospace', fontWeight: 'bold', fontSize: 10, background: '#b87333', color: '#fff', padding: '1px 3px', borderRadius: 3 }}>{'{ }'}</span>;
    return '📦';
};

/* ─── Bus node icons ───────────────────────────────────────────────────────── */

const BUS_META = {
    ethercat: { label: 'EtherCAT Master', icon: '⬡' },
    canbus:   { label: 'CANbus',          icon: '⬡' },
};

/* ═══════════════════════════════════════════════════════════════════════════ */

const ProjectSidebar = ({
    projectStructure, onSelectItem, activeId,
    onAddItem, onDeleteItem, onEditItem, onReorderItem, onPasteItem,
    onBoardClick, selectedBoard, isRunning = false,
    buses = [], onAddBus, onDeleteBus,
}) => {
    const { t } = useTranslation();

    /* Collapse state */
    const [expanded, setExpanded] = useState({
        plcLogic:       true,
        dataTypes:      true,
        functionBlocks: true,
        functions:      true,
        programs:       true,
    });
    const toggle = (key) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

    /* Drag & drop */
    const [dragItem, setDragItem] = useState(null);
    const [dragEnabled, setDragEnabled] = useState(false);
    const [dragOverIndex, setDragOverIndex] = useState(null);

    /* Clipboard */
    const clipboardRef = useRef(null);
    const [clipboardCategory, setClipboardCategory] = useState(null);

    /* Context menu */
    const [ctxMenu, setCtxMenu] = useState(null); // { x, y, items }
    const closeCtx = useCallback(() => setCtxMenu(null), []);

    const openCtx = (e, items) => {
        e.preventDefault();
        e.stopPropagation();
        setCtxMenu({ x: e.clientX, y: e.clientY, items });
    };

    /* ── Clipboard helpers ── */
    const copyItem = useCallback((category, item) => {
        clipboardRef.current = { category, payload: JSON.parse(JSON.stringify(item)) };
        setClipboardCategory(category);
    }, []);

    const handleSidebarCopy = useCallback(() => {
        if (isRunning || !activeId) return;
        for (const cat of ['dataTypes', 'functions', 'functionBlocks', 'programs']) {
            const item = projectStructure[cat]?.find(i => i.id === activeId);
            if (item) { copyItem(cat, item); return; }
        }
    }, [isRunning, activeId, projectStructure, copyItem]);

    const handleSidebarPaste = useCallback((targetCategory, insertIndex) => {
        if (isRunning || !clipboardRef.current) return;
        const clip = clipboardRef.current;
        if (clip.category !== targetCategory) return;
        const src = clip.payload;
        const ts = Date.now();
        const newItem = {
            ...src, id: `${targetCategory}_${ts}`,
            name: `${src.name}_copy`,
            content: JSON.parse(JSON.stringify(src.content || {})),
        };
        onPasteItem?.(targetCategory, newItem, insertIndex);
    }, [isRunning, onPasteItem]);

    /* Ctrl+C / Ctrl+V */
    useEffect(() => {
        const handler = (e) => {
            if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
            if (!(e.ctrlKey || e.metaKey)) return;
            if (e.key.toLowerCase() === 'c') handleSidebarCopy();
            else if (e.key.toLowerCase() === 'v') {
                if (!clipboardRef.current) return;
                const cat = clipboardRef.current.category;
                handleSidebarPaste(cat, projectStructure[cat]?.length || 0);
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [handleSidebarCopy, handleSidebarPaste, projectStructure]);

    /* ── Delete with confirm ── */
    const handleDelete = useCallback(async (category, item) => {
        if (isRunning) return;
        const confirmed = await ask(
            t('messages.confirmDelete', { name: item.name }),
            { title: t('common.delete'), type: 'warning' }
        );
        if (confirmed) onDeleteItem(category, item.id);
    }, [isRunning, onDeleteItem, t]);

    /* ── Context menu builders ── */
    const itemCtxItems = (category, item, insertIndex) => [
        {
            icon: '✎', label: t('common.rename'),
            disabled: isRunning,
            action: () => !isRunning && onEditItem?.(category, item.id),
        },
        {
            icon: '📋', label: 'Copy',
            disabled: isRunning,
            action: () => !isRunning && copyItem(category, item),
        },
        ...(clipboardCategory === category ? [{
            icon: '📄', label: 'Paste',
            disabled: isRunning,
            action: () => handleSidebarPaste(category, insertIndex),
        }] : []),
        'sep',
        {
            icon: '🗑', label: t('common.delete'), danger: true,
            disabled: isRunning,
            action: () => handleDelete(category, item),
        },
    ];

    const categoryCtxItems = (category, items) => [
        {
            icon: '+', label: t('actions.addNew'),
            disabled: isRunning,
            action: () => !isRunning && onAddItem(category, items.length),
        },
        ...(clipboardCategory === category ? [{
            icon: '📄', label: 'Paste',
            disabled: isRunning,
            action: () => handleSidebarPaste(category, items.length),
        }] : []),
    ];

    const deviceCtxItems = () => {
        const hasBus = (type) => buses.some(b => b.type === type);
        return [
            {
                icon: '⬡', label: `${t('actions.add')} EtherCAT Master`,
                disabled: isRunning || hasBus('ethercat'),
                action: () => !isRunning && !hasBus('ethercat') && onAddBus?.('ethercat'),
            },
            {
                icon: '⬡', label: `${t('actions.add')} CANbus`,
                disabled: isRunning || hasBus('canbus'),
                action: () => !isRunning && !hasBus('canbus') && onAddBus?.('canbus'),
            },
        ];
    };

    /* ─── Category section renderer ─────────────────────────────────────────── */
    const renderCategory = (title, key, items) => (
        <TreeNode
            level={2}
            icon={null}
            label={title}
            isOpen={expanded[key]}
            onToggle={() => toggle(key)}
            onContextMenu={(e) => openCtx(e, categoryCtxItems(key, items))}
        >
            <div
                onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget)) setDragOverIndex(null);
                }}
            >
                <InsertZone
                    onInsert={() => onAddItem(key, 0)}
                    onPaste={() => handleSidebarPaste(key, 0)}
                    canPaste={clipboardCategory === key}
                    disabled={isRunning || !!dragItem}
                />
                {items.map((item, index) => {
                    const isBeingDragged = dragItem?.category === key && item.id === dragItem.id;
                    const showLineAbove = dragItem?.category === key && dragOverIndex === index;

                    return (
                        <React.Fragment key={item.id}>
                            <div
                                draggable={!isRunning && dragEnabled}
                                onDragStart={(e) => {
                                    if (isRunning || !dragEnabled) { e.preventDefault(); return; }
                                    setDragItem({ category: key, index: items.findIndex(i => i.id === item.id), id: item.id });
                                    e.dataTransfer.setData('text/plain', item.id);
                                    e.dataTransfer.effectAllowed = 'move';
                                    e.dataTransfer.setDragImage?.(EMPTY_IMG, 0, 0);
                                }}
                                onDragEnd={() => { setDragItem(null); setDragEnabled(false); setDragOverIndex(null); }}
                                onDragOver={(e) => {
                                    if (isRunning || !dragItem || dragItem.category !== key) return;
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = 'move';
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const insertIndex = e.clientY < rect.top + rect.height / 2 ? index : index + 1;
                                    if (insertIndex !== dragOverIndex) setDragOverIndex(insertIndex);
                                }}
                                onDrop={(e) => {
                                    if (isRunning) return;
                                    e.preventDefault();
                                    if (!dragItem || dragItem.category !== key || dragOverIndex === null) { setDragItem(null); setDragOverIndex(null); return; }
                                    const src = dragItem.index;
                                    const dst = dragOverIndex;
                                    if (dst !== src && dst !== src + 1) {
                                        onReorderItem(key, src, dst > src ? dst - 1 : dst);
                                    }
                                    setDragItem(null); setDragEnabled(false); setDragOverIndex(null);
                                }}
                                onClick={() => onSelectItem(key, item.id)}
                                onContextMenu={(e) => openCtx(e, itemCtxItems(key, item, index + 1))}
                                style={{
                                    padding: '5px 8px 5px 42px',
                                    cursor: 'pointer',
                                    background: activeId === item.id ? '#37373d' : 'transparent',
                                    borderLeft: activeId === item.id ? '2px solid #007acc' : '2px solid transparent',
                                    borderTop: showLineAbove ? '2px solid #007acc' : '2px solid transparent',
                                    color: activeId === item.id ? '#fff' : '#ccc',
                                    fontSize: 12,
                                    display: 'flex', alignItems: 'center', gap: 6,
                                    opacity: isBeingDragged ? 0.4 : 1,
                                }}
                            >
                                {/* Drag handle */}
                                <div
                                    onMouseEnter={() => { if (!isRunning) setDragEnabled(true); }}
                                    onMouseLeave={() => setDragEnabled(false)}
                                    style={{
                                        display: 'grid', gridTemplateColumns: 'repeat(2, 2px)', gap: '2px',
                                        padding: '4px', cursor: isRunning ? 'not-allowed' : 'grab',
                                        opacity: isRunning ? 0.2 : 0.5,
                                    }}
                                    title="Drag"
                                >
                                    {[...Array(6)].map((_, i) => (
                                        <div key={i} style={{ width: 2, height: 2, background: '#ccc', borderRadius: '50%' }} />
                                    ))}
                                </div>
                                <span>{itemIcon(item)}</span>
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {item.name}
                                </span>
                                {key === 'programs' && item.cycleTime && (
                                    <span style={{ fontSize: 10, color: '#888' }}>[{item.cycleTime}]</span>
                                )}
                                {item.type && (
                                    <span style={{ fontSize: 9, color: '#666', border: '1px solid #444', padding: '0 2px', borderRadius: 2 }}>
                                        {item.type}
                                    </span>
                                )}
                            </div>

                            {index < items.length - 1 && (
                                <InsertZone
                                    onInsert={() => onAddItem(key, index + 1)}
                                    onPaste={() => handleSidebarPaste(key, index + 1)}
                                    canPaste={clipboardCategory === key}
                                    disabled={isRunning || !!dragItem}
                                />
                            )}
                        </React.Fragment>
                    );
                })}

                {/* Bottom drop zone */}
                <div
                    style={{ minHeight: dragItem ? 16 : 0 }}
                    onDragOver={(e) => {
                        if (isRunning || !dragItem || dragItem.category !== key) return;
                        e.preventDefault(); e.stopPropagation();
                        if (dragOverIndex !== items.length) setDragOverIndex(items.length);
                    }}
                    onDrop={(e) => {
                        if (isRunning || !dragItem || dragItem.category !== key) return;
                        e.preventDefault();
                        const src = dragItem.index, dst = items.length;
                        if (dst !== src && dst !== src + 1) onReorderItem(key, src, dst > src ? dst - 1 : dst);
                        setDragItem(null); setDragEnabled(false); setDragOverIndex(null);
                    }}
                >
                    {dragItem?.category === key && dragOverIndex === items.length && (
                        <div style={{ height: 2, background: '#007acc', margin: '0 15px', borderRadius: 1 }} />
                    )}
                </div>

                {!isRunning && (
                    <div
                        onClick={() => onAddItem(key, items.length)}
                        style={{ display: 'flex', justifyContent: 'center', padding: '3px 0', cursor: 'pointer', opacity: 0.4 }}
                        onMouseEnter={e => e.currentTarget.style.opacity = 1}
                        onMouseLeave={e => e.currentTarget.style.opacity = 0.4}
                        title={t('modals.create')}
                    >
                        <div style={{ width: 16, height: 16, background: '#007acc', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, fontWeight: 'bold' }}>+</div>
                    </div>
                )}
            </div>
        </TreeNode>
    );

    /* ─── Render ─────────────────────────────────────────────────────────────── */

    const boardName = selectedBoard ? (getBoardById(selectedBoard)?.name || selectedBoard) : 'PLC Project';
    const globalItem = projectStructure.resources?.[0];

    return (
        <div style={{ height: '100%', overflowY: 'auto', background: '#252526', borderRight: '1px solid #333', display: 'flex', flexDirection: 'column' }}>

            {/* ── Device root node ── */}
            <TreeNode
                level={0}
                icon="🖥"
                label={boardName}
                isOpen={true}
                onContextMenu={(e) => openCtx(e, deviceCtxItems())}
                endAdornment={
                    <span
                        onClick={(e) => { e.stopPropagation(); onBoardClick?.(); }}
                        style={{ fontSize: 10, opacity: 0.5, marginLeft: 4, padding: '1px 4px', borderRadius: 3, border: '1px solid #555', cursor: 'pointer' }}
                        title="Board ayarla"
                        onMouseEnter={e => e.currentTarget.style.opacity = 1}
                        onMouseLeave={e => e.currentTarget.style.opacity = 0.5}
                    >⚙</span>
                }
            >

                {/* ── PLC Logic ── */}
                <TreeNode
                    level={1}
                    icon="🔷"
                    label="PLC Logic"
                    isOpen={expanded.plcLogic}
                    onToggle={() => toggle('plcLogic')}
                >
                    {/* Global Variables */}
                    <TreeNode
                        level={2}
                        icon="⚙️"
                        label={t('sidebar.global') || 'Global Variables'}
                        active={activeId === globalItem?.id}
                        onClick={() => globalItem && onSelectItem('resources', globalItem.id)}
                    />

                    {renderCategory(t('sidebar.dataTypes') || 'Data Types',      'dataTypes',      projectStructure.dataTypes)}
                    {renderCategory(t('sidebar.functions') || 'Functions',        'functions',       projectStructure.functions)}
                    {renderCategory(t('sidebar.functionBlocks') || 'Function Blocks', 'functionBlocks', projectStructure.functionBlocks)}
                    {renderCategory(t('sidebar.programs') || 'Programs',          'programs',        projectStructure.programs)}
                </TreeNode>

                {/* ── Optional Bus nodes ── */}
                {buses.map(bus => {
                    const meta = BUS_META[bus.type] || { label: bus.type, icon: '⬡' };
                    return (
                        <TreeNode
                            key={bus.id}
                            level={1}
                            icon={meta.icon}
                            label={meta.label}
                            isOpen={false}
                            onToggle={() => {}} // future: bus sub-nodes
                            onContextMenu={(e) => openCtx(e, [
                                {
                                    icon: '🗑', label: 'Kaldır', danger: true,
                                    disabled: isRunning,
                                    action: () => !isRunning && onDeleteBus?.(bus.id),
                                }
                            ])}
                            dimmed
                        />
                    );
                })}

                {/* Add bus button — only when no buses yet */}
                {!isRunning && buses.length === 0 && (
                    <div
                        onContextMenu={(e) => openCtx(e, deviceCtxItems())}
                        style={{ paddingLeft: 28, paddingBottom: 4 }}
                    >
                        <div
                            onClick={(e) => openCtx(e, deviceCtxItems())}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#555', cursor: 'pointer', padding: '2px 6px' }}
                            onMouseEnter={e => e.currentTarget.style.color = '#888'}
                            onMouseLeave={e => e.currentTarget.style.color = '#555'}
                            title={`${t('actions.add')} Fieldbus (${t('common.rightClick')})`}
                        >
                            <span>+</span><span>{`${t('actions.add')} Fieldbus`}</span>
                        </div>
                    </div>
                )}
            </TreeNode>

            {/* Context menu */}
            {ctxMenu && (
                <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={closeCtx} />
            )}
        </div>
    );
};

export default ProjectSidebar;
