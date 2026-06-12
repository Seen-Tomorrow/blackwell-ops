# Engines

## Architecture

- **EngineStack**: 16 slots, no fixed ports. Each slot is `Arc<parking_lot::Mutex<EngineSlot>>` inside a `tokio::sync::Mutex<EngineStack>`.
- **EngineSlot** fields: `child_proc: Option<Child>`, `pid: Option<u32>`, `port`, `status` (Idle/Loading/Running), `alias`, `model_path`, `gpu_mask`, `vram_mib`, `n_ctx`, `provider_name`, `backend_type`.
- The `child_proc` handle is the **single source of truth** for the running process. Only one path should own it at a time.
- The `pid` field exists solely so the reaper can monitor the process without touching `child_proc`.

## Launch Flow

1. `launch_engine` (engine.rs) — Tauri command entry point.
2. Validates binary and model path.
3. Acquires `stack.lock()` with 5s timeout (deadlock detection), finds idle slot.
4. **Port assignment**: Reads provider's `base_port` from config params (default 8080). Scans all running slots for used ports, assigns first available port starting from provider's `base_port` (collision avoidance across **this app's slots only** — does not probe LM Studio or other apps).
5. **`reclaim_our_ghost_or_fail`** (engine_port_lock.rs): Fast TCP connect probe (~150ms). If port is free → continue. If busy → verify lock file + LISTENING PID + exe path + owner app PID; kill **only** a verified Blackwell orphan via `taskkill /PID`. Foreign or live sibling-instance listeners → fail with clear error (no port skip, no carpet-bomb).
6. Builds command args from provider template, writes to temp launch log.
7. Calls `EngineStack::load_slot` with auto-retry (once, 500ms delay, emits `[RETRY]` alert on first failure).
8. **`load_slot`** (engine_stack.rs):
   - Spawns child with `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`, stdout=null, stderr=piped.
   - 500ms alive check — if child already dead, returns `Err(...)` and cleans slot (no lock file written).
   - **`write_lock`**: Persists `config/engine-locks/{port}.json` with `engine_pid`, `owner_app_pid`, `binary_path`.
   - Stores `child` in `slot.child_proc`, PID in `slot.pid`, sets status=Loading.
   - Extracts stderr, passes to `log_hub.spawn_slot_reader` for log reading + readiness detection.
   - Spawns reaper via `Self::spawn_reaper`.
9. After `load_slot` succeeds, `launch_engine` spawns the fusion brain for the slot.
10. **`on_ready` callback**: fires when `/health` reports ready (or stderr readiness). Sets status=Running, emits `stack-changed`.

## Port Lock Files (`engine_port_lock.rs`)

Location: `{app_root}/config/engine-locks/{port}.json`

```jsonc
{
  "engine_pid": 12345,       // llama-server listener PID at write time
  "owner_app_pid": 6789,     // Blackwell Ops process that spawned it
  "binary_path": "foundry/artifacts/.../llama-server.exe",
  "reserved_at": "2026-06-13T..."
}
```

| Event | Action |
|-------|--------|
| Spawn survives 500ms check | `write_lock` |
| `clear_slot` (stop, fail, shutdown) | `delete_lock` |
| Launch, port busy | `reclaim_our_ghost_or_fail` — may `kill_process_by_pid(listener)` then `delete_lock` |

**Ghost proof chain:** lock file exists → `engine_pid` matches LISTENING netstat PID → lock binary matches launch binary → process image path matches → owner is current app OR owner app PID is dead.

**Never kill:** LM Studio, other apps, ESTABLISHED TCP clients (fusion/health pollers), another live Blackwell Ops instance on the same port.

## Reaper

The reaper monitors each engine's PID every 500ms during **Loading** only.

### `is_process_alive(pid)` — `engine_utils.rs`
- Uses `OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid)` + `GetExitCodeProcess`.
- Returns `true` if exit code is `STILL_ACTIVE` (259).
- **CRITICAL**: Must use `PROCESS_QUERY_INFORMATION` only. `PROCESS_VM_READ` causes `OpenProcess` to be denied on child processes, making callers think the process is dead.

### When death is detected (Loading only):
1. Calls `fail_loading_slot` — fusion brain stopped, slot cleared, PID-only kill if needed.
2. Does **not** scan or kill by port.

### Key invariant
The reaper **never** touches `child_proc`. It only reads `pid` and monitors via `OpenProcess`.

## Stop Flow

All stop functions are **self-locking** — callers must NOT hold the tokio stack lock.

### `stop_slot(slot_idx)`
1. Stops fusion brain, takes `child_proc` via `.take()`.
2. Clears slot immediately (UI feedback) — `delete_lock` runs in `clear_slot`.
3. `finish_process_stop` → `stop_child_fast`: brief CTRL+C, then `taskkill /PID`, reap handle. **No port scan.**

### `stop_all_parallel()` / `stop_slots_by_provider_*` / `kill_all()`
Three-phase pattern, no lock held across async boundaries:

1. **Phase 1**: Brief `stack.lock()` — take `child_proc` for matching slots.
2. **Phase 2**: Clear slots + emit events (locks deleted).
3. **Phase 3**: Parallel `finish_process_stop` (PID-only). `kill_all` awaits teardown for app exit.

## Key Invariants

1. **`child_proc` ownership**: Only the stop logic owns `child_proc`. The reaper only reads `pid`.
2. **No shared state**: No `Arc<Mutex<Child>>`. The `Child` handle lives directly in the slot and is `.take()`en by the stop path.
3. **Self-locking stop functions**: All stop functions acquire and release the tokio stack lock internally.
4. **Fusion brain stopped first**: All stop commands cancel the fusion brain before stopping the slot.
5. **Port safety**: User's `base_port` is respected. Busy foreign ports fail at launch — never auto-increment past external occupants. Internal slot collision avoidance only increments among this app's reserved ports.
6. **PID-only teardown**: `stop_child_fast`, `fail_loading_slot`, and reclaim all use known PIDs. **`kill_process_by_port` does not exist** — removed after it killed fusion clients and sibling app instances.

## Pitfalls

- **`PROCESS_VM_READ` in `OpenProcess`**: Causes access denied on child processes → false "dead" detection. Use `PROCESS_QUERY_INFORMATION` only.
- **Port conflicts with foreign apps**: Launch fails with actionable error — stop the other server or change BASE-PORT. Do not reintroduce netstat carpet-bomb.
- **Dev + release same port**: If release instance is alive, reclaim refuses (owner PID mismatch). By design.
- **`on_ready` lock splitting**: Holding the tokio Mutex while Tauri's `emit()` blocks can deadlock. Split into two lock acquisitions.
- **Reaper scope**: Only fails slots still in **Loading**. Running engines that die unexpectedly are a separate gap (not handled by reaper today).

## Files

- `src-tauri/src/engine.rs` — Tauri commands, launch orchestration, ghost reclaim hook
- `src-tauri/src/engine_stack.rs` — Slot management, spawn, reaper, stop logic, lock write/delete
- `src-tauri/src/engine_port_lock.rs` — Per-port lock files, orphan reclaim
- `src-tauri/src/engine_utils.rs` — Binary resolution, `is_port_in_use`, `get_listening_pid`, PID kill, `stop_child_fast`
- `src-tauri/src/log_hub.rs` — stderr reader, log batching, readiness detection
- `src-tauri/src/fusion_brain.rs` — HTTP polling brain, slot/metrics monitoring