/**
 * hwPortVars.js
 *
 * Generates read-only system variables for each enabled hardware interface port.
 * These variables are STRING-typed, hold the Linux device path, and serve as
 * named constants in the FB editor (e.g. UART_0_PORT → "/dev/ttyAMA0").
 *
 * The numeric port ID (portNum) is used by the transpiler when the variable
 * name is referenced in a Port_ID input.
 */

import { resolveDevicePath, getPortNumericId } from './devicePortMapping';

/**
 * Build system HW port variables from the current interface config.
 *
 * @param {object} interfaceConfig  { I2C: { I2C_1: { enabled, ... } }, UART: {...}, SPI: {...} }
 * @param {string} boardFamilyDefine  HAL board family (e.g. 'HAL_BOARD_FAMILY_RPI')
 * @returns {{ name, type, value, portId, portNum, protocol, system, comment }[]}
 */
export const buildHardwarePortVars = (interfaceConfig, boardFamilyDefine) => {
  if (!interfaceConfig) return [];

  const vars = [];

  for (const protocol of ['I2C', 'SPI', 'UART']) {
    const ports = interfaceConfig[protocol];
    if (!ports) continue;

    for (const [portId, cfg] of Object.entries(ports)) {
      if (!cfg?.enabled) continue;

      const devPath =
        (boardFamilyDefine
          ? resolveDevicePath(boardFamilyDefine, protocol, portId)
          : null) || portId;

      const portNum = getPortNumericId(portId);

      // "UART_0" → "UART0_PORT", "I2C_1" → "I2C1_PORT", "SPI_0_CE0" → "SPI0_CE0_PORT"
      const parts = portId.split('_');
      const varName = parts[0] + parts[1] + (parts.length > 2 ? '_' + parts.slice(2).join('_') : '') + '_PORT';

      vars.push({
        name: varName,
        type: 'STRING',
        value: devPath,
        portId,
        portNum,
        protocol,
        system: true,
        comment: `${protocol} ${portId} — ${devPath}`,
      });
    }
  }

  return vars;
};

/**
 * Return only the HW port vars that are relevant to a given block type.
 *   UART_Send / UART_Receive  →  UART vars
 *   I2C_WriteRead             →  I2C vars
 *   SPI_Transfer              →  SPI vars
 *   anything else             →  all vars
 */
export const getRelevantPortVars = (blockType, hwPortVars) => {
  if (!hwPortVars?.length) return [];
  if (!blockType) return hwPortVars;

  const upper = blockType.toUpperCase();
  if (upper.includes('I2C'))  return hwPortVars.filter(v => v.protocol === 'I2C');
  if (upper.includes('SPI'))  return hwPortVars.filter(v => v.protocol === 'SPI');
  if (upper.includes('UART')) return hwPortVars.filter(v => v.protocol === 'UART');
  return hwPortVars;
};
