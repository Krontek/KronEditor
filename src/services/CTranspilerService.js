import { getBoardBlockMeta } from '../utils/halBlockMeta';
import { buildGeneratedDeviceArtifacts } from '../utils/deviceCodegen';
import { getPortOptions } from '../utils/devicePortMapping';

const getBoardFamilyDefine = (boardId) => {
    if (!boardId) return null;
    if (boardId.startsWith('rpi_pico')) return 'HAL_BOARD_FAMILY_PICO';
    if (boardId.startsWith('rpi_')) return 'HAL_BOARD_FAMILY_RPI';
    if (boardId.startsWith('bb_')) return 'HAL_BOARD_FAMILY_BB';
    if (boardId.startsWith('jetson_')) return 'HAL_BOARD_FAMILY_JETSON';
    return null;
};

const parseNumeric = (value, fallback = 0) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const str = String(value).trim();
    if (!str) return fallback;
    if (/^0x[0-9a-f]+$/i.test(str)) return parseInt(str, 16);
    const num = Number(str);
    return Number.isFinite(num) ? num : fallback;
};

const parseUartChannel = (port) =>
    parseNumeric(String(port?.id || '').match(/UART_(\d+)/)?.[1], 0);

const parseI2CBus = (port) =>
    parseNumeric(
        String(port?.path || '').match(/i2c-(\d+)/)?.[1]
        ?? String(port?.id || '').match(/I2C_(\d+)/)?.[1],
        0
    );

const parseSpiEndpoint = (port) => {
    const pathMatch = String(port?.path || '').match(/spidev(\d+)\.(\d+)/i);
    const idMatch = String(port?.id || '').match(/SPI_(\d+)_CE(\d+)/i);
    const bus = parseNumeric(pathMatch?.[1] ?? idMatch?.[1], 0);
    const cs = parseNumeric(pathMatch?.[2] ?? idMatch?.[2], 0);
    return { logicalId: (bus * 2) + cs, bus, cs };
};

