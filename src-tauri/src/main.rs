// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ast;
mod lexer;

use tauri::{command, Emitter, Manager, State};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use lalrpop_util::lalrpop_mod;
use logos::Logos;
use serde_json::{json, Value};
use std::process::Command;

#[cfg(not(target_os = "windows"))]
use std::process::{Child, Stdio};
#[cfg(not(target_os = "windows"))]
use std::thread;
#[cfg(not(target_os = "windows"))]
use std::time::Duration;
#[cfg(not(target_os = "windows"))]
use std::collections::HashMap;
#[cfg(not(target_os = "windows"))]
use serde_json::Map;

lalrpop_mod!(pub grammar);

// ---------------------------------------------------------------------------
// Platform constants
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
const SIM_BIN: &str = "simulation";

// ---------------------------------------------------------------------------
// Toolchain path helpers
//
// Layout (host-OS separated, no symlinks):
//   toolchains/
//     linux/
//       aarch64-none-linux-gnu/   RPi 3/4/5/Zero2W + BB AI-64  (aarch64)
//       arm-linux-gnueabihf/      BB Black/Green/AI              (armv7)
//       arm-none-eabi/            RPi Pico/Pico W                (Cortex-M)
//     windows/
//       aarch64-none-linux-gnu/   same targets, Windows-hosted
//       arm-linux-gnueabihf/      same
//       arm-none-eabi/            same
//       mingw/                    simulation on Windows (.dll)
// ---------------------------------------------------------------------------

/// Root directory for the LLVM/sysroot toolchain bundle.
fn llvm_toolchain_dir(resource_dir: &Path) -> PathBuf {
    resource_dir.join("toolchains")
}

/// Full path to a bundled LLVM binary.
fn llvm_bin(resource_dir: &Path, binary: &str) -> PathBuf {
    let exe = if cfg!(target_os = "windows") {
        format!("{}.exe", binary)
    } else {
        binary.to_string()
    };
    llvm_toolchain_dir(resource_dir).join("bin").join(exe)
}

/// Full path to a harvested sysroot directory.
fn llvm_sysroot_dir(resource_dir: &Path, target: &str) -> PathBuf {
    llvm_toolchain_dir(resource_dir).join("sysroots").join(target)
}

/// Clang resource dir is versioned; return the first version folder found.
fn llvm_clang_resource_dir(resource_dir: &Path) -> Result<PathBuf, String> {
    let base = llvm_toolchain_dir(resource_dir).join("lib").join("clang");
    let mut entries: Vec<PathBuf> = fs::read_dir(&base)
        .map_err(|e| format!("LLVM resource dir not found ({}): {}", base.display(), e))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    entries.sort();
    entries.into_iter().next()
        .ok_or_else(|| format!("No Clang resource version found under {}", base.display()))
}

/// Return extra `-isystem` include roots for a harvested sysroot.
fn llvm_target_include_dirs(resource_dir: &Path, target: &str) -> Result<Vec<PathBuf>, String> {
    let sysroot = llvm_sysroot_dir(resource_dir, target);
    let clang_res = llvm_clang_resource_dir(resource_dir)?;
    let mut dirs = vec![clang_res.join("include")];
    match target {
        "x86_64-linux-gnu" => {
            dirs.push(sysroot.join("usr/include"));
            dirs.push(sysroot.join("include"));
            dirs.push(sysroot.join("usr/include/x86_64-linux-gnu"));
        }
        "aarch64-linux-gnu" => {
            dirs.push(sysroot.join("usr/include"));
            dirs.push(sysroot.join("include"));
            dirs.push(sysroot.join("usr/include/aarch64-linux-gnu"));
        }
        "arm-linux-gnueabihf" => {
            dirs.push(sysroot.join("usr/include"));
            dirs.push(sysroot.join("include"));
            dirs.push(sysroot.join("usr/include/arm-linux-gnueabihf"));
        }
        "x86_64-w64-mingw32" => {
            dirs.push(sysroot.join("include"));
            dirs.push(sysroot.join("x86_64-w64-mingw32/include"));
            // Fallback: generic-w64-mingw32/include has the real MinGW CRT headers
            // (symlink was dropped by filter="data" extraction, harvest copies them here)
            dirs.push(sysroot.join("generic-w64-mingw32/include"));
        }
        "arm-none-eabi" => {
            dirs.push(sysroot.join("arm-none-eabi/include"));
            let gcc_root = sysroot.join("lib/gcc/arm-none-eabi");
            if let Ok(mut versions) = fs::read_dir(&gcc_root).map(|it| {
                it.flatten()
                    .map(|e| e.path())
                    .filter(|p| p.is_dir())
                    .collect::<Vec<PathBuf>>()
            }) {
                versions.sort();
                if let Some(ver) = versions.pop() {
                    dirs.push(ver.join("include"));
                    dirs.push(ver.join("include-fixed"));
                }
            }
        }
        other => return Err(format!("Unsupported LLVM target include layout: {}", other)),
    }
    Ok(dirs.into_iter().filter(|p| p.exists()).collect())
}

/// Returns the base Clang compile args needed to isolate includes to our bundled sysroot.
fn llvm_compile_base_args(
    resource_dir: &Path,
    target: &str,
) -> Result<(PathBuf, PathBuf, Vec<String>, Vec<PathBuf>), String> {
    let clang = llvm_bin(resource_dir, "clang");
    let llvm_ar = llvm_bin(resource_dir, "llvm-ar");
    if !clang.exists() {
        return Err(format!("Bundled clang not found: {}", clang.display()));
    }
    if !llvm_ar.exists() {
        return Err(format!("Bundled llvm-ar not found: {}", llvm_ar.display()));
    }
    let clang_res = llvm_clang_resource_dir(resource_dir)?;
    let sysroot = llvm_sysroot_dir(resource_dir, target);
    if !sysroot.exists() {
        return Err(format!("Bundled sysroot not found: {}", sysroot.display()));
    }

    let (triple, arch_flags): (&str, &[&str]) = match target {
        "x86_64-linux-gnu" => ("x86_64-linux-gnu", &[]),
        "x86_64-w64-mingw32" => ("x86_64-w64-mingw32", &[]),
        "aarch64-linux-gnu" => ("aarch64-linux-gnu", &["-mcpu=cortex-a72"]),
        "arm-linux-gnueabihf" => ("arm-linux-gnueabihf", &["-mcpu=cortex-a8", "-mfloat-abi=hard", "-mfpu=neon-vfpv4"]),
        "arm-none-eabi" => ("arm-none-eabi", &["-ffreestanding", "-fno-builtin"]),
        other => return Err(format!("Unsupported LLVM compile target: {}", other)),
    };

    let mut args = vec![
        format!("--target={}", triple),
        format!("--sysroot={}", sysroot.display()),
        "-resource-dir".to_string(),
        clang_res.to_string_lossy().to_string(),
    ];
    // win32 (llvm-mingw): rely on --sysroot for MinGW header discovery.
    // Other targets: -nostdinc to prevent host system headers from leaking in.
    if target != "x86_64-w64-mingw32" {
        args.push("-nostdinc".to_string());
    }
    // arm-none-eabi: GCC CRT is embedded in the sysroot.
    // aarch64-linux-gnu / arm-linux-gnueabihf: GCC CRT is harvested into
    // sysroot/lib/gcc/ so --gcc-toolchain points at the sysroot itself.
    if target == "arm-none-eabi"
        || target == "aarch64-linux-gnu"
        || target == "arm-linux-gnueabihf"
    {
        args.push(format!("--gcc-toolchain={}", sysroot.display()));
    }
    for flag in arch_flags {
        args.push((*flag).to_string());
    }

    Ok((clang, llvm_ar, args, llvm_target_include_dirs(resource_dir, target)?))
}

fn llvm_target_library_dirs(resource_dir: &Path, target: &str) -> Vec<PathBuf> {
    let sysroot = llvm_sysroot_dir(resource_dir, target);
    let mut dirs = Vec::new();
    match target {
        "x86_64-linux-gnu" => {
            dirs.push(sysroot.join("lib"));
            dirs.push(sysroot.join("lib64"));
            dirs.push(sysroot.join("usr/lib"));
            dirs.push(sysroot.join("usr/lib/x86_64-linux-gnu"));
        }
        "aarch64-linux-gnu" => {
            dirs.push(sysroot.join("lib"));
            dirs.push(sysroot.join("usr/lib"));
            dirs.push(sysroot.join("usr/lib/aarch64-linux-gnu"));
        }
        "arm-linux-gnueabihf" => {
            dirs.push(sysroot.join("lib"));
            dirs.push(sysroot.join("usr/lib"));
            dirs.push(sysroot.join("usr/lib/arm-linux-gnueabihf"));
        }
        "x86_64-w64-mingw32" => {
            dirs.push(sysroot.join("lib"));
            dirs.push(sysroot.join("x86_64-w64-mingw32/lib"));
        }
        "arm-none-eabi" => {
            dirs.push(sysroot.join("arm-none-eabi/lib"));
            let gcc_root = sysroot.join("lib/gcc/arm-none-eabi");
            if let Ok(mut versions) = fs::read_dir(&gcc_root).map(|it| {
                it.flatten()
                    .map(|e| e.path())
                    .filter(|p| p.is_dir())
                    .collect::<Vec<PathBuf>>()
            }) {
                versions.sort();
                if let Some(ver) = versions.pop() {
                    dirs.push(ver);
                }
            }
        }
        _ => {}
    }
    dirs.into_iter().filter(|p| p.exists()).collect()
}

fn bundled_host_clang_args(resource_dir: &Path) -> Result<(PathBuf, Vec<String>), String> {
    let clang = llvm_bin(resource_dir, "clang");
    if !clang.exists() {
        return Err(format!("Bundled clang not found: {}", clang.display()));
    }
    let clang_res = llvm_clang_resource_dir(resource_dir)?;
    let triple = if cfg!(target_os = "windows") {
        "x86_64-w64-windows-gnu"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { "aarch64-apple-darwin" } else { "x86_64-apple-darwin" }
    } else if cfg!(target_arch = "aarch64") {
        "aarch64-linux-gnu"
    } else {
        "x86_64-linux-gnu"
    };
    Ok((
        clang,
        vec![
            format!("--target={}", triple),
            "-resource-dir".to_string(),
            clang_res.to_string_lossy().to_string(),
        ],
    ))
}

fn collect_static_archives(dir: &Path) -> Vec<PathBuf> {
    let mut a_files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| {
            entries.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map_or(false, |x| x == "a"))
                .collect()
        })
        .unwrap_or_default();
    a_files.sort();
    let has_specialized_kron = a_files.iter().any(|p| {
        let name = p.file_name().map_or(String::new(), |n| n.to_string_lossy().into_owned());
        name.starts_with("libkron") && name != "libkron.a" && name.ends_with(".a")
    });
    if has_specialized_kron {
        a_files.retain(|a| a.file_name().map_or(true, |n| n != "libkron.a"));
    }
    a_files
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn target_resource_key(target: &str) -> &'static str {
    match target {
        "x86_64/linux" => "x86_64-linux-gnu",
        "x86_64/win32" => "x86_64-w64-mingw32",
        "x86_64/macos" => "x86_64-apple-darwin",
        "arm/aarch64" => "aarch64-linux-gnu",
        "arm/armv7" => "arm-linux-gnueabihf",
        "arm/CortexM/M0" => "arm-none-eabi-m0",
        "arm/CortexM/M4" => "arm-none-eabi-m4",
        "arm/CortexM/M7" => "arm-none-eabi-m7",
        "server/linux/amd64" => "x86_64-linux-gnu",
        "server/linux/arm64" => "aarch64-linux-gnu",
        "server/linux/armv7" => "arm-linux-gnueabihf",
        other => panic!("Unknown resource target key: {}", other),
    }
}

fn resource_target_dir(resources_root: &Path, target: &str) -> PathBuf {
    resources_root.join(target_resource_key(target))
}

fn resource_target_include_dir(resources_root: &Path, target: &str) -> PathBuf {
    resource_target_dir(resources_root, target).join("include")
}

fn resource_target_lib_dir(resources_root: &Path, target: &str) -> PathBuf {
    resource_target_dir(resources_root, target).join("lib")
}

fn resource_target_server_dir(resources_root: &Path, target: &str) -> PathBuf {
    resource_target_dir(resources_root, target).join("server")
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn get_build_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let build_dir = data_dir.join("build");
    fs::create_dir_all(&build_dir).map_err(|e| e.to_string())?;
    Ok(build_dir)
}

fn get_resource_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let p = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(plain_path(&p))
}

/// Find the src-tauri/ directory by walking up from the current executable.
/// In dev mode exe is at src-tauri/target/debug/<bin>.
/// Returns None in production (bundled) mode.
fn find_src_tauri_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    std::iter::successors(exe.parent(), |p| p.parent())
        .find(|p| p.file_name().map(|n| n == "src-tauri").unwrap_or(false)
               && p.join("Cargo.toml").exists())
        .map(|p| p.to_path_buf())
}

/// Returns the resources root inside src-tauri/resources in dev, or bundled resources/resources in production.
fn get_target_resources_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    if let Some(src_tauri) = find_src_tauri_dir() {
        let root = src_tauri.join("resources");
        let _ = fs::create_dir_all(&root);
        return vec![root];
    }
    if let Ok(r) = get_resource_dir(app) {
        let root = r.join("resources");
        let _ = fs::create_dir_all(&root);
        vec![root]
    } else {
        vec![]
    }
}

/// Primary resources root lookup used by compile/build commands.
fn get_libraries_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    get_target_resources_dirs(app)
        .into_iter()
        .next()
        .ok_or_else(|| "Cannot locate resources directory".to_string())
}

fn mingw_sysroot_has_headers(resource_dir: &Path) -> bool {
    let sysroot = llvm_sysroot_dir(resource_dir, "x86_64-w64-mingw32");
    let windows_candidates = [
        sysroot.join("x86_64-w64-mingw32/include/windows.h"),
        sysroot.join("generic-w64-mingw32/include/windows.h"),
        sysroot.join("include/windows.h"),
    ];
    let stdio_candidates = [
        sysroot.join("x86_64-w64-mingw32/include/stdio.h"),
        sysroot.join("generic-w64-mingw32/include/stdio.h"),
        sysroot.join("include/stdio.h"),
    ];
    windows_candidates.iter().any(|p| p.exists())
        && stdio_candidates.iter().any(|p| p.exists())
}

