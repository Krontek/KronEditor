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
# After this script, build the installer ON WINDOWS with Inno Setup:
#   iscc packaging\windows\kron-editor.iss
# or just zip the KronEditor/ folder for a portable distribution.
#
# Prereqs: go, node/npm, python3.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/packaging/dist/windows"
PAYLOAD="$DIST/KronEditor"

mkdir -p "$PAYLOAD"

# Single source of truth for the version: package.json (injected into the Go binary).
VERSION="$(node -p "require('$ROOT/package.json').version")"

echo "==> 1/4 Building frontend (v$VERSION)"
( cd "$ROOT" && npm run build:frontend )

echo "==> 2/4 Building host-agent (windows/amd64)"
( cd "$ROOT/host-agent" && GOOS=windows GOARCH=amd64 go build -ldflags "-X main.appVersion=$VERSION" -o "$PAYLOAD/kron-host-agent.exe" . )

echo "==> 3/4 Resources"
rm -rf "$PAYLOAD/resources"
cp -r "$ROOT/resources" "$PAYLOAD/resources"

echo "==> 4/4 Toolchains (windows host) — windows clang.exe + shared sysroots"
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
printf '#define AppVersion "%s"\n' "$VERSION" > "$ROOT/packaging/windows/version.iss"
echo "Wrote packaging/windows/version.iss (AppVersion $VERSION)"

echo "Payload ready: $PAYLOAD"
echo "Next (on Windows): iscc packaging\\windows\\kron-editor.iss   → installer"
echo "Or zip the folder for a portable build. Run kron-host-agent.exe, then open http://localhost:7171"
