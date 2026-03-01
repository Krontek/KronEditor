import { useState, useCallback, useRef, useEffect } from 'react';
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

const RungEditorNew = ({ variables, setVariables, rungs, setRungs, availableBlocks, globalVars = [], liveVariables = null, parentName = "", readOnly = false }) => {

  // Undo/Redo history - her snapshot { rungs, variables } çiftini saklıyor
  const historyRef = useRef([{
    rungs: JSON.parse(JSON.stringify(rungs)),
    variables: JSON.parse(JSON.stringify(variables))
  }]);
  const historyIndexRef = useRef(0);

  // Settings modal state
  const [editingBlock, setEditingBlock] = useState(null);

  // History kaydet - hem rungs hem variables birlikte
  const saveHistory = useCallback((newRungs, newVariables) => {
    const sliced = historyRef.current.slice(0, historyIndexRef.current + 1);
    sliced.push({
      rungs: JSON.parse(JSON.stringify(newRungs)),
      variables: JSON.parse(JSON.stringify(newVariables))
    });
    if (sliced.length > 50) sliced.shift();
    historyRef.current = sliced;
    historyIndexRef.current = sliced.length - 1;
  }, []);

  const undo = useCallback(() => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      const state = historyRef.current[historyIndexRef.current];
      setRungs(JSON.parse(JSON.stringify(state.rungs)));
      setVariables(JSON.parse(JSON.stringify(state.variables)));
    }
  }, [setRungs, setVariables]);

  const redo = useCallback(() => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current++;
      const state = historyRef.current[historyIndexRef.current];
      setRungs(JSON.parse(JSON.stringify(state.rungs)));
      setVariables(JSON.parse(JSON.stringify(state.variables)));
    }
  }, [setRungs, setVariables]);

  // Keyboard Shortcuts for Undo/Redo
  useEffect(() => {
    const handleKeyDown = (e) => {
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
    if (readOnly) return;

    // instanceName değiştiyse variables'ı da güncelle
    let newVariables = variables;
    if (newData.instanceName) {
      newVariables = variables.map(v => v.id === blockId ? { ...v, name: newData.instanceName } : v);
      setVariables(newVariables);
    }

    setRungs(prevRungs => {
      const newRungs = prevRungs.map(rung => {
        if (rung.id === rungId) {
          return {
            ...rung,
            blocks: rung.blocks.map(b =>
              b.id === blockId ? { ...b, data: { ...b.data, ...newData } } : b
            )
          };
        }
        return rung;
      });
      saveHistory(newRungs, newVariables);
      return newRungs;
    });
  }, [readOnly, variables, saveHistory, setVariables]);

  // Blok pozisyonunu güncelleme (history'e kaydedilmez - performans için)
  const updateBlockPosition = useCallback((rungId, blockId, position) => {
    if (readOnly) return;
    setRungs(prevRungs => prevRungs.map(rung => {
      if (rung.id === rungId) {
        return {
          ...rung,
          blocks: rung.blocks.map(b => b.id === blockId ? { ...b, position } : b)
        };
      }
      return rung;
    }));
  }, [readOnly]);

  // Blok çift tıklandığında ayarları aç
  const handleNodeDoubleClick = useCallback((_event, node, rungId) => {
    if (readOnly) return;
    setEditingBlock({
      rungId,
      id: node.id,
      type: node.data.type,
      ...node.data
    });
  }, [readOnly]);

  // Ayarları kaydet
  const handleSaveSettings = useCallback((blockId, newSettings) => {
    if (!editingBlock) return;
    updateBlockData(editingBlock.rungId, blockId, newSettings);
    setEditingBlock(null);
  }, [editingBlock, updateBlockData]);

  // Rung ekleme
  const addRung = useCallback(() => {
    if (readOnly) return;
    const newRung = {
      id: `rung_${Date.now()}_${Math.random()}`,
      label: String(rungs.length).padStart(3, '0'),
      blocks: [],
      connections: []
    };
    const newRungs = [...rungs, newRung];
    setRungs(newRungs);
    saveHistory(newRungs, variables);
  }, [readOnly, rungs, variables, saveHistory]);

  // Rung silme
  const deleteRung = useCallback((rungId) => {
    if (readOnly) return;
    const newRungs = rungs.filter(r => r.id !== rungId);
    setRungs(newRungs);
    saveHistory(newRungs, variables);
  }, [readOnly, rungs, variables, saveHistory]);

  // Rung'lar arasında taşıma (yukarı/aşağı)
  const moveRung = useCallback((rungId, direction) => {
    if (readOnly) return;
    const idx = rungs.findIndex(r => r.id === rungId);
    if (direction === 'up' && idx <= 0) return;
    if (direction === 'down' && idx >= rungs.length - 1) return;

    const newRungs = [...rungs];
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    [newRungs[idx], newRungs[swapIdx]] = [newRungs[swapIdx], newRungs[idx]];
    setRungs(newRungs);
    saveHistory(newRungs, variables);
  }, [readOnly, rungs, variables, saveHistory]);

  // HELPER: Blok ekle + history'ye hem rungs hem variables kaydet
  const insertBlock = useCallback((rungId, blockType, position, instanceName, customData, newVariables) => {
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
      saveHistory(newRungs, newVariables);
      return newRungs;
    });
  }, [setRungs, saveHistory]);

  // Main Add Block Handler
  const addBlockToRung = useCallback((rungId, blockType, position, customData = null) => {
    if (!position || readOnly) return;

    // 1. CONTACT / COIL LOGIC
    if (blockType === 'Contact' || blockType === 'Coil') {
      const allVars = [
        ...variables.map(v => ({ ...v, scope: 'Local' })),
        ...globalVars.map(v => ({ ...v, scope: 'Global' }))
      ];
      const boolVars = allVars.filter(v => v.type === 'BOOL');

      // Case A: BOOL değişken yok -> otomatik oluştur
      if (boolVars.length === 0) {
        let index = 0;
        let newName = '';
        while (true) {
          const candidate = `Var${index}`;
          if (!allVars.some(v => v.name === candidate)) {
            newName = candidate;
            break;
          }
          index++;
          if (index > 1000) { console.error("Loop safety break"); break; }
        }

        const newVar = {
          id: `created_var_${Date.now()}`,
          name: newName,
          class: 'Local',
          type: 'BOOL',
          location: '',
          initialValue: '',
          description: ''
        };
        const newVariables = [...variables, newVar];
        setVariables(newVariables);
        insertBlock(rungId, blockType, position, newName, customData, newVariables);
      }
      // Case B: BOOL değişken var -> boş placeholder
      else {
        insertBlock(rungId, blockType, position, '', customData, variables);
      }
      return;
    }

    // 2. DİĞER BLOKLAR (Standard / UserDefined)
    let instanceName;
    let newVariables = variables;

    if (customData) {
      if (customData.type === 'functions') {
        instanceName = customData.name;
        // Function blok instance oluşturmaz, variables değişmez
      } else {
        // Function Block Instance
        let index = 0;
        while (true) {
          const candidateName = `${customData.name}_${index}`;
          if (!variables.some(v => v.name === candidateName) && !(globalVars || []).some(v => v.name === candidateName)) {
            instanceName = candidateName;
            break;
          }
          index++;
          if (index > 1000) { console.error("Loop safety break"); break; }
        }

        const newVar = {
          id: `fb_inst_${Date.now()}`,
          name: instanceName,
          class: 'Local',
          type: customData.name,
          location: '',
          initialValue: '',
          description: 'FB Instance'
        };
        newVariables = [...variables, newVar];
        setVariables(newVariables);
      }
    } else {
      // Standard Blocks (TON, CTU, etc.)
      let index = 0;
      while (true) {
        const candidate = `${blockType}${index}`;
        if (!variables.some(v => v.name === candidate) && !(globalVars || []).some(v => v.name === candidate)) {
          instanceName = candidate;
          break;
        }
        index++;
        if (index > 1000) { console.error("Loop safety break"); break; }
      }

      const newVar = {
        id: `std_inst_${Date.now()}`,
        name: instanceName,
        class: 'Local',
        type: blockType,
        location: '',
        initialValue: '',
        description: ''
      };
      newVariables = [...variables, newVar];
      setVariables(newVariables);
    }

    insertBlock(rungId, blockType, position, instanceName, customData, newVariables);
  }, [readOnly, variables, globalVars, insertBlock, setVariables]);

  // Rung'dan blok silme - variable da siliniyorsa history'ye yeni hali kaydet
  const deleteBlockFromRung = useCallback((rungId, blockId) => {
    if (readOnly) return;
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

    // Silinen bloğun variable'ını da kaldır - yeni variables'ı senkron hesapla
    let newVariables = variables;
    if (blockToDelete?.data?.instanceName) {
      const instanceName = blockToDelete.data.instanceName;
      const isUsedElsewhere = newRungs.some(r =>
        r.blocks.some(b => b.data?.instanceName === instanceName)
      );
      if (!isUsedElsewhere) {
        newVariables = variables.filter(v => v.name !== instanceName);
        setVariables(newVariables);
      }
    }

    // Her iki yeni state'i birlikte history'ye kaydet
    saveHistory(newRungs, newVariables);
  }, [readOnly, rungs, variables, saveHistory, setVariables]);

  // Rung'a bağlantı ekleme
  const addConnectionToRung = useCallback((rungId, connection) => {
    if (readOnly) return;
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
    saveHistory(newRungs, variables);
  }, [readOnly, rungs, variables, saveHistory]);

  // Rung'dan bağlantı silme
  const deleteConnectionFromRung = useCallback((rungId, connectionId) => {
    if (readOnly) return;
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
    saveHistory(newRungs, variables);
  }, [readOnly, rungs, variables, saveHistory]);

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
      <div style={{ background: readOnly ? '#1a1a1a' : '#252526', borderBottom: '1px solid #333', padding: '6px 10px', display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          onClick={addRung}
          disabled={readOnly}
          style={{
            background: readOnly ? '#444' : '#2e7d32',
            color: readOnly ? '#888' : 'white',
            border: 'none',
            padding: '4px 8px',
            fontSize: '12px',
            borderRadius: 4,
            cursor: readOnly ? 'default' : 'pointer',
            fontWeight: 'bold',
            marginRight: '10px',
            opacity: readOnly ? 0.5 : 1
          }}
        >
          + Rung
        </button>

        {/* Draggable Blocks */}
        <div style={{ display: 'flex', gap: '10px', paddingLeft: '10px', borderLeft: '1px solid #444', opacity: readOnly ? 0.4 : 1, pointerEvents: readOnly ? 'none' : 'auto' }}>
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
                <line x1="0" y1="20" x2="10" y2="20" />
                <path d="M10,5 Q-5,20 10,35" />
                <path d="M30,5 Q45,20 30,35" />
                <line x1="30" y1="20" x2="40" y2="20" />
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
                liveVariables={liveVariables}
                parentName={parentName}
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
