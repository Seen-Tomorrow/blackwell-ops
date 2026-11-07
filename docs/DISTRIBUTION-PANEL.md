# DISTRIBUTION panel

**Status: implemented P1 + P2.** The dashboard, plan protocol, step reporting and history are
live; P3 (catalog tab, `link-setup`) and P4 (scheduler) remain. Read with
`docs/RELEASE-CHANNELS.md` (the release contract this panel drives).

## 1. Goal

One screen that answers three questions and does three things:

1. **What is out there?** — every channel, its latest version/build, and whether what is
   staged locally matches it.
2. **What will happen if I press this?** — a plan is shown before it runs, not discovered in
   a log.
3. **What just happened?** — a live, readable job log and a short history.

Optimised for a solo dev: the common flows are **one button** with no options to get wrong;
everything else is behind a selection. No popups, no second source of truth for names, no
per-action script strings.

## 2. Principles

- **Presets are the product, checkboxes are the escape hatch.** Daily app update = one click.
  Weekly full = one click. Engine ready in Foundry = one click per profile.
- **The panel is a dashboard, not a launcher.** Artifact rows show staged vs published, so
  "did that actually ship?" is answered without opening GitHub.
- **Plans, not action strings.** A click builds a typed `ReleasePlan` (artifacts + phases +
  flags), previews it, and hands the same JSON to the runner. Adding an artifact never adds
  a command string.
- **Idempotent and resumable.** Ship skips bytes already published; `Retry` re-runs only the
  failed phases; staged artifacts survive a failed job.
- **One source of names.** Tags, asset names, retention and release copy come from
  `src-tauri/release-channels.json` — the panel never spells an asset name itself.
- **Separation by product.** Main App, Engines, Link, Toolchain, Catalog are independent
  tabs. When OYM-Link or the server moves to its own repo, only that tab's config changes.

## 3. Layout

Horizontal split, controls left, job output right, draggable divider (reuse
`useCatalogSplitResize` + `catalog-split-workspace` / `catalog-split-handle` — same feel as
OPERATIONS, double-click resets the width).

```
┌ DISTRIBUTION ─────────────────────────────────────────────────────────────────────────┐
│ v1.1.12 · channels: full 1.1.9 · app 1.1.12 · engines 0.8.0-dev(b12017)               │
│ ✓ ship unlock   ✓ gh auth   ✓ lock pinned   ✓ pi 1.4.0   ✓ foundry edge/stable   ⟳     │
├───────────────────────────────────────────┬───────────────────────────────────────────┤
│ [MAIN APP] [ENGINES] [LINK] [TOOLCHAIN]   │ JOB · idle                    last: 12:04 │
│                                           │ ┌───────────────────────────────────────┐ │
│ PRIMARY                                   │ │ ✓ check   ✓ build   ✓ pack            │ │
│ ┌───────────────────────────────────────┐ │ │ ✓ verify  ● publish …  ○ prune        │ │
│ │ APP UPDATE          → v1.1.13         │ │ └───────────────────────────────────────┘ │
│ │ bump · pack app · ship app        RUN │ │ [filter: all ▾] [search…] [copy] [open]  │
│ ├───────────────────────────────────────┤ │ 12:04:11 === pack app ===                │
│ │ FULL RELEASE        → v1.1.13         │ │ 12:04:12 build target 1.1.13             │
│ │ bump · engines · app · NSIS · ship    │ │ 12:05:03 PE identity OK                  │
│ └───────────────────────────────────────┘ │ 12:05:40 created channel release 'app'   │
│                                           │ 12:05:41 uploaded APP_UPDATE_…7z         │
│ ARTIFACTS          staged      published  │ 12:05:44 channel.json published          │
│ ☑ App .7z          1.1.12      1.1.12 ⚠   │ 12:05:44 prune: nothing to delete        │
│ ☐ FULL setup       1.1.9       1.1.9      │                                           │
│                                           │ ── recent ──────────────────────────────  │
│ [Pack] [Ship] [Pack+Ship]   [dry run ▢]   │ 12:04 app   v1.1.12  ok   2m              │
│                                           │ 11:38 engines edge b12017 ok 26m          │
└───────────────────────────────────────────┴───────────────────────────────────────────┘
```

