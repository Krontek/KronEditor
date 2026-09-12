import { useRef, useCallback, useMemo } from 'react';
import HmiComponentRenderer from './HmiComponentRenderer';
import { COMPONENT_DEFS } from './hmiComponentDefs';
import { liveGet, liveResolveKey } from '../../utils/iecNames';

const GRID = 10;
const snap = v => Math.round(v / GRID) * GRID;

/* Resolve variable expression to a live key */
const resolveVar = (expr, projectStructure) => {
    if (!expr || !projectStructure) return expr || null;
    const trimmed = expr.trim();
    const dotIdx  = trimmed.indexOf('.');
    if (dotIdx > 0) {
        const prog   = trimmed.slice(0, dotIdx).trim().replace(/\s+/g, '_');
        const varN   = trimmed.slice(dotIdx + 1).trim().replace(/\s+/g, '_');
        return `prog_${prog}_${varN}`;
    }
    return trimmed.replace(/\s+/g, '_');
};

/* 8-directional resize handles */
const HANDLES = ['nw','n','ne','e','se','s','sw','w'];
const HANDLE_CURSORS = { nw:'nw-resize', n:'n-resize', ne:'ne-resize', e:'e-resize', se:'se-resize', s:'s-resize', sw:'sw-resize', w:'w-resize' };

const handleStyle = (pos, sz) => {
    const S = sz; const H = S / 2;
    const base = { position: 'absolute', width: S, height: S, background: '#007acc', border: '1px solid #003d66', zIndex: 20 };
    const map = {
        nw: { top: -H, left: -H },  n: { top: -H, left: `calc(50% - ${H}px)` },  ne: { top: -H, right: -H },
        e:  { top: `calc(50% - ${H}px)`, right: -H },
        se: { bottom: -H, right: -H }, s: { bottom: -H, left: `calc(50% - ${H}px)` }, sw: { bottom: -H, left: -H },
        w:  { top: `calc(50% - ${H}px)`, left: -H },
    };
    return { ...base, ...map[pos] };
};

