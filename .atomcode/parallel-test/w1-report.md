# Worker 1 Report — Parallelism Test Run #2

**W1_START:** 1784984505681  
**W1_END:** 1784984528610  
**Duration:** 22929 ms (~22.9 s)

---

## Module Responsibilities

| File | Lines | Symbols | Responsibility |
|------|-------|---------|----------------|
| `engine.rs` | 2039 | 65 | Orchestrates the full engine lifecycle: port picking, model launch (llama-server subprocess), stop/clean/teardown, dialog/file ops, binary version probing, FIT scan orchestration, speculative decoding param sanitization. |
| `engine_stack.rs` | 1232 | 48 | Per-app `EngineStack` data structure (array of `EngineSlot`s). Manages slot lifecycle (idle → loading → running), health/readiness probing, reaper, parallel stop/kill, VRAM estimation, load failure formatting. |
| `engine_utils.rs` | 589 | 39 | Shared primitives extracted to break circular deps: binary profile/path resolution, CUDA toolchain binding, cmd-line formatting, GPU mask computation, process kill/reap (Windows API), PID↔port lookup, netstat parsing, port-in-use detection, image-path comparison. |
| `engine_job.rs` | 426 | 11 | Windows Job Object wrapper. Creates a `KILL_ON_JOB_CLOSE` job at app init; assigns each engine PID to it so engines auto-die when the app process exits. Idempotent init, non-Windows no-op. |
| `engine_port_lock.rs` | ~426 | 10 | Cross-process port ownership via lock files on disk. Writes/reads/deletes per-port locks; sweeps stale locks; kills orphans of dead owners; reclaims our own ghost processes on startup. |

**Total:** 4712 lines, 173 symbols

---

## Public Symbols Catalog

### `engine.rs` — 2039 lines

#### Constants
| Symbol | Type | Line |
|--------|------|------|
| `DEFAULT_BASE_PORT` | `u16` = 8080 | L22 |
| `PRIVILEGED_PORT_THRESHOLD` | `u16` = 1024 | L23 |
| `MAX_PORT_SCAN_RANGE` | `u16` = 512 | L24 |
| `SPEC_EXTRA_PARAM_KEYS` | `&[&str]` | L59 |

#### Public Functions (29)
| Symbol | Signature | Line |
|--------|-----------|------|
| `pick_next_engine_port` | `async fn(base_port, used_ports, live_pids) -> u16` | L28 |
| `AppContext` | `pub struct` | L206 |
| `list_models` | `pub async fn(app) -> Result<Vec<ModelEntry>, String>` | L223 |
| `launch_engine` | `pub async fn(config, app, alias, slot_idx) -> Result<(usize, u16), String>` | L269 |
| `stop_engine_slot` | `pub async fn(slot_idx, app) -> Result<String, String>` | L585 |
| `stop_engine` | `pub async fn(alias, app) -> Result<String, String>` | L600 |
| `stop_all_engines` | `pub async fn(app) -> Result<String, String>` | L626 |
| `stop_engines_by_provider` | `pub async fn(provider_id, app) -> Result<String, String>` | L641 |
| `toolchain_install_blocked_message` | `pub fn(stack) -> Option<String>` | L648 |
| `get_stack_status` | `pub async fn(app) -> Result<Vec<StackEntry>, String>` | L666 |
| `teardown_all_for_app_exit` | `pub async fn(app_handle)` | L725 |
| `teardown_stack_for_app_exit` | `pub async fn(app_handle)` | L790 |
| `clean_exit` | `pub async fn(app) -> Result<(), String>` | L830 |
| `get_template` | `pub fn(provider_id) -> Result<ProviderTemplate, String>` | L839 |
| `get_template_for_provider` | `pub fn(provider_id) -> Result<ProviderTemplate, String>` | L846 |
| `preview_launch_command` | `pub async fn(config, alias, slot_idx) -> Result<String, String>` | L1100 |
| `open_nobsproof_cmd` | `pub async fn(app, alias, slot_idx) -> Result<(), String>` | L1125 |
| `open_file_dialog` | `pub async fn(title, filter) -> Result<Option<String>, String>` | L1179 |
| `open_folder_dialog` | `pub async fn(title) -> Result<Option<String>, String>` | L1193 |
| `reveal_path_in_explorer` | `pub async fn(path) -> Result<(), String>` | L1209 |
| `delete_model_file_cmd` | `pub async fn(app, path, alias) -> Result<String, String>` | L1249 |
| `rename_model_file_cmd` | `pub async fn(app, old_path, new_name, alias) -> Result<String, String>` | L1274 |
| `fit_scan_model` | `pub async fn(app, model_path, provider_id) -> Result<String, String>` | L1330 |
| `fit_scan_single_model` | `pub async fn(app, model_path, provider_id) -> Result<String, String>` | L1413 |
| `fit_scan_library` | `pub async fn(app, provider_id) -> Result<String, String>` | L1483 |
| `fit_stop_scan` | `pub async fn(app) -> Result<(), String>` | L1590 |
| `probe_binary_version_sync` | `pub(crate) fn(path) -> Result<String, String>` | L1639 |
| `probe_binary_version` | `pub async fn(path) -> Result<String, String>` | L1712 |
| `get_binary_build_info` | `pub async fn(binary_path) -> Result<BuildInfo, String>` | L1720 |
| `set_build_info_for_env` | `pub async fn(binary_path) -> Result<(), String>` | L1744 |
| `scan_model_metadata_cmd` | `pub async fn(app, path, provider_id) -> Result<String, String>` | L1760 |
| `scan_all_models_cmd` | `pub async fn(app, provider_id, stop_token) -> Result<String, String>` | L1838 |
| `cancel_gguf_scan_cmd` | `pub fn()` | L2031 |
| `clear_model_cache_cmd` | `pub async fn() -> Result<(), String>` | L2036 |

