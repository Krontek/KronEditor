#!/usr/bin/env bash
# Build the KronEditor macOS disk image.
#
#   packaging/build-mac.sh
#
# Produces exactly ONE artifact:
#   packaging/KronEditor-<arch>.dmg          (arch = arm64 | x86_64)
#
# It is self-contained apart from Apple's SDK (see "Host requirements"):
#   - KronEditor.app/Contents/MacOS/          launcher + kron-host-agent (darwin)
#   - KronEditor.app/Contents/Resources/      resources/ + toolchains/ (macOS host)
#   - Info.plist + .icns, generated inline (see HEREDOCs below)
#
# ⚠️ THIS SCRIPT MUST RUN ON A MAC. This is the one place macOS breaks the
# pattern the other two artifacts follow. build-windows.sh cross-builds its .exe
# from Linux because makensis runs there; there is no equivalent for macOS —
# hdiutil, codesign, sips/iconutil and the SDK are all Apple-only. The whole
# release can no longer be cut from one machine.
#
# ⚠️ Everything transient goes to packaging/tmpmac/ and is deleted on exit, so
# the packaging/ directory only ever holds the build scripts and the artifacts.
# Set KEEP_TMP=1 to keep the staging tree when debugging a build. (Each script
# stages in its own root — tmplinux/, tmpwin/, tmpmac/ — so builds can run at
# the same time without one deleting another's tree.)
#
# Downloaded build inputs are cached OUTSIDE packaging/, in
# ~/.cache/kron-editor-packaging/, matching the other two scripts.
#
# Host requirements: macOS, Xcode Command Line Tools (xcode-select --install),
# go, node/npm, python3.
#
# ⚠️ Apple's SDK is NOT bundled — Apple does not permit redistributing it. So
# unlike the Linux and Windows artifacts, the .app is not fully self-contained:
# LOCAL SIMULATION on the end user's Mac needs the Command Line Tools installed
# there too (the agent resolves the SDK with `xcrun --show-sdk-path`; see
# paths.go MacOSSDKPath). Build & Send to a PLC needs nothing extra — those
# targets use the bundled Linux sysroots.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packaging"
TMP="$PKG/tmpmac"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/kron-editor-packaging"
STAGE="$TMP/dmgroot"
APP="$STAGE/KronEditor.app"

# ── Host gate ───────────────────────────────────────────────────────────────
if [ "$(uname -s)" != "Darwin" ]; then
    cat >&2 <<'EOF'
ERROR: build-mac.sh must run on macOS.

Unlike build-windows.sh (NSIS runs on Linux, so the .exe cross-builds), the
macOS artifact needs Apple-only tools: hdiutil, codesign, sips/iconutil and the
macOS SDK. There is no supported way to produce it from Linux.
EOF
    exit 1
fi

for tool in xcrun go node npm python3 hdiutil codesign sips iconutil; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: '$tool' not found in PATH." >&2
        case "$tool" in
            xcrun|codesign|sips|iconutil|hdiutil)
                echo "Install the Xcode Command Line Tools: xcode-select --install" >&2 ;;
        esac
        exit 1
    fi
done

# The SDK must actually resolve — the agent needs it at runtime for -isysroot,
# and a broken xcode-select is far easier to diagnose here than as a wall of
# "stdio.h file not found" on the user's first simulation.
SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
if [ -z "$SDK" ] || [ ! -d "$SDK" ]; then
    echo "ERROR: macOS SDK not found. Run: xcode-select --install" >&2
    exit 1
fi

case "$(uname -m)" in
    arm64)  ARCH=arm64;  GOARCH=arm64; RES_TRIPLE=aarch64-apple-darwin ;;
    x86_64) ARCH=x86_64; GOARCH=amd64; RES_TRIPLE=x86_64-apple-darwin ;;
    *) echo "ERROR: unsupported macOS architecture $(uname -m)" >&2; exit 1 ;;
esac
OUT="$PKG/KronEditor-$ARCH.dmg"

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
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$CACHE"

# Single source of truth for the version: package.json (§4 of CLAUDE.md).
VERSION="$(node -p "require('$ROOT/package.json').version")"

