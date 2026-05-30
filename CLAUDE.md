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

- **Frontend**: React (Vite), ReactFlow (LD diagram), Monaco (ST editor) — runs in a browser tab
- **Host agent**: Go (`host-agent/`) — single binary, listens on **`:7171`**, embeds the Vite build via `embed.FS`. Replaces what Tauri's Rust backend used to do (file I/O, GCC/clang invocation, simulation spawn, shared memory, HMI server, deploy to remote device).
- **PLC languages**: IEC 61131-3 LD + ST → transpiled to C → compiled with bundled clang (LLVM toolchains under `toolchains/`)
- **Simulation**: compiled binary spawned by the host agent; variables read/written via `/proc/<pid>/mem` (Linux); live updates streamed to the browser over SSE (`/api/host/plc-variables` and `/api/host/events`)
- **Deployment Server**: Go (KronServer, `server/`) — ConnectRPC/gRPC agent that runs on the **target device** for PLC runtime deployment, shared memory IPC, HMI serving. The host agent talks to it over HTTP for `Build & Send`.

### Tauri removed
The old Tauri v2 desktop wrapper (`src-tauri/`) has been deleted in favour of the browser+host-agent setup. All 24 `invoke('cmd', args)` calls were ported to `host.<method>(args)` (see `src/services/HostClient.js`); event listeners were ported to SSE via `host.streamEvents()`; `@tauri-apps/plugin-fs`, `plugin-dialog`, `plugin-clipboard-manager`, and `getCurrentWindow()` were replaced by `src/services/browserFs.js` and `navigator.clipboard`. **Some commands are intentionally stubbed (501 Not Implemented)** in `host-agent/`: `update_libraries`, `update_server`, `build_soem`, `build_canopen`, `ec_request_state`. Re-implementing them is a follow-up — the editor's core compile/run/deploy path does not depend on them. **`deploy_server_to_target` IS implemented** (`host-agent/deploy_ssh.go`, deps `golang.org/x/crypto/ssh` + `github.com/pkg/sftp`): SFTP-uploads the prebuilt `plc-agent` for the board to `<home>/plc/plc-agent`, installs a supervisor (systemd unit when `/run/systemd/system` exists, else a cron `@reboot` POSIX-sh restart loop), starts it, and polls `http://host:7070/status` (5×2 s) to verify. Progress streams on the `server-deploy-progress` SSE topic (the panel opens it before the POST). **Auth tries `ssh.Password` AND `ssh.KeyboardInteractive` (same password)** — PAM-only servers offer keyboard-interactive, not the raw password method, so a correct password fails without the fallback. **Host keys use agent-managed TOFU** (`tofuHostKeyCallback`, `AppDataDir/known_hosts` via `golang.org/x/crypto/ssh/knownhosts`): unknown host → accept + persist on first use (first deploy to a never-SSH'd device just works); same key later → accept; **changed key → reject** (MITM/reinstalled device; user removes the line to re-trust). This replaced the earlier blanket `InsecureIgnoreHostKey`. **The binary it ships comes from `resources/<triple>/server/plc-agent_linux_{arm64|armv7|amd64}` — `server/build.sh` now copies its `dist/` output there, so a server rebuild is actually what gets deployed; if you edit `server/` you MUST re-run `server/build.sh` or the deploy ships a stale binary.**

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

## Dev Workflow

```
# Terminal 1: Go host agent (serves API + embedded frontend on :7171)
cd host-agent && go run .

# Terminal 2: Vite dev server (hot-reload, proxies /api/host → :7171)
npm run dev
```

Open `http://localhost:1420` (Vite) for active development; the host-agent's `http://localhost:7171` serves the built frontend (after `npm run build:frontend`) for production-mode browsing.

Single-binary production build:
```
npm run build           # = build:frontend + build:host-agent
./dist-binary/kron-host-agent
```
The resulting binary embeds the React app via `embed.FS` (see `host-agent/embed.go`) and looks for the `resources/` and `toolchains/` directories as siblings of the executable (or the working directory).

### Version — single source of truth = `package.json`
Bump the app version in **one place: `package.json` `"version"`**. It propagates everywhere:
- **Frontend** (About in `StartScreen.jsx` + `SettingsPage.jsx`): Vite injects `__APP_VERSION__` from package.json (`vite.config.ts` `define`); components import `APP_VERSION` from `src/version.js`. Never hardcode a version string in a component again.
- **Go host-agent** (`/api/host/health` `version`): `main.go` has `var appVersion = "dev"`, overridden at build time via `-ldflags "-X main.appVersion=$npm_package_version"` in the `build:host-agent` npm script and `-X main.appVersion=$VERSION` in `packaging/*.sh` (which read it with `node -p`). `go run .` shows `"dev"`.
- **Windows installer** (`kron-editor.iss` `AppVersion`): `build-windows.sh` generates `packaging/windows/version.iss` (`#define AppVersion "x.y.z"`) from package.json; the `.iss` `#include`s it (falls back to `0.0.0-dev` if absent). `version.iss` is gitignored.

### Distributables (`packaging/`)
Two end-user bundles, each = host-agent binary + `resources/` + a **host-specific** `toolchains/`:
- `packaging/build-appimage.sh` → `KronEditor-x86_64.AppImage` (linux toolchains; `AppRun` opens a terminal and runs the agent; both simulation and Build & Send work).
- `packaging/build-windows.sh` → `dist/windows/KronEditor/` payload (cross-built `.exe` + **windows** toolchains), packaged by `packaging/windows/kron-editor.iss` (Inno Setup, run on Windows) into `KronEditor-Setup.exe`.

Key facts a future change must respect:
- **Toolchains are per-host, sysroots are shared.** `setup_toolchain.py --host {linux|windows} --root <dir>` downloads the matching LLVM (`clang` vs `clang.exe`); target sysroots are identical. So Windows `clang.exe` cross-compiles to the Linux PLC targets — **Build & Send works on Windows**.
- **Local simulation is Linux-only and stays that way on Windows**: `runtime.go` reads `/proc/<pid>/mem` and runs a host-compiled binary. The host-agent *does* cross-compile for Windows (`GOOS=windows go build` succeeds — `/proc` paths are runtime strings, not build-time), so the editor + Build & Send ship fine; only RUN/simulate is disabled there.
- `setup_toolchain.py` emits to the repo-root `toolchains/` by default (the dir the host-agent resolves); packaging passes `--root <payload>/toolchains` to write into the bundle instead. `toolchains/` is ~5 GB and is embedded whole (no on-demand download), so artifacts are multi-GB.
- Startup UX is **terminal-only** (no auto-browser, no tray): the agent logs ports/URL to stdout; the user opens `http://localhost:7171`.

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
    HostClient.js           HTTP client for the local host-agent (compile, run-sim, deploy, etc.)
    browserFs.js            Browser replacements for plugin-fs / plugin-dialog (open/save/ask)
    PLCClient.js            HTTP/SSE client for the **remote** KronServer on the target device
    HmiExportService.js     HMI export
    EsiLibraryService.js    EtherCAT ESI file reader (uses host-agent filesystem endpoints)
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

