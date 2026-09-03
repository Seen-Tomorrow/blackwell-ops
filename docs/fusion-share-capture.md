# Fusion share capture — bezel layout, html-to-image quirks, micro-stats

Memo for humans and agents. If a share PNG comes out with the top buttons overlapping the
glass, the bezel too tall/short, a missing per-slot `xxx /slot` meter, or the small print
under the TG number showing stale values — read this before touching layout math or capture
styling.

**Layout was rewritten 2026-09-03** from hand-summed content budgets to *measure + uniform
scale*. Sections marked **(legacy)** describe the deleted design only so nobody rebuilds it.

Primary: `src/lib/fusionShareCapture.tsx` (capture pipeline) · `src/components/FusionOverlay.tsx`
(live micro-stats) · `src/components/BenchWidget.tsx` (bench ordering) · `src/styles/fusion-display.css`
(capture-stage CSS).

**Last aligned with code:** 2026-09-03 (measured glass + fixed 16:9 canvas + 2× raster)

---

## One-line model

The share capture is a **photograph of the live glass**, not a re-typeset copy. It clones the live
frame, drops card-only chrome, lays the clone out at **one reference width**, **measures** it, and
scales it uniformly into a **fixed 16:9 card**. Live CSS owns the glass; the card owns the mat.

Consequence: a fusion-display change needs **no mirror correction in the card** — if it fits live,
it fits the card, because the fit comes from a measurement. The deleted design did the opposite
(fixed content budgets + a ladder of size pins) and every live change had to be re-tuned twice,
which is why the card kept clipping.

---

## Capture pipeline (top → bottom)

```
renderFusionSharePngOnce(meta, variant)
  ├─ layout = computeFusionShareExportLayout(meta)      // fixed 900×506 CSS card, 16:9
  ├─ createFrameCaptureStage(sourceFrame, …)
  │    ├─ clone live frame; drop only industrial-display-frame--bottom-chrome
  │    ├─ clone width = layout.glassAreaWidthPx          // the one reference width
  │    └─ injectShareBezelBrand(frame)                   // bottom-right logo, inside the glass
  ├─ hideCaptureChrome(frame)              // CAPTURE_STRIP_SELECTORS → visibility:hidden
  ├─ removeCaptureChrome(frame)            // CAPTURE_REMOVE_SELECTORS → display:none
  ├─ prepareFusionOverlayForCapture / stripForecastPaddingForCapture / pinFusionCaptureFonts
  ├─ mountCaptureShell(stage) → measure → applyGlassFit()   // transform: scale(s)
  └─ captureMountedShell(headerShell) + html-to-image toCanvas(stage) @ PIXEL_RATIO
```

Stage mounts on `document.body` (WebView2 rasterizes on-screen nodes only) with
`--ui-text-scale: 1`, so **the user's app zoom never leaks into the card**.

---

## Key constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `FUSION_SHARE_EXPORT_CARD_WIDTH` | **900** | Card CSS width; height = 9/16 → 506. PNG 1800×1012. |
| `FUSION_SHARE_EXPORT_PIXEL_RATIO` | **2** | CSS→PNG. Under uniform scale the content is vector-rasterized, so crispness follows this number, not the clone's font sizes. X/Reddit serve ≤ ~1600px; 4× bought nothing and quadrupled html-to-image work per attempt. |
| `FUSION_SHARE_EXPORT_HEADER_HEIGHT` | **54** | Card header: identity row + config chip row (card-only UI, hand-built). The GPU identity lives in the glass top bezel, not the header. |
| `FUSION_SHARE_EXPORT_FRAME_PAD_X` / `_BOTTOM` / `_TOP` | **5** / 14 / 0 | Panel-accent mat. X is deliberately small — the bezel reads as full-bleed and 5px only keeps its cast shadow from being sawn off at the card edge. |
| `SHARE_ASPECT_W` / `_H` | 16 / 9 | **Card** aspect. The glass keeps whatever aspect live gives it. |
| `FUSION_CAPTURE_HERO_FONT_PX` / `_PER_SLOT_FONT_PX` | 40 / 20 | **The only pinned sizes.** `vh` inside the mounted stage resolves against the real window, so without these the card's proportions would differ between a 1080p and a 4K session. |

`computeFusionShareGlassFit(layout, measured)` → `scale = min(1, min(areaW/w, areaH/h))`.
It never upscales and never clamps *up*: a "legibility floor" would clip, because the fit box is
`overflow: hidden`. Worst real case is a 2× stacked display shrinking to ~0.6.

Glass area = `cardWidth − 2·PAD_X` × (`frameHeight − pads`). A tall glass shrinks and centers; the
leftover is mat. PNG dimensions never change with GPU count or bench state.

---

## Why the glass is measured, not budgeted

Two facts about this pipeline are still true, and they are why the old design hurt:

1. `html-to-image`'s `cloneCSSStyle` does `targetStyle.cssText = sourceStyle.cssText`, which
   **clobbers inline styles** with the source's computed style. A plain inline override can be
   silently discarded; `!important` survives.
