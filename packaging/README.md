# `packaging/` — how KronEditor is shipped

Read this before touching either build script.

## Purpose

Turn the repo into **two self-contained artifacts** — one per OS — that a user can run on a machine with **nothing installed**: no Go, no Node, no Python, no clang, no internet.

| Script | Artifact | Runs the whole product? |
|---|---|---|
| `build-appimage.sh` | `KronEditor-x86_64.AppImage` | **Yes** — editor, transpiler, AI agent, local simulation, hot-swap, Build & Send |
| `build-windows.sh` | `KronEditor-Setup-x64.exe` | Everything **except local simulation / hot-swap** — see [Windows limitation](#windows-limitation) |

Both are built **on Linux**. No Windows machine and no Wine are involved: Go cross-compiles the agent, and NSIS cross-builds the installer.

## Directory contract ⚠️

`packaging/` holds **only**:

```
packaging/
├── README.md               ← this file
├── build-appimage.sh       ← committed
├── build-windows.sh        ← committed
├── KronEditor-x86_64.AppImage    ← produced, gitignored
└── KronEditor-Setup-x64.exe      ← produced, gitignored
```

**Do not add committed asset files here.** Everything an artifact needs that used to be a separate file is now *generated inline* by the script that needs it:

- the AppImage's `AppRun` and `.desktop` → HEREDOCs in `build-appimage.sh`
- the Windows installer definition (`.nsi`) → written at build time by `build-windows.sh`

If you find yourself wanting to add `packaging/something.conf`, put it in the script instead.

**Staging dirs**: `packaging/tmplinux/` and `packaging/tmpwin/`. Each script removes its own on an `EXIT` trap, so a failed or Ctrl-C'd build still cleans up. They are **separate roots on purpose** — with one shared `tmp/` the two builds could not run at the same time, because either trap would delete the other's tree.

```bash
KEEP_TMP=1 ./packaging/build-windows.sh   # keep the staging tree to debug a build
```

**Downloaded build tools are cached OUTSIDE `packaging/`**, in `~/.cache/kron-editor-packaging/` (`appimagetool`, and NSIS when it is not installed). Otherwise "delete the temp dir" would mean re-downloading them on every build.

## What goes into an artifact

Three things, in both cases:

1. **`kron-host-agent`** — the Go backend. The Vite frontend is *embedded inside the binary* (`host-agent/embed.go`), so there is no separate web asset to ship.
2. **`resources/`** — Krontek libraries, the shared `krontek-include/` header tree, per-arch `.a` archives, and the prebuilt KronServer binaries that Build & Send deploys to a board.
3. **`toolchains/`** — the bundled LLVM plus **every target sysroot**. This is what makes the artifact multi-GB, and it is why Build & Send works offline.

⚠️ **Toolchains are per-HOST; sysroots are shared.** The AppImage ships the Linux `clang`; the installer ships the Windows `clang.exe` (`toolchains-win/`, fetched once by `setup_toolchain.py --host windows`). The *target sysroots* are byte-identical either way, which is exactly why a Windows `clang.exe` can cross-compile to a Linux ARM PLC.

⚠️ The multi-GB `toolchains/.cache/` in the repo root holds download archives for *rebuilding* the toolchain. It is **not** shipped — the scripts copy only `bin/`, `lib/`, `sysroots/`.

## Build host requirements

Common: `go`, `node`/`npm`, `python3`, `curl`, and a repo-root `toolchains/` (run `python3 setup_toolchain.py --host linux` once if missing).

| Script | Extra | If missing |
|---|---|---|
| `build-appimage.sh` | `appimagetool` | auto-downloaded to the cache (it bundles its own `mksquashfs`, so no squashfs tools needed) |
| `build-windows.sh` | `makensis`, plus `toolchains-win/` | NSIS is unpacked into the cache with `apt-get download nsis nsis-common` + `dpkg -x` — **no sudo, nothing installed system-wide**. `toolchains-win/` is fetched once by `setup_toolchain.py`. |

⚠️ An **unpacked** (not installed) NSIS cannot find its stubs/plugins via its compiled-in prefix — the script sets `NSISDIR` to the unpacked share tree. Drop that and `makensis` fails on `MUI2.nsh`.

On a non-dpkg distro the script stops with an explicit "install NSIS" message rather than guessing.

## Windows limitation

**Local simulation and hot-swap do not work on Windows, and no packaging change can fix that.** The runtime reads `/proc/<pid>/mem` and `/dev/shm`, and hot-swap needs `dlopen` + `SIGUSR1` — `host-agent/hotswap_signal_windows.go` returns an explicit error rather than pretending. The editor, transpiler, AI agent, and Build & Send to a real PLC all work on Windows.

⚠️ `GOOS=windows go build ./...` must keep succeeding — it is a release invariant, checked by this script every time.

## Design decisions worth not re-litigating

- **NSIS, not Inno Setup.** `makensis` runs natively on Linux, so one machine cuts the whole release. The previous flow produced a payload **zip** and left the `.exe` step to `iscc` run by hand on Windows — meaning `build-windows.sh` never actually produced an exe.
- **Artifact names carry no version.** The contract is "two files in this directory"; a versioned name would accumulate one file per release. The version lives *inside* both artifacts (`/api/host/health`, and the installer's VERSIONINFO / Add-Remove-Programs entry), single-sourced from `package.json`.
- **The AppImage passes `--resources-root`/`--toolchains-root` explicitly.** They live under `usr/share/kron/`, not next to the binary, so the agent's sibling-directory auto-detection cannot find them.
- **The uninstaller removes only what it installed** (`resources\`, `toolchains\`, the exe, the uninstaller) — never a blind `RMDir /r $INSTDIR`, which would take anything the user put beside it.
- **`File /r "<payload>\*.*"` in NSIS does include extension-less files** (verified) — `*.*` is "everything" there, not the DOS meaning.

## Verifying a build

The artifacts are big and slow to produce, so check them rather than assuming.

```bash
# AppImage: inspect without installing
./packaging/KronEditor-x86_64.AppImage --appimage-extract
ls squashfs-root/usr/share/kron/toolchains/bin/clang

# AppImage: actually run it on a spare port and compile something.
# ⚠️ Never use :7171 — that is the developer's own running agent.
./packaging/KronEditor-x86_64.AppImage --addr 127.0.0.1:7799 --app-data-dir /tmp/kt &
curl -s http://127.0.0.1:7799/api/host/health
# then POST /api/host/compile-simulation and /api/host/compile-for-target
# (the latter for an aarch64 AND an armv7 board — they take different code paths)

# Installer: list its contents without a Windows machine
7z l packaging/KronEditor-Setup-x64.exe | head -30
```

A green build is not proof. The checks that actually caught things here: the produced sim binary **runs**, and target compiles succeed for **both** aarch64 and armv7 (armv7 static linking has its own failure mode — see CLAUDE.md §4 on `LLVMGCCInstallDir`).

## Related docs

`CLAUDE.md` §4 — versioning, build output locations, and the toolchain/GCC invariants these scripts depend on.