host-agent/                 Local Go agent (replaces Tauri's Rust backend)
  main.go                   HTTP server, flag parsing, lifecycle
  paths.go                  Resolves resources/ + toolchains/ + app-data dir
  files.go                  write_plc_files, get_standard_headers, generic FS ops
  compile.go                compile_simulation, compile_for_target (bundled clang)
  runtime.go                run/stop_simulation, write_variable, ELF symbol parsing, /proc/<pid>/mem
  deploy.go                 check_server_status, deploy_to_server (HTTP to remote KronServer)
  hmi.go                    HMI in-memory state (server stubbed pending full HTML port)
  libraries.go              update_libraries / update_server (stubbed)
  ethercat.go               build_soem / build_canopen / ec_request_state (stubbed)
  events.go                 SSE broadcaster for build-command, library-update-progress, etc.
  embed.go                  embed.FS for the Vite build → served at /
  dist/                     Vite build output (Go embed source)

resources/<triple>/         Krontek libraries (was src-tauri/resources/)
  include/HAL/
    kronhal.h               HAL struct definitions + dispatch functions (SECONDARY COPY — edit KrontekLibraries/KronHAL/ first)
    kronhal_sim.h           Simulation stubs
    kronhal_rpi.h           Raspberry Pi HAL
    kronhal_jetson.h        NVIDIA Jetson HAL
    kronhal_bb.h            BeagleBone HAL
  lib/                      Prebuilt .a libraries (do not edit)

toolchains/                 Bundled LLVM (clang, llvm-ar) + harvested sysroots
  bin/clang, llvm-ar
  lib/clang/<ver>/include/
  sysroots/<triple>/        Per-target sysroot (x86_64-linux-gnu, aarch64-linux-gnu, …)

public/libraries/           XML block library definitions loaded by LibraryService.js

server/ (in-tree at <repo>/server/ — Go agent sources, cross-compiled to target binaries)
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
- `liveVariables` — map of live variable values pushed from the host-agent SSE stream (`simulation-output` topic on `/api/host/events`)

### Simulation Flow
```
App.jsx: startSimulation()
  → host.writePlcFiles({...})        POST /api/host/write-plc-files     (Go agent writes plc.c/h, variables.json)
  → host.compileSimulation()         POST /api/host/compile-simulation  (Go agent invokes bundled clang → runtime.bin)
  → host.runSimulation()             POST /api/host/run-simulation      (Go spawns binary, starts /proc/<pid>/mem poller)
  → SSE `simulation-output` topic on /api/host/events → liveVariables state → watch panel
isRunning=true → all editors go readOnly
```
**Auto-run on Simulation ON:** `handleToggleSimulation` (App.jsx), after transpile+compile+`setIsSimulationMode(true)`, calls the shared `runSimulationNow()` helper — toggling Simulation Mode ON immediately starts the run (no separate Run click). `handleStartExecution`'s sim branch reuses the same helper.

**ST editor inline live badges** (`EditorPane.jsx`, the CoDeSys-style decorations) — TYPE-AWARE via a `varTypeMap` (name→type) + `SCALAR_IEC_TYPES` (module-level set; anything not in it, or matching `ARRAY`/`[`, is COMPOSITE = FB instance / UDT / array): a **call site** (`blink(...)`, next char `(`) gets NO badge; a **member access** (`blink.Q`) always `continue`s after (optionally) showing the MEMBER's scalar value (`val.Q`) — so the base FB/struct is NEVER rendered as a bogus scalar (this is what caused `blink 0 .Q`); a **composite root** (FB/struct/array referenced whole) shows a `{ } struct` / `▦ array` icon (class `live-var-text-struct`), NOT a raw value; **scalars** render the value badge. **Live-value HOVER** (`registerHoverProvider('iec-st')`): hovering an FB/struct/array var shows its full contents as a Markdown table (`formatLiveHoverMd`) — members for a struct/FB object, or array elements gathered from the indexed `prog_X_arr[i]` live keys. The provider reads `window.stLiveCtx = { live, prog }` (refreshed each tick by the decoration effect; nulled when not running). The watch table (`VariableManager.formatLiveDisplay`) still formats whole FB objects as `Q=F ET=T#0s`. **FB outputs on the TARGET (Build & Send) vs local sim — two representations, overlay handles both:** the local sim reads the FB struct via DWARF and decodes it to an OBJECT at `prog_X_blink` (`{Q,ET}`); the target's KronServer reads `/dev/shm` by offset and can only stream SCALARS, so the FB struct itself isn't visible. To fix that, the transpiler (`CTranspilerService.js`, FB-instance loop) now also emits each FB scalar OUTPUT pin (`FB_OUTPUTS[type]` × `getOutputPinType`) as its own SHM-slotted variable, debug key `prog_X_<var>.<pin>` with c_symbol `prog_X_inst_<var>.<pin>` (so `plc_shm_sync` copies `S->…inst_blink.Q` to its slot) — so KronServer streams `prog_Blinker_blink.Q` as a flat bool. The ST overlay's member-access resolves BOTH: object `val.Q` (sim) OR the flat live key `prog_X_<var>.<pin>` (target); the hover provider reconstructs an object from those flat `.pin` keys too. No KronServer change (it already streams scalars by name). Requires a re-Build&Send (new `variable_table.json` + runtime.bin).

### Read-Only Mode (isRunning=true)
- `App.jsx` → passes `isRunning` to `EditorPane` and `ProjectSidebar`
- `EditorPane` → Monaco `readOnly={isRunning}`, `RungEditorNew readOnly={isRunning}`
- `RungEditorNew` → all add/delete/move/connect operations blocked
- `VariableManager` → `disabled={isRunning}`
- `ProjectSidebar` → add/delete/edit buttons disabled

---

## Hot-Swap (Online Change) — Linux-only

State-preserving live PLC code update: change logic while running, no restart, timers/counters/latches survive. **Developed on branch `feat/hotswap-plcstate`.** Linux-only by design — MCU/bare-metal (`arm-none-eabi`) compile targets were removed from `setup_toolchain.py` + `host-agent/compile.go`/`paths.go`.

**Core idea — split the binary into a stable loader-host + a swappable `logic.so`:**
- The transpiler now ALWAYS emits a single `PlcState` struct holding ALL mutable state (globals, program locals, FB instances, shadow vars, exec-time) reached through a file-scope `static PlcState *S`. Every state reference is `S->…` (varMap in `transpilePOUSource`, `resolveVar`/`getCallTarget`/shadow write-back in `transpileLDLogics`, SHM pull/sync, exec vars). FB-local vars stay `instance->…`; function/LD-transient locals stay bare. Declarations are collected into `stateFields` and emitted as the struct AFTER all type defs (UDTs, FB typedefs) + signatures but BEFORE function bodies; non-zero initials go to a `plc_state_init()` cold-init called from `PLC_Init`. The single instance is `static PlcState __plc_state;` with `static PlcState *S = &__plc_state;`. **Consequence for the regular (non-hot-swap) local sim:** PLC variables are now struct FIELDS, not standalone globals, so the old "look up each variable's C symbol in the ELF `.symtab`" live-read (`runtime.go` `buildVarSpecs`, reads `/proc/<pid>/mem`) finds nothing → `"No variables matched in symbol table"`. The fix has THREE interlocking parts: (1) **`__plc_state` must have EXTERNAL linkage** in the non-hot-swap build — `#ifdef PLC_HOTSWAP` keeps it `static` (host owns state), but otherwise it's a plain global `PlcState __plc_state;`. As `static`, `-O3` SROA-dissolves it entirely (the SHM pull→use→sync makes every field a pass-through redundant with `__plc_shm`), leaving NO symbol — verified: `static` → symbol absent in the `.o`, external → `B __plc_state` present. No-LTO external globals are observable so they can't be removed/scalarized, and layout stays ABI-fixed. (2) the sim is compiled with **`-g`** (`compile.go`) so DWARF carries the struct layout. (3) `parseELFSymbols` finds the `__plc_state` base address + each member's offset from **DWARF** (`plcStateMemberOffsets`, tolerates a clang `__plc_state.N` suffix), registering `memberName → absAddr` so `buildVarSpecs` matches `c_symbol`/`base_symbol` exactly as before. **The sim build now uses `-O0` (not `-O3`)** — the sim is a logic test, not a perf target, and `-O3` was the dominant compile-time cost on large projects (motion/EtherCAT inline headers); `-O0 -g` compiles much faster AND, as a bonus, would keep `__plc_state` even without the external-linkage fix (no SROA at `-O0`) — but keep external linkage anyway as belt-and-suspenders if `-O` is ever bumped. The cross-compiled **target/deploy** build (`compileForTarget`) stays `-O3`. The hot-swap path was unaffected because it reads the `/dev/shm` mirror by byte offset, not by symbol. **CRITICAL filename separation:** the local-sim binary is `simBin = "sim_runtime.bin"` (host x86_64, `-O0 -g`); the target/deploy + hot-swap binary is the literal `"runtime.bin"` (cross-compiled for the ARM board, `-O3`, no `-g`). They live in the SAME build dir but MUST NOT share a name — they used to both be `runtime.bin`, so a **Build & Send / Go-live clobbered the local sim binary with a wrong-arch, no-DWARF ARM one**, after which local simulation read garbage and FB objects (e.g. `blink.Q`) never resolved (the binary was literally `ELF … ARM aarch64`). `simBin` is referenced ONLY by `compileSimulation` (writes it) and `handleRunSimulation` (runs it). **Build cache:** the bundled clang is **~242 MB**, so its cold load (first compile / after the page cache is evicted) dominates the perceived "compiling…" time — the actual codegen is ~60 ms (measured). `compileSimulation` therefore SKIPS clang when the transpiled inputs are unchanged: `simInputsHash(buildDir)` = SHA-256 over `plc.c`+`plc.h` (they fully determine the binary), compared against `sim_runtime.bin.hash`; on a hit (and the binary exists) it returns `"(cached …)"` immediately. So re-toggling Simulation off→on without code changes is near-instant.

**Simulation while PLC connected:** `handleToggleSimulation` no longer blocks when `isPlcConnected` — local sim and a remote PLC connection coexist (the status-poll that auto-attaches to a running remote already guards `!isSimulationModeRef.current`). Instead, the **Build & Send button is disabled while `isPlcConnected && isSimulationMode`** (turning Simulation OFF re-enables it) — prevents pushing to the device mid-sim.
- **`-DPLC_HOTSWAP`** turns the same `plc.c` into a loadable `logic.so`: `plc_stop`/`us_tick`/`__plc_shm` become host-owned (extern; declared in plc.h), `main()`+threads are `#ifndef PLC_HOTSWAP`, and it exports a fixed ABI — `plc_state_size`, `plc_bind(PlcState*)`, `plc_state_init`, `plc_init_hs`/`plc_cleanup_hs`, `plc_task_count`, `plc_task_interval_us(i)`, `plc_task_body_<i>()`, `plc_shm_name`/`plc_shm_size`. Without the define it builds as the normal single binary (unchanged behavior). Per-task scan was refactored into `plc_task_body_<i>()` shared by both modes.
- **Loader-host** (`host-agent/hotswaphost/host.c`, embedded into the agent): owns `PlcState` (host memory → survives swap), the `/dev/shm` mirror (`__plc_shm`, so the editor keeps reading live vars across swaps), `us_tick`/`plc_stop`, the scan threads + timing, compiled `-rdynamic` (the `.so` resolves `us_tick`/lib symbols from it). On `SIGUSR1` it reads `./swap_request`, parks all task threads on a scan-boundary barrier, `dlclose`+`dlopen`s the new `.so`, re-binds the SAME `PlcState` (no `state_init`), and **rolls back** to the running `.so` on any failure.

**Local sim (host-agent)** — `host-agent/hotswap.go`: `POST /api/host/hotswap/{build,run,swap,stop}` compiles host (once) + `logic_<n>.so` (`-shared -fPIC -DPLC_HOTSWAP` + libs), runs the host, pushes swaps (write `swap_request` + SIGUSR1), and a `/dev/shm` poller streams live vars on the existing `simulation-output` SSE. HostClient: `hotswapBuild/Run/Swap/Stop`. App.jsx: `startHotSwapSession`/`stopHotSwapSession` + `handleAgentHotSwap` (re-transpile → `hotswapSwap`); the AI agent's `read_live_variables` tool + approved edits push online changes when the panel's "Go live" session is active.

**Field (KronServer)** — `server/hotswap.go` + `process.go`: `runtime.bin` runs in host mode (`runtime.bin logic_0.so`) when a `logic_0.so` is present; `POST /deploy/logic` uploads `logic_<n>.so`, `POST /hotswap/swap` calls `ProcessManager.SwapLogic` (write `swap_request` + SIGUSR1). The editor side is wired: host-agent `POST /api/host/hotswap/target-build` cross-compiles the loader-host (`runtime.bin`, **dynamic/-rdynamic** so it can dlopen) + `logic_0.so` for the ARM target (aarch64/armv7); `deployToServer` now also pushes `logic_0.so`; `/api/host/hotswap/target-logic` recompiles `logic_<n>.so` for an online change and `/api/host/hotswap/deploy-swap` uploads it to KronServer + triggers the swap. App: **"Go live"** deploys the hot-swap runtime to the target when connected (else local sim); `handleAgentHotSwap` pushes agent-approved edits online (sim → local swap; field → recompile+upload+swap, with a `window.confirm` before touching live hardware). Cross-compile produces correct ARM artifacts; **the full field path is UNVERIFIED on real hardware.**

**Edge cases requiring a cold restart, NOT a hot-swap** (editor must detect via a layout/ABI signature): task-config change (count/interval/priority), any variable-table change (add/remove/retype/re-address a var, esp. globals), FB instance add/remove/retype, board/IO/HAL config, EtherCAT/PDO, UDT change, SHM size. Rule: hot-swap only when the `PlcState` layout + variable table + task/IO/EC config are byte-identical to the running one; only POU logic bodies differ.

**HAL-to-host (done for HAL):** HAL functions are `static inline` with file-scope `static` fd arrays (e.g. `_rpi_uart_fd[6]`), so a naive split loses IO state on swap. Fix (codegen-partition, no canonical HAL edits): in hot-swap mode the transpiler emits a guarded macro block in plc.h — `extern void __hs_F(void*); #define F __hs_F` placed AFTER `kronhal.h` (real defs) but before the bodies — so the logic.so's HAL calls become `__hs_*` with NO call-site changes; the transpiler also returns `hostGlue` (a `host_glue.c` that `#define PLC_HOST_GLUE` + includes the HAL preamble + defines `void __hs_F(void*i){F(i);}` trampolines). The host-agent compiles `host.c`+`host_glue.c` together (`-rdynamic`, HAL + its fds live in the host); `logic.so` resolves `__hs_*` from the host at dlopen. HAL state survives swaps. **Verified end-to-end on the local sim** (build→run→swap, cnt continuous, HAL untouched). Trampolined surface = HAL block `_Call`s + `HAL_Init`/`HAL_Cleanup`/`KRON_UART_RuntimeInit`/`Cleanup`.

**Known gaps before field use:** (1) **EtherCAT/motion are NOT trampolined** — `__ec_cfg`/`Kron_PI`/PDO state still lives in `logic.so`, and in hot-swap mode the PDO read/write (host-thread-loop, `#ifndef PLC_HOTSWAP`) don't run, so a project using EtherCAT/motion can't hot-swap that IO (full redeploy + restart); pure logic + HAL works. (2) `sudo -n`-spawned runtime won't receive SIGUSR1 — agent must run as root on target. (3) The loader-host is cached per build dir, so a HAL/board change needs a clean build to rebuild the host. (4) The whole field path is **compile-verified only** (ARM artifacts build); on-hardware testing (real fds, real swap, real-time jitter during the barrier) + a proper operator-confirm/safe-state review are still required.

**Verification harness:** `experiments/transpiler-check/` (`compile-gate.sh` compiles real transpiler output with bundled clang — the completeness gate for the `S->` migration) and `experiments/hotswap-v2/` (`demo.sh` proves live swap with state preserved + `/dev/shm` live read, using real codegen).

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

### Task assignment — STRICT (a program runs only if assigned to a task)
`generateMainLoop` (CTranspilerService.js) builds task→program groups from `taskConfig.tasks` (priority order: `taskConfig` > legacy `res_config` > none). **A program is executed ONLY if it is explicitly assigned to a task.** There is NO `__unassigned` default-task fallback (it was removed — it used to auto-run any unassigned program at 10 ms whenever ≥1 task existed, which surprised users: "I never assigned it but it runs + streams data"). Now an unassigned program's POU code is still generated but never called by a task thread, so its variables stay at their initial values (no live data). The transpiler `console.warn`s the unassigned program names, and `handleToggleSimulation` (App.jsx) compares `projectStructure.programs` against `variableTable.tasks` (the authoritative run-list; `program` names normalized spaces→`_`) and `addLog`s a UI warning ("Not assigned to any task — will NOT run: …"). With ZERO tasks configured at all, nothing runs (unchanged).

### ST Transpilation — Line Handling
- **Comment stripping order (in `transpileSTLogics`):** BOTH `(* … *)` block comments AND `// …` line comments are stripped in the initial `stripped` step, BEFORE the keyword-normalization pass (which injects newlines after `THEN`/`DO`/`OF`/`ELSE`/`END_*`). Order matters: an ST keyword appearing inside a comment (e.g. the word "**of**" in `// period of 1 second`) matches `\bOF\b` and gets a newline injected mid-comment, splitting it so the tail (`1 second`) survives and leaks into the C output as a bogus statement → `error: expected ';'`. If you add comment handling, keep it ahead of normalization.
- Variables are referenced by BARE name in ST — there is NO `global.`/`GVL.` namespace object. The system prompt instructs the model to never write `global.led`/`global.blink.Q` (a CODESYS habit some models have); member access is only for FB output pins (`blink.Q`).
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

## AI Agent Panel (`src/components/AiAgentPanel.jsx`)

Second tab of the right "Kütüphane" sidebar — a **real tool-calling agent** that edits the project (NOT a chat stub anymore; `sampleReply` is gone). It can create/rename/delete POUs, rewrite ST, add/update/remove variables (local + global), and author ladder. The **board is read-only context** — no tool changes hardware. Config persists in `localStorage["aiAgentConfig"]` = `{provider, model, apiKey, baseUrl}`. **Display name is "PLC Agent"** (sidebar tab + panel header + the `addLog` "PLC Agent applied changes" line); the CODE symbols stay `AiAgentPanel` / `aiAgentConfig` / `aiAgentConversation` / `/api/host/ai/*` (renaming those would break persisted config + routes — only the user-visible strings were rebranded). **The system prompt now instructs a CLARIFY-FIRST policy:** on a materially ambiguous request (a named "block" that could be an FB or a plain var, unspecified ST/LD/SCL, unknown type/address/axis/IO channel) the model asks 1–3 questions and emits NO tool calls that turn — the loop already renders a no-tool-call turn as a normal assistant message the user answers (so no loop change was needed). **Model field is an editable combobox** (`ModelCombo`) — known models are suggestions but any name is typeable (Gemini ships many). **Provider list includes `gemini`** (see ai.go note).

### Agent architecture (3 layers)
- **`host-agent/ai.go`** — provider-agnostic **single-turn** chat proxy at `POST /api/host/ai/chat`. STATELESS normalizer: given `{provider, model, apiKey, baseUrl, system, messages, tools, maxTokens?, temperature?}` it calls the configured provider and returns ONE normalized assistant message `{role:'assistant', content, toolCalls:[{id,name,arguments}]}`. Each provider's wire dialect is isolated in `callAnthropic` (`/v1/messages`, `x-api-key`, content-block tool_use/tool_result, merges consecutive same-role turns), `callOpenAI` (`/v1/chat/completions`, Bearer, `tool_calls` with string args; also serves `custom` — OpenAI-compatible, baseUrl required — AND `gemini`/`google`, routed to Gemini's OpenAI-compat base `https://generativelanguage.googleapis.com/v1beta/openai` with default base so no baseUrl entry is needed; tool-calling works), `callOllama` (`/api/chat`, `stream:false`, object args, synthesizes `call_<i>` ids since Ollama gives none). Normalized message shape is shared in both directions; `aiTool.parameters`/`aiToolCall.arguments` are `json.RawMessage`. **Ollama prompt-based tool fallback:** some Ollama models (e.g. `codellama`) have no native tool API and answer HTTP 400 `"<model> does not support tools"` when `tools` is sent. `callOllama` detects this (`isUnsupportedToolsErr`), then retries via `ollamaChatOnce` WITHOUT the `tools` field but with `toolPrompt(tools)` appended to the system prompt (renders each tool's name/description/JSON-schema + instructs the model to emit `{"name","arguments"}` JSON). The frontend's `extractInlineToolCalls`/`repairJsonBrackets` then recover those calls — so non-tool models still drive the agent (less reliably than a native-tools model like qwen2.5-coder).
- **`host-agent/anthropic_oauth.go`** — "Sign in with your Claude account" (Pro/Max subscription) as an alternative to an Anthropic API key. Implements Claude Code's public **PKCE OAuth** flow (client_id `9d1c250a-…`, authorize `claude.ai/oauth/authorize`, token `console.anthropic.com/v1/oauth/token`, redirect = the hosted `…/oauth/code/callback` that shows a `code#state` to paste). Routes: `/api/host/anthropic-oauth/{start,exchange,status,logout}`. Tokens persist at `AppDataDir/anthropic_oauth.json` (0600); `accessToken(force)` auto-refreshes within 60 s of expiry (or on a forced 401 retry). The agent uses provider **`anthropic-oauth`** (no apiKey) → `handleAIChat` calls `callAnthropic(ctx, req, oauthToken)`: that param switches `callAnthropic` to **Bearer auth + `anthropic-beta: oauth-2025-04-20`** (no `x-api-key`) AND sends `system` as content blocks **led by a "You are Claude Code…" identity block** (the subscription credential is only authorized for Claude Code, else 403). Frontend: provider `anthropic-oauth` in `PROVIDERS`; the config panel shows a sign-in flow (`anthropicOAuthStart` → open URL → paste `code#state` → `anthropicOAuthExchange`); `configured` treats it as ready when `oauth.connected`. **CAVEATS (user opted in):** gray-area ToS for 3rd-party subscription use, Claude-only, and breakable if Anthropic changes the flow.
- **`src/services/agentTools.js`** — the agent's **action surface**. `TOOL_DEFS` (JSON-Schema tool list sent to the model) + `applyToolCall(struct, name, args)`, a **pure** executor: never mutates in place, returns either `{mutation:false, ok, result}` (read tools) or `{mutation:true, ok, summary, diff, next}` (write tools, `next` = fresh projectStructure) or `{ok:false, error}`. Tools: `get_project_overview`, `read_pou`, `list_blocks`, `create_pou`, `rename_pou`, `delete_pou`, `set_st_code` (full-body replace), `add/update/remove_variable` (scope local|global, **defaults to local** — globals live in the RESOURCE_EDITOR `content.globalVars`), `set_ladder`. Purity is what enables the diff-then-approve flow. **`create_pou` accepts language `ST` | `LD` | `SCL`** (SCL = mixed, `{rungs,variables}` content like LD); **`set_ladder` works on LD *and* SCL POUs** (SCL ladder rungs are tagged `lang:'LD'`); `set_st_code` works on ST and SCL (SCL → a single `lang:'ST'` rung). `findPOU` is exported and case-insensitive, and rejects the literal strings `"undefined"`/`"null"` (weak models stringify a missing arg into them). **Program "tokenization" for the model:** `read_pou` renders LD/SCL rungs via `renderRungs` (NOT the old block-type-name `summarizeRungs`, removed) — it traces each rung's power-flow graph (`incoming` edges, memoized `exprOf` from the left rail) into readable boolean logic (`coil := (Start OR Motor) AND NOT Stop`; series=AND, converging edges=OR, NC contact=`NOT v`, coil SET/RESET/Negated tagged); ST/SCL-ST rungs surface verbatim `code`; rungs with FBs list them structurally + a note (FB internals are opaque to boolean rendering). **Live-data buffering for diagnosis:** `summarizeLiveSamples(samples)` (exported) condenses the panel's rolling snapshot buffer into a per-variable time-series — `last/first/min/max`, `changes`, a recent down-sampled series, and a `flags` classification (`constant` / `oscillating` [≤3 distinct values + ≥4 flips] / `rising` / `falling`); `read_live_variables` returns `{ running, values:current, history }`.
- **`list_blocks` is how the agent learns what FBs/functions exist and their PINS** (`buildBlockCatalog(struct, library, filter)`): standard library blocks come from App's `libraryData` (the parsed `public/libraries/*.xml`, shape `[{title, blocks:[{blockType, class, inputs:[{name,type}], outputs:[{name,type}]}]}]`) injected as `args.__library` by the panel; project-defined FBs/functions come from `struct.functionBlocks`/`functions`, pins derived from their variables by `class` (Input/InOut→inputs, Output→outputs — same rule the transpiler & RungContainer use). The system prompt lists only block **names** (grouped, scales as the XML grows) and instructs the model to call `list_blocks` for exact pins before using any FB/function in ST. **`set_ladder` still cannot place an FB into a rung** (contacts+coils only — FB rungs need `customData` pin metadata); the prompt routes timers/counters/motion/comm/user-FBs to ST instead.
- **`src/components/AiAgentPanel.jsx`** — owns the **agent loop** (it lives frontend-side because that's where `projectStructure` is). Per model turn: read tools auto-run and feed results back; write tools are dry-run into a composed `next` structure and shown as a **diff card the user must Approve/Reject** before it touches state. On approve → `setProjectStructure(next)` + `onApplied(pouNames)`. Loop capped at `MAX_AGENT_TURNS=16`. Tool-call args are chained through a `workingRef` so multi-step turns (add_variable then set_st_code) compose. **POU-target inference (weak-model safety net):** in the dry-run loop, a local-scope tool (`add_variable`/`update_variable`/`remove_variable` when scope≠global, plus `set_st_code`/`set_ladder` always) whose `pou` doesn't resolve in the working struct gets its `pou` rewritten to a context-inferred POU — the POU touched last this turn → the single `create_pou` of this turn → the open POU (`activeItem`). This is what fixes the common weak-model failure where it does `create_pou("X")` then `add_variable` with a missing/garbled `pou` (so the BOOL behind a ladder coil never lands and the rung references an undefined name). It only overrides an *unresolvable* `pou`, never a valid one. **Live-sample ring buffer:** a `liveBufRef` (cap `LIVE_BUF_MAX=600`) is appended in a lightweight `useEffect([liveVariables])` (ref, NOT state — no heavy re-render) while the program runs; `read_live_variables` injects `args.__live = { current: liveVariables, history: summarizeLiveSamples(liveBufRef.current) }`; the buffer is cleared on New chat. `extractInlineToolCalls` recovers tool calls that weaker local models emit as TEXT instead of the structured field — without it, qwen2.5-coder-class models don't drive the agent. It handles BOTH shapes: a proper `{name, arguments}` JSON object, AND the **markdown form** where the tool NAME is a heading and only the ARGS are JSON (`1. **create_pou**\n{"name":"Blinker","language":"ST"}`) — `findJsonObjects` returns each object's position, and a bare args object (whose `name` isn't a known tool) is paired with `lastToolMention` (the nearest known tool name in the preceding text). `create_pou` also DEFAULTS a missing/variant `category` to `programs` (weak models omit it). Without the pairing the qwen markdown output yields ZERO calls ("agent produced no output"). **`extractKeyValToolCalls`** handles a THIRD shape some models use — non-JSON `tool_name key="value" key=value` lines (one call per block; quoted values may span newlines, e.g. `set_st_code … code="…multi-line…"`): it finds each known tool name at a line-start call position and parses its key/value args up to the next tool name. **`recoverStCodeBlock`** is the last-ditch layer: after several turns a weak model may stop calling tools entirely and just PRINT the POU body in a ```st code block — this recovers the first ST-looking fenced block (tagged st/scl/iec/pascal, or content with `:=`/IEC keywords; JSON blocks skipped) as a `set_st_code` call with no `pou` (the POU-target inference fills the open POU). These layers keep qwen2.5-coder-7b *usable* but it remains unreliable across long conversations — a native-tools cloud model (Gemini/Claude) is far steadier. Two robustness layers ride on top: (1) **`stripSpecialTokens`** removes chat-template leakage (`<|im_start|>`) AND `<tool_call>`/`<tool_response>` wrapper tags some models emit (a faked `<tool_response>APPLIED:…</tool_response>` carries no JSON so it correctly yields no call); (2) **`repairJsonBrackets`** is a parse fallback for the single most common LLM JSON malformation — an object written with `[...]` instead of `{...}` (e.g. `set_ladder`'s `rungs: [["outputs":…]]`). It rewrites a `[` whose first non-space content is a `"key":` to `{` (and its matching `]` to `}`), is idempotent on valid JSON, and only runs after `JSON.parse` throws. A dropped `set_ladder` (malformed args) is what makes weak models then hallucinate a fake `<tool_response>` confirmation on the next turn — fixing the parse fixes both.

### Agent wiring & gotchas
- App.jsx passes `projectStructure`, `setProjectStructure`, `selectedBoard`, `onApplied` to `<AiAgentPanel>`. **EditorPane seeds its local state from `initialContent` only on mount** (keyed by `activeItem.id`), so an agent edit to the OPEN POU won't show until remount — App.jsx bumps `agentReloadKey` (added to the EditorPane `key`) when `onApplied` reports the active POU was touched.
- **`set_st_code` auto-recovers inline declarations (weak-model safety net).** The ST editor box is BODY-ONLY (variables live in the table), so `stripStWrappers` removes any `VAR…END_VAR` blocks and bare `name : TYPE;` lines a model wrongly inlines. But weaker models (qwen2.5-coder-7b class) routinely declare variables that way *instead of* calling `add_variable` — which would leave the body referencing undefined names. So `set_st_code` first runs `extractStDeclarations(rawCode)`: parses those stripped declarations (VAR_GLOBAL → global scope, VAR_INPUT/OUTPUT/IN_OUT/TEMP/EXTERNAL → matching class, else Local; multi-name `a, b : INT := 0;` supported) and **adds the missing variables to the POU (or globals) as part of the same diff**, skipping names that already exist. The system prompt still tells the model to use `add_variable`; this is the silent fallback when it doesn't. A pure body with no declarations adds nothing (FB calls like `pulse(...)` are never mistaken for decls — the `: TYPE` vs `:=` distinction guards it).
- **Ladder generation (`set_ladder`) is contacts + coils ONLY.** Function blocks (TON, CTU, HAL, motion, user FBs) need `data.customData.inputs/outputs` pin metadata from the XML library — the agent doesn't carry it, and `RungContainer` draws FB handles from that metadata, so a generated FB wouldn't render or transpile. For timers/counters/FBs the agent must use ST. The ladder compiler in `agentTools.js` (`compileLadderRung`) models a rung as OR-of-`branches` (each an AND-series of contacts) + optional `seriesAfter` + `outputs` coils; OR = multiple power-flow edges into one merge block, AND = a series chain (matches how the transpiler ORs incoming edges / ANDs series). Contacts set BOTH `data.instanceName` and `data.values.{var|coil}` (renderer reads instanceName-or-values at RungContainer.jsx:458; transpiler reads `values.var||instanceName`). Terminals are the literal ids `terminal_left_middle` / `terminal_right_middle`; contact/coil pins are `'in'`/`'out'`.

### Local model download & setup (Ollama) — REAL
The "Download & Setup" tab in the config dropdown talks to a locally-running **Ollama daemon** (default `http://localhost:11434`, overridable via the host field which writes `draftCfg.baseUrl`). Backend in **`host-agent/ollama.go`**, no `ollama` CLI shell-out — it proxies the daemon's HTTP API:
- `POST /api/host/ollama-status {baseUrl?}` → `{running, installed, models:[{name,size}]}` (queries `GET {base}/api/tags`; unreachable daemon = `running:false`, not an error. `installed` = an ollama binary exists user-local or on PATH).
- `POST /api/host/ollama-setup {baseUrl?}` → returns immediately `{started}`; **one-click bootstrap** in a detached goroutine: if the daemon is reachable → done; else locate an ollama binary (user-local install first via `findExtractedOllama`, then PATH), download the official archive into `{AppDataDir}/ollama` if missing (no sudo), then spawn `ollama serve` (tracked in `OllamaState.serveCmd`, killed on agent shutdown) and poll until ready. Progress on topic **`ollama-setup-progress`** = `{phase, percent, done, error}` (phases: checking/downloading/starting/ready/failed). `OllamaState.setting` dedupes concurrent setups.
- **Multiplatform install — asset naming is OS-specific and NOT static:** `downloadOllama` streams the archive to a temp file then extracts. **Linux** → `ollama.com/download/ollama-linux-{amd64|arm64}.tar.zst` — **zstd-compressed** (NOT gzip; Ollama renamed `.tgz`→`.tar.zst`), decoded via `github.com/klauspost/compress/zstd` (pure-Go, keeps `CGO_ENABLED=0`), layout `bin/ollama`+`lib/`. **Windows** → `ollama-windows-{amd64|arm64}.zip` (`archive/zip`), layout `ollama.exe`+`lib/` at root. `ollama.com/download/<asset>` 307-redirects to the GitHub `releases/latest/download/<asset>`, so a future asset rename there silently breaks setup — `findExtractedOllama` walks the dir as a fallback, but the URL/extension is still hardcoded per-OS. `exec.LookPath("ollama")` finds `ollama.exe` on Windows automatically. **Verified end-to-end on Linux** (download→zstd extract→`ollama serve`→GPU detect→model pull); Windows path is compile-verified only.
- `POST /api/host/ollama-pull {model, baseUrl?}` → returns immediately `{started}`; runs `POST {base}/api/pull` (stream) in a **detached goroutine** (2 h ctx, survives the request) and rebroadcasts progress on the generic event bus under topic **`ollama-pull-progress`** = `{model, status, completed, total, percent, done, error}`. `OllamaState.inFlight` map dedupes concurrent pulls of the same model.
- **`OllamaState` (in `ollama.go`) is a field on `Server`** (`srvState.ollama = NewOllamaState()`), all 3 routes registered in `main.go`, and `srvState.ollama.Stop()` runs on shutdown. Forgetting the struct field / init makes the host-agent fail to compile (the handlers reference `s.ollama`).
- `POST /api/host/ollama-runtime {model, baseUrl, load?}` → reports where the model runs: `{loaded, processor:"GPU"|"CPU"|"GPU/CPU", gpuPercent, modelSize, modelVram, gpu?:{name, vramTotal}}`. Placement comes from Ollama's `GET /api/ps` (`size_vram` vs `size`). `load:true` first preloads the model (empty-prompt `POST /api/generate`, blocks up to 120s) so /api/ps can observe it. **Total VRAM** has no Ollama HTTP surface: `detectGPU` tries `nvidia-smi --query-gpu=name,memory.total` first, then **falls back to scraping the managed daemon's own stderr/stdout** (`gpuLogTap` tees both streams and parses the `inference compute … description="…" … total="N GiB"` line into `OllamaState.gpuVramTotal`). The fallback matters because a driver/NVML mismatch breaks `nvidia-smi` even when Ollama's CUDA detection still works. `gpu` is omitted on CPU-only hosts. The frontend's `RuntimeStats` shows a badge + a VRAM bar of **modelVram / vramTotal** (model footprint vs capacity — a 7B model reads ~4.6/6 GB).
- Frontend consumes both progress topics via the existing `host.streamEvents()` SSE (NOT a dedicated stream). The Download button per model is `disabled` while the daemon is down; when `!running`, `OllamaCatalog` shows an **Install & Start Ollama** (or **Start Ollama** if `installed`) button wired to `ollamaSetup` — on setup `done && !error` it calls `refreshOllama`, flipping `running:true` and enabling the Download buttons. On pull `done && !error` it auto-writes `aiAgentConfig` to that ollama model and "connects" it. **"Use this model" keeps the config dropdown open** (doesn't close) so the active row's `RuntimeStats` is visible; while the Download tab shows the active ollama model, a 4s poll hits `ollamaRuntime` (first tick `load:true`). `OLLAMA_CATALOG` is the curated model list; installed models not in it render under "Other installed".
- HostClient methods: `ollamaStatus(baseUrl)`, `ollamaSetup(baseUrl)`, `ollamaPull(model, baseUrl)`, `ollamaRuntime(model, baseUrl, load)`.

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

## ST/SCL Editor Validation

Monaco's live "Undefined identifier" red squiggles for ST come from **`src/utils/stValidation.js` `findStMarkers(code, {allowedLower, conversionPattern, varTypes})`** — shared by the ST editor (`EditorPane.jsx`) and the SCL inline rung editor (`RungEditorNew.jsx` `validateSCLCode`); both pass their own allow-list + a `name→type` map and tag the returned markers with `MarkerSeverity.Error`. It does ONE forward token scan per line tracking the open-call-paren stack, so **named arguments (`IN := …` inside `TON(…)`) are validated as PINS, not variables**: a named-arg key is flagged ONLY when the call target resolves to a *known standard* FB/function and the key isn't one of its pins. Pins come from **`getStandardFBPins(type)` (exported from `CTranspilerService.js`)** = inputs ∪ outputs ∪ EN/ENO from `FB_INPUTS`/`FB_OUTPUTS` (plus `X_TO_Y` → en/eno/in/out); the call target is resolved either directly (type name like `TON`) or via the instance variable's declared type (`pulse : TON`). **Unknown targets (user-defined FBs, or an instance typed as a non-FB like `TIME`) return null ⇒ their named args are deliberately NOT flagged** (we can't know the pin list, so we never false-positive). Time/duration literals (`T#500ms`) and radix literals (`16#FF`) are blanked before scanning; member access (`x.Q`) is skipped.

## LD Editor

### Project-tree Undo/Redo (App.jsx)
Separate from the LD-editor history below. Covers sidebar STRUCTURAL ops — add/delete/rename/reorder/paste of programs, function blocks, functions, data types (and paste-globals). Implementation: `undoHistoryRef = {past:[], future:[]}` (cap `UNDO_LIMIT=50`) + `projectStructureRef` (synced via effect). Each structural handler calls **`pushUndoSnapshot(prev)` INSIDE its `setProjectStructure(prev => …)` updater** (so it records ONLY when a real mutation runs — not on validation-failed early returns); `undoProject`/`redoProject` swap snapshots and update the ref synchronously (so rapid Ctrl+Z/Ctrl+Y chains). A window `keydown` handler does Ctrl+Z (undo) / Ctrl+Shift+Z|Ctrl+Y (redo), gated like the sidebar copy/paste handler: bail in INPUT/TEXTAREA/contentEditable (Monaco/LD own their undo) and when `getEditorScope()` is a non-SIDEBAR scope. NOT wired for variable-table edits or agent/taskConfig changes (only the listed sidebar ops snapshot).

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

## Clipboard / Copy-Paste (`src/utils/kronClipboard.js`)

Cross-tab copy/paste rides the OS clipboard (`navigator.clipboard`) with an in-process fallback. Every payload is tagged with a `CLIP_KIND` (`POU`, `RUNG`, `BLOCK`, `VARIABLE`, `GLOBALS`). Keyboard handlers in ProjectSidebar / VariableManager / RungEditorNew are **scope-gated** via `editorScope.js` (`EDITOR_SCOPE.SIDEBAR|VARIABLES|LD`), set on the container's `onMouseDown`; a handler bails if the scope isn't its own, so the three Ctrl+C/V listeners don't race on the shared clipboard.

**Paste-naming rules differ by kind — this is intentional:**
- **POUs / data types** (`handlePasteItem`, App.jsx): keep the original name; on collision append `_copy1`, `_copy2`, … (strip any existing `_copy\d*` first). ProjectSidebar's paste passes the source name verbatim — it does **not** pre-suffix `_copy`.
- **Local variables** (`uniqueVarName`, VariableManager): same `_copy{n}` scheme.
- **Global-variable SET** (sidebar "Global Variables" node → `CLIP_KIND.GLOBALS` → `handlePasteGlobals`, App.jsx): **merge by name, NOT `_copy`**. Globals are shared definitions, so a same-named global is **skipped** (destination's copy kept) rather than duplicated as `Foo_copy1`. Addresses are dropped on paste (hardware-unique; matches the variable-table paste convention). Copy/paste the whole set via Ctrl+C/V or right-click on the node; merging into another project is the point.
- **Referenced globals bundled with a POU**: copying a POU also bundles the globals it references (`bundleReferencedGlobals`) into `meta.globalsBundle`; `handlePasteItem` merges them by name (skip-if-present) — same philosophy as the GLOBALS kind.

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

Source: `<repo>/server/` (in-tree; cross-compiled by `server/build.sh` into `server/dist/` **and copied into `resources/<triple>/server/`** — the host-agent's `deploy_server_to_target` (SSH/SFTP, `deploy_ssh.go`) reads from there and ships it to the target hardware)

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
- `POST /deploy/project-file` — upload the editor project source (`project.xml`); `GET` returns it back. Editor-only — the runtime never reads it. Stored at `{deploy-dir}/project.xml` (`handleProjectFile` in `server.go`). Powers "Pull from Target".
- `GET /status` — JSON status report
- `GET /stream/vars` — SSE variable stream

**Project file round-trip**: `handleBuildAndSend` (App.jsx) POSTs the serialized project XML to `/deploy/project-file` right after the runtime/variable deploy — a failure here **fails the whole Build & Send** (strict). The Project dropdown's "Pull from Target" (`handlePullFromTarget`) GETs it back, loads it via `processFileContent(xml, label)` then clears `currentFilePath` so the next Save acts as Save As. Both calls are direct browser→KronServer fetches (like `/deploy/hmi-layout` and `/deploy/config`), NOT routed through the host agent. **Consequence: an already-deployed older KronServer without this endpoint will break Build & Send — rebuild + redeploy the server first.**

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

### HMI serving — two listeners, base-path aware
The same HMI UI is reachable two ways:
- **Agent port** (`:7070`) under **`/hmi/`** — always registered (`RegisterHMIRoutes`).
- **Dedicated operator port** at the **root** (`http://ip:PORT/`) — registered by `RegisterHMIRoutesAtRoot` on a second `http.Server` that only carries HMI routes (no deploy/RPC surface). Managed by `Server.applyHMIPort(port)` in `server.go`: idempotent, tears down on 0, rebinds on change, bind failures are logged not fatal. The port is `RuntimeConfig.HMIPort` (persisted in `runtime_config.json`, pushed via `/deploy/config` `hmi_port`); started in `Start()` and on every config update.
- Handlers/templates are **base-path aware** via `hmiBase(r)` (`"/hmi"` when the path starts with `/hmi`, else `""`). It drives the login/logout redirects, the session-cookie `Path` (`hmiCookiePath`), and the `BASE` const injected into `mainHMIHTML`/`loginHTML` (all fetch/form URLs are `BASE+'/api/...'`). Add base-awareness to any new HMI route or template path, or root serving breaks.
- **`/hmi/api/variables` returns only ADDRESSED variables** (`ReadAddressedVariables`), matching the REST API and the editor restriction below.

**Editor side**: the Visualization variable picker (`HmiProperties.jsx` `collectVars`) lists **only addressed variables** (global + local, with the address shown) — non-addressed vars have no value on the target's addressed feed, so binding them is pointless. The HMI port lives in **`hmiLayout.port`** (edited in the Visualization toolbar, default 8080, persisted in project XML since the whole `hmiLayout` is JSON-serialized). `handleBuildAndSend` pushes it as `/deploy/config` `hmi_port` (or `0` when there are no HMI pages → tears the listener down) and logs `http://<plc-host>:<port>/`.

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

**`/deploy/config` endpoint**: `POST /deploy/config` — no auth required (same trust level as other deploy endpoints). Accepts a **partial** JSON body (`auto_run`, `stream_interval_ms`, `hmi_port`): omitted fields keep their current value, so the editor can push `{"auto_run": ...}` without clobbering an API-tuned `stream_interval_ms`. Saves `runtime_config.json`. A present `hmi_port` triggers `applyHMIPort` (rebind/teardown of the dedicated HMI listener). Same partial-update payload is also accepted (with bearer auth) at `POST /api/v1/runtime/config`.
