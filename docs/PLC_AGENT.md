# PLC Agent — Architecture & Reference

The **PLC Agent** is KronEditor's embedded, tool-calling engineering agent. The user asks in plain language ("when the sensor turns on, light the lamp after 5 seconds, in ladder"); the agent edits the project through a fixed set of tools, and **every change is shown as a reviewable diff the user must approve** before it touches the project. It is the part of the product that differs most from a classic PLC IDE, and this document is its complete internal reference.

Source files:

| File | Role |
|---|---|
| `src/components/AiAgentPanel.jsx` | The panel UI + the agent loop (turns, proposals, approval, live buffers) |
| `src/services/agentTools.js` | The **pure action surface**: `TOOL_DEFS` (sent to the model) + `applyToolCall()` (executes them) |
| `host-agent/ai.go` | Provider-agnostic single-turn chat proxy (`POST /api/host/ai/chat`) |
| `host-agent/anthropic_oauth.go` | "Sign in with your Claude account" (PKCE OAuth, Pro/Max subscriptions) |
| `host-agent/ollama.go` | Local-model bootstrap (download/serve/pull Ollama, GPU placement) |
| `experiments/agent-check/` | The end-to-end verification gate (tools → transpile → real clang compile) |

---

## 1. Design principles

1. **Propose → approve, never mutate.** `applyToolCall(struct, name, args)` is a pure function: it never mutates the project in place. A write tool returns `{ mutation: true, next, diff }` — `next` is a *proposed* new projectStructure, `diff` is what the user sees. Only on approval does the panel commit `next` via `setProjectStructure`. Rejection throws the proposal away and tells the model it was rejected, so it can adapt.
2. **Read tools run free, write tools are gated.** Reads (`get_project_overview`, `read_pou`, `list_blocks`, `read_live_variables`, `watch_live_variables`, `check_compile`) auto-execute and their results are fed straight back to the model. Writes accumulate into one **proposal card** per assistant turn (`role: 'proposal'`, `status: 'pending'`) with Approve/Reject.
3. **The board is read-only context.** There is deliberately no tool that changes hardware config.
4. **Agent output must be indistinguishable from human editing.** Whatever a tool produces (rungs, blocks, wires, variables) must be exactly the shape the editor produces by hand and the transpiler consumes — same `customData`, same handle names, same variable objects. This is enforced by construction (shared tables/imports) and by the gate (§9).
5. **Weak models are a supported floor, not the target.** Multiple recovery layers (§4) keep a 7B local model *usable*; a native-tools cloud model is the intended experience.

---

## 2. The agent loop (one turn)

```
user prompt (+ optional images)
  │
  ▼
buildSystemPrompt(projectStructure, board, activeItem, libraryData)   ← rebuilt EVERY turn
  │
  ▼
host.aiChat({ provider, model, apiKey, baseUrl, system, messages, tools: TOOL_DEFS })
  │            (host-agent /api/host/ai/chat normalizes all providers to
  │             one assistant message { content, toolCalls })
  ▼
for each toolCall:
  ├─ read tool  → applyToolCall() now → tool result appended to messages, loop continues
  └─ write tool → applyToolCall() against a WORKING COPY (`working`) so later calls
                  in the same turn see earlier ones; collected into `steps`
  │
  ▼
steps.length > 0 → one proposal card (pending)
  │
  ├─ Approve → setProjectStructure(working commit), tool results = "applied",
  │            onHotSwap(touchedPous) if a hot-swap session is live (§7)
  └─ Reject  → tool results = "rejected", model told to adapt
```

Key mechanics in `AiAgentPanel.jsx`:

- **Working-copy chaining.** Within one turn, `working` starts as the current project and each approved-tool-in-waiting mutates it (`working = res.next`). This is why `create_pou` + `add_variable` + `set_ladder` in a single response works: the later calls see the POU the earlier one created — *before* any approval.
- **POU-target inference (weak-model safety net).** A local-scope tool whose `pou` doesn't resolve is rewritten to the last-touched / just-created / currently-open POU. It only ever overrides an *unresolvable* target, never a valid one.
- **Argument injection.** The panel injects panel-side context the pure module can't know:
  - `args.__library` (the XML block library) for `list_blocks` **and `set_ladder`** (FB pin resolution);
  - `args.__compile` (the result of an actual toolbar-equivalent compile) for `check_compile`.
