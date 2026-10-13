import { getBoardBlockMeta } from '../utils/halBlockMeta';
import { buildGeneratedDeviceArtifacts } from '../utils/deviceCodegen';
import { getPortOptions } from '../utils/devicePortMapping';
import { validateIECAddress } from '../utils/iecAddress';
import { buildEcVarNames, findEcIssues } from '../utils/ecNaming';
import { createSTExprCompiler, STExprError } from './stExpr';

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
    // Generic Linux targets (industrial PC, VM, unlisted SBC): device-node
    // peripherals only, same userspace HAL as the RPi.
    if (boardId.startsWith('generic_linux')) return 'HAL_BOARD_FAMILY_RPI';
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
const isStringInputType = (iecType) => /^W?STRING$/i.test(String(iecType || '').trim());
// Bytes a STRING occupies — in PlcState AND in the shared-memory mirror,
// including the NUL. Matches KRON_SYS_TEXT_LEN in kronsystem.h (a static
// assert in plc.h holds the two together) so a reader block's whole line fits.
// IEC `STRING[n]` is not supported: every STRING is this one fixed size.
const STRING_SHM_BYTES = 64;

// ── IEC STRING has VALUE semantics ──────────────────────────────────────────
// A STRING variable (global, program local, FB/UDT member, array element,
// FUNCTION local/input) is a fixed `kron_string_t` = `char[STRING_SHM_BYTES]`
// holding the TEXT, never a `char *`. A pointer field was wrong three ways: a
// retained one persisted an address from the previous process, under hot-swap
// a literal assigned once pointed into the .rodata of a dlclose'd logic_N.so,
// and `a := b` aliased instead of copying.
// ⚠️ An array cannot be the target of C `=`, so EVERY assignment to STRING
// storage is lowered to KRON_STRSET (bounded, NUL-terminating, NUL-padding;
// see the plc.h preamble). The macro refuses a target that is not a
// kron_string_t at COMPILE time, so a mis-detected `const char *` pin (the
// standard blocks' PATH/NAME inputs, which are pointers re-assigned every
// scan) fails loudly instead of being written through.
const STRING_C_TYPE = 'kron_string_t';
const kronStrset = (dst, src) => `KRON_STRSET(${dst}, ${src})`;
// C return type of a FUNCTION: a STRING result is handed back as a pointer to
// a per-thread buffer (an array cannot be returned) — see transpilePOUSource.
const fnReturnCType = (iecType) => (isStringInputType(iecType) ? 'const char *' : mapType(iecType || 'VOID'));

// IEC type name → the KRON_ library's spelling, e.g. INT→INT16. Module level
// because the ST rewrite and the ladder conversion branch must agree; they had
// separate copies and only one of them knew about text.
const IEC_KRON_NAME = {
    BOOL: 'BOOL', BYTE: 'BYTE', WORD: 'WORD', DWORD: 'DWORD', LWORD: 'LWORD',
    SINT: 'INT8', INT: 'INT16', DINT: 'INT32', LINT: 'INT64',
    USINT: 'UINT8', UINT: 'UINT16', UDINT: 'UINT32', ULINT: 'UINT64',
    REAL: 'REAL', LREAL: 'LREAL', STRING: 'STRING',
};
// Buffer symbol for one x_TO_STRING call site. A conversion to text has to
// write SOMEWHERE, and every ownerless answer is wrong: a static races between
// task threads, a thread-local pool goes stale, a compound literal dangles
// after the scan. Giving each call site a PlcState field makes the text live
// exactly as long as the instance and survive a hot-swap.
const strConvSymbol = (progName, tag) => `prog_${progName}_sconv_${tag}`;
// Upper bound on ST call sites. Comments and string literals are stripped
// before the rewrite runs, so the rewrite can only consume FEWER than this —
// never more, which would reference a field that was never declared.
const countStringConvCalls = (code) => ((stripIecComments(code, { blankStrings: true })
    .match(/\b[A-Za-z]+_TO_STRING\s*\(/g)) || []).length;

// ── Shared-memory mirror: one emitter per direction ─────────────────────────
// ⚠️ Both plc_shm_sync/pull and their per-task twins in generateMainLoop are
// generated from these, so the two copies cannot drift apart.
//
// SHM layout v2 (the byte contract is server/RING_FORMAT.md § "Variable
// segment"): data slots from 0 at NATURAL alignment, one runtime-owned flag
// byte per variable from SHM_FORCE_FLAGS_BASE, and the force-write command
// mailbox at SHM_MAILBOX_BASE. Writers (KronServer, the host agent) never touch
// a slot or a flag any more — they post a command and wait for its ack.
//
// A STRING variable is a `kron_string_t` (char[64]) holding the text, and the
// slot carries the same TEXT: copy the characters, NUL-pad the rest. The scan
// is bounded by the slot, so a buffer something filled without a terminator
// (a block's own VALUE) can never be over-read. Two consequences, both
// deliberate:
//   - the mirror is written UNCONDITIONALLY for text, ignoring the force flag,
//     because a string cannot be forced (see below) and honouring a stray flag
//     would freeze the display;
//   - text is NEVER pulled back: a 64-byte copy cannot be applied atomically
//     between scans the way a scalar is, and a STRING pin of a standard block
//     is a `const char *` the runtime does not own. STRING is a read-only
//     live value (KronServer encodeValue, writeHotSwapVariable, the UI and the
//     mailbox's PLC_MB_ST_READ_ONLY all refuse a write).
// ⚠️ Text is the one slot NOT copied atomically (64 bytes cannot be): a reader
// racing this memcpy can see half of the old line and half of the new one. A
// torn display line is tolerable for a read-only diagnostic; anything that
// needs a consistent value must not be a STRING.
const SHM_LAYOUT_VERSION = 2;
const SHM_TOTAL_SIZE = 65536;      // must match PLC_SHM_SIZE and KronServer's -shm-size
const SHM_FORCE_FLAGS_BASE = 32768;
const SHM_MAILBOX_BASE = 61440;    // 0xF000: the top 4 KiB of the segment
const SHM_MAILBOX_CAP = 64;
// Natural-width carrier for a scalar slot. Every slot is aligned to its own
// width (max 8), so these loads/stores are single-copy atomic on every target —
// including 64-bit values on armv7 (ldrexd/strexd need 8-byte alignment).
const SHM_SCALAR_C = { 1: 'uint8_t', 2: 'uint16_t', 4: 'uint32_t', 8: 'uint64_t' };
const shmScalarC = (size) => SHM_SCALAR_C[size] || null;

const shmSyncLine = ({ c_symbol, offset, size, flagOffset, isString }) => isString
    ? `    { const char *__s = (const char *)(S->${c_symbol}); size_t __n = 0u;` +
      ` while (__n < ${size - 1}u && __s[__n]) __n++;` +
      ` if (__n) memcpy(__plc_shm + ${offset}, __s, __n);` +
      ` memset(__plc_shm + ${offset} + __n, 0, ${size}u - __n); }\n`
    // A FORCED slot shows the forced value (kept in S->__plc_fv, which only the
    // mailbox consumer writes), never whatever the logic computed this scan.
    : `    PLC_SLOT_ST(${offset}, (PLC_FLAG_LD(${flagOffset}) == PLC_FLAG_FORCED) ? (const void*)(S->__plc_fv + ${offset}) : (const void*)&(S->${c_symbol}), ${shmScalarC(size)});\n`;

// ⚠️ The forced value is re-injected from S->__plc_fv, NOT from the data slot.
// The slot is a display: plc_shm_sync on ANOTHER task thread may have read the
// flag as 0 just before the consumer forced it and store the stale computed
// value afterwards — re-reading the slot would then pin that stale value, the
// exact race the mailbox exists to remove. Any flag value other than 0 /
// PLC_FLAG_FORCED was written by an outdated writer (v1 KronServer/agent).
const shmPullLine = ({ c_symbol, offset, size, flagOffset, isString }) => isString
    ? ''
    : `    { uint8_t __f = PLC_FLAG_LD(${flagOffset}); if (__f) { if (__f == PLC_FLAG_FORCED) PLC_COPY_IN(&(S->${c_symbol}), S->__plc_fv + ${offset}, ${shmScalarC(size)}); else plc_mb_foreign(${flagOffset}u, __f); } }\n`;

// ── Force-write command mailbox (runtime = the ONLY consumer) ──────────────
// Writers used to store the value into the data slot and then set the flag
// byte. A plc_shm_sync between those two stores overwrote the new value, the
// flag then pinned the OLD one, and the request still returned 200. Now a
// writer posts {seq, index, op, size, value} into this mailbox, publishing seq
// LAST (release); the runtime drains it at the start of every plc_shm_pull,
// applies each command (PlcState + forced value + slot + flag — the runtime
// OWNS the flag bytes now) and publishes `ack`. The writer returns success only
// after the ack. Byte layout: server/RING_FORMAT.md § "Force-write mailbox";
// the Go writer is hotswaplib/shmcmd, shared by KronServer and the host agent.
//
// ⚠️ Every task thread runs plc_shm_pull, so consumption is a TRY-lock in the
// segment itself: a thread that finds it taken simply skips (the holder
// applies everything pending). Never a blocking mutex — RT tasks of different
// priority would invert on it. The lock and the cursors live in the MIRROR,
// which the loader-host owns, so under hot-swap nothing is lost or applied
// twice across a swap (no thread is ever inside pull while the barrier holds).
const generateShmMailbox = (shmEntries) => {
    let c = '';
    c += `#include <stdio.h>\n`;
    c += `#define PLC_SHM_LAYOUT_VERSION ${SHM_LAYOUT_VERSION}u\n`;
    c += `#define PLC_FORCE_FLAGS_BASE ${SHM_FORCE_FLAGS_BASE}u\n`;
    // Flag byte values (runtime-written): 0 = the logic owns the value,
    // PLC_FLAG_FORCED = re-injected from S->__plc_fv every scan. PULSE is no
    // longer a stored state — it is applied once when its command is consumed.
    // Anything else came from an outdated writer and is cleared + counted.
    c += `#define PLC_FLAG_FORCED 0x81u\n`;
    c += `#define PLC_MB_BASE ${SHM_MAILBOX_BASE}u\n`;
    c += `#define PLC_MB_MAGIC 0x424D524Bu /* "KRMB" */\n`;
    c += `#define PLC_MB_HDR 64u\n`;
    c += `#define PLC_MB_CAP ${SHM_MAILBOX_CAP}u\n`;
    c += `#define PLC_MB_ENTRY 32u\n`;
    c += `#define PLC_MB_NVARS ${shmEntries.length}u\n`;
    c += `#define PLC_MB_OP_FORCE 1u\n#define PLC_MB_OP_PULSE 2u\n#define PLC_MB_OP_UNFORCE 3u\n#define PLC_MB_OP_CLEAR_ALL 4u\n`;
    c += `#define PLC_MB_ST_CLAIMED 1u\n#define PLC_MB_ST_APPLIED 2u\n#define PLC_MB_ST_BAD_INDEX 3u\n#define PLC_MB_ST_BAD_SIZE 4u\n#define PLC_MB_ST_READ_ONLY 5u\n#define PLC_MB_ST_BAD_OP 6u\n`;
    c += `#define PLC_FLAG_LD(f) __atomic_load_n(__plc_shm + (f), __ATOMIC_ACQUIRE)\n`;
    c += `#define PLC_SLOT_ST(off, src, T) do { T __v; memcpy(&__v, (src), sizeof(T)); __atomic_store_n((T *)(__plc_shm + (off)), __v, __ATOMIC_RELAXED); } while (0)\n`;
    c += `#define PLC_COPY_IN(dst, src, T) do { T __v = __atomic_load_n((const T *)(src), __ATOMIC_RELAXED); memcpy((dst), &__v, sizeof(T)); } while (0)\n`;
    // Atomic store of an n-byte scalar to an n-aligned address.
    c += `static void plc_mb_put(uint8_t *d, const uint8_t *s, int n) {\n`;
    c += `    switch (n) {\n`;
    c += `    case 1: __atomic_store_n(d, s[0], __ATOMIC_RELAXED); break;\n`;
    c += `    case 2: { uint16_t v; memcpy(&v, s, 2); __atomic_store_n((uint16_t *)d, v, __ATOMIC_RELAXED); } break;\n`;
    c += `    case 4: { uint32_t v; memcpy(&v, s, 4); __atomic_store_n((uint32_t *)d, v, __ATOMIC_RELAXED); } break;\n`;
    c += `    case 8: { uint64_t v; memcpy(&v, s, 8); __atomic_store_n((uint64_t *)d, v, __ATOMIC_RELAXED); } break;\n`;
    c += `    default: break;\n    }\n}\n`;
    // index → (slot offset, PlcState address, size); -1 = read-only (STRING).
    c += `static int plc_mb_target(uint32_t i, uint32_t *off, void **st) {\n`;
    c += `    switch (i) {\n`;
    shmEntries.forEach((e, i) => {
        c += e.isString
            ? `    case ${i}u: return -1;\n`
            : `    case ${i}u: *off = ${e.offset}u; *st = (void *)&(S->${e.c_symbol}); return ${e.size};\n`;
    });
    c += `    default: (void)off; (void)st; return 0;\n    }\n}\n`;
    // A flag byte this runtime never writes: an outdated writer (a v1
    // KronServer or host agent) stored value + flag directly. Its write is
    // dropped — honouring it would bring back the race — and said out loud.
    c += `static void plc_mb_foreign(uint32_t flag, uint8_t v) {\n`;
    c += `    static int warned = 0;\n`;
    c += `    if (!__atomic_compare_exchange_n(__plc_shm + flag, &v, (uint8_t)0, 0, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) return;\n`;
    c += `    __atomic_fetch_add((uint32_t *)(__plc_shm + PLC_MB_BASE + 44u), 1u, __ATOMIC_RELAXED);\n`;
    c += `    if (!__atomic_exchange_n(&warned, 1, __ATOMIC_RELAXED))\n`;
    c += `        fprintf(stderr, "[plc] ignored a force flag written directly into shared memory: the writer predates the force-write mailbox (SHM layout v%u) - redeploy KronServer (server/build.sh + Deploy Server to Target)\\n", PLC_SHM_LAYOUT_VERSION);\n`;
    c += `}\n`;
    c += `static uint32_t plc_mb_apply(const uint8_t *e) {\n`;
    c += `    uint32_t idx; memcpy(&idx, e + 8, 4);\n`;
    c += `    uint8_t op = e[16], sz = e[17], has = e[18];\n`;
    c += `    const uint8_t *val = e + 24;\n`;
    c += `    if (op == PLC_MB_OP_CLEAR_ALL) {\n`;
    c += `        for (uint32_t i = 0; i < PLC_MB_NVARS; i++) __atomic_store_n(__plc_shm + PLC_FORCE_FLAGS_BASE + i, (uint8_t)0, __ATOMIC_RELEASE);\n`;
    c += `        return PLC_MB_ST_APPLIED;\n    }\n`;
    c += `    if (op < PLC_MB_OP_FORCE || op > PLC_MB_OP_UNFORCE) return PLC_MB_ST_BAD_OP;\n`;
    c += `    uint32_t off = 0; void *st = 0;\n`;
    c += `    int n = plc_mb_target(idx, &off, &st);\n`;
    c += `    if (n == 0) return PLC_MB_ST_BAD_INDEX;\n`;
    c += `    if (n < 0) return PLC_MB_ST_READ_ONLY;\n`;
    c += `    int writes = (op != PLC_MB_OP_UNFORCE) || has;\n`;
    c += `    if (writes && sz != (uint8_t)n) return PLC_MB_ST_BAD_SIZE;\n`;
    c += `    uint8_t *flag = __plc_shm + PLC_FORCE_FLAGS_BASE + idx;\n`;
    c += `    if (op == PLC_MB_OP_FORCE) {\n`;
    // forced value FIRST, then the flag with release: a pull on another task
    // that acquire-loads FORCED is guaranteed to read the new forced value.
    c += `        plc_mb_put(S->__plc_fv + off, val, n);\n`;
    c += `        __atomic_store_n(flag, (uint8_t)PLC_FLAG_FORCED, __ATOMIC_RELEASE);\n`;
    c += `    } else {\n`;
    c += `        __atomic_store_n(flag, (uint8_t)0, __ATOMIC_RELEASE);\n`;
    c += `    }\n`;
    c += `    if (writes) { memcpy(st, val, (size_t)n); plc_mb_put(__plc_shm + off, val, n); }\n`;
    c += `    return PLC_MB_ST_APPLIED;\n`;
    c += `}\n`;
    c += `static void plc_mb_consume(void) {\n`;
    c += `    uint8_t *mb = __plc_shm + PLC_MB_BASE;\n`;
    c += `    if (__atomic_load_n((uint32_t *)(mb + 0), __ATOMIC_ACQUIRE) != PLC_MB_MAGIC) return;\n`;
    c += `    if (__atomic_exchange_n((uint32_t *)(mb + 20), 1u, __ATOMIC_ACQUIRE) != 0u) return; /* another task is draining */\n`;
    c += `    uint64_t ack = __atomic_load_n((uint64_t *)(mb + 32), __ATOMIC_RELAXED);\n`;
    // Bounded to one lap per scan, so a flood can never stretch a scan.
    c += `    for (uint32_t k = 0; k < PLC_MB_CAP; k++) {\n`;
    c += `        uint64_t s = ack + 1u;\n`;
    c += `        uint8_t *e = mb + PLC_MB_HDR + (uint32_t)(s % PLC_MB_CAP) * PLC_MB_ENTRY;\n`;
    c += `        if (__atomic_load_n((uint64_t *)e, __ATOMIC_ACQUIRE) != s) break;\n`;
    // CLAIM before applying: a writer that timed out CASes the same word to
    // "cancelled", so a late runtime can never apply a write its client was
    // already told had failed.
    c += `        uint32_t expect = 0u;\n`;
    c += `        if (__atomic_compare_exchange_n((uint32_t *)(e + 12), &expect, PLC_MB_ST_CLAIMED, 0, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE))\n`;
    c += `            __atomic_store_n((uint32_t *)(e + 12), plc_mb_apply(e), __ATOMIC_RELEASE);\n`;
    c += `        ack = s;\n`;
    c += `        __atomic_store_n((uint64_t *)(mb + 32), ack, __ATOMIC_RELEASE);\n`;
    c += `    }\n`;
    c += `    __atomic_store_n((uint32_t *)(mb + 20), 0u, __ATOMIC_RELEASE);\n`;
    c += `}\n`;
    // Runs once per runtime start, BEFORE any task thread exists (plc_shm_init
    // in the single binary, plc_init_hs on a hot-swap cold start — never on a
    // swap, whose mailbox state must carry over untouched).
    c += `static void plc_mb_init(void) {\n`;
    c += `    if (!__plc_shm) return;\n`;
    c += `    uint8_t *mb = __plc_shm + PLC_MB_BASE;\n`;
    c += `    __atomic_store_n((uint32_t *)(mb + 0), 0u, __ATOMIC_RELEASE); /* unpublished while re-initialising */\n`;
    // A force that survived a crash-restart with the SAME table (KronServer
    // clears the flags when the table changed): its slot still shows the forced
    // value, because plc_shm_sync wrote S->__plc_fv there — reload it.
    c += `    for (uint32_t i = 0; i < PLC_MB_NVARS; i++) {\n`;
    c += `        uint8_t f = __atomic_load_n(__plc_shm + PLC_FORCE_FLAGS_BASE + i, __ATOMIC_RELAXED);\n`;
    c += `        if (!f) continue;\n`;
    c += `        uint32_t off = 0; void *st = 0;\n`;
    c += `        int n = plc_mb_target(i, &off, &st);\n`;
    c += `        if (f != PLC_FLAG_FORCED || n <= 0) { __atomic_store_n(__plc_shm + PLC_FORCE_FLAGS_BASE + i, (uint8_t)0, __ATOMIC_RELAXED); continue; }\n`;
    c += `        memcpy(S->__plc_fv + off, __plc_shm + off, (size_t)n);\n`;
    c += `        memcpy(st, __plc_shm + off, (size_t)n);\n`;
    c += `    }\n`;
    // Anything posted while no runtime was consuming belongs to nobody: its
    // writer has timed out (and been told so) — drop it, never apply it late.
    c += `    __atomic_store_n((uint64_t *)(mb + 32), __atomic_load_n((uint64_t *)(mb + 24), __ATOMIC_ACQUIRE), __ATOMIC_RELAXED);\n`;
    c += `    __atomic_store_n((uint32_t *)(mb + 20), 0u, __ATOMIC_RELAXED);\n`;
    c += `    __atomic_store_n((uint16_t *)(mb + 4), (uint16_t)PLC_SHM_LAYOUT_VERSION, __ATOMIC_RELAXED);\n`;
    c += `    __atomic_store_n((uint16_t *)(mb + 6), (uint16_t)PLC_MB_HDR, __ATOMIC_RELAXED);\n`;
    c += `    __atomic_store_n((uint32_t *)(mb + 8), PLC_MB_CAP, __ATOMIC_RELAXED);\n`;
    c += `    __atomic_store_n((uint32_t *)(mb + 12), PLC_MB_ENTRY, __ATOMIC_RELAXED);\n`;
    c += `    __atomic_store_n((uint32_t *)(mb + 16), PLC_MB_NVARS, __ATOMIC_RELAXED);\n`;
    c += `    __atomic_store_n((uint32_t *)(mb + 0), PLC_MB_MAGIC, __ATOMIC_RELEASE); /* publish LAST */\n`;
    c += `}\n`;
    return c;
};

// ── IEC STRING literals ───────────────────────────────────────────────────
// IEC escapes the `$` character ($$ $' $" $L $N $P $R $T and $xx hex); C
// escapes the backslash. Decoding to plain text FIRST and re-escaping for C
// second is what keeps a Windows path or an apostrophe from producing a
// broken (or silently different) C literal.
const iecStringDecode = (body) => {
    let out = '';
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '$' && i + 1 < body.length) {
            const n = body[i + 1];
            const up = n.toUpperCase();
            if (n === '$' || n === "'" || n === '"') { out += n; i++; continue; }
            if (up === 'L' || up === 'N') { out += '\n'; i++; continue; }
            if (up === 'P') { out += '\f'; i++; continue; }
            if (up === 'R') { out += '\r'; i++; continue; }
            if (up === 'T') { out += '\t'; i++; continue; }
            const hex = body.slice(i + 1, i + 3);
            if (/^[0-9A-Fa-f]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 2; continue; }
        }
        out += ch;
    }
    return out;
};
const cEscapeString = (text) => String(text).replace(/[\\"\n\r\t\f\v\0]/g, (ch) => ({
    '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r',
    '\t': '\\t', '\f': '\\f', '\v': '\\v', '\0': '\\0',
}[ch]));
// Strip the surrounding IEC `'…'` (or `"…"`) quotes and decode; null if the
// text is not quoted at all.
const unquoteIecString = (s) => {
    const m = /^'([\s\S]*)'$/.exec(String(s)) || /^"([\s\S]*)"$/.exec(String(s));
    return m ? iecStringDecode(m[1]) : null;
};
// Literal BODY (already unquoted) → C string literal.
const iecStringToC = (body) => '"' + cEscapeString(iecStringDecode(body)) + '"';
// Quoted literal → C string literal, else null.
const quotedStringToC = (s) => {
    const text = unquoteIecString(s);
    return text === null ? null : '"' + cEscapeString(text) + '"';
};
// Any user-entered STRING text (quoted or bare) → C string literal. Quotes a
// user typed around a value are DELIMITERS, never part of it — leaving them in
// produced a path like "'/sys/class/hwmon/hwmon1/'" that could never open.
const anyStringToC = (s) => quotedStringToC(s) ?? iecStringToC(String(s));
const isBooleanLiteral = (value) => /^(?:BOOL#)?(?:TRUE|FALSE)$/i.test(String(value || '').trim());
const normalizeBooleanLiteral = (value) => {
    const normalized = String(value || '').trim().replace(/^BOOL#/i, '').toUpperCase();
    if (normalized === 'TRUE') return 'true';
    if (normalized === 'FALSE') return 'false';
    return null;
};

// ── ST source scanning ──────────────────────────────────────────────────────
// ⚠️ ONE scanner removes comments, and it skips string literals while doing
// it. The regex pair it replaces (`\(\*[\s\S]*?\*\)` then `\/\/.*`) knew
// nothing about quotes, so `s := '(* x *)'` became `s := ''` and
// `u := 'http://a'` lost the rest of its line. Strings honour IEC `$'` / `$"`
// escapes and never span a line (an unterminated quote must not swallow the
// rest of the POU). `(* … *)` NESTS — `(* a (* b *) c *)` is one comment; the
// lazy regex ended it at the first `*)` and leaked ` c *)` into C. `/* … */`
// (IEC 3rd edition) and `// …` are handled too.
//   keepLayout   — a comment becomes spaces (newlines kept), so line/column
//                  numbers stay valid (the validator reports positions);
//                  otherwise a comment becomes one space, or its newlines.
//   blankStrings — string literals become spaces (validator: never flag an
//                  identifier inside text).
//   strTable     — string literals become `\x0e<idx>\x0f` placeholders with the
//                  original text pushed here, so the keyword-normalisation
//                  regexes that run next cannot split `'go THEN stop'`.
const stripIecComments = (code, { keepLayout = false, blankStrings = false, strTable = null } = {}) => {
    const s = String(code || '');
    const n = s.length;
    let out = '';
    let i = 0;
    const dropComment = (text) => {
        if (keepLayout) return text.replace(/[^\n]/g, ' ');
        const nl = (text.match(/\n/g) || []).length;
        return nl ? '\n'.repeat(nl) : ' ';
    };
    while (i < n) {
        const c = s[i];
        const c2 = s[i + 1];
        if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < n && s[j] !== c && s[j] !== '\n') j += (s[j] === '$' && j + 1 < n && s[j + 1] !== '\n') ? 2 : 1;
            const end = (j < n && s[j] === c) ? j + 1 : j;
            const lit = s.slice(i, end);
            if (blankStrings) out += lit.replace(/[^\n]/g, ' ');
            else if (strTable) { strTable.push(lit); out += `\x0e${strTable.length - 1}\x0f`; }
            else out += lit;
            i = end;
            continue;
        }
        if (c === '(' && c2 === '*') {
            let j = i + 2, depth = 1;
            while (j < n && depth > 0) {
                if (s[j] === '(' && s[j + 1] === '*') { depth++; j += 2; }
                else if (s[j] === '*' && s[j + 1] === ')') { depth--; j += 2; }
                else j++;
            }
            out += dropComment(s.slice(i, j));
            i = j;
            continue;
        }
        if (c === '/' && c2 === '*') {
            const close = s.indexOf('*/', i + 2);
            const j = close < 0 ? n : close + 2;
            out += dropComment(s.slice(i, j));
            i = j;
            continue;
        }
        if (c === '/' && c2 === '/') {
            let j = i;
            while (j < n && s[j] !== '\n') j++;
            out += keepLayout ? ' '.repeat(j - i) : '';
            i = j;
            continue;
        }
        out += c;
        i++;
    }
    return out;
};

// ── IEC numeric literals → C ────────────────────────────────────────────────
// `_` is a digit separator everywhere in IEC (`1_000`, `16#FF_FF`), `2#`/`8#`
// are real radixes, and a leading zero is DECIMAL (`010` = ten) while C reads
// it as octal. Returns null for anything that is not a plain numeric literal.
const iecNumberToC = (tok) => {
    const t = String(tok).replace(/_/g, '');
    const r = /^(2|8|10|16)#([0-9A-Fa-f]+)$/.exec(t);
    if (r) {
        const prefix = { 2: '0b', 8: '0o', 10: '', 16: '0x' }[r[1]];
        if (r[1] === '16' && /^[0-9A-Fa-f]+$/.test(r[2])) return '0x' + r[2].toUpperCase();
        try { const v = BigInt(prefix + r[2]); return r[1] === '10' ? v.toString() : '0x' + v.toString(16).toUpperCase(); }
        catch { return null; }
    }
    if (/^\d+$/.test(t)) return t.replace(/^0+(?=\d)/, '');
    if (/^\d+\.\d+(?:[eE][+-]?\d+)?$/.test(t) || /^\d+[eE][+-]?\d+$/.test(t)) return t.replace(/^0+(?=\d)/, '');
    return null;
};

// IEC elementary type → C type, for `TYPE#literal` and conversion casts.
const IEC_SCALAR_C = {
    BOOL: 'bool', BYTE: 'uint8_t', WORD: 'uint16_t', DWORD: 'uint32_t', LWORD: 'uint64_t',
    SINT: 'int8_t', INT: 'int16_t', DINT: 'int32_t', LINT: 'int64_t',
    USINT: 'uint8_t', UINT: 'uint16_t', UDINT: 'uint32_t', ULINT: 'uint64_t',
    REAL: 'float', LREAL: 'double',
};
const IEC_INT_TYPES = new Set(['SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT',
    'BYTE', 'WORD', 'DWORD', 'LWORD']);
const IEC_BIT_WIDTH = {
    BOOL: 1, SINT: 8, USINT: 8, BYTE: 8, INT: 16, UINT: 16, WORD: 16,
    DINT: 32, UDINT: 32, DWORD: 32, LINT: 64, ULINT: 64, LWORD: 64,
};
// Width-aware rotate. ROL/ROR are NOT shifts: the bits pushed out re-enter on
// the other side, so the operand's own width (BYTE 8 … LWORD 64) is part of
// the operation. `(W - n%W) % W` keeps every shift count in [0, W-1] (a shift
// by W is undefined behaviour in C).
const rotateExpr = (dir, x, n, width) => {
    const w = [8, 16, 32, 64].includes(width) ? width : 32;
    const T = `uint${w}_t`;
    const k = `((unsigned)(${n}) % ${w}u)`;
    const back = `((${w}u - ${k}) % ${w}u)`;
    const [a, b] = dir === 'ROL' ? ['<<', '>>'] : ['>>', '<<'];
    return `((${T})(((${T})(${x}) ${a} ${k}) | ((${T})(${x}) ${b} ${back})))`;
};

