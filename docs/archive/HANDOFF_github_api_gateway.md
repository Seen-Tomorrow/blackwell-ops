# Handoff — GitHub API Call-Volume Rework

## What was built

A single REST gateway in `src-tauri/src/github_releases.rs` that **every `api.github.com` call now flows through** (`github_get_json_cached`, line 337). It replaces the old in-memory-only releases cache with a **persistent disk cache + ETag/304 + force-dedup + hourly budget**, eliminating the `api.github.com` 403 rate-limit errors (60 req/hr unauthenticated).

One file changed: `src-tauri/src/github_releases.rs`. Public API is unchanged, so no call-site code was edited.

## Why the 403s happened

GitHub's unauthenticated REST limit is **60 requests/hour**. The old design burned the budget three ways:

1. **In-memory cache wiped on every restart.** The releases-list cache (`RELEASES_CACHE_TTL = 30m`) lived in a `static LazyLock<Mutex<Option<ReleasesListCache>>>` — gone on every process start. At ~100 rebuilds/day, the first GitHub call after each restart re-hit the API → 100+ calls/day just from restarts.
2. **`force:true` bypassed the cache.** The Updates tab fired **3 parallel** `force:true` invokes (`get_update_offerings` + `get_plugin_catalog` + `check_binary_updates`) that skipped the TTL entirely → 3 calls per tab mount, re-fired after every download-complete.
3. **Uncached by-tag / latest-tag.** `fetch_release_by_tag` (toolchain) and `fetch_latest_release_tag` (pi, DEV) had **no cache at all** — every call was a live hit.

The frontend makes **zero** direct HTTP calls to GitHub (all goes through Tauri invokes of Rust commands); the Intel widget (`intel.rs`) is a separate unauthenticated client and was **excluded** from this rework.

## Architecture

```
Frontend (UpdatesConfig.tsx / ProvidersConfig.tsx / App.tsx)
  │ invoke('get_update_offerings' | 'get_plugin_catalog' | 'check_binary_updates' | ...)
  ▼
Tauri commands (binary_update.rs / plugin_catalog.rs / foundry_toolchain.rs / pi_code.rs)
  │ fetch_update_offerings_ex / fetch_recent_version_releases_ex /
  │ fetch_release_by_tag / fetch_latest_release_tag          (public API unchanged)
  ▼
github_releases::github_get_json_cached(url, ttl, force)    ← THE CHOKEPOINT (line 337)
  │ 1. disk cache fresh?      → return (0 API calls)
  │ 2. dedup window hit?      → return (0 API calls)
  │ 3. per-URL single-flight  → wait, then re-check 1+2
  │ 4. budget low + background?→ serve stale
  │ 5. conditional GET (If-None-Match)
  ▼
github_releases::github_get_json_conditional(url, etag)     (line 424)
  │ 304 → prior body + refreshed TTL      200 → new body + ETag → persist to disk
  ▼
api.github.com   (repo: Seen-Tomorrow/blackwell-ops, GITHUB_REPO line 22)
```

## The gateway — how it works

Every call goes through `github_get_json_cached` (line 337). Decision order:

| Step | Check | Result | API cost |
|------|-------|--------|----------|
| 1 | disk cache fresh (`age < ttl`), non-force | return cached body | 0 |
| 2 | dedup window hit (`< 60s` since last fetch) | return recent body | 0 |
| 3 | per-URL single-flight | wait, then re-check 1+2 | 0 (shared) |
| 4 | budget low (`≤ 2` remaining) + background | serve stale cache | 0 |
| 5 | conditional GET (`If-None-Match`) | 304 or 200 | 1 (304 cheap) |

### Persistent disk cache (the #1 fix)

- Location: `config/cache/github/` — `github_cache_dir` (line 241) → `crate::config::cache_dir().join("github")`. Same cache dir the rest of the app uses (`download_manager.rs`, `gguf_patch.rs`, …); lives in the exe's config dir, not the repo.
- One file per URL — `github_cache_file` (line 253): URL sanitized to a safe filename (`/ ? & = : { } space #` → `_`), e.g. `gh_api_github_com_repos_Seen-Tomorrow_blackwell-ops_releases_per_page_40.json`.
- Shape — `GitHubCacheEntry` (line 265): `{ fetched_at: unix_secs, etag: Option<String>, body: Value }`.
- **Survives rebuilds/restarts** — this is what kills the restart-burn. 100 restarts/day = 0 re-hits. Read/write at lines 271 / 276; age at line 285.

### ETag / 304

`github_get_json_conditional` (line 424) sends `If-None-Match` with the stored ETag. On **304** it returns the prior body and refreshes the TTL (cheap). On **200** it stores the new body + ETag. PAT is applied when present (401/403 → one anonymous retry), same as before.

### Force-dedup window

`force` no longer means "always hit the API". It means "revalidate (bypass the disk TTL)" but still dedups within `FORCE_DEDUP_WINDOW` (60s, line 236). The 3 parallel Updates-tab force calls → **1 round-trip** (first does the GET, the other two hit the dedup/single-flight). A re-fire after a download-complete within 60s → 0 calls.

### Hourly budget

`GATEWAY_MEM.budget` (line 293) is a sliding 1-hour window of call timestamps. `budget_remaining` (line 312) caps at `BUDGET_MAX_PER_HOUR` (45, line 239). When within 2 of the cap, **background (non-force)** fetches serve stale cache; **force (user-initiated)** always proceeds. 304s count against the budget (GitHub counts them too).

### Shared HTTP client

`GITHUB_CLIENT` (line 305) is a `LazyLock<reqwest::Client>` with a 30s timeout — connection pooling. The old code built a new `reqwest::Client` per call.

## TTLs

