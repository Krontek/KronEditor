import { DataTypeSelector } from './common/Selectors';

const StructureTypeEditor = ({ content, onContentChange, projectStructure, currentId, derivedTypes = [] }) => {
    const members = content.members || [];

    const update = (newMembers) => {
        onContentChange({ ...content, members: newMembers });
    };

    const addMember = () => {
        let index = 0;
        let name = `Var${index}`;
        const existingNames = members.map(m => m.name);
        while (existingNames.includes(name)) {
            index++;
            name = `Var${index}`;
        }

        const newMember = {
            id: Date.now(),
            name,
            type: 'INT',
            initialValue: ''
        };
        update([...members, newMember]);
    };

    const updateMember = (id, field, value) => {
        update(members.map(m => m.id === id ? { ...m, [field]: value } : m));
    };

    const deleteMember = (id) => {
        update(members.filter(m => m.id !== id));
    };

    // Keyboard navigation: Enter on last input adds new row
    const handleKeyDown = (e, index, field) => {
        if (e.key === 'Enter') {
            if (index === members.length - 1 && field === 'initialValue') {
                addMember();
                // Focus will naturally go to the new input if we could ref it, 
                // but React state update is async.
                // For simplified logic, just adding is good.
            }
        }
    };

    return (
        <div style={{ padding: '20px', color: '#e0e0e0', fontFamily: 'Inter, system-ui, sans-serif' }}>
            <div style={{ marginBottom: '20px', borderBottom: '1px solid #333', paddingBottom: '10px' }}>
                <h3 style={{ margin: 0, fontWeight: 500, color: '#fff' }}>Structure Definition</h3>
                <p style={{ margin: '5px 0 0', fontSize: '12px', color: '#888' }}>Define the members of your structure.</p>
            </div>

            <div style={{
                background: '#1e1e1e',
                border: '1px solid #333',
                borderRadius: '6px',
                overflow: 'hidden',
                boxShadow: '0 4px 6px rgba(0,0,0,0.2)'
            }}>
                {/* HEADERS */}
                <div style={{ display: 'flex', background: '#252526', borderBottom: '1px solid #333', padding: '10px', fontWeight: '600', fontSize: '12px', color: '#ccc' }}>
                    <div style={{ width: '40px', textAlign: 'center' }}>#</div>
                    <div style={{ flex: 2, paddingLeft: '10px' }}>Name</div>
                    <div style={{ flex: 2, paddingLeft: '10px' }}>Type</div>
                    <div style={{ flex: 1, paddingLeft: '10px' }}>Initial Value</div>
                    <div style={{ width: '40px' }}></div>
                </div>

                {/* ROWS */}
                <div style={{ maxHeight: 'calc(100vh - 250px)', overflowY: 'auto' }}>
                    {members.map((member, index) => (
                        <div key={member.id} style={{
                            display: 'flex',
                            padding: '8px 10px',
                            alignItems: 'center',
                            borderBottom: '1px solid #2a2a2a',
                            background: index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                            transition: 'background 0.2s'
                        }}>
                            <div style={{ width: '40px', textAlign: 'center', color: '#666', fontSize: '11px' }}>{index + 1}</div>

                            {/* Name */}
                            <div style={{ flex: 2, paddingRight: '10px' }}>
                                <input
                                    type="text"
                                    value={member.name}
                                    onChange={(e) => updateMember(member.id, 'name', e.target.value)}
                                    style={{
                                        width: '100%', background: 'transparent', border: 'none', borderBottom: '1px solid #444',
                                        color: '#fff', padding: '4px', outline: 'none', transition: 'border-color 0.2s'
                                    }}
                                    onFocus={(e) => e.target.style.borderColor = '#007acc'}
                                    onBlur={(e) => e.target.style.borderColor = '#444'}
                                />
                            </div>

                            {/* Type */}
                            <div style={{ flex: 2, paddingRight: '10px' }}>
                                <DataTypeSelector
                                    value={member.type}
                                    onChange={(val) => updateMember(member.id, 'type', val)}
                                    derivedTypes={derivedTypes}
                                />
                            </div>

                            {/* Initial Value */}
                            <div style={{ flex: 1, paddingRight: '10px' }}>
                                <input
                                    type="text"
                                    value={member.initialValue}
                                    onChange={(e) => updateMember(member.id, 'initialValue', e.target.value)}
                                    onKeyDown={(e) => handleKeyDown(e, index, 'initialValue')}
                                    placeholder="Optional"
                                    style={{
                                        width: '100%', background: 'transparent', border: 'none', borderBottom: '1px solid #444',
                                        color: '#bbb', padding: '4px', outline: 'none', fontSize: '12px'
                                    }}
                                    onFocus={(e) => e.target.style.borderColor = '#007acc'}
                                    onBlur={(e) => e.target.style.borderColor = '#444'}
                                />
                            </div>

                            {/* Actions */}
                            <div style={{ width: '40px', display: 'flex', justifyContent: 'center' }}>
                                <button
                                    onClick={() => deleteMember(member.id)}
                                    style={{
                                        background: 'transparent', border: 'none', color: '#666',
                                        cursor: 'pointer', fontSize: '16px', padding: 0,
                                        transition: 'color 0.2s'
                                    }}
                                    onMouseOver={(e) => e.target.style.color = '#e55'}
                                    onMouseOut={(e) => e.target.style.color = '#666'}
                                    title="Delete Member"
                                >
                                    ×
                                </button>
                            </div>
                        </div>
                    ))}

                    {/* Empty State */}
                    {members.length === 0 && (
                        <div style={{ padding: '30px', textAlign: 'center', color: '#666', fontSize: '13px' }}>
                            No members defined. Click "Add Member" to start.
                        </div>
                    )}
                </div>

                {/* Footer Controls */}
                <div style={{ padding: '10px', background: '#252526', borderTop: '1px solid #333' }}>
                    <button
                        onClick={addMember}
                        style={{
                            background: '#007acc',
                            border: 'none',
                            color: 'white',
                            padding: '8px 16px',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: '600',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                        }}
                    >
                        <span>+</span> Add Member
                    </button>
                    <div style={{ marginTop: '5px', fontSize: '10px', color: '#666' }}>
                        Tip: Press Enter in the last Initial Value field to add a new row.
                    </div>
                </div>
            </div>
            {/* PREVIEW */}
            <div style={{ marginTop: '20px', padding: '12px', background: '#000', borderRadius: '4px', fontSize: '13px', fontFamily: 'Consolas, monospace', color: '#a6e22e', border: '1px solid #333' }}>
                <span style={{ color: '#66d9ef' }}>TYPE</span> MyStruct : <br />
                <span style={{ color: '#66d9ef' }}>STRUCT</span><br />
                {members.map(m => (
                    <span key={m.id}>
                        &nbsp;&nbsp;{m.name} : <span style={{ color: '#ae81ff' }}>{m.type}</span>{m.initialValue ? ` := ${m.initialValue}` : ''};<br />
                    </span>
                ))}
                <span style={{ color: '#66d9ef' }}>END_STRUCT</span><br />
                <span style={{ color: '#66d9ef' }}>END_TYPE</span>
            </div>
        </div>
    );
};

export default StructureTypeEditor;
