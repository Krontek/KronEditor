/**
 * deviceCatalog.js
 * Built-in device templates for the Device Builder panel.
 * Catalog devices have pre-filled register maps and init sequences.
 * Custom devices (templateId: 'custom') are user-defined via the wizard.
 */

// Protocol constants used throughout the device system
export const DEVICE_PROTOCOLS = ['I2C', 'SPI', 'UART'];

// IEC 61131-3 types available for output fields
export const FIELD_TYPES = ['BOOL', 'BYTE', 'INT', 'DINT', 'REAL', 'LREAL', 'WORD', 'DWORD'];

// Encoding options for binary field decoding
export const FIELD_ENCODINGS = [
  { id: 'UINT8',     label: 'Unsigned 8-bit' },
  { id: 'INT8',      label: 'Signed 8-bit' },
  { id: 'UINT16_BE', label: 'Unsigned 16-bit Big-Endian' },
  { id: 'UINT16_LE', label: 'Unsigned 16-bit Little-Endian' },
  { id: 'INT16_BE',  label: 'Signed 16-bit Big-Endian' },
  { id: 'INT16_LE',  label: 'Signed 16-bit Little-Endian' },
  { id: 'UINT32_BE', label: 'Unsigned 32-bit Big-Endian' },
  { id: 'INT32_BE',  label: 'Signed 32-bit Big-Endian' },
  { id: 'FLOAT32_BE', label: 'Float 32-bit Big-Endian' },
  { id: 'BOOL',      label: 'Boolean (non-zero = true)' },
  { id: 'ASCII_FLOAT', label: 'ASCII decimal float string' },
  { id: 'ASCII_INT',   label: 'ASCII decimal integer string' },
];