#### Internal / Helper Functions
| Symbol | Line |
|--------|------|
| `guard_speculative_decoding` | L104 |
| `validate_spec_launch` | L130 |
| `assemble_launch_command` | L865 |
| `peek_next_launch_port` | L926 |
| `batch_quote` | L956 |
| `write_nobsproof_batch` | L961 |
| `spawn_nobsproof_cmd_window` | L1034 |
| `reveal_path_in_explorer_windows` | L1309 |
| `handle_scan_result` | L1966 |
| `handle_scan_result_with_sanity` | L1996 |
| `is_placeholder_build_version` | L1597 |
| `clean_version_probe_output` | L1609 |
| `parse_llama_version_line` | L1626 |
| `sanitize_spec_extra_params` | L88 |
| `strip_spec_extra_params` | L79 |
| `model_has_embedded_mtp` | L73 |
| `is_spec_decoding_group_active` | L66 |

#### Structs / Types
| Symbol | Line |
|--------|------|
| `AppContext` | L206 |
| `AssembledLaunch` | L858 |
| `ScanHandle` (inner type) | L1877 |

---

### `engine_stack.rs` — 1232 lines

#### Constants
| Symbol | Type | Line |
|--------|------|------|
| `DEFAULT_N_CTX` | `usize` = 32768 | L7 |
| `LOAD_FAILURE_ALREADY_REPORTED` | `&str` | L9 |

#### Enums
| Symbol | Line |
|--------|------|
| `SlotStatus` (`Idle`, `Loading`, `Running`) | L71 |

#### Structs
| Symbol | Line |
|--------|------|
| `EngineSlot` | L88 |
| `EngineStack` | L113 |

