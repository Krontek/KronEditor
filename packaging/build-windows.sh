#!/usr/bin/env bash
# Build the KronEditor Windows installer. Runs ON LINUX — Go cross-compiles the
# agent and NSIS cross-builds the installer, so no Windows machine is involved.
#
#   packaging/build-windows.sh
#
# Produces exactly ONE artifact:
#   packaging/KronEditor-Setup-x64.exe
#
# A real installer (install dir choice, Start-Menu + optional desktop shortcut,
# uninstaller, Add/Remove Programs entry) carrying everything the target machine
# needs — nothing else to install:
#   - kron-host-agent.exe  (Windows/amd64, the Vite frontend is embedded)
#   - resources\           (Krontek libraries + the shared krontek-include headers)
#   - toolchains\          (WINDOWS-host clang.exe/lld + the shared target
#                           sysroots → Build & Send to an ARM PLC works offline)
#
# ⚠️ LOCAL SIMULATION IS LINUX-ONLY and therefore not available in this build.
# The runtime reads /proc/<pid>/mem and /dev/shm and hot-swap needs dlopen +
# SIGUSR1 (host-agent/hotswap_signal_windows.go returns an explicit error). That
# is a runtime limitation, not a packaging one — no bundling can fix it. The
# editor, the transpiler, the AI agent and Build & Send to a real PLC all work.
#
# ⚠️ Everything transient goes to packaging/tmpwin/ and is deleted on exit, so
# packaging/ only ever holds the two build scripts and the two artifacts. Set
# KEEP_TMP=1 to keep the staging tree when debugging a build.
# (The AppImage script stages in packaging/tmplinux/ — separate roots, so the
#  two builds can run at the same time without one deleting the other's tree.)
#
# Build host needs: go, node/npm, python3, curl, and makensis — if makensis is
# absent the script provisions NSIS into ~/.cache/kron-editor-packaging/ from
# the distro archive with `apt-get download` (NO sudo, nothing installed
# system-wide).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packaging"
TMP="$PKG/tmpwin"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/kron-editor-packaging"
PAYLOAD="$TMP/payload"
OUT="$PKG/KronEditor-Setup-x64.exe"

cleanup() {
    if [ "${KEEP_TMP:-0}" = "1" ]; then
        echo "KEEP_TMP=1 — staging kept at $TMP"
        return
    fi
    rm -rf "$TMP"
}
trap cleanup EXIT

rm -rf "$TMP"
mkdir -p "$PAYLOAD" "$CACHE"

# Single source of truth for the version: package.json (§4 of CLAUDE.md).
VERSION="$(node -p "require('$ROOT/package.json').version")"

echo "==> 1/6 Frontend (v$VERSION)"
( cd "$ROOT" && npm run build:frontend )

echo "==> 2/6 Host agent (windows/amd64)"
# ⚠️ Release invariant: this cross-build must keep succeeding (CLAUDE.md §4).
( cd "$ROOT/host-agent" && GOOS=windows GOARCH=amd64 \
    go build -ldflags "-X main.appVersion=$VERSION" -o "$PAYLOAD/kron-host-agent.exe" . )

echo "==> 3/6 Resources"
cp -a --reflink=auto "$ROOT/resources" "$PAYLOAD/resources"

echo "==> 4/6 Toolchains (windows clang.exe + shared sysroots)"
SRC_TC="$ROOT/toolchains"      # linux-built; the SYSROOTS are host-independent
WIN_TC="$ROOT/toolchains-win"  # persistent windows-host LLVM, downloaded once
if [ ! -d "$SRC_TC/sysroots" ]; then
    echo "    ERROR: repo-root toolchains/ has no sysroots." >&2
    echo "           Run: python3 setup_toolchain.py --host linux" >&2
    exit 1
fi
if [ ! -x "$WIN_TC/bin/clang.exe" ]; then
    echo "    fetching Windows LLVM once → toolchains-win/"
    python3 "$ROOT/setup_toolchain.py" --host windows --only llvm --root "$WIN_TC"