const HmiCanvas = ({
    components = [],
    selectedId,
    onSelect,
    onDrop,
    onMove,
    onResize,
    onDelete,
    liveVariables = null,
    onWrite,
    projectStructure = null,
    isPreview = false,
    canvasW = 1280,
    canvasH = 800,
}) => {
    const canvasRef  = useRef(null);
    const stateRef   = useRef({ drag: null, resize: null }); // mutable interaction state

    /* ── Drag-from-toolbox drop ─────────────────────────────── */
    const handleDragOver = useCallback(e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    }, []);

    const handleDrop = useCallback(e => {
        e.preventDefault();
        const type = e.dataTransfer.getData('hmiComponentType');
        if (!type || !COMPONENT_DEFS[type]) return;
        const rect = canvasRef.current.getBoundingClientRect();
        const x = snap(e.clientX - rect.left + canvasRef.current.parentElement.scrollLeft);
        const y = snap(e.clientY - rect.top  + canvasRef.current.parentElement.scrollTop);
        onDrop(type, x, y);
    }, [onDrop]);

    /* ── Component mouse-down (start move or just select) ────── */
    const handleCompMouseDown = useCallback((e, id) => {
        if (isPreview) return;
        e.stopPropagation();
        onSelect(id);
        const comp = components.find(c => c.id === id);
        if (!comp) return;
        stateRef.current.drag = {
            id,
            startMouseX: e.clientX, startMouseY: e.clientY,
            origX: comp.x, origY: comp.y,
            moved: false,
        };

        const onMove = (ev) => {
            const d = stateRef.current.drag;
            if (!d) return;
            const dx = ev.clientX - d.startMouseX;
            const dy = ev.clientY - d.startMouseY;
            if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
            d.moved = true;
            onMove && onMove(d.id, snap(d.origX + dx), snap(d.origY + dy));
        };
        const onUp = () => {
            stateRef.current.drag = null;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [isPreview, components, onSelect, onMove]);

    /* ── Resize handle mouse-down ────────────────────────────── */
    const handleResizeMouseDown = useCallback((e, id, handle) => {
        e.stopPropagation();
        const comp = components.find(c => c.id === id);
        if (!comp) return;
        stateRef.current.resize = {
            id, handle,
            startMouseX: e.clientX, startMouseY: e.clientY,
            origX: comp.x, origY: comp.y, origW: comp.w, origH: comp.h,
        };

        const onMouseMove = (ev) => {
            const r = stateRef.current.resize;
            if (!r) return;
            const dx = ev.clientX - r.startMouseX;
            const dy = ev.clientY - r.startMouseY;
            let { origX: x, origY: y, origW: w, origH: h } = r;

            if (r.handle.includes('e')) w = Math.max(GRID * 2, snap(w + dx));
            if (r.handle.includes('s')) h = Math.max(GRID * 2, snap(h + dy));
            if (r.handle.includes('w')) { const nw = Math.max(GRID * 2, snap(w - dx)); x = snap(r.origX + (w - nw)); w = nw; }
            if (r.handle.includes('n')) { const nh = Math.max(GRID * 2, snap(h - dy)); y = snap(r.origY + (h - nh)); h = nh; }

            onResize && onResize(r.id, x, y, w, h);
        };
        const onMouseUp = () => {
            stateRef.current.resize = null;
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    }, [components, onResize]);

    /* ── Canvas click (deselect) ────────────────────────────── */
    const handleCanvasMouseDown = useCallback((e) => {
        if (e.target === canvasRef.current) onSelect(null);
    }, [onSelect]);

    /* ── Keyboard delete ────────────────────────────────────── */
    const handleKeyDown = useCallback((e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !isPreview) {
            onDelete && onDelete(selectedId);
        }
    }, [selectedId, onDelete, isPreview]);

    /* ── Live value resolver ─────────────────────────────────── */
    // ⚠️ Resolved through liveGet/liveResolveKey, never `liveVariables[key]`:
    // the binding field is free text (the datalist only suggests), so a typed
    // `motorrun` must still find the declared `MotorRun`'s key — an exact index
    // left the widget blank while the program ran. liveResolveKey is what a
    // write targets, so it must return the key as the runtime spells it.
    const getLiveValue = useCallback((comp) => {
        if (!liveVariables || !comp.props?.variable) return undefined;
        const key = resolveVar(comp.props.variable, projectStructure);
        return key ? liveGet(liveVariables, key) : undefined;
    }, [liveVariables, projectStructure]);

    const getLiveKey = useCallback((comp) => {
        if (!comp.props?.variable) return null;
        const key = resolveVar(comp.props.variable, projectStructure);
        if (!key) return null;
        return liveResolveKey(liveVariables, key) || key;
    }, [liveVariables, projectStructure]);

    /* ── Grid background style ───────────────────────────────── */
    const gridBg = useMemo(() => ({
        backgroundImage: isPreview ? 'none' : `radial-gradient(circle, #252525 1px, transparent 1px)`,
        backgroundSize: `${GRID * 2}px ${GRID * 2}px`,
    }), [isPreview]);

    return (
        <div
            style={{ flex: 1, overflow: 'auto', background: isPreview ? '#0d0d0d' : '#111' }}
            onClick={e => { if (e.target.dataset.canvas) onSelect(null); }}
        >
            <div
                ref={canvasRef}
                data-canvas="1"
                tabIndex={0}
                onKeyDown={handleKeyDown}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onMouseDown={handleCanvasMouseDown}
                style={{
                    position: 'relative',
                    width: canvasW,
                    height: canvasH,
                    background: isPreview ? '#0d0d0d' : '#111',
                    outline: 'none',
                    ...gridBg,
                    flexShrink: 0,
                }}
            >
                {/* Canvas border in edit mode */}
                {!isPreview && (
                    <div style={{
                        position: 'absolute', inset: 0,
                        border: '1px solid #2a2a2a',
                        pointerEvents: 'none', zIndex: 0,
                    }} />
                )}

                {components.map(comp => {
                    const isSelected = !isPreview && comp.id === selectedId;
                    const value = getLiveValue(comp);
                    const liveKey = getLiveKey(comp);

                    return (
                        <div
                            key={comp.id}
                            onMouseDown={e => handleCompMouseDown(e, comp.id)}
                            style={{
                                position: 'absolute',
                                left: comp.x,
                                top: comp.y,
                                width: comp.w,
                                height: comp.h,
                                outline: isSelected ? '1.5px solid #007acc' : 'none',
                                outlineOffset: 1,
                                cursor: isPreview ? 'default' : 'move',
                                zIndex: isSelected ? 10 : 1,
                                boxSizing: 'border-box',
                            }}
                        >
                            {/* Component content */}
                            <HmiComponentRenderer
                                id={comp.id}
                                type={comp.type}
                                w={comp.w}
                                h={comp.h}
                                compProps={comp.props || {}}
                                value={value}
                                onWrite={onWrite}
                                liveKey={liveKey}
                                isPreview={isPreview}
                            />

                            {/* Resize handles — only on selected, non-preview */}
                            {isSelected && HANDLES.map(h => (
                                <div
                                    key={h}
                                    onMouseDown={e => { e.stopPropagation(); handleResizeMouseDown(e, comp.id, h); }}
                                    style={{ ...handleStyle(h, 7), cursor: HANDLE_CURSORS[h] }}
                                />
                            ))}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default HmiCanvas;
