import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * 3-button save-confirm dialog.
 * Props:
 *   isOpen  – boolean
 *   onSave  – () => void  (save then close)
 *   onDiscard – () => void (discard then close)
 *   onCancel  – () => void (abort close)
 */
const SaveConfirmDialog = ({ isOpen, onSave, onDiscard, onCancel }) => {
    const { t } = useTranslation();
    const cancelBtnRef = useRef(null);

    useEffect(() => {
        if (!isOpen) return;
        // Default focus on Cancel so accidental Enter doesn't trigger Save
        cancelBtnRef.current?.focus();

        const onKey = (e) => {
            if (e.key === 'Escape') onCancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isOpen, onCancel]);

    if (!isOpen) return null;

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 99999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.6)',
        }}>
            <div style={{
                background: '#252526', border: '1px solid #454545',
                borderRadius: '6px', padding: '24px 28px', minWidth: '360px', maxWidth: '460px',
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                display: 'flex', flexDirection: 'column', gap: '16px',
            }}>
                {/* Title */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontSize: '18px' }}>⚠️</span>
                    <span style={{ fontWeight: 600, fontSize: '15px', color: '#e0e0e0' }}>
                        {t('saveConfirm.title')}
                    </span>
                </div>

                {/* Message */}
                <p style={{ margin: 0, color: '#c8c8c8', fontSize: '13px', lineHeight: 1.5 }}>
                    {t('saveConfirm.message')}
                </p>

                {/* Buttons */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
                    <button
                        ref={cancelBtnRef}
                        onClick={onCancel}
                        style={{
                            padding: '7px 18px', borderRadius: '4px', cursor: 'pointer',
                            background: 'transparent', border: '1px solid #555', color: '#ccc',
                            fontSize: '13px',
                        }}
                    >
                        {t('saveConfirm.cancel')}
                    </button>
                    <button
                        onClick={onDiscard}
                        style={{
                            padding: '7px 18px', borderRadius: '4px', cursor: 'pointer',
                            background: 'transparent', border: '1px solid #c75', color: '#e8a060',
                            fontSize: '13px',
                        }}
                    >
                        {t('saveConfirm.dontSave')}
                    </button>
                    <button
                        onClick={onSave}
                        style={{
                            padding: '7px 18px', borderRadius: '4px', cursor: 'pointer',
                            background: '#007acc', border: 'none', color: 'white',
                            fontSize: '13px', fontWeight: 500,
                        }}
                    >
                        {t('saveConfirm.save')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SaveConfirmDialog;
