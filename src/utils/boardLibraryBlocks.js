/**
 * boardLibraryBlocks.js
 * Generates board-specific library blocks (GPIO, PWM, SPI, I2C, UART, ADC, CAN, PRU)
 * based on the selected board's interfaces and capabilities.
 *
 * All blocks carry EN (enable) input and ENO (enable out) output for
 * proper ladder-diagram power-flow, matching the HAL C structs in kronhal.h.
 */
import { getBoardById } from './boardDefinitions';

const GENERIC_COMM_INTERFACES = new Set(['I2C', 'SPI', 'UART', 'USB']);
// ─── Channel counts per board family / board ─────────────────────────────────

const BOARD_CHANNELS = {
  // Raspberry Pi (full-size boards)
  // Pi 5 (RP1) has 4 physical PWM lines but only 2 routable channels —
  // each channel (PWM0 / PWM1) drives exactly one GPIO at a time.
  rpi_5:        { PWM: 2, SPI: 2, I2C: 2, UART: 5, USB: 4 },
  // Pi 4 / BCM2711: 2 PWM channels (PWM0 on GPIO12/18, PWM1 on GPIO13/19),
  // mutually exclusive per channel.
  rpi_4b:       { PWM: 2, SPI: 2, I2C: 2, UART: 5, USB: 4 },
  rpi_3b_plus:  { PWM: 2, SPI: 2, I2C: 1, UART: 1, USB: 4 },
  rpi_3b:       { PWM: 2, SPI: 2, I2C: 1, UART: 1, USB: 4 },
  rpi_zero_2w:  { PWM: 2, SPI: 2, I2C: 1, UART: 1, USB: 1 },
  // BeagleBone
  bb_black:          { PWM: 3, SPI: 2, I2C: 3, UART: 5, ADC: 7, CAN: 2, PRU: 2 },
  bb_black_wireless: { PWM: 3, SPI: 2, I2C: 3, UART: 5, ADC: 7, CAN: 2, PRU: 2 },
  bb_green:          { PWM: 3, SPI: 2, I2C: 3, UART: 5, ADC: 7, CAN: 2, PRU: 2 },
  bb_green_wireless: { PWM: 3, SPI: 2, I2C: 3, UART: 5, ADC: 7, CAN: 2, PRU: 2 },
  bb_ai:             { PWM: 4, SPI: 4, I2C: 4, UART: 6, ADC: 7, CAN: 2, PRU: 4 },
  bb_ai64:           { PWM: 4, SPI: 4, I2C: 4, UART: 6, ADC: 7, CAN: 2, PRU: 4 },
  // NVIDIA Jetson — all models have 40-pin header with GPIO/I2C/SPI/UART/CAN
  // Jetson Nano (T210) has NO on-chip CAN controller — MCP2515 HATs ride SPI.
  jetson_nano:       { PWM: 2, SPI: 1, I2C: 2, UART: 4, USB: 4 },
  jetson_tx2:        { PWM: 2, SPI: 1, I2C: 2, UART: 4, CAN: 2, USB: 4 },
  jetson_xavier_nx:  { PWM: 2, SPI: 1, I2C: 2, UART: 4, CAN: 1, USB: 4 },
  jetson_agx_xavier: { PWM: 2, SPI: 1, I2C: 2, UART: 4, CAN: 2, USB: 3 },
  jetson_orin_nano:  { PWM: 3, SPI: 1, I2C: 2, UART: 4, CAN: 1, USB: 5 },
  jetson_orin_nx:    { PWM: 3, SPI: 1, I2C: 2, UART: 4, CAN: 1, USB: 5 },
  jetson_agx_orin:   { PWM: 3, SPI: 1, I2C: 2, UART: 4, CAN: 2, USB: 5 },
  // Orange Pi — RK3588S/RK3588 expose many UART/I2C/SPI controllers; counts
  // reflect what is practically reachable on the 40-pin header.
  // RK3588S: can0-m0 + can1-m0 device-tree overlays expose both on the 26-pin header.
  opi_5:             { PWM: 4, SPI: 2, I2C: 3, UART: 4, CAN: 2, USB: 4 },
  opi_5_plus:        { PWM: 4, SPI: 2, I2C: 3, UART: 4, CAN: 1, USB: 5 },
  opi_zero_2w:       { PWM: 2, SPI: 1, I2C: 2, UART: 3, USB: 1 },
  // Radxa
  // RK3588: can1-m1 overlay exposes CAN on the 40-pin header (netdev becomes can0).
  radxa_rock_5b:     { PWM: 4, SPI: 2, I2C: 4, UART: 4, CAN: 1, USB: 5 },
  radxa_rock_3a:     { PWM: 3, SPI: 2, I2C: 3, UART: 4, USB: 4 },
  radxa_zero_3w:     { PWM: 2, SPI: 1, I2C: 2, UART: 3, USB: 2 },
  // Odroid (Amlogic)
  // ODROID-C4 J2 header exposes TWO analog inputs (Expansion Connectors doc,
  // board rev 1.0): pin 40 = ADC.AIN0, pin 37 = ADC.AIN2, ref pin 38 = 1.8 V.
  // The channel number IS the IIO index, so ADC0/ADC2 are the wired ones —
  // AIN1 is not routed to the header (count is 3 only to reach AIN2).
  // ⚠️ 1.8 V ceiling, NOT 3.3 V like the digital pins — a 3.3 V signal damages it.
  // PWM: the J2 header carries PWM_A..PWM_F — six outputs, from the S905X3's
  // three 2-channel cells (PWM_AB / PWM_CD / PWM_EF). The HAL flattens
  // pwmchips in ascending index, so PWM0..PWM5 land on A,B,C,D,E,F in order;
  // a cell the device tree has not enabled simply reports ERR_ID.
  odroid_c4:         { PWM: 6, SPI: 1, I2C: 2, UART: 2, ADC: 3, USB: 4 },
  odroid_n2_plus:    { PWM: 2, SPI: 1, I2C: 2, UART: 2, USB: 4 },
  // Banana Pi (Amlogic)
  bpi_m5:            { PWM: 2, SPI: 1, I2C: 2, UART: 2, USB: 4 },
  // Libre Computer (Amlogic)
  libre_le_potato:   { PWM: 2, SPI: 1, I2C: 2, UART: 2, USB: 4 },
  // Pine64 (Rockchip)
  // ROCK64 Pi-2 connector (Port V3 definition) carries no analog input at all —
  // all 40 pins are GPIO/I2C/SPI/UART/I2S. Deliberately no ADC key.
  pine_rock64:       { PWM: 2, SPI: 1, I2C: 2, UART: 2, USB: 3 },
  pine_rockpro64:    { PWM: 2, SPI: 2, I2C: 4, UART: 4, USB: 4 },
};

