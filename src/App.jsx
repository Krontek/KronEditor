import React, { useState, useEffect, useCallback } from 'react';
import EditorPane from './components/EditorPane';
import Toolbox from './components/Toolbox';
import ProjectSidebar from './components/ProjectSidebar';
import CreateItemModal from './components/CreateItemModal';
import DataTypeCreationModal from './components/DataTypeCreationModal';
import ErrorBoundary from './components/ErrorBoundary';
import SettingsPage from './components/SettingsPage';
import ShortcutsModal from './components/ShortcutsModal';
import { useTranslation } from 'react-i18next';
import { exportProjectToXml, importProjectFromXml } from './services/XmlService';
import { libraryService } from './services/LibraryService'; // Import Service
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { compileProjectToST } from './services/CompilerService';
import './App.css';

function App() {
  const { t } = useTranslation();

  // Library State
  const [libraryData, setLibraryData] = useState([]);

  // Load Library on Mount
  useEffect(() => {
    libraryService.loadLibrary().then(data => {
      console.log("Library Loaded:", data);
      setLibraryData(data);
    });
  }, []);

  // Global Project State
  const [projectStructure, setProjectStructure] = useState({
    dataTypes: [],
    functionBlocks: [],
    functions: [],
    programs: [],
    resources: [
      {
        id: 'res_config',
        name: 'Configuration',
        type: 'RESOURCE_EDITOR',
        content: {
          globalVars: [],
          tasks: [],
          instances: []
        }
      }
    ]
  });

  const [activeId, setActiveId] = useState(null);
  const [createModal, setCreateModal] = useState({
    isOpen: false,
    category: '',
    defaultName: ''
  });

  const [dataTypeModal, setDataTypeModal] = useState({
    isOpen: false,
    existingNames: []
  });

  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);

  const [currentFilePath, setCurrentFilePath] = useState(null);

  // App Settings State
  // App Settings State - Persisted to LocalStorage
  const [theme, setTheme] = useState(() => localStorage.getItem('appTheme') || 'dark');
  const [editorSettings, setEditorSettings] = useState(() => {
    const saved = localStorage.getItem('editorSettings');
    return saved ? JSON.parse(saved) : { fontSize: 14, minimap: true, wordWrap: false };
  });

  // Persist settings
  useEffect(() => {
    localStorage.setItem('appTheme', theme);
    document.body.className = theme; // Optional: apply class if needed globally
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('editorSettings', JSON.stringify(editorSettings));
  }, [editorSettings]);

  // --- Layout & Resizing State ---
  const [layout, setLayout] = useState({
    leftWidth: 250,
    rightWidth: 250,
    consoleHeight: 150
  });
  const [isResizing, setIsResizing] = useState(null); // 'left', 'right', 'console'

  // Sahte Konsol Logları
  const [logs, setLogs] = useState([
    { type: 'info', msg: 'PLC Editörü başlatıldı v2.1' },
    { type: 'success', msg: 'Hazır.' }
  ]);

  const addLog = useCallback((type, msg) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { type, msg: `[${time}] ${msg}` }]);
  }, []);

  // --- File Operations ---

  const handleSave = useCallback(async () => {
    if (!currentFilePath) {
      handleSaveAs();
      return;
    }

    try {
      const xmlContent = exportProjectToXml(projectStructure);
      await writeTextFile(currentFilePath, xmlContent);
      addLog('success', `Project saved to ${currentFilePath}`);
    } catch (error) {
      addLog('error', `Save Error: ${error}`);
    }
  }, [currentFilePath, projectStructure, addLog]);

  const handleSaveAs = useCallback(async () => {
    try {
      let filePath = await save({
        filters: [{
          name: 'PLC Project Files',
          extensions: ['xml']
        }]
      });
      if (!filePath) return;

      if (!filePath.toLowerCase().endsWith('.xml')) {
        filePath += '.xml';
      }

      const xmlContent = exportProjectToXml(projectStructure);
      await writeTextFile(filePath, xmlContent);

      setCurrentFilePath(filePath);
      addLog('success', `Project saved to ${filePath}`);
    } catch (error) {
      addLog('error', `Save As Error: ${error}`);
    }
  }, [projectStructure, addLog]);

  const handleOpen = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'PLC Project Files',
          extensions: ['xml']
        }, {
          name: 'All Files',
          extensions: ['*']
        }]
      });

      if (!selected) return;

      const filePath = Array.isArray(selected) ? selected[0] : selected;
      const content = await readTextFile(filePath);

      const newStructure = importProjectFromXml(content);
      if (newStructure) {
        // Ensure Configuration Resource Exists
        if (!newStructure.resources || newStructure.resources.length === 0) {
          newStructure.resources = [
            {
              id: 'res_config',
              name: 'Configuration',
              type: 'RESOURCE_EDITOR',
              content: { globalVars: [], tasks: [], instances: [] }
            }
          ];
          addLog('warning', 'Project had no configuration; restored default.');
        }

        setProjectStructure(newStructure);
        setCurrentFilePath(filePath);
        setActiveId(null);
        addLog('success', `Project loaded from ${filePath}`);
      } else {
        addLog('error', 'Failed to parse project file (Invalid Format).');
      }
    } catch (error) {
      console.error(error);
      addLog('error', `Open Error: ${error}`);
    }
  };

  const handleSimulate = async () => {
    addLog('info', 'Compiling Project...');

    try {
      const fullST = compileProjectToST(projectStructure);

      if (!fullST || !fullST.trim()) {
        addLog('warning', 'Project is empty. Nothing to simulate.');
        return;
      }

      // 1. Call Rust Backend
      const result = await invoke('simulate_st', { code: fullST });
      addLog('success', result);

    } catch (error) {
      addLog('error', `Simulation Failed: ${error}`);
    }
  };

  const handleSendToPlc = async () => {
    addLog('info', 'Compiling for target Hardware...');
    // Future: Invoke specific Rust command for cross-compilation
    setTimeout(() => {
      addLog('success', 'Binary sent to PLC (Simulated Action)');
    }, 1000);
  };

  // --- Global Keyboard Shortcuts ---
  useEffect(() => {
    const handleKeyDown = (e) => {
      // CMD/CTRL check
      if (e.ctrlKey || e.metaKey) {

        // Save: Ctrl + S
        if (e.key.toLowerCase() === 's') {
          e.preventDefault();
          handleSave();
        }

        // Compile: Ctrl + B
        if (e.key.toLowerCase() === 'b') {
          e.preventDefault();
          addLog('warning', `${t('messages.plcCompileStarted') || 'Derleme başlatıldı'}...`);
        }

        // Simulation: Ctrl + X
        if (e.key.toLowerCase() === 'x') {
          e.preventDefault();
          addLog('success', t('messages.plcRunMode') || 'PLC Run Mode Active');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave, addLog, t]);


  // --- Handlers ---

  const handleAddItem = (category) => {
    let base = category;
    if (category.endsWith('s')) base = category.slice(0, -1);
    const prefix = base.charAt(0).toUpperCase() + base.slice(1);

    const existingNames = projectStructure[category].map(item => item.name);
    let counter = 0;
    while (existingNames.includes(`${prefix}${counter}`)) {
      counter++;
    }
    const defaultName = `${prefix}${counter}`;

    if (category === 'dataTypes') {
      setDataTypeModal({ isOpen: true, existingNames });
      return;
    }

    setCreateModal({
      isOpen: true,
      category,
      defaultName
    });
  };

  const handleCreateDataType = (name, type) => {
    // Default Content based on structure type
    let content = {};
    if (type === 'Array') {
      content = { baseType: 'INT', dimensions: [{ id: Date.now(), min: 0, max: 10 }] };
    } else if (type === 'Enumerated') {
      content = { values: [] };
    } else if (type === 'Structure') {
      content = { members: [] };
    }

    const newItem = {
      id: `dataTypes_${Date.now()}`,
      name: name,
      type: type, // 'Array' | 'Enumerated' | 'Structure'
      content: content
    };

    setProjectStructure(prev => ({
      ...prev,
      dataTypes: [...prev.dataTypes, newItem]
    }));
    setActiveId(newItem.id);
    addLog('info', `Added Data Type ${name} (${type})`);
    setDataTypeModal({ isOpen: false, existingNames: [] });
  };

  const handleCreateConfirm = (name, type, returnType) => {
    const category = createModal.category;
    const newItem = {
      id: `${category}_${Date.now()}`,
      name: name,
      type,
      returnType: category === 'functions' ? returnType : undefined,
      content:
        type === 'LD' ? { rungs: [], variables: [] } :
          type === 'UDT' ? { members: [] } :
            type === 'GVL' ? { variables: [] } :
              { code: '', variables: [] }
    };

    setProjectStructure(prev => ({
      ...prev,
      [category]: [...prev[category], newItem]
    }));
    setActiveId(newItem.id);
    addLog('info', `Added ${name} (${type}) to ${category}`);
    // Close modal handled by createModal state update below
    setCreateModal({ isOpen: false, category: '', defaultName: '' });
  };

  const handleDeleteItem = (category, id) => {
    setProjectStructure(prev => ({
      ...prev,
      [category]: prev[category].filter(item => item.id !== id)
    }));
    if (activeId === id) setActiveId(null);
    addLog('warning', `Deleted item ${id}`);
  };

  const handleRenameItem = (category, id, newName) => {
    setProjectStructure(prev => ({
      ...prev,
      [category]: prev[category].map(item =>
        item.id === id ? { ...item, name: newName } : item
      )
    }));
    addLog('info', `Renamed item to ${newName}`);
  };

  const handleSelectItem = (category, id) => {
    setActiveId(id);
  };

  const getActiveItem = () => {
    for (const key of Object.keys(projectStructure)) {
      const item = projectStructure[key].find(i => i.id === activeId);
      if (item) return { ...item, category: key };
    }
    return null;
  };

  const activeItem = getActiveItem();

  const handleContentChange = (newContent) => {
    if (!activeItem) return;
    setProjectStructure(prev => ({
      ...prev,
      [activeItem.category]: prev[activeItem.category].map(item =>
        item.id === activeId ? { ...item, content: newContent } : item
      )
    }));
  };

  // --- Resize Effects ---
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizing) return;

      if (isResizing === 'left') {
        const newWidth = Math.max(150, Math.min(600, e.clientX));
        setLayout(prev => ({ ...prev, leftWidth: newWidth }));
      } else if (isResizing === 'right') {
        const newWidth = Math.max(150, Math.min(600, window.innerWidth - e.clientX));
        setLayout(prev => ({ ...prev, rightWidth: newWidth }));
      } else if (isResizing === 'console') {
        const newHeight = Math.max(50, Math.min(600, window.innerHeight - e.clientY));
        setLayout(prev => ({ ...prev, consoleHeight: newHeight }));
      }
    };

    const handleMouseUp = () => {
      if (isResizing) setIsResizing(null);
    };

    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = isResizing === 'console' ? 'row-resize' : 'col-resize';
      document.body.style.userSelect = 'none'; // text selection fail preventing
    } else {
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };
  }, [isResizing]);

  const startResizing = (direction) => setIsResizing(direction);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', background: '#1e1e1e', overflow: 'hidden' }}>

      {/* 1. HEADER (Fixed) */}
      <div className="header" style={{ height: '50px', flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 15px', background: '#2d2d2d', borderBottom: '1px solid #3e3e42' }}>
        <button className="toolbar-btn" onClick={handleOpen}>📂 {t('common.open') || 'Open'}</button>
        <button className="toolbar-btn" onClick={handleSave}>💾 {t('common.save')}</button>
        <button className="toolbar-btn" onClick={handleSaveAs}>💾 {t('common.saveAs') || 'Save As'}</button>
        <div style={{ width: 20 }}></div>
        <div style={{ width: 20 }}></div>
        <button className="toolbar-btn" onClick={handleSimulate}>🚀 {t('actions.simulate')}</button>
        <button className="toolbar-btn" onClick={handleSendToPlc}>⚡ {t('actions.sendToPlc')}</button>
        <button className="toolbar-btn run" onClick={() => addLog('success', t('messages.plcRunMode') || 'Running')}>▶ {t('actions.start')}</button>
        <button className="toolbar-btn stop" onClick={() => addLog('error', t('messages.plcStopped') || 'Stopped')}>⏹ {t('actions.stop')}</button>
      </div>

      {/* 2. BODY (Row) */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* LEFT SIDEBAR (Project) */}
        <div style={{ width: layout.leftWidth, display: 'flex', flexDirection: 'column', borderRight: '1px solid #333', background: '#252526' }}>
          <ProjectSidebar
            projectStructure={projectStructure}
            activeId={activeId}
            onSelectItem={handleSelectItem}
            onAddItem={handleAddItem}
            onDeleteItem={handleDeleteItem}
            onRenameItem={handleRenameItem}
            onSettingsClick={() => setActiveId('SETTINGS')}
            onShortcutsClick={() => setShortcutsModalOpen(true)}
          />
        </div>

        {/* RESIZER (LEFT) */}
        <div
          onMouseDown={() => startResizing('left')}
          style={{ width: 5, cursor: 'col-resize', background: isResizing === 'left' ? '#007acc' : '#1e1e1e', zIndex: 10, flexShrink: 0, borderRight: '1px solid #333' }}
        />

        {/* CENTER COLUMN (Editor + Console) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: '#1e1e1e' }}>

          {/* EDITOR */}
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {activeId === 'SETTINGS' ? (
              <ErrorBoundary>
                <SettingsPage
                  theme={theme}
                  setTheme={setTheme}
                  editorSettings={editorSettings}
                  setEditorSettings={setEditorSettings}
                />
              </ErrorBoundary>
            ) : activeItem ? (
              <ErrorBoundary>
                <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                  <EditorPane
                    key={activeItem.id}
                    fileType={activeItem.type}
                    initialContent={activeItem.content}
                    onContentChange={handleContentChange}
                    allowedClasses={
                      activeItem.category === 'programs'
                        ? ['Local', 'Temp']
                        : ['Input', 'Output', 'InOut', 'Local', 'Temp']
                    }
                    context={activeItem.category}
                    availableBlocks={[...projectStructure.functionBlocks, ...projectStructure.functions]}
                    availablePrograms={projectStructure.programs.map(p => p.name)}
                    availableTasks={projectStructure.resources.find(r => r.type === 'RESOURCE_EDITOR')?.content.tasks?.map(t => t.name) || []}
                    globalVars={projectStructure.resources.find(r => r.type === 'RESOURCE_EDITOR')?.content.globalVars || []}
                    projectStructure={projectStructure}
                    currentId={activeItem.id}
                    libraryData={libraryData} // Pass Library Data
                  />
                </div>
              </ErrorBoundary>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666' }}>
                Select an item from the Project Tree to edit.
              </div>
            )}
          </div>

          {/* RESIZER (CONSOLE) */}
          <div
            onMouseDown={() => startResizing('console')}
            style={{ height: 5, cursor: 'row-resize', background: isResizing === 'console' ? '#007acc' : '#2d2d2d', zIndex: 10, flexShrink: 0, borderTop: '1px solid #333', borderBottom: '1px solid #333' }}
          />

          {/* CONSOLE */}
          <div style={{ height: layout.consoleHeight, background: '#1e1e1e', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '5px 10px', background: '#2d2d2d', borderBottom: '1px solid #333', fontSize: '11px', fontWeight: 'bold', color: '#ccc' }}>
              OUTPUT
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '5px', fontFamily: 'Consolas, monospace', fontSize: '12px' }}>
              {logs.map((log, index) => (
                <div key={index} className={`log-line log-${log.type}`}>
                  {log.msg}
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* RIGHT SIDEBAR (Only if LD) */}
        {(activeItem?.type === 'LD' || activeItem?.type === 'ST') && (
          <>
            {/* RESIZER (RIGHT) */}
            <div
              onMouseDown={() => startResizing('right')}
              style={{ width: 5, cursor: 'col-resize', background: isResizing === 'right' ? '#007acc' : '#1e1e1e', zIndex: 10, flexShrink: 0, borderLeft: '1px solid #333' }}
            />

            <div style={{ width: layout.rightWidth, display: 'flex', flexDirection: 'column', background: '#252526', borderLeft: '1px solid #333' }}>
              <h4 style={{ padding: '10px 15px', margin: 0, background: '#2d2d2d', fontSize: '11px', textTransform: 'uppercase', color: '#ccc' }}>Kütüphane</h4>
              <div style={{ flex: 1, overflow: 'auto' }}>
                <Toolbox
                  libraryData={libraryData} // Pass Library Data
                  activeFileType={activeItem?.type}
                  userDefinedBlocks={
                    activeItem.category === 'programs'
                      ? [...projectStructure.functionBlocks, ...projectStructure.functions]
                      : []
                  }
                />
              </div>
            </div>
          </>
        )}

      </div>

      <CreateItemModal
        isOpen={createModal.isOpen}
        onClose={() => setCreateModal({ ...createModal, isOpen: false })}
        onConfirm={handleCreateConfirm}
        category={createModal.category}
        defaultName={createModal.defaultName}
      />

      <DataTypeCreationModal
        isOpen={dataTypeModal.isOpen}
        onClose={() => setDataTypeModal({ isOpen: false, existingNames: [] })}
        onSave={handleCreateDataType}
        existingNames={dataTypeModal.existingNames}
      />

      <ShortcutsModal
        isOpen={shortcutsModalOpen}
        onClose={() => setShortcutsModalOpen(false)}
      />

    </div>
  );
}

export default App;
