/**
 * App theme registry — single source of truth for UI color tokens.
 * Apply via applyAppTheme(); components read CSS variables, not theme objects directly.
 *
 * Pattern mirrors scenario factory: themes define tokens, renderers stay dumb.
 */

export interface AppTheme {
  id: string;
  name: string;
  description: string;
  /** Native window chrome preference (title bar / caption buttons). */
  native?: "light" | "dark";
  tokens: Record<string, string>;
}

/** ARCTIC + DOTTED frame drop shadow (fed to --theme-bezel-cast-shadow). Soft — heavy drop reads as “bottom smear” on short panels. */
const DISPLAY_PROFILE_BEZEL_CAST =
  "0 3px 10px rgba(40, 60, 80, 0.14), 0 1px 3px rgba(40, 60, 80, 0.1)";

const MATRIX: AppTheme = {
  id: "matrix",
  name: "MATRIX",
  description: "Phosphor green on deep black",
  tokens: {
    "--theme-bg": "#000000",
    "--theme-text": "#e0e0e0",
    "--theme-text-muted": "#4a4a5a",
    "--theme-panel": "#111810",
    "--theme-panel-accent": "#040b01",
    "--theme-border": "#1a2e1a",
    "--theme-frame-border": "rgba(74, 222, 128, 0.14)",
    "--theme-frame-border-strong": "rgba(74, 222, 128, 0.26)",
    "--theme-accent": "#76B900",
    "--theme-accent-bright": "#4ade80",
    "--theme-accent-dim": "#4a6a5a",
    /* Distribution/App-update cyan — stays cyan on dark themes, readable teal on arctic */
    "--theme-accent-glow": "rgba(74, 222, 128, 0.3)",
    "--theme-accent-soft": "rgba(74, 222, 128, 0.06)",
    "--theme-chip-bg": "rgba(74, 222, 128, 0.04)",
    "--theme-chip-border": "rgba(74, 222, 128, 0.28)",
    "--theme-chip-text": "#4a6a5a",
    "--theme-chip-hover-border": "rgba(74, 222, 128, 0.48)",
    "--theme-chip-hover-text": "#4ade80",
    "--theme-chip-active-bg": "rgba(74, 222, 128, 0.14)",
    "--theme-chip-active-border": "rgba(74, 222, 128, 0.62)",
    "--theme-chip-active-text": "#4ade80",
    "--theme-chip-solid-bg": "#4ade80",
    "--theme-chip-solid-text": "#0c120a",
    /* Pair seat B (WORKER) — solid with theme-correct contrast */
    "--theme-pair-secondary-bg": "#4ade80",
    "--theme-pair-secondary-text": "#0c120a",
    /* Harness BRAIN/WORKER identity (wizard + running cards) */
    /* Near-black + green tint (CLEAN + DARK share face) */
    "--display-face-bg": "#030805",
    "--display-face-bg-dark": "#020603",
    "--display-face-glow": "rgba(74, 222, 128, 0.035)",
    "--display-face-text": "#4ade80",
    "--display-face-text-muted": "#3a6a4a",
    "--display-face-bar-bg": "rgba(74, 222, 128, 0.08)",
    "--display-face-border": "rgba(74, 222, 128, 0.12)",
    "--theme-industrial-bg": "#111810",
    "--theme-industrial-text": "#4ade80",
    /* DFlash / DSPARK spec strip — violet tone (dark surface) */
    /* MTP spec strip — product green (dark surface) */
    "--theme-industrial-muted": "#4ade80",
    "--theme-industrial-bar-track": "rgba(74, 222, 128, 0.03)",
    "--theme-industrial-gpu-card-bg": "rgba(74, 222, 128, 0.04)",
    "--theme-industrial-gpu-border": "rgba(74, 222, 128, 0.15)",
    "--theme-industrial-gpu-selected": "rgba(74, 222, 128, 0.7)",
    "--theme-gpu-topo-selected-border": "rgba(148, 163, 184, 0.5)",
    "--theme-gpu-topo-selected-shadow": "0 0 10px rgba(148, 163, 184, 0.22)",
    "--theme-bezel-edge-hi": "rgba(74, 222, 128, 0.07)",
    "--theme-bezel-grain": "rgba(74, 222, 128, 0.03)",
    "--theme-bezel-inset-hi": "rgba(74, 222, 128, 0.07)",
    "--theme-card-selected-bg": "#111810",
    "--theme-card-selected-accent": "#b87a00",
    "--theme-scrollbar-track": "rgba(10, 10, 15, 0.5)",
    "--theme-scrollbar-thumb": "rgba(118, 185, 0, 0.3)",
    "--theme-secondary": "#b87a00",
    "--theme-secondary-bright": "#f5971f",
    "--theme-selection-bg": "#76B900",
    "--theme-selection-text": "#000000",
    "--theme-eject-header-bg": "#000000",
    "--theme-eject-header-text": "#b87a00",
    "--theme-eject-card-bg": "rgba(74, 222, 128, 0.03)",
    "--theme-eject-card-hover-bg": "rgba(74, 222, 128, 0.06)",
    "--theme-eject-card-text": "#e8e2d6",
    "--theme-eject-card-muted": "#9a9488",
    "--theme-eject-badge-bg": "#000000",
    "--theme-eject-card-hover-border": "rgba(184, 122, 0, 0.28)",
    "--theme-eject-card-selected-bg": "rgba(184, 122, 0, 0.16)",
    "--theme-eject-card-selected-border": "rgba(184, 122, 0, 0.55)",
    "--theme-provider-label": "rgba(245, 151, 31, 0.8)",
    "--theme-provider-pill-bg": "#1a1206",
    "--theme-provider-pill-border": "#b87a00",
    "--theme-provider-pill-text": "#b87a00",
    "--theme-provider-pill-hover-border": "#f5971f",
    "--theme-provider-pill-hover-text": "#f5971f",
    "--theme-provider-pill-active-bg": "#f5971f",
    "--theme-provider-pill-active-border": "#f5971f",
    "--theme-provider-pill-active-text": "#0a0804",
    "--theme-header-border": "#1a2e1a",
    "--theme-header-title": "#ffffff",
    "--theme-header-subtitle": "rgba(255, 255, 255, 0.25)",
    "--theme-header-logo": "#76B900",
    "--theme-nav-text": "#4a4a5a",
    "--theme-nav-hover-text": "#e0e0e0",
    "--theme-nav-hover-bg": "rgba(255, 255, 255, 0.05)",
    "--theme-nav-active-bg": "rgba(74, 222, 128, 0.12)",
    "--theme-nav-active-border": "rgba(74, 222, 128, 0.5)",
    "--theme-nav-active-text": "#4ade80",
    "--theme-chrome-control-border": "#1a2e1a",
    "--theme-chrome-control-text": "#4a4a5a",
    "--theme-chrome-control-hover": "#4ade80",
    "--theme-footer-bg": "#000000",
    "--theme-footer-border": "#b87a00",
    "--theme-footer-text": "rgba(255, 255, 255, 0.4)",
    "--theme-status-nominal": "#4ade80",
    "--theme-launch-bg": "color-mix(in srgb, var(--theme-chip-solid-bg) 58%, var(--theme-industrial-bg) 42%)",
    "--theme-launch-border": "color-mix(in srgb, var(--theme-chip-active-border) 82%, transparent)",
    "--theme-launch-text": "var(--theme-chip-active-text)",
    "--theme-launch-shadow": "none",
    "--theme-launch-hover-bg": "color-mix(in srgb, var(--theme-chip-solid-bg) 68%, var(--theme-industrial-bg) 32%)",
    "--theme-launch-hover-border": "var(--theme-chip-active-border)",
    "--theme-launch-hover-text": "var(--theme-chip-hover-text)",
    "--theme-launch-active-bg": "color-mix(in srgb, var(--theme-chip-solid-bg) 72%, var(--theme-industrial-bg) 28%)",
    "--theme-launch-active-border": "var(--theme-chip-solid-bg)",
    "--theme-launch-active-text": "var(--theme-chip-solid-text)",
    "--display-face-light-readout-divider-opacity": "0.32",
    "--display-face-light-readout-idle-divider": "#5a6a52",
    "--display-face-light-readout-idle-divider-opacity": "0.48",
    "--display-face-light-concurrency-label": "#4a6a4a",
    "--display-face-light-concurrency-chip-bg": "#243818",
    "--display-face-light-concurrency-chip-fg": "#9ed44a",
    "--display-face-light-concurrency-chip-border": "#4d7a00",
    /* Fused VRAM/RAM bar label chips (name/cap/need) */
    "--display-face-light-fc-label-bg": "#243818",
    "--display-face-light-fc-label-fg": "#d9f99d",
    "--display-face-light-fc-label-border": "#4d7a00",
    "--display-face-light-fc-label-ram-bg": "#0a2830",
    "--display-face-light-fc-label-ram-fg": "#a5f3fc",
    "--display-face-light-fc-label-ram-border": "#0e7490",
    "--display-face-gpu-readout": "var(--theme-accent-bright, var(--theme-accent))",
    "--display-face-gpu-readout-muted": "var(--display-face-text-muted)",
    "--display-face-light-gpu-readout": "var(--display-face-light-text-accent, var(--theme-accent))",
    "--display-face-light-gpu-readout-muted": "var(--display-face-light-text-muted)",
    "--display-face-light-ctx-chip-border": "rgba(77, 122, 0, 0.5)",
    "--display-face-light-ctx-chip-fg": "#4a6a4a",
    "--display-face-light-ctx-fill-pct": "#1e3a14",
    "--display-face-light-ctx-fill-idle": "rgba(74, 222, 128, 0.4)",
    "--display-face-light-ctx-slot-fg": "#4a6a4a",
    "--display-face-light-hw-label": "#3a5a32",
    "--display-face-light-hw-driver": "#5a7050",
    "--display-face-light-gpu-name": "#4a6a4a",
    "--display-face-light-gpu-name-selected": "#1e3a14",
    "--display-face-light-text-red": "#5a2828",
    "--display-face-light-text-violet": "#4a3858",
    "--display-face-light-gpu-selected-border": "#526848",
    "--display-face-light-gpu-selected-bg": "rgba(70, 90, 64, 0.45)",
    "--display-face-light-gpu-selected-shadow": "0 0 0 1px rgba(82, 104, 72, 0.55), 0 2px 5px rgba(40, 50, 36, 0.25)",
  },
};

