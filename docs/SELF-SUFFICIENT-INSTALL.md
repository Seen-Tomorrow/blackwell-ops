# Self-sufficient install — what ships, what downloads, what must be true

Memo for humans and agents. The product position: **ship one small exe; the app rebuilds its own
ecosystem.** A user needs internet and nothing else — no pre-installed Python, no Node, no Visual
Studio, no CUDA toolkit, no pi, no admin rights for the app itself.

If you are changing anything in `pi_code.rs`, `foundry_toolchain.rs`, `runtime-distribution.ps1`,
`pack-app-update.ps1`, or `majestic.ps1`, read this first. Most of what follows is the answer to a
question that was already asked once and got the wrong answer.

---

## One-line model

**The exe is the seed. Everything else is downloaded, verified, and self-healed into `{app_root}`.**

`app_root_dir()` = `current_exe().parent()` (`src-tauri/src/config/paths.rs`). Config, cache,
`runtime/`, `toolchain/`, `foundry/`, `pi-home/`, `pi-ext/`, `external-tools/` all hang off it.
There are **no** hardcoded `C:\` / `D:\` paths in live code — every literal in the tree is inside
`#[cfg(test)]` fixtures. That is what makes the flash-disk story work, and it is an invariant, not
a coincidence.

---

## Payload table (measured, v1.0.65)

| Artifact | Size | Contains | Source |
|---|---|---|---|
| **App `.7z`** (`CORE_Blackwell-Ops-App-*.7z`) | **~5.0 MB**, 6 files / 14 entries | `blackwell-ops.exe`, `runtime/*/config` factory templates, `runtime-catalog/`, `bin/7z.exe`+`7z.dll`, `foundry/patches/*.patch`, **`pi-ext/` when its hash changed** | `scripts/pack-app-update.ps1` |
| **NSIS Full setup** | not built this session | above + `runtime/` engine binaries (+ CRT, see below) | `prepare-release-runtime.ps1` → `tauri.conf.json` resources |
| ↳ `runtime-bundle/` staged | **273.6 MB** | engine binaries + configs + plugin catalog | `prepare-release-runtime.ps1` — **staged size, not installer size** |
| **Toolchain** (`toolchain.7z`) | **~1.15 GB** → **4.3 GB** unpacked | `vs/` 1.7 G, `cuda/` 2.3 G, `Windows Kits/` 381 M, `cmake/` 57 M | `majestic -Mode ship-toolchain` |
| **pi** (`pi.exe`) | ~104 MB | compiled bun binary | downloaded at runtime from GitHub releases |
| **pi-ext** (`pi-subagents`) | **7.85 MB / 1171 files** → **1.25 MB 7z** (`-mx=9`) | extension + 4 runtime deps | npm, refreshed by UPDATE PI |

**Be explicit with users about the 1.15 GB.** The app is calculator-sized; first onboarding is not.
The toolchain is a hard gate in `SetupGuideDisplay.tsx` — `FINISH SETUP` is
`disabled={!driversConfirmed || !runtimeReady}`.

---

## The lean bundle (pi-ext)

`pi-subagents` from npm is **143 MB / 1945 files**. It ships at **7.85 MB / 1171 files** →
**1.25 MB** compressed (`-mx=9`) — roughly a quarter of the 5 MB App pack. Three stages, all in
`src-tauri/src/pi_code.rs`:

1. **`SUBAGENTS_RUNTIME_DEPS`** — allowlist `acorn`, `jiti`, `typebox`, `yaml`. `acorn` is required
   by `src/workflows/scripted-workflow.ts` (the workflow-script parser); it is easy to miss and the
   first version of this list got it wrong.
2. **`prune_bundle_node_modules()`** — rebuilds `node_modules` to the allowlist only.
3. **`prune_bundle_dead_files()`** — strips `.d.mts` / `.d.ts` / `.d.cts` / `.map`, then removes
   emptied dirs (looped to fixed point, **never follows symlinks**). 1945 → 1171 files.

Why this is safe: **pi 0.84.3 is a compiled bun binary.** The provider SDKs
(`@anthropic-ai/sdk`, `openai`, `@aws-sdk/client-sts`, `@google/genai`) are inlined into `pi.exe` at
its build time. Extension-side copies of those SDKs were unreachable dead weight.

