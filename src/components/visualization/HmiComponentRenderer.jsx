import { useRef, useEffect, useState, useCallback } from 'react';

/* ─── Gauge helpers ─────────────────────────────────────────── */
const polarToXY = (cx, cy, r, angleDeg) => {
    const rad = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
};
const arcPath = (cx, cy, r, fromDeg, toDeg) => {
    const start = polarToXY(cx, cy, r, fromDeg);
    const end   = polarToXY(cx, cy, r, toDeg);
    const large = (toDeg - fromDeg) > 180 ? 1 : 0;
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
};

/* ─── LED ───────────────────────────────────────────────────── */
const LedComp = ({ w, h, p, value }) => {
    const on    = value === true || value === 1 || value === '1' || value === 'TRUE';
    const color = on ? (p.onColor || '#00e676') : (p.offColor || '#1a1a1a');
    const border = p.borderColor || '#555';
    const size  = Math.min(w, h) * 0.68;
    const hasLabel = p.label && p.label.trim();
    const pos   = p.labelPosition || 'bottom';

    const circle = (
        <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
            <div style={{
                width: size, height: size, borderRadius: '50%',
                background: color,
                border: `2px solid ${border}`,
                boxShadow: on ? `0 0 ${size * 0.35}px ${color}, 0 0 ${size * 0.6}px ${color}55` : `inset 0 2px 6px rgba(0,0,0,0.5)`,
                transition: 'background 0.1s, box-shadow 0.1s',
            }} />
        </div>
    );

    if (!hasLabel) return (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {circle}
        </div>
    );

    const isVert = pos === 'top' || pos === 'bottom';
    return (
        <div style={{
            width: '100%', height: '100%',
            display: 'flex', flexDirection: isVert ? 'column' : 'row',
            alignItems: 'center', justifyContent: 'center', gap: 4,
        }}>
            {(pos === 'top' || pos === 'left') && (
                <span style={{ fontSize: p.fontSize || 11, color: '#aaa', whiteSpace: 'nowrap' }}>{p.label}</span>
            )}
            {circle}
            {(pos === 'bottom' || pos === 'right') && (
                <span style={{ fontSize: p.fontSize || 11, color: '#aaa', whiteSpace: 'nowrap' }}>{p.label}</span>
            )}
        </div>
    );
};

/* ─── Alarm ─────────────────────────────────────────────────── */
const AlarmComp = ({ w, h, p, value }) => {
    const active = value === true || value === 1 || value === 'TRUE' || value === '1';
    const [blinkOn, setBlinkOn] = useState(true);
    useEffect(() => {
        if (!active || !p.blink) { setBlinkOn(true); return; }
        const t = setInterval(() => setBlinkOn(v => !v), 500);
        return () => clearInterval(t);
    }, [active, p.blink]);
    const color = active
        ? ((p.blink ? blinkOn : true) ? (p.activeColor || '#f14c4c') : '#800')
        : (p.inactiveColor || '#2a2a2a');
    const size = Math.min(w, h) * 0.7;
    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <svg width={size} height={size} viewBox="0 0 24 24" style={{ filter: active && blinkOn ? `drop-shadow(0 0 6px ${p.activeColor || '#f14c4c'})` : 'none', transition: 'filter 0.1s' }}>
                <path d="M12 2L1 21h22L12 2z" fill={color} stroke={active ? '#ff000088' : '#444'} strokeWidth="1" />
                <text x="12" y="17" textAnchor="middle" fill="#fff" fontSize="7" fontWeight="bold">!</text>
            </svg>
            {p.label && <span style={{ fontSize: p.fontSize || 12, color: active ? (p.activeColor || '#f14c4c') : '#555', fontWeight: '600', letterSpacing: '0.05em' }}>{p.label}</span>}
        </div>
    );
};

