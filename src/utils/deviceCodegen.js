import { getCatalogEntry, getOutputFields } from './deviceCatalog';
import bme280Template from '../templates/devices/bme280.c.tpl?raw';
import vl53l0xTemplate from '../templates/devices/vl53l0x.c.tpl?raw';

const EMPTY_ARTIFACTS = {
  devices: [],
  meta: { triggerPin: {}, qOutput: {}, inputs: {}, outputs: {}, inputTypes: {}, outputTypes: {} },
  headerHelpers: '',
  headerTypedefs: '',
  headerSignatures: '',
  headerImplementations: '',
  sourceSupport: '',
  initCode: '',
  cleanupCode: '',
};

const UART_RING_SIZE = 512;
const UART_FRAME_SIZE = 256;

const mapType = (iecType) => {
  const typeMap = {
    BOOL: 'bool',
    SINT: 'int8_t',
    INT: 'int16_t',
    DINT: 'int32_t',
    LINT: 'int64_t',
    USINT: 'uint8_t',
    UINT: 'uint16_t',
    UDINT: 'uint32_t',
    ULINT: 'uint64_t',
    REAL: 'float',
    LREAL: 'double',
    BYTE: 'uint8_t',
    WORD: 'uint16_t',
    DWORD: 'uint32_t',
    LWORD: 'uint64_t',
    TIME: 'uint32_t',
    STRING: 'char*',
  };
  return typeMap[(iecType || '').toUpperCase()] || iecType;
};

const sanitizeIdentifier = (value, prefix = 'Device') => {
  const raw = String(value ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
  if (!raw) return prefix;
  return /^[A-Za-z_]/.test(raw) ? raw : `${prefix}_${raw}`;
};

const deepClone = (value) => JSON.parse(JSON.stringify(value ?? null));

const mergeConfig = (baseConfig = {}, overrideConfig = {}) => {
  const base = deepClone(baseConfig) || {};
  const override = deepClone(overrideConfig) || {};
  const merged = { ...base, ...override };
  Object.keys(base).forEach((key) => {
    if (Array.isArray(base[key])) merged[key] = deepClone(base[key]);
    else if (base[key] && typeof base[key] === 'object') merged[key] = deepClone(base[key]);
  });
  Object.entries(override).forEach(([key, value]) => {
    if (Array.isArray(value)) merged[key] = deepClone(value);
    else if (value && typeof value === 'object') merged[key] = mergeConfig(base[key], value);
    else merged[key] = value;
  });
  return merged;
};

const parseNumeric = (value, fallback = 0) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const str = String(value ?? '').trim();
  if (!str) return fallback;
  if (/^0x[0-9a-f]+$/i.test(str)) return parseInt(str, 16);
  const num = Number(str);
  return Number.isFinite(num) ? num : fallback;
};

const normalizeByte = (value) => {
  const num = parseNumeric(value, 0);
  const mod = ((num % 256) + 256) % 256;
  return mod;
};

const normalizeByteArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeByte);
};

const cInt = (value) => String(Math.trunc(parseNumeric(value, 0)));

const cHex = (value, width = 2) => `0x${normalizeByte(value).toString(16).toUpperCase().padStart(width, '0')}`;

const cFloat = (value) => {
  const num = parseNumeric(value, 0);
  if (!Number.isFinite(num)) return '0.0f';
  if (Number.isInteger(num)) return `${num}.0f`;
  return `${num}f`;
};

const cDouble = (value) => {
  const num = parseNumeric(value, 0);
  if (!Number.isFinite(num)) return '0.0';
  if (Number.isInteger(num)) return `${num}.0`;
  return `${num}`;
};

const cByteArrayLiteral = (bytes) =>
  bytes.length > 0 ? bytes.map((byte) => cHex(byte)).join(', ') : '';

const decodeCStringBytes = (value) => {
  const str = String(value ?? '');
  const bytes = [];
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '\\' && i + 1 < str.length) {
      const next = str[i + 1];
      if (next === 'r') { bytes.push(13); i += 1; continue; }
      if (next === 'n') { bytes.push(10); i += 1; continue; }
      if (next === 't') { bytes.push(9); i += 1; continue; }
      if (next === '\\') { bytes.push(92); i += 1; continue; }
    }
    bytes.push(str.charCodeAt(i) & 0xFF);
  }
  return bytes;
};

const getBoardFamilyDefine = (boardId) => {
  if (!boardId) return null;
  if (boardId.startsWith('rpi_pico')) return 'HAL_BOARD_FAMILY_PICO';
  if (boardId.startsWith('rpi_')) return 'HAL_BOARD_FAMILY_RPI';
  if (boardId.startsWith('bb_')) return 'HAL_BOARD_FAMILY_BB';
  if (boardId.startsWith('jetson_')) return 'HAL_BOARD_FAMILY_JETSON';
  return null;
};

const buildOutputFields = (templateId, config, entry, explicitOutputs = []) => {
  if (explicitOutputs.length > 0) {
    return explicitOutputs.map((field) => ({
      ...field,
      name: sanitizeIdentifier(field.name, 'OUT'),
      type: (field.type || 'REAL').toUpperCase(),
    }));
  }
  if (entry) {
    return getOutputFields(templateId, config).map((field) => ({
      ...field,
      name: sanitizeIdentifier(field.name, 'OUT'),
      type: (field.type || 'REAL').toUpperCase(),
    }));
  }
  return ((config?.registers || []).flatMap((reg) => reg.fields || [])).map((field) => ({
    ...field,
    name: sanitizeIdentifier(field.name, 'OUT'),
    type: (field.type || 'REAL').toUpperCase(),
  }));
};

const buildExtraInputs = (entry, raw) => {
  const inputs = [...(entry?.extraInputs || []), ...(raw?.extraInputs || [])];
  const seen = new Set();
  return inputs
    .map((input) => ({
      ...input,
      name: sanitizeIdentifier(input.name, 'IN'),
      type: (input.type || 'INT').toUpperCase(),
    }))
    .filter((input) => {
      if (input.name === 'EN' || seen.has(input.name)) return false;
      seen.add(input.name);
      return true;
    });
};

