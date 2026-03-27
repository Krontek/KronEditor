import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { lazy, Suspense } from 'react';
const EtherCATEditor = lazy(() => import('./components/EtherCATEditor'));
import EditorPane from './components/EditorPane';
import Toolbox from './components/Toolbox';
import ProjectSidebar from './components/ProjectSidebar';
import CreateItemModal from './components/CreateItemModal';
import DataTypeCreationModal from './components/DataTypeCreationModal';
import ErrorBoundary from './components/ErrorBoundary';
import SettingsPage from './components/SettingsPage';
import ShortcutsModal from './components/ShortcutsModal';
import StartScreen from './components/StartScreen';
import BoardSelectionModal from './components/BoardSelectionModal';
import BoardConfigPage from './components/BoardConfigPage';
import TaskManager from './components/TaskManager';
import OutputPanel from './components/OutputPanel';
import EditorTabs from './components/EditorTabs';
import SaveConfirmDialog from './components/SaveConfirmDialog';
import VisualizationEditor from './components/visualization/VisualizationEditor';
import { getBoardById } from './utils/boardDefinitions';
import { getBoardFamilyDefine } from './utils/devicePortMapping';
import { buildHardwarePortVars } from './utils/hwPortVars';
import ArrayTypeEditor from './components/ArrayTypeEditor';
import StructureTypeEditor from './components/StructureTypeEditor';
import EnumTypeEditor from './components/EnumTypeEditor';
import { useTranslation } from 'react-i18next';
import { exportProjectToXml, importProjectFromXml } from './services/XmlService';
import { libraryService } from './services/LibraryService'; // Import Service
import { loadAllEsiDevices, saveEsiFile } from './services/EsiLibraryService';
import { open, save, ask } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { transpileToC } from './services/CTranspilerService';
import { PLCClient } from './services/PLCClient';
import PlcIcon from './assets/icons/plc-icon.png';
import EtherCATIconSrc from './assets/icons/ethercat.png';
const EtherCATTabIcon = <img src={EtherCATIconSrc} height="13" style={{ objectFit: 'contain', verticalAlign: 'middle' }} alt="EtherCAT" />;
import './App.css';