const POINTER_INPUT_TYPES = new Set(['POINTER']);
const IDENTIFIER_REF_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const isPointerInputType = (iecType) => POINTER_INPUT_TYPES.has(String(iecType || '').toUpperCase());
const isBooleanLiteral = (value) => /^(?:BOOL#)?(?:TRUE|FALSE)$/i.test(String(value || '').trim());
const normalizeBooleanLiteral = (value) => {
    const normalized = String(value || '').trim().replace(/^BOOL#/i, '').toUpperCase();
    if (normalized === 'TRUE') return 'true';
    if (normalized === 'FALSE') return 'false';
    return null;
};

const resolveHardwarePortSymbol = (value) => {
    if (value === undefined || value === null) return null;
    const normalized = String(value).replace(/[🌍🏠⊞⊡⊟]/g, '').trim().toUpperCase();
    if (!normalized) return null;

    const i2cMatch = normalized.match(/^I2C(?:_|)?(\d+)(?:_PORT)?$/);
    if (i2cMatch) return String(parseNumeric(i2cMatch[1], 0));

    const uartMatch = normalized.match(/^UART(?:_|)?(\d+)(?:_PORT)?$/);
    if (uartMatch) return String(parseNumeric(uartMatch[1], 0));

    const spiMatch = normalized.match(/^SPI(?:_|)?(\d+)_CE(\d+)(?:_PORT)?$/);
    if (spiMatch) {
        const bus = parseNumeric(spiMatch[1], 0);
        const cs = parseNumeric(spiMatch[2], 0);
        return String((bus * 2) + cs);
    }

    return null;
};

const parityToCode = (value) => {
    const normalized = String(value || 'NONE').toUpperCase();
    if (normalized === 'EVEN') return 1;
    if (normalized === 'ODD') return 2;
    return 0;
};

const buildRuntimePortHelpers = (boardId, interfaceConfig = {}) => {
    const boardFamily = getBoardFamilyDefine(boardId);
    if (!boardFamily) return '';

    const i2cPorts = getPortOptions(boardFamily, 'I2C')
        .map((port) => {
            const config = {
                enabled: false,
                ...(interfaceConfig?.I2C?.[port.id] || {}),
            };
            return { bus: parseI2CBus(port), enabled: !!config.enabled };
        })
        .sort((a, b) => a.bus - b.bus);

    const spiPorts = getPortOptions(boardFamily, 'SPI')
        .map((port) => {
            const endpoint = parseSpiEndpoint(port);
            const config = {
                enabled: false,
                clockHz: 1000000,
                mode: 0,
                bitOrder: 'MSB',
                ...(interfaceConfig?.SPI?.[port.id] || {}),
            };
            return {
                logicalId: endpoint.logicalId,
                bus: endpoint.bus,
                cs: endpoint.cs,
                enabled: !!config.enabled,
                clockHz: parseNumeric(config.clockHz, 1000000),
                mode: parseNumeric(config.mode, 0),
                bitOrder: String(config.bitOrder || 'MSB').toUpperCase() === 'LSB' ? 1 : 0,
            };
        })
        .sort((a, b) => a.logicalId - b.logicalId);

    const uartPorts = getPortOptions(boardFamily, 'UART')
        .map((port) => {
            const config = {
                enabled: false,
                baudRate: 115200,
                parity: 'NONE',
                stopBits: 1,
                devicePath: '',
                ...(interfaceConfig?.UART?.[port.id] || {}),
            };
            return {
                channel: parseUartChannel(port),
                enabled: !!config.enabled,
                baudRate: parseNumeric(config.baudRate, 115200),
                parity: parityToCode(config.parity),
                stopBits: parseNumeric(config.stopBits, 1),
                devicePath: (config.devicePath || '').trim(),
            };
        })
        .sort((a, b) => a.channel - b.channel);

    const renderSwitch = (cases, defaultValue, mapper) => {
        if (cases.length === 0) return `    (void)port;\n    return ${defaultValue};\n`;
        let code = '    switch (port) {\n';
        cases.forEach((entry) => {
            code += `        case ${entry.caseValue}: return ${mapper(entry)};\n`;
        });
        code += `        default: return ${defaultValue};\n`;
        code += '    }\n';
        return code;
    };

    // UART device path overrides — emitted before kronhal.h so #ifndef KRON_UARTx picks them up
    let uartPathDefines = '';
    uartPorts.forEach((entry) => {
        if (entry.devicePath) {
            const escaped = entry.devicePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            uartPathDefines += `#ifndef KRON_UART${entry.channel}\n`;
            uartPathDefines += `#define KRON_UART${entry.channel} "${escaped}"\n`;
            uartPathDefines += `#endif\n`;
        }
    });

    let helpers = `#define KRON_RUNTIME_PORT_HELPERS 1\n${uartPathDefines}\n`;
    helpers += `static inline bool KRON_I2C_PortEnabled(uint8_t port) {\n`;
    helpers += renderSwitch(
        i2cPorts.map((entry) => ({ caseValue: entry.bus, enabled: entry.enabled })),
        'false',
        (entry) => entry.enabled ? 'true' : 'false'
    );
    helpers += `}\n\n`;

    helpers += `static inline bool KRON_SPI_PortResolve(uint8_t port, uint8_t *bus, uint8_t *cs, uint8_t *mode, uint8_t *bit_order, int32_t *clk_hz, bool *enabled) {\n`;
    if (spiPorts.length === 0) {
        helpers += `    (void)port;\n    if (bus) *bus = 0;\n    if (cs) *cs = 0;\n    if (mode) *mode = 0;\n    if (bit_order) *bit_order = 0;\n    if (clk_hz) *clk_hz = 1000000;\n    if (enabled) *enabled = false;\n    return false;\n`;
    } else {
        helpers += `    switch (port) {\n`;
        spiPorts.forEach((entry) => {
            helpers += `        case ${entry.logicalId}:\n`;
            helpers += `            if (bus) *bus = ${entry.bus};\n`;
            helpers += `            if (cs) *cs = ${entry.cs};\n`;
            helpers += `            if (mode) *mode = ${entry.mode};\n`;
            helpers += `            if (bit_order) *bit_order = ${entry.bitOrder};\n`;
            helpers += `            if (clk_hz) *clk_hz = ${entry.clockHz};\n`;
            helpers += `            if (enabled) *enabled = ${entry.enabled ? 'true' : 'false'};\n`;
            helpers += `            return true;\n`;
        });
        helpers += `        default:\n`;
        helpers += `            if (bus) *bus = 0;\n`;
        helpers += `            if (cs) *cs = 0;\n`;
        helpers += `            if (mode) *mode = 0;\n`;
        helpers += `            if (bit_order) *bit_order = 0;\n`;
        helpers += `            if (clk_hz) *clk_hz = 1000000;\n`;
        helpers += `            if (enabled) *enabled = false;\n`;
        helpers += `            return false;\n`;
        helpers += `    }\n`;
    }
    helpers += `}\n\n`;

    helpers += `static inline bool KRON_UART_PortEnabled(uint8_t port) {\n`;
    helpers += renderSwitch(
        uartPorts.map((entry) => ({ caseValue: entry.channel, enabled: entry.enabled })),
        'false',
        (entry) => entry.enabled ? 'true' : 'false'
    );
    helpers += `}\n\n`;

    helpers += `static inline int32_t KRON_UART_PortBaud(uint8_t port) {\n`;
    helpers += renderSwitch(
        uartPorts.map((entry) => ({ caseValue: entry.channel, baudRate: entry.baudRate })),
        '115200',
        (entry) => `${entry.baudRate}`
    );
    helpers += `}\n\n`;

    helpers += `static inline uint8_t KRON_UART_PortParity(uint8_t port) {\n`;
    helpers += renderSwitch(
        uartPorts.map((entry) => ({ caseValue: entry.channel, parity: entry.parity })),
        '0',
        (entry) => `${entry.parity}`
    );
    helpers += `}\n\n`;

    helpers += `static inline uint8_t KRON_UART_PortStopBits(uint8_t port) {\n`;
    helpers += renderSwitch(
        uartPorts.map((entry) => ({ caseValue: entry.channel, stopBits: entry.stopBits })),
        '1',
        (entry) => `${entry.stopBits}`
    );
    helpers += `}\n\n`;

    return helpers;
};

const ST_KEYWORDS_LOWER = new Set([
    'if','then','elsif','else','end_if','case','of','end_case',
    'for','to','by','do','end_for','while','end_while',
    'repeat','until','end_repeat','return','exit',
    'true','false','and','or','not','xor','mod',
    'bool','int','uint','dint','udint','lint','ulint',
    'real','lreal','time','string','byte','word','dword','lword',
    'ton','tof','tp','tonr','ctu','ctd','ctud','sr','rs','r_trig','f_trig',
    'shl','shr','rol','ror','band','bor','bxor','bnot',
    'add','sub','mul','div','abs','sqrt','expt','sin','cos','tan','asin','acos','atan',
    'max','min','limit','sel','mux','move',
    'gt','ge','eq','ne','le','lt',
    'byte_to_uint','byte_to_int','byte_to_dint','byte_to_real',
    'int_to_real','real_to_int','dint_to_real','real_to_dint',
    'bool_to_int','int_to_bool','norm_x','scale_x',
    'int_to_uint','uint_to_int','dint_to_int','int_to_dint',
    'uart_receive','uart_send',
]);

/**
 * Validate all ST/SCL code in the project before compilation.
 * Returns an array of { program, rung, line, column, word } error objects.
 * Errors indicate identifiers not found in variable tables or known functions.
 */
export const validateProjectST = (projectStructure, stdFunctionNames = []) => {
    const errors = [];
    const stdLower = new Set(stdFunctionNames.map(n => n.toLowerCase()));
    const globalVarNames = new Set(
        (projectStructure?.global?.variables || []).map(v => (v.name || '').toLowerCase())
    );
    const dataTypeNames = new Set(
        (projectStructure?.dataTypes || []).map(dt => (dt.name || '').toLowerCase())
    );

    const validateCode = (code, varNames, contextLabel) => {
        // Strip multi-line (* block comments *) preserving line count, then split
        const stripped = (code || '').replace(/\(\*[\s\S]*?\*\)/g, match => '\n'.repeat((match.match(/\n/g) || []).length));
        const lines = stripped.split('\n');
        lines.forEach((rawLine, i) => {
            const line = rawLine.replace(/\/\/.*$/, '').replace(/\(\*.*?\*\)/g, '');
            const regex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
            let match;
            while ((match = regex.exec(line)) !== null) {
                // Skip member access identifiers (e.g. .NewData in UART_Receive1.NewData)
                if (match.index > 0 && line[match.index - 1] === '.') continue;
                const word = match[0];
                const lower = word.toLowerCase();
                if (!ST_KEYWORDS_LOWER.has(lower) && !stdLower.has(lower) &&
                    !globalVarNames.has(lower) && !dataTypeNames.has(lower) &&
                    !varNames.has(lower) && isNaN(word)) {
                    errors.push({ context: contextLabel, line: i + 1, column: match.index + 1, word });
                }
            }
        });
    };

    const allPOUs = [
        ...(projectStructure?.programs || []),
        ...(projectStructure?.functionBlocks || []),
        ...(projectStructure?.functions || []),
    ];

    allPOUs.forEach(pou => {
        const pouName = pou.name || '?';
        const varNames = new Set(
            (pou.content?.variables || []).map(v => (v.name || '').toLowerCase())
        );

        if (pou.type === 'ST' && pou.content?.code) {
            validateCode(pou.content.code, varNames, pouName);
        } else if (pou.type === 'SCL') {
            (pou.content?.rungs || []).forEach((rung, ri) => {
                if (rung.lang === 'ST' && rung.code) {
                    validateCode(rung.code, varNames, `${pouName} Rung ${ri}`);
                }
            });
        }
    });

    return errors;
};

export const transpileToC = (projectStructure, standardHeaders = [], boardId = null, simMode = true) => {
    let stdFunctions = {};
    let customIncludes = ``;

    // Board-specific HAL implementation headers: excluded from direct #include
    // because kronhal.h conditionally includes the right one based on defines.
    const HAL_IMPL_HEADERS = new Set([
        'kronhal_sim.h', 'kronhal_pico.h', 'kronhal_rpi.h', 'kronhal_bb.h',
        'kronhal_jetson.h'
    ]);

    standardHeaders.forEach(([filename, content]) => {
        if (!HAL_IMPL_HEADERS.has(filename)) {
            customIncludes += `#include "${filename}"\n`;
        }
        const regex = /\b([A-Za-z0-9_]+)_Call\s*\(([^)]*)\)/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            const blockType = match[1];
            const paramsStr = match[2].trim();
            const paramList = paramsStr ? paramsStr.split(',').map(s => s.trim()) : [];
            let isFB = false;

            if (paramList.length > 0 && paramList[0].includes('*')) {
                isFB = true;
                paramList.shift();
            } else if (paramList.length > 0 && paramList[0] === 'void') {
                paramList.shift();
            }

            const inputs = paramList.map(p => {
                const parts = p.split(/\s+/).filter(Boolean);
                if (parts.length === 0) return null;
                const last = parts[parts.length - 1];
                return last.replace(/[^A-Za-z0-9_]/g, '');
            }).filter(Boolean);

            stdFunctions[blockType] = {
                hasTime: paramsStr.includes('TIME'),
                inputs: inputs,
                isFB: isFB
            };
        }
    });

    const IEC_TYPE_SIZES = {
        'BOOL': 1, 'SINT': 1, 'USINT': 1, 'BYTE': 1,
        'INT': 2, 'UINT': 2, 'WORD': 2,
        'DINT': 4, 'UDINT': 4, 'TIME': 4, 'REAL': 4, 'DWORD': 4
    };

    // Shared memory offset tracker — each scalar PLC variable gets a consecutive slot
    // Force flags region starts at FORCE_FLAGS_BASE: one byte per variable, set by KronServer
    // to prevent plc_shm_sync from overwriting a forced value with the PLC-computed value.
    const FORCE_FLAGS_BASE = 32768;
    let shmOffset = 0;
    const shmEntries = []; // {c_symbol, offset, size, flagOffset} used to generate plc_shm_sync()
    const tryAssignShm = (type, c_symbol) => {
        const size = IEC_TYPE_SIZES[type?.toUpperCase()];
        if (!size) return {}; // FB, user-defined type or unknown — no SHM slot
        const offset = shmOffset;
        const flagOffset = FORCE_FLAGS_BASE + shmEntries.length;
        shmOffset += size;
        shmEntries.push({ c_symbol, offset, size, flagOffset });
        return { offset, size, force_flag_offset: flagOffset };
    };

    const resolveInitialValue = (val, type) => {
        if (val !== undefined && val !== null && val !== '') {
            if (type === 'BOOL') return val.toString().toLowerCase() === 'true' || val === '1';
            if (['STRING'].includes(type)) return val.toString().replace(/^"|"$/g, '');
            return Number(val) || 0;
        }
        if (type === 'BOOL') return false;
        if (['STRING'].includes(type)) return "";
        return 0;
    };

    // Board-specific HAL defines (for kronhal.h conditional compilation)
    let boardDefines = '';
    if (boardId) {
        const familyDef = getBoardFamilyDefine(boardId);
        boardDefines += `#define HAL_BOARD "${boardId}"\n`;
        if (simMode || !familyDef) {
            // Simulation build or unknown board: use simulation stubs
            boardDefines += `#define HAL_SIM_MODE 1\n`;
        } else {
            // Real target build: use board-specific HAL implementation
            boardDefines += `#define ${familyDef} 1\n`;
        }
    }

    const config = projectStructure.resources?.find(r => r.id === 'res_config');
    const runtimePortHelpers = buildRuntimePortHelpers(boardId, config?.content?.deviceInterfaceConfig || {});

    let header = `// Autogenerated by KronEditor CTranspiler
#ifndef PLC_H
#define PLC_H

#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <stdlib.h>
${boardDefines}${runtimePortHelpers}${customIncludes}

extern volatile uint64_t us_tick;

`;

    let source = `// Autogenerated by KronEditor CTranspiler\n#include "plc.h"\n\n#if defined(__linux__) || defined(__APPLE__)\n#include <time.h>\n#include <unistd.h>\n#endif\n#if defined(__linux__)\n#include <sched.h>\n#include <pthread.h>\n#elif defined(_WIN32)\nvoid Sleep(unsigned long ms);\nint SetPriorityClass(void *hProcess, unsigned long dwPriorityClass);\nvoid *GetCurrentProcess(void);\nint SetThreadPriority(void *hThread, int nPriority);\nvoid *GetCurrentThread(void);\n#define REALTIME_PRIORITY_CLASS 0x00000100\n#define THREAD_PRIORITY_TIME_CRITICAL 15\n#endif\n\n`;

    let variableTable = {
        dataTypes: {},
        globalVars: {},
        programs: {},
        // Flat debug map: liveKey → {type, c_symbol, defaultValue}
        // Written so the simulator/developer can verify symbol tracking
        debugDefaults: {}
    };

    // Register board-specific blocks in transpiler lookup tables
    // so the LD transpiler knows their pin layout and trigger pins.
    const _halSavedKeys = { triggerPin: [], qOutput: [], inputs: [], outputs: [], inputTypes: [] };
    if (boardId) {
        const halMeta = getBoardBlockMeta(boardId);
        Object.keys(halMeta.triggerPin).forEach(k => {
            if (!(k in FB_TRIGGER_PIN)) { FB_TRIGGER_PIN[k] = halMeta.triggerPin[k]; _halSavedKeys.triggerPin.push(k); HAL_BLOCK_TYPES.add(k); }
        });
        Object.keys(halMeta.qOutput).forEach(k => {
            if (!(k in FB_Q_OUTPUT)) { FB_Q_OUTPUT[k] = halMeta.qOutput[k]; _halSavedKeys.qOutput.push(k); }
        });
        Object.keys(halMeta.inputs).forEach(k => {
            if (!(k in FB_INPUTS)) { FB_INPUTS[k] = halMeta.inputs[k]; _halSavedKeys.inputs.push(k); }
        });
        Object.keys(halMeta.outputs).forEach(k => {
            if (!(k in FB_OUTPUTS)) { FB_OUTPUTS[k] = halMeta.outputs[k]; _halSavedKeys.outputs.push(k); }
        });
        Object.keys(halMeta.inputTypes).forEach(k => {
            if (!(k in FB_INPUT_TYPES)) { FB_INPUT_TYPES[k] = halMeta.inputTypes[k]; _halSavedKeys.inputTypes.push(k); }
        });
    }

    const deviceArtifacts = buildGeneratedDeviceArtifacts(projectStructure, config, boardId);
    const _deviceSavedKeys = { triggerPin: [], qOutput: [], inputs: [], outputs: [], inputTypes: [], outputTypes: [] };
    Object.keys(deviceArtifacts.meta.triggerPin).forEach(k => {
        if (!(k in FB_TRIGGER_PIN)) { FB_TRIGGER_PIN[k] = deviceArtifacts.meta.triggerPin[k]; _deviceSavedKeys.triggerPin.push(k); HAL_BLOCK_TYPES.add(k); }
    });
    Object.keys(deviceArtifacts.meta.qOutput).forEach(k => {
        if (!(k in FB_Q_OUTPUT)) { FB_Q_OUTPUT[k] = deviceArtifacts.meta.qOutput[k]; _deviceSavedKeys.qOutput.push(k); }
    });
    Object.keys(deviceArtifacts.meta.inputs).forEach(k => {
        if (!(k in FB_INPUTS)) { FB_INPUTS[k] = deviceArtifacts.meta.inputs[k]; _deviceSavedKeys.inputs.push(k); }
    });
    Object.keys(deviceArtifacts.meta.outputs).forEach(k => {
        if (!(k in FB_OUTPUTS)) { FB_OUTPUTS[k] = deviceArtifacts.meta.outputs[k]; _deviceSavedKeys.outputs.push(k); }
    });
    Object.keys(deviceArtifacts.meta.inputTypes).forEach(k => {
        if (!(k in FB_INPUT_TYPES)) { FB_INPUT_TYPES[k] = deviceArtifacts.meta.inputTypes[k]; _deviceSavedKeys.inputTypes.push(k); }
    });
    Object.keys(deviceArtifacts.meta.outputTypes).forEach(k => {
        if (!(k in GENERATED_FB_OUTPUT_TYPES)) { GENERATED_FB_OUTPUT_TYPES[k] = deviceArtifacts.meta.outputTypes[k]; _deviceSavedKeys.outputTypes.push(k); }
    });

    // 1. Data Types (Header only)
    if (projectStructure.dataTypes && projectStructure.dataTypes.length > 0) {
        header += `// --- DATA TYPES ---\n`;
        projectStructure.dataTypes.forEach(dt => {
            header += transpileDataType(dt);
            // Record structured mapping
            variableTable.dataTypes[dt.name] = {
                type: dt.type,
                content: dt.content
            };
        });
    }

    // 2. Global Variables

    // Build lookup: typeName → data type definition (for array/struct/enum expansion)
    const dataTypeDefs = (projectStructure.dataTypes || []).reduce((acc, dt) => {
        acc[dt.name] = dt; return acc;
    }, {});

    if (config && config.content.globalVars && config.content.globalVars.length > 0) {
        header += `// --- GLOBAL VARIABLES ---\n`;
        config.content.globalVars.forEach(v => {
            const isUserType = !!dataTypeDefs[v.type];
            let initVal = (!isUserType && v.initialValue) ? ` = ${v.initialValue}` : '';
            if (v.type === 'STRING' && v.initialValue) initVal = ` = "${v.initialValue}"`;
            header += `${mapType(v.type)} ${v.name}${initVal};\n`;
            const gInitVal = resolveInitialValue(v.initialValue, v.type);
            variableTable.globalVars[v.name] = { type: v.type, initialValue: gInitVal };
            // Debug: top-level entry (scalar types get a SHM slot)
            const gShmSlot = !isUserType ? tryAssignShm(v.type, v.name) : {};
            variableTable.debugDefaults[`prog__${v.name}`] = {
                type: v.type, c_symbol: v.name, defaultValue: gInitVal, ...gShmSlot
            };
            // Debug: expand array elements and struct members for monitoring
            const dtDef = dataTypeDefs[v.type];
            if (dtDef?.type === 'Array') {
                const baseType = dtDef.content.baseType;
                const elemSize = IEC_TYPE_SIZES[baseType.toUpperCase()] || 0;
                dtDef.content.dimensions.forEach(dim => {
                    for (let i = parseInt(dim.min); i <= parseInt(dim.max); i++) {
                        const elemCSym = `${v.name}[${i}]`;
                        const elemShmSlot = tryAssignShm(baseType, elemCSym);
                        variableTable.debugDefaults[`prog__${v.name}[${i}]`] = {
                            type: baseType, c_symbol: elemCSym,
                            base_symbol: v.name, byte_offset: i * elemSize,
                            defaultValue: 0, ...elemShmSlot
                        };
                    }
                });
            } else if (dtDef?.type === 'Structure') {
                let memberOffset = 0;
                (dtDef.content.members || []).forEach(member => {
                    const memCSym = `${v.name}.${member.name}`;
                    const memShmSlot = tryAssignShm(member.type, memCSym);
                    variableTable.debugDefaults[`prog__${v.name}.${member.name}`] = {
                        type: member.type, c_symbol: memCSym,
                        base_symbol: v.name, byte_offset: memberOffset,
                        defaultValue: 0, ...memShmSlot
                    };
                    memberOffset += IEC_TYPE_SIZES[member.type.toUpperCase()] || 0;
                });
            }
        });
        header += `\n`;
    }

    // 3. Function Blocks (State Structures)
    if (projectStructure.functionBlocks && projectStructure.functionBlocks.length > 0) {
        header += `// --- FUNCTION BLOCK STATES ---\n`;
        projectStructure.functionBlocks.forEach(fb => {
            const fbNameSafe = (fb.name || '').trim().replace(/\s+/g, '_');
            header += `typedef struct {\n`;
            fb.content.variables.forEach(v => {
                if (isInlineMathType(v.type)) return; // Inline math — no struct member needed
                header += `    ${mapType(v.type)} ${v.name};\n`;
            });
            header += `} ${fbNameSafe};\n\n`;
        });
    }

    if (deviceArtifacts.headerTypedefs) {
        header += `// --- GENERATED DEVICE FUNCTION BLOCKS ---\n`;
        header += deviceArtifacts.headerTypedefs;
    }

    // 4. Function and Program Signatures
    header += `// --- SIGNATURES ---\n`;
    header += `void PLC_Init(void);\n`;
    header += `void PLC_Cleanup(void);\n`;

    if (projectStructure.functions) {
        projectStructure.functions.forEach(fn => {
            const retType = mapType(fn.returnType || 'VOID');
            let fnName = (fn.name || '').trim().replace(/\s+/g, '_');
            header += `static inline ${retType} ${fnName}();\n`;
        });
    }

    if (projectStructure.functionBlocks) {
        projectStructure.functionBlocks.forEach(fb => {
            let fbName = (fb.name || '').trim().replace(/\s+/g, '_');
            header += `static inline void ${fbName}_Execute(${fbName} *instance);\n`;
        });
    }

    if (projectStructure.programs) {
        projectStructure.programs.forEach(prog => {
            let progName = (prog.name || '').trim().replace(/\s+/g, '_');
            header += `static inline void ${progName}();\n`;
        });
    }
    if (deviceArtifacts.headerSignatures) {
        header += deviceArtifacts.headerSignatures;
    }

    // Collect global variable names (used by LD transpiler to skip prog_ prefix)
    const globalVarNames = (config?.content?.globalVars || [])
        .map(v => (v.name || '').trim().replace(/\s+/g, '_'));

    header += `\n// --- IMPLEMENTATIONS ---\n`;
    if (deviceArtifacts.headerHelpers) {
        header += `// --- GENERATED DEVICE HELPERS ---\n`;
        header += deviceArtifacts.headerHelpers;
    }
    if (deviceArtifacts.headerImplementations) {
        header += `// --- GENERATED DEVICE IMPLEMENTATIONS ---\n`;
        header += deviceArtifacts.headerImplementations;
    }

    if (projectStructure.functions) {
        header += `// --- FUNCTIONS ---\n`;
        projectStructure.functions.forEach(fn => {
            header += transpilePOUSource(fn, 'function', stdFunctions, fn.name, globalVarNames);
        });
    }

    if (projectStructure.functionBlocks) {
        header += `// --- FUNCTION BLOCKS ---\n`;
        projectStructure.functionBlocks.forEach(fb => {
            header += transpilePOUSource(fb, 'function_block', stdFunctions, fb.name, globalVarNames);
        });
    }

    if (projectStructure.programs) {
        header += `// --- PROGRAMS ---\n`;
        projectStructure.programs.forEach(prog => {
            let progName = (prog.name || '').trim().replace(/\s+/g, '_');

            variableTable.programs[progName] = { variables: {} };

            // Allocate static program instances of FBs if they exist
            prog.content.variables.forEach(v => {
                let vName = (v.name || '').trim().replace(/\s+/g, '_');
                let vType = (v.type || '').trim();
                if (isInlineMathType(vType)) return; // Inline math — handled inline in LD, no instance
                const isFB = isFBType(vType, projectStructure) || !!stdFunctions[vType] || HAL_BLOCK_TYPES.has(vType);
                if (isFB) {
                    header += `${vType} prog_${progName}_inst_${vName};\n`;
                } else {
                    // Global internal variables for simple programs
                    header += `${mapType(vType)} prog_${progName}_${vName};\n`;
                }

                const cSym = isFB ? `prog_${progName}_inst_${vName}` : `prog_${progName}_${vName}`;
                const initVal = resolveInitialValue(v.initialValue, vType);
                variableTable.programs[progName].variables[vName] = {
                    type: vType, c_symbol: cSym, initialValue: initVal
                };
                // Debug: top-level entry (non-FB scalars get a SHM slot)
                const vShmSlot = !isFB ? tryAssignShm(vType, cSym) : {};
                variableTable.debugDefaults[`prog_${progName}_${vName}`] = {
                    type: vType, c_symbol: cSym, defaultValue: initVal, ...vShmSlot
                };
                // Debug: expand array elements and struct members
                if (!isFB) {
                    const dtDef = dataTypeDefs[vType];
                    if (dtDef?.type === 'Array') {
                        const baseType = dtDef.content.baseType;
                        const elemSize = IEC_TYPE_SIZES[baseType.toUpperCase()] || 0;
                        dtDef.content.dimensions.forEach(dim => {
                            for (let i = parseInt(dim.min); i <= parseInt(dim.max); i++) {
                                const elemCSym = `${cSym}[${i}]`;
                                const elemShmSlot = tryAssignShm(baseType, elemCSym);
                                variableTable.debugDefaults[`prog_${progName}_${vName}[${i}]`] = {
                                    type: baseType, c_symbol: elemCSym,
                                    base_symbol: cSym, byte_offset: i * elemSize,
                                    defaultValue: 0, ...elemShmSlot
                                };
                            }
                        });
                    } else if (dtDef?.type === 'Structure') {
                        let memberOffset = 0;
                        (dtDef.content.members || []).forEach(member => {
                            const memCSym = `${cSym}.${member.name}`;
                            const memShmSlot = tryAssignShm(member.type, memCSym);
                            variableTable.debugDefaults[`prog_${progName}_${vName}.${member.name}`] = {
                                type: member.type, c_symbol: memCSym,
                                base_symbol: cSym, byte_offset: memberOffset,
                                defaultValue: 0, ...memShmSlot
                            };
                            memberOffset += IEC_TYPE_SIZES[member.type.toUpperCase()] || 0;
                        });
                    }
                }
            });
            // Collect shadow vars BEFORE transpiling so they can be declared before the function body
            const shadowVars = (prog.type === 'LD' || prog.type === 'SCL')
                ? collectShadowVars(prog.content?.rungs, progName)
                : [];
            // Declare shadow tracking globals in header
            shadowVars.forEach(sv => {
                header += `${mapType(sv.type)} ${sv.symbol};\n`;
                const shortKey = sv.symbol.replace(`prog_${progName}_`, '');
                variableTable.programs[progName].variables[shortKey] = {
                    type: sv.type,
                    c_symbol: sv.symbol,
                    initialValue: 0
                };
                const svShmSlot = tryAssignShm(sv.type, sv.symbol);
                variableTable.debugDefaults[`prog_${progName}_${shortKey}`] = {
                    type: sv.type,
                    c_symbol: sv.symbol,
                    defaultValue: 0,
                    ...svShmSlot
                };
            });

            // Collect input shadow vars — writable placeholders for unassigned/literal FB input pins
            const inputShadowVars = (prog.type === 'LD' || prog.type === 'SCL')
                ? collectInputShadowVars(prog.content?.rungs, progName)
                : [];
            inputShadowVars.forEach(sv => {
                const initPart = sv.initStr !== '0' ? ` = ${sv.initStr}` : '';
                header += `${mapType(sv.type)} ${sv.symbol}${initPart};\n`;
                const shortKey = sv.symbol.replace(`prog_${progName}_`, '');
                variableTable.programs[progName].variables[shortKey] = {
                    type: sv.type,
                    c_symbol: sv.symbol,
                    initialValue: sv.initVal
                };
                const isvShmSlot = tryAssignShm(sv.type, sv.symbol);
                variableTable.debugDefaults[`prog_${progName}_${shortKey}`] = {
                    type: sv.type,
                    c_symbol: sv.symbol,
                    defaultValue: sv.initVal,
                    ...isvShmSlot
                };
            });
            const inputShadowMap = new Map();
            inputShadowVars.forEach(sv => inputShadowMap.set(`${sv.instName}_${sv.editorPin}`, sv.symbol));

            // Collect variable names already declared (program vars + shadow vars)
            if (prog.type === 'LD') {
                const declaredVarNames = new Set();
                prog.content.variables.forEach(v => {
                    const vName = (v.name || '').trim().replace(/\s+/g, '_');
                    if (!isInlineMathType(v.type)) declaredVarNames.add(vName);
                });
                shadowVars.forEach(sv => {
                    const shortKey = sv.symbol.replace(`prog_${progName}_`, '');
                    declaredVarNames.add(shortKey);
                });
                // Variables referenced in pin fields but not declared in the
                // variable table are intentionally left undeclared so that the
                // C compiler emits an error, forcing the user to add them.
            }

            header += transpilePOUSource(prog, 'program', stdFunctions, progName, globalVarNames, inputShadowMap);
        });
    }

    header += `\n#endif // PLC_H\n`;

    // --- 5. EXEC TIME TRACKING VARS (declared before SHM so plc_shm_sync can reference them) ---
    const execTimeVars = (projectStructure.programs || []).map(p => {
        const pName = (p.name || '').trim().replace(/\s+/g, '_');
        const cSym = `__exec_us_${pName}`;
        const liveKey = `prog____exec_us_${pName}`;
        const shmSlot = tryAssignShm('UDINT', cSym);
        variableTable.debugDefaults[liveKey] = { type: 'UDINT', c_symbol: cSym, defaultValue: 0, ...shmSlot };
        source += `#if defined(__linux__) || defined(__APPLE__)\nstatic volatile uint32_t ${cSym} = 0;\n#endif\n`;
        return { progName: pName, cSym, liveKey };
    });

    // --- 6. BUILD SERVER VARIABLES ARRAY ---
    const IEC_TO_SERVER_TYPE = {
        'BOOL': 'bool',
        'SINT': 'uint8', 'USINT': 'uint8', 'BYTE': 'uint8',
        'INT': 'int16',
        'UINT': 'uint16', 'WORD': 'uint16',
        'DINT': 'int32',
        'UDINT': 'uint32', 'DWORD': 'uint32',
        'REAL': 'float32',
        'LREAL': 'float64',
        'TIME': 'uint32',
    };
    variableTable.variables = Object.entries(variableTable.debugDefaults)
        .filter(([, info]) => info.offset !== undefined)
        .map(([name, info]) => ({
            name,
            offset: info.offset,
            size: info.size,
            type: IEC_TO_SERVER_TYPE[info.type?.toUpperCase()] ?? 'int32',
            force_flag_offset: info.force_flag_offset,
        }));

    // --- 6. SHARED MEMORY SYNC (Linux only) ---
    variableTable.shmSize = shmOffset;
    if (shmEntries.length > 0) {
        source += `\n#if defined(__linux__)\n`;
        source += `#include <sys/mman.h>\n`;
        source += `#include <fcntl.h>\n`;
        source += `#define PLC_SHM_NAME "/plc_runtime"\n`;
        source += `#define PLC_SHM_SIZE 65536\n`;
        source += `static uint8_t *__plc_shm = NULL;\n`;
        source += `static void plc_shm_init(void) {\n`;
        source += `    int fd = shm_open(PLC_SHM_NAME, O_CREAT | O_RDWR, 0666);\n`;
        source += `    if (fd < 0) return;\n`;
        source += `    ftruncate(fd, PLC_SHM_SIZE);\n`;
        source += `    __plc_shm = (uint8_t *)mmap(NULL, PLC_SHM_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);\n`;
        source += `    if (__plc_shm == MAP_FAILED) __plc_shm = NULL;\n`;
        source += `    close(fd);\n`;
        source += `}\n`;
        source += `#define PLC_FORCE_FLAGS_BASE ${FORCE_FLAGS_BASE}\n`;
        source += `static void plc_shm_pull(void) {\n`;
        source += `    if (!__plc_shm) return;\n`;
        shmEntries.forEach(({ c_symbol, offset, size, flagOffset }) => {
            // Only pull variables that KronServer has explicitly force-written (flag != 0).
            // PLC-computed and literal-initialized variables keep their C values;
            // they are never overwritten by a zeroed or stale SHM region.
            source += `    if (__plc_shm[${flagOffset}] != 0) { memcpy(&(${c_symbol}), __plc_shm + ${offset}, ${size}); }\n`;
        });
        source += `}\n`;
        source += `static void plc_shm_sync(void) {\n`;
        source += `    if (!__plc_shm) return;\n`;
        shmEntries.forEach(({ c_symbol, offset, size, flagOffset }) => {
            // Skip writing to SHM if a force flag is set (KronServer holds the value).
            source += `    if (__plc_shm[${flagOffset}] == 0) { memcpy(__plc_shm + ${offset}, &(${c_symbol}), ${size}); }\n`;
        });
        source += `}\n`;
        source += `#endif /* __linux__ */\n\n`;
    }

    // --- 6. DETERMINISTIC SCAN LOOP ---
    if (deviceArtifacts.sourceSupport) {
        source += deviceArtifacts.sourceSupport;
    }
    const mainLoop = generateMainLoop(projectStructure, config, boardId, shmEntries.length > 0, execTimeVars, deviceArtifacts.initCode, deviceArtifacts.cleanupCode);
    source += mainLoop.src;
    variableTable.tasks = mainLoop.programTasks.map(pt => ({
        program: pt.name,
        interval_us: pt.intervalUs,
        interval: formatUsDisplay(pt.intervalUs),
        exec_time_key: `prog____exec_us_${pt.name}`,
    }));
    variableTable.base_tick_us = mainLoop.baseTickUs;
    variableTable.base_tick = formatUsDisplay(mainLoop.baseTickUs);

    // Cleanup: remove board-specific entries from module-level lookup tables
    _halSavedKeys.triggerPin.forEach(k => { delete FB_TRIGGER_PIN[k]; HAL_BLOCK_TYPES.delete(k); });
    _halSavedKeys.qOutput.forEach(k => delete FB_Q_OUTPUT[k]);
    _halSavedKeys.inputs.forEach(k => delete FB_INPUTS[k]);
    _halSavedKeys.outputs.forEach(k => delete FB_OUTPUTS[k]);
    _halSavedKeys.inputTypes.forEach(k => delete FB_INPUT_TYPES[k]);
    _deviceSavedKeys.triggerPin.forEach(k => { delete FB_TRIGGER_PIN[k]; HAL_BLOCK_TYPES.delete(k); });
    _deviceSavedKeys.qOutput.forEach(k => delete FB_Q_OUTPUT[k]);
    _deviceSavedKeys.inputs.forEach(k => delete FB_INPUTS[k]);
    _deviceSavedKeys.outputs.forEach(k => delete FB_OUTPUTS[k]);
    _deviceSavedKeys.inputTypes.forEach(k => delete FB_INPUT_TYPES[k]);
    _deviceSavedKeys.outputTypes.forEach(k => delete GENERATED_FB_OUTPUT_TYPES[k]);

    return { header, source, variableTable };
};

