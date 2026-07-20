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
  BoltIcon,
} from './components/ToolbarIcons';
import SaveConfirmDialog from './components/SaveConfirmDialog';
import VisualizationEditor from './components/visualization/VisualizationEditor';
import { getEditorScope, EDITOR_SCOPE } from './utils/editorScope';
import { isReservedTranspilerName } from './utils/reservedNames';
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
import { openFile, saveFile, ask, readTextFile, writeTextFile, clearActiveFileHandle, registerPathPicker } from './services/browserFs';
import SavePathModal from './components/SavePathModal';
import { transpileToC, validateProjectST } from './services/CTranspilerService';
import { PLCClient } from './services/PLCClient';
import { host } from './services/HostClient';
import PlcIcon from './assets/icons/plc-icon.png';
import EtherCATIconSrc from './assets/icons/ethercat.png';
const EtherCATTabIcon = <img src={EtherCATIconSrc} height="13" style={{ objectFit: 'contain', verticalAlign: 'middle' }} alt="EtherCAT" />;
import './App.css';

// ── Unified rung-based POU model ─────────────────────────────────────────────
// Every program / function block / function is ONE kind of thing: a list of
// RUNGS, where each rung is authored in either Ladder (LD) or Structured Text
// (ST). There is no separate "ST POU" vs "LD POU" vs "SCL POU" anymore — the
// old `SCL` type IS this unified model, and it is now the only one the UI
// creates. Older projects (and any agent output) may still carry the legacy
// types `LD` (all-ladder rungs) or `ST` (a single code body); we fold them into
// the unified shape on load and on create so the editor, transpiler and I/O
// only ever deal with one type. This keeps the mental model simple: "everything
// is rungs; pick the language per rung."
const RUNG_POU_CATEGORIES = ['programs', 'functionBlocks', 'functions'];
const normalizePouToRungs = (item) => {
  if (!item || !item.content) return item;
  if (item.type === 'ST') {
    const code = item.content.code || '';
    return {
      ...item,
      type: 'SCL',
      content: {
        variables: item.content.variables || [],
        rungs: code.trim()
          ? [{ id: `${item.id}_r0`, lang: 'ST', code, blocks: [], connections: [] }]
          : [],
      },
    };
  }
  if (item.type === 'LD') {
    // LD rungs are already the right shape; a rung with no `lang` renders/
    // transpiles as LD, so no per-rung migration is needed.
    return {
      ...item,
      type: 'SCL',
      content: { variables: item.content.variables || [], rungs: item.content.rungs || [] },
    };
  }
  return item; // already SCL, or a non-POU (UDT / GVL / resource)
};
const normalizeProjectToRungs = (struct) => {
  if (!struct) return struct;
  const next = { ...struct };
  RUNG_POU_CATEGORIES.forEach((cat) => {
    if (Array.isArray(next[cat])) next[cat] = next[cat].map(normalizePouToRungs);
  });
  return next;
};

// Pre-flight layout signature gating hot-swap — a FAST, FRIENDLY UX layer
// only, not the safety boundary. If any of these sub-signatures change since
// a hot-swap session started, the edit altered something a `swap` cannot
// apply (the runtime's fixed task table / PlcState layout / the loader-host
// binary itself), so we keep the edit (already accepted into the project)
// but refuse to push it online and tell the user which part changed — they
// re-deploy via Build & Send (cold restart) instead.
//
// This guard can have gaps (an edge case it doesn't model) and that's
// acceptable: the actual, unconditional safety boundary is the C-level
// plc_state_layout_hash check baked into every hot-swap build (see
// CTranspilerService.js + host-agent/hotswaphost/host.c) — it runs on every
// swap attempt regardless of what this JS guard concluded, and is what
// actually prevents a layout-incompatible swap from corrupting the live
// PlcState arena. This layer only saves a wasted compile+swap round-trip and
// gives a precise message instead of a generic "swap failed".

// Task scheduling (interval/duration, count, priority, program assignment) —
// part of the runtime's fixed task table, never hot-swappable.
const taskSignature = (struct) => JSON.stringify(
  (struct?.taskConfig?.tasks || []).map((t) => ({
    name: t.name,
    interval: t.interval,
    programs: (t.programs || []).map((p) => ({ program: p.program, priority: p.priority })),
  }))
);

// Variable table shape — name + declared type only (NOT address/comment,
// which are HMI/REST metadata that doesn't affect the PlcState struct
// layout at all). Covers globals, program/FB/function locals, AND FB/UDT
// instance variables (an instance is just a variable whose type is an FB/UDT
// name) — an add/remove/retype of any of these shifts the struct.
const variableTableSignature = (struct) => {
  const norm = (v) => ({ name: v.name, type: v.type });
  const globals = (struct?.resources || [])
    .flatMap((r) => r.content?.globalVars || [])
    .map(norm);
  const locals = [
    ...(struct?.programs || []),
    ...(struct?.functionBlocks || []),
    ...(struct?.functions || []),
    // Unified rung-based POUs keep their locals at content.variables (legacy
    // shapes had p.variables). Reading only p.variables made `locals` ALWAYS
    // empty — so a while-running edit that auto-declared an FB instance (e.g.
    // dropping a CTD → `CTD0 : CTD`) never tripped this guard; the swap went
    // to the C layout-hash, was rolled back by the loader-host, and the OLD
    // logic silently kept running (a CTD that "counts up").
  ].flatMap((p) => ((p.content?.variables ?? p.variables) || []).map((v) => ({ owner: p.name, ...norm(v) })));
  return JSON.stringify({ globals, locals });
};

// UDT (struct/array/enum) definitions — a field/member added/removed/retyped
// on a UDT changes the size of every variable of that type WITHOUT the
// variable's own {name,type} signature above changing at all, so this needs
// its own check. Broad whole-array stringify (not hand-picking fields) is
// deliberate: over-triggering a "needs Build & Send" message on a cosmetic
// UDT edit is harmless (the C hash never even gets exercised by a swap
// attempt that was never made); under-triggering is the only real risk.
const udtSignature = (struct) => JSON.stringify(struct?.dataTypes || []);

// Board + EtherCAT/bus config — these don't live in PlcState at all, but
// changing them requires rebuilding the LOADER-HOST binary itself (HAL
// trampolines compiled into host_glue.c), which a logic-only `swap` can
// never do regardless of what the PlcState hash says.
const ioEcSignature = (boardId, buses, busConfigs) =>
  JSON.stringify({ boardId, buses: buses || [], busConfigs: busConfigs || {} });

