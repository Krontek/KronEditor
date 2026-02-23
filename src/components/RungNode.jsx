import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { useTranslation } from 'react-i18next';

const RungNode = memo(({ data, style, selected, id }) => {
  const { t } = useTranslation();
  const width = style?.width || '100%';
  const height = style?.height || 120;

  return (
    <div style={{
      width: width,
      height: height,
      position: 'relative',
      border: selected ? '2px solid #2196f3' : '1px solid #333',
      backgroundColor: '#141414',
      display: 'flex',
      flexDirection: 'column',
      boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
      cursor: 'default'
    }}>

      {/* BAŞLIK */}
      <div style={{
        height: '24px',
        background: '#252526',
        borderBottom: '1px solid #333',
        display: 'flex', alignItems: 'center', padding: '0 10px', justifyContent: 'space-between',
        fontSize: '11px', color: '#888', fontFamily: 'Consolas'
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <strong style={{ color: '#4caf50', minWidth: '30px' }}>{data.label}</strong>
          <span style={{ opacity: 0.5 }}>{t('common.networkTitle')}...</span>
        </div>

        {/* İKONLAR */}
        <div style={{ display: 'flex', gap: 5, pointerEvents: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => data.onMoveUp(id)}
            style={{
              background: 'none', border: 'none', color: '#4CAF50',
              cursor: 'pointer', fontSize: '12px', padding: '2px 5px'
            }}
            title={t('common.moveUp')}
          >
            ▲
          </button>
          <button
            onClick={() => data.onMoveDown(id)}
            style={{
              background: 'none', border: 'none', color: '#4CAF50',
              cursor: 'pointer', fontSize: '12px', padding: '2px 5px'
            }}
            title={t('common.moveDown')}
          >
            ▼
          </button>
          <button
            onClick={() => data.onDelete(id)}
            style={{
              background: 'none', border: 'none', color: '#FF5722',
              cursor: 'pointer', fontSize: '12px', padding: '2px 5px'
            }}
            title={t('common.delete')}
          >
            ✕
          </button>
        </div>
      </div>

      {/* GÖVDE */}
      <div style={{ flex: 1, position: 'relative', pointerEvents: 'none' }}>

        {/* --- SOL RAY (+24V) --- */}
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '6px', background: '#d32f2f', borderRight: '1px solid #000' }}>
          {/* Sol Ray Terminali (Çıkış verir -> Sağa doğru) */}
          <Handle
            type="source"
            position={Position.Right}
            id="rail_left"
            style={{
              top: '50%',
              right: '-6px', // Rayın dışına biraz taşsın
              width: '10px', height: '10px',
              background: '#FFC107', // Altın Sarısı Terminal Rengi
              borderRadius: '2px',
              border: '1px solid #fff',
              zIndex: 10
            }}
          />
          {/* Sol Ray Ortası Nokta */}
          <div style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: '10px',
            height: '10px',
            background: '#FFC107',
            borderRadius: '50%',
            border: '1px solid #fff',
            zIndex: 10
          }} />
        </div>

        {/* --- SAĞ RAY (0V) --- */}
        <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '6px', background: '#1976d2', borderLeft: '1px solid #000' }}>
          {/* Sağ Ray Terminali (Giriş alır <- Soldan gelir) */}
          <Handle
            type="target"
            position={Position.Left}
            id="rail_right"
            style={{
              top: '50%',
              left: '-6px', // Rayın dışına taşsın
              width: '10px', height: '10px',
              background: '#FFC107',
              borderRadius: '2px',
              border: '1px solid #fff',
              zIndex: 10
            }}
          />
          {/* Sağ Ray Ortası Nokta */}
          <div style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: '10px',
            height: '10px',
            background: '#FFC107',
            borderRadius: '50%',
            border: '1px solid #fff',
            zIndex: 10
          }} />
        </div>
      </div>
    </div>
  );
});

export default RungNode;