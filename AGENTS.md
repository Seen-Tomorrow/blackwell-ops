# AGENTS.md

Traps and invariants only — not a code map. Read the source for flows, schemas, and file layout.

---

## CRITICAL: never kill the running app

**NEVER `Stop-Process` / kill `blackwell-ops` without explicitly asking the user first.**
The running instance is frequently the REL build that is actively serving the LLM engine
(and thus the very agent session doing the work). Killing it kills the session/engine.
If a build fails because the exe is locked (`Access is denied (os error 5)` / cannot remove
`target\...\blackwell-ops.exe`), that is normal — ASK the user to close the app, or use a
different build target. Do not auto-kill. The only exception is a user explicitly instructing
`npm run tauri` full-restart flow, and even then confirm before stopping a REL-served session.

**How to tell REL vs DEV before touching anything** — by executable path (use
`scripts/identify-app-processes.ps1`):
- **REL** = path contains `Blackwell OPS portable` (e.g. `C:\AI-MASTER\Blackwell OPS portable\blackwell-ops.exe`)
  → serves the engine/session; **never kill**.
- **DEV** = path contains `target\debug` (e.g. `...\src-tauri\target\debug\blackwell-ops.exe`).
- If a `cargo build` fails with a locked exe, the REL app is running — ASK the user to close
  it or build to a separate target.

---

## CSS / themes (frontend)

**Tokens only** — Theme differences live in `src/themes/app-themes.ts` (`--theme-*`, `--fusion-eink-*`, `--theme-launch-*`). Apply via `applyAppTheme()`. Do **not** add new `[data-theme="…"]` or `html:not([data-theme=…])` component rules in CSS.

**Domain partials** — Styles live under `src/styles/*.css`; `src/index.css` is Tailwind + `@import` only. Edit the matching partial (chrome, cockpit, fusion-display, config, launch, …).

**No theme forks** — New colors/surfaces: add a token on **all** themes, then use `var(--theme-…)` in one rule. Arctic is not special-cased in CSS.

**Tailwind** — Prefer layout utilities + semantic theme classes / CSS variables. `stealth` / `nv` utilities resolve to CSS vars (theme-aware). Do not reintroduce hard-coded multi-theme palettes in `tailwind.config.js`.

**Removed modules** — Mobile Sentinel Bridge (`mobile_bridge.rs`, WebSocket `0.0.0.0:3814`, `tokio-tungstenite`) is fully removed — backend and UI. Do not revive it.

**Industrial display (bezel / glass)** — One glass only: frame pad = metal, `.phosphor-screen-inner` = full face + unified recess shadow, children = content (no nested phosphor surface). Display texture also paints HW monitor widget faces (`.launch-rail-tel .phosphor-display-surface`) — not catalog quiet-wing desaturate. Full memo: `docs/display-bezel-glass.md`. Do not revive `DisplayGlitchOverlay` / `.display-glitch-*`.

**No `backdrop-filter: blur` (or `-webkit-backdrop-filter: blur`)** — Modal/scrim overlays must **dim only** (semi-opaque `background`, e.g. `color-mix(in srgb, #000 60%, transparent)`). Blur forces continuous full-compositor work in WebView2 and pegs the **iGPU at ~100%** for as long as the overlay is open (harness confirm, etc.). Prefer stronger dim over blur. Do not reintroduce blur for “frosted glass” aesthetics without an explicit exception.

**Vite/Rolldown barrel re-exports** — Never mix `type` into a value re-export list:
`export { type Foo, bar } from "./x"`. Vite 8 / Rolldown can emit an **empty module**
(only a sourcemap). Symptom: black WebView, DevTools `Uncaught SyntaxError: Invalid or
unexpected token`, while `tsc` / `npm run build` stay clean. Split them:
`export { bar } from "./x"` + `export type { Foo } from "./x"`. Sanity-check a suspect
URL: `curl http://127.0.0.1:1420/src/.../file.ts` must show real `export { ... }`, not
solely `//# sourceMappingURL=...`.

