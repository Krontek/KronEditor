#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
FIXED_TOOLCHAIN_ROOT = SCRIPT_DIR / "src-tauri" / "toolchains"

LLVM_VERSION = "21.1.6"
LLVM_RELEASE_TAG = f"llvmorg-{LLVM_VERSION}"
LLVM_RELEASE_API = f"https://api.github.com/repos/llvm/llvm-project/releases/tags/{LLVM_RELEASE_TAG}"

ARM_NONE_EABI_VERSION = "10.3-2021.07"
ARM_NONE_EABI_ARCHIVE = f"gcc-arm-none-eabi-{ARM_NONE_EABI_VERSION}-x86_64-linux.tar.bz2"
ARM_NONE_EABI_URL = (
    f"https://developer.arm.com/-/media/Files/downloads/gnu-rm/{ARM_NONE_EABI_VERSION}/"
    f"{ARM_NONE_EABI_ARCHIVE}"
)

ARM_LINUX_VERSION = "10.2-2020.11"
ARM_LINUX_BASE = f"https://developer.arm.com/-/media/Files/downloads/gnu-a/{ARM_LINUX_VERSION}/binrel"
ARM_AARCH64_ARCHIVE = f"gcc-arm-{ARM_LINUX_VERSION}-x86_64-aarch64-none-linux-gnu.tar.xz"
ARM_AARCH64_URL = f"{ARM_LINUX_BASE}/{ARM_AARCH64_ARCHIVE}"
ARM_ARMHF_ARCHIVE = f"gcc-arm-{ARM_LINUX_VERSION}-x86_64-arm-none-linux-gnueabihf.tar.xz"
ARM_ARMHF_URL = f"{ARM_LINUX_BASE}/{ARM_ARMHF_ARCHIVE}"

BOOTLIN_X86_64_ARCHIVE = "x86-64-core-i7--glibc--stable-2020.08-1.tar.bz2"
BOOTLIN_X86_64_URL = (
    "https://toolchains.bootlin.com/downloads/releases/toolchains/x86-64-core-i7/tarballs/"
    f"{BOOTLIN_X86_64_ARCHIVE}"
)

LLVM_MINGW_VERSION = "20251118"
LLVM_MINGW_RELEASE_API = (
    f"https://api.github.com/repos/mstorsjo/llvm-mingw/releases/tags/{LLVM_MINGW_VERSION}"
)

LLVM_BINARIES = [
    "clang",
    "clang++",
    "clang-cl",
    "ld.lld",
    "lld-link",
    "llvm-ar",
    "llvm-ranlib",
    "llvm-objcopy",
    "llvm-strip",
    "llvm-readelf",
]

TARGETS = {
    "arm-none-eabi": "Bare-metal ARM",
    "aarch64-linux-gnu": "Embedded Linux 64-bit",
    "arm-linux-gnueabihf": "Embedded Linux 32-bit",
    "x86_64-linux-gnu": "Industrial PC Linux",
    "x86_64-w64-mingw32": "Industrial PC Windows",
    "simulation_env": "Host-side mock headers",
}


class SetupError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"[toolchains] {message}")


def detect_host(host_override: str | None = None) -> tuple[str, str]:
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "linux":
        host_os = "linux"
    elif system == "darwin":
        host_os = "macos"
    elif system == "windows":
        host_os = "windows"
    else:
        raise SetupError(f"Unsupported host OS: {platform.system()}")

    if machine in {"x86_64", "amd64"}:
        host_arch = "x86_64"
    elif machine in {"arm64", "aarch64"}:
        host_arch = "arm64"
    else:
        raise SetupError(f"Unsupported host architecture: {platform.machine()}")

    if host_override:
        host_os = host_override

    return host_os, host_arch


def executable_name(name: str, host_os: str) -> str:
    return f"{name}.exe" if host_os == "windows" else name


def ensure_executable(path: Path) -> None:
    if not path.exists() or path.is_dir():
        return
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def request_json(url: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "KronEditor-toolchains-bootstrap"},
    )
    with urllib.request.urlopen(req) as response:
        return json.loads(response.read().decode("utf-8"))


