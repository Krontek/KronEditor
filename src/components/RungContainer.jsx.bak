import React, { useState, useCallback, useRef, useEffect } from 'react';
import ForceWriteModal from './common/ForceWriteModal';
import { formatTimeUs } from '../utils/plcStandards';
import ReactFlow, {
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  useReactFlow,
  useEdges
} from 'reactflow';
import 'reactflow/dist/style.css';
import DragDropManager from '../utils/DragDropManager';


/**
 * Her rung'un kendi mini ladder editörü
 * - Sol: Terminal - Kırmızı çizgi (fixed, canvas dışında)
 * - Orta: Bloklar (sürüklenebilir, React Flow içinde)
 * - Sağ: Terminal - Mavi çizgi (fixed, canvas dışında)
 */

// Terminal connection point - 24V ve 0V bağlantı noktaları
const TerminalConnectionPoint = ({ data, isConnectable }) => {
  const isLeft = data.position === 'left';
  const label = isLeft ? '24V' : '0V';
  const color = isLeft ? '#ff3333' : '#0066ff';

  return (
    <div style={{
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 20,
      height: 20,
      pointerEvents: 'auto'
    }}>
      {/* Half-filled Circle */}
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: 7, // Half width
        height: 14,
        borderRadius: isLeft ? '0 14px 14px 0' : '14px 0 0 14px',
        background: color,
        border: `2px solid ${color}`,
        zIndex: 10,
        transform: isLeft ? 'translate(0, -50%)' : 'translate(-100%, -50%)'
      }}>
        <Handle
          type={isLeft ? 'source' : 'target'}
          position={isLeft ? Position.Right : Position.Left}
          id={isLeft ? 'out' : 'in'}
          isConnectable={true}
          style={{
            background: 'transparent',
            width: 24,
            height: 24,
            border: 'none',
            opacity: 0,
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'all'
          }}
        />
      </div>
    </div>
  );
};

