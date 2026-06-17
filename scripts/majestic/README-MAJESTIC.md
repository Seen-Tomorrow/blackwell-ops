# Majestic — release robot (your eyes only)

You keep coding and using Foundry in DEV. Majestic ships when you say so.

## Easiest: double-click

```
Majestic.bat
```

Menu: **10 BUMP** → CHECK → PACK → SHIP (plus backups and dry-runs).

## Or npm

```powershell
npm run majestic:bump     # 1.0.0 → 1.0.1 in tauri.conf.json, tauri.conf.dev.json, package.json, Cargo.toml (asks YES)
npm run majestic:check    # am I ready? (safe, read-only)
npm run majestic:pack     # mirror → bundle → build installer (+ optional zips)
npm run majestic:ship     # upload to GitHub (needs unlock file + type YES)
```

## Version bump

**BUMP** increments the **patch** only (`1.0.0` → `1.0.1`). Syncs `tauri.conf.json`, `tauri.conf.dev.json`, `package.json`, and `Cargo.toml`. Run **before PACK** so the installer name matches.

## Git tags on SHIP

SHIP does **not** commit your code. It does:

1. **Local** annotated tag `v1.0.0` on current `HEAD` (if missing)
2. **GitHub Release** via `gh release create v1.0.0` — this creates the **tag on GitHub** and uploads assets
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

SHIP only touches GitHub (re-upload replaces release assets). Does not delete source, Foundry artifacts, or dev `target/debug/`.

## What never gets committed

- `scripts/majestic/.majestic-enabled`
- `scripts/majestic/.majestic-secrets`
- `scripts/majestic/majestic.lock`
- `.majestic-out/`
- `.majestic-backup/`

## Optional: in-app binary updates later

1. Set `"upload.binaryZips": true` in `majestic.config.json`.
2. Re-run `pack` + `ship`.
3. Set `BINARY_UPDATES_ENABLED = true` in `src-tauri/src/binary_update.rs`.

Zip names must stay `{provider}-{profile}.zip` (e.g. `ggml-master-vanguard.zip`).