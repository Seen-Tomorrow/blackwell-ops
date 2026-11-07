# Majestic — release robot

You build and tune in DEV. Majestic ships when you say so. There is **one** engine today
(`ggml-master`, 3-arch, EDGE + STABLE), and majestic enumerates everything from files — there is no
provider list to keep in sync.

Release layout is frozen in [`docs/RELEASE-CHANNELS.md`](../../docs/RELEASE-CHANNELS.md): **rolling
channel tags**, class-prefixed asset names, and a `channel.json` manifest per channel as the only
thing the app reads. The channel table (`src-tauri/release-channels.json`) is the single source for
tags, names, retention and release copy.

## Easiest: double-click

```
Majestic.bat
```

Menu: **10 BUMP** → CHECK → PACK → SHIP (plus backups and dry-runs).

| Cadence | npm | Publishes |
|---|---|---|
| **Daily app** | `majestic:pack:app` → `majestic:ship` | `app` channel: App `.7z` + `channel.json` |
| **Release** | `majestic:pack` → `majestic:ship` | `app` + `full` + `engines` channels: App `.7z`, FULL setup, both engine packs |
| **One engine** | `majestic:pack:engines -- -ProviderId ggml-master -ProfileId edge` → `majestic:ship:engines -- -ProviderId ggml-master -ProfileId edge` | rebuilds that pack + `engines.json`, then publishes it to the `engines` channel — no app build |
| **Rare** | `majestic:toolchain` → `majestic:ship-toolchain` | `toolchain` channel |

## Source of truth (four files, no others)

| File | Owns |
|---|---|
| `scripts/distribution-policy.json` | `nsisCore` (profiles **inside** the installer — EDGE only), `enginePacks` (profiles published as packs — EDGE + STABLE), `plugins` (empty; not part of this flow), `recommendedEngine` |
| `src-tauri/runtime-catalog/engines.json` | every engine pack: asset name, sha256, size, CUDA, build id (written by `pack-provider-runtime.ps1`, committed, **embedded in the app**) |
| `toolchain/manifest.json` | toolchain packs: `runtime-<cuda>`, `build` + digests (written by `pack-toolchain-packs.ps1`) |
| `src-tauri/release-channels.json` | channel tags, asset class/product names, retention, release titles/blurbs |

Both pack manifests are **embedded in the binary**, so the app asks for an exact asset name and
verifies the digest itself. Adding an engine later = edit the policy + pack it; do not edit the
scripts. The app refuses a pack whose name/digest its own build does not pin, which is why engine
packs are always built **before** the app compiles (`PACK` does this automatically).

## Or npm

```powershell
npm run majestic:bump      # 1.0.0 -> 1.0.1 (asks YES), syncs conf/package/Cargo, refreshes lock
npm run majestic:check     # full: policy rows + Foundry artifacts + pi pin
npm run majestic:check:app # app-only variant

npm run majestic:pack      # engines first (packs -> engines.json), then app + NSIS
npm run majestic:pack:app  # lean App .7z only
npm run majestic:pack:engines   # rebuild every enginePacks profile + engines.json (no app build)
npm run majestic:pack:engines -- -ProviderId ggml-master -ProfileId edge   # just one
npm run majestic:ship:engines   # publish staged engine packs to the `engines` channel
npm run majestic:ship:engines -- -ProviderId ggml-master -ProfileId edge  # just one

npm run majestic:ship      # publishes every channel the pack manifest names

npm run majestic:toolchain
npm run majestic:ship-toolchain  # uploads every pack listed in toolchain/manifest.json
```

Dry-run without touching anything: append `-- -DryRun`, e.g. `npm run majestic:ship -- -DryRun`.

## What PACK actually does

1. `Invoke-MajesticCheck` — policy rows, Foundry artifacts for `enginePacks`, pi pin/bundle.
2. `cargo clean -p blackwell-ops --release` and the pinned-lock gate.
3. **Full variant, in this order:** `npm run prerelease` (stage the `nsisCore` seed from Foundry
   artifacts) -> `pack-provider-runtime.ps1` (packs every `enginePacks` profile, writes `engines.json`) ->
   `npm run build` -> `tauri build` (NSIS). Engines land before the app compiles, because the PE
   embeds `engines.json`.