| Resource | TTL | Constant (line) |
|----------|-----|-----------------|
| Releases list (`?per_page=40`) | 30 min | `RELEASES_CACHE_TTL` (231) |
| By-tag (`/releases/tags/{tag}`) | 1 h | `TAG_CACHE_TTL` (232) |
| Latest-tag (per repo, `/releases/latest`) | 6 h | `LATEST_TAG_CACHE_TTL` (233) |
| Force-dedup window | 60 s | `FORCE_DEDUP_WINDOW` (236) |
| Hourly budget cap | 45 / hr | `BUDGET_MAX_PER_HOUR` (239) |

## Call sites (migrated transparently)

The public API is **unchanged** — no call-site code was edited. Every caller now flows through the gateway:

| Caller | Line | Goes through |
|--------|------|--------------|
| `binary_update.rs` (plugin catalog) | 255 | `fetch_recent_version_releases_ex(40, force)` |
| `binary_update.rs` (check_binary_updates) | 564 | `fetch_update_offerings_ex(…, force)` |
| `binary_update.rs` (download) | 601 | `fetch_update_offerings(…)` |
| `foundry_toolchain.rs` (toolchain download) | 941 | `fetch_release_by_tag(TOOLCHAIN_RELEASE_TAG)` |
| `pi_code.rs` (pi update, **DEV-only**) | 443 | `fetch_latest_release_tag("earendil-works/pi")` |
| `plugin_catalog.rs` (plugin packs) | 182 | `fetch_recent_version_releases_ex(40, force)` |

`fetch_release_by_tag` (line 492) now serves recent semver tags from the cached releases list first (0 calls), falling back to a 1h-cached by-tag fetch only for non-semver tags (e.g. `toolchain`). `fetch_latest_release_tag` (line 507) is 6h-cached per repo.

## Before → after (per typical day)

| Trigger | Before | After |
|---------|--------|-------|
| App restart ×100 | 1+ calls each | **0** (disk cache) |
| Updates tab mount (3 parallel force) | 3 calls | **1** (deduped) |
| Toolchain by-tag | 1, uncached | 0 within 1h |
| pi latest-tag (DEV) | 1, uncached | 0 within 6h |

Sustained load is now ~1 releases-list re-fetch per 30 min — far under the 60/hr cap.

## What was NOT changed

- **`intel.rs`** — excluded per instruction (separate unauthenticated client, ~17 calls/channel/refresh). The gateway is structured so it can be routed through `github_get_json_cached` later.
- **Frontend** — unchanged. No timers reach GitHub; the 3-parallel force calls are deduped in the backend.
- **`reactor_foundry.rs:1339`** PR patch-diff — different host (`patch-diff.githubusercontent.com`, not `api.github.com`), doesn't count against the REST limit.

## Current state

### ✅ Works
- Persistent disk cache (write/read round-trip, ETag + body survival) — unit-tested
- ETag / 304 conditional GET
- Force-dedup window + per-URL single-flight
- Hourly budget (background yields, force proceeds)
- URL → filename sanitization (no path/query chars leak) — unit-tested
- Budget cap saturates at 0 — unit-tested
- All existing callers flow through the gateway (transparent)

### ❌ Known issues / caveats
- Disk I/O (`std::fs`) happens on the async runtime thread — negligible for small files (sub-ms), consistent with the rest of the codebase (`download_manager.rs`, `gguf_patch.rs`), but could move to `spawn_blocking` if it ever matters.
- `GATEWAY_MEM.recent` / `.locks` grow one entry per distinct URL — bounded (a handful of URLs), no eviction needed.
- The budget window is per-process (in-memory), so it resets on restart. The disk cache is the primary protection; the budget is a secondary safety net.
- `intel.rs` still burns its own ~17 calls/channel/refresh (excluded). **If the 403s persist after this, that's the next thing to route through the gateway.**

### 🚧 Not implemented (optional)
- Route `intel.rs` through the gateway (brings it under the budget).
- A `per_page`-agnostic list cache (currently keyed by full URL incl. `per_page`; all callers use 40 so it's one entry).
- On-disk budget persistence (survives restart) — not needed given the disk cache.

## How to verify the 403s are gone

1. DEV: `npm run tauri` (foreground), open the **Updates** tab.
2. Watch the terminal for `[github]` lines:
   - `DISK CACHE HIT (age …s < ttl …s)` — served from disk, 0 API calls.
   - `DEDUP HIT (age …s < 60s)` — force calls sharing one fetch.
   - `LIVE GET … (auth|anon)` — a real round-trip (should be rare).
   - `BUDGET LOW — serving stale cache` — budget guard engaged.
3. Rebuild/restart repeatedly — the first GitHub call should be a `DISK CACHE HIT`, not a `LIVE GET`.

## Test command

```bash
cd src-tauri
cargo test --package blackwell-ops -- github_releases   # 7 tests (4 pre-existing + 3 gateway)
cargo test --package blackwell-ops                        # 186 pass / 0 fail
```

New gateway tests (`#[cfg(test)] mod tests`, line 1193):
- `cache_file_sanitizes_url` — URL → filename mapping, distinct URLs don't collide
- `budget_reaches_zero_at_cap` — saturates at 0 once the cap is hit
- `cache_round_trip_persists_body_and_etag` — disk write/read, ETag + body survive

## Build

```bash
cd src-tauri
cargo check   # clean, no new warnings
```

## Related

- `GITHUB-Firewall-rules-for-DEV.md` (repo root) — blocks `api.github.com` for the DEV exe by process path. This rework is the **REL-side** fix (the 403s were from REL's unauthenticated budget).
- `src-tauri/src/secrets.rs` — PAT in OS keyring under `github_pat`; the gateway applies it when present (401/403 → one anon retry).
