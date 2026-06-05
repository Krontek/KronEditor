import React, { useMemo, useState } from 'react';
import VariableManager from './VariableManager';
import { useTranslation } from 'react-i18next';

// POU buckets in projectStructure, with a human label for the overview's Scope column.
const POU_CATS = [
    { key: 'programs', label: 'Program' },
    { key: 'functionBlocks', label: 'Function Block' },
    { key: 'functions', label: 'Function' },
];

const ResourceEditor = ({ content, onContentChange, availablePrograms = [], derivedTypes = [], userDefinedTypes = [], liveVariables = null, isRunning = false, isSimulationMode = false, onForceWrite = null }) => {
    const { t } = useTranslation();
    const [tab, setTab] = useState('globals'); // 'globals' | 'addressed'

    const handleDeleteVar = (id) => {
        const newVars = (content.globalVars || []).filter(v => v.id !== id);
        onContentChange({ ...content, globalVars: newVars });
    };

    const handleUpdateVar = (id, fieldOrObj, value) => {
        const patch = (typeof fieldOrObj === 'string') ? { [fieldOrObj]: value } : fieldOrObj;
        const newVars = (content.globalVars || []).map(v => v.id === id ? { ...v, ...patch } : v);
        onContentChange({ ...content, globalVars: newVars });
    };

    const handleAddVar = (newVar) => {
        const variable = newVar || {
            id: Date.now().toString(),
            name: 'NewVar',
            class: 'Var',
            type: 'BOOL',
            initialValue: '',
            desc: ''
        };
        const newVars = [...(content.globalVars || []), variable];
        onContentChange({ ...content, globalVars: newVars });
    };

    // Collect EVERY addressed variable across the whole project (globals + each
    // POU's locals) into one read-only overview, so "which program has which
    // addressed variable" is visible in one place.
    const addressed = useMemo(() => {
        const ps = content.projectStructure || {};
        const rows = [];
        const push = (scope, kind, v) => {
            const addr = (v?.address != null ? String(v.address) : '').trim();
            if (!addr) return;
            rows.push({ scope, kind, name: v.name || '', type: v.type || '', address: addr });
        };
        (content.globalVars || []).forEach(v => push('Global', 'Global', v));
        POU_CATS.forEach(({ key, label }) => {
            (ps[key] || []).forEach(p => (p.content?.variables || []).forEach(v => push(p.name || '(unnamed)', label, v)));
        });
        rows.sort((a, b) =>
            a.scope.localeCompare(b.scope) ||
            a.address.localeCompare(b.address, undefined, { numeric: true }));
        // Flag addresses used by more than one variable (must be unique on the PLC).
        const counts = rows.reduce((m, r) => (m[r.address] = (m[r.address] || 0) + 1, m), {});
        rows.forEach(r => { r.dup = counts[r.address] > 1; });
        return rows;
    }, [content.globalVars, content.projectStructure]);

    const SectionHeader = ({ title }) => (
        <div style={{
            padding: '5px 10px', background: '#2d2d2d', color: '#ccc', fontSize: '11px',
            fontWeight: 'bold', textTransform: 'uppercase', borderBottom: '1px solid #333'
        }}>
            {title}
        </div>
    );

    const TabBtn = ({ id, children }) => (
        <button
            onClick={() => setTab(id)}
            style={{
                padding: '6px 14px', fontSize: 12, cursor: 'pointer',
                background: tab === id ? '#1e1e1e' : 'transparent',
                color: tab === id ? '#fff' : '#aaa',
                border: 'none', borderBottom: `2px solid ${tab === id ? '#4a90d9' : 'transparent'}`,
                fontWeight: tab === id ? 600 : 400,
            }}>
            {children}
        </button>
    );

    const th = { textAlign: 'left', padding: '6px 10px', position: 'sticky', top: 0, background: '#2d2d2d', color: '#ccc', fontSize: 11, textTransform: 'uppercase', borderBottom: '1px solid #333' };
    const td = { padding: '5px 10px', borderBottom: '1px solid #2a2a2a', color: '#ddd', fontSize: 12, whiteSpace: 'nowrap' };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            {/* Sub-tabs */}
            <div style={{ display: 'flex', alignItems: 'center', background: '#252525', borderBottom: '1px solid #333', flexShrink: 0 }}>
                <TabBtn id="globals">{t('resources.globalVariables') || 'Global Variables'}</TabBtn>
                <TabBtn id="addressed">Addressed Variables{addressed.length ? ` (${addressed.length})` : ''}</TabBtn>
            </div>

            {tab === 'globals' ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <SectionHeader title={t('resources.globalVariables')} />
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                        <VariableManager
                            variables={content.globalVars || []}
                            onDelete={handleDeleteVar}
                            onUpdate={handleUpdateVar}
                            onAdd={handleAddVar}
                            allowedClasses={['Var', 'Constant', 'Retain']}
                            derivedTypes={derivedTypes}
                            userDefinedTypes={userDefinedTypes}
                            liveVariables={liveVariables}
                            disabled={isRunning}
                            isSimulationMode={isSimulationMode}
                            onForceWrite={onForceWrite}
                            projectStructure={content.projectStructure}
                        />
                    </div>
                </div>
            ) : (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <SectionHeader title={`Addressed Variables — all programs (${addressed.length})`} />
                    <div style={{ flex: 1, overflow: 'auto' }}>
                        {addressed.length === 0 ? (
                            <div style={{ padding: 20, color: '#888', fontSize: 12, textAlign: 'center' }}>
                                No addressed variables yet. Give a variable an address (e.g. %MW0) in any program or in the global table.
                            </div>
                        ) : (
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr>
                                        <th style={th}>Address</th>
                                        <th style={th}>Variable</th>
                                        <th style={th}>Type</th>
                                        <th style={th}>Scope</th>
                                        <th style={th}>Kind</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {addressed.map((r, i) => (
                                        <tr key={i} title={r.dup ? 'Duplicate address — must be unique on the PLC' : ''}>
                                            <td style={{ ...td, fontFamily: 'monospace', color: r.dup ? '#f44747' : '#4a90d9', fontWeight: 600 }}>
                                                {r.address}{r.dup ? ' ⚠' : ''}
                                            </td>
                                            <td style={td}>{r.name}</td>
                                            <td style={{ ...td, color: '#9c9c9c' }}>{r.type}</td>
                                            <td style={td}>{r.scope}</td>
                                            <td style={{ ...td, color: '#9c9c9c' }}>{r.kind}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default ResourceEditor;
