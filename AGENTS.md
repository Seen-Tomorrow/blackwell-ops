## Dev Startup / Kill Procedure

**Normal restart (Rust changes only):** Just run `npm run tauri` again in the same terminal. Cargo watch auto-recompiles. Vite stays running — no need to kill it.

**Full restart (both Rust + Frontend):**
```powershell
# Only kill Tauri's CMD.exe, NOT node/Vite
Get-Process -Name blackwell-ops -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
npm run tauri
```
> **Important:** Do NOT use `Start-Process -WindowStyle Hidden` to launch Tauri in background — the MCP bridge WebSocket plugin fails to initialize properly. Always run `npm run tauri` directly in your terminal (foreground).
>
- `npm run build` — `tsc && vite build`

No tests, lint, or CI configured.

## Stack

- **Backend:** Rust (Tauri v2) + Tokio async runtime
- **Frontend:** React 18 + TypeScript + Tailwind CSS + Vite 6
- **UI:** Custom dark terminal-style, transparent/decorationless window
- **Process Manager:** Spawns `llama-server.exe` via `tokio::process::Command`
- **Dev server:** port 1420 (Vite) / 9090+ (engine stack ports)

## Architecture

Data-driven CLI command generation — all engine flags come from `genesis_template.json`, not hardcoded in Rust. Each provider has a `template_type` ("ggml-llama" / "ik-llama" / "") that routes to the correct param set.

- `src-tauri/src/main.rs` — Tauri entrypoint, registers Tauri commands, spawns GPU telemetry background task (1s interval)
- `src-tauri/src/engine.rs` — `launch_engine`, `hot_swap_engine`, `stop_engine`, `clean_exit`, `check_vram_fit`, provider management (`list_providers`, `save_provider`, `remove_provider`) with template_type-aware param injection
- `src-tauri/src/engine_stack.rs` — 4-slot engine stack, manages running llama-server processes
- `src-tauri/src/templates.rs` — `ProviderTemplate` struct, `build_command()` loops through template params to construct CLI args. **Zero hardcoded flags.** `ctx_to_int_str()`, `offload_map()`, `template_type_for_id()`, `known_ids()` helpers.
- `src-tauri/src/types.rs` — shared types: `EngineConfig`, `ParamDef`, `ProviderConfig` (with `template_type` field), `ModelEntry`
- `src-tauri/src/config.rs` — `genesis_providers()` builds 3 built-in providers with per-provider params from embedded template, sets factory_default on each ParamDef. `param_def_from_template()` helper for consistent construction. `load_config()` entry point, detects GPUs, saves to disk. **No overlay/delta system.** Full param_definitions saved to provider_meta.json. Added: `check_template_update(providerId)`, `apply_template_update(providerId, addParams[], removeKeys[])`.
- `src-tauri/src/log_hub.rs` — batches engine stdout into 100ms LogBatch events, streams to frontend
- `src-tauri/src/telemetry.rs` — GPU telemetry scanning
- `src-tauri/src/vram.rs` — VRAM fit calculation
- `src-tauri/src/backend.rs` — ProviderRegistry for strategy-based launching
- `src/App.tsx` — state hub: models, stack, logs, telemetry, system events. Polls stack every 2s. Listens for `tauri://event` for telemetry/logs.
- `src/components/ConfigPage.tsx` — param editor with admin toggle (LOCKED=genesis-only/green, UNLOCKED=full edit/yellow), merged Basic/Advanced AddParamSection
- `src/components/ProvidersConfig.tsx` — provider management UI with template_type dropdown and auto-detect from ID
- `src/lib/types.ts` — frontend type definitions (mirrors Rust types)

## Config & Providers Architecture — Complete Reference

### Core Principle: Single Source of Truth (factory_default + defaultValue)

Each `ParamDef` carries **two independent values**:
- **`factory_default`** — set once at startup from genesis template, never changed by admin edits
- **`default_value`** — current/active value, can be edited by admin

Genesis template (`genesis_template.json`) is read only:
1. At startup — populates `factory_default` on fresh param_definitions
2. By CHECK TEMPLATE UPDATE — shows diff vs current state (never at render time)

No cross-referencing templates at runtime. No delta/overlay system.

