import React, { useState, useEffect, useRef } from 'react';
import { Editor } from '@monaco-editor/react';
import VariableManager from './VariableManager';
import RungEditorNew from './RungEditorNew';
import ResourceEditor from './ResourceEditor';
import DragDropManager from '../utils/DragDropManager';

const EditorPane = ({
  fileType,
  initialContent,
  onContentChange,
  readOnly = false,
  allowedClasses = [],
  globalVars = [],
  availableBlocks = [],
  availablePrograms = [],
  projectStructure = null
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

  // Refs for checking current state in callbacks/providers without dependencies
  const variablesRef = useRef(variables);
  const globalVarsRef = useRef(globalVars);

  useEffect(() => {
    variablesRef.current = variables;
    globalVarsRef.current = globalVars;
  }, [variables, globalVars]);

  // --- SYNC WITH PARENT ---
  useEffect(() => {
    let newContent = {};
    if (fileType === 'ST') {
      newContent = { code, variables };
    } else if (fileType === 'LD') {
      newContent = { rungs, variables };
    } else if (fileType === 'RESOURCE_EDITOR') {
      newContent = { globalVars: variables, tasks, instances };
    } else {
      newContent = { ...initialContent, variables };
    }

    onContentChange(newContent);
  }, [code, rungs, variables, tasks, instances, fileType]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- VARIABLE MANAGERS HANDLERS ---
  const handleAddVar = (newVar) => {
    setVariables((prev) => [...prev, newVar]);
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
      const lines = text.split('\n');

      const allVarNames = new Set([
        ...variables.map(v => v.name),
        ...globalVars.map(v => v.name),
        'IF', 'THEN', 'ELSE', 'END_IF', 'CASE', 'OF', 'END_CASE', 'FOR', 'TO', 'DO', 'END_FOR',
        'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT', 'RETURN', 'EXIT',
        'TRUE', 'FALSE', 'BOOL', 'INT', 'REAL', 'TIME', 'STRING', 'TON', 'TOF', 'TP', 'CTU', 'CTD',
        'AND', 'OR', 'NOT', 'XOR', 'MOD', 'R_TRIG', 'F_TRIG'
      ]);

      lines.forEach((line, i) => {
        const regex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
        let match;
        while ((match = regex.exec(line)) !== null) {
          const word = match[0];
          if (!allVarNames.has(word) && isNaN(word)) {
            markers.push({
              severity: monacoInstance.MarkerSeverity.Error,
              message: `Undefined variable: '${word}'`,
              startLineNumber: i + 1,
              startColumn: match.index + 1,
              endLineNumber: i + 1,
              endColumn: match.index + 1 + word.length
            });
          }
        }
      });
      monacoInstance.editor.setModelMarkers(model, 'owner', markers);
    };

    validate();
    const disposable = model.onDidChangeContent(validate);
    return () => disposable.dispose();
  }, [variables, globalVars, code, fileType, monacoInstance]);

  // --- AUTOCOMPLETE PROVIDER ---
  useEffect(() => {
    if (!monacoInstance) return;

    // Register Completion Provider for 'pascal' (used for ST)
    const disposable = monacoInstance.languages.registerCompletionItemProvider('pascal', {
      provideCompletionItems: (model, position) => {
        const suggestions = [];

        // 1. Keywords
        const keywords = [
          'IF', 'THEN', 'ELSE', 'ELSIF', 'END_IF',
          'CASE', 'OF', 'END_CASE',
          'FOR', 'TO', 'BY', 'DO', 'END_FOR',
          'WHILE', 'END_WHILE',
          'REPEAT', 'UNTIL', 'END_REPEAT',
          'RETURN', 'EXIT',
          'TRUE', 'FALSE'
        ];

        keywords.forEach(kw => {
          suggestions.push({
            label: kw,
            kind: monacoInstance.languages.CompletionItemKind.Keyword,
            insertText: kw,
            detail: 'Keyword'
          });
        });

        // 2. Standard Functions/Blocks
        const stdBlocks = ['TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG'];
        stdBlocks.forEach(blk => {
          suggestions.push({
            label: blk,
            kind: monacoInstance.languages.CompletionItemKind.Class,
            insertText: blk,
            detail: 'Standard FB'
          });
        });

        // 3. Variables (Local & Global)
        // Access via Refs to get latest state
        const allVars = [
          ...variablesRef.current,
          ...globalVarsRef.current
        ];

        allVars.forEach(v => {
          suggestions.push({
            label: v.name,
            kind: monacoInstance.languages.CompletionItemKind.Variable,
            insertText: v.name,
            detail: `${v.type} (${v.class || 'Var'})`
          });
        });

        return { suggestions: suggestions };
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

    monaco.editor.defineTheme('plc-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'keyword', foreground: '569CD6', fontStyle: 'bold' },
        { token: 'identifier', foreground: '9CDCFE' },
        { token: 'number', foreground: 'B5CEA8' },
        { token: 'string', foreground: 'CE9178' },
        { token: 'comment', foreground: '6A9955' },
        { token: 'operator', foreground: 'D4D4D4' }
      ],
      colors: {
        'editor.background': '#1e1e1e',
        'editorCursor.foreground': '#AEAFAD',
        'editor.lineHighlightBackground': '#2b2b2b',
        'editorLineNumber.foreground': '#858585',
        'editor.selectionBackground': '#264f78',
        'editor.inactiveSelectionBackground': '#3a3d41'
      }
    });
    monaco.editor.setTheme('plc-dark');
  };

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
    const snippet = dragData ? dragData.stSnippet : e.dataTransfer.getData('stSnippet');

    if (snippet && window.stEditor) {
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: '#1e1e1e' }}>
      {fileType !== 'RESOURCE_EDITOR' && (
        <div style={{ height: '30%', minHeight: '150px', flexShrink: 0 }}>
          <VariableManager
            variables={variables}
            onAdd={handleAddVar}
            onDelete={handleDeleteVar}
            onUpdate={handleUpdateVar}
            allowedClasses={allowedClasses}
            globalVars={globalVars}
            derivedTypes={projectStructure?.dataTypes?.map(d => d.name) || []}
            userDefinedTypes={availableBlocks?.map(b => b.name) || []}
          />
        </div>
      )}

      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', borderTop: '2px solid #444' }}>
        {fileType === 'LD' ? (
          <RungEditorNew
            variables={variables}
            setVariables={setVariables}
            rungs={rungs}
            setRungs={setRungs}
            availableBlocks={availableBlocks}
            globalVars={globalVars}
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
              defaultLanguage="pascal"
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
                readOnly: readOnly,
                dnd: true
              }}
              onMount={handleEditorDidMount}
            />
          </div>
        ) : fileType === 'RESOURCE_EDITOR' ? (
          <ResourceEditor
            content={{ globalVars: variables, tasks, instances }}
            onContentChange={(newContent) => {
              setVariables(newContent.globalVars || []);
              setTasks(newContent.tasks || []);
              setInstances(newContent.instances || []);
            }}
            availablePrograms={availablePrograms}
            derivedTypes={projectStructure?.dataTypes?.map(d => d.name) || []}
            userDefinedTypes={availableBlocks?.map(b => b.name) || []}
          />
        ) : (
          <div style={{ padding: 20, color: '#aaa', textAlign: 'center' }}>
            Editor not available for {fileType}
          </div>
        )}
      </div>
    </div>
  );
};

export default EditorPane;