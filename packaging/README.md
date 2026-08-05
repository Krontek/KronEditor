# `packaging/` — how KronEditor is shipped

Read this before touching either build script.

## Purpose

Turn the repo into **three artifacts** — one per OS — that a user can run on a machine with **nothing installed**: no Go, no Node, no Python, no clang, no internet.

| Script | Artifact | Runs the whole product? |
|---|---|---|
| `build-appimage.sh` | `KronEditor-x86_64.AppImage` | **Yes** — editor, transpiler, AI agent, local simulation, hot-swap, Build & Send |
| `build-windows.sh` | `KronEditor-Setup-x64.exe` | **Yes** — same set; local simulation runs on Windows via the hot-swap runtime (see [Windows notes](#windows-notes)) |
| `build-mac.sh` | `KronEditor-<arch>.dmg` | **Almost** — same set, but local simulation additionally needs Xcode Command Line Tools on the user's Mac (see [macOS notes](#macos-notes)) |

The first two are built **on Linux**. No Windows machine and no Wine are involved: Go cross-compiles the agent, and NSIS cross-builds the installer.

⚠️ **`build-mac.sh` must run ON a Mac** — it is the one artifact the Linux box cannot cut. `hdiutil`, `codesign`, `sips`/`iconutil` and the SDK are Apple-only, and there is no NSIS-equivalent that runs elsewhere. The script refuses to start on a non-Darwin host rather than producing something subtly broken.

## Directory contract ⚠️

`packaging/` holds **only**:

```
packaging/
├── README.md               ← this file
├── build-appimage.sh       ← committed
├── build-windows.sh        ← committed
├── build-mac.sh            ← committed
├── KronEditor-x86_64.AppImage    ← produced, gitignored
├── KronEditor-Setup-x64.exe      ← produced, gitignored
└── KronEditor-arm64.dmg          ← produced, gitignored
```

**Do not add committed asset files here.** Everything an artifact needs that used to be a separate file is now *generated inline* by the script that needs it:

- the AppImage's `AppRun` and `.desktop` → HEREDOCs in `build-appimage.sh`
- the Windows installer definition (`.nsi`) → written at build time by `build-windows.sh`
- the `.app`'s `Info.plist` and launcher → HEREDOCs in `build-mac.sh`; its `.icns` is generated from the repo's PNG with `sips`/`iconutil`, so no icon binary is committed

If you find yourself wanting to add `packaging/something.conf`, put it in the script instead.

**Staging dirs**: `packaging/tmplinux/`, `packaging/tmpwin/`, `packaging/tmpmac/`. Each script removes its own on an `EXIT` trap, so a failed or Ctrl-C'd build still cleans up. They are **separate roots on purpose** — with one shared `tmp/` the builds could not run at the same time, because any trap would delete the others' trees.

⚠️ Separate staging dirs are necessary but not sufficient for concurrency: every script drives the SAME Vite build into the same `dist/`, and running two together crashed one mid-build. `frontend_build()` therefore holds an `flock` for that ~2 s step; the expensive parts (toolchain copy, squashfs/LZMA/UDZO) still overlap fully. macOS ships no `flock(1)`, so `build-mac.sh` takes the documented fallback — it runs on a different machine anyway, so it cannot collide with the other two.

```bash
KEEP_TMP=1 ./packaging/build-windows.sh   # keep the staging tree to debug a build
```

**Downloaded build tools are cached OUTSIDE `packaging/`**, in `~/.cache/kron-editor-packaging/` (`appimagetool`, and NSIS when it is not installed). Otherwise "delete the temp dir" would mean re-downloading them on every build.

## What goes into an artifact

Three things, in both cases:

1. **`kron-host-agent`** — the Go backend. The Vite frontend is *embedded inside the binary* (`host-agent/embed.go`), so there is no separate web asset to ship.
2. **`resources/`** — Krontek libraries, the shared `krontek-include/` header tree, per-arch `.a` archives, and the prebuilt KronServer binaries that Build & Send deploys to a board.
3. **`toolchains/`** — the bundled LLVM plus **every target sysroot**. This is what makes the artifact multi-GB, and it is why Build & Send works offline.

⚠️ **Toolchains are per-HOST; sysroots are shared.** The AppImage ships the Linux `clang`; the installer ships the Windows `clang.exe` (`toolchains-win/`, fetched once by `setup_toolchain.py --host windows`); the DMG ships the macOS `clang` (`setup_toolchain.py --host macos`, auto-fetched by `build-mac.sh`). The *target sysroots* are byte-identical in all three, which is exactly why a Windows or macOS `clang` can cross-compile to a Linux ARM PLC.

⚠️ **macOS is the exception to "self-contained".** Apple does not permit redistributing its SDK, so there is no `toolchains/sysroots/*-apple-darwin` and the DMG cannot carry one. Compiling *for the Mac itself* (i.e. local simulation) resolves the SDK at run time via `xcrun --show-sdk-path` (`paths.go` `MacOSSDKPath`), so the end user needs `xcode-select --install`. Build & Send is unaffected — it links the bundled Linux sysroots.

⚠️ The multi-GB `toolchains/.cache/` in the repo root holds download archives for *rebuilding* the toolchain. It is **not** shipped — the scripts copy only `bin/`, `lib/`, `sysroots/`.

## Build host requirements

Common: `go`, `node`/`npm`, `python3`, `curl`, and a repo-root `toolchains/` (run `python3 setup_toolchain.py --host linux` once if missing).

| Script | Extra | If missing |
|---|---|---|
| `build-appimage.sh` | `appimagetool` | auto-downloaded to the cache (it bundles its own `mksquashfs`, so no squashfs tools needed) |
| `build-windows.sh` | `makensis`, plus `toolchains-win/` | NSIS is unpacked into the cache with `apt-get download nsis nsis-common` + `dpkg -x` — **no sudo, nothing installed system-wide**. `toolchains-win/` is fetched once by `setup_toolchain.py`. |

| `build-mac.sh` | **a Mac**, plus Xcode Command Line Tools | the script checks `uname -s`, every tool it uses, and that `xcrun --show-sdk-path` actually resolves — all before doing any work |

⚠️ An **unpacked** (not installed) NSIS cannot find its stubs/plugins via its compiled-in prefix — the script sets `NSISDIR` to the unpacked share tree. Drop that and `makensis` fails on `MUI2.nsh`.

On a non-dpkg distro the script stops with an explicit "install NSIS" message rather than guessing.

⚠️ `build-mac.sh` validates `toolchains/manifest.json`'s `host.os`, not just the existence of `bin/clang`. A `toolchains/` tree copied over from the Linux or Windows dev box has a `clang` at exactly the same path that cannot execute on a Mac, and without the manifest check that only surfaces as the user's first compile dying.

## Windows notes

**Local simulation works on Windows.** It runs the same hot-swap runtime as Linux: the loader-host creates a named section (`Local\plc_runtime`) instead of a `/dev/shm` object, loads the logic with `LoadLibrary` instead of `dlopen`, and takes its swap signal from a named Event instead of `SIGUSR1`. Everything above that — the scan barrier, the ping-pong slots, the force/pulse flag semantics — is the same code. CLAUDE.md §6 "Windows simulation" has the details and the traps found while porting.

Only the LEGACY plain-sim path stays Linux-only (it reads `/proc/<pid>/mem` and needs ELF/DWARF); `handleRunSimulation` returns an explicit error on Windows. Users never pick that path — hot-swap is the default runtime.

⚠️ **Verified under wine64, not yet on real Windows.** Treat the first run on a real machine as the acceptance test, and watch for the two things wine cannot tell us: scan-timing jitter, and Defender/SmartScreen reacting to an app that compiles and loads DLLs at run time.

⚠️ `GOOS=windows go build ./...` must keep succeeding — it is a release invariant, checked by this script every time.

## macOS notes

**Local simulation works on macOS too**, on the same hot-swap runtime. Four things differ and all four are in CLAUDE.md §6 "macOS simulation": the mirror is a plain mmap'd *file* (macOS has no `/dev/shm`, and a `shm_open`'d object is invisible to the agent), `plc_sleep_until` uses `mach_wait_until` (there is no `clock_nanosleep` at all), the scan barrier is a mutex+condvar shim (Apple never shipped `pthread_barrier_*`), and the logic module is a Mach-O **bundle** linked with `-bundle_loader` (the exact analogue of the Windows import library). Everything above that — the scan structure, the ping-pong slots, the swap protocol, force/pulse semantics — is the same code.

The LEGACY plain-sim path stays Linux-only here as well; `handleRunSimulation` returns an explicit error. Users never pick it — hot-swap is the default.

⚠️ **The Krontek `.a` archives for `aarch64-apple-darwin` are NOT in the repo.** Per CLAUDE.md §1, building `.a` files is the user's job. Without them the DMG still Builds & Sends to a PLC, but local simulation fails at link time. `build-mac.sh` checks for them and prints a loud warning plus the exact `clang`/`llvm-ar` commands — it does not fail the build, because a Build-&-Send-only artifact is still useful.

⚠️ **Ad-hoc signed, not notarized.** On Apple Silicon every Mach-O must carry *some* signature or the kernel kills it on load, so the script signs the bundled clang/lld and the agent (innermost first — signing a nested binary after its container invalidates the container). That satisfies the loader but **not** Gatekeeper, which also wants notarization; notarizing needs a paid Developer ID and an upload of the whole multi-GB image. So the first launch needs a one-time `xattr -dr com.apple.quarantine /Applications/KronEditor.app`, which the script prints.

⚠️ **Not yet verified on real hardware.** Unlike the Windows port, which could be iterated under wine64, there is no macOS emulator on Linux — everything below the Go layer is compile-reasoned, not run. Treat the first run on a real Mac as the acceptance test.

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

# DMG (on the Mac): mount, check the bundle, run it on a spare port
hdiutil attach packaging/KronEditor-arm64.dmg
codesign -dv --verbose=2 /Volumes/KronEditor*/KronEditor.app     # expect "Signature=adhoc"
/Volumes/KronEditor*/KronEditor.app/Contents/MacOS/kron-host-agent \
    --resources-root  /Volumes/KronEditor*/KronEditor.app/Contents/Resources/resources \
    --toolchains-root /Volumes/KronEditor*/KronEditor.app/Contents/Resources/toolchains \
    --addr 127.0.0.1:7799 --app-data-dir /tmp/kt &
curl -s http://127.0.0.1:7799/api/host/health
```

A green build is not proof. The checks that actually caught things here: the produced sim binary **runs**, and target compiles succeed for **both** aarch64 and armv7 (armv7 static linking has its own failure mode — see CLAUDE.md §4 on `LLVMGCCInstallDir`).

On macOS the equivalent acceptance test is a hot-swap session, because that is where all four ported primitives meet: start a simulation, confirm live values move (proves the file-backed mirror and the `mach_wait_until` scan timing — a 10 ms task should tick ~100×/s, not thousands), force- and pulse-write a variable, then edit logic and Hot Reload (proves `-bundle_loader` binding and the barrier shim).

## Related docs

`CLAUDE.md` §4 — versioning, build output locations, and the toolchain/GCC invariants these scripts depend on.
