# KronEditor — Architecture & Coding Reference

Browser-based **IEC 61131-3 PLC editor**: draw Ladder (LD) / write Structured Text (ST) → transpile to C → compile with a bundled clang → run a local simulation or deploy to a Linux SBC running KronServer.

> ⚠️ **HARD LIMIT: keep this file under 50 000 characters** (`wc -c CLAUDE.md`) — it loads into context every session. Adding a rule means compressing or deleting an equally sized one, never appending: write the *rule* + a few words of *why*, and put deep detail in a sub-reference ([`docs/PLC_AGENT.md`](docs/PLC_AGENT.md), [`packaging/README.md`](packaging/README.md), [`server/RING_FORMAT.md`](server/RING_FORMAT.md)). Long-form pre-2026-08 version: `git show be0f9b8:CLAUDE.md`.

⚠️ = depends on this; breaks silently.

## 1. Rules for contributors
- Code, comments, identifiers and string literals are **English only**.
- **Headers live in ONE place:** `resources/krontek-include/` (incl. `HAL/`). No per-triple `include/` copies — drift was a recurring bug. If `KrontekLibraries/` exists locally it is the source of truth for `.c`; mirror `.h` changes into `krontek-include/`.
- **Never generate `.a` archives** — only `.c`/`.h`. Building/deploying the per-triple `.a` is the user's job.
- **Ask before large or ambiguous changes** — before implementing, not after.
- **Keep this file current and under 50k** — record durable, surprising findings in the same turn, traded against existing text. Never session state or what the code already says.

## 2. Stack & processes
| Process | Role |
|---|---|
| Frontend (React/Vite, ReactFlow for LD, Monaco for ST) | editor UI in a browser tab |
| Host agent `host-agent/` (Go, **`:7171`**) | file I/O, clang, sim spawn + variable reads, SSE, deploy; embeds the Vite build (`embed.FS`) |
| KronServer `server/` (Go, on the SBC) | receives the runtime; lifecycle, shm IPC, HMI + REST |

Simulation = a binary spawned by the host agent; variables via `/dev/shm` (hot-swap, default) or `/proc/<pid>/mem` (legacy plain sim); live values stream over SSE.

**Tauri was removed:** `invoke()` → `host.<method>()` (`HostClient.js`), events → SSE, fs/dialog/clipboard → `browserFs.js` + `navigator.clipboard`. Only `ec_request_state` is still a 501 stub (needs a CGO bridge to SOEM).

**`deploy_server_to_target`** (`deploy_ssh.go`): SFTP the prebuilt `plc-agent` to `<home>/plc/plc-agent`, install a supervisor (systemd unit, else a cron `@reboot` loop), start, poll `:7070/status`. SSE topic `server-deploy-progress`.
- Auth tries `ssh.Password` **AND** `ssh.KeyboardInteractive` (same password) — PAM-only servers offer only the latter.
- ⚠️ Host keys are TOFU (`AppDataDir/known_hosts`) but a **changed key is auto-retrusted** — deliberate, no MITM protection; discuss before changing.
- ⚠️ **`serverBinaryForBoard` maps board-id prefix → server arch** (aarch64 prefixes → `_arm64`, `bb_` → `_armv7`, default amd64); a new aarch64 family must be added or deploy ships the wrong arch.
- ⚠️ **Re-run `server/build.sh` after editing `server/`** — it is the only writer of `resources/<triple>/server/`, which the deploy reads.

## 3. Repository layout
```
src/
  App.jsx                  Root state: isRunning, isSimulationMode, liveVariables, project tree
  components/  EditorPane RungEditorNew RungContainer VariableManager ProjectSidebar Toolbox
               OutputPanel BoardConfigPage TaskManager Slave/EtherCATEditor AiAgentPanel
  services/    CTranspilerService.js (ST/LD→C, the compile path) HostClient PLCClient
               LibraryService browserFs agentTools.js (agent action surface)
  utils/       boardDefinitions boardLibraryBlocks devicePortMapping deviceCodegen libraryTree
               stValidation iecNames iecAddress editorScope kronClipboard hwPortVars
host-agent/    main paths files compile runtime hotswap deploy deploy_ssh ai ollama
               anthropic_oauth events embed libraries* hotswaphost/host.c
server/        main server service ipc ipc_ring process auth hmi api hotswap ringsize
               build.sh (→ dist/ AND resources/<triple>/server/) RING_FORMAT.md proto/
hotswaplib/    shared Go module (local-replaced into both go.mod): generations + swap_result
resources/krontek-include/  SINGLE shared header tree (HAL/*.h + kron*.h + soem/), one -I per target
       kronsystem.h  git-TRACKED (like HAL/): static-inline blocks needing no .a — §14
resources/<triple>/  per-arch artifacts ONLY: lib/*.a + server/. No headers.
toolchains/    bundled LLVM + sysroots (~5 GB, gitignored)
public/libraries/*.xml  block definitions;  KrontekLibraries/  SOURCE OF TRUTH for .c/.h
experiments/   transpiler-check/ agent-check/;  docs/PLC_AGENT.md  full agent reference
```

## 4. Dev workflow, versioning, packaging
```
cd host-agent && go run .   # API + embedded frontend :7171
npm run dev                 # Vite :1420, proxies /api/host → :7171
npm run build               # → ./dist-binary/kron-host-agent
```
- ⚠️ **A fresh clone cannot compile** — `toolchains/` and `resources/<triple>/` are gitignored (only `krontek-include/HAL/` + `kronsystem.h` are tracked). `bundled clang not found: toolchains\bin\clang.exe` is `paths.go`'s no-toolchain fallback; `/api/host/health` reports the resolved roots. Fix with `python setup_toolchain.py`, but **keep the repo's own `krontek-include/HAL/`**.
- ⚠️ **Never commit a compiled agent** — `go build ./...` in `host-agent/` writes `kron-host-agent[.exe]` there; expected, gitignored.
- **Version = `package.json` `"version"`, never hardcoded:** Vite injects `__APP_VERSION__` → `src/version.js`; the agent gets `-ldflags "-X main.appVersion=…"` (`go run .` shows `dev`).

**`packaging/`** holds only three scripts + README, each emitting ONE self-contained gitignored artifact beside itself (AppImage, NSIS `.exe`, `.dmg`). **[`packaging/README.md`](packaging/README.md) is the full reference.**
- ⚠️ **`build-mac.sh` must run on a Mac** (hdiutil/codesign/sips) and hard-fails elsewhere; Windows cross-builds on Linux via `makensis`.
- ⚠️ **The macOS artifact is not self-contained** — Apple's SDK can't ship, so local sim resolves it at run time (`paths.go MacOSSDKPath` ← `xcrun`) and needs `xcode-select --install`; Build & Send needs nothing extra.
- **Toolchains are per-host, sysroots shared**, so Windows clang cross-compiles to the Linux targets. ⚠️ `GOOS=windows` and `GOOS=darwin GOARCH=arm64` builds must keep succeeding.
- ⚠️ **Locate the bundled GCC dir by GLOB, not from the compile triple** (`paths.go LLVMGCCInstallDir`, used as `-B`/`-L`): sysroots use a "none" vendor that clang auto-detects for aarch64 but not arm, so every armv7 `-static` build died with `cannot open crtbeginT.o`. Version dirs use `compareVersionStrings` (numeric).