def download(url: str, destination: Path, force_download: bool) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and not force_download:
        log(f"Using cached archive {destination.name}")
        return destination

    log(f"Downloading {url}")
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "KronEditor-toolchains-bootstrap"},
    )
    with urllib.request.urlopen(req) as response, destination.open("wb") as out:
        shutil.copyfileobj(response, out)
    return destination


def _is_within_directory(base: Path, target: Path) -> bool:
    try:
        target.relative_to(base)
        return True
    except ValueError:
        return False


def safe_extract_tar(archive: Path, destination: Path) -> None:
    with tarfile.open(archive, "r:*") as tf:
        for member in tf.getmembers():
            member_path = destination / member.name
            if not _is_within_directory(destination, member_path.resolve()):
                raise SetupError(f"Unsafe tar path detected: {member.name}")
        try:
            tf.extractall(destination, filter="data")
        except TypeError:
            tf.extractall(destination)


def safe_extract_zip(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive, "r") as zf:
        for member in zf.infolist():
            member_path = destination / member.filename
            if not _is_within_directory(destination, member_path.resolve()):
                raise SetupError(f"Unsafe zip path detected: {member.filename}")
        zf.extractall(destination)


def extract_archive(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    suffixes = "".join(archive.suffixes).lower()
    log(f"Extracting {archive.name}")
    if suffixes.endswith((".tar.xz", ".tar.gz", ".tar.bz2", ".tgz", ".tbz2")):
        safe_extract_tar(archive, destination)
    elif suffixes.endswith(".zip"):
        safe_extract_zip(archive, destination)
    else:
        raise SetupError(f"Unsupported archive type: {archive.name}")


def remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists():
        shutil.rmtree(path)


def reset_directory(path: Path) -> None:
    remove_path(path)
    path.mkdir(parents=True, exist_ok=True)


def copy_tree(src: Path, dst: Path) -> None:
    if not src.exists():
        raise SetupError(f"Missing source path: {src}")
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, symlinks=True)


def copy_contents(src: Path, dst: Path) -> None:
    if not src.exists():
        raise SetupError(f"Missing source path: {src}")
    dst.mkdir(parents=True, exist_ok=True)
    for entry in src.iterdir():
        target = dst / entry.name
        if entry.is_dir():
            copy_tree(entry, target)
        else:
            if target.exists():
                target.unlink()
            shutil.copy2(entry, target)


def prune_sysroot_runtime_noise(sysroot_dir: Path) -> None:
    removable_dirs = [
        "dev",
        "proc",
        "sys",
        "run",
        "tmp",
        "mnt",
        "media",
        "opt",
        "root",
        "home",
        "srv",
        "var",
    ]
    removable_files = [
        "etc/mtab",
        "etc/resolv.conf",
        "etc/hosts",
        "etc/passwd",
        "etc/group",
        "etc/shadow",
    ]

    for rel in removable_dirs:
        remove_path(sysroot_dir / rel)

    for rel in removable_files:
        remove_path(sysroot_dir / rel)

    for current_root, dirs, files in os.walk(sysroot_dir, topdown=False):
        current = Path(current_root)
        for name in files:
            path = current / name
            if path.is_symlink() and not path.resolve(strict=False).exists():
                path.unlink(missing_ok=True)
        for name in dirs:
            path = current / name
            if path.is_symlink() and not path.resolve(strict=False).exists():
                path.unlink(missing_ok=True)


def find_dir(root: Path, predicate) -> Path:
    for current_root, dirs, files in os.walk(root):
        candidate = Path(current_root)
        if predicate(candidate, dirs, files):
            return candidate
    raise SetupError(f"Expected directory not found under {root}")


def find_path(root: Path, relative_path: str) -> Path:
    relative = Path(relative_path)
    candidate = root / relative
    if candidate.exists():
        return candidate
    for current_root, _dirs, _files in os.walk(root):
        current = Path(current_root)
        candidate = current / relative
        if candidate.exists():
            return candidate
    raise SetupError(f"Could not find {relative_path} under {root}")