- **Config** persists in `localStorage["aiAgentConfig"]` (`{provider, model, apiKey, baseUrl}`). User-visible name is "PLC Agent"; code symbols keep `AiAgentPanel`/`aiAgentConfig`.

---

## 3. Providers

| Provider id | Auth | Tool calls | Notes |
|---|---|---|---|
| `anthropic` | API key | native | Models: opus/sonnet/haiku (see `PROVIDERS`) |
| `anthropic-oauth` | Claude account sign-in (PKCE) | native | Bearer + `anthropic-beta: oauth-2025-04-20` + a "You are Claude Code" identity system block (subscription credential is only authorized for Claude Code). Tokens at `AppDataDir/anthropic_oauth.json`, auto-refresh ≤60s before expiry; refresh does NOT hold the mutex across the network call; `state` must match exactly. |
| `openai` | API key | native | |
| `gemini` / `google` | API key | native | Served through `callOpenAI` via Gemini's OpenAI-compat base URL |
| `ollama` | none (local daemon) | synthesized | `callOllama` fabricates tool-call ids; prompt-based tool fallback for models with no tool API. One-click bootstrap: `ollama-setup` downloads the official archive into `AppDataDir/ollama` and spawns `ollama serve`; progress on SSE `ollama-setup-progress` / `ollama-pull-progress`. |
| `custom` | anything | OpenAI-dialect | Any OpenAI-compatible endpoint via `baseUrl` |

Images: only `IMAGE_CAPABLE_PROVIDERS` (all except ollama) accept attachments.

All dialects are isolated in `host-agent/ai.go` (`callAnthropic`, `callOpenAI`, `callOllama`); the panel never sees provider differences.

---

## 4. Weak-model recovery layers

Local/small models routinely mangle tool calls. The panel repairs, in order:

| Layer | Fixes |
|---|---|
| `extractInlineToolCalls` | Tool calls written as JSON blocks, markdown headings, or bare-args forms in the TEXT instead of the tool-calls field |
| `extractKeyValToolCalls` | `name: set_st_code\npou: Main\n...` key-value prose forms |
| `recoverStCodeBlock` | A lone ST code block with no tool wrapper at all → synthesized `set_st_code` |
| `stripSpecialTokens`, `repairJsonBrackets` | Llama-family special tokens; unbalanced JSON |
| `extractStDeclarations` | Inlined `VAR…END_VAR` blocks in ST bodies → converted to `add_variable`-equivalent diff entries |
| POU-target inference (§2) | Missing/wrong `pou` argument |
| `set_ladder` auto-declare (§6) | Missing `add_variable` calls for ladder references |

These make qwen2.5-coder-class models workable, but they are heuristics — expect occasional nonsense from 7B models regardless.

---

## 5. Tool reference

All tools live in `TOOL_DEFS` (schema sent to the model) and are executed by `applyToolCall`. Errors are returned as `{ ok: false, error }` and fed back to the model verbatim — **error messages are written to teach the model the correct next call** (they name valid pins, suggest `list_blocks`, etc.).

### Read tools (auto-run, no approval)

| Tool | Purpose |
|---|---|
| `get_project_overview` | Every POU (name/language/var counts), globals, data types, board. The prompt tells the model to call this first. |
| `read_pou` | Full source of one POU: ST code, **rendered ladder** (`renderRungs` — see below), and its variable table. |
| `list_blocks` | The block catalog with REAL pin names/types (`buildBlockCatalog`): standard XML library + the project's own FBs/functions. The prompt forbids using any FB's pins from memory — it must call this. |
| `read_live_variables` | Buffered snapshot + recent history of live values (only meaningful while sim/PLC is running). |
| `watch_live_variables` | Awaits a trailing time-window of per-variable samples, then injects a condensed summary (`summarizeWatch`) — the tool for time-dependent verification (timers, oscillation). |
| `check_compile` | Transpiles + actually compiles the current project with the bundled clang (same as the toolbar Build). Failure returns real compiler diagnostics for the model to map back to IEC source. Success ≠ correct logic, only compilable. |

