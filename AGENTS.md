# AGENTS.md

Traps and invariants only — not a code map. Read the source for flows, schemas, and file layout.

---

## CRITICAL: never kill the running app

**NEVER `Stop-Process` / kill `blackwell-ops` without explicitly asking the user first.**
The running instance is frequently the REL build serving the LLM engine that runs the agent
session itself — killing it kills the session. A locked `blackwell-ops.exe` during `cargo build`
(`Access is denied (os error 5)`) means REL is up: ask the user to close it, or build to a
separate target. A full app restart is the only exception — still confirm first.
(There is **no** `npm run tauri` script; the app runs via `npm run dev`.)

**REL vs DEV, by exe path** (`scripts/identify-app-processes.ps1`):
- **REL** = path contains `Blackwell OPS portable` → serves the engine/session; **never kill**.
- **DEV** = path contains `target\debug`.

---

## CSS / themes (frontend)

**Themes law** — Color lives in `src/themes/app-themes.ts` + `src/styles/tokens-base.css`. CSS/TSX only *name* tokens. To recolor an element: grep the class → if it’s a `var(--token)`, edit the token (all three themes, or base if shared); if it’s a hex, that site is the source of truth until someone wires a token. Frozen set: MATRIX / SLATE / ARCTIC × DOTTED / CLEAN. Do not add themes, faces, `[data-theme="…"]` forks, or `var(--x, #hex)` “just in case.”

**`var(--x, <literal>)` fallbacks are a decoy, not defense** — if the token is undefined there the
literal *is* the paint and the theme switch silently does nothing; if defined it is never read and only
pollutes a hex grep. Meter: `python scripts/fb-triage.py` (`DEAD` / `DEAD-CHAIN` unreachable → strip to
`var(--x)`; `DEAD-FLAT` base literal never switches; `LIVE-LITERAL` = token undefined, the literal
paints on **every** face → always fix). Face presence is read off `app-themes.ts` only, so a token
themed via a `[data-theme]` CSS block is mislabelled — `LIVE-LITERAL` is the one category whose
conclusion does not depend on that.

**Non-color fallbacks are the JS-runtime idiom — do NOT strip them** — `var(--seg-thumb-width, 0px)`, `var(--device-pixel-ratio, 1)`, `var(--bench-control-row-h, 18px)` and ~143 siblings are not decoys: the token is written at runtime by JS (`style.setProperty`) and the CSS literal is the documented pre-JS default, so removing it would break layout before the first measurement, not "clean a shadow". `scripts/fb-triage.py` matches hex / `rgba()` only and therefore ignores these, plus nested `var(--a, var(--b))` (184 sites, which still theme-switch). Target state is zero hex/`rgba()` fallbacks; a non-zero count of these two families is expected forever.

**Deliberately off-theme — do NOT theme these** — owner verdict 2026-09-03, recorded so nobody
re-litigates: `--boc-*` (ops output console) and `--dev-danger*` (DEV-only chrome) stay fixed;
`--theme-nv-green` and `--theme-telemetry-*` are legacy **aliases**, not a third palette — point them at
`--theme-accent` / `--theme-tel-*` / `--theme-secondary-bright`; `--custom-flags-amber*` is fixed
product amber (`--theme-tel-amber` is the themed variant — do not invent another). ARCTIC-only tokens
are not a bug: dark defaults live in `tokens-base.css`, ARCTIC overrides them. Never copy ARCTIC ice
onto MATRIX/SLATE; a token missing from base needs the **dark** default, not the light one.

**Domain partials** — Styles live under `src/styles/*.css`; `src/index.css` is Tailwind + `@import` only. Edit the matching partial (chrome, cockpit, fusion-display, config, launch, …).

**`cfg-mut` / `cfg-bord` / `cfg-acc` are room-role vocabulary, not drift** — owner decision 2026-09-03; do NOT "fix" them into per-element surface classes (rejected: churn across hundreds of sites, zero gain). A site resolves to a ROLE — muted ink, hairline border, accent text — inside the Config room, all defined in `src/styles/config-params.css`, so one edit re-tones the whole room coherently. That is the trade being made: the blast radius spans many files and is **not** readable from the rule, so grep the class before editing and treat it as a room-wide change. When a single element must diverge, add a narrow surface class beside the family.

**Tailwind = layout only** — no Tailwind **color** utility and no arbitrary `text-[Npx]` in TSX/TS
(migration closed 2026-09-03; meter: `python scripts/tw-census.py` → paint 0 / px 0). Paint lives in
named surface classes inside the partials, so "grep the class → change the color without opening TSX"
keeps working. Named sizes (`text-xs` … `text-2xl`) stay — they carry `line-height`. The `stealth` /
`nv` / `telemetry` / `theme` color maps are physically **gone** from `tailwind.config.js`: a new color
utility compiles to nothing instead of painting.