def choose_llvm_asset(release: dict, host_os: str, host_arch: str) -> dict:
    version = re.escape(LLVM_VERSION)
    patterns = {
        ("linux", "x86_64"): [
            rf"^(LLVM|clang\+llvm)-{version}-(Linux-X64|x86_64-linux-gnu-ubuntu-.*)\.(tar\.xz|zip)$",
        ],
        ("macos", "x86_64"): [
            rf"^(LLVM|clang\+llvm)-{version}-(macOS-X64|x86_64-apple-darwin.*)\.(tar\.xz|zip)$",
        ],
        ("macos", "arm64"): [
            rf"^(LLVM|clang\+llvm)-{version}-(macOS-ARM64|arm64-apple-darwin.*)\.(tar\.xz|zip)$",
        ],
        ("windows", "x86_64"): [
            rf"^(clang\+llvm)-{version}-x86_64-pc-windows-msvc\.(zip|tar\.xz)$",
            rf"^LLVM-{version}-(win64|Windows-AMD64|windows-x64)\.(zip|tar\.xz)$",
        ],
        ("windows", "arm64"): [
            rf"^(clang\+llvm)-{version}-aarch64-pc-windows-msvc\.(zip|tar\.xz)$",
            rf"^LLVM-{version}-(woa64|Windows-ARM64|windows-arm64)\.(zip|tar\.xz)$",
        ],
    }
    assets = release.get("assets", [])
    for pattern in patterns.get((host_os, host_arch), []):
        regex = re.compile(pattern, re.IGNORECASE)
        for asset in assets:
            if regex.match(asset["name"]):
                return asset
    names = ", ".join(asset["name"] for asset in assets[:20])
    raise SetupError(f"No LLVM asset matched {host_os}/{host_arch}. Assets seen: {names}")


def install_llvm(host_os: str, host_arch: str, root: Path, cache_dir: Path, force: bool, force_download: bool) -> None:
    clang_bin = root / "bin" / executable_name("clang", host_os)
    clang_resource_dir = root / "lib" / "clang"
    if clang_bin.exists() and clang_resource_dir.exists() and not force:
        log("LLVM already installed; skipping")
        return

    release = request_json(LLVM_RELEASE_API)
    asset = choose_llvm_asset(release, host_os, host_arch)
    archive = download(asset["browser_download_url"], cache_dir / asset["name"], force_download)

    with tempfile.TemporaryDirectory(prefix="kron-llvm-") as tmp:
        extract_root = Path(tmp)
        extract_archive(archive, extract_root)
        package_root = find_dir(
            extract_root,
            lambda candidate, _dirs, _files: (candidate / "bin" / executable_name("clang", host_os)).exists(),
        )

        if force:
            remove_path(root / "bin")
            remove_path(root / "lib" / "clang")

        (root / "bin").mkdir(parents=True, exist_ok=True)
        (root / "lib").mkdir(parents=True, exist_ok=True)

        for binary in LLVM_BINARIES:
            source = package_root / "bin" / executable_name(binary, host_os)
            if source.exists():
                target = root / "bin" / source.name
                shutil.copy2(source, target)
                ensure_executable(target)

        builtin_headers = package_root / "lib" / "clang"
        if not builtin_headers.exists():
            raise SetupError("LLVM package does not contain lib/clang")
        copy_tree(builtin_headers, root / "lib" / "clang")


def harvest_arm_none_eabi(root: Path, cache_dir: Path, force: bool, force_download: bool) -> None:
    destination = root / "sysroots" / "arm-none-eabi"
    if destination.exists() and not force:
        log("arm-none-eabi already installed; skipping")
        return

    archive = download(ARM_NONE_EABI_URL, cache_dir / ARM_NONE_EABI_ARCHIVE, force_download)
    with tempfile.TemporaryDirectory(prefix="kron-arm-none-eabi-") as tmp:
        extract_root = Path(tmp)
        extract_archive(archive, extract_root)
        toolchains_root = find_dir(
            extract_root,
            lambda candidate, _dirs, _files: (candidate / "arm-none-eabi" / "include").exists(),
        )

        staging = extract_root / "_harvest"
        reset_directory(staging)
        copy_tree(toolchains_root / "arm-none-eabi", staging / "arm-none-eabi")

        gcc_root = toolchains_root / "lib" / "gcc" / "arm-none-eabi"
        if gcc_root.exists():
            copy_tree(gcc_root, staging / "lib" / "gcc" / "arm-none-eabi")

        clang_rt_root = toolchains_root / "lib" / "clang-runtimes" / "arm-none-eabi"
        if clang_rt_root.exists():
            copy_tree(clang_rt_root, staging / "clang-runtimes" / "arm-none-eabi")

        remove_path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staging), str(destination))


