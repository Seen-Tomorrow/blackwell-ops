# AGENTS.md

Traps and invariants only — not a code map. Read the source for flows, schemas, and file layout.

**This file is the short law.** Mechanics, measurements, history and *why* live in
`docs/AGENTS-REFERENCE.md` under the same headings. Read that section only when a rule below is not
enough; everything here is a rule that costs real time or data when missed.

---

## No real users yet — never write migration code

- No persisted-state shims, legacy-key repair, `OBSOLETE_*` stripping, dual-read fallbacks,
  versioned up-converters or deprecation aliases — for configs, localStorage, catalog/learned files,
  templates, any on-disk format.
- Change the shape and let stale data be wrong; the owner resets config/cache locally, which is free.
- Existing shims (`Repair mtp_*`/`dflash_*`, obsolete spec-key stripping, migrate branches in
  `systemParams` / `EngineConfigPanel`) are **debt, not contracts**: delete them when you touch that
  area instead of extending them.
- Revisit this section only when the first real install ships.

## CRITICAL: never kill the running app

- **NEVER `Stop-Process` / kill `blackwell-ops` without explicitly asking first.** The running
  instance may be the REL build serving the engine that runs this session.
- A locked `blackwell-ops.exe` during `cargo build` (`Access is denied (os error 5)`) means an app is
  up: ask the user, or build to a separate target.
- **REL** = exe path contains `Blackwell OPS portable` → never kill. **DEV** = path contains
  `target\debug`. (`scripts/identify-app-processes.ps1`.)
- Closing DEV (only for a rebuild, after asking): `(Get-Process -Id <pid>).CloseMainWindow()` →
  exits 0. `Stop-Process -Force` leaves `0xffffffff` in the log and reads as a crash.
- There is **no** `npm run tauri`; the app runs via `npm run dev`.

## Where runtime data lives — git cannot see it

- **App root** = the folder holding `blackwell-ops.exe`, not the repo root:
  `src-tauri/target/debug/` in DEV, the portable folder in REL.
- `toolchain/`, `config/`, `runtime/` are gitignored, so `git grep` / `git ls-files` cannot see
  them. Absence from git is not absence from disk.
