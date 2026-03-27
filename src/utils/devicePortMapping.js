/**
 * devicePortMapping.js
 * Maps HAL board family defines → protocol → port ID → Linux device path.
 * Used by the Device Builder UI (to show available ports) and by the
 * C code generator (to embed the correct device path string).
 *
 * Pico (HAL_BOARD_FAMILY_PICO) is intentionally omitted — device FB
 * code generation for Pico is pending toolchain support.
 */

export const BOARD_PORT_DETAILS = {
  HAL_BOARD_FAMILY_RPI: {
    I2C: {
      I2C_1: { path: '/dev/i2c-1', pins: { SDA: 'Pin 3 / GPIO2', SCL: 'Pin 5 / GPIO3' } },
      I2C_3: { path: '/dev/i2c-3', pins: { SDA: 'Overlay pin mux', SCL: 'Overlay pin mux' } },
      I2C_4: { path: '/dev/i2c-4', pins: { SDA: 'Overlay pin mux', SCL: 'Overlay pin mux' } },
      I2C_5: { path: '/dev/i2c-5', pins: { SDA: 'Overlay pin mux', SCL: 'Overlay pin mux' } },
      I2C_6: { path: '/dev/i2c-6', pins: { SDA: 'Overlay pin mux', SCL: 'Overlay pin mux' } },
    },
    SPI: {
      SPI_0_CE0: { path: '/dev/spidev0.0', pins: { MOSI: 'Pin 19 / GPIO10', MISO: 'Pin 21 / GPIO9', SCLK: 'Pin 23 / GPIO11', CS: 'Pin 24 / GPIO8' } },
      SPI_0_CE1: { path: '/dev/spidev0.1', pins: { MOSI: 'Pin 19 / GPIO10', MISO: 'Pin 21 / GPIO9', SCLK: 'Pin 23 / GPIO11', CS: 'Pin 26 / GPIO7' } },
      SPI_1_CE0: { path: '/dev/spidev1.0', pins: { MOSI: 'Pin 38 / GPIO20', MISO: 'Pin 35 / GPIO19', SCLK: 'Pin 40 / GPIO21', CS: 'Pin 36 / GPIO16' } },
    },
    UART: {
      UART_0: { path: '/dev/ttyAMA0', pins: { TX: 'Pin 8 / GPIO14', RX: 'Pin 10 / GPIO15' } },
      UART_1: { path: '/dev/ttyS0', pins: { TX: 'Mini UART TX', RX: 'Mini UART RX' } },
      UART_2: { path: '/dev/ttyAMA1', pins: { TX: 'Overlay pin mux', RX: 'Overlay pin mux' } },
      UART_3: { path: '/dev/ttyAMA2', pins: { TX: 'Overlay pin mux', RX: 'Overlay pin mux' } },
      UART_4: { path: '/dev/ttyAMA3', pins: { TX: 'Overlay pin mux', RX: 'Overlay pin mux' } },
      UART_5: { path: '/dev/ttyAMA4', pins: { TX: 'Overlay pin mux', RX: 'Overlay pin mux' } },
    },
  },

  HAL_BOARD_FAMILY_JETSON: {
    I2C: {
      I2C_0: { path: '/dev/i2c-0', pins: { SDA: 'Pin 27 / I2C0_SDA', SCL: 'Pin 28 / I2C0_SCL' } },
      I2C_1: { path: '/dev/i2c-1', pins: { SDA: 'Pin 3 / I2C_SDA', SCL: 'Pin 5 / I2C_SCL' } },
      I2C_2: { path: '/dev/i2c-2', pins: { SDA: 'Carrier specific', SCL: 'Carrier specific' } },
      I2C_3: { path: '/dev/i2c-3', pins: { SDA: 'Carrier specific', SCL: 'Carrier specific' } },
    },
    SPI: {
      SPI_0_CE0: { path: '/dev/spidev0.0', pins: { MOSI: 'Pin 19 / SPI_MOSI', MISO: 'Pin 21 / SPI_MISO', SCLK: 'Pin 23 / SPI_SCK', CS: 'Pin 24 / SPI_CS0' } },
      SPI_1_CE0: { path: '/dev/spidev1.0', pins: { MOSI: 'Carrier specific', MISO: 'Carrier specific', SCLK: 'Carrier specific', CS: 'Carrier specific' } },
    },
    UART: {
      UART_0: { path: '/dev/ttyTHS0', pins: { TX: 'Pin 8 / UART_TX', RX: 'Pin 10 / UART_RX' } },
      UART_1: { path: '/dev/ttyTHS1', pins: { TX: 'Carrier specific', RX: 'Carrier specific' } },
      UART_2: { path: '/dev/ttyTHS2', pins: { TX: 'Carrier specific', RX: 'Carrier specific' } },
      UART_3: { path: '/dev/ttyTHS3', pins: { TX: 'Carrier specific', RX: 'Carrier specific' } },
      UART_4: { path: '/dev/ttyS0', pins: { TX: 'Legacy UART TX', RX: 'Legacy UART RX' } },
      UART_5: { path: '/dev/ttyS1', pins: { TX: 'Legacy UART TX', RX: 'Legacy UART RX' } },
    },
  },

  HAL_BOARD_FAMILY_BB: {
    I2C: {
      I2C_1: { path: '/dev/i2c-1', pins: { SDA: 'P9.18 / GPIO0_4', SCL: 'P9.17 / GPIO0_5' } },
      I2C_2: { path: '/dev/i2c-2', pins: { SDA: 'P9.20 / GPIO0_12', SCL: 'P9.19 / GPIO0_13' } },
    },
    SPI: {
      SPI_1_CE0: { path: '/dev/spidev1.0', pins: { MOSI: 'P9.30 / GPIO3_16', MISO: 'P9.29 / GPIO3_15', SCLK: 'P9.31 / GPIO3_14', CS: 'P9.28 / GPIO3_17' } },
      SPI_2_CE0: { path: '/dev/spidev2.0', pins: { MOSI: 'P9 header overlay', MISO: 'P9 header overlay', SCLK: 'P9 header overlay', CS: 'P9 header overlay' } },
    },
    UART: {
      UART_1: { path: '/dev/ttyS1', pins: { TX: 'P9.24 / GPIO0_15', RX: 'P9.26 / GPIO0_14' } },
      UART_2: { path: '/dev/ttyS2', pins: { TX: 'P9.21 / GPIO0_3', RX: 'P9.22 / GPIO0_2' } },
      UART_3: { path: '/dev/ttyS3', pins: { TX: 'Overlay pin mux', RX: 'Overlay pin mux' } },
      UART_4: { path: '/dev/ttyS4', pins: { TX: 'P9.13 / GPIO0_31', RX: 'P9.11 / GPIO0_30' } },
      UART_5: { path: '/dev/ttyS5', pins: { TX: 'Overlay pin mux', RX: 'Overlay pin mux' } },
    },
  },

};