def harvest_linux_libc_sysroot(
    *,
    root: Path,
    cache_dir: Path,
    force: bool,
    force_download: bool,
    target_name: str,
    archive_url: str,
    archive_name: str,
    archive_relative_path: str,
    gcc_lib_relative_path: str | None = None,
) -> None:
    destination = root / "sysroots" / target_name
    if destination.exists() and not force:
        log(f"{target_name} already installed; skipping")
        return

    archive = download(archive_url, cache_dir / archive_name, force_download)
    with tempfile.TemporaryDirectory(prefix=f"kron-{target_name}-") as tmp:
        extract_root = Path(tmp)
        extract_archive(archive, extract_root)
        sysroot_src = find_path(extract_root, archive_relative_path)

        staging = extract_root / "_harvest"
        reset_directory(staging)
        copy_contents(sysroot_src, staging)
        prune_sysroot_runtime_noise(staging)

        # Also harvest GCC lib directory so Clang can find crtbeginS.o / libgcc.a
        if gcc_lib_relative_path:
            try:
                gcc_src = find_path(extract_root, gcc_lib_relative_path)
                gcc_dst = staging / "lib" / "gcc"
                gcc_dst.parent.mkdir(parents=True, exist_ok=True)
                copy_tree(gcc_src, gcc_dst)
                log(f"  GCC runtime harvested into sysroot/lib/gcc/")
            except SetupError:
                log(f"  WARN: GCC lib not found at {gcc_lib_relative_path}, skipping")

        remove_path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staging), str(destination))


def choose_llvm_mingw_asset(release: dict) -> dict:
    regexes = [
        re.compile(
            rf"^llvm-mingw-{LLVM_MINGW_VERSION}-ucrt-ubuntu-.*-x86_64\.tar\.xz$",
            re.IGNORECASE,
        ),
        re.compile(
            rf"^llvm-mingw-{LLVM_MINGW_VERSION}-ucrt-ubuntu-.*\.tar\.xz$",
            re.IGNORECASE,
        ),
    ]
    assets = release.get("assets", [])
    for regex in regexes:
        for asset in assets:
            if regex.match(asset["name"]):
                return asset
    names = ", ".join(asset["name"] for asset in assets[:20])
    raise SetupError(f"No llvm-mingw asset matched expected naming. Assets seen: {names}")


def harvest_mingw_sysroot(root: Path, cache_dir: Path, force: bool, force_download: bool) -> None:
    destination = root / "sysroots" / "x86_64-w64-mingw32"
    if destination.exists() and not force:
        log("x86_64-w64-mingw32 already installed; skipping")
        return

    release = request_json(LLVM_MINGW_RELEASE_API)
    asset = choose_llvm_mingw_asset(release)
    archive = download(asset["browser_download_url"], cache_dir / asset["name"], force_download)

    with tempfile.TemporaryDirectory(prefix="kron-mingw-") as tmp:
        extract_root = Path(tmp)
        extract_archive(archive, extract_root)
        package_root = find_dir(
            extract_root,
            lambda candidate, dirs, _files: "x86_64-w64-mingw32" in dirs and "include" in dirs and "lib" in dirs,
        )

        staging = extract_root / "_harvest"
        reset_directory(staging)
        for name in ("include", "lib", "share", "generic-w64-mingw32", "x86_64-w64-mingw32"):
            source = package_root / name
            if source.exists():
                copy_tree(source, staging / name)

        # x86_64-w64-mingw32/include is a symlink in the archive pointing to
        # ../generic-w64-mingw32/include. Python's filter="data" drops symlinks
        # during extraction, so we must populate the triplet include explicitly.
        triplet_inc = staging / "x86_64-w64-mingw32" / "include"
        generic_inc = staging / "generic-w64-mingw32" / "include"
        root_inc    = staging / "include"
        if triplet_inc.is_symlink():
            triplet_inc.unlink()
        if not triplet_inc.exists() or not any(triplet_inc.iterdir()):
            if generic_inc.exists():
                copy_tree(generic_inc, triplet_inc)
            elif root_inc.exists():
                copy_tree(root_inc, triplet_inc)

        remove_path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staging), str(destination))


