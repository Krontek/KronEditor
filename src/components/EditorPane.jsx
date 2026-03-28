import { useState, useEffect, useRef } from 'react';
import { Editor } from '@monaco-editor/react';
import { registerIECSTLanguage } from '../utils/iecSTLanguage';
import VariableManager from './VariableManager';
import RungEditorNew from './RungEditorNew';
import ResourceEditor from './ResourceEditor';
import DragDropManager from '../utils/DragDropManager';
import ForceWriteModal from './common/ForceWriteModal';

const EditorPane = ({
  fileType,
  initialContent,
  onContentChange,
  readOnly = false,
  allowedClasses = [],
  globalVars = [],
  availableBlocks = [],
  availablePrograms = [],
  projectStructure = null,
  liveVariables = null,
  parentName = "",
  isRunning = false,
  isSimulationMode = false,
  onForceWrite = null,
  onAddToWatchTable = null,
  hwPortVars = [],
}) => {
  // --- STATE MANAGEMENT ---
  // We use separate state checks to ensure safety
  const [variables, setVariables] = useState(initialContent?.variables || initialContent?.globalVars || []);
  const [code, setCode] = useState(initialContent?.code || '');
  const [rungs, setRungs] = useState(initialContent?.rungs || []);
  const [tasks, setTasks] = useState(initialContent?.tasks || []);
  const [instances, setInstances] = useState(initialContent?.instances || []);

  const [monacoInstance, setMonacoInstance] = useState(null);
  const editorRef = useRef(null);

  // Layout state for VariableManager vs Editor
  const [variablePaneHeight, setVariablePaneHeight] = useState(250); // Default px
  const [isResizingVarPane, setIsResizingVarPane] = useState(false);

  // ST Editor Force Write Modal state
  const [stForceWriteData, setStForceWriteData] = useState(null);

  // Refs for checking current state in callbacks/providers without dependencies
  const variablesRef = useRef(variables);
  const globalVarsRef = useRef(globalVars);
  const projectStructureRef = useRef(projectStructure);

  useEffect(() => {
    variablesRef.current = variables;
    globalVarsRef.current = globalVars;
    projectStructureRef.current = projectStructure;
  }, [variables, globalVars, projectStructure]);

  // --- SYNC WITH PARENT ---
  useEffect(() => {
    let newContent = {};
    if (fileType === 'ST') {
      newContent = { code, variables };
    } else if (fileType === 'LD' || fileType === 'SCL') {
      newContent = { rungs, variables };
    } else if (fileType === 'RESOURCE_EDITOR') {
      newContent = { globalVars: variables, tasks, instances };
    } else {
      newContent = { ...initialContent, variables };
    }

    onContentChange(newContent);
  }, [code, rungs, variables, tasks, instances, fileType]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- VARIABLE MANAGERS HANDLERS ---
  const handleAddVar = (newVar, insertAfterIndex) => {
    setVariables((prev) => {
      if (insertAfterIndex === undefined || insertAfterIndex < 0) return [...prev, newVar];
      const next = [...prev];
      next.splice(insertAfterIndex + 1, 0, newVar);
      return next;
    });
  };

  const handleDeleteVar = (id) => {
    const variableToDelete = variables.find(v => v.id === id);
    if (!variableToDelete) return;

    const newVariables = variables.filter((v) => v.id !== id);
    setVariables(newVariables);

    if (fileType === 'LD') {
      setRungs(prevRungs => prevRungs.map(rung => ({
        ...rung,
        blocks: rung.blocks.filter(b => b.data.instanceName !== variableToDelete.name),
        connections: rung.connections.filter(c => {
          const sourceExists = rung.blocks.some(b => b.id === c.source);
          const targetExists = rung.blocks.some(b => b.id === c.target);
          return sourceExists && targetExists;
        })
      })));
    }
  };

  const handleUpdateVar = (id, field, value) => {
    const oldVar = variables.find(v => v.id === id);
    const oldName = oldVar?.name;

    setVariables((prev) =>
      prev.map((v) => (v.id === id ? { ...v, [field]: value } : v))
    );

    if (field === 'name' && fileType === 'LD' && oldName && oldName !== value) {
      setRungs(prevRungs => prevRungs.map(rung => ({
        ...rung,
        blocks: rung.blocks.map(block => {
          const newData = { ...block.data };
          let changed = false;

          if (newData.instanceName === oldName) {
            newData.instanceName = value;
            changed = true;
          }

          if (newData.values) {
            Object.keys(newData.values).forEach(key => {
              if (newData.values[key] === oldName) {
                newData.values[key] = value;
                changed = true;
              }
            });
          }
          return changed ? { ...block, data: newData } : block;
        })
      })));
    } else if (field === 'type' && fileType === 'LD' && oldName) {
      // Cascade variable type change to the matching Block instances in Rungs
      setRungs(prevRungs => prevRungs.map(rung => ({
        ...rung,
        blocks: rung.blocks.map(block => {
          if (block.data.instanceName === oldName) {
            return {
              ...block,
              type: value,
              data: {
                ...block.data,
                type: value,
                label: value
              }
            };
          }
          return block;
        })
      })));
    }
  };

  // --- ST VALIDATION LOGIC ---
  useEffect(() => {
    if (fileType !== 'ST' || !monacoInstance || !window.stEditor) return;

    const editor = window.stEditor;
    const model = editor.getModel();
    if (!model) return;

    const validate = () => {
      const text = model.getValue();
      const markers = [];
      // Strip multi-line (* block comments *) from the whole text before line-by-line scan
      const stripped = text.replace(/\(\*[\s\S]*?\*\)/g, match => '\n'.repeat((match.match(/\n/g) || []).length));
      const lines = stripped.split('\n');

      // Case-insensitive set: IEC 61131-3 identifiers are case-insensitive
      const allowedLower = new Set([
        ...variables.map(v => (v.name || '').toLowerCase()),
        ...globalVars.map(v => (v.name || '').toLowerCase()),
        // control flow keywords
        'if', 'then', 'elsif', 'else', 'end_if',
        'case', 'of', 'end_case',
        'for', 'to', 'by', 'do', 'end_for',
        'while', 'end_while',
        'repeat', 'until', 'end_repeat',
        'return', 'exit',
        // literals & operators
        'true', 'false', 'and', 'or', 'not', 'xor', 'mod',
        // types
        'bool', 'int', 'uint', 'dint', 'udint', 'lint', 'ulint',
        'real', 'lreal', 'time', 'string', 'byte', 'word', 'dword', 'lword',
        // standard FBs
        'ton', 'tof', 'tp', 'tonr',
        'ctu', 'ctd', 'ctud',
        'sr', 'rs', 'r_trig', 'f_trig',
        // standard functions — bit logic
        'shl', 'shr', 'rol', 'ror', 'band', 'bor', 'bxor', 'bnot',
        // standard functions — math
        'add', 'sub', 'mul', 'div', 'abs', 'sqrt', 'expt',
        'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
        'max', 'min', 'limit', 'sel', 'mux', 'move',
        // standard functions — comparison
        'gt', 'ge', 'eq', 'ne', 'le', 'lt',
        // standard functions — conversion
        'byte_to_uint', 'byte_to_int', 'byte_to_dint', 'byte_to_real',
        'int_to_real', 'real_to_int', 'dint_to_real', 'real_to_dint',
        'bool_to_int', 'int_to_bool', 'norm_x', 'scale_x',
        'int_to_uint', 'uint_to_int', 'dint_to_int', 'int_to_dint',
        // HAL block types (used as FB instance type names in expressions)
        'uart_receive', 'uart_send',
      ]);

      lines.forEach((rawLine, i) => {
        // Strip single-line comments before scanning
        const line = rawLine.replace(/\/\/.*$/, '').replace(/\(\*.*?\*\)/g, '');
        const regex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
        let match;
        while ((match = regex.exec(line)) !== null) {
          if (match.index > 0 && line[match.index - 1] === '.') continue;
          const word = match[0];
          if (!allowedLower.has(word.toLowerCase()) && isNaN(word)) {
            markers.push({
              severity: monacoInstance.MarkerSeverity.Error,
              message: `Undefined identifier: '${word}'`,
              startLineNumber: i + 1,
              startColumn: match.index + 1,
              endLineNumber: i + 1,
              endColumn: match.index + 1 + word.length
            });
          }
        }
      });
      monacoInstance.editor.setModelMarkers(model, 'owner', markers);

      // ONLINE MODE DECORATIONS (CoDeSys-style inline values)
      if (liveVariables && window.stEditor) {
        const decs = [];
        const safeProgName = (parentName || "").trim().replace(/\s+/g, '_');

        // Only look up actual user-defined variables, not keywords
        const userVarNames = new Set([
          ...variables.map(v => v.name),
          ...globalVars.map(v => v.name)
        ]);

        lines.forEach((line, i) => {
          const regex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
          let match;
          while ((match = regex.exec(line)) !== null) {
            const word = match[0];
            if (!userVarNames.has(word)) continue;

            // Try program-scoped key first, then global key
            const progKey = `prog_${safeProgName}_${word}`;
            const globalKey = `prog__${word}`;
            let val;
            if (liveVariables[progKey] !== undefined) {
              val = liveVariables[progKey];
            } else if (liveVariables[globalKey] !== undefined) {
              val = liveVariables[globalKey];
            } else {
              continue;
            }

            const isBool = typeof val === 'boolean';
            const displayStr = isBool ? (val ? 'TRUE' : 'FALSE') : String(val);
            const hlClass = isBool ? (val ? 'live-var-hl-true' : 'live-var-hl-false') : 'live-var-hl-num';
            const textClass = isBool ? (val ? 'live-var-text-true' : 'live-var-text-false') : 'live-var-text-num';

            decs.push({
              range: new monacoInstance.Range(
                i + 1, match.index + 1,
                i + 1, match.index + 1 + word.length
              ),
              options: {
                className: hlClass,
                after: {
                  content: ` ${displayStr}`,
                  inlineClassName: textClass,
                }
              }
            });
          }
        });

        window.stEditor._liveDecs = window.stEditor.deltaDecorations(window.stEditor._liveDecs || [], decs);
      } else if (window.stEditor && window.stEditor._liveDecs) {
        // Clear decorations when not in simulation
        window.stEditor._liveDecs = window.stEditor.deltaDecorations(window.stEditor._liveDecs, []);
      }
    };

    validate();
    const disposable = model.onDidChangeContent(validate);
    return () => disposable.dispose();
  }, [variables, globalVars, code, fileType, monacoInstance, liveVariables, parentName]);

  // --- AUTOCOMPLETE PROVIDER ---
  useEffect(() => {
    if (!monacoInstance) return;

    const CIK = monacoInstance.languages.CompletionItemKind;

    // Helper: find members of a named data type
    const getMembersOf = (typeName) => {
      const dt = (projectStructureRef.current?.dataTypes || []).find(d => d.name === typeName);
      if (!dt) return null;
      return dt;
    };

    // Register Completion Provider for 'pascal' (used for ST)
    const disposable = monacoInstance.languages.registerCompletionItemProvider('iec-st', {
      triggerCharacters: ['.', '['],
      provideCompletionItems: (model, position) => {
        const suggestions = [];
        const lineContent = model.getLineContent(position.lineNumber);
        const beforeCursor = lineContent.substring(0, position.column - 1);
        const allVars = [...variablesRef.current, ...globalVarsRef.current];

        // ── Member access: varName.member ──────────────────────────────────
        const dotMatch = beforeCursor.match(/(\w+)\.(\w*)$/);
        if (dotMatch) {
          const baseName = dotMatch[1];
          const baseVar = allVars.find(v => v.name === baseName);
          if (baseVar) {
            const dt = getMembersOf(baseVar.type);
            if (dt?.type === 'Structure') {
              (dt.content?.members || []).forEach(m => {
                suggestions.push({
                  label: m.name,
                  kind: CIK.Field,
                  insertText: m.name,
                  detail: `${m.type}  — ${baseVar.type}.${m.name}`,
                  documentation: m.description || ''
                });
              });
            } else if (dt?.type === 'Enumerated') {
              (dt.content?.values || []).forEach(v => {
                suggestions.push({
                  label: v.name,
                  kind: CIK.EnumMember,
                  insertText: v.name,
                  detail: `${baseVar.type}#${v.name}`,
                  documentation: v.value !== undefined ? `= ${v.value}` : ''
                });
              });
            }
          }
          return { suggestions, incomplete: false };
        }

        // ── Array index access: varName[ ───────────────────────────────────
        const bracketMatch = beforeCursor.match(/(\w+)\[(\d*)$/);
        if (bracketMatch) {
          const baseName = bracketMatch[1];
          const baseVar = allVars.find(v => v.name === baseName);
          if (baseVar) {
            const dt = getMembersOf(baseVar.type);
            if (dt?.type === 'Array') {
              const dims = dt.content?.dimensions || [];
              const dim = dims[0];
              if (dim) {
                const lo = Number(dim.min), hi = Number(dim.max);
                const count = Math.min(hi - lo + 1, 20);
                for (let i = 0; i < count; i++) {
                  const idx = lo + i;
                  suggestions.push({
                    label: String(idx),
                    kind: CIK.Value,
                    insertText: `${idx}]`,
                    detail: `${dt.content?.baseType}  — index ${idx} of ${baseVar.type}[${lo}..${hi}]`
                  });
                }
              }
            }
          }
          return { suggestions, incomplete: false };
        }

        // ── Base completions ───────────────────────────────────────────────
        const keywords = [
          'IF', 'THEN', 'ELSE', 'ELSIF', 'END_IF',
          'CASE', 'OF', 'END_CASE',
          'FOR', 'TO', 'BY', 'DO', 'END_FOR',
          'WHILE', 'END_WHILE',
          'REPEAT', 'UNTIL', 'END_REPEAT',
          'RETURN', 'EXIT', 'TRUE', 'FALSE'
        ];
        keywords.forEach(kw => {
          suggestions.push({ label: kw, kind: CIK.Keyword, insertText: kw, detail: 'Keyword' });
        });

        const stdBlocks = ['TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG'];
        stdBlocks.forEach(blk => {
          suggestions.push({ label: blk, kind: CIK.Class, insertText: blk, detail: 'Standard FB' });
        });

        allVars.forEach(v => {
          const dt = getMembersOf(v.type);
          let insertText = v.name;
          let detail = `${v.type} (${v.class || 'Var'})`;
          if (dt?.type === 'Structure') {
            detail += '  { }';
          } else if (dt?.type === 'Array') {
            detail += `  [${dt.content?.dimensions?.[0]?.min}..${dt.content?.dimensions?.[0]?.max}]`;
          } else if (dt?.type === 'Enumerated') {
            detail += '  (enum)';
          }
          suggestions.push({ label: v.name, kind: CIK.Variable, insertText, detail });
        });

        return { suggestions };
      }
    });

    return () => {
      disposable.dispose();
    };
  }, [monacoInstance]); // Only re-register if monaco instance changes (rarely)

  // --- ST EDITOR CONFIGURATION & DRAG-DROP ---
  const handleEditorDidMount = (editor, monaco) => {
    editorRef.current = editor;
    setMonacoInstance(monaco);
    window.stEditor = editor;

    // ── Register IEC 61131-3 Structured Text language & plc-dark theme ──
    registerIECSTLanguage(monaco);

    // Inject CSS for live variable inline decorations (only once)
    if (!document.getElementById('inline-live-var-style')) {
      const style = document.createElement('style');
      style.id = 'inline-live-var-style';
      style.textContent = `
        .live-var-hl-true  {}
        .live-var-hl-false {}
        .live-var-hl-num   {}
        .live-var-text-true {
          background-color: #00c853 !important;
          color: #fff !important;
          font-size: 11px !important;
          font-weight: bold !important;
          font-style: normal !important;
          padding: 1px 5px !important;
          border-radius: 3px !important;
          margin-left: 4px !important;
        }
        .live-var-text-false {
          background-color: #d32f2f !important;
          color: #fff !important;
          font-size: 11px !important;
          font-weight: bold !important;
          font-style: normal !important;
          padding: 1px 5px !important;
          border-radius: 3px !important;
          margin-left: 4px !important;
        }
        .live-var-text-num {
          background-color: #1565c0 !important;
          color: #fff !important;
          font-size: 11px !important;
          font-style: normal !important;
          padding: 1px 5px !important;
          border-radius: 3px !important;
          margin-left: 4px !important;
        }
      `;
      document.head.appendChild(style);
    }

    // Add mouse down listener for live variable manipulation
    editor.onMouseDown((e) => {
      // We only care if we are in simulation mode and we have liveVariables and onForceWrite
      if (!window.liveVariablesRef || !window.onForceWriteRef) return;

      const liveVars = window.liveVariablesRef;
      const onForceWriteFn = window.onForceWriteRef;

      // Ensure click target is text
      if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;

      // Require double click for manipulation to avoid interfering with normal text selection
      if (e.event.detail !== 2) return;

      const position = e.target.position;
      const model = editor.getModel();
      const wordInfo = model.getWordAtPosition(position);

      if (!wordInfo) return;
      const word = wordInfo.word;

      const safeProgName = (window.parentNameRef || "").trim().replace(/\s+/g, '_');
      const progKey = `prog_${safeProgName}_${word}`;
      const globalKey = `prog__${word}`;

      let lookupKey = null;
      if (liveVars[progKey] !== undefined) {
        lookupKey = progKey;
      } else if (liveVars[globalKey] !== undefined) {
        lookupKey = globalKey;
      }

      if (lookupKey) {
        // Find variable type
        const allVars = [...window.variablesRef, ...window.globalVarsRef];
        const v = allVars.find(vari => vari.name === word);
        const vType = v ? v.type : 'BOOL';

        // Open Modal
        window.setStForceWriteDataFn({
          varName: word,
          varType: vType,
          currentValue: liveVars[lookupKey],
          liveKey: lookupKey
        });
      }
    });
  };

  // Sync refs to window for the monaco callback to access current state
  useEffect(() => {
    window.liveVariablesRef = liveVariables;
    window.onForceWriteRef = onForceWrite;
    window.parentNameRef = parentName;
    window.variablesRef = variables;
    window.globalVarsRef = globalVars;
    window.setStForceWriteDataFn = setStForceWriteData;
  }, [liveVariables, onForceWrite, parentName, variables, globalVars]);

  useEffect(() => {
    if (!monacoInstance || !window.stEditor || fileType !== 'ST') return;
    const editor = window.stEditor;
    const widgetId = 'st-drag-ghost-widget';

    const createWidget = (position, text) => ({
      getId: () => widgetId,
      getDomNode: () => {
        const domNode = document.createElement('div');
        domNode.style.cssText = 'margin:0;padding:2px 4px;font-family:Consolas,monospace;font-size:14px;color:rgba(255,255,255,0.5);pointer-events:none;white-space:pre;font-style:italic';
        domNode.textContent = text;
        return domNode;
      },
      getPosition: () => ({
        position: position,
        preference: [monacoInstance.editor.ContentWidgetPositionPreference.EXACT]
      })
    });

    const lastPosRef = { current: null };
    const lastTimeRef = { current: 0 };

    const handleDragOver = (e) => {
      const now = Date.now();
      if (now - lastTimeRef.current < 40) return;
      lastTimeRef.current = now;

      const dragData = DragDropManager.getDragData();
      const snippet = dragData ? dragData.stSnippet : null;
      if (!snippet) return;

      const target = editor.getTargetAtClientPoint(e.clientX, e.clientY);
      if (target && target.position) {
        if (lastPosRef.current &&
          lastPosRef.current.lineNumber === target.position.lineNumber &&
          lastPosRef.current.column === target.position.column) {
          return;
        }
        lastPosRef.current = target.position;
        const widget = createWidget(target.position, snippet);
        try { editor.removeContentWidget({ getId: () => widgetId }); } catch (err) { }
        editor.addContentWidget(widget);
      }
    };

    const handleDragLeave = () => {
      try { editor.removeContentWidget({ getId: () => widgetId }); } catch (err) { }
    };
    const handleDropClean = () => {
      try { editor.removeContentWidget({ getId: () => widgetId }); } catch (err) { }
    };

    window.stHandleDragOver = handleDragOver;
    window.stHandleDragLeave = handleDragLeave;
    window.stHandleDropClean = handleDropClean;

    return () => {
      delete window.stHandleDragOver;
      delete window.stHandleDragLeave;
      delete window.stHandleDropClean;
      try { editor.removeContentWidget({ getId: () => widgetId }); } catch (err) { }
    };
  }, [monacoInstance, fileType]);

  const handleSTDrop = (e) => {
    e.preventDefault();
    if (window.stHandleDropClean) window.stHandleDropClean();

    const dragData = DragDropManager.getDragData();
    let snippet = dragData ? dragData.stSnippet : e.dataTransfer.getData('stSnippet');

    if (snippet && window.stEditor) {
      if (dragData && dragData.type === 'blockNode' && dragData.instanceNamePattern) {
        // Variables are only required for Function Blocks, not standard Functions (which have return types)
        const isFunction = dragData.customData && (dragData.customData.returnType || dragData.customData.type === 'functions' || dragData.customData.class === 'Function');
        const isContactOrCoil = dragData.blockType === 'Contact' || dragData.blockType === 'Coil';

        if (!isFunction && !isContactOrCoil) {
          const rawBaseName = dragData.instanceNamePattern.replace(/[0-9]+$/, '');
          const baseName = rawBaseName.trim().replace(/\s+/g, '_');
          let index = 0;
          let newName = '';
          const allVars = [...variablesRef.current, ...globalVarsRef.current];

          while (true) {
            const candidate = `${baseName}${index}`;
            if (!allVars.some(v => v.name === candidate)) {
              newName = candidate;
              break;
            }
            index++;
            if (index > 1000) break;
          }

          // Replace the hardcoded instance name in the snippet with the safe newName
          const hardcodedName = `${rawBaseName}0`;
          if (snippet.startsWith(hardcodedName)) {
            snippet = newName + snippet.substring(hardcodedName.length);
          }

          // Add the matched variable to local variables
          const newVar = {
            id: `st_fb_inst_${Date.now()}`,
            name: newName,
            class: 'Local',
            type: dragData.customData?.name || dragData.blockType,
            location: '',
            initialValue: '',
            description: 'FB Instance'
          };
          handleAddVar(newVar);
        }
      }

      const editor = window.stEditor;
      const position = editor.getTargetAtClientPoint(e.clientX, e.clientY)?.position;

      if (position) {
        const range = new monacoInstance.Range(position.lineNumber, position.column, position.lineNumber, position.column);
        editor.executeEdits('dnd', [{ range: range, text: snippet, forceMoveMarkers: true }]);
        editor.pushUndoStop();
      }
    }
    DragDropManager.clear();
  };

  const startResizingVarPane = () => {
    setIsResizingVarPane(true);
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizingVarPane) return;

      // EditorPane generally starts below the header/toolbar. We can calculate height based on bounding rect if needed,
      // but simpler approach: e.clientY relative to the EditorPane top or just take a reasonable delta.
      // Easiest is to measure distance from top of screen assuming EditorPane is relatively fixed.
      // Wait, let's just find the container offset.
      const pane = document.getElementById('editor-pane-container');
      if (pane) {
        const rect = pane.getBoundingClientRect();
        const newHeight = Math.max(100, Math.min(e.clientY - rect.top, rect.height - 100)); // Min 100px, Max (container - 100px)
        setVariablePaneHeight(newHeight);
      }
    };

    const handleMouseUp = () => {
      setIsResizingVarPane(false);
    };

    if (isResizingVarPane) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingVarPane]);

  return (
    <div id="editor-pane-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: '#1e1e1e' }}>
      {fileType !== 'RESOURCE_EDITOR' && (
        <div style={{ height: variablePaneHeight, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
          <VariableManager
            variables={variables}
            onAdd={handleAddVar}
            onDelete={handleDeleteVar}
            onUpdate={handleUpdateVar}
            allowedClasses={allowedClasses}
            globalVars={globalVars}
            derivedTypes={projectStructure?.dataTypes || []}
            userDefinedTypes={availableBlocks || []}
            liveVariables={liveVariables}
            parentName={parentName}
            disabled={isRunning}
            isRunning={isRunning}
            isSimulationMode={isSimulationMode}
            onForceWrite={onForceWrite}
            onAddToWatchTable={onAddToWatchTable}
            projectStructure={projectStructure}
          />
        </div>
      )}

      {/* HORIZONTAL RESIZER FOR VARIABLE PANE */}
      {fileType !== 'RESOURCE_EDITOR' && (
        <div
          onMouseDown={startResizingVarPane}
          style={{
            height: 5,
            cursor: 'row-resize',
            background: isResizingVarPane ? '#007acc' : '#2d2d2d',
            zIndex: 10,
            flexShrink: 0,
            borderTop: '1px solid #333',
            borderBottom: '1px solid #333'
          }}
        />
      )}

      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {(fileType === 'LD' || fileType === 'SCL') ? (
          <RungEditorNew
            variables={variables}
            setVariables={setVariables}
            rungs={rungs}
            setRungs={setRungs}
            availableBlocks={availableBlocks}
            globalVars={globalVars}
            dataTypes={projectStructure?.dataTypes || []}
            liveVariables={liveVariables}
            parentName={parentName}
            readOnly={isRunning}
            onForceWrite={onForceWrite}
            programType={fileType}
            hwPortVars={hwPortVars}
          />
        ) : fileType === 'ST' ? (
          <div
            style={{ height: '100%', width: '100%' }}
            onDragOverCapture={(e) => {
              e.preventDefault();
              if (window.stHandleDragOver) window.stHandleDragOver(e);
            }}
            onDragLeaveCapture={(e) => {
              if (window.stHandleDragLeave) window.stHandleDragLeave(e);
            }}
            onDropCapture={handleSTDrop}
          >
            <Editor
              height="100%"
              defaultLanguage="iec-st"
              theme="plc-dark"
              value={code || ''}
              onChange={(val) => setCode(val)}
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                fontFamily: "'Consolas', 'Courier New', monospace",
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                readOnly: readOnly || isRunning,
                dnd: !isRunning
              }}
              onMount={handleEditorDidMount}
            />
          </div>
        ) : fileType === 'RESOURCE_EDITOR' ? (
          <ResourceEditor
            content={{ globalVars: variables, tasks, instances, projectStructure }}
            onContentChange={(newContent) => {
              setVariables(newContent.globalVars || []);
              setTasks(newContent.tasks || []);
              setInstances(newContent.instances || []);
            }}
            availablePrograms={availablePrograms}
            derivedTypes={projectStructure?.dataTypes || []}
            userDefinedTypes={availableBlocks || []}
            liveVariables={liveVariables}
            isRunning={isRunning}
            isSimulationMode={isSimulationMode}
            onForceWrite={onForceWrite}
          />
        ) : (
          <div style={{ padding: 20, color: '#aaa', textAlign: 'center' }}>
            Editor not available for {fileType}
          </div>
        )}
      </div>

      {/* Force Write Modal for ST Editor */}
      {stForceWriteData && (
        <ForceWriteModal
          isOpen={true}
          onClose={() => setStForceWriteData(null)}
          varName={stForceWriteData.varName}
          varType={stForceWriteData.varType}
          currentValue={stForceWriteData.currentValue}
          liveKey={stForceWriteData.liveKey}
          onConfirm={(key, val) => {
            if (onForceWrite) onForceWrite(key, val);
          }}
        />
      )}
    </div>
  );
};

export default EditorPane;