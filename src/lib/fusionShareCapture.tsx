import { toCanvas } from "html-to-image";
import { brandLogoMarkup } from "./brandLogos";
import type { DisplayTexture } from "./displayTexture";
import { DISPLAY_BEZEL_PADDING_PX, FORECAST_PHOSPHOR_HEIGHT_PX } from "./onboardingDisplay";
import { getThemeById } from "../themes/app-themes";

export const FUSION_SHARE_FRAME_SELECTOR = "[data-fusion-share-frame]";

/** Share cards always snapshot as phosphor-light e-ink (readable on every app theme). */
const SHARE_CAPTURE_TEXTURE: DisplayTexture = "phosphor-light";

export interface FusionShareLaunchConfig {
  ctx?: string | number;
  batch?: string | number;
  ubatch?: string | number;
  flashAttn?: string;
  splitMode?: string;
  kvQuant?: string;
}

export interface FusionShareMeta {
  providerName?: string;
  modelName?: string;
  modelQuant?: string;
  profileLabel?: string;
  cudaVersion?: string;
  launchConfig?: FusionShareLaunchConfig;
}

/** Share cards always render as ARCTIC — unified look across users/themes. */
const SHARE_CAPTURE_THEME_ID = "arctic";
const NV_GREEN = "#76B900";

const CAPTURE_STRIP_SELECTORS = [
  "[data-fusion-share-exclude]",
  ".display-texture-toggle",
  ".display-glitch-ambient",
  ".display-glitch-chroma",
  ".display-glitch-block",
  ".vram-forecast-scenario-badge",
].join(",");

/**
 * Export layout budget (CSS px):
 * 1. White header (provider · profile · model · params).
 * 2. Gap + frame (live phosphor + bezel height).
 * 3. Footer (logo + version) pinned to bottom of frame.
 * 4. Width derived from total height so the full card stays 16:9.
 */
const SHARE_ASPECT_W = 16;
const SHARE_ASPECT_H = 9;
export const FUSION_SHARE_EXPORT_GAP = 10;
/** Panel-accent mat around the bezel in share captures (CSS px). */
export const FUSION_SHARE_EXPORT_FRAME_PAD_TOP = 0;
export const FUSION_SHARE_EXPORT_FRAME_PAD_X = 20;
export const FUSION_SHARE_EXPORT_FRAME_PAD_BOTTOM = 20;
/** Matches live `.vram-forecast-display` + gunmetal bezel padding. */
export const FUSION_SHARE_LIVE_FRAME_HEIGHT_PX =
  FORECAST_PHOSPHOR_HEIGHT_PX + DISPLAY_BEZEL_PADDING_PX * 2;
/** Gunmetal bezel block height (phosphor + frame padding). */
export const FUSION_SHARE_EXPORT_BEZEL_HEIGHT_PX = FUSION_SHARE_LIVE_FRAME_HEIGHT_PX;
/** Middle card section — bezel inset with panel-accent breathing room + drop shadow. */
export const FUSION_SHARE_EXPORT_FRAME_HEIGHT =
  FUSION_SHARE_EXPORT_BEZEL_HEIGHT_PX +
  FUSION_SHARE_EXPORT_FRAME_PAD_TOP +
  FUSION_SHARE_EXPORT_FRAME_PAD_BOTTOM;
export const FUSION_SHARE_EXPORT_FOOTER_HEIGHT = 27;
/** Provider · profile · model · params — white header bar only. */
export const FUSION_SHARE_EXPORT_HEADER_HEIGHT = 80;
/** @deprecated Use FUSION_SHARE_EXPORT_HEADER_HEIGHT — kept for callers expecting brand height. */
export const FUSION_SHARE_EXPORT_BRAND_HEIGHT = FUSION_SHARE_EXPORT_HEADER_HEIGHT;
export const FUSION_SHARE_EXPORT_TOTAL_HEIGHT =
  FUSION_SHARE_EXPORT_HEADER_HEIGHT +
  FUSION_SHARE_EXPORT_GAP +
  FUSION_SHARE_EXPORT_FRAME_HEIGHT +
  FUSION_SHARE_EXPORT_FOOTER_HEIGHT;
export const FUSION_SHARE_EXPORT_WIDTH = Math.round(
  (FUSION_SHARE_EXPORT_TOTAL_HEIGHT * SHARE_ASPECT_W) / SHARE_ASPECT_H,
);
const FUSION_SHARE_FOOTER_LOGO_HEIGHT = 22;
const FUSION_SHARE_HEADER_BG = "#f4f6f8";
const FUSION_SHARE_HEADER_TEXT = "#1a2030";
const FUSION_SHARE_HEADER_MUTED = "rgba(26, 32, 48, 0.45)";
const FUSION_SHARE_HEADER_DIVIDER = "rgba(30, 50, 80, 0.22)";
const FUSION_SHARE_HEADER_BORDER = "rgba(30, 50, 80, 0.12)";
const FUSION_SHARE_FOOTER_BG = "#0a0c10";
const FUSION_SHARE_FOOTER_BORDER = "rgba(118, 185, 0, 0.22)";
/** CSS card × FUSION_SHARE_EXPORT_PIXEL_RATIO → PNG (e.g. ~707×398 → ~2828×1592). */
export const FUSION_SHARE_EXPORT_PIXEL_RATIO = 4;