fn repair_mingw_sysroot_if_needed(app: &tauri::AppHandle, resource_dir: &Path) -> Result<(), String> {
    if mingw_sysroot_has_headers(resource_dir) {
        return Ok(());
    }

    let _ = app.emit(
        "library-update-progress",
        "[win32] Missing MinGW headers in sysroot. Repairing x86_64-w64-mingw32...".to_string(),
    );

    let src_tauri_dir = find_src_tauri_dir()
        .ok_or_else(|| "Cannot locate src-tauri directory to run setup_toolchain.py".to_string())?;
    let project_root = src_tauri_dir
        .parent()
        .ok_or_else(|| "Cannot locate project root from src-tauri".to_string())?;
    let setup_script = project_root.join("setup_toolchain.py");
    if !setup_script.exists() {
        return Err(format!(
            "setup_toolchain.py not found at {}",
            setup_script.display()
        ));
    }

    let run_setup = |force_download: bool| -> Result<(), String> {
        let mut common_args = vec![
            setup_script.as_os_str().to_owned(),
            "--only".into(),
            "x86_64-w64-mingw32".into(),
            "--force".into(),
        ];
        if force_download {
            common_args.push("--force-download".into());
        }

        let mut cmd = Command::new("python3");
        for a in &common_args {
            cmd.arg(a);
        }
        let out = cmd.output().or_else(|_| {
            let mut fallback = Command::new("python");
            for a in &common_args {
                fallback.arg(a);
            }
            fallback.output()
        }).map_err(|e| format!("Failed to launch Python for toolchain setup: {}", e))?;

        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "setup_toolchain.py failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    };

    // First pass: reuse cache. Second pass: force fresh download if still incomplete.
    run_setup(false)?;
    if mingw_sysroot_has_headers(resource_dir) {
        let _ = app.emit(
            "library-update-progress",
            "[win32] MinGW sysroot repaired from cache.".to_string(),
        );
        return Ok(());
    }

    let _ = app.emit(
        "library-update-progress",
        "[win32] Headers still missing after cache restore. Forcing re-download...".to_string(),
    );
    run_setup(true)?;
    if mingw_sysroot_has_headers(resource_dir) {
        let _ = app.emit(
            "library-update-progress",
            "[win32] MinGW sysroot repaired after re-download.".to_string(),
        );
        Ok(())
    } else {
        Err("MinGW sysroot repair completed, but windows.h/stdio.h are still missing".to_string())
    }
}

/// Strip the \\?\ long-path UNC prefix that Windows sometimes adds.
/// gcc does not accept this prefix in -I/-B arguments.
#[cfg(target_os = "windows")]
fn plain_path(p: &Path) -> PathBuf {
    match p.to_str() {
        Some(s) if s.starts_with("\\\\?\\") => PathBuf::from(&s[4..]),
        _ => p.to_path_buf(),
    }
}

#[cfg(not(target_os = "windows"))]
fn plain_path(p: &Path) -> PathBuf { p.to_path_buf() }

// ---------------------------------------------------------------------------
// Windows in-process simulation via MinGW-compiled DLL
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod win_sim {
    use std::ffi::CString;
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    use std::thread;
    use std::time::Duration;
    use serde_json::{json, Map, Value};
    use tauri::Emitter;
    use windows_sys::Win32::Foundation::{FreeLibrary, GetLastError, HMODULE};
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};

    // -------------------------------------------------------------------------
    // WinCtx — running DLL simulation stored in SimState
    // -------------------------------------------------------------------------

    pub struct WinCtx {
        hlib:        HMODULE,
        stop_ptr:    *mut i32,
        main_thr:    Option<thread::JoinHandle<i32>>,
        reader_stop: Arc<AtomicBool>,
        reader_thr:  Option<thread::JoinHandle<()>>,
    }
    unsafe impl Send for WinCtx {}

    impl Drop for WinCtx {
        fn drop(&mut self) {
            if !self.stop_ptr.is_null() {
                unsafe { *self.stop_ptr = 1; }
            }
            if let Some(h) = self.main_thr.take() { let _ = h.join(); }
            self.reader_stop.store(true, Ordering::Relaxed);
            if let Some(h) = self.reader_thr.take() { let _ = h.join(); }
            if !self.hlib.is_null() {
                unsafe { FreeLibrary(self.hlib); }
            }
        }
    }

    fn get_proc(hlib: HMODULE, name: &str) -> *mut u8 {
        let c = CString::new(name).unwrap();
        unsafe {
            let fp = GetProcAddress(hlib, c.as_ptr() as *const u8);
            fp.map(|f| std::mem::transmute(f)).unwrap_or(std::ptr::null_mut())
        }
    }

    fn build_var_specs(hlib: HMODULE, var_table: &Value) -> Vec<super::VarSpec> {
        let mut specs = Vec::new();
        if let Some(progs) = var_table.get("programs").and_then(|v| v.as_object()) {
            for (prog, info) in progs {
                if let Some(vars) = info.get("variables").and_then(|v| v.as_object()) {
                    for (var_name, var_info) in vars {
                        let c_sym = var_info.get("c_symbol").and_then(|v| v.as_str()).unwrap_or("");
                        let vtype = var_info.get("type").and_then(|v| v.as_str()).unwrap_or("BOOL");
                        let ptr = get_proc(hlib, c_sym);
                        if !ptr.is_null() {
                            specs.push(super::VarSpec {
                                key:     format!("prog_{}_{}", prog, var_name),
                                address: ptr as u64,
                                vtype:   vtype.to_string(),
                            });
                        }
                    }
                }
            }
        }
        if let Some(gvars) = var_table.get("globalVars").and_then(|v| v.as_object()) {
            for (var_name, var_info) in gvars {
                let c_sym = var_info.get("c_symbol").and_then(|v| v.as_str()).unwrap_or(var_name);
                let vtype = var_info.get("type").and_then(|v| v.as_str()).unwrap_or("BOOL");
                let ptr = get_proc(hlib, c_sym);
                if !ptr.is_null() {
                    specs.push(super::VarSpec {
                        key:     format!("prog__{}", var_name),
                        address: ptr as u64,
                        vtype:   vtype.to_string(),
                    });
                }
            }
        }
        if let Some(debug) = var_table.get("debugDefaults").and_then(|v| v.as_object()) {
            for (key, entry) in debug {
                let base_sym = match entry.get("base_symbol").and_then(|v| v.as_str()) {
                    Some(s) => s,
                    None    => continue,
                };
                let byte_offset = entry.get("byte_offset").and_then(|v| v.as_u64()).unwrap_or(0);
                let vtype = entry.get("type").and_then(|v| v.as_str()).unwrap_or("BOOL");
                let ptr = get_proc(hlib, base_sym);
                if !ptr.is_null() {
                    specs.push(super::VarSpec {
                        key:     key.clone(),
                        address: ptr as u64 + byte_offset,
                        vtype:   vtype.to_string(),
                    });
                }
            }
        }
        specs
    }

    // -------------------------------------------------------------------------
    // load_and_run() — LoadLibrary(plc.dll), spawn threads
    // -------------------------------------------------------------------------

    pub fn load_and_run(
        app:       tauri::AppHandle,
        build_dir: &std::path::Path,
        var_table: &Value,
    ) -> Result<(WinCtx, Vec<super::VarSpec>), String> {
        let dll_path = build_dir.join("plc.dll");
        let dll_cstr = CString::new(
            dll_path.to_str().ok_or("Invalid DLL path")?)
            .map_err(|e| e.to_string())?;

        let hlib = unsafe { LoadLibraryA(dll_cstr.as_ptr() as *const u8) };
        if hlib.is_null() {
            let err = unsafe { GetLastError() };
            return Err(format!(
                "LoadLibrary('{}') failed — Windows error {}",
                dll_path.display(), err
            ));
        }

        let var_specs = build_var_specs(hlib, var_table);

        let main_ptr = get_proc(hlib, "main");
        if main_ptr.is_null() {
            unsafe { FreeLibrary(hlib); }
            return Err("Symbol 'main' not found in plc.dll — check generated C code".into());
        }
        let stop_ptr = get_proc(hlib, "plc_stop") as *mut i32;

        let main_fn: unsafe extern "C" fn() -> i32 = unsafe { std::mem::transmute(main_ptr) };
        let main_thr = thread::spawn(move || unsafe { main_fn() });

        let reader_stop = Arc::new(AtomicBool::new(false));
        let rs_clone    = reader_stop.clone();
        let specs_clone = var_specs.clone();
        let reader_thr  = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            loop {
                thread::sleep(Duration::from_millis(200));
                if rs_clone.load(Ordering::Relaxed) { break; }
                let mut vars_data: Map<String, Value> = Map::new();
                let mut any_ok = false;
                for spec in &specs_clone {
                    let size = super::type_size(&spec.vtype);
                    if size == 0 { continue; }
                    let buf = unsafe {
                        let ptr = spec.address as *const u8;
                        std::slice::from_raw_parts(ptr, size)
                    };
                    vars_data.insert(spec.key.clone(), super::decode_value(buf, &spec.vtype));
                    any_ok = true;
                }
                if any_ok {
                    let _ = app.emit("simulation-output", json!({"vars": vars_data}).to_string());
                }
            }
        });

        Ok((
            WinCtx {
                hlib,
                stop_ptr,
                main_thr:    Some(main_thr),
                reader_stop,
                reader_thr:  Some(reader_thr),
            },
            var_specs,
        ))
    }

}

// ---------------------------------------------------------------------------
// write_plc_files
// ---------------------------------------------------------------------------

#[tauri::command]
fn write_plc_files(
    app: tauri::AppHandle,
    header: String,
    source: String,
    variable_table: String,
    hal: Option<String>,
) -> Result<String, String> {
    let build_dir = get_build_dir(&app)?;
    fs::write(build_dir.join("plc.h"), &header).map_err(|e| e.to_string())?;
    fs::write(build_dir.join("plc.c"), &source).map_err(|e| e.to_string())?;
    fs::write(build_dir.join("variables.json"), &variable_table).map_err(|e| e.to_string())?;
    if let Some(hal_content) = hal {
        if !hal_content.is_empty() {
            fs::write(build_dir.join("kron_hal.h"), &hal_content).map_err(|e| e.to_string())?;
        }
    }
    Ok(build_dir.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// get_standard_headers
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_standard_headers(app: tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    let mut headers = Vec::new();

    // Return ONLY Krontek library headers (kron*.h) and known board support headers (gpiod.h).
    // SOEM, CANopen, wpcap, and other third-party headers are accessed via compiler -I paths
    // and must NOT be included directly in plc.h via customIncludes — they require
    // specific include ordering and platform-specific prerequisites.
    // Board-specific HAL implementation headers are conditionally included
    // by kronhal.h itself — they must never be passed to the JS transpiler
    // for direct #include generation, as that would cause redefinition errors
    // when both kronhal.h and the board header are compiled together.
    let hal_impl_headers: std::collections::HashSet<&str> = [
        "kronhal_rpi.h", "kronhal_bb.h", "kronhal_jetson.h",
        "kronhal_pico.h", "kronhal_sim.h",
    ].iter().copied().collect();

    if let Ok(libraries_dir) = get_libraries_dir(&app) {
        let include_dir = resource_target_include_dir(&libraries_dir, "x86_64/linux");
        // Scan top-level kron*.h / gpiod.h (non-HAL headers)
        if let Ok(entries) = fs::read_dir(&include_dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    let is_kron = name.starts_with("kron") && name.ends_with(".h");
                    let is_allowed = (is_kron || name == "gpiod.h")
                        && !hal_impl_headers.contains(name);
                    if is_allowed {
                        if let Ok(content) = fs::read_to_string(entry.path()) {
                            headers.push((name.to_string(), content));
                        }
                    }
                }
            }
        }
        // Scan HAL/ subdirectory — filenames returned as "HAL/kronhal.h" etc.
        let hal_dir = include_dir.join("HAL");
        if let Ok(hal_entries) = fs::read_dir(&hal_dir) {
            for entry in hal_entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.starts_with("kron") && name.ends_with(".h")
                        && !hal_impl_headers.contains(name)
                    {
                        if let Ok(content) = fs::read_to_string(entry.path()) {
                            headers.push((format!("HAL/{}", name), content));
                        }
                    }
                }
            }
        }
    }

    Ok(headers)
}

// ---------------------------------------------------------------------------
// update_libraries
// ---------------------------------------------------------------------------

/// Copy every file from `src` into `dst`, preserving relative structure.
/// Only overwrites files that differ (by size) to avoid unnecessary writes.
/// Does NOT delete files in `dst` that no longer exist in `src`.
fn sync_dir_from_clone(src: &Path, dst: &Path, app: &tauri::AppHandle) {
    if let Ok(entries) = fs::read_dir(src) {
        for entry in entries.flatten() {
            let src_path = entry.path();
            let name = entry.file_name();
            if src_path.is_dir() {
                let dst_sub = dst.join(&name);
                let _ = fs::create_dir_all(&dst_sub);
                sync_dir_from_clone(&src_path, &dst_sub, app);
            } else {
                let dst_path = dst.join(&name);
                // Skip binary / build artifacts; only sync source and headers
                let ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if !matches!(ext, "c" | "h" | "cpp" | "hpp" | "txt" | "md" | "cmake" | "xml") {
                    continue;
                }
                let needs_copy = dst_path.metadata().map(|m| m.len()).ok()
                    != src_path.metadata().map(|m| m.len()).ok();
                if needs_copy {
                    if let Err(e) = fs::copy(&src_path, &dst_path) {
                        let _ = app.emit("library-update-progress",
                            format!("  WARN: sync {} → {}: {}", src_path.display(), dst_path.display(), e));
                    }
                }
            }
        }
    }
}

fn find_files_with_ext(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut result = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                result.extend(find_files_with_ext(&path, ext));
            } else if path.extension().and_then(|e| e.to_str()) == Some(ext) {
                result.push(path);
            }
        }
    }
    result
}

/// Create an AR archive from a list of object files (pure Rust, no subprocess).
#[allow(dead_code)]

