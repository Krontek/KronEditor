import { useState, useCallback, useRef, useEffect } from 'react';
import { Editor } from '@monaco-editor/react';
import RungContainer, { blockConfig } from './RungContainer';
import ErrorBoundary from './ErrorBoundary';
import BlockSettingsModal from './BlockSettingsModal';
import ForceWriteModal from './common/ForceWriteModal';
import DragDropManager from '../utils/DragDropManager';
import { registerIECSTLanguage } from '../utils/iecSTLanguage';

// IEC ST identifier validation for SCL inline editors.
// Returns Monaco markers for undeclared identifiers.
const ST_ALWAYS_ALLOWED = new Set([
  'if','then','elsif','else','end_if','case','of','end_case',
  'for','to','by','do','end_for','while','end_while',
  'repeat','until','end_repeat','return','exit',
  'true','false','and','or','not','xor','mod',
  'bool','int','uint','dint','udint','lint','ulint',
  'real','lreal','time','string','byte','word','dword','lword',
  'ton','tof','tp','tonr','ctu','ctd','ctud','sr','rs','r_trig','f_trig',
  'shl','shr','rol','ror','band','bor','bxor','bnot',
  'add','sub','mul','div','abs','sqrt','expt','sin','cos','tan','asin','acos','atan',
  'max','min','limit','sel','mux','move',
  'gt','ge','eq','ne','le','lt',
  'byte_to_uint','byte_to_int','byte_to_dint','byte_to_real',
  'int_to_real','real_to_int','dint_to_real','real_to_dint',
  'uint_to_real','real_to_uint','lint_to_real','real_to_lint',
  'bool_to_int','int_to_bool','bool_to_uint','uint_to_bool',
  'norm_x','scale_x',
  'int_to_uint','uint_to_int','dint_to_int','int_to_dint',
  'uint_to_dint','dint_to_uint','lint_to_dint','dint_to_lint',
  'uint_to_lint','int_to_lint','word_to_uint','uint_to_word',
  'dword_to_udint','udint_to_dword',
  'uart_receive','uart_send',
]);

function validateSCLCode(code, variables, globalVars, monaco, model) {
  const allowed = new Set(ST_ALWAYS_ALLOWED);
  variables.forEach(v => { if (v.name) allowed.add(v.name.toLowerCase()); });
  globalVars.forEach(v => { if (v.name) allowed.add(v.name.toLowerCase()); });

  const markers = [];
  // Strip multi-line (* block comments *) from the whole code before line-by-line scan
  const strippedCode = (code || '').replace(/\(\*[\s\S]*?\*\)/g, match => '\n'.repeat((match.match(/\n/g) || []).length));
  const lines = strippedCode.split('\n');
  lines.forEach((rawLine, i) => {
    const line = rawLine.replace(/\/\/.*$/, '').replace(/\(\*.*?\*\)/g, '');
    const regex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      if (match.index > 0 && line[match.index - 1] === '.') continue;
      const word = match[0];
      if (!allowed.has(word.toLowerCase()) && isNaN(word)) {
        markers.push({
          severity: monaco.MarkerSeverity.Error,
          message: `Undefined identifier: '${word}'`,
          startLineNumber: i + 1,
          startColumn: match.index + 1,
          endLineNumber: i + 1,
          endColumn: match.index + 1 + word.length,
        });
      }
    }
  });
  monaco.editor.setModelMarkers(model, 'scl-owner', markers);
}