export function fusionShareExportPixelSize(): {
  width: number;
  height: number;
  brandHeight: number;
  frameHeight: number;
  footerHeight: number;
} {
  const scale = FUSION_SHARE_EXPORT_PIXEL_RATIO;
  const brandHeight = FUSION_SHARE_EXPORT_HEADER_HEIGHT * scale;
  const frameHeight = FUSION_SHARE_EXPORT_FRAME_HEIGHT * scale;
  const footerHeight = FUSION_SHARE_EXPORT_FOOTER_HEIGHT * scale;
  return {
    width: FUSION_SHARE_EXPORT_WIDTH * scale,
    height: FUSION_SHARE_EXPORT_TOTAL_HEIGHT * scale,
    brandHeight,
    frameHeight,
    footerHeight,
  };
}

interface HiddenNode {
  el: HTMLElement;
  visibility: string;
}

interface StyleRestore {
  el: HTMLElement;
  overflow: string;
}

interface PaddingRestore {
  el: HTMLElement;
  padding: string;
  borderRadius: string;
}

interface CaptureColors {
  /** Brand header bar */
  brandBar: string;
  /** `.industrial-display-area` brushed panel behind bezel */
  panelAccent: string;
  /** Industrial VRAM bezel */
  industrialBg: string;
  /** Merged card letterbox fill */
  cardFill: string;
  title: string;
  subtitle: string;
  logo: string;
  accent: string;
  accentSoft: string;
  border: string;
  divider: string;
}

function arcticToken(name: string, fallback: string): string {
  const theme = getThemeById(SHARE_CAPTURE_THEME_ID);
  return theme.tokens[name] ?? fallback;
}

function resolveCaptureColors(): CaptureColors {
  const industrialBg = arcticToken("--theme-industrial-bg", "#b0bcc8");
  const panelAccent = arcticToken("--theme-panel-accent", "#dce2ea");
  return {
    brandBar: arcticToken("--theme-panel", "#f4f6f8"),
    panelAccent,
    industrialBg,
    cardFill: panelAccent,
    title: arcticToken("--theme-header-title", "#1a2030"),
    subtitle: arcticToken("--theme-header-subtitle", "rgba(26, 32, 48, 0.45)"),
    logo: arcticToken("--theme-header-logo", "#2a6b4a"),
    accent: arcticToken("--theme-accent-bright", "#1a5a3a"),
    accentSoft: arcticToken("--theme-chip-active-bg", "rgba(42, 107, 74, 0.16)"),
    border: arcticToken("--theme-border-subtle", "rgba(30, 50, 80, 0.12)"),
    divider: arcticToken("--theme-border", "#b8c4d0"),
  };
}

function applyShareCaptureTheme(host: HTMLElement): void {
  host.setAttribute("data-theme", SHARE_CAPTURE_THEME_ID);
  host.setAttribute("data-display-texture", SHARE_CAPTURE_TEXTURE);
  const theme = getThemeById(SHARE_CAPTURE_THEME_ID);
  for (const [key, value] of Object.entries(theme.tokens)) {
    host.style.setProperty(key, value);
  }
}

interface PrimedSurface {
  el: HTMLElement;
  backgroundColor: string;
  backgroundImage: string;
}

function primeFrameBezel(frame: HTMLElement, colors: CaptureColors): PrimedSurface[] {
  const primed: PrimedSurface[] = [];
  primed.push({
    el: frame,
    backgroundColor: frame.style.backgroundColor,
    backgroundImage: frame.style.backgroundImage,
  });
  frame.style.backgroundColor = colors.industrialBg;
  const grain = getComputedStyle(frame).backgroundImage;
  if (grain && grain !== "none") {
    frame.style.backgroundImage = grain;
  }
  return primed;
}

function restorePrimedSurfaces(primed: PrimedSurface[]): void {
  primed.forEach(({ el, backgroundColor, backgroundImage }) => {
    el.style.backgroundColor = backgroundColor;
    el.style.backgroundImage = backgroundImage;
  });
}

function brandDivider(): HTMLSpanElement {
  const divider = document.createElement("span");
  divider.textContent = "│";
  divider.style.flexShrink = "0";
  divider.style.color = FUSION_SHARE_HEADER_DIVIDER;
  divider.style.opacity = "0.85";
  divider.style.fontFamily = "'JetBrains Mono', 'Roboto Mono', monospace";
  divider.style.fontSize = "11px";
  divider.style.lineHeight = "1";
  return divider;
}

function formatShareCtx(value: string | number | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (value >= 1_048_576 && value % 1_048_576 === 0) return `${value / 1_048_576}M`;
    if (value >= 1024 && value % 1024 === 0) return `${value / 1024}K`;
    return String(value);
  }
  const text = String(value).trim();
  return text || null;
}

function formatShareBatchPair(
  batch: string | number | undefined,
  ubatch: string | number | undefined,
): string | null {
  const hasBatch = batch !== undefined && batch !== null && batch !== "";
  const hasUbatch = ubatch !== undefined && ubatch !== null && ubatch !== "";
  if (!hasBatch && !hasUbatch) return null;
  if (hasBatch && hasUbatch) return `batch/ubatch ${batch}/${ubatch}`;
  if (hasBatch) return `batch ${batch}`;
  return `ubatch ${ubatch}`;
}

function formatShareFlashAttn(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  return `flash-att ${value.trim().toLowerCase()}`;
}

function formatShareSplitMode(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  return `split ${value.trim().toLowerCase()}`;
}

function formatShareKvQuant(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  return `KV ${value.trim().toUpperCase()}`;
}