`typebox` is 690 of the 1171 remaining files — half the file count is one dep. Windows creates
~24k files/sec, so a full 1945-file extract is 0.081 s via 7z (1.24 s via raw recursive copy).
**File count is not a bottleneck; do not optimize for it again.**

### User-installed extensions survive all of this

`pi install npm:<pkg>` lands in `{home}/npm/` as a **separate module root**.
`build_models_and_settings()` union-merges `packages` from `settings.packages`, so `pi-blackhole`,
`pi-observational-memory` etc. are untouched by prune, strip, or app update. Do not "clean up"
that union.

---

## The junction bug that started it (do not reintroduce)

`refresh_pi_subagents_bundle()` copied npm output including a **dangling junction to
`@earendil-works/pi-coding-agent-shim`** — an upstream *devDependency* fixture that is not in the
published tarball. That junction **shadowed pi's own bundled core packages**, so Node resolved the
extension against the wrong core. Symptom: an extension-load error naming a file that plainly
exists.

`strip_shadowed_pi_core_modules()` removes symlinks / junctions / dangling entries and any
`pi-coding-agent-shim` target under `node_modules/@earendil-works`. It is called **self-healing,
before the version-stamp early-return** in `sync_bundled_subagents()`, so every session launch
repairs a broken install with no reinstall and no rebuild.

**Unrelated, pre-existing:** `Background-work snapshot sessionId must be at most 256 characters`
from `src/runs/shared/subagent-prompt-runtime.ts`. Proven present in sessions started 13:28 and
14:23 — *before* any of this work — and it never reproduced in dedicated probes. Correlates with
the detach/intercom path (`snapshotBackgroundWork` receiving an over-long session id), not bundle
contents. Separate investigation; not a regression.

---

## UPDATE PI — unsafe while a session is live

`pi_code_update_latest()` → `install_pi_version()` does:

```rust
let dest_pkg = package_dir();          // {app_root}/external-tools/pi/pi
if dest_pkg.exists() { std::fs::remove_dir_all(&dest_pkg) }   // ← the live pi.exe lives here
```

`sync_dev_pi_ext()` likewise does `remove_dir_all(target/debug/pi-ext)` — the tree a running
session's extension resolves from. On Windows a running image cannot be deleted: best case the
update fails with a sharing violation **after** the ~104 MB download; worst case Windows defers
the delete and you get a partially replaced package with a live session on a binary whose
docs/assets vanished.

Two layers now refuse it:

- **Backend** — `running_pi_consoles()` (`sysinfo`) matches **name `pi.exe` AND an exe path under
  `package_dir()`**. Canonicalised prefix match, so a pi installed elsewhere on the machine is
  correctly *not* counted. `pi_code_update_latest` refuses **before downloading anything**, naming
  the PIDs and the directory at risk. Backend-side so no caller or retry path bypasses it.
- **Frontend** — UPDATE PI probes `pi_code_console_running` first and shows a *"Close pi before
  updating"* modal. **`"I have closed it" re-probes** rather than trusting the click. If the probe
  itself errors we fall through and let the backend guard decide, so a broken probe cannot wedge
  the update permanently.

Reuses `harness-confirm-overlay` / `-modal` / `-actions`. **No `backdrop-filter: blur`** — dim
only, per the compositor rule in `AGENTS.md`.

After a successful update: `refresh_pi_subagents_bundle()` runs the lean pipeline, then
`sync_dev_pi_ext()`. pi-ext is refreshed and re-leaned automatically. **pi-ext tracks npm `latest`,
not pi's version** — if pi bumps and pi-subagents hasn't released, you re-copy the same version,
harmlessly, and the pack hash stays identical.

---

## Hash-gated pi-ext in App-only

`pack-app-update.ps1` stages `pi-ext/` only when a content hash
(`.majestic-out/pi-ext.hash`, gitignored) differs from the previous pack.

| Scenario | Result |
|---|---|
| pi-ext unchanged since last pack | `SKIP` → App pack stays ~5.0 MB / ~3 s update |
| pi-ext changed (pi-subagents released) | staged → ~6.2 MB, once |

Measured: pack 1 staged, pack 2 skipped, and a deliberate content change was detected. Deterministic
hash. So daily app updates keep the 3-second profile, and the extension payload rides along only on
the days it actually changed — which is roughly once a month.

---

## MSVC C runtime — the dependency that was invisible