const collectDeviceEntries = (projectStructure, config) => {
  const pools = [
    config?.content?.deviceDefinitions,
    config?.content?.deviceTemplates,
    config?.content?.devices,
    projectStructure?.deviceDefinitions,
    projectStructure?.deviceTemplates,
    projectStructure?.devices,
    projectStructure?.hardware?.devices,
  ];
  return pools.flatMap((items) => (Array.isArray(items) ? items : [])).map((item) => deepClone(item));
};

const normalizeBinding = (raw, protocol, config) => {
  const portValue = raw.port ?? raw.portId ?? raw.channel ?? config?.port ?? config?.portId ?? config?.channel ?? 0;
  const port = protocol === 'SPI' ? parseNumeric(portValue, 0) : parseNumeric(String(portValue).match(/(\d+)/)?.[1], parseNumeric(portValue, 0));
  const binding = {
    id: sanitizeIdentifier(raw.id || raw.instanceName || raw.variableName || raw.name || raw.label || 'Binding', 'Binding'),
    instanceName: sanitizeIdentifier(raw.instanceName || raw.variableName || raw.name || raw.id || 'DeviceInst', 'DeviceInst'),
    variableName: sanitizeIdentifier(raw.variableName || raw.instanceName || raw.name || raw.id || 'DeviceInst', 'DeviceInst'),
    programName: raw.programName ? sanitizeIdentifier(raw.programName, 'Program') : null,
    port,
    portLabel: raw.portId || raw.port || raw.channel || null,
    address: parseNumeric(raw.address ?? config?.address, 0),
    clockHz: parseNumeric(raw.clockHz ?? config?.clockHz, 100000),
    mode: parseNumeric(raw.mode ?? config?.mode, 0),
    bitOrder: String(raw.bitOrder ?? config?.bitOrder ?? 'MSB').toUpperCase() === 'LSB' ? 1 : 0,
    cs: parseNumeric(raw.cs ?? raw.csPin ?? String(raw.portId || '').match(/CE(\d+)/)?.[1], 0),
    baud: parseNumeric(raw.baud ?? raw.baudRate ?? config?.baud ?? config?.baudRate, 115200),
    parity: sanitizeIdentifier(raw.parity || config?.parity || 'NONE', 'NONE').toUpperCase(),
    stopBits: parseNumeric(raw.stopBits ?? config?.stopBits, 1),
  };
  if (protocol === 'UART') {
    binding.port = parseNumeric(String(raw.portId || raw.port || raw.channel || 0).match(/(\d+)/)?.[1], binding.port);
  }
  if (protocol === 'SPI') {
    binding.port = parseNumeric(String(raw.portId || raw.port || raw.channel || 0).match(/SPI_(\d+)/)?.[1], binding.port);
  }
  return binding;
};

const normalizeDeviceDefinitions = (projectStructure, config) => {
  const grouped = new Map();
  collectDeviceEntries(projectStructure, config).forEach((raw) => {
    const templateId = raw.templateId || raw.catalogId || raw.deviceId || raw.id || null;
    const entry = templateId ? getCatalogEntry(templateId) : null;
    const mergedConfig = mergeConfig(entry?.defaultConfig || {}, raw.config || {});
    const protocol = (raw.protocol || entry?.protocol || 'I2C').toUpperCase();
    const typeName = sanitizeIdentifier(raw.blockType || raw.typeName || `FB_${templateId || raw.name || raw.id || 'Device'}`, 'FB_Device');
    const outputs = buildOutputFields(templateId, mergedConfig, entry, raw.outputs || []);
    const extraInputs = buildExtraInputs(entry, raw);
    const specialGenerator = raw.specialGenerator || entry?.specialGenerator || null;
    const seed = grouped.get(typeName) || {
      typeName,
      templateId,
      displayName: raw.displayName || entry?.displayName || raw.name || typeName,
      protocol,
      config: mergedConfig,
      outputs,
      extraInputs,
      specialGenerator,
      instances: [],
    };
    const rawInstances = Array.isArray(raw.instances) && raw.instances.length > 0 ? raw.instances : [raw];
    rawInstances.forEach((instanceRaw) => {
      seed.instances.push(normalizeBinding(instanceRaw, protocol, mergedConfig));
    });
    grouped.set(typeName, seed);
  });
  return Array.from(grouped.values());
};

const buildProgramVarIndex = (projectStructure, typeSet) => {
  const index = new Map();
  (projectStructure?.programs || []).forEach((prog) => {
    const programName = sanitizeIdentifier(prog.name || 'Program', 'Program');
    (prog.content?.variables || []).forEach((variable) => {
      const typeName = (variable.type || '').trim();
      if (!typeSet.has(typeName)) return;
      const variableName = sanitizeIdentifier(variable.name || 'Instance', 'Instance');
      const entry = {
        typeName,
        programName,
        variableName,
        cSymbol: `prog_${programName}_inst_${variableName}`,
      };
      if (!index.has(typeName)) index.set(typeName, []);
      index.get(typeName).push(entry);
    });
  });
  return index;
};

const bindInstancesToProgramVars = (devices, projectStructure) => {
  const index = buildProgramVarIndex(projectStructure, new Set(devices.map((device) => device.typeName)));
  const bound = [];
  devices.forEach((device) => {
    const vars = [...(index.get(device.typeName) || [])];
    const claimed = new Set();
    const bindings = device.instances.length > 0 ? device.instances : [{ instanceName: device.typeName, variableName: device.typeName, programName: null, port: 0, address: parseNumeric(device.config?.address, 0), clockHz: parseNumeric(device.config?.clockHz, 100000), mode: parseNumeric(device.config?.mode, 0), bitOrder: String(device.config?.bitOrder || 'MSB').toUpperCase() === 'LSB' ? 1 : 0, cs: parseNumeric(device.config?.cs, 0), baud: parseNumeric(device.config?.baud ?? device.config?.baudRate, 115200), parity: sanitizeIdentifier(device.config?.parity || 'NONE', 'NONE').toUpperCase(), stopBits: parseNumeric(device.config?.stopBits, 1) }];
    bindings.forEach((binding) => {
      let match = null;
      if (binding.programName) {
        match = vars.find((candidate) =>
          !claimed.has(candidate.cSymbol) &&
          candidate.programName === binding.programName &&
          (candidate.variableName === binding.variableName || candidate.variableName === binding.instanceName));
      }
      if (!match) {
        const sameName = vars.filter((candidate) =>
          !claimed.has(candidate.cSymbol) &&
          (candidate.variableName === binding.variableName || candidate.variableName === binding.instanceName));
        if (sameName.length === 1) match = sameName[0];
      }
      if (!match && vars.length - claimed.size === 1) {
        match = vars.find((candidate) => !claimed.has(candidate.cSymbol));
      }
      if (match) {
        claimed.add(match.cSymbol);
        bound.push({ ...binding, protocol: device.protocol, typeName: device.typeName, cSymbol: match.cSymbol });
      }
    });
  });
  return bound;
};

