# Catalog HF update check — plan

Status: **disabled on startup** (2026-06-16). Backend and Model Hub on-demand checks remain; catalog auto-check is gated until UX is ready.

---

## What we turned off

On app start, `reloadModels()` used to call `check_catalog_hf_updates` after `list_models`. That:

1. Re-ran `merge_catalogs` (second full cache read + path scan)
2. Grouped local models by HF repo ID
3. Fetched each paired repo’s HF file tree (`Tree page returned N entries…`)
4. Compared local quants to Hub (LFS OID → size → mismatch)
5. Set `catalogHfUpdates` for yellow **HF UPDATE** badges on catalog cards

**Change:** removed the `check_catalog_hf_updates` invoke from `App.tsx` `reloadModels()`. `catalogHfUpdates` stays wired but empty until we ship manual/on-demand catalog UX.

**Unchanged:** Model Hub still supports per-repo checks (`check_hf_repo_updates`, `check_hf_files_against_disk`) when the user selects a model.

---

## Why disable now

- **No catalog action** — badge only; no click-to-update, no detail, no user control
- **Startup cost** — N Hub API calls per cold start (one tree fetch per paired repo) plus duplicate `merge_catalogs` / cache reads
- **Pairing is partial** — many libraries won’t pair correctly without more work (see below)

---

## Pairing local models to HF repos

Update checks only run for models with a resolvable `hf_model_id`. Sources today:

| Source | When | Reliability |
|--------|------|-------------|
| **Download cache** (`model_cache.json` `hf_meta`) | Downloaded via Blackwell | High — `hf_model_id`, `lfs_oid`, quant |
| **Directory layout** | `author/repo-folder/file.gguf` (LM Studio pattern) | Medium — assumes folder name matches HF repo |
| **GGUF `general.repo_url`** | Embedded in header | **Not used for repo ID** — and often truncated/unreliable in the wild; do not depend on it |
| **Flat / custom paths** | e.g. `D:\models\foo-Q4_K_M.gguf` | None — skipped |

Directory heuristic (`model_catalog.rs` `scan_path`):

- `components.len() >= 2` → `hf_model_id = "{author}/{rest-of-path}"`
- First catalog merge persists stub `hf_meta` (no `lfs_oid`) for discovered pairings

**LM Studio migrants:** works if they kept `author/model-repo-name/` layout. Fails on flat dumps, renamed folders, or extra nesting (`author/repo/subdir` → wrong repo string).

**Comparison logic** (`check_hf_files_against_disk`) is source-agnostic once paired:

1. LFS OID match (Blackwell downloads only)
2. Same quant + same byte size → up to date
3. Same quant + different size → update available

Quant labels must align between local filename (`extract_quant`) and Hub filenames.

---

## What “ready” means (re-enable criteria)

### Frontend (required)

1. **User-triggered check** — catalog toolbar “Check HF updates” (not every startup)
2. **Action on badge** — click **HF UPDATE** → update flow (dialog or Model Hub deep-link with repo + quant pre-selected)
3. **Reuse Model Hub paths** — `check_hf_repo_updates`, mismatch → `UPDATE` download (already implemented in `ModelHubSearch.tsx`)
4. **Feedback** — last-checked time, in-progress state, errors per repo
5. **Optional:** show pairing source (download / folder guess) and “link to HF repo” for unpaired models

### Backend (recommended before or with re-enable)

1. **No duplicate catalog build** — pass `list_models` result into update check, or share one `merge_catalogs` + in-memory cache per session
2. **TTL cache** — persist check results (like `saveStartupUpdatesCache` for binary updates); respect stale window (e.g. 24h)
3. **Do not use `general.repo_url` as primary pairing** — truncated URLs are common; treat as hint only if we add validation against HF API
4. **Manual pairing** — user-assigned `hf_model_id` in cache overrides directory guess
5. **Quant normalization** — align local vs Hub quant strings before compare

---

## Implementation sketch (when we ship)

### Phase 1 — Manual check + badge action

- Add `refreshCatalogHfUpdates()` back, called only from catalog button (not `reloadModels` mount)
- Wire badge click → open update UI (minimal: navigate to Model Hub with repo id in state/query)
- Show `checking` / `lastChecked` in catalog header

### Phase 2 — Performance + trust

- Rust: optional `check_catalog_hf_updates_from_catalog(Vec<ModelEntry>)` to skip second `merge_catalogs`
- `storage.ts`: `catalogHfUpdatesCache` with timestamp
- Pairing indicator on model card; manual “Set HF repo” (config or context menu)

### Phase 3 — Optional startup (opt-in)

- Settings toggle: “Check for HF updates on startup” default **off**
- If on, use TTL cache so repeat starts within window don’t hit Hub

---

## Files involved

| Area | Files |
|------|--------|
| Disabled entry | `src/App.tsx` (`reloadModels`) |
| IPC | `src-tauri/src/main.rs` → `check_catalog_hf_updates` |
| Logic | `src-tauri/src/hf_api.rs`, `src-tauri/src/model_catalog.rs` |
| Catalog UI | `src/components/ModelCatalog.tsx`, `ModelCard.tsx` |
| Working reference | `src/components/ModelHubSearch.tsx` |
| Pairing / cache | `src-tauri/src/model_cache.rs`, `model_catalog.rs` `scan_path` / `merge_catalogs` |

---

## Re-enable snippet (reference)

When catalog UX is ready, restore something like:

```ts
// App.tsx or useModelCatalog — on button click only, not on mount
const entries = await invoke<CatalogUpdateEntry[]>("check_catalog_hf_updates");
setCatalogHfUpdates(new Set(entries.filter((e) => e.hasUpdate).map((e) => e.path)));
```

Do **not** call this unconditionally from `useEffect` on app load.