function brandConfigLabel(text: string): HTMLSpanElement {
  const label = document.createElement("span");
  label.textContent = text;
  label.style.fontFamily = "monospace";
  label.style.fontSize = "9px";
  label.style.fontWeight = "400";
  label.style.letterSpacing = "0.04em";
  label.style.color = FUSION_SHARE_HEADER_MUTED;
  label.style.opacity = "1";
  label.style.whiteSpace = "nowrap";
  label.style.flexShrink = "0";
  label.style.lineHeight = "1.2";
  return label;
}

function brandKvQuantLabel(text: string): HTMLSpanElement {
  const label = document.createElement("span");
  label.textContent = text;
  label.style.fontFamily = "monospace";
  label.style.fontSize = "10px";
  label.style.fontWeight = "700";
  label.style.letterSpacing = "0.05em";
  label.style.color = NV_GREEN;
  label.style.background = "rgba(118, 185, 0, 0.14)";
  label.style.border = `1px solid ${NV_GREEN}`;
  label.style.borderRadius = "4px";
  label.style.padding = "2px 7px";
  label.style.whiteSpace = "nowrap";
  label.style.flexShrink = "0";
  label.style.lineHeight = "1.2";
  return label;
}

function collectShareLaunchConfigSegments(
  launchConfig: FusionShareLaunchConfig | undefined,
): string[] {
  if (!launchConfig) return [];

  const segments: string[] = [];
  const ctx = formatShareCtx(launchConfig.ctx);
  if (ctx) segments.push(`CTX ${ctx}`);

  const batchPair = formatShareBatchPair(launchConfig.batch, launchConfig.ubatch);
  if (batchPair) segments.push(batchPair);

  const flashAttn = formatShareFlashAttn(launchConfig.flashAttn);
  if (flashAttn) segments.push(flashAttn);

  const splitMode = formatShareSplitMode(launchConfig.splitMode);
  if (splitMode) segments.push(splitMode);

  return segments;
}

function brandCudaBadge(cudaVersion: string): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.textContent = `CUDA ${cudaVersion}`;
  badge.style.fontFamily = "'JetBrains Mono', 'Roboto Mono', monospace";
  badge.style.fontSize = "10px";
  badge.style.fontWeight = "700";
  badge.style.letterSpacing = "0.05em";
  badge.style.color = NV_GREEN;
  badge.style.border = `1px solid ${NV_GREEN}`;
  badge.style.borderRadius = "4px";
  badge.style.padding = "2px 8px";
  badge.style.background = "rgba(118, 185, 0, 0.1)";
  badge.style.lineHeight = "1.2";
  badge.style.flexShrink = "0";
  return badge;
}

function createLaunchParamsBox(
  launchConfig: FusionShareLaunchConfig | undefined,
): HTMLElement | null {
  const kvQuant = formatShareKvQuant(launchConfig?.kvQuant);
  const segments = collectShareLaunchConfigSegments(launchConfig);
  if (!kvQuant && segments.length === 0) return null;

  const box = document.createElement("div");
  box.style.display = "inline-flex";
  box.style.alignItems = "center";
  box.style.flexWrap = "nowrap";
  box.style.gap = "6px";
  box.style.padding = "6px 14px";
  box.style.border = `1px solid ${FUSION_SHARE_HEADER_BORDER}`;
  box.style.borderRadius = "6px";
  box.style.maxWidth = "100%";
  box.style.overflow = "hidden";

  if (kvQuant) {
    box.appendChild(brandKvQuantLabel(kvQuant));
    if (segments.length > 0) {
      box.appendChild(brandDivider());
    }
  }

  segments.forEach((segment, index) => {
    if (index > 0) box.appendChild(brandDivider());
    box.appendChild(brandConfigLabel(segment));
  });

  return box;
}

interface FrameCaptureStage {
  stage: HTMLElement;
  frame: HTMLElement;
}

/**
 * WebView2 only rasterizes on-screen nodes for html-to-image.
 * Mount at (0,0) one shell at a time — never -10000px or below the viewport.
 */
function mountCaptureShell(shell: HTMLElement): void {
  shell.style.position = "fixed";
  shell.style.left = "0";
  shell.style.top = "0";
  shell.style.pointerEvents = "none";
  shell.style.zIndex = "2147483647";
  shell.style.opacity = "1";
  shell.style.visibility = "visible";
  if (!shell.isConnected) {
    document.body.appendChild(shell);
  }
}

function unmountCaptureShell(shell: HTMLElement): void {
  if (shell.isConnected) {
    document.body.removeChild(shell);
  }
}

