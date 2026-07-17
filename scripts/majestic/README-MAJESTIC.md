# Majestic — release robot (your eyes only)

You keep coding and using Foundry in DEV. Majestic ships when you say so.

## Easiest: double-click

```
Majestic.bat
```

Menu: **10 BUMP** → CHECK → PACK → SHIP (plus backups and dry-runs).

| Cadence | Menu / npm | Output |
|---------|------------|--------|
| **Daily** | `majestic:pack:app` → ship | `Blackwell-Ops-App-vX.Y.Z.7z` (~5 MB) — UI + core templates + **plugin catalog** |
| **Weekly** | `majestic:pack` → ship | Full NSIS (**ggml-master only**) + App `.7z` + optional `{provider}-{profile}.7z` packs |
| **One plugin** | `majestic:pack:provider` → `majestic:ship:provider` | Single `bee-llama-frontier.7z` (etc.) onto current tag |
| **Rare** | toolchain | `toolchain.7z` on tag `toolchain` |

### Policy source of truth

**`scripts/distribution-policy.json`** (also edited from DEV app → Config → **DISTRIBUTION**):

| Key | Meaning |
|-----|---------|
| `nsisCore` | Engines in Full NSIS only (`ggml-master` frontier+stable) |
| `plugins` | Optional catalog plugins + selective `.7z` packs |

Majestic merges these into `nsisProviders` / `providers` at runtime — do not hand-edit those maps for distribution. CHECK FULL **requires** Foundry only for `nsisCore`.

## Or npm

```powershell
npm run majestic:bump     # 1.0.0 → 1.0.1 (asks YES)
npm run majestic:check    # Full: NSIS engines ready?
npm run majestic:check:app
npm run majestic:pack     # weekly: NSIS (core only) + App 7z + all ready provider packs
npm run majestic:pack:app # daily: lean App 7z only
npm run majestic:ship     # upload staged full/app assets (unlock + YES)

# Single plugin pack (after Foundry-build that provider/profile)
npm run majestic:pack:provider -- -ProviderId bee-llama -ProfileId frontier
npm run majestic:ship:provider -- -ProviderId bee-llama -ProfileId frontier

npm run majestic:toolchain
npm run majestic:ship-toolchain
```

## Version bump

**BUMP** increments the **patch** only (`1.0.0` → `1.0.1`). Syncs `tauri.conf.json`, `tauri.conf.dev.json`, `package.json`, and `Cargo.toml`. Run **before PACK** so the installer name matches.

## Git tags on SHIP

SHIP does **not** commit your code. It does:

1. **Local** annotated tag `v1.0.0` on current `HEAD` (if missing)
2. **GitHub Release** via `gh release create v1.0.0 <assets...>` — creates the tag and attaches assets **before** publish (required when release immutability is enabled)
3. **`git push origin tag`** only if `"pushTag": true` in `majestic.config.json` (default **false**)

So the GitHub release tag is automatic; pushing the tag to `origin` via plain git is optional.

## First-time unlock (ship only)

```powershell
New-Item -ItemType File -Path scripts/majestic/.majestic-enabled -Force
gh auth login    # if not already logged in
```

## Tonight (v1.0)

1. Finish Foundry builds for all required profiles.
2. `npm run majestic:check` — all green?
3. `npm run majestic:pack` — go get coffee (~10–20 min).
4. Test `/.majestic-out/Blackwell Ops_*_x64-setup.exe` if you want.
5. `npm run majestic:ship` — type `YES`.

## Safety

PACK mirror **replaces files** in `src-tauri/runtime/<profile>/` (not `config/`). Menu **7** backs up the whole runtime tree; PACK asks to backup first (default yes).

Menu **9 PARANOID** zips to `.majestic-backup/paranoid-*.zip` (**no compression**, ~15s). Keeps source + `src-tauri/runtime/` + `foundry/artifacts/` only (the 1h rebuild insurance). Skips llama.cpp `engines/`, `runtime-bundle`, repo `target/` dev mirror, `.pdb`, `node_modules`, Rust caches, `target/release/`.

SHIP only touches GitHub. Mutable releases can be re-uploaded (`--clobber`); **immutable** releases cannot be changed after publish (disabling immutability in settings does not unlock old releases). If ship fails with HTTP 422, delete the broken release, **bump patch** (tag cannot be reused), pack, ship again.

Does not delete source, Foundry artifacts, or dev `target/debug/`.

## What never gets committed

- `scripts/majestic/.majestic-enabled`
- `scripts/majestic/.majestic-secrets`
- `scripts/majestic/majestic.lock`
- `.majestic-out/`
- `.majestic-backup/`

## In-app update assets (shipped by Majestic)

| Asset | Channel |
|-------|---------|
| `Blackwell-Ops-App-vX.Y.Z.7z` | Portable App update (exe + templates + 7z) |
| `*Setup*.exe` (no App-Only) | Full NSIS install |
| `{provider}-{profile}.7z` | Selective engine pack (e.g. `ggml-master-frontier.7z`) |
| `toolchain.7z` (tag `toolchain`) | Foundry portable toolchain |

`BINARY_UPDATES_ENABLED` is on. Provider packs use the same download manager + bundled 7z as toolchain.

### One GitHub tag = one version (important)

- Each **BUMP** creates a new `vX.Y.Z`. Ship **once** per version when possible.
- **Daily App pack** → creates release `vX.Y.Z` with App `.7z` + App notes.
- **Weekly Full pack** → prefer a **new bump** so Full gets its own tag with NSIS + App `.7z` + provider packs + Full notes.
- If you re-upload assets to an **existing mutable** release, Majestic now also **edits release notes** to match the pack kind just shipped (so Full does not leave stale App-only body text). Immutable releases still cannot be changed — bump instead.
- In-app updater **scans recent tags** and picks the newest App asset and newest Full asset independently (they need not be the same tag).

### Provider / plugin packs — prepare, ship, test

1. **In DEV app:** add provider (or use existing plugin), tune params/layout, **EXPORT FACTORY** (writes `src-tauri/runtime/{id}/config/{id}-default-config.json`).
2. Add `{id}` + profiles to `majestic.config.json` → `providers` and `scripts/runtime-distribution.ps1` → `OptionalDownloadProviders` (not `nsisProviders` unless it should be in Full install).
3. Foundry-build that provider’s profiles.
4. Either:
   - **Weekly full:** `majestic:pack` packs every ready `providers` profile as `.7z` + NSIS for `nsisProviders` only; or
   - **One plugin:**  
     `npm run majestic:pack:provider -- -ProviderId bee-llama -ProfileId frontier`  
     `npm run majestic:ship:provider -- -ProviderId bee-llama -ProfileId frontier`
5. **Daily App update** ships the **catalog** (`plugins.json`) so users see Install buttons; engines stay separate packs.
6. In app: **CONFIG → UPDATES** — Install Frontier/Stable/Both. Provider appears in PROVIDERS after download.

**New fork (in-app first):** EXPORT FACTORY seeds factory JSON if missing → promote is optional if export already wrote `src-tauri/runtime`. Keep `optionalDownload: true` on factory JSON.