// ⚠️ A name that is a C keyword (or an object-like macro the generated code
// can see) cannot be a C identifier. Program locals are safe — they are always
// emitted as `prog_<P>_<name>` — but globals, FB locals and FUNCTION
// params/locals are emitted under their own name. The IEC name stays the
// identity everywhere the editor looks (live keys, variables.json, retain
// keys); only the C identifier changes. `S` is here because it is the
// generated code's own PlcState pointer: a FUNCTION parameter named `S`
// shadowed it and broke every `S->` in that body.
const C_RESERVED_NAMES = new Set([
    'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double',
    'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
    'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
    'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
    '_Bool', '_Complex', '_Imaginary', '_Alignas', '_Alignof', '_Atomic', '_Generic',
    '_Noreturn', '_Static_assert', '_Thread_local', 'asm', 'typeof',
    'bool', 'true', 'false', 'NULL', 'errno', 'stdin', 'stdout', 'stderr', 'EOF', 'S',
]);
const cIdent = (name) => {
    const s = String(name ?? '');
    return C_RESERVED_NAMES.has(s) ? `iec_${s}` : s;
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
    'repeat','until','end_repeat','return','exit','continue',
    'true','false','and','or','not','xor','mod',
    'bool','int','uint','dint','udint','lint','ulint',
    'real','lreal','time','string','byte','word','dword','lword',
    'sint','usint','pointer',
    'ton','tof','tp','tonr','ctu','ctd','ctud','sr','rs','r_trig','f_trig',
    'shl','shr','rol','ror','band','bor','bxor','bnot',
    'add','sub','mul','div','abs','sqrt','expt','sin','cos','tan','asin','acos','atan',
    'ln','log','exp','trunc',
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
const ST_CONVERSION_REGEX = /^(?:BOOL|BYTE|WORD|DWORD|LWORD|SINT|USINT|INT|UINT|DINT|UDINT|LINT|ULINT|REAL|LREAL|STRING)_TO_(?:BOOL|BYTE|WORD|DWORD|LWORD|SINT|USINT|INT|UINT|DINT|UDINT|LINT|ULINT|REAL|LREAL|STRING)$/i;

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
    // ⚠️ Must accept every name the ST expression compiler (stExpr.js)
    // accepts, or this pre-build check aborts a build the transpiler would
    // have compiled: user FUNCTION / FB names (`Add2(a, b)`, `F := …` inside
    // F) and enumerated values (`Red`, `Color#Red`) were all "undefined".
    const pouNames = new Set([...(projectStructure?.functions || []), ...(projectStructure?.functionBlocks || [])]
        .map(f => (f.name || '').trim().replace(/\s+/g, '_').toLowerCase()).filter(Boolean));
    const enumValueNames = new Set((projectStructure?.dataTypes || [])
        .filter(dt => dt?.type === 'Enumerated')
        .flatMap(dt => (dt.content?.values || []).map(v => String(v?.name || '').trim().toLowerCase()))
        .filter(Boolean));

    const validateCode = (code, varNames, contextLabel) => {
        // Comments AND string literals become spaces (stripIecComments keeps the
        // layout), so line/column numbers stay valid, a `//` inside a string no
        // longer truncates the line and `(* … *)` inside a string is not a comment.
        const stripped = stripIecComments(code, { keepLayout: true, blankStrings: true });
        const lines = stripped.split('\n');
        // Parenthesis nesting tracked across the whole POU — multi-line FB calls
        // span newlines, so we cannot reset depth per line.
        let depth = 0;
        lines.forEach((rawLine, i) => {
            // Strip (comments and strings are already blanked above):
            //   - typed-radix integer literals (16#FE, 2#1010, 8#777)
            //   - IEC time/date/datetime literals (T#5ms, TIME#1h30m, D#2026-01-01,
            //     DT#2026-01-01-12:00:00, TOD#13:45:00.123)
            // Replace with same-length spaces so column numbers in errors stay accurate.
            const line = rawLine
                .replace(/\b\d+#[0-9A-Fa-f_]+\b/g, m => ' '.repeat(m.length))
                .replace(/\b(?:T|LT|TIME|LTIME|D|DATE|LDATE|DT|LDT|TOD|LTOD)#[A-Za-z0-9_.:\-+]+/gi,
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
                // ':=' (input) or '=>' (output) is a parameter NAME, not a var.
                if (depth > 0 && /^\s*(?::=|=>)/.test(line.slice(regex.lastIndex))) continue;
                if (ST_KEYWORDS_LOWER.has(lower)) continue;
                if (stdLower.has(lower)) continue;
                if (globalVarNames.has(lower)) continue;
                if (dataTypeNames.has(lower)) continue;
                if (hwPortNames.has(lower)) continue;
                if (pouNames.has(lower) || enumValueNames.has(lower)) continue;
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

    // ⚠️ IEC identifiers — type names included — are CASE-INSENSITIVE, C is
    // not: a variable declared `int` became the C keyword `int` (wrong width,
    // no SHM slot) and one declared `ton` named a C type that does not exist.
    // Every declared type is canonicalised ONCE here, on a copy, so the dozens
    // of exact type comparisons below (FB tables, isFBType, mapType, the SHM
    // size table) all see the spelling the tables use. User FB / data-type
    // names win over a standard block of the same name, as they do elsewhere.
    projectStructure = canonicalizeProjectTypes(projectStructure, [
        ...Object.keys(FB_TRIGGER_PIN), ...Object.keys(FB_OUTPUTS), ...Object.keys(FB_INPUTS),
        ...Object.keys(stdFunctions).filter(k => stdFunctions[k].isFB),
        ...(boardId ? Object.keys(getBoardBlockMeta(boardId).triggerPin || {}) : []),
        'AXIS_REF',
    ]);

    const IEC_TYPE_SIZES = {
        'BOOL': 1, 'SINT': 1, 'USINT': 1, 'BYTE': 1,
        'INT': 2, 'UINT': 2, 'WORD': 2,
        'DINT': 4, 'UDINT': 4, 'REAL': 4, 'DWORD': 4,
        'LINT': 8, 'ULINT': 8, 'LREAL': 8, 'LWORD': 8,
        // TIME/LTIME: signed 64-bit MICROseconds (kronstandard.h), so the
        // slot is 8 bytes, naturally aligned like LINT.
        'TIME': 8, 'LTIME': 8,
        // STRING is a `kron_string_t` (char[64]) in PlcState and its slot
        // holds the same TEXT. Fixed width, NUL-padded; see the string branch
        // of plc_shm_sync. ⚠️ Its C ALIGNMENT is 1, not min(size, 8) — the
        // struct/array offset walks below use cAlignOf for that. It stays
        // out of IEC_TYPE_PREFIX (not addressable, so never in the capture
        // ring) and out of IEC_CAST_C / IEC_TO_KRON_TYPE (no X_TO_Y
        // conversion is a C cast, which is meaningless for text).
        'STRING': STRING_SHM_BYTES
    };

    // Shared memory offset tracker — each scalar PLC variable gets its own slot.
    // Data grows from 0, one runtime-owned flag byte per variable from
    // SHM_FORCE_FLAGS_BASE, and the command mailbox owns the top of the segment
    // (SHM layout v2 — server/RING_FORMAT.md § "Variable segment").
    const FORCE_FLAGS_BASE = SHM_FORCE_FLAGS_BASE;
    let shmOffset = 0;
    const shmEntries = []; // {c_symbol, offset, size, flagOffset, isString} → plc_shm_sync()
    const tryAssignShm = (type, c_symbol) => {
        const size = IEC_TYPE_SIZES[type?.toUpperCase()];
        if (!size) return {}; // FB, user-defined type or unknown — no SHM slot
        // ⚠️ NATURAL alignment (a = min(size, 8)). Packed slots put an LREAL at
        // an odd offset, where neither the runtime nor KronServer can copy it
        // in one atomic access — a reader could see half of the old double and
        // half of the new one (and armv7 cannot even do a 64-bit atomic at an
        // unaligned address). Offsets travel in the variable table, so every
        // consumer follows automatically.
        const align = Math.min(size, 8);
        const offset = (shmOffset + align - 1) & ~(align - 1);
        const flagOffset = FORCE_FLAGS_BASE + shmEntries.length;
        // Data region must stay below the force-flag region, and the flag region
        // below the mailbox — otherwise the generated copies silently corrupt
        // neighbouring variables / the command mailbox.
        if (offset + size > FORCE_FLAGS_BASE) {
            throw new Error(`Too many/too large variables for shared memory: data region exceeds ${FORCE_FLAGS_BASE} bytes at variable "${c_symbol}". Reduce the number/size of monitored variables (e.g. large arrays).`);
        }
        if (flagOffset >= SHM_MAILBOX_BASE) {
            throw new Error(`Too many variables for shared memory: force-flag region reaches the command mailbox at ${SHM_MAILBOX_BASE} at variable "${c_symbol}". Reduce the number of monitored variables.`);
        }
        shmOffset = offset + size;
        // The flag rides on the ENTRY, not a closure: generateMainLoop emits a
        // second copy of these functions from the same array and would
        // otherwise have no way to tell text from a number.
        shmEntries.push({ c_symbol, offset, size, flagOffset, isString: isStringInputType(type) });
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
            // A typed literal (`INT#5`) and `_` digit separators (`1_000`) must
            // seed the same number the C initialiser (formatVarInitial) does.
            const s = String(val).trim().replace(/^(?!L?T#|L?TIME#)[A-Za-z]+#(?=[-+]?\d)/i, '');
            if (T === 'BOOL') {
                const b = s.toLowerCase();
                return b === 'true' || b === '1';
            }
            if (T === 'STRING' || T === 'WSTRING') return unquoteIecString(s) ?? iecStringDecode(s);
            if (isTimeTypeName(T) && isTimeLiteral(s)) return mapIECtoTimeUs(s);
            const radix = s.match(/^(\d+)#([0-9A-Fa-f_]+)$/);
            if (radix) {
                const n = parseInt(radix[2].replace(/_/g, ''), parseInt(radix[1], 10));
                return Number.isFinite(n) ? n : 0;
            }
            if (/^-?0x[0-9A-Fa-f]+$/i.test(s)) return parseInt(s, 16);
            const num = Number(/^[-+]?\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?$/.test(s) ? s.replace(/_/g, '') : s);
            return Number.isFinite(num) ? num : 0;
        }
        if (T === 'BOOL') return false;
        if (T === 'STRING' || T === 'WSTRING') return "";
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

    // --- ETHERCAT DIAGNOSTIC-FB GATE ---
    // ⚠️ Every EC_* block is emitted as `EC_x_Call(&inst, &__ec_cfg)`, but
    // __ec_cfg only exists when the project HAS an EtherCAT bus (it is part of
    // generateEtherCATConfig's output). A project that used one and then
    // dropped the bus — or a rung pasted in from another project — produced
    // `use of undeclared identifier '__ec_cfg'` from clang, pointing at
    // generated C the user never wrote. Caught here with the real cause.
    if (!ecCfgEarly.headerExtern) {
        const ecBlockUsers = [];
        const scanForEcFbs = (vars, scope) => (vars || []).forEach(v => {
            if (EC_FB_CFG_PARAM.has((v.type || '').trim())) ecBlockUsers.push(`  • ${scope}.${v.name || '(unnamed)'} : ${v.type}`);
        });
        scanForEcFbs(config?.content?.globalVars, 'GLOBAL');
        (projectStructure.programs || []).forEach(p => scanForEcFbs(p.content?.variables, p.name || '(unnamed program)'));
        (projectStructure.functionBlocks || []).forEach(fb => scanForEcFbs(fb.content?.variables, fb.name || '(unnamed FB)'));
        if (ecBlockUsers.length > 0) {
            throw new Error(
                `EtherCAT diagnostic block${ecBlockUsers.length > 1 ? 's' : ''} used without an EtherCAT bus (${ecBlockUsers.length}):\n` +
                `${ecBlockUsers.join('\n')}\n` +
                `EC_* blocks read the master configuration, so the project needs an EtherCAT bus ` +
                `(right-click the project tree → add bus), or remove these blocks.`
            );
        }
    }

    // --- AXIS_REF GATE ---
    // ⚠️ Enabling "Axis" on a slave makes the transpiler emit
    // `AXIS_REF_Init(&S->Axis1, …)`, but the AXIS_REF itself is a USER global
    // (src/services/CLAUDE.md: the declaration comes from the variable table so programs can write
    // Axis1.Set.Position). Forget the global and clang reports
    // `no member named 'Axis1' in 'struct PlcState'` against generated code —
    // a message that says nothing about the actual mistake.
    const declaredAxisRefs = new Set(
        (config?.content?.globalVars || [])
            .filter(v => (v.type || '').trim().toUpperCase() === 'AXIS_REF')
            .map(v => (v.name || '').trim().toLowerCase())
    );
    const missingAxisRefs = (ecCfgEarly.axisNames || [])
        .filter(n => !declaredAxisRefs.has(n.toLowerCase()));
    if (missingAxisRefs.length > 0) {
        throw new Error(
            `Axis enabled on ${missingAxisRefs.length} EtherCAT slave${missingAxisRefs.length > 1 ? 's' : ''} ` +
            `without the matching AXIS_REF global variable:\n` +
            missingAxisRefs.map(n => `  • ${n} : AXIS_REF`).join('\n') +
            `\nAdd each one as a GLOBAL variable of type AXIS_REF (Resource editor), ` +
            `or turn the Axis tab off on that slave.`
        );
    }

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
        if (ecPdoCanon((v.name || '').trim())) return; // EtherCAT-owned, no SHM slot
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
/* IEC '/' and MOD. An INTEGER divide by zero (and INT_MIN / -1) raises SIGFPE
 * on x86_64 and kills the runtime, so the integer form yields 0 instead; the
 * divisor is evaluated once. A floating divide keeps IEEE semantics (inf/nan).
 * _Generic picks the branch from the type of the result, so this is right
 * whatever the operand types turn out to be. */
#ifndef KRON_IDIV
#define __KRON_DIV_BAD(d) ((d) == 0 || (((__typeof__(d))-1 < 0) && (d) == (__typeof__(d))-1))
#define KRON_IDIV(a, b) ({ __typeof__(b) __kd = (b); _Generic((a) / __kd, \\
    float: (a) / __kd, double: (a) / __kd, long double: (a) / __kd, \\
    default: (__KRON_DIV_BAD(__kd) ? (__kd == 0 ? 0 : -(a)) : (a) / __kd)); })
#define KRON_IMOD(a, b) ({ __typeof__(b) __kd = (b); __KRON_DIV_BAD(__kd) ? 0 : (a) % __kd; })
#endif
/* REAL -> integer conversion ROUNDS (IEC 61131-3), it does not truncate as a C
 * cast does; an integer argument passes through unchanged. */
#ifndef KRON_RND
#define KRON_RND(x) _Generic((x), float: (int64_t)llrintf((float)(x)), \\
    double: (int64_t)llrint((double)(x)), long double: (int64_t)llrintl((long double)(x)), \\
    default: (int64_t)(x))
#endif
/* IEC NOT/AND/OR/XOR on operands whose IEC type the transpiler could not see
 * (an AXIS_REF member, a pin no table describes): logical on a C bool,
 * bitwise on anything else — decided by the C type at compile time. */
#ifndef KRON_NOT_U
#define KRON_NOT_U(x)    _Generic((x), bool: !(x), default: ~(x))
#define KRON_AND_U(a, b) _Generic((a), bool: (a) && (b), default: (a) & (b))
#define KRON_OR_U(a, b)  _Generic((a), bool: (a) || (b), default: (a) | (b))
#define KRON_XOR_U(a, b) _Generic((a), bool: (bool)(a) != (bool)(b), default: (a) ^ (b))
#endif
/* IEC STRING: a fixed array holding the TEXT (value semantics), never a
 * pointer — so it can be retained, survives a hot-swap and \`a := b\` copies.
 * Every assignment to STRING storage goes through KRON_STRSET: a bounded copy
 * that always NUL-terminates, zero-fills the rest (the retain image and the
 * shared-memory slot stay deterministic) and, when it truncates, never splits
 * a UTF-8 sequence. memmove, so \`s := s\` is harmless. The _Generic refuses
 * at COMPILE time any target that is not a kron_string_t (e.g. a standard
 * block's \`const char *\` pin) instead of writing through it. */
#ifndef KRON_STRING_LEN
#define KRON_STRING_LEN ${STRING_SHM_BYTES}
typedef char kron_string_t[KRON_STRING_LEN];
static inline void __kron_strset(char *dst, size_t cap, const char *src)
{
    size_t n = 0;
    if (!src) src = "";
    while (n + 1 < cap && src[n]) n++;
    if (n + 1 == cap && src[n])
        while (n > 0 && ((unsigned char)src[n] & 0xC0u) == 0x80u) n--;
    memmove(dst, src, n);
    memset(dst + n, 0, cap - n);
}
#define KRON_STRSET(d, s) __kron_strset(_Generic(&(d), kron_string_t *: (d)), KRON_STRING_LEN, (s))
#endif

${boardDefines}${runtimePortHelpers}${customIncludes}#if defined(KRON_SYS_TEXT_LEN)
_Static_assert(KRON_SYS_TEXT_LEN == KRON_STRING_LEN, "kronsystem.h KRON_SYS_TEXT_LEN must equal the transpiler's STRING size");
#endif
${ecCfgEarly.motionIncludes ? ecCfgEarly.motionIncludes + '\n' : ''}${ecCfgEarly.axisLockMacros || '#define KRON_AXIS_LOCK()   ((void)0)\n#define KRON_AXIS_UNLOCK() ((void)0)\n'}extern volatile uint64_t us_tick;

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
    // ⚠️ LEGACY per-channel HAL blocks (`I2C0_Read`, `SPI1_Transfer`, …): the
    // Toolbox replaced them with the generic COMM_PROTO_BLOCKS, so the board
    // meta above no longer lists them, yet kronhal.h still typedefs them and
    // saved projects still carry them. Unregistered, the LD emitter never set
    // EN (the _Call silently did nothing) and read power flow from a `.Q` the
    // HAL struct does not have — a compile error. Register them as the EN/ENO
    // blocks they are, from the pin list each saved block carries.
    for (const cat of ['programs', 'functionBlocks', 'functions']) {
        for (const pou of projectStructure[cat] || []) {
            for (const rung of pou.content?.rungs || []) {
                for (const b of rung.blocks || []) {
                    const t = b.type;
                    if (!t || t in FB_TRIGGER_PIN || !/^(?:I2C|SPI|UART|USB|CAN|ADC|PWM)\d+_[A-Za-z]+$/.test(t)) continue;
                    const cd = b.data?.customData;
                    if (!cd || !Array.isArray(cd.inputs) || !Array.isArray(cd.outputs)) continue;
                    FB_TRIGGER_PIN[t] = 'EN'; _halSavedKeys.triggerPin.push(t); HAL_BLOCK_TYPES.add(t);
                    FB_Q_OUTPUT[t] = 'ENO'; _halSavedKeys.qOutput.push(t);
                    FB_INPUTS[t] = cd.inputs.map(p => p.name).filter(n => n !== 'EN'); _halSavedKeys.inputs.push(t);
                    FB_OUTPUTS[t] = ['ENO', ...cd.outputs.map(p => p.name).filter(n => n !== 'ENO')]; _halSavedKeys.outputs.push(t);
                    FB_INPUT_TYPES[t] = Object.fromEntries(cd.inputs.map(p => [p.name, p.type])); _halSavedKeys.inputTypes.push(t);
                }
            }
        }
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
    // `offset` = byte offset inside the real AXIS_REF C struct (kron_axis.h) on the
    // LOCAL-SIM target (x86_64: 8-byte pointers/doubles, 4-byte enums, natural
    // alignment) — used by the sim's /proc/<pid>/mem reader (base_symbol + byte_offset).
    // ⚠️ The axis engine works in DOUBLE (LREAL), not REAL: a float position
    // accumulator drifts visibly on a long-travel axis. Typing one of these REAL
    // would read 4 bytes of a double and show garbage.
    // ⚠️ Re-verify with offsetof() after ANY edit to AXIS_REF — the struct was
    // relaid out wholesale when kron_nc.c was replaced by kron_axis.c.
    const AXIS_REF_DEBUG_FIELDS = [
        { name: 'AxisNo',            type: 'UINT',  offset: 0 },
        { name: 'Simulation',        type: 'BOOL',  offset: 16 },
        { name: 'MaxVelocity',       type: 'LREAL', offset: 24 },
        { name: 'MaxAcceleration',   type: 'LREAL', offset: 32 },
        { name: 'MaxDeceleration',   type: 'LREAL', offset: 40 },
        { name: 'MaxJerk',           type: 'LREAL', offset: 48 },
        { name: 'SwLimitNegative',   type: 'LREAL', offset: 56 },
        { name: 'SwLimitPositive',   type: 'LREAL', offset: 64 },
        { name: 'MaxPositionLag',    type: 'LREAL', offset: 80 },
        { name: 'InPositionWindow',  type: 'LREAL', offset: 88 },
        { name: 'InVelocityWindow',  type: 'LREAL', offset: 96 },
        { name: 'VelFactor',         type: 'LREAL', offset: 104 },
        { name: 'AccFactor',         type: 'LREAL', offset: 112 },
        { name: 'JerkFactor',        type: 'LREAL', offset: 120 },
        { name: 'GearRatio',         type: 'LREAL', offset: 128 },
        { name: 'PositionOffset',    type: 'LREAL', offset: 144 },
        { name: 'ActualPosition',    type: 'LREAL', offset: 152 },
        { name: 'ActualVelocity',    type: 'LREAL', offset: 160 },
        { name: 'ActualTorque',      type: 'LREAL', offset: 168 },
        // Set = MotionState (Position, Velocity, Acceleration) — the trajectory
        // core's answer for this cycle, i.e. what is actually sent to the drive.
        // ⚠️ The name IS the C member path — it becomes the SHM slot's c_symbol
        // (`S->Axis1.Set.Position`), so a flattened `SetPosition` would not compile.
        { name: 'Set.Position',      type: 'LREAL', offset: 176 },
        { name: 'Set.Velocity',      type: 'LREAL', offset: 184 },
        { name: 'Set.Acceleration',  type: 'LREAL', offset: 192 },
        { name: 'SetJerk',           type: 'LREAL', offset: 200 },
        { name: 'BrakeDistance',     type: 'LREAL', offset: 208 },
        { name: 'CommandedPosition', type: 'LREAL', offset: 216 },
        { name: 'CommandedVelocity', type: 'LREAL', offset: 224 },
        // MC_AXIS_STATE is a 4-byte enum — UDINT, not UINT.
        { name: 'State',             type: 'UDINT', offset: 264 },
        { name: 'PowerEnabled',      type: 'BOOL',  offset: 268 },
        { name: 'PowerStatus',       type: 'BOOL',  offset: 271 },
        { name: 'IsHomed',           type: 'BOOL',  offset: 272 },
        { name: 'AxisWarning',       type: 'BOOL',  offset: 273 },
        { name: 'AxisError',         type: 'BOOL',  offset: 274 },
        { name: 'AxisErrorID',       type: 'UINT',  offset: 276 },
        { name: 'drv_StatusWord',    type: 'UINT',  offset: 278 },
        { name: 'drv_ControlWord',   type: 'UINT',  offset: 280 },
        { name: 'StopActive',        type: 'BOOL',  offset: 344 },
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
    // C alignment of a scalar IEC type: its width up to 8, except a STRING,
    // which is a char array (alignment 1) — treating it as 8-aligned shifted
    // every member after a STRING in a UDT by up to 7 bytes.
    const cAlignOf = (type, size) => (isStringInputType(type) ? 1 : Math.min(Math.max(size, 1), 8));
    const structMemberOffsets = (members) => {
        let off = 0;
        return (members || []).map(member => {
            const size = IEC_TYPE_SIZES[member.type?.toUpperCase()] || 0;
            const align = cAlignOf(member.type, size);
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
            if (ecPdoCanon((v.name || '').trim())) {
                variableTable.globalVars[v.name] = { type: v.type, initialValue: gInitVal };
                return;
            }
            const isUserType = !!dataTypeDefs[v.type];
            // C identifier of the field; the IEC name stays the live key.
            const gC = cIdent(v.name);
            const gIsFB = isFBType(v.type, projectStructure) || !!stdFunctions[v.type]?.isFB
                || HAL_BLOCK_TYPES.has(v.type) || (v.type in FB_TRIGGER_PIN && !isInlineMathType(v.type));
            const initLine = (isUserType || gIsFB) ? '' : initAssignStmt(`S->${gC}`, v.initialValue, v.type);
            stateFields.push(`${mapType(v.type)} ${gC};`);
            if (initLine) stateInits.push(initLine);
            if (gIsFB) stateInits.push(...fbInstanceInitLines(v.type, `S->${gC}`, v.initialValue, projectStructure));
            const gRetain = isRetainVar(v);
            // Globals are keyed by bare name — the same identity the ST/LD code
            // uses, so renaming a PROGRAM never orphans a retained global.
            if (gRetain) retainEntries.push({ key: v.name, field: gC });
            variableTable.globalVars[v.name] = { type: v.type, initialValue: gInitVal, ...(gRetain ? { retain: true } : {}) };
            // Debug: top-level entry (scalar types get a SHM slot)
            const gShmSlot = !isUserType ? tryAssignShm(v.type, gC) : {};
            variableTable.debugDefaults[`prog__${v.name}`] = {
                type: v.type, c_symbol: gC, defaultValue: gInitVal, address: v.address || '', ...gShmSlot,
                ...(gRetain ? { retain: true } : {})
            };
            // Debug: expand array elements and struct members for monitoring
            const dtDef = dataTypeDefs[v.type];
            if (dtDef?.type === 'Array') {
                const { baseType, elements } = expandArrayElements(dtDef);
                elements.forEach(({ suffix, offset }) => {
                    const elemCSym = `${gC}${suffix}`;
                    const elemShmSlot = tryAssignShm(baseType, elemCSym);
                    variableTable.debugDefaults[`prog__${v.name}${suffix}`] = {
                        type: baseType, c_symbol: elemCSym,
                        base_symbol: gC, byte_offset: offset,
                        defaultValue: isStringInputType(baseType) ? '' : 0, address: v.address || '', ...elemShmSlot
                    };
                });
            } else if (dtDef?.type === 'Structure') {
                structMemberOffsets(dtDef.content.members).forEach(({ member, offset }) => {
                    const memCSym = `${gC}.${cIdent(member.name)}`;
                    const memShmSlot = tryAssignShm(member.type, memCSym);
                    variableTable.debugDefaults[`prog__${v.name}.${member.name}`] = {
                        type: member.type, c_symbol: memCSym,
                        base_symbol: gC, byte_offset: offset,
                        defaultValue: isStringInputType(member.type) ? '' : 0, address: v.address || '', ...memShmSlot
                    };
                });
            } else if (v.type === 'AXIS_REF') {
                AXIS_REF_DEBUG_FIELDS.forEach(field => {
                    const memCSym = `${gC}.${field.name}`;
                    const memShmSlot = tryAssignShm(field.type, memCSym);
                    variableTable.debugDefaults[`prog__${v.name}.${field.name}`] = {
                        type: field.type, c_symbol: memCSym,
                        base_symbol: gC, byte_offset: field.offset,
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
                header += `    ${mapType(v.type)} ${cIdent((v.name || '').trim().replace(/\s+/g, '_'))};\n`;
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
            const retType = fnReturnCType(fn.returnType || 'VOID');
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
                    // FB-local initial values (recursively, FB-in-FB) plus the
                    // instance's own `(PT := T#1s)` initialiser. Without this a
                    // user FB declaring `cnt : INT := 100` started at 0.
                    stateInits.push(...fbInstanceInitLines(vType, `S->prog_${progName}_inst_${vName}`, v.initialValue, projectStructure));
                } else {
                    // Program-local variables — emit initial value when the user
                    // provided one in the Variable Manager. Without this, scalar
                    // POU vars default to 0 even if Variable Manager shows e.g.
                    // `state := 90` or `pca_dev_addr := 16#40`, which silently
                    // breaks state machines that rely on a non-zero start state.
                    const isUserType = !!dataTypeDefs[vType];
                    const initLine = isUserType ? '' : initAssignStmt(`S->prog_${progName}_${vName}`, v.initialValue, vType);
                    stateFields.push(`${mapType(vType)} prog_${progName}_${vName};`);
                    if (initLine) stateInits.push(initLine);
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
                                defaultValue: isStringInputType(baseType) ? '' : 0, address: v.address || '', ...elemShmSlot
                            };
                        });
                    } else if (dtDef?.type === 'Structure') {
                        structMemberOffsets(dtDef.content.members).forEach(({ member, offset }) => {
                            const memCSym = `${cSym}.${cIdent(member.name)}`;
                            const memShmSlot = tryAssignShm(member.type, memCSym);
                            variableTable.debugDefaults[`prog_${progName}_${vName}.${member.name}`] = {
                                type: member.type, c_symbol: memCSym,
                                base_symbol: cSym, byte_offset: offset,
                                defaultValue: isStringInputType(member.type) ? '' : 0, address: v.address || '', ...memShmSlot
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
                // An ALIASED shadow (x_TO_STRING) names a field that already
                // exists — declaring it again would be a duplicate member.
                const cSym = sv.aliasOf || sv.symbol;
                if (!sv.aliasOf) stateFields.push(`${mapType(sv.type)} ${sv.symbol};`);
                const shortKey = sv.symbol.replace(`prog_${progName}_`, '');
                const svDefault = sv.type === 'STRING' ? '' : 0;
                variableTable.programs[progName].variables[shortKey] = {
                    type: sv.type,
                    c_symbol: cSym,
                    initialValue: svDefault
                };
                const svShmSlot = tryAssignShm(sv.type, cSym);
                // ⚠️ Flagged so the editor can tell a pin shadow (pure debug
                // mirror of an FB/block pin, NOT program state) from a real
                // variable without guessing from the `in_`/`out_` name shape.
                variableTable.debugDefaults[`prog_${progName}_${shortKey}`] = {
                    type: sv.type,
                    c_symbol: cSym,
                    defaultValue: svDefault,
                    isPinShadow: true,
                    pinDir: 'out',
                    ...svShmSlot
                };
            });

            // Text buffers for x_TO_STRING call sites in this program.
            collectStringConvBuffers(prog, progName).forEach(sym => {
                stateFields.push(`${STRING_C_TYPE} ${sym};`);
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
                    isPinShadow: true,
                    pinDir: 'in',
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
    // Forced values live HERE, in PlcState, at the same offset as the
    // variable's data slot — not in the slot itself (see shmPullLine for the
    // race that rules the slot out). PlcState is host-owned under hot-swap, so
    // a force survives a logic swap; only the mailbox consumer writes it.
    if (shmEntries.length > 0) {
        stateFields.push(`_Alignas(8) uint8_t __plc_fv[${Math.max(8, Math.ceil(shmOffset / 8) * 8)}];`);
    }
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
        'STRING': 'string',
        // KronServer has no duration type: TIME/LTIME travel as the signed
        // 64-bit count of microseconds they are.
        'TIME': 'int64', 'LTIME': 'int64',
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
        source += `#define PLC_SHM_SIZE ${SHM_TOTAL_SIZE}\n`;
        source += `static void plc_mb_init(void);\n`;
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
        source += `    plc_mb_init();\n`;
        source += `}\n`;
        source += `#else\n`;
        // NOTE (macOS): this non-hot-swap branch is dead code there — the plain
        // sim is refused on darwin (runtime.go) and macOS is never a deploy
        // target, so nothing ever runs it. It still has to COMPILE, which
        // shm_open does. The mirror macOS actually uses is the file-backed one
        // the loader-host creates (hotswaphost/host.c, __APPLE__ branch).
        source += `static void plc_shm_init(void) {\n`;
        // 0660 (not 0666) matches what KronServer's NewIPCManager and the
        // capture-ring segment already open this with, so nothing on target
        // changes — it just stops publishing every live variable to any other
        // local account on a shared machine.
        source += `    int fd = shm_open(PLC_SHM_NAME, O_CREAT | O_RDWR, 0660);\n`;
        source += `    if (fd < 0) return;\n`;
        source += `    ftruncate(fd, PLC_SHM_SIZE);\n`;
        source += `    __plc_shm = (uint8_t *)mmap(NULL, PLC_SHM_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);\n`;
        source += `    if (__plc_shm == MAP_FAILED) __plc_shm = NULL;\n`;
        source += `    close(fd);\n`;
        source += `    plc_mb_init();\n`;
        source += `}\n`;
        source += `#endif\n`;
        source += `#endif\n`;
        source += generateShmMailbox(shmEntries);
        source += `static void plc_shm_pull(void) {\n`;
        source += `    if (!__plc_shm) return;\n`;
        source += `    plc_mb_consume();\n`;
        shmEntries.forEach(e => { source += shmPullLine(e); });
        source += `}\n`;
        source += `static void plc_shm_sync(void) {\n`;
        source += `    if (!__plc_shm) return;\n`;
        shmEntries.forEach(e => { source += shmSyncLine(e); });
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
        deviceArtifacts.initCode
            + (ecCfg.masterInitCode
                ? `#ifndef PLC_HOTSWAP\n${ecCfg.masterInitCode}#endif /* !PLC_HOTSWAP — the loader-host calls __hs_ec_start() */\n`
                : '')
            + (ecCfg.axisInitCode || ''),
        (ecCfg.cleanupCode
            ? `#ifndef PLC_HOTSWAP\n${ecCfg.cleanupCode}#endif /* !PLC_HOTSWAP — __hs_ec_stop() closes the bus */\n`
            : '') + deviceArtifacts.cleanupCode,
        ecCfg.pdoReadCode,
        ecCfg.pdoWriteCode,
        ecCfg.ecThreadCode      || '',
        ecCfg.ecThreadStartCode || '',
        ecCfg.ecThreadJoinCode  || '',
        !!ecCfg.halContent,         // gpiMutexEnabled: true when IO_Bus thread owns the bus
        shmEntries,
        plcStateLayoutHash,
        addressedRingVars,
        retainEntries.length > 0,
        ecCfg.axisNames || []
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
    // SHM layout v2 descriptor for the force-write writers (KronServer and the
    // host agent). A table WITHOUT it was built for the v1 runtime; the writers
    // also verify the mailbox magic/version in the segment itself, so a table
    // and a runtime from different builds cannot silently disagree.
    // max_task_interval_us sizes the writer's ack timeout.
    if (shmEntries.length > 0) {
        variableTable.shm_layout = {
            version: SHM_LAYOUT_VERSION,
            size: SHM_TOTAL_SIZE,
            force_flags_base: SHM_FORCE_FLAGS_BASE,
            mailbox_offset: SHM_MAILBOX_BASE,
            mailbox_capacity: SHM_MAILBOX_CAP,
            nvars: shmEntries.length,
            max_task_interval_us: mainLoop.programTasks.reduce((m, pt) => Math.max(m, pt.intervalUs || 0), 0),
        };
    }
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
    // PLC_HOST_GLUE) keeps the real names to wrap them. The EtherCAT master is
    // host-owned the same way (hostGlueEc); only the MOTION/axis side still
    // needs a cold restart.
    const halVoidFns = ['KRON_UART_RuntimeInit', 'KRON_UART_RuntimeCleanup'];
    if (boardId) halVoidFns.push('HAL_Init', 'HAL_Cleanup');
    const halCallFns = [...usedHalBlocks].map(t => `${t}_Call`);
    // The EtherCAT master is host-owned under hot-swap too (generateEtherCATConfig),
    // so a board-less EtherCAT project still needs a host_glue.c.
    const ecGlue = ecCfgEarly.hostGlueEc || '';
    let halDefines = '';
    let hostGlue = '';
    if (halCallFns.length > 0 || boardId || ecGlue) {
        halDefines += `\n#if defined(PLC_HOTSWAP) && !defined(PLC_HOST_GLUE)\n`;
        halDefines += `/* hot-swap: HAL runs in the loader-host; the logic.so calls these trampolines so device fds survive a swap */\n`;
        halVoidFns.forEach(f => { halDefines += `extern void __hs_${f}(void);\n#define ${f} __hs_${f}\n`; });
        halCallFns.forEach(f => { halDefines += `extern void __hs_${f}(void*);\n#define ${f} __hs_${f}\n`; });
        halDefines += `#endif\n`;
        if (halCallFns.length === 0 && !boardId) halDefines = '';   // EC-only project: nothing to redirect

        const tramp = [
            ...halVoidFns.map(f => `void __hs_${f}(void) { ${f}(); }`),
            ...halCallFns.map(f => `void __hs_${f}(void *i) { ${f}(i); }`),
        ].join('\n');
        hostGlue =
            `// Autogenerated host-glue — HAL trampolines for hot-swap (HAL state stays in the host).\n` +
            `#include <stdint.h>\n#include <stdbool.h>\n#include <string.h>\n#include <stdlib.h>\n#include <math.h>\n` +
            `${boardDefines}${runtimePortHelpers}${customIncludes}` +
            `extern volatile uint64_t us_tick;\n\n` +
            `${tramp}\n` +
            ecGlue;
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

const IEC_ELEMENTARY_TYPES = new Set([
    ...Object.keys(IEC_SCALAR_C), 'TIME', 'LTIME', 'STRING', 'WSTRING', 'POINTER', 'VOID',
    'DATE', 'TOD', 'DT', 'TIME_OF_DAY', 'DATE_AND_TIME',
]);
// See the call site in transpileToC. Returns a shallow copy with every
// declared type (variables, FUNCTION return types, UDT members / base types)
// spelled the way the transpiler's tables spell it. Unknown names are kept.
const canonicalizeProjectTypes = (ps, standardTypeNames = []) => {
    if (!ps) return ps;
    const canon = new Map();
    standardTypeNames.forEach(n => { if (n) canon.set(String(n).toLowerCase(), String(n)); });
    [...(ps.functionBlocks || []), ...(ps.functions || []), ...(ps.dataTypes || [])].forEach(d => {
        const n = (d?.name || '').trim();
        if (n) canon.set(n.toLowerCase(), n);
    });
    const canonType = (t) => {
        if (typeof t !== 'string') return t;
        const raw = t.trim();
        if (!raw) return t;
        const up = raw.toUpperCase();
        if (IEC_ELEMENTARY_TYPES.has(up)) return up;
        return canon.get(raw.toLowerCase()) || t;
    };
    const canonVars = (vars) => Array.isArray(vars)
        ? vars.map(v => (v && typeof v.type === 'string') ? { ...v, type: canonType(v.type) } : v)
        : vars;
    const canonPou = (p) => {
        if (!p) return p;
        const out = { ...p };
        if (p.returnType) out.returnType = canonType(p.returnType);
        if (p.content?.variables) out.content = { ...p.content, variables: canonVars(p.content.variables) };
        return out;
    };
    const canonDt = (dt) => {
        if (!dt?.content) return dt;
        const c = { ...dt.content };
        if (Array.isArray(c.members)) c.members = canonVars(c.members);
        if (c.baseType) c.baseType = canonType(c.baseType);
        return { ...dt, content: c };
    };
    return {
        ...ps,
        programs: (ps.programs || []).map(canonPou),
        functionBlocks: (ps.functionBlocks || []).map(canonPou),
        functions: (ps.functions || []).map(canonPou),
        dataTypes: (ps.dataTypes || []).map(canonDt),
        resources: (ps.resources || []).map(r => (r?.content?.globalVars
            ? { ...r, content: { ...r.content, globalVars: canonVars(r.content.globalVars) } }
            : r)),
    };
};

// One cold-init statement for the field at C path `cPath`, or '' when the
// variable has no initial value. A STRING is COPIED into its own array
// (KRON_STRSET) — never pointed at the literal, which under hot-swap lives in
// the .rodata of a module that a later swap dlclose()s.
const initAssignStmt = (cPath, raw, type) => {
    const init = formatVarInitial(raw, type);
    if (!init) return '';
    return isStringInputType(type)
        ? `${kronStrset(cPath, init.replace(/^ = /, ''))};`
        : `${cPath}${init};`;
};

// Cold-init lines for one FB instance at C path `cPath` (`S->prog_P_inst_t1`,
// `S->g`, or a nested member). A user FB contributes its locals' declared
// initial values — recursively, so an FB inside an FB is initialised too — and
// the instance's own IEC initialiser `(PT := T#1s, …)` is applied last, as an
// override. Both used to be dropped: plc_state_init only knew scalars, so
// `cnt : INT := 100` inside an FB started at 0.
const fbInstanceInitLines = (type, cPath, instInit, ps, depth = 0) => {
    if (depth > 16) throw new Error(`FB instance nesting too deep at "${cPath}" (recursive FB type "${type}"?).`);
    const t = String(type || '').trim();
    const fb = (ps?.functionBlocks || []).find(f => (f.name || '').trim().replace(/\s+/g, '_') === t.replace(/\s+/g, '_'));
    const isFbTypeName = (tn) => {
        const x = String(tn || '').trim();
        return (ps?.functionBlocks || []).some(f => (f.name || '').trim() === x)
            || (x in FB_TRIGGER_PIN && !isInlineMathType(x));
    };
    const lines = [];
    const members = {};
    if (fb) {
        (fb.content?.variables || []).forEach(v => {
            const vn = (v.name || '').trim().replace(/\s+/g, '_');
            if (!vn || isInlineMathType(v.type)) return;
            members[vn.toLowerCase()] = { name: vn, type: v.type };
            const member = `${cPath}.${cIdent(vn)}`;
            if (isFbTypeName(v.type)) {
                lines.push(...fbInstanceInitLines(v.type, member, v.initialValue, ps, depth + 1));
            } else if (!(ps?.dataTypes || []).some(dt => dt.name === v.type)) {
                const line = initAssignStmt(member, v.initialValue, v.type);
                if (line) lines.push(line);
            }
        });
    }
    const raw = String(instInit ?? '').trim();
    if (!raw) return lines;
    const m = /^\(([\s\S]*)\)$/.exec(raw);
    if (!m) {
        throw new Error(`Initial value "${raw}" of "${cPath.replace(/^S->(?:prog_.*?_inst_)?/, '')}" (${t}) must be a ` +
            `parenthesised list of pin assignments, e.g. (PT := T#1s).`);
    }
    splitTopLevelArgs(m[1]).forEach(a => {
        const mm = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([\s\S]+)$/.exec(a);
        if (!mm) throw new Error(`Instance initialiser "${raw}" (${t}): "${a}" is not a "Name := value" pair.`);
        let field, fieldType;
        if (fb) {
            const mem = members[mm[1].toLowerCase()];
            if (!mem) throw new Error(`Instance initialiser "${raw}": ${t} has no variable "${mm[1]}".`);
            field = cIdent(mem.name);
            fieldType = mem.type;
        } else {
            const pin = canonicalPinName(t, mm[1]);
            const known = (FB_INPUTS[t] || []).includes(pin) || (FB_OUTPUTS[t] || []).includes(pin)
                || FB_INPUT_TYPES[t]?.[pin] !== undefined || FB_TRIGGER_PIN[t] === pin;
            if (!known) throw new Error(`Instance initialiser "${raw}": ${t} has no pin "${mm[1]}".`);
            field = cStructPin(t, pin);
            fieldType = FB_INPUT_TYPES[t]?.[pin] || (pin === FB_TRIGGER_PIN[t] ? 'BOOL' : getOutputPinType(t, pin, null));
        }
        // ⚠️ A standard block's STRING pin (Read_Sys_File.PATH, …) is a
        // `const char *`, not storage. Set once here it would point into the
        // .rodata of the module that ran plc_state_init — dangling after the
        // first hot-swap — so it must be given on the CALL, where it is
        // re-assigned every scan.
        if (!fb && isStringInputType(fieldType)) {
            throw new Error(`Instance initialiser "${raw}" (${t}): STRING pin ${mm[1]} cannot be set here — ` +
                `give it on the block/call instead (it is re-assigned every scan there).`);
        }
        const line = initAssignStmt(`${cPath}.${field}`, mm[2].trim(), fieldType);
        if (line) lines.push(line);
    });
    return lines;
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
// ⚠️ TIME (and LTIME, the same type) is a SIGNED 64-bit count of
// MICROseconds end to end (kronstandard.h), so negative durations (T#-5s) are
// legal. The bound enforced here is the tighter of the int64 range and JS's
// exact-integer range: a literal is summed as a JS number, and beyond 2^53 µs
// (~285 years) the sum would silently round, so the emitted C would not be
// the value written. Refused instead, naming the literal.
const TIME_US_LIMIT = Number.MAX_SAFE_INTEGER; // 2^53 - 1 µs, well inside int64
const checkTimeRange = (us, raw) => {
    if (!Number.isFinite(us) || Math.abs(us) > TIME_US_LIMIT) {
        throw new Error(
            `TIME value "${raw}" is out of range: TIME is a signed 64-bit count of microseconds, ` +
            `and a literal must stay within +/- ${TIME_US_LIMIT} µs (about 285 years) to be exact.`);
    }
    // -0 → 0, so the emitted C never reads "-0".
    return us === 0 ? 0 : us;
};
const TIME_PREFIX_RE = /^(?:LTIME|TIME|LT|T)#/i;
const isTimeLiteral = (s) => TIME_PREFIX_RE.test(String(s ?? '').trim());
const isTimeTypeName = (t) => /^L?TIME$/i.test(String(t ?? '').trim());
// A TASK interval is not a TIME value: it reaches the runtime through the
// `unsigned long plc_task_interval_us()` ABI (32-bit on armv7) and must be
// positive, so it keeps the old 1 µs .. 0xFFFFFFFF µs (~71.6 min) window even
// though TIME itself is now 64-bit and signed.
const TASK_INTERVAL_US_MAX = 0xFFFFFFFF;
const mapTaskIntervalUs = (iecTimeStr) => {
    const us = mapIECtoTimeUs(iecTimeStr);
    if (!(us >= 1) || us > TASK_INTERVAL_US_MAX) {
        throw new Error(
            `Task interval "${iecTimeStr}" = ${us} µs is out of range: a task interval must be ` +
            `between 1 µs and T#71m34s967ms295us.`);
    }
    return us;
};
const mapIECtoTimeUs = (iecTimeStr) => {
    if (iecTimeStr === undefined || iecTimeStr === null || String(iecTimeStr).trim() === '') return 10000;
    const raw = String(iecTimeStr).trim();
    let str = raw.toUpperCase().replace(TIME_PREFIX_RE, '').replace(/_/g, '');
    if (!str) return 10000;
    // IEC allows a sign on the whole duration: T#-5s, T#-1m30s.
    let sign = 1;
    if (str[0] === '-' || str[0] === '+') {
        if (str[0] === '-') sign = -1;
        str = str.slice(1);
        if (!str) throw new Error(`Invalid TIME literal "${raw}" — expected forms like T#500ms, T#-5s, T#1h2m3s500ms.`);
    }
    // Bare number (no unit) — historically accepted in pin fields as µs.
    if (/^\d+(?:\.\d+)?$/.test(str)) return checkTimeRange(sign * Math.round(parseFloat(str)), raw);
    // Unit order matters: MS before M, US/NS before S.
    const re = /(\d+(?:\.\d+)?)(MS|US|NS|D|H|M|S)/y;
    let total = 0;
    let idx = 0;
    while (idx < str.length) {
        re.lastIndex = idx;
        const m = re.exec(str);
        if (!m) {
            throw new Error(`Invalid TIME literal "${raw}" — expected forms like T#500ms, T#-5s, T#1h2m3s500ms.`);
        }
        total += parseFloat(m[1]) * TIME_UNIT_US[m[2]];
        idx = re.lastIndex;
    }
    return checkTimeRange(sign * Math.round(total), raw);
};

// formatVarInitial — turn a Variable Manager `initialValue` field into a C
// initialiser fragment (`= ...`). Without this normalisation the raw IEC
// text would land in plc.h verbatim and break the build:
//   BOOL  : `True` / `TRUE` / `1`     →  ` = true`        (C `bool`)
//   TIME  : `T#300ms` / `LTIME#-1s`   →  ` = 300000` / ` = -1000000` (int64 µs, matches the ST expression compiler)
//   INT…  : `16#40` / `2#1010`        →  ` = 0x40` / ` = 0b1010`
//   STRING: `hello`                    →  ` = "hello"`
// Empty/undefined returns '' so the caller can append nothing.
const formatVarInitial = (raw, type) => {
    if (raw === undefined || raw === null || raw === '') return '';
    const T = String(type || '').toUpperCase();
    if (T === 'STRING' || T === 'WSTRING') return ` = ${anyStringToC(String(raw))}`;
    if (T === 'BOOL') {
        const b = String(raw).trim().toLowerCase();
        return ` = ${(b === 'true' || b === '1') ? 'true' : 'false'}`;
    }
    if (isTimeTypeName(T)) {
        const s = String(raw).trim();
        if (isTimeLiteral(s)) return ` = ${mapIECtoTimeUs(s)}`;
        const neg = /^-/.test(s);
        const n = iecNumberToC(s.replace(/^[-+]/, ''));
        if (n !== null && /^\d+$/.test(n)) return ` = ${checkTimeRange((neg ? -1 : 1) * Number(n), s)}`;
        return ` = ${s}`;
    }
    // Numeric — accept C decimal/hex (`64`, `0x40`) or IEC typed-radix
    // (`16#40`, `2#1010`) and translate the latter to C syntax. A typed
    // literal (`INT#5`) drops its prefix, and `_` separators (`1_000`) go.
    const rawStr = String(raw).trim().replace(/^[A-Za-z]+#(?=[-+]?\d)/, '');
    const asNum = /^[-+]/.test(rawStr) ? iecNumberToC(rawStr.slice(1)) : iecNumberToC(rawStr);
    if (asNum !== null) return ` = ${rawStr[0] === '-' ? '-' : ''}${asNum}`;
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
// ⚠️ Mirrors the #defines in resources/krontek-include/kronethercatmaster.h.
// Raising one there without raising it here (or vice versa) either rejects a
// valid project or writes past the end of a fixed array in generated C.
const KRON_EC_MAX_PDO    = 256;
const KRON_EC_MAX_SDO    = 64;
const KRON_EC_MAX_SLAVES = 64;

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

// CiA402 object sizes, for validating hand-entered SDO Init rows.
//
// ⚠️ An SDO written with the WRONG LENGTH is rejected by the drive with an abort
// ("data type does not match"), and the failure chain that follows explains
// nothing: PreOP→SafeOP fails, the bus never reaches OP, the slave reports state
// 0x00 and the recovery loop runs forever — while the editor shows a perfectly
// healthy project. Observed with 0x6060 (Modes of Operation, INT8) written as
// 2 bytes: the SDO editor's size is a free <select> that defaults to 2.
//
// Only the standard, fixed-width objects are listed. A vendor object is not
// checked, and this WARNS rather than throwing: an unusual drive may genuinely
// deviate, and refusing to build would be worse than saying so.
export const CIA402_SDO_SIZES = {
    0x6040: 2,  // Controlword                 UINT16
    0x6041: 2,  // Statusword                  UINT16
    0x605A: 2,  // Quick stop option code      INT16
    0x6060: 1,  // Modes of operation          INT8
    0x6061: 1,  // Modes of operation display  INT8
    0x6064: 4,  // Position actual value       INT32
    0x606C: 4,  // Velocity actual value       INT32
    0x6071: 2,  // Target torque               INT16
    0x6077: 2,  // Torque actual value         INT16
    0x607A: 4,  // Target position             INT32
    0x6080: 4,  // Max motor speed             UINT32
    0x6081: 4,  // Profile velocity            UINT32
    0x6083: 4,  // Profile acceleration        UINT32
    0x6084: 4,  // Profile deceleration        UINT32
    0x6098: 1,  // Homing method               INT8
    0x60FF: 4,  // Target velocity             INT32
    0x60F4: 4,  // Following error actual      INT32
};

/** Byte width of an SDO Init object, from the authoritative source available.
 *
 * ⚠️ The width is NOT the user's to choose — it belongs to the object. The SDO
 * editor used to offer a free 1/2/4 select defaulting to 2, and a mis-sized
 * write is ABORTED by the drive with a failure chain that names nothing (see
 * CIA402_SDO_SIZES). The slave's own ESI declares every object's BitLen, so
 * that wins; the CiA402 table covers objects the ESI does not expose through a
 * PDO; only a genuinely unknown vendor object keeps whatever was stored.
 */
export const resolveSdoByteSize = (slave, index, subindex = 0, stored = 1) => {
    const idx = (index || 0) >>> 0;
    const sub = (subindex || 0) & 0xFF;
    for (const pdo of (slave?.pdos || [])) {
        for (const e of (pdo.entries || [])) {
            if (((e.index || 0) >>> 0) === idx && ((e.subindex || 0) & 0xFF) === sub && e.bitLen > 0) {
                return { size: Math.max(1, Math.ceil(e.bitLen / 8)), source: 'ESI', dtype: e.dtype || '' };
            }
        }
    }
    if (CIA402_SDO_SIZES[idx]) return { size: CIA402_SDO_SIZES[idx], source: 'CiA402', dtype: '' };
    return { size: Math.min(4, Math.max(1, parseInt(stored) || 1)), source: 'stored', dtype: '' };
};

const generateEtherCATConfig = (buses, busConfigs, globalSimMode = false) => {
    const ecBuses = (buses || []).filter(b => b.type === 'ethercat' && busConfigs?.[b.id]);
    if (ecBuses.length === 0) return {
        headerDecl: '', headerExtern: '', gpiMacros: '', motionIncludes: '', cleanupCode: '',
        masterInitCode: '', axisInitCode: '', hostGlueEc: '',
        pdoReadCode: '', pdoWriteCode: '',
        ecThreadCode: '', ecThreadStartCode: '', ecThreadJoinCode: '',
        halContent: '', gpiVarNames: []
    };

    // Only the first EtherCAT bus is used for now
    const cfg = busConfigs[ecBuses[0].id] || {};
    const slaves = cfg.slaves || [];

    let initCode = `\n    /* ── EtherCAT Master ── */\n`;
    initCode += `    memset(&__ec_cfg, 0, sizeof(__ec_cfg));\n`;
    // ⚠️ The SIMULATION build runs on the developer's PC, whose NIC is virtually
    // never named like the target's (enp3s0 / enx… vs eth0), so the bus config
    // carries a SEPARATE ifnameSim. Empty → fall back to the target's ifname.
    const ecIfname = ((globalSimMode ? (cfg.ifnameSim || cfg.ifname) : cfg.ifname) || 'eth0');
    initCode += `    strncpy(__ec_cfg.ifname, ${JSON.stringify(ecIfname.slice(0, 63))}, sizeof(__ec_cfg.ifname) - 1);\n`;
    initCode += `    __ec_cfg.cycle_us = ${Math.max(100, parseInt(cfg.cycle_us) || 1000)}U;\n`;
    initCode += `    __ec_cfg.dc_enable = ${cfg.dc_enable ? 'true' : 'false'};\n`;
    if (slaves.length > KRON_EC_MAX_SLAVES) {
        throw new Error(
            `EtherCAT bus has ${slaves.length} slaves but KRON_EC_MAX_SLAVES is ${KRON_EC_MAX_SLAVES} ` +
            `(kronethercatmaster.h). The generated code would write past the end of __ec_cfg.slaves.`
        );
    }
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

    // ⚠️ PDO variable names come from utils/ecNaming — the SAME function the
    // Slave editor uses when it declares the matching globals. This used to be
    // a private running counter here and another one in the editor, over
    // different scopes, so any collision made the two disagree: the editor
    // declared `ec_X_Status` while this emitted `ec_X_Status_2`, and the global
    // then got a real PlcState/SHM slot instead of the GPI macro — a variable
    // that read a constant zero with nothing reporting a problem.
    const ecNameMap = buildEcVarNames(slaves);

    // ⚠️ Hard gate, same class as the IEC-address and array-bounds throws: a
    // selection the slave will reject (one CoE object mapped through two
    // alternative PDOs, two mutually exclusive PDOs assigned together, two
    // entries collapsing onto one variable name) must not become a runtime
    // that quietly never reaches OP. The editor blocks this at entry; a
    // hand-edited project file or an older project still arrives here.
    const ecIssues = findEcIssues(slaves).filter(i => i.level === 'error');
    if (ecIssues.length > 0) {
        throw new Error(
            `Invalid EtherCAT PDO mapping (${ecIssues.length}):\n` +
            ecIssues.map(i => `  • ${i.message}`).join('\n') +
            `\nFix the PDO Mapping tab of the affected slave.`
        );
    }

    slaves.forEach((slave, si) => {
        const safeName = (slave.name || `Slave_${si + 1}`).replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 63);
        initCode += `\n    /* Slave ${si}: ${safeName} */\n`;
        initCode += `    __ec_cfg.slaves[${si}].position     = ${Math.max(1, parseInt(slave.position) || (si + 1))};\n`;
        initCode += `    __ec_cfg.slaves[${si}].vendor_id    = 0x${((slave.vendorId || 0) >>> 0).toString(16).toUpperCase().padStart(8, '0')}UL;\n`;
        initCode += `    __ec_cfg.slaves[${si}].product_code = 0x${((slave.productCode || 0) >>> 0).toString(16).toUpperCase().padStart(8, '0')}UL;\n`;
        initCode += `    strncpy(__ec_cfg.slaves[${si}].name, "${safeName}", sizeof(__ec_cfg.slaves[${si}].name) - 1);\n`;

        let pdoCount = 0;
        (slave.pdos || []).forEach((pdo, pi) => {
            (pdo.entries || []).forEach((entry, ei) => {
                if (!entry.selected) return;
                const varName = ecNameMap.get(`${si}|${pi}|${ei}`)?.name;
                if (!varName) return;
                // ⚠️ pdo_entries is a fixed KRON_EC_MAX_PDO array in
                // kronethercatmaster.h; without this the generated C writes
                // past its end, which clang accepts as a warning and the
                // runtime turns into memory corruption on the first cycle.
                if (pdoCount >= KRON_EC_MAX_PDO) {
                    throw new Error(
                        `EtherCAT slave "${slave.name || `Slave_${si + 1}`}" has more than ` +
                        `${KRON_EC_MAX_PDO} selected PDO entries — raise KRON_EC_MAX_PDO in ` +
                        `kronethercatmaster.h or deselect some entries.`
                    );
                }
                usedVarNames.add(varName);
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

        // ⚠️ The PDO-mapping SDOs must run BEFORE the user's own startup SDOs
        // (a drive's 0x6060 Modes of Operation is written into a mapping that
        // has to exist first), and the total must not silently fall off the end
        // of the fixed sdo_inits array — the old `.slice(0, 64)` dropped the
        // USER's commands first, since they were appended last, and said
        // nothing about it.
        // ⚠️ The emitted width comes from resolveSdoByteSize, NOT from whatever the
        // project stored: a project saved before the size became authoritative
        // still carries the old free-select value, and the resulting SDO abort
        // costs an afternoon to trace. Corrections are reported, never silent.
        const userSdos = (slave.sdos || []).map(sdo => {
            const stored = Math.min(4, Math.max(1, parseInt(sdo.byteSize) || 1));
            const { size, source, dtype } = resolveSdoByteSize(slave, sdo.index, sdo.subindex, stored);
            if (size !== stored) {
                console.warn(
                    `[transpiler] SDO Init 0x${((sdo.index || 0) >>> 0).toString(16).toUpperCase().padStart(4, '0')}:` +
                    `${(sdo.subindex || 0) & 0xFF} on slave "${slave.name || `Slave_${si + 1}`}" was stored as ${stored} ` +
                    `byte(s); emitting ${size} as declared by ${source}${dtype ? ` (${dtype})` : ''}. A mis-sized SDO is ` +
                    `aborted by the drive and the bus never reaches OP.`);
            }
            return { ...sdo, byteSize: size };
        });
        const allSdos = [...pdoMapSdos, ...userSdos];
        if (allSdos.length > KRON_EC_MAX_SDO) {
            throw new Error(
                `EtherCAT slave "${slave.name || `Slave_${si + 1}`}" needs ${allSdos.length} startup SDOs ` +
                `(${pdoMapSdos.length} generated for the PDO mapping + ${userSdos.length} of your own) but ` +
                `KRON_EC_MAX_SDO is ${KRON_EC_MAX_SDO}. Reduce the selected PDO entries or the SDO Init list.`
            );
        }
        allSdos.forEach((sdo, di) => {
            const sidx = (sdo.index || 0) >>> 0;
            initCode += `    __ec_cfg.slaves[${si}].sdo_inits[${di}].index     = 0x${sidx.toString(16).toUpperCase().padStart(4, '0')};\n`;
            initCode += `    __ec_cfg.slaves[${si}].sdo_inits[${di}].subindex  = ${(sdo.subindex || 0) & 0xFF};\n`;
            initCode += `    __ec_cfg.slaves[${si}].sdo_inits[${di}].value     = 0x${((sdo.value || 0) >>> 0).toString(16).toUpperCase().padStart(8, '0')}UL;\n`;
            initCode += `    __ec_cfg.slaves[${si}].sdo_inits[${di}].byte_size = ${Math.min(4, Math.max(1, parseInt(sdo.byteSize) || 1))};\n`;   // resolveSdoByteSize for user rows; generated PDO-mapping SDOs carry their own
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
    // ⚠️ On Linux an INPUT resolves through the per-scan snapshot (one consistent
    // bus image for the whole scan) while an OUTPUT resolves to the single
    // __gpi_out image. Routing outputs through the snapshot too meant writing
    // into a buffer the IO_Bus thread was about to recycle — see plc_task_IO_Bus.
    const linuxMacroLines    = [
        ...uniqueInputVars.map(v  => `#define ${v.varName.padEnd(36)} (__gpi_snap->_pi_${v.varName})`),
        ...uniqueOutputVars.map(v => `#define ${v.varName.padEnd(36)} (__gpi_out._pi_${v.varName})`),
    ].join('\n');
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
extern _Thread_local KRON_Process_Image *__gpi_snap; /* per-scan INPUT snapshot       */
extern KRON_Process_Image            __gpi_out;     /* logic OUTPUTS \u2014 single image */
#else /* bare-metal / Windows: single buffer */
/* \u2500\u2500 Single-buffer fallback \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
extern KRON_Process_Image __gpi;
#define __gpi_hw  __gpi  /* var_ptr targets the single buffer on non-Linux */
#define __gpi_out __gpi  /* no IO_Bus thread here \u2014 nothing to decouple      */
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

    // Helper: emit a float literal that always has a decimal point (C99 requires it).
    // KRON_SERVO_SLOT's scaling fields are float; AXIS_REF's are double — hence
    // the second helper. An `f`-suffixed literal assigned to a double silently
    // rounds the value to single precision first.
    const floatLit = (n) => {
        const f = parseFloat(n);
        return Number.isInteger(f) ? `${f}.0f` : `${f}f`;
    };
    const dblLit = (n) => {
        const f = parseFloat(n);
        return Number.isInteger(f) ? `${f}.0` : `${f}`;
    };
    const optNum = (v) => { const f = parseFloat(v); return Number.isFinite(f) ? f : null; };

    const hasAxes = axisSlaves.length > 0;

    // Generate GPI↔KRON_SERVO_SLOT bridge code for the IO Bus thread.
    // ncReadBridge : after kron_ec_pdo_read  — copy GPI inputs  → Kron_PI.servo[n]
    // ncWriteBridge: before kron_ec_pdo_write — copy Kron_PI.servo[n] → GPI outputs
    // ⚠️ These bridges are ALL the IO_Bus thread does for motion now. The axis
    // engine itself (KronAxis_ReadInput/WriteOutput) runs in the LOGIC task next
    // to the MC_* FBs — see generateMainLoop's axisPhase*. kron_axis.c replaced
    // the old cmd_Seq/sts_AckSeq handshake with a plain request-pointer queue
    // (AXIS_REF.Active/Buffer[]), which has NO cross-thread protection at all,
    // so running the engine here again would race every KronAxis_Submit.
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

    const axisNamesOf = () => axisSlaves.map(({ slave }) =>
        (slave.axisRef.name || `Axis_${slave.position}`).replace(/[^A-Za-z0-9_]/g, '_'));

    let axisInitCode = '';
    if (hasAxes) {
        // ⚠️ Under hot-swap the bus thread is already running when PLC_Init
        // executes this (host.c calls __hs_ec_start() BEFORE plc_init_hs()), so
        // the init of an axis the engine is polling must be atomic against it.
        axisInitCode += `\n    /* ── Motion Axes ── */\n    KRON_AXIS_LOCK();\n    memset(&Kron_PI, 0, sizeof(Kron_PI));\n`;
        // ⚠️ An axis is simulated when the ETHERCAT MASTER is stubbed, never
        // because this is "a simulation build". The local sim drives a real bus
        // on Linux (KRON_EC_SIM was dropped from the hot-swap build, host-agent/CLAUDE.md), so
        // tying AXIS_REF.Simulation to the transpiler's simMode left the bus
        // real and every axis fake: KronAxis_WriteOutput takes its
        // `slot == NULL || Simulation || !present` branch, which mirrors
        // PowerStatus = PowerEnabled and never writes a CiA402 control word —
        // MC_Power reported Status = TRUE while the drive stayed disabled.
        // KRON_EC_SIM is defined by exactly the builds whose master is a no-op
        // (Windows/macOS, or a host without a real libsoem.a — see
        // host-agent/hotswap.go ecSimFlag and compile.go's plain sim), so it is
        // the one condition under which a faked axis is the right answer.
        axisInitCode += `#ifdef KRON_EC_SIM\n    const bool __kron_bus_sim = true;   /* EtherCAT master is a stub */\n#else\n    const bool __kron_bus_sim = false;  /* real SOEM master on this build */\n#endif\n`;
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
            // The slave's own Simulation checkbox still forces a fake axis outright;
            // otherwise the decision is the C-level one above.
            const sim     = slave.axisRef.simMode ? 'true'  : '__kron_bus_sim';
            const present = slave.axisRef.simMode ? 'false' : '!__kron_bus_sim';
            // AXIS_REF_Init zeroes the struct and sets AxisNo, slot, VelFactor=1, AccFactor=1.
            // The AXIS_REF global is a PlcState field (hot-swap refactor), so it is
            // reached via S-> — this init code lands in PLC_Init (plc.c), where the
            // file-scope S from plc.h is in scope.
            axisInitCode += `    AXIS_REF_Init(&S->${axisName}, ${axisNo}, &Kron_PI.servo[${axisNo}]);\n`;
            const encTypeMap = { incremental: 'KRON_ENC_INCREMENTAL', absolute_st: 'KRON_ENC_ABSOLUTE_ST', absolute_mt: 'KRON_ENC_ABSOLUTE_MT' };
            const encType = encTypeMap[slave.axisRef.encoderType] || 'KRON_ENC_INCREMENTAL';
            axisInitCode += `    S->${axisName}.Simulation        = ${sim};\n`;
            axisInitCode += `    S->${axisName}.GearRatio         = ${dblLit(gRatio)};\n`;
            axisInitCode += `    S->${axisName}.EncoderType       = ${encType};\n`;
            // Axis limits & windows. AXIS_REF_Init already installs usable
            // defaults (overrides 1.0, windows non-zero), so ONLY fields the
            // user actually configured are emitted — writing 0 for a blank
            // field would disable the limit or make InPositionWindow so tight
            // that no move ever reports Done.
            const axisLimitFields = [
                ['maxVelocity',      'MaxVelocity'],
                ['maxAcceleration',  'MaxAcceleration'],
                ['maxDeceleration',  'MaxDeceleration'],
                ['maxJerk',          'MaxJerk'],
                ['maxPositionLag',   'MaxPositionLag'],
                ['inPositionWindow', 'InPositionWindow'],
                ['inVelocityWindow', 'InVelocityWindow'],
            ];
            axisLimitFields.forEach(([cfgKey, cField]) => {
                const n = optNum(slave.axisRef[cfgKey]);
                if (n !== null && n > 0) axisInitCode += `    S->${axisName}.${cField}${' '.repeat(Math.max(1, 18 - cField.length))}= ${dblLit(n)};\n`;
            });
            // Software position limits are a PAIR with an explicit enable: a
            // limit of 0.0 is a legitimate coordinate, so the enable flag —
            // never "is it non-zero" — decides whether the axis honours it.
            if (slave.axisRef.enableLimitNegative) {
                axisInitCode += `    S->${axisName}.SwLimitNegative   = ${dblLit(optNum(slave.axisRef.swLimitNegative) ?? 0)};\n`;
                axisInitCode += `    S->${axisName}.EnableLimitNegative = true;\n`;
            }
            if (slave.axisRef.enableLimitPositive) {
                axisInitCode += `    S->${axisName}.SwLimitPositive   = ${dblLit(optNum(slave.axisRef.swLimitPositive) ?? 0)};\n`;
                axisInitCode += `    S->${axisName}.EnableLimitPositive = true;\n`;
            }
            if (slave.axisRef.enablePosLagMonitoring) {
                axisInitCode += `    S->${axisName}.EnablePosLagMonitoring = true;\n`;
            }
            // Scaling factors on the servo slot (set after AXIS_REF_Init so slot is valid)
            axisInitCode += `    Kron_PI.servo[${axisNo}].counts_per_unit   = ${floatLit(cpu)};\n`;
            axisInitCode += `    Kron_PI.servo[${axisNo}].vel_raw_per_unit  = ${floatLit(vpu)};\n`;
            axisInitCode += `    Kron_PI.servo[${axisNo}].encoder_type        = ${encType};\n`;
            axisInitCode += `    Kron_PI.servo[${axisNo}].enc_single_turn_bits = ${stBits}u;\n`;
            if (slave.axisRef.encoderType === 'absolute_mt') {
                axisInitCode += `    Kron_PI.servo[${axisNo}].enc_multi_turn_bits  = ${parseInt(slave.axisRef.multiTurnBits) || 12}u;\n`;
            }
            axisInitCode += `    Kron_PI.servo[${axisNo}].present           = ${present};\n`;
        });
        axisInitCode += `    KRON_AXIS_UNLOCK();\n`;
    }

    // ── Motion: the axis engine runs in the BUS thread, at the BUS cycle ────
    // ⚠️ dt MUST equal the rate the engine is really called at — the trajectory
    // core integrates exactly one dt per call, so "which thread" and "what dt"
    // are ONE decision. It used to run in the logic task with dt = that task's
    // interval; measured against the real library, a 10 ms dt made a
    // jerk-limited move hunt around the target for ever (40 set-velocity sign
    // flips, ±31 500 counts, Done never set, DiscreteMotion never left) while
    // the same move at the 500 µs bus cycle lands in a single approach. The
    // cycle comes from the BUS THAT CARRIES THE AXIS, so a second fieldbus
    // later brings its own instead of inheriting a scan rate it knows nothing
    // about.
    const axisDtSec = (Math.max(100, parseInt(cfg.cycle_us) || 1000) / 1e6).toFixed(9);
    // The lock must exist before the bus thread does. initCode is the master
    // init: it runs in PLC_Init for a single-binary build and inside
    // __hs_ec_start() for hot-swap — both before any pthread_create and before
    // axisInitCode touches an axis.
    if (hasAxes) initCode += `    __kron_axis_mu_init();\n`;

    // ⚠️ ONE lock guards every axis, and EVERY entry point takes it.
    // KronAxis_Submit stores a POINTER to a request living inside the FB
    // instance into AXIS_REF.Active/Buffer[] with no synchronisation of its own
    // — kron_axis.c dropped the old cmd_Seq/sts_AckSeq handshake and the
    // archive is prebuilt, so the interlock has to be added around it: the
    // engine step below, and every MC_*_Call emitted into a logic task. It also
    // covers the READ side (AXIS_REF.ActualPosition & co. are 8-byte doubles
    // that armv7 cannot load atomically, so an unlocked FB read could tear).
    // PRIO_INHERIT because the holder is usually a logic task while the waiter
    // is the SCHED_FIFO bus thread.
    const axisLockMacros = hasAxes
        ? `#if defined(__linux__)\n` +
          `#include <pthread.h>\n` +
          `extern pthread_mutex_t __kron_axis_mu;\n` +
          `void __kron_axis_mu_init(void);\n` +
          `#define KRON_AXIS_LOCK()   pthread_mutex_lock(&__kron_axis_mu)\n` +
          `#define KRON_AXIS_UNLOCK() pthread_mutex_unlock(&__kron_axis_mu)\n` +
          `#else\n` +
          `#define KRON_AXIS_LOCK()   ((void)0)\n` +
          `#define KRON_AXIS_UNLOCK() ((void)0)\n` +
          `#endif\n`
        : '';
    const axisMuDef = hasAxes
        ? `pthread_mutex_t __kron_axis_mu;\n` +
          `void __kron_axis_mu_init(void) {\n` +
          `    pthread_mutexattr_t __a;\n` +
          `    pthread_mutexattr_init(&__a);\n` +
          `    pthread_mutexattr_setprotocol(&__a, PTHREAD_PRIO_INHERIT);\n` +
          `    pthread_mutex_init(&__kron_axis_mu, &__a);\n` +
          `    pthread_mutexattr_destroy(&__a);\n` +
          `}\n`
        : '';
    // Two definitions of the same step, because the bus thread body is emitted
    // into BOTH plc.c (single binary, PlcState reachable through the file-scope
    // S) and host_glue.c (hot-swap, where the thread lives in the loader-host
    // and PlcState is only reachable through the pointers plc_axis_ptr hands
    // over at bind time). The thread body itself stays byte-identical.
    const axisStepDefPlc = hasAxes
        ? `\n/* One axis-engine scan, run by the IO_Bus thread at the bus cycle. */\n` +
          `static inline void __kron_axis_step(void) {\n` +
          `    KRON_AXIS_LOCK();\n` +
          axisNamesOf().map(a =>
          `    KronAxis_ReadInput(&S->${a});\n` +
          `    KronAxis_WriteOutput(&S->${a}, ${axisDtSec});\n`).join('') +
          `    KRON_AXIS_UNLOCK();\n}\n`
        : '';
    const axisStepDefHost = hasAxes
        ? `\nAXIS_REF *__hs_axis[${axisSlaves.length}] = {0};\n` +
          `/* Called by the loader-host after every bind — the axis lives in PlcState,\n` +
          ` * whose field offsets only the generated module knows. */\n` +
          `void __hs_axis_bind(void *(*getptr)(int)) {\n` +
          `    KRON_AXIS_LOCK();\n` +
          `    for (int __i = 0; __i < ${axisSlaves.length}; __i++) __hs_axis[__i] = (AXIS_REF*)getptr(__i);\n` +
          `    KRON_AXIS_UNLOCK();\n}\n` +
          `/* One axis-engine scan, run by the IO_Bus thread at the bus cycle. */\n` +
          `static inline void __kron_axis_step(void) {\n` +
          `    KRON_AXIS_LOCK();\n` +
          axisSlaves.map((_, i) =>
          `    if (__hs_axis[${i}]) { KronAxis_ReadInput(__hs_axis[${i}]); KronAxis_WriteOutput(__hs_axis[${i}], ${axisDtSec}); }\n`).join('') +
          `    KRON_AXIS_UNLOCK();\n}\n`
        : '';
    // ⚠️ axisInitCode is deliberately NOT appended to initCode: the master init
    // moves into the loader-host under hot-swap (see hostGlueEc below) while the
    // axis init must stay in PLC_Init — it writes S->‹axis›, i.e. PlcState.

    // headerDecl: definitions in plc.c
    // __gpi_snap is initialised to NULL; generateMainLoop sets it via
    // atomic_load_explicit at the top of every logic task's scan loop,
    // so it is always valid before any POU macro dereferences it.
    // ⚠️ plc.c must NOT define Kron_PI / Kron_HAL — `kron_pi.c` (→ libkron_pi.a)
    // owns both definitions so a build without a generated plc.c still links,
    // and defining them here too is a hard `multiple definition of 'Kron_PI'`
    // at link time. kron_pi.h declares them extern; motionIncludes pulls it in.
    // ⚠️ Kron_HAL therefore stays NULL: the fieldbus exchange is done by the
    // IO_Bus thread below (kron_ec_pdo_read/write + the servo bridges), so the
    // generated code calls KronAxis_ReadInput/WriteOutput per axis and NEVER
    // KronMotion_ReadInputs/WriteOutputs — those wrappers go through this
    // pointer and would do nothing.
    const kronPIDecl = '';
    const ncStubs = '';
    // ⚠️ Under PLC_HOTSWAP on Linux these objects are DEFINED BY THE LOADER-HOST
    // (host_glue.c, see hostGlueEc) and only declared here — SOEM's socket and
    // the process image must outlive a dlclose. __gpi_snap stays in the logic
    // module: it is thread-local and re-snapped from __gpi on every scan.
    const gpiDefs =
`KRON_Process_Image            __gpi_hw;\n` +
`KRON_Process_Image            __gpi_buf[2];\n` +
`KRON_Process_Image            __gpi_out;\n` +
`_Atomic(KRON_Process_Image *) __gpi = &__gpi_buf[0];\n`;
    const headerDecl =
`\n#if defined(__linux__)\n` +
`#if defined(PLC_HOTSWAP)\n` +
`extern KRON_Process_Image            __gpi_hw;\n` +
`extern KRON_Process_Image            __gpi_buf[2];\n` +
`extern KRON_Process_Image            __gpi_out;\n` +
`extern _Atomic(KRON_Process_Image *) __gpi;\n` +
`extern KRON_EC_Config                __ec_cfg;\n` +
`#else\n` +
gpiDefs +
`KRON_EC_Config __ec_cfg;\n` +
axisMuDef +
`#endif\n` +
`_Thread_local KRON_Process_Image *__gpi_snap = NULL;\n` +
`#else\n` +
`KRON_Process_Image __gpi;\n` +
`KRON_EC_Config __ec_cfg;\n` +
`#endif\n` +
kronPIDecl +
ncStubs;

    // motionIncludes: injected EARLY in plc.h (before global vars) so AXIS_REF type
    // is defined by the time the global variable `AXIS_REF Axis1;` is emitted.
    const motionIncludes = hasAxes
        ? `#include "kron_pi.h"\n#include "kronmotion.h"\nextern KRON_PROCESS_IMAGE Kron_PI;\n`
        : '';

    // headerExtern: injected into plc.h in the EtherCAT HAL section (after global vars).
    // Does NOT repeat motion includes — they are in motionIncludes (injected earlier).
    const headerExtern =
`\n#include "kron_hal.h"\n` +
`extern KRON_EC_Config __ec_cfg;\n` +
'';

    // Member-wise copies for the IO_Bus cycle (see the comment in its body).
    const gpiOutCopyIn = uniqueOutputVars.length
        ? uniqueOutputVars.map(v => `        __gpi_hw._pi_${v.varName} = __gpi_out._pi_${v.varName};\n`).join('')
        : '        /* no RxPDO entries */\n';
    const gpiInCopyBack = uniqueInputVars.length
        ? uniqueInputVars.map(v => `        back->_pi_${v.varName} = __gpi_hw._pi_${v.varName};\n`).join('')
        : '        (void)back;\n';

    // SDO background thread + watchdog thread + IO_Bus thread (Linux only)
    // The bus threads are emitted TWICE from this one body: into plc.c for the
    // single-binary build, and into host_glue.c for hot-swap (where they must
    // live in the host, since a swap unloads the logic module under them).
    const ecThreadBody = `
/* plc_stop is DEFINED further down (generateMainLoop emits it with the scan
 * loop), so this block — emitted before it — needs the extern. In a hot-swap
 * build the loader-host owns and exports it. */
extern volatile int plc_stop;
static void* __ec_sdo_thread(void *arg) {
    (void)arg;
    while (!plc_stop) {
        kron_ec_process_sdo(&__ec_cfg);
        struct timespec __ts = { 0, 100000L }; /* 100 \u00b5s */
        nanosleep(&__ts, NULL);
    }
    return NULL;
}
/* Bus watchdog.
 *
 * \u26a0\ufe0f BACKS OFF instead of hammering. kron_ec_check_state() runs the
 * recovery path, and a bus that CANNOT come up (rather than one that blipped)
 * made this retry 10x a second forever: the log filled with an endless
 * "not OP / recovery failed" pair, and the library's recovery eventually
 * re-enters its own init and dies with a double free, taking the runtime with
 * it. A transient drop recovers on the first or second try, so backing off
 * costs nothing real and turns an unrecoverable bus into ONE actionable line
 * instead of a crash.
 *
 * The advice is deliberately generic: a bus that never reaches OP with DC
 * enabled, on any drive, is the single most common cause, and the fastest test
 * a user can run is to turn DC off. */
static void* __ec_watchdog_thread(void *arg) {
    (void)arg;
    long __wd_delay_ms = 100;          /* healthy poll rate */
    int  __wd_fail = 0, __wd_told = 0;
    while (!plc_stop) {
        kron_ec_check_state(&__ec_cfg);
        if (__ec_cfg.is_operational) {
            if (__wd_fail > 0) fprintf(stderr, "[plc] EtherCAT bus back in OP after %d failed attempt(s)\\n", __wd_fail);
            __wd_fail = 0; __wd_told = 0; __wd_delay_ms = 100;
        } else {
            __wd_fail++;
            /* 100ms -> 200 -> 400 ... capped at 30s. */
            if (__wd_delay_ms < 30000) __wd_delay_ms *= 2;
            if (__wd_fail == 5 && !__wd_told) {
                __wd_told = 1;
                fprintf(stderr,
                    "[plc] EtherCAT bus is not in OP after %d recovery attempts - backing off to %ld s between retries.\\n"
                    "[plc]   The slaves answer but refuse OPERATIONAL. If Distributed Clocks is enabled for this bus,\\n"
                    "[plc]   turn it off and retry: DC requires the drive's SYNC0 expectations to be met exactly, and a\\n"
                    "[plc]   mismatch leaves every slave parked in SAFE-OP with no AL error code to explain it.\\n",
                    __wd_fail, __wd_delay_ms / 1000);
            }
        }
        struct timespec __ts = { __wd_delay_ms / 1000, (__wd_delay_ms % 1000) * 1000000L };
        nanosleep(&__ts, NULL);
    }
    return NULL;
}
/* plc_task_IO_Bus \u2014 dedicated fieldbus I/O thread (lock-free).
 *
 * This is the ONLY thread that calls kron_ec_pdo_read / kron_ec_pdo_write.
 * All var_ptr fields in __ec_cfg point into __gpi_hw (the HW staging buffer).
 *
 * \u26a0\ufe0f INPUTS and OUTPUTS are carried differently, on purpose:
 *   inputs  \u2014 double-buffered (__gpi_buf[2] behind the __gpi front pointer),
 *              so every POU in one scan sees one consistent bus image.
 *   outputs \u2014 written by the logic straight into the single __gpi_out.
 * The old code ran BOTH through the double buffer, copying *front into the
 * staging buffer and later overwriting the recycled buffer wholesale
 * (*back = __gpi_hw). Any output the logic wrote between those two points went
 * into a buffer that was about to be overwritten, so it was silently dropped \u2014
 * an output pulse could simply never reach the slave. Outputs need no snapshot:
 * they are aligned scalars with a single writer each.
 *
 * Each bus cycle:
 *   1. Copy the logic's outputs (__gpi_out) into the HW staging buffer.
 *   2. Axis engine: one trajectory scan per axis, dt = THIS thread's cycle.
 *   3. Axis write bridge: Kron_PI.servo[n] \u2192 staging (motion owns its objects).
 *   4. kron_ec_pdo_write: transmit staging outputs \u2192 slave RxPDOs.
 *   5. kron_ec_pdo_read:  receive slave TxPDOs \u2192 staging inputs.
 *   6. Axis read bridge: staging \u2192 Kron_PI.servo[n].
 *   7. Copy the staging INPUTS into the back buffer and publish it (release).
 *
 * \u26a0\ufe0f The axis engine lives HERE, not in a logic task: the trajectory core
 * integrates one dt per call and dt is this thread's period, so the motion
 * resolution is the fieldbus cycle and not whatever scan rate the program that
 * declares the MC_* blocks happens to use. The FBs still run in their task and
 * reach the engine through __kron_axis_mu. */
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

        KRON_Process_Image *front = atomic_load_explicit(&__gpi, memory_order_relaxed);
        KRON_Process_Image *back  = (front == &__gpi_buf[0]) ? &__gpi_buf[1] : &__gpi_buf[0];

        /* Step 1: latest logic outputs \u2192 HW staging */
${gpiOutCopyIn}${hasAxes ? `\n        /* Step 2: the axis engine \u2014 PLCopen state machine + ONE trajectory scan,\n         * on the feedback this thread read at the end of the previous cycle. */\n        __kron_axis_step();\n\n        /* Step 3: axis outputs override the logic's for the CiA402 objects */\n${ncWriteBridge}` : ''}
        /* Step 4: transmit */
        kron_ec_pdo_write(&__ec_cfg);

        /* Step 5: receive */
        kron_ec_pdo_read(&__ec_cfg);
${hasAxes ? `\n        /* Step 6: fresh drive feedback \u2192 servo image (the engine consumes it\n         * at step 2 of the NEXT cycle) */\n${ncReadBridge}` : ''}
        /* Step 7: publish the fresh INPUT image to the logic tasks. Only the
         * input members are copied \u2014 the buffers' output members are unused. */
${gpiInCopyBack}        atomic_store_explicit(&__gpi, back, memory_order_release);

        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &__next, NULL);
    }
    return NULL;
}
`;
    const ecThreadCode =
        `\n#if defined(__linux__) && !defined(PLC_HOTSWAP)\n` + axisStepDefPlc + ecThreadBody + `#endif /* __linux__ && !PLC_HOTSWAP */\n`;

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

    // ── Hot-swap: the EtherCAT master belongs to the LOADER-HOST ───────────
    // ⚠️ SOEM's entire state (the raw socket, ecx_context, the PDO map) is
    // file-scope data of whichever module links libkronethercatmaster.a. Left in
    // logic.so it is torn down by every dlclose — and plc_init_hs() runs on the
    // COLD start ONLY, so the master would never be re-initialised: the bus would
    // die silently on the first hot reload, with the FBs still reporting OP from
    // a zeroed __ec_cfg. Emitting the master, the process image and the three bus
    // threads into host_glue.c (compiled into the loader-host) is the same fix
    // the HAL got with its __hs_* trampolines. host.c drives it through weakly
    // referenced __hs_ec_start / __hs_ec_stop.
    // ⚠️ Linux only — the Windows/macOS sim keeps -DKRON_EC_SIM: SOEM needs npcap
    // there / a contrib libpcap port, neither of which is bundled.
    const hostGlueEc =
`\n/* ── EtherCAT master (hot-swap: host-owned, survives a logic swap) ── */\n` +
`#if defined(__linux__)\n` +
`#include <pthread.h>\n#include <time.h>\n#include <stdatomic.h>\n` +
`#include "kronethercatmaster.h"\n#include "kron_hal.h"\n` +
(hasAxes ? `#include "kron_pi.h"\n#include "kronmotion.h"\nextern KRON_PROCESS_IMAGE Kron_PI;\n` : '') +
axisLockMacros +
axisMuDef +
`KRON_EC_Config __ec_cfg;\n` +
gpiDefs +
axisStepDefHost +
ecThreadBody +
`static pthread_t __ec_sdo_tid, __ec_wd_tid, __ec_io_tid;\n` +
`static int __ec_threads_up = 0;\n` +
`void __hs_ec_start(void) {\n` +
initCode +
`    pthread_create(&__ec_sdo_tid, NULL, __ec_sdo_thread,      NULL);\n` +
`    pthread_create(&__ec_wd_tid,  NULL, __ec_watchdog_thread, NULL);\n` +
`    pthread_create(&__ec_io_tid,  NULL, plc_task_IO_Bus,      NULL);\n` +
`    __ec_threads_up = 1;\n` +
`}\n` +
`/* Called by the loader-host AFTER the task threads are joined, so plc_stop is\n` +
` * already set and the three loops below are on their way out. */\n` +
`void __hs_ec_stop(void) {\n` +
`    if (__ec_threads_up) {\n` +
`        pthread_join(__ec_sdo_tid, NULL);\n` +
`        pthread_join(__ec_wd_tid,  NULL);\n` +
`        pthread_join(__ec_io_tid,  NULL);\n` +
`        __ec_threads_up = 0;\n` +
`    }\n` +
cleanupCode +
`}\n` +
`#endif /* __linux__ */\n`;

    return {
        headerDecl, headerExtern, gpiMacros, motionIncludes, axisLockMacros, cleanupCode,
        // masterInitCode = the bus itself (guarded out of PLC_Init under hot-swap,
        // where __hs_ec_start runs it); axisInitCode = PlcState writes, always in
        // PLC_Init. Their ORDER is preserved either way: host.c calls
        // __hs_ec_start() before plc_init_hs().
        masterInitCode: initCode, axisInitCode, hostGlueEc,
        pdoReadCode, pdoWriteCode, ecThreadCode, ecThreadStartCode, ecThreadJoinCode,
        halContent,
        // Names of all GPI-macro-backed PDO variables — transpileToC excludes
        // same-named user globals from PlcState/SHM so the macro applies.
        gpiVarNames: uniqueGpiVars.map(v => v.varName),
        // PlcState field names of every enabled axis, in declaration order.
        // generateMainLoop wraps the fastest task's scan with the axis engine's
        // read/write phases around these.
        axisNames: axisSlaves.map(({ slave }) =>
            (slave.axisRef.name || `Axis_${slave.position}`).replace(/[^A-Za-z0-9_]/g, '_')),
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
// the capture ring's producer (server/CLAUDE.md) — a known v1 gap, not an oversight.
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
    s += `// Values persisted to ./${'retain.dat'} and restored at PLC_Init. See src/services/CLAUDE.md.\n`;
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

const generateMainLoop = (projectStructure, config, boardId = null, shmEnabled = false, execTimeVars = [], initCode = '', cleanupCode = '', ecPdoReadCode = '', ecPdoWriteCode = '', ecThreadCode = '', ecThreadStartCode = '', ecThreadJoinCode = '', gpiMutexEnabled = false, shmEntries = [], plcStateLayoutHash = '0', addressedRingVars = [], retainEnabled = false, axisNames = []) => {
    let mainSrc = `\n// --- DETERMINISTIC SCAN LOOP ---\n`;

    // --- 1. Discover task→program groupings (priority: taskConfig > res_config > fallback) ---
    // taskGroups: [ { taskName, intervalUs, programs: [ progName, ... ] } ]
    let taskGroups = [];
    let programTasks = []; // flat: [ { name, intervalUs } ] for variableTable.tasks

    if (projectStructure.taskConfig?.tasks?.length > 0) {
        const usedTaskNames = new Set();
        projectStructure.taskConfig.tasks.forEach(task => {
            const intervalUs = mapTaskIntervalUs(task.interval);
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
                // SCHED_FIFO priority for this task's scan thread (TaskManager
                // field). Clamped here, not trusted: it reaches the runtime as a
                // C literal, and sched_setscheduler rejects anything outside
                // 1..99 — which would leave the thread at SCHED_OTHER with no
                // indication why. A project saved before the field existed keeps
                // the 99 the runtime used to hardcode.
                const rtPriority = Math.max(1, Math.min(99, Math.round(Number(task.rtPriority) || 99)));
                taskGroups.push({ taskName: tName, intervalUs, rtPriority, programs: progs });
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
            const intervalUs = task ? mapTaskIntervalUs(task.interval) : 10000;
            const tKey = inst.task || '__default';
            if (!legacyTaskMap[tKey]) legacyTaskMap[tKey] = { taskName: tKey.replace(/\s+/g, '_'), intervalUs, rtPriority: 99, programs: [] };
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

    // ── Motion: the axis engine's two scan phases (NON-LINUX FALLBACK ONLY) ──
    // ⚠️ On Linux the engine runs in the IO_Bus thread at the FIELDBUS cycle —
    // see plc_task_IO_Bus. dt has to equal the rate the core is really called
    // at, and a logic task's interval is the wrong rate: measured against the
    // real library, a 10 ms dt makes a jerk-limited move hunt around its target
    // for ever instead of completing. What made the engine live here before was
    // that kron_axis.c hands a request POINTER inside the FB instance to
    // AXIS_REF.Active/Buffer[] with no handshake of its own; that is solved by
    // __kron_axis_mu, which every entry point on both threads now takes.
    // Windows/macOS have no IO_Bus thread (EtherCAT is Linux-only here, and
    // those builds are KRON_EC_SIM anyway), so there the engine still runs in
    // the owning logic task with dt = that task's interval — simulation only.
    // Which task is that? An FB instance must be DECLARED to be called, in
    // ladder and in ST alike, so the program's own variable list is the
    // reliable signal — no rung/ST parsing needed.
    const motionProgramNames = new Set(
        (projectStructure.programs || [])
            .filter(prog => (prog.content?.variables || [])
                .some(v => MOTION_FB_AXIS_PARAM.has((v.type || '').trim())))
            .map(prog => (prog.name || '').trim().replace(/\s+/g, '_'))
    );
    const motionTaskIdxs = taskGroups
        .map((tg, i) => (tg.programs.some(pName => motionProgramNames.has(pName)) ? i : -1))
        .filter(i => i >= 0);
    if (motionTaskIdxs.length > 1) {
        console.warn(`[transpiler] Motion function blocks are called from ${motionTaskIdxs.length} different tasks `
            + `(${motionTaskIdxs.map(i => taskGroups[i].taskName).join(', ')}). On Linux this is safe — the engine runs `
            + `in the bus thread and every MC_* call takes __kron_axis_mu — but on a platform with no bus thread `
            + `(Windows/macOS sim) the engine runs in ${taskGroups[motionTaskIdxs[0]].taskName} only.`);
    }
    // No MC_* program yet: still run the engine (it drives the CiA402 state
    // machine and the feedback path), in the fastest task.
    const motionTaskIdx = axisNames.length === 0
        ? -1
        : (motionTaskIdxs.length > 0
            ? motionTaskIdxs.reduce((a, b) => (taskGroups[b].intervalUs < taskGroups[a].intervalUs ? b : a))
            : taskGroups.findIndex(tg => tg.intervalUs === fastestIntervalUs));
    // dt is the OWNING task's interval in seconds, not the fieldbus cycle: the
    // trajectory core integrates once per call and is called once per scan of
    // that task. A C literal needs the decimal point — a bare `1` for a 1 s task
    // is an int, and while it promotes here, the next use of this string may not.
    const motionDtUs = motionTaskIdx >= 0 ? taskGroups[motionTaskIdx].intervalUs : fastestIntervalUs;
    const motionDt = Number.isFinite(motionDtUs)
        ? (motionDtUs / 1e6).toFixed(9).replace(/0+$/, '0')
        : '0.0';
    const axisReadPhase = motionTaskIdx >= 0
        ? `#if !defined(__linux__)   /* no IO_Bus thread here \u2014 engine runs in this task */\n` +
          axisNames.map(a => `    KronAxis_ReadInput(&S->${a});\n`).join('') +
          `#endif\n`
        : '';
    const axisWritePhase = motionTaskIdx >= 0
        ? `#if !defined(__linux__)\n` +
          axisNames.map(a => `    KronAxis_WriteOutput(&S->${a}, ${motionDt});\n`).join('') +
          `#endif\n`
        : '';

    // Per-task SHM pull/sync functions — each task calls its own named version.
    // All currently include the full variable set; partition per-task in future if needed.
    if (shmEnabled && shmEntries.length > 0) {
        taskGroups.forEach(tg => {
            // See generateShmMailbox for the command protocol: the mailbox is
            // drained FIRST, so a command takes effect on this very scan.
            mainSrc += `static void plc_shm_pull_${tg.taskName}(void) {\n`;
            mainSrc += `    if (!__plc_shm) return;\n`;
            mainSrc += `    plc_mb_consume();\n`;
            shmEntries.forEach(e => { mainSrc += shmPullLine(e); });
            mainSrc += `}\n`;
            mainSrc += `static void plc_shm_sync_${tg.taskName}(void) {\n`;
            mainSrc += `    if (!__plc_shm) return;\n`;
            shmEntries.forEach(e => { mainSrc += shmSyncLine(e); });
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
        mainSrc += `    u32 = 2u;          memcpy(r+4,&u32,4);\n`;   // version (2: scan counter in record +12, fence after fetch_add)
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
            mainSrc += `    uint64_t sc = __ring_scan_${t.taskName}++;\n`;
            mainSrc += `    if ((sc % N) != 0) return;\n`;
            mainSrc += `    uint64_t s = __atomic_fetch_add((uint64_t*)(__plc_ring + 32), 1ull, __ATOMIC_RELAXED);\n`;
            // ⚠️ Seqlock writer fence: the payload stores below must not become
            // visible before the claim above. KronServer's torn-read check
            // (copy, then re-read write_seq) is only sound with it — a relaxed
            // fetch_add orders nothing on ARM.
            mainSrc += `    __atomic_thread_fence(__ATOMIC_RELEASE);\n`;
            mainSrc += `    uint8_t *slot = __plc_ring + 256 + (uint64_t)(s % __plc_ring_nslots) * PLC_RING_STRIDE;\n`;
            mainSrc += `    uint16_t tid = ${t.taskId}u; memcpy(slot + 8, &tid, 2);\n`;
            mainSrc += `    uint16_t pl = ${t.payloadLen}u; memcpy(slot + 10, &pl, 2);\n`;
            // v2: this task's scan counter (low 32 bits) — consecutive kept
            // records differ by stride_N, so a client SEES thinning.
            mainSrc += `    uint32_t scl = (uint32_t)sc; memcpy(slot + 12, &scl, 4);\n`;
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
        if (ti === motionTaskIdx) mainSrc += axisReadPhase;
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
        // The engine runs AFTER the POUs — an FB submits on this scan and the
        // trajectory core answers on the same one, which is what makes a new
        // target take effect next cycle with no profile to re-plan.
        if (ti === motionTaskIdx) mainSrc += axisWritePhase;
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
        mainSrc += `    { struct sched_param __sp = { .sched_priority = ${tg.rtPriority || 99} };\n`;
        mainSrc += `      if (pthread_setschedparam(pthread_self(), SCHED_FIFO, &__sp) != 0)\n`;
        mainSrc += `          fprintf(stderr, "[plc] task ${tg.taskName}: real-time scheduling unavailable (need CAP_SYS_NICE or RLIMIT_RTPRIO) — timing will jitter\\n"); }\n`;
        mainSrc += `    struct timespec __next;\n`;
        mainSrc += `    clock_gettime(CLOCK_MONOTONIC, &__next);\n`;
        mainSrc += `    while (!plc_stop) {\n`;
        // ⚠️ Whole seconds go to tv_sec: tv_nsec is a 32-bit long on armv7, so
        // adding interval*1000 ns for an interval >= ~2.1 s overflowed it.
        if (tg.intervalUs >= 1000000) mainSrc += `        __next.tv_sec += ${Math.floor(tg.intervalUs / 1000000)};\n`;
        mainSrc += `        __next.tv_nsec += ${(tg.intervalUs % 1000000) * 1000}L;\n`;
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
    // ⚠️ OPTIONAL ABI symbol: the loader-host dlsyms it and falls back to 99
    // when it is absent, so a logic.so built before this field still swaps into
    // an older host and vice versa. Adding it to the REQUIRED set would have
    // made every mismatched pair fail a cold start.
    mainSrc += `int plc_task_priority(int i) {\n`;
    mainSrc += `    switch (i) {\n`;
    taskGroups.forEach((tg, ti) => {
        mainSrc += `        case ${ti}: return ${tg.rtPriority || 99};\n`;
    });
    mainSrc += `        default: return 99;\n    }\n}\n`;
    // ⚠️ OPTIONAL ABI symbol, same contract as plc_task_priority: the axis
    // engine runs in the loader-host's bus thread, but AXIS_REF is a PlcState
    // field whose offset only this module knows. host.c resolves this after
    // every bind and feeds it to the generated __hs_axis_bind(), so the
    // pointers can never outlive the arena they came from. Absent = a project
    // with no axes, or a module built before this existed.
    if (axisNames.length > 0) {
        mainSrc += `void* plc_axis_ptr(int i) {\n    switch (i) {\n`;
        axisNames.forEach((a, i) => { mainSrc += `        case ${i}: return (void*)&S->${a};\n`; });
        mainSrc += `        default: return 0;\n    }\n}\n`;
    }
    // The host maps the mirror BEFORE calling this, so the mailbox is
    // initialised exactly once per cold start — never on a swap.
    mainSrc += shmEnabled
        ? `void plc_init_hs(void) { PLC_Init(); plc_mb_init(); }\n`
        : `void plc_init_hs(void) { PLC_Init(); }\n`;
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
// ⚠️ VAR_IN_OUT is a PARAMETER too, passed BY POINTER: it used to be left
// out of the parameter list and declared as a body local, so the caller's
// argument count no longer matched the prototype and nothing was written back.
// Inside the body the name resolves to `(*name)` (see buildStMaps / the LD
// resolver); at a call site the argument becomes `&(arg)` and must be a
// variable.
const isInOutClass = (v) => String(v?.class || '').toLowerCase() === 'inout';
const functionInputVars = (pou) =>
    (pou?.content?.variables || []).filter(v => ['input', 'inout'].includes(String(v.class || '').toLowerCase()));

// ⚠️ A STRING VAR_INPUT arrives as `const char *__in_<name>` and the body
// copies it into a local kron_string_t of the declared name (IEC passes inputs
// BY VALUE): an array parameter would decay to a pointer into the CALLER's
// storage, so assigning to the input inside the function wrote the caller's
// variable, and KRON_STRSET could not tell it from a pointer. A STRING
// VAR_IN_OUT is `kron_string_t *` and works on the caller's array as intended.
const stringInputParamName = (vName) => `__in_${vName}`;
const isStringByValueInput = (v) => !isInOutClass(v) && isStringInputType(v?.type);
// ⚠️ A STRING-returning FUNCTION takes its result buffer from the CALLER
// (`kron_string_t *__res`, first parameter): every ST call site owns one
// (stExpr.js userCall). One per-function static buffer made `F(a) = F(b)`
// compare F(b) with itself, whatever order C evaluated the calls in.
const STRING_RESULT_PARAM = '__res';
const buildFunctionParams = (pou) => {
    const ins = functionInputVars(pou);
    const res = isStringInputType(pou?.returnType) ? [`${STRING_C_TYPE} *${STRING_RESULT_PARAM}`] : [];
    if (ins.length === 0 && res.length === 0) return 'void';
    return [...res, ...ins
        .map(v => {
            const n = cIdent((v.name || '').trim().replace(/\s+/g, '_'));
            if (isStringByValueInput(v)) return `const char *${stringInputParamName(n)}`;
            return `${mapType((v.type || '').trim())} ${isInOutClass(v) ? '*' : ''}${n}`;
        })]
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
    const fnRetType = category === 'function' ? fnReturnCType(pou.returnType || 'VOID') : 'void';
    const fnReturnsString = category === 'function' && isStringInputType(pou.returnType);

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
    const stringFnReturn = `{ ${kronStrset(`*${STRING_RESULT_PARAM}`, '__ret')}; return *${STRING_RESULT_PARAM}; }`;
    const fnInputNames = new Set();
    if (category === 'function') {
        functionInputVars(pou).forEach(v => {
            const vName = (v.name || '').trim().replace(/\s+/g, '_');
            if (vName) fnInputNames.add(vName);
        });
        // STRING inputs: the by-value copy (see buildFunctionParams).
        functionInputVars(pou).filter(isStringByValueInput).forEach(v => {
            const n = cIdent((v.name || '').trim().replace(/\s+/g, '_'));
            src += `    ${STRING_C_TYPE} ${n}; ${kronStrset(n, stringInputParamName(n))};\n`;
        });
        (pou.content?.variables || []).forEach(v => {
            const vName = (v.name || '').trim().replace(/\s+/g, '_');
            if (!vName || fnInputNames.has(vName)) return;
            if (isInlineMathType(v.type)) return;
            if (isStringInputType(v.type)) {
                // Copied, so an over-long initial is truncated like any other
                // assignment instead of being a C initializer error.
                src += `    ${STRING_C_TYPE} ${cIdent(vName)} = {0};\n`;
                const line = initAssignStmt(cIdent(vName), v.initialValue, v.type);
                if (line) src += `    ${line}\n`;
                return;
            }
            const init = formatVarInitial(v.initialValue, v.type) || ' = {0}';
            src += `    ${mapType((v.type || '').trim())} ${cIdent(vName)}${init};\n`;
        });
        if (fnReturnsString) {
            // ⚠️ An array cannot be returned: the result is built in a local
            // and copied into the CALLER's buffer (see buildFunctionParams),
            // whose address is returned — valid for as long as the caller's
            // scope, and distinct per call site.
            src += `    ${STRING_C_TYPE} __ret = {0};\n`;
            fnEpilogue = `    ${stringFnReturn}\n`;
        } else if (fnRetType !== 'void') {
            src += `    ${fnRetType} __ret = {0};\n`;
            fnEpilogue = `    return __ret;\n`;
        }
    }

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
    // Member names + types of user FBs and structure UDTs — lets `t2.q`,
    // `myFb.count` and `pt.x` be spelled in any case (IEC) and still name the
    // real C member, and lets an InOut pin get its copy-back.
    const memberCtx = buildMemberCtx(projectStructure);

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

    // Case-insensitive views of the declared names (IEC identifiers are
    // case-insensitive): lower → declared spelling, and lower → IEC type with
    // locals shadowing globals.
    const globalLower = new Map(globalVarNames.map(g => [String(g).toLowerCase(), g]));
    const nameTypes = new Map();
    (globalVarsList || []).forEach(gv => {
        const gName = (gv.name || '').trim().replace(/\s+/g, '_');
        if (gName) nameTypes.set(gName.toLowerCase(), gv.type);
    });
    (pou.content?.variables || []).forEach(v => {
        const vName = (v.name || '').trim().replace(/\s+/g, '_');
        if (vName) nameTypes.set(vName.toLowerCase(), v.type);
    });
    // FUNCTION VAR_IN_OUT parameters are pointers: every use is `(*name)`.
    const fnPtrParams = new Set(category === 'function'
        ? (pou.content?.variables || []).filter(isInOutClass).map(v => (v.name || '').trim().replace(/\s+/g, '_'))
        : []);

    // Build C-symbol → IEC-type map for LD type inference (REAL detection).
    // ⚠️ Keyed by the EXACT text resolveVal returns (`S->prog_Main_x`,
    // `S->g`, `instance->x`, `(*p)`): it used to be keyed `prog_Main_x` / `g`,
    // so no lookup ever hit and every LD math block on REAL variables ran the
    // int32 struct path, truncating the result. Bare forms stay as aliases.
    const buildCSymTypeMap = () => {
        const map = {};
        globalVarsList.forEach(v => {
            const vName = (v.name || '').trim().replace(/\s+/g, '_');
            if (!vName) return;
            map[vName] = v.type;
            map[`S->${cIdent(vName)}`] = v.type;
        });
        (pou.content.variables || []).forEach(v => {
            const vName = (v.name || '').trim().replace(/\s+/g, '_');
            if (!vName) return;
            const keys = [];
            if (globalLower.has(vName.toLowerCase())) {
                const g = globalLower.get(vName.toLowerCase());
                keys.push(g, `S->${cIdent(g)}`);
            } else if (category === 'program') {
                keys.push(`prog_${safeName}_${vName}`, `S->prog_${safeName}_${vName}`);
            } else if (category === 'function_block') {
                keys.push(`instance->${cIdent(vName)}`);
            } else {
                keys.push(cIdent(vName), `(*${cIdent(vName)})`);
            }
            keys.forEach(k => { map[k] = v.type; });
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
            const g = globalLower.get(vName.toLowerCase());
            if (g) {
                varMap[vName] = `S->${cIdent(g)}`; // global: PlcState field (hot-swap)
            } else if (category === 'program') {
                varMap[vName] = fbInstanceNames.has(vName)
                    ? `S->prog_${parentName}_inst_${vName}`
                    : `S->prog_${parentName}_${vName}`;
            } else if (category === 'function_block') {
                varMap[vName] = `instance->${cIdent(vName)}`;
            } else {
                varMap[vName] = fnPtrParams.has(vName) ? `(*${cIdent(vName)})` : cIdent(vName);
            }
        });
        // Globals referenced but not declared locally are PlcState fields too.
        const mappedLower = new Set(Object.keys(varMap).map(k => k.toLowerCase()));
        globalVarNames.forEach(g => {
            const gn = (g || '').trim().replace(/\s+/g, '_');
            if (gn && !mappedLower.has(gn.toLowerCase())) { varMap[gn] = `S->${cIdent(gn)}`; mappedLower.add(gn.toLowerCase()); }
        });
        // EtherCAT PDO variables must stay BARE so the GPI access macro applies
        // (they have no PlcState field — mapping them to S->name breaks compile).
        // Mapped to the macro's own spelling, so `EC_x` written in any case
        // still names `ec_X`.
        Object.keys(varMap).forEach(k => {
            const c = ecPdoCanon(k);
            if (c && varMap[k] === `S->${cIdent(k)}`) varMap[k] = c;
        });
        EC_PDO_VAR_NAMES.forEach(n => { if (!mappedLower.has(n.toLowerCase())) varMap[n] = n; });
        // Function result variable: FuncName := expr → __ret = expr.
        if (category === 'function' && fnRetType !== 'void') {
            varMap[safeName] = '__ret';
        }
        return { varMap, varTypeMap };
    };

    const stOpts = {
        fnReturnVar: (category === 'function' && fnRetType !== 'void') ? '__ret' : null,
        // `FuncName := …` / RETURN in a STRING function are copies into __ret.
        fnResult: (category === 'function' && fnRetType !== 'void')
            ? { name: safeName, type: pou.returnType, isString: fnReturnsString } : null,
        userFBInputs,
        memberCtx,
        // Full signatures for the expression compiler (stExpr.js).
        userFunctionDefs: new Map((projectStructure?.functions || [])
            .map(fn => {
                const n = (fn.name || '').trim().replace(/\s+/g, '_');
                return [n.toLowerCase(), {
                    name: n,
                    ret: fn.returnType || 'VOID',
                    params: functionInputVars(fn).filter(v => (v.name || '').trim()).map(v => ({
                        name: (v.name || '').trim().replace(/\s+/g, '_'), type: v.type, inout: isInOutClass(v),
                    })),
                }];
            })
            .filter(([n]) => n)),
        // Expression temps / per-call STRING result buffers, unique per POU.
        exprSeq: { next: 0 },
        stringFnReturn: fnReturnsString ? stringFnReturn : null,
        // ONE counter for the whole POU: an SCL program calls transpileSTLogics
        // once per ST rung, and a per-call counter would hand the same buffer
        // to two different conversions.
        strConv: category === 'program' ? { progName: safeName, next: 0 } : null,
        // Same reason: EXIT labels and hidden FOR counters must be unique
        // across every ST rung of one C function.
        labelSeq: { next: 0 },
    };
    const declaredCanon = new Map();
    globalVarNames.forEach(g => declaredCanon.set(String(g).toLowerCase(), g));
    localVarNames.forEach(n => declaredCanon.set(n.toLowerCase(), n));
    const ldCtx = { memberCtx, nameTypes, fnPtrParams, declaredCanon };

    if (pou.type === 'ST') {
        const { varMap, varTypeMap } = buildStMaps();
        src += transpileSTLogics(pou.content.code, stdFunctions, parentName, category, varMap, varTypeMap, userFBTypes, stOpts);
    } else if (pou.type === 'LD') {
        src += transpileLDLogics(pou.content.rungs, stdFunctions, safeName, category, globalVarNames, inputShadowMap, 0, buildCSymTypeMap(), localVarNames, fbInstanceNames, ldCtx);
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
                src += transpileLDLogics([rung], stdFunctions, safeName, category, globalVarNames, inputShadowMap, sclLdRungIdx, buildCSymTypeMap(), localVarNames, fbInstanceNames, ldCtx);
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
    'LN': 'EN', 'LOG': 'EN', 'EXP': 'EN',
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
    'MC_SetPosition': 'Execute', 'MC_SetOverride': 'Enable',
    'MC_Reset': 'Execute',
    'MC_ReadParameter': 'Enable', 'MC_ReadBoolParameter': 'Enable',
    'MC_WriteParameter': 'Execute', 'MC_WriteBoolParameter': 'Execute',
    'MC_ReadActualPosition': 'Enable', 'MC_ReadActualVelocity': 'Enable',
    'MC_ReadActualTorque': 'Enable', 'MC_ReadStatus': 'Enable',
    'MC_ReadMotionState': 'Enable', 'MC_ReadAxisInfo': 'Enable', 'MC_ReadAxisError': 'Enable',
    // System / RTC / scheduling / diagnostics (kronsystem.h). The EN-triggered
    // ones are REAL instance FBs, hence their SYSTEM_FB_TYPES entries, which
    // keep them out of isInlineMathType.
    'Read_System_Time': 'EN', 'Read_System_Date': 'EN', 'Read_Epoch_Time': 'EN',
    'Epoch_To_Date': 'EN',
    'Time_Switch': 'EN', 'Daily_Trigger': 'EN', 'Astro_Clock': 'EN',
    'Read_Uptime': 'EN', 'Cycle_Time_Monitor': 'EN',
    'Read_CPU_Temperature': 'EN', 'Read_System_Load': 'EN', 'Read_Disk_Free': 'EN',
    'Read_Sys_File': 'EN', 'Read_Hwmon': 'EN',
    'T_To_Ms': 'EN', 'Ms_To_T': 'EN', 'T_To_Sec': 'EN', 'Sec_To_T': 'EN',
    'Add_T': 'EN', 'Sub_T': 'EN', 'Mul_T': 'EN', 'Div_T': 'EN',
    'Gen_Signal': 'EN',
    // Power flow enters these on their own signal pin, so no EN and no
    // SYSTEM_FB_TYPES entry is needed (isInlineMathType is already false).
    'Hour_Meter': 'IN', 'Watchdog': 'KICK', 'Blink': 'ENABLE', 'Debounce': 'IN',
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
    'LN': 'ENO', 'LOG': 'ENO', 'EXP': 'ENO',
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
    'MC_SetPosition': 'Done', 'MC_SetOverride': 'Enabled',
    'MC_Reset': 'Done',
    'MC_ReadParameter': 'Valid', 'MC_ReadBoolParameter': 'Valid',
    'MC_WriteParameter': 'Done', 'MC_WriteBoolParameter': 'Done',
    'MC_ReadActualPosition': 'Valid', 'MC_ReadActualVelocity': 'Valid',
    'MC_ReadActualTorque': 'Valid', 'MC_ReadStatus': 'Valid',
    'MC_ReadMotionState': 'Valid', 'MC_ReadAxisInfo': 'Valid', 'MC_ReadAxisError': 'Valid',
    // System / RTC / scheduling / diagnostics
    'Read_System_Time': 'ENO', 'Read_System_Date': 'ENO', 'Read_Epoch_Time': 'ENO',
    'Epoch_To_Date': 'ENO',
    'Time_Switch': 'Q', 'Daily_Trigger': 'Q', 'Astro_Clock': 'IS_DAY',
    'Read_Uptime': 'ENO', 'Cycle_Time_Monitor': 'ENO', 'Hour_Meter': 'Q',
    'Watchdog': 'EXPIRED',
    'Read_CPU_Temperature': 'ENO', 'Read_System_Load': 'ENO', 'Read_Disk_Free': 'ENO',
    'Read_Sys_File': 'ENO', 'Read_Hwmon': 'ENO',
    'T_To_Ms': 'ENO', 'Ms_To_T': 'ENO', 'T_To_Sec': 'ENO', 'Sec_To_T': 'ENO',
    'Add_T': 'ENO', 'Sub_T': 'ENO', 'Mul_T': 'ENO', 'Div_T': 'ENO',
    'Blink': 'OUT', 'Debounce': 'OUT', 'Gen_Signal': 'ENO',
};

// Exported for agentTools.js (the PLC Agent's set_ladder): the agent authors
// FB-in-ladder rungs and must wire the power flow into the SAME trigger pin and
// out of the SAME Q pin this transpiler uses — importing the tables keeps one
// source of truth instead of a hand-copied map that would silently drift.
export { FB_TRIGGER_PIN, FB_Q_OUTPUT };

const GENERATED_FB_OUTPUT_TYPES = {};

// Output pin types for the kronsystem.h blocks. These MUST be declared rather
// than inferred: the generic rules in getOutputPinType key off pin NAMES, and
// every one of these blocks has pins those rules would get wrong —
// Read_System_Time.TIME is a DINT (ms since local midnight), not the IEC TIME
// duration its name suggests; Gen_Signal.OUT is a REAL where the `OUT` rule
// yields DINT; and everything not otherwise matched silently defaults to BOOL.
// ⚠️ Mandatory for every non-BOOL output of an EC_* block, for the same reason
// MOTION_FB_OUTPUT_TYPES is mandatory for MC_*: getOutputPinType keys off pin
// NAMES and falls through to BOOL, so ErrorID / State / SlaveCount / Value
// collapsed to one bit in every path that has no XML customData to fall back on
// (an agent-authored rung, a project saved before the library carried pins).
// Types are the struct fields in kronethercatmaster.h.
const EC_FB_OUTPUT_TYPES = {
    'EC_GetMasterState': { 'ErrorID': 'WORD', 'State': 'BYTE', 'SlaveCount': 'UINT' },
    'EC_GetSlaveState':  { 'ErrorID': 'WORD', 'State': 'BYTE' },
    'EC_ResetBus':       { 'ErrorID': 'WORD' },
    'EC_ReadSDO':        { 'ErrorID': 'WORD', 'Value': 'DWORD' },
    'EC_WriteSDO':       { 'ErrorID': 'WORD' },
};

const SYSTEM_FB_OUTPUT_TYPES = {
    'Read_System_Time':     { 'TIME': 'DINT' },
    'Read_System_Date':     { 'Year': 'INT', 'Month': 'USINT', 'Day': 'USINT', 'Weekday': 'USINT', 'DayOfYear': 'UINT' },
    'Read_Epoch_Time':      { 'SEC': 'UDINT', 'MS': 'UINT', 'UTC_Offset': 'INT' },
    'Epoch_To_Date':        { 'Year': 'INT', 'Month': 'USINT', 'Day': 'USINT', 'Hour': 'USINT',
                              'Minute': 'USINT', 'Second': 'USINT', 'Millisecond': 'UINT', 'Weekday': 'USINT' },
    'Astro_Clock':          { 'SUNRISE_MIN': 'UINT', 'SUNSET_MIN': 'UINT', 'IS_DAY': 'BOOL', 'VALID': 'BOOL' },
    'Read_Uptime':          { 'DAYS': 'UINT', 'HOURS': 'USINT', 'MINUTES': 'USINT', 'SECONDS': 'USINT', 'TOTAL_SEC': 'UDINT' },
    'Cycle_Time_Monitor':   { 'LAST_US': 'UDINT', 'MIN_US': 'UDINT', 'MAX_US': 'UDINT',
                              'AVG_US': 'UDINT', 'JITTER_US': 'UDINT', 'SAMPLES': 'UDINT' },
    // Hour_Meter counts a total, so SECONDS is a UDINT here and a 0..59
    // component (USINT) on Read_Uptime — the table is per block for that reason.
    'Hour_Meter':           { 'HOURS': 'UDINT', 'SECONDS': 'UDINT' },
    'Watchdog':             { 'EXPIRED': 'BOOL', 'ET': 'TIME' },
    'Read_CPU_Temperature': { 'TEMP': 'REAL', 'ERR_ID': 'USINT' },
    'Read_System_Load':     { 'LOAD_1M': 'REAL', 'MEM_FREE_MB': 'UDINT', 'MEM_TOTAL_MB': 'UDINT', 'ERR_ID': 'USINT' },
    'Read_Disk_Free':       { 'FREE_MB': 'UDINT', 'TOTAL_MB': 'UDINT', 'ERR_ID': 'USINT' },
    'Read_Sys_File':        { 'VALUE': 'STRING', 'ERR_ID': 'USINT' },
    'Read_Hwmon':           { 'VALUE': 'STRING', 'ERR_ID': 'USINT' },
    'T_To_Ms':              { 'OUT': 'DINT' },
    'Ms_To_T':              { 'OUT': 'TIME' },
    'T_To_Sec':             { 'OUT': 'REAL' },
    'Sec_To_T':             { 'OUT': 'TIME' },
    'Add_T':                { 'OUT': 'TIME' },
    'Sub_T':                { 'OUT': 'TIME' },
    'Mul_T':                { 'OUT': 'TIME' },
    'Div_T':                { 'OUT': 'TIME' },
    'Blink':                { 'OUT': 'BOOL' },
    'Debounce':             { 'OUT': 'BOOL' },
    'Gen_Signal':           { 'OUT': 'REAL' },
};

// Returns the IEC type of an output pin for a given block type
// customData is optional — used for user-defined FB output pin types
const getOutputPinType = (blockType, pinName, customData) => {
    if (['Q', 'Q1', 'QU', 'QD', 'ENO'].includes(pinName)) return 'BOOL';
    if ((blockType === 'UART_Receive' || blockType === 'USB_Receive') && pinName === 'ReceivedLength') return 'UINT';
    if (EC_FB_OUTPUT_TYPES[blockType]?.[pinName]) return EC_FB_OUTPUT_TYPES[blockType][pinName];
    if (SYSTEM_FB_OUTPUT_TYPES[blockType]?.[pinName]) return SYSTEM_FB_OUTPUT_TYPES[blockType][pinName];
    if (MOTION_FB_OUTPUT_TYPES[blockType]?.[pinName]) return MOTION_FB_OUTPUT_TYPES[blockType][pinName];
    if (GENERATED_FB_OUTPUT_TYPES[blockType]?.[pinName]) return GENERATED_FB_OUTPUT_TYPES[blockType][pinName];
    if (pinName === 'ET') return 'TIME';
    if (pinName === 'CV') return 'INT';
    if (pinName === 'OUT') {
        const m = blockType.match(/_TO_([A-Z]+)$/);
        if (m) return m[1];
        if (['ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'MOVE', 'SEL', 'MUX'].includes(blockType)) return 'DINT';
        if (['ABS', 'SQRT', 'EXPT', 'MAX', 'MIN', 'LIMIT', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'LN', 'LOG', 'EXP', 'NORM_X', 'SCALE_X'].includes(blockType)) return 'REAL';
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

// IEC type of a standard block's pin for the ST expression typer, or null
// when no table states it. ⚠️ Deliberately NOT getOutputPinType: that falls
// through to BOOL for any pin it does not know, and a guessed BOOL would make
// the typer refuse `inst.ErrorID = 5` (or pick logical AND on a WORD).
const stdPinTypeForExpr = (blockType, pin) => {
    if (FB_TRIGGER_PIN[blockType] === pin) return 'BOOL';
    const it = FB_INPUT_TYPES[blockType]?.[pin];
    if (it) return it;
    if (['Q', 'Q1', 'QU', 'QD', 'ENO', 'EN'].includes(pin)) return 'BOOL';
    if ((blockType === 'UART_Receive' || blockType === 'USB_Receive') && pin === 'ReceivedLength') return 'UINT';
    const tables = [EC_FB_OUTPUT_TYPES, SYSTEM_FB_OUTPUT_TYPES, MOTION_FB_OUTPUT_TYPES, GENERATED_FB_OUTPUT_TYPES];
    for (const t of tables) if (t[blockType]?.[pin]) return t[blockType][pin];
    if (pin === 'ET' && (FB_OUTPUTS[blockType] || []).includes('ET')) return 'TIME';
    if (pin === 'CV' && (FB_OUTPUTS[blockType] || []).includes('CV')) return 'INT';
    return null;
};

// IEC type of the debug shadow field behind an INLINE (EN/ENO, stateless)
// block's data output — ADD, EQ, BAND, INT_TO_REAL, MIN/MAX/LIMIT/SEL/MUX.
// ⚠️ The math path chooses its int-vs-float form at EMIT time (`useReal`, read
// off the operand expressions), which this pre-scan cannot see, so every
// numeric result is held as LREAL: a double carries the whole int32 range
// exactly, so ONE field type serves both paths and can never truncate a REAL.
// Comparisons (BOOL), bitwise ops (DWORD) and conversions (the _TO_ suffix)
// have a fixed result type, so they keep the one getOutputPinType reports.
const inlineShadowType = (blockType, pinName) =>
    pinName === 'OUT' && (MATH_FB_BLOCKS.has(blockType) || ['MIN', 'MAX', 'LIMIT', 'SEL', 'MUX'].includes(blockType))
        ? 'LREAL'
        : getOutputPinType(blockType, pinName, null);

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
            // ⚠️ Inline blocks (ADD, EQ, BAND, X_TO_Y, MIN/MAX/SEL/MUX/LIMIT) are
            // stateless: their result used to exist ONLY inside the C expression
            // it fed, so a block whose OUT/Q pin was left unassigned produced a
            // value nothing could observe. They get a shadow field like every
            // other block, which is also what forces the expression to be
            // emitted at all when no variable and no wire consumes it.
            const inline = isInlineMathType(type);
            const instName = (data.instanceName || type).trim().replace(/\s+/g, '_');
            const outPins = [
                // An inline block's ENO IS the rung's power flow, already drawn
                // on the rail — a slot of its own would double the cost for
                // nothing.
                ...(FB_OUTPUTS[type] || []).filter(p => !(inline && p === 'ENO')),
                ...(data.customData?.content?.variables || [])
                    .filter(v => v.class === 'Output').map(v => v.name)
            ];
            outPins.forEach(pinName => {
                const sym = `prog_${progName}_out_${instName}_${pinName}`;
                if (seen.has(sym)) return;
                seen.add(sym);
                if (inline && /_TO_STRING$/.test(type)) {
                    // The text already lives in this call site's own PlcState
                    // buffer (strConvSymbol) — a second field would be a stray
                    // char[64], and `field = KRON_x_TO_STRING(...)` does not even
                    // compile against an array. Alias the debug key onto it.
                    vars.push({ symbol: sym, type: 'STRING', aliasOf: strConvSymbol(progName, instName) });
                    return;
                }
                vars.push({
                    symbol: sym,
                    type: inline ? inlineShadowType(type, pinName)
                                 : getOutputPinType(type, pinName, data.customData),
                });
            });
        });
    });
    return vars;
};

// Every x_TO_STRING call site in a PROGRAM needs its own text buffer in
// PlcState (see strConvSymbol). Ladder sites are named after the block
// instance; ST sites are numbered, and the count is an UPPER BOUND — comments
// and string literals are stripped before the rewrite runs, so it consumes
// fewer. Over-allocating wastes 64 bytes; under-allocating would reference a
// field that does not exist, which is a compile error rather than a silent
// wrong value. Ladder tags are deduped so a repeated instance name shares a
// buffer instead of naming a field nobody declared.
const collectStringConvBuffers = (prog, progName) => {
    const syms = [];
    const seen = new Set();
    const add = (tag) => {
        const sym = strConvSymbol(progName, tag);
        if (seen.has(sym)) return;
        seen.add(sym);
        syms.push(sym);
    };
    const rungs = prog.content?.rungs || [];
    if (prog.type === 'LD' || prog.type === 'SCL') {
        rungs.forEach(rung => {
            if (rung.lang === 'ST') return;
            (rung.blocks || []).forEach((b, i) => {
                const t = (b.type || '').trim();
                if (!/^[A-Z]+_TO_STRING$/.test(t)) return;
                add(((b.data?.instanceName) || `${t}${i}`).trim().replace(/\s+/g, '_'));
            });
        });
    }
    // ST sources, concatenated in the SAME order transpilePOUSource visits
    // them, so the numbering the rewrite hands out matches these fields.
    let stText = '';
    if (prog.type === 'ST') stText = prog.content?.code || '';
    else if (prog.type === 'SCL') stText = rungs.filter(r => r.lang === 'ST').map(r => r.code || '').join('\n');
    for (let i = 0; i < countStringConvCalls(stText); i++) add(`st${i}`);
    return syms;
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
                // A standard block's STRING pin is a `const char *`, re-pointed
                // at its literal/variable every scan (which keeps it valid across
                // a hot-swap). A writable shadow would be pointless — text is a
                // read-only live value — so there is none.
                if (isStringInputType(iecType)) return;
                // The Axis pin is passed as the _Call's 2nd parameter, not a
                // struct field — a shadow var would declare a stray AXIS_REF
                // PlcState field with no SHM slot when the pin is left empty.
                if (iecType === 'AXIS_REF') return;
                const rawVal = data.values?.[editorPin];
                if (isVarRef(rawVal)) return;
                const sym = `prog_${progName}_in_${instName}_${editorPin}`;
                if (seen.has(sym)) return;
                seen.add(sym);
                const cleanVal = rawVal ? (rawVal + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                let initStr = '0';
                let initVal = 0;
                if (cleanVal) {
                    if (isTimeTypeName(iecType)) {
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
        /^-?[0-9]/.test(s) || /^(true|false)$/i.test(s) || isTimeLiteral(s);

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
                // A bare word on a STRING pin is literal text, not a variable —
                // declaring it here would mint a BOOL and break the C assignment.
                if (isStringInputType(FB_INPUT_TYPES[type]?.[pinName])) return;
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
    'LN': ['ENO', 'OUT'], 'LOG': ['ENO', 'OUT'], 'EXP': ['ENO', 'OUT'],
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
    'MC_Stop': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_Halt': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_MoveAbsolute': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_MoveRelative': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_MoveAdditive': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_MoveVelocity': ['InVelocity', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_MoveSuperimposed': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID', 'CoveredDistance'],
    'MC_HaltSuperimposed': ['Done', 'Busy', 'Active', 'CommandAborted', 'Error', 'ErrorID'],
    'MC_SetPosition': ['Done', 'Busy', 'Error', 'ErrorID'],
    'MC_SetOverride': ['Enabled', 'Busy', 'Error', 'ErrorID'],
    'MC_Reset': ['Done', 'Busy', 'Error', 'ErrorID'],
    'MC_ReadParameter': ['Valid', 'Busy', 'Error', 'ErrorID', 'Value'],
    'MC_ReadBoolParameter': ['Valid', 'Busy', 'Error', 'ErrorID', 'Value'],
    'MC_WriteParameter': ['Done', 'Busy', 'Error', 'ErrorID'],
    'MC_WriteBoolParameter': ['Done', 'Busy', 'Error', 'ErrorID'],
    'MC_ReadActualPosition': ['Valid', 'Busy', 'Error', 'ErrorID', 'Position'],
    'MC_ReadActualVelocity': ['Valid', 'Busy', 'Error', 'ErrorID', 'Velocity'],
    'MC_ReadActualTorque': ['Valid', 'Busy', 'Error', 'ErrorID', 'Torque'],
    'MC_ReadStatus': ['Valid', 'Busy', 'Error', 'ErrorID', 'ErrorStop', 'Disabled', 'Stopping', 'Homing', 'Standstill', 'DiscreteMotion', 'ContinuousMotion', 'SynchronizedMotion'],
    'MC_ReadMotionState': ['Valid', 'Busy', 'Error', 'ErrorID', 'ConstantVelocity', 'Accelerating', 'Decelerating', 'DirectionPositive', 'DirectionNegative'],
    'MC_ReadAxisInfo': ['Valid', 'Busy', 'Error', 'ErrorID', 'HomeAbsSwitch', 'LimitSwitchPos', 'LimitSwitchNeg',
                        'Simulation', 'CommunicationReady', 'ReadyForPowerOn', 'PowerOn', 'IsHomed', 'AxisWarning'],
    'MC_ReadAxisError': ['Valid', 'Busy', 'Error', 'ErrorID', 'AxisErrorID'],
    // System / RTC / scheduling / diagnostics (kronsystem.h)
    'Read_System_Time': ['ENO', 'TIME'],
    'Read_System_Date': ['ENO', 'Year', 'Month', 'Day', 'Weekday', 'DayOfYear'],
    'Read_Epoch_Time': ['ENO', 'SEC', 'MS', 'UTC_Offset'],
    'Epoch_To_Date': ['ENO', 'Year', 'Month', 'Day', 'Hour', 'Minute', 'Second', 'Millisecond', 'Weekday'],
    'Time_Switch': ['ENO', 'Q'],
    'Daily_Trigger': ['ENO', 'Q'],
    'Astro_Clock': ['ENO', 'SUNRISE_MIN', 'SUNSET_MIN', 'IS_DAY', 'VALID'],
    'Read_Uptime': ['ENO', 'DAYS', 'HOURS', 'MINUTES', 'SECONDS', 'TOTAL_SEC'],
    'Cycle_Time_Monitor': ['ENO', 'LAST_US', 'MIN_US', 'MAX_US', 'AVG_US', 'JITTER_US', 'SAMPLES'],
    'Hour_Meter': ['Q', 'HOURS', 'SECONDS'],
    'Watchdog': ['EXPIRED', 'ET'],
    'Read_CPU_Temperature': ['ENO', 'TEMP', 'ERR_ID'],
    'Read_System_Load': ['ENO', 'LOAD_1M', 'MEM_FREE_MB', 'MEM_TOTAL_MB', 'ERR_ID'],
    'Read_Disk_Free': ['ENO', 'FREE_MB', 'TOTAL_MB', 'ERR_ID'],
    'Read_Sys_File': ['ENO', 'VALUE', 'ERR_ID'],
    'Read_Hwmon': ['ENO', 'VALUE', 'ERR_ID'],
    'T_To_Ms': ['ENO', 'OUT'], 'Ms_To_T': ['ENO', 'OUT'],
    'T_To_Sec': ['ENO', 'OUT'], 'Sec_To_T': ['ENO', 'OUT'],
    'Add_T': ['ENO', 'OUT'], 'Sub_T': ['ENO', 'OUT'],
    'Mul_T': ['ENO', 'OUT'], 'Div_T': ['ENO', 'OUT'],
    'Blink': ['OUT'], 'Debounce': ['OUT'], 'Gen_Signal': ['ENO', 'OUT'],
};
// All conversion blocks (X_TO_Y) share ['ENO', 'OUT'] — built dynamically below
// Programmatically populate all 72 X_TO_Y conversion entries across lookup tables
// ⚠️ STRING is in this list, so the 18 STRING_TO_x / x_TO_STRING pairs get the
// same FB tables as the numeric ones. Their C side is NOT in libkron*.a — it is
// static inline in kronsystem.h — and the TO_STRING half needs an output
// buffer, which is why both directions are emitted by name below instead of
// through the generic C-cast branch.
const _CONV_TYPES = ['BOOL', 'BYTE', 'WORD', 'DWORD', 'INT', 'UINT', 'DINT', 'UDINT', 'REAL', 'STRING'];
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
    'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'LN', 'LOG', 'EXP',
]);
// Unary <math.h> functions: no kronmath.h struct exists for any of them (a
// `SIN` struct was referenced and never compiled), so they are ALWAYS emitted
// inline in floating point, whatever the operand type. block → C function.
const MATH_UNARY_C = {
    SQRT: 'sqrt', SIN: 'sin', COS: 'cos', TAN: 'tan', ASIN: 'asin', ACOS: 'acos', ATAN: 'atan',
    LN: 'log', LOG: 'log10', EXP: 'exp',
};
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

// ── Comparison / selection / range ──────────────────────────────────────────
// ⚠️ Neither path uses kroncompare.h's KRON_GT/KRON_LIMIT/KRON_SEL… any more:
// they dispatch with `_Generic` on ONE argument, so `GT(5, r_real)` compared
// as int32 and `LIMIT(0, x_real, 100)` truncated. The ladder emits plain C
// operators / conditionals (transpileLDLogics); ST emits typed conditionals
// with single-evaluation temps (stExpr.js).
// splitTopLevelArgs splits an argument list on commas that are NOT inside
// nested parentheses or brackets. String literals are already placeholder
// tokens by the time this runs, so no quote handling is needed.
const splitTopLevelArgs = (inner) => {
    const args = [];
    let depth = 0, cur = '';
    for (const ch of inner) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim() !== '' || args.length > 0) args.push(cur);
    return args.map(a => a.trim()).filter(a => a !== '');
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
// The PDO macro's own spelling for a name written in any case, else null.
const ecPdoCanon = (name) => {
    const l = String(name || '').toLowerCase();
    for (const n of EC_PDO_VAR_NAMES) if (n.toLowerCase() === l) return n;
    return null;
};

// Member tables of user FB types and structure UDTs (lowercased lookups) —
// see canonMemberPath.
const buildMemberCtx = (ps) => {
    const types = new Map();
    const add = (typeName, vars) => {
        const n = String(typeName || '').trim().replace(/\s+/g, '_');
        if (!n) return;
        const members = new Map();
        (vars || []).forEach(v => {
            const vn = String(v?.name || '').trim().replace(/\s+/g, '_');
            if (vn) members.set(vn.toLowerCase(), { name: vn, type: v.type, inout: isInOutClass(v) });
        });
        types.set(n.toLowerCase(), { name: n, members });
    };
    (ps?.functionBlocks || []).forEach(fb => add(fb.name, fb.content?.variables));
    (ps?.dataTypes || []).forEach(dt => { if (dt?.type === 'Structure') add(dt.name, dt.content?.members); });
    // ARRAY data types: element type + dimension count, so an assignment to
    // `arr[i]` / `arr[i].member` can tell whether its target is STRING storage.
    const arrays = new Map();
    (ps?.dataTypes || []).forEach(dt => {
        if (dt?.type !== 'Array') return;
        const n = String(dt.name || '').trim().replace(/\s+/g, '_');
        if (n) arrays.set(n.toLowerCase(), { baseType: dt.content?.baseType, dims: (dt.content?.dimensions || []).length || 1 });
    });
    // ENUMERATED data types: type lower → declared name, value lower →
    // { name, type } (C enum constants are bare, file-scope identifiers).
    const enumTypes = new Map();
    const enumValues = new Map();
    (ps?.dataTypes || []).forEach(dt => {
        if (dt?.type !== 'Enumerated') return;
        const n = String(dt.name || '').trim();
        if (!n) return;
        enumTypes.set(n.toLowerCase(), n);
        (dt.content?.values || []).forEach(v => {
            const vn = String(v?.name || '').trim();
            if (vn) enumValues.set(vn.toLowerCase(), { name: vn, type: n });
        });
    });
    return { types, arrays, enumTypes, enumValues };
};


// `inst.member.member…` written in any case → the C member names. IEC is
// case-insensitive, C is not: `t2.q` on a TON is the field `Q`, and a member
// whose name is a C keyword is emitted under its mangled name (cIdent).
// Unknown types / members are left as written (clang then names them).
const canonMemberPath = (baseType, members, ctx) => {
    let t = String(baseType || '').trim();
    return members.map(m => {
        const info = t ? ctx?.types?.get(t.toLowerCase()) : null;
        if (info) {
            const mem = info.members.get(String(m).toLowerCase());
            t = mem ? String(mem.type || '').trim() : '';
            return mem ? cIdent(mem.name) : m;
        }
        if (t && (FB_OUTPUTS[t] || FB_INPUTS[t] || FB_TRIGGER_PIN[t])) {
            const fbt = t;
            t = '';
            return cStructPin(fbt, canonicalPinName(fbt, m));
        }
        t = '';
        return m;
    });
};

// Statically-known blocks that use EN as their power-flow pin but are REAL
// instance FBs backed by a struct + _Call (kronsystem.h) — the same exemption
// HAL_BLOCK_TYPES gives the dynamically-registered HAL blocks, except these are
// always present so they live in a permanent set. Without the exemption they
// would be treated as stateless inline math: no PlcState field, no instance, no
// shadow vars, and the LD path would fall into the inline branch that has no
// code generator for them.
// ⚠️ Every member needs a struct + `<Type>_Call(<Type>*)` reachable from a
// kron*.h in resources/krontek-include/ — otherwise the generated C references
// a type and a function that do not exist and the build fails at compile time.
const SYSTEM_FB_TYPES = new Set([
    // RTC / calendar
    'Read_System_Time', 'Read_System_Date', 'Read_Epoch_Time', 'Epoch_To_Date',
    // Clock-driven scheduling
    'Time_Switch', 'Daily_Trigger', 'Astro_Clock',
    // Runtime diagnostics
    'Read_Uptime', 'Cycle_Time_Monitor',
    // Host health + generic sysfs readers
    'Read_CPU_Temperature', 'Read_System_Load', 'Read_Disk_Free',
    'Read_Sys_File', 'Read_Hwmon',
    // TIME arithmetic. These are stateless, but they cannot take the inline
    // path: that branch dispatches by block name (comparisons, BITWISE_OP, MATH_FB_BLOCKS…)
    // and a name in none of those tables has nowhere to be emitted. They are
    // also why the block names avoid the X_TO_Y spelling — the ST expression
    // compiler maps that to KRON_<src>_TO_<dst>, which only resolves in the archive.
    'T_To_Ms', 'Ms_To_T', 'T_To_Sec', 'Sec_To_T',
    'Add_T', 'Sub_T', 'Mul_T', 'Div_T',
    // Signal generation (Blink/Debounce need no entry — their trigger is not EN)
    'Gen_Signal',
]);
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
    'LN': ['EN', 'IN'], 'LOG': ['EN', 'IN'], 'EXP': ['EN', 'IN'],
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
    'MC_Home': ['Execute', 'Position', 'BufferMode'],
    'MC_Stop': ['Execute', 'Deceleration', 'Jerk'],
    'MC_Halt': ['Execute', 'Deceleration', 'Jerk', 'BufferMode'],
    'MC_MoveAbsolute': ['Execute', 'ContinuousUpdate', 'Position', 'Velocity', 'Acceleration', 'Deceleration', 'Jerk', 'Direction', 'BufferMode'],
    'MC_MoveRelative': ['Execute', 'ContinuousUpdate', 'Distance', 'Velocity', 'Acceleration', 'Deceleration', 'Jerk', 'BufferMode'],
    'MC_MoveAdditive': ['Execute', 'ContinuousUpdate', 'Distance', 'Velocity', 'Acceleration', 'Deceleration', 'Jerk', 'BufferMode'],
    'MC_MoveVelocity': ['Execute', 'ContinuousUpdate', 'Velocity', 'Acceleration', 'Deceleration', 'Jerk', 'Direction', 'BufferMode'],
    'MC_MoveSuperimposed': ['Execute', 'ContinuousUpdate', 'Distance', 'VelocityDiff', 'Acceleration', 'Deceleration', 'Jerk'],
    'MC_HaltSuperimposed': ['Execute', 'Deceleration', 'Jerk'],
    'MC_SetPosition': ['Execute', 'Position', 'Relative', 'ExecutionMode'],
    'MC_SetOverride': ['Enable', 'VelFactor', 'AccFactor', 'JerkFactor'],
    'MC_Reset': ['Execute'],
    'MC_ReadParameter': ['Enable', 'ParameterNumber'],
    'MC_ReadBoolParameter': ['Enable', 'ParameterNumber'],
    'MC_WriteParameter': ['Execute', 'ParameterNumber', 'Value', 'ExecutionMode'],
    'MC_WriteBoolParameter': ['Execute', 'ParameterNumber', 'Value', 'ExecutionMode'],
    'MC_ReadActualPosition': ['Enable'],
    'MC_ReadActualVelocity': ['Enable'],
    'MC_ReadActualTorque': ['Enable'],
    'MC_ReadStatus': ['Enable'],
    'MC_ReadMotionState': ['Enable', 'Source'],
    'MC_ReadAxisInfo': ['Enable', 'HomeSwitchInput', 'LimitSwitchPosInput', 'LimitSwitchNegInput'],
    'MC_ReadAxisError': ['Enable'],
    // System / RTC / scheduling / diagnostics (kronsystem.h)
    'Read_System_Time': ['EN'],
    'Read_System_Date': ['EN'],
    'Read_Epoch_Time': ['EN'],
    'Epoch_To_Date': ['EN', 'EPOCH_MS', 'LOCAL'],
    'Time_Switch': ['EN', 'ON_H', 'ON_M', 'OFF_H', 'OFF_M', 'DAYS'],
    'Daily_Trigger': ['EN', 'H', 'M', 'S'],
    'Astro_Clock': ['EN', 'LAT', 'LON'],
    'Read_Uptime': ['EN'],
    'Cycle_Time_Monitor': ['EN', 'RESET'],
    'Hour_Meter': ['IN', 'RESET'],
    'Watchdog': ['KICK', 'PT'],
    'Read_CPU_Temperature': ['EN'],
    'Read_System_Load': ['EN'],
    'Read_Disk_Free': ['EN'],
    'Read_Sys_File': ['EN', 'PATH', 'POLL_MS'],
    'Read_Hwmon': ['EN', 'NAME', 'ATTR', 'POLL_MS'],
    'T_To_Ms': ['EN', 'IN'], 'Ms_To_T': ['EN', 'IN'],
    'T_To_Sec': ['EN', 'IN'], 'Sec_To_T': ['EN', 'IN'],
    'Add_T': ['EN', 'IN1', 'IN2'], 'Sub_T': ['EN', 'IN1', 'IN2'],
    'Mul_T': ['EN', 'IN', 'N'], 'Div_T': ['EN', 'IN', 'N'],
    'Blink': ['ENABLE', 'T_LOW', 'T_HIGH'],
    'Debounce': ['IN', 'PT'],
    'Gen_Signal': ['EN', 'MODE', 'PERIOD', 'AMPLITUDE', 'OFFSET'],
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
    'MC_MoveVelocity', 'MC_MoveSuperimposed', 'MC_HaltSuperimposed',
    'MC_SetPosition', 'MC_SetOverride', 'MC_Reset',
    'MC_ReadParameter', 'MC_ReadBoolParameter',
    'MC_WriteParameter', 'MC_WriteBoolParameter',
    'MC_ReadActualPosition', 'MC_ReadActualVelocity', 'MC_ReadActualTorque',
    'MC_ReadStatus', 'MC_ReadMotionState', 'MC_ReadAxisInfo', 'MC_ReadAxisError',
]);

// Output pin types for the PLCopen motion FBs. REQUIRED: getOutputPinType's
// generic rules key off pin NAMES and fall through to BOOL, so without this
// table `MC_ReadActualPosition.Position` got a BOOL shadow var and every REAL
// reading collapsed to 0/1 — and every `ErrorID` (uint16_t in kronmotion.h)
// published a single bit. Keys must match the FB_OUTPUTS entries exactly.
const MOTION_FB_OUTPUT_TYPES = {};
[...MOTION_FB_AXIS_PARAM].forEach(k => { MOTION_FB_OUTPUT_TYPES[k] = { 'ErrorID': 'WORD' }; });
// ⚠️ LREAL, not REAL: every numeric pin in kronmotion.h is a `double` (the
// trajectory core works in double; a float position accumulator drifts visibly
// on a long-travel axis). A REAL shadow var would silently halve the precision.
Object.assign(MOTION_FB_OUTPUT_TYPES, {
    'MC_MoveSuperimposed':   { 'ErrorID': 'WORD', 'CoveredDistance': 'LREAL' },
    'MC_ReadParameter':      { 'ErrorID': 'WORD', 'Value': 'LREAL' },
    'MC_ReadBoolParameter':  { 'ErrorID': 'WORD', 'Value': 'BOOL' },
    'MC_ReadActualPosition': { 'ErrorID': 'WORD', 'Position': 'LREAL' },
    'MC_ReadActualVelocity': { 'ErrorID': 'WORD', 'Velocity': 'LREAL' },
    'MC_ReadActualTorque':   { 'ErrorID': 'WORD', 'Torque': 'LREAL' },
    'MC_ReadAxisError':      { 'ErrorID': 'WORD', 'AxisErrorID': 'WORD' },
});

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
    for (const k of (FB_INPUTS[fbType] || [])) {
        if (k.toLowerCase() === lower) return k;
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
    // STRING pins: no writable shadow var (collectInputShadowVars skips the
    // type) — the literal is emitted as a C string every scan, see resolveVal.
    'Read_Sys_File': { 'PATH': 'STRING', 'POLL_MS': 'UDINT' },
    'Read_Hwmon': { 'NAME': 'STRING', 'ATTR': 'STRING', 'POLL_MS': 'UDINT' },
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
    // System / RTC / scheduling / diagnostics (kronsystem.h)
    'Epoch_To_Date':      { 'EPOCH_MS': 'LINT', 'LOCAL': 'BOOL' },
    'Time_Switch':        { 'ON_H': 'USINT', 'ON_M': 'USINT', 'OFF_H': 'USINT', 'OFF_M': 'USINT', 'DAYS': 'BYTE' },
    'Daily_Trigger':      { 'H': 'USINT', 'M': 'USINT', 'S': 'USINT' },
    'Astro_Clock':        { 'LAT': 'REAL', 'LON': 'REAL' },
    'Cycle_Time_Monitor': { 'RESET': 'BOOL' },
    'Hour_Meter':         { 'RESET': 'BOOL' },
    'Watchdog':           { 'PT': 'TIME' },
    'T_To_Ms':            { 'IN': 'TIME' },
    'Ms_To_T':            { 'IN': 'DINT' },
    'T_To_Sec':           { 'IN': 'TIME' },
    'Sec_To_T':           { 'IN': 'REAL' },
    'Add_T':              { 'IN1': 'TIME', 'IN2': 'TIME' },
    'Sub_T':              { 'IN1': 'TIME', 'IN2': 'TIME' },
    'Mul_T':              { 'IN': 'TIME', 'N': 'REAL' },
    'Div_T':              { 'IN': 'TIME', 'N': 'REAL' },
    'Blink':              { 'T_LOW': 'TIME', 'T_HIGH': 'TIME' },
    'Debounce':           { 'PT': 'TIME' },
    'Gen_Signal':         { 'MODE': 'USINT', 'PERIOD': 'TIME', 'AMPLITUDE': 'REAL', 'OFFSET': 'REAL' },
};
// EtherCAT diagnostics. Without these the non-trigger pins get no writable
// input shadow var, so — unlike every other FB — a literal typed into
// SlaveAddress/Index/SubIndex could not be monitored or forced from the editor,
// and an LD auto-declare on such a pin had no type to work from.
FB_INPUT_TYPES['EC_GetSlaveState'] = { 'SlaveAddress': 'UINT' };
FB_INPUT_TYPES['EC_ReadSDO']       = { 'SlaveAddress': 'UINT', 'Index': 'WORD', 'SubIndex': 'BYTE', 'ByteSize': 'BYTE' };
FB_INPUT_TYPES['EC_WriteSDO']      = { 'SlaveAddress': 'UINT', 'Index': 'WORD', 'SubIndex': 'BYTE', 'ByteSize': 'BYTE', 'Value': 'DWORD' };

// Motion control: all MC_* FBs take Axis: AXIS_REF
[...MOTION_FB_AXIS_PARAM].forEach(k => { FB_INPUT_TYPES[k] = { 'Axis': 'AXIS_REF' }; });
// Populate conversion entries for FB_INPUTS (must be after FB_INPUTS definition)
_CONV_TYPES.forEach(src => _CONV_TYPES.forEach(dst => {
    if (src !== dst) FB_INPUTS[`${src}_TO_${dst}`] = ['EN', 'IN'];
}));


const transpileSTLogics = (code, stdFunctions = {}, parentName = '', category = 'program', varMap = {}, varTypeMap = {}, userFBTypes = new Set(), opts = {}) => {
    if (!code) return `    // ST Implementation Empty\n`;
    const {
        fnReturnVar = null, userFBInputs = {},
        strConv = null, memberCtx = null, labelSeq = { next: 0 }, fnResult = null,
        userFunctionDefs = new Map(), exprSeq = { next: 0 },
        stringFnReturn = null,
    } = opts;
    // Case-insensitive type lookup (IEC identifiers are case-insensitive).
    const varTypeLower = new Map(Object.entries(varTypeMap).map(([k, v]) => [k.toLowerCase(), v]));
    const typeOfName = (n) => varTypeLower.get(String(n || '').toLowerCase());


    // Strip IEC 61131-3 comments and VAR…END_VAR blocks before splitting:
    //   (* block comments — single or multi-line *)
    //   // line comments
    //   VAR … END_VAR (inline variable declarations — already declared in variable table)
    // ⚠️ Comments go BEFORE the keyword normalization below — otherwise an ST
    // keyword inside a comment (the word "of" in "period of 1 second") matches
    // \bOF\b, gets a newline injected, and the comment's tail leaks into C.
    // String literals become `\x0e<n>\x0f` placeholders for the same reason
    // (`'go THEN stop'` must not be split); the expression tokenizer reads them.
    const strTable = [];
    const restoreStr = (t) => String(t).replace(/\x0e(\d+)\x0f/g, (_, i) => strTable[+i]);
    const stripped = stripIecComments(code, { strTable })
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
        .replace(/\bREPEAT\b[ \t]*(?=[^\r\n;])/gi, 'REPEAT\n')
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
        .replace(/;[ \t]*(?=(?:IF|CASE|FOR|WHILE|REPEAT|RETURN|EXIT|CONTINUE)\b)/gi, ';\n');

    // Join continuation lines: a line ending with AND/OR/NOT/XOR, an arithmetic
    // operator (+ - * /), a comparison operator (< > <= >= <>), comma, or
    // open-paren (after stripping comment) means the expression continues on
    // the next line.  Merge them so the keyword matchers (IF…THEN, ELSIF…THEN,
    // WHILE…DO, FOR…DO) see a single line.
    const rawLines = normalized.split(/\r?\n|\\n/);
    const lines = [];
    let pending = '';
    // A physical line that STARTS with a binary operator also continues the
    // previous statement, e.g.:
    //   angle_raw := a * 128
    //              + b / 2;
    //   ready := motor_ok
    //          AND NOT fault;
    // No valid ST statement begins with a binary operator, so once CASE
    // labels (bare `n:` / `name:`) are excluded this is unambiguous. The
    // trailing-operator check above only catches the operator at the END of
    // the PREVIOUS line — it cannot see one leading the NEXT line, which is
    // an equally common way to break a long expression and was silently
    // mis-transpiled into two statements (the tail became a discarded,
    // unused-value expression and its term never reached the assignment).
    const LEADING_OP_RE = /^(?:AND|OR|XOR|NOT|MOD|BAND|BOR|BXOR)\b|^(?:<=|>=|<>|[+\-*/<>=])/i;
    const looksLikeLabel = s => /:(?!=)/.test(s);
    const endsOpenBlock = s => /\b(?:THEN|DO|OF|ELSE)$/i.test(s);
    for (const raw of rawLines) {
        const trimRaw = raw.trim();
        if (!trimRaw) {
            if (pending) { /* skip blank continuation lines */ }
            else lines.push(raw);
            continue;
        }
        if (!pending && lines.length && LEADING_OP_RE.test(trimRaw) && !looksLikeLabel(trimRaw)) {
            const prev = lines[lines.length - 1].trim();
            if (prev && !prev.endsWith(';') && !endsOpenBlock(prev) && !looksLikeLabel(prev)) {
                pending = lines.pop().trim();
            }
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
    // the expression compiler (which refuses `:=` inside an expression).
    const splitCaseLabels = () => {
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
    };
    splitCaseLabels();

    // Split lines that pack multiple `;`-separated statements onto one physical
    // line, e.g. the body of a single-line `IF … THEN fb(); x := 1; END_IF`
    // (after control-keyword normalization the body survives as
    // `fb(); x := 1;`). The FB-call detector (regex anchored with `$`) matches
    // a WHOLE line as exactly one `inst(args);` call, so a trailing second
    // statement made it fall through to the expression path — which mangled a named
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
    // Again: the `;` split can expose a new `label: body` line
    // (`1: EXIT; 2: CONTINUE;` → `2: CONTINUE;`), whose body must reach the
    // statement handlers rather than be emitted as an expression.
    splitCaseLabels();

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

    // IEC name (any case) → C symbol.
    const varMapLower = {};
    Object.keys(varMap).forEach(name => { varMapLower[name.toLowerCase()] = varMap[name]; });

    // ── Expression compiler (stExpr.js) ────────────────────────────────────
    // Every expression below — conditions, right-hand sides, call arguments,
    // CASE selectors, FOR bounds, indexes, assignment targets — is parsed and
    // typed there; this function only keeps the statement structure.
    const fbTypeOf = (t) => {
        const ty = String(t || '').trim();
        return !!ty && (stdFunctions[ty]?.isFB === true || HAL_BLOCK_TYPES.has(ty) || userFBTypes.has(ty)
            || (ty in FB_TRIGGER_PIN && !isInlineMathType(ty)));
    };
    const userFbLower = new Set([...userFBTypes].map(n => String(n).toLowerCase()));
    const stdFbLower = new Map(Object.keys(FB_TRIGGER_PIN).concat(Object.keys(FB_OUTPUTS), Object.keys(stdFunctions).filter(k => stdFunctions[k]?.isFB))
        .filter(k => !isInlineMathType(k)).map(k => [k.toLowerCase(), k]));
    const exprEnv = {
        H: {
            iecNumberToC, mapIECtoTimeUs, iecStringDecode, cEscapeString, cIdent, mapType, rotateExpr,
            IEC_KRON_NAME, strConvSymbol, STRING_SHM_BYTES,
        },
        strTable,
        lookupVar: (name) => {
            const l = String(name).toLowerCase();
            if (fnResult && l === String(fnResult.name).toLowerCase() && varMapLower[l] !== undefined) {
                return { c: varMapLower[l], t: fnResult.type || null };
            }
            const c = varMapLower[l];
            if (c === undefined) return null;
            return { c, t: typeOfName(name) ?? null };
        },
        enumMember: (name) => memberCtx?.enumValues?.get(String(name).toLowerCase()) || null,
        enumTypes: memberCtx?.enumTypes || new Map(),
        memberCtx,
        stdMember: (t, m) => {
            if (!(FB_OUTPUTS[t] || FB_INPUTS[t] || FB_TRIGGER_PIN[t] || FB_INPUT_TYPES[t] || stdFunctions[t]?.isFB)) return null;
            const pin = canonicalPinName(t, m);
            const pt = stdPinTypeForExpr(t, pin);
            // A standard block's STRING INPUT is a `const char *` re-pointed
            // every scan — assigned with `=`, never copied into.
            return { c: cStructPin(t, pin), t: pt, ptrStr: isStringInputType(pt) && FB_INPUT_TYPES[t]?.[pin] !== undefined };
        },
        isFbTypeName: (n) => userFbLower.has(String(n).toLowerCase()) || stdFbLower.has(String(n).toLowerCase()),
        isFbInstance: (n) => fbTypeOf(typeOfName(n)),
        userFunctions: userFunctionDefs,
        strConv,
        seq: exprSeq,
        decls: [],
        fnResult,
    };
    const X = createSTExprCompiler(exprEnv);
    // The emitter parenthesises every operation; where the C syntax already
    // supplies the parentheses (`if (…)`, `switch (…)`) the outer pair goes,
    // or clang warns about `if ((a == b))`.
    const stripOuter = (c) => {
        if (!c.startsWith('(') || !c.endsWith(')')) return c;
        let d = 0;
        for (let i = 0; i < c.length; i++) {
            if (c[i] === '(') d++;
            else if (c[i] === ')' && --d === 0 && i !== c.length - 1) return c;
        }
        return c.slice(1, -1);
    };
    const exprC = (text) => X.expr(text).c;
    const condC = (text, what) => {
        const r = X.expr(text);
        if (r.t !== null && r.t !== 'BOOL' && !(r.t === '#INT' && (r.lit === 0n || r.lit === 1n))) {
            throw new STExprError(`${what} condition must be BOOL, got ${r.t.startsWith('#') ? 'a literal' : r.t}`);
        }
        return stripOuter(r.c);
    };
    // Top-level `;` / `:=` splitting (depth- and quote-aware).
    const splitTop = (text, sep) => {
        const parts = [];
        let cur = '', depth = 0, q = null;
        const t = String(text);
        for (let i = 0; i < t.length; i++) {
            const ch = t[i];
            if (q) { cur += ch; if (ch === '$') { cur += t[++i] ?? ''; } else if (ch === q) q = null; continue; }
            if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
            if (ch === '(' || ch === '[') depth++;
            else if ((ch === ')' || ch === ']') && depth > 0) depth--;
            if (depth === 0 && t.startsWith(sep, i)) { parts.push(cur); cur = ''; i += sep.length - 1; continue; }
            cur += ch;
        }
        parts.push(cur);
        return parts;
    };
    // One ST statement line (assignments and/or calls) → C, no trailing `;`.
    const stmtC = (text) => splitTop(text, ';')
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => {
            const parts = splitTop(p, ':=');
            if (parts.length >= 2) return X.assign(parts[0], parts.slice(1).join(':='));
            return X.callStatement(p);
        })
        .join('; ');

    // Errors name the POU, an approximate source line and the statement.
    const locate = (stmt) => {
        const probe = restoreStr(stmt).trim().slice(0, 24);
        const at = probe ? String(code).indexOf(probe) : -1;
        return at < 0 ? '' : `, line ${String(code).slice(0, at).split('\n').length}`;
    };
    const kindLabel = { program: 'PROGRAM', function_block: 'FUNCTION_BLOCK', function: 'FUNCTION' }[category] || 'POU';

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            emitLine(trimmed);
        } catch (e) {
            if (e?.stLocated) throw e;
            const msg = String(e?.message || e).replace(/^ST:\s*/, '');
            const err = new Error(`ST ${kindLabel} ${parentName}${locate(trimmed)}: ${msg} — in "${restoreStr(trimmed)}"`);
            err.stLocated = true;
            throw err;
        }
    });
    if (exprEnv.decls.length) out = exprEnv.decls.map(d => `    ${d}\n`).join('') + out;

    return out || `    // ST parsing placeholder\n`;

    function emitLine(trimmed) {

        // ── CASE x OF ────────────────────────────────────────────────────
        const caseOfMatch = trimmed.match(/^CASE\s+(.+?)\s+OF\s*;?\s*$/i);
        if (caseOfMatch) {
            out += `${indent()}switch (${stripOuter(exprC(caseOfMatch[1]))}) {\n`;
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
                    let cl = stmtC(elseBody);
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
                    let cl = stmtC(bodyPart);
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
            const frame = topKind() === 'FOR' ? topFrame() : null;
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}}\n`;
            // The hidden-counter FOR is wrapped in its own block (see FOR below).
            if (frame?.wrapped) { indentLevel = Math.max(1, indentLevel - 1); out += `${indent()}}\n`; }
            if (frame?.exitLabel) out += `${indent()}${frame.exitLabel}: ;\n`;
            popIfTop('FOR');
            return;
        }
        if (/^END_WHILE\s*;?$/i.test(trimmed)) {
            const frame = topKind() === 'WHILE' ? topFrame() : null;
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}}\n`;
            if (frame?.exitLabel) out += `${indent()}${frame.exitLabel}: ;\n`;
            popIfTop('WHILE');
            return;
        }
        // REPEAT … UNTIL c; END_REPEAT — the loop already closed at UNTIL, so
        // END_REPEAT itself emits nothing (it used to reach C verbatim).
        if (/^END_REPEAT\s*;?$/i.test(trimmed)) {
            if (topKind() === 'REPEAT') throw new Error('ST: END_REPEAT without UNTIL <condition>.');
            return;
        }

        // ── ELSIF / ELSE IF (check before standalone ELSE) ────────────────
        const elsifMatch = trimmed.match(/^(?:ELSIF|ELSE\s+IF)\s+(.+?)\s+THEN\s*;?\s*$/i);
        if (elsifMatch) {
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}} else if (${condC(elsifMatch[1], 'ELSIF')}) {\n`;
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
            out += `${indent()}if (${condC(ifMatch[1], 'IF')}) {\n`;
            indentLevel++;
            blockStack.push({ kind: 'IF' });
            return;
        }

        // ── FOR ... TO ... BY ... DO (BY clause first — more specific) ────
        // ⚠️ The loop runs on a HIDDEN int64_t counter and assigns the control
        // variable at the top of every iteration. Iterating the control
        // variable itself never terminated whenever `end` is the top of its
        // type: `FOR k := 0 TO 255` on a USINT wraps 255 → 0 and `<= 255`
        // holds for ever; an unsigned count-down to 0 likewise. End and step
        // are evaluated once, before the first iteration (IEC forbids the
        // body from changing them). After the loop the control variable holds
        // the last value it was given (IEC leaves it implementation-defined).
        const forHeader = (vn, start, end, step) => {
            const cv = X.lvalue(vn).c;
            const n = labelSeq.next++;
            const i = `__for_i${n}`, e = `__for_e${n}`, st = `__for_s${n}`;
            const stepExpr = step === null ? '1' : exprC(step).trim();
            let cond;
            if (/^\+?\s*\d+(?:\.\d+)?$/.test(stepExpr)) cond = `${i} <= ${e}`;
            else if (/^-\s*\d+(?:\.\d+)?$/.test(stepExpr)) cond = `${i} >= ${e}`;
            else cond = `(${st} >= 0 ? ${i} <= ${e} : ${i} >= ${e})`;
            out += `${indent()}{\n`;
            indentLevel++;
            out += `${indent()}const int64_t ${e} = (int64_t)(${exprC(end)});\n`;
            out += `${indent()}const int64_t ${st} = (int64_t)(${stepExpr});\n`;
            out += `${indent()}for (int64_t ${i} = (int64_t)(${exprC(start)}); ${cond}; ${i} += ${st}) {\n`;
            indentLevel++;
            out += `${indent()}${cv} = (__typeof__(${cv}))${i};\n`;
            blockStack.push({ kind: 'FOR', wrapped: true });
        };
        const forByMatch = trimmed.match(/^FOR\s+(\w+)\s*:=\s*(.+?)\s+TO\s+(.+?)\s+BY\s+(.+?)\s+DO\s*;?\s*$/i);
        if (forByMatch) {
            const [, vn, start, end, step] = forByMatch;
            forHeader(vn, start, end, step);
            return;
        }

        // ── FOR ... TO ... DO ─────────────────────────────────────────────
        const forMatch = trimmed.match(/^FOR\s+(\w+)\s*:=\s*(.+?)\s+TO\s+(.+?)\s+DO\s*;?\s*$/i);
        if (forMatch) {
            const [, vn, start, end] = forMatch;
            forHeader(vn, start, end, null);
            return;
        }

        // ── WHILE ... DO ──────────────────────────────────────────────────
        const whileMatch = trimmed.match(/^WHILE\s+(.+?)\s+DO\s*;?\s*$/i);
        if (whileMatch) {
            out += `${indent()}while (${condC(whileMatch[1], 'WHILE')}) {\n`;
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
            const frame = topKind() === 'REPEAT' ? topFrame() : null;
            indentLevel = Math.max(1, indentLevel - 1);
            out += `${indent()}} while (!(${condC(untilMatch[1], 'UNTIL')}));\n`;
            if (frame?.exitLabel) out += `${indent()}${frame.exitLabel}: ;\n`;
            popIfTop('REPEAT');
            return;
        }

        // ── EXIT → break / goto ───────────────────────────────────────────
        // ⚠️ A C `break` leaves the innermost switch OR loop, IEC EXIT always
        // leaves the loop: EXIT inside a CASE inside a FOR only ended the
        // switch and the loop kept going. With a CASE between the EXIT and its
        // loop, jump to a label placed right after that loop instead.
        if (/^EXIT\s*;?\s*$/i.test(trimmed)) {
            let loopIdx = -1, crossesCase = false;
            for (let k = blockStack.length - 1; k >= 0; k--) {
                const kind = blockStack[k].kind;
                if (kind === 'FOR' || kind === 'WHILE' || kind === 'REPEAT') { loopIdx = k; break; }
                if (kind === 'CASE') crossesCase = true;
            }
            if (loopIdx < 0) throw new Error('ST: EXIT outside of a FOR / WHILE / REPEAT loop.');
            if (crossesCase) {
                const loop = blockStack[loopIdx];
                if (!loop.exitLabel) loop.exitLabel = `__exit_${labelSeq.next++}`;
                out += `${indent()}goto ${loop.exitLabel};\n`;
            } else {
                out += `${indent()}break;\n`;
            }
            return;
        }
        // CONTINUE → continue (a C switch does not capture `continue`).
        if (/^CONTINUE\s*;?\s*$/i.test(trimmed)) {
            if (!blockStack.some(f => ['FOR', 'WHILE', 'REPEAT'].includes(f.kind))) {
                throw new Error('ST: CONTINUE outside of a FOR / WHILE / REPEAT loop.');
            }
            out += `${indent()}continue;\n`;
            return;
        }

        // ── RETURN ────────────────────────────────────────────────────────
        if (/^RETURN\b/i.test(trimmed)) {
            const retVal = trimmed.replace(/^RETURN\s*/i, '').replace(/;$/, '').trim();
            if (retVal && fnResult?.isString) {
                // Copied into the result buffer: `RETURN local;` would
                // otherwise hand back a pointer into this call's stack frame.
                out += `${indent()}{ ${X.assign(fnResult.name, retVal)}; ${stringFnReturn} }\n`;
            } else if (retVal) {
                out += `${indent()}return ${exprC(retVal)};\n`;
            } else if (fnResult?.isString) {
                out += `${indent()}${stringFnReturn}\n`;
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
            // Case-insensitive: `T1(…)` calls the instance declared `t1`.
            const fbType = typeOfName(instName);
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
                const cInst = varMapLower[instName.toLowerCase()];
                // User FB: pin names resolve through its declared variables
                // (any case, C-keyword names mangled); InOut pins get a
                // copy-back after the call.
                const userFbInfo = userFBTypes.has(fbType) ? memberCtx?.types?.get(String(fbType).toLowerCase()) : null;
                const pinMember = (pin) => {
                    if (userFbInfo) {
                        const mem = userFbInfo.members.get(String(pin).toLowerCase());
                        if (!mem) throw new Error(`ST: ${fbType} has no pin "${pin}" (call on ${instName}).`);
                        return cIdent(mem.name);
                    }
                    return cStructPin(fbType, canonicalPinName(fbType, pin));
                };
                const inOutCopyBack = [];
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
                // Same interlock as the ladder path — see the note there.
                const motionLockAt = isMotion ? out.length : -1;
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
                        const target  = restoreStr(outM[2].trim());
                        const member  = pinMember(userPin);
                        // A STRING output is copied into the target's own array.
                        const outType = userFbInfo
                            ? userFbInfo.members.get(userPin.toLowerCase())?.type
                            : stdPinTypeForExpr(fbType, canonicalPinName(fbType, userPin));
                        outputCaptures.push(X.assignC(target, `${cInst}.${member}`, outType ?? null));
                        return;
                    }
                    const m = a.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([\s\S]+)$/);
                    if (!m) return;
                    const userPin  = m[1];
                    const rawValue = restoreStr(m[2].trim());
                    const pinName  = canonicalPinName(fbType, userPin);

                    // Motion FB Axis pin: passed as 2nd Call arg, not a struct field
                    if (isMotion && pinName === 'Axis') {
                        axisExpr = IDENTIFIER_REF_REGEX.test(rawValue)
                            ? `&(${X.lvalue(rawValue).c})`
                            : exprC(rawValue);
                        return;
                    }

                    const inputType = FB_INPUT_TYPES[fbType]?.[pinName];
                    let value;
                    if (pinName === 'Port_ID') {
                        const portNum = resolveHardwarePortSymbol(rawValue);
                        value = portNum !== null ? portNum : exprC(rawValue);
                    } else if (isPointerInputType(inputType)) {
                        if (/^NULL$/i.test(rawValue)) value = 'NULL';
                        else if (IDENTIFIER_REF_REGEX.test(rawValue)) value = `&(${X.lvalue(rawValue).c})`;
                        else value = exprC(rawValue);
                    } else {
                        // A TIME pin included: a T#/TIME# literal and a
                        // variable/expression both go through the compiler
                        // (`PT := myDelay` once became the literal 10000).
                        const userMemT = userFbInfo?.members.get(userPin.toLowerCase())?.type;
                        value = X.value(rawValue, userMemT ?? inputType ?? null, `${instName}.${userPin}`);
                    }

                    const member = pinMember(userPin);
                    // A user FB's STRING pin is an array member: copy into it.
                    // (A standard block's STRING pin is a `const char *`
                    // assigned here every scan — a plain `=` is right there.)
                    const userMem = userFbInfo?.members.get(userPin.toLowerCase());
                    const memIsString = isStringInputType(userMem?.type);
                    out += memIsString
                        ? `${indent()}${kronStrset(`${cInst}.${member}`, value)};\n`
                        : `${indent()}${cInst}.${member} = ${value};\n`;
                    // ⚠️ VAR_IN_OUT: the FB works on its own copy of the
                    // variable, so the result has to be written back after the
                    // call or the caller never sees the change.
                    if (userMem?.inout) {
                        if (!IDENTIFIER_REF_REGEX.test(rawValue)) {
                            throw new Error(`ST: ${fbType}.${userPin} is VAR_IN_OUT and must be given a variable, got "${rawValue}".`);
                        }
                        inOutCopyBack.push(X.assignC(rawValue, `${cInst}.${member}`, userMem.type ?? null));
                    }
                });

                if (isMotion) {
                    out += `${indent()}${fbType}_Call(&${cInst}, ${axisExpr || 'NULL'});\n`;
                    out = out.slice(0, motionLockAt) + `${indent()}KRON_AXIS_LOCK();\n`
                        + out.slice(motionLockAt) + `${indent()}KRON_AXIS_UNLOCK();\n`;
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

                inOutCopyBack.forEach(stmt => { out += `${indent()}${stmt};\n`; });
                outputCaptures.forEach(stmt => { out += `${indent()}${stmt};\n`; });
                return;
            }
        }

        // ── Regular statement (assignment, function call, etc.) ───────────
        let cl = stmtC(trimmed);
        if (!cl.endsWith(';')) cl += ';';
        out += `${indent()}${cl}\n`;
    }
};

const transpileLDLogics = (rungs, stdFunctions = {}, parentName = '', category = 'program', globalVarNames = [], inputShadowMap = null, rungIdxOffset = 0, cSymTypeMap = {}, localVarNames = new Set(), fbInstanceNames = new Set(), ldCtx = {}) => {
    if (!rungs || rungs.length === 0) return `    // LD Implementation Empty\n`;

    let out = '';
    const { memberCtx = null, nameTypes = new Map(), fnPtrParams = new Set(), declaredCanon = new Map() } = ldCtx || {};

    // IEC type of a resolved C operand, or null when unknown: a float literal
    // is REAL, an integer literal DINT (LINT past the int32 range), a
    // variable whatever cSymTypeMap says (keyed by the exact resolved text —
    // see buildCSymTypeMap), a cast `((T)(…))` its type.
    const operandType = (val) => {
        if (!val) return null;
        const v = String(val).trim();
        if (/^-?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v) || /^-?\d+[eE][+-]?\d+$/.test(v)) return 'REAL';
        if (/^-?(?:\d+|0[xX][0-9A-Fa-f]+)$/.test(v)) {
            const n = Number(v.replace(/^-?0[xX]/, m => (m.startsWith('-') ? '-0x' : '0x')));
            return Number.isFinite(n) && (n > 2147483647 || n < -2147483648) ? 'LINT' : 'DINT';
        }
        if (v === 'true' || v === 'false') return 'BOOL';
        if (cSymTypeMap[v]) return String(cSymTypeMap[v]).toUpperCase();
        const cast = /^\(\((\w+)\)\(/.exec(v);
        if (cast) {
            const hit = Object.entries(IEC_SCALAR_C).find(([, c]) => c === cast[1]);
            if (hit) return hit[0];
        }
        return null;
    };
    const isRealExpr = (val) => ['REAL', 'LREAL'].includes(operandType(val));

    // Resolve a variable/signal name to its C symbol, respecting scope.
    // Handles simple names, array elements (var[idx]), struct members (var.member),
    // FB-instance output access (blink.Q → …_inst_blink.Q).
    const resolveVar = (varName) => {
        if (!varName) return null;
        const s = varName.trim();
        // Split base name from suffix (array index or struct member access)
        const sepIdx = s.search(/[[.]/);
        const typedBase = (sepIdx >= 0 ? s.slice(0, sepIdx) : s).replace(/\s+/g, '_');
        // IEC names are case-insensitive: resolve to the DECLARED spelling.
        const baseName = declaredCanon.get(typedBase.toLowerCase()) || typedBase;
        let suffix = sepIdx >= 0 ? s.slice(sepIdx) : '';
        // `blink.q` → `blink.Q`, `fb.count` → the declared member spelling.
        if (/^\.[A-Za-z_]/.test(suffix)) {
            const m = /^((?:\.[A-Za-z_][A-Za-z0-9_]*)+)([\s\S]*)$/.exec(suffix);
            const t = nameTypes.get(baseName.toLowerCase());
            if (m && t) {
                suffix = canonMemberPath(t, m[1].split('.').filter(Boolean), memberCtx).map(x => '.' + x).join('') + m[2];
            }
        }
        // EtherCAT PDO variables have no PlcState field — leave the name BARE
        // so the GPI access macro (#define ec_X (__gpi_snap->…)) applies.
        const ecName = ecPdoCanon(baseName);
        if (ecName && !localVarNames.has(baseName)) {
            return ecName + suffix;
        }
        if (category === 'program') {
            // All state lives in PlcState (hot-swap): globals and local program
            // vars are both fields reached via S->.
            if (globalVarNames.includes(baseName)) return `S->${cIdent(baseName)}${suffix}`;
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
                return `S->${cIdent(baseName)}${suffix}`;
            }
            return `instance->${cIdent(baseName)}${suffix}`;
        }
        // FUNCTION: params/locals are plain C names; VAR_IN_OUT is a pointer.
        if (!localVarNames.has(baseName) && globalVarNames.includes(baseName)) return `S->${cIdent(baseName)}${suffix}`;
        return fnPtrParams.has(baseName) ? `(*${cIdent(baseName)})${suffix}` : `${cIdent(baseName)}${suffix}`;
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
        if (isTimeLiteral(s)) {
            return mapIECtoTimeUs(s).toString();
        }
        // Quoted STRING literal ('…' IEC, "…" also accepted) → C string
        const strLit = quotedStringToC(s);
        if (strLit !== null) return strLit;
        // Typed literal `INT#5`, `REAL#1.5`, `DWORD#16#FF` → cast of the value.
        const typed = /^([A-Za-z]+)#(.+)$/.exec(s);
        if (typed && IEC_SCALAR_C[typed[1].toUpperCase()] && !/^(?:L?T|L?TIME)$/i.test(typed[1])) {
            const inner = resolveVal(typed[2]);
            if (inner === null) return null;
            return `((${IEC_SCALAR_C[typed[1].toUpperCase()]})(${inner}))`;
        }
        // IEC radix / underscore literals: 16#FF_FF, 2#1010, 8#17, 1_000.
        if (/^-?(?:(?:2|8|10|16)#[0-9A-Fa-f_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)$/.test(s) && (/[#_]/.test(s) || /^-?0\d/.test(s))) {
            const neg = s.startsWith('-');
            const c = iecNumberToC(neg ? s.slice(1) : s);
            if (c !== null) return (neg ? '-' : '') + c;
        }
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
        if (isStringInputType(pinMeta.type)) {
            // Quoted text is always a literal. Bare text resolves to a variable
            // ONLY if one is actually declared under that name — otherwise it is
            // the text itself. Reading a bare word as an undeclared variable
            // turned `NAME := pwmfan` into a BOOL auto-declared behind the
            // user's back, and a path only escaped that because of its slashes.
            const quoted = quotedStringToC(cleanValue);
            if (quoted !== null) return quoted;
            const base = cleanValue.split(/[.[]/)[0];
            const declared = IDENTIFIER_REF_REGEX.test(cleanValue) &&
                (localVarNames.has(base) || fbInstanceNames.has(base) || globalVarNames.includes(base));
            return declared ? resolveVar(cleanValue) : iecStringToC(cleanValue);
        }
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
        if (!localVarNames.has(i) && globalVarNames.includes(i)) return `S->${cIdent(i)}`;
        if (category === 'program') return `S->prog_${parentName}_inst_${i}`;
        if (category === 'function_block') return `instance->${cIdent(i)}`;
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

        // Sorted block indices whose math result lives in a rung-local scalar
        // `_m_r<r>_b<i>_rout` (every non-int32 path) rather than a kronmath struct.
        const realInlineBlocks = new Set();
        // sorted block index → IEC type of an inline block's result, so a block
        // wired to it picks the right arithmetic width too.
        const inlineOutType = new Map();

        // ⚠️ Stateless inline blocks (X_TO_Y conversions, MIN/MAX/LIMIT/SEL/MUX,
        // bitwise, comparisons) get NO PlcState instance — they are emitted as a
        // pure C expression. So when their OUT/Q pin is WIRED into another
        // block's data input, the consumer must substitute that expression, not
        // read `<instance>.OUT`: that member does not exist and clang failed with
        // "no member named 'prog_X_INT_TO_UINT0' in 'struct PlcState'". Only the
        // MATH_FB_BLOCKS subset had a local-variable escape hatch; every other
        // inline family fell through to the struct reference. Substitution is
        // safe because the expressions are pure — they may be evaluated more than
        // once and are not gated on the source block's power flow (the consumer
        // has its own EN). Sorted (topological) order guarantees the producer
        // registers here before any consumer reads it, and every symbol the
        // expression names is declared earlier in the SAME emitted C block.
        //   sorted block index → the block's C result expression
        const inlineOutExpr = new Map();

        // Resolve a wired named output pin (out_OUT / out_Q / out_ENO) of an
        // INLINE source block. Returns null when the source is a real FB, so the
        // caller falls back to its `<instance>.<pin>` struct read — and also for
        // an inline source not yet emitted, which only happens if the rung graph
        // has a CYCLE (the topological sort covers data wires, not just power
        // flow, so a well-formed rung always emits the producer first). That
        // fallback then fails at clang rather than silently substituting 0.
        const inlineSourceRef = (srcType, srcIdx, pinName, rIdx) => {
            if (!isInlineMathType(srcType)) return null;
            // ENO is the block's power flow, never part of the value expression.
            if (pinName === 'ENO') return `out_r${rIdx}_b${srcIdx}`;
            if (MATH_FB_BLOCKS.has(srcType)) {
                return realInlineBlocks.has(srcIdx)
                    ? `_m_r${rIdx}_b${srcIdx}_rout`
                    : `_m_r${rIdx}_b${srcIdx}.${pinName}`;
            }
            const expr = inlineOutExpr.get(srcIdx);
            return expr ? `(${expr})` : null;
        };

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

                // Debug shadow for this block's data output — the PlcState field
                // collectShadowVars declared for it (programs only; a FUNCTION or
                // FUNCTION_BLOCK has no such field). Writing it is what makes an
                // inline result observable at all: with no variable on OUT/Q and
                // no wire out, the expression below otherwise reaches no
                // statement and the block's value exists nowhere.
                const dbgInst = (data.instanceName || type).trim().replace(/\s+/g, '_');
                const dbgOut = (pin) => category === 'program'
                    ? `S->prog_${parentName}_out_${dbgInst}_${pin}`
                    : null;

                // Collect argument values from static pin values and wire connections.
                // ⚠️ `argIsString` rides along because a comparison of text must
                // become strcmp, not `==` on two `char *` (which tests addresses
                // and silently never matches). It is set where the TYPE is still
                // known — the pin's own value, or the source block's output pin.
                const argValues = {};
                const argIsString = {};
                // pin → IEC type of the operand (null = unknown); drives the
                // int32 / int64 / float / double choice and the rotate width.
                const argTypes = {};
                const markStr = (pin, yes) => { if (yes) argIsString[pin] = true; };
                if (data.values) {
                    Object.entries(data.values).forEach(([pinName, val]) => {
                        if (['EN', 'ENO', 'OUT', 'Q'].includes(pinName)) return;
                        const resolved = resolveVal(val);
                        if (resolved === null) return;
                        argValues[pinName] = resolved;
                        argTypes[pinName] = operandType(resolved);
                        markStr(pinName, /^"/.test(resolved) ||
                            /^W?STRING$/i.test(String(cSymTypeMap[resolved] || '')));
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
                        argTypes[pinName] = 'BOOL';
                    } else if (sortedIndex[c.source] !== undefined) {
                        const sp = c.sourcePin || '';
                        if (sp.startsWith('out_') && !/^out_\d+$/.test(sp)) {
                            // Named data output pin (e.g. "out_VALUE", "out_Q") — read from source struct directly
                            const srcBlock = nodeMap[c.source];
                            const srcType = srcBlock?.type || srcBlock?.data?.type || '';
                            const srcInstName = (srcBlock?.data?.instanceName || srcType || '');
                            const srcIdx = sortedIndex[c.source];
                            const inlineRef = inlineSourceRef(srcType, srcIdx, sp.slice(4), rungIdx);
                            if (inlineRef !== null) {
                                argValues[pinName] = inlineRef;
                                argTypes[pinName] = sp.slice(4) === 'ENO' ? 'BOOL' : (inlineOutType.get(srcIdx) || null);
                            } else {
                                argValues[pinName] = `${getCallTarget(srcInstName)}.${sp.slice(4)}`;
                                argTypes[pinName] = String(getOutputPinType(srcType, sp.slice(4), srcBlock?.data?.customData) || '').toUpperCase() || null;
                            }
                            markStr(pinName, /^W?STRING$/i.test(
                                String(getOutputPinType(srcType, sp.slice(4), srcBlock?.data?.customData) || '')));
                        } else {
                            argValues[pinName] = `out_r${rungIdx}_b${sortedIndex[c.source]}`;
                            argTypes[pinName] = 'BOOL';
                        }
                    }
                });

                const args = dataInputPins.map(pin => argValues[pin] || '0');

                // Arithmetic width for this block, from every operand and the
                // OUT variable: LREAL → double, REAL → float, a 64-bit integer
                // (or UDINT/DWORD/TIME/LTIME, which int32 cannot hold) → int64_t, else
                // the int32 kronmath struct path.
                // ⚠️ The type has to be read off EVERY operand: the old check only
                // knew literals because cSymTypeMap never matched a resolved
                // variable, and KRON_GT/KRON_LIMIT dispatch on their FIRST argument
                // only, so `GT(5, r)` compared as int32.
                const outRawCheck = data.values?.OUT;
                const outVarCheck = outRawCheck ? (outRawCheck + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                const outCSym = (outVarCheck && IDENTIFIER_REF_REGEX.test(outVarCheck)) ? resolveVar(outVarCheck) : null;
                const kindOf = (types) => {
                    const T = types.map(t => String(t || '').toUpperCase());
                    if (T.includes('LREAL')) return 'f64';
                    if (T.includes('REAL')) return 'f32';
                    if (T.some(t => ['LINT', 'ULINT', 'LWORD', 'UDINT', 'DWORD', 'TIME', 'LTIME'].includes(t))) return 'i64';
                    return 'i32';
                };
                const KIND_C = { f64: 'double', f32: 'float', i64: 'int64_t', i32: 'int32_t' };
                const KIND_IEC = { f64: 'LREAL', f32: 'REAL', i64: 'LINT', i32: 'DINT' };

                if (type === 'MOVE' && (argIsString.IN || operandType(outCSym) === 'STRING')) {
                    // MOVE of text is a copy into the OUT variable's own array;
                    // the numeric paths below would cast a pointer.
                    out += `    ${bOut} = ${inExpr};\n`;
                    if (outCSym) out += `    if (${bOut}) { ${kronStrset(outCSym, argValues.IN || '""')}; }\n`;
                } else if (MATH_FB_BLOCKS.has(type)) {
                    const inputVals = dataInputPins.map(pin => argValues[pin] || '0');
                    let kind = kindOf([...dataInputPins.map(p => argTypes[p]), outCSym ? operandType(outCSym) : null]);
                    // <math.h> functions are floating point whatever the operand.
                    if (MATH_UNARY_C[type]) kind = (kind === 'f64' || kind === 'i64') ? 'f64' : 'f32';

                    out += `    ${bOut} = ${inExpr};\n`;

                    if (kind !== 'i32') {
                        // ── Inline path: no struct, a typed C expression ──
                        realInlineBlocks.add(idx);
                        inlineOutType.set(idx, KIND_IEC[kind]);
                        const ct = KIND_C[kind];
                        const isF = kind === 'f32' || kind === 'f64';
                        const fsuf = kind === 'f32' ? 'f' : '';
                        const zero = kind === 'f32' ? '0.0f' : kind === 'f64' ? '0.0' : '0';
                        const localRout = `_m_r${rungIdx}_b${idx}_rout`;
                        const cv = (v) => `(${ct})(${v})`;
                        let expr;
                        if (MATH_FB_ARRAY_INPUT.has(type)) {
                            const vals = inputVals.map(cv);
                            if (type === 'ADD') expr = vals.join(' + ');
                            else if (type === 'MUL') expr = vals.join(' * ');
                            else if (type === 'AVG') expr = `(${vals.join(' + ')}) / ${isF ? `${inputVals.length}.0${fsuf}` : inputVals.length}`;
                        } else {
                            const a = cv(inputVals[0] || '0');
                            const b = cv(inputVals[1] || '0');
                            if (type === 'SUB') expr = `${a} - ${b}`;
                            else if (type === 'DIV') expr = isF ? `(${b} != ${zero}) ? (${a} / ${b}) : ${zero}` : `KRON_IDIV(${a}, ${b})`;
                            else if (type === 'MOD') expr = isF ? `(${b} != ${zero}) ? fmod${fsuf}(${a}, ${b}) : ${zero}` : `KRON_IMOD(${a}, ${b})`;
                            else if (type === 'MOVE') expr = a;
                            else if (type === 'NEG') expr = `-${a}`;
                            else if (type === 'ABS') expr = `(${a} < ${zero} ? -${a} : ${a})`;
                            else if (type === 'EXPT') expr = isF ? `pow${fsuf}(${a}, ${b})` : `(int64_t)llround(pow((double)${a}, (double)${b}))`;
                            else if (type === 'SQRT') expr = `(${a} >= ${zero} ? sqrt${fsuf}(${a}) : ${zero})`;
                            else if (MATH_UNARY_C[type]) expr = `${MATH_UNARY_C[type]}${fsuf}(${a})`;
                        }
                        if (!expr) throw new Error(`LD: no ${kind} implementation for math block ${type} on rung ${rungIdx + 1}.`);
                        out += `    ${ct} ${localRout} = ${zero};\n`;
                        out += `    if (${bOut}) {\n`;
                        out += `        ${localRout} = ${expr};\n`;
                        if (dbgOut('OUT')) out += `        ${dbgOut('OUT')} = ${localRout};\n`;
                        if (outCSym) out += `        ${outCSym} = ${localRout};\n`;
                        out += `    }\n`;
                    } else {
                        // ── Integer path: struct + _Call (kronmath.h) ──
                        inlineOutType.set(idx, 'DINT');
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
                        if (dbgOut('OUT')) out += `    ${dbgOut('OUT')} = ${localVar}.OUT;\n`;

                        if (outCSym) {
                            out += `    ${outCSym} = ${localVar}.OUT;\n`;
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
                    // Plain C operators throughout: C's usual arithmetic
                    // conversions pick the common type of BOTH operands, which
                    // the archive's _Generic macros (keyed on one argument) did not.
                    const A = (pin) => `(${argValues[pin] || '0'})`;
                    const T = (pin) => String(argTypes[pin] || '').toUpperCase();
                    let resultExpr;
                    let resultType = null;
                    if (type === 'MUX') {
                        // KRON_MUX expects (k, ARRAY-pointer, n) — dereferencing a
                        // scalar is a compile error. The 2-input XML block is a
                        // simple select: K != 0 picks IN1.
                        resultExpr = `(${A('K')} ? ${A('IN1')} : ${A('IN0')})`;
                        resultType = KIND_IEC[kindOf([argTypes.IN0, argTypes.IN1])];
                    } else if (type === 'SEL') {
                        resultExpr = `(${A('G')} ? ${A('IN1')} : ${A('IN0')})`;
                        resultType = KIND_IEC[kindOf([argTypes.IN0, argTypes.IN1])];
                    } else if (type === 'LIMIT') {
                        // IEC LIMIT(MN, IN, MX), by pin NAME (FB_INPUTS order is IN, MN, MX).
                        resultExpr = `(${A('IN')} < ${A('MN')} ? ${A('MN')} : (${A('IN')} > ${A('MX')} ? ${A('MX')} : ${A('IN')}))`;
                        resultType = KIND_IEC[kindOf([argTypes.IN, argTypes.MN, argTypes.MX])];
                    } else if (type === 'MIN' || type === 'MAX') {
                        const op = type === 'MIN' ? '<' : '>';
                        resultExpr = `(${A('IN1')} ${op} ${A('IN2')} ? ${A('IN1')} : ${A('IN2')})`;
                        resultType = KIND_IEC[kindOf([argTypes.IN1, argTypes.IN2])];
                    } else if (['GT', 'GE', 'EQ', 'NE', 'LT', 'LE'].includes(type)) {
                        // Text operands: a C `==` on two `char *` compares
                        // addresses, so lower to strcmp. Ordering text has no
                        // meaning here and is refused instead.
                        const textCmp = dataInputPins.some(pin => argIsString[pin]);
                        if (textCmp && (type === 'EQ' || type === 'NE')) {
                            const eq = `__kron_streq(${args[0]}, ${args[1]})`;
                            resultExpr = type === 'EQ' ? eq : `(!${eq})`;
                        } else if (textCmp) {
                            throw new Error(
                                `${type} compares text on rung ${rungIdx + 1}: only EQ and NE work ` +
                                `on STRING. Convert with STRING_TO_DINT / STRING_TO_REAL first.`);
                        } else {
                            const op = { GT: '>', GE: '>=', EQ: '==', NE: '!=', LT: '<', LE: '<=' }[type];
                            resultExpr = `(${A('IN1')} ${op} ${A('IN2')})`;
                        }
                        resultType = 'BOOL';
                    } else if (type === 'BNOT') {
                        // BNOT on a BOOL is a logical NOT: `~true` is -2, i.e. TRUE.
                        resultExpr = T('IN') === 'BOOL' ? `(!${A('IN')})` : `(~${A('IN')})`;
                        resultType = T('IN') === 'BOOL' ? 'BOOL' : (T('IN') || 'DWORD');
                    } else if (type === 'ROL' || type === 'ROR') {
                        // Width of the OPERAND (BYTE 8 … LWORD 64): from the IN
                        // value, else the OUT variable, else the pin's DWORD.
                        const wt = IEC_BIT_WIDTH[T('IN')] > 1 ? T('IN')
                            : (IEC_BIT_WIDTH[String(operandType(outCSym) || '').toUpperCase()] > 1
                                ? String(operandType(outCSym)).toUpperCase() : 'DWORD');
                        resultExpr = rotateExpr(type, argValues.IN || '0', argValues.N || '0', IEC_BIT_WIDTH[wt]);
                        resultType = wt;
                    } else if (BITWISE_OP[type]) {
                        if (dataInputPins.length === 1) {
                            resultExpr = `(${BITWISE_OP[type]}${args[0]})`;
                        } else {
                            resultExpr = `(${args[0]} ${BITWISE_OP[type]} ${args[1]})`;
                        }
                        resultType = T(dataInputPins[0]) || 'DWORD';
                    } else if (type === 'NORM_X') {
                        // (VALUE - MIN) / (MAX - MIN), in double whatever the pins are.
                        resultExpr = `(((double)${A('VALUE')} - ${A('MIN')}) / ((double)${A('MAX')} - ${A('MIN')}))`;
                        resultType = 'LREAL';
                    } else if (type === 'SCALE_X') {
                        // VALUE * (MAX - MIN) + MIN
                        resultExpr = `((double)${A('VALUE')} * ((double)${A('MAX')} - ${A('MIN')}) + ${A('MIN')})`;
                        resultType = 'LREAL';
                    } else if (type.match(/^[A-Z]+_TO_[A-Z]+$/)) {
                        const [srcType, dstType] = type.split('_TO_');
                        resultType = dstType;
                        if (dstType === 'STRING' || srcType === 'STRING') {
                            // Text cannot be a C cast: `(int32_t)(char*)` reads the
                            // pointer and `(char*)(int32_t)` invents one. Both
                            // directions are real calls, and TO_STRING writes into
                            // this call site's own PlcState buffer.
                            const ks = IEC_KRON_NAME[srcType], kd = IEC_KRON_NAME[dstType];
                            if (!ks || !kd) throw new Error(`Unsupported conversion block "${type}"`);
                            if (dstType === 'STRING') {
                                if (category !== 'program') {
                                    throw new Error(
                                        `${type} is only available inside a PROGRAM. A FUNCTION or ` +
                                        `FUNCTION_BLOCK has no PlcState field to hold the text.`);
                                }
                                const buf = strConvSymbol(parentName, (data.instanceName || `${type}${idx}`).trim().replace(/\s+/g, '_'));
                                resultExpr = `KRON_${ks}_TO_STRING(${args[0]}, S->${buf}, ${STRING_SHM_BYTES})`;
                            } else {
                                resultExpr = `KRON_STRING_TO_${kd}(${args[0]})`;
                            }
                        } else if ((srcType === 'REAL' || srcType === 'LREAL') && IEC_INT_TYPES.has(dstType)) {
                            // ⚠️ IEC REAL_TO_INT ROUNDS; a C cast truncates (2.7 → 2).
                            resultExpr = srcType === 'REAL'
                                ? `((${mapType(dstType)})llrintf((float)(${args[0]})))`
                                : `((${mapType(dstType)})llrint((double)(${args[0]})))`;
                        } else {
                            // Other numeric conversions — a C cast is exact and free
                            resultExpr = `(${mapType(dstType)})(${args[0]})`;
                        }
                    } else {
                        // ⚠️ Never emit a placeholder: `/* unknown */ 0` compiled
                        // into a plausible wrong program.
                        throw new Error(`LD: block type "${type}" on rung ${rungIdx + 1} has no code generator ` +
                            `(an EN/ENO inline block nothing implements).`);
                    }
                    inlineOutType.set(idx, resultType);

                    // Publish the expression for any block wired to this one's
                    // OUT/Q pin (see inlineOutExpr above). Registered BEFORE the
                    // emit branches below, which only cover the case where the
                    // user typed a variable name into the OUT/Q field.
                    inlineOutExpr.set(idx, resultExpr);

                    const hasOutPin = (FB_OUTPUTS[type] || []).includes('OUT');
                    const hasQPin   = (FB_OUTPUTS[type] || []).includes('Q');
                    const isBoolResult = !hasOutPin && !hasQPin;

                    // A conversion to text writes into its own PlcState buffer
                    // and RETURNS it, so the debug key is an alias of that buffer
                    // (collectShadowVars) — never an assignment, which would not
                    // compile against a char[]. What it does need is a statement
                    // that evaluates the call when nothing else consumes it.
                    const isToString = /_TO_STRING$/.test(type);
                    // A text operand makes the result a `char *` (SEL/MUX pass one
                    // through); the shadow field is numeric, so skip it rather than
                    // emit an assignment that cannot compile.
                    const hasTextArg = Object.keys(argIsString).length > 0;

                    if (isBoolResult) {
                        out += `    ${bOut} = ${inExpr} && ${resultExpr};\n`;
                    } else if (hasQPin) {
                        // Comparison blocks: power-flow = EN, Q = raw comparison result
                        out += `    ${bOut} = ${inExpr};\n`;
                        if (dbgOut('Q')) out += `    ${dbgOut('Q')} = ${resultExpr};\n`;
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
                        const outAssigned = outVar && IDENTIFIER_REF_REGEX.test(outVar);
                        if (!isToString && !hasTextArg && dbgOut('OUT')) {
                            out += `    if (${bOut}) { ${dbgOut('OUT')} = ${resultExpr}; }\n`;
                        } else if (isToString && !outAssigned && category === 'program') {
                            out += `    if (${bOut}) { (void)(${resultExpr}); }\n`;
                        }
                        if (outAssigned) {
                            // Text result (x_TO_STRING, SEL/MUX of STRINGs): copy.
                            out += (isToString || (hasTextArg && ['SEL', 'MUX'].includes(type)))
                                ? `    if (${bOut}) { ${kronStrset(resolveVar(outVar), resultExpr)}; }\n`
                                : `    if (${bOut}) { ${resolveVar(outVar)} = ${resultExpr}; }\n`;
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
                // C member of a pin: a user FB's member is its declared name
                // (mangled if it is a C keyword); a standard FB's goes through
                // cStructPin (CTU.R → RESET).
                const memberOf = (pin) => (isUserDefinedFB ? cIdent(pin) : cStructPin(type, pin));
                // Pre-call input write. A USER FB's STRING pin is an array
                // member and is copied into; a standard block's STRING pin is a
                // `const char *` re-pointed here every scan (plain `=`).
                const pinAssign = (cPin, pinName, rhs) => (isUserDefinedFB
                    && isStringInputType(getInputPinMeta(type, pinName, data.customData).type)
                    ? `    ${kronStrset(`${callTarget}.${cPin}`, rhs)};\n`
                    : `    ${callTarget}.${cPin} = ${rhs};\n`);
                // ⚠️ A motion FB's pin writes land INSIDE the request the axis
                // engine may already own (AXIS_REF.Active/Buffer[] hold a pointer
                // into this very instance, and a buffered command reads its
                // parameters at activation time — on the bus thread). So the lock
                // has to span the pin assignments as well as the _Call, not just
                // the call. Spliced in once the whole block has been emitted.
                const motionLockAt = MOTION_FB_AXIS_PARAM.has(type) ? out.length : -1;
                // Step 1: assign static pin values entered in the block's INPUT fields
                //         Skip output pins — those are written back after the call
                if (data.values) {
                    Object.entries(data.values).forEach(([pinName, val]) => {
                        if (outputPinNames.has(pinName)) return; // handled post-call
                        if (FB_TRIGGER_PIN[type] && pinName === FB_TRIGGER_PIN[type]) return; // overwritten by power flow in step 3
                        if (MOTION_FB_AXIS_PARAM.has(type) && pinName === 'Axis') return; // passed as 2nd call param
                        // Skip pins not in inputPins (e.g. old output pins removed from the standard)
                        if (inputPins.length > 0 && !inputPins.includes(pinName) && !isUserDefinedFB) return;
                        const cPin = memberOf(pinName);
                        const shadowSym = inputShadowMap?.get(`${safeInst}_${pinName}`);
                        if (shadowSym) {
                            out += `    ${callTarget}.${cPin} = S->${shadowSym};\n`;
                        } else {
                            const resolved = resolveInputPinValue(type, pinName, val, data.customData);
                            if (resolved !== null && resolved !== undefined) {
                                out += pinAssign(cPin, pinName, resolved);
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
                            const cPin = memberOf(pinName);
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
                    const cPin = memberOf(pinName);
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
                    const cPin = memberOf(pinName);
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
                            // Inline blocks have no persistent instance: math FBs
                            // use a rung-local struct/float, the rest a pure expression.
                            const srcIdx = sortedIndex[c.source];
                            const inlineRef = inlineSourceRef(srcType, srcIdx, sp.slice(4), rungIdx);
                            const srcRef = inlineRef !== null
                                ? inlineRef
                                : `${getCallTarget(srcInstName)}.${sp.slice(4)}`;
                            const sourceExpr = adaptExprForInputPin(type, pinName, srcRef, data.customData);
                            out += pinAssign(cPin, pinName, sourceExpr);
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
                    out = out.slice(0, motionLockAt) + `    KRON_AXIS_LOCK();\n`
                        + out.slice(motionLockAt) + `    KRON_AXIS_UNLOCK();\n`;
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
                    // A STRING output (Read_Sys_File.VALUE, a user FB's STRING
                    // pin) is COPIED: the target and the shadow are arrays.
                    const pinIsString = isStringInputType(getOutputPinType(type, pinName, data.customData));
                    const assign = (lhs, rhs) => (pinIsString ? `${kronStrset(lhs, rhs)};` : `${lhs} = ${rhs};`);
                    if (isVarAssigned) {
                        out += `    ${assign(resolveVar(varStr), `${callTarget}.${memberOf(pinName)}`)}\n`;
                    }
                    // Always write to shadow tracking var so the variable table can show output values
                    if (category !== 'function_block') {
                        out += `    ${assign(`S->prog_${parentName}_out_${safeInst}_${pinName}`, `${callTarget}.${memberOf(pinName)}`)}\n`;
                    }
                });
                // ⚠️ VAR_IN_OUT of a user FB: the FB worked on its own copy, so
                // the variable typed into the pin gets the result back.
                if (isUserDefinedFB) {
                    (data.customData.content.variables || []).filter(isInOutClass).forEach(v => {
                        const raw = data.values?.[v.name];
                        const vs = raw ? (raw + '').replace(/[🌍🏠⊞⊡⊟]/g, '').trim() : '';
                        if (vs && IDENTIFIER_REF_REGEX.test(vs)) {
                            out += isStringInputType(v.type)
                                ? `    ${kronStrset(resolveVar(vs), `${callTarget}.${memberOf(v.name)}`)};\n`
                                : `    ${resolveVar(vs)} = ${callTarget}.${memberOf(v.name)};\n`;
                        }
                    });
                }
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
        // IEC TIME/LTIME = kronstandard.h's TIME (int64_t microseconds).
        // Spelled as the C type so a field never depends on that header.
        'TIME': 'int64_t',
        'LTIME': 'int64_t',
        'STRING': STRING_C_TYPE,
        'WSTRING': STRING_C_TYPE,
        'POINTER': 'void*',
        'VOID': 'void'
    };
    // Fallback to custom name — sanitized like the typedef emission ("My FB" →
    // typedef My_FB), so field declarations reference the real C type name.
    // ⚠️ Upper-cased first: IEC type names are case-insensitive, and a
    // lowercase `int` used to fall through and be emitted as C's own `int`.
    return typeMap[String(iecType || '').trim().toUpperCase()] || String(iecType || '').trim().replace(/\s+/g, '_');
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
            code += `    ${mapType(member.type)} ${cIdent(member.name)};\n`;
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