# ⚠️ Serialise the Vite build, same reason as the other two scripts: all three
# emit into the SAME dist/ tree, so concurrent runs clobber each other mid-build.
# macOS ships no flock(1), so the fallback path is the normal one here.
frontend_build() {
    if command -v flock >/dev/null 2>&1; then
        flock "$ROOT/node_modules/.vite-build.lock" -c "cd '$ROOT' && npm run build:frontend"
    else
        ( cd "$ROOT" && npm run build:frontend )
    fi
}

echo "==> 1/7 Frontend (v$VERSION)"
frontend_build

echo "==> 2/7 Host agent (darwin/$GOARCH)"
( cd "$ROOT/host-agent" && GOOS=darwin GOARCH="$GOARCH" \
    go build -ldflags "-X main.appVersion=$VERSION" -o "$APP/Contents/MacOS/kron-host-agent" . )
chmod +x "$APP/Contents/MacOS/kron-host-agent"

echo "==> 3/7 Resources"
# ditto rather than cp -a: it is the macOS-native recursive copy and preserves
# extended attributes and resource forks that BSD cp can silently drop.
ditto "$ROOT/resources" "$APP/Contents/Resources/resources"

# ⚠️ The Krontek static archives are per-ABI and the macOS ones are NOT in the
# repo — CLAUDE.md §1 makes building .a files the user's job. Without them the
# artifact still Builds & Sends to a PLC (that links the bundled Linux
# archives), but LOCAL SIMULATION cannot link and fails at the last step.
DARWIN_LIBS_OK=1
if ! ls "$ROOT/resources/$RES_TRIPLE/lib/"*.a >/dev/null 2>&1; then
    DARWIN_LIBS_OK=0
    cat <<EOF

    ⚠️  resources/$RES_TRIPLE/lib/ has no .a archives.
        Build & Send will work; LOCAL SIMULATION will fail at link time.
        Build them from KrontekLibraries with the bundled clang, e.g.
          clang --target=$RES_TRIPLE -isysroot "$SDK" -O2 -c <lib>.c -o <lib>.o
          llvm-ar rcs resources/$RES_TRIPLE/lib/lib<name>.a <lib>.o
        then re-run this script.

EOF
fi

echo "==> 4/7 Toolchains (macOS host)"
SRC_TC="$ROOT/toolchains"
# ⚠️ Check the manifest, not just bin/clang: a toolchains/ tree copied over from
# the Linux or Windows dev box has a clang at the same path that cannot execute
# here, and the failure would only surface as the user's first compile dying.
TC_HOST=""
if [ -f "$SRC_TC/manifest.json" ]; then
    TC_HOST="$(node -p "require('$SRC_TC/manifest.json').host.os" 2>/dev/null || echo "")"
fi
if [ "$TC_HOST" != "macos" ] || [ ! -x "$SRC_TC/bin/clang" ]; then
    echo "    toolchains/ is for host '${TC_HOST:-unknown}' — fetching macOS host toolchain"
    python3 "$ROOT/setup_toolchain.py" --host macos
fi
mkdir -p "$APP/Contents/Resources/toolchains"
# bin + clang builtin headers + target sysroots. The multi-GB .cache/ under
# toolchains/ holds download archives for REBUILDING the toolchain — not shipped.
for d in bin lib sysroots; do
    ditto "$SRC_TC/$d" "$APP/Contents/Resources/toolchains/$d"
