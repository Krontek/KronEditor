import { useMemo } from 'react';

/* Collect the variable expressions that may be bound to HMI widgets.
 *
 * Only ADDRESSED variables are eligible: a non-empty `address` (e.g. %MW0)
 * means the variable is published over the REST API and the deployed HMI
 * server's /api/variables feed. Binding a widget to a non-addressed variable
 * would render no live value on the target, so they are excluded here. */
const collectVars = (projectStructure) => {
    if (!projectStructure) return [];
    const vars = [];
    const isAddressed = (v) => v && v.name && typeof v.address === 'string' && v.address.trim() !== '';
    const globalVars = projectStructure.resources?.find(r => r.type === 'RESOURCE_EDITOR')?.content?.globalVars || [];
    globalVars.forEach(v => { if (isAddressed(v)) vars.push({ expr: v.name, type: v.type || '', address: v.address }); });
    const allPOUs = [...(projectStructure.programs || []), ...(projectStructure.functionBlocks || [])];
    allPOUs.forEach(pou => {
        (pou.content?.variables || []).forEach(v => {
            if (isAddressed(v)) vars.push({ expr: `${pou.name}.${v.name}`, type: v.type || '', address: v.address });
        });
    });
    return vars;
};

/* ─── Field components ──────────────────────────────────────── */
const Section = ({ title }) => (
    <div style={{ padding: '6px 10px 3px', fontSize: 10, fontWeight: '700', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#555', borderTop: '1px solid #222', marginTop: 4 }}>
        {title}
    </div>
);

const Row = ({ label, children }) => (
    <div style={{ display: 'flex', alignItems: 'center', padding: '3px 10px', gap: 6, minHeight: 26 }}>
        <span style={{ fontSize: 11, color: '#666', minWidth: 72, flexShrink: 0 }}>{label}</span>
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
);

const Input = ({ value, onChange, type = 'text', style = {} }) => (
    <input
        type={type}
        value={value ?? ''}
        onChange={e => onChange(type === 'number' ? Number(e.target.value) : e.target.value)}
        style={{
            width: '100%', background: '#1a1a1a', border: '1px solid #333',
            color: '#d4d4d4', fontSize: 11, padding: '2px 6px', outline: 'none',
            borderRadius: 0, fontFamily: 'inherit', ...style,
        }}
        onFocus={e => e.target.style.borderColor = '#007acc'}
        onBlur={e => e.target.style.borderColor = '#333'}
    />
);

const CheckBox = ({ value, onChange, label }) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} style={{ accentColor: '#007acc' }} />
        {label && <span style={{ fontSize: 11, color: '#888' }}>{label}</span>}
    </label>
);

const Select = ({ value, onChange, options }) => (
    <select
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        style={{
            width: '100%', background: '#1a1a1a', border: '1px solid #333',
            color: '#d4d4d4', fontSize: 11, padding: '2px 4px', outline: 'none',
            borderRadius: 0, fontFamily: 'inherit',
        }}
    >
        {options.map(o => (
            <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
        ))}
    </select>
);

const ColorField = ({ value, onChange }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
            type="color"
            value={value || '#000000'}
            onChange={e => onChange(e.target.value)}
            title={value || '#000000'}
            style={{ width: 48, height: 22, border: '1px solid #333', background: 'none', cursor: 'pointer', padding: 1, flexShrink: 0 }}
        />
        <span style={{ fontSize: 10, color: '#555', fontFamily: 'monospace', letterSpacing: '0.03em' }}>{value || '—'}</span>
    </div>
);

const VarField = ({ value, onChange, vars }) => (
    <div style={{ position: 'relative' }}>
        <input
            list="hmi-var-list"
            value={value || ''}
            onChange={e => onChange(e.target.value)}
            placeholder="addressed variable (e.g. %MW0)"
            style={{
                width: '100%', background: '#0f1929', border: '1px solid #1e3a5c',
                color: '#7eb8f7', fontSize: 11, padding: '2px 6px', outline: 'none',
                fontFamily: 'monospace', borderRadius: 0,
            }}
            onFocus={e => e.target.style.borderColor = '#007acc'}
            onBlur={e => e.target.style.borderColor = '#1e3a5c'}
        />
        <datalist id="hmi-var-list">
            {vars.map(v => <option key={v.expr} value={v.expr} label={v.address ? `${v.address} · ${v.type}` : v.type} />)}
        </datalist>
    </div>
);