**Container corrections must not match utility names** — pre-migration CSS repaired bad hues with
selectors like `[data-config-page] .text-yellow-400\/70`. Deleting the utility kills the correction
**silently**: no build error, one wrong color on one face. Correct shape: (a) re-scope the semantic
token on the container — valid ONLY when the old hook corrected *every* property that token drives in
that subtree — or (b) a **property-scoped class list** (`[data-model-hub] .cfg-acc… { color: … }`) when
the hook was text-only and the token also paints fills/borders there. Detector:
`python scripts/hook-check.py` (diffs hook lists against `a38f23abf`; require `broken=0`).

**`bg-black/NN` reproductions are face-unsafe** — `color-mix(in srgb, var(--theme-panel) 25%, black)` renders **charcoal on ARCTIC paper** (`--theme-panel` is `#ffffff` there). Face-correct inset fill: `color-mix(in srgb, var(--theme-text) 6%, var(--theme-panel-accent))` — see `.fnd-cache-row`.

**`/NN` alpha tails never fold onto the plain token** — write `color-mix(in srgb, var(--x) NN%, transparent)` with the exact percentage (no `rgba()`, no hex). Folding turned hairlines into hard borders once already. Literal hex stays legal for **data**, not chrome: ANSI terminal output, GPU swatches, the VRAM forecast bar ramp (`badges.css` `.bar-need--*`), MoE gold.

**CSS comment must never contain `*/`** — a class glob in prose (`text-*/60`) terminates the comment
early and the leftover parses as a selector. **postcss accepts it**, so DEV and scratch parsers look
fine and only `vite build` fails (`[lightningcss minify] Invalid empty selector`). Gate:
`node scripts/css-minify-gate.mjs`.

**Type scale is the LAST `@import`** — `src/styles/type-scale.css` must stay last in `src/index.css`
(immediately before `@tailwind`): `.type-*` replaces Tailwind `text-[Npx]`, which was emitted after
every partial and therefore won every same-specificity tie; declaring the scale earlier lets later
partials (`value-chip`, `fnd-*`, `config.css`) silently resize migrated text. Related trap: `chrome.css`
keys some font-size overrides on the **literal utility name** (`.foundry-window .text-\[9px\]`, a
compact-density `.config-spec-decoding ~ div.text-\[8px\]`) so Foundry text follows `--foundry-scale`.
Swap the class and the override stops matching — text shrinks in that container. When removing a
`text-[Npx]`, grep `text-\\[` in `src/styles/` and re-key every hit onto the matching `.type-*` selector
(keep the utility selector for unmigrated rooms).

**Removed modules** — Mobile Sentinel Bridge (`mobile_bridge.rs`, WebSocket `0.0.0.0:3814`, `tokio-tungstenite`) is fully removed — backend and UI. Do not revive it.

**Industrial display (bezel / glass)** — One glass only: frame pad = metal, `.phosphor-screen-inner` = full face + unified recess shadow, children = content (no nested phosphor surface). HW monitor widgets use the same face (`.launch-rail-tel .phosphor-display-surface`). Do not revive `DisplayGlitchOverlay` / `.display-glitch-*`.

**No `backdrop-filter: blur` (or `-webkit-backdrop-filter: blur`)** — Modal/scrim overlays must **dim only** (semi-opaque `background`, e.g. `color-mix(in srgb, #000 60%, transparent)`). Blur forces continuous full-compositor work in WebView2 and pegs the **iGPU at ~100%** for as long as the overlay is open (harness confirm, etc.). Prefer stronger dim over blur. Do not reintroduce blur for “frosted glass” aesthetics without an explicit exception.

**Vite/Rolldown barrel re-exports** — Never mix `type` into a value re-export list:
`export { type Foo, bar } from "./x"`. Vite 8 / Rolldown can emit an **empty module** (only a sourcemap):
black WebView, DevTools `Uncaught SyntaxError`, while `tsc` / `npm run build` stay clean. Split:
`export { bar } from "./x"` + `export type { Foo } from "./x"`. Sanity-check a suspect URL:
`curl http://127.0.0.1:1420/src/.../file.ts` must show real `export { ... }`.

