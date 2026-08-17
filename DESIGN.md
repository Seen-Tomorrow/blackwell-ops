# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-08-17
- Primary product surfaces: Fusion live performance meter (phosphor glass inside industrial bezel)
- Evidence reviewed:
  - `src/components/FusionOverlay.tsx`
  - `src/components/SlotCtxBars.tsx`
  - `src/styles/fusion-display.css`
  - `src/lib/benchPanelLayout.ts`
  - `src/lib/fusionShareCapture.tsx`
  - `docs/display-bezel-glass.md`
  - `AGENTS.md` (tokens-only themes, no blur, one glass)

## Brand
- Personality: Precision industrial instrument — F1 timing wall meets CRT lab scope. Expensive, calm, lethal when live.
- Trust signals: Tabular numerals, fixed layout (no jitter), phase-true color, share-capture honesty.
- Avoid: Generic SaaS cards, neon cyberpunk spam, glassmorphism blur, second nested glass, hard-coded single-theme greens, toy gauges.

## Product goals
- Goals:
  - Make live TG/PP the most enviable local-LLM performance readout on the market.
  - Instant phase legibility (IDLE / PP / TG) without reading labels twice.
  - Keep every existing metric/behavior (LIVE/AVG, micro latch, per-slot, MTP, bench suppress, quiet/lv/stop, share classes).
- Non-goals:
  - Backend brain/math changes.
  - Reworking VRAM forecast scenarios or bezel chrome.
  - New product features beyond presentation of existing `FusionUpdate` fields.
- Success signals:
  - Hero numbers feel carved into phosphor, not floated Tailwind text.
  - Active channel blooms; idle channel stays ghosted but readable.
  - Share PNG still captures TG/PP/per-slot via existing class hooks.
  - No layout thrash when tokens/ms update at 25ms telemetry.

## Personas and jobs
- Primary personas: Local inference power users, bench sharers, multi-slot agent runners.
- User jobs: Read system tok/s at a glance; compare LIVE vs AVG; watch PP progress; latch last-request timing; screenshot flex.
- Key contexts of use: 1080p marginal → 1440p/4K optimal; dark CRT themes + phosphor-light e-ink faces.

## Information architecture
- Primary navigation: n/a (embedded in config display stack).
- Core routes/screens: Fusion overlay fill inside `.phosphor-screen-inner`.
- Content hierarchy:
  1. Identity + ops (alias, port, QUIET/LV/STOP)
  2. Hero triad: context slot bank · TG instrument · PP instrument
  3. Bench tray — instrument controls + metric-cell results

## Design principles
- Principle 1: **One dominant number** — TG system throughput owns the eye; PP is peer but cooler; per-slot is satellite.
- Principle 2: **Instrument, not card** — recessed wells, hairline rules, label-over-value cells; no flat bordered boxes.
- Principle 3: **Phosphor physics** — glow via `text-shadow` / `box-shadow` only; never `backdrop-filter: blur`.
- Tradeoffs: Dense 122px hero budget over airy dashboard padding; kinetic sparkline only on TG (space).

## Visual language
- Color:
  - TG active → `var(--display-face-text)` (+ soft bloom)
  - TG idle → muted face / control muted
  - PP active → cooler secondary mix of face text + slate (theme-aware via CSS)
  - PP progress → face text at reduced alpha; active PP may use warm phase accent token
  - Phase PP label → warm amber accent; TG → face text / nv green token path
  - No raw `#22c55e` inline on heroes
- Typography: `ui-monospace` / system mono; `font-variant-numeric: tabular-nums`; hero clamp ~2–3.5rem; micro 6–7px labels + 8–9px values.
- Spacing/layout rhythm: 2–4px internal gaps; instrument pad 6–8px; fixed `FUSION_HERO_ROW_PX` (122, headroom only if phosphor math updated).
- Shape/radius/elevation: 3–4px radius wells; dual inset highlight (top hi / bottom lo); active well outer glow 1px ring + soft outer shadow.
- Motion: 180–280ms color/border transitions; sparkline path morph; optional phase pulse on active rim (opacity). Respect reduced motion → static.
- Imagery/iconography: No icons required; sparkline is the kinetic glyph.

## Components
- Existing components to reuse:
  - `FusionOverlay` (state/math owner)
  - `SlotCtxBars` — instrument slot bank (chrome + speculative/live ticks)
  - `FusionBenchTrayLatch` + `BenchWidget` — instrument controls/results
  - Share classes: `.fusion-tg-hero-value`, `.fusion-prefill-hero-value`, `.fusion-per-slot-meter`, `.fusion-per-slot-meter__value`, micro-stat cells
- New/changed components:
  - `FusionHeroSparkline` — TG live history waveform
  - `FusionMicroReadout` — latched precision strip (label/value cells)
  - CSS cluster `.fusion-instrument*` / `.fusion-slot-bank*` / `.fusion-bench-*` in `fusion-display.css`
- Variants and states: idle / pp-active / tg-active / suppressed (`--`) / parallel per-slot visible / micro live vs latched idle
- Token/component ownership:
  - Presentation tokens in CSS using existing `--display-face-*` + `--theme-*`
  - Prefer zero new theme keys unless a face color cannot be mixed

## Accessibility
- Target standard: keyboard-focusable controls (LIVE/AVG, QUIET, LV, STOP) keep visible focus rings.
- Keyboard/focus behavior: buttons remain real `<button>` elements.
- Contrast/readout: idle values stay ≥ readable muted; light phosphor uses existing light-readout tokens.
- Screen-reader semantics: phase text remains textual; progress bars keep reserved space with `aria-hidden` when suppressed.
- Reduced motion: disable sparkline animation / rim pulse under `prefers-reduced-motion`.

## Responsive behavior
- Supported breakpoints/devices: 1080p min, 1440p+ recommended (product floor).
- Layout adaptations: existing slot column width via `fusionSlotColumnLayout`; hero flex 45/35 TG/PP.
- Touch/hover: denser click targets on LIVE/AVG segment (≥18px height).

## Interaction states
- Loading: `FusionBooter` unchanged.
- Empty/sync: SYNCING FUSION placeholder unchanged.
- Error / fusion off: existing non-fusion engine panel.
- Success: live metrics + bench pin.
- Disabled: STOP while stopping; suppressed heroes show `--`.
- Offline/slow network: n/a (local engine).

## Content voice
- Tone: Telemetry terse — GENERATION, PREFILL, LIVE, AVG, tok/s.
- Terminology: Keep PP / TG / MTP / +1st / ELAPSED product language.
- Microcopy rules: Uppercase tracking labels; no marketing fluff inside the meter.

## Implementation constraints
- Framework/styling system: React + Tailwind utilities + `fusion-display.css` partial; theme tokens only.
- Design-token constraints: No new `[data-theme]` forks; texture overrides via `[data-display-texture=…]` only where needed.
- Performance constraints: Telemetry 25ms — avoid layout thrash; tabular nums + fixed micro cell widths; sparkline ≤64 samples, pure SVG path.
- Compatibility constraints:
  - Preserve share-capture selectors and bench height math.
  - One glass: content stays transparent over `.phosphor-screen-inner`.
  - No `backdrop-filter: blur`.
- Test/screenshot expectations: Manual visual in DEV app; `npm run build` typecheck; share class grep.

## Open questions
- [ ] Optional later: secondary spark history for PP (space-limited now).
- [ ] Optional later: retire unused `FusionTpsDisplay` / `FusionPhaseBadge` / `FusionFuelTank` dead leaves.
- [x] Slot bank + bench tray restyled to instrument language; surface unused fields (speculative, prompt_tps, aggregate/per-req, PP wall).