const SLATE: AppTheme = {
  id: "slate",
  name: "SLATE",
  description: "Neutral phosphor — grey terminal, low saturation",
  tokens: {
    "--theme-bg": "#080808",
    "--theme-text": "#d0d0d8",
    "--theme-text-muted": "#5a5a6a",
    "--theme-panel": "#121218",
    "--theme-panel-accent": "#0c0c0c",
    "--theme-border": "#222228",
    /* Mid-grey structure — not pale glow on black */
    "--theme-frame-border": "rgba(100, 100, 120, 0.22)",
    "--theme-frame-border-strong": "rgba(130, 130, 150, 0.34)",
    "--theme-accent": "#8a8a9a",
    "--theme-accent-bright": "#c8c8d0",
    "--theme-accent-dim": "#5a5a6a",
    /* Distribution/App-update cyan — stays cyan on dark themes, readable teal on arctic */
    "--theme-accent-glow": "rgba(160, 160, 176, 0.22)",
    "--theme-accent-soft": "rgba(120, 120, 140, 0.08)",
    "--theme-chip-bg": "rgba(120, 120, 140, 0.06)",
    "--theme-chip-border": "rgba(140, 140, 160, 0.32)",
    "--theme-chip-text": "#7a7a8a",
    "--theme-chip-hover-border": "rgba(180, 180, 200, 0.45)",
    "--theme-chip-hover-text": "#c8c8d0",
    "--theme-chip-active-bg": "rgba(160, 160, 176, 0.14)",
    "--theme-chip-active-border": "rgba(200, 200, 216, 0.55)",
    "--theme-chip-active-text": "#e0e0e8",
    "--theme-chip-solid-bg": "#8a8a9a",
    "--theme-chip-solid-text": "#0c0c0c",
    "--theme-pair-secondary-bg": "#8a8a9a",
    "--theme-pair-secondary-text": "#0c0c0c",
    /* Harness BRAIN/WORKER identity (wizard + running cards) */
    "--display-face-bg": "#080808",
    "--display-face-bg-dark": "#080808",
    "--display-face-glow": "rgba(200, 200, 200, 0.05)",
    "--display-face-text": "#c8c8d0",
    "--display-face-text-muted": "#6a6a7a",
    "--display-face-bar-bg": "rgba(200, 200, 210, 0.08)",
    "--display-face-border": "rgba(200, 200, 210, 0.065)",
    "--theme-industrial-bg": "#1a1a1e",
    "--theme-industrial-text": "#c8c8d0",
    /* DFlash / DSPARK spec strip — violet tone (dark surface) */
    /* MTP spec strip — product green (dark surface) */
    "--theme-industrial-muted": "#8a8a9a",
    "--theme-industrial-bar-track": "rgba(200, 200, 210, 0.025)",
    "--theme-industrial-gpu-card-bg": "rgba(200, 200, 210, 0.025)",
    "--theme-industrial-gpu-border": "rgba(200, 200, 210, 0.15)",
    "--theme-industrial-gpu-selected": "rgba(200, 200, 210, 0.55)",
    "--theme-gpu-topo-selected-border": "rgba(200, 200, 210, 0.55)",
    "--theme-gpu-topo-selected-shadow": "0 0 10px rgba(200, 200, 210, 0.24)",
    "--theme-bezel-edge-hi": "rgba(210, 210, 220, 0.12)",
    "--theme-bezel-grain": "rgba(255, 255, 255, 0.022)",
    "--theme-bezel-inset-hi": "rgba(255, 255, 255, 0.055)",
    "--theme-card-selected-bg": "#1a1a1e",
    "--theme-card-selected-accent": "#8a8a9a",
    "--theme-scrollbar-track": "rgba(15, 15, 18, 0.5)",
    "--theme-scrollbar-thumb": "rgba(138, 138, 154, 0.35)",
    "--theme-secondary": "#7a7a8a",
    "--theme-secondary-bright": "#a0a0b0",
    "--theme-selection-bg": "#8a8a9a",
    "--theme-selection-text": "#0c0c0c",
    "--theme-eject-header-bg": "#141418",
    "--theme-eject-header-text": "#a0a0b0",
    "--theme-eject-card-bg": "rgba(120, 120, 140, 0.05)",
    "--theme-eject-card-hover-bg": "rgba(140, 140, 160, 0.1)",
    "--theme-eject-card-text": "#d0d0d8",
    "--theme-eject-card-muted": "#6a6a7a",
    "--theme-eject-badge-bg": "#141418",
    "--theme-eject-card-hover-border": "var(--theme-frame-border-strong)",
    "--theme-eject-card-selected-bg": "rgba(160, 160, 176, 0.16)",
    "--theme-eject-card-selected-border": "rgba(200, 200, 216, 0.5)",
    "--theme-provider-label": "rgba(200, 170, 100, 0.8)",
    "--theme-provider-pill-bg": "#1a1810",
    "--theme-provider-pill-border": "#a08840",
    "--theme-provider-pill-text": "#a08840",
    "--theme-provider-pill-hover-border": "#c8a860",
    "--theme-provider-pill-hover-text": "#c8a860",
    "--theme-provider-pill-active-bg": "#c8a860",
    "--theme-provider-pill-active-border": "#c8a860",
    "--theme-provider-pill-active-text": "#1a1408",
    "--theme-header-border": "#222228",
    "--theme-header-title": "#d0d0d8",
    "--theme-header-subtitle": "rgba(208, 208, 216, 0.35)",
    "--theme-header-logo": "#8a8a9a",
    "--theme-nav-text": "#5a5a6a",
    "--theme-nav-hover-text": "#d0d0d8",
    "--theme-nav-hover-bg": "rgba(200, 200, 210, 0.06)",
    "--theme-nav-active-bg": "rgba(200, 200, 210, 0.065)",
    "--theme-nav-active-border": "rgba(200, 200, 210, 0.45)",
    "--theme-nav-active-text": "#c8c8d0",
    "--theme-chrome-control-border": "#222228",
    "--theme-chrome-control-text": "#5a5a6a",
    "--theme-chrome-control-hover": "#c8c8d0",
    "--theme-footer-bg": "#0c0c0c",
    "--theme-footer-border": "#7a7a8a",
    "--theme-footer-text": "rgba(208, 208, 216, 0.45)",
    "--theme-status-nominal": "#c8c8d0",
    "--theme-launch-bg": "var(--theme-provider-pill-active-bg)",
    "--theme-launch-border": "var(--theme-provider-pill-active-border)",
    "--theme-launch-text": "var(--theme-provider-pill-active-text)",
    "--theme-launch-shadow": "0 0 6px color-mix(in srgb, var(--theme-provider-pill-active-bg) 40%, transparent)",
    "--theme-launch-hover-bg": "color-mix(in srgb, var(--theme-provider-pill-active-bg) 82%, #ffffff 18%)",
    "--theme-launch-hover-border": "var(--theme-provider-pill-hover-border)",
    "--theme-launch-hover-text": "var(--theme-provider-pill-active-text)",
    "--theme-launch-hover-shadow": "0 0 8px color-mix(in srgb, var(--theme-provider-pill-active-bg) 48%, transparent)",
    "--theme-launch-active-bg": "color-mix(in srgb, var(--theme-provider-pill-active-bg) 78%, var(--theme-provider-pill-active-text) 22%)",
    "--theme-launch-active-border": "color-mix(in srgb, var(--theme-provider-pill-active-border) 70%, var(--theme-provider-pill-active-text) 30%)",
    "--theme-launch-active-text": "var(--theme-provider-pill-active-text)",
    "--theme-launch-active-shadow": "0 0 4px color-mix(in srgb, var(--theme-provider-pill-active-bg) 28%, transparent)",
    "--display-face-light-readout-divider-opacity": "0.28",
    "--display-face-light-readout-idle-divider": "#6a6a78",
    "--display-face-light-readout-idle-divider-opacity": "0.44",
    "--display-face-light-concurrency-label": "#5a5a6a",
    "--display-face-light-concurrency-chip-bg": "#2a2a32",
    "--display-face-light-concurrency-chip-fg": "#d0d0d8",
    "--display-face-light-concurrency-chip-border": "#6a6a7a",
    "--display-face-light-fc-label-bg": "#2a2a32",
    "--display-face-light-fc-label-fg": "#e2e8f0",
    "--display-face-light-fc-label-border": "#6a6a7a",
    "--display-face-light-fc-label-ram-bg": "#1e3a4a",
    "--display-face-light-fc-label-ram-fg": "#bae6fd",
    "--display-face-light-fc-label-ram-border": "#475569",
    "--display-face-light-ctx-chip-border": "rgba(106, 106, 122, 0.5)",
    "--display-face-light-ctx-chip-fg": "#5a5a6a",
    "--display-face-light-ctx-fill-pct": "#2e2e38",
    "--display-face-light-ctx-fill-idle": "rgba(200, 200, 210, 0.42)",
    "--display-face-light-ctx-slot-fg": "#5a5a6a",
    "--display-face-light-hw-label": "#4a4a58",
    "--display-face-light-hw-driver": "#6a6a78",
    "--display-face-light-gpu-name": "#5a5a6a",
    "--display-face-light-gpu-name-selected": "#2e2e38",
    "--display-face-light-text-red": "#4a3840",
    "--display-face-light-text-violet": "#484858",
    "--display-face-light-gpu-selected-border": "#686870",
    "--display-face-light-gpu-selected-bg": "rgba(90, 90, 96, 0.4)",
    "--display-face-light-gpu-selected-shadow": "0 0 0 1px rgba(104, 104, 112, 0.5), 0 2px 5px rgba(36, 36, 40, 0.22)",
  },
};

