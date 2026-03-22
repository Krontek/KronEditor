/**
 * EsiParser.js  –  EtherCAT ESI (EtherCAT Slave Information) XML parser
 *
 * Parses ETG.2000 compliant ESI XML files and extracts:
 *   - Device descriptions (vendor, product, revision)
 *   - TxPDO (inputs from slave to master)
 *   - RxPDO (outputs from master to slave)
 *   - PDO entries with index, subindex, data type, bit length, name
 *   - CoE startup SDO commands
 *   - Supported sync modes / cycle times
 *
 * Returns an array of EsiDevice objects.
 */

/* ── Data-type bit-size map (ETG.1000.6 §5.6.2) ── */
const ESI_DTYPE_BITS = {
  'BOOL':   1,
  'BIT1':   1, 'BIT2': 2, 'BIT3': 3, 'BIT4': 4,
  'BYTE':   8,
  'UINT8':  8,  'INT8':  8,
  'UINT16': 16, 'INT16': 16,
  'UINT32': 32, 'INT32': 32,
  'UINT64': 64, 'INT64': 64,
  'REAL32': 32, 'REAL64': 64,
  'STRING': 8,  /* per character */
  'OCTET_STRING': 8,
  'USINT': 8,  'SINT': 8,
  'UINT':  16, 'INT': 16,
  'UDINT': 32, 'DINT': 32,
  'ULINT': 64, 'LINT': 64,
};

/** Map ESI data type string → kronethercatmaster.h KRON_EC_DataType enum value */
export const esiDtypeToKron = (dtype) => {
  const u = (dtype || '').toUpperCase();
  if (u === 'BOOL' || u.startsWith('BIT')) return 'KRON_EC_DTYPE_BOOL';
  if (u === 'INT8'  || u === 'SINT')  return 'KRON_EC_DTYPE_INT8';
  if (u === 'UINT8' || u === 'USINT' || u === 'BYTE') return 'KRON_EC_DTYPE_UINT8';
  if (u === 'INT16' || u === 'INT')   return 'KRON_EC_DTYPE_INT16';
  if (u === 'UINT16'|| u === 'UINT')  return 'KRON_EC_DTYPE_UINT16';
  if (u === 'INT32' || u === 'DINT')  return 'KRON_EC_DTYPE_INT32';
  if (u === 'UINT32'|| u === 'UDINT') return 'KRON_EC_DTYPE_UINT32';
  if (u === 'INT64' || u === 'LINT')  return 'KRON_EC_DTYPE_INT64';
  if (u === 'UINT64'|| u === 'ULINT') return 'KRON_EC_DTYPE_UINT64';
  if (u === 'REAL32'|| u === 'FLOAT') return 'KRON_EC_DTYPE_REAL32';
  if (u === 'REAL64'|| u === 'LREAL') return 'KRON_EC_DTYPE_REAL64';
  return 'KRON_EC_DTYPE_UINT8';
};

/** Map ESI data type → IEC 61131-3 type (for global variable creation) */
export const esiDtypeToIEC = (dtype) => {
  const u = (dtype || '').toUpperCase();
  if (u === 'BOOL' || u.startsWith('BIT')) return 'BOOL';
  if (u === 'INT8'  || u === 'SINT')  return 'SINT';
  if (u === 'UINT8' || u === 'USINT' || u === 'BYTE') return 'USINT';
  if (u === 'INT16' || u === 'INT')   return 'INT';
  if (u === 'UINT16'|| u === 'UINT')  return 'UINT';
  if (u === 'INT32' || u === 'DINT')  return 'DINT';
  if (u === 'UINT32'|| u === 'UDINT') return 'UDINT';
  if (u === 'INT64' || u === 'LINT')  return 'LINT';
  if (u === 'UINT64'|| u === 'ULINT') return 'ULINT';
  if (u === 'REAL32'|| u === 'FLOAT') return 'REAL';
  if (u === 'REAL64'|| u === 'LREAL') return 'LREAL';
  return 'USINT';
};

/* ── XML helpers ─────────────────────────────────────────────────────────── */