/* ─── Numeric Display ───────────────────────────────────────── */
const NumericDisplayComp = ({ w, h, p, value }) => {
    const dec = Number(p.decimals) || 0;
    let display = '---';
    if (value !== null && value !== undefined) {
        const n = Number(value);
        display = isNaN(n) ? String(value) : n.toFixed(dec);
    }
    return (
        <div style={{
            width: '100%', height: '100%',
            background: p.background || '#0a0f14',
            border: `1px solid ${p.borderColor || '#1e2a38'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
            padding: '0 10px',
        }}>
            <span style={{
                fontFamily: '"Courier New", "Consolas", monospace',
                fontSize: Math.min(p.fontSize || 24, h * 0.7),
                color: p.color || '#4ec9b0',
                letterSpacing: '0.04em',
                fontWeight: '700',
            }}>{display}</span>
            {p.unit && <span style={{ fontSize: Math.max((p.fontSize || 24) * 0.45, 10), color: '#666', marginTop: 2 }}>{p.unit}</span>}
        </div>
    );
};

/* ─── Progress Bar ──────────────────────────────────────────── */
const ProgressComp = ({ w, h, p, value }) => {
    const min = Number(p.min) || 0;
    const max = Number(p.max) || 100;
    const val = Math.min(max, Math.max(min, Number(value) || min));
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
            {p.label && <span style={{ fontSize: 10, color: '#777', paddingLeft: 2 }}>{p.label}</span>}
            <div style={{ position: 'relative', width: '100%', height: p.label ? '55%' : '100%', background: p.background || '#1a1a1a', border: `1px solid ${p.borderColor || '#2a2a2a'}` }}>
                <div style={{ width: `${pct}%`, height: '100%', background: p.color || '#007acc', transition: 'width 0.1s' }} />
                {p.showValue && (
                    <span style={{
                        position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
                        fontSize: 10, color: '#fff', fontFamily: 'monospace', fontWeight: '600',
                        textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                    }}>{val.toFixed(0)}</span>
                )}
            </div>
        </div>
    );
};

/* ─── Gauge ─────────────────────────────────────────────────── */
const GaugeComp = ({ w, h, p, value }) => {
    const min     = Number(p.min) || 0;
    const max     = Number(p.max) || 100;
    const val     = Math.min(max, Math.max(min, Number(value) || min));
    const norm    = max > min ? (val - min) / (max - min) : 0;
    const START   = 135;
    const SWEEP   = 270;
    const valDeg  = START + norm * SWEEP;
    const cx = w / 2, cy = h * 0.52;
    const r  = Math.min(w * 0.42, h * 0.48);
    const dec = Number(p.decimals) || 0;

    const needle = polarToXY(cx, cy, r * 0.78, valDeg);
    const needleBase1 = polarToXY(cx, cy, r * 0.12, valDeg + 90);
    const needleBase2 = polarToXY(cx, cy, r * 0.12, valDeg - 90);

    return (
        <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
            {/* Background arc */}
            <path d={arcPath(cx, cy, r, START, START + SWEEP)} fill="none" stroke={p.bgArcColor || '#1e2a38'} strokeWidth={r * 0.18} strokeLinecap="round" />
            {/* Value arc */}
            {norm > 0.001 && <path d={arcPath(cx, cy, r, START, valDeg)} fill="none" stroke={p.arcColor || '#007acc'} strokeWidth={r * 0.18} strokeLinecap="round" />}
            {/* Needle */}
            <polygon
                points={`${needle.x.toFixed(1)},${needle.y.toFixed(1)} ${needleBase1.x.toFixed(1)},${needleBase1.y.toFixed(1)} ${needleBase2.x.toFixed(1)},${needleBase2.y.toFixed(1)}`}
                fill={p.needleColor || '#e0e0e0'}
            />
            {/* Center dot */}
            <circle cx={cx} cy={cy} r={r * 0.07} fill={p.needleColor || '#e0e0e0'} />
            {/* Value text */}
            <text x={cx} y={cy + r * 0.52} textAnchor="middle" fill={p.valueColor || '#e0e0e0'} fontSize={r * 0.28} fontFamily="Consolas, monospace" fontWeight="700">
                {value !== null && value !== undefined ? Number(value).toFixed(dec) : '---'}
            </text>
            {p.unit && <text x={cx} y={cy + r * 0.78} textAnchor="middle" fill="#666" fontSize={r * 0.19}>{p.unit}</text>}
            {p.label && <text x={cx} y={h - 4} textAnchor="middle" fill="#777" fontSize={r * 0.2}>{p.label}</text>}
            {/* Min/max ticks */}
            {[0, 1].map(t => {
                const pt = polarToXY(cx, cy, r * 1.14, START + t * SWEEP);
                const label = t === 0 ? min : max;
                return <text key={t} x={pt.x.toFixed(1)} y={(pt.y + 4).toFixed(1)} textAnchor="middle" fill="#555" fontSize={r * 0.17}>{label}</text>;
            })}
        </svg>
    );
};

/* ─── Trend Chart ───────────────────────────────────────────── */
const ChartComp = ({ w, h, p, value }) => {
    const canvasRef   = useRef(null);
    const historyRef  = useRef([]);
    const lastValRef  = useRef(null);

    useEffect(() => {
        if (value !== undefined && value !== null && value !== lastValRef.current) {
            lastValRef.current = value;
            const n = Number(value);
            if (!isNaN(n)) {
                historyRef.current.push(n);
                if (historyRef.current.length > (Number(p.maxPoints) || 100)) {
                    historyRef.current.shift();
                }
            }
        }
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx    = canvas.getContext('2d');
        const data   = historyRef.current;

        ctx.fillStyle = p.background || '#0a0f14';
        ctx.fillRect(0, 0, w, h);

        // Grid
        ctx.strokeStyle = p.gridColor || '#1a2030';
        ctx.lineWidth = 1;
        for (let row = 1; row < 4; row++) {
            const y = Math.round(h * row / 4) + 0.5;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
        for (let col = 1; col < 6; col++) {
            const x = Math.round(w * col / 6) + 0.5;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }

        if (data.length < 2) return;

        const minV = p.autoScale ? Math.min(...data) : (p.min ?? Math.min(...data));
        const maxV = p.autoScale ? Math.max(...data) : (p.max ?? Math.max(...data));
        const range = maxV - minV || 1;

        const toX = (i) => (i / (data.length - 1)) * w;
        const toY = (v) => h - ((v - minV) / range) * (h * 0.88) - h * 0.06;

        // Fill
        ctx.beginPath();
        ctx.moveTo(toX(0), h);
        data.forEach((v, i) => ctx.lineTo(toX(i), toY(v)));
        ctx.lineTo(toX(data.length - 1), h);
        ctx.closePath();
        ctx.fillStyle = p.fillColor || 'rgba(0,122,204,0.15)';
        ctx.fill();

        // Line
        ctx.beginPath();
        data.forEach((v, i) => i === 0 ? ctx.moveTo(toX(i), toY(v)) : ctx.lineTo(toX(i), toY(v)));
        ctx.strokeStyle = p.lineColor || '#007acc';
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Labels
        if (p.label || p.unit) {
            ctx.fillStyle = '#666';
            ctx.font = '10px Consolas, monospace';
            const txt = [p.label, p.unit].filter(Boolean).join(' ');
            ctx.fillText(txt, 4, 12);
        }
        if (data.length > 0) {
            const latest = data[data.length - 1];
            ctx.fillStyle = p.lineColor || '#007acc';
            ctx.font = 'bold 11px Consolas, monospace';
            ctx.fillText(latest.toFixed(2), w - 4 - ctx.measureText(latest.toFixed(2)).width, 12);
        }
    }, [value, w, h, p]);

    return <canvas ref={canvasRef} width={w} height={h} style={{ display: 'block' }} />;
};

/* ─── Button ────────────────────────────────────────────────── */
const ButtonComp = ({ w, h, p, value, onWrite, liveKey, isPreview }) => {
    const [pressed, setPressed] = useState(false);
    const on = value === true || value === 1 || value === 'TRUE' || value === '1';
    const active = p.mode === 'toggle' ? on : pressed;
    const bg = active ? (p.onColor || '#007acc') : (p.offColor || '#252525');
    const border = p.borderColor || '#3a3a3a';

    // Momentary: press = FORCE TRUE (held while pressed), release = UNFORCE
    // writing FALSE once, so the logic owns the bit again afterwards.
    // ⚠️ Pointer capture keeps the release on this element when the cursor or
    // finger slides off, and pointercancel / lostpointercapture count as a
    // release — a missed release would leave the bit forced TRUE. downRef makes
    // the release fire exactly once (pointerup is followed by
    // lostpointercapture). Ordering of press vs release is guaranteed by the
    // per-key chain in App.jsx handleForceWrite.
    const downRef = useRef(false);
    const handleDown = useCallback((e) => {
        if (!isPreview || !onWrite) return;
        if (e.button > 0) return; // primary button / touch / pen only
        if (p.mode === 'momentary') {
            if (downRef.current) return;
            downRef.current = true;
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* element gone */ }
            setPressed(true);
            onWrite(liveKey, true, 'force');
        } else {
            onWrite(liveKey, !on);
        }
    }, [isPreview, onWrite, liveKey, p.mode, on]);

    const handleUp = useCallback(() => {
        if (!downRef.current) return;
        downRef.current = false;
        setPressed(false);
        if (isPreview && onWrite) onWrite(liveKey, false, 'unforce');
    }, [isPreview, onWrite, liveKey]);

    // Unmounted mid-press (page switch, leaving preview): release too.
    const releaseRef = useRef(null);
    releaseRef.current = handleUp;
    useEffect(() => () => releaseRef.current && releaseRef.current(), []);

    return (
        <div
            onPointerDown={handleDown}
            onPointerUp={handleUp}
            onPointerCancel={handleUp}
            onLostPointerCapture={handleUp}
            style={{
                width: '100%', height: '100%',
                background: bg,
                border: `1px solid ${border}`,
                borderRadius: p.borderRadius ?? 3,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: isPreview ? 'pointer' : 'default',
                userSelect: 'none',
                touchAction: 'none',
                transition: 'background 0.08s',
                boxShadow: active ? `inset 0 2px 6px rgba(0,0,0,0.4)` : `0 2px 4px rgba(0,0,0,0.3)`,
            }}
        >
            <span style={{ fontSize: p.fontSize || 13, color: p.textColor || '#fff', fontWeight: '500', pointerEvents: 'none' }}>
                {p.label || 'Button'}
            </span>
        </div>
    );
};

/* ─── Toggle Button ─────────────────────────────────────────── */
const ToggleButtonComp = ({ w, h, p, value, onWrite, liveKey, isPreview }) => {
    const on = value === true || value === 1 || value === 'TRUE' || value === '1';
    const bg = on ? (p.onColor || '#007a4d') : (p.offColor || '#252525');
    return (
        <div
            onClick={() => isPreview && onWrite && onWrite(liveKey, !on)}
            style={{
                width: '100%', height: '100%',
                background: bg,
                border: `1px solid ${p.borderColor || '#3a3a3a'}`,
                borderRadius: p.borderRadius ?? 3,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: isPreview ? 'pointer' : 'default',
                userSelect: 'none',
                transition: 'background 0.1s',
                boxShadow: on ? `inset 0 2px 5px rgba(0,0,0,0.3)` : `0 2px 4px rgba(0,0,0,0.3)`,
            }}
        >
            <span style={{ fontSize: p.fontSize || 13, color: p.textColor || '#fff', fontWeight: '600', letterSpacing: '0.06em', pointerEvents: 'none' }}>
                {on ? (p.labelOn || 'ON') : (p.labelOff || 'OFF')}
            </span>
        </div>
    );
};

/* ─── Switch ────────────────────────────────────────────────── */
const SwitchComp = ({ w, h, p, value, onWrite, liveKey, isPreview }) => {
    const on    = value === true || value === 1 || value === 'TRUE' || value === '1';
    const TRACK_W = Math.min(w * 0.56, 54);
    const TRACK_H = Math.min(h * 0.52, 28);
    const THUMB   = TRACK_H - 4;

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <div
                onClick={() => isPreview && onWrite && onWrite(liveKey, !on)}
                style={{
                    width: TRACK_W, height: TRACK_H, borderRadius: TRACK_H / 2,
                    background: on ? (p.onColor || '#007acc') : (p.offColor || '#333'),
                    position: 'relative', cursor: isPreview ? 'pointer' : 'default',
                    transition: 'background 0.15s', flexShrink: 0,
                    boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.4)',
                }}
            >
                <div style={{
                    position: 'absolute',
                    top: 2, left: on ? TRACK_W - THUMB - 2 : 2,
                    width: THUMB, height: THUMB,
                    borderRadius: '50%',
                    background: '#e0e0e0',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.5)',
                    transition: 'left 0.15s',
                }} />
            </div>
            {p.label && (
                <span style={{ fontSize: p.fontSize || 12, color: '#aaa', whiteSpace: 'nowrap' }}>{p.label}</span>
            )}
        </div>
    );
};

/* ─── Slider ────────────────────────────────────────────────── */
const SliderComp = ({ w, h, p, value, onWrite, liveKey, isPreview }) => {
    const min  = Number(p.min) ?? 0;
    const max  = Number(p.max) ?? 100;
    const step = Number(p.step) || 1;
    const val  = Number(value) || min;

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, padding: '0 8px' }}>
            <input
                type="range"
                min={min} max={max} step={step} value={val}
                disabled={!isPreview}
                onChange={e => isPreview && onWrite && onWrite(liveKey, Number(e.target.value))}
                style={{ width: '100%', accentColor: p.thumbColor || '#007acc', cursor: isPreview ? 'pointer' : 'default' }}
            />
            {p.showValue && (
                <span style={{ fontSize: 10, color: '#888', fontFamily: 'monospace' }}>{val}</span>
            )}
        </div>
    );
};

/* ─── Numeric Input ─────────────────────────────────────────── */
const NumericInputComp = ({ w, h, p, value, onWrite, liveKey, isPreview }) => {
    const [draft, setDraft] = useState('');
    const [editing, setEditing] = useState(false);
    const dec = Number(p.decimals) || 0;
    const display = (value !== null && value !== undefined) ? Number(value).toFixed(dec) : '---';

    const commit = () => {
        const n = parseFloat(draft);
        if (!isNaN(n) && onWrite) onWrite(liveKey, n);
        setEditing(false);
    };

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: 2 }}>
            {p.label && <span style={{ fontSize: 10, color: '#666', paddingLeft: 2 }}>{p.label}</span>}
            {editing && isPreview ? (
                <input
                    autoFocus
                    type="number"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
                    style={{
                        background: p.background || '#1a1a1a',
                        border: `1px solid #007acc`,
                        color: p.color || '#e0e0e0',
                        fontSize: p.fontSize || 14,
                        fontFamily: 'monospace',
                        padding: '2px 8px',
                        outline: 'none',
                        width: '100%',
                    }}
                />
            ) : (
                <div
                    onClick={() => { if (isPreview) { setDraft(display === '---' ? '' : display); setEditing(true); } }}
                    style={{
                        background: p.background || '#1a1a1a',
                        border: `1px solid ${p.borderColor || '#3a3a3a'}`,
                        color: p.color || '#e0e0e0',
                        fontSize: p.fontSize || 14,
                        fontFamily: 'monospace',
                        padding: '4px 8px',
                        cursor: isPreview ? 'text' : 'default',
                        textAlign: 'right',
                    }}
                >
                    {display}
                </div>
            )}
        </div>
    );
};