/** Offscreen clone at fixed CSS px — avoids mutating the live panel and ignores UI zoom. */
function createFrameCaptureStage(source: HTMLElement, colors: CaptureColors): FrameCaptureStage {
  const padTop = FUSION_SHARE_EXPORT_FRAME_PAD_TOP;
  const padX = FUSION_SHARE_EXPORT_FRAME_PAD_X;
  const padBottom = FUSION_SHARE_EXPORT_FRAME_PAD_BOTTOM;
  const bezelHeight = FUSION_SHARE_EXPORT_BEZEL_HEIGHT_PX;
  const innerWidth = FUSION_SHARE_EXPORT_WIDTH - padX * 2;

  const stage = document.createElement("div");
  stage.className = "fusion-share-capture-stage";
  stage.setAttribute("data-fusion-share-capture", "");
  stage.setAttribute("data-fusion-share-exclude", "");
  applyShareCaptureTheme(stage);
  stage.style.setProperty("--ui-text-scale", "1");
  stage.style.width = `${FUSION_SHARE_EXPORT_WIDTH}px`;
  stage.style.height = `${FUSION_SHARE_EXPORT_FRAME_HEIGHT}px`;
  stage.style.padding = `${padTop}px ${padX}px ${padBottom}px ${padX}px`;
  stage.style.background = colors.panelAccent;
  stage.style.display = "block";
  stage.style.overflow = "visible";
  stage.style.boxSizing = "border-box";

  const frame = source.cloneNode(true) as HTMLElement;
  frame.style.width = `${innerWidth}px`;
  frame.style.height = `${bezelHeight}px`;
  frame.style.minHeight = `${bezelHeight}px`;
  frame.style.maxHeight = `${bezelHeight}px`;
  frame.style.maxWidth = `${innerWidth}px`;
  frame.style.minWidth = "0";
  frame.style.display = "block";
  frame.style.boxSizing = "border-box";
  frame.style.overflow = "visible";
  frame.style.margin = "0";

  normalizeFusionCaptureLayout(frame);

  stage.appendChild(frame);
  return { stage, frame };
}

/** Clone restarts fadeIn at opacity 0 — force fusion phosphor + overlay fully painted before snapshot. */
function forceFusionCapturePaint(frame: HTMLElement): void {
  const roots = [
    frame,
    frame.querySelector(".vram-forecast-display"),
    frame.querySelector(".vram-badge-forecast"),
    frame.querySelector(".vram-badge-forecast > .phosphor-screen.phosphor-display-surface"),
    frame.querySelector(".vram-forecast-display .phosphor-screen.phosphor-display-surface"),
  ];

  roots.forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    node.style.opacity = "1";
    node.style.visibility = "visible";
    node.style.animation = "none";
  });

  frame.querySelectorAll<HTMLElement>("[style*='fadeIn'], [style*='opacity']").forEach((node) => {
    node.style.animation = "none";
    node.style.opacity = "1";
  });
}

/** Live overlay hero uses `clamp(…, 6vh, …)` — offscreen capture must pin a fixed size. */
const FUSION_CAPTURE_HERO_FONT_PX = 44;

function stripForecastPaddingForCapture(frame: HTMLElement): PaddingRestore[] {
  const restores: PaddingRestore[] = [];
  const nodes: HTMLElement[] = [];

  const display = frame.querySelector(".vram-forecast-display");
  if (display instanceof HTMLElement) nodes.push(display);

  const forecast = frame.querySelector(".vram-badge-forecast");
  if (forecast instanceof HTMLElement) nodes.push(forecast);

  const header = frame.querySelector(".vram-forecast-header");
  if (header instanceof HTMLElement) nodes.push(header);

  const fusionPanel = frame.querySelector(
    ".vram-badge-forecast > .phosphor-screen.phosphor-display-surface",
  );
  if (fusionPanel instanceof HTMLElement) nodes.push(fusionPanel);

  nodes.forEach((el) => {
    restores.push({
      el,
      padding: el.style.padding,
      borderRadius: el.style.borderRadius,
    });
    el.style.padding = "0";
    if (el === fusionPanel) {
      el.style.borderRadius = "0";
      el.style.top = "0";
      el.style.left = "0";
      el.style.right = "0";
      el.style.bottom = "0";
    }
  });

  if (header instanceof HTMLElement) {
    header.style.visibility = "hidden";
    header.style.height = "0";
    header.style.minHeight = "0";
    header.style.maxHeight = "0";
    header.style.margin = "0";
    header.style.overflow = "hidden";
  }

  return restores;
}

function restoreForecastPadding(restores: PaddingRestore[]): void {
  restores.forEach(({ el, padding, borderRadius }) => {
    el.style.padding = padding;
    el.style.borderRadius = borderRadius;
    if (el.classList.contains("vram-forecast-header")) {
      el.style.visibility = "";
      el.style.height = "";
      el.style.minHeight = "";
      el.style.maxHeight = "";
      el.style.margin = "";
      el.style.overflow = "";
    }
  });
}

function normalizeFusionCaptureLayout(frame: HTMLElement): void {
  const display = frame.querySelector(".vram-forecast-display");
  if (display instanceof HTMLElement) {
    display.style.height = `${FORECAST_PHOSPHOR_HEIGHT_PX}px`;
    display.style.minHeight = `${FORECAST_PHOSPHOR_HEIGHT_PX}px`;
    display.style.maxHeight = `${FORECAST_PHOSPHOR_HEIGHT_PX}px`;
  }

  frame.querySelectorAll<HTMLElement>(".fusion-prefill-hero-value").forEach((el) => {
    el.style.fontSize = `${FUSION_CAPTURE_HERO_FONT_PX}px`;
  });

  frame.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    const fontSize = el.style.fontSize;
    if (fontSize.includes("vh") || fontSize.includes("clamp")) {
      el.style.fontSize = `${FUSION_CAPTURE_HERO_FONT_PX}px`;
    }
  });
}

function brandIdentityLabel(text: string, weight = "700"): HTMLSpanElement {
  const label = document.createElement("span");
  label.textContent = text;
  label.style.fontFamily = "monospace";
  label.style.fontSize = "11px";
  label.style.fontWeight = weight;
  label.style.letterSpacing = "0.06em";
  label.style.color = FUSION_SHARE_HEADER_TEXT;
  label.style.webkitTextFillColor = FUSION_SHARE_HEADER_TEXT;
  label.style.lineHeight = "1.2";
  label.style.flexShrink = "0";
  label.style.whiteSpace = "nowrap";
  return label;
}

