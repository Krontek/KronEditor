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
15. [Library builder (Settings → Libraries)](#15-library-builder-settings--libraries)

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

**Intentionally stubbed (501)** in the host agent: `ec_request_state` only — it needs a CGO bridge to the live SOEM C ABI, which the editor's main workflow never uses. (`update_libraries`, `update_server`, `build_soem` and `build_canopen` were stubs and are now real — see §15.)

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

⚠️ **A fresh clone cannot compile anything — `toolchains/` and `resources/<triple>/` are gitignored.** Only `resources/krontek-include/HAL/` is tracked; the rest of `krontek-include` (`kron*.h`, `soem/`) and every per-triple `lib/`+`server/` come from outside the repo. Symptom: `bundled clang not found: toolchains\bin\clang.exe` — the bare relative path is `paths.go`'s fallback when `guessSiblingDir` finds no toolchains tree at all (the error now says so and names the resolved root; `/api/host/health` also reports `resourcesRoot`/`toolchainsRoot`, which is the fastest way to confirm what the agent actually resolved). Two ways to populate them:
- `python setup_toolchain.py` (works on Windows too — it downloads the windows-host LLVM). Multi-GB.
- **If a packaged KronEditor is already installed on the machine, reuse its tree** — it is the same layout and the same LLVM/mingw versions the scripts pin. On Windows: `mklink /J <repo>\toolchains "C:\Program Files\KronEditor\toolchains"` (junction, no admin needed) and copy `resources/<triple>/` + the non-HAL `krontek-include` headers into the repo. **Keep the repo's own `krontek-include/HAL/`** — that one is source-of-truth here, the installed copy is a build output.

### Production build
```
npm run build           # = build:frontend + build:host-agent
./dist-binary/kron-host-agent
```
The binary embeds the React app (`host-agent/embed.go`) and looks for `resources/` and `toolchains/` as siblings of the executable (or in the working directory).

⚠️ **Compiled agents are gitignored — never commit one.** `dist-binary/kron-host-agent` plus the two strays a bare `go build` drops in `host-agent/` (`kron-host-agent`, `kron-host-agent.exe`) were tracked for a long time and re-committed on every rebuild, adding ~14 MB of unreviewable blob each time — and a binary is the one artifact in a PR that cannot be diffed or verified against its source. Nothing references them; they are reproducible with the command above, and release artifacts come from `packaging/` (§4), not from git. ⚠️ Note `go build ./...` inside `host-agent/` still WRITES those two paths, so they will reappear as untracked files after any local build — that is expected and now ignored.

### Version — single source of truth = `package.json` `"version"`
It propagates everywhere; never hardcode a version string:
- **Frontend:** Vite injects `__APP_VERSION__` (`vite.config.ts`); components import `APP_VERSION` from `src/version.js`.
- **Host agent** (`/api/host/health`): `main.go` `var appVersion = "dev"`, overridden at build via `-ldflags "-X main.appVersion=$npm_package_version"`. `go run .` shows `"dev"`.
- **Windows installer**: `build-windows.sh` interpolates the version straight into the NSIS script it generates (`APPVERSION`), which sets the installer's version, its Add/Remove Programs entry and the exe's VERSIONINFO resource.

### Distributables (`packaging/`)
⚠️ **`packaging/` holds only the three build scripts plus `packaging/README.md`, and each script emits exactly ONE self-contained artifact beside itself.** No committed ASSET files, no `dist/` tree. All artifacts are gitignored. **[`packaging/README.md`](packaging/README.md) is the full packaging reference** — purpose, host requirements, the directory contract, the Windows and macOS limitations, and how to verify a build; keep it current with these scripts.

| Script | Artifact | Contents |
|---|---|---|
| `build-appimage.sh` | `packaging/KronEditor-x86_64.AppImage` | agent + `resources/` + **linux-host** toolchains → sim AND Build & Send work |
| `build-windows.sh` | `packaging/KronEditor-Setup-x64.exe` | agent.exe + `resources/` + **windows-host** toolchains → sim AND Build & Send work |
| `build-mac.sh` | `packaging/KronEditor-<arch>.dmg` | `KronEditor.app` (agent + `resources/` + **macos-host** toolchains) → Build & Send works; sim also needs Xcode CLT on the user's Mac |

- ⚠️ **`build-mac.sh` MUST RUN ON A MAC** — the only artifact this Linux box cannot cut. Windows is cross-built here because `makensis` runs on Linux; macOS has no equivalent (`hdiutil`, `codesign`, `sips`/`iconutil` and the SDK are Apple-only). The script hard-fails on a non-Darwin host instead of emitting something subtly broken.
- ⚠️ **The macOS artifact is the one that is NOT fully self-contained.** Apple forbids redistributing its SDK, so no `toolchains/sysroots/*-apple-darwin` exists and none can ship. Compiling *for the Mac itself* (local simulation) resolves the SDK at run time with `xcrun --show-sdk-path` (`paths.go` `MacOSSDKPath`, cached via `sync.Once`), so the end user needs `xcode-select --install`. Build & Send links the bundled **Linux** sysroots and needs nothing extra.
- ⚠️ **The Krontek `.a` archives for `aarch64-apple-darwin` are NOT in the repo** (building `.a` is the user's job, §1). Without them the DMG still Builds & Sends, but local simulation fails at link. `build-mac.sh` detects this and warns loudly with the exact `clang`/`llvm-ar` commands rather than failing — a Build-&-Send-only artifact is still useful. ⚠️ `hostResourceTarget()` follows **GOARCH** on darwin (`arm64/macos` → `aarch64-apple-darwin`): every other host we ship is x86_64, and returning the Intel key on an M-series Mac links wrong-arch archives.
- ⚠️ **Ad-hoc signed, not notarized.** On Apple Silicon every Mach-O must carry a signature or the kernel kills it on load ("Killed: 9"), so the script signs the bundled clang/lld and the agent **innermost first** (signing a nested binary after its container invalidates the container). That satisfies the loader but not Gatekeeper, so the user needs a one-time `xattr -dr com.apple.quarantine /Applications/KronEditor.app` (printed by the script). Notarizing would need a paid Developer ID and uploading the whole multi-GB image.

- ⚠️ **Anything the artifact needs that used to live in `packaging/` is now GENERATED INLINE by its script** — the AppImage's `AppRun`/`.desktop` come from HEREDOCs, and the Windows installer script is an NSIS `.nsi` written at build time. Adding a committed asset file back to `packaging/` breaks the directory contract; put it in the script.
- ⚠️ **Staging dirs are per-target and self-deleting**: `packaging/tmplinux/` and `packaging/tmpwin/`, each removed by an `EXIT` trap (so a failed or Ctrl-C'd build cleans up too). They are **separate roots on purpose** — one shared `tmp/` meant the two builds could not run concurrently, because either trap would delete the other's tree. `KEEP_TMP=1` preserves the staging tree for debugging.
- ⚠️ **Downloaded build TOOLS are cached outside `packaging/`**, in `~/.cache/kron-editor-packaging/` — otherwise "delete the temp dir" would re-download ~15 MB of `appimagetool` and ~1.7 MB of NSIS on every build.
- ⚠️ **The Windows installer is built with NSIS, not Inno Setup**, because `makensis` runs natively on Linux — the whole release is cut from one machine with no Windows box and no Wine. If `makensis` is not installed the script provisions it with `apt-get download nsis nsis-common` + `dpkg -x` into the cache: **no sudo, nothing installed system-wide** (an unpacked NSIS needs `NSISDIR` pointed at its share tree, or it cannot find its stubs/plugins). The previous flow only produced a payload **zip** and left the `.exe` to `iscc` run by hand on Windows — so `build-windows.sh` never actually produced an exe.
- The NSIS uninstaller removes **only the directories the installer created** (`resources\`, `toolchains\`, the exe, the uninstaller), never a blind `RMDir /r $INSTDIR` — that would take anything the user put beside it.

Facts a packaging change must respect:
- **Toolchains are per-host; sysroots are shared.** `setup_toolchain.py --host {linux|windows}` downloads the matching LLVM; target sysroots are identical, so Windows `clang.exe` cross-compiles to the Linux PLC targets — **Build & Send works on Windows.**
- **Local simulation runs on Windows and macOS too** (see §6 "Windows simulation" / "macOS simulation"). Only the LEGACY plain-sim path stays Linux-only (`/proc/<pid>/mem` + ELF/DWARF); the others use the hot-swap runtime, which is the default anyway. ⚠️ **`GOOS=windows go build ./...` AND `GOOS=darwin GOARCH=arm64 go build ./...` must keep succeeding** — both are release invariants.
- `toolchains/` is embedded whole (no on-demand download), so artifacts are multi-GB.
- ⚠️ **The bundled GCC install dir must be located by GLOB, not built from the compile triple** (`paths.go` `LLVMGCCInstallDir`, passed as `-B` in `llvmCompileBaseArgs` and as a `-L` from `LLVMTargetLibraryDirs`). The sysroots name it with a **"none" vendor** (`arm-none-linux-gnueabihf`, `aarch64-none-linux-gnu`) while we compile with `--target=arm-linux-gnueabihf`; clang's own GCC auto-detection happens to include the aarch64 "none" spelling in its candidate list but **not** the arm one. So `--gcc-toolchain=<sysroot>` alone silently found nothing on armv7 and every `-static` target build died with `cannot open crtbeginT.o` / `unable to find library -lgcc` — **Build & Send was broken for all armv7 BeagleBones** while aarch64 worked by luck. Version dirs are compared with `compareVersionStrings` (numeric per component): `sort.Strings` ranks `9.3.0` above `10.2.1` and would select the older GCC (covered by `paths_gcc_test.go`).
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

### ⚠️ The task interval bounds every timer's resolution
A timer resolves only to the scan that observes it, and a **self-resetting TON** (`blink(IN := NOT blink.Q, PT := T#1s)`, the standard blinker) needs two extra scans per half-cycle — one to see `Q` and drop `IN`, one to restart. So the observed half-period is `PT + 2 × task_interval`. Measured against the real `TON_Call` with `PT = T#1s`: task `T#1s` → toggles every **3.00 s**; `T#500ms` → 2.00 s; `T#100ms` → 1.20 s; `T#10ms` → **1.02 s**; `T#1ms` → 1.00 s. This is standard PLC behaviour, not a bug — but it reads as "my 1-second blinker is much slower than 1 Hz" when someone sets the task period to the blink period. Keep the task interval an order of magnitude below the shortest time being measured (the `T#10ms` default is right for second-scale timers).
⚠️ Note `kronstandard.h` says `// TIME is treated as milliseconds` — that comment is **stale and wrong**. `TIME` is `uint32` **MICROseconds** end-to-end: the transpiler emits `mapIECtoTimeUs`, the loader-host feeds `us_tick` (µs), and the prebuilt `TON_Call` was verified to fire at exactly `PT = 1000000` when driven with µs.

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
⚠️ **The ns→µs migration left one straggler in the DISPLAY path**: `TaskManager.jsx`'s formatter was still `fmtExecNs` and divided as if its argument were nanoseconds, while every call site passed µs — both the exec-time badge *and* the task interval (`ivUs`). So the running task card showed every number 1000× too small: a **`T#1s` interval rendered as "1.00ms"**, a `T#1ms` one as "1.0µs". It is now `fmtExecUs` (µs → µs/ms/s). Overrun detection was never affected (`totalExecUs > ivUs`, both µs) — only the display lied, which is exactly what made it survive so long. When changing a unit, grep the FORMATTERS too, not just the arithmetic.

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

### Hot-swap (online change) — all three hosts
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

### Windows simulation ⚠️
Local simulation is **not** Linux-only any more. Windows runs the SAME hot-swap runtime; only the legacy plain-sim path (`handleRunSimulation`) is Linux-only and returns an explicit error on Windows — porting it would need a PE/DWARF reader plus `ReadProcessMemory` for zero user-visible gain, since hot-swap addresses the mirror by `variables.json` offset and needs no debug info at all.

A handful of primitives differ; **everything else — the scan structure, the ping-pong slots, the swap protocol, the force-flag semantics — has exactly one implementation.** Keep it that way.

| | Linux | Windows | macOS |
|---|---|---|---|
| mirror | `shm_open`+`ftruncate`+`mmap`, a file under `/dev/shm` | `CreateFileMapping(INVALID_HANDLE_VALUE,…)`+`MapViewOfFile`, a named section `Local\plc_runtime` | `open`+`ftruncate`+`mmap` on a REAL file, `<buildDir>/plc_runtime.mirror` |
| agent side | `os.OpenFile("/dev/shm"+name)` | `OpenFileMappingW` + `MapViewOfFile` | `os.OpenFile(<buildDir>/…)` (`shmmirror_{unix,windows,darwin}.go`) |
| dynamic load | `dlopen`/`dlsym`/`dlclose` | `LoadLibrary`/`GetProcAddress`/`FreeLibrary` (`plc_dlopen` shim in host.c) | `dlopen`/`dlsym`/`dlclose` |
| logic module | `-shared` ELF vs `-rdynamic` host | DLL + `plc_host.lib` import library | Mach-O **bundle**, `-bundle -bundle_loader plc_host` |
| swap signal | `SIGUSR1` | named auto-reset Event `Local\kron_plc_swap` + a waiter thread that sets the same `g_swap_req` flag | `SIGUSR1` |
| sleep to deadline | `clock_nanosleep(TIMER_ABSTIME)` | `CREATE_WAITABLE_TIMER_HIGH_RESOLUTION` | `mach_wait_until` |
| scan barrier | `pthread_barrier_*` | `pthread_barrier_*` (winpthreads) | mutex+condvar **shim** under the same names |

- ⚠️ **The agent OPENS the mirror and the event; the loader-host CREATES both.** A Win32 section/event only lives while a handle is open, so if the agent created them a stale segment would outlive a crashed host, and a swap signalled before the host was up would be silently latched by the auto-reset event and look accepted.
- ⚠️ **A PE DLL cannot resolve symbols from the EXE that loads it** the way a `.so` resolves against a `-rdynamic` host — imports bind at LINK time. `compileHost` therefore links the host with `-Wl,--export-all-symbols -Wl,--out-implib,plc_host.lib` and `compileLogic` links the logic DLL against that import library. That is what keeps the HAL trampolines (`__hs_*`) and the host-owned `us_tick`/`plc_stop`/`__plc_shm` in the host so they survive a swap. (The logic module itself needs no `dllexport`: mingw auto-exports everything when no symbol is explicitly exported — verified by reading the PE export table, all 10 ABI symbols present.)
- ⚠️ **Windows locks a LOADED module's file**, so a slot cannot be overwritten while live. The 2-slot ping-pong already only ever writes the slot that is *not* loaded, and `CleanupExcept` deletes the other only after a confirmed `OK` (i.e. after `FreeLibrary`) — so the scheme needs no Windows-specific change. **Do not "simplify" it to a single slot.** Slot files keep the `logic_<n>.so` name on Windows too: it is a slot id in the shared ping-pong protocol, not a format claim, and `LoadLibraryA` loads any extension by full path.
- ⚠️ **`clock_nanosleep(TIMER_ABSTIME)` exists in winpthreads but does NOT block.** The scan thread returned instantly and a 10 ms task ran ~6 million times/second (every IEC timer and counter millions of times too fast). `plc_sleep_until` in host.c therefore uses a `CREATE_WAITABLE_TIMER_HIGH_RESOLUTION` waitable timer with a relative due time computed from the same absolute deadline (zero long-term drift). Measured after the fix: 10 ms task → 320 scans in 3 s.
- ⚠️ **The scan deadline must be accumulated in 64-bit** (`task_thread` in host.c). `long` — and mingw's `timespec.tv_nsec` — is **32 bits on Windows**, so the old `next.tv_nsec += (long)(g_interval[idx] * 1000UL)` overflowed for any task interval ≥ ~2.148 s: measured on Windows, `(long)(3000000 * 1000UL)` is **−1294967296**, which pushed the deadline BACKWARD, so `plc_sleep_until` saw `delta_ns <= 0`, never slept, and the task ran flat out. It now splits a `long long` period into whole seconds + remainder before touching `tv_nsec`. Linux was never affected (LP64 `long` is 64-bit). Verified after the fix: a T#3s task ticks at exactly 3000 ms.
- ⚠️ **ISO `rename()` fails on Windows when the destination exists**, so `write_swap_result` uses `MoveFileExA(..., MOVEFILE_REPLACE_EXISTING)`. Without it only the cold-start line would ever be written and every later swap would read as a timeout.
- ⚠️ **The loader-host AND the logic module must link the mingw runtime `-static` on Windows** (`windowsStaticRuntimeFlag`, applied in both `compileHost` and `compileLogic`). llvm-mingw ships `libwinpthread.a` *and* `libwinpthread.dll.a`, and the linker prefers the import library — so both artifacts imported `libwinpthread-1.dll`, which lives only in `toolchains/sysroots/x86_64-w64-mingw32/x86_64-w64-mingw32/bin` (on neither the build dir nor PATH). Result: `plc_host.exe` died with **STATUS_DLL_NOT_FOUND (0xC0000135)** before reaching `main`, so **local simulation could never start on real Windows** — every attempt surfaced only as `cold-start outcome unknown (timeout) — host killed`. ⚠️ It must cover the LOGIC module too: the transpiler's per-task exec-time instrumentation calls `clock_gettime` (a winpthreads symbol), so **every project that has a task** pulled the same DLL import in and failed at `LoadLibraryA` with `Win32 error 126` even after the host was fixed. A zero-task project hides the bug (no task bodies → no `clock_gettime` → no import). `compileSimulation` already passed `-static` for this reason; the hot-swap path did not. **The link recipe is mixed into `hostInputsHash` via `hostLinkRecipe()`** — the cache key covers only the C sources, so a flags-only change would otherwise let every existing installation keep reusing its old, broken cached `plc_host`.
- ⚠️ **Every cold-start failure path in `host.c`'s `main` must `write_swap_result` before returning.** The Go supervisor learns the outcome ONLY from that file, so a bare `return 1` (bad `dlopen`, missing `plc_state_size`, failed `calloc`) is indistinguishable from a host that never started: the agent waits out `swapResultTimeout` and reports the useless "outcome unknown", while the real reason goes to a stderr nobody reads. `handleHotSwapRun` additionally watches the process's `done` channel (`awaitColdStart`) and reports the **exit status** when the host died without reporting — but it still RE-READS the result file on exit, because a legitimate zero-task project writes `OK … COLDSTART` and then returns immediately (no scan threads to join). ⚠️ **Sample `exited(done)`/`cmd.ProcessState` BEFORE calling `s.hotswap.Stop()`**: `Stop` kills the host and then waits on `done`, so afterwards the channel is closed either way and "died on its own" becomes indistinguishable from "we killed it" — reading it after would relabel every genuine timeout (host alive but slow) as a bogus `exited (signal: killed)` and lose the one message that path exists to produce. `describeExit` prints hex NTSTATUS on Windows (0xC0000135 only reads as anything in hex) and `ProcessState.String()` elsewhere (a signal death gives `ExitCode() == -1`, i.e. a meaningless `0xFFFFFFFF`).
- **Toolchain**: the mingw-w64 target needs its OWN `--sysroot`, `-resource-dir` (the SYSROOT's `lib/clang/<ver>` — the bundled LLVM ships only the MSVC-flavoured `.lib`), `-rtlib=compiler-rt --unwindlib=libunwind` and `-L <sysroot>/x86_64-w64-mingw32/lib`; llvm-mingw has no libgcc at all. `bundledHostClangArgs` adds all four on Windows. `hostResourceTarget()` picks `x86_64/win32` so the Windows Krontek archives (which already ship in `resources/x86_64-w64-mingw32/lib/`) are linked, not the Linux ELF ones.
- **Verified under wine64** (a dedicated 64-bit prefix, so no Windows box is needed to iterate): cold start + bind, live values through the mirror, an online swap that **preserved state while changing logic** (counter continued from 5485 and its increment went 1 → 100), FORCE held a value constant, PULSE injected once and let the logic resume.
- ⚠️ **Now also exercised on REAL Windows — and wine hid two hard failures that only appear there**, which is why the wine result above must never be read as "Windows works": the `-static`/`libwinpthread-1.dll` failure (wine resolves the DLL from its own path handling) and the 32-bit `tv_nsec` overflow (both measured on Windows, see the two entries above). Both are fixed and re-verified there. Still unverified on real Windows: AV/Defender interaction with the ping-pong slot writes, and long-run timing jitter.

### macOS simulation ⚠️
Apple Silicon (and Intel) Macs run the SAME hot-swap runtime. As on Windows, only the legacy plain-sim path is excluded (`handleRunSimulation` returns an explicit error on darwin): it would need a Mach-O/DWARF reader plus `mach_vm_read`, which SIP and the `task_for_pid` entitlement block anyway, for zero gain.

Three "POSIX" primitives are genuinely missing on macOS. **Two fail at COMPILE time and one fails silently — the silent one is the dangerous one:**

- ⚠️ **`clock_nanosleep` does not exist on macOS at all.** `plc_sleep_until` uses `mach_wait_until`, computing the delta from the same absolute deadline so the zero-drift property is preserved. ⚠️ **`mach_timebase_info` numer/denom is NOT 1/1 on Apple Silicon** (24 MHz timebase) — mach ticks must really be converted; treating them as nanoseconds runs every task ~41× too fast. (Same class of bug as the Windows `clock_nanosleep` non-blocking one.)
- ⚠️ **`pthread_barrier_*` was never implemented by Apple** (the optional POSIX barriers; `_POSIX_BARRIERS` is undefined). host.c provides a **mutex+condvar shim under the standard names** so the scan loop stays byte-identical — do NOT fork the scan loop instead. It is **phase-counted**, which is what makes the barrier safely reusable: a thread waits on the phase it entered with, so a fast thread cannot lap into the next round and be miscounted in the previous one. Verified on Linux by extracting the shim verbatim from host.c and stress-testing 1/2/3/4/8/16 threads × 20 000 rounds against the real double-barrier swap pattern, clean under ThreadSanitizer.
- ⚠️ **macOS has NO `/dev/shm`, and a `shm_open`'d object is invisible to the filesystem** — so the Go agent could only reach it via cgo (neither the stdlib nor `x/sys/unix` wraps `shm_open` on darwin), which would cost `CGO_ENABLED=0`. Apple's `shm_open` also caps names at 31 chars and permits `ftruncate` exactly ONCE per object, so a second cold start could not resize a surviving segment. The mirror is therefore a **plain `mmap(MAP_SHARED)` file** in the loader-host's cwd (= the build dir). ⚠️ host.c's `mirror_path()` and `shmmirror_darwin.go`'s `mirrorPath()` perform the SAME `/plc_runtime` → `plc_runtime.mirror` transformation — change them together, or the agent reads a file nobody writes and every live value silently freezes at zero.

- ⚠️ **A Mach-O `.dylib` cannot resolve symbols from the executable that loads it** — the two-level namespace binds every undefined symbol at LINK time, so `-shared` against a `-rdynamic` host does not work the way ELF does. `compileLogic` builds the module as **`-bundle -bundle_loader <plc_host>`** (the exact analogue of the Windows import library) and `compileHost` links with `-Wl,-export_dynamic`; that is what keeps the HAL trampolines (`__hs_*`) and the host-owned `us_tick`/`plc_stop`/`__plc_shm` in the host so they survive a swap. This makes the loader-host a **build-order prerequisite** for the logic module on darwin (it already was on Windows) — `compileLogic` errors clearly if it is missing. The 2-slot ping-pong, atomic rename and `logic_<n>.so` slot names need no change: the name is a slot id in the shared protocol, not a format claim, and `dlopen` loads a bundle by path regardless of extension.
- ⚠️ **`-lrt` and `-ldl` do not exist on macOS** — asking for them fails the link outright. `dlopen`/`clock_gettime` live in libSystem. `hostSimLinkArgs()` and `compileHost` both special-case darwin.
- ⚠️ **The Mach-O link uses the SYSTEM linker, not lld** (`hostUseLLD()` returns nothing on darwin). We already depend on the Command Line Tools for the SDK, and ld64.lld lags Apple's ld on frameworks, `-bundle_loader` and newer load commands — nothing to gain, a class of link failures to avoid. The cross-compiles to Linux boards keep `-fuse-ld=lld` unconditionally.
- ⚠️ **`__APPLE__` must stay in the transpiler's shm guard** (`CTranspilerService.js`, `#if defined(__linux__) || defined(_WIN32) || defined(__APPLE__)`) even though nothing in that block creates the segment on macOS: the hot-swap build needs the `extern __plc_shm` declaration and the `plc_shm_name`/`plc_shm_size` exports the loader-host `dlsym`s. Drop it and the sim runs perfectly while the editor shows no live values and every force-write silently does nothing.
- **Toolchain**: the macOS LLVM comes from the same upstream release (`LLVM-<ver>-macOS-ARM64.tar.xz`; `setup_toolchain.py` already matched it, no change needed). ⚠️ Unlike every other target there is **no bundled sysroot** — Apple forbids redistributing the SDK — so `bundledHostClangArgs` passes `-isysroot` from `xcrun --show-sdk-path` (`paths.go` `MacOSSDKPath`, `sync.Once`-cached, and it reports the `xcode-select --install` fix rather than letting it surface as "stdio.h not found"). The host triple is pinned to `arm64-apple-macos11`/`x86_64-apple-macos11` to match the `.app`'s `LSMinimumSystemVersion`.
- ⚠️ **NOT verified on real hardware.** The Windows port could be iterated under wine64; there is no macOS emulator on Linux. Everything above the Go layer is compile- and reasoning-verified only, plus the barrier shim's Linux stress test. The first run on a real Mac is the acceptance test — see `packaging/README.md` "Verifying a build" for what to exercise.

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
- **Power-line magnet:** the `[10,10]` snap grid cannot land a block's power handle exactly on `MIDDLE_Y` (a contact's box is 27×27 with the handle at `top:50%`, i.e. `y+13.5` in flow units — forever off any grid line). `powerHandleOffsetY(nodeId)` measures the node's first `.react-flow__handle.target` center from the DOM (divided by `scaleFactor`, so it returns FLOW units), and `onNodeDragStop` / `onDrop` snap the block to `MIDDLE_Y - offset` when released within `POWER_SNAP_DRAG`/`POWER_SNAP_DROP`.
- ⚠️ **Agent-authored blocks never travel the drop path, so they carry the same arithmetic inlined** (`LD_MIDDLE_Y`/`LD_CONTACT_Y`/`LD_FB_Y` in `agentTools.js` `compileLadderRung`). They were all emitted at `y=0`, which parked every contact and coil at the TOP of the rung ~75px above the rail with every wire running diagonally. Contact/coil is exact (`MIDDLE_Y − 27/2`); the FB constant approximates its **trigger row** (instance bar + label bar + body padding + half a pin row) since row height depends on the pin's controls — the 16px magnet absorbs the residual and any drag re-snaps it from the DOM. Branch 0 rides the line; extra parallel branches stack below by `LD_ROW`. **If the node geometry in `RungContainer` changes, these constants must follow.** Drop-time snap needs the new block's id — `insertBlock`/`addBlockToRung` (RungEditorNew) **return the created block id** for exactly this; keep that contract.

### RungContainer performance rules ⚠️
- **Never** put `liveVariables` in `mapBlocksToNodes` useCallback deps — it rebuilds every node every 500 ms. Update live values via a separate lightweight effect that only touches `n.data.liveVariables`.
- **Wrap** `varsByType`/`dtMap`/`allRawVars` in `useMemo` (deps: `variables, globalVars, dataTypes`).
- **Do not** add custom equality to `RungContainerWrapper` until all callbacks use `setRungs(prev => …)` form.
- Pin-type validation in `isValidConnection` resolves handles **by name** (`in_PT` → strip prefix → look up `cfg.inputs/outputs`), not by index.

### Undo/redo
- **Project-tree undo (App.jsx):** covers sidebar structural ops (add/delete/rename/reorder/paste of POUs & data types). `undoHistoryRef = {past,future}` (cap 50) + `projectStructureRef`. Each structural handler calls `pushUndoSnapshot(prev)` inside its `setProjectStructure` updater. Window keydown: Ctrl+Z / Ctrl+Shift+Z|Ctrl+Y, gated by `getEditorScope()` being SIDEBAR (or null).
- **LD editor undo (RungEditorNew.jsx):** `useRef` of `{rungs, variables}` pairs (max 50). ⚠️ **Every mutation must call `saveHistory(newRungs, newVariables)` with both.** The Ctrl+Z/Y handler is scope-gated to `EDITOR_SCOPE.LD`. ⚠️ `saveHistory` is called *outside* setState updaters (compute new value → set → saveHistory) — calling it inside an updater double-counts under React StrictMode.

### Focus guards ⚠️
⚠️ **A global Ctrl+C handler must ALSO bail on `hasTextSelection()`** (`editorScope.js`), not just on the INPUT/TEXTAREA/contentEditable/monaco focus check. Selecting text in a plain `<div>` — an agent chat bubble, an error message, a diff line — leaves focus on `<body>`, so every focus guard passes and the handler fires: Ctrl+C then replaced the user's highlighted text with a copied POU. Two of the three handlers were additionally permissive on a **null** scope (`if (scope && scope !== …) return`), so they fired for any panel that never claims a scope. `EDITOR_SCOPE.AGENT` exists so the agent panel claims one (`onMouseDownCapture` on its root), but the selection check is the real fix — it protects panels that don't participate in the scope system at all.

Every global window keydown handler (undo/redo, Space-toggle of contacts, Ctrl+X Run shortcut, clipboard) MUST bail when the active element is an `INPUT`/`TEXTAREA`/`isContentEditable`/inside `.monaco-editor`. A tagName-only check is insufficient because the SCL inline ST editor is Monaco (a contentEditable div). Missing guards caused: sidebar paste firing inside the code box, Ctrl+X hijacking native cut, spacebar force-toggling a contact while typing in a modal.

### Monaco editors ⚠️
Both Monaco mounts use **`defaultValue` (uncontrolled)** + a position-preserving sync effect (`if (model.getValue() !== code) { save pos; setValue; restore pos }`), NOT a controlled `value={code}` — the controlled path calls `setValue()` on every parent re-render and jerks the caret to (1,1). The EditorPane parent-sync effect **skips its first run** (mountedRef) so merely opening a POU doesn't mark the project unsaved. The SCL inline editor's blur/validation listeners read fresh props via **refs** (they're registered once at mount and would otherwise capture stale `rungs`/`variables`).

Note: the old Monaco `addCommand(Ctrl+V/C/X)` clipboard overrides were **removed** post-Tauri — Monaco's native clipboard works in the browser setup. (Earlier docs claimed they were required.)

### ST/SCL validation (`stValidation.js`)
`findStMarkers(code, {allowedLower, conversionPattern, varTypes})` — shared by the ST editor and the SCL inline rung editor. One forward token scan per line tracking the call-paren stack, so **named arguments (`IN := …`) are validated as PINS**, flagged only when the call target resolves to a *known standard* FB/function and the key isn't a pin. Pins come from `getStandardFBPins(type)`. Unknown targets (user FBs) return null → their named args are never flagged. Time/radix literals AND single-quoted string literals are blanked before scanning; member access (`x.Q`) is skipped.

---

## 8. The AI agent panel

**Full internal reference: [`docs/PLC_AGENT.md`](docs/PLC_AGENT.md)** — architecture, the complete tool reference, the ladder DSL spec (fb-in-rung, auto-declare), provider matrix, prompt policies, and the agent gate. Keep it updated together with this section.

`src/components/AiAgentPanel.jsx` — a real tool-calling agent ("PLC Agent") that edits the project: create/rename/delete POUs, rewrite ST, add/update/remove variables, author ladder. The board is read-only context. Config in `localStorage["aiAgentConfig"]`. (Code symbols stay `AiAgentPanel`/`aiAgentConfig`/`/api/host/ai/*`; only user-visible strings are "PLC Agent".) The system prompt enforces a **clarify-first policy** on ambiguous requests — asked through the `ask_user` tool (see below), never as prose.

### Architecture (3 layers)
- **`host-agent/ai.go`** — provider-agnostic single-turn chat proxy at `POST /api/host/ai/chat`. Normalizes `{provider, model, apiKey, baseUrl, system, context, messages, tools}` → one assistant message `{content, toolCalls}`. Dialects isolated in `callAnthropic`, `callOpenAI` (also serves `custom`, `deepseek`, and `gemini`/`google` via their OpenAI-compat bases), `callOllama` (synthesizes tool-call ids; has a prompt-based tool fallback for models with no native tool API). **Adding an OpenAI-compatible provider is two `case` lines** (one in `handleAIChat`, one in `handleAIModels`) plus a `PROVIDERS` entry — that is all `deepseek` needed.
- ⚠️ **A NAMED provider must always reach its own host — `baseUrl` is honored ONLY by `custom`.** `callOpenAI`/`listOpenAIModels` take a `defaultBase`; the request base is `defaultBase` when it is non-empty and `req.BaseURL` **only** when it is `""` (the `custom` case). They used to prefer `req.BaseURL` unconditionally, and `baseUrl` is a single shared field in `aiAgentConfig` — so a value left over from an Ollama/custom setup silently redirected every other provider: selecting Gemini and pasting a valid key POSTed to `http://localhost:11434/v1/chat/completions` and failed with `connection refused`, with nothing on screen suggesting the base URL was involved. Beyond the confusion, that path sends the provider's **API key as a Bearer token to whatever host the base names**. The listing path (`handleAIModels`) had the identical bug, so the model picker broke for the same provider the user was setting up; `gemini`/`anthropic` listing now pass `""` explicitly. Ollama keeps its own `baseUrl` (different function, `normalizeOllamaBase`).
- ⚠️ **Switching provider in the settings dialog must not carry `apiKey`/`baseUrl` across** (`switchProvider` + `credStashRef` in `AiAgentPanel.jsx`). The Base URL input is only *rendered* for `custom`/`local`, but the value stayed in `draftCfg` and was still saved and sent — that is what produced the stale base above. The old handler was an inline `setDraftCfg(d => ({...d, provider, model}))`. Fields are stashed per provider so flipping back and forth stays non-destructive.
- ⚠️ **The model picker reads a LIVE catalogue, never a hardcoded list** — `POST /api/host/ai/models` (`handleAIModels`) proxies each provider's list endpoint. `PROVIDERS[].models` in `AiAgentPanel.jsx` is only the **offline fallback** (no key yet, daemon down, endpoint with no `/models` route). A hardcoded list silently rots with every model release — that's how the Claude sign-in came to offer Opus 4.8 as its newest option long after Opus 5 shipped; don't "fix" a stale picker by editing the fallback array. **A provider-side failure returns HTTP 200 with `{models:[], error}`** (a missing key in a settings dialog is an expected state, not a request failure); only an unknown provider is a 400. `anthropicVersion` is the single source of the `anthropic-version` header for both `/v1/messages` and `/v1/models`.
- **Per-provider listing quirks** (each verified against the live endpoint):
  | Provider | List endpoint | Notes |
  |---|---|---|
  | anthropic / anthropic-oauth | `GET /v1/models?limit=100` | API key *or* OAuth Bearer + `oauth-2025-04-20` beta, with chat's 401 force-refresh retry. Already newest-first; all returned models are chat models. |
  | openai / custom | `GET {base}/models` (`/v1/models` on the first-party host) | Returns the WHOLE account catalogue — embeddings, whisper/tts, dall-e, moderation — so it is filtered (below) and re-sorted newest-first by the `created` timestamp (raw order is arbitrary, which buried the current model mid-list). |
  | deepseek | `GET https://api.deepseek.com/models` | Fully OpenAI-shaped (Bearer auth, `tool_calls`), so it reuses `callOpenAI`/`listOpenAIModels` unchanged. ⚠️ `deepseekBase` carries **no version segment** — both helpers append their own path (`/chat/completions`, `/models`) and DeepSeek serves them at the root. Its docs also accept `.../v1`, but that "v1" is OpenAI-SDK compatibility, not an API version. `deepseek-chat` is the tool-calling model and leads the fallback list; `deepseek-reasoner` is a reasoning model — verify its current function-calling support before pointing the agent at it. Text-only, hence absent from `IMAGE_CAPABLE_PROVIDERS`. |
  | gemini | ⚠️ **native** `GET /v1beta/models?key=…` — *not* the OpenAI-compat route | The compat `/v1beta/openai/models` **404s** ("Requested entity was not found") when unauthenticated — a routing 404 that reads as "endpoint gone" instead of "add a key". The native route also returns `supportedGenerationMethods`, so chat capability is filtered on the provider's own `generateContent` flag rather than guessed from the id. Auth is the `?key=` **query param**, not a Bearer header. (Chat still goes through the OpenAI-compat surface — only *listing* is native.) |
  | ollama | `GET /api/tags` | Lists what's **installed**, so its fallback array must hold pullable `name:tag` ids from `OLLAMA_CATALOG` — bare names like `qwen2.5-coder` aren't pullable. An empty live list means "nothing pulled yet", not an error. |
- **`isChatModelID` / `nonChatModelMarkers`** filter non-conversational families (embedding, whisper/tts/audio/realtime/transcribe, dall-e/image/imagen/sora/veo, moderation/rerank/guard, legacy babbage/ada/curie/davinci) out of the OpenAI-shaped lists. Deliberately **conservative**: the combo box is free-text, so a wrongly filtered model can still be typed, whereas a wrongly *offered* one fails later mid-conversation. Verified to keep `gpt-4o-mini` while dropping `gpt-4o-mini-tts`.
- ⚠️ **The Model field is a SELECT, never an editable combo** (`ModelPicker`). It used to be a free-text combo whose input doubled as the filter — but that input also held the *current selection*, so opening the dropdown filtered the list down to entries containing the already-selected name: a user on `claude-opus-4-8` saw only that one entry and could not reach any other model. A native `<select>` (styled like the Provider field above it) fixes this structurally — click always shows the full list, plus keyboard nav and type-ahead. **Do not reintroduce free-text-as-filter.** Two behaviours the replacement must keep: a saved model the provider no longer lists is **prepended** so it stays selectable (otherwise opening settings silently switches the user on Save), and an **empty** options list falls back to a plain text input — that's the only escape hatch, and it's needed for a `custom` gateway with no `/models` route, where a select would offer nothing at all.
- **The Connect tab withholds its form until the first catalogue fetch settles** (`modelCat.settled` → an "Updating available models…" placeholder). Rendering the form during the fetch would put the stale fallback list on screen and let the user pick from it before the real list lands. ⚠️ **Only the OPEN gates the form** (`gatedForRef`): a *provider switch* refetches with the inline "updating…" and keeps the form on screen — gating there would yank away the Provider select the user just used — while clearing `models` so the previous provider's list can't linger in the picker. Refetch is keyed on **open + provider switch only**, not on API-key/baseUrl keystrokes (per-character refetching would hammer the provider) — the inline **⟳ Refresh** button and the OAuth sign-in/sign-out handlers (via `refreshModelsRef`, since they're defined above the fetch) cover the "I just added credentials" case. `modelReqRef` sequence-guards against an out-of-order response overwriting a newer one.
- ⚠️ **Anthropic prompt caching + the `context` field split.** The agent loop re-sends tools + system + full history every turn (≤16 turns/request), which without caching re-billed everything at full input price — the dominant token cost on Claude. `callAnthropic` sets three `cache_control: ephemeral` breakpoints: last tool, last system block (both auth modes), last **stable** history block; reads bill ~0.1×. Caching is a byte-exact prefix match, so the VOLATILE project state (board, open POU, POU/global/data-type lists) must NOT live in the system prompt — `buildSystemPrompt` (AiAgentPanel.jsx) is now stable (rules + library catalog + agentMode only) and `buildProjectContext` sends the volatile part as the separate `context` request field, which `callAnthropic` appends as a trailing `<project-context>` user block AFTER the breakpoints (non-Anthropic providers get it folded into system by `handleAIChat`). ⚠️ Do not reintroduce per-turn/per-project text into `buildSystemPrompt` or before the message breakpoint — it silently kills the cache (verify via `usage.cache_read_input_tokens` if suspicious).
- ⚠️ **Providers are grouped by `auth`, not by vendor** (`PROVIDERS[].auth` + `AUTH_GROUPS` → `<optgroup>`s in the picker): `login` (sign in with an existing subscription), `key` (paste an API key), `local` (Ollama), `custom` (your own OpenAI-compatible endpoint). The key field, the sign-in block, the base-URL field and the header's `configured` pill all derive from `auth` — **don't reintroduce hardcoded provider ids** for those (the genuinely Ollama-specific bits — daemon polling, the Download tab, the pull catalog — correctly stay id-based).
- **`login` holds ONLY `anthropic-oauth`.** A subscription/account token does **not** authenticate the vendor's normal API surface, so each sign-in provider needs its OWN backend dialect — Claude's goes to `/v1/messages` with the oauth beta header (`callAnthropic` OAuth mode). **OpenAI is deliberately key-only**: it exposes PKCE OAuth (`auth.openai.com` serves OIDC discovery with S256) but a ChatGPT token is scoped to the Codex backend, which would need a third dialect. DeepSeek serves no OIDC discovery at all. ⚠️ Do not move a provider into `login` until its token is verified end-to-end against an endpoint this app actually calls.
- ⚠️ **Gemini's model LIST is not the same as what a key can CALL.** Verified live against a real AI Studio key: `/v1beta/models` happily lists `gemini-2.5-pro` / `gemini-2.5-flash`, but calling them fails (404 "no longer available to new users", or 429 with `limit: 0`), and *pro* models return 429 on a free key. So a valid key with valid auth still failed on the first request purely because of the model. The fallback list therefore uses the **`-latest` aliases** (`gemini-pro-latest`, `gemini-flash-latest`) which always resolve to a current model and cannot go stale. ⚠️ Order it by **capability, not by what one particular key has quota for** — reachability depends on the account's plan, and `friendlyProviderError` is what explains a mismatch.
- ⚠️ **`aiToolCall.Extra` round-trips the provider's opaque per-call blob and MUST be echoed back verbatim.** Gemini 3 returns `extra_content.google.thought_signature` on every tool call and rejects the *whole* next request with `400 "Function call is missing a thought_signature in functionCall parts"` when a replayed assistant turn lacks it — so multi-turn tool use (i.e. the agent loop itself) died on turn 2 while turn 1 looked perfect. `callOpenAI` captures it, `buildOpenAIMessages` re-emits it, and the frontend preserves it through the `{...c}` spread when normalizing arguments. Never parse or synthesize it.
- ⚠️ **`friendlyProviderError` (ai.go) condenses provider error bodies into one actionable sentence** before the panel shows them; the raw text still goes to the agent log. Google's quota body alone is ~800 chars of repeated per-metric lines that bury the one useful fact. It distinguishes **`limit: 0`** (the plan grants NO quota for that model — retrying never helps) from an ordinary rate limit, and flags withdrawn models. ⚠️ **Not every bad-credential answer is a 401** — Google returns **400 "Please pass a valid API key"** — so it matches on the message text too; a plain typo in a key would otherwise surface as a raw JSON blob.
- 🛑 **Google/Gemini account sign-in was implemented, then REMOVED — do not re-add it without new evidence.** Verified live against a real account: `loadCodeAssist` returns `ineligibleTiers: [free-tier → UNSUPPORTED_CLIENT, "This client is no longer supported for Gemini Code Assist for individuals … migrate to the Antigravity suite"]`, leaving only `standard-tier` (paid licence **and** a caller-supplied GCP project). Google withdrew the Gemini CLI OAuth client from the individual free tier, so the consumer path cannot work at all. The code was deleted rather than left dormant because it had to embed Gemini CLI's public client id/secret, and **GitHub push protection rejects the push on those two lines** (`GH013`, "Google OAuth Client ID/Secret"). For Gemini, use the API-key `gemini` provider — it is unaffected.
- **`host-agent/anthropic_oauth.go`** — "Sign in with your Claude account" (Pro/Max) via Claude Code's PKCE OAuth flow. Provider `anthropic-oauth`: Bearer auth + `anthropic-beta: oauth-2025-04-20` + a "You are Claude Code" identity system block (the subscription credential is only authorized for Claude Code). Tokens at `AppDataDir/anthropic_oauth.json`; auto-refresh within 60s of expiry. ⚠️ The refresh does NOT hold the mutex across the network call; `state` is matched exactly (no single-pending fallback).
- **`src/services/agentTools.js`** — the pure action surface. `TOOL_DEFS` + `applyToolCall(struct, name, args)` returns `{mutation, ok, summary, diff, next}` (never mutates in place). Tools: `get_project_overview`, `read_pou`, `list_blocks`, `create_pou`, `rename/delete_pou`, `set_st_code`, `add/update/remove_variable`, `set_ladder`, `create_data_type`.
- ⚠️ **The agent has NO compile/build tool, deliberately.** `check_compile` was removed: it ran a real transpile + bundled-clang compile, and clang's ~242 MB cold load dominates that cost (§6) — the model called it after almost every change, so every edit paid a full build and the agent felt interminably slow. Compiling is a human, toolbar-initiated action. `applyToolCall` keeps a `case 'check_compile'` guard returning a terminal, actionable error (a model can still name it from an older transcript), and the prompt says outright that it cannot build or "verify by compiling". `App.handleAgentCheckCompile`/`onCheckCompile` are gone with it. Don't re-add it without making it opt-in and rate-bounded.

### ⚠️ Array/struct/enum types are never inline — always a named data type
A variable's `type` must be a scalar IEC type, a **standard stateful FB type** (see below), an existing data-type/FB name, or (once) the literal `ARRAY[m..n] OF TYPE` (auto-recovered into a real `dataTypes` entry). Anything else is rejected with a message telling the model to call `create_data_type` first. Enforced at the single choke point `resolveVarType(struct, rawType)` (both `add_variable`/`update_variable` funnel through it). `create_data_type` builds the exact `dataTypes` shape the human editors produce (`{name, type:'Array'|'Structure'|'Enumerated', content}`).

⚠️ **`add_variable` MUST accept standard FB types (`TON`, `CTU`, `MC_Power`, …).** `resolveVarType` resolves them from `STANDARD_FB_TYPES` = keys of the transpiler's **`FB_OUTPUTS`** (exported for this) minus the `FB_TRIGGER_PIN[type]==='EN'` entries — EN-trigger blocks are the inline math/compare/conversion ops (ADD, GT, `INT_TO_REAL`, …), which are expressions with no instance, and are rejected with a "use it in an ST expression" routing error rather than the generic unknown-type message. Lookup is case-insensitive but stores the **canonical** spelling (`mc_power` → `MC_Power`) because the transpiler's tables are keyed exactly. Project data types / POUs are resolved FIRST so a user FB named `TON` shadows the standard one. Resolved FB instances (standard or user) get **`_isInstance: true`**, mirroring the editors' inline declare — it keeps instances out of the ladder pin-suggestion datalists; `update_variable` moves the flag on a retype. Without this the system prompt's own instruction ("call `list_blocks`, then `add_variable` with type = the FB type name") was rejected for *every* standard FB, and the agent had to detour through `set_ladder` just to get a timer instance declared.

### Asking the user: the `ask_user` tool (VSCode quick-pick)
⚠️ **A clarifying question is a TOOL CALL, never prose.** The prompt used to say "write the question(s) in your reply and emit no tool calls", which produced a numbered list of 3 questions in one chat bubble that the user had to read and answer in prose — and, because a text-only turn ends the loop, nothing was actually *waiting* on the answer. `ask_user` (declared in `TOOL_DEFS`, **intercepted by `runTurn` before the `applyToolCall` dispatch**) is the only sanctioned way to ask.
- **It is the one tool whose result comes from the human, not the project struct**, so it cannot live in the pure `applyToolCall` executor — that function only has a `case 'ask_user'` guard returning an error if the intercept is ever bypassed.
- **Options → buttons, no options → text box.** `options: [{label, description?}]` renders as clickable choices; omitting it renders a focused text input. The prompt tells the model that almost every PLC clarification *is* a choice (language, FB vs BOOL, ramp vs step, which UART, which type) and to reserve free text for genuinely open answers. `allowOther` (default true) keeps a free-text box under the buttons so the model's option list can never trap the user.
- **Several questions in one turn are asked ONE AT A TIME.** The model emits all its `ask_user` calls in a single turn; `asking = {calls, answers, idx, otherCalls, turn}` walks them with a `n / total` counter and sends every answer back together — so the model still gets one round without cramming.
- ⚠️ **Every `tool_call_id` in the turn must get a result** or the next request is rejected by the provider. A turn containing `ask_user` runs *no* other tool, so `answerAsk` returns an explicit `not executed — … Re-issue this call now that you have the answers` result for each of the `otherCalls`.
- ⚠️ **The question card renders OUTSIDE the scrolling message list**, directly above the input bar — same rule as the Stop button (§Run state). A blocked question that scrolls away makes the agent look hung. While `asking`, the textarea/send/attach controls are disabled, `send()` bails, and `stopAgent`/`resetChat` clear it. Cancelling a question bumps `runGenRef` and ends the run rather than fabricating a "skip" answer into the transcript.

### Run state: showing progress and stopping (VSCode-style)
- ⚠️ **The Stop control lives in the INPUT BAR, not in the message list.** While `running`, the send `➤` button becomes a red `■` Stop (and `Esc` in the textarea stops too). It used to sit only at the bottom of the *scrolling* conversation, so in a long chat it was below the fold and the agent looked unstoppable — the control was simply off-screen. Anything that reports or cancels a run must stay outside the scroll container.
- ⚠️ **`resolvePending` RESUMES the loop, so it must re-arm the run state** (`setRunning(true)` + a fresh `runStartedAt`/generation). Without that, approving a proposal left the agent working with no indicator and no Stop button at all. The clock restarts at the resume so it measures work, not how long the proposal waited for a human.
- ⚠️ **Stop is generation-based, not just an `abort()`.** `runGenRef` is bumped by `stopAgent` (and by each `send`/`resolvePending`), and `runTurn` bails whenever its captured `gen` is stale. Aborting the fetch alone is insufficient: the loop recurses *between* turns (read-only turns chain into the next `runTurn` with no request in flight), and `send()` resets `stopRequestedRef` — so without the generation a stopped loop could resume and run alongside the new one. `stopAgent` also clears `busy`/`running`/`activity` itself and posts the single "Stopped." note; the abort handler suppresses its own note when the generation is stale so it isn't posted twice.
- **Proof of life = label + ticking clock**, not the dot animation (a static animation is indistinguishable from a hung request). `activity` is set at each phase (`thinking` → `applying` → `watching live variables`) and `ElapsedTimer` renders the elapsed time. ⚠️ `ElapsedTimer` owns its own 1s interval **on purpose** — holding the tick in panel state would re-render the whole message list (and every `ProposalCard`) every second. It seeds its state from `since` rather than 0 because it also mounts mid-run.

- ⚠️ **An explicit "write it in ladder" OUTRANKS the content-based language heuristic.** The prompt used to state "user said ladder → set_ladder" and "use ST for math/comparison" as two peer rules with no precedence, so any task containing `+ 1` or `>= 10` sent the model to ST — observed with a counter request written entirely in ST, `set_ladder` never called once. The rules now say the user's request is a hard requirement, that **counting and timing are ladder-NATIVE** (CTU/CTD/CTUD's `PV` *is* the limit and `Q`/`QU`/`QD` *is* the limit-reached signal, so "count to 10" needs no comparison block; a periodic pulse is a self-resetting TON; a direction latch is SR/RS), and that if one part genuinely needs ST the rest must still be ladder rungs with the exception called out in the reply. Verified that `set_ladder` really accepts the TON + SR + CTUD pattern before telling the model to use it.

### Agent loop & robustness
- **Manual vs Auto mode** (header toggle in `AiAgentPanel.jsx`, persisted in `localStorage["aiAgentMode"]`, mirrored in `agentModeRef`). **Manual** (default): a turn's composed mutations pause as a `pending` proposal the user approves/rejects. **Auto**: `runTurn` applies the turn itself (renders the proposal as already-`approved`, calls the shared `commitTurn(steps, dryStruct)`, and feeds `outcome:'applied'` tool results straight into the next turn — no gate). `commitTurn` is the single commit path (setProjectStructure + `onApplied` + `onHotSwap`) shared by both modes; `resolvePending(true)` just calls it. `buildSystemPrompt` takes the mode so the prompt tells the model whether changes are auto-applied.
- **`create_pou` always creates the unified rung-based POU** (`SCL`; the `language` arg is accepted but only steers which authoring tool the model uses next). `set_ladder` works on LD+SCL; `set_st_code` on ST+SCL.
- ⚠️ **On an SCL POU the two authoring tools each own ONLY their own language's rungs.** `set_st_code` replaces the `lang:'ST'` rungs and **keeps** the LD ones; `set_ladder` replaces the `lang!=='ST'` rungs and **keeps** the ST ones (each preserving the other's rungs in place, ST-then-LD order). Their contracts are "the entire ST body" / "the entire ladder", NOT "the entire rung list" — mixing both languages in one POU is the documented normal case (§7), so a whole-list overwrite silently destroys the other half. Both used to assign `rungs: [theirOwn]`, so in a mixed POU whichever tool ran LAST deleted the other's work: the agent would author a ladder rung, then call `set_st_code`, and approving the ST wiped the ladder. Repeated calls to the same tool still REPLACE (never accumulate) that language's rungs.
- `read_pou` renders LD/SCL rungs via `renderRungs` (traces power-flow into readable boolean logic).
- **`list_blocks`** is how the agent learns FB/function pins (`buildBlockCatalog`). ⚠️ Each FB entry also carries **`triggerPin`** (+ a note that it must NOT be passed in `fb.inputs`) and **`powerOutputPin`** — a bare pin list left the model guessing which pin carries power flow, which is how weak models produced mis-wired or coil-less rungs. Both come from **`powerPins()`**, which `compileLadderRung` also uses, so the catalogue always documents the pins the compiler actually wires (including the first-BOOL fallback for project FBs with no entry in the transpiler tables). Functions are excluded — they're inline ST calls with no ladder power flow.
- ⚠️ **`read_pou` returns the POU's referenced GLOBALS** alongside its locals (`referencedGlobals`, word-boundary-scanned over the ST code and every ladder block's values). Without it the model reads logic like `MotorRun := (Start OR MotorRun) AND NOT Stop` where `MotorRun` is declared nowhere it can see, and a weak model "fixes" that by re-declaring it as a local — silently shadowing the global. Scoped to referenced names so a global-heavy project doesn't flood the response.
- **`set_ladder` supports contacts (NO/NC/Rising/Falling), coils (Normal/Set/Reset/Negated/edge) AND one stateful FB per rung** via `fb: {type, instance, inputs, outputs}` — power flows contact network → trigger pin → Q → coils. Wiring uses the transpiler's own `FB_TRIGGER_PIN`/`FB_Q_OUTPUT` tables (**exported from CTranspilerService for exactly this** — never hand-copy them) so handles are `in_IN`/`out_Q` etc., identical to a human-dropped block; pin metadata (`customData`) comes from the XML library (`args.__library`, injected by the panel for `list_blocks` + `set_ladder`), `GENERIC_FB_DEFS`, or the project's own FBs (`resolveFbBlockDef`). Non-trigger pins ride in `data.values` by pin NAME (literals or variable refs); `fb.outputs` captures output pins into variables (`{"ET":"elapsed"}`). Inline math/compare/move (`FB_TRIGGER_PIN[type]==='EN'`) and motion (any `AXIS_REF` pin) are **rejected with a routing error** → ST.
- ⚠️ **`set_ladder` VALIDATES contact/coil targets — a bad rung must fail loudly, never compile into a plausible-looking wrong program.** Four checks, all added after weak models silently produced nonsense that was accepted: (1) the target must be a valid IEC name — `{contact:"10"}` used to create a block referencing an undeclared literal; (2) if already declared it must be **BOOL** — a coil on an `INT` used to sail through and only break in generated C; (3) an unknown `subType` **errors instead of falling back** to NO/Normal, and comparison-ish names (`EQ`,`GT`,`>=`,…) get a routing error to ST — `{contact:"counter",subType:"EQ"}` + `{contact:"10"}` had been silently normalized into `counter AND 10`; (4) member access (`blink.Q`) is explicitly allowed through as an FB output pin. `normContactSub`/`normCoilSub` still exist but are **display-only** (`ladderRungText` renders the approval diff and must never throw) — compilation uses the strict `reqContactSub`/`reqCoilSub`.
- ⚠️ **`add_variable` refuses to create a local that SHADOWS a global.** `set_ladder`'s auto-declare resolves a contact/coil against locals *and* globals, so adding a local with a global's name silently re-binds every existing reference to the new local (observed: a BOOL global `counter`, then a local `counter : INT`, quietly retargeting a rung's coil).
- **`set_ladder` auto-declares** referenced-but-undeclared variables (contacts/coils → BOOL, `fb.instance` → the FB type, fb pin refs → the PIN's type, e.g. `ET⇒elapsed` declares `elapsed : TIME`) and lists each one in the approval diff — typos surface to the human instead of silently splitting logic.
- ⚠️ **`experiments/agent-check/gate.sh`** drives the REAL tool surface (create_pou → set_ladder with seal-in + TON + CTU + R_TRIG), asserts the produced block/wire/variable shapes AND `read_pou`'s rendering, then transpiles + compiles with the bundled clang. Run it after touching agentTools' ladder DSL or the transpiler's LD path.
- **Live diagnosis:** `read_live_variables` returns a buffered snapshot + history; `watch_live_variables` awaits a per-variable trailing window (`summarizeWatch`) then injects the summary. The prompt routes time-dependent checks to `watch` and to auto-verify after any change/deploy.
- **POU-target inference:** a local-scope tool whose `pou` doesn't resolve gets rewritten to the last-touched / just-created / open POU (weak-model safety net; only overrides an *unresolvable* pou).
- ⚠️ **Tool errors are the weak model's only feedback channel — make them actionable.** `pouTargetError` distinguishes "no `pou` was named" from "that POU doesn't exist", and always appends the POUs that DO exist (or "no POUs yet — call create_pou first"). It replaced a raw `` `POU "${args.pou}" not found` `` that interpolated a JS `undefined` into the message whenever a recovery layer synthesized a call with no `pou` and `inferPou` had nothing to infer from (empty project). `POU "undefined" not found` told the model nothing, and observed local models responded by abandoning the task entirely. Any new error a tool can return should name the fix, not just the symptom.
- ⚠️ **A bare-args JSON object is routed by its SHAPE, not by the surrounding prose** (`toolFromArgShape` / `ARG_SHAPE_TOOL`, checked before `lastToolMention` in `consume`). `lastToolMention` scans the text *preceding* the object — and that text includes EARLIER JSON BLOCKS, so a second unnamed block inherited the first block's tool name: llama3.1:8b emitted `{"name":"create_pou",…}` followed by a bare `{"pou":…,"rungs":[…]}`, which ran as `create_pou` and died with "name is required" instead of as `set_ladder`. Only **unambiguous** keys may be added to the table (`rungs`, `code`, `newName`, `kind`) — `add/update/remove_variable` all share `{name,pou,scope}` and must stay with the prose scan.
- **Weak-model recovery layers:** `extractInlineToolCalls` (JSON + markdown-heading + bare-args forms), `extractKeyValToolCalls`, `recoverStCodeBlock`, `stripSpecialTokens`, `repairJsonBrackets`, `extractStDeclarations` (adds inlined `VAR…END_VAR` declarations to the diff). These keep qwen2.5-coder-class local models *usable* but unreliable; a native-tools cloud model (Gemini/Claude) is far steadier.
- ⚠️ **The text-mining recovery layers run ONLY for `ollama`/`custom`** (`recoverToolCallsFromText`), and every call they fabricate is tagged **`_synth: true`**. Two distinct bugs made this necessary, both observed end-to-end against Gemini: (1) a first-party provider that returns text-only is **finished**, so treating its closing summary as a missed call is a misread — Gemini applied a 4-tool turn, then replied "I have created … ```iecst …```", and `recoverStCodeBlock` re-submitted that summary as a *new* `set_st_code` (with no `pou`, so it also errored); (2) far worse, that fabricated call was then **replayed to the provider as a real tool call**, and Gemini 3 hard-rejects the WHOLE request with `400 "Function call is missing a thought_signature in functionCall parts … function call default_api:set_st_code, position 7"`. A `thought_signature` cannot be synthesized, so the run was unrecoverable — every subsequent turn 400'd. **`providerSafeMessages` is the standing safety net**: before each request it strips `_synth` calls out of the assistant turn (folding them into its text) and rewrites their `tool` results as user-role lines, so a recovered call still *executes locally* but is never presented as something the model emitted. ⚠️ It must rewrite the results too — a `tool` message whose `tool_call_id` has no matching call is itself a 400 on Anthropic and OpenAI. The agent log records `(no structured tool_calls — …)` right before such a failure, which is the fingerprint to look for.

### Local model setup (Ollama) — `host-agent/ollama.go`
Talks to a local Ollama daemon (default `:11434`) over HTTP — no CLI shell-out. Routes: `ollama-status`, `ollama-setup` (one-click bootstrap: locate/download the official archive into `AppDataDir/ollama`, spawn `ollama serve`), `ollama-pull`, `ollama-runtime` (GPU/CPU placement + VRAM). Progress on SSE topics `ollama-setup-progress`/`ollama-pull-progress`. Multiplatform: Linux `.tar.zst` (pure-Go zstd, keeps `CGO_ENABLED=0`), Windows `.zip`. ⚠️ Tar extraction rejects symlink-slip (absolute or `..`-escaping Linknames). Verified end-to-end on Linux; Windows compile-verified.

---

## 9. Board support (adding a new SBC)

Boards are grouped into **display families** (`BOARD_FAMILIES` in `boardDefinitions.js`) and, separately, into **HAL families** (chosen by ID prefix). The HAL family determines the HAL header, compile triple, device paths, and server binary.

### ⚠️ INVARIANT — `getBoardFamilyDefine` exists in THREE files, keep them identical
1. `src/utils/devicePortMapping.js`
2. `src/services/CTranspilerService.js`
3. `src/utils/deviceCodegen.js`

All three map an ID prefix → HAL family: `rpi_`→`RPI`, `bb_`→`BB`, `jetson_`→`JETSON`, plus the generic-Linux vendor prefixes below. Adding a prefix to one but not the others silently breaks codegen for that board.

### ⚠️ Every supported board runs Linux — there is no bare-metal family
`rpi_pico`/`rpi_pico_w` and `HAL_BOARD_FAMILY_PICO` were **removed**: the whole product (KronServer agent, `/dev/shm` IPC, SocketCAN, sysfs PWM, hot-swap `dlopen`) assumes a Linux userspace, so a Cortex-M board could only ever simulate — deploy was rejected — while still costing a HAL header, three prefix mappings and per-board UI branches. `kronhal_pico.h` is gone. **Do not add a non-Linux board back** without first designing a real bare-metal runtime; a board that cannot be deployed to does not belong in the board list.

### Currently supported HAL families
| HAL family | Boards | Arch | HAL header |
|---|---|---|---|
| `HAL_BOARD_FAMILY_RPI` | Raspberry Pi (rpi_*) + all generic-Linux SBCs below | aarch64 | `kronhal_rpi.h` |
| `HAL_BOARD_FAMILY_BB` | BeagleBone (bb_*; `bb_ai64` is aarch64, rest armv7) | armv7/aarch64 | `kronhal_bb.h` |
| `HAL_BOARD_FAMILY_JETSON` | NVIDIA Jetson (jetson_*) | aarch64 | `kronhal_jetson.h` |

### Generic-Linux SBCs (reuse the RPi HAL)
`kronhal_rpi.h` uses standard Linux userspace APIs (gpiod, `/dev/i2c-*`, `/dev/spidev*`, `/dev/tty*`) that work on essentially all aarch64 Linux SBCs. So these boards are grouped under their own **display** families for a nice UI but map (via the three `getBoardFamilyDefine`) to `HAL_BOARD_FAMILY_RPI` — no new C HAL, no new triple, no new server binary:

Orange Pi (`opi_*`), Radxa (`radxa_*`), Odroid (`odroid_*`), Banana Pi (`bpi_*`), Libre Computer (`libre_*`), Pine64 (`pine_*`) — 12 boards, all aarch64, pinLayout `rpi40`.

⚠️ **Device-path caveat:** these boards reuse the RPi `BOARD_PORT_DETAILS` (`/dev/ttyAMA0`, `/dev/i2c-1`, `/dev/spidev0.0`), which are *functional defaults* but differ per SoC — Rockchip header UART is often `/dev/ttyS2`, header I2C `/dev/i2c-2/-3/-7`; Amlogic UARTs are `/dev/ttyAML*`; Allwinner H618 UARTs are `/dev/ttyS0..5`. Users can override the device path per port. USB serial (`/dev/ttyUSB*`, `/dev/ttyACM*`) is identical everywhere.

⚠️ **Device-node overrides (UART + I2C) — how they reach the HAL.** The interface-config Device Path/Node field (stored per port in `content.deviceInterfaceConfig`, resource id `res_config`) is emitted by `buildRuntimePortHelpers` (CTranspilerService.js) as `#define KRON_UART<n> "<path>"` / `#define KRON_I2C<n> "<path>"` *before* `kron_hal.h`, and the HALs resolve the open path through `_*_devnode(ch)` (`_i2c_devnode` in kronhal_jetson.h, `_rpi_i2c_devnode` in kronhal_rpi.h). SPI has no override (path derived from bus/cs). This matters on Jetson Orin, where header pins 3/5 are I2C8 (typically `/dev/i2c-7`), not the table's Nano-era `/dev/i2c-1` — set the Device Node field after verifying with `i2cdetect -l` on the target. The I2C **CLOCK HZ field is decorative** — Linux i2c-dev cannot change bus speed at runtime (device-tree fixed); only the SPI clock is real (`KRON_SPI_PortResolve`).

### Checklist — adding a board
**Adding an aarch64 Linux SBC to an existing (or generic-Linux) family — the common case:**
1. `boardDefinitions.js` — add the board object to a `BOARD_FAMILIES` family (`{id, name, cpu, arch:'aarch64', ram, storage, connectivity, gpio, usb, display, pinout, pinLayout:'rpi40', interfaces, usbPorts}`). Reuse `GENERIC_40PIN_HEADER` for 40-pin boards.
2. `boardLibraryBlocks.js` — add `BOARD_CHANNELS[id] = {PWM, SPI, I2C, UART, USB[, ADC, CAN]}` matching the board's real peripheral count. ⚠️ **A key here MINTS BLOCKS in the toolbox**, so an optimistic count is a promise the hardware must keep — omit `CAN`/`ADC` entirely rather than guessing (`jetson_nano` claimed `CAN: 1`, but Tegra X1 has no CAN controller at all; RK3588 boards were missing CAN they really do have via the `can0-m0`/`can1-m0` overlays). `boardDefinitions.js` `interfaces:` is **display-only** (a chip list in `InterfacesCard`) — it mints nothing, but keep the two consistent.
3. **Nothing else** if the prefix already maps to a HAL family. `compile.go` needs no change (non-`bb_` → default aarch64 triple). The aarch64 server binary already exists at `resources/aarch64-linux-gnu/server/plc-agent_linux_arm64`.

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

### ⚠️ A missing peripheral must FAIL, never fake success
Every `_Call` that cannot do its job sets `ERR_ID` and leaves its output false/zero. The three HALs used to contain `/* TODO */` bodies that returned `DONE = EN` or `VALUE = 0, ERR_ID = 0` — indistinguishable on the wire from a working read, so a project would silently run on invented data. All of those are now either real or honest:

| Peripheral | RPI (+ all generic-Linux SBCs) | BB | JETSON |
|---|---|---|---|
| GPIO / I2C / SPI burst / UART / USB | real | real | real |
| PWM | real (sysfs, channels **flattened across chips**, `KRON_PWM_MAX 8`) | real (sysfs, same flattening — AM335x ehrpwm exposes 2 per chip, so PWM0/1 = chip 0, PWM2 = chip 1) | real |
| SPI single byte | real | real | real |
| ADC | generic IIO scan (`in_voltage<ch>_raw`, honors the driver's `_scale`); no IIO device → `ERR_ID=2` | real (AM335x IIO, 12-bit / 1.8 V) | `ERR_ID=1` — Jetson dev kits expose no user ADC |
| CAN | SocketCAN (MCP2515 HATs, Rockchip on-chip) | SocketCAN (dcan0/dcan1) | SocketCAN |
| PRU / PCM / Grove / DI / DO | `ERR_ID=1` | `ERR_ID=1` (PRU needs remoteproc firmware infra) | `ERR_ID=1` |

SocketCAN blocks open `KRON_CAN0`/`KRON_CAN1` (default `can0`/`can1`) **non-blocking**; the interface must already be up (`ip link set can0 up type can bitrate 500000`) or the call reports `ERR_ID=2`. ERR_ID convention throughout: `0`=OK, `1`=invalid channel/pin (or peripheral genuinely absent), `2`=open/init failed, `3`=I/O error.

⚠️ **PWM channels are FLATTENED ACROSS pwmchips in both HALs** — never "the first chip with enough channels". A Pi really does put both channels on one pwmchip, but the generic-Linux SBCs that share `kronhal_rpi.h` publish one pwmchip **per PWM cell** (an ODROID-C4's PWM_A…PWM_F are three 2-channel cells; Rockchip is the same). The old "first chip with `npwm >= KRON_PWM_MAX`" probe therefore matched **nothing** on those boards and PWM was dead on all 12 of them. Chips are now collected, **sorted by index** (readdir order is not sorted, and channel numbering must be stable across boots) and their `npwm` concatenated, so global channel → `(chip, local)`. ⚠️ The fd arrays lost their `{-1,-1}` initializers when `KRON_PWM_MAX` grew, so `HAL_Init` **must** set them to `-1`: every "is this open?" test is `fd >= 0`, and a static-zero fd would make `HAL_Cleanup` write `"0"` to fd 0 and **close stdin**.

### ⚠️ KNOWN GAP — GPIO pin numbering is Raspberry-Pi-specific on the 12 generic-Linux boards
`_RPI_PHYS_TO_BCM` (kronhal_rpi.h) translates the user's physical header pin → **BCM** line, and `GENERIC_40PIN_HEADER` in `boardDefinitions.js` is literally `RPI_40PIN_HEADER`. Every generic-Linux board (`opi_`, `radxa_`, `odroid_`, `bpi_`, `libre_`, `pine_`) inherits both — but their kernel line numbering is completely different (Rockchip `bank*32 + port*8 + pin` → ROCK64 pin 3 is GPIO2_D1 = line 89, not 2; Amlogic ODROID-C4 pin 3 is GPIOX.17 = export 493). So a GPIO block on those boards **silently drives a different pad** — it does not fail, which is worse than the stub problem fixed above. I2C/SPI/UART/USB/PWM/ADC/CAN are unaffected (they address device nodes and sysfs, not line numbers). Verified header pinouts are on hand for **ODROID-C4** (wiki.odroid.com expansion_connectors) and **ROCK64** (Port V3 Pi-2 definition); the other 10 boards need per-board data before a real fix. Fixing it needs a per-board phys→line table selected at compile time (the `-D` channel `compile.go` already uses for `KRON_GPIO_CHIP`), plus per-board `pinout` arrays so the UI stops showing BCM names on non-Pi hardware.

⚠️ **The BeagleBone P8 pin map was all `-1` placeholders** — every P8 GPIO silently failed. It now carries the real AM335x `bank*32 + offset` line ids from the BBB SRM. Two caveats live in the header: many P8 pins conflict with HDMI/eMMC unless disabled in the device tree (the request just fails EBUSY), and `bb_ai`/`bb_ai64` (AM5729/TDA4VM) route *different* SoC pads to the same header positions, so their map needs on-device verification.

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

⚠️ **Never call `navigator.clipboard.readText()` while OPENING a menu.** Firefox (and Safari) answer every `readText()` with a native "Paste" confirmation chip at the cursor — so a right-click showed only that chip, and the app's context menu appeared only after the chip was dismissed (the awaited promise settled). Menu builders and focus refresh must use `peekClipboard()`/`refreshClipboard()`, which read the OS clipboard only when the Permissions API reports `clipboard-read: granted` (Chrome) and otherwise return the cache. **Cross-window sync rides a localStorage mirror** (`STORE_KEY` + the `'storage'` event, seeded at module load): every copy writes the OS clipboard AND the mirror, so same-origin Firefox windows see each other's copies permission-free (menu items, Ctrl+V — no chip). `readClipboard()` (paste actions): silent OS read when granted, else the mirror; the prompting chip-read is the LAST RESORT for an empty cache (fresh profile, or a copy made in a *different browser* — the one case where the mirror can be stale/missing).

**Paste-naming rules (intentionally different by kind):**
- **POUs / data types:** keep name; on collision append `_copy1`, `_copy2`, ….
- **Local variables:** same `_copy{n}` scheme.
- **Global-variable SET** (`CLIP_KIND.GLOBALS`): **merge by name** — a same-named global is skipped (destination's kept), not `_copy`-duplicated. Addresses dropped on paste (hardware-unique). Merging into another project is the point.
- **Referenced globals bundled with a POU** (`meta.globalsBundle`): merged by name (skip-if-present).

---

## 15. Library builder (Settings → Libraries)

The four buttons in Settings → Libraries. All were 501 stubs after the Tauri removal and are now real, ported from `src-tauri/src/main.rs` (`do_update_libraries` / `do_build_soem` / `do_build_canopen` / `do_update_server`, recoverable at `bdc8c071^`).

| Button | Endpoint | Code | Produces |
|---|---|---|---|
| Build Libraries | `update-libraries` | `libraries_kron.go` | `resources/krontek-include/*.h` + `HAL/` and one `lib<stem>.a` per source, per target |
| Build SOEM | `build-soem` | `libraries_deps.go` | `krontek-include/soem/**` + `libsoem.a` |
| Build CANopen | `build-canopen` | `libraries_deps.go` | `krontek-include/canopen/**` + `libcanopen.a` |
| Build Server | `update-server` | `libraries_server.go` | `resources/<triple>/server/plc-agent_linux_{armv7,arm64,amd64}` |

These are **developer** actions: they need `git`, network access, and they rewrite files committed to the repo. `libraries.go` holds the target matrix and the shared helpers (clone, compile, archive, staging swap).

### Target matrix (`libraryTargets`)
`x86_64/linux`, `x86_64/win32`, `arm/aarch64`, `arm/armv7` — plus `arm64/macos` (or `x86_64/macos`) **only when running on a Mac**.
- ⚠️ **macOS is host-only.** Every other target cross-compiles anywhere because its sysroot is bundled; Apple's SDK cannot be redistributed, so darwin archives exist only if the build runs on a Mac. The matrix is host-dependent for the first time — `runUpdateLibraries` logs an explicit note on non-Mac hosts so a Linux run cannot read as "macOS covered too". This is the intended way to produce the archives `packaging/build-mac.sh` warns about.
- ⚠️ **Cortex-M (M0/M4/M7) was REMOVED from the matrix** with the bare-metal boards (§9). `targetResourceKey`/`llvmCompileBaseArgs` never learned `arm-none-eabi`, so adding the targets back means adding both. The stale `resources/arm-none-eabi-m*/` trees are left untouched, not deleted.
- Cross targets resolve their compiler through `llvmCompileBaseArgs` (bundled sysroot); the macOS host target must go through `bundledHostClangArgs` (`-isysroot` from xcrun) — `resolveToolchain` picks.

### Rules the port deliberately CHANGED from the Tauri original
- ⚠️ **Headers go to ONE place.** The original copied them into every `resources/<triple>/include/`; those copies were consolidated into `resources/krontek-include/` precisely because drift between them was a recurring bug (§1/§3). `installKrontekHeaders` must never grow back into a per-target loop — `TestRunUpdateLibrariesEndToEnd` asserts no per-target `include/` appears.
- ⚠️ **Build to staging, install only on success.** The original DELETED every header and `.a` up front and compiled in place, so an aborted run left `resources/` stripped. Survivable when each target had its own header copy; not survivable now that one shared tree feeds every compile in the product.
- ⚠️ **`installKrontekHeaders` replaces only what the Krontek repos own** — top-level `*.h` plus `HAL/`. Sibling subtrees (`soem/`, `canopen/`) belong to the other buttons and must survive; the original got away with wiping everything only because it rebuilt SOEM in the same pass.
- ⚠️ **A header scope is cleared ONLY if the build staged content for it** (`stagedScopes`; an empty staged `HAL/` does not count). Nothing writing into `resources/` may delete what the current run cannot put back — `HAL/` in particular is hand-maintained and never staged, since KronHAL is not a repo.
- ⚠️ **A local `KrontekLibraries/` is NOT written back to.** The original synced the GitHub clone onto it, which silently overwrites the very local edits §1 makes it the source of truth for. The build logs that it is leaving the directory alone.
- ⚠️ **KronHAL is NOT a repo** and is absent from `KRON_REPOS` (SettingsPage.jsx). The HAL headers live only in `resources/krontek-include/HAL/`, edited there directly (or mirrored from `KrontekLibraries/KronHAL/` — §1). `runUpdateLibraries`'s `isHAL` branch is currently dead code, kept only so the HAL/ layout rule survives if those sources ever return as a fetchable repo.

### Constraints the implementation must respect
- ⚠️ **A repo that fails to clone is skipped, never a hard stop.** The failure is recorded and the loop moves on, so everything that DID clone still compiles and all problems surface in one run. The run as a whole still fails and installs nothing (the staging/atomicity rule above).
- ⚠️ **`runWithTimeout` APPENDS to `cmd.Env`, never resets it to `os.Environ()`.** `runUpdateServer` sets `GOOS`/`GOARCH`/`GOARM`/`CGO_ENABLED=0` before calling in; resetting silently produces host-arch, dynamically linked binaries that `deploy_server_to_target` would ship to ARM boards.
- ⚠️ **SOEM's `ec_options.h` is cmake-generated**, so a plain clone lacks it and every SOEM source fails on the missing include. `writeSoemOptionsHeader` writes SOEM v2.0.0's CMakeLists defaults directly (no cmake dependency). `EC_BUFSIZE` really is `(EC_MAXECATFRAME)` — that macro comes from `ec_type.h`, included later, so the preprocessor resolves it lazily. Do not "fix" it to a literal.
- ⚠️ **SOEM v2.x builds `osal/<platform>/osal.c` only**; only legacy trees also compile `osal/*.c` from the root, and adding it on v2.x gives duplicate symbols. `patchSoemWin32Osal` swaps `timespec_get()` for `_ftime64_s()` because mingw-w64 on MSVCRT does not expose it even with `-std=c11`.
- ⚠️ **CANopenNode's upstream layout DRIFTED since the Tauri code.** The `socketCAN/` directory the original compiled has moved to a separate repo (CANopenLinux), and the only `CO_driver_target.h` now lives in `example/`. So the build produces a protocol-stack archive (`CANopen.c` + `301/` + `303/` + `305/`) bound to upstream's **reference** driver header — compilable everywhere, but **not CAN-capable**: a real KronCANopen driver must rebuild the stack against its own `CO_driver_target.h`, since the struct layouts come from it. Upstream `304/`, `309/`, `storage/`, `extra/` are logged as present-but-not-built rather than silently guessed at.
- **Nothing links `libcanopen.a` today** — `kron_pi.h` only names KronCANopen as a future parallel driver. The build says so in its own log.
- Compilation is parallel (`compileConcurrency`, capped at 8): the bundled clang is ~242 MB and its cold load dominates each invocation, so a serial 5-target matrix spends most of its wall clock in process startup. Object files carry an index prefix because two source dirs can hold the same basename (SOEM's `osal/osal.c` vs `osal/linux/osal.c`) and a plain stem silently overwrites one.
- `archive()` removes the target `.a` first: `ar rcs` MERGES into an existing archive, so a stale member would otherwise survive a rebuild.

### Tests
`libraries_test.go` / `libraries_deps_test.go` — driven against the real bundled clang.
- ⚠️ The Krontek repos are **private**, so `krontekRepoBase` is a `var` the end-to-end test repoints at a local git fixture. The fixture directory must be named `<repo>.git`: the URL is built as `base+repo+".git"` and git does not strip that suffix for filesystem paths.
- SOEM/CANopen/server tests do real clones and real cross-compiles; they honour `-short` and skip when github is unreachable.
