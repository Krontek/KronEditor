<p align="center">
  <img src="images/demo.gif" alt="KronEditor Demo" width="800">
</p>

<h1 align="center">KronEditor</h1>

<p align="center">
  <strong>One editor to rule all your machines.</strong><br>
  Write IEC 61131-3 logic. Compile to native C. Deploy to real hardware.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.1-blue" alt="v0.1.1">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20Windows-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/compiler-Clang%2FLLVM-blueviolet" alt="Clang/LLVM">
</p>

---

> ### We are actively looking for contributors and development partners.
> KronEditor is ambitious in scope — real-time PLC runtime, EtherCAT master, motion control, multi-target compilation. If you work in industrial automation, embedded systems, or compiler tooling and want to build something serious, **reach out or open a PR.**

---

## What is KronEditor?

KronEditor is an open-source, desktop-native PLC IDE built on [Tauri](https://v2.tauri.app/) + React. It targets real industrial hardware — not a simulator, not a toy. You write logic in Ladder Diagram or Structured Text, and it compiles down to a native binary via **Clang/LLVM** and runs on the device.

No proprietary runtime. No license fees. The compiled output is plain C.

## Features

- **Visual Ladder Diagram editor** — drag contacts, coils, and function blocks; live wire coloring during simulation
- **Structured Text editor** — full Monaco (VS Code engine) with IEC 61131-3 syntax
- **Clang/LLVM compilation** — simulation and cross-compilation toolchain powered by LLVM; supports x86_64, AArch64 (Raspberry Pi 3/4/5), ARM Cortex-M0/M4/M7
- **Live simulation** — compiled program runs as a real process; variables update from actual process memory every 200 ms; force-write any variable at runtime
- **EtherCAT Master** — SOEM v2.0.0 integration; configure slaves, PDO mappings, SDO init, distributed clocks
- **Motion Control** — PLCopen-compliant motion blocks: `MC_Power`, `MC_MoveAbsolute`, `MC_MoveRelative`, `MC_Stop`, `MC_Home`
- **IEC 61131-3 project structure** — Programs, Function Blocks, Functions, Data Types, Resources & Tasks
- **60+ standard library blocks** — Timers, Counters, Edge Detectors, Arithmetic, Trigonometry, Comparison, Bitwise, Type Conversion, PID
- **Watch Table** — monitor any variable expression, force values inline
- **Undo/Redo** — 50-step history across rung edits and variable changes
- **i18n** — English · Turkish · Russian

## Getting Started

### Prerequisites

#### Common (all platforms)

| Tool | Version | Install |
|---|---|---|
| [Rust](https://rustup.rs/) | stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) or your package manager |
| Python | 3.8+ | used by `setup_toolchain.py` to download Clang + sysroots |

#### Linux — system libraries (Tauri + WebKit)

**Arch / CachyOS / Manjaro**
```bash
sudo pacman -S webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg \
               libxml2 base-devel curl wget file openssl patchelf
```

**Ubuntu / Debian**
```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
                 libayatana-appindicator3-dev librsvg2-dev \
                 libxml2-dev patchelf curl wget file libssl-dev build-essential
```

**Fedora**
```bash
sudo dnf install webkit2gtk4.1-devel gtk3-devel \
                 libappindicator-gtk3-devel librsvg2-devel \
                 libxml2-devel patchelf curl wget file openssl-devel
```

#### Windows

- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with **Desktop development with C++** workload
- WebView2 runtime — pre-installed on Windows 10 (1803+) and Windows 11; otherwise install from [microsoft.com](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

#### macOS

```bash
xcode-select --install
```

---

### Build

```bash
git clone https://github.com/Krontek/KronEditor.git
cd KronEditor
npm install
npm run dev
```

```bash
npm run build:linux    # Linux AppImage
npm run build:windows  # Windows installer (cross-compiled)
npm run build          # All platforms
```

Cross-compilation toolchains (LLVM/Clang 21, arm-none-eabi, aarch64-linux-gnu, arm-linux-gnueabihf, MinGW sysroot) are downloaded automatically on first build via `setup_toolchain.py`. Subsequent builds skip the download if toolchains are already present.

## Architecture

Tauri v2 (Rust) backend handles compilation, process spawning, and memory reads. React + ReactFlow + Monaco frontend handles editing. `CTranspilerService.js` converts LD and ST to C. Rust backend calls Clang/LLVM to compile and link against pre-built C static libraries.

## License

[MIT](LICENSE) — Krontek, 2026
