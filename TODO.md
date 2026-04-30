# TODO — Remove Hardcoded Build Profiles

## Current State (Hardcoded)

Build environment profiles are defined as an enum with match arms in `src-tauri/src/reactor_foundry.rs:20-67`:

```rust
pub enum BuildEnv { Vanguard, Stable, Fresh }
```

Each variant has hardcoded paths for:

| Property | Vanguard | Stable | Fresh |
|----------|----------|--------|-------|
| **VS DevCmd** | VS 18 (BuildTools) | VS 2022 (BuildTools) | VS 2022 (BuildTools) |
| **CUDA Toolkit** | v13.2 | v12.8 | v13.1 |
| **nvcc.exe** | `.../CUDA/v13.2/bin/nvcc.exe` | `.../CUDA/v12.8/bin/nvcc.exe` | `.../CUDA/v13.1/bin/nvcc.exe` |

### How it works now

1. User selects a provider + environment (vanguard/stable/fresh) in the UI
2. `foundry_build()` is called with `BuildEnv` enum variant
3. `env.cuda_path()`, `env.nvcc_path()`, `env.vs_devcmd()` return hardcoded paths via match arms
4. CMake configure batch script sets `CUDA_PATH=<env.cuda_path()>` and calls VS DevCmd
5. After build succeeds, `nvcc --version` is run to extract exact CUDA version (e.g., "13.2.51")
6. Build info (`version`, `cuda_version`, `build_date`) saved to `provider_meta.json` under `buildInfoPerEnv[env_label]`

### Where it's referenced

- `reactor_foundry.rs:20-67` — enum definition + match arms (paths, labels, excluded CUDA versions)
- `reactor_foundry.rs:140` — `environment: BuildEnv` field in build request struct
- `reactor_foundry.rs:154-157` — string-to-enum conversion ("vanguard" → BuildEnv::Vanguard, etc.)

## Goal

Move all profile definitions to a JSON config file (e.g., `src-tauri/config/build_profiles.json`) so users can:
- Add new profiles without recompiling
- Customize CUDA toolkit paths per machine
- Override VS DevCmd locations
- Define which CUDA versions to exclude from PATH scanning

### Proposed Config Shape

```json
{
  "profiles": {
    "vanguard": {
      "vs_devcmd": "C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\Common7\\Tools\\VsDevCmd.bat",
      "cuda_toolkit": "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.2",
      "excluded_cuda_versions": ["v12.8", "v13.1"]
    },
    "stable": { ... },
    "fresh": { ... }
  }
}
```

### Migration Steps

1. Create `src-tauri/config/build_profiles.json` with current hardcoded values
2. Add a loader function in Rust to parse the config at startup (with fallback to embedded defaults)
3. Replace all `env.cuda_path()`, `env.nvcc_path()`, `env.vs_devcmd()` match arms with config lookups
4. Update `BuildEnv` enum or replace with string-based profile IDs
5. Remove hardcoded paths from `reactor_foundry.rs`
6. Add UI for editing profiles (optional — can be done via JSON edit first)
