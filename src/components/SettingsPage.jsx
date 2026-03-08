import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const KRON_REPOS = [
    'KronStandard', 'KronControl', 'KronCompare', 'KronConverter',
    'KronMathematic', 'KronCommunication', 'KronLogic', 'KronMotion',
];

const SettingsPage = ({ theme, setTheme, editorSettings, setEditorSettings }) => {
    const { t, i18n } = useTranslation();
    const [activeTab, setActiveTab] = useState('general');
    const [isUpdating, setIsUpdating] = useState(false);
    const [progressLog, setProgressLog] = useState('');
    const [selectedRepos, setSelectedRepos] = useState([...KRON_REPOS]);
    const logRef = useRef(null);
    const unlistenRef = useRef(null);

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

    const tabs = [
        { id: 'general', label: t('settingsPage.general'), icon: '⚙️' },
        { id: 'editor', label: t('settingsPage.editor'), icon: '📝' },
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
                                    💻 {t('settingsPage.auto') || 'Auto'}
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
            case 'libraries':
                return (
                    <div style={{ maxWidth: '600px' }}>
                        <h3 style={{ borderBottom: '1px solid #444', paddingBottom: '10px', marginTop: 0 }}>
                            Kron Libraries
                        </h3>
                        <div style={{ marginBottom: '20px', background: '#252526', borderRadius: '4px', padding: '4px 12px' }}>
                            {KRON_REPOS.map((repo, i) => (
                                <div key={repo} style={{
                                    padding: '8px 0',
                                    color: '#ccc',
                                    fontSize: '13px',
                                    borderBottom: i < KRON_REPOS.length - 1 ? '1px solid #333' : 'none',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px'
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
                        <button
                            onClick={handleUpdateLibraries}
                            disabled={isUpdating}
                            style={{
                                padding: '10px 20px',
                                backgroundColor: isUpdating ? '#444' : '#007acc',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: isUpdating ? 'not-allowed' : 'pointer',
                                marginBottom: '16px',
                                width: '100%',
                                fontSize: '14px'
                            }}
                        >
                            {isUpdating ? 'Building...' : 'Build Libraries'}
                        </button>
                        {progressLog && (
                            <textarea
                                ref={logRef}
                                value={progressLog}
                                readOnly
                                style={{
                                    width: '100%',
                                    height: '260px',
                                    background: '#0d0d0d',
                                    color: '#4ec9b0',
                                    border: '1px solid #333',
                                    borderRadius: '4px',
                                    padding: '10px',
                                    fontFamily: 'monospace',
                                    fontSize: '12px',
                                    resize: 'none',
                                    boxSizing: 'border-box'
                                }}
                            />
                        )}
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
