# Blackwell Ops — Codebase Manifest

## Overview
- **Stack:** Tauri v2 (Rust backend) + React 18 + TypeScript + Tailwind CSS + Vite 6
- **Platform:** Windows-only; process-spawns `llama-server.exe`; hardcoded model path: `C:\Users\GHOST-TOWER\.lmstudio\models`
- **Config source of truth:** `genesis_template.json` (embedded at compile time) → `provider_meta.json` (runtime disk)
- **Template types:** `ggml-llama` (19 params), `ik-llama` (7 params), custom/empty

---

## Rust Source Files (`src-tauri/src/`)

### `main.rs`
**Exports/Taia commands:**
| Symbol | Type |
|--------|------|
| `fn list_models(model_base: String)` | Tauri command |
| `fn launch_engine(config, model_base)` | Tauri command |
| `fn stop_all_engines()` | Tauri command |
| `fn get_stack_status()` | Tauri command |
| `fn scan_gpus()` | Tauri command (Vec<GpuInfo>) |
| `fn scan_cpu()` | Tauri command (CpuInfo) |
| `fn set_telemetry_active(active: bool)` | Tauri command |
| `fn list_providers()` | Tauri command (ProviderConfig[]) |
| `fn save_provider(provider, provider_meta_json)` | Tauri command |
| `fn remove_provider(id)` | Tauri command |
| `fn get_param_definitions(provider_id, provider_meta_json)` | Tauri command |
| `fn check_template_update(provider_id, current_params)` | Tauri command |
| `fn apply_template_update(provider_id, add_params, remove_keys)` | Tauri command |

---

### `config.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `genesis_providers()` | pub fn → Vec<ProviderConfig> | Builds 3 built-in providers with factory_default set from embedded template |
| `param_def_from_template(tp, key)` | Helper | Sets default_value = factory_default from TemplateParam |
| `load_config()` | pub fn | Tauri command entry point; detects GPUs; calls genesis_providers() → saves to disk |
| `check_template_update(provider_id, current_params)` | pub async fn | Returns new/orphaned params by comparing fresh template vs disk state |
| `apply_template_update(provider_id, add_params, remove_keys)` | pub async fn | Merges selected new params; removes unselected orphans |

---

### `templates.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `ProviderTemplate::load()` | pub fn → Self | Loads ggml-stable template from embedded JSON |
| `known_ids()` | pub fn → Vec<&'static str> | Returns ["ggml-stable", "ggml-dev", "ik-extreme"] |
| `template_type_for_id(id)` | pub fn → &'static str | Maps ID to "ggml-llama" / "ik-llama" / "" |
| `get_value(key, param_defs)` | pub fn | Resolves selected value priority chain |
| `build_command(param_defs, config, model_path)` | pub fn → (String, EngineConfig) | Builds CLI args; skips hidden rows; injects sub_params from disk-first then template fallback |

---

### `engine.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `launch_engine(config: EngineConfig, model_base)` | pub async fn → Result<EngineHandle> | Spawns llama-server; sets up GPU telemetry + log streaming |
| `hot_swap_engine(alias, new_config)` | pub async fn | Stops old engine, launches updated version on same slot |
| `stop_engine(alias)` | pub async fn | Graceful shutdown with SIGTERM + 5s timeout → kill |
| `clean_exit(slot_idx)` | pub fn | Sends termination signal to engine process |
| `check_vram_fit(gpu_info, config, model_path)` | pub async fn | Uses VRAM scanner; returns fit check result |
| `list_providers()` | pub fn → Vec<ProviderConfig> | Returns providers with param_definitions from disk |
| `save_provider(provider)` | pub fn | Saves full param_definitions to provider_meta.json (no delta) |
| `remove_provider(id)` | pub fn | Removes provider by ID from registry and disk |

---

### `engine_stack.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `EngineStack::new()` | impl | Initializes 4-slot engine stack |
| `insert(slot_idx, handle, config)` | pub async fn | Inserts running engine into slot; sets up telemetry + log forwarder |
| `remove(alias)` | pub async fn → bool | Stops engine, cleans logs/events/perf events |

---

### `log_hub.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `LogHub::new()` | impl | Batches stdout lines at 100ms intervals |
| `forward_to_frontend(slot_idx)` | pub fn → tokio JoinHandle | Streams engine stdout as LogBatch events |

---

### `telemetry.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `scan_gpus()` | pub async fn → Vec<GpuInfo> | Wraps nvml_probe / intel one; uses VramCalc |
| `gpu_telemetry_loop(gpu_idx)` | pub fn → tokio spawn | 1s polling loop; emits GPU telemetry events |