**WebView2 module cache** — After a bad transform (empty barrel, half-HMR), F5 / Vite
restart / rebuild may still black-screen: Chromium caches the broken JS under
`%LOCALAPPDATA%\com.blackwell-ops.app.dev\EBWebView\Default\` (`Cache`, `Code Cache`,
`GPUCache`, `Service Worker`). Clear those folders (app may lock files — close DEV
window first if needed), then reload. REL profile is `com.blackwell-ops.app`. This is
**not** localStorage; wiping storage keys will not fix a cached empty module.

**VRAM forecast is measured-only** — No GGUF formula path. Paint sources:
`LEARNED` / `LEARNED≈` / `FIT PROBE` only (`src/services/vram/forecast/`, default adapter
`ggml_master`). `evaluate()` returns `null` → skeleton until probe/learned lands. Old
formula scenarios live under `tmp/archive_vram_formula/` (gitignored scratch), not in
the live graph.


---

## Product floor / layout density

**Supported viewports** — **1080p minimum (marginal)**, **1440p+ recommended**, **4K optimal**. Below 1080 is out of scope (no layout redesign). Vertical space is the constraint; horizontal is fine. Prefer **manual** density (display bezel **GPU 2|3** / **ENG 2|3** cards-per-row) over auto viewport policies. HW monitor: GPU stack scrolls; OC panel stays pinned above launch dock.

**DEV tools (header)** — `VIEW` = physical panel presets + live Windows scale (app zoom 100% when testing). `GPU+` = fake multi-GPU topo (real SKU names/VRAM) for layout + forecast stress — session only. Do not ship these in REL UX.

---

## Agent harness

**Supported harness = pi only** (`pi_code`). Live product surface is the agentic harness framework: `harness-*` CSS, `html[data-harness-open]` / `data-harness-wizard`, `--theme-harness-brain-*` / `--theme-harness-worker-*`, and `EVENTS.harness*`. Tool id is `HarnessToolId = "pi"`; `normalizeHarnessTool()` coerces any legacy localStorage `"atomcode"` / `"qwen"` to pi. **AtomCode and Qwen Code are archived** — their backends, Tauri commands, `lib/atomcode.ts` / `lib/qwenCode.ts`, and root docs are gone. Do not revive product UX, install paths, or dual-stack routing for them. `external_agents.rs` **stays** (`pi_code.rs` + `download_manager.rs` depend on it). Future extra harness tools should plug into the same neutral `harness-*` chrome + `HarnessToolId`, not reintroduce product-branded class names. pi models.json: per-seat **`input: text|image`** only when that engine launched with **`--mmproj`** (`stack.vision`); BRAIN and WORKER are independent.

**Session roles (local stack)** — This seat is the **designer/planner mastermind**. Local engines:
- **BRAIN** — capable thinking model (design, planning, hard reasoning)
- **WORKER** — fast non-thinking grunt (mechanical edits, lookups, bulk work)
- **Adviser** — Claude / Grok 4.6 when stuck on a difficult task (external escalate)
Route grunt work to WORKER; keep design/plan/judgment here; escalate only when blocked.

**Temp / debug / scratch files → `tmp/`** — Any throwaway agent work (test scripts, probe outputs, `nul`, `*.py`, `*results.json`, one-off experiments) must be written under the **gitignored `tmp/` directory** (repo root), never at the repo root or anywhere tracked. Do not `git add` them; do not leave them in the working tree where they show up as untracked. If you need a scratch area, use `tmp/` (already in `.gitignore`) or a subdir under it. Clean up after yourself; a dirty `git status` from agent junk is a review failure. **Commit only real source changes**, categorized logically (feature / fix / theme, separate commits per concern).
**Orphaned headless Chrome (visual checks)** — The agent browser tool (puppeteer) runs its own headless Chromium under `C:\Users\<user>\.omp\puppeteer\chrome\win64-<ver>\chrome-win64\chrome.exe`. Sessions/tabs that close (or error mid-run) **orphan the process tree** — invisible (no window) but ~85 MB each, accumulating until the user Task Manager-hunts them. **Reap them in the same step as closing the browser session.** Kill by path filter ONLY — the user's real Chrome/Edge share the `chrome.exe` name, so a bare `Stop-Process -Name chrome` is forbidden:
```powershell
Get-Process -Name chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like '*\.omp\puppeteer\*' } |
  Stop-Process -Force