done
cp "$SRC_TC"/*.json "$APP/Contents/Resources/toolchains/" 2>/dev/null || true

echo "==> 5/7 Bundle layout (Info.plist + launcher + icon)"
# ⚠️ Generated here rather than copied from packaging/mac/: packaging/ must
# contain nothing but the build scripts and the artifacts, so these tiny files
# live in the script that needs them.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>              <string>KronEditor</string>
    <key>CFBundleDisplayName</key>       <string>KronEditor</string>
    <key>CFBundleIdentifier</key>        <string>com.plceditor.app</string>
    <key>CFBundleExecutable</key>        <string>KronEditor</string>
    <key>CFBundleIconFile</key>          <string>kron-editor</string>
    <key>CFBundlePackageType</key>       <string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundleVersion</key>           <string>$VERSION</string>
    <key>LSMinimumSystemVersion</key>    <string>11.0</string>
    <key>NSHighResolutionCapable</key>   <true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/KronEditor" <<'LAUNCHER'
#!/bin/bash
# Bundle entry point for KronEditor.
#
# Starts the bundled kron-host-agent and points it at the bundled resources/ and
# toolchains/. They live under Contents/Resources/, NOT next to the binary, so
# the agent's sibling-directory auto-detection cannot find them — pass them
# explicitly. The agent serves the editor UI + API on :7171.
#
# Startup is terminal-based (matching the AppImage): from a shell it stays in
# the foreground; from Finder it re-opens itself in Terminal.app so the access
# URL and the log stay visible.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
RES="$HERE/../Resources"

run() {
    exec "$HERE/kron-host-agent" \
        --resources-root  "$RES/resources" \
        --toolchains-root "$RES/toolchains" \
        "$@"
}

# Attached to a terminal already (launched from a shell) → foreground.
if [ -t 1 ]; then
    run "$@"
fi

# No tty (Finder / Dock launch) → hand ourselves to Terminal.app, which runs
# this same script WITH a tty and so takes the branch above. Not recursive.
exec /usr/bin/open -a Terminal "$HERE/KronEditor"
LAUNCHER
chmod +x "$APP/Contents/MacOS/KronEditor"

# .icns built on the fly from the repo's square PNG with Apple's own tools, so
# no binary icon asset has to be committed to packaging/.
ICONSET="$TMP/kron.iconset"
mkdir -p "$ICONSET"
SRC_PNG="$ROOT/src/assets/icons/plc-icon-square.png"
for sz in 16 32 128 256 512; do
    sips -z "$sz" "$sz" "$SRC_PNG" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null
    sips -z "$((sz * 2))" "$((sz * 2))" "$SRC_PNG" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/kron-editor.icns"

echo "==> 6/7 Ad-hoc code signing"
# ⚠️ On Apple Silicon EVERY Mach-O must carry a signature or the kernel kills it
# outright ("Killed: 9") — there is no unsigned-binary fallback as on Intel. So
# the bundled clang/lld and the agent are signed here, innermost first (a nested
# binary signed after its container invalidates the container's signature).
#
# This is an AD-HOC signature (-s -), not a Developer ID: it satisfies the
# arm64 load-time requirement but NOT Gatekeeper, which additionally wants
# notarization. Hence the quarantine note printed at the end. Notarizing would
# need a paid Developer ID and uploading the whole multi-GB image to Apple.
sign() { codesign --force --sign - --timestamp=none "$1" >/dev/null 2>&1 || true; }

while IFS= read -r bin; do sign "$bin"; done < <(
    find "$APP/Contents/Resources/toolchains/bin" -type f -perm -u+x
)
sign "$APP/Contents/MacOS/kron-host-agent"
codesign --force --sign - --timestamp=none "$APP"

echo "==> 7/7 Packing DMG (compressing several GB — this takes a while)"
# The /Applications symlink is what makes the window a drag-to-install target.
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
# HFS+ because the payload exceeds 4 GB; UDZO is the standard compressed
# read-only image format.
hdiutil create \
    -volname "KronEditor $VERSION" \
    -srcfolder "$STAGE" \
    -fs HFS+ \
    -format UDZO \
    -ov "$OUT" >/dev/null

echo
echo "Done: $OUT  ($(du -h "$OUT" | cut -f1))"
[ "$DARWIN_LIBS_OK" = "1" ] || echo "⚠️  Built WITHOUT resources/$RES_TRIPLE/lib — local simulation will not link."
cat <<EOF

Install: open the DMG, drag KronEditor.app to Applications.

⚠️  The app is ad-hoc signed, not notarized, so Gatekeeper will refuse the first
launch. Clear the quarantine flag once after installing:

    xattr -dr com.apple.quarantine /Applications/KronEditor.app

Then launch it and open http://localhost:7171 in a browser.
Local simulation additionally needs the Xcode Command Line Tools on that Mac:

    xcode-select --install
EOF
