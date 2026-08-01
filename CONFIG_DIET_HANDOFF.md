# ENGINE-CONFIG-DIET — Handoff / Resume Notes

> Written at context-compaction pause. **Read this first, then the commits, then
> the relevant AGENTS.md.** Working tree is clean.

## Where we are

- **Branch:** `ENGINE-CONFIG-DIET` — **8 commits ahead of `main`**, working tree clean.
- **Project goal:** reduce the **maintenance surface** of the engine-config system
  (NOT just line count — *simpler logic = fewer issues long-term*). The system has
  been edited/added/removed across hundreds of iterations, so there is dead and
  redundant code to remove.
- **Key decision that changed the whole plan:** **the app has NO users** → **no
  migration logic is needed**. Any code that exists only to migrate/convert old data
  (old template formats, retired profiles, legacy file layouts) can be **deleted**,
  not kept for compatibility.

## Commits on the branch (oldest → newest)

```
671a512 config-diet: remove dead/deprecated code          [prior session]
20891a0 config-diet: consolidate validators + loaders      [prior session]
a7219bf config-diet: fix pre-existing broken test modules  [prior session]
347f4a7 config-diet: split config.rs god-file into modules [this effort]
f609f5f config-diet: drop migration/dead code (no users)
0fd40e0 config-diet: remove dead code orphaned by migration
88487b0 config-diet: merge ProviderMeta into ProviderConfig
005b139 config-diet: drop LaunchProfile, expose SpawnProfile
```

## What is DONE (all gates green)

### 1. Split the config god-file (347f4a7)
`src-tauri/src/config.rs` was **3815 lines**. Now it is a **re-export hub (647 lines)**
plus **9 focused submodules** under `src-tauri/src/config/`:

| Module | Concern |
|---|---|
| `paths.rs` | path/dir infra, portable-structure setup, constants |
| `meta.rs` | `ProviderConfig`/`AppConfig` persistence, user-config files |
| `validate.rs` | provider param validation + block-save |
| `discovery.rs` | disk discovery, full config assembly, template types |
| `model_library.rs` | model path mgmt + download-dest validation |
| `hf_download.rs` | HuggingFace download/quant validation |
| `merge.rs` | factory-template ↔ user-param merge |
| `commands.rs` | app-config load/save + reset/setup commands |
| `export.rs` | factory template export (admin/dev) |

**Mechanism (important to understand before editing):** each submodule starts with
`use crate::config::*;` (glob-imports the hub) and the hub re-exports everything via
`pub use <mod>::*;`. This keeps the historical `crate::config::…` call sites working
with **zero body rewrites**. To move a fn between modules, make it `pub` (so it is
re-exported) and it resolves from anywhere via the glob.

### 2. Dropped migration + dead code (f609f5f, 0fd40e0) — because NO USERS
- `profile_binaries.rs`: `migrate_provider_profile_keys` + `migrate_hashmap_keys`
  (vanguard/fresh → frontier per-env map migration) + its `discovery.rs` call site.
- `meta.rs`: legacy array-format `*-user-config.json` migration in
  `load_user_providers_meta` (now loads single `ProviderConfig` only).
- `meta.rs`: dead `dev_factory_default_config_source_path`.
- `foundry_toolchain.rs`: `is_retired_profile` (orphaned by the migration removal).
- `types.rs`: `UserEditedTemplateParam::is_value_essentials_hidden` (never called).

### 3. Merged `ProviderMeta` → `ProviderConfig` (88487b0) — single struct
`ProviderConfig` (already the frontend model) is now **also the disk-persistence
format** for `*-user-config.json`. Deleted `ProviderMeta` struct + `from_config`
copying. Since no users, the transient inventory / `spawn_profile` / `params` fields
just persist too and are **ignored / re-scanned on load** (backward-compatible with
existing files: same serde renames, transient fields have `#[serde(default)]`).
**Backend-only** (frontend never saw `ProviderMeta`).

### 4. Dropped `LaunchProfile` → expose `SpawnProfile` (005b139)
`ProviderConfig.spawn_profile: SpawnProfile` (serde rename `"spawnProfile"`) replaces
the derived 5-field `LaunchProfile` struct + `from_spawn_profile`. Deleted
`LaunchProfile`, `Default`, `from_spawn_profile`. Frontend now reads **snake_case**
fields directly off `spawnProfile`: `auto_vram`, `fit_style`, `simple_param_keys`,
`essentialParamKeys` (stays camelCase — matches backend), `tensor_split`.
Removed `fitLaunchKeys` / `fitMarginMib` (never populated by backend) and dead
`emptyCustomLaunchProfile` (`customProvider.ts`).

