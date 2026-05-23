# Engines

## Architecture

- **EngineStack**: 16 slots, base port 9090. Each slot is `Arc<parking_lot::Mutex<EngineSlot>>` inside a `tokio::sync::Mutex<EngineStack>`.
- **EngineSlot** fields: `child_proc: Option<Child>`, `pid: Option<u32>`, `port`, `status` (Idle/Loading/Running), `alias`, `model_path`, `gpu_mask`, `vram_mib`, `n_ctx`, `provider_name`, `backend_type`.
- The `child_proc` handle is the **single source of truth** for the running process. Only one path should own it at a time.
- The `pid` field exists solely so the reaper can monitor the process without touching `child_proc`.

## Launch Flow

1. `launch_engine` (engine.rs) — Tauri command entry point.
2. Validates binary and model path.
3. Acquires `stack.lock()` with 5s timeout (deadlock detection), finds idle slot.
4. **Port override**: `slot_port = 9090 + slot_idx`. The frontend's `config.port` is ignored for idle slots to prevent port conflicts.
5. `taskkill` any existing process on that port, sleep 300ms for port release.
6. Builds command args from provider template, writes to `C:\tmp\blackwell-launch.log`.
7. Calls `EngineStack::load_slot` with auto-retry (once, 1s delay, emits `[RETRY]` alert on first failure).
8. **`load_slot`** (engine_stack.rs):
   - Clones env vars, sets `CUDA_VISIBLE_DEVICES` and `LLAMA_LOG_COLORS`.
   - Spawns child with `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`, stdout=null, stderr=piped.
   - 500ms alive check — if child already dead, returns `Err(...)` and cleans slot.
   - Stores `child` in `slot.child_proc`, PID in `slot.pid`, sets status=Loading.
   - Extracts stderr, passes to `log_hub.spawn_slot_reader` for log reading + readiness detection.
   - Spawns reaper via `Self::spawn_reaper`.
9. After `load_slot` succeeds, `launch_engine` spawns the fusion brain for the slot.
10. **`on_ready` callback**: fires when stderr contains "server is listening". Splits lock acquisition into two phases — first sets status=Running, drops lock, then re-acquires to call `emit_stack_changed`. This prevents holding the tokio Mutex while Tauri's `emit()` blocks on a saturated event channel.

## Reaper

The reaper monitors each engine's PID every 2 seconds to detect unexpected deaths.

### `is_process_alive(pid)`
- Uses `OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid)` + `GetExitCodeProcess`.
- Returns `true` if exit code is `STILL_ACTIVE` (259).
- **CRITICAL**: Must use `PROCESS_QUERY_INFORMATION` only. `PROCESS_VM_READ` causes `OpenProcess` to be denied on child processes, making the reaper think the process is dead and triggering a false kill via `kill_process_by_port`.

### When death is detected:
1. Stops fusion brain for the slot.
2. Emits system event to frontend.
3. Calls `kill_process_by_port` to clean up any orphaned process on the port.
4. Acquires `stack.lock()`, calls `clear_slot`, emits `stack-changed`.
5. Emits `slot-cleared` event for frontend log cleanup.

### Key invariant
The reaper **never** touches `child_proc`. It only reads `pid` and monitors via `OpenProcess`. This ensures `child_proc` remains available for the stop logic.

## Stop Flow

All stop functions are **self-locking** — callers must NOT hold the tokio stack lock.

### `stop_slot(slot_idx)`
1. Acquires `stack.lock()`, takes `child_proc` via `.take()`, captures port and alias.
2. Runs `graceful_shutdown_process` in `spawn_blocking`: calls `child.kill()`, polls `try_wait()` up to 2s (40 × 50ms).
3. Emits system event, calls `kill_process_by_port` as belt-and-suspenders.
4. Clears slot, emits `stack-changed`.

### `stop_all_parallel()`
Three-phase approach, no lock held across async boundaries:

1. **Phase 1**: Brief `stack.lock()` — iterates all slots, takes `child_proc` via `.take()` for Running/Loading slots, collects targets.
2. **Phase 2**: Spawns all shutdowns in parallel via `tokio::spawn`. Each runs `graceful_shutdown_process` in `spawn_blocking`, emits events, kills port orphans.
3. **Phase 3**: Awaits all handles, clears each slot, emits single `stack-changed`.

### `stop_slots_by_provider_parallel(backend_type)`
Same three-phase pattern as `stop_all_parallel`, but filters by `slot.backend_type == backend_type`.

### `kill_all()`
Emergency kill for app exit. Same three-phase pattern but no event emission (app is shutting down). After parallel kill, iterates all ports and runs `kill_process_by_port` as final cleanup.

### `graceful_shutdown_process(child, slot_idx)`
- Calls `child.kill()` (TerminateProcess on Windows).
- Polls `child.try_wait()` every 50ms, up to 40 attempts (2s total).
- Returns `true` if killed, `false` if orphaned.

## `kill_process_by_port(port)`
Powershell one-liner: `netstat -ano | Select-String ':PORT' | taskkill /F /PID`. Belt-and-suspenders fallback when `child.kill()` doesn't fully clean up.

## Key Invariants

1. **`child_proc` ownership**: Only the stop logic owns `child_proc`. The reaper only reads `pid`.
2. **No shared state**: No `Arc<Mutex<Child>>`. The `Child` handle lives directly in the slot and is `.take()`en by the stop path.
3. **Self-locking stop functions**: All stop functions acquire and release the tokio stack lock internally. Callers never hold it.
4. **Fusion brain stopped first**: All stop commands cancel the fusion brain before stopping the slot, preventing race conditions with channel close.
5. **Port safety**: `9090 + idx` is always used for idle slots, regardless of frontend `config.port`.

## Pitfalls

- **`PROCESS_VM_READ` in `OpenProcess`**: Causes access denied on child processes → reaper thinks process is dead → `kill_process_by_port` kills the actual running engine. Use `PROCESS_QUERY_INFORMATION` only.
- **Port conflicts**: Frontend sends `config.port` which may not match slot index. Always override with `9090 + idx` for idle slots.
- **`on_ready` lock splitting**: Holding the tokio Mutex while Tauri's `emit()` blocks on a saturated event channel will deadlock. Split into two lock acquisitions.
- **Reaper after stop**: After stop kills the process, the reaper will detect it 2s later and call `clear_slot` again. This is harmless — the slot is already idle and `child_proc` is already `None`.

## Files

- `src-tauri/src/engine.rs` — Tauri commands, launch orchestration, GPU mask computation, auto-retry
- `src-tauri/src/engine_stack.rs` — Slot management, spawn, reaper, stop logic, port kill
- `src-tauri/src/log_hub.rs` — stderr reader, log batching, readiness detection
- `src-tauri/src/fusion_brain.rs` — HTTP polling brain, slot/metrics monitoring
