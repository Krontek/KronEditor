import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getBoardById } from '../utils/boardDefinitions';
import {
  getBoardFamilyDefine,
  getPinPorts,
} from '../utils/devicePortMapping';

// ===== PIN LEGEND =====
const PinLegend = () => {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '8px 0' }}>
      {[
        { label: t('board.legendGpio'), color: '#4caf50' },
        { label: t('board.legendPower'), color: '#ff6b35' },
        { label: '5V', color: '#ff0000' },
        { label: 'GND', color: '#333', border: '#666' },
        { label: 'I2C', color: '#4a90d9' },
        { label: 'SPI', color: '#ff9800' },
        { label: 'UART', color: '#9c27b0' },
        { label: 'ADC', color: '#e91e63' },
        { label: t('board.legendSpecial'), color: '#607d8b' },
      ].map(l => (
        <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: l.color, border: `1px solid ${l.border || l.color}` }} />
          <span style={{ fontSize: '10px', color: '#999' }}>{l.label}</span>
        </div>
      ))}
    </div>
  );
};

// ===== SHARED PIN LABEL =====
const PinLabel = ({ pin, align }) => (
  <div style={{
    width: 110, textAlign: align, fontSize: '10px', fontFamily: 'monospace',
    overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
    title: `${pin.name}${pin.alt ? ` — ${pin.alt}` : ''}`,
  }}
    title={`${pin.name}${pin.alt ? ` — ${pin.alt}` : ''}`}
  >
    {align === 'right' ? (
      <>
        {pin.alt && <span style={{ color: '#555', marginRight: 4 }}>{pin.alt}</span>}
        <span style={{ color: '#aaa' }}>{pin.name}</span>
      </>
    ) : (
      <>
        <span style={{ color: '#aaa' }}>{pin.name}</span>
        {pin.alt && <span style={{ color: '#555', marginLeft: 4 }}>{pin.alt}</span>}
      </>
    )}
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
          <PinLabel pin={left} align="right" />
          <div
            onClick={() => onPinClick && onPinClick(left)}
            style={{
              width: 26, height: 26, borderRadius: '50%',
              background: selectedPin?.pin === left.pin ? '#fff' : left.color,
              color: selectedPin?.pin === left.pin ? '#000' : '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '9px', fontWeight: 'bold', cursor: 'pointer',
              border: `2px solid ${selectedPin?.pin === left.pin ? '#007acc' : 'transparent'}`,
              transition: 'all 0.1s', flexShrink: 0,
            }}
            title={`Pin ${left.pin}: ${left.name}${left.alt ? ` (${left.alt})` : ''}`}
          >
            {left.pin}
          </div>
          <div
            onClick={() => onPinClick && onPinClick(right)}
            style={{
              width: 26, height: 26, borderRadius: '50%',
              background: selectedPin?.pin === right.pin ? '#fff' : right.color,
              color: selectedPin?.pin === right.pin ? '#000' : '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '9px', fontWeight: 'bold', cursor: 'pointer',
              border: `2px solid ${selectedPin?.pin === right.pin ? '#007acc' : 'transparent'}`,
              transition: 'all 0.1s', flexShrink: 0,
            }}
            title={`Pin ${right.pin}: ${right.name}${right.alt ? ` (${right.alt})` : ''}`}
          >
            {right.pin}
          </div>
          <PinLabel pin={right} align="left" />
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
          <PinLabel pin={left} align="right" />
          <div
            onClick={() => onPinClick && onPinClick(left)}
            style={{
              width: 24, height: 24, borderRadius: 4, flexShrink: 0,
              background: selectedPin?.pin === left.pin ? '#fff' : left.color,
              color: selectedPin?.pin === left.pin ? '#000' : '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '8px', fontWeight: 'bold', cursor: 'pointer',
              border: `2px solid ${selectedPin?.pin === left.pin ? '#007acc' : 'transparent'}`,
            }}
            title={`Pin ${left.pin}: ${left.name}${left.alt ? ` (${left.alt})` : ''}`}
          >
            {left.pin}
          </div>
          <div style={{ width: 16, height: 2, background: '#444', flexShrink: 0 }} />
          <div
            onClick={() => onPinClick && onPinClick(right)}
            style={{
              width: 24, height: 24, borderRadius: 4, flexShrink: 0,
              background: selectedPin?.pin === right.pin ? '#fff' : right.color,
              color: selectedPin?.pin === right.pin ? '#000' : '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '8px', fontWeight: 'bold', cursor: 'pointer',
              border: `2px solid ${selectedPin?.pin === right.pin ? '#007acc' : 'transparent'}`,
            }}
            title={`Pin ${right.pin}: ${right.name}${right.alt ? ` (${right.alt})` : ''}`}
          >
            {right.pin}
          </div>
          <PinLabel pin={right} align="left" />
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
            <PinLabel pin={left} align="right" />
            <div
              onClick={() => onPinClick && onPinClick({ ...left, header: headerName })}
              style={{
                width: 24, height: 24, borderRadius: 3, flexShrink: 0,
                background: selectedPin?.pin === left.pin && selectedPin?.header === headerName ? '#fff' : left.color,
                color: selectedPin?.pin === left.pin && selectedPin?.header === headerName ? '#000' : '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '8px', fontWeight: 'bold', cursor: 'pointer',
                border: `2px solid ${selectedPin?.pin === left.pin && selectedPin?.header === headerName ? '#007acc' : 'transparent'}`,
              }}
              title={`${headerName}.${left.pin}: ${left.name}${left.alt ? ` (${left.alt})` : ''}`}
            >
              {left.pin}
            </div>
            <div
              onClick={() => onPinClick && onPinClick({ ...right, header: headerName })}
              style={{
                width: 24, height: 24, borderRadius: 3, flexShrink: 0,
                background: selectedPin?.pin === right.pin && selectedPin?.header === headerName ? '#fff' : right.color,
                color: selectedPin?.pin === right.pin && selectedPin?.header === headerName ? '#000' : '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '8px', fontWeight: 'bold', cursor: 'pointer',
                border: `2px solid ${selectedPin?.pin === right.pin && selectedPin?.header === headerName ? '#007acc' : 'transparent'}`,
              }}
              title={`${headerName}.${right.pin}: ${right.name}${right.alt ? ` (${right.alt})` : ''}`}
            >
              {right.pin}
            </div>
            <PinLabel pin={right} align="left" />
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

// ===== PROTOCOL BADGE COLORS =====
const PROTO_COLOR = { I2C: '#4a90d9', SPI: '#ff9800', UART: '#9c27b0' };

// ===== PIN CONFIG PANEL =====
// Replaces the old static PinDetailPanel.
// Shows basic pin info + expandable per-port protocol config for every port
// that uses this physical pin.
const PinConfigPanel = ({ pin, board, interfaceConfig, onInterfaceConfigChange }) => {
  const { t } = useTranslation();
  const [openPort, setOpenPort] = useState(null); // "UART_UART_0"

  if (!pin) return (
    <div style={{ padding: 20, textAlign: 'center', color: '#666', fontSize: '12px' }}>
      {t('board.clickPinPrompt')}
    </div>
  );

  const boardFamilyDefine = getBoardFamilyDefine(board?.id);
  const pinPorts = getPinPorts(boardFamilyDefine, pin);
  const headerLabel = pin.header ? `${pin.header}.` : '';

  const togglePort = (key) => setOpenPort((prev) => (prev === key ? null : key));

  const handlePortChange = (protocol, portId, nextValue, port) => {
    if (!onInterfaceConfigChange) return;
    onInterfaceConfigChange({
      ...(interfaceConfig || {}),
      [protocol]: {
        ...(interfaceConfig?.[protocol] || {}),
        [portId]: {
          ...getDefaultProtocolConfig(protocol, port),
          ...(interfaceConfig?.[protocol]?.[portId] || {}),
          ...nextValue,
        },
      },
    });
  };

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Pin header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%', background: pin.color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 'bold', fontSize: '13px',
          border: '2px solid rgba(255,255,255,0.2)', flexShrink: 0,
        }}>
          {pin.pin}
        </div>
        <div>
          <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '14px' }}>{headerLabel}Pin {pin.pin}</div>
          <div style={{ color: '#ccc', fontSize: '11px' }}>{pin.name}</div>
          {pin.alt && <div style={{ color: '#4a90d9', fontSize: '10px', marginTop: 1 }}>{pin.alt}</div>}
        </div>
      </div>

      {/* Available protocol functions */}
      {pinPorts.length > 0 ? (
        <div>
          <div style={{ fontSize: '10px', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
            {t('board.availableFunctions')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pinPorts.map(({ protocol, portId, portDetails, signals }) => {
              const key = `${protocol}_${portId}`;
              const isOpen = openPort === key;
              const portCfg = {
                ...getDefaultProtocolConfig(protocol, portDetails),
                ...(interfaceConfig?.[protocol]?.[portId] || {}),
                pins: {
                  ...(portDetails.pins || {}),
                  ...((interfaceConfig?.[protocol]?.[portId] || {}).pins || {}),
                },
              };
              const isEnabled = !!portCfg.enabled;
              const color = PROTO_COLOR[protocol] || '#888';
              const portOpt = { id: portId, path: portDetails.path, pins: portDetails.pins || {} };

              return (
                <div key={key} style={{
                  borderRadius: 6, border: `1px solid ${isEnabled ? color + '55' : '#333'}`,
                  background: isEnabled ? color + '12' : '#1e1e1e',
                  overflow: 'hidden',
                }}>
                  {/* Port row */}
                  <div
                    onClick={() => togglePort(key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 10px', cursor: 'pointer', userSelect: 'none',
                    }}
                  >
                    {/* Enable toggle */}
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        handlePortChange(protocol, portId, { ...portCfg, enabled: checked }, portOpt);
                      }}
                      onClick={(e) => { e.stopPropagation(); e.nativeEvent?.stopImmediatePropagation?.(); }}
                      style={{ cursor: 'pointer', accentColor: color }}
                    />
                    {/* Protocol badge */}
                    <span style={{
                      fontSize: '9px', fontWeight: 'bold', padding: '1px 5px',
                      borderRadius: 3, background: color + '33', color,
                    }}>
                      {protocol}
                    </span>
                    {/* Port id + signals */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ color: '#ddd', fontSize: '11px', fontWeight: 'bold' }}>{portId}</span>
                      <span style={{ color: '#666', fontSize: '10px', marginLeft: 5 }}>{portDetails.path}</span>
                    </div>
                    {/* Signal badges */}
                    <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                      {signals.map((s) => (
                        <span key={s} style={{
                          fontSize: '8px', padding: '1px 4px', borderRadius: 2,
                          background: '#333', color: '#aaa',
                        }}>{s}</span>
                      ))}
                    </div>
                    <span style={{ fontSize: 9, color: '#666' }}>{isOpen ? '▼' : '▶'}</span>
                  </div>

                  {/* Expanded config */}
                  {isOpen && (
                    <div style={{ padding: '0 10px 10px' }}>
                      <ProtocolPortCard
                        board={board}
                        protocol={protocol}
                        port={portOpt}
                        value={portCfg}
                        onChange={(nextValue) => handlePortChange(protocol, portId, nextValue, portOpt)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div style={{ color: '#555', fontSize: '11px', padding: '4px 0' }}>
          {pin.type === 'gpio'
            ? t('board.noProtocolMapping')
            : t('board.pinTypeFallback', { type: String(pin.type || '').toUpperCase() })}
        </div>
      )}
    </div>
  );
};

// ===== BOARD SPECS CARD =====
const BoardSpecsCard = ({ board }) => {
  const { t } = useTranslation();
  const specs = [
    { label: t('board.cpuLabel'), value: board.cpu },
    { label: t('board.architectureLabel'), value: board.arch },
    { label: t('board.ramLabel'), value: board.ram },
    { label: t('board.storageLabel'), value: board.storage },
    { label: t('board.connectivityLabel'), value: board.connectivity },
    { label: t('board.usbLabel'), value: board.usb },
    { label: t('board.displayLabel'), value: board.display },
    { label: t('board.gpioCountLabel'), value: String(board.gpio) },
  ];

  return (
    <div style={{
      background: '#1e1e1e', borderRadius: 6, border: '1px solid #333',
      padding: 14, marginBottom: 12
    }}>
      <h4 style={{ margin: '0 0 10px 0', color: '#fff', fontSize: '13px' }}>{t('board.hardwareSpecs')}</h4>
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
const InterfacesCard = ({ board }) => {
  const { t } = useTranslation();
  return (
    <div style={{
      background: '#1e1e1e', borderRadius: 6, border: '1px solid #333',
      padding: 14, marginBottom: 12
    }}>
      <h4 style={{ margin: '0 0 10px 0', color: '#fff', fontSize: '13px' }}>{t('board.availableInterfaces')}</h4>
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
};

// ===== BOARD ICON HELPER =====
const boardIcon = (family) => {
  if (family === 'Raspberry Pi') return { icon: '🍓', bg: 'linear-gradient(135deg, #c51a4a, #8b1a3a)' };
  if (family === 'NVIDIA Jetson') return { icon: '🤖', bg: 'linear-gradient(135deg, #2e7d32, #1b5e20)' };
  return { icon: '🦴', bg: 'linear-gradient(135deg, #546e7a, #37474f)' };
};

const flattenBoardPins = (board) => {
  if (!board?.pinout) return [];
  if (Array.isArray(board.pinout)) return board.pinout;
  return Object.entries(board.pinout).flatMap(([header, pins]) =>
    (pins || []).map(pin => ({ ...pin, header }))
  );
};

const SIGNAL_KEYWORDS = {
  I2C: {
    SDA: ['SDA'],
    SCL: ['SCL'],
  },
  SPI: {
    MOSI: ['MOSI', 'D1', 'TX'],
    MISO: ['MISO', 'D0', 'RX'],
    SCLK: ['SCLK', 'SCK', 'CLK'],
    CS: ['CS', 'CE'],
  },
  UART: {
    TX: ['TX'],
    RX: ['RX'],
    RTS: ['RTS'],
    CTS: ['CTS'],
  },
};

const pinLabel = (pin) => {
  const headerPrefix = pin.header ? `${pin.header}.` : '';
  const alt = pin.alt ? ` - ${pin.alt}` : '';
  return `${headerPrefix}${pin.pin} ${pin.name}${alt}`;
};

const buildPinOptions = (board, protocol, signal, preferredLabel) => {
  const allPins = flattenBoardPins(board);
  const keywords = SIGNAL_KEYWORDS[protocol]?.[signal] || [signal];
  const matches = allPins.filter(pin => {
    const haystack = `${pin.name || ''} ${pin.alt || ''}`.toUpperCase();
    return keywords.some(keyword => haystack.includes(keyword));
  });
  const selectedPins = matches.length > 0 ? matches : allPins.filter(pin => pin.type === 'gpio');
  const options = selectedPins.map(pin => ({ value: pinLabel(pin), label: pinLabel(pin) }));
  if (preferredLabel && !options.some(option => option.value === preferredLabel)) {
    options.unshift({ value: preferredLabel, label: preferredLabel });
  }
  return options;
};

const getDefaultProtocolConfig = (protocol, port) => {
  if (protocol === 'I2C') {
    return { enabled: false, clockHz: 400000, pins: { ...(port.pins || {}) } };
  }
  if (protocol === 'SPI') {
    return { enabled: false, clockHz: 1000000, mode: 0, bitOrder: 'MSB', pins: { ...(port.pins || {}) } };
  }
  return { enabled: false, baudRate: 115200, parity: 'NONE', stopBits: 1, devicePath: port.path || '', pins: { ...(port.pins || {}) } };
};

const DetailBadge = ({ label, value, color = '#4a90d9' }) => (
  <div style={{
    padding: '4px 8px', borderRadius: 999, border: `1px solid ${color}33`,
    background: `${color}14`, color, fontSize: '10px', fontWeight: 'bold'
  }}>
    {label}: {value}
  </div>
);

const FieldLabel = ({ children }) => (
  <div style={{ fontSize: '10px', color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 }}>
    {children}
  </div>
);

const InputBaseStyle = {
  width: '100%',
  background: '#1e1e1e',
  border: '1px solid #3b3b3b',
  borderRadius: 6,
  color: '#ddd',
  padding: '8px 10px',
  fontSize: '12px',
  outline: 'none',
  boxSizing: 'border-box',
};

const ProtocolPortCard = ({ board, protocol, port, value, onChange }) => {
  const { t } = useTranslation();
  const update = (patch) => onChange({ ...value, ...patch });
  const updatePin = (signal, signalValue) => update({ pins: { ...(value.pins || {}), [signal]: signalValue } });
  const pinEntries = Object.entries(port.pins || {});

  return (
    <div style={{
      background: '#1e1e1e', borderRadius: 8, border: '1px solid #333',
      padding: 14, display: 'flex', flexDirection: 'column', gap: 12
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '13px' }}>{port.id}</div>
          <div style={{ color: '#777', fontSize: '11px', marginTop: 2 }}>{port.path}</div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#ccc', fontSize: '12px' }}>
          <input
            type="checkbox"
            checked={!!value.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          {t('board.enabled')}
        </label>
      </div>

      {pinEntries.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {pinEntries.map(([signal, signalValue]) => (
            <DetailBadge key={signal} label={signal} value={signalValue} />
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: protocol === 'UART' ? 'repeat(4, minmax(0, 1fr))' : 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        {protocol === 'I2C' && (
          <>
            <div>
              <FieldLabel>{t('board.clockHz')}</FieldLabel>
              <input
                type="number"
                value={value.clockHz ?? 400000}
                onChange={(e) => update({ clockHz: Number(e.target.value) || 0 })}
                style={InputBaseStyle}
              />
            </div>
            <div>
              <FieldLabel>{t('board.deviceNode')}</FieldLabel>
              <input value={port.path} readOnly style={{ ...InputBaseStyle, color: '#888' }} />
            </div>
          </>
        )}

        {protocol === 'SPI' && (
          <>
            <div>
              <FieldLabel>{t('board.clockHz')}</FieldLabel>
              <input
                type="number"
                value={value.clockHz ?? 1000000}
                onChange={(e) => update({ clockHz: Number(e.target.value) || 0 })}
                style={InputBaseStyle}
              />
            </div>
            <div>
              <FieldLabel>{t('board.spiMode')}</FieldLabel>
              <select value={value.mode ?? 0} onChange={(e) => update({ mode: Number(e.target.value) })} style={InputBaseStyle}>
                {[0, 1, 2, 3].map(mode => <option key={mode} value={mode}>{t('board.spiModeOption', { mode })}</option>)}
              </select>
            </div>
            <div>
              <FieldLabel>{t('board.bitOrder')}</FieldLabel>
              <select value={value.bitOrder ?? 'MSB'} onChange={(e) => update({ bitOrder: e.target.value })} style={InputBaseStyle}>
                <option value="MSB">{t('board.msbFirst')}</option>
                <option value="LSB">{t('board.lsbFirst')}</option>
              </select>
            </div>
            <div>
              <FieldLabel>{t('board.deviceNode')}</FieldLabel>
              <input value={port.path} readOnly style={{ ...InputBaseStyle, color: '#888' }} />
            </div>
          </>
        )}

        {protocol === 'UART' && (
          <>
            <div>
              <FieldLabel>{t('board.baudRate')}</FieldLabel>
              <select value={value.baudRate ?? 115200} onChange={(e) => update({ baudRate: Number(e.target.value) })} style={InputBaseStyle}>
                {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(baud => (
                  <option key={baud} value={baud}>{baud}</option>
                ))}
              </select>
            </div>
            <div>
              <FieldLabel>{t('board.parity')}</FieldLabel>
              <select value={value.parity ?? 'NONE'} onChange={(e) => update({ parity: e.target.value })} style={InputBaseStyle}>
                <option value="NONE">{t('board.none')}</option>
                <option value="EVEN">{t('board.even')}</option>
                <option value="ODD">{t('board.odd')}</option>
              </select>
            </div>
            <div>
              <FieldLabel>{t('board.stopBits')}</FieldLabel>
              <select value={value.stopBits ?? 1} onChange={(e) => update({ stopBits: Number(e.target.value) })} style={InputBaseStyle}>
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </div>
            <div>
              <FieldLabel>Device Path</FieldLabel>
              <input
                type="text"
                value={value.devicePath !== undefined && value.devicePath !== null ? value.devicePath : (port.path || '')}
                onChange={(e) => update({ devicePath: e.target.value })}
                placeholder={port.path || '/dev/ttyAMA0'}
                style={InputBaseStyle}
                spellCheck={false}
              />
            </div>
          </>
        )}
      </div>

      {pinEntries.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          {pinEntries.map(([signal, signalValue]) => {
            const options = buildPinOptions(board, protocol, signal, value.pins?.[signal] || signalValue);
            return (
              <div key={signal}>
                <FieldLabel>{t('board.signalPin', { signal })}</FieldLabel>
                <select
                  value={value.pins?.[signal] || signalValue}
                  onChange={(e) => updatePin(signal, e.target.value)}
                  style={InputBaseStyle}
                >
                  {options.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ===== MAIN BOARD CONFIG PAGE =====
const BoardConfigPage = ({ boardId, interfaceConfig = {}, onInterfaceConfigChange }) => {
  const { t } = useTranslation();
  const [selectedPin, setSelectedPin] = useState(null);
  const [horizontalRatio, setHorizontalRatio] = useState(0.5);
  const [verticalRatio, setVerticalRatio] = useState(0.5);
  const containerRef = useRef(null);
  const rightPaneRef = useRef(null);
  const dragging = useRef(false);
  const verticalDragging = useRef(false);
  const board = getBoardById(boardId);

  const onResizeMouseDown = useCallback((e) => {
    dragging.current = true;
    const onMove = (ev) => {
      if (!dragging.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const usableWidth = Math.max(1, rect.width - 20);
      const nextRightWidth = rect.right - ev.clientX;
      const nextRatio = nextRightWidth / usableWidth;
      setHorizontalRatio(Math.max(0.2, Math.min(0.8, nextRatio)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  }, []);

  const onVerticalResizeMouseDown = useCallback((e) => {
    verticalDragging.current = true;
    const onMove = (ev) => {
      if (!verticalDragging.current) return;
      const rect = rightPaneRef.current?.getBoundingClientRect();
      if (!rect) return;
      const usableHeight = Math.max(1, rect.height - 12);
      const nextTopHeight = ev.clientY - rect.top;
      const nextRatio = nextTopHeight / usableHeight;
      setVerticalRatio(Math.max(0.2, Math.min(0.8, nextRatio)));
    };
    const onUp = () => {
      verticalDragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  }, []);

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

  return (
    <div style={{ height: '100%', padding: '16px', background: '#1e1e1e', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 16, overflow: 'hidden' }}>
      {/* Board Title */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
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

      {/* Main Layout: Left (Pinout / I/O) + resize handle + Right (Details) */}
      <div
        ref={containerRef}
        style={{
          display: 'grid',
          gridTemplateColumns: `${Math.max(0.2, 1 - horizontalRatio)}fr 12px ${Math.max(0.2, horizontalRatio)}fr`,
          alignItems: 'stretch',
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          gap: 8,
        }}
      >
        {/* LEFT: Pinout Diagram */}
        <div style={{
          background: '#252526', borderRadius: 8, border: '1px solid #333',
          overflow: 'auto', minWidth: 0, minHeight: 0
        }}>
          <div style={{
            padding: '10px 14px', borderBottom: '1px solid #333',
            fontWeight: 'bold', fontSize: '12px', color: '#ccc',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between'
          }}>
            <span>{t('board.pinoutDiagram')}</span>
            <span style={{ fontSize: '10px', color: '#666', fontWeight: 'normal' }}>
              {board.gpio} GPIO
            </span>
          </div>

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
        </div>

        {/* Resize handle */}
        <div
          onMouseDown={onResizeMouseDown}
          style={{
            cursor: 'col-resize',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            minHeight: 0,
          }}
          title={t('board.resizeHorizontal')}
        >
          <div style={{ width: 4, height: 52, borderRadius: 999, background: '#4a4a4a' }} />
        </div>

        {/* RIGHT: Specs + Pin Detail */}
        <div
          ref={rightPaneRef}
          style={{
            display: 'grid',
            gridTemplateRows: `${Math.max(0.2, verticalRatio)}fr 12px ${Math.max(0.2, 1 - verticalRatio)}fr`,
            minHeight: 0,
            minWidth: 0,
            gap: 6,
          }}
        >
          <div style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
            <BoardSpecsCard board={board} />
            <InterfacesCard board={board} />
          </div>

          <>
            <div
              onMouseDown={onVerticalResizeMouseDown}
              style={{
                cursor: 'row-resize',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              title={t('board.resizeVertical')}
            >
              <div style={{ width: 52, height: 4, borderRadius: 999, background: '#4a4a4a' }} />
            </div>
            <div style={{
              background: '#252526', borderRadius: 6, border: '1px solid #333',
              minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
            }}>
              <div style={{
                padding: '8px 14px', borderBottom: '1px solid #333',
                fontWeight: 'bold', fontSize: '12px', color: '#ccc', flexShrink: 0,
              }}>
                {selectedPin ? t('board.pinDetails') : t('board.pinFunctions')}
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                <PinConfigPanel
                  key={selectedPin ? `${selectedPin.header || ''}${selectedPin.pin}` : 'none'}
                  pin={selectedPin}
                  board={board}
                  interfaceConfig={interfaceConfig}
                  onInterfaceConfigChange={onInterfaceConfigChange}
                />
              </div>
            </div>
          </>
        </div>
      </div>

    </div>
  );
};

export default BoardConfigPage;
