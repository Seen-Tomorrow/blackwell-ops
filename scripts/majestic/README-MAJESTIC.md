# Majestic — release robot (your eyes only)

You keep coding and using Foundry in DEV. Majestic ships when you say so.

## Easiest: double-click

```
Majestic.bat
```

Menu: **10 BUMP** → CHECK → PACK → SHIP (plus backups and dry-runs).

| Cadence | Menu | Output |
|---------|------|--------|
| **Daily** | 12 → 13 → 14 (or **15** pack+ship) | `Blackwell-Ops-App-vX.Y.Z.7z` (~5 MB) |
| **Weekly** | 1 → 2 → 3 | Full NSIS + App `.7z` + `{provider}-{profile}.7z` packs |
| **Rare** | 11 → 17 | `toolchain.7z` on tag `toolchain` |

## Or npm

```powershell
npm run majestic:bump     # 1.0.0 → 1.0.1 in tauri.conf.json, tauri.conf.dev.json, package.json, Cargo.toml (asks YES)
npm run majestic:check    # full bundle ready? (safe, read-only)
npm run majestic:check:app
npm run majestic:pack     # weekly: NSIS + App 7z + provider packs
npm run majestic:pack:app # daily: lean App 7z only
npm run majestic:ship     # upload staged assets (needs unlock + YES)
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