# KronEditor — Coding Rules & Architecture Reference

## Rules

### Language
All code must be written in English. Comments, variable names, function names, string literals, and any other text in source files must use English only.

### Library Source Files
- **Always** edit canonical C sources under `/home/fehim/Documents/KrontekLibraries/` first.
- If the same file exists under `src-tauri/resources/.../include/`, apply the same change there too (keep in sync).
- **Never** only edit `resources/include/` and skip KrontekLibraries.
- **Never** generate `.a` static archive files. Only edit `.c` and `.h`. Rebuilding/deploying `.a` is the user's responsibility.
- `src-tauri/target/release/resources/include/kronec.c` is a stale stub — never edit it.

### Communication
When uncertain about requirements, architecture decisions, or implementation direction, **always ask first** before proceeding. If you have questions, ask them **before** making any changes — never start implementing and ask later.

### Self-Update of This File
After every prompt, before ending your turn, briefly evaluate whether anything **durable** was learned that future sessions need to know — a new transpiler rule, a HAL behavior, a build-pipeline quirk, a non-obvious workaround. If yes, update this CLAUDE.md in the same turn. Do **not** record session-specific debugging details, in-progress task state, or things already derivable from the code. Only persist facts that would surprise a future Claude reading the codebase cold.

---

## Technology Stack

- **Frontend**: React (Vite), ReactFlow (LD diagram), Monaco (ST editor)
- **Backend**: Tauri v2 (Rust), IPC via `invoke` + Tauri events
- **PLC languages**: IEC 61131-3 LD + ST → transpiled to C → compiled with GCC (`x86_64-linux-gnu`)
- **Simulation**: compiled binary + shared memory, managed by Rust
- **Deployment Server**: Go (KronServer) — ConnectRPC/gRPC agent for PLC runtime deployment, shared memory IPC, HMI serving

---

## Build Output Location

The compiled PLC artifacts (Build & Send target output) are written to:
`~/.local/share/com.plceditor.app/build/`
(absolute: `/home/fehim/.local/share/com.plceditor.app/build/`)

Files generated there:
- `plc.c` / `plc.h` — transpiled C output (CTranspilerService.js result)
- `kron_hal.h` — auto-generated process image / HAL glue
- `runtime.bin` — compiled binary (cross-compiled for the selected board family)
- `variables.json` — symbol table for SHM offsets, addressed vars, password hashes

Use this directory when verifying transpiler output or diagnosing runtime behavior.

---

## Key Directories