#### Public Methods on `EngineStack`
| Symbol | Signature | Line |
|--------|-----------|------|
| `new` | `fn(slot_count: usize) -> Self` | L119 |
| `set_log_hub` | `fn(&mut self, hub: LogHub)` | L147 |
| `find_idle_slot` | `fn(&self) -> Option<usize>` | L151 |
| `reserved_ports` | `fn(&self) -> HashSet<u16>` | L166 |
| `live_engine_pids` | `fn(&self) -> HashSet<u32>` | L183 |
| `alias_in_use` | `fn(&self, alias: &str) -> bool` | L200 |
| `provider_has_active_engine` | `fn(&self, provider_id: &str) -> bool` | L210 |
| `model_path_in_active_use` | `fn(&self, path: &str) -> bool` | L221 |
| `reserve_slot` | `fn(&self, idx, alias, port) -> Result<(), String>` | L237 |
| `release_reserved_slot` | `fn(&mut self, idx)` | L253 |
| `load_slot` | `pub async fn(&mut self, idx, config, app, alias, stop_token) -> Result<(), String>` | L267 |
| `stop_slot` | `pub async fn(&mut self, idx, app, provider_id, slot_alias) -> Result<(), String>` | L945 |
| `update_slot_vram` | `pub fn(&mut self, idx, vram_mib, breakdown)` | L917 |
| `emit_stack_changed` | `pub fn(&self)` | L937 |
| `stop_all_parallel` | `pub async fn(&mut self, app, stop_token) -> Vec<usize>` | L1064 |
| `stop_slots_by_provider_parallel` | `pub async fn(&mut self, app, provider_id, stop_token) -> Vec<usize>` | L1077 |
| `stop_slots_by_provider_and_profile_parallel` | `pub async fn(...)` | L1101 |
| `kill_all` | `pub async fn(stack_ref) -> Vec<usize>` | L1123 |
| `get_status` | `pub fn(&self) -> Vec<StackEntry>` | L1188 |
| `get_slot` | `pub fn(&self, idx) -> Option<MutexGuard<'_, EngineSlot>>` | L1205 |
| `fail_loading_slot` | `pub async fn(&mut self, idx, err, app)` | L800 |

#### Internal Methods on `EngineStack`
| Symbol | Line |
|--------|------|
| `slots_still_loading` | L472 |
| `probe_readiness_source` | L482 |
| `probe_health_ok` | L510 |
| `spawn_health_readiness_probe` | L525 |
| `spawn_reaper` | L596 |
| `finish_process_stop` | L635 |
| `handle_engine_died` | L704 |
| `clear_crashed_running_slot` | L734 |
| `clear_slot` | L886 |
| `shutdown_slots_generic` | L988 |
| `slot_to_entry` | L1134 |
| `default_entry` | L1166 |
| `normalized_slot_profile` | L1091 |

#### Standalone Functions
| Symbol | Line |
|--------|------|
| `format_load_failure_reason` | L12 |
| `fit_scanner_estimate_vram` | L29 |
| `validate_binary_path` | L60 |

---

### `engine_utils.rs` — 589 lines

| Symbol | Type | Line |
|--------|------|------|
| `normalized_binary_profile` | `pub fn(profile) -> &str` | L14 |
| `binary_profile_from_path` | `pub fn(path) -> Option<String>` | L23 |
| `apply_cuda_toolchain_for_profile` | `pub fn(cmd, profile) -> Result<(), String>` | L36 |
| `apply_cuda_toolchain_for_binary` | `pub fn(cmd, path) -> Result<(), String>` | L43 |
| `find_provider_binary` | `pub fn(cfg, provider_id, profile) -> Result<PathBuf, String>` | L52 |
| `format_debug_executable` | `pub fn(path) -> String` | L102 |
| `format_cmd_arg` | `pub fn(arg) -> String` | L108 |
| `format_cmd_line` | `pub fn(exe, args) -> String` | L114 |
| `compute_gpu_mask` | `pub fn(config, gpu_count, test_has_split) -> String` | L125 |
| `compute_gpu_mask_from_params` | `pub fn(device, split_mode, gpu_count, test_has_split) -> String` | L132 |
| `resolve_nvidia_smi_path` | `pub fn() -> PathBuf` | L148 |
| `reap_child_handle` | `pub fn(child) -> bool` | L183 |
| `stop_child_fast` | `pub async fn(child, pid, port, app, provider_id, alias, slot_idx)` | L205 |
| `run_hidden_output` | `pub fn(cmd) -> Result<(String, String), String>` | L229 |
| `run_hidden_output_async` | `pub async fn(cmd)` | L259 |
| `kill_process_by_pid_blocking` | `fn(pid) -> Result<(), String>` | L272 |
| `kill_process_by_pid` | `pub async fn(pid) -> Result<(), String>` | L319 |
| `get_listening_pid` | `pub async fn(port) -> Option<u32>` | L333 |
| `get_listening_pid_blocking` | `fn(port) -> Option<u32>` | L340 |
| `parse_netstat_local_port` | `fn(local) -> Option<u16>` | L374 |
| `get_process_image_path` | `pub fn(pid) -> Option<PathBuf>` | L384 |
| `same_executable_path` | `pub fn(a, b) -> bool` | L418 |
| `is_managed_llama_server_image` | `pub fn(path) -> bool` | L429 |
| `is_process_alive` | `pub fn(pid) -> bool` | L466 |
| `is_port_in_use` | `pub async fn(port) -> bool` | L499 |
| `describe_process_exit_code` | `pub fn(code) -> String` | L511 |
| `extract_model_name` | `pub fn(path) -> String` | L526 |
| `split_cuda_arch_list` | `fn(raw) -> Vec<String>` | L535 |
| `parse_cuda_architectures_from_cmake` | `pub fn(cmake_flags) -> Vec<String>` | L543 |
| `enrich_build_info_cuda_arch` | `pub fn(info, cmake_flags) -> BuildInfo` | L558 |
| `strip_ansi` | `pub fn(s) -> String` | L577 |

