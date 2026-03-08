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
        "arm/linux", "arm/CortexM/M0", "arm/CortexM/M4", "arm/CortexM/M7",
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

    // Ensure toolchains directory exists so Tauri's glob doesn't fail
    // when toolchains haven't been downloaded yet.
    // Toolchains are stored per-host: toolchains/linux/, toolchains/windows/
    // A symlink toolchains/active → <host>/ selects the right one at build/dev time.
    let tc_base = std::path::Path::new("toolchains");
    let _ = std::fs::create_dir_all(tc_base);

    // Determine host from cargo TARGET env: windows target → windows toolchains, else linux
    let target = std::env::var("TARGET").unwrap_or_default();
    let host_name = if target.contains("windows") { "windows" } else { "linux" };

    // Ensure both host dirs exist
    let _ = std::fs::create_dir_all(tc_base.join("linux"));
    let _ = std::fs::create_dir_all(tc_base.join("windows"));

    // Create/update the "active" symlink → <host_name>
    let active_link = tc_base.join("active");
    // Remove existing symlink or directory
    if active_link.is_symlink() || active_link.exists() {
        let _ = std::fs::remove_file(&active_link);
    }
    #[cfg(unix)]
    let _ = std::os::unix::fs::symlink(host_name, &active_link);
    #[cfg(windows)]
    let _ = std::os::windows::fs::symlink_dir(host_name, &active_link);

    // Ensure placeholder dirs inside active toolchains so Tauri globs don't fail
    for tc in &["mingw/bin", "arm-none-eabi/bin", "aarch64-none-linux-gnu/bin"] {
        let d = active_link.join(tc);
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

    tauri_build::build();
    lalrpop::process_root().unwrap();
}
