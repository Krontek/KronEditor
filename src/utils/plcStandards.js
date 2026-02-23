// src/utils/plcStandards.js

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

  // --- TETİKLEYİCİLER ---
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

  // --- FLIP FLOPS ---
  SR: {
    label: 'SR',
    description: 'Set Dominant',
    inputs: [
      { id: 'S1', type: 'BOOL', label: 'S1' },
      { id: 'R', type: 'BOOL', label: 'R' }
    ],
    outputs: [{ id: 'Q1', type: 'BOOL', label: 'Q1' }]
  },
  RS: {
    label: 'RS',
    description: 'Reset Dominant',
    inputs: [
      { id: 'S', type: 'BOOL', label: 'S' },
      { id: 'R1', type: 'BOOL', label: 'R1' }
    ],
    outputs: [{ id: 'Q1', type: 'BOOL', label: 'Q1' }]
  }
};