---

### `vram.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `VramCalc::new(gpus: Vec<GpuInfo>)` | impl | Initializes VRAM calculator with per-GPU memory info |
| `check(config, model_path)` | pub fn → VramResult | Estimates KV cache + model layers; returns fit decision |

---

### `types.rs`
**Types:**
| Symbol | Type |
|--------|------|
| `struct EngineConfig` | Clone + Serialize + Deserialize |
| `struct ParamDef { key, label, default_value, factory_default, flag, ptype, values, sub_params, hidden } |
| `struct ProviderConfig { id, template_type, binary_path, git_url, param_definitions: Vec<ParamDef> } |
| `struct ModelEntry` | Clone + Serialize |

---

### `engine_perf.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `start_monitoring(slot_idx)` | pub fn → tokio spawn | Parses TPS, TTFT from engine stdout; emits EnginePerfEvent every 1s |
| `parse_tps(line)` | fn → Option<(f32, f32)> | Regex: "tokens per second: (\d+\.\d+)" / "TTFT: (\d+\.?\d*)ms" |

---

### `nvml_probe.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `probe_nvml()` | pub async fn → Vec<GpuInfo> | Loads NVIDIA NVML DLL; reads per-GPU utilization, memory, temperature, power |
| `probe_intel()` | pub async fn → Option<CpuInfo> | Fallback: WMI Win32_Processor |

---

### `intel.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `scan_cpu_info()` | pub fn | Reads CPU name, cores, speed from registry |

---

### `peripherals.rs` — Singleton `PeripheralManager`
**Functions/Methods:**
| Symbol | Type | Note |
|--------|------|-------|
| `PeripheralManager::new(template)` | async fn → Self | Spawns HID worker + LCD worker threads |
| `PeripheralManager::init()` | pub async fn | Probes ASUS USB devices; connects OpenRGB daemon (127.0.0.1:6742) |
| `PeripheralManager::set_system_state(state)` | pub async fn | Pushes system state to event loop for RGB update |
| `PeripheralManager::get_status()` | pub async fn → PeripheralStatus |
| `PeripheralManager::probe_lcd_descriptor()` | pub async fn → String (hex dump) |
| `PeripheralManager::push_test_frame(color)` | pub async fn → Result<(), String> |
| `PeripheralManager::push_dashboard(vram, tps, gpu_temp)` | pub async fn → Result<(), String> |
| `PeripheralManager::get_lcd_status()` | pub async fn → LcdStatus |
| `probe_asus_display()` | pub async fn → Vec<HidDeviceInfo> |
| `send_ryujin_handshake()` | pub async fn → Vec<String> |

**Tauri commands:**
`cmd_probe_asus_display`, `cmd_get_peripheral_status`, `cmd_set_system_state`, `cmd_probe_lcd_descriptor`, `cmd_push_test_frame`, `cmd_push_dashboard`, `cmd_get_lcd_status`, `cmd_probe_wmi_asus`, `cmd_run_static_fallback`

---

### `workers.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `spawn_hid_worker(vid, pid, rx)` | pub fn → JoinHandle | Sets OLED + AURA LED state from HID command channel |
| `spawn_lcd_worker(vid, pid, rx)` | pub fn → JoinHandle | Pushes LCD frames from LCD command channel |

---

### `win32_hid.rs` — Win32HidDevice
**Methods:**
| Symbol | Type | Note |
|--------|------|-------|
| `Win32HidDevice::enumerate_device_paths(vid, pid)` | pub fn → Result<Vec<String>> | Uses SetupDiGetClassDevsW; filters by VID/PID in path string |
| `Win32HidDevice::open_by_path(path)` | pub fn → Result<Self> | Opens via CreateFileW with GENERIC_READ_WRITE |
| `send_feature_report(report)` | pub fn | HidD_SetFeature |
| `write_raw(data)` | pub fn | WriteFile to bulk pipe |
| `send_get_feature_report(query, buf)` | pub fn → u32 bytes read | SetFeature + GetFeature sequence |

---

### `handshake.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `send_ryujin_handshake()` | pub async fn → Vec<String> | 3-step init: wake, clear, switch to external framebuffer; tests red/black/white pixel blocks |

---

