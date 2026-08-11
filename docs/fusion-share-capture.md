# Fusion share capture — bezel layout, html-to-image quirks, micro-stats

Memo for humans and agents. If a share PNG comes out with the top buttons overlapping the
glass, the bezel too tall/short, a missing per-slot `xxx /slot` meter, or the small print
under the TG number showing stale values — read this before touching layout math or capture
styling.

Primary: `src/lib/fusionShareCapture.tsx` (capture pipeline) · `src/components/FusionOverlay.tsx`
(live micro-stats) · `src/components/BenchWidget.tsx` (bench ordering) · `src/styles/fusion-display.css`
(capture-stage CSS).

**Last aligned with code:** 2026-08-11 (v1.0.43-era share + bench work)

---

## One-line model

The share capture is **not** a screenshot of the live DOM — it is a **rebuilt offscreen stage**
(`fusion-share-capture-stage`) that clones the live frame, strips live-only chrome, and re-tunes
sizes/positions so the result is a clean 16:9 card. The live CSS (bezel pads, chrome bands, zoom)
is the enemy; the stage must override it.

---

## Capture pipeline (top → bottom)

```
renderFusionSharePngOnce(meta, variant)
  ├─ hasTopChrome = sourceFrame.querySelector("[data-frame-top-chrome]") != null
  ├─ topBandPx  = hasTopChrome ? CAPTURE_TOP_CHROME_BAND_PX(36) : DISPLAY_BEZEL_PADDING_PX(18)
  ├─ layout     = computeFusionShareExportLayout(meta, topBandPx)
  ├─ createFrameCaptureStage(sourceFrame, …)   // clone + strip chrome classes + force pad
  │    ├─ normalizeFusionCaptureLayout(frame, phosphorH)   // pin heights, hero fonts
  │    ├─ injectShareBezelBrand(frame)                     // bottom-right logo/version
  │    └─ createShareHwBand(meta, layout)                  // GPU topo band below bezel
  ├─ hideCaptureChrome(frame)          // CAPTURE_STRIP_SELECTORS → visibility:hidden
  ├─ prepareFusionOverlayForCapture(frame)  // hide forecast underlay, force fusion paint
  ├─ stripForecastPaddingForCapture(frame)  // zero padding, hide header
  └─ captureMountedShell(headerShell) + html-to-image toCanvas(stage)
```

Stage is mounted at `document.body` at `--ui-text-scale: 1`. **The user's 120% app zoom does not
affect the capture** — the stage is at scale 1 regardless.

---

## Key constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `CAPTURE_TOP_CHROME_BAND_PX` | **36** | Top bezel band (ASSISTED/FULL AUTO + Device/Split). Tuned live by hand; do not re-measure from the DOM. |
| `DISPLAY_BEZEL_PADDING_PX` | **18** | Standard metal pad (bottom always uses this; bottom chrome is hidden from captures). |
| `FUSION_SHARE_EXPORT_PIXEL_RATIO` | **4** | CSS→PNG scale (~707×398 → ~2828×1592). |
| `FUSION_SHARE_CAPTURE_PHOSPHOR_HEIGHT_PX` | from `computeFusionShareCapturePhosphorHeightPx()` | Phosphor budget, synced with `benchPanelLayout`. |
| `SHARE_ASPECT_W/H` | 16/9 | Total card aspect. |
| `FUSION_CAPTURE_HERO_FONT_PX` / `FUSION_CAPTURE_PER_SLOT_FONT_PX` | 40 / 20 | Hero & per-slot meter font sizes forced in capture. |

`computeShareBezelHeightPx(phosphorH, topBandPx) = phosphorH + topBandPx + 18`.
`computeFusionShareExportLayout(meta, topBandPx = 18)` — the no-arg default (18) reproduces the
original no-top-chrome layout (`phosphorH + 36`).

---

## The top-chrome pad bug (root cause, do not reintroduce)

**Symptom:** top bezel buttons rendered over/overlapping the phosphor glass in screenshots.

**Root cause (two parts):**
1. `html-to-image`'s `cloneCSSStyle` does `targetStyle.cssText = sourceStyle.cssText`, which
   **clobbers inline styles** (including an inline `padding`) with the computed style from the
   source. So a plain inline `padding` override was silently discarded.