**Every shipped engine binary imports the x64 MSVC CRT.** Verified with
`dumpbin //DEPENDENTS` over all 40 `.dll`/`.exe` under `runtime/`. The complete surface is exactly:

```
40 VCRUNTIME140.dll
30 VCRUNTIME140_1.dll
30 MSVCP140.dll
```

No `concrt140`, no `vccorlib140`, no `_threads` variant. **714 KB raw / 176 KB 7zipped.**

Nothing bundled them and NSIS never installed a redist, so on a machine that never had
VC++ 2015-2022 x64 the engine died at `LoadLibrary` with a raw Windows *"MSVCP140.dll was not
found"* dialog and **not one line of engine log** — indistinguishable from an app bug. Invisible in
DEV because BuildTools puts the CRT in System32.

**It was already inside the toolchain** (32 CRT DLLs under `toolchain/vs/*/VC/Tools/MSVC/*/bin/`)
and still did not work: `apply_portable_cuda_to_command()` put **only CUDA bins** on PATH, and
`check_runtime_ready()` checks cublas/cublasLt/cudart **only** — it has no idea the CRT exists.
Onboarding could report fully green while the CRT was unreachable.

### Resolution order (foundry_toolchain.rs)

**app-local beside the exe → portable toolchain → System32.**

App-local wins the OS DLL search order. PATH is an **addition, never a substitute**, so a stale
toolchain copy cannot shadow a newer system CRT. A **partial** app-local set counts as absent —
half-staged is exactly the silent-death case.

- `MSVC_CRT_DLLS`, `msvc_crt_present()`, `msvc_crt_missing_message()`, `apply_msvc_crt_to_command()`
- Wired into **both** launch paths: piped (`engine_stack.rs`) and batch/NoBSproof
  (`PortableCudaEnv.path_prefix`)
- `ToolchainInstallInfo` gained `msvc_crt_ready` + `msvc_crt_error`, surfaced in the toolchain panel
  in **both** onboarding and full views — deliberately **not** gated behind `all_ready`, because
  CUDA can be green while the CRT is missing.

### Why app-local and not `vc_redist.x64.exe`

| | Bundle 3 DLLs | Enforce redist |
|---|---|---|
| Download | **176 KB** | 17.9–24.4 MB |
| Admin / UAC | none | **yes** |
| Reboot | never | occasionally |
| System mutation | none | machine-global |
| Works offline from a flash disk | ✅ | ❌ |

The redist also refuses with **1638** when another app already registered a different CRT version —
which converts every Steam and Adobe install into our support queue. App-local touches nothing.

Staging lives in `scripts/runtime-distribution.ps1`:
`Find-MsvcCrtSourceDir` (prefers the portable toolchain, newest toolset first, then local
BuildTools) and `Install-MsvcCrtIntoDirs` (copies the 3 DLLs into every dir holding a
`llama-server.exe`).

- `prepare-release-runtime.ps1` stages into the NSIS bundle after the profile copy.
- `prepare-release-app-only.ps1` needs **nothing** — it ships config only, no engines.
- `sync-dev-runtime.ps1` stages **before the fingerprint early-exit**. The CRT is not part of the
  runtime source fingerprint, so a skip-copy day would otherwise leave the debug tree without it.
  Non-fatal in DEV; idempotent (18 files = 3 × 6 profiles, stable across runs).

### Three traps when touching this code

1. **Layout is `{toolchain}/vs/{vsYear}/VC/Tools/MSVC/{msvcVersion}/bin/Hostx64/x64`.** Note the
   extra `vs` level, and that `vsYear` is a **key** (`2022` / `2026`), not a version dir. Globbing
   the toolchain root probes `cuda/` and `Windows Kits/` instead and **silently misses** — it looks
   like a fallback worked.
2. **`Get-ChildItem -Recurse` follows junctions.** Same hazard `sync-dev-runtime.ps1` documents for
   pi-ext. Walk the known two levels (`runtime/{provider}/{profile}/`) instead.
3. **`apply_msvc_crt_to_command` must merge into the command's PATH, never replace from the parent
   process.** Launch order is `apply_portable_cuda_to_command` (sets child PATH to portable
   `cublas`/`cudart` bins) then CRT fallback. Reading only `std::env::var("PATH")` and
   `cmd.env("PATH", …)` wipes those CUDA bins. Symptom on a clean test machine: raw Windows
   *"cublas64_13.dll was not found"* with no engine log — looks like missing toolchain even when
   `toolchain/cuda/v13.3/bin/x64` is present. App-local CRT early-return hides the bug on machines
   where staging worked; the PATH-fallback branch is what breaks isolation. Regression test:
   `apply_crt_preserves_command_cuda_path`.

