# PROVIDER CONFIG REFACTOR — Data-Driven Engine Launch Pipeline

## Problem
The engine config launch pipeline had 3 layers of indirection between user choice and CLI args:
1. Frontend `config` object → typed `EngineConfig` struct (hardcoded mapping, loses params)
2. `EngineConfig` → `apply_provider_defaults` (broken guards, case mismatches)
3. `typed_field_to_string` → `build_command` (16 match arms, drops anything not listed)

**Result:** 12+ params silently dropped. `verbose`/`log_timestamps` hardcoded. User sovereignty violated.

## Solution
**Single transport:** `extra_params` HashMap. All non-mandatory params flow through it.
```
User config (frontend) → extra_params → Rust get_value() → build_command → CLI
```

## Status: COMPLETE

### Rust Backend (5 files)
| File | Change |
|------|--------|
| `types.rs` | Flattened `EngineConfig` to 6 fields + helpers (`get_parallel`, `get_unified_kv`, `get_param_str`) |
| `templates.rs` | Removed `typed_field_to_string`, reversed `get_value` priority (extra_params → param_defs → template), removed `apply_provider_defaults` |
| `engine.rs` | `compute_gpu_mask`, `launch_engine`, `preview_command` read `split`, `device`, `ctx` from `extra_params` |
| `engine_stack.rs` | `fit_scanner_estimate_vram` + slot update read `ctx`, `kv_quant` from `extra_params` |
| `features/reactor11/bridge.rs` | GPU allocation injection, split mode, quant extraction all use `extra_params` |

### Frontend (4 files)
| File | Change |
|------|--------|
| `lib/types.ts` | Flattened `EngineConfig` interface: only `alias`, `model_path`, `port`, `backend_type`, `binary_profile`, `extra_params` |
| `components/EngineConfigPanel.tsx` | Builds `fullConfig` with all user params in `extra_params` |
| `hooks/useScenarioEvaluator.ts` | Replaced typed config object (26 lines) with `extra_params: { ...curConfig }`, removed hardcoded `verbose: false` / `log_timestamps: true` |
| `services/vram/scenarios/scenarios_factory.ts` | Added `ep`/`cfgStr`/`cfgNum`/`cfgBool` helpers to read from `extra_params` |

## Mandatory Fields (only these stay typed)
| Field | Reason |
|-------|--------|
| `alias` | Stack, logs, fusion, window titles |
| `model_path` | Passed as `-m`, GGUF scanning |
| `port` | Passed as `--port`, /slots polling |
| `backend_type` | Provider selection, binary path |
| `binary_profile` | Build profile per provider |
| `extra_params` | All optional engine params |

## Key Design Decisions
1. **Priority chain:** User choice (extra_params) → param_defs override → template default
2. **Case-insensitive lookups:** All key matching is `.to_lowercase()` on both sides
3. **No typed field bloat:** New params require zero Rust/frontend changes — just edit `genesis_template.json`
4. **Helper methods:** `get_parallel()`, `get_unified_kv()`, `get_param_str()` for pre-launch needs (fusion poller, GPU mask)

## Bugs Fixed
- `verbose` hardcoded to `false` in 3 frontend files — user toggle had no effect
- `log_timestamps` hardcoded to `true` in 3 frontend files — user toggle had no effect
- 12 params (`unified_kv`, `rope_scaling`, `rope_scale`, `yarn_orig_ctx`, `rope_freq_base`, `reasoning`, `spec_type`, `ik_perf`, etc.) silently dropped from launch because missing from `typed_field_to_string`
- `apply_provider_defaults` used uppercase guards (`"REGULAR"`, `"NONE"`) against lowercase values — defaults never applied

## Testing Checklist
- [ ] Launch with all defaults → matches current CLI output
- [ ] Toggle `verbose` ON → `--verbose` appears in CLI
- [ ] Toggle `log_timestamps` OFF → `-ts` absent from CLI
- [ ] Change `unified_kv`, `rope_scaling`, `spec_type` → all appear in CLI
- [ ] R11 split allocation → `--split-mode layer` + `--parallel 2` in CLI
- [ ] VRAM scenario evaluation → reads correct params from `extra_params`