function App() {
  const { t } = useTranslation();

  // Project Open State
  const [isProjectOpen, setIsProjectOpen] = useState(false);

  const [libraryData, setLibraryData] = useState([]);
  const [parsedBlocks, setParsedBlocks] = useState([]);

  // Load Library on Mount
  // Load ESI device library from ~/kroneditor/esi/ on startup
  useEffect(() => {
    loadAllEsiDevices().then(setEsiLibrary).catch(() => {});
  }, []);

  useEffect(() => {
    libraryService.loadLibrary().then(data => {
      console.log("Library Loaded:", data);
      setLibraryData(data);

      // Extract library blocks for the Variable Manager drop-down
      const blocks = [];
      data.forEach(cat => {
        const catName = cat.title || cat.category || 'Standard Libraries';
        (cat.blocks || []).forEach(b => blocks.push({ name: b.blockType, category: catName }));
        (cat.subcategories || []).forEach(sub => {
          (sub.items || []).forEach(item => blocks.push({ name: item.blockType, category: catName }));
          (sub.fromLibrary || []).forEach(item => blocks.push({ name: item, category: catName }));
        });
      });
      // Deduplicate blocks
      const uniqueBlocksMap = new Map();
      blocks.forEach(b => {
        if (!uniqueBlocksMap.has(b.name)) {
          uniqueBlocksMap.set(b.name, b);
        }
      });
      setParsedBlocks(Array.from(uniqueBlocksMap.values()));
    });
  }, []);

  const defaultProjectStructure = {
    dataTypes: [],
    functionBlocks: [],
    functions: [],
    programs: [],
    taskConfig: { tasks: [] },
    resources: [
      {
        id: 'res_config',
        name: 'Configuration',
        type: 'RESOURCE_EDITOR',
        content: { globalVars: [], tasks: [], instances: [] }
      }
    ]
  };

  // ESI Device Library (loaded from ~/kroneditor/esi/ on startup)
  const [esiLibrary, setEsiLibrary] = useState([]); // flat EsiDevice[]

  // Global Project State
  const [projectStructure, setProjectStructure] = useState(defaultProjectStructure);
  const [buses, setBuses] = useState([]);
  const [busConfigs, setBusConfigs] = useState({}); // busId → config object

  const [activeId, setActiveId] = useState(null);
  const [createModal, setCreateModal] = useState({
    isOpen: false,
    category: '',
    defaultName: '',
    isEdit: false,
    editId: null,
    initialData: {},
    insertIndex: null
  });

  const [dataTypeModal, setDataTypeModal] = useState({
    isOpen: false,
    existingNames: []
  });

  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);

  const [currentFilePath, setCurrentFilePath] = useState(null);

  // Dropdown States
  const [isProjectDropdownOpen, setIsProjectDropdownOpen] = useState(false);

  // Board State
  const [isBoardModalOpen, setIsBoardModalOpen] = useState(false);
  const [selectedBoard, setSelectedBoard] = useState(null);
  const [pendingNewProject, setPendingNewProject] = useState(false);

  // App Settings State - Persisted to LocalStorage
  const [theme, setTheme] = useState(() => localStorage.getItem('appTheme') || 'auto');
  const [editorSettings, setEditorSettings] = useState(() => {
    const saved = localStorage.getItem('editorSettings');
    return saved ? JSON.parse(saved) : { fontSize: 14, minimap: true, wordWrap: false };
  });

  // PLC & Simulation Execution State
  const [isPlcConnected, setIsPlcConnected] = useState(false);
  const [connectionEnabled, setConnectionEnabled] = useState(true);
  const [isSimulationMode, setIsSimulationMode] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  // HMI Layout state — persisted in project XML file
  const [hmiLayout, setHmiLayout] = useState({ pages: [] });
  const [hmiPort] = useState(() => Number(localStorage.getItem('hmiPort') || '7800'));

  // Remote deployment state
  const [plcAddress, setPlcAddress] = useState(() => localStorage.getItem('plcAddress') || '');
  const [sshUser, setSshUser] = useState(() => localStorage.getItem('sshUser') || 'pi');
  const [sshPort, setSshPort] = useState(() => localStorage.getItem('sshPort') || '22');
  const [isDeployed, setIsDeployed] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const isDirtyRef = React.useRef(false);

  // Save-confirm dialog state
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);
  const saveConfirmResolveRef = React.useRef(null); // resolves with 'save' | 'discard' | 'cancel'

  const showSaveConfirm = () => new Promise((resolve) => {
    saveConfirmResolveRef.current = resolve;
    setSaveConfirmOpen(true);
  });
  const handleSaveConfirmSave    = () => { setSaveConfirmOpen(false); saveConfirmResolveRef.current?.('save'); };
  const handleSaveConfirmDiscard = () => { setSaveConfirmOpen(false); saveConfirmResolveRef.current?.('discard'); };
  const handleSaveConfirmCancel  = () => { setSaveConfirmOpen(false); saveConfirmResolveRef.current?.('cancel'); };
  const plcClientRef = React.useRef(null);   // PLCClient instance
  const stopStreamRef = React.useRef(null);  // cancel fn returned by streamVars()
  const remoteVarKeysRef = React.useRef([]);

  // Persist settings
  useEffect(() => {
    localStorage.setItem('appTheme', theme);
    
    const applyTheme = (isDark) => {
      document.body.classList.remove('light', 'dark');
      document.body.classList.add(isDark ? 'dark' : 'light');
    };

    if (theme === 'auto') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      applyTheme(mediaQuery.matches);
      
      const handleChange = (e) => applyTheme(e.matches);
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    } else {
      applyTheme(theme === 'dark');
    }
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('editorSettings', JSON.stringify(editorSettings));
  }, [editorSettings]);

  // --- PLC server connection check ---
  useEffect(() => {
    if (!plcAddress || !connectionEnabled) {
      setIsPlcConnected(false);
      return;
    }
    const checkStatus = () => {
      invoke('check_server_status', { serverAddr: plcAddress })
        .then(() => setIsPlcConnected(true))
        .catch(() => {
          // Don't mark disconnected while a stream is active (server is clearly alive)
          if (!plcClientRef.current?.isStreaming) {
            setIsPlcConnected(false);
          }
        });
    };
    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, [plcAddress, connectionEnabled]);

  // --- isDirty: mark dirty only when LOGIC changes after deployment (not positions/layout) ---
  const computeLogicFingerprint = (s) => {
    const stripVisual = (v) => {
      if (!v || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(stripVisual);
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (k === 'position' || k === 'x' || k === 'y' || k === 'width' || k === 'height' ||
            k === 'selected' || k === 'dragging' || k === 'measured') continue;
        out[k] = stripVisual(val);
      }
      return out;
    };
    return JSON.stringify(stripVisual({
      programs: s.programs, functions: s.functions,
      functionBlocks: s.functionBlocks, dataTypes: s.dataTypes,
      resources: s.resources,
    }));
  };
  const logicFingerprintRef = React.useRef(computeLogicFingerprint(projectStructure));
  useEffect(() => {
    const fp = computeLogicFingerprint(projectStructure);
    if (fp !== logicFingerprintRef.current && isDeployed) {
      setIsDirty(true);
    }
    logicFingerprintRef.current = fp;
  }, [projectStructure, isDeployed]);

  // Keep isDirtyRef in sync so the window close handler can read it without stale closure
  useEffect(() => { isDirtyRef.current = isDirty; }, [isDirty]);

  // hasUnsaved: true whenever project content changes since last save/load
  const hasUnsavedRef = React.useRef(false);
  const isLoadingProjectRef = React.useRef(false); // suppresses change tracking during load
  useEffect(() => {
    if (isLoadingProjectRef.current) return;
    if (isProjectOpen) hasUnsavedRef.current = true;
  }, [projectStructure, buses, busConfigs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep a ref to handleSave so the close handler can call it without stale closure
  const handleSaveRef = React.useRef(null);

  // Keep isProjectOpen in a ref so the close handler (registered once) always sees fresh value
  const isProjectOpenRef = React.useRef(isProjectOpen);
  useEffect(() => { isProjectOpenRef.current = isProjectOpen; }, [isProjectOpen]);

  // --- Window close: ask to save if project is open ---
  // Registered ONCE so multiple isProjectOpen changes don't stack listeners.
  useEffect(() => {
    const win = getCurrentWindow();
    let isHandlingClose = false;
    const unlistenPromise = win.onCloseRequested(async (event) => {
      if (isHandlingClose) return;
      if (!isProjectOpenRef.current) return;
      if (!hasUnsavedRef.current) return; // no changes since last save → close directly
      event.preventDefault();
      isHandlingClose = true;
      try {
        const choice = await showSaveConfirm();
        if (choice === 'cancel') { isHandlingClose = false; return; }
        if (choice === 'save' && handleSaveRef.current) {
          await handleSaveRef.current().catch(() => {});
        }
      } catch {
        isHandlingClose = false;
        return;
      }
      isHandlingClose = false;
      await win.destroy().catch(() => win.close().catch(() => {}));
    });
    return () => { unlistenPromise.then(fn => fn()).catch(() => {}); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Bus handlers ---
  const handleAddBus = useCallback((type) => {
    const existing = buses.find(b => b.type === type);
    if (existing) {
      setActiveId(existing.id);
      openTab(existing.id, type === 'ethercat' ? 'Master' : type, type === 'ethercat' ? EtherCATTabIcon : '🔌');
      return;
    }
    const newId = `bus_${type}_${Date.now()}`;
    setBuses(prev => [...prev, { id: newId, type }]);
    setActiveId(newId);
    openTab(newId, type === 'ethercat' ? 'Master' : type, type === 'ethercat' ? EtherCATTabIcon : '🔌');
  }, [buses]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDeleteBus = useCallback(async (busId) => {
    const confirmed = await ask('Bu fieldbus bağlantısını kaldırmak istiyor musunuz?', {
      title: 'Fieldbus Kaldır', type: 'warning'
    });
    if (confirmed) {
      const removedBus = buses.find(b => b.id === busId);

      // If removing an EtherCAT master, strip all EC_* blocks from every program's rungs
      if (removedBus?.type === 'ethercat') {
        setProjectStructure(prev => ({
          ...prev,
          programs: prev.programs.map(prog => {
            if (!prog.content?.rungs) return prog;
            const cleanedRungs = prog.content.rungs.map(rung => ({
              ...rung,
              blocks: (rung.blocks || []).filter(b => !b.type?.startsWith('EC_')),
              connections: (rung.connections || []).filter(conn => {
                const remaining = new Set((rung.blocks || [])
                  .filter(b => !b.type?.startsWith('EC_'))
                  .map(b => b.id));
                return remaining.has(conn.source) && remaining.has(conn.target);
              }),
            }));
            return { ...prog, content: { ...prog.content, rungs: cleanedRungs } };
          }),
          functionBlocks: prev.functionBlocks.map(fb => {
            if (!fb.content?.rungs) return fb;
            const cleanedRungs = fb.content.rungs.map(rung => ({
              ...rung,
              blocks: (rung.blocks || []).filter(b => !b.type?.startsWith('EC_')),
              connections: (rung.connections || []).filter(conn => {
                const remaining = new Set((rung.blocks || [])
                  .filter(b => !b.type?.startsWith('EC_'))
                  .map(b => b.id));
                return remaining.has(conn.source) && remaining.has(conn.target);
              }),
            }));
            return { ...fb, content: { ...fb.content, rungs: cleanedRungs } };
          }),
        }));
      }

      setBuses(prev => prev.filter(b => b.id !== busId));
      setBusConfigs(prev => { const n = { ...prev }; delete n[busId]; return n; });
      // Close tab using functional updater to avoid depending on openTabs state
      setOpenTabs(prev => {
        const tabIdx = prev.findIndex(t => t.id === busId);
        const newTabs = prev.filter(t => t.id !== busId);
        if (activeId === busId) {
          const next = newTabs[tabIdx] || newTabs[tabIdx - 1] || null;
          setActiveId(next?.id || null);
        }
        return newTabs;
      });
    }
  }, [activeId, buses]);

  const handleSelectBus = useCallback((busId) => {
    setActiveId(busId);
    const bus = buses.find(b => b.id === busId);
    if (bus) openTab(busId, bus.type === 'ethercat' ? 'Master' : bus.type, bus.type === 'ethercat' ? EtherCATTabIcon : '🔌');
  }, [buses]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleBusConfigChange = useCallback((busId, newConfig) => {
    setBusConfigs(prev => ({ ...prev, [busId]: newConfig }));
  }, []);

  const handleAddGlobalVarsFromBus = useCallback((vars) => {
    const configResource = projectStructure.resources.find(r => r.type === 'RESOURCE_EDITOR');
    if (!configResource) return;
    const existing = configResource.content.globalVars || [];
    const existingNames = new Set(existing.map(v => v.name));
    const toAdd = vars
      .filter(v => !existingNames.has(v.name))
      .map(v => ({ id: `gv_ec_${Date.now()}_${Math.random().toString(36).slice(2)}`, name: v.name, type: v.type, initialValue: '', comment: v.comment || '' }));
    if (!toAdd.length) return;
    setProjectStructure(prev => ({
      ...prev,
      resources: prev.resources.map(r =>
        r.type === 'RESOURCE_EDITOR'
          ? { ...r, content: { ...r.content, globalVars: [...(r.content.globalVars || []), ...toAdd] } }
          : r
      ),
    }));
  }, [projectStructure]);

  // Called from SettingsPage: save ESI file to library and reload device list
  const handleLoadEsiFile = useCallback(async (filename, content) => {
    await saveEsiFile(filename, content);
    const devices = await loadAllEsiDevices();
    setEsiLibrary(devices);
  }, []);

  // --- Layout & Resizing State ---
  const [layout, setLayout] = useState({
    leftWidth: 250,
    rightWidth: 250,
    consoleHeight: 150
  });
  const [isResizing, setIsResizing] = useState(null); // 'left', 'right', 'console'

  // Console Scroll Ref
  const [logs, setLogs] = useState([
    { type: 'info', msg: t('logs.systemInitialized') || 'System initialized.' },
    { type: 'info', msg: t('logs.systemReady') || 'Ready to map PLC project...' }
  ]);

  // Watch table state
  const [watchTable, setWatchTable] = useState([]);
  const addToWatchTable = useCallback((entry) => {
    setWatchTable(prev => prev.some(e => e.liveKey === entry.liveKey) ? prev : [...prev, entry]);
  }, []);
  const removeFromWatchTable = useCallback((id) => {
    setWatchTable(prev => prev.filter(e => e.id !== id));
  }, []);
  const updateWatchTableEntry = useCallback((id, updated) => {
    setWatchTable(prev => prev.map(e => e.id === id ? updated : e));
  }, []);

  // ── Tab system ──
  const [openTabs, setOpenTabs] = useState([]);

  const SPECIAL_TABS = {
    'SETTINGS':     { label: 'Settings',       icon: '⚙️' },
    'BOARD_CONFIG': { label: 'Devices',         icon: '🖥' },
    'TASK_MANAGER': { label: 'Task Manager',    icon: '⏱' },
    'VISUALIZATION':{ label: 'Visualization',   icon: '📊' },
  };

  const getItemIcon = (category, type) => {
    if (category === 'programs') {
      if (type === 'LD') return '🪜';
      if (type === 'SCL') return '≋';
      return '📋';
    }
    if (category === 'functionBlocks') return '🧩';
    if (category === 'functions') return '⚡';
    if (category === 'dataTypes') return '🔷';
    if (category === 'resources') return '⚙️';
    return '📄';
  };

  // Open a tab; no-op if already open
  const openTab = (id, label, icon) => {
    setOpenTabs(prev => prev.some(t => t.id === id) ? prev : [...prev, { id, label, icon }]);
  };

  // Open a special tab (SETTINGS, TASK_MANAGER, etc.) and activate it
  const openSpecialTab = (id) => {
    const info = SPECIAL_TABS[id];
    if (info) openTab(id, info.label, info.icon);
    setActiveId(id);
  };

  // Close a tab; activate adjacent if it was active
  const closeTab = (id) => {
    const idx = openTabs.findIndex(t => t.id === id);
    const newTabs = openTabs.filter(t => t.id !== id);
    setOpenTabs(newTabs);
    if (activeId === id) {
      const next = newTabs[idx] || newTabs[idx - 1] || null;
      setActiveId(next?.id || null);
    }
  };

  // Update a tab's label (on rename)
  const renameTab = (id, newLabel) => {
    setOpenTabs(prev => prev.map(t => t.id === id ? { ...t, label: newLabel } : t));
  };

  const addLog = useCallback((type, msg) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => {
      const next = [...prev, { type, msg: `[${time}] ${msg} ` }];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  // --- Simulation Compile Log Listener (debug) ---
  useEffect(() => {
    let unlisten = null;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('simulation-compile-log', (event) => {
        addLog('info', event.payload);
      }).then(f => unlisten = f);
    });
    return () => { if (unlisten) unlisten(); };
  }, []);

  // --- Live Variable Listener ---
  const [liveVariables, setLiveVariables] = useState({});
  const liveVarsRef = React.useRef(liveVariables);

  // Throttled sync: copy ref to state at ~2 FPS to avoid re-render storms
  const liveVarsDirtyRef = React.useRef(false);
  useEffect(() => {
    if (!isRunning) return;
    const syncId = setInterval(() => {
      if (liveVarsDirtyRef.current) {
        liveVarsDirtyRef.current = false;
        setLiveVariables({ ...liveVarsRef.current });
      }
    }, 500);
    return () => clearInterval(syncId);
  }, [isRunning]);

  useEffect(() => {
    let unlisten = null;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('simulation-output', (event) => {
        try {
          const parsed = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
          if (parsed.vars) {
            // Write to ref (no re-render); throttled sync will push to state
            Object.assign(liveVarsRef.current, parsed.vars);
            liveVarsDirtyRef.current = true;
          } else if (parsed.status === 'exited' || parsed.status === 'crashed') {
            setIsRunning(false);
            addLog('warning', t('logs.simulationStatus', { status: parsed.status }) || `Simulation ${parsed.status}.`);
          } else if (parsed.error) {
            addLog('error', t('logs.simulationError', { error: parsed.error }) || `Simulation: ${parsed.error}`);
          }
        } catch (e) {
          console.error("Failed to parse simulation output:", e, "Raw Payload:", event.payload);
        }
      }).then(f => unlisten = f);
    });
    return () => { if (unlisten) unlisten(); };
  }, []);

  // --- File Operations ---

  const handleSaveAs = useCallback(async () => {
    try {
      let filePath = await save({
        filters: []
      });
      if (!filePath) return;

      if (!filePath.toLowerCase().endsWith('.xml')) {
        filePath += '.xml';
      }

      const xmlContent = exportProjectToXml(projectStructure, selectedBoard, { plcAddress, sshUser, sshPort }, buses, busConfigs, watchTable, hmiLayout);
      await writeTextFile(filePath, xmlContent);

      hasUnsavedRef.current = false;
      setCurrentFilePath(filePath);
      addLog('success', t('logs.projectSaved', { path: filePath }) || `Project saved to ${filePath} `);
    } catch (error) {
      addLog('error', t('logs.saveAsError', { error: error }) || `Save As Error: ${error} `);
    }
  }, [projectStructure, selectedBoard, plcAddress, sshUser, sshPort, buses, busConfigs, hmiLayout, addLog]);

  const handleSave = useCallback(async () => {
    if (!currentFilePath) {
      await handleSaveAs();
      return;
    }

    try {
      const xmlContent = exportProjectToXml(projectStructure, selectedBoard, { plcAddress, sshUser, sshPort }, buses, busConfigs, watchTable, hmiLayout);
      await writeTextFile(currentFilePath, xmlContent);
      hasUnsavedRef.current = false;
      addLog('success', t('logs.projectSaved', { path: currentFilePath }) || `Project saved to ${currentFilePath} `);
    } catch (error) {
      addLog('error', t('logs.saveError', { error: error }) || `Save Error: ${error} `);
    }
  }, [currentFilePath, handleSaveAs, projectStructure, selectedBoard, plcAddress, sshUser, sshPort, buses, busConfigs, hmiLayout, addLog]);

  // Keep ref up-to-date so onCloseRequested handler can call it without stale closure
  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);

  const handleNewProject = useCallback(() => {
    // Show board selection first, then create project
    setPendingNewProject(true);
    setIsBoardModalOpen(true);
  }, []);

  const handleBoardSelected = useCallback((boardId) => {
    setSelectedBoard(boardId);
    if (pendingNewProject) {
      // Creating a new project with selected board
      setProjectStructure(defaultProjectStructure);
      setBuses([]);
      setCurrentFilePath(null);
      setActiveId(null);
      const boardInfo = getBoardById(boardId);
      setLogs([
        { type: 'info', msg: t('logs.startedNewProject') || 'Started new project.' },
        { type: 'info', msg: `Board: ${boardInfo?.name || boardId}` }
      ]);
      hasUnsavedRef.current = false;
      setIsProjectOpen(true);
      setPendingNewProject(false);
    } else {
      const boardInfo = getBoardById(boardId);
      addLog('info', `Board changed to: ${boardInfo?.name || boardId}`);
    }
  }, [pendingNewProject, defaultProjectStructure, addLog, t]);

  const handleCloseProject = useCallback(async () => {
    const confirmation = await ask(t('messages.confirmCloseProject') || 'Are you sure you want to close the current project? Any unsaved changes will be lost.', {
      title: 'Close Project',
      type: 'warning'
    });

    if (confirmation) {
      hasUnsavedRef.current = false;
      setIsProjectOpen(false);
      setProjectStructure(defaultProjectStructure);
      setBuses([]);
      setBusConfigs({});
      setCurrentFilePath(null);
      setActiveId(null);
      setOpenTabs([]);
      setWatchTable([]);
      setHmiLayout({ pages: [] });
      setSelectedBoard(null);
      setIsDeployed(false);
      setIsDirty(false);
      setIsSimulationMode(false);
      setIsRunning(false);
      setLiveVariables({});
      liveVarsRef.current = {};
      if (stopStreamRef.current) {
        stopStreamRef.current();
        stopStreamRef.current = null;
      }
      if (plcClientRef.current) {
        plcClientRef.current.close();
        plcClientRef.current = null;
      }
    }
  }, [defaultProjectStructure]);

  const handleOpen = async () => {
    // Determine if we are running in Tauri
    const isTauri = window.__TAURI_INTERNALS__ !== undefined;

    if (isTauri) {
      try {
        const selected = await open({
          multiple: false
        });

        if (!selected) return;

        const filePath = Array.isArray(selected) ? selected[0] : selected;
        const content = await readTextFile(filePath);
        processFileContent(content, filePath);
      } catch (error) {
        console.error(error);
        addLog('error', t('logs.openError', { error: error }) || `Open Error: ${error} `);
      }
    } else {
      // Web Fallback: Use standard HTML file input
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.xml';
      input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
          const content = event.target.result;
          processFileContent(content, file.name);
        };
        reader.readAsText(file);
      };
      input.click();
    }
  };

  const processFileContent = (content, filePath) => {
    try {
      const result = importProjectFromXml(content);
      if (result) {
        const { projectStructure: newStructure, boardId, plcAddress: savedAddr, sshUser: savedSshUser, sshPort: savedSshPort } = result;
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
          addLog('warning', t('logs.missingConfigRestored') || 'Project had no configuration; restored default.');
        }

        // Ensure taskConfig exists for projects saved before Task Manager was added
        if (!newStructure.taskConfig) {
          newStructure.taskConfig = { tasks: [] };
        }

        isLoadingProjectRef.current = true;
        setProjectStructure(newStructure);
        setCurrentFilePath(filePath);
        setActiveId(null);
        setOpenTabs([]);
        setBuses(result.buses || []);
        setBusConfigs(result.busConfigs || {});
        setWatchTable(result.watchTable || []);
        setHmiLayout(result.hmiLayout || { pages: [] });
        setIsProjectOpen(true);
        // Reset after state batch; setTimeout ensures effects ran first
        setTimeout(() => { isLoadingProjectRef.current = false; hasUnsavedRef.current = false; }, 0);

        // Restore board from XML
        if (boardId) {
          setSelectedBoard(boardId);
        }

        // Restore connection settings from XML
        if (savedAddr) {
          setPlcAddress(savedAddr);
          localStorage.setItem('plcAddress', savedAddr);
        }
        if (savedSshUser) {
          setSshUser(savedSshUser);
          localStorage.setItem('sshUser', savedSshUser);
        }
        if (savedSshPort) {
          setSshPort(savedSshPort);
          localStorage.setItem('sshPort', savedSshPort);
        }

        addLog('success', t('logs.projectLoaded', { path: filePath }) || `Project loaded from ${filePath} `);
      } else {
        addLog('error', t('logs.invalidFormat') || 'Failed to parse project file (Invalid Format).');
      }
    } catch (error) {
       console.error(error);
       addLog('error', t('logs.openError', { error: error }) || `Open Error: ${error} `);
    }
  };

  const handleToggleSimulation = async () => {
    if (isPlcConnected) {
      addLog('error', t('logs.cannotSimulateConnected') || 'Cannot enable Simulation Mode while PLC is connected.');
      return;
    }

    if (isRunning) {
      addLog('warning', t('logs.stopExecutionFirst') || 'Please stop execution before toggling simulation mode.');
      return;
    }

    const nextMode = !isSimulationMode;

    if (nextMode) {
      addLog('info', t('logs.compilingSimulationTranspile') || 'Compiling Project for Simulation (C Transpilation)...');
      try {
        const standardHeaders = await invoke('get_standard_headers').catch(() => []);
        const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard);
        const outPath = await invoke('write_plc_files', {
          header: cCode.header,
          source: cCode.source,
          variableTable: JSON.stringify(cCode.variableTable, null, 2)
        });
        addLog('success', t('logs.transpiledSaved', { path: outPath }) || `Transpiled C header and source successfully saved to ${outPath}`);

        addLog('info', t('logs.compilingSimulation') || 'Compiling simulation executable...');
        const exePath = await invoke('compile_simulation');
        addLog('success', t('logs.simulationCompiled', { path: exePath }) || `Simulation executable compiled: ${exePath}`);

        setIsSimulationMode(true);

        // Load Default Initial Values from debugDefaults (keyed by live variable key)
        let initialLiveVars = {};
        if (cCode.variableTable && cCode.variableTable.debugDefaults) {
          Object.entries(cCode.variableTable.debugDefaults).forEach(([liveKey, info]) => {
            initialLiveVars[liveKey] = info.defaultValue;
          });
        }

        liveVarsRef.current = initialLiveVars;
        setLiveVariables(initialLiveVars);
        addLog('info', t('logs.simulationEnabled') || 'Simulation Mode Enabled. Variables populated with default values.');
      } catch (error) {
        addLog('error', t('logs.simulationCompileFailed', { error: error }) || `Simulation Compilation Failed: ${error}`);
      }
    } else {
      setIsSimulationMode(false);
      addLog('info', t('logs.simulationDisabled') || 'Simulation Mode Disabled.');
      liveVarsRef.current = {};
      setLiveVariables({});
    }
  };

  const handleStartExecution = async () => {
    if (!isSimulationMode && !(isDeployed && !isDirty && isPlcConnected)) {
      addLog('warning', 'Cannot start. Enable Simulation Mode or Build & Send to PLC first.');
      return;
    }

    if (isSimulationMode) {
      setIsRunning(true);
      addLog('success', 'Running Simulation Execution...');
      try {
        await invoke('run_simulation');
      } catch (err) {
        addLog('error', `Failed to start simulation: ${err}`);
        setIsRunning(false);
      }
    } else if (isDeployed && !isDirty && isPlcConnected) {
      // Remote execution via ConnectRPC (server streaming — no polling)
      try {
        // Reuse existing client if already connected.
        if (!plcClientRef.current) {
          plcClientRef.current = new PLCClient(plcAddress);
        }
        const client = plcClientRef.current;

        addLog('success', 'Connecting to PLC...');
        await client.start();
        addLog('success', 'PLC runtime started.');
        setIsRunning(true);

        // Auto force-write literal-valued FB input shadow variables so the PLC
        // runtime sees the user-specified defaults from the block pin inputs.
        const shadowWrites = Object.entries(liveVarsRef.current)
          .filter(([k, v]) =>
            remoteVarKeysRef.current.includes(k) &&
            k.includes('_in_') &&
            v !== 0 && v !== false && v !== null && v !== undefined
          )
          .map(([k, v]) => client.writeVar(k, v).catch((e) => {
            addLog('error', `Auto force-write failed for '${k}': ${e.message}`);
          }));
        if (shadowWrites.length > 0) await Promise.all(shadowWrites);

        // Start server-streaming subscription (server pushes every 50 ms).
        if (remoteVarKeysRef.current.length > 0) {
          stopStreamRef.current = client.streamVars(
            (vars) => {
              // vars is a plain JS object: { varName: value, ... }
              Object.assign(liveVarsRef.current, vars);
              liveVarsDirtyRef.current = true;
            },
            (err) => {
              addLog('error', `Stream error: ${err.message}`);
            },
          );
        }
      } catch (err) {
        addLog('error', `Failed to start PLC: ${err.message || err}`);
        setIsRunning(false);
      }
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
      } else if (plcClientRef.current) {
        // Stop the variable stream first.
        if (stopStreamRef.current) {
          stopStreamRef.current();
          stopStreamRef.current = null;
        }
        // Send stop + clear forces (fire-and-forget; errors just logged).
        plcClientRef.current.stop().catch((e) => addLog('error', `Stop failed: ${e.message}`));
        plcClientRef.current.clearAllForces().catch(() => {});
        // Re-check server status immediately so connection indicator stays green.
        if (plcAddress && connectionEnabled) {
          invoke('check_server_status', { serverAddr: plcAddress })
            .then(() => setIsPlcConnected(true))
            .catch(() => setIsPlcConnected(false));
        }
      }

      addLog('info', 'Execution Stopped.');
    }
  };

  const handleForceWrite = useCallback(async (key, value) => {
    if (!isRunning) return;
    if (plcClientRef.current && !isSimulationMode) {
      const normalizedValue = (() => {
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        if (trimmed === '') return value;
        if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
        const asNumber = Number(trimmed);
        return Number.isFinite(asNumber) ? asNumber : value;
      })();

      // Remote force write — skip FB instance variables (no SHM slot)
      if (!remoteVarKeysRef.current.includes(key)) return;
      plcClientRef.current.writeVar(key, normalizedValue).catch((e) => {
        addLog('error', `Force write failed for '${key}': ${e.message}`);
      });
    } else {
      try {
        await invoke('write_variable', { name: key, value: String(value) });
      } catch (err) {
        addLog('error', `Force write failed for '${key}': ${err}`);
      }
    }
  }, [isRunning, isSimulationMode, addLog]);

  const isBaremetalBoard = (boardId) => boardId === 'rpi_pico' || boardId === 'rpi_pico_w';

  const checkBaremetalConcurrency = () => {
    if (!isBaremetalBoard(selectedBoard)) return true;
    const taskCount = (projectStructure.taskConfig?.tasks || []).length;
    if (taskCount > 1) {
      addLog('warning', `⚠ Baremetal target (${selectedBoard}) detected with ${taskCount} concurrent tasks. Concurrent pthreads are not supported on baremetal; tasks will run cooperatively via timer wheel. Ensure total CPU load fits within a single core.`);
    }
    return true;
  };

  const checkTaskAssignments = () => {
    const tasks = projectStructure?.taskConfig?.tasks || [];
    const programs = projectStructure?.programs || [];
    if (programs.length === 0) return true; // no programs, nothing to check
    if (tasks.length === 0) {
      addLog('error', 'No tasks defined. Create at least one task and assign programs before building.');
      return false;
    }
    const assignedPrograms = new Set(tasks.flatMap(t => (t.programs || []).map(p => p.program)));
    const unassigned = programs.map(p => p.name).filter(n => !assignedPrograms.has(n));
    if (unassigned.length > 0) {
      addLog('warning', `Programs not assigned to any task (will not run): ${unassigned.join(', ')}`);
    }
    return true;
  };

  const handleBuild = async () => {
    if (!checkTaskAssignments()) return;
    const boardInfo = getBoardById(selectedBoard);
    checkBaremetalConcurrency();
    addLog('info', `Build started for board: ${boardInfo?.name || selectedBoard}...`);
    try {
      const standardHeaders = await invoke('get_standard_headers').catch(() => []);
      const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard);
      await invoke('write_plc_files', {
        header: cCode.header,
        source: cCode.source,
        variableTable: JSON.stringify(cCode.variableTable, null, 2)
      });
      await invoke('compile_simulation');
      addLog('success', 'Build successful.');
    } catch (err) {
      addLog('error', `Build failed: ${err.message || err}`);
    }
  };

  const handleBuildAndSend = async () => {
    if (!checkTaskAssignments()) return;
    if (!isPlcConnected || !plcAddress) {
      addLog('error', 'Cannot Build & Send: not connected to PLC server.');
      return;
    }
    const boardInfo = getBoardById(selectedBoard);
    checkBaremetalConcurrency();
    addLog('info', `Build & Send for ${boardInfo?.name || selectedBoard}...`);
    try {
      const standardHeaders = await invoke('get_standard_headers').catch(() => []);
      const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, false);

      addLog('info', 'Cross-compiling for target...');
      await invoke('compile_for_target', {
        header: cCode.header,
        source: cCode.source,
        variableTable: JSON.stringify(cCode.variableTable, null, 2),
        boardId: selectedBoard,
        diCount: boardInfo?.pinout?.diCount ?? null,
        doCount: boardInfo?.pinout?.doCount ?? null,
      });
      addLog('success', 'Cross-compilation successful.');

      addLog('info', `Deploying to ${plcAddress}...`);
      await invoke('deploy_to_server', { serverAddr: plcAddress });
      addLog('success', `Deployed to ${plcAddress}.`);

      // Deploy HMI layout (JSON). Empty pages → server clears HMI, serves nothing.
      const hasHmiPages = (hmiLayout?.pages?.length ?? 0) > 0;
      const hmiPayload = hasHmiPages ? JSON.stringify(hmiLayout) : '{}';
      try {
        const hmiResp = await fetch(`http://${plcAddress}/deploy/hmi-layout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: hmiPayload,
        });
        if (!hmiResp.ok) {
          addLog('warning', `HMI layout deploy failed: ${hmiResp.status} ${hmiResp.statusText}`);
        } else {
          const result = await hmiResp.json();
          if (hasHmiPages) {
            addLog('info', `HMI deployed: ${result.pages ?? '?'} page(s).`);
          }
        }
      } catch (hmiErr) {
        addLog('warning', `HMI layout deploy skipped: ${hmiErr.message}`);
      }

      setIsDeployed(true);
      setIsDirty(false);

      // Store debug defaults for live variable display
      if (cCode.variableTable && cCode.variableTable.debugDefaults) {
        let initialLiveVars = {};
        const remoteKeys = [];
        Object.entries(cCode.variableTable.debugDefaults).forEach(([liveKey, info]) => {
          initialLiveVars[liveKey] = info.defaultValue;
          if (info.offset !== undefined) remoteKeys.push(liveKey);
        });
        liveVarsRef.current = initialLiveVars;
        setLiveVariables(initialLiveVars);
        remoteVarKeysRef.current = remoteKeys;
      }
    } catch (err) {
      addLog('error', `Build & Send failed: ${err.message || err}`);
    }
  };

  // --- Global Keyboard Shortcuts ---
  // Use refs so the keydown listener always calls latest handler versions
  const handleBuildRef = React.useRef(handleBuild);
  handleBuildRef.current = handleBuild;
  const handleStartRef = React.useRef(handleStartExecution);
  handleStartRef.current = handleStartExecution;

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
          handleBuildRef.current();
        }

        // Run/Start: Ctrl + X
        if (e.key.toLowerCase() === 'x') {
          e.preventDefault();
          handleStartRef.current();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave, addLog, t]);


  // --- Handlers ---

  const handleAddItem = (category, insertIndex = null) => {
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
      setDataTypeModal({ isOpen: true, existingNames, insertIndex });
      return;
    }

    setCreateModal({
      isOpen: true,
      category,
      defaultName,
      isEdit: false,
      editId: null,
      initialData: {},
      insertIndex
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

    setProjectStructure(prev => {
      const items = [...prev.dataTypes];
      const insertAt = dataTypeModal.insertIndex;
      if (insertAt !== null && insertAt !== undefined && insertAt >= 0 && insertAt <= items.length) {
        items.splice(insertAt, 0, newItem);
      } else {
        items.push(newItem);
      }
      return { ...prev, dataTypes: items };
    });
    setActiveId(newItem.id);
    openTab(newItem.id, name, '🔷');
    addLog('info', t('logs.addedDataType', { name, type }) || `Added Data Type ${name} (${type})`);
    setDataTypeModal({ isOpen: false, existingNames: [] });
  };

  const handleCreateConfirm = (name, type, returnType) => {
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
            };
          }
          return item;
        });

        if (category === 'programs' && oldProgramName && oldProgramName !== name) {
          // Sync taskConfig program name
          nextStruct.taskConfig = {
            ...nextStruct.taskConfig,
            tasks: (nextStruct.taskConfig?.tasks || []).map(t => ({
              ...t,
              programs: t.programs.map(p => p.program === oldProgramName ? { ...p, program: name } : p),
            })),
          };
        }
        return nextStruct;
      });
      renameTab(createModal.editId, name);
      addLog('info', t('logs.updatedProperties', { name }) || `Updated properties for ${name}`);
      setCreateModal({ isOpen: false, category: '', defaultName: '', isEdit: false, editId: null, initialData: {}, insertIndex: null });
      return true;
    }

    const newItem = {
      id: `${category}_${Date.now()}`,
      name: name,
      type,
      returnType: category === 'functions' ? returnType : undefined,
      content:
        (type === 'LD' || type === 'SCL') ? { rungs: [], variables: [] } :
          type === 'UDT' ? { members: [] } :
            type === 'GVL' ? { variables: [] } :
              { code: '', variables: [] }
    };

    setProjectStructure(prev => {
      const catItems = [...prev[category]];
      const insertAt = createModal.insertIndex;
      if (insertAt !== null && insertAt !== undefined && insertAt >= 0 && insertAt <= catItems.length) {
        catItems.splice(insertAt, 0, newItem);
      } else {
        catItems.push(newItem);
      }
      return { ...prev, [category]: catItems };
    });

    setActiveId(newItem.id);
    openTab(newItem.id, name, getItemIcon(category, type));
    addLog('info', t('logs.addedItem', { name, type, category }) || `Added ${name} (${type}) to ${category}`);
    // Close modal handled by createModal state update below
    setCreateModal({ isOpen: false, category: '', defaultName: '', isEdit: false, editId: null, initialData: {}, insertIndex: null });
    return true;
  };

  const handleDeleteItem = (category, id) => {
    setProjectStructure(prev => {
      const removed = prev[category]?.find(item => item.id === id);
      const next = { ...prev, [category]: prev[category].filter(item => item.id !== id) };
      if (category === 'programs' && removed) {
        const pName = removed.name;
        next.taskConfig = {
          ...prev.taskConfig,
          tasks: (prev.taskConfig?.tasks || []).map(t => ({
            ...t,
            programs: t.programs
              .filter(p => p.program !== pName)
              .sort((a, b) => a.priority - b.priority)
              .map((p, i) => ({ ...p, priority: i })),
          })),
        };
      }
      return next;
    });
    // Close tab
    const idx = openTabs.findIndex(t => t.id === id);
    const newTabs = openTabs.filter(t => t.id !== id);
    setOpenTabs(newTabs);
    if (activeId === id) {
      const next = newTabs[idx] || newTabs[idx - 1] || null;
      setActiveId(next?.id || null);
    }
    addLog('warning', t('logs.deletedItem', { id }) || `Deleted item ${id}`);
  };

  const handleReorderItem = (category, sourceIndex, destinationIndex) => {
    setProjectStructure(prev => {
      if (!prev[category]) return prev;

      const newItems = Array.from(prev[category]);
      const [movedItem] = newItems.splice(sourceIndex, 1);
      newItems.splice(destinationIndex, 0, movedItem);

      return {
        ...prev,
        [category]: newItems
      };
    });
  };

  // Paste a sidebar item (deep-copied) at a given index within a category
  const handlePasteItem = (category, newItem, insertIndex) => {
    // Ensure unique name
    const existingNames = new Set(projectStructure[category].map(i => i.name));
    let name = newItem.name;
    let counter = 1;
    while (existingNames.has(name)) {
      name = `${newItem.name.replace(/_copy\d*$/, '')}_copy${counter}`;
      counter++;
    }
    const item = { ...newItem, name };
    setProjectStructure(prev => {
      const items = [...prev[category]];
      if (insertIndex !== null && insertIndex !== undefined && insertIndex >= 0 && insertIndex <= items.length) {
        items.splice(insertIndex, 0, item);
      } else {
        items.push(item);
      }
      return { ...prev, [category]: items };
    });
    setActiveId(item.id);
    openTab(item.id, item.name, getItemIcon(category, item.type));
    addLog('info', `Pasted ${category} item: ${item.name}`);
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
        renameTab(id, newName);
        addLog('info', t('logs.renamedItem', { name: newName }) || `Renamed item to ${newName}`);
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
      }
    });
  };

  const handleSelectItem = (category, id) => {
    setActiveId(id);
    // Special pages (TASK_MANAGER, VISUALIZATION, …)
    if (SPECIAL_TABS[id]) {
      openTab(id, SPECIAL_TABS[id].label, SPECIAL_TABS[id].icon);
      return;
    }
    // Project items
    for (const key of Object.keys(projectStructure)) {
      if (!Array.isArray(projectStructure[key])) continue;
      const item = projectStructure[key].find(i => i.id === id);
      if (item) {
        openTab(id, item.name, getItemIcon(key, item.type));
        return;
      }
    }
    // Buses
    const bus = buses.find(b => b.id === id);
    if (bus) openTab(id, bus.type === 'ethercat' ? 'Master' : bus.type, bus.type === 'ethercat' ? EtherCATTabIcon : '🔌');
  };

  const getActiveItem = () => {
    for (const key of Object.keys(projectStructure)) {
      if (!Array.isArray(projectStructure[key])) continue;
      const item = projectStructure[key].find(i => i.id === activeId);
      if (item) return { ...item, category: key };
    }
    return null;
  };

  const activeItem = getActiveItem();
  const deviceInterfaceConfig =
    projectStructure.resources?.find(r => r.id === 'res_config')?.content?.deviceInterfaceConfig || {};

  const hwPortVars = useMemo(
    () => buildHardwarePortVars(deviceInterfaceConfig, getBoardFamilyDefine(selectedBoard)),
    [deviceInterfaceConfig, selectedBoard]
  );

  const handleDeviceInterfaceConfigChange = useCallback((nextConfig) => {
    setProjectStructure(prev => ({
      ...prev,
      resources: (prev.resources || []).map(resource =>
        resource.id === 'res_config'
          ? {
              ...resource,
              content: {
                ...(resource.content || {}),
                deviceInterfaceConfig: nextConfig,
              },
            }
          : resource
      ),
    }));
  }, []);

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
    let rafId = null;
    const handleMouseMove = (e) => {
      if (!isResizing) return;
      if (rafId) return; // skip if a frame is already pending
      rafId = requestAnimationFrame(() => {
        rafId = null;
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
      });
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
      if (rafId) cancelAnimationFrame(rafId);
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

  // Filter accessible blocks by declaration order:
  // functions: only preceding functions + library
  // functionBlocks: all functions + preceding FBs + library
  // programs: all
  const getAvailableBlocks = () => {
    if (!activeItem) return [...projectStructure.functionBlocks, ...projectStructure.functions, ...parsedBlocks];
    const cat = activeItem.category;
    if (cat === 'functions') {
      const idx = projectStructure.functions.findIndex(f => f.id === activeItem.id);
      const prevFunctions = idx >= 0 ? projectStructure.functions.slice(0, idx) : projectStructure.functions;
      return [...prevFunctions, ...parsedBlocks];
    } else if (cat === 'functionBlocks') {
      const idx = projectStructure.functionBlocks.findIndex(fb => fb.id === activeItem.id);
      const prevFBs = idx >= 0 ? projectStructure.functionBlocks.slice(0, idx) : projectStructure.functionBlocks;
      return [...prevFBs, ...projectStructure.functions, ...parsedBlocks];
    }
    // programs and others: all
    return [...projectStructure.functionBlocks, ...projectStructure.functions, ...parsedBlocks];
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', background: '#1e1e1e', overflow: 'hidden', boxShadow: 'inset 0 0 0 1px #3e3e42' }}>
      <SaveConfirmDialog
        isOpen={saveConfirmOpen}
        onSave={handleSaveConfirmSave}
        onDiscard={handleSaveConfirmDiscard}
        onCancel={handleSaveConfirmCancel}
      />

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

            {/* Info & Settings buttons */}
            <button
              className="toolbar-btn"
              onClick={() => setShortcutsModalOpen(true)}
              style={{ fontSize: '24px', lineHeight: 1, padding: '4px 6px', background: 'transparent', border: '1px solid transparent' }}
              title={t('common.shortcuts') || 'Shortcuts'}
            >
              ℹ️
            </button>
            <button
              className="toolbar-btn"
              onClick={() => openSpecialTab('SETTINGS')}
              style={{ fontSize: '24px', lineHeight: 1, padding: '4px 6px', background: 'transparent', border: '1px solid transparent', marginRight: '10px' }}
              title={t('common.settings')}
            >
              ⚙️
            </button>

            {/* Build OR Build & Send (single button, depends on PLC connection) */}
            <button
              className="toolbar-btn"
              onClick={isPlcConnected ? handleBuildAndSend : handleBuild}
              disabled={isRunning}
              style={{ opacity: isRunning ? 0.5 : 1 }}
            >
              {isPlcConnected ? '📡 Build & Send' : `🔨 ${t('actions.build') || 'Build'}`}
            </button>

            <div style={{ width: 10 }}></div>

            {/* Simulation Toggle */}
            <button
              className={`toolbar-btn ${isSimulationMode ? 'simulation-active' : ''}`}
              onClick={handleToggleSimulation}
              disabled={isRunning}
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
              disabled={isRunning || (!isSimulationMode && !(isDeployed && !isDirty && isPlcConnected))}
              style={{ opacity: (isRunning || (!isSimulationMode && !(isDeployed && !isDirty && isPlcConnected))) ? 0.5 : 1 }}
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

            {/* Connection indicator */}
            {plcAddress && (
              <button
                onClick={() => {
                  if (isRunning) return; // Don't toggle connection while running
                  if (isPlcConnected) {
                    setConnectionEnabled(false);
                    setIsPlcConnected(false);
                  } else {
                    setConnectionEnabled(true);
                  }
                }}
                disabled={isRunning}
                title={isRunning ? 'Stop execution before disconnecting' : isPlcConnected ? 'Click to disconnect' : 'Click to connect'}
                style={{
                  marginLeft: '10px', display: 'flex', alignItems: 'center', gap: '6px',
                  fontSize: '12px', color: '#888', background: 'none', border: '1px solid #3e3e42',
                  borderRadius: '4px', padding: '2px 8px', cursor: 'pointer'
                }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: isPlcConnected ? '#4ec9b0' : '#666',
                  display: 'inline-block', flexShrink: 0
                }} />
                {isPlcConnected ? 'Connected' : 'Disconnected'}
                {isDeployed && !isDirty && <span style={{ color: '#4ec9b0', marginLeft: 4 }}>Deployed</span>}
                {isDeployed && isDirty && <span style={{ color: '#f44747', marginLeft: 4 }}>Modified</span>}
              </button>
            )}
          </>
        )}
      </div>

      {/* 2. BODY (Row) */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {!isProjectOpen ? (
          <StartScreen
            onNewProject={handleNewProject}
            onOpenProject={handleOpen}
            theme={theme}
            setTheme={setTheme}
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
                onReorderItem={handleReorderItem}
                onPasteItem={handlePasteItem}
                onBoardClick={() => openSpecialTab('BOARD_CONFIG')}
                selectedBoard={selectedBoard}
                isRunning={isRunning || isSimulationMode}
                liveVariables={isRunning ? liveVariables : null}
                buses={buses}
                onAddBus={handleAddBus}
                onDeleteBus={handleDeleteBus}
                onSelectBus={handleSelectBus}
              />
            </div>

            {/* RESIZER (LEFT) */}
            <div
              onMouseDown={() => startResizing('left')}
              style={{ width: 5, cursor: 'col-resize', background: isResizing === 'left' ? '#007acc' : '#1e1e1e', zIndex: 10, flexShrink: 0, borderRight: '1px solid #333' }}
            />

            {/* CENTER COLUMN (Editor + Console) */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: '#1e1e1e' }}>

              {/* EDITOR TABS */}
              <EditorTabs
                tabs={openTabs}
                activeId={activeId}
                onActivate={(id) => setActiveId(id)}
                onClose={closeTab}
              />

              {/* EDITOR */}
              <div
                style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
                onMouseDown={() => window.getSelection()?.removeAllRanges()}
              >
                {buses.some(b => b.id === activeId && b.type === 'ethercat') ? (
                  <ErrorBoundary>
                    <Suspense fallback={<div style={{ padding: 20, color: '#888' }}>Loading EtherCAT editor...</div>}>
                      <EtherCATEditor
                        busConfig={busConfigs[activeId]}
                        onChange={(cfg) => handleBusConfigChange(activeId, cfg)}
                        onAddGlobalVars={handleAddGlobalVarsFromBus}
                        isRunning={isRunning || isSimulationMode}
                        esiLibrary={esiLibrary}
                      />
                    </Suspense>
                  </ErrorBoundary>
                ) : activeId === 'SETTINGS' ? (
                  <ErrorBoundary>
                    <SettingsPage
                      theme={theme}
                      setTheme={setTheme}
                      editorSettings={editorSettings}
                      setEditorSettings={setEditorSettings}
                      selectedBoard={selectedBoard}
                      plcAddress={plcAddress}
                      setPlcAddress={setPlcAddress}
                      sshUser={sshUser}
                      setSshUser={setSshUser}
                      sshPort={sshPort}
                      setSshPort={setSshPort}
                      isPlcConnected={isPlcConnected}
                      setConnectionEnabled={setConnectionEnabled}
                      esiLibrary={esiLibrary}
                      onLoadEsiFile={handleLoadEsiFile}
                    />
                  </ErrorBoundary>
                ) : activeId === 'BOARD_CONFIG' ? (
                  <ErrorBoundary>
                    <BoardConfigPage
                      boardId={selectedBoard}
                      interfaceConfig={deviceInterfaceConfig}
                      onInterfaceConfigChange={handleDeviceInterfaceConfigChange}
                    />
                  </ErrorBoundary>
                ) : activeId === 'TASK_MANAGER' ? (
                  <ErrorBoundary>
                    <TaskManager
                      taskConfig={projectStructure.taskConfig}
                      onTaskConfigChange={(tc) => setProjectStructure(prev => ({ ...prev, taskConfig: tc }))}
                      programs={projectStructure.programs}
                      isRunning={isRunning}
                      liveVariables={isRunning ? liveVariables : null}
                    />
                  </ErrorBoundary>
                ) : activeId === 'VISUALIZATION' ? (
                  <VisualizationEditor
                    hmiLayout={hmiLayout}
                    onLayoutChange={setHmiLayout}
                    liveVariables={isRunning ? liveVariables : null}
                    onForceWrite={isRunning ? handleForceWrite : null}
                    isRunning={isRunning}
                    projectStructure={projectStructure}
                    hmiPort={hmiPort}
                  />
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
                          availableBlocks={getAvailableBlocks()}
                          availablePrograms={projectStructure.programs.map(p => p.name)}
                          availableTasks={projectStructure.resources.find(r => r.type === 'RESOURCE_EDITOR')?.content.tasks?.map(t => t.name) || []}
                          globalVars={projectStructure.resources.find(r => r.type === 'RESOURCE_EDITOR')?.content.globalVars || []}
                          projectStructure={projectStructure}
                          currentId={activeItem.id}
                          libraryData={libraryData}
                          liveVariables={(isSimulationMode || isRunning) ? (liveVariables || {}) : null}
                          parentName={activeItem.name}
                          isRunning={isRunning}
                          isSimulationMode={isSimulationMode}
                          onForceWrite={isRunning ? handleForceWrite : null}
                          onAddToWatchTable={addToWatchTable}
                          hwPortVars={hwPortVars}
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

              {/* OUTPUT PANEL */}
              <div style={{ height: layout.consoleHeight, display: 'flex', flexDirection: 'column' }}>
                <OutputPanel
                  logs={logs}
                  watchTable={watchTable}
                  onWatchTableRemove={removeFromWatchTable}
                  onWatchTableUpdate={updateWatchTableEntry}
                  onForceWrite={isRunning ? handleForceWrite : null}
                  liveVariables={liveVariables}
                  isRunning={isRunning}
                  projectStructure={projectStructure}
                />
              </div>

            </div>

            {/* RIGHT SIDEBAR (Only if LD) */}
            {(activeItem?.type === 'LD' || activeItem?.type === 'ST' || activeItem?.type === 'SCL') && (
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
                      libraryData={libraryData}
                      activeFileType={activeItem?.type}
                      selectedBoard={selectedBoard}
                      buses={buses}
                      interfaceConfig={deviceInterfaceConfig}
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

      <BoardSelectionModal
        isOpen={isBoardModalOpen}
        onClose={() => {
          setIsBoardModalOpen(false);
          if (pendingNewProject) setPendingNewProject(false);
        }}
        currentBoard={selectedBoard}
        onSelect={handleBoardSelected}
      />

    </div>
  );
}

export default App;
