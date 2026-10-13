# KronEditor — Architecture & Principles

Browser-based **IEC 61131-3 PLC editor**: draw Ladder (LD) / write Structured Text (ST) → transpile to C → compile with a bundled clang → run a local simulation or deploy to a Linux SBC running KronServer.

⚠️ = depends on this; breaks silently.

## How this documentation is organised
This file holds only the architecture, the contributor rules and the invariants that cross module boundaries. **Area rules live in a `CLAUDE.md` next to the code they govern** — Claude Code loads one automatically when it works on a file in that directory, so read the matching file before changing an area:

| File | Covers |
|---|---|
| [`src/CLAUDE.md`](src/CLAUDE.md) | editor UI (rungs, ReactFlow, Monaco, undo, focus), live values & liveness, AI agent panel, board support, IEC addresses, EtherCAT/ESI editor, clipboard |
| [`src/services/CLAUDE.md`](src/services/CLAUDE.md) | the transpiler (ST/LD → C), motion & EtherCAT codegen, library blocks (XML ↔ C), STRING, RETAIN |
| [`host-agent/CLAUDE.md`](host-agent/CLAUDE.md) | simulation + hot-swap runtime (Linux/Windows/macOS), privileged runtime, deploy to target, packaging & toolchain, library builder |
| [`server/CLAUDE.md`](server/CLAUDE.md) | KronServer process/deploy endpoints, HMI & REST, lossless capture ring |
| [`resources/krontek-include/CLAUDE.md`](resources/krontek-include/CLAUDE.md) | HAL pattern, motion library, rules for `kron*.h` bodies |

Deep references: [`docs/PLC_AGENT.md`](docs/PLC_AGENT.md) (agent), [`server/RING_FORMAT.md`](server/RING_FORMAT.md) (ring + variable segment + force mailbox bytes), [`server/API.md`](server/API.md) (REST), [`packaging/README.md`](packaging/README.md). Pre-split long form: `git show be0f9b8:CLAUDE.md`.

## Rules for contributors
- Code, comments, identifiers and string literals are **English only**.
- **Headers live in ONE place:** `resources/krontek-include/` (incl. `HAL/`). No per-triple `include/` copies — drift was a recurring bug. If `KrontekLibraries/` exists locally it is the source of truth for `.c`; mirror `.h` changes into `krontek-include/`.
- **Never generate `.a` archives** — only `.c`/`.h`. Building/deploying the per-triple `.a` is the user's job.
- **Ask before large or ambiguous changes** — before implementing, not after.
- **Open the spec, never quote a standard from memory** (details below).
- **A missing capability must FAIL loudly, never fake success** — a HAL `_Call` that cannot work sets `ERR_ID`; a transpiler gap throws; a stub carries a visible note. Plausible-but-wrong output is the failure mode this codebase keeps paying for.
- **Keep these files current** — record durable, surprising findings in the same turn, in the file of the area they belong to (this one only if they cross areas): the *rule* + a few words of *why*. Never session state or what the code already says. ⚠️ **Size limits — they load into context:** this file < 20 000 characters, each area file < 30 000; adding a rule means compressing or deleting an equally sized one. Code comments cite these files by path, not by section number.

## Stack & processes
| Process | Role |
|---|---|
| Frontend (React/Vite, ReactFlow for LD, Monaco for ST) | editor UI in a browser tab |
| Host agent `host-agent/` (Go, **`:7171`**) | file I/O, clang, sim spawn + variable reads, SSE, deploy; embeds the Vite build (`embed.FS`) |
| KronServer `server/` (Go, on the SBC, **`:7070`**) | receives the runtime; lifecycle, shm IPC, HMI + REST, capture ring |

**Data flow:** project (rungs, variables, tasks, buses) → `CTranspilerService.js` emits ONE `plc.c` whose `PlcState` struct holds all mutable state → the host agent compiles it with the bundled clang either as a hot-swap `logic.so` under a stable loader-host (local sim, default) or as a cross-compiled `runtime.bin` (Build & Send → KronServer). Both mirror variables into a 64 KiB shm segment at offsets from `variables.json`; the agents read it for live values (SSE) and write it only through the force-write mailbox.

Simulation = a binary spawned by the host agent; variables via `/dev/shm` (hot-swap, default) or `/proc/<pid>/mem` (legacy plain sim). **The runtime always runs privileged** (raw socket for EtherCAT + SCHED_FIFO), so it is a root child of an unprivileged agent — control paths cannot rely on `kill(2)` (see `host-agent/CLAUDE.md`).

