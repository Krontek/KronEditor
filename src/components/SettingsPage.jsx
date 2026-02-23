import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

const SettingsPage = ({ theme, setTheme, editorSettings, setEditorSettings }) => {
    const { t, i18n } = useTranslation();
    const [activeTab, setActiveTab] = useState('general');

    const tabs = [
        { id: 'general', label: t('settingsPage.general'), icon: '⚙️' },
        { id: 'editor', label: t('settingsPage.editor'), icon: '📝' },
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
