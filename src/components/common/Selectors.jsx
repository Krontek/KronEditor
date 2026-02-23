import React, { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';

export const ELEMENTARY_TYPES = [
    'BOOL', 'SINT', 'INT', 'DINT', 'LINT',
    'USINT', 'UINT', 'UDINT', 'ULINT',
    'REAL', 'LREAL', 'TIME', 'DATE', 'TOD', 'DT',
    'STRING', 'WSTRING', 'BYTE', 'WORD', 'DWORD', 'LWORD'
];

export const DataTypeSelector = ({ value, onChange, derivedTypes = [], userDefinedTypes = [] }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [expandedCategories, setExpandedCategories] = useState({
        elementary: false,
        derived: false,
        user: false
    });
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

    // Filter Logic
    const term = searchTerm.toLowerCase();
    const isSearching = term.length > 0;

    // If searching, we might want to auto-expand or just show list. 
    // Usually accordion + search implies filtering within categories or showing flat list.
    // Let's keep categories structure but expand them if they have matches and search term exists.

    const filteredElementary = ELEMENTARY_TYPES.filter(t => t.toLowerCase().includes(term));
    const filteredDerived = derivedTypes.filter(t => t.toLowerCase().includes(term));
    const filteredUser = userDefinedTypes.filter(t => t.toLowerCase().includes(term));

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
                            if (filteredDerived.length > 0) { handleSelect(filteredDerived[0]); return; }
                            if (filteredUser.length > 0) { handleSelect(filteredUser[0]); return; }
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
                    <span>Elementary Types</span>
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

                {/* 2. DERIVED TYPES (UDTs) */}
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
                    <span>Derived Types</span>
                    {!isSearching && <span>{expandedCategories.derived ? '▼' : '►'}</span>}
                </div>
                {showDerived && (
                    <div style={{ padding: '4px 0', background: '#1e1e1e' }}>
                        {filteredDerived.length === 0 && <div style={{ padding: '5px 20px', color: '#666', fontSize: '11px' }}>No derived types</div>}
                        {filteredDerived.map(t => (
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

                {/* 3. USER DEFINED TYPES (FBs) - Only show if prop passed */}
                {userDefinedTypes.length > 0 && (
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
                            <span>User Defined (FB)</span>
                            {!isSearching && <span>{expandedCategories.user ? '▼' : '►'}</span>}
                        </div>
                        {showUser && (
                            <div style={{ padding: '4px 0', background: '#1e1e1e' }}>
                                {filteredUser.length === 0 && <div style={{ padding: '5px 20px', color: '#666', fontSize: '11px' }}>No FBs available</div>}
                                {filteredUser.map(t => (
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
                    </>
                )}

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