`renderRungs` is the agent's *eyes* for ladder: it traces each rung's power-flow graph into readable boolean logic (`Motor := (Start | Motor) & NOT Stop`), renders edge contacts as `RISING(x)`/`FALLING(x)`, and for each FB reports `{ type, instance, triggeredBy, pins, qOutput }` — downstream coil logic reads `instance.Q`, so the model can reconstruct and edit an existing rung rather than just knowing "there's a timer".

### Write tools (gated by approval)

| Tool | Purpose / notable rules |
|---|---|
| `create_pou` | Creates the **unified rung-based POU** (`type:'SCL'`, empty `rungs`) — the `language` arg is accepted but never changes the type; it only steers which authoring tool the model uses next. Category normalization tolerates "program"/"fb"/"functionblock" variants. Name must be an IEC identifier and not transpiler-reserved. |
| `rename_pou` | Renames + keeps `taskConfig` program references in sync. |
| `delete_pou` | Explicit-request only (prompt rule). |
| `set_st_code` | Replaces the POU's ST: on a unified/SCL POU the body goes into a single `lang:'ST'` rung. Takes ONLY plain statements (no PROGRAM/VAR wrappers, no METHOD — enforced by prompt + recovery strip). |
| `set_ladder` | Replaces ALL rungs with compiled ladder from the DSL — full spec in §6. |
| `add_variable` / `update_variable` / `remove_variable` | Local (needs `pou`) or global scope. Types funnel through `resolveVarType`: a scalar IEC type, an existing data-type/FB name, or a one-shot inline `ARRAY[m..n] OF T` that is auto-recovered into a real named data type. Anything else is rejected with instructions to call `create_data_type`. Reserved names (e.g. `S`, the PlcState pointer) are rejected. |
| `create_data_type` | Builds the exact `dataTypes` shape the human editors produce (`{name, type:'Array'|'Structure'|'Enumerated', content}`). |

---

## 6. Ladder authoring (`set_ladder`) — the deep dive

This is the agent's most differentiated capability: it authors **real, editor-native, transpiler-correct ladder**, including function blocks.

### 6.1 The rung DSL

```jsonc
{
  "pou": "Main",
  "rungs": [
    {
      "comment": "optional",
      "branches": [ [ {"contact":"Start"}, {"contact":"Enable","subType":"NO"} ],   // AND-series
                    [ {"contact":"Motor"} ] ],                                       // OR'd branch
      "seriesAfter": [ {"contact":"Stop","subType":"NC"} ],                          // after the OR-merge
      "fb": {                                                                        // optional, ONE per rung
        "type": "TON",
        "instance": "delayTimer",
        "inputs":  { "PT": "T#5s" },          // non-trigger pins: literal or variable name
        "outputs": { "ET": "elapsed" }        // capture output pins into variables
      },
      "outputs": [ {"coil":"Lamp","subType":"Normal"} ]                              // may be empty if fb present
    }
  ]
}
```

