# KronEditor — Architecture & Coding Reference

KronEditor is a browser-based **IEC 61131-3 PLC editor**. You draw Ladder (LD) diagrams and write Structured Text (ST), it transpiles to C, compiles with a bundled clang, and either runs a local simulation or deploys to a Linux single-board computer (SBC) running the KronServer runtime agent.

This file is the durable knowledge base for anyone (human or AI) working on the codebase. Read the section relevant to your task; the invariants marked **⚠️ INVARIANT** are things the code depends on that are easy to break silently.

## Table of Contents
1. [Rules for contributors](#1-rules-for-contributors)
2. [Technology stack & processes](#2-technology-stack--processes)
3. [Repository layout](#3-repository-layout)
4. [Dev workflow, versioning, packaging](#4-dev-workflow-versioning-packaging)
5. [The transpiler (ST/LD → C)](#5-the-transpiler-stld--c)
6. [Simulation, hot-swap & the PlcState model](#6-simulation-hot-swap--the-plcstate-model)
7. [Frontend architecture](#7-frontend-architecture)
8. [The AI agent panel](#8-the-ai-agent-panel)
9. [Board support (adding a new SBC)](#9-board-support-adding-a-new-sbc)
10. [HAL pattern](#10-hal-pattern)
11. [KronServer (target-device agent)](#11-kronserver-target-device-agent)
12. [Security model](#12-security-model)
13. [EtherCAT & motion](#13-ethercat--motion)
14. [Library system & clipboard](#14-library-system--clipboard)

---

## 1. Rules for contributors

**Language.** All code, comments, identifiers, and string literals are English only.

**Library C / HAL headers.**
- Header sources (`.h`, incl. `HAL/kronhal*.h`) now live in **ONE** place: `resources/krontek-include/`. Edit there — a single copy is served to every target, so there is no longer a per-triple sync step (the old `resources/<triple>/include/` copies were consolidated; drift between them was a recurring bug).
- If `KrontekLibraries/` is present on the machine, edit the canonical `.c` there first and mirror any `.h` change into `resources/krontek-include/`.
- Never generate `.a` static archives — only `.c`/`.h`. Rebuilding/deploying `.a` (per-triple under `resources/<triple>/lib/`) is the user's job.

**Ask before large or ambiguous changes.** When uncertain about requirements or direction, ask *before* implementing, not after.

**Keep this file current.** After each task, if something *durable and surprising* was learned (a new transpiler rule, a HAL behavior, a build quirk, a non-obvious workaround), update the relevant section here in the same turn. Do **not** record session-specific debugging state or anything already obvious from the code.

---

## 2. Technology stack & processes

Three processes cooperate:

| Process | Language | Role |
|---|---|---|
| **Frontend** | React (Vite), ReactFlow (LD), Monaco (ST) | The editor UI, runs in a browser tab |
| **Host agent** | Go (`host-agent/`) | Local backend on **`:7171`**: file I/O, clang invocation, simulation spawn + `/proc` variable reads, SSE streaming, deploy-to-device. Embeds the Vite build via `embed.FS`. |
| **KronServer** | Go (`server/`) | Runs **on the target SBC**: receives deployed runtime, manages its lifecycle, shared-memory IPC, HMI + REST API. Host agent talks to it over HTTP for Build & Send. |

- **PLC languages:** IEC 61131-3 LD + ST → transpiled to C → compiled with bundled clang (LLVM toolchains under `toolchains/`).
- **Simulation:** compiled binary spawned by the host agent; variables read/written via `/dev/shm` (hot-swap default) or `/proc/<pid>/mem` (legacy plain sim); live updates stream to the browser over SSE.

### Tauri has been removed
The old Tauri v2 desktop wrapper (`src-tauri/`) is gone in favour of browser + host-agent. All `invoke('cmd', args)` calls became `host.<method>(args)` (`src/services/HostClient.js`); event listeners became SSE via `host.streamEvents()`; the Tauri fs/dialog/clipboard plugins became `src/services/browserFs.js` + `navigator.clipboard`.

**Intentionally stubbed (501)** in the host agent: `update_libraries`, `update_server`, `build_soem`, `build_canopen`, `ec_request_state`. The core compile/run/deploy path doesn't need them.

**`deploy_server_to_target` IS implemented** (`host-agent/deploy_ssh.go`, uses `golang.org/x/crypto/ssh` + `github.com/pkg/sftp`): SFTP-uploads the prebuilt `plc-agent` for the board to `<home>/plc/plc-agent`, installs a supervisor (systemd unit if `/run/systemd/system` exists, else a cron `@reboot` restart loop), starts it, and polls `http://host:7070/status` (5×2s) to verify. Progress streams on the `server-deploy-progress` SSE topic.
- **Auth tries `ssh.Password` AND `ssh.KeyboardInteractive` (same password)** — PAM-only servers offer only keyboard-interactive, so a correct password fails without the fallback.
- **Host keys use agent-managed TOFU** (`tofuHostKeyCallback`, `AppDataDir/known_hosts`): unknown host → accept + persist; same key later → accept; **changed key → the current code auto-retrusts** (removes the old entry and accepts). ⚠️ This is *weaker* than pure TOFU and offers no MITM protection against a changed key; it is a deliberate usability tradeoff. Do not "fix" it without discussing — but be aware of the exposure (password-based auth means an MITM could harvest the device password).
- **`serverBinaryForBoard` (deploy_ssh.go) maps board-id prefix → server binary arch.** aarch64 board prefixes → `plc-agent_linux_arm64`; `bb_` (armv7) → `plc-agent_linux_armv7`; default → amd64. ⚠️ When adding a new aarch64 board family, its prefix MUST be added here or the deploy ships the wrong-arch binary. The binary source is `resources/<triple>/server/plc-agent_linux_{arm64|armv7|amd64}` — `server/build.sh` copies its `dist/` output there, **so after editing `server/` you MUST re-run `server/build.sh` or the deploy ships a stale binary.**

---

## 3. Repository layout

```
src/                          React frontend
  App.jsx                     Root state: isRunning, isSimulationMode, liveVariables, project tree
  components/
    EditorPane.jsx            Tabbed editor: ST (Monaco), LD (RungEditorNew), Resource; live badges
    RungEditorNew.jsx         LD editor: rung list, block insertion, undo/redo
    RungContainer.jsx         ReactFlow canvas for one rung (large)
    VariableManager.jsx       Variable table (global + POU-local), IEC address formatting
    ProjectSidebar.jsx        Project tree; add/delete POUs; structural undo/redo
    Toolbox.jsx               Draggable block library (3-level hierarchy)
    OutputPanel.jsx           Simulation log + live variable watch
    BoardConfigPage.jsx       Board selection + interface (GPIO/I2C/SPI/UART/USB) config
    TaskManager.jsx           PLC task scheduling
    Slave/EtherCATEditor.jsx  EtherCAT master/slave config
    AiAgentPanel.jsx          Tool-calling AI agent ("PLC Agent")
  services/
    CTranspilerService.js     ST→C and LD→C transpiler (the main compile path)
    HostClient.js             HTTP client for the local host-agent
    PLCClient.js              HTTP/SSE client for the remote KronServer
    LibraryService.js         Loads XML block library from public/libraries/
    browserFs.js              open/save/ask replacements for the Tauri fs/dialog plugins
    agentTools.js             AI agent action surface (pure tool executor)
  utils/
    boardDefinitions.js       All boards: specs, pinout, usbPorts, interfaces
    boardLibraryBlocks.js     Per-board channel counts (BOARD_CHANNELS)
    devicePortMapping.js      Family → protocol → portId → Linux device path; getBoardFamilyDefine
    deviceCodegen.js          EtherCAT device C codegen; ALSO has a copy of getBoardFamilyDefine
    hwPortVars.js             System STRING vars from interfaceConfig
    libraryTree.js            Static toolbox tree + GENERIC_FB_DEFS + PROTOCOL_BLOCKS
    stValidation.js           Monaco "undefined identifier" markers for ST/SCL
    plcStandards.js           IEC 61131-3 type definitions

host-agent/                   Local Go agent (replaces Tauri's Rust backend)
  main.go                     HTTP server, CORS/origin gating, lifecycle, body limits
  paths.go                    Resolves resources/ + toolchains/ + app-data dir
  files.go                    write_plc_files, get_standard_headers, generic FS ops
  compile.go                  compile_simulation, compile_for_target (bundled clang)
  runtime.go                  run/stop sim, write_variable, ELF/DWARF parse, /proc + /dev/shm
  hotswap.go                  Hot-swap loader-host: build/run/swap/stop, /dev/shm poller
  deploy.go                   check_server_status, deploy_to_server (HTTP to remote KronServer)
  deploy_ssh.go               SSH/SFTP server deploy; serverBinaryForBoard
  ai.go / anthropic_oauth.go / ollama.go   AI provider proxy, OAuth, local model setup
  events.go                   SSE broadcaster
  embed.go                    embed.FS for the Vite build → served at /

server/                       KronServer (cross-compiled to target binaries)
  main.go server.go service.go ipc.go process.go auth.go hmi.go api.go hotswap.go
  build.sh                    Cross-compile ARM32/ARM64/x86_64 → dist/ AND resources/<triple>/server/
  proto/ gen/                 Protobuf + ConnectRPC

hotswaplib/                   Shared Go module (local-replaced into host-agent + server go.mod)
                              Generation discovery + swap_result protocol

resources/krontek-include/    SINGLE shared header tree (HAL/*.h + kron*.h + soem/) — arch-independent, served to EVERY target via one -I (host-agent paths.go ResourceTargetIncludeDir). Replaces the old per-triple include/ copies.
resources/<triple>/           Per-arch build artifacts ONLY: prebuilt .a (lib/) + server binary (server/). No headers.
toolchains/                   Bundled LLVM (clang, llvm-ar) + per-target sysroots (~5 GB)
public/libraries/*.xml        Block library definitions loaded by LibraryService.js
KrontekLibraries/             SOURCE OF TRUTH for all .c/.h HAL & library sources
experiments/                  transpiler-check/ (compile gate), hotswap-v2/ (swap demo)
```

---

## 4. Dev workflow, versioning, packaging

### Local dev
```
# Terminal 1: Go host agent (API + embedded frontend on :7171)
cd host-agent && go run .

# Terminal 2: Vite dev server (hot-reload, proxies /api/host → :7171)
npm run dev
```
Open `http://localhost:1420` (Vite) for development. The host-agent's `:7171` serves the built frontend for production browsing.

### Production build
```
npm run build           # = build:frontend + build:host-agent
./dist-binary/kron-host-agent
```
The binary embeds the React app (`host-agent/embed.go`) and looks for `resources/` and `toolchains/` as siblings of the executable (or in the working directory).

### Version — single source of truth = `package.json` `"version"`
It propagates everywhere; never hardcode a version string:
- **Frontend:** Vite injects `__APP_VERSION__` (`vite.config.ts`); components import `APP_VERSION` from `src/version.js`.
- **Host agent** (`/api/host/health`): `main.go` `var appVersion = "dev"`, overridden at build via `-ldflags "-X main.appVersion=$npm_package_version"`. `go run .` shows `"dev"`.
- **Windows installer** (`kron-editor.iss`): `build-windows.sh` generates `packaging/windows/version.iss` from package.json.

### Distributables (`packaging/`)
Each bundle = host-agent binary + `resources/` + a **host-specific** `toolchains/`:
- `build-appimage.sh` → `KronEditor-x86_64.AppImage` (linux toolchains; sim + Build & Send work).
- `build-windows.sh` → payload packaged by `kron-editor.iss` (Inno Setup) into `KronEditor-Setup.exe`.

Facts a packaging change must respect:
- **Toolchains are per-host; sysroots are shared.** `setup_toolchain.py --host {linux|windows}` downloads the matching LLVM; target sysroots are identical, so Windows `clang.exe` cross-compiles to the Linux PLC targets — **Build & Send works on Windows.**
- **Local simulation is Linux-only** (`runtime.go` reads `/proc`/`/dev/shm`). The host-agent cross-builds for Windows fine (`GOOS=windows go build` succeeds — the `/proc` paths are runtime strings), so the editor + Build & Send ship on Windows; only RUN/simulate is disabled there. ⚠️ **`GOOS=windows go build ./...` must keep succeeding** — it's a release invariant.
- `toolchains/` is embedded whole (no on-demand download), so artifacts are multi-GB.
- Startup is **terminal-only**: the agent logs the URL to stdout; the user opens `http://localhost:7171`.

### Build output location
Build & Send artifacts go to `~/.local/share/com.plceditor.app/build/`:
- `plc.c`/`plc.h` — transpiled C. `kron_hal.h` — HAL glue.
- `sim_runtime.bin` — local sim binary (host x86_64, `-O0 -g`).
- `runtime.bin` — target/hot-swap binary (cross-compiled, `-O3`). ⚠️ **These two MUST NOT share a name** (see §6).
- `variables.json` — symbol table (SHM offsets, addresses, password hashes).

---

## 5. The transpiler (ST/LD → C)

`src/services/CTranspilerService.js` is the heart of the compile path.

### Entry points
```js
transpileToC(projectStructure, standardHeaders, boardId, simMode, buses=[], busConfigs={})
  → per-POU: transpilePOUSource(pou, globalVarNames, stdFunctions, interfaceConfig)
    → ST: transpileSTLogics(code, stdFunctions, parentName, category, varMap)
    → LD: transpileLDLogics(rungs, blockType, parentName, category, varMap)
```
All three `transpileToC` call sites in `App.jsx` pass `buses` and `busConfigs` as args 5 and 6.

### Variable scoping
- Global vars → no prefix (looked up via `globalVarNames[]`), mapped to `S->${name}`.
- Local vars → `prog_NAME_` prefix, mapped to `S->prog_NAME_${name}`.
- FB-instance-local vars → `instance->${name}`.
- `varMap` (IEC name → C symbol) is built in `transpilePOUSource`.

### ⚠️ INVARIANT — the four IEC type tables must stay in sync
When adding a new IEC primitive type, update **all four** in `CTranspilerService.js`:
| Table | Purpose | Failure if missing |
|---|---|---|
| `IEC_TYPE_SIZES` | byte size | no SHM slot, no force flag, var invisible to KronServer/REST |
| `IEC_TO_SERVER_TYPE` | KronServer type name | wrong signedness silently corrupts HMI/REST values |
| `IEC_TO_KRON_TYPE` (in `transformExpr`) | KRON converter suffix | `X_TO_Y(...)` silently loses precision |
| `IEC_CAST_C` (in `transformExpr`) | C cast for `INT(x)` coercions | also update the type-name regex |

`agentTools.js` `SCALAR_IEC_TYPES` mirrors `mapType`'s typeMap keys — they are **not** shared/imported, so keep them in sync by hand.

### ST operator mappings
| IEC ST | C | Notes |
|---|---|---|
| `:=` `AND` `OR` `NOT` `XOR` `MOD` | `=` `&&` `||` `!` `^` `%` | AND/OR/NOT are **always logical** |
| `BAND` `BOR` `BXOR` `BNOT` | `&` `|` `^` `~` | bitwise (vendor extension) — use these for integer masking |
| `ABS(x)` | `((x)<0?-(x):(x))` macro | arg evaluated twice — no side-effecting args |
| control flow | `if/else if/else`, `for`, `while`, `do{}while(!…)`, `break`, `return` | |

⚠️ The transpiler is **not type-aware** on AND/OR — mixing `AND` with integer operands produces silent wrong results. Use BAND/BOR/BXOR/BNOT for bit ops.

### ST line handling (order matters)
- **Comment stripping happens BEFORE keyword normalization.** Both `(* *)` block and `// ` line comments are stripped in the initial `stripped` step, before the pass that injects newlines after `THEN`/`DO`/`OF`/`ELSE`/`END_*`. Otherwise an ST keyword *inside* a comment (e.g. "of" in `// period of 1 second`) triggers a mid-comment newline that leaks the tail into C.
- **String literals** are blanked length-preservingly before scanning (both here and in `validateCode`, so a variable name mentioned inside `'...'` no longer produces a bogus "undefined identifier" that aborts the build).
- Variables are referenced by **bare name** in ST — no `global.`/`GVL.` namespace. Member access is only for FB output pins (`blink.Q`).
- **Continuation merge:** lines ending in an operator / `,` / `(` merge with the next. `:=` is excluded.
- **CASE label + inline body** on one line is split so the body runs through the full pipeline.
- **Multi-statement `;` split:** each physical line is split on top-level `;` (paren depth 0, outside strings), so FB calls need not be on their own source line.
- **String placeholders use ASCII control chars** `\x01<idx>\x02` — never replace them with bare digits (the `\d+` restore regex would corrupt real numeric literals).

### CASE labels
The label matcher accepts **numeric ranges/lists, identifier (enum) labels, and negative numbers** — e.g. `IDLE: …`, `1..5:`, `-1:`. Enum labels emit `case <ENUM_CONST>:` (enum members become C enum constants). (Previously digits-only, which silently turned enum-labeled bodies into dead C goto-labels.)

### FUNCTION POUs (`category === 'function'`)
Supported: **Input**-class vars become C parameters in declaration order (`static inline RET name(T1 a, T2 b)`); **Local/Temp** vars are declared at the top of the body; `FuncName := expr;` becomes `return (expr);`. Call sites resolve args positionally.

### Task assignment — STRICT
`generateMainLoop` builds task→program groups from `taskConfig.tasks`. **A program runs ONLY if explicitly assigned to a task** — there is no `__unassigned` default fallback. An unassigned program's code is generated but never called, so its variables stay at initial values. The transpiler `console.warn`s unassigned names; `handleToggleSimulation` (App.jsx) also surfaces a UI warning. Zero tasks configured → nothing runs.

### LD data structures & rules
```js
rung.blocks[i].type / data.subType / data.values   // Contact NO|NC, Coil Normal|Set|Reset, {PT:'T#5s'} etc.
rung.connections[i].sourcePin/targetPin            // 'out'/'in' or 'out_0','in_1' for FBs
```
- Global vars never get `prog_` prefix (checked against `globalVarNames[]`).
- FB trigger pin: `in_0`/`in` = power flow; `in_1`+ = separate assignments.
- SR trigger → `.S1`; RS trigger → `.S` (different fields).
- Topological sort deduplicates identical source→target edges.
- Module-scope constants: `FB_TRIGGER_PIN`, `FB_Q_OUTPUT`, `FB_INPUTS`, `FB_OUTPUTS`, `FB_INPUT_TYPES`.

### Block-specific codegen notes (learned the hard way)
- **LIMIT / MUX are emitted by argument NAME, not position.** `LIMIT` → `KRON_LIMIT(MN, IN, MX)` (the C macro order); the 2-input `MUX` → a ternary `((K)?(IN1):(IN0))` (the `KRON_MUX` macro expects an array pointer and would not compile on scalars).
- **Rising/Falling edge contacts and coils have real edge memory.** Each edge block gets a persistent BOOL — a `PlcState` field for program scope (`prog_<prog>_edge_<id>`) or an FB struct member (`__edge_<id>`). A Rising contact fires only on the false→true transition of its variable. ⚠️ These fields are part of `PlcState`, so they contribute to `plc_state_layout_hash` — that's expected and correct.
- **TIME pins:** only `T#…`-literal values go through `mapIECtoTimeUs`; a variable or expression passes through `transformExpr` untouched. `mapIECtoTimeUs` supports fractional, `m`/`h`, and compound (`T#1m30s`, `T#1h2m3s500ms`) forms and **throws** on an unparseable literal (no more silent 10 ms default).
- **`FOR … BY <negative>`** iterates downward correctly.
- **`0b…`/`0o…`/`16#…` literals** parse correctly in `resolveVal`; malformed numeric tokens return null (surfacing the problem) rather than leaking into C.

### Arrays
`transpileDataType` sizes a C array as **`[max+1]`**, NOT `[max-min+1]`, so raw IEC indices stay valid when the lower bound is > 0 (elements below `min` are simply unused). ⚠️ **Negative lower bounds and `upper < lower` are rejected with a clear transpile error.** Multi-dimensional arrays use the full index cross-product for debug/SHM expansion (`var[i][j]`), not per-dimension iteration.

### Shared-memory layout & bounds
Data region grows from offset 0; force flags start at `FORCE_FLAGS_BASE` (32768); total segment is 65536. ⚠️ The transpiler **throws a clear error** if the data region would cross `FORCE_FLAGS_BASE` or the flag region would exceed the segment (e.g. huge arrays) — instead of silently producing overlapping regions.
- Struct-member debug offsets are computed with **natural C alignment** (not packed), so the local sim reads padded UDTs correctly; AXIS_REF debug fields carry real byte offsets.
- `resolveInitialValue` parses TIME/radix literals so `variables.json` `initial_value` matches the compiled initial (KronServer's `WriteInitialValues` then seeds the right value).

### `resolveVarsInExpr` is single-pass
Names are substituted in one pass via a single alternation regex with a callback, skipping matches preceded by `.`/`->`. (A naive longest-first repeated `replace` corrupted expressions when a variable was named `s`, `q`, or `instance` — it would rewrite the `S` in `S->`.)

### exec-time is MICROseconds
The per-program execution-time field (`__exec_us_<prog>`) stores **microseconds**. Both `TaskManager.jsx` (overrun detection) and `ProjectSidebar.jsx` (display) treat it as µs. (It previously stored ns while the name said µs, making overrun detection 1000× too eager.)

### Verification harness
- `experiments/transpiler-check/compile-gate.sh` — regenerates the representative project's C and compiles it with the bundled clang using the exact sim include/lib recipe. **This is the completeness gate; run it after transpiler changes.**
- `experiments/hotswap-v2/demo.sh` — proves live swap with state preserved.

---

## 6. Simulation, hot-swap & the PlcState model

### The PlcState model (foundation of both sim and hot-swap)
The transpiler **always** emits a single `PlcState` struct holding ALL mutable state (globals, program locals, FB instances, shadow vars, edge memory, exec-time), reached through a file-scope `static PlcState *S`. Every state reference is `S->…`. FB-local vars stay `instance->…`; function/LD-transient locals stay bare. Declarations are collected into `stateFields`, emitted as the struct *after* all type defs but *before* function bodies; non-zero initials go to `plc_state_init()` (called from `PLC_Init`). The instance is `static PlcState __plc_state;` with `static PlcState *S = &__plc_state;`.

⚠️ **`__plc_state` must have EXTERNAL linkage in the non-hot-swap build.** `#ifdef PLC_HOTSWAP` keeps it `static` (host owns state); otherwise it's a plain global. As `static` under `-O3`, SROA dissolves it entirely (no symbol) and the local-sim's DWARF-based live read finds nothing. The fix has three parts: (1) external linkage; (2) sim compiled with **`-g`** so DWARF carries the layout; (3) `parseELFSymbols` finds `__plc_state`'s base + each member's offset from DWARF (`plcStateMemberOffsets`). The sim build uses **`-O0 -g`** (faster compile; `-O0` also keeps the symbol as belt-and-suspenders). The target/deploy build (`compileForTarget`) stays `-O3`.

⚠️ **CRITICAL filename separation:** the local-sim binary is **`sim_runtime.bin`** (host x86_64, `-O0 -g`); the target/deploy + hot-swap binary is **`runtime.bin`** (cross-compiled, `-O3`, no `-g`). Same dir, different names — they used to both be `runtime.bin`, so a Build & Send clobbered the local sim with a wrong-arch, no-DWARF binary and simulation read garbage. `sim_runtime.bin` is referenced only by `compileSimulation` (writes) and `handleRunSimulation` (runs).

**Compile cache:** the bundled clang is ~242 MB; its cold load dominates perceived compile time (actual codegen ~60 ms). `compileSimulation` skips clang when `simInputsHash` (SHA-256 of `plc.c`+`plc.h`) matches `sim_runtime.bin.hash` and the binary exists — so re-toggling Simulation off→on without code changes is near-instant. The hash is captured *before* clang runs, so a concurrent input rewrite safely forces a rebuild next time.

### Hot-swap (online change) — Linux only
State-preserving live code update: change logic while running, timers/counters/latches survive. **Hot-swap is the DEFAULT runtime for simulation** — toggling Simulation ON builds+runs the loader-host; there is no separate "Go live" button.

**Split binary:** a stable **loader-host** owns `PlcState` (host memory → survives swap) + the `/dev/shm` mirror + timing + scan threads; a swappable **`logic.so`** holds the POU logic. `-DPLC_HOTSWAP` turns the same `plc.c` into the `.so`, exporting a fixed ABI (`plc_state_size`, `plc_bind`, `plc_state_init`, `plc_task_body_<i>`, `plc_shm_name`, `plc_state_layout_hash`, …). Without the define it builds as the normal single binary.

**Loader-host** (`host-agent/hotswaphost/host.c`, embedded, compiled `-rdynamic`): on `SIGUSR1` it reads `./swap_request`, parks task threads on a scan-boundary barrier, `dlclose`+`dlopen`s the new `.so`, re-binds the SAME `PlcState` (no re-init), and **rolls back** on any failure.

**Generation scheme — bounded 2-slot ping-pong** (`hotswaplib/` shared module):
- ⚠️ Hot reload uses **exactly two fixed slots, `logic_0.so` ↔ `logic_1.so`**, that alternate. Each swap targets the slot that is **not** the one currently running (`PingPongGeneration(confirmedGen)`), so the generation number **never grows** (the old `NextGeneration` = "highest+1" produced `logic_0 … logic_57` forever, and on a long-lived field device it never reset — `NextGeneration` is now deprecated). `CleanupExcept` deletes the other slot only after a confirmed `OK`, so at most two files ever exist.
- ⚠️ **The confirmed-running generation is tracked explicitly, never inferred from a directory listing** (which is ambiguous while two slots briefly coexist). Local sim: `HotSwapState.curGen` (set to 0 at cold start, advanced only on confirmed `OK`). Target: `ProcessManager.curGen` (set to the exact gen launched at Start, advanced on confirmed `OK`); `handleDeployLogic` reads it (`ConfirmedGen`) to place an online change into the alternate slot. So we are always certain which numbered logic is live and which is being sent.
- ⚠️ **Slot writes must be atomic** because names are reused: the local compile writes `logic_<n>.so.tmp` then `os.Rename`s over the slot (`TempGenerationPath`), and the target's `saveUpload` already does tmp+rename. This gives the slot a fresh inode so a `.so` the loader-host still has `mmap`'d is never truncated in place (`dlopen` then loads the new inode as a distinct library).
- **Cold reset:** the initial field deploy posts `/deploy/logic?cold=1`, which wipes any stale `logic_*.so` and installs exactly `logic_0.so`, so a redeployed device starts from an unambiguous generation 0. Online changes post `/deploy/logic` (no flag), which ping-pongs off `ConfirmedGen`.
- **Timeout = outcome unknown, delete nothing** (deliberate, safe): on a `PollSwapResult` timeout neither slot is deleted and `curGen` is left unchanged (we stay certain only of the last confirmed generation); the loader-host has rolled itself back, so the machine keeps running the old logic and the user retries. The next swap's atomic rename + `dlopen`-by-inode make it self-healing even if the timed-out swap had actually applied.
- **`swap_result` file** (atomic tmp+rename, written by `host.c`): `OK <gen>` / `FAIL <gen> <DLOPEN|SYMBOL|TASKCOUNT|LAYOUT>` / `OK <gen> COLDSTART`. Both `host-agent/hotswap.go` and `server/process.go` **poll it before reporting success and clean up only after a confirmed `OK`** — never optimistically. On `FAIL`, only the rejected candidate is deleted. On timeout, nothing is deleted; result surfaces as unknown.
- **`plc_state_layout_hash()`** (FNV-1a over the joined `stateFields` struct-body — the *shape*, never values): `host.c` refuses+rolls back a swap whose hash differs from the one captured at the first cold-start bind (every swap checked against the ORIGINAL, so incremental drift can't slip through). This is the **hard safety net**, run unconditionally.
- **`layoutSignature(struct, boardId, buses, busConfigs)`** (App.jsx): a fast UX pre-check over `{task, variables, udts, blocks, ioEc}`. `blocks` = `stateBlocksSignature`: every FB-style ladder block (per-pin shadow fields exist per BLOCK, not per declared variable) + Rising/Falling contacts/coils (`__edge_<id>` fields) in document order — so adding a block whose instance variable was ALREADY declared (the CTD case) is caught too; plain NO/NC contacts and Normal/Set/Reset coils carry no state and stay hot-reloadable. `handleAgentHotSwap` calls `layoutSignatureDiff` and reports *which* part changed instead of pushing online. Two-layer by design: the JS guard names the problem; `plc_state_layout_hash` prevents corruption regardless. ⚠️ `variableTableSignature` must read POU locals from **`p.content?.variables`** (unified rung-based POUs) — it once read only the legacy `p.variables`, so `locals` was always empty and a while-running edit that auto-declared an FB instance (dropping a CTD → `CTD0 : CTD`) sailed past the JS guard; the loader-host then rolled the swap back and the OLD logic silently kept running (a "CTD" that counts up). On a refused layout change the sim path now `window.confirm`s an immediate **rebuild + restart** of the simulation (`offerSimRestart`); the field path stays warn-only (never auto-restart hardware). **State carry-over:** `offerSimRestart` snapshots `liveVarsRef` before stopping and, after the restart, PULSE-writes every scalar whose live key still exists in the new build's `debugDefaults` — so a counter at 35 resumes from 35 across a layout change. ⚠️ **Carried = real state ONLY**: bare locals/globals + FB struct members (dotted keys, `prog_X_CTU0.CV`). **Skipped**: `__exec_us` diagnostics, composites, and — critically — **`in_`/`out_` pin shadows** (`/_(?:in|out)_/` on dot-free keys): `in_` shadows hold the PROGRAM SOURCE's pin literal (seeded at init, only READ per scan), so carrying the old runtime value would silently revert a pin-literal edit (PT 500ms→2s came back as 500ms); `out_` shadows are recomputed every scan anyway. Limits: FB-internal edge memory isn't in SHM (not carried; one edge may re-evaluate), new variables/instances start at initial values (a NEW CTD starts CV=0 — seed it via LD/PV if it must continue from an existing count), and writes span a few scans so derived values may mix briefly before settling. The SAME offer fires when the **C-level hash** rejects a sim swap (catch matches `/LAYOUT/` in the agent's `hot-swap rejected: LAYOUT` error) — the JS pre-check can miss exotic cases, and a log-only error read as "applied" while the old logic kept running.
- **Concurrency:** both supervisors have a dedicated `swapMu` (separate from the state-protecting `mu`); a swap holds it for the whole operation (compile→request→signal→poll, ≤5s), while `Stop` only needs the short `mu` so it's never blocked behind a hung swap.

**Force-write works in hot-swap sim.** `handleWriteVariable` (runtime.go) detects a running hot-swap host and writes the value + force flag into the `/dev/shm` mirror at the variable's offset (`writeHotSwapVariable`, using `ShmSpec` with a `ForceOff` field loaded by `buildShmSpecs`). (Previously it only knew the legacy plain sim, so every force-write during a default simulation failed 400.)

⚠️ **Force-flag byte has THREE values (pull semantics):** `0` = normal (logic owns the value), `1` = **FORCE** (re-injected every scan → held constant/pinned), `2` = **PULSE** (one-shot: `plc_shm_pull` applies it and immediately clears the flag to `0`, so the logic resumes from the injected value on the SAME scan — e.g. seeding a counter to 0 which then counts up again). This is emitted by BOTH `plc_shm_pull` codegen sites in `CTranspilerService.js` (`if (__plc_shm[F]) { memcpy(...); if (__plc_shm[F]==2) __plc_shm[F]=0; }`); `plc_shm_sync` still writes PlcState→shm only for flag `0`, so a released pulse is written back the same scan. The write request carries `mode` (`writeVariableReq.Mode`): `writeHotSwapVariable` writes flag `2` for `"pulse"`, `1` for `"force"` (default). UI: `ForceWriteModal` shows a **Pulse/Force** selector when `pulseOK` (local hot-swap sim — `allowPulse` prop, else the `window.__kronSimActive` flag App publishes); default is Pulse. `handleForceWrite(key,value,mode)` forwards `mode` for the local sim only — a **remote PLC always force-writes** (KronServer's `WriteVar` has no pulse yet; the codegen supports it, so wiring pulse into KronServer later is trivial). Force (flag `1`) semantics and KronServer are unchanged/backward-compatible.

**Robustness (process lifecycle):**
- The crash reaper closes `stopCh` when it's still the current process, so the SHM poller dies with the process (no frozen values, no double poller on restart).
- `handleHotSwapRun` removes the `/dev/shm` mirror path only *after* the already-running early-return (a redundant run no longer kills the live poller).
- On cold-start poll timeout the host is killed and state cleaned (deterministic failure, not a phantom "running" sim).
- Reaper is the sole `cmd.Wait()` caller (done-channel pattern); `Stop` kills then waits on `done`. (Concurrent `Wait` calls are a race.)
- NaN/Inf floats are sanitized to JSON null at decode so one bad float can't stop the whole live-variable frame.

**HAL-to-host (done):** HAL functions are `static inline` with file-scope `static` fd arrays, so a naive split loses IO state. Fix (codegen-partition, no HAL edits): in hot-swap mode the transpiler emits `extern void __hs_F(void*); #define F __hs_F` after `kronhal.h`, and returns a `host_glue.c` with `__hs_*` trampolines; the host compiles `host.c`+`host_glue.c` together so HAL + its fds live in the host and survive swaps. **Verified end-to-end on the local sim.**

**Field path is wired to the toolbar.** A **"Go Live"** toggle (shown only when connected to a PLC, `App.jsx`) calls `startHotSwapSession` → deploys the loader-host + `logic_0.so` (cold) to the target and sets `fieldHotSwap`, so subsequent agent-approved edits apply as online changes (`handleAgentHotSwap`'s field branch → `hotswapTargetLogic` + `hotswapDeploySwap`) instead of a full Build & Send. Manual edits go the same way via the **"Hot Reload"** toolbar button (see §7 read-only mode — logic editors stay editable while a hot-swap runtime is live). `fieldHotSwap` is cleared by Stop Live, by a plain Build & Send (it deploys a self-contained binary, ending online-change mode), and on disconnect. It is distinct from `isHotSwap` (which is also true for the local-sim hot-swap).

**Known gaps before field use:** (1) EtherCAT/motion are NOT trampolined — a project using EC/motion can't hot-swap that IO (full redeploy). (2) A `sudo -n`-spawned runtime won't receive SIGUSR1 — the agent must run as root on target. (3) The local-sim loader-host (`plc_host`) is cached in the build dir but the cache key is now a **content hash** (`hostInputsHash` = embedded `hotswap_host.c` + `host_glue.c`) written to `plc_host.hash`, so a host-agent upgrade or a HAL change auto-rebuilds it — a stale `plc_host` (e.g. one predating the `OK <gen> COLDSTART` result write) is never reused. ⚠️ Before this, `compileHost` cached on mere file existence, so an old loader that never wrote the cold-start `swap_result` made every sim start fail with "cold-start outcome unknown (timeout) — host killed". (The TARGET loader `runtime.bin` in `compileHostForTarget` always rebuilds, so it was never affected.) (4) The field path is **compile-, unit- and HTTP-protocol-verified** (ping-pong naming proven in `hotswaplib` + `server` tests; the swap ping-pong, cold reset, and confirmed-gen tracking are exercised), but the actual live swap on **physical hardware** (real fds, real-time jitter during the barrier, `sudo`/signal-forwarding) is still unverified — a real-device test + an operator safe-state review remain required.

### Re-attach after a browser reload
The simulation is a separate host-agent process, so it survives a tab close/reload. `GET /api/host/sim-status` reports both the plain and hot-swap state (`{running, pid, mode}`, `mode` = `"hotswap"`|`"plain"`). On (re)load, an effect (guarded by `simReattachedRef`) restores the running flags; for hot-swap it also restores `hotSwapActiveRef`/`taskSigRef` so a re-attached sim stays reloadable. Live values resume over the existing `simulation-output` SSE.

For a **remote** running PLC, the 3s `checkStatus` poll re-attaches (guarded by `!isSimulationModeRef.current`). ⚠️ The re-attach starts the SSE stream unconditionally (it no longer requires `remoteVarKeysRef` to be populated — that ref is only set by Build & Send in the same session, so after a reload it's empty and live values used to stay `---`).

---

## 7. Frontend architecture

### ⚠️ Unified rung-based POU model
Every program / function block / function is ONE kind of thing: a **list of rungs**, each authored in Ladder (LD) or Structured Text (ST). There is no longer a separate "LD POU" vs "ST POU" vs "SCL POU" — the old `SCL` type IS this unified model and is now the **only** one the UI creates (`type: 'SCL'`, `content: { rungs, variables }`).
- **Legacy fold-in:** `normalizePouToRungs`/`normalizeProjectToRungs` (`App.jsx`, module scope) convert older `ST` POUs (a single `content.code` → one `lang:'ST'` rung) and `LD` POUs (rungs already fine → tagged `SCL`) into the unified shape on project load (`processFileContent`) and on create. So old projects open unchanged and the editor/transpiler/agent/XML only ever see `SCL`.
- **Transpiler unaffected & safe:** the transpiler still dispatches on `pou.type`; a unified POU is `SCL`, which it already handles per-rung (`transpilePOUSource`: `rung.lang==='ST'` → `transpileSTLogics`, else `transpileLDLogics([rung], …, sclLdRungIdx, …)`). An all-LD unified POU produces the same codegen as a legacy `LD` POU (rung index is `rungIdxOffset+ri`, per-rung helpers are stateless), so `LD→SCL` conversion is regression-free. **Do not reintroduce a create-time LD/ST/SCL language picker** — language is per rung.
- **Create flow:** `CreateItemModal` has no language radios for POUs; `handleAddItem` forces programs/FBs/functions to `SCL` with empty `rungs`. `agentTools` `create_pou` also always makes `SCL` (its `set_ladder`/`set_st_code` add LD/ST rungs respectively).
- **XML I/O is generic** (writes `type` attr + `JSON.stringify(content)`), so `SCL` round-trips automatically; import runs the normalizer.

### Rung editing UX (`RungEditorNew.jsx`)
- **Empty-state onboarding:** a POU with no rungs shows a guidance card with "🪜 Add Ladder rung" / "📝 Add Structured Text rung" buttons (calls `addRung(null,false,'LD'|'ST')`) instead of a blank canvas.
- **Per-rung language convert:** the rung header's language pill is a **button** (`convertRungLang`) that switches a rung LD↔ST. An empty rung switches silently; a rung with content confirms first (the other language can't carry ladder blocks ↔ code — variables are kept). Reorder (drag handle / move up-down) and delete live in the same header bar.
- **Inline variable declaration (LD):** committing a contact/coil/FB block (`updateBlockData`) whose referenced name isn't declared (local or global) auto-creates it with an inferred type — contacts/coils → `BOOL`, an FB → an instance typed by the block (e.g. `TON`) — as `class:'Local'`, appended in the same history step. Skips invalid names and member access (`blink.Q`), so you never leave the rung to open the variable table. (ST rungs still surface undefined names as red squiggles; a Monaco quick-fix is a possible future add.)

### Pin autocomplete & block notes
- ⚠️ **Pin suggestion datalists:** each pin input's autocomplete references `ladder-vars-<TYPE>` datalists rendered by `RungEditorNew`. The family datalists (`ANY_NUM`/`ANY_INT`/`ANY_REAL`/`ANY_BIT`/`ANY_STRING`) are **always rendered even when empty** — a referenced-but-missing datalist id silently kills autocomplete for that pin. The ANY_NUM polymorphic inference in `RungContainer` (POLY_NUM_BLOCKS) narrows pin `type` for display/wiring but sets **`suggestType: 'ANY_NUM'`** on rewritten pins; `getPinSuggestionList` prefers `suggestType`, so typing a literal into IN1 (inferring e.g. DINT) no longer collapses the other pins' suggestions to only-DINT variables.
- **64-bit types are first-class:** `ELEMENTARY_TYPES` (Selectors.jsx) includes `LINT/ULINT/LREAL/LWORD`; host-agent `typeSize`/`encodeValue`/`decodeValue` (runtime.go) handle the bit-string types `BYTE/WORD/DWORD/LWORD` (they were missing entirely — force-writes on them failed). Transpiler tables were already complete.
- **Block "How it works" notes:** double-clicking a block opens `BlockSettingsModal`, which shows a notes panel at the bottom via `getBlockNotes(blockData, t)` (`src/utils/blockNotes.js`). The note TEXTS live in the locale files under the **`blockNotes.*`** namespace (`blockNotes.Contact.<subType>`, `blockNotes.Coil.<subType>`, `blockNotes.<TYPE>`, `blockNotes.enNote`) — subType-aware for contacts/coils, appends the EN/ENO note when Execution Control is on, and falls back to the (untranslated) XML `description` for library blocks (Toolbox passes it through `customData.description`). ⚠️ A new standard block's note must be added to **all three** locale files (en/tr/ru); en is the i18next fallback.

### Block palette (`Toolbox.jsx`)
A sticky **search box** filters all blocks into a flat, grouped list (multi-term match over name/type/description/group) across every source — board, EtherCAT, standard library, user-defined — preserving source grouping + colors; drag-to-rung is unchanged. Empty query → the normal collapsible 3-level tree.

### Read-only mode (`isRunning === true`) — logic exempt while hot-swap is live
`App.jsx` passes `isRunning` down: `VariableManager` disabled, `ProjectSidebar` add/delete/edit disabled, `ResourceEditor` (globals/tasks) locked. **LOGIC editors (Monaco ST + `RungEditorNew`) are additionally gated by `allowLiveEdit`** (EditorPane prop, = App's `hotSwapLive` = `(isRunning && isHotSwap) || fieldHotSwap`): `logicEditLocked = readOnly || (isRunning && !allowLiveEdit)`. So while a hot-swap runtime is live, the user can edit ST/ladder (CoDeSys-style online change) — but layout-owning editors stay locked so a manual edit can't silently change the PlcState shape. Editing while running sets `pendingOnlineChange` (structure differs from `runStructSnapRef`, the snapshot of what runs — set at session start/re-attach, refreshed after each confirmed swap, nulled on stop); that surfaces a **"Hot Reload" toolbar button** which calls `manualHotReload` → `handleAgentHotSwap(['edited logic'])` — the same guarded path as agent edits (layoutSignature pre-check names refused layout changes; the C-level `plc_state_layout_hash` remains the hard net). ⚠️ LD inline auto-declare can still add a variable during live edit — that's *allowed* in the editor but *refused* at Hot Reload with the exact reason (edit kept; Build & Send deploys it). Plain (non-hot-swap) runs and remote runs without Go Live keep everything locked.

### Simulation while connected
Local sim and a remote PLC connection coexist. **Build & Send is NOT disabled during sim/run** — when connected it stays enabled; `handleBuildAndSend` instead `window.confirm`s (a full Build & Send recompiles + RESTARTS the runtime → state lost). The confirm message reflects which runtime is actually live (local sim vs remote). Build & Send deploys a self-contained runtime (`compileForTarget`) — it is **not** hot-swap.

### ST editor live badges (`EditorPane.jsx`)
CoDeSys-style inline decorations, TYPE-AWARE via a `varTypeMap` + `SCALAR_IEC_TYPES`:
- A **call site** (`blink(`) gets no badge; a **member access** (`blink.Q`) shows the member's scalar value and continues; a **composite root** (whole FB/struct/array) shows a `{ }`/`▦` icon, not a raw value; **scalars** show the value badge.
- **Comments & string literals are excluded** — block comments and `// ` line comments and `'…'` literals are blanked length-preservingly before the scan (and the hover checks against the blanked line). ⚠️ Block comments must be blanked with **same-length spaces** (not deleted) so badge columns stay aligned after an inline `(* … *)`.
- **Live hover** shows an FB/struct/array's full contents as a Markdown table; the provider reads `window.stLiveCtx = { live, prog }`.

**FB outputs — two representations, overlay handles both.** The local sim reads the FB struct via DWARF as an object at `prog_X_blink` (`{Q,ET}`); the target/hot-swap streams FLAT scalar keys `prog_X_<var>.<pin>` (read from `/dev/shm` by offset). The transpiler emits each FB scalar OUTPUT pin as its own SHM-slotted variable (`prog_X_<var>.<pin>`, c_symbol `prog_X_inst_<var>.<pin>`) so KronServer streams `prog_Blinker_blink.Q` as a flat bool. The ST overlay resolves both; the watch table shows flat keys as individual pin rows. Requires a re-Build&Send.

### Watch panel (`OutputPanel.jsx`)
`buildGroups` reads globals from `projectStructure.resources[].content.globalVars` (the RESOURCE_EDITOR resource — globals do NOT live at `projectStructure.globalVars`). `resolveExpression` maps a bare global name to the live key `prog__<name>`.

### Rung power-line alignment ⚠️
- **`MIDDLE_Y` (the rail connection Y) is FIXED at `MIN_RUNG_HEIGHT/2`** — never make it proportional to the dynamic `RUNG_HEIGHT` again. The rung grows downward with its lowest block; a height-proportional middle moved the rail dots on every growth and put a step into every previously straight wire.
- **Power-line magnet:** the `[10,10]` snap grid cannot land a block's power handle exactly on `MIDDLE_Y` (a contact's handle is at `y+9`). `powerHandleOffsetY(nodeId)` measures the node's first `.react-flow__handle.target` center from the DOM (divided by `scaleFactor`), and `onNodeDragStop` / `onDrop` snap the block so the handle sits dead on the line when released within `POWER_SNAP_DRAG`/`POWER_SNAP_DROP`. Drop-time snap needs the new block's id — `insertBlock`/`addBlockToRung` (RungEditorNew) **return the created block id** for exactly this; keep that contract.

### RungContainer performance rules ⚠️
- **Never** put `liveVariables` in `mapBlocksToNodes` useCallback deps — it rebuilds every node every 500 ms. Update live values via a separate lightweight effect that only touches `n.data.liveVariables`.
- **Wrap** `varsByType`/`dtMap`/`allRawVars` in `useMemo` (deps: `variables, globalVars, dataTypes`).
- **Do not** add custom equality to `RungContainerWrapper` until all callbacks use `setRungs(prev => …)` form.
- Pin-type validation in `isValidConnection` resolves handles **by name** (`in_PT` → strip prefix → look up `cfg.inputs/outputs`), not by index.

### Undo/redo
- **Project-tree undo (App.jsx):** covers sidebar structural ops (add/delete/rename/reorder/paste of POUs & data types). `undoHistoryRef = {past,future}` (cap 50) + `projectStructureRef`. Each structural handler calls `pushUndoSnapshot(prev)` inside its `setProjectStructure` updater. Window keydown: Ctrl+Z / Ctrl+Shift+Z|Ctrl+Y, gated by `getEditorScope()` being SIDEBAR (or null).
- **LD editor undo (RungEditorNew.jsx):** `useRef` of `{rungs, variables}` pairs (max 50). ⚠️ **Every mutation must call `saveHistory(newRungs, newVariables)` with both.** The Ctrl+Z/Y handler is scope-gated to `EDITOR_SCOPE.LD`. ⚠️ `saveHistory` is called *outside* setState updaters (compute new value → set → saveHistory) — calling it inside an updater double-counts under React StrictMode.

### Focus guards ⚠️
Every global window keydown handler (undo/redo, Space-toggle of contacts, Ctrl+X Run shortcut, clipboard) MUST bail when the active element is an `INPUT`/`TEXTAREA`/`isContentEditable`/inside `.monaco-editor`. A tagName-only check is insufficient because the SCL inline ST editor is Monaco (a contentEditable div). Missing guards caused: sidebar paste firing inside the code box, Ctrl+X hijacking native cut, spacebar force-toggling a contact while typing in a modal.

### Monaco editors ⚠️
Both Monaco mounts use **`defaultValue` (uncontrolled)** + a position-preserving sync effect (`if (model.getValue() !== code) { save pos; setValue; restore pos }`), NOT a controlled `value={code}` — the controlled path calls `setValue()` on every parent re-render and jerks the caret to (1,1). The EditorPane parent-sync effect **skips its first run** (mountedRef) so merely opening a POU doesn't mark the project unsaved. The SCL inline editor's blur/validation listeners read fresh props via **refs** (they're registered once at mount and would otherwise capture stale `rungs`/`variables`).

Note: the old Monaco `addCommand(Ctrl+V/C/X)` clipboard overrides were **removed** post-Tauri — Monaco's native clipboard works in the browser setup. (Earlier docs claimed they were required.)

### ST/SCL validation (`stValidation.js`)
`findStMarkers(code, {allowedLower, conversionPattern, varTypes})` — shared by the ST editor and the SCL inline rung editor. One forward token scan per line tracking the call-paren stack, so **named arguments (`IN := …`) are validated as PINS**, flagged only when the call target resolves to a *known standard* FB/function and the key isn't a pin. Pins come from `getStandardFBPins(type)`. Unknown targets (user FBs) return null → their named args are never flagged. Time/radix literals AND single-quoted string literals are blanked before scanning; member access (`x.Q`) is skipped.

---

## 8. The AI agent panel

**Full internal reference: [`docs/PLC_AGENT.md`](docs/PLC_AGENT.md)** — architecture, the complete tool reference, the ladder DSL spec (fb-in-rung, auto-declare), provider matrix, prompt policies, and the agent gate. Keep it updated together with this section.

`src/components/AiAgentPanel.jsx` — a real tool-calling agent ("PLC Agent") that edits the project: create/rename/delete POUs, rewrite ST, add/update/remove variables, author ladder. The board is read-only context. Config in `localStorage["aiAgentConfig"]`. (Code symbols stay `AiAgentPanel`/`aiAgentConfig`/`/api/host/ai/*`; only user-visible strings are "PLC Agent".) The system prompt enforces a **clarify-first policy** on ambiguous requests.

### Architecture (3 layers)
- **`host-agent/ai.go`** — provider-agnostic single-turn chat proxy at `POST /api/host/ai/chat`. Normalizes `{provider, model, apiKey, baseUrl, system, messages, tools}` → one assistant message `{content, toolCalls}`. Dialects isolated in `callAnthropic`, `callOpenAI` (also serves `custom` + `gemini`/`google` via Gemini's OpenAI-compat base), `callOllama` (synthesizes tool-call ids; has a prompt-based tool fallback for models with no native tool API).
- **`host-agent/anthropic_oauth.go`** — "Sign in with your Claude account" (Pro/Max) via Claude Code's PKCE OAuth flow. Provider `anthropic-oauth`: Bearer auth + `anthropic-beta: oauth-2025-04-20` + a "You are Claude Code" identity system block (the subscription credential is only authorized for Claude Code). Tokens at `AppDataDir/anthropic_oauth.json`; auto-refresh within 60s of expiry. ⚠️ The refresh does NOT hold the mutex across the network call; `state` is matched exactly (no single-pending fallback).
- **`src/services/agentTools.js`** — the pure action surface. `TOOL_DEFS` + `applyToolCall(struct, name, args)` returns `{mutation, ok, summary, diff, next}` (never mutates in place). Tools: `get_project_overview`, `read_pou`, `list_blocks`, `create_pou`, `rename/delete_pou`, `set_st_code`, `add/update/remove_variable`, `set_ladder`, `create_data_type`.

### ⚠️ Array/struct/enum types are never inline — always a named data type
A variable's `type` must be a scalar IEC type, an existing data-type/FB name, or (once) the literal `ARRAY[m..n] OF TYPE` (auto-recovered into a real `dataTypes` entry). Anything else is rejected with a message telling the model to call `create_data_type` first. Enforced at the single choke point `resolveVarType(struct, rawType)` (both `add_variable`/`update_variable` funnel through it). `create_data_type` builds the exact `dataTypes` shape the human editors produce (`{name, type:'Array'|'Structure'|'Enumerated', content}`).

### Agent loop & robustness
- **Manual vs Auto mode** (header toggle in `AiAgentPanel.jsx`, persisted in `localStorage["aiAgentMode"]`, mirrored in `agentModeRef`). **Manual** (default): a turn's composed mutations pause as a `pending` proposal the user approves/rejects. **Auto**: `runTurn` applies the turn itself (renders the proposal as already-`approved`, calls the shared `commitTurn(steps, dryStruct)`, and feeds `outcome:'applied'` tool results straight into the next turn — no gate). `commitTurn` is the single commit path (setProjectStructure + `onApplied` + `onHotSwap`) shared by both modes; `resolvePending(true)` just calls it. `buildSystemPrompt` takes the mode so the prompt tells the model whether changes are auto-applied.
- **`create_pou` always creates the unified rung-based POU** (`SCL`; the `language` arg is accepted but only steers which authoring tool the model uses next). `set_ladder` works on LD+SCL; `set_st_code` on ST+SCL.
- `read_pou` renders LD/SCL rungs via `renderRungs` (traces power-flow into readable boolean logic).
- **`list_blocks`** is how the agent learns FB/function pins (`buildBlockCatalog`).
- **`set_ladder` supports contacts (NO/NC/Rising/Falling), coils (Normal/Set/Reset/Negated/edge) AND one stateful FB per rung** via `fb: {type, instance, inputs, outputs}` — power flows contact network → trigger pin → Q → coils. Wiring uses the transpiler's own `FB_TRIGGER_PIN`/`FB_Q_OUTPUT` tables (**exported from CTranspilerService for exactly this** — never hand-copy them) so handles are `in_IN`/`out_Q` etc., identical to a human-dropped block; pin metadata (`customData`) comes from the XML library (`args.__library`, injected by the panel for `list_blocks` + `set_ladder`), `GENERIC_FB_DEFS`, or the project's own FBs (`resolveFbBlockDef`). Non-trigger pins ride in `data.values` by pin NAME (literals or variable refs); `fb.outputs` captures output pins into variables (`{"ET":"elapsed"}`). Inline math/compare/move (`FB_TRIGGER_PIN[type]==='EN'`) and motion (any `AXIS_REF` pin) are **rejected with a routing error** → ST.
- **`set_ladder` auto-declares** referenced-but-undeclared variables (contacts/coils → BOOL, `fb.instance` → the FB type, fb pin refs → the PIN's type, e.g. `ET⇒elapsed` declares `elapsed : TIME`) and lists each one in the approval diff — typos surface to the human instead of silently splitting logic.
- ⚠️ **`experiments/agent-check/gate.sh`** drives the REAL tool surface (create_pou → set_ladder with seal-in + TON + CTU + R_TRIG), asserts the produced block/wire/variable shapes AND `read_pou`'s rendering, then transpiles + compiles with the bundled clang. Run it after touching agentTools' ladder DSL or the transpiler's LD path.
- **Live diagnosis:** `read_live_variables` returns a buffered snapshot + history; `watch_live_variables` awaits a per-variable trailing window (`summarizeWatch`) then injects the summary. The prompt routes time-dependent checks to `watch` and to auto-verify after any change/deploy.
- **POU-target inference:** a local-scope tool whose `pou` doesn't resolve gets rewritten to the last-touched / just-created / open POU (weak-model safety net; only overrides an *unresolvable* pou).
- **Weak-model recovery layers:** `extractInlineToolCalls` (JSON + markdown-heading + bare-args forms), `extractKeyValToolCalls`, `recoverStCodeBlock`, `stripSpecialTokens`, `repairJsonBrackets`, `extractStDeclarations` (adds inlined `VAR…END_VAR` declarations to the diff). These keep qwen2.5-coder-class local models *usable* but unreliable; a native-tools cloud model (Gemini/Claude) is far steadier.

### Local model setup (Ollama) — `host-agent/ollama.go`
Talks to a local Ollama daemon (default `:11434`) over HTTP — no CLI shell-out. Routes: `ollama-status`, `ollama-setup` (one-click bootstrap: locate/download the official archive into `AppDataDir/ollama`, spawn `ollama serve`), `ollama-pull`, `ollama-runtime` (GPU/CPU placement + VRAM). Progress on SSE topics `ollama-setup-progress`/`ollama-pull-progress`. Multiplatform: Linux `.tar.zst` (pure-Go zstd, keeps `CGO_ENABLED=0`), Windows `.zip`. ⚠️ Tar extraction rejects symlink-slip (absolute or `..`-escaping Linknames). Verified end-to-end on Linux; Windows compile-verified.

---

## 9. Board support (adding a new SBC)

Boards are grouped into **display families** (`BOARD_FAMILIES` in `boardDefinitions.js`) and, separately, into **HAL families** (chosen by ID prefix). The HAL family determines the HAL header, compile triple, device paths, and server binary.

### ⚠️ INVARIANT — `getBoardFamilyDefine` exists in THREE files, keep them identical
1. `src/utils/devicePortMapping.js`
2. `src/services/CTranspilerService.js`
3. `src/utils/deviceCodegen.js`

All three map an ID prefix → HAL family: `rpi_pico`→`PICO`, `rpi_`→`RPI`, `bb_`→`BB`, `jetson_`→`JETSON`, plus the generic-Linux vendor prefixes below. Adding a prefix to one but not the others silently breaks codegen for that board.

### Currently supported HAL families
| HAL family | Boards | Arch | HAL header |
|---|---|---|---|
| `HAL_BOARD_FAMILY_RPI` | Raspberry Pi (rpi_*) + all generic-Linux SBCs below | aarch64 | `kronhal_rpi.h` |
| `HAL_BOARD_FAMILY_BB` | BeagleBone (bb_*; `bb_ai64` is aarch64, rest armv7) | armv7/aarch64 | `kronhal_bb.h` |
| `HAL_BOARD_FAMILY_JETSON` | NVIDIA Jetson (jetson_*) | aarch64 | `kronhal_jetson.h` |
| `HAL_BOARD_FAMILY_PICO` | rpi_pico(_w) — sim only, deploy rejected | Cortex-M | `kronhal_pico.h` |

### Generic-Linux SBCs (reuse the RPi HAL)
`kronhal_rpi.h` uses standard Linux userspace APIs (gpiod, `/dev/i2c-*`, `/dev/spidev*`, `/dev/tty*`) that work on essentially all aarch64 Linux SBCs. So these boards are grouped under their own **display** families for a nice UI but map (via the three `getBoardFamilyDefine`) to `HAL_BOARD_FAMILY_RPI` — no new C HAL, no new triple, no new server binary:

Orange Pi (`opi_*`), Radxa (`radxa_*`), Odroid (`odroid_*`), Banana Pi (`bpi_*`), Libre Computer (`libre_*`), Pine64 (`pine_*`) — 12 boards, all aarch64, pinLayout `rpi40`.

⚠️ **Device-path caveat:** these boards reuse the RPi `BOARD_PORT_DETAILS` (`/dev/ttyAMA0`, `/dev/i2c-1`, `/dev/spidev0.0`), which are *functional defaults* but differ per SoC — Rockchip header UART is often `/dev/ttyS2`, header I2C `/dev/i2c-2/-3/-7`; Amlogic UARTs are `/dev/ttyAML*`; Allwinner H618 UARTs are `/dev/ttyS0..5`. Users can override the device path per port. USB serial (`/dev/ttyUSB*`, `/dev/ttyACM*`) is identical everywhere.

⚠️ **Device-node overrides (UART + I2C) — how they reach the HAL.** The interface-config Device Path/Node field (stored per port in `content.deviceInterfaceConfig`, resource id `res_config`) is emitted by `buildRuntimePortHelpers` (CTranspilerService.js) as `#define KRON_UART<n> "<path>"` / `#define KRON_I2C<n> "<path>"` *before* `kron_hal.h`, and the HALs resolve the open path through `_*_devnode(ch)` (`_i2c_devnode` in kronhal_jetson.h, `_rpi_i2c_devnode` in kronhal_rpi.h). SPI has no override (path derived from bus/cs). This matters on Jetson Orin, where header pins 3/5 are I2C8 (typically `/dev/i2c-7`), not the table's Nano-era `/dev/i2c-1` — set the Device Node field after verifying with `i2cdetect -l` on the target. The I2C **CLOCK HZ field is decorative** — Linux i2c-dev cannot change bus speed at runtime (device-tree fixed); only the SPI clock is real (`KRON_SPI_PortResolve`).

### Checklist — adding a board
**Adding an aarch64 Linux SBC to an existing (or generic-Linux) family — the common case:**
1. `boardDefinitions.js` — add the board object to a `BOARD_FAMILIES` family (`{id, name, cpu, arch:'aarch64', ram, storage, connectivity, gpio, usb, display, pinout, pinLayout:'rpi40', interfaces, usbPorts}`). Reuse `GENERIC_40PIN_HEADER` for 40-pin boards.
2. `boardLibraryBlocks.js` — add `BOARD_CHANNELS[id] = {PWM, SPI, I2C, UART, USB}` matching the board's real peripheral count.
3. **Nothing else** if the prefix already maps to a HAL family. `compile.go` needs no change (non-`bb_`/non-pico → default aarch64 triple). The aarch64 server binary already exists at `resources/aarch64-linux-gnu/server/plc-agent_linux_arm64`.

**Adding a NEW vendor prefix (new display family, still generic Linux):**
4. Add the prefix → `HAL_BOARD_FAMILY_RPI` to **all three** `getBoardFamilyDefine` functions (with a comment that it reuses the generic Linux HAL).
5. Add the prefix to `serverBinaryForBoard`'s aarch64 list in `host-agent/deploy_ssh.go` (else deploy ships the amd64 binary).
6. Add the family to `LINUX_BOARD_FAMILIES` in `devicePortMapping.js` **only if** it's a genuinely new HAL family string (the generic boards map to `RPI`, already present).
7. Add an icon/gradient for the new family name in `BoardConfigPage.jsx` `boardIcon()` (else it falls to the BeagleBone default).

**Adding a truly new HAL family (new arch or non-generic peripherals)** additionally requires: a new `kronhal_<family>.h` (adapt an existing one), a `compile.go` triple case if not aarch64, and a cross-compiled server binary for the arch. Much more work — only when reuse is genuinely impossible.

---

## 10. HAL pattern

Every hardware block = **struct + `_Call` function**.
- Hardware struct: `HAL_UART_Send`, `HAL_I2C_Read`, `HAL_USB_Send`.
- Generic struct (in transpiled C): `UART_Send`, `USB_Receive`.
- Channel dispatch: `UART0_Send_Call(inst)` → `HAL_UART_Send_Call(inst, 0)`.
- ⚠️ The runtime HAL header is `resources/krontek-include/HAL/kronhal.h` (single shared copy). If `KrontekLibraries/KronHAL/kronhal.h` is present, keep it in sync with that one.

### USB_Send vs USB_Receive (different by design)
| Block | Trigger | Done/Ready | Buffer | Length |
|---|---|---|---|---|
| `USB_Send` | `Execute` (rising edge) | `Done`, `Busy`, `Error` | `pTxBuffer` | `Length` |
| `USB_Receive` | `Enable` (continuous level) | `NewData`, `Error` | `pRxBuffer` | `MaxSize` (in) + `ReceivedLength` (out) |

`USB_Receive_Call` loops up to `MaxSize` byte-reads per scan and breaks when the OS read returns nothing — so one `Enable=TRUE` per scan drains the kernel tty buffer. No edge-cycling required.

### Jetson GPIO line numbering ⚠️
`_JETSON_PHYS_TO_LINE` (kronhal_jetson.h) must contain the **runtime line indices** reported by `gpioinfo /dev/gpiochip0`, NOT the `TEGRA234_MAIN_GPIO(port,bit)` device-tree macro values. On Orin the DT macro gave port Y as 192–196, which exceeds the main chip's line count — every line request failed (`ERR_ID=3`) and GPIO output was silently dead. Real port Y starts at kernel line 122 (py3=125 / py4=126 verified on device). When adding a Jetson model, generate the table from `gpioinfo` output on the actual board.

### USB DTR handling
`_*_usb_open()` drops DTR low after `tcsetattr` via `ioctl(fd, TIOCMBIC, &TIOCM_DTR)`. Required for motor-controlled USB devices like RPLIDAR A1M8 (DTR-high = motor-off). **Side effect:** Arduino/ESP32 boards with a DTR auto-reset line are held in reset while the port is open. If a future board needs DTR-high default, refactor into an explicit HAL block instead of a per-port flag.

### Adding/removing pins on a standard FB — four locations
| Location | Change |
|---|---|
| `resources/krontek-include/…/header.h` | struct field (single shared copy; if `KrontekLibraries/…/header.h` exists, sync it too) |
| `public/libraries/*.xml` | `<pin>` under `<inputs>`/`<outputs>` (drives the LD UI) |
| `FB_INPUTS[type]` (CTranspilerService.js) | ordered input pin list (drives pre-call assignment) |
| `FB_OUTPUTS[type]` (CTranspilerService.js) | output pin list (drives shadow-var decl + write-back) |

Rules: `FB_OUTPUTS` is the single source of truth for codegen — a pin not listed there gets no shadow var and no write-back. A `data.values` key not in `FB_INPUTS` is silently skipped (safe guard for stale project data). Always verify pins against the PLCopen/vendor spec (e.g. `MC_Stop` has no `Active` output; `MC_Halt`/`MC_MoveAbsolute` do).

---

## 11. KronServer (target-device agent)

Source: `server/` (in-tree; cross-compiled by `server/build.sh` into `server/dist/` **and copied into `resources/<triple>/server/`** — the SSH deploy reads from there). Go 1.25, fully static (`CGO_ENABLED=0`), ConnectRPC + protobuf, `mmap` on `/dev/shm` for IPC.

### ConnectRPC service (`/plc.v1.PLCService/`)
`Start` (launch runtime, returns PID) · `Stop` (SIGTERM 5s → SIGKILL) · `WriteVar` (force-write) · `ClearAllForces` · `StreamVars` (all vars every 50 ms).

### HTTP endpoints
- `POST /deploy/runtime` — upload PLC binary (128 MB max, atomic write).
- `POST /deploy/variable-table` — upload `variable_table.json`.
- `POST /deploy/project-file` / `GET` — the editor project XML (editor-only; powers "Pull from Target"). ⚠️ `handleBuildAndSend` POSTs it as a strict step, so an already-deployed **older KronServer without this endpoint breaks Build & Send** — rebuild + redeploy the server first.
- `POST /deploy/logic` — hot-swap `.so` upload (generation-numbered; guarded against concurrent-upload collisions).
- `GET /status` — JSON status incl. `auto_run`, `stream_interval_ms`, `last_runtime_event`.
- `GET /stream/vars` — SSE variable stream.

### Shared memory IPC (`ipc.go`)
Variable table = name, offset, type, size, force_flag_offset. Types: `bool`, `int8/16/32/64`, `uint8/16/32/64`, `float32/64`. Little-endian, bounds-checked. ⚠️ **Offsets are validated at load** (`Offset >= 0 && Size > 0 && Offset <= shmSize - Size`, same for `ForceFlagOffset`) — a malicious/corrupt table with a negative or overflowing offset is rejected with a clear error instead of panicking (which, via `WriteInitialValues` on the startup goroutine under AutoRun, would crash-loop the agent forever).

### Process lifecycle (`process.go`) ⚠️
- `intentionalStop` is **reset in `Start()`** (after `cancelRestartLocked`) and only set by `Stop()` when something is actually running — otherwise a manual Stop would permanently suppress the next genuine crash's event + AutoRun respawn.
- **`WriteInitialValues` runs via a `preStartHook`** invoked *after* the old process is stopped and *before* the new one spawns — so the dying runtime's shm sync can't clobber the fresh initials. Wired in `main.go` to `ipc.WriteInitialValues`.
- `Start()` takes `swapMu` for the whole operation and releases `mu` before the ≤5s cold-start `PollSwapResult` — so `Stop()`/`Status()` (the editor's poll) never stall behind it, and an AutoRun crash-restart can't interleave with `SwapLogic`. Lock order is strictly swapMu → mu.
- Orphan cleanup runs *before* the HTTP server starts accepting, so a Start RPC in the startup window isn't reaped as an orphan.

### HMI & auth (`hmi.go`, `auth.go`)
4-tier RBAC (Viewer → Operator → Maintainer → Admin), SHA-256 salted passwords, 64-byte session tokens (8h TTL), HttpOnly + SameSite=Lax cookies. Layout persisted at `deploy-dir/hmi_layout.json`.
- ⚠️ **Reflected values are HTML-escaped** (login `?error=`, username/roleName) and JS-literal-encoded via `json.Marshal` — previously a raw-interpolation XSS.
- ⚠️ `/hmi/api/write` is **restricted to addressed variables** (mirrors the read feed) and requires Operator+. (Per-page `writeRoles` enforcement is a known residual gap — component bindings are opaque editor-side JSON; documented in code.)
- Constant-time password comparison (`crypto/subtle`).

### HMI serving — two listeners, base-path aware
Same UI reachable two ways: the agent port (`:7070`) under **`/hmi/`** (always registered), and a dedicated operator port at the **root** (`RegisterHMIRoutesAtRoot`, managed by `applyHMIPort`, port from `RuntimeConfig.HMIPort`). ⚠️ Handlers/templates are base-path aware via `hmiBase(r)` (`"/hmi"` or `""`), which drives login/logout redirects, the session-cookie `Path`, and the injected `BASE` const. Add base-awareness to any new HMI route/template or root serving breaks. `/hmi/api/variables` returns only addressed variables. The editor's Visualization picker (`HmiProperties.jsx`) lists only addressed vars.

### Addressed variables & REST API
An IEC address in the VariableManager "Address" column (`%MW0`, `%MX0.1`, …) exposes a variable via REST. `formatIECAddress` (VariableManager.jsx): BOOL→`%MX{byte}.{bit}`, BYTE/SINT/USINT→`%MB`, INT/UINT/WORD→`%MW`, DINT/UDINT/DWORD/REAL/TIME→`%MD`, LINT/ULINT/LWORD/LREAL→`%ML`. A plain number auto-formats by type. The single API password (SettingsPage → Connection) is SHA-256+salt-embedded into `variable_table.json`; empty = API disabled.

**REST endpoints** (`api.go`, Bearer token from `POST /api/v1/auth`): `GET/POST /variables[/{name}]`, `GET /stream` (SSE, addressed only, cadence tunable 5–60000 ms via `stream_interval_ms`), `POST /forces/clear`, `GET/POST /runtime[/start|/stop|/config]`. Editor streams (`/stream/vars`, RPC `StreamVars`) are fixed at 50 ms.

**`GET /api/v1/stream/buffered?vars=a,b&interval_us=N`** — high-rate server-buffered **BINARY** feed of addressed variables. Delivery cadence is fixed at **5 ms** (HTTP-friendly); the client picks a sample `interval_us` that may be *shorter*, and the server samples that fast (`AppendRawSample` reads raw LE bytes straight from the SHM mmap) and packs every sample accumulated per 5 ms into one length-prefixed frame (`u32 frame_len · u16 sample_count · u8 var_count · u8 types[] · sample_count×native-values`). This decouples a fast sample rate from the 5 ms push rate. ⚠️ **Server-sampling, not a ring:** if the PLC writes faster than `interval_us` the intermediate values are aliased away (deliberate, accepted) — samples are assumed evenly spaced (no per-sample timestamp); the delivery of what *was* sampled is lossless. `interval_us` floored at 100 µs (scheduler jitter dominates below that); one sampler goroutine per connection (designed for ≤5 clients). Reference client: `tools/buffered_stream_client.py`.

⚠️ KronServer **auto-rehydrates `variable_table.json` on startup** (`loadStoredVariableTable`) — else the API password would be empty after every reboot. The runtime need not be running for the REST API to work.

### AutoRun & restart
- AutoRun toggle persisted in project XML → pushed via `POST /deploy/config {"auto_run":…}` → `runtime_config.json`. On startup with `auto_run=true`, the server writes initial values then starts the runtime.
- The editor's 10s `/status` poll attaches on `running:true` / detects crash on `running:false`.
- ⚠️ **`restart` is a transient action flag** (not persisted). `handleDeployRuntime` only overwrites `runtime.bin` on disk — the running process keeps the old binary in memory. So `handleBuildAndSend` sends `restart: autoRun || isRunning` as its LAST step (after runtime + variable_table + project-file are all uploaded) so a push to a running/AutoRun target restarts into the new code instead of running stale code. `/deploy/config` accepts a **partial** JSON body (omitted fields keep their value); POST-only + 1 MB body limit.

### CLI flags
`-addr :7070` · `-deploy-dir /opt/plc` · `-shm-name plc_runtime` · `-shm-size 65536` · `-log-level info`.

---

## 12. Security model

The agents are "local trust" backends, but the browser makes them network-reachable, so both now **origin-gate** every request:

⚠️ **CORS/origin gating (host-agent `main.go` `isAllowedOrigin`; KronServer `server.go` `isAllowedCORSOrigin`).** If a request has an `Origin` header, it is allowed only from local/private origins — localhost, `.localhost`, `.local`, loopback (127/8, ::1), RFC1918/ULA (`net.IP.IsPrivate`), link-local — any port, http/https only. Allowed origins get the origin reflected + `Vary: Origin` (not `*`); disallowed origins get **403 without processing, on all methods** (not just preflight). Requests **without** an Origin header (curl, same-origin GET, connect-web) pass unchanged. This stops a random website the user visits from driving the agent (which exposes file R/W, compile/exec, and — on KronServer — unauthenticated `/deploy/*` that runs a binary as root).

Other hardening in place:
- **host-agent `build.go`:** `Compiler` restricted to a bare-name allowlist (clang/clang++/gcc/g++/cc); `Output` rejects `..`/separators.
- **Body limits + `ReadHeaderTimeout`** on both agents; KronServer deploy/config endpoints bounded.
- **SSH deploy** (`deploy_ssh.go`): per-command timeout, install-step errors surfaced. (Host-key auto-retrust is a known, deliberate tradeoff — see §2.)
- **KronServer:** offset validation (§11), XSS escaping, addressed-only writes, constant-time compares.

Deploy endpoints remain unauthenticated by design (the trust model is "same machine / trusted LAN"); origin gating + the private-network restriction are what make that safe against drive-by browser attacks. A shared-secret on `/deploy/*` would be the next hardening step if the threat model widens.

---

## 13. EtherCAT & motion

### Motion control (CTranspilerService.js)
- `MOTION_FB_AXIS_PARAM` set — all `MC_*` blocks call `MC_xxx_Call(&inst, &axisVar)`.
- `Axis` (AXIS_REF) is not a struct field — skipped in value assignment and null-init.
- `MC_Power`: trigger `Enable`, Q `Status`. `MC_MoveAbsolute/Relative`: trigger `Execute`, Q `Done`.
- `motion.xml`: MC_Power, MC_Home, MC_Stop, MC_Halt, MC_MoveAbsolute/Relative/Velocity, MC_Reset, MC_ReadActualPosition/Velocity/Status, MC_ReadAxisError, MC_SetOverride — all have `Axis` first.

### EtherCAT config generation
- `generateEtherCATConfig(buses, busConfigs)` → `KRON_EC_Config` init C. `static KRON_EC_Config __ec_cfg;` in `plc.c`. `kron_ec_init(&__ec_cfg)` in PLC_Init, `kron_ec_close` in PLC_Cleanup. `kron_ec_pdo_read` before `plc_shm_pull`, `kron_ec_pdo_write` after `plc_shm_sync` per task.
- ⚠️ **Axis init uses `S->${axisName}`** (globals are PlcState fields post-migration): `AXIS_REF_Init(&S->Axis1,…)`, `NC_Init(…, &S->Axis1)`.
- ⚠️ **PDO variable names are excluded from the `S->` mapping.** The transpiler generates `#define ec_X (__gpi_snap->_pi_ec_X)` per PDO entry; those names are left as bare identifiers (not `S->ec_X`) so the macro applies, and they get no `PlcState` field and no SHM slot (they're EtherCAT-owned). Mapping them to `S->` would expand to `S->(__gpi_snap->…)` — a syntax error.
- PDO varName: `entry.varName` if set, else `ec_{slaveName}_{entryName}`.
- Files: `EtherCATEditor.jsx` + `deviceCodegen.js` (master), `SlaveConfigPage.jsx` + `EsiLibraryService.js` (slave).

### Known gap
EtherCAT/motion are NOT hot-swap-trampolined (see §6) — a project using them needs a full redeploy + restart to change logic, not a hot-swap.

---

## 14. Library system & clipboard

### XML library format (`public/libraries/*.xml`)
```xml
<library><category name="TIMERS">
  <block type="TON">
    <inputs><pin name="IN" type="BOOL" trigger="true"/><pin name="PT" type="TIME"/></inputs>
    <outputs><pin name="Q" type="BOOL"/><pin name="ET" type="TIME"/></outputs>
  </block>
</category></library>
```
Load order (LibraryService.js): `bit_logic` → `timers` → `counters` → `math` → `comparison_selection` → `conversion` → `advanced_control`/`motion`/`communication`/`system`. `categoryName.replace(/_/g,' ')`. Trig typedefs are uppercase to avoid libc conflicts. Timers include TONR (retentive; ET accumulates across IN=false, only RESET clears).

### Toolbox 3-level hierarchy
`libraryTree.js` `LIBRARY_TREE`: 9 top-level categories with subcategories; `fromLibrary:[types]` resolved from XML at render; `items:[{blockType, subType, label, desc}]` inline. `Toolbox.jsx`: `buildBlockMap`, separate `expandedCats`/`expandedSubs`. Contact `#1a6b3a`, Coil `#8b3a0f`, others `#673ab7`. `subType` passed via `customData.subType`.

### Clipboard (`kronClipboard.js`)
Cross-tab copy/paste rides `navigator.clipboard` with an in-process fallback. Each payload is tagged with a `CLIP_KIND` (`POU`, `RUNG`, `BLOCK`, `VARIABLE`, `GLOBALS`). Keyboard handlers are **scope-gated** via `editorScope.js` (`SIDEBAR|VARIABLES|LD`), set on the container's mousedown. ⚠️ **The LD editor root MUST use `onMouseDownCapture`** — ReactFlow's node drag `stopPropagation`s a bubble-phase mousedown, so the scope would stay SIDEBAR and Ctrl+C would copy the whole program. All global Ctrl+C/V/Z handlers use the full focus guard (§7).

**Paste-naming rules (intentionally different by kind):**
- **POUs / data types:** keep name; on collision append `_copy1`, `_copy2`, ….
- **Local variables:** same `_copy{n}` scheme.
- **Global-variable SET** (`CLIP_KIND.GLOBALS`): **merge by name** — a same-named global is skipped (destination's kept), not `_copy`-duplicated. Addresses dropped on paste (hardware-unique). Merging into another project is the point.
- **Referenced globals bundled with a POU** (`meta.globalsBundle`): merged by name (skip-if-present).
