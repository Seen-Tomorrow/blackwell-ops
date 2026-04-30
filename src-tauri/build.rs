use std::env;
use std::path::PathBuf;

fn main() {
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
