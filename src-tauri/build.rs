use std::env;
use std::path::PathBuf;

fn main() {
    // REL `tauri.conf.json` ships `pi-ext/` as a bundle resource (Blackwell pi-subagents).
    // The tree is gitignored (`src-tauri/pi-ext/`) because of node_modules size — it must
    // exist on disk before `tauri_build` or you get: resource path `pi-ext` doesn't exist.
    // DEV uses `tauri.conf.dev.json` with empty resources and syncs via sync-dev-runtime.ps1.
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let piext_pkg = manifest_dir
        .join("pi-ext")
        .join("pi-subagents")
        .join("package.json");
    println!("cargo:rerun-if-changed=pi-ext/pi-subagents/package.json");
    let profile = env::var("PROFILE").unwrap_or_default();
    if profile == "release" && !piext_pkg.is_file() {
        panic!(
            "\n\n[blackwell-ops] REL requires src-tauri/pi-ext/pi-subagents (gitignored).\n\
             Missing: {}\n\
             Restore the tree (copy from a prior target/*/pi-ext, or re-vendor pi-subagents),\n\
             then rebuild. Without it Tauri fails with: resource path `pi-ext` doesn't exist.\n",
            piext_pkg.display()
        );
    }

    tauri_build::build();

    // No hardcoded paths — all DLL discovery happens at runtime via config.providers.
    // build.rs only reads the commit hash from cmake config if LLAMA_CPP_BUILD_DIR is set.
    let build_dir_str = env::var("LLAMA_CPP_BUILD_DIR").unwrap_or_default();
    let build_dir = PathBuf::from(&build_dir_str);

    if !build_dir_str.is_empty() {
        let cmake_config = build_dir.join("llama-config.cmake");
        if cmake_config.exists() {
            if let Ok(content) = std::fs::read_to_string(&cmake_config) {
                for line in content.lines() {
                    if line.contains("LLAMA_BUILD_COMMIT") {
                        if let Some(start) = line.find('"') {
                            if let Some(end) = line[start + 1..].find('"') {
                                println!("cargo:rustc-env=LLAMA_BUILD_COMMIT={}", &line[start + 1..start + 1 + end]);
                                return;
                            }
                        }
                    }
                }
            }
        }
    }

    // Fallback to env var or empty string — runtime config always wins anyway.
    println!("cargo:rustc-env=LLAMA_BUILD_COMMIT={}", std::env::var("LLAMA_BUILD_COMMIT").unwrap_or_default());
}