const deviceOutputTypeMap = (device) => {
  const map = { ENO: 'BOOL', OK: 'BOOL', ERR_ID: 'SINT' };
  device.outputs.forEach((output) => { map[output.name] = output.type; });
  return map;
};

const buildMeta = (devices) => {
  const meta = { triggerPin: {}, qOutput: {}, inputs: {}, outputs: {}, inputTypes: {}, outputTypes: {} };
  devices.forEach((device) => {
    meta.triggerPin[device.typeName] = 'EN';
    meta.qOutput[device.typeName] = 'ENO';
    meta.inputs[device.typeName] = ['EN', ...device.extraInputs.map((input) => input.name)];
    meta.outputs[device.typeName] = ['ENO', 'OK', 'ERR_ID', ...device.outputs.map((output) => output.name)];
    meta.inputTypes[device.typeName] = Object.fromEntries(device.extraInputs.map((input) => [input.name, input.type]));
    meta.outputTypes[device.typeName] = deviceOutputTypeMap(device);
  });
  return meta;
};

const buildCommonStruct = (device, internalLines = []) => {
  const fields = ['typedef struct {', '    bool EN;'];
  device.extraInputs.forEach((input) => {
    fields.push(`    ${mapType(input.type)} ${input.name};`);
  });
  fields.push('    bool ENO;');
  fields.push('    bool OK;');
  fields.push('    int8_t ERR_ID;');
  device.outputs.forEach((output) => {
    fields.push(`    ${mapType(output.type)} ${output.name};`);
  });
  if (device.protocol === 'I2C') {
    fields.push('    uint8_t _port;');
    fields.push('    uint8_t _address;');
    fields.push('    int32_t _clock_hz;');
    fields.push('    bool _configured;');
  }
  if (device.protocol === 'SPI') {
    fields.push('    uint8_t _port;');
    fields.push('    uint8_t _cs;');
    fields.push('    uint8_t _mode;');
    fields.push('    uint8_t _bit_order;');
    fields.push('    int32_t _clock_hz;');
    fields.push('    bool _configured;');
  }
  if (device.protocol === 'UART') {
    fields.push('    uint8_t _port;');
    fields.push('    int32_t _baud;');
    fields.push('    uint8_t _parity;');
    fields.push('    uint8_t _stop_bits;');
    fields.push('    bool _configured;');
    fields.push('    volatile uint16_t _uart_head;');
    fields.push('    volatile uint16_t _uart_tail;');
    fields.push(`    uint8_t _uart_ring[${UART_RING_SIZE}];`);
    fields.push(`    uint8_t _frame_buf[${UART_FRAME_SIZE}];`);
    fields.push('    uint16_t _frame_len;');
  }
  internalLines.forEach((line) => fields.push(`    ${line}`));
  fields.push(`} ${device.typeName};`, '');
  return `${fields.join('\n')}\n`;
};

const buildDecodeExpr = (field, bufferExpr) => {
  const offset = parseNumeric(field.byteOffset, 0);
  const ptr = `${bufferExpr} + ${offset}`;
  switch (String(field.encoding || 'UINT8').toUpperCase()) {
    case 'UINT8': return `((uint8_t)${bufferExpr}[${offset}])`;
    case 'INT8': return `((int8_t)${bufferExpr}[${offset}])`;
    case 'UINT16_BE': return `__kron_u16_be(${ptr})`;
    case 'UINT16_LE': return `__kron_u16_le(${ptr})`;
    case 'INT16_BE': return `__kron_s16_be(${ptr})`;
    case 'INT16_LE': return `__kron_s16_le(${ptr})`;
    case 'UINT32_BE': return `__kron_u32_be(${ptr})`;
    case 'INT32_BE': return `__kron_s32_be(${ptr})`;
    case 'FLOAT32_BE': return `__kron_f32_be(${ptr})`;
    case 'BOOL': return `(${bufferExpr}[${offset}] != 0)`;
    default: return `((uint8_t)${bufferExpr}[${offset}])`;
  }
};

const buildScaledAssign = (field, expr) => {
  const fieldType = (field.type || 'REAL').toUpperCase();
  if (fieldType === 'BOOL') return `    instance->${field.name} = (${expr}) ? true : false;\n`;
  const scale = parseNumeric(field.scale, 1);
  const offsetVal = parseNumeric(field.offset_val ?? field.offset, 0);
  let finalExpr = expr;
  if (scale !== 1 || offsetVal !== 0) {
    finalExpr = `(((${expr}) * ${fieldType === 'LREAL' ? cDouble(scale) : cFloat(scale)}) + ${fieldType === 'LREAL' ? cDouble(offsetVal) : cFloat(offsetVal)})`;
  }
  return `    instance->${field.name} = (${mapType(fieldType)})(${finalExpr});\n`;
};

const buildBinaryFieldAssignments = (fields, bufferExpr) =>
  (fields || []).map((field) => buildScaledAssign(field, buildDecodeExpr(field, bufferExpr))).join('');

const buildAsciiFieldAssignments = (fields, bufferExpr, lenExpr) => {
  let code = '';
  (fields || []).forEach((field, index) => {
    const offset = parseNumeric(field.byteOffset, 0);
    const byteCount = parseNumeric(field.byteCount, 0);
    const tmpName = `__field_${index}`;
    code += `    if ((${lenExpr}) >= ${offset + byteCount}) {\n`;
    code += `        char ${tmpName}[${Math.max(8, byteCount + 1)}];\n`;
    code += `        memcpy(${tmpName}, ${bufferExpr} + ${offset}, ${byteCount});\n`;
    code += `        ${tmpName}[${byteCount}] = '\\0';\n`;
    if (String(field.encoding || '').toUpperCase() === 'ASCII_INT') {
      code += `        instance->${field.name} = (${mapType(field.type)})strtol(${tmpName}, NULL, 10);\n`;
    } else {
      code += `        instance->${field.name} = (${mapType(field.type)})strtof(${tmpName}, NULL);\n`;
    }
    code += '    }\n';
  });
  return code;
};