```
The bash tool mangles `$_`/`$p` in inline `powershell -Command` strings (eats the `$`) — write the snippet to a script under gitignored `tmp/` and run `powershell -NoProfile -ExecutionPolicy Bypass -File tmp/<name>.ps1`.


---

## Regressions to avoid

**Engine ports** — Do not reintroduce port-based taskkill (`kill_process_by_port` or netstat carpet-bomb) on launch, stop, or fail paths. Launch uses `engine_port_lock::reclaim_our_ghost_or_fail` (verified orphan only); teardown is PID-only via `stop_child_fast` / `kill_process_by_pid`. Old behavior killed ESTABLISHED fusion/health clients and sibling app instances.

**Engine lifetime** — Engines join a private Job Object (`engine_job`, `KILL_ON_JOB_CLOSE`). Never bare `AppHandle::exit` without `engine::teardown_all_for_app_exit` (update path included). Stop is taskkill-by-PID only (no console CTRL+C). Startup runs `kill_orphans_of_dead_owners` then `sweep_stale_locks`.

**App exit / heap corruption (`0xC0000374`)** — After engines are stopped, do **not** use `AppHandle::exit(0)` or `WebviewWindow::destroy()` for process death. Session logs showed STATUS_HEAP_CORRUPTION in ntdll immediately after “main window destroyed” / Tauri Drop, even when taskkill + fusion stop had completed cleanly. Close/update path: `teardown_all_for_app_exit` → `app_lifecycle::finish_process_exit` → `std::process::exit(0)` (skip webview destroy + Tauri Drop cascade). During shutdown: `app_lifecycle::begin_shutdown` suppresses fusion/IPC and pipe-EOF FIT work. Fusion warm-idle poll is 250ms (not 50ms) to avoid multi-engine HTTP stampede before exit.

**REL blink-close after reboot (`0xC0000409` / Instant underflow)** — Not WebView. Windows `Instant` is boot-relative: `Instant::now() - Duration::from_secs(3600)` (or any window longer than uptime) **panics** with `overflow when subtracting duration from instant`. REL `panic = "abort"` → process dies right after frontend ping (canvas blinks, exit `0xC0000409`). Hit path: GitHub REST gateway hourly budget in `github_releases.rs` (`budget_remaining`), reached from REL `get_startup_updates` (DEV skips auto startup checks). Fix pattern: `now.saturating_duration_since(t) < window` / `checked_sub` — never bare `Instant - Duration`. Diagnose: `%TEMP%\blackwell-panic.log` (not only `blackwell-crash.log`). Do not reintroduce cutoff-via-subtraction in rate budgets, TTLs, or caches.

**Tauri listeners** — Use `useTauriListen`; raw `listen()` in `useEffect` leaks under StrictMode because unsubscribe resolves after first cleanup.

**Frontend persistence** — New localStorage keys → `storage.ts`. New window events → `events.ts`. Tauri event names (`engine-log-batch`, etc.) are backend-owned strings.

**Windows `is_process_alive`** — `PROCESS_QUERY_INFORMATION` only. `PROCESS_VM_READ` is denied on child processes → false “dead” reads. `OpenProcess` failure is **NULL (0)**, not `INVALID_HANDLE_VALUE` — must treat both as failure or dead PIDs look “alive” via `GetExitCodeProcess(null)`. On open failure: `ERROR_INVALID_PARAMETER` = PID gone (dead); `ERROR_ACCESS_DENIED` = treat as alive (protected process).

**Windows detached console spawn** — Never use `CREATE_BREAKAWAY_FROM_JOB`. Cargo/Tauri/dev hosts put the process in a job that denies breakaway → immediate `Access is denied (os error 5)`. Detached visible windows: `Start-Process` (or `cmd start "" …`) via a `CREATE_NO_WINDOW` helper — see `engine::spawn_nobsproof_cmd_window` and `distribution::spawn_detached_chain`. `CREATE_NEW_CONSOLE` alone is last resort; breakaway is never OK. Pack/ship do not need gsudo/admin.

**Windows paths with spaces** — Users may install anywhere (incl. `"C:\AI-MASTER\Blackwell OPS portable"`). NSIS default folder is `Blackwell-Ops` (no space) for hygiene only — **do not** require space-free paths. Symptom of broken quoting: `'C:\…\Blackwell' is not recognized as an internal or external command` at Foundry cmake configure.

- **`cmd /s /c` batch launch** — `/s` strips the outer quotes CreateProcess adds. A bare path arg becomes unquoted and splits on spaces. Always launch `.cmd`/`.bat` via `sidecar_elevate::cmd_script_raw_tail` / `apply_cmd_script_raw_arg` / `cmd_script_launch` → literal `cmd /d /s /c ""path\to\script.bat""` attached with `CommandExt::raw_arg` (not `.args()` on the tail). Same for app-update helper, GPU priv scripts, silent update spawn. Do **not** reintroduce `cmd … /c` + unquoted path or `.args(["/c", path])`.
- **Command lines embedded in `.cmd`** — Prefer `Command::new(exe).args([...])` (CreateProcess argv — spaces OK). When a full line must run inside a batch (Foundry cmake, NoBSproof, session `LAUNCH_CMD`), quote every token: `engine_utils::format_cmd_line` / `format_cmd_arg` / `format_debug_executable`. Never `binary.display()` + `args.join(" ")` without quoting. Inside batches: `call "vsdevcmd"`, `set "PATH=…"`, cmake `-B "…" -S "…"` already.
- **Safe patterns already** — Engine/FIT/GGUF spawn via argv; explorer `/select,` + path as separate args; 7z `-o{dest}` as one argv; GPU smi/inspector via `quote_exe` in priv batch; PS `Start-Process -ArgumentList @(...)` with single-quoted paths.

**Release asset naming** — `CORE_*` = App `.7z`, Full NSIS Setup, optional `CORE_ggml-master-{profile}.7z`. `PLUGIN_*` = optional engine packs. **Pack Full** stages CORE only (App + Setup with Master) — never bulk PLUGIN packs. Plugins via explicit Pack+Ship per provider. Ship full filters to CORE assets. Client accepts legacy unprefixed names.

**App Pack/Ship identity** — DISTRIBUTION Pack+Ship must never publish a DEV PE under a REL tag. Pack scrubbs `TAURI_CONFIG`, forces `cargo clean -p blackwell-ops --release`, builds with default `tauri.conf.json` only (never merge `tauri.conf.dev.json`), then asserts PE ProductName=`Blackwell Ops`, FileVersion=conf version, no `.app.dev`/`:1420`. Ship re-asserts App `.7z` contents before `gh release`. Header semver uses runtime `package_info` (`get_app_package_version`), not Vite `__TAURI_VERSION__` alone.

**Binary sources** — Core: Bundled (`runtime/`) + Foundry + Catalog overlay (`runtime-catalog/{id}/{profile}/`) — catalog must **not** clobber NSIS. Plugins: Catalog install under `runtime/` (+ Foundry if built). Active source is switchable (`binarySourcePerEnv` is sole ACTIVE). Product tag (`downloadedVersion`) is for UPDATES only; engine identity = `llama-server --version` (not app tag). Plugin metadata: `runtime-catalog/plugins.json` (legacy `runtime/catalog/` still read).

---

## Foundry paths

**Foundry `work/` CMake cache** — Retained between builds for all users when the configure fingerprint matches (`.blackwell-foundry-cache-key` + `CMakeCache.txt`). Fingerprint miss, configure failure (cold path), or CLEAR CACHE wipes the tree. `foundry/artifacts/.../Release/` is the only durable **runtime** binary location. Provider `binary_path` / `binary_path_per_env` must point at artifacts after a foundry build, never at cmake temp output under `work/`.

**Foundry batch spawn** — Configure/build write `_build_cfg_*.bat` / `_build_run_*.bat` under `work/` then run via `cmd_script_launch` + `run_foundry_batch_streaming` (`raw_arg` tail). Do not spawn those batches with plain `cmd /c path` — install dirs with spaces fail before cmake starts (see **Windows paths with spaces** above).

---
## APP/engine logs
DEV session files (engine stderr/stdout + launch): `{exe_dir}/config/logs/sessions/`  
→ typically `src-tauri/target/debug/config/logs/sessions/session-*/`  
Always ON in debug builds; `BLACKWELL_SESSION_LOG=0` off, `=1` force-on (incl. REL). Last **25** sessions kept.  
Native crashes also append `%TEMP%\blackwell-crash.log` (heap `0xC0000374`, illegal insn `0xC000001D`).
---

## Provider config merge

`merge_template_for_provider` syncs structure from factory templates on every load/save. User-owned fields that must not be overwritten: `hidden`, `order`, `userAddedValues`, `hidden_values`. Bump factory `templateVersion` when shipping param changes — mismatch surfaces `needs_template_attention` in ConfigPage.

**Spec profiles (`SPECULATIVE-MTP` / `SPECULATIVE-DFLASH`)** — Template-owned groups with independent knobs (`mtp_*` / `dflash_*`). Boost selects which profile is visible (`set_group_hidden`); Off hides both. Launch flattens the active profile to CLI keys (`spec_type`, …) via `buildSpecCliExtraParams` — do not emit profile row keys as raw extras. Defaults live only in factory templates (Config editor), not hardcoded presets.

**DSpark** — Product Boost method only; **no separate template group**. Shares **SPECULATIVE-DFLASH** knobs + `dflash_draft_model` → `--spec-draft-model` (`-md`); CLI type is **`draft-dspark`**. Do not reintroduce free-form factory `spec_type` chips.

**Hidden profile knobs → CLI** — Config/cockpit **hide** (`hidden` / `userHidden`) on `mtp_*` / `dflash_*` must **not** reach CLI. `buildSpecCliExtraParams` skips hidden rows; Rust must not force-emit hidden profile knobs from `extra_params` (override path + post-loop). Draft path keys still allowed when external draft is active.

**CORS** — Launch injects `--cors-origins localhost` when unset (llama-server default `*` + no API key spams security warnings). Do not force open `*` for desktop.

**Protected groups (CONFIG policy)** — Flag-driven via provider `protectedGroups` (not name hardcoding). Factory ships the list; DEV can toggle **SYS** on a group header. Protected groups sort under a **SYSTEM PARAMS** section (auto-collapsed on open). Actors: locked / user (editor unlocked) / dev (`isDevBuild` unrestricted, or **USER VIEW** preview). Users on protected groups: set defaults, add/hide values (not whole-row hide); cannot delete factory values (hide only) or tear down factory structure. Placement chrome (`split`/`ctx`/SYSTEM bucket) remains Launch placement-locked for users. Do not pin `mtp_*`/`dflash_*` into SYSTEM.

**Launch forces vs template** — Prefer `spawn_profile` (verbosity_args, enable_metrics, fit_style) and template params only. Do **not** invent CLI keys absent from the provider param list (no silent `cont_batching` force). Custom `template_type=custom` uses bare launch shell (model/port/alias only) plus optional `customCapabilities` (fusion / metrics / verbose+free-form flags). Cockpit binds only when Master param **keys** exist on the template (hide unbound knobs). Essentials pack inserts regular user-editable rows (not protected). Custom soft-launches despite VRAM `fits=false` (warn only); factory providers keep hard gate.

---

## Known gaps / flags

- Reaper clears slots + `engine-locks` on unexpected exit (Loading or Running). Stale locks from prior sessions are swept on app start and when launching on a free port.
- **Quiet stderr loads** — Some models stop writing to stderr early (pipe EOF) while still loading. `log_hub` must not fail the slot when spawn-time `engine_pid` is still alive; HTTP `/slots` or `/health` readiness owns promotion to Running. Do not require stderr “model loaded” lines for these models.
- **GPU topo “External apps”** — Grey = NVML used minus (breakdown SELF + capped CUDA/runtime, max 4 GiB/GPU). Do not assign all NVML to our bar when a foreign app (LM Studio) shares the GPU. Stale NVML after stop = background `scan_gpus` + `gpuMemoryKey` re-eval + burst poll on `slot-cleared` (+2s).
- `BINARY_UPDATES_ENABLED = true` — App `.7z` + Full NSIS + provider packs via GitHub releases (Majestic ships assets).
- Fusion prefill % needs `prefill_tokens_total` from `NewPrompt` log; `/slots` `n_prompt_tokens_processed` is the numerator. Do not call `reset_prefill_counters()` on `/slots` new_request after NewPrompt — it zeroes total and forces fallback to sparse `print_timing` stderr lines.
- Bench warmup→measured has no `/slots` idle gap — call `reset_bench_meters_for_port` at each bench phase start or hero AVG/LIVE TPS bleeds warmup into measured.
- **Telemetry tick:** Single constant `log_hub::TELEMETRY_TICK_MS` drives stderr batch flush, `fusion::brain` active `/slots` poll, and `FusionContext` `RENDER_INTERVAL_MS` — keep them synced (one knob). Currently **25ms** (~80 HTTP polls/s per active engine). 10ms was most reliable but heavy; 50ms is lighter if phase detection still holds.
- **Fusion adapters:** Per-provider metrics live in `src-tauri/src/fusion/adapters/` — set `spawn_profile.fusion_adapter` in factory JSON (`ggml_master` | `ggml_tom` | `ggml_quiet`). Per-slot KV/decode/prompt tracking lives in `fusion/slotstate.rs` (`SlotBank`); the frontend `FusionUpdate` contract + emit fingerprint + snapshot rehydrate cache live in `fusion/emit.rs`; pure hero TPS math in `fusion/meter.rs` (`session_avg_tps`, `per_slot_tps`). `brain.rs` remains the orchestrator + phase/log-handler. `ggml_quiet` = silent server (no stderr PP/TG logs); brain derives PP totals/progress from `/slots` peak `n_prompt_tokens` and opens the multi-slot TG window on decode-without-log signal. Custom providers: `customCapabilities.fusionAdapter`.
- **Runtime quiet toggle:** Silent models on a normal ggml-master provider (e.g. DS4) flip the live brain via the fusion-display `QUIET`/`LOGS` button → `set_fusion_quiet_mode(port, quiet)` → `BrainInbound::SetQuietMode` toggles `has_log_belt` + re-polls `/slots`. Persisted per model (`fusion.quiet.<model>` localStorage). Do not gate this on provider template — it is per-model. Tom uses stdout `PromptProcessingProgress` at `-lv 3`; brain skips `/slots` PP when `slots_expose_prompt_processed() == false`.
- **FIT adapters:** Per-provider `llama-fit-params` + learned VRAM in `src-tauri/src/fit_adapters/` — set `spawn_profile.fit_adapter`. Tom rejects `--fit-print`; use `projected to use N MiB` from `llama_params_fit_impl` (do not parse CUDA init VRAM lines).
- **FIT library cache:** `config/cache/fit_scan_full.json` is partitioned by `fit_adapter` (`ggml_master` | `ggml_tom`), not shared across providers. Legacy flat file migrates into `ggml_master` on first read.
- **Runtime profiles:** `frontier` (CUDA 13.3.x) + `stable` (12.8) only — `vanguard`/`fresh` migrate to `frontier` on load. Portable toolkit: `{app_root}/toolchain/cuda/v13.3` (slim via `strip-cuda-toolkit.ps1` from Program Files). Update-in-place is fine for toolkit bugfix builds (no new profile for 13.3 Update 1).
- **Live CPU MHz (HW monitor):** Registry/`Processor Frequency` stick at base on modern CPUs — use PDH `% Processor Performance` × WMI base. Cores open → hero shows live MHz; closed → usage %.
- **SWA / long-lived slots (Opencode):** TG detection must use **per-request** `n_decoded > request_start_n_decoded`, not `n_decoded > 0`. Parse `forcing full prompt re-processing` → PP. Slot may never idle between turns — also detect `id_task` change as `new_request`. Raw `n_decoded` from prior chat looks like TG during SWA re-prefill.
- **Agent burst micro-idle:** Opencode file-read cadence &lt;1s — don't `stop_request_clock` / IDLE / zero CTX on brief `/slots` idle; use `INTER_REQUEST_GAP_HOLD_MS` + `max(live, sessionNDecoded)` on bars.

---

## npm scripts (dev / release)

`tauri.conf.dev.json` has **no** `beforeDevCommand` — Vite and Tauri are separate. Do not re-couple them without an explicit reason.

### Dev

| Command | What it does |
|---------|----------------|
| `npm run vite` | Plain Vite on `127.0.0.1:1420` — browser/UI only (no Tauri IPC) |
| `npm run server` | Warm Vite (`:1421` internal → `:1420` proxy) — start before the app for fast WebView load |
| `npm run dev` | Tauri + Rust — **`--no-watch`** (manual Rust rebuild / restart after `.rs` edits) |
| `npm run dev:watch` | Same as old auto-rebuild on Rust file changes |

`npm run dev` still runs `predev` (`sync-dev-runtime.ps1`) — mirrors `src-tauri/runtime` → `target/debug/runtime` only when the source fingerprint changes (path/size/mtime). Use `npm run sync:dev-runtime:force` after foundry installs if the stamp is wrong.

**Typical workflow** — two terminals:

```bash
# Terminal 1
npm run server