/* ─── Label ─────────────────────────────────────────────────── */
const LabelComp = ({ w, h, p, value }) => {
    const dec  = Number(p.decimals) || 0;
    let   text = p.text || '';
    if (p.variable && value !== null && value !== undefined) {
        const n = Number(value);
        text = isNaN(n) ? String(value) : n.toFixed(dec);
        if (p.unit) text += ` ${p.unit}`;
    }
    return (
        <div style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center',
            justifyContent: p.align === 'center' ? 'center' : p.align === 'right' ? 'flex-end' : 'flex-start',
            background: p.background || 'transparent',
            padding: '0 4px',
            overflow: 'hidden',
        }}>
            <span style={{
                fontSize: p.fontSize || 13,
                fontWeight: p.fontWeight || 'normal',
                color: p.color || '#d4d4d4',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
            }}>
                {text}
            </span>
        </div>
    );
};

/* ─── Rectangle ─────────────────────────────────────────────── */
const RectangleComp = ({ w, h, p }) => (
    <div style={{
        width: '100%', height: '100%',
        background: p.background || 'transparent',
        border: `${p.borderWidth || 1}px solid ${p.borderColor || '#444'}`,
        borderRadius: p.borderRadius || 0,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-start',
    }}>
        {p.label && (
            <span style={{ fontSize: p.fontSize || 11, color: p.labelColor || '#888', padding: '2px 6px', userSelect: 'none' }}>{p.label}</span>
        )}
    </div>
);

