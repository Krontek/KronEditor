# Packaging requirements

What you need on the build machine to produce each KronEditor distributable.
The version everywhere is single-sourced from `package.json` `"version"` — bump
that, nothing else.

> ⚠️ **Disk & time:** every artifact embeds the LLVM `toolchains/` (~2 GB
> Windows payload, ~5 GB Linux). Expect large outputs and multi-minute builds.
> Nothing is downloaded on-demand at runtime — it's all in the box.

---

## Common (both scripts)

| Tool | Why | Install (Debian/Ubuntu) |
|---|---|---|
| **Go** (1.25+) | builds `kron-host-agent` | `apt install golang` or go.dev |
| **Node + npm** | builds the Vite frontend + reads the version | `apt install nodejs npm` |
| **python3** | `setup_toolchain.py` (LLVM fetch) | preinstalled |
| **curl** | fetches `appimagetool` / toolchains once | `apt install curl` |
| `toolchains/` at repo root | LLVM + target sysroots (compile + Build&Send) | auto-fetched once: `python3 setup_toolchain.py --host linux` |

The toolchain download happens **once**; subsequent builds reuse it.

---

## 1. Linux AppImage — `./packaging/build-appimage.sh`

Produces `packaging/dist/KronEditor-x86_64.AppImage` (single self-contained file:
agent + resources + Linux toolchains → simulation **and** Build & Send work).

Needs, beyond the common tools:
- **appimagetool** — auto-downloaded to `packaging/dist/` on first run (needs curl).
- These tracked assets must exist (they are committed under `packaging/appimage/`):
  - `packaging/appimage/AppRun`
  - `packaging/appimage/kron-editor.desktop`
  - `src/assets/icons/plc-icon.png`

No extra install — just run the script.

---

## 2. Windows portable ZIP — `./packaging/build-windows.sh`

Runs **on Linux** (Go cross-compiles the `.exe`). Produces:
- `packaging/dist/windows/KronEditor/` — payload (`kron-host-agent.exe` + `resources/` + Windows `toolchains/`)
- `packaging/dist/windows/KronEditor-<ver>-windows-x64.zip` — ship this; the user unzips and double-clicks `kron-host-agent.exe`, then opens <http://localhost:7171>
- `packaging/windows/version.iss` — the `AppVersion` define for the installer (below)

Needs, beyond the common tools:
- **Windows LLVM** at `toolchains-win/` — auto-downloaded once (`setup_toolchain.py --host windows --only llvm`); sysroots are shared with the Linux `toolchains/`.
- `zip` or `7z` — *optional*, speeds up the archive; falls back to python3 `zipfile`.

> Local **simulation** does not work on Windows (`/proc`-based, Linux only).
> The editor + Build & Send to a remote Linux PLC do work.

---

## 3. Windows installer `.exe` — `iscc packaging\windows\kron-editor.iss`

**Separate step — NOT produced by `build-windows.sh`.** It bundles the payload
from step 2 into a single `KronEditor-<ver>-Setup.exe` (exe + resources +
toolchains, Start-menu shortcut, uninstaller).

Prerequisites:
1. **Run step 2 first** — the installer packs `packaging/dist/windows/KronEditor/`
   and includes `packaging/windows/version.iss`. Both must exist.
2. **Inno Setup 6** (`iscc` / `ISCC.exe`):
   - **On Windows:** install Inno Setup 6, then `iscc packaging\windows\kron-editor.iss`
   - **On Linux via Wine:**
     ```bash
     # one-time: install Inno Setup under Wine
     curl -fL -o is.exe https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe
     wine is.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-
     # build the installer
     cd packaging/windows
     wine "C:/Program Files/Inno Setup 6/ISCC.exe" kron-editor.iss
     ```
   Output: `packaging/dist/windows/KronEditor-<ver>-Setup.exe` (multi-GB — LZMA
   compresses the ~2 GB payload; the compile takes several minutes).

To make the installer smaller (slower build), raise compression in
`kron-editor.iss`: `Compression=lzma2/max` + `SolidCompression=yes`.

> **MSI instead of EXE?** Not set up here. An MSI needs the WiX Toolset and a
> separate `.wxs` authoring — only worth it for enterprise GPO deployment. The
> Inno Setup `.exe` is the supported installer.

---

## Quick reference

```bash
# Linux AppImage (complete, one file)
./packaging/build-appimage.sh
#   → packaging/dist/KronEditor-x86_64.AppImage

# Windows portable zip (+ payload + version.iss)
./packaging/build-windows.sh
#   → packaging/dist/windows/KronEditor-<ver>-windows-x64.zip

# Windows installer exe (needs Inno Setup; run after build-windows.sh)
iscc packaging/windows/kron-editor.iss      # or: wine ".../ISCC.exe" ...
#   → packaging/dist/windows/KronEditor-<ver>-Setup.exe
```
