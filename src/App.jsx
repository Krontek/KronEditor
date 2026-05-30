import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { lazy, Suspense } from 'react';
const EtherCATEditor = lazy(() => import('./components/EtherCATEditor'));
import SlaveConfigPage from './components/SlaveConfigPage';
import EditorPane from './components/EditorPane';
import Toolbox from './components/Toolbox';
import AiAgentPanel from './components/AiAgentPanel';
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
import {
  FolderIcon, ChevronDownIcon, InfoIcon, SettingsIcon, BuildIcon, UploadIcon,
  FlaskIcon, PlayIcon, StopIcon, RepeatIcon, OpenIcon, SaveIcon, SaveAsIcon, CloseIcon,
} from './components/ToolbarIcons';
import SaveConfirmDialog from './components/SaveConfirmDialog';
import VisualizationEditor from './components/visualization/VisualizationEditor';
import { getBoardById } from './utils/boardDefinitions';
import { getBoardFamilyDefine } from './utils/devicePortMapping';
import { buildHardwarePortVars } from './utils/hwPortVars';
import { getBoardLibraryTree } from './utils/boardLibraryBlocks';
import ArrayTypeEditor from './components/ArrayTypeEditor';
import StructureTypeEditor from './components/StructureTypeEditor';
import EnumTypeEditor from './components/EnumTypeEditor';
import { useTranslation } from 'react-i18next';
import { exportProjectToXml, importProjectFromXml } from './services/XmlService';
import { libraryService } from './services/LibraryService'; // Import Service
import { errorCodeService } from './services/ErrorCodeService';
import { loadAllEsiDevices, saveEsiFile } from './services/EsiLibraryService';
import { openFile, saveFile, ask, readTextFile, writeTextFile } from './services/browserFs';
import { transpileToC, validateProjectST } from './services/CTranspilerService';
import { PLCClient } from './services/PLCClient';
import { host } from './services/HostClient';
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
    errorCodeService.load().catch(err => console.warn('Error codes load failed:', err));
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
  const [apiPassword, setApiPassword] = useState('krontek');
  const [autoRun, setAutoRun] = useState(false);
  const [isDeployed, setIsDeployed] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const isDirtyRef = React.useRef(false);

  // Bumped when the AI agent commits changes to the currently-open POU, forcing
  // EditorPane to remount so it re-reads the mutated content (it seeds its local
  // state from initialContent only on mount).
  const [agentReloadKey, setAgentReloadKey] = useState(0);
  // Hot-swap (online change) session active — agent-approved edits go live.
  const [isHotSwap, setIsHotSwap] = useState(false);

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
  // Read isRunning / isSimulationMode via refs so the polling effect doesn't
  // tear down and rebuild every time they flip. The interval is created once
  // per (plcAddress, connectionEnabled) change.
  const isRunningRef = React.useRef(isRunning);
  const isSimulationModeRef = React.useRef(isSimulationMode);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { isSimulationModeRef.current = isSimulationMode; }, [isSimulationMode]);

  useEffect(() => {
    if (!plcAddress || !connectionEnabled) {
      setIsPlcConnected(false);
      return;
    }
    // Hysteresis: require 2 consecutive failures before flipping to "Disconnected".
    // Single-packet jitter / agent under load shouldn't blink the indicator.
    let consecutiveFailures = 0;
    const FAILURE_THRESHOLD = 2;
    const checkStatus = () => {
      host.checkServerStatus(plcAddress)
        .then((jsonStr) => {
          consecutiveFailures = 0;
          setIsPlcConnected(true);
          try {
            const status = JSON.parse(jsonStr);
            // If runtime is already running (e.g. AutoRun) and editor is not tracking it yet,
            // sync the running state so the editor shows it as running.
            if (status.running && !isRunningRef.current && !isSimulationModeRef.current) {
              if (!plcClientRef.current) {
                plcClientRef.current = new PLCClient(plcAddress);
              }
              setIsRunning(true);
              addLog('info', 'Runtime already running (AutoRun). Attaching stream...');
              if (remoteVarKeysRef.current.length > 0 && !plcClientRef.current.isStreaming) {
                stopStreamRef.current = plcClientRef.current.streamVars(
                  (vars) => { Object.assign(liveVarsRef.current, vars); liveVarsDirtyRef.current = true; },
                  (err) => addLog('error', `Stream error: ${err.message}`),
                );
              }
            } else if (!status.running && isRunningRef.current && !isSimulationModeRef.current) {
              // Runtime stopped externally (e.g. crash) — reflect in editor.
              setIsRunning(false);
              if (stopStreamRef.current) { stopStreamRef.current(); stopStreamRef.current = null; }
            }
          } catch (_) { /* ignore parse errors */ }
        })
        .catch(() => {
          // Don't mark disconnected while a stream is active (server is clearly alive)
          if (plcClientRef.current?.isStreaming) return;
          consecutiveFailures += 1;
          if (consecutiveFailures >= FAILURE_THRESHOLD) {
            setIsPlcConnected(false);
          }
        });
    };
    checkStatus();
    const interval = setInterval(checkStatus, 3000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // --- Window close: warn before unload if project has unsaved changes ---
  // Browser security disallows blocking unload to show a custom dialog
  // (the beforeunload event only supports the native browser prompt). The
  // save-confirm modal used to live in the Tauri onCloseRequested hook; we
  // surface it instead via a confirm prompt + native beforeunload guard.
  useEffect(() => {
    const handler = (event) => {
      if (!isProjectOpenRef.current) return;
      if (!hasUnsavedRef.current) return;
      event.preventDefault();
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

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

  const handleBusConfigChange = useCallback((busId, masterSettings) => {
    // Preserve slaves — EtherCATEditor only sends master settings now
    setBusConfigs(prev => ({
      ...prev,
      [busId]: { ...masterSettings, slaves: prev[busId]?.slaves || [] },
    }));
  }, []);

  /* ── Slave handlers ── */
  const handleAddSlave = useCallback((busId) => {
    const existingSlaves = busConfigs[busId]?.slaves || [];
    const id = `slave_${Date.now()}`;
    const newSlave = {
      id,
      position: existingSlaves.length + 1,
      name: `Slave_${existingSlaves.length + 1}`,
      vendorId: 0, productCode: 0, revision: 0,
      pdos: [], sdos: [],
    };
    setBusConfigs(prev => ({
      ...prev,
      [busId]: { ...(prev[busId] || {}), slaves: [...existingSlaves, newSlave] },
    }));
    setActiveId(id);
    openTab(id, newSlave.name, '🔌');
  }, [busConfigs]); // eslint-disable-line react-hooks/exhaustive-deps

  const [esiPickerBusId, setEsiPickerBusId] = useState(null);

  const handleAddSlaveFromLibrary = useCallback((busId) => {
    setEsiPickerBusId(busId);
  }, []);

  const handleEsiDevicePicked = useCallback((device) => {
    const busId = esiPickerBusId;
    if (!busId) return;
    setEsiPickerBusId(null);
    const existingSlaves = busConfigs[busId]?.slaves || [];
    const id = `slave_${Date.now()}`;
    const newSlave = {
      id,
      position: existingSlaves.length + 1,
      name: device.name,
      vendorId: device.vendorId,
      productCode: device.productCode,
      revision: device.revision,
      pdos: (device.allPdos || []).map(pdo => ({
        ...pdo,
        entries: (pdo.entries || []).map(e => ({ ...e, selected: false, varName: '' })),
      })),
      sdos: (device.sdos || []).map(s => ({ ...s })),
    };
    setBusConfigs(prev => ({
      ...prev,
      [busId]: { ...(prev[busId] || {}), slaves: [...existingSlaves, newSlave] },
    }));
    setActiveId(id);
    openTab(id, newSlave.name, '🔌');
  }, [busConfigs, esiPickerBusId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDeleteSlave = useCallback(async (busId, slaveId) => {
    const slave = (busConfigs[busId]?.slaves || []).find(s => s.id === slaveId);
    const confirmed = await ask(`"${slave?.name || 'Slave'}" silinsin mi?`, { title: 'Slave Sil', type: 'warning' });
    if (!confirmed) return;
    setBusConfigs(prev => ({
      ...prev,
      [busId]: { ...(prev[busId] || {}), slaves: (prev[busId]?.slaves || []).filter(s => s.id !== slaveId) },
    }));
    setOpenTabs(prev => prev.filter(t => t.id !== slaveId));
    if (activeId === slaveId) setActiveId(busId);
  }, [busConfigs, activeId]);

  const handleSelectSlave = useCallback((busId, slaveId) => {
    const slave = (busConfigs[busId]?.slaves || []).find(s => s.id === slaveId);
    setActiveId(slaveId);
    openTab(slaveId, slave?.name || 'Slave', '🔌');
  }, [busConfigs]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpdateSlave = useCallback((busId, slaveId, updatedSlave) => {
    // Sync AXIS_REF to global variables automatically
    const oldSlave = busConfigs[busId]?.slaves?.find(s => s.id === slaveId);
    const oldAxis  = oldSlave?.axisRef;
    const newAxis  = updatedSlave.axisRef;

    if (newAxis?.enabled) {
      const cleanName = (n) => (n || '').replace(/[^A-Za-z0-9_]/g, '_') || 'Axis_1';
      const newName = cleanName(newAxis.name || `Axis_${updatedSlave.position || 1}`);
      const oldName = oldAxis?.enabled
        ? cleanName(oldAxis.name || `Axis_${oldSlave.position || 1}`)
        : null;

      setProjectStructure(prev => {
        const res = prev.resources.find(r => r.type === 'RESOURCE_EDITOR');
        if (!res) return prev;
        const vars = res.content.globalVars || [];

        let newVars;
        if (oldName && oldName !== newName) {
          // Axis renamed → rename the existing AXIS_REF global var
          newVars = vars.map(v =>
            v.name === oldName && v.type === 'AXIS_REF' ? { ...v, name: newName } : v
          );
        } else if (!vars.some(v => v.name === newName && v.type === 'AXIS_REF')) {
          // Axis newly enabled → add global var
          newVars = [...vars, {
            id: `gv_axis_${Date.now()}`,
            name: newName,
            type: 'AXIS_REF',
            initialValue: '',
            comment: `Axis for ${updatedSlave.name || 'slave'}`,
          }];
        } else {
          newVars = vars;
        }

        return {
          ...prev,
          resources: prev.resources.map(r =>
            r.type === 'RESOURCE_EDITOR'
              ? { ...r, content: { ...r.content, globalVars: newVars } }
              : r
          ),
        };
      });
    }

    setBusConfigs(prev => ({
      ...prev,
      [busId]: {
        ...(prev[busId] || {}),
        slaves: (prev[busId]?.slaves || []).map(s => s.id === slaveId ? updatedSlave : s),
      },
    }));
    // Keep tab label in sync with slave name
    setOpenTabs(prev => prev.map(t => t.id === slaveId ? { ...t, label: updatedSlave.name || 'Slave' } : t));
  }, [busConfigs]);

  // Find which bus + slave the current activeId belongs to
  const activeSlave = useMemo(() => {
    for (const bus of buses) {
      const slaves = busConfigs[bus.id]?.slaves || [];
      const slave = slaves.find(s => s.id === activeId);
      if (slave) return { busId: bus.id, slave };
    }
    return null;
  }, [activeId, buses, busConfigs]);

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
  const [rightTab, setRightTab] = useState('blocks'); // 'blocks' | 'agent' — right sidebar tabs

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

  // --- Host-agent event stream (build-command, simulation-compile-log, …) ---
  useEffect(() => {
    const stop = host.streamEvents((msg) => {
      if (!msg || !msg.topic) return;
      if (msg.topic === 'simulation-compile-log') {
        addLog('info', typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data));
      } else if (msg.topic === 'build-command') {
        addLog('info', `Build command: ${typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data)}`);
      } else if (msg.topic === 'library-update-progress' || msg.topic === 'server-update-progress') {
        addLog('info', String(msg.data));
      }
    });
    return () => stop();
  }, [addLog]);

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
    const stop = host.streamEvents((msg) => {
      if (!msg || msg.topic !== 'simulation-output') return;
      try {
        const parsed = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        if (parsed.vars) {
          Object.assign(liveVarsRef.current, parsed.vars);
          liveVarsDirtyRef.current = true;
        } else if (parsed.status === 'exited' || parsed.status === 'crashed') {
          setIsRunning(false);
          addLog('warning', t('logs.simulationStatus', { status: parsed.status }) || `Simulation ${parsed.status}.`);
        } else if (parsed.error) {
          addLog('error', t('logs.simulationError', { error: parsed.error }) || `Simulation: ${parsed.error}`);
        }
      } catch (e) {
        console.error('Failed to parse simulation output:', e, msg);
      }
    });
    return () => stop();
  }, [addLog, t]);

  // --- File Operations ---

  const handleSaveAs = useCallback(async () => {
    try {
      const xmlContent = exportProjectToXml(projectStructure, selectedBoard, { plcAddress, sshUser, sshPort, apiPassword, autoRun }, buses, busConfigs, watchTable, hmiLayout);
      const suggestedName = (currentFilePath || 'project.xml').split('/').pop() || 'project.xml';
      const savedName = await saveFile({ suggestedName, content: xmlContent });
      if (!savedName) return;

      hasUnsavedRef.current = false;
      setCurrentFilePath(savedName);
      addLog('success', t('logs.projectSaved', { path: savedName }) || `Project saved to ${savedName} `);
    } catch (error) {
      addLog('error', t('logs.saveAsError', { error: error }) || `Save As Error: ${error} `);
    }
  }, [projectStructure, selectedBoard, plcAddress, sshUser, sshPort, apiPassword, autoRun, buses, busConfigs, watchTable, hmiLayout, currentFilePath, addLog, t]);

  const handleSave = useCallback(async () => {
    // In browser there is no in-place path write — every save goes through the
    // file picker / download path. Forward to handleSaveAs for both first and
    // subsequent saves.
    await handleSaveAs();
  }, [handleSaveAs]);

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
    try {
      const picked = await openFile({ accept: '.xml' });
      if (!picked) return;
      processFileContent(picked.content, picked.path);
    } catch (error) {
      console.error(error);
      addLog('error', t('logs.openError', { error: error }) || `Open Error: ${error} `);
    }
  };

  // Pull the running project back from the connected target device. The pulled
  // project replaces the current one in the editor and is loaded WITHOUT a file
  // path, so the next Save acts as Save As (user must choose where to store it).
  const handlePullFromTarget = async () => {
    setIsProjectDropdownOpen(false);
    if (!isPlcConnected || !plcAddress) {
      addLog('error', t('logs.pullNotConnected') || 'Cannot pull: not connected to PLC server.');
      return;
    }
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('actions.pullConfirm') || 'The current project will be closed and replaced by the one on the target. Continue?')) {
      return;
    }
    try {
      addLog('info', t('logs.pulling', { addr: plcAddress }) || `Pulling project from ${plcAddress}...`);
      const resp = await fetch(`http://${plcAddress}/deploy/project-file`);
      if (!resp.ok) {
        if (resp.status === 404) {
          addLog('error', t('logs.pullNotFound') || 'No project file found on target (deploy a project first).');
        } else {
          addLog('error', `Pull failed: ${resp.status} ${resp.statusText}`);
        }
        return;
      }
      const xml = await resp.text();
      // Load with a display label, then clear the path so Save → Save As.
      processFileContent(xml, `${plcAddress} (target)`);
      setCurrentFilePath(null);
      addLog('success', t('logs.pulled', { addr: plcAddress }) || `Project pulled from ${plcAddress}.`);
    } catch (err) {
      addLog('error', `Pull failed: ${err.message || err}`);
    }
  };

  const processFileContent = (content, filePath) => {
    try {
      const result = importProjectFromXml(content);
      if (result) {
        const { projectStructure: newStructure, boardId, plcAddress: savedAddr, sshUser: savedSshUser, sshPort: savedSshPort, apiPassword: savedApiPassword, autoRun: savedAutoRun } = result;
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
        setApiPassword(savedApiPassword || 'krontek');
        if (savedAutoRun !== undefined) {
          setAutoRun(savedAutoRun);
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
        const standardHeaders = await host.getStandardHeaders().catch(() => []);
        const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, true, buses, busConfigs);
        const writeRes = await host.writePlcFiles({
          header: cCode.header,
          source: cCode.source,
          variableTable: JSON.stringify(cCode.variableTable, null, 2),
          hal: cCode.hal || ''
        });
        const outPath = writeRes.buildDir;
        addLog('success', t('logs.transpiledSaved', { path: outPath }) || `Transpiled C header and source successfully saved to ${outPath}`);

        addLog('info', t('logs.compilingSimulation') || 'Compiling simulation executable...');
        const exePath = await host.compileSimulation();
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
        await host.runSimulation();
      } catch (err) {
        addLog('error', `Failed to start simulation: ${err.message || err}`);
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
        addLog('info', `HMI available at http://${plcAddress}/hmi/`);
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
          await host.stopSimulation();
        } catch (err) {
          addLog('error', `Failed to stop simulation: ${err.message || err}`);
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
          host.checkServerStatus(plcAddress)
            .then(() => setIsPlcConnected(true))
            .catch(() => setIsPlcConnected(false));
        }
      }

      addLog('info', 'Execution Stopped.');
      if (isSimulationMode) {
        host.stopHmiServer().catch(() => {});
      }
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
        await host.writeVariable(key, value);
      } catch (err) {
        addLog('error', `Force write failed for '${key}': ${err.message || err}`);
      }
    }
  }, [isRunning, isSimulationMode, addLog]);

  // Auto-start/stop local HMI server when simulation runs
  useEffect(() => {
    if (!isRunning || !isSimulationMode) return;
    const layoutJson = JSON.stringify(hmiLayout);
    host.startHmiServer(hmiPort, layoutJson)
      .then(() => addLog('info', `HMI available at http://localhost:${hmiPort}/hmi/`))
      .catch((e) => addLog('warning', `HMI server failed to start: ${e.message || e}`));
    return () => { host.stopHmiServer().catch(() => {}); };
  }, [isRunning, isSimulationMode]); // eslint-disable-line

  // Push live variables to local HMI server during simulation
  useEffect(() => {
    if (!isRunning || !isSimulationMode || !liveVariables) return;
    host.pushHmiVariables(JSON.stringify(liveVariables)).catch(() => {});
  }, [isRunning, isSimulationMode, liveVariables]);

  // Poll HMI write requests from local server during simulation
  useEffect(() => {
    if (!isRunning || !isSimulationMode) return;
    const interval = setInterval(async () => {
      try {
        const writes = await host.pollHmiWrites();
        if (Array.isArray(writes)) {
          writes.forEach((w) => handleForceWrite(w.key, w.value));
        }
      } catch (_) {}
    }, 200);
    return () => clearInterval(interval);
  }, [isRunning, isSimulationMode, handleForceWrite]);

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
    const stErrors = validateProjectST(projectStructure, [], hwPortVars);
    if (stErrors.length > 0) {
      stErrors.forEach(e => addLog('error', `[${e.context}] Line ${e.line}:${e.column} — Undefined identifier: '${e.word}'`));
      addLog('error', `Build aborted: ${stErrors.length} ST validation error(s). Fix before building.`);
      return;
    }
    const boardInfo = getBoardById(selectedBoard);
    checkBaremetalConcurrency();
    addLog('info', `Build started for board: ${boardInfo?.name || selectedBoard}...`);
    try {
      const standardHeaders = await host.getStandardHeaders().catch(() => []);
      const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, true, buses, busConfigs);
      await host.writePlcFiles({
        header: cCode.header,
        source: cCode.source,
        variableTable: JSON.stringify(cCode.variableTable, null, 2),
        hal: cCode.hal || ''
      });
      await host.compileSimulation();
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
    const stErrors = validateProjectST(projectStructure, [], hwPortVars);
    if (stErrors.length > 0) {
      stErrors.forEach(e => addLog('error', `[${e.context}] Line ${e.line}:${e.column} — Undefined identifier: '${e.word}'`));
      addLog('error', `Build aborted: ${stErrors.length} ST validation error(s). Fix before building.`);
      return;
    }
    const boardInfo = getBoardById(selectedBoard);
    checkBaremetalConcurrency();
    addLog('info', `Build & Send for ${boardInfo?.name || selectedBoard}...`);
    try {
      const standardHeaders = await host.getStandardHeaders().catch(() => []);
      const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, false, buses, busConfigs);

      // Inject API password hash into variable table
      if (apiPassword) {
        const saltBytes = crypto.getRandomValues(new Uint8Array(16));
        const saltHex = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        const data = new TextEncoder().encode(saltHex + ':' + apiPassword);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        cCode.variableTable.api_password_hash = hashHex;
        cCode.variableTable.api_password_salt = saltHex;
      }

      addLog('info', 'Cross-compiling for target...');
      await host.compileForTarget({
        header: cCode.header,
        source: cCode.source,
        variableTable: JSON.stringify(cCode.variableTable, null, 2),
        hal: cCode.hal || '',
        boardId: selectedBoard,
      });
      addLog('success', 'Cross-compilation successful.');

      addLog('info', `Deploying to ${plcAddress}...`);
      await host.deployToServer(plcAddress);
      addLog('success', `Deployed to ${plcAddress}.`);

      // Send the project source file so it can be pulled back later
      // ("Pull from Target"). A failure here fails the whole Build & Send.
      addLog('info', 'Sending project file...');
      const projectXml = exportProjectToXml(projectStructure, selectedBoard, { plcAddress, sshUser, sshPort, apiPassword, autoRun }, buses, busConfigs, watchTable, hmiLayout);
      const projResp = await fetch(`http://${plcAddress}/deploy/project-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: projectXml,
      });
      if (!projResp.ok) {
        throw new Error(`project file deploy failed: ${projResp.status} ${projResp.statusText}`);
      }
      addLog('success', 'Project file sent.');

      // Deploy HMI layout (JSON). Empty pages → server clears HMI, serves nothing.
      const hasHmiPages = (hmiLayout?.pages?.length ?? 0) > 0;
      const hmiPayload = hasHmiPages ? JSON.stringify(hmiLayout) : '{}';
      // HMI broadcast port (served at the root on a dedicated listener). When
      // there are no HMI pages we push 0 to tear down any existing listener.
      const hmiPort = hasHmiPages ? (Number(hmiLayout?.port) || 8080) : 0;
      const plcHost = String(plcAddress).replace(/:\d+$/, '');
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
            addLog('info', `HMI deployed: ${result.pages ?? '?'} page(s). Access at http://${plcHost}:${hmiPort}/`);
          }
        }
      } catch (hmiErr) {
        addLog('warning', `HMI layout deploy skipped: ${hmiErr.message}`);
      }

      // Deploy autorun + HMI port config
      try {
        await fetch(`http://${plcAddress}/deploy/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ auto_run: autoRun, hmi_port: hmiPort }),
        });
      } catch (cfgErr) {
        addLog('warning', `Runtime config deploy skipped: ${cfgErr.message}`);
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
    // NOTE: no trailing space — POU names must be valid IEC identifiers. A space
    // here used to leak into names like "Program0 ", breaking the C symbol
    // mapping and POU lookups (agent + editor reload).
    while (existingNames.includes(`${prefix}${counter}`)) {
      counter++;
    }
    const defaultName = `${prefix}${counter}`;

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

  const handleCreateConfirm = (rawName, type, returnType) => {
    const category = createModal.category;
    // POU/data-type names must be valid IEC identifiers — trim and collapse any
    // stray whitespace so names like "Program0 " never reach the project (they
    // break the C symbol mapping and POU lookups).
    const name = String(rawName || '').trim().replace(/\s+/g, '_');

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

  // Paste a sidebar item (deep-copied) at a given index within a category.
  // When the payload carries a `_globalsBundle` (POU copied from another
  // editor instance), merge any missing globals into the resources table
  // so the pasted POU keeps compiling against the expected symbols.
  const handlePasteItem = (category, newItem, insertIndex) => {
    // Ensure unique name
    const existingNames = new Set(projectStructure[category].map(i => i.name));
    let name = newItem.name;
    let counter = 1;
    while (existingNames.has(name)) {
      name = `${newItem.name.replace(/_copy\d*$/, '')}_copy${counter}`;
      counter++;
    }
    const { _globalsBundle, ...rest } = newItem;
    const item = { ...rest, name };
    const mergedGlobalNames = [];
    setProjectStructure(prev => {
      const items = [...prev[category]];
      if (insertIndex !== null && insertIndex !== undefined && insertIndex >= 0 && insertIndex <= items.length) {
        items.splice(insertIndex, 0, item);
      } else {
        items.push(item);
      }
      const next = { ...prev, [category]: items };

      if (Array.isArray(_globalsBundle) && _globalsBundle.length > 0) {
        const resources = (prev.resources || []).map(r => {
          if (r.type !== 'RESOURCE_EDITOR') return r;
          const existing = r.content?.globalVars || [];
          const existingByName = new Map(existing.map(v => [v.name, v]));
          const toAdd = [];
          _globalsBundle.forEach(g => {
            if (!g || !g.name) return;
            const match = existingByName.get(g.name);
            // Only add when missing. When a global with the same name
            // already exists we keep the destination project's copy,
            // even if the type differs, to avoid silently overwriting.
            if (!match) {
              toAdd.push({ ...g, id: `var_${Date.now()}_${Math.random()}` });
              mergedGlobalNames.push(g.name);
            }
          });
          if (!toAdd.length) return r;
          return { ...r, content: { ...r.content, globalVars: [...existing, ...toAdd] } };
        });
        next.resources = resources;
      }
      return next;
    });
    setActiveId(item.id);
    openTab(item.id, item.name, getItemIcon(category, item.type));
    const logMsg = mergedGlobalNames.length
      ? `Pasted ${category} item: ${item.name} (merged globals: ${mergedGlobalNames.join(', ')})`
      : `Pasted ${category} item: ${item.name}`;
    addLog('info', logMsg);
  };

  // Paste a whole global-variable set (copied from the sidebar "Global
  // Variables" node, possibly in another project). Merges by name: globals
  // whose name already exists are skipped (destination copy is kept), the
  // rest are added. Addresses are dropped — they are hardware-unique and the
  // user re-assigns them, matching the variable-table paste convention.
  const handlePasteGlobals = (list) => {
    if (!Array.isArray(list) || list.length === 0) return;
    const added = [];
    const skipped = [];
    setProjectStructure(prev => {
      const resources = (prev.resources || []).map(r => {
        if (r.type !== 'RESOURCE_EDITOR') return r;
        const existing = r.content?.globalVars || [];
        const existingNames = new Set(existing.map(v => v.name));
        const toAdd = [];
        list.forEach((g, i) => {
          if (!g || !g.name) return;
          if (existingNames.has(g.name)) { skipped.push(g.name); return; }
          existingNames.add(g.name);
          toAdd.push({ ...g, id: `var_${Date.now()}_${Math.random()}_${i}`, address: '' });
          added.push(g.name);
        });
        if (!toAdd.length) return r;
        return { ...r, content: { ...r.content, globalVars: [...existing, ...toAdd] } };
      });
      return { ...prev, resources };
    });
    if (added.length) {
      addLog('info', `Pasted ${added.length} global variable(s): ${added.join(', ')}`);
    }
    if (skipped.length) {
      addLog('warning', `Skipped ${skipped.length} global(s) already present: ${skipped.join(', ')}`);
    }
    if (!added.length && !skipped.length) {
      addLog('warning', 'No global variables to paste.');
    }
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

  const boardBlocks = useMemo(() => {
    if (!selectedBoard) return [];
    const COMM_PROTO_BLOCKS = {
      UART: ['UART_Send', 'UART_Receive'],
      I2C:  ['I2C_WriteRead'],
      SPI:  ['SPI_Transfer'],
      USB:  ['USB_Send', 'USB_Receive'],
    };
    const out = [];
    for (const sub of getBoardLibraryTree(selectedBoard)) {
      for (const item of (sub.items || [])) {
        if (!item?.blockType) continue;
        out.push({ name: item.blockType, category: `Hardware / ${sub.title}` });
      }
    }
    for (const proto of ['UART', 'I2C', 'SPI', 'USB']) {
      const ports = deviceInterfaceConfig[proto];
      if (!ports || !Object.values(ports).some(p => p?.enabled)) continue;
      for (const blockType of COMM_PROTO_BLOCKS[proto]) {
        out.push({ name: blockType, category: `Hardware / ${proto}` });
      }
    }
    const seen = new Set();
    return out.filter(b => {
      if (seen.has(b.name)) return false;
      seen.add(b.name);
      return true;
    });
  }, [selectedBoard, deviceInterfaceConfig]);

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

  // The AI agent committed changes (it already called setProjectStructure with
  // the new structure). If it touched the open POU, remount the editor so it
  // reflects the new code/variables; always log it.
  const handleAgentApplied = useCallback((pouNames) => {
    const names = pouNames || [];
    const norm = (n) => (n || '').trim().toLowerCase();   // tolerate stray spaces in names
    if (activeItem && names.some(n => norm(n) === norm(activeItem.name))) {
      setAgentReloadKey(k => k + 1);
    }
    addLog('info', `AI agent applied changes: ${names.length ? names.join(', ') : 'project structure'}`);
  }, [activeItem, addLog]);

  // ── Hot-swap (online change) session ──────────────────────────────────────
  // When a live session is running, an agent-approved code change is pushed to
  // the running PLC without a restart (state preserved). Live values keep
  // flowing on the existing simulation-output SSE (the host-agent's SHM poller).
  const hotSwapActiveRef = React.useRef(false);

  // "Go live": if connected to a remote PLC, deploy a hot-swap-capable runtime
  // (loader-host + logic_0.so) to the field; otherwise start a LOCAL sim
  // hot-swap session. Either way, agent-approved edits then apply online.
  const startHotSwapSession = useCallback(async () => {
    const standardHeaders = await host.getStandardHeaders().catch(() => []);
    if (isPlcConnected && plcAddress) {
      addLog('info', 'Deploying hot-swap runtime to target…');
      const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, false, buses, busConfigs);
      await host.hotswapTargetBuild({
        header: cCode.header, source: cCode.source,
        variableTable: JSON.stringify(cCode.variableTable, null, 2), hal: cCode.hal || '',
        hostGlue: cCode.hostGlue || '', boardId: selectedBoard,
      });
      await host.deployToServer(plcAddress); // runtime.bin(host) + variable-table + logic_0.so
      hotSwapActiveRef.current = false;       // field mode (not local sim)
      setIsHotSwap(true);
      addLog('success', 'Field hot-swap runtime deployed — online change enabled on the target.');
    } else {
      const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, true, buses, busConfigs);
      await host.hotswapBuild({
        header: cCode.header, source: cCode.source,
        variableTable: JSON.stringify(cCode.variableTable, null, 2), hal: cCode.hal || '',
        hostGlue: cCode.hostGlue || '',
      });
      await host.hotswapRun();
      hotSwapActiveRef.current = true;
      setIsHotSwap(true);
      setIsSimulationMode(true);
      setIsRunning(true);
      addLog('success', 'Hot-swap session started (simulation) — online change enabled.');
    }
  }, [projectStructure, selectedBoard, buses, busConfigs, isPlcConnected, plcAddress, addLog]);

  const stopHotSwapSession = useCallback(async () => {
    if (hotSwapActiveRef.current) { try { await host.hotswapStop(); } catch { /* ignore */ } setIsRunning(false); }
    hotSwapActiveRef.current = false;
    setIsHotSwap(false);
    addLog('info', 'Hot-swap session stopped.');
  }, [addLog]);

  // Agent approved a code change while a hot-swap session is active → push it as
  // an online change (no restart, state preserved). Sim → local swap; field →
  // recompile logic.so for the target, upload to KronServer, swap. A
  // layout-changing edit can't be swapped (the runtime rolls back / errors —
  // surface it; the user should redeploy). Field swaps confirm first (live HW).
  const handleAgentHotSwap = useCallback(async (touchedPous) => {
    const what = (touchedPous || []).join(', ') || 'logic';
    const standardHeaders = await host.getStandardHeaders().catch(() => []);
    try {
      if (hotSwapActiveRef.current) {
        const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, true, buses, busConfigs);
        await host.hotswapSwap({ header: cCode.header, source: cCode.source });
        addLog('success', `Online change applied (sim): ${what}`);
      } else if (isHotSwap && isPlcConnected && plcAddress) {
        if (!window.confirm(`Apply this change to the RUNNING PLC at ${plcAddress} now (online change)?\n\n${what}`)) {
          addLog('info', 'Online change to target cancelled.');
          return;
        }
        const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, false, buses, busConfigs);
        await host.hotswapTargetLogic({ header: cCode.header, source: cCode.source, boardId: selectedBoard });
        await host.hotswapDeploySwap(plcAddress);
        addLog('success', `Online change applied to target: ${what}`);
      }
    } catch (e) {
      addLog('error', `Hot-swap apply failed (a layout change needs a full redeploy): ${e.message || e}`);
    }
  }, [projectStructure, selectedBoard, buses, busConfigs, isHotSwap, isPlcConnected, plcAddress, addLog]);

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
    if (!activeItem) return [...projectStructure.functionBlocks, ...projectStructure.functions, ...parsedBlocks, ...boardBlocks];
    const cat = activeItem.category;
    if (cat === 'functions') {
      const idx = projectStructure.functions.findIndex(f => f.id === activeItem.id);
      const prevFunctions = idx >= 0 ? projectStructure.functions.slice(0, idx) : projectStructure.functions;
      return [...prevFunctions, ...parsedBlocks, ...boardBlocks];
    } else if (cat === 'functionBlocks') {
      const idx = projectStructure.functionBlocks.findIndex(fb => fb.id === activeItem.id);
      const prevFBs = idx >= 0 ? projectStructure.functionBlocks.slice(0, idx) : projectStructure.functionBlocks;
      return [...prevFBs, ...projectStructure.functions, ...parsedBlocks, ...boardBlocks];
    }
    // programs and others: all
    return [...projectStructure.functionBlocks, ...projectStructure.functions, ...parsedBlocks, ...boardBlocks];
  };

  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      height: '100vh', 
      width: '100vw', 
      background: '#1e1e1e', 
      overflow: 'hidden', 
      boxSizing: 'border-box', 
      border: '1px solid rgba(255, 255, 255, 0.1)', 
      borderRadius: '8px',
      boxShadow: '0 0 10px rgba(0, 0, 0, 0.5)'
    }}>
      <SaveConfirmDialog
        isOpen={saveConfirmOpen}
        onSave={handleSaveConfirmSave}
        onDiscard={handleSaveConfirmDiscard}
        onCancel={handleSaveConfirmCancel}
      />

      {/* Browser-only title bar — the custom titlebar (with min/max/close
          buttons) was Tauri-specific. In browser mode the OS browser chrome
          owns window controls, so we render a slim header strip with only the
          app name. */}
      <div className="custom-titlebar">
        <div className="titlebar-title">
          <img src={PlcIcon} alt="Logo" style={{ height: '18px', marginRight: '8px', pointerEvents: 'none' }} />
          <span>KronEditor</span>
        </div>
      </div>

      {/* 1. HEADER / TOOLBAR */}
      <div className="header app-toolbar">
        {isProjectOpen && (
          <>
            {/* ── Group: File ──────────────────────────────────────────── */}
            <div className="dropdown">
              <button
                className="tb-btn tb-text"
                onClick={() => setIsProjectDropdownOpen(!isProjectDropdownOpen)}
                onBlur={() => setTimeout(() => setIsProjectDropdownOpen(false), 200)}
                title={t('common.project') || 'Project'}
              >
                <FolderIcon />
                <span>{t('common.project') || 'Project'}</span>
                <ChevronDownIcon width={12} height={12} />
              </button>
              {isProjectDropdownOpen && (
                <div className="dropdown-content">
                  <div className="dropdown-item" onClick={handleOpen}>
                    <OpenIcon /> {t('common.open') || 'Open'}
                  </div>
                  <div className="dropdown-item" onClick={handleSave}>
                    <SaveIcon /> {t('common.save')}
                  </div>
                  <div className="dropdown-item" onClick={handleSaveAs}>
                    <SaveAsIcon /> {t('common.saveAs') || 'Save As'}
                  </div>
                  <div className="dropdown-sep" />
                  <div
                    className={`dropdown-item ${isPlcConnected ? '' : 'dropdown-item-disabled'}`}
                    onClick={isPlcConnected ? handlePullFromTarget : undefined}
                    title={isPlcConnected ? '' : 'Connect to a PLC server to pull its project'}
                  >
                    <OpenIcon /> {t('actions.pullFromTarget') || 'Pull from Target'}
                  </div>
                  <div className="dropdown-sep" />
                  <div className="dropdown-item dropdown-item-warn" onClick={handleCloseProject}>
                    <CloseIcon /> {t('actions.closeProject') || 'Close Project'}
                  </div>
                </div>
              )}
            </div>

            <div className="tb-divider" />

            {/* ── Group: App-level ────────────────────────────────────── */}
            <button
              className="tb-btn tb-icon"
              onClick={() => setShortcutsModalOpen(true)}
              title={t('common.shortcuts') || 'Shortcuts'}
            >
              <InfoIcon />
            </button>
            <button
              className="tb-btn tb-icon"
              onClick={() => openSpecialTab('SETTINGS')}
              title={t('common.settings')}
            >
              <SettingsIcon />
            </button>

            <div className="tb-divider" />

            {/* ── Group: Build ─────────────────────────────────────────── */}
            <button
              className="tb-btn tb-text tb-primary"
              onClick={isPlcConnected ? handleBuildAndSend : handleBuild}
              disabled={isRunning}
              title={isPlcConnected ? 'Build & Send to PLC' : (t('actions.build') || 'Build')}
            >
              {isPlcConnected ? <UploadIcon /> : <BuildIcon />}
              <span>{isPlcConnected ? 'Build & Send' : (t('actions.build') || 'Build')}</span>
            </button>

            <div className="tb-divider" />

            {/* ── Group: Run ───────────────────────────────────────────── */}
            <button
              className={`tb-btn tb-text ${isSimulationMode ? 'tb-toggle-on' : 'tb-toggle-off'}`}
              onClick={handleToggleSimulation}
              disabled={isRunning}
              title="Toggle Simulation Mode"
            >
              <FlaskIcon />
              <span>Simulation</span>
              <span className={`tb-pill ${isSimulationMode ? 'on' : ''}`}>
                {isSimulationMode ? 'ON' : 'OFF'}
              </span>
            </button>
            <button
              className="tb-btn tb-icon tb-run"
              onClick={handleStartExecution}
              disabled={isRunning || (!isSimulationMode && !(isDeployed && !isDirty && isPlcConnected))}
              title={t('actions.start') || 'Start'}
            >
              <PlayIcon />
            </button>
            <button
              className="tb-btn tb-icon tb-stop"
              onClick={handleStopExecution}
              disabled={!isRunning}
              title={t('actions.stop') || 'Stop'}
            >
              <StopIcon />
            </button>

            {/* ── Right-aligned group: status ──────────────────────────── */}
            <div style={{ flex: 1 }} />

            <button
              className={`tb-btn tb-text ${autoRun ? 'tb-toggle-on' : 'tb-toggle-off'}`}
              onClick={() => setAutoRun(!autoRun)}
              title="AutoRun: automatically start runtime on PLC boot"
            >
              <RepeatIcon />
              <span>AutoRun</span>
              <span className={`tb-pill ${autoRun ? 'on' : ''}`}>
                {autoRun ? 'ON' : 'OFF'}
              </span>
            </button>

            {plcAddress && (
              <button
                className="tb-conn"
                onClick={() => {
                  if (isRunning) return;
                  if (isPlcConnected) {
                    setConnectionEnabled(false);
                    setIsPlcConnected(false);
                  } else {
                    setConnectionEnabled(true);
                  }
                }}
                disabled={isRunning}
                title={isRunning ? 'Stop execution before disconnecting' : isPlcConnected ? 'Click to disconnect' : 'Click to connect'}
              >
                <span className={`tb-conn-dot ${isPlcConnected ? 'on' : ''}`} />
                <span>{isPlcConnected ? 'Connected' : 'Disconnected'}</span>
                {isDeployed && !isDirty && <span className="tb-tag tb-tag-ok">Deployed</span>}
                {isDeployed && isDirty && <span className="tb-tag tb-tag-warn">Modified</span>}
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
                onPasteGlobals={handlePasteGlobals}
                onBoardClick={() => openSpecialTab('BOARD_CONFIG')}
                selectedBoard={selectedBoard}
                isRunning={isRunning || isSimulationMode}
                liveVariables={isRunning ? liveVariables : null}
                buses={buses}
                onAddBus={handleAddBus}
                onDeleteBus={handleDeleteBus}
                onSelectBus={handleSelectBus}
                busConfigs={busConfigs}
                onAddSlave={handleAddSlave}
                onAddSlaveFromLibrary={esiLibrary.length > 0 ? handleAddSlaveFromLibrary : undefined}
                onDeleteSlave={handleDeleteSlave}
                onSelectSlave={handleSelectSlave}
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
                {activeSlave ? (
                  <SlaveConfigPage
                    key={activeSlave.slave.id}
                    slave={activeSlave.slave}
                    onChange={(updated) => handleUpdateSlave(activeSlave.busId, activeSlave.slave.id, updated)}
                    onAddGlobalVars={handleAddGlobalVarsFromBus}
                    isRunning={isRunning || isSimulationMode}
                    esiLibrary={esiLibrary}
                  />
                ) : buses.some(b => b.id === activeId && b.type === 'ethercat') ? (
                  <ErrorBoundary>
                    <Suspense fallback={<div style={{ padding: 20, color: '#888' }}>Loading EtherCAT editor...</div>}>
                      <EtherCATEditor
                        busConfig={busConfigs[activeId]}
                        onChange={(cfg) => handleBusConfigChange(activeId, cfg)}
                        isRunning={isRunning || isSimulationMode}
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
                      apiPassword={apiPassword}
                      setApiPassword={setApiPassword}
                      isPlcConnected={isPlcConnected}
                      setConnectionEnabled={setConnectionEnabled}
                      esiLibrary={esiLibrary}
                      onLoadEsiFile={handleLoadEsiFile}
                      projectStructure={projectStructure}
                      buses={buses}
                      busConfigs={busConfigs}
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
                    projectStructure={projectStructure}
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
                          key={`${activeItem.id}_${agentReloadKey}`}
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
                          errorCodeService={errorCodeService}
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
                  onClearLogs={(tab) => {
                    if (tab === 'messages') setLogs(prev => prev.filter(l => l.type !== 'info' && l.type !== 'success'));
                    else if (tab === 'warnings') setLogs(prev => prev.filter(l => l.type !== 'warning'));
                    else if (tab === 'errors') setLogs(prev => prev.filter(l => l.type !== 'error'));
                  }}
                  watchTable={watchTable}
                  onWatchTableAdd={addToWatchTable}
                  onWatchTableRemove={removeFromWatchTable}
                  onWatchTableUpdate={updateWatchTableEntry}
                  onForceWrite={isRunning ? handleForceWrite : null}
                  liveVariables={liveVariables}
                  isRunning={isRunning}
                  projectStructure={projectStructure}
                  errorCodeService={errorCodeService}
                />
              </div>

            </div>

            {/* RIGHT SIDEBAR — always present (Kütüphane + AI Agent are always available) */}
            <>
                {/* RESIZER (RIGHT) */}
                <div
                  onMouseDown={() => startResizing('right')}
                  style={{ width: 5, cursor: 'col-resize', background: isResizing === 'right' ? '#007acc' : '#1e1e1e', zIndex: 10, flexShrink: 0, borderLeft: '1px solid #333' }}
                />

                <div style={{ width: layout.rightWidth, display: 'flex', flexDirection: 'column', background: '#252526', borderLeft: '1px solid #333' }}>
                  {/* Tab strip: Kütüphane (blocks) | AI Agent */}
                  <div style={{ display: 'flex', background: '#2d2d2d', borderBottom: '1px solid #1e1e1e', flexShrink: 0, height: 32 }}>
                    {[
                      { id: 'blocks', label: 'Kütüphane', icon: '📦' },
                      { id: 'agent', label: 'AI Agent', icon: '🤖' },
                    ].map(tab => (
                      <div
                        key={tab.id}
                        onClick={() => setRightTab(tab.id)}
                        style={{
                          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                          cursor: 'pointer', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em',
                          color: rightTab === tab.id ? '#fff' : '#999',
                          background: rightTab === tab.id ? '#252526' : 'transparent',
                          borderTop: rightTab === tab.id ? '2px solid #007acc' : '2px solid transparent',
                          borderBottom: rightTab === tab.id ? '1px solid #252526' : '1px solid transparent',
                        }}
                      >
                        <span>{tab.icon}</span>{tab.label}
                      </div>
                    ))}
                  </div>
                  <div style={{ flex: 1, overflow: 'auto', display: rightTab === 'blocks' ? 'block' : 'none' }}>
                    <Toolbox
                      libraryData={libraryData}
                      activeFileType={activeItem?.type}
                      selectedBoard={selectedBoard}
                      buses={buses}
                      interfaceConfig={deviceInterfaceConfig}
                      userDefinedBlocks={
                        activeItem?.category === 'programs'
                          ? [...projectStructure.functionBlocks, ...projectStructure.functions]
                          : []
                      }
                    />
                  </div>
                  {rightTab === 'agent' && (
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <AiAgentPanel
                        activeItem={activeItem}
                        projectStructure={projectStructure}
                        setProjectStructure={setProjectStructure}
                        selectedBoard={selectedBoard}
                        liveVariables={(isSimulationMode || isRunning) ? (liveVariables || {}) : null}
                        onApplied={handleAgentApplied}
                        onHotSwap={handleAgentHotSwap}
                        hotSwapActive={isHotSwap}
                        onStartHotSwap={startHotSwapSession}
                        onStopHotSwap={stopHotSwapSession}
                      />
                    </div>
                  )}
                </div>
              </>
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

      {/* ── ESI Slave Picker (triggered from sidebar "Add from Library") ── */}
      {esiPickerBusId && (
        <>
          <div
            onClick={() => setEsiPickerBusId(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9998 }}
          />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            background: '#252526', border: '1px solid #444', borderRadius: 6,
            padding: 16, zIndex: 9999, minWidth: 420, maxWidth: 640,
            maxHeight: '70vh', overflowY: 'auto',
          }}>
            <div style={{ fontWeight: 'bold', color: '#ddd', marginBottom: 10, fontSize: 13 }}>
              Select Device from Library ({esiLibrary.length} found)
            </div>
            {esiLibrary.map((dev, i) => (
              <div
                key={i}
                onClick={() => handleEsiDevicePicked(dev)}
                style={{ border: '1px solid #333', borderRadius: 4, padding: '7px 10px', marginBottom: 5,
                  cursor: 'pointer', background: '#2a2a2a', display: 'flex', flexDirection: 'column', gap: 3 }}
                onMouseEnter={e => e.currentTarget.style.background = '#333'}
                onMouseLeave={e => e.currentTarget.style.background = '#2a2a2a'}
              >
                <div style={{ fontWeight: 'bold', color: '#9cdcfe', fontSize: 12 }}>{dev.name}</div>
                <div style={{ color: '#555', fontSize: 10 }}>
                  {dev.vendorName} · VID:0x{(dev.vendorId >>> 0).toString(16).toUpperCase().padStart(8,'0')} · PC:0x{(dev.productCode >>> 0).toString(16).toUpperCase().padStart(8,'0')}
                </div>
                <div style={{ color: '#888', fontSize: 10 }}>
                  {(dev.txPdos || []).length} TxPDO · {(dev.rxPdos || []).length} RxPDO · {(dev.sdos || []).length} SDO init
                </div>
              </div>
            ))}
            <button
              onClick={() => setEsiPickerBusId(null)}
              style={{ marginTop: 8, background: '#37474f', color: '#ccc', border: 'none', borderRadius: 3, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        </>
      )}

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
