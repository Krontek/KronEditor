import React from 'react';
import VariableManager from './VariableManager';
import { useTranslation } from 'react-i18next';

const ResourceEditor = ({ content, onContentChange, availablePrograms = [], derivedTypes = [], userDefinedTypes = [], liveVariables = null, isRunning = false }) => {
    const { t } = useTranslation();

    const handleDeleteVar = (id) => {
        const newVars = (content.globalVars || []).filter(v => v.id !== id);
        onContentChange({ ...content, globalVars: newVars });
    };

    const handleUpdateVar = (id, updatedObj) => {
        const newVars = (content.globalVars || []).map(v => v.id === id ? { ...v, ...updatedObj } : v);
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

    const SectionHeader = ({ title }) => (
        <div style={{
            padding: '5px 10px', background: '#2d2d2d', color: '#ccc', fontSize: '11px',
            fontWeight: 'bold', textTransform: 'uppercase', borderBottom: '1px solid #333'
        }}>
            {title}
        </div>
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
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
                    />
                </div>
            </div>
        </div>
    );
};

export default ResourceEditor;
