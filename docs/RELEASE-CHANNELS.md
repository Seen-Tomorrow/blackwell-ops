# Release channels

**Status: FROZEN 2026-11-07 — implemented 2026-11-07.** This is the final release layout. Change it
only for the reasons listed in §13 — not for taste.

Implementation: the client resolves `app` / `full` / `engines` through `channel.json`
(`src-tauri/src/release_channels.rs`, `github_releases.rs`), the packer/ship script publishes
assets + manifest per channel (`scripts/majestic/majestic.ps1`), and the channel table lives in
`src-tauri/release-channels.json` (read by both sides). Old per-version releases are retired at the
first channel ship.

## 1. Model

Three separate things, and they never mix again:

| Thing | Is | Lives | Consumed by |
|---|---|---|---|
| **Channel** | a rolling GitHub release tag | one per artifact class | humans, website |
| **Asset** | an opaque file with a human-readable name | inside its channel release | download only |
| **Manifest** | `channel.json` — the machine interface | asset at the top of every channel release | the client |

Rules that follow:

- A channel tag is **never** a version and is **never** moved, renamed or deleted.
- The client reads **manifests only**. It never parses filenames, never scans release lists,
  never guesses a class from words like `setup` / `app`.
- Filenames exist for humans, the website, and pruning. Changing a filename must never
  require a client change (`latest.asset` in the manifest is authoritative).
- Provenance lives in an annotated git tag `v<version>` per ship (commit + notes). The
  channel release is only a pointer.

## 2. Channels

| Tag | Class prefix | Example asset | Version unit | Retention | Latest badge |
|---|---|---|---|---|---|
| `full` | `FULL_SETUP_` | `FULL_SETUP_Blackwell-Ops-v1.1.13.exe` | semver | 10 | **yes** |
| `app` | `APP_UPDATE_` | `APP_UPDATE_Blackwell-Ops-v1.1.13.7z` | semver | 10 | no |
| `engines` | `ENGINE_` | `ENGINE_ggml-master-edge-0.8.0-dev-b12017-5047748f.7z` | build id | 10 builds (20 files) | no |
| `toolchain` | *(existing names)* | `toolchain-rt-13.4-v4.7.7z` | manifest version | 10 sets | no |
| `link` | `OYM_link_` | `OYM_link_b2047.7z` | build integer | 10 | no |
| `link-setup` | `OYM_link_SETUP_` | `OYM_link_SETUP_v0.1.0.exe` | semver | 10 | no |

`full` is the only release marked **Latest**, so `…/releases/latest` is the installer page
the website links to. Everything else is `--latest=false`.

Retention of 10 is safe: updates fetch the newest; the retained list is for rollback and
manual downloads, not for stepping through versions. The toolchain tag is the exception in
size (~400 MB per pack, 3 packs per manifest version); raise/lower its retention in
`src-tauri/release-channels.json` if 10 sets ever becomes a storage concern.

## 3. Naming grammar

```
<CLASS>_<Product>-<Version>.<ext>        # app, full, engines
<CLASS>_<Version>.<ext>                  # link, link-setup (class names the product)
```

- `CLASS` ∈ `APP_UPDATE | FULL_SETUP | ENGINE | OYM_link | OYM_link_SETUP` — **the class
  prefix is mandatory** and is the only thing that identifies a file's role. No
  `contains("setup")` guessing, ever.
- `Product` ∈ `Blackwell-Ops | <provider-id>`; empty for the OYM-Link channels, whose class
  already reads `OYM_link`.
- `Version`:
  - app / full / link setup → `v<major>.<minor>.<patch>`
  - engines → `[<llama-version>-]b<build>-<sha8>`: the llama version (`0.8.0-dev`) is the only
    human-readable part and comes first; the build id is the machine identity. Forks that print
    no semver drop the version segment.
  - link update → `b<build>` (the link client ships builds, not versions)
- `ext`: `.7z` for archives, `.exe` for installers.
- Toolchain keeps its existing names (`toolchain-<kind>[-<cuda>]-v<manifest>.7z`): the
  embedded `toolchain/manifest.json` pins them exactly, and they are already unambiguous.

Examples:

