#!/usr/bin/env bash
# Build the Windows payload for KronEditor (run on Linux; Go cross-compiles).
#
#   packaging/build-windows.sh
#
# Produces packaging/dist/windows/KronEditor/ containing:
#   - kron-host-agent.exe   (Windows, embeds the Vite frontend, serves :7171)
#   - resources/            (Krontek libs + headers)
#   - toolchains/           (WINDOWS-host LLVM: clang.exe/ld.lld.exe + sysroots)
#
# resources/ and toolchains/ sit next to the .exe, so the agent finds them with
# no flags (guessSiblingDir in host-agent/paths.go).
#
# NOTE: Local SIMULATION does not work on Windows (it reads /proc/<pid>/mem and
# runs a host binary — both Linux-only). Build & Send to a remote Linux PLC
# DOES work, because the bundled Windows clang.exe cross-compiles to the Linux
# target sysroots. The editor itself is fully functional.
#
# This script also produces a PORTABLE ZIP (KronEditor-<ver>-windows-x64.zip):
# the end user just unzips it and double-clicks kron-host-agent.exe — no install
# step. (An Inno Setup installer is optional & separate: run on Windows with
#   iscc packaging\windows\kron-editor.iss
# once a real installer is wanted.)
#
# Prereqs: go, node/npm, python3. (zip/7z optional — speeds up the archive step.)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/packaging/dist/windows"
PAYLOAD="$DIST/KronEditor"

mkdir -p "$PAYLOAD"

# Single source of truth for the version: package.json (injected into the Go binary).
VERSION="$(node -p "require('$ROOT/package.json').version")"

echo "==> 1/5 Building frontend (v$VERSION)"
( cd "$ROOT" && npm run build:frontend )

echo "==> 2/5 Building host-agent (windows/amd64)"
( cd "$ROOT/host-agent" && GOOS=windows GOARCH=amd64 go build -ldflags "-X main.appVersion=$VERSION" -o "$PAYLOAD/kron-host-agent.exe" . )

echo "==> 3/5 Resources"
rm -rf "$PAYLOAD/resources"
cp -r "$ROOT/resources" "$PAYLOAD/resources"

echo "==> 4/5 Toolchains (windows host) — windows clang.exe + shared sysroots"
SRC_TC="$ROOT/toolchains"        # linux-built; sysroots + clang headers are host-independent
WIN_TC="$ROOT/toolchains-win"    # persistent windows-host LLVM (downloaded once)

if [ ! -d "$SRC_TC/sysroots" ]; then
    echo "    ERROR: repo-root toolchains/ has no sysroots. Run: python3 setup_toolchain.py --host linux" >&2
    exit 1
fi
# Download the WINDOWS LLVM binaries (clang.exe/ld.lld.exe/...) exactly once.
# Sysroots are NOT re-downloaded — they are shared with the linux toolchain.
if [ ! -x "$WIN_TC/bin/clang.exe" ]; then
    echo "    fetching Windows LLVM once → toolchains-win/ (clang.exe etc.)"
    python3 "$ROOT/setup_toolchain.py" --host windows --only llvm --root "$WIN_TC"
fi

rm -rf "$PAYLOAD/toolchains"
mkdir -p "$PAYLOAD/toolchains"
cp -a --reflink=auto "$WIN_TC/bin"        "$PAYLOAD/toolchains/bin"       # windows clang.exe + lld
cp -a --reflink=auto "$WIN_TC/lib"        "$PAYLOAD/toolchains/lib"       # clang builtin headers
cp -a --reflink=auto "$SRC_TC/sysroots"   "$PAYLOAD/toolchains/sysroots"  # shared target sysroots
cp -a "$SRC_TC"/*.json "$PAYLOAD/toolchains/" 2>/dev/null || true

echo
# Single-source the installer version too: emit the AppVersion define the .iss includes.
# (Only used if you later build the optional Inno Setup installer ON WINDOWS.)
mkdir -p "$ROOT/packaging/windows"
printf '#define AppVersion "%s"\n' "$VERSION" > "$ROOT/packaging/windows/version.iss"
echo "Wrote packaging/windows/version.iss (AppVersion $VERSION)"

echo "==> 5/5 Portable zip"
ZIP_NAME="KronEditor-$VERSION-windows-x64.zip"
ZIP_PATH="$DIST/$ZIP_NAME"
rm -f "$ZIP_PATH"
# The archive holds a top-level KronEditor/ dir, so it unzips into a clean folder.
# Prefer a fast native archiver; fall back to python3 (always a prereq) otherwise.
if command -v zip >/dev/null 2>&1; then
    ( cd "$DIST" && zip -r -q "$ZIP_NAME" "KronEditor" )
elif command -v 7z >/dev/null 2>&1; then
    ( cd "$DIST" && 7z a -tzip -bso0 -bsp0 "$ZIP_NAME" "KronEditor" >/dev/null )
else
    echo "    (no zip/7z found — using python3 zipfile; install 'zip' for a faster archive)"
    python3 - "$DIST" "KronEditor" "$ZIP_PATH" <<'PY'
import os, sys, zipfile
base, top, out = sys.argv[1], sys.argv[2], sys.argv[3]
root = os.path.join(base, top)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for dirpath, _, files in os.walk(root):
        for f in files:
            full = os.path.join(dirpath, f)
            z.write(full, os.path.relpath(full, base))
PY
fi
ZIP_SIZE="$(du -h "$ZIP_PATH" | cut -f1)"

echo
echo "Payload ready:  $PAYLOAD"
echo "Portable zip:   $ZIP_PATH  ($ZIP_SIZE)"
echo "Ship the .zip. The user unzips it and double-clicks kron-host-agent.exe,"
echo "then opens http://localhost:7171 in a browser. No install step needed."
echo
echo "(Optional, later) Installer on Windows: iscc packaging\\windows\\kron-editor.iss"
