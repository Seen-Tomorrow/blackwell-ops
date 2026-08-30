# VRAM forecast / fusion UI — traps

Gotchas and invariants for the ASSISTED forecast glass and running fusion overlay.  
**Not** a component map — read source for structure. Backend SOURCE model: `docs/VRAM-FORECAST.md`. Glass stack: `docs/display-bezel-glass.md`.

Primary code:

| Area | Where |
|------|--------|
| Heights | `src/lib/onboardingDisplay.ts`, `src/lib/benchPanelLayout.ts` — applied by `EngineGpuForecast` |
| Forecast shell | `src/components/VramBadge.tsx` (one ASSISTED glass; no FULL AUTO fork) |
| SOURCE / NEED | `src/components/MemorySourcePanel.tsx` |
| GPU bank | `src/components/GpuTopology.tsx` |
| CSS | `src/styles/fusion-display.css`, `src/styles/config.css` |
| Theme tokens | `src/themes/app-themes.ts`, `src/styles/tokens-base.css` |

---

## Phosphor heights are **not** one number

| Constant / helper | Use |
|-------------------|-----|
| `FORECAST_PHOSPHOR_HEIGHT_1ROW_PX` (248) | ASSISTED when GPU bank fits **one** row |
| `FORECAST_PHOSPHOR_HEIGHT_2ROW_PX` (300) | ASSISTED when bank needs **two** visible rows |
| `computeForecastPhosphorHeightPx(gpuCount, perRow)` | Shared by forecast, EVALUATING radar, and LOADING boot |
| `FUSION_*` in `benchPanelLayout.ts` | **Running** overlay only — header + hero + latch + bench |

**Do not** set fusion tray height from `FORECAST_PHOSPHOR_HEIGHT_*`. Coupling them reintroduced ~50px dead space above the BENCHMARK latch after ASSISTED grew to 280.

**Do not** hardcode skeleton CSS to 280 — `EngineGpuForecast` applies `forecastHeightPx` so model/GPU-bank changes don’t jump the glass.

**Do not** write glass height from `VramBadge` via `closest()`. The phosphor node owns its height.

**Evaluator traps**
- Show EVALUATING radar on **model** or **hard-knob** change (`probeKey`). Hold previous paint only for soft same-identity LEARNED re-fetch / RE-PROBE.
- Auto-probe must not skip solely because the learned **curve** has this CTX (curve ignores batch/ubatch/flash). Skip only when LEARNED/curve can already paint, or a probe session already matches the hard key.

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

**EINK (DOTTED) badge treatment**

- Badge / bars / GPU topo on the eink face use the **same base (paper) treatment** — no eink-specific chip wells, need-frame plate, or reverse washes (removed 2026-08; ARCTIC visual pass: paper looked better). Only the general eink face ink (`--display-face-light-text-*` utilities on the phosphor surface) remains eink-specific.

---

## Display texture grain

- **EINK** and **CRT**: **dots only**. Horizontal scan bands off (`--display-face-*-band-opacity: 0`).  
- Do not reintroduce harsh scan stripes on the CRT face.

---

## Engine config chip rails (batch / ubatch / …)

Sliding thumb must track the **selected chip box** (`offsetLeft/Top/Width/Height`).  
Full-rail `top/bottom` stretch looks like **two** selections when the value row wraps.  
See `ConfigChipSegment` in `EngineParamGroups.tsx` + `.config-value-segment__thumb` in `config.css`.

## CTX learned marks

Ticks come from `get_learned_vram_curve` → hook `learnedCurveCtxs`, **not**
from `evaluate()` / forecast skeleton. Do not bind the rail only to
`manifest.learnedCurveCtxs` or EVALUATING hides known launches.
Hide reasons that are *not* a missing store: strip toggle ALL/REGULAR/OFF,
mark outside slider min/max, `spec`/draft/split mismatch on the curve query.
Full memo: `docs/LOW-VRAM-REPROBE.md` § CTX slider learned marks.

## Product layout decision

**One ASSISTED forecast layout** for the glass. FULL AUTO remains a launch policy (FIT / chrome lock), not a second forecast UI.


---

## AGENTS.md CSS law (still applies)

- Tokens only; no new `[data-theme=…]` component forks.  
- ARCTIC paper differences → `app-themes.ts` tokens, one CSS rule.  
- Domain CSS in `fusion-display.css` / `config.css`, not ad-hoc theme sheets.  