const isFBType = (type, structure) => {
    const t = (type || '').trim();
    return structure.functionBlocks?.some(fb => (fb.name || '').trim() === t);
};

const mapIECtoTimeUs = (iecTimeStr) => {
    if (!iecTimeStr) return 10000;
    const str = iecTimeStr.toUpperCase().replace('T#', '').replace('TIME#', '');
    if (str.endsWith('MS')) return parseInt(str.replace('MS', '')) * 1000;
    if (str.endsWith('US')) return parseInt(str.replace('US', ''));
    if (str.endsWith('S')) return parseInt(str.replace('S', '')) * 1000000;
    return 10000; // Default 10000us (10ms)
};

const formatUsDisplay = (us) => {
    if (us >= 1000000 && us % 1000000 === 0) return `${us / 1000000}s`;
    if (us >= 1000 && us % 1000 === 0) return `${us / 1000}ms`;
    return `${us}us`;
};



const generateMainLoop = (projectStructure, config, boardId = null, shmEnabled = false, execTimeVars = [], initCode = '', cleanupCode = '') => {
    let mainSrc = `\n// --- DETERMINISTIC SCAN LOOP ---\n`;

    // --- 1. Discover task→program groupings (priority: taskConfig > res_config > fallback) ---
    // taskGroups: [ { taskName, intervalUs, programs: [ progName, ... ] } ]
    let taskGroups = [];
    let programTasks = []; // flat: [ { name, intervalUs } ] for variableTable.tasks

    if (projectStructure.taskConfig?.tasks?.length > 0) {
        projectStructure.taskConfig.tasks.forEach(task => {
            const intervalUs = mapIECtoTimeUs(task.interval);
            const progs = [...(task.programs || [])]
                .sort((a, b) => a.priority - b.priority)
                .map(p => (p.program || '').trim().replace(/\s+/g, '_'))
                .filter(Boolean);
            if (progs.length > 0) {
                taskGroups.push({ taskName: (task.name || task.id).replace(/\s+/g, '_'), intervalUs, programs: progs });
            }
            progs.forEach(pName => {
                if (!programTasks.find(pt => pt.name === pName))
                    programTasks.push({ name: pName, intervalUs });
            });
        });
        // Unassigned programs → default task with 10ms
        const unassigned = (projectStructure.programs || [])
            .map(p => (p.name || '').trim().replace(/\s+/g, '_'))
            .filter(pName => !programTasks.find(pt => pt.name === pName));
        if (unassigned.length > 0) {
            taskGroups.push({ taskName: '__unassigned', intervalUs: 10000, programs: unassigned });
            unassigned.forEach(pName => programTasks.push({ name: pName, intervalUs: 10000 }));
        }
    } else if (config?.content?.instances?.length > 0) {
        // Legacy res_config tasks/instances — one flat group per task
        const legacyTaskMap = {};
        config.content.instances.forEach(inst => {
            const task = config.content.tasks?.find(t => t.name === inst.task);
            const pName = (inst.program || '').trim().replace(/\s+/g, '_');
            const intervalUs = task ? mapIECtoTimeUs(task.interval) : 10000;
            const tKey = inst.task || '__default';
            if (!legacyTaskMap[tKey]) legacyTaskMap[tKey] = { taskName: tKey.replace(/\s+/g, '_'), intervalUs, programs: [] };
            legacyTaskMap[tKey].programs.push(pName);
            programTasks.push({ name: pName, intervalUs });
        });
        taskGroups = Object.values(legacyTaskMap);
    } else {
        // No tasks configured — programs are NOT executed. Build will succeed but nothing runs.
        // (User must assign programs to tasks in Task Manager.)
    }

    // Base tick = minimum interval across all programs (minimum 1us) — used for baremetal/Win
    const baseTickUs = programTasks.length > 0
        ? Math.max(1, Math.min(...programTasks.map(pt => pt.intervalUs)))
        : 1000;

    // --- 2. Global shared state ---
    // us_tick is defined for ALL platforms.
    // Linux/Apple: updated from clock_gettime inside each task thread → always accurate.
    // Windows:     updated from QueryPerformanceCounter in the main loop.
    // Bare-metal:  must be incremented by a hardware timer ISR every ~${formatUsDisplay(baseTickUs)}.
    mainSrc += `volatile int plc_stop = 0;\n`;
    mainSrc += `volatile uint64_t us_tick = 0;\n\n`;
    mainSrc += `void PLC_Init(void) {\n`;
    if (boardId) {
        mainSrc += `    HAL_Init();\n`;
    }
    mainSrc += `    KRON_UART_RuntimeInit();\n`;
    if (initCode) {
        mainSrc += initCode;
    }
    mainSrc += `}\n\n`;
    mainSrc += `void PLC_Cleanup(void) {\n`;
    if (cleanupCode) {
        mainSrc += cleanupCode;
    }
    mainSrc += `    KRON_UART_RuntimeCleanup();\n`;
    if (boardId) {
        mainSrc += `    HAL_Cleanup();\n`;
    }
    mainSrc += `}\n\n`;

    // --- 3. Linux: one pthread function per task group ---
    mainSrc += `#if defined(__linux__)\n\n`;

    taskGroups.forEach(tg => {
        mainSrc += `static void* plc_task_${tg.taskName}(void *arg) {\n`;
        mainSrc += `    (void)arg;\n`;
        mainSrc += `    { struct sched_param __sp = { .sched_priority = sched_get_priority_max(SCHED_FIFO) };\n`;
        mainSrc += `      pthread_setschedparam(pthread_self(), SCHED_FIFO, &__sp); }\n`;
        mainSrc += `    struct timespec __next;\n`;
        mainSrc += `    clock_gettime(CLOCK_MONOTONIC, &__next);\n`;
        mainSrc += `    while (!plc_stop) {\n`;
        // Advance deadline
        mainSrc += `        __next.tv_nsec += ${tg.intervalUs * 1000}UL;\n`;
        mainSrc += `        while (__next.tv_nsec >= 1000000000L) { __next.tv_sec++; __next.tv_nsec -= 1000000000L; }\n`;
        // SHM pull
        if (shmEnabled) {
            mainSrc += `        plc_shm_pull();\n`;
        }
        // Sync us_tick to real wall-clock time so IEC timers (TON/TOF/TP) are accurate.
        // Without this, if program execution takes longer than the sleep, us_tick drifts
        // behind real time and all timers run proportionally slower.
        mainSrc += `        { struct timespec __ts; clock_gettime(CLOCK_MONOTONIC, &__ts);\n`;
        mainSrc += `          us_tick = (uint64_t)__ts.tv_sec * 1000000ULL + (uint64_t)__ts.tv_nsec / 1000ULL; }\n`;
        // Execute each program in priority order with exec time measurement
        tg.programs.forEach(pName => {
            const etv = execTimeVars.find(e => e.progName === pName);
            if (etv) {
                mainSrc += `        { struct timespec __t0, __t1;\n`;
                mainSrc += `          clock_gettime(CLOCK_MONOTONIC, &__t0);\n`;
                mainSrc += `          ${pName}();\n`;
                mainSrc += `          clock_gettime(CLOCK_MONOTONIC, &__t1);\n`;
                mainSrc += `          ${etv.cSym} = (uint32_t)((__t1.tv_sec - __t0.tv_sec) * 1000000UL + (__t1.tv_nsec - __t0.tv_nsec) / 1000UL); }\n`;
            } else {
                mainSrc += `        ${pName}();\n`;
            }
        });
        // SHM sync
        if (shmEnabled) {
            mainSrc += `        plc_shm_sync();\n`;
        }
        // Drift-free sleep to next deadline
        mainSrc += `        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &__next, NULL);\n`;
        mainSrc += `    }\n`;
        mainSrc += `    return NULL;\n`;
        mainSrc += `}\n\n`;
    });

    // Linux main(): spawn all task threads
    mainSrc += `int main() {\n`;
    mainSrc += `    { struct sched_param __sp = { .sched_priority = sched_get_priority_max(SCHED_FIFO) };\n`;
    mainSrc += `      sched_setscheduler(0, SCHED_FIFO, &__sp); }\n`;
    mainSrc += `    PLC_Init();\n`;
    if (shmEnabled) {
        mainSrc += `    plc_shm_init();\n`;
    }
    if (taskGroups.length > 0) {
        mainSrc += `    pthread_t __plc_threads[${taskGroups.length}];\n`;
        taskGroups.forEach((tg, i) => {
            mainSrc += `    pthread_create(&__plc_threads[${i}], NULL, plc_task_${tg.taskName}, NULL);\n`;
        });
        mainSrc += `    for (int i = 0; i < ${taskGroups.length}; i++) pthread_join(__plc_threads[i], NULL);\n`;
    }
    mainSrc += `    PLC_Cleanup();\n`;
    mainSrc += `    return 0;\n}\n\n`;

    // --- 4. Windows: cooperative timer wheel ---
    mainSrc += `#elif defined(_WIN32)\n\n`;
    mainSrc += `// Windows QPC declarations\n`;
    mainSrc += `int QueryPerformanceCounter(long long *lpPerformanceCount);\n`;
    mainSrc += `int QueryPerformanceFrequency(long long *lpFrequency);\n`;
    mainSrc += `static void __update_us_tick(void) {\n`;
    mainSrc += `    static long long __freq = 0, __origin = 0;\n`;
    mainSrc += `    if (!__freq) { QueryPerformanceFrequency(&__freq); QueryPerformanceCounter(&__origin); }\n`;
    mainSrc += `    long long __now; QueryPerformanceCounter(&__now);\n`;
    mainSrc += `    us_tick = (uint64_t)((__now - __origin) * 1000000LL / __freq);\n`;
    mainSrc += `}\n`;
    mainSrc += `int main() {\n`;
    mainSrc += `    SetPriorityClass(GetCurrentProcess(), REALTIME_PRIORITY_CLASS);\n`;
    mainSrc += `    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);\n`;
    mainSrc += `    PLC_Init();\n`;
    mainSrc += `    uint64_t __prev_us = 0;\n`;
    mainSrc += `    while (!plc_stop) {\n`;
    mainSrc += `        __update_us_tick();\n`;
    programTasks.forEach(pt => {
        mainSrc += `        if (us_tick / ${pt.intervalUs} != __prev_us / ${pt.intervalUs}) { ${pt.name}(); }\n`;
    });
    mainSrc += `        __prev_us = us_tick;\n`;
    mainSrc += `        Sleep(${Math.max(1, Math.floor(baseTickUs / 1000))});\n`;
    mainSrc += `    }\n`;
    mainSrc += `    PLC_Cleanup();\n`;
    mainSrc += `    return 0;\n}\n\n`;

    // --- 5. Bare-metal: cooperative timer wheel called from HAL ---
    mainSrc += `#else\n\n`;
    mainSrc += `// Bare-metal / RTOS-less execution engine.\n`;
    mainSrc += `// us_tick must be incremented by a hardware timer ISR every ${formatUsDisplay(baseTickUs)}.\n`;
    mainSrc += `void PLC_Run(void) {\n`;
    programTasks.forEach(pt => {
        mainSrc += `    if (us_tick % ${pt.intervalUs}ULL == 0) { ${pt.name}(); }\n`;
    });
    mainSrc += `}\n\n`;
    mainSrc += `#endif\n`;

    return { src: mainSrc, programTasks, baseTickUs };
};