function txt(el, tag) {
  const c = el?.querySelector?.(tag) ?? el?.getElementsByTagName?.(tag)?.[0];
  return c?.textContent?.trim() ?? '';
}

function attr(el, name) {
  return el?.getAttribute?.(name) ?? '';
}

/** Parse a hex or decimal string, return number */
function parseNum(s) {
  if (!s) return 0;
  s = s.trim();
  if (s.startsWith('#x') || s.startsWith('#X')) return parseInt(s.slice(2), 16);
  if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s.slice(2), 16);
  return parseInt(s, 10) || 0;
}

/** Get direct child elements by tag name (non-recursive) */
function children(el, tag) {
  if (!el) return [];
  const result = [];
  for (const child of el.children ?? []) {
    if (child.tagName === tag || child.localName === tag) result.push(child);
  }
  return result;
}

/* ── SDO parser ──────────────────────────────────────────────────────────── */

function parseStartupSdos(deviceEl) {
  const sdos = [];
  /* CoE > InitCmds > InitCmd */
  const coe = deviceEl.querySelector?.('CoE') ?? null;
  if (!coe) return sdos;
  const initCmds = coe.querySelector?.('InitCmds') ?? null;
  if (!initCmds) return sdos;

  for (const cmd of children(initCmds, 'InitCmd')) {
    const transition = txt(cmd, 'Transition');
    /* Only include PS (PRE-OP → SAFE-OP) or SI, IP startup commands */
    if (transition && !['PS','PI','SI','IP'].includes(transition.toUpperCase())) continue;

    const indexStr   = txt(cmd, 'Index')    || attr(cmd, 'Index');
    const subStr     = txt(cmd, 'SubIndex') || attr(cmd, 'SubIndex');
    const dataStr    = txt(cmd, 'Data')     || attr(cmd, 'Data');
    const comment    = txt(cmd, 'Comment');

    const index    = parseNum(indexStr);
    const subindex = parseNum(subStr);
    if (!index) continue;

    /* Data is a hex string, e.g. "01000000" (little-endian) */
    let value    = 0;
    let byteSize = 1;
    if (dataStr) {
      const hex = dataStr.replace(/\s/g, '');
      byteSize  = Math.max(1, hex.length / 2);
      byteSize  = Math.min(byteSize, 4);
      value     = parseInt(hex.slice(0, 8), 16) || 0;
    }

    sdos.push({ index, subindex, value, byteSize, comment, transition });
  }
  return sdos;
}

/* ── PDO parser ──────────────────────────────────────────────────────────── */

function parsePdoGroup(pdoEls, direction) {
  const pdos = [];
  for (const pdo of pdoEls) {
    const pdoIndex = parseNum(txt(pdo, 'Index') || attr(pdo, 'Index'));
    const pdoName  = txt(pdo, 'Name') || `PDO_${pdoIndex.toString(16).toUpperCase()}`;
    const fixed    = attr(pdo, 'Fixed') === '1' || attr(pdo, 'Fixed') === 'true';
    const mandatory= attr(pdo, 'Mandatory') === '1';

    const entries = [];
    for (const entry of children(pdo, 'Entry')) {
      const indexStr   = txt(entry, 'Index')    || attr(entry, 'Index');
      const subStr     = txt(entry, 'SubIndex') || attr(entry, 'SubIndex');
      const bitlenStr  = txt(entry, 'BitLen')   || attr(entry, 'BitLen');
      const dtStr      = txt(entry, 'DataType') || attr(entry, 'DataType');
      const entryName  = txt(entry, 'Name');

      const index    = parseNum(indexStr);
      const subindex = parseNum(subStr);
      const bitLen   = parseNum(bitlenStr) || (ESI_DTYPE_BITS[dtStr?.toUpperCase()] ?? 8);

      /* Skip padding entries (index=0) */
      if (!index && !entryName) continue;

      entries.push({
        index,
        subindex,
        bitLen,
        dtype:    dtStr || 'UINT8',
        kronDtype: esiDtypeToKron(dtStr),
        iecType:  esiDtypeToIEC(dtStr),
        name:     entryName || `Entry_${index.toString(16).toUpperCase()}_${subindex}`,
      });
    }
    pdos.push({ index: pdoIndex, name: pdoName, direction, fixed, mandatory, entries });
  }
  return pdos;
}