```
FULL_SETUP_Blackwell-Ops-v1.1.13.exe
APP_UPDATE_Blackwell-Ops-v1.1.13.7z
ENGINE_ggml-master-edge-0.8.0-dev-b12017-5047748f.7z
ENGINE_ggml-master-stable-0.8.0-dev-b12017-5047748f.7z
OYM_link_b2047.7z
OYM_link_SETUP_v0.1.0.exe
```

**Linking rule:** a new channel or class may be added at any time. Adding one never
renames an existing asset and never changes the parser for the others.

## 4. `channel.json`

Fixed asset name in every channel release (except `toolchain`, see §13). Stable URL:

```
https://github.com/Seen-Tomorrow/blackwell-ops/releases/download/<tag>/channel.json
```

### 4.1 Product channels (`app`, `full`, `link`, `link-setup`)

```json
{
  "schemaVersion": 1,
  "channel": "app",
  "product": "Blackwell-Ops",
  "generatedAt": "2026-11-07T12:00:00Z",
  "latest": {
    "version": "1.1.13",
    "commit": "3780116",
    "asset": "APP_UPDATE_Blackwell-Ops-v1.1.13.7z",
    "sizeBytes": 7123456,
    "sha256": "<64 hex>",
    "publishedAt": "2026-11-07T11:59:00Z",
    "notes": "markdown for this version"
  },
  "releases": [
    { "version": "1.1.13", "asset": "...", "sha256": "...", "sizeBytes": 0, "commit": "3780116", "publishedAt": "..." }
  ]
}
```

- `latest` is what clients act on. `releases[]` is the retained history (max 10), newest
  first, and is the **only** source the prune step reads.
- `notes` is the per-version markdown the app shows; the release body is for humans.
- `link` manifests add `"build": <integer>` (the update unit for that client); Blackwell
  clients ignore unknown fields.

### 4.2 Engine channel (`engines`)

```json
{
  "schemaVersion": 1,
  "channel": "engines",
  "generatedAt": "2026-11-07T12:00:00Z",
  "engines": [
    {
      "provider": "ggml-master", "profile": "edge",
      "build": "b12017-5047748f",
      "version": "0.8.0-dev",
      "asset": "ENGINE_ggml-master-edge-0.8.0-dev-b12017-5047748f.7z",
      "sha256": "<64 hex>", "sizeBytes": 115343360,
      "cuda": "13.4", "recommended": true
    }
  ]
}
```

`build` is the machine identity used for comparison; `version` is llama's human-readable
label (it is what the ENGINE page renders as `version: 0.8.0-dev, build: 12017`, and may be
empty for forks that print no semver).

**The manifest is authoritative.** Engines are independent of app builds: `Pack+Ship
<profile>` publishes one pack plus an updated `channel.json`, and every installed app offers
it immediately — no app release required. The embedded
`src-tauri/runtime-catalog/engines.json` is the build-time record and the **offline/repair
fallback**: only when the channel cannot be read does the client fall back to the exact
name + digest its build pins.

## 5. Publish order (atomic)

Every ship, in this order — no exceptions:

1. Build and stage the asset(s).
2. Verify locally: PE identity, version == `tauri.conf.json`, archive contains
   `foundry/patches`, digests reproducible.
3. Upload assets to the channel release (`--clobber`).
4. Re-read the release from the API and assert every uploaded asset is present with the
   expected size (and, where GitHub publishes it, digest).
5. Generate `channel.json` **from the uploaded set** (never from the staging dir alone).
6. Upload `channel.json` **last**.
7. Prune to retention — never before step 6, never the asset named by `latest`.
8. Update the release body (channel blurb + latest notes + retained table).
9. Create/push the annotated `v<version>` git tag.

A failure at any step leaves the previous `channel.json` in place, so clients keep working
and simply do not see the half-published version.

## 6. Pruning

- Input: the new manifest's `releases[]` (or `engines[]` build list). Delete assets older
  than the retained window.
- Never delete the asset referenced by `latest`.
- Never prune if step 4 failed or if the manifest was not uploaded.
- Every deletion is logged to the job log (`[prune] delete <asset>`).

## 7. Rollback

Rollback is a metadata edit, not a re-upload:

