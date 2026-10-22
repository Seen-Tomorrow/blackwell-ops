# Download-path integrity — handoff for the SHA checks

Scope: the paths where this app **downloads, extracts, and executes** binaries at runtime.
State of the build side (crate graph + compiler pinning) is in `AGENTS.md` → *npm scripts*.

Measured 2026-10-22 against `main` @ v1.1.1. Every line reference below was read, not inferred.

---

## The problem in one line

`download_manager.rs` reuses the `lfs_oid` field to carry a **release tag** for engine/provider
packs, so the only digest gate in the file silently skips on exactly the artifacts that matter most.

```
download_manager.rs:805    lfs_oid: release_tag,          // <- not a digest
download_manager.rs:1885   if let Some(expected) = lfs_oid.strip_prefix("sha256:") { … }
```

A `release_tag` never starts with `sha256:`, so `strip_prefix` yields `None`, the `if let` body
never runs, and `llama-server.exe` + its CUDA DLLs are extracted into `runtime/` with **no integrity
check at all** — not even corruption detection. The code both "has SHA-256 verification" and does
none. This is the thing to fix first.

## Measured state of every remote-artifact path

| Path | Source of bytes | Verification today |
|---|---|---|
| `binary_update.rs` → `download_binary_update` (engine / provider `.7z`) | GitHub releases | **None.** `lfs_oid` = release tag → gate skipped |
| `plugin_catalog.rs`, `profile_binaries.rs`, `github_releases.rs` | GitHub releases | **None.** 0 hits for sha256/checksum/verify/signature |
| App update `.7z` / NSIS (`binary_update.rs:620`) | GitHub releases | **None** on this path; `tauri-plugin-updater` is registered (`main.rs:238`) but `createUpdaterArtifacts = false`, so no `.sig` is ever produced to verify |
| `pi_code.rs:379-395` (pi harness zip) | GitHub release + `SHA256SUMS` from the **same** release | Advisory: sums download fails → `String::new()`; entry missing → logs *"proceeding with sha256=…"* and installs |
| `download_manager.rs:1884-1909` (HF model weights) | Hugging Face | Real check, **but conditional** on `lfs_oid` being present and `sha256:`-prefixed |
| `external_agents.rs:84-86` `sha256_hex()` | — | Correct helper, already exists, simply not called by the rows above |

**Principle that decides the design:** a digest fetched from the same origin as the artifact is
*corruption detection*, not authentication. Anyone who controls the release tag controls both files.
Corruption checks are worth having — but only a key the app already trusts, or a digest committed in
this repo, stops a substituted asset.

---

## P0 — Make the digest gate real (no format changes, ~1 h)

1. **Stop overloading `lfs_oid`.** Add `expected_sha256: Option<String>` and `source_tag: Option<String>`
   to `DownloadTask` (`download_manager.rs:39`, `:408`). A field whose name promises a digest and
   receives `v1.1.0` will keep defeating every future check. `part_bytes_ready` at `:1616` also takes
   `lfs_oid` — audit what it actually compares.
2. **One gate, one policy, called by every path.** Extend the existing helper into
   `external_agents::verify_digest(bytes_or_path, expected: Option<&str>, Policy) -> Result<(), DigestError>`
   with `Policy::Required` (default for `*.exe *.dll *.7z *.zip *.gz` — anything that gets executed or
   extracted into `runtime/`) and `Policy::Advisory` (weights). `Required` + `expected = None` is an
   **error**, never a shrug. One authoritative implementation, per `AGENTS.md`.
3. **`pi_code.rs`**: missing `SHA256SUMS`, unreadable file, missing entry, and mismatch all return `Err`.
   Delete the "proceeding with sha256=…" branch at `:394`.
4. **DEV escape hatch**, so iteration is not blocked: `#[cfg(debug_assertions)]` plus
   `BLACKWELL_ALLOW_UNVERIFIED_DOWNLOAD=1`, logged at `error!` on every use. Never compiled into REL.

