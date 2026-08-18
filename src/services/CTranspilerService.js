import { getBoardBlockMeta } from '../utils/halBlockMeta';
import { buildGeneratedDeviceArtifacts } from '../utils/deviceCodegen';
import { getPortOptions } from '../utils/devicePortMapping';
import { validateIECAddress } from '../utils/iecAddress';

const getBoardFamilyDefine = (boardId) => {
    if (!boardId) return null;
    if (boardId.startsWith('rpi_')) return 'HAL_BOARD_FAMILY_RPI';
    if (boardId.startsWith('bb_')) return 'HAL_BOARD_FAMILY_BB';
    if (boardId.startsWith('jetson_')) return 'HAL_BOARD_FAMILY_JETSON';
    // Third-party aarch64 Linux SBCs (Orange Pi, Radxa, Odroid, Banana Pi,
    // Libre Computer, Pine64) reuse the generic Linux userspace HAL
    // (kronhal_rpi.h) until a board-specific HAL family is written.
    // Keep in sync with devicePortMapping.js and deviceCodegen.js.
    if (boardId.startsWith('opi_')) return 'HAL_BOARD_FAMILY_RPI';
    if (boardId.startsWith('radxa_')) return 'HAL_BOARD_FAMILY_RPI';
    if (boardId.startsWith('odroid_')) return 'HAL_BOARD_FAMILY_RPI';
    if (boardId.startsWith('bpi_')) return 'HAL_BOARD_FAMILY_RPI';
    if (boardId.startsWith('libre_')) return 'HAL_BOARD_FAMILY_RPI';
    if (boardId.startsWith('pine_')) return 'HAL_BOARD_FAMILY_RPI';
    return null;
};

