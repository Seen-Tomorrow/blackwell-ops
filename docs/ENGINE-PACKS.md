# Engine packs and the installer seed

Design + phase-1 diff. **v3.1 — 2026-10-25, supersedes v3/v2.1/v1.** PR 1 (NSIS `lzma` + installer
seed assertion) and PR 2a (driver gate) are landed; see §14. Adds the driver nudge (§0.1) and puts
3-arch engines on the roadmap (§3).

v1 said "ship no engine in the installer". That was wrong for this product: an empty app cannot
finish onboarding (the GGUF scan spawns `llama-server`, which needs the CUDA runtime), and it makes
the first-run download the *only* thing standing between the user and a working app. v2 keeps the
**EDGE engine in the installer as a seed** and pulls only the CUDA runtime in the wizard.

All sizes measured on the 2026-10-25 3-arch build. Compression ratios are real `7z -mx=7` runs,
runs, not guesses; see §13 for the commands.

---

## 0. Decision

| Artifact | Contents | Delivery |
|---|---|---|
| **NSIS installer** | app shell + `bin/` + **`ggml-master/edge` seed** | one download, compressed |
| **CUDA runtime pack** | 3 DLLs for one CUDA version | wizard, mandatory for whichever profile the driver supports |
| **Engine pack** | one provider/profile | updates, repair, STABLE, forks |
| **Build pack** | VS + SDK + cmake + nvcc | first Foundry use |
| ~~**Full pack**~~ | retired 2026-10-25 — split packs cover both consumers | — |

One compatibility pack (`STABLE` = engine + CUDA 12.8 runtime) and any fork engines are optional
downloads from CONFIG → UPDATES. Foundry is offered the first time it is used, never in the wizard.

### 0.1 Driver gate — the actual first decision

The seeded EDGE engine is usable only on a driver that can run CUDA 13.4. This repo already has the
table (`src/lib/foundry_constants.ts`): **13.4 → 610**, 13.0 → 580, **12.8 → 570**, 12.0 → 525. You
said 580 — that is the CUDA 13.x *floor*; 13.4 is **610** in the constants. Keep 610 unless the
release notes are re-checked. This machine runs 616.92, so it passes either number.

On driver < 610 the seed is dead weight: EDGE cannot initialize, `--version` cannot be read, the
GGUF scan and every launch fail. The installer cannot know the driver and the app cannot install one,
so the wizard checks, nudges, and re-checks **in place**:

1. **On wizard open, before any download:** read `nvidia-smi`.
2. **≥ 610** → step 2 is just "CUDA 13.4 runtime, 383 MB".
3. **< 610** → "your driver (NNN) is older than EDGE needs (610+)": `OPEN DRIVER PAGE` +
   `CHECK AGAIN`. A re-check spawns a **fresh `nvidia-smi`** — never the cached major the launch gate
   uses — and needs no app restart. Poll every 3 s while the step is open and re-check on window
   focus, because the user will alt-tab back from the NVIDIA installer.
4. **Installed but unchanged** → the new kernel driver is not in memory until reboot. Say exactly
   that, and keep `CHECK AGAIN` (it passes after the reboot; the next app start re-checks too).
5. **Still old after two checks** → offer the STABLE compatibility pack (engine + 12.8 runtime,
   ~536 MB). This is the only real decision in the wizard, and only the minority ever sees it.
6. **Refused** → "continue without an engine (degraded)" as an explicit escape (locked-down machine),
   same rule as "no NVIDIA GPU" in §6. Nothing is downloaded; the nudge stays in the header.

The seed's cost is confined to step 5: a user who refuses the driver update pays the engine twice
(~112 MB at 3-arch). That is the bet, and it is countable, because reaching the STABLE fallback is an
explicit UI action.

Why not drop the seed and let the wizard pick (option A)? That turns the first screen into an engine
decision plus two downloads, and "fast one or compatible one" is unanswerable for a new user. With the
seed, the wizard's only content is "install the driver" or "download 383 MB".

Two code facts behind this:

- **The gate is advisory today and lives in the wrong place.** `CUDA_MIN_DRIVER_MAJOR` is TS-only;
  nothing in Rust refuses to spawn an engine whose driver cannot run its CUDA version. The launch and
  probe paths must check it.
- **Move the table to one source:** `toolchain/manifest.json` → `profiles[].min_driver_major`. Rust
  computes it, `ToolchainInstallInfo.runtime_versions` ships
  `{ cuda, ready, min_driver_major, driver_major, driver_ok }`, and TS renders values instead of
  owning a second copy (delete `CUDA_MIN_DRIVER_MAJOR` / `getMinDriverMajorForCuda`).

---

## 1. The byte budget is invariant — so decide on UX, not size

With compression on, the same bytes get downloaded whichever way they are packaged. Measured
installer components:

| Component | Raw | Compressed | Ratio |
|---|---:|---:|---:|
| shell: exe 16.2 + dist 1.8 + pi-ext 7.0 + templates ~1 | ~26 MB | **6.3 MB** | 24% |
| `bin/` MinGit tree | 96.6 MB | **23.5 MB** | 24% |
| `ggml-master/edge` **3-arch** (built 2026-10-25) | 144.7 MB | **107.6 MB** | 74% |
| `ggml-master/stable` **3-arch** (built 2026-10-25) | 144.4 MB | **112.0 MB** | 78% |
| ↳ `ggml-cuda.dll` inside either profile | 124.2 MB | — | — |
| CUDA 13.4 runtime (cublas + cublasLt + cudart) | 522.9 MB | **382.9 MB** | 73% |
| CUDA 12.8 runtime | 769.4 MB | **423.7 MB** | 55% |