---

## pi pin — the release binary embeds it, and nothing used to validate it

`pi-pinned-version.txt` is compiled in via `pi_code::PINNED_VERSION` (`include_str!`), and
`pi_code_install` **falls back to that pin when no version is given**. A stale pin therefore makes a
fresh REL install download a pi that was never tested.

Only `majestic -Mode bump-pi` writes it, and nothing validated it: `Invoke-MajesticCheck` never
looked at pi. Packing straight after a pi update reported READY and shipped the old pi. Found while
checking the never-run `bump-pi` path — DEV was at 0.84.3 with the pin still at 0.84.2.

`Invoke-MajesticCheck` now compares `Read-PiPinnedVersion` against `Get-DevPiInstalledVersion` for
**both** variants and folds the result into `$ready`. Not a warning — **NOT READY**, naming both
versions, the consequence, and the fix.

**A missing DEV pi is a warning, not a failure.** A clean checkout cannot be pinned and that must
not block an unrelated pack. A *present but mismatched* pi is a hard gate.

Byte format matters: **no BOM, no trailing newline** — `include_str!` reads it verbatim.

Distribution tab has two adjacent buttons with different effects: **BUMP** (app patch version) and
**BUMP HARNESS** (`bump_pi` → majestic `-Mode bump-pi`). Easy to press wrong.

---

## Release ritual

```powershell
# 1. Close the pi console window (UPDATE PI refuses while one is live)
#    Harness connect → UPDATE   → pi + pi-subagents + lean pipeline + sync_dev_pi_ext
# 2. Launch a session — sync_bundled_subagents self-heals and re-stamps pi-home
# 3. Pin what you tested
npm run majestic:bump:pi          # or Distribution tab → BUMP HARNESS
# 4. Check — now refuses READY on a stale pi pin
npm run majestic:check
# 5. Pack + ship (Distribution tab, or)
npm run majestic:pack:app ; npm run majestic:ship
```

`majestic.ps1` modes: `check`, `bump`, `bump-pi`, `pack -Variant app|full`, `ship`,
`ship-toolchain`, `pack-provider`, `ship-provider`.

---

## Invariants

- **No absolute paths outside `{app_root}`** in live code. `app_root_dir()` is the only root.
- **`pi-ext/`, `runtime-bundle/`, `bin/git/`, `*.dll` are gitignored** — generated artifacts fetched
  by Harness UPDATE / Foundry / npm. Do not commit them. Reproducibility lives in the version
  stamps (`.blackwell-version`, `pi-pinned-version.txt`, `pi-ext.hash`), not in tracked copies.
- **`strip_shadowed_pi_core_modules()` + `prune_bundle_*` stay non-fatal at launch.** They run
  inside `pi_code_launch`; a filesystem hiccup must never block an agent session from starting.
- **The CRT allowlist is measured, not guessed.** If a future llama.cpp starts importing
  `concrt140`/`vccorlib140`, `MSVC_CRT_DLLS` is stale and app-local staging will not save the
  launch. `crt_tests::crt_allowlist_is_the_measured_surface` pins the current shape on purpose.
- **`majestic:check` must stay a real gate.** Adding a first-run dependency without adding its
  check means onboarding goes green while the product is broken.
- **Never `Stop-Process` the app** (see `AGENTS.md`). Same spirit applies to UPDATE PI: the *update*
  is the thing that must not run while a session is being served.

---

## Verification commands

```powershell
# Complete CRT import surface of every shipped engine binary
dumpbin //DEPENDENTS src-tauri\runtime\ggml-master\frontier\ggml-cpu.dll | findstr /i "vcruntime msvcp"

# Zero unsatisfied CRT imports (the check that actually matters)
# — sweep every engine dir, compare imports against app-local files

cd src-tauri ; cargo test --bin blackwell-ops          # 209 pass
npx tsc --noEmit
powershell -File scripts\majestic\majestic.ps1 -Mode check -Variant app
powershell -File scripts\majestic\majestic.ps1 -Mode bump-pi -DryRun
```