// State-shaping ladder blocks — PlcState fields that exist WITHOUT any declared
// variable changing: every FB-style block emits per-pin shadow fields
// (prog_X_in/out_<inst>_<pin>) and every Rising/Falling contact/coil emits an
// edge-memory field keyed by its BLOCK id (__edge_<id>). So adding/removing/
// renaming such a block changes the PlcState layout even when the variable
// table is identical (the exact CTD case: instance var already declared, block
// added later — the old signature saw nothing, the C hash rolled the swap
// back, and the old logic silently kept running). Plain NO/NC contacts and
// Normal/Set/Reset coils carry no state and stay hot-reloadable. Document
// order is kept deliberately: the C layout hash is order-sensitive too.
const stateBlocksSignature = (struct) => {
  const pous = [
    ...(struct?.programs || []),
    ...(struct?.functionBlocks || []),
    ...(struct?.functions || []),
  ];
  return JSON.stringify(pous.map((p) => ({
    pou: p.name,
    blocks: (p.content?.rungs || []).flatMap((r) => (r.blocks || [])
      .map((b) => {
        const t = b.data?.type || b.type;
        if (t === 'Contact' || t === 'Coil') {
          const st = b.data?.subType || (t === 'Contact' ? 'NO' : 'Normal');
          return (st === 'Rising' || st === 'Falling') ? { edge: b.id } : null;
        }
        return { fb: b.data?.instanceName || b.id, type: b.data?.label || t };
      })
      .filter(Boolean)),
  })));
};

const layoutSignature = (struct, boardId, buses, busConfigs) => ({
  task: taskSignature(struct),
  variables: variableTableSignature(struct),
  udts: udtSignature(struct),
  blocks: stateBlocksSignature(struct),
  ioEc: ioEcSignature(boardId, buses, busConfigs),
});

