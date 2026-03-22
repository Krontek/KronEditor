/**
 * LIBRARY_TREE — IEC 61131-3 Toolbox Hierarchy Definition
 *
 * Two kinds of subcategory entries:
 *   fromLibrary: string[]   → looks up these blockTypes in the loaded XML library data
 *   items:       object[]   → inline entries (Contact / Coil subtypes not in XML)
 *
 * Each item in `items` can have:
 *   { blockType, subType, label, desc }
 *
 * `fromLibrary` items automatically inherit their desc from the XML block definition.
 */
export const LIBRARY_TREE = [
  // ── 1. Bit Logic Operations ─────────────────────────────────────────────
  {
    id: 'bit_logic',
    title: 'Bit Logic Operations',
    subcategories: [
      {
        id: 'contacts',
        title: 'Contacts',
        items: [
          { blockType: 'Contact', subType: 'NO',      label: 'NO',      desc: 'Normally Open Contact'   },
          { blockType: 'Contact', subType: 'NC',      label: 'NC',      desc: 'Normally Closed Contact' },
          { blockType: 'Contact', subType: 'Rising',  label: 'Invert',  desc: 'Inverted / Rising Edge'  },
          { blockType: 'Contact', subType: 'Falling', label: 'Falling', desc: 'Falling Edge Contact'    },
        ]
      },
      {
        id: 'coils',
        title: 'Coils',
        items: [
          { blockType: 'Coil', subType: 'Normal', label: 'Normal', desc: 'Output Coil'        },
          { blockType: 'Coil', subType: 'Set',    label: 'Set',    desc: 'Set Coil (latch)'   },
          { blockType: 'Coil', subType: 'Reset',  label: 'Reset',  desc: 'Reset Coil (unlatch)' },
        ]
      },
      {
        id: 'bistables',
        title: 'Bistables',
        fromLibrary: ['SR', 'RS']
      },
      {
        id: 'edge_detectors',
        title: 'Edge Detectors',
        fromLibrary: ['R_TRIG', 'F_TRIG']
      },
      {
        id: 'bitwise',
        title: 'Bitwise Operations',
        fromLibrary: ['BAND', 'BOR', 'BXOR', 'BNOT', 'SHL', 'SHR', 'ROL', 'ROR']
      }
    ]
  },

  // ── 2. Standard Function Blocks ─────────────────────────────────────────
  {
    id: 'standard_fbs',
    title: 'Standard Function Blocks',
    subcategories: [
      {
        id: 'timers',
        title: 'Timers',
        fromLibrary: ['TON', 'TOF', 'TP', 'TONR']
      },
      {
        id: 'counters',
        title: 'Counters',
        fromLibrary: ['CTU', 'CTD', 'CTUD']
      }
    ]
  },

  // ── 3. Mathematical Functions ────────────────────────────────────────────
  {
    id: 'math',
    title: 'Mathematical Functions',
    subcategories: [
      {
        id: 'basic_math',
        title: 'Basic Math',
        fromLibrary: ['ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'MOVE']
      },
      {
        id: 'float_math',
        title: 'Floating Point',
        fromLibrary: ['ABS', 'SQRT', 'EXPT']
      },
      {
        id: 'trigonometry',
        title: 'Trigonometry',
        fromLibrary: ['SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN']
      }
    ]
  },

  // ── 4. Comparison & Selection ────────────────────────────────────────────
  {
    id: 'comparison',
    title: 'Comparison & Selection',
    subcategories: [
      {
        id: 'comparison_ops',
        title: 'Comparison',
        fromLibrary: ['EQ', 'NE', 'GT', 'GE', 'LT', 'LE']
      },
      {
        id: 'selection_ops',
        title: 'Selection',
        fromLibrary: ['SEL', 'MUX', 'LIMIT', 'MAX', 'MIN']
      }
    ]
  },

  // ── 5. Data Conversion ───────────────────────────────────────────────────
  {
    id: 'conversion',
    title: 'Data Conversion',
    subcategories: [
      {
        id: 'to_bool',
        title: 'TO_BOOL',
        fromLibrary: ['BYTE_TO_BOOL', 'WORD_TO_BOOL', 'DWORD_TO_BOOL', 'INT_TO_BOOL', 'UINT_TO_BOOL', 'DINT_TO_BOOL', 'UDINT_TO_BOOL', 'REAL_TO_BOOL']
      },
      {
        id: 'to_byte',
        title: 'TO_BYTE',
        fromLibrary: ['BOOL_TO_BYTE', 'WORD_TO_BYTE', 'DWORD_TO_BYTE', 'INT_TO_BYTE', 'UINT_TO_BYTE', 'DINT_TO_BYTE', 'UDINT_TO_BYTE', 'REAL_TO_BYTE']
      },
      {
        id: 'to_word',
        title: 'TO_WORD',
        fromLibrary: ['BOOL_TO_WORD', 'BYTE_TO_WORD', 'DWORD_TO_WORD', 'INT_TO_WORD', 'UINT_TO_WORD', 'DINT_TO_WORD', 'UDINT_TO_WORD', 'REAL_TO_WORD']
      },
      {
        id: 'to_dword',
        title: 'TO_DWORD',
        fromLibrary: ['BOOL_TO_DWORD', 'BYTE_TO_DWORD', 'WORD_TO_DWORD', 'INT_TO_DWORD', 'UINT_TO_DWORD', 'DINT_TO_DWORD', 'UDINT_TO_DWORD', 'REAL_TO_DWORD']
      },
      {
        id: 'to_int',
        title: 'TO_INT',
        fromLibrary: ['BOOL_TO_INT', 'BYTE_TO_INT', 'WORD_TO_INT', 'DWORD_TO_INT', 'UINT_TO_INT', 'DINT_TO_INT', 'UDINT_TO_INT', 'REAL_TO_INT']
      },
      {
        id: 'to_uint',
        title: 'TO_UINT',
        fromLibrary: ['BOOL_TO_UINT', 'BYTE_TO_UINT', 'WORD_TO_UINT', 'DWORD_TO_UINT', 'INT_TO_UINT', 'DINT_TO_UINT', 'UDINT_TO_UINT', 'REAL_TO_UINT']
      },
      {
        id: 'to_dint',
        title: 'TO_DINT',
        fromLibrary: ['BOOL_TO_DINT', 'BYTE_TO_DINT', 'WORD_TO_DINT', 'DWORD_TO_DINT', 'INT_TO_DINT', 'UINT_TO_DINT', 'UDINT_TO_DINT', 'REAL_TO_DINT']
      },
      {
        id: 'to_udint',
        title: 'TO_UDINT',
        fromLibrary: ['BOOL_TO_UDINT', 'BYTE_TO_UDINT', 'WORD_TO_UDINT', 'DWORD_TO_UDINT', 'INT_TO_UDINT', 'UINT_TO_UDINT', 'DINT_TO_UDINT', 'REAL_TO_UDINT']
      },
      {
        id: 'to_real',
        title: 'TO_REAL',
        fromLibrary: ['BOOL_TO_REAL', 'BYTE_TO_REAL', 'WORD_TO_REAL', 'DWORD_TO_REAL', 'INT_TO_REAL', 'UINT_TO_REAL', 'DINT_TO_REAL', 'UDINT_TO_REAL']
      },
      {
        id: 'scaling',
        title: 'Scaling',
        fromLibrary: ['NORM_X', 'SCALE_X']
      }
    ]
  },

  // ── 6. Advanced Control ──────────────────────────────────────────────────
  {
    id: 'advanced_control',
    title: 'Advanced Control',
    subcategories: [
      {
        id: 'regulators',
        title: 'Regulators',
        fromLibrary: ['PID_Compact', 'Filter_LowPass']
      },
      {
        id: 'signal_processing',
        title: 'Signal Processing',
        items: [
          { blockType: 'Moving_Average', label: 'Moving_Average', desc: 'Moving Average Filter'   },
          { blockType: 'Ramp_Function',  label: 'Ramp_Function',  desc: 'Ramp Function Generator' }
        ]
      }
    ]
  },

  // ── 7. Motion Control ────────────────────────────────────────────────────
  {
    id: 'motion',
    title: 'Motion Control',
    subcategories: [
      {
        id: 'motion_admin',
        title: 'Administrative',
        fromLibrary: ['MC_Power', 'MC_Stop']
      },
      {
        id: 'motion_p2p',
        title: 'Point-to-Point',
        fromLibrary: ['MC_MoveAbsolute', 'MC_MoveRelative']
      },
      {
        id: 'motion_homing',
        title: 'Homing',
        items: [
          { blockType: 'MC_Home', label: 'MC_Home', desc: 'Homing Sequence' }
        ]
      },
      {
        id: 'motion_multi',
        title: 'Multi-Axis',
        items: [
          { blockType: 'MC_GearIn', label: 'MC_GearIn', desc: 'Electronic Gearing' },
          { blockType: 'MC_CamIn',  label: 'MC_CamIn',  desc: 'Electronic Cam'     }
        ]
      }
    ]
  },

  // ── 8. Communication ─────────────────────────────────────────────────────
  {
    id: 'communication',
    title: 'Communication',
    subcategories: [
      {
        id: 'comm_generic',
        title: 'Generic',
        fromLibrary: ['TSEND', 'TRCV']
      },
      {
        id: 'comm_protocols',
        title: 'Protocols',
        fromLibrary: ['Modbus_Master', 'MQTT_Client']
      },
      {
        id: 'comm_diagnostics',
        title: 'Diagnostics',
        items: [
          { blockType: 'Get_Alarm_State',   label: 'Get_Alarm_State',   desc: 'Read Active Alarms'  },
          { blockType: 'Read_Hardware_ID',  label: 'Read_Hardware_ID',  desc: 'Read Hardware ID'    }
        ]
      }
    ]
  },

  // ── 9. System & Time ─────────────────────────────────────────────────────
  {
    id: 'system',
    title: 'System & Time',
    subcategories: [
      {
        id: 'rtc',
        title: 'RTC',
        fromLibrary: ['Read_System_Time']
      },
      {
        id: 'file_ops',
        title: 'File',
        fromLibrary: ['Log_Data']
      }
    ]
  }
];

// EtherCAT Master function block tree — shown in Toolbox only when an EtherCAT bus is present
export const ETHERCAT_LIBRARY_TREE = [
  {
    id: 'ec_master_ctrl',
    title: 'Master Control',
    items: [
      { blockType: 'EC_Init',  label: 'EC_Init',  desc: 'Initialize EtherCAT master on a network interface',
        customData: { class: 'FunctionBlock',
          inputs:  [{ name: 'EN', type: 'BOOL' }, { name: 'Interface', type: 'STRING' }],
          outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'Done', type: 'BOOL' }, { name: 'Error', type: 'BOOL' }, { name: 'ErrorID', type: 'INT' }] } },
      { blockType: 'EC_Close', label: 'EC_Close', desc: 'Release EtherCAT master and close all slaves',
        customData: { class: 'FunctionBlock',
          inputs:  [{ name: 'EN', type: 'BOOL' }],
          outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'Done', type: 'BOOL' }] } },
    ]
  },
  {
    id: 'ec_pdo',
    title: 'PDO Access',
    items: [
      { blockType: 'EC_ReadPDO',  label: 'EC_ReadPDO',  desc: 'Read a PDO entry from the IOmap (slave input)',
        customData: { class: 'FunctionBlock',
          inputs:  [{ name: 'EN', type: 'BOOL' }, { name: 'Slave', type: 'INT' }, { name: 'Index', type: 'INT' }],
          outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'Value', type: 'DWORD' }] } },
      { blockType: 'EC_WritePDO', label: 'EC_WritePDO', desc: 'Write a PDO entry to the IOmap (slave output)',
        customData: { class: 'FunctionBlock',
          inputs:  [{ name: 'EN', type: 'BOOL' }, { name: 'Slave', type: 'INT' }, { name: 'Index', type: 'INT' }, { name: 'Value', type: 'DWORD' }],
          outputs: [{ name: 'ENO', type: 'BOOL' }] } },
    ]
  },
  {
    id: 'ec_sdo',
    title: 'SDO Access',
    items: [
      { blockType: 'EC_ReadSDO',  label: 'EC_ReadSDO',  desc: 'Asynchronous SDO upload from slave object dictionary',
        customData: { class: 'FunctionBlock',
          inputs:  [{ name: 'Execute', type: 'BOOL' }, { name: 'Slave', type: 'INT' }, { name: 'Index', type: 'WORD' }, { name: 'SubIndex', type: 'BYTE' }],
          outputs: [{ name: 'Done', type: 'BOOL' }, { name: 'Busy', type: 'BOOL' }, { name: 'Error', type: 'BOOL' }, { name: 'Value', type: 'DWORD' }] } },
      { blockType: 'EC_WriteSDO', label: 'EC_WriteSDO', desc: 'Asynchronous SDO download to slave object dictionary',
        customData: { class: 'FunctionBlock',
          inputs:  [{ name: 'Execute', type: 'BOOL' }, { name: 'Slave', type: 'INT' }, { name: 'Index', type: 'WORD' }, { name: 'SubIndex', type: 'BYTE' }, { name: 'Value', type: 'DWORD' }],
          outputs: [{ name: 'Done', type: 'BOOL' }, { name: 'Busy', type: 'BOOL' }, { name: 'Error', type: 'BOOL' }] } },
    ]
  },
  {
    id: 'ec_diag',
    title: 'Diagnostics',
    items: [
      { blockType: 'EC_SlaveStatus',  label: 'EC_SlaveStatus',  desc: 'Read slave state (Init/PreOp/SafeOp/Op) and online flag',
        customData: { class: 'FunctionBlock',
          inputs:  [{ name: 'EN', type: 'BOOL' }, { name: 'Slave', type: 'INT' }],
          outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'State', type: 'INT' }, { name: 'Online', type: 'BOOL' }] } },
      { blockType: 'EC_MasterStatus', label: 'EC_MasterStatus', desc: 'Read master state and total online slave count',
        customData: { class: 'FunctionBlock',
          inputs:  [{ name: 'EN', type: 'BOOL' }],
          outputs: [{ name: 'ENO', type: 'BOOL' }, { name: 'State', type: 'INT' }, { name: 'SlaveCount', type: 'INT' }] } },
    ]
  },
];