```
genesis_template.json → factory_default + default_value = ParamDef.param_definitions
                                    ↓
                         provider_meta.json (full dump)
```

### File Layout

| File | Role |
|------|------|
| `src-tauri/config/genesis_template.json` | **Base template.** Defines all providers and their params. Embedded at compile time via `include_str!`. Read at startup (for factory_default) and by `check_template_update` IPC only. |
| `src-tauri/src/templates.rs` | Loads embedded template, provides `ProviderTemplate::load()`, `known_ids()`, `template_type_for_id()`, `build_command()` (CLI arg generation). **Zero hardcoded flags.** |
| `src-tauri/src/config.rs` | `genesis_providers()` — builds 3 built-in providers with per-provider params from template + factory_default set. `param_def_from_template()` helper sets both default_value and factory_default at once. Removed: all overlay/delta code (`load_provider_overlays`, `save_provider_overlays`, `apply_overlay_to_template`, `compute_deltas`). |
| `src-tauri/src/engine.rs` | `list_providers()` — returns providers with param_definitions as saved on disk. `params_for_template()` — loads params from template with factory_default set. `save_provider()` — saves full param_definitions to disk (no delta computation). |
| `src-tauri/src/types.rs` | `ParamDef` struct has `factory_default: serde_json::Value` field alongside `default_value`. Set once at load, never mutated by admin edits. `ProviderConfig` with `template_type`. |
| `provider_meta.json` (disk) | Saves provider metadata + **full param_definitions** (including factory_default). Read and written as complete dump on every save. |

### Provider Types (`template_type`)

Each provider has a `template_type` that determines which genesis_template.json params it gets:

| template_type | Genesis Template Key | Params | Providers |
|---|---|---|---|
| `"ggml-llama"` | `ggml-stable` (shared by ggml-dev) | 19 params | ggml-stable, ggml-dev |
| `"ik-llama"` | `ik-extreme` | 7 IK-specific params | ik-extreme |
| `""` (empty/custom) | N/A | None — user adds all manually | User-created custom providers |

**Auto-detection:** When a new provider is saved with empty `template_type`, the ID is checked case-insensitively: if it contains `"ik"` → `"ik-llama"`, else → `"ggml-llama"`. The frontend dropdown lets users override this.

### Built-in Providers (3)

Defined in `config.rs:genesis_providers()`:

1. **ggml-stable** — "GGML Stable", template_type="ggml-llama", 19 params from genesis_template.json
2. **ggml-dev** — "GGML Nightly/Dev", template_type="ggml-llama", 19 params (same structure as stable)
3. **ik-extreme** — "IK-Extreme (Flagship)", template_type="ik-llama", 7 IK-specific params

Each gets its own param_definitions loaded from the correct genesis_template.json key at startup. `params_for_id()` closure converts each `TemplateParam` to a `ParamDef`, setting both `default_value` and `factory_default` from the same template source.

### Param Definitions Flow (End-to-End)

```
1. App starts → load_config() calls genesis_providers()
2. genesis_providers() loads embedded genesis_template.json into TemplateBundle
3. For each built-in provider, params_for_id() converts template params → ParamDef[]
   with default_value = template.default AND factory_default = template.default (same value)
4. Full param_definitions saved to %APPDATA%/blackwell-ops/provider_meta.json
5. Frontend calls list_providers() IPC → returns providers from disk
6. ConfigPage.tsx receives providers, uses defaultValue vs factoryDefault per-param for styling

Genesis is read again ONLY when:
- RESET TO DEFAULTS button: re-reads template to reconstruct clean param_definitions
- CHECK TEMPLATE UPDATE button: diff current state vs fresh template (new/orphaned params)
```

### Admin Toggle Behavior (ConfigPage.tsx)

The LOCKED/UNLOCKED toggle controls edit access:

| State | Variable | Available Actions |
|---|---|---|
| **LOCKED** | `isAdminLocked = true` | Browse, copy values only. CHECK TEMPLATE UPDATE button visible. |
| **UNLOCKED** | `isAdminLocked = false` | Full edit: SET DEFAULT, drag-reorder, hide rows/values, add params, RESET TO DEFAULTS |

### Color Coding

