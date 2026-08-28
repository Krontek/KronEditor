import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Popup for the Connection tab's "Search" button — shows live progress while
 * host-agent scans a subnet for a KronServer, then lets the user pick a
 * result to fill the IP/Port fields with. Purely presentational: all scan
 * state (progress, results) lives in SettingsPage.
 *
 * Props:
 *   isOpen    – boolean
 *   scanning  – boolean (scan still in progress)
 *   progress  – { scanned, total }
 *   results   – [{ ip, port, running, pid, variableCount, hmiPort }]
 *   onSelect  – (host) => void
 *   onClose   – () => void
 */
const DeviceScanModal = ({ isOpen, scanning, progress, results, onSelect, onClose }) => {
    const { t } = useTranslation();
    const closeBtnRef = useRef(null);

    useEffect(() => {
        if (!isOpen) return;
        closeBtnRef.current?.focus();
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const pct = progress?.total ? Math.round((progress.scanned / progress.total) * 100) : 0;

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 99999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.6)',
        }}>
            <div style={{
                background: '#252526', border: '1px solid #454545',
                borderRadius: '6px', padding: '20px 24px', width: '440px', maxWidth: '90vw',
                maxHeight: '70vh', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                display: 'flex', flexDirection: 'column', gap: '14px',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontSize: '16px' }}>🔍</span>
                    <span style={{ fontWeight: 600, fontSize: '14px', color: '#e0e0e0' }}>
                        {t('settingsPage.scanTitle', 'Search Devices')}
                    </span>
                </div>

                <div style={{ fontSize: '12px', color: '#888' }}>
                    {scanning
                        ? t('settingsPage.scanScanning', 'Scanning {{scanned}}/{{total}}…', { scanned: progress?.scanned || 0, total: progress?.total || 0 })
                        : t('settingsPage.scanDone', 'Scan finished — {{count}} found', { count: results.length })}
                </div>

                {/* Progress bar */}
                <div style={{ height: '4px', background: '#1e1e1e', borderRadius: '2px', overflow: 'hidden' }}>
                    <div style={{
                        height: '100%', width: `${scanning ? pct : 100}%`,
                        background: scanning ? '#0e639c' : '#4ec9b0',
                        transition: 'width 0.15s linear',
                    }} />
                </div>

                {/* Results list */}
                <div style={{
                    overflowY: 'auto', flex: 1, minHeight: '80px', maxHeight: '320px',
                    border: '1px solid #333', borderRadius: '4px',
                }}>
                    {results.length === 0 ? (
                        <div style={{ padding: '18px', textAlign: 'center', color: '#666', fontSize: '12px' }}>
                            {scanning
                                ? t('settingsPage.scanSearching', 'Searching the network…')
                                : t('settingsPage.scanNoneFound', 'No devices found on this network.')}
                        </div>
                    ) : (
                        results.map((h) => (
                            <div
                                key={`${h.ip}:${h.port}`}
                                onClick={() => onSelect(h)}
                                style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: '10px 12px', cursor: 'pointer',
                                    borderBottom: '1px solid #2d2d2d',
                                }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = '#2a2d2e'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                            >
                                <div>
                                    <div style={{ color: '#e0e0e0', fontSize: '13px', fontFamily: 'monospace' }}>
                                        {h.ip}:{h.port}
                                    </div>
                                    <div style={{ color: '#888', fontSize: '11px', marginTop: '2px' }}>
                                        {h.running
                                            ? t('settingsPage.scanRuntimeRunning', 'runtime running · {{count}} vars', { count: h.variableCount })
                                            : t('settingsPage.scanRuntimeStopped', 'runtime stopped')}
                                    </div>
                                </div>
                                <span style={{ color: '#4ec9b0', fontSize: '11px' }}>
                                    {t('settingsPage.scanSelect', 'Select')} →
                                </span>
                            </div>
                        ))
                    )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                    <button
                        ref={closeBtnRef}
                        onClick={onClose}
                        style={{
                            padding: '7px 18px', borderRadius: '4px', cursor: 'pointer',
                            background: 'transparent', border: '1px solid #555', color: '#ccc',
                            fontSize: '13px',
                        }}
                    >
                        {scanning ? t('settingsPage.scanCancel', 'Cancel') : t('common.close', 'Close')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default DeviceScanModal;