const transpilePOUSource = (pou, category, stdFunctions = {}, parentName = '', globalVarNames = [], inputShadowMap = null) => {
    let src = ``;
    let safeName = (pou.name || '').trim().replace(/\s+/g, '_');
    let sig = `static inline void ${safeName}()`;

    if (category === 'function') {
        const retType = mapType(pou.returnType || 'VOID');
        sig = `static inline ${retType} ${safeName}()`;
    } else if (category === 'function_block') {
        sig = `static inline void ${safeName}_Execute(${safeName} *instance)`;
    }

    src += `${sig} {\n`;

    if (pou.type === 'ST') {
        // Build variable name map: IEC identifier → C symbol
        const varMap = {};
        (pou.content.variables || []).forEach(v => {
            const vName = (v.name || '').trim().replace(/\s+/g, '_');
            if (!vName) return;
            if (globalVarNames.includes(vName)) {
                varMap[vName] = vName; // global vars: no prefix
            } else if (category === 'program') {
                const isFB = stdFunctions[v.type] !== undefined || HAL_BLOCK_TYPES.has(v.type);
                varMap[vName] = isFB
                    ? `prog_${parentName}_inst_${vName}`
                    : `prog_${parentName}_${vName}`;
            } else if (category === 'function_block') {
                varMap[vName] = `instance->${vName}`;
            } else {
                varMap[vName] = vName;
            }
        });
        src += transpileSTLogics(pou.content.code, stdFunctions, parentName, category, varMap);
    } else if (pou.type === 'LD') {
        src += transpileLDLogics(pou.content.rungs, stdFunctions, safeName, category, globalVarNames, inputShadowMap);
    } else if (pou.type === 'SCL') {
        // SCL: mixed LD/ST per rung. Each rung carries a `lang` field ('LD' or 'ST').
        (pou.content.rungs || []).forEach(rung => {
            if (rung.lang === 'ST') {
                const varMap = {};
                (pou.content.variables || []).forEach(v => {
                    const vName = (v.name || '').trim().replace(/\s+/g, '_');
                    if (!vName) return;
                    if (globalVarNames.includes(vName)) { varMap[vName] = vName; }
                    else if (category === 'program') {
                        const isFB = stdFunctions[v.type] !== undefined || HAL_BLOCK_TYPES.has(v.type);
                        varMap[vName] = isFB ? `prog_${parentName}_inst_${vName}` : `prog_${parentName}_${vName}`;
                    } else if (category === 'function_block') { varMap[vName] = `instance->${vName}`; }
                    else { varMap[vName] = vName; }
                });
                src += `    // SCL rung [ST]\n`;
                src += transpileSTLogics(rung.code || '', stdFunctions, parentName, category, varMap);
            } else {
                // Default: treat as LD rung
                src += `    // SCL rung [LD]\n`;
                src += transpileLDLogics([rung], stdFunctions, safeName, category, globalVarNames, inputShadowMap);
            }
        });
    }

    src += `}\n\n`;
    return src;
};

// --- LD Block Type Definitions (mirrors blockConfig in RungContainer) ---
// Trigger (first/power-flow) input pin for each standard FB type
const FB_TRIGGER_PIN = {
    // Timers
    'TON': 'IN', 'TOF': 'IN', 'TP': 'IN', 'TONR': 'IN',
    // Counters
    'CTU': 'CU', 'CTD': 'CD', 'CTUD': 'CU',
    // Edge detectors
    'R_TRIG': 'CLK', 'F_TRIG': 'CLK',
    // Generic communication runtime FBs
    'I2C_WriteRead': 'Execute', 'SPI_Transfer': 'Execute', 'UART_Send': 'Execute', 'UART_Receive': 'Enable',
    // Comparison / Arithmetic / Math / Bitwise / Trig / Selection / Conversion — EN is the power-flow input
    'GT': 'EN', 'GE': 'EN', 'EQ': 'EN', 'NE': 'EN', 'LE': 'EN', 'LT': 'EN',
    'ADD': 'EN', 'SUB': 'EN', 'MUL': 'EN', 'DIV': 'EN', 'MOD': 'EN', 'MOVE': 'EN',
    'ABS': 'EN', 'SQRT': 'EN', 'EXPT': 'EN', 'MAX': 'EN', 'MIN': 'EN', 'LIMIT': 'EN',
    'BAND': 'EN', 'BOR': 'EN', 'BXOR': 'EN', 'BNOT': 'EN',
    'SHL': 'EN', 'SHR': 'EN', 'ROL': 'EN', 'ROR': 'EN',
    'SIN': 'EN', 'COS': 'EN', 'TAN': 'EN', 'ASIN': 'EN', 'ACOS': 'EN', 'ATAN': 'EN',
    'SEL': 'EN', 'MUX': 'EN',
    // Conversion (all 72 — EN is trigger)
    'BYTE_TO_BOOL': 'EN', 'WORD_TO_BOOL': 'EN', 'DWORD_TO_BOOL': 'EN', 'INT_TO_BOOL': 'EN',
    'UINT_TO_BOOL': 'EN', 'DINT_TO_BOOL': 'EN', 'UDINT_TO_BOOL': 'EN', 'REAL_TO_BOOL': 'EN',
    'BOOL_TO_BYTE': 'EN', 'WORD_TO_BYTE': 'EN', 'DWORD_TO_BYTE': 'EN', 'INT_TO_BYTE': 'EN',
    'UINT_TO_BYTE': 'EN', 'DINT_TO_BYTE': 'EN', 'UDINT_TO_BYTE': 'EN', 'REAL_TO_BYTE': 'EN',
    'BOOL_TO_WORD': 'EN', 'BYTE_TO_WORD': 'EN', 'DWORD_TO_WORD': 'EN', 'INT_TO_WORD': 'EN',
    'UINT_TO_WORD': 'EN', 'DINT_TO_WORD': 'EN', 'UDINT_TO_WORD': 'EN', 'REAL_TO_WORD': 'EN',
    'BOOL_TO_DWORD': 'EN', 'BYTE_TO_DWORD': 'EN', 'WORD_TO_DWORD': 'EN', 'INT_TO_DWORD': 'EN',
    'UINT_TO_DWORD': 'EN', 'DINT_TO_DWORD': 'EN', 'UDINT_TO_DWORD': 'EN', 'REAL_TO_DWORD': 'EN',
    'BOOL_TO_INT': 'EN', 'BYTE_TO_INT': 'EN', 'WORD_TO_INT': 'EN', 'DWORD_TO_INT': 'EN',
    'UINT_TO_INT': 'EN', 'DINT_TO_INT': 'EN', 'UDINT_TO_INT': 'EN', 'REAL_TO_INT': 'EN',
    'BOOL_TO_UINT': 'EN', 'BYTE_TO_UINT': 'EN', 'WORD_TO_UINT': 'EN', 'DWORD_TO_UINT': 'EN',
    'INT_TO_UINT': 'EN', 'DINT_TO_UINT': 'EN', 'UDINT_TO_UINT': 'EN', 'REAL_TO_UINT': 'EN',
    'BOOL_TO_DINT': 'EN', 'BYTE_TO_DINT': 'EN', 'WORD_TO_DINT': 'EN', 'DWORD_TO_DINT': 'EN',
    'INT_TO_DINT': 'EN', 'UINT_TO_DINT': 'EN', 'UDINT_TO_DINT': 'EN', 'REAL_TO_DINT': 'EN',
    'BOOL_TO_UDINT': 'EN', 'BYTE_TO_UDINT': 'EN', 'WORD_TO_UDINT': 'EN', 'DWORD_TO_UDINT': 'EN',
    'INT_TO_UDINT': 'EN', 'UINT_TO_UDINT': 'EN', 'DINT_TO_UDINT': 'EN', 'REAL_TO_UDINT': 'EN',
    'BOOL_TO_REAL': 'EN', 'BYTE_TO_REAL': 'EN', 'WORD_TO_REAL': 'EN', 'DWORD_TO_REAL': 'EN',
    'INT_TO_REAL': 'EN', 'UINT_TO_REAL': 'EN', 'DINT_TO_REAL': 'EN', 'UDINT_TO_REAL': 'EN',
    'NORM_X': 'EN', 'SCALE_X': 'EN'
};

