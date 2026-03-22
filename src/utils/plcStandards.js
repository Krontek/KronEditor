// src/utils/plcStandards.js

/**
 * Format a TIME value (stored as microseconds u32) into IEC T# notation.
 * e.g. 1100000 → "T#1s100ms", 1020100 → "T#1s20ms100us"
 */
export const formatTimeUs = (us) => {
    const v = Math.round(Number(us));
    if (isNaN(v) || v < 0) return String(us);
    if (v === 0) return 'T#0s';
    let rem = v;
    const m  = Math.floor(rem / 60_000_000); rem %= 60_000_000;
    const s  = Math.floor(rem /  1_000_000); rem %=  1_000_000;
    const ms = Math.floor(rem /      1_000); rem %=      1_000;
    const uv = rem;
    let result = 'T#';
    if (m)  result += `${m}m`;
    if (s)  result += `${s}s`;
    if (ms) result += `${ms}ms`;
    if (uv) result += `${uv}us`;
    return result;
};

export const PLC_BLOCKS = {
  // --- ZAMANLAYICILAR ---
  TON: {
    label: 'TON',
    description: 'On-Delay Timer',
    inputs: [
      { id: 'IN', type: 'BOOL', label: 'IN' }, 
      { id: 'PT', type: 'TIME', label: 'PT' }
    ],
    outputs: [
      { id: 'Q', type: 'BOOL', label: 'Q' },
      { id: 'ET', type: 'TIME', label: 'ET' }
    ]
  },
  TOF: {
    label: 'TOF',
    description: 'Off-Delay Timer',
    inputs: [
      { id: 'IN', type: 'BOOL', label: 'IN' },
      { id: 'PT', type: 'TIME', label: 'PT' }
    ],
    outputs: [
      { id: 'Q', type: 'BOOL', label: 'Q' },
      { id: 'ET', type: 'TIME', label: 'ET' }
    ]
  },
  TP: {
    label: 'TP',
    description: 'Pulse Timer',
    inputs: [
      { id: 'IN', type: 'BOOL', label: 'IN' },
      { id: 'PT', type: 'TIME', label: 'PT' }
    ],
    outputs: [
      { id: 'Q', type: 'BOOL', label: 'Q' },
      { id: 'ET', type: 'TIME', label: 'ET' }
    ]
  },
  TONR: {
    label: 'TONR',
    description: 'Retentive On-Delay Timer',
    inputs: [
      { id: 'IN',    type: 'BOOL', label: 'IN'    },
      { id: 'PT',    type: 'TIME', label: 'PT'    },
      { id: 'RESET', type: 'BOOL', label: 'RESET' }
    ],
    outputs: [
      { id: 'Q',  type: 'BOOL', label: 'Q'  },
      { id: 'ET', type: 'TIME', label: 'ET' }
    ]
  },

  // --- SAYICILAR ---
  CTU: {
    label: 'CTU',
    description: 'Count Up',
    inputs: [
      { id: 'CU', type: 'BOOL', label: 'CU' },
      { id: 'R', type: 'BOOL', label: 'R' },
      { id: 'PV', type: 'INT', label: 'PV' }
    ],
    outputs: [
      { id: 'Q', type: 'BOOL', label: 'Q' },
      { id: 'CV', type: 'INT', label: 'CV' }
    ]
  },
  CTD: {
    label: 'CTD',
    description: 'Count Down',
    inputs: [
      { id: 'CD', type: 'BOOL', label: 'CD' },
      { id: 'LD', type: 'BOOL', label: 'LD' },
      { id: 'PV', type: 'INT', label: 'PV' }
    ],
    outputs: [
      { id: 'Q', type: 'BOOL', label: 'Q' },
      { id: 'CV', type: 'INT', label: 'CV' }
    ]
  },
  CTUD: {
    label: 'CTUD',
    description: 'Count Up/Down',
    inputs: [
      { id: 'CU', type: 'BOOL', label: 'CU' },
      { id: 'CD', type: 'BOOL', label: 'CD' },
      { id: 'R',  type: 'BOOL', label: 'R'  },
      { id: 'LD', type: 'BOOL', label: 'LD' },
      { id: 'PV', type: 'INT',  label: 'PV' }
    ],
    outputs: [
      { id: 'QU', type: 'BOOL', label: 'QU' },
      { id: 'QD', type: 'BOOL', label: 'QD' },
      { id: 'CV', type: 'INT',  label: 'CV' }
    ]
  },

  // --- EDGE DETECTORS ---
  R_TRIG: {
    label: 'R_TRIG',
    description: 'Rising Edge',
    inputs: [{ id: 'CLK', type: 'BOOL', label: 'CLK' }],
    outputs: [{ id: 'Q', type: 'BOOL', label: 'Q' }]
  },
  F_TRIG: {
    label: 'F_TRIG',
    description: 'Falling Edge',
    inputs: [{ id: 'CLK', type: 'BOOL', label: 'CLK' }],
    outputs: [{ id: 'Q', type: 'BOOL', label: 'Q' }]
  },

  // --- BISTABLE LATCHES ---
  SR: {
    label: 'SR',
    description: 'Set Dominant',
    inputs: [
      { id: 'S1', type: 'BOOL', label: 'S1' },
      { id: 'R',  type: 'BOOL', label: 'R'  }
    ],
    outputs: [{ id: 'Q1', type: 'BOOL', label: 'Q1' }]
  },
  RS: {
    label: 'RS',
    description: 'Reset Dominant',
    inputs: [
      { id: 'S',  type: 'BOOL', label: 'S'  },
      { id: 'R1', type: 'BOOL', label: 'R1' }
    ],
    outputs: [{ id: 'Q1', type: 'BOOL', label: 'Q1' }]
  },

  // --- COMPARISON ---
  GT:   { label: 'GT',   description: 'Greater Than',     inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN1', type: 'DINT', label: 'IN1' }, { id: 'IN2', type: 'DINT', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'Q', type: 'BOOL', label: 'Q' }] },
  GE:   { label: 'GE',   description: 'Greater or Equal', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN1', type: 'DINT', label: 'IN1' }, { id: 'IN2', type: 'DINT', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'Q', type: 'BOOL', label: 'Q' }] },
  EQ:   { label: 'EQ',   description: 'Equal',            inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN1', type: 'DINT', label: 'IN1' }, { id: 'IN2', type: 'DINT', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'Q', type: 'BOOL', label: 'Q' }] },
  NE:   { label: 'NE',   description: 'Not Equal',        inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN1', type: 'DINT', label: 'IN1' }, { id: 'IN2', type: 'DINT', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'Q', type: 'BOOL', label: 'Q' }] },
  LE:   { label: 'LE',   description: 'Less or Equal',    inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN1', type: 'DINT', label: 'IN1' }, { id: 'IN2', type: 'DINT', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'Q', type: 'BOOL', label: 'Q' }] },
  LT:   { label: 'LT',   description: 'Less Than',        inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN1', type: 'DINT', label: 'IN1' }, { id: 'IN2', type: 'DINT', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'Q', type: 'BOOL', label: 'Q' }] },

  // --- ARITHMETIC ---
  ADD:  { label: 'ADD',  description: 'Addition',       inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN1', type: 'DINT', label: 'IN1' }, { id: 'IN2', type: 'DINT', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  SUB:  { label: 'SUB',  description: 'Subtraction',    inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN1', type: 'DINT', label: 'IN1' }, { id: 'IN2', type: 'DINT', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  MUL:  { label: 'MUL',  description: 'Multiplication', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN1', type: 'DINT', label: 'IN1' }, { id: 'IN2', type: 'DINT', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  DIV:  { label: 'DIV',  description: 'Division',       inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN1', type: 'DINT', label: 'IN1' }, { id: 'IN2', type: 'DINT', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  MOD:  { label: 'MOD',  description: 'Modulo',         inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN1', type: 'DINT', label: 'IN1' }, { id: 'IN2', type: 'DINT', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  MOVE: { label: 'MOVE', description: 'Move / Assign',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN',  type: 'DINT', label: 'IN'  }],                                              outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },

  // --- MATH ---
  ABS:   { label: 'ABS',   description: 'Absolute Value',          inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN',  type: 'REAL', label: 'IN'  }],                                              outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  SQRT:  { label: 'SQRT',  description: 'Square Root',             inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN',  type: 'REAL', label: 'IN'  }],                                              outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  EXPT:  { label: 'EXPT',  description: 'Exponentiation',          inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN',  type: 'REAL', label: 'IN'  }, { id: 'EXP', type: 'REAL', label: 'EXP' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  MAX:   { label: 'MAX',   description: 'Maximum of two values',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN1', type: 'REAL', label: 'IN1' }, { id: 'IN2', type: 'REAL', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  MIN:   { label: 'MIN',   description: 'Minimum of two values',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN1', type: 'REAL', label: 'IN1' }, { id: 'IN2', type: 'REAL', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  LIMIT: { label: 'LIMIT', description: 'Clamp to [MN, MX]',       inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN',  type: 'REAL', label: 'IN'  }, { id: 'MN',  type: 'REAL', label: 'MN'  }, { id: 'MX', type: 'REAL', label: 'MX' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },

  // --- BITWISE ---
  BAND:  { label: 'BAND', description: 'Bitwise AND',    inputs: [{ id: 'EN', type: 'BOOL',  label: 'EN' }, { id: 'IN1', type: 'DWORD', label: 'IN1' }, { id: 'IN2', type: 'DWORD', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  BOR:   { label: 'BOR',  description: 'Bitwise OR',     inputs: [{ id: 'EN', type: 'BOOL',  label: 'EN' }, { id: 'IN1', type: 'DWORD', label: 'IN1' }, { id: 'IN2', type: 'DWORD', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  BXOR:  { label: 'BXOR', description: 'Bitwise XOR',    inputs: [{ id: 'EN', type: 'BOOL',  label: 'EN' }, { id: 'IN1', type: 'DWORD', label: 'IN1' }, { id: 'IN2', type: 'DWORD', label: 'IN2' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  BNOT:  { label: 'BNOT', description: 'Bitwise NOT',    inputs: [{ id: 'EN', type: 'BOOL',  label: 'EN' }, { id: 'IN',  type: 'DWORD', label: 'IN'  }],                                              outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  SHL:   { label: 'SHL',  description: 'Shift Left',     inputs: [{ id: 'EN', type: 'BOOL',  label: 'EN' }, { id: 'IN',  type: 'DWORD', label: 'IN'  }, { id: 'N', type: 'USINT', label: 'N' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  SHR:   { label: 'SHR',  description: 'Shift Right',    inputs: [{ id: 'EN', type: 'BOOL',  label: 'EN' }, { id: 'IN',  type: 'DWORD', label: 'IN'  }, { id: 'N', type: 'USINT', label: 'N' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  ROL:   { label: 'ROL',  description: 'Rotate Left',    inputs: [{ id: 'EN', type: 'BOOL',  label: 'EN' }, { id: 'IN',  type: 'DWORD', label: 'IN'  }, { id: 'N', type: 'USINT', label: 'N' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  ROR:   { label: 'ROR',  description: 'Rotate Right',   inputs: [{ id: 'EN', type: 'BOOL',  label: 'EN' }, { id: 'IN',  type: 'DWORD', label: 'IN'  }, { id: 'N', type: 'USINT', label: 'N' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },

  // --- TRIGONOMETRIC ---
  SIN:  { label: 'SIN',  description: 'Sine (rad)',       inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  COS:  { label: 'COS',  description: 'Cosine (rad)',     inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  TAN:  { label: 'TAN',  description: 'Tangent (rad)',    inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  ASIN: { label: 'ASIN', description: 'Arc Sine',         inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  ACOS: { label: 'ACOS', description: 'Arc Cosine',       inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  ATAN: { label: 'ATAN', description: 'Arc Tangent',      inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },

  // --- SELECTION ---
  SEL: { label: 'SEL', description: 'Binary Select',      inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'G', type: 'BOOL', label: 'G' }, { id: 'IN0', type: 'DINT', label: 'IN0' }, { id: 'IN1', type: 'DINT', label: 'IN1' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  MUX: { label: 'MUX', description: '2-to-1 Multiplexer', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'K', type: 'USINT', label: 'K' }, { id: 'IN0', type: 'DINT', label: 'IN0' }, { id: 'IN1', type: 'DINT', label: 'IN1' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },

  // --- TYPE CONVERSION (TO_BOOL) ---
  BYTE_TO_BOOL:  { label: 'BYTE_TO_BOOL',  description: 'BYTE → BOOL',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BYTE',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BOOL', label: 'OUT' }] },
  WORD_TO_BOOL:  { label: 'WORD_TO_BOOL',  description: 'WORD → BOOL',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'WORD',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BOOL', label: 'OUT' }] },
  DWORD_TO_BOOL: { label: 'DWORD_TO_BOOL', description: 'DWORD → BOOL', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DWORD', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BOOL', label: 'OUT' }] },
  INT_TO_BOOL:   { label: 'INT_TO_BOOL',   description: 'INT → BOOL',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'INT',   label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BOOL', label: 'OUT' }] },
  UINT_TO_BOOL:  { label: 'UINT_TO_BOOL',  description: 'UINT → BOOL',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BOOL', label: 'OUT' }] },
  DINT_TO_BOOL:  { label: 'DINT_TO_BOOL',  description: 'DINT → BOOL',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BOOL', label: 'OUT' }] },
  UDINT_TO_BOOL: { label: 'UDINT_TO_BOOL', description: 'UDINT → BOOL', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UDINT', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BOOL', label: 'OUT' }] },
  REAL_TO_BOOL:  { label: 'REAL_TO_BOOL',  description: 'REAL → BOOL',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BOOL', label: 'OUT' }] },
  // --- CONVERSION (TO_BYTE) ---
  BOOL_TO_BYTE:  { label: 'BOOL_TO_BYTE',  description: 'BOOL → BYTE',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BOOL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BYTE', label: 'OUT' }] },
  WORD_TO_BYTE:  { label: 'WORD_TO_BYTE',  description: 'WORD → BYTE',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'WORD',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BYTE', label: 'OUT' }] },
  DWORD_TO_BYTE: { label: 'DWORD_TO_BYTE', description: 'DWORD → BYTE', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DWORD', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BYTE', label: 'OUT' }] },
  INT_TO_BYTE:   { label: 'INT_TO_BYTE',   description: 'INT → BYTE',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'INT',   label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BYTE', label: 'OUT' }] },
  UINT_TO_BYTE:  { label: 'UINT_TO_BYTE',  description: 'UINT → BYTE',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BYTE', label: 'OUT' }] },
  DINT_TO_BYTE:  { label: 'DINT_TO_BYTE',  description: 'DINT → BYTE',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BYTE', label: 'OUT' }] },
  UDINT_TO_BYTE: { label: 'UDINT_TO_BYTE', description: 'UDINT → BYTE', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UDINT', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BYTE', label: 'OUT' }] },
  REAL_TO_BYTE:  { label: 'REAL_TO_BYTE',  description: 'REAL → BYTE',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'BYTE', label: 'OUT' }] },
  // --- CONVERSION (TO_WORD) ---
  BOOL_TO_WORD:  { label: 'BOOL_TO_WORD',  description: 'BOOL → WORD',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BOOL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'WORD', label: 'OUT' }] },
  BYTE_TO_WORD:  { label: 'BYTE_TO_WORD',  description: 'BYTE → WORD',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BYTE',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'WORD', label: 'OUT' }] },
  DWORD_TO_WORD: { label: 'DWORD_TO_WORD', description: 'DWORD → WORD', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DWORD', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'WORD', label: 'OUT' }] },
  INT_TO_WORD:   { label: 'INT_TO_WORD',   description: 'INT → WORD',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'INT',   label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'WORD', label: 'OUT' }] },
  UINT_TO_WORD:  { label: 'UINT_TO_WORD',  description: 'UINT → WORD',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'WORD', label: 'OUT' }] },
  DINT_TO_WORD:  { label: 'DINT_TO_WORD',  description: 'DINT → WORD',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'WORD', label: 'OUT' }] },
  UDINT_TO_WORD: { label: 'UDINT_TO_WORD', description: 'UDINT → WORD', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UDINT', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'WORD', label: 'OUT' }] },
  REAL_TO_WORD:  { label: 'REAL_TO_WORD',  description: 'REAL → WORD',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'WORD', label: 'OUT' }] },
  // --- CONVERSION (TO_DWORD) ---
  BOOL_TO_DWORD:  { label: 'BOOL_TO_DWORD',  description: 'BOOL → DWORD',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BOOL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  BYTE_TO_DWORD:  { label: 'BYTE_TO_DWORD',  description: 'BYTE → DWORD',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BYTE',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  WORD_TO_DWORD:  { label: 'WORD_TO_DWORD',  description: 'WORD → DWORD',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'WORD',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  INT_TO_DWORD:   { label: 'INT_TO_DWORD',   description: 'INT → DWORD',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'INT',   label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  UINT_TO_DWORD:  { label: 'UINT_TO_DWORD',  description: 'UINT → DWORD',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  DINT_TO_DWORD:  { label: 'DINT_TO_DWORD',  description: 'DINT → DWORD',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  UDINT_TO_DWORD: { label: 'UDINT_TO_DWORD', description: 'UDINT → DWORD', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UDINT', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  REAL_TO_DWORD:  { label: 'REAL_TO_DWORD',  description: 'REAL → DWORD',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DWORD', label: 'OUT' }] },
  // --- CONVERSION (TO_INT) ---
  BOOL_TO_INT:   { label: 'BOOL_TO_INT',   description: 'BOOL → INT',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BOOL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'INT', label: 'OUT' }] },
  BYTE_TO_INT:   { label: 'BYTE_TO_INT',   description: 'BYTE → INT',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BYTE',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'INT', label: 'OUT' }] },
  WORD_TO_INT:   { label: 'WORD_TO_INT',   description: 'WORD → INT',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'WORD',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'INT', label: 'OUT' }] },
  DWORD_TO_INT:  { label: 'DWORD_TO_INT',  description: 'DWORD → INT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DWORD', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'INT', label: 'OUT' }] },
  UINT_TO_INT:   { label: 'UINT_TO_INT',   description: 'UINT → INT',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'INT', label: 'OUT' }] },
  DINT_TO_INT:   { label: 'DINT_TO_INT',   description: 'DINT → INT',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'INT', label: 'OUT' }] },
  UDINT_TO_INT:  { label: 'UDINT_TO_INT',  description: 'UDINT → INT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UDINT', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'INT', label: 'OUT' }] },
  REAL_TO_INT:   { label: 'REAL_TO_INT',   description: 'REAL → INT',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'INT', label: 'OUT' }] },
  // --- CONVERSION (TO_UINT) ---
  BOOL_TO_UINT:  { label: 'BOOL_TO_UINT',  description: 'BOOL → UINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BOOL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UINT', label: 'OUT' }] },
  BYTE_TO_UINT:  { label: 'BYTE_TO_UINT',  description: 'BYTE → UINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BYTE',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UINT', label: 'OUT' }] },
  WORD_TO_UINT:  { label: 'WORD_TO_UINT',  description: 'WORD → UINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'WORD',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UINT', label: 'OUT' }] },
  DWORD_TO_UINT: { label: 'DWORD_TO_UINT', description: 'DWORD → UINT', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DWORD', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UINT', label: 'OUT' }] },
  INT_TO_UINT:   { label: 'INT_TO_UINT',   description: 'INT → UINT',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'INT',   label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UINT', label: 'OUT' }] },
  DINT_TO_UINT:  { label: 'DINT_TO_UINT',  description: 'DINT → UINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UINT', label: 'OUT' }] },
  UDINT_TO_UINT: { label: 'UDINT_TO_UINT', description: 'UDINT → UINT', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UDINT', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UINT', label: 'OUT' }] },
  REAL_TO_UINT:  { label: 'REAL_TO_UINT',  description: 'REAL → UINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UINT', label: 'OUT' }] },
  // --- CONVERSION (TO_DINT) ---
  BOOL_TO_DINT:  { label: 'BOOL_TO_DINT',  description: 'BOOL → DINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BOOL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  BYTE_TO_DINT:  { label: 'BYTE_TO_DINT',  description: 'BYTE → DINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BYTE',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  WORD_TO_DINT:  { label: 'WORD_TO_DINT',  description: 'WORD → DINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'WORD',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  DWORD_TO_DINT: { label: 'DWORD_TO_DINT', description: 'DWORD → DINT', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DWORD', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  INT_TO_DINT:   { label: 'INT_TO_DINT',   description: 'INT → DINT',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'INT',   label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  UINT_TO_DINT:  { label: 'UINT_TO_DINT',  description: 'UINT → DINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  UDINT_TO_DINT: { label: 'UDINT_TO_DINT', description: 'UDINT → DINT', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UDINT', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  REAL_TO_DINT:  { label: 'REAL_TO_DINT',  description: 'REAL → DINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'DINT', label: 'OUT' }] },
  // --- CONVERSION (TO_UDINT) ---
  BOOL_TO_UDINT:  { label: 'BOOL_TO_UDINT',  description: 'BOOL → UDINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BOOL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UDINT', label: 'OUT' }] },
  BYTE_TO_UDINT:  { label: 'BYTE_TO_UDINT',  description: 'BYTE → UDINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BYTE',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UDINT', label: 'OUT' }] },
  WORD_TO_UDINT:  { label: 'WORD_TO_UDINT',  description: 'WORD → UDINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'WORD',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UDINT', label: 'OUT' }] },
  DWORD_TO_UDINT: { label: 'DWORD_TO_UDINT', description: 'DWORD → UDINT', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DWORD', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UDINT', label: 'OUT' }] },
  INT_TO_UDINT:   { label: 'INT_TO_UDINT',   description: 'INT → UDINT',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'INT',   label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UDINT', label: 'OUT' }] },
  UINT_TO_UDINT:  { label: 'UINT_TO_UDINT',  description: 'UINT → UDINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UDINT', label: 'OUT' }] },
  DINT_TO_UDINT:  { label: 'DINT_TO_UDINT',  description: 'DINT → UDINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UDINT', label: 'OUT' }] },
  REAL_TO_UDINT:  { label: 'REAL_TO_UDINT',  description: 'REAL → UDINT',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'REAL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'UDINT', label: 'OUT' }] },
  // --- CONVERSION (TO_REAL) ---
  BOOL_TO_REAL:  { label: 'BOOL_TO_REAL',  description: 'BOOL → REAL',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BOOL',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  BYTE_TO_REAL:  { label: 'BYTE_TO_REAL',  description: 'BYTE → REAL',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'BYTE',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  WORD_TO_REAL:  { label: 'WORD_TO_REAL',  description: 'WORD → REAL',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'WORD',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  DWORD_TO_REAL: { label: 'DWORD_TO_REAL', description: 'DWORD → REAL', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DWORD', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  INT_TO_REAL:   { label: 'INT_TO_REAL',   description: 'INT → REAL',   inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'INT',   label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  UINT_TO_REAL:  { label: 'UINT_TO_REAL',  description: 'UINT → REAL',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  DINT_TO_REAL:  { label: 'DINT_TO_REAL',  description: 'DINT → REAL',  inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'DINT',  label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  UDINT_TO_REAL: { label: 'UDINT_TO_REAL', description: 'UDINT → REAL', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'IN', type: 'UDINT', label: 'IN' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  NORM_X:  { label: 'NORM_X',  description: 'Normalize [MIN,MAX]→[0,1]', inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'MIN', type: 'REAL', label: 'MIN' }, { id: 'MAX', type: 'REAL', label: 'MAX' }, { id: 'VALUE', type: 'REAL', label: 'VALUE' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] },
  SCALE_X: { label: 'SCALE_X', description: 'Scale [0,1]→[MIN,MAX]',    inputs: [{ id: 'EN', type: 'BOOL', label: 'EN' }, { id: 'MIN', type: 'REAL', label: 'MIN' }, { id: 'MAX', type: 'REAL', label: 'MAX' }, { id: 'VALUE', type: 'REAL', label: 'VALUE' }], outputs: [{ id: 'ENO', type: 'BOOL', label: 'ENO' }, { id: 'OUT', type: 'REAL', label: 'OUT' }] }
};

