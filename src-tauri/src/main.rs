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

/// Root toolchain directory for the current host OS.
fn toolchains_dir(resource_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        resource_dir.join("toolchains/windows")
    } else {
        resource_dir.join("toolchains/linux")
    }
}

/// Full path to a compiler binary inside a named toolchain.
/// `toolchain` e.g. "aarch64-none-linux-gnu", binary e.g. "aarch64-none-linux-gnu-gcc"
fn tc_bin(resource_dir: &Path, toolchain: &str, binary: &str) -> PathBuf {
    let exe = if cfg!(target_os = "windows") {
        format!("{}.exe", binary)
    } else {
        binary.to_string()
    };
    toolchains_dir(resource_dir).join(toolchain).join("bin").join(exe)
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
) -> Result<String, String> {
    let build_dir = get_build_dir(&app)?;
    fs::write(build_dir.join("plc.h"), &header).map_err(|e| e.to_string())?;
    fs::write(build_dir.join("plc.c"), &source).map_err(|e| e.to_string())?;
    fs::write(build_dir.join("variable_table.json"), &variable_table).map_err(|e| e.to_string())?;
    Ok(build_dir.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// get_standard_headers
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_standard_headers(app: tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    let mut headers = Vec::new();

    // Read headers from bundled resources/include/ (the definitive location)
    if let Ok(resource_dir) = get_resource_dir(&app) {
        let include_dir = resource_dir.join("resources/include");
        if let Ok(entries) = fs::read_dir(&include_dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.ends_with(".h") {
                        if let Ok(content) = fs::read_to_string(entry.path()) {
                            headers.push((name.to_string(), content));
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
fn create_ar_archive(output: &Path, obj_files: &[PathBuf]) -> Result<(), String> {
    use std::io::Write;
    let mut f = fs::File::create(output)
        .map_err(|e| format!("Cannot create {}: {}", output.display(), e))?;

    // Global AR header
    f.write_all(b"!<arch>\n").map_err(|e| e.to_string())?;

    for obj in obj_files {
        let data = fs::read(obj)
            .map_err(|e| format!("Cannot read {}: {}", obj.display(), e))?;
        let name = obj.file_name().unwrap_or_default().to_string_lossy();

        // AR member header: exactly 60 bytes
        // name/           16 bytes (name + "/" padded with spaces)
        // mtime           12 bytes
        // uid              6 bytes
        // gid              6 bytes
        // mode             8 bytes
        // size            10 bytes
        // fmag             2 bytes ("`\n")
        let name_with_slash = format!("{}/", &name[..name.len().min(15)]);
        let header = format!(
            "{:<16}{:<12}{:<6}{:<6}{:<8}{:<10}`\n",
            name_with_slash, "0", "0", "0", "100644", data.len()
        );
        debug_assert_eq!(header.len(), 60);

        f.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
        f.write_all(&data).map_err(|e| e.to_string())?;

        // AR requires 2-byte alignment padding
        if data.len() % 2 != 0 {
            f.write_all(b"\n").map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn do_update_libraries(app: &tauri::AppHandle, repos: Vec<String>) -> Result<(), String> {
    let resource_dir = get_resource_dir(app)?;
    let include_dir = resource_dir.join("resources/include");
    fs::create_dir_all(&include_dir).map_err(|e| e.to_string())?;

    // Target directories for compiled libraries
    struct BuildTarget {
        name: &'static str,
        dir: PathBuf,
        dev_dir: Option<PathBuf>,
    }

    let target_names = [
        "x86_64/linux", "x86_64/win32",
        "arm/aarch64", "arm/armv7",
        "arm/CortexM/M0", "arm/CortexM/M4", "arm/CortexM/M7",
    ];

    let mut targets: Vec<BuildTarget> = Vec::new();
    for tname in &target_names {
        let dir = resource_dir.join(format!("resources/{}", tname));
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        targets.push(BuildTarget { name: tname, dir, dev_dir: None });
    }

    // In dev mode, also copy to the project-root resources/ tree so files persist across builds.
    // Walk up from cwd until we find a directory that contains BOTH "src-tauri" and "resources".
    // This works regardless of whether cargo is invoked from the project root or from src-tauri/.
    let mut dev_include_dir = None;
    if let Ok(cwd) = std::env::current_dir() {
        let project_root = std::iter::successors(Some(cwd.as_ref() as &std::path::Path), |p| p.parent())
            .find(|p| p.join("src-tauri").exists() && p.join("resources").exists())
            .map(|p| p.to_path_buf());
        if let Some(root) = project_root {
            let res = root.join("resources");
            let i = res.join("include");
            let _ = fs::create_dir_all(&i);
            dev_include_dir = Some(i);
            for t in &mut targets {
                let d = res.join(t.name);
                let _ = fs::create_dir_all(&d);
                t.dev_dir = Some(d);
            }
        }
    }

    let temp_base = std::env::temp_dir().join("kroneditor_libs");
    let _ = fs::remove_dir_all(&temp_base);
    fs::create_dir_all(&temp_base).map_err(|e| e.to_string())?;

    let mut errors: Vec<String> = Vec::new();

    // --- Clone all repos, gather headers and sources ---
    let mut repo_sources: Vec<(String, PathBuf)> = Vec::new(); // (lib_name, c_file)
    let mut cloned_dirs:  Vec<PathBuf>            = Vec::new();

    for repo_name in &repos {
        let repo_url = format!("https://github.com/Krontek/{}.git", repo_name);
        let clone_dir = temp_base.join(repo_name);

        let _ = app.emit("library-update-progress", format!("[{}] Cloning...", repo_name));

        let clone_out = std::process::Command::new("git")
            .args(["clone", "--depth=1", "--quiet", &repo_url])
            .arg(&clone_dir)
            .output()
            .map_err(|e| format!("git not found: {}", e))?;

        if !clone_out.status.success() {
            let msg = format!(
                "[{}] Clone failed: {}",
                repo_name,
                String::from_utf8_lossy(&clone_out.stderr).trim()
            );
            let _ = app.emit("library-update-progress", format!("ERROR: {}", msg));
            errors.push(msg);
            continue;
        }

        // Copy .h files
        let h_files = find_files_with_ext(&clone_dir, "h");
        for h_file in &h_files {
            if let Some(fname) = h_file.file_name() {
                let _ = fs::copy(h_file, include_dir.join(fname));
                if let Some(ref dev_inc) = dev_include_dir {
                    let _ = fs::copy(h_file, dev_inc.join(fname));
                }
            }
        }
        let _ = app.emit(
            "library-update-progress",
            format!("[{}] Copied {} header(s)", repo_name, h_files.len()),
        );

        // Each repo has exactly one main source: <reponame>.c (lowercase).
        // Skip test.c, example.c and any other auxiliary files.
        let lib_name = repo_name.to_lowercase();
        let main_c = clone_dir.join(format!("{}.c", lib_name));
        if main_c.exists() {
            repo_sources.push((lib_name, main_c));
        } else {
            // Fallback: accept .c files NOT named test*.c or example*.c
            let candidates: Vec<PathBuf> = find_files_with_ext(&clone_dir, "c")
                .into_iter()
                .filter(|p| {
                    let n = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                    !n.starts_with("test") && !n.starts_with("example")
                })
                .collect();
            if candidates.is_empty() {
                let _ = app.emit("library-update-progress",
                    format!("[{}] WARN: no .c source found", repo_name));
            }
            for c in candidates {
                let stem = c.file_stem().unwrap_or_default().to_string_lossy().to_string();
                repo_sources.push((stem, c));
            }
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

    // Helper: compile one .c → lib<lib_name>.a  (used for Linux and ARM targets)
    let compile_one_ar = |
        target_tag: &str,
        compiler:   &str,
        cc_args:    &[&str],
        ar_cmd:     &str,
        lib_dir:    &Path,
        dev_dir:    &Option<PathBuf>,
        lib_name:   &str,
        c_file:     &Path,
    | -> Result<(), String> {
        let obj_path = temp_base.join(format!("{}_{}.o", target_tag.replace('/', "_"), lib_name));
        let mut cmd = std::process::Command::new(compiler);
        for arg in cc_args { cmd.arg(arg); }
        cmd.arg("-I").arg(&include_dir);
        for cdir in &cloned_dirs { cmd.arg("-I").arg(cdir); }
        cmd.arg("-c").arg(c_file).arg("-o").arg(&obj_path);

        let out = cmd.output().map_err(|e| format!("[{}] {} spawn error: {}", target_tag, lib_name, e))?;
        if !out.status.success() {
            let _ = fs::remove_file(&obj_path);
            return Err(format!("[{}] {} compile error: {}",
                target_tag, lib_name, String::from_utf8_lossy(&out.stderr).trim()));
        }

        let lib_path = lib_dir.join(format!("lib{}.a", lib_name));
        let ar_out = std::process::Command::new(ar_cmd)
            .arg("rcs").arg(&lib_path).arg(&obj_path)
            .output()
            .map_err(|e| format!("[{}] {} ar error: {}", target_tag, lib_name, e))?;
        let _ = fs::remove_file(&obj_path);
        if !ar_out.status.success() {
            return Err(format!("[{}] {} archive error: {}",
                target_tag, lib_name, String::from_utf8_lossy(&ar_out.stderr).trim()));
        }
        if let Some(ref d) = dev_dir {
            let _ = fs::copy(&lib_path, d.join(format!("lib{}.a", lib_name)));
        }
        Ok(())
    };

    // ---- x86_64/linux — GCC (per-repo .a archives) ----
    {
        let _ = app.emit("library-update-progress", "--- Building for x86_64/linux ---".to_string());
        let t = &targets[0];
        let cc_args: &[&str] = &["-O2", "-ffunction-sections", "-fdata-sections"];
        for (lib_name, c_file) in &repo_sources {
            match compile_one_ar(
                "x86_64/linux", "gcc", cc_args, "ar",
                &t.dir, &t.dev_dir, lib_name, c_file,
            ) {
                Ok(()) => { let _ = app.emit("library-update-progress", format!(
                    "  [x86_64/linux] lib{}.a OK", lib_name)); }
                Err(e) => { let _ = app.emit("library-update-progress",
                    format!("  [x86_64/linux] {}", e)); }
            }
        }
    }

    // ---- x86_64/win32 — per-lib MinGW .a archives ----
    {
        let _ = app.emit("library-update-progress", "--- Building for x86_64/win32 ---".to_string());
        // Try bundled MinGW first (windows/mingw on Windows host, system cross-compiler on Linux)
        let bundled_gcc = tc_bin(&resource_dir, "mingw", "gcc");
        let bundled_ar  = tc_bin(&resource_dir, "mingw", "ar");
        let (cc, ar_cmd): (String, String) = if bundled_gcc.exists() {
            (bundled_gcc.to_string_lossy().to_string(), bundled_ar.to_string_lossy().to_string())
        } else {
            ("x86_64-w64-mingw32-gcc".to_string(), "x86_64-w64-mingw32-ar".to_string())
        };
        let has_cc = std::process::Command::new(&cc)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status().map(|s| s.success()).unwrap_or(false);
        if !has_cc {
            let _ = app.emit("library-update-progress",
                "  [x86_64/win32] SKIP: MinGW gcc not found".to_string());
        } else {
            let t = &targets[1];
            let cc_args: &[&str] = &["-O2", "-ffunction-sections", "-fdata-sections"];
            for (lib_name, c_file) in &repo_sources {
                match compile_one_ar(
                    "x86_64/win32", &cc, cc_args, &ar_cmd,
                    &t.dir, &t.dev_dir, lib_name, c_file,
                ) {
                    Ok(()) => { let _ = app.emit("library-update-progress", format!(
                        "  [x86_64/win32] lib{}.a OK", lib_name)); }
                    Err(e) => { let _ = app.emit("library-update-progress",
                        format!("  [x86_64/win32] {}", e)); }
                }
            }
        }
    }

    // ---- arm/aarch64 — aarch64-none-linux-gnu-gcc ----
    {
        let _ = app.emit("library-update-progress", "--- Building for arm/aarch64 ---".to_string());
        let cc_path = tc_bin(&resource_dir, "aarch64-none-linux-gnu", "aarch64-none-linux-gnu-gcc");
        let ar_path = tc_bin(&resource_dir, "aarch64-none-linux-gnu", "aarch64-none-linux-gnu-ar");
        if !cc_path.exists() {
            let _ = app.emit("library-update-progress",
                "  [arm/aarch64] SKIP: aarch64-none-linux-gnu-gcc not found".to_string());
        } else {
            let t = &targets[2];
            let cc_str = cc_path.to_string_lossy().to_string();
            let ar_str = ar_path.to_string_lossy().to_string();
            let cc_args: &[&str] = &["-O2", "-ffunction-sections", "-fdata-sections"];
            for (lib_name, c_file) in &repo_sources {
                match compile_one_ar(
                    "arm/aarch64", &cc_str, cc_args, &ar_str,
                    &t.dir, &t.dev_dir, lib_name, c_file,
                ) {
                    Ok(()) => { let _ = app.emit("library-update-progress", format!(
                        "  [arm/aarch64] lib{}.a OK", lib_name)); }
                    Err(e) => { let _ = app.emit("library-update-progress",
                        format!("  [arm/aarch64] {}", e)); }
                }
            }
        }
    }

    // ---- arm/armv7 — arm-linux-gnueabihf-gcc (BB Black/Green/AI) ----
    {
        let _ = app.emit("library-update-progress", "--- Building for arm/armv7 ---".to_string());
        let cc_path = tc_bin(&resource_dir, "arm-linux-gnueabihf", "arm-linux-gnueabihf-gcc");
        let ar_path = tc_bin(&resource_dir, "arm-linux-gnueabihf", "arm-linux-gnueabihf-ar");
        if !cc_path.exists() {
            let _ = app.emit("library-update-progress",
                "  [arm/armv7] SKIP: arm-linux-gnueabihf-gcc not found".to_string());
        } else {
            let t = &targets[3];
            let cc_str = cc_path.to_string_lossy().to_string();
            let ar_str = ar_path.to_string_lossy().to_string();
            let cc_args: &[&str] = &["-march=armv7-a", "-mfpu=vfpv3-d16", "-mfloat-abi=hard",
                                     "-O2", "-ffunction-sections", "-fdata-sections"];
            for (lib_name, c_file) in &repo_sources {
                match compile_one_ar(
                    "arm/armv7", &cc_str, cc_args, &ar_str,
                    &t.dir, &t.dev_dir, lib_name, c_file,
                ) {
                    Ok(()) => { let _ = app.emit("library-update-progress", format!(
                        "  [arm/armv7] lib{}.a OK", lib_name)); }
                    Err(e) => { let _ = app.emit("library-update-progress",
                        format!("  [arm/armv7] {}", e)); }
                }
            }
        }
    }

    // ---- ARM CortexM targets — arm-none-eabi-gcc ----
    // targets indices: [0]=x86_64/linux [1]=x86_64/win32
    //                  [2]=arm/aarch64  [3]=arm/armv7
    //                  [4]=arm/CortexM/M0 [5]=arm/CortexM/M4 [6]=arm/CortexM/M7
    let arm_targets: &[(&str, usize, &[&str])] = &[
        ("arm/CortexM/M0", 4, &["-mcpu=cortex-m0", "-mthumb", "-mfloat-abi=soft", "-O2", "-ffunction-sections", "-fdata-sections"]),
        ("arm/CortexM/M4", 5, &["-mcpu=cortex-m4", "-mthumb", "-mfloat-abi=hard", "-mfpu=fpv4-sp-d16", "-O2", "-ffunction-sections", "-fdata-sections"]),
        ("arm/CortexM/M7", 6, &["-mcpu=cortex-m7", "-mthumb", "-mfloat-abi=hard", "-mfpu=fpv5-d16", "-O2", "-ffunction-sections", "-fdata-sections"]),
    ];

    let arm_gcc = tc_bin(&resource_dir, "arm-none-eabi", "arm-none-eabi-gcc");
    let arm_ar  = tc_bin(&resource_dir, "arm-none-eabi", "arm-none-eabi-ar");
    let has_arm = arm_gcc.exists();

    for (name, idx, cc_args) in arm_targets {
        let _ = app.emit("library-update-progress", format!("--- Building for {} ---", name));
        if !has_arm {
            let _ = app.emit("library-update-progress",
                format!("  [{}] SKIP: arm-none-eabi-gcc not found", name));
            continue;
        }
        let t = &targets[*idx];
        let cc_str = arm_gcc.to_string_lossy().to_string();
        let ar_str = arm_ar.to_string_lossy().to_string();
        for (lib_name, c_file) in &repo_sources {
            match compile_one_ar(
                name, &cc_str, cc_args, &ar_str,
                &t.dir, &t.dev_dir, lib_name, c_file,
            ) {
                Ok(()) => { let _ = app.emit("library-update-progress", format!(
                    "  [{}] lib{}.a OK", name, lib_name)); }
                Err(e) => { let _ = app.emit("library-update-progress",
                    format!("  [{}] {}", name, e)); }
            }
        }
    }

    // Cleanup
    for cdir in &cloned_dirs {
        let _ = fs::remove_dir_all(cdir);
    }
    let _ = fs::remove_dir_all(&temp_base);

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

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
    let resource_dir = get_resource_dir(app)?;
    let server_dir = resource_dir.join("resources/dist/server");
    fs::create_dir_all(&server_dir).map_err(|e| e.to_string())?;

    // Dev-mode mirror
    let mut dev_server_dir: Option<PathBuf> = None;
    if let Ok(cwd) = std::env::current_dir() {
        let project_root = std::iter::successors(Some(cwd.as_ref() as &std::path::Path), |p| p.parent())
            .find(|p| p.join("src-tauri").exists() && p.join("resources").exists())
            .map(|p| p.to_path_buf());
        if let Some(root) = project_root {
            let dev = root.join("resources/dist/server");
            let _ = fs::create_dir_all(&dev);
            dev_server_dir = Some(dev);
        }
    }

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
        ("linux", "arm",   "7",  "plc-agent_linux_armv7"),
        ("linux", "arm64", "",   "plc-agent_linux_arm64"),
        ("linux", "amd64", "",   "plc-agent_linux_amd64"),
    ];

    for (i, (goos, goarch, goarm, out_name)) in targets.iter().enumerate() {
        let _ = app.emit("server-update-progress",
            format!("[{}/{}] Building {}/{} -> {}...", i + 1, targets.len(), goos, goarch, out_name));

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

        // Copy to dev dir too
        if let Some(ref dev_dir) = dev_server_dir {
            let _ = fs::copy(&out_path, dev_dir.join(out_name));
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
fn compile_for_target(
    app: tauri::AppHandle,
    header: String,
    source: String,
    variable_table: String,
    board_id: String,
    di_count: Option<u8>,
    do_count: Option<u8>,
) -> Result<String, String> {
    let resource_dir = get_resource_dir(&app)?;
    let build_dir = plain_path(&get_build_dir(&app)?);

    // Write source files
    fs::write(build_dir.join("plc.h"), &header).map_err(|e| e.to_string())?;
    fs::write(build_dir.join("plc.c"), &source).map_err(|e| e.to_string())?;
    fs::write(build_dir.join("variable_table.json"), &variable_table).map_err(|e| e.to_string())?;

    let plc_c = build_dir.join("plc.c");
    let out_file = build_dir.join("runtime.bin");
    let res_include = resource_dir.join("resources/include");

    // Select cross-compiler and library directory based on board
    let (compiler, lib_dir) = if board_id.starts_with("rpi_pico") {
        return Err("Pico (Cortex-M) targets are not supported for remote deployment".into());
    } else if board_id.starts_with("bb_") && !board_id.starts_with("bb_ai64") {
        // BeagleBone Black / Green / AI → armv7 (Cortex-A8/A15)
        (
            tc_bin(&resource_dir, "arm-linux-gnueabihf", "arm-linux-gnueabihf-gcc"),
            resource_dir.join("resources/arm/armv7"),
        )
    } else {
        // RPi 3/4/5/Zero2W + BeagleBone AI-64 → aarch64
        (
            tc_bin(&resource_dir, "aarch64-none-linux-gnu", "aarch64-none-linux-gnu-gcc"),
            resource_dir.join("resources/arm/aarch64"),
        )
    };

    if !compiler.exists() {
        return Err(format!("Cross-compiler not found: {}", compiler.display()));
    }

    let mut cmd = Command::new(&compiler);
    cmd.arg("-O2")
        .arg("-static")
        .arg("-ffunction-sections")
        .arg("-fdata-sections")
        .arg("-Wl,--gc-sections");

    // Architecture-specific flags
    if board_id.starts_with("bb_") && !board_id.starts_with("bb_ai64") {
        cmd.arg("-march=armv7-a").arg("-mfpu=vfpv3-d16").arg("-mfloat-abi=hard");
    }

    // Board-specific preprocessor defines
    if board_id == "rpi_5" {
        // RPi 5 uses /dev/gpiochip4 (RP1 chip) instead of the default gpiochip0
        cmd.arg(r#"-DKRON_GPIO_CHIP="/dev/gpiochip4""#);
    }
    if board_id.starts_with("edatec_") {
        let di = di_count.unwrap_or(8);
        let do_ = do_count.unwrap_or(8);
        cmd.arg(format!("-DKRON_DI_COUNT={}", di));
        cmd.arg(format!("-DKRON_DO_COUNT={}", do_));
    }

    cmd.arg("-I").arg(&build_dir)
        .arg("-I").arg(&res_include)
        .arg("-o").arg(&out_file)
        .arg(&plc_c);

    // Link .a library files
    let mut a_files: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(&lib_dir) {
        for e in entries.flatten() {
            if e.path().extension().map_or(false, |x| x == "a") {
                a_files.push(e.path());
            }
        }
    }
    a_files.sort();
    for a in &a_files { cmd.arg(a); }
    cmd.arg("-lm");

    let output = cmd.output()
        .map_err(|e| format!("Failed to run cross-compiler: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Cross-compilation failed:\nstderr: {}\nstdout: {}",
            stderr.trim(), stdout.trim()
        ));
    }

    // Build server-format variable table from transpiler pre-computed SHM offsets
    build_server_variable_table(&variable_table, &build_dir)?;

    Ok(out_file.to_string_lossy().to_string())
}

/// Build a KronServer-compatible variable_table_server.json using the
/// SHM offsets pre-computed by the JS transpiler (stored in debugDefaults).
/// No ELF parsing required — offsets are already layout-stable.
fn build_server_variable_table(
    variable_table_json: &str,
    build_dir: &Path,
) -> Result<(), String> {
    let vt: Value = serde_json::from_str(variable_table_json)
        .map_err(|e| format!("Variable table JSON parse error: {}", e))?;

    let debug_defaults = vt.get("debugDefaults")
        .and_then(|v| v.as_object())
        .ok_or("No debugDefaults in variable table")?;

    let mut variables: Vec<Value> = Vec::new();

    for (key, info) in debug_defaults {
        // Only entries with a pre-computed SHM offset are included
        let offset = match info.get("offset").and_then(|v| v.as_u64()) {
            Some(o) => o as i64,
            None => continue,
        };
        let size = info.get("size").and_then(|v| v.as_u64()).unwrap_or(1) as i64;
        let iec_type = info.get("type").and_then(|v| v.as_str()).unwrap_or("BOOL");

        let server_type = match iec_type {
            "BOOL"            => "bool",
            "SINT" | "USINT" | "BYTE" => "uint8",
            "INT"             => "int16",
            "UINT" | "WORD"   => "uint16",
            "DINT"            => "int32",
            "UDINT" | "DWORD" => "uint32",
            "REAL"            => "float32",
            "LREAL"           => "float64",
            "TIME"            => "uint32",
            _                 => "int32",
        };

        let mut var_entry = json!({
            "name": key,
            "offset": offset,
            "type": server_type,
            "size": size
        });
        if let Some(flag_offset) = info.get("force_flag_offset").and_then(|v| v.as_u64()) {
            var_entry["force_flag_offset"] = json!(flag_offset);
        }
        variables.push(var_entry);
    }

    let server_vt = json!({ "variables": variables });
    let out_path = build_dir.join("variable_table_server.json");
    fs::write(&out_path, serde_json::to_string_pretty(&server_vt).unwrap())
        .map_err(|e| format!("Failed to write server variable table: {}", e))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// deploy_to_server -- POST runtime.bin + variable_table to KronServer
// ---------------------------------------------------------------------------

#[tauri::command]
fn deploy_to_server(app: tauri::AppHandle, server_addr: String) -> Result<String, String> {
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

    // POST variable_table_server.json
    let vt_path = build_dir.join("variable_table_server.json");
    let vt_bytes = fs::read(&vt_path)
        .map_err(|e| format!("Cannot read variable_table_server.json: {}", e))?;

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
fn deploy_server_to_target(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    username: String,
    password: String,
    board_id: String,
) -> Result<String, String> {
    let resource_dir = get_resource_dir(&app)?;
    let server_dir = resource_dir.join("resources/dist/server");

    // Select the right binary based on board
    let binary_name = if board_id.starts_with("rpi_pico") {
        return Err("Pico targets do not support remote server deployment".into());
    } else if board_id.starts_with("rpi_") || board_id.starts_with("edatec_") || board_id == "bb_ai64" {
        // aarch64: all RPi Linux boards + Edatec IPC + BeagleBone AI-64
        "plc-agent_linux_arm64"
    } else if board_id.starts_with("bb_") {
        // armv7: BeagleBone Black / Green / AI
        "plc-agent_linux_armv7"
    } else {
        "plc-agent_linux_amd64"
    };

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
        "[Unit]\nDescription=PLC Agent (KronServer)\nAfter=network.target\n\n[Service]\nExecStart={} -addr :7070 -deploy-dir {} -shm-name plc_runtime -shm-size 65536\nRestart=always\nRestartSec=3\nWorkingDirectory={}\n\n[Install]\nWantedBy=multi-user.target\n",
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
fn compile_simulation(app: tauri::AppHandle) -> Result<String, String> {
    let resource_dir = get_resource_dir(&app)?;
    let build_dir    = plain_path(&get_build_dir(&app)?);
    let gcc_path     = tc_bin(&resource_dir, "mingw", "gcc");
    let plc_c        = build_dir.join("plc.c");
    let plc_dll      = build_dir.join("plc.dll");
    let res_include  = resource_dir.join("resources/include");
    let sim_win      = resource_dir.join("resources/x86_64/win32");

    let gcc_bin_dir = gcc_path.parent().unwrap_or(&gcc_path);

    let mut cmd = Command::new(&gcc_path);
    // -B tells gcc where to find its helper tools (as.exe, ld.exe, etc.)
    cmd.arg(format!("-B{}", gcc_bin_dir.display()))
        .arg("-shared")
        .arg("-Wl,--export-all-symbols")
        .arg("-I").arg(&build_dir)
        .arg("-I").arg(&res_include)
        .arg("-o").arg(&plc_dll)
        .arg(&plc_c);

    let mut a_files: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&sim_win) {
        for e in entries.flatten() {
            if e.path().extension().map_or(false, |x| x == "a") {
                a_files.push(e.path());
            }
        }
    }
    a_files.sort();
    for a in &a_files { cmd.arg(a); }
    cmd.arg("-lm");

    let output = cmd.output()
        .map_err(|e| format!("Failed to run gcc ({}): {}", gcc_path.display(), e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let code   = output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into());
        return Err(format!(
            "MinGW compilation failed (exit {})\nstderr: {}\nstdout: {}",
            code, stderr.trim(), stdout.trim()
        ));
    }

    Ok(plc_dll.to_string_lossy().to_string())
}

/// Linux/macOS: compile plc.c → simulation binary using system gcc.
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn compile_simulation(app: tauri::AppHandle) -> Result<String, String> {
    let resource_dir = get_resource_dir(&app)?;
    let build_dir    = plain_path(&get_build_dir(&app)?);
    let plc_c        = build_dir.join("plc.c");
    let out_file     = build_dir.join(SIM_BIN);
    let res_include  = resource_dir.join("resources/include");
    let sim_lib      = resource_dir.join("resources/x86_64/linux");

    let mut cmd = Command::new("gcc");
    cmd.arg("-I").arg(&build_dir)
        .arg("-I").arg(&res_include)
        .arg("-rdynamic")
        .arg("-no-pie")
        .arg("-o").arg(&out_file)
        .arg(&plc_c);

    let mut a_files: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&sim_lib) {
        for e in entries.flatten() {
            if e.path().extension().map_or(false, |x| x == "a") {
                a_files.push(e.path());
            }
        }
    }
    a_files.sort();
    for a in &a_files { cmd.arg(a); }
    cmd.arg("-lm");

    let output = cmd.output()
        .map_err(|e| format!("Failed to run gcc: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let code   = output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into());
        return Err(format!(
            "GCC compilation failed (exit {})\nstderr: {}\nstdout: {}",
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
    let var_table_str = fs::read_to_string(build_dir.join("variable_table.json"))
        .map_err(|e| format!("Failed to read variable_table.json: {}", e))?;
    let var_table: Value = serde_json::from_str(&var_table_str)
        .map_err(|e| format!("Failed to parse variable_table.json: {}", e))?;

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
    let var_table_path = build_dir.join("variable_table.json");

    let var_table_str = fs::read_to_string(&var_table_path)
        .map_err(|e| format!("Failed to read variable_table.json: {}", e))?;
    let var_table: Value = serde_json::from_str(&var_table_str)
        .map_err(|e| format!("Failed to parse variable_table.json: {}", e))?;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
