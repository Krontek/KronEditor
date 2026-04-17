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
    let resource_targets: &[&str] = &[
        "x86_64-linux-gnu/include",
        "x86_64-linux-gnu/lib",
        "x86_64-linux-gnu/server",
        "x86_64-w64-mingw32/include",
        "x86_64-w64-mingw32/lib",
        "x86_64-w64-mingw32/server",
        "x86_64-apple-darwin/include",
        "x86_64-apple-darwin/lib",
        "x86_64-apple-darwin/server",
        "aarch64-linux-gnu/include",
        "aarch64-linux-gnu/lib",
        "aarch64-linux-gnu/server",
        "arm-linux-gnueabihf/include",
        "arm-linux-gnueabihf/lib",
        "arm-linux-gnueabihf/server",
        "arm-none-eabi-m0/include",
        "arm-none-eabi-m0/lib",
        "arm-none-eabi-m0/server",
        "arm-none-eabi-m4/include",
        "arm-none-eabi-m4/lib",
        "arm-none-eabi-m4/server",
        "arm-none-eabi-m7/include",
        "arm-none-eabi-m7/lib",
        "arm-none-eabi-m7/server",
    ];

    ensure_placeholder_dirs(std::path::Path::new("resources"), resource_targets);

    // Ensure the LLVM/sysroot toolchain layout exists so bundle resource
    // globs keep working before setup_toolchain.py has been executed.
    let llvm_toolchain_dirs: &[&str] = &[
        "bin",
        "lib/clang",
        "sysroots/arm-none-eabi",
        "sysroots/aarch64-linux-gnu",
        "sysroots/arm-linux-gnueabihf",
        "sysroots/x86_64-linux-gnu",
        "sysroots/x86_64-w64-mingw32",
        "sysroots/simulation_env/include",
        "sysroots/simulation_env/lib",
    ];
    ensure_placeholder_dirs(std::path::Path::new("toolchains"), llvm_toolchain_dirs);

    tauri_build::build();
    lalrpop::process_root().unwrap();
}
