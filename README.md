<p align="center">
  <img src="images/demo.gif" alt="KronEditor Demo" width="800">
</p>

<h1 align="center">Turn Your Raspberry Pi Into a PLC</h1>

<p align="center">
  Build industrial-style control logic on affordable hardware with an open-source IEC 61131-3 toolchain.<br>
  Design Ladder Diagrams visually, compile to native C, and run live simulations with real-time variable monitoring.
</p>

<p align="center">
  <strong>What the demo shows:</strong> the <code>demo.gif</code> showcases a Raspberry Pi GPIO short-circuit pin test setup,
  where pin-level input/output behavior is verified directly from KronEditor during runtime.
</p>

<p align="center">
  KronEditor is fully open source and under active development.<br>
  <strong>We are looking for contributors</strong> across automation logic, embedded targets, UI/UX, testing, and documentation.
</p>

<p align="center">
  <a href="#getting-started">Getting Started</a> · <a href="#architecture">Architecture</a> · <a href="#simulation">Simulation</a> · <a href="#cross-compilation">Cross-Compilation</a> · <a href="#contributing">Contributing</a>
</p>

---

<h2 align="center">🔌 EtherCAT Master Support — Now Available</h2>

<p align="center">
  KronEditor now ships with a built-in <strong>EtherCAT master</strong> powered by <a href="https://github.com/OpenEtherCATsociety/SOEM">SOEM v2.0.0</a>.<br>
  Configure slaves, map PDO entries, and run real-time fieldbus communication directly from your PLC project.
</p>

<p align="center">
  <img src="images/config_ec.png" alt="EtherCAT Configuration" width="800">
</p>

<p align="center">
  <strong>Supported targets:</strong> x86_64 Linux · AArch64 Linux (Raspberry Pi 3/4/5) · ARMv7 Linux (BeagleBone) · Cortex-M4/M7 bare-metal<br>
  <code>libsoem.a</code> is built automatically from source via <em>Settings → Libraries → Build SOEM</em>.
</p>

> **CANopen** — coming soon. 🚧

---

## About

KronEditor is a desktop PLC IDE built with **Tauri v2** (Rust backend) and **React** (frontend). It lets you build IEC 61131-3 Ladder Diagram programs visually, compile them to native C for multiple hardware targets, and simulate them with live variable monitoring — all from a single application.

The editor is in active development. If you're interested in industrial automation, embedded systems, or PLC tooling, we'd love your contributions.

### Features

- **Visual Ladder Diagram Editor** — Drag-and-drop contacts, coils, timers, counters, math blocks, and user-defined function blocks onto rungs with automatic wire routing (powered by React Flow)
- **IEC 61131-3 Project Structure** — Programs, Function Blocks, Functions, Data Types (Array, Enum, Struct), Resources, Tasks with cycle-time scheduling
- **C Transpilation** — Ladder logic is transpiled to portable C code using topological evaluation ordering
- **Native Compilation** — Bundled GCC cross-compilers for 6 targets: x86_64 Linux/Windows, AArch64 Linux, ARM Cortex-M0/M4/M7
- **Real-Time Simulation** — Run the compiled program as a native process and monitor all variables live via `/proc/PID/mem` (Linux) or in-process DLL loading (Windows)
- **Force-Write Variables** — Click any variable during simulation to override its value in real time
- **Standard Library** — TON/TOF/TP/TONR timers, CTU/CTD/CTUD counters, R_TRIG/F_TRIG edge detectors, arithmetic, comparison, bitwise, trig, type conversion, PID, motion control blocks
- **Project Save/Load** — XML-based project files
- **EtherCAT Master** — Built-in SOEM v2.0.0 integration; configure slaves, PDO mapping, SDO init commands, and distributed clocks from a dedicated fieldbus editor. `libsoem.a` compiled automatically for all targets
- **Internationalization** — English, Turkish, Russian

---