**Build output** `~/.local/share/com.plceditor.app/build/`: `plc.c`/`plc.h`, `kron_hal.h`, **`sim_runtime.bin`** (local sim, `-O0 -g`), **`runtime.bin`** (target/hot-swap, cross, `-O3`), `variables.json`. ⚠️ The two binaries **must not share a name** (§6).

## 5. The transpiler (ST/LD → C)
`src/services/CTranspilerService.js`:
```js
transpileToC(projectStructure, standardHeaders, boardId, simMode, buses=[], busConfigs={})
  → transpilePOUSource(pou, globalVarNames, stdFunctions, interfaceConfig)
    → transpileSTLogics(...) | transpileLDLogics(rungs, blockType, parent, category, varMap)
```
All three call sites in `App.jsx` pass `buses`/`busConfigs` as args 5–6.
**Scoping:** globals → `S->${name}` (no prefix, matched against `globalVarNames[]`); program locals → `S->prog_NAME_${name}`; FB-instance locals → `instance->${name}`. `varMap` is built in `transpilePOUSource`.

⚠️ **INVARIANT — four IEC type tables must stay in sync:** `IEC_TYPE_SIZES` (missing → no SHM slot, invisible to KronServer/REST) · `IEC_TO_SERVER_TYPE` (wrong signedness corrupts HMI/REST) · `IEC_TO_KRON_TYPE` (`X_TO_Y` loses precision) · `IEC_CAST_C` (also update the type-name regex). Hand-mirrored in `agentTools.js SCALAR_IEC_TYPES` and `iecAddress.js IEC_TYPE_PREFIX` (§11).

**Operators:** `:=`→`=`; `AND OR NOT XOR MOD` → `&& || ! ^ %` (**always logical**); `BAND BOR BXOR BNOT` → `& | ^ ~` (**use these for integer masking**); `ABS(x)` is a macro evaluating its arg twice. ⚠️ Not type-aware on AND/OR — integer operands silently give wrong results.

**ST line handling (order matters):**
- ⚠️ **Comments are stripped BEFORE keyword normalization**, else a keyword inside a comment injects a newline that leaks the tail into C. String literals are blanked length-preservingly before scanning (also in `validateCode`).
- ⚠️ **Continuation merge is bidirectional:** a line ending in an operator/`,`/`(` merges forward (`:=` excluded) *and* a line starting with a binary operator merges backward — excluding bare CASE labels and lines ending mid-block. Without the look-back, `x := a * 128\n + b / 2;` lost its second term; test leading-`+`, leading-`AND`, a `-1:` label.
- ⚠️ **String placeholders use `\x01<idx>\x02`** — bare digits would let the restore regex corrupt numeric literals.

⚠️ **The task interval bounds every timer:** a self-resetting TON needs 2 extra scans per half-cycle, so the observed half-period is `PT + 2 × task_interval` (PT=1s on a `T#1s` task toggles every 3.00 s). Keep the interval an order of magnitude below the shortest measured time.
⚠️ `kronstandard.h`'s "TIME is milliseconds" comment is **stale** — TIME is `uint32` **MICROseconds** end-to-end (`mapIECtoTimeUs` → `us_tick` → `TON_Call`).
⚠️ **Task assignment is STRICT:** a program runs only if explicitly assigned to a task — no fallback. Unassigned code is generated but never called (the transpiler warns, `handleToggleSimulation` surfaces it); zero tasks → nothing runs.

**LD:** `rung.blocks[i].type / data.subType / data.values`; `rung.connections[i].sourcePin/targetPin` (`out`/`in`, or `out_0`/`in_1` for FBs). Globals never get `prog_`. FB trigger pin `in_0`/`in` = power flow, `in_1`+ = separate assignments; SR trigger → `.S1`, RS → `.S`. Constants: `FB_TRIGGER_PIN`, `FB_Q_OUTPUT`, `FB_INPUTS`, `FB_OUTPUTS`, `FB_INPUT_TYPES`.
- **LIMIT/MUX emit by argument NAME, not position** (`KRON_LIMIT(MN,IN,MX)`; a 2-input `MUX` becomes a ternary).
- **Rising/Falling contacts and coils have real edge memory** — a persistent BOOL per block, so they do affect `plc_state_layout_hash`.
- **TIME pins:** only `T#…` literals go through `mapIECtoTimeUs` (**throws** on an unparseable literal); variables pass through `transformExpr`. `0b/0o/16#` parse in `resolveVal`; malformed tokens return null rather than leaking into C.

**Arrays & SHM:** a C array is sized **`[max+1]`** (not `[max-min+1]`) so raw IEC indices stay valid with lower bound > 0; ⚠️ negative lower bounds and `upper < lower` are rejected. Data grows from 0, force flags from `FORCE_FLAGS_BASE` (32768), segment 65536; ⚠️ the transpiler **throws** if either region overruns. Struct-member debug offsets use **natural C alignment**.
⚠️ **`resolveVarsInExpr` is single-pass** (one alternation regex + callback, skipping matches preceded by `.`/`->`) — a longest-first repeated `replace` corrupted expressions for variables named `s`/`q`/`instance` by rewriting the `S` in `S->`.
⚠️ **exec-time is MICROseconds** (`__exec_us_<prog>`); when changing a unit, grep the FORMATTERS too — `fmtExecNs` survived the ns→µs migration.

**Gates:** `experiments/transpiler-check/compile-gate.sh` (**run after transpiler changes**) and `experiments/agent-check/gate.sh` (§8).

## 6. Simulation, hot-swap & PlcState
**PlcState:** the transpiler always emits ONE struct holding all mutable state (globals, program locals, FB instances, shadow vars, edge memory, exec-time), reached via file-scope `static PlcState *S`; FB-locals stay `instance->…`. Non-zero initials go to `plc_state_init()`.
- ⚠️ **`__plc_state` must have EXTERNAL linkage in the non-hot-swap build** (`#ifdef PLC_HOTSWAP` keeps it static; the host owns state there) — as static under `-O3`, SROA dissolves it and the DWARF read finds nothing. The sim therefore builds `-O0 -g`; `compileForTarget` stays `-O3`.
- ⚠️ **Filename separation:** local sim = `sim_runtime.bin`, target/hot-swap = `runtime.bin`. Sharing a name let a Build & Send clobber the sim with a wrong-arch, no-DWARF binary.

### Hot-swap — the DEFAULT simulation runtime
A stable **loader-host** owns `PlcState` + the shm mirror + timing + scan threads; a swappable **`logic.so`** holds POU logic. `-DPLC_HOTSWAP` turns the same `plc.c` into the `.so` behind a fixed ABI (`plc_state_size`, `plc_bind`, `plc_task_body_<i>`, `plc_state_layout_hash`, …). On `SIGUSR1` the loader-host (`hotswaphost/host.c`) parks task threads on a scan-boundary barrier, `dlclose`+`dlopen`s, re-binds the SAME `PlcState`, and **rolls back** on failure.