**Acceptance:** no code path reaches `extract_7z_archive()` or spawns an `llama-server.exe` unless a
digest was compared and matched, or an explicit REL-fatal error was returned.

## P0 — Get the digests from somewhere the attacker does not control (~half a day)

Write the expected digest into **source in this repo**, and have `majestic` fill it in:

- `runtime-catalog/plugins.json`, the toolchain `manifest.json`, and factory provider JSON gain
  `sha256` per asset. The app then compares against a compiled-in/repo-reviewed value; the digest
  arrives over a different trust path than the bytes.
- `majestic pack` computes each asset's digest and `majestic ship` refuses to upload any asset whose
  digest is not recorded and committed. Add to `scripts/prepare-release-*.ps1`: hard exit when an
  artifact has no digest entry — so "shipped without a digest" becomes unrepresentable, not forgotten.
- Emit `SHA256SUMS` for provider/toolchain archives using the format `pi_code.rs:parse_sums_expected`
  already parses, so one convention covers pi, packs, and toolchain.
- No migration shims for existing catalog entries (per `AGENTS.md`: no installed base — change the shape).

## P1 — Authenticity: sign the update, you already have the crate

`minisign-verify v0.2.5` is **already in the graph** (via `tauri-plugin-updater`), and
`tauri.conf.json` already carries a `pubkey`. So signing needs no new dependency and no new format:

- Decide which story is real and delete the other. Either flip `createUpdaterArtifacts = true` and let
  `tauri-plugin-updater` verify its own `.sig`, **or** keep the `.7z` + `download_manager` flow and
  ship `CORE_*.7z.minisig`, verified in `binary_update.rs` before extraction with the pubkey compiled in.
  Right now it is both-half-done: a plugin registered for a signature that is never produced.
- Private key stays off the build machine (CI has no key by design; releases ship locally).
  `majestic ship` must fail, not warn, if signing fails.

## P1 — Verify before the bytes become executable

`pi_code.rs` verifies in-memory then writes — fine. `download_manager.rs` verifies a **path** after
shard assembly: confirm the verified path is the same path later extracted and executed. Verify →
atomic rename → extract. Never verify a temp file a later step can swap.

## P2 — Extraction hardening

`archive_util.rs:25 extract_7z_archive` uses 7z with `-o{dest}` as one argv (path-safe per `AGENTS.md`),
but no `..`-entry guard is visible in that function. Test a crafted `.7z` containing `..\..\evil.dll`
and confirm rejection; add the guard at extraction if it extracts.

---

## Tests to add — invariants, never snapshots (`AGENTS.md` law)

- `verify_digest` table: `Required` + `None` → `Err`; `Required` + mismatch → `Err` naming expected/got;
  `Advisory` + `None` → `Ok` and one `warn!`. Pure function, no I/O.
- `parse_sums_expected`: absent name, empty file, CRLF, `sha256:`-prefixed and bare hex columns.
- Policy classifier: `llama-server.exe` → `Required`, `model.gguf` → `Advisory`.
- Structural invariant in `src/lib/repoInvariants.test.ts`, like the existing `Instant`-subtraction
  scanner: no `.rs` calls `extract_7z_archive` without a `verify_digest` in the same function or its
  direct caller. **Plant the violation first and watch it fail** — a scanner that matches nothing
  passes vacuously.

## Do not

- No new hashing crate, no second algorithm, no bespoke signature format — `sha2 = "0.11"` is a direct
  dependency and `minisign-verify` is already in the graph.
- No "if an older version wrote X" fallbacks for catalog/manifest fields. No installed base.
- No `backdrop-filter`, no new `!important`, unrelated to this file — noted only because the front-end
  rules are strict and this doc touches no CSS.
- Do not trust a green `Complete!` here: assert on what the gate actually did (`AGENTS.md`: verify
  build output, not build exit code). A digest check that skips is invisible in a successful build.