export const DEVICE_CATALOG = [
  /* ─── I2C Sensors ─────────────────────────────────────────────────────── */
  {
    id: 'MPU9250',
    displayName: 'MPU-9250 9-Axis IMU',
    manufacturer: 'InvenSense / TDK',
    category: 'Motion',
    protocol: 'I2C',
    defaultAddress: 0x68,
    altAddresses: [0x68, 0x69],
    defaultClockHz: 400000,
    description: '3-axis accelerometer + gyroscope. Outputs in physical units (g and deg/s).',
    outputs: [
      { name: 'AccX',  type: 'REAL', desc: 'Acceleration X [g]' },
      { name: 'AccY',  type: 'REAL', desc: 'Acceleration Y [g]' },
      { name: 'AccZ',  type: 'REAL', desc: 'Acceleration Z [g]' },
      { name: 'GyroX', type: 'REAL', desc: 'Angular velocity X [deg/s]' },
      { name: 'GyroY', type: 'REAL', desc: 'Angular velocity Y [deg/s]' },
      { name: 'GyroZ', type: 'REAL', desc: 'Angular velocity Z [deg/s]' },
      { name: 'Temp',  type: 'REAL', desc: 'Die temperature [°C]' },
    ],
    // Generic register pipeline — no specialGenerator needed
    defaultConfig: {
      address: 0x68,
      clockHz: 400000,
      initSequence: [
        { regAddr: 0x6B, data: [0x00] },  // PWR_MGMT_1: clear sleep bit
        { regAddr: 0x1B, data: [0x00] },  // GYRO_CONFIG: ±250 deg/s FSR
        { regAddr: 0x1C, data: [0x00] },  // ACCEL_CONFIG: ±2g FSR
      ],
      registers: [
        {
          name: 'ACCEL_GYRO_TEMP',
          regAddr: 0x3B,
          byteCount: 14,
          fields: [
            { name: 'AccX',  type: 'REAL', byteOffset: 0,  byteCount: 2, encoding: 'INT16_BE', scale: 1 / 16384.0, offset_val: 0 },
            { name: 'AccY',  type: 'REAL', byteOffset: 2,  byteCount: 2, encoding: 'INT16_BE', scale: 1 / 16384.0, offset_val: 0 },
            { name: 'AccZ',  type: 'REAL', byteOffset: 4,  byteCount: 2, encoding: 'INT16_BE', scale: 1 / 16384.0, offset_val: 0 },
            { name: 'Temp',  type: 'REAL', byteOffset: 6,  byteCount: 2, encoding: 'INT16_BE', scale: 1 / 340.0,   offset_val: 36.53 },
            { name: 'GyroX', type: 'REAL', byteOffset: 8,  byteCount: 2, encoding: 'INT16_BE', scale: 1 / 131.0,   offset_val: 0 },
            { name: 'GyroY', type: 'REAL', byteOffset: 10, byteCount: 2, encoding: 'INT16_BE', scale: 1 / 131.0,   offset_val: 0 },
            { name: 'GyroZ', type: 'REAL', byteOffset: 12, byteCount: 2, encoding: 'INT16_BE', scale: 1 / 131.0,   offset_val: 0 },
          ],
        },
      ],
    },
  },
  {
    id: 'BME280',
    displayName: 'BME280 Environmental Sensor',
    manufacturer: 'Bosch Sensortec',
    category: 'Environment',
    protocol: 'I2C',
    defaultAddress: 0x76,
    altAddresses: [0x76, 0x77],
    defaultClockHz: 400000,
    description: 'Temperature, pressure, and humidity with Bosch on-chip compensation formulas.',
    outputs: [
      { name: 'Temperature', type: 'REAL', desc: 'Temperature [°C]' },
      { name: 'Pressure',    type: 'REAL', desc: 'Pressure [hPa]' },
      { name: 'Humidity',    type: 'REAL', desc: 'Relative humidity [%RH]' },
    ],
    specialGenerator: 'BME280',
    defaultConfig: {
      address: 0x76,
      clockHz: 400000,
      initSequence: [],  // handled by specialGenerator
      registers: [],
    },
  },
  {
    id: 'ADS1115',
    displayName: 'ADS1115 16-bit ADC',
    manufacturer: 'Texas Instruments',
    category: 'Analog',
    protocol: 'I2C',
    defaultAddress: 0x48,
    altAddresses: [0x48, 0x49, 0x4A, 0x4B],
    defaultClockHz: 400000,
    description: '4-channel 16-bit ADC with programmable gain amplifier. Outputs in Volts (FSR ±4.096V, PGA=1).',
    outputs: [
      { name: 'CH0', type: 'REAL', desc: 'Channel 0 voltage [V]' },
      { name: 'CH1', type: 'REAL', desc: 'Channel 1 voltage [V]' },
      { name: 'CH2', type: 'REAL', desc: 'Channel 2 voltage [V]' },
      { name: 'CH3', type: 'REAL', desc: 'Channel 3 voltage [V]' },
    ],
    specialGenerator: 'ADS1115',
    defaultConfig: { address: 0x48, clockHz: 400000, initSequence: [], registers: [] },
  },
  {
    id: 'VL53L0X',
    displayName: 'VL53L0X Time-of-Flight Distance',
    manufacturer: 'STMicroelectronics',
    category: 'Distance',
    protocol: 'I2C',
    defaultAddress: 0x29,
    altAddresses: [0x29],
    defaultClockHz: 400000,
    description: 'Laser ToF distance sensor, up to ~2 m. Output in millimeters.',
    outputs: [
      { name: 'Distance_mm', type: 'INT', desc: 'Distance [mm]. 8190 = no target.' },
    ],
    specialGenerator: 'VL53L0X',
    defaultConfig: { address: 0x29, clockHz: 400000, initSequence: [], registers: [] },
  },
  {
    id: 'MLX90614',
    displayName: 'MLX90614 IR Thermometer',
    manufacturer: 'Melexis',
    category: 'Temperature',
    protocol: 'I2C',
    defaultAddress: 0x5A,
    altAddresses: [0x5A],
    defaultClockHz: 100000,
    description: 'Non-contact IR thermometer. Outputs ambient and object temperature in °C.',
    outputs: [
      { name: 'Ambient_C', type: 'REAL', desc: 'Ambient temperature [°C]' },
      { name: 'Object_C',  type: 'REAL', desc: 'Object surface temperature [°C]' },
    ],
    defaultConfig: {
      address: 0x5A,
      clockHz: 100000,
      initSequence: [],
      registers: [
        {
          name: 'TEMP_AMBIENT',
          regAddr: 0x06,
          byteCount: 2,
          fields: [
            { name: 'Ambient_C', type: 'REAL', byteOffset: 0, byteCount: 2, encoding: 'UINT16_LE', scale: 0.02, offset_val: -273.15 },
          ],
        },
        {
          name: 'TEMP_OBJECT',
          regAddr: 0x07,
          byteCount: 2,
          fields: [
            { name: 'Object_C', type: 'REAL', byteOffset: 0, byteCount: 2, encoding: 'UINT16_LE', scale: 0.02, offset_val: -273.15 },
          ],
        },
      ],
    },
  },
  {
    id: 'DS3231',
    displayName: 'DS3231 Precision RTC',
    manufacturer: 'Maxim Integrated',
    category: 'Time',
    protocol: 'I2C',
    defaultAddress: 0x68,
    altAddresses: [0x68],
    defaultClockHz: 400000,
    description: 'High-accuracy RTC with temperature-compensated crystal. Outputs BCD decoded to integers.',
    outputs: [
      { name: 'Second', type: 'BYTE', desc: 'Seconds (0–59)' },
      { name: 'Minute', type: 'BYTE', desc: 'Minutes (0–59)' },
      { name: 'Hour',   type: 'BYTE', desc: 'Hours (0–23, 24h mode)' },
      { name: 'Day',    type: 'BYTE', desc: 'Day of month (1–31)' },
      { name: 'Month',  type: 'BYTE', desc: 'Month (1–12)' },
      { name: 'Year',   type: 'BYTE', desc: 'Year offset from 2000 (0–99)' },
      { name: 'Temp_C', type: 'REAL', desc: 'RTC temperature [°C]' },
    ],
    specialGenerator: 'DS3231',
    defaultConfig: { address: 0x68, clockHz: 400000, initSequence: [], registers: [] },
  },
  {
    id: 'PCA9685',
    displayName: 'PCA9685 16-Ch PWM Driver',
    manufacturer: 'NXP Semiconductors',
    category: 'Actuator',
    protocol: 'I2C',
    defaultAddress: 0x40,
    altAddresses: [0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47],
    defaultClockHz: 400000,
    description: '16-channel 12-bit PWM controller. Write CH0–CH3 pulse width (0–4095) each cycle.',
    outputs: [],
    extraInputs: [
      { name: 'CH0',  type: 'INT', desc: 'Channel 0 pulse width (0–4095)' },
      { name: 'CH1',  type: 'INT', desc: 'Channel 1 pulse width (0–4095)' },
      { name: 'CH2',  type: 'INT', desc: 'Channel 2 pulse width (0–4095)' },
      { name: 'CH3',  type: 'INT', desc: 'Channel 3 pulse width (0–4095)' },
    ],
    specialGenerator: 'PCA9685',
    defaultConfig: {
      address: 0x40,
      clockHz: 400000,
      pwmFrequency: 50,
      initSequence: [],
      registers: [],
    },
  },

  /* ─── SPI Sensors ──────────────────────────────────────────────────────── */
  {
    id: 'MAX31856',
    displayName: 'MAX31856 Thermocouple Amplifier',
    manufacturer: 'Maxim Integrated',
    category: 'Temperature',
    protocol: 'SPI',
    defaultClockHz: 5000000,
    defaultMode: 1,
    description: 'Universal thermocouple-to-digital converter with cold-junction compensation.',
    outputs: [
      { name: 'Temp_C',   type: 'REAL', desc: 'Thermocouple temperature [°C]' },
      { name: 'CJTemp_C', type: 'REAL', desc: 'Cold-junction temperature [°C]' },
      { name: 'Fault',    type: 'BOOL', desc: 'Fault flag (open/short/OC)' },
    ],
    specialGenerator: 'MAX31856',
    defaultConfig: {
      clockHz: 5000000,
      mode: 1,
      bitOrder: 'MSB',
      txFrame: [],
      rxFields: [],
      initSequence: [
        { txBytes: [0x80, 0x00] },  // Write CR0: auto cold-junction, continuous
        { txBytes: [0x81, 0x03] },  // Write CR1: K-type, 4 samples averaged
      ],
    },
  },
  {
    id: 'MCP3208',
    displayName: 'MCP3208 8-Channel 12-bit ADC',
    manufacturer: 'Microchip Technology',
    category: 'Analog',
    protocol: 'SPI',
    defaultClockHz: 2000000,
    defaultMode: 0,
    description: '8-channel single-ended 12-bit SPI ADC. CH0–CH7 raw counts (0–4095).',
    outputs: [
      { name: 'CH0', type: 'INT', desc: 'Channel 0 (0–4095)' },
      { name: 'CH1', type: 'INT', desc: 'Channel 1 (0–4095)' },
      { name: 'CH2', type: 'INT', desc: 'Channel 2 (0–4095)' },
      { name: 'CH3', type: 'INT', desc: 'Channel 3 (0–4095)' },
      { name: 'CH4', type: 'INT', desc: 'Channel 4 (0–4095)' },
      { name: 'CH5', type: 'INT', desc: 'Channel 5 (0–4095)' },
      { name: 'CH6', type: 'INT', desc: 'Channel 6 (0–4095)' },
      { name: 'CH7', type: 'INT', desc: 'Channel 7 (0–4095)' },
    ],
    specialGenerator: 'MCP3208',
    defaultConfig: {
      clockHz: 2000000,
      mode: 0,
      bitOrder: 'MSB',
      txFrame: [],
      rxFields: [],
      initSequence: [],
    },
  },
];

/** Return a catalog entry by its ID. */
export const getCatalogEntry = (templateId) =>
  DEVICE_CATALOG.find((d) => d.id === templateId) || null;

/** Return all catalog entries for a given protocol. */
export const getCatalogByProtocol = (protocol) =>
  DEVICE_CATALOG.filter((d) => d.protocol === protocol);

/** Build a deep-copy of a device's default config (safe to mutate for a project instance). */
export const buildDeviceConfig = (templateId, overrides = {}) => {
  const entry = getCatalogEntry(templateId);
  if (!entry) return null;
  return { ...JSON.parse(JSON.stringify(entry.defaultConfig)), ...overrides };
};

/** Return all output field definitions for a device instance config.
 *  For generic (register-pipeline) devices, flattens all register fields.
 *  For special-generator devices, returns the catalog outputs directly.
 */
export const getOutputFields = (templateId, config) => {
  const entry = getCatalogEntry(templateId);
  if (!entry) return [];
  if (entry.specialGenerator || !config?.registers?.length) {
    return entry.outputs || [];
  }
  return (config.registers || []).flatMap((r) => r.fields || []);
};