/* ─── Type-specific property sections ───────────────────────── */
const PropsForType = ({ type, props, onChange, vars }) => {
    const set = (key, val) => onChange({ ...props, [key]: val });

    const hasVar = !['RECTANGLE', 'CIRCLE', 'LINE'].includes(type);
    const hasColors = !['CHART', 'LINE'].includes(type);

    return (
        <>
            {/* Variable binding */}
            {hasVar && (
                <>
                    <Section title="Variable" />
                    <Row label="Bind">
                        <VarField value={props.variable} onChange={v => set('variable', v)} vars={vars} />
                    </Row>
                </>
            )}

            {/* Type-specific */}
            {type === 'LED' && (
                <>
                    <Section title="Appearance" />
                    <Row label="On Color"><ColorField value={props.onColor} onChange={v => set('onColor', v)} /></Row>
                    <Row label="Off Color"><ColorField value={props.offColor} onChange={v => set('offColor', v)} /></Row>
                    <Row label="Border"><ColorField value={props.borderColor} onChange={v => set('borderColor', v)} /></Row>
                    <Row label="Label"><Input value={props.label} onChange={v => set('label', v)} /></Row>
                    <Row label="Label Pos">
                        <Select value={props.labelPosition} onChange={v => set('labelPosition', v)}
                            options={[{value:'bottom',label:'Bottom'},{value:'top',label:'Top'},{value:'left',label:'Left'},{value:'right',label:'Right'},{value:'none',label:'None'}]} />
                    </Row>
                    <Row label="Font Size"><Input type="number" value={props.fontSize} onChange={v => set('fontSize', v)} /></Row>
                </>
            )}

            {type === 'ALARM' && (
                <>
                    <Section title="Appearance" />
                    <Row label="Active"><ColorField value={props.activeColor} onChange={v => set('activeColor', v)} /></Row>
                    <Row label="Inactive"><ColorField value={props.inactiveColor} onChange={v => set('inactiveColor', v)} /></Row>
                    <Row label="Label"><Input value={props.label} onChange={v => set('label', v)} /></Row>
                    <Row label="Blink"><CheckBox value={props.blink} onChange={v => set('blink', v)} /></Row>
                    <Row label="Font Size"><Input type="number" value={props.fontSize} onChange={v => set('fontSize', v)} /></Row>
                </>
            )}

            {type === 'NUMERIC_DISPLAY' && (
                <>
                    <Section title="Format" />
                    <Row label="Decimals"><Input type="number" value={props.decimals} onChange={v => set('decimals', v)} /></Row>
                    <Row label="Unit"><Input value={props.unit} onChange={v => set('unit', v)} /></Row>
                    <Row label="Font Size"><Input type="number" value={props.fontSize} onChange={v => set('fontSize', v)} /></Row>
                    <Section title="Appearance" />
                    <Row label="Color"><ColorField value={props.color} onChange={v => set('color', v)} /></Row>
                    <Row label="Background"><ColorField value={props.background} onChange={v => set('background', v)} /></Row>
                    <Row label="Border"><ColorField value={props.borderColor} onChange={v => set('borderColor', v)} /></Row>
                </>
            )}

            {type === 'PROGRESS' && (
                <>
                    <Section title="Range" />
                    <Row label="Min"><Input type="number" value={props.min} onChange={v => set('min', v)} /></Row>
                    <Row label="Max"><Input type="number" value={props.max} onChange={v => set('max', v)} /></Row>
                    <Row label="Label"><Input value={props.label} onChange={v => set('label', v)} /></Row>
                    <Row label="Show Value"><CheckBox value={props.showValue} onChange={v => set('showValue', v)} /></Row>
                    <Section title="Appearance" />
                    <Row label="Fill Color"><ColorField value={props.color} onChange={v => set('color', v)} /></Row>
                    <Row label="Background"><ColorField value={props.background} onChange={v => set('background', v)} /></Row>
                </>
            )}

            {type === 'GAUGE' && (
                <>
                    <Section title="Range" />
                    <Row label="Min"><Input type="number" value={props.min} onChange={v => set('min', v)} /></Row>
                    <Row label="Max"><Input type="number" value={props.max} onChange={v => set('max', v)} /></Row>
                    <Row label="Unit"><Input value={props.unit} onChange={v => set('unit', v)} /></Row>
                    <Row label="Label"><Input value={props.label} onChange={v => set('label', v)} /></Row>
                    <Row label="Decimals"><Input type="number" value={props.decimals} onChange={v => set('decimals', v)} /></Row>
                    <Section title="Appearance" />
                    <Row label="Arc Color"><ColorField value={props.arcColor} onChange={v => set('arcColor', v)} /></Row>
                    <Row label="Bg Arc"><ColorField value={props.bgArcColor} onChange={v => set('bgArcColor', v)} /></Row>
                    <Row label="Needle"><ColorField value={props.needleColor} onChange={v => set('needleColor', v)} /></Row>
                </>
            )}

            {type === 'CHART' && (
                <>
                    <Section title="Settings" />
                    <Row label="Max Pts"><Input type="number" value={props.maxPoints} onChange={v => set('maxPoints', v)} /></Row>
                    <Row label="Label"><Input value={props.label} onChange={v => set('label', v)} /></Row>
                    <Row label="Unit"><Input value={props.unit} onChange={v => set('unit', v)} /></Row>
                    <Row label="Auto Scale"><CheckBox value={props.autoScale} onChange={v => set('autoScale', v)} /></Row>
                    {!props.autoScale && <>
                        <Row label="Y Min"><Input type="number" value={props.min ?? ''} onChange={v => set('min', v)} /></Row>
                        <Row label="Y Max"><Input type="number" value={props.max ?? ''} onChange={v => set('max', v)} /></Row>
                    </>}
                    <Section title="Appearance" />
                    <Row label="Line"><ColorField value={props.lineColor} onChange={v => set('lineColor', v)} /></Row>
                    <Row label="Fill"><ColorField value={props.fillColor} onChange={v => set('fillColor', v)} /></Row>
                    <Row label="Background"><ColorField value={props.background} onChange={v => set('background', v)} /></Row>
                </>
            )}

            {(type === 'BUTTON' || type === 'TOGGLE_BUTTON') && (
                <>
                    <Section title="Behavior" />
                    {type === 'BUTTON' && (
                        <Row label="Mode">
                            <Select value={props.mode} onChange={v => set('mode', v)}
                                options={[{value:'momentary',label:'Momentary'},{value:'toggle',label:'Toggle'}]} />
                        </Row>
                    )}
                    <Section title="Label" />
                    {type === 'BUTTON' && <Row label="Text"><Input value={props.label} onChange={v => set('label', v)} /></Row>}
                    {type === 'TOGGLE_BUTTON' && <>
                        <Row label="ON Text"><Input value={props.labelOn} onChange={v => set('labelOn', v)} /></Row>
                        <Row label="OFF Text"><Input value={props.labelOff} onChange={v => set('labelOff', v)} /></Row>
                    </>}
                    <Row label="Font Size"><Input type="number" value={props.fontSize} onChange={v => set('fontSize', v)} /></Row>
                    <Section title="Appearance" />
                    <Row label="ON Color"><ColorField value={props.onColor} onChange={v => set('onColor', v)} /></Row>
                    <Row label="OFF Color"><ColorField value={props.offColor} onChange={v => set('offColor', v)} /></Row>
                    <Row label="Text Color"><ColorField value={props.textColor} onChange={v => set('textColor', v)} /></Row>
                    <Row label="Radius"><Input type="number" value={props.borderRadius} onChange={v => set('borderRadius', v)} /></Row>
                </>
            )}

            {type === 'SWITCH' && (
                <>
                    <Section title="Appearance" />
                    <Row label="ON Color"><ColorField value={props.onColor} onChange={v => set('onColor', v)} /></Row>
                    <Row label="OFF Color"><ColorField value={props.offColor} onChange={v => set('offColor', v)} /></Row>
                    <Row label="Label"><Input value={props.label} onChange={v => set('label', v)} /></Row>
                    <Row label="Label Pos">
                        <Select value={props.labelPosition} onChange={v => set('labelPosition', v)}
                            options={[{value:'right',label:'Right'},{value:'left',label:'Left'}]} />
                    </Row>
                </>
            )}

            {type === 'SLIDER' && (
                <>
                    <Section title="Range" />
                    <Row label="Min"><Input type="number" value={props.min} onChange={v => set('min', v)} /></Row>
                    <Row label="Max"><Input type="number" value={props.max} onChange={v => set('max', v)} /></Row>
                    <Row label="Step"><Input type="number" value={props.step} onChange={v => set('step', v)} /></Row>
                    <Row label="Show Value"><CheckBox value={props.showValue} onChange={v => set('showValue', v)} /></Row>
                    <Section title="Appearance" />
                    <Row label="Thumb"><ColorField value={props.thumbColor} onChange={v => set('thumbColor', v)} /></Row>
                </>
            )}

            {type === 'NUMERIC_INPUT' && (
                <>
                    <Section title="Format" />
                    <Row label="Decimals"><Input type="number" value={props.decimals} onChange={v => set('decimals', v)} /></Row>
                    <Row label="Label"><Input value={props.label} onChange={v => set('label', v)} /></Row>
                    <Section title="Appearance" />
                    <Row label="Color"><ColorField value={props.color} onChange={v => set('color', v)} /></Row>
                    <Row label="Background"><ColorField value={props.background} onChange={v => set('background', v)} /></Row>
                </>
            )}

            {type === 'LABEL' && (
                <>
                    <Section title="Content" />
                    <Row label="Text"><Input value={props.text} onChange={v => set('text', v)} /></Row>
                    <Row label="Unit"><Input value={props.unit} onChange={v => set('unit', v)} /></Row>
                    <Row label="Decimals"><Input type="number" value={props.decimals} onChange={v => set('decimals', v)} /></Row>
                    <Section title="Style" />
                    <Row label="Font Size"><Input type="number" value={props.fontSize} onChange={v => set('fontSize', v)} /></Row>
                    <Row label="Font Weight">
                        <Select value={props.fontWeight} onChange={v => set('fontWeight', v)}
                            options={[{value:'normal',label:'Normal'},{value:'bold',label:'Bold'},{value:'600',label:'Semi-bold'}]} />
                    </Row>
                    <Row label="Color"><ColorField value={props.color} onChange={v => set('color', v)} /></Row>
                    <Row label="Align">
                        <Select value={props.align} onChange={v => set('align', v)}
                            options={[{value:'left',label:'Left'},{value:'center',label:'Center'},{value:'right',label:'Right'}]} />
                    </Row>
                    <Row label="Background"><ColorField value={props.background} onChange={v => set('background', v)} /></Row>
                </>
            )}

            {type === 'RECTANGLE' && (
                <>
                    <Section title="Appearance" />
                    <Row label="Fill"><ColorField value={props.background} onChange={v => set('background', v)} /></Row>
                    <Row label="Border"><ColorField value={props.borderColor} onChange={v => set('borderColor', v)} /></Row>
                    <Row label="Border W"><Input type="number" value={props.borderWidth} onChange={v => set('borderWidth', v)} /></Row>
                    <Row label="Radius"><Input type="number" value={props.borderRadius} onChange={v => set('borderRadius', v)} /></Row>
                    <Row label="Label"><Input value={props.label} onChange={v => set('label', v)} /></Row>
                    <Row label="Label Color"><ColorField value={props.labelColor} onChange={v => set('labelColor', v)} /></Row>
                </>
            )}

            {type === 'CIRCLE' && (
                <>
                    <Section title="Appearance" />
                    <Row label="Fill"><ColorField value={props.background} onChange={v => set('background', v)} /></Row>
                    <Row label="Border"><ColorField value={props.borderColor} onChange={v => set('borderColor', v)} /></Row>
                    <Row label="Border W"><Input type="number" value={props.borderWidth} onChange={v => set('borderWidth', v)} /></Row>
                </>
            )}

            {type === 'LINE' && (
                <>
                    <Section title="Appearance" />
                    <Row label="Color"><ColorField value={props.color} onChange={v => set('color', v)} /></Row>
                    <Row label="Thickness"><Input type="number" value={props.thickness} onChange={v => set('thickness', v)} /></Row>
                    <Row label="Style">
                        <Select value={props.style} onChange={v => set('style', v)}
                            options={[{value:'solid',label:'Solid'},{value:'dashed',label:'Dashed'},{value:'dotted',label:'Dotted'}]} />
                    </Row>
                    <Row label="Direction">
                        <Select value={props.orientation} onChange={v => set('orientation', v)}
                            options={[{value:'horizontal',label:'Horizontal'},{value:'vertical',label:'Vertical'}]} />
                    </Row>
                </>
            )}
        </>
    );
};

