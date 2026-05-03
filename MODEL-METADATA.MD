# Model Metadata Processing — Complete Reference

## Overview

Models flow through two independent metadata sources that merge into a single unified cache:

| Source | What It Provides | When | Cost |
|--------|-----------------|------|------|
| **HF API** (tree endpoint) | Canonical ID, author, repo name, quant type, `lfs_oid` (SHA-256), file size, tags, downloads, likes | At download time — captured once, stored forever | Free (HTTP call during search/detail fetch) |
| **GGUF binary scan** (`llama-server -m`) | Architecture, layers, heads, rope, experts, tensor counts, BPW, params, vocab | On-demand or batch SCAN ALL — cached permanently until file changes | ~3s per model, CPU-only, zero VRAM |

## Unified Cache: `model_cache.json`

Single file at `%APPDATA%/blackwell-ops/model_cache.json`. Keyed by absolute GGUF file path.

```json
{
  "C:/models/unsloth/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-IQ4_XS.gguf": {
    "hfMeta": {                    // ← Persistent, never expires
      "hfModelId": "unsloth/Qwen3.5-0.8B-Instruct-GGUF",
      "author": "unsloth",
      "repoName": "Qwen3.5-0.8B-Instruct-GGUF",
      "quantType": "IQ4_XS",
      "fileSizeBytes": 524288000,
      "lfsOid": "deac83b571f3982a...",   // SHA-256 from HF LFS
      "tags": [],
      "downloads": 0,
      "likesCount": 0,
      "lastModified": ""
    },
    "ggufMeta": {                  // ← No TTL, invalidated only by mtime change
      "architecture": "qwen2",
      "n_layer": 24,
      "n_head": 16,
      ...                          // Full ModelMetadata struct (see types.rs:83-147)
    },
    "file_mtime_ms": 1748700000000
  }
}
```

### Cache Invalidation Rules

| Condition | Action |
|-----------|--------|
| File mtime changed (replaced, modified) | Invalidate `ggufMeta`, rescan on next access |
| File deleted | Catalog scan won't find it — no lookup happens |
| 24h elapsed | **No action** — removed. GGUF headers are immutable. |
| `lfs_oid` mismatch (future: if we re-download same model) | Would trigger rescan — not implemented yet |

## Pipeline: HF Download → Cache

```
1. User clicks download on GgufFile in ModelHubSearch
   │
2. Frontend extracts author/repo from modelId, constructs dest path:
      {defaultPath}/{author}/{repoName}/{filename}.gguf
   │  Passes to backend: hfModelId, fileName, url, totalBytes, destPath,
   │                     hfAuthor, quantType, lfsOid
   │
3. download_manager.start_download() — saves task with all fields
   │
4. Download completes → post-download block runs:
   ├─ Marks status = Completed
   ├─ Constructs HfMetadata from task fields (including lfs_oid)
   └─ model_cache::set_hf_metadata(dest_path, hf_meta) → persists to cache
      │  If entry exists: preserves existing ggufMeta
      │  If no entry: creates new with hfMeta only, ggufMeta = None
   │
5. Frontend detects completion in poll loop → emits download-completed event
   │
6. App.tsx listens for event → calls list_models IPC → catalog refreshes
```

## Pipeline: Catalog Merge (list_models)

```
1. model_catalog::merge_catalogs(paths[]) — walks all configured paths
   │  Each path scanned with scan_path(base/author/model_dir/*.gguf)
   │
2. For each .gguf file found:
   ├─ Parses author from first directory level
   ├─ Parses name from second directory level (-GGUF suffix stripped)
   ├─ Extracts quant from filename (heuristics against KNOWN_QUANTS list)
   ├─ Detects mmproj files in same folder → vision flag
   └─ Strips shard patterns (-001-of-002) for dedup key
   │
3. Cross-path dedup: author|name|quant key, largest file wins conflicts
   │
4. For each deduplicated entry — cache lookup:
   ├─ model_cache::get_cached(path) → returns ggufMeta if mtime matches
   ├─ model_cache::get_hf_metadata(path) → returns hfMeta (no validation)
   │
5. If hfMeta exists → overrides author, name, quant from directory parsing
   │  (HF values are authoritative — no filename heuristics needed)
   │
6. ModelEntry returned with: path, author, name, quant, size_str, vision,
   mmproj, sourcePathLabel, metadata (ggufMeta), hf_meta
```

## Pipeline: SCAN ALL (Incremental)

```
1. scan_all_models_cmd — gets catalog from merge_catalogs()
   │  Returns all model paths across configured directories
   │
2. For each path in catalog:
   ├─ model_cache::get_cached(path) → checks mtime only
   │  ├─ HIT → skip GGUF binary, count as scanned ✓ (near-instant)
   │  └─ MISS → spawn llama-server scan on spawn_blocking thread
   │     ├─ Parses KV headers, dims, tensor counts from stderr
   │     ├─ Kills process before load_tensors (zero VRAM usage)
   │     └─ model_cache::set_cached(path, metadata) → saves to cache
   │        Preserves existing hfMeta if present
   │
3. Concurrency: 2 parallel scans at a time
4. Cancellation: atomic flag checked between models
5. Progress events emitted to frontend via LogHub
```

**First run:** Full scan of all models (same as before).  
**Subsequent runs:** Near-instant — every model with valid mtime is skipped. Only new/changed files trigger the binary scan.

## Data Flow: What Frontend Sees

| Field | Source | When Available |
|-------|--------|---------------|
| `model.author` | HF cache (override) or directory parsing | Immediately on catalog load |
| `model.name` | HF cache (override) or directory parsing | Immediately on catalog load |
| `model.quant` | HF cache (override) or filename heuristics | Immediately on catalog load |
| `model.size_str` | File size from disk scan | Immediately on catalog load |
| `model.vision`, `model.mmproj` | Directory scan for mmproj files | Immediately on catalog load |
| `model.sourcePathLabel` | Configured path label (e.g., "Main SSD") | Immediately on catalog load |
| `model.hfMeta` | HF cache — only set for downloaded models | After download completes + catalog refresh |
| `model.metadata.architecture` | GGUF binary scan | After SCAN ALL or single-model scan |
| `model.metadata.n_layer`, etc. | GGUF binary scan | After SCAN ALL or single-model scan |

## Key Types (Rust → TS)

### HfMetadata (`types.rs:47-78`)
Persistent HF API data — set once at download, never expires. Includes `lfs_oid` for future incremental checks.

### ModelMetadata (`types.rs:83-147`)
Deep GGUF header data from binary scan. Cached permanently until file mtime changes.

### GgufFile (`types.rs:375-383`)
Pre-download representation from HF API. Includes `lfs_oid` captured from tree endpoint's LFS info.

### DownloadTask (`types.rs:412-454`)
In-memory download queue entry. Carries `hf_author`, `quant_type`, `lfs_oid` for post-download cache save.

### ModelEntry (`types.rs:79-100`)
Final catalog item sent to frontend. Merges directory scan + HF cache override + GGUF cache. Has both `metadata` (ggufMeta) and `hf_meta`.

## Migration Notes

Legacy cache format (single `metadata` field) is auto-migrated on first load:
- Old entries → `ggufMeta = metadata`, `hfMeta = None`
- Migrated cache saved immediately in new format
- No data loss during transition