2. The frame's metal pads come from `.industrial-display-frame--top-chrome` and
   `.industrial-display-frame:has(> .industrial-display-frame__top-chrome)` → `padding-top: 36px`
   (bottom 32px). Removing the class does **not** remove the pad, because `:has()` re-applies it.

**(legacy)** The old pipeline fought (2) three ways at once: remove the classes, force pads with
`!important`, and re-add the band height from `CAPTURE_TOP_CHROME_BAND_PX = 36` — three
hand-tuned numbers for one pad, the band iterated 72 → 44 → 36 by eye, plus
`computeFusionShareCapturePhosphorHeightPx()` summing dashboard chrome + max bench slot for the
glass height.

**Now:** pads apply from live CSS and are measured with the glass. Only `--bottom-chrome` drops
(its buttons are hidden, so its pad would read as dead metal). There is no band constant, no
phosphor budget, and no height pin left to keep in sync.

---

## What gets hidden from captures

Two lists, and the difference matters:

- `CAPTURE_STRIP_SELECTORS` → `visibility:hidden`, safe only for chrome that reserves **no** flow
  height (absolute buttons, toggles, hints): `[data-fusion-share-exclude]`,
  `[data-frame-bottom-chrome]`, `.display-texture-toggle`, `.industrial-bezel-texture-toggle`,
  `.vram-forecast-scenario-badge`, `.bench-hw-topo`, `.display-chrome-hints`.
- `CAPTURE_REMOVE_SELECTORS` → `display:none`, for anything that owns a row: `.fusion-bench-latch`.
  `visibility:hidden` **still occupies layout** — hiding the latch that way pushed the results
  block down by a latch row and clipped its unit line at the bezel edge. Anything with height
  belongs in the remove list.

`prepareFusionOverlayForCapture` hides every child of `.vram-badge-forecast` **except**
`.fusion-overlay-fill`, and forces the fusion panel to `opacity:1` + `animation:none` (the clone
restarts `fadeIn` at opacity 0). The per-slot meter lives *inside* the fusion panel, so it survives.

Removed earlier: the "single session" banner (`injectCaptureBezelModeBanner`) and its CSS.

---

## Per-slot `xxx /slot` meter in the share

- Rendered live in `FusionOverlay.tsx` (`.fusion-per-slot-meter`, `top-1.5 right-2` in the TG hero).
  Shows when `!suppressTgHero && concurrentSlots > 1`.
- Capture pins its font to `FUSION_CAPTURE_PER_SLOT_FONT_PX` (20) and repositions it
  (`top:6px; right:8px`) via `.fusion-share-capture-stage[data-fusion-share-capture]` rules.
- **It depends on the engine being in a concurrent TG state.** A solo TG bench leaves the slots
  concurrent → meter shows. A combined bench that *ends in PP* leaves the slots non-concurrent →
  meter missing. **Fix: combined bench runs PP first, then TG** so it ends in the TG state
  (`runBenchBoth` in `BenchWidget.tsx`). Do not reorder it back without re-checking the share card.

---

## Header anatomy (two rows) + GPU identity in the top bezel

`createHeaderShell` builds **identity** (provider · build · profile · CUDA · model · quant) →
**config chips** (`KV` → `CTX` → `batch/ubatch` → `flash-att` → **split** (amber) → `SPEC-TYPE` →
`DRAFT-N-MAX` → `DRAFT-N-MIN`). The header is a fixed 54px (identity + one chip row); the config
row is `flex: 1` and centered.

The **GPU identity** (`● 2× RTX PRO 6000 … 96GB drv 610.x`) is *not* in the header — it is injected
into the glass's **top bezel band** by `injectShareGpuIdentity`: a card-only `position: absolute`
overlay (`top: 0; right: 18px; height: 36px`) on the frame, vertically centered on the 36px top pad
so it reads as the label of the **DEVICE** cluster directly below it. Because it is a child of the
frame it scales with the fit, so it stays aligned with DEVICE at any scale. It reuses the
`.fusion-share-hw-band__chip|__swatch|__driver` classes (theme-token colored), so no new CSS.

The old bottom band and its `2 GPUs · TENSOR SPLIT` headline are gone — the count is in `2×`, the
split mode is a chip on the config row, and the band cost a row of card height under the glass.
`createShareHwBand` + its wrap estimate (`computeFusionShareHwBandHeightPx`) and the
`.fusion-share-hw-band__topo|__headline|__chips` CSS were deleted.

## SPEC chips ride the config row (Boost-derived, not the legacy `spec_type` key)

`SPEC-TYPE …`, `DRAFT-N-MAX …`, `DRAFT-N-MIN …` come from `collectShareSpecChips` ←
`FusionShareLaunchConfig.specType / specDraftNMax / specDraftNMin`, filled by `specShareFields()`
(`src/lib/specProfiles.ts`) — the same `buildSpecCliExtraParams` flattening launch emits, keyed off
Boost (`specBoostMethod`: mtp → `draft-mtp`, dflash → `draft-dflash`, dspark → `draft-dspark` with
the shared DFlash knobs).