# Terminal 2 (after server is up)
npm run dev
```

### Release

| Command | Frontend | Rust | Prerelease scripts | NSIS installer |
|---------|----------|------|-------------------|----------------|
| `npm run release` | ✓ | ✓ release | ✓ mirror + prepare runtime | ✓ |
| `npm run release:exe` | ✓ | ✓ release | ✗ | ✗ |
| `npm run build:exe` | ✓ | ✓ release | ✗ | ✗ (alias of `release:exe`) |
| `npm run build:rust` | ✗ (needs existing `dist/`) | ✓ release | ✗ | ✗ |

Release exe: `src-tauri/target/release/blackwell-ops.exe`. Run `npm run build` first if `dist/` is stale before `build:rust`.

---

## Tests (Rust)

`cargo test` → **110 pass / 0 fail** (all green). Note: two earlier failures were fixed by
making `model_file_cache_key` slash-normalize (`\`→`/`, key-only) and completing the qwen36
fixture's architecture line — see commit `125706b`.

**What the tests cover** (each lives in `#[cfg(test)] mod …` next to its code):
- `config.rs::merge_tests` — template↔user param merge, validation, dedup (the **largest**; validates live merge logic)
- `templates.rs::build_cmd_tests` — launch CLI assembly
- `provider_mgmt.rs`, `log_hub.rs`, `engine_stack.rs`, `model_catalog.rs`, `llama_catalog.rs`, `gguf_scan.rs`, `hf_api.rs`, `download_manager.rs`, `github_releases.rs`, `bench_cancel.rs`, `bench_prompts.rs`, `vram_learn.rs::dedup_tests`, `fit_scanner.rs::memory_breakdown_tests`/`cache_key_tests`, `launch_memory_parse.rs`, `spec_draft.rs`, `sidecar_elevate.rs`