Three ways to deliver the same first-run set:

| | Installer | Wizard download | Total | Offline |
|---|---:|---:|---:|---|
| A — app only | 31 MB | 491 MB | **522 MB** | no |
| **B — app + EDGE seed** | **~140 MB** | **383 MB** | **523 MB** | no |
| C — app + EDGE + runtime | ~523 MB | 0 | **523 MB** | **yes** |

**B is the right default.** It costs nothing in bytes, the in-app download is the smallest possible
(383 MB instead of 491 MB), and the app is never empty. C is the only offline variant and is a build
flag away, not a second product: stage the runtime DLLs into the payload. A is only better for users
on very slow links, where a 31 MB first download lets them start sooner.

The CUDA runtime is now **the dominant payload** (383 of 523 MB; the engine is 108). Any future size
work belongs there, not in the engine — and the 12.8 runtime is 424 MB, which is why STABLE is a big
optional pack.

One exception to the byte invariance: on a driver below CUDA 13.4's minimum the seed cannot run
(§0.1), so B costs that segment the engine twice. That is a segment judgement, not a byte one.

Correction to v1: bundling EDGE does **not** buy offline (the runtime is still missing). It buys an
app that is never empty plus the smallest mandatory download. That is worth the installer size,
which after compression is *smaller than today's 508 MB*.

---

## 2. Turn NSIS compression back on

`tauri.conf.json` has `"compression": "none"`; the v1.1.1 installer lists `Method = Copy`, which is
why 508 MB of payload is a 508 MB download.

The slowness you saw is **build-time, not install-time**: NSIS compresses the payload in a single
threaded process, so 500 MB at low CPU usage is expected on a 32-core box. Install-time decompression
is a different, much faster pass.

| Setting | Installer (B / both engines) | Build time | Install |
|---|---|---|---|
| `none` | ~267 MB (B) / ~411 MB (both) | seconds | seconds |
| `lzma` | **~140 MB / ~250 MB** | a few min, 1 core | ~5–15 s |
| `zlib` | ~185 MB / ~330 MB (est) | ~1 min | faster |

Start with `lzma`. If build time is still unacceptable, `zlib` recovers most of the win at ~30%
more size. Do not treat the previous slow run as proof of a bug — measure it once on a release build
and record both numbers in `docs/SELF-SUFFICIENT-INSTALL.md`.

Caveat: with `none`, `7z l setup.exe` lists payload paths (verified: `runtime\ggml-master\edge\
ggml-cuda.dll 182087680`). With LZMA solid that listing may not be available. **Assert on the
staging tree, not on the built exe** (§8.6), so the gate survives the compression change.

---

## 3. 3-arch is the default, for both profiles

Decision: the shipped `ggml-master` packs are 3-arch — a safe superset of the GPUs currently in
circulation — for EDGE and STABLE alike. A user who knows their mixed topology and wants a leaner
binary builds it in Foundry. Do **not** publish per-arch downloads: that is a support matrix, not a
feature.

Today's local build is 3-arch (`ggml-cuda.dll` 124.2 MB, pack 144.7 MB, 107.6 MB as 7z — measured on
the 2026-10-25 build). The old single-arch numbers are obsolete; do not plan from them.

| | Measured 2026-10-25 |
|---|---:|
| EDGE engine pack | **144.7 MB → 107.6 MB 7z** |
| STABLE engine pack | **144.4 MB → 112.0 MB 7z** |
| Installer (B, EDGE seed) | **~140 MB** |
| First-run total (with 383 MB runtime) | **~523 MB** |
| STABLE compat pack (engine + 12.8 rt) | **~536 MB** |

Measured on the 2026-10-25 3-arch build, not projected.

**Do not read the EDGE/STABLE size delta as a profile property.** The old 191 MB STABLE
`ggml-cuda.dll` was built with FA-all-quants (kernels for every quant type), which inflated it; the
clean rebuild is 124.2 MB — the same as EDGE. The two profiles are now the same size.

Consequences:

- A **~140 MB** installer is a 72% cut from today's 508 MB, and the first run drops from 1.69 GB to
  **~523 MB**. That is the story for the release notes.
- **Revisit only if the installer exceeds ~700 MB.** There is ~5× headroom now, so this is a guard,
  not a live decision.
- NSIS build time scales with the staged payload (~267 MB raw for B): budget a few minutes for `lzma`
  on one core, not the 5–10 min an engine-heavy payload implied.
- STABLE is **~536 MB** because the 12.8 runtime alone is 424 MB, not because the engine is big. That
  is the honest cost of the compatibility pack; it stays optional.

---

## 4. Names

The word "runtime" currently means three things and that is why the question was confusing. Vocabulary
for code review, UI copy and commits from now on:

| Say | For | Disk |
|---|---|---|
| **engine pack** | `ggml-master` + profile binaries | `runtime/{provider}/{profile}/` (seed + catalog overlay) |
| **CUDA runtime pack** | `cublas*` / `cublasLt*` / `cudart*` for one CUDA version | `toolchain/cuda/v{cuda}/bin[/x64]/` |
| **build pack** | VS + SDK + cmake + nvcc | `toolchain/{vs,Windows Kits,cmake}` |
| **toolchain** | the union of CUDA runtime + build packs | `toolchain/` |

