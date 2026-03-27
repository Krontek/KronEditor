/**
 * boardLibraryBlocks.js
 * Generates board-specific library blocks (GPIO, PWM, SPI, I2C, UART, ADC, CAN, PRU)
 * based on the selected board's interfaces and capabilities.
 *
 * All blocks carry EN (enable) input and ENO (enable out) output for
 * proper ladder-diagram power-flow, matching the HAL C structs in kronhal.h.
 */
import { getBoardById } from './boardDefinitions';

const GENERIC_COMM_INTERFACES = new Set(['I2C', 'SPI', 'UART']);
const isPicoBoard = (boardId) => boardId?.startsWith('rpi_pico');

// ─── Channel counts per board family / board ─────────────────────────────────

const BOARD_CHANNELS = {
  // Raspberry Pi (full-size boards)
  rpi_5:        { PWM: 4, SPI: 2, I2C: 2, UART: 5 },
  rpi_4b:       { PWM: 4, SPI: 2, I2C: 2, UART: 5 },
  rpi_3b_plus:  { PWM: 2, SPI: 2, I2C: 1, UART: 1 },
  rpi_3b:       { PWM: 2, SPI: 2, I2C: 1, UART: 1 },
  rpi_zero_2w:  { PWM: 2, SPI: 2, I2C: 1, UART: 1 },
  // Raspberry Pi Pico
  rpi_pico:     { PWM: 8, SPI: 2, I2C: 2, UART: 2, ADC: 3 },
  rpi_pico_w:   { PWM: 8, SPI: 2, I2C: 2, UART: 2, ADC: 3 },
  // BeagleBone
  bb_black:          { PWM: 3, SPI: 2, I2C: 3, UART: 5, ADC: 7, CAN: 2, PRU: 2 },
  bb_black_wireless: { PWM: 3, SPI: 2, I2C: 3, UART: 5, ADC: 7, CAN: 2, PRU: 2 },
  bb_green:          { PWM: 3, SPI: 2, I2C: 3, UART: 5, ADC: 7, CAN: 2, PRU: 2 },
  bb_green_wireless: { PWM: 3, SPI: 2, I2C: 3, UART: 5, ADC: 7, CAN: 2, PRU: 2 },
  bb_ai:             { PWM: 4, SPI: 4, I2C: 4, UART: 6, ADC: 7, CAN: 2, PRU: 4 },
  bb_ai64:           { PWM: 4, SPI: 4, I2C: 4, UART: 6, ADC: 7, CAN: 2, PRU: 4 },
  // NVIDIA Jetson — all models have 40-pin header with GPIO/I2C/SPI/UART/CAN
  jetson_nano:       { PWM: 2, SPI: 1, I2C: 2, UART: 4, CAN: 1 },
  jetson_tx2:        { PWM: 2, SPI: 1, I2C: 2, UART: 4, CAN: 1 },
  jetson_xavier_nx:  { PWM: 2, SPI: 1, I2C: 2, UART: 4, CAN: 1 },
  jetson_agx_xavier: { PWM: 2, SPI: 1, I2C: 2, UART: 4, CAN: 2 },
  jetson_orin_nano:  { PWM: 2, SPI: 1, I2C: 2, UART: 4, CAN: 1 },
  jetson_orin_nx:    { PWM: 2, SPI: 1, I2C: 2, UART: 4, CAN: 1 },
  jetson_agx_orin:   { PWM: 2, SPI: 1, I2C: 2, UART: 4, CAN: 2 },
};

// ─── Block templates per interface ──────────────────────────────────────────