// Compares two layoutSignature() results and returns a list of human-readable
// reasons for whichever sub-signatures differ (empty array = fully compatible
// with the snapshot taken when the hot-swap session started).
const layoutSignatureDiff = (a, b) => {
  if (!a || !b) return [];
  const reasons = [];
  if (a.task !== b.task) reasons.push('task timing/scheduling changed (task durations are not hot-reloadable)');
  if (a.variables !== b.variables) reasons.push('variable table changed (a variable or FB/UDT instance was added, removed, or retyped)');
  if (a.udts !== b.udts) reasons.push('a data type (struct/array/enum) definition changed');
  if (a.blocks !== b.blocks) reasons.push('a state-carrying ladder block changed (an FB or Rising/Falling contact/coil was added, removed, renamed, or reordered)');
  if (a.ioEc !== b.ioEc) reasons.push('board or EtherCAT/bus configuration changed (the runtime binary itself needs rebuilding)');
  return reasons;
};

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

  // Host-agent-backed path picker for browsers without the File System Access
  // API (Firefox) — browserFs.js calls this to resolve a real save/open path
  // instead of falling back to a Downloads-folder download.
  const [pathPickerRequest, setPathPickerRequest] = useState(null);
  useEffect(() => {
    registerPathPicker((opts) => new Promise((resolve) => {
      setPathPickerRequest({ ...opts, resolve });
    }));
  }, []);

  useEffect(() => {
    errorCodeService.load().catch(err => console.warn('Error codes load failed:', err));
  }, []);

  // Suppress the browser's native right-click context menu app-wide. Several
  // components (ProjectSidebar tree rows, VariableManager rows) already show
  // their OWN custom menu and call preventDefault()/stopPropagation() locally,
  // but large areas (toolbox, output panel, LD canvas background, config
  // pages) had no handler at all — there the native menu leaked through, with
  // a browser "Paste" entry that reads the OS clipboard directly instead of
  // going through the app's own clipboard handling. This catch-all listener
  // closes that gap; components with their own menu still work the same
  // (their handler runs first and may stopPropagation, this one is harmless
  // to call preventDefault twice).
  //
  // EXCEPT over editable text fields (input/textarea/contentEditable, incl.
  // Monaco's hidden input) — there the native Cut/Copy/Paste menu IS the
  // correct interaction (typing a value needs real OS-clipboard paste, not
  // the app's structured POU/rung/variable clipboard). Chrome fully respects
  // preventDefault here so this used to silently kill native paste on every
  // text field in Chrome only — Firefox does not allow suppressing this menu
  // on editable elements at all, so the same blanket preventDefault left
  // Firefox showing it anyway. Excluding editable targets makes both browsers
  // behave the same way instead of just papering over Firefox's exception.
  useEffect(() => {
    const onContextMenu = (e) => {
      const t = e.target;
      const editable = t && t.closest && t.closest('input, textarea, [contenteditable="true"]');
      if (editable) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
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

  // ── Project-tree undo/redo ────────────────────────────────────────────────
  // Covers the sidebar structural ops (add/delete/rename/reorder/paste of
  // programs, function blocks, functions, data types). Each such mutation calls
  // pushUndoSnapshot(prev) INSIDE its setProjectStructure updater, so history
  // records only real changes. Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) restore.
  const projectStructureRef = React.useRef(projectStructure);
  useEffect(() => { projectStructureRef.current = projectStructure; }, [projectStructure]);
  const undoHistoryRef = React.useRef({ past: [], future: [] });
  const UNDO_LIMIT = 50;
  const pushUndoSnapshot = (prev) => {
    const h = undoHistoryRef.current;
    h.past.push(prev);
    if (h.past.length > UNDO_LIMIT) h.past.shift();
    h.future = [];
  };

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

  // Bumped when the PLC Agent commits changes to the currently-open POU, forcing
  // EditorPane to remount so it re-reads the mutated content (it seeds its local
  // state from initialContent only on mount).
  const [agentReloadKey, setAgentReloadKey] = useState(0);
  // Hot-swap (online change) session active — agent-approved edits go live.
  const [isHotSwap, setIsHotSwap] = useState(false);
  // Field online-change mode: a hot-swap loader-host has been deployed to the
  // connected target, so edits apply as online changes (no restart) instead of
  // via a full Build & Send. Distinct from isHotSwap (which is also true for the
  // local-sim hot-swap). Cleared by Stop Live, a plain Build & Send (which
  // deploys a self-contained binary and thus ends online-change mode), or
  // losing the connection. Drives the "Go Live" toolbar toggle.
  const [fieldHotSwap, setFieldHotSwap] = useState(false);
  const [hotSwapBusy, setHotSwapBusy] = useState(false); // Go Live deploy in flight
  // A compile/build is in flight: 'sim' (Simulation toggle) or 'build' (Build /
  // Build & Send). Drives the toolbar spinner + the busy (progress) cursor so
  // the multi-second clang run has visible feedback instead of a frozen-looking
  // button.
  const [compileBusy, setCompileBusy] = useState(null);
  // Manual online-change (CoDeSys-style): while a hot-swap runtime is live, the
  // LOGIC editors stay editable; edits are NOT pushed automatically — they set
  // pendingOnlineChange, which surfaces a "Hot Reload" toolbar button that
  // applies them through the same guarded path as agent edits
  // (handleAgentHotSwap: layoutSignature pre-check + the C-level
  // plc_state_layout_hash safety net, state preserved). Layout-owning editors
  // (variable table, sidebar structure, tasks) stay LOCKED while running so a
  // manual edit can't silently change the PlcState shape.
  const [pendingOnlineChange, setPendingOnlineChange] = useState(false);
  const [hotReloadBusy, setHotReloadBusy] = useState(false); // manual hot reload in flight
  // Project-structure snapshot the running logic was built from (set at session
  // start / re-attach, refreshed after each confirmed swap; null when no
  // hot-swap runtime is live). Any structure change away from it = pending.
  const runStructSnapRef = React.useRef(null);
  const hotSwapLive = (isRunning && isHotSwap) || fieldHotSwap;
  useEffect(() => {
    if (hotSwapLive) {
      // Session (re)started or re-attached: the current structure IS what runs.
      runStructSnapRef.current = projectStructureRef.current;
    } else {
      // Stopped / disconnected / Build & Send: nothing live to diff against.
      runStructSnapRef.current = null;
      setPendingOnlineChange(false);
    }
  }, [hotSwapLive]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Structural edit while a hot-swap runtime is live → offer Hot Reload.
    if (runStructSnapRef.current && projectStructure !== runStructSnapRef.current) {
      setPendingOnlineChange(true);
    }
  }, [projectStructure]);

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
  // Busy cursor for the whole app while a compile/build runs (the toolbar
  // spinner alone is easy to miss when the user is looking at the editor).
  // The sim-compile cursor is suppressed once the sim is actually running —
  // same stale-state guard as the button spinner. ('build' may legitimately
  // run while a remote runtime is running, so it is not gated on isRunning.)
  useEffect(() => {
    const busy = compileBusy === 'build' || (compileBusy === 'sim' && !isRunning);
    document.body.style.cursor = busy ? 'progress' : '';
    return () => { document.body.style.cursor = ''; };
  }, [compileBusy, isRunning]);
  // Publish "local hot-swap sim is active" so ForceWriteModal can offer the
  // Pulse (one-scan) write mode without threading isSimulationMode through every
  // force entry point (watch table, ladder canvas, ST editor). Pulse only works
  // in the local sim; a remote PLC always force-writes.
  useEffect(() => {
    window.__kronSimActive = isRunning && isSimulationMode;
    return () => { window.__kronSimActive = false; };
  }, [isRunning, isSimulationMode]);

  useEffect(() => {
    if (!plcAddress || !connectionEnabled) {
      setIsPlcConnected(false);
      // Clear the client so reconnect (possibly to a new IP) always gets a fresh one.
      if (plcClientRef.current) {
        plcClientRef.current.close();
        plcClientRef.current = null;
      }
      return;
    }
    // If the address changed while still connected, replace the stale client.
    if (plcClientRef.current && plcClientRef.current._base !== `http://${plcAddress}`) {
      plcClientRef.current.close();
      plcClientRef.current = null;
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
              // Always (re)attach the stream here — the server streams its own
              // deployed variable table, so we must NOT gate on
              // remoteVarKeysRef (it is only populated by Build & Send in the
              // same browser session; after a reload it is empty and live
              // values would stay '---' forever).
              if (!plcClientRef.current.isStreaming) {
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
    const confirmed = await ask(t('messages.removeFieldbusConfirm') || 'Do you want to remove this fieldbus connection?', {
      title: t('messages.removeFieldbusTitle') || 'Remove Fieldbus', type: 'warning'
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
    const confirmed = await ask(t('messages.deleteSlaveConfirm', { name: slave?.name || 'Slave' }) || `Delete "${slave?.name || 'Slave'}"?`, { title: t('messages.deleteSlaveTitle') || 'Delete Slave', type: 'warning' });
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
    consoleHeight: 128
  });
  const [isResizing, setIsResizing] = useState(null); // 'left', 'right', 'console'
  const [rightTab, setRightTab] = useState('blocks'); // 'blocks' | 'agent' — right sidebar tabs
  // Lazy-mount the agent panel on first open, then keep it MOUNTED (hidden with
  // display:none) so switching tabs never unmounts it and loses a pending
  // approval. Users who never open the agent don't pay for its effects.
  const [agentEverOpened, setAgentEverOpened] = useState(false);
  useEffect(() => { if (rightTab === 'agent') setAgentEverOpened(true); }, [rightTab]);
  // Bridge: "Ask agent" from the output-panel error popup. Reveals the agent
  // tab (mounting it if first use) and hands it a prompt to send. The {text,id}
  // shape lets AiAgentPanel fire once per request even if the same text repeats.
  const [agentAsk, setAgentAsk] = useState(null);
  const askAgentAbout = useCallback((text) => {
    setAgentEverOpened(true);
    setRightTab('agent');
    setAgentAsk({ text, id: Date.now() });
  }, []);

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

  // Undo/redo for the project tree. undo: pop past → current goes to future →
  // restore. redo: the inverse. Refs are updated synchronously so a rapid
  // Ctrl+Z/Ctrl+Y sequence chains correctly without waiting for a re-render.
  const undoProject = useCallback(() => {
    const h = undoHistoryRef.current;
    if (h.past.length === 0) { addLog('info', 'Nothing to undo'); return; }
    const prev = h.past.pop();
    h.future.push(projectStructureRef.current);
    projectStructureRef.current = prev;
    setProjectStructure(prev);
    addLog('info', 'Undo (project tree)');
  }, [addLog]);

  const redoProject = useCallback(() => {
    const h = undoHistoryRef.current;
    if (h.future.length === 0) { addLog('info', 'Nothing to redo'); return; }
    const next = h.future.pop();
    h.past.push(projectStructureRef.current);
    projectStructureRef.current = next;
    setProjectStructure(next);
    addLog('info', 'Redo (project tree)');
  }, [addLog]);

  // Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) for the project tree. Gated like the
  // sidebar copy/paste handler: bail in text inputs (Monaco/textarea handle
  // their own undo) and when another editor scope (LD / variables) owns focus.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      // Physical-key resolve (e.code) with e.key fallback — Ctrl+Shift+Z's e.key
      // can differ by layout, which used to swallow project-tree redo.
      const isZ = e.code === 'KeyZ' || k === 'z';
      const isY = e.code === 'KeyY' || k === 'y';
      if (!isZ && !isY) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const scope = getEditorScope();
      if (scope && scope !== EDITOR_SCOPE.SIDEBAR) return; // LD/variables own their undo
      if (isY || (isZ && e.shiftKey)) { e.preventDefault(); redoProject(); }
      else if (isZ) { e.preventDefault(); undoProject(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undoProject, redoProject]);

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

  // --- Re-attach to a local simulation left running by a previous session ---
  // The simulation runs as a separate host-agent process with its own /proc
  // poller, so it survives a browser tab close/reload. On (re)load — once a
  // project is open and the editor isn't already tracking a run — we ask the
  // agent whether a sim is still running and, if so, restore the running state
  // instead of erroring with "Simulation is already running" on the next start.
  // Live values resume automatically over the existing simulation-output SSE.
  // (The remote/KronServer case is handled separately by the 3s status poll.)
  const simReattachedRef = React.useRef(false);
  useEffect(() => {
    if (!isProjectOpen || simReattachedRef.current) return;
    if (isRunningRef.current || isSimulationModeRef.current) return;
    simReattachedRef.current = true;
    host.simStatus()
      .then((res) => {
        const st = typeof res === 'string' ? JSON.parse(res) : res;
        if (st && st.running && !isRunningRef.current && !isSimulationModeRef.current) {
          setIsSimulationMode(true);
          setIsRunning(true);
          // The default sim is a hot-swap loader-host, so a re-attached sim stays
          // reloadable — restore the flags so an agent change can still hot reload.
          if (st.mode === 'hotswap') {
            hotSwapActiveRef.current = true;
            setIsHotSwap(true);
            layoutSigRef.current = layoutSignature(projectStructure, selectedBoard, buses, busConfigs);
          }
          addLog('info', 'Simulation already running — re-attached (live values resuming).');
        }
      })
      .catch(() => { simReattachedRef.current = false; }); // agent not ready yet → allow a retry
  }, [isProjectOpen, addLog]);

  // --- File Operations ---

  // Shared save routine. saveAs=false (Save) overwrites the open file in place
  // via the retained FSA handle (no picker); saveAs=true always prompts.
  const persistProject = useCallback(async (saveAs) => {
    try {
      const xmlContent = exportProjectToXml(projectStructure, selectedBoard, { plcAddress, sshUser, sshPort, apiPassword, autoRun }, buses, busConfigs, watchTable, hmiLayout);
      const suggestedName = (currentFilePath || 'project.xml').split('/').pop() || 'project.xml';
      const savedName = await saveFile({ suggestedName, content: xmlContent, saveAs });
      if (!savedName) return;

      hasUnsavedRef.current = false;
      setCurrentFilePath(savedName);
      // No success notification on save — it just clutters the output (user asked
      // for silent saves). Failures still surface below; the unsaved-changes
      // warnings on close/unload stay so closing without saving is still caught.
    } catch (error) {
      addLog('error', t('logs.saveAsError', { error: error }) || `Save Error: ${error} `);
    }
  }, [projectStructure, selectedBoard, plcAddress, sshUser, sshPort, apiPassword, autoRun, buses, busConfigs, watchTable, hmiLayout, currentFilePath, addLog, t]);

  const handleSaveAs = useCallback(() => persistProject(true), [persistProject]);
  const handleSave = useCallback(() => persistProject(false), [persistProject]);

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
      clearActiveFileHandle();
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
      clearActiveFileHandle();
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
      clearActiveFileHandle();
      addLog('success', t('logs.pulled', { addr: plcAddress }) || `Project pulled from ${plcAddress}.`);
    } catch (err) {
      addLog('error', `Pull failed: ${err.message || err}`);
    }
  };

  const processFileContent = (content, filePath) => {
    try {
      const result = importProjectFromXml(content);
      if (result) {
        // Fold any legacy LD/ST POUs into the unified rung model on load.
        const newStructure = normalizeProjectToRungs(result.projectStructure);
        const { boardId, plcAddress: savedAddr, sshUser: savedSshUser, sshPort: savedSshPort, apiPassword: savedApiPassword, autoRun: savedAutoRun } = result;
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

  // Start the local simulation runtime. Shared by the Run button and by the
  // auto-run when Simulation Mode is enabled (toggling sim ON = run).
  const runSimulationNow = async () => {
    setIsRunning(true);
    addLog('success', 'Running Simulation Execution...');
    try {
      // The simulation runs as a hot-swap loader-host (built by handleToggleSimulation),
      // so live code is reloadable — an agent change while running can be applied
      // without a restart. hotswapRun is idempotent (returns alreadyRunning).
      await host.hotswapRun();
      hotSwapActiveRef.current = true;
      setIsHotSwap(true);
      layoutSigRef.current = layoutSignature(projectStructure, selectedBoard, buses, busConfigs);
    } catch (err) {
      addLog('error', `Failed to start simulation: ${err.message || err}`);
      setIsRunning(false);
    }
  };

  const handleToggleSimulation = async () => {
    // Simulation Mode is allowed even while a PLC is connected — Build & Send is
    // disabled for the duration instead (re-enabled when Simulation goes OFF).
    if (isRunning) {
      addLog('warning', t('logs.stopExecutionFirst') || 'Please stop execution before toggling simulation mode.');
      return;
    }

    const nextMode = !isSimulationMode;

    if (nextMode) {
      setCompileBusy('sim');
      addLog('info', t('logs.compilingSimulationTranspile') || 'Compiling Project for Simulation (C Transpilation)...');
      try {
        const standardHeaders = await host.getStandardHeaders().catch(() => []);
        const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, true, buses, busConfigs);

        // Strict task semantics: only task-assigned programs run. Warn about any
        // program that won't execute (so "I made it but no data" is diagnosable).
        const runningProgs = new Set((cCode.variableTable?.tasks || []).map(tk => tk.program));
        const notRunning = (projectStructure.programs || [])
          .map(p => p.name)
          .filter(n => n && !runningProgs.has(n.trim().replace(/\s+/g, '_')));
        if (notRunning.length > 0) {
          addLog('warning', `Not assigned to any task — will NOT run: ${notRunning.join(', ')}. Assign them in Task Manager.`);
        }

        // Build the simulation as a HOT-SWAP loader-host (+ logic.so), not a plain
        // binary — so the running sim is reloadable and an agent change can be
        // applied live (with a confirm). hotswapBuild writes the C files itself.
        addLog('info', t('logs.compilingSimulation') || 'Compiling simulation executable...');
        await host.hotswapBuild({
          header: cCode.header,
          source: cCode.source,
          variableTable: JSON.stringify(cCode.variableTable, null, 2),
          hal: cCode.hal || '',
          hostGlue: cCode.hostGlue || '',
        });
        addLog('success', 'Simulation built (hot-swap enabled — live code is reloadable).');
        // Compile phase is over — stop the spinner NOW, before the run starts
        // (the finally below is only the error-path safety net). Keeping it
        // spinning through runSimulationNow made a healthy start look busy.
        setCompileBusy(null);

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

        // Toggling Simulation ON auto-starts the run (no separate Run click).
        await runSimulationNow();
      } catch (error) {
        addLog('error', t('logs.simulationCompileFailed', { error: error }) || `Simulation Compilation Failed: ${error}`);
        // Surface the actual compiler output (clang errors) so the failure has a reason.
        if (error && error.log && String(error.log).trim()) {
          String(error.log).trim().split('\n').forEach(line => addLog('error', line));
        }
      } finally {
        setCompileBusy(null);
      }
    } else {
      setIsSimulationMode(false);
      addLog('info', t('logs.simulationDisabled') || 'Simulation Mode Disabled.');
      liveVarsRef.current = {};
      setLiveVariables({});
      hotSwapActiveRef.current = false;
      setIsHotSwap(false);
      layoutSigRef.current = null;
    }
  };

  const handleStartExecution = async () => {
    if (!isSimulationMode && !(isDeployed && !isDirty && isPlcConnected)) {
      addLog('warning', 'Cannot start. Enable Simulation Mode or Build & Send to PLC first.');
      return;
    }

    if (isSimulationMode) {
      await runSimulationNow();
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
          await host.hotswapStop(); // sim runs the hot-swap loader-host now
        } catch (err) {
          addLog('error', `Failed to stop simulation: ${err.message || err}`);
        }
        hotSwapActiveRef.current = false;
        setIsHotSwap(false);
        layoutSigRef.current = null;
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

  // mode: 'force' (hold, default) or 'pulse' (apply for one scan). Pulse is only
  // wired for the local hot-swap sim; a remote PLC always force-writes.
  const handleForceWrite = useCallback(async (key, value, mode = 'force') => {
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
        await host.writeVariable(key, value, mode);
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
    setCompileBusy('build');
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
    } finally {
      setCompileBusy(null);
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
    // The runtime may be live (local simulation, or a running remote PLC). A full
    // Build & Send recompiles and RESTARTS the target runtime, so outputs reset
    // and running state (timers/counters/latches) is lost. Don't block it — just
    // confirm before disrupting a live system. (For a state-preserving update use
    // the PLC Agent's online change / "Go live" instead.)
    if (isRunning || isSimulationMode) {
      // isPlcConnected is always true here (guarded above), so base the message
      // on WHICH runtime is actually live: in simulation mode isRunning tracks
      // the local sim; otherwise it tracks the remote PLC runtime.
      const where = isSimulationMode ? 'the local simulation' : `the PLC at ${plcAddress}`;
      if (!window.confirm(`The runtime on ${where} is RUNNING.\n\nBuild & Send will recompile and RESTART it with the new program — outputs reset and current state (timers, counters, latches) is lost.\n\nProceed?`)) {
        addLog('info', 'Build & Send cancelled.');
        return;
      }
    }
    const boardInfo = getBoardById(selectedBoard);
    checkBaremetalConcurrency();
    addLog('info', `Build & Send for ${boardInfo?.name || selectedBoard}...`);
    setCompileBusy('build');
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

      // Cross-compile a SELF-CONTAINED runtime.bin (NOT the hot-swap loader-host).
      // Remote hot reload was reverted: the loader-host is unverified on real
      // hardware and was crashing on the target (it needs a logic.so arg that the
      // deploy mis-named). Build & Send is a full deploy + restart; live reload
      // stays a SIMULATION-only feature.
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

      // Deploy autorun + HMI port config. `restart` makes the server swap the
      // running runtime to the binary we just deployed — without it, a Build &
      // Send while a runtime is already running (or under AutoRun) leaves the
      // OLD code executing (overwriting runtime.bin on disk doesn't touch the
      // live process). Restart only when it SHOULD run: AutoRun on, or it was
      // already running (the confirm dialog already warned state is lost).
      const shouldRestart = autoRun || isRunning;
      try {
        await fetch(`http://${plcAddress}/deploy/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ auto_run: autoRun, hmi_port: hmiPort, restart: shouldRestart }),
        });
        if (shouldRestart) addLog('info', 'Restarting runtime with new code...');
      } catch (cfgErr) {
        addLog('warning', `Runtime config deploy skipped: ${cfgErr.message}`);
      }

      setIsDeployed(true);
      setIsDirty(false);
      // A plain Build & Send deploys a SELF-CONTAINED runtime (compileForTarget),
      // replacing any loader-host on the target — so field online-change mode is
      // no longer in effect. Re-enable it later with "Go Live" if desired.
      if (fieldHotSwap) { setFieldHotSwap(false); setIsHotSwap(false); }

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
      if (err && err.log && String(err.log).trim()) {
        String(err.log).trim().split('\n').forEach(line => addLog('error', line));
      }
    } finally {
      setCompileBusy(null);
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

        // Focus guard for shortcuts that collide with native editing keys
        // (Ctrl+X = cut, Ctrl+B in Monaco): never hijack them while the user
        // is typing in an input/textarea/contentEditable/Monaco editor.
        const ae = document.activeElement;
        const isTextEditingTarget = !!(ae && (
          ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable ||
          ae.closest?.('.monaco-editor')
        ));

        // Compile: Ctrl + B
        if (e.key.toLowerCase() === 'b' && !isTextEditingTarget) {
          e.preventDefault();
          handleBuildRef.current();
        }

        // Run/Start: Ctrl + X
        if (e.key.toLowerCase() === 'x' && !isTextEditingTarget) {
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

    // Block names the transpiler/runtime reserve at C file scope (e.g. "S" is
    // the internal PlcState pointer) — see reservedNames.js for the full list.
    if (isReservedTranspilerName(name)) {
      alert(`"${name}" is reserved by the transpiler/runtime and can't be used as a name.`);
      return false;
    }

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
        pushUndoSnapshot(prev);
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

    // Programs / function blocks / functions are always the unified rung model
    // (internally still tagged 'SCL'); the create modal no longer asks for a
    // language — you add LD or ST rungs inside the editor. Data types / globals
    // keep their own shapes.
    const isRungPou = RUNG_POU_CATEGORIES.includes(category);
    const pouType = isRungPou ? 'SCL' : type;
    const newItem = {
      id: `${category}_${Date.now()}`,
      name: name,
      type: pouType,
      returnType: category === 'functions' ? returnType : undefined,
      content:
        isRungPou ? { rungs: [], variables: [] } :
          pouType === 'UDT' ? { members: [] } :
            pouType === 'GVL' ? { variables: [] } :
              { code: '', variables: [] }
    };

    setProjectStructure(prev => {
      pushUndoSnapshot(prev);
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
      pushUndoSnapshot(prev);
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
      pushUndoSnapshot(prev);
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
      pushUndoSnapshot(prev);
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
      pushUndoSnapshot(prev);
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

  // Tab labels resolve LIVE from the project by id, so a rename (or a name set
  // after the tab was opened) updates the tab. openTab() snapshots the label
  // only at open time and never refreshes it, which left renamed/late-named
  // POUs showing a stale or blank tab title.
  const resolveTabLabel = (id, fallback) => {
    for (const key of Object.keys(projectStructure)) {
      if (!Array.isArray(projectStructure[key])) continue;
      const item = projectStructure[key].find(i => i.id === id);
      if (item) return item.name || fallback;
    }
    return fallback;
  };
  const displayTabs = openTabs.map(t => ({ ...t, label: resolveTabLabel(t.id, t.label) }));

  const deviceInterfaceConfig =
    projectStructure.resources?.find(r => r.id === 'res_config')?.content?.deviceInterfaceConfig || {};

  const hwPortVars = useMemo(
    () => buildHardwarePortVars(deviceInterfaceConfig, getBoardFamilyDefine(selectedBoard)),
    [deviceInterfaceConfig, selectedBoard]
  );

  const handleAgentCheckCompile = useCallback(async () => {
    const stErrors = validateProjectST(projectStructure, [], hwPortVars);
    if (stErrors.length > 0) {
      return {
        ok: false,
        stage: 'st-validation',
        errors: stErrors.map(e => `[${e.context}] Line ${e.line}:${e.column} — ${e.word}`),
        note: `${stErrors.length} ST identifier error(s) found before reaching the C compiler.`,
      };
    }
    try {
      const standardHeaders = await host.getStandardHeaders().catch(() => []);
      const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, true, buses, busConfigs);
      await host.writePlcFiles({
        header: cCode.header,
        source: cCode.source,
        variableTable: JSON.stringify(cCode.variableTable, null, 2),
        hal: cCode.hal || '',
      });
      await host.compileSimulation();
      return { ok: true, stage: 'compile', message: 'Compiled successfully — no errors.' };
    } catch (err) {
      return { ok: false, stage: 'compile', error: err.message || String(err), log: err.log || '' };
    }
  }, [projectStructure, selectedBoard, buses, busConfigs, hwPortVars]);

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

  // The PLC Agent committed changes (it already called setProjectStructure with
  // the new structure). If it touched the open POU, remount the editor so it
  // reflects the new code/variables; always log it.
  const handleAgentApplied = useCallback((pouNames, opts = {}) => {
    const names = pouNames || [];
    const norm = (n) => (n || '').trim().toLowerCase();   // tolerate stray spaces in names
    // Bring what the agent just wrote to the screen so the result is visible.
    // opts.structure is the freshly-committed projectStructure (passed by the
    // panel) — using it avoids racing App's not-yet-updated state.
    const struct = opts.structure;
    const focusName = opts.focus || names[0];
    if (struct && focusName) {
      for (const key of Object.keys(struct)) {
        if (!Array.isArray(struct[key])) continue;
        const item = struct[key].find(i => norm(i.name) === norm(focusName));
        if (item) {
          openTab(item.id, item.name, getItemIcon(key, item.type));
          setActiveId(item.id);            // focus its editor tab
          break;
        }
      }
    }
    if (activeItem && names.some(n => norm(n) === norm(activeItem.name))) {
      setAgentReloadKey(k => k + 1);       // already-open POU: force a content reload
    }
    addLog('info', `PLC Agent applied changes: ${names.length ? names.join(', ') : 'project structure'}`);
  }, [activeItem, addLog]);

  // ── Hot-swap (online change) session ──────────────────────────────────────
  // When a live session is running, an agent-approved code change is pushed to
  // the running PLC without a restart (state preserved). Live values keep
  // flowing on the existing simulation-output SSE (the host-agent's SHM poller).
  const hotSwapActiveRef = React.useRef(false);
  // Snapshot of layoutSignature() taken when a hot-swap session starts. Any
  // sub-signature changing since (task table / variable table / UDTs /
  // board-EC config) means the edit altered something a `swap` cannot apply —
  // the edit is kept (accepted into the project) but NOT pushed online; the
  // user re-deploys via Build & Send (cold restart) instead. Fast UX layer
  // only — see layoutSignature's own comment for the real safety boundary.
  const layoutSigRef = React.useRef(null);

  // Losing the target connection ends field online-change mode (the loader-host
  // may still be running on the device, but the editor can no longer push swaps).
  useEffect(() => {
    if (!isPlcConnected && fieldHotSwap) { setFieldHotSwap(false); setIsHotSwap(false); }
  }, [isPlcConnected, fieldHotSwap]);

  // "Go live": if connected to a remote PLC, deploy a hot-swap-capable runtime
  // (loader-host + logic_0.so) to the field; otherwise start a LOCAL sim
  // hot-swap session. Either way, agent-approved edits then apply online.
  const startHotSwapSession = useCallback(async () => {
    setHotSwapBusy(true);
    const standardHeaders = await host.getStandardHeaders().catch(() => []);
    try {
      if (isPlcConnected && plcAddress) {
        addLog('info', 'Deploying hot-swap runtime to target…');
        const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, false, buses, busConfigs);
        await host.hotswapTargetBuild({
          header: cCode.header, source: cCode.source,
          variableTable: JSON.stringify(cCode.variableTable, null, 2), hal: cCode.hal || '',
          hostGlue: cCode.hostGlue || '', boardId: selectedBoard,
        });
        // Dedicated hot-swap deploy path (NOT plain deployToServer, which is
        // Build & Send's self-contained-binary path and deliberately never
        // uploads a logic.so) — uploads runtime.bin(loader-host) + variables +
        // logic_0.so (cold, generation 0) as one atomic sequence.
        await host.hotswapTargetDeploy(plcAddress);
        hotSwapActiveRef.current = false;       // field mode (not local sim)
        setIsHotSwap(true);
        setFieldHotSwap(true);
        setIsRunning(true);                     // the loader-host is now running the logic
        addLog('success', 'Field hot-swap runtime deployed — online change enabled on the target (state preserved across edits).');
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
      // Baseline for the layout-change guard below.
      layoutSigRef.current = layoutSignature(projectStructure, selectedBoard, buses, busConfigs);
    } catch (err) {
      addLog('error', `Failed to start hot-swap session: ${err.message || err}`);
    } finally {
      setHotSwapBusy(false);
    }
  }, [projectStructure, selectedBoard, buses, busConfigs, isPlcConnected, plcAddress, addLog]);

  const stopHotSwapSession = useCallback(async () => {
    if (hotSwapActiveRef.current) { try { await host.hotswapStop(); } catch { /* ignore */ } setIsRunning(false); }
    hotSwapActiveRef.current = false;
    setIsHotSwap(false);
    // Field online-change mode ends too. NOTE: the loader-host keeps running on
    // the target (it is an independent process, like any deployed runtime) —
    // this only stops the editor pushing further online changes. Use Build &
    // Send to replace it with a fresh runtime, or Stop from the runtime controls.
    if (fieldHotSwap) { setFieldHotSwap(false); addLog('info', 'Online-change mode ended — the target keeps running the last logic.'); }
    else { addLog('info', 'Hot-swap session stopped.'); }
  }, [fieldHotSwap, addLog]);

  // Agent approved a code change while a hot-swap session is active → push it as
  // an online change (no restart, state preserved). Sim → local swap; field →
  // recompile logic.so for the target, upload to KronServer, swap. A
  // layout-changing edit can't be swapped (the runtime rolls back / errors —
  // surface it; the user should redeploy). Field swaps confirm first (live HW).
  // Offer + perform a full rebuild & restart of the LOCAL simulation when a
  // change cannot be hot-reloaded (layout change). Shared by the JS pre-check
  // AND the C-level layout-hash rejection path (the loader-host's rollback),
  // so a refused reload always surfaces as an actionable dialog — never only
  // as a log line that is easy to miss while the OLD logic keeps running.
  const offerSimRestart = useCallback(async (reasonText) => {
    if (!window.confirm(`${reasonText}\n\nRestart the SIMULATION with the new code now?\n\nValues of variables that exist in BOTH versions (counters, timers, flags) are carried over, so the program resumes from its current state. Brand-new variables/FB instances start at their initial values.\n\nCancel keeps the OLD code running; the edit stays in the project.`)) {
      addLog('warning', `Not applied — ${reasonText} The old code keeps running; the edit is kept in the project.`);
      return;
    }
    setCompileBusy('sim');
    try {
      // STATE CARRY-OVER: snapshot the last live values BEFORE stopping. After
      // the restart, every scalar that still exists (same live key) in the new
      // build is re-injected as a PULSE (one-scan write, then the logic owns
      // it) — so a counter at 35 resumes from 35 instead of resetting, which
      // is what an operator expects from an "online" layout change. FB-internal
      // edge memory isn't carried (not in SHM); a NEW instance starts fresh.
      const preserved = { ...(liveVarsRef.current || {}) };
      await host.hotswapStop().catch(() => {});
      setIsRunning(false);
      const standardHeaders = await host.getStandardHeaders().catch(() => []);
      const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, true, buses, busConfigs);
      await host.hotswapBuild({
        header: cCode.header,
        source: cCode.source,
        variableTable: JSON.stringify(cCode.variableTable, null, 2),
        hal: cCode.hal || '',
        hostGlue: cCode.hostGlue || '',
      });
      setCompileBusy(null);
      await runSimulationNow(); // refreshes layoutSigRef via its own snapshot
      runStructSnapRef.current = projectStructure;
      setPendingOnlineChange(false);
      let carried = 0;
      const newDefaults = cCode.variableTable?.debugDefaults || {};
      for (const key of Object.keys(newDefaults)) {
        if (!(key in preserved)) continue;             // new variable — starts fresh
        if (key.startsWith('prog____exec_us')) continue; // diagnostics, not state
        // FB pin shadows are NOT state and must NOT be carried:
        //  - in_ shadows (prog_X_in_<inst>_<pin>) hold the PROGRAM SOURCE's pin
        //    literal — seeded from the (possibly just-edited) literal at init and
        //    only READ per scan. Carrying the old runtime value would silently
        //    revert a pin-literal edit (PT 500ms→2s would come back as 500ms).
        //  - out_ shadows are recomputed from the FB every scan; carrying them
        //    only adds transient mixing before the first call settles them.
        // Real state lives in bare vars + FB struct members (keys with a dot,
        // e.g. prog_X_CTU0.CV) which never match this pattern.
        if (!key.includes('.') && /_(?:in|out)_/.test(key)) continue;
        const v = preserved[key];
        if (v === null || v === undefined || typeof v === 'object') continue; // composites/NaN
        try { await host.writeVariable(key, v, 'pulse'); carried++; } catch { /* type changed / no slot — skip */ }
      }
      addLog('success', `Simulation restarted with the new code — ${carried} variable value(s) carried over.`);
    } catch (e) {
      addLog('error', `Simulation restart failed: ${e.message || e}`);
      if (e && e.log && String(e.log).trim()) {
        String(e.log).trim().split('\n').forEach(line => addLog('error', line));
      }
    } finally {
      setCompileBusy(null);
    }
  }, [projectStructure, selectedBoard, buses, busConfigs, addLog, runSimulationNow]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAgentHotSwap = useCallback(async (touchedPous) => {
    const what = (touchedPous || []).join(', ') || 'logic';
    // A layout-changing edit (task table / variable table / UDTs / board-EC
    // config) is NOT hot-reloadable — it needs a cold restart. KEEP the edit
    // (already accepted into the project) but do NOT push it online; report
    // precisely which part changed instead of a generic message. This is the
    // fast UX pre-check only — the unconditional safety boundary is the
    // C-level plc_state_layout_hash check every swap attempt still goes
    // through regardless (see layoutSignature's comment).
    const layoutReasons = layoutSignatureDiff(
      layoutSigRef.current,
      layoutSigRef.current && layoutSignature(projectStructure, selectedBoard, buses, busConfigs)
    );
    if (layoutReasons.length > 0) {
      const why = layoutReasons.join('; ');
      // LOCAL SIM: a layout change can't hot-reload, but a sim restart is cheap —
      // offer it right here instead of leaving only a log line (which read as
      // "applied" while the OLD logic silently kept running after the rollback).
      if (hotSwapActiveRef.current) {
        await offerSimRestart(`This change is NOT hot-reloadable — ${why}.`);
        return;
      }
      // FIELD (real PLC): never auto-restart hardware — keep the explicit path.
      addLog('warning', `Not applied as an online change — ${why}. The change is kept; use Build & Send to deploy it (the runtime will restart).`);
      return;
    }
    const standardHeaders = await host.getStandardHeaders().catch(() => []);
    try {
      if (hotSwapActiveRef.current) {
        if (!window.confirm(`The simulation is RUNNING.\n\nApply this change LIVE as a HOT RELOAD — the logic is swapped without stopping the run, so state (timers/counters/latches) is preserved.\n\nChanged: ${what}\n\nHot reload now?`)) {
          addLog('info', 'Hot reload cancelled — change kept; it will apply on the next restart/Build & Send.');
          return;
        }
        const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, true, buses, busConfigs);
        await host.hotswapSwap({ header: cCode.header, source: cCode.source });
        addLog('success', `Hot reload applied (sim): ${what}`);
        runStructSnapRef.current = projectStructure; // this structure is now what runs
        setPendingOnlineChange(false);
      } else if (fieldHotSwap && isPlcConnected && plcAddress) {
        if (!window.confirm(`The PLC at ${plcAddress} is RUNNING.\n\nThis applies your change LIVE as an online change — the logic is swapped without stopping the runtime, so outputs may change immediately on real hardware (timers/counters/latches are preserved).\n\nChanged: ${what}\n\nApply to the live PLC now?`)) {
          addLog('info', 'Online change to target cancelled.');
          return;
        }
        // Stage the new logic (host-agent picks the local staging slot) then push
        // it to the target, which ping-pongs it into the slot NOT currently
        // running and swaps only after confirming — surfacing a rejected swap
        // (e.g. a layout mismatch caught by the loader-host) as an error.
        const cCode = transpileToC(projectStructure, standardHeaders, selectedBoard, false, buses, busConfigs);
        await host.hotswapTargetLogic({ header: cCode.header, source: cCode.source, boardId: selectedBoard });
        await host.hotswapDeploySwap(plcAddress);
        addLog('success', `Online change applied to target: ${what}`);
        runStructSnapRef.current = projectStructure; // this structure is now what runs
        setPendingOnlineChange(false);
      }
    } catch (e) {
      const msg = String(e?.message || e);
      // The loader-host's plc_state_layout_hash rejected the swap (the JS
      // pre-check can miss exotic layout changes — the C hash is the hard
      // net). For the local sim, turn that rejection into the same restart
      // offer instead of a log-only error the user won't see.
      if (hotSwapActiveRef.current && /LAYOUT/i.test(msg)) {
        await offerSimRestart('The running program\'s memory layout differs from this change (the safety check rejected the live swap and rolled back — the OLD logic is still running).');
        return;
      }
      addLog('error', `Hot-swap apply failed (a layout change needs a full redeploy): ${msg}`);
    }
  }, [projectStructure, selectedBoard, buses, busConfigs, isHotSwap, fieldHotSwap, isPlcConnected, plcAddress, addLog, offerSimRestart]); // eslint-disable-line react-hooks/exhaustive-deps

  // Manual "Hot Reload" (toolbar): apply the user's own edits to the running
  // logic through the SAME guarded path as agent edits — the layoutSignature
  // pre-check refuses layout changes with a precise reason, and the loader-host
  // still verifies plc_state_layout_hash before binding, so the running state
  // machine (timers/counters/latches) is preserved or the swap is rolled back.
  const manualHotReload = useCallback(async () => {
    setHotReloadBusy(true);
    try {
      await handleAgentHotSwap(['edited logic']);
    } finally {
      setHotReloadBusy(false);
    }
  }, [handleAgentHotSwap]);

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
          {isProjectOpen && (
            <span style={{ marginLeft: '10px', color: '#888', fontWeight: 400 }}>
              — {currentFilePath || 'Untitled'}
            </span>
          )}
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
                    <OpenIcon /> {t('actions.loadFromTarget', 'Load from Target')}
                  </div>
                  <div className="dropdown-sep" />
                  <div className="dropdown-item dropdown-item-warn" onClick={handleCloseProject}>
                    <CloseIcon /> {t('actions.closeProject') || 'Close Project'}
                  </div>
                </div>
              )}
            </div>

            {/* Quick Save (floppy disk) — one click, same as Ctrl+S */}
            <button
              className="tb-btn tb-icon"
              onClick={handleSave}
              title={`${t('common.save') || 'Save'} (Ctrl+S)`}
            >
              <SaveIcon />
            </button>

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
              // When connected, Build & Send stays available even during Simulation /
              // while running — it confirms (and restarts the runtime) instead of
              // being blocked. Local Build (not connected) still waits for the sim to stop.
              disabled={!!compileBusy || (isPlcConnected ? false : isRunning)}
              title={
                compileBusy ? 'Compiling…'
                  : isPlcConnected && (isRunning || isSimulationMode) ? 'Build & Send to PLC (runtime is running — you will be asked to confirm)'
                    : isPlcConnected ? 'Build & Send to PLC' : (t('actions.build') || 'Build')
              }
            >
              {compileBusy === 'build' ? <span className="tb-spinner" /> : isPlcConnected ? <UploadIcon /> : <BuildIcon />}
              <span>
                {compileBusy === 'build'
                  ? (isPlcConnected ? 'Building & Sending…' : 'Building…')
                  : isPlcConnected ? 'Build & Send' : (t('actions.build') || 'Build')}
              </span>
            </button>

            {/* Go Live: deploy a hot-swap loader-host to the connected target so
                agent-approved edits apply as ONLINE changes (state preserved, no
                restart) instead of a full Build & Send. Field path only. */}
            {isPlcConnected && (
              <button
                className={`tb-btn tb-text ${fieldHotSwap ? 'tb-toggle-on' : 'tb-toggle-off'}`}
                onClick={fieldHotSwap ? stopHotSwapSession : startHotSwapSession}
                disabled={hotSwapBusy}
                title={
                  hotSwapBusy ? 'Deploying hot-swap runtime…'
                    : fieldHotSwap ? 'Online-change mode is ON — agent edits apply live (state preserved). Click to stop pushing online changes.'
                      : 'Go Live: deploy a hot-swap runtime so edits apply online without a restart (state preserved). Alternative to Build & Send.'
                }
              >
                <BoltIcon />
                <span>{hotSwapBusy ? 'Deploying…' : 'Go Live'}</span>
                <span className={`tb-pill ${fieldHotSwap ? 'on' : ''}`}>{fieldHotSwap ? 'ON' : 'OFF'}</span>
              </button>
            )}

            {/* Hot Reload: appears only while a hot-swap runtime is live AND the
                user has edited logic since the running build — applies the edits
                online (state preserved) via the same guarded path as agent
                edits. Layout changes are refused with the exact reason. */}
            {hotSwapLive && pendingOnlineChange && (
              <button
                className="tb-btn tb-text tb-toggle-on"
                onClick={manualHotReload}
                disabled={hotReloadBusy}
                title="You edited logic while the PLC is running. Apply it live as a hot reload — timers/counters/latches are preserved. Variable/task/UDT changes can't hot-reload and will be refused (use Build & Send)."
              >
                <BoltIcon />
                <span>{hotReloadBusy ? 'Reloading…' : 'Hot Reload'}</span>
              </button>
            )}

            <div className="tb-divider" />

            {/* ── Group: Run ───────────────────────────────────────────── */}
            {/* simCompiling: spinner strictly for the COMPILE phase — once the
                sim is running (isRunning) the button must never look busy, even
                if a stale compileBusy survived an HMR/interrupted handler. */}
            {(() => { const simCompiling = compileBusy === 'sim' && !isRunning; return (
            <button
              className={`tb-btn tb-text ${isSimulationMode ? 'tb-toggle-on' : 'tb-toggle-off'}`}
              onClick={handleToggleSimulation}
              disabled={isRunning || !!compileBusy}
              title={simCompiling ? 'Compiling simulation…' : 'Toggle Simulation Mode'}
            >
              {simCompiling ? <span className="tb-spinner" /> : <FlaskIcon />}
              <span>{simCompiling ? 'Compiling…' : 'Simulation'}</span>
              {!simCompiling && (
                <span className={`tb-pill ${isSimulationMode ? 'on' : ''}`}>
                  {isSimulationMode ? 'ON' : 'OFF'}
                </span>
              )}
            </button>
            ); })()}
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
                tabs={displayTabs}
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
                          allowLiveEdit={hotSwapLive}
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
                  onAskAgent={askAgentAbout}
                />
              </div>

            </div>

            {/* RIGHT SIDEBAR — always present (Kütüphane + PLC Agent are always available) */}
            <>
                {/* RESIZER (RIGHT) */}
                <div
                  onMouseDown={() => startResizing('right')}
                  style={{ width: 5, cursor: 'col-resize', background: isResizing === 'right' ? '#007acc' : '#1e1e1e', zIndex: 10, flexShrink: 0, borderLeft: '1px solid #333' }}
                />

                <div style={{ width: layout.rightWidth, display: 'flex', flexDirection: 'column', background: '#252526', borderLeft: '1px solid #333' }}>
                  {/* Tab strip: Kütüphane (blocks) | PLC Agent */}
                  <div style={{ display: 'flex', background: '#2d2d2d', borderBottom: '1px solid #1e1e1e', flexShrink: 0, height: 32 }}>
                    {[
                      { id: 'blocks', label: t('common.library') || 'Library', icon: '📦' },
                      { id: 'agent', label: 'PLC Agent', icon: '🤖' },
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
                  {/* Kept MOUNTED (display:none when hidden) like the blocks tab —
                      NOT `rightTab==='agent' && …`. Conditional mount unmounted the
                      agent on every tab switch, wiping its in-memory `pending`
                      approval; the mount-restore then marked the un-approved
                      proposal "rejected" and the Accept/Reject buttons vanished. */}
                  {agentEverOpened && (
                    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: rightTab === 'agent' ? 'flex' : 'none', flexDirection: 'column' }}>
                      <AiAgentPanel
                        activeItem={activeItem}
                        projectStructure={projectStructure}
                        setProjectStructure={setProjectStructure}
                        selectedBoard={selectedBoard}
                        libraryData={libraryData}
                        liveVariables={(isSimulationMode || isRunning) ? (liveVariables || {}) : null}
                        onApplied={handleAgentApplied}
                        onHotSwap={handleAgentHotSwap}
                        hotSwapActive={isHotSwap}
                        onStartHotSwap={startHotSwapSession}
                        onStopHotSwap={stopHotSwapSession}
                        onCheckCompile={handleAgentCheckCompile}
                        askRequest={agentAsk}
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

      <SavePathModal
        isOpen={!!pathPickerRequest}
        mode={pathPickerRequest?.mode}
        suggestedName={pathPickerRequest?.suggestedName}
        initialPath={pathPickerRequest?.initialPath}
        onConfirm={(path) => {
          pathPickerRequest?.resolve(path);
          setPathPickerRequest(null);
        }}
        onCancel={() => {
          pathPickerRequest?.resolve(null);
          setPathPickerRequest(null);
        }}
      />

    </div>
  );
}

export default App;