// Auto-sizing Monaco editor for SCL ST rungs.
// IMPORTANT: must stop mouse event propagation to prevent the outer
// draggable rung div from intercepting clicks and blocking Monaco input.
const SCLInlineEditor = ({ code, readOnly, onCodeChange, onBlur, variables = [], globalVars = [], liveVariables = null, parentName = '' }) => {
  const [height, setHeight] = useState(60);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const liveDecsRef = useRef([]);

  // Sync external code (undo/redo) into Monaco without resetting cursor
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const model = ed.getModel();
    if (model && model.getValue() !== code) {
      const pos = ed.getPosition();
      model.setValue(code || '');
      if (pos) ed.setPosition(pos);
    }
  }, [code]);

  // Re-validate when variables/globalVars change
  useEffect(() => {
    const ed = editorRef.current;
    const mc = monacoRef.current;
    if (!ed || !mc) return;
    const model = ed.getModel();
    if (model) validateSCLCode(model.getValue(), variables, globalVars, mc, model);
  }, [variables, globalVars]);

  // Live variable decorations
  useEffect(() => {
    const ed = editorRef.current;
    const mc = monacoRef.current;
    if (!ed || !mc) return;
    const model = ed.getModel();
    if (!model) return;

    if (!liveVariables) {
      liveDecsRef.current = ed.deltaDecorations(liveDecsRef.current, []);
      return;
    }

    const safeProgName = (parentName || '').trim().replace(/\s+/g, '_');
    const userVarNames = new Set([...variables.map(v => v.name), ...globalVars.map(v => v.name)]);
    const lines = model.getValue().split('\n');
    const decs = [];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const regex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
      let match;
      while ((match = regex.exec(line)) !== null) {
        const word = match[0];
        if (!userVarNames.has(word)) continue;
        const progKey = `prog_${safeProgName}_${word}`;
        const globalKey = `prog__${word}`;
        let val;
        if (liveVariables[progKey] !== undefined) val = liveVariables[progKey];
        else if (liveVariables[globalKey] !== undefined) val = liveVariables[globalKey];
        else continue;

        const isBool = typeof val === 'boolean';
        const displayStr = isBool ? (val ? 'TRUE' : 'FALSE') : String(val);
        const hlClass = isBool ? (val ? 'live-var-hl-true' : 'live-var-hl-false') : 'live-var-hl-num';
        const textClass = isBool ? (val ? 'live-var-text-true' : 'live-var-text-false') : 'live-var-text-num';
        decs.push({
          range: new mc.Range(lineIdx + 1, match.index + 1, lineIdx + 1, match.index + 1 + word.length),
          options: { className: hlClass, after: { content: ` ${displayStr}`, inlineClassName: textClass } },
        });
      }
    }

    liveDecsRef.current = ed.deltaDecorations(liveDecsRef.current, decs);
  }, [liveVariables, variables, globalVars, parentName]);

  return (
    <div
      draggable={false}
      onMouseDown={e => e.stopPropagation()}
      style={{ background: '#1e1e1e' }}
    >
      <Editor
        height={height}
        defaultLanguage="iec-st"
        theme="plc-dark"
        defaultValue={code || ''}
        options={{
          readOnly: !!readOnly,
          fontSize: 13,
          minimap: { enabled: false },
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          wordWrap: 'off',
          automaticLayout: true,
          renderLineHighlight: 'line',
          overviewRulerLanes: 0,
          folding: false,
          contextmenu: true,
          scrollbar: { vertical: 'hidden', horizontal: 'auto', alwaysConsumeMouseWheel: false },
        }}
        beforeMount={monaco => {
          registerIECSTLanguage(monaco);
          monacoRef.current = monaco;
          if (!document.getElementById('inline-live-var-style')) {
            const style = document.createElement('style');
            style.id = 'inline-live-var-style';
            style.textContent = `
              .live-var-text-true {
                background-color: #00c853 !important; color: #fff !important;
                font-size: 11px !important; font-weight: bold !important;
                font-style: normal !important; padding: 1px 5px !important;
                border-radius: 3px !important; margin-left: 4px !important;
              }
              .live-var-text-false {
                background-color: #d32f2f !important; color: #fff !important;
                font-size: 11px !important; font-weight: bold !important;
                font-style: normal !important; padding: 1px 5px !important;
                border-radius: 3px !important; margin-left: 4px !important;
              }
              .live-var-text-num {
                background-color: #1565c0 !important; color: #fff !important;
                font-size: 11px !important; font-style: normal !important;
                padding: 1px 5px !important; border-radius: 3px !important;
                margin-left: 4px !important;
              }
            `;
            document.head.appendChild(style);
          }
        }}
        onChange={val => onCodeChange(val ?? '')}
        onMount={editor => {
          editorRef.current = editor;
          const mc = monacoRef.current;
          const updateHeight = () => {
            const h = Math.max(60, editor.getContentHeight());
            setHeight(h);
          };
          editor.onDidContentSizeChange(updateHeight);
          updateHeight();
          editor.onDidBlurEditorText(onBlur);
          // Initial validation
          const model = editor.getModel();
          if (model && mc) {
            validateSCLCode(model.getValue(), variables, globalVars, mc, model);
            editor.onDidChangeModelContent(() => {
              validateSCLCode(model.getValue(), variables, globalVars, mc, model);
            });
          }
        }}
      />
    </div>
  );
};

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
 * Ladder Editor
 * - Rungs are arranged as a list
 * - Each rung has its own blocks and connections
 * - When a rung moves, everything inside moves with it
 */

