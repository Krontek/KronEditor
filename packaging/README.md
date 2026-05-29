# Packaging KronEditor

KronEditor ships as a single Go binary (`kron-host-agent`) that **embeds the
React frontend** and serves both the UI and the API on **`:7171`**. There is no
desktop shell — you run the binary and open `http://localhost:7171` in a
browser. Compilation (simulation + Build & Send) uses the bundled LLVM
`toolchains/`, resolved next to the binary (or via `--toolchains-root`).

Two distributables:

| | Linux `.AppImage` | Windows installer `.exe` |
|---|---|---|
| Editor UI in browser (`:7171`) | ✅ | ✅ |
| Build & Send (cross-compile → remote Linux PLC) | ✅ | ✅ |
| Local **simulation** (RUN) | ✅ | ❌ — `/proc`-based, Linux only |
| Bundled toolchain host | linux | windows |

The toolchain is **host-specific**: `setup_toolchain.py --host <os>` downloads
the matching LLVM (`clang` vs `clang.exe`); the target **sysroots** are the same
either way, so a Windows `clang.exe` still cross-compiles to aarch64/armhf/x86_64
Linux targets. That's why Build & Send works on Windows even though local
simulation (which runs a host binary and reads `/proc/<pid>/mem`) does not.

> ⚠️ `toolchains/` is ~5 GB. Both artifacts embed it, so expect a ~5 GB AppImage
> and a multi-GB installer. There is no on-demand download — it's all in the box.

---

## Build the Linux AppImage

```bash
packaging/build-appimage.sh
# → packaging/dist/KronEditor-x86_64.AppImage
```

Steps it runs: build frontend → build `kron-host-agent` (linux/amd64) → assemble
`KronEditor.AppDir` (binary + `resources/` + linux-host `toolchains/`) →
`AppRun` + `.desktop` + icon → `appimagetool` (auto-downloaded if absent).

The toolchain is **copied** from the repo-root `toolchains/` (the linux-host
toolchain) — *not* re-downloaded. The 2.5 GB `.cache/` (download archives) is
left out of the bundle. It only runs `setup_toolchain.py --host linux` if
`toolchains/` was never built. So you download the toolchain once, ever.

`AppRun` opens a terminal emulator (x-terminal-emulator/gnome-terminal/konsole/
xfce4-terminal/xterm) showing the agent log and the access URL; run it from a
shell to stay in the foreground instead.

Prereqs: `go`, `node`/`npm`, `python3`, `curl`. (`appimagetool` is fetched on
first run.)

## Build the Windows installer

```bash
packaging/build-windows.sh          # run on Linux — Go cross-compiles the .exe
# → packaging/dist/windows/KronEditor/   (exe + resources/ + windows toolchains/)
```

Toolchain assembly reuses what's already on disk: the **sysroots** and clang
headers are host-independent and are copied from the repo-root `toolchains/`;
only the **Windows LLVM binaries** (`clang.exe`, `ld.lld.exe`, …) are downloaded
— once — into a persistent `toolchains-win/`. Re-runs skip the download.

Then, **on a Windows machine** with [Inno Setup](https://jrsoftware.org/isinfo.php):

```bat
iscc packaging\windows\kron-editor.iss
:: → packaging\dist\windows\KronEditor-Setup.exe
```

Or skip the installer and zip `packaging/dist/windows/KronEditor/` for a
portable build. Launching `kron-host-agent.exe` opens a console (terminal-only
UX) that prints the URL; open `http://localhost:7171` manually.

Prereqs (payload): `go`, `node`/`npm`, `python3`. (Installer step needs Inno
Setup on Windows.)

---

## Notes

- **Ports**: agent on `:7171`. A deployed HMI (from Build & Send) is served by
  the *target device's* KronServer on its own configurable port — unrelated to
  this `:7171`.
- **App data / build output** lives outside the bundle, under the per-user data
  dir (`~/.local/share/com.plceditor.app/` on Linux, `%APPDATA%\com.plceditor.app`
  on Windows) — see `host-agent/paths.go`.
- **Toolchain output path**: `setup_toolchain.py` defaults to the repo-root
  `toolchains/` (what the dev host-agent expects); the packaging scripts pass
  `--root <payload>/toolchains` to emit straight into the bundle instead.
