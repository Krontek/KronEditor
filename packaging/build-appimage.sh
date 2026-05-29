#!/usr/bin/env bash
# Build a Linux AppImage for KronEditor.
#
#   packaging/build-appimage.sh
#
# Produces packaging/dist/KronEditor-x86_64.AppImage — a single file bundling:
#   - kron-host-agent (Linux, embeds the Vite frontend, serves :7171)
#   - resources/      (Krontek libs + headers)
#   - toolchains/     (LINUX-host LLVM + sysroots → simulation AND Build & Send work)
#
# Prereqs: go, node/npm, python3, and appimagetool (auto-downloaded if missing).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/packaging/dist"
APPDIR="$DIST/KronEditor.AppDir"
SHARE="$APPDIR/usr/share/kron"
OUT="$DIST/KronEditor-x86_64.AppImage"

mkdir -p "$DIST"

echo "==> 1/6 Building frontend"
( cd "$ROOT" && npm run build:frontend )

echo "==> 2/6 Building host-agent (linux/amd64)"
( cd "$ROOT/host-agent" && GOOS=linux GOARCH=amd64 go build -o "$DIST/kron-host-agent" . )

echo "==> 3/6 Assembling AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$SHARE"
cp "$DIST/kron-host-agent" "$APPDIR/usr/bin/kron-host-agent"
chmod +x "$APPDIR/usr/bin/kron-host-agent"
cp -r "$ROOT/resources" "$SHARE/resources"

echo "==> 4/6 Toolchains (linux host) — copy from repo-root toolchains/"
SRC_TC="$ROOT/toolchains"
# The repo-root toolchains/ IS the linux-host toolchain. Reuse it; only fetch
# (once) if it was never built. Never re-download on every package build.
if [ ! -x "$SRC_TC/bin/clang" ]; then
    echo "    repo-root toolchains/ missing — fetching once (setup_toolchain.py --host linux)"
    python3 "$ROOT/setup_toolchain.py" --host linux
fi
rm -rf "$SHARE/toolchains"
mkdir -p "$SHARE/toolchains"
# Copy only what the agent needs (bin + clang headers + sysroots). The 2.5 GB
# .cache/ holds download archives for rebuilding the toolchain — not shipped.
for d in bin lib sysroots; do
    cp -a --reflink=auto "$SRC_TC/$d" "$SHARE/toolchains/$d"
done
cp -a "$SRC_TC"/*.json "$SHARE/toolchains/" 2>/dev/null || true

echo "==> 5/6 AppRun + desktop + icon"
cp "$ROOT/packaging/appimage/AppRun" "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"
cp "$ROOT/packaging/appimage/kron-editor.desktop" "$APPDIR/kron-editor.desktop"
cp "$ROOT/src/assets/icons/plc-icon.png" "$APPDIR/kron-editor.png"

echo "==> 6/6 Packing AppImage"
APPIMAGETOOL="$(command -v appimagetool || true)"
if [ -z "$APPIMAGETOOL" ]; then
    APPIMAGETOOL="$DIST/appimagetool-x86_64.AppImage"
    if [ ! -x "$APPIMAGETOOL" ]; then
        echo "    downloading appimagetool"
        curl -fL -o "$APPIMAGETOOL" \
            https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
        chmod +x "$APPIMAGETOOL"
    fi
fi

# ARCH is required by appimagetool; --no-appstream avoids the metadata check.
ARCH=x86_64 "$APPIMAGETOOL" --no-appstream "$APPDIR" "$OUT"

echo
echo "Done: $OUT"
echo "Run it, then open http://localhost:7171 in your browser."