def simulation_mock_header() -> str:
    return """#ifndef KRON_MOCK_IO_H
#define KRON_MOCK_IO_H

#include <stdint.h>
#include <stdio.h>

#ifdef __cplusplus
extern "C" {
#endif

static inline void digitalWrite(int pin, int value) {
    fprintf(stderr, "[kron_mock_io] digitalWrite(pin=%d, value=%d)\\n", pin, value);
}

static inline int digitalRead(int pin) {
    fprintf(stderr, "[kron_mock_io] digitalRead(pin=%d) -> 0\\n", pin);
    return 0;
}

static inline void analogWrite(int pin, int value) {
    fprintf(stderr, "[kron_mock_io] analogWrite(pin=%d, value=%d)\\n", pin, value);
}

static inline int analogRead(int pin) {
    fprintf(stderr, "[kron_mock_io] analogRead(pin=%d) -> 0\\n", pin);
    return 0;
}

static inline void pwmWrite(int pin, float duty_cycle) {
    fprintf(stderr, "[kron_mock_io] pwmWrite(pin=%d, duty_cycle=%0.3f)\\n", pin, (double)duty_cycle);
}

static inline void pinMode(int pin, int mode) {
    fprintf(stderr, "[kron_mock_io] pinMode(pin=%d, mode=%d)\\n", pin, mode);
}

static inline void delay(unsigned int ms) {
    fprintf(stderr, "[kron_mock_io] delay(ms=%u)\\n", ms);
}

static inline void delayMicroseconds(unsigned int us) {
    fprintf(stderr, "[kron_mock_io] delayMicroseconds(us=%u)\\n", us);
}

#ifdef __cplusplus
}
#endif

#endif
"""


def write_simulation_env(root: Path, force: bool) -> None:
    destination = root / "sysroots" / "simulation_env"
    include_dir = destination / "include"
    lib_dir = destination / "lib"
    if force:
        remove_path(destination)
    include_dir.mkdir(parents=True, exist_ok=True)
    lib_dir.mkdir(parents=True, exist_ok=True)
    (include_dir / "kron_mock_io.h").write_text(simulation_mock_header(), encoding="utf-8")
    (lib_dir / ".gitkeep").write_text("", encoding="utf-8")


