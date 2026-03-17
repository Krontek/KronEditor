fn main() {
    // Create resources/ symlink inside src-tauri/ pointing to ../resources (project root).
    // This lets tauri.conf.json use simple "resources/..." glob patterns while the
    // actual files live at the project root (gitignored there, outside src-tauri/).
    let symlink_path = std::path::Path::new("resources");
    let target_path  = std::path::Path::new("../resources");
    if !symlink_path.exists() {
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(target_path, symlink_path);
        #[cfg(windows)]
        let _ = std::os::windows::fs::symlink_dir(target_path, symlink_path);
    }

    // Ensure resource directories exist with a placeholder file so Tauri's
    // glob patterns don't fail when no libraries have been built yet.
    let res = std::path::Path::new("../resources");
    for dir in &[
        "x86_64/linux", "x86_64/win32", "x86_64/MacOS",
        "arm/aarch64", "arm/armv7", "arm/CortexM/M0", "arm/CortexM/M4", "arm/CortexM/M7",
    ] {
        let d = res.join(dir);
        let _ = std::fs::create_dir_all(&d);
        let placeholder = d.join("EMPTY");
        if !placeholder.exists() {
            let has_files = std::fs::read_dir(&d)
                .map(|entries| entries.flatten().any(|e| {
                    let name = e.file_name();
                    let n = name.to_string_lossy();
                    n != "EMPTY" && !n.starts_with('.')
                }))
                .unwrap_or(false);
            if !has_files {
                let _ = std::fs::write(&placeholder, "");
            }
        }
    }

    // Ensure toolchain bin/ placeholder dirs exist so Tauri globs don't fail
    // when toolchains haven't been downloaded yet.
    let tc_base = std::path::Path::new("toolchains");
    for host in &["linux", "windows"] {
        for tc in &["aarch64-none-linux-gnu/bin", "arm-linux-gnueabihf/bin", "arm-none-eabi/bin", "mingw/bin"] {
            let d = tc_base.join(host).join(tc);
            let _ = std::fs::create_dir_all(&d);
            let placeholder = d.join("EMPTY");
            if !placeholder.exists() {
                let has_files = std::fs::read_dir(&d)
                    .map(|e| e.flatten().any(|f| {
                        let n = f.file_name(); let s = n.to_string_lossy();
                        s != "EMPTY" && !s.starts_with('.')
                    }))
                    .unwrap_or(false);
                if !has_files {
                    let _ = std::fs::write(&placeholder, "");
                }
            }
        }
    }

    tauri_build::build();
    lalrpop::process_root().unwrap();
}