```
src/
  App.jsx                   Root state: isRunning, isSimulationMode, liveVariables, project tree
  components/
    EditorPane.jsx          Tabbed editor: ST (Monaco), LD (RungEditorNew), Resource
    RungEditorNew.jsx       LD editor: rung list, block insertion, undo/redo (useRef history)
    RungContainer.jsx       ReactFlow canvas for a single rung (large file)
    VariableManager.jsx     Variable table (global + POU-local)
    ProjectSidebar.jsx      Left sidebar: project tree, add/delete POUs
    Toolbox.jsx             Right sidebar: draggable block library, 3-level hierarchy
    BlockSettingsModal.jsx  Pin assignment popup for LD blocks
    BoardConfigPage.jsx     Hardware board selection + interface config (GPIO/I2C/SPI/UART/USB)
    SlaveConfigPage.jsx     EtherCAT slave configuration
    EtherCATEditor.jsx      EtherCAT master config editor
    TaskManager.jsx         PLC task scheduling config
    OutputPanel.jsx         Simulation log + live variable watch
  services/
    CTranspilerService.js   ST → C and LD → C transpiler (main compilation path)
    LibraryService.js       Loads XML block library from public/libraries/
    PLCClient.js            Tauri IPC wrapper (invoke calls to Rust backend)
    HmiExportService.js     HMI export
    EsiLibraryService.js    EtherCAT ESI file reader
  utils/
    boardDefinitions.js     All supported boards: specs, pinout, usbPorts[], interfaces[]
    boardLibraryBlocks.js   Channel-specific HAL blocks per board (UART0_Send, USB2_Receive, …)
    devicePortMapping.js    Board family → protocol → portId → Linux device path
    hwPortVars.js           Generates system STRING vars from interfaceConfig (USB2_PORT, UART1_PORT, …)
    libraryTree.js          Static 3-level toolbox tree + GENERIC_FB_DEFS + PROTOCOL_BLOCKS
    halBlockMeta.js         HAL block input/output metadata for LD pin rendering
    deviceCodegen.js        C code generation for EtherCAT device config
    plcStandards.js         IEC 61131-3 data type definitions
    iecSTLanguage.js        Monaco language definition for ST

src-tauri/
  src/
    main.rs                 Tauri commands: compile, run simulation, file I/O, shared memory
    lexer.rs / grammar.lalrpop / ast.rs   LALRPOP-based ST parser (for static analysis)
  resources/x86_64-linux-gnu/
    include/HAL/
      kronhal.h             HAL struct definitions + dispatch functions (SECONDARY COPY — edit KrontekLibraries/KronHAL/ first)
      kronhal_sim.h         Simulation stubs
      kronhal_rpi.h         Raspberry Pi HAL
      kronhal_jetson.h      NVIDIA Jetson HAL
      kronhal_bb.h          BeagleBone HAL
    lib/                    Prebuilt .a libraries (do not edit)

public/libraries/           XML block library definitions loaded by LibraryService.js

KronServer/ (/home/fehim/Documents/KronServer/)
  main.go                   Entry point: CLI flags, logger, manager init, graceful shutdown
  server.go                 HTTP server: ConnectRPC routes, deploy endpoints, CORS, h2c
  service.go                PLCService RPC impl (Start/Stop/WriteVar/ClearAllForces/StreamVars)
  ipc.go                    Shared memory (mmap) IPC: variable read/write, force flags, type decoding
  process.go                PLC runtime process lifecycle: start, SIGTERM/SIGKILL, log redirect
  auth.go                   Authentication: SHA-256 passwords, sessions (8h TTL), 4-tier RBAC
  hmi.go                    HMI layout management: XML/JSON import, per-page permissions, web routes
  build.sh                  Cross-compilation: ARM32, ARM64, x86_64 (CGO_ENABLED=0, static)
  proto/plc/v1/plc.proto    Protobuf service & message definitions
  gen/plc/v1/               Generated protobuf + ConnectRPC handler code
  dist/                     Compiled binaries output

KrontekLibraries/           SOURCE OF TRUTH for all .c/.h files
  KronHAL/kronhal.h         Master HAL header
  KronEthercatMaster/
    kronethercatmaster.c    Real EC master (pdo_read/write, kron_ec_init)
    kronethercatmaster.h    KRON_EC_Config, KRON_EC_Slave, KRON_EC_PDO_Entry
  KronMotion/
    kronmotion.c            MC_Power_Call, MC_Home_Call, etc.
    kron_nc.c               NC Engine: NC_ProcessOne, CiA402 state machine
  KronStandard/, KronLogic/, KronMathematic/, KronControl/, KronCompare/,
  KronConverter/, KronCommunication/
```

---

## App State & Simulation Flow

### Key States (App.jsx)
- `isRunning` — simulation binary is running; all editors go readOnly
- `isSimulationMode` — simulation mode is active
- `liveVariables` — map of live variable values from Tauri `plc_variables` event (updated ~500ms)

### Simulation Flow
```
App.jsx: startSimulation()
  → PLCClient.invoke('compile') → Rust: transpile + gcc → binary
  → PLCClient.invoke('run_simulation') → Rust: spawn binary + shared memory
  → Tauri event 'plc_variables' → liveVariables state → watch panel
isRunning=true → all editors go readOnly
```

### Read-Only Mode (isRunning=true)
- `App.jsx` → passes `isRunning` to `EditorPane` and `ProjectSidebar`
- `EditorPane` → Monaco `readOnly={isRunning}`, `RungEditorNew readOnly={isRunning}`
- `RungEditorNew` → all add/delete/move/connect operations blocked
- `VariableManager` → `disabled={isRunning}`
- `ProjectSidebar` → add/delete/edit buttons disabled

