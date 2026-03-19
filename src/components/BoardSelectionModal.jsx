import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BOARD_FAMILIES } from '../utils/boardDefinitions';

const BoardSelectionModal = ({ isOpen, onClose, onSelect, currentBoard }) => {
  const { t } = useTranslation();
  const [expandedFamily, setExpandedFamily] = useState(null);
  const [hoveredBoard, setHoveredBoard] = useState(null);

  if (!isOpen) return null;

  const handleSelect = (boardId) => {
    onSelect(boardId);
    onClose();
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}>
      <div style={{
        background: '#252526', width: 580, maxHeight: '80vh', borderRadius: 8,
        border: '1px solid #333', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 20px', background: '#2d2d2d', borderBottom: '1px solid #333',
          fontWeight: 'bold', fontSize: '14px', color: '#fff',
          display: 'flex', alignItems: 'center', gap: 8
        }}>
          <span style={{ fontSize: '18px' }}>🔧</span>
          {t('board.selectBoard')}
        </div>

        {/* Board Families */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
          {BOARD_FAMILIES.map((family) => (
            <div key={family.name} style={{ marginBottom: 8 }}>
              {/* Family Header */}
              <div
                onClick={() => setExpandedFamily(expandedFamily === family.name ? null : family.name)}
                style={{
                  padding: '10px 14px',
                  background: expandedFamily === family.name ? '#1e3a5f' : '#1e1e1e',
                  border: '1px solid',
                  borderColor: expandedFamily === family.name ? '#007acc' : '#333',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: '#fff',
                  fontSize: '14px',
                  fontWeight: 'bold',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  transition: 'all 0.15s ease',
                }}
              >
                <span style={{ fontSize: '20px' }}>{family.icon}</span>
                <span style={{ flex: 1 }}>{family.name}</span>
                <span style={{ fontSize: '11px', color: '#888' }}>
                  {family.boards.length} {t('board.variants')}
                </span>
                <span style={{ fontSize: '12px', color: '#666', transition: 'transform 0.15s', transform: expandedFamily === family.name ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
              </div>

              {/* Variant Boards */}
              {expandedFamily === family.name && (
                <div style={{ padding: '6px 0 0 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {family.boards.map((board) => {
                    const isSelected = currentBoard === board.id;
                    const isHovered = hoveredBoard === board.id;

                    return (
                      <div
                        key={board.id}
                        onClick={() => handleSelect(board.id)}
                        onMouseEnter={() => setHoveredBoard(board.id)}
                        onMouseLeave={() => setHoveredBoard(null)}
                        style={{
                          padding: '10px 14px',
                          marginLeft: 16,
                          background: isSelected ? '#007acc' : isHovered ? '#2a2d2e' : '#1e1e1e',
                          border: '1px solid',
                          borderColor: isSelected ? '#007acc' : '#333',
                          borderRadius: 5,
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {isSelected && <span style={{ color: '#fff', fontSize: '14px' }}>✓</span>}
                          <span style={{ color: '#fff', fontSize: '13px', fontWeight: '600' }}>{board.name}</span>
                        </div>
                        <div style={{ marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '11px', color: isSelected ? '#ddd' : '#888' }}>
                            {board.cpu.split('(')[0].trim()}
                          </span>
                          {board.pinLayout === 'edatec_ipc' ? (() => {
                            const p = board.pinout;
                            const rs485 = p.serialPorts.filter(s => s.type === 'RS485').length;
                            const rs232 = p.serialPorts.filter(s => s.type === 'RS232').length;
                            return (
                              <>
                                {rs485 > 0 && <span style={{ fontSize: '11px', color: isSelected ? '#ddd' : '#666' }}>RS485: {rs485}</span>}
                                {rs232 > 0 && <span style={{ fontSize: '11px', color: isSelected ? '#ddd' : '#666' }}>RS232: {rs232}</span>}
                                {p.canCount > 0 && <span style={{ fontSize: '11px', color: isSelected ? '#ddd' : '#666' }}>CAN: {p.canCount}</span>}
                                {p.diCount > 0 && <span style={{ fontSize: '11px', color: isSelected ? '#ddd' : '#666' }}>DI: {p.diCount}</span>}
                                {p.doCount > 0 && <span style={{ fontSize: '11px', color: isSelected ? '#ddd' : '#666' }}>DO: {p.doCount}</span>}
                              </>
                            );
                          })() : (
                            <>
                              <span style={{ fontSize: '11px', color: isSelected ? '#ddd' : '#666' }}>
                                RAM: {board.ram.split('/')[0].trim()}
                              </span>
                              <span style={{ fontSize: '11px', color: isSelected ? '#ddd' : '#666' }}>
                                GPIO: {board.gpio}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 20px', background: '#1e1e1e', borderTop: '1px solid #333',
          display: 'flex', justifyContent: 'flex-end'
        }}>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', color: '#ccc', border: '1px solid #555',
              padding: '6px 16px', cursor: 'pointer', borderRadius: 4, fontSize: '13px'
            }}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BoardSelectionModal;