- **Green (value bubble)** = factory default value matches current selected value
- **Yellow (value bubble text + border)** = user added this value to the param's values list
- **Yellow row highlight** = never used — only drag state highlights a row yellow

No more cross-template lookups needed for styling.

### RESET TO DEFAULTS Button (UNLOCKED mode)

Clears all admin edits for the selected provider. Re-reads from genesis template, sets `default_value = factory_default` on every param, clears hidden flags and user-added values. Confirmation modal required. Persists full clean state to disk.

### CHECK TEMPLATE UPDATE Button (UNLOCKED mode)

Compares current disk state vs fresh genesis template:
- **NEW IN TEMPLATE** — params in genesis but not on disk; pre-checked, can uncheck unwanted ones
- **ORPHANED PARAMS** — params on disk but not in genesis; unchecked by default, checked = keep

User selects which to merge via checkboxes. APPLY sends `addParams[]` + `removeKeys[]` to Rust:
- `apply_template_update(providerId, addParams, removeKeys)` — adds selected new params to disk state, removes unselected orphaned ones
- Both operations are atomic within the same IPC call

### Add Parameter Section (UNLOCKED mode only)

Single section with key input + value list builder. Saves full ParamDef (key, label=key, values) to provider's param_definitions array. No separate localStorage for user-added params anymore.

### Value Bubble Actions

| Action | LOCKED state | UNLOCKED state |
|---|---|---|
| Set as default (*) | Hidden | Always visible — sets this value as the param's default_value (saves to disk). If it matches factory_default, no yellow highlight. |
| Hide/show row (eye) | Hidden | Toggle: hide from catalog (sets `hidden` flag on ParamDef, saves to disk) |
| × remove value | Hidden | Removes value from param definition (saves to Tauri via add/remove operations). Does NOT affect factory_default. |

### Provider Management (ProvidersConfig.tsx)

Adding/editing providers includes a **Template Type dropdown**:
- GGML-Llama (19 params) — default for most providers
- IK-Llama (7 params) — auto-detected when ID contains "ik"
- Custom (manual) — empty param_definitions, user adds all manually

The dropdown defaults to the auto-detected value but can be overridden. When saving, `template_type` is stored in provider_meta.json.

### Persistence Model

| What | Where Saved | When |
|---|---|---|
| Param definitions + factory_default | `%APPDATA%/blackwell-ops/provider_meta.json` — full param_definitions array | On every save_provider IPC call |
| Provider metadata (binary_path, git_url, etc.) | Same `provider_meta.json` file | On save_provider / save_provider_meta IPC calls |
| User value overrides (selected values per model) | localStorage (`blackwell-ops-overrides:{providerId}`) | On setOverride calls |

### Command Building Flow (`build_command`)

This is the single most important function — it converts user-visible config into the actual CLI command. Rules:

1. **What the user sees in catalog → goes to CMD.** Any param/value not visible before launch is filtered out.
2. **`param.hidden = true`** (row hidden) → skip entire param, no flag or sub_params injected
3. **Value in `hidden_values[]`** → if it's the selected value, auto-switch to first visible value before injection (so config can never be "blind")
4. **Sub-params** — checked from disk state (`ParamDef.sub_params: HashMap`) first, then embedded template fallback

**`get_value()` priority chain:**
```
typed field on EngineConfig
    → extra_params HashMap (catalog-level runtime overrides)
    → param_definitions[].default_value  ← THE SOURCE OF TRUTH per AGENTS.md
    → genesis_template default (final fallback)
```

### Key Functions Reference