/* ─── Main HmiProperties ────────────────────────────────────── */
const HmiProperties = ({ selected, page, onUpdateComponent, projectStructure }) => {
    const vars = useMemo(() => collectVars(projectStructure), [projectStructure]);

    if (!selected) {
        return (
            <div style={{
                width: '100%', height: '100%',
                background: '#161616',
                borderLeft: '1px solid #2a2a2a',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#333', fontSize: 11, fontStyle: 'italic',
                userSelect: 'none',
            }}>
                Select a component
            </div>
        );
    }

    const handlePositionChange = (key, val) => {
        onUpdateComponent(selected.id, { [key]: Number(val) });
    };

    const handlePropsChange = (newProps) => {
        onUpdateComponent(selected.id, { props: newProps });
    };

    return (
        <div style={{
            width: '100%', height: '100%',
            background: '#161616',
            borderLeft: '1px solid #2a2a2a',
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'auto',
        }}>
            {/* Header */}
            <div style={{
                padding: '7px 10px',
                fontSize: 11,
                fontWeight: '600',
                color: '#888',
                borderBottom: '1px solid #222',
                background: '#1a1a1a',
                flexShrink: 0,
                letterSpacing: '0.04em',
            }}>
                {selected.type}
                <span style={{ color: '#444', marginLeft: 8, fontSize: 10, fontWeight: '400' }}>#{selected.id.slice(-4)}</span>
            </div>

            {/* Position & Size */}
            <Section title="Position & Size" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, padding: '0 10px 4px' }}>
                {[['X', 'x'], ['Y', 'y'], ['W', 'w'], ['H', 'h']].map(([label, key]) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 10, color: '#555', width: 12 }}>{label}</span>
                        <input
                            type="number"
                            value={selected[key] ?? 0}
                            onChange={e => handlePositionChange(key, e.target.value)}
                            style={{ flex: 1, minWidth: 0, background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#c0c0c0', fontSize: 11, padding: '2px 4px', outline: 'none', fontFamily: 'monospace' }}
                            onFocus={e => e.target.style.borderColor = '#007acc'}
                            onBlur={e => e.target.style.borderColor = '#2a2a2a'}
                        />
                    </div>
                ))}
            </div>

            {/* Type-specific properties */}
            <PropsForType
                type={selected.type}
                props={selected.props || {}}
                onChange={handlePropsChange}
                vars={vars}
            />

            <div style={{ height: 20, flexShrink: 0 }} />
        </div>
    );
};

export default HmiProperties;
