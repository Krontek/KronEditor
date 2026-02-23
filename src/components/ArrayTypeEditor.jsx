import { DataTypeSelector } from './common/Selectors';

const ArrayTypeEditor = ({ content, onContentChange, projectStructure, currentId, derivedTypes = [] }) => {

    // Helper to update content
    const update = (changes) => {
        onContentChange({ ...content, ...changes });
    };

    const addDimension = () => {
        const newDim = { id: Date.now(), min: 0, max: 10 };
        update({ dimensions: [...(content.dimensions || []), newDim] });
    };

    const removeDimension = (id) => {
        update({ dimensions: (content.dimensions || []).filter(d => d.id !== id) });
    };

    const updateDimension = (id, field, value) => {
        const val = parseInt(value, 10);
        if (isNaN(val)) return;

        update({
            dimensions: (content.dimensions || []).map(d =>
                d.id === id ? { ...d, [field]: val } : d
            )
        });
    };

    const moveDimension = (index, direction) => {
        const dims = [...(content.dimensions || [])];
        if (direction === 'up' && index > 0) {
            [dims[index], dims[index - 1]] = [dims[index - 1], dims[index]];
        } else if (direction === 'down' && index < dims.length - 1) {
            [dims[index], dims[index + 1]] = [dims[index + 1], dims[index]];
        }
        update({ dimensions: dims });
    };

    return (
        <div style={{ padding: '20px', color: '#e0e0e0', fontFamily: 'Inter, system-ui, sans-serif' }}>
            <div style={{ marginBottom: '20px', borderBottom: '1px solid #333', paddingBottom: '10px' }}>
                <h3 style={{ margin: 0, fontWeight: 500, color: '#fff' }}>Array Definition</h3>
                <p style={{ margin: '5px 0 0', fontSize: '12px', color: '#888' }}>Define the dimensions and base type of your array.</p>
            </div>

            <div style={{
                background: '#1e1e1e',
                border: '1px solid #333',
                borderRadius: '6px',
                padding: '20px',
                boxShadow: '0 4px 6px rgba(0,0,0,0.2)'
            }}>
                {/* BASE TYPE */}
                <div style={{ marginBottom: '25px' }}>
                    <label style={{ display: 'block', marginBottom: '8px', fontSize: '12px', fontWeight: 'bold', color: '#ccc' }}>Base Type</label>
                    <div style={{ width: '300px' }}>
                        <DataTypeSelector
                            value={content.baseType || 'INT'}
                            onChange={(val) => update({ baseType: val })}
                            derivedTypes={derivedTypes}
                        // showArrays={false} removed as not in new API, but we might want to filter 'ARRAY' out if base type shouldn't be array
                        // Actually EditorPane passes `derivedTypes` containing 'ARRAY' for ArrayEditor?
                        // In EditorPane I passed `derivedTypes` as is.
                        // Base Type of an Array CAN be another Array (Multi-dimensional).
                        // But usually we define dimensions in the list.
                        // If I select 'ARRAY', what happens?
                        // Let's assume it's allowed.
                        />
                    </div>
                </div>

                {/* DIMENSIONS */}
                <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', marginBottom: '8px', fontSize: '12px', fontWeight: 'bold', color: '#ccc' }}>Dimensions</label>
                    <div style={{ border: '1px solid #333', borderRadius: '4px', overflow: 'hidden' }}>

                        {/* Header */}
                        <div style={{ display: 'flex', background: '#252526', borderBottom: '1px solid #333', padding: '8px 10px', fontSize: '11px', color: '#888', fontWeight: '600' }}>
                            <div style={{ width: '30px', textAlign: 'center' }}>#</div>
                            <div style={{ width: '100px' }}>Min (Integer)</div>
                            <div style={{ width: '20px' }}></div>
                            <div style={{ width: '100px' }}>Max (Integer)</div>
                            <div style={{ flex: 1 }}></div>
                            <div style={{ width: '80px', textAlign: 'right' }}>Actions</div>
                        </div>

                        {/* Rows */}
                        {(content.dimensions || []).map((dim, index) => (
                            <div key={dim.id} style={{
                                display: 'flex', alignItems: 'center', padding: '8px 10px',
                                borderBottom: '1px solid #2a2a2a', background: index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'
                            }}>
                                <span style={{ width: '30px', textAlign: 'center', color: '#666', fontSize: '12px' }}>{index + 1}</span>

                                <input
                                    type="number"
                                    value={dim.min}
                                    onChange={(e) => updateDimension(dim.id, 'min', e.target.value)}
                                    style={{ width: '100px', padding: '6px', background: '#1e1e1e', border: '1px solid #444', color: '#fff', borderRadius: '3px' }}
                                    min="0"
                                />
                                <span style={{ width: '20px', textAlign: 'center', color: '#888' }}>..</span>
                                <input
                                    type="number"
                                    value={dim.max}
                                    onChange={(e) => updateDimension(dim.id, 'max', e.target.value)}
                                    style={{ width: '100px', padding: '6px', background: '#1e1e1e', border: '1px solid #444', color: '#fff', borderRadius: '3px' }}
                                    min="0"
                                />

                                <div style={{ flex: 1 }}></div>

                                {/* CONTROLS */}
                                <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end', width: '80px' }}>
                                    <button
                                        onClick={() => moveDimension(index, 'up')}
                                        disabled={index === 0}
                                        style={{ background: '#333', color: '#fff', border: 'none', cursor: 'pointer', padding: '4px 8px', borderRadius: '3px', opacity: index === 0 ? 0.3 : 1 }}
                                        title="Move Up"
                                    >
                                        ▲
                                    </button>
                                    <button
                                        onClick={() => moveDimension(index, 'down')}
                                        disabled={index === (content.dimensions || []).length - 1}
                                        style={{ background: '#333', color: '#fff', border: 'none', cursor: 'pointer', padding: '4px 8px', borderRadius: '3px', opacity: index === (content.dimensions || []).length - 1 ? 0.3 : 1 }}
                                        title="Move Down"
                                    >
                                        ▼
                                    </button>
                                    <button
                                        onClick={() => removeDimension(dim.id)}
                                        style={{ background: 'transparent', color: '#e55', border: '1px solid #e55', cursor: 'pointer', padding: '4px 8px', borderRadius: '3px', fontWeight: 'bold' }}
                                        title="Remove Dimension"
                                    >
                                        -
                                    </button>
                                </div>
                            </div>
                        ))}

                        <button
                            onClick={addDimension}
                            style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                width: '100%', padding: '8px',
                                background: '#252526', border: 'none', color: '#007acc',
                                cursor: 'pointer', fontWeight: '600', fontSize: '12px',
                                transition: 'background 0.2s'
                            }}
                            onMouseOver={(e) => e.target.style.background = '#2d2d2d'}
                            onMouseOut={(e) => e.target.style.background = '#252526'}
                        >
                            + Add Another Dimension
                        </button>
                    </div>
                </div>

                {/* PREVIEW */}
                <div style={{ marginTop: '20px', padding: '12px', background: '#000', borderRadius: '4px', fontSize: '13px', fontFamily: 'Consolas, monospace', color: '#a6e22e', border: '1px solid #333' }}>
                    <span style={{ color: '#66d9ef' }}>ARRAY</span> [{(content.dimensions || []).map(d => `${d.min}..${d.max}`).join(', ')}] <span style={{ color: '#66d9ef' }}>OF</span> <span style={{ color: '#ae81ff' }}>{content.baseType || 'INT'}</span>;
                </div>
            </div>
        </div>
    );
};

export default ArrayTypeEditor;