// Primary boolean output pin for downstream power flow
const FB_Q_OUTPUT = {
    // Timers
    'TON': 'Q', 'TOF': 'Q', 'TP': 'Q', 'TONR': 'Q',
    // Counters
    'CTU': 'Q', 'CTD': 'Q', 'CTUD': 'QU',
    // Edge detectors
    'R_TRIG': 'Q', 'F_TRIG': 'Q',
    // Generic communication runtime FBs
    'I2C_WriteRead': 'Done', 'SPI_Transfer': 'Done', 'UART_Send': 'Done', 'UART_Receive': 'NewData',
    // Bistable
    'RS': 'Q1', 'SR': 'Q1',
    // Comparison: ENO = EN && (result) — acts as conditional power flow
    'GT': 'ENO', 'GE': 'ENO', 'EQ': 'ENO', 'NE': 'ENO', 'LE': 'ENO', 'LT': 'ENO',
    // Arithmetic / Math / Bitwise / Trig / Selection / Conversion: ENO = EN — passes power through
    'ADD': 'ENO', 'SUB': 'ENO', 'MUL': 'ENO', 'DIV': 'ENO', 'MOD': 'ENO', 'MOVE': 'ENO',
    'ABS': 'ENO', 'SQRT': 'ENO', 'EXPT': 'ENO', 'MAX': 'ENO', 'MIN': 'ENO', 'LIMIT': 'ENO',
    'BAND': 'ENO', 'BOR': 'ENO', 'BXOR': 'ENO', 'BNOT': 'ENO',
    'SHL': 'ENO', 'SHR': 'ENO', 'ROL': 'ENO', 'ROR': 'ENO',
    'SIN': 'ENO', 'COS': 'ENO', 'TAN': 'ENO', 'ASIN': 'ENO', 'ACOS': 'ENO', 'ATAN': 'ENO',
    'SEL': 'ENO', 'MUX': 'ENO',
    // Conversion (all 72 — ENO passes power through)
    'BYTE_TO_BOOL': 'ENO', 'WORD_TO_BOOL': 'ENO', 'DWORD_TO_BOOL': 'ENO', 'INT_TO_BOOL': 'ENO',
    'UINT_TO_BOOL': 'ENO', 'DINT_TO_BOOL': 'ENO', 'UDINT_TO_BOOL': 'ENO', 'REAL_TO_BOOL': 'ENO',
    'BOOL_TO_BYTE': 'ENO', 'WORD_TO_BYTE': 'ENO', 'DWORD_TO_BYTE': 'ENO', 'INT_TO_BYTE': 'ENO',
    'UINT_TO_BYTE': 'ENO', 'DINT_TO_BYTE': 'ENO', 'UDINT_TO_BYTE': 'ENO', 'REAL_TO_BYTE': 'ENO',
    'BOOL_TO_WORD': 'ENO', 'BYTE_TO_WORD': 'ENO', 'DWORD_TO_WORD': 'ENO', 'INT_TO_WORD': 'ENO',
    'UINT_TO_WORD': 'ENO', 'DINT_TO_WORD': 'ENO', 'UDINT_TO_WORD': 'ENO', 'REAL_TO_WORD': 'ENO',
    'BOOL_TO_DWORD': 'ENO', 'BYTE_TO_DWORD': 'ENO', 'WORD_TO_DWORD': 'ENO', 'INT_TO_DWORD': 'ENO',
    'UINT_TO_DWORD': 'ENO', 'DINT_TO_DWORD': 'ENO', 'UDINT_TO_DWORD': 'ENO', 'REAL_TO_DWORD': 'ENO',
    'BOOL_TO_INT': 'ENO', 'BYTE_TO_INT': 'ENO', 'WORD_TO_INT': 'ENO', 'DWORD_TO_INT': 'ENO',
    'UINT_TO_INT': 'ENO', 'DINT_TO_INT': 'ENO', 'UDINT_TO_INT': 'ENO', 'REAL_TO_INT': 'ENO',
    'BOOL_TO_UINT': 'ENO', 'BYTE_TO_UINT': 'ENO', 'WORD_TO_UINT': 'ENO', 'DWORD_TO_UINT': 'ENO',
    'INT_TO_UINT': 'ENO', 'DINT_TO_UINT': 'ENO', 'UDINT_TO_UINT': 'ENO', 'REAL_TO_UINT': 'ENO',
    'BOOL_TO_DINT': 'ENO', 'BYTE_TO_DINT': 'ENO', 'WORD_TO_DINT': 'ENO', 'DWORD_TO_DINT': 'ENO',
    'INT_TO_DINT': 'ENO', 'UINT_TO_DINT': 'ENO', 'UDINT_TO_DINT': 'ENO', 'REAL_TO_DINT': 'ENO',
    'BOOL_TO_UDINT': 'ENO', 'BYTE_TO_UDINT': 'ENO', 'WORD_TO_UDINT': 'ENO', 'DWORD_TO_UDINT': 'ENO',
    'INT_TO_UDINT': 'ENO', 'UINT_TO_UDINT': 'ENO', 'DINT_TO_UDINT': 'ENO', 'REAL_TO_UDINT': 'ENO',
    'BOOL_TO_REAL': 'ENO', 'BYTE_TO_REAL': 'ENO', 'WORD_TO_REAL': 'ENO', 'DWORD_TO_REAL': 'ENO',
    'INT_TO_REAL': 'ENO', 'UINT_TO_REAL': 'ENO', 'DINT_TO_REAL': 'ENO', 'UDINT_TO_REAL': 'ENO',
    'NORM_X': 'ENO', 'SCALE_X': 'ENO'
};

const GENERATED_FB_OUTPUT_TYPES = {};