// ─── Block templates per interface ──────────────────────────────────────────

const INTERFACE_BLOCKS = {
  GPIO: {
    title: 'GPIO',
    blocks: [
      {
        blockType: 'GPIO_Read',
        label: 'GPIO_Read',
        desc: 'Read digital value from a GPIO pin (PIN = physical header pin, e.g. 11 = Pi GPIO17)',
        inputs: [
          { name: 'PIN', type: 'INT', default: '11' },
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
        desc: 'Write digital value to a GPIO pin (PIN = physical header pin, e.g. 11 = Pi GPIO17)',
        inputs: [
          { name: 'PIN', type: 'INT', default: '11' },
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
        desc: 'Configure GPIO pin as INPUT (MODE=0) or OUTPUT (MODE=1). PIN = physical header pin',
        inputs: [
          { name: 'PIN', type: 'INT', default: '11' },
          { name: 'MODE', type: 'INT', default: '1' },
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
          desc: `PWM Channel ${i} – FREQ: Hz (e.g. 1000.0 = 1 kHz, 50.0 = servo), DUTY: % (0.0–100.0)`,
          inputs: [
            { name: 'DUTY', type: 'REAL', default: '0.0',    desc: 'Duty cycle (0.0–100.0 %)' },
            { name: 'FREQ', type: 'REAL', default: '1000.0', desc: 'Frequency in Hz (e.g. 1000.0 = 1 kHz)' },
            { name: 'EN',   type: 'BOOL', default: 'TRUE' },
          ],
          outputs: [
            { name: 'ENO',    type: 'BOOL' },
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
          },
          {
            blockType: `I2C${i}_BurstRead`,
            label: `I2C${i}_BurstRead`,
            desc: `I2C${i} – Burst-read multiple bytes from slave device into buffer`,
            inputs: [
              { name: 'ADDR', type: 'BYTE', default: '0' },
              { name: 'REG', type: 'BYTE', default: '0' },
              { name: 'LEN', type: 'UINT', default: '1' },
              { name: 'BUFFER', type: 'POINTER', default: '0' },
              { name: 'EN', type: 'BOOL', default: 'TRUE' },
            ],
            outputs: [
              { name: 'ENO', type: 'BOOL' },
              { name: 'OK', type: 'BOOL' },
              { name: 'ERR_ID', type: 'BYTE' },
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

  USB: {
    title: 'USB Serial',
    channelBlocks: (count) => {
      const blocks = [];
      for (let i = 0; i < count; i++) {
        blocks.push(
          {
            blockType: `USB${i}_Send`,
            label: `USB${i}_Send`,
            desc: `USB${i} – Send serial data over USB`,
            inputs: [
              { name: 'DATA', type: 'BYTE', default: '0' },
              { name: 'BAUD', type: 'DINT', default: '115200' },
              { name: 'EN', type: 'BOOL', default: 'TRUE' },
            ],
            outputs: [
              { name: 'ENO', type: 'BOOL' },
              { name: 'DONE', type: 'BOOL' },
            ],
            class: 'FunctionBlock',
          },
          {
            blockType: `USB${i}_Receive`,
            label: `USB${i}_Receive`,
            desc: `USB${i} – Receive serial data over USB`,
            inputs: [
              { name: 'BAUD', type: 'DINT', default: '115200' },
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
    if (GENERIC_COMM_INTERFACES.has(iface)) {
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