---

## Transpiler (CTranspilerService.js)

### Entry Points & Signatures
```js
transpileToC(projectStructure, standardHeaders, boardId, simMode, buses=[], busConfigs={})
  → per-POU: transpilePOUSource(pou, globalVarNames, stdFunctions, interfaceConfig)
    → ST: transpileSTLogics(code, stdFunctions, parentName, category, varMap)
    → LD: transpileLDLogics(rungs, blockType, parentName, category, varMap)
```
All 3 `transpileToC` call sites in `App.jsx` pass `buses` and `busConfigs` as args 5 and 6.

### Variable Scoping
- Global vars → no prefix (looked up via `globalVarNames[]`)
- Local vars → `prog_NAME_` prefix
- Instance vars → `instance->` prefix
- `varMap`: IEC variable name → C symbol; built automatically in `transpilePOUSource`

### IEC Type Lookup Tables (must stay in sync)
When adding a new IEC primitive type, update **all four** tables in `CTranspilerService.js`:
- `IEC_TYPE_SIZES` — byte size; missing entry = no SHM slot, no force flag, var invisible to KronServer/REST API
- `IEC_TO_SERVER_TYPE` — KronServer type name (`bool`, `int8/16/32/64`, `uint8/16/32/64`, `float32/64`); wrong signedness silently corrupts values displayed in HMI/REST
- `IEC_TO_KRON_TYPE` (inside `transformExpr`) — KRON converter library suffix (e.g. `INT64`); truncated entry causes ST `X_TO_Y(...)` to silently lose precision
- `IEC_CAST_C` (inside `transformExpr`) — C cast type for `INT(x)` style coercions; also update the regex listing the type names

### ST Transpilation — Operator Mappings
| IEC ST | C |
|--------|---|
| `:=` | `=` |
| `AND` | `&&` (logical) |
| `OR` | `\|\|` (logical) |
| `NOT` | `!` (logical) |
| `XOR` | `^` |
| `BAND` | `&` (bitwise — vendor extension) |
| `BOR` | `\|` (bitwise — vendor extension) |
| `BXOR` | `^` (bitwise — vendor extension) |
| `BNOT` | `~` (bitwise — vendor extension) |
| `MOD` | `%` |
| `ABS(x)` | macro `((x) < 0 ? -(x) : (x))` defined in plc.h prelude — works for REAL and integer; argument is evaluated twice, so don't pass side-effecting expressions |
| `IF/THEN … ELSIF … ELSE … END_IF` | `if { } else if { } else { }` |
| `FOR i := s TO e BY b DO … END_FOR` | `for (…)` |
| `WHILE … DO … END_WHILE` | `while (…)` |
| `REPEAT … UNTIL …` | `do { } while (!…)` |
| `EXIT` | `break` |
| `RETURN` | `return` |

**The transpiler is NOT type-aware on `AND`/`OR`** — they always emit logical `&&`/`||`. To do bitwise masking on integer/byte values, use `BAND`/`BOR`/`BXOR`/`BNOT`. Mixing `AND` with integer operands produces silent wrong results (compiler warns `-Wconstant-logical-operand` only when an operand is a literal).

### ST Transpilation — Line Handling
- Raw line split: `/\r?\n|\\n/` (handles both real and escaped newlines).
- **Continuation merge**: lines ending with `AND`/`OR`/`NOT`/`XOR`, an arithmetic operator (`+ - * /`), a comparison operator (`< > <= >= <>` or bare `=`), `,`, or `(` are merged with the next line. `:=` is excluded so trailing assignments don't accidentally swallow the next statement.
- **CASE label + body split**: a numeric label followed by an inline body on the same line (e.g. `1:  init_wait(IN := TRUE, PT := T#30ms);`) is automatically split into two lines so the body still passes through the full statement pipeline (FB-call detection, etc.). Without this split, named-arg FB calls inside CASE labels would be mangled into invalid C.
- **String-literal placeholder uses ASCII control chars** (`\x01<idx>\x02`) inside `transformExpr`. They will not appear in any text editor view, but they exist in the JS source and must NOT be replaced with bare digits — bare-digit placeholders silently corrupt every numeric literal in the expression into `"undefined"` because the restore regex `\d+` cannot distinguish a placeholder from a real number.