### `lcd_protocol.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `escape_bytes(data)` | pub fn | Escapes 0x5A → 0x5B 0x01, 0x5B → 0x5B 0x02 |
| `checksum(data)` | pub fn → u8 | Sum of bytes mod 256 |
| `build_lcd_packet(content, id, cmd_type)` | pub fn → Vec<u8> | Builds 1024-byte protocol packet with header + escaped content |
| `send_screen_config(dev)` | pub fn | Sends initial "Customization" JSON config |
| `send_keepalive(dev, msg_id)` | pub fn | Pushes zeroed sensor data as keep-alive |
| `generate_red_test_frame()` | pub fn → Vec<u8> | Full-red 800×480 RGBA for screen test |
| `generate_green_test_frame()` | pub fn → Vec<u8> | Partial-green test frame |

---

### `dashboard.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `render_ops_dashboard(vram_used, vram_total, tps, gpu_temp)` | pub fn → Vec<u8> | Renders 800×480 Blackwell Green-on-black dashboard via tiny-skia |

---

### `reactor_bridge.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `estimate_vram(model_path, config)` | pub async fn → Result<VramResult> | Loads .gguf metadata; uses VramCalc to predict fit |
| `insert_rod(config, app, gpu_info)` | pub async fn → Result<RodHandle> | Launches engine with GPU-selected allocation strategy |

---

### `reactor_foundry.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `find_best_allocation(gpus, vram_required)` | pub fn → Option<(f64, Vec<GpuInfo>)> | Binary search: best fit across GPU combinations |
| `push_rod(config, slot_idx)` | pub async fn → Result<RodHandle> | Injects --gpu flag; starts log forwarder |

---

### `mobile_bridge.rs`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `get_rods()` | pub fn → Vec<GpuInfo> | Returns current GPU list for mobile sentinel UI |

---

## React Source Files (`src/`)

### `App.tsx`
**Exports/State:**
| Symbol | Type | Note |
|--------|------|------|
| `isMobileDevice()` | fn → bool | Detects mobile via width + user-agent |
| `lowPower` | useState boolean | 2s GPU polling, 5s CPU polling when true |
| `activeTab: Tab` | useState | "catalog" \| "stack" \| "reactor11" \| "telemetry" \| "logs" \| "config" \| "sentinel" |
| `handleLaunchEngine(config)` | callback | Invokes launch_engine IPC → updates stack view |
| `handleStopEngine(alias)` | callback | stop_engine; clears logs/events/perf events |
| `handleStopAll()` | callback | stop_all_engines |

---

### `components/ConfigPage.tsx`
**Exports/Hooks:**
| Symbol | Type | Note |
|--------|------|------|
| `load()` | useCallback | Fetches param_definitions + hiddenCount, totalParams from backend |
| `onParamChange(providerId)` | fn(key, value) | Updates in-memory state; persists to localStorage |
| `handleResetDefaults()` | fn | Re-reads template; sets default_value = factory_default on all params |
| `handleApplyTemplateUpdate(add, remove)` | fn | Invokes apply_template_update IPC |

---

### `components/ProvidersConfig.tsx`
**Functions:**
| Symbol | Type | Note |
|--------|------|-------|
| `detectTemplateType(id)` | fn → "ggml-llama" \| "ik-llama" \| "" | Case-insensitive ID contains "ik" detection |
| `saveProvider(provider)` | async fn | save_provider IPC; auto-detects template_type if empty |

---

### `components/ModelCatalog.tsx`
**Functions:**
| Symbol | Type | Note |
|--------|------|------|
| `scanDirectory(base, gpus, committed_mib)` | fn → Promise<ModelEntry[]> | Invokes list_models IPC; filters by available VRAM |
| `LaunchButton` | component | Launches selected model via handleLaunchEngine |

---

### `components/StackView.tsx`
**Functions:**
| Symbol | Type | Note |
|--------|------|------|
| `getSlotStatus(slot)` | fn → "running" \| "stopping" \| "offline" | Derived from stack data + logs map |

---

### `components/TelemetryPanel.tsx`
**Functions:**
| Symbol | Type | Note |
|--------|------|------|
| `GpuCard` | component | Displays per-GPU utilization, VRAM bar, temperatures (Core/Junction/VRAM) |

---

### `components/Reactor11.tsx`, `R11_CoreGemini.tsx`
**Functions:**
| Symbol | Type | Note |
|--------|------|------|
| `Reactor11` | component | Orchestrates Core, Wells, Sidebar sub-components |
| `CoreGeminiView` | component | GPU allocation + engine launch UI |

---

### `context/StatusBarContext.tsx`
**Exports:**
| Symbol | Type | Note |
|--------|------|------|
| `totalParams`, `hiddenCount` | context values | Set via param-config-changed events from ConfigPage |
| `onShowAll()` | fn | Clears BlackOps-* localStorage keys |

---

