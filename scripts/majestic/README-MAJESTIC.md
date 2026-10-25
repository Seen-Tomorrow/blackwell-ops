# Majestic — release robot (single engine)

You build and tune in DEV. Majestic ships when you say so. There is **one** engine today
(`ggml-master`, 3-arch, EDGE + STABLE), and majestic enumerates everything from files — there is no
provider list to keep in sync.

## Easiest: double-click

```
Majestic.bat
```

Menu: **10 BUMP** → CHECK → PACK → SHIP (plus backups and dry-runs).

| Cadence | npm | Output |
|---|---|---|
| **Daily app** | `majestic:pack:app` → `majestic:ship` | App `.7z` only (~6 MB) |
| **Release** | `majestic:pack` → `majestic:ship` | App `.7z` + NSIS (EDGE seed, ~140 MB) + `ENGINE_*` packs |
| **Engine only** | `majestic:pack:engines` | Rebuilds `ENGINE_*` + updates `engines.json` |
| **Rare** | `majestic:toolchain` → `majestic:ship-toolchain` | Toolchain packs on tag `toolchain` |

## Source of truth (three files, no others)

| File | Owns |
|---|---|
| `scripts/distribution-policy.json` | `nsisCore` (profiles **inside** the installer — EDGE only), `enginePacks` (profiles published as packs — EDGE + STABLE), `plugins` (empty; not part of this flow), `recommendedEngine` |
| `src-tauri/runtime-catalog/engines.json` | every engine pack: asset name, sha256, size, CUDA, build id (written by `pack-provider-runtime.ps1`, committed) |
| `toolchain/manifest.json` | toolchain packs: `runtime-<cuda>`, `build` + digests (written by `pack-toolchain-packs.ps1`) |

Both manifests are **embedded in the binary**, so the app asks for an exact asset name and verifies the
digest itself. Adding an engine later = edit the policy + pack it; do not edit this script.

## Or npm

```powershell
npm run majestic:bump      # 1.0.0 -> 1.0.1 (asks YES), syncs conf/package/Cargo, refreshes lock
npm run majestic:check     # full: policy rows + Foundry artifacts + installer age + pi pin
npm run majestic:check:app # app-only variant

npm run majestic:pack      # App .7z + NSIS (EDGE seed) + both ENGINE_* packs, digest-verified
npm run majestic:pack:app  # lean App .7z only
npm run majestic:pack:engines   # rebuild engine packs + engines.json (no app build)

npm run majestic:ship      # uploads exactly the files in the pack manifest

npm run majestic:toolchain
npm run majestic:ship-toolchain  # uploads every pack listed in toolchain/manifest.json
```

Dry-run without touching anything: append `-- -DryRun`, e.g. `npm run majestic:ship -- -DryRun`.

## What PACK actually does

1. `Invoke-MajesticCheck` — policy rows, Foundry artifacts for `enginePacks`, pi pin/bundle, installer age.
2. Full variant: `cargo clean -p blackwell-ops --release` → `npm run release` (Vite + tauri build with
   **default** `tauri.conf.json` only) → PE identity assert.
3. `prepare-release-runtime.ps1` stages **`nsisCore` only** (EDGE) into `runtime-bundle/`; the
   installer is built, then `Assert-InstallerSeed` requires EDGE present, no other profile staged,
   and the installer in the 120–200 MB band.
4. `prepare-release-app-only.ps1` rebuilds templates+catalog for the lean App `.7z`.
5. `pack-provider-runtime.ps1` packs **every `enginePacks` profile** from `src-tauri/runtime`, writes
   `engines.json`, and majestic verifies each file's digest before adding it to the pack manifest.
6. Writes `.majestic-out/manifest-vX.Y.Z.json` — the only list SHIP reads.

`SHIP` uploads that manifest (App `.7z`, setup, `ENGINE_*`, nothing filtered by filename) after
re-asserting the App archive PE, running the release test gate, and asking for `YES`.

## Release integrity (App / Full pack)

Pack always:

1. Scrubs `TAURI_CONFIG` / DEV env pollution (critical when launched from DISTRIBUTION inside `tauri dev`)
2. `cargo clean -p blackwell-ops --release` so VERSIONINFO / ProductName cannot stick from a prior conf
3. Builds with **default** `tauri.conf.json` (never merges `tauri.conf.dev.json`)
4. Asserts PE: ProductName = `Blackwell Ops`, FileVersion = conf version, no `.app.dev` / `:1420`
5. Asserts the staged App `.7z` embeds that same PE
6. Asserts the installer carries the seed and sits in the expected size band

Ship re-asserts App archives before `gh release`. A DEV-named or off-by-one PE fails the job instead
of publishing.

## Git tags on SHIP

1. **Local** annotated tag `v1.0.0` on current `HEAD` (if missing)
2. **GitHub Release** via `gh release create v1.0.0 <assets…>` — tag and assets before publish
   (required when release immutability is enabled)