## Getting Started

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Node.js](https://nodejs.org/) | 18+ LTS | Runtime for the frontend build |
| [Rust](https://rustup.rs/) | stable | Required by Tauri for the backend |
| System libraries | — | See [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS |

### Install & Run

```bash
git clone https://github.com/Krontek/KronEditor.git
cd KronEditor
npm install
npm run dev
```

This starts the Tauri development server with hot-reload. The app window opens automatically.

### Build for Distribution

```bash
# Linux AppImage
npm run build:linux

# Windows NSIS installer (cross-compiled from Linux)
npm run build:windows

# Both
npm run build
```

The build scripts automatically download the required cross-compilation toolchains (~1 GB) on first run. Outputs go to `src-tauri/target/release/bundle/`.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  React Frontend (Vite + React Flow)                     │
│  ┌──────────┐ ┌──────────────┐ ┌─────────────────────┐ │
│  │ Ladder   │ │ Variable     │ │ Project Sidebar     │ │
│  │ Editor   │ │ Manager      │ │ (Programs, FBs,     │ │
│  │          │ │ (live view)  │ │  Functions, Types)  │ │
│  └────┬─────┘ └──────▲───────┘ └─────────────────────┘ │
│       │               │                                  │
│  ┌────▼───────────────┴──────┐                          │
│  │ CTranspilerService        │                          │
│  │ Ladder → C transpilation  │                          │
│  └────────────┬──────────────┘                          │
└───────────────┼─────────────────────────────────────────┘
                │ Tauri IPC
┌───────────────▼─────────────────────────────────────────┐
│  Rust Backend (Tauri v2)                                │
│  ┌────────────────┐  ┌──────────────────────────────┐   │
│  │ compile_simulation │ run_simulation               │   │
│  │ (GCC invocation)│  │ (spawn process, read memory) │   │
│  └────────┬───────┘  └──────────┬───────────────────┘   │
│           │                      │                       │
│  ┌────────▼──────────────────────▼───────────────────┐  │
│  │ Bundled Toolchains                                │  │
│  │ MinGW · arm-none-eabi-gcc · aarch64-linux-gnu-gcc │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Project Structure

```
src/                        React frontend
  components/               UI components (ladder editor, variable manager, etc.)
  services/
    CTranspilerService.js   Ladder diagram → C code transpiler
    CompilerService.js      Frontend compilation orchestration
    LibraryService.js       Standard library block definitions
    XmlService.js           Project save/load
  locales/                  i18n translations

src-tauri/                  Rust backend
  src/main.rs               Tauri commands (compile, simulate, library update)
  src/ast.rs                Structured Text AST
  src/grammar.lalrpop       ST parser (LALRPOP)
  src/lexer.rs              ST lexer (Logos)

resources/                  Pre-compiled standard libraries
  include/                  C headers (kronstandard.h, kroncontrol.h, ...)
  x86_64/{linux,win32}/     Static archives (.a) per target
  arm/{linux,CortexM/M0,M4,M7}/

scripts/
  download-toolchains.js    Downloads ARM & MinGW cross-compilers

public/libraries/           Block definitions (XML) for the toolbox
```

---

## How It Works

### 1. Ladder Diagram Editing

Each program contains **rungs** — horizontal circuits from a left power rail to a right power rail. You place **contacts** (read a BOOL variable), **coils** (write a BOOL variable), and **function blocks** (timers, counters, math, etc.) on the rungs and connect them with wires.

The editor uses React Flow for node-based visual editing. Blocks are dragged from the toolbox, wired together, and configured with variable names or literal values on their input/output pins.

### 2. C Transpilation

When you compile, `CTranspilerService` walks the project structure and emits portable C code:

1. **Topological sort** — Blocks in each rung are sorted by their wire connections (Kahn's algorithm) so upstream blocks evaluate before downstream ones
2. **Power-flow propagation** — Each block gets an input expression (`inExpr`) derived from its upstream connections; contacts AND the variable value with the power flow; coils write the result
3. **Function block calls** — Standard FB instances (TON, CTU, R_TRIG, etc.) are called via their `_Call()` functions from the Krontek standard libraries
4. **Variable table** — A JSON map of every variable's C symbol, type, and byte offset is emitted alongside the C code, enabling the simulator to locate variables in memory

The output is a self-contained `plc.c` + `plc.h` that includes a `main()` with a microsecond-timed scan loop.

### 3. Native Compilation

The Rust backend invokes GCC to compile the transpiled C code:

| Target | Compiler | Flags | Output |
|--------|----------|-------|--------|
| x86_64 Linux | `gcc` | `-O2 -no-pie` | ELF executable |
| x86_64 Windows | MinGW `gcc` | `-O2 -shared` | `plc.dll` |
| AArch64 Linux | `aarch64-none-linux-gnu-gcc` | `-O2` | ELF executable |
| Cortex-M0 | `arm-none-eabi-gcc` | `-mcpu=cortex-m0 -mthumb` | Bare-metal binary |
| Cortex-M4F | `arm-none-eabi-gcc` | `-mcpu=cortex-m4 -mfpu=fpv4-sp-d16` | Bare-metal binary |
| Cortex-M7F | `arm-none-eabi-gcc` | `-mcpu=cortex-m7 -mfpu=fpv5-d16` | Bare-metal binary |

Pre-compiled static libraries (`libkronstandard.a`, `libkroncontrol.a`, etc.) for each target are linked automatically.

### 4. Simulation

Simulation runs the compiled program as a live process and reads variable values in real time:

**Linux:** The compiled ELF binary is spawned as a subprocess. The backend parses its ELF symbol table (via the `object` crate) to resolve variable addresses, then opens `/proc/PID/mem` to read and write variable values in a 200ms polling loop. Changes are emitted to the frontend via Tauri events.

**Windows:** The compiled `plc.dll` is loaded in-process via `LoadLibrary`. Variable pointers are resolved with `GetProcAddress`, and `main()` runs on a dedicated thread. Memory is accessed directly through the resolved pointers.

The frontend **Variable Manager** displays live values for all variables. Clicking a value opens a force-write dialog to override it at runtime. During simulation, ladder wires are color-coded: **red** = energized (TRUE), **blue** = de-energized (FALSE), reflecting actual output pin values from the running program.

---

## Standard Library

All blocks are implemented as C libraries in the [KrontekLibraries](https://github.com/AKronfeld) repositories.

| Category | Blocks |
|----------|--------|
| **Timers** | TON, TOF, TP, TONR |
| **Counters** | CTU, CTD, CTUD |
| **Edge Detectors** | R_TRIG, F_TRIG |
| **Bistable** | SR, RS |
| **Arithmetic** | ADD, SUB, MUL, DIV, MOD, ABS, SQRT, EXPT |
| **Trigonometry** | SIN, COS, TAN, ASIN, ACOS, ATAN |
| **Comparison** | GT, GE, EQ, NE, LE, LT |
| **Selection** | SEL, MUX, MAX, MIN, LIMIT |
| **Bitwise** | BAND, BOR, BXOR, BNOT, SHL, SHR, ROL, ROR |
| **Type Conversion** | All IEC standard conversions (INT_TO_REAL, BOOL_TO_INT, etc.) |
| **Scaling** | NORM_X, SCALE_X |
| **Motion** | MC_Power, MC_MoveAbsolute, MC_MoveRelative, MC_Stop, MC_Home |
| **Communication** | SEND, RECEIVE, MODBUS_READ, MODBUS_WRITE |
| **Advanced Control** | PID |

---

## Cross-Compilation

Toolchains are downloaded automatically on first build. You can also download them manually:

```bash
# Linux-hosted toolchains
node scripts/download-toolchains.js --host linux

# Windows-hosted toolchains (for cross-compile from Linux)
node scripts/download-toolchains.js --host windows
```

Toolchains are stored in `src-tauri/toolchains/{linux,windows}/` and bundled into the final application. The active host's toolchains are symlinked at `src-tauri/toolchains/active/` during the Cargo build.

---

## Usage

1. **Create a project** — Click *Project > New* or open an existing `.xml` project
2. **Add variables** — Define BOOL, INT, REAL, TIME, or custom data types in the Variable Manager
3. **Edit ladder rungs** — Drag contacts, coils, and function blocks from the toolbox; wire them together
4. **Configure blocks** — Click a block to assign variable names or literal values to its pins
5. **Simulate** — Click *Start* to compile and run; watch variables update live; click values to force-write; press Space on a selected contact to toggle its variable
6. **Build for target** — Use *PLC > Build* to compile for your target hardware; output binary appears in the build directory

---

## Contributing

KronEditor is in active development and we welcome contributions of all kinds:

- **Bug reports & feature requests** — Open an issue
- **Standard library blocks** — Add new blocks to the Krontek C libraries
- **Ladder editor improvements** — New block types, better wire routing, undo/redo
- **Structured Text** — The ST parser (LALRPOP + Logos) is functional but needs further work
- **Target support** — New MCU architectures, RTOS integration, communication protocols
- **Documentation & translations** — Improve docs or add new languages

```bash
# Development workflow
npm run dev          # Start with hot-reload
npm run build:linux  # Build Linux AppImage
npm run build        # Build for all platforms
```

---

## License


[MIT](LICENSE) — Krontek, 2026
