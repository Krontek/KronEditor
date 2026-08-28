#!/usr/bin/env bash
# build.sh - PLC Agent Cross-Compilation Script
#
# Prerequisite:
#   go mod download   (download dependencies)
#
# CGO_ENABLED=0  -> Fully static binary (zero external .so dependency)
# -ldflags="-s -w" -> Strip debug symbols (usually reduces binary size by 30-40%)
# -trimpath       -> Remove build machine paths from binary (security + determinism)

set -euo pipefail

echo "=== Cleaning old binaries and build cache ==="
rm -f dist/plc-agent_linux_armv7 dist/plc-agent_linux_arm64 dist/plc-agent_linux_amd64
go clean -cache
echo ""

VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS="-s -w -X main.Version=${VERSION}"

echo "=== PLC Agent Build ==="
echo "Version: ${VERSION}"
echo ""

# Linux ARM32 (ARMv7 - Raspberry Pi 2/3/4 32-bit OS)
echo "[1/3] Building Linux ARM32 (ARMv7)..."
CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 \
    go build -trimpath -ldflags="${LDFLAGS}" \
    -o dist/plc-agent_linux_armv7 .
echo "      -> dist/plc-agent_linux_armv7"

# Linux ARM64 (AArch64 - Raspberry Pi 3/4/5 64-bit OS, Jetson Nano)
echo "[2/3] Building Linux ARM64 (AArch64)..."
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
    go build -trimpath -ldflags="${LDFLAGS}" \
    -o dist/plc-agent_linux_arm64 .
echo "      -> dist/plc-agent_linux_arm64"

# Linux x86_64 (PC development/test environment)
echo "[3/3] Building Linux x86_64..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="${LDFLAGS}" \
    -o dist/plc-agent_linux_amd64 .
echo "      -> dist/plc-agent_linux_amd64"

echo ""
echo "=== Syncing binaries into resources/ (what 'Deploy Server to Target' ships) ==="
# The host-agent's deploy_server_to_target reads the binary from
# resources/<triple>/server/. Keep it in sync so a rebuild is actually deployed
# (otherwise the editor would ship a stale server).
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
copy_to_resources() {
    local src="$1" triple="$2"
    local dst_dir="${REPO_ROOT}/resources/${triple}/server"
    # ⚠️ Must mkdir -p, not just skip when missing: on a machine that hasn't
    # run "Build Server" from the UI yet (which does create it, via Go
    # os.MkdirAll — see libraries_server.go), resources/<triple>/server/
    # doesn't exist at all, so the old `if [ -d "$dst_dir" ]` guard silently
    # did NOTHING — the Go cross-compile succeeded, dist/ got fresh binaries,
    # but the sync into resources/ (what deploy_server_to_target actually
    # reads) never happened, and nothing here said so. The only symptom was
    # "Deploy Server to Target" refusing with "Server binary not found ...
    # Build the server first" — right after a successful build.
    mkdir -p "$dst_dir"
    cp -f "$src" "$dst_dir/" && echo "      -> resources/${triple}/server/$(basename "$src")"
}
copy_to_resources dist/plc-agent_linux_armv7 arm-linux-gnueabihf
copy_to_resources dist/plc-agent_linux_arm64 aarch64-linux-gnu
copy_to_resources dist/plc-agent_linux_amd64 x86_64-linux-gnu

echo ""
echo "=== Build completed ==="
ls -lh dist/

# Raspberry Pi deployment example
# scp dist/plc-agent_linux_arm64 pi@192.168.1.100:/opt/plc/
# ssh pi@192.168.1.100 "chmod +x /opt/plc/plc-agent_linux_arm64 && \
#     /opt/plc/plc-agent_linux_arm64 \
#         -addr ':7070' \
#         -deploy-dir '/opt/plc' \
#         -shm-name 'plc_runtime' \
#         -shm-size 65536 \
#         -log-level 'info'"

# Systemd service (/etc/systemd/system/plc-agent.service)
# SOEM requires root (CAP_NET_RAW) for raw EtherCAT socket access.
#
# Option A — run plc-agent as root (simplest):
#
# [Unit]
# Description=PLC Deployment & Debug Agent
# After=network.target
#
# [Service]
# ExecStart=/opt/plc/plc-agent_linux_arm64 -addr :7070 -deploy-dir /opt/plc -log-level info
# Restart=always
# RestartSec=5
# User=root
#
# [Install]
# WantedBy=multi-user.target
#
# Option B — run as dedicated user with only the needed capabilities:
#
# [Unit]
# Description=PLC Deployment & Debug Agent
# After=network.target
#
# [Service]
# ExecStart=/opt/plc/plc-agent_linux_arm64 -addr :7070 -deploy-dir /opt/plc -log-level info
# Restart=always
# RestartSec=5
# User=plc
# AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN
# CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN
# # Also allow spawned runtime.bin to inherit capabilities:
# # setcap 'cap_net_raw,cap_net_admin+eip' /opt/plc/runtime.bin
#
# [Install]
# WantedBy=multi-user.target
#
# Option B sudoers entry (if not using systemd capabilities):
#   echo "plc ALL=(root) NOPASSWD: /opt/plc/runtime.bin" > /etc/sudoers.d/plc-runtime
#   chmod 0440 /etc/sudoers.d/plc-runtime
