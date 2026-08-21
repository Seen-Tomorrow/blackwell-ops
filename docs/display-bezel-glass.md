# Industrial display — bezel, glass, content

Memo for humans and agents. If a change “looks inset” or the glass doesn’t fill the metal, read this before adding another box-shadow or nested surface.

Primary CSS: `src/styles/fusion-display.css`  
Mount: `EngineConfigPanel` (frame + glass) → `VramBadge` (forecast or fusion fill)

---

## One-line model

**Frame padding = metal bezel · `phosphor-screen-inner` = full glass (texture + one recess shadow) · children = content only.**

There is **one** display glass. Forecast and fusion share it. Fusion is **not** a second glass.

---

## Layer cake (outside → in)

```
.industrial-display-area          /* panel mat behind the unit */
  .industrial-display-frame       /* GUNMETAL BEZEL — pad + metal texture + cast */
    [optional] .industrial-display-frame__top-chrome   /* absolute in top pad */
    .phosphor-screen-inner.phosphor-display-surface    /* GLASS — full content box */
      .vram-badge-forecast        /* content stack only — no glass chrome */
        forecast UI  OR  .fusion-overlay-fill → FusionOverlay
```

| Layer | Class | Owns |
|--------|--------|------|
| Bezel metal | `.industrial-display-frame` | Outer cast, hard metal edge, industrial texture (`::before`), **padding = rim thickness** |
| Glass | `.phosphor-screen-inner` (+ `.phosphor-display-surface`) | Face color, CRT / e-ink texture, **one unified inset recess shadow** |
| Content | `.vram-badge-forecast`, `.fusion-overlay-fill` | Layout, text, bars — **transparent**, no second rim/shadow/texture |

---

## Bezel thickness = frame padding

Metal lip width is **only** `.industrial-display-frame` padding.

- **Top:** thin base pad; with top-chrome, `padding-top: 36px` (controls live in that band — absolute, not a second stack).
- **Left / right / bottom:** thicker lip (restored ~18px). Do **not** “thicken bezel” by padding nested content or inventing margins on the glass.

Share capture may force equal pad for export geometry; live UI keeps top vs L/R/B split.

---

## Glass shadow (unified)

**One** recess on `.phosphor-screen-inner` for **all** app themes and **all** display textures:

```css
box-shadow:
  inset 0 1px 0 /* edge hi */,
  inset 0 2px 6px var(--theme-phosphor-inset-top),
  inset 0 -1px 3px var(--theme-phosphor-inset-bottom);
```

- Sits on the **inner edge of the metal** (glass face), not on nested fusion fill.
- **No** per-texture / per-theme shadow forks (no DARK-only / LIGHT-only second recipe).
- Softness may still come from theme tokens (`--theme-phosphor-inset-*` in `app-themes.ts`); structure does not.
- Frame keeps outer cast + hard edge only — **not** a second soft pocket that competes with glass.

Reference look: ARCTIC + LIGHT recess on the glass edge.

---

## Display textures (face only)

`data-display-texture` on the display area: `clean` | `phosphor-dark` | `phosphor-light`.

- Apply **face** recipes only to **`.phosphor-screen-inner.phosphor-display-surface`** (full glass).
- Do **not** put `phosphor-display-surface` / CRT / e-ink grain on fusion fill or forecast badge.
- LIGHT grain lives on glass `::before` / `::after` — must cover the **full** glass, not a smaller child.

Legacy storage value `glitch` migrates to `clean`. Glitch overlay DOM (`DisplayGlitchOverlay`, `.display-glitch-*`) is **removed** — do not revive.

---

## HW monitor widgets (right rail)

Display texture also covers HW monitor cells (not only forecast/fusion).

| Surface | Class | Texture host |
|---------|--------|----------------|
| Main glass | `.phosphor-screen-inner.phosphor-display-surface` | full CRT / e-ink + **recess shadow** |
| HW widgets | `.launch-rail-tel .phosphor-display-surface` (totals / CPU / GPU / topo cards) | **same face** (CLEAN / DARK / LIGHT), **no** glass recess shadow |

- `data-display-texture` is set on `.launch-rail-tel` (see `LaunchRailTelemetry.tsx`).
- Face recipes live in `fusion-display.css` paired selectors:
  - glass: `.phosphor-screen-inner…`
  - rail: `.launch-rail-tel[data-display-texture="…"] .phosphor-display-surface`
- Widget chrome (borders, ink on LIGHT) lives in `launch.css`.
- **Not** the catalog quiet wing: catalog desaturate is only  
  `[data-model-catalog] .catalog-list-panel { filter: saturate(…) }` — never the launch rail.
- Do not leave LIGHT ink on a transparent / black-wash widget face (reads as a veil). LIGHT must set `--fusion-eink-surface` on the widget face like the main glass.

---

## Forecast vs fusion

| Mode | Glass | Content |
|------|--------|---------|
| Memory forecast | Same `.phosphor-screen-inner` | `.vram-badge-forecast` with content padding (`px-3 py-2` is for **text**, not a second display) |
| Fusion (engine loading/running) | Same glass | `data-fusion-only` badge: **padding 0**; `.fusion-overlay-fill` (no phosphor classes); FusionOverlay may use its own `px/py` for widgets |

Never reintroduce:

```text
.phosphor-screen.phosphor-display-surface + rounded + border + p-[6px]
```

That nested “inner display” only showed under fusion + LIGHT and fought the full-glass model.

---

## What to change for common requests

| Want | Change |
|------|--------|
| Thicker/thinner metal (L/R/B or top) | Frame `padding` (and top-chrome `padding-top` if needed) |
| Stronger/softer glass recess | Tokens `--theme-phosphor-inset-*` and/or the **single** rule on `.phosphor-screen-inner` |
| Dot matrix / e-ink / clean face | Texture selectors on **`.phosphor-screen-inner.phosphor-display-surface` only** |
| Content inset from glass edge | Padding on forecast badge or FusionOverlay — **not** a nested glass |
| Bezel face grit / brush / diamond | Industrial bezel texture cycle (`html[data-industrial-bezel]`, frame `::before`) — separate from phosphor texture |

---

## Files that matter

| Area | Where |
|------|--------|
| Frame, glass, textures, share-stage bezel | `src/styles/fusion-display.css` |
| Theme phosphor inset / e-ink tokens | `src/themes/app-themes.ts`, `src/styles/tokens-base.css` |
| Frame + glass mount | `EngineConfigPanel.tsx` |
| Forecast / fusion fill | `VramBadge.tsx` (`fusion-overlay-fill`) |
| Fusion widgets | `FusionOverlay.tsx` |
| Share capture host = glass face | `fusionShareCapture.tsx` → `.vram-forecast-display` / phosphor-screen-inner |

---

## Agent traps (do not repeat)

1. **Do not** nest a second `phosphor-display-surface` for fusion.
2. **Do not** put glass `box-shadow` on `.vram-badge-forecast` or `.fusion-overlay-fill`.
3. **Do not** re-add per-mode shadow chips “for LIGHT only” / “for DARK only”.
4. **Do not** use content `padding` / Tailwind `p-[6px]` to fake bezel thickness.
5. **Do not** revive `DisplayGlitchOverlay` or `.display-glitch-*`.
6. If something looks like a smaller screen inside the glass: search for a nested phosphor surface or unexpected pad on `data-fusion-only` first.

---

## Related
- Fusion metrics field names: `docs/FUSION-metrics.md` (if current)
- Forecast / fusion UI height + SOURCE/NEED traps: `docs/VRAM-FORECAST-UI.md`