function createFooterShell(): HTMLElement {
  const shell = document.createElement("div");
  shell.className = "fusion-share-capture-footer-shell";
  shell.setAttribute("data-fusion-share-exclude", "");
  shell.style.setProperty("--ui-text-scale", "1");

  shell.style.top = "0";
  shell.style.left = "0";
  shell.style.width = `${FUSION_SHARE_EXPORT_WIDTH}px`;
  shell.style.height = `${FUSION_SHARE_EXPORT_FOOTER_HEIGHT}px`;
  shell.style.zIndex = "2147483647";
  shell.style.pointerEvents = "none";
  shell.style.boxSizing = "border-box";
  shell.style.position = "fixed";
  shell.style.display = "flex";
  shell.style.alignItems = "center";
  shell.style.justifyContent = "flex-end";
  shell.style.gap = "10px";
  shell.style.padding = "0 10px";
  shell.style.background = FUSION_SHARE_FOOTER_BG;
  shell.style.borderTop = `1px solid ${FUSION_SHARE_FOOTER_BORDER}`;
  shell.style.overflow = "hidden";

  const versionLine = document.createElement("span");
  versionLine.textContent = `v${__TAURI_VERSION__} · BUILD ${__APP_VERSION__}`;
  versionLine.style.fontFamily = "monospace";
  versionLine.style.fontSize = "7px";
  versionLine.style.fontWeight = "600";
  versionLine.style.letterSpacing = "0.05em";
  versionLine.style.color = "rgba(118, 185, 0, 0.82)";
  versionLine.style.webkitTextFillColor = "rgba(118, 185, 0, 0.82)";
  versionLine.style.lineHeight = "1";
  versionLine.style.whiteSpace = "nowrap";
  versionLine.style.flexShrink = "0";
  shell.appendChild(versionLine);

  const logoWrap = document.createElement("span");
  logoWrap.style.display = "inline-flex";
  logoWrap.style.color = NV_GREEN;
  logoWrap.style.lineHeight = "0";
  logoWrap.style.flexShrink = "0";
  logoWrap.innerHTML = brandLogoMarkup(FUSION_SHARE_FOOTER_LOGO_HEIGHT);
  shell.appendChild(logoWrap);

  return shell;
}

function createHeaderShell(meta: FusionShareMeta): HTMLElement {
  const shell = document.createElement("div");
  shell.className = "fusion-share-capture-brand-shell";
  shell.setAttribute("data-fusion-share-exclude", "");
  shell.style.setProperty("--ui-text-scale", "1");

  shell.style.top = "0";
  shell.style.left = "0";
  shell.style.width = `${FUSION_SHARE_EXPORT_WIDTH}px`;
  shell.style.height = `${FUSION_SHARE_EXPORT_HEADER_HEIGHT}px`;
  shell.style.zIndex = "2147483647";
  shell.style.pointerEvents = "none";
  shell.style.boxSizing = "border-box";
  shell.style.position = "fixed";
  shell.style.display = "flex";
  shell.style.flexDirection = "column";
  shell.style.background = FUSION_SHARE_HEADER_BG;
  shell.style.color = FUSION_SHARE_HEADER_TEXT;
  shell.style.overflow = "hidden";
  shell.style.borderBottom = `1px solid ${FUSION_SHARE_HEADER_BORDER}`;

  const main = document.createElement("div");
  main.style.flex = "1";
  main.style.display = "flex";
  main.style.flexDirection = "column";
  main.style.justifyContent = "center";
  main.style.gap = "6px";
  main.style.padding = "6px 12px 4px";
  main.style.minWidth = "0";
  main.style.boxSizing = "border-box";
  main.style.overflow = "hidden";
  main.style.background = FUSION_SHARE_HEADER_BG;

  const providerName = meta.providerName?.trim();
  const profileLabel = meta.profileLabel?.trim();
  const cudaVersion = meta.cudaVersion?.trim();
  const modelName = meta.modelName?.trim();
  const modelQuant = meta.modelQuant?.trim();
  const hasIdentityLine = providerName || profileLabel || cudaVersion || modelName || modelQuant;

  if (hasIdentityLine) {
    const stackRow = document.createElement("div");
    stackRow.style.display = "flex";
    stackRow.style.alignItems = "center";
    stackRow.style.gap = "8px";
    stackRow.style.minWidth = "0";
    stackRow.style.width = "100%";
    stackRow.style.overflow = "hidden";
    stackRow.style.whiteSpace = "nowrap";

    if (providerName) {
      stackRow.appendChild(brandIdentityLabel(providerName));
    }
    if (profileLabel) {
      if (providerName) {
        stackRow.appendChild(brandDivider());
      }
      stackRow.appendChild(brandIdentityLabel(profileLabel));
    }
    if (cudaVersion) {
      stackRow.appendChild(brandCudaBadge(cudaVersion));
    }

    if (modelName || modelQuant) {
      if (providerName || profileLabel || cudaVersion) {
        stackRow.appendChild(brandDivider());
      }

      const modelLine = document.createElement("span");
      const modelParts = [modelName, modelQuant].filter(Boolean);
      modelLine.textContent = modelParts.join(" ");
      modelLine.style.fontFamily = "monospace";
      modelLine.style.fontSize = "11px";
      modelLine.style.fontWeight = "600";
      modelLine.style.color = FUSION_SHARE_HEADER_TEXT;
      modelLine.style.webkitTextFillColor = FUSION_SHARE_HEADER_TEXT;
      modelLine.style.lineHeight = "1.2";
      modelLine.style.flex = "1";
      modelLine.style.minWidth = "0";
      modelLine.style.overflow = "hidden";
      modelLine.style.textOverflow = "ellipsis";
      modelLine.style.whiteSpace = "nowrap";
      stackRow.appendChild(modelLine);
    }

    main.appendChild(stackRow);
  }

  const paramsBox = createLaunchParamsBox(meta.launchConfig);
  if (paramsBox) {
    paramsBox.style.maxWidth = "100%";
    paramsBox.style.flexShrink = "1";
    paramsBox.style.minWidth = "0";
    main.appendChild(paramsBox);
  }

  shell.appendChild(main);

  return shell;
}

