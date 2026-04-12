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

    this.errorFiles = [
      '/libraries/errors/motion_errors.xml',
      '/libraries/errors/hal_errors.xml',
      '/libraries/errors/communication_errors.xml',
      '/libraries/errors/ethercat_errors.xml',
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

  _parseXml(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');
    const blocks = doc.querySelectorAll('block');

    for (const block of blocks) {
      const blockType = block.getAttribute('type');
      if (!blockType) continue;

      const errors = new Map();
      for (const err of block.querySelectorAll('error')) {
        const codeStr = err.getAttribute('code');
        const code = codeStr.startsWith('0x')
          ? parseInt(codeStr, 16)
          : parseInt(codeStr, 10);
        errors.set(code, {
          code,
          name: err.getAttribute('name') || '',
          text: err.getAttribute('text') || '',
        });
      }

      if (errors.size > 0) {
        this.catalog.set(blockType, errors);
      }
    }
  }

  /**
   * Look up error description for a given block type and error code.
   * @param {string} blockType - e.g. 'MC_MoveAbsolute', 'HAL_UART_Send'
   * @param {number} errorCode - e.g. 1, 2, 100
   * @returns {{code:number, name:string, text:string}|null}
   */
  lookup(blockType, errorCode) {
    if (!errorCode || errorCode === 0) return null;
    const blockErrors = this.catalog.get(blockType);
    if (!blockErrors) return null;
    return blockErrors.get(errorCode) || null;
  }

  /**
   * Get all error definitions for a block type.
   * @param {string} blockType
   * @returns {Array<{code:number, name:string, text:string}>}
   */
  getBlockErrors(blockType) {
    const blockErrors = this.catalog.get(blockType);
    if (!blockErrors) return [];
    return Array.from(blockErrors.values());
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
