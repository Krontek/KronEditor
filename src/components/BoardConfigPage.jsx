import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBoardById } from '../utils/boardDefinitions';

// ===== PIN LEGEND =====
const PinLegend = () => (
  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '8px 0' }}>
    {[
      { label: 'GPIO', color: '#4caf50' },
      { label: 'Power', color: '#ff6b35' },
      { label: '5V', color: '#ff0000' },
      { label: 'GND', color: '#333', border: '#666' },
      { label: 'I2C', color: '#4a90d9' },
      { label: 'SPI', color: '#ff9800' },
      { label: 'UART', color: '#9c27b0' },
      { label: 'ADC', color: '#e91e63' },
      { label: 'Special', color: '#607d8b' },
    ].map(l => (
      <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <div style={{ width: 12, height: 12, borderRadius: '50%', background: l.color, border: `1px solid ${l.border || l.color}` }} />
        <span style={{ fontSize: '10px', color: '#999' }}>{l.label}</span>
      </div>
    ))}
  </div>
);

// ===== 40-PIN HEADER RENDERER (Raspberry Pi) =====
const Rpi40PinHeader = ({ pinout, onPinClick, selectedPin }) => {
  const rows = [];
  for (let i = 0; i < pinout.length; i += 2) {
    rows.push([pinout[i], pinout[i + 1]]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px' }}>
      {rows.map(([left, right], idx) => (
        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {/* Left label */}
          <div style={{ width: 120, textAlign: 'right', fontSize: '10px', color: '#aaa', fontFamily: 'monospace' }}>
            {left.alt && <span style={{ color: '#666', marginRight: 4 }}>{left.alt}</span>}
            {left.name}
          </div>
          {/* Left pin */}
          <div
            onClick={() => onPinClick && onPinClick(left)}
            style={{
              width: 26, height: 26, borderRadius: '50%',
              background: selectedPin?.pin === left.pin ? '#fff' : left.color,
              color: selectedPin?.pin === left.pin ? '#000' : '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '9px', fontWeight: 'bold', cursor: 'pointer',
              border: `2px solid ${selectedPin?.pin === left.pin ? '#007acc' : 'transparent'}`,
              transition: 'all 0.1s',
            }}
            title={`Pin ${left.pin}: ${left.name}${left.alt ? ` (${left.alt})` : ''}`}
          >
            {left.pin}
          </div>
          {/* Right pin */}
          <div
            onClick={() => onPinClick && onPinClick(right)}
            style={{
              width: 26, height: 26, borderRadius: '50%',
              background: selectedPin?.pin === right.pin ? '#fff' : right.color,
              color: selectedPin?.pin === right.pin ? '#000' : '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '9px', fontWeight: 'bold', cursor: 'pointer',
              border: `2px solid ${selectedPin?.pin === right.pin ? '#007acc' : 'transparent'}`,
              transition: 'all 0.1s',
            }}
            title={`Pin ${right.pin}: ${right.name}${right.alt ? ` (${right.alt})` : ''}`}
          >
            {right.pin}
          </div>
          {/* Right label */}
          <div style={{ width: 120, textAlign: 'left', fontSize: '10px', color: '#aaa', fontFamily: 'monospace' }}>
            {right.name}
            {right.alt && <span style={{ color: '#666', marginLeft: 4 }}>{right.alt}</span>}
          </div>
        </div>
      ))}
    </div>
  );
};

// ===== PICO PIN RENDERER =====
const PicoPinHeader = ({ pinout, onPinClick, selectedPin }) => {
  // Pico is also 40 pins, left/right like RPi
  const rows = [];
  for (let i = 0; i < pinout.length; i += 2) {
    rows.push([pinout[i], pinout[i + 1]]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px' }}>
      {rows.map(([left, right], idx) => (
        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 140, textAlign: 'right', fontSize: '10px', color: '#aaa', fontFamily: 'monospace' }}>
            {left.alt && <span style={{ color: '#666', marginRight: 4 }}>{left.alt.split('/')[0]}</span>}
            {left.name}
          </div>
          <div
            onClick={() => onPinClick && onPinClick(left)}
            style={{
              width: 24, height: 24, borderRadius: 4,
              background: selectedPin?.pin === left.pin ? '#fff' : left.color,
              color: selectedPin?.pin === left.pin ? '#000' : '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '8px', fontWeight: 'bold', cursor: 'pointer',
              border: `2px solid ${selectedPin?.pin === left.pin ? '#007acc' : 'transparent'}`,
            }}
            title={`Pin ${left.pin}: ${left.name}`}
          >
            {left.pin}
          </div>
          <div style={{ width: 20, height: 2, background: '#444' }} />
          <div
            onClick={() => onPinClick && onPinClick(right)}
            style={{
              width: 24, height: 24, borderRadius: 4,
              background: selectedPin?.pin === right.pin ? '#fff' : right.color,
              color: selectedPin?.pin === right.pin ? '#000' : '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '8px', fontWeight: 'bold', cursor: 'pointer',
              border: `2px solid ${selectedPin?.pin === right.pin ? '#007acc' : 'transparent'}`,
            }}
            title={`Pin ${right.pin}: ${right.name}`}
          >
            {right.pin}
          </div>
          <div style={{ width: 140, textAlign: 'left', fontSize: '10px', color: '#aaa', fontFamily: 'monospace' }}>
            {right.name}
            {right.alt && <span style={{ color: '#666', marginLeft: 4 }}>{right.alt.split('/')[0]}</span>}
          </div>
        </div>
      ))}
    </div>
  );
};