const buildGenericI2CImplementation = (device) => {
  let code = `static inline void ${device.typeName}_Init(${device.typeName} *instance, uint8_t port, uint8_t address) {\n`;
  code += '    instance->_port = port;\n';
  code += '    instance->_address = address;\n';
  code += `    instance->_clock_hz = ${cInt(device.config?.clockHz || 100000)};\n`;
  code += '    instance->_configured = true;\n';
  code += '    instance->OK = false;\n';
  code += '    instance->ERR_ID = 0;\n';
  (device.config?.initSequence || []).forEach((step, index) => {
    const data = normalizeByteArray(step.data);
    if (data.length === 0) return;
    code += `    { const uint8_t __init_${index}[] = { ${cByteArrayLiteral(data)} };\n`;
    code += `      if (!HAL_I2C_BurstWrite_Port(port, address, ${cHex(step.regAddr)}, __init_${index}, ${data.length}, &instance->ERR_ID)) return; }\n`;
  });
  code += '    instance->OK = true;\n';
  code += '}\n\n';
  code += `static inline void ${device.typeName}_Call(${device.typeName} *instance) {\n`;
  code += '    instance->ENO = instance->EN;\n';
  code += '    instance->OK = false;\n';
  code += '    instance->ERR_ID = 0;\n';
  code += '    if (!instance->EN) return;\n';
  code += '    if (!instance->_configured) { instance->ERR_ID = 1; return; }\n';
  (device.config?.registers || []).forEach((register, index) => {
    const byteCount = parseNumeric(register.byteCount, 0);
    if (byteCount <= 0) return;
    code += `    { uint8_t __buf_${index}[${byteCount}] = {0};\n`;
    code += `      if (!HAL_I2C_BurstRead_Port(instance->_port, instance->_address, ${cHex(register.regAddr)}, __buf_${index}, ${byteCount}, &instance->ERR_ID)) return;\n`;
    code += buildBinaryFieldAssignments(register.fields || [], `__buf_${index}`);
    code += '    }\n';
  });
  code += '    instance->OK = true;\n';
  code += '}\n\n';
  return code;
};

const buildGenericSPIImplementation = (device) => {
  const txFrame = normalizeByteArray(device.config?.txFrame || []);
  const rxFields = (device.config?.rxFields || []).map((field) => ({ ...field, name: sanitizeIdentifier(field.name, 'OUT'), type: (field.type || 'REAL').toUpperCase() }));
  const frameLen = Math.max(txFrame.length, ...rxFields.map((field) => parseNumeric(field.byteOffset, 0) + parseNumeric(field.byteCount, 1)), 1);
  let code = `static inline void ${device.typeName}_Init(${device.typeName} *instance, uint8_t port, uint8_t cs, uint8_t mode, uint8_t bit_order, int32_t clock_hz) {\n`;
  code += '    instance->_port = port;\n';
  code += '    instance->_cs = cs;\n';
  code += '    instance->_mode = mode;\n';
  code += '    instance->_bit_order = bit_order;\n';
  code += '    instance->_clock_hz = clock_hz;\n';
  code += '    instance->_configured = true;\n';
  code += '    instance->OK = false;\n';
  code += '    instance->ERR_ID = 0;\n';
  (device.config?.initSequence || []).forEach((step, index) => {
    const bytes = normalizeByteArray(step.txBytes || []);
    if (bytes.length === 0) return;
    code += `    { const uint8_t __spi_init_${index}[] = { ${cByteArrayLiteral(bytes)} };\n`;
    code += `      if (!HAL_SPI_BurstTransfer_Port(port, cs, mode, bit_order, clock_hz, __spi_init_${index}, NULL, ${bytes.length}, &instance->ERR_ID)) return; }\n`;
  });
  code += '    instance->OK = true;\n';
  code += '}\n\n';
  code += `static inline void ${device.typeName}_Call(${device.typeName} *instance) {\n`;
  code += '    instance->ENO = instance->EN;\n';
  code += '    instance->OK = false;\n';
  code += '    instance->ERR_ID = 0;\n';
  code += '    if (!instance->EN) return;\n';
  code += '    if (!instance->_configured) { instance->ERR_ID = 1; return; }\n';
  code += `    uint8_t __tx[${frameLen}] = {0};\n`;
  if (txFrame.length > 0) {
    txFrame.forEach((byte, index) => {
      code += `    __tx[${index}] = ${cHex(byte)};\n`;
    });
  }
  code += `    uint8_t __rx[${frameLen}] = {0};\n`;
  code += `    if (!HAL_SPI_BurstTransfer_Port(instance->_port, instance->_cs, instance->_mode, instance->_bit_order, instance->_clock_hz, __tx, __rx, ${frameLen}, &instance->ERR_ID)) return;\n`;
  code += buildBinaryFieldAssignments(rxFields, '__rx');
  code += '    instance->OK = true;\n';
  code += '}\n\n';
  return code;
};

const buildUARTParseFunction = (device) => {
  const fields = (device.config?.rxFields || device.config?.fields || []).map((field) => ({
    ...field,
    name: sanitizeIdentifier(field.name, 'OUT'),
    type: (field.type || 'REAL').toUpperCase(),
  }));
  let code = `static inline void ${device.typeName}_ParseFrame(${device.typeName} *instance, const uint8_t *frame, uint16_t len) {\n`;
  code += '    instance->ERR_ID = 0;\n';
  const asciiFields = fields.filter((field) => String(field.encoding || '').toUpperCase().startsWith('ASCII_'));
  const binaryFields = fields.filter((field) => !String(field.encoding || '').toUpperCase().startsWith('ASCII_'));
  code += buildBinaryFieldAssignments(binaryFields, 'frame');
  code += buildAsciiFieldAssignments(asciiFields, 'frame', 'len');
  code += '    instance->OK = true;\n';
  code += '}\n\n';
  return code;
};