// FNV-1a 64-bit over a UTF-8 string, used to fingerprint the PlcState struct
// SHAPE (the joined "<ctype> <name>;" field declarations, in order — never
// values) so a hot-swap loader-host can refuse a layout-incompatible swap
// before it touches the live state arena. Plain accidental-collision-avoidance
// hash, not cryptographic — there is no adversary here, only the need to
// reliably detect "this struct shape differs from that one". Implemented
// identically (same algorithm, same constants) in C by the loader-host
// (host-agent/hotswaphost/host.c) so both sides agree bit-for-bit; JS numbers
// can't hold a 64-bit value precisely, so this returns a hex string and the
// caller emits it as a `0x...ULL` C literal rather than doing arithmetic on it.
const FNV1A64_OFFSET = 0xcbf29ce484222325n;
const FNV1A64_PRIME = 0x100000001b3n;
const FNV1A64_MASK = 0xffffffffffffffffn;
export const fnv1a64Hex = (str) => {
    let hash = FNV1A64_OFFSET;
    for (let i = 0; i < str.length; i++) {
        hash ^= BigInt(str.charCodeAt(i) & 0xff);
        hash = (hash * FNV1A64_PRIME) & FNV1A64_MASK;
        const cc = str.charCodeAt(i);
        if (cc > 0xff) {
            // Non-ASCII char (shouldn't occur in generated C identifiers/types,
            // but guard anyway): fold in the remaining byte deterministically.
            hash ^= BigInt((cc >> 8) & 0xff);
            hash = (hash * FNV1A64_PRIME) & FNV1A64_MASK;
        }
    }
    return hash.toString(16).padStart(16, '0');
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

const parseUsbChannel = (port) =>
    parseNumeric(String(port?.id || '').match(/USB_(\d+)/)?.[1], 0);

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

    const usbMatch = normalized.match(/^USB(?:_|)?(\d+)(?:_PORT)?$/);
    if (usbMatch) return String(parseNumeric(usbMatch[1], 0));

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
                devicePath: '',
                ...(interfaceConfig?.I2C?.[port.id] || {}),
            };
            return {
                bus: parseI2CBus(port),
                enabled: !!config.enabled,
                devicePath: (config.devicePath || '').trim(),
            };
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
                devicePath: (config.devicePath || port.path || '').trim(),
            };
        })
        .sort((a, b) => a.channel - b.channel);

    const usbPorts = getPortOptions(boardFamily, 'USB')
        .map((port) => {
            const config = {
                enabled: false,
                baudRate: 115200,
                devicePath: '',
                ...(interfaceConfig?.USB?.[port.id] || {}),
            };
            return {
                channel: parseUsbChannel(port),
                enabled: !!config.enabled,
                baudRate: parseNumeric(config.baudRate, 115200),
                devicePath: (config.devicePath || port.path || '').trim(),
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

    // I2C device node overrides — same mechanism as UART: `#define KRON_I2C<n> "<path>"`
    // before kronhal.h, honored by _i2c_devnode()/_rpi_i2c_devnode(). Lets a logical
    // channel open a different bus (e.g. AGX Orin pins 3/5 = I2C8 → /dev/i2c-7).
    let i2cPathDefines = '';
    i2cPorts.forEach((entry) => {
        if (entry.devicePath && entry.bus >= 0 && entry.bus <= 7 &&
            entry.devicePath !== `/dev/i2c-${entry.bus}`) {
            const escaped = entry.devicePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            i2cPathDefines += `#ifndef KRON_I2C${entry.bus}\n`;
            i2cPathDefines += `#define KRON_I2C${entry.bus} "${escaped}"\n`;
            i2cPathDefines += `#endif\n`;
        }
    });

    // USB device path overrides — same mechanism as UART: `#define KRON_USB<n> "<path>"`
    // before kronhal.h, honored by the HALs' _usb_devs[] table (all three declare the
    // slots behind `#ifndef KRON_USB<n>`). Without this the configured Device Path was
    // read into usbPorts[] and then silently DROPPED: the channel always opened its
    // compiled-in default, so a board whose dongle enumerated anywhere else was
    // unreachable from a PLC program no matter what the user typed. The defaults also
    // cover no /dev/ttyUSB3 slot at all (Jetson/RPi USB3 = /dev/ttyACM1), so that path
    // was not selectable by ANY channel — open() failed with ERR_ID=2 and the block
    // reported "no data" forever, which reads as a wiring fault rather than config.
    // ⚠️ Gated on `enabled`, unlike UART/I2C: the Device Path input is only RENDERED for
    // an enabled USB port, so a disabled port's path is invisible config the user cannot
    // see or edit — letting it steer codegen means a stale leftover silently redirects a
    // channel. Real projects carry exactly that (a port tried, given a path, then turned
    // off), which would have pointed USB0 at the USB3 dongle. Unlike UART there is no
    // KRON_USB_PortEnabled gate in the HAL, so this define is the only guard.
    let usbPathDefines = '';
    usbPorts.forEach((entry) => {
        if (entry.enabled && entry.devicePath && entry.channel >= 0 && entry.channel <= 4) {
            const escaped = entry.devicePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            usbPathDefines += `#ifndef KRON_USB${entry.channel}\n`;
            usbPathDefines += `#define KRON_USB${entry.channel} "${escaped}"\n`;
            usbPathDefines += `#endif\n`;
        }
    });

    let helpers = `#define KRON_RUNTIME_PORT_HELPERS 1\n${uartPathDefines}${i2cPathDefines}${usbPathDefines}\n`;
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

    // USB baud-per-port dispatch — kronhal.h's USB_Send_Call / USB_Receive_Call
    // call this so the kernel port is opened at the user-configured baud rate.
    // Without this they were hardcoding 115200 and high-speed sensors
    // (e.g. RPLIDAR S2 @ 1 Mbps) never got a clean byte stream.
    helpers += `static inline int32_t KRON_USB_PortBaud(uint8_t port) {\n`;
    helpers += renderSwitch(
        usbPorts.map((entry) => ({ caseValue: entry.channel, baudRate: entry.baudRate })),
        '115200',
        (entry) => `${entry.baudRate}`
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
    'sint','usint','pointer',
    'ton','tof','tp','tonr','ctu','ctd','ctud','sr','rs','r_trig','f_trig',
    'shl','shr','rol','ror','band','bor','bxor','bnot',
    'add','sub','mul','div','abs','sqrt','expt','sin','cos','tan','asin','acos','atan',
    'max','min','limit','sel','mux','move',
    'gt','ge','eq','ne','le','lt',
    'norm_x','scale_x',
    'adr','null',
    'uart_receive','uart_send',
    'usb_receive','usb_send',
    'i2c_writeread','spi_transfer',
]);

// IEC 61131-3 type-conversion functions (X_TO_Y) are stateless and inlined by
// the transpiler. The validator accepts any TYPE_TO_TYPE pair to avoid hard-
// coding all 90+ combinations.
const ST_CONVERSION_REGEX = /^(?:BOOL|BYTE|WORD|DWORD|LWORD|SINT|USINT|INT|UINT|DINT|UDINT|LINT|ULINT|REAL|LREAL)_TO_(?:BOOL|BYTE|WORD|DWORD|LWORD|SINT|USINT|INT|UINT|DINT|UDINT|LINT|ULINT|REAL|LREAL)$/i;

/**
 * Validate all ST/SCL code in the project before compilation.
 * Returns an array of { program, rung, line, column, word } error objects.
 * Errors indicate identifiers not found in variable tables or known functions.
 */
export const validateProjectST = (projectStructure, stdFunctionNames = [], hwPortVars = []) => {
    const errors = [];
    const stdLower = new Set(stdFunctionNames.map(n => n.toLowerCase()));
    const globalVarNames = new Set(
        (projectStructure?.resources?.find(r => r.type === 'RESOURCE_EDITOR')?.content?.globalVars || [])
            .map(v => (v.name || '').toLowerCase())
    );
    const dataTypeNames = new Set(
        (projectStructure?.dataTypes || []).map(dt => (dt.name || '').toLowerCase())
    );
    const hwPortNames = new Set(
        (hwPortVars || []).map(v => (v.name || '').toLowerCase())
    );

    const validateCode = (code, varNames, contextLabel) => {
        // Strip multi-line (* block comments *) preserving line count, then split
        const stripped = (code || '').replace(/\(\*[\s\S]*?\*\)/g, match => '\n'.repeat((match.match(/\n/g) || []).length));
        const lines = stripped.split('\n');
        // Parenthesis nesting tracked across the whole POU — multi-line FB calls
        // span newlines, so we cannot reset depth per line.
        let depth = 0;
        lines.forEach((rawLine, i) => {
            // Strip:
            //   - single-line comments
            //   - in-line (* ... *) block comments
            //   - typed-radix integer literals (16#FE, 2#1010, 8#777)
            //   - IEC time/date/datetime literals (T#5ms, TIME#1h30m, D#2026-01-01,
            //     DT#2026-01-01-12:00:00, TOD#13:45:00.123)
            // Replace with same-length spaces so column numbers in errors stay accurate.
            const line = rawLine
                // Blank single-quoted string literals FIRST (length-preserving) so
                // identifiers inside 'strings' are never flagged and a // inside a
                // string doesn't truncate the line.
                .replace(/'(?:[^'\\\r\n]|\\.)*'/g, m => ' '.repeat(m.length))
                .replace(/\/\/.*$/, '')
                .replace(/\(\*.*?\*\)/g, '')
                .replace(/\b\d+#[0-9A-Fa-f_]+\b/g, m => ' '.repeat(m.length))
                .replace(/\b(?:T|TIME|LTIME|D|DATE|LDATE|DT|LDT|TOD|LTOD)#[A-Za-z0-9_.:\-]+/gi,
                         m => ' '.repeat(m.length));
            const regex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
            let scanIdx = 0;
            let match;
            while ((match = regex.exec(line)) !== null) {
                for (let k = scanIdx; k < match.index; k++) {
                    if (line[k] === '(') depth++;
                    else if (line[k] === ')' && depth > 0) depth--;
                }
                scanIdx = regex.lastIndex;

                // Skip member access identifiers (e.g. .NewData in UART_Receive1.NewData)
                if (match.index > 0 && line[match.index - 1] === '.') continue;
                const word = match[0];
                const lower = word.toLowerCase();
                // Inside an FB-call argument list, an identifier directly followed by
                // ':=' is a parameter NAME (Execute, Port_ID, IN, PT, …), not a var.
                if (depth > 0 && /^\s*:=/.test(line.slice(regex.lastIndex))) continue;
                if (ST_KEYWORDS_LOWER.has(lower)) continue;
                if (stdLower.has(lower)) continue;
                if (globalVarNames.has(lower)) continue;
                if (dataTypeNames.has(lower)) continue;
                if (hwPortNames.has(lower)) continue;
                if (varNames.has(lower)) continue;
                if (ST_CONVERSION_REGEX.test(word)) continue;
                if (!isNaN(word)) continue;
                errors.push({ context: contextLabel, line: i + 1, column: match.index + 1, word });
            }
            // Count parens trailing the last identifier so depth stays correct on the next line
            for (let k = scanIdx; k < line.length; k++) {
                if (line[k] === '(') depth++;
                else if (line[k] === ')' && depth > 0) depth--;
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

export const transpileToC = (projectStructure, standardHeaders = [], boardId = null, simMode = true, buses = [], busConfigs = {}) => {
    let stdFunctions = {};
    let customIncludes = ``;

    // Board-specific HAL implementation headers: excluded from direct #include
    // because HAL/kronhal.h conditionally includes the right one based on defines.
    // Filenames match what get_standard_headers returns ("HAL/<name>" prefix).
    const HAL_IMPL_HEADERS = new Set([
        'HAL/kronhal_sim.h', 'HAL/kronhal_rpi.h',
        'HAL/kronhal_bb.h', 'HAL/kronhal_jetson.h'
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
        'DINT': 4, 'UDINT': 4, 'TIME': 4, 'REAL': 4, 'DWORD': 4,
        'LINT': 8, 'ULINT': 8, 'LREAL': 8, 'LWORD': 8
    };

    // Shared memory offset tracker — each scalar PLC variable gets a consecutive slot
    // Force flags region starts at FORCE_FLAGS_BASE: one byte per variable, set by KronServer
    // to prevent plc_shm_sync from overwriting a forced value with the PLC-computed value.
    const FORCE_FLAGS_BASE = 32768;
    const PLC_SHM_TOTAL_SIZE = 65536; // must match PLC_SHM_SIZE emitted into plc.c
    let shmOffset = 0;
    const shmEntries = []; // {c_symbol, offset, size, flagOffset} used to generate plc_shm_sync()
    const tryAssignShm = (type, c_symbol) => {
        const size = IEC_TYPE_SIZES[type?.toUpperCase()];
        if (!size) return {}; // FB, user-defined type or unknown — no SHM slot
        const offset = shmOffset;
        const flagOffset = FORCE_FLAGS_BASE + shmEntries.length;
        // Data region must stay below the force-flag region, and the flag region
        // must stay inside the shared-memory segment — otherwise the generated
        // memcpy offsets silently corrupt neighbouring variables / overflow SHM.
        if (offset + size > FORCE_FLAGS_BASE) {
            throw new Error(`Too many/too large variables for shared memory: data region exceeds ${FORCE_FLAGS_BASE} bytes at variable "${c_symbol}". Reduce the number/size of monitored variables (e.g. large arrays).`);
        }
        if (flagOffset >= PLC_SHM_TOTAL_SIZE) {
            throw new Error(`Too many variables for shared memory: force-flag region exceeds the ${PLC_SHM_TOTAL_SIZE}-byte segment at variable "${c_symbol}". Reduce the number of monitored variables.`);
        }
        shmOffset += size;
        shmEntries.push({ c_symbol, offset, size, flagOffset });
        return { offset, size, force_flag_offset: flagOffset };
    };

    // Parse a Variable Manager initial value into the JS value stored in
    // variables.json. Must MATCH what the compiled C initialiser produces
    // (formatVarInitial): time literals (T#300ms → 300000 µs), IEC typed-radix
    // (16#40 → 64), hex (0x40 → 64). Otherwise KronServer's WriteInitialValues
    // seeds 0 while the binary's cold-init uses the real value.
    const resolveInitialValue = (val, type) => {
        const T = String(type || '').toUpperCase();
        if (val !== undefined && val !== null && val !== '') {
            const s = String(val).trim();
            if (T === 'BOOL') {
                const b = s.toLowerCase();
                return b === 'true' || b === '1';
            }
            if (T === 'STRING') return s.replace(/^"|"$/g, '');
            if (T === 'TIME' && /^(?:T|TIME)#/i.test(s)) return mapIECtoTimeUs(s);
            const radix = s.match(/^(\d+)#([0-9A-Fa-f_]+)$/);
            if (radix) {
                const n = parseInt(radix[2].replace(/_/g, ''), parseInt(radix[1], 10));
                return Number.isFinite(n) ? n : 0;
            }
            if (/^-?0x[0-9A-Fa-f]+$/i.test(s)) return parseInt(s, 16);
            const num = Number(s);
            return Number.isFinite(num) ? num : 0;
        }
        if (T === 'BOOL') return false;
        if (T === 'STRING') return "";
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

    // Compute EtherCAT config early so we can inject the extern before POU function bodies
    const ecCfgEarly = generateEtherCATConfig(buses, busConfigs, simMode);

    // EtherCAT PDO variable names are accessed through the GPI #define macros
    // (ec_X → __gpi_snap->_pi_ec_X). The user workflow ALSO adds them as global
    // variables — those must NOT become PlcState fields / S-> references / SHM
    // slots, or the macro expansion produces `S->(__gpi_snap->…)` (syntax error)
    // and plc_shm_sync copies EC-owned data. Registered transiently like
    // HAL_BLOCK_TYPES; cleared in the cleanup section below.
    EC_PDO_VAR_NAMES.clear();
    (ecCfgEarly.gpiVarNames || []).forEach(n => EC_PDO_VAR_NAMES.add(n));

    // --- DIRECT-ADDRESS GATE (runs before any codegen) ---
    // ⚠️ An IEC address is a WIDTH claim (%MX bit / %MW word / %MD dword / …),
    // but nothing downstream re-derives it: the transpiler copies the string
    // into variableTable verbatim, and KronServer reads the variable by
    // offset/size (both from the TYPE) while treating a non-empty address as
    // nothing more than "expose this over REST/HMI". So a prefix that no longer
    // matches its type — the classic case being a type changed AFTER the
    // address was assigned — produces a runtime that works perfectly while
    // publishing the wrong width to whatever is on the other end of the link.
    // The Variable Manager blocks this at entry and retargets on a type change,
    // but a hand-edited project XML, an AI-agent-written variable, or any
    // project saved before those checks existed still reaches here — this is
    // the last place to catch it, so it is a hard error, like the array-bounds
    // and SHM-overflow checks.
    const addressProblems = [];
    const checkAddress = (v, scope) => {
        if (!v || !v.address) return;
        if (EC_PDO_VAR_NAMES.has((v.name || '').trim())) return; // EtherCAT-owned, no SHM slot
        const res = validateIECAddress(v.address, v.type);
        if (!res.ok) addressProblems.push(`  • ${scope}.${v.name || '(unnamed)'} : ${v.type || '?'} — ${res.message}`);
    };
    (config?.content?.globalVars || []).forEach(v => checkAddress(v, 'GLOBAL'));
    (projectStructure.programs || []).forEach(prog =>
        (prog.content?.variables || []).forEach(v => checkAddress(v, prog.name || '(unnamed program)')));
    if (addressProblems.length > 0) {
        throw new Error(
            `Invalid IEC address${addressProblems.length > 1 ? 'es' : ''} (${addressProblems.length}):\n` +
            `${addressProblems.join('\n')}\n` +
            `Fix the Address column in the Variable Manager (clearing it removes the variable from the REST/HMI feed).`
        );
    }

    let header = `// Autogenerated by KronEditor CTranspiler
#ifndef PLC_H
#define PLC_H

#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>

#ifndef ABS
#define ABS(x) ((x) < 0 ? -(x) : (x))
#endif

${boardDefines}${runtimePortHelpers}${customIncludes}${ecCfgEarly.motionIncludes ? ecCfgEarly.motionIncludes + '\n' : ''}extern volatile uint64_t us_tick;

`;

    let source = `// Autogenerated by KronEditor CTranspiler\n#include "plc.h"\n\n// ⚠️ <time.h> is needed on WINDOWS too: the exec-time instrumentation in\n// plc_task_body_* uses struct timespec + clock_gettime, which mingw/winpthreads\n// provide. Gating it on __linux__/__APPLE__ left struct timespec incomplete and\n// no Windows build could compile. <unistd.h> stays POSIX-only.\n#include <time.h>\n#if defined(__linux__) || defined(__APPLE__)\n#include <unistd.h>\n#endif\n#if defined(__linux__)\n#include <sched.h>\n#include <pthread.h>\n#elif defined(_WIN32)\nvoid Sleep(unsigned long ms);\nint SetPriorityClass(void *hProcess, unsigned long dwPriorityClass);\nvoid *GetCurrentProcess(void);\nint SetThreadPriority(void *hThread, int nPriority);\nvoid *GetCurrentThread(void);\n#define REALTIME_PRIORITY_CLASS 0x00000100\n#define THREAD_PRIORITY_TIME_CRITICAL 15\n#endif\n\n`;

    // ── Phase 2 (hot-swap): all mutable state goes into ONE PlcState struct,
    // reached through a file-scope pointer S. Declarations are collected here
    // (struct body) instead of emitted at file scope; non-zero initializers go
    // to a cold-init. Every state reference is S->… (see transpilePOUSource /
    // transpileLDLogics / generateMainLoop). This is what lets the logic be
    // hot-swapped (dlopen) while the state in S (shared memory) persists.
    const stateFields = [];   // e.g. "int16_t prog_Main_cnt;"
    const stateInits = [];    // e.g. "S->prog_Main_cnt = 0;"
    // Retentive variables: PlcState fields snapshotted to retain.dat and restored
    // at PLC_Init (see generateRetainSupport). {key} is the STABLE identity the
    // file is matched on — the C field name is free to change (it encodes the
    // owning program), the key is not.
    const retainEntries = [];
    const usedHalBlocks = new Set(); // HAL block types used → trampolined to the host in hot-swap mode
    // The struct itself is emitted AFTER all type defs (UDTs, FB structs) and
    // signatures but BEFORE the function/program bodies — see the marker below.

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

    // AXIS_REF fields exposed for SHM debugging (subset useful for diagnosing motion issues).
    // `offset` = byte offset inside the real AXIS_REF C struct (kronmotion.h) on the
    // LOCAL-SIM target (x86_64: 8-byte pointers, 4-byte enums, natural alignment) —
    // used by the sim's /proc/<pid>/mem reader (base_symbol + byte_offset).
    // Verified against offsetof() with the bundled clang; keep in sync with kronmotion.h.
    const AXIS_REF_DEBUG_FIELDS = [
        { name: 'AxisNo',           type: 'UINT', offset: 0 },
        { name: 'Simulation',       type: 'BOOL', offset: 16 },
        { name: 'ActualPosition',   type: 'REAL', offset: 32 },
        { name: 'ActualVelocity',   type: 'REAL', offset: 36 },
        { name: 'ActualTorque',     type: 'REAL', offset: 40 },
        { name: 'IsHomed',          type: 'BOOL', offset: 61 },
        { name: 'AxisWarning',      type: 'BOOL', offset: 62 },
        { name: 'AxisErrorID',      type: 'UINT', offset: 64 },
        { name: 'cmd_Seq',          type: 'UINT', offset: 66 },
        { name: 'sts_AckSeq',       type: 'UINT', offset: 96 },
        { name: 'sts_State',        type: 'UINT', offset: 100 },
        { name: 'sts_Busy',         type: 'BOOL', offset: 104 },
        { name: 'sts_Done',         type: 'BOOL', offset: 105 },
        { name: 'sts_Error',        type: 'BOOL', offset: 106 },
        { name: 'sts_ErrorID',      type: 'UINT', offset: 108 },
        { name: 'drv_StatusWord',   type: 'UINT', offset: 110 },
        { name: 'drv_ControlWord',  type: 'UINT', offset: 112 },
    ];

    // Expand an ARRAY data type into the FULL index cross-product with row-major
    // byte offsets that match the C declaration `base name[d0max+1][d1max+1]…`
    // (see transpileDataType — dimensions are sized [max+1] so raw IEC indices
    // stay valid; lower bounds must be >= 0). Iterating dimensions independently
    // (the old behaviour) emitted var[0], var[1] per dimension — duplicates with
    // wrong offsets for multi-dim arrays.
    const expandArrayElements = (dtDef) => {
        const baseType = dtDef.content.baseType;
        const elemSize = IEC_TYPE_SIZES[baseType.toUpperCase()] || 0;
        const dims = (dtDef.content.dimensions || []).map(d => ({
            min: parseInt(d.min, 10), max: parseInt(d.max, 10),
        }));
        const elements = [];
        if (dims.length === 0 || dims.some(d => !Number.isFinite(d.min) || !Number.isFinite(d.max))) {
            return { baseType, elements };
        }
        const strides = dims.map((_, i) =>
            dims.slice(i + 1).reduce((acc, d) => acc * (d.max + 1), 1) * elemSize);
        const rec = (dimIdx, suffix, offset) => {
            if (dimIdx === dims.length) { elements.push({ suffix, offset }); return; }
            for (let i = dims[dimIdx].min; i <= dims[dimIdx].max; i++) {
                rec(dimIdx + 1, `${suffix}[${i}]`, offset + i * strides[dimIdx]);
            }
        };
        rec(0, '', 0);
        return { baseType, elements };
    };

    // Walk a Structure data type's members computing NATURALLY ALIGNED offsets
    // (alignment = scalar size, up to 8) — matches the C compiler's struct
    // layout. A packed walk (just summing sizes) disagreed with real padding,
    // so the local sim read garbage for padded UDTs.
    const structMemberOffsets = (members) => {
        let off = 0;
        return (members || []).map(member => {
            const size = IEC_TYPE_SIZES[member.type?.toUpperCase()] || 0;
            const align = Math.min(Math.max(size, 1), 8);
            off = Math.ceil(off / align) * align;
            const entry = { member, offset: off };
            off += size;
            return entry;
        });
    };

    // Build lookup: typeName → data type definition (for array/struct/enum expansion)
    const dataTypeDefs = (projectStructure.dataTypes || []).reduce((acc, dt) => {
        acc[dt.name] = dt; return acc;
    }, {});

    if (config && config.content.globalVars && config.content.globalVars.length > 0) {
        header += `// --- GLOBAL VARIABLES ---\n`;
        config.content.globalVars.forEach(v => {
            const gInitVal = resolveInitialValue(v.initialValue, v.type);
            // EC-owned PDO variable: lives in the GPI struct behind an access
            // macro — no PlcState field, no SHM slot, no S-> mapping.
            if (EC_PDO_VAR_NAMES.has((v.name || '').trim())) {
                variableTable.globalVars[v.name] = { type: v.type, initialValue: gInitVal };
                return;
            }
            const isUserType = !!dataTypeDefs[v.type];
            const initVal = isUserType ? '' : formatVarInitial(v.initialValue, v.type);
            stateFields.push(`${mapType(v.type)} ${v.name};`);
            if (initVal) stateInits.push(`S->${v.name}${initVal};`);
            const gRetain = isRetainVar(v);
            // Globals are keyed by bare name — the same identity the ST/LD code
            // uses, so renaming a PROGRAM never orphans a retained global.
            if (gRetain) retainEntries.push({ key: v.name, field: v.name });
            variableTable.globalVars[v.name] = { type: v.type, initialValue: gInitVal, ...(gRetain ? { retain: true } : {}) };
            // Debug: top-level entry (scalar types get a SHM slot)
            const gShmSlot = !isUserType ? tryAssignShm(v.type, v.name) : {};
            variableTable.debugDefaults[`prog__${v.name}`] = {
                type: v.type, c_symbol: v.name, defaultValue: gInitVal, address: v.address || '', ...gShmSlot,
                ...(gRetain ? { retain: true } : {})
            };
            // Debug: expand array elements and struct members for monitoring
            const dtDef = dataTypeDefs[v.type];
            if (dtDef?.type === 'Array') {
                const { baseType, elements } = expandArrayElements(dtDef);
                elements.forEach(({ suffix, offset }) => {
                    const elemCSym = `${v.name}${suffix}`;
                    const elemShmSlot = tryAssignShm(baseType, elemCSym);
                    variableTable.debugDefaults[`prog__${v.name}${suffix}`] = {
                        type: baseType, c_symbol: elemCSym,
                        base_symbol: v.name, byte_offset: offset,
                        defaultValue: 0, address: v.address || '', ...elemShmSlot
                    };
                });
            } else if (dtDef?.type === 'Structure') {
                structMemberOffsets(dtDef.content.members).forEach(({ member, offset }) => {
                    const memCSym = `${v.name}.${member.name}`;
                    const memShmSlot = tryAssignShm(member.type, memCSym);
                    variableTable.debugDefaults[`prog__${v.name}.${member.name}`] = {
                        type: member.type, c_symbol: memCSym,
                        base_symbol: v.name, byte_offset: offset,
                        defaultValue: 0, address: v.address || '', ...memShmSlot
                    };
                });
            } else if (v.type === 'AXIS_REF') {
                AXIS_REF_DEBUG_FIELDS.forEach(field => {
                    const memCSym = `${v.name}.${field.name}`;
                    const memShmSlot = tryAssignShm(field.type, memCSym);
                    variableTable.debugDefaults[`prog__${v.name}.${field.name}`] = {
                        type: field.type, c_symbol: memCSym,
                        base_symbol: v.name, byte_offset: field.offset,
                        defaultValue: 0, address: v.address || '', ...memShmSlot
                    };
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
            // Edge-memory members for Rising/Falling LD contacts/coils inside
            // this FB's ladder (per-instance previous-scan state).
            if (fb.type === 'LD' || fb.type === 'SCL') {
                collectEdgeVars(fb.content?.rungs).forEach(ev => {
                    header += `    bool __edge_${ev.id};\n`;
                });
            }
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
            header += `static inline ${retType} ${fnName}(${buildFunctionParams(fn)});\n`;
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

    // PlcState struct goes here — after all type defs (UDTs, FB structs) and
    // signatures, before any function body that references S->fields.
    header += '@@PLCSTATE_STRUCT@@\n';

    // Collect global variable names (used by LD transpiler to skip prog_ prefix)
    const globalVarsList = (config?.content?.globalVars || []);
    const globalVarNames = globalVarsList
        .map(v => (v.name || '').trim().replace(/\s+/g, '_'));

    if (ecCfgEarly.headerExtern) {
        header += `\n// --- ETHERCAT HAL ---\n${ecCfgEarly.headerExtern}\n`;
    }
    // GPI access macros are injected HERE — after all global variable declarations
    // (to prevent macro expansion of user-declared globals with matching names) but
    // before POU implementation bodies (so the macros are active inside them).
    if (ecCfgEarly.gpiMacros) {
        header += ecCfgEarly.gpiMacros;
    }

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
            header += transpilePOUSource(fn, 'function', stdFunctions, fn.name, globalVarNames, null, globalVarsList, projectStructure);
        });
    }

    if (projectStructure.functionBlocks) {
        header += `// --- FUNCTION BLOCKS ---\n`;
        projectStructure.functionBlocks.forEach(fb => {
            header += transpilePOUSource(fb, 'function_block', stdFunctions, fb.name, globalVarNames, null, globalVarsList, projectStructure);
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
                const isFB = isFBType(vType, projectStructure) || !!stdFunctions[vType] || HAL_BLOCK_TYPES.has(vType) || (vType in FB_TRIGGER_PIN && !isInlineMathType(vType));
                if (HAL_BLOCK_TYPES.has(vType)) usedHalBlocks.add(vType);
                if (isFB) {
                    // Sanitize the type the same way the FB typedef does
                    // ("My FB" → typedef My_FB), or the field declaration
                    // references a nonexistent type name.
                    stateFields.push(`${vType.replace(/\s+/g, '_')} prog_${progName}_inst_${vName};`);
                } else {
                    // Program-local variables — emit initial value when the user
                    // provided one in the Variable Manager. Without this, scalar
                    // POU vars default to 0 even if Variable Manager shows e.g.
                    // `state := 90` or `pca_dev_addr := 16#40`, which silently
                    // breaks state machines that rely on a non-zero start state.
                    const isUserType = !!dataTypeDefs[vType];
                    const initStr = isUserType ? '' : formatVarInitial(v.initialValue, vType);
                    stateFields.push(`${mapType(vType)} prog_${progName}_${vName};`);
                    if (initStr) stateInits.push(`S->prog_${progName}_${vName}${initStr};`);
                }

                const cSym = isFB ? `prog_${progName}_inst_${vName}` : `prog_${progName}_${vName}`;
                const initVal = resolveInitialValue(v.initialValue, vType);
                // A retained FB INSTANCE persists the whole struct (a CTU keeps
                // its CV, a TONR its accumulated ET) — the entry is one blob of
                // sizeof(that struct), so nothing here is type-specific.
                const vRetain = isRetainVar(v);
                if (vRetain) retainEntries.push({ key: `${progName}.${vName}`, field: cSym });
                variableTable.programs[progName].variables[vName] = {
                    type: vType, c_symbol: cSym, initialValue: initVal, ...(vRetain ? { retain: true } : {})
                };
                // Debug: top-level entry (non-FB scalars get a SHM slot)
                const vShmSlot = !isFB ? tryAssignShm(vType, cSym) : {};
                variableTable.debugDefaults[`prog_${progName}_${vName}`] = {
                    type: vType, c_symbol: cSym, defaultValue: initVal, address: v.address || '', ...vShmSlot,
                    ...(vRetain ? { retain: true } : {})
                };
                // FB instance OUTPUT pins (Q, ET, CV, …): expose each scalar pin
                // as its own SHM-slotted variable so the TARGET (KronServer reads
                // /dev/shm by offset) can stream them for debug. The FB struct
                // itself has no SHM slot, but its scalar outputs do. Live key
                // `prog_X_<var>.<pin>` (what the ST debug overlay resolves for
                // member access); c_symbol points into the FB struct field.
                if (isFB) {
                    (FB_OUTPUTS[vType] || []).forEach(pin => {
                        const pinType = getOutputPinType(vType, pin);
                        if (!IEC_TYPE_SIZES[pinType?.toUpperCase()]) return; // scalar pins only
                        const pinCSym = `${cSym}.${pin}`;
                        const pinSlot = tryAssignShm(pinType, pinCSym);
                        variableTable.debugDefaults[`prog_${progName}_${vName}.${pin}`] = {
                            type: pinType, c_symbol: pinCSym, defaultValue: 0, ...pinSlot
                        };
                    });
                }
                // Debug: expand array elements and struct members
                if (!isFB) {
                    const dtDef = dataTypeDefs[vType];
                    if (dtDef?.type === 'Array') {
                        const { baseType, elements } = expandArrayElements(dtDef);
                        elements.forEach(({ suffix, offset }) => {
                            const elemCSym = `${cSym}${suffix}`;
                            const elemShmSlot = tryAssignShm(baseType, elemCSym);
                            variableTable.debugDefaults[`prog_${progName}_${vName}${suffix}`] = {
                                type: baseType, c_symbol: elemCSym,
                                base_symbol: cSym, byte_offset: offset,
                                defaultValue: 0, address: v.address || '', ...elemShmSlot
                            };
                        });
                    } else if (dtDef?.type === 'Structure') {
                        structMemberOffsets(dtDef.content.members).forEach(({ member, offset }) => {
                            const memCSym = `${cSym}.${member.name}`;
                            const memShmSlot = tryAssignShm(member.type, memCSym);
                            variableTable.debugDefaults[`prog_${progName}_${vName}.${member.name}`] = {
                                type: member.type, c_symbol: memCSym,
                                base_symbol: cSym, byte_offset: offset,
                                defaultValue: 0, address: v.address || '', ...memShmSlot
                            };
                        });
                    }
                }
            });
            // Edge-memory state for Rising/Falling LD contacts/coils — one BOOL
            // per edge block holding the previous-scan value. Lives in PlcState
            // so it survives hot-swaps; pushed BEFORE plcStateLayoutHash is
            // computed (all program-loop pushes are).
            if (prog.type === 'LD' || prog.type === 'SCL') {
                collectEdgeVars(prog.content?.rungs).forEach(ev => {
                    stateFields.push(`bool prog_${progName}_edge_${ev.id};`);
                });
            }

            // Collect shadow vars BEFORE transpiling so they can be declared before the function body
            const shadowVars = (prog.type === 'LD' || prog.type === 'SCL')
                ? collectShadowVars(prog.content?.rungs, progName)
                : [];
            // Declare shadow tracking globals in header
            shadowVars.forEach(sv => {
                stateFields.push(`${mapType(sv.type)} ${sv.symbol};`);
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
                stateFields.push(`${mapType(sv.type)} ${sv.symbol};`);
                if (initPart) stateInits.push(`S->${sv.symbol}${initPart};`);
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

            header += transpilePOUSource(prog, 'program', stdFunctions, progName, globalVarNames, inputShadowMap, globalVarsList, projectStructure);
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
        stateFields.push(`uint32_t ${cSym};`);
        return { progName: pName, cSym, liveKey };
    });

    // Fingerprint of the PlcState SHAPE (field decls, in order — not values),
    // exported under PLC_HOTSWAP (in generateMainLoop, below) as
    // plc_state_layout_hash(). The loader-host compares this between the
    // running and a candidate-swap .so and refuses the swap on any mismatch —
    // the hard safety net for "an edit changed the variable table/FB
    // instances/UDTs without anyone updating the hot-swap layout guard".
    // stateFields is fully finalized by this point — every push site runs
    // earlier than this in transpilePOUSource/this function.
    const plcStateLayoutHash = fnv1a64Hex(stateFields.join('\n'));

    // --- 6. BUILD SERVER VARIABLES ARRAY ---
    const IEC_TO_SERVER_TYPE = {
        'BOOL': 'bool',
        'SINT': 'int8',
        'USINT': 'uint8', 'BYTE': 'uint8',
        'INT': 'int16',
        'UINT': 'uint16', 'WORD': 'uint16',
        'DINT': 'int32',
        'UDINT': 'uint32', 'DWORD': 'uint32',
        'LINT': 'int64',
        'ULINT': 'uint64', 'LWORD': 'uint64',
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
            address: info.address || '',
            initial_value: info.defaultValue,
        }));

    // --- 7. SHARED MEMORY SYNC (Linux + Windows + macOS) ---
    variableTable.shmSize = shmOffset;
    if (shmEntries.length > 0) {
        // ⚠️ Linux AND Windows AND macOS. The mirror is how the editor
        // reads/forces live variables, so gating it on __linux__ alone is what
        // made local simulation Linux-only. The platforms differ ONLY in how
        // the shared segment is created; everything below (pull/sync, force
        // flags) is byte-identical, because the agent addresses it purely by
        // offset.
        //
        // ⚠️ __APPLE__ must stay in this guard even though the branch below
        // creates nothing on macOS: in a hot-swap build the LOADER-HOST owns
        // the segment and the logic module only needs the `extern __plc_shm`
        // declaration plus the plc_shm_name/plc_shm_size exports the host
        // dlsym's. Drop __APPLE__ and those exports vanish, the host's dlsym
        // returns NULL, and the sim runs perfectly while the editor shows no
        // live values and every force-write silently does nothing.
        source += `\n#if defined(__linux__) || defined(_WIN32) || defined(__APPLE__)\n`;
        source += `#define PLC_SHM_SIZE 65536\n`;
        source += `#if defined(_WIN32)\n`;
        // Win32 kernel object name — NOT the POSIX "/plc_runtime": a Windows
        // named section lives in the object namespace ("Local\\..." = per
        // session), and a leading slash is not valid there.
        source += `#define PLC_SHM_NAME "Local\\\\plc_runtime"\n`;
        source += `#else\n`;
        source += `#include <sys/mman.h>\n`;
        source += `#include <fcntl.h>\n`;
        source += `#define PLC_SHM_NAME "/plc_runtime"\n`;
        source += `#endif\n`;
        // In a hot-swap build the loader-host owns the mirror (so the editor
        // keeps reading live variables across a logic swap) and assigns
        // __plc_shm; the logic module just references it (extern), like us_tick.
        source += `#ifdef PLC_HOTSWAP\n`;
        source += `extern uint8_t *__plc_shm;\n`;
        source += `#else\n`;
        source += `static uint8_t *__plc_shm = NULL;\n`;
        source += `#if defined(_WIN32)\n`;
        source += `void *CreateFileMappingA(void *hFile, void *lpAttrs, unsigned long flProtect,\n`;
        source += `                         unsigned long dwMaxHi, unsigned long dwMaxLo, const char *lpName);\n`;
        source += `void *MapViewOfFile(void *hMap, unsigned long dwAccess,\n`;
        source += `                    unsigned long offHi, unsigned long offLo, unsigned long long numBytes);\n`;
        source += `static void plc_shm_init(void) {\n`;
        source += `    /* INVALID_HANDLE_VALUE backing = page-file section (no file on disk). */\n`;
        source += `    void *h = CreateFileMappingA((void*)(long long)-1, 0, 0x04 /*PAGE_READWRITE*/,\n`;
        source += `                                 0, PLC_SHM_SIZE, PLC_SHM_NAME);\n`;
        source += `    if (!h) return;\n`;
        source += `    __plc_shm = (uint8_t *)MapViewOfFile(h, 0x000F001F /*FILE_MAP_ALL_ACCESS*/, 0, 0, PLC_SHM_SIZE);\n`;
        source += `}\n`;
        source += `#else\n`;
        // NOTE (macOS): this non-hot-swap branch is dead code there — the plain
        // sim is refused on darwin (runtime.go) and macOS is never a deploy
        // target, so nothing ever runs it. It still has to COMPILE, which
        // shm_open does. The mirror macOS actually uses is the file-backed one
        // the loader-host creates (hotswaphost/host.c, __APPLE__ branch).
        source += `static void plc_shm_init(void) {\n`;
        source += `    int fd = shm_open(PLC_SHM_NAME, O_CREAT | O_RDWR, 0666);\n`;
        source += `    if (fd < 0) return;\n`;
        source += `    ftruncate(fd, PLC_SHM_SIZE);\n`;
        source += `    __plc_shm = (uint8_t *)mmap(NULL, PLC_SHM_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);\n`;
        source += `    if (__plc_shm == MAP_FAILED) __plc_shm = NULL;\n`;
        source += `    close(fd);\n`;
        source += `}\n`;
        source += `#endif\n`;
        source += `#endif\n`;
        source += `#define PLC_FORCE_FLAGS_BASE ${FORCE_FLAGS_BASE}\n`;
        // Force-flag byte values: 0 = normal (logic owns the value), 1 = FORCE
        // (value is re-injected every scan → held constant), 2 = PULSE (inject
        // once then auto-release: pull applies it and immediately clears the flag
        // to 0, so the logic resumes from the injected value on the SAME scan —
        // e.g. seeding a counter to 0 which then counts up again). sync writes
        // PlcState→shm only for flag==0, so a released pulse is written back the
        // same scan.
        source += `static void plc_shm_pull(void) {\n`;
        source += `    if (!__plc_shm) return;\n`;
        shmEntries.forEach(({ c_symbol, offset, size, flagOffset }) => {
            source += `    if (__plc_shm[${flagOffset}]) { memcpy((void*)&(S->${c_symbol}), __plc_shm + ${offset}, ${size}); if (__plc_shm[${flagOffset}] == 2) __plc_shm[${flagOffset}] = 0; }\n`;
        });
        source += `}\n`;
        source += `static void plc_shm_sync(void) {\n`;
        source += `    if (!__plc_shm) return;\n`;
        shmEntries.forEach(({ c_symbol, offset, size, flagOffset }) => {
            source += `    if (__plc_shm[${flagOffset}] == 0) { memcpy(__plc_shm + ${offset}, (const void*)&(S->${c_symbol}), ${size}); }\n`;
        });
        source += `}\n`;
        source += `#endif /* __linux__ || _WIN32 */\n\n`;
    }

    // --- 8. DETERMINISTIC SCAN LOOP ---
    if (deviceArtifacts.sourceSupport) {
        source += deviceArtifacts.sourceSupport;
    }
    const ecCfg = ecCfgEarly;
    if (ecCfg.headerDecl) {
        source += ecCfg.headerDecl; // KRON_EC_Config definition in plc.c
    }
    // Addressed SCALAR variables for the lossless capture ring. Only scalars with
    // a real shm slot and a C field symbol (no array/struct member access) — the
    // common case (%MW0, %ML0…). Order/task grouping happens in generateMainLoop.
    const addressedRingVars = Object.entries(variableTable.debugDefaults)
        .filter(([, info]) => info.address && info.offset !== undefined && info.size > 0
            && info.c_symbol && !/[.\[]/.test(info.c_symbol))
        .map(([key, info]) => ({
            name: key,
            cSymbol: info.c_symbol,
            size: info.size,
            offset: info.offset,
            serverType: IEC_TO_SERVER_TYPE[info.type?.toUpperCase()] ?? 'int32',
            isGlobal: key.startsWith('prog__'),
        }));

    // Retain support must precede the scan loop: PLC_Init/PLC_Cleanup and the
    // flusher thread below call plc_retain_load/save, and C needs them declared
    // first. It only references PlcState + S, both from plc.h.
    source += generateRetainSupport(retainEntries);

    const mainLoop = generateMainLoop(
        projectStructure, config, boardId, shmEntries.length > 0, execTimeVars,
        deviceArtifacts.initCode + ecCfg.initCode,
        ecCfg.cleanupCode + deviceArtifacts.cleanupCode,
        ecCfg.pdoReadCode,
        ecCfg.pdoWriteCode,
        ecCfg.ecThreadCode      || '',
        ecCfg.ecThreadStartCode || '',
        ecCfg.ecThreadJoinCode  || '',
        !!ecCfg.halContent,         // gpiMutexEnabled: true when IO_Bus thread owns the bus
        shmEntries,
        plcStateLayoutHash,
        addressedRingVars,
        retainEntries.length > 0
    );
    source += mainLoop.src;
    if (mainLoop.ringConfig) variableTable.ring = mainLoop.ringConfig;
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
    EC_PDO_VAR_NAMES.clear();

    // ── Phase 2 (hot-swap): emit the PlcState struct collected above, the
    // file-scope pointer S, plc_bind() (re-point S at the live state arena after
    // a logic swap) and the cold-init. Both the header (function bodies) and the
    // source (scan loop, SHM sync) reference S->fields.
    // ── HAL-to-host (hot-swap): trampolines ──────────────────────────────────
    // HAL functions are static-inline with file-scope fd state; in a hot-swap
    // build the HAL lives in the loader-host (its fds survive a swap) and the
    // logic .so calls `__hs_*` trampolines instead. We DON'T touch any call
    // site — a macro block in plc.h (after kronhal.h, before the bodies)
    // redirects HAL names to the trampolines; host_glue.c (which defines
    // PLC_HOST_GLUE) keeps the real names to wrap them. EtherCAT/motion are NOT
    // yet trampolined — a project using them can't hot-swap their IO (cold
    // restart), but pure logic + HAL works.
    const halVoidFns = ['KRON_UART_RuntimeInit', 'KRON_UART_RuntimeCleanup'];
    if (boardId) halVoidFns.push('HAL_Init', 'HAL_Cleanup');
    const halCallFns = [...usedHalBlocks].map(t => `${t}_Call`);
    let halDefines = '';
    let hostGlue = '';
    if (halCallFns.length > 0 || boardId) {
        halDefines += `\n#if defined(PLC_HOTSWAP) && !defined(PLC_HOST_GLUE)\n`;
        halDefines += `/* hot-swap: HAL runs in the loader-host; the logic.so calls these trampolines so device fds survive a swap */\n`;
        halVoidFns.forEach(f => { halDefines += `extern void __hs_${f}(void);\n#define ${f} __hs_${f}\n`; });
        halCallFns.forEach(f => { halDefines += `extern void __hs_${f}(void*);\n#define ${f} __hs_${f}\n`; });
        halDefines += `#endif\n`;

        const tramp = [
            ...halVoidFns.map(f => `void __hs_${f}(void) { ${f}(); }`),
            ...halCallFns.map(f => `void __hs_${f}(void *i) { ${f}(i); }`),
        ].join('\n');
        hostGlue =
            `// Autogenerated host-glue — HAL trampolines for hot-swap (HAL state stays in the host).\n` +
            `#include <stdint.h>\n#include <stdbool.h>\n#include <string.h>\n#include <stdlib.h>\n#include <math.h>\n` +
            `${boardDefines}${runtimePortHelpers}${customIncludes}` +
            `extern volatile uint64_t us_tick;\n\n` +
            `${tramp}\n`;
    }

    const plcStateBlock =
        `typedef struct PlcState PlcState;\n` +
        `struct PlcState {\n${stateFields.map(f => '    ' + f).join('\n')}\n};\n` +
        // The single PlcState instance. In a hot-swap build the host owns state
        // (binds S via plc_bind), so this local copy is just the initial and
        // stays `static`. In the normal single-binary build it MUST have
        // EXTERNAL linkage: otherwise -O3 + the SHM pull→use→sync pattern makes
        // every field a pure pass-through (redundant with __plc_shm) and clang
        // dissolves the whole struct via SROA — leaving no `__plc_state` symbol,
        // so the local-sim live-read (DWARF member offsets off &__plc_state)
        // finds nothing → "No variables matched in symbol table". An
        // external-linkage global is observable (no LTO) so it can't be removed
        // or scalarized; its ABI layout matches the DWARF the agent reads.
        `#ifdef PLC_HOTSWAP\n` +
        `static PlcState __plc_state;\n` +
        `#else\n` +
        `PlcState __plc_state;\n` +
        `#endif\n` +
        `static PlcState *S = &__plc_state;\n` +
        `void plc_bind(PlcState *s);\n` +
        `static void plc_state_init(void);\n` +
        halDefines;
    header = header.replace('@@PLCSTATE_STRUCT@@', plcStateBlock);

    source += `\nvoid plc_bind(PlcState *s) { S = s; }\n`;
    source += `static void plc_state_init(void) {\n${stateInits.map(l => '    ' + l).join('\n')}\n}\n`;
    // Run the cold-init once at startup (sets non-zero initial values into S).
    source = source.replace('void PLC_Init(void) {\n', 'void PLC_Init(void) {\n    plc_state_init();\n');

    return { header, source, variableTable, hal: ecCfg.halContent || '', hostGlue, plcStateLayoutHash };
};

const isFBType = (type, structure) => {
    const t = (type || '').trim();
    return structure.functionBlocks?.some(fb => (fb.name || '').trim() === t);
};

// Parse an IEC time-duration literal into integer MICROseconds.
// Supports the full compound form with fractional values and d/h/m/s/ms/us/ns
// units: T#500ms, T#1.5s, T#1m30s, T#1h2m3s500ms, TIME#2d, 10ms (prefix optional).
// Underscore digit separators (T#1_500ms) are allowed. Empty/undefined input
// keeps the historical 10 ms default (unconfigured task interval); anything
// non-empty that does not fully parse THROWS a transpile error instead of
// silently becoming 10000 µs.
const TIME_UNIT_US = {
    'D': 86400000000, 'H': 3600000000, 'M': 60000000,
    'S': 1000000, 'MS': 1000, 'US': 1, 'NS': 0.001,
};
const mapIECtoTimeUs = (iecTimeStr) => {
    if (iecTimeStr === undefined || iecTimeStr === null || String(iecTimeStr).trim() === '') return 10000;
    const raw = String(iecTimeStr).trim();
    const str = raw.toUpperCase().replace(/^(?:LTIME|TIME|LT|T)#/, '').replace(/_/g, '');
    if (!str) return 10000;
    // Bare number (no unit) — historically accepted in pin fields as µs.
    if (/^\d+(?:\.\d+)?$/.test(str)) return Math.round(parseFloat(str));
    // Unit order matters: MS before M, US/NS before S.
    const re = /(\d+(?:\.\d+)?)(MS|US|NS|D|H|M|S)/y;
    let total = 0;
    let idx = 0;
    while (idx < str.length) {
        re.lastIndex = idx;
        const m = re.exec(str);
        if (!m) {
            throw new Error(`Invalid TIME literal "${raw}" — expected forms like T#500ms, T#1.5s, T#1h2m3s500ms.`);
        }
        total += parseFloat(m[1]) * TIME_UNIT_US[m[2]];
        idx = re.lastIndex;
    }
    return Math.round(total);
};

// formatVarInitial — turn a Variable Manager `initialValue` field into a C
// initialiser fragment (`= ...`). Without this normalisation the raw IEC
// text would land in plc.h verbatim and break the build:
//   BOOL  : `True` / `TRUE` / `1`     →  ` = true`        (C `bool`)
//   TIME  : `T#300ms` / `TIME#1s`     →  ` = 300000`      (uint32 µs, matches transformExpr)
//   INT…  : `16#40` / `2#1010`        →  ` = 0x40` / ` = 0b1010`
//   STRING: `hello`                    →  ` = "hello"`
// Empty/undefined returns '' so the caller can append nothing.
const formatVarInitial = (raw, type) => {
    if (raw === undefined || raw === null || raw === '') return '';
    const T = String(type || '').toUpperCase();
    if (T === 'STRING') return ` = "${raw}"`;
    if (T === 'BOOL') {
        const b = String(raw).trim().toLowerCase();
        return ` = ${(b === 'true' || b === '1') ? 'true' : 'false'}`;
    }
    if (T === 'TIME') {
        const s = String(raw).trim();
        if (/^(?:T|TIME)#/i.test(s)) return ` = ${mapIECtoTimeUs(s)}`;
        return ` = ${s}`;
    }
    // Numeric — accept C decimal/hex (`64`, `0x40`) or IEC typed-radix
    // (`16#40`, `2#1010`) and translate the latter to C syntax.
    const rawStr = String(raw).trim();
    const cVal = rawStr.replace(/\b(\d+)#([0-9A-Fa-f_]+)\b/g, (_, base, digits) => {
        const cleaned = digits.replace(/_/g, '');
        if (base === '16') return `0x${cleaned}`;
        if (base === '2')  return `0b${cleaned}`; // GCC extension
        if (base === '8')  return `0${cleaned}`;
        return parseInt(cleaned, parseInt(base, 10)).toString();
    });
    return ` = ${cVal}`;
};

const formatUsDisplay = (us) => {
    if (us >= 1000000 && us % 1000000 === 0) return `${us / 1000000}s`;
    if (us >= 1000 && us % 1000 === 0) return `${us / 1000}ms`;
    return `${us}us`;
};



/**
 * generateEtherCATConfig — build C init/cleanup/cycle code for KRON_EC_Config
 * Returns { headerDecl, initCode, cleanupCode, pdoReadCode, pdoWriteCode }
 */
// Maps KRON_EC_DataType enum names → C scalar types for the GPI struct members
const KRON_DTYPE_TO_C = {
    'KRON_EC_DTYPE_BOOL':   'bool',
    'KRON_EC_DTYPE_INT8':   'int8_t',
    'KRON_EC_DTYPE_UINT8':  'uint8_t',
    'KRON_EC_DTYPE_INT16':  'int16_t',
    'KRON_EC_DTYPE_UINT16': 'uint16_t',
    'KRON_EC_DTYPE_INT32':  'int32_t',
    'KRON_EC_DTYPE_UINT32': 'uint32_t',
    'KRON_EC_DTYPE_INT64':  'int64_t',
    'KRON_EC_DTYPE_UINT64': 'uint64_t',
    'KRON_EC_DTYPE_REAL32': 'float',
    'KRON_EC_DTYPE_REAL64': 'double',
};

const generateEtherCATConfig = (buses, busConfigs, globalSimMode = false) => {
    const ecBuses = (buses || []).filter(b => b.type === 'ethercat' && busConfigs?.[b.id]);
    if (ecBuses.length === 0) return {
        headerDecl: '', headerExtern: '', gpiMacros: '', motionIncludes: '', initCode: '', cleanupCode: '',
        pdoReadCode: '', pdoWriteCode: '',
        ecThreadCode: '', ecThreadStartCode: '', ecThreadJoinCode: '',
        halContent: '', gpiVarNames: []
    };

    // Only the first EtherCAT bus is used for now
    const cfg = busConfigs[ecBuses[0].id] || {};
    const slaves = cfg.slaves || [];

    let initCode = `\n    /* ── EtherCAT Master ── */\n`;
    initCode += `    memset(&__ec_cfg, 0, sizeof(__ec_cfg));\n`;
    initCode += `    strncpy(__ec_cfg.ifname, ${JSON.stringify((cfg.ifname || 'eth0').slice(0, 63))}, sizeof(__ec_cfg.ifname) - 1);\n`;
    initCode += `    __ec_cfg.cycle_us = ${Math.max(100, parseInt(cfg.cycle_us) || 1000)}U;\n`;
    initCode += `    __ec_cfg.dc_enable = ${cfg.dc_enable ? 'true' : 'false'};\n`;
    initCode += `    __ec_cfg.slave_count = ${slaves.length};\n`;

    // Collect PDO vars for the Global Process Image struct
    const gpiInputVars  = [];  // { varName, cType }  — TxPDO: slave → master
    const gpiOutputVars = [];  // { varName, cType }  — RxPDO: master → slave
    const usedVarNames = new Set();

    // CiA402 object index → KRON_SERVO_SLOT field name
    const CIA402_IN  = { 0x6041:'status_word', 0x6064:'actual_pos_raw', 0x606C:'actual_vel_raw',
                         0x6077:'actual_torque_raw', 0x60F4:'following_error_raw', 0x6061:'mode_display' };
    const CIA402_OUT = { 0x6040:'control_word', 0x607A:'target_pos_raw', 0x60FF:'target_vel_raw',
                         0x6071:'target_torque_raw', 0x6060:'mode_of_operation' };
    // Per-slave bridge map: slaveIndex → { axisNo, reads:[{varName,field}], writes:[{varName,field}] }
    const slaveBridges = {};

    const makeUniqueVarName = (rawName, slaveIndex) => {
        const cleaned = (rawName || '')
            .replace(/[^A-Za-z0-9_]/g, '_')
            .replace(/__+/g, '_')
            .replace(/^_+|_+$/g, '');
        const base = cleaned || `ec_slave_${slaveIndex + 1}_var`;
        if (!usedVarNames.has(base)) {
            usedVarNames.add(base);
            return base;
        }

        let n = 2;
        let candidate = `${base}_${n}`;
        while (usedVarNames.has(candidate)) {
            n++;
            candidate = `${base}_${n}`;
        }
        usedVarNames.add(candidate);
        return candidate;
    };

    slaves.forEach((slave, si) => {
        const safeName = (slave.name || `Slave_${si + 1}`).replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 63);
        initCode += `\n    /* Slave ${si}: ${safeName} */\n`;
        initCode += `    __ec_cfg.slaves[${si}].position     = ${Math.max(1, parseInt(slave.position) || (si + 1))};\n`;
        initCode += `    __ec_cfg.slaves[${si}].vendor_id    = 0x${((slave.vendorId || 0) >>> 0).toString(16).toUpperCase().padStart(8, '0')}UL;\n`;
        initCode += `    __ec_cfg.slaves[${si}].product_code = 0x${((slave.productCode || 0) >>> 0).toString(16).toUpperCase().padStart(8, '0')}UL;\n`;
        initCode += `    strncpy(__ec_cfg.slaves[${si}].name, "${safeName}", sizeof(__ec_cfg.slaves[${si}].name) - 1);\n`;

        let pdoCount = 0;
        const safeSlaveName = (slave.name || `Slave_${si + 1}`).replace(/[^A-Za-z0-9_]/g, '_');
        (slave.pdos || []).forEach(pdo => {
            (pdo.entries || []).forEach(entry => {
                if (!entry.selected) return;
                // Use custom varName if set; otherwise auto-generate like pdoEntriesToGlobalVars
                const customName = (entry.varName || '').trim();
                const autoName = `ec_${safeSlaveName}_${(entry.name || 'var')}`;
                const varName = makeUniqueVarName(customName || autoName, si);
                if (!varName) return;
                const isInput = pdo.direction === 'input';
                const dir   = isInput ? 'KRON_EC_DIR_INPUT' : 'KRON_EC_DIR_OUTPUT';
                const dtype = entry.kronDtype || 'KRON_EC_DTYPE_UINT8';
                const cType = KRON_DTYPE_TO_C[dtype] || 'uint8_t';
                const idx = (entry.index || 0) >>> 0;
                const sub = (entry.subindex || 0) & 0xFF;
                initCode += `    __ec_cfg.slaves[${si}].pdo_entries[${pdoCount}].index    = 0x${idx.toString(16).toUpperCase().padStart(4, '0')};\n`;
                initCode += `    __ec_cfg.slaves[${si}].pdo_entries[${pdoCount}].subindex = 0x${sub.toString(16).toUpperCase().padStart(2, '0')};\n`;
                initCode += `    __ec_cfg.slaves[${si}].pdo_entries[${pdoCount}].dtype    = ${dtype};\n`;
                initCode += `    __ec_cfg.slaves[${si}].pdo_entries[${pdoCount}].dir      = ${dir};\n`;
                // var_ptr targets __gpi_hw (the dedicated HW staging buffer).
                // Uses _pi_ prefix so the name does NOT match the access macro.
                initCode += `    __ec_cfg.slaves[${si}].pdo_entries[${pdoCount}].var_ptr  = &__gpi_hw._pi_${varName};\n`;
                if (isInput) gpiInputVars.push({ varName, cType });
                else         gpiOutputVars.push({ varName, cType });
                // CiA402 bridge: record GPI↔slot mapping for axis slaves
                if (slave.axisRef?.enabled) {
                    if (!slaveBridges[si]) slaveBridges[si] = { reads: [], writes: [] };
                    if (isInput  && CIA402_IN[idx])  slaveBridges[si].reads.push({ varName, field: CIA402_IN[idx] });
                    if (!isInput && CIA402_OUT[idx]) slaveBridges[si].writes.push({ varName, field: CIA402_OUT[idx] });
                }
                pdoCount++;
            });
        });
        initCode += `    __ec_cfg.slaves[${si}].pdo_count = ${pdoCount};\n`;

        // Auto-generate PDO mapping SDOs from selected PDO entries.
        // This configures 0x1600/0x1A00 (PDO objects) and 0x1C12/0x1C13 (SM assignment)
        // so ecx_config_map_group sees the correct layout in PREOP.
        const pdoMapSdos = [];
        const rxPdoGroups = []; // output: master→slave
        const txPdoGroups = []; // input:  slave→master
        (slave.pdos || []).forEach(pdo => {
            const sel = (pdo.entries || []).filter(e => e.selected);
            if (sel.length === 0) return;
            if (pdo.direction === 'output') rxPdoGroups.push({ index: pdo.index, entries: sel, fixed: pdo.fixed });
            else                            txPdoGroups.push({ index: pdo.index, entries: sel, fixed: pdo.fixed });
        });
        if (rxPdoGroups.length > 0 || txPdoGroups.length > 0) {
            // Clear sync managers first
            pdoMapSdos.push({ index: 0x1C12, subindex: 0, value: 0, byteSize: 1 });
            pdoMapSdos.push({ index: 0x1C13, subindex: 0, value: 0, byteSize: 1 });
            // Configure each RxPDO object
            for (const g of rxPdoGroups) {
                if (g.fixed) continue;
                pdoMapSdos.push({ index: g.index, subindex: 0, value: 0, byteSize: 1 });
                g.entries.forEach((e, i) => {
                    const mapping = (((e.index || 0) & 0xFFFF) << 16) | (((e.subindex || 0) & 0xFF) << 8) | ((e.bitLen || 0) & 0xFF);
                    pdoMapSdos.push({ index: g.index, subindex: i + 1, value: mapping >>> 0, byteSize: 4 });
                });
                pdoMapSdos.push({ index: g.index, subindex: 0, value: g.entries.length, byteSize: 1 });
            }
            // Configure each TxPDO object
            for (const g of txPdoGroups) {
                if (g.fixed) continue;
                pdoMapSdos.push({ index: g.index, subindex: 0, value: 0, byteSize: 1 });
                g.entries.forEach((e, i) => {
                    const mapping = (((e.index || 0) & 0xFFFF) << 16) | (((e.subindex || 0) & 0xFF) << 8) | ((e.bitLen || 0) & 0xFF);
                    pdoMapSdos.push({ index: g.index, subindex: i + 1, value: mapping >>> 0, byteSize: 4 });
                });
                pdoMapSdos.push({ index: g.index, subindex: 0, value: g.entries.length, byteSize: 1 });
            }
            // Assign PDO groups to sync managers
            rxPdoGroups.forEach((g, i) => { pdoMapSdos.push({ index: 0x1C12, subindex: i + 1, value: g.index, byteSize: 2 }); });
            pdoMapSdos.push({ index: 0x1C12, subindex: 0, value: rxPdoGroups.length, byteSize: 1 });
            txPdoGroups.forEach((g, i) => { pdoMapSdos.push({ index: 0x1C13, subindex: i + 1, value: g.index, byteSize: 2 }); });
            pdoMapSdos.push({ index: 0x1C13, subindex: 0, value: txPdoGroups.length, byteSize: 1 });
        }

        const userSdos = (slave.sdos || []);
        const allSdos = [...pdoMapSdos, ...userSdos].slice(0, 64);
        allSdos.forEach((sdo, di) => {
            const sidx = (sdo.index || 0) >>> 0;
            initCode += `    __ec_cfg.slaves[${si}].sdo_inits[${di}].index     = 0x${sidx.toString(16).toUpperCase().padStart(4, '0')};\n`;
            initCode += `    __ec_cfg.slaves[${si}].sdo_inits[${di}].subindex  = ${(sdo.subindex || 0) & 0xFF};\n`;
            initCode += `    __ec_cfg.slaves[${si}].sdo_inits[${di}].value     = 0x${((sdo.value || 0) >>> 0).toString(16).toUpperCase().padStart(8, '0')}UL;\n`;
            initCode += `    __ec_cfg.slaves[${si}].sdo_inits[${di}].byte_size = ${Math.min(4, Math.max(1, parseInt(sdo.byteSize) || 1))};\n`;
        });
        if (allSdos.length > 0) initCode += `    __ec_cfg.slaves[${si}].sdo_count = ${allSdos.length};\n`;
    });

    initCode += `    kron_ec_init(&__ec_cfg);\n`;

    const cleanupCode  = `    kron_ec_close(&__ec_cfg);\n`;
    // pdoReadCode / pdoWriteCode are retained for Windows & bare-metal paths where
    // there is no separate IO_Bus thread.  generateMainLoop skips injecting them
    // into logic tasks when gpiMutexEnabled is true (Linux double-buffer path).
    const pdoReadCode  = `        kron_ec_pdo_read(&__ec_cfg);\n`;
    const pdoWriteCode = `        kron_ec_pdo_write(&__ec_cfg);\n`;

    // --- Build kron_hal.h -------------------------------------------------------
    // Deduplicate by varName (safety net — makeUniqueVarName should already prevent
    // dupes, but two slaves with identical names can still collide via customName).
    const seenGpiNames = new Set();
    const uniqueInputVars  = gpiInputVars.filter(v => {
        if (seenGpiNames.has(v.varName)) return false;
        seenGpiNames.add(v.varName); return true;
    });
    const uniqueOutputVars = gpiOutputVars.filter(v => {
        if (seenGpiNames.has(v.varName)) return false;
        seenGpiNames.add(v.varName); return true;
    });
    const uniqueGpiVars = [...uniqueInputVars, ...uniqueOutputVars];

    // GPI struct body — members use _pi_ prefix so the GPI access macros
    // (which use the bare variable name) never expand inside the struct definition
    // or inside var_ptr assignments (which reference _pi_${varName} directly).
    let gpiStructBody = '';
    if (uniqueInputVars.length > 0) {
        gpiStructBody += `    /* INPUTS \u2014 slave \u2192 master (TxPDO) */\n`;
        uniqueInputVars.forEach(v => {
            gpiStructBody += `    ${v.cType.padEnd(12)} _pi_${v.varName};\n`;
        });
    }
    if (uniqueOutputVars.length > 0) {
        if (uniqueInputVars.length > 0) gpiStructBody += '\n';
        gpiStructBody += `    /* OUTPUTS \u2014 master \u2192 slave (RxPDO) */\n`;
        uniqueOutputVars.forEach(v => {
            gpiStructBody += `    ${v.cType.padEnd(12)} _pi_${v.varName};\n`;
        });
    }
    if (uniqueGpiVars.length === 0) {
        gpiStructBody += `    uint8_t __reserved; /* no PDO entries configured */\n`;
    }

    // GPI access macros — kept SEPARATE from kron_hal.h so they can be injected
    // into plc.h AFTER all global variable declarations.  This prevents the macro
    // from firing on a global-variable declaration that shares the same name.
    // Linux  : route through the per-scan snapshot pointer (__gpi_snap).
    // Other  : route through the single-buffer alias (__gpi_hw == __gpi).
    const linuxMacroLines    = uniqueGpiVars.map(v =>
        `#define ${v.varName.padEnd(36)} (__gpi_snap->_pi_${v.varName})`).join('\n');
    const nonLinuxMacroLines = uniqueGpiVars.map(v =>
        `#define ${v.varName.padEnd(36)} (__gpi_hw._pi_${v.varName})`).join('\n');
    const gpiMacros = uniqueGpiVars.length === 0 ? '' :
`/* GPI transparent access macros (injected after global variable declarations) */
#if defined(__linux__)
${linuxMacroLines}
#else
${nonLinuxMacroLines}
#endif /* __linux__ */
`;

    const halContent =
`/* kron_hal.h \u2014 Fieldbus-Agnostic Hardware Abstraction Layer
 * AUTO-GENERATED by KronEditor. Do NOT edit manually.
 *
 * Lock-free double-buffer design (Linux):
 *   __gpi_hw      \u2014 HW staging buffer; all var_ptr fields point here.
 *   __gpi_buf[2]  \u2014 double buffer visible to logic tasks.
 *   __gpi         \u2014 atomic pointer to the "front" (published) buffer.
 *   __gpi_snap    \u2014 thread-local pointer; snapped once per scan cycle so
 *                    every POU access within one scan sees consistent data.
 *
 * NOTE: GPI access macros (#define varName ...) are NOT included here.
 * They are injected into plc.h AFTER global variable declarations to prevent
 * macro expansion of user-declared global variables with matching names.
 *
 * Bare-metal / Windows: single buffer (__gpi), no threading.
 */
#ifndef KRON_HAL_H
#define KRON_HAL_H

#include <stdint.h>
#include <stdbool.h>

/* \u2500\u2500 Global Process Image \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
typedef struct {
${gpiStructBody}} KRON_Process_Image;

#if defined(__linux__)
/* \u2500\u2500 Lock-free double-buffer (Linux) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
#include <stdatomic.h>
extern KRON_Process_Image            __gpi_hw;      /* HW staging \u2014 var_ptr targets  */
extern KRON_Process_Image            __gpi_buf[2];  /* double buffer                  */
extern _Atomic(KRON_Process_Image *) __gpi;         /* published front pointer        */
extern _Thread_local KRON_Process_Image *__gpi_snap; /* per-scan snapshot             */
#else /* bare-metal / Windows: single buffer */
/* \u2500\u2500 Single-buffer fallback \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
extern KRON_Process_Image __gpi;
#define __gpi_hw __gpi   /* var_ptr targets the single buffer on non-Linux */
#endif /* __linux__ */

#endif /* KRON_HAL_H */
`;

    // Collect axis-enabled slaves for motion init codegen.
    // NOTE: AXIS_REF declarations are NOT generated here — they come from the
    // user-facing global variable table (type = 'AXIS_REF'), so the user can
    // reference Axis1.ControlWord etc. directly in PLC programs.
    // Only KRON_PROCESS_IMAGE Kron_PI is declared here (internal, not user-visible).
    const axisSlaves = slaves
        .map((slave, si) => ({ slave, si }))
        .filter(({ slave }) => slave.axisRef?.enabled);

    // Helper: emit a float literal that always has a decimal point (C99 requires it)
    const floatLit = (n) => {
        const f = parseFloat(n);
        return Number.isInteger(f) ? `${f}.0f` : `${f}f`;
    };

    const hasAxes = axisSlaves.length > 0;

    // Generate GPI↔KRON_SERVO_SLOT bridge code for the IO Bus thread.
    // ncReadBridge : after kron_ec_pdo_read  — copy GPI inputs  → Kron_PI.servo[n]
    // ncWriteBridge: after NC_ProcessOne     — copy Kron_PI.servo[n] → GPI outputs
    let ncReadBridge = '';
    let ncWriteBridge = '';
    axisSlaves.forEach(({ slave, si }) => {
        const axisNo = Math.max(0, parseInt(slave.axisRef.axisNo) || 0);
        const br = slaveBridges[si];
        if (!br) return;
        if (br.reads.length)  ncReadBridge  += `        /* Axis ${axisNo} inputs */\n`;
        br.reads.forEach(({ varName, field }) => {
            ncReadBridge  += `        Kron_PI.servo[${axisNo}].${field} = __gpi_hw._pi_${varName};\n`;
        });
        if (br.writes.length) ncWriteBridge += `        /* Axis ${axisNo} outputs */\n`;
        br.writes.forEach(({ varName, field }) => {
            ncWriteBridge += `        __gpi_hw._pi_${varName} = Kron_PI.servo[${axisNo}].${field};\n`;
        });
    });

    let axisInitCode = '';
    if (hasAxes) {
        axisInitCode += `\n    /* ── Motion Axes ── */\n    memset(&Kron_PI, 0, sizeof(Kron_PI));\n`;
        axisSlaves.forEach(({ slave }, i) => {
            const axisName = (slave.axisRef.name || `Axis_${slave.position}`).replace(/[^A-Za-z0-9_]/g, '_');
            const axisNo   = Math.max(0, parseInt(slave.axisRef.axisNo) || 0);
            const stBits   = parseInt(slave.axisRef.singleTurnBits) || 13;
            const encRes   = Math.pow(2, stBits);   // 2^singleTurnBits = counts per rev
            const gearRatio         = parseFloat(slave.axisRef.gearRatio);
            const gRatio = Number.isFinite(gearRatio) && gearRatio > 0 ? gearRatio : 1;
            // counts_per_unit = encoder counts per motor rev / user units per motor rev
            // Example: 2^13 = 8192 counts/rev, gear ratio 5 (1 rev = 5 mm) → 8192/5 = 1638.4 counts/mm
            const cpu = encRes / gRatio;
            // vel_raw_per_unit: drive reports velocity in counts/s — same ratio applies
            const vpu = cpu;
            const sim = (globalSimMode || slave.axisRef.simMode) ? 'true' : 'false';
            // AXIS_REF_Init zeroes the struct and sets AxisNo, slot, VelFactor=1, AccFactor=1.
            // The AXIS_REF global is a PlcState field (hot-swap refactor), so it is
            // reached via S-> — this init code lands in PLC_Init (plc.c), where the
            // file-scope S from plc.h is in scope.
            axisInitCode += `    AXIS_REF_Init(&S->${axisName}, ${axisNo}, &Kron_PI.servo[${axisNo}]);\n`;
            const encTypeMap = { incremental: 'KRON_ENC_INCREMENTAL', absolute_st: 'KRON_ENC_ABSOLUTE_ST', absolute_mt: 'KRON_ENC_ABSOLUTE_MT' };
            const encType = encTypeMap[slave.axisRef.encoderType] || 'KRON_ENC_INCREMENTAL';
            axisInitCode += `    S->${axisName}.Simulation        = ${sim};\n`;
            axisInitCode += `    S->${axisName}.GearRatio         = ${floatLit(gRatio)};\n`;
            axisInitCode += `    S->${axisName}.EncoderType       = ${encType};\n`;
            // Scaling factors on the servo slot (set after AXIS_REF_Init so slot is valid)
            axisInitCode += `    Kron_PI.servo[${axisNo}].counts_per_unit   = ${floatLit(cpu)};\n`;
            axisInitCode += `    Kron_PI.servo[${axisNo}].vel_raw_per_unit  = ${floatLit(vpu)};\n`;
            axisInitCode += `    Kron_PI.servo[${axisNo}].encoder_type        = ${encType};\n`;
            axisInitCode += `    Kron_PI.servo[${axisNo}].enc_single_turn_bits = ${stBits}u;\n`;
            if (slave.axisRef.encoderType === 'absolute_mt') {
                axisInitCode += `    Kron_PI.servo[${axisNo}].enc_multi_turn_bits  = ${parseInt(slave.axisRef.multiTurnBits) || 12}u;\n`;
            }
            axisInitCode += `    Kron_PI.servo[${axisNo}].present           = !${sim};\n`;
            // NC engine private state
            axisInitCode += `    NC_Init(&g_NC_Axes[${i}], &S->${axisName});\n`;
        });
    }
    initCode += axisInitCode;

    // headerDecl: definitions in plc.c
    // __gpi_snap is initialised to NULL; generateMainLoop sets it via
    // atomic_load_explicit at the top of every logic task's scan loop,
    // so it is always valid before any POU macro dereferences it.
    const kronPIDecl = hasAxes
        ? `KRON_PROCESS_IMAGE  Kron_PI;\n` +
          `KRON_HAL_Driver    *Kron_HAL = NULL;\n` +
          `NC_AXIS             g_NC_Axes[${axisSlaves.length}];\n`
        : '';
    // NC Engine stubs — provided inline so the build succeeds when libkronmotion
    // does not yet export NC_Init / NC_ProcessOne.  The weak attribute lets a real
    // library implementation take precedence if it is ever linked (GCC/Clang only).
    // NC_Init and NC_ProcessOne are provided by libkronmotion.a — no inline
    // stubs needed.  Using extern declarations so the linker pulls the real
    // implementations from the archive (weak stubs would prevent this).
    const ncStubs = '';
    const headerDecl =
`\n#if defined(__linux__)\n` +
`KRON_Process_Image            __gpi_hw;\n` +
`KRON_Process_Image            __gpi_buf[2];\n` +
`_Atomic(KRON_Process_Image *) __gpi = &__gpi_buf[0];\n` +
`_Thread_local KRON_Process_Image *__gpi_snap = NULL;\n` +
`#else\n` +
`KRON_Process_Image __gpi;\n` +
`#endif\n` +
`KRON_EC_Config __ec_cfg;\n` +
kronPIDecl +
ncStubs;

    // motionIncludes: injected EARLY in plc.h (before global vars) so AXIS_REF type
    // is defined by the time the global variable `AXIS_REF Axis1;` is emitted.
    const motionIncludes = hasAxes
        ? `#include "kron_pi.h"\n#include "kronmotion.h"\n#include "kron_nc.h"\nextern KRON_PROCESS_IMAGE Kron_PI;\n`
        : '';

    // headerExtern: injected into plc.h in the EtherCAT HAL section (after global vars).
    // Does NOT repeat motion includes — they are in motionIncludes (injected earlier).
    const headerExtern =
`\n#include "kron_hal.h"\n` +
`extern KRON_EC_Config __ec_cfg;\n` +
(hasAxes
    ? `extern NC_AXIS             g_NC_Axes[${axisSlaves.length}];\n` +
      `extern KRON_HAL_Driver    *Kron_HAL;\n`
    : '');

    // SDO background thread + watchdog thread + IO_Bus thread (Linux only)
    const ecThreadCode = `
#if defined(__linux__)
static void* __ec_sdo_thread(void *arg) {
    (void)arg;
    while (!plc_stop) {
        kron_ec_process_sdo(&__ec_cfg);
        struct timespec __ts = { 0, 100000L }; /* 100 \u00b5s */
        nanosleep(&__ts, NULL);
    }
    return NULL;
}
static void* __ec_watchdog_thread(void *arg) {
    (void)arg;
    while (!plc_stop) {
        kron_ec_check_state(&__ec_cfg);
        struct timespec __ts = { 0, 100000000L }; /* 100 ms */
        nanosleep(&__ts, NULL);
    }
    return NULL;
}
/* plc_task_IO_Bus \u2014 dedicated fieldbus I/O thread (lock-free).
 *
 * This is the ONLY thread that calls kron_ec_pdo_read / kron_ec_pdo_write.
 * All var_ptr fields in __ec_cfg point into __gpi_hw (the HW staging buffer).
 *
 * Each bus cycle:
 *   1. Identify which of __gpi_buf[0/1] is the current front (logic reads it).
 *   2. Copy *front \u2192 __gpi_hw so the latest logic outputs reach the hardware.
 *   3. kron_ec_pdo_write: transmit __gpi_hw outputs \u2192 slave RxPDOs.
 *   4. kron_ec_pdo_read:  receive slave TxPDOs \u2192 __gpi_hw inputs.
 *   5. Copy __gpi_hw \u2192 *back  (back buffer now has fresh inputs + last outputs).
 *   6. Atomic pointer swap: publish back as the new front (release semantics).
 *      Logic tasks observe the new front at their next scan-cycle boundary. */
static void* plc_task_IO_Bus(void *arg) {
    (void)arg;
    { struct sched_param __sp = { .sched_priority = sched_get_priority_max(SCHED_FIFO) };
      pthread_setschedparam(pthread_self(), SCHED_FIFO, &__sp); }
    unsigned long __ec_ns = (unsigned long)__ec_cfg.cycle_us * 1000UL;
    struct timespec __next;
    clock_gettime(CLOCK_MONOTONIC, &__next);
    while (!plc_stop) {
        __next.tv_nsec += __ec_ns;
        while (__next.tv_nsec >= 1000000000L) { __next.tv_sec++; __next.tv_nsec -= 1000000000L; }

        /* Identify front (logic reads) and back (we build next image here) */
        KRON_Process_Image *front = atomic_load_explicit(&__gpi, memory_order_relaxed);
        KRON_Process_Image *back  = (front == &__gpi_buf[0]) ? &__gpi_buf[1] : &__gpi_buf[0];

        /* Step 1-2: Capture latest logic outputs into HW staging, then send to hardware */
        __gpi_hw = *front;
        kron_ec_pdo_write(&__ec_cfg);

        /* Step 3: Receive hardware inputs into HW staging */
        kron_ec_pdo_read(&__ec_cfg);

${hasAxes ? `${ncReadBridge}        /* NC Engine: run motion profile for each axis (cycle-synchronous) */
        { float __nc_dt = (float)__ec_cfg.cycle_us * 1e-6f;
          for (uint16_t __i = 0; __i < ${axisSlaves.length}U; __i++) {
              NC_ProcessOne(&g_NC_Axes[__i], __nc_dt);
          }
        }
${ncWriteBridge}` : ''}        /* Step 4: Propagate HW-updated staging to the back buffer.
         * Back buffer now has: fresh hardware inputs + last logic outputs. */
        *back = __gpi_hw;

        /* Step 5: Atomic pointer swap \u2014 publish back as the new front.
         * Logic tasks acquire this pointer (memory_order_acquire) at the start
         * of each scan cycle, ensuring they see all writes above. */
        atomic_store_explicit(&__gpi, back, memory_order_release);

        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &__next, NULL);
    }
    return NULL;
}
#endif /* __linux__ */
`;

    const ecThreadStartCode =
`\n    /* EtherCAT background threads + lock-free IO_Bus */\n` +
`    pthread_t __ec_sdo_tid, __ec_wd_tid, __ec_io_tid;\n` +
`    pthread_create(&__ec_sdo_tid, NULL, __ec_sdo_thread,      NULL);\n` +
`    pthread_create(&__ec_wd_tid,  NULL, __ec_watchdog_thread, NULL);\n` +
`    pthread_create(&__ec_io_tid,  NULL, plc_task_IO_Bus,      NULL);\n`;

    const ecThreadJoinCode =
`    pthread_join(__ec_sdo_tid, NULL);\n` +
`    pthread_join(__ec_wd_tid,  NULL);\n` +
`    pthread_join(__ec_io_tid,  NULL);\n`;

    return {
        headerDecl, headerExtern, gpiMacros, motionIncludes, initCode, cleanupCode,
        pdoReadCode, pdoWriteCode, ecThreadCode, ecThreadStartCode, ecThreadJoinCode,
        halContent,
        // Names of all GPI-macro-backed PDO variables — transpileToC excludes
        // same-named user globals from PlcState/SHM so the macro applies.
        gpiVarNames: uniqueGpiVars.map(v => v.varName),
    };
};

// ── RETENTIVE (RETAIN) VARIABLES ─────────────────────────────────────────────
// A variable declared with class `Retain` keeps its LAST value across a runtime
// restart (IEC 61131-3 warm restart). Every retainable value already lives in
// exactly one place — PlcState — so persistence is a name-keyed snapshot of a
// subset of its fields to a file (`retain.dat`) in the runtime's cwd: the deploy
// dir on a target (process.go sets cmd.Dir), the build dir for the local sim
// (hotswap.go does the same).
//
// ⚠️ The file is SELF-DESCRIBING and matched BY NAME, not by struct layout.
// A rebuild that adds/removes/retypes variables must not discard the values of
// everything else, and a raw `memcpy(&PlcState)` blob would do exactly that (it
// would also silently restore garbage into the wrong fields once a field moved).
// Records whose name is unknown are skipped; a name whose size no longer matches
// is skipped; a retained variable with no record simply keeps its initial value.
//
// ⚠️ The snapshot is taken ASYNCHRONOUSLY (a flusher thread, not the scan), so a
// >word-sized value (LINT/LREAL on a 32-bit board) can in principle be sampled
// mid-update. Scan-synchronised capture would need per-task partitioning like
// the capture ring's producer (§16) — a known v1 gap, not an oversight.
//
// Layout: "KRTN" u16 version u16 count, then count × { u16 nameLen, name,
// u16 size, value bytes }. Scalars are explicit little-endian; the payload is
// raw native bytes (only ever read back by the same runtime on the same box).
const RETAIN_INTERVAL_MS = 1000;
// The declaration side is the variable's CLASS (IEC's `VAR_GLOBAL RETAIN` /
// `VAR RETAIN`), matched case-insensitively like every other identifier here.
export const isRetainVar = (v) => String(v?.class || '').toLowerCase() === 'retain';
const generateRetainSupport = (retainEntries) => {
    if (!retainEntries.length) return '';
    let s = `\n// --- RETENTIVE (RETAIN) VARIABLES ---\n`;
    s += `// Values persisted to ./${'retain.dat'} and restored at PLC_Init. See CLAUDE.md §17.\n`;
    s += `#include <stdio.h>\n#include <stddef.h>\n`;
    s += `#if defined(_WIN32)\n`;
    // ⚠️ ISO rename() fails on Windows when the destination exists (same trap as
    // host.c's swap_result), so the atomic replace must go through MoveFileEx.
    s += `int MoveFileExA(const char *src, const char *dst, unsigned long flags);\n`;
    s += `#define PLC_RETAIN_REPLACE 0x1UL /* MOVEFILE_REPLACE_EXISTING */\n`;
    s += `#endif\n`;
    s += `#define PLC_RETAIN_FILE "retain.dat"\n`;
    s += `#define PLC_RETAIN_TMP  "retain.dat.tmp"\n`;
    s += `#define PLC_RETAIN_VERSION 1u\n`;
    s += `#define PLC_RETAIN_MAX_FILE (16u << 20) /* sanity bound: refuse an absurd/corrupt file outright (the whole file is read into memory) */\n`;
    s += `typedef struct { const char *name; unsigned int off; unsigned int sz; } plc_retain_ent;\n`;
    s += `static const plc_retain_ent __retain_tab[] = {\n`;
    retainEntries.forEach(({ key, field }) => {
        s += `    { "${key}", (unsigned int)offsetof(PlcState, ${field}), (unsigned int)sizeof(((PlcState *)0)->${field}) },\n`;
    });
    s += `};\n`;
    s += `#define PLC_RETAIN_COUNT ((int)(sizeof(__retain_tab) / sizeof(__retain_tab[0])))\n\n`;
    s += `static unsigned char *__retain_img = NULL;   /* image packed on each save */\n`;
    s += `static unsigned char *__retain_prev = NULL;  /* last image actually written */\n`;
    s += `static unsigned int   __retain_len = 0;\n`;
    s += `static void __retain_put16(unsigned char *b, unsigned int v) { b[0] = (unsigned char)(v & 0xFF); b[1] = (unsigned char)((v >> 8) & 0xFF); }\n`;
    s += `static unsigned int __retain_get16(const unsigned char *b) { return (unsigned int)b[0] | ((unsigned int)b[1] << 8); }\n`;
    // ⚠️ The VALUE length is 32-bit on purpose. A retained ARRAY[0..20000] OF
    // DINT is 80 KB — a u16 length would wrap silently and restore a fraction
    // of the array over the rest of PlcState. Names stay u16 (identifiers).
    s += `static void __retain_put32(unsigned char *b, unsigned int v) { for (int k = 0; k < 4; k++) b[k] = (unsigned char)((v >> (8 * k)) & 0xFF); }\n`;
    s += `static unsigned int __retain_get32(const unsigned char *b) {\n`;
    s += `    unsigned int v = 0; for (int k = 0; k < 4; k++) v |= (unsigned int)b[k] << (8 * k); return v;\n}\n\n`;
    s += `static unsigned int __retain_image_len(void) {\n`;
    s += `    unsigned int n = 8; /* magic(4) + version(2) + count(2) */\n`;
    s += `    for (int i = 0; i < PLC_RETAIN_COUNT; i++) n += 6 + (unsigned int)strlen(__retain_tab[i].name) + __retain_tab[i].sz;\n`;
    s += `    return n;\n}\n\n`;
    s += `static void __retain_pack(unsigned char *b) {\n`;
    s += `    memcpy(b, "KRTN", 4);\n`;
    s += `    __retain_put16(b + 4, PLC_RETAIN_VERSION);\n`;
    s += `    __retain_put16(b + 6, (unsigned int)PLC_RETAIN_COUNT);\n`;
    s += `    unsigned char *p = b + 8;\n`;
    s += `    for (int i = 0; i < PLC_RETAIN_COUNT; i++) {\n`;
    s += `        unsigned int nl = (unsigned int)strlen(__retain_tab[i].name);\n`;
    s += `        __retain_put16(p, nl); p += 2;\n`;
    s += `        memcpy(p, __retain_tab[i].name, nl); p += nl;\n`;
    s += `        __retain_put32(p, __retain_tab[i].sz); p += 4;\n`;
    s += `        memcpy(p, (const unsigned char *)S + __retain_tab[i].off, __retain_tab[i].sz);\n`;
    s += `        p += __retain_tab[i].sz;\n`;
    s += `    }\n}\n\n`;
    // Non-static: in a hot-swap build the loader-host dlsym's plc_retain_save to
    // drive the periodic flush (the logic module owns no threads of its own).
    s += `/* Restores retained values over the initial ones. Called at the END of\n`;
    s += ` * PLC_Init — i.e. after plc_state_init() has seeded every initial value,\n`;
    s += ` * so a retained variable overrides its initial and an unretained (or\n`;
    s += ` * brand-new) one keeps it. */\n`;
    s += `void plc_retain_load(void) {\n`;
    s += `    FILE *f = fopen(PLC_RETAIN_FILE, "rb");\n`;
    s += `    if (!f) return;              /* first ever run — initial values stand */\n`;
    s += `    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return; }\n`;
    s += `    long len = ftell(f);\n`;
    s += `    if (len < 8 || len > (long)PLC_RETAIN_MAX_FILE || fseek(f, 0, SEEK_SET) != 0) { fclose(f); return; }\n`;
    s += `    unsigned char *b = (unsigned char *)malloc((size_t)len);\n`;
    s += `    if (!b) { fclose(f); return; }\n`;
    s += `    size_t got = fread(b, 1, (size_t)len, f);\n`;
    s += `    fclose(f);\n`;
    s += `    if (got != (size_t)len || memcmp(b, "KRTN", 4) != 0 || __retain_get16(b + 4) != PLC_RETAIN_VERSION) { free(b); return; }\n`;
    s += `    unsigned int cnt = __retain_get16(b + 6), restored = 0;\n`;
    s += `    const unsigned char *p = b + 8, *end = b + len;\n`;
    s += `    for (unsigned int r = 0; r < cnt; r++) {\n`;
    s += `        if ((size_t)(end - p) < 2) break;\n`;
    s += `        unsigned int nl = __retain_get16(p); p += 2;\n`;
    s += `        if ((size_t)(end - p) < (size_t)nl + 4) break;\n`;
    s += `        const char *nm = (const char *)p; p += nl;\n`;
    s += `        unsigned int sz = __retain_get32(p); p += 4;\n`;
    s += `        if ((size_t)(end - p) < (size_t)sz) break;\n`;
    s += `        for (int i = 0; i < PLC_RETAIN_COUNT; i++) {\n`;
    s += `            /* The stored name is NOT NUL-terminated — compare length-bounded. */\n`;
    s += `            if (__retain_tab[i].sz == sz && strlen(__retain_tab[i].name) == nl\n`;
    s += `                && memcmp(__retain_tab[i].name, nm, nl) == 0) {\n`;
    s += `                memcpy((unsigned char *)S + __retain_tab[i].off, p, sz);\n`;
    s += `                restored++;\n`;
    s += `                break;\n`;
    s += `            }\n`;
    s += `        }\n`;
    s += `        p += sz;\n`;
    s += `    }\n`;
    s += `    free(b);\n`;
    s += `    fprintf(stderr, "[plc] retain: restored %u/%d variable(s) from %s\\n", restored, PLC_RETAIN_COUNT, PLC_RETAIN_FILE);\n`;
    s += `    fflush(stderr);\n`;
    s += `}\n\n`;
    s += `/* Packs the retained fields and writes them atomically (tmp + rename) IF\n`;
    s += ` * they differ from the last image written — an idle machine performs zero\n`;
    s += ` * disk writes, which is what keeps this off an SD card's wear budget.\n`;
    s += ` * Returns 1 when a write happened. Safe to call from any thread; never\n`;
    s += ` * called from a scan. */\n`;
    s += `int plc_retain_save(void) {\n`;
    s += `    if (!__retain_img) {\n`;
    s += `        __retain_len = __retain_image_len();\n`;
    s += `        __retain_img = (unsigned char *)malloc(__retain_len);\n`;
    s += `        if (!__retain_img) return 0;\n`;
    s += `    }\n`;
    s += `    __retain_pack(__retain_img);\n`;
    s += `    if (__retain_prev && memcmp(__retain_prev, __retain_img, __retain_len) == 0) return 0;\n`;
    s += `    FILE *f = fopen(PLC_RETAIN_TMP, "wb");\n`;
    s += `    if (!f) return 0;\n`;
    s += `    size_t w = fwrite(__retain_img, 1, __retain_len, f);\n`;
    s += `    fflush(f);\n`;
    s += `#if defined(__linux__) || defined(__APPLE__)\n`;
    s += `    /* The rename is only atomic with respect to data that actually reached\n`;
    s += `     * the disk — without this, a power cut can leave an empty new file. */\n`;
    s += `    fsync(fileno(f));\n`;
    s += `#endif\n`;
    s += `    fclose(f);\n`;
    s += `    if (w != (size_t)__retain_len) { remove(PLC_RETAIN_TMP); return 0; }\n`;
    s += `#if defined(_WIN32)\n`;
    s += `    if (!MoveFileExA(PLC_RETAIN_TMP, PLC_RETAIN_FILE, PLC_RETAIN_REPLACE)) return 0;\n`;
    s += `#else\n`;
    s += `    if (rename(PLC_RETAIN_TMP, PLC_RETAIN_FILE) != 0) return 0;\n`;
    s += `#endif\n`;
    s += `    if (!__retain_prev) __retain_prev = (unsigned char *)malloc(__retain_len);\n`;
    s += `    if (__retain_prev) memcpy(__retain_prev, __retain_img, __retain_len);\n`;
    s += `    return 1;\n`;
    s += `}\n\n`;
    // The flusher thread belongs to the SINGLE-BINARY build only: under
    // PLC_HOTSWAP the logic module is dlclose'd on every swap, so a thread
    // running in it would be pulled out from under itself — the loader-host owns
    // the cadence there (hotswaphost/host.c retain_thread).
    s += `#if defined(__linux__) && !defined(PLC_HOTSWAP)\n`;
    s += `#define PLC_RETAIN_INTERVAL_MS ${RETAIN_INTERVAL_MS}\n`;
    // plc_stop is DEFINED further down (generateMainLoop emits it with the scan
    // loop), so this block — which is emitted before it — needs the extern.
    s += `extern volatile int plc_stop;\n`;
    s += `static void *plc_retain_thread(void *arg) {\n`;
    s += `    (void)arg;\n`;
    s += `    int ticks = 0;\n`;
    s += `    while (!plc_stop) {\n`;
    s += `        /* 100 ms granularity so a stop is honoured promptly regardless of\n`;
    s += `         * how long the flush interval is. */\n`;
    s += `        struct timespec ts = { .tv_sec = 0, .tv_nsec = 100 * 1000 * 1000 };\n`;
    s += `        nanosleep(&ts, NULL);\n`;
    s += `        if (++ticks < (PLC_RETAIN_INTERVAL_MS / 100)) continue;\n`;
    s += `        ticks = 0;\n`;
    s += `        plc_retain_save();\n`;
    s += `    }\n`;
    s += `    return NULL;\n`;
    s += `}\n`;
    s += `#endif\n`;
    return s;
};

const generateMainLoop = (projectStructure, config, boardId = null, shmEnabled = false, execTimeVars = [], initCode = '', cleanupCode = '', ecPdoReadCode = '', ecPdoWriteCode = '', ecThreadCode = '', ecThreadStartCode = '', ecThreadJoinCode = '', gpiMutexEnabled = false, shmEntries = [], plcStateLayoutHash = '0', addressedRingVars = [], retainEnabled = false) => {
    let mainSrc = `\n// --- DETERMINISTIC SCAN LOOP ---\n`;

    // --- 1. Discover task→program groupings (priority: taskConfig > res_config > fallback) ---
    // taskGroups: [ { taskName, intervalUs, programs: [ progName, ... ] } ]
    let taskGroups = [];
    let programTasks = []; // flat: [ { name, intervalUs } ] for variableTable.tasks

    if (projectStructure.taskConfig?.tasks?.length > 0) {
        const usedTaskNames = new Set();
        projectStructure.taskConfig.tasks.forEach(task => {
            const intervalUs = mapIECtoTimeUs(task.interval);
            const progs = [...(task.programs || [])]
                .sort((a, b) => a.priority - b.priority)
                .map(p => (p.program || '').trim().replace(/\s+/g, '_'))
                .filter(Boolean);
            if (progs.length > 0) {
                let tName = (task.name || task.id).replace(/\s+/g, '_');
                if (usedTaskNames.has(tName)) {
                    let n = 2;
                    while (usedTaskNames.has(`${tName}_${n}`)) n++;
                    tName = `${tName}_${n}`;
                }
                usedTaskNames.add(tName);
                taskGroups.push({ taskName: tName, intervalUs, programs: progs });
            }
            progs.forEach(pName => {
                if (!programTasks.find(pt => pt.name === pName))
                    programTasks.push({ name: pName, intervalUs });
            });
        });
        // STRICT (IEC 61131-3): a program runs ONLY if it is explicitly assigned
        // to a task. Programs not in any task are NOT executed (no default task).
        // Their POU code is still generated but never called by a task thread, so
        // their variables stay at their initial values. Warn so an "I made a
        // program but it doesn't run / no live data" situation is diagnosable.
        const unassigned = (projectStructure.programs || [])
            .map(p => (p.name || '').trim().replace(/\s+/g, '_'))
            .filter(pName => !programTasks.find(pt => pt.name === pName));
        if (unassigned.length > 0) {
            console.warn(`[transpiler] Programs not assigned to any task (will NOT run): ${unassigned.join(', ')}. Assign them in Task Manager.`);
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

    // Rename task threads sequentially (Task0, Task1, ...) regardless of configured names.
    // This ensures clean, predictable thread identifiers in the generated C code.
    taskGroups.forEach((tg, i) => { tg.taskName = `Task${i}`; });

    // Base tick = minimum interval across all programs (minimum 1us) — used for baremetal/Win
    const baseTickUs = programTasks.length > 0
        ? Math.max(1, Math.min(...programTasks.map(pt => pt.intervalUs)))
        : 1000;

    // --- LOSSLESS CAPTURE RING grouping (addressed variables) ---
    // Group each addressed variable under the TASK that writes it, so the ring
    // record for a task carries exactly that task's addressed vars. Program-local
    // vars map to their program's task; globals (which any task may write) map to
    // the FASTEST task so they are captured at the highest rate (never
    // undersampled). See server/RING_FORMAT.md. A variable whose program is
    // unassigned to any task is skipped (it never runs).
    const ringFastestTaskIdx = taskGroups.length > 0
        ? taskGroups.reduce((best, tg, i, arr) => (tg.intervalUs < arr[best].intervalUs ? i : best), 0)
        : -1;
    const ringOwnerTaskIdx = (rv) => {
        if (rv.isGlobal) return ringFastestTaskIdx;
        let best = -1, bestLen = -1;
        taskGroups.forEach((tg, ti) => {
            tg.programs.forEach((P) => {
                if (rv.cSymbol.startsWith(`prog_${P}_`) && P.length > bestLen) { best = ti; bestLen = P.length; }
            });
        });
        return best;
    };
    // ringTasks[ti] present only for tasks that actually carry addressed vars.
    const ringTasksByIdx = {};
    (addressedRingVars || []).forEach((rv) => {
        const ti = ringOwnerTaskIdx(rv);
        if (ti < 0) return;
        (ringTasksByIdx[ti] = ringTasksByIdx[ti] || []).push(rv);
    });
    // deterministic payload order = ascending shm offset
    Object.values(ringTasksByIdx).forEach((list) => list.sort((a, b) => a.offset - b.offset));
    const ringTasks = Object.keys(ringTasksByIdx)
        .map((k) => parseInt(k, 10))
        .sort((a, b) => a - b)
        .map((ti) => {
            const vars = ringTasksByIdx[ti];
            const payloadLen = vars.reduce((s, v) => s + v.size, 0);
            return { taskId: ti, taskName: taskGroups[ti].taskName, periodUs: taskGroups[ti].intervalUs, vars, payloadLen };
        });
    const ringEnabled = ringTasks.length > 0;
    const ringMaxPayload = ringEnabled ? Math.max(...ringTasks.map((t) => t.payloadLen)) : 0;
    // record_stride = align8(16 header + max task payload)
    const ringRecordStride = ringEnabled ? Math.ceil((16 + ringMaxPayload) / 8) * 8 : 0;
    // ringConfig returned for variable_table.json (client decodes payloads with it)
    const ringConfig = ringEnabled ? {
        record_stride: ringRecordStride,
        tasks: ringTasks.map((t) => ({
            task_id: t.taskId,
            period_us: t.periodUs,
            vars: t.vars.map((v) => ({ name: v.name, type: v.serverType, size: v.size })),
        })),
    } : null;

    // --- 2. Global shared state ---
    // us_tick is defined for ALL platforms.
    // Linux/Apple: updated from clock_gettime inside each task thread → always accurate.
    // Windows:     updated from QueryPerformanceCounter in the main loop.
    // Bare-metal:  must be incremented by a hardware timer ISR every ~${formatUsDisplay(baseTickUs)}.
    // In a hot-swap build the loader-host owns the scan loop, so it defines
    // plc_stop and us_tick and exports them; the logic .so references us_tick
    // (extern, declared in plc.h) and never touches plc_stop.
    mainSrc += `#ifndef PLC_HOTSWAP\n`;
    mainSrc += `volatile int plc_stop = 0;\n`;
    mainSrc += `volatile uint64_t us_tick = 0;\n`;
    mainSrc += `#endif\n\n`;
    if (ringEnabled) mainSrc += `static void plc_ring_init(void);\n`;
    mainSrc += `void PLC_Init(void) {\n`;
    if (boardId) {
        mainSrc += `    HAL_Init();\n`;
    }
    mainSrc += `    KRON_UART_RuntimeInit();\n`;
    if (initCode) {
        mainSrc += initCode;
    }
    if (ringEnabled) mainSrc += `    plc_ring_init();\n`;
    // ⚠️ LAST in PLC_Init, on purpose: plc_state_init() (injected at the top of
    // this function) has just written every initial value, so the retained ones
    // must be restored over it — the reverse order would make retain a no-op.
    if (retainEnabled) mainSrc += `    plc_retain_load();\n`;
    mainSrc += `}\n\n`;
    mainSrc += `void PLC_Cleanup(void) {\n`;
    // Final flush before the HAL/EtherCAT teardown below can disturb anything.
    if (retainEnabled) mainSrc += `    plc_retain_save();\n`;
    if (cleanupCode) {
        mainSrc += cleanupCode;
    }
    mainSrc += `    KRON_UART_RuntimeCleanup();\n`;
    if (boardId) {
        mainSrc += `    HAL_Cleanup();\n`;
    }
    mainSrc += `}\n\n`;

    // ⚠️ The per-task SHM wrappers and plc_task_body_* below are PLATFORM-NEUTRAL
    // and must stay OUTSIDE the #if chain. They used to sit inside the __linux__
    // arm, so on Windows neither existed — yet the Windows scan loop calls
    // plc_task_body_0() and the hot-swap ABI exports it, i.e. a Windows build
    // could not compile at all. They only use memcpy and clock_gettime, both
    // available on Windows through winpthreads.
    // (Only the pthread task functions and the EC background threads are
    // genuinely Linux-specific; the #if opens after them.)

    // Fieldbus-Agnostic Rule: kron_ec_pdo_read/write belong ONLY in the fastest task.
    // All slower (logic) tasks are pure computation — no bus access.
    // This eliminates bus collisions and decouples scan rate from fieldbus cycle.
    const hasEc = !!(ecPdoReadCode || ecPdoWriteCode);
    const fastestIntervalUs = taskGroups.length > 0
        ? Math.min(...taskGroups.map(tg => tg.intervalUs))
        : Infinity;

    // Per-task SHM pull/sync functions — each task calls its own named version.
    // All currently include the full variable set; partition per-task in future if needed.
    if (shmEnabled && shmEntries.length > 0) {
        taskGroups.forEach(tg => {
            // See plc_shm_pull above for the flag semantics: 1 = FORCE (hold),
            // 2 = PULSE (apply once, auto-clear, logic resumes same scan).
            mainSrc += `static void plc_shm_pull_${tg.taskName}(void) {\n`;
            mainSrc += `    if (!__plc_shm) return;\n`;
            shmEntries.forEach(({ c_symbol, offset, size, flagOffset }) => {
                mainSrc += `    if (__plc_shm[${flagOffset}]) { memcpy((void*)&(S->${c_symbol}), __plc_shm + ${offset}, ${size}); if (__plc_shm[${flagOffset}] == 2) __plc_shm[${flagOffset}] = 0; }\n`;
            });
            mainSrc += `}\n`;
            mainSrc += `static void plc_shm_sync_${tg.taskName}(void) {\n`;
            mainSrc += `    if (!__plc_shm) return;\n`;
            shmEntries.forEach(({ c_symbol, offset, size, flagOffset }) => {
                mainSrc += `    if (__plc_shm[${flagOffset}] == 0) { memcpy(__plc_shm + ${offset}, (const void*)&(S->${c_symbol}), ${size}); }\n`;
            });
            mainSrc += `}\n`;
        });
        mainSrc += `\n`;
    }

    // --- LOSSLESS CAPTURE RING codegen (addressed variables) ---
    // Producer side of server/RING_FORMAT.md. A second /dev/shm segment
    // (<shm>_ring) holds fixed-stride records; each task appends its addressed
    // vars on kept scans (scan_g % stride_N). KronServer drains it losslessly and
    // writes stride_N back. Gated to a plain Linux build: KronServer (the only
    // consumer) runs on Linux, hot-swap builds don't own this memory, and the
    // Windows/macOS SIM keeps compiling via the no-op stubs below.
    if (ringEnabled) {
        const RS = ringRecordStride;
        mainSrc += `// ===== Lossless capture ring (addressed variables) =====\n`;
        mainSrc += `#if defined(__linux__) && !defined(PLC_HOTSWAP)\n`;
        mainSrc += `#include <sys/mman.h>\n#include <sys/stat.h>\n#include <fcntl.h>\n#include <unistd.h>\n#include <stdlib.h>\n#include <string.h>\n#include <stdint.h>\n`;
        mainSrc += `#define PLC_RING_NAME "/plc_runtime_ring"\n`;
        mainSrc += `#define PLC_RING_HEADER 256\n`;
        mainSrc += `#define PLC_RING_STRIDE ${RS}\n`;
        mainSrc += `static uint8_t *__plc_ring = NULL;\n`;
        mainSrc += `static uint64_t __plc_ring_nslots = 0;\n`;
        ringTasks.forEach((t) => { mainSrc += `static uint64_t __ring_scan_${t.taskName} = 0;\n`; });
        // init
        mainSrc += `static void plc_ring_init(void) {\n`;
        mainSrc += `    int fd = shm_open(PLC_RING_NAME, O_CREAT | O_RDWR, 0660);\n`;
        mainSrc += `    if (fd < 0) return;\n`;
        mainSrc += `    struct stat st;\n`;
        mainSrc += `    if (fstat(fd, &st) != 0) { close(fd); return; }\n`;
        mainSrc += `    long total = (long)st.st_size;\n`;
        mainSrc += `    long minimal = PLC_RING_HEADER + PLC_RING_STRIDE;\n`;
        mainSrc += `    if (total < minimal) {\n`;
        mainSrc += `        const char *env = getenv("KRON_RING_BYTES");\n`;
        mainSrc += `        long want = env ? atol(env) : (1L<<20);\n`;
        mainSrc += `        if (want < minimal) want = 1L<<20;\n`;
        mainSrc += `        if (ftruncate(fd, want) != 0) { close(fd); return; }\n`;
        mainSrc += `        total = want;\n`;
        mainSrc += `    }\n`;
        mainSrc += `    uint8_t *r = (uint8_t*)mmap(NULL, (size_t)total, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);\n`;
        mainSrc += `    close(fd);\n`;
        mainSrc += `    if (r == MAP_FAILED) return;\n`;
        mainSrc += `    uint64_t nslots = (uint64_t)((total - PLC_RING_HEADER) / PLC_RING_STRIDE);\n`;
        mainSrc += `    if (nslots == 0) { munmap(r, (size_t)total); return; }\n`;
        // preserve stride_N + epoch across restarts
        mainSrc += `    uint64_t oldEpoch; memcpy(&oldEpoch, r + 48, 8);\n`;
        mainSrc += `    uint32_t u32; uint16_t u16; uint64_t u64;\n`;
        mainSrc += `    u32 = 0x4B524E47u; memcpy(r+0,&u32,4);\n`;   // magic
        mainSrc += `    u32 = 1u;          memcpy(r+4,&u32,4);\n`;   // version
        mainSrc += `    u32 = 256u;        memcpy(r+8,&u32,4);\n`;   // header_bytes
        mainSrc += `    u32 = (uint32_t)PLC_RING_STRIDE; memcpy(r+12,&u32,4);\n`;
        mainSrc += `    u32 = (uint32_t)nslots; memcpy(r+16,&u32,4);\n`;
        mainSrc += `    u32 = (uint32_t)total; memcpy(r+20,&u32,4);\n`;
        mainSrc += `    u32 = ${ringTasks.length}u; memcpy(r+24,&u32,4);\n`; // ntasks
        mainSrc += `    u32 = 1u; memcpy(r+28,&u32,4);\n`;            // flags: enabled
        // write_seq CONTINUES monotonically across (re)starts and starts at 1,
        // never 0. This makes every valid record sequence >= 1, so an unwritten /
        // punched slot (which reads back as 0, a tmpfs hole) can NEVER be mistaken
        // for a real record — which is why the slots need no 0xFFFF initialization
        // (that init used to touch every page → the whole segment resident at boot).
        mainSrc += `    { uint64_t oldW = 0; memcpy(&oldW, r+32, 8); if (oldW < 1) oldW = 1; memcpy(r+32, &oldW, 8); }\n`;
        mainSrc += `    u32 = 0u; memcpy(r+40,&u32,4);\n`;           // stride_N = 0 → PAUSED until a consumer connects
        // epoch is published LAST (release store, below) so a consumer that sees
        // the new epoch is guaranteed to see the fully-written header + task table
        // task table
        ringTasks.forEach((t, j) => {
            mainSrc += `    u32 = ${t.periodUs}u; memcpy(r+${64 + j * 8},&u32,4);\n`;
            mainSrc += `    u16 = ${t.payloadLen}u; memcpy(r+${64 + j * 8 + 4},&u16,2);\n`;
            mainSrc += `    u16 = ${t.taskId}u; memcpy(r+${64 + j * 8 + 6},&u16,2);\n`;
        });
        // NOTE: slots are deliberately NOT initialized — see the write_seq comment
        // above. Leaving them as tmpfs holes (RSS 0) is what lets the ring's
        // resident memory track the live backlog; the consumer punches consumed
        // slots back into holes (fallocate) so the segment never stays fully
        // resident. A hole reads 0, which is < every valid seq (≥1), so it is
        // never mistaken for data.
        // Publish epoch LAST with a release store: on a restart that changed the
        // header layout, a consumer acquire-loading the new epoch is then
        // guaranteed to see the fresh record_stride/nslots/task-table too (ARM is
        // weakly ordered, so this ordering is load-bearing, not cosmetic).
        mainSrc += `    __atomic_store_n((uint64_t*)(r + 48), oldEpoch + 1ull, __ATOMIC_RELEASE);\n`;
        mainSrc += `    __plc_ring = r; __plc_ring_nslots = nslots;\n`;
        mainSrc += `}\n`;
        // append per task
        ringTasks.forEach((t) => {
            mainSrc += `static void plc_ring_append_${t.taskName}(void) {\n`;
            mainSrc += `    if (!__plc_ring) return;\n`;
            mainSrc += `    uint32_t N = __atomic_load_n((uint32_t*)(__plc_ring + 40), __ATOMIC_RELAXED);\n`;
            mainSrc += `    if (N == 0) return; /* paused: no consumer connected → don't burn scan cycles / RAM */\n`;
            mainSrc += `    if ((__ring_scan_${t.taskName}++ % N) != 0) return;\n`;
            mainSrc += `    uint64_t s = __atomic_fetch_add((uint64_t*)(__plc_ring + 32), 1ull, __ATOMIC_RELAXED);\n`;
            mainSrc += `    uint8_t *slot = __plc_ring + 256 + (uint64_t)(s % __plc_ring_nslots) * PLC_RING_STRIDE;\n`;
            mainSrc += `    uint16_t tid = ${t.taskId}u; memcpy(slot + 8, &tid, 2);\n`;
            mainSrc += `    uint16_t pl = ${t.payloadLen}u; memcpy(slot + 10, &pl, 2);\n`;
            mainSrc += `    uint8_t *p = slot + 16;\n`;
            let po = 0;
            t.vars.forEach((v) => {
                mainSrc += `    memcpy(p + ${po}, (const void*)&(S->${v.cSymbol}), ${v.size});\n`;
                po += v.size;
            });
            mainSrc += `    __atomic_store_n((uint64_t*)(slot + 0), s, __ATOMIC_RELEASE);\n`;
            mainSrc += `}\n`;
        });
        mainSrc += `#else\n`;
        // non-Linux sim / hot-swap: ring not owned here — no-op so the SAME task
        // body compiles and links everywhere.
        mainSrc += `static inline void plc_ring_init(void) {}\n`;
        ringTasks.forEach((t) => { mainSrc += `static inline void plc_ring_append_${t.taskName}(void) {}\n`; });
        mainSrc += `#endif\n\n`;
    }

    // Per-task scan BODY (SHM pull → programs → SHM sync). Extracted into its own
    // function so the SAME body is run by the in-binary thread loop (normal build)
    // AND by the hot-swap loader-host, which calls plc_task_body_<i> through dlsym
    // after dlopen'ing this translation unit as logic.so. Hot-swappable.
    taskGroups.forEach((tg, ti) => {
        mainSrc += `void plc_task_body_${ti}(void) {\n`;
        if (shmEnabled) mainSrc += `    plc_shm_pull_${tg.taskName}();\n`;
        if (gpiMutexEnabled) mainSrc += `    __gpi_snap = atomic_load_explicit(&__gpi, memory_order_acquire);\n`;
        tg.programs.forEach(pName => {
            const etv = execTimeVars.find(e => e.progName === pName);
            if (etv) {
                mainSrc += `    { struct timespec __t0, __t1;\n`;
                mainSrc += `      clock_gettime(CLOCK_MONOTONIC, &__t0);\n`;
                mainSrc += `      ${pName}();\n`;
                mainSrc += `      clock_gettime(CLOCK_MONOTONIC, &__t1);\n`;
                mainSrc += `      S->${etv.cSym} = (uint32_t)(((int64_t)(__t1.tv_sec - __t0.tv_sec) * 1000000LL) + ((__t1.tv_nsec - __t0.tv_nsec) / 1000)); }\n`;
            } else {
                mainSrc += `    ${pName}();\n`;
            }
        });
        if (shmEnabled) mainSrc += `    plc_shm_sync_${tg.taskName}();\n`;
        // Capture ring: append this task's addressed vars AFTER shm sync (values
        // final for the scan). No-op unless this task has addressed vars.
        if (ringEnabled && ringTasks.find((t) => t.taskId === ti)) {
            mainSrc += `    plc_ring_append_${taskGroups[ti].taskName}();\n`;
        }
        mainSrc += `}\n\n`;
    });

    // --- 3. Linux: one pthread function per task group ---
    mainSrc += `#if defined(__linux__)\n\n`;
    // EC background thread functions (SDO + watchdog) — Linux-only.
    if (ecThreadCode) mainSrc += ecThreadCode;

    // In-binary thread loop — normal (non-hot-swap) build only. The loader-host
    // provides its own loop in a hot-swap build.
    mainSrc += `#ifndef PLC_HOTSWAP\n`;
    taskGroups.forEach((tg, ti) => {
        const isIoTask = hasEc && (tg.intervalUs === fastestIntervalUs);
        mainSrc += `static void* plc_task_${tg.taskName}(void *arg) {\n`;
        mainSrc += `    (void)arg;\n`;
        mainSrc += `    { struct sched_param __sp = { .sched_priority = sched_get_priority_max(SCHED_FIFO) };\n`;
        mainSrc += `      pthread_setschedparam(pthread_self(), SCHED_FIFO, &__sp); }\n`;
        mainSrc += `    struct timespec __next;\n`;
        mainSrc += `    clock_gettime(CLOCK_MONOTONIC, &__next);\n`;
        mainSrc += `    while (!plc_stop) {\n`;
        mainSrc += `        __next.tv_nsec += ${tg.intervalUs * 1000}UL;\n`;
        mainSrc += `        while (__next.tv_nsec >= 1000000000L) { __next.tv_sec++; __next.tv_nsec -= 1000000000L; }\n`;
        if (!gpiMutexEnabled && isIoTask && ecPdoReadCode) mainSrc += ecPdoReadCode;
        // us_tick → wall-clock so IEC timers stay accurate even if a scan overruns.
        mainSrc += `        { struct timespec __ts; clock_gettime(CLOCK_MONOTONIC, &__ts);\n`;
        mainSrc += `          us_tick = (uint64_t)__ts.tv_sec * 1000000ULL + (uint64_t)__ts.tv_nsec / 1000ULL; }\n`;
        mainSrc += `        plc_task_body_${ti}();\n`;
        if (!gpiMutexEnabled && isIoTask && ecPdoWriteCode) mainSrc += ecPdoWriteCode;
        mainSrc += `        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &__next, NULL);\n`;
        mainSrc += `    }\n`;
        mainSrc += `    return NULL;\n`;
        mainSrc += `}\n\n`;
    });
    mainSrc += `#endif /* !PLC_HOTSWAP */\n\n`;

    // Linux main(): spawn all task threads (normal build only).
    mainSrc += `#ifndef PLC_HOTSWAP\n`;
    if (retainEnabled) {
        // ⚠️ Installed ONLY for a project that has retained variables. Without a
        // handler SIGTERM terminates the process outright, so KronServer's Stop
        // (SIGTERM → 5 s → SIGKILL, server/process.go) would skip PLC_Cleanup and
        // lose everything written since the last periodic flush. Gating it on
        // retain keeps the stop semantics of every other project unchanged.
        mainSrc += `#include <signal.h>\n`;
        mainSrc += `static void plc_on_term(int sig) { (void)sig; plc_stop = 1; }\n`;
    }
    mainSrc += `int main() {\n`;
    mainSrc += `    { struct sched_param __sp = { .sched_priority = sched_get_priority_max(SCHED_FIFO) };\n`;
    mainSrc += `      sched_setscheduler(0, SCHED_FIFO, &__sp); }\n`;
    if (retainEnabled) {
        mainSrc += `    signal(SIGTERM, plc_on_term);\n`;
        mainSrc += `    signal(SIGINT,  plc_on_term);\n`;
    }
    mainSrc += `    PLC_Init();\n`;
    if (shmEnabled) {
        mainSrc += `    plc_shm_init();\n`;
    }
    if (ecThreadStartCode) mainSrc += ecThreadStartCode;
    if (taskGroups.length > 0) {
        // The flusher is tied to the task threads' lifetime: with no tasks
        // nothing ever sets plc_stop, so an unconditional thread here would make
        // main() hang forever on its join.
        if (retainEnabled) mainSrc += `    pthread_t __retain_thread;\n    pthread_create(&__retain_thread, NULL, plc_retain_thread, NULL);\n`;
        mainSrc += `    pthread_t __plc_threads[${taskGroups.length}];\n`;
        taskGroups.forEach((tg, i) => {
            mainSrc += `    pthread_create(&__plc_threads[${i}], NULL, plc_task_${tg.taskName}, NULL);\n`;
        });
        mainSrc += `    for (int i = 0; i < ${taskGroups.length}; i++) pthread_join(__plc_threads[i], NULL);\n`;
        if (retainEnabled) mainSrc += `    pthread_join(__retain_thread, NULL);\n`;
    }
    if (ecThreadJoinCode) mainSrc += ecThreadJoinCode;
    mainSrc += `    PLC_Cleanup();\n`;
    mainSrc += `    return 0;\n}\n`;
    mainSrc += `#endif /* !PLC_HOTSWAP */\n\n`;

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
    // ⚠️ In a hot-swap build the loader-host owns the scan loop, so this
    // in-binary main() must NOT be emitted — mirrors the Linux arm's guard.
    mainSrc += `#ifndef PLC_HOTSWAP\n`;
    mainSrc += `int main() {\n`;
    mainSrc += `    SetPriorityClass(GetCurrentProcess(), REALTIME_PRIORITY_CLASS);\n`;
    mainSrc += `    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);\n`;
    mainSrc += `    PLC_Init();\n`;
    if (shmEnabled) mainSrc += `    plc_shm_init();\n`;
    mainSrc += `    uint64_t __prev_us = 0;\n`;
    if (retainEnabled) mainSrc += `    uint64_t __retain_last_us = 0;\n`;
    mainSrc += `    while (!plc_stop) {\n`;
    mainSrc += `        __update_us_tick();\n`;
    if (ecPdoReadCode) mainSrc += ecPdoReadCode;
    // ⚠️ Dispatch through plc_task_body_<i>, exactly like the Linux threads —
    // NOT the bare program functions. The body wrapper is what runs the SHM
    // pull/sync pair, so calling the programs directly left the mirror (and
    // therefore every live value and force-write) permanently empty.
    taskGroups.forEach((tg, ti) => {
        mainSrc += `        if (us_tick / ${tg.intervalUs} != __prev_us / ${tg.intervalUs}) { plc_task_body_${ti}(); }\n`;
    });
    mainSrc += `        __prev_us = us_tick;\n`;
    if (retainEnabled) {
        // Windows has no flusher thread here: this main() IS a cooperative timer
        // wheel, so the periodic save rides it directly (plc.c includes
        // <pthread.h> only under __linux__). The save is a no-op unless a
        // retained value actually changed.
        mainSrc += `        if (us_tick - __retain_last_us >= ${RETAIN_INTERVAL_MS * 1000}ULL) { __retain_last_us = us_tick; plc_retain_save(); }\n`;
    }
    if (ecPdoWriteCode) mainSrc += ecPdoWriteCode;
    mainSrc += `        Sleep(${Math.max(1, Math.floor(baseTickUs / 1000))});\n`;
    mainSrc += `    }\n`;
    mainSrc += `    PLC_Cleanup();\n`;
    mainSrc += `    return 0;\n}\n`;
    mainSrc += `#endif /* !PLC_HOTSWAP */\n\n`;

    // --- 5. Bare-metal: cooperative timer wheel called from HAL ---
    mainSrc += `#else\n\n`;
    mainSrc += `// Bare-metal / RTOS-less execution engine.\n`;
    mainSrc += `// us_tick must be incremented by a hardware timer ISR every ${formatUsDisplay(baseTickUs)}.\n`;
    mainSrc += `void PLC_Run(void) {\n`;
    if (ecPdoReadCode) mainSrc += ecPdoReadCode.replace(/^ {8}/gm, '    '); // 4-space indent for PLC_Run
    programTasks.forEach(pt => {
        mainSrc += `    if (us_tick % ${pt.intervalUs}ULL == 0) { ${pt.name}(); }\n`;
    });
    if (ecPdoWriteCode) mainSrc += ecPdoWriteCode.replace(/^ {8}/gm, '    ');
    mainSrc += `}\n\n`;
    mainSrc += `#endif\n`;

    // ⚠️ The hot-swap ABI is emitted OUTSIDE the platform #if/#elif chain.
    // It used to sit inside the __linux__ arm, so a Windows -DPLC_HOTSWAP
    // build exported none of these and the loader-host could not bind it —
    // the single reason the whole hot-swap runtime was Linux-only at the
    // codegen level. Nothing in here is platform-specific.
    // Hot-swap ABI: when compiled with -DPLC_HOTSWAP this TU is a loadable
    // logic module. The loader-host dlopen/LoadLibrary's it and drives the scan via
    // these exports; PlcState lives in the host (survives a swap), us_tick and
    // plc_stop are host-owned. plc_state_init runs once on cold load only.
    mainSrc += `#ifdef PLC_HOTSWAP\n`;
    mainSrc += `#include <stddef.h>\n`;
    mainSrc += `unsigned long plc_state_size(void) { return (unsigned long)sizeof(PlcState); }\n`;
    // PlcState shape fingerprint (see plcStateLayoutHash above) — the
    // loader-host refuses a swap whose .so reports a different hash than the
    // one it cold-started with, regardless of what the editor's own
    // pre-flight check concluded.
    mainSrc += `unsigned long long plc_state_layout_hash(void) { return 0x${plcStateLayoutHash}ULL; }\n`;
    mainSrc += `int plc_task_count(void) { return ${taskGroups.length}; }\n`;
    mainSrc += `unsigned long plc_task_interval_us(int i) {\n`;
    mainSrc += `    switch (i) {\n`;
    taskGroups.forEach((tg, ti) => {
        mainSrc += `        case ${ti}: return ${tg.intervalUs}UL;\n`;
    });
    mainSrc += `        default: return 0UL;\n    }\n}\n`;
    mainSrc += `void plc_init_hs(void) { PLC_Init(); }\n`;
    mainSrc += `void plc_cleanup_hs(void) { PLC_Cleanup(); }\n`;
    if (shmEnabled) {
        // Host opens this /dev/shm mirror and assigns __plc_shm before the scan.
        mainSrc += `const char* plc_shm_name(void) { return PLC_SHM_NAME; }\n`;
        mainSrc += `unsigned long plc_shm_size(void) { return (unsigned long)PLC_SHM_SIZE; }\n`;
    }
    mainSrc += `#endif /* PLC_HOTSWAP */\n\n`;


    return { src: mainSrc, programTasks, baseTickUs, ringConfig };
};

// FUNCTION POU helpers — Input-class variables become C parameters in
// declaration order; everything else is a body-local.
const functionInputVars = (pou) =>
    (pou?.content?.variables || []).filter(v => String(v.class || '').toLowerCase() === 'input');

const buildFunctionParams = (pou) => {
    const ins = functionInputVars(pou);
    if (ins.length === 0) return 'void';
    return ins
        .map(v => `${mapType((v.type || '').trim())} ${(v.name || '').trim().replace(/\s+/g, '_')}`)
        .join(', ');
};

const transpilePOUSource = (pou, category, stdFunctions = {}, parentName = '', globalVarNames = [], inputShadowMap = null, globalVarsList = [], projectStructure = null) => {
    // User-defined FB type names (normalized) — so ST can recognize a user-FB
    // instance call and name the instance consistently with its declaration.
    const userFBTypes = new Set((projectStructure?.functionBlocks || []).map(fb => (fb.name || '').trim().replace(/\s+/g, '_')));
    const isUserFB = (t) => userFBTypes.has((t || '').trim().replace(/\s+/g, '_'));
    let src = ``;
    let safeName = (pou.name || '').trim().replace(/\s+/g, '_');
    let sig = `static inline void ${safeName}()`;
    const fnRetType = category === 'function' ? mapType(pou.returnType || 'VOID') : 'void';

    if (category === 'function') {
        sig = `static inline ${fnRetType} ${safeName}(${buildFunctionParams(pou)})`;
    } else if (category === 'function_block') {
        sig = `static inline void ${safeName}_Execute(${safeName} *instance)`;
    }

    src += `${sig} {\n`;

    // FUNCTION POU: declare non-input variables as body locals (with initials)
    // and, for non-void functions, the implicit result variable. Assignments to
    // the function's own name (`FuncName := expr;`) target __ret via varMap, so
    // mid-body result assignments keep executing the rest of the body (IEC
    // semantics) and the single `return __ret;` epilogue returns the final value.
    let fnEpilogue = '';
    const fnInputNames = new Set();
    if (category === 'function') {
        functionInputVars(pou).forEach(v => {
            const vName = (v.name || '').trim().replace(/\s+/g, '_');
            if (vName) fnInputNames.add(vName);
        });
        (pou.content?.variables || []).forEach(v => {
            const vName = (v.name || '').trim().replace(/\s+/g, '_');
            if (!vName || fnInputNames.has(vName)) return;
            if (isInlineMathType(v.type)) return;
            const init = formatVarInitial(v.initialValue, v.type) || ' = {0}';
            src += `    ${mapType((v.type || '').trim())} ${vName}${init};\n`;
        });
        if (fnRetType !== 'void') {
            src += `    ${fnRetType} __ret = {0};\n`;
            fnEpilogue = `    return __ret;\n`;
        }
    }

    // User-defined FUNCTION input order — lets ST rewrite named-argument calls
    // (`MyFunc(A := x)`) into positional C calls.
    const userFunctionInputs = {};
    (projectStructure?.functions || []).forEach(fn => {
        const n = (fn.name || '').trim().replace(/\s+/g, '_');
        if (!n) return;
        userFunctionInputs[n] = functionInputVars(fn)
            .map(v => (v.name || '').trim().replace(/\s+/g, '_'))
            .filter(Boolean);
    });

    // User-defined FB input pin order — lets ST map POSITIONAL FB instance
    // calls (`inst(a, b)`) onto the FB's declared input pins.
    const userFBInputs = {};
    (projectStructure?.functionBlocks || []).forEach(fb => {
        const n = (fb.name || '').trim().replace(/\s+/g, '_');
        if (!n) return;
        userFBInputs[n] = (fb.content?.variables || [])
            .filter(v => ['input', 'inout'].includes(String(v.class || '').toLowerCase()))
            .map(v => (v.name || '').trim().replace(/\s+/g, '_'))
            .filter(Boolean);
    });

    // Local variable names + which of them are FB instances (for LD member
    // access like `blink.Q` → inst_ field, and local-vs-global precedence).
    const localVarNames = new Set();
    const fbInstanceNames = new Set();
    (pou.content?.variables || []).forEach(v => {
        const vName = (v.name || '').trim().replace(/\s+/g, '_');
        if (!vName) return;
        localVarNames.add(vName);
        const isFB = stdFunctions[v.type] !== undefined || HAL_BLOCK_TYPES.has(v.type) || isUserFB(v.type) || (v.type in FB_TRIGGER_PIN && !isInlineMathType(v.type));
        if (isFB) fbInstanceNames.add(vName);
    });

    // Build C-symbol → IEC-type map for LD type inference (REAL detection)
    const buildCSymTypeMap = () => {
        const map = {};
        // Global vars: C symbol = variable name unchanged
        globalVarsList.forEach(v => {
            const vName = (v.name || '').trim().replace(/\s+/g, '_');
            if (vName) map[vName] = v.type;
        });
        // Local POU variables
        (pou.content.variables || []).forEach(v => {
            const vName = (v.name || '').trim().replace(/\s+/g, '_');
            if (!vName) return;
            let cSym;
            if (globalVarNames.includes(vName)) {
                cSym = vName;
            } else if (category === 'program') {
                cSym = `prog_${safeName}_${vName}`;
            } else if (category === 'function_block') {
                cSym = `instance->${vName}`;
            } else {
                cSym = vName;
            }
            map[cSym] = v.type;
        });
        return map;
    };

    // Build IEC identifier → C symbol + IEC identifier → type maps for ST.
    // Shared by the ST and SCL branches (they were duplicated before).
    const buildStMaps = () => {
        const varMap = {};
        const varTypeMap = {};
        // Globals first — so their TYPES are known (a global FB instance must get
        // FB-call treatment) — locals overwrite (shadowing).
        (globalVarsList || []).forEach(gv => {
            const gName = (gv.name || '').trim().replace(/\s+/g, '_');
            if (gName) varTypeMap[gName] = gv.type;
        });
        (pou.content.variables || []).forEach(v => {
            const vName = (v.name || '').trim().replace(/\s+/g, '_');
            if (!vName) return;
            varTypeMap[vName] = v.type;
            if (globalVarNames.includes(vName)) {
                varMap[vName] = `S->${vName}`; // global: PlcState field (hot-swap)
            } else if (category === 'program') {
                varMap[vName] = fbInstanceNames.has(vName)
                    ? `S->prog_${parentName}_inst_${vName}`
                    : `S->prog_${parentName}_${vName}`;
            } else if (category === 'function_block') {
                varMap[vName] = `instance->${vName}`;
            } else {
                varMap[vName] = vName;
            }
        });
        // Globals referenced but not declared locally are PlcState fields too.
        globalVarNames.forEach(g => { const gn = (g || '').trim().replace(/\s+/g, '_'); if (gn && !(gn in varMap)) varMap[gn] = `S->${gn}`; });
        // EtherCAT PDO variables must stay BARE so the GPI access macro applies
        // (they have no PlcState field — mapping them to S->name breaks compile).
        EC_PDO_VAR_NAMES.forEach(n => { if (varMap[n] === `S->${n}`) delete varMap[n]; });
        // Function result variable: FuncName := expr → __ret = expr.
        if (category === 'function' && fnRetType !== 'void') {
            varMap[safeName] = '__ret';
        }
        return { varMap, varTypeMap };
    };

    const stOpts = {
        fnReturnVar: (category === 'function' && fnRetType !== 'void') ? '__ret' : null,
        userFunctionInputs,
        userFBInputs,
    };

    if (pou.type === 'ST') {
        const { varMap, varTypeMap } = buildStMaps();
        src += transpileSTLogics(pou.content.code, stdFunctions, parentName, category, varMap, varTypeMap, userFBTypes, stOpts);
    } else if (pou.type === 'LD') {
        src += transpileLDLogics(pou.content.rungs, stdFunctions, safeName, category, globalVarNames, inputShadowMap, 0, buildCSymTypeMap(), localVarNames, fbInstanceNames);
    } else if (pou.type === 'SCL') {
        // SCL: mixed LD/ST per rung. Each rung carries a `lang` field ('LD' or 'ST').
        let sclLdRungIdx = 0;
        (pou.content.rungs || []).forEach(rung => {
            if (rung.lang === 'ST') {
                const { varMap, varTypeMap } = buildStMaps();
                src += `    // SCL rung [ST]\n`;
                src += transpileSTLogics(rung.code || '', stdFunctions, parentName, category, varMap, varTypeMap, userFBTypes, stOpts);
            } else {
                // Default: treat as LD rung
                src += `    // SCL rung [LD]\n`;
                src += transpileLDLogics([rung], stdFunctions, safeName, category, globalVarNames, inputShadowMap, sclLdRungIdx, buildCSymTypeMap(), localVarNames, fbInstanceNames);
                sclLdRungIdx++;
            }
        });
    }

    src += fnEpilogue;
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
    'USB_Send': 'Execute', 'USB_Receive': 'Enable',
    // Comparison / Arithmetic / Math / Bitwise / Trig / Selection / Conversion — EN is the power-flow input
    'GT': 'EN', 'GE': 'EN', 'EQ': 'EN', 'NE': 'EN', 'LE': 'EN', 'LT': 'EN',
    'ADD': 'EN', 'SUB': 'EN', 'MUL': 'EN', 'DIV': 'EN', 'MOD': 'EN', 'MOVE': 'EN',
    'ABS': 'EN', 'SQRT': 'EN', 'EXPT': 'EN', 'MAX': 'EN', 'MIN': 'EN', 'LIMIT': 'EN',
    'BAND': 'EN', 'BOR': 'EN', 'BXOR': 'EN', 'BNOT': 'EN',
    'SHL': 'EN', 'SHR': 'EN', 'ROL': 'EN', 'ROR': 'EN',
    'SIN': 'EN', 'COS': 'EN', 'TAN': 'EN', 'ASIN': 'EN', 'ACOS': 'EN', 'ATAN': 'EN',
    'SEL': 'EN', 'MUX': 'EN',
    // Conversion (72 entries generated below), Scaling
    'NORM_X': 'EN', 'SCALE_X': 'EN',
    // EtherCAT diagnostics
    'EC_GetMasterState': 'Enable',
    'EC_GetSlaveState': 'Enable',
    'EC_ResetBus': 'Execute',
    'EC_ReadSDO': 'Execute',
    'EC_WriteSDO': 'Execute',
    // Motion control (PLCopen TC2 Part 1 v2.0)
    'MC_Power': 'Enable',
    'MC_Home': 'Execute', 'MC_Stop': 'Execute', 'MC_Halt': 'Execute',
    'MC_MoveAbsolute': 'Execute', 'MC_MoveRelative': 'Execute',
    'MC_MoveAdditive': 'Execute', 'MC_MoveVelocity': 'Execute',
    'MC_MoveSuperimposed': 'Execute', 'MC_HaltSuperimposed': 'Execute',
    'MC_MoveContinuousAbsolute': 'Execute', 'MC_MoveContinuousRelative': 'Execute',
    'MC_SetPosition': 'Execute', 'MC_SetOverride': 'Enable',
    'MC_Reset': 'Execute',
    'MC_ReadActualPosition': 'Enable', 'MC_ReadActualVelocity': 'Enable',
    'MC_ReadActualTorque': 'Enable', 'MC_ReadStatus': 'Enable',
    'MC_ReadMotionState': 'Enable', 'MC_ReadAxisInfo': 'Enable', 'MC_ReadAxisError': 'Enable',
    // System / RTC (kronsystem.h) — EN-triggered but a REAL instance FB,
    // hence the SYSTEM_FB_TYPES entry that keeps it out of isInlineMathType.
    'Read_System_Time': 'EN',
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
    'USB_Send': 'Done', 'USB_Receive': 'NewData',
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
    // Conversion (72 entries generated below), Scaling
    'NORM_X': 'ENO', 'SCALE_X': 'ENO',
    // EtherCAT diagnostics
    'EC_GetMasterState': 'Valid',
    'EC_GetSlaveState': 'Valid',
    'EC_ResetBus': 'Done',
    'EC_ReadSDO': 'Done',
    'EC_WriteSDO': 'Done',
    // Motion control
    'MC_Power': 'Status',
    'MC_Home': 'Done', 'MC_Stop': 'Done', 'MC_Halt': 'Done',
    'MC_MoveAbsolute': 'Done', 'MC_MoveRelative': 'Done',
    'MC_MoveAdditive': 'Done', 'MC_MoveVelocity': 'InVelocity',
    'MC_MoveSuperimposed': 'Done', 'MC_HaltSuperimposed': 'Done',
    'MC_MoveContinuousAbsolute': 'InEndVelocity', 'MC_MoveContinuousRelative': 'InEndVelocity',
    'MC_SetPosition': 'Done', 'MC_SetOverride': 'Enabled',
    'MC_Reset': 'Done',
    'MC_ReadActualPosition': 'Valid', 'MC_ReadActualVelocity': 'Valid',
    'MC_ReadActualTorque': 'Valid', 'MC_ReadStatus': 'Valid',
    'MC_ReadMotionState': 'Valid', 'MC_ReadAxisInfo': 'Valid', 'MC_ReadAxisError': 'Valid',
    // System / RTC
    'Read_System_Time': 'ENO',
};

// Exported for agentTools.js (the PLC Agent's set_ladder): the agent authors
// FB-in-ladder rungs and must wire the power flow into the SAME trigger pin and
// out of the SAME Q pin this transpiler uses — importing the tables keeps one
// source of truth instead of a hand-copied map that would silently drift.
export { FB_TRIGGER_PIN, FB_Q_OUTPUT };

const GENERATED_FB_OUTPUT_TYPES = {};

// Returns the IEC type of an output pin for a given block type
// customData is optional — used for user-defined FB output pin types
const getOutputPinType = (blockType, pinName, customData) => {
    if (['Q', 'Q1', 'QU', 'QD', 'ENO'].includes(pinName)) return 'BOOL';
    if ((blockType === 'UART_Receive' || blockType === 'USB_Receive') && pinName === 'ReceivedLength') return 'UINT';
    // Read_System_Time.TIME is a DINT (ms since local midnight), NOT the IEC
    // TIME duration type the pin name suggests — must not fall through to the
    // `pinName === 'ET'`-style rules or the default BOOL.
    if (blockType === 'Read_System_Time' && pinName === 'TIME') return 'DINT';
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

// Sanitize a block id into a C identifier fragment (edge-memory field names).
const sanitizeBlockId = (id) => String(id).replace(/[^A-Za-z0-9_]/g, '_');

// Pre-scan rungs for Rising/Falling edge contacts & coils. Each needs one
// persistent BOOL holding the previous-scan value: programs get a PlcState
// field `prog_<prog>_edge_<id>`, FBs get a struct member `__edge_<id>`.
// Block ids are unique per project (ReactFlow), so names are collision-free.
const collectEdgeVars = (rungs) => {
    const list = [];
    (rungs || []).forEach(rung => {
        (rung.blocks || []).forEach(b => {
            const type = (b.type || '').trim();
            const sub = b.data?.subType;
            if ((type === 'Contact' || type === 'Coil') && (sub === 'Rising' || sub === 'Falling')) {
                list.push({ id: sanitizeBlockId(b.id), subType: sub, blockType: type });
            }
        });
    });
    return list;
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
        return v.length > 0 && IDENTIFIER_REF_REGEX.test(v);
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
                    } else if (/^16#([0-9A-Fa-f]+)$/i.test(cleanVal)) {
                        const hexDigits = cleanVal.slice(3);
                        const hexVal = parseInt(hexDigits, 16);
                        initStr = '0x' + hexDigits.toUpperCase();
                        initVal = hexVal;
                    } else if (/^-?\d+(\.\d+)?$/.test(cleanVal)) {
                        initStr = cleanVal;
                        initVal = parseFloat(cleanVal);
                    } else if (isBooleanLiteral(cleanVal)) {
                        initStr = normalizeBooleanLiteral(cleanVal) || 'false';
                        // BOOL shadow values must be real JS booleans: KronServer
                        // unmarshals WriteVar into a Go bool, and variable_table.json's
                        // initial_value must also be true/false for the same reason.
                        initVal = initStr === 'true';
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
                if (v && IDENTIFIER_REF_REGEX.test(v) && !isLiteral(v)) {
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
                if (!v || !IDENTIFIER_REF_REGEX.test(v) || isLiteral(v)) return;
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
    'USB_Send': ['Done', 'Busy', 'Error'],
    'USB_Receive': ['NewData', 'ReceivedLength', 'Error'],
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
    // EtherCAT diagnostics
    'EC_GetMasterState': ['Valid', 'Error', 'ErrorID', 'State', 'Operational', 'SlaveCount'],
    'EC_GetSlaveState':  ['Valid', 'Error', 'ErrorID', 'State', 'LinkUp'],
    'EC_ResetBus':       ['Done', 'Busy', 'Error', 'ErrorID'],
    'EC_ReadSDO':        ['Done', 'Busy', 'Error', 'ErrorID', 'Value'],
    'EC_WriteSDO':       ['Done', 'Busy', 'Error', 'ErrorID'],
    // Motion control
    'MC_Power': ['Status', 'Valid', 'Error', 'ErrorID'],
    'MC_Home': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_Stop': ['Done', 'Busy', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_Halt': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_MoveAbsolute': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_MoveRelative': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_MoveAdditive': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_MoveVelocity': ['InVelocity', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_MoveSuperimposed': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_HaltSuperimposed': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_MoveContinuousAbsolute': ['InEndVelocity', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_MoveContinuousRelative': ['InEndVelocity', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_SetPosition': ['Done', 'Busy', 'Error', 'ErrorID'],
    'MC_SetOverride': ['Enabled', 'Busy', 'Error', 'ErrorID'],
    'MC_Reset': ['Done', 'Busy', 'Error', 'ErrorID'],
    'MC_ReadActualPosition': ['Valid', 'Busy', 'Error', 'ErrorID', 'Position'],
    'MC_ReadActualVelocity': ['Valid', 'Busy', 'Error', 'ErrorID', 'Velocity'],
    'MC_ReadActualTorque': ['Valid', 'Busy', 'Error', 'ErrorID', 'Torque'],
    'MC_ReadStatus': ['Valid', 'Busy', 'Error', 'ErrorID', 'ErrorStop', 'Disabled', 'Stopping', 'Homing', 'Standstill', 'DiscreteMotion', 'ContinuousMotion', 'SynchronizedMotion'],
    'MC_ReadMotionState': ['Valid', 'Busy', 'Error', 'ErrorID', 'ConstantVelocity', 'Accelerating', 'Decelerating', 'DirectionPositive', 'DirectionNegative'],
    'MC_ReadAxisInfo': ['Valid', 'Busy', 'Error', 'ErrorID'],
    'MC_ReadAxisError': ['Valid', 'Busy', 'Error', 'ErrorID', 'AxisErrorID'],
    // System / RTC (kronsystem.h)
    'Read_System_Time': ['ENO', 'TIME'],
};
// All conversion blocks (X_TO_Y) share ['ENO', 'OUT'] — built dynamically below
// Programmatically populate all 72 X_TO_Y conversion entries across lookup tables
const _CONV_TYPES = ['BOOL', 'BYTE', 'WORD', 'DWORD', 'INT', 'UINT', 'DINT', 'UDINT', 'REAL'];
_CONV_TYPES.forEach(src => _CONV_TYPES.forEach(dst => {
    if (src === dst) return;
    const k = `${src}_TO_${dst}`;
    FB_TRIGGER_PIN[k] = 'EN';
    FB_Q_OUTPUT[k] = 'ENO';
    FB_OUTPUTS[k] = ['ENO', 'OUT'];
}));

// Exported for agentTools.js (add_variable): the agent must be able to declare
// an instance of a standard stateful FB (TON, CTU, MC_Power…). FB_OUTPUTS is the
// widest catalogue of known block types — combined with FB_TRIGGER_PIN !== 'EN'
// (which filters out the inline math/compare/convert ops, none of which are
// instances) it is exactly the set of types a variable may be declared as.
// Exported AFTER the generated conversion entries so importers see the full set.
export { FB_OUTPUTS };

// ── Math FB blocks: use struct-based _Call from kronmath.h ──
// Integer structs by default; _REAL variants used when inputs are REAL/LREAL.
// No EN/ENO fields. Struct type names may differ from block type.
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

// Tracks EtherCAT PDO variable names registered transiently during transpileToC.
// These are backed by GPI access macros (#define ec_X (__gpi_snap->_pi_ec_X)) —
// they must stay BARE names in generated code (no S-> prefix, no PlcState field,
// no SHM slot) or the macro expansion produces invalid C.
const EC_PDO_VAR_NAMES = new Set();

// Statically-known blocks that use EN as their power-flow pin but are REAL
// instance FBs backed by a struct + _Call (kronsystem.h) — the same exemption
// HAL_BLOCK_TYPES gives the dynamically-registered HAL blocks, except these are
// always present so they live in a permanent set. Without the exemption they
// would be treated as stateless inline math: no PlcState field, no instance, no
// shadow vars, and the LD path would fall into the inline branch that has no
// KRON_FN/BITWISE/MATH_FB entry for them.
// ⚠️ Every member needs a struct + `<Type>_Call(<Type>*)` reachable from a
// kron*.h in resources/krontek-include/ — otherwise the generated C references
// a type and a function that do not exist and the build fails at compile time.
const SYSTEM_FB_TYPES = new Set(['Read_System_Time']);
export { SYSTEM_FB_TYPES };

// Returns true for EN-trigger stateless blocks that should be inlined.
// HAL blocks (GPIO_Read, PWM0, etc.) are excluded even though their trigger is EN.
const isInlineMathType = (type) =>
    FB_TRIGGER_PIN[type] === 'EN' && !HAL_BLOCK_TYPES.has(type) && !SYSTEM_FB_TYPES.has(type);

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
    'USB_Send': ['Execute', 'Port_ID', 'pTxBuffer', 'Length'],
    'USB_Receive': ['Enable', 'Port_ID', 'pRxBuffer', 'MaxSize'],
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
    // Conversion (72 entries generated by _CONV_TYPES loop above)
    // Scaling
    'NORM_X': ['EN', 'MIN', 'MAX', 'VALUE'],
    'SCALE_X': ['EN', 'MIN', 'MAX', 'VALUE'],
    // EtherCAT diagnostics — cfg pointer passed as 2nd arg (like AXIS_REF for motion)
    'EC_GetMasterState': ['Enable'],
    'EC_GetSlaveState':  ['Enable', 'SlaveAddress'],
    'EC_ResetBus':       ['Execute'],
    'EC_ReadSDO':        ['Execute', 'SlaveAddress', 'Index', 'SubIndex', 'ByteSize'],
    'EC_WriteSDO':       ['Execute', 'SlaveAddress', 'Index', 'SubIndex', 'ByteSize', 'Value'],
    // Motion control — Axis parameter is NOT listed here (passed separately as 2nd arg to _Call)
    'MC_Power': ['Enable', 'EnablePositive', 'EnableNegative'],
    'MC_Home': ['Execute', 'Position', 'HomingMode'],
    'MC_Stop': ['Execute', 'Deceleration', 'Jerk'],
    'MC_Halt': ['Execute', 'Deceleration', 'Jerk', 'BufferMode'],
    'MC_MoveAbsolute': ['Execute', 'ContinuousUpdate', 'Position', 'Velocity', 'Acceleration', 'Deceleration', 'Jerk', 'BufferMode'],
    'MC_MoveRelative': ['Execute', 'ContinuousUpdate', 'Distance', 'Velocity', 'Acceleration', 'Deceleration', 'Jerk', 'BufferMode'],
    'MC_MoveAdditive': ['Execute', 'ContinuousUpdate', 'Distance', 'Velocity', 'Acceleration', 'Deceleration', 'Jerk', 'BufferMode'],
    'MC_MoveVelocity': ['Execute', 'ContinuousUpdate', 'Velocity', 'Acceleration', 'Deceleration', 'Jerk', 'Direction', 'BufferMode'],
    'MC_MoveSuperimposed': ['Execute', 'Distance', 'VelocityDiff', 'AccelerationDiff', 'DecelerationDiff', 'JerkDiff'],
    'MC_HaltSuperimposed': ['Execute', 'Deceleration', 'Jerk'],
    'MC_MoveContinuousAbsolute': ['Execute', 'Position', 'EndVelocity', 'Velocity', 'Acceleration', 'Deceleration', 'Jerk'],
    'MC_MoveContinuousRelative': ['Execute', 'Distance', 'EndVelocity', 'Velocity', 'Acceleration', 'Deceleration', 'Jerk'],
    'MC_SetPosition': ['Execute', 'Position', 'Relative'],
    'MC_SetOverride': ['Enable', 'VelFactor', 'AccFactor', 'JerkFactor'],
    'MC_Reset': ['Execute'],
    'MC_ReadActualPosition': ['Enable'],
    'MC_ReadActualVelocity': ['Enable'],
    'MC_ReadActualTorque': ['Enable'],
    'MC_ReadStatus': ['Enable'],
    'MC_ReadMotionState': ['Enable'],
    'MC_ReadAxisInfo': ['Enable'],
    'MC_ReadAxisError': ['Enable'],
    // System / RTC (kronsystem.h)
    'Read_System_Time': ['EN'],
};

// EtherCAT diagnostic FBs that require KRON_EC_Config* (&__ec_cfg) as 2nd parameter.
// No user-facing "Cfg" input pin — the global __ec_cfg is always passed.
const EC_FB_CFG_PARAM = new Set([
    'EC_GetMasterState', 'EC_GetSlaveState', 'EC_ResetBus',
    'EC_ReadSDO', 'EC_WriteSDO',
]);

// Motion control FBs that require AXIS_REF* as 2nd parameter to their _Call function.
// The Axis input is NOT a struct field — it is passed directly as &axisVar in the generated call.
const MOTION_FB_AXIS_PARAM = new Set([
    'MC_Power', 'MC_Home', 'MC_Stop', 'MC_Halt',
    'MC_MoveAbsolute', 'MC_MoveRelative', 'MC_MoveAdditive',
    'MC_MoveVelocity', 'MC_MoveContinuousAbsolute', 'MC_MoveContinuousRelative',
    'MC_MoveSuperimposed', 'MC_HaltSuperimposed',
    'MC_SetPosition', 'MC_SetOverride', 'MC_Reset',
    'MC_ReadActualPosition', 'MC_ReadActualVelocity', 'MC_ReadActualTorque',
    'MC_ReadStatus', 'MC_ReadMotionState', 'MC_ReadAxisInfo', 'MC_ReadAxisError',
]);

// Maps editor-facing pin names to actual C struct member names where they differ
const FB_C_PIN_NAME = {
    'CTU':  { 'R': 'RESET' },
    'CTUD': { 'R': 'RESET' },
};

// Public: the set of valid named-argument (pin) names for a standard FB/function
// type — inputs ∪ outputs ∪ EN/ENO — used by the ST editor to validate named
// arguments like `TON(IN := …, PT := …)`. Returns a lowercased Set, or null if
// the type is not a known standard block (the caller must then NOT flag, since
// it can't know the pin list — e.g. user-defined function blocks).
export const getStandardFBPins = (type) => {
    if (!type) return null;
    const t = String(type).trim();
    if (!t) return null;
    // X_TO_Y conversion functions: EN/ENO + IN/OUT (not enumerated in FB_INPUTS).
    if (/^[A-Za-z]+_TO_[A-Za-z]+$/i.test(t)) return new Set(['en', 'eno', 'in', 'out']);
    const tl = t.toLowerCase();
    const keyIn = Object.keys(FB_INPUTS).find((k) => k.toLowerCase() === tl);
    const keyOut = Object.keys(FB_OUTPUTS).find((k) => k.toLowerCase() === tl);
    if (!keyIn && !keyOut) return null;
    const pins = new Set(['en', 'eno']);
    (FB_INPUTS[keyIn] || []).forEach((p) => pins.add(p.toLowerCase()));
    (FB_OUTPUTS[keyOut] || []).forEach((p) => pins.add(p.toLowerCase()));
    return pins;
};
// Returns the C struct member name for a given editor pin name and block type.
// Lookup is case-insensitive; the original-case canonical pin from FB_C_PIN_NAME
// (or the user's spelling, when unknown) is returned.
const cStructPin = (blockType, editorPin) => {
    const map = FB_C_PIN_NAME[blockType];
    if (!map) return editorPin;
    if (map[editorPin] !== undefined) return map[editorPin];
    const lower = String(editorPin).toLowerCase();
    for (const k of Object.keys(map)) {
        if (k.toLowerCase() === lower) return map[k];
    }
    return editorPin;
};

// Canonicalize a pin name to the case used in the FB's C struct definition.
// IEC ST is case-insensitive, but the generated C is not — `bno.execute` is a
// compile error when the struct field is `Execute`. Falls back to the user's
// spelling for unknown FB types or unlisted pins.
const canonicalPinName = (fbType, userPin) => {
    if (!fbType || !userPin) return userPin;
    const lower = String(userPin).toLowerCase();
    const trigger = FB_TRIGGER_PIN[fbType];
    if (trigger && trigger.toLowerCase() === lower) return trigger;
    const inputs = FB_INPUT_TYPES[fbType];
    if (inputs) {
        for (const k of Object.keys(inputs)) {
            if (k.toLowerCase() === lower) return k;
        }
    }
    const outputs = FB_OUTPUTS[fbType];
    if (outputs) {
        for (const k of outputs) {
            if (k.toLowerCase() === lower) return k;
        }
    }
    return userPin;
};

// IEC type of each non-trigger input pin for standard FBs (for input shadow var generation)
const FB_INPUT_TYPES = {
    'I2C_WriteRead': { 'Port_ID': 'USINT', 'Device_Address': 'USINT', 'Register_Address': 'USINT', 'pTxBuffer': 'POINTER', 'TxLength': 'UINT', 'pRxBuffer': 'POINTER', 'RxLength': 'UINT' },
    'SPI_Transfer': { 'Port_ID': 'USINT', 'pTxBuffer': 'POINTER', 'pRxBuffer': 'POINTER', 'Length': 'UINT' },
    'UART_Send': { 'Port_ID': 'USINT', 'pTxBuffer': 'POINTER', 'Length': 'UINT' },
    'UART_Receive': { 'Port_ID': 'USINT', 'pRxBuffer': 'POINTER', 'MaxSize': 'UINT' },
    'USB_Send': { 'Port_ID': 'USINT', 'pTxBuffer': 'POINTER', 'Length': 'UINT' },
    'USB_Receive': { 'Port_ID': 'USINT', 'pRxBuffer': 'POINTER', 'MaxSize': 'UINT' },
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
// Motion control: all MC_* FBs take Axis: AXIS_REF
[...MOTION_FB_AXIS_PARAM].forEach(k => { FB_INPUT_TYPES[k] = { 'Axis': 'AXIS_REF' }; });
// Populate conversion entries for FB_INPUTS (must be after FB_INPUTS definition)
_CONV_TYPES.forEach(src => _CONV_TYPES.forEach(dst => {
    if (src !== dst) FB_INPUTS[`${src}_TO_${dst}`] = ['EN', 'IN'];
}));

const transpileSTLogics = (code, stdFunctions = {}, parentName = '', category = 'program', varMap = {}, varTypeMap = {}, userFBTypes = new Set(), opts = {}) => {
    if (!code) return `    // ST Implementation Empty\n`;
    const { fnReturnVar = null, userFunctionInputs = {}, userFBInputs = {} } = opts;

    // Strip IEC 61131-3 comments and VAR…END_VAR blocks before splitting:
    //   (* block comments — single or multi-line *)
    //   // line comments
    //   VAR … END_VAR (inline variable declarations — already declared in variable table)
    const stripped = code
        .replace(/\(\*[\s\S]*?\*\)/g, '')
        // Strip // line comments HERE, before the keyword-normalization below.
        // Otherwise an ST keyword that happens to appear inside a comment (e.g.
        // the word "of" in "period of 1 second") matches \bOF\b and gets a
        // newline injected, splitting the comment so its tail ("1 second")
        // survives the later per-line // strip and leaks into the C output.
        .replace(/\/\/[^\n]*/g, '')
        // Drop a leading `global.` / `GVL.` namespace prefix that some models
        // (CODESYS habit) put on variable refs — `global.blink(IN := …)` →
        // `blink(IN := …)`. Without this the FB-call detector misses the call
        // and emits invalid C `S->…blink(IN = …, PT = …)`. The lookbehind keeps
        // genuine member access (`x.global.y`) untouched; there is no global
        // namespace object in this dialect — variables are referenced bare.
        .replace(/(?<![\w.])(?:global|gvl)\s*\.\s*/gi, '')
        .replace(/\bVAR\b[\s\S]*?\bEND_VAR\b\s*;?/gi, '');

    // Expand inline control-flow: insert newlines so that keywords that the
    // line-oriented matchers below expect at end-of-line are actually there.
    // e.g.  IF x THEN y := 1; ELSIF z THEN y := 2; END_IF;
    //   →   IF x THEN\ny := 1;\nELSIF z THEN\ny := 2;\nEND_IF;
    const normalized = stripped
        // CASE label with a control-flow keyword body — split the body to a new
        // line so the IF / CASE / WHILE / FOR / REPEAT line-matcher sees it.
        // Without this, "1: IF foo THEN ..." is taken as a single expression by
        // the case-label handler and IF/THEN leak into the C output.
        // Labels may be numbers (incl. negative), identifiers (enum members) or
        // TypeName#EnumValue; `:(?!=)` keeps `x := IF…`-style text unmatched.
        .replace(/^((?:[A-Za-z_][A-Za-z0-9_#]*|-?\d+)(?:[ \t]*(?:\.\.|,)[ \t]*(?:[A-Za-z_][A-Za-z0-9_#]*|-?\d+))*[ \t]*:)(?!=)[ \t]+(?=(?:IF|CASE|WHILE|FOR|REPEAT)\b)/gim, '$1\n')
        // After THEN/DO/OF — insert newline when something follows on the same line
        .replace(/\bTHEN\b[ \t]*(?=[^\r\n])/gi, 'THEN\n')
        .replace(/\bDO\b[ \t]*(?=[^\r\n])/gi, 'DO\n')
        .replace(/\bOF\b[ \t]*(?=[^\r\n])/gi, 'OF\n')
        // Before ELSIF / ELSE / END_xxx / UNTIL / END_CASE — ensure they start on own line
        .replace(/[ \t]*\bELSIF\b/gi, '\nELSIF')
        .replace(/[ \t]*\bELSE\b(?!\s*IF\b)[ \t]*/gi, '\nELSE\n')
        .replace(/[ \t]*\bEND_IF\b/gi, '\nEND_IF')
        .replace(/[ \t]*\bEND_FOR\b/gi, '\nEND_FOR')
        .replace(/[ \t]*\bEND_WHILE\b/gi, '\nEND_WHILE')
        .replace(/[ \t]*\bEND_REPEAT\b/gi, '\nEND_REPEAT')
        .replace(/[ \t]*\bEND_CASE\b/gi, '\nEND_CASE')
        .replace(/[ \t]*\bUNTIL\b/gi, '\nUNTIL')
        // Split `; <control keyword>` so a control keyword always starts on its own line
        // (handles cases like `x := 1; IF cond THEN` left over after block-comment removal).
        .replace(/;[ \t]*(?=(?:IF|CASE|FOR|WHILE|REPEAT|RETURN|EXIT)\b)/gi, ';\n');

    // Join continuation lines: a line ending with AND/OR/NOT/XOR, an arithmetic
    // operator (+ - * /), a comparison operator (< > <= >= <>), comma, or
    // open-paren (after stripping comment) means the expression continues on
    // the next line.  Merge them so the keyword matchers (IF…THEN, ELSIF…THEN,
    // WHILE…DO, FOR…DO) see a single line.
    const rawLines = normalized.split(/\r?\n|\\n/).map(l => l.replace(/\/\/.*$/, ''));
    const lines = [];
    let pending = '';
    for (const raw of rawLines) {
        const trimRaw = raw.trim();
        if (!trimRaw) {
            if (pending) { /* skip blank continuation lines */ }
            else lines.push(raw);
            continue;
        }
        const combined = pending ? pending + ' ' + trimRaw : raw;
        const combinedTrim = combined.trim();
        // Continuation: line ends with logical/arithmetic/comparison operator, comma, or open-paren.
        // `:=` is excluded so an assignment line on its own doesn't accidentally swallow the next line.
        const endsWithContinuation =
            /\b(?:AND|OR|NOT|XOR)\s*$/i.test(combinedTrim) ||
            /[,(+\-*/]\s*$/.test(combinedTrim) ||
            (/(?:<=|>=|<>|<|>)\s*$/.test(combinedTrim)) ||
            (/(?<![:<>!=])=\s*$/.test(combinedTrim));
        if (endsWithContinuation) {
            pending = combinedTrim;
        } else {
            lines.push(combined);
            pending = '';
        }
    }
    if (pending) lines.push(pending);

    // Split numeric CASE labels that share a line with their body, e.g.:
    //   `1: init_wait(IN := TRUE, PT := T#30ms);`
    // becomes two separate lines so the body goes through the full statement
    // pipeline (FB-call detection, etc.) instead of being dumped raw into
    // transformExpr (which would mangle `:=` into `=` inside named args).
    {
        const expanded = [];
        // Label atoms: numbers (incl. negative), identifiers (enum members),
        // TypeName#EnumValue — same shapes the case-label handler accepts.
        // `:(?!=)` keeps assignments (`x := 1`) from being split as labels.
        const SPLIT_ATOM = '(?:[A-Za-z_][A-Za-z0-9_]*(?:#[A-Za-z_][A-Za-z0-9_]*)?|-?\\d+)';
        const SPLIT_LABEL_RE = new RegExp(`^(${SPLIT_ATOM}(?:\\s*(?:\\.\\.|,)\\s*${SPLIT_ATOM})*)\\s*:(?!=)\\s*(.+)$`);
        for (const ln of lines) {
            const t = ln.trim();
            const m = t.match(SPLIT_LABEL_RE);
            const body = m && m[2].trim();
            if (m && body && body !== ';') {
                expanded.push(m[1].trim() + ':');
                expanded.push(body);
            } else {
                expanded.push(ln);
            }
        }
        lines.length = 0;
        for (const ln of expanded) lines.push(ln);
    }

    // Split lines that pack multiple `;`-separated statements onto one physical
    // line, e.g. the body of a single-line `IF … THEN fb(); x := 1; END_IF`
    // (after control-keyword normalization the body survives as
    // `fb(); x := 1;`). The FB-call detector (regex anchored with `$`) matches
    // a WHOLE line as exactly one `inst(args);` call, so a trailing second
    // statement made it fall through to transformExpr — which mangles a named
    // FB call `init_wait(IN := FALSE)` into `init_wait(IN = false)` (undeclared
    // `IN`). Splitting on TOP-LEVEL `;` (paren depth 0, outside '…' strings)
    // gives each statement its own line; control-flow headers (IF/FOR/END_*)
    // carry no internal `;` so they're untouched, and a lone single-statement
    // line is preserved verbatim (keeps its trailing `;`).
    {
        const expanded = [];
        for (const ln of lines) {
            if (ln.indexOf(';') < 0) { expanded.push(ln); continue; }
            const parts = [];
            let buf = '', depth = 0, inStr = false;
            for (let k = 0; k < ln.length; k++) {
                const ch = ln[k];
                if (inStr) { buf += ch; if (ch === "'") inStr = false; continue; }
                if (ch === "'") { inStr = true; buf += ch; continue; }
                if (ch === '(') depth++;
                else if (ch === ')' && depth > 0) depth--;
                if (ch === ';' && depth === 0) { parts.push(buf); buf = ''; continue; }
                buf += ch;
            }
            if (buf.trim()) parts.push(buf);
            const real = parts.filter(p => p.trim());
            if (real.length <= 1) { expanded.push(ln); continue; }
            for (const p of real) expanded.push(p.trim() + ';');
        }
        lines.length = 0;
        for (const ln of expanded) lines.push(ln);
    }

    let out = '';
    let indentLevel = 1; // 1 = inside function body (4 spaces)
    // Block nesting stack — each entry represents an open control structure.
    // Used to disambiguate ELSE: only treat as switch `default:` when the
    // innermost open block is a CASE. ELSE inside an IF nested in a CASE is
    // the IF's else branch, not the case's default.
    // Frames: { kind: 'CASE' | 'IF' | 'FOR' | 'WHILE' | 'REPEAT', ... }
    // CASE frames also carry { caseBodyOpen, hasDefault } so END_CASE knows
    // whether to emit a fallback `default: break;` (skipped when user already
    // wrote ELSE inside the CASE).
    const blockStack = [];
    const topKind = () => (blockStack.length ? blockStack[blockStack.length - 1].kind : null);
    const topFrame = () => blockStack[blockStack.length - 1];
    const popIfTop = (kind) => { if (topKind() === kind) blockStack.pop(); };

    const indent = () => '    '.repeat(indentLevel);

    // Substitute known variable names with their C equivalents.
    // SINGLE-PASS: one alternation regex (longest name first) with a callback —
    // never rescans already-substituted output, so a variable named `s`, `q`
    // or `instance` can no longer corrupt an earlier `S->…` / `instance->…`
    // substitution. Matches preceded by `.` or `->` (member access) are skipped.
    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const varMapLower = {};
    Object.keys(varMap).forEach(name => { varMapLower[name.toLowerCase()] = varMap[name]; });
    const varNamesSorted = Object.keys(varMap).sort((a, b) => b.length - a.length);
    const varNameRegex = varNamesSorted.length > 0
        ? new RegExp(`\\b(?:${varNamesSorted.map(escapeRegExp).join('|')})\\b`, 'gi')
        : null;
    const resolveVarsInExpr = (expr) => {
        if (!varNameRegex) return expr;
        return String(expr).replace(varNameRegex, (m, offset, whole) => {
            const prev = offset > 0 ? whole[offset - 1] : '';
            if (prev === '.') return m; // member access (x.Q) — leave member name alone
            if (prev === '>' && offset > 1 && whole[offset - 2] === '-') return m; // already C `->`
            const mapped = varMapLower[m.toLowerCase()];
            return mapped !== undefined ? mapped : m;
        });
    };

    const transformExpr = (expr) => {
        // Protect string and wstring literals from substitution. IEC uses single
        // quotes for STRING and double quotes for WSTRING. We escape them out,
        // perform all transformations, and splice back at the end so AND/OR/MOD
        // keywords or commas inside string content stay intact.
        const stringTokens = [];
        let work = String(expr).replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, m => {
            stringTokens.push(m);
            return `${stringTokens.length - 1}`;
        });

        // Named-argument USER FUNCTION calls (`MyFunc(A := x, B := y)`) → map the
        // args positionally by the function's Input declaration order, BEFORE the
        // `:=` protection below would mangle them into `A = x`. Only non-nested
        // argument lists are handled (regex limit) — the common form.
        Object.entries(userFunctionInputs).forEach(([fnName, inputs]) => {
            if (!inputs || inputs.length === 0) return;
            const re = new RegExp(`\\b${fnName}\\s*\\(([^()]*)\\)`, 'gi');
            work = work.replace(re, (m, argStr) => {
                if (!/:=/.test(argStr)) return m;
                const byName = {};
                argStr.split(',').forEach(a => {
                    const mm = a.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([\s\S]+?)\s*$/);
                    if (mm) byName[mm[1].toLowerCase()] = mm[2];
                });
                const positional = inputs.map(p => byName[p.toLowerCase()] !== undefined ? byName[p.toLowerCase()] : '0');
                return `${fnName}(${positional.join(', ')})`;
            });
        });

        let result = work
            .replace(/\b[A-Za-z_][A-Za-z0-9_]*#([A-Za-z_][A-Za-z0-9_]*)\b/g, '$1') // TypeName#EnumValue → EnumValue
            .replace(/\b16#([0-9A-Fa-f]+)/gi, '0x$1')  // IEC hex literal: 16#FF → 0xFF
            .replace(/:=/g, '__ASSIGN__')               // protect assignments before = → == pass
            .replace(/<>/g, '!=')                       // IEC not-equal → C not-equal
            .replace(/(?<![:=<>!])=(?!=)/g, '==')       // comparison = → == (not :=, <=, >=, !=, ==)
            .replace(/__ASSIGN__/g, '=')                // restore assignments
            // Bitwise (IEC vendor extension) — must run BEFORE logical AND/OR/XOR/NOT
            // so e.g. BAND doesn't get partially matched by the AND rule.
            .replace(/\bBAND\b/gi, '&')
            .replace(/\bBOR\b/gi, '|')
            .replace(/\bBXOR\b/gi, '^^^')   // placeholder — XOR rewrite below collapses ^
            .replace(/\bBNOT\b/gi, '~')
            .replace(/\bAND\b/gi, '&&')
            .replace(/\bOR\b/gi, '||')
            .replace(/\bNOT\b/gi, '!')
            .replace(/\bMOD\b/gi, '%')
            .replace(/\bXOR\b/gi, '^')
            .replace(/\^\^\^/g, '^')        // restore BXOR placeholder
            .replace(/\bTRUE\b/gi, 'true')
            .replace(/\bFALSE\b/gi, 'false');
        // IEC time-duration literal → microsecond integer. Handles simple,
        // fractional and compound forms (T#5ms, T#1.5s, T#1m30s, T#1h2m3s500ms);
        // a malformed literal throws a transpile error in mapIECtoTimeUs.
        result = result.replace(/\b(?:T|TIME)#(?:[\d._]+(?:MS|US|NS|D|H|M|S))+\b/gi, m => String(mapIECtoTimeUs(m)));
        result = result.replace(/\bADR\s*\(\s*([^)]+?)\s*\)/gi, (_, inner) => `(&(${resolveVarsInExpr(inner.trim())}))`);
        result = result.replace(/\bNULL\b/gi, 'NULL');
        // IEC 61131-3 type-conversion functions → KRON_ library names
        // e.g. BYTE_TO_UINT(...) → KRON_BYTE_TO_UINT16(...)
        const IEC_TO_KRON_TYPE = {
            BOOL:'BOOL', BYTE:'BYTE', WORD:'WORD', DWORD:'DWORD', LWORD:'LWORD',
            SINT:'INT8', INT:'INT16', DINT:'INT32', LINT:'INT64',
            USINT:'UINT8', UINT:'UINT16', UDINT:'UINT32', ULINT:'UINT64',
            REAL:'REAL', LREAL:'LREAL',
        };
        result = result.replace(/\b([A-Za-z]+)_TO_([A-Za-z]+)(?=\s*\()/g, (match, src, dst) => {
            const ks = IEC_TO_KRON_TYPE[src.toUpperCase()];
            const kd = IEC_TO_KRON_TYPE[dst.toUpperCase()];
            return (ks && kd) ? `KRON_${ks}_TO_${kd}` : match;
        });
        // IEC type cast functions: INT(x) → (int16_t)(x), DINT(x) → (int32_t)(x), etc.
        const IEC_CAST_C = {
            BOOL: 'bool', BYTE: 'uint8_t', WORD: 'uint16_t', DWORD: 'uint32_t', LWORD: 'uint64_t',
            SINT: 'int8_t', INT: 'int16_t', DINT: 'int32_t', LINT: 'int64_t',
            USINT: 'uint8_t', UINT: 'uint16_t', UDINT: 'uint32_t', ULINT: 'uint64_t',
            REAL: 'float', LREAL: 'double',
        };
        result = result.replace(/\b(BOOL|BYTE|WORD|DWORD|LWORD|SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT|REAL|LREAL)\s*\(/gi,
            (match, typeName) => {
                const ct = IEC_CAST_C[typeName.toUpperCase()];
                return ct ? `(${ct})(` : match;
            }
        );
        result = resolveVarsInExpr(result);
        // Restore protected strings
        return result.replace(/(\d+)/g, (_, i) => stringTokens[+i]);
    };

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        // ── CASE x OF ────────────────────────────────────────────────────
        const caseOfMatch = trimmed.match(/^CASE\s+(.+?)\s+OF\s*;?\s*$/i);
        if (caseOfMatch) {
            out += `${indent()}switch (${transformExpr(caseOfMatch[1])}) {\n`;
            indentLevel++;
            blockStack.push({ kind: 'CASE', caseBodyOpen: false, hasDefault: false });
            return;
        }

        // ── END_CASE ─────────────────────────────────────────────────────
        if (/^END_CASE\s*;?$/i.test(trimmed)) {
            const frame = topFrame();
            if (frame && frame.kind === 'CASE') {
                if (frame.caseBodyOpen) {
                    out += `${indent()}break;\n`;
                    indentLevel = Math.max(1, indentLevel - 1);
                }
                // Only emit fallback default if user did not already write ELSE
                if (!frame.hasDefault) {
                    out += `${indent()}default: break;\n`;
                }
                indentLevel = Math.max(1, indentLevel - 1);
                out += `${indent()}}\n`;
                blockStack.pop();
            }
            return;
        }

        // ── Case label(s): n:, IDLE:, -1:, n1,n2:, n1..n2: ────────────────
        // Only valid when the innermost open block is the CASE itself — a
        // case label inside a nested IF/FOR/WHILE is a syntax error in IEC
        // and we should not treat it as one here.
        if (topKind() === 'CASE') {
            const frame = topFrame();
            // ELSE inside CASE (at the case's direct level) → default:
            // Checked BEFORE label matching — `ELSE` would otherwise parse as
            // an identifier label now that identifier labels are supported.
            if (/^ELSE\b\s*:?/i.test(trimmed)) {
                if (frame.caseBodyOpen) {
                    out += `${indent()}break;\n`;
                    indentLevel = Math.max(1, indentLevel - 1);
                }
                out += `${indent()}default:\n`;
                indentLevel++;
                frame.caseBodyOpen = true;
                frame.hasDefault = true;
                const elseBody = trimmed.replace(/^ELSE\b\s*:?\s*/i, '').trim();
                if (elseBody && elseBody !== ';') {
                    let cl = transformExpr(elseBody);
                    if (!cl.endsWith(';')) cl += ';';
                    out += `${indent()}${cl}\n`;
                }
                return;
            }
            // Label atoms: integers (incl. negative), identifiers (enum members —
            // transpiled enums are plain C enum constants, so a bare identifier
            // label works), or TypeName#EnumValue. `:(?!=)` keeps assignments
            // (`x := 1`) from matching as a label `x`.
            const CASE_ATOM = '(?:[A-Za-z_][A-Za-z0-9_]*(?:#[A-Za-z_][A-Za-z0-9_]*)?|-?\\d+)';
            const caseLabelMatch = trimmed.match(new RegExp(`^(${CASE_ATOM}(?:\\s*(?:\\.\\.|,)\\s*${CASE_ATOM})*)\\s*:(?!=)\\s*(.*)$`));
            if (caseLabelMatch) {
                const labelPart = caseLabelMatch[1].trim();
                const bodyPart  = caseLabelMatch[2].trim();
                if (frame.caseBodyOpen) {
                    out += `${indent()}break;\n`;
                    indentLevel = Math.max(1, indentLevel - 1);
                }
                // TypeName#EnumValue → EnumValue (enum members are bare C constants)
                const stripEnumPrefix = (p) => p.replace(/^[A-Za-z_][A-Za-z0-9_]*#/, '');
                // Multiple values: "1, 2" or ranges "1..3"
                const parts = labelPart.split(',').map(p => p.trim());
                parts.forEach(p => {
                    if (p.includes('..')) {
                        const [fromS, toS] = p.split('..').map(n => n.trim());
                        const from = parseInt(fromS, 10);
                        const to = parseInt(toS, 10);
                        if (Number.isFinite(from) && Number.isFinite(to)) {
                            for (let v = from; v <= to; v++) out += `${indent()}case ${v}:\n`;
                        } else {
                            // Non-numeric range bounds: GCC/Clang case-range extension
                            out += `${indent()}case ${stripEnumPrefix(fromS)} ... ${stripEnumPrefix(toS)}:\n`;
                        }
                    } else {
                        out += `${indent()}case ${stripEnumPrefix(p)}:\n`;
                    }
                });
                indentLevel++;
                frame.caseBodyOpen = true;
                if (bodyPart && bodyPart !== ';') {
                    let cl = transformExpr(bodyPart);
                    if (!cl.endsWith(';')) cl += ';';
                    out += `${indent()}${cl}\n`;
                }
                return;
            }
        }

        // ── Block closing keywords ────────────────────────────────────────
        if (/^END_IF\s*;?$/i.test(trimmed)) {
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}}\n`;
            popIfTop('IF');
            return;
        }
        if (/^END_FOR\s*;?$/i.test(trimmed)) {
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}}\n`;
            popIfTop('FOR');
            return;
        }
        if (/^END_WHILE\s*;?$/i.test(trimmed)) {
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}}\n`;
            popIfTop('WHILE');
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
            blockStack.push({ kind: 'IF' });
            return;
        }

        // ── FOR ... TO ... BY ... DO (BY clause first — more specific) ────
        const forByMatch = trimmed.match(/^FOR\s+(\w+)\s*:=\s*(.+?)\s+TO\s+(.+?)\s+BY\s+(.+?)\s+DO\s*;?\s*$/i);
        if (forByMatch) {
            const [, vn, start, end, step] = forByMatch;
            const cv = varMap[vn] || vn;
            const stepExpr = transformExpr(step).trim();
            const endExpr = transformExpr(end);
            // Loop condition depends on the step SIGN: a negative BY counts down
            // (cv >= end). Literal steps get the right operator directly; a
            // variable step gets a runtime sign check.
            let cond;
            if (/^-\s*\d+(?:\.\d+)?$/.test(stepExpr)) {
                cond = `${cv} >= ${endExpr}`;
            } else if (/^\+?\s*\d+(?:\.\d+)?$/.test(stepExpr)) {
                cond = `${cv} <= ${endExpr}`;
            } else {
                cond = `((${stepExpr}) >= 0 ? (${cv} <= ${endExpr}) : (${cv} >= ${endExpr}))`;
            }
            out += `${indent()}for (${cv} = ${transformExpr(start)}; ${cond}; ${cv} += ${stepExpr}) {\n`;
            indentLevel++;
            blockStack.push({ kind: 'FOR' });
            return;
        }

        // ── FOR ... TO ... DO ─────────────────────────────────────────────
        const forMatch = trimmed.match(/^FOR\s+(\w+)\s*:=\s*(.+?)\s+TO\s+(.+?)\s+DO\s*;?\s*$/i);
        if (forMatch) {
            const [, vn, start, end] = forMatch;
            const cv = varMap[vn] || vn;
            out += `${indent()}for (${cv} = ${transformExpr(start)}; ${cv} <= ${transformExpr(end)}; ${cv}++) {\n`;
            indentLevel++;
            blockStack.push({ kind: 'FOR' });
            return;
        }

        // ── WHILE ... DO ──────────────────────────────────────────────────
        const whileMatch = trimmed.match(/^WHILE\s+(.+?)\s+DO\s*;?\s*$/i);
        if (whileMatch) {
            out += `${indent()}while (${transformExpr(whileMatch[1])}) {\n`;
            indentLevel++;
            blockStack.push({ kind: 'WHILE' });
            return;
        }

        // ── REPEAT (do-while start) ───────────────────────────────────────
        if (/^REPEAT\s*;?\s*$/i.test(trimmed)) {
            out += `${indent()}do {\n`;
            indentLevel++;
            blockStack.push({ kind: 'REPEAT' });
            return;
        }

        // ── UNTIL (do-while end) ──────────────────────────────────────────
        const untilMatch = trimmed.match(/^UNTIL\s+(.+?)\s*;?\s*$/i);
        if (untilMatch) {
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}} while (!(${transformExpr(untilMatch[1])}));\n`;
            popIfTop('REPEAT');
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
            if (retVal) {
                out += `${indent()}return ${transformExpr(retVal)};\n`;
            } else if (fnReturnVar) {
                // IEC RETURN carries no value — a non-void FUNCTION returns the
                // current result variable (FuncName := … assignments target it).
                out += `${indent()}return ${fnReturnVar};\n`;
            } else {
                out += `${indent()}return;\n`;
            }
            return;
        }

        // ── FB instance call: instName(Pin1 := val1, Pin2 := val2, …) ─────
        // Multi-line forms are pre-merged by the line-continuation loop above
        // (lines ending with `,` or `(` get joined). We treat the statement as
        // an FB call when the target is a known FB-typed variable; user
        // functions and inline math FB types fall through to the generic path.
        const fbCallMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*;?\s*$/);
        if (fbCallMatch) {
            const instName = fbCallMatch[1];
            const argStr = fbCallMatch[2];
            const fbType = varTypeMap[instName];
            const isFB = fbType && (
                stdFunctions[fbType] !== undefined ||
                HAL_BLOCK_TYPES.has(fbType) ||
                userFBTypes.has(fbType) ||
                (fbType in FB_TRIGGER_PIN && !isInlineMathType(fbType))
            );
            // Any call statement on an FB-typed variable is an FB call: named
            // args (`:=`/`=>`), an empty arg list, or POSITIONAL args
            // (`inst(a, b)` — mapped onto the FB's input pins in order).
            if (isFB) {
                const cInst = varMap[instName];
                // Top-level comma split — depth- and string-aware so nested
                // calls/casts and string literals stay intact.
                const args = [];
                {
                    let cur = '', d = 0, inStr = null;
                    for (const ch of argStr) {
                        if (inStr) {
                            cur += ch;
                            if (ch === inStr) inStr = null;
                            continue;
                        }
                        if (ch === "'" || ch === '"') { inStr = ch; cur += ch; continue; }
                        if (ch === '(') d++;
                        else if (ch === ')' && d > 0) d--;
                        if (ch === ',' && d === 0) {
                            if (cur.trim()) args.push(cur.trim());
                            cur = '';
                        } else {
                            cur += ch;
                        }
                    }
                    if (cur.trim()) args.push(cur.trim());
                }

                const isMotion = MOTION_FB_AXIS_PARAM.has(fbType);
                let axisExpr = null;
                // Output captures (`OUT => varname`) are emitted AFTER the Call
                // so the user reads post-call values.
                const outputCaptures = [];

                // POSITIONAL call (`inst(a, b)`, no `:=`/`=>`): synthesize named
                // args by the FB's input pin declaration order (EN skipped — it
                // is not a struct field on standard FBs).
                let effArgs = args;
                if (args.length > 0 && !args.some(a => /:=|=>/.test(a))) {
                    const fbTypeNorm = (fbType || '').trim().replace(/\s+/g, '_');
                    const pinOrder = (FB_INPUTS[fbType] || stdFunctions[fbType]?.inputs || userFBInputs[fbTypeNorm] || [])
                        .filter(p => p !== 'EN');
                    effArgs = args
                        .map((a, i) => (pinOrder[i] ? `${pinOrder[i]} := ${a}` : null))
                        .filter(Boolean);
                }

                effArgs.forEach(a => {
                    // Try output-capture form first (`Pin => varname`); then
                    // input form (`Pin := value`). Anything else is ignored.
                    const outM = a.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=>\s*([\s\S]+)$/);
                    if (outM) {
                        const userPin = outM[1];
                        const target  = outM[2].trim();
                        const member  = cStructPin(fbType, canonicalPinName(fbType, userPin));
                        const lhs     = transformExpr(target);
                        outputCaptures.push(`${lhs} = ${cInst}.${member}`);
                        return;
                    }
                    const m = a.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([\s\S]+)$/);
                    if (!m) return;
                    const userPin  = m[1];
                    const rawValue = m[2].trim();
                    const pinName  = canonicalPinName(fbType, userPin);

                    // Motion FB Axis pin: passed as 2nd Call arg, not a struct field
                    if (isMotion && pinName === 'Axis') {
                        axisExpr = IDENTIFIER_REF_REGEX.test(rawValue)
                            ? `&(${resolveVarsInExpr(rawValue)})`
                            : transformExpr(rawValue);
                        return;
                    }

                    const inputType = FB_INPUT_TYPES[fbType]?.[pinName];
                    let value;
                    if (pinName === 'Port_ID') {
                        const portNum = resolveHardwarePortSymbol(rawValue);
                        value = portNum !== null ? portNum : transformExpr(rawValue);
                    } else if (isPointerInputType(inputType)) {
                        if (/^NULL$/i.test(rawValue)) value = 'NULL';
                        else if (IDENTIFIER_REF_REGEX.test(rawValue)) value = `&(${resolveVarsInExpr(rawValue)})`;
                        else value = transformExpr(rawValue);
                    } else if (inputType === 'TIME') {
                        // Only convert actual T#/TIME# LITERALS. A variable (or
                        // expression) passed to PT must go through transformExpr —
                        // mapIECtoTimeUs never returns null, so it used to turn
                        // `PT := myDelay` into the literal 10000.
                        value = /^(?:T|TIME|LTIME|LT)#/i.test(rawValue)
                            ? String(mapIECtoTimeUs(rawValue))
                            : transformExpr(rawValue);
                    } else {
                        value = transformExpr(rawValue);
                    }

                    const member = cStructPin(fbType, pinName);
                    out += `${indent()}${cInst}.${member} = ${value};\n`;
                });

                if (isMotion) {
                    out += `${indent()}${fbType}_Call(&${cInst}, ${axisExpr || 'NULL'});\n`;
                } else if (EC_FB_CFG_PARAM.has(fbType)) {
                    out += `${indent()}${fbType}_Call(&${cInst}, &__ec_cfg);\n`;
                } else if (stdFunctions[fbType]?.hasTime) {
                    out += `${indent()}${fbType}_Call(&${cInst}, us_tick);\n`;
                } else if (userFBTypes.has(fbType)) {
                    // User-defined FB bodies are emitted as <Name>_Execute(inst).
                    out += `${indent()}${fbType}_Execute(&${cInst});\n`;
                } else {
                    out += `${indent()}${fbType}_Call(&${cInst});\n`;
                }

                outputCaptures.forEach(stmt => { out += `${indent()}${stmt};\n`; });
                return;
            }
        }

        // ── Regular statement (assignment, function call, etc.) ───────────
        let cl = transformExpr(trimmed);
        if (!cl.endsWith(';')) cl += ';';
        out += `${indent()}${cl}\n`;
    });

    return out || `    // ST parsing placeholder\n`;
};

const transpileLDLogics = (rungs, stdFunctions = {}, parentName = '', category = 'program', globalVarNames = [], inputShadowMap = null, rungIdxOffset = 0, cSymTypeMap = {}, localVarNames = new Set(), fbInstanceNames = new Set()) => {
    if (!rungs || rungs.length === 0) return `    // LD Implementation Empty\n`;

    let out = '';

    // Returns true if a C expression represents a REAL (float) value:
    // either a float literal (contains decimal point) or a REAL/LREAL variable.
    const isRealExpr = (val) => {
        if (!val) return false;
        if (/^-?[0-9]*\.[0-9]+([eE][+-]?[0-9]+)?$/.test(val)) return true;
        if (/^-?[0-9]+\.[0-9]*([eE][+-]?[0-9]+)?$/.test(val)) return true;
        return ['REAL', 'LREAL'].includes(cSymTypeMap[val]);
    };

    // Resolve a variable/signal name to its C symbol, respecting scope.
    // Handles simple names, array elements (var[idx]), struct members (var.member),
    // FB-instance output access (blink.Q → …_inst_blink.Q).
    const resolveVar = (varName) => {
        if (!varName) return null;
        const s = varName.trim();
        // Split base name from suffix (array index or struct member access)
        const sepIdx = s.search(/[[.]/);
        const baseName = (sepIdx >= 0 ? s.slice(0, sepIdx) : s).replace(/\s+/g, '_');
        const suffix = sepIdx >= 0 ? s.slice(sepIdx) : '';
        // EtherCAT PDO variables have no PlcState field — leave the name BARE
        // so the GPI access macro (#define ec_X (__gpi_snap->…)) applies.
        if (EC_PDO_VAR_NAMES.has(baseName) && !localVarNames.has(baseName)) {
            return baseName + suffix;
        }
        if (category === 'program') {
            // All state lives in PlcState (hot-swap): globals and local program
            // vars are both fields reached via S->.
            if (globalVarNames.includes(baseName)) return `S->${baseName}${suffix}`;
            // FB instance member access (blink.Q): the state field is
            // prog_<prog>_inst_<name>, mirroring the ST varMap logic.
            if (suffix.startsWith('.') && fbInstanceNames.has(baseName)) {
                return `S->prog_${parentName}_inst_${baseName}${suffix}`;
            }
            return `S->prog_${parentName}_${baseName}${suffix}`;
        }
        if (category === 'function_block') {
            // Locals (incl. FB-local FB instances) live in the instance struct;
            // GLOBALS referenced inside an FB's ladder are PlcState fields.
            if (!localVarNames.has(baseName) && globalVarNames.includes(baseName)) {
                return `S->${baseName}${suffix}`;
            }
            return `instance->${baseName}${suffix}`;
        }
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
            if (IDENTIFIER_REF_REGEX.test(adrTarget)) {
                return `&(${resolveVar(adrTarget)})`;
            }
            return null;
        }
        if (s.toUpperCase().startsWith('T#') || s.toUpperCase().startsWith('TIME#')) {
            return mapIECtoTimeUs(s).toString();
        }
        // IEC hex literal 16#FF → 0xFF
        if (/^16#[0-9A-Fa-f]+$/i.test(s)) return '0x' + s.slice(3).toUpperCase();
        // Binary literal 0b... → decimal (C99 doesn't support 0b).
        // NOTE: parse the DIGITS only — parseInt('0b101', 2) is 0.
        if (/^0[bB][01]+$/.test(s)) return parseInt(s.slice(2), 2).toString();
        // Octal literal 0o... → C octal 0... (C uses leading-zero octal)
        if (/^0[oO][0-7]+$/.test(s)) return '0' + parseInt(s.slice(2), 8).toString(8);
        // Numeric literal — STRICT: plain int, float (with optional exponent),
        // or hex 0x…. Malformed tokens (`5F`, `1.2.3`, `0x`) return null so the
        // problem surfaces instead of leaking garbage into the C output.
        if (/^-?\d+$/.test(s)) return s;
        if (/^-?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return s;
        if (/^-?\d+[eE][+-]?\d+$/.test(s)) return s;
        if (/^-?0[xX][0-9A-Fa-f]+$/.test(s)) return s;
        // Boolean literals
        if (isBooleanLiteral(s)) return normalizeBooleanLiteral(s);
        // Variable reference: simple, arr[idx], or struct.member
        if (IDENTIFIER_REF_REGEX.test(s)) {
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

    // Get the C call-target for an FB instance. GLOBAL FB instances are plain
    // PlcState fields (`S-><name>`, no prog_/inst_ prefix — matching how the
    // global-variable loop emits them); locals get the per-POU field.
    const getCallTarget = (instName) => {
        const i = (instName || '').trim().replace(/\s+/g, '_');
        if (!localVarNames.has(i) && globalVarNames.includes(i)) return `S->${i}`;
        if (category === 'program') return `S->prog_${parentName}_inst_${i}`;
        if (category === 'function_block') return `instance->${i}`;
        return i;
    };

    rungs.forEach((rung, ri) => {
        const rungIdx = rungIdxOffset + ri;
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

        // Tracks which sorted block indices use REAL inline mode (for source-ref resolution)
        const realInlineBlocks = new Set();

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

            // Persistent edge memory for Rising/Falling contacts & coils —
            // matches the fields pushed by collectEdgeVars (PlcState for
            // programs, instance struct member for FBs). Functions have no
            // persistent state, so edges there degrade to level semantics.
            const edgeMemRef = () => {
                const id = sanitizeBlockId(blockId);
                if (category === 'program') return `S->prog_${parentName}_edge_${id}`;
                if (category === 'function_block') return `instance->__edge_${id}`;
                return null;
            };

            if (type === 'Contact') {
                const varName = ((data.values?.var || data.instanceName) + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() || null;
                if (varName) {
                    const v = resolveVar(varName);
                    if (subType === 'Rising' || subType === 'Falling') {
                        const mem = edgeMemRef();
                        if (mem) {
                            // One-scan pulse on the variable's transition
                            const edgeLocal = `__e_r${rungIdx}_b${idx}`;
                            out += `    bool ${edgeLocal} = ${subType === 'Rising' ? `(${v} && !${mem})` : `(!${v} && ${mem})`};\n`;
                            out += `    ${mem} = ${v};\n`;
                            out += `    ${bOut} = ${inExpr} && ${edgeLocal};\n`;
                        } else {
                            // No persistent state (function): level semantics fallback
                            out += `    ${bOut} = ${inExpr} && ${subType === 'Falling' ? `!${v}` : v}; /* edge contact: no state in FUNCTION, level fallback */\n`;
                        }
                    } else if (subType === 'NC') {
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
                    } else if (subType === 'Rising' || subType === 'Falling') {
                        // Edge coil: target is TRUE for exactly one scan on the
                        // rung input's rising/falling transition.
                        const mem = edgeMemRef();
                        if (mem) {
                            out += `    ${v} = ${subType === 'Rising' ? `(${bOut} && !${mem})` : `(!${bOut} && ${mem})`};\n`;
                            out += `    ${mem} = ${bOut};\n`;
                        } else {
                            out += `    ${v} = ${bOut}; /* edge coil: no state in FUNCTION, level fallback */\n`;
                        }
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
                            const srcType = srcBlock?.type || srcBlock?.data?.type || '';
                            const srcInstName = (srcBlock?.data?.instanceName || srcType || '');
                            if (isInlineMathType(srcType) && MATH_FB_BLOCKS.has(srcType)) {
                                const srcIdx = sortedIndex[c.source];
                                if (realInlineBlocks.has(srcIdx)) {
                                    argValues[pinName] = `_m_r${rungIdx}_b${srcIdx}_rout`;
                                } else {
                                    argValues[pinName] = `_m_r${rungIdx}_b${srcIdx}.${sp.slice(4)}`;
                                }
                            } else {
                                argValues[pinName] = `${getCallTarget(srcInstName)}.${sp.slice(4)}`;
                            }
                        } else {
                            argValues[pinName] = `out_r${rungIdx}_b${sortedIndex[c.source]}`;
                        }
                    }
                });

                const args = dataInputPins.map(pin => argValues[pin] || '0');

                if (MATH_FB_BLOCKS.has(type)) {
                    // ── Math FB: local struct + _Call (kronmath.h) ──
                    // When inputs are REAL/LREAL or float literals, emit inline C expressions
                    // (no struct needed — uses C operators and standard math functions).
                    const inputVals = dataInputPins.map(pin => argValues[pin] || '0');
                    const outRawCheck = data.values?.OUT;
                    const outVarCheck = outRawCheck ? (outRawCheck + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                    const outCSym = outVarCheck ? resolveVar(outVarCheck) : null;
                    const useReal = inputVals.some(isRealExpr) ||
                        (outCSym && ['REAL', 'LREAL'].includes(cSymTypeMap[outCSym]));

                    out += `    ${bOut} = ${inExpr};\n`;

                    if (useReal) {
                        // ── Inline REAL path: no struct, emit C float expressions ──
                        realInlineBlocks.add(idx);
                        const localRout = `_m_r${rungIdx}_b${idx}_rout`;
                        const fv = (v) => `(float)(${v})`;  // cast helper
                        let realExpr = '0.0f';
                        if (MATH_FB_ARRAY_INPUT.has(type)) {
                            // ADD, MUL, AVG — multi-input
                            const fVals = inputVals.map(fv);
                            if (type === 'ADD') realExpr = fVals.join(' + ');
                            else if (type === 'MUL') realExpr = fVals.join(' * ');
                            else if (type === 'AVG') realExpr = `(${fVals.join(' + ')}) / ${inputVals.length}.0f`;
                        } else {
                            const a = fv(inputVals[0] || '0');
                            const b = fv(inputVals[1] || '0');
                            if (type === 'SUB')  realExpr = `${a} - ${b}`;
                            else if (type === 'DIV')  realExpr = `(${b} != 0.0f) ? (${a} / ${b}) : 0.0f`;
                            else if (type === 'MOD')  realExpr = `(${b} != 0.0f) ? fmodf(${a}, ${b}) : 0.0f`;
                            else if (type === 'MOVE') realExpr = a;
                            else if (type === 'NEG')  realExpr = `-${a}`;
                            else if (type === 'ABS')  realExpr = `(${a} < 0.0f ? -${a} : ${a})`;
                            else if (type === 'SQRT') realExpr = `(${a} >= 0.0f ? sqrtf(${a}) : 0.0f)`;
                            else if (type === 'EXPT') realExpr = `powf(${a}, ${b})`;
                        }
                        out += `    float ${localRout} = 0.0f;\n`;
                        out += `    if (${bOut}) {\n`;
                        out += `        ${localRout} = ${realExpr};\n`;
                        if (outVarCheck && IDENTIFIER_REF_REGEX.test(outVarCheck)) {
                            out += `        ${resolveVar(outVarCheck)} = ${localRout};\n`;
                        }
                        out += `    }\n`;
                    } else {
                        // ── Integer path: struct + _Call (kronmath.h) ──
                        const structType = MATH_FB_STRUCT[type] || type;
                        const callFn = `${structType === type ? type : structType.replace('_FB', '')}_Call`;
                        const localVar = `_m_r${rungIdx}_b${idx}`;
                        const pinMap = MATH_FB_PIN_MAP[type] || {};

                        out += `    ${structType} ${localVar} = {0};\n`;
                        out += `    if (${bOut}) {\n`;

                        if (MATH_FB_ARRAY_INPUT.has(type)) {
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

                        if (outVarCheck && IDENTIFIER_REF_REGEX.test(outVarCheck)) {
                            out += `    ${resolveVar(outVarCheck)} = ${localVar}.OUT;\n`;
                        }
                        out += `    }\n`;
                    }

                    // ENO write-back (power-flow passthrough)
                    const enoRaw = data.values?.ENO;
                    const enoVar = enoRaw ? (enoRaw + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                    if (enoVar && IDENTIFIER_REF_REGEX.test(enoVar)) {
                        out += `    ${resolveVar(enoVar)} = ${bOut};\n`;
                    }

                } else {
                    // ── Inline comparison/selection/range/bitwise/conversion ──
                    let resultExpr;
                    if (type === 'MUX') {
                        // KRON_MUX expects (k, ARRAY-pointer, n) — dereferencing a
                        // scalar is a compile error. The 2-input XML block is a
                        // simple select: K != 0 picks IN1.
                        resultExpr = `((${argValues['K'] || '0'}) ? (${argValues['IN1'] || '0'}) : (${argValues['IN0'] || '0'}))`;
                    } else if (type === 'LIMIT') {
                        // IEC LIMIT(MN, IN, MX); the KRON_LIMIT macro takes
                        // (mn, in, mx) — FB_INPUTS order is (IN, MN, MX), so map
                        // by NAME instead of position.
                        resultExpr = `KRON_LIMIT(${argValues['MN'] || '0'}, ${argValues['IN'] || '0'}, ${argValues['MX'] || '0'})`;
                    } else if (KRON_FN[type]) {
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
                        if (qVar && IDENTIFIER_REF_REGEX.test(qVar)) {
                            out += `    ${resolveVar(qVar)} = ${resultExpr};\n`;
                        }
                    } else {
                        out += `    ${bOut} = ${inExpr};\n`;
                        // Assign OUT to target variable
                        const outRaw = data.values?.OUT;
                        const outVar = outRaw ? (outRaw + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                        if (outVar && IDENTIFIER_REF_REGEX.test(outVar)) {
                            out += `    if (${bOut}) { ${resolveVar(outVar)} = ${resultExpr}; }\n`;
                        }
                    }

                    // ENO write-back (if assigned to a variable)
                    const enoRaw = data.values?.ENO;
                    const enoVar = enoRaw ? (enoRaw + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                    if (enoVar && IDENTIFIER_REF_REGEX.test(enoVar)) {
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
                        if (FB_TRIGGER_PIN[type] && pinName === FB_TRIGGER_PIN[type]) return; // overwritten by power flow in step 3
                        if (MOTION_FB_AXIS_PARAM.has(type) && pinName === 'Axis') return; // passed as 2nd call param
                        // Skip pins not in inputPins (e.g. old output pins removed from the standard)
                        if (inputPins.length > 0 && !inputPins.includes(pinName) && !isUserDefinedFB) return;
                        const cPin = cStructPin(type, pinName);
                        const shadowSym = inputShadowMap?.get(`${safeInst}_${pinName}`);
                        if (shadowSym) {
                            out += `    ${callTarget}.${cPin} = S->${shadowSym};\n`;
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
                            out += `    ${callTarget}.${cPin} = S->${shadowSym};\n`;
                        }
                    });
                }
                (inputPins || []).forEach(pinName => {
                    if (pinName === FB_TRIGGER_PIN[type]) return;
                    if (outputPinNames.has(pinName)) return;
                    if (MOTION_FB_AXIS_PARAM.has(type) && pinName === 'Axis') return; // not a struct field
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
                            const srcType = srcBlock?.type || srcBlock?.data?.type || '';
                            const srcInstName = (srcBlock?.data?.instanceName || srcType || '');
                            // Inline math blocks use a local variable, not a persistent instance
                            let srcRef;
                            if (isInlineMathType(srcType) && MATH_FB_BLOCKS.has(srcType)) {
                                const srcIdx = sortedIndex[c.source];
                                srcRef = realInlineBlocks.has(srcIdx)
                                    ? `_m_r${rungIdx}_b${srcIdx}_rout`
                                    : `_m_r${rungIdx}_b${srcIdx}.${sp.slice(4)}`;
                            } else {
                                srcRef = `${getCallTarget(srcInstName)}.${sp.slice(4)}`;
                            }
                            const sourceExpr = adaptExprForInputPin(type, pinName, srcRef, data.customData);
                            out += `    ${callTarget}.${cPin} = ${sourceExpr};\n`;
                        } else {
                            const sourceExpr = adaptExprForInputPin(type, pinName, `out_r${rungIdx}_b${sortedIndex[c.source]}`, data.customData);
                            out += `    ${callTarget}.${cPin} = ${sourceExpr};\n`;
                        }
                    }
                });
                }

                // Step 3: set the trigger (power-flow) input
                // If the user typed a variable name into the trigger pin field (e.g. "SWB_State"
                // for Execute), AND it with the rung power flow so the FB sees the actual
                // signal transitions (rising/falling edge) instead of a constant true.
                const triggerPin = FB_TRIGGER_PIN[type] || (!isUserDefinedFB && !FB_INPUTS[type] && inputPins.length > 0 ? inputPins[0] : null);
                if (triggerPin) {
                    let trigExpr = inExpr;
                    const userTrigVal = data.values?.[triggerPin];
                    if (userTrigVal && userTrigVal !== '') {
                        const resolvedTrig = resolveInputPinValue(type, triggerPin, userTrigVal, data.customData);
                        if (resolvedTrig !== null && resolvedTrig !== undefined
                            && resolvedTrig !== 'true' && resolvedTrig !== 'false') {
                            // AND user value with power flow; simplify if power is just 'true'
                            trigExpr = (inExpr === 'true' || inExpr === '(true)')
                                ? resolvedTrig
                                : `(${inExpr}) && ${resolvedTrig}`;
                        }
                    }
                    out += `    ${callTarget}.${cStructPin(type, triggerPin)} = ${trigExpr};\n`;
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
                } else if (EC_FB_CFG_PARAM.has(type)) {
                    // EtherCAT diagnostic FB: EC_xxx_Call(&inst, &__ec_cfg)
                    out += `    ${type}_Call(&${callTarget}, &__ec_cfg);\n`;
                } else if (MOTION_FB_AXIS_PARAM.has(type)) {
                    // PLCopen motion FB: MC_xxx_Call(&inst, &axisVar)
                    const axisRaw = data.values?.Axis;
                    const axisClean = axisRaw ? String(axisRaw).replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                    const axisExpr = (axisClean && IDENTIFIER_REF_REGEX.test(axisClean))
                        ? `&${resolveVar(axisClean)}`
                        : 'NULL';
                    out += `    ${type}_Call(&${callTarget}, ${axisExpr});\n`;
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
                    const isVarAssigned = varStr && IDENTIFIER_REF_REGEX.test(varStr);
                    if (isVarAssigned) {
                        out += `    ${resolveVar(varStr)} = ${callTarget}.${pinName};\n`;
                    }
                    // Always write to shadow tracking var so the variable table can show output values
                    if (category !== 'function_block') {
                        out += `    S->prog_${parentName}_out_${safeInst}_${pinName} = ${callTarget}.${pinName};\n`;
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
    // Fallback to custom name — sanitized like the typedef emission ("My FB" →
    // typedef My_FB), so field declarations reference the real C type name.
    return typeMap[iecType] || String(iecType || '').trim().replace(/\s+/g, '_');
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
        // Dimensions are sized [max+1] (NOT [max-min+1]) so raw IEC indices stay
        // valid when the lower bound is > 0 — every element access in generated
        // code (ST/LD passthrough, SHM/debug expansion) uses raw IEC indices.
        // Elements below `min` are simply unused. Negative lower bounds cannot
        // be represented this way and are rejected.
        const sizes = dt.content.dimensions.map(d => {
            const min = parseInt(d.min, 10);
            const max = parseInt(d.max, 10);
            if (!Number.isFinite(min) || !Number.isFinite(max)) {
                throw new Error(`ARRAY data type "${dt.name}": invalid dimension bounds [${d.min}..${d.max}].`);
            }
            if (min < 0) {
                throw new Error(`ARRAY lower bound must be >= 0 (data type "${dt.name}" has [${d.min}..${d.max}]).`);
            }
            if (max < min) {
                throw new Error(`ARRAY upper bound must be >= lower bound (data type "${dt.name}" has [${d.min}..${d.max}]).`);
            }
            return `[${max + 1}]`;
        }).join('');
        code += `typedef ${mapType(dt.content.baseType)} ${dt.name}${sizes};\n\n`;
    }
    return code;
};