/*
 * ARCTIC — EXPERIMENT “Glacier Dawn”
 * Premium light default: paper-white workspace, polar sky accent, copper alerts,
 * bright aluminium industrial metal. High contrast, low mud, product-grade calm.
 */
const ARCTIC: AppTheme = {
  id: "arctic",
  name: "ARCTIC",
  description: "Glacier Dawn — paper white, polar sky, copper signal",
  native: "light",
  tokens: {
    /* ── Workspace ── pure cool paper, not institutional grey */
    "--theme-bg": "#eef3f8",
    "--theme-text": "#0b1220",
    "--theme-text-muted": "#5b6b7c",
    "--theme-panel": "#ffffff",
    "--theme-panel-accent": "#e7eef6",
    "--theme-border": "#a8bacd",
    /* Ink-dark enough to read at a glance on white panels (not wash-out grey) */
    "--theme-frame-border": "rgba(15, 40, 70, 0.22)",
    "--theme-frame-border-strong": "rgba(12, 45, 80, 0.4)",
    "--theme-border-subtle": "var(--theme-frame-border)",

    /* ── Accent — polar sky (vivid but professional) ── */
    "--theme-accent": "#0284c7",
    "--theme-accent-bright": "#075985",
    "--theme-accent-dim": "#64748b",
    /* Distribution/App-update cyan — stays cyan on dark themes, readable teal on arctic */
    "--theme-dist-cyan": "#0e7490",
    "--theme-accent-glow": "rgba(14, 165, 233, 0.18)",
    "--theme-accent-soft": "rgba(14, 165, 233, 0.1)",

    /* ── Chips — crisp sky glass ── */
    "--theme-chip-bg": "rgba(14, 165, 233, 0.08)",
    "--theme-chip-border": "rgba(3, 105, 161, 0.32)",
    "--theme-chip-text": "#0c4a6e",
    "--theme-chip-hover-border": "rgba(3, 105, 161, 0.55)",
    "--theme-chip-hover-text": "#075985",
    "--theme-chip-active-bg": "rgba(14, 165, 233, 0.18)",
    "--theme-chip-active-border": "rgba(3, 105, 161, 0.72)",
    "--theme-chip-active-text": "#0c4a6e",
    /* Solid chip — deep sky (was #0ea5e9 wash; unreadable on aluminium bezel) */
    "--theme-chip-solid-bg": "#0284c7",
    "--theme-chip-solid-text": "#f8fafc",
    "--theme-pair-secondary-bg": "#0284c7",
    "--theme-pair-secondary-text": "#f8fafc",
    /* Harness BRAIN/WORKER identity — arctic keeps distinct blue vs copper even
       though its provider-pill + pair-secondary both resolve to sky. */
    "--theme-harness-brain-raw": "#0284c7",
    "--theme-harness-worker-raw": "#ea580c",
    "--theme-harness-brain-text": "#0284c7",

    /* ── CLEAN phosphor face ── cool porcelain */
    "--display-face-bg": "#f7fafc",
    /* DARK face = neutral like SLATE (light theme forced dark, avoid tinted banding) */
    "--display-face-bg-dark": "#080808",
    /*
     * DOTTED face on a light theme: light dots would be invisible on porcelain, so
     * ARCTIC supplies dark dots + multiply (the recipe the old `eink` rules hardcoded)
     * and a slightly wider pitch. Surface stays ARCTIC's own face colour — the
     * separate light-LCD surface (--display-face-light-surface) is gone by decision:
     * texture decides the pattern, the theme decides the colour.
     */
    "--display-face-grain-dot": "rgba(0, 0, 0, 0.028)",
    "--display-face-grain-band": "rgba(0, 0, 0, 0.014)",
    "--display-face-grain-cell": "3px",
    "--display-face-grain-scan": "6px",
    "--display-face-grain-blend": "multiply",
    "--display-face-glow": "rgba(255, 255, 255, 0.85)",
    "--display-face-text": "#0f2744",
    "--display-face-text-muted": "#5a7088",
    "--display-face-bar-bg": "rgba(14, 165, 233, 0.08)",
    "--display-face-border": "rgba(3, 105, 161, 0.16)",
    /*
     * Bench RUN / active chips on paper face — solid sky wells + ice ink
     * (not translucent green wash). Matches concurrency chip contrast.
     */
    "--display-face-control-text": "#0c4a6e",
    "--display-face-control-muted": "#475569",
    "--display-face-control-border": "rgba(3, 105, 161, 0.35)",
    "--display-face-control-active-bg": "#0369a1",
    "--display-face-control-active-border": "#0284c7",
    "--display-face-control-active-text": "#e0f2fe",
    /*
     * CLEAN (and DOTTED on paper face) — same dark slate wash as DOTTED
     * so gold LEARNED / cyan PROBE stay readable. Token path only.
     */
    "--display-face-source-wash-mid": "color-mix(in srgb, #0f172a 14%, transparent)",
    "--display-face-source-wash-end": "color-mix(in srgb, #0b1220 52%, transparent)",
    "--display-face-source-lab": "color-mix(in srgb, #e2e8f0 78%, #94a3b8)",
    "--display-face-source-kind-bg": "color-mix(in srgb, #020617 72%, transparent)",
    "--display-face-source-kind-border": "color-mix(in srgb, #94a3b8 32%, transparent)",
    "--display-face-plate-wash-start": "color-mix(in srgb, #0b1220 52%, transparent)",
    "--display-face-plate-wash-mid": "color-mix(in srgb, #0f172a 36%, transparent)",
    "--display-face-gpu-trough-wash-start": "color-mix(in srgb, #0b1220 48%, transparent)",
    "--display-face-gpu-trough-wash-mid": "color-mix(in srgb, #0f172a 28%, transparent)",
    /* SOURCE hover recap — SLATE panel + dotted text (readable on paper UI) */
    "--display-face-recap-bg": "#121218",
    "--display-face-recap-text": "#d0d0d8",
    "--display-face-recap-text-muted": "#5a5a6a",

    /* ── PHOSPHOR LIGHT — bright glacier glass (light paper, soft grain) ── */
    "--display-face-light-surface": "#f4f8fc",
    "--display-face-light-dot": "rgba(15, 40, 70, 0.02)",
    "--display-face-light-band": "rgba(15, 40, 70, 0.012)",
    "--display-face-light-bar-bg": "#0c4a6e",
    "--display-face-light-text-muted": "#475569",
    "--display-face-light-text-accent": "#0369a1",
    "--display-face-light-text-cyan": "#0e7490",
    "--display-face-light-border": "rgba(3, 105, 161, 0.28)",
    "--display-face-light-readout": "#0f2744",
    "--display-face-light-readout-divider": "#0f2744",
    "--display-face-light-readout-divider-opacity": "0.28",
    "--display-face-light-readout-idle": "#64748b",
    "--display-face-light-readout-idle-divider": "#64748b",
    "--display-face-light-readout-idle-divider-opacity": "0.4",
    "--display-face-light-concurrency-label": "#475569",
    "--display-face-light-concurrency-chip-bg": "#0c4a6e",
    "--display-face-light-concurrency-chip-fg": "#e0f2fe",
    "--display-face-light-concurrency-chip-border": "#0369a1",
    /*
     * Fused VRAM/RAM label chips — solid wells (not wash).
     * ARCTIC face is paper-light even on CLEAN → dark wells + ice ink
     * (same language as concurrency chips). No cyan-on-skyblue mud.
     */
    /* Fused label chips — mid sky wells (lighter than #0c4a6e navy) + ice ink */
    "--display-face-fc-label-bg": "#0369a1",
    "--display-face-fc-label-fg": "#e0f2fe",
    "--display-face-fc-label-border": "#0284c7",
    "--display-face-fc-label-ram-bg": "#0e7490",
    "--display-face-fc-label-ram-fg": "#ecfeff",
    "--display-face-fc-label-ram-border": "#0891b2",
    "--display-face-light-fc-label-bg": "#0369a1",
    "--display-face-light-fc-label-fg": "#e0f2fe",
    "--display-face-light-fc-label-border": "#0284c7",
    "--display-face-light-fc-label-ram-bg": "#0e7490",
    "--display-face-light-fc-label-ram-fg": "#ecfeff",
    "--display-face-light-fc-label-ram-border": "#0891b2",
    /* GPU card "38.8/96G 40%" readout — theme accent, no glow */
    "--display-face-gpu-readout": "var(--theme-accent)",
    "--display-face-gpu-readout-muted": "var(--display-face-text-muted)",
    "--display-face-light-gpu-readout": "var(--display-face-light-text-accent)",
    "--display-face-light-gpu-readout-muted": "var(--display-face-light-text-muted)",
    "--display-face-light-ctx-chip-border": "rgba(3, 105, 161, 0.45)",
    "--display-face-light-ctx-chip-fg": "#0c4a6e",
    "--display-face-light-ctx-fill-pct": "#0f2744",
    "--display-face-light-ctx-fill-pct-shadow": "rgba(255, 255, 255, 0.85)",
    "--display-face-light-ctx-track-bg": "rgba(14, 165, 233, 0.1)",
    "--display-face-light-ctx-track-border": "rgba(3, 105, 161, 0.22)",
    "--display-face-light-ctx-fill-processing": "#0ea5e9",
    "--display-face-light-ctx-fill-idle": "rgba(14, 165, 233, 0.38)",
    "--display-face-light-ctx-slot-bg": "rgba(14, 165, 233, 0.1)",
    "--display-face-light-ctx-slot-fg": "#0c4a6e",
    "--display-face-light-hw-label": "#0369a1",
    "--display-face-light-hw-driver": "#64748b",
    "--display-face-light-gpu-name": "#334155",
    "--display-face-light-gpu-name-selected": "#0c4a6e",
    "--display-face-light-text-red": "#9f1239",
    "--display-face-light-text-violet": "#5b21b6",
    "--display-face-light-text-amber": "#c2410c",
    "--display-face-light-gpu-selected-border": "#0284c7",
    "--display-face-light-gpu-selected-bg": "rgba(14, 165, 233, 0.22)",
    "--display-face-light-gpu-selected-shadow":
      "0 0 0 1px rgba(14, 165, 233, 0.45), 0 2px 8px rgba(15, 40, 70, 0.12)",

    /* HW monitor + OVERCLOCKING — sky VRAM, cool RAM, copper warn */
    "--theme-tel-vram": "#0284c7",
    "--theme-tel-ram": "#0e7490",
    "--theme-tel-amber": "#ea580c",
    "--theme-tel-amber-deep": "#9a3412",
    "--theme-tel-amber-ink": "#9a3412",
    "--theme-tel-cyan": "#0891b2",
    "--theme-tel-hot": "#e11d48",
    "--theme-tel-cell-bg": "rgba(255, 255, 255, 0.55)",

    /* Model catalog — ice slab cards + dim FIT meta */
    "--theme-catalog-card-bg": "rgba(255, 255, 255, 0.72)",
    "--theme-catalog-card-bg-image":
      "linear-gradient(152deg, rgba(255,255,255,0.95) 0%, rgba(224,242,254,0.55) 42%, rgba(186,230,253,0.28) 100%)",
    "--theme-catalog-card-border": "rgba(14, 165, 233, 0.28)",
    "--theme-catalog-card-shadow":
      "inset 0 1px 0 rgba(255,255,255,0.92), inset 0 -1px 0 rgba(3,105,161,0.06), 0 1px 4px rgba(15,40,70,0.07)",
    "--theme-catalog-card-hover-bg": "rgba(255, 255, 255, 0.88)",
    "--theme-catalog-card-hover-border": "rgba(2, 132, 199, 0.48)",
    "--theme-catalog-card-hover-shadow":
      "inset 0 1px 0 rgba(255,255,255,0.98), 0 2px 10px rgba(14,165,233,0.14)",
    "--theme-catalog-card-selected-bg": "rgba(255, 255, 255, 0.96)",
    "--theme-catalog-card-selected-bg-image":
      "linear-gradient(152deg, #ffffff 0%, rgba(224,242,254,0.75) 48%, rgba(186,230,253,0.4) 100%)",
    "--theme-catalog-card-selected-border": "rgba(2, 132, 199, 0.62)",
    "--theme-catalog-card-selected-shadow":
      "inset 0 1px 0 rgba(255,255,255,1), inset 0 0 0 1px rgba(14,165,233,0.12), 0 2px 12px rgba(14,165,233,0.18)",
    "--theme-catalog-card-rail": "rgba(2, 132, 199, 0.85)",
    "--theme-catalog-fit-fg": "rgba(91, 107, 124, 0.55)",
    "--theme-catalog-fit-border": "rgba(148, 163, 184, 0.35)",
    "--theme-catalog-fit-bg": "rgba(148, 163, 184, 0.06)",
    "--theme-catalog-fit-opacity": "0.42",

    /* Display texture overlays on light faces */


    /* ── Industrial metal — bright brushed aluminium ── */
    "--theme-industrial-bg": "#c8d4e0",
    "--theme-industrial-text": "#0c4a6e",
    /* DFlash / DSPARK spec strip — violet surface, clearly visible on paper */
    "--theme-dflash-strip-bg": "#ddd6fe",
    "--theme-dflash-strip-border": "#a78bfa",
    "--theme-dflash-strip-text": "#5b21b6",
    "--theme-dflash-strip-text-soft": "color-mix(in srgb, #5b21b6 80%, transparent)",
    "--theme-dflash-strip-btn-text": "#5b21b6",
    "--theme-dflash-strip-btn-border": "#a78bfa",
    "--theme-dflash-strip-btn-bg": "#c4b5fd",
    "--theme-dflash-strip-btn-hover-bg": "#a78bfa",
    "--theme-dflash-strip-btn-ghost-text": "#5b21b6",
    "--theme-dflash-strip-btn-ghost-border": "#a78bfa",
    "--theme-dflash-strip-shadow": "none",
    /* MTP spec strip — fresh emerald surface (clean green, not swampy, on paper) */
    "--theme-dflash-mtp-bg": "#d1fae5",
    "--theme-dflash-mtp-border": "#6ee7b7",
    "--theme-dflash-mtp-text": "#047857",
    "--theme-dflash-mtp-text-soft": "color-mix(in srgb, #047857 80%, transparent)",
    "--theme-dflash-mtp-btn-text": "#047857",
    "--theme-dflash-mtp-btn-border": "#6ee7b7",
    "--theme-dflash-mtp-btn-bg": "#a7f3d0",
    "--theme-dflash-mtp-btn-hover-bg": "#6ee7b7",
    "--theme-dflash-mtp-btn-hover-border": "#34d399",
    "--theme-dflash-mtp-shadow": "none",
    "--theme-industrial-muted": "#5b6b7c",
    "--theme-industrial-bar-track": "rgba(14, 165, 233, 0.12)",
    "--theme-industrial-gpu-card-bg": "rgba(14, 165, 233, 0.1)",
    "--theme-industrial-gpu-border": "rgba(3, 105, 161, 0.28)",
    "--theme-industrial-gpu-selected": "rgba(2, 132, 199, 0.7)",
    "--theme-gpu-topo-selected-border": "rgba(2, 132, 199, 0.55)",
    "--theme-gpu-topo-selected-shadow":
      "0 4px 12px rgba(14, 165, 233, 0.18), 0 1px 4px rgba(15, 40, 70, 0.1)",
    "--theme-bezel-edge-hi": "rgba(255, 255, 255, 0.72)",
    "--theme-bezel-edge-lo": "rgba(100, 120, 140, 0.16)",
    "--theme-bezel-grain": "rgba(80, 100, 120, 0.08)",
    "--theme-bezel-bottom-shade": "color-mix(in srgb, #64748b 7%, transparent)",
    "--theme-bezel-dot-shade": "color-mix(in srgb, #64748b 5%, transparent)",
    "--theme-bezel-inset-hi": "rgba(255, 255, 255, 0.55)",
    "--theme-bezel-inset-lo": "rgba(15, 40, 70, 0.14)",
    "--display-face-inset-top": "rgba(15, 40, 70, 0.18)",
    "--display-face-inset-bottom": "rgba(15, 40, 70, 0.1)",
    "--theme-bezel-cast-shadow": DISPLAY_PROFILE_BEZEL_CAST,
    /* Eject panel (running engines) — stronger, longer cast than the frame so
       the aluminium panel reads as floating above the toolbar below. Cool
       slate (not pure black) to stay on the Glacier Dawn language. */
    "--theme-eject-cast-shadow":
      "0 10px 28px rgba(15, 40, 70, 0.28), 0 4px 10px rgba(15, 40, 70, 0.18)",
    "--theme-bench-inset-shadow": "rgba(15, 40, 70, 0.08)",
    "--theme-card-selected-bg": "#ffffff",
    "--theme-card-selected-accent": "#0ea5e9",
    "--theme-scrollbar-track": "rgba(226, 232, 240, 0.85)",
    "--theme-scrollbar-thumb": "rgba(14, 165, 233, 0.4)",

    /* ── Secondary — copper signal (status / updates / warn) ── */
    "--theme-secondary": "#c2410c",
    "--theme-secondary-bright": "#ea580c",
    "--theme-selection-bg": "#0ea5e9",
    "--theme-selection-text": "#f8fafc",

    /* ── Cards / eject ── floating white glass */
    "--theme-eject-header-bg": "#dbe7f2",
    "--theme-eject-header-text": "#c2410c",
    "--theme-eject-card-bg": "rgba(255, 255, 255, 0.72)",
    "--theme-eject-card-hover-bg": "rgba(255, 255, 255, 0.92)",
    "--theme-eject-card-text": "#0b1220",
    "--theme-eject-card-muted": "#5b6b7c",
    "--theme-eject-badge-bg": "rgba(255, 255, 255, 0.9)",
    "--theme-eject-card-border": "var(--theme-frame-border)",
    "--theme-eject-card-hover-border": "var(--theme-frame-border-strong)",
    "--theme-eject-card-selected-bg": "#ffffff",
    "--theme-eject-card-selected-border": "rgba(14, 165, 233, 0.55)",

    /* ── Provider pills — sky active, soft sand idle ── */
    "--theme-provider-label": "#c2410c",
    "--theme-provider-pill-bg": "#fff7ed",
    "--theme-provider-pill-border": "#ea580c",
    "--theme-provider-pill-text": "#c2410c",
    "--theme-provider-pill-hover-border": "#f97316",
    "--theme-provider-pill-hover-text": "#9a3412",
    "--theme-provider-pill-active-bg": "#0ea5e9",
    "--theme-provider-pill-active-border": "#0284c7",
    "--theme-provider-pill-active-text": "#f8fafc",

    /* ── Header / nav — bright glass chrome ── */
    "--theme-header-border": "#c5d4e4",
    "--theme-header-title": "#0b1220",
    "--theme-header-subtitle": "rgba(11, 18, 32, 0.48)",
    "--theme-header-logo": "#0284c7",
    "--theme-nav-text": "#5b6b7c",
    "--theme-nav-hover-text": "#0b1220",
    "--theme-nav-hover-bg": "rgba(14, 165, 233, 0.08)",
    "--theme-nav-active-bg": "rgba(14, 165, 233, 0.14)",
    "--theme-nav-active-border": "rgba(2, 132, 199, 0.55)",
    "--theme-nav-active-text": "#0369a1",
    "--theme-chrome-control-border": "#c5d4e4",
    "--theme-chrome-control-text": "#5b6b7c",
    "--theme-chrome-control-hover": "#0284c7",

    /* ── Footer — cool slate band, copper console signal ── */
    "--theme-footer-bg": "#d5e0eb",
    "--theme-footer-border": "#c2410c",
    "--theme-footer-text": "rgba(11, 18, 32, 0.58)",
    "--theme-status-nominal": "#0369a1",

    /* ── Launch CTA — solid polar sky ── */
    "--theme-launch-bg": "#0ea5e9",
    "--theme-launch-border": "#0284c7",
    "--theme-launch-text": "#f8fafc",
    "--theme-launch-shadow": "0 2px 10px rgba(14, 165, 233, 0.35)",
    "--theme-launch-hover-bg": "#38bdf8",
    "--theme-launch-hover-border": "#0ea5e9",
    "--theme-launch-hover-text": "#0b1220",
    "--theme-launch-hover-shadow": "0 3px 14px rgba(14, 165, 233, 0.45)",
    "--theme-launch-active-bg": "#0284c7",
    "--theme-launch-active-border": "#0369a1",
    "--theme-launch-active-text": "#f8fafc",
    "--theme-launch-active-shadow": "0 1px 6px rgba(2, 132, 199, 0.4)",

    /* Bright aluminium face under grit/brush/diamond — tighter range (not glare-white) */
    "--theme-industrial-face-gradient":
      "linear-gradient(168deg, #d8e2ec 0%, #c8d6e4 20%, #b4c4d4 46%, #c2d0de 70%, #dce6f0 100%)",
    "--theme-cockpit-well-shadow":
      "inset 0 1px 3px color-mix(in srgb, #64748b 8%, transparent), inset 0 1px 0 color-mix(in srgb, #ffffff 70%, transparent), inset 0 -1px 0 color-mix(in srgb, #ffffff 40%, transparent)",
    "--theme-cockpit-header-shadow":
      "inset 0 1px 0 color-mix(in srgb, #ffffff 75%, transparent), inset 0 -1px 0 color-mix(in srgb, #94a3b8 10%, transparent)",
  },
};

export const APP_THEMES: AppTheme[] = [MATRIX, SLATE, ARCTIC];

/** EXPERIMENT-theme-arctic: trial default — glacier light for product feel */
export const DEFAULT_THEME_ID = "arctic";

export function getThemeById(id: string): AppTheme {
  return APP_THEMES.find(t => t.id === id) ?? ARCTIC;
}

/** Keys last applied — cleared when missing from the next theme (avoids ARCTIC-only tokens sticking). */
let appliedThemeTokenKeys: string[] = [];

export function applyAppTheme(theme: AppTheme): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme.id);
  const nextKeys = Object.keys(theme.tokens);
  for (const key of appliedThemeTokenKeys) {
    if (!(key in theme.tokens)) {
      root.style.removeProperty(key);
    }
  }
  for (const [key, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(key, value);
  }
  appliedThemeTokenKeys = nextKeys;
}