### LD Transpilation — Data Structures
```js
rung.blocks[i].type          // block type: 'Contact', 'TON', 'SR', etc.
rung.blocks[i].data.subType  // Contact: 'NO'|'NC'; Coil: 'Normal'|'Set'|'Reset'
rung.blocks[i].data.values   // { var: 'name' } Contact, { coil: 'name' } Coil, { PT: 'T#5s' } FB
rung.connections[i].sourcePin // 'out' (Contact/Coil), 'out_0','out_1'... (FB)
rung.connections[i].targetPin // 'in' (Contact/Coil), 'in_0','in_1'... (FB)
```

### LD Transpilation — Key Rules
- **Global var prefix**: Global vars never get `prog_` prefix; check against `globalVarNames[]`
- **FB trigger pin**: `in_0` / `in` = power flow trigger; `in_1`, `in_2`… = separate pin assignments
- **SR vs RS trigger**: SR → `.S1`; RS → `.S` (different fields!)
- **Duplicate edges**: topological sort deduplicates same source→target pairs
- **resolveVal**: handles IEC time literals, numeric, and identifier types correctly
- Module-scope constants: `FB_TRIGGER_PIN`, `FB_Q_OUTPUT`, `FB_INPUTS`, `FB_OUTPUTS`, `FB_INPUT_TYPES`
- `globalVarNames` flows: `transpileToC` → `transpilePOUSource` → `transpileLDLogics`

### HAL Port Resolution
- Port IDs use underscore format: `USB_0`, `USB_2`, `UART_1`, `I2C_1`, `SPI_0_CE0`
- System vars from hwPortVars.js: `USB2_PORT`, `UART1_PORT`, `I2C1_PORT`
- `resolveHardwarePortSymbol(value)` → converts both system var name and numeric literal to channel index string

---

## HAL Pattern

Every hardware block: **struct + `_Call` function**
- Hardware struct: `HAL_UART_Send`, `HAL_I2C_Read`, `HAL_USB_Send`
- Generic struct (in transpiled C): `UART_Send`, `USB_Receive`
- Channel dispatch: `UART0_Send_Call(inst)` → `HAL_UART_Send_Call(inst, 0)`
- Both `KrontekLibraries/KronHAL/kronhal.h` and `src-tauri/resources/.../kronhal.h` must stay in sync.

### USB_Send vs USB_Receive Paradigms (different on purpose)

| Block | Trigger pin | Done/Ready pin | Buffer pin | Length pin |
|-------|-------------|----------------|------------|-----------|
| `USB_Send` | `Execute` (rising edge — like a one-shot transfer) | `Done`, `Busy`, `Error` | `pTxBuffer` | `Length` |
| `USB_Receive` | `Enable` (continuous level — drains all available bytes each call) | `NewData`, `Error` | `pRxBuffer` | `MaxSize` (capacity) + `ReceivedLength` (output, actual bytes read) |

`USB_Receive_Call` loops up to `MaxSize` byte-reads in a single PLC scan — when the OS read returns no byte the loop breaks. So one `Enable=TRUE` per scan drains the kernel tty buffer. **No edge-cycling required.**

### USB DTR Handling
`_*_usb_open()` (rpi/jetson/bb) drops DTR low after `tcsetattr` via `ioctl(fd, TIOCMBIC, &TIOCM_DTR)`. This is required for motor-controlled USB devices like RPLIDAR A1M8 (DTR-high = motor-off; without this the motor stalls a few hundred ms after `open()` and the data stream stops).