const INTERFACE_BLOCKS = {
  GPIO: {
    title: 'GPIO',
    blocks: [
      {
        blockType: 'GPIO_Read',
        label: 'GPIO_Read',
        desc: 'Read digital value from a GPIO pin',
        inputs: [
          { name: 'PIN', type: 'INT', default: '0' },
          { name: 'EN', type: 'BOOL', default: 'TRUE' },
        ],
        outputs: [
          { name: 'ENO', type: 'BOOL' },
          { name: 'VALUE', type: 'BOOL' },
        ],
        class: 'FunctionBlock',
      },
      {
        blockType: 'GPIO_Write',
        label: 'GPIO_Write',
        desc: 'Write digital value to a GPIO pin',
        inputs: [
          { name: 'PIN', type: 'INT', default: '0' },
          { name: 'VALUE', type: 'BOOL', default: 'FALSE' },
          { name: 'EN', type: 'BOOL', default: 'TRUE' },
        ],
        outputs: [
          { name: 'ENO', type: 'BOOL' },
          { name: 'OK', type: 'BOOL' },
        ],
        class: 'FunctionBlock',
      },
      {
        blockType: 'GPIO_SetMode',
        label: 'GPIO_SetMode',
        desc: 'Configure GPIO pin as INPUT or OUTPUT',
        inputs: [
          { name: 'PIN', type: 'INT', default: '0' },
          { name: 'MODE', type: 'INT', default: '0' },
          { name: 'EN', type: 'BOOL', default: 'TRUE' },
        ],
        outputs: [
          { name: 'ENO', type: 'BOOL' },
          { name: 'OK', type: 'BOOL' },
        ],
        class: 'FunctionBlock',
      },
    ],
  },

  PWM: {
    title: 'PWM',
    channelBlocks: (count) => {
      const blocks = [];
      for (let i = 0; i < count; i++) {
        blocks.push({
          blockType: `PWM${i}`,
          label: `PWM${i}`,
          desc: `PWM Channel ${i} – Set duty cycle and frequency`,
          inputs: [
            { name: 'DUTY', type: 'REAL', default: '0.0' },
            { name: 'FREQ', type: 'REAL', default: '1000.0' },
            { name: 'EN', type: 'BOOL', default: 'TRUE' },
          ],
          outputs: [
            { name: 'ENO', type: 'BOOL' },
            { name: 'ACTIVE', type: 'BOOL' },
          ],
          class: 'FunctionBlock',
        });
      }
      return blocks;
    },
  },

  SPI: {
    title: 'SPI',
    channelBlocks: (count) => {
      const blocks = [];
      for (let i = 0; i < count; i++) {
        blocks.push({
          blockType: `SPI${i}_Transfer`,
          label: `SPI${i}_Transfer`,
          desc: `SPI${i} – Full-duplex data transfer`,
          inputs: [
            { name: 'TX_DATA', type: 'BYTE', default: '0' },
            { name: 'CS', type: 'INT', default: '0' },
            { name: 'CLK_HZ', type: 'DINT', default: '1000000' },
            { name: 'EN', type: 'BOOL', default: 'TRUE' },
          ],
          outputs: [
            { name: 'ENO', type: 'BOOL' },
            { name: 'RX_DATA', type: 'BYTE' },
            { name: 'DONE', type: 'BOOL' },
          ],
          class: 'FunctionBlock',
        });
      }
      return blocks;
    },
  },

  I2C: {
    title: 'I2C',
    channelBlocks: (count) => {
      const blocks = [];
      for (let i = 0; i < count; i++) {
        blocks.push(
          {
            blockType: `I2C${i}_Read`,
            label: `I2C${i}_Read`,
            desc: `I2C${i} – Read data from slave device`,
            inputs: [
              { name: 'ADDR', type: 'BYTE', default: '0' },
              { name: 'REG', type: 'BYTE', default: '0' },
              { name: 'LEN', type: 'INT', default: '1' },
              { name: 'EN', type: 'BOOL', default: 'TRUE' },
            ],
            outputs: [
              { name: 'ENO', type: 'BOOL' },
              { name: 'DATA', type: 'BYTE' },
              { name: 'OK', type: 'BOOL' },
            ],
            class: 'FunctionBlock',
          },
          {
            blockType: `I2C${i}_Write`,
            label: `I2C${i}_Write`,
            desc: `I2C${i} – Write data to slave device`,
            inputs: [
              { name: 'ADDR', type: 'BYTE', default: '0' },
              { name: 'REG', type: 'BYTE', default: '0' },
              { name: 'DATA', type: 'BYTE', default: '0' },
              { name: 'EN', type: 'BOOL', default: 'TRUE' },
            ],
            outputs: [
              { name: 'ENO', type: 'BOOL' },
              { name: 'OK', type: 'BOOL' },
            ],
            class: 'FunctionBlock',
          }
        );
      }
      return blocks;
    },
  },

  UART: {
    title: 'UART',
    channelBlocks: (count) => {
      const blocks = [];
      for (let i = 0; i < count; i++) {
        blocks.push(
          {
            blockType: `UART${i}_Send`,
            label: `UART${i}_Send`,
            desc: `UART${i} – Send data`,
            inputs: [
              { name: 'DATA', type: 'BYTE', default: '0' },
              { name: 'BAUD', type: 'DINT', default: '9600' },
              { name: 'EN', type: 'BOOL', default: 'TRUE' },
            ],
            outputs: [
              { name: 'ENO', type: 'BOOL' },
              { name: 'DONE', type: 'BOOL' },
            ],
            class: 'FunctionBlock',
          },
          {
            blockType: `UART${i}_Receive`,
            label: `UART${i}_Receive`,
            desc: `UART${i} – Receive data`,
            inputs: [
              { name: 'BAUD', type: 'DINT', default: '9600' },
              { name: 'TIMEOUT', type: 'INT', default: '100' },
              { name: 'EN', type: 'BOOL', default: 'TRUE' },
            ],
            outputs: [
              { name: 'ENO', type: 'BOOL' },
              { name: 'DATA', type: 'BYTE' },
              { name: 'READY', type: 'BOOL' },
            ],
            class: 'FunctionBlock',
          },
        );
      }
      return blocks;
    },
  },

  ADC: {
    title: 'ADC',
    channelBlocks: (count) => {
      const blocks = [];
      for (let i = 0; i < count; i++) {
        blocks.push({
          blockType: `ADC${i}_Read`,
          label: `ADC${i}_Read`,
          desc: `ADC Channel ${i} – Read analog value`,
          inputs: [
            { name: 'TRIGGER', type: 'BOOL', default: 'TRUE' },
            { name: 'EN', type: 'BOOL', default: 'TRUE' },
          ],
          outputs: [
            { name: 'ENO', type: 'BOOL' },
            { name: 'VALUE', type: 'INT' },
            { name: 'VOLTAGE', type: 'REAL' },
          ],
          class: 'FunctionBlock',
        });
      }
      return blocks;
    },
  },

  CAN: {
    title: 'CAN',
    channelBlocks: (count) => {
      const blocks = [];
      for (let i = 0; i < count; i++) {
        blocks.push(
          {
            blockType: `CAN${i}_Send`,
            label: `CAN${i}_Send`,
            desc: `CAN${i} – Send CAN frame`,
            inputs: [
              { name: 'ID', type: 'DINT', default: '0' },
              { name: 'DATA', type: 'BYTE', default: '0' },
              { name: 'DLC', type: 'INT', default: '8' },
              { name: 'EN', type: 'BOOL', default: 'TRUE' },
            ],
            outputs: [
              { name: 'ENO', type: 'BOOL' },
              { name: 'DONE', type: 'BOOL' },
            ],
            class: 'FunctionBlock',
          },
          {
            blockType: `CAN${i}_Receive`,
            label: `CAN${i}_Receive`,
            desc: `CAN${i} – Receive CAN frame`,
            inputs: [
              { name: 'FILTER_ID', type: 'DINT', default: '0' },
              { name: 'EN', type: 'BOOL', default: 'TRUE' },
            ],
            outputs: [
              { name: 'ENO', type: 'BOOL' },
              { name: 'ID', type: 'DINT' },
              { name: 'DATA', type: 'BYTE' },
              { name: 'READY', type: 'BOOL' },
            ],
            class: 'FunctionBlock',
          }
        );
      }
      return blocks;
    },
  },

  PRU: {
    title: 'PRU',
    channelBlocks: (count) => {
      const blocks = [];
      for (let i = 0; i < count; i++) {
        blocks.push({
          blockType: `PRU${i}_Execute`,
          label: `PRU${i}_Execute`,
          desc: `PRU${i} – Execute real-time routine on PRU core`,
          inputs: [
            { name: 'CMD', type: 'INT', default: '0' },
            { name: 'PARAM', type: 'DINT', default: '0' },
            { name: 'EN', type: 'BOOL', default: 'TRUE' },
          ],
          outputs: [
            { name: 'ENO', type: 'BOOL' },
            { name: 'RESULT', type: 'DINT' },
            { name: 'DONE', type: 'BOOL' },
          ],
          class: 'FunctionBlock',
        });
      }
      return blocks;
    },
  },

  PCM: {
    title: 'PCM',
    blocks: [
      {
        blockType: 'PCM_Output',
        label: 'PCM_Output',
        desc: 'PCM audio data output',
        inputs: [
          { name: 'DATA', type: 'INT', default: '0' },
          { name: 'RATE', type: 'DINT', default: '44100' },
          { name: 'EN', type: 'BOOL', default: 'TRUE' },
        ],
        outputs: [
          { name: 'ENO', type: 'BOOL' },
          { name: 'OK', type: 'BOOL' },
        ],
        class: 'FunctionBlock',
      },
      {
        blockType: 'PCM_Input',
        label: 'PCM_Input',
        desc: 'PCM audio data input',
        inputs: [
          { name: 'RATE', type: 'DINT', default: '44100' },
          { name: 'EN', type: 'BOOL', default: 'TRUE' },
        ],
        outputs: [
          { name: 'ENO', type: 'BOOL' },
          { name: 'DATA', type: 'INT' },
          { name: 'READY', type: 'BOOL' },
        ],
        class: 'FunctionBlock',
      },
    ],
  },

  DI: {
    title: 'Digital Input',
    channelBlocks: (count) => {
      const blocks = [];
      for (let i = 0; i < count; i++) {
        blocks.push({
          blockType: `DI${i}_Read`,
          label: `DI${i}_Read`,
          desc: `Digital Input Channel ${i} – Read isolated digital input`,
          inputs: [
            { name: 'EN', type: 'BOOL', default: 'TRUE' },
          ],
          outputs: [
            { name: 'ENO', type: 'BOOL' },
            { name: 'VALUE', type: 'BOOL' },
          ],
          class: 'FunctionBlock',
        });
      }
      return blocks;
    },
  },

  DO: {
    title: 'Digital Output',
    channelBlocks: (count) => {
      const blocks = [];
      for (let i = 0; i < count; i++) {
        blocks.push({
          blockType: `DO${i}_Write`,
          label: `DO${i}_Write`,
          desc: `Digital Output Channel ${i} – Write isolated digital output`,
          inputs: [
            { name: 'VALUE', type: 'BOOL', default: 'FALSE' },
            { name: 'EN', type: 'BOOL', default: 'TRUE' },
          ],
          outputs: [
            { name: 'ENO', type: 'BOOL' },
            { name: 'OK', type: 'BOOL' },
          ],
          class: 'FunctionBlock',
        });
      }
      return blocks;
    },
  },

  Grove: {
    title: 'Grove',
    blocks: [
      {
        blockType: 'Grove_DigitalRead',
        label: 'Grove_DigitalRead',
        desc: 'Read from Grove digital connector',
        inputs: [
          { name: 'PORT', type: 'INT', default: '0' },
          { name: 'EN', type: 'BOOL', default: 'TRUE' },
        ],
        outputs: [
          { name: 'ENO', type: 'BOOL' },
          { name: 'VALUE', type: 'BOOL' },
        ],
        class: 'FunctionBlock',
      },
      {
        blockType: 'Grove_DigitalWrite',
        label: 'Grove_DigitalWrite',
        desc: 'Write to Grove digital connector',
        inputs: [
          { name: 'PORT', type: 'INT', default: '0' },
          { name: 'VALUE', type: 'BOOL', default: 'FALSE' },
          { name: 'EN', type: 'BOOL', default: 'TRUE' },
        ],
        outputs: [
          { name: 'ENO', type: 'BOOL' },
          { name: 'OK', type: 'BOOL' },
        ],
        class: 'FunctionBlock',
      },
      {
        blockType: 'Grove_AnalogRead',
        label: 'Grove_AnalogRead',
        desc: 'Read from Grove analog connector',
        inputs: [
          { name: 'PORT', type: 'INT', default: '0' },
          { name: 'EN', type: 'BOOL', default: 'TRUE' },
        ],
        outputs: [
          { name: 'ENO', type: 'BOOL' },
          { name: 'VALUE', type: 'INT' },
          { name: 'VOLTAGE', type: 'REAL' },
        ],
        class: 'FunctionBlock',
      },
    ],
  },
};

