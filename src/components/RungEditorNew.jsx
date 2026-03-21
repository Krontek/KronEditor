import { useState, useCallback, useRef, useEffect } from 'react';
import RungContainer, { blockConfig } from './RungContainer';
import ErrorBoundary from './ErrorBoundary';
import BlockSettingsModal from './BlockSettingsModal';
import ForceWriteModal from './common/ForceWriteModal';
import DragDropManager from '../utils/DragDropManager';

const EMPTY_IMG = new Image();
EMPTY_IMG.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Dashed line appearing on hover "insert here"
const InsertZone = ({ onInsert, onPaste, canPaste, disabled }) => {
  const [hovered, setHovered] = useState(false);
  if (disabled) return <div style={{ height: 6 }} />;
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: hovered ? 24 : 6,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        transition: 'height 0.1s ease',
        margin: '0 4px',
        gap: 6,
      }}
    >
      {hovered && (
        <>
          <div style={{ position: 'absolute', left: 0, right: 0, height: 2, background: '#007acc', borderRadius: 1 }} />
          <div
            onClick={onInsert}
            style={{ position: 'relative', zIndex: 1, width: 18, height: 18, background: '#007acc', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, fontWeight: 'bold', lineHeight: 1 }}
            title="Add new rung"
          >+</div>
          {canPaste && (
            <div
              onClick={(e) => { e.stopPropagation(); onPaste && onPaste(); }}
              style={{ position: 'relative', zIndex: 1, width: 18, height: 18, background: '#4caf50', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 'bold', lineHeight: 1, cursor: 'pointer' }}
              title="Yapıştır"
            >📋</div>
          )}
        </>
      )}
    </div>
  );
};

/**
 * YENİ LADDER EDITOR MİMARİ
 * - Rung'lar bir liste olarak düzenleniyor
 * - Her rung'ın kendi blokları ve bağlantıları var
 * - Rung hareket ederken, içindeki her şey beraber hareket ediyor
 */

