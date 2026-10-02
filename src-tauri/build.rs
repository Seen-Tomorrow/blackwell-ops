use std::env;
use std::path::PathBuf;

/// Bake source provenance into the binary.
///
/// Releases are built locally by `majestic`, and nothing ever recorded which commit
/// produced a given exe. That is not academic: `v1.0.66` and `v1.0.68` both resolve to
/// one commit, `v1.0.69` and `v1.0.70` to another, and neither matches the version in
/// `tauri.conf.json` at that commit. When a user reports a crash there is currently no
/// way to answer "which source was this built from".
///
/// Emitted first so nothing downstream can skip it via an early `return`.
fn emit_source_provenance() {
    let git = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(env::var("CARGO_MANIFEST_DIR").ok()?)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };

    let sha = git(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"])
        .filter(|s| !s.is_empty() && s != "HEAD")
        .unwrap_or_else(|| "detached".into());
    // "dirty" is the important one: it says a shipped build does not match any commit,
    // which is the case that makes a bug report unrepeatable.
    let dirty = match git(&["status", "--porcelain"]) {
        Some(status) if !status.trim().is_empty() => "dirty",
        Some(_) => "clean",
        None => "unknown",
    };

    println!("cargo:rustc-env=BLACKWELL_GIT_SHA={sha}");
    println!("cargo:rustc-env=BLACKWELL_GIT_BRANCH={branch}");
    println!("cargo:rustc-env=BLACKWELL_GIT_DIRTY={dirty}");

    // Re-run when HEAD moves so the baked SHA cannot go stale. Only claim this when the
    // path exists: this build script already emits a rerun-if-changed, so pointing at a
    // missing file would force a rebuild on every invocation.
    if PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_default())
        .join("../.git/HEAD")
        .exists()
    {
        println!("cargo:rerun-if-changed=../.git/HEAD");
    }
}

fn main() {
    emit_source_provenance();

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
