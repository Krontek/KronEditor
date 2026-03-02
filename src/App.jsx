import React, { useState, useEffect, useCallback } from 'react';
import EditorPane from './components/EditorPane';
import Toolbox from './components/Toolbox';
import ProjectSidebar from './components/ProjectSidebar';
import CreateItemModal from './components/CreateItemModal';
import DataTypeCreationModal from './components/DataTypeCreationModal';
import ErrorBoundary from './components/ErrorBoundary';
import SettingsPage from './components/SettingsPage';
import ShortcutsModal from './components/ShortcutsModal';
import StartScreen from './components/StartScreen';
import SelectTargetModal from './components/SelectTargetModal';
import ArrayTypeEditor from './components/ArrayTypeEditor';
import StructureTypeEditor from './components/StructureTypeEditor';
import EnumTypeEditor from './components/EnumTypeEditor';
import { useTranslation } from 'react-i18next';
import { exportProjectToXml, importProjectFromXml } from './services/XmlService';
import { libraryService } from './services/LibraryService'; // Import Service
import { open, save, ask } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { compileProjectToST } from './services/CompilerService';
import { transpileToC } from './services/CTranspilerService';
import { mkdir, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import PlcIcon from './assets/icons/plc-icon.png';
import './App.css';

function App() {
  const { t } = useTranslation();

  // Project Open State
  const [isProjectOpen, setIsProjectOpen] = useState(false);

  // Library State
  const [libraryData, setLibraryData] = useState([]);

  // Load Library on Mount
  useEffect(() => {
    libraryService.loadLibrary().then(data => {
      console.log("Library Loaded:", data);
      setLibraryData(data);
    });
  }, []);

  const defaultProjectStructure = {
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
  };

  // Global Project State
  const [projectStructure, setProjectStructure] = useState(defaultProjectStructure);

  const [activeId, setActiveId] = useState(null);
  const [createModal, setCreateModal] = useState({
    isOpen: false,
    category: '',
    defaultName: '',
    isEdit: false,
    editId: null,
    initialData: {}
  });

  const [dataTypeModal, setDataTypeModal] = useState({
    isOpen: false,
    existingNames: []
  });

  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);

  const [currentFilePath, setCurrentFilePath] = useState(null);

  // Dropdown States
  const [isProjectDropdownOpen, setIsProjectDropdownOpen] = useState(false);
  const [isPlcDropdownOpen, setIsPlcDropdownOpen] = useState(false);

  // PLC Targets State
  const [isTargetModalOpen, setIsTargetModalOpen] = useState(false);
  const [plcTarget, setPlcTarget] = useState('imx8m');

  // App Settings State - Persisted to LocalStorage
  const [theme, setTheme] = useState(() => localStorage.getItem('appTheme') || 'dark');
  const [editorSettings, setEditorSettings] = useState(() => {
    const saved = localStorage.getItem('editorSettings');
    return saved ? JSON.parse(saved) : { fontSize: 14, minimap: true, wordWrap: false };
  });

  // PLC & Simulation Execution State
  const [isPlcConnected, setIsPlcConnected] = useState(false); // Mock for future
  const [isSimulationMode, setIsSimulationMode] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

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

  // Console Scroll Ref
  const consoleEndRef = React.useRef(null);

  // Sahte Konsol Logları
  const [logs, setLogs] = useState([
    { type: 'info', msg: 'System initialized.' },
    { type: 'info', msg: 'Ready to map PLC project...' }
  ]);

  // Auto-scroll Console
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const addLog = useCallback((type, msg) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { type, msg: `[${time}] ${msg} ` }]);
  }, []);

  // --- Live Variable Listener ---
  const [liveVariables, setLiveVariables] = useState({});

  useEffect(() => {
    let unlisten = null;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('simulation-output', (event) => {
        try {
          const parsed = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
          if (parsed.vars) {
            // Normal variable update from LLDB monitor
            setLiveVariables(parsed.vars);
          } else if (parsed.status === 'exited' || parsed.status === 'crashed') {
            // Simulation process ended on its own
            setIsRunning(false);
            addLog('warning', `Simulation ${parsed.status}.`);
          } else if (parsed.error) {
            addLog('error', `Simulation: ${parsed.error}`);
          }
          // {"status": "started", "pid": N} is informational, no action needed
        } catch (e) {
          console.error("Failed to parse simulation output:", e, "Raw Payload:", event.payload);
        }
      }).then(f => unlisten = f);
    });
    return () => { if (unlisten) unlisten(); };
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
      addLog('success', `Project saved to ${currentFilePath} `);
    } catch (error) {
      addLog('error', `Save Error: ${error} `);
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
      addLog('success', `Project saved to ${filePath} `);
    } catch (error) {
      addLog('error', `Save As Error: ${error} `);
    }
  }, [projectStructure, addLog]);

  const handleNewProject = useCallback(() => {
    // Reset to default empty project structure
    setProjectStructure(defaultProjectStructure);
    setCurrentFilePath(null);
    setActiveId(null);
    setLogs([
      { type: 'info', msg: 'Started new project.' }
    ]);
    setIsProjectOpen(true);
  }, [defaultProjectStructure]);

  const handleCloseProject = useCallback(async () => {
    const confirmation = await ask('Are you sure you want to close the current project? Any unsaved changes will be lost.', {
      title: 'Close Project',
      type: 'warning'
    });

    if (confirmation) {
      setIsProjectOpen(false);
      setProjectStructure(defaultProjectStructure);
      setCurrentFilePath(null);
      setActiveId(null);
    }
  }, [defaultProjectStructure]);

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
        setIsProjectOpen(true);
        addLog('success', `Project loaded from ${filePath} `);
      } else {
        addLog('error', 'Failed to parse project file (Invalid Format).');
      }
    } catch (error) {
      console.error(error);
      addLog('error', `Open Error: ${error} `);
    }
  };

  const handleToggleSimulation = async () => {
    if (isPlcConnected) {
      addLog('error', 'Cannot enable Simulation Mode while PLC is connected.');
      return;
    }

    if (isRunning) {
      addLog('warning', 'Please stop execution before toggling simulation mode.');
      return;
    }

    const nextMode = !isSimulationMode;

    if (nextMode) {
      addLog('info', 'Compiling Project for Simulation (C Transpilation)...');
      try {
        const standardHeaders = await invoke('get_standard_headers').catch(() => []);
        const cCode = transpileToC(projectStructure, standardHeaders);
        const outPath = await invoke('write_plc_files', {
          header: cCode.header,
          source: cCode.source,
          variableTable: JSON.stringify(cCode.variableTable, null, 2)
        });
        addLog('success', `Transpiled C header and source successfully saved to ${outPath}`);

        addLog('info', 'Compiling simulation executable with gcc (debug symbols)...');
        const exePath = await invoke('compile_simulation');
        addLog('success', `Simulation executable compiled: ${exePath}`);

        setIsSimulationMode(true);

        // Load Default Initial Values
        let initialLiveVars = {};
        if (cCode.variableTable && cCode.variableTable.programs) {
          Object.values(cCode.variableTable.programs).forEach(prog => {
            if (prog.variables) {
              Object.values(prog.variables).forEach(v => {
                initialLiveVars[v.c_symbol] = v.initialValue;
              });
            }
          });
        }
        if (cCode.variableTable && cCode.variableTable.globalVars) {
          Object.entries(cCode.variableTable.globalVars).forEach(([name, v]) => {
            initialLiveVars[name] = v.initialValue;
          });
        }

        setLiveVariables(initialLiveVars);
        addLog('info', 'Simulation Mode Enabled. Variables populated with default values.');
      } catch (error) {
        addLog('error', `Simulation Compilation Failed: ${error}`);
      }
    } else {
      setIsSimulationMode(false);
      addLog('info', 'Simulation Mode Disabled.');
      setLiveVariables({});
    }
  };

  const handleStartExecution = async () => {
    if (!isSimulationMode && !isPlcConnected) {
      addLog('warning', 'Cannot start. Please enable Simulation Mode or connect to a PLC.');
      return;
    }

    if (isSimulationMode) {
      setIsRunning(true);
      addLog('success', t('messages.plcRunMode') || 'Running Simulation Execution...');
      try {
        await invoke('run_simulation');
      } catch (err) {
        addLog('error', `Failed to start simulation: ${err}`);
        setIsRunning(false);
      }
    } else if (isPlcConnected) {
      setIsRunning(true);
      addLog('success', 'PLC Execution Started.');
    }
  };

  const handleStopExecution = async () => {
    if (isRunning) {
      setIsRunning(false);

      if (isSimulationMode) {
        try {
          await invoke('stop_simulation');
        } catch (err) {
          addLog('error', `Failed to stop simulation: ${err}`);
        }
      }

      addLog('error', t('messages.plcStopped') || 'Execution Stopped.');
    }
  };

  const handleForceWrite = useCallback(async (key, value) => {
    if (!isRunning) return;
    try {
      await invoke('write_variable', { name: key, value: String(value) });
    } catch (err) {
      addLog('error', `Force write failed for '${key}': ${err}`);
    }
  }, [isRunning, addLog]);

  const handleBuild = () => {
    addLog('info', `Build started for target: ${plcTarget}...`);
    try {
      const stCode = compileProjectToST(projectStructure);
      addLog('success', 'Project built successfully.');
    } catch (err) {
      addLog('error', `Build failed: ${err.message}`);
    }
  };

  const handleSendToPlc = async () => {
    addLog('info', `Send to PLC triggered for target: ${plcTarget} `);
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
          handleBuild();
        }

        // Run/Start: Ctrl + X
        if (e.key.toLowerCase() === 'x') {
          e.preventDefault();
          handleStartExecution();
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
    while (existingNames.includes(`${prefix}${counter} `)) {
      counter++;
    }
    const defaultName = `${prefix}${counter} `;

    if (category === 'dataTypes') {
      setDataTypeModal({ isOpen: true, existingNames });
      return;
    }

    setCreateModal({
      isOpen: true,
      category,
      defaultName,
      isEdit: false,
      editId: null,
      initialData: {}
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

  const handleCreateConfirm = (name, type, returnType, cycleTime) => {
    const category = createModal.category;

    // Check if name already exists in this category
    const isDuplicate = projectStructure[category].some(item =>
      item.name.toLowerCase() === name.toLowerCase() &&
      (!createModal.isEdit || item.id !== createModal.editId)
    );

    if (isDuplicate) {
      alert(t('messages.duplicateName') || 'An item with this name already exists.');
      return false;
    }

    if (createModal.isEdit) {
      setProjectStructure(prev => {
        const nextStruct = { ...prev };
        let oldProgramName = null;

        nextStruct[category] = nextStruct[category].map(item => {
          if (item.id === createModal.editId) {
            oldProgramName = item.name;
            return {
              ...item,
              name,
              returnType: category === 'functions' ? returnType : item.returnType,
              cycleTime: category === 'programs' ? (cycleTime || '1ms') : item.cycleTime
            };
          }
          return item;
        });

        if (category === 'programs' && oldProgramName && oldProgramName !== name) {
          // Update the associated task interval and instance program name in res_config
          nextStruct.resources = nextStruct.resources.map(r => {
            if (r.id === 'res_config') {
              const tasks = [...(r.content.tasks || [])];
              const instances = [...(r.content.instances || [])];

              const taskIndex = tasks.findIndex(t => t.name === `task_${oldProgramName}`);
              if (taskIndex !== -1) {
                const formattedInterval = cycleTime.startsWith('T#') ? cycleTime : `T#${cycleTime}`;
                tasks[taskIndex] = { ...tasks[taskIndex], name: `task_${name}`, interval: formattedInterval };
              }

              const instIndex = instances.findIndex(inst => inst.program === oldProgramName);
              if (instIndex !== -1) {
                instances[instIndex] = { ...instances[instIndex], program: name, task: `task_${name}` };
              }

              return { ...r, content: { ...r.content, tasks, instances } };
            }
            return r;
          });
        } else if (category === 'programs' && oldProgramName === name) {
          // Just updated cycle time
          nextStruct.resources = nextStruct.resources.map(r => {
            if (r.id === 'res_config') {
              const tasks = [...(r.content.tasks || [])];
              const taskIndex = tasks.findIndex(t => t.name === `task_${name}`);
              if (taskIndex !== -1) {
                const formattedInterval = cycleTime.startsWith('T#') ? cycleTime : `T#${cycleTime}`;
                tasks[taskIndex] = { ...tasks[taskIndex], interval: formattedInterval };
              }
              return { ...r, content: { ...r.content, tasks } };
            }
            return r;
          });
        }
        return nextStruct;
      });
      addLog('info', `Updated properties for ${name}`);
      setCreateModal({ isOpen: false, category: '', defaultName: '', isEdit: false, editId: null, initialData: {} });
      return true;
    }

    const newItem = {
      id: `${category}_${Date.now()}`,
      name: name,
      type,
      returnType: category === 'functions' ? returnType : undefined,
      cycleTime: category === 'programs' ? (cycleTime || '1ms') : undefined,
      content:
        type === 'LD' ? { rungs: [], variables: [] } :
          type === 'UDT' ? { members: [] } :
            type === 'GVL' ? { variables: [] } :
              { code: '', variables: [] }
    };

    setProjectStructure(prev => {
      const nextStruct = {
        ...prev,
        [category]: [...prev[category], newItem]
      };

      if (category === 'programs' && cycleTime) {
        // Automatically create a task and instance for the program
        const configResource = nextStruct.resources.find(r => r.id === 'res_config');
        if (configResource) {
          const tasks = configResource.content.tasks || [];
          const instances = configResource.content.instances || [];

          const taskName = `task_${name}`;
          let newTasks = [...tasks];
          newTasks.push({
            id: `task_${Date.now()}`,
            name: taskName,
            triggering: 'Cyclic',
            interval: cycleTime.startsWith('T#') ? cycleTime : `T#${cycleTime}`,
            priority: 1
          });

          let i = 0;
          const instNames = instances.map(inst => inst.name);
          while (instNames.includes(`instance${i}`)) i++;

          const newInstances = [...instances, {
            id: `inst_${Date.now()}_${Math.random()}`,
            name: `instance${i}`,
            program: name,
            task: taskName
          }];

          nextStruct.resources = nextStruct.resources.map(r =>
            r.id === 'res_config' ? {
              ...r,
              content: {
                ...r.content,
                tasks: newTasks,
                instances: newInstances
              }
            } : r
          );
        }
      }

      return nextStruct;
    });

    setActiveId(newItem.id);
    addLog('info', `Added ${name} (${type}) to ${category}`);
    // Close modal handled by createModal state update below
    setCreateModal({ isOpen: false, category: '', defaultName: '', isEdit: false, editId: null, initialData: {} });
    return true;
  };

  const handleDeleteItem = (category, id) => {
    setProjectStructure(prev => ({
      ...prev,
      [category]: prev[category].filter(item => item.id !== id)
    }));
    if (activeId === id) setActiveId(null);
    addLog('warning', `Deleted item ${id}`);
  };

  const handleEditItemDetails = (category, id) => {
    const item = projectStructure[category].find(i => i.id === id);
    if (!item) return;

    if (category === 'dataTypes') {
      const newName = window.prompt(t('modals.enterName') || 'Enter Name:', item.name);
      if (newName && newName !== item.name) {
        // Check for duplicates
        if (projectStructure[category].some(it => it.name.toLowerCase() === newName.toLowerCase() && it.id !== id)) {
          alert(t('messages.duplicateName') || 'An item with this name already exists.');
          return;
        }

        setProjectStructure(prev => ({
          ...prev,
          [category]: prev[category].map(it =>
            it.id === id ? { ...it, name: newName } : it
          )
        }));
        addLog('info', `Renamed item to ${newName}`);
      }
      return;
    }

    setCreateModal({
      isOpen: true,
      category,
      defaultName: item.name,
      isEdit: true,
      editId: id,
      initialData: {
        name: item.name,
        language: item.type,
        returnType: item.returnType,
        cycleTime: item.cycleTime
      }
    });
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

  const getAvailableDataTypes = () => {
    if (!activeItem || activeItem.category !== 'dataTypes') return projectStructure.dataTypes.map(d => d.name);
    const idx = projectStructure.dataTypes.findIndex(d => d.id === activeItem.id);
    return idx >= 0 ? projectStructure.dataTypes.slice(0, idx).map(d => d.name) : projectStructure.dataTypes.map(d => d.name);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', background: '#1e1e1e', overflow: 'hidden' }}>

      {/* CUSTOM TITLEBAR */}
      <div data-tauri-drag-region className="custom-titlebar">
        <div className="titlebar-title">
          <img src={PlcIcon} alt="Logo" style={{ height: '18px', marginRight: '8px', pointerEvents: 'none' }} />
          <span>KronEditor</span>
        </div>
        <div className="titlebar-controls">
          <div className="titlebar-button" onClick={() => getCurrentWindow().minimize()}>_</div>
          <div className="titlebar-button" onClick={() => getCurrentWindow().toggleMaximize()}>□</div>
          <div className="titlebar-button titlebar-close" onClick={() => getCurrentWindow().close()}>✕</div>
        </div>
      </div>

      {/* 1. HEADER (Fixed) */}
      <div className="header" style={{ height: '50px', flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 15px', background: '#2d2d2d', borderBottom: '1px solid #3e3e42' }}>
        {isProjectOpen && (
          <>
            {/* Project Dropdown */}
            <div className="dropdown" style={{ marginRight: '10px' }}>
              <button
                className="toolbar-btn"
                onClick={() => setIsProjectDropdownOpen(!isProjectDropdownOpen)}
                onBlur={() => setTimeout(() => setIsProjectDropdownOpen(false), 200)}
              >
                📁 {t('common.project') || 'Project'} ▼
              </button>
              {isProjectDropdownOpen && (
                <div className="dropdown-content">
                  <div className="dropdown-item" onClick={handleOpen}>
                    📂 {t('common.open') || 'Open'}
                  </div>
                  <div className="dropdown-item" onClick={handleSave}>
                    💾 {t('common.save')}
                  </div>
                  <div className="dropdown-item" onClick={handleSaveAs}>
                    💾 {t('common.saveAs') || 'Save As'}
                  </div>
                  <div style={{ height: '1px', background: '#3e3e42', margin: '4px 0' }}></div>
                  <div className="dropdown-item" onClick={handleCloseProject} style={{ color: '#ff9800' }}>
                    ✖ {t('actions.closeProject') || 'Close Project'}
                  </div>
                </div>
              )}
            </div>

            {/* PLC Dropdown */}
            <div className="dropdown" style={{ marginRight: '10px' }}>
              <button
                className="toolbar-btn"
                onClick={() => setIsPlcDropdownOpen(!isPlcDropdownOpen)}
                onBlur={() => setTimeout(() => setIsPlcDropdownOpen(false), 200)}
              >
                ⚙️ {t('common.plc') || 'PLC'} ▼
              </button>
              {isPlcDropdownOpen && (
                <div className="dropdown-content">
                  <div className="dropdown-item" onClick={() => setIsTargetModalOpen(true)}>
                    🎯 {t('actions.selectTarget') || 'Select Target'}
                  </div>
                  <div className="dropdown-item" onClick={handleBuild}>
                    🔨 {t('actions.build') || 'Build'}
                  </div>
                  <div className="dropdown-item" onClick={handleSendToPlc}>
                    ⚡ {t('actions.sendToPlc') || 'Send to PLC'}
                  </div>
                </div>
              )}
            </div>

            <div style={{ width: 10 }}></div>

            {/* Simulation Toggle */}
            <button
              className={`toolbar-btn ${isSimulationMode ? 'simulation-active' : ''}`}
              onClick={handleToggleSimulation}
              disabled={isPlcConnected || isRunning}
              style={{
                background: isSimulationMode ? '#007acc' : 'transparent',
                border: isSimulationMode ? '1px solid #0098ff' : '1px solid transparent',
              }}
            >
              🚀 {isSimulationMode ? 'Simulation ON' : 'Simulation OFF'}
            </button>

            {/* Execution Controls */}
            <button
              className="toolbar-btn run"
              onClick={handleStartExecution}
              disabled={isRunning || (!isSimulationMode && !isPlcConnected)}
              style={{ opacity: (isRunning || (!isSimulationMode && !isPlcConnected)) ? 0.5 : 1 }}
            >
              ▶ {t('actions.start')}
            </button>

            <button
              className="toolbar-btn stop"
              onClick={handleStopExecution}
              disabled={!isRunning}
              style={{ opacity: !isRunning ? 0.5 : 1 }}
            >
              ⏹ {t('actions.stop')}
            </button>
          </>
        )}
      </div>

      {/* 2. BODY (Row) */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {!isProjectOpen ? (
          <StartScreen
            onNewProject={handleNewProject}
            onOpenProject={handleOpen}
          />
        ) : (
          <>
            {/* LEFT SIDEBAR (Project) */}
            <div style={{ width: layout.leftWidth, display: 'flex', flexDirection: 'column', borderRight: '1px solid #333', background: '#252526' }}>
              <ProjectSidebar
                projectStructure={projectStructure}
                activeId={activeId}
                onSelectItem={handleSelectItem}
                onAddItem={handleAddItem}
                onDeleteItem={handleDeleteItem}
                onEditItem={handleEditItemDetails}
                onSettingsClick={() => setActiveId('SETTINGS')}
                onShortcutsClick={() => setShortcutsModalOpen(true)}
                isRunning={isRunning || isSimulationMode}
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
                      {activeItem.category === 'dataTypes' ? (
                        <div style={{
                          height: '100%',
                          pointerEvents: (isRunning || isSimulationMode) ? 'none' : 'auto',
                          opacity: (isRunning || isSimulationMode) ? 0.55 : 1
                        }}>
                          {activeItem.type === 'Array' && <ArrayTypeEditor content={activeItem.content} onContentChange={handleContentChange} projectStructure={projectStructure} currentId={activeItem.id} derivedTypes={getAvailableDataTypes()} />}
                          {activeItem.type === 'Structure' && <StructureTypeEditor content={activeItem.content} onContentChange={handleContentChange} projectStructure={projectStructure} currentId={activeItem.id} derivedTypes={getAvailableDataTypes()} />}
                          {activeItem.type === 'Enumerated' && <EnumTypeEditor content={activeItem.content} onContentChange={handleContentChange} />}
                        </div>
                      ) : (
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
                          libraryData={libraryData}
                          liveVariables={isSimulationMode ? (liveVariables || {}) : null}
                          parentName={activeItem.name}
                          isRunning={isRunning}
                          isSimulationMode={isSimulationMode}
                          onForceWrite={isRunning ? handleForceWrite : null}
                        />
                      )}
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
                  <div ref={consoleEndRef} />
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
          </>
        )}
      </div>

      <CreateItemModal
        isOpen={createModal.isOpen}
        onClose={() => setCreateModal({ ...createModal, isOpen: false })}
        onConfirm={handleCreateConfirm}
        category={createModal.category}
        defaultName={createModal.defaultName}
        isEdit={createModal.isEdit}
        initialData={createModal.initialData}
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

      <SelectTargetModal
        isOpen={isTargetModalOpen}
        onClose={() => setIsTargetModalOpen(false)}
        currentTarget={plcTarget}
        onSelect={(target) => {
          setPlcTarget(target);
          addLog('info', `PLC target changed to: ${target} `);
        }}
      />

    </div>
  );
}

export default App;
