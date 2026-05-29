import { useState, useCallback, useEffect, useRef } from 'react';

import HmiToolbox from './HmiToolbox';
import HmiCanvas from './HmiCanvas';
import HmiProperties from './HmiProperties';
import HmiAuthPanel from './HmiAuthPanel';
import { COMPONENT_DEFS } from './hmiComponentDefs';

let _idCounter = 1;
const newId = () => `hmi_${Date.now()}_${_idCounter++}`;

const newPage = (name) => ({ id: newId(), name, components: [], canvasW: 1280, canvasH: 800 });

const VisualizationEditor = ({
    hmiLayout,
    onLayoutChange,
    liveVariables = null,
    onForceWrite = null,
    projectStructure = null,
}) => {
    const [currentPageIdx, setCurrentPageIdx] = useState(0);
    const [selectedId, setSelectedId]         = useState(null);
    const [isPreview, setIsPreview]           = useState(false);
    const [renamingPage, setRenamingPage]     = useState(null); // pageId | null
    const [renameVal, setRenameVal]           = useState('');
    const [activeView, setActiveView]         = useState('editor'); // 'editor' | 'auth'
    const [propsWidth, setPropsWidth]         = useState(240);
    const resizingRef                         = useRef(false);
    const resizeStartX                        = useRef(0);
    const resizeStartW                        = useRef(240);

    const pages = hmiLayout?.pages || [];
    const page  = pages[currentPageIdx] || pages[0] || null;

    /* ── Init with one empty page if none ─────────────────── */
    useEffect(() => {
        if (!hmiLayout || !hmiLayout.pages || hmiLayout.pages.length === 0) {
            onLayoutChange({ pages: [newPage('Page 1')] });
        }
    }, []); // eslint-disable-line

    /* ── Helpers ────────────────────────────────────────────── */
    const updatePages = useCallback((newPages) => {
        onLayoutChange({ ...hmiLayout, pages: newPages });
    }, [hmiLayout, onLayoutChange]);

    const updateCurrentPage = useCallback((patch) => {
        updatePages(pages.map((p, i) => i === currentPageIdx ? { ...p, ...patch } : p));
    }, [pages, currentPageIdx, updatePages]);

    const updateComponents = useCallback((newComponents) => {
        updateCurrentPage({ components: newComponents });
    }, [updateCurrentPage]);

    /* ── Page management ────────────────────────────────────── */
    const addPage = () => {
        const pg = newPage(`Page ${pages.length + 1}`);
        updatePages([...pages, pg]);
        setCurrentPageIdx(pages.length);
        setSelectedId(null);
    };

    const deletePage = (idx) => {
        if (pages.length <= 1) return;
        const newPages = pages.filter((_, i) => i !== idx);
        updatePages(newPages);
        setCurrentPageIdx(Math.min(idx, newPages.length - 1));
        setSelectedId(null);
    };

    const startRenamePage = (pageId, name) => {
        setRenamingPage(pageId);
        setRenameVal(name);
    };
    const commitRenamePage = () => {
        if (!renameVal.trim()) { setRenamingPage(null); return; }
        updatePages(pages.map(p => p.id === renamingPage ? { ...p, name: renameVal.trim() } : p));
        setRenamingPage(null);
    };

    /* ── Canvas operations ──────────────────────────────────── */
    const handleDrop = useCallback((type, x, y) => {
        const def = COMPONENT_DEFS[type];
        if (!def) return;
        const comp = {
            id: newId(),
            type,
            x, y,
            w: def.defaultSize.w,
            h: def.defaultSize.h,
            props: { ...def.defaultProps },
        };
        updateComponents([...(page?.components || []), comp]);
        setSelectedId(comp.id);
    }, [page, updateComponents]);

    const handleMove = useCallback((id, x, y) => {
        updateComponents((page?.components || []).map(c => c.id === id ? { ...c, x, y } : c));
    }, [page, updateComponents]);

    const handleResize = useCallback((id, x, y, w, h) => {
        updateComponents((page?.components || []).map(c => c.id === id ? { ...c, x, y, w, h } : c));
    }, [page, updateComponents]);

    const handleDelete = useCallback((id) => {
        updateComponents((page?.components || []).filter(c => c.id !== id));
        if (selectedId === id) setSelectedId(null);
    }, [page, updateComponents, selectedId]);

    const handleUpdateComponent = useCallback((id, patch) => {
        updateComponents((page?.components || []).map(c => c.id === id ? { ...c, ...patch } : c));
    }, [page, updateComponents]);

    const selectedComp = page?.components?.find(c => c.id === selectedId) || null;

    /* ── Canvas size controls ────────────────────────────────── */
    const canvasW = page?.canvasW || 1280;
    const canvasH = page?.canvasH || 800;

    /* ── Duplicate selected ─────────────────────────────────── */
    const handleDuplicate = useCallback(() => {
        if (!selectedComp) return;
        const dup = { ...selectedComp, id: newId(), x: selectedComp.x + 20, y: selectedComp.y + 20 };
        updateComponents([...(page?.components || []), dup]);
        setSelectedId(dup.id);
    }, [selectedComp, page, updateComponents]);

    /* ── Keyboard shortcuts ──────────────────────────────────── */
    useEffect(() => {
        const handler = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
            if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); handleDuplicate(); }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [handleDuplicate]);

    /* ── Props panel resize ──────────────────────────────────── */
    useEffect(() => {
        const onMove = (e) => {
            if (!resizingRef.current) return;
            const dx = resizeStartX.current - e.clientX;
            setPropsWidth(Math.max(160, Math.min(480, resizeStartW.current + dx)));
        };
        const onUp = () => { resizingRef.current = false; document.body.style.cursor = ''; };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    }, []);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#111' }}>

            {/* ── Toolbar ── */}
            <div style={{
                display: 'flex', alignItems: 'center',
                height: 38, flexShrink: 0,
                background: '#1a1a1a',
                borderBottom: '1px solid #2a2a2a',
                gap: 0,
                padding: '0 4px',
            }}>
                {/* Page tabs */}
                <div style={{ display: 'flex', alignItems: 'stretch', gap: 1, flex: 1, overflow: 'hidden', height: '100%' }}>
                    {pages.map((pg, idx) => (
                        <div
                            key={pg.id}
                            style={{
                                display: 'flex', alignItems: 'center',
                                background: idx === currentPageIdx ? '#252525' : 'transparent',
                                borderBottom: idx === currentPageIdx ? '2px solid #007acc' : '2px solid transparent',
                                paddingLeft: 10, paddingRight: 4,
                                cursor: 'pointer',
                                fontSize: 12,
                                color: idx === currentPageIdx ? '#e0e0e0' : '#666',
                                gap: 4,
                                flexShrink: 0,
                                minWidth: 60,
                                position: 'relative',
                            }}
                            onClick={() => { setCurrentPageIdx(idx); setSelectedId(null); }}
                        >
                            {renamingPage === pg.id ? (
                                <input
                                    autoFocus
                                    value={renameVal}
                                    onChange={e => setRenameVal(e.target.value)}
                                    onBlur={commitRenamePage}
                                    onKeyDown={e => { if (e.key === 'Enter') commitRenamePage(); if (e.key === 'Escape') setRenamingPage(null); }}
                                    onClick={e => e.stopPropagation()}
                                    style={{
                                        background: '#252525', border: '1px solid #007acc',
                                        color: '#e0e0e0', fontSize: 12, width: 80,
                                        padding: '1px 4px', outline: 'none',
                                    }}
                                />
                            ) : (
                                <span onDoubleClick={e => { e.stopPropagation(); startRenamePage(pg.id, pg.name); }}>
                                    {pg.name}
                                </span>
                            )}
                            {pages.length > 1 && (
                                <button
                                    onClick={e => { e.stopPropagation(); deletePage(idx); }}
                                    style={{
                                        background: 'none', border: 'none',
                                        color: '#555', fontSize: 12, cursor: 'pointer', padding: '0 2px',
                                        lineHeight: 1,
                                    }}
                                >×</button>
                            )}
                        </div>
                    ))}
                    <button
                        onClick={addPage}
                        title="Add page"
                        style={{
                            background: 'transparent', border: 'none',
                            color: '#555', fontSize: 14, cursor: 'pointer',
                            padding: '0 8px', alignSelf: 'center',
                        }}
                    >+</button>
                </div>

                {/* Separator */}
                <div style={{ width: 1, height: 22, background: '#2a2a2a', margin: '0 8px' }} />

                {/* Canvas size */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#555' }}>
                    <input type="number" value={canvasW} min={400} max={3840} step={10}
                        onChange={e => updateCurrentPage({ canvasW: Number(e.target.value) })}
                        style={{ width: 52, background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#777', fontSize: 11, padding: '2px 4px', textAlign: 'right' }} />
                    <span>×</span>
                    <input type="number" value={canvasH} min={300} max={2160} step={10}
                        onChange={e => updateCurrentPage({ canvasH: Number(e.target.value) })}
                        style={{ width: 52, background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#777', fontSize: 11, padding: '2px 4px', textAlign: 'right' }} />
                </div>

                <div style={{ width: 1, height: 22, background: '#2a2a2a', margin: '0 8px' }} />

                {/* Preview toggle */}
                <button
                    onClick={() => { setIsPreview(v => !v); setSelectedId(null); }}
                    style={{
                        background: isPreview ? '#007acc' : 'transparent',
                        border: `1px solid ${isPreview ? '#007acc' : '#333'}`,
                        color: isPreview ? '#fff' : '#888',
                        fontSize: 11, padding: '3px 10px',
                        cursor: 'pointer', borderRadius: 2,
                        fontWeight: isPreview ? '600' : '400',
                    }}
                >
                    {isPreview ? '▣ Preview' : '▷ Preview'}
                </button>

                {/* Auth view toggle */}
                <button
                    onClick={() => setActiveView(v => v === 'auth' ? 'editor' : 'auth')}
                    style={{
                        background: activeView === 'auth' ? '#1e2a3a' : 'transparent',
                        border: `1px solid ${activeView === 'auth' ? '#007acc' : '#333'}`,
                        color: activeView === 'auth' ? '#7eb8f7' : '#777',
                        fontSize: 11, padding: '3px 10px',
                        cursor: 'pointer', borderRadius: 2, marginLeft: 6,
                        display: 'flex', alignItems: 'center', gap: 5,
                    }}
                >
                    🔐 Auth
                    {(hmiLayout?.auth?.users?.length > 0) && (
                        <span style={{ background: '#2a3a4a', color: '#7eb8f7', fontSize: 9, padding: '0 4px', borderRadius: 2 }}>
                            {hmiLayout.auth.users.length}
                        </span>
                    )}
                </button>

                {/* HMI broadcast port — the deployed HMI is served at
                    http://<plc-ip>:<port>/ (pushed to the target on Build & Send) */}
                <div style={{ width: 1, height: 22, background: '#2a2a2a', margin: '0 8px' }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#555' }}
                    title="HMI broadcast port — served at http://<plc-ip>:<port>/ after Build & Send">
                    <span>🌐 Port</span>
                    <input
                        type="number"
                        min={1024}
                        max={65535}
                        value={hmiLayout?.port ?? 8080}
                        onChange={e => {
                            const n = Math.max(0, Math.min(65535, Number(e.target.value) || 0));
                            onLayoutChange({ ...hmiLayout, port: n });
                        }}
                        style={{ width: 60, background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#7eb8f7', fontSize: 11, padding: '2px 4px', textAlign: 'right', fontFamily: 'monospace' }}
                    />
                </div>

                {/* Duplicate */}
                {selectedComp && !isPreview && activeView === 'editor' && (
                    <button onClick={handleDuplicate} title="Duplicate (Ctrl+D)"
                        style={{ background: 'transparent', border: '1px solid #333', color: '#666', fontSize: 11, padding: '3px 8px', cursor: 'pointer', borderRadius: 2, marginLeft: 4 }}>
                        ⧉
                    </button>
                )}
            </div>

            {/* ── Main area ── */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

                {activeView === 'auth' ? (
                    <HmiAuthPanel hmiLayout={hmiLayout} onLayoutChange={onLayoutChange} />
                ) : (
                    <>
                        {/* Toolbox */}
                        {!isPreview && (
                            <div style={{ width: 156, flexShrink: 0 }}>
                                <HmiToolbox />
                            </div>
                        )}

                        {/* Canvas */}
                        {page ? (
                            <HmiCanvas
                                components={page.components || []}
                                selectedId={selectedId}
                                onSelect={setSelectedId}
                                onDrop={handleDrop}
                                onMove={handleMove}
                                onResize={handleResize}
                                onDelete={handleDelete}
                                liveVariables={liveVariables}
                                onWrite={onForceWrite}
                                projectStructure={projectStructure}
                                isPreview={isPreview}
                                canvasW={canvasW}
                                canvasH={canvasH}
                            />
                        ) : (
                            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333', fontSize: 13 }}>
                                No page — click + to add
                            </div>
                        )}

                        {/* Properties */}
                        {!isPreview && (
                            <>
                                {/* Resize handle */}
                                <div
                                    style={{
                                        width: 4, flexShrink: 0, cursor: 'col-resize',
                                        background: 'transparent',
                                        borderLeft: '1px solid #2a2a2a',
                                        transition: 'background 0.15s',
                                    }}
                                    onMouseEnter={e => e.currentTarget.style.background = '#007acc44'}
                                    onMouseLeave={e => { if (!resizingRef.current) e.currentTarget.style.background = 'transparent'; }}
                                    onMouseDown={e => {
                                        resizingRef.current = true;
                                        resizeStartX.current = e.clientX;
                                        resizeStartW.current = propsWidth;
                                        document.body.style.cursor = 'col-resize';
                                        e.preventDefault();
                                    }}
                                />
                                <div style={{ width: propsWidth, flexShrink: 0 }}>
                                    <HmiProperties
                                        selected={selectedComp}
                                        page={page}
                                        onUpdateComponent={handleUpdateComponent}
                                        projectStructure={projectStructure}
                                    />
                                </div>
                            </>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export default VisualizationEditor;