| Function | File | Role |
|---|---|---|
| `genesis_providers()` | config.rs | Builds 3 built-in providers with factory_default set from template |
| `param_def_from_template()` | config.rs | Helper: creates ParamDef with both default_value and factory_default = template.default |
| `load_config()` | config.rs | Tauri command entry point, detects GPUs, calls genesis_providers() → saves to disk |
| `check_template_update(providerId)` | config.rs | Returns `{new_params[], orphaned_params[]}` by comparing fresh template vs disk state |
| `apply_template_update(providerId, addParams, removeKeys)` | config.rs | Merges selected new params and removes unselected orphans from disk state |
| `params_for_template()` | engine.rs:924 | Loads params from correct template with factory_default set |
| `list_providers()` | engine.rs | Returns providers with current param_definitions from disk |
| `save_provider(provider)` | engine.rs | Saves full param_definitions to disk (no delta computation) |
| `template_type_for_id()` | templates.rs:111 | Maps provider ID → template type string |
| `ProviderTemplate::load()` | templates.rs:93 | Loads ggml-stable template from embedded JSON |
| `get_value(key, param_defs)` | templates.rs | Resolves selected value priority: typed field → extra_params → **param_definitions.default_value** (source of truth) → template default |
| `build_command(param_defs)` | templates.rs | Iterates params; skips hidden rows; auto-repairs hidden defaults to first visible; injects sub_params from disk-first then template fallback |
| `inject_sub_params()` | templates.rs | Checks param_definitions.sub_params (disk/HashMap) first, falls back to TemplateParam.sub_params (embedded JSON) |

### Gotchas

- **`genesis_template.json` must be valid JSON** — if corrupt, app panics on startup
- **Genesis read at startup + by CHECK TEMPLATE UPDATE only** — never during normal render or config editing
- **Custom providers (template_type="") get no injected params** — empty param_definitions, user adds all manually
- **`factory_default` is set once and immutable** — admin edits change `default_value`, factory_default stays as reference point for diff/styling
- **`provider_meta.json` stores full param_definitions** — no overlay/delta system; every save replaces the array entirely

## Frontend

- **Tabs:** catalog | stack | telemetry | Reactor11 | logs | config
- **Model base path** is hardcoded in `App.tsx:20-22`: `C:\Users\GHOST-TOWER\.lmstudio\models`


## Architect / Worker Pattern

You are **BRAIN (architect/validator)**. You run on the `build` primary agent. WORKER1 runs as subagent via `task(subagent_type="general", ...)`. Up to 3 workers can run in parallel.

**Your role:**
- Break work into independent, well-scoped subtasks with clear acceptance criteria
- Dispatch tasks to WORKER1 via the `task` tool — include file paths, exact edits, expected output. Use him often - Worker is 400% faster than BRAIN. 
- Review returned results, validate correctness, decide next steps
- Chain follow-up tasks iteratively until complete

**Worker role:**
- Reads files, makes edits, generates boilerplate, does grunt work
- Returns concise summary of what was done
- No cross-talk between workers — each is isolated

**When to delegate vs do directly:**
- **Delegate:** Multi-file reads/writes, boilerplate generation, searches across codebase, parallelizable tasks
- **Do directly:** Single-line edits, quick lookups, decisions that require full context awareness

## Behavioral rules

- **Avoid-hardcoding until requested by user** New flags MUST go in `genesis_template.json`. The code handles them via `ptype`.
- **Binary-safe math:** All memory/context sizing uses power-of-two (1024 multiplier).
- **Surgical edits:** Touch only what's requested. Don't "improve" adjacent code. Clean up your own orphaned imports.
- **Read-only context:** `src-tauri/src/templates.rs` and `src-tauri/src/types.rs` are the rules of the world. Don't propose changes to these unless asked.
- **No tests or lint** — verify by reading code, not running tests.
- **Windows-only paths** — don't assume cross-platform compatibility.

## Gotchas

- **WebView2 cache auto-clear on dev startup:** `main.rs` clears WebView2 Cache + Code Cache folders every debug launch to prevent stale JS bundles. This is DEBUG ONLY (`#[cfg(debug_assertions)]`). Paths: `%LOCALAPPDATA%\com.blackwell-ops.sentinel\EBWebView/Default\Cache` and `\Code Cache`.
- Tauri MCP bridge plugin (`tauri-plugin-mcp-bridge`) is **only loaded in debug builds** (`#[cfg(debug_assertions)]`)
- `tsconfig.json` has `strict: false`, `noUnusedLocals: false`, `noUnusedParameters: false`
- `@/*` path alias maps to `src/*`
- `tailwind.config.js` defines custom color palette: `stealth-*`, `nv-*`, `telemetry-*`
- `tsconfig.node.json` is separate (Vite node config)
- Release profile: `opt-level = "z"`, `lto = true`, `codegen-units = 1`, `strip = true`