def command_templates(llvm_version: str) -> dict:
    return {
        "schema_version": 1,
        "llvm_version": llvm_version,
        "layout": {
            "bin": "toolchains/bin",
            "resource_dir": f"toolchains/lib/clang/{llvm_version}",
            "sysroots": "toolchains/sysroots",
        },
        "common": {
            "compile_flags": [
                "-ffunction-sections",
                "-fdata-sections",
                "-fno-common",
                "-Wall",
                "-Wextra",
                "-g",
                "-O2",
            ],
            "link_flags": [
                "-fuse-ld=lld",
                "-Wl,--gc-sections",
            ],
        },
        "targets": {
            "aarch64-linux-gnu": {
                "triple": "aarch64-linux-gnu",
                "sysroot": "toolchains/sysroots/aarch64-linux-gnu",
                "compile": [
                    "toolchains/bin/clang",
                    "--target=aarch64-linux-gnu",
                    "--sysroot=toolchains/sysroots/aarch64-linux-gnu",
                    "-resource-dir",
                    f"toolchains/lib/clang/{llvm_version}",
                    "-mcpu=cortex-a72",
                    "-c",
                    "${source}",
                    "-o",
                    "${object}",
                    "@common.compile_flags",
                ],
                "link": [
                    "toolchains/bin/clang",
                    "--target=aarch64-linux-gnu",
                    "--sysroot=toolchains/sysroots/aarch64-linux-gnu",
                    "-resource-dir",
                    f"toolchains/lib/clang/{llvm_version}",
                    "${object}",
                    "-Wl,--dynamic-linker=/lib/ld-linux-aarch64.so.1",
                    "-lpthread",
                    "-ldl",
                    "-lm",
                    "-o",
                    "${output}",
                    "@common.link_flags",
                ],
            },
            "arm-linux-gnueabihf": {
                "triple": "arm-linux-gnueabihf",
                "sysroot": "toolchains/sysroots/arm-linux-gnueabihf",
                "compile": [
                    "toolchains/bin/clang",
                    "--target=arm-linux-gnueabihf",
                    "--sysroot=toolchains/sysroots/arm-linux-gnueabihf",
                    "-resource-dir",
                    f"toolchains/lib/clang/{llvm_version}",
                    "-mcpu=cortex-a8",
                    "-mfpu=neon",
                    "-mfloat-abi=hard",
                    "-c",
                    "${source}",
                    "-o",
                    "${object}",
                    "@common.compile_flags",
                ],
                "link": [
                    "toolchains/bin/clang",
                    "--target=arm-linux-gnueabihf",
                    "--sysroot=toolchains/sysroots/arm-linux-gnueabihf",
                    "-resource-dir",
                    f"toolchains/lib/clang/{llvm_version}",
                    "${object}",
                    "-Wl,--dynamic-linker=/lib/ld-linux-armhf.so.3",
                    "-lpthread",
                    "-ldl",
                    "-lm",
                    "-o",
                    "${output}",
                    "@common.link_flags",
                ],
            },
            "x86_64-linux-gnu": {
                "triple": "x86_64-linux-gnu",
                "sysroot": "toolchains/sysroots/x86_64-linux-gnu",
                "compile": [
                    "toolchains/bin/clang",
                    "--target=x86_64-linux-gnu",
                    "--sysroot=toolchains/sysroots/x86_64-linux-gnu",
                    "-resource-dir",
                    f"toolchains/lib/clang/{llvm_version}",
                    "-c",
                    "${source}",
                    "-o",
                    "${object}",
                    "@common.compile_flags",
                ],
                "link": [
                    "toolchains/bin/clang",
                    "--target=x86_64-linux-gnu",
                    "--sysroot=toolchains/sysroots/x86_64-linux-gnu",
                    "-resource-dir",
                    f"toolchains/lib/clang/{llvm_version}",
                    "${object}",
                    "-lpthread",
                    "-ldl",
                    "-lm",
                    "-o",
                    "${output}",
                    "@common.link_flags",
                ],
            },
            "x86_64-w64-mingw32": {
                "triple": "x86_64-w64-mingw32",
                "sysroot": "toolchains/sysroots/x86_64-w64-mingw32",
                "compile": [
                    "toolchains/bin/clang",
                    "--target=x86_64-w64-mingw32",
                    "--sysroot=toolchains/sysroots/x86_64-w64-mingw32",
                    "-resource-dir",
                    f"toolchains/lib/clang/{llvm_version}",
                    "-c",
                    "${source}",
                    "-o",
                    "${object}",
                    "@common.compile_flags",
                ],
                "link": [
                    "toolchains/bin/clang",
                    "--target=x86_64-w64-mingw32",
                    "--sysroot=toolchains/sysroots/x86_64-w64-mingw32",
                    "-resource-dir",
                    f"toolchains/lib/clang/{llvm_version}",
                    "${object}",
                    "-lws2_32",
                    "-lwinmm",
                    "-liphlpapi",
                    "-lole32",
                    "-o",
                    "${output}.exe",
                    "@common.link_flags",
                ],
            },
            "arm-none-eabi": {
                "triple": "arm-none-eabi",
                "sysroot": "toolchains/sysroots/arm-none-eabi",
                "compile": [
                    "toolchains/bin/clang",
                    "--target=arm-none-eabi",
                    "--sysroot=toolchains/sysroots/arm-none-eabi",
                    "-resource-dir",
                    f"toolchains/lib/clang/{llvm_version}",
                    "-mcpu=cortex-m4",
                    "-mthumb",
                    "-ffreestanding",
                    "-fno-exceptions",
                    "-c",
                    "${source}",
                    "-o",
                    "${object}",
                    "@common.compile_flags",
                ],
                "link": [
                    "toolchains/bin/clang",
                    "--target=arm-none-eabi",
                    "--sysroot=toolchains/sysroots/arm-none-eabi",
                    "-resource-dir",
                    f"toolchains/lib/clang/{llvm_version}",
                    "-mcpu=cortex-m4",
                    "-mthumb",
                    "-nostartfiles",
                    "-Wl,-T,${linker_script}",
                    "${object}",
                    "-Ltoolchains/sysroots/arm-none-eabi/arm-none-eabi/lib",
                    "-Ltoolchains/sysroots/arm-none-eabi/lib/gcc/arm-none-eabi",
                    "-lc",
                    "-lm",
                    "-lgcc",
                    "-o",
                    "${output}",
                    "@common.link_flags",
                ],
            },
            "simulation_env": {
                "triple": "${host_triple}",
                "include_overlay": "toolchains/sysroots/simulation_env/include",
                "compile": [
                    "toolchains/bin/clang",
                    "--target=${host_triple}",
                    "-resource-dir",
                    f"toolchains/lib/clang/{llvm_version}",
                    "-DKRON_SIMULATION=1",
                    "-Itoolchains/sysroots/simulation_env/include",
                    "-c",
                    "${source}",
                    "-o",
                    "${object}",
                    "@common.compile_flags",
                ],
            },
        },
    }


