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
    label: 'TON', descriptionKey: 'blockInfo.TON',
    inputs: [{ name: 'IN', type: 'BOOL' }, { name: 'PT', type: 'TIME' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'ET', type: 'TIME' }]
  },
  TOF: {
    label: 'TOF', descriptionKey: 'blockInfo.TOF',
    inputs: [{ name: 'IN', type: 'BOOL' }, { name: 'PT', type: 'TIME' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'ET', type: 'TIME' }]
  },
  TP: {
    label: 'TP', descriptionKey: 'blockInfo.TP',
    inputs: [{ name: 'IN', type: 'BOOL' }, { name: 'PT', type: 'TIME' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'ET', type: 'TIME' }]
  },
  TONR: {
    label: 'TONR', descriptionKey: 'blockInfo.TONR',
    inputs: [{ name: 'IN', type: 'BOOL' }, { name: 'PT', type: 'TIME' }, { name: 'RESET', type: 'BOOL' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'ET', type: 'TIME' }]
  },
  CTU: {
    label: 'CTU', descriptionKey: 'blockInfo.CTU',
    inputs: [{ name: 'CU', type: 'BOOL' }, { name: 'R', type: 'BOOL' }, { name: 'PV', type: 'INT' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'CV', type: 'INT' }]
  },
  CTD: {
    label: 'CTD', descriptionKey: 'blockInfo.CTD',
    inputs: [{ name: 'CD', type: 'BOOL' }, { name: 'LD', type: 'BOOL' }, { name: 'PV', type: 'INT' }],
    outputs: [{ name: 'Q', type: 'BOOL' }, { name: 'CV', type: 'INT' }]
  },
  CTUD: {
    label: 'CTUD', descriptionKey: 'blockInfo.CTUD',
    inputs: [{ name: 'CU', type: 'BOOL' }, { name: 'CD', type: 'BOOL' }, { name: 'R', type: 'BOOL' }, { name: 'LD', type: 'BOOL' }, { name: 'PV', type: 'INT' }],
    outputs: [{ name: 'QU', type: 'BOOL' }, { name: 'QD', type: 'BOOL' }, { name: 'CV', type: 'INT' }]
  },
  R_TRIG: {
    label: 'R_TRIG', descriptionKey: 'blockInfo.R_TRIG',
    inputs: [{ name: 'CLK', type: 'BOOL' }],
    outputs: [{ name: 'Q', type: 'BOOL' }]
  },
  F_TRIG: {
    label: 'F_TRIG', descriptionKey: 'blockInfo.F_TRIG',
    inputs: [{ name: 'CLK', type: 'BOOL' }],
    outputs: [{ name: 'Q', type: 'BOOL' }]
  },
  RS: {
    label: 'RS', descriptionKey: 'blockInfo.RS',
    inputs: [{ name: 'S', type: 'BOOL' }, { name: 'R1', type: 'BOOL' }],
    outputs: [{ name: 'Q1', type: 'BOOL' }]
  },
  SR: {
    label: 'SR', descriptionKey: 'blockInfo.SR',
    inputs: [{ name: 'S1', type: 'BOOL' }, { name: 'R', type: 'BOOL' }],
    outputs: [{ name: 'Q1', type: 'BOOL' }]
  },
  // --- COMPARISON ---
  GT: { label: 'GT', descriptionKey: 'blockInfo.GT', inputs: [{ name: 'IN1', type: 'ANY_NUM' }, { name: 'IN2', type: 'ANY_NUM' }], outputs: [{ name: 'Q', type: 'BOOL' }] },
  GE: { label: 'GE', descriptionKey: 'blockInfo.GE', inputs: [{ name: 'IN1', type: 'ANY_NUM' }, { name: 'IN2', type: 'ANY_NUM' }], outputs: [{ name: 'Q', type: 'BOOL' }] },
  EQ: { label: 'EQ', descriptionKey: 'blockInfo.EQ', inputs: [{ name: 'IN1', type: 'ANY_NUM' }, { name: 'IN2', type: 'ANY_NUM' }], outputs: [{ name: 'Q', type: 'BOOL' }] },
  NE: { label: 'NE', descriptionKey: 'blockInfo.NE', inputs: [{ name: 'IN1', type: 'ANY_NUM' }, { name: 'IN2', type: 'ANY_NUM' }], outputs: [{ name: 'Q', type: 'BOOL' }] },
  LE: { label: 'LE', descriptionKey: 'blockInfo.LE', inputs: [{ name: 'IN1', type: 'ANY_NUM' }, { name: 'IN2', type: 'ANY_NUM' }], outputs: [{ name: 'Q', type: 'BOOL' }] },
  LT: { label: 'LT', descriptionKey: 'blockInfo.LT', inputs: [{ name: 'IN1', type: 'ANY_NUM' }, { name: 'IN2', type: 'ANY_NUM' }], outputs: [{ name: 'Q', type: 'BOOL' }] },
  // --- ARITHMETIC ---
  ADD: { label: 'ADD', descriptionKey: 'blockInfo.ADD', inputs: [{ name: 'IN1', type: 'ANY_NUM' }, { name: 'IN2', type: 'ANY_NUM' }], outputs: [{ name: 'OUT', type: 'ANY_NUM' }] },
  SUB: { label: 'SUB', descriptionKey: 'blockInfo.SUB', inputs: [{ name: 'IN1', type: 'ANY_NUM' }, { name: 'IN2', type: 'ANY_NUM' }], outputs: [{ name: 'OUT', type: 'ANY_NUM' }] },
  MUL: { label: 'MUL', descriptionKey: 'blockInfo.MUL', inputs: [{ name: 'IN1', type: 'ANY_NUM' }, { name: 'IN2', type: 'ANY_NUM' }], outputs: [{ name: 'OUT', type: 'ANY_NUM' }] },
  DIV: { label: 'DIV', descriptionKey: 'blockInfo.DIV', inputs: [{ name: 'IN1', type: 'ANY_NUM' }, { name: 'IN2', type: 'ANY_NUM' }], outputs: [{ name: 'OUT', type: 'ANY_NUM' }] },
  MOD: { label: 'MOD', descriptionKey: 'blockInfo.MOD', inputs: [{ name: 'IN1', type: 'ANY_NUM' }, { name: 'IN2', type: 'ANY_NUM' }], outputs: [{ name: 'OUT', type: 'ANY_NUM' }] },
  MOVE: { label: 'MOVE', descriptionKey: 'blockInfo.MOVE', inputs: [{ name: 'IN', type: 'ANY_NUM' }], outputs: [{ name: 'OUT', type: 'ANY_NUM' }] },
  // --- MATH ---
  ABS: { label: 'ABS', descriptionKey: 'blockInfo.ABS', inputs: [{ name: 'IN', type: 'ANY_NUM' }], outputs: [{ name: 'OUT', type: 'ANY_NUM' }] },
  SQRT: { label: 'SQRT', descriptionKey: 'blockInfo.SQRT', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  EXPT: { label: 'EXPT', descriptionKey: 'blockInfo.EXPT', inputs: [{ name: 'IN', type: 'REAL' }, { name: 'EXP', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  MAX: { label: 'MAX', descriptionKey: 'blockInfo.MAX', inputs: [{ name: 'IN1', type: 'ANY_NUM' }, { name: 'IN2', type: 'ANY_NUM' }], outputs: [{ name: 'OUT', type: 'ANY_NUM' }] },
  MIN: { label: 'MIN', descriptionKey: 'blockInfo.MIN', inputs: [{ name: 'IN1', type: 'ANY_NUM' }, { name: 'IN2', type: 'ANY_NUM' }], outputs: [{ name: 'OUT', type: 'ANY_NUM' }] },
  LIMIT: { label: 'LIMIT', descriptionKey: 'blockInfo.LIMIT', inputs: [{ name: 'IN', type: 'ANY_NUM' }, { name: 'MN', type: 'ANY_NUM' }, { name: 'MX', type: 'ANY_NUM' }], outputs: [{ name: 'OUT', type: 'ANY_NUM' }] },
  // --- BITWISE ---
  BAND: { label: 'BAND', descriptionKey: 'blockInfo.BAND', inputs: [{ name: 'IN1', type: 'DWORD' }, { name: 'IN2', type: 'DWORD' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  BOR: { label: 'BOR', descriptionKey: 'blockInfo.BOR', inputs: [{ name: 'IN1', type: 'DWORD' }, { name: 'IN2', type: 'DWORD' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  BXOR: { label: 'BXOR', descriptionKey: 'blockInfo.BXOR', inputs: [{ name: 'IN1', type: 'DWORD' }, { name: 'IN2', type: 'DWORD' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  BNOT: { label: 'BNOT', descriptionKey: 'blockInfo.BNOT', inputs: [{ name: 'IN', type: 'DWORD' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  SHL: { label: 'SHL', descriptionKey: 'blockInfo.SHL', inputs: [{ name: 'IN', type: 'DWORD' }, { name: 'N', type: 'USINT' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  SHR: { label: 'SHR', descriptionKey: 'blockInfo.SHR', inputs: [{ name: 'IN', type: 'DWORD' }, { name: 'N', type: 'USINT' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  ROL: { label: 'ROL', descriptionKey: 'blockInfo.ROL', inputs: [{ name: 'IN', type: 'DWORD' }, { name: 'N', type: 'USINT' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  ROR: { label: 'ROR', descriptionKey: 'blockInfo.ROR', inputs: [{ name: 'IN', type: 'DWORD' }, { name: 'N', type: 'USINT' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  // --- TRIG ---
  SIN: { label: 'SIN', descriptionKey: 'blockInfo.SIN', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  COS: { label: 'COS', descriptionKey: 'blockInfo.COS', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  TAN: { label: 'TAN', descriptionKey: 'blockInfo.TAN', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  ASIN: { label: 'ASIN', descriptionKey: 'blockInfo.ASIN', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  ACOS: { label: 'ACOS', descriptionKey: 'blockInfo.ACOS', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  ATAN: { label: 'ATAN', descriptionKey: 'blockInfo.ATAN', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  // --- SELECTION ---
  SEL: { label: 'SEL', descriptionKey: 'blockInfo.SEL', inputs: [{ name: 'G', type: 'BOOL' }, { name: 'IN0', type: 'ANY_NUM' }, { name: 'IN1', type: 'ANY_NUM' }], outputs: [{ name: 'OUT', type: 'ANY_NUM' }] },
  MUX: { label: 'MUX', descriptionKey: 'blockInfo.MUX', inputs: [{ name: 'K', type: 'USINT' }, { name: 'IN0', type: 'ANY_NUM' }, { name: 'IN1', type: 'ANY_NUM' }], outputs: [{ name: 'OUT', type: 'ANY_NUM' }] },
  // --- CONVERSION (TO_BOOL) ---
  BYTE_TO_BOOL: { label: 'BYTE_TO_BOOL', inputs: [{ name: 'IN', type: 'BYTE' }], outputs: [{ name: 'OUT', type: 'BOOL' }] },
  WORD_TO_BOOL: { label: 'WORD_TO_BOOL', inputs: [{ name: 'IN', type: 'WORD' }], outputs: [{ name: 'OUT', type: 'BOOL' }] },
  DWORD_TO_BOOL: { label: 'DWORD_TO_BOOL', inputs: [{ name: 'IN', type: 'DWORD' }], outputs: [{ name: 'OUT', type: 'BOOL' }] },
  INT_TO_BOOL: { label: 'INT_TO_BOOL', inputs: [{ name: 'IN', type: 'INT' }], outputs: [{ name: 'OUT', type: 'BOOL' }] },
  UINT_TO_BOOL: { label: 'UINT_TO_BOOL', inputs: [{ name: 'IN', type: 'UINT' }], outputs: [{ name: 'OUT', type: 'BOOL' }] },
  DINT_TO_BOOL: { label: 'DINT_TO_BOOL', inputs: [{ name: 'IN', type: 'DINT' }], outputs: [{ name: 'OUT', type: 'BOOL' }] },
  UDINT_TO_BOOL: { label: 'UDINT_TO_BOOL', inputs: [{ name: 'IN', type: 'UDINT' }], outputs: [{ name: 'OUT', type: 'BOOL' }] },
  REAL_TO_BOOL: { label: 'REAL_TO_BOOL', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'BOOL' }] },
  // --- CONVERSION (TO_BYTE) ---
  BOOL_TO_BYTE: { label: 'BOOL_TO_BYTE', inputs: [{ name: 'IN', type: 'BOOL' }], outputs: [{ name: 'OUT', type: 'BYTE' }] },
  WORD_TO_BYTE: { label: 'WORD_TO_BYTE', inputs: [{ name: 'IN', type: 'WORD' }], outputs: [{ name: 'OUT', type: 'BYTE' }] },
  DWORD_TO_BYTE: { label: 'DWORD_TO_BYTE', inputs: [{ name: 'IN', type: 'DWORD' }], outputs: [{ name: 'OUT', type: 'BYTE' }] },
  INT_TO_BYTE: { label: 'INT_TO_BYTE', inputs: [{ name: 'IN', type: 'INT' }], outputs: [{ name: 'OUT', type: 'BYTE' }] },
  UINT_TO_BYTE: { label: 'UINT_TO_BYTE', inputs: [{ name: 'IN', type: 'UINT' }], outputs: [{ name: 'OUT', type: 'BYTE' }] },
  DINT_TO_BYTE: { label: 'DINT_TO_BYTE', inputs: [{ name: 'IN', type: 'DINT' }], outputs: [{ name: 'OUT', type: 'BYTE' }] },
  UDINT_TO_BYTE: { label: 'UDINT_TO_BYTE', inputs: [{ name: 'IN', type: 'UDINT' }], outputs: [{ name: 'OUT', type: 'BYTE' }] },
  REAL_TO_BYTE: { label: 'REAL_TO_BYTE', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'BYTE' }] },
  // --- CONVERSION (TO_WORD) ---
  BOOL_TO_WORD: { label: 'BOOL_TO_WORD', inputs: [{ name: 'IN', type: 'BOOL' }], outputs: [{ name: 'OUT', type: 'WORD' }] },
  BYTE_TO_WORD: { label: 'BYTE_TO_WORD', inputs: [{ name: 'IN', type: 'BYTE' }], outputs: [{ name: 'OUT', type: 'WORD' }] },
  DWORD_TO_WORD: { label: 'DWORD_TO_WORD', inputs: [{ name: 'IN', type: 'DWORD' }], outputs: [{ name: 'OUT', type: 'WORD' }] },
  INT_TO_WORD: { label: 'INT_TO_WORD', inputs: [{ name: 'IN', type: 'INT' }], outputs: [{ name: 'OUT', type: 'WORD' }] },
  UINT_TO_WORD: { label: 'UINT_TO_WORD', inputs: [{ name: 'IN', type: 'UINT' }], outputs: [{ name: 'OUT', type: 'WORD' }] },
  DINT_TO_WORD: { label: 'DINT_TO_WORD', inputs: [{ name: 'IN', type: 'DINT' }], outputs: [{ name: 'OUT', type: 'WORD' }] },
  UDINT_TO_WORD: { label: 'UDINT_TO_WORD', inputs: [{ name: 'IN', type: 'UDINT' }], outputs: [{ name: 'OUT', type: 'WORD' }] },
  REAL_TO_WORD: { label: 'REAL_TO_WORD', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'WORD' }] },
  // --- CONVERSION (TO_DWORD) ---
  BOOL_TO_DWORD: { label: 'BOOL_TO_DWORD', inputs: [{ name: 'IN', type: 'BOOL' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  BYTE_TO_DWORD: { label: 'BYTE_TO_DWORD', inputs: [{ name: 'IN', type: 'BYTE' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  WORD_TO_DWORD: { label: 'WORD_TO_DWORD', inputs: [{ name: 'IN', type: 'WORD' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  INT_TO_DWORD: { label: 'INT_TO_DWORD', inputs: [{ name: 'IN', type: 'INT' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  UINT_TO_DWORD: { label: 'UINT_TO_DWORD', inputs: [{ name: 'IN', type: 'UINT' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  DINT_TO_DWORD: { label: 'DINT_TO_DWORD', inputs: [{ name: 'IN', type: 'DINT' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  UDINT_TO_DWORD: { label: 'UDINT_TO_DWORD', inputs: [{ name: 'IN', type: 'UDINT' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  REAL_TO_DWORD: { label: 'REAL_TO_DWORD', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'DWORD' }] },
  // --- CONVERSION (TO_INT) ---
  BOOL_TO_INT: { label: 'BOOL_TO_INT', inputs: [{ name: 'IN', type: 'BOOL' }], outputs: [{ name: 'OUT', type: 'INT' }] },
  BYTE_TO_INT: { label: 'BYTE_TO_INT', inputs: [{ name: 'IN', type: 'BYTE' }], outputs: [{ name: 'OUT', type: 'INT' }] },
  WORD_TO_INT: { label: 'WORD_TO_INT', inputs: [{ name: 'IN', type: 'WORD' }], outputs: [{ name: 'OUT', type: 'INT' }] },
  DWORD_TO_INT: { label: 'DWORD_TO_INT', inputs: [{ name: 'IN', type: 'DWORD' }], outputs: [{ name: 'OUT', type: 'INT' }] },
  UINT_TO_INT: { label: 'UINT_TO_INT', inputs: [{ name: 'IN', type: 'UINT' }], outputs: [{ name: 'OUT', type: 'INT' }] },
  DINT_TO_INT: { label: 'DINT_TO_INT', inputs: [{ name: 'IN', type: 'DINT' }], outputs: [{ name: 'OUT', type: 'INT' }] },
  UDINT_TO_INT: { label: 'UDINT_TO_INT', inputs: [{ name: 'IN', type: 'UDINT' }], outputs: [{ name: 'OUT', type: 'INT' }] },
  REAL_TO_INT: { label: 'REAL_TO_INT', descriptionKey: 'blockInfo.REAL_TO_INT', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'INT' }] },
  // --- CONVERSION (TO_UINT) ---
  BOOL_TO_UINT: { label: 'BOOL_TO_UINT', inputs: [{ name: 'IN', type: 'BOOL' }], outputs: [{ name: 'OUT', type: 'UINT' }] },
  BYTE_TO_UINT: { label: 'BYTE_TO_UINT', inputs: [{ name: 'IN', type: 'BYTE' }], outputs: [{ name: 'OUT', type: 'UINT' }] },
  WORD_TO_UINT: { label: 'WORD_TO_UINT', inputs: [{ name: 'IN', type: 'WORD' }], outputs: [{ name: 'OUT', type: 'UINT' }] },
  DWORD_TO_UINT: { label: 'DWORD_TO_UINT', inputs: [{ name: 'IN', type: 'DWORD' }], outputs: [{ name: 'OUT', type: 'UINT' }] },
  INT_TO_UINT: { label: 'INT_TO_UINT', inputs: [{ name: 'IN', type: 'INT' }], outputs: [{ name: 'OUT', type: 'UINT' }] },
  DINT_TO_UINT: { label: 'DINT_TO_UINT', inputs: [{ name: 'IN', type: 'DINT' }], outputs: [{ name: 'OUT', type: 'UINT' }] },
  UDINT_TO_UINT: { label: 'UDINT_TO_UINT', inputs: [{ name: 'IN', type: 'UDINT' }], outputs: [{ name: 'OUT', type: 'UINT' }] },
  REAL_TO_UINT: { label: 'REAL_TO_UINT', descriptionKey: 'blockInfo.REAL_TO_INT', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'UINT' }] },
  // --- CONVERSION (TO_DINT) ---
  BOOL_TO_DINT: { label: 'BOOL_TO_DINT', inputs: [{ name: 'IN', type: 'BOOL' }], outputs: [{ name: 'OUT', type: 'DINT' }] },
  BYTE_TO_DINT: { label: 'BYTE_TO_DINT', inputs: [{ name: 'IN', type: 'BYTE' }], outputs: [{ name: 'OUT', type: 'DINT' }] },
  WORD_TO_DINT: { label: 'WORD_TO_DINT', inputs: [{ name: 'IN', type: 'WORD' }], outputs: [{ name: 'OUT', type: 'DINT' }] },
  DWORD_TO_DINT: { label: 'DWORD_TO_DINT', inputs: [{ name: 'IN', type: 'DWORD' }], outputs: [{ name: 'OUT', type: 'DINT' }] },
  INT_TO_DINT: { label: 'INT_TO_DINT', inputs: [{ name: 'IN', type: 'INT' }], outputs: [{ name: 'OUT', type: 'DINT' }] },
  UINT_TO_DINT: { label: 'UINT_TO_DINT', inputs: [{ name: 'IN', type: 'UINT' }], outputs: [{ name: 'OUT', type: 'DINT' }] },
  UDINT_TO_DINT: { label: 'UDINT_TO_DINT', inputs: [{ name: 'IN', type: 'UDINT' }], outputs: [{ name: 'OUT', type: 'DINT' }] },
  REAL_TO_DINT: { label: 'REAL_TO_DINT', descriptionKey: 'blockInfo.REAL_TO_INT', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'DINT' }] },
  // --- CONVERSION (TO_UDINT) ---
  BOOL_TO_UDINT: { label: 'BOOL_TO_UDINT', inputs: [{ name: 'IN', type: 'BOOL' }], outputs: [{ name: 'OUT', type: 'UDINT' }] },
  BYTE_TO_UDINT: { label: 'BYTE_TO_UDINT', inputs: [{ name: 'IN', type: 'BYTE' }], outputs: [{ name: 'OUT', type: 'UDINT' }] },
  WORD_TO_UDINT: { label: 'WORD_TO_UDINT', inputs: [{ name: 'IN', type: 'WORD' }], outputs: [{ name: 'OUT', type: 'UDINT' }] },
  DWORD_TO_UDINT: { label: 'DWORD_TO_UDINT', inputs: [{ name: 'IN', type: 'DWORD' }], outputs: [{ name: 'OUT', type: 'UDINT' }] },
  INT_TO_UDINT: { label: 'INT_TO_UDINT', inputs: [{ name: 'IN', type: 'INT' }], outputs: [{ name: 'OUT', type: 'UDINT' }] },
  UINT_TO_UDINT: { label: 'UINT_TO_UDINT', inputs: [{ name: 'IN', type: 'UINT' }], outputs: [{ name: 'OUT', type: 'UDINT' }] },
  DINT_TO_UDINT: { label: 'DINT_TO_UDINT', inputs: [{ name: 'IN', type: 'DINT' }], outputs: [{ name: 'OUT', type: 'UDINT' }] },
  REAL_TO_UDINT: { label: 'REAL_TO_UDINT', descriptionKey: 'blockInfo.REAL_TO_INT', inputs: [{ name: 'IN', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'UDINT' }] },
  // --- CONVERSION (TO_REAL) ---
  BOOL_TO_REAL: { label: 'BOOL_TO_REAL', inputs: [{ name: 'IN', type: 'BOOL' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  BYTE_TO_REAL: { label: 'BYTE_TO_REAL', inputs: [{ name: 'IN', type: 'BYTE' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  WORD_TO_REAL: { label: 'WORD_TO_REAL', inputs: [{ name: 'IN', type: 'WORD' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  DWORD_TO_REAL: { label: 'DWORD_TO_REAL', inputs: [{ name: 'IN', type: 'DWORD' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  INT_TO_REAL: { label: 'INT_TO_REAL', inputs: [{ name: 'IN', type: 'INT' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  UINT_TO_REAL: { label: 'UINT_TO_REAL', inputs: [{ name: 'IN', type: 'UINT' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  DINT_TO_REAL: { label: 'DINT_TO_REAL', inputs: [{ name: 'IN', type: 'DINT' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  UDINT_TO_REAL: { label: 'UDINT_TO_REAL', inputs: [{ name: 'IN', type: 'UDINT' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  NORM_X: { label: 'NORM_X', descriptionKey: 'blockInfo.NORM_X', inputs: [{ name: 'MIN', type: 'REAL' }, { name: 'MAX', type: 'REAL' }, { name: 'VALUE', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
  SCALE_X: { label: 'SCALE_X', descriptionKey: 'blockInfo.SCALE_X', inputs: [{ name: 'MIN', type: 'REAL' }, { name: 'MAX', type: 'REAL' }, { name: 'VALUE', type: 'REAL' }], outputs: [{ name: 'OUT', type: 'REAL' }] },
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
  const [forceModal, setForceModal] = useState(null);

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
    const allVars = [...variables, ...globalVars];
    const varDef = allVars.find(v => v.name === instanceName);
    const varType = varDef?.type || 'BOOL';
    const isTypeMismatch = !!(varDef && varDef.type !== 'BOOL');

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
        pointerEvents: 'auto', // Explicitly allow clicks here
        background: selected ? 'rgba(0, 122, 204, 0.2)' : 'rgba(255, 255, 255, 0.05)',
        border: selected ? '2px solid #a78bfa' : (
          isTypeMismatch ? '2px solid #ff9800' // ORANGE: variable exists but not BOOL
          : ((data.type === 'Contact' || data.type === 'Coil') && instanceName !== '' &&
              !allVars.some(v => v.name === instanceName.replace(/[🌍🏠⊞⊡⊟]/g, '').trim().split(/[\[.]/)[0]))
            ? '2px solid #f44336' // RED: variable not found
            : '1px solid transparent'
        ),
        borderRadius: 4
      }}>
        {/* Live Variable Overlay for Online Mode */}
        {isLiveActive && (
          <div
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); if (canForce) setForceModal({ liveKey: lookupKey, varName: instanceName, varType, currentValue: liveVariables?.[lookupKey] }); }}
            title={canForce ? 'Click to force-write value' : ''}
            style={{
              position: 'absolute',
              top: -42,
              left: '50%',
              transform: 'translateX(-50%)',
              background: liveVariables[lookupKey] ? '#00e676' : '#252526',
              color: liveVariables[lookupKey] ? '#000' : '#888',
              border: `1px solid ${liveVariables[lookupKey] ? '#00e676' : '#888'}`,
              padding: '1px 4px',
              borderRadius: 4,
              fontSize: 8,
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
          top: -24,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 4,
          alignItems: 'center',
          zIndex: 10
        }}>
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
              // Block assignment if variable exists but is not BOOL type
              const typedVarDef = allVars.find(v => v.name === val.split(/[\[.]/)[0]);
              if (typedVarDef && typedVarDef.type !== 'BOOL') return;
              handleUpdate({ instanceName: val });
            }}
            list={data.readOnly ? undefined : "ladder-vars-BOOL"}
            placeholder="??"
            style={{
              width: 65,
              height: 16,
              fontSize: 9,
              border: selected ? '1px solid #a78bfa' : '1px solid #333',
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
              height: 16,
              padding: '0 6px',
              background: '#a78bfa',
              color: 'white',
              fontSize: 8,
              fontWeight: 'bold',
              borderRadius: 2,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: 14,
              userSelect: 'none'
            }}
            title={`Current Type: ${subType}. Click to change.`}
          >
            {subType === 'Normal' ? 'N' : subType.substring(0, 3)}
          </div>
        </div>

        {/* SVG Symbol */}
        <svg width="27" height="27" viewBox="0 0 40 40" style={{
          color: selected ? '#a78bfa'
            : (data.type === 'Contact' && isLiveActive && lookupKey && liveVariables?.[lookupKey]) ? '#ff1744'
            : '#fff',
          overflow: 'visible', pointerEvents: 'none'
        }}>
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
            onClose={() => setForceModal(null)}
            varName={forceModal.varName}
            varType={forceModal.varType}
            currentValue={forceModal.currentValue}
            liveKey={forceModal.liveKey}
            onConfirm={(key, val) => { data.onForceWrite && data.onForceWrite(key, val); }}
          />
        )}
      </div>
    );
  }

  // DYNAMIC CONFIGURATION FOR USER DEFINED BLOCKS
  let cfg;
  let isBoardBlock = false;
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
  } else if (data.customData && data.customData.inputs) {
    // Board/HAL blocks: customData carries inputs/outputs arrays directly.
    // EN is the power-flow trigger (left handle) and ENO is the power-flow output (right handle),
    // so both are excluded from the data pin list shown inside the block body.
    isBoardBlock = true;
    cfg = {
      label: data.type,
      inputs: data.customData.inputs
        .filter(i => i.name !== 'EN')
        .map(i => ({ name: i.name, type: i.type })),
      outputs: data.customData.outputs
        ? data.customData.outputs
            .filter(o => o.name !== 'ENO')
            .map(o => ({ name: o.name, type: o.type }))
        : []
    };
  } else {
    // Default config for standard blocks
    cfg = blockConfig[data.type] || {
      label: data.type,
      inputs: [{ name: 'IN', type: 'ANY' }, { name: 'IN2', type: 'ANY' }],
      outputs: [{ name: 'OUT', type: 'ANY' }, { name: 'OUT2', type: 'ANY' }]
    };
  }

  // Polymorphic type inference for ANY_NUM blocks:
  // output type follows input type — REAL if any input is REAL or has a decimal, else infer from variable type
  const POLY_NUM_BLOCKS = new Set([
    'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'MOVE',
    'ABS', 'SQRT', 'EXPT', 'MAX', 'MIN', 'LIMIT',
    'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN',
    'GT', 'GE', 'EQ', 'NE', 'LE', 'LT',
    'SEL', 'MUX'
  ]);
  if (!data.customData && POLY_NUM_BLOCKS.has(data.type)) {
    const allVars = [...variables, ...globalVars];
    const numPinNames = cfg.inputs.filter(p => p.type === 'ANY_NUM').map(p => p.name);
    let inferredType = 'ANY_NUM';
    for (const pinName of numPinNames) {
      const raw = (localPinValues[pinName] ?? data.values?.[pinName] ?? '');
      const val = String(raw).replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
      if (!val) continue;
      // Decimal literal → REAL
      if (/^-?\d*\.\d+$|^-?\d+\.\d*$/.test(val)) { inferredType = 'REAL'; break; }
      // Integer literal → DINT (default integer)
      if (/^-?\d+$/.test(val)) {
        if (inferredType === 'ANY_NUM') inferredType = 'DINT';
        continue;
      }
      // Variable reference → use its declared type
      const baseName = val.split(/[\[.]/)[0];
      const varDef = allVars.find(v => v.name === baseName);
      if (varDef) {
        if (varDef.type === 'REAL' || varDef.type === 'LREAL') { inferredType = 'REAL'; break; }
        if (inferredType === 'ANY_NUM') inferredType = varDef.type;
      }
    }
    cfg = {
      ...cfg,
      inputs: cfg.inputs.map(p => p.type === 'ANY_NUM' ? { ...p, type: inferredType } : p),
      outputs: cfg.outputs.map(p => p.type === 'ANY_NUM' ? { ...p, type: inferredType } : p),
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
      border: selected ? '2px solid #a78bfa' : '1px solid #666',
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
      <div style={{ background: isBoardBlock ? '#00695c' : '#0d47a1', padding: '4px 8px', textAlign: 'center', fontWeight: 'bold' }}
        title={isBoardBlock && data.customData?.desc ? data.customData.desc : undefined}>
        {cfg.label}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 4px' }}>
        {/* Helper values for live check */}
        <div style={{ display: 'none' }}>
        </div>
        {/* INPUTS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {effectiveInputs.map((pin) => {
            const handleId = `in_${pin.name}`;
            const connected = isHandleConnected(handleId, 'target');
            const isTime = pin.type === 'TIME';
            const val = data.values?.[pin.name] || '';

            const safeProgName = (data.parentName || "").trim().replace(/\s+/g, '_');
            const safeInstName = (data.instanceName || '').trim().replace(/\s+/g, '_');
            const shadowKey = `prog_${safeProgName}_in_${safeInstName}_${pin.name}`;
            const hasShadow = !!(liveVariables && liveVariables[shadowKey] !== undefined);
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
                  <div style={{
                    position: 'absolute',
                    right: '100%',
                    marginRight: 15,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    transform: (liveVariables && val && valVarDef) ? 'translateY(8px)' : 'none',
                    transition: 'transform 0.2s ease'
                  }}>
                    {/* Live value badge (simulation mode) - Positioned above the input if a variable is assigned, or in place of it if not */}
                    {(liveVariables && (!val || valVarDef || hasShadow)) && (() => {
                      const varLiveVal = liveVariables[`prog_${safeProgName}_${baseValName}`] !== undefined
                        ? liveVariables[`prog_${safeProgName}_${baseValName}`]
                        : liveVariables[`prog__${baseValName}`] !== undefined
                          ? liveVariables[`prog__${baseValName}`]
                          : liveVariables[shadowKey];
                      const hasLive = varLiveVal !== undefined;
                      const liveStr = hasLive
                        ? (typeof varLiveVal === 'boolean' ? (varLiveVal ? '1' : '0') : (pin.type === 'TIME' ? formatTimeUs(varLiveVal) : String(varLiveVal)))
                        : '---';
                      return (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!data.readOnly || !data.onForceWrite) return;
                            const cleanedVal = (val || '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
                            const isVarRefBadge = cleanedVal && /^[A-Za-z_]/.test(cleanedVal);
                            let forceKey = shadowKey;
                            let forceCurrent = liveVariables?.[shadowKey];
                            let forceName = `${data.instanceName || data.type}.${pin.name}`;
                            if (isVarRefBadge) {
                              const safeVar = cleanedVal.replace(/\s+/g, '_');
                              const pk = `prog_${safeProgName}_${safeVar}`;
                              forceKey = liveVariables?.[pk] !== undefined ? pk : `prog__${safeVar}`;
                              forceCurrent = liveVariables?.[forceKey];
                              forceName = cleanedVal;
                            }
                            const modalVarType = pin.type === 'TIME' ? 'INT' : (pin.type === 'ANY' ? 'INT' : pin.type);
                            setForceModal({ liveKey: forceKey, varName: forceName, varType: modalVarType, currentValue: forceCurrent });
                          }}
                          style={{
                          position: 'absolute',
                          top: val ? -15 : 0,
                          right: 0,
                          minWidth: 36,
                          fontSize: 9,
                          background: hasLive ? 'rgba(0,230,118,0.12)' : 'transparent',
                          border: `1px solid ${hasLive ? 'rgba(0,230,118,0.4)' : '#444'}`,
                          color: hasLive ? '#00e676' : '#555',
                          padding: '0px 3px',
                          borderRadius: 2,
                          fontFamily: 'Consolas, monospace',
                          textAlign: 'center',
                          cursor: data.readOnly && data.onForceWrite ? 'pointer' : 'default',
                          zIndex: 10,
                          whiteSpace: 'nowrap'
                        }}>
                          {liveStr}
                        </span>
                      );
                    })()}

                    <input
                      type="text"
                      className="nodrag"
                      value={localPinValues[pin.name] !== undefined ? localPinValues[pin.name] : (val || '')}
                      list={data.readOnly ? undefined : (pin.type === 'ANY' ? "ladder-vars-ANY" : `ladder-vars-${pin.type}`)}
                      readOnly={!!data.readOnly}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!data.readOnly || !data.onForceWrite) return;
                        const cleanedVal = (val || '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
                        const isVarRef = cleanedVal && /^[A-Za-z_]/.test(cleanedVal);
                        let forceKey = shadowKey;
                        let forceCurrent = liveVariables?.[shadowKey];
                        let forceName = `${data.instanceName || data.type}.${pin.name}`;
                        if (isVarRef) {
                          const safeVar = cleanedVal.replace(/\s+/g, '_');
                          const pk = `prog_${safeProgName}_${safeVar}`;
                          forceKey = liveVariables?.[pk] !== undefined ? pk : `prog__${safeVar}`;
                          forceCurrent = liveVariables?.[forceKey];
                          forceName = cleanedVal;
                        }
                        const modalVarType = pin.type === 'TIME' ? 'INT' : (pin.type === 'ANY' ? 'INT' : pin.type);
                        setForceModal({ liveKey: forceKey, varName: forceName, varType: modalVarType, currentValue: forceCurrent });
                      }}
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
                        minWidth: 40,
                        width: `${Math.max(40, (localPinValues[pin.name] !== undefined ? localPinValues[pin.name].length : (val || '').length) * 6 + 8)}px`,
                        maxWidth: 160,
                        fontSize: 9,
                        background: '#1e1e1e',
                        border: isValid ? '1px solid #444' : '1px solid #f44336',
                        color: isValid ? '#ddd' : '#f44336',
                        padding: '1px 3px',
                        borderRadius: 2,
                        outline: 'none',
                        textAlign: 'right',
                        opacity: (liveVariables && (!val || hasShadow)) ? 0 : 1
                      }}
                      placeholder={isTime ? 'T#...' : '...'}
                    />
                  </div>
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
          {effectiveOutputs.map((pin) => {
            const handleId = `out_${pin.name}`;
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

                {/* Edit-mode variable assignment field (Always show when not connected) */}
                {!connected && (
                  <div style={{
                    position: 'absolute',
                    left: '100%',
                    marginLeft: 15,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    transform: (lv && val && outVarDef) ? 'translateY(8px)' : 'none',
                    transition: 'transform 0.2s ease'
                  }}>
                    {/* Live value badge (simulation mode) - Positioned above the input if a variable is assigned, or in place of it if not */}
                    {(lv && (!val || outVarDef)) && (
                      <span style={{
                        position: 'absolute',
                        top: val ? -15 : 0, // Move above if there is text, otherwise overlay
                        left: 0,
                        minWidth: 36,
                        fontSize: 9,
                        background: hasLive ? 'rgba(0,230,118,0.12)' : 'transparent',
                        border: `1px solid ${hasLive ? 'rgba(0,230,118,0.4)' : '#444'}`,
                        color: hasLive ? '#00e676' : '#555',
                        padding: '0px 3px',
                        borderRadius: 2,
                        fontFamily: 'Consolas, monospace',
                        textAlign: 'center',
                        pointerEvents: 'none',
                        zIndex: 10,
                        whiteSpace: 'nowrap'
                      }}>
                        {hasLive ? liveDisplay : '---'}
                      </span>
                    )}

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
                        minWidth: 40,
                        width: `${Math.max(40, (localPinValues[pin.name] !== undefined ? String(localPinValues[pin.name]).length : String(val).length) * 6 + 8)}px`,
                        maxWidth: 160,
                        fontSize: 9,
                        background: '#1e1e1e',
                        border: outIsArrayWithoutIndex ? '1px solid #f44336' : '1px solid #444',
                        color: outIsArrayWithoutIndex ? '#f44336' : '#ddd',
                        padding: '1px 3px',
                        borderRadius: 2,
                        outline: 'none',
                        textAlign: 'left',
                        opacity: (lv && !val) ? 0 : 1 // Hide input visually if in sim mode and it's empty, so the '---' badge shows perfectly
                      }}
                      placeholder="..."
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {forceModal && (
        <ForceWriteModal
          isOpen={true}
          onClose={() => setForceModal(null)}
          varName={forceModal.varName}
          varType={forceModal.varType}
          currentValue={forceModal.currentValue}
          liveKey={forceModal.liveKey}
          onConfirm={(key, val) => { data.onForceWrite && data.onForceWrite(key, val); }}
        />
      )}
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
  onSelectBlock,
  globalSelectedBlockId,
  availableBlocks = [],
  variables = [],
  globalVars = [],
  dataTypes = [],
  liveVariables = null,
  parentName = "",
  readOnly = false,
  onForceWrite,
  isFocused = false,
  onFocusRung,
  onInsertAbove,
  onInsertBelow = null
}) => {
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = React.useState(800);

  // ── Rubber band selection state ──
  const [rubberBand, setRubberBand] = useState(null); // { startX, startY, currentX, currentY }
  const [rubberBandListening, setRubberBandListening] = useState(false); // triggers effect to attach listeners
  const rubberBandRef = useRef(null);
  const isRubberBandingRef = useRef(false);

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
  const MIN_RUNG_HEIGHT = 150;

  // Helper to calculate block height (no cap — rung expands to fit)
  const getBlockHeight = useCallback((type) => {
    if (type === 'Contact' || type === 'Coil') return 18;
    const config = blockConfig[type];
    if (!config) return 100;
    const rows = Math.max(config.inputs.length, config.outputs.length);
    return 46 + (rows * 30);
  }, []);

  // Dynamic rung height: expand to fit the tallest block (+ 20px padding)
  const RUNG_HEIGHT = React.useMemo(() => {
    const maxBlock = rung.blocks.reduce((max, b) => {
      return Math.max(max, getBlockHeight(b.data?.type || b.type));
    }, 0);
    return Math.max(MIN_RUNG_HEIGHT, maxBlock + 20);
  }, [rung.blocks, getBlockHeight]);

  const MIDDLE_Y = RUNG_HEIGHT / 2;

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
  }, [getBlockHeight, variables, globalVars, dataTypes, liveVariables, parentName, readOnly, RUNG_HEIGHT]);

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



  const [selectedEdgeId, setSelectedEdgeId] = useState(null);

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

  const handleEdgeClick = useCallback((event, edge) => {
    if (readOnly) return;
    event.stopPropagation();
    setSelectedEdgeId(prev => {
      const newId = prev === edge.id ? null : edge.id;
      return newId;
    });
    // Deselect all nodes when an edge is clicked
    setNodes(nds => nds.map(n => ({ ...n, selected: false })));
    if (onSelectBlock) onSelectBlock(null, null);
  }, [readOnly, setNodes, onSelectBlock]);

  const handleNodeClick = useCallback((event, node) => {
    // Don't toggle terminal nodes
    if (node.id.startsWith('terminal_')) return;

    // Clear edge selection when a node is clicked
    setSelectedEdgeId(null);

    const targetNode = nodes.find(n => n.id === node.id);
    const wasSelected = targetNode ? targetNode.selected : false;

    if (readOnly) {
      // Simulation mode: allow selection for spacebar BOOL toggle, skip edit callbacks
      // Only one node selected at a time — propagate through global ID so other rungs also deselect
      const newSelected = !wasSelected;
      setNodes((nds) => nds.map((n) => (n.id === node.id ? { ...n, selected: newSelected } : { ...n, selected: false })));
      if (onSelectBlock) {
        if (newSelected) onSelectBlock(rung.id, node);
        else onSelectBlock(null, null);
      }
      return;
    }

    if (wasSelected) {
      // Toggle off if already selected
      setNodes((nds) => nds.map((n) => (n.id === node.id ? { ...n, selected: false } : n)));
      if (onSelectBlock) onSelectBlock(null);
    } else {
      // Select this node, deselect all others in this rung
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === node.id })));
      if (onSelectBlock) onSelectBlock(rung.id, node);
    }
  }, [readOnly, onSelectBlock, rung.id, setNodes, nodes]);

  // Simülasyon başlayınca çoklu seçimi temizle
  React.useEffect(() => {
    if (readOnly) {
      setNodes((nds) => {
        const selectedCount = nds.filter(n => n.selected).length;
        if (selectedCount > 1) return nds.map(n => ({ ...n, selected: false }));
        return nds;
      });
    }
  }, [readOnly, setNodes]);

  // Sync global selection state
  React.useEffect(() => {
    if (globalSelectedBlockId !== undefined) {
      setNodes((nds) => nds.map((n) => {
        // preserve terminal node selection (always false)
        if (n.id.startsWith('terminal_')) return n;
        return { ...n, selected: n.id === globalSelectedBlockId };
      }));
    }
  }, [globalSelectedBlockId, setNodes]);

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
        selected: conn.id === selectedEdgeId,
        style: conn.id === selectedEdgeId
          ? { stroke: '#a78bfa', strokeWidth: 3 }
          : { stroke: '#fff', strokeWidth: 2 },
        animated: false,
      }))
    );
  }, [rung.connections, setEdges, selectedEdgeId]);

  // ── Live power-flow edge colouring (simulation mode) ──
  React.useEffect(() => {
    if (!liveVariables) {
      // Simulation stopped → reset edges to default white (keep selection highlight)
      setEdges(eds => eds.map(e => ({
        ...e,
        style: e.id === selectedEdgeId
          ? { stroke: '#a78bfa', strokeWidth: 3 }
          : { stroke: '#fff', strokeWidth: 2 },
        animated: false,
      })));
      return;
    }

    const safeProgName = (parentName || '').trim().replace(/\s+/g, '_');

    const lookupVar = (name) => {
      if (!name) return false;
      const safeName = (name + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
      if (!safeName) return false;
      const progKey = `prog_${safeProgName}_${safeName}`;
      const globalKey = `prog__${safeName}`;
      if (liveVariables[progKey] !== undefined) return !!liveVariables[progKey];
      if (liveVariables[globalKey] !== undefined) return !!liveVariables[globalKey];
      return false;
    };

    const blockMap = {};
    (rung.blocks || []).forEach(b => { blockMap[b.id] = b; });

    setEdges(currentEdges => {
      // Build incoming edges per block
      const incomingByBlock = {};
      currentEdges.forEach(e => {
        if (!incomingByBlock[e.target]) incomingByBlock[e.target] = [];
        incomingByBlock[e.target].push(e);
      });

      // Topological order: left rail first, then blocks sorted by X, right rail last
      const blockIds = ['terminal_left_middle'];
      const sortedBlocks = (rung.blocks || []).slice().sort(
        (a, b) => (a.position?.x || 0) - (b.position?.x || 0)
      );
      sortedBlocks.forEach(b => blockIds.push(b.id));
      blockIds.push('terminal_right_middle');

      // Compute output power for each block.
      // For simple blocks (Contact, Coil, terminal): blockOutPower[id] = boolean
      // For FB blocks: blockOutPower[id] = { _default: bool, out_Q: bool, ... }
      const blockOutPower = { terminal_left_middle: true };

      // Helper to read per-pin power from a source block
      const getSourcePower = (edge) => {
        const p = blockOutPower[edge.source];
        if (p === undefined) return false;
        if (typeof p !== 'object' || p === null) return !!p;
        if (edge.sourceHandle && p[edge.sourceHandle] !== undefined) return p[edge.sourceHandle];
        return p._default || false;
      };

      blockIds.forEach(bid => {
        if (bid === 'terminal_left_middle') return;

        // Input power = OR of all incoming edge source powers (per-pin aware)
        const incoming = incomingByBlock[bid] || [];
        let inPower = false;
        incoming.forEach(e => { if (getSourcePower(e)) inPower = true; });

        const block = blockMap[bid];

        if (!block) {
          // Terminal node (right rail) or unknown
          blockOutPower[bid] = inPower;
          return;
        }

        const type = (block.data?.type || block.data?.label || '').trim();
        const subType = block.data?.subType || 'NO';
        const vals = block.data?.values || {};

        if (type === 'Contact') {
          const varVal = lookupVar(vals.var || block.data?.instanceName || '');
          blockOutPower[bid] = subType === 'NC' ? (inPower && !varVal) : (inPower && varVal);
        } else if (type === 'Coil') {
          blockOutPower[bid] = false; // Coil is a sink — does not pass power forward
        } else {
          // Function Block — per-output-pin power from live simulation values
          const instName = (block.data?.instanceName || '').trim().replace(/\s+/g, '_');
          const pinPower = { _default: inPower };

          // For each outgoing edge from this block, look up the output pin's live value
          currentEdges.forEach(e => {
            if (e.source !== bid || !e.sourceHandle) return;
            if (pinPower[e.sourceHandle] !== undefined) return; // already computed
            const pinName = e.sourceHandle.replace(/^out_/, '');
            if (!pinName) return;

            let pinVal;
            // 1. Check if a variable is assigned to this output pin
            const assignedVar = (vals[pinName] || '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
            if (assignedVar && /^[A-Za-z_]/.test(assignedVar)) {
              const safeVar = assignedVar.replace(/\s+/g, '_');
              const progKey = `prog_${safeProgName}_${safeVar}`;
              pinVal = liveVariables[progKey] !== undefined ? liveVariables[progKey] : liveVariables[`prog__${safeVar}`];
            }
            // 2. Fallback: shadow variable for unassigned output pins
            if (pinVal === undefined && instName) {
              pinVal = liveVariables[`prog_${safeProgName}_out_${instName}_${pinName}`];
            }

            if (pinVal !== undefined) {
              pinPower[e.sourceHandle] = typeof pinVal === 'boolean' ? pinVal
                : typeof pinVal === 'number' ? pinVal !== 0
                : !!pinVal;
            } else {
              pinPower[e.sourceHandle] = inPower; // no live data → fallback
            }
          });

          blockOutPower[bid] = pinPower;
        }
      });

      // Colour each edge: red = powered, blue = unpowered (purple = selected)
      return currentEdges.map(e => ({
        ...e,
        style: e.id === selectedEdgeId
          ? { stroke: '#a78bfa', strokeWidth: 3 }
          : { stroke: getSourcePower(e) ? '#ff1744' : '#2979ff', strokeWidth: 2 },
      }));
    });
  }, [liveVariables, rung.blocks, parentName, setEdges, selectedEdgeId]);

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
    setSelectedEdgeId(null);
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
      // ANY_NUM accepts any numeric type
      const NUMERIC_TYPES = ['INT', 'UINT', 'SINT', 'USINT', 'DINT', 'UDINT', 'REAL', 'LREAL', 'BYTE', 'WORD', 'DWORD', 'ANY_NUM'];
      const srcIsNum = NUMERIC_TYPES.includes(sourceType);
      const tgtIsNum = NUMERIC_TYPES.includes(targetType);
      if (srcIsNum && tgtIsNum) return true;

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

  // ── Rubber Band Selection (Right-click drag) ──
  // Returns the bounding box of a node using its position and calculated dimensions
  const getNodeBounds = useCallback((node) => {
    const type = node.data?.type || node.data?.label || node.type;
    if (type === 'Contact' || type === 'Coil') {
      return { x: node.position.x, y: node.position.y, width: 27, height: 27 };
    }
    const height = getBlockHeight(type);
    return { x: node.position.x, y: node.position.y, width: 140, height };
  }, [getBlockHeight]);

  // Check if two rectangles intersect (touch)
  const rectsIntersect = useCallback((r1, r2) => {
    return !(r1.x + r1.width < r2.x || r2.x + r2.width < r1.x ||
             r1.y + r1.height < r2.y || r2.y + r2.height < r1.y);
  }, []);

  // Check if r1 fully contains r2
  const rectContains = useCallback((r1, r2) => {
    return r1.x <= r2.x && r1.y <= r2.y &&
           r1.x + r1.width >= r2.x + r2.width &&
           r1.y + r1.height >= r2.y + r2.height;
  }, []);

  // Compute which nodes should be selected based on rubber band rect and direction
  const computeRubberBandSelection = useCallback((band) => {
    if (!band) return [];
    const { startX, startY, currentX, currentY } = band;
    const selRect = {
      x: Math.min(startX, currentX),
      y: Math.min(startY, currentY),
      width: Math.abs(currentX - startX),
      height: Math.abs(currentY - startY)
    };
    const isRightToLeft = currentX < startX;
    const selectedIds = [];

    nodes.forEach(node => {
      if (node.id.startsWith('terminal_')) return;
      const bounds = getNodeBounds(node);
      if (isRightToLeft) {
        // Right-to-left: select all objects the rectangle touches (intersects)
        if (rectsIntersect(selRect, bounds)) {
          selectedIds.push(node.id);
        }
      } else {
        // Left-to-right: select only fully contained objects
        if (rectContains(selRect, bounds)) {
          selectedIds.push(node.id);
        }
      }
    });
    return selectedIds;
  }, [nodes, getNodeBounds, rectsIntersect, rectContains]);

  // Apply rubber band selection to nodes in real-time
  const applyRubberBandSelection = useCallback((band) => {
    const selectedIds = computeRubberBandSelection(band);
    setNodes(nds => nds.map(n => {
      if (n.id.startsWith('terminal_')) return n;
      return { ...n, selected: selectedIds.includes(n.id) };
    }));
  }, [computeRubberBandSelection, setNodes]);

  // Minimum pixel distance before rubber band activates (to distinguish from click)
  const RUBBER_BAND_THRESHOLD = 5;
  const rubberBandPendingRef = useRef(null); // stores initial mousedown point before threshold met

  const handleRubberBandMouseDown = useCallback((e) => {
    // Only left-click (button === 0)
    if (e.button !== 0) return;
    if (readOnly) return;

    // Only activate on empty canvas, not on nodes/edges/handles
    const target = e.target;
    const isPane = target.classList?.contains('react-flow__pane') ||
                   target.classList?.contains('react-flow__renderer') ||
                   target.classList?.contains('react-flow__viewport');
    if (!isPane) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;

    // Store pending start, don't activate rubber band yet (wait for threshold)
    rubberBandPendingRef.current = { startX, startY, clientX: e.clientX, clientY: e.clientY };
    isRubberBandingRef.current = false;
    setRubberBandListening(true);
  }, [readOnly]);

  const handleRubberBandMouseMove = useCallback((e) => {
    // Check if we have a pending start but haven't crossed threshold yet
    if (rubberBandPendingRef.current && !isRubberBandingRef.current) {
      const dx = e.clientX - rubberBandPendingRef.current.clientX;
      const dy = e.clientY - rubberBandPendingRef.current.clientY;
      if (Math.abs(dx) < RUBBER_BAND_THRESHOLD && Math.abs(dy) < RUBBER_BAND_THRESHOLD) return;

      // Threshold crossed - activate rubber band
      const { startX, startY } = rubberBandPendingRef.current;
      const band = { startX, startY, currentX: startX, currentY: startY };
      setRubberBand(band);
      rubberBandRef.current = band;
      isRubberBandingRef.current = true;
      rubberBandPendingRef.current = null;

      // Clear previous selection
      setNodes(nds => nds.map(n => ({ ...n, selected: false })));
      if (onSelectBlock) onSelectBlock(null);
    }

    if (!isRubberBandingRef.current || !rubberBandRef.current) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    const updatedBand = { ...rubberBandRef.current, currentX, currentY };
    rubberBandRef.current = updatedBand;
    setRubberBand(updatedBand);

    // Real-time selection
    applyRubberBandSelection(updatedBand);
  }, [applyRubberBandSelection, setNodes, onSelectBlock]);

  const handleRubberBandMouseUp = useCallback((e) => {
    // If pending but never crossed threshold = just a click on empty space → deselect all
    if (rubberBandPendingRef.current && !isRubberBandingRef.current) {
      rubberBandPendingRef.current = null;
      setRubberBandListening(false);
      setNodes(nds => nds.map(n => ({ ...n, selected: false })));
      if (onSelectBlock) onSelectBlock(null);
      return;
    }

    if (!isRubberBandingRef.current) {
      setRubberBandListening(false);
      return;
    }

    isRubberBandingRef.current = false;
    setRubberBandListening(false);

    // Final selection is already applied in mousemove
    // Notify parent about selected block (first selected or null)
    const selectedIds = computeRubberBandSelection(rubberBandRef.current);
    if (selectedIds.length === 1) {
      const node = nodes.find(n => n.id === selectedIds[0]);
      if (node && onSelectBlock) onSelectBlock(rung.id, node);
    } else if (selectedIds.length === 0) {
      if (onSelectBlock) onSelectBlock(null);
    }

    setRubberBand(null);
    rubberBandRef.current = null;
  }, [computeRubberBandSelection, nodes, onSelectBlock, rung.id, setNodes]);

  // Attach/detach window-level mouse events for rubber band
  useEffect(() => {
    if (rubberBandListening) {
      window.addEventListener('mousemove', handleRubberBandMouseMove);
      window.addEventListener('mouseup', handleRubberBandMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleRubberBandMouseMove);
        window.removeEventListener('mouseup', handleRubberBandMouseUp);
      };
    }
  }, [rubberBandListening, handleRubberBandMouseMove, handleRubberBandMouseUp]);

  // Compute rubber band visual rect
  const rubberBandStyle = React.useMemo(() => {
    if (!rubberBand) return null;
    const { startX, startY, currentX, currentY } = rubberBand;
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    const isRightToLeft = currentX < startX;
    return { left, top, width, height, isRightToLeft };
  }, [rubberBand]);

  return (
    <div style={{
      background: '#2a2a2a',
      border: '2px solid #444',
      borderRadius: 8,
      overflow: 'hidden',
      boxShadow: '0 4px 6px rgba(0,0,0,0.3)'
    }}>
      {/* RUNG HEADER */}
      <div
        onClick={(e) => { e.stopPropagation(); if (onFocusRung) onFocusRung(); }}
        style={{
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
        onMouseDown={handleRubberBandMouseDown}
        style={{
          width: '100%',
          height: RUNG_HEIGHT,
          background: '#1e1e1e',
          position: 'relative',
          border: '1px dashed #444',
          overflow: 'hidden',
          cursor: 'default'
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

        {/* Rubber Band Selection Rectangle */}
        {rubberBandStyle && (
          <div
            className={`rung-selection-rect ${rubberBandStyle.isRightToLeft ? 'select-intersect' : 'select-contain'}`}
            style={{
              left: rubberBandStyle.left,
              top: rubberBandStyle.top,
              width: rubberBandStyle.width,
              height: rubberBandStyle.height,
            }}
          />
        )}

        <ReactFlow
          style={{ zIndex: 5 }}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          elementsSelectable={false}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          onEdgeClick={handleEdgeClick}
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
          multiSelectionKeyCode={readOnly ? null : ['Meta', 'Ctrl']}
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
