/**
 * ErrorCodeService — Loads per-block error code catalogs from XML files
 * and provides lookup: (blockType, errorCode) → description text.
 *
 * XML files are located in public/libraries/errors/ and follow this format:
 *   <error_codes library="LibName">
 *     <block type="BlockType">
 *       <error code="1" name="ERR_NAME" text="Description" />
 *     </block>
 *   </error_codes>
 *
 * Usage:
 *   const svc = new ErrorCodeService();
 *   await svc.load();
 *   svc.lookup('MC_MoveAbsolute', 2) → { code: 2, name: 'ERR_STATE', text: '...' }
 */
export class ErrorCodeService {
  constructor() {
    /** @type {Map<string, Map<number, {code:number, name:string, text:string}>>} */
    this.catalog = new Map();
    // ⚠️ A block may be catalogued with NO codes at all and a <note> saying
    // why (MC_ReadStatus, MC_ReadAxisInfo, MC_ReadAxisError report the axis
    // state, not a fault of their own). Kept apart from `catalog` so lookup()
    // semantics stay "a code resolved or it did not", while the UI can still
    // tell "documented: nothing to report" from "this block is undocumented".
    /** @type {Map<string, string>} */
    this.notes = new Map();

    this.errorFiles = [
      '/libraries/errors/motion_errors.xml',
      '/libraries/errors/hal_errors.xml',
      '/libraries/errors/communication_errors.xml',
      '/libraries/errors/ethercat_errors.xml',
      '/libraries/errors/system_errors.xml',
    ];
  }

  async load() {
    const promises = this.errorFiles.map(file =>
      fetch(file)
        .then(res => {
          if (!res.ok) throw new Error(`Failed to load ${file}`);
          return res.text();
        })
        .then(xml => this._parseXml(xml))
        .catch(err => {
          console.warn(`ErrorCodeService: could not load ${file}:`, err);
        })
    );
    await Promise.all(promises);
    return this.catalog;
  }

  /** Parse one catalog file into this.catalog.
   *
   * ⚠️ TWO shapes must both work. A block either lists its own <error>
   * children, or pulls in the codes every block of that library shares:
   *     <shared><error code="1" …/></shared>
   *     <block type="MC_Home"><uses shared="1,2,4,5,100" /></block>
   * The <uses> form used to be ignored completely — only <error> children of a
   * <block> were read — so 13 of the 24 motion blocks (MC_MoveAbsolute among
   * them) registered ZERO codes and their ErrorID surfaced as a bare number
   * with no explanation anywhere in the UI.
   */
  _parseXml(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');

    const shared = new Map();
    for (const el of doc.querySelectorAll('shared > error')) {
      const e = ErrorCodeService._parseError(el);
      if (e) shared.set(e.code, e);
    }

    for (const block of doc.querySelectorAll('block')) {
      const blockType = block.getAttribute('type');
      if (!blockType) continue;

      const errors = new Map();
      for (const uses of block.querySelectorAll('uses')) {
        for (const tok of (uses.getAttribute('shared') || '').split(',')) {
          const e = shared.get(ErrorCodeService._parseCode(tok));
          if (e) errors.set(e.code, e);
        }
      }
      // A block's own <error> overrides the shared text for the same code.
      for (const el of block.querySelectorAll('error')) {
        const e = ErrorCodeService._parseError(el);
        if (e) errors.set(e.code, e);
      }

      const note = block.getElementsByTagName('note')[0];
      const noteText = note ? (note.textContent || '').trim() : '';
      if (noteText) this.notes.set(blockType, noteText);
      if (errors.size > 0) this.catalog.set(blockType, errors);
    }
  }

  static _parseCode(raw) {
    const str = (raw || '').trim();
    if (!str) return NaN;
    return str.toLowerCase().startsWith('0x') ? parseInt(str, 16) : parseInt(str, 10);
  }

  static _parseError(el) {
    const code = ErrorCodeService._parseCode(el.getAttribute('code'));
    if (!Number.isFinite(code)) return null;
    return { code, name: el.getAttribute('name') || '', text: el.getAttribute('text') || '' };
  }

  /** Catalog keys to try for an editor block type, most specific first.
   *
   * ⚠️ The toolbox mints ONE block per hardware CHANNEL (PWM0, UART1_Send,
   * I2C0_Read …) while the catalog documents the generic HAL block they all
   * dispatch to (HAL_PWM, HAL_UART_Send, HAL_I2C_Read) — the channel is a
   * dispatch detail and the error codes are identical (resources/krontek-include/CLAUDE.md). lookup()
   * was an exact Map.get with no normalisation, so all 17 HAL entries were
   * unreachable from the editor; only the three channel-less GPIO blocks
   * matched, by luck.
   */
  static _candidates(blockType) {
    if (!blockType) return [];
    const out = [blockType];
    // ⚠️ The CHANNEL is the LAST digit run before the verb, so the greedy
    // `.*[A-Za-z]` is required: a peripheral name may itself contain a digit
    // (I2C0_Read → I2C + 0 + _Read). An `[A-Za-z]+` prefix split it as "I" + "2"
    // and left every I2C block unresolved.
    const m = /^(.*[A-Za-z])(\d+)(_.+)?$/.exec(blockType);
    if (m) {
      const periph = m[1];
      const rest = m[3] || '';
      out.push(`HAL_${periph}${rest}`);
      // SPI's transfer block is catalogued as plain HAL_SPI. Pushed AFTER the
      // specific name so a future HAL_SPI_<verb> entry still wins.
      if (periph === 'SPI') out.push('HAL_SPI');
    }
    return out;
  }

