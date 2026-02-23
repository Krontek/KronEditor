import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { PLC_BLOCKS } from '../utils/plcStandards';

// Memo kullanarak performansı artırıyoruz (gereksiz render önlenir)
const FunctionBlockNode = memo(({ data }) => {
  // data.blockType (örneğin 'TON') üzerinden standartları çekiyoruz
  const blockConfig = PLC_BLOCKS[data.blockType];

  if (!blockConfig) {
    return <div style={{background:'red', color:'white', padding:5}}>Bilinmeyen Blok: {data.blockType}</div>;
  }

  return (
    <div style={{
      background: '#252526',
      border: '1px solid #555',
      borderRadius: '5px',
      minWidth: '100px',
      color: '#fff',
      boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
      fontSize: '12px',
      fontFamily: 'Consolas, monospace'
    }}>
      {/* BAŞLIK (Örn: TON) */}
      <div style={{
        background: '#007acc',
        padding: '4px 8px',
        textAlign: 'center',
        fontWeight: 'bold',
        borderTopLeftRadius: '4px',
        borderTopRightRadius: '4px',
        letterSpacing: '1px'
      }}>
        {blockConfig.label}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0' }}>
        
        {/* --- SOL TARA (GİRİŞLER) --- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', paddingLeft: '5px' }}>
          {blockConfig.inputs.map((input, index) => (
            <div key={input.id} style={{ position: 'relative', paddingLeft: '10px' }}>
              {/* Giriş Noktası (Handle) */}
              <Handle
                type="target"
                position={Position.Left}
                id={input.id}
                style={{ background: '#4CAF50', width: '8px', height: '8px', left: '-5px' }}
              />
              {/* Pin İsmi (IN, PT vb.) */}
              <span>{input.label}</span>
              {/* Veri Tipi (Küçük gri yazı) */}
              <span style={{ fontSize: '8px', color: '#888', marginLeft: '4px' }}>{input.type}</span>
            </div>
          ))}
        </div>

        {/* --- SAĞ TARAF (ÇIKIŞLAR) --- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', paddingRight: '5px', alignItems: 'flex-end' }}>
          {blockConfig.outputs.map((output, index) => (
            <div key={output.id} style={{ position: 'relative', paddingRight: '10px' }}>
              {/* Pin İsmi */}
              <span>{output.label}</span>
              <span style={{ fontSize: '8px', color: '#888', marginRight: '4px' }}>{output.type}</span>
              {/* Çıkış Noktası (Handle) */}
              <Handle
                type="source"
                position={Position.Right}
                id={output.id}
                style={{ background: '#FF5722', width: '8px', height: '8px', right: '-5px' }}
              />
            </div>
          ))}
        </div>

      </div>
    </div>
  );
});

export default FunctionBlockNode;