4. `prepare-release-app-only.ps1` rebuilds templates+catalog for the lean App `.7z` (always — a
   full pack still ships the templates-only archive).
5. PE identity assert, then `Assert-InstallerSeed` (EDGE present, no other profile, size band).
6. Writes `.majestic-out/manifest-vX.Y.Z.json` with a **channel per asset** — the only list SHIP
   reads.

## What SHIP does (docs/RELEASE-CHANNELS.md §5)

1. Re-asserts the App archive PE (DEV-named or off-by-one fails the job).
2. Annotated local git tag `vX.Y.Z` (provenance; optional push).
3. Release test gate (`npm test` + `cargo test`).
4. Per channel: create the release if missing (`full` carries the **Latest** badge) → upload assets
   → build `channel.json` from the uploaded set + the previously published manifest → upload
   `channel.json` **last** → prune to retention (never the referenced asset) → rewrite the body.
5. LINK assets still go to their own tag; the OYM-Link client migrates to `link` / `link-setup`
   separately.

A failure before step 4's manifest upload leaves the previous `channel.json` in place, so clients
keep working and simply never see a half-published version.

## Release assets

| Asset | Channel | Contents |
|---|---|---|
| `APP_UPDATE_Blackwell-Ops-vX.Y.Z.7z` | `app` | lean update: exe + templates + catalog + foundry patches + 7z (+ pi-ext when its hash changed) |
| `FULL_SETUP_Blackwell-Ops-vX.Y.Z.exe` | `full` | first install: app + **EDGE seed** (~140 MB compressed) |
| `ENGINE_ggml-master-{edge,stable}-{llamaVersion}-{build}.7z` | `engines` | engine packs, CRT included, digest-pinned by the channel manifest; independent of app builds |
| `toolchain-rt-{13.4,12.9}-v4.7z`, `toolchain-build-v4.7z` | `toolchain` | split toolchain packs |
| `LINK_OYM-Link-{build}.7z` | `link` (pending client migration) | remote client update |

Nothing is picked by filename — the app reads `channel.json`.

## Channels are not versions

- Channel tags (`app`, `full`, `engines`, `toolchain`, `link`, `link-setup`) never move and never
  carry a version. The **git tag** `vX.Y.Z` is the provenance record.
- Retention is 10 per channel, pruned on every ship and derived from the manifest's retained list.
- Rollback is a metadata edit: point `channel.json`'s `latest` at the previous entry and upload only
  that file. No asset moves, no re-tag.
- Versions are never reused; `ship` can publish a version that already exists only as a repair.
- **Immutable releases must stay OFF** — rolling channels need mutable releases.

## Testing

### 1. Cheap gates

```powershell
npm run check                 # tsc + vitest + css + cargo
npm run majestic:check        # READY + artifacts + pi pin
```

### 2. Pack without shipping

```powershell
npm run majestic:pack -- -DryRun     # shows the plan, builds nothing
npm run majestic:pack                # real run (10-20+ min)
```

Then inspect `.majestic-out`:

```powershell
Get-ChildItem .majestic-out | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
# expect: APP_UPDATE_…7z ~6 MB, FULL_SETUP_….exe 120-200 MB,
#         ENGINE_…edge….7z ~108 MB, ENGINE_…stable….7z ~110 MB, manifest-vX.Y.Z.json

# the installer must carry EDGE and NO STABLE:
7z l ".majestic-out\FULL_SETUP_*.exe" | Select-String "ggml-master\\(edge|stable)"
```

Read `manifest-vX.Y.Z.json` — every entry must name a `channel`.

### 3. Fresh-install test (the real one)

```powershell
# silent install into a scratch folder
Start-Process -Wait -FilePath ".majestic-out\FULL_SETUP_*.exe" -ArgumentList '/S','/D=C:\tmp\bo-test'
C:\tmp\bo-test\blackwell-ops.exe
```