// ===== BEAGLEBONE HEADER RENDERER =====
const BeagleBoneHeaders = ({ pinout, onPinClick, selectedPin }) => {
  const [activeHeader, setActiveHeader] = useState('P9');

  const renderHeader = (header, headerName) => {
    const rows = [];
    for (let i = 0; i < header.length; i += 2) {
      rows.push([header[i], header[i + 1]]);
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px' }}>
        {rows.map(([left, right], idx) => (
          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 110, textAlign: 'right', fontSize: '10px', color: '#aaa', fontFamily: 'monospace' }}>
              {left.alt && <span style={{ color: '#666', marginRight: 4 }}>{left.alt}</span>}
              {left.name}
            </div>
            <div
              onClick={() => onPinClick && onPinClick({ ...left, header: headerName })}
              style={{
                width: 24, height: 24, borderRadius: 3,
                background: selectedPin?.pin === left.pin && selectedPin?.header === headerName ? '#fff' : left.color,
                color: selectedPin?.pin === left.pin && selectedPin?.header === headerName ? '#000' : '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '8px', fontWeight: 'bold', cursor: 'pointer',
                border: `2px solid ${selectedPin?.pin === left.pin && selectedPin?.header === headerName ? '#007acc' : 'transparent'}`,
              }}
              title={`${headerName}.${left.pin}: ${left.name}`}
            >
              {left.pin}
            </div>
            <div
              onClick={() => onPinClick && onPinClick({ ...right, header: headerName })}
              style={{
                width: 24, height: 24, borderRadius: 3,
                background: selectedPin?.pin === right.pin && selectedPin?.header === headerName ? '#fff' : right.color,
                color: selectedPin?.pin === right.pin && selectedPin?.header === headerName ? '#000' : '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '8px', fontWeight: 'bold', cursor: 'pointer',
                border: `2px solid ${selectedPin?.pin === right.pin && selectedPin?.header === headerName ? '#007acc' : 'transparent'}`,
              }}
              title={`${headerName}.${right.pin}: ${right.name}`}
            >
              {right.pin}
            </div>
            <div style={{ width: 110, textAlign: 'left', fontSize: '10px', color: '#aaa', fontFamily: 'monospace' }}>
              {right.name}
              {right.alt && <span style={{ color: '#666', marginLeft: 4 }}>{right.alt}</span>}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div>
      {/* Header tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {['P9', 'P8'].map(h => (
          <button
            key={h}
            onClick={() => setActiveHeader(h)}
            style={{
              padding: '6px 16px', borderRadius: 4, cursor: 'pointer',
              background: activeHeader === h ? '#007acc' : '#333',
              color: activeHeader === h ? '#fff' : '#ccc',
              border: 'none', fontSize: '12px', fontWeight: 'bold',
            }}
          >
            {h} Header
          </button>
        ))}
      </div>
      {renderHeader(pinout[activeHeader], activeHeader)}
    </div>
  );
};

// ===== PIN DETAIL PANEL =====
const PinDetailPanel = ({ pin, boardLayout }) => {
  if (!pin) return (
    <div style={{ padding: 20, textAlign: 'center', color: '#666', fontSize: '12px' }}>
      Click a pin to view details
    </div>
  );

  const headerLabel = pin.header ? `${pin.header}.` : '';

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%', background: pin.color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 'bold', fontSize: '13px',
          border: '2px solid rgba(255,255,255,0.2)'
        }}>
          {pin.pin}
        </div>
        <div>
          <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '14px' }}>{headerLabel}Pin {pin.pin}</div>
          <div style={{ color: '#ccc', fontSize: '12px' }}>{pin.name}</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #333' }}>
          <span style={{ color: '#888', fontSize: '11px' }}>Type</span>
          <span style={{ color: '#fff', fontSize: '11px', textTransform: 'uppercase' }}>{pin.type}</span>
        </div>
        {pin.alt && (
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #333' }}>
            <span style={{ color: '#888', fontSize: '11px' }}>Alt Functions</span>
            <span style={{ color: '#4a90d9', fontSize: '11px' }}>{pin.alt}</span>
          </div>
        )}
        {pin.type === 'gpio' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #333' }}>
              <span style={{ color: '#888', fontSize: '11px' }}>Direction</span>
              <span style={{ color: '#4caf50', fontSize: '11px' }}>Input / Output</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #333' }}>
              <span style={{ color: '#888', fontSize: '11px' }}>Voltage</span>
              <span style={{ color: '#ff6b35', fontSize: '11px' }}>3.3V Logic</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ===== BOARD SPECS CARD =====
const BoardSpecsCard = ({ board }) => {
  const specs = [
    { label: 'CPU', value: board.cpu },
    { label: 'Architecture', value: board.arch },
    { label: 'RAM', value: board.ram },
    { label: 'Storage', value: board.storage },
    { label: 'Connectivity', value: board.connectivity },
    { label: 'USB', value: board.usb },
    { label: 'Display', value: board.display },
    { label: 'GPIO Count', value: String(board.gpio) },
  ];

  return (
    <div style={{
      background: '#1e1e1e', borderRadius: 6, border: '1px solid #333',
      padding: 14, marginBottom: 12
    }}>
      <h4 style={{ margin: '0 0 10px 0', color: '#fff', fontSize: '13px' }}>Hardware Specifications</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {specs.map(s => (
          <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid #2a2a2a' }}>
            <span style={{ color: '#888', fontSize: '11px' }}>{s.label}</span>
            <span style={{ color: '#ccc', fontSize: '11px', maxWidth: '60%', textAlign: 'right' }}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ===== INTERFACES CARD =====
const InterfacesCard = ({ board }) => (
  <div style={{
    background: '#1e1e1e', borderRadius: 6, border: '1px solid #333',
    padding: 14, marginBottom: 12
  }}>
    <h4 style={{ margin: '0 0 10px 0', color: '#fff', fontSize: '13px' }}>Available Interfaces</h4>
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {board.interfaces.map(iface => (
        <span key={iface} style={{
          padding: '4px 10px', background: '#2a2a2a', borderRadius: 12,
          fontSize: '11px', color: '#4a90d9', border: '1px solid #333'
        }}>
          {iface}
        </span>
      ))}
    </div>
  </div>
);

// ===== EDATEC IPC I/O PANEL =====
const EdatecIOPanel = ({ pinout }) => {
  const { serialPorts = [], diCount = 0, doCount = 0, canCount = 0 } = pinout || {};
  const rs485 = serialPorts.filter(p => p.type === 'RS485');
  const rs232 = serialPorts.filter(p => p.type === 'RS232');

  const Section = ({ title, color, items }) => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: '11px', fontWeight: 'bold', color, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.map((label, i) => (
          <div key={i} style={{
            padding: '6px 12px', borderRadius: 4,
            background: '#1e1e1e', border: `1px solid ${color}44`,
            fontSize: '11px', color, fontFamily: 'monospace',
          }}>
            {label}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ padding: 16 }}>
      {rs485.length > 0 && (
        <Section title="RS485 Ports" color="#4caf50"
          items={rs485.map(p => `${p.label}  /dev/ttyS${p.index}`)} />
      )}
      {rs232.length > 0 && (
        <Section title="RS232 Ports" color="#9c27b0"
          items={rs232.map(p => `${p.label}  /dev/ttyS${p.index}`)} />
      )}
      {canCount > 0 && (
        <Section title="CAN Bus" color="#ff9800"
          items={Array.from({ length: canCount }, (_, i) => `CAN${i}  can${i}`)} />
      )}
      {diCount > 0 && (
        <Section title={`Digital Inputs (${diCount}x Isolated)`} color="#4a90d9"
          items={Array.from({ length: diCount }, (_, i) => `DI${i}`)} />
      )}
      {doCount > 0 && (
        <Section title={`Digital Outputs (${doCount}x Isolated)`} color="#e91e63"
          items={Array.from({ length: doCount }, (_, i) => `DO${i}`)} />
      )}
      {rs485.length === 0 && rs232.length === 0 && canCount === 0 && diCount === 0 && doCount === 0 && (
        <div style={{ color: '#666', fontSize: '12px', textAlign: 'center', paddingTop: 24 }}>
          Standard CM4/CM5/Pi5 interfaces (GPIO, I2C, SPI, UART)
        </div>
      )}
    </div>
  );
};

// ===== BOARD ICON HELPER =====
const boardIcon = (family) => {
  if (family === 'Raspberry Pi') return { icon: '🍓', bg: 'linear-gradient(135deg, #c51a4a, #8b1a3a)' };
  if (family === 'Edatec IPC')   return { icon: '🏭', bg: 'linear-gradient(135deg, #1565c0, #0d47a1)' };
  return { icon: '🦴', bg: 'linear-gradient(135deg, #2e7d32, #1b5e20)' };
};

// ===== MAIN BOARD CONFIG PAGE =====
const BoardConfigPage = ({ boardId }) => {
  const { t } = useTranslation();
  const [selectedPin, setSelectedPin] = useState(null);
  const board = getBoardById(boardId);

  if (!board) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666' }}>
        {t('board.noBoardSelected')}
      </div>
    );
  }

  const handlePinClick = (pin) => {
    setSelectedPin(prev => prev?.pin === pin.pin && prev?.header === pin.header ? null : pin);
  };

  const { icon, bg } = boardIcon(board.family);
  const isEdatec = board.pinLayout === 'edatec_ipc';

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '16px', background: '#1e1e1e' }}>
      {/* Board Title */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        padding: '14px 18px', background: '#252526', borderRadius: 8, border: '1px solid #333'
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 8, background: bg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '24px'
        }}>
          {icon}
        </div>
        <div>
          <h2 style={{ margin: 0, color: '#fff', fontSize: '18px' }}>{board.name}</h2>
          <span style={{ color: '#888', fontSize: '12px' }}>{board.cpu}</span>
        </div>
      </div>

      {/* Main Layout: Left (Pinout / I/O) + Right (Details) */}
      <div style={{ display: 'flex', gap: 16, minHeight: 400 }}>
        {/* LEFT: Pinout Diagram or Edatec I/O panel */}
        <div style={{
          flex: 1, background: '#252526', borderRadius: 8, border: '1px solid #333',
          overflow: 'auto', minWidth: 0
        }}>
          <div style={{
            padding: '10px 14px', borderBottom: '1px solid #333',
            fontWeight: 'bold', fontSize: '12px', color: '#ccc',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between'
          }}>
            <span>{isEdatec ? 'I/O Connectors' : t('board.pinoutDiagram')}</span>
            {!isEdatec && (
              <span style={{ fontSize: '10px', color: '#666', fontWeight: 'normal' }}>
                {board.gpio} GPIO
              </span>
            )}
          </div>

          {isEdatec ? (
            <EdatecIOPanel pinout={board.pinout} />
          ) : (
            <>
              <PinLegend />
              <div style={{ display: 'flex', justifyContent: 'center', padding: '0 8px 8px' }}>
                {board.pinLayout === 'rpi40' && (
                  <Rpi40PinHeader pinout={board.pinout} onPinClick={handlePinClick} selectedPin={selectedPin} />
                )}
                {board.pinLayout === 'pico' && (
                  <PicoPinHeader pinout={board.pinout} onPinClick={handlePinClick} selectedPin={selectedPin} />
                )}
                {board.pinLayout === 'beaglebone' && (
                  <BeagleBoneHeaders pinout={board.pinout} onPinClick={handlePinClick} selectedPin={selectedPin} />
                )}
              </div>
            </>
          )}
        </div>

        {/* RIGHT: Specs + Pin Detail */}
        <div style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <BoardSpecsCard board={board} />
          <InterfacesCard board={board} />

          {!isEdatec && (
            <div style={{
              background: '#252526', borderRadius: 6, border: '1px solid #333', flex: 1
            }}>
              <div style={{
                padding: '8px 14px', borderBottom: '1px solid #333',
                fontWeight: 'bold', fontSize: '12px', color: '#ccc'
              }}>
                {t('board.pinDetails')}
              </div>
              <PinDetailPanel pin={selectedPin} boardLayout={board.pinLayout} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BoardConfigPage;