const buildGenericUARTImplementation = (device) => {
  const mode = String(device.config?.messageFormat || device.config?.frameMode || (device.config?.delimiter ? 'DELIMITER' : 'FIXED')).toUpperCase();
  const fixedLength = Math.max(1, parseNumeric(device.config?.fixedLength ?? device.config?.byteCount, 16));
  const delimiterBytes = normalizeByteArray(device.config?.delimiterBytes || decodeCStringBytes(device.config?.delimiter || '\r\n'));
  let code = `static inline void ${device.typeName}_Init(${device.typeName} *instance, uint8_t port, int32_t baud, uint8_t parity, uint8_t stop_bits) {\n`;
  code += '    instance->_port = port;\n';
  code += '    instance->_baud = baud;\n';
  code += '    instance->_parity = parity;\n';
  code += '    instance->_stop_bits = stop_bits;\n';
  code += '    instance->_configured = true;\n';
  code += '    instance->_uart_head = 0;\n';
  code += '    instance->_uart_tail = 0;\n';
  code += '    instance->_frame_len = 0;\n';
  code += '    instance->OK = true;\n';
  code += '    instance->ERR_ID = 0;\n';
  code += '}\n\n';
  code += buildUARTParseFunction(device);
  code += `static inline void ${device.typeName}_Call(${device.typeName} *instance) {\n`;
  code += '    instance->ENO = instance->EN;\n';
  code += '    instance->OK = false;\n';
  code += '    instance->ERR_ID = 0;\n';
  code += '    if (!instance->EN) return;\n';
  code += '    if (!instance->_configured) { instance->ERR_ID = 1; return; }\n';
  if (mode === 'DELIMITER') {
    code += `    static const uint8_t __delimiter[] = { ${cByteArrayLiteral(delimiterBytes)} };\n`;
  }
  code += '    while (instance->_uart_tail != instance->_uart_head) {\n';
  code += '        uint8_t __byte = instance->_uart_ring[instance->_uart_tail];\n';
  code += `        instance->_uart_tail = (uint16_t)((instance->_uart_tail + 1u) % ${UART_RING_SIZE}u);\n`;
  code += `        if (instance->_frame_len < ${UART_FRAME_SIZE}u) instance->_frame_buf[instance->_frame_len++] = __byte;\n`;
  code += '        else { instance->_frame_len = 0; instance->ERR_ID = 4; }\n';
  if (mode === 'DELIMITER') {
    code += `        if (__kron_match_tail(instance->_frame_buf, instance->_frame_len, __delimiter, ${delimiterBytes.length})) {\n`;
    code += `            ${device.typeName}_ParseFrame(instance, instance->_frame_buf, (uint16_t)(instance->_frame_len - ${delimiterBytes.length}u));\n`;
    code += '            instance->_frame_len = 0;\n';
    code += '        }\n';
  } else {
    code += `        if (instance->_frame_len >= ${fixedLength}u) {\n`;
    code += `            ${device.typeName}_ParseFrame(instance, instance->_frame_buf, ${fixedLength});\n`;
    code += '            instance->_frame_len = 0;\n';
    code += '        }\n';
  }
  code += '    }\n';
  code += '}\n\n';
  return code;
};

const renderTemplate = (template, replacements) => {
  let rendered = template;
  Object.entries(replacements).forEach(([key, value]) => {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  });
  return rendered;
};

const buildBME280Implementation = (device) => renderTemplate(bme280Template, {
  TYPE_NAME: device.typeName,
  CLOCK_HZ: cInt(device.config?.clockHz || 400000),
  TEMP_FIELD: device.outputs[0]?.name || 'Temperature',
  PRESS_FIELD: device.outputs[1]?.name || 'Pressure',
  HUM_FIELD: device.outputs[2]?.name || 'Humidity',
});

const buildVL53L0XImplementation = (device) => renderTemplate(vl53l0xTemplate, {
  TYPE_NAME: device.typeName,
  CLOCK_HZ: cInt(device.config?.clockHz || 400000),
  DIST_FIELD: device.outputs[0]?.name || 'Distance_mm',
});

const buildADS1115Implementation = (device) => {
  const outs = device.outputs.map((output) => output.name);
  let code = `static inline void ${device.typeName}_Init(${device.typeName} *instance, uint8_t port, uint8_t address) {\n`;
  code += '    instance->_port = port;\n';
  code += '    instance->_address = address;\n';
  code += `    instance->_clock_hz = ${cInt(device.config?.clockHz || 400000)};\n`;
  code += '    instance->_configured = true;\n';
  code += '    instance->_next_channel = 0;\n';
  code += '    instance->OK = true;\n';
  code += '    instance->ERR_ID = 0;\n';
  code += '}\n\n';
  code += `static inline void ${device.typeName}_Call(${device.typeName} *instance) {\n`;
  code += '    instance->ENO = instance->EN;\n';
  code += '    instance->OK = false;\n';
  code += '    instance->ERR_ID = 0;\n';
  code += '    if (!instance->EN) return;\n';
  code += '    if (!instance->_configured) { instance->ERR_ID = 1; return; }\n';
  code += '    uint8_t conv[2] = {0};\n';
  code += '    if (!HAL_I2C_BurstRead_Port(instance->_port, instance->_address, 0x00, conv, 2, &instance->ERR_ID)) return;\n';
  code += '    int16_t raw = __kron_s16_be(conv);\n';
  outs.forEach((name, index) => {
    code += `    if (instance->_next_channel == ${index}) instance->${name} = (float)raw * 0.000125f;\n`;
  });
  code += '    {\n';
  code += '        uint8_t next = (uint8_t)((instance->_next_channel + 1u) & 0x03u);\n';
  code += '        uint16_t mux = (uint16_t)(0x4000u + ((uint16_t)next << 12));\n';
  code += '        uint16_t cfg = (uint16_t)(0x8000u | mux | 0x0200u | 0x0083u);\n';
  code += '        uint8_t frame[2] = { (uint8_t)(cfg >> 8), (uint8_t)(cfg & 0xFF) };\n';
  code += '        if (!HAL_I2C_BurstWrite_Port(instance->_port, instance->_address, 0x01, frame, 2, &instance->ERR_ID)) return;\n';
  code += '        instance->_next_channel = next;\n';
  code += '    }\n';
  code += '    instance->OK = true;\n';
  code += '}\n\n';
  return code;
};