**Side effect**: Arduino/ESP32 boards with a DTR-driven auto-reset line will be held in reset while the PLC runtime keeps the port open. If a future board needs DTR-high default behavior, refactor this into an explicit HAL block (`USB_DTR_Set` etc.) instead of a per-port flag.

---

## LD Editor

### Undo/Redo (RungEditorNew.jsx)
- History: `useRef` storing `{ rungs, variables }` pairs, max 50 steps
- **Every mutation** must call `saveHistory(newRungs, newVariables)` with both
- `insertBlock(rungId, ..., newVariables)` — caller must compute new variables and pass them
- `deleteBlockFromRung` — deletes variable synchronously, then calls `saveHistory`
- Ctrl+Z = undo, Ctrl+Shift+Z = redo

### Block Insertion (RungEditorNew.jsx `insertBlock`)
- `subTypeOverride = customData?.subType` for Contact/Coil
- Spreads `subType` directly onto block `data` so RungContainer renders the correct symbol immediately

### Performance Rules (RungContainer.jsx)
- **Never** put `liveVariables` in `mapBlocksToNodes` useCallback deps — causes full node rebuild every 500ms
- Update live values via a separate lightweight `useEffect`:
  ```js
  React.useEffect(() => {
    setNodes(nds => nds.map(n => {
      if (n.id.startsWith('terminal_')) return n;
      if (n.data.liveVariables === liveVariables) return n;
      return { ...n, data: { ...n.data, liveVariables } };
    }));
  }, [liveVariables, setNodes]);
  ```
- **Wrap** `varsByType`/`dtMap`/`allRawVars` in `useMemo` (deps: `variables, globalVars, dataTypes`)
- **Do not** add custom equality to `RungContainerWrapper` until all callbacks use `setRungs(prev => …)` form (stale closure risk)

---

## Library System

### XML Format (public/libraries/*.xml)
```xml
<library>
  <category name="CATEGORY_NAME">
    <block type="BlockType">
      <inputs>
        <pin name="Execute" type="BOOL" trigger="true"/>
        <pin name="Port_ID" type="USINT"/>
      </inputs>
      <outputs>
        <pin name="ENO" type="BOOL"/>
        <pin name="DONE" type="BOOL"/>
      </outputs>
    </block>
  </category>
</library>
```

### Load Order & Blocks (LibraryService.js)
1. `bit_logic.xml` → BIT LOGIC: SR, RS, R_TRIG, F_TRIG, BAND, BOR, BXOR, BNOT, SHL, SHR, ROL, ROR
2. `timers.xml` → TIMERS: TON, TOF, TP, TONR (retentive; ET accumulates across IN=false, only RESET clears)
3. `counters.xml` → COUNTERS: CTU, CTD, CTUD
4. `math.xml` → MATH: ADD, SUB, MUL, DIV, MOD, MOVE, ABS, SQRT, EXPT, SIN, COS, TAN, ASIN, ACOS, ATAN
5. `comparison_selection.xml` → COMPARISON: GT, GE, EQ, NE, LE, LT, SEL, MUX, MAX, MIN, LIMIT
6. `conversion.xml` → CONVERSION: INT_TO_REAL, REAL_TO_INT, DINT_TO_REAL, REAL_TO_DINT, BOOL_TO_INT, INT_TO_BOOL, NORM_X, SCALE_X
7. `advanced_control.xml`, `motion.xml`, `communication.xml`, `system.xml` → placeholder categories

Notes:
- `categoryName.replace(/_/g, ' ')` — regex fix for multi-underscore names
- Trig typedefs uppercase (`SIN`, `COS`, `TAN`, etc.) to avoid libc conflict
- `standardfunction.c`: GT_Call uses `GT *inst` (not `GT_BLOCK *inst`)

### Adding or Removing Pins from a Block

When adding or removing input/output pins from **any** standard FB (motion, HAL, standard library, etc.), **all five locations** must be updated together:

| Location | What to change |
|----------|---------------|
| `KrontekLibraries/…/header.h` | Add/remove the field from the C struct (canonical source) |
| `src-tauri/resources/*/include/header.h` | Sync — copy updated header to all 7–8 target directories |
| `public/libraries/*.xml` | Add/remove the `<Variable>` entry under `<Inputs>` or `<Outputs>` |
| `FB_INPUTS[type]` in `CTranspilerService.js` | Update the ordered input pin list (drives pre-call assignments) |
| `FB_OUTPUTS[type]` in `CTranspilerService.js` | Update the output pin list (drives shadow var declaration + write-back) |

**Rules:**
- `FB_OUTPUTS` is the single source of truth for code generation — if a pin is NOT listed here, no shadow var is declared and no write-back code is emitted.
- `FB_INPUTS` drives Step 1 input assignment. Any `data.values` entry whose key is not in `FB_INPUTS` is silently skipped (safe guard for stale project data).
- Always verify pins against the PLCopen / vendor spec before adding them. Example: `MC_Stop` has **no** `Active` output per PLCopen TC2 v2.0 — only `Done, Busy, CommandAborted, Error, ErrorID`.
- `MC_Halt`, `MC_MoveAbsolute`, etc. **do** have `Active`.
- After removing a pin, existing projects may still have it in `data.values` — this is harmless because of the guard above.
- The XML file controls what the LD editor UI shows to the user; the JS constants control what C code is generated. They must stay in sync.

### Toolbox 3-Level Hierarchy
**`src/utils/libraryTree.js`** — `LIBRARY_TREE` static definition:
- 9 top-level categories, each with subcategories
- `fromLibrary: [blockTypes]` → resolved from XML at render time
- `items: [{blockType, subType, label, desc}]` → inline items (Contact/Coil, placeholders)

**`src/components/Toolbox.jsx`**:
- `buildBlockMap(libraryData)` → flat `{ blockType → block }` lookup
- 3-level expand/collapse: `expandedCats`, `expandedSubs` (separate useState)
- Contact color: `#1a6b3a`, Coil color: `#8b3a0f`, others: `#673ab7`
- User-defined blocks appended as flat category at bottom
- `subType` passed via `customData.subType` for Contact/Coil drag

---

## EtherCAT & Motion

### Motion Control (CTranspilerService.js)
- `MOTION_FB_AXIS_PARAM` set — all `MC_*` blocks call `MC_xxx_Call(&inst, &axisVar)` (not `MC_xxx_Call(&inst)`)
- `Axis` input pin is **not** a struct field — skipped in step 1 (values assignment) and null-init loop
- `MC_Power`: trigger=`Enable`, Q=`Status`; `MC_MoveAbsolute/Relative`: trigger=`Execute`, Q=`Done`

### motion.xml (PLCopen standard blocks)
MC_Power, MC_Home, MC_Stop, MC_Halt, MC_MoveAbsolute, MC_MoveRelative, MC_MoveVelocity,
MC_Reset, MC_ReadActualPosition, MC_ReadActualVelocity, MC_ReadStatus, MC_ReadAxisError, MC_SetOverride.
All have `Axis` (AXIS_REF) as first input pin.

### EtherCAT Config Generation (CTranspilerService.js)
- `generateEtherCATConfig(buses, busConfigs)` → generates `KRON_EC_Config` init C code
- `static KRON_EC_Config __ec_cfg;` added to `plc.c` (NOT `plc.h`)
- `kron_ec_init(&__ec_cfg)` in PLC_Init; `kron_ec_close(&__ec_cfg)` in PLC_Cleanup
- `kron_ec_pdo_read` injected before `plc_shm_pull`; `kron_ec_pdo_write` after `plc_shm_sync` in each task
- PDO varName: uses `entry.varName` if set; else auto-generates `ec_{slaveName}_{entryName}`

### EtherCAT Files
- Master config: `EtherCATEditor.jsx` + `deviceCodegen.js`
- Slave config: `SlaveConfigPage.jsx` + `EsiLibraryService.js`
- C generation: `KRON_EC_Config` struct + `ethercat_master_config.h`

---

## KronServer — PLC Deployment & Debug Agent