3. **`git push origin tag`** only if `"pushTag": true` in `majestic.config.json` (default **false**)

## First-time unlock (ship only)

```powershell
New-Item -ItemType File -Path scripts/majestic/.majestic-enabled -Force
gh auth login    # if not already logged in
```

## Release assets

| Asset | Tag | Contents |
|---|---|---|
| `CORE_Blackwell-Ops-App-vX.Y.Z.7z` | `vX.Y.Z` | lean app update: exe + templates + catalog + patches + 7z |
| `CORE_Blackwell Ops_X.Y.Z_x64-setup.exe` | `vX.Y.Z` | first install: app + **EDGE seed** (~140 MB compressed) |
| `ENGINE_ggml-master-{edge,stable}-{build}.7z` | `vX.Y.Z` | engine packs (107.8 / 110.2 MB), CRT included |
| `toolchain-rt-{13.4,12.8}-v4.7z`, `toolchain-build-v4.7z` | `toolchain` | split toolchain packs (1.17 GB total) |

The CUDA runtime is **not** bundled: the setup wizard downloads it (383 MB for EDGE) and STABLE is an
optional pack (engine 110 MB + CUDA 12.8 runtime 424 MB) from DOWNLOADS → SOFTWARE.

## One GitHub tag = one version

- Each **BUMP** creates a new `vX.Y.Z`. Ship **once** per version when possible.
- Re-uploading to an **existing mutable** release is allowed (`--clobber`) and majestic edits the
  release notes to match the pack kind.
- **Immutable** releases cannot be changed — bump instead.
- In-app update scans recent tags and picks the newest App asset and newest Full asset independently.

## Testing

### 1. Cheap gates

```powershell
npm run check                 # tsc + vitest + css + cargo (401 tests)
npm run majestic:check        # READY + "1 profile(s) ready" + "engine pack … ready to pack" x2
```

### 2. Pack without shipping

```powershell
npm run majestic:pack -- -DryRun     # shows the plan, builds nothing
npm run majestic:pack                # real run (10-20 min)
```

Then inspect `.majestic-out`:

```powershell
Get-ChildItem .majestic-out | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
# expect: CORE_…App….7z ~6 MB, CORE_…setup.exe 120-200 MB,
#         ENGINE_…edge….7z ~108 MB, ENGINE_…stable….7z ~110 MB, manifest-vX.Y.Z.json

# the installer must carry EDGE and NO STABLE:
7z l ".majestic-out\CORE_*setup.exe" | Select-String "ggml-master\\(edge|stable)"
```

Read `manifest-vX.Y.Z.json` — it must list exactly those four files.

### 3. Fresh-install test (the real one)

```powershell
# silent install into a scratch folder
Start-Process -Wait -FilePath ".majestic-out\CORE_*.setup.exe" -ArgumentList '/S','/D=C:\tmp\bo-test'
C:\tmp\bo-test\blackwell-ops.exe
```

Expected, in order:

1. App opens; no missing-DLL dialog, no engine spawn error.
2. Wizard asks for the model library, then shows **CUDA runtime · 383 MB** (not 1.15 GB) and the
   engine asset `toolchain-rt-13.4-v4.7z`.
3. On a driver below 610 the step instead shows **Driver too old for EDGE** with OPEN DRIVER PAGE +
   CHECK AGAIN; update (or fake it with `BLACKWELL_FAKE_DRIVER_MAJOR=620` in a debug run) and the
   download must start without restarting the app.
4. After the runtime downloads, GGUF scan runs and an engine launches.
5. DOWNLOADS → SOFTWARE shows **STABLE** available: engine 110 MB + CUDA 12.8 runtime 424 MB. Install it,
   switch the active binary (RESET TO SEED returns to the installer copy), launch.
6. Foundry: it offers **Foundry build tools · 366 MB**. The old 1.18 GB full pack is retired.

### 4. Reinstall / uninstall

- Reinstall over the same folder: `runtime\` packs and `toolchain\` must survive.
- Uninstall currently leaves `runtime\`/`toolchain\` behind (known gap) — verify nothing corrupts.

### 5. Ship

```powershell
npm run majestic:ship -- -DryRun   # asset list only
npm run majestic:ship              # type YES
```

Then on the release page confirm the four assets, and that the in-app UPDATE menu offers the new
version. If `gh` returns **HTTP 422**, the tag already exists on an immutable release — bump the patch,
pack, ship.

## Safety

- PACK mirrors into `src-tauri/runtime/<profile>/` (replaces binaries, keeps `config/`).
- Menu **7** backs up the runtime tree; PACK asks first.
- Menu **9 PARANOID** zips source + `src-tauri/runtime/` + `foundry/artifacts/` to `.majestic-backup/`.
- SHIP only touches GitHub. It never commits or pushes source.

## What never gets committed

`scripts/majestic/.majestic-enabled`, `.majestic-secrets`, `majestic.lock`, `.majestic-out/`,
`.majestic-backup/`.
