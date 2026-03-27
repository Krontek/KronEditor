/**
 * Registers the IEC 61131-3 Structured Text language ('iec-st') and
 * the 'plc-dark' theme into a Monaco instance.
 * Safe to call multiple times — idempotent.
 */
export function registerIECSTLanguage(monaco) {
  // Monaco doesn't expose a "is registered?" API cleanly, but re-registering
  // a language and re-setting a tokenizer is harmless (last call wins).
  monaco.languages.register({ id: 'iec-st' });

  monaco.languages.setMonarchTokensProvider('iec-st', {
    ignoreCase: true,
    defaultToken: 'identifier',
    keywords: [
      'IF', 'THEN', 'ELSE', 'ELSIF', 'END_IF',
      'CASE', 'OF', 'END_CASE',
      'FOR', 'TO', 'BY', 'DO', 'END_FOR',
      'WHILE', 'END_WHILE',
      'REPEAT', 'UNTIL', 'END_REPEAT',
      'RETURN', 'EXIT',
      'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_EXTERNAL',
      'END_VAR', 'VAR_TEMP', 'VAR_ACCESS',
      'PROGRAM', 'END_PROGRAM', 'FUNCTION', 'END_FUNCTION',
      'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
      'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT',
      'ARRAY', 'AT', 'CONSTANT', 'RETAIN',
    ],
    typeKeywords: [
      'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
      'SINT', 'INT', 'DINT', 'LINT',
      'USINT', 'UINT', 'UDINT', 'ULINT',
      'REAL', 'LREAL',
      'TIME', 'DATE', 'TIME_OF_DAY', 'TOD', 'DATE_AND_TIME', 'DT',
      'STRING', 'WSTRING',
    ],
    builtinFBs: [
      'TON', 'TOF', 'TP', 'TONR',
      'CTU', 'CTD', 'CTUD',
      'R_TRIG', 'F_TRIG',
      'SR', 'RS',
      'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'MOVE', 'ABS', 'SQRT', 'EXPT', 'NEG', 'AVG',
      'GT', 'GE', 'EQ', 'NE', 'LE', 'LT',
      'SEL', 'MUX', 'MIN', 'MAX', 'LIMIT',
      'SHL', 'SHR', 'ROL', 'ROR',
      'BAND', 'BOR', 'BXOR', 'BNOT',
      'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN',
    ],
    boolLiterals: ['TRUE', 'FALSE'],
    logicOperators: ['AND', 'OR', 'NOT', 'XOR'],
    operators: [
      ':=', '=>', '<=', '>=', '<>', '=', '<', '>',
      '+', '-', '*', '/', '**',
      '(', ')', '[', ']', '.', ',', ';', ':',
    ],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\(\*/, 'comment', '@blockComment'],
        [/\/\*/, 'comment', '@blockComment2'],
        [/\b(T|TIME)#[0-9a-z_dhmsu]+\b/i, 'number.time'],
        [/\b16#[0-9A-Fa-f_]+\b/, 'number.hex'],
        [/\b8#[0-7_]+\b/, 'number.octal'],
        [/\b2#[01_]+\b/, 'number.binary'],
        [/\b\d+\.\d+([eE][+-]?\d+)?\b/, 'number.float'],
        [/\b\d+\b/, 'number'],
        [/'[^']*'/, 'string'],
        [/"[^"]*"/, 'string'],
        [/[a-zA-Z_][a-zA-Z0-9_]*/, {
          cases: {
            '@boolLiterals': 'constant.boolean',
            '@logicOperators': 'keyword.operator',
            '@keywords': 'keyword',
            '@typeKeywords': 'type',
            '@builtinFBs': 'entity.function',
            '@default': 'identifier',
          }
        }],
        [/:=|=>|<>|<=|>=|\*\*/, 'operator'],
        [/[=<>+\-*/]/, 'operator'],
        [/[;,.:()\[\]]/, 'delimiter'],
        [/\s+/, 'white'],
      ],
      blockComment: [
        [/[^*()]+/, 'comment'],
        [/\*\)/, 'comment', '@pop'],
        [/./, 'comment'],
      ],
      blockComment2: [
        [/[^*/]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/./, 'comment'],
      ],
    },
  });

  monaco.editor.defineTheme('plc-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword',          foreground: 'C586C0', fontStyle: 'bold' },
      { token: 'keyword.operator', foreground: '569CD6', fontStyle: 'bold' },
      { token: 'type',             foreground: '4EC9B0' },
      { token: 'entity.function',  foreground: 'DCDCAA' },
      { token: 'constant.boolean', foreground: '569CD6' },
      { token: 'identifier',       foreground: '9CDCFE' },
      { token: 'number',           foreground: 'B5CEA8' },
      { token: 'number.float',     foreground: 'B5CEA8' },
      { token: 'number.hex',       foreground: 'B5CEA8' },
      { token: 'number.octal',     foreground: 'B5CEA8' },
      { token: 'number.binary',    foreground: 'B5CEA8' },
      { token: 'number.time',      foreground: 'CE9178' },
      { token: 'string',           foreground: 'CE9178' },
      { token: 'comment',          foreground: '6A9955', fontStyle: 'italic' },
      { token: 'operator',         foreground: 'D4D4D4' },
      { token: 'delimiter',        foreground: 'D4D4D4' },
    ],
    colors: {
      'editor.background':                  '#1e1e1e',
      'editorCursor.foreground':            '#AEAFAD',
      'editor.lineHighlightBackground':     '#2b2b2b',
      'editorLineNumber.foreground':        '#858585',
      'editor.selectionBackground':         '#264f78',
      'editor.inactiveSelectionBackground': '#3a3d41',
    },
  });

  monaco.editor.setTheme('plc-dark');
}