The ⚠ on a staged row means *staged but not the published version* (needs a ship), or
*published but staged is older* (channel is ahead of this checkout). The panel never hides a
mismatch.

## 4. Tabs

### MAIN APP

| Element | Behaviour |
|---|---|
| version + **bump** | patch bump (writes the four version files + lock, as today) |
| **APP UPDATE** preset | bump if the current version is already published → pack app → ship app |
| **FULL RELEASE** preset | bump → pack full (engines first, then app+NSIS) → ship app+full+engines |
| Artifacts | `App .7z` (app channel), `FULL setup` (full channel) — checkbox + state |
| Phases | Pack / Ship / Pack+Ship on the checked rows; dry-run toggle |
| Notes | ship requires the unlock file; a PE/version mismatch blocks, never warns |
| **REFRESH LOCAL REL** (DEV only) | builds the current tree as a REL exe and copies it + the Foundry EDGE artifact + the factory template + the learned cache (fit/VRAM/calibration/model cache, appended forecast log) into the local portable test install (`C:\AI-MASTER\Blackwell OPS portable`, override `BLACKWELL_LOCAL_REL_DIR`). No pack, no bump, no upload. Close REL first; the job refuses if it is running. |

### ENGINES

Per provider (core first, catalog providers later) and per profile:

```
ggml-master
  EDGE   0.8.0-dev  b12017   staged 110 MB  published 0.8.0-dev   [Pack] [Ship] [Pack+Ship]
  STABLE 0.8.0-dev  b12017   staged 111 MB  published —            [Pack] [Ship] [Pack+Ship]
ggml-tom (catalog ON) …
[Pack all] [Ship all] [Pack+Ship all]
```

- No version bump, no app build — shipping one profile is the normal path.
- **Ship** is the one-click default when a pack is staged and the published build differs.
- **Pack+Ship** is the "engine just finished in Foundry" button.
- A row whose staged build equals the published build shows `published` and disables Ship
  (nothing to do) until a new build is packed.
- Retention and manifest changes stay invisible; the job log shows what was pruned.

### LINK

Its own tab from day one, structured exactly like MAIN APP (`APP_UPDATE` / `FULL_SETUP`
channels, own version line, later its own repo setting). Building the link installer stays a
separate action (`Build installer`), because it is a separate codebase.

### TOOLCHAIN

Status-only by default: each pack listed from `toolchain/manifest.json` with digest state and
the note that it changes rarely. One **Ship toolchain** action with a confirm. No preset.

### CATALOG (later)

The catalog providers (forks) live here: `Catalog ON/OFF`, provider/profile engine rows with
the same state/actions as ENGINES. This is the tab that comes back when custom providers
return; it does not change the core tabs.

## 5. Artifact state model

Every row is derived server-side (new `get_distribution_state`), never guessed in the UI:

| State | Meaning | Actions offered |
|---|---|---|
| `absent` | no staged file, nothing published for this channel | Pack |
| `staged` | file in `.majestic-out` with a valid digest, channel has no such version | Ship |
| `published` | staged digest == channel `latest` digest | — (repair only) |
| `stale` | staged, but channel `latest` differs (newer or different digest) | Ship |
| `diverged` | channel latest is *older* than this checkout's version (rolled back / not yet shipped) | Ship |
| `blocked` | preflight says it cannot run (no Foundry artifact, no unlock, version not bumped) | — with reason |

Each row also carries: channel, version/build, size, short digest, publishedAt, and the
blockers that apply. Preflight chips at the top are the same blockers aggregated.

## 6. Interaction model

