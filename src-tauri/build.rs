fn ensure_placeholder_dirs(base: &std::path::Path, dirs: &[&str]) {
    for dir in dirs {
        let d = base.join(dir);
        let _ = std::fs::create_dir_all(&d);
        let placeholder = d.join("EMPTY");
        if !placeholder.exists() {
            let has_files = std::fs::read_dir(&d)
                .map(|entries| entries.flatten().any(|e| {
                    let n = e.file_name(); let s = n.to_string_lossy();
                    s != "EMPTY" && !s.starts_with('.')
                }))
                .unwrap_or(false);
            if !has_files {
                let _ = std::fs::write(&placeholder, "");
            }
        }
    }
}

fn main() {
    let lib_dirs: &[&str] = &[
        "include",
        "x86_64/linux", "x86_64/win32",
        "arm/aarch64", "arm/armv7",
        "arm/CortexM/M0", "arm/CortexM/M4", "arm/CortexM/M7",
    ];

    // Ensure both debug and release resources directories exist with placeholders
    // so Tauri glob patterns in tauri.conf.json / tauri.linux.conf.json don't fail.
    ensure_placeholder_dirs(std::path::Path::new("target/debug/resources"),   lib_dirs);
    ensure_placeholder_dirs(std::path::Path::new("target/release/resources"),  lib_dirs);

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