const buildDS3231Implementation = (device) => {
  const outs = Object.fromEntries(device.outputs.map((output) => [output.name.toLowerCase(), output.name]));
  let code = `static inline void ${device.typeName}_Init(${device.typeName} *instance, uint8_t port, uint8_t address) {\n`;
  code += '    instance->_port = port;\n';
  code += '    instance->_address = address;\n';
  code += `    instance->_clock_hz = ${cInt(device.config?.clockHz || 400000)};\n`;
  code += '    instance->_configured = true;\n';
  code += '    instance->OK = true;\n';
  code += '    instance->ERR_ID = 0;\n';
  code += '}\n\n';
  code += `static inline void ${device.typeName}_Call(${device.typeName} *instance) {\n`;
  code += '    instance->ENO = instance->EN;\n';
  code += '    instance->OK = false;\n';
  code += '    instance->ERR_ID = 0;\n';
  code += '    if (!instance->EN) return;\n';
  code += '    if (!instance->_configured) { instance->ERR_ID = 1; return; }\n';
  code += '    uint8_t rtc[7] = {0};\n';
  code += '    uint8_t temp[2] = {0};\n';
  code += '    if (!HAL_I2C_BurstRead_Port(instance->_port, instance->_address, 0x00, rtc, 7, &instance->ERR_ID)) return;\n';
  code += '    if (!HAL_I2C_BurstRead_Port(instance->_port, instance->_address, 0x11, temp, 2, &instance->ERR_ID)) return;\n';
  if (outs.second) code += `    instance->${outs.second} = (uint8_t)__kron_bcd_to_u8(rtc[0] & 0x7F);\n`;
  if (outs.minute) code += `    instance->${outs.minute} = (uint8_t)__kron_bcd_to_u8(rtc[1] & 0x7F);\n`;
  if (outs.hour) code += `    instance->${outs.hour} = (uint8_t)__kron_bcd_to_u8(rtc[2] & 0x3F);\n`;
  if (outs.day) code += `    instance->${outs.day} = (uint8_t)__kron_bcd_to_u8(rtc[4] & 0x3F);\n`;
  if (outs.month) code += `    instance->${outs.month} = (uint8_t)__kron_bcd_to_u8(rtc[5] & 0x1F);\n`;
  if (outs.year) code += `    instance->${outs.year} = (uint8_t)__kron_bcd_to_u8(rtc[6]);\n`;
  if (outs.temp_c) code += `    instance->${outs.temp_c} = (float)(((int16_t)temp[0] << 8) | temp[1]) / 256.0f;\n`;
  code += '    instance->OK = true;\n';
  code += '}\n\n';
  return code;
};

const buildPCA9685Implementation = (device) => {
  const input = (name) => device.extraInputs.find((entry) => entry.name === name)?.name || name;
  const pwmFreq = Math.max(1, parseNumeric(device.config?.pwmFrequency, 50));
  const prescale = Math.max(3, Math.min(255, Math.round(25000000 / (4096 * pwmFreq)) - 1));
  let code = `static inline void ${device.typeName}_Init(${device.typeName} *instance, uint8_t port, uint8_t address) {\n`;
  code += '    instance->_port = port;\n';
  code += '    instance->_address = address;\n';
  code += `    instance->_clock_hz = ${cInt(device.config?.clockHz || 400000)};\n`;
  code += '    instance->_configured = true;\n';
  code += '    instance->OK = false;\n';
  code += '    instance->ERR_ID = 0;\n';
  code += `    { const uint8_t sleep_mode[] = { 0x10 }; if (!HAL_I2C_BurstWrite_Port(port, address, 0x00, sleep_mode, 1, &instance->ERR_ID)) return; }\n`;
  code += `    { const uint8_t pre[] = { ${cHex(prescale)} }; if (!HAL_I2C_BurstWrite_Port(port, address, 0xFE, pre, 1, &instance->ERR_ID)) return; }\n`;
  code += '    { const uint8_t wake_mode[] = { 0xA1 }; if (!HAL_I2C_BurstWrite_Port(port, address, 0x00, wake_mode, 1, &instance->ERR_ID)) return; }\n';
  code += '    instance->OK = true;\n';
  code += '}\n\n';
  code += `static inline void ${device.typeName}_Call(${device.typeName} *instance) {\n`;
  code += '    instance->ENO = instance->EN;\n';
  code += '    instance->OK = false;\n';
  code += '    instance->ERR_ID = 0;\n';
  code += '    if (!instance->EN) return;\n';
  code += '    if (!instance->_configured) { instance->ERR_ID = 1; return; }\n';
  code += '    uint8_t frame[16] = {0};\n';
  ['CH0', 'CH1', 'CH2', 'CH3'].forEach((name, index) => {
    code += `    { uint16_t duty = (uint16_t)__kron_clamp_i32((int32_t)instance->${input(name)}, 0, 4095);\n`;
    code += `      frame[${index * 4 + 2}] = (uint8_t)(duty & 0xFF);\n`;
    code += `      frame[${index * 4 + 3}] = (uint8_t)(duty >> 8); }\n`;
  });
  code += '    if (!HAL_I2C_BurstWrite_Port(instance->_port, instance->_address, 0x06, frame, 16, &instance->ERR_ID)) return;\n';
  code += '    instance->OK = true;\n';
  code += '}\n\n';
  return code;
};