- `rg` honours `.gitignore`: use `git grep` for source and `rg --no-ignore <pat> <dir>` for artefacts.
- Never call a directory empty from a rounded size — list the files.
- `toolchain/` is a **runtime** dependency (CUDA runtime DLLs), not just a build input.
- Uninstall keeps `config\*.json`, `config\cache\`, `config\automation\`,
  `config\external-tools\pi-home\` and user models (`docs/UNINSTALL.md` is the contract). Never add a
  model path to the uninstaller's `RMDir` list.

## Line endings — LF everywhere

- Write UTF-8 / LF. `.gitattributes` pins `eol=lf`; only `*.bat` / `*.cmd` stay CRLF.
- Healthy: `git ls-files --eol <file>` → `i/lf w/lf`. `i/crlf` → `git add --renormalize`.
  `w/crlf` only → delete and `git checkout -- <file>`.
- A whole-file diff with no content change is that signature; never "fix" it by editing the file.
- After scripted writes, check for `\r\r`.

## CSS / themes

- Color lives in `src/themes/app-themes.ts` + `src/styles/tokens-base.css`; CSS/TSX **name** tokens
  only. Frozen set MATRIX / SLATE / ARCTIC × DOTTED / CLEAN — no new themes or `[data-theme]` forks.
- `var(--x, <literal>)` is a decoy, not defense. Non-color fallbacks written by JS at runtime are the
  idiom — do **not** strip those.
- Off-theme by decision: `--boc-*`, `--dev-danger*`, `--custom-flags-amber*`.
  `--theme-nv-green` / `--theme-telemetry-*` are aliases, not a third palette.
- Styles live in domain partials (`src/styles/*.css`); `src/index.css` is Tailwind + imports only, and
  `type-scale.css` stays last.
- Tailwind = layout only: no color utilities, no arbitrary `text-[Npx]`.
- `bg-black/NN` reproductions are face-unsafe; `/NN` alpha tails always
  `color-mix(in srgb, var(--x) NN%, transparent)`.
- A CSS comment must never contain `*/`. Gate: `node scripts/css-minify-gate.mjs`.
- `npm run css:audit` is in the gate. Two things fail it: a change to partial order, and source
  `!important` above 50. Treat its counts as a report, not a budget.
- An `!important` may only be removed with one of three proofs (out-specifies / tie → duplicate the
  class / only tool against an inline style).
- Never let a scripted CSS edit double the CR.
- **Before editing these areas, read `docs/AGENTS-REFERENCE.md` → CSS / themes** — `cfg-*` / `!important` /
  container-hook / `text-[Npx]` / shadowed-rule rules and their detectors live there.

## Product floor / layout density

- **1080p minimum (marginal), 1440p+ recommended, 4K optimal**; below 1080 is out of scope.
- Prefer **manual** density (GPU 2|3, ENG 2|3) over viewport auto-policies. Vertical space is the
  constraint; horizontal is fine.
- HW monitor: rail body scrolls, FULL/CMPT is its own header toggle (drop rows in JSX, never hide with
  CSS), OC panel is a header-triggered overlay in both placements.
- DEV tools (`VIEW`, `GPU+`) never ship in REL UX.

## DEV automation — attach, never start another

When the user says "use automation" (or asks for a UI check, a launch, a memory-log/bench action):
**attach to the DEV instance that is already running. Do not start another one.**

- **Check first:** `curl http://127.0.0.1:9222/json/list` (or `node scripts/ui-probe.mjs "1"`). DEV
  builds expose CDP on 9222 by default (`main.rs`, debug-only); if it answers, that is your app.
- **One owner for the port:** a second DEV window cannot bind 9222 and will talk to nothing. Two
  instances also duplicate the automation queue, so both would run the same job.
- **No port answering** = the running instance predates the default, or it is a REL build. Ask for
  one restart (`npm run dev`); never launch a parallel instance to get a port.
- **Closing DEV** (only when a rebuild is required, and after asking):
  `(Get-Process -Id <pid>).CloseMainWindow()`, which exits 0. `Stop-Process -Force` leaves
  `0xffffffff` in the log and looks like a crash.

The queue itself is DEV-only (`automation::spawn` returns immediately in release):

```powershell
python scripts/engine-test.py status                    # stack + slots
python scripts/engine-test.py launch --model <gguf> --ctx 65536 --hold 8000
python scripts/engine-test.py stop --slot 0
python scripts/engine-test.py snapshot                  # writes config/cache/nvram/snap-*.json
python scripts/engine-test.py ui --ui select-slot --slot 0   # fusion dashboard for that engine
python scripts/engine-test.py ui --ui memory-log --open      # memory log (auto-refreshes on capture)
python scripts/engine-test.py ui --ui bench-tray --open      # bench tray; bench-run-tg / bench-run-pp / bench-stop
```

Results land in `{app_root}/config/automation/results/<job>.json`; UI state in
`config/automation/ui/vram-badge.json`; snapshots in `config/cache/nvram/` and compare with
`blackwell-ops.exe --nvram-diff a.json b.json`. The `ui` commands drive renderer state through the
`automation-ui` event; a command that needs a running slot (e.g. `select-slot`) is cleared by the UI
when nothing is running, so launch first.

## Agent harness

- **Supported harness = pi only** (`pi_code`). Product surface is the neutral framework
  (`harness-*` CSS, `html[data-harness-open]`, `EVENTS.harness*`, `HarnessToolId = "pi"`); never
  product-brand class names. `external_agents.rs` stays.
- **Session roles:** this seat is the designer/planner. BRAIN thinks, WORKER does grunt work,
  Adviser (external) only when blocked.
