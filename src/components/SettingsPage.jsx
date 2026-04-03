import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { Editor } from '@monaco-editor/react';
import { transpileToC } from '../services/CTranspilerService';

const KRON_REPOS = [
    'KronStandard', 'KronControl', 'KronCompare', 'KronConverter',
    'KronMathematic', 'KronCommunication', 'KronLogic', 'KronMotion',
    'KronEthercatMaster',
];

const SettingsPage = ({ theme, setTheme, editorSettings, setEditorSettings, selectedBoard, plcAddress, setPlcAddress, sshUser: sshUserProp, setSshUser: setSshUserProp, sshPort: sshPortProp, setSshPort: setSshPortProp, isPlcConnected, setConnectionEnabled, esiLibrary = [], onLoadEsiFile, projectStructure, buses, busConfigs }) => {
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
                unlistenRef.current.progress?.();
                unlistenRef.current.done?.();
            }
        };
    }, []);

    useEffect(() => {
        if (logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
        }
    }, [progressLog]);

    // ── Transpiler debug handlers ────────────────────────────────────────────
    const handleTranspile = async () => {
        try {
            const standardHeaders = await invoke('get_standard_headers').catch(() => []);
            const result = transpileToC(projectStructure || {}, standardHeaders, selectedBoard, true, buses || [], busConfigs || {});
            setTranspilerOut({ header: result.header || '', source: result.source || '' });
        } catch (err) {
            setTranspilerOut({ header: '// Error: ' + err, source: '' });
        }
    };

    const handleDevBuild = async () => {
        setIsBuildRunning(true);
        setBuildLog('Starting build → runtime2.bin...\n');
        try {
            const standardHeaders = await invoke('get_standard_headers').catch(() => []);
            const result = transpileToC(projectStructure || {}, standardHeaders, selectedBoard, false, buses || [], busConfigs || {});
            setTranspilerOut({ header: result.header || '', source: result.source || '' });
            setBuildLog(prev => prev + 'Transpile OK. Cross-compiling...\n');

            const outPath = await invoke('compile_for_target', {
                header: result.header,
                source: result.source,
                variableTable: JSON.stringify(result.variableTable || {}, null, 2),
                hal: result.hal || '',
                boardId: selectedBoard,
                outputName: 'runtime2.bin',
            });
            setBuildLog(prev => prev + `✓ Built: ${outPath}\n`);
        } catch (err) {
            setBuildLog(prev => prev + '✗ ' + String(err) + '\n');
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
        setProgressLog(prev => prev + 'Targets: x86_64/linux (GCC), x86_64/win32 (MinGW), arm/linux (aarch64), arm/CortexM/M0, M4, M7 (arm-none-eabi-gcc)\n\n');

        const unlistenProgress = await listen('library-update-progress', (event) => {
            setProgressLog(prev => prev + event.payload + '\n');
        });

        const unlistenDone = await listen('library-update-done', (event) => {
            const { success, message } = event.payload;
            setProgressLog(prev => prev + (success ? '✓ ' : '✗ ') + message + '\n');
            setIsUpdating(false);
            unlistenProgress();
            unlistenDone();
            unlistenRef.current = null;
        });

        unlistenRef.current = { progress: unlistenProgress, done: unlistenDone };

        invoke('update_libraries', { repos: selectedRepos }).catch(err => {
            setProgressLog(prev => prev + 'Error: ' + err + '\n');
            setIsUpdating(false);
            unlistenProgress();
            unlistenDone();
            unlistenRef.current = null;
        });
    };

    const handleBuildCanopen = async () => {
        setIsUpdating(true);
        setProgressLog('Starting CANopen build (cloning + compiling for all toolchains)...\n');

        const unlistenProgress = await listen('library-update-progress', (event) => {
            setProgressLog(prev => prev + event.payload + '\n');
        });

        const unlistenDone = await listen('library-update-done', (event) => {
            const { success, message } = event.payload;
            setProgressLog(prev => prev + (success ? '✓ ' : '✗ ') + message + '\n');
            setIsUpdating(false);
            unlistenProgress();
            unlistenDone();
            unlistenRef.current = null;
        });

        unlistenRef.current = { progress: unlistenProgress, done: unlistenDone };

        invoke('build_canopen').catch(err => {
            setProgressLog(prev => prev + 'Error: ' + err + '\n');
            setIsUpdating(false);
            unlistenProgress();
            unlistenDone();
            unlistenRef.current = null;
        });
    };

    const handleBuildSoem = async () => {
        setIsUpdating(true);
        setProgressLog('Starting SOEM build (cloning + compiling for all toolchains)...\n');

        const unlistenProgress = await listen('library-update-progress', (event) => {
            setProgressLog(prev => prev + event.payload + '\n');
        });

        const unlistenDone = await listen('library-update-done', (event) => {
            const { success, message } = event.payload;
            setProgressLog(prev => prev + (success ? '✓ ' : '✗ ') + message + '\n');
            setIsUpdating(false);
            unlistenProgress();
            unlistenDone();
            unlistenRef.current = null;
        });

        unlistenRef.current = { progress: unlistenProgress, done: unlistenDone };

        invoke('build_soem').catch(err => {
            setProgressLog(prev => prev + 'Error: ' + err + '\n');
            setIsUpdating(false);
            unlistenProgress();
            unlistenDone();
            unlistenRef.current = null;
        });
    };

    const handleUpdateServer = async () => {
        setIsUpdating(true);
        setProgressLog('Starting KronServer build...\n');

        const unlistenProgress = await listen('server-update-progress', (event) => {
            setProgressLog(prev => prev + event.payload + '\n');
        });

        const unlistenDone = await listen('server-update-done', (event) => {
            const { success, message } = event.payload;
            setProgressLog(prev => prev + (success ? '✓ ' : '✗ ') + message + '\n');
            setIsUpdating(false);
            unlistenProgress();
            unlistenDone();
            unlistenRef.current = null;
        });

        unlistenRef.current = { progress: unlistenProgress, done: unlistenDone };

        invoke('update_server').catch(err => {
            setProgressLog(prev => prev + 'Error: ' + err + '\n');
            setIsUpdating(false);
            unlistenProgress();
            unlistenDone();
            unlistenRef.current = null;
        });
    };

    const handleConnect = async () => {
        if (!connIp) return;
        const addr = `${connIp}:${connPort}`;
        setConnStatus('checking');
        try {
            await invoke('check_server_status', { serverAddr: addr });
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

        const unlistenProgress = await listen('server-deploy-progress', (event) => {
            setProgressLog(prev => prev + event.payload + '\n');
        });

        try {
            await invoke('deploy_server_to_target', {
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
            setProgressLog(prev => prev + '✗ Deploy failed: ' + err + '\n');
        } finally {
            setIsDeploying(false);
            unlistenProgress();
        }
    };

    const [esiLoadError, setEsiLoadError] = useState(null);
    const [esiLoadLog, setEsiLoadLog] = useState('');

    const handleLoadEsiFileClick = async () => {
        setEsiLoadError(null);
        setEsiLoadLog('');
        try {
            const selected = await open({
                filters: [{ name: 'ESI XML', extensions: ['xml', 'XML'] }],
                multiple: false,
            });
            if (!selected) return;
            const content = await readTextFile(selected);
            const filename = selected.split('/').pop().split('\\').pop();
            await onLoadEsiFile?.(filename, content);
            setEsiLoadLog(`Loaded: ${filename}`);
        } catch (e) {
            setEsiLoadError('Error: ' + e.message);
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
                                <button
                                    onClick={() => changeLanguage('en')}
                                    style={{
                                        flex: 1, padding: '10px',
                                        backgroundColor: i18n.language === 'en' ? '#007acc' : '#2d2d2d',
                                        color: '#fff', border: '1px solid #444', borderRadius: '4px', cursor: 'pointer'
                                    }}
                                >
                                    🇬🇧 English
                                </button>
                                <button
                                    onClick={() => changeLanguage('tr')}
                                    style={{
                                        flex: 1, padding: '10px',
                                        backgroundColor: i18n.language === 'tr' ? '#007acc' : '#2d2d2d',
                                        color: '#fff', border: '1px solid #444', borderRadius: '4px', cursor: 'pointer'
                                    }}
                                >
                                    🇹🇷 Türkçe
                                </button>
                                <button
                                    onClick={() => changeLanguage('ru')}
                                    style={{
                                        flex: 1, padding: '10px',
                                        backgroundColor: i18n.language === 'ru' ? '#007acc' : '#2d2d2d',
                                        color: '#fff', border: '1px solid #444', borderRadius: '4px', cursor: 'pointer'
                                    }}
                                >
                                    🇷🇺 Русский
                                </button>
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
                                <input
                                    type="password"
                                    value={sshPass}
                                    onChange={(e) => setSshPass(e.target.value)}
                                    placeholder="••••••"
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
                                { label: 'Build Libraries', handler: handleUpdateLibraries, color: '#007acc' },
                                { label: 'Build Server',    handler: handleUpdateServer,    color: '#0d47a1' },
                                { label: 'Build SOEM',      handler: handleBuildSoem,       color: '#1b5e20' },
                                { label: 'Build CANopen',   handler: handleBuildCanopen,    color: '#0d47a1' },
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
                        <p style={{ color: '#aaa' }}>{t('settingsPage.version')} 2.1.0</p>
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
                            <h3 style={{ fontSize: 13, fontWeight: '600', color: '#aaa', marginBottom: 12, letterSpacing: '0.05em', textTransform: 'uppercase' }}>How to Use</h3>
                            <div style={{ fontSize: 12, color: '#666', lineHeight: 1.8 }}>
                                <div>1. Open the <span style={{ color: '#c0c0c0' }}>Visualization</span> tab from the project tree.</div>
                                <div>2. Drag components from the toolbox onto the canvas.</div>
                                <div>3. Bind variables using the properties panel on the right.</div>
                                <div>4. Click <span style={{ color: '#4ec9b0' }}>🌐 Serve</span> in the toolbar to start the web server.</div>
                                <div>5. Open <span style={{ color: '#7eb8f7', fontFamily: 'monospace' }}>http://localhost:{Number(localStorage.getItem('hmiPort') || '7800')}</span> in a browser.</div>
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
        </div>
    );
};

export default SettingsPage;