function hideCaptureChrome(frame: HTMLElement): HiddenNode[] {
  const hidden: HiddenNode[] = [];
  frame.querySelectorAll(CAPTURE_STRIP_SELECTORS).forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    hidden.push({ el: node, visibility: node.style.visibility });
    node.style.visibility = "hidden";
  });
  return hidden;
}

/**
 * Clone restarts fadeIn at opacity 0 — forecast bleeds through. Hide underlay and
 * force the fusion phosphor panel fully opaque for snapshot.
 */
function prepareFusionOverlayForCapture(frame: HTMLElement): HiddenNode[] {
  const hidden: HiddenNode[] = [];

  const forecast = frame.querySelector(".vram-badge-forecast");
  const fusionPanel = frame.querySelector(
    ".vram-badge-forecast > .phosphor-screen.phosphor-display-surface",
  );

  if (forecast instanceof HTMLElement && fusionPanel instanceof HTMLElement) {
    Array.from(forecast.children).forEach((child) => {
      if (child === fusionPanel || !(child instanceof HTMLElement)) return;
      hidden.push({ el: child, visibility: child.style.visibility });
      child.style.visibility = "hidden";
    });

    fusionPanel.style.opacity = "1";
    fusionPanel.style.animation = "none";
    fusionPanel.querySelectorAll<HTMLElement>("[style]").forEach((node) => {
      if (!(node.style.animation || "").includes("fadeIn")) return;
      node.style.animation = "none";
      node.style.opacity = "1";
    });
  }

  frame.querySelectorAll<HTMLElement>("[style*='fadeIn']").forEach((node) => {
    node.style.animation = "none";
    node.style.opacity = "1";
  });

  return hidden;
}

function restoreCaptureChrome(hidden: HiddenNode[]): void {
  hidden.forEach(({ el, visibility }) => {
    el.style.visibility = visibility;
  });
}

function clampFrameOverflow(frame: HTMLElement): StyleRestore {
  const restore = { el: frame, overflow: frame.style.overflow };
  frame.style.overflow = "visible";
  return restore;
}

function restoreFrameOverflow(restore: StyleRestore): void {
  restore.el.style.overflow = restore.overflow;
}

interface CaptureCanvasOpts {
  backgroundColor: string;
  canvasWidth: number;
  canvasHeight: number;
}

/** Avoid cross-origin Google Fonts cssRules reads in WebView2 (SecurityError). */
const CAPTURE_IMAGE_OPTS = {
  skipFonts: true,
  fontEmbedCSS: "" as const,
} as const;

async function captureNode(node: HTMLElement, opts: CaptureCanvasOpts): Promise<HTMLCanvasElement> {
  return toCanvas(node, {
    ...CAPTURE_IMAGE_OPTS,
    pixelRatio: 1,
    cacheBust: true,
    backgroundColor: opts.backgroundColor,
    canvasWidth: opts.canvasWidth,
    canvasHeight: opts.canvasHeight,
  });
}

async function ensureWindowFocused(): Promise<void> {
  window.focus();
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFocus();
  } catch {
    // Non-Tauri / permission edge — window.focus() above is enough on some hosts.
  }
}

function isFocusError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not focused|Document is not focused/i.test(msg);
}

function assertClipboardImageApi(): void {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Clipboard image API is not available");
  }
}

/**
 * Pass Promise<Blob> into ClipboardItem so clipboard.write begins in the click
 * handler's user-gesture window while capture finishes asynchronously.
 */
async function writeClipboardPngPromise(pngPromise: Promise<Blob>): Promise<void> {
  assertClipboardImageApi();
  const attempts = 3;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (attempt > 0) await ensureWindowFocused();
      await navigator.clipboard.write([
        new ClipboardItem({
          "image/png": pngPromise,
        }),
      ]);
      return;
    } catch (err) {
      if (attempt === attempts - 1 || !isFocusError(err)) throw err;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  }
}

function waitForPaint(frames = 4): Promise<void> {
  return new Promise((resolve) => {
    let remaining = frames;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("PNG encoding failed"));
      },
      "image/png",
    );
  });
}

function canvasHasVisiblePixels(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width < 1 || canvas.height < 1) return false;
  const sampleW = Math.min(canvas.width, 48);
  const sampleH = Math.min(canvas.height, 48);
  const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 12) return true;
  }
  return false;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = hex.trim().replace("#", "");
  if (normalized.length !== 6) return null;
  const value = Number.parseInt(normalized, 16);
  if (Number.isNaN(value)) return null;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Mat fills the border — require non-mat pixels in the bezel center. */