fi
mkdir -p "$PAYLOAD/toolchains"
cp -a --reflink=auto "$WIN_TC/bin"      "$PAYLOAD/toolchains/bin"      # clang.exe + lld
cp -a --reflink=auto "$WIN_TC/lib"      "$PAYLOAD/toolchains/lib"      # clang builtin headers
cp -a --reflink=auto "$SRC_TC/sysroots" "$PAYLOAD/toolchains/sysroots" # shared target sysroots
cp -a "$SRC_TC"/*.json "$PAYLOAD/toolchains/" 2>/dev/null || true

echo "==> 5/6 Locating makensis"
# Prefer a system makensis. Otherwise unpack the distro's nsis packages into the
# cache with dpkg -x — this needs NO root and installs nothing system-wide, so a
# dev box is never modified just to cut a release.
MAKENSIS="$(command -v makensis || true)"
NSISDIR=""
if [ -z "$MAKENSIS" ]; then
    NSIS_ROOT="$CACHE/nsis"
    if [ ! -x "$NSIS_ROOT/usr/bin/makensis" ]; then
        echo "    makensis not installed — unpacking nsis into $NSIS_ROOT (no sudo)"
        if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg >/dev/null 2>&1; then
            echo "    ERROR: makensis not found and this is not a dpkg-based distro." >&2
            echo "           Install NSIS (e.g. 'apt install nsis' / 'dnf install mingw32-nsis')" >&2
            echo "           and re-run." >&2
            exit 1
        fi
        DEBS="$CACHE/nsis-debs"
        mkdir -p "$DEBS" "$NSIS_ROOT"
        ( cd "$DEBS" && apt-get download nsis nsis-common )
        for d in "$DEBS"/*.deb; do dpkg -x "$d" "$NSIS_ROOT"; done
        rm -rf "$DEBS"
    fi
    MAKENSIS="$NSIS_ROOT/usr/bin/makensis"
    # An unpacked (not installed) NSIS cannot find its stubs/plugins by the
    # compiled-in prefix — point it at the unpacked share tree.
    NSISDIR="$NSIS_ROOT/usr/share/nsis"
fi
echo "    using $MAKENSIS ($("$MAKENSIS" -VERSION 2>/dev/null || echo '?'))"

echo "==> 6/6 Building installer (LZMA solid — this takes a while)"
# ⚠️ Generated here rather than kept as packaging/windows/*.iss: packaging/ must
# contain nothing but the two scripts and the two artifacts.
#
# NSIS rather than Inno Setup: makensis runs natively on Linux, so the whole
# release is cut from one machine with no Windows box and no Wine. (The old
# flow produced a payload zip and left the .exe step to `iscc` run manually on
# Windows — which meant "build-windows.sh" never actually produced an exe.)
cat > "$TMP/installer.nsi" <<NSI
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APPNAME    "KronEditor"
!define APPVERSION "$VERSION"
!define APPEXE     "kron-host-agent.exe"
!define APPURL     "http://localhost:7171"
!define REGKEY     "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${APPNAME}"

Name "\${APPNAME} \${APPVERSION}"
OutFile "$OUT"
InstallDir "\$PROGRAMFILES64\\\${APPNAME}"
InstallDirRegKey HKLM "Software\\\${APPNAME}" "InstallDir"
; Program Files needs elevation; the agent writes its build output to %APPDATA%
; at runtime, so the installed tree can stay read-only.
RequestExecutionLevel admin
; The payload is multi-GB of already-compressed LLVM binaries. Solid LZMA still
; pays off here because the sysroots hold many small, similar text headers.
SetCompressor /SOLID lzma
SetCompressorDictSize 64

VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName"     "\${APPNAME}"
VIAddVersionKey "FileDescription" "IEC 61131-3 PLC editor"
VIAddVersionKey "FileVersion"     "\${APPVERSION}"
VIAddVersionKey "ProductVersion"  "\${APPVERSION}"
VIAddVersionKey "LegalCopyright"  ""

!define MUI_ABORTWARNING
!define MUI_ICON   "\${NSISDIR}\\Contrib\\Graphics\\Icons\\modern-install.ico"
!define MUI_UNICON "\${NSISDIR}\\Contrib\\Graphics\\Icons\\modern-uninstall.ico"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
; Offer to start the agent; it opens a console window and prints the URL.
!define MUI_FINISHPAGE_RUN "\$INSTDIR\\\${APPEXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start \${APPNAME} (then open \${APPURL})"
!define MUI_FINISHPAGE_LINK "Open \${APPURL}"
!define MUI_FINISHPAGE_LINK_LOCATION "\${APPURL}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
    SetOutPath "\$INSTDIR"
    File /r "$PAYLOAD\\*.*"

    CreateDirectory "\$SMPROGRAMS\\\${APPNAME}"
    CreateShortcut "\$SMPROGRAMS\\\${APPNAME}\\\${APPNAME}.lnk" "\$INSTDIR\\\${APPEXE}"
    CreateShortcut "\$SMPROGRAMS\\\${APPNAME}\\Open \${APPNAME} (\${APPURL}).lnk" "\${APPURL}"
    CreateShortcut "\$SMPROGRAMS\\\${APPNAME}\\Uninstall.lnk" "\$INSTDIR\\uninstall.exe"
    CreateShortcut "\$DESKTOP\\\${APPNAME}.lnk" "\$INSTDIR\\\${APPEXE}"

    WriteRegStr HKLM "Software\\\${APPNAME}" "InstallDir" "\$INSTDIR"
    WriteUninstaller "\$INSTDIR\\uninstall.exe"

    ; Add/Remove Programs entry, with the real on-disk size so Windows does not
    ; report a multi-GB install as 0 KB.
    WriteRegStr   HKLM "\${REGKEY}" "DisplayName"     "\${APPNAME}"
    WriteRegStr   HKLM "\${REGKEY}" "DisplayVersion"  "\${APPVERSION}"
    WriteRegStr   HKLM "\${REGKEY}" "DisplayIcon"     "\$INSTDIR\\\${APPEXE}"
    WriteRegStr   HKLM "\${REGKEY}" "InstallLocation" "\$INSTDIR"
    WriteRegStr   HKLM "\${REGKEY}" "UninstallString" '"\$INSTDIR\\uninstall.exe"'
    WriteRegDWORD HKLM "\${REGKEY}" "NoModify" 1
    WriteRegDWORD HKLM "\${REGKEY}" "NoRepair" 1
    \${GetSize} "\$INSTDIR" "/S=0K" \$0 \$1 \$2
    IntFmt \$0 "0x%08X" \$0
    WriteRegDWORD HKLM "\${REGKEY}" "EstimatedSize" "\$0"
SectionEnd

Section "Uninstall"
    Delete "\$DESKTOP\\\${APPNAME}.lnk"
    RMDir /r "\$SMPROGRAMS\\\${APPNAME}"
    ; Only the directories we installed — never a blind RMDir /r on \$INSTDIR,
    ; which would take anything the user put beside it with it.
    RMDir /r "\$INSTDIR\\resources"
    RMDir /r "\$INSTDIR\\toolchains"
    Delete "\$INSTDIR\\\${APPEXE}"
    Delete "\$INSTDIR\\uninstall.exe"
    RMDir "\$INSTDIR"
    DeleteRegKey HKLM "\${REGKEY}"
    DeleteRegKey HKLM "Software\\\${APPNAME}"
SectionEnd
NSI

rm -f "$OUT"
if [ -n "$NSISDIR" ]; then
    NSISDIR="$NSISDIR" "$MAKENSIS" -V2 "$TMP/installer.nsi"
else
    "$MAKENSIS" -V2 "$TMP/installer.nsi"
fi

echo
echo "Done: $OUT  ($(du -h "$OUT" | cut -f1))"
echo "On Windows: run it, then start KronEditor and open http://localhost:7171."
echo "(Local simulation is Linux-only — see the note at the top of this script.)"
