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
import BoardSelectionModal from './components/BoardSelectionModal';
import BoardConfigPage from './components/BoardConfigPage';
import { getBoardById } from './utils/boardDefinitions';
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
import { transpileToC } from './services/CTranspilerService';
import { PLCClient } from './services/PLCClient';
import { mkdir, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import PlcIcon from './assets/icons/plc-icon.png';
import './App.css';

function App() {
  const { t } = useTranslation();

  // Project Open State
  const [isProjectOpen, setIsProjectOpen] = useState(false);

  const [libraryData, setLibraryData] = useState([]);
  const [parsedBlocks, setParsedBlocks] = useState([]);

  // Load Library on Mount
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

  // Remote deployment state
  const [plcAddress, setPlcAddress] = useState(() => localStorage.getItem('plcAddress') || '');
  const [sshUser, setSshUser] = useState(() => localStorage.getItem('sshUser') || 'pi');
  const [sshPort, setSshPort] = useState(() => localStorage.getItem('sshPort') || '22');
  const [isDeployed, setIsDeployed] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
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

  // --- isDirty: mark dirty when project changes after deployment ---
  const projectStructureRef = React.useRef(projectStructure);
  useEffect(() => {
    // Skip the initial render and only trigger when projectStructure actually changes
    if (projectStructureRef.current !== projectStructure && isDeployed) {
      setIsDirty(true);
    }
    projectStructureRef.current = projectStructure;
  }, [projectStructure, isDeployed]);

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
    { type: 'info', msg: t('logs.systemInitialized') || 'System initialized.' },
    { type: 'info', msg: t('logs.systemReady') || 'Ready to map PLC project...' }
  ]);

  // Auto-scroll Console
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

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

  const handleSave = useCallback(async () => {
    if (!currentFilePath) {
      handleSaveAs();
      return;
    }

    try {
      const xmlContent = exportProjectToXml(projectStructure, selectedBoard, { plcAddress, sshUser, sshPort });
      await writeTextFile(currentFilePath, xmlContent);
      addLog('success', t('logs.projectSaved', { path: currentFilePath }) || `Project saved to ${currentFilePath} `);
    } catch (error) {
      addLog('error', t('logs.saveError', { error: error }) || `Save Error: ${error} `);
    }
  }, [currentFilePath, projectStructure, selectedBoard, plcAddress, sshUser, sshPort, addLog]);

  const handleSaveAs = useCallback(async () => {
    try {
      let filePath = await save({
        filters: []
      });
      if (!filePath) return;

      if (!filePath.toLowerCase().endsWith('.xml')) {
        filePath += '.xml';
      }

      const xmlContent = exportProjectToXml(projectStructure, selectedBoard, { plcAddress, sshUser, sshPort });
      await writeTextFile(filePath, xmlContent);

      setCurrentFilePath(filePath);
      addLog('success', t('logs.projectSaved', { path: filePath }) || `Project saved to ${filePath} `);
    } catch (error) {
      addLog('error', t('logs.saveAsError', { error: error }) || `Save As Error: ${error} `);
    }
  }, [projectStructure, selectedBoard, plcAddress, sshUser, sshPort, addLog]);

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
      setCurrentFilePath(null);
      setActiveId(null);
      const boardInfo = getBoardById(boardId);
      setLogs([
        { type: 'info', msg: t('logs.startedNewProject') || 'Started new project.' },
        { type: 'info', msg: `Board: ${boardInfo?.name || boardId}` }
      ]);
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
      setIsProjectOpen(false);
      setProjectStructure(defaultProjectStructure);
      setCurrentFilePath(null);
      setActiveId(null);
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

        setProjectStructure(newStructure);
        setCurrentFilePath(filePath);
        setActiveId(null);
        setIsProjectOpen(true);

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

  const handleBuild = async () => {
    const boardInfo = getBoardById(selectedBoard);
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
    if (!isPlcConnected || !plcAddress) {
      addLog('error', 'Cannot Build & Send: not connected to PLC server.');
      return;
    }
    const boardInfo = getBoardById(selectedBoard);
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
    addLog('info', t('logs.addedDataType', { name, type }) || `Added Data Type ${name} (${type})`);
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
      addLog('info', t('logs.updatedProperties', { name }) || `Updated properties for ${name}`);
      setCreateModal({ isOpen: false, category: '', defaultName: '', isEdit: false, editId: null, initialData: {}, insertIndex: null });
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
      const catItems = [...prev[category]];
      const insertAt = createModal.insertIndex;
      if (insertAt !== null && insertAt !== undefined && insertAt >= 0 && insertAt <= catItems.length) {
        catItems.splice(insertAt, 0, newItem);
      } else {
        catItems.push(newItem);
      }
      const nextStruct = {
        ...prev,
        [category]: catItems
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
    addLog('info', t('logs.addedItem', { name, type, category }) || `Added ${name} (${type}) to ${category}`);
    // Close modal handled by createModal state update below
    setCreateModal({ isOpen: false, category: '', defaultName: '', isEdit: false, editId: null, initialData: {}, insertIndex: null });
    return true;
  };

  const handleDeleteItem = (category, id) => {
    setProjectStructure(prev => ({
      ...prev,
      [category]: prev[category].filter(item => item.id !== id)
    }));
    if (activeId === id) setActiveId(null);
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

  // Hangi POU'nun hangi bloklara erişebileceğini tanım sırasına göre filtrele:
  // functions: yalnızca kendinden önceki functions + library
  // functionBlocks: tüm functions + kendinden önceki FBs + library
  // programs: hepsi
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
              onClick={() => setActiveId('SETTINGS')}
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
                onBoardClick={() => setActiveId('BOARD_CONFIG')}
                selectedBoard={selectedBoard}
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
              <div
                style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
                onMouseDown={() => window.getSelection()?.removeAllRanges()}
              >
                {activeId === 'SETTINGS' ? (
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
                    />
                  </ErrorBoundary>
                ) : activeId === 'BOARD_CONFIG' ? (
                  <ErrorBoundary>
                    <BoardConfigPage boardId={selectedBoard} />
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
                      selectedBoard={selectedBoard}
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