Source: `/home/fehim/Documents/KronServer/`

### Overview
Go-based agent that deploys compiled PLC runtime binaries to target hardware, manages runtime lifecycle, and provides live variable streaming via shared memory IPC. Serves HMI web interface with role-based access control.

### Technology
- **Language**: Go 1.25 — fully static binaries (`CGO_ENABLED=0`)
- **RPC**: ConnectRPC (supports Connect, gRPC, gRPC-Web protocols)
- **Serialization**: Protocol Buffers (`proto/plc/v1/plc.proto`)
- **IPC**: `mmap` on `/dev/shm/<name>` — zero-CGO shared memory with PLC runtime
- **Build targets**: ARM32 (RPi 32-bit), ARM64 (RPi 64-bit, Jetson), x86_64

### ConnectRPC Service (`/plc.v1.PLCService/`)
| RPC | Description |
|-----|-------------|
| `Start` | Launch PLC runtime binary, returns PID |
| `Stop` | Graceful SIGTERM (5s) → SIGKILL |
| `WriteVar` | Force-write variable value to shared memory |
| `ClearAllForces` | Remove all force flags |
| `StreamVars` | Server-stream all variables every 50ms |

### HTTP Endpoints
- `POST /deploy/runtime` — upload PLC runtime binary (128 MB max, atomic write)
- `POST /deploy/variable-table` — upload `variable_table.json`
- `GET /status` — JSON status report
- `GET /stream/vars` — SSE variable stream

### Shared Memory IPC (`ipc.go`)
- Variable table loaded from `variable_table.json` (name, offset, type, size, force_flag_offset)
- Supported types: `bool`, `int8/16/32/64`, `uint8/16/32/64`, `float32/64`
- Little-endian decoding, bounds checking, duplicate detection

### HMI & Auth (`hmi.go`, `auth.go`)
- 4-tier RBAC: Viewer → Operator → Maintainer → Admin
- SHA-256 password hashing with per-user salt
- Session tokens: 64-byte random hex, 8h TTL
- HMI layout: XML or JSON import, per-page read/write permissions
- Persisted at `deploy-dir/hmi_layout.json`

### CLI Flags
```
-addr        :7070          Listen address
-deploy-dir  /opt/plc       Working directory for binaries & logs
-shm-name    plc_runtime    Shared memory name under /dev/shm
-shm-size    65536          Shared memory size (bytes)
-log-level   info           debug|info|warn|error
```

### Runtime Artifacts
- `deploy-dir/runtime.bin` — compiled PLC binary
- `deploy-dir/variable_table.json` — variable symbol table
- `deploy-dir/hmi_layout.json` — persisted HMI config
- `deploy-dir/logs/runtime_*_{stdout,stderr}.log` — process logs

### Addressed Variables & REST API

Variables get an IEC address in the VariableManager "Address" column (e.g. `%MW0`, `%MX0.1`, `%MD10`). Non-empty address = variable is exposed via REST API. Input: user can type a plain number (`1`) and it auto-formats to IEC based on type (BOOL→`%MX0.1`, INT→`%MW1`, DINT/REAL→`%MD1`, LREAL→`%ML1`). Or user can type full IEC address directly.

**IEC address prefix logic** (`formatIECAddress` in VariableManager.jsx):
- `BOOL` → `%MX{byte}.{bit}` (e.g. address 9 = byte 1, bit 1 → `%MX1.1`)
- `BYTE/SINT/USINT` → `%MB{n}`
- `INT/UINT/WORD` → `%MW{n}`
- `DINT/UDINT/DWORD/REAL/TIME` → `%MD{n}`
- `LINT/ULINT/LWORD/LREAL` → `%ML{n}`

**Password**: Single API password set in SettingsPage → Connection tab. Hashed (SHA-256 with 16-byte salt) and embedded in `variable_table.json` as `api_password_hash` + `api_password_salt` during Build & Send. Empty = API disabled.