**Stale / low-value (TO-DO: update later to be useful):** several of these modules were written by an agent and never requested — they may not reflect current behavior. In particular `config.rs::merge_tests` and `fit_scanner.rs::memory_breakdown_tests` exercise some helper-only code. Both are `#[cfg(test)]`-gated so they add **zero** warnings to `cargo build`. Keep them for now; a future pass should refresh them to assert real current behavior (or drop the ones with no value). Tests are **not** a gate for releases.

---

## Optional reference

`docs/FUSION-metrics.md` — fusion poller field names when working on metrics/TG-PP, if that file is still current.

`docs/VRAM-FORECAST-UI.md` — ASSISTED forecast / fusion overlay height traps, SOURCE+NEED chrome, GPU bank rows, config chip thumb wrap (gotchas only).

`docs/VRAM-FORECAST.md` — measured SOURCE model / probe law (backend product).

`docs/display-bezel-glass.md` — one glass bezel stack; fusion is not a second glass.

`docs/SELF-SUFFICIENT-INSTALL.md` — **read before touching `pi_code.rs`, `foundry_toolchain.rs`,
`runtime-distribution.ps1`, `pack-app-update.ps1`, or `majestic.ps1`.** What ships vs downloads
(App `.7z` ~5 MB / NSIS ~274 MB / toolchain ~1.15 GB), the lean pi-ext pipeline and the
`pi-coding-agent-shim` junction that broke extension resolution, why UPDATE PI is unsafe while a
session is live (it `remove_dir_all`s the running `pi.exe`'s own directory), the hash gate that
keeps daily app updates at 3 s, the pi pin gate, and the x64 MSVC CRT (`vcruntime140`,
`vcruntime140_1`, `msvcp140`) that every engine imports and that onboarding used to report green
without.