def write_command_templates(root: Path) -> None:
    path = root / "clang-command-templates.json"
    path.write_text(json.dumps(command_templates(LLVM_VERSION), indent=2) + "\n", encoding="utf-8")


def write_manifest(root: Path, host_os: str, host_arch: str) -> None:
    manifest = {
        "schema_version": 1,
        "host": {
            "os": host_os,
            "arch": host_arch,
        },
        "llvm_version": LLVM_VERSION,
        "sources": {
            "arm_none_eabi": ARM_NONE_EABI_URL,
            "aarch64_linux_gnu": ARM_AARCH64_URL,
            "arm_linux_gnueabihf": ARM_ARMHF_URL,
            "x86_64_linux_gnu": BOOTLIN_X86_64_URL,
            "x86_64_w64_mingw32": LLVM_MINGW_RELEASE_API,
        },
        "layout": {
            "bin": "toolchains/bin",
            "clang_resource_dir": f"toolchains/lib/clang/{LLVM_VERSION}",
            "sysroots": "toolchains/sysroots",
        },
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def ensure_layout(root: Path) -> None:
    (root / "bin").mkdir(parents=True, exist_ok=True)
    (root / "lib").mkdir(parents=True, exist_ok=True)
    (root / "sysroots").mkdir(parents=True, exist_ok=True)
    (root / ".cache").mkdir(parents=True, exist_ok=True)


def selected_targets(args: argparse.Namespace) -> list[str]:
    if args.only:
        unknown = sorted(set(args.only) - (set(TARGETS.keys()) | {"llvm"}))
        if unknown:
            raise SetupError(f"Unknown targets: {', '.join(unknown)}")
        return list(args.only)
    return ["llvm", *TARGETS.keys()]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bootstrap KronEditor Clang toolchains via sysroot harvesting")
    parser.add_argument(
        "--host",
        choices=["linux", "macos", "windows"],
        help="Override packaged host OS for LLVM binary selection",
    )
    parser.add_argument(
        "--only",
        nargs="+",
        help="Subset to install: llvm arm-none-eabi aarch64-linux-gnu arm-linux-gnueabihf x86_64-linux-gnu x86_64-w64-mingw32 simulation_env",
    )
    parser.add_argument(
        "--skip-llvm",
        action="store_true",
        help="Skip host LLVM binary installation",
    )
    parser.add_argument(
        "--skip-sysroots",
        action="store_true",
        help="Skip all target sysroot installation",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Replace existing installed components",
    )
    parser.add_argument(
        "--force-download",
        action="store_true",
        help="Re-download archives even if they already exist in cache",
    )
    return parser.parse_args()


def patch_lld_libxml2(root: Path) -> None:
    """On Linux, LLVM releases link ld.lld/lld-link against libxml2.so.2.
    Modern distros (libxml2 >= 2.12) ship libxml2.so.16 instead.
    Use patchelf to rewrite the NEEDED entry so the binaries load correctly."""
    targets = ["ld.lld", "lld-link"]
    old_soname = "libxml2.so.2"
    new_soname = "libxml2.so.16"

    # Only patch if the new soname actually exists on this system
    import ctypes.util
    if not ctypes.util.find_library("xml2"):
        return
    found_new = any(
        Path(p).exists()
        for p in ["/usr/lib/libxml2.so.16", "/usr/lib64/libxml2.so.16",
                  "/lib/x86_64-linux-gnu/libxml2.so.16"]
    )
    if not found_new:
        return

    patchelf = shutil.which("patchelf")
    if not patchelf:
        log("WARN: patchelf not found — skipping libxml2 SONAME patch for ld.lld. "
            "Install patchelf if linking fails with 'libxml2.so.2: cannot open shared object file'.")
        return

    for name in targets:
        binary = root / "bin" / name
        if not binary.exists():
            continue
        try:
            import subprocess as _sp
            result = _sp.run(
                ["patchelf", "--print-needed", str(binary)],
                capture_output=True, text=True,
            )
            if old_soname not in result.stdout:
                continue
            _sp.run(
                ["patchelf", "--replace-needed", old_soname, new_soname, str(binary)],
                check=True,
            )
            log(f"Patched {name}: {old_soname} → {new_soname}")
        except Exception as exc:
            log(f"WARN: could not patch {name}: {exc}")


def main() -> int:
    args = parse_args()
    host_os, host_arch = detect_host(args.host)
    root = FIXED_TOOLCHAIN_ROOT
    ensure_layout(root)
    cache_dir = root / ".cache"
    wanted = selected_targets(args)

    log(f"Host detected: {host_os}/{host_arch}")
    log(f"Toolchains root: {root}")

    if "llvm" in wanted and not args.skip_llvm:
        install_llvm(host_os, host_arch, root, cache_dir, args.force, args.force_download)

    if not args.skip_sysroots:
        if "arm-none-eabi" in wanted:
            harvest_arm_none_eabi(root, cache_dir, args.force, args.force_download)
        if "aarch64-linux-gnu" in wanted:
            harvest_linux_libc_sysroot(
                root=root,
                cache_dir=cache_dir,
                force=args.force,
                force_download=args.force_download,
                target_name="aarch64-linux-gnu",
                archive_url=ARM_AARCH64_URL,
                archive_name=ARM_AARCH64_ARCHIVE,
                archive_relative_path="aarch64-none-linux-gnu/libc",
                gcc_lib_relative_path="lib/gcc",
            )
        if "arm-linux-gnueabihf" in wanted:
            harvest_linux_libc_sysroot(
                root=root,
                cache_dir=cache_dir,
                force=args.force,
                force_download=args.force_download,
                target_name="arm-linux-gnueabihf",
                archive_url=ARM_ARMHF_URL,
                archive_name=ARM_ARMHF_ARCHIVE,
                archive_relative_path="arm-none-linux-gnueabihf/libc",
                gcc_lib_relative_path="lib/gcc",
            )
        if "x86_64-linux-gnu" in wanted:
            harvest_linux_libc_sysroot(
                root=root,
                cache_dir=cache_dir,
                force=args.force,
                force_download=args.force_download,
                target_name="x86_64-linux-gnu",
                archive_url=BOOTLIN_X86_64_URL,
                archive_name=BOOTLIN_X86_64_ARCHIVE,
                archive_relative_path="x86_64-buildroot-linux-gnu/sysroot",
            )
        if "x86_64-w64-mingw32" in wanted:
            harvest_mingw_sysroot(root, cache_dir, args.force, args.force_download)
        if "simulation_env" in wanted:
            write_simulation_env(root, args.force)

    if host_os == "linux":
        patch_lld_libxml2(root)

    write_command_templates(root)
    write_manifest(root, host_os, host_arch)
    log("Bootstrap completed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SetupError as exc:
        print(f"[toolchains] ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