**Tauri was removed:** `invoke()` → `host.<method>()` (`HostClient.js`), events → SSE, fs/dialog/clipboard → `browserFs.js` + `navigator.clipboard`. Only `ec_request_state` is still a 501 stub (needs a CGO bridge to SOEM).

## Repository layout
```
src/
  App.jsx                  Root state: isRunning, isSimulationMode, liveVariables, project tree
  components/  EditorPane RungEditorNew RungContainer VariableManager ProjectSidebar Toolbox
               OutputPanel BoardConfigPage TaskManager Slave/EtherCATEditor AiAgentPanel
  services/    CTranspilerService.js (ST/LD→C, the compile path) HostClient PLCClient
               LibraryService browserFs agentTools.js (agent action surface)
  utils/       boardDefinitions boardLibraryBlocks devicePortMapping deviceCodegen libraryTree
               stValidation iecNames iecAddress editorScope kronClipboard hwPortVars ecNaming
host-agent/    main paths files compile runtime hotswap deploy deploy_ssh ai ollama
               anthropic_oauth events embed libraries* hotswaphost/host.c
server/        main server service ipc ipc_ring process auth hmi api hotswap ringsize
               build.sh (→ dist/ AND resources/<triple>/server/) RING_FORMAT.md proto/
hotswaplib/    shared Go module (local-replaced into both go.mod): generations, swap_result,
               shmcmd/ (force-write mailbox writer)
resources/krontek-include/  SINGLE shared header tree (HAL/*.h + kron*.h + soem/), one -I per target
       kronsystem.h  git-TRACKED (like HAL/): static-inline blocks needing no .a
resources/<triple>/  per-arch artifacts ONLY: lib/*.a + server/. No headers.
toolchains/    bundled LLVM + sysroots (~5 GB, gitignored)
public/libraries/*.xml  block definitions;  KrontekLibraries/  SOURCE OF TRUTH for .c/.h
experiments/   transpiler-check/ agent-check/;  docs/PLC_AGENT.md  full agent reference
ApiSamples/    stdlib-only Python REST/ring clients + samples (own README.md)
```

## Dev workflow & versioning
```
cd host-agent && go run .   # API + embedded frontend :7171
npm run dev                 # Vite :1420, proxies /api/host → :7171
npm run build               # → ./dist-binary/kron-host-agent
```
- ⚠️ **A fresh clone cannot compile** — `toolchains/` and `resources/<triple>/` are gitignored (only `krontek-include/HAL/` + `kronsystem.h` are tracked). `bundled clang not found: toolchains\bin\clang.exe` is `paths.go`'s no-toolchain fallback; `/api/host/health` reports the resolved roots. Fix with `python setup_toolchain.py`, but **keep the repo's own `krontek-include/HAL/`**.
- ⚠️ **Never commit a compiled agent** — `go build ./...` in `host-agent/` writes `kron-host-agent[.exe]` there; expected, gitignored.
- **Tests:** `cd host-agent && go test ./...`, `cd hotswaplib && go test ./...`, `cd server && go test ./...` (**Linux only** — on macOS use `GOOS=linux go vet ./... && GOOS=linux go test -c -o /dev/null .`), plus `cd ApiSamples && python3 -m unittest discover -p 'test_*.py'` (offline, no device). ⚠️ These are the only checked-in verification — the two `experiments/` gates are gitignored (`src/services/CLAUDE.md`).
- **Version = `package.json` `"version"`, never hardcoded:** Vite injects `__APP_VERSION__` → `src/version.js`; the agent gets `-ldflags "-X main.appVersion=…"` (`go run .` shows `dev`).
- **Toolchains are per-host, sysroots shared**, so Windows clang cross-compiles to the Linux targets. ⚠️ `GOOS=windows` and `GOOS=darwin GOARCH=arm64` builds of the host agent must keep succeeding.
- ⚠️ **Deploying is TWO steps** — Build & Send ships only the runtime; anything new in KronServer needs `server/build.sh` + Deploy Server to Target, or the target answers with the old agent.

## Cross-cutting invariants
⚠️ **Four IEC type tables must stay in sync** (`CTranspilerService.js`): `IEC_TYPE_SIZES` (missing → no SHM slot, invisible to KronServer/REST) · `IEC_TO_SERVER_TYPE` (wrong signedness corrupts HMI/REST) · `IEC_TO_KRON_TYPE` (`X_TO_Y` loses precision) · `IEC_CAST_C` (also update the type-name regex). Hand-mirrored in `agentTools.js SCALAR_IEC_TYPES` and `iecAddress.js IEC_TYPE_PREFIX` (`src/CLAUDE.md`).