/* ─── Circle ────────────────────────────────────────────────── */
const CircleComp = ({ w, h, p }) => {
    const size = Math.min(w, h);
    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{
                width: size, height: size,
                borderRadius: '50%',
                background: p.background || 'transparent',
                border: `${p.borderWidth || 1}px solid ${p.borderColor || '#444'}`,
            }} />
        </div>
    );
};

/* ─── Line ──────────────────────────────────────────────────── */
const LineComp = ({ w, h, p }) => {
    const horiz = (p.orientation || 'horizontal') === 'horizontal';
    return (
        <div style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
            <div style={{
                width:  horiz ? '100%' : (p.thickness || 1),
                height: horiz ? (p.thickness || 1) : '100%',
                background: p.color || '#444',
                borderStyle: p.style || 'solid',
            }} />
        </div>
    );
};

/* ─── Main renderer ─────────────────────────────────────────── */
const RENDERERS = {
    LED:              LedComp,
    ALARM:            AlarmComp,
    NUMERIC_DISPLAY:  NumericDisplayComp,
    PROGRESS:         ProgressComp,
    GAUGE:            GaugeComp,
    CHART:            ChartComp,
    BUTTON:           ButtonComp,
    TOGGLE_BUTTON:    ToggleButtonComp,
    SWITCH:           SwitchComp,
    SLIDER:           SliderComp,
    NUMERIC_INPUT:    NumericInputComp,
    LABEL:            LabelComp,
    RECTANGLE:        RectangleComp,
    CIRCLE:           CircleComp,
    LINE:             LineComp,
};

const HmiComponentRenderer = ({ id, type, w, h, compProps = {}, value, onWrite, liveKey, isPreview = false }) => {
    const Comp = RENDERERS[type];
    if (!Comp) {
        return (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1a1a1a', border: '1px dashed #444', color: '#555', fontSize: 11 }}>
                {type}
            </div>
        );
    }
    return (
        <Comp
            w={w} h={h}
            p={compProps}
            value={value}
            onWrite={onWrite}
            liveKey={liveKey}
            isPreview={isPreview}
        />
    );
};

export default HmiComponentRenderer;