Do **not** rename `runtime/` on disk in this phase. It is referenced by
`binarySourcePerEnv`, `runtime-distribution.ps1`, NSIS resources, and the Foundry output tree; a
rename is a separate mechanical PR with no user-visible effect. Fix the *vocabulary* first.

Asset names (version in the name: a committed digest plus a stable name strands old app versions the
first time bytes change):

```
ENGINE_{provider}-{profile}-{buildId}.7z      ENGINE_ggml-master-edge-b4231-a1b2c3d.7z
toolchain-rt-{cuda}-v{manifestVersion}.7z     toolchain-rt-13.4-v4.7z
toolchain-build-v{manifestVersion}.7z
toolchain-full-v{manifestVersion}.7z
SHA256SUMS
```

`{buildId}` is what `engine_build_info.rs` derives from `llama-server --version` (`b<build>-<sha8>`),
so pack name, UI label and the running binary agree.

Digest trust follows `SUPPLY-CHAIN-SHA-CHECKS.md` P0: the manifest is **committed and compiled in**
(`include_str!`), so the digest arrives over a different trust path than the bytes. Consequence:
a new engine becomes visible to users with an app release (the 6.3 MB update), while the pack itself
is downloaded on demand. A signed remote manifest can lift that later; do not fetch an unsigned one.

---

## 5. Manifests

### 5.1 `src-tauri/runtime-catalog/engines.json` (new, committed, embedded)

```json
{
  "schemaVersion": 1,
  "generated": "2026-10-25T00:00:00Z",
  "enginePacks": [
    {
      "provider": "ggml-master", "profile": "edge", "label": "EDGE",
      "asset": "ENGINE_ggml-master-edge-b4231-a1b2c3d.7z",
      "sha256": "9f2c...", "sizeBytes": 160878961,
      "cuda": "13.4", "engineVersion": "b4231-a1b2c3d", "recommended": true
    },
    {
      "provider": "ggml-master", "profile": "stable", "label": "STABLE",
      "asset": "ENGINE_ggml-master-stable-b4231-a1b2c3d.7z",
      "sha256": "...", "sizeBytes": 157...,
      "cuda": "12.8", "engineVersion": "b4231-a1b2c3d", "recommended": false
    }
  ]
}
```

```rust
pub const EMBEDDED_ENGINES: &str = include_str!("../runtime-catalog/engines.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnginePackDef {
    pub provider: String, pub profile: String, pub label: String,
    pub asset: String, pub sha256: String, pub size_bytes: u64,
    pub cuda: String, pub engine_version: String,
    #[serde(default)] pub recommended: bool,
}

pub fn engine_pack(provider: &str, profile: &str) -> Option<&'static EnginePackDef>;
pub fn recommended_engine() -> Option<&'static EnginePackDef>;
```

`plugins.json` keeps its current generated shape; do not merge the two. `engines.json` is an install
manifest (identity + digest), `plugins.json` is fork metadata.

### 5.2 `toolchain/manifest.json` v4 (committed, embedded)

```diff
-  "version": 3,
+  "version": 4,
+  "packs": [
+    { "id": "runtime-13.4", "kind": "runtime", "cuda": "13.4",
+      "asset": "toolchain-rt-13.4-v4.7z", "sha256": "…", "sizeBytes": 401449091 },
+    { "id": "runtime-12.8", "kind": "runtime", "cuda": "12.8",
+      "asset": "toolchain-rt-12.8-v4.7z", "sha256": "…", "sizeBytes": 444262993 },
+    { "id": "build", "kind": "build",
+      "asset": "toolchain-build-v4.7z", "sha256": "…", "sizeBytes": 838…,
+      "requires": ["runtime-13.4", "runtime-12.8"] },
+    { "id": "full", "kind": "full",
+      "asset": "toolchain-full-v4.7z", "sha256": "…", "sizeBytes": 1237… }
+  ]
```

Profiles gain the driver floor — single source for §0.1, so `foundry_constants.ts` stops owning a
copy:

```diff
     {
       "id": "edge", "label": "EDGE", "vs": "2026", "cuda": "13.4",
+      "min_driver_major": 610,
       "generator": "Visual Studio 18 2026", "arch": "x64", ...
     },
     {
       "id": "stable", "label": "STABLE", "vs": "2022", "cuda": "12.8",
+      "min_driver_major": 570,
       "generator": "Visual Studio 17 2022", "arch": "x64", ...
     }
```

Pack contents (keep the `toolchain/` prefix so `resolve_toolchain_extract_dest` is untouched):

| Pack | Files |
|---|---|
| `runtime-13.4` | `toolchain/cuda/v13.4/bin/x64/{cublas64_13,cublasLt64_13,cudart64_13}.dll` |
| `runtime-12.8` | `toolchain/cuda/v12.8/bin/{cublas64_12,cublasLt64_12,cudart64_12}.dll` |
| `build` | full tree minus those 6 files |
| ~~`full`~~ | retired 2026-10-25 — the two consumers are a runtime and `build` |

`build` does not need the runtime to build: `ProfileCheck` tests devcmd / MSVC / ml64 / SDK headers /
nvcc / CUDA include / cmake only. Verified import chain for launch is
`ggml-cuda.dll -> cublas64_13.dll -> cublasLt64_13.dll`; `cudart64_13.dll` is shipped by the pack for
the existing readiness check but is not imported by this build.

---

## 6. First run (the seeded flow)