  /**
   * Look up error description for a given block type and error code.
   * @param {string} blockType - e.g. 'MC_MoveAbsolute', 'HAL_UART_Send'
   * @param {number} errorCode - e.g. 1, 2, 100
   * @returns {{code:number, name:string, text:string}|null}
   */
  lookup(blockType, errorCode) {
    if (!errorCode || errorCode === 0) return null;
    for (const key of ErrorCodeService._candidates(blockType)) {
      const hit = this.catalog.get(key)?.get(errorCode);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Get all error definitions for a block type.
   * @param {string} blockType
   * @returns {Array<{code:number, name:string, text:string}>}
   */
  getBlockErrors(blockType) {
    for (const key of ErrorCodeService._candidates(blockType)) {
      const blockErrors = this.catalog.get(key);
      if (blockErrors) return Array.from(blockErrors.values()).sort((a, b) => a.code - b.code);
    }
    return [];
  }

  /** Explanatory note for a block that documents no error codes, or ''. */
  getBlockNote(blockType) {
    for (const key of ErrorCodeService._candidates(blockType)) {
      const n = this.notes.get(key);
      if (n) return n;
    }
    return '';
  }

  /** True when this block type appears in a catalog at all — with codes or
   *  with a note. Lets the UI say "nothing to report" instead of going silent. */
  isDocumented(blockType) {
    return ErrorCodeService._candidates(blockType)
      .some(k => this.catalog.has(k) || this.notes.has(k));
  }

  /**
   * Check if a variable name looks like an error code field.
   * Matches ErrorID, ERR_ID, ErrorCode patterns.
   * @param {string} varName - full variable name like 'prog__mc_stop.ErrorID'
   * @returns {string|null} - the error field name or null
   */
  /**
   * Check if a variable name ends with an error code field suffix.
   * Handles both dot-notation (inst.ErrorID) and underscore-notation
   * (prog_Main_my_stop_ErrorID) as used in flattened SHM variables.
   * @param {string} varName - display name or liveKey
   * @returns {string|null} - the error field name or null
   */
  static getErrorFieldName(varName) {
    if (!varName) return null;
    for (const field of ['ErrorID', 'ERR_ID', 'ErrorCode']) {
      if (varName.endsWith(field) || varName.endsWith('.' + field) || varName.endsWith('_' + field)) {
        return field;
      }
    }
    return null;
  }

  /**
   * Given a liveKey like 'prog_MainProg_my_stop_ErrorID', strip the error
   * field suffix and find the parent FB instance type from the project.
   * @param {string} liveKey
   * @param {string} errorField - 'ErrorID', 'ERR_ID', or 'ErrorCode'
   * @param {object} projectStructure
   * @returns {string|null} block type e.g. 'MC_Stop'
   */
  static resolveBlockType(liveKey, errorField, projectStructure) {
    if (!liveKey || !projectStructure) return null;

    // Strip error field suffix from liveKey
    // liveKey: prog_ProgName_instanceName_ErrorID → instanceName
    const suffix = '_' + errorField;
    if (!liveKey.endsWith(suffix)) return null;
    const baseLiveKey = liveKey.slice(0, -suffix.length);

    const allPOUs = [
      ...(projectStructure.programs || []),
      ...(projectStructure.functionBlocks || []),
    ];

    // Match against actual POU names to avoid underscore ambiguity.
    // e.g. prog_Main_Program_my_sdo → POU "Main Program" (safe: Main_Program), var "my_sdo"
    if (baseLiveKey.startsWith('prog_')) {
      const rest = baseLiveKey.slice(5); // strip 'prog_'
      for (const pou of allPOUs) {
        const safeProg = pou.name.trim().replace(/\s+/g, '_');
        const prefix = safeProg + '_';
        if (rest.startsWith(prefix)) {
          const varName = rest.slice(prefix.length);
          const v = (pou.content?.variables || []).find(vr =>
            vr.name.replace(/\s+/g, '_') === varName
          );
          if (v && v.type) return v.type;
        }
      }
    }

    // Check global vars
    const globals = projectStructure.globalVars || [];
    const gv = globals.find(v => v.name.replace(/\s+/g, '_') === baseLiveKey);
    if (gv && gv.type) return gv.type;

    return null;
  }
}

export const errorCodeService = new ErrorCodeService();