/* ── Device parser ───────────────────────────────────────────────────────── */

function parseDevice(deviceEl, vendorId, vendorName) {
  const name        = txt(deviceEl, 'Name')    || txt(deviceEl, 'Type');
  const productCode = parseNum(txt(deviceEl, 'ProductCode')  || attr(deviceEl.querySelector?.('Type') ?? deviceEl, 'ProductCode'));
  const revision    = parseNum(txt(deviceEl, 'RevisionNo')   || attr(deviceEl.querySelector?.('Type') ?? deviceEl, 'RevisionNo'));

  /* Type element can also hold ProductCode / RevisionNo as attributes */
  const typeEl = deviceEl.querySelector?.('Type');
  const pc  = productCode || parseNum(attr(typeEl ?? deviceEl, 'ProductCode'));
  const rev = revision    || parseNum(attr(typeEl ?? deviceEl, 'RevisionNo'));

  /* TxPDOs (slave → master = inputs) */
  const txPdoEls = Array.from(deviceEl.querySelectorAll?.('TxPdo') ?? []);
  const rxPdoEls = Array.from(deviceEl.querySelectorAll?.('RxPdo') ?? []);

  const txPdos = parsePdoGroup(txPdoEls, 'input');
  const rxPdos = parsePdoGroup(rxPdoEls, 'output');

  const sdos = parseStartupSdos(deviceEl);

  /* Sync modes */
  const syncModes = [];
  for (const sm of (deviceEl.querySelectorAll?.('Sm') ?? [])) {
    syncModes.push({
      minCycleTime: parseNum(attr(sm, 'MinCycleTime')),
      defaultCycleTime: parseNum(attr(sm, 'DefaultCycleTime')),
    });
  }

  return {
    vendorId,
    vendorName,
    name,
    productCode: pc,
    revision:    rev,
    txPdos,
    rxPdos,
    sdos,
    syncModes,
    allPdos: [...txPdos, ...rxPdos],
  };
}

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Parse an ESI XML string and return an array of EsiDevice objects.
 *
 * @param {string} xmlString - Full ESI XML file content
 * @returns {EsiDevice[]}
 */
export function parseEsiXml(xmlString) {
  const parser  = new DOMParser();
  const doc     = parser.parseFromString(xmlString, 'text/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    throw new Error('ESI XML parse error: ' + parseErr.textContent);
  }

  /* Vendor info */
  const vendorEl  = doc.querySelector('Vendor');
  const vendorId  = parseNum(txt(vendorEl, 'Id'));
  const vendorName= txt(vendorEl, 'Name') || 'Unknown';

  const devices = [];
  for (const devEl of (doc.querySelectorAll('Device') ?? [])) {
    try {
      devices.push(parseDevice(devEl, vendorId, vendorName));
    } catch (e) {
      console.warn('[EsiParser] Skipped device:', e.message);
    }
  }
  return devices;
}

/**
 * Generate a list of suggested global variables from a set of selected PDO entries.
 *
 * @param {object[]} selectedEntries - Array of { entry, slaveName, direction }
 * @param {string}   prefix          - Optional prefix for variable names
 * @returns {{ name: string, type: string, direction: string, comment: string }[]}
 */
export function pdoEntriesToGlobalVars(selectedEntries, prefix = 'ec') {
  return selectedEntries.map(({ entry, slaveName, direction }) => {
    const safeSlave = (slaveName || 'slave').replace(/[^A-Za-z0-9_]/g, '_');
    const safeName  = (entry.name || 'var').replace(/[^A-Za-z0-9_]/g, '_');
    const varName   = `${prefix}_${safeSlave}_${safeName}`.replace(/__+/g, '_');
    return {
      name:      varName,
      type:      entry.iecType || 'USINT',
      direction, /* 'input' | 'output' */
      kronDtype: entry.kronDtype,
      index:     entry.index,
      subindex:  entry.subindex,
      bitLen:    entry.bitLen,
      comment:   `EtherCAT ${direction}: ${slaveName} ${entry.name}`,
    };
  });
}