1. **Install** ~140 MB. The engine is already on disk.
2. **Wizard, step 1 — link models.** No download.
3. **Wizard, step 2 — driver, then one download.**
   - ≥ 610: "CUDA 13.4 runtime, 383 MB" → download → scan runs.
   - < 610: the nudge ladder (§0.1) with an in-place re-check; on success the same 383 MB queues.
     Two failed checks expose the STABLE fallback; a refusal exposes the degraded escape.
4. **Wizard, step 3 — finish.** The driver is no longer "a warning, not a gate" — it is the reason
   step 2 took the branch it took. FINISH remains one button.

Rules that must hold, in this order:

- **Never spawn an engine before its CUDA runtime is verified.** `probe_binary_version_sync` calls
  `apply_cuda_toolchain_for_binary` but ignores its `Result`, so with the seed present and no runtime
  the app probes `llama-server.exe` anyway: `LoadLibrary` fails, the probe returns no version, and on
  a machine without VC++ this is exactly the "raw Windows dialog, no log line" failure documented in
  `SELF-SUFFICIENT-INSTALL.md`. Gate the probe (and `check_binary_updates`' local half) on
  `cuda_runtime_ready_for_version(profile) && driver_ok(profile)`, and return "runtime missing" /
  "driver too old" instead of spawning.
- **The GGUF scan waits for the runtime, silently.** `require_runtime_for_gguf_scan` already refuses;
  make the refusal a queued state, not an error, and re-run the scan on the `runtime ready`
  transition (the download-complete event already exists).
- **Onboarding gate = "some engine can launch".**
  `engineReady = (seed && runtime13.4 && driver_ok(edge)) || (stable && runtime12.8 && driver_ok(stable))`.
  Not `all_ready`, not both CUDA versions. `check_runtime_ready` currently requires every profile
  (`manifest.profiles.iter().all(...)`), which would force a 424 MB 12.8 download on an EDGE user —
  that is the bug this section removes.
- **A parked seed must be visibly parked.** On the STABLE branch the seeded EDGE appears in
  PROVIDERS as "requires driver 610+ (yours: NNN)", is never probed or launched, and does not count
  toward `engineReady`. Otherwise the first launch looks broken on hardware that is fine.
- **"No NVIDIA GPU" is not "old driver".** `get_nvidia_driver_version` distinguishes `Ok(None)` from
  an error. A machine with no driver at all must not be offered a 536 MB pack it can never run:
  allow FINISH with a warning and let the app work as a config/model manager. Do not let a missing
  GPU become a download trap.
- **No Foundry step.** The wizard never offers the 1.18 GB pack.

Copy for step 2:

> **CUDA runtime for EDGE**
> One download, 383 MB. Required to start the EDGE engine. STABLE, other forks and the Foundry build
> tools can be added later from CONFIG → UPDATES.

Offline story (unchanged, and the reason no second installer is needed): the runtime pack can be
dropped into `.toolchain-download/cache/` and installed from cache — the wizard already supports it.
Portable revival works; a fully offline *installer* does not exist in B (see §1, option C).

### Frontend diffs

`src/lib/setupGuide.ts`:
```diff
-export type SetupPhase = "paths" | "toolchain" | "finish";
+export type SetupPhase = "paths" | "runtime" | "finish";
...
-/** Portable CUDA runtime is a hard requirement — no skip path. */
-export function computeToolchainDone(runtimeReady: boolean): boolean {
-  return runtimeReady;
-}
+/** The seeded engine needs the CUDA runtime for its own profile — that is the only gate. */
+export function computeRuntimeDone(runtimeReady: boolean): boolean {
+  return runtimeReady;
+}
...
-export function computeSetupPhase(opts: { pathsDone: boolean; toolchainDone: boolean }): SetupPhase {
+export function computeSetupPhase(opts: { pathsDone: boolean; runtimeDone: boolean }): SetupPhase {
   if (!opts.pathsDone) return "paths";
-  if (!opts.toolchainDone) return "toolchain";
+  if (!opts.runtimeDone) return "runtime";
   return "finish";
 }
```

`src/hooks/useSetupGuide.ts`: `runtimeReady` now comes from `runtime_ready_versions[seedCuda]` (not
`runtime_ready`); keep `toolchainChecked` (rename `runtimeChecked` optional); `dismiss()` gates on the
same value; FINISH tooltip becomes "Install the CUDA runtime before finishing setup".

`SetupGuideDisplay.tsx`: keep `FoundryToolchainPanel onboarding` — but it must render **runtime-only**
(changed in §8.5) with a 383 MB button and no mention of Foundry. The checklist row stays
"CUDA runtime"; its detail becomes "383 MB — required for the EDGE engine".

`EngineSetupPanel` is **not** needed for the seed. It is needed only for the optional packs (STABLE,
forks) and lives in UPDATES.

---

## 7. Optional packs: STABLE, forks, Foundry

- **STABLE** = one action that installs `runtime-12.8` then `ENGINE_ggml-master-stable-*.7z`
  (~536 MB). UPDATES shows the requirement before the click (`requires CUDA 12.8 ·
  424 MB`). `install_engine_pack(provider, profile)` does both: resolve the `EnginePackDef`, start the
  runtime pack if `!cuda_runtime_ready_for_version(def.cuda)`, then start the engine pack. Extraction
  targets are disjoint (`toolchain/` vs `runtime/`), so they may run concurrently and the UI
  aggregates progress.
- **Forks** are exactly the plugin flow that exists today; only the asset prefix changes.
- **Foundry** stays where it already renders: `FoundryConfirmForm` when `!all_ready`, plus the compact
  strip in `ProvidersConfig`. Nothing new to build.

---

## 8. Diffs

### 8.1 `src-tauri/tauri.conf.json`

```diff
       "nsis": {
-        "compression": "none",
+        "compression": "lzma",
         "template": "./nsis/installer.nsi",
```
and one resource line, so installer and App `.7z` finally agree on the catalog path (today the
installer writes legacy `runtime/catalog/`, the updater writes `runtime-catalog/`, and
`plugin_catalog.rs` falls back between them):

```diff
     "resources": {
       "runtime-bundle/": "runtime/",
+      "runtime-catalog/": "runtime-catalog/",
       "bin/": "bin/",
```

### 8.2 `scripts/distribution-policy.json` — v2

`nsisCore` currently drives three unrelated things (NSIS staging, mirroring, template selection).
Reducing it to `edge` would silently stop mirroring STABLE. Split the concerns:

```diff
-{ "policyVersion": 1, "nsisCore": { "ggml-master": ["edge","stable"] }, "plugins": {}, ... }
+{
+  "policyVersion": 2,
+  "installer":   { "ggml-master": ["edge"] },
+  "enginePacks": { "ggml-master": ["edge", "stable"] },
+  "plugins": {},
+  "recommendedEngine": { "provider": "ggml-master", "profile": "edge" },
+  "defaultPluginProfiles": ["edge", "stable"]
+}
```

`scripts/runtime-distribution.ps1`:
- `$script:InstallerProviders` from `.installer`; `Get-RuntimeNsisProfiles` reads it (staging only).
- `$script:RuntimeBundleProfiles` = `.enginePacks` ∪ `.plugins` — **mirroring and packing use this**,
  so STABLE keeps being built.
- `Test-RuntimeNsisProvider` is renamed `Test-RuntimeEngineProvider` (`.enginePacks` ∪ `.plugins`) —
  that is what `prepare-release-app-only.ps1` uses to pick providers whose templates ship.
- `$script:RecommendedEngine` for the catalog writer.
`DistributionDevPanel.tsx` edits this JSON; it must learn the v2 keys in the same PR (otherwise the
panel rewrites a v1 shape over it).

### 8.3 `scripts/prepare-release-runtime.ps1` — keep, but it stages edge only

No code change beyond the policy (§8.2) and a header that says so. It keeps staging the engine seed
plus factory templates into `runtime-bundle/`; the CRT staging inside it still applies to the seed.

Delete the "STABLE" examples from its header comment. Its output must contain exactly
`runtime-bundle/ggml-master/edge` (plus `runtime-bundle/ggml-master/config`).

### 8.4 `scripts/prepare-release-app-only.ps1`

Catalog goes to the canonical top-level path (it currently stages inside `runtime-bundle/`, which maps
to `runtime/` and would produce `runtime/runtime-catalog/`):

```diff
-# Bundle as runtime-catalog/ so App .7z extracts to app/runtime-catalog/plugins.json
-$catalog_dst = Join-Path $bundle_root 'runtime-catalog'
-& (Join-Path $script_dir 'generate-plugin-catalog.ps1') -OutDir $catalog_dst
+# Canonical catalog for BOTH routes: {app_root}/runtime-catalog/plugins.json.
+# tauri.conf maps src-tauri/runtime-catalog/ -> runtime-catalog/; pack-app-update.ps1 reads
+# the same tree. Never stage this under runtime-bundle/ (that maps to runtime/).
+& (Join-Path $script_dir 'generate-plugin-catalog.ps1')
```

### 8.5 `scripts/pack-provider-runtime.ps1`

Packs every provider/profile in `enginePacks` (not just plugins), names with the build id, writes the
committed digest manifest.

```diff
-#   PLUGIN_{provider}-{profile}.7z  — catalog plugins (default when packing "all")
-#   CORE_{provider}-{profile}.7z    — NSIS core (ggml-master) only when -ProviderId is explicit
+#   ENGINE_{provider}-{profile}-{buildId}.7z — one per pack, including ggml-master
 #
-# Full NSIS already embeds core engines — do not bulk-pack ggml-master on weekly Full.
+# The installer seeds ggml-master/edge only. Every other engine is a pack; upload a pack
+# when {buildId} changed (identical builds are skipped).
```

```diff
-    $kind = if (Test-RuntimeNsisProvider -ProviderId $Prov) { 'CORE' } else { 'PLUGIN' }
-    $zip_name = "${kind}_${Prov}-${Prof}.7z"
+    $build_id = Get-EngineBuildId -Exe (Join-Path $profile_src 'llama-server.exe')
+    $zip_name = "ENGINE_${Prov}-${Prof}-${build_id}.7z"
-    foreach ($kv in $script:OptionalDownloadProviders.GetEnumerator()) {
+    foreach ($kv in $script:EnginePackProviders.GetEnumerator()) {
```

New helpers in the same file: `Get-EngineBuildId` (runs `llama-server --version` with the portable
CUDA bin on PATH, returns `b<build>-<sha8>`, **fails the pack if unparseable**) and
`Update-EngineManifest` (rewrites `engines.json`; no write when content is identical, so `git status`
stays clean).

**Every pack carries the three CRT DLLs (landed).** Previously `Install-MsvcCrtIntoDirs` ran only in
`prepare-release-runtime.ps1` (the installer seed), so `pack-provider-runtime.ps1` published engine
dirs without `msvcp140/vcruntime140` — the documented "raw Windows dialog, no engine log" failure on a
machine that never had VC++ 2015-2022. The pack script now stages them into the staged profile and
fails the pack if it wrote fewer than three.

### 8.6 `scripts/majestic/majestic.ps1`

Replace the engine assertion (the 7z-listing one from v1 does not survive `lzma`) with a staging +
size gate, after `Invoke-PrepareReleaseBundle` and again after `Stage-InstallerForVariant`:

```powershell
function Assert-InstallerSeed {
    param([string]$InstallerPath)
    $seed = Join-Path $root 'src-tauri\runtime-bundle\ggml-master\edge\llama-server.exe'
    if (-not (Test-Path -LiteralPath $seed)) {
        throw "Installer seed missing: runtime-bundle\ggml-master\edge (prepare-release-runtime.ps1)."
    }
    $stable = Join-Path $root 'src-tauri\runtime-bundle\ggml-master\stable'
    if (Test-Path -LiteralPath $stable) {
        throw "runtime-bundle contains ggml-master/stable - STABLE ships as a pack, not in the installer."
    }
    $mb = [math]::Round((Get-Item -LiteralPath $InstallerPath).Length / 1MB, 1)
    if ($mb -lt 120 -or $mb -gt 700) {   # 120 floor = shell+seed sanity; 700 = 3-arch revisit trigger
        throw "Installer is $mb MB - outside the expected 120-700 MB band (see docs/ENGINE-PACKS.md)."
    }
    Write-Majestic "Installer seed assertion passed ($mb MB, EDGE only)" -Color Green
}
```

`Get-PackKindLabel` becomes `'Full Bundle (CORE: App .7z + NSIS with EDGE seed)'`.

### 8.7 Client: pack registry, per-version readiness, merge extract, per-pack verify

`foundry_toolchain.rs`:

1. `pack_archive_name(pack)` → look up `manifest.packs` (`ToolchainPackDef { id, kind, cuda, asset,
   sha256, size_bytes }`). Drop `TOOLCHAIN_ARCHIVE_NAME` as the single truth.
2. `check_runtime_ready` keeps its "all profiles" meaning for `FoundryToolchainPanel`; add
   `runtime_ready_versions(manifest)` and expose it in `ToolchainInstallInfo` as
   `{ cuda, ready, min_driver_major, driver_major, driver_ok }`. The wizard reads **one** entry, and
   the launch/probe gate reads `driver_ok` before spawning. `driver_major` comes from the existing
   `telemetry::get_nvidia_driver_version()` (`nvidia-smi`), cached per session — it is already async
   and already used by `bench_archive`.
3. `prepare_toolchain_upgrade` wipes `toolchain/`; a partial pack must merge instead:
   ```rust
   match def.kind {
       PackKind::Full => prepare_toolchain_upgrade(&pack_key)?,
       _ => std::fs::create_dir_all(toolchain_dir())?,
   }
   ```
   (`extract_toolchain_archive` already passes `-aoa`, so overlay is correct.)
4. `verify_toolchain_install` calls `check_all_profiles_strict()`, which would fail every runtime
   pack:
   ```rust
   match def.kind {
       PackKind::Runtime => cuda_runtime_ready_for_version(def.cuda.as_ref().unwrap())
           .then_some(()).ok_or_else(|| format!("CUDA {} runtime incomplete after extract", cuda))?,
       PackKind::Build => { check_all_profiles_strict()?; }   // profiles only, no runtime check
       PackKind::Full => { check_all_profiles_strict()?; }
   }
   ```
5. Runtime packs are not worth caching: `finalize_toolchain_install` promotes every archive to
   `.toolchain-download/cache` (that is why 1.18 GB sits next to 4.4 GB today). Delete the archive
   after a verified runtime install; keep `build`/`full`.

### 8.8 Client: engine packs

- `resolve_provider_pack_asset(provider, profile)` stops scanning 40 releases for
  `{provider}-{profile}.7z` and instead reads `EnginePackDef` (name + sha256), then finds the release
  asset with that name. Transport stays "scan app tags"; identity comes from the catalog.
- `start_provider_pack_download` compares the asset digest against `EnginePackDef.sha256`
  (`Policy::Required` per the supply-chain doc), not only against the GitHub digest.
- New command `install_engine_pack(provider_id, profile)` (§7) and `get_engine_status()` — the latter
  must be offline-safe (local disk + compiled catalog, no GitHub call) because the wizard renders
  before the network is known to work.
- `binarySourcePerEnv`: **keep `Bundled`**. The seed is a permanent fallback if an overlay is corrupt
  or its DLLs are missing. v1 proposed deleting it; that was wrong for a seeded install.

---

## 9. Uninstall, update, repair

- Update (`/S /UPDATE`): Tauri overwrites only files in the new installer. The seed is one of them;
  `runtime-catalog/` overlays, `toolchain/`, and `config/` are untouched. Packs survive by
  construction — assert it (§12).
- Uninstall: Tauri deletes only files it installed and then `RMDir "$INSTDIR"` non-recursively. With
  packs on disk that leaves an orphaned ~700 MB tree and a folder that will not delete. Add, under
  `$UpdateMode <> 1` in `installer.nsi`: `RMDir /r "$INSTDIR\runtime"`, `"$INSTDIR\runtime-catalog"`,
  `"$INSTDIR\toolchain"`. Keep `config/` (user data) as today.
- Repair: delete a seed file by hand → `binarySourcePerEnv` falls back to the overlay; delete the
  overlay → the seed still launches. Both paths must be tested, not assumed.

---

## 10. PR sequence (each shippable)

| PR | Change | Installer | First-run |
|---|---|---|---|
| 1 | `compression: "lzma"` + size/seed assertions | 508 → **~250 MB** (both engines) | unchanged 1.69 GB |
| 2 | manifest v4 + pack registry + per-pack verify/merge + **driver gate with in-place re-check** (`min_driver_major`, `driver_ok`); wizard pulls one runtime pack once the nudge passes. While both engines are still bundled, the fallback for a stuck driver is the **already-installed STABLE** + `runtime-12.8` | ~250 MB | 633 MB |
| 3 | `engines.json` + `ENGINE_*` packs + digest-pinned resolution; UPDATES installs/updates cores and STABLE | ~250 MB | same |
| 4 | policy v2: installer seeds EDGE only (STABLE becomes a pack); catalog path | **~140 MB** | **523 MB** |
| 5 | probe/scan gating (§6), uninstall hook (§9), docs, `majestic:check` digest gates | ~140 MB | 523 MB |

Installer/first-run numbers are measured on the 2026-10-25 3-arch build (§3), not projected.

PR 1 is pure win and zero risk. **PR 2 must ship the driver gate together with the runtime split:**
without it an old-driver user downloads 383 MB, fails to launch, and has no explained path — the
worst possible first run. The driver fallback is free in PR 2 (STABLE is still bundled, so only its
424 MB runtime downloads); from PR 4 it costs the STABLE pack (~536 MB). That is the only
ordering constraint the fallback has. PR 4 must not land before PR 3, or a fresh install has no
STABLE path at all. PR 5's probe gate is the only one that can produce a user-visible dialog on first
launch — land it before anyone outside the team installs.

---

## 11. Deferred

- **Offline installer** (option C): stage the runtime DLLs into `runtime-bundle/` under a `-Offline`
  flag. One build flag, not a second product. Only if support demand appears.
- **`bin/` becomes a pack**: now that compression is on, MinGit is 23.5 MB of a 184 MB installer
  (13%), not 78%. Not worth the harness-without-git risk.
- **Renaming `runtime/` → `engines/`**: vocabulary is fixed (§4); the directory rename is separate.
- **Delta updates**: `ggml-cuda.dll` changes on every build and does not delta well.

---

## 12. Acceptance checks

```powershell
npm run check                      # css gates + tsc + vitest + cargo
npm run majestic:check             # + manifest digests match packed files; installer seed assertion

# 1. Staging: seed only (this assert survives NSIS compression)
Test-Path src-tauri\runtime-bundle\ggml-master\edge\llama-server.exe   # True
Test-Path src-tauri\runtime-bundle\ggml-master\stable                  # False
(Get-Item ...setup.exe).Length / 1MB                                   # 120-200 MB (3-arch)

# 2. Fresh folder, no toolchain, current driver (this machine: 616.92)
.\CORE_...setup.exe /S /D=C:\tmp\bo-test
# wizard: link models -> "CUDA runtime 383 MB" -> scan runs -> FINISH enabled
# before the runtime: no engine spawn, no missing-DLL dialog, engine listed as "runtime missing"

# 3. Reinstall keeps packs; uninstall removes them
# 4. STABLE pack: install -> 424 MB runtime + engine, EDGE untouched
# 5. Foundry: not offered in the wizard; offered in FoundryConfirmForm

# 6. Driver nudge, re-checked in place (no old GPU required)
$env:BLACKWELL_FAKE_DRIVER_MAJOR=560   # DEV-only, #[cfg(debug_assertions)]; never compiled into REL
# nudge shown, NO download queued, EDGE parked, probe/scan must not spawn it
$env:BLACKWELL_FAKE_DRIVER_MAJOR=620
# CHECK AGAIN -> runtime-13.4 queues immediately; no app restart; scan runs on completion
```

Explicit failure tests: cancel mid-runtime (FINISH stays disabled, no dialog, scan stays queued);
delete `cublasLt64_13.dll` (launch fails with `portable_cuda_missing_message`, UPDATES offers repair);
install STABLE with only 13.4 present (pulls 12.8, does not touch 13.4); run with the driver faked to
560 after STABLE is installed (STABLE launches, EDGE stays parked).

---

## 13. How the numbers were measured

```powershell
7z a -t7z -mx=7 -mmt=on tmp\size-probe\bin.7z src-tauri\bin\*            # 96.6 -> 23.5 MB
7z a -t7z -mx=7 -mmt=on tmp\size-probe\edge.7z src-tauri\runtime-bundle\ggml-master\edge\*
                                                                          # 194.4 -> 153.4 MB
7z a -t7z -mx=7 -mmt=on tmp\size-probe\ggml-cuda-edge.7z ...\ggml-cuda.dll  # 173.7 -> 149.9 MB
7z l .majestic-out\CORE_*setup.exe                                        # Method = Copy, 508 MB
dumpbin /dependents ggml-cuda.dll                                         # -> cublas64_13.dll
dumpbin /dependents cublas64_13.dll                                       # -> cublasLt64_13.dll
nvidia-smi --query-gpu=driver_version,name --format=csv,noheader         # 616.92, RTX PRO 6000
```

Driver floors now live in `toolchain/manifest.json` → `profiles[].min_driver_major` (610 / 570) and are
read by the Rust launch gate. `src/lib/foundry_constants.ts` still carries a display copy
(`CUDA_MIN_DRIVER_MAJOR`); PR 2b deletes it once the wizard renders the Rust-provided
`runtime_versions` instead.

---

## 14. Implementation status (2026-10-25)

| Item | State | Where |
|---|---|---|
| NSIS `lzma` (was `none`) | **landed** | `src-tauri/tauri.conf.json` |
| Installer seed assertion: staging-based, policy-driven, size band | **landed**, runs on the next full pack | `Assert-InstallerSeed` in `scripts/majestic/majestic.ps1` |
| Driver floor per profile | **landed** | `toolchain/manifest.json` (`min_driver_major`: edge 610, stable 570) |
| Launch refusal on an old/unknown driver (piped + NoBSproof) | **landed** | `foundry_toolchain::ensure_driver_supports_profile`; `engine.rs` (`launch_engine`, `open_nobsproof_cmd`) |
| Fresh driver probe + `runtime_versions` in install info | **landed** | `foundry_toolchain::{detect_driver_major, install_info}` |
| DEV override for testing the nudge | **landed** | `BLACKWELL_FAKE_DRIVER_MAJOR` (debug builds only) |
| Toolchain split: `manifest.json` v4 `packs[]` | **landed** | `toolchain/manifest.json`, `scripts/pack-toolchain-packs.ps1` |
| Pack registry, per-pack verify, merge-not-wipe extraction, runtime packs not cached | **landed** | `foundry_toolchain::{pack_def, finalize_toolchain_install, verify_toolchain_install}` |
| Engine pack manifest + `ENGINE_*` assets | **landed** | `scripts/pack-provider-runtime.ps1` → `src-tauri/runtime-catalog/engines.json`; `src-tauri/src/engine_packs.rs` |
| Digest-pinned pack resolution (manifest name preferred, forks fall back to the name scan) | **landed** | `github_releases::resolve_provider_pack_asset`; `download_manager` uses the manifest sha |
| Installer seeds **EDGE only** (policy v2) | **landed** | `scripts/distribution-policy.json`: `nsisCore: edge`, `enginePacks: edge + stable` |
| Wizard nudge + seeded-runtime gate (no second CUDA download) | **landed** | `FoundryToolchainPanel` (driver block, CHECK AGAIN, 3 s + focus re-probe), `useSetupGuide` |
| Build pack (VS/SDK/cmake/nvcc minus the six runtime DLLs) | **landed** — 366.2 MB | `pack-toolchain-packs.ps1 -Packs build`; Foundry now requests `build`, not `full` |
| Foundry download requests `build` instead of `full` | **landed** | `FoundryToolchainPanel` (`onboardingPackId ?? "build"`) |

**Release flow (majestic), reworked for one engine:** profile rows come from
`distribution-policy.json` (`nsisCore`, `enginePacks`) — there is no provider list in
`majestic.config.json` any more. `pack` stages the App `.7z`, the NSIS setup (EDGE seed), then
builds **and digest-verifies** both `ENGINE_*` packs from `engines.json`; `ship` uploads exactly the
files recorded in the pack manifest (the old `CORE_`/`PLUGIN_` filename filters are gone).
`ship-provider` is retired (`npm run majestic:ship:provider` removed); `majestic:pack:provider` /
`majestic:pack:engines` rebuild engine packs from the policy. Adding a future engine = policy edit +
pack, no script edit.

Engine packs built 2026-10-25 (engine `b11869-d327bf1f`, both profiles):

| Asset | Size |
|---|---:|
| `ENGINE_ggml-master-edge-b11869-d327bf1f.7z` | 107.6 MB |
| `ENGINE_ggml-master-stable-b11869-d327bf1f.7z` | 110.0 MB |

Generated packs (2026-10-25, `-mx=7`, digests pinned in the manifest):

| Pack | Size | SHA-256 (short) |
|---|---:|---|
| `toolchain-rt-13.4-v4.7z` | 382.9 MB | `a1d5c8df…` |
| `toolchain-rt-12.8-v4.7z` | 423.7 MB | `e645819c…` |
| `toolchain-build-v4.7z` | 366.2 MB | `56643fc7…` |

Published to the `toolchain` tag on 2026-10-25 (3 assets, 1,172.7 MB total). The former
`toolchain.7z` full pack is **retired**: onboarding needs a runtime pack and Foundry needs `build`,
so nothing requests it — it was 1.18 GB of every ship.

Runtime packs are **not** cached after a verified extract (383 MB archive next to 523 MB extracted is
duplication); `build` stays in `.toolchain-download/cache` for install-from-cache and re-extract.

Two implementation notes worth keeping:

- **The floor reads the embedded manifest, not the one on disk.** A test caught this box's on-disk
  `toolchain/manifest.json` still naming `frontier`; disk-first resolution would have silently
  disabled the gate on any machine with an older pack. Disk-first stays correct for *toolchain
  resolution*; it is wrong for a *launch policy*. `profile_def()` parses `EMBEDDED_MANIFEST`.
- **`install_info` takes the driver major as an argument.** The function stays pure/testable; the
  Tauri command does the async probe and passes it in.

Not landed yet, in order: wizard phase rename + nudge UI and deleting the TS driver table (PR 2b),
`engines.json` + `ENGINE_*` packs (PR 3), EDGE-only installer (PR 4), cleanup (PR 5), majestic
policy-driven rework (last).

Engine sizes are the 2026-10-25 3-arch build: 144.7 MB edge / 144.4 MB stable raw, 107.6 / 112.0 MB as
7z, with a 124.2 MB `ggml-cuda.dll` in both. The old "STABLE is 2.8× EDGE" reading was a FA-all-quants
artifact, not a profile property. Re-measure if either profile's build flags change.