function canvasHasBezelContent(
  canvas: HTMLCanvasElement,
  pixelRatio: number,
  matColor: string,
): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width < 8 || canvas.height < 8) return false;

  const matRgb = hexToRgb(matColor);
  const padTop = FUSION_SHARE_EXPORT_FRAME_PAD_TOP * pixelRatio;
  const padBottom = FUSION_SHARE_EXPORT_FRAME_PAD_BOTTOM * pixelRatio;
  const bezelH = canvas.height - padTop - padBottom;
  const cx = Math.floor(canvas.width / 2);
  const cy = Math.floor(padTop + bezelH / 2);
  const half = 24;
  const x = Math.max(0, cx - half);
  const y = Math.max(0, cy - half);
  const w = Math.min(canvas.width - x, half * 2);
  const h = Math.min(canvas.height - y, half * 2);
  const data = ctx.getImageData(x, y, w, h).data;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 24) continue;
    if (!matRgb) return true;
    const dr = Math.abs(data[i] - matRgb[0]);
    const dg = Math.abs(data[i + 1] - matRgb[1]);
    const db = Math.abs(data[i + 2] - matRgb[2]);
    if (dr + dg + db > 36) return true;
  }
  return false;
}

async function captureMountedShell(
  shell: HTMLElement,
  opts: CaptureCanvasOpts,
): Promise<HTMLCanvasElement> {
  mountCaptureShell(shell);
  await waitForPaint(6);
  try {
    return await captureNode(shell, opts);
  } finally {
    unmountCaptureShell(shell);
  }
}

function compositeFrameWithMat(
  frameCanvas: HTMLCanvasElement,
  pixelRatio: number,
  matColor: string,
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = FUSION_SHARE_EXPORT_WIDTH * pixelRatio;
  out.height = FUSION_SHARE_EXPORT_FRAME_HEIGHT * pixelRatio;
  const ctx = out.getContext("2d");
  if (!ctx) return frameCanvas;

  const padTop = FUSION_SHARE_EXPORT_FRAME_PAD_TOP * pixelRatio;
  const padX = FUSION_SHARE_EXPORT_FRAME_PAD_X * pixelRatio;
  ctx.fillStyle = matColor;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(frameCanvas, padX, padTop);
  return out;
}

function cropCanvas(
  source: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number,
  backgroundColor: string,
): HTMLCanvasElement {
  const cropped = document.createElement("canvas");
  cropped.width = targetWidth;
  cropped.height = targetHeight;
  const ctx = cropped.getContext("2d");
  if (!ctx) return source;

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  const srcW = Math.min(source.width, targetWidth);
  const srcH = Math.min(source.height, targetHeight);
  ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, srcW, srcH);
  return cropped;
}