export const BOARD_PORT_MAP = Object.fromEntries(
  Object.entries(BOARD_PORT_DETAILS).map(([family, protocols]) => [
    family,
    Object.fromEntries(
      Object.entries(protocols).map(([protocol, ports]) => [
        protocol,
        Object.fromEntries(
          Object.entries(ports).map(([id, details]) => [id, details.path])
        ),
      ])
    ),
  ])
);

/** All Linux board families that support device FB code generation. */
export const LINUX_BOARD_FAMILIES = new Set([
  'HAL_BOARD_FAMILY_RPI',
  'HAL_BOARD_FAMILY_JETSON',
  'HAL_BOARD_FAMILY_BB',
]);

/**
 * Resolve the Linux device path for a given board family, protocol, and port ID.
 * Returns null if the combination is not found.
 */
export const resolveDevicePath = (boardFamilyDefine, protocol, portId) => {
  const familyMap = BOARD_PORT_MAP[boardFamilyDefine];
  if (!familyMap) return null;
  const protoMap = familyMap[protocol];
  if (!protoMap) return null;
  return protoMap[portId] || null;
};

/**
 * Return the available port IDs for a board family + protocol combination.
 * Returns an array of { id, path, label } objects for the UI dropdown.
 */
export const getPortOptions = (boardFamilyDefine, protocol) => {
  const familyMap = BOARD_PORT_DETAILS[boardFamilyDefine];
  if (!familyMap) return [];
  const protoMap = familyMap[protocol];
  if (!protoMap) return [];
  return Object.entries(protoMap).map(([id, details]) => ({
    id,
    path: details.path,
    pins: details.pins || {},
    label: `${id}  (${details.path})`,
  }));
};

/**
 * Return true if the given board family define is a Linux-based board
 * that supports device FB code generation.
 */
export const isLinuxBoardFamily = (boardFamilyDefine) =>
  LINUX_BOARD_FAMILIES.has(boardFamilyDefine);

/**
 * Given a board family and a clicked pin object ({ pin, header? }), return all
 * protocol ports whose pin map includes this physical pin.
 *
 * Handles two label formats:
 *   RPi/Jetson: "Pin 8 / GPIO14"
 *   BeagleBone: "P9.18 / GPIO0_4"  (requires pin.header)
 *
 * Returns: [{ protocol, portId, portDetails, signals: [signalName] }]
 */
export const getPinPorts = (boardFamilyDefine, pin) => {
  const familyDetails = BOARD_PORT_DETAILS[boardFamilyDefine];
  if (!familyDetails || !pin) return [];

  const results = [];

  for (const [protocol, ports] of Object.entries(familyDetails)) {
    for (const [portId, portDetails] of Object.entries(ports)) {
      for (const [signal, pinLabel] of Object.entries(portDetails.pins || {})) {
        let matches = false;

        if (pin.header) {
          // BeagleBone: match "P9.18" pattern
          const bbPattern = new RegExp(`${pin.header}\\.${pin.pin}\\b`, 'i');
          matches = bbPattern.test(pinLabel);
        } else {
          // RPi / Jetson: match "Pin 8" pattern
          const m = pinLabel.match(/Pin\s+(\d+)/i);
          if (m && parseInt(m[1]) === pin.pin) matches = true;
        }

        if (matches) {
          const existing = results.find(
            (r) => r.protocol === protocol && r.portId === portId
          );
          if (existing) {
            existing.signals.push(signal);
          } else {
            results.push({ protocol, portId, portDetails, signals: [signal] });
          }
        }
      }
    }
  }

  return results;
};

/**
 * Extract the primary numeric index from a portId string.
 * "I2C_1" → 1,  "UART_0" → 0,  "SPI_0_CE0" → 0
 */
export const getPortNumericId = (portId) => {
  const m = portId.match(/_(\d+)/);
  return m ? parseInt(m[1]) : 0;
};

/**
 * Derive the HAL board family define from a boardId string.
 * Mirrors the logic in CTranspilerService.js.
 */
export const getBoardFamilyDefine = (boardId) => {
  if (!boardId) return null;
  if (boardId.startsWith('rpi_pico')) return 'HAL_BOARD_FAMILY_PICO';
  if (boardId.startsWith('rpi_'))    return 'HAL_BOARD_FAMILY_RPI';
  if (boardId.startsWith('bb_'))     return 'HAL_BOARD_FAMILY_BB';
  if (boardId.startsWith('jetson_')) return 'HAL_BOARD_FAMILY_JETSON';
  return null;
};