// Blok Yapılandırması ve Tip Tanımları
export const blockConfig = {
  TON: {
    label: 'TON',
    inputs: [{ name: 'IN', type: 'BOOL' }, { name: 'PT', type: 'TIME' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'ET', type: 'TIME' }]
  },
  TOF: {
    label: 'TOF',
    inputs: [{ name: 'IN', type: 'BOOL' }, { name: 'PT', type: 'TIME' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'ET', type: 'TIME' }]
  },
  TP: {
    label: 'TP',
    inputs: [{ name: 'IN', type: 'BOOL' }, { name: 'PT', type: 'TIME' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'ET', type: 'TIME' }]
  },
  TONR: {
    label: 'TONR',
    inputs: [{ name: 'IN', type: 'BOOL' }, { name: 'PT', type: 'TIME' }, { name: 'RESET', type: 'BOOL' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'ET', type: 'TIME' }]
  },
  CTU: {
    label: 'CTU',
    inputs: [{ name: 'CU', type: 'BOOL' }, { name: 'R', type: 'BOOL' }, { name: 'PV', type: 'INT' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'CV', type: 'INT' }]
  },
  CTD: {
    label: 'CTD',
    inputs: [{ name: 'CD', type: 'BOOL' }, { name: 'LD', type: 'BOOL' }, { name: 'PV', type: 'INT' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'CV', type: 'INT' }]
  },
  CTUD: {
    label: 'CTUD',
    inputs: [{ name: 'CU', type: 'BOOL' }, { name: 'CD', type: 'BOOL' }, { name: 'R', type: 'BOOL' }, { name: 'LD', type: 'BOOL' }, { name: 'PV', type: 'INT' }],
    outputs: [{ name: 'QU', type: 'BOOL' }, { name: 'QD', type: 'BOOL' }, { name: 'CV', type: 'INT' }]
  },
  R_TRIG: {
    label: 'R_TRIG',
    inputs: [{ name: 'CLK', type: 'BOOL' }],
    outputs: [{ name: 'Q', type: 'BOOL' }]
  },
  F_TRIG: {
    label: 'F_TRIG',
    inputs: [{ name: 'CLK', type: 'BOOL' }],
    outputs: [{ name: 'Q', type: 'BOOL' }]
  },
  RS: {
    label: 'RS',
    inputs: [{ name: 'S', type: 'BOOL' }, { name: 'R1', type: 'BOOL' }],
    outputs: [{ name: 'Q1', type: 'BOOL' }]
  },
  SR: {
    label: 'SR',
    inputs: [{ name: 'S1', type: 'BOOL' }, { name: 'R', type: 'BOOL' }],
    outputs: [{ name: 'Q1', type: 'BOOL' }]
  },
  // --- COMPARISON ---
  GT: { label: 'GT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DINT' }, { name: 'IN2', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }] },
  GE: { label: 'GE', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DINT' }, { name: 'IN2', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }] },
  EQ: { label: 'EQ', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DINT' }, { name: 'IN2', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }] },
  NE: { label: 'NE', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DINT' }, { name: 'IN2', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }] },
  LE: { label: 'LE', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DINT' }, { name: 'IN2', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }] },
  LT: { label: 'LT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DINT' }, { name: 'IN2', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }] },
  // --- ARITHMETIC ---
  ADD: { label: 'ADD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DINT' }, { name: 'IN2', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  SUB: { label: 'SUB', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DINT' }, { name: 'IN2', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  MUL: { label: 'MUL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DINT' }, { name: 'IN2', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  DIV: { label: 'DIV', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DINT' }, { name: 'IN2', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  MOD: { label: 'MOD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DINT' }, { name: 'IN2', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  MOVE: { label: 'MOVE', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  // --- MATH ---
  ABS: { label: 'ABS', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  SQRT: { label: 'SQRT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  EXPT: { label: 'EXPT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }, { name: 'EXP', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  MAX: { label: 'MAX', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'REAL' }, { name: 'IN2', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  MIN: { label: 'MIN', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'REAL' }, { name: 'IN2', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  LIMIT: { label: 'LIMIT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }, { name: 'MN', type: 'REAL' }, { name: 'MX', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  // --- BITWISE ---
  BAND: { label: 'BAND', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DWORD' }, { name: 'IN2', type: 'DWORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  BOR: { label: 'BOR', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DWORD' }, { name: 'IN2', type: 'DWORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  BXOR: { label: 'BXOR', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN1', type: 'DWORD' }, { name: 'IN2', type: 'DWORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  BNOT: { label: 'BNOT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DWORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  SHL: { label: 'SHL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DWORD' }, { name: 'N', type: 'USINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  SHR: { label: 'SHR', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DWORD' }, { name: 'N', type: 'USINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  ROL: { label: 'ROL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DWORD' }, { name: 'N', type: 'USINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  ROR: { label: 'ROR', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DWORD' }, { name: 'N', type: 'USINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  // --- TRIG ---
  SIN: { label: 'SIN', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  COS: { label: 'COS', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  TAN: { label: 'TAN', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  ASIN: { label: 'ASIN', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  ACOS: { label: 'ACOS', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  ATAN: { label: 'ATAN', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  // --- SELECTION ---
  SEL: { label: 'SEL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'G', type: 'BOOL' }, { name: 'IN0', type: 'DINT' }, { name: 'IN1', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  MUX: { label: 'MUX', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'K', type: 'USINT' }, { name: 'IN0', type: 'DINT' }, { name: 'IN1', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  // --- CONVERSION (TO_BOOL) ---
  BYTE_TO_BOOL: { label: 'BYTE_TO_BOOL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BYTE' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BOOL' }] },
  WORD_TO_BOOL: { label: 'WORD_TO_BOOL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'WORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BOOL' }] },
  DWORD_TO_BOOL: { label: 'DWORD_TO_BOOL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DWORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BOOL' }] },
  INT_TO_BOOL: { label: 'INT_TO_BOOL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'INT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BOOL' }] },
  UINT_TO_BOOL: { label: 'UINT_TO_BOOL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BOOL' }] },
  DINT_TO_BOOL: { label: 'DINT_TO_BOOL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BOOL' }] },
  UDINT_TO_BOOL: { label: 'UDINT_TO_BOOL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UDINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BOOL' }] },
  REAL_TO_BOOL: { label: 'REAL_TO_BOOL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BOOL' }] },
  // --- CONVERSION (TO_BYTE) ---
  BOOL_TO_BYTE: { label: 'BOOL_TO_BYTE', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BOOL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BYTE' }] },
  WORD_TO_BYTE: { label: 'WORD_TO_BYTE', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'WORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BYTE' }] },
  DWORD_TO_BYTE: { label: 'DWORD_TO_BYTE', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DWORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BYTE' }] },
  INT_TO_BYTE: { label: 'INT_TO_BYTE', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'INT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BYTE' }] },
  UINT_TO_BYTE: { label: 'UINT_TO_BYTE', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BYTE' }] },
  DINT_TO_BYTE: { label: 'DINT_TO_BYTE', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BYTE' }] },
  UDINT_TO_BYTE: { label: 'UDINT_TO_BYTE', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UDINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BYTE' }] },
  REAL_TO_BYTE: { label: 'REAL_TO_BYTE', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'BYTE' }] },
  // --- CONVERSION (TO_WORD) ---
  BOOL_TO_WORD: { label: 'BOOL_TO_WORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BOOL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'WORD' }] },
  BYTE_TO_WORD: { label: 'BYTE_TO_WORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BYTE' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'WORD' }] },
  DWORD_TO_WORD: { label: 'DWORD_TO_WORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DWORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'WORD' }] },
  INT_TO_WORD: { label: 'INT_TO_WORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'INT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'WORD' }] },
  UINT_TO_WORD: { label: 'UINT_TO_WORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'WORD' }] },
  DINT_TO_WORD: { label: 'DINT_TO_WORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'WORD' }] },
  UDINT_TO_WORD: { label: 'UDINT_TO_WORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UDINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'WORD' }] },
  REAL_TO_WORD: { label: 'REAL_TO_WORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'WORD' }] },
  // --- CONVERSION (TO_DWORD) ---
  BOOL_TO_DWORD: { label: 'BOOL_TO_DWORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BOOL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  BYTE_TO_DWORD: { label: 'BYTE_TO_DWORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BYTE' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  WORD_TO_DWORD: { label: 'WORD_TO_DWORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'WORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  INT_TO_DWORD: { label: 'INT_TO_DWORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'INT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  UINT_TO_DWORD: { label: 'UINT_TO_DWORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  DINT_TO_DWORD: { label: 'DINT_TO_DWORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  UDINT_TO_DWORD: { label: 'UDINT_TO_DWORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UDINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  REAL_TO_DWORD: { label: 'REAL_TO_DWORD', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DWORD' }] },
  // --- CONVERSION (TO_INT) ---
  BOOL_TO_INT: { label: 'BOOL_TO_INT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BOOL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'INT' }] },
  BYTE_TO_INT: { label: 'BYTE_TO_INT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BYTE' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'INT' }] },
  WORD_TO_INT: { label: 'WORD_TO_INT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'WORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'INT' }] },
  DWORD_TO_INT: { label: 'DWORD_TO_INT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DWORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'INT' }] },
  UINT_TO_INT: { label: 'UINT_TO_INT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'INT' }] },
  DINT_TO_INT: { label: 'DINT_TO_INT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'INT' }] },
  UDINT_TO_INT: { label: 'UDINT_TO_INT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UDINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'INT' }] },
  REAL_TO_INT: { label: 'REAL_TO_INT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'INT' }] },
  // --- CONVERSION (TO_UINT) ---
  BOOL_TO_UINT: { label: 'BOOL_TO_UINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BOOL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UINT' }] },
  BYTE_TO_UINT: { label: 'BYTE_TO_UINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BYTE' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UINT' }] },
  WORD_TO_UINT: { label: 'WORD_TO_UINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'WORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UINT' }] },
  DWORD_TO_UINT: { label: 'DWORD_TO_UINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DWORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UINT' }] },
  INT_TO_UINT: { label: 'INT_TO_UINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'INT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UINT' }] },
  DINT_TO_UINT: { label: 'DINT_TO_UINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UINT' }] },
  UDINT_TO_UINT: { label: 'UDINT_TO_UINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UDINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UINT' }] },
  REAL_TO_UINT: { label: 'REAL_TO_UINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UINT' }] },
  // --- CONVERSION (TO_DINT) ---
  BOOL_TO_DINT: { label: 'BOOL_TO_DINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BOOL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  BYTE_TO_DINT: { label: 'BYTE_TO_DINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BYTE' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  WORD_TO_DINT: { label: 'WORD_TO_DINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'WORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  DWORD_TO_DINT: { label: 'DWORD_TO_DINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DWORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  INT_TO_DINT: { label: 'INT_TO_DINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'INT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  UINT_TO_DINT: { label: 'UINT_TO_DINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  UDINT_TO_DINT: { label: 'UDINT_TO_DINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UDINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  REAL_TO_DINT: { label: 'REAL_TO_DINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'DINT' }] },
  // --- CONVERSION (TO_UDINT) ---
  BOOL_TO_UDINT: { label: 'BOOL_TO_UDINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BOOL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UDINT' }] },
  BYTE_TO_UDINT: { label: 'BYTE_TO_UDINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BYTE' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UDINT' }] },
  WORD_TO_UDINT: { label: 'WORD_TO_UDINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'WORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UDINT' }] },
  DWORD_TO_UDINT: { label: 'DWORD_TO_UDINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DWORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UDINT' }] },
  INT_TO_UDINT: { label: 'INT_TO_UDINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'INT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UDINT' }] },
  UINT_TO_UDINT: { label: 'UINT_TO_UDINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UDINT' }] },
  DINT_TO_UDINT: { label: 'DINT_TO_UDINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UDINT' }] },
  REAL_TO_UDINT: { label: 'REAL_TO_UDINT', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'UDINT' }] },
  // --- CONVERSION (TO_REAL) ---
  BOOL_TO_REAL: { label: 'BOOL_TO_REAL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BOOL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  BYTE_TO_REAL: { label: 'BYTE_TO_REAL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'BYTE' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  WORD_TO_REAL: { label: 'WORD_TO_REAL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'WORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  DWORD_TO_REAL: { label: 'DWORD_TO_REAL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DWORD' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  INT_TO_REAL: { label: 'INT_TO_REAL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'INT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  UINT_TO_REAL: { label: 'UINT_TO_REAL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  DINT_TO_REAL: { label: 'DINT_TO_REAL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'DINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  UDINT_TO_REAL: { label: 'UDINT_TO_REAL', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'IN', type: 'UDINT' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  NORM_X: { label: 'NORM_X', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'MIN', type: 'REAL' }, { name: 'MAX', type: 'REAL' }, { name: 'VALUE', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  SCALE_X: { label: 'SCALE_X', inputs: [{ name: 'EN', type: 'BOOL' }, { name: 'MIN', type: 'REAL' }, { name: 'MAX', type: 'REAL' }, { name: 'VALUE', type: 'REAL' }], outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'OUT', type: 'REAL' }] },
  // --- BASIC ELEMENTS ---
  Contact: { label: 'Contact', inputs: [], outputs: [] },
  Coil: { label: 'Coil', inputs: [], outputs: [] }
};

// SVG Path Helper
const getSymbolPath = (type, subType) => {
  if (type === 'Contact') {
    switch (subType) {
      case 'NC': // Normally Closed
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <line x1="10" y1="5" x2="10" y2="35" />
            <line x1="30" y1="5" x2="30" y2="35" />
            <line x1="30" y1="20" x2="40" y2="20" />
            <line x1="8" y1="35" x2="32" y2="5" />
          </g>
        );
      case 'Rising': // Rising Edge (P)
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <line x1="10" y1="5" x2="10" y2="35" />
            <line x1="30" y1="5" x2="30" y2="35" />
            <line x1="30" y1="20" x2="40" y2="20" />
            <text x="20" y="25" textAnchor="middle" fontSize="14" stroke="none" fill="currentColor">P</text>
          </g>
        );
      case 'Falling': // Falling Edge (N)
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <line x1="10" y1="5" x2="10" y2="35" />
            <line x1="30" y1="5" x2="30" y2="35" />
            <line x1="30" y1="20" x2="40" y2="20" />
            <text x="20" y="25" textAnchor="middle" fontSize="14" stroke="none" fill="currentColor">N</text>
          </g>
        );
      case 'NO': // Normally Open (Default)
      default:
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <line x1="10" y1="5" x2="10" y2="35" />
            <line x1="30" y1="5" x2="30" y2="35" />
            <line x1="30" y1="20" x2="40" y2="20" />
          </g>
        );
    }
  } else if (type === 'Coil') {
    switch (subType) {
      case 'Negated':
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <path d="M15,5 Q5,20 15,35" />
            <path d="M25,5 Q35,20 25,35" />
            <line x1="30" y1="20" x2="40" y2="20" />
            <line x1="15" y1="30" x2="25" y2="10" />
          </g>
        );
      case 'Set':
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <path d="M15,5 Q5,20 15,35" />
            <path d="M25,5 Q35,20 25,35" />
            <line x1="30" y1="20" x2="40" y2="20" />
            <text x="20" y="25" textAnchor="middle" fontSize="12" stroke="none" fill="currentColor">S</text>
          </g>
        );
      case 'Reset':
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <path d="M15,5 Q5,20 15,35" />
            <path d="M25,5 Q35,20 25,35" />
            <line x1="30" y1="20" x2="40" y2="20" />
            <text x="20" y="25" textAnchor="middle" fontSize="12" stroke="none" fill="currentColor">R</text>
          </g>
        );
      case 'Rising':
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <path d="M15,5 Q5,20 15,35" />
            <path d="M25,5 Q35,20 25,35" />
            <line x1="30" y1="20" x2="40" y2="20" />
            <text x="20" y="25" textAnchor="middle" fontSize="12" stroke="none" fill="currentColor">P</text>
          </g>
        );
      case 'Falling':
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <path d="M15,5 Q5,20 15,35" />
            <path d="M25,5 Q35,20 25,35" />
            <line x1="30" y1="20" x2="40" y2="20" />
            <text x="20" y="25" textAnchor="middle" fontSize="12" stroke="none" fill="currentColor">N</text>
          </g>
        );
      case 'Normal':
      default:
        return (
          <g stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="0" y1="20" x2="10" y2="20" />
            <path d="M15,5 Q5,20 15,35" />
            <path d="M25,5 Q35,20 25,35" />
            <line x1="30" y1="20" x2="40" y2="20" />
          </g>
        );
    }
  }
  return null;
};


const BlockNode = ({ id, data, isConnectable, selected }) => {
  const { setNodes } = useReactFlow();
  const edges = useEdges();
  const { variables = [], globalVars = [], dataTypes = [], liveVariables = null } = data; // Receive vars from data context

  // Build map of array type names → their definitions for validation
  const arrayTypeMap = React.useMemo(() => {
    const m = {};
    dataTypes.forEach(dt => { if (dt.type === 'Array') m[dt.name] = dt; });
    return m;
  }, [dataTypes]);

  // LOCAL STATE to prevent cursor jumping due to async prop updates
  const [localInstanceName, setLocalInstanceName] = useState(
    data.instanceName || (data.type === 'Contact' ? (data.values?.var || '') : (data.values?.coil || ''))
  );

  React.useEffect(() => {
    setLocalInstanceName(
      data.instanceName || (data.type === 'Contact' ? (data.values?.var || '') : (data.values?.coil || ''))
    );
  }, [data.instanceName, data.type, data.values?.var, data.values?.coil]);

  const [localPinValues, setLocalPinValues] = useState(data.values || {});
  const [forceModal, setForceModal] = useState(false);

  React.useEffect(() => {
    setLocalPinValues(data.values || {});
  }, [data.values]);


  const handleUpdate = useCallback((updates) => {
    setNodes((nds) => nds.map((n) => {
      if (n.id === id) {
        const newData = { ...n.data, ...updates };
        // Sync values if instanceName changes
        if (updates.instanceName) {
          newData.values = {
            ...(newData.values || {}),
            ...(newData.type === 'Contact' ? { var: updates.instanceName } : {}),
            ...(newData.type === 'Coil' ? { coil: updates.instanceName } : {})
          };
        }
        if (data.onUpdate) data.onUpdate(id, updates);
        return { ...n, data: newData };
      }
      return n;
    }));
  }, [id, setNodes, data]);

  if (data.type === 'Contact' || data.type === 'Coil') {
    const subType = data.subType || (data.type === 'Contact' ? 'NO' : 'Normal');
    const symbol = getSymbolPath(data.type, subType);
    const instanceName = data.instanceName || (data.type === 'Contact' ? (data.values?.var || '') : (data.values?.coil || '')); // Default to empty string for placeholder

    // LIVE VARIABLE CHECK
    const liveVariables = data.liveVariables;
    const safeProgName = (data.parentName || "").trim().replace(/\s+/g, '_');
    const safeName = instanceName ? instanceName.trim() : '';
    let lookupKey = null;
    if (liveVariables && safeName) {
      const progKey = `prog_${safeProgName}_${safeName}`;
      if (liveVariables[progKey] !== undefined) {
        lookupKey = progKey;
      } else {
        const globalKey = `prog__${safeName}`;
        lookupKey = liveVariables[globalKey] !== undefined ? globalKey : progKey;
      }
    }
    const isLiveActive = liveVariables && lookupKey && liveVariables[lookupKey] !== undefined;
    const canForce = !!data.onForceWrite && isLiveActive;
    const varDef = [...variables, ...globalVars].find(v => v.name === instanceName);
    const varType = varDef?.type || 'BOOL';

    const cycleType = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (data.readOnly) return;
      const contactTypes = ['NO', 'NC', 'Rising', 'Falling'];
      const coilTypes = ['Normal', 'Negated', 'Set', 'Reset', 'Rising', 'Falling'];
      const types = data.type === 'Contact' ? contactTypes : coilTypes;
      const currentIdx = types.indexOf(subType);
      const nextType = types[(currentIdx + 1) % types.length];
      handleUpdate({ subType: nextType });
    };

    return (
      <div style={{
        position: 'relative',
        width: 27,
        height: 27,
        minWidth: 27, // Explicit min width
        minHeight: 27, // Explicit min height
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        background: 'rgba(255, 255, 255, 0.05)',
        border: selected ? '2px solid #007acc' : (
          ((data.type === 'Contact' || data.type === 'Coil') && instanceName !== '' &&
            ![...variables, ...globalVars].some(v => v.name === instanceName.split(/[\[.]/)[0]))
            ? '2px solid #f44336' // RED ERROR BORDER
            : '1px solid transparent'
        ),
        borderRadius: 4
      }}>
        {/* Live Variable Overlay for Online Mode */}
        {isLiveActive && (
          <div
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); if (canForce) setForceModal(true); }}
            title={canForce ? 'Click to force-write value' : ''}
            style={{
              position: 'absolute',
              top: -50,
              left: '50%',
              transform: 'translateX(-50%)',
              background: liveVariables[lookupKey] ? '#00e676' : '#252526',
              color: liveVariables[lookupKey] ? '#000' : '#888',
              border: `1px solid ${liveVariables[lookupKey] ? '#00e676' : '#888'}`,
              padding: '2px 6px',
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 'bold',
              zIndex: 20,
              cursor: canForce ? 'pointer' : 'default',
              whiteSpace: 'nowrap'
            }}
          >
            {liveVariables[lookupKey] ? 'TRUE' : 'FALSE'}
          </div>
        )}
        {/* Interactive Controls (Top) */}
        <div style={{
          position: 'absolute',
          top: -30,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 4,
          alignItems: 'center',
          zIndex: 10
        }} onClick={(e) => e.stopPropagation()}>
          {/* Variable Input */}
          <input
            className="nodrag"
            value={localInstanceName}
            readOnly={!!data.readOnly}
            onChange={(e) => {
              if (data.readOnly) return;
              const rawValue = e.target.value;
              setLocalInstanceName(rawValue);
              const val = rawValue.replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
              handleUpdate({ instanceName: val });
            }}
            list={data.readOnly ? undefined : "ladder-vars-BOOL"}
            placeholder="??"
            style={{
              width: 80,
              height: 20,
              fontSize: 11,
              border: selected ? '1px solid #007acc' : '1px solid #333',
              background: '#252526',
              color: 'white',
              borderRadius: 2,
              padding: '0 4px',
              outline: 'none',
              textAlign: 'center'
            }}
          />
          {/* Type Toggle Button */}
          <div
            onClick={cycleType}
            className="nodrag"
            style={{
              height: 20,
              padding: '0 6px',
              background: '#007acc',
              color: 'white',
              fontSize: 10,
              fontWeight: 'bold',
              borderRadius: 2,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: 18,
              userSelect: 'none'
            }}
            title={`Current Type: ${subType}. Click to change.`}
          >
            {subType === 'Normal' ? 'N' : subType.substring(0, 3)}
          </div>
        </div>

        {/* SVG Symbol */}
        <svg width="27" height="27" viewBox="0 0 40 40" style={{ color: selected ? '#007acc' : '#fff', overflow: 'visible' }}>
          {symbol}
        </svg>

        {/* Handles */}
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          isConnectable={true}
          style={{
            width: 8,
            height: 8,
            background: 'transparent',
            left: -4,
            top: '50%',
            transform: 'translateY(-50%)',
            border: 'none',
            opacity: 0,
            zIndex: 5
          }}
        />
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          isConnectable={true}
          style={{
            background: 'transparent',
            width: 8,
            height: 8,
            right: -4,
            top: '50%',
            transform: 'translateY(-50%)',
            border: 'none',
            opacity: 0,
            zIndex: 5
          }}
        />
        {forceModal && (
          <ForceWriteModal
            isOpen={true}
            onClose={() => setForceModal(false)}
            varName={instanceName}
            varType={varType}
            currentValue={liveVariables?.[lookupKey]}
            liveKey={lookupKey}
            onConfirm={(key, val) => { data.onForceWrite && data.onForceWrite(key, val); }}
          />
        )}
      </div>
    );
  }

  // DYNAMIC CONFIGURATION FOR USER DEFINED BLOCKS
  let cfg;
  if (data.customData && data.customData.content) {
    const variables = data.customData.content?.variables || [];
    const inputs = variables
      .filter(v => v.class === 'Input' || v.class === 'InOut')
      .map(v => ({ name: v.name, type: v.type }));

    const outputs = variables
      .filter(v => v.class === 'Output')
      .map(v => ({ name: v.name, type: v.type }));

    // Add Return Type for Functions
    if (data.customData.returnType) {
      outputs.push({ name: 'OUT', type: data.customData.returnType });
    }

    cfg = {
      label: data.customData.name,
      inputs: inputs,
      outputs: outputs
    };
  } else {
    // Default config for standard blocks
    cfg = blockConfig[data.type] || {
      label: data.type,
      inputs: [{ name: 'IN', type: 'ANY' }, { name: 'IN2', type: 'ANY' }],
      outputs: [{ name: 'OUT', type: 'ANY' }, { name: 'OUT2', type: 'ANY' }]
    };
  }

  // Polymorphic type inference for basic math blocks:
  // output type follows input type — REAL if any input is REAL or has a decimal, else DINT
  const POLY_MATH = new Set(['ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'MOVE']);
  if (!data.customData && POLY_MATH.has(data.type)) {
    const allVars = [...variables, ...globalVars];
    const numPinNames = cfg.inputs.filter(p => p.type !== 'BOOL').map(p => p.name);
    let inferredType = 'DINT';
    for (const pinName of numPinNames) {
      const raw = (localPinValues[pinName] ?? data.values?.[pinName] ?? '');
      const val = String(raw).replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
      if (!val) continue;
      if (/^-?\d*\.\d+$|^-?\d+\.\d*$/.test(val)) { inferredType = 'REAL'; break; }
      const baseName = val.split(/[\[.]/)[0];
      const varDef = allVars.find(v => v.name === baseName);
      if (varDef && (varDef.type === 'REAL' || varDef.type === 'LREAL')) { inferredType = 'REAL'; break; }
    }
    cfg = {
      ...cfg,
      inputs:  cfg.inputs.map(p  => (p.type  === 'DINT' || p.type  === 'INT') ? { ...p,  type: inferredType } : p),
      outputs: cfg.outputs.map(p => (p.type === 'DINT' || p.type === 'INT') ? { ...p, type: inferredType } : p),
    };
  }

  // Execution Control (EN) varsa inputlara ekle
  const effectiveInputs = data.executionControl
    ? [{ name: 'EN', type: 'BOOL' }, ...cfg.inputs]
    : cfg.inputs;

  // Execution Control (EN) varsa outputlara ENO ekle
  const effectiveOutputs = data.executionControl
    ? [{ name: 'ENO', type: 'BOOL' }, ...cfg.outputs]
    : cfg.outputs;

  // Instance Name (Header)
  const instanceName = data.instanceName || `${data.type}_1`;

  // Input değeri değiştiğinde
  const handleInputChange = (pinLabel, value) => {
    // 1. React Flow state'ini güncelle (Hızlı UI tepkisi için)
    setNodes((nodes) =>
      nodes.map((node) => {
        if (node.id === id) {
          const newData = {
            ...node.data,
            values: {
              ...node.data.values,
              [pinLabel]: value
            }
          };

          // 2. Ana state'i güncelle (Veri kalıcılığı için)
          if (data.onUpdate) {
            data.onUpdate(id, { values: newData.values });
          }

          return {
            ...node,
            data: newData
          };
        }
        return node;
      })
    );
  };

  const isHandleConnected = (handleId, type) => {
    if (type === 'target') {
      return edges.some(e => e.target === id && e.targetHandle === handleId);
    } else {
      return edges.some(e => e.source === id && e.sourceHandle === handleId);
    }
  };

  return (
    <div style={{
      backgroundColor: selected ? '#3c3c3c' : '#252526',
      border: selected ? '2px solid #007acc' : '1px solid #666',
      borderRadius: 4,
      minWidth: 140,
      color: '#fff',
      fontSize: 11,
      overflow: 'visible',
      boxShadow: selected ? '0 0 8px rgba(0, 122, 204, 0.5)' : '0 2px 4px rgba(0,0,0,0.2)',
      transition: 'all 0.2s ease',
    }}>
      <div style={{
        background: '#333',
        padding: '2px 4px',
        textAlign: 'center',
        fontSize: '10px',
        color: '#ccc',
        borderBottom: '1px solid #444',
        borderTopLeftRadius: 3,
        borderTopRightRadius: 3
      }}>
        {instanceName}
      </div>
      <div style={{ background: '#0d47a1', padding: '4px 8px', textAlign: 'center', fontWeight: 'bold' }}>
        {cfg.label}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 4px' }}>
        {/* INPUTS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {effectiveInputs.map((pin, i) => {
            const handleId = `in_${i}`;
            const connected = isHandleConnected(handleId, 'target');
            const isTime = pin.type === 'TIME';
            const val = data.values?.[pin.name] || '';

            // IEC 61131-3 Time Literal Regex
            // Matches T#..., TIME#... with units d, h, m, s, ms. 
            // Case insensitive.
            const TIME_FORMAT_REGEX = /^(T|TIME)#-?(\d+(\.\d+)?(ms|d|h|m|s)_?)+$/i;
            const TIME_CHAR_REGEX = /^[0-9tihmds._#-]*$/i;

            const cleanVal = val.replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
            const baseValName = cleanVal.split(/[\[.]/)[0];
            const valVarDef = [...variables, ...globalVars].find(v => v.name === baseValName);
            const isArrayWithoutIndex = valVarDef && arrayTypeMap[valVarDef.type] && !cleanVal.includes('[');
            const isValid = !isArrayWithoutIndex && (!isTime || !val || TIME_FORMAT_REGEX.test(val));

            return (
              <div key={handleId} style={{ position: 'relative', display: 'flex', alignItems: 'center', height: 20 }}>
                {/* External Input Field (Blok dışında, solda) */}
                {!connected && (
                  <input
                    type="text"
                    className="nodrag"
                    value={localPinValues[pin.name] !== undefined ? localPinValues[pin.name] : (val || '')}
                    list={data.readOnly ? undefined : (pin.type === 'ANY' ? "ladder-vars-ANY" : `ladder-vars-${pin.type}`)}
                    readOnly={!!data.readOnly}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      if (data.readOnly) return;
                      const rawValue = e.target.value;
                      setLocalPinValues(prev => ({ ...prev, [pin.name]: rawValue }));

                      // Strip emojis coming from autocomplete suggestions (globally and trim)
                      const newValue = rawValue.replace(/[🌍🏠⊞⊡⊟]/g, '').trim();

                      if (isTime && !TIME_CHAR_REGEX.test(newValue)) return;
                      handleInputChange(pin.name, newValue);
                    }}
                    style={{
                      position: 'absolute',
                      right: '100%',
                      marginRight: 15, // Handle (10px) + Gap (5px)
                      width: 40,
                      fontSize: 10,
                      background: '#1e1e1e',
                      border: isValid ? '1px solid #444' : '1px solid #f44336',
                      color: isValid ? '#ddd' : '#f44336',
                      padding: '2px 4px',
                      borderRadius: 2,
                      outline: 'none',
                      textAlign: 'right'
                    }}
                    placeholder={isTime ? 'T#...' : '...'}
                  />
                )}

                {/* External Handle */}
                <Handle
                  type="target"
                  position={Position.Left}
                  id={handleId}
                  isConnectable={true}
                  style={{
                    width: 10,
                    height: 10,
                    background: '#4CAF50',
                    left: -10, // Kutu dışına
                    top: '50%',
                    transform: 'translateY(-50%)',
                    border: '1px solid #fff'
                  }}
                />

                {/* Label (Blok içinde - Tip kaldırıldı) */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1, marginLeft: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 'bold' }}>{pin.name}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* OUTPUTS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end', marginLeft: 10 }}>
          {effectiveOutputs.map((pin, i) => {
            const handleId = `out_${i}`;
            const connected = isHandleConnected(handleId, 'source');
            const val = data.values?.[pin.name] || '';
            const outCleanVal = val.replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
            const outBaseVarName = outCleanVal.split(/[\[.]/)[0];
            const outVarDef = [...variables, ...globalVars].find(v => v.name === outBaseVarName);
            const outIsArrayWithoutIndex = outVarDef && arrayTypeMap[outVarDef.type] && !outCleanVal.includes('[');

            // Live value lookup for this output pin
            const lv = liveVariables;
            let outLiveVal;
            if (lv) {
              const safeProgName = (data.parentName || '').trim().replace(/\s+/g, '_');
              const safeInstName = (data.instanceName || '').trim().replace(/\s+/g, '_');
              const assignedVar = val.replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
              if (assignedVar && /^[A-Za-z_]/.test(assignedVar)) {
                const safeVar = assignedVar.replace(/\s+/g, '_');
                const progKey = `prog_${safeProgName}_${safeVar}`;
                outLiveVal = lv[progKey] !== undefined ? lv[progKey] : lv[`prog__${safeVar}`];
              }
              if (outLiveVal === undefined && safeInstName) {
                outLiveVal = lv[`prog_${safeProgName}_out_${safeInstName}_${pin.name}`];
              }
            }
            const hasLive = outLiveVal !== undefined;
            const liveDisplay = hasLive
              ? (typeof outLiveVal === 'boolean'
                  ? (outLiveVal ? '1' : '0')
                  : pin.type === 'TIME' ? formatTimeUs(outLiveVal) : String(outLiveVal))
              : null;

            return (
              <div key={handleId} style={{ position: 'relative', display: 'flex', alignItems: 'center', height: 20 }}>
                {/* Label (Blok içinde - Tip kaldırıldı) */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1, marginRight: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 'bold' }}>{pin.name}</span>
                </div>

                {/* External Handle */}
                <Handle
                  type="source"
                  position={Position.Right}
                  id={handleId}
                  isConnectable={true}
                  style={{
                    width: 10,
                    height: 10,
                    background: '#FF5722',
                    right: -10,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    border: '1px solid #fff'
                  }}
                />

                {/* Live value badge (simulation mode) */}
                {!connected && lv && (
                  <span style={{
                    position: 'absolute',
                    left: '100%',
                    marginLeft: 15,
                    minWidth: 36,
                    fontSize: 10,
                    background: hasLive ? 'rgba(0,230,118,0.12)' : 'transparent',
                    border: `1px solid ${hasLive ? 'rgba(0,230,118,0.4)' : '#444'}`,
                    color: hasLive ? '#00e676' : '#555',
                    padding: '1px 4px',
                    borderRadius: 2,
                    fontFamily: 'Consolas, monospace',
                    textAlign: 'center',
                    pointerEvents: 'none'
                  }}>
                    {hasLive ? liveDisplay : '---'}
                  </span>
                )}

                {/* Edit-mode variable assignment field */}
                {!connected && !lv && (
                  <input
                    type="text"
                    className="nodrag"
                    value={localPinValues[pin.name] !== undefined ? localPinValues[pin.name] : val}
                    list={data.readOnly ? undefined : (pin.type === 'ANY' ? "ladder-vars-ANY" : `ladder-vars-${pin.type}`)}
                    readOnly={!!data.readOnly}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      if (data.readOnly) return;
                      const rawValue = e.target.value;
                      setLocalPinValues(prev => ({ ...prev, [pin.name]: rawValue }));
                      const newValue = rawValue.replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
                      handleInputChange(pin.name, newValue);
                    }}
                    style={{
                      position: 'absolute',
                      left: '100%',
                      marginLeft: 15,
                      width: 40,
                      fontSize: 10,
                      background: '#1e1e1e',
                      border: outIsArrayWithoutIndex ? '1px solid #f44336' : '1px solid #444',
                      color: outIsArrayWithoutIndex ? '#f44336' : '#ddd',
                      padding: '2px 4px',
                      borderRadius: 2,
                      outline: 'none',
                      textAlign: 'left'
                    }}
                    placeholder="..."
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div >
  );
};

// Node types defined outside to prevent re-creation on render
const nodeTypes = {
  terminalConnectionPoint: TerminalConnectionPoint,
  blockNode: BlockNode
};

const RungContainer = ({
  rung,
  index,
  totalRungs,
  onDelete,
  onMoveUp,
  onMoveDown,
  onAddBlock,
  onDeleteBlock,
  onAddConnection,
  onDeleteConnection,
  onUpdateBlock,
  onUpdateBlockPosition,

  onNodeDoubleClick,
  availableBlocks = [],
  variables = [],
  globalVars = [],
  dataTypes = [],
  liveVariables = null,
  parentName = "",
  readOnly = false,
  onForceWrite,
  isFocused = false,
  onInsertAbove,
  onInsertBelow = null
}) => {
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = React.useState(800);
  // Container ve Rung boyutları


  // Rung sınırları - containerWidth değişince güncellenir
  const RUNG_BOUNDS = React.useMemo(() => {
    const safeWidth = Math.max(containerWidth, 200);
    return {
      minX: 30,
      maxX: safeWidth - 30,
      height: 150 // Use constant logic
    };
  }, [containerWidth]);

  // Container genişliğini hesapla
  React.useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.clientWidth);
      }
    };
    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  // Constants moved/stabilized
  const LEFT_LINE_X = 12;
  const MIDDLE_Y = 75;
  const RUNG_HEIGHT = 150;

  // Helper to calculate block height
  const getBlockHeight = useCallback((type) => {
    if (type === 'Contact' || type === 'Coil') return 18;
    const config = blockConfig[type];
    if (!config) return 100;
    const rows = Math.max(config.inputs.length, config.outputs.length);
    // Header(~18) + Label(~22) + BodyPadding(16) + Rows*20 + Gaps(10)
    // 56 + rows*20 + (rows-1)*10 -> Simplify: 46 + rows*30
    const calculated = 46 + (rows * 30);
    return Math.min(calculated, RUNG_HEIGHT - 10);
  }, [RUNG_HEIGHT]);

  const createTerminalNodes = useCallback((width) => {
    const safeWidth = Math.max(width, 200);
    // Right Rail Center: width - 10px (margin) - 2px (half line width) = width - 12
    const rightLineX = safeWidth - 12;

    return [
      {
        id: 'terminal_left_middle',
        type: 'terminalConnectionPoint',
        position: { x: LEFT_LINE_X - 10, y: MIDDLE_Y - 10 },
        data: { position: 'left', label: '24V' },
        draggable: false,
        selectable: false,
        zIndex: 100
      },
      {
        id: 'terminal_right_middle',
        type: 'terminalConnectionPoint',
        position: { x: rightLineX - 10, y: MIDDLE_Y - 10 },
        data: { position: 'right', label: '0V' },
        draggable: false,
        selectable: false,
        zIndex: 100
      }
    ];
  }, [LEFT_LINE_X, MIDDLE_Y]);

  const mapBlocksToNodes = useCallback((blocks, width, selectedMap = {}, draggingMap = {}, prevNodes = []) => {
    const safeWidth = Math.max(width, 200);
    const bounds = {
      minX: 50,
      maxX: safeWidth - 50,
      height: RUNG_HEIGHT
    };

    return blocks.map(block => {
      // If node is currently being dragged, preserve its local state completely
      if (draggingMap[block.id]) {
        const prev = prevNodes.find(n => n.id === block.id);
        if (prev) return prev;
      }

      const height = getBlockHeight(block.data.type || block.type);
      return {
        id: block.id,
        type: 'blockNode',
        position: block.position,
        data: {
          ...block.data,
          type: block.data.label || block.type,
          values: block.data.values || {},
          onUpdate: (id, val) => onUpdateBlockRef.current(id, val),
          onForceWrite: (key, val) => onForceWriteRef.current?.(key, val),
          variables: variables, // Pass to node data
          globalVars: globalVars, // Pass to node data
          dataTypes: dataTypes,
          liveVariables: liveVariables, // Pass online mode data mapping
          parentName: parentName,
          readOnly: readOnly
        },
        draggable: !readOnly,
        selected: !!selectedMap[block.id],
        extent: [[bounds.minX, 0], [bounds.maxX, RUNG_HEIGHT]] // Fully relaxed Y constraint
      };
    });
  }, [getBlockHeight, variables, globalVars, dataTypes, liveVariables, parentName, readOnly]);

  const [nodes, setNodes, onNodesChange] = useNodesState([
    ...createTerminalNodes(containerWidth),
    ...mapBlocksToNodes(rung.blocks, containerWidth)
  ]);

  // Space key → toggle selected Contact variable in simulation mode
  React.useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code !== 'Space' || !onForceWrite || !liveVariables) return;
      const safeProgName = (parentName || '').trim().replace(/\s+/g, '_');
      nodes.forEach(node => {
        if (!node.selected || node.data?.type !== 'Contact') return;
        const varName = ((node.data.values?.var || node.data.instanceName) + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
        if (!varName) return;
        const safeVar = varName.replace(/\s+/g, '_');
        const progKey = `prog_${safeProgName}_${safeVar}`;
        const globalKey = `prog__${safeVar}`;
        let liveKey = progKey;
        let currentVal = false;
        if (liveVariables[progKey] !== undefined) {
          liveKey = progKey;
          currentVal = !!liveVariables[progKey];
        } else if (liveVariables[globalKey] !== undefined) {
          liveKey = globalKey;
          currentVal = !!liveVariables[globalKey];
        }
        e.preventDefault();
        onForceWrite(liveKey, !currentVal);
      });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nodes, liveVariables, parentName, onForceWrite]);

  // onNodesChange'i sarmalayarak pozisyon kontrolü ekle
  const handleNodesChange = useCallback((changes) => {
    const constrainedChanges = changes.map(change => {
      // Terminal node'ları değiştirme
      if (change.id === 'terminal_left_middle' || change.id === 'terminal_right_middle') {
        return change;
      }
      return change;
    });
    onNodesChange(constrainedChanges);
  }, [onNodesChange]);



  const [edges, setEdges, onEdgesChange] = useEdgesState(
    rung.connections.map(conn => ({
      id: conn.id,
      source: conn.source,
      target: conn.target,
      sourceHandle: conn.sourcePin,
      targetHandle: conn.targetPin,
      type: 'step',
      style: { stroke: '#fff', strokeWidth: 2 },
      animated: false,
    }))
  );

  // Callback ref'i oluştur
  const onUpdateBlockRef = useRef(onUpdateBlock);
  React.useEffect(() => {
    onUpdateBlockRef.current = onUpdateBlock;
  }, [onUpdateBlock]);

  const onForceWriteRef = useRef(onForceWrite);
  React.useEffect(() => {
    onForceWriteRef.current = onForceWrite;
  }, [onForceWrite]);

  // Rung.blocks değişince nodes'u güncelle
  React.useEffect(() => {


    setNodes((prevNodes) => {
      // Mevcut seçim durumlarını sakla
      const selectedMap = {};
      const draggingMap = {};
      if (prevNodes) {
        prevNodes.forEach(n => {
          if (n.selected) selectedMap[n.id] = true;
          if (n.dragging) draggingMap[n.id] = true;
        });
      }

      return [
        ...createTerminalNodes(containerWidth),
        ...mapBlocksToNodes(rung.blocks, containerWidth, selectedMap, draggingMap, prevNodes)
      ];
    });
  }, [rung.blocks, setNodes, containerWidth, createTerminalNodes, mapBlocksToNodes]);

  // Rung.connections değişince edges'ı güncelle
  React.useEffect(() => {
    setEdges(
      rung.connections.map(conn => ({
        id: conn.id,
        source: conn.source,
        target: conn.target,
        sourceHandle: conn.sourcePin,
        targetHandle: conn.targetPin,
        type: 'smoothstep',
        style: { stroke: '#fff', strokeWidth: 2 },
        animated: false,
      }))
    );
  }, [rung.connections, setEdges]);

  const { screenToFlowPosition, getNode, setViewport } = useReactFlow();
  const connectionEndPositionRef = useRef(null);

  // Viewport'u sabit tut
  React.useEffect(() => {
    setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 0 });
  }, [setViewport]);



  // Çizgilere yakın olup olmadığını kontrol et ve terminal node'a yönlendir
  const checkAndSnapToTerminal = useCallback((connection, endPosition = null) => {
    const safeWidth = Math.max(containerWidth, 200);
    const RIGHT_LINE_X_CALC = safeWidth - 12;
    const SNAP_THRESHOLD = 80;

    let finalConnection = { ...connection };

    // Eğer endPosition varsa (mouse pozisyonu), önce onu kontrol et
    if (endPosition) {
      const { x, y } = endPosition;

      // Sol çizgiye yakın mı kontrol et
      if (Math.abs(x - LEFT_LINE_X) < SNAP_THRESHOLD &&
        Math.abs(y - MIDDLE_Y) < SNAP_THRESHOLD) {
        if (connection.target) {
          finalConnection.target = 'terminal_left_middle';
          finalConnection.targetHandle = 'in';
        }
        if (connection.source) {
          finalConnection.source = 'terminal_left_middle';
          finalConnection.sourceHandle = 'out';
        }
        return finalConnection;
      }
      // Sağ çizgiye yakın mı kontrol et
      else if (Math.abs(x - RIGHT_LINE_X_CALC) < SNAP_THRESHOLD &&
        Math.abs(y - MIDDLE_Y) < SNAP_THRESHOLD) {
        if (connection.target) {
          finalConnection.target = 'terminal_right_middle';
          finalConnection.targetHandle = 'in';
        }
        if (connection.source) {
          finalConnection.source = 'terminal_right_middle';
          finalConnection.sourceHandle = 'out';
        }
        return finalConnection;
      }
    }

    // Mouse pozisyonu yoksa, node pozisyonlarını kontrol et
    const targetNode = connection.target ? getNode(connection.target) : null;
    if (targetNode) {
      const targetX = targetNode.type === 'terminalConnectionPoint' ? targetNode.position.x + 10 : targetNode.position.x;
      const targetY = targetNode.type === 'terminalConnectionPoint' ? targetNode.position.y + 10 : targetNode.position.y;

      if (Math.abs(targetX - LEFT_LINE_X) < SNAP_THRESHOLD &&
        Math.abs(targetY - MIDDLE_Y) < SNAP_THRESHOLD) {
        finalConnection.target = 'terminal_left_middle';
        finalConnection.targetHandle = 'in';
      }
      else if (Math.abs(targetX - RIGHT_LINE_X_CALC) < SNAP_THRESHOLD &&
        Math.abs(targetY - MIDDLE_Y) < SNAP_THRESHOLD) {
        finalConnection.target = 'terminal_right_middle';
        finalConnection.targetHandle = 'in';
      }
    }

    const sourceNode = connection.source ? getNode(connection.source) : null;
    if (sourceNode) {
      const sourceX = sourceNode.type === 'terminalConnectionPoint' ? sourceNode.position.x + 10 : sourceNode.position.x;
      const sourceY = sourceNode.type === 'terminalConnectionPoint' ? sourceNode.position.y + 10 : sourceNode.position.y;

      if (Math.abs(sourceX - LEFT_LINE_X) < SNAP_THRESHOLD &&
        Math.abs(sourceY - MIDDLE_Y) < SNAP_THRESHOLD) {
        finalConnection.source = 'terminal_left_middle';
        finalConnection.sourceHandle = 'out';
      }
      else if (Math.abs(sourceX - RIGHT_LINE_X_CALC) < SNAP_THRESHOLD &&
        Math.abs(sourceY - MIDDLE_Y) < SNAP_THRESHOLD) {
        finalConnection.source = 'terminal_right_middle';
        finalConnection.sourceHandle = 'out';
      }
    }

    return finalConnection;
  }, [getNode, containerWidth]);

  const onConnectStart = useCallback((event, { nodeId, handleType }) => {
    connectionEndPositionRef.current = null;
    setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 0 });
  }, [setViewport]);

  const onConnectEnd = useCallback((event) => {
    if (event && 'clientX' in event && 'clientY' in event) {
      const flowPos = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY
      });
      connectionEndPositionRef.current = flowPos;
    }
  }, [screenToFlowPosition]);

  const onConnect = useCallback((connection) => {
    const snappedConnection = checkAndSnapToTerminal(connection, connectionEndPositionRef.current);
    connectionEndPositionRef.current = null;

    const edge = {
      source: snappedConnection.source,
      target: snappedConnection.target,
      sourcePin: snappedConnection.sourceHandle,
      targetPin: snappedConnection.targetHandle
    };
    onAddConnection(edge);
    setEdges((eds) => addEdge({
      ...snappedConnection,
      type: 'smoothstep',
      style: { stroke: '#fff', strokeWidth: 2 },
      animated: false,
    }, eds));
  }, [onAddConnection, setEdges, checkAndSnapToTerminal]);

  const onNodesDelete = useCallback((deletedNodes) => {
    deletedNodes.forEach(node => {
      if (node.id !== 'terminal_left_middle' && node.id !== 'terminal_right_middle') {
        onDeleteBlock(node.id);
      }
    });
  }, [onDeleteBlock]);

  const onEdgesDelete = useCallback((deletedEdges) => {
    deletedEdges.forEach(edge => {
      onDeleteConnection(edge.id);
    });
  }, [onDeleteConnection]);

  const onDrop = useCallback((event) => {
    event.preventDefault();

    if (readOnly) { DragDropManager.clear(); return; }

    // Use DragDropManager instead of dataTransfer.getData
    const dragData = DragDropManager.getDragData();
    const blockType = dragData ? dragData.blockType : event.dataTransfer.getData('blockType');

    if (!blockType) return;

    // Use dragData for customData
    const customData = dragData ? dragData.customData : null;
    // (We also keep the old logic as fallback if needed, but manager is primary)

    // clientX, clientY'yi flow coordinate'lerine çevir
    const position = screenToFlowPosition({
      x: event.clientX,
      y: event.clientY
    });

    // Clamp drop position
    const height = getBlockHeight(blockType);

    // Strict Clamping to CURRENT height with Grid Snap Logic [10, 10]
    const maxAllowedY = Math.max(0, RUNG_HEIGHT - height - 5);
    const maxGridY = Math.floor(maxAllowedY / 10) * 10;

    // First calculate Raw Snap, then Clamp
    const rawSnappedY = Math.round(position.y / 10) * 10;
    const constrainedY = Math.max(0, Math.min(maxGridY, rawSnappedY));

    const constrainedX = Math.max(RUNG_BOUNDS.minX, Math.min(RUNG_BOUNDS.maxX, position.x));
    const snappedX = Math.round(constrainedX / 10) * 10;

    const clampedPosition = {
      x: snappedX,
      y: constrainedY
    };

    onAddBlock(blockType, clampedPosition, customData);
    DragDropManager.clear();
  }, [screenToFlowPosition, onAddBlock, RUNG_BOUNDS, getBlockHeight]);

  const onDragLeave = useCallback(() => {
  }, []);

  const isValidConnection = useCallback((connection) => {
    const sourceNode = getNode(connection.source);
    const targetNode = getNode(connection.target);

    if (!sourceNode || !targetNode) return false;

    // Terminal kontrolü
    const isSourceTerminal = sourceNode.type === 'terminalConnectionPoint';
    const isTargetTerminal = targetNode.type === 'terminalConnectionPoint';

    if (isSourceTerminal && sourceNode.data.position !== 'left') return false; // Right terminal source olamaz
    if (isTargetTerminal && targetNode.data.position !== 'right') return false; // Left terminal target olamaz

    // 2. TYPE CHECK
    const sourceType = isSourceTerminal ? 'BOOL' : (() => {
      if (!connection.sourceHandle) return 'ANY';
      const pinIndex = parseInt(connection.sourceHandle.split('_')[1]);

      // Dynamic output adjustment for ENO
      if (sourceNode.data.executionControl) {
        if (pinIndex === 0) return 'BOOL'; // ENO pin
        const config = blockConfig[sourceNode.data.type];
        return config?.outputs[pinIndex - 1]?.type || 'ANY';
      }

      const config = blockConfig[sourceNode.data.type];
      return config?.outputs[pinIndex]?.type || 'ANY';
    })();

    const targetType = isTargetTerminal ? 'BOOL' : (() => {
      if (!connection.targetHandle) return 'ANY';
      const pinIndex = parseInt(connection.targetHandle.split('_')[1]);

      // Dynamic input adjustment for EN
      if (targetNode.data.executionControl) {
        if (pinIndex === 0) return 'BOOL'; // EN pin
        const config = blockConfig[targetNode.data.type];
        return config?.inputs[pinIndex - 1]?.type || 'ANY';
      }

      const config = blockConfig[targetNode.data.type];
      return config?.inputs[pinIndex]?.type || 'ANY';
    })();

    if (sourceType !== targetType && sourceType !== 'ANY' && targetType !== 'ANY') {
      console.warn(`Type Mismatch: ${sourceType} -> ${targetType}`);
      return false;
    }

    return true;
  }, [getNode, blockConfig]);

  // Throttled Drag Handler (24 FPS ~= 40ms)
  const lastDragTimeRef = useRef(0);

  const throttleDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    // FPS LIMIT CHECK
    const now = Date.now();
    if (now - lastDragTimeRef.current < 40) {
      return;
    }
    lastDragTimeRef.current = now;

    // Retrieve FROM DragDropManager
    const dragData = DragDropManager.getDragData();
    // logDebug(`DragOver: ${JSON.stringify(dragData)}`); // Performance optimization

    if (!dragData) {
      return;
    }

  }, []);

  const onNodeDragStop = useCallback((event, node) => {
    // Blok pozisyonu değişince ana state'i güncelle
    if (node.id === 'terminal_left_middle' || node.id === 'terminal_right_middle') return;

    // Position değişmişse güncelle
    onUpdateBlockPosition(node.id, node.position);
  }, [onUpdateBlockPosition]);

  return (
    <div style={{
      background: '#2a2a2a',
      border: '2px solid #444',
      borderRadius: 8,
      overflow: 'hidden',
      boxShadow: '0 4px 6px rgba(0,0,0,0.3)'
    }}>
      {/* RUNG HEADER */}
      <div style={{
        background: isFocused ? '#333333' : '#252526',
        padding: '7px 11px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: '1px solid #444'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
          <div
            className="rung-drag-handle"
            title="Sürükleyip Bırak"
            style={{
              padding: '4px',
              cursor: readOnly ? 'default' : 'grab',
              opacity: readOnly ? 0.3 : 0.7,
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
            }}
          >
            <div style={{ display: 'flex', gap: '2px' }}>
              <div style={{ width: 3, height: 3, background: 'white', borderRadius: '50%' }}></div>
              <div style={{ width: 3, height: 3, background: 'white', borderRadius: '50%' }}></div>
            </div>
            <div style={{ display: 'flex', gap: '2px' }}>
              <div style={{ width: 3, height: 3, background: 'white', borderRadius: '50%' }}></div>
              <div style={{ width: 3, height: 3, background: 'white', borderRadius: '50%' }}></div>
            </div>
            <div style={{ display: 'flex', gap: '2px' }}>
              <div style={{ width: 3, height: 3, background: 'white', borderRadius: '50%' }}></div>
              <div style={{ width: 3, height: 3, background: 'white', borderRadius: '50%' }}></div>
            </div>
          </div>
          <span style={{ color: isFocused ? '#4da6ff' : '#fff', fontWeight: 'bold', fontSize: 10 }}>
            Rung {index}: {rung.label}
          </span>
          <span style={{ color: '#888', fontSize: 8 }}>
            ({rung.blocks.length} blok)
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>

          <button
            onClick={onMoveUp}
            disabled={index === 0}
            style={{
              background: index === 0 ? '#444' : '#0d47a1',
              color: '#fff',
              border: 'none',
              padding: '3.5px 7px',
              borderRadius: 3,
              cursor: index === 0 ? 'not-allowed' : 'pointer',
              fontSize: 8,
              fontWeight: 'bold'
            }}
          >
            ↑ Yukarı
          </button>
          <button
            onClick={onMoveDown}
            disabled={index === totalRungs - 1}
            style={{
              background: index === totalRungs - 1 ? '#444' : '#0d47a1',
              color: '#fff',
              border: 'none',
              padding: '3.5px 7px',
              borderRadius: 3,
              cursor: index === totalRungs - 1 ? 'not-allowed' : 'pointer',
              fontSize: 8,
              fontWeight: 'bold'
            }}
          >
            ↓ Aşağı
          </button>
          <button
            onClick={onDelete}
            style={{
              background: '#c62828',
              color: '#fff',
              border: 'none',
              padding: '3.5px 7px',
              borderRadius: 3,
              cursor: 'pointer',
              fontSize: 8,
              fontWeight: 'bold'
            }}
          >
            🗑 Sil
          </button>
        </div>
      </div>

      {/* RUNG EDITOR CANVAS */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: RUNG_HEIGHT,
          background: '#1e1e1e',
          position: 'relative',
          border: '1px dashed #444',
          overflow: 'hidden'
        }}
      // Handlers moved back to ReactFlow for better integration
      >
        {/* Terminal Çizgileri Arka Planda */}
        <div style={{
          position: 'absolute',
          left: 10,
          top: 0,
          bottom: 0,
          width: 4,
          background: '#ff3333',
          pointerEvents: 'none',
          zIndex: 0
        }} />

        <div style={{
          position: 'absolute',
          right: 10,
          top: 0,
          bottom: 0,
          width: 4,
          background: '#0066ff',
          pointerEvents: 'none',
          zIndex: 0
        }} />

        <ReactFlow
          style={{ zIndex: 5 }}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onNodesDelete={onNodesDelete}
          onEdgesDelete={onEdgesDelete}
          isValidConnection={isValidConnection}
          onDrop={onDrop}
          onDragOver={throttleDragOver}
          onDragLeave={(e) => {
            // Fix: Only clear ghost if we genuinely leave the container
            // (e.relatedTarget is the element we are entering)
            if (!e.currentTarget.contains(e.relatedTarget)) {
              setDragGhost(null);
            }
          }}
          onNodeDragStop={onNodeDragStop}
          onNodeDoubleClick={onNodeDoubleClick}
          snapToGrid={true}
          snapGrid={[10, 10]}
          minZoom={1}
          maxZoom={1}
          fitView={false}
          attributionPosition="top-left"
          proOptions={{ hideAttribution: true }}
          selectionOnDrag={false}
          panOnDrag={false}
          panOnScroll={false}
          panOnConnect={false}
          autoPanOnConnect={false}
          autoPanOnNodeDrag={false}
          preventScrolling={false}
          zoomOnScroll={false}
          edgesUpdatable={true}
          edgesFocusable={true}
          edgesSelectable={true}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          nodesSelectable={true}
          deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
          multiSelectionKeyCode={['Meta', 'Ctrl']}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        />
      </div>
    </div>
  );
};

// Wrapper with ReactFlowProvider
const RungContainerWrapper = (props) => (
  <ReactFlowProvider>
    <RungContainer {...props} />
  </ReactFlowProvider>
);

export default RungContainerWrapper;
