# STAGE 1: Race Condition Fix + God Function Decomposition

## Goal
Fix the critical race condition where two concurrent `launch_engine()` calls can claim the same slot or compute the same port, while simultaneously refactoring the 236-line God function into smaller, testable units.

**Estimated effort:** 4–8 hours  
**Risk level:** HIGH (correctness bug that corrupts state under concurrent load)

---

## Problem Analysis

### Current Flow in `launch_engine()` (engine.rs lines 61–297):
```
find_idle_slot → drop lock → compute port → load_slot
```

The issue: The stack lock is acquired **twice separately**:
- First at lines 117–125 to find an idle slot
- Second at lines 138–146 to compute a free port

Between these two acquisitions, another concurrent call can claim the same slot or compute the same port.

### Current TOCTOU in `find_idle_slot()` (engine_stack.rs lines 108–120):
Returns an index but drops the per-slot lock before use. Between finding and using it (in `load_slot`), another thread could claim that slot.

---

## Implementation Plan

### Step 1: Create atomic `claim_slot_with_port()` method in engine_stack.rs

**File:** `src-tauri/src/engine_stack.rs`

Add a new public async method to `EngineStack`:

```rust
/// Atomically reserve an idle slot with a unique port.
/// Returns (slot_idx, assigned_port) under single lock acquisition.
pub async fn claim_slot_with_port(
    stack_ref: &Arc<tokio::sync::Mutex<EngineStack>>,
    base_port: u16,
) -> Result<(usize, u16), String> {
    let mut stack = tokio::time::timeout(Duration::from_secs(5), stack_ref.lock())
        .await
        .map_err(|_| "Stack lock timeout — possible deadlock".to_string())?;

    // 1. Find idle slot (same logic as find_idle_slot, but under same lock)
    let mut slot_idx = None;
    for (i, slot_opt) in stack.slots.iter().enumerate() {
        if let Some(slot_arc) = slot_opt {
            let slot = slot_arc.lock();
            if matches!(slot.status, SlotStatus::Idle) {
                slot_idx = Some(i);
                break;
            }
        } else {
            slot_idx = Some(i);
            break;
        }
    }

    let idx = slot_idx.ok_or("All engine slots are occupied")?;

    // 2. Compute free port (same logic as in launch_engine, but under same lock)
    let used_ports: HashSet<u16> = stack.slots.iter()
        .filter_map(|s| s.as_ref().map(|arc| arc.lock().port))
        .filter(|&p| p != 0 && p > PRIVILEGED_PORT_THRESHOLD)
        .collect();

    let port = (base_port..=u16::MAX)
        .find(|p| !used_ports.contains(p) && *p > PRIVILEGED_PORT_THRESHOLD)
        .ok_or("No available ports in range")?;

    Ok((idx, port))
}
```

**Key design decisions:**
- Single lock acquisition eliminates the race condition
- Port scanning includes `> PRIVILEGED_PORT_THRESHOLD` filter (no need for separate check after)
- Returns `(slot_idx, assigned_port)` as a tuple — caller doesn't need to compute separately

---

### Step 2: Update engine.rs launch_engine() to use atomic claim

**File:** `src-tauri/src/engine.rs`

Replace the current flow:
```rust
// Old flow (lines ~115-148):
let slot_idx = {
    let stack = app.stack.lock().await;
    stack.find_idle_slot().ok_or("All engine slots are occupied")?
};
// ... port computation ...
config.port = slot_port;
```

With the new atomic claim:
```rust
// New flow (atomic slot + port reservation)
let provider_base_port = config.get_param_str("base_port")
    .and_then(|v| v.parse::<u16>().ok())
    .unwrap_or(DEFAULT_BASE_PORT);

if provider_base_port <= PRIVILEGED_PORT_THRESHOLD {
    return Err(format!("base_port {} is too low — must be > {}", 
        provider_base_port, PRIVILEGED_PORT_THRESHOLD));
}

let (slot_idx, slot_port) = EngineStack::claim_slot_with_port(
    &app.stack, provider_base_port
).await?;
config.port = slot_port;
```

This eliminates the race condition by combining idle-slot finding and port allocation into a single locked operation.

---

### Step 3: Remove `find_idle_slot()` from engine_stack.rs

**File:** `src-tauri/src/engine_stack.rs` (lines ~108–120)

Since `claim_slot_with_port()` now handles both slot finding and port allocation atomically, the standalone `find_idle_slot()` method is no longer needed.

Remove it entirely — its only caller was `engine.rs:124`.

---

### Step 4: Decompose `launch_engine()` into smaller functions

**File:** `src-tauri/src/engine.rs`

Break the ~236-line function into focused helpers:

| New Function | Responsibility | Lines extracted |
|---|---|---|
| `resolve_launch_config(app, config)` | Resolve backend type, binary path, template, user params | ~70–91 |
| `compute_gpu_mask_and_validate(config, ...)` | GPU mask computation + validation of paths | ~93–125 |
| `build_command_line(config, gpu_mask, cmd_args, ...)` | Construct CLI args for the engine process | ~154–186 |
| `spawn_engine_with_retry(app, config, slot_idx, port, ...)` | Retry logic (up to 2 attempts) calling load_slot | ~200–279 |

**Key constraints:**
- Each helper should be a separate function with clear inputs/outputs
- Lock ordering must remain consistent: tokio stack lock → per-slot parking_lot lock
- No async locks held across `.await` boundaries (current pattern is correct)
- The `make_on_ready()` closure stays as-is since it's already well-scoped

---

### Step 5: Verify lock ordering and fix any issues

The current code follows this consistent pattern:
```
tokio stack lock → per-slot parking_lot lock → drop both
```

After refactoring, verify that:
- No new nested locks are introduced across `.await` boundaries
- The `on_ready()` closure still acquires locks in the correct order (it does — lines 206–216)
- The reaper (`spawn_reaper`) doesn't conflict with launch operations

---

### Step 6: Test and verify

After all changes:
1. Run `cargo check` to ensure no compilation errors
2. Verify that the race condition is eliminated by testing concurrent launches (if possible)
3. Ensure existing tests still pass (check for test files in src-tauri/tests/)

---

## Files Modified

| File | Changes |
|---|---|
| `src-tauri/src/engine_stack.rs` | Add `claim_slot_with_port()` method; remove `find_idle_slot()` |
| `src-tauri/src/engine.rs` | Update `launch_engine()` to use atomic claim; decompose into smaller functions |

---

## Risk Assessment

- **Highest risk:** Step 1 (atomic slot+port reservation) touches core concurrency logic
- **Medium risk:** Step 4 (God function decomposition) requires careful extraction without changing behavior
- **Lowest risk:** Steps 2, 3, 5, 6 are straightforward changes with clear verification paths

---

## Rollback Plan

If any step introduces issues:
1. Revert the specific file change using `git checkout`
2. The old code still works — it just has a race condition under concurrent load
3. No data loss risk since all changes are in-memory (no persistent state)