**variable_table.json extended format**:
```json
{
  "variables": [
    { "name": "prog__motor_speed", "offset": 0, "type": "float32", "size": 4,
      "force_flag_offset": 32768, "address": "%MD0", "initial_value": 0.0 },
    { "name": "prog__pump_on", "offset": 4, "type": "bool", "size": 1,
      "force_flag_offset": 32769, "address": "%MX0.4", "initial_value": true }
  ],
  "api_password_hash": "a1b2c3...",
  "api_password_salt": "d4e5f6..."
}
```

**Initial values**: `WriteInitialValues()` is called before runtime Start. Writes `initial_value` from variable_table.json to SHM so variables start at their configured defaults on every restart.

**Agent restart**: KronServer auto-rehydrates `{deploy-dir}/variable_table.json` on startup (`server.go` `loadStoredVariableTable`). Without this the API password (embedded in the file) would be empty after every reboot and `/api/v1/auth` would return 503 even though Build & Send had already deployed the file. The PLC runtime does NOT need to be running for the REST API to work — the agent and the runtime are independent processes; only `LoadVariableTable` matters for `APIEnabled()`.

**REST API Endpoints** (`api.go`):
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/auth` | No | `{"password":"..."}` → `{"token":"..."}` |
| GET | `/api/v1/variables` | Bearer token | All addressed variables |
| GET | `/api/v1/variables/{name}` | Bearer token | Single addressed variable + address field |
| POST | `/api/v1/variables/{name}` | Bearer token | Write value |
| GET | `/api/v1/stream` | Bearer token | SSE stream (addressed only, cadence tunable, default 50ms) |
| POST | `/api/v1/forces/clear` | Bearer token | Clear force flags |
| GET | `/api/v1/runtime` | Bearer token | `{running, pid, auto_run, stream_interval_ms}` |
| POST | `/api/v1/runtime/start` | Bearer token | Start PLC runtime (mirrors ConnectRPC `Start`) |
| POST | `/api/v1/runtime/stop` | Bearer token | Stop PLC runtime (SIGTERM → 5s → SIGKILL) |
| POST | `/api/v1/runtime/config` | Bearer token | Partial update of `auto_run` and/or `stream_interval_ms` |

**Stream cadence scope**: only `/api/v1/stream` (addressed variables, external clients) is tunable. Editor streams (`/stream/vars` SSE and ConnectRPC `StreamVars`) are deliberately fixed at the `streamInterval` constant (50 ms) — the editor relies on this stability. The `stream_interval_ms` knob is clamped to **5–60000** and changes apply on the next tick to all in-flight `/api/v1/stream` clients (no reconnect needed).

**Key files**:
- Editor: `VariableManager.jsx` (`formatIECAddress`), `CTranspilerService.js` (propagation), `App.jsx` (password hash)
- Server: `ipc.go` (`ReadAddressedVariables`, `CheckAPIPassword`, `WriteInitialValues`), `api.go` (REST endpoints)

### AutoRun

**Editor**: AutoRun toggle button in toolbar (green = ON, grey = OFF). Persisted in project XML.

**Deploy**: `POST /deploy/config` sends `{"auto_run": true/false}` → server saves to `deploy-dir/runtime_config.json`.

**Server startup**: If `auto_run=true` in `runtime_config.json`, server calls `WriteInitialValues()` then starts the runtime automatically.

**Editor on connect**: Every 10s status check parses `/status` JSON. If `running: true` and editor doesn't think it's running → attaches as if Start was pressed (creates PLCClient, starts stream, sets `isRunning=true`). If `running: false` and editor thinks it's running → detects crash, sets `isRunning=false`.

**`/status` response** includes `auto_run: bool` and `stream_interval_ms: uint`.

**`/deploy/config` endpoint**: `POST /deploy/config` — no auth required (same trust level as other deploy endpoints). Accepts a **partial** JSON body: omitted fields keep their current value, so the editor can push `{"auto_run": ...}` without clobbering an API-tuned `stream_interval_ms`. Saves `runtime_config.json`. Same partial-update payload is also accepted (with bearer auth) at `POST /api/v1/runtime/config`.
