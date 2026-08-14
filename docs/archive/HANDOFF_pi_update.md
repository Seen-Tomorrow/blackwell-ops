# Handoff — PI update (broken junction fix + DEV-only update button)

Two related pieces of work landed together. This handoff captures why, what changed,
what's verified, and what is **still untested** so a later session can pick it up.

---

## 1. The original build failure (`npm run dev` predev)

### Symptom

`npm run dev`'s `predev` (`scripts/sync-dev-runtime.ps1`) died at the pi-ext mirror:

```
Copy-Item : Could not find a part of the path
'...\src-tauri\pi-ext\pi-subagents\node_modules\@earendil-works\pi-coding-agent'
```

### Root cause

`src-tauri/pi-ext/pi-subagents/package.json` (upstream `nicobailon/pi-subagents`,
v0.49.0) declares a **devDependency**:

```json
"@earendil-works/pi-coding-agent": "file:./test/fixtures/pi-coding-agent-shim"
```

That is the upstream repo's **test-only shim**. Running `npm install` inside the bundle
created a Windows **junction** at `node_modules/@earendil-works/pi-coding-agent`
pointing to `test/fixtures/pi-coding-agent-shim` — which is **not shipped** (npm `files`
excludes `test/`), so the junction was **dangling**. `Copy-Item -Recurse` follows
junctions and hard-failed on the broken target.

### Fix (merged)

1. **Removed the dangling junction** from the source bundle (gitignored artifact — not a
   tracked change). `@earendil-works` now holds only `pi-agent-core`, `pi-ai`, `pi-tui`.
   `pi-coding-agent` is the **host** pi binary and is provided at runtime by pi itself
   (`peerDependenciesMeta` marks it optional), so it does not belong in the bundle.
2. **Hardened `scripts/sync-dev-runtime.ps1`** — added `Remove-BrokenReparsePoints`,
   called before the pi-ext mirror, so a future dangling link is pruned instead of
   hard-failing `npm run dev`.

---

## 2. DEV-only "UPDATE pi" button (Harness connect wizard)

### What it does

A 1-click `UPDATE` button in the **Harness connect** wizard (`MultiAgentBooster.tsx`)
that:

1. Fetches the newest pi release tag from GitHub (`earendil-works/pi`).
2. Reinstalls the pi binary at that version (download → SHA-256 verify → extract → install).
3. Refreshes the bundled pi-subagents extension from npm
   (`npm install pi-subagents@latest --omit=dev` in a temp project), then copies the
   package + runtime deps (`jiti`/`typebox`/`yaml`) into `src-tauri/pi-ext/pi-subagents`.
4. Mirrors `src-tauri/pi-ext` → `src-tauri/target/debug/pi-ext` so the running DEV app
   picks it up.

### Gating (deliberate product decision)

**DEV-only.** The app pins a verified pi (`PINNED_VERSION` in `pi_code.rs`, currently
`0.83.0`) for engine compatibility; following GitHub "latest" is unverified and could
break a user's harness. Enforced twice:
- Frontend: button hidden unless `isDevBuild()` (`src/lib/build.ts`).
- Rust: `pi_code_update_latest` refuses to run unless `cfg!(debug_assertions)`.

Regular users get pi updates automatically via app releases (the pinned version bumps,
pi re-installs on next open). No user-facing update button.

### Key files

| File | Change |
|------|--------|
| `src-tauri/src/pi_code.rs` | Extracted `install_pi_version`; added `pi_code_update_latest`, `dev_pi_ext_src`, `refresh_pi_subagents_bundle`, `sync_dev_pi_ext` |
| `src-tauri/src/github_releases.rs` | Added `fetch_latest_release_tag(repo)` |
| `src-tauri/src/main.rs` | Registered `pi_code_update_latest` |
| `src/components/MultiAgentBooster.tsx` | `piUpdating` state, `updatePiToLatest` handler, DEV-gated UPDATE button |
| `src/styles/cockpit.css` | `.atomcode-wizard__update` styles |
| `scripts/sync-dev-runtime.ps1` | `Remove-BrokenReparsePoints` guard (from fix 1) |

### Verification status

- `cargo check` → **passes** (only pre-existing dead-code warnings).
- `tsc --noEmit` → **clean**.
- `scripts/sync-dev-runtime.ps1` runs successfully; `target/debug/pi-ext` confirmed to
  have **no broken junctions** and no empty `pi-coding-agent` dir.

---

## 3. Known gaps / UNTESTED (please verify on a real DEV machine)

These could not be exercised in the sandbox (network + npm-cache writes blocked):

- **Live npm bundle refresh** — `refresh_pi_subagents_bundle` runs
  `npm install pi-subagents@latest --omit=dev` in a temp dir, then copies
  `node_modules/pi-subagents` + `jiti`/`typebox`/`yaml`. Needs:
  - network access to `registry.npmjs.org`,
  - `npm` on PATH (the DEV machine has it),
  - write access to `src-tauri/pi-ext` (the repo source tree) — writing to the source
    tree from a running app is intentional but unusual; confirm it behaves.
  - **Confirm the resulting bundle has no dangling `pi-coding-agent` junction** and
    that `jiti`/`typebox`/`yaml` are present in its `node_modules`.
- **End-to-end button flow** — click UPDATE in a dev build with pi installed, watch the
  phase strip (download → verify → finalize), confirm the pi binary version bumps and
  the isolated pi-home re-syncs on next launch.
- **Version-stamp re-sync** — `sync_bundled_subagents` re-copies the bundle into the
  pi-home only when the bundled `package.json` version differs from the installed
  `.blackwell-version` stamp. Confirm a newer bundle triggers the re-sync.

### Things to watch for when testing

- If `npm install` fails, the error surfaces inline (bundle left in prior state — the
  temp dir is cleaned up on failure, and the old bundle is only removed after a
  successful install).
- After an update, the next `npm run dev` predev re-mirrors pi-ext (fingerprint
  changes) — idempotent, no action needed.
- The `Remove-BrokenReparsePoints` guard in the sync script is the safety net if a
  future npm install ever reintroduces a dangling junction.

---

## 4. Future notes / gotchas

- **Never run a plain `npm install` inside `src-tauri/pi-ext/pi-subagents`** — it
  recreates the broken `pi-coding-agent` shim junction. Use
  `npm install --omit=dev` (or the UPDATE button).
- The pi binary and the pi-subagents bundle versions don't need to match exactly
  (peers are optional / host-provided), but when bumping the pi binary to a new major,
  refresh the bundle to a compatible release at the same time.
- `pi-ext/` is a tauri resource (`"pi-ext/": "pi-ext/"` in `tauri.conf.json`) — a
  **release** build bundles whatever is in `src-tauri/pi-ext` at build time. Keep the
  bundle in sync before shipping.
- `src-tauri/pi-ext` is gitignored — its contents are not in version control.
