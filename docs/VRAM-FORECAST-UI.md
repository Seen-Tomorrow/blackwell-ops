# VRAM forecast / fusion UI — traps

Gotchas and invariants for the ASSISTED forecast glass and running fusion overlay.  
**Not** a component map — read source for structure. Backend SOURCE model: `docs/VRAM-FORECAST.md`. Glass stack: `docs/display-bezel-glass.md`.

Primary code:

| Area | Where |
|------|--------|
| Heights | `src/lib/onboardingDisplay.ts`, `src/lib/benchPanelLayout.ts` |
| Forecast shell | `src/components/VramBadge.tsx` |
| SOURCE / NEED | `src/components/MemorySourcePanel.tsx` |
| GPU bank | `src/components/GpuTopology.tsx` |
| CSS | `src/styles/fusion-display.css`, `src/styles/config.css` |
| Theme tokens | `src/themes/app-themes.ts`, `src/styles/tokens-base.css` |

---

## Phosphor heights are **not** one number

| Constant / helper | Use |
|-------------------|-----|
| `FORECAST_PHOSPHOR_HEIGHT_1ROW_PX` (228) | ASSISTED forecast when GPU bank fits **one** row |
| `FORECAST_PHOSPHOR_HEIGHT_2ROW_PX` (280) | ASSISTED when bank needs **two** visible rows |
| `computeForecastPhosphorHeightPx(gpuCount, perRow)` | Picks 1- vs 2-row |
| `FUSION_*` in `benchPanelLayout.ts` | **Running** overlay only — header + hero + latch + bench |
| Boot / EVALUATING radar | Always **280** (2-row). Short-lived; do not squash to 1-row |

**Do not** set fusion tray height from `FORECAST_PHOSPHOR_HEIGHT_*`. Coupling them reintroduced ~50px dead space above the BENCHMARK latch after ASSISTED grew to 280.

`VramBadge.applyFusionDisplayHeight`:

- No engine → forecast height from GPU count  
- `LOADING` → 280  
- `RUNNING` → `computeFusionPhosphorHeightForTray` / dual-stack helpers  

---

## GPU topo bank (forecast)

- **1 GPU** → single full-width column (not half of a 2-col grid).  
- **perRow 2|3** (bezel GPU 2|3) only when `count > 1`.  
- **Visible rows** = `min(ceil(n/cols), 2)`. Extras **scroll** inside the 2-row bank.  
- CSS row geometry uses `--gpu-topo-max-rows` from **visible** rows — never force 2-row `cqh` split on a 1-row bank (that left empty air under one GPU).  

---

## MEMORY FORECAST SOURCE + NEED frame

**Layout (ASSISTED measure cluster)**

```
SOURCE strip (lab · LEARNED)     |  status (EXACT / INTERPOLATED / …)
VRAM / RAM tracks                |  need GB  (aligned to bars via subgrid)
```

- Status sits **above** the need GB column, not between VRAM/RAM.  
- RE-PROBE lives on the **launch-summary header** (provider-pill tokens), not in the NEED frame.  
- Live cue on NEED = **perimeter rim only** (monochrome conic chase).  
  - RE-PROBE → solid chase + spark  
  - CTX scrub → **dashed** slower chase  
  - Never full-face equalizer over the GB readout  

**SOURCE strip plate**

- Default transparent.  
- ARCTIC dark flat plate via `--display-face-source-plate-bg` in **theme tokens** — **no** `[data-theme="arctic"]` in CSS.  

**Hover recap**

- Anchor to the **content-sized** SOURCE cluster (`flex: 0 0 auto`), `right: 0` under the label — not full-strip `left: 0`.  
- Flat panel: `--display-face-recap-bg` / `-text` / `-text-muted`. ARCTIC reuses **SLATE** panel/text values.  

**DISPLAY LIGHT paper ink**

- Launch summary ok/fail → `--display-face-light-readout` / `-text-accent` / `-text-red` (not bright accent wash).  
- NEED / GPU reverse washes on paper: `--display-face-light-plate-ink*` or CLEAN face plate tokens.  

---

## Display texture grain

- **LIGHT** and **DARK**: **dots only**. Horizontal scan bands off (`--display-face-*-band-opacity: 0`).  
- Do not reintroduce harsh CRT stripes on DARK.  

---

## Engine config chip rails (batch / ubatch / …)

Sliding thumb must track the **selected chip box** (`offsetLeft/Top/Width/Height`).  
Full-rail `top/bottom` stretch looks like **two** selections when the value row wraps.  
See `ConfigChipSegment` in `EngineParamGroups.tsx` + `.config-value-segment__thumb` in `config.css`.

---

## Product layout decision

**One ASSISTED forecast layout** for the glass. FULL AUTO as a second UI was deferred — prefer policy/behavior flags over a second visual system if revived.

---

## AGENTS.md CSS law (still applies)

- Tokens only; no new `[data-theme=…]` component forks.  
- ARCTIC paper differences → `app-themes.ts` tokens, one CSS rule.  
- Domain CSS in `fusion-display.css` / `config.css`, not ad-hoc theme sheets.  