function drawHeaderFallbackCanvas(width: number, pixelRatio: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = FUSION_SHARE_EXPORT_HEADER_HEIGHT * pixelRatio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  const cssHeight = FUSION_SHARE_EXPORT_HEADER_HEIGHT;

  ctx.fillStyle = FUSION_SHARE_HEADER_BG;
  ctx.fillRect(0, 0, width, canvas.height);
  ctx.fillStyle = FUSION_SHARE_HEADER_TEXT;
  ctx.font = `700 ${15 * pixelRatio}px 'JetBrains Mono', 'Roboto Mono', monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("BLACKWELL OPS", width / 2, (cssHeight * pixelRatio) / 2);

  return canvas;
}

function mergeCanvases(
  headerCanvas: HTMLCanvasElement,
  frameCanvas: HTMLCanvasElement,
  footerCanvas: HTMLCanvasElement,
  backgroundColor: string,
): HTMLCanvasElement {
  const gap = FUSION_SHARE_EXPORT_GAP * FUSION_SHARE_EXPORT_PIXEL_RATIO;
  const width = frameCanvas.width;
  const height = headerCanvas.height + gap + frameCanvas.height + footerCanvas.height;
  const merged = document.createElement("canvas");
  merged.width = width;
  merged.height = height;

  const ctx = merged.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);

  let y = 0;
  ctx.drawImage(headerCanvas, 0, y);
  y += headerCanvas.height + gap;
  ctx.drawImage(frameCanvas, 0, y);
  y += frameCanvas.height;
  ctx.drawImage(footerCanvas, 0, y);
  return merged;
}

async function renderFusionSharePngOnce(meta: FusionShareMeta): Promise<Blob> {
  const sourceFrame = document.querySelector(FUSION_SHARE_FRAME_SELECTOR);
  if (!(sourceFrame instanceof HTMLElement)) {
    throw new Error("VRAM display frame not found");
  }

  const rect = sourceFrame.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    throw new Error("VRAM display frame is not visible");
  }

  const colors = resolveCaptureColors();
  const pixelRatio = FUSION_SHARE_EXPORT_PIXEL_RATIO;
  const targetFrameW = FUSION_SHARE_EXPORT_WIDTH * pixelRatio;
  const targetFrameH = FUSION_SHARE_EXPORT_FRAME_HEIGHT * pixelRatio;
  const targetHeaderW = FUSION_SHARE_EXPORT_WIDTH * pixelRatio;
  const targetHeaderH = FUSION_SHARE_EXPORT_HEADER_HEIGHT * pixelRatio;
  const targetFooterW = FUSION_SHARE_EXPORT_WIDTH * pixelRatio;
  const targetFooterH = FUSION_SHARE_EXPORT_FOOTER_HEIGHT * pixelRatio;

  const { stage, frame } = createFrameCaptureStage(sourceFrame, colors);
  const headerShell = createHeaderShell(meta);
  const footerShell = createFooterShell();

  const hidden = [
    ...hideCaptureChrome(frame),
    ...prepareFusionOverlayForCapture(frame),
  ];
  const overflowRestore = clampFrameOverflow(frame);
  const primedSurfaces = primeFrameBezel(frame, colors);
  const paddingRestore = stripForecastPaddingForCapture(frame);
  forceFusionCapturePaint(frame);

  const targetBezelW = (FUSION_SHARE_EXPORT_WIDTH - FUSION_SHARE_EXPORT_FRAME_PAD_X * 2) * pixelRatio;
  const targetBezelH = FUSION_SHARE_EXPORT_BEZEL_HEIGHT_PX * pixelRatio;

  try {
    let headerCanvas = await captureMountedShell(headerShell, {
      backgroundColor: FUSION_SHARE_HEADER_BG,
      canvasWidth: targetHeaderW,
      canvasHeight: targetHeaderH,
    });

    if (!canvasHasVisiblePixels(headerCanvas)) {
      headerCanvas = drawHeaderFallbackCanvas(targetHeaderW, pixelRatio);
    } else if (headerCanvas.width !== targetHeaderW || headerCanvas.height !== targetHeaderH) {
      headerCanvas = cropCanvas(headerCanvas, targetHeaderW, targetHeaderH, FUSION_SHARE_HEADER_BG);
    }

    mountCaptureShell(stage);
    await waitForPaint(6);

    let frameCanvas = await captureNode(stage, {
      backgroundColor: colors.panelAccent,
      canvasWidth: targetFrameW,
      canvasHeight: targetFrameH,
    });

    if (!canvasHasBezelContent(frameCanvas, pixelRatio, colors.panelAccent)) {
      let bezelCanvas = await captureNode(frame, {
        backgroundColor: colors.industrialBg,
        canvasWidth: targetBezelW,
        canvasHeight: targetBezelH,
      });
      if (bezelCanvas.width !== targetBezelW || bezelCanvas.height !== targetBezelH) {
        bezelCanvas = cropCanvas(bezelCanvas, targetBezelW, targetBezelH, colors.industrialBg);
      }

      const cloneMat = compositeFrameWithMat(bezelCanvas, pixelRatio, colors.panelAccent);
      if (!canvasHasBezelContent(cloneMat, pixelRatio, colors.panelAccent)) {
        unmountCaptureShell(stage);
        await waitForPaint(2);
        let liveCanvas = await captureNode(sourceFrame, {
          backgroundColor: colors.industrialBg,
          canvasWidth: targetBezelW,
          canvasHeight: targetBezelH,
        });
        if (liveCanvas.width !== targetBezelW || liveCanvas.height !== targetBezelH) {
          liveCanvas = cropCanvas(liveCanvas, targetBezelW, targetBezelH, colors.industrialBg);
        }
        bezelCanvas = liveCanvas;
        mountCaptureShell(stage);
        await waitForPaint(2);
      }

      frameCanvas = compositeFrameWithMat(bezelCanvas, pixelRatio, colors.panelAccent);
    }

    unmountCaptureShell(stage);

    if (frameCanvas.width !== targetFrameW || frameCanvas.height !== targetFrameH) {
      frameCanvas = cropCanvas(frameCanvas, targetFrameW, targetFrameH, colors.panelAccent);
    }

    let footerCanvas = await captureMountedShell(footerShell, {
      backgroundColor: FUSION_SHARE_FOOTER_BG,
      canvasWidth: targetFooterW,
      canvasHeight: targetFooterH,
    });

    if (footerCanvas.width !== targetFooterW || footerCanvas.height !== targetFooterH) {
      footerCanvas = cropCanvas(footerCanvas, targetFooterW, targetFooterH, FUSION_SHARE_FOOTER_BG);
    }

    const merged = mergeCanvases(headerCanvas, frameCanvas, footerCanvas, colors.cardFill);
    return await canvasToBlob(merged);
  } finally {
    restoreForecastPadding(paddingRestore);
    restorePrimedSurfaces(primedSurfaces);
    restoreCaptureChrome(hidden);
    restoreFrameOverflow(overflowRestore);
    unmountCaptureShell(headerShell);
    unmountCaptureShell(footerShell);
    unmountCaptureShell(stage);
  }
}

export async function renderFusionSharePng(meta: FusionShareMeta = {}): Promise<Blob> {
  try {
    return await renderFusionSharePngOnce(meta);
  } catch (first) {
    await waitForPaint(2);
    return await renderFusionSharePngOnce(meta);
  }
}

export async function copyFusionSharePngToClipboard(meta: FusionShareMeta = {}): Promise<void> {
  const pngPromise = renderFusionSharePng(meta);
  await writeClipboardPngPromise(pngPromise);
}

export function downloadFusionSharePng(blob: Blob, alias?: string): void {
  const slug = alias
    ? alias.replace(/[^\w.-]+/g, "_").replace(/^_|_$/g, "").slice(0, 40)
    : "fusion";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `blackwell-ops-${slug}-${stamp}.png`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function toastFusionShare(message: string, type: "success" | "error"): void {
  window.__blackopsToasts?.addToast(message, type);
}