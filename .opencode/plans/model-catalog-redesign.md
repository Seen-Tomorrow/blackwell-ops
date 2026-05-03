# Model Catalog Redesign — Plan v2 ✅ COMPLETE (except keyboard zones)

## Status: 90% Done
All changes implemented and build passes. Keyboard zones deferred (step 9) — requires stable DOM structure after visual changes are validated.

## Completed Changes

### 1. Genesis Template ✅
- Device: `Multi-GPU` → `Core` (all providers)
- Unified-KV: `Performance` → `Feature Flags`
- Flash-Attn: `Feature Flags` → `Performance`

### 2. VRAM Display/Calc Split ✅
- `displayVramMib` = manufactured capacity (what users see: "192 GB")
- `availableVramMib` = real free memory for fit calculations
- Removed `osOverheadMib` from display chain entirely

### 3. EngineConfigPanel Grouped Rendering ✅
- Collapsible groups with localStorage persistence
- Core + Performance always open, Multi-GPU + Feature Flags collapsible
- Dynamic Multi-GPU elevation when model > single GPU VRAM
- Provider param count badge: `(19)` next to name
- Model identity header marked for removal (`opacity-70`)

### 4. VramBadge Overhaul ✅
- Removed "MEMORY FORECAST" label
- Centered forecast numbers with green available VRAM
- FIT CHECK inline with guidance text (saves ~35px)

### 5. GpuTopology Fixes ✅
- Full GPU names from telemetry (no truncation)
- Manufactured VRAM display: `/96 GB` per card
- Percentage badge on bar right edge
- RAM bar full-width, shows when Multi-GPU elevated OR spill > 0
- Removed single GPU recommendation hint

### 6. Telemetry Panel ✅
- Total VRAM in green (`text-nv-green`)
- Per-GPU cards show manufactured capacity in GB

### 7. Model Catalog Styling ✅
- Sort label: "SIZE STR" → "SIZE"
- Vision eye icon (👁) after model name
- Quant styling: cyan border default, NVFP4 gets green bg+border

## Deferred
- **Keyboard zones** — requires stable DOM structure after visual changes validated. Will implement once user confirms layout is correct.

## Goal
Reorganize launch config panel: collapsible param groups, context-aware Multi-GPU elevation, compact FIT CHECK, zone-based keyboard navigation, GPU topology polish, catalog table alignment, and telemetry VRAM display fixes.

---

## 1. Genesis Template Group Changes

**File:** `src-tauri/config/genesis_template.json` (both `ggml-stable` and `ggml-dev` sections)

| Param | From ui_group | To ui_group |
|---|---|---|
| Device | `"Multi-GPU"` | `"Core"` |
| Unified-KV | `"Performance"` | `"Feature Flags"` |
| Flash-Attn | `"Feature Flags"` | `"Performance"` |

Resulting groups:
- **Core** (3): KV-Quant, CTX, Device — always open
- **Performance** (4): Batch, uBatch, Parallel, Flash-Attn — always open
- **Multi-GPU** (3): Offload, Offload_Mode, Split — collapsible, elevatable
- **Feature Flags** (8): Vision, Reasoning, MMAP, Unified-KV, Jinja, Cont-Batching, Metrics, Verbose, Log-Timestamps — collapsible

For `ik-extreme`: no changes needed.

---

## 2. EngineConfigPanel — Grouped Param Rendering + Multi-GPU Elevation

**File:** `src/components/EngineConfigPanel.tsx`

### 2a. Group config
```ts
const PARAM_GROUPS = [
  { id: 'Core', label: 'CORE', alwaysOpen: true },
  { id: 'Performance', label: 'PERFORMANCE', alwaysOpen: true },
  { id: 'Multi-GPU', label: 'MULTI-GPU', alwaysOpen: false, elevatable: true },
  { id: 'Feature Flags', label: 'FEATURE FLAGS', alwaysOpen: false },
];
```

### 2b. Collapsible state (localStorage persisted)
Default collapsed: `['Multi-GPU', 'Feature Flags']`. Chevron toggle per group header.

### 2c. Group-aware rendering replaces flat param loop (lines ~292-335)
Each group renders as a collapsible section. Elevated Multi-GPU skipped from inline params list.

### 2d. Dynamic Multi-GPU Elevation
**Condition:** `model.size_mib > gpus[0].memory_total_manufactured` (use manufactured, not BIOS-reported)