// ─── Main generator function ─────────────────────────────────────────────────

/**
 * Generate a library tree (array of subcategory objects) for the Board tab
 * based on the selected boardId.
 *
 * Returns an array like:
 *   [{ id: 'board_gpio', title: 'GPIO', items: [...] }, ...]
 *
 * Each item has: { blockType, label, desc, customData: { inputs, outputs, class } }
 */
export const getBoardLibraryTree = (boardId) => {
  if (!boardId) return [];

  const board = getBoardById(boardId);
  if (!board) return [];

  const channels = BOARD_CHANNELS[boardId] || {};
  const interfaces = board.interfaces || [];

  const subcategories = [];

  for (const iface of interfaces) {
    if (GENERIC_COMM_INTERFACES.has(iface) && !isPicoBoard(boardId)) {
      continue;
    }

    const template = INTERFACE_BLOCKS[iface];
    if (!template) continue;

    let rawBlocks = [];

    // Static blocks (e.g., GPIO, PCM, Grove)
    if (template.blocks) {
      rawBlocks = [...template.blocks];
    }

    // Channel-based blocks (e.g., PWM0, PWM1, SPI0_Transfer...)
    if (template.channelBlocks) {
      const count = channels[iface] || 1;
      rawBlocks = [...rawBlocks, ...template.channelBlocks(count)];
    }

    if (rawBlocks.length === 0) continue;

    subcategories.push({
      id: `board_${iface.toLowerCase()}`,
      title: template.title,
      items: rawBlocks.map(b => ({
        blockType: b.blockType,
        label: b.label,
        desc: b.desc,
        customData: {
          inputs: b.inputs || [],
          outputs: b.outputs || [],
          class: b.class || 'FunctionBlock',
          desc: b.desc,
        },
      })),
    });
  }

  return subcategories;
};