- **Temp / debug / scratch → gitignored `tmp/`**, never the repo root; clean up after.
  **Commit only real source changes**, split per concern.
- **Never ship or run a PE built under a Low-stamped tree.** A workspace-write session stamps the
  workspace Low and the stamp outlives it; keep this workspace full-access, raise the root once
  after such a session (`icacls <root> /setintegritylevel Medium`) and rebuild. Symptoms: silent
  `os error 5` in `%TEMP%` (~15 `cargo test` failures), or a DEV webview dying with
  `0x800700AA`.
- **Do NOT commit TEMP-redirect / `/Z7` workarounds** for that stamp (they live in
  `git stash list` → `grok-lowil-workarounds`); they must never land.
- While a workspace-write session is live its ACEs **are** the confinement design: don't hand-edit
  them, don't `icacls /T`, don't elevate. Clear the stamp only after the session ends.
- Orphaned puppeteer Chromium: reap by path filter `*\.omp\puppeteer\*`; a bare
  `Stop-Process -Name chrome` is forbidden.
- Detail: `docs/AGENTS-REFERENCE.md` → Agent harness (incl. the `docs/windows-forensics.md` trail).

## Regressions to avoid (checklist)

- **Engine ports** — no port-based taskkill; launch uses
  `engine_port_lock::reclaim_our_ghost_or_fail`; teardown is PID-only.
- **Engine lifetime** — private Job Object (`KILL_ON_JOB_CLOSE`); never bare `AppHandle::exit`;
  startup runs `kill_orphans_of_dead_owners` + `sweep_stale_locks`.
- **App exit path** — `teardown_all_for_app_exit` → `finish_process_exit` →
  `std::process::exit(0)`; don't use `AppHandle::exit` / `destroy()` for process death.
- **`Instant - Duration` panics after reboot** (`0xC0000409`) — use `saturating_duration_since` /
  `checked_sub`; enforced by `repoInvariants.test.ts`.
- **`0xC0000409` can also be commit exhaustion** — read app stdout
  (`memory allocation of N bytes failed`) before blaming the GPU.
- **Tauri listeners** — `useTauriListen`, never raw `listen()` in `useEffect`.
- **Persistence** — new localStorage keys → `storage.ts`; new window events → `events.ts`; Tauri
  event names are backend-owned.
- **`is_process_alive`** — `PROCESS_QUERY_INFORMATION` only; NULL handle or
  `ERROR_INVALID_PARAMETER` = dead, `ERROR_ACCESS_DENIED` = alive.
- **Detached spawn** — never `CREATE_BREAKAWAY_FROM_JOB`; short-lived hidden children via the
  `CREATE_NO_WINDOW` helpers; `.cmd` via `cmd /d /s /c ""path""` + `raw_arg`.
- **Paths with spaces** — quote every token (`format_cmd_line`); never join without quoting.
- **Release identity** — Pack must never publish a DEV PE under a REL tag; channels are frozen
  (`docs/RELEASE-CHANNELS.md`); the client reads only `channel.json`.
- **Binary sources** — `binarySourcePerEnv` is the only ACTIVE pointer; the newest build id wins,
  never file mtime.

## Foundry paths

- `foundry/artifacts/<provider>/<profile>/Release/` is the only durable **runtime** binary location;
  provider `binary_path` must point there, never at `work/` cmake temp output. The `work/` CMake
  cache survives only while its fingerprint matches (miss, configure failure or CLEAR CACHE wipes it).
- **No binary mirror** — `src-tauri/runtime/<provider>/config/` holds factory templates only. DEV
  sync, `pack-provider-runtime.ps1` and `prepare-release-runtime.ps1` read artifacts directly; do not
  reintroduce a copy step.
- Foundry batches run via `cmd_script_launch` + `run_foundry_batch_streaming` (`raw_arg` tail), never
  plain `cmd /c path`.
