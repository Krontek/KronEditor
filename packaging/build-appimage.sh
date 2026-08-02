#!/usr/bin/env bash
# Build the KronEditor Linux AppImage.
#
#   packaging/build-appimage.sh
#
# Produces exactly ONE artifact:
#   packaging/KronEditor-x86_64.AppImage
#
# It is fully self-contained — the target machine needs nothing installed:
#   - kron-host-agent  (Linux/amd64, the Vite frontend is embedded in the binary)
#   - resources/       (Krontek libraries + the shared krontek-include headers)
#   - toolchains/      (LLVM clang + every target sysroot → local simulation AND
#                       Build & Send to an ARM PLC both work offline)
#   - AppRun + .desktop + icon, generated inline (see HEREDOCs below)
#
# ⚠️ Everything transient goes to packaging/tmplinux/ and is deleted on exit, so
# the packaging/ directory only ever holds the two build scripts and the two
# artifacts. Set KEEP_TMP=1 to keep the staging tree when debugging a build.
# (The Windows script stages in packaging/tmpwin/ — separate roots, so the two
#  builds can run at the same time without one deleting the other's tree.)
#
# Downloaded build tools (appimagetool) are cached OUTSIDE packaging/, in
# ~/.cache/kron-editor-packaging/, so repeat builds do not re-download and
# packaging/ still stays clean.
#
# Build host needs: go, node/npm, python3, curl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packaging"
TMP="$PKG/tmplinux"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/kron-editor-packaging"
APPDIR="$TMP/KronEditor.AppDir"
SHARE="$APPDIR/usr/share/kron"
OUT="$PKG/KronEditor-x86_64.AppImage"

# Always clean the staging tree — including on failure or Ctrl-C.
cleanup() {
    if [ "${KEEP_TMP:-0}" = "1" ]; then
        echo "KEEP_TMP=1 — staging kept at $TMP"
        return
    fi
    rm -rf "$TMP"
}
trap cleanup EXIT

rm -rf "$TMP"
mkdir -p "$APPDIR/usr/bin" "$SHARE" "$CACHE"

# Single source of truth for the version: package.json (§4 of CLAUDE.md).
VERSION="$(node -p "require('$ROOT/package.json').version")"

# ⚠️ Serialise the Vite build. Both scripts emit into the SAME dist/ tree, so
# running them concurrently (which the separate tmp dirs otherwise allow) makes
# one clobber the other's output mid-build — observed as a Vite crash. flock
# costs nothing for a solo build and only holds for the ~2 s frontend step; the
# expensive parts (toolchain copy, squashfs/LZMA) still overlap fully.
frontend_build() {
    if command -v flock >/dev/null 2>&1; then
        flock "$ROOT/node_modules/.vite-build.lock" -c "cd '$ROOT' && npm run build:frontend"
    else
        ( cd "$ROOT" && npm run build:frontend )
    fi
}

echo "==> 1/6 Frontend (v$VERSION)"
frontend_build

echo "==> 2/6 Host agent (linux/amd64)"
( cd "$ROOT/host-agent" && GOOS=linux GOARCH=amd64 \
    go build -ldflags "-X main.appVersion=$VERSION" -o "$APPDIR/usr/bin/kron-host-agent" . )
chmod +x "$APPDIR/usr/bin/kron-host-agent"

echo "==> 3/6 Resources"
cp -a --reflink=auto "$ROOT/resources" "$SHARE/resources"

echo "==> 4/6 Toolchains (linux host)"
SRC_TC="$ROOT/toolchains"
# The repo-root toolchains/ IS the linux-host toolchain — reuse it. Only fetch
# if it was never built; never re-download on every package build.
if [ ! -x "$SRC_TC/bin/clang" ]; then
    echo "    repo-root toolchains/ missing — fetching once (setup_toolchain.py --host linux)"
    python3 "$ROOT/setup_toolchain.py" --host linux
fi
mkdir -p "$SHARE/toolchains"
# bin + clang builtin headers + target sysroots. The multi-GB .cache/ under
# toolchains/ holds download archives for REBUILDING the toolchain — not shipped.
for d in bin lib sysroots; do
    cp -a --reflink=auto "$SRC_TC/$d" "$SHARE/toolchains/$d"
done
cp -a "$SRC_TC"/*.json "$SHARE/toolchains/" 2>/dev/null || true

echo "==> 5/6 AppRun + desktop entry + icon"
# ⚠️ Generated here rather than copied from packaging/appimage/: packaging/ must
# contain nothing but the two scripts and the two artifacts, so these tiny files
# live in the script that needs them.
cat > "$APPDIR/AppRun" <<'APPRUN'
#!/usr/bin/env bash
# AppRun — entry point for the KronEditor AppImage.
#
# Starts the bundled kron-host-agent and points it at the bundled resources/ and
# toolchains/. They live under usr/share/kron/, NOT next to the binary, so the
# agent's sibling-directory auto-detection cannot find them — pass them
# explicitly. The agent serves the editor UI + API on :7171.
#
# Startup is terminal-based: from a shell it stays in the foreground; from a
# file manager it opens a terminal so the access URL and log stay visible.
set -e

SELF="$(readlink -f "${0}")"
HERE="$(dirname "$SELF")"

run() {
    exec "$HERE/usr/bin/kron-host-agent" \
        --resources-root  "$HERE/usr/share/kron/resources" \
        --toolchains-root "$HERE/usr/share/kron/toolchains" \
        "$@"
}

# Attached to a terminal already (launched from a shell) → foreground.
if [ -t 1 ]; then
    run "$@"
fi

# No terminal (desktop / file-manager launch) → open one so the URL is visible.
for term in x-terminal-emulator gnome-terminal konsole xfce4-terminal xterm; do
    if command -v "$term" >/dev/null 2>&1; then
        case "$term" in
            gnome-terminal) exec "$term" -- "$SELF" "$@" ;;
            *)              exec "$term" -e "$SELF" "$@" ;;
        esac
    fi
done

# No terminal emulator on the box — run headless (the URL still goes to stdout).
run "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

cat > "$APPDIR/kron-editor.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=KronEditor
GenericName=PLC Editor
Comment=Browser-based IEC 61131-3 PLC editor (Ladder + Structured Text)
Exec=AppRun
Icon=kron-editor
Categories=Development;IDE;
Terminal=true
DESKTOP

cp "$ROOT/src/assets/icons/plc-icon.png" "$APPDIR/kron-editor.png"

echo "==> 6/6 Packing"
# appimagetool bundles its own mksquashfs, so the build host needs no squashfs
# tools. Cached outside packaging/ so a rebuild does not re-download it.
APPIMAGETOOL="$(command -v appimagetool || true)"
if [ -z "$APPIMAGETOOL" ]; then
    APPIMAGETOOL="$CACHE/appimagetool-x86_64.AppImage"
    if [ ! -x "$APPIMAGETOOL" ]; then
        echo "    downloading appimagetool → $CACHE"
        curl -fL --retry 3 -o "$APPIMAGETOOL" \
            https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
        chmod +x "$APPIMAGETOOL"
    fi
fi

rm -f "$OUT"
# ARCH is required by appimagetool; --no-appstream skips the metadata validator
# (we ship a .desktop, not an AppStream component).
ARCH=x86_64 "$APPIMAGETOOL" --no-appstream "$APPDIR" "$OUT"
chmod +x "$OUT"

echo
echo "Done: $OUT  ($(du -h "$OUT" | cut -f1))"
echo "Run it, then open http://localhost:7171 in a browser."
