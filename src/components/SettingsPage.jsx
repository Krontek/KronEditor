import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Editor } from '@monaco-editor/react';
import { transpileToC } from '../services/CTranspilerService';
import { HostClient, host } from '../services/HostClient';
import { openFile } from '../services/browserFs';
import PasswordInput from './common/PasswordInput';
import DeviceScanModal from './DeviceScanModal';
import { APP_VERSION } from '../version';

// ⚠️ KronHAL is NOT a separate repo any more — the HAL headers (kronhal_rpi.h
// etc.) live only in resources/krontek-include/HAL/ and are edited there /
// mirrored from KrontekLibraries (CLAUDE.md §1), never fetched by this build.
const KRON_REPOS = [
    'KronStandard', 'KronControl', 'KronCompare', 'KronConverter',
    'KronMathematic', 'KronCommunication', 'KronLogic', 'KronMotion',
    'KronEthercatMaster',
];

const SettingsPage = ({ theme, setTheme, editorSettings, setEditorSettings, selectedBoard, plcAddress, setPlcAddress, sshUser: sshUserProp, setSshUser: setSshUserProp, sshPort: sshPortProp, setSshPort: setSshPortProp, apiPassword, setApiPassword, isPlcConnected, setConnectionEnabled, esiLibrary = [], onLoadEsiFile, projectStructure, buses, busConfigs }) => {
    const { t, i18n } = useTranslation();
    const [activeTab, setActiveTab] = useState('general');
    const [isUpdating, setIsUpdating] = useState(false);
    const [progressLog, setProgressLog] = useState('');
    const [selectedRepos, setSelectedRepos] = useState([...KRON_REPOS]);
    const logRef = useRef(null);

    // ── Transpiler debug panel state (DEV only) ──────────────────────────────
    const [transpilerOut, setTranspilerOut] = useState({ header: '', source: '' });
    const [transpilerTab, setTranspilerTab] = useState('header');
    const [buildLog, setBuildLog] = useState('');
    const [isBuildRunning, setIsBuildRunning] = useState(false);
    const buildLogRef = useRef(null);
    const unlistenRef = useRef(null);

    // Connection state
    const [connIp, setConnIp] = useState(() => {
        const saved = localStorage.getItem('plcAddress') || '';
        const parts = saved.split(':');
        return parts[0] || '';
    });
    const [connPort, setConnPort] = useState(() => {
        const saved = localStorage.getItem('plcAddress') || '';
        const parts = saved.split(':');
        return parts[1] || '7070';
    });
    const [connStatus, setConnStatus] = useState(null); // null | 'checking' | 'connected' | 'failed' | 'disconnected'

    // ── Network device search (pick an interface, scan its subnet) ──────────
    const [netIfaces, setNetIfaces] = useState([]); // [{name, ipv4, cidr}]
    const [scanIface, setScanIface] = useState('');
    const [scanModalOpen, setScanModalOpen] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [scanProgress, setScanProgress] = useState({ scanned: 0, total: 0 });
    const [scanResults, setScanResults] = useState([]);
    const scanStopRef = useRef(null);

    useEffect(() => {
        host.listNetworkInterfaceDetails().then((list) => {
            setNetIfaces(list);
            setScanIface((prev) => prev || (list[0]?.name ?? ''));
        }).catch((err) => {
            // Host agent unreachable (or briefly restarting) — Search stays
            // disabled. Logged (not silent) so "No interfaces found" is
            // diagnosable instead of looking like a missing feature; reopening
            // this tab re-runs the probe since SettingsPage remounts per open.
            console.error('[SettingsPage] listNetworkInterfaceDetails failed:', err);
        });
    }, []);

    const handleSearchDevices = () => {
        if (!scanIface || scanning) return;
        setScanResults([]);
        setScanProgress({ scanned: 0, total: 0 });
        setScanning(true);
        setScanModalOpen(true);
        const stop = host.streamEvents((msg) => {
            if (msg?.topic === 'network-scan-progress') {
                setScanProgress({ scanned: msg.data.scanned, total: msg.data.total });
                if (msg.data.found) {
                    setScanResults((prev) => [...prev, msg.data.found]);
                }
            } else if (msg?.topic === 'network-scan-done') {
                setScanning(false);
                stop();
                scanStopRef.current = null;
            }
        });
        scanStopRef.current = stop;
        host.scanNetwork({ interfaceName: scanIface, port: parseInt(connPort, 10) || 7070 })
            .then((res) => setScanProgress((prev) => ({ ...prev, total: res.total || prev.total })))
            .catch((err) => {
                setScanning(false);
                stop();
                scanStopRef.current = null;
                setScanModalOpen(false);
                alert('Scan failed: ' + (err.message || err));
            });
    };

    const handleCloseScanModal = () => {
        if (scanStopRef.current) { scanStopRef.current(); scanStopRef.current = null; }
        // Stop the backend's remaining probes too, not just our SSE listener —
        // otherwise up to scanConcurrency in-flight requests keep going out at
        // the target port for a few more seconds after the popup is gone,
        // which is exactly what was making a just-established connection's
        // status poll miss a beat and flap the toolbar indicator.
        host.cancelNetworkScan().catch(() => {});
        setScanning(false);
        setScanModalOpen(false);
    };

    const handleSelectScanResult = (h) => {
        setConnIp(h.ip);
        setConnPort(String(h.port));
        handleCloseScanModal();
    };

    // Unmounting mid-scan (e.g. leaving the Settings page): stop listening so
    // a stray SSE update never fires into an unmounted component, and cancel
    // the backend job itself (host-agent netscan.go) so it doesn't keep
    // probing the target port after nothing is watching it any more.
    useEffect(() => () => {
        if (scanStopRef.current) scanStopRef.current();
        host.cancelNetworkScan().catch(() => {});
    }, []);

    // ── Lossless capture buffer (ring) sizing ────────────────────────────────
    const [ringInfo, setRingInfo] = useState(null); // { mem_total_bytes, mem_available_bytes, ring_ram_percent, ring_bytes }
    const [ringPct, setRingPct] = useState('');      // user input, % of available RAM
    const [ringMsg, setRingMsg] = useState('');
    const [ringBusy, setRingBusy] = useState(false);

    const fmtBytes = (b) => {
        if (!b || b <= 0) return '—';
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0, v = b;
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
    };

    const refreshRingInfo = async () => {
        if (!plcAddress) return;
        try {
            const st = await host.checkServerStatus(plcAddress);
            if (st && typeof st === 'object') {
                setRingInfo(st);
                if (ringPct === '' && st.ring_ram_percent != null) {
                    setRingPct(st.ring_ram_percent ? String(st.ring_ram_percent) : '');
                }
            }
        } catch { /* not connected — leave info as-is */ }
    };

    // Refresh capture-buffer info when the connection comes up.
    useEffect(() => {
        if (isPlcConnected) refreshRingInfo();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPlcConnected, plcAddress]);

    const applyRingPercent = async () => {
        const p = parseFloat(ringPct);
        if (Number.isNaN(p) || p < 0 || p > 50) {
            setRingMsg(t('settingsPage.capture.range', 'Enter a percentage between 0 and 50.'));
            return;
        }
        setRingBusy(true);
        setRingMsg('');
        try {
            const res = await fetch(`http://${plcAddress}/deploy/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ring_ram_percent: p }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setRingMsg(t('settingsPage.capture.applied', 'Applied. Takes effect on the next runtime (re)start.'));
            await refreshRingInfo();
        } catch (e) {
            setRingMsg(`${t('settingsPage.capture.failed', 'Failed')}: ${e.message}`);
        } finally {
            setRingBusy(false);
        }
    };

    // Derived: how long a link stall the resolved ring absorbs before it laps.
    // The server reports the project's real ring byte-rate on /status, so this is
    // a division rather than an estimate.
    //
    // ⚠️ It used to be guessed client-side as (8 bytes x addressed var count) /
    // task period, which ignored the 16-byte record header and so read ~3x too
    // optimistic for a single 8-byte variable. Never re-derive the rate here.
    const ringSeconds = (() => {
        const rate = ringInfo?.ring_produced_bytes_per_sec;
        if (!ringInfo?.ring_bytes || !rate || rate <= 0) return null;
        return ringInfo.ring_bytes / rate;
    })();

    // ── Host-agent PoC (temporary — remove after migration) ──────────────────
    const [hostBuildStatus, setHostBuildStatus] = useState(null); // null | 'running' | 'ok' | 'fail'
    const [hostBuildLog, setHostBuildLog] = useState('');
    const handleTestHostBuild = async () => {
        setHostBuildStatus('running');
        setHostBuildLog('');
        try {
            const client = new HostClient();
            const health = await client.health();
            const helloC = `#include <stdio.h>\nint main(void){ printf("hello from host-agent build\\n"); return 0; }\n`;
            const result = await client.build({
                sources: { 'hello.c': helloC },
                output: 'hello',
            });
            const ok = result.ok === true;
            setHostBuildStatus(ok ? 'ok' : 'fail');
            setHostBuildLog(
                `agent: ${JSON.stringify(health)}\n` +
                `buildDir: ${result.buildDir || '(none)'}\n` +
                `binary: ${result.binaryPath || '(none)'}\n` +
                `error: ${result.error || '(none)'}\n` +
                `--- compiler log ---\n${result.log || '(empty)'}`
            );
        } catch (err) {
            setHostBuildStatus('fail');
            setHostBuildLog(`error: ${err.message}`);
        }
    };

    // Sync connStatus with live connection state when entering the page
    useEffect(() => {
        if (isPlcConnected) {
            setConnStatus('connected');
        } else if (connStatus === 'connected') {
            setConnStatus('disconnected');
        }
    }, [isPlcConnected]);
    const [sshUser, setSshUser] = useState(() => sshUserProp || localStorage.getItem('sshUser') || 'pi');
    const [sshPass, setSshPass] = useState('');
    const [sshPort, setSshPort] = useState(() => sshPortProp || localStorage.getItem('sshPort') || '22');
    const [isDeploying, setIsDeploying] = useState(false);

    // Sync connection fields when project is loaded (props change)
    useEffect(() => {
        if (plcAddress) {
            const parts = plcAddress.split(':');
            setConnIp(parts[0] || '');
            setConnPort(parts[1] || '7070');
        }
    }, [plcAddress]);

    useEffect(() => {
        if (sshUserProp) setSshUser(sshUserProp);
    }, [sshUserProp]);

    useEffect(() => {
        if (sshPortProp) setSshPort(sshPortProp);
    }, [sshPortProp]);

    const handleRepoSelection = (repo) => {
        if (selectedRepos.includes(repo)) {
            setSelectedRepos(selectedRepos.filter(r => r !== repo));
        } else {
            setSelectedRepos([...selectedRepos, repo]);
        }
    };

    useEffect(() => {
        return () => {
            if (unlistenRef.current) {
                unlistenRef.current();
            }
        };
    }, []);

    // Helper: subscribe to host-agent SSE for build/update progress topics.
    // Mirrors the pattern of the old Tauri `listen('topic', cb)` flow but
    // multiplexes over the single /api/host/events stream.
    const subscribeProgress = (topicProgress, topicDone, onDone) => {
        const stop = host.streamEvents((msg) => {
            if (!msg || !msg.topic) return;
            if (msg.topic === topicProgress) {
                setProgressLog(prev => prev + String(msg.data) + '\n');
            } else if (msg.topic === topicDone) {
                const { success, message } = msg.data || {};
                setProgressLog(prev => prev + (success ? '✓ ' : '✗ ') + (message || '') + '\n');
                setIsUpdating(false);
                stop();
                unlistenRef.current = null;
                if (onDone) onDone();
            }
        });
        unlistenRef.current = stop;
    };

    useEffect(() => {
        if (logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
        }
    }, [progressLog]);

    // ── Transpiler debug handlers ────────────────────────────────────────────
    const handleTranspile = async () => {
        try {
            const standardHeaders = await host.getStandardHeaders().catch(() => []);
            const result = transpileToC(projectStructure || {}, standardHeaders, selectedBoard, true, buses || [], busConfigs || {});
            setTranspilerOut({ header: result.header || '', source: result.source || '' });
        } catch (err) {
            setTranspilerOut({ header: '// Error: ' + (err.message || err), source: '' });
        }
    };

    const handleDevBuild = async () => {
        setIsBuildRunning(true);
        setBuildLog('Starting build → runtime2.bin...\n');
        try {
            const standardHeaders = await host.getStandardHeaders().catch(() => []);
            const result = transpileToC(projectStructure || {}, standardHeaders, selectedBoard, false, buses || [], busConfigs || {});
            setTranspilerOut({ header: result.header || '', source: result.source || '' });
            setBuildLog(prev => prev + 'Transpile OK. Cross-compiling...\n');

            const outPath = await host.compileForTarget({
                header: result.header,
                source: result.source,
                variableTable: JSON.stringify(result.variableTable || {}, null, 2),
                hal: result.hal || '',
                boardId: selectedBoard,
                outputName: 'runtime2.bin',
            });
            setBuildLog(prev => prev + `✓ Built: ${outPath}\n`);
        } catch (err) {
            setBuildLog(prev => prev + '✗ ' + String(err.message || err) + '\n');
        } finally {
            setIsBuildRunning(false);
            if (buildLogRef.current) buildLogRef.current.scrollTop = buildLogRef.current.scrollHeight;
        }
    };

    const handleTranspilerCodeChange = (value) => {
        const nextValue = value ?? '';
        setTranspilerOut(prev => (
            transpilerTab === 'header'
                ? { ...prev, header: nextValue }
                : { ...prev, source: nextValue }
        ));
    };

    const handleUpdateLibraries = async () => {
        setIsUpdating(true);
        setProgressLog('Starting library build for all targets...\n');
        setProgressLog(prev => prev + 'Targets: x86_64/linux (Clang), x86_64/win32 (Clang + llvm-mingw sysroot), arm/linux (aarch64/armv7 via Clang), arm/CortexM/M0, M4, M7 (Clang + arm-none-eabi sysroot)\n\n');
        subscribeProgress('library-update-progress', 'library-update-done');
        host.updateLibraries(selectedRepos).catch(err => {
            setProgressLog(prev => prev + 'Error: ' + (err.message || err) + '\n');
            setIsUpdating(false);
            if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null; }
        });
    };

    const handleBuildCanopen = async () => {
        setIsUpdating(true);
        setProgressLog('Starting CANopen build (cloning + compiling for all toolchains)...\n');
        subscribeProgress('library-update-progress', 'library-update-done');
        host.buildCanopen().catch(err => {
            setProgressLog(prev => prev + 'Error: ' + (err.message || err) + '\n');
            setIsUpdating(false);
            if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null; }
        });
    };


    const handleUpdateServer = async () => {
        setIsUpdating(true);
        setProgressLog('Starting KronServer build...\n');
        subscribeProgress('server-update-progress', 'server-update-done');
        host.updateServer().catch(err => {
            setProgressLog(prev => prev + 'Error: ' + (err.message || err) + '\n');
            setIsUpdating(false);
            if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null; }
        });
    };

    const handleConnect = async () => {
        if (!connIp) return;
        const addr = `${connIp}:${connPort}`;
        setConnStatus('checking');
        try {
            await host.checkServerStatus(addr);
            setConnStatus('connected');
            localStorage.setItem('plcAddress', addr);
            if (setPlcAddress) setPlcAddress(addr);
            if (setConnectionEnabled) setConnectionEnabled(true);
        } catch {
            setConnStatus('failed');
        }
    };

    const handleDisconnect = () => {
        if (setConnectionEnabled) setConnectionEnabled(false);
        setConnStatus('disconnected');
    };

    const handleSaveConnection = () => {
        const addr = connIp ? `${connIp}:${connPort}` : '';
        localStorage.setItem('plcAddress', addr);
        localStorage.setItem('sshUser', sshUser);
        localStorage.setItem('sshPort', sshPort);
        if (setPlcAddress) setPlcAddress(addr);
        if (setSshUserProp) setSshUserProp(sshUser);
        if (setSshPortProp) setSshPortProp(sshPort);
    };

    const handleDeployServer = async () => {
        if (!connIp || !selectedBoard) return;
        setIsDeploying(true);
        setProgressLog('');

        const stopProgress = host.streamEvents((msg) => {
            if (msg?.topic === 'server-deploy-progress') {
                setProgressLog(prev => prev + String(msg.data) + '\n');
            }
        });

        try {
            await host.deployServerToTarget({
                host: connIp,
                port: parseInt(sshPort) || 22,
                username: sshUser,
                password: sshPass,
                boardId: selectedBoard,
            });
            setProgressLog(prev => prev + '✓ Server deployed successfully!\n');
            setConnStatus('connected');
            const addr = `${connIp}:${connPort}`;
            localStorage.setItem('plcAddress', addr);
            if (setPlcAddress) setPlcAddress(addr);
        } catch (err) {
            setProgressLog(prev => prev + '✗ Deploy failed: ' + (err.message || err) + '\n');
        } finally {
            setIsDeploying(false);
            stopProgress();
        }
    };

    const [esiLoadError, setEsiLoadError] = useState(null);
    const [esiLoadLog, setEsiLoadLog] = useState('');

    const handleLoadEsiFileClick = async () => {
        setEsiLoadError(null);
        setEsiLoadLog('');
        try {
            const picked = await openFile({ accept: '.xml,.XML' });
            if (!picked) return;
            await onLoadEsiFile?.(picked.name, picked.content);
            setEsiLoadLog(`Loaded: ${picked.name}`);
        } catch (e) {
            setEsiLoadError('Error: ' + (e.message || e));
        }
    };

    const tabs = [
        { id: 'general', label: t('settingsPage.general'), icon: '⚙️' },
        { id: 'editor', label: t('settingsPage.editor'), icon: '📝' },
        { id: 'connection', label: t('settingsPage.connection', 'Connection'), icon: '🔌' },
        { id: 'hmi', label: 'HMI', icon: '📊' },
        { id: 'fieldbus', label: 'Fieldbus', icon: '⊕' },
        ...(import.meta.env.DEV ? [{ id: 'libraries', label: 'Libraries', icon: '📦' }] : []),
        { id: 'about', label: t('settingsPage.about'), icon: 'ℹ️' }
    ];

    const changeLanguage = (lng) => {
        i18n.changeLanguage(lng);
    };

    const renderContent = () => {
        switch (activeTab) {
            case 'general':
                return (
                    <div style={{ maxWidth: '600px' }}>
                        <div style={{ marginBottom: '25px' }}>
                            <h3 style={{ borderBottom: '1px solid #444', paddingBottom: '10px', marginTop: 0 }}>{t('common.language')}</h3>
                            <div style={{ display: 'flex', gap: '10px' }}>
                                {[
                                    { code: 'en', label: 'English' },
                                    { code: 'tr', label: 'Türkçe' },
                                    { code: 'ru', label: 'Русский' },
                                ].map(({ code, label }) => {
                                    const active = (i18n.resolvedLanguage || i18n.language || 'en') === code;
                                    return (
                                        <button
                                            key={code}
                                            onClick={() => changeLanguage(code)}
                                            style={{
                                                flex: 1, padding: '10px',
                                                backgroundColor: active ? '#0e639c' : '#2d2d2d',
                                                color: active ? '#fff' : '#ccc',
                                                border: `1px solid ${active ? '#1177bb' : '#444'}`,
                                                borderRadius: '4px',
                                                cursor: 'pointer',
                                                fontWeight: active ? 600 : 400,
                                                transition: 'background 0.1s, border-color 0.1s',
                                            }}
                                        >
                                            <span style={{
                                                display: 'inline-block',
                                                fontFamily: 'monospace',
                                                fontSize: 11,
                                                opacity: 0.7,
                                                marginRight: 6,
                                                letterSpacing: '0.05em',
                                            }}>{code.toUpperCase()}</span>
                                            {label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        <div style={{ marginBottom: '25px' }}>
                            <h3 style={{ borderBottom: '1px solid #444', paddingBottom: '10px' }}>{t('settingsPage.theme')}</h3>
                            <div style={{ display: 'flex', gap: '10px' }}>
                                <button
                                    onClick={() => setTheme('dark')}
                                    style={{
                                        flex: 1, padding: '10px',
                                        backgroundColor: theme === 'dark' ? '#007acc' : '#2d2d2d',
                                        color: '#fff', border: '1px solid #444', borderRadius: '4px', cursor: 'pointer'
                                    }}
                                >
                                    🌑 {t('settingsPage.dark')}
                                </button>
                                <button
                                    onClick={() => setTheme('light')}
                                    style={{
                                        flex: 1, padding: '10px',
                                        backgroundColor: theme === 'light' ? '#007acc' : '#2d2d2d',
                                        color: '#fff', border: '1px solid #444', borderRadius: '4px', cursor: 'pointer'
                                    }}
                                >
                                    ☀️ {t('settingsPage.light')}
                                </button>
                                <button
                                    onClick={() => setTheme('auto')}
                                    style={{
                                        flex: 1, padding: '10px',
                                        backgroundColor: theme === 'auto' ? '#007acc' : '#2d2d2d',
                                        color: '#fff', border: '1px solid #444', borderRadius: '4px', cursor: 'pointer'
                                    }}
                                >
                                    💻 {t('settingsPage.auto', 'Auto')}
                                </button>
                            </div>
                        </div>
                    </div>
                );
            case 'editor':
                return (
                    <div style={{ maxWidth: '600px' }}>
                        <div style={{ marginBottom: '25px' }}>
                            <h3 style={{ borderBottom: '1px solid #444', paddingBottom: '10px', marginTop: 0 }}>{t('settingsPage.editorConfiguration')}</h3>

                            <div style={{ marginBottom: '15px' }}>
                                <label style={{ display: 'block', marginBottom: '8px', color: '#ccc' }}>{t('settingsPage.fontSize')}</label>
                                <select
                                    value={editorSettings.fontSize}
                                    onChange={(e) => setEditorSettings({ ...editorSettings, fontSize: parseInt(e.target.value) })}
                                    style={{ width: '100%', padding: '8px', background: '#252526', color: '#fff', border: '1px solid #444', borderRadius: '4px' }}
                                >
                                    <option value={12}>12px</option>
                                    <option value={14}>14px</option>
                                    <option value={16}>16px</option>
                                    <option value={18}>18px</option>
                                    <option value={20}>20px</option>
                                </select>
                            </div>

                            <div style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <input
                                    type="checkbox"
                                    checked={editorSettings.minimap}
                                    onChange={(e) => setEditorSettings({ ...editorSettings, minimap: e.target.checked })}
                                    id="minimap-check"
                                />
                                <label htmlFor="minimap-check" style={{ color: '#ccc', cursor: 'pointer' }}>{t('settingsPage.showMinimap')}</label>
                            </div>

                            <div style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <input
                                    type="checkbox"
                                    checked={editorSettings.wordWrap}
                                    onChange={(e) => setEditorSettings({ ...editorSettings, wordWrap: e.target.checked })}
                                    id="wrap-check"
                                />
                                <label htmlFor="wrap-check" style={{ color: '#ccc', cursor: 'pointer' }}>{t('settingsPage.wordWrap')}</label>
                            </div>
                        </div>
                    </div>
                );
            case 'connection':
                return (
                    <div style={{ maxWidth: '600px' }}>
                        <h3 style={{ borderBottom: '1px solid #444', paddingBottom: '10px', marginTop: 0 }}>
                            {t('settingsPage.connectionSettings', 'Connection Settings')}
                        </h3>

                        {/* Search: pick the local interface to scan, then find a device on it */}
                        <div style={{ marginBottom: '16px' }}>
                            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
                                <div style={{ flex: 3 }}>
                                    <label style={{ display: 'block', marginBottom: '6px', color: '#ccc', fontSize: '13px' }}>
                                        {t('settingsPage.networkInterface', 'Network Interface')}
                                    </label>
                                    <select
                                        value={scanIface}
                                        onChange={(e) => setScanIface(e.target.value)}
                                        disabled={netIfaces.length === 0}
                                        style={{
                                            width: '100%', padding: '8px', background: '#252526', color: '#fff',
                                            border: '1px solid #444', borderRadius: '4px', boxSizing: 'border-box'
                                        }}
                                    >
                                        {netIfaces.length === 0 && (
                                            <option value="">{t('settingsPage.noInterfaces', 'No interfaces found')}</option>
                                        )}
                                        {netIfaces.map((ifc) => (
                                            <option key={ifc.name} value={ifc.name}>{ifc.name} ({ifc.cidr})</option>
                                        ))}
                                    </select>
                                </div>
                                <div style={{ flex: 1 }}>
                                    <button
                                        onClick={handleSearchDevices}
                                        disabled={!scanIface || scanning}
                                        style={{
                                            width: '100%', padding: '8px 18px', backgroundColor: '#2d2d2d', color: '#ccc',
                                            border: '1px solid #444', borderRadius: '4px',
                                            cursor: (!scanIface || scanning) ? 'not-allowed' : 'pointer',
                                            opacity: (!scanIface || scanning) ? 0.5 : 1,
                                            fontSize: '13px'
                                        }}
                                    >
                                        🔍 {scanning ? t('settingsPage.searching', 'Searching...') : t('settingsPage.search', 'Search')}
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* IP & Port */}
                        <div style={{ marginBottom: '20px' }}>
                            <div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
                                <div style={{ flex: 3 }}>
                                    <label style={{ display: 'block', marginBottom: '6px', color: '#ccc', fontSize: '13px' }}>
                                        {t('settingsPage.ipAddress', 'IP Address')}
                                    </label>
                                    <input
                                        type="text"
                                        value={connIp}
                                        onChange={(e) => setConnIp(e.target.value)}
                                        placeholder="192.168.1.100"
                                        style={{
                                            width: '100%', padding: '8px', background: '#252526', color: '#fff',
                                            border: '1px solid #444', borderRadius: '4px', boxSizing: 'border-box'
                                        }}
                                    />
                                </div>
                                <div style={{ flex: 1 }}>
                                    <label style={{ display: 'block', marginBottom: '6px', color: '#ccc', fontSize: '13px' }}>
                                        {t('settingsPage.port', 'Port')}
                                    </label>
                                    <input
                                        type="text"
                                        value={connPort}
                                        onChange={(e) => setConnPort(e.target.value)}
                                        placeholder="7070"
                                        style={{
                                            width: '100%', padding: '8px', background: '#252526', color: '#fff',
                                            border: '1px solid #444', borderRadius: '4px', boxSizing: 'border-box'
                                        }}
                                    />
                                </div>
                            </div>

                            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                {isPlcConnected ? (
                                    <button
                                        onClick={handleDisconnect}
                                        style={{
                                            padding: '8px 18px', backgroundColor: '#3a1a1a', color: '#f44747',
                                            border: '1px solid #f44747', borderRadius: '4px',
                                            cursor: 'pointer', fontSize: '13px'
                                        }}
                                    >
                                        Disconnect
                                    </button>
                                ) : (
                                    <button
                                        onClick={handleConnect}
                                        disabled={!connIp || connStatus === 'checking'}
                                        style={{
                                            padding: '8px 18px', backgroundColor: '#007acc', color: '#fff',
                                            border: 'none', borderRadius: '4px',
                                            cursor: (!connIp || connStatus === 'checking') ? 'not-allowed' : 'pointer',
                                            opacity: (!connIp || connStatus === 'checking') ? 0.5 : 1,
                                            fontSize: '13px'
                                        }}
                                    >
                                        {connStatus === 'checking' ? 'Connecting...' : 'Connect'}
                                    </button>
                                )}
                                <button
                                    onClick={handleSaveConnection}
                                    style={{
                                        padding: '8px 18px', backgroundColor: '#2d2d2d', color: '#ccc',
                                        border: '1px solid #444', borderRadius: '4px', cursor: 'pointer', fontSize: '13px'
                                    }}
                                >
                                    {t('common.save', 'Save')}
                                </button>
                                {isPlcConnected && (
                                    <span style={{ color: '#4ec9b0', fontSize: '13px' }}>● Connected</span>
                                )}
                                {!isPlcConnected && connStatus === 'disconnected' && (
                                    <span style={{ color: '#888', fontSize: '13px' }}>● Disconnected</span>
                                )}
                                {!isPlcConnected && connStatus === 'failed' && (
                                    <span style={{ color: '#f44747', fontSize: '13px' }}>● Connection Failed</span>
                                )}
                            </div>
                        </div>

                        <div style={{ height: '1px', background: '#333', margin: '20px 0' }} />

                        {/* Lossless capture buffer (ring) sizing */}
                        <h3 style={{ borderBottom: '1px solid #444', paddingBottom: '10px' }}>
                            {t('settingsPage.capture.title', 'Capture Buffer (Lossless)')}
                        </h3>
                        <p style={{ color: '#888', fontSize: '12px', marginBottom: '12px', lineHeight: 1.5 }}>
                            {t('settingsPage.capture.desc',
                                'On-device buffer that lets the REST API stream (/api/v1/stream/ring) capture EVERY scan value of addressed variables with no loss. The buffer is sized automatically from the project\'s capture rate (about 10 s of production); this percentage is only the CEILING it may not exceed (max 50% of available RAM). Raising it does not make the buffer bigger unless the project needs it. Takes effect on the next runtime (re)start.')}
                        </p>
                        {ringInfo && (ringInfo.mem_total_bytes || ringInfo.ring_bytes) ? (
                            <div style={{
                                display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px',
                                fontSize: '12px', color: '#bbb', marginBottom: '12px',
                                background: '#1e1e1e', border: '1px solid #333', borderRadius: '4px', padding: '10px',
                            }}>
                                <span style={{ color: '#888' }}>{t('settingsPage.capture.ramTotal', 'Device RAM (total)')}</span>
                                <span>{fmtBytes(ringInfo.mem_total_bytes)}</span>
                                <span style={{ color: '#888' }}>{t('settingsPage.capture.ramAvail', 'RAM available')}</span>
                                <span>{fmtBytes(ringInfo.mem_available_bytes)}</span>
                                <span style={{ color: '#888' }}>{t('settingsPage.capture.current', 'Current buffer')}</span>
                                <span>
                                    {fmtBytes(ringInfo.ring_bytes)}
                                    {ringInfo.ring_ram_percent ? ` (${ringInfo.ring_ram_percent}% of available)` : ` (${t('settingsPage.capture.default', 'default')})`}
                                    {ringSeconds != null ? ` · ≈ ${ringSeconds >= 1 ? ringSeconds.toFixed(1) + ' s' : (ringSeconds * 1000).toFixed(0) + ' ms'} ${t('settingsPage.capture.stall', 'of link-stall tolerance')}` : ''}
                                </span>
                            </div>
                        ) : (
                            <p style={{ color: '#666', fontSize: '12px', marginBottom: '12px' }}>
                                {t('settingsPage.capture.connectFirst', 'Connect to a device to read its memory and configure the buffer.')}
                            </p>
                        )}
                        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '8px' }}>
                            <label style={{ fontSize: '13px', color: '#ccc' }}>
                                {t('settingsPage.capture.percent', 'Maximum buffer (% of available RAM)')}
                            </label>
                            <input
                                type="number" min="0" max="50" step="0.5"
                                value={ringPct}
                                onChange={(e) => setRingPct(e.target.value)}
                                placeholder="0"
                                style={{
                                    width: '80px', padding: '6px 8px', background: '#2d2d2d', color: '#ddd',
                                    border: '1px solid #444', borderRadius: '4px', fontSize: '13px',
                                }}
                            />
                            <button
                                onClick={applyRingPercent}
                                disabled={ringBusy || !isPlcConnected}
                                style={{
                                    padding: '6px 16px', backgroundColor: '#0e639c', color: '#fff',
                                    border: 'none', borderRadius: '4px', fontSize: '13px',
                                    cursor: (ringBusy || !isPlcConnected) ? 'not-allowed' : 'pointer',
                                    opacity: (ringBusy || !isPlcConnected) ? 0.5 : 1,
                                }}
                            >
                                {ringBusy ? t('common.applying', 'Applying…') : t('common.apply', 'Apply')}
                            </button>
                            <button
                                onClick={refreshRingInfo}
                                disabled={!isPlcConnected}
                                style={{
                                    padding: '6px 12px', backgroundColor: '#2d2d2d', color: '#ccc',
                                    border: '1px solid #444', borderRadius: '4px', fontSize: '13px',
                                    cursor: !isPlcConnected ? 'not-allowed' : 'pointer', opacity: !isPlcConnected ? 0.5 : 1,
                                }}
                            >
                                ⟳ {t('common.refresh', 'Refresh')}
                            </button>
                        </div>
                        {ringMsg && (
                            <p style={{ color: ringMsg.startsWith(t('settingsPage.capture.failed', 'Failed')) ? '#f44747' : '#4ec9b0', fontSize: '12px', margin: '4px 0 0' }}>
                                {ringMsg}
                            </p>
                        )}

                        <div style={{ height: '1px', background: '#333', margin: '20px 0' }} />

                        {/* Host-agent PoC — temporary test panel */}
                        <h3 style={{ borderBottom: '1px solid #444', paddingBottom: '10px' }}>
                            Host Agent (PoC)
                        </h3>
                        <p style={{ color: '#888', fontSize: '12px', marginBottom: '12px' }}>
                            Calls local kron-host-agent on :7171 via Vite proxy. Will be removed after migration.
                        </p>
                        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px' }}>
                            <button
                                onClick={handleTestHostBuild}
                                disabled={hostBuildStatus === 'running'}
                                style={{
                                    padding: '8px 18px',
                                    backgroundColor: '#2d2d2d',
                                    color: '#ccc',
                                    border: '1px solid #444',
                                    borderRadius: '4px',
                                    cursor: hostBuildStatus === 'running' ? 'not-allowed' : 'pointer',
                                    fontSize: '13px',
                                }}
                            >
                                {hostBuildStatus === 'running' ? 'Building…' : 'Test Host Build'}
                            </button>
                            {hostBuildStatus === 'ok' && (
                                <span style={{ color: '#4ec9b0', fontSize: '13px' }}>● Build OK</span>
                            )}
                            {hostBuildStatus === 'fail' && (
                                <span style={{ color: '#f44747', fontSize: '13px' }}>● Build Failed</span>
                            )}
                        </div>
                        {hostBuildLog && (
                            <pre style={{
                                background: '#1e1e1e',
                                color: '#ccc',
                                padding: '10px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                maxHeight: '200px',
                                overflow: 'auto',
                                whiteSpace: 'pre-wrap',
                                border: '1px solid #333',
                            }}>{hostBuildLog}</pre>
                        )}

                        <div style={{ height: '1px', background: '#333', margin: '20px 0' }} />

                        {/* SSH Settings for Server Deploy */}
                        <h3 style={{ borderBottom: '1px solid #444', paddingBottom: '10px' }}>
                            {t('settingsPage.serverDeploy', 'Deploy Server to Target')}
                        </h3>
                        <p style={{ color: '#888', fontSize: '12px', marginBottom: '16px' }}>
                            {t('settingsPage.serverDeployDesc', 'Upload and start plc-agent on the target board via SSH.')}
                        </p>

                        <div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
                            <div style={{ flex: 2 }}>
                                <label style={{ display: 'block', marginBottom: '6px', color: '#ccc', fontSize: '13px' }}>
                                    {t('settingsPage.sshUsername', 'SSH Username')}
                                </label>
                                <input
                                    type="text"
                                    value={sshUser}
                                    onChange={(e) => {
                                        setSshUser(e.target.value);
                                        if (setSshUserProp) setSshUserProp(e.target.value);
                                        localStorage.setItem('sshUser', e.target.value);
                                    }}
                                    placeholder="pi"
                                    style={{
                                        width: '100%', padding: '8px', background: '#252526', color: '#fff',
                                        border: '1px solid #444', borderRadius: '4px', boxSizing: 'border-box'
                                    }}
                                />
                            </div>
                            <div style={{ flex: 2 }}>
                                <label style={{ display: 'block', marginBottom: '6px', color: '#ccc', fontSize: '13px' }}>
                                    {t('settingsPage.sshPassword', 'SSH Password')}
                                </label>
                                <PasswordInput
                                    value={sshPass}
                                    onChange={(e) => setSshPass(e.target.value)}
                                    placeholder="••••••"
                                    showTitle={t('settingsPage.showPassword', 'Show password')}
                                    hideTitle={t('settingsPage.hidePassword', 'Hide password')}
                                    style={{
                                        width: '100%', padding: '8px', background: '#252526', color: '#fff',
                                        border: '1px solid #444', borderRadius: '4px', boxSizing: 'border-box'
                                    }}
                                />
                            </div>
                            <div style={{ flex: 1 }}>
                                <label style={{ display: 'block', marginBottom: '6px', color: '#ccc', fontSize: '13px' }}>
                                    {t('settingsPage.sshPort', 'SSH Port')}
                                </label>
                                <input
                                    type="text"
                                    value={sshPort}
                                    onChange={(e) => {
                                        setSshPort(e.target.value);
                                        if (setSshPortProp) setSshPortProp(e.target.value);
                                        localStorage.setItem('sshPort', e.target.value);
                                    }}
                                    placeholder="22"
                                    style={{
                                        width: '100%', padding: '8px', background: '#252526', color: '#fff',
                                        border: '1px solid #444', borderRadius: '4px', boxSizing: 'border-box'
                                    }}
                                />
                            </div>
                        </div>

                        {/* API Password */}
                        <div style={{ marginBottom: '16px' }}>
                            <label style={{ display: 'block', marginBottom: '6px', color: '#ccc', fontSize: '13px' }}>
                                API Password
                            </label>
                            <PasswordInput
                                value={apiPassword || ''}
                                onChange={(e) => { if (setApiPassword) setApiPassword(e.target.value); }}
                                placeholder="Default: krontek"
                                showTitle={t('settingsPage.showPassword', 'Show password')}
                                hideTitle={t('settingsPage.hidePassword', 'Hide password')}
                                style={{
                                    width: '100%', padding: '8px', background: '#252526', color: '#fff',
                                    border: '1px solid #444', borderRadius: '4px', boxSizing: 'border-box'
                                }}
                            />
                            <span style={{ fontSize: '11px', color: '#888', marginTop: '4px', display: 'block' }}>
                                Password for external REST API access to addressed variables. Leave empty to disable API.
                            </span>
                        </div>

                        <button
                            onClick={handleDeployServer}
                            disabled={isDeploying || !connIp || !selectedBoard}
                            style={{
                                padding: '10px 20px', backgroundColor: isDeploying ? '#444' : '#0d47a1',
                                color: '#fff', border: 'none', borderRadius: '4px',
                                cursor: (isDeploying || !connIp || !selectedBoard) ? 'not-allowed' : 'pointer',
                                width: '100%', fontSize: '14px', marginBottom: '16px'
                            }}
                        >
                            {isDeploying ? 'Deploying...' : (t('settingsPage.deployServer', 'Deploy Server'))}
                        </button>

                        {!selectedBoard && (
                            <p style={{ color: '#f44747', fontSize: '12px' }}>
                                {t('settingsPage.noBoardSelected', 'Please select a board first (create or open a project).')}
                            </p>
                        )}

                        {progressLog && (
                            <textarea
                                ref={logRef}
                                value={progressLog}
                                readOnly
                                style={{
                                    width: '100%', height: '200px', background: '#0d0d0d', color: '#4ec9b0',
                                    border: '1px solid #333', borderRadius: '4px', padding: '10px',
                                    fontFamily: 'monospace', fontSize: '12px', resize: 'none', boxSizing: 'border-box'
                                }}
                            />
                        )}
                    </div>
                );
            case 'libraries':
                return (
                    <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start' }}>

                        {/* ── Left: Kron Libraries ── */}
                        <div style={{ width: '280px', flexShrink: 0 }}>
                            <h3 style={{ borderBottom: '1px solid #444', paddingBottom: '10px', marginTop: 0 }}>
                                Kron Libraries
                            </h3>
                            <div style={{ marginBottom: '20px', background: '#252526', borderRadius: '4px', padding: '4px 12px' }}>
                                {KRON_REPOS.map((repo, i) => (
                                    <div key={repo} style={{
                                        padding: '8px 0', color: '#ccc', fontSize: '13px',
                                        borderBottom: i < KRON_REPOS.length - 1 ? '1px solid #333' : 'none',
                                        display: 'flex', alignItems: 'center', gap: '8px'
                                    }}>
                                        <input
                                            type="checkbox"
                                            checked={selectedRepos.includes(repo)}
                                            onChange={() => handleRepoSelection(repo)}
                                            disabled={isUpdating}
                                            style={{ cursor: isUpdating ? 'not-allowed' : 'pointer', margin: 0 }}
                                        />
                                        <span style={{ color: '#888' }}>github.com/Krontek/</span>
                                        <span style={{ color: '#9cdcfe' }}>{repo}</span>
                                    </div>
                                ))}
                            </div>
                            {[
                                { label: t('settingsPage.buildLibraries'), handler: handleUpdateLibraries, color: '#007acc' },
                                { label: t('settingsPage.buildServer'),    handler: handleUpdateServer,    color: '#0d47a1' },
                                { label: t('settingsPage.buildCanopen'),   handler: handleBuildCanopen,    color: '#0d47a1' },
                            ].map(({ label, handler, color }) => (
                                <button key={label} onClick={handler} disabled={isUpdating} style={{
                                    padding: '10px 20px', backgroundColor: isUpdating ? '#444' : color,
                                    color: '#fff', border: 'none', borderRadius: '4px',
                                    cursor: isUpdating ? 'not-allowed' : 'pointer',
                                    marginBottom: '8px', width: '100%', fontSize: '14px'
                                }}>
                                    {isUpdating ? 'Building...' : label}
                                </button>
                            ))}
                            {progressLog && (
                                <textarea
                                    ref={logRef}
                                    value={progressLog}
                                    readOnly
                                    style={{
                                        width: '100%', height: '260px', background: '#0d0d0d',
                                        color: '#4ec9b0', border: '1px solid #333', borderRadius: '4px',
                                        padding: '10px', fontFamily: 'monospace', fontSize: '12px',
                                        resize: 'none', boxSizing: 'border-box', marginTop: '8px'
                                    }}
                                />
                            )}
                        </div>

                        {/* ── Right: Transpiler Debug ── */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <h3 style={{ borderBottom: '1px solid #444', paddingBottom: '10px', marginTop: 0 }}>
                                Transpiler Debug
                            </h3>
                            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                                <button
                                    onClick={handleTranspile}
                                    style={{
                                        flex: 1, padding: '9px 0', background: '#4a3f7a', color: '#fff',
                                        border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px'
                                    }}
                                >
                                    Transpile to C
                                </button>
                                <button
                                    onClick={handleDevBuild}
                                    disabled={isBuildRunning}
                                    style={{
                                        flex: 1, padding: '9px 0',
                                        background: isBuildRunning ? '#444' : '#1b5e20',
                                        color: '#fff', border: 'none', borderRadius: '4px',
                                        cursor: isBuildRunning ? 'not-allowed' : 'pointer', fontSize: '13px'
                                    }}
                                >
                                    {isBuildRunning ? 'Building...' : 'Build'}
                                </button>
                            </div>

                            {/* Tab bar always visible */}
                            <div style={{ display: 'flex', borderBottom: '1px solid #444' }}>
                                {['header', 'source'].map(tab => (
                                    <div
                                        key={tab}
                                        onClick={() => setTranspilerTab(tab)}
                                        style={{
                                            padding: '6px 16px', cursor: 'pointer', fontSize: '12px',
                                            color: transpilerTab === tab ? '#fff' : '#888',
                                            borderBottom: transpilerTab === tab ? '2px solid #007acc' : '2px solid transparent',
                                            userSelect: 'none'
                                        }}
                                    >
                                        {tab === 'header' ? 'plc.h' : 'plc.c'}
                                    </div>
                                ))}
                            </div>
                            <div style={{ border: '1px solid #444', borderTop: 'none', height: '480px' }}>
                                <Editor
                                    language="c"
                                    theme="vs-dark"
                                    value={transpilerTab === 'header' ? transpilerOut.header : transpilerOut.source}
                                    onChange={handleTranspilerCodeChange}
                                    options={{
                                        readOnly: false,
                                        minimap: { enabled: false },
                                        fontSize: 11,
                                        lineNumbers: 'on',
                                        scrollBeyondLastLine: false,
                                        automaticLayout: true,
                                        wordWrap: 'off',
                                    }}
                                />
                            </div>

                            {buildLog && (
                                <textarea
                                    ref={buildLogRef}
                                    value={buildLog}
                                    readOnly
                                    style={{
                                        width: '100%', height: '160px', background: '#0d0d0d',
                                        color: '#4ec9b0', border: '1px solid #333', borderRadius: '4px',
                                        padding: '10px', fontFamily: 'monospace', fontSize: '12px',
                                        resize: 'none', boxSizing: 'border-box', marginTop: '8px'
                                    }}
                                />
                            )}
                        </div>
                    </div>
                );
            case 'fieldbus':
                return (
                    <div style={{ maxWidth: '600px' }}>
                        <h3 style={{ borderBottom: '1px solid #444', paddingBottom: '10px', marginTop: 0 }}>
                            ESI Device Library
                        </h3>
                        <p style={{ color: '#888', fontSize: '12px', marginBottom: '16px' }}>
                            ESI files are stored in the app's local data directory (<code style={{ color: '#9cdcfe' }}>~/.local/share/com.plceditor.app/esi/</code>) and loaded automatically on startup.
                            Devices become available in the EtherCAT Master editor.
                        </p>
                        <button
                            onClick={handleLoadEsiFileClick}
                            style={{
                                padding: '8px 18px', backgroundColor: '#0d47a1', color: '#fff',
                                border: 'none', borderRadius: '4px', cursor: 'pointer',
                                fontSize: '13px', marginBottom: '16px'
                            }}
                        >
                            + Load ESI File
                        </button>
                        {esiLoadLog && (
                            <div style={{ color: '#4caf50', fontSize: '12px', marginBottom: '10px' }}>{esiLoadLog}</div>
                        )}
                        {esiLoadError && (
                            <div style={{ color: '#f44747', fontSize: '12px', marginBottom: '10px' }}>{esiLoadError}</div>
                        )}
                        <div style={{ background: '#252526', border: '1px solid #333', borderRadius: '4px', padding: '8px 12px' }}>
                            <div style={{ color: '#888', fontSize: '11px', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                Loaded Devices ({esiLibrary.length})
                            </div>
                            {esiLibrary.length === 0 ? (
                                <div style={{ color: '#555', fontSize: '12px', padding: '8px 0' }}>No ESI files loaded yet.</div>
                            ) : (
                                esiLibrary.map((dev, i) => (
                                    <div key={i} style={{
                                        padding: '6px 0',
                                        borderBottom: i < esiLibrary.length - 1 ? '1px solid #2a2a2a' : 'none',
                                        display: 'flex', flexDirection: 'column', gap: 2
                                    }}>
                                        <span style={{ color: '#9cdcfe', fontSize: '12px', fontWeight: 'bold' }}>{dev.name}</span>
                                        <span style={{ color: '#555', fontSize: '11px' }}>
                                            {dev.vendorName} · VID:0x{(dev.vendorId ?? 0).toString(16).toUpperCase().padStart(4,'0')}
                                            · PC:0x{(dev.productCode ?? 0).toString(16).toUpperCase().padStart(4,'0')}
                                            {dev._esiFile && <> · <span style={{ color: '#444' }}>{dev._esiFile}</span></>}
                                        </span>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                );
            case 'about':
                return (
                    <div style={{ maxWidth: '600px', textAlign: 'center', padding: '40px 0' }}>
                        <h1>📦 PLC Editor</h1>
                        <p style={{ color: '#aaa' }}>{t('settingsPage.version')} {APP_VERSION}</p>
                        <hr style={{ borderColor: '#333', margin: '20px 0' }} />
                        <p style={{ color: '#ccc' }}>
                            {t('settingsPage.aboutDescription')}
                        </p>
                        <p style={{ marginTop: '20px', fontSize: '12px', color: '#666' }}>
                            {t('settingsPage.copyright')}
                        </p>
                    </div>
                );
            case 'hmi':
                return (
                    <div>
                        <h2 style={{ fontSize: '20px', fontWeight: '600', marginBottom: '24px', color: '#fff' }}>HMI Server</h2>
                        <div style={{ background: '#252526', border: '1px solid #333', borderRadius: 3, padding: '20px', marginBottom: 20 }}>
                            <h3 style={{ fontSize: 13, fontWeight: '600', color: '#aaa', marginBottom: 16, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Web Server Port</h3>
                            <p style={{ fontSize: 12, color: '#666', marginBottom: 14 }}>
                                The HMI visualization is served as a web page at <span style={{ color: '#7eb8f7', fontFamily: 'monospace' }}>http://localhost:[port]</span>.
                                Open this URL in any browser to view the HMI at runtime.
                            </p>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <label style={{ fontSize: 13, color: '#888', minWidth: 80 }}>Port</label>
                                <input
                                    type="number"
                                    min={1024} max={65535}
                                    defaultValue={Number(localStorage.getItem('hmiPort') || '7800')}
                                    onChange={e => {
                                        const v = Math.min(65535, Math.max(1024, Number(e.target.value)));
                                        localStorage.setItem('hmiPort', String(v));
                                    }}
                                    style={{
                                        width: 100, background: '#1a1a1a', border: '1px solid #444',
                                        color: '#d4d4d4', fontSize: 13, padding: '5px 8px', outline: 'none',
                                        borderRadius: 2,
                                    }}
                                    onFocus={e => e.target.style.borderColor = '#007acc'}
                                    onBlur={e => e.target.style.borderColor = '#444'}
                                />
                                <span style={{ fontSize: 11, color: '#555' }}>Restart app to apply port change.</span>
                            </div>
                        </div>

                        <div style={{ background: '#252526', border: '1px solid #333', borderRadius: 3, padding: '20px' }}>
                            <h3 style={{ fontSize: 13, fontWeight: '600', color: '#aaa', marginBottom: 12, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{t('settingsPage.hmiHowToUse')}</h3>
                            <div style={{ fontSize: 12, color: '#666', lineHeight: 1.8 }}>
                                <div>1. {t('settingsPage.hmiStep1')} <span style={{ color: '#c0c0c0' }}>{t('sidebar.visualization')}</span> {t('settingsPage.hmiStep2')}</div>
                                <div>2. {t('settingsPage.hmiStep3')}</div>
                                <div>3. {t('settingsPage.hmiStep4')}</div>
                                <div>4. {t('settingsPage.hmiStep5')} <span style={{ color: '#4ec9b0' }}>🌐 {t('settingsPage.hmiStep6')}</span> {t('settingsPage.hmiStep7')}</div>
                                <div>5. {t('settingsPage.hmiStep8')} <span style={{ color: '#7eb8f7', fontFamily: 'monospace' }}>http://localhost:{Number(localStorage.getItem('hmiPort') || '7800')}</span> {t('settingsPage.hmiStep9')}</div>
                            </div>
                        </div>
                    </div>
                );
            default:
                return null;
        }
    };

    return (
        <div style={{ display: 'flex', height: '100%', background: '#1e1e1e', color: '#fff' }}>
            {/* Sidebar Tabs */}
            <div style={{ width: '200px', borderRight: '1px solid #333', padding: '20px 0', background: '#252526' }}>
                <div style={{ padding: '0 20px 20px 20px', fontSize: '18px', fontWeight: 'bold', color: '#fff', borderBottom: '1px solid #333', marginBottom: '10px' }}>
                    {t('common.settings')}
                </div>
                {tabs.map(tab => (
                    <div
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        style={{
                            padding: '12px 20px',
                            cursor: 'pointer',
                            backgroundColor: activeTab === tab.id ? '#37373d' : 'transparent',
                            borderLeft: activeTab === tab.id ? '3px solid #007acc' : '3px solid transparent',
                            color: activeTab === tab.id ? '#fff' : '#aaa',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            transition: 'all 0.2s'
                        }}
                    >
                        <span>{tab.icon}</span>
                        {tab.label}
                    </div>
                ))}
            </div>

            {/* Content Area */}
            <div style={{ flex: 1, padding: '40px', overflowY: 'auto' }}>
                {renderContent()}
            </div>

            <DeviceScanModal
                isOpen={scanModalOpen}
                scanning={scanning}
                progress={scanProgress}
                results={scanResults}
                onSelect={handleSelectScanResult}
                onClose={handleCloseScanModal}
            />
        </div>
    );
};

export default SettingsPage;