**Generations — bounded 2-slot ping-pong** (`hotswaplib/`):
- ⚠️ Exactly two slots `logic_0.so` ↔ `logic_1.so`; each swap targets the slot **not** running (`PingPongGeneration(confirmedGen)`) so numbers never grow (`NextGeneration` = highest+1 is deprecated). `CleanupExcept` deletes the other only after a confirmed `OK`.
- ⚠️ **Slot writes must be atomic** (names are reused): `.tmp` + rename gives a fresh inode, so an `mmap`'d `.so` is never truncated in place.
- ⚠️ **`plc_state_layout_hash()`** (FNV-1a over the `stateFields` *shape*) is the hard safety net — host.c refuses+rolls back any swap whose hash differs from the one captured at the first cold-start bind (always the ORIGINAL, so drift can't accumulate).
- **`layoutSignature(...)`** (App.jsx) is the fast UX pre-check over `{task, variables, udts, blocks, ioEc}`; `blocks` = `stateBlocksSignature` covers every FB-style ladder block (shadow fields exist per BLOCK, not per declared variable) plus edge contacts/coils. ⚠️ `variableTableSignature` must read POU locals from **`p.content?.variables`**, not the legacy `p.variables`.
- **On a refused layout change the sim offers a rebuild+restart** (`offerSimRestart`), while the field path stays warn-only. ⚠️ **Carry real state ONLY** — bare locals/globals + FB struct members; **skip** `__exec_us`, composites and **`in_`/`out_` pin shadows** (`in_` holds the source's pin literal, so carrying it reverts a pin edit).

⚠️ **The force-flag byte has THREE values:** `0` normal · `1` **FORCE** (re-injected every scan, pinned) · `2` **PULSE** (one-shot — `plc_shm_pull` applies it then clears to 0, so logic resumes the same scan). Emitted by BOTH `plc_shm_pull` sites; `plc_shm_sync` writes PlcState→shm only for flag 0. Pulse is offered only for the local hot-swap sim — a **remote PLC always force-writes**.

**HAL-to-host:** HAL functions are `static inline` over file-scope `static` fd arrays, so hot-swap mode emits `#define F __hs_F` trampolines (`host_glue.c`) compiled into the host — HAL + fds survive swaps.
**Known gaps:** EtherCAT/motion aren't trampolined (full redeploy); a `sudo -n`-spawned runtime won't get SIGUSR1 (the agent must run as root on target); the local `plc_host` cache key is a **content hash** so a HAL or link-flag change rebuilds it; a live swap on **physical hardware** is unverified.

### Windows & macOS simulation ⚠️
Both run the SAME hot-swap runtime; only the legacy plain sim is Linux-only. **Scan structure, ping-pong, swap protocol and force flags have exactly one implementation — keep it that way.**

| | Linux | Windows | macOS |
|---|---|---|---|
| mirror | `shm_open`+`mmap` in `/dev/shm` | `CreateFileMapping`, `Local\plc_runtime` | `mmap` on a real file `<buildDir>/plc_runtime.mirror` |
| module | `-shared` vs `-rdynamic` host | DLL + `plc_host.lib` import lib | `-bundle -bundle_loader plc_host` |
| swap signal | `SIGUSR1` | auto-reset Event `Local\kron_plc_swap` | `SIGUSR1` |
| sleep | `clock_nanosleep(ABSTIME)` | waitable timer | `mach_wait_until` |
| barrier | `pthread_barrier_*` | winpthreads | mutex+condvar shim, same names |

- ⚠️ **The agent OPENS the mirror and event; the loader-host CREATES both** — a Win32 section/event lives only while a handle is open, and an auto-reset event would silently latch an early swap signal.
- ⚠️ **Neither a PE DLL nor a Mach-O bundle resolves symbols from its loader** the way ELF does, so the host exports an import library (Windows) / is passed as `-bundle_loader` (macOS) — that keeps `__hs_*`, `us_tick`, `plc_stop`, `__plc_shm` in the host across a swap, and makes the loader-host a build-order prerequisite.
- ⚠️ **Windows locks a LOADED module's file** — the ping-pong handles it; **do not "simplify" to a single slot**. Slot files keep the `logic_<n>.so` name everywhere (a slot id, not a format claim).
- ⚠️ **Timing primitives lie by default:** winpthreads' `clock_nanosleep(ABSTIME)` doesn't block (a 10 ms task ran ~6 M times/s) and macOS has none, with `mach_timebase_info` not 1/1 on Apple Silicon; both compute a relative delta from the same absolute deadline, accumulated in **64-bit** (mingw's `tv_nsec` is 32-bit, so an interval ≥ ~2.148 s overflowed negative).
- ⚠️ **Host AND logic must link `-static` on Windows** (`windowsStaticRuntimeFlag` in both `compileHost` and `compileLogic`) — the linker prefers `libwinpthread.dll.a`, and the missing DLL surfaces only as "cold-start outcome unknown" / `LoadLibraryA` error 126.
- ⚠️ **Every cold-start failure path in host.c's `main` must `write_swap_result` before returning** — that file is the supervisor's only channel. Sample `exited(done)`/`ProcessState` **before** `Stop()` (which kills then waits) or a genuine timeout reads as `exited (signal: killed)`.
- ⚠️ **`pthread_barrier_*` was never implemented by Apple** — host.c has a **phase-counted** mutex+condvar shim under the standard names (do NOT fork the scan loop); phase counting stops a fast thread lapping into the next round.
- ⚠️ **macOS has no `/dev/shm`** (a `shm_open`'d object is invisible to the filesystem), so the mirror is a plain file — host.c's `mirror_path()` and `shmmirror_darwin.go`'s `mirrorPath()` must change together or every live value freezes at zero. `-lrt`/`-ldl` don't exist there, and the Mach-O link uses the **system linker, not lld**.
- ⚠️ **`__APPLE__` must stay in the transpiler's shm guard** — the hot-swap build needs the `extern __plc_shm` declaration and the `plc_shm_name`/`plc_shm_size` exports, or the sim runs fine with no live values and dead force-writes.
- ⚠️ Windows is verified under wine64 **and** on real Windows (two bugs appeared only on the latter); **macOS is unverified on real hardware**.

**Re-attach after a browser reload:** `GET /api/host/sim-status` → `{running, pid, mode}`, and an effect guarded by `simReattachedRef` restores the flags plus `hotSwapActiveRef`/`taskSigRef`. ⚠️ For a **remote** PLC the 3 s `checkStatus` poll starts the SSE **unconditionally** — `remoteVarKeysRef` is only set by Build & Send in the same session.
⚠️ **Liveness is `PLCClient.isStreamHealthy` (last event < 5 s), NEVER `isStreaming`** — EventSource retries a dead host forever with readyState stuck at CONNECTING, so a powered-off target stayed **Connected/Running** with frozen values; 2 failed polls now drop the stream+client and clear `isRunning`.

## 7. Frontend architecture
⚠️ **Unified rung-based POU model.** Every program/FB/function is a **list of rungs**, each authored in LD or ST; `SCL` IS this model and is the **only** type the UI creates (`content:{rungs, variables}`), with `normalizePouToRungs` folding legacy `ST`/`LD` POUs on load. The transpiler dispatches on `pou.type` and handles `SCL` per rung, so an all-LD unified POU produces identical codegen to a legacy `LD` POU. **Do not reintroduce a create-time language picker** — language is per rung.

**Rung UX (`RungEditorNew.jsx`):** the rung header's language pill is a `convertRungLang` button. ⚠️ **Inline declaration (LD):** committing a block whose name isn't declared auto-creates it (contacts/coils → BOOL, FB → an instance of that type) as `class:'Local'` in the same history step.
- ⚠️ **Pin datalists for the families** (`ANY_NUM/ANY_INT/…`) are **always rendered even when empty** — a missing datalist id silently kills autocomplete. `POLY_NUM_BLOCKS` narrows pin `type` for display but sets **`suggestType:'ANY_NUM'`**, which `getPinSuggestionList` prefers, so a literal in IN1 doesn't collapse the other pins.

**Read-only mode (`isRunning`)** disables `VariableManager`, sidebar edits and `ResourceEditor`, but **logic editors are additionally gated by `allowLiveEdit`** (= `(isRunning && isHotSwap) || fieldHotSwap`), so a live hot-swap allows online ST/ladder editing while layout-owning editors stay locked. Editing while running sets `pendingOnlineChange`, surfacing **"Hot Reload"**. ⚠️ LD auto-declare can add a variable during live edit — allowed in the editor, refused at Hot Reload.
**Sim while connected:** local sim and a remote PLC coexist, and **Build & Send is NOT disabled during a run** — it `window.confirm`s instead, since it recompiles + RESTARTS (state lost).

⚠️ **INVARIANT — IEC identifiers are CASE-INSENSITIVE** (`src/utils/iecNames.js`). Names resolve through a lowercase map behind a `/gi` regex, so `var0` matches a declared `Var0`. **Every editor-side comparison of a typed name against a declared one must use the shared helpers** — `liveGet`/`liveResolveKey`/`memberGet`/`liveEntriesWithPrefix` for live keys, `findVarByName`/`hasVarNamed` for the list; **never `liveVariables[key]` or `.find(v => v.name === typed)`**. Exact compares caused a silent live blackout and duplicate-variable corruption (two `PlcState` fields, one collapsed name, ladder and ST on **different storage**). ⚠️ A force-write addresses its slot **by key** → `liveResolveKey`.

⚠️ **FB outputs have two representations and the overlay handles both:** the local sim reads the struct via DWARF as an object at `prog_X_blink`; target/hot-swap streams FLAT keys `prog_X_<var>.<pin>` by SHM offset (each scalar OUTPUT pin is its own slot). Needs a re-Build&Send.

**Rung geometry ⚠️:** `MIDDLE_Y` is **FIXED at `MIN_RUNG_HEIGHT/2`** — never proportional to the dynamic `RUNG_HEIGHT`, or the rail dots move whenever a rung grows. The `[10,10]` grid can't land a contact's handle on `MIDDLE_Y`, so `powerHandleOffsetY(nodeId)` measures it from the DOM and drag/drop snap to `MIDDLE_Y - offset`. ⚠️ **Agent-authored blocks never take the drop path**, so they inline the same arithmetic (`LD_*` constants in `agentTools.js`) — **if `RungContainer` geometry changes, these follow**; `insertBlock`/`addBlockToRung` **return the block id** for the snap.

**RungContainer performance ⚠️:** never put `liveVariables` in `mapBlocksToNodes` deps (rebuilds every node every 500 ms — use a separate effect touching only `n.data.liveVariables`); `useMemo` `varsByType`/`dtMap`/`allRawVars`; `isValidConnection` resolves handles **by name**, not index.

**Undo/redo:** the project tree covers sidebar structural ops via `undoHistoryRef={past,future}` (cap 50), gated on `getEditorScope()` being SIDEBAR/null. The LD editor keeps `{rungs, variables}` pairs: ⚠️ **every mutation must call `saveHistory(newRungs, newVariables)` with both**, ⚠️ **outside** setState updaters (inside double-counts under StrictMode).

⚠️ **Focus guards:** every global keydown handler (undo/redo, Space-toggle, Ctrl+X, clipboard) must bail on `INPUT`/`TEXTAREA`/`isContentEditable`/inside `.monaco-editor` — a tagName-only check misses the inline ST editor — **and a global Ctrl+C must ALSO bail on `hasTextSelection()`**, since selecting text in a plain `<div>` leaves focus on `<body>` and the handler replaced the selection with a copied POU.

⚠️ **Monaco:** both mounts use **`defaultValue` (uncontrolled)** + a position-preserving sync effect, NOT `value={code}` — the controlled path calls `setValue()` on every parent re-render and jerks the caret to (1,1). The EditorPane effect **skips its first run** so opening a POU doesn't mark the project unsaved.


## 8. The AI agent panel
**[`docs/PLC_AGENT.md`](docs/PLC_AGENT.md) is the full reference** — architecture, tool reference, ladder DSL, provider matrix, prompt policies, loop hardening. Keep it updated instead of growing this section.

`AiAgentPanel.jsx` is a tool-calling agent ("PLC Agent") that edits the project; config in `localStorage["aiAgentConfig"]`. Three layers: **`ai.go`** (provider-agnostic proxy at `POST /api/host/ai/chat`), **`anthropic_oauth.go`** (Claude subscription sign-in), **`agentTools.js`** (the pure executor `applyToolCall`, never mutating in place).

Cross-cutting rules:
- ⚠️ **`baseUrl` is honored ONLY by `custom`** — one shared config field, so a leftover value redirected every named provider *and* leaked its API key there; `switchProvider` must not carry credentials across providers.
- ⚠️ **The model picker reads a LIVE catalogue** (`POST /api/host/ai/models`); `PROVIDERS[].models` is only the offline fallback — never "fix" a stale picker by editing it.
- ⚠️ **The Model field is a `<select>`, never a free-text combo** (as a combo, filter and selection shared one input so only the current model was reachable); a saved-but-unlisted model is prepended, an empty list falls back to a text input.
- ⚠️ **Anthropic prompt caching:** `buildSystemPrompt` must stay **stable**; volatile project state rides the separate `context` field, appended AFTER the `cache_control` breakpoints — caching is a byte-exact prefix match. That `context` also carries the **run-state line**, the ONLY thing telling the model a program is running (tool schemas just describe how to ask): without it a weak model invents "nothing is running" while a target streams. Live reads use `liveRef`/`liveBufRef`, never `runTurn`'s frozen `liveVariables` closure.
- ⚠️ **`parseArgs` MUST return a copy** — the loop enriches args in place (`__library`, `__live`, …) and once wrote a 47 KB catalog into history twice in one turn.
- ⚠️ **Never present a locally recovered tool call to a provider** — text-mining recovery runs only for `ollama`/`custom`, tags calls `_synth: true`, and `providerSafeMessages` strips them (rewriting their `tool` results too, since an orphaned `tool` message is a 400).
- ⚠️ **A dead turn (no text, no tool calls) must never reach the transcript** — it serialized as an empty text block and 400'd *every* later message, bricking the conversation.
- ⚠️ **Truncation is the other dead-turn source:** `defaultMaxTokens` is **32000** (thinking tokens bill against it); a max_tokens/length finish **discards the turn and fails loudly**, since a tool call cut mid-arguments comes back partially parsed and looks well-formed.
- ⚠️ **`aiToolCall.Extra` round-trips the provider's opaque per-call blob verbatim** (Gemini's `thought_signature`) — never parse or synthesize it.
- ⚠️ **No compile/build tool, deliberately** — `check_compile` made every edit pay clang's cold load.
- ⚠️ **A clarifying question is the `ask_user` TOOL, never prose** (a text-only turn ends the loop); it is intercepted before the executor and must return a result for **every** `tool_call_id` in the turn.
- ⚠️ **Stop is generation-based** (`runGenRef`), not just `abort()` — the loop recurses between turns with no request in flight. The Stop control lives in the **input bar**, and `resolvePending` must re-arm the run state.
- ⚠️ **Types go through `resolveVarType`** — a scalar, a standard FB type (`STANDARD_FB_TYPES` = the transpiler's exported `FB_OUTPUTS` minus `EN`-trigger inline ops), an existing data-type/POU name, or once-only `ARRAY[m..n] OF TYPE`.
- ⚠️ **`set_ladder` validates contact/coil targets and fails loudly** (valid IEC name, BOOL if declared, unknown `subType` errors instead of falling back, comparisons route to ST) — a bad rung must never compile into a plausible wrong program. `add_variable` refuses a local that shadows a global.
- ⚠️ **On an SCL POU each authoring tool owns ONLY its own language's rungs**, or one deletes the other's work.
- ⚠️ **Wiring tables (`FB_TRIGGER_PIN`, `FB_Q_OUTPUT`, `powerPins()`) are exported from the transpiler — never hand-copy them.** Run **`experiments/agent-check/gate.sh`** after touching the ladder DSL or the LD path.


## 9. Board support (adding an SBC)
Boards group into **display families** (`BOARD_FAMILIES`) and, separately, **HAL families** (by ID prefix, deciding HAL header, triple, device paths, server binary).
- ⚠️ **INVARIANT — `getBoardFamilyDefine` exists in THREE files, keep them identical:** `utils/devicePortMapping.js`, `services/CTranspilerService.js`, `utils/deviceCodegen.js`. A prefix added to one but not the others silently breaks codegen.
- ⚠️ **Every supported board runs Linux — there is no bare-metal family.** `rpi_pico*`/`HAL_BOARD_FAMILY_PICO` were removed because the whole product (KronServer, shm IPC, SocketCAN, sysfs PWM, `dlopen`) assumes a Linux userspace; don't add one back without a real bare-metal runtime.

HAL families: `..._RPI` (Pi + all generic-Linux SBCs, aarch64) · `..._BB` (BeagleBone; `bb_ai64` aarch64, rest armv7) · `..._JETSON` (aarch64), each with its own `kronhal_*.h`.
**Generic-Linux SBCs reuse the RPi HAL** (standard gpiod, `/dev/i2c-*`, `/dev/spidev*`, `/dev/tty*`): `opi_`, `radxa_`, `odroid_`, `bpi_`, `libre_`, `pine_` — 12 aarch64 boards with their own display family but mapping to `HAL_BOARD_FAMILY_RPI`, so no new HAL, triple or server binary. ⚠️ They inherit the RPi `BOARD_PORT_DETAILS`, functional defaults that differ per SoC, so users override per port.

⚠️ **Device-node overrides (UART+I2C+USB) reach the HAL** via `buildRuntimePortHelpers`, emitting `#define KRON_UART<n>/KRON_I2C<n>/KRON_USB<n>` *before* `kron_hal.h` from `content.deviceInterfaceConfig`; SPI has no override.
- ⚠️ **The USB override is gated on the port being ENABLED — UART/I2C are not.** The input renders only for an enabled port, and there is **no `KRON_USB_PortEnabled` gate in the HAL**, so this emission guard is the only thing stopping an invisible stale path from redirecting a channel.
- ⚠️ **USB channel → default path is NOT `USB<n>` → `/dev/ttyUSB<n>`:** Jetson/RPi map USB0/1 → `ttyUSB0/1`, **USB2/3 → `/dev/ttyACM0/1`**, USB4 → `ttyUSB2`. Prefer a stable `/dev/serial/by-id/…` name — `ttyUSB<n>` numbering moves across reboots, and `_usb_open` doesn't cache a failed open so a late udev symlink self-heals.
- The I2C **clock-Hz field is decorative** (Linux i2c-dev can't change bus speed at runtime); only the SPI clock is real.

**Checklist — aarch64 SBC in an existing family:** add the board object to a `BOARD_FAMILIES` family (reusing `GENERIC_40PIN_HEADER`), then add `BOARD_CHANNELS[id]` — ⚠️ **a key here MINTS BLOCKS in the toolbox**, so omit `CAN`/`ADC` rather than guessing (`jetson_nano` claimed `CAN:1`, but Tegra X1 has none). Nothing else if the prefix already maps to a HAL family.
**A new vendor prefix** also goes in all three `getBoardFamilyDefine`, in `serverBinaryForBoard`'s aarch64 list, in `LINUX_BOARD_FAMILIES` (only if a genuinely new HAL family) and in `boardIcon()`. **A new HAL family** additionally needs `kronhal_<family>.h`, a `compile.go` triple case, and a server binary.

## 10. HAL pattern
Every hardware block = **struct + `_Call`**: hardware struct `HAL_UART_Send`, generic struct (in transpiled C) `UART_Send`, channel dispatch `UART0_Send_Call(inst)` → `HAL_UART_Send_Call(inst, 0)`. The runtime header is `krontek-include/HAL/kronhal.h`.

⚠️ **A missing peripheral must FAIL, never fake success** — every `_Call` that can't do its job sets `ERR_ID` and leaves output false/zero (`/* TODO */` bodies returning `DONE = EN` were indistinguishable from a working read). `0`=OK, `1`=absent/invalid channel, `2`=open failed, `3`=I/O error. ADC is IIO on RPI/BB and **`ERR_ID=1` on Jetson**; CAN is SocketCAN (interface must already be up); PRU/PCM/Grove/DI/DO are `ERR_ID=1`.
- ⚠️ **PWM channels are FLATTENED ACROSS pwmchips**, never "the first chip with enough channels" — generic SBCs sharing `kronhal_rpi.h` publish one pwmchip **per PWM cell**, so the old probe matched nothing and PWM was dead on all 12. Chips are collected, **sorted by index** (readdir isn't sorted) and their `npwm` concatenated.
- ⚠️ **`HAL_Init` must set the PWM fd arrays to `-1`** — every check is `fd >= 0`, so a static-zero fd makes `HAL_Cleanup` **close stdin**.
- ⚠️ **KNOWN GAP — GPIO pin numbering is Raspberry-Pi-specific on the 12 generic boards.** `_RPI_PHYS_TO_BCM` maps physical pin → BCM line and `GENERIC_40PIN_HEADER` is literally `RPI_40PIN_HEADER`, but Rockchip/Amlogic numbering differs, so a GPIO block there **silently drives a different pad**; device-node peripherals are unaffected.
- ⚠️ **Jetson `_JETSON_PHYS_TO_LINE` must hold the runtime indices from `gpioinfo /dev/gpiochip0`**, not the `TEGRA234_MAIN_GPIO(port,bit)` DT macro values — on Orin the macro exceeded the chip's line count and every request failed silently.

**Adding/removing a pin on a standard FB — four locations:** the header struct field, the `<pin>` in the XML (LD UI), `FB_INPUTS[type]` (ordered, pre-call assignment), `FB_OUTPUTS[type]` (shadow-var decl + write-back). `FB_OUTPUTS` is the single source of truth — an unlisted pin gets no shadow var and no write-back.

## 11. KronServer (target agent)
`server/`, cross-compiled by `server/build.sh` into `dist/` **and** `resources/<triple>/server/`. Go, static (`CGO_ENABLED=0`), ConnectRPC + protobuf, `mmap` on `/dev/shm`.
**RPC:** `Start` · `Stop` (SIGTERM 5 s → SIGKILL) · `WriteVar` · `ClearAllForces` · `StreamVars` (50 ms).
**HTTP:** `/deploy/runtime` (128 MB, atomic) · `/deploy/variable-table` · `/deploy/project-file` (⚠️ Build & Send POSTs it as a strict step, so an **older deployed KronServer without it breaks Build & Send**) · `/deploy/logic` · `GET /status` · `GET /stream/vars`.
- ⚠️ **Variable-table offsets are validated at load** (`Offset >= 0 && Size > 0 && Offset <= shmSize-Size`, same for `ForceFlagOffset`) — a corrupt table would otherwise panic via `WriteInitialValues` and crash-loop the agent forever.
- ⚠️ **`intentionalStop` is reset in `Start()`** and set by `Stop()` only when something runs, else a manual Stop suppresses the next crash event + AutoRun respawn.
- ⚠️ **`WriteInitialValues` runs via a `preStartHook`** — after the old process stops, before the new one spawns, so the dying runtime's shm sync can't clobber the initials.

**HMI & auth:** 4-tier RBAC, SHA-256 salted passwords, 64-byte tokens (8 h), HttpOnly+SameSite=Lax, constant-time compares. ⚠️ Reflected values are HTML-escaped and JS-literal-encoded (was an XSS); `/hmi/api/write` is restricted to addressed variables, Operator+. The UI is served under **`/hmi/`** and at the **root** of an operator port — ⚠️ handlers are base-aware via `hmiBase(r)`, and a new route without it breaks root serving.

**Addressed variables & REST.** An IEC address in the "Address" column exposes the variable over REST. Prefix per type (`IEC_TYPE_PREFIX`, `utils/iecAddress.js`): BOOL→`%MX{byte}.{bit}`, BYTE/SINT/USINT→`%MB`, INT/UINT/WORD→`%MW`, DINT/UDINT/DWORD/REAL/TIME→`%MD`, 64-bit→`%ML`. The API password is salted into `variable_table.json`; empty = API disabled.
⚠️ **INVARIANT — the prefix MUST agree with the type; nothing downstream re-derives it.** An address is a width *claim* but only a label to the runtime (which addresses by `Offset`/`Size` from the TYPE), so a mismatch **never fails anywhere** — it surfaces in the field when SCADA reads a word where a bit was published. `iecAddress.js` is the single rule, applied by **VariableManager** (⚠️ type + address must land in **ONE** update, hence the object patch in both `handleUpdateVar`s), **`agentTools`** (address resolved *after* the type), and **the transpiler gate** in `transpileToC` — a hard `throw`, the only one covering hand-edited XML.
⚠️ **Only elementary types can be addressed** — debugDefaults expansion hands the SAME address to every element, so an addressed `ARRAY[0..9] OF INT` would publish ten variables claiming one location. Keep `IEC_TYPE_PREFIX` in sync with the four transpiler tables (§5). **Deliberate gaps:** addresses on FB/FUNCTION locals do nothing; duplicates are not a build error.

**REST (`api.go`, Bearer from `POST /api/v1/auth`):** `GET/POST /variables[/{name}]` · `GET /stream` (SSE, addressed only) · `POST /forces/clear` · `GET/POST /runtime[/start|/stop|/config]`.
- ⚠️ KronServer **auto-rehydrates `variable_table.json` on startup**, else the API password would be empty after every reboot; the runtime need not be running for REST to work.
- ⚠️ **`restart` is a transient action flag** — `handleDeployRuntime` only overwrites `runtime.bin` on disk while the running process keeps the old binary in memory, so Build & Send sends `restart: autoRun || isRunning` as its LAST step. `/deploy/config` takes a partial body.

## 12. Security model
⚠️ **Both agents origin-gate every request** (host-agent `isAllowedOrigin`, KronServer `isAllowedCORSOrigin`): a request *with* an `Origin` is allowed only from local/private origins (localhost, `.local`, loopback, RFC1918/ULA, link-local), reflected back with `Vary: Origin` — never `*`. Disallowed origins get **403 without processing on all methods**, not just preflight; requests **without** an Origin (curl, connect-web) pass unchanged. This stops a website driving the agent (file R/W, compile/exec, KronServer's unauthenticated `/deploy/*` running a binary as root).
Also: `build.go` restricts `Compiler` to a bare-name allowlist and rejects `..`/separators in `Output`; both agents set body limits + `ReadHeaderTimeout`. Deploy endpoints stay unauthenticated by design (trust model = same machine / trusted LAN); a shared secret on `/deploy/*` is the next step if that widens.

## 13. EtherCAT & motion
**Motion:** the `MOTION_FB_AXIS_PARAM` set — all `MC_*` blocks call `MC_xxx_Call(&inst, &axisVar)`; `Axis` (AXIS_REF) is not a struct field (skipped in value assignment + null-init). `MC_Power`: trigger `Enable`, Q `Status`; `MC_MoveAbsolute/Relative`: `Execute`/`Done`. All `motion.xml` blocks have `Axis` first.
**Config generation:** `generateEtherCATConfig(buses, busConfigs)` → `KRON_EC_Config` init C; `kron_ec_init`/`kron_ec_close` in PLC_Init/Cleanup, `kron_ec_pdo_read` before `plc_shm_pull` and `kron_ec_pdo_write` after `plc_shm_sync`, per task. Files: `EtherCATEditor.jsx` + `deviceCodegen.js`, `SlaveConfigPage.jsx` + `EsiLibraryService.js`.
- ⚠️ **Axis init uses `S->${axisName}`** (globals are PlcState fields).
- ⚠️ **PDO variable names are excluded from the `S->` mapping** — the transpiler emits `#define ec_X (__gpi_snap->_pi_ec_X)`, so they stay bare identifiers with no `PlcState` field and no SHM slot; mapping them would expand to `S->(__gpi_snap->…)`, a syntax error.
- **Gap:** not hot-swap-trampolined — full redeploy (§6).

## 14. Library system & clipboard
**Blocks are declared in `public/libraries/*.xml`** (`<block type>` + `<inputs>`/`<outputs>` `<pin name type [trigger]>`, grouped in `<category>`) and arranged for the Toolbox by `libraryTree.js`.

⚠️ **An XML block with no C implementation is a PHANTOM — draggable, then unbuildable**, dying at **compile** time with `unknown type name 'X'`; nothing checks the pairing. **Still phantom:** `Log_Data`, `PID_Compact`, `Filter_LowPass`, `Modbus_Master`, `MQTT_Client`, `TSEND`, `TRCV`, `Get_Alarm_State`, `Read_Hardware_ID`. Comparison/math/bitwise/trig/`X_TO_Y` legitimately have no `_Call` (emitted inline).

**Implementing one: `kronsystem.h` is the pattern** — other blocks live in a prebuilt `libkron*.a` and §1 forbids generating `.a`s, so this header holds `static inline` bodies compiled into `plc.c`/`logic.so`. ⚠️ It is the ONE file under `krontek-include/` besides `HAL/` that is **git-tracked**. It carries **25 blocks**: RTC/calendar, scheduling (`Time_Switch`, `Daily_Trigger`, `Astro_Clock`), diagnostics (`Read_Uptime`, `Cycle_Time_Monitor`, `Hour_Meter`, `Watchdog`), Linux-only host health (temp/load/disk, `ERR_ID=1` elsewhere), TIME arithmetic, and `Blink`/`Debounce`/`Gen_Signal` (TIMERS). **Five** things must line up — the XML and a `libraryTree.js` entry (else it never reaches the Toolbox), plus:
1. **The header** — `typedef struct {…} X;` + `static inline void X_Call(X *inst)`; `transpileToC` scans every served `kron*.h` for that shape (**comments included**) and auto-registers it. ⚠️ The parameter list — **which contains the struct type name** — must not hold the literal `TIME`, or the block is taken for a timer and called as `_Call(&inst, us_tick)`. The test is **case-SENSITIVE**: `Read_System_Time`/`Add_T` pass, `TIME_SWITCH`/`ADD_TIME` would not compile.
2. **`FB_TRIGGER_PIN`, `FB_Q_OUTPUT`, `FB_OUTPUTS`, `FB_INPUTS`** + **`FB_INPUT_TYPES`** for non-trigger inputs, pin names exactly as the XML declares.
3. **`SYSTEM_FB_TYPES`** if the trigger pin is `EN` — else `isInlineMathType` calls it stateless inline math: no `PlcState` field, no instance, no codegen branch to land in. Same reason TIME arithmetic is FBs, not inline (that branch dispatches only via `KRON_FN`/`BITWISE_OP`/`MATH_FB_BLOCKS`). ⚠️ Those also avoid the `X_TO_Y` name shape, which `transformExpr` rewrites to `KRON_<src>_TO_<dst>` — resolvable only inside the archive; hence `T_To_Ms`, not `TIME_TO_DINT`.
4. **`SYSTEM_FB_OUTPUT_TYPES`** for EVERY output pin: the generic rules key off pin NAMES and fall through to **BOOL**, so an unlisted `Year`/`TEMP`/`OUT` is silently wrong. (`Read_System_Time.TIME` is a **DINT**, ms since LOCAL midnight — epoch ms wouldn't fit — not an IEC duration.)

⚠️ **Three constraints on the bodies** (the header's own comment block is the long form): `us_tick` is **invisible** inside a `kron*.h` — its extern is emitted *after* `customIncludes` — and its origin is platform-dependent, so blocks read `CLOCK_MONOTONIC` via `__kron_mono_us()`; an FB instance is a PlcState field, **zero-filled with no way to set a non-zero initial**, hence the `__primed` bool instead of a `-1` sentinel; a **Retain**ed instance carries a **stale monotonic timestamp** across a restart, so `Hour_Meter` drops gaps > 10 s rather than booking downtime as run time.

⚠️ **`Log_Data` cannot be a printf** — the agent sets `cmd.Stdout = nil` for the local sim and KronServer writes the target's stdout to a log file with **no endpoint to read it**. Publish diagnostics as **variables** (SHM → SSE/REST/HMI/ring).

**Clipboard (`kronClipboard.js`):** cross-tab copy/paste over `navigator.clipboard` with an in-process fallback; payloads tagged `CLIP_KIND`; handlers scope-gated by `editorScope.js`.
- ⚠️ **The LD editor root MUST use `onMouseDownCapture`** — ReactFlow's node drag `stopPropagation`s a bubble-phase mousedown, so the scope would stay SIDEBAR and Ctrl+C would copy the whole program.
- ⚠️ **Never call `navigator.clipboard.readText()` while OPENING a menu** — Firefox/Safari answer with a native "Paste" chip that hides the app menu until dismissed. Menu builders use `peekClipboard()`/`refreshClipboard()`; **cross-window sync rides a localStorage mirror**, so same-origin windows see each other permission-free.
- **Paste naming differs by kind on purpose:** POUs / data types / local variables keep their name and append `_copy{n}` on collision, but a **global-variable SET** (and globals bundled with a POU) **merges by name** — a same-named global is skipped and addresses dropped, because merging into another project is the point.

## 15. Library builder (Settings → Libraries)
Four developer actions (need `git` + network; they rewrite repo files): **Build Libraries** (`libraries_kron.go`) → headers + one `lib<stem>.a` per source per target; **Build SOEM** / **Build CANopen** (`libraries_deps.go`); **Build Server** (`libraries_server.go`) → `resources/<triple>/server/`. `libraries.go` holds the matrix and shared helpers.

**Matrix (`libraryTargets`):** `x86_64/linux`, `x86_64/win32`, `arm/aarch64`, `arm/armv7`, plus `arm64|x86_64/macos` **only on a Mac** — ⚠️ macOS is host-only (Apple's SDK can't be redistributed).
⚠️ **`kronethercatmaster.h` is included into every generated `plc.c` and always does `#include "soem/soem.h"`**, so **every build needs `krontek-include/soem/soem.h`** — a fresh machine hits "soem.h not found" on its first compile until Build SOEM is run once.

**Rules deliberately changed from the Tauri original:**
- ⚠️ **Headers go to ONE place** — `installKrontekHeaders` must never become a per-target loop (a test asserts no per-target `include/`).
- ⚠️ **Build to staging, install only on success** — the original deleted every header and `.a` up front, so an aborted run left `resources/` stripped.
- ⚠️ **A local `KrontekLibraries/` is NOT written back to** — the original synced the clone onto it, overwriting the local edits §1 makes it source-of-truth for.
- ⚠️ **`runWithTimeout` APPENDS to `cmd.Env`, never resets it** — `runUpdateServer` sets `GOOS`/`GOARCH`/`GOARM`/`CGO_ENABLED=0` first, and resetting silently produces host-arch dynamic binaries shipped to ARM boards.

## 16. Lossless capture ring
`GET /variables` returns only the latest value and `/stream/buffered` server-samples, but a Go ticker tops out ~1–1.5 kHz on an SBC, so a 100 µs task is aliased. The ring delivers EVERY kept scan of the **addressed** variables by flipping to **producer-push**: the PLC scan loop itself appends. ⚠️ **The byte layout is the contract in [`server/RING_FORMAT.md`](server/RING_FORMAT.md)** — the C codegen and `server/ipc_ring.go` must match exactly.

**Producer (`generateMainLoop`):** per addressed SCALAR var, by owning task (**global → the FASTEST task**; unassigned → skipped). After `plc_shm_sync`: read `stride_N`, `if (scan_g++ % N) return;` else `__atomic_fetch_add(write_seq)`, memcpy into `s % nslots`, publish `slot.seq` with a RELEASE store LAST. Wait-free MPSC.
- ⚠️ **Gated `#if defined(__linux__) && !defined(PLC_HOTSWAP)`** (KronServer is the only consumer; a hot-swap `.so` doesn't own this memory) — Windows/macOS sim compiles via no-op stubs, and a "Go Live" project does NOT feed the ring.
- ⚠️ **Segment sizing is KronServer's, not the runtime's, and it MUST hang off `pm.preStartHook`** (`main.go` → `Server.SizeRingSegment`, `ringsize.go`). It `ftruncate`s `<shm>_ring` BEFORE the runtime spawns so the runtime *adopts* the size (it only sizes the segment itself when it finds one smaller than a record) and no env has to survive a `sudo` reset; it bumps `epoch` at init so a re-attached consumer resets its cursor. ⚠️ **`StartRuntime` is only ONE of four spawn paths** — the ConnectRPC `Start` (`service.go`, i.e. **the editor's Run button**), AutoRun at agent startup (`main.go`) and the crash-restart watchdog (`process.go`) all call `pm.Start()` directly. Sizing from `StartRuntime` alone therefore left the Run button producing the runtime's own **1 MiB** fallback — 0.43 s of slack at 100 kHz — while `/status` cheerfully reported the configured size, because it was computed and never applied. `preStartHook` is the single choke point all four share (it already carries `WriteInitialValues`).
- ⚠️ **Size = `min(P × 10 s, RingRAMPercent × MemAvailable)` — the percentage is a CEILING, not the target** (`ringBytesFor`). `P` comes from the deployed variable table (`ringProducedBytesPerSec`, using **`RecordStride`** not `payload_len` — a record occupies a whole slot). Bigger is NOT better and the reason is **latency, not memory**: `/dev/shm` is tmpfs and the producer never initialises slots, so an oversized segment costs no RSS until it fills, but the controller trips on `fill = backlog/nslots`, a *fraction* — at 50 % of 3.4 GiB (76 M slots) a consumer that cannot keep up stays invisible for ~6 minutes while its data goes that stale. 10 s of production absorbs any TCP hiccup and still surfaces sustained overload in ~5 s. `/status` also reports `ring_produced_bytes_per_sec` so the editor divides for the real stall tolerance instead of guessing it from the variable list (the old guess assumed 8 B/var, ignoring the record header → 3× optimistic).
- ⚠️ **The controller's decrease must be MULTIPLICATIVE** (`api_ring.go`, `n -= n/10`). Growth doubles, so an additive `n--` per 100 ms tick could not undo it: a burst to `N=2048` needed 2047 ticks (**3.4 minutes**) to walk back and any blip on the way re-doubled it. Observed in the field on a 100 kHz counter — stride pinned near 1500, **0.08 % of scans delivered**, falling by exactly 10/s and never arriving, with `seq_gaps=0` and `dropped=0` the whole time (nothing was *lost*; production was being thinned at the source). ⚠️ Note this pathology is a **one-way trap**: at low stride the frames are large and `D` really does measure the link, but once the stride is high there is nothing left to send, `D` collapses, and `floor = ceil(P/(α·D))` keeps it high — `D` measures *utilisation*, not *capacity*. A small ring is what pushes you in. (Driving the controller off the backlog trend instead of `D` would remove the trap entirely — not done, see gaps.)
- ⚠️ **The controller's `P` must be `WireBytesPerSec`, not `ProducedBytesPerSec`.** `D` is measured over whole frames, so `P` has to include the 12-byte per-record *wire* header (`u64 seq + u16 task_id + u16 payload_len`) — distinct from the 16-byte *slot* header. Payload-only understated production 2.5× for one 8-byte variable, so `floor` came out that much too low. `ProducedBytesPerSec` keeps its payload-only meaning for the `/ring/info` field.

**Consumer (`ipc_ring.go` + `api_ring.go`):** ONE shared `RingConsumer` mmap serves all connections, each with its own `readSeq`, under `rc.mu`.
- ⚠️ **The header is RE-PARSED on epoch change** (`syncLocked`) — a Build & Send that changes the addressed set restarts the runtime with a different `record_stride`/`nslots`, and without re-parsing the agent decodes new records with the old stride (only the first variable appears). The producer publishes `epoch` LAST with a release store (ARM is weakly ordered).
- ⚠️ **`Drain` is byte-bounded per frame (4 MiB)** — a client attaching to a running high-rate producer would otherwise drain the whole ring in one allocation and **the agent is OOM-killed** (4.3 GB RSS on a Jetson). On lap it counts `dropped` and catches up to the oldest surviving slot.
- ⚠️ **`stride_N = 0` means PAUSED — the producer stops writing entirely**, set when the last consumer disconnects (and at boot) so the runtime burns zero scan cycles. `SetStrideN` must NOT coerce `0→1`; the codegen is `if (N == 0) return;`. Trade-off: no pre-connect history.
**Proven** on real hardware (Jetson Orin Nano, 10 µs task, 0 drops). ⚠️ **Deploying is TWO steps** — Build & Send updates only the runtime, but the ring endpoints live in KronServer, so run `server/build.sh` then Deploy Server to Target (a stale agent 404s `/api/v1/ring/info`). **Gaps (v1):** scalars only; hot-swap doesn't feed the ring.

## 17. Retentive (RETAIN) variables
A variable of class **`Retain`** keeps its last value across a runtime restart (IEC warm restart). Everything retainable lives in `PlcState` (§6), so persistence is a name-keyed snapshot of a subset of its fields to **`retain.dat`** in the runtime's cwd (deploy dir on target, build dir for the sim).

Offered for **globals** (`['Var','Constant','Retain']`) and **program locals** (`['Local','Temp','Retain']`), including an **FB instance** in a program (the whole struct is one blob, so a `CTU` keeps `CV`). ❌ Deliberately absent inside an FB/function — those aren't `PlcState` fields, so it would be a silent no-op; retain the INSTANCE instead.
- ⚠️ **`VariableManager`'s `showClass` must keep testing for `'Retain'`** — it only fired for POUs with pin classes, making the option unreachable in the two scopes that need it. Sibling trap: the `<select>` falls back to `allowedClasses[0]` when the stored class isn't offered, and a value matching no option renders **blank**.
- ⚠️ **The file is SELF-DESCRIBING and matched BY NAME** (`"KRTN" u16 ver u16 count`, then `{u16 nameLen, name, u32 size, bytes}`). A raw `memcpy(&PlcState)` blob would be shorter and catastrophically wrong — adding one variable shifts every offset. Unknown/mismatched records are skipped; a new retained variable keeps its initial.
- ⚠️ **`plc_retain_load()` is emitted LAST in `PLC_Init`**, after `plc_state_init()` writes the initials; the reverse order makes retain a silent no-op. `plc_retain_save()` compares against the last image and skips the disk when unchanged; the write is tmp + `fsync` + rename (⚠️ `MoveFileExA` on Windows).

**Cadence (1 s, `RETAIN_INTERVAL_MS`):** Linux single binary → `plc_retain_thread` + a final flush in `PLC_Cleanup`, reachable because a **SIGTERM handler is installed only when the project has retained variables** (`retainEnabled`), leaving other projects' stop semantics untouched. Windows → the timer wheel in `main()`, periodic flush only. Hot-swap → `retain_thread` in `hotswaphost/host.c`.
- ⚠️ **The logic module must NOT own the flusher thread** (it is `dlclose`d on every swap) — `plc_retain_save` is exported non-static and the host `dlsym`s it **optionally**, re-resolving on every bind.
- ⚠️ **`g_retain_mu` makes that safe:** the flusher runs OUTSIDE the scan barrier, so it can be inside the old module's `plc_retain_save` when thread 0 `dlclose`s it — `do_swap` takes the same mutex across dlclose + re-resolve.
- ⚠️ The retain thread is created **only when there are tasks** — with zero tasks nothing sets `plc_stop`, so an unconditional thread hangs `main()` on its join forever.
- ⚠️ **The agent sets it via a boolean `retain`**, not a free `class` string, and `resolveRetainClass` refuses it outside a global / PROGRAM local — **that single guard also protects FB pin classes** from being rewritten to `Local`.

**Deliberate v1 limits — say these out loud:** the snapshot is asynchronous, not scan-boundary, so a >word-sized value on a 32-bit board can be sampled mid-update; the power-cut loss window is up to 1 s (chosen over per-change writes → flash wear); **a Build & Send does NOT reset retained values** and there is **no "clear" button** (force/PULSE-write, or delete `retain.dat`). ⚠️ **Not yet run on real hardware.**