**WebView2 module cache** — After a bad transform (empty barrel, half-HMR), F5 / Vite restart / rebuild
may still black-screen: Chromium caches the broken JS under
`%LOCALAPPDATA%\com.blackwell-ops.app.dev\EBWebView\Default\` (`Cache`, `Code Cache`, `GPUCache`,
`Service Worker`). Clear those folders (close the DEV window first if locked), then reload. REL profile
is `com.blackwell-ops.app`. **Not** localStorage — wiping storage keys will not fix a cached module.

**VRAM forecast is measured-only** — No GGUF formula path. Paint sources `LEARNED` / `LEARNED≈` /
`FIT PROBE` only (`src/services/vram/forecast/`, default adapter `ggml_master`); `evaluate()` returns
`null` → skeleton until probe/learned lands. `scenarios/scenarios_factory.ts` is a thin compat re-export
only. Formula evaluators (`auto_fit` / `hw_locked`) and old scenarios live under gitignored
`tmp/archive_vram_formula/`, never imported. **One** ASSISTED forecast glass: `VramBadge` is the shell
(ASSISTED cluster or fusion fill), height lives in `EngineGpuForecast` — no second FULL AUTO UI;
`EVALUATING` copy is pre-manifest only. Library FIT tensor is usually noΔ (`Meta` ≈ none): do not
`Meta`×N fit-print; the layer tax from a library Δ is real. Law: `docs/VRAM-FORECAST.md`.

---

## Product floor / layout density

**Supported viewports** — **1080p minimum (marginal)**, **1440p+ recommended**, **4K optimal**; below
1080 is out of scope. Vertical space is the constraint; horizontal is fine. Prefer **manual** density
(display bezel **GPU 2|3** / **ENG 2|3** cards-per-row) over auto viewport policies. HW monitor: GPU
stack scrolls; OC panel stays pinned above launch dock.

**DEV tools (header)** — `VIEW` = physical panel presets + live Windows scale (app zoom 100% when testing). `GPU+` = fake multi-GPU topo (real SKU names/VRAM) for layout + forecast stress — session only. Do not ship these in REL UX.

---

## Agent harness

**Supported harness = pi only** (`pi_code`). Product surface is the neutral agentic harness framework:
`harness-*` CSS, `html[data-harness-open]` / `data-harness-wizard`, `--theme-harness-brain-*` /
`--theme-harness-worker-*`, `EVENTS.harness*`, `HarnessToolId = "pi"`. `external_agents.rs` **stays**
(`pi_code.rs` + `download_manager.rs` depend on it). Future harness tools plug into the same chrome +
`HarnessToolId`, never product-branded class names. pi models.json: per-seat **`input: text|image`**
only when that engine launched with **`--mmproj`** (`stack.vision`); BRAIN and WORKER are independent.

**Session roles (local stack)** — this seat is the **designer/planner**. **BRAIN** = thinking model
(design, planning, hard reasoning); **WORKER** = fast non-thinking grunt (mechanical edits, lookups,
bulk work); **Adviser** = external Claude / Grok escalate. Route grunt work to WORKER, keep
design/judgment here, escalate only when blocked.

**Temp / debug / scratch files → gitignored `tmp/`** (repo root), never the repo root or a tracked
path; clean up afterwards. **Commit only real source changes**, split per concern (feature / fix /
theme).

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

**Only facts `package.json` cannot tell you** (do not restate the script table — it rots):

- `tauri.conf.dev.json` has **no** `beforeDevCommand` — Vite and Tauri are deliberately separate. Do not re-couple them without an explicit reason.
- `npm run dev` is `--no-watch`: after a `.rs` edit you rebuild/restart manually. `dev:watch` is the auto-rebuild variant.
- **`npm run dev` MUST run in the foreground** (two terminals: `server`, then `dev`).
  Launched via `Start-Process -WindowStyle Hidden` the app fails to initialize correctly —
  observed, mechanism not identified in this app (registered Tauri plugins are only
  `shell` + `updater`; there is no MCP/WebSocket bridge plugin to blame).

---

## Tests (Rust)

Run `cargo test` from `src-tauri/`; each module's tests live in `#[cfg(test)] mod …` beside its code.
`config.rs::merge_tests` (template↔user merge) is by far the largest — run it after any
`merge_template_for_provider` change.

---

## Release-build process spawn (CRITICAL)

Windows **release** builds wedge on `tokio::process` + `CREATE_NO_WINDOW`: `ERROR_INVALID_HANDLE`
(os error 6), or a child that exists with zero output forever. Short-lived hidden subprocesses use
**`std::process`** with explicit stdio (`Stdio::null()` / `piped()`) + `creation_flags(CREATE_NO_WINDOW)`
— see `engine_utils::apply_create_no_window`, `fit_scanner::run_fit_process_blocking`,
`reactor_foundry.rs:433`, and `telemetry.rs:511` (nvidia-smi needs `piped()`, `null()` returns fallback).
Engines are the exception: `engine_stack.rs` pipes stdout/stderr into `log_hub`.

**No lint/CI configured** — `npm run build` is `tsc && vite build`; Rust tests via `cargo test`.