- **Vendor patches track upstream HEAD** and are applied in filename order
  (`single-model-load-sse` → `telemetry-sse`). `npm run check:patches` verifies them in a throwaway
  `origin/master` worktree; a failed patch aborts Foundry configure (no silent unpatched build).
- Detail: `docs/AGENTS-REFERENCE.md` → Foundry paths.

## APP / engine logs

- Three consoles, never "the console": **BOC** (users, DEV **and** REL), the **Rust/Tauri console**
  (DEV stdout only), the **WebView console** (DevTools).
- User-facing status → BOC `utils`; developer tracing → `log::debug!` / BOC `debug`. Never `println!`
  a status line.
- A BOC change is not live until rebuild — `npm run dev` is `--no-watch`.
- Session files: `{app_root}/config/logs/sessions/session-*/` (last 25 kept); crashes append
  `%TEMP%\blackwell-crash.log`.

## Provider config merge

- `merge_template_for_provider` syncs structure from factory templates; user-owned fields
  (`hidden`, `order`, `userAddedValues`, `hidden_values`) must not be overwritten. Bump
  `templateVersion` when shipping param changes.
- Spec profiles are template-owned; launch flattens them to CLI keys (`buildSpecCliExtraParams`),
  never raw profile keys. Hidden `mtp_*` / `dflash_*` must not reach the CLI.
- Protected groups are flag-driven (`protectedGroups`), not name-hardcoded. Do not invent CLI keys
  absent from the provider param list.

## Known gaps / flags

Read `docs/AGENTS-REFERENCE.md` → Known gaps / flags before touching: fusion telemetry (SSE primary, **one brain per engine**), the
54 ms PP calibration, PCIe/NVML caching costs, memory junction absent from NVML, the 25 ms telemetry
tick, quiet-stderr loads, GPU "external apps", FIT adapters + library cache, runtime profiles
(`edge` / `stable`), CPU MHz, SWA slots.

## npm scripts

- `npm run dev` = `tauri dev --no-watch --config src-tauri/tauri.conf.dev.json`; no
  `beforeDevCommand` (Vite is separate) and it must run in the **foreground**.
- Crate graph and compiler are pinned: every direct cargo call passes `--locked`. `tauri build`
  cannot, so `check:lock` runs before `build:exe` / `release`.
- Everything else is in `package.json`.

## Tests

- **`npm run check` is the one command**: `css:audit` → `css:minify` → `tsc --noEmit` → vitest →
  `cargo test`, ~15 s warm. Run it instead of the parts.
- **Invariants only**: no snapshots, no assertions on exact user-visible strings or tooltips, no
  tests that mirror an implementation.
- `src/lib/repoInvariants.test.ts` scans tracked files (UTF-8, no mojibake; no `Instant - Duration`
  outside tests). Fix the source — never widen the allow-list.
- **IPC field contract**: after changing a registered type's field, run
  `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored regenerate_ipc_wire_keys`, then fix
  the TS interface.
- `lint:dead` / `lint:dead:rust` are opt-in and never gate.
- Detail: `docs/AGENTS-REFERENCE.md` → Tests (why text scanners lie, the no-runtime-seam rule, CI).

## Release-build process spawn (CRITICAL)

- Windows **release** builds wedge on `tokio::process` + `CREATE_NO_WINDOW`: short-lived hidden
  subprocesses use **`std::process`** with explicit stdio + `creation_flags(CREATE_NO_WINDOW)`.
  Engines are the exception (their stdio goes to `log_hub`).
- **CI is tests only**; releases ship locally via `majestic` (bump → pack → ship). Ship runs both
  suites before touching GitHub; pack stays ungated on purpose.
- `cargo test` cannot build a clean checkout (gitignored resource dirs) — CI fabricates empty trees,
  which is why no hosted runner can build the installer.
- `CARGO_NET_GIT_FETCH_WITH_CLI` must be `true`, never `1`.
