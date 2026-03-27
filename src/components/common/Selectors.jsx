import React, { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';

export const ELEMENTARY_TYPES = [
    'BOOL', 'SINT', 'INT', 'DINT',
    'USINT', 'UINT', 'UDINT',
    'REAL', 'TIME', 'DATE', 'TOD', 'DT',
    'STRING', 'WSTRING', 'BYTE', 'WORD', 'DWORD'
];

export const STD_BLOCK_TYPES = [
    // Standard Function Blocks
    { name: 'TON', category: 'Standard Function Blocks / Timers' },
    { name: 'TOF', category: 'Standard Function Blocks / Timers' },
    { name: 'TP', category: 'Standard Function Blocks / Timers' },
    { name: 'TONR', category: 'Standard Function Blocks / Timers' },
    { name: 'CTU', category: 'Standard Function Blocks / Counters' },
    { name: 'CTD', category: 'Standard Function Blocks / Counters' },
    { name: 'CTUD', category: 'Standard Function Blocks / Counters' },

    // Bit Logic Operations
    { name: 'R_TRIG', category: 'Bit Logic Operations / Edge Detectors' },
    { name: 'F_TRIG', category: 'Bit Logic Operations / Edge Detectors' },
    { name: 'SR', category: 'Bit Logic Operations / Bistables' },
    { name: 'RS', category: 'Bit Logic Operations / Bistables' },
    { name: 'BAND', category: 'Bit Logic Operations / Bitwise Operations' },
    { name: 'BOR', category: 'Bit Logic Operations / Bitwise Operations' },
    { name: 'BXOR', category: 'Bit Logic Operations / Bitwise Operations' },
    { name: 'BNOT', category: 'Bit Logic Operations / Bitwise Operations' },
    { name: 'SHL', category: 'Bit Logic Operations / Bitwise Operations' },
    { name: 'SHR', category: 'Bit Logic Operations / Bitwise Operations' },
    { name: 'ROL', category: 'Bit Logic Operations / Bitwise Operations' },
    { name: 'ROR', category: 'Bit Logic Operations / Bitwise Operations' },

    // Mathematical Functions
    { name: 'ADD', category: 'Mathematical Functions / Basic Math' },
    { name: 'SUB', category: 'Mathematical Functions / Basic Math' },
    { name: 'MUL', category: 'Mathematical Functions / Basic Math' },
    { name: 'DIV', category: 'Mathematical Functions / Basic Math' },
    { name: 'MOD', category: 'Mathematical Functions / Basic Math' },
    { name: 'MOVE', category: 'Mathematical Functions / Basic Math' },
    { name: 'ABS', category: 'Mathematical Functions / Floating Point' },
    { name: 'SQRT', category: 'Mathematical Functions / Floating Point' },
    { name: 'EXPT', category: 'Mathematical Functions / Floating Point' },
    { name: 'SIN', category: 'Mathematical Functions / Trigonometry' },
    { name: 'COS', category: 'Mathematical Functions / Trigonometry' },
    { name: 'TAN', category: 'Mathematical Functions / Trigonometry' },
    { name: 'ASIN', category: 'Mathematical Functions / Trigonometry' },
    { name: 'ACOS', category: 'Mathematical Functions / Trigonometry' },
    { name: 'ATAN', category: 'Mathematical Functions / Trigonometry' },

    // Comparison & Selection
    { name: 'GT', category: 'Comparison & Selection / Comparison' },
    { name: 'GE', category: 'Comparison & Selection / Comparison' },
    { name: 'EQ', category: 'Comparison & Selection / Comparison' },
    { name: 'NE', category: 'Comparison & Selection / Comparison' },
    { name: 'LE', category: 'Comparison & Selection / Comparison' },
    { name: 'LT', category: 'Comparison & Selection / Comparison' },
    { name: 'SEL', category: 'Comparison & Selection / Selection' },
    { name: 'MUX', category: 'Comparison & Selection / Selection' },
    { name: 'LIMIT', category: 'Comparison & Selection / Selection' },
    { name: 'MAX', category: 'Comparison & Selection / Selection' },
    { name: 'MIN', category: 'Comparison & Selection / Selection' }
];

export const DataTypeSelector = ({ value, onChange, derivedTypes = [], userDefinedTypes = [] }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [expandedCategories, setExpandedCategories] = useState({
        elementary: false,
        derived: false,
        user: false
    });
    const [expandedUserMain, setExpandedUserMain] = useState({});
    const [expandedUserSub, setExpandedUserSub] = useState({});
    const [coords, setCoords] = useState({ top: 0, left: 0, width: 0 });
    const containerRef = useRef(null);
    const searchInputRef = useRef(null);
    const uniqueId = useRef('dt-select-' + Math.random().toString(36).substr(2, 9)).current;

    useEffect(() => {
        const handleClickOutside = (event) => {
            const dropdownEl = document.getElementById(`dropdown-portal-${containerRef.current?.id}`);
            if (
                containerRef.current &&
                !containerRef.current.contains(event.target) &&
                (!dropdownEl || !dropdownEl.contains(event.target))
            ) {
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            setTimeout(() => {
                if (searchInputRef.current) searchInputRef.current.focus();
            }, 50);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    const toggleOpen = () => {
        if (!isOpen && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            setCoords({
                top: rect.bottom + 2,
                left: rect.left,
                width: Math.max(rect.width, 240) // Min width 240px
            });
            setSearchTerm('');
            // Reset categories to closed on open? Or keep state? User said "acik gelmesin" (should not come open).
            // So defaults reset to false.
            setExpandedCategories({
                elementary: false,
                derived: false,
                user: false
            });
            setExpandedUserMain({});
            setExpandedUserSub({});
            setIsOpen(true);
        } else {
            setIsOpen(false);
        }
    };

    const handleSelect = (type) => {
        onChange(type);
        setIsOpen(false);
    };

    const toggleCategory = (cat) => {
        setExpandedCategories(prev => ({
            ...prev,
            [cat]: !prev[cat]
        }));
    };

    const toggleUserMain = (cat) => {
        setExpandedUserMain(prev => ({
            ...prev,
            [cat]: !prev[cat]
        }));
    };

    const toggleUserSub = (subCat) => {
        setExpandedUserSub(prev => ({
            ...prev,
            [subCat]: !prev[subCat]
        }));
    };

    // Filter Logic
    const term = searchTerm.toLowerCase();
    const isSearching = term.length > 0;

    // If searching, we might want to auto-expand or just show list. 
    // Usually accordion + search implies filtering within categories or showing flat list.
    // Let's keep categories structure but expand them if they have matches and search term exists.

    const filteredElementary = ELEMENTARY_TYPES.filter(t => t.toLowerCase().includes(term));

    // Explicitly separate Standard Library vs User Defined
    const standardBlocksMap = new Map();
    STD_BLOCK_TYPES.forEach(b => {
        standardBlocksMap.set(b.name, { name: b.name, category: b.category, type: 'FunctionBlocks', isStandard: true });
    });

    const userBlocks = [];
    userDefinedTypes.forEach(b => {
        if (typeof b === 'string') {
            userBlocks.push({ name: b, category: 'FunctionBlocks', type: 'FunctionBlocks', isStandard: false });
            return;
        }

        // If it has an 'id', it was created by the user in this project
        if (b.id) {
            userBlocks.push({ name: b.name, category: b.category || 'FunctionBlocks', type: b.type || 'FunctionBlocks', isStandard: false });
        } else {
            // It comes from the dynamically loaded standard library
            if (!standardBlocksMap.has(b.name)) {
                standardBlocksMap.set(b.name, { name: b.name, category: b.category || 'Standard FBs', type: 'FunctionBlocks', isStandard: true });
            }
        }
    });

    const standardBlocks = Array.from(standardBlocksMap.values());

    const projectDefined = {
        Arrays: [],
        Enums: [],
        Structs: [],
        Functions: [],
        FunctionBlocks: []
    };

    const allDerivedTypes = derivedTypes.map(d => typeof d === 'string' ? { name: d, type: 'Unknown' } : d);

    allDerivedTypes.forEach(d => {
        if (d.type === 'Array') projectDefined.Arrays.push(d.name);
        else if (d.type === 'Enumerated') projectDefined.Enums.push(d.name);
        else if (d.type === 'Structure') projectDefined.Structs.push(d.name);
        else projectDefined.Arrays.push(d.name); // Fallback if VariableManager still passes strings
    });

    // Only user blocks go to Derived -> Functions/FunctionBlocks
    userBlocks.forEach(u => {
        if (u.type === 'functions' || u.type === 'Function') projectDefined.Functions.push(u.name);
        else projectDefined.FunctionBlocks.push(u.name);
    });

    const filteredProjectDefined = {};
    Object.entries(projectDefined).forEach(([k, v]) => {
        const matching = v.filter(name => name.toLowerCase().includes(term));
        if (matching.length > 0) filteredProjectDefined[k] = matching;
    });

    // Only standard blocks go to structuredUserTypes (FunctionBlock section)
    const structuredUserTypes = {};
    standardBlocks.forEach(curr => {
        if (!curr.name.toLowerCase().includes(term)) return;
        const parts = curr.category ? curr.category.split(' / ') : ['FunctionBlocks'];
        const mainCat = parts[0];
        const subCat = parts.length > 1 ? parts[1] : null;

        if (!structuredUserTypes[mainCat]) structuredUserTypes[mainCat] = { items: [], subCats: {} };

        if (subCat) {
            if (!structuredUserTypes[mainCat].subCats[subCat]) structuredUserTypes[mainCat].subCats[subCat] = [];
            if (!structuredUserTypes[mainCat].subCats[subCat].includes(curr.name)) {
                structuredUserTypes[mainCat].subCats[subCat].push(curr.name);
            }
        } else {
            if (!structuredUserTypes[mainCat].items.includes(curr.name)) {
                structuredUserTypes[mainCat].items.push(curr.name);
            }
        }
    });

    // Auto-expand if searching
    const showElementary = isSearching || expandedCategories.elementary;
    const showDerived = isSearching || expandedCategories.derived;
    const showUser = isSearching || expandedCategories.user;

    const dropdownContent = (
        <div
            id={`dropdown-portal-${uniqueId}`}
            style={{
                position: 'fixed',
                top: coords.top,
                left: coords.left,
                width: coords.width,
                background: '#252526',
                border: '1px solid #454545',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                zIndex: 9999,
                maxHeight: '400px',
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 4,
                overflow: 'hidden'
            }}
        >
            {/* Search Input */}
            <div style={{ padding: '6px', borderBottom: '1px solid #333', background: '#333' }}>
                <input
                    ref={searchInputRef}
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search type..."
                    style={{
                        width: '100%',
                        padding: '6px 8px',
                        background: '#1e1e1e',
                        border: '1px solid #444',
                        borderRadius: '3px',
                        color: '#fff',
                        fontSize: '12px',
                        outline: 'none',
                        boxSizing: 'border-box'
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            if (filteredElementary.length > 0) { handleSelect(filteredElementary[0]); return; }
                            // First project defined item
                            const projKeys = Object.keys(filteredProjectDefined);
                            if (projKeys.length > 0 && filteredProjectDefined[projKeys[0]].length > 0) {
                                handleSelect(filteredProjectDefined[projKeys[0]][0]); return;
                            }
                            // First standard item
                            const stdKeys = Object.keys(structuredUserTypes);
                            if (stdKeys.length > 0 && structuredUserTypes[stdKeys[0]].items.length > 0) {
                                handleSelect(structuredUserTypes[stdKeys[0]].items[0]); return;
                            }
                        }
                    }}
                />
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>

                {/* 1. ELEMENTARY TYPES */}
                <div
                    onClick={() => !isSearching && toggleCategory('elementary')}
                    style={{
                        padding: '6px 10px',
                        background: '#333',
                        borderBottom: '1px solid #2d2d2d',
                        color: '#eee',
                        fontSize: '11px',
                        fontWeight: 'bold',
                        cursor: isSearching ? 'default' : 'pointer',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                    }}
                >
                    <span>Elementary</span>
                    {!isSearching && <span>{expandedCategories.elementary ? '▼' : '►'}</span>}
                </div>
                {showElementary && (
                    <div style={{ padding: '4px 0', background: '#1e1e1e' }}>
                        {filteredElementary.map(t => (
                            <div
                                key={t}
                                onClick={() => handleSelect(t)}
                                style={{
                                    padding: '6px 20px',
                                    cursor: 'pointer',
                                    fontSize: '13px',
                                    color: value === t ? '#4ec9b0' : '#ccc',
                                    background: value === t ? '#2d2d2d' : 'transparent',
                                    fontFamily: 'Consolas, monospace'
                                }}
                                onMouseEnter={(e) => e.target.style.background = '#2d2d2d'}
                                onMouseLeave={(e) => e.target.style.background = value === t ? '#2d2d2d' : 'transparent'}
                            >
                                {t}
                            </div>
                        ))}
                    </div>
                )}

                {/* 2. PROJECT DEFINED TYPES */}
                <>
                    <div
                        onClick={() => !isSearching && toggleCategory('derived')}
                        style={{
                            padding: '6px 10px',
                            background: '#333',
                            borderBottom: '1px solid #2d2d2d',
                            borderTop: '1px solid #2d2d2d',
                            color: '#eee',
                            fontSize: '11px',
                            fontWeight: 'bold',
                            cursor: isSearching ? 'default' : 'pointer',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                        }}
                    >
                        <span>Derived</span>
                        {!isSearching && <span>{showDerived ? '▼' : '►'}</span>}
                    </div>
                    {showDerived && (
                        <div style={{ padding: '0', background: '#1e1e1e' }}>
                            {Object.keys(filteredProjectDefined).length === 0 && <div style={{ padding: '5px 20px', color: '#666', fontSize: '11px' }}>No project types</div>}

                            {Object.entries(filteredProjectDefined).map(([subCat, blocks]) => {
                                const isSubExpanded = isSearching || expandedUserSub[`proj-${subCat}`];
                                return (
                                    <div key={subCat}>
                                        <div
                                            onClick={() => !isSearching && toggleUserSub(`proj-${subCat}`)}
                                            style={{
                                                padding: '4px 15px',
                                                color: '#888',
                                                fontSize: '11px',
                                                fontWeight: 'bold',
                                                textTransform: 'uppercase',
                                                background: '#252526',
                                                borderBottom: '1px solid #333',
                                                cursor: isSearching ? 'default' : 'pointer',
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                alignItems: 'center'
                                            }}
                                        >
                                            <span>{subCat}</span>
                                            {!isSearching && <span>{isSubExpanded ? '▼' : '►'}</span>}
                                        </div>

                                        {isSubExpanded && blocks.map(t => (
                                            <div
                                                key={t}
                                                onClick={() => handleSelect(t)}
                                                style={{
                                                    padding: '6px 20px',
                                                    cursor: 'pointer',
                                                    fontSize: '13px',
                                                    color: value === t ? '#4ec9b0' : '#ccc',
                                                    background: value === t ? '#2d2d2d' : 'transparent',
                                                    fontFamily: 'Consolas, monospace'
                                                }}
                                                onMouseEnter={(e) => e.target.style.background = '#2d2d2d'}
                                                onMouseLeave={(e) => e.target.style.background = value === t ? '#2d2d2d' : 'transparent'}
                                            >
                                                {t}
                                            </div>
                                        ))}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </>

                {/* 3. FUNCTION BLOCKS (STANDARD) */}
                <>
                    <div
                        onClick={() => !isSearching && toggleCategory('user')}
                        style={{
                            padding: '6px 10px',
                            background: '#333',
                            borderBottom: '1px solid #2d2d2d',
                            borderTop: '1px solid #2d2d2d',
                            color: '#eee',
                            fontSize: '11px',
                            fontWeight: 'bold',
                            cursor: isSearching ? 'default' : 'pointer',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                        }}
                    >
                        <span>FunctionBlock</span>
                        {!isSearching && <span>{showUser ? '▼' : '►'}</span>}
                    </div>
                    {showUser && (
                        <div style={{ padding: '0', background: '#1e1e1e' }}>
                            {Object.keys(structuredUserTypes).length === 0 && <div style={{ padding: '5px 20px', color: '#666', fontSize: '11px' }}>No standard function blocks</div>}
                            {Object.entries(structuredUserTypes).map(([mainCat, data]) => {
                                const isMainExpanded = isSearching || expandedUserMain[mainCat];
                                return (
                                    <div key={mainCat}>
                                        <div
                                            onClick={() => !isSearching && toggleUserMain(mainCat)}
                                            style={{
                                                padding: '4px 15px',
                                                color: '#888',
                                                fontSize: '11px',
                                                fontWeight: 'bold',
                                                textTransform: 'uppercase',
                                                background: '#252526',
                                                borderBottom: '1px solid #333',
                                                cursor: isSearching ? 'default' : 'pointer',
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                alignItems: 'center'
                                            }}
                                        >
                                            <span>{mainCat}</span>
                                            {!isSearching && <span>{isMainExpanded ? '▼' : '►'}</span>}
                                        </div>

                                        {isMainExpanded && data.items.map(t => (
                                            <div
                                                key={t}
                                                onClick={() => handleSelect(t)}
                                                style={{
                                                    padding: '6px 20px',
                                                    cursor: 'pointer',
                                                    fontSize: '13px',
                                                    color: value === t ? '#4ec9b0' : '#ccc',
                                                    background: value === t ? '#2d2d2d' : 'transparent',
                                                    fontFamily: 'Consolas, monospace'
                                                }}
                                                onMouseEnter={(e) => e.target.style.background = '#2d2d2d'}
                                                onMouseLeave={(e) => e.target.style.background = value === t ? '#2d2d2d' : 'transparent'}
                                            >
                                                {t}
                                            </div>
                                        ))}

                                        {isMainExpanded && Object.entries(data.subCats).map(([subCat, blocks]) => {
                                            const subCatKey = `${mainCat}-${subCat}`;
                                            const isSubExpanded = isSearching || expandedUserSub[subCatKey];
                                            return (
                                                <div key={subCatKey}>
                                                    <div
                                                        onClick={() => !isSearching && toggleUserSub(subCatKey)}
                                                        style={{
                                                            padding: '4px 25px',
                                                            color: '#aaa',
                                                            fontSize: '10px',
                                                            background: '#2a2a2a',
                                                            borderBottom: '1px solid #333',
                                                            cursor: isSearching ? 'default' : 'pointer',
                                                            display: 'flex',
                                                            justifyContent: 'space-between',
                                                            alignItems: 'center'
                                                        }}
                                                    >
                                                        <span>{subCat}</span>
                                                        {!isSearching && <span>{isSubExpanded ? '▼' : '►'}</span>}
                                                    </div>
                                                    {isSubExpanded && blocks.map(t => (
                                                        <div
                                                            key={t}
                                                            onClick={() => handleSelect(t)}
                                                            style={{
                                                                padding: '6px 35px',
                                                                cursor: 'pointer',
                                                                fontSize: '13px',
                                                                color: value === t ? '#4ec9b0' : '#ccc',
                                                                background: value === t ? '#2d2d2d' : 'transparent',
                                                                fontFamily: 'Consolas, monospace'
                                                            }}
                                                            onMouseEnter={(e) => e.target.style.background = '#2d2d2d'}
                                                            onMouseLeave={(e) => e.target.style.background = value === t ? '#2d2d2d' : 'transparent'}
                                                        >
                                                            {t}
                                                        </div>
                                                    ))}
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </>


            </div>
        </div>
    );

    return (
        <div ref={containerRef} id={uniqueId} style={{ position: 'relative', width: '100%' }}>
            <div
                onClick={toggleOpen}
                style={{
                    cursor: 'pointer',
                    padding: '6px 10px',
                    color: '#4ec9b0', // VS Code Type Color
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    border: isOpen ? '1px solid #007acc' : '1px solid #444',
                    background: isOpen ? '#1e1e1e' : '#252526',
                    borderRadius: 3,
                    fontFamily: 'Consolas, monospace',
                    fontSize: '13px'
                }}
            >
                <span>{value || 'Select Type...'}</span>
                <span style={{ fontSize: '10px', color: '#888' }}>▼</span>
            </div>
            {isOpen && ReactDOM.createPortal(dropdownContent, document.body)}
        </div>
    );
};

export const ModernSelect = ({ value, options, onChange, color = '#ce9178' }) => {
    // Keep ModernSelect mostly same but improve visuals if needed
    // For now simple pass through but better border coloring
    const [isOpen, setIsOpen] = useState(false);
    const [coords, setCoords] = useState({ top: 0, left: 0, width: 0 });
    const containerRef = useRef(null);
    const uniqueId = useRef('mod-select-' + Math.random().toString(36).substr(2, 9)).current;

    useEffect(() => {
        const handleClickOutside = (event) => {
            const dropdownEl = document.getElementById(`dropdown-portal-${containerRef.current?.id}`);
            if (
                containerRef.current &&
                !containerRef.current.contains(event.target) &&
                (!dropdownEl || !dropdownEl.contains(event.target))
            ) {
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    const toggleOpen = () => {
        if (!isOpen && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            setCoords({
                top: rect.bottom + 2,
                left: rect.left,
                width: Math.max(rect.width, 100)
            });
            setIsOpen(true);
        } else {
            setIsOpen(false);
        }
    };

    const handleSelect = (val) => {
        onChange(val);
        setIsOpen(false);
    };

    const dropdownContent = (
        <div
            id={`dropdown-portal-${uniqueId}`}
            style={{
                position: 'fixed',
                top: coords.top,
                left: coords.left,
                width: coords.width,
                background: '#252526',
                border: '1px solid #454545',
                boxShadow: '0 4px 6px rgba(0,0,0,0.5)',
                zIndex: 9999,
                maxHeight: '300px',
                overflowY: 'auto',
                borderRadius: 4
            }}
        >
            {options.map(opt => (
                <div
                    key={opt}
                    onClick={() => handleSelect(opt)}
                    style={{
                        padding: '6px 8px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        color: value === opt ? color : '#ccc',
                        background: value === opt ? '#2a2d2e' : 'transparent',
                        borderBottom: '1px solid #333'
                    }}
                    onMouseEnter={(e) => e.target.style.background = '#2a2d2e'}
                    onMouseLeave={(e) => e.target.style.background = value === opt ? '#2a2d2e' : 'transparent'}
                >
                    {opt}
                </div>
            ))}
        </div>
    );

    return (
        <div ref={containerRef} id={uniqueId} style={{ position: 'relative', width: '100%' }}>
            <div
                onClick={toggleOpen}
                style={{
                    cursor: 'pointer',
                    padding: '6px 8px', // Matched padding
                    color: color,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    border: isOpen ? '1px solid #007acc' : '1px solid #444',
                    background: isOpen ? '#1e1e1e' : '#252526',
                    borderRadius: 3,
                    fontSize: '13px'
                }}
            >
                <span>{value}</span>
                <span style={{ fontSize: '10px', color: '#888' }}>▼</span>
            </div>
            {isOpen && ReactDOM.createPortal(dropdownContent, document.body)}
        </div>
    );
};