// Returns the IEC type of an output pin for a given block type
// customData is optional — used for user-defined FB output pin types
const getOutputPinType = (blockType, pinName, customData) => {
    if (['Q', 'Q1', 'QU', 'QD', 'ENO'].includes(pinName)) return 'BOOL';
    if (blockType === 'UART_Receive' && pinName === 'ReceivedLength') return 'UINT';
    if (GENERATED_FB_OUTPUT_TYPES[blockType]?.[pinName]) return GENERATED_FB_OUTPUT_TYPES[blockType][pinName];
    if (pinName === 'ET') return 'TIME';
    if (pinName === 'CV') return 'INT';
    if (pinName === 'OUT') {
        const m = blockType.match(/_TO_([A-Z]+)$/);
        if (m) return m[1];
        if (['ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'MOVE', 'SEL', 'MUX'].includes(blockType)) return 'DINT';
        if (['ABS', 'SQRT', 'EXPT', 'MAX', 'MIN', 'LIMIT', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'NORM_X', 'SCALE_X'].includes(blockType)) return 'REAL';
        if (['BAND', 'BOR', 'BXOR', 'BNOT', 'SHL', 'SHR', 'ROL', 'ROR'].includes(blockType)) return 'DWORD';
    }
    // User-defined FB: look up actual type from customData variables
    if (customData?.content?.variables) {
        const varDef = customData.content.variables.find(v => v.name === pinName);
        if (varDef) return varDef.type || 'BOOL';
    }
    // Board/HAL blocks: customData has outputs[] directly
    if (customData?.outputs) {
        const outDef = customData.outputs.find(o => o.name === pinName);
        if (outDef) return outDef.type || 'BOOL';
    }
    return 'BOOL';
};

// Pre-scan rungs and collect shadow variables for unassigned FB output pins.
// These become global C variables so the simulator can track them.
const collectShadowVars = (rungs, progName) => {
    const seen = new Set();
    const vars = [];
    (rungs || []).forEach(rung => {
        (rung.blocks || []).forEach(b => {
            const type = (b.type || '').trim();
            const data = b.data || {};
            if (type === 'Contact' || type === 'Coil') return;
            if (isInlineMathType(type)) return; // Inline math — no shadow vars
            const instName = (data.instanceName || type).trim().replace(/\s+/g, '_');
            const outPins = [
                ...(FB_OUTPUTS[type] || []),
                ...(data.customData?.content?.variables || [])
                    .filter(v => v.class === 'Output').map(v => v.name)
            ];
            outPins.forEach(pinName => {
                const sym = `prog_${progName}_out_${instName}_${pinName}`;
                if (!seen.has(sym)) {
                    seen.add(sym);
                    vars.push({ symbol: sym, type: getOutputPinType(type, pinName, data.customData) });
                }
            });
        });
    });
    return vars;
};

// Collect writable input shadow variables for unassigned/literal FB input pins.
// Returns shadow entries with initial values so the simulator can track and write them.
const collectInputShadowVars = (rungs, progName) => {
    const seen = new Set();
    const vars = [];
    const isVarRef = (val) => {
        if (!val) return false;
        const v = (val + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
        if (isBooleanLiteral(v)) return false;
        if (/^ADR\s*\(.+\)$/i.test(v)) return true;
        if (/^NULL$/i.test(v)) return true;
        return v.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(v);
    };
    (rungs || []).forEach(rung => {
        (rung.blocks || []).forEach(b => {
            const type = (b.type || '').trim();
            if (!FB_INPUT_TYPES[type]) return;
            const data = b.data || {};
            const instName = (data.instanceName || type).trim().replace(/\s+/g, '_');
            const pinTypes = FB_INPUT_TYPES[type];
            Object.entries(pinTypes).forEach(([editorPin, iecType]) => {
                if (isPointerInputType(iecType)) return;
                const rawVal = data.values?.[editorPin];
                if (isVarRef(rawVal)) return;
                const sym = `prog_${progName}_in_${instName}_${editorPin}`;
                if (seen.has(sym)) return;
                seen.add(sym);
                const cleanVal = rawVal ? (rawVal + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                let initStr = '0';
                let initVal = 0;
                if (cleanVal) {
                    if (iecType === 'TIME') {
                        const us = mapIECtoTimeUs(cleanVal);
                        initStr = String(us);
                        initVal = us;
                    } else if (/^-?\d+(\.\d+)?$/.test(cleanVal)) {
                        initStr = cleanVal;
                        initVal = parseFloat(cleanVal);
                    } else if (isBooleanLiteral(cleanVal)) {
                        initStr = normalizeBooleanLiteral(cleanVal) || 'false';
                        initVal = initStr === 'true' ? 1 : 0;
                    }
                }
                vars.push({ symbol: sym, type: iecType, instName, editorPin, initStr, initVal });
            });
        });
    });
    return vars;
};

// Scan all blocks for variable references in pin fields that are not yet declared.
// Returns shadow-style entries so the caller can declare them in the header.
const collectUndeclaredPinVars = (rungs, progName, declaredVarNames, globalVarNames) => {
    const seen = new Set();
    const vars = [];
    const idRegex = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/;
    const isLiteral = (s) =>
        /^-?[0-9]/.test(s) || /^(true|false)$/i.test(s) ||
        s.toUpperCase().startsWith('T#') || s.toUpperCase().startsWith('TIME#');

    (rungs || []).forEach(rung => {
        (rung.blocks || []).forEach(b => {
            const type = (b.type || '').trim();
            const data = b.data || {};
            const vals = data.values || {};

            // Contact/Coil variable references
            if (type === 'Contact' || type === 'Coil') {
                const pinKey = type === 'Contact' ? 'var' : 'coil';
                const raw = (vals[pinKey] || data.instanceName || '') + '';
                const v = raw.replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
                if (v && idRegex.test(v) && !isLiteral(v)) {
                    const baseName = v.split(/[.[]/)[0];
                    if (!globalVarNames.includes(baseName) && !declaredVarNames.has(baseName) && !seen.has(baseName)) {
                        seen.add(baseName);
                        vars.push({ symbol: `prog_${progName}_${baseName}`, type: 'BOOL' });
                    }
                }
                return;
            }

            // All other blocks — scan every pin value
            Object.entries(vals).forEach(([pinName, rawVal]) => {
                const v = rawVal ? (rawVal + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                if (!v || !idRegex.test(v) || isLiteral(v)) return;
                const baseName = v.split(/[.[]/)[0];
                if (globalVarNames.includes(baseName) || declaredVarNames.has(baseName) || seen.has(baseName)) return;
                seen.add(baseName);
                const pinType = getOutputPinType(type, pinName);
                vars.push({ symbol: `prog_${progName}_${baseName}`, type: pinType });
            });
        });
    });
    return vars;
};

// Output pin names for each standard FB type (used to separate read-back assignments)
const FB_OUTPUTS = {
    'TON': ['Q', 'ET'], 'TOF': ['Q', 'ET'], 'TP': ['Q', 'ET'], 'TONR': ['Q', 'ET'],
    'CTU': ['Q', 'CV'], 'CTD': ['Q', 'CV'], 'CTUD': ['QU', 'QD', 'CV'],
    'SR': ['Q1'], 'RS': ['Q1'],
    'R_TRIG': ['Q'], 'F_TRIG': ['Q'],
    'I2C_WriteRead': ['Done', 'Busy', 'Error'],
    'SPI_Transfer': ['Done', 'Busy', 'Error'],
    'UART_Send': ['Done', 'Busy', 'Error'],
    'UART_Receive': ['NewData', 'ReceivedLength', 'Error'],
    // Comparison — ENO (power-flow) + Q (raw comparison result)
    'GT': ['ENO', 'Q'], 'GE': ['ENO', 'Q'], 'EQ': ['ENO', 'Q'], 'NE': ['ENO', 'Q'], 'LE': ['ENO', 'Q'], 'LT': ['ENO', 'Q'],
    // Arithmetic / Math / Bitwise / Trig / Selection — ENO + OUT
    'ADD': ['ENO', 'OUT'], 'SUB': ['ENO', 'OUT'], 'MUL': ['ENO', 'OUT'],
    'DIV': ['ENO', 'OUT'], 'MOD': ['ENO', 'OUT'], 'MOVE': ['ENO', 'OUT'],
    'ABS': ['ENO', 'OUT'], 'SQRT': ['ENO', 'OUT'], 'EXPT': ['ENO', 'OUT'],
    'MAX': ['ENO', 'OUT'], 'MIN': ['ENO', 'OUT'], 'LIMIT': ['ENO', 'OUT'],
    'BAND': ['ENO', 'OUT'], 'BOR': ['ENO', 'OUT'], 'BXOR': ['ENO', 'OUT'], 'BNOT': ['ENO', 'OUT'],
    'SHL': ['ENO', 'OUT'], 'SHR': ['ENO', 'OUT'], 'ROL': ['ENO', 'OUT'], 'ROR': ['ENO', 'OUT'],
    'SIN': ['ENO', 'OUT'], 'COS': ['ENO', 'OUT'], 'TAN': ['ENO', 'OUT'],
    'ASIN': ['ENO', 'OUT'], 'ACOS': ['ENO', 'OUT'], 'ATAN': ['ENO', 'OUT'],
    'SEL': ['ENO', 'OUT'], 'MUX': ['ENO', 'OUT'],
    'NORM_X': ['ENO', 'OUT'], 'SCALE_X': ['ENO', 'OUT'],
};
// All conversion blocks (X_TO_Y) share ['ENO', 'OUT'] — built dynamically below
Object.keys(FB_OUTPUTS).length; // dummy to close initializer
['BOOL', 'BYTE', 'WORD', 'DWORD', 'INT', 'UINT', 'DINT', 'UDINT', 'REAL'].forEach(src => {
    ['BOOL', 'BYTE', 'WORD', 'DWORD', 'INT', 'UINT', 'DINT', 'UDINT', 'REAL'].forEach(dst => {
        if (src !== dst) FB_OUTPUTS[`${src}_TO_${dst}`] = ['ENO', 'OUT'];
    });
});

// ── Math FB blocks: use struct-based _Call from kronmath.h ──
// All integer-only, no EN/ENO fields. Struct type names may differ from block type.
const MATH_FB_BLOCKS = new Set([
    'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'MOVE', 'ABS',
    'SQRT', 'EXPT', 'NEG', 'AVG',
    'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN'
]);
// Map block type → C struct type name (only where they differ)
const MATH_FB_STRUCT = {
    'ABS': 'ABS_FB', 'SQRT': 'SQRT_FB', 'MIN': 'MIN_FB', 'MAX': 'MAX_FB',
};
// Blocks with array inputs: IN[KRON_MATH_MAX_IN] + N count
const MATH_FB_ARRAY_INPUT = new Set(['ADD', 'MUL', 'MIN', 'MAX', 'AVG']);
// Map editor pin names → struct member names (only where they differ)
const MATH_FB_PIN_MAP = {
    'EXPT': { 'IN': 'IN1', 'EXP': 'IN2' },
};

// ── Inline KRON_ functions (kroncompare.h) — still use direct function calls ──
const KRON_FN = {
    // Comparison (kroncompare.h)
    'GT': 'KRON_GT', 'GE': 'KRON_GE', 'EQ': 'KRON_EQ',
    'NE': 'KRON_NE', 'LE': 'KRON_LE', 'LT': 'KRON_LT',
    // Selection (kroncompare.h)
    'SEL': 'KRON_SEL', 'MUX': 'KRON_MUX',
    // Range (kroncompare.h)
    'MAX': 'KRON_MAX', 'MIN': 'KRON_MIN', 'LIMIT': 'KRON_LIMIT',
};
// Bitwise — use C operators directly
const BITWISE_OP = {
    'BAND': '&', 'BOR': '|', 'BXOR': '^', 'BNOT': '~',
    'SHL': '<<', 'SHR': '>>', 'ROL': '<<', 'ROR': '>>',
};
// Tracks HAL block types registered transiently during transpileToC.
// These have EN trigger pins but require persistent instance variables and
// _Call functions — they must NOT be treated as stateless inline blocks.
const HAL_BLOCK_TYPES = new Set();

// Returns true for EN-trigger stateless blocks that should be inlined.
// HAL blocks (GPIO_Read, PWM0, etc.) are excluded even though their trigger is EN.
const isInlineMathType = (type) => FB_TRIGGER_PIN[type] === 'EN' && !HAL_BLOCK_TYPES.has(type);

// Ordered input pin names for each standard FB type (index matches in_0, in_1, ...)
const FB_INPUTS = {
    'TON': ['IN', 'PT'],
    'TOF': ['IN', 'PT'],
    'TP': ['IN', 'PT'],
    'TONR': ['IN', 'PT', 'RESET'],
    'CTU': ['CU', 'R', 'PV'],
    'CTD': ['CD', 'LD', 'PV'],
    'CTUD': ['CU', 'CD', 'R', 'LD', 'PV'],
    'R_TRIG': ['CLK'],
    'F_TRIG': ['CLK'],
    'I2C_WriteRead': ['Execute', 'Port_ID', 'Device_Address', 'Register_Address', 'pTxBuffer', 'TxLength', 'pRxBuffer', 'RxLength'],
    'SPI_Transfer': ['Execute', 'Port_ID', 'pTxBuffer', 'pRxBuffer', 'Length'],
    'UART_Send': ['Execute', 'Port_ID', 'pTxBuffer', 'Length'],
    'UART_Receive': ['Enable', 'Port_ID', 'pRxBuffer', 'MaxSize'],
    'RS': ['S', 'R1'],
    'SR': ['S1', 'R'],
    // Comparison
    'GT': ['EN', 'IN1', 'IN2'], 'GE': ['EN', 'IN1', 'IN2'], 'EQ': ['EN', 'IN1', 'IN2'],
    'NE': ['EN', 'IN1', 'IN2'], 'LE': ['EN', 'IN1', 'IN2'], 'LT': ['EN', 'IN1', 'IN2'],
    // Arithmetic
    'ADD': ['EN', 'IN1', 'IN2'], 'SUB': ['EN', 'IN1', 'IN2'],
    'MUL': ['EN', 'IN1', 'IN2'], 'DIV': ['EN', 'IN1', 'IN2'],
    'MOD': ['EN', 'IN1', 'IN2'], 'MOVE': ['EN', 'IN'],
    // Math
    'ABS': ['EN', 'IN'], 'SQRT': ['EN', 'IN'],
    'EXPT': ['EN', 'IN', 'EXP'],
    'MAX': ['EN', 'IN1', 'IN2'], 'MIN': ['EN', 'IN1', 'IN2'],
    'LIMIT': ['EN', 'IN', 'MN', 'MX'],
    // Bitwise
    'BAND': ['EN', 'IN1', 'IN2'], 'BOR': ['EN', 'IN1', 'IN2'],
    'BXOR': ['EN', 'IN1', 'IN2'], 'BNOT': ['EN', 'IN'],
    'SHL': ['EN', 'IN', 'N'], 'SHR': ['EN', 'IN', 'N'],
    'ROL': ['EN', 'IN', 'N'], 'ROR': ['EN', 'IN', 'N'],
    // Trig
    'SIN': ['EN', 'IN'], 'COS': ['EN', 'IN'], 'TAN': ['EN', 'IN'],
    'ASIN': ['EN', 'IN'], 'ACOS': ['EN', 'IN'], 'ATAN': ['EN', 'IN'],
    // Selection
    'SEL': ['EN', 'G', 'IN0', 'IN1'],
    'MUX': ['EN', 'K', 'IN0', 'IN1'],
    // Conversion (all 72 — ['EN', 'IN'] pattern)
    'BYTE_TO_BOOL': ['EN', 'IN'], 'WORD_TO_BOOL': ['EN', 'IN'], 'DWORD_TO_BOOL': ['EN', 'IN'],
    'INT_TO_BOOL': ['EN', 'IN'], 'UINT_TO_BOOL': ['EN', 'IN'], 'DINT_TO_BOOL': ['EN', 'IN'],
    'UDINT_TO_BOOL': ['EN', 'IN'], 'REAL_TO_BOOL': ['EN', 'IN'],
    'BOOL_TO_BYTE': ['EN', 'IN'], 'WORD_TO_BYTE': ['EN', 'IN'], 'DWORD_TO_BYTE': ['EN', 'IN'],
    'INT_TO_BYTE': ['EN', 'IN'], 'UINT_TO_BYTE': ['EN', 'IN'], 'DINT_TO_BYTE': ['EN', 'IN'],
    'UDINT_TO_BYTE': ['EN', 'IN'], 'REAL_TO_BYTE': ['EN', 'IN'],
    'BOOL_TO_WORD': ['EN', 'IN'], 'BYTE_TO_WORD': ['EN', 'IN'], 'DWORD_TO_WORD': ['EN', 'IN'],
    'INT_TO_WORD': ['EN', 'IN'], 'UINT_TO_WORD': ['EN', 'IN'], 'DINT_TO_WORD': ['EN', 'IN'],
    'UDINT_TO_WORD': ['EN', 'IN'], 'REAL_TO_WORD': ['EN', 'IN'],
    'BOOL_TO_DWORD': ['EN', 'IN'], 'BYTE_TO_DWORD': ['EN', 'IN'], 'WORD_TO_DWORD': ['EN', 'IN'],
    'INT_TO_DWORD': ['EN', 'IN'], 'UINT_TO_DWORD': ['EN', 'IN'], 'DINT_TO_DWORD': ['EN', 'IN'],
    'UDINT_TO_DWORD': ['EN', 'IN'], 'REAL_TO_DWORD': ['EN', 'IN'],
    'BOOL_TO_INT': ['EN', 'IN'], 'BYTE_TO_INT': ['EN', 'IN'], 'WORD_TO_INT': ['EN', 'IN'],
    'DWORD_TO_INT': ['EN', 'IN'], 'UINT_TO_INT': ['EN', 'IN'], 'DINT_TO_INT': ['EN', 'IN'],
    'UDINT_TO_INT': ['EN', 'IN'], 'REAL_TO_INT': ['EN', 'IN'],
    'BOOL_TO_UINT': ['EN', 'IN'], 'BYTE_TO_UINT': ['EN', 'IN'], 'WORD_TO_UINT': ['EN', 'IN'],
    'DWORD_TO_UINT': ['EN', 'IN'], 'INT_TO_UINT': ['EN', 'IN'], 'DINT_TO_UINT': ['EN', 'IN'],
    'UDINT_TO_UINT': ['EN', 'IN'], 'REAL_TO_UINT': ['EN', 'IN'],
    'BOOL_TO_DINT': ['EN', 'IN'], 'BYTE_TO_DINT': ['EN', 'IN'], 'WORD_TO_DINT': ['EN', 'IN'],
    'DWORD_TO_DINT': ['EN', 'IN'], 'INT_TO_DINT': ['EN', 'IN'], 'UINT_TO_DINT': ['EN', 'IN'],
    'UDINT_TO_DINT': ['EN', 'IN'], 'REAL_TO_DINT': ['EN', 'IN'],
    'BOOL_TO_UDINT': ['EN', 'IN'], 'BYTE_TO_UDINT': ['EN', 'IN'], 'WORD_TO_UDINT': ['EN', 'IN'],
    'DWORD_TO_UDINT': ['EN', 'IN'], 'INT_TO_UDINT': ['EN', 'IN'], 'UINT_TO_UDINT': ['EN', 'IN'],
    'DINT_TO_UDINT': ['EN', 'IN'], 'REAL_TO_UDINT': ['EN', 'IN'],
    'BOOL_TO_REAL': ['EN', 'IN'], 'BYTE_TO_REAL': ['EN', 'IN'], 'WORD_TO_REAL': ['EN', 'IN'],
    'DWORD_TO_REAL': ['EN', 'IN'], 'INT_TO_REAL': ['EN', 'IN'], 'UINT_TO_REAL': ['EN', 'IN'],
    'DINT_TO_REAL': ['EN', 'IN'], 'UDINT_TO_REAL': ['EN', 'IN'],
    // Scaling
    'NORM_X': ['EN', 'MIN', 'MAX', 'VALUE'],
    'SCALE_X': ['EN', 'MIN', 'MAX', 'VALUE']
};

// Maps editor-facing pin names to actual C struct member names where they differ
const FB_C_PIN_NAME = {
    'CTU':  { 'R': 'RESET' },
    'CTUD': { 'R': 'RESET' },
};
// Returns the C struct member name for a given editor pin name and block type
const cStructPin = (blockType, editorPin) => FB_C_PIN_NAME[blockType]?.[editorPin] ?? editorPin;

// IEC type of each non-trigger input pin for standard FBs (for input shadow var generation)
const FB_INPUT_TYPES = {
    'I2C_WriteRead': { 'Port_ID': 'USINT', 'Device_Address': 'USINT', 'Register_Address': 'USINT', 'pTxBuffer': 'POINTER', 'TxLength': 'UINT', 'pRxBuffer': 'POINTER', 'RxLength': 'UINT' },
    'SPI_Transfer': { 'Port_ID': 'USINT', 'pTxBuffer': 'POINTER', 'pRxBuffer': 'POINTER', 'Length': 'UINT' },
    'UART_Send': { 'Port_ID': 'USINT', 'pTxBuffer': 'POINTER', 'Length': 'UINT' },
    'UART_Receive': { 'Port_ID': 'USINT', 'pRxBuffer': 'POINTER', 'MaxSize': 'UINT' },
    'TON':   { 'PT': 'TIME' },
    'TOF':   { 'PT': 'TIME' },
    'TP':    { 'PT': 'TIME' },
    'TONR':  { 'PT': 'TIME', 'RESET': 'BOOL' },
    'CTU':   { 'R': 'BOOL', 'PV': 'INT' },
    'CTD':   { 'LD': 'BOOL', 'PV': 'INT' },
    'CTUD':  { 'CD': 'BOOL', 'R': 'BOOL', 'LD': 'BOOL', 'PV': 'INT' },
    'SR':    { 'S1': 'BOOL', 'R': 'BOOL' },
    'RS':    { 'S': 'BOOL', 'R1': 'BOOL' },
    // Bitwise
    'BAND':  { 'IN1': 'DWORD', 'IN2': 'DWORD' },
    'BOR':   { 'IN1': 'DWORD', 'IN2': 'DWORD' },
    'BXOR':  { 'IN1': 'DWORD', 'IN2': 'DWORD' },
    'BNOT':  { 'IN': 'DWORD' },
    'SHL':   { 'IN': 'DWORD', 'N': 'USINT' },
    'SHR':   { 'IN': 'DWORD', 'N': 'USINT' },
    'ROL':   { 'IN': 'DWORD', 'N': 'USINT' },
    'ROR':   { 'IN': 'DWORD', 'N': 'USINT' },
};

const transpileSTLogics = (code, stdFunctions = {}, parentName = '', category = 'program', varMap = {}) => {
    if (!code) return `    // ST Implementation Empty\n`;

    // Strip IEC 61131-3 comments before splitting:
    //   (* block comments — single or multi-line *)
    //   // line comments
    const stripped = code.replace(/\(\*[\s\S]*?\*\)/g, '');
    const lines = stripped.split(/\r?\n|\\n/).map(l => l.replace(/\/\/.*$/, ''));
    let out = '';
    let indentLevel = 1; // 1 = inside function body (4 spaces)

    const indent = () => '    '.repeat(indentLevel);

    // Substitute known variable names with their C equivalents
    const resolveVarsInExpr = (expr) => {
        const sortedNames = Object.keys(varMap).sort((a, b) => b.length - a.length);
        let result = expr;
        sortedNames.forEach(name => {
            result = result.replace(new RegExp(`\\b${name}\\b`, 'gi'), varMap[name]);
        });
        return result;
    };

    const transformExpr = (expr) => {
        let result = expr
            .replace(/\b[A-Za-z_][A-Za-z0-9_]*#([A-Za-z_][A-Za-z0-9_]*)\b/g, '$1') // TypeName#EnumValue → EnumValue
            .replace(/\b16#([0-9A-Fa-f]+)/gi, '0x$1')  // IEC hex literal: 16#FF → 0xFF
            .replace(/:=/g, '__ASSIGN__')               // protect assignments before = → == pass
            .replace(/<>/g, '!=')                       // IEC not-equal → C not-equal
            .replace(/(?<![:=<>!])=(?!=)/g, '==')       // comparison = → == (not :=, <=, >=, !=, ==)
            .replace(/__ASSIGN__/g, '=')                // restore assignments
            .replace(/\bAND\b/g, '&&')
            .replace(/\bOR\b/g, '||')
            .replace(/\bNOT\b/g, '!')
            .replace(/\bMOD\b/g, '%')
            .replace(/\bXOR\b/g, '^')
            .replace(/\bTRUE\b/gi, 'true')
            .replace(/\bFALSE\b/gi, 'false');
        result = result.replace(/\bADR\s*\(\s*([^)]+?)\s*\)/gi, (_, inner) => `(&(${resolveVarsInExpr(inner.trim())}))`);
        result = result.replace(/\bNULL\b/g, 'NULL');
        // IEC 61131-3 type-conversion functions → KRON_ library names
        // e.g. BYTE_TO_UINT(...) → KRON_BYTE_TO_UINT16(...)
        const IEC_TO_KRON_TYPE = {
            BOOL:'BOOL', BYTE:'BYTE', WORD:'WORD', DWORD:'DWORD',
            SINT:'INT8', INT:'INT16', DINT:'INT32', LINT:'INT32',
            USINT:'UINT8', UINT:'UINT16', UDINT:'UINT32', ULINT:'UINT32',
            REAL:'REAL', LREAL:'LREAL',
        };
        result = result.replace(/\b([A-Z]+)_TO_([A-Z]+)(?=\s*\()/g, (match, src, dst) => {
            const ks = IEC_TO_KRON_TYPE[src], kd = IEC_TO_KRON_TYPE[dst];
            return (ks && kd) ? `KRON_${ks}_TO_${kd}` : match;
        });
        return resolveVarsInExpr(result);
    };

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        // ── Block closing keywords ────────────────────────────────────────
        if (/^END_IF\s*;?$/i.test(trimmed)) {
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}}\n`;
            return;
        }
        if (/^END_FOR\s*;?$/i.test(trimmed)) {
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}}\n`;
            return;
        }
        if (/^END_WHILE\s*;?$/i.test(trimmed)) {
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}}\n`;
            return;
        }

        // ── ELSIF / ELSE IF (check before standalone ELSE) ────────────────
        const elsifMatch = trimmed.match(/^(?:ELSIF|ELSE\s+IF)\s+(.+?)\s+THEN\s*;?\s*$/i);
        if (elsifMatch) {
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}} else if (${transformExpr(elsifMatch[1])}) {\n`;
            indentLevel++;
            return;
        }

        // ── ELSE ──────────────────────────────────────────────────────────
        if (/^ELSE\s*;?\s*$/i.test(trimmed)) {
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}} else {\n`;
            indentLevel++;
            return;
        }

        // ── IF ... THEN ───────────────────────────────────────────────────
        const ifMatch = trimmed.match(/^IF\s+(.+?)\s+THEN\s*;?\s*$/i);
        if (ifMatch) {
            out += `${indent()}if (${transformExpr(ifMatch[1])}) {\n`;
            indentLevel++;
            return;
        }

        // ── FOR ... TO ... BY ... DO (BY clause first — more specific) ────
        const forByMatch = trimmed.match(/^FOR\s+(\w+)\s*:=\s*(.+?)\s+TO\s+(.+?)\s+BY\s+(.+?)\s+DO\s*;?\s*$/i);
        if (forByMatch) {
            const [, vn, start, end, step] = forByMatch;
            const cv = varMap[vn] || vn;
            out += `${indent()}for (${cv} = ${transformExpr(start)}; ${cv} <= ${transformExpr(end)}; ${cv} += ${transformExpr(step)}) {\n`;
            indentLevel++;
            return;
        }

        // ── FOR ... TO ... DO ─────────────────────────────────────────────
        const forMatch = trimmed.match(/^FOR\s+(\w+)\s*:=\s*(.+?)\s+TO\s+(.+?)\s+DO\s*;?\s*$/i);
        if (forMatch) {
            const [, vn, start, end] = forMatch;
            const cv = varMap[vn] || vn;
            out += `${indent()}for (${cv} = ${transformExpr(start)}; ${cv} <= ${transformExpr(end)}; ${cv}++) {\n`;
            indentLevel++;
            return;
        }

        // ── WHILE ... DO ──────────────────────────────────────────────────
        const whileMatch = trimmed.match(/^WHILE\s+(.+?)\s+DO\s*;?\s*$/i);
        if (whileMatch) {
            out += `${indent()}while (${transformExpr(whileMatch[1])}) {\n`;
            indentLevel++;
            return;
        }

        // ── REPEAT (do-while start) ───────────────────────────────────────
        if (/^REPEAT\s*;?\s*$/i.test(trimmed)) {
            out += `${indent()}do {\n`;
            indentLevel++;
            return;
        }

        // ── UNTIL (do-while end) ──────────────────────────────────────────
        const untilMatch = trimmed.match(/^UNTIL\s+(.+?)\s*;?\s*$/i);
        if (untilMatch) {
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}} while (!(${transformExpr(untilMatch[1])}));\n`;
            return;
        }

        // ── EXIT → break ──────────────────────────────────────────────────
        if (/^EXIT\s*;?\s*$/i.test(trimmed)) {
            out += `${indent()}break;\n`;
            return;
        }

        // ── RETURN ────────────────────────────────────────────────────────
        if (/^RETURN\b/i.test(trimmed)) {
            const retVal = trimmed.replace(/^RETURN\s*/i, '').replace(/;$/, '').trim();
            out += `${indent()}return${retVal ? ` ${transformExpr(retVal)}` : ''};\n`;
            return;
        }

        // ── Regular statement (assignment, function call, etc.) ───────────
        let cl = transformExpr(trimmed);
        if (!cl.endsWith(';')) cl += ';';
        out += `${indent()}${cl}\n`;
    });

    return out || `    // ST parsing placeholder\n`;
};

const transpileLDLogics = (rungs, stdFunctions = {}, parentName = '', category = 'program', globalVarNames = [], inputShadowMap = null) => {
    if (!rungs || rungs.length === 0) return `    // LD Implementation Empty\n`;

    let out = '';

    // Resolve a variable/signal name to its C symbol, respecting scope.
    // Handles simple names, array elements (var[idx]), struct members (var.member).
    const resolveVar = (varName) => {
        if (!varName) return null;
        const s = varName.trim();
        // Split base name from suffix (array index or struct member access)
        const sepIdx = s.search(/[[.]/);
        const baseName = (sepIdx >= 0 ? s.slice(0, sepIdx) : s).replace(/\s+/g, '_');
        const suffix = sepIdx >= 0 ? s.slice(sepIdx) : '';
        if (category === 'program') {
            // Global vars: no prefix; local program vars: prog_<name>_ prefix
            const resolved = globalVarNames.includes(baseName) ? baseName : `prog_${parentName}_${baseName}`;
            return resolved + suffix;
        }
        if (category === 'function_block') return `instance->${baseName}${suffix}`;
        return s;
    };

    // Resolve a value string: IEC time literal → us integer, numeric → as-is,
    // identifier (incl. arr[idx] and struct.member) → scoped C symbol
    const resolveVal = (val) => {
        if (!val && val !== 0) return null;
        // Strip any UI scope/type icons (🌍🏠⊞⊡⊟)
        const s = val.toString().replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
        if (!s) return null;
        if (/^NULL$/i.test(s)) return 'NULL';
        const adrMatch = s.match(/^ADR\s*\(\s*(.+?)\s*\)$/i);
        if (adrMatch) {
            const adrTarget = adrMatch[1].trim();
            if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(adrTarget)) {
                return `&(${resolveVar(adrTarget)})`;
            }
            return null;
        }
        if (s.toUpperCase().startsWith('T#') || s.toUpperCase().startsWith('TIME#')) {
            return mapIECtoTimeUs(s).toString();
        }
        // Binary literal 0b... → decimal (C99 doesn't support 0b)
        if (/^0[bB][01]+$/.test(s)) return parseInt(s, 2).toString();
        // Octal literal 0o... → C octal 0... (C uses leading-zero octal)
        if (/^0[oO][0-7]+$/.test(s)) return '0' + parseInt(s, 8).toString(8);
        // Numeric literal (int, float, hex 0x...)
        if (/^-?[0-9][0-9a-fA-FxX.]*$/.test(s)) return s;
        // Boolean literals
        if (isBooleanLiteral(s)) return normalizeBooleanLiteral(s);
        // Variable reference: simple, arr[idx], or struct.member
        if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(s)) {
            return resolveVar(s);
        }
        return null; // unrecognised
    };

    const getInputPinMeta = (blockType, pinName, customData = null) => {
        if (customData?.content?.variables) {
            const pinVar = customData.content.variables.find((v) => v.name === pinName && (v.class === 'Input' || v.class === 'InOut'));
            if (pinVar?.type) return { type: pinVar.type, passByReference: false };
        }
        if (customData?.inputs) {
            const pinDef = customData.inputs.find((input) => input.name === pinName);
            if (pinDef) {
                return {
                    type: pinDef.storageType || pinDef.type || null,
                    passByReference: !!pinDef.passByReference || isPointerInputType(pinDef.storageType || pinDef.type),
                };
            }
        }
        return {
            type: FB_INPUT_TYPES[blockType]?.[pinName] || null,
            passByReference: isPointerInputType(FB_INPUT_TYPES[blockType]?.[pinName]),
        };
    };

    const resolveInputPinValue = (blockType, pinName, rawValue, customData = null) => {
        if (rawValue === undefined || rawValue === null || rawValue === '') return null;
        const cleanValue = String(rawValue).replace(/[🌍🏠⊞⊡⊟]/g, '').trim();
        if (!cleanValue) return null;

        if (pinName === 'Port_ID') {
            const resolvedPort = resolveHardwarePortSymbol(cleanValue);
            if (resolvedPort !== null) return resolvedPort;
        }

        const pinMeta = getInputPinMeta(blockType, pinName, customData);
        if (pinMeta.passByReference) {
            if (/^NULL$/i.test(cleanValue)) return 'NULL';
            const adrMatch = cleanValue.match(/^ADR\s*\(\s*(.+?)\s*\)$/i);
            if (adrMatch && IDENTIFIER_REF_REGEX.test(adrMatch[1].trim())) {
                return `&(${resolveVar(adrMatch[1].trim())})`;
            }
            if (IDENTIFIER_REF_REGEX.test(cleanValue)) {
                return `&(${resolveVar(cleanValue)})`;
            }
        }

        return resolveVal(cleanValue);
    };

    const adaptExprForInputPin = (blockType, pinName, expr, customData = null) => {
        if (!expr) return expr;
        const pinMeta = getInputPinMeta(blockType, pinName, customData);
        if (pinMeta.passByReference) {
            if (expr === 'NULL') return 'NULL';
            if (
                /^out_r\d+_b\d+$/.test(expr) ||
                /^[A-Za-z_][A-Za-z0-9_]*(?:->[A-Za-z_][A-Za-z0-9_]*|\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]+\])*$/.test(expr)
            ) {
                return `&(${expr})`;
            }
        }
        return expr;
    };

    // Get the C call-target for an FB instance
    const getCallTarget = (instName) => {
        const i = (instName || '').trim().replace(/\s+/g, '_');
        if (category === 'program') return `prog_${parentName}_inst_${i}`;
        if (category === 'function_block') return `instance->${i}`;
        return i;
    };

    rungs.forEach((rung, rungIdx) => {
        out += `    // Rung ${rungIdx}\n`;

        if (!rung.blocks || rung.blocks.length === 0) {
            out += `    // Empty Rung\n`;
            return;
        }

        // 1. Build adjacency graph (block-to-block only; terminal connections excluded)
        const adjacency = {};
        const incoming = {};
        const nodeMap = {};

        rung.blocks.forEach(b => {
            nodeMap[b.id] = b;
            adjacency[b.id] = [];
            incoming[b.id] = 0;
        });

        // Track unique source→target pairs so duplicate connections don't skew in-degree
        const addedEdges = new Set();
        (rung.connections || []).forEach(c => {
            const edgeKey = `${c.source}->${c.target}`;
            if (
                adjacency[c.source] !== undefined &&
                incoming[c.target] !== undefined &&
                !addedEdges.has(edgeKey)
            ) {
                addedEdges.add(edgeKey);
                adjacency[c.source].push(c.target);
                incoming[c.target]++;
            }
        });

        // 2. Topological sort (Kahn's algorithm)
        const queue = [];
        const sorted = [];
        Object.keys(incoming).forEach(id => {
            if (incoming[id] === 0) queue.push(id);
        });
        while (queue.length > 0) {
            const curr = queue.shift();
            sorted.push(curr);
            adjacency[curr].forEach(child => {
                incoming[child]--;
                if (incoming[child] === 0) queue.push(child);
            });
        }
        // Append any blocks not reached (disconnected sub-graphs / cycles)
        rung.blocks.forEach(b => {
            if (!sorted.includes(b.id)) sorted.push(b.id);
        });

        // Index map: blockId → position in sorted array
        const sortedIndex = {};
        sorted.forEach((id, idx) => { sortedIndex[id] = idx; });

        // Build power-flow (inExpr) for a block:
        //   Contact / Coil use handle id "in"
        //   FB trigger input uses "in_<triggerPinName>" (e.g. in_CU, in_IN, in_CLK)
        //   Multiple parallel paths converging are OR'd
        const getInExpr = (blockId, blockType) => {
            const isSimple = blockType === 'Contact' || blockType === 'Coil';
            // Determine the trigger-pin handle name for this FB type
            const trigPin = FB_TRIGGER_PIN[blockType];
            const trigHandle = trigPin ? `in_${trigPin}` : null;
            const conds = [];
            (rung.connections || []).forEach(c => {
                if (c.target !== blockId) return;
                // Accept only the power-flow target handle
                const tp = c.targetPin;
                const isFlowPin = isSimple
                    ? (tp === 'in' || !tp)
                    : !trigHandle
                        ? true  // No trigger pin (e.g. SR/RS): ALL incoming wires are power-flow
                        : (tp === trigHandle || tp === 'in_0' || tp === 'in' || !tp);
                if (!isFlowPin) return;

                if (c.source && c.source.startsWith('terminal_left')) {
                    conds.push('true');
                } else if (sortedIndex[c.source] !== undefined) {
                    conds.push(`out_r${rungIdx}_b${sortedIndex[c.source]}`);
                }
            });
            return conds.length > 0 ? `(${conds.join(' || ')})` : 'true';
        };

        // 3. Emit C code in topological order
        sorted.forEach((blockId, idx) => {
            const b = nodeMap[blockId];
            const type = (b.type || '').trim();
            const data = b.data || {};
            const subType = data.subType || (type === 'Contact' ? 'NO' : 'Normal');
            const bOut = `out_r${rungIdx}_b${idx}`;
            const inExpr = getInExpr(blockId, type);

            out += `    bool ${bOut} = false;\n`;

            if (type === 'Contact') {
                const varName = ((data.values?.var || data.instanceName) + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() || null;
                if (varName) {
                    const v = resolveVar(varName);
                    if (subType === 'NC' || subType === 'Falling') {
                        out += `    ${bOut} = ${inExpr} && !${v};\n`;
                    } else {
                        out += `    ${bOut} = ${inExpr} && ${v};\n`;
                    }
                } else {
                    out += `    ${bOut} = ${inExpr}; // Contact: no variable assigned\n`;
                }

            } else if (type === 'Coil') {
                const varName = ((data.values?.coil || data.instanceName) + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() || null;
                out += `    ${bOut} = ${inExpr};\n`;
                if (varName) {
                    const v = resolveVar(varName);
                    if (subType === 'Negated') {
                        out += `    ${v} = !(${bOut});\n`;
                    } else if (subType === 'Set') {
                        out += `    if (${bOut}) { ${v} = true; }\n`;
                    } else if (subType === 'Reset') {
                        out += `    if (${bOut}) { ${v} = false; }\n`;
                    } else {
                        out += `    ${v} = ${bOut};\n`;
                    }
                }

            } else if (isInlineMathType(type)) {
                // ── EN-trigger stateless block ──
                const inputPins = FB_INPUTS[type] || [];
                const dataInputPins = inputPins.filter(p => p !== 'EN');

                // Collect argument values from static pin values and wire connections
                const argValues = {};
                if (data.values) {
                    Object.entries(data.values).forEach(([pinName, val]) => {
                        if (['EN', 'ENO', 'OUT'].includes(pinName)) return;
                        const resolved = resolveVal(val);
                        if (resolved !== null) argValues[pinName] = resolved;
                    });
                }
                (rung.connections || []).forEach(c => {
                    if (c.target !== blockId) return;
                    const tp = c.targetPin;
                    if (!tp || tp === 'in_0' || tp === 'in' || tp === 'in_EN') return;
                    // Handle is "in_<pinName>" — extract pin name
                    const pinName = tp.startsWith('in_') ? tp.slice(3) : null;
                    if (!pinName || !inputPins.includes(pinName) || pinName === 'EN') return;
                    if (c.source && c.source.startsWith('terminal_left')) {
                        argValues[pinName] = 'true';
                    } else if (sortedIndex[c.source] !== undefined) {
                        const sp = c.sourcePin || '';
                        if (sp.startsWith('out_') && !/^out_\d+$/.test(sp)) {
                            // Named data output pin (e.g. "out_VALUE", "out_Q") — read from source struct directly
                            const srcBlock = nodeMap[c.source];
                            const srcInstName = (srcBlock?.data?.instanceName || srcBlock?.type || '');
                            argValues[pinName] = `${getCallTarget(srcInstName)}.${sp.slice(4)}`;
                        } else {
                            argValues[pinName] = `out_r${rungIdx}_b${sortedIndex[c.source]}`;
                        }
                    }
                });

                const args = dataInputPins.map(pin => argValues[pin] || '0');
                const validIdPattern = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/;

                if (MATH_FB_BLOCKS.has(type)) {
                    // ── Math FB: local struct + _Call (kronmath.h) ──
                    // New kronmath.h: no EN/ENO fields, integer-only structs
                    const structType = MATH_FB_STRUCT[type] || type;
                    const callFn = `${structType === type ? type : structType.replace('_FB', '')}_Call`;
                    const localVar = `_m_r${rungIdx}_b${idx}`;
                    const pinMap = MATH_FB_PIN_MAP[type] || {};

                    out += `    ${bOut} = ${inExpr};\n`;
                    out += `    if (${bOut}) {\n`;
                    out += `    ${structType} ${localVar} = {0};\n`;

                    if (MATH_FB_ARRAY_INPUT.has(type)) {
                        // Array-input blocks: IN[0]=val1, IN[1]=val2, N=count
                        dataInputPins.forEach((pin, i) => {
                            out += `    ${localVar}.IN[${i}] = ${argValues[pin] || '0'};\n`;
                        });
                        out += `    ${localVar}.N = ${dataInputPins.length};\n`;
                    } else {
                        dataInputPins.forEach(pin => {
                            const structPin = pinMap[pin] || pin;
                            out += `    ${localVar}.${structPin} = ${argValues[pin] || '0'};\n`;
                        });
                    }
                    out += `    ${callFn}(&${localVar});\n`;

                    // OUT assignment
                    const outRaw = data.values?.OUT;
                    const outVar = outRaw ? (outRaw + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                    if (outVar && validIdPattern.test(outVar)) {
                        out += `    ${resolveVar(outVar)} = ${localVar}.OUT;\n`;
                    }
                    out += `    }\n`;

                    // ENO write-back (power-flow passthrough)
                    const enoRaw = data.values?.ENO;
                    const enoVar = enoRaw ? (enoRaw + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                    if (enoVar && validIdPattern.test(enoVar)) {
                        out += `    ${resolveVar(enoVar)} = ${bOut};\n`;
                    }

                } else {
                    // ── Inline comparison/selection/range/bitwise/conversion ──
                    let resultExpr;
                    if (KRON_FN[type]) {
                        resultExpr = `${KRON_FN[type]}(${args.join(', ')})`;
                    } else if (BITWISE_OP[type]) {
                        if (args.length === 1) {
                            resultExpr = `(${BITWISE_OP[type]}${args[0]})`;
                        } else {
                            resultExpr = `(${args[0]} ${BITWISE_OP[type]} ${args[1]})`;
                        }
                    } else if (type.match(/^[A-Z]+_TO_[A-Z]+$/)) {
                        // Conversion — use C cast
                        const dstType = type.split('_TO_')[1];
                        resultExpr = `(${mapType(dstType)})(${args[0]})`;
                    } else {
                        resultExpr = `/* unknown inline: ${type} */ 0`;
                    }

                    const hasOutPin = (FB_OUTPUTS[type] || []).includes('OUT');
                    const hasQPin   = (FB_OUTPUTS[type] || []).includes('Q');
                    const isBoolResult = !hasOutPin && !hasQPin;

                    if (isBoolResult) {
                        out += `    ${bOut} = ${inExpr} && ${resultExpr};\n`;
                    } else if (hasQPin) {
                        // Comparison blocks: power-flow = EN, Q = raw comparison result
                        out += `    ${bOut} = ${inExpr};\n`;
                        const qRaw = data.values?.Q;
                        const qVar = qRaw ? (qRaw + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                        if (qVar && validIdPattern.test(qVar)) {
                            out += `    ${resolveVar(qVar)} = ${resultExpr};\n`;
                        }
                    } else {
                        out += `    ${bOut} = ${inExpr};\n`;
                        // Assign OUT to target variable
                        const outRaw = data.values?.OUT;
                        const outVar = outRaw ? (outRaw + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                        if (outVar && validIdPattern.test(outVar)) {
                            out += `    if (${bOut}) { ${resolveVar(outVar)} = ${resultExpr}; }\n`;
                        }
                    }

                    // ENO write-back (if assigned to a variable)
                    const enoRaw = data.values?.ENO;
                    const enoVar = enoRaw ? (enoRaw + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                    if (enoVar && validIdPattern.test(enoVar)) {
                        out += `    ${resolveVar(enoVar)} = ${bOut};\n`;
                    }
                }

            } else {
                // ── Function Block (standard or user-defined) ──────────────────
                const instName = data.instanceName || type;
                const callTarget = getCallTarget(instName);
                const isUserDefinedFB = !FB_INPUTS[type] && !stdFunctions[type] && !!data.customData?.content?.variables;
                // For user-defined FBs, build inputPins from customData Input variables
                const userInputPins = isUserDefinedFB
                    ? (data.customData.content.variables || []).filter(v => v.class === 'Input' || v.class === 'InOut').map(v => v.name)
                    : [];
                const inputPins = FB_INPUTS[type] || (stdFunctions[type] ? stdFunctions[type].inputs : userInputPins);

                // Determine output pin names for this block type so we can separate
                // write-back assignments (post-call) from input assignments (pre-call)
                let outputPinNames = new Set(FB_OUTPUTS[type] || []);
                if (data.customData?.content?.variables) {
                    data.customData.content.variables
                        .filter(v => v.class === 'Output')
                        .forEach(v => outputPinNames.add(v.name));
                }

                const safeInst = instName.trim().replace(/\s+/g, '_');
                // Step 1: assign static pin values entered in the block's INPUT fields
                //         Skip output pins — those are written back after the call
                if (data.values) {
                    Object.entries(data.values).forEach(([pinName, val]) => {
                        if (outputPinNames.has(pinName)) return; // handled post-call
                        const cPin = cStructPin(type, pinName);
                        const shadowSym = inputShadowMap?.get(`${safeInst}_${pinName}`);
                        if (shadowSym) {
                            out += `    ${callTarget}.${cPin} = ${shadowSym};\n`;
                        } else {
                            const resolved = resolveInputPinValue(type, pinName, val, data.customData);
                            if (resolved !== null && resolved !== undefined) {
                                out += `    ${callTarget}.${cPin} = ${resolved};\n`;
                            }
                        }
                    });
                }
                // Empty input pins that have shadow tracking variables (not present in data.values)
                if (inputShadowMap) {
                    (inputPins || []).forEach(pinName => {
                        if (pinName === FB_TRIGGER_PIN[type]) return;
                        if (outputPinNames.has(pinName)) return;
                        if (data.values?.[pinName] !== undefined && data.values[pinName] !== '') return;
                        const shadowSym = inputShadowMap.get(`${safeInst}_${pinName}`);
                        if (shadowSym) {
                            const cPin = cStructPin(type, pinName);
                            out += `    ${callTarget}.${cPin} = ${shadowSym};\n`;
                        }
                    });
                }
                (inputPins || []).forEach(pinName => {
                    if (pinName === FB_TRIGGER_PIN[type]) return;
                    if (outputPinNames.has(pinName)) return;
                    if (data.values?.[pinName] !== undefined && data.values[pinName] !== '') return;
                    if (inputShadowMap?.get(`${safeInst}_${pinName}`)) return;
                    if (!getInputPinMeta(type, pinName, data.customData).passByReference) return;
                    const cPin = cStructPin(type, pinName);
                    out += `    ${callTarget}.${cPin} = NULL;\n`;
                });

                // Step 2: assign non-trigger inputs that arrive via wire connections
                // Skip for built-in blocks without a trigger pin (e.g. SR/RS) — their inputs
                // come exclusively from data.values / shadow vars, not from wire power flow.
                // User-defined FBs always need this step since their inputs are wired.
                const hasTriggerPin = !!FB_TRIGGER_PIN[type];
                if (hasTriggerPin || isUserDefinedFB) {
                (rung.connections || []).forEach(c => {
                    if (c.target !== blockId) return;
                    const tp = c.targetPin;
                    // Skip the power-flow (trigger) handle
                    const trigPinHandle = `in_${FB_TRIGGER_PIN[type]}`;
                    if (!tp || tp === 'in_0' || tp === 'in' || tp === trigPinHandle) return;
                    // Handle is "in_<pinName>" — extract pin name
                    const pinName = tp.startsWith('in_') ? tp.slice(3) : null;
                    if (!pinName || !inputPins.includes(pinName)) return;
                    const cPin = cStructPin(type, pinName);
                    if (c.source && c.source.startsWith('terminal_left')) {
                        const sourceExpr = getInputPinMeta(type, pinName, data.customData).passByReference
                            ? 'NULL'
                            : adaptExprForInputPin(type, pinName, 'true', data.customData);
                        out += `    ${callTarget}.${cPin} = ${sourceExpr};\n`;
                    } else if (sortedIndex[c.source] !== undefined) {
                        const sp = c.sourcePin || '';
                        if (sp.startsWith('out_') && !/^out_\d+$/.test(sp)) {
                            // Named data output pin (e.g. "out_VALUE", "out_Q") — read from source struct directly
                            const srcBlock = nodeMap[c.source];
                            const srcInstName = (srcBlock?.data?.instanceName || srcBlock?.type || '');
                            const sourceExpr = adaptExprForInputPin(type, pinName, `${getCallTarget(srcInstName)}.${sp.slice(4)}`, data.customData);
                            out += `    ${callTarget}.${cPin} = ${sourceExpr};\n`;
                        } else {
                            const sourceExpr = adaptExprForInputPin(type, pinName, `out_r${rungIdx}_b${sortedIndex[c.source]}`, data.customData);
                            out += `    ${callTarget}.${cPin} = ${sourceExpr};\n`;
                        }
                    }
                });
                }

                // Step 3: set the trigger (power-flow) input — always from inExpr
                const triggerPin = FB_TRIGGER_PIN[type] || (!isUserDefinedFB && !FB_INPUTS[type] && inputPins.length > 0 ? inputPins[0] : null);
                if (triggerPin) {
                    out += `    ${callTarget}.${cStructPin(type, triggerPin)} = ${inExpr};\n`;
                }
                // User-defined FBs always execute every scan (they have no implicit EN/ENO);
                // power flow only controls downstream energization. Standard FBs without a
                // trigger pin (SR/RS) are still guarded by inExpr.
                if (!hasTriggerPin && !isUserDefinedFB) {
                    out += `    if (${inExpr}) {\n`;
                }
                if (isUserDefinedFB) {
                    // User-defined FBs use _Execute naming convention
                    out += `    ${type}_Execute(&${callTarget});\n`;
                } else if (stdFunctions[type]?.hasTime) {
                    if (stdFunctions[type]?.isFB !== false || Object.keys(FB_INPUTS).includes(type)) {
                        out += `    ${type}_Call(&${callTarget}, us_tick);\n`;
                    } else {
                        out += `    ${bOut} = ${type}_Call(${inExpr}); // Unhandled function with time\n`;
                    }
                } else {
                    if (stdFunctions[type]?.isFB !== false || Object.keys(FB_INPUTS).includes(type)) { // Standard blocks or FBs
                        out += `    ${(hasTriggerPin || isUserDefinedFB) ? '' : '  '}${type}_Call(&${callTarget}); // FBs handle their own execution\n`;
                    } else {
                        // Regular function call transpilation fallback
                        const funcArgs = [inExpr];
                        for (let i = 1; i < inputPins.length; i++) {
                            funcArgs.push(`${callTarget}.${inputPins[i]}`);
                        }
                        out += `    ${(hasTriggerPin || isUserDefinedFB) ? '' : '  '}${bOut} = ${type}_Call(${funcArgs.join(', ')});\n`;
                    }
                }
                if (!hasTriggerPin && !isUserDefinedFB) {
                    out += `    }\n`;
                }

                // Check and propagate EN -> ENO correctly for regular FBs, or use Q-output
                if (isUserDefinedFB) {
                    // User-defined FBs don't have a standard Q/ENO pin;
                    // power flow passes through unconditionally after execution
                    out += `    ${bOut} = ${inExpr};\n`;
                } else {
                    const qOutput = FB_Q_OUTPUT[type] || (triggerPin === 'EN' ? 'ENO' : 'Q');
                    if (qOutput === 'ENO' && triggerPin === 'EN') {
                        // Implicit power flow
                        out += `    ${bOut} = ${callTarget}.EN;\n`;
                    } else if (qOutput) {
                        out += `    ${bOut} = ${callTarget}.${qOutput};\n`;
                    } else {
                        out += `    ${bOut} = false;\n`;
                    }
                }

                // Step 4: output pin write-back — all pins, to assigned var AND shadow tracking var
                outputPinNames.forEach(pinName => {
                    const rawVal = data.values?.[pinName];
                    const varStr = rawVal ? (rawVal + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                    const isVarAssigned = varStr && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(varStr);
                    if (isVarAssigned) {
                        out += `    ${resolveVar(varStr)} = ${callTarget}.${pinName};\n`;
                    }
                    // Always write to shadow tracking var so the variable table can show output values
                    if (category !== 'function_block') {
                        out += `    prog_${parentName}_out_${safeInst}_${pinName} = ${callTarget}.${pinName};\n`;
                    }
                });
            }
        });
    });

    return out;
};

const mapType = (iecType) => {
    const typeMap = {
        'BOOL': 'bool',
        'SINT': 'int8_t',
        'INT': 'int16_t',
        'DINT': 'int32_t',
        'LINT': 'int64_t',
        'USINT': 'uint8_t',
        'UINT': 'uint16_t',
        'UDINT': 'uint32_t',
        'ULINT': 'uint64_t',
        'REAL': 'float',
        'LREAL': 'double',
        'BYTE': 'uint8_t',
        'WORD': 'uint16_t',
        'DWORD': 'uint32_t',
        'LWORD': 'uint64_t',
        'TIME': 'uint32_t',
        'STRING': 'char*',
        'POINTER': 'void*',
        'VOID': 'void'
    };
    return typeMap[iecType] || iecType; // Fallback to custom name
};

const transpileDataType = (dt) => {
    let code = '';
    if (dt.type === 'Enumerated') {
        code += `typedef enum {\n`;
        dt.content.values.forEach((val, i) => {
            code += `    ${val.name}${val.value !== undefined && val.value !== '' ? ` = ${val.value}` : ''}${i < dt.content.values.length - 1 ? ',' : ''}\n`;
        });
        code += `} ${dt.name};\n\n`;
    } else if (dt.type === 'Structure') {
        code += `typedef struct {\n`;
        dt.content.members.forEach(member => {
            code += `    ${mapType(member.type)} ${member.name};\n`;
        });
        code += `} ${dt.name};\n\n`;
    } else if (dt.type === 'Array') {
        const sizes = dt.content.dimensions.map(d => `[${parseInt(d.max) - parseInt(d.min) + 1}]`).join('');
        code += `typedef ${mapType(dt.content.baseType)} ${dt.name}${sizes};\n\n`;
    }
    return code;
};
