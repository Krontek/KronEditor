import React from 'react';
import { useTranslation } from 'react-i18next';
import PlcIcon from '../assets/icons/plc-icon.png';

const LANGUAGES = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'tr', label: 'Türkçe', flag: '🇹🇷' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
];

const THEMES = [
  { id: 'dark',  label: '🌑 Dark' },
  { id: 'light', label: '☀️ Light' },
  { id: 'auto',  label: '🖥️ Auto' },
];

const btnBase = {
  cursor: 'pointer',
  border: '1px solid #444',
  borderRadius: '6px',
  padding: '6px 14px',
  fontSize: '13px',
  transition: 'background 0.15s, border-color 0.15s',
};

const StartScreen = ({ onNewProject, onOpenProject, theme, setTheme }) => {
  const { t, i18n } = useTranslation();
  const currentLang = i18n.language || 'en';

  return (
    <div style={{
      display: 'flex',
      flex: 1,
      height: '100%',
      width: '100%',
      background: '#1e1e1e',
      color: '#fff',
      overflow: 'hidden',
    }}>

      {/* ── LEFT: Logo + actions ── */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 32px',
        textAlign: 'center',
        userSelect: 'none',
      }}>
        <img
          src={PlcIcon}
          alt="KronEditor"
          style={{ width: '380px', opacity: 0.9, marginBottom: '24px' }}
        />

        <p style={{ color: '#888', marginBottom: '36px', fontSize: '16px', maxWidth: '480px', lineHeight: 1.6 }}>
          {t('messages.startScreenDesc') || 'A modern web-based PLC programming environment'}
        </p>

        <div style={{ display: 'flex', gap: '16px' }}>
          <button
            onClick={onNewProject}
            style={{
              ...btnBase,
              padding: '12px 28px',
              fontSize: '15px',
              background: '#0d47a1',
              border: '1px solid #1565c0',
              color: '#fff',
              boxShadow: '0 4px 8px rgba(0,0,0,0.4)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
            onMouseOver={e => e.currentTarget.style.background = '#1565c0'}
            onMouseOut={e => e.currentTarget.style.background = '#0d47a1'}
          >
            <span style={{ fontSize: '20px', lineHeight: 1 }}>+</span>
            {t('common.newProject') || 'New Project'}
          </button>

          <button
            onClick={onOpenProject}
            style={{
              ...btnBase,
              padding: '12px 28px',
              fontSize: '15px',
              background: '#2a2a2a',
              color: '#fff',
              boxShadow: '0 4px 8px rgba(0,0,0,0.3)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
            onMouseOver={e => e.currentTarget.style.background = '#383838'}
            onMouseOut={e => e.currentTarget.style.background = '#2a2a2a'}
          >
            <span style={{ fontSize: '18px', lineHeight: 1 }}>📂</span>
            {t('common.openProject') || 'Open Project'}
          </button>
        </div>
      </div>

      {/* ── DIVIDER ── */}
      <div style={{ width: '1px', background: '#333', flexShrink: 0 }} />

      {/* ── RIGHT: Settings + Info ── */}
      <div style={{
        width: '300px',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: '32px 24px',
        background: '#252526',
        overflowY: 'auto',
        gap: '28px',
      }}>

        {/* Language */}
        <section>
          <h4 style={{ margin: '0 0 12px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#888' }}>
            {t('common.language') || 'Language'}
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {LANGUAGES.map(lang => (
              <button
                key={lang.code}
                onClick={() => i18n.changeLanguage(lang.code)}
                style={{
                  ...btnBase,
                  textAlign: 'left',
                  background: currentLang === lang.code ? '#094771' : '#2d2d2d',
                  border: currentLang === lang.code ? '1px solid #007acc' : '1px solid #3e3e42',
                  color: currentLang === lang.code ? '#fff' : '#ccc',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <span>{lang.flag}</span>
                <span>{lang.label}</span>
                {currentLang === lang.code && <span style={{ marginLeft: 'auto', color: '#4fc3f7', fontSize: '12px' }}>✓</span>}
              </button>
            ))}
          </div>
        </section>

        {/* Theme */}
        <section>
          <h4 style={{ margin: '0 0 12px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#888' }}>
            {t('settingsPage.theme') || 'Theme'}
          </h4>
          <div style={{ display: 'flex', gap: '6px' }}>
            {THEMES.map(th => (
              <button
                key={th.id}
                onClick={() => setTheme && setTheme(th.id)}
                style={{
                  ...btnBase,
                  flex: 1,
                  textAlign: 'center',
                  fontSize: '12px',
                  background: theme === th.id ? '#094771' : '#2d2d2d',
                  border: theme === th.id ? '1px solid #007acc' : '1px solid #3e3e42',
                  color: theme === th.id ? '#fff' : '#ccc',
                }}
              >
                {th.label}
              </button>
            ))}
          </div>
        </section>

        {/* Divider */}
        <div style={{ height: '1px', background: '#333' }} />

        {/* About / Info */}
        <section>
          <h4 style={{ margin: '0 0 12px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#888' }}>
            {t('settingsPage.about') || 'About'}
          </h4>
          <div style={{ fontSize: '13px', color: '#aaa', lineHeight: 1.7 }}>
            <div style={{ fontWeight: 600, color: '#ddd', marginBottom: '4px', fontSize: '15px' }}>KronEditor</div>
            <div style={{ color: '#666', marginBottom: '8px' }}>{t('settingsPage.version') || 'Version'} 2.1.0</div>
            <div style={{ color: '#888', fontSize: '12px' }}>
              {t('settingsPage.aboutDescription') || 'IEC 61131-3 compatible PLC programming environment for embedded hardware.'}
            </div>
            <div style={{ marginTop: '12px', color: '#555', fontSize: '11px' }}>
              {t('settingsPage.copyright') || '© 2024 Krontek'}
            </div>
          </div>
        </section>

      </div>
    </div>
  );
};

export default StartScreen;