const buildMAX31856Implementation = (device) => {
  let code = `static inline void ${device.typeName}_Init(${device.typeName} *instance, uint8_t port, uint8_t cs, uint8_t mode, uint8_t bit_order, int32_t clock_hz) {\n`;
  code += '    instance->_port = port;\n';
  code += '    instance->_cs = cs;\n';
  code += '    instance->_mode = mode;\n';
  code += '    instance->_bit_order = bit_order;\n';
  code += '    instance->_clock_hz = clock_hz;\n';
  code += '    instance->_configured = true;\n';
  code += '    instance->OK = false;\n';
  code += '    instance->ERR_ID = 0;\n';
  (device.config?.initSequence || []).forEach((step, index) => {
    const bytes = normalizeByteArray(step.txBytes || []);
    if (bytes.length === 0) return;
    code += `    { const uint8_t __init_${index}[] = { ${cByteArrayLiteral(bytes)} };\n`;
    code += `      if (!HAL_SPI_BurstTransfer_Port(port, cs, mode, bit_order, clock_hz, __init_${index}, NULL, ${bytes.length}, &instance->ERR_ID)) return; }\n`;
  });
  code += '    instance->OK = true;\n';
  code += '}\n\n';
  code += `static inline void ${device.typeName}_Call(${device.typeName} *instance) {\n`;
  code += '    instance->ENO = instance->EN;\n';
  code += '    instance->OK = false;\n';
  code += '    instance->ERR_ID = 0;\n';
  code += '    if (!instance->EN) return;\n';
  code += '    if (!instance->_configured) { instance->ERR_ID = 1; return; }\n';
  code += '    const uint8_t tx[7] = { 0x0A, 0, 0, 0, 0, 0, 0 };\n';
  code += '    uint8_t rx[7] = {0};\n';
  code += '    if (!HAL_SPI_BurstTransfer_Port(instance->_port, instance->_cs, instance->_mode, instance->_bit_order, instance->_clock_hz, tx, rx, 7, &instance->ERR_ID)) return;\n';
  code += `    instance->${device.outputs[0]?.name || 'Temp_C'} = (float)((int32_t)((rx[3] << 16) | (rx[4] << 8) | rx[5]) >> 5) * 0.0078125f;\n`;
  code += `    instance->${device.outputs[1]?.name || 'CJTemp_C'} = (float)((int16_t)((rx[1] << 8) | rx[2]) >> 2) * 0.015625f;\n`;
  code += `    instance->${device.outputs[2]?.name || 'Fault'} = (rx[6] != 0);\n`;
  code += '    instance->OK = true;\n';
  code += '}\n\n';
  return code;
};

const buildMCP3208Implementation = (device) => {
  let code = `static inline void ${device.typeName}_Init(${device.typeName} *instance, uint8_t port, uint8_t cs, uint8_t mode, uint8_t bit_order, int32_t clock_hz) {\n`;
  code += '    instance->_port = port;\n';
  code += '    instance->_cs = cs;\n';
  code += '    instance->_mode = mode;\n';
  code += '    instance->_bit_order = bit_order;\n';
  code += '    instance->_clock_hz = clock_hz;\n';
  code += '    instance->_configured = true;\n';
  code += '    instance->OK = true;\n';
  code += '    instance->ERR_ID = 0;\n';
  code += '}\n\n';
  code += `static inline void ${device.typeName}_Call(${device.typeName} *instance) {\n`;
  code += '    instance->ENO = instance->EN;\n';
  code += '    instance->OK = false;\n';
  code += '    instance->ERR_ID = 0;\n';
  code += '    if (!instance->EN) return;\n';
  code += '    if (!instance->_configured) { instance->ERR_ID = 1; return; }\n';
  device.outputs.forEach((output, index) => {
    code += `    { uint8_t tx[3] = { (uint8_t)(0x06 | ((${index} >> 2) & 0x01)), (uint8_t)((${index} & 0x03) << 6), 0x00 };\n`;
    code += '      uint8_t rx[3] = {0};\n';
    code += '      if (!HAL_SPI_BurstTransfer_Port(instance->_port, instance->_cs, instance->_mode, instance->_bit_order, instance->_clock_hz, tx, rx, 3, &instance->ERR_ID)) return;\n';
    code += `      instance->${output.name} = (int16_t)(((rx[1] & 0x0F) << 8) | rx[2]); }\n`;
  });
  code += '    instance->OK = true;\n';
  code += '}\n\n';
  return code;
};

const SPECIAL_BUILDERS = {
  BME280: {
    internalFields: [
      'uint16_t _dig_T1;',
      'int16_t _dig_T2;',
      'int16_t _dig_T3;',
      'uint16_t _dig_P1;',
      'int16_t _dig_P2;',
      'int16_t _dig_P3;',
      'int16_t _dig_P4;',
      'int16_t _dig_P5;',
      'int16_t _dig_P6;',
      'int16_t _dig_P7;',
      'int16_t _dig_P8;',
      'int16_t _dig_P9;',
      'uint8_t _dig_H1;',
      'int16_t _dig_H2;',
      'uint8_t _dig_H3;',
      'int16_t _dig_H4;',
      'int16_t _dig_H5;',
      'int8_t _dig_H6;',
      'int32_t _t_fine;',
    ],
    build: buildBME280Implementation,
  },
  VL53L0X: {
    internalFields: [],
    build: buildVL53L0XImplementation,
  },
  ADS1115: {
    internalFields: ['uint8_t _next_channel;'],
    build: buildADS1115Implementation,
  },
  DS3231: {
    internalFields: [],
    build: buildDS3231Implementation,
  },
  PCA9685: {
    internalFields: [],
    build: buildPCA9685Implementation,
  },
  MAX31856: {
    internalFields: [],
    build: buildMAX31856Implementation,
  },
  MCP3208: {
    internalFields: [],
    build: buildMCP3208Implementation,
  },
};

const buildImplementationForDevice = (device) => {
  const special = SPECIAL_BUILDERS[device.specialGenerator];
  if (special) return special.build(device);
  if (device.protocol === 'I2C') return buildGenericI2CImplementation(device);
  if (device.protocol === 'SPI') return buildGenericSPIImplementation(device);
  if (device.protocol === 'UART') return buildGenericUARTImplementation(device);
  return '';
};

const buildStructForDevice = (device) => {
  const special = SPECIAL_BUILDERS[device.specialGenerator];
  return buildCommonStruct(device, special?.internalFields || []);
};

const buildSignatureForDevice = (device) => {
  if (device.protocol === 'I2C') {
    return `static inline void ${device.typeName}_Init(${device.typeName} *instance, uint8_t port, uint8_t address);\nstatic inline void ${device.typeName}_Call(${device.typeName} *instance);\n`;
  }
  if (device.protocol === 'SPI') {
    return `static inline void ${device.typeName}_Init(${device.typeName} *instance, uint8_t port, uint8_t cs, uint8_t mode, uint8_t bit_order, int32_t clock_hz);\nstatic inline void ${device.typeName}_Call(${device.typeName} *instance);\n`;
  }
  return `static inline void ${device.typeName}_Init(${device.typeName} *instance, uint8_t port, int32_t baud, uint8_t parity, uint8_t stop_bits);\nstatic inline void ${device.typeName}_Call(${device.typeName} *instance);\n`;
};