- **Power flow:** `branches` (OR of AND-series) → `seriesAfter` contacts → `fb` trigger pin → `fb` Q output → `outputs` coils → right rail.
- **Contact subTypes:** `NO`, `NC`, `Rising`, `Falling` (edges get real one-scan edge memory in the transpiler — a persistent PlcState field per block).
- **Coil subTypes:** `Normal`, `Set`, `Reset`, `Negated` (+ `Rising`/`Falling` accepted).
- An empty branch (`[]`) = direct power (always-true). A rung with only `outputs` is valid (unconditioned coil). A rung with only `fb` and no coils is valid (e.g. a counter that's read elsewhere).

### 6.2 What `fb` accepts and rejects

| Category | Examples | Verdict |
|---|---|---|
| Timers | TON, TOF, TP, TONR | ✅ |
| Counters | CTU, CTD, CTUD | ✅ |
| Edge / bistable | R_TRIG, F_TRIG, SR, RS | ✅ |
| Communication | UART/I2C/SPI/USB blocks (from `GENERIC_FB_DEFS`) | ✅ |
| Project (user) FBs | any `functionBlocks` POU | ✅ (pins from its Input/Output variables) |
| Inline math/compare/move | ADD, SUB, GT, MOVE, SEL, conversions… (`FB_TRIGGER_PIN[type]==='EN'`) | ❌ rejected → "express it in an ST rung" (their OUT has no ladder sink in this DSL) |
| Motion | MC_* (any pin typed `AXIS_REF`) | ❌ rejected → "author motion in ST" (Axis wiring is a special call parameter) |

The EN-rejection runs **before** library resolution, so it fires even if the library wasn't passed.

### 6.3 Single source of truth (⚠️ do not duplicate)

`agentTools.js` **imports** `FB_TRIGGER_PIN` and `FB_Q_OUTPUT` from `CTranspilerService.js` (exported there for exactly this purpose). These decide:

- the wire INTO the FB: `targetPin: "in_<trigger>"` (e.g. `in_IN`, `in_CU`, `in_CLK`); fallback for table-less types (SR/RS): first BOOL input;
- the wire OUT of the FB: `sourcePin: "out_<q>"` (e.g. `out_Q`, `out_Done`); fallback: first BOOL output.

Pin *metadata* (names/types for validation, `customData` for editor rendering) is resolved by `resolveFbBlockDef` in this order: XML library (`args.__library`) → `GENERIC_FB_DEFS` (`libraryTree.js`) → the project's own FBs (`pouPins`). The attached `customData` is byte-for-byte what a Toolbox drag attaches, so the editor renders agent blocks with correct pin handles and the transpiler's user-FB path finds `customData.content.variables`.

Never hand-copy a trigger/Q/pin table into agentTools — import or resolve it.

### 6.4 Auto-declaration

`set_ladder` auto-declares referenced-but-undeclared variables, **typed correctly**:

| Reference | Declared as |
|---|---|
| contact / coil name | `BOOL` |
| `fb.instance` | the FB type (e.g. `TON`), marked `_isInstance: true` |
| identifier in `fb.inputs` (e.g. `R: "ResetBtn"`) | the **pin's** type (BOOL for R) |
| `fb.outputs` capture (e.g. `ET ⇒ elapsed`) | the **pin's** type (TIME for ET) |

Literals (`T#5s`, `100`, `TRUE`) are never declared. Names that aren't plain identifiers (member access `dev.ok`, array `arr[1]`) are skipped. Every auto-declared variable appears in the approval diff as `auto-declared  name : TYPE` — a typo'd contact shows up as an unexpected new variable for the human to catch, instead of silently splitting the logic. The prompt tells the model NOT to emit `add_variable` for plain ladder references (only for non-default type/initial/address).

### 6.5 What a compiled rung looks like

`compileLadderRung` emits editor-native structures: `blocks` (Contact/Coil with `values.var`/`values.coil` + `subType`; FBs with `instanceName`, `customData`, `values` keyed by pin name) and `connections` (`{source, target, sourcePin, targetPin}`) from the left rail through the network to the right rail. Geometry: `LD_X0/LD_COL/LD_ROW` grid; an FB occupies double column width. On a unified/SCL POU every compiled rung is tagged `lang:'LD'`.

Transpiler mapping (verified by the gate): rung power reaches the FB via `inst.<TriggerPin> = (out_rN_bM)`, values land as `inst.<Pin> = <resolved>` (with editor-pin→C-struct-field translation, e.g. CTU's `R` → `RESET`), the call is `TYPE_Call(&inst…)`, downstream power is `inst.<Q>`, and `fb.outputs` captures emit `var = inst.<Pin>` write-backs.

### 6.6 Prompt routing (language per rung)

The system prompt routes STRICTLY per rung, not per POU:

- boolean interlocks + timers/counters/edges → **ladder** (`set_ladder`, with `fb`) — "timers and counters BELONG in ladder; do NOT switch to ST for them";
- math/expressions, loops/CASE, motion (MC_*), multi-FB interactions, strings/arrays → **ST** (`set_st_code`);
- mixing both in one POU is normal — it's one rung list (the unified model, see CLAUDE.md §7).

---

## 7. Live diagnosis & hot-swap integration

- While a simulation/PLC runs, the panel keeps a rolling ring buffer of timestamped live-variable snapshots. `read_live_variables` returns a condensed per-variable series (last/first/min/max, change count, oscillating/constant flags, down-sampled tail); `watch_live_variables` *waits* a window and then summarizes — the prompt routes any time-dependent check (did the timer fire? is it blinking at 1 Hz?) to `watch`, and tells the model to auto-verify after any change/deploy.
- **Online change:** when a hot-swap session is active, approving a proposal calls `onHotSwap(touchedPous)` → `App.handleAgentHotSwap`, which pre-checks `layoutSignatureDiff` (names exactly which non-swappable thing changed, if any), confirms with the user, then pushes the recompiled logic as a live swap (local sim) or to the target (`hotswapTargetLogic` + `hotswapDeploySwap`) — state preserved, no restart. The C-level `plc_state_layout_hash` remains the unconditional safety net.
- `check_compile` gives the model the same ground truth the Build button gives the human.

---

## 8. System prompt policies (summary)

Rebuilt every turn by `buildSystemPrompt` with the live project overview, board, open POU, and the library block names. Key policies (see the source for exact wording):

- **Clarify-first:** on a material ambiguity, ask 1–3 short questions and emit NO tool calls that turn. Never ask the user to write the code — clarify *requirements* only, once.
- **"Block" terminology:** a user-named "block" matching a standard block (mc_power→MC_Power) is an FB *instance* of that type — never a plain BOOL with that name.
- **No invented variables**; every added variable must be referenced; bare names only (no `GVL.`/`global.` prefixes — this is not CODESYS).
- **Order within a turn:** `create_pou` → variables → `set_ladder`/`set_st_code`, same POU name string everywhere.
- **ST hygiene:** one scan per call — no `WHILE TRUE`; FBs are instances called as `name(IN := …)`, outputs read as `name.Q`; no METHOD/VAR wrappers; `RETURN <value>` forbidden in programs.
- **Types:** arrays/structs/enums only via `create_data_type` + a named type.
- Tool-calls are the ONLY way to change the project; the system (not the model) reports "applied".

---

## 9. Verification — the agent gate

```
bash experiments/agent-check/gate.sh
```

`sample.mjs` drives the REAL tool surface exactly like a model turn: `create_pou` → `set_ladder` with four rungs (Start/Stop seal-in; Sensor→TON(PT, ET⇒elapsed)→Lamp; PartSensor→CTU(PV, R:=ResetBtn, CV⇒count)→BatchDone; Rising-contact→R_TRIG, no coil). It asserts:

- produced rung/block/wire shapes (`in_IN`/`out_Q` handles, `customData` present, values by pin name);
- pin-typed auto-declarations (`elapsed:TIME`, `count:INT`, `delayTimer:TON`, …) and that literals were NOT declared;
- loud, specific error paths (unknown pin lists the valid pins; ADD-in-ladder is routed to ST);
- `read_pou` renders the TON legibly (`triggeredBy: "Sensor"`, coil logic reads `delayTimer.Q`);

then transpiles (with a task assigned — the STRICT task model) and **compiles the generated C with the bundled clang**. Run it after touching agentTools' ladder DSL, `TOOL_DEFS`, or the transpiler's LD path. Its sibling `experiments/transpiler-check/compile-gate.sh` covers the transpiler itself.

---

## 10. Extending the agent — checklist

Adding a tool:

1. Schema in `TOOL_DEFS` (write the description as *instructions to the model*, including an example call; enums for closed sets).
2. Case in `applyToolCall` — pure; return `{mutation, ok, summary, diff, next}` for writes, `{mutation:false, ok, result}` for reads. Error strings must teach the correct next call.
3. If it needs panel-side context (library, live values, compiler), inject it as an `args.__*` key in the panel loop and document it in §2.
4. If it authors editor structures, match the human-editing shape exactly and extend `experiments/agent-check/sample.mjs` to assert it + compile.
5. Update the system prompt only if the model needs routing/ordering rules for it.
6. Update this file and CLAUDE.md §8.

Known deliberate limits (do not "fix" casually):

- One `fb` per rung; FB-to-FB wiring (cascades) and inline-math OUT sinks in ladder are out of scope — route to ST.
- Motion in ladder is rejected (Axis is a call parameter, not a wire).
- `set_ladder`/`set_st_code` replace the WHOLE rung list/body — there is no partial-rung edit tool; the model re-emits the full program (kept simple because `read_pou` gives it a faithful rendering to re-emit from).
