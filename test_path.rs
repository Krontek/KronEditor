use std::path::PathBuf;
fn main() {
    let cwd = std::env::current_dir().unwrap();
    println!("cwd: {}", cwd.display());
}