- **Selection = artifacts.** Phase buttons apply to checked rows. This answers "let me check
  what I want to build" without a checkbox per phase.
- **Plan preview is mandatory.** The plan strip above the action bar reads, e.g.
  `pack app · ship app+full+engines · bump 1.1.12→1.1.13 · 3 assets · ~2 min`. Dry-run runs
  the same plan with `-DryRun` and writes nothing.
- **Presets set the selection and the phases**, so a user who clicks APP UPDATE sees exactly
  what the checkbox equivalent would be before it starts.
- **Retry** appears on a failed job: it re-runs the same plan with completed phases skipped.
- **Ship what's staged** (small link under the action bar) selects every `stale` row.

## 7. Job contract

The panel sends one typed plan; the runner executes it and reports steps.

```json
{
  "schemaVersion": 1,
  "id": "2026-11-07T13-22-01Z-app",
  "product": "blackwell",
  "bump": "patch",
  "dryRun": false,
  "artifacts": ["app", "engines:ggml-master:edge"],
  "phases": ["pack", "ship"]
}
```

- Written to `.majestic-out/release-plan.json`; the detached runner is spawned with
  `-PlanFile` instead of `-Chain <action>`.
- Runner maps artifacts/phases to the existing `majestic` modes, appends
  `@@STEP <id> <state> [message]` lines to the log, and updates `job-status.json` with the
  same step list. The panel renders the step strip from those markers — no guessing from
  free text.
- On finish the runner re-reads each touched channel's `channel.json` and asserts
  `latest.asset`/`sha256` equal what it shipped. A mismatch fails the job even if uploads
  succeeded.
- History: `.majestic-out/jobs/<id>.json` = plan + steps + result + digests + duration. The
  panel lists the last 10 with open-log / reuse-plan.

## 8. Guardrails that encode the workflow

- **Bump rules:** app/full bump only when the current version is already on the channel
  (repair or repeat ship) or when the preset says bump. Engines never bump.
- **Ship unlock** required for every ship phase; the chip shows it before you click.
- **PE identity + archive contents** asserted on every app ship (already in the pipeline).
- **Digest verification** before and after upload; prune refuses to delete the referenced
  asset.
- **Immutable releases** detected and reported as a hard block, with the one rule to remember.
- **Nothing silently succeeds:** every skipped upload, prune and no-op is one log line.

## 9. Deliberately out of scope (for now)

- Scheduling / overnight engine builds (later; the plan JSON is already the input a scheduler
  would produce).
- Model/HF downloads, toolchain packing, Foundry builds — those stay in their own rooms; the
  panel only shows whether their output is ready.
- Multi-repo publishing beyond a per-product `repo` setting.

## 10. Implementation phases

**P1 — shell + state (read-only).** Tabs, splitter, log pane, preflight chips, artifact rows,
`get_distribution_state`. All existing actions still run through the current chain names;
presets map to them. This is the visible redesign.

**P2 — plan protocol.** `ReleasePlan` type + validation in Rust, `-PlanFile` in the runner,
step markers, post-ship verification, history files, Retry. Removes the action-string switch
and the per-profile chain special cases.

**P3 — catalog + link-full.** Catalog tab (plugin providers), `link-setup`, toolchain polish.

**P4 — scheduling (optional).** A cron-like rule produces the same `ReleasePlan`; no new
runner code.

## 11. Files

- UI: `src/components/DistributionDevPanel.tsx` (rewrite), new `src/components/dist/*` for the
  tabs and rows, styles added to the existing `fnd-dev-*` block in
  `src/styles/config-page.css` (no new hex, tokens only).
- Backend: `src-tauri/src/distribution.rs` — `get_distribution_state`, `plan_release`,
  `run_release_plan`, history; reuse `release_channels` for names and retention.
- Runner: `scripts/majestic/run-release-plan.ps1` — `-PlanFile`, step markers; `majestic.ps1`
  keeps the modes but is never called with a hand-built chain string.