When true: render Multi-GPU as its own section **between Memory Forecast and Parameters**, with label `"⚡ MULTI-GPU REQUIRED — Model exceeds GPU VRAM"`. Removed from collapsible params below.

### 2e. Provider buttons — param count badge
Add param count to each provider pill:
```tsx
// Current: {p.display_name || p.id}
// New: {p.display_name || p.id} <span className="opacity-50">({paramCount})</span>
```

### 2f. Model identity header — mark for removal
Add `// REMOVE ??` comment on the model identity header block (lines ~214-240). Keep functional, visually dimmed with reduced opacity. May remove later once confirmed redundant with catalog card info.

---

## 3. Memory Forecast / VramBadge Overhaul

**File:** `src/components/VramBadge.tsx` + `src/components/GpuTopology.tsx`

### 3a. Remove "MEMORY FORECAST" section label
Remove the `<label>` that renders "MEMORY FORECAST" in EngineConfigPanel (line ~271-274). The forecast speaks for itself — no header needed.

### 3b. Centered forecast numbers
The `neededGb / availableStr` line should be **centered**, not left-aligned. It represents the combined system view:

```tsx
// Current: flex items-baseline gap-2 (left-aligned)
// New: flex items-baseline justify-center gap-2
<div className="flex items-baseline justify-center gap-2">
  <span className={`text-xl font-mono ${cfg.color}`}>{neededGb}</span>
  <span className="text-[10px] font-mono text-stealth-muted">GB needed /</span>
  <span className="text-[10px] font-mono text-nv-green">{availableStr} GB available</span>
</div>
```

The "needed" number keeps its status color. The "available" number is **always green** (`text-nv-green`) — users want to see their total VRAM capacity in a positive color.

### 3c. FIT CHECK inline (estimated state only)
Remove dedicated button row. Inline with guidance text:
```tsx
<div className="flex items-center justify-center gap-2">
  <span className={`text-[9px] font-mono ${cfg.color}`}>→ {action}</span>
  {onFitCheck && (
    <button ... className="px-2 py-0.5 text-[8px] font-mono border border-telemetry-cyan/40 text-telemetry-cyan hover:bg-telemetry-cyan/10 rounded-sm">
      {isScanning ? 'CALIBRATING...' : 'FIT CHECK'}
    </button>
  )}
</div>
```

Saves ~35px vertical space.

---

## 4. GPU Topology — Names, VRAM Display, RAM Bar

**File:** `src/components/GpuTopology.tsx` + `src/hooks/useVramCalculator.ts`

### 4a. Fix GPU names
Remove the `shortGpuName()` truncation function entirely. Use `gpu.name` directly from telemetry (full name like "NVIDIA RTX PRO 6000 BLACKWELL"). The name comes from nvidia-smi, already correct in telemetry.rs:91-95.

If name is too long for the card, use CSS `truncate` with a full-name tooltip (`title={gpu.name}`), not programmatic truncation.

### 4b. Per-GPU VRAM numbers — green + manufactured capacity
Change per-GPU memory display to show **manufactured capacity** (96 GB, not ~98 BIOS):

```tsx
// Current: uses gpu.totalMib (from memory_total = BIOS-reported)
// New: use memory_total_manufactured from GpuInfo
<span className="text-[8px] font-mono text-nv-green">
  {(gpu.projectedMib / 1024).toFixed(1)} GB
</span>
<span className="text-[8px] font-mono text-stealth-muted/50">
  /{(gpu.totalManufacturedMib / 1024).toFixed(0)} GB
</span>
```

The projected number (used VRAM) in **green** (`text-nv-green`) — users want to see their memory numbers prominently. The total capacity stays muted as reference.

Need to pass `memory_total_manufactured` through the chain:
1. Add `totalManufacturedMib` to `GpuDistribution` interface in useVramCalculator.ts
2. Populate from `gpus[i].memory_total_manufactured` when building distribution
3. Use in GpuTopology rendering

### 4c. RAM bar — full width, conditional display
The system RAM bar should be **full-width** (spans both GPU columns), shown when:
- Model doesn't fit total GPU VRAM (`spillMib > 0`), OR
- Multi-GPU group is elevated (model exceeds single GPU)