fn do_update_libraries(app: &tauri::AppHandle, repos: Vec<String>) -> Result<(), String> {
    let out_dirs = get_target_resources_dirs(app);
    if out_dirs.is_empty() { return Err("Cannot locate resources directory".into()); }
    let resources_root = out_dirs[0].clone();
    let resource_dir = resources_root.parent()
        .ok_or_else(|| "Cannot find parent of resources root".to_string())?
        .to_path_buf();

    // Ensure Windows cross sysroot is healthy before any win32 compilation.
    repair_mingw_sysroot_if_needed(app, &resource_dir)?;

    let target_names = [
        "x86_64/linux", "x86_64/win32",
        "arm/aarch64", "arm/armv7",
        "arm/CortexM/M0", "arm/CortexM/M4", "arm/CortexM/M7",
    ];

    // --- Clean old headers and .a files from all target dirs ---
    let _ = app.emit("library-update-progress", "Cleaning old headers and .a files...".to_string());
    for tname in &target_names {
        let include_dir = resource_target_include_dir(&resources_root, tname);
        let _ = fs::remove_dir_all(&include_dir);
        let _ = fs::create_dir_all(&include_dir);

        let lib_dir = resource_target_lib_dir(&resources_root, tname);
        if let Ok(entries) = fs::read_dir(&lib_dir) {
            for e in entries.flatten() {
                if e.path().extension().map_or(false, |x| x == "a") {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
    }

    for tname in &target_names {
        fs::create_dir_all(resource_target_include_dir(&resources_root, tname)).map_err(|e| e.to_string())?;
        fs::create_dir_all(resource_target_lib_dir(&resources_root, tname)).map_err(|e| e.to_string())?;
        fs::create_dir_all(resource_target_server_dir(&resources_root, tname)).map_err(|e| e.to_string())?;
    }
    let include_dir = resource_target_include_dir(&resources_root, "x86_64/linux");

    // --- Build SOEM first so kronethercatmaster can link against it ---
    let _ = app.emit("library-update-progress", "=== Building SOEM ===".to_string());
    match do_build_soem(app) {
        Ok(()) => { let _ = app.emit("library-update-progress", "=== SOEM done ===".to_string()); }
        Err(e) => { let _ = app.emit("library-update-progress",
            format!("WARN: SOEM build failed (kronethercatmaster will use stubs): {}", e)); }
    }

    // targets[i] = output lib dirs for target_names[i]
    let mut targets: Vec<Vec<PathBuf>> = Vec::new();
    for tname in &target_names {
        targets.push(vec![resource_target_lib_dir(&resources_root, tname)]);
    }

    let temp_base = std::env::temp_dir().join("kroneditor_libs");
    let _ = fs::remove_dir_all(&temp_base);
    fs::create_dir_all(&temp_base).map_err(|e| e.to_string())?;

    let mut errors: Vec<String> = Vec::new();

    // --- Resolve local KrontekLibraries path (sibling of project root) ---
    // src-tauri/ → project root → Documents/ → KrontekLibraries/
    let local_libs_base: Option<PathBuf> = find_src_tauri_dir()
        .and_then(|st| st.parent()?.parent().map(|d| d.join("KrontekLibraries")));

    // --- Clone all repos from GitHub, gather headers and sources ---
    // Always clone fresh from GitHub so the build always uses the latest
    // published source. Local KrontekLibraries/ edits are NOT picked up here;
    // this guarantees a clean, reproducible build.
    let mut repo_sources: Vec<(String, PathBuf)> = Vec::new(); // (lib_name, c_file)
    let mut cloned_dirs:  Vec<PathBuf>            = Vec::new();

    for repo_name in &repos {
        let clone_dir = temp_base.join(repo_name);
        let repo_url  = format!("https://github.com/Krontek/{}.git", repo_name);
        let _ = app.emit("library-update-progress",
            format!("[{}] Cloning from GitHub...", repo_name));
        let clone_out = std::process::Command::new("git")
            .args(["clone", "--depth=1", "--quiet", &repo_url])
            .arg(&clone_dir)
            .output()
            .map_err(|e| format!("git not found: {}", e))?;
        if !clone_out.status.success() {
            let msg = format!("[{}] Clone failed: {}", repo_name,
                String::from_utf8_lossy(&clone_out.stderr).trim());
            let _ = app.emit("library-update-progress", format!("ERROR: {}", msg));
            errors.push(msg);
            continue;
        }

        // After cloning, sync the local KrontekLibraries/<RepoName> directory
        // so that local source files stay up-to-date with the GitHub version.
        if let Some(local_dir) = local_libs_base.as_ref().map(|b| b.join(repo_name)) {
            if local_dir.is_dir() {
                let _ = app.emit("library-update-progress",
                    format!("[{}] Syncing local KrontekLibraries/{}/...", repo_name, repo_name));
                sync_dir_from_clone(&clone_dir, &local_dir, app);
            }
        }

        let clone_dir = clone_dir;

        // Copy .h files into all out_dirs' include/
        // KronHAL headers go into include/HAL/, all others go into include/ flat.
        let is_hal = repo_name.to_lowercase() == "kronhal";
        let h_files = find_files_with_ext(&clone_dir, "h");
        for h_file in &h_files {
            if let Some(fname) = h_file.file_name() {
                for tname in &target_names {
                    let mut dst_dir = resource_target_include_dir(&resources_root, tname);
                    if is_hal {
                        dst_dir = dst_dir.join("HAL");
                    }
                    let _ = fs::create_dir_all(&dst_dir);
                    let _ = fs::copy(h_file, dst_dir.join(fname));
                }
            }
        }
        let _ = app.emit(
            "library-update-progress",
            format!("[{}] Copied {} header(s){}", repo_name, h_files.len(),
                if is_hal { " → include/HAL/" } else { " → include/" }),
        );

        let is_hal_repo = repo_name.eq_ignore_ascii_case("kronhal");

        // Build libraries from top-level .c files only.
        // This intentionally ignores subdirectories/CMake layouts and keeps
        // the existing clang/ar compilation flow.
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(entries) = fs::read_dir(&clone_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("c") {
                    let n = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                    if !n.starts_with("test") && !n.starts_with("example") && n != "debug.c" {
                        candidates.push(p);
                    }
                }
            }
        }
        if candidates.is_empty() && !is_hal_repo {
            let _ = app.emit("library-update-progress",
                format!("[{}] WARN: no top-level .c source found", repo_name));
        }
        for c in candidates {
            let stem = c.file_stem().unwrap_or_default().to_string_lossy().to_string();
            repo_sources.push((stem, c));
        }
        cloned_dirs.push(clone_dir);
    }

    if repo_sources.is_empty() {
        let _ = fs::remove_dir_all(&temp_base);
        if errors.is_empty() {
            return Ok(());
        } else {
            return Err(errors.join("; "));
        }
    }

    // --- Compile for each target ---
    let mut build_errors: Vec<String> = Vec::new();
    let mut required_repo_archives: Vec<String> = repo_sources
        .iter()
        .map(|(lib_name, _)| format!("lib{}.a", lib_name))
        .collect();
    required_repo_archives.sort();
    required_repo_archives.dedup();

    let verify_required_archives = |target_tag: &str, lib_dirs: &[PathBuf]| -> Vec<String> {
        if lib_dirs.is_empty() {
            return vec![format!("[{}] no output lib directory configured", target_tag)];
        }
        required_repo_archives
            .iter()
            .filter_map(|archive| {
                if lib_dirs[0].join(archive).exists() {
                    None
                } else {
                    Some(format!("[{}] missing required archive {}", target_tag, archive))
                }
            })
            .collect()
    };

    // Pre-compute SOEM platform include paths
    let soem_base = include_dir.join("soem");
    let soem_inc_dir     = soem_base.join("include");          // soem/include  → soem/soem.h
    let soem_osal_dir    = soem_base.join("osal");             // soem/osal/    → osal.h dispatch
    let soem_osal_linux  = soem_base.join("osal/linux");       // Linux osal
    let soem_osal_win32  = soem_base.join("osal/win32");       // Win32 osal
    let soem_oshw_linux  = soem_base.join("oshw/linux");       // Linux nicdrv.h
    let soem_oshw_win32  = soem_base.join("oshw/win32");       // Win32 nicdrv.h
    // WinPcap headers needed by soem/oshw/win32/nicdrv.h (<pcap.h>)
    let soem_wpcap_inc   = soem_base.join("oshw/win32/wpcap/Include");

    // Returns extra include dirs + extra cc flags for repos that wrap SOEM (KronEthercatMaster).
    // Returns empty vecs for all other repos.
    // When SOEM headers are not installed (include/soem/ absent), falls back to -DKRON_EC_SIM
    // so the stub-only variant compiles. Run Build SOEM first for real EtherCAT support.
    let soem_headers_present = soem_inc_dir.exists();
    let soem_extra = |lib_name: &str, platform: &str| -> (Vec<PathBuf>, Vec<&'static str>) {
        if lib_name != "kronethercatmaster" { return (vec![], vec![]); }
        match platform {
            "linux" => {
                if soem_headers_present {
                    (vec![soem_inc_dir.clone(), soem_osal_dir.clone(), soem_osal_linux.clone(), soem_oshw_linux.clone()],
                     vec!["-DLINUX"])
                } else {
                    (vec![], vec!["-DKRON_EC_SIM"])
                }
            },
            "win32" => {
                if soem_headers_present {
                    // EtherCAT master on Windows requires WinPcap.
                    (vec![soem_inc_dir.clone(), soem_osal_dir.clone(), soem_osal_win32.clone(),
                          soem_oshw_win32.clone(), soem_wpcap_inc.clone()],
                     vec!["-DWIN32"])
                } else {
                    (vec![], vec!["-DKRON_EC_SIM"])
                }
            },
            "bare" => {
                // Bare-metal targets have no OS networking stack — compile stub-only.
                (vec![], vec!["-DKRON_EC_SIM"])
            },
            _ => (vec![], vec![]),
        }
    };

    // Helper: compile one .c → lib<lib_name>.a and write to all lib_dirs directly.
    let compile_one_ar = |
        target_tag:  &str,
        compiler:    &Path,
        cc_args:     &[String],
        sys_incs:    &[PathBuf],
        extra_incs:  &[PathBuf],
        extra_flags: &[&str],
        ar_cmd:      &Path,
        lib_dirs:    &[PathBuf],
        lib_name:    &str,
        c_file:      &Path,
    | -> Result<(), String> {
        let obj_path = temp_base.join(format!("{}_{}.o", target_tag.replace('/', "_"), lib_name));
        let mut cmd = std::process::Command::new(compiler);
        for arg in cc_args  { cmd.arg(arg); }
        for arg in extra_flags { cmd.arg(arg); }
        for inc in sys_incs { if inc.exists() { cmd.arg("-isystem").arg(inc); } }
        cmd.arg("-I").arg(&include_dir);
        for ei in extra_incs { if ei.exists() { cmd.arg("-I").arg(ei); } }
        for cdir in &cloned_dirs { cmd.arg("-I").arg(cdir); }
        cmd.arg("-c").arg(c_file).arg("-o").arg(&obj_path);

        let out = cmd.output().map_err(|e| format!("[{}] {} spawn error: {}", target_tag, lib_name, e))?;
        if !out.status.success() {
            let _ = fs::remove_file(&obj_path);
            return Err(format!("[{}] {} compile error: {}",
                target_tag, lib_name, String::from_utf8_lossy(&out.stderr).trim()));
        }

        // Archive into first dir
        let lib_fname = format!("lib{}.a", lib_name);
        let first_lib = lib_dirs[0].join(&lib_fname);
        let ar_out = std::process::Command::new(ar_cmd)
            .arg("rcs").arg(&first_lib).arg(&obj_path)
            .output()
            .map_err(|e| format!("[{}] {} ar error: {}", target_tag, lib_name, e))?;
        let _ = fs::remove_file(&obj_path);
        if !ar_out.status.success() {
            return Err(format!("[{}] {} archive error: {}",
                target_tag, lib_name, String::from_utf8_lossy(&ar_out.stderr).trim()));
        }
        // Copy to remaining dirs (e.g. release/resources/...)
        for extra_dir in lib_dirs.iter().skip(1) {
            let _ = fs::copy(&first_lib, extra_dir.join(&lib_fname));
        }
        Ok(())
    };

    // ---- x86_64/linux — Clang + harvested sysroot ----
    {
        let _ = app.emit("library-update-progress", "--- Building for x86_64/linux ---".to_string());
        match llvm_compile_base_args(&resource_dir, "x86_64-linux-gnu") {
            Ok((clang, llvm_ar, mut cc_args, sys_incs)) => {
                cc_args.extend(["-O3", "-ffunction-sections", "-fdata-sections"].iter().map(|s| s.to_string()));
                for (lib_name, c_file) in &repo_sources {
                    let (ei, ef) = soem_extra(lib_name, "linux");
                    match compile_one_ar(
                        "x86_64/linux", &clang, &cc_args, &sys_incs, &ei, &ef, &llvm_ar,
                        &targets[0], lib_name, c_file,
                    ) {
                        Ok(()) => { let _ = app.emit("library-update-progress", format!(
                            "  [x86_64/linux] lib{}.a OK", lib_name)); }
                        Err(e) => {
                            let _ = app.emit("library-update-progress",
                                format!("  [x86_64/linux] {}", e));
                            build_errors.push(e);
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app.emit("library-update-progress",
                    format!("  [x86_64/linux] SKIP: {}", e));
                build_errors.push(format!("[x86_64/linux] toolchain unavailable: {}", e));
            }
        }
        for msg in verify_required_archives("x86_64/linux", &targets[0]) {
            let _ = app.emit("library-update-progress", format!("  [x86_64/linux] {}", msg));
            build_errors.push(msg);
        }
    }

    // ---- x86_64/win32 — Clang + llvm-mingw sysroot ----
    {
        let _ = app.emit("library-update-progress", "--- Building for x86_64/win32 ---".to_string());
        match llvm_compile_base_args(&resource_dir, "x86_64-w64-mingw32") {
            Ok((clang, llvm_ar, mut cc_args, sys_incs)) => {
                cc_args.extend(["-O3", "-ffunction-sections", "-fdata-sections"].iter().map(|s| s.to_string()));
                for (lib_name, c_file) in &repo_sources {
                    let (ei, ef) = soem_extra(lib_name, "win32");
                    match compile_one_ar(
                        "x86_64/win32", &clang, &cc_args, &sys_incs, &ei, &ef, &llvm_ar,
                        &targets[1], lib_name, c_file,
                    ) {
                        Ok(()) => { let _ = app.emit("library-update-progress", format!(
                            "  [x86_64/win32] lib{}.a OK", lib_name)); }
                        Err(e) => {
                            let _ = app.emit("library-update-progress",
                                format!("  [x86_64/win32] {}", e));
                            build_errors.push(e);
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app.emit("library-update-progress",
                    format!("  [x86_64/win32] SKIP: {}", e));
                build_errors.push(format!("[x86_64/win32] toolchain unavailable: {}", e));
            }
        }
        for msg in verify_required_archives("x86_64/win32", &targets[1]) {
            let _ = app.emit("library-update-progress", format!("  [x86_64/win32] {}", msg));
            build_errors.push(msg);
        }
    }

    // ---- arm/aarch64 — Clang + harvested sysroot ----
    {
        let _ = app.emit("library-update-progress", "--- Building for arm/aarch64 ---".to_string());
        match llvm_compile_base_args(&resource_dir, "aarch64-linux-gnu") {
            Ok((clang, llvm_ar, mut cc_args, sys_incs)) => {
                cc_args.extend(["-O3", "-ffunction-sections", "-fdata-sections"].iter().map(|s| s.to_string()));
                for (lib_name, c_file) in &repo_sources {
                    let (ei, ef) = soem_extra(lib_name, "linux");
                    match compile_one_ar(
                        "arm/aarch64", &clang, &cc_args, &sys_incs, &ei, &ef, &llvm_ar,
                        &targets[2], lib_name, c_file,
                    ) {
                        Ok(()) => { let _ = app.emit("library-update-progress", format!(
                            "  [arm/aarch64] lib{}.a OK", lib_name)); }
                        Err(e) => {
                            let _ = app.emit("library-update-progress",
                                format!("  [arm/aarch64] {}", e));
                            build_errors.push(e);
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app.emit("library-update-progress",
                    format!("  [arm/aarch64] SKIP: {}", e));
                build_errors.push(format!("[arm/aarch64] toolchain unavailable: {}", e));
            }
        }
        for msg in verify_required_archives("arm/aarch64", &targets[2]) {
            let _ = app.emit("library-update-progress", format!("  [arm/aarch64] {}", msg));
            build_errors.push(msg);
        }
    }

    // ---- arm/armv7 — Clang + harvested sysroot ----
    {
        let _ = app.emit("library-update-progress", "--- Building for arm/armv7 ---".to_string());
        match llvm_compile_base_args(&resource_dir, "arm-linux-gnueabihf") {
            Ok((clang, llvm_ar, mut cc_args, sys_incs)) => {
                cc_args.extend(["-O3", "-ffunction-sections", "-fdata-sections"].iter().map(|s| s.to_string()));
                for (lib_name, c_file) in &repo_sources {
                    let (ei, ef) = soem_extra(lib_name, "linux");
                    match compile_one_ar(
                        "arm/armv7", &clang, &cc_args, &sys_incs, &ei, &ef, &llvm_ar,
                        &targets[3], lib_name, c_file,
                    ) {
                        Ok(()) => { let _ = app.emit("library-update-progress", format!(
                            "  [arm/armv7] lib{}.a OK", lib_name)); }
                        Err(e) => {
                            let _ = app.emit("library-update-progress",
                                format!("  [arm/armv7] {}", e));
                            build_errors.push(e);
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app.emit("library-update-progress",
                    format!("  [arm/armv7] SKIP: {}", e));
                build_errors.push(format!("[arm/armv7] toolchain unavailable: {}", e));
            }
        }
        for msg in verify_required_archives("arm/armv7", &targets[3]) {
            let _ = app.emit("library-update-progress", format!("  [arm/armv7] {}", msg));
            build_errors.push(msg);
        }
    }

    // ---- ARM CortexM targets — Clang + harvested arm-none-eabi sysroot ----
    // targets indices: [0]=x86_64/linux [1]=x86_64/win32
    //                  [2]=arm/aarch64  [3]=arm/armv7
    //                  [4]=arm/CortexM/M0 [5]=arm/CortexM/M4 [6]=arm/CortexM/M7
    let arm_targets: &[(&str, usize, &[&str])] = &[
        ("arm/CortexM/M0", 4, &["-mcpu=cortex-m0", "-mthumb", "-mfloat-abi=soft", "-O3", "-ffunction-sections", "-fdata-sections"]),
        ("arm/CortexM/M4", 5, &["-mcpu=cortex-m4", "-mthumb", "-mfloat-abi=hard", "-mfpu=fpv4-sp-d16", "-O3", "-ffunction-sections", "-fdata-sections"]),
        ("arm/CortexM/M7", 6, &["-mcpu=cortex-m7", "-mthumb", "-mfloat-abi=hard", "-mfpu=fpv5-d16", "-O3", "-ffunction-sections", "-fdata-sections"]),
    ];

    match llvm_compile_base_args(&resource_dir, "arm-none-eabi") {
        Ok((clang, llvm_ar, base_args, sys_incs)) => {
            for (name, idx, cc_args) in arm_targets {
                let _ = app.emit("library-update-progress", format!("--- Building for {} ---", name));
                let mut args = base_args.clone();
                args.extend(cc_args.iter().map(|s| s.to_string()));
                for (lib_name, c_file) in &repo_sources {
                    let (ei, ef) = soem_extra(lib_name, "bare");
                    match compile_one_ar(
                        name, &clang, &args, &sys_incs, &ei, &ef, &llvm_ar,
                        &targets[*idx], lib_name, c_file,
                    ) {
                        Ok(()) => { let _ = app.emit("library-update-progress", format!(
                            "  [{}] lib{}.a OK", name, lib_name)); }
                        Err(e) => {
                            let _ = app.emit("library-update-progress",
                                format!("  [{}] {}", name, e));
                            build_errors.push(e);
                        }
                    }
                }
                for msg in verify_required_archives(name, &targets[*idx]) {
                    let _ = app.emit("library-update-progress", format!("  [{}] {}", name, msg));
                    build_errors.push(msg);
                }
            }
        }
        Err(e) => {
            for (name, idx, _) in arm_targets {
                let _ = app.emit("library-update-progress",
                    format!("  [{}] SKIP: {}", name, e));
                build_errors.push(format!("[{}] toolchain unavailable: {}", name, e));
                for msg in verify_required_archives(name, &targets[*idx]) {
                    let _ = app.emit("library-update-progress", format!("  [{}] {}", name, msg));
                    build_errors.push(msg);
                }
            }
        }
    }

    // SOEM is required on hosted targets for EtherCAT-enabled builds.
    for (tag, idx) in [
        ("x86_64/linux", 0usize),
        ("x86_64/win32", 1usize),
        ("arm/aarch64", 2usize),
        ("arm/armv7", 3usize),
    ] {
        if !targets[idx].is_empty() && !targets[idx][0].join("libsoem.a").exists() {
            let msg = format!("[{}] missing required archive libsoem.a", tag);
            let _ = app.emit("library-update-progress", format!("  [{}] {}", tag, msg));
            build_errors.push(msg);
        }
    }

    // Cleanup — only delete dirs we actually cloned into temp_base, not local source dirs.
    for cdir in &cloned_dirs {
        if cdir.starts_with(&temp_base) {
            let _ = fs::remove_dir_all(cdir);
        }
    }
    let _ = fs::remove_dir_all(&temp_base);

    errors.extend(build_errors);

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// Recursively copy src directory contents into dst, creating dirs as needed.

#[tauri::command]
fn update_libraries(app: tauri::AppHandle, repos: Vec<String>) -> Result<String, String> {
    std::thread::spawn(move || {
        match do_update_libraries(&app, repos) {
            Ok(()) => {
                let _ = app.emit(
                    "library-update-done",
                    json!({"success": true, "message": "All libraries updated successfully"}),
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "library-update-done",
                    json!({"success": false, "message": e}),
                );
            }
        }
    });
    Ok("started".to_string())
}

// ---------------------------------------------------------------------------
// update_server -- clone KronServer and cross-compile Go binaries
// ---------------------------------------------------------------------------

fn do_update_server(app: &tauri::AppHandle) -> Result<(), String> {
    let out_dirs = get_target_resources_dirs(app);
    if out_dirs.is_empty() { return Err("Cannot locate resources directory".into()); }
    let resources_root = out_dirs[0].clone();


    // Check Go is available
    let _ = app.emit("server-update-progress", "Checking Go installation...");
    let go_check = Command::new("go").arg("version").output()
        .map_err(|_| "Go is not installed or not in PATH. Install Go from https://go.dev".to_string())?;
    if !go_check.status.success() {
        return Err("Go version check failed".into());
    }
    let go_ver = String::from_utf8_lossy(&go_check.stdout);
    let _ = app.emit("server-update-progress", format!("Found: {}", go_ver.trim()));

    // Clone KronServer
    let temp_dir = std::env::temp_dir().join("kroneditor_server_build");
    let _ = fs::remove_dir_all(&temp_dir);
    let _ = app.emit("server-update-progress", "Cloning KronServer repository...");

    let clone_out = Command::new("git")
        .args(["clone", "--depth=1", "--quiet", "https://github.com/Krontek/KronServer.git"])
        .arg(&temp_dir)
        .output()
        .map_err(|e| format!("git not found: {}", e))?;
    if !clone_out.status.success() {
        return Err(format!("Clone failed: {}", String::from_utf8_lossy(&clone_out.stderr).trim()));
    }
    let _ = app.emit("server-update-progress", "Repository cloned.");

    // Cross-compile for 3 targets
    let targets = [
        ("linux", "arm",   "7",  "plc-agent_linux_armv7", "server/linux/armv7"),
        ("linux", "arm64", "",   "plc-agent_linux_arm64", "server/linux/arm64"),
        ("linux", "amd64", "",   "plc-agent_linux_amd64", "server/linux/amd64"),
    ];

    for (i, (goos, goarch, goarm, out_name, resource_target)) in targets.iter().enumerate() {
        let _ = app.emit("server-update-progress",
            format!("[{}/{}] Building {}/{} -> {}...", i + 1, targets.len(), goos, goarch, out_name));

        let server_dir = resource_target_server_dir(&resources_root, resource_target);
        fs::create_dir_all(&server_dir).map_err(|e| e.to_string())?;
        let out_path = server_dir.join(out_name);
        let mut cmd = Command::new("go");
        cmd.current_dir(&temp_dir)
            .env("CGO_ENABLED", "0")
            .env("GOOS", goos)
            .env("GOARCH", goarch)
            .args(["build", "-trimpath", "-ldflags=-s -w", "-o"])
            .arg(&out_path)
            .arg(".");

        if !goarm.is_empty() {
            cmd.env("GOARM", goarm);
        }

        let build_out = cmd.output()
            .map_err(|e| format!("go build failed: {}", e))?;

        if !build_out.status.success() {
            let stderr = String::from_utf8_lossy(&build_out.stderr);
            let _ = app.emit("server-update-progress", format!("ERROR: {}", stderr.trim()));
            return Err(format!("{} build failed: {}", out_name, stderr.trim()));
        }

        let _ = app.emit("server-update-progress", format!("[{}/{}] {} built.", i + 1, targets.len(), out_name));
    }

    // Cleanup
    let _ = fs::remove_dir_all(&temp_dir);

    Ok(())
}

#[tauri::command]
fn update_server(app: tauri::AppHandle) -> Result<String, String> {
    std::thread::spawn(move || {
        match do_update_server(&app) {
            Ok(()) => {
                let _ = app.emit(
                    "server-update-done",
                    json!({"success": true, "message": "KronServer built for all targets"}),
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "server-update-done",
                    json!({"success": false, "message": e}),
                );
            }
        }
    });
    Ok("started".to_string())
}

// ---------------------------------------------------------------------------
// compile_for_target -- cross-compile PLC project for target board
// ---------------------------------------------------------------------------

#[tauri::command]
async fn compile_for_target(
    app: tauri::AppHandle,
    header: String,
    source: String,
    variable_table: String,
    hal: Option<String>,
    board_id: String,
    _di_count: Option<u8>,
    _do_count: Option<u8>,
    output_name: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || compile_for_target_sync(
        app, header, source, variable_table, hal, board_id, _di_count, _do_count, output_name
    )).await.map_err(|e| format!("Task error: {}", e))?
}

fn compile_for_target_sync(
    app: tauri::AppHandle,
    header: String,
    source: String,
    variable_table: String,
    hal: Option<String>,
    board_id: String,
    _di_count: Option<u8>,
    _do_count: Option<u8>,
    output_name: Option<String>,
) -> Result<String, String> {
    let resource_dir  = get_resource_dir(&app)?;
    let resources_root = get_libraries_dir(&app)?;
    let build_dir = plain_path(&get_build_dir(&app)?);

    // Write source files
    fs::write(build_dir.join("plc.h"), &header).map_err(|e| e.to_string())?;
    fs::write(build_dir.join("plc.c"), &source).map_err(|e| e.to_string())?;
    if let Some(hal_content) = hal {
        if !hal_content.is_empty() {
            fs::write(build_dir.join("kron_hal.h"), &hal_content).map_err(|e| e.to_string())?;
        }
    }
    fs::write(build_dir.join("variables.json"), &variable_table).map_err(|e| e.to_string())?;

    let plc_c = build_dir.join("plc.c");
    let bin_name = output_name.unwrap_or_else(|| "runtime.bin".to_string());
    let out_file = build_dir.join(&bin_name);
    // Select Clang/sysroot target and board library directory.
    let (llvm_target, resource_target) = if board_id.starts_with("rpi_pico") {
        return Err("Pico (Cortex-M) targets are not supported for remote deployment".into());
    } else if board_id.starts_with("bb_") && !board_id.starts_with("bb_ai64") {
        ("arm-linux-gnueabihf", "arm/armv7")
    } else {
        ("aarch64-linux-gnu", "arm/aarch64")
    };
    let res_include = resource_target_include_dir(&resources_root, resource_target);
    let lib_dir = resource_target_lib_dir(&resources_root, resource_target);

    let (compiler, _llvm_ar, base_flags, sys_incs) =
        llvm_compile_base_args(&resource_dir, llvm_target)?;
    let mut cmd = Command::new(&compiler);
    for f in &base_flags { cmd.arg(f); }
    cmd.arg("-O3")
        .arg("-ffunction-sections")
        .arg("-fdata-sections")
        .arg("-fuse-ld=lld")
        .arg("-static")
        .arg("-Wl,--gc-sections");

    // Architecture-specific flags
    if board_id.starts_with("bb_") && !board_id.starts_with("bb_ai64") {
        cmd.arg("-march=armv7-a");
    }

    // Board-specific preprocessor defines
    if board_id == "rpi_5" {
        // RPi 5 uses /dev/gpiochip4 (RP1 chip) instead of the default gpiochip0
        cmd.arg(r#"-DKRON_GPIO_CHIP="/dev/gpiochip4""#);
    }
    // Jetson: all models use /dev/gpiochip0 by default (same as RPi).
    // Static linking (-static above) is sufficient — kronhal_jetson.h uses
    // only linux/gpio.h ioctls, termios, and AF_CAN sockets; no shared libs needed.

    // Detect whether EtherCAT runtime APIs are actually used by generated code.
    // If used, target builds must use real SOEM (no simulation fallback).
    let needs_ec_runtime = source.contains("kron_ec_init(")
        || source.contains("kron_ec_pdo_read(")
        || source.contains("kron_ec_pdo_write(")
        || source.contains("kron_ec_check_state(")
        || source.contains("kron_ec_process_sdo(");

    // Check whether EtherCAT implementation library is present.
    let has_ec_lib = fs::read_dir(&lib_dir).map(|entries| {
        entries.flatten().any(|e| {
            let n = e.file_name().to_string_lossy().to_lowercase();
            n.contains("ethercatmaster") || n.contains("kronec")
        })
    }).unwrap_or(false);

    // SOEM requires 4 separate -I paths for the full include chain.
    let soem_base_inc   = res_include.join("soem");
    let soem_inc        = soem_base_inc.join("include");
    let soem_osal       = soem_base_inc.join("osal");
    let soem_osal_linux = soem_base_inc.join("osal/linux");
    let soem_oshw_linux = soem_base_inc.join("oshw/linux");

    // Check if a full SOEM library (with ecx_init) is available.
    // libsoem.a may exist but contain only partial symbols (e.g. NIC layer only).
    // Use `ar -t` + `nm` to verify ecx_init is actually defined.
    let has_full_soem = fs::read_dir(&lib_dir).ok()
        .and_then(|entries| {
            entries.flatten().find(|e| {
                let n = e.file_name().to_string_lossy().to_lowercase();
                n.contains("soem") && n.ends_with(".a")
            })
        })
        .and_then(|e| std::process::Command::new("nm")
            .arg(e.path())
            .output().ok())
        .map(|out| String::from_utf8_lossy(&out.stdout).contains("ecx_init"))
        .unwrap_or(false);

    // Target build must not silently switch to simulation.
    if needs_ec_runtime && (!has_ec_lib || !has_full_soem) {
        return Err(
            "Target build requires real EtherCAT runtime, but SOEM is missing/incomplete. \
Run Build Libraries and ensure libsoem.a exports ecx_init. KRON_EC_SIM is only used by Simulation build."
                .to_string(),
        );
    }

    for inc in &sys_incs {
        cmd.arg("-isystem").arg(inc);
    }
    cmd.arg("-I").arg(&build_dir)
        .arg("-I").arg(&res_include);
    // Add SOEM include roots when present.
    for p in &[&soem_inc, &soem_osal, &soem_osal_linux, &soem_oshw_linux] {
        if p.exists() { cmd.arg("-I").arg(p); }
    }
    cmd
        .arg("-o").arg(&out_file)
        .arg(&plc_c);

    for lib_search in llvm_target_library_dirs(&resource_dir, llvm_target) {
        cmd.arg("-L").arg(lib_search);
    }
    // No --dynamic-linker with -static build

    // Link .a library files from selected target library directory.
    let a_files = collect_static_archives(&lib_dir);
    for a in &a_files { cmd.arg(a); }
    // -lrt: shm_open/shm_unlink (POSIX shared memory), clock_nanosleep (real-time clock)
    cmd.arg("-lm").arg("-lpthread").arg("-lrt");

    // Emit the full build command so the user can inspect it
    let cmd_str = format!("{:?}", cmd);
    let _ = app.emit("build-command", &cmd_str);

    let output = cmd.output()
        .map_err(|e| format!("Failed to run clang cross-compiler ({}): {}", compiler.display(), e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Clang cross-compilation failed:\nstderr: {}\nstdout: {}",
            stderr.trim(), stdout.trim()
        ));
    }

    Ok(out_file.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// deploy_to_server -- POST runtime.bin + variable_table to KronServer
// ---------------------------------------------------------------------------

#[tauri::command]
async fn deploy_to_server(app: tauri::AppHandle, server_addr: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || deploy_to_server_sync(app, server_addr))
        .await
        .map_err(|e| format!("Task error: {}", e))?
}

fn deploy_to_server_sync(app: tauri::AppHandle, server_addr: String) -> Result<String, String> {
    let build_dir = plain_path(&get_build_dir(&app)?);

    // POST runtime.bin
    let runtime_path = build_dir.join("runtime.bin");
    let runtime_bytes = fs::read(&runtime_path)
        .map_err(|e| format!("Cannot read runtime.bin: {}", e))?;

    let url_runtime = format!("http://{}/deploy/runtime", server_addr);
    let resp = ureq::post(&url_runtime)
        .set("Content-Type", "application/octet-stream")
        .send_bytes(&runtime_bytes)
        .map_err(|e| format!("Failed to deploy runtime: {}", e))?;

    if resp.status() >= 400 {
        return Err(format!("Runtime deploy failed: HTTP {}", resp.status()));
    }

    // POST variables.json
    let vt_path = build_dir.join("variables.json");
    let vt_bytes = fs::read(&vt_path)
        .map_err(|e| format!("Cannot read variables.json: {}", e))?;

    let url_vt = format!("http://{}/deploy/variable-table", server_addr);
    let resp = ureq::post(&url_vt)
        .set("Content-Type", "application/json")
        .send_bytes(&vt_bytes)
        .map_err(|e| format!("Failed to deploy variable table: {}", e))?;

    if resp.status() >= 400 {
        return Err(format!("Variable table deploy failed: HTTP {}", resp.status()));
    }

    Ok("Deployed successfully".into())
}

// ---------------------------------------------------------------------------
// check_server_status -- GET /status from KronServer
// ---------------------------------------------------------------------------

fn check_server_status_sync(server_addr: &str) -> Result<String, String> {
    let url = format!("http://{}/status", server_addr);
    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(3))
        .call()
        .map_err(|e| format!("Connection failed: {}", e))?;
    resp.into_string()
        .map_err(|e| format!("Failed to read response: {}", e))
}

#[tauri::command]
async fn check_server_status(server_addr: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || check_server_status_sync(&server_addr))
        .await
        .map_err(|e| format!("Task error: {}", e))?
}

// ---------------------------------------------------------------------------
// deploy_server_to_target -- SCP plc-agent binary to target + start via SSH
// ---------------------------------------------------------------------------

#[tauri::command]
async fn deploy_server_to_target(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    username: String,
    password: String,
    board_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || deploy_server_to_target_sync(app, host, port, username, password, board_id))
        .await
        .map_err(|e| format!("Task error: {}", e))?
}

fn deploy_server_to_target_sync(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    username: String,
    password: String,
    board_id: String,
) -> Result<String, String> {
    let resources_root = get_libraries_dir(&app)?;

    // Select the right binary based on board
    let (binary_name, resource_target) = if board_id.starts_with("rpi_pico") {
        return Err("Pico targets do not support remote server deployment".into());
    } else if board_id.starts_with("rpi_")
            || board_id == "bb_ai64" || board_id.starts_with("jetson_") {
        // aarch64: all RPi Linux boards + BeagleBone AI-64 + NVIDIA Jetson
        ("plc-agent_linux_arm64", "server/linux/arm64")
    } else if board_id.starts_with("bb_") {
        // armv7: BeagleBone Black / Green / AI
        ("plc-agent_linux_armv7", "server/linux/armv7")
    } else {
        ("plc-agent_linux_amd64", "server/linux/amd64")
    };

    let server_dir = resource_target_server_dir(&resources_root, resource_target);
    let binary_path = server_dir.join(binary_name);
    if !binary_path.exists() {
        return Err(format!(
            "Server binary not found: {}\nPlease build the server first (Settings > Libraries > Build Server)",
            binary_path.display()
        ));
    }

    let _ = app.emit("server-deploy-progress", "Connecting via SSH...");

    let tcp = std::net::TcpStream::connect(format!("{}:{}", host, port))
        .map_err(|e| format!("TCP connection to {}:{} failed: {}", host, port, e))?;

    let mut sess = ssh2::Session::new()
        .map_err(|e| format!("SSH session creation failed: {}", e))?;
    sess.set_tcp_stream(tcp);
    sess.handshake()
        .map_err(|e| format!("SSH handshake failed: {}", e))?;
    sess.userauth_password(&username, &password)
        .map_err(|e| format!("SSH authentication failed: {}", e))?;

    if !sess.authenticated() {
        return Err("SSH authentication failed: wrong username or password".into());
    }

    let _ = app.emit("server-deploy-progress", "Connected. Detecting home directory...");

    // Get the remote user's home directory
    let mut channel = sess.channel_session()
        .map_err(|e| format!("SSH channel error: {}", e))?;
    channel.exec("echo $HOME")
        .map_err(|e| format!("SSH exec error: {}", e))?;
    let mut home_dir = String::new();
    std::io::Read::read_to_string(&mut channel, &mut home_dir).ok();
    channel.wait_close().ok();
    let home_dir = home_dir.trim().to_string();
    let home_dir = if home_dir.is_empty() { format!("/home/{}", username) } else { home_dir };
    let remote_dir = format!("{}/plc", home_dir);
    let remote_bin = format!("{}/plc-agent", remote_dir);

    let _ = app.emit("server-deploy-progress", format!("Preparing target directory: {}", remote_dir));

    // sudo prefix: root user or empty password → no sudo needed
    let sudo_prefix = if username == "root" || password.is_empty() {
        String::new()
    } else {
        format!("echo '{}' | sudo -S ", password.replace('\'', "'\\''"))
    };

    // Stop any running agent (systemd first, then fallback to pkill)
    let _ = app.emit("server-deploy-progress", "Stopping existing plc-agent...");
    let stop_cmd = format!(
        "{0}systemctl stop plc-agent 2>/dev/null; pkill -f plc-agent 2>/dev/null; rm -f {1}; sleep 1; true",
        sudo_prefix, remote_bin
    );
    let mut channel = sess.channel_session()
        .map_err(|e| format!("SSH channel error: {}", e))?;
    channel.exec(&stop_cmd)
        .map_err(|e| format!("SSH exec error: {}", e))?;
    let mut out = String::new();
    std::io::Read::read_to_string(&mut channel, &mut out).ok();
    channel.wait_close().ok();

    let _ = app.emit("server-deploy-progress", "Uploading server binary via SFTP...");

    // Use SFTP for reliable file transfer (avoids SCP protocol issues)
    let binary_data = fs::read(&binary_path)
        .map_err(|e| format!("Cannot read binary: {}", e))?;

    let sftp = sess.sftp()
        .map_err(|e| format!("SFTP init failed: {}", e))?;

    // Create directory (ignore error if already exists)
    let _ = sftp.mkdir(std::path::Path::new(&remote_dir), 0o755);

    // Upload binary
    let remote_path = std::path::Path::new(&remote_bin);
    let mut remote_file = sftp.open_mode(
        remote_path,
        ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::TRUNCATE,
        0o755,
        ssh2::OpenType::File,
    ).map_err(|e| format!("SFTP create failed: {}", e))?;
    std::io::Write::write_all(&mut remote_file, &binary_data)
        .map_err(|e| format!("SFTP write failed: {}", e))?;
    drop(remote_file);

    // Set executable bit via chmod (SFTP open_mode sets it on create, but chmod is reliable)
    let chmod_cmd = format!("chmod +x {}", remote_bin);
    let mut channel = sess.channel_session()
        .map_err(|e| format!("SSH channel error: {}", e))?;
    channel.exec(&chmod_cmd)
        .map_err(|e| format!("SSH exec error: {}", e))?;
    channel.wait_close().ok();

    let _ = app.emit("server-deploy-progress", "Installing systemd service...");

    // Write systemd unit file and install it
    let unit_content = format!(
        "[Unit]\nDescription=PLC Agent (KronServer)\nAfter=network.target\n\n[Service]\nExecStart={} -addr :7070 -deploy-dir {} -shm-name plc_runtime -shm-size 65536\nRestart=always\nRestartSec=3\nWorkingDirectory={}\nUser=root\n\n[Install]\nWantedBy=multi-user.target\n",
        remote_bin, remote_dir, remote_dir
    );
    let install_cmd = format!(
        "cat > /tmp/plc-agent.service << 'UNIT'\n{unit}UNIT\n{sudo}cp /tmp/plc-agent.service /etc/systemd/system/plc-agent.service && {sudo}systemctl daemon-reload && {sudo}systemctl enable plc-agent",
        unit = unit_content,
        sudo = sudo_prefix
    );
    let mut channel = sess.channel_session()
        .map_err(|e| format!("SSH channel error: {}", e))?;
    channel.exec(&install_cmd)
        .map_err(|e| format!("SSH exec error: {}", e))?;
    let mut out = String::new();
    std::io::Read::read_to_string(&mut channel, &mut out).ok();
    channel.wait_close().ok();

    let _ = app.emit("server-deploy-progress", "Starting plc-agent service...");

    // Start the agent: try systemd first, fall back to direct nohup launch (for Yocto/no-systemd)
    let start_cmd = format!(
        "{sudo}systemctl start plc-agent 2>/dev/null || (pkill -f plc-agent 2>/dev/null; nohup {bin} -addr :7070 -deploy-dir {dir} -shm-name plc_runtime -shm-size 65536 > {dir}/plc-agent.log 2>&1 & sleep 1)",
        sudo = sudo_prefix,
        bin = remote_bin,
        dir = remote_dir
    );
    let mut channel = sess.channel_session()
        .map_err(|e| format!("SSH channel error: {}", e))?;
    channel.exec(&start_cmd)
        .map_err(|e| format!("SSH exec error: {}", e))?;
    let mut out = String::new();
    std::io::Read::read_to_string(&mut channel, &mut out).ok();
    channel.wait_close().ok();

    // Wait a moment for the agent to start
    std::thread::sleep(std::time::Duration::from_secs(2));

    let _ = app.emit("server-deploy-progress", "Verifying agent is running...");

    // Verify
    let check_addr = format!("{}:7070", host);
    match check_server_status_sync(&check_addr) {
        Ok(_) => {
            let _ = app.emit("server-deploy-progress", "plc-agent deployed and running!");
            Ok("Server deployed successfully".into())
        }
        Err(e) => {
            let _ = app.emit("server-deploy-progress",
                format!("WARNING: Agent may not have started: {}", e));
            Err(format!("Server deployed but verification failed: {}", e))
        }
    }
}

/// Windows: compile plc.c → plc.dll using bundled MinGW gcc.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn compile_simulation(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || compile_simulation_sync(app))
        .await
        .map_err(|e| format!("Task error: {}", e))?
}

#[cfg(target_os = "windows")]
fn compile_simulation_sync(app: tauri::AppHandle) -> Result<String, String> {
    let resource_dir = get_resource_dir(&app)?;
    let build_dir    = plain_path(&get_build_dir(&app)?);
    let (clang_path, base_flags) = bundled_host_clang_args(&resource_dir)?;
    let plc_c        = build_dir.join("plc.c");
    let plc_dll      = build_dir.join("plc.dll");
    let resources_root = get_libraries_dir(&app)?;
    let res_include  = resource_target_include_dir(&resources_root, "x86_64/win32");
    let sim_win      = resource_target_lib_dir(&resources_root, "x86_64/win32");

    let mut cmd = Command::new(&clang_path);
    for f in &base_flags { cmd.arg(f); }
    cmd.arg("--sysroot").arg(llvm_sysroot_dir(&resource_dir, "x86_64-w64-mingw32"))
        .arg("-shared")
        .arg("-fuse-ld=lld")
        .arg("-Wl,--export-all-symbols")
        .arg("-DKRON_EC_SIM")
        .arg("-I").arg(&build_dir)
        .arg("-I").arg(&res_include)
        .arg("-I").arg(res_include.join("soem/include"))
        .arg("-o").arg(&plc_dll)
        .arg(&plc_c);

    for inc in llvm_target_include_dirs(&resource_dir, "x86_64-w64-mingw32")? {
        cmd.arg("-isystem").arg(inc);
    }
    for lib_search in llvm_target_library_dirs(&resource_dir, "x86_64-w64-mingw32") {
        cmd.arg("-L").arg(lib_search);
    }
    let a_files = collect_static_archives(&sim_win);
    for a in &a_files { cmd.arg(a); }
    // SOEM on Windows requires winsock2, winmm, and IP helper
    let has_soem = a_files.iter().any(|p| p.file_name()
        .map_or(false, |n| n.to_string_lossy().contains("soem")));
    cmd.arg("-lm");
    if has_soem {
        cmd.arg("-lws2_32").arg("-lwinmm").arg("-liphlpapi");
    }

    let output = cmd.output()
        .map_err(|e| format!("Failed to run bundled clang ({}): {}", clang_path.display(), e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let code   = output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into());
        return Err(format!(
            "Clang/LLVM Windows simulation build failed (exit {})\nstderr: {}\nstdout: {}",
            code, stderr.trim(), stdout.trim()
        ));
    }

    Ok(plc_dll.to_string_lossy().to_string())
}

/// Linux/macOS: compile plc.c → simulation binary using bundled clang.
#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn compile_simulation(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || compile_simulation_sync(app))
        .await
        .map_err(|e| format!("Task error: {}", e))?
}

#[cfg(not(target_os = "windows"))]
fn compile_simulation_sync(app: tauri::AppHandle) -> Result<String, String> {
    let resource_dir  = get_resource_dir(&app)?;
    let resources_root = get_libraries_dir(&app)?;
    let build_dir     = plain_path(&get_build_dir(&app)?);
    let plc_c         = build_dir.join("plc.c");
    let out_file      = build_dir.join(SIM_BIN);
    let resource_target = if cfg!(target_os = "macos") {
        "x86_64/macos"
    } else {
        "x86_64/linux"
    };
    let res_include   = resource_target_include_dir(&resources_root, resource_target);
    let host_lib_dir  = resource_target_lib_dir(&resources_root, resource_target);
    let (clang_path, base_flags) = bundled_host_clang_args(&resource_dir)?;

    let mut cmd = Command::new(&clang_path);
    for f in &base_flags { cmd.arg(f); }
    // KRON_EC_SIM: use inline no-op stubs in kronethercatmaster.h (no SOEM linking needed for simulation)
    cmd.arg("-DKRON_EC_SIM")
        .arg("-I").arg(&build_dir)
        .arg("-I").arg(&res_include)
        .arg("-I").arg(llvm_sysroot_dir(&resource_dir, "simulation_env").join("include"))
        .arg("-I").arg(res_include.join("soem/include"))
        .arg("-fuse-ld=lld")
        .arg("-ffunction-sections")
        .arg("-fdata-sections")
        .arg("-O3")
        .arg("-o").arg(&out_file)
        .arg(&plc_c);

    // Simulation runs on the host; prefer static linking to avoid runtime path issues.
    #[cfg(not(target_os = "macos"))]
    cmd.arg("-static");

    let a_files = collect_static_archives(&host_lib_dir);
    for a in &a_files {
        cmd.arg(a);
    }
    // -lrt: shm_open/shm_unlink (POSIX shared memory), clock_nanosleep (real-time clock)
    cmd.arg("-lm").arg("-lpthread");
    #[cfg(not(target_os = "macos"))]
    cmd.arg("-lrt");
    #[cfg(target_os = "macos")]
    {
        cmd.arg("-framework").arg("CoreFoundation")
            .arg("-framework").arg("IOKit");
    }

    // Emit the full build command so the user can inspect it
    let cmd_str = format!("{:?}", cmd);
    let _ = app.emit("build-command", &cmd_str);

    let output = cmd.output()
        .map_err(|e| format!("Failed to run bundled clang ({}): {}", clang_path.display(), e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let code   = output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into());
        return Err(format!(
            "Clang/LLVM simulation build failed (exit {})\nstderr: {}\nstdout: {}",
            code, stderr.trim(), stdout.trim()
        ));
    }

    Ok(out_file.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// SimState
// ---------------------------------------------------------------------------

struct SimState {
    var_specs: Mutex<Vec<VarSpec>>,
    // Linux/macOS: subprocess approach
    #[cfg(not(target_os = "windows"))]
    process: Mutex<Option<Child>>,
    #[cfg(not(target_os = "windows"))]
    pid:     Mutex<Option<u32>>,
    // Windows: in-process DLL simulation
    #[cfg(target_os = "windows")]
    win: Mutex<Option<win_sim::WinCtx>>,
}

// ---------------------------------------------------------------------------
// PLC type helpers
// ---------------------------------------------------------------------------

fn type_size(vtype: &str) -> usize {
    match vtype.to_uppercase().as_str() {
        "BOOL" | "SINT" | "USINT"           => 1,
        "INT"  | "UINT"                     => 2,
        "DINT" | "UDINT" | "TIME" | "REAL"  => 4,
        "LINT" | "ULINT" | "LREAL"          => 8,
        "TON"  | "TOF"                      => 16,
        "CTU"                               => 8,
        _                                   => 0,
    }
}

fn decode_value(buf: &[u8], vtype: &str) -> Value {
    let u = vtype.to_uppercase();
    match u.as_str() {
        "BOOL"  => json!(buf[0] != 0),
        "SINT"  => json!(buf[0] as i8),
        "USINT" => json!(buf[0]),
        "INT"   => json!(i16::from_le_bytes([buf[0], buf[1]])),
        "UINT"  => json!(u16::from_le_bytes([buf[0], buf[1]])),
        "DINT"  => json!(i32::from_le_bytes(buf[0..4].try_into().unwrap_or([0; 4]))),
        "UDINT" | "TIME" => json!(u32::from_le_bytes(buf[0..4].try_into().unwrap_or([0; 4]))),
        "LINT"  => json!(i64::from_le_bytes(buf[0..8].try_into().unwrap_or([0; 8]))),
        "ULINT" => json!(u64::from_le_bytes(buf[0..8].try_into().unwrap_or([0; 8]))),
        "REAL"  => json!(f32::from_le_bytes(buf[0..4].try_into().unwrap_or([0; 4]))),
        "LREAL" => json!(f64::from_le_bytes(buf[0..8].try_into().unwrap_or([0; 8]))),
        "TON" | "TOF" if buf.len() >= 15 => json!({
            "PT":        u32::from_le_bytes(buf[0..4].try_into().unwrap_or([0;4])),
            "ET":        u32::from_le_bytes(buf[4..8].try_into().unwrap_or([0;4])),
            "StartTime": u32::from_le_bytes(buf[8..12].try_into().unwrap_or([0;4])),
            "IN": buf[12] != 0,
            "Q":  buf[13] != 0,
            "M":  buf[14] != 0,
        }),
        "CTU" if buf.len() >= 8 => json!({
            "PV":    i16::from_le_bytes([buf[0], buf[1]]),
            "CV":    i16::from_le_bytes([buf[2], buf[3]]),
            "CU":    buf[4] != 0,
            "RESET": buf[5] != 0,
            "Q":     buf[6] != 0,
            "M":     buf[7] != 0,
        }),
        _ => json!(null),
    }
}

fn encode_value(vtype: &str, value_str: &str) -> Option<Vec<u8>> {
    let u = vtype.to_uppercase();
    let s = value_str.trim();
    match u.as_str() {
        "BOOL" => {
            let b: u8 = match s.to_uppercase().as_str() {
                "TRUE" | "1" => 1,
                _             => 0,
            };
            Some(vec![b])
        }
        "SINT"  => Some((s.parse::<i8>().ok()? as u8).to_le_bytes().to_vec()),
        "USINT" => Some(s.parse::<u8>().ok()?.to_le_bytes().to_vec()),
        "INT"   => Some(s.parse::<i16>().ok()?.to_le_bytes().to_vec()),
        "UINT"  => Some(s.parse::<u16>().ok()?.to_le_bytes().to_vec()),
        "DINT"  => Some(s.parse::<i32>().ok()?.to_le_bytes().to_vec()),
        "UDINT" | "TIME" => Some(s.parse::<u32>().ok()?.to_le_bytes().to_vec()),
        "LINT"  => Some(s.parse::<i64>().ok()?.to_le_bytes().to_vec()),
        "ULINT" => Some(s.parse::<u64>().ok()?.to_le_bytes().to_vec()),
        "REAL"  => Some(s.parse::<f32>().ok()?.to_le_bytes().to_vec()),
        "LREAL" => Some(s.parse::<f64>().ok()?.to_le_bytes().to_vec()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Linux: write bytes into running process memory
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn write_proc_mem(pid: u32, address: u64, data: &[u8]) -> Result<(), String> {
    use std::io::{Seek, SeekFrom, Write};
    let path = format!("/proc/{}/mem", pid);
    let mut f = std::fs::OpenOptions::new().write(true).open(&path)
        .map_err(|e| format!("Cannot open {}: {}", path, e))?;
    f.seek(SeekFrom::Start(address)).map_err(|e| format!("Seek: {}", e))?;
    f.write_all(data).map_err(|e| format!("Write: {}", e))?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[cfg(not(target_os = "windows"))]
fn write_proc_mem(_pid: u32, _address: u64, _data: &[u8]) -> Result<(), String> {
    Err("Memory write not supported on this platform".into())
}

// ---------------------------------------------------------------------------
// VarSpec + symbol helpers (Linux)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct VarSpec {
    key:     String,
    address: u64,
    vtype:   String,
}

#[cfg(not(target_os = "windows"))]
fn parse_symbols(bin_path: &Path) -> Result<HashMap<String, u64>, String> {
    use object::{Object, ObjectSymbol};
    let data = fs::read(bin_path).map_err(|e| format!("Failed to read binary: {}", e))?;
    let obj  = object::File::parse(&*data)
        .map_err(|e| format!("Failed to parse binary: {}", e))?;
    let mut map = HashMap::new();
    for sym in obj.symbols() {
        if sym.address() == 0 { continue; }
        if let Ok(name) = sym.name() {
            if !name.is_empty() { map.insert(name.to_string(), sym.address()); }
        }
    }
    for sym in obj.dynamic_symbols() {
        if sym.address() == 0 { continue; }
        if let Ok(name) = sym.name() {
            if !name.is_empty() { map.entry(name.to_string()).or_insert(sym.address()); }
        }
    }
    Ok(map)
}

#[cfg(not(target_os = "windows"))]
fn build_var_specs(var_table: &Value, symbols: &HashMap<String, u64>) -> Vec<VarSpec> {
    let mut specs = Vec::new();
    if let Some(programs) = var_table.get("programs").and_then(|v| v.as_object()) {
        for (prog, prog_info) in programs {
            if let Some(vars) = prog_info.get("variables").and_then(|v| v.as_object()) {
                for (var_name, var_info) in vars {
                    let c_sym = var_info.get("c_symbol").and_then(|v| v.as_str()).unwrap_or("");
                    let vtype = var_info.get("type").and_then(|v| v.as_str()).unwrap_or("BOOL");
                    if let Some(&addr) = symbols.get(c_sym) {
                        specs.push(VarSpec {
                            key:   format!("prog_{}_{}", prog, var_name),
                            address: addr,
                            vtype: vtype.to_string(),
                        });
                    }
                }
            }
        }
    }
    if let Some(gvars) = var_table.get("globalVars").and_then(|v| v.as_object()) {
        for (var_name, var_info) in gvars {
            let c_sym = var_info.get("c_symbol").and_then(|v| v.as_str()).unwrap_or(var_name);
            let vtype = var_info.get("type").and_then(|v| v.as_str()).unwrap_or("BOOL");
            if let Some(&addr) = symbols.get(c_sym) {
                specs.push(VarSpec {
                    key:   format!("prog__{}", var_name),
                    address: addr,
                    vtype: vtype.to_string(),
                });
            }
        }
    }
    // Process debugDefaults entries with base_symbol: array elements and struct members
    if let Some(debug) = var_table.get("debugDefaults").and_then(|v| v.as_object()) {
        for (key, entry) in debug {
            let base_sym = match entry.get("base_symbol").and_then(|v| v.as_str()) {
                Some(s) => s,
                None => continue, // top-level var entries — already handled above
            };
            let byte_offset = entry.get("byte_offset").and_then(|v| v.as_u64()).unwrap_or(0);
            let vtype = entry.get("type").and_then(|v| v.as_str()).unwrap_or("BOOL");
            if let Some(&base_addr) = symbols.get(base_sym) {
                specs.push(VarSpec {
                    key:     key.clone(),
                    address: base_addr + byte_offset,
                    vtype:   vtype.to_string(),
                });
            }
        }
    }
    specs
}

// ---------------------------------------------------------------------------
// Linux: /proc/PID/mem reader
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod mem {
    use std::fs::OpenOptions;
    use std::io::{Read, Seek, SeekFrom};

    pub struct ProcMemReader { pid: u32 }

    impl ProcMemReader {
        pub fn open(pid: u32) -> Option<Self> {
            let path = format!("/proc/{}/mem", pid);
            if std::path::Path::new(&path).exists() { Some(ProcMemReader { pid }) } else { None }
        }
        pub fn read(&self, address: u64, size: usize) -> Option<Vec<u8>> {
            let mut f = OpenOptions::new().read(true)
                .open(format!("/proc/{}/mem", self.pid)).ok()?;
            f.seek(SeekFrom::Start(address)).ok()?;
            let mut buf = vec![0u8; size];
            f.read_exact(&mut buf).ok()?;
            Some(buf)
        }
        pub fn is_alive(&self) -> bool {
            std::path::Path::new(&format!("/proc/{}/mem", self.pid)).exists()
        }
    }
}

// ---------------------------------------------------------------------------
// run_simulation
// ---------------------------------------------------------------------------

/// Windows: load plc.dll (MinGW-compiled), get symbol pointers, start threads.
#[cfg(target_os = "windows")]
#[tauri::command]
fn run_simulation(
    app:   tauri::AppHandle,
    state: State<'_, SimState>,
) -> Result<String, String> {
    let build_dir     = plain_path(&get_build_dir(&app)?);
    let var_table_str = fs::read_to_string(build_dir.join("variables.json"))
        .map_err(|e| format!("Failed to read variables.json: {}", e))?;
    let var_table: Value = serde_json::from_str(&var_table_str)
        .map_err(|e| format!("Failed to parse variables.json: {}", e))?;

    if state.win.lock().unwrap().is_some() {
        return Err("Simulation is already running".into());
    }

    let (ctx, var_specs) = win_sim::load_and_run(app.clone(), &build_dir, &var_table)?;
    *state.win.lock().unwrap()      = Some(ctx);
    *state.var_specs.lock().unwrap() = var_specs;
    let _ = app.emit("simulation-output", json!({"status": "started"}).to_string());
    Ok("Simulation started".into())
}

/// Linux: subprocess + procfs memory reader.
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn run_simulation(
    app:   tauri::AppHandle,
    state: State<'_, SimState>,
) -> Result<String, String> {
    let build_dir      = plain_path(&get_build_dir(&app)?);
    let bin_path       = build_dir.join(SIM_BIN);
    let var_table_path = build_dir.join("variables.json");

    let var_table_str = fs::read_to_string(&var_table_path)
        .map_err(|e| format!("Failed to read variables.json: {}", e))?;
    let var_table: Value = serde_json::from_str(&var_table_str)
        .map_err(|e| format!("Failed to parse variables.json: {}", e))?;

    let symbols   = parse_symbols(&bin_path)?;
    let var_specs = build_var_specs(&var_table, &symbols);

    if var_specs.is_empty() {
        return Err("No variables matched in symbol table".into());
    }

    let mut proc_guard = state.process.lock().unwrap();
    if proc_guard.is_some() { return Err("Simulation is already running".into()); }

    let child = Command::new(&bin_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start simulation: {}", e))?;

    let pid = child.id();
    *proc_guard = Some(child);
    drop(proc_guard);

    *state.pid.lock().unwrap()       = Some(pid);
    *state.var_specs.lock().unwrap() = var_specs.clone();

    let _ = app.emit("simulation-output", json!({"status": "started"}).to_string());

    let app_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(100));
        let reader = match mem::ProcMemReader::open(pid) {
            Some(r) => r,
            None => {
                let _ = app_handle.emit("simulation-output",
                    json!({"error": "Failed to open process memory"}).to_string());
                return;
            }
        };
        loop {
            thread::sleep(Duration::from_millis(200));
            if !reader.is_alive() { break; }
            let mut vars_data: Map<String, Value> = Map::new();
            let mut any_ok = false;
            for spec in &var_specs {
                let size = type_size(&spec.vtype);
                if size == 0 { continue; }
                if let Some(buf) = reader.read(spec.address, size) {
                    vars_data.insert(spec.key.clone(), decode_value(&buf, &spec.vtype));
                    any_ok = true;
                }
            }
            if any_ok {
                let _ = app_handle.emit("simulation-output", json!({"vars": vars_data}).to_string());
            }
        }
        let _ = app_handle.emit("simulation-output", json!({"status": "exited"}).to_string());
    });

    Ok("Simulation started".into())
}

// ---------------------------------------------------------------------------
// stop_simulation
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
#[tauri::command]
fn stop_simulation(state: State<'_, SimState>) -> Result<String, String> {
    state.var_specs.lock().unwrap().clear();
    let was_running = state.win.lock().unwrap().take().is_some();
    // WinCtx::drop() signals plc_stop=1, joins threads, then FreeLibrary
    if was_running {
        Ok("Simulation stopped".into())
    } else {
        Err("No simulation running".into())
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn stop_simulation(state: State<'_, SimState>) -> Result<String, String> {
    *state.pid.lock().unwrap() = None;
    state.var_specs.lock().unwrap().clear();
    let mut proc_guard = state.process.lock().unwrap();
    if let Some(mut child) = proc_guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        Ok("Simulation stopped".into())
    } else {
        Err("No simulation running".into())
    }
}

// ---------------------------------------------------------------------------
// write_variable
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
#[tauri::command]
fn write_variable(
    name:  String,
    value: String,
    state: State<'_, SimState>,
) -> Result<(), String> {
    let (address, vtype) = {
        let specs = state.var_specs.lock().unwrap();
        let spec = specs.iter().find(|s| s.key == name)
            .ok_or_else(|| format!("Variable '{}' not found", name))?;
        (spec.address, spec.vtype.clone())
    };
    let data = encode_value(&vtype, &value)
        .ok_or_else(|| format!("Cannot encode '{}' as {}", value, vtype))?;
    // Direct pointer write into in-process DLL memory
    unsafe {
        let ptr = address as *mut u8;
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn write_variable(
    name:  String,
    value: String,
    state: State<'_, SimState>,
) -> Result<(), String> {
    let pid = state.pid.lock().unwrap().ok_or("No simulation running")?;
    let (address, vtype) = {
        let specs = state.var_specs.lock().unwrap();
        let spec = specs.iter().find(|s| s.key == name)
            .ok_or_else(|| format!("Variable '{}' not found", name))?;
        (spec.address, spec.vtype.clone())
    };
    let data = encode_value(&vtype, &value)
        .ok_or_else(|| format!("Cannot encode '{}' as {}", value, vtype))?;
    write_proc_mem(pid, address, &data)
}

// ---------------------------------------------------------------------------
// simulate_st (ST parser)
// ---------------------------------------------------------------------------

#[command]
fn simulate_st(code: String) -> Result<String, String> {
    let lexer = lexer::Token::lexer(&code);
    let parser_input = lexer.spanned().map(|(token, span)| match token {
        Ok(t) => Ok((span.start, t, span.end)),
        Err(_) => Err(()),
    });
    let parser = grammar::ProgramParser::new();
    match parser.parse(parser_input) {
        Ok(ast) => serde_json::to_string_pretty(&ast).map_err(|e| e.to_string()),
        Err(e) => Err(format!("Parse Error: {:?}", e)),
    }
}

// ---------------------------------------------------------------------------
// build_soem — Clone SOEM v2.0.0 and compile libsoem.a for all toolchains
// ---------------------------------------------------------------------------

fn do_build_soem(app: &tauri::AppHandle) -> Result<(), String> {
    let out_dirs      = get_target_resources_dirs(app);
    if out_dirs.is_empty() { return Err("Cannot locate resources directory".into()); }
    let resources_root = out_dirs[0].clone();
    let resource_dir = resources_root.parent()
        .ok_or_else(|| "Cannot find parent of resources root".to_string())?
        .to_path_buf();
    let target_names = ["x86_64/linux","x86_64/win32","arm/aarch64","arm/armv7",
                        "arm/CortexM/M0","arm/CortexM/M4","arm/CortexM/M7"];
    for tname in &target_names {
        let _ = fs::create_dir_all(resource_target_lib_dir(&resources_root, tname));
        let _ = fs::create_dir_all(resource_target_include_dir(&resources_root, tname).join("soem"));
    }

    let temp_dir = std::env::temp_dir().join("kroneditor_soem_build");
    let _ = fs::remove_dir_all(&temp_dir);
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    let soem_dir = temp_dir.join("SOEM");
    let _ = app.emit("library-update-progress", "[SOEM] Cloning v2.0.0...".to_string());

    let clone_out = Command::new("git")
        .args(["clone", "--depth=1", "--branch", "v2.0.0",
               "https://github.com/OpenEtherCATsociety/SOEM.git"])
        .arg(&soem_dir)
        .output()
        .map_err(|e| format!("git not found: {}", e))?;

    if !clone_out.status.success() {
        let msg = format!("[SOEM] Clone failed: {}",
            String::from_utf8_lossy(&clone_out.stderr).trim());
        let _ = app.emit("library-update-progress", format!("ERROR: {}", msg));
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(msg);
    }
    let _ = app.emit("library-update-progress", "[SOEM] Cloned OK".to_string());

    // ── Generate ec_options.h (cmake-generated, not present in raw git clone) ──
    {
        let cmake_gen_dir = temp_dir.join("soem_cmake_gen");
        let ec_options_dst = soem_dir.join("include").join("soem").join("ec_options.h");

        // Try cmake configure first
        let cmake_ok = Command::new("cmake")
            .args([
                "-S", soem_dir.to_str().unwrap_or("."),
                "-B", cmake_gen_dir.to_str().unwrap_or("soem_cmake_gen"),
                "-DCMAKE_BUILD_TYPE=Release",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        let generated = if cmake_ok {
            let cmake_out = cmake_gen_dir.join("include").join("soem").join("ec_options.h");
            if cmake_out.exists() {
                fs::copy(&cmake_out, &ec_options_dst).is_ok()
            } else {
                false
            }
        } else {
            false
        };

        if generated {
            let _ = app.emit("library-update-progress",
                "[SOEM] ec_options.h generated via cmake".to_string());
        } else {
            // cmake not available or generated file missing — write hardcoded defaults
            // These match SOEM v2.0.0 CMakeLists.txt default values
            let default_content = "\
/* ec_options.h — auto-generated defaults (cmake not available) */\n\
#ifndef EC_OPTIONS_H\n\
#define EC_OPTIONS_H\n\
\n\
/** Maximum number of slaves */\n\
#define EC_MAXSLAVE          200\n\
/** Maximum number of groups */\n\
#define EC_MAXGROUP          2\n\
/** Maximum number of IO segments per group */\n\
#define EC_MAXIOSEGMENTS     64\n\
/** Maximum mailbox size */\n\
#define EC_MAXMBX            0x400\n\
/** Size of EEPROM bitmap */\n\
#define EC_MAXEEPBITMAP      128\n\
/** Size of EEPROM buffer */\n\
#define EC_MAXEEPBUF         (EC_MAXEEPBITMAP * 2)\n\
/** Maximum entries in Object Description list */\n\
#define EC_MAXODLIST         1024\n\
/** Maximum number of SyncManagers */\n\
#define EC_MAXSM             8\n\
/** Maximum number of FMMU entries */\n\
#define EC_MAXFMMU           4\n\
/** Maximum number of process data frames */\n\
#define EC_MAXBUF            16\n\
/** Maximum number of lost EtherCAT frames */\n\
#define EC_MAXLOST           2\n\
/** Maximum burst reads */\n\
#define EC_MAXBURSTREADS     15\n\
/** Timeout value for safe mode in microseconds */\n\
#define EC_TIMEOUTSAFE       20000\n\
/** Timeout return in microseconds */\n\
#define EC_TIMEOUTRET        2000\n\
/** Monitor timeout in ms */\n\
#define EC_TIMEOUTMON        500\n\
/** Log level (0=off, 3=verbose) */\n\
#define EC_LOG_LEVEL         3\n\
\n\
#endif /* EC_OPTIONS_H */\n";
            let _ = fs::write(&ec_options_dst, default_content);
            let _ = app.emit("library-update-progress",
                "[SOEM] ec_options.h written with default values (cmake not found)".to_string());
        }
    }

    // SOEM directory layout:
    //   include/soem/   ← public headers (ec_*.h, soem.h)
    //   src/            ← core .c sources (v2.x)
    //   soem/           ← core .c sources (older trees)
    //   oshw/linux/     ← Linux OSHW sources + nicdrv.h, oshw.h
    //   oshw/win32/     ← Win32 OSHW sources + nicdrv.h, oshw.h + wpcap/
    //   osal/           ← common OSAL source + osal.h
    //   osal/linux/     ← Linux OSAL
    //   osal/win32/     ← Win32 OSAL
    let repo_inc_dir     = soem_dir.join("include");          // -I for "soem/soem.h"
    let soem_src_dir_v2  = soem_dir.join("src");
    let soem_src_dir_v1  = soem_dir.join("soem");
    let soem_src_dir     = if soem_src_dir_v2.exists() {
        soem_src_dir_v2
    } else {
        soem_src_dir_v1
    };
    let legacy_core_layout = soem_src_dir.ends_with("soem");
    let oshw_linux_dir   = soem_dir.join("oshw").join("linux");
    let oshw_win32_dir   = soem_dir.join("oshw").join("win32");
    let wpcap_inc_dir    = oshw_win32_dir.join("wpcap").join("Include");
    let osal_dir         = soem_dir.join("osal");
    let osal_linux_dir   = soem_dir.join("osal").join("linux");
    let osal_win32_dir   = soem_dir.join("osal").join("win32");

    // Filter helper
    let filter_c = |v: Vec<PathBuf>| -> Vec<PathBuf> {
        v.into_iter().filter(|p| {
            let n = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
            !n.starts_with("test") && !n.starts_with("example")
        }).collect()
    };

    let core_sources        = filter_c(find_files_with_ext(&soem_src_dir,   "c"));
    let linux_oshw_sources  = filter_c(find_files_with_ext(&oshw_linux_dir, "c"));
    let win32_oshw_sources  = filter_c(find_files_with_ext(&oshw_win32_dir, "c"));
    // Only legacy trees require osal/*.c from the root.
    // SOEM v2.x Linux/Windows builds use only osal/linux/osal.c or osal/win32/osal.c.
    let osal_root_sources: Vec<PathBuf> = {
        if !legacy_core_layout {
            Vec::new()
        } else {
        let mut v = Vec::new();
        if let Ok(entries) = fs::read_dir(&osal_dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_file() && p.extension().and_then(|x| x.to_str()) == Some("c") {
                    let n = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                    if !n.starts_with("test") && !n.starts_with("example") {
                        v.push(p);
                    }
                }
            }
        }
        v
        }
    };
    let osal_linux_sources  = filter_c(find_files_with_ext(&osal_linux_dir, "c"));
    let osal_win32_sources  = filter_c(find_files_with_ext(&osal_win32_dir, "c"));

    if core_sources.is_empty() {
        let msg = format!(
            "[SOEM] No core C sources found (checked: {}). Build aborted to avoid partial libsoem.a",
            soem_src_dir.display()
        );
        let _ = app.emit("library-update-progress", format!("ERROR: {}", msg));
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(msg);
    }

    let _ = app.emit("library-update-progress", format!(
        "[SOEM] Source sets: core={}, linux_oshw={}, win32_oshw={}, osal_root={}, osal_linux={}, osal_win32={}",
        core_sources.len(),
        linux_oshw_sources.len(),
        win32_oshw_sources.len(),
        osal_root_sources.len(),
        osal_linux_sources.len(),
        osal_win32_sources.len()
    ));

    // Copy entire SOEM repo header tree preserving directory structure:
    //   SOEM/include/soem/soem.h  →  resources/include/soem/include/soem/soem.h
    //   SOEM/oshw/linux/nicdrv.h  →  resources/include/soem/oshw/linux/nicdrv.h
    //   SOEM/osal/osal.h          →  resources/include/soem/osal/osal.h  etc.
    let all_hdrs = find_files_with_ext(&soem_dir, "h");
    let mut copied = 0usize;
    for h in &all_hdrs {
        if let Ok(rel) = h.strip_prefix(&soem_dir) {
            for od in &out_dirs {
                let dst = resource_target_include_dir(od, "x86_64/linux").join("soem").join(rel);
                if let Some(parent) = dst.parent() { let _ = fs::create_dir_all(parent); }
                if fs::copy(h, &dst).is_ok() { copied += 1; }
            }
        }
    }
    for tname in target_names.iter().skip(1) {
        let src_base = resource_target_include_dir(&resources_root, "x86_64/linux").join("soem");
        let dst_base = resource_target_include_dir(&resources_root, tname).join("soem");
        let _ = fs::create_dir_all(&dst_base);
        if let Ok(entries) = fs::read_dir(&src_base) {
            for _ in entries.flatten() {}
        }
        let _ = copy_dir_all(&src_base, &dst_base);
    }
    let _ = app.emit("library-update-progress",
        format!("[SOEM] Copied {} headers → include/soem/ (structure preserved)", copied));

    // Helper: compile .c files into libsoem.a
    let compile_soem_ar = |
        tag:        &str,
        compiler:   &Path,
        cc_flags:   &[String],
        sys_incs:   &[PathBuf],
        ar_cmd:     &Path,
        out_dir:    &Path,
        sources:    &[PathBuf],
        inc_dirs:   &[&Path],
    | -> Result<(), String> {
        let _ = app.emit("library-update-progress",
            format!("[SOEM] Compiling for {}...", tag));
        let mut obj_files: Vec<PathBuf> = Vec::new();
        for src in sources {
            let stem = src.file_stem().unwrap_or_default().to_string_lossy();
            let obj  = temp_dir.join(format!("soem_{}_{}.o", tag.replace('/', "_"), stem));
            let mut cmd = Command::new(compiler);
            for f in cc_flags { cmd.arg(f); }
            for inc in sys_incs { if inc.exists() { cmd.arg("-isystem").arg(inc); } }
            for inc in inc_dirs { cmd.arg("-I").arg(inc); }
            cmd.arg("-c").arg(src).arg("-o").arg(&obj);
            let out = cmd.output()
                .map_err(|e| format!("[SOEM][{}] spawn error: {}", tag, e))?;
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let _ = fs::remove_file(&obj);
                return Err(format!("[SOEM][{}] compile error ({}): {}",
                    tag, src.file_name().unwrap_or_default().to_string_lossy(), stderr.trim()));
            }
            obj_files.push(obj);
        }
        if obj_files.is_empty() {
            let _ = app.emit("library-update-progress",
                format!("[SOEM][{}] WARN: no sources compiled", tag));
            return Ok(());
        }
        let lib_path = out_dir.join("libsoem.a");
        let mut ar = Command::new(ar_cmd);
        ar.arg("rcs").arg(&lib_path);
        for obj in &obj_files { ar.arg(obj); }
        let ar_out = ar.output()
            .map_err(|e| format!("[SOEM][{}] ar error: {}", tag, e))?;
        for obj in &obj_files { let _ = fs::remove_file(obj); }
        if !ar_out.status.success() {
            return Err(format!("[SOEM][{}] archive error: {}",
                tag, String::from_utf8_lossy(&ar_out.stderr).trim()));
        }
        let _ = app.emit("library-update-progress",
            format!("[SOEM][{}] libsoem.a OK", tag));
        Ok(())
    };

    let repo_inc_ref        = repo_inc_dir.as_path();
    let oshw_linux_ref      = oshw_linux_dir.as_path();
    let oshw_win32_ref      = oshw_win32_dir.as_path();
    let wpcap_ref           = wpcap_inc_dir.as_path();
    let osal_ref            = osal_dir.as_path();
    let osal_linux_ref      = osal_linux_dir.as_path();
    let osal_win32_ref      = osal_win32_dir.as_path();

    // Linux sources: core + oshw/linux + osal_root (common) + osal/linux
    let mut linux_sources: Vec<PathBuf> = core_sources.clone();
    linux_sources.extend(linux_oshw_sources.clone());
    linux_sources.extend(osal_root_sources.clone());
    linux_sources.extend(osal_linux_sources.clone());

    // Win32 sources: core + oshw/win32 + osal_root (common) + osal/win32
    let mut win32_sources: Vec<PathBuf> = core_sources.clone();
    win32_sources.extend(win32_oshw_sources.clone());
    win32_sources.extend(osal_root_sources.clone());
    // Patch osal/win32/osal.c: replace timespec_get() call with _ftime64_s().
    // Older MinGW-w64 (MSVCRT runtime) doesn't expose timespec_get even with -std=c11.
    for src in &osal_win32_sources {
        let is_win32_osal = src.file_name().map(|n| n == "osal.c").unwrap_or(false)
            && src.parent().map(|p| p.ends_with("win32")).unwrap_or(false);
        if is_win32_osal {
            if let Ok(content) = fs::read_to_string(src) {
                if content.contains("timespec_get") {
                    let patched = std::iter::once(
                        "#include <sys/timeb.h>\n#ifndef TIME_UTC\n#define TIME_UTC 1\n#endif\n"
                            .to_string(),
                    )
                    .chain(content.lines().map(|line| {
                        if line.contains("timespec_get(") {
                            // replace: timespec_get(&ts, TIME_UTC);
                            // with:    _ftime64_s equivalent
                            "   { struct __timeb64 _ftb; _ftime64_s(&_ftb); \
                             ts.tv_sec=(time_t)_ftb.time; \
                             ts.tv_nsec=(long)_ftb.millitm*1000000L; }\n"
                                .to_string()
                        } else if line.contains("TIME_UTC") && !line.contains("timespec_get(") {
                            // drop bare TIME_UTC references that became orphaned
                            String::new()
                        } else {
                            format!("{}\n", line)
                        }
                    }))
                    .collect::<String>();
                    let patched_path = temp_dir.join("osal_win32_patched.c");
                    if fs::write(&patched_path, patched).is_ok() {
                        win32_sources.push(patched_path);
                        continue; // don't push the original
                    }
                }
            }
        }
        win32_sources.push(src.clone());
    }

    // Linux include dirs: repo/include (soem/*.h), oshw/linux (nicdrv.h), osal, osal/linux
    let linux_inc: &[&Path] = &[repo_inc_ref, oshw_linux_ref, osal_ref, osal_linux_ref];
    // Win32 include dirs: repo/include, oshw/win32, wpcap/Include, osal, osal/win32
    let win32_inc: &[&Path] = &[repo_inc_ref, oshw_win32_ref, wpcap_ref, osal_ref, osal_win32_ref];

    // x86_64/linux
    {
        let out_dir = resource_target_lib_dir(&resources_root, "x86_64/linux");
        match llvm_compile_base_args(&resource_dir, "x86_64-linux-gnu") {
            Ok((clang, llvm_ar, mut cc_flags, sys_incs)) => {
                cc_flags.extend(["-O3", "-ffunction-sections", "-fdata-sections",
                    "-DLINUX", "-pthread"].iter().map(|s| s.to_string()));
                if let Err(e) = compile_soem_ar(
                    "x86_64/linux", &clang, &cc_flags, &sys_incs, &llvm_ar, &out_dir, &linux_sources, linux_inc)
                {
                    let _ = app.emit("library-update-progress", format!("WARN: {}", e));
                }
            }
            Err(e) => {
                let _ = app.emit("library-update-progress", format!("WARN: {}", e));
            }
        }
    }

    // x86_64/win32 (Clang + llvm-mingw sysroot)
    {
        let out_dir = resource_target_lib_dir(&resources_root, "x86_64/win32");
        match llvm_compile_base_args(&resource_dir, "x86_64-w64-mingw32") {
            Ok((clang, llvm_ar, mut cc_flags, sys_incs)) => {
                cc_flags.extend(["-O3", "-ffunction-sections", "-fdata-sections",
                    "-DWIN32", "-D_WIN32"].iter().map(|s| s.to_string()));
                if let Err(e) = compile_soem_ar(
                    "x86_64/win32", &clang, &cc_flags, &sys_incs, &llvm_ar, &out_dir, &win32_sources, win32_inc)
                {
                    let _ = app.emit("library-update-progress", format!("WARN: {}", e));
                }
            }
            Err(e) => {
                let _ = app.emit("library-update-progress",
                    format!("[SOEM][x86_64/win32] SKIP: {}", e));
            }
        }
    }

    // arm/aarch64
    {
        let out_dir = resource_target_lib_dir(&resources_root, "arm/aarch64");
        match llvm_compile_base_args(&resource_dir, "aarch64-linux-gnu") {
            Ok((clang, llvm_ar, mut cc_flags, sys_incs)) => {
                cc_flags.extend(["-O3", "-ffunction-sections", "-fdata-sections",
                    "-DLINUX", "-pthread"].iter().map(|s| s.to_string()));
                if let Err(e) = compile_soem_ar(
                    "arm/aarch64", &clang, &cc_flags, &sys_incs,
                    &llvm_ar, &out_dir, &linux_sources, linux_inc)
                {
                    let _ = app.emit("library-update-progress", format!("WARN: {}", e));
                }
            }
            Err(e) => {
                let _ = app.emit("library-update-progress",
                    format!("[SOEM][arm/aarch64] SKIP: {}", e));
            }
        }
    }

    // arm/armv7 (ARMv7 Linux, e.g. Raspberry Pi 32-bit, BeagleBone)
    {
        let out_dir = resource_target_lib_dir(&resources_root, "arm/armv7");
        match llvm_compile_base_args(&resource_dir, "arm-linux-gnueabihf") {
            Ok((clang, llvm_ar, mut cc_flags, sys_incs)) => {
                cc_flags.extend(["-O3", "-ffunction-sections", "-fdata-sections",
                    "-DLINUX", "-pthread"].iter().map(|s| s.to_string()));
                if let Err(e) = compile_soem_ar(
                    "arm/armv7", &clang, &cc_flags, &sys_incs, &llvm_ar, &out_dir, &linux_sources, linux_inc)
                {
                    let _ = app.emit("library-update-progress", format!("WARN: {}", e));
                }
            }
            Err(e) => {
                let _ = app.emit("library-update-progress",
                    format!("[SOEM][arm/armv7] SKIP: {}", e));
            }
        }
    }

    // arm/CortexM bare-metal
    // SOEM v2 core depends on platform-specific packed/type/port definitions and cannot be
    // built as a generic static archive for Cortex-M without a concrete OSHW/OSAL port.
    // Skip these targets here to avoid noisy compile errors; bare-metal EtherCAT requires a
    // dedicated board-specific SOEM port supplied by the user/toolchain.
    for m_tag in &["arm/CortexM/M0", "arm/CortexM/M4", "arm/CortexM/M7"] {
        let _ = app.emit("library-update-progress",
            format!("[SOEM][{}] SKIP: bare-metal SOEM v2 generic build is not supported", m_tag));
    }

    let _ = fs::remove_dir_all(&temp_dir);
    let _ = app.emit("library-update-progress", "[SOEM] Build complete".to_string());
    Ok(())
}

#[tauri::command]
fn build_soem(app: tauri::AppHandle) -> Result<String, String> {
    std::thread::spawn(move || {
        match do_build_soem(&app) {
            Ok(()) => {
                let _ = app.emit("library-update-done",
                    json!({"success": true, "message": "SOEM built successfully"}));
            }
            Err(e) => {
                let _ = app.emit("library-update-done",
                    json!({"success": false, "message": e}));
            }
        }
    });
    Ok("started".to_string())
}

// ---------------------------------------------------------------------------
// ec_request_state — request an EtherCAT state transition at runtime
// ---------------------------------------------------------------------------

#[tauri::command]
fn ec_request_state(app: tauri::AppHandle, state: String) -> Result<(), String> {
    // Emit the request so the simulation layer (or future IPC channel) can act on it.
    // State id strings: "init" | "preop" | "safeop" | "op"
    let code: u8 = match state.as_str() {
        "init"   => 0x01,
        "preop"  => 0x02,
        "safeop" => 0x04,
        "op"     => 0x08,
        other    => return Err(format!("Unknown EC state: {}", other)),
    };
    let _ = app.emit("ec-state-request", json!({ "state": state, "state_code": code }));
    Ok(())
}

// ---------------------------------------------------------------------------
// build_canopen — Clone CANopenNode and compile libcanopen.a for all toolchains
// ---------------------------------------------------------------------------

fn do_build_canopen(app: &tauri::AppHandle) -> Result<(), String> {
    let out_dirs      = get_target_resources_dirs(app);
    if out_dirs.is_empty() { return Err("Cannot locate resources directory".into()); }
    let resources_root = out_dirs[0].clone();
    let resource_dir = resources_root.parent()
        .ok_or_else(|| "Cannot find parent of resources root".to_string())?
        .to_path_buf();
    let target_names = ["x86_64/linux","x86_64/win32","arm/aarch64","arm/armv7",
                        "arm/CortexM/M0","arm/CortexM/M4","arm/CortexM/M7"];
    for tname in &target_names {
        let _ = fs::create_dir_all(resource_target_include_dir(&resources_root, tname).join("canopen"));
        let _ = fs::create_dir_all(resource_target_lib_dir(&resources_root, tname));
    }

    let temp_dir = std::env::temp_dir().join("kroneditor_canopen_build");
    let _ = fs::remove_dir_all(&temp_dir);
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    let repo_dir = temp_dir.join("CANopenNode");
    let _ = app.emit("library-update-progress", "[CANopen] Cloning CANopenNode...".to_string());

    let clone_out = Command::new("git")
        .args(["clone", "--depth=1",
               "https://github.com/CANopenNode/CANopenNode.git"])
        .arg(&repo_dir)
        .output()
        .map_err(|e| format!("git not found: {}", e))?;

    if !clone_out.status.success() {
        let msg = format!("[CANopen] Clone failed: {}",
            String::from_utf8_lossy(&clone_out.stderr).trim());
        let _ = app.emit("library-update-progress", format!("ERROR: {}", msg));
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(msg);
    }
    let _ = app.emit("library-update-progress", "[CANopen] Cloned OK".to_string());

    // Copy all headers preserving directory structure
    //   CANopenNode/CANopen.h          → resources/include/canopen/CANopen.h
    //   CANopenNode/301/CO_SDOserver.h → resources/include/canopen/301/CO_SDOserver.h
    //   CANopenNode/socketCAN/*.h      → resources/include/canopen/socketCAN/*.h  etc.
    let all_hdrs = find_files_with_ext(&repo_dir, "h");
    let mut copied = 0usize;
    for h in &all_hdrs {
        if let Ok(rel) = h.strip_prefix(&repo_dir) {
            let rel_str = rel.to_string_lossy().to_lowercase();
            if rel_str.starts_with("example") || rel_str.starts_with("doc")
                || rel_str.starts_with("test") { continue; }
            for od in &out_dirs {
                let dst = resource_target_include_dir(od, "x86_64/linux").join("canopen").join(rel);
                if let Some(parent) = dst.parent() { let _ = fs::create_dir_all(parent); }
                if fs::copy(h, &dst).is_ok() { copied += 1; }
            }
        }
    }
    for tname in target_names.iter().skip(1) {
        let src_base = resource_target_include_dir(&resources_root, "x86_64/linux").join("canopen");
        let dst_base = resource_target_include_dir(&resources_root, tname).join("canopen");
        let _ = copy_dir_all(&src_base, &dst_base);
    }
    let _ = app.emit("library-update-progress",
        format!("[CANopen] Copied {} headers → include/canopen/ (structure preserved)", copied));

    // ── Source file collections ──────────────────────────────────────────────
    let dir_301        = repo_dir.join("301");
    let dir_303        = repo_dir.join("303");
    let dir_305        = repo_dir.join("305");
    let dir_socketcan  = repo_dir.join("socketCAN");

    let filter_c = |v: Vec<PathBuf>| -> Vec<PathBuf> {
        v.into_iter().filter(|p| {
            let n = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
            !n.starts_with("test") && !n.starts_with("example")
        }).collect()
    };

    // Root CANopen.c
    let root_c: Vec<PathBuf> = {
        let f = repo_dir.join("CANopen.c");
        if f.exists() { vec![f] } else { vec![] }
    };

    let core_301  = filter_c(find_files_with_ext(&dir_301,       "c"));
    let core_303  = filter_c(find_files_with_ext(&dir_303,       "c"));
    let core_305  = filter_c(find_files_with_ext(&dir_305,       "c"));
    let socketcan = filter_c(find_files_with_ext(&dir_socketcan, "c"));

    // Linux/aarch64/armv7: core + socketCAN driver
    let mut linux_sources: Vec<PathBuf> = Vec::new();
    linux_sources.extend(root_c.clone());
    linux_sources.extend(core_301.clone());
    linux_sources.extend(core_303.clone());
    linux_sources.extend(core_305.clone());
    linux_sources.extend(socketcan.clone());

    // Bare-metal: core only — CAN driver supplied by user at link time
    let mut bm_sources: Vec<PathBuf> = Vec::new();
    bm_sources.extend(root_c.clone());
    bm_sources.extend(core_301.clone());
    bm_sources.extend(core_303.clone());
    bm_sources.extend(core_305.clone());

    // ── Write bare-metal CO_driver_target.h stub ────────────────────────────
    // CANopenNode requires CO_driver_target.h (not shipped — platform-specific).
    // This stub satisfies the include for compilation; users replace it at link time.
    let bm_inc_dir = temp_dir.join("co_bm_inc");
    let _ = fs::create_dir_all(&bm_inc_dir);
    let co_driver_target_h = "\
/* CO_driver_target.h — bare-metal stub generated by KronEditor */\n\
#ifndef CO_DRIVER_TARGET_H\n\
#define CO_DRIVER_TARGET_H\n\
\n\
#include <stddef.h>\n\
#include <stdint.h>\n\
#include <stdbool.h>\n\
\n\
/* CAN message structure */\n\
typedef struct {\n\
    uint32_t ident;   /* CAN identifier, 11 or 29 bit */\n\
    uint8_t  DLC;     /* Data length code (0..8) */\n\
    uint8_t  data[8]; /* Data bytes */\n\
} CO_CANrxMsg_t;\n\
\n\
/* CAN receive callback type */\n\
typedef void (*CO_CANrxBufferCallback_t)(void *object, void *message);\n\
\n\
/* CAN TX buffer */\n\
typedef struct {\n\
    uint32_t ident;   /* CAN identifier with flags */\n\
    uint8_t  DLC;\n\
    uint8_t  data[8];\n\
    volatile bool bufferFull;\n\
    volatile bool syncFlag;\n\
} CO_CANtx_t;\n\
\n\
/* CAN module (opaque — provided by platform driver) */\n\
typedef struct CO_CANmodule_t CO_CANmodule_t;\n\
\n\
/* Endianness: assume little-endian (ARM Cortex-M) */\n\
#ifndef CO_LITTLE_ENDIAN\n\
# define CO_LITTLE_ENDIAN\n\
#endif\n\
\n\
/* Memory alignment */\n\
#define CO_CONFIG_GLOBAL_FLAG_CALLBACK_PRE  0\n\
#define CO_CONFIG_GLOBAL_FLAG_OD_DYNAMIC    0\n\
\n\
/* Atomic access — bare-metal: disable interrupts around critical sections */\n\
#define CO_LOCK_CAN_SEND(m)    do {} while(0)\n\
#define CO_UNLOCK_CAN_SEND(m)  do {} while(0)\n\
#define CO_LOCK_EMCY(m)        do {} while(0)\n\
#define CO_UNLOCK_EMCY(m)      do {} while(0)\n\
#define CO_LOCK_OD(m)          do {} while(0)\n\
#define CO_UNLOCK_OD(m)        do {} while(0)\n\
\n\
/* Memory barriers */\n\
#define CANrxMemoryBarrier()   do {} while(0)\n\
\n\
#endif /* CO_DRIVER_TARGET_H */\n";
    let _ = fs::write(bm_inc_dir.join("CO_driver_target.h"), co_driver_target_h);

    // Also write a minimal CO_driver.h override for bare-metal (some builds expect it at root)
    // Most versions include it transitively; write a passthrough just in case.
    let _ = fs::write(bm_inc_dir.join("CO_driver.h"),
        "/* CO_driver.h — bare-metal passthrough */\n\
         #pragma once\n\
         #include \"CO_driver_target.h\"\n");

    // ── compile_canopen_ar closure ──────────────────────────────────────────
    let compile_canopen_ar = |
        tag:        &str,
        compiler:   &Path,
        cc_flags:   &[String],
        sys_incs:   &[PathBuf],
        ar_cmd:     &Path,
        out_dir:    &Path,
        sources:    &[PathBuf],
        inc_dirs:   &[&Path],
    | -> Result<(), String> {
        let _ = app.emit("library-update-progress",
            format!("[CANopen] Compiling for {}...", tag));
        if sources.is_empty() {
            let _ = app.emit("library-update-progress",
                format!("[CANopen][{}] WARN: no sources found", tag));
            return Ok(());
        }
        let mut obj_files: Vec<PathBuf> = Vec::new();
        for src in sources {
            let stem = src.file_stem().unwrap_or_default().to_string_lossy();
            let obj  = temp_dir.join(format!("co_{}_{}.o", tag.replace('/', "_"), stem));
            let mut cmd = Command::new(compiler);
            for f in cc_flags { cmd.arg(f); }
            for inc in sys_incs { if inc.exists() { cmd.arg("-isystem").arg(inc); } }
            for inc in inc_dirs { cmd.arg("-I").arg(inc); }
            cmd.arg("-c").arg(src).arg("-o").arg(&obj);
            let out = cmd.output()
                .map_err(|e| format!("[CANopen][{}] spawn error: {}", tag, e))?;
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let _ = fs::remove_file(&obj);
                return Err(format!("[CANopen][{}] compile error ({}): {}",
                    tag, src.file_name().unwrap_or_default().to_string_lossy(), stderr.trim()));
            }
            obj_files.push(obj);
        }
        let lib_path = out_dir.join("libcanopen.a");
        let mut ar = Command::new(ar_cmd);
        ar.arg("rcs").arg(&lib_path);
        for obj in &obj_files { ar.arg(obj); }
        let ar_out = ar.output()
            .map_err(|e| format!("[CANopen][{}] ar error: {}", tag, e))?;
        for obj in &obj_files { let _ = fs::remove_file(obj); }
        if !ar_out.status.success() {
            return Err(format!("[CANopen][{}] archive error: {}",
                tag, String::from_utf8_lossy(&ar_out.stderr).trim()));
        }
        let _ = app.emit("library-update-progress",
            format!("[CANopen][{}] libcanopen.a OK", tag));
        Ok(())
    };

    // Include dirs
    let repo_ref        = repo_dir.as_path();
    let dir_301_ref     = dir_301.as_path();
    let dir_303_ref     = dir_303.as_path();
    let dir_305_ref     = dir_305.as_path();
    let socketcan_ref   = dir_socketcan.as_path();
    let bm_inc_ref      = bm_inc_dir.as_path();

    let linux_inc: &[&Path] = &[repo_ref, dir_301_ref, dir_303_ref, dir_305_ref, socketcan_ref];
    let bm_inc:    &[&Path] = &[bm_inc_ref, repo_ref, dir_301_ref, dir_303_ref, dir_305_ref];

    // x86_64/linux
    {
        let out_dir = resource_target_lib_dir(&resources_root, "x86_64/linux");
        match llvm_compile_base_args(&resource_dir, "x86_64-linux-gnu") {
            Ok((clang, llvm_ar, mut cc_flags, sys_incs)) => {
                cc_flags.extend(["-O3", "-ffunction-sections", "-fdata-sections",
                    "-DLINUX", "-pthread"].iter().map(|s| s.to_string()));
                if let Err(e) = compile_canopen_ar(
                    "x86_64/linux", &clang, &cc_flags, &sys_incs, &llvm_ar, &out_dir, &linux_sources, linux_inc)
                {
                    let _ = app.emit("library-update-progress", format!("WARN: {}", e));
                }
            }
            Err(e) => {
                let _ = app.emit("library-update-progress", format!("WARN: {}", e));
            }
        }
    }

    // x86_64/win32 — CANopen over SocketCAN not available on Windows; skip
    {
        let _ = app.emit("library-update-progress",
            "[CANopen][x86_64/win32] SKIP: SocketCAN not available on Windows".to_string());
    }

    // arm/aarch64
    {
        let out_dir = resource_target_lib_dir(&resources_root, "arm/aarch64");
        match llvm_compile_base_args(&resource_dir, "aarch64-linux-gnu") {
            Ok((clang, llvm_ar, mut cc_flags, sys_incs)) => {
                cc_flags.extend(["-O3", "-ffunction-sections", "-fdata-sections",
                    "-DLINUX", "-pthread"].iter().map(|s| s.to_string()));
                if let Err(e) = compile_canopen_ar(
                    "arm/aarch64", &clang, &cc_flags, &sys_incs,
                    &llvm_ar, &out_dir, &linux_sources, linux_inc)
                {
                    let _ = app.emit("library-update-progress", format!("WARN: {}", e));
                }
            }
            Err(e) => {
                let _ = app.emit("library-update-progress",
                    format!("[CANopen][arm/aarch64] SKIP: {}", e));
            }
        }
    }

    // arm/armv7
    {
        let out_dir = resource_target_lib_dir(&resources_root, "arm/armv7");
        match llvm_compile_base_args(&resource_dir, "arm-linux-gnueabihf") {
            Ok((clang, llvm_ar, mut cc_flags, sys_incs)) => {
                cc_flags.extend(["-O3", "-ffunction-sections", "-fdata-sections",
                    "-DLINUX", "-pthread"].iter().map(|s| s.to_string()));
                if let Err(e) = compile_canopen_ar(
                    "arm/armv7", &clang, &cc_flags, &sys_incs, &llvm_ar, &out_dir, &linux_sources, linux_inc)
                {
                    let _ = app.emit("library-update-progress", format!("WARN: {}", e));
                }
            }
            Err(e) => {
                let _ = app.emit("library-update-progress",
                    format!("[CANopen][arm/armv7] SKIP: {}", e));
            }
        }
    }

    // arm/CortexM bare-metal (core only, no SocketCAN)
    {
        match llvm_compile_base_args(&resource_dir, "arm-none-eabi") {
            Ok((clang, llvm_ar, base_flags, sys_incs)) => {
                let targets: &[(&str, &[&str])] = &[
                    ("arm/CortexM/M0", &["-mcpu=cortex-m0", "-mthumb",
                        "-O3", "-ffunction-sections", "-fdata-sections", "-DBARE_METAL=1"]),
                    ("arm/CortexM/M4", &["-mcpu=cortex-m4", "-mthumb",
                        "-mfpu=fpv4-sp-d16", "-mfloat-abi=hard",
                        "-O3", "-ffunction-sections", "-fdata-sections", "-DBARE_METAL=1"]),
                    ("arm/CortexM/M7", &["-mcpu=cortex-m7", "-mthumb",
                        "-mfpu=fpv5-d16", "-mfloat-abi=hard",
                        "-O3", "-ffunction-sections", "-fdata-sections", "-DBARE_METAL=1"]),
                ];
                for (m_tag, cc_flags) in targets {
                    let out_dir = resource_target_lib_dir(&resources_root, m_tag);
                    let mut flags = base_flags.clone();
                    flags.extend(cc_flags.iter().map(|s| s.to_string()));
                    if let Err(e) = compile_canopen_ar(
                        m_tag, &clang, &flags, &sys_incs, &llvm_ar,
                        &out_dir, &bm_sources, bm_inc)
                    {
                        let _ = app.emit("library-update-progress", format!("WARN: {}", e));
                    }
                }
            }
            Err(e) => {
                for m_tag in &["arm/CortexM/M0", "arm/CortexM/M4", "arm/CortexM/M7"] {
                    let _ = app.emit("library-update-progress",
                        format!("[CANopen][{}] SKIP: {}", m_tag, e));
                }
            }
        }
    }

    let _ = fs::remove_dir_all(&temp_dir);
    let _ = app.emit("library-update-progress", "[CANopen] Build complete".to_string());
    Ok(())
}

#[tauri::command]
fn build_canopen(app: tauri::AppHandle) -> Result<String, String> {
    std::thread::spawn(move || {
        match do_build_canopen(&app) {
            Ok(()) => {
                let _ = app.emit("library-update-done",
                    json!({"success": true, "message": "CANopen built successfully"}));
            }
            Err(e) => {
                let _ = app.emit("library-update-done",
                    json!({"success": false, "message": e}));
            }
        }
    });
    Ok("started".to_string())
}

// ---------------------------------------------------------------------------
// list_network_interfaces — return available network interface names
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_network_interfaces() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        // On Windows: parse `netsh interface show interface` output
        let out = Command::new("netsh")
            .args(["interface", "show", "interface"])
            .output();
        match out {
            Ok(o) => {
                let text = String::from_utf8_lossy(&o.stdout);
                text.lines()
                    .filter_map(|line| {
                        let parts: Vec<&str> = line.split_whitespace().collect();
                        // lines look like: "Enabled  Connected  Dedicated  Ethernet"
                        if parts.len() >= 4 { Some(parts[3..].join(" ")) } else { None }
                    })
                    .filter(|s| !s.is_empty() && s != "Interface Name")
                    .collect()
            }
            Err(_) => vec![],
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // On Linux/macOS: read /sys/class/net directory entries
        let net_dir = std::path::Path::new("/sys/class/net");
        if let Ok(entries) = std::fs::read_dir(net_dir) {
            let mut ifaces: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|name| name != "lo")
                .collect();
            ifaces.sort();
            ifaces
        } else {
            // Fallback: parse `ip link show`
            let out = Command::new("ip").args(["link", "show"]).output();
            match out {
                Ok(o) => {
                    let text = String::from_utf8_lossy(&o.stdout);
                    text.lines()
                        .filter(|l| l.starts_with(|c: char| c.is_ascii_digit()))
                        .filter_map(|l| {
                            let name = l.split(':').nth(1)?.trim().split('@').next()?;
                            let name = name.trim().to_string();
                            if name == "lo" { None } else { Some(name) }
                        })
                        .collect()
                }
                Err(_) => vec![],
            }
        }
    }
}

// ---------------------------------------------------------------------------
// HMI web server
// ---------------------------------------------------------------------------

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

struct HmiState {
    layout:        Mutex<String>,
    variables:     Mutex<String>,
    pending_writes: Mutex<Vec<(String, serde_json::Value)>>,
    running:       AtomicBool,
}

impl HmiState {
    fn new() -> Self {
        HmiState {
            layout:        Mutex::new("{}".to_string()),
            variables:     Mutex::new("{}".to_string()),
            pending_writes: Mutex::new(Vec::new()),
            running:       AtomicBool::new(false),
        }
    }
}

static HMI_STATE: std::sync::OnceLock<Arc<HmiState>> = std::sync::OnceLock::new();

fn get_hmi_state() -> Arc<HmiState> {
    HMI_STATE.get_or_init(|| Arc::new(HmiState::new())).clone()
}

const HMI_HTML: &str = r####"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KronEditor HMI</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:#d4d4d4;font-family:Consolas,monospace;overflow:auto}
#hmi-root{position:relative}
.hmi-comp{position:absolute;overflow:hidden}
.led-wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px}
.led-circle{border-radius:50%;border:2px solid #555;transition:background .1s,box-shadow .1s}
.num-display{width:100%;height:100%;display:flex;align-items:center;justify-content:center;gap:4px;font-family:'Courier New',monospace}
.btn{width:100%;height:100%;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;transition:background .08s}
.progress-bar{position:relative;width:100%;overflow:hidden}
.progress-fill{height:100%;transition:width .15s}
.progress-val{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:10px;font-weight:600;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.8)}
.switch-track{position:relative;cursor:pointer;border-radius:999px;transition:background .15s}
.switch-thumb{position:absolute;border-radius:50%;background:#e0e0e0;box-shadow:0 1px 4px rgba(0,0,0,.5);transition:left .15s}
.label-comp{width:100%;height:100%;display:flex;align-items:center;overflow:hidden;padding:0 4px}
</style>
</head>
<body>
<div id="hmi-root"></div>
<script>
let layout={pages:[]};
let variables={};
let currentPage=0;
let btnState={};

async function loadLayout(){
  try{const r=await fetch('/api/layout');layout=await r.json();}catch(e){}
  render();
}
async function pollVars(){
  try{const r=await fetch('/api/variables');variables=await r.json();updateLive();}catch(e){}
}
async function sendWrite(key,value){
  try{await fetch('/api/write',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,value})});}catch(e){}
}

function resolveVar(expr){
  if(!expr)return null;
  const t=expr.trim();
  const d=t.indexOf('.');
  if(d>0){const prog=t.slice(0,d).replace(/\s+/g,'_');const v=t.slice(d+1).replace(/\s+/g,'_');return`prog_${prog}_${v}`;}
  return t.replace(/\s+/g,'_');
}

function getVal(expr){const k=resolveVar(expr);return k?variables[k]:undefined;}
function fmtVal(v,dec){if(v===null||v===undefined)return'---';if(typeof v==='boolean')return v?'TRUE':'FALSE';const n=Number(v);return isNaN(n)?String(v):n.toFixed(Number(dec)||0);}

function render(){
  const root=document.getElementById('hmi-root');
  const pg=layout.pages?layout.pages[currentPage]:null;
  if(!pg){root.innerHTML='<div style="color:#333;padding:20px">No pages.</div>';return;}
  root.style.width=(pg.canvasW||1280)+'px';
  root.style.height=(pg.canvasH||800)+'px';
  root.innerHTML='';
  (pg.components||[]).forEach(comp=>renderComp(root,comp));
  updateLive();
}

function renderComp(root,comp){
  const el=document.createElement('div');
  el.className='hmi-comp';
  el.id='comp_'+comp.id;
  el.style.cssText=`left:${comp.x}px;top:${comp.y}px;width:${comp.w}px;height:${comp.h}px`;
  const p=comp.props||{};
  switch(comp.type){
    case'LED':{
      const s=Math.min(comp.w,comp.h)*0.68;
      el.innerHTML=`<div class="led-wrap"><div class="led-circle" id="led_${comp.id}" style="width:${s}px;height:${s}px"></div>${p.label&&p.label.trim()?`<span style="font-size:${p.fontSize||11}px;color:#aaa">${p.label}</span>`:''}</div>`;
      break;}
    case'ALARM':{
      el.innerHTML=`<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px">
        <svg id="alarm_${comp.id}" width="${Math.min(comp.w,comp.h)*0.7}" height="${Math.min(comp.w,comp.h)*0.7}" viewBox="0 0 24 24">
          <path d="M12 2L1 21h22L12 2z" fill="${p.inactiveColor||'#2a2a2a'}" stroke="#444" stroke-width="1"/>
          <text x="12" y="17" text-anchor="middle" fill="#fff" font-size="7" font-weight="bold">!</text>
        </svg>
        ${p.label?`<span style="font-size:${p.fontSize||12}px;font-weight:600;letter-spacing:.05em" id="alarmlbl_${comp.id}">${p.label}</span>`:''}
      </div>`;break;}
    case'NUMERIC_DISPLAY':{
      el.innerHTML=`<div class="num-display" style="background:${p.background||'#0a0f14'};border:1px solid ${p.borderColor||'#1e2a38'}">
        <span id="num_${comp.id}" style="font-size:${Math.min(p.fontSize||24,comp.h*.7)}px;color:${p.color||'#4ec9b0'};font-weight:700">---</span>
        ${p.unit?`<span style="font-size:${Math.max((p.fontSize||24)*.45,10)}px;color:#666">${p.unit}</span>`:''}
      </div>`;break;}
    case'PROGRESS':{
      el.innerHTML=`<div style="width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;gap:2px">
        ${p.label?`<span style="font-size:10px;color:#777;padding-left:2px">${p.label}</span>`:''}
        <div class="progress-bar" style="flex:1;background:${p.background||'#1a1a1a'};border:1px solid ${p.borderColor||'#2a2a2a'}">
          <div id="prog_${comp.id}" class="progress-fill" style="background:${p.color||'#007acc'};width:0%"></div>
          ${p.showValue?`<div id="progval_${comp.id}" class="progress-val">0</div>`:''}
        </div>
      </div>`;break;}
    case'BUTTON':{
      const off=p.offColor||'#252525',on=p.onColor||'#007acc';
      el.innerHTML=`<div class="btn" id="btn_${comp.id}" style="background:${off};border:1px solid ${p.borderColor||'#3a3a3a'};border-radius:${p.borderRadius||3}px;box-shadow:0 2px 4px rgba(0,0,0,.3)">
        <span style="font-size:${p.fontSize||13}px;color:${p.textColor||'#fff'};font-weight:500;pointer-events:none">${p.label||'Button'}</span>
      </div>`;
      const btn=el.querySelector(`#btn_${comp.id}`);
      const lk=resolveVar(p.variable);
      if(lk){
        if(p.mode==='toggle'){
          btn.addEventListener('click',()=>{const cur=variables[lk];sendWrite(lk,!(cur===true||cur===1||cur==='TRUE'));});
        }else{
          btn.addEventListener('mousedown',()=>{btn.style.background=on;btn.style.boxShadow='inset 0 2px 6px rgba(0,0,0,.4)';sendWrite(lk,true);});
          btn.addEventListener('mouseup',()=>{btn.style.background=off;btn.style.boxShadow='0 2px 4px rgba(0,0,0,.3)';sendWrite(lk,false);});
          btn.addEventListener('mouseleave',()=>{btn.style.background=off;btn.style.boxShadow='0 2px 4px rgba(0,0,0,.3)';sendWrite(lk,false);});
        }
      }
      break;}
    case'TOGGLE_BUTTON':{
      el.innerHTML=`<div class="btn" id="tbtn_${comp.id}" style="background:${p.offColor||'#252525'};border:1px solid ${p.borderColor||'#3a3a3a'};border-radius:${p.borderRadius||3}px">
        <span id="tbtnlbl_${comp.id}" style="font-size:${p.fontSize||13}px;color:${p.textColor||'#fff'};font-weight:600;letter-spacing:.06em;pointer-events:none">${p.labelOff||'OFF'}</span>
      </div>`;
      const lk=resolveVar(p.variable);
      if(lk)el.querySelector(`#tbtn_${comp.id}`).addEventListener('click',()=>sendWrite(lk,!(variables[lk]===true||variables[lk]===1)));
      break;}
    case'SWITCH':{
      const tw=Math.min(comp.w*.56,54),th=Math.min(comp.h*.52,28),thumb=th-4;
      el.innerHTML=`<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;gap:8px">
        <div id="sw_${comp.id}" class="switch-track" style="width:${tw}px;height:${th}px;background:${p.offColor||'#333'};box-shadow:inset 0 2px 4px rgba(0,0,0,.4)">
          <div id="swthumb_${comp.id}" class="switch-thumb" style="top:2px;left:2px;width:${thumb}px;height:${thumb}px"></div>
        </div>
        ${p.label?`<span style="font-size:${p.fontSize||12}px;color:#aaa;white-space:nowrap">${p.label}</span>`:''}
      </div>`;
      const lk=resolveVar(p.variable),tw2=tw;
      if(lk)el.querySelector(`#sw_${comp.id}`).addEventListener('click',()=>sendWrite(lk,!(variables[lk]===true||variables[lk]===1)));
      el.querySelector(`#sw_${comp.id}`).__tw=tw2;el.querySelector(`#sw_${comp.id}`).__thumb=thumb;
      break;}
    case'SLIDER':{
      const lk=resolveVar(p.variable);
      el.innerHTML=`<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:0 8px">
        <input id="slider_${comp.id}" type="range" min="${p.min||0}" max="${p.max||100}" step="${p.step||1}" value="${p.min||0}" style="width:100%;accent-color:${p.thumbColor||'#007acc'}">
        ${p.showValue?`<span id="sliderval_${comp.id}" style="font-size:10px;color:#888;font-family:monospace">${p.min||0}</span>`:''}
      </div>`;
      const sl=el.querySelector(`#slider_${comp.id}`);
      if(lk)sl.addEventListener('input',e=>{
        if(p.showValue){const sv=el.querySelector(`#sliderval_${comp.id}`);if(sv)sv.textContent=e.target.value;}
        sendWrite(lk,Number(e.target.value));
      });
      break;}
    case'LABEL':{
      el.innerHTML=`<div class="label-comp" style="background:${p.background||'transparent'};justify-content:${p.align==='center'?'center':p.align==='right'?'flex-end':'flex-start'}">
        <span id="lbl_${comp.id}" style="font-size:${p.fontSize||13}px;font-weight:${p.fontWeight||'normal'};color:${p.color||'#d4d4d4'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.text||''}</span>
      </div>`;break;}
    case'RECTANGLE':{
      el.innerHTML=`<div style="width:100%;height:100%;background:${p.background||'transparent'};border:${p.borderWidth||1}px solid ${p.borderColor||'#444'};border-radius:${p.borderRadius||0}px;display:flex;align-items:flex-end">
        ${p.label?`<span style="font-size:${p.fontSize||11}px;color:${p.labelColor||'#888'};padding:2px 6px">${p.label}</span>`:''}
      </div>`;break;}
    case'CIRCLE':{
      const sz=Math.min(comp.w,comp.h);
      el.innerHTML=`<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center"><div style="width:${sz}px;height:${sz}px;border-radius:50%;background:${p.background||'transparent'};border:${p.borderWidth||1}px solid ${p.borderColor||'#444'}"></div></div>`;break;}
    case'LINE':{
      const horiz=(p.orientation||'horizontal')==='horizontal';
      el.innerHTML=`<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center"><div style="width:${horiz?'100%':p.thickness+'px'};height:${horiz?p.thickness+'px':'100%'};background:${p.color||'#444'}"></div></div>`;break;}
    default:
      el.innerHTML=`<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;border:1px dashed #333;color:#444;font-size:11px">${comp.type}</div>`;
  }
  root.appendChild(el);
}

function updateLive(){
  const pg=layout.pages?layout.pages[currentPage]:null;
  if(!pg)return;
  (pg.components||[]).forEach(comp=>{
    const p=comp.props||{};
    const val=getVal(p.variable);
    const on=val===true||val===1||val==='TRUE'||val==='1';
    switch(comp.type){
      case'LED':{
        const c=document.getElementById('led_'+comp.id);
        if(c){c.style.background=on?(p.onColor||'#00e676'):(p.offColor||'#1a1a1a');c.style.boxShadow=on?`0 0 12px ${p.onColor||'#00e676'},0 0 20px ${p.onColor||'#00e676'}55`:'inset 0 2px 6px rgba(0,0,0,.5)';}
        break;}
      case'ALARM':{
        const a=document.getElementById('alarm_'+comp.id);
        if(a){const path=a.querySelector('path');if(path)path.setAttribute('fill',on?(p.activeColor||'#f14c4c'):(p.inactiveColor||'#2a2a2a'));}
        const lbl=document.getElementById('alarmlbl_'+comp.id);
        if(lbl)lbl.style.color=on?(p.activeColor||'#f14c4c'):'#555';
        break;}
      case'NUMERIC_DISPLAY':{
        const n=document.getElementById('num_'+comp.id);
        if(n)n.textContent=fmtVal(val,p.decimals);
        break;}
      case'PROGRESS':{
        const min=Number(p.min)||0,max=Number(p.max)||100,v=Math.min(max,Math.max(min,Number(val)||min));
        const pct=max>min?((v-min)/(max-min))*100:0;
        const bar=document.getElementById('prog_'+comp.id);if(bar)bar.style.width=pct+'%';
        const pv=document.getElementById('progval_'+comp.id);if(pv)pv.textContent=v.toFixed(0);
        break;}
      case'TOGGLE_BUTTON':{
        const tb=document.getElementById('tbtn_'+comp.id);
        const tl=document.getElementById('tbtnlbl_'+comp.id);
        if(tb)tb.style.background=on?(p.onColor||'#007a4d'):(p.offColor||'#252525');
        if(tl)tl.textContent=on?(p.labelOn||'ON'):(p.labelOff||'OFF');
        break;}
      case'BUTTON':{
        if(p.mode==='toggle'){
          const btn=document.getElementById('btn_'+comp.id);
          if(btn)btn.style.background=on?(p.onColor||'#007acc'):(p.offColor||'#252525');
        }break;}
      case'SWITCH':{
        const sw=document.getElementById('sw_'+comp.id);
        const swt=document.getElementById('swthumb_'+comp.id);
        if(sw&&swt){
          sw.style.background=on?(p.onColor||'#007acc'):(p.offColor||'#333');
          const tw=sw.__tw||54,thumb=sw.__thumb||24;
          swt.style.left=on?(tw-thumb-2)+'px':'2px';
        }break;}
      case'SLIDER':{
        const sl=document.getElementById('slider_'+comp.id);
        if(sl&&val!==undefined)sl.value=Number(val);
        const sv=document.getElementById('sliderval_'+comp.id);
        if(sv&&val!==undefined)sv.textContent=Number(val).toFixed(0);
        break;}
      case'LABEL':{
        const lbl=document.getElementById('lbl_'+comp.id);
        if(lbl){if(p.variable&&val!==undefined){const n=Number(val);lbl.textContent=isNaN(n)?String(val):n.toFixed(p.decimals||0)+(p.unit?` ${p.unit}`:'')}else lbl.textContent=p.text||'';}
        break;}
    }
  });
}

loadLayout();
setInterval(pollVars,400);
</script>
</body>
</html>
"####;

#[tauri::command]
fn start_hmi_server(port: u16, layout_json: String) -> Result<String, String> {
    let state = get_hmi_state();
    *state.layout.lock().unwrap() = layout_json;
    state.running.store(true, Ordering::Relaxed);

    let state_clone = state.clone();
    std::thread::spawn(move || {
        let addr = format!("0.0.0.0:{}", port);
        let server = match tiny_http::Server::http(&addr) {
            Ok(s) => s,
            Err(e) => { eprintln!("HMI server error: {}", e); return; }
        };

        while state_clone.running.load(Ordering::Relaxed) {
            let request = match server.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(Some(r)) => r,
                Ok(None) => continue,
                Err(_) => break,
            };

            let url = request.url().to_string();
            let method = request.method().to_string();

            let respond = |req: tiny_http::Request, status: u16, ct: &str, body: String| {
                let response = tiny_http::Response::from_string(body)
                    .with_status_code(status)
                    .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap())
                    .with_header(tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                let _ = req.respond(response);
            };

            if url == "/" || url.is_empty() {
                respond(request, 200, "text/html; charset=utf-8", HMI_HTML.to_string());
            } else if url == "/api/layout" {
                let body = state_clone.layout.lock().unwrap().clone();
                respond(request, 200, "application/json", body);
            } else if url == "/api/variables" {
                let body = state_clone.variables.lock().unwrap().clone();
                respond(request, 200, "application/json", body);
            } else if url == "/api/write" && method == "POST" {
                let mut req = request;
                let mut buf = String::new();
                req.as_reader().read_to_string(&mut buf).unwrap_or(0);
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&buf) {
                    if let (Some(key), Some(value)) = (val.get("key"), val.get("value")) {
                        let key_str = key.as_str().unwrap_or("").to_string();
                        let mut pw = state_clone.pending_writes.lock().unwrap();
                        pw.push((key_str, value.clone()));
                    }
                }
                respond(req, 200, "application/json", r#"{"ok":true}"#.to_string());
            } else {
                respond(request, 404, "text/plain", "Not found".to_string());
            }
        }
    });

    Ok(format!("HMI server started on port {}", port))
}

#[tauri::command]
fn stop_hmi_server() -> Result<(), String> {
    let state = get_hmi_state();
    state.running.store(false, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn push_hmi_variables(vars_json: String) -> Result<(), String> {
    let state = get_hmi_state();
    *state.variables.lock().unwrap() = vars_json;
    Ok(())
}

#[tauri::command]
fn poll_hmi_writes() -> Result<Vec<(String, serde_json::Value)>, String> {
    let state = get_hmi_state();
    let mut pw = state.pending_writes.lock().unwrap();
    let writes = pw.drain(..).collect();
    Ok(writes)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .manage(SimState {
            var_specs: Mutex::new(Vec::new()),
            #[cfg(not(target_os = "windows"))]
            process:   Mutex::new(None),
            #[cfg(not(target_os = "windows"))]
            pid:       Mutex::new(None),
            #[cfg(target_os = "windows")]
            win:       Mutex::new(None),
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            simulate_st,
            write_plc_files,
            get_standard_headers,
            compile_simulation,
            run_simulation,
            stop_simulation,
            write_variable,
            update_libraries,
            update_server,
            compile_for_target,
            deploy_to_server,
            check_server_status,
            deploy_server_to_target,
            build_soem,
            ec_request_state,
            build_canopen,
            list_network_interfaces,
            start_hmi_server,
            stop_hmi_server,
            push_hmi_variables,
            poll_hmi_writes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