**Do not** read `config.spec_type` / `spec_draft_n_max` / `spec_draft_n_min` for them. Those are
`OBSOLETE_SPEC_PARAM_KEYS`: stripped from the param list on load, therefore always `undefined`, and
the SPEC chips vanish silently — that was the empty-row bug; the spec-profile refactor
(`a54044a29`) caused it and `src/lib/specProfiles.test.ts` guards it.

Knobs hidden in Config are dropped as well — the CLI never receives them, so the card must not
claim them.

---

## Bench ordering + hero pinning (`BenchWidget.runBenchBoth`)

- Order is **PP first, then TG** (was TG→PP). Rationale above (per-slot meter / share card).
- At start: `patchHero({ tg: null, pp: null })` clears both once.
- After `executeBenchPp(false)`, if PP succeeded, `patchHero({ pp: … })` **pins the PP result
  immediately** so it stays during the TG run. Without this, the *live* PP metric resets when the
  PP bench ends and the PP hero briefly shows `--` (a gap, not a hero clear).
- After `executeBenchTg(false)`, both results are patched together.
- The hero numbers are **not** cleared at the start of each bench — only once at the start of the
  whole combined run. The visible "clearing" between phases is the live metric resetting.

---

## Small print under the TG number (PP / +1st / tok / ELAPSED)

- Values come from `MicroStatsLatch` in `FusionOverlay.tsx`, latched per slot
  (`engineStates.current`), wiped only on a new request/phase reset (`fusionNewPromptReset`).
- Because the backend `finalize_request_meters` does **not** clear `prefill_ms`/`decode_ttft_ms`,
  the latch kept the last request's values after a bench → **non-deterministic "sticks"** depending
  on whether a trailing phase event fired the wipe.
- **Fix:** in `updateMicroLatch`, when the engine is fully idle past `MICRO_STATS_IDLE_HOLD_MS`
  (1500ms — the same guard that prevents flicker on sub-second agent-turn gaps), clear
  `genTokens`, `prefillMs`, `decodeTtftMs`, and reset `elapsedMs` to `"0ms"`. Result: the small
  print deterministically shows `--` after a bench/request idles. `sessionOpen` is set false at the
  same time; `microReadoutLive = sessionOpen || isActive` still keeps the live style when the slot
  is active.
- If "always show last request's values" is ever wanted instead, flip this block to clear nothing.

---

## Traps (do not repeat)

- **Never reintroduce a content height budget in the card.** Measured fit replaced it; a budget
  is what made the card need re-tuning on every live change.
- **Never add `min-width` floors or fixed sizes to capture CSS to "fix" fitting.** Shrink the
  reference width or let the fit scale; floors that exist to stop live jitter (`.fusion-micro-cell`
  `ch` floors) are pointless on a static card and were dropped there.
- The clone must be **mounted** before `applyGlassFit` — a detached node measures 0×0 and throws
  `Share glass measured empty`, which the retry ladder then re-runs.
- `transform: scale()` inside html-to-image's foreignObject raster is **verified** (probe: content
  lands at the scaled corner, sibling bands composite correctly). Chromium `zoom` behaves the same
  if transform ever regresses.
- **Never** set the frame pad as a plain inline `padding` — html-to-image clobbers it (use
  `setProperty(..., "important")` if you ever must).
- **Do not** add `[data-theme="…"]` / `html:not([data-theme=…])` capture rules; theme is applied
  via tokens and `applyShareCaptureTheme`.
- **Do not** blanket-match `style*="6vh"` for hero fonts — it also hits the 2.6vh per-slot meter.
  Select `.fusion-tg-hero-value` / `.fusion-prefill-hero-value` explicitly.
- **Do not** reorder the combined bench back to TG→PP — the share card loses the per-slot meter.
- **Do not** source the SPEC chips from `config.spec_type` / `spec_draft_n_*` — use
  `specShareFields(boostMethod, config, params)`. The legacy bag keys are stripped on load, so the
  row dies silently and only an empty band remains under the config chips.
- **Do not** reuse `AppHandle::exit` / webview-destroy shutdown patterns here (unrelated, but this
  repo's shutdown is PID-only via `app_lifecycle`).

---

## Files that matter

| File | Role |
|------|------|
| `src/lib/fusionShareCapture.tsx` | Entire capture pipeline, layout, stage, strip/hide logic |
| `src/components/FusionOverlay.tsx` | Live micro-stats latch + per-slot meter + hero render |
| `src/components/BenchWidget.tsx` | Bench ordering (`runBenchBoth`) + hero pinning |
| `src/styles/fusion-display.css` | `.fusion-share-capture-stage[data-fusion-share-capture]` rules |
| `src/lib/benchPanelLayout.ts` | **Live** glass height budget (`computeDualStackPhosphorHeightForTray`); the card no longer reads it — it measures the clone |
| `src/lib/onboardingDisplay.ts` | `DISPLAY_BEZEL_PADDING_PX` (18) — live bezel pad |

---

## Related

- `docs/display-bezel-glass.md` — the live bezel/glass model (capture overrides it for export).
- `docs/FUSION-metrics.md` — fusion poller fields behind the hero/meter values.