⚠️ **TIME/LTIME are `int64_t` MICROseconds everywhere** — headers, transpiler, shm slot (8 bytes), `%ML` address, KronServer decoding. A unit or width change has to be grepped through all of them, formatters included.

⚠️ **IEC identifiers are CASE-INSENSITIVE** (`src/utils/iecNames.js`). Names resolve through a lowercase map behind a `/gi` regex, so `var0` matches a declared `Var0`. **Every editor-side comparison of a typed name against a declared one must use the shared helpers** — `liveGet`/`liveResolveKey`/`memberGet`/`liveEntriesWithPrefix` for live keys, `findVarByName`/`hasVarNamed` for the list; **never `liveVariables[key]` or `.find(v => v.name === typed)`**. Exact compares caused a live blackout and duplicate-variable corruption (two `PlcState` fields, one collapsed name, ladder and ST on **different storage**). ⚠️ A force-write addresses its slot **by key** → `liveResolveKey`.

⚠️ **Writers never touch a slot or a flag — they post to the FORCE-WRITE MAILBOX** (SHM layout v2, `[61440,65536)`, contract in `RING_FORMAT.md` § Variable segment; Go writer `hotswaplib/shmcmd`, shared by BOTH agents; consumer `generateShmMailbox` at the start of every `plc_shm_pull`). The old slot-then-flag write raced `plc_shm_sync` and pinned the OLD value while returning 200. Success = the runtime's ACK with `status==applied`; a timed-out writer CASes the entry to cancelled so it is **never applied late** (504). Ops FORCE/PULSE/UNFORCE/CLEAR_ALL — Pulse works on a remote PLC too. The flag byte is **runtime-owned**: `0` or `0x81` FORCED (re-injected from `__plc_fv`, not the slot); any other value is a v1 writer, cleared and counted. Slots are naturally aligned and copied with one atomic of their width (no torn LREAL). ⚠️ The C codegen, `shmcmd` and `RING_FORMAT.md` change together.

⚠️ **`getBoardFamilyDefine` exists in THREE files, keep them identical:** `utils/devicePortMapping.js`, `services/CTranspilerService.js`, `utils/deviceCodegen.js`. A prefix added to one but not the others silently breaks codegen.

⚠️ **Every supported board runs Linux — there is no bare-metal family.** `rpi_pico*`/`HAL_BOARD_FAMILY_PICO` were removed because the whole product (KronServer, shm IPC, SocketCAN, sysfs PWM, `dlopen`) assumes a Linux userspace; don't add one back without a real bare-metal runtime.

## Security model
⚠️ **Both agents origin-gate every request** (host-agent `isAllowedOrigin`, KronServer `isAllowedCORSOrigin`): a request *with* an `Origin` is allowed only from local/private ones (localhost, `.local`, loopback, RFC1918/ULA, link-local), reflected with `Vary: Origin` — never `*`. Disallowed origins get **403 without processing on all methods**, not just preflight; requests **without** an Origin (curl, connect-web) pass unchanged. This stops a website driving the agent (file R/W, compile/exec, KronServer's unauthenticated `/deploy/*` running a binary as root). A new listener (e.g. an HMI port) must not weaken this — matching `Origin` against the request's own `Host` is defeated by DNS rebinding.
- ⚠️ **shm modes are `0600` (hot-swap) / `0660` (transpiler, = KronServer + ring), never `0666`** — same-machine trust still shouldn't hand every live variable to any local account, and the target runtime is root.
- Trust model = same machine / trusted LAN: deploy endpoints are unauthenticated by design; a shared secret on `/deploy/*` is the next step if that widens. Agent-side details: `host-agent/CLAUDE.md`.

## Standards: open the spec
⚠️ **NEVER state what a standard requires from memory — open the spec.** `PLCopen_Motion_Control_Part_1_version_2.0.pdf` is at `~/Documents/KronLibraries/KronMotion/` (outside this repo; `pdftotext -layout` + grep the FB name). Recalled-from-memory PLCopen "rules" have already been wrong in the exact way that costs trust: that `MC_MoveVelocity.Velocity` is always positive with `Direction` carrying the sign — §3.10 says **"Can be a signed value"** and notes *"Negative velocity * negative direction = positive velocity"*, which is what KronMotion implements. Quote the clause and its section, or say you have not checked. The same applies to every claim about what a block "must" have: §3.3/§3.4 give `MC_Stop`/`MC_Halt` only `Execute`/`Deceleration`/`Jerk` (+`BufferMode`) — no Acceleration, which is why demanding one was non-conformant. Same for IEC 61131-3 and ETG (EtherCAT) behaviour.