1. Point `latest` at the previous `releases[]` entry.
2. Upload only `channel.json`.
3. If the bad asset must disappear, prune it explicitly after the manifest no longer
   references it.

Version numbers are never reused, so a client that already saw `1.1.13` will happily
"downgrade" to `1.1.12` only if `latest` says so — which is exactly what rollback means.

## 8. Version rules

- **app / full / link-setup:** semver, strictly increasing per product. Ship refuses to
  publish a version ≤ the current `latest` (a deliberate same-version repair uploads
  `channel.json` only, and says so).
- **engines:** identity is `b<build>-<sha8>`; never rebuild under the same name, never
  reuse a build id for different bytes.
- **link update:** monotonically increasing build integer; the manifest also carries the
  product version for display.
- **toolchain:** identity is the manifest version (`v4.7`) embedded in the asset name.

## 9. Client resolution (target state)

| Channel | How the client resolves |
|---|---|
| `app` | fetch `app/channel.json` → `latest.version > current` → download `latest.asset`, verify `latest.sha256` |
| `full` | same; **offered only when newer** (no downgrade offer) |
| `engines` | fetch `engines/channel.json` → entry for provider/profile → download `asset`, verify its `sha256`; `build` drives the update badge, `version` the label. Embedded `engines.json` is only the offline/repair fallback |
| `toolchain` | unchanged: embedded `toolchain/manifest.json` names + digests, fixed `toolchain` tag |
| `link` / `link-setup` | the OYM-Link client reads its own manifests; Blackwell does not consume them |

The Blackwell client never scans releases and never parses asset names. Engine runtime
packs (CUDA) are still queued before the engine pack, unchanged.

`full` is for first install / repair. A machine with no engines gets them from the `engines`
channel, not from an old full setup — that removes the current "offered v1.1.9 Full while
running v1.1.12" downgrade path.

## 10. Notes and provenance

- Release body per channel: one-line blurb, the latest version's notes, and a retained
  versions table. **The body never repeats the release title** — GitHub renders the title
  above it, so an H1 with the same text shows it twice.
- Shipping is idempotent: an asset already on the channel with the same size (and digest,
  when GitHub reports one) is not re-uploaded, so a body/manifest refresh costs seconds.
- The annotated `v<version>` git tag message carries the same notes. Git is the durable
  archive; the release body is the current pointer.
- `full` carries the Latest badge so `…/releases/latest` is always the installer.

## 11. OYM-Link

OYM-Link is a separate product line with its own version and its own channels. It shares
the repository today; if it ever moves to its own repo, only its two channels move and
nothing in the Blackwell channels or client changes.

## 12. Cutover checklist (one-time, no migration)

There are no users, so this is a hard cut — no dual-read, no legacy names, no shims.

1. Land the client + packer cutover in one series.
2. Ship once per channel to create: `full`, `app`, `engines`, `link`, `link-setup`
   (`toolchain` already exists).
3. Verify on a clean install: app update, full offer, engine install from `engines`.
4. Delete the old per-version releases (`v*`) and `link-v0.1.0`. Keep the git tags.
5. Point the website at `…/releases/tag/full`.

## 13. Non-negotiables

- **GitHub "immutable releases" stays OFF.** Rolling channels need mutable releases; if it
  is ever enabled, this design has to change, which is the one thing to avoid.
- `channel.json` is required in every product channel. Toolchain may add one later
  (additive; clients ignore unknown assets).
- Asset class prefixes are frozen per channel. Adding a channel is fine; renaming one is not.
- Manifest is published last, pruning happens after, versions are never reused.
- One writer: only the release tool uploads to channel tags. No manual `gh release upload`.

## 14. Retired concepts (delete, do not keep)

- Per-version release tags as the update source.
- `CORE_` / `PLUGIN_` asset prefixes and every legacy name fallback.
- Name heuristics: `is_app_update_archive`, `is_app_only_nsis_installer`,
  `is_full_bundle_nsis_installer`, `is_version_release_tag`, `provider_pack_asset_candidates`.
- Release-list scanning (`fetch_recent_version_releases*`) for offers and packs.
- `link-v<version>` release tags.
- The "need engines → offer an older Full setup" path.