const RungEditorNew = ({ variables, setVariables, rungs, setRungs, availableBlocks, globalVars = [], dataTypes = [], liveVariables = null, parentName = "", readOnly = false, onForceWrite = null }) => {
  // Undo/Redo history - her snapshot { rungs, variables } çiftini saklıyor
  const historyRef = useRef([{
    rungs: JSON.parse(JSON.stringify(rungs)),
    variables: JSON.parse(JSON.stringify(variables))
  }]);
  const historyIndexRef = useRef(0);
  const [historyStats, setHistoryStats] = useState({ canUndo: 0, canRedo: 0 });
  const dragAllowedRef = useRef(false);

  // Settings modal state
  const [editingBlock, setEditingBlock] = useState(null);
  // Simulation force-write modal (double-click on node during simulation)
  const [simForceModal, setSimForceModal] = useState(null); // { varName, varType, liveKey, currentValue }

  // Rung selection & drag/drop
  const [focusedRungId, setFocusedRungId] = useState(null);
  const [draggedRungIndex, setDraggedRungIndex] = useState(null);
  const [dragOverRungIndex, setDragOverRungIndex] = useState(null);
  const [globalSelectedBlockId, setGlobalSelectedBlockId] = useState(null);

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
    setHistoryStats({ canUndo: historyIndexRef.current, canRedo: 0 });
  }, []);

  const undo = useCallback(() => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      const state = historyRef.current[historyIndexRef.current];
      setRungs(JSON.parse(JSON.stringify(state.rungs)));
      setVariables(JSON.parse(JSON.stringify(state.variables)));
      setHistoryStats({
        canUndo: historyIndexRef.current,
        canRedo: historyRef.current.length - 1 - historyIndexRef.current
      });
    }
  }, [setRungs, setVariables]);

  const redo = useCallback(() => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current++;
      const state = historyRef.current[historyIndexRef.current];
      setRungs(JSON.parse(JSON.stringify(state.rungs)));
      setVariables(JSON.parse(JSON.stringify(state.variables)));
      setHistoryStats({
        canUndo: historyIndexRef.current,
        canRedo: historyRef.current.length - 1 - historyIndexRef.current
      });
    }
  }, [setRungs, setVariables]);

  // Keyboard Shortcuts for Undo/Redo/Copy/Paste
  const selectedNodeRef = useRef(null);
  const clipboardRef = useRef(null);
  const [clipboardType, setClipboardType] = useState(null); // 'rung' | 'block' | null

  const handleCopy = useCallback(() => {
    if (readOnly) return;
    // Block-level copy (only when a block is selected and no rung is focused)
    if (selectedNodeRef.current && !focusedRungId) {
      clipboardRef.current = { type: 'block', rungId: selectedNodeRef.current.rungId, payload: JSON.parse(JSON.stringify(selectedNodeRef.current)) };
      setClipboardType('block');
      return;
    }
    // Rung-level copy (only when a rung is focused and no block is selected)
    if (focusedRungId && !selectedNodeRef.current) {
      const rung = rungs.find(r => r.id === focusedRungId);
      if (rung) {
        clipboardRef.current = { type: 'rung', payload: JSON.parse(JSON.stringify(rung)) };
        setClipboardType('rung');
      }
    }
  }, [readOnly, focusedRungId, rungs]);

  const handlePaste = useCallback(() => {
    if (readOnly || !clipboardRef.current) return;
    const clip = clipboardRef.current;

    if (clip.type === 'rung') {
      // ── Rung paste ─────────────────────────────────────
      const src = clip.payload;
      const idMap = {};
      const ts = Date.now();
      const newBlocks = src.blocks.map((b, i) => {
        const newId = `node_${ts}_${i}`;
        idMap[b.id] = newId;
        return { ...b, id: newId };
      });
      const newConns = (src.connections || []).map((c, i) => ({
        ...c,
        id: `conn_${ts}_${i}`,
        source: idMap[c.source] || c.source,
        target: idMap[c.target] || c.target,
      }));
      const newRung = {
        ...src,
        id: `rung_${ts}`,
        label: `${src.label || ''} (copy)`,
        blocks: newBlocks,
        connections: newConns,
      };
      // FB instance variables for copied blocks
      const fbBlocks = newBlocks.filter(b => b.data?.type !== 'Contact' && b.data?.type !== 'Coil' && b.data?.instanceName);
      if (fbBlocks.length) {
        setVariables(prev => {
          const names = new Set(prev.map(v => v.name));
          const extra = [];
          fbBlocks.forEach(b => {
            if (!names.has(b.data.instanceName)) {
              const orig = prev.find(v => v.name === src.blocks.find(ob => ob.id === Object.keys(idMap).find(k => idMap[k] === b.id))?.data?.instanceName);
              if (orig) extra.push({ ...orig, id: `var_${Date.now()}_${Math.random()}`, name: b.data.instanceName });
            }
          });
          return extra.length ? [...prev, ...extra] : prev;
        });
      }
      setRungs(prev => {
        const idx = focusedRungId ? prev.findIndex(r => r.id === focusedRungId) : prev.length - 1;
        const newRungs = [...prev];
        newRungs.splice(idx + 1, 0, newRung);
        setTimeout(() => setVariables(v => { saveHistory(newRungs, v); return v; }), 0);
        return newRungs;
      });
      setFocusedRungId(newRung.id);
      return;
    }

    // ── Block paste ─────────────────────────────────────
    // Block can only be pasted into the same rung it was copied from
    const copied = clip.payload;
    const sourceRungId = clip.rungId || copied.rungId;
    if (!sourceRungId) return;
    let targetRungId = sourceRungId;
    
    setRungs(prevRungs => {
      const targetRung = prevRungs.find(r => r.id === targetRungId);
      if (!targetRung) return prevRungs;
      
      const newBlockId = `node_${Date.now()}_${Math.random()}`;
      const newPosition = {
        x: (copied.position?.x || 0) + 20,
        y: (copied.position?.y || 0) + 20
      };
      
      const newBlock = {
        ...copied,
        id: newBlockId,
        position: newPosition,
        selected: true,
      };
      
      if (newBlock.data.type !== 'Contact' && newBlock.data.type !== 'Coil') {
          newBlock.data.instanceName = `${newBlock.data.instanceName}_copy`;
          setVariables(prevVars => {
             const newVars = [...prevVars];
             if(!newVars.some(v => v.name === newBlock.data.instanceName)) {
                const varDef = prevVars.find(v => v.name === copied.data.instanceName);
                if(varDef) {
                   newVars.push({ ...varDef, id: `var_${Date.now()}`, name: newBlock.data.instanceName });
                }
             }
             return newVars;
          });
      }

      const newRungs = prevRungs.map(r => {
        if (r.id === targetRung.id) {
          return {
            ...r,
            blocks: [...r.blocks.map(b => ({...b, selected: false})), newBlock]
          };
        }
        return r;
      });
      
      setTimeout(() => setVariables(v => { saveHistory(newRungs, v); return v; }), 0);
      return newRungs;
    });

    selectedNodeRef.current = { rungId: targetRungId, ...copied, selected: true };
    
  }, [readOnly, focusedRungId, setRungs, setVariables, saveHistory, rungs]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't trigger if user is typing in an input field (except possibly read-only ones)
      if (document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'text') {
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === 'z') {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            redo();
          } else {
            undo();
          }
        } else if (key === 'c') {
          e.preventDefault();
          handleCopy();
        } else if (key === 'v') {
          e.preventDefault();
          handlePaste();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, handleCopy, handlePaste]);

  // Blok verisini güncelleme
  const updateBlockData = useCallback((rungId, blockId, newData) => {
    if (readOnly) return;

    setRungs(prevRungs => {
      let oldInstanceName = null;
      const newRungs = prevRungs.map(rung => {
        if (rung.id === rungId) {
          return {
            ...rung,
            blocks: rung.blocks.map(b => {
              if (b.id === blockId) {
                oldInstanceName = b.data.instanceName;
                return { ...b, data: { ...b.data, ...newData } };
              }
              return b;
            })
          };
        }
        return rung;
      });

      // instanceName değiştiyse variables'ı da güncelle
      if (newData.instanceName && oldInstanceName && newData.instanceName !== oldInstanceName) {
         setVariables(prev => {
            const newVars = prev.map(v => v.name === oldInstanceName ? { ...v, name: newData.instanceName } : v);
            setTimeout(() => saveHistory(newRungs, newVars), 0);
            return newVars;
         });
      } else {
         saveHistory(newRungs, variables);
      }

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

  // Blok çift tıklandığında ayarları aç (simülasyon modunda force-write modalı açar)
  const handleNodeDoubleClick = useCallback((_event, node, rungId) => {
    if (readOnly) {
      // Simulation mode: open force-write modal for this node's variable
      if (!liveVariables || !onForceWrite) return;
      const instanceName = (
        node.data.instanceName ||
        node.data.values?.var ||
        node.data.values?.coil ||
        ''
      ).replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
      if (!instanceName) return;
      const safeProgName = (parentName || '').trim().replace(/\s+/g, '_');
      const progKey = `prog_${safeProgName}_${instanceName}`;
      const globalKey = `prog__${instanceName}`;
      const lookupKey = liveVariables[progKey] !== undefined ? progKey : globalKey;
      const varDef = [...variables, ...globalVars].find(v => v.name === instanceName);
      setSimForceModal({
        varName: instanceName,
        varType: varDef?.type || 'BOOL',
        liveKey: lookupKey,
        currentValue: liveVariables[lookupKey]
      });
      return;
    }
    setEditingBlock({
      rungId,
      id: node.id,
      type: node.data.type,
      ...node.data
    });
  }, [readOnly, liveVariables, onForceWrite, parentName, variables, globalVars]);

  // Ayarları kaydet
  const handleSaveSettings = useCallback((blockId, newSettings) => {
    if (!editingBlock) return;
    updateBlockData(editingBlock.rungId, blockId, newSettings);
    setEditingBlock(null);
  }, [editingBlock, updateBlockData]);

  // Paste rung at a specific position (called from InsertZone paste button)
  const pasteRungAt = useCallback((targetId, before) => {
    if (readOnly || !clipboardRef.current || clipboardRef.current.type !== 'rung') return;
    const src = clipboardRef.current.payload;
    const idMap = {};
    const ts = Date.now();
    const newBlocks = src.blocks.map((b, i) => {
      const newId = `node_${ts}_${i}`;
      idMap[b.id] = newId;
      return { ...b, id: newId };
    });
    const newConns = (src.connections || []).map((c, i) => ({
      ...c,
      id: `conn_${ts}_${i}`,
      source: idMap[c.source] || c.source,
      target: idMap[c.target] || c.target,
    }));
    const newRung = {
      ...src,
      id: `rung_${ts}`,
      label: '',
      blocks: newBlocks,
      connections: newConns,
    };
    const fbBlocks = newBlocks.filter(b => b.data?.type !== 'Contact' && b.data?.type !== 'Coil' && b.data?.instanceName);
    if (fbBlocks.length) {
      setVariables(prev => {
        const names = new Set(prev.map(v => v.name));
        const extra = [];
        fbBlocks.forEach(b => {
          if (!names.has(b.data.instanceName)) {
            const origBlockId = Object.keys(idMap).find(k => idMap[k] === b.id);
            const origBlock = src.blocks.find(ob => ob.id === origBlockId);
            const orig = prev.find(v => v.name === origBlock?.data?.instanceName);
            if (orig) extra.push({ ...orig, id: `var_${Date.now()}_${Math.random()}`, name: b.data.instanceName });
          }
        });
        return extra.length ? [...prev, ...extra] : prev;
      });
    }
    let newRungs = [...rungs];
    if (targetId) {
      const idx = newRungs.findIndex(r => r.id === targetId);
      if (idx !== -1) {
        newRungs.splice(before ? idx : idx + 1, 0, newRung);
      } else {
        newRungs.push(newRung);
      }
    } else {
      newRungs.push(newRung);
    }
    newRungs = newRungs.map((r, i) => ({ ...r, label: String(i).padStart(3, '0') }));
    setRungs(newRungs);
    setFocusedRungId(newRung.id);
    saveHistory(newRungs, variables);
  }, [readOnly, rungs, variables, saveHistory, setRungs, setVariables]);

  // Add Rung
  // targetId: which rung to insert beside (null = add to end)
  // before: if true add before, if false add after
  const addRung = useCallback((targetId = null, before = false) => {
    if (readOnly) return;
    const newRung = {
      id: `rung_${Date.now()}_${Math.random()}`,
      label: '',
      blocks: [],
      connections: []
    };

    let newRungs = [...rungs];
    const resolvedId = targetId || focusedRungId;

    if (resolvedId) {
      const idx = newRungs.findIndex(r => r.id === resolvedId);
      if (idx !== -1) {
        newRungs.splice(before ? idx : idx + 1, 0, newRung);
      } else {
        newRungs.push(newRung);
      }
    } else {
      newRungs.push(newRung);
    }

    // Update labels sequentially
    newRungs = newRungs.map((r, i) => ({ ...r, label: String(i).padStart(3, '0') }));

    setRungs(newRungs);
    setFocusedRungId(newRung.id);
    saveHistory(newRungs, variables);
  }, [readOnly, rungs, variables, focusedRungId, saveHistory]);

  // Delete Rung
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

    let newRungs = [...rungs];
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    [newRungs[idx], newRungs[swapIdx]] = [newRungs[swapIdx], newRungs[idx]];

    // Update labels sequentially
    newRungs = newRungs.map((r, i) => ({ ...r, label: String(i).padStart(3, '0') }));

    setRungs(newRungs);
    saveHistory(newRungs, variables);
  }, [readOnly, rungs, variables, saveHistory]);

  const handleDragStart = (e, index) => {
    if (readOnly || !dragAllowedRef.current) {
      e.preventDefault();
      return;
    }
    setDraggedRungIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `rung_${index}`);
    if (e.dataTransfer.setDragImage) {
      e.dataTransfer.setDragImage(EMPTY_IMG, 0, 0);
    }
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    if (readOnly || draggedRungIndex === null) return;
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const insertIndex = e.clientY < rect.top + rect.height / 2 ? index : index + 1;
    if (insertIndex !== dragOverRungIndex) setDragOverRungIndex(insertIndex);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const src = draggedRungIndex;
    const dst = dragOverRungIndex;
    setDraggedRungIndex(null);
    setDragOverRungIndex(null);
    if (readOnly || src === null || dst === null || dst === src || dst === src + 1) return;

    let newRungs = [...rungs];
    const [removed] = newRungs.splice(src, 1);
    const spliceDst = dst > src ? dst - 1 : dst;
    newRungs.splice(spliceDst, 0, removed);

    // Update labels sequentially
    newRungs = newRungs.map((r, i) => ({ ...r, label: String(i).padStart(3, '0') }));

    setRungs(newRungs);
    saveHistory(newRungs, variables);
  };

  const handleDragEnd = () => {
    setDraggedRungIndex(null);
    setDragOverRungIndex(null);
  };

  // HELPER: Add block + save both rungs and variables to history
  const insertBlock = useCallback((rungId, blockType, position, instanceName, customData, newVariables) => {
    const blockId = `block_${Date.now()}_${Math.random()}`;
    // For Contact/Coil, propagate subType from customData directly onto data
    // so RungContainer can render the correct symbol immediately on drop.
    const subTypeOverride = (blockType === 'Contact' || blockType === 'Coil')
      ? customData?.subType
      : undefined;

    const newBlock = {
      id: blockId,
      type: blockType,
      position: position,
      data: {
        label: blockType === 'UserDefined' ? customData?.name : blockType,
        instanceName: instanceName,
        customData: customData,
        ...(subTypeOverride ? { subType: subTypeOverride } : {})
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

    // Use predefined name pattern if available
    const dragData = typeof DragDropManager !== 'undefined' ? DragDropManager.getDragData() : null;
    const namePatternBase = dragData?.instanceNamePattern ? dragData.instanceNamePattern.replace(/[0-9]+$/, '') : null;

    if (customData && customData.name) {
      if (customData.type === 'functions') {
        instanceName = customData.name;
        // Function blok instance oluşturmaz, variables değişmez
      } else {
        // User-defined Function Block Instance (has a name)
        const baseName = (namePatternBase || customData.name).trim().replace(/\s+/g, '_');
        let index = 0;

        while (true) {
          const candidateName = `${baseName}${index}`;
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
    } else if (customData && customData.inputs) {
      // Board/HAL blocks: customData has inputs/outputs directly (no name field)
      const baseName = (namePatternBase || blockType).trim().replace(/\s+/g, '_');
      let index = 0;

      while (true) {
        const candidate = `${baseName}${index}`;
        if (!variables.some(v => v.name === candidate) && !(globalVars || []).some(v => v.name === candidate)) {
          instanceName = candidate;
          break;
        }
        index++;
        if (index > 1000) { console.error("Loop safety break"); break; }
      }

      const newVar = {
        id: `hal_inst_${Date.now()}`,
        name: instanceName,
        class: 'Local',
        type: blockType,
        location: '',
        initialValue: '',
        description: 'HAL Block'
      };
      newVariables = [...variables, newVar];
      setVariables(newVariables);
    } else {
      // Standard Blocks (TON, CTU, etc.)
      const baseName = (namePatternBase || blockType).trim().replace(/\s+/g, '_');
      let index = 0;

      while (true) {
        const candidate = `${baseName}${index}`;
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

  // Type icons for complex types (stripped on input in RungContainer)
  // ⊞ = Array, ⊡ = Struct, ⊟ = Enum
  const dtMap = (dataTypes || []).reduce((acc, dt) => { acc[dt.name] = dt; return acc; }, {});

  const allRawVars = [
    ...(variables || []).map(v => ({ ...v, scope: 'Local' })),
    ...(globalVars || []).map(v => ({ ...v, scope: 'Global' })),
  ];

  const varsByType = {};
  const NUMERIC_TYPES = new Set(['INT', 'UINT', 'SINT', 'USINT', 'DINT', 'UDINT', 'REAL', 'LREAL', 'BYTE', 'WORD', 'DWORD']);
  const addOption = (type, value) => {
    if (!varsByType[type]) varsByType[type] = [];
    varsByType[type].push(value);
    if (type !== 'ANY') {
      if (!varsByType['ANY']) varsByType['ANY'] = [];
      varsByType['ANY'].push(value);
    }
    if (NUMERIC_TYPES.has(type)) {
      if (!varsByType['ANY_NUM']) varsByType['ANY_NUM'] = [];
      varsByType['ANY_NUM'].push(value);
    }
  };

  allRawVars.forEach(v => {
    const s = v.scope === 'Global' ? '🌍' : '🏠';
    const dt = dtMap[v.type];
    if (dt?.type === 'Array') {
      const minIdx = parseInt(dt.content.dimensions[0].min);
      addOption(dt.content.baseType, `${s}⊞ ${v.name}[${minIdx}]`);
    } else if (dt?.type === 'Structure') {
      (dt.content.members || []).forEach(member => {
        addOption(member.type, `${s}⊡ ${v.name}.${member.name}`);
      });
    } else if (dt?.type === 'Enumerated') {
      addOption(v.type, `${s}⊟ ${v.name}`);
    } else {
      addOption(v.type, `${s} ${v.name}`);
    }
  });

  const uniqueTypes = Object.keys(varsByType).filter(t => t !== 'ANY');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#1e1e1e' }}>

      {/* Type-Specific Datalists */}
      {uniqueTypes.map(type => (
        <datalist key={type} id={`ladder-vars-${type}`}>
          {[...new Set(varsByType[type])].map((val, i) => <option key={i} value={val} />)}
        </datalist>
      ))}

      {/* Fallback 'ALL' Datalist (for ANY type) */}
      <datalist id="ladder-vars-ANY">
        {[...new Set(varsByType['ANY'] || [])].map((val, i) => <option key={i} value={val} />)}
      </datalist>

      {/* TOOLBAR */}
      <div style={{ background: readOnly ? '#1a1a1a' : '#252526', borderBottom: '1px solid #333', padding: '6px 10px', display: 'flex', gap: '8px', alignItems: 'center' }}>
        <div style={{ color: '#888', fontSize: 11, display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
          <span title="Ctrl+Z">
            ↩ {historyStats.canUndo > 0
              ? <span style={{ color: '#90caf9', fontWeight: 'bold' }}>{historyStats.canUndo}</span>
              : <span style={{ opacity: 0.4 }}>0</span>}
          </span>
          <span title="Ctrl+Shift+Z">
            ↪ {historyStats.canRedo > 0
              ? <span style={{ color: '#90caf9', fontWeight: 'bold' }}>{historyStats.canRedo}</span>
              : <span style={{ opacity: 0.4 }}>0</span>}
          </span>
          <span style={{ opacity: 0.4 }}>Ctrl+Z / Ctrl+Shift+Z</span>
        </div>
      </div>

      {/* RUNGS AREA */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px', background: '#1e1e1e', minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <InsertZone onInsert={() => addRung(rungs[0]?.id, true)} onPaste={() => pasteRungAt(rungs[0]?.id, true)} canPaste={clipboardType === 'rung'} disabled={readOnly || draggedRungIndex !== null} />
          {rungs.map((rung, index) => (
            <div key={rung.id}>
              {/* Drag drop indicator above */}
              {draggedRungIndex !== null && dragOverRungIndex === index && (
                <div style={{ height: 3, background: '#007acc', borderRadius: 2, margin: '0 4px' }} />
              )}
              <div
                draggable={!readOnly}
                onMouseDown={(e) => { dragAllowedRef.current = !!e.target.closest('.rung-drag-handle'); }}
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
                style={{
                  opacity: draggedRungIndex === index ? 0.4 : 1,
                  border: focusedRungId === rung.id ? '1px solid #007acc' : '1px solid transparent',
                  borderRadius: '4px',
                  transition: 'border 0.2s',
                }}
              >
                <ErrorBoundary>
                  <RungContainer
                    rung={rung}
                    index={index}
                    totalRungs={rungs.length}
                    isFocused={focusedRungId === rung.id}
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
                    globalSelectedBlockId={globalSelectedBlockId}
                    onSelectBlock={(rungId, node) => {
                      if (!node) {
                        selectedNodeRef.current = null;
                        setGlobalSelectedBlockId(null);
                      } else {
                        // Block selected → clear rung focus (mutual exclusion)
                        setFocusedRungId(null);
                        selectedNodeRef.current = { rungId, ...node };
                        setGlobalSelectedBlockId(node.id);
                      }
                    }}
                    availableBlocks={availableBlocks}
                    variables={variables}
                    globalVars={globalVars}
                    dataTypes={dataTypes}
                    liveVariables={liveVariables}
                    parentName={parentName}
                    readOnly={readOnly}
                    onForceWrite={onForceWrite}
                    onFocusRung={() => {
                      if (readOnly) return;
                      // Rung focused → clear block selection (mutual exclusion)
                      selectedNodeRef.current = null;
                      setGlobalSelectedBlockId(null);
                      setFocusedRungId(rung.id);
                    }}
                  />
                </ErrorBoundary>
              </div>
              {index < rungs.length - 1 && (
                <InsertZone onInsert={() => addRung(rung.id, false)} onPaste={() => pasteRungAt(rung.id, false)} canPaste={clipboardType === 'rung'} disabled={readOnly || draggedRungIndex !== null} />
              )}
            </div>
          ))}
          {/* Drag drop indicator after last rung */}
          {draggedRungIndex !== null && dragOverRungIndex === rungs.length && (
            <div style={{ height: 3, background: '#007acc', borderRadius: 2, margin: '0 4px' }} />
          )}
          {!readOnly && (
            <div
              onClick={() => addRung(null, false)}
              style={{ display: 'flex', justifyContent: 'center', padding: '6px 0', cursor: 'pointer', opacity: 0.5 }}
              onMouseEnter={e => e.currentTarget.style.opacity = 1}
              onMouseLeave={e => e.currentTarget.style.opacity = 0.5}
            >
              <div style={{ width: 22, height: 22, background: '#007acc', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 16, fontWeight: 'bold', lineHeight: 1 }}>+</div>
            </div>
          )}
          {/* Bottom drop zone: catches drags below all rungs */}
          <div
            style={{ flex: 1, minHeight: 40 }}
            onDragOver={(e) => {
              if (readOnly || draggedRungIndex === null) return;
              e.preventDefault();
              e.stopPropagation();
              if (dragOverRungIndex !== rungs.length) setDragOverRungIndex(rungs.length);
            }}
            onDrop={handleDrop}
          />
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

      {/* SIMULATION FORCE-WRITE MODAL (double-click on node during simulation) */}
      {simForceModal && (
        <ForceWriteModal
          isOpen={true}
          onClose={() => setSimForceModal(null)}
          varName={simForceModal.varName}
          varType={simForceModal.varType}
          currentValue={simForceModal.currentValue}
          liveKey={simForceModal.liveKey}
          onConfirm={(key, val) => { onForceWrite && onForceWrite(key, val); setSimForceModal(null); }}
        />
      )}
    </div>
  );
};

export default RungEditorNew;