## Gates (all currently green)

```
cargo build           ✅  (~19 pre-existing warnings, incl. test-module/dead-code)
cargo test            ✅  108 pass / 2 FAIL pre-existing & UNRELATED:
                        - fit_scanner::cache_key_tests::insert_fit_scan_result_rekeys...
                        - launch_memory_parse::tests::parses_qwen36_mtp_buffer_inventory
npx tsc --noEmit      ✅
```

## What REMAINS (reassessment order)

**A. Collapse the 10 per-env binary maps → `Vec<EnvBinaryState>` — the biggest
remaining win (~200–300 lines + 10→1 field) but the RISKIEST.**
The 10 maps are NOT truly parallel — they form 3 layers:
- **Inventory (transient, re-scanned each load, NOT persisted):** `bundled_/foundry_/catalog_`
  × `_binary_path_per_env` + `_build_info_per_env` (6 maps).
- **Active (persisted):** `binary_path_per_env` + `build_info_per_env` (2 maps, + synthetic
  `"current"` key).
- **Preference/tags (persisted):** `binary_source_per_env`, `downloaded_version_per_env`,
  `last_pr_per_env` (3 maps).

Critical subtlety: `profile_binaries.rs::merge_probed_version` preserves a **real
`llama --version` string** across rescans (engine identity = `llama-server --version`,
per AGENTS.md) because disk rescans only produce mtime placeholder labels. A collapse
must preserve this. Changing the wire contract (maps-keyed-by-profile → Vec) touches
**8 backend files + 7 frontend files** and needs a serialization migration. This is the
launch/binary path AGENTS.md flags as regression-prone.

**B. `ProviderConfig.params` field — dead** (always written `json!({})`, never read in
Rust; frontend reads `provider.params.batch/ubatch` only as a `|| 2048/512` fallback,
already undefined). Low value, trivial backend change + tiny frontend touch.

**C. Codebase-wide dead-code sweep** (a separate pass, NOT config-specific):
`sidecar_elevate` `run_privileged`/`cmd_quote`, `trash_util::move_all_to_trash`,
`github_releases` `fetch_latest_version_release`/`APP_7Z_PREFIX`, `fit_scanner` parse
helpers, `qwen_code` `context_window`, `types.rs` `default_stack_parallel`, etc.

## CONSTRAINTS / GOTCHAS

- **DO NOT TOUCH anything named FUSION** (user's explicit, still-in-force instruction).
  That includes `fusion_adapter`, `supports_fusion`, fusion pollers/adapters. The
  `spawn_profile` now serialized to the frontend includes these — do not alter that logic.
- **Launch/binary path is regression-prone** (AGENTS.md) — be extra careful with item A.
- **2 pre-existing test failures** (`fit_scanner`, `launch_memory_parse`) are unrelated
  to config — do not "fix" them as part of this work.
- Engine ports: **PID-only teardown, never port-based taskkill**. No `backdrop-filter: blur`.
- Windows paths with spaces → quoting rules (see AGENTS.md "Windows paths with spaces").

## Tooling quirks observed this session

- **`rg` output mangles long identifiers** in this terminal (they render as a bare `n`),
  making `rg` line output unreliable for reading code. **Use the `read` tool** (renders
  faithfully) or file-level `grep -l`/`grep -c` for reliable analysis.
- `config.rs` + the new `config/` modules are **CRLF** in the repo (git normalizes; the
  hand-written hub file is LF and git handles the conversion — warnings are cosmetic).
- Use `cargo check` for fast iteration; `cargo test` + `npx tsc --noEmit` as full gates.

## Environment

- CWD: `C:/Users/GHOST-TOWER/INFRA/blackwell-ops`
- Prior interrupted session (full-ctx): `2026-08-01T17-03-32-293Z` under
  `C:\Users\GHOST-TOWER\.pi\agent\sessions\--C--Users-GHOST-TOWER-INFRA-blackwell-ops--\`
- Original full assessment (the "40% over-engineered" analysis, spec/column/permission
  tradeoffs) lives at message idx 48 of that session file if you want the original rationale.