```tsx
{showRam && (
  <motion.div className="pt-2 border-t border-stealth-border/20">
    <div className="flex justify-between items-center mb-1">
      <span className="text-[8px] font-mono text-stealth-muted tracking-wider">SYSTEM RAM</span>
      <span className={`text-[8px] font-mono ${ramColor}`}>
        {(spillMib / 1024).toFixed(0)} GB spill / {totalRamGb} GB ({percentage.toFixed(0)}%)
      </span>
    </div>
    <div className="h-1.5 bg-depth-black/50 rounded-sm overflow-hidden border border-stealth-border/20">
      {/* fill bar */}
    </div>
  </motion.div>
)}
```

Pass `shouldShowRam` from VramBadge based on elevation state + spill amount. Currently `ramEstimate.spillMib > 0` only triggers when model exceeds ALL GPU VRAM combined. Need to also trigger when Multi-GPU is elevated (model > single GPU but ≤ total).

### 4d. Percentage badge repositioning
Move percentage from header row to right edge of the bar itself (saves ~8px per card):

```tsx
<div className="relative h-2">
  <div className="absolute inset-0 bg-depth-black/50 rounded-sm ..." />
  <motion.div style={{ width: `${Math.min(percentage, 100)}%` }} ... />
  <span className="absolute right-0 top-0 text-[7px] font-mono translate-x-full ml-1">
    {percentage.toFixed(0)}%
  </span>
</div>
```

### 4e. GPU grid — up to 16 GPUs, 2 per row
Already supported by `grid-cols-2` CSS. No change needed. The grid naturally wraps: 8 rows × 2 = 16 GPUs max visible. Verified in current GpuTopology.tsx:37.

### 4f. Single GPU handling
When `gpus.length === 1`: show one centered card (use `max-w-[48%]` class already on line 37), no "2nd GPU recommended" hint text — remove it, too condescending for power users.

---

## 5. VRAM Display vs Calculation Separation (Critical Fix)

**Files:** `src/components/EngineConfigPanel.tsx`, `src/App.tsx`, `src/hooks/useVramCalculator.ts`

### The Problem
Currently one value (`availableVramMib`) serves two purposes: display AND calculation. It uses BIOS-reported `memory_total` minus overhead, giving "191 GB" instead of clean "192 GB".

### The Fix — Two Independent Values

**EngineConfigPanel.tsx (line ~73):**
```ts
// NEW: Display value — manufactured capacity, no deductions
const displayVramMib = gpus.reduce((sum, g) => sum + (g.memory_total_manufactured || g.memory_total), 0);

// UNCHANGED: Calculation value — real available for fit decisions
const availableVramMib = Math.max(0, 
  gpus.reduce((sum, g) => sum + g.memory_free, 0) - committedVramMib);
```

**Pass both to VramBadge:**
- `displayVramGb` (from `displayVramMib / 1024`) → shown as "available" number in green
- `availableMib` (unchanged) → used for dirty math fit calculations, status determination

**Key rules:**
- Display always shows manufactured capacity: 96 GB per RTX PRO 6000 = 192 GB total. Clean numbers.
- Calculations use `memory_free` (real available after OS/driver usage). Accurate fit decisions.
- Remove the `osOverheadMib` subtraction from display entirely — it's a CUDA safety margin, not a user-visible concept
- The "committed VRAM" note at the bottom of VramBadge still shows running engine usage

### 5b. Telemetry Panel (unchanged)
TelemetryPanel.tsx:14 already uses `memory_total_manufactured || memory_total` for total display — correct. Per-GPU cards show BIOS values currently; update to manufactured + green color for capacity numbers.

---

## 6. Model Catalog — Table Alignment + Styling

**File:** `src/components/ModelCatalog.tsx`

### 6a. Search includes author + quant
Already does: line ~73-77 filters by name, author, and quant. ✅ No change needed.

### 6b. Sort column "SIZE STR" → "SIZE"
Line 116: Change display label from `field.replace("_", " ")` which produces "size str" to a mapping:

```tsx
const sortLabels: Record<string, string> = {
  name: 'NAME', author: 'AUTHOR', quant: 'QUANT', size_str: 'SIZE'
};
// Use sortLabels[field] || field.replace("_", " ")
```

### 6c. Table-like alignment for model cards
Replace the current flex layout with a CSS grid that aligns columns perfectly:

