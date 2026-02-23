import React, { useState } from 'react';

const EnumTypeEditor = ({ content, onContentChange }) => {
    // Content structure: { values: [ { id, name, value (optional) } ] }
    const values = content.values || [];

    const update = (newValues) => {
        onContentChange({ ...content, values: newValues });
    };

    const addValue = () => {
        let index = 0;
        let name = `Object${index}`;
        const existingNames = values.map(v => v.name);
        while (existingNames.includes(name)) {
            index++;
            name = `Object${index}`;
        }

        const newValue = {
            id: Date.now(),
            name,
            value: '' // Optional explicit integer value
        };
        update([...values, newValue]);
    };

    const deleteValue = (id) => {
        update(values.filter(v => v.id !== id));
    };

    const moveValue = (index, direction) => {
        const newValues = [...values];
        if (direction === 'up' && index > 0) {
            [newValues[index], newValues[index - 1]] = [newValues[index - 1], newValues[index]];
        } else if (direction === 'down' && index < newValues.length - 1) {
            [newValues[index], newValues[index + 1]] = [newValues[index + 1], newValues[index]];
        }
        update(newValues);
    };

    // --- Validation Logic ---
    // User requirement: If identifier is invalid, revert to previous.
    // We can track focus `onFocus` to store previous.

    const [tempValue, setTempValue] = useState(null); // Helper to store valid state

    const handleFocus = (currentName) => {
        setTempValue(currentName);
    };

    const isValidIdentifier = (name) => {
        return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
    };

    const handleNameChange = (id, newName) => {
        // Allow typing (even invalid intermediate states like numbers being deleted), check on Blur.
        // Actually, if we want strict "don't accept", maybe block invalid chars?
        // User said: "identifier sartina uymazsa (rakamla baslarsa falan...) oncekine donuyorsun"
        // This implies validation ON COMMIT (Blur/Enter).
        update(values.map(v => v.id === id ? { ...v, name: newName } : v));
    };

    const handleBlur = (id, currentName) => {
        if (!isValidIdentifier(currentName)) {
            // Revert
            update(values.map(v => v.id === id ? { ...v, name: tempValue || `Object${values.findIndex(x => x.id === id)}` } : v));
            alert(`Invalid Identifier: "${currentName}". Must start with a letter/underscore and contain only alphanumeric characters.`);
        } else {
            // Valid, check for duplicates?
            // User didn't explicitly ask for dup check here, but it's good practice.
            // We'll skip complex dup check revert for now to stick strictly to user request about "identifier syntax".
        }
        setTempValue(null);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.target.blur(); // Trigger blur validation
        }
    };

    return (
        <div style={{ padding: '20px', color: '#e0e0e0', fontFamily: 'Inter, system-ui, sans-serif' }}>
            <div style={{ marginBottom: '20px', borderBottom: '1px solid #333', paddingBottom: '10px' }}>
                <h3 style={{ margin: 0, fontWeight: 500, color: '#fff' }}>Enumerated Definition</h3>
                <p style={{ margin: '5px 0 0', fontSize: '12px', color: '#888' }}>Define the enumerated values.</p>
            </div>

            <div style={{
                background: '#1e1e1e',
                border: '1px solid #333',
                borderRadius: '6px',
                padding: '0',
                overflow: 'hidden',
                boxShadow: '0 4px 6px rgba(0,0,0,0.2)'
            }}>
                {/* Header */}
                <div style={{ display: 'flex', background: '#252526', borderBottom: '1px solid #333', padding: '10px', fontWeight: '600', fontSize: '12px', color: '#ccc' }}>
                    <div style={{ width: '40px', textAlign: 'center' }}>#</div>
                    <div style={{ flex: 1, paddingLeft: '10px' }}>Identifier</div>
                    <div style={{ width: '100px', paddingLeft: '10px' }}>Value (Optional)</div>
                    <div style={{ width: '80px', textAlign: 'right' }}>Actions</div>
                </div>

                {/* List */}
                <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                    {values.map((item, index) => (
                        <div key={item.id} style={{
                            display: 'flex', alignItems: 'center', padding: '8px 10px',
                            borderBottom: '1px solid #2a2a2a', background: index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'
                        }}>
                            <div style={{ width: '40px', textAlign: 'center', color: '#666', fontSize: '11px' }}>{index + 1}</div>

                            {/* Identifier Input */}
                            <div style={{ flex: 1, paddingRight: '10px' }}>
                                <input
                                    type="text"
                                    value={item.name}
                                    onFocus={() => handleFocus(item.name)}
                                    onChange={(e) => handleNameChange(item.id, e.target.value)}
                                    onBlur={(e) => handleBlur(item.id, e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    style={{
                                        width: '100%', background: 'transparent', border: 'none', borderBottom: '1px solid #444',
                                        color: '#fff', padding: '4px', outline: 'none', transition: 'border-color 0.2s'
                                    }}
                                    onFocusCapture={(e) => { e.target.style.borderColor = '#007acc'; handleFocus(item.name); }}
                                    onBlurCapture={(e) => e.target.style.borderColor = '#444'}
                                />
                            </div>

                            {/* Optional Value */}
                            <div style={{ width: '100px', paddingRight: '10px' }}>
                                <input
                                    type="number"
                                    value={item.value || ''}
                                    placeholder="(Auto)"
                                    onChange={(e) => update(values.map(v => v.id === item.id ? { ...v, value: e.target.value } : v))}
                                    style={{
                                        width: '100%', background: 'transparent', border: 'none', borderBottom: '1px solid #444',
                                        color: '#bbb', padding: '4px', outline: 'none', fontSize: '12px'
                                    }}
                                />
                            </div>

                            {/* Actions */}
                            <div style={{ width: '80px', display: 'flex', justifyContent: 'flex-end', gap: '4px' }}>
                                <button
                                    onClick={() => moveValue(index, 'up')}
                                    disabled={index === 0}
                                    style={{ background: '#333', color: '#fff', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: '3px', opacity: index === 0 ? 0.3 : 1 }}
                                >
                                    ▲
                                </button>
                                <button
                                    onClick={() => moveValue(index, 'down')}
                                    disabled={index === values.length - 1}
                                    style={{ background: '#333', color: '#fff', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: '3px', opacity: index === values.length - 1 ? 0.3 : 1 }}
                                >
                                    ▼
                                </button>
                                <button
                                    onClick={() => deleteValue(item.id)}
                                    style={{ background: 'transparent', color: '#e55', border: 'none', cursor: 'pointer', fontSize: '16px', padding: '0 4px' }}
                                >
                                    ×
                                </button>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Footer */}
                <div style={{ padding: '10px', background: '#252526', borderTop: '1px solid #333' }}>
                    <button
                        onClick={addValue}
                        style={{
                            background: '#007acc', border: 'none', color: 'white',
                            padding: '8px 16px', borderRadius: '4px', cursor: 'pointer',
                            fontSize: '12px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px'
                        }}
                    >
                        <span>+</span> Add Value
                    </button>
                </div>
            </div>

            {/* PREVIEW */}
            <div style={{ marginTop: '20px', padding: '12px', background: '#000', borderRadius: '4px', fontSize: '13px', fontFamily: 'Consolas, monospace', color: '#a6e22e', border: '1px solid #333' }}>
                <span style={{ color: '#66d9ef' }}>TYPE</span> MyEnum : <br />
                &nbsp;&nbsp;(<br />
                {values.map((v, i) => (
                    <span key={v.id}>
                        &nbsp;&nbsp;&nbsp;&nbsp;{v.name}{v.value ? ` := ${v.value}` : ''}{i < values.length - 1 ? ',' : ''}<br />
                    </span>
                ))}
                &nbsp;&nbsp;);<br />
                <span style={{ color: '#66d9ef' }}>END_TYPE</span>
            </div>
        </div>
    );
};

export default EnumTypeEditor;