---

### `engine_job.rs` — 426 lines

| Symbol | Type | Line |
|--------|------|------|
| `init_engine_job` | `pub fn()` | L21 |
| `emit_engine_job_status_to_console` | `pub fn()` | L61 |
| `is_job_active` | `pub fn() -> bool` | L83 |
| `assign_engine_to_job` | `pub fn(pid, alias, slot_idx, port)` | L95 |
| `JOB_STATUS_LINE` | `static OnceLock<String>` | L18 |
| `ENGINE_JOB` | `static OnceLock<isize>` | L153 |

---

### `engine_port_lock.rs` — ~426 lines

| Symbol | Type | Line |
|--------|------|------|
| `EnginePortLock` (struct) | `pub struct { port, engine_pid, binary_path, timestamp }` | L8 |
| `locks_dir` | `fn() -> PathBuf` | L15 |
| `lock_file` | `fn(port) -> PathBuf` | L21 |
| `write_lock` | `pub fn(port, pid, path) -> Result<(), String>` | L25 |
| `delete_lock` | `pub fn(port)` | L41 |
| `read_lock` | `fn(port) -> Option<EnginePortLock>` | L48 |
| `occupied_ports_from_locks` | `pub fn() -> HashSet<u16>` | L54 |
| `live_stack_engine_error` | `fn(port, listener_pid) -> String` | L84 |
| `kill_orphans_of_dead_owners` | `pub async fn()` | L94 |
| `sweep_stale_locks` | `pub async fn()` | L236 |
| `reclaim_our_ghost_or_fail` | `pub async fn(port, engine_pid, binary_path, app)` | L291 |

---

## Dependency Graph (imports between these modules)

```
engine.rs
  ├── engine_stack (SlotStatus, EngineStack)
  ├── engine_utils (is_port_in_use, get_listening_pid)
  ├── fit_scanner
  ├── telemetry (detect_gpu_count)
  ├── fusion
  ├── model_catalog
  ├── model_cache
  ├── log_hub
  ├── output_console

engine_stack.rs
  ├── types (EngineConfig, StackEntry)
  ├── log_hub (LogHub)
  ├── vram_learn (lookup_learned_vram_for_config)
  ├── fit_scanner (find_existing_scan_in_provider_partition)
  ├── config (DEFAULT_PROVIDER_ID)

engine_utils.rs
  ├── config (AppConfig)
  ├── types (EngineConfig)
  ├── foundry_toolchain (apply_portable_cuda_to_command)

engine_job.rs
  ├── output_console (emit_blackwell_*_line)

engine_port_lock.rs
  ├── output_console (emit_blackwell_*_line)
```
