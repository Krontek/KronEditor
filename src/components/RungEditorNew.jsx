import React, { useState, useCallback, useRef, useEffect } from 'react';
import RungContainer, { blockConfig } from './RungContainer';
import ErrorBoundary from './ErrorBoundary';
import BlockSettingsModal from './BlockSettingsModal';
import DraggableBlock from './DraggableBlock';

/**
 * YENİ LADDER EDITOR MİMARİ
 * - Rung'lar bir liste olarak düzenleniyor
 * - Her rung'ın kendi blokları ve bağlantıları var
 * - Rung hareket ederken, içindeki her şey beraber hareket ediyor
 */

const RungEditorNew = ({ variables, setVariables, rungs, setRungs, availableBlocks, globalVars = [] }) => {
  // Rungs listesi artık prop olarak geliyor: { id, blocks: [...], connections: [...], label }

  // Undo/Redo history
  const [history, setHistory] = useState([[]]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // Settings modal state
  const [editingBlock, setEditingBlock] = useState(null); // { rungId, blockId, data }

  // History yönetimi
  const saveHistory = useCallback((newRungs) => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(JSON.parse(JSON.stringify(newRungs))); // Deep copy
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  }, [history, historyIndex]);

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      setRungs(JSON.parse(JSON.stringify(history[historyIndex - 1])));
    }
  }, [historyIndex, history]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(historyIndex + 1);
      setRungs(JSON.parse(JSON.stringify(history[historyIndex + 1])));
    }
  }, [historyIndex, history]);

  // Keyboard Shortcuts for Undo/Redo
  useEffect(() => {
    const handleKeyDown = (e) => {
      // CMD/CTRL + Z
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();

        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  // Blok verisini güncelleme
  const updateBlockData = useCallback((rungId, blockId, newData) => {
    // 1. Rungs State güncellemesi
    setRungs(prevRungs => prevRungs.map(rung => {
      if (rung.id === rungId) {
        return {
          ...rung,
          blocks: rung.blocks.map(b => {
            if (b.id === blockId) {
              return {
                ...b,
                data: { ...b.data, ...newData }
              };
            }
            return b;
          })
        };
      }
      return rung;
    }));

    // 2. Variables State güncellemesi (Eğer instanceName değiştiyse)
    if (newData.instanceName) {
      setVariables(prevVars => prevVars.map(v =>
        v.id === blockId ? { ...v, name: newData.instanceName } : v
      ));
    }
  }, []);

  // Blok pozisyonunu güncelleme
  const updateBlockPosition = useCallback((rungId, blockId, position) => {
    setRungs(prevRungs => prevRungs.map(rung => {
      if (rung.id === rungId) {
        return {
          ...rung,
          blocks: rung.blocks.map(b => {
            if (b.id === blockId) {
              return { ...b, position };
            }
            return b;
          })
        };
      }
      return rung;
    }));
  }, []);

  // Blok çift tıklandığında ayarları aç
  const handleNodeDoubleClick = useCallback((event, node, rungId) => {
    // Sadece bloklara çift tıklanınca (terminal değil)
    setEditingBlock({
      rungId,
      id: node.id,
      type: node.data.type,
      ...node.data
    });
  }, []);

  // Ayarları kaydet
  const handleSaveSettings = useCallback((blockId, newSettings) => {
    if (!editingBlock) return;

    updateBlockData(editingBlock.rungId, blockId, newSettings);
    setEditingBlock(null);
  }, [editingBlock, updateBlockData]);

  // Rung ekleme
  const addRung = useCallback(() => {
    const newRung = {
      id: `rung_${Date.now()}_${Math.random()}`,
      label: String(rungs.length).padStart(3, '0'),
      blocks: [],
      connections: []
    };
    const newRungs = [...rungs, newRung];
    setRungs(newRungs);
    saveHistory(newRungs);
  }, [rungs, saveHistory]);

  // Rung silme
  const deleteRung = useCallback((rungId) => {
    const newRungs = rungs.filter(r => r.id !== rungId);
    setRungs(newRungs);
    saveHistory(newRungs);
  }, [rungs, saveHistory]);

  // Rung'lar arasında taşıma (yukarı/aşağı)
  const moveRung = useCallback((rungId, direction) => {
    const idx = rungs.findIndex(r => r.id === rungId);
    if (direction === 'up' && idx <= 0) return;
    if (direction === 'down' && idx >= rungs.length - 1) return;

    const newRungs = [...rungs];
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    [newRungs[idx], newRungs[swapIdx]] = [newRungs[swapIdx], newRungs[idx]];
    setRungs(newRungs);
    saveHistory(newRungs);
  }, [rungs, saveHistory]);

  // HELPER: Safely Insert Block into Rung (Pure logic)
  const insertBlock = useCallback((rungId, blockType, position, instanceName, customData) => {
    const blockId = `block_${Date.now()}_${Math.random()}`;

    const newBlock = {
      id: blockId,
      type: blockType,
      position: position,
      data: {
        label: blockType === 'UserDefined' ? customData?.name : blockType,
        instanceName: instanceName,
        customData: customData
      }
    };

    setRungs(prevRungs => {
      const newRungs = prevRungs.map(rung => {
        if (rung.id === rungId) {
          return { ...rung, blocks: [...rung.blocks, newBlock] };
        }
        return rung;
      });
      saveHistory(newRungs);
      return newRungs;
    });
  }, [setRungs, saveHistory]);

  // Main Add Block Handler
  const addBlockToRung = useCallback((rungId, blockType, position, customData = null) => {
    if (!position) return;

    // 1. CONTACT / COIL LOGIC (Smart Selection via Inline UI)
    if (blockType === 'Contact' || blockType === 'Coil') {
      const allVars = [
        ...variables.map(v => ({ ...v, scope: 'Local' })),
        ...globalVars.map(v => ({ ...v, scope: 'Global' }))
      ];
      const boolVars = allVars.filter(v => v.type === 'BOOL');

      // Case A: No BOOL variables exist -> Auto-create Var0 and Assign
      if (boolVars.length === 0) {
        let index = 0;
        let newName = '';
        while (true) {
          const candidate = `Var${index}`;
          const exists = allVars.some(v => v.name === candidate);
          if (!exists) {
            newName = candidate;
            break;
          }
          index++;
          if (index > 1000) { console.error("Loop safety break"); break; } // Safety
        }

        const varClass = blockType === 'Contact' ? 'Input' : 'Output';
        setVariables(prev => [...prev, {
          id: `created_var_${Date.now()}`,
          name: newName,
          class: 'Local',
          type: 'BOOL',
          location: '',
          initialValue: '',
          description: ''
        }]);

        insertBlock(rungId, blockType, position, newName, customData);
      }
      // Case B: BOOL variables exist -> Insert blank/placeholder for inline selection
      else {
        // We pass empty string as instanceName. The Block UI will show '??' and inputs.
        insertBlock(rungId, blockType, position, '', customData);
      }
      return;
    }

    // 2. OTHER BLOCKS (Standard / UserDefined) - Auto Naming
    let instanceName;
    if (customData) {
      if (customData.type === 'functions') {
        instanceName = customData.name;
      } else {
        // Function Block Instance
        let index = 0;
        while (true) {
          const candidateName = `${customData.name}_${index}`;
          const exists = variables.some(v => v.name === candidateName) || (globalVars || []).some(v => v.name === candidateName);
          if (!exists) {
            instanceName = candidateName;
            break;
          }
          index++;
          if (index > 1000) { console.error("Loop safety break"); break; } // Safety
        }

        setVariables(prev => [...prev, {
          id: `fb_inst_${Date.now()}`,
          name: instanceName,
          class: 'Local',
          type: customData.name,
          location: '',
          initialValue: '',
          description: 'FB Instance'
        }]);
      }
    } else {
      // Standard Blocks (TON, CTU, etc.)
      let index = 0;
      while (true) {
        const candidate = `${blockType}${index}`;
        const exists = variables.some(v => v.name === candidate) || (globalVars || []).some(v => v.name === candidate);
        if (!exists) {
          instanceName = candidate;
          break;
        }
        index++;
        if (index > 1000) { console.error("Loop safety break"); break; } // Safety
      }
      setVariables(prev => [...prev, {
        id: `std_inst_${Date.now()}`,
        name: instanceName,
        class: 'Local',
        type: blockType,
        location: '',
        initialValue: '',
        description: ''
      }]);
    }

    insertBlock(rungId, blockType, position, instanceName, customData);
  }, [variables, globalVars, insertBlock, setVariables]);

  // Rung'dan blok silme
  const deleteBlockFromRung = useCallback((rungId, blockId) => {
    let blockToDelete = null;
    const newRungs = rungs.map(rung => {
      if (rung.id === rungId) {
        blockToDelete = rung.blocks.find(b => b.id === blockId);
        return {
          ...rung,
          blocks: rung.blocks.filter(b => b.id !== blockId),
          connections: rung.connections.filter(c => c.source !== blockId && c.target !== blockId)
        };
      }
      return rung;
    });
    setRungs(newRungs);
    saveHistory(newRungs);

    // Remove the associated variable if it's no longer used by any block
    if (blockToDelete && blockToDelete.data && blockToDelete.data.instanceName) {
      const instanceName = blockToDelete.data.instanceName;
      const isUsedElsewhere = newRungs.some(r =>
        r.blocks.some(b => b.data && b.data.instanceName === instanceName)
      );

      if (!isUsedElsewhere) {
        setVariables(prev => prev.filter(v => v.name !== instanceName));
      }
    }
  }, [rungs, saveHistory, setVariables]);

  // Rung'a bağlantı ekleme
  const addConnectionToRung = useCallback((rungId, connection) => {
    const newRungs = rungs.map(rung => {
      if (rung.id === rungId) {
        return {
          ...rung,
          connections: [...rung.connections, {
            id: `conn_${Date.now()}_${Math.random()}`,
            ...connection
          }]
        };
      }
      return rung;
    });
    setRungs(newRungs);
    saveHistory(newRungs);
  }, [rungs, saveHistory]);

  // Rung'dan bağlantı silme
  const deleteConnectionFromRung = useCallback((rungId, connectionId) => {
    const newRungs = rungs.map(rung => {
      if (rung.id === rungId) {
        return {
          ...rung,
          connections: rung.connections.filter(c => c.id !== connectionId)
        };
      }
      return rung;
    });
    setRungs(newRungs);
    saveHistory(newRungs);
  }, [rungs, saveHistory]);



  // Helpers to Group Variables by Type
  const processVars = (vars, scope) => vars.map(v => ({ name: v.name, type: v.type, scope }));
  const allProccessedVars = [
    ...processVars(variables, 'Local'),
    ...processVars(globalVars || [], 'Global')
  ];

  const varsByType = allProccessedVars.reduce((acc, v) => {
    if (!acc[v.type]) acc[v.type] = [];
    acc[v.type].push(v);
    return acc;
  }, {});
  const uniqueTypes = Object.keys(varsByType);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#1e1e1e' }}>

      {/* Type-Specific Datalists */}
      {uniqueTypes.map(type => (
        <datalist key={type} id={`ladder-vars-${type}`}>
          {[...new Map(varsByType[type].map(item => [item.name, item])).values()].map(v => (
            <option
              key={v.name}
              value={`${v.scope === 'Global' ? '🌍' : '🏠'} ${v.name}`}
            />
          ))}
        </datalist>
      ))}

      {/* Fallback 'ALL' Datalist (for ANY type) */}
      <datalist id="ladder-vars-ANY">
        {[...new Map(allProccessedVars.map(item => [item.name, item])).values()].map(v => (
          <option
            key={v.name}
            value={`${v.scope === 'Global' ? '🌍' : '🏠'} ${v.name}`}
          />
        ))}
      </datalist>

      {/* TOOLBAR */}
      <div style={{ background: '#252526', borderBottom: '1px solid #333', padding: '10px', display: 'flex', gap: '10px', alignItems: 'center' }}>
        <button
          onClick={addRung}
          style={{
            background: '#2e7d32',
            color: 'white',
            border: 'none',
            padding: '8px 16px',
            borderRadius: 4,
            cursor: 'pointer',
            fontWeight: 'bold',
            marginRight: '20px'
          }}
        >
          + Rung Ekle
        </button>

        {/* Draggable Blocks */}
        <div style={{ display: 'flex', gap: '10px', paddingLeft: '10px', borderLeft: '1px solid #444' }}>
          <DraggableBlock
            type="Contact"
            label="Contact"
            icon={
              <svg width="24" height="24" viewBox="0 0 40 40" stroke="currentColor" strokeWidth="2" fill="none">
                <line x1="0" y1="20" x2="10" y2="20" />
                <line x1="10" y1="5" x2="10" y2="35" />
                <line x1="30" y1="5" x2="30" y2="35" />
                <line x1="30" y1="20" x2="40" y2="20" />
              </svg>
            }
          />
          <DraggableBlock
            type="Coil"
            label="Coil"
            icon={
              <svg width="24" height="24" viewBox="0 0 40 40" stroke="currentColor" strokeWidth="2" fill="none">
                <line x1="0" y1="20" x2="5" y2="20" />
                <path d="M5,5 Q15,5 15,20 Q15,35 5,35" />
                <path d="M35,5 Q25,5 25,20 Q25,35 35,35" />
                <line x1="35" y1="20" x2="40" y2="20" />
              </svg>
            }
          />

        </div>

        <div style={{ color: '#888', fontSize: 12, display: 'flex', alignItems: 'center', marginLeft: 'auto' }}>
          Ctrl+Z: Geri | Ctrl+Shift+Z: İleri
        </div>
      </div>

      {/* RUNGS AREA */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px', background: '#1e1e1e', minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {rungs.map((rung, index) => (
            <ErrorBoundary key={rung.id}>
              <RungContainer
                rung={rung}
                index={index}
                totalRungs={rungs.length}
                onDelete={() => deleteRung(rung.id)}
                onMoveUp={() => moveRung(rung.id, 'up')}
                onMoveDown={() => moveRung(rung.id, 'down')}
                onAddBlock={(blockType, position, customData) => addBlockToRung(rung.id, blockType, position, customData)}
                onDeleteBlock={(blockId) => deleteBlockFromRung(rung.id, blockId)}
                onAddConnection={(connection) => addConnectionToRung(rung.id, connection)}
                onDeleteConnection={(connectionId) => deleteConnectionFromRung(rung.id, connectionId)}
                onUpdateBlock={(blockId, newData) => updateBlockData(rung.id, blockId, newData)}
                onUpdateBlockPosition={(blockId, position) => updateBlockPosition(rung.id, blockId, position)}
                onNodeDoubleClick={(e, node) => handleNodeDoubleClick(e, node, rung.id)}
                availableBlocks={availableBlocks}
                variables={variables}
                globalVars={globalVars}
              />
            </ErrorBoundary>
          ))}
          {rungs.length === 0 && (
            <div style={{ color: '#666', textAlign: 'center', padding: '40px' }}>
              Rung eklemek için yukarıdaki butona tıklayın
            </div>
          )}
        </div>
      </div>

      {/* SETTINGS MODAL */}
      <BlockSettingsModal
        isOpen={!!editingBlock}
        onClose={() => setEditingBlock(null)}
        blockData={editingBlock}
        onSave={handleSaveSettings}
        blockConfig={blockConfig}
        variables={variables}
        globalVars={globalVars}
      />
    </div>
  );
};

export default RungEditorNew;