2. The live `:has(.top-chrome)` / `:has(.bottom-chrome)` rules inflate the frame's `padding-top`
   (36px) / `padding-bottom` (32px), squeezing the phosphor when the clone inherits them.

**Fix (in `createFrameCaptureStage`):**
- `frame.classList.remove("industrial-display-frame--top-chrome", "…--bottom-chrome")` on the clone.
- Force the pad with `!important` inline styles:
  `frame.style.setProperty("padding-top", `${topPad}px`, "important")` (and right/bottom/left = 18).
- `topPad = layout.bezelHeightPx - layout.phosphorHeightPx - DISPLAY_BEZEL_PADDING_PX`.

**Tuning knob:** only `CAPTURE_TOP_CHROME_BAND_PX` (36). It was iterated 72 → 44 → **36**; 72 was
3× too tall, 44 still a bit high. Do **not** "measure" the band from the live DOM — the old
`readCaptureTopChromeBandPx` helper scanned all descendants and overshot to ~108px (3×). Use the
fixed constant + `hasTopChrome` boolean detection.

---

## What gets hidden from captures

`CAPTURE_STRIP_SELECTORS` (visibility:hidden):
- `[data-fusion-share-exclude]`, `[data-frame-bottom-chrome]` (bottom GPU/ENG density buttons),
  `.display-texture-toggle`, `.industrial-bezel-texture-toggle`, `.vram-forecast-scenario-badge`,
  `.fusion-bench-latch`, `.bench-hw-topo`, `.display-chrome-hints` ("MODEL NEEDS MULTIPLE GPUS…").

`prepareFusionOverlayForCapture` hides every child of `.vram-badge-forecast` **except**
`.fusion-overlay-fill`, and forces the fusion panel to `opacity:1` + `animation:none` (the clone
restarts `fadeIn` at opacity 0). The per-slot meter lives *inside* the fusion panel, so it survives.

Removed earlier: the "single session" banner (`injectCaptureBezelModeBanner`) and its CSS.

---

## Per-slot `xxx /slot` meter in the share

- Rendered live in `FusionOverlay.tsx` (`.fusion-per-slot-meter`, `top-1.5 right-2` in the TG hero).
  Shows when `!suppressTgHero && concurrentSlots > 1`.
- Capture forces its font to `FUSION_CAPTURE_PER_SLOT_FONT_PX` (20) and repositions it
  (`top:6px; right:8px`) via `.fusion-share-capture-stage[data-fusion-share-capture]` rules.
- **It depends on the engine being in a concurrent TG state.** A solo TG bench leaves the slots
  concurrent → meter shows. A combined bench that *ends in PP* leaves the slots non-concurrent →
  meter missing. **Fix: combined bench runs PP first, then TG** so it ends in the TG state
  (`runBenchBoth` in `BenchWidget.tsx`). Do not reorder it back without re-checking the share card.

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

- **Never** set the frame pad as a plain inline `padding` — html-to-image clobbers it. Use
  `setProperty(..., "important")` or strip the live chrome classes.
- **Never** measure the top chrome band from the DOM — use `CAPTURE_TOP_CHROME_BAND_PX` (36).
- **Do not** add `[data-theme="…"]` / `html:not([data-theme=…])` capture rules in CSS; theme is
  applied via tokens and `applyShareCaptureTheme`.
- **Do not** blanket-match `style*="6vh"` for hero fonts — it also hits the 2.6vh per-slot meter.
  Select `.fusion-tg-hero-value` / `.fusion-prefill-hero-value` explicitly.
- **Do not** reorder the combined bench back to TG→PP — the share card loses the per-slot meter.
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
| `src/lib/benchPanelLayout.ts` | Phosphor/slot height budget (`computeFusionShareCapturePhosphorHeightPx`) |
| `src/lib/onboardingDisplay.ts` | `DISPLAY_BEZEL_PADDING_PX` (18) |

---

## Related

- `docs/display-bezel-glass.md` — the live bezel/glass model (capture overrides it for export).
- `docs/FUSION-metrics.md` — fusion poller fields behind the hero/meter values.