### `lib/types.ts`
**Types:**
| Symbol | Type |
|--------|------|
| `Tab` | "catalog" \| ... |
| `ModelEntry`, `StackEntry` | interface |
| `GpuInfo` | { index, name, memory_total_mib, memory_free_mib, utilization_pct, temperature_c, power_draw_w } |
| `CpuInfo` | { name, cores, speed_mhz } |
| `EngineConfig` | mirrors Rust EngineConfig |
| `ProviderConfig`, `ParamDef` | with factory_default field |

---

## Dead Zones

### Unused Rust Functions
1. **`Win32HidDevice::open(vid, pid)`** — Opens by VID/PID directly via libloading; never called (use `enumerate_device_paths` + `open_by_path` instead)
2. **`Win32HidDevice::send_get_feature_report(query, buf)` — Feature report read-back; defined but unused in handshake code which uses write_raw for bulk pipe only
3. **`PeripheralManager::run_wmi_probe()` — WMI class probe result stored but never used by any consumer (result not connected to UI)
4. **`PeripheralManager::get_current_effect(template, state)` — Returns LightingEffect; caller ignores return value in `set_system_state` event loop

### Unused React Components
1. **`components/MobileSentinelPage.tsx`** — Exported from App but only rendered when tab === "sentinel"; no navigation to this tab exists in Layout (no nav link)
2. **`components/IntelWidget.tsx`** — Imported by TelemetryPanel but never referenced in JSX

---

## Patches (`//TODO`, `//FIXME`, etc.)

### Rust
| File | Line | Content |
|------|------|---------|
| `target/debug/build/clang-sys-*/out/dynamic.rs | 244 | `// FIXME: Maybe we can just hardlink or symlink it?` (third-party build artifact) |

### TypeScript / JSON
*None found — no TODO/FIXME/TEMP comments in frontend source.*

---

## File Inventory

```
src/
├── App.tsx                    # State hub, IPC listeners, tab routing
├── main.tsx                  # Vite entry, Tauri mount
├── app.css                   # Tailwind directives + custom dark theme (stealth-*, nv-* palettes)
├── lib/types.ts              # Frontend type mirrors of Rust types
├── components/
│   ├── ConfigPage.tsx        # Param editor with admin lock/unlock
│   ├── ProvidersConfig.tsx    # Provider CRUD, template_type dropdown
│   ├── ModelCatalog.tsx      # Directory scanner + launch UI
│   ├── StackView.tsx         # 4-slot engine stack display
│   ├── EngineCard.tsx       # Per-slot card with stop button
│   ├── TelemetryPanel.tsx   # GPU grid + IntelWidget integration
│   ├── Reactor11.tsx        # R11 tab container
│   │   ├── R11_Core.rs      # Core GPU allocation UI
│   │   ├── R11_Wells.rs    # VRAM well visualization
│   │   └── ...
│   ├── Layout.tsx          # Tab bar + status bar (totalParams, hiddenCount)
│   ├── ValueBubbles.tsx     # Per-param value display
│   ├── ParamEditor.tsx       # Row editor component
│   └── StatusIcon.tsx       # Engine status indicator
└── context/
    └── StatusBarContext.tsx  # totalParams/hiddenCount provider

src-tauri/src/          (23 Rust source files)
├── main.rs              # Tauri builder; WebView2 cache clear (debug); MCP bridge (debug only)
├── engine.rs           # launch/stop/list providers
├── engine_stack.rs    # 4-slot EngineStack
├── config.rs         # Genesis providers, template update logic
├── templates.rs       # build_command, get_value, template_type_for_id
├── types.rs          # ParamDef, ProviderConfig, ModelEntry
├── log_hub.rs      # Batched stdout forwarding to frontend
├── telemetry.rs     # GPU + CPU telemetry polling
├── vram.rs          # VRAM fit calculator
├── engine_perf.rs    # TPS/TTFT parsing from engine output
├── nvml_probe.rs   # NVIDIA NVML bindings
├── intel.rs         # CPU info via registry
├── peripherals.rs   # PeripheralManager singleton
│   ├── workers.rs  # HID + LCD worker threads
│   └── handshake.rs # Ryujin III init sequence
├── win32_hid.rs    # Win32 SetupDi/HidD raw device access
├── lcd_protocol.rs  # ASUS LCD packet format (1024B)
├── dashboard.rs     # tiny-skia 800×480 render
├── reactor_bridge.rs # estimate_vram + insert_rod
├── reactor_foundry.rs # GPU allocation finder
└── mobile_bridge.rs # Mobile sentinel GPU list

src-tauri/config/
└── genesis_template.json   # Embedded at compile time; defines all provider params (ggml-stable, ggml-dev, ik-extreme)
```