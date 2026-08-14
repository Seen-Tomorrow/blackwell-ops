# Handoff — GGUF Metadata Patching

## What was built

A new module `src-tauri/src/gguf_patch.rs` that patches local GGUF files with new metadata from HuggingFace without re-downloading the entire file. Only works for **metadata-only changes** (jinja template, EULA, `tokenizer.chat_template`, etc.). Tensor weight changes still require full re-download.

## Architecture

```
Frontend (ModelHubSearch.tsx)
  │ click PATCH button
  │ invoke('patch_model_metadata', { localPath, remoteUrl, remoteTotalSize })
  ▼
Tauri command → gguf_patch::patch_metadata()
  │ 1. Parse local GGUF → find header_end (where tensor data starts)
  │ 2. HTTP Range GET 0..header_end from HF
  │ 3. Compare bytes
  │ 4. If same → AlreadyCurrent
  │ 5. If same length → splice in-place
  │ 6. If different length → shift tensor data + write new file
  ▼
PatchResult
```

## Key files

| File | Purpose |
|------|---------|
| `src-tauri/src/gguf_patch.rs` | Core logic: GGUF parser + HTTP Range + patching |
| `src-tauri/src/main.rs` | Registers `patch_model_metadata` Tauri command |
| `src/components/ModelHubSearch.tsx` | Frontend: PATCH button + handler |

## GGUF format notes (learned the hard way)

| Field | Size | Note |
|-------|------|------|
| Magic | 4 bytes | `GGUF` |
| Version | u32 | 3 = modern, but some files use v2 type encoding |
| Tensor count | u64 | |
| Metadata count | u64 | |
| Metadata KV key | string (u64 len + UTF-8) | |
| Metadata value type | u32 | Type 9 = ARRAY (not UINT64!) in practice |
| Metadata value | varies | Type 9 and 13 = array (elem_type u32 + count u64 + elements) |
| Tensor name | string (u64 len + UTF-8) | |
| Tensor dim_count | **u32** (4 bytes) | NOT u64! This was a bug that caused 22T dims |
| Tensor dims | [u64] | |
| Tensor offset | u64 | Offset WITHIN tensor data section, not file offset |
| Tensor size | u64 | |

## Current state

### ✅ Works
- Parses local GGUF files correctly (52 metadata KV pairs, 866 tensors)
- Downloads remote header via HTTP Range
- Same-length metadata patch (splice in-place)
- Different-length metadata patch (shift tensor data)
- Error messages tell you exactly what failed and where

### ❌ Known issues
- `find_header_end_from_file` uses closures `read_4`/`read_8` that could be replaced with proper helper functions (minor warning about `mut`)
- Remote header parsing writes to a temp file — could be optimized to parse in-memory
- No test for the remote header parsing path
- No integration test against a real GGUF file

### 🚧 Not implemented
- Frontend doesn't show patch result in the UI (just a toast)
- No "PATCH ALL" button for bulk patching
- No progress indicator during patch
- Patch button only appears for `matchType === 'size'` (same file size, different LFS OID) — could also show for `mismatch` when the size delta is tiny (metadata-only with different-length)
- No detection of "this is a tensor change, not metadata" — currently relies on file size comparison
- Multi-shard models: patches each shard individually, no batch coordination

## How to test

1. Open a model in Hub search that has local copies (e.g., `unsloth/Qwen3.6-27B-MTP-GGUF`)
2. Click **CHECK UPDATES**
3. If a quant shows **✓ ON DISK** + **PATCH** → click PATCH
4. Check stderr for `[gguf-patch]` log lines

## Next steps for a fresh session

1. **Add integration tests** — `cargo test` currently only has unit tests for the GGUF parser helper functions, not for `patch_metadata` itself
2. **Optimize remote header parsing** — instead of writing to temp file, parse the byte buffer directly with a `std::io::Cursor`
3. **Add progress** — emit Tauri events during patch so frontend can show a progress bar
4. **Handle multi-shard batches** — coordinate patch across all shards of a quant
5. **Add "PATCH ALL" button** — patch all outdated quants in one click
6. **Improve error UX** — show specific error messages in the UI (not just "PATCH FAILED")
7. **Consider `llama-gguf-split --dry-run`** — it's fast and could be used as a fallback if the Rust parser encounters unknown GGUF variants

## Test command

```bash
cd src-tauri
cargo test --package blackwell-ops -- gguf_patch
```

## Build

```bash
cd src-tauri
cargo check  # no errors, only pre-existing warnings
```
