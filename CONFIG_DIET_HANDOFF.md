# ENGINE-CONFIG-DIET — Handoff / Resume Notes

> Written at context-compaction pause. **Read this first, then the commits, then
> the relevant AGENTS.md.** Working tree is clean.

## Where we are

- **Branch:** `ENGINE-CONFIG-DIET` — **17 commits ahead of `main`**, working tree clean.
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

### 5. Dropped dead `ProviderConfig.params` (eade230) — item B
`params: serde_json::Value` (always `json!({})`, never read in Rust; frontend only used
it as a 2048/512 FIT-scan fallback that never fired). Removed from struct + the two
`json!({})` construction sites + TS type + custom-provider form's unused params + the
FIT-scan fallbacks (now explicit `batch: 2048, ubatch: 512`).

### 6. Removed dead production code (0828fb8) — item C tier 1
Dead-code warnings 19 → 12. Removed `github_releases` `APP_7Z_PREFIX` +
`fetch_latest_version_release`, `plugin_catalog::catalog_has_pending_updates`,
`spec_draft::DraftRole::from_str` + `spec_type_parallel_conflict`, `config/meta` unused
`HashMap` import, and the unused `backend_type` param from `engine::peek_next_launch_port`.
**Excluded** (user actively uses): `sidecar_elevate` `run_privileged`/`spawn_privileged`/`cmd_quote`,
`trash_util::move_all_to_trash`, `qwen_code` `context_window`. Kept `default_stack_parallel`
(serde-default false positive) and the fit_scanner parse helpers + config `make_*` test helpers
(used by stale test modules — see AGENTS.md Tests section).

### 7. Collapsed 6 inventory maps → one field (2d29404) — item A slice A2
`ProviderConfig` had 6 parallel per-env inventory maps (`bundled_/foundry_/catalog_` ×
`_binary_path_per_env`/`_build_info_per_env`). Collapsed to a single serialized field
`inventory_per_env: HashMap<String, EnvBinaryInventory>` where
`EnvBinaryInventory { bundled/foundry/catalog: Option<BinaryEntry> }`,
`BinaryEntry { path, info: Option<BuildInfo> }`. Wire rename `"inventoryPerEnv"`.
Backend: `profile_binaries` resolver + `reactor_foundry` probe/write-back +
`binary_update` + `plugin_catalog` + `config/discovery`. Frontend: `types.ts`
(`envBinaryLookup` helper + new TS types) + `FoundryComponents`/`UpdatesConfig`/
`ProvidersConfig`/`foundryBuildRefresh` — all **read-only** rewrites via `envBinaryLookup`.
`merge_probed_version` (real `llama --version` preservation) intact via a prev-inventory clone.
**Launch path untouched** (active `binary_path_per_env`/`build_info_per_env` maps unchanged).

## Gates (all currently green)

```
cargo build           ✅  ZERO warnings (dead-code warnings fully eliminated: 19 → 0;
                          test helpers #[cfg(test)]-gated, serde default #[allow(dead_code)],
                          dead fns removed)
cargo test            ✅  110 pass / 0 fail (the 2 old failures fixed in 125706b: FIT
                        cache key now slash-normalized; qwen36 fixture got its arch line)
npx tsc --noEmit      ✅
```

## What REMAINS (reassessment order)

**A2 (rest). Full collapse of the ACTIVE + PREFERENCE/TAG maps** — DECIDED: **NOT doing it**.
Investigation showed these 5 maps hold genuinely **distinct** data (not parallel copies of the
same data, unlike the 6 inventory maps), so there's no drift-bug class to kill — the payoff is
only ergonomics. And most are load-bearing in subtle ways, so the risk isn't justified:
- `binary_path` (singular): default-profile active path — launch fallback, stored in port locks,
  AND written directly by discovery / binary_update / migration. Not safely derivable.
- `downloaded_version_per_env`: dual role — updates tag AND gates `prefer_catalog` (plugin-pack
  installed detection) in resolve. Not purely cosmetic.
- `binary_source_per_env`: the mechanism that makes a fresh Foundry build ACTIVE (pref +
  `resolve_after_source_change`), plus user choice that must persist. Load-bearing.
- `last_pr_per_env`: display only.

**Synthetic `"current"` build-info key: REMOVED (deb9041).** Verified it was dead — written by
the backend but never read by name on the frontend (only surfaced as one more entry in
`Object.values()` iterations, where the real profile key is already present). Active binary is
NEVER selected via `"current"` (that's `binary_source_per_env` + resolve). Deleted
`sync_current_build_info` + the 3 `reactor_foundry` write sites. No frontend change needed.

**C tier 2 — stale test modules.** Decided (per user): KEEP the test modules for now; they're
`#[cfg(test)]`-gated so they add zero `cargo build` warnings. Documented in AGENTS.md "Tests"
section; a future pass should refresh them to assert real current behavior (or drop the valueless
ones). (The old 2 failing tests — `cache_key_tests`, `launch_memory_parse` — were fixed in
`125706b`; `cargo test` is now 110/0.)

**Dead-code warnings: eliminated (19 → 0).** d502138 gated test helpers with `#[cfg(test)]`
(merge_tests + fit_scanner helpers) and `#[allow(dead_code)]` on the serde-default
`default_stack_parallel`. eab9f30 removed the last 5 genuinely-dead items (verified no callers):
`sidecar_elevate` `run_privileged`/`spawn_privileged` (live path uses `run_privileged_batch`),
`atomcode::cmd_quote`, `trash_util::move_all_to_trash` (keep `move_to_trash`, used by engine),
`qwen_code::QwenEngineRef.context_window` field.

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