const RungEditorNew = ({ variables, setVariables, rungs, setRungs, availableBlocks, globalVars = [], dataTypes = [], liveVariables = null, parentName = "", readOnly = false, onForceWrite = null, programType = 'LD', hwPortVars = [] }) => {
  // Undo/Redo history - each snapshot stores { rungs, variables } pair
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

  // SCL: pending rung lang selection dialog
  const [pendingSCLInsert, setPendingSCLInsert] = useState(null); // { targetId, before }

  // Rung selection & drag/drop
  const [focusedRungId, setFocusedRungId] = useState(null);
  const [draggedRungIndex, setDraggedRungIndex] = useState(null);
  const [dragOverRungIndex, setDragOverRungIndex] = useState(null);
  const [globalSelectedBlockId, setGlobalSelectedBlockId] = useState(null);

  // Save history snapshot - rungs and variables together
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
      const ae = document.activeElement;
      // Skip if typing in an input/textarea or inside a Monaco editor
      if (ae && (
        (ae.tagName === 'INPUT' && ae.type === 'text') ||
        ae.tagName === 'TEXTAREA' ||
        ae.closest?.('.monaco-editor')
      )) {
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

  // Update block data
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

      // If instanceName changed, update variables accordingly
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

  // Update block position (not saved to history for performance)
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

  // On block double-click: open settings (or force-write modal in simulation mode)
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

  // Save block settings
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
  const addRung = useCallback((targetId = null, before = false, lang = null) => {
    if (readOnly) return;
    // SCL programs: ask user to choose rung language if not provided
    if (programType === 'SCL' && !lang) {
      setPendingSCLInsert({ targetId, before });
      return;
    }
    const newRung = {
      id: `rung_${Date.now()}_${Math.random()}`,
      label: '',
      lang: programType === 'SCL' ? (lang || 'LD') : undefined,
      blocks: [],
      connections: [],
      code: ''
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
  }, [readOnly, programType, rungs, variables, focusedRungId, saveHistory]);

  const toggleRungLang = useCallback((rungId) => {
    if (readOnly) return;
    const newRungs = rungs.map(r => r.id === rungId ? { ...r, lang: r.lang === 'ST' ? 'LD' : 'ST' } : r);
    setRungs(newRungs);
    saveHistory(newRungs, variables);
  }, [readOnly, rungs, variables, saveHistory]);

  const updateRungCode = useCallback((rungId, code) => {
    if (readOnly) return;
    const newRungs = rungs.map(r => r.id === rungId ? { ...r, code } : r);
    setRungs(newRungs);
    // No history save on every keystroke — throttle by saving on blur
  }, [readOnly, rungs]);

  // Delete Rung
  const deleteRung = useCallback((rungId) => {
    if (readOnly) return;
    const newRungs = rungs.filter(r => r.id !== rungId);
    setRungs(newRungs);
    saveHistory(newRungs, variables);
  }, [readOnly, rungs, variables, saveHistory]);

  // Move rung up/down
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

      // Case A: no BOOL variable exists → auto-create one
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
      // Case B: BOOL variable exists → leave as empty placeholder
      else {
        insertBlock(rungId, blockType, position, '', customData, variables);
      }
      return;
    }

    // 2. Other blocks (Standard / UserDefined)
    let instanceName;
    let newVariables = variables;

    // Use predefined name pattern if available
    const dragData = typeof DragDropManager !== 'undefined' ? DragDropManager.getDragData() : null;
    const namePatternBase = dragData?.instanceNamePattern ? dragData.instanceNamePattern.replace(/[0-9]+$/, '') : null;

    if (customData && customData.name) {
      if (customData.type === 'functions') {
        instanceName = customData.name;
        // Functions do not create instances; variables unchanged
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
          description: '',
          _isInstance: true
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
        description: '',
        _isInstance: true
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

  // Delete block from rung; also remove its variable if unused, then save history
  const deleteBlockFromRung = useCallback((rungId, blockId) => {
    if (readOnly) return;
    let blockToDelete = null;
    let newRungs;
    setRungs(prevRungs => {
      newRungs = prevRungs.map(rung => {
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
      return newRungs;
    });

    // Remove the deleted block's variable if it is not used elsewhere
    // newRungs is set synchronously inside the updater before setVariables runs
    setTimeout(() => {
      if (!newRungs) return;
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
      saveHistory(newRungs, newVariables);
    }, 0);
  }, [readOnly, variables, saveHistory, setVariables]);

  // Add connection to rung
  const addConnectionToRung = useCallback((rungId, connection) => {
    if (readOnly) return;
    const newConn = { id: `conn_${Date.now()}_${Math.random()}`, ...connection };
    let newRungs;
    setRungs(prevRungs => {
      newRungs = prevRungs.map(rung => {
        if (rung.id === rungId) {
          return { ...rung, connections: [...rung.connections, newConn] };
        }
        return rung;
      });
      return newRungs;
    });
    setTimeout(() => { if (newRungs) saveHistory(newRungs, variables); }, 0);
  }, [readOnly, variables, saveHistory]);

  // Remove connection from rung
  const deleteConnectionFromRung = useCallback((rungId, connectionId) => {
    if (readOnly) return;
    let newRungs;
    setRungs(prevRungs => {
      newRungs = prevRungs.map(rung => {
        if (rung.id === rungId) {
          return { ...rung, connections: rung.connections.filter(c => c.id !== connectionId) };
        }
        return rung;
      });
      return newRungs;
    });
    setTimeout(() => { if (newRungs) saveHistory(newRungs, variables); }, 0);
  }, [readOnly, variables, saveHistory]);

  // Type icons for complex types (stripped on input in RungContainer)
  // ⊞ = Array, ⊡ = Struct, ⊟ = Enum
  const dtMap = (dataTypes || []).reduce((acc, dt) => { acc[dt.name] = dt; return acc; }, {});
  const blockTypeNames = new Set([
    ...Object.keys(blockConfig || {}),
    ...((availableBlocks || []).flatMap((block) => {
      const names = [];
      if (block?.name) names.push(block.name);
      if (block?.type && typeof block.type === 'string') names.push(block.type);
      if (block?.blockType) names.push(block.blockType);
      return names;
    })),
  ]);

  const allRawVars = [
    ...(variables || []).map(v => ({ ...v, scope: 'Local' })),
    ...(globalVars || []).map(v => ({ ...v, scope: 'Global' })),
  ];
  const allDataVars = allRawVars.filter((v) => {
    if (!v?.name || !v?.type) return false;
    if (v._isInstance) return false;
    return !blockTypeNames.has(v.type);
  });

  const varsByType = {};
  const NUMERIC_TYPES = new Set(['SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'REAL', 'LREAL', 'BYTE', 'WORD', 'DWORD', 'LWORD']);
  const INTEGER_TYPES = new Set(['SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'BYTE', 'WORD', 'DWORD', 'LWORD']);
  const REAL_TYPES = new Set(['REAL', 'LREAL']);
  const BIT_TYPES = new Set(['BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD']);
  const STRING_TYPES = new Set(['STRING', 'WSTRING']);
  const addOption = (type, value, options = {}) => {
    const { includeAnyFamilies = true } = options;
    if (!varsByType[type]) varsByType[type] = [];
    varsByType[type].push(value);
    if (includeAnyFamilies && type !== 'ANY') {
      if (!varsByType['ANY']) varsByType['ANY'] = [];
      varsByType['ANY'].push(value);
    }
    if (includeAnyFamilies && NUMERIC_TYPES.has(type)) {
      if (!varsByType['ANY_NUM']) varsByType['ANY_NUM'] = [];
      varsByType['ANY_NUM'].push(value);
    }
    if (includeAnyFamilies && INTEGER_TYPES.has(type)) {
      if (!varsByType['ANY_INT']) varsByType['ANY_INT'] = [];
      varsByType['ANY_INT'].push(value);
    }
    if (includeAnyFamilies && REAL_TYPES.has(type)) {
      if (!varsByType['ANY_REAL']) varsByType['ANY_REAL'] = [];
      varsByType['ANY_REAL'].push(value);
    }
    if (includeAnyFamilies && BIT_TYPES.has(type)) {
      if (!varsByType['ANY_BIT']) varsByType['ANY_BIT'] = [];
      varsByType['ANY_BIT'].push(value);
    }
    if (includeAnyFamilies && STRING_TYPES.has(type)) {
      if (!varsByType['ANY_STRING']) varsByType['ANY_STRING'] = [];
      varsByType['ANY_STRING'].push(value);
    }
  };

  allDataVars.forEach(v => {
    const s = v.scope === 'Global' ? '🌍' : '🏠';
    const dt = dtMap[v.type];
    if (dt?.type === 'Array') {
      addOption('ANY_DERIVED', `${s} ${v.name}`);
      const minIdx = parseInt(dt.content.dimensions[0].min);
      addOption(dt.content.baseType, `${s}⊞ ${v.name}[${minIdx}]`);
    } else if (dt?.type === 'Structure') {
      addOption('ANY_DERIVED', `${s} ${v.name}`);
      (dt.content.members || []).forEach(member => {
        addOption(member.type, `${s}⊡ ${v.name}.${member.name}`);
      });
    } else if (dt?.type === 'Enumerated') {
      addOption('ANY_DERIVED', `${s} ${v.name}`);
      addOption(v.type, `${s}⊟ ${v.name}`);
    } else {
      addOption(v.type, `${s} ${v.name}`);
    }
  });

  (hwPortVars || []).forEach((portVar) => {
    if (!portVar?.name) return;
    addOption('USINT', portVar.name, { includeAnyFamilies: false });
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
                {/* SCL lang toggle bar */}
                {programType === 'SCL' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px', background: '#2d2d2d', borderBottom: '1px solid #3a3a3a' }}>
                    <div
                      className="rung-drag-handle"
                      style={{ cursor: 'grab', color: '#555', fontSize: 14, padding: '0 2px', lineHeight: 1, userSelect: 'none' }}
                    >⠿</div>
                    <span style={{ fontSize: 10, color: '#888' }}>Rung {index}:</span>
                    {['LD', 'ST'].map(l => (
                      <button
                        key={l}
                        disabled={readOnly}
                        onClick={() => toggleRungLang(rung.id)}
                        style={{
                          padding: '1px 8px', fontSize: 11, borderRadius: 3, border: 'none', cursor: readOnly ? 'default' : 'pointer',
                          background: (rung.lang || 'LD') === l ? '#007acc' : '#3a3a3a',
                          color: (rung.lang || 'LD') === l ? '#fff' : '#aaa',
                          fontWeight: (rung.lang || 'LD') === l ? 'bold' : 'normal',
                        }}
                      >{l}</button>
                    ))}
                    {(rung.lang || 'LD') === 'ST' && !readOnly && (
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                        <button
                          onClick={() => moveRung(rung.id, 'up')}
                          disabled={index === 0}
                          style={{ background: index === 0 ? '#444' : '#0d47a1', color: '#fff', border: 'none', padding: '2px 7px', borderRadius: 3, cursor: index === 0 ? 'not-allowed' : 'pointer', fontSize: 10 }}
                        >↑ Yukarı</button>
                        <button
                          onClick={() => moveRung(rung.id, 'down')}
                          disabled={index === rungs.length - 1}
                          style={{ background: index === rungs.length - 1 ? '#444' : '#0d47a1', color: '#fff', border: 'none', padding: '2px 7px', borderRadius: 3, cursor: index === rungs.length - 1 ? 'not-allowed' : 'pointer', fontSize: 10 }}
                        >↓ Aşağı</button>
                        <button
                          onClick={() => deleteRung(rung.id)}
                          style={{ background: '#c62828', color: '#fff', border: 'none', padding: '2px 7px', borderRadius: 3, cursor: 'pointer', fontSize: 10 }}
                        >🗑 Delete</button>
                      </div>
                    )}
                  </div>
                )}
                <ErrorBoundary>
                  {programType === 'SCL' && (rung.lang || 'LD') === 'ST' ? (
                    <div
                      draggable={false}
                      onClick={() => setFocusedRungId(rung.id)}
                      style={{
                        background: '#2a2a2a',
                        border: focusedRungId === rung.id ? '2px solid #007acc' : '2px solid #444',
                        borderRadius: 8,
                        overflow: 'hidden',
                        boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
                        transition: 'border-color 0.2s',
                      }}
                    >
                      <SCLInlineEditor
                        code={rung.code || ''}
                        readOnly={readOnly}
                        onCodeChange={val => updateRungCode(rung.id, val)}
                        onBlur={() => saveHistory(rungs, variables)}
                        variables={variables}
                        globalVars={globalVars}
                        liveVariables={liveVariables}
                        parentName={parentName}
                      />
                    </div>
                  ) : (
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
                      hwPortVars={hwPortVars}
                      onFocusRung={() => {
                        if (readOnly) return;
                        selectedNodeRef.current = null;
                        setGlobalSelectedBlockId(null);
                        setFocusedRungId(rung.id);
                      }}
                    />
                  )}
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

      {/* SCL: choose rung language dialog */}
      {pendingSCLInsert && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
          <div style={{ background: '#252526', border: '1px solid #444', borderRadius: 8, padding: 24, minWidth: 260, boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}>
            <div style={{ color: '#eee', fontWeight: 'bold', fontSize: 14, marginBottom: 16 }}>Choose rung language</div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              {['LD', 'ST'].map(l => (
                <button
                  key={l}
                  onClick={() => { const p = pendingSCLInsert; setPendingSCLInsert(null); addRung(p.targetId, p.before, l); }}
                  style={{ padding: '8px 28px', fontSize: 14, borderRadius: 4, border: 'none', cursor: 'pointer', background: l === 'LD' ? '#1a6b3a' : '#0d47a1', color: '#fff', fontWeight: 'bold' }}
                >{l === 'LD' ? 'Ladder (LD)' : 'Structured Text (ST)'}</button>
              ))}
            </div>
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button onClick={() => setPendingSCLInsert(null)} style={{ background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

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
