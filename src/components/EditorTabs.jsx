import { useRef, useEffect } from 'react';

const EditorTabs = ({ tabs = [], activeId, onActivate, onClose }) => {
    const scrollRef = useRef(null);
    const activeTabRef = useRef(null);

    // Auto-scroll active tab into view
    useEffect(() => {
        if (activeTabRef.current && scrollRef.current) {
            activeTabRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
    }, [activeId]);

    if (!tabs || tabs.length === 0) return null;

    return (
        <div
            ref={scrollRef}
            style={{
                display: 'flex',
                background: '#252526',
                borderBottom: '1px solid #1e1e1e',
                overflowX: 'auto',
                overflowY: 'hidden',
                flexShrink: 0,
                height: 34,
                scrollbarWidth: 'none',
                msOverflowStyle: 'none',
            }}
        >
            {tabs.map(tab => {
                const isActive = tab.id === activeId;
                return (
                    <div
                        key={tab.id}
                        ref={isActive ? activeTabRef : null}
                        onClick={() => onActivate(tab.id)}
                        onAuxClick={(e) => { if (e.button === 1) onClose(tab.id); }}
                        title={tab.label}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '0 6px 0 10px',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                            fontSize: 12,
                            color: isActive ? '#fff' : '#999',
                            background: isActive ? '#1e1e1e' : '#2d2d2d',
                            borderRight: '1px solid #1e1e1e',
                            borderTop: isActive ? '1px solid #007acc' : '1px solid transparent',
                            boxSizing: 'border-box',
                            flexShrink: 0,
                            userSelect: 'none',
                            minWidth: 80,
                            maxWidth: 200,
                        }}
                    >
                        <span style={{ fontSize: 13, flexShrink: 0 }}>{tab.icon}</span>
                        <span style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            flex: 1,
                            minWidth: 0,
                        }}>
                            {tab.label}
                        </span>
                        <button
                            onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                            title="Close"
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: isActive ? '#aaa' : 'transparent',
                                cursor: 'pointer',
                                fontSize: 14,
                                padding: '0 2px',
                                lineHeight: 1,
                                borderRadius: 3,
                                flexShrink: 0,
                                width: 18,
                                height: 18,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.color = '#fff';
                                e.currentTarget.style.background = '#c42b1c';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.color = isActive ? '#aaa' : 'transparent';
                                e.currentTarget.style.background = 'transparent';
                            }}
                        >
                            ×
                        </button>
                    </div>
                );
            })}
        </div>
    );
};

export default EditorTabs;