const buildInitCall = (binding) => {
  if (binding.protocol === 'I2C') {
    return `${binding.typeName}_Init(&${binding.cSymbol}, ${cInt(binding.port)}, ${cHex(binding.address)});`;
  }
  if (binding.protocol === 'SPI') {
    return `${binding.typeName}_Init(&${binding.cSymbol}, ${cInt(binding.port)}, ${cInt(binding.cs)}, ${cInt(binding.mode)}, ${cInt(binding.bitOrder)}, ${cInt(binding.clockHz)});`;
  }
  const parityMap = { NONE: 0, EVEN: 1, ODD: 2 };
  return `${binding.typeName}_Init(&${binding.cSymbol}, ${cInt(binding.port)}, ${cInt(binding.baud)}, ${cInt(parityMap[binding.parity] ?? 0)}, ${cInt(binding.stopBits)});`;
};

const buildUARTThreadSupport = (bindings) => {
  const uartBindings = bindings.filter((binding) => binding.protocol === 'UART');
  if (uartBindings.length === 0) return '';
  let code = '\n#if defined(__linux__)\nextern volatile int plc_stop;\n';
  uartBindings.forEach((binding) => {
    const threadName = `__uart_thread_${binding.cSymbol.replace(/[^A-Za-z0-9_]/g, '_')}`;
    const fnName = `__uart_reader_${binding.cSymbol.replace(/[^A-Za-z0-9_]/g, '_')}`;
    code += `static pthread_t ${threadName};\n`;
    code += `static void* ${fnName}(void *arg) {\n`;
    code += '    (void)arg;\n';
    code += `    HAL_UART_Receive __rx = { .BAUD = ${cInt(binding.baud)}, .TIMEOUT = 0, .EN = true };\n`;
    code += '    while (!plc_stop) {\n';
    code += `        HAL_UART_Receive_Call(&__rx, ${cInt(binding.port)});\n`;
    code += '        if (__rx.READY) {\n';
    code += `            uint16_t __next = (uint16_t)((${binding.cSymbol}._uart_head + 1u) % ${UART_RING_SIZE}u);\n`;
    code += `            if (__next != ${binding.cSymbol}._uart_tail) {\n`;
    code += `                ${binding.cSymbol}._uart_ring[${binding.cSymbol}._uart_head] = __rx.DATA;\n`;
    code += `                ${binding.cSymbol}._uart_head = __next;\n`;
    code += '            }\n';
    code += '        } else {\n';
    code += '            usleep(1000);\n';
    code += '        }\n';
    code += '    }\n';
    code += '    return NULL;\n';
    code += '}\n';
    code += `static inline void ${fnName}_start(void) {\n`;
    code += `    pthread_create(&${threadName}, NULL, ${fnName}, NULL);\n`;
    code += `    pthread_detach(${threadName});\n`;
    code += '}\n';
  });
  code += '#endif\n';
  return code;
};

const buildInitCode = (bindings) => {
  if (bindings.length === 0) return '';
  const lines = bindings.map((binding) => `    ${buildInitCall(binding)}\n`);
  bindings.filter((binding) => binding.protocol === 'UART').forEach((binding) => {
    const fnName = `__uart_reader_${binding.cSymbol.replace(/[^A-Za-z0-9_]/g, '_')}_start`;
    lines.push('#if defined(__linux__)\n');
    lines.push(`    ${fnName}();\n`);
    lines.push('#endif\n');
  });
  return lines.join('');
};

const buildHeaderHelpers = () => `static inline uint16_t __kron_u16_be(const uint8_t *p) { return (uint16_t)(((uint16_t)p[0] << 8) | p[1]); }\n\
static inline uint16_t __kron_u16_le(const uint8_t *p) { return (uint16_t)(((uint16_t)p[1] << 8) | p[0]); }\n\
static inline int16_t __kron_s16_be(const uint8_t *p) { return (int16_t)__kron_u16_be(p); }\n\
static inline int16_t __kron_s16_le(const uint8_t *p) { return (int16_t)__kron_u16_le(p); }\n\
static inline uint32_t __kron_u32_be(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }\n\
static inline int32_t __kron_s32_be(const uint8_t *p) { return (int32_t)__kron_u32_be(p); }\n\
static inline float __kron_f32_be(const uint8_t *p) { union { uint32_t u; float f; } v; v.u = __kron_u32_be(p); return v.f; }\n\
static inline int32_t __kron_clamp_i32(int32_t v, int32_t lo, int32_t hi) { return v < lo ? lo : (v > hi ? hi : v); }\n\
static inline int __kron_match_tail(const uint8_t *buf, uint16_t len, const uint8_t *tail, uint16_t tail_len) {\n\
    if (tail_len == 0 || len < tail_len) return 0;\n\
    return memcmp(buf + len - tail_len, tail, tail_len) == 0;\n\
}\n\
static inline uint8_t __kron_bcd_to_u8(uint8_t value) { return (uint8_t)(((value >> 4) * 10u) + (value & 0x0Fu)); }\n\n`;

export const buildGeneratedDeviceArtifacts = (projectStructure, config, boardId) => {
  const boardFamily = getBoardFamilyDefine(boardId);
  if (!boardFamily || boardFamily === 'HAL_BOARD_FAMILY_PICO') return EMPTY_ARTIFACTS;

  const devices = normalizeDeviceDefinitions(projectStructure, config);
  if (devices.length === 0) return EMPTY_ARTIFACTS;

  const bindings = bindInstancesToProgramVars(devices, projectStructure);
  return {
    devices,
    meta: buildMeta(devices),
    headerHelpers: buildHeaderHelpers(),
    headerTypedefs: devices.map(buildStructForDevice).join(''),
    headerSignatures: devices.map(buildSignatureForDevice).join(''),
    headerImplementations: devices.map(buildImplementationForDevice).join(''),
    sourceSupport: buildUARTThreadSupport(bindings),
    initCode: buildInitCode(bindings),
    cleanupCode: '',
  };
};