```tsx
{/* Model card content */}
<div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center">
  <span className="text-xs font-mono truncate text-white">{model.name}</span>
  <span className="text-[9px] font-mono text-stealth-muted truncate max-w-[80px]">{model.author}</span>
  <span className={`text-[9px] font-mono flex-shrink-0 ${quantStyle}`}>{model.quant}</span>
  <span className="text-[9px] font-mono text-stealth-muted flex-shrink-0">{model.size_str}</span>
</div>
```

The vision eye icon goes **after** the model name, not before:
```tsx
<div className="flex items-center gap-1 min-w-0">
  <span className="text-xs font-mono truncate">{model.name}</span>
  {model.vision && (
    <span className="text-[8px] flex-shrink-0" title="Vision capable">👁</span>
  )}
</div>
```

### 6d. Quant styling
- Default quant: cyan border (`border border-telemetry-cyan/30 text-telemetry-cyan`)
- NVFP4 (native Blackwell best): green background + border (`bg-nv-green/20 border border-nv-green/40 text-nv-green`)

```tsx
const isNvfp = model.quant.toUpperCase().includes('NVFP');
const quantClass = isNvfp
  ? 'text-[9px] font-mono px-1.5 py-0.5 bg-nv-green/20 border border-nv-green/40 text-nv-green rounded-sm'
  : 'text-[9px] font-mono px-1.5 py-0.5 border border-telemetry-cyan/30 text-telemetry-cyan rounded-sm';
```

---

## 7. Keyboard Zone Navigation

**New file:** `src/hooks/useKeyboardZones.ts`
**Integration:** `src/components/ModelCatalog.tsx`

### Zones: search → models → config

| Key | Effect |
|---|---|
| `/` or `Ctrl+K` | Enter search zone, focus input |
| `Esc` (from search) | Blur search, return to none |
| `↑`/`↓` (zone=none) | Enter models zone, highlight row |
| `Enter` (models zone) | Select highlighted model, exit zone |
| `Tab` / `Shift+Tab` | Cycle zones: search → models → config → search |
| `↑`/`↓` (config zone) | Move between visible param rows |
| `←`/`→` (config zone) | Cycle chip values within current param row |
| `Enter` (config zone) | Activate selected chip value |
| `Esc` (any zone) | Exit to none |

### Visual indicator: Left-edge glow bar per active zone
- Search: cyan border-left
- Models: green border-left on left panel
- Config: magenta border-left on right panel

### Implementation
- Single `useEffect` with document-level keydown listener when catalog tab active
- Zone state in ModelCatalog, passed as props to child components
- No DOM focus management — zone + arrows handle navigation visually
- Search input gets real `.focus()` only in search zone

---

## Summary of Files to Change

| File | Changes | Scope |
|---|---|---|
| `src-tauri/config/genesis_template.json` | ui_group reassignments (6 edits) | Small |
| `src/components/EngineConfigPanel.tsx` | Grouped rendering, Multi-GPU elevation, provider param count, model header comment, **displayVramMib split** | **Large** |
| `src/components/VramBadge.tsx` | Remove label, center numbers, inline FIT CHECK, green available VRAM (manufactured) | Medium |
| `src/components/GpuTopology.tsx` | Full GPU names, manufactured VRAM, RAM bar full-width + conditional, badge reposition, remove single-GPU hint | **Medium** |
| `src/hooks/useVramCalculator.ts` | Add totalManufacturedMib to GpuDistribution, fix ramEstimate trigger condition | Small |
| `src/components/TelemetryPanel.tsx` | Green capacity numbers (manufactured) | Small |
| `src/App.tsx` | Remove osOverheadMib from display chain (keep for calculation only) | Small |
| `src/components/ModelCatalog.tsx` | Table alignment, vision eye after name, quant styling (cyan/NVFP4 green), sort label mapping, keyboard zones integration | **Medium** |
| `src/hooks/useKeyboardZones.ts` | NEW — zone navigation hook | Medium |

## Execution Order
1. Genesis template edits (unblocks grouped rendering)
2. VRAM display/calculation split (EngineConfigPanel + App) — **foundational, unblocks everything visual**
3. EngineConfigPanel grouped rendering + Multi-GPU elevation
4. VramBadge overhaul (label removal, centering, inline FIT CHECK, green numbers)
5. GpuTopology fixes (names, manufactured VRAM, RAM bar)
6. useVramCalculator chain updates (manufactured Mib passthrough)
7. Telemetry panel VRAM display polish
8. Model catalog table alignment + quant styling
9. Keyboard zones (last — depends on stable DOM structure from all above changes)
