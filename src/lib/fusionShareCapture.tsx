import { toCanvas } from "html-to-image";
import { brandLogoMarkup } from "./brandLogos";
import type { DisplayTexture } from "./displayTexture";
import { DISPLAY_BEZEL_PADDING_PX } from "./onboardingDisplay";
import { getThemeById } from "../themes/app-themes";
import type { GpuInfo } from "./types";

export const FUSION_SHARE_FRAME_SELECTOR = "[data-fusion-share-frame]";

/** White = ARCTIC + phosphor-light; black = SLATE + phosphor-dark. */
export type FusionShareVariant = "white" | "black";

const SHARE_VARIANT_CONFIG: Record<
  FusionShareVariant,
  { themeId: string; texture: DisplayTexture }
> = {
  white: { themeId: "arctic", texture: "phosphor-light" },
  black: { themeId: "slate", texture: "phosphor-dark" },
};

export interface FusionShareLaunchConfig {
  ctx?: string | number;
  batch?: string | number;
  ubatch?: string | number;
  flashAttn?: string;
  splitMode?: string;
  kvQuant?: string;
  specType?: string;
  specDraftNMax?: string | number;
  specDraftNMin?: string | number;
}

export interface FusionShareMeta {
  providerName?: string;
  /** Engine binary build string, e.g. "v51 (ac4cdde)". */
  providerBuildVersion?: string;
  modelName?: string;
  modelQuant?: string;
  profileLabel?: string;
  cudaVersion?: string;
  /** e.g. "2xRTX PRO 6000 96GB" — GPUs the bench ran on. */
  hwTopo?: string;
  launchConfig?: FusionShareLaunchConfig;
}

/** Shorter phosphor in share cards — room for 2-row params + HW topo band. */
export const FUSION_SHARE_CAPTURE_PHOSPHOR_HEIGHT_PX = 208;
export const FUSION_SHARE_EXPORT_HW_TOPO_HEIGHT = 22;

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
 * 1. Dark header (provider · profile · model · params).
 * 2. Gap + frame (live phosphor + bezel height).
 * 3. Footer (logo + version) pinned to bottom of frame.
 * 4. Width derived from total height so the full card stays 16:9.
 */
const SHARE_ASPECT_W = 16;
const SHARE_ASPECT_H = 9;
export const FUSION_SHARE_EXPORT_GAP = 8;
/** Panel-accent mat around the bezel in share captures (CSS px). */
export const FUSION_SHARE_EXPORT_FRAME_PAD_TOP = 0;
export const FUSION_SHARE_EXPORT_FRAME_PAD_X = 20;
export const FUSION_SHARE_EXPORT_FRAME_PAD_BOTTOM = 14;
/** Gunmetal bezel block height (capture phosphor + frame padding). */
export const FUSION_SHARE_EXPORT_BEZEL_HEIGHT_PX =
  FUSION_SHARE_CAPTURE_PHOSPHOR_HEIGHT_PX + DISPLAY_BEZEL_PADDING_PX * 2;
/** Middle card section — bezel + HW topo band inside panel-accent mat. */
export const FUSION_SHARE_EXPORT_FRAME_HEIGHT =
  FUSION_SHARE_EXPORT_BEZEL_HEIGHT_PX +
  FUSION_SHARE_EXPORT_FRAME_PAD_TOP +
  FUSION_SHARE_EXPORT_HW_TOPO_HEIGHT +
  FUSION_SHARE_EXPORT_FRAME_PAD_BOTTOM;
export const FUSION_SHARE_EXPORT_FOOTER_HEIGHT = 27;
/** Identity row + up to two params chip rows. */
export const FUSION_SHARE_EXPORT_HEADER_HEIGHT = 94;
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
/** Identity row only — params row uses industrial panel-accent band. */
const FUSION_SHARE_IDENTITY_BG = "#0a0c10";
const FUSION_SHARE_IDENTITY_TEXT = "#f4f6f8";
const FUSION_SHARE_IDENTITY_MUTED = "rgba(244, 246, 248, 0.42)";
const FUSION_SHARE_IDENTITY_DIVIDER = "rgba(244, 246, 248, 0.28)";
const FUSION_SHARE_CYAN = "#00e5ff";
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

interface ParamsRowPalette {
  muted: string;
  divider: string;
  border: string;
  boxBg: string;
}

interface CaptureColors {
  /** Brand header bar */
  brandBar: string;
  /** `.industrial-display-area` brushed panel behind bezel */
  panelAccent: string;
  /** Params row — panel-accent → theme-bg (matches display surround). */
  paramsBandBg: string;
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

function themeToken(themeId: string, name: string, fallback: string): string {
  const theme = getThemeById(themeId);
  return theme.tokens[name] ?? fallback;
}

function resolveCaptureColors(variant: FusionShareVariant = "white"): CaptureColors {
  const { themeId } = SHARE_VARIANT_CONFIG[variant];
  const industrialBg = themeToken(themeId, "--theme-industrial-bg", "#b0bcc8");
  const panelAccent = themeToken(themeId, "--theme-panel-accent", "#dce2ea");
  const themeBg = themeToken(themeId, "--theme-bg", "#e8ecef");
  return {
    brandBar: themeToken(themeId, "--theme-panel", "#f4f6f8"),
    panelAccent,
    paramsBandBg: `linear-gradient(180deg, ${panelAccent} 0%, ${themeBg} 100%)`,
    industrialBg,
    cardFill: panelAccent,
    title: themeToken(themeId, "--theme-header-title", "#1a2030"),
    subtitle: themeToken(themeId, "--theme-header-subtitle", "rgba(26, 32, 48, 0.45)"),
    logo: themeToken(themeId, "--theme-header-logo", "#2a6b4a"),
    accent: themeToken(themeId, "--theme-accent-bright", "#1a5a3a"),
    accentSoft: themeToken(themeId, "--theme-chip-active-bg", "rgba(42, 107, 74, 0.16)"),
    border: themeToken(themeId, "--theme-border-subtle", "rgba(30, 50, 80, 0.12)"),
    divider: themeToken(themeId, "--theme-border", "#b8c4d0"),
  };
}

function applyShareCaptureTheme(host: HTMLElement, variant: FusionShareVariant): void {
  const { themeId, texture } = SHARE_VARIANT_CONFIG[variant];
  host.setAttribute("data-theme", themeId);
  host.setAttribute("data-display-texture", texture);
  host.setAttribute("data-fusion-share-variant", variant);
  const theme = getThemeById(themeId);
  for (const [key, value] of Object.entries(theme.tokens)) {
    host.style.setProperty(key, value);
  }
}

interface DocumentThemeLock {
  restore: () => void;
}

/** Force ARCTIC/SLATE on :root during rasterize — document texture leaks into clones otherwise. */
function lockDocumentThemeForCapture(variant: FusionShareVariant): DocumentThemeLock {
  const root = document.documentElement;
  const { themeId, texture } = SHARE_VARIANT_CONFIG[variant];
  const theme = getThemeById(themeId);
  const prevTheme = root.getAttribute("data-theme");
  const prevTexture = root.getAttribute("data-display-texture");
  const prevInline = new Map<string, string>();
  for (const key of Object.keys(theme.tokens)) {
    prevInline.set(key, root.style.getPropertyValue(key));
  }

  root.setAttribute("data-theme", themeId);
  root.setAttribute("data-display-texture", texture);
  for (const [key, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(key, value);
  }

  return {
    restore: () => {
      if (prevTheme != null) root.setAttribute("data-theme", prevTheme);
      else root.removeAttribute("data-theme");
      if (prevTexture != null) root.setAttribute("data-display-texture", prevTexture);
      else root.removeAttribute("data-display-texture");
      for (const [key, prev] of prevInline) {
        if (prev) root.style.setProperty(key, prev);
        else root.style.removeProperty(key);
      }
    },
  };
}

export function formatShareHwTopo(gpus: GpuInfo[], gpuMask?: string): string | undefined {
  if (gpus.length === 0) return undefined;

  const indices = gpuMask?.trim()
    ? gpuMask
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n))
    : gpus.map((g) => g.index);

  const selected = indices
    .map((i) => gpus.find((g) => g.index === i))
    .filter((g): g is GpuInfo => g != null);
  if (selected.length === 0) return undefined;

  const groups = new Map<string, { count: number; label: string }>();
  for (const gpu of selected) {
    const vramGb = Math.round((gpu.memory_total_manufactured || gpu.memory_total) / 1024);
    const shortName = gpu.name.replace(/^NVIDIA\s+/i, "").trim();
    const key = `${shortName}|${vramGb}`;
    const entry = groups.get(key);
    if (entry) entry.count += 1;
    else groups.set(key, { count: 1, label: `${shortName} ${vramGb}GB` });
  }

  return Array.from(groups.values())
    .map((g) => (g.count > 1 ? `${g.count}x${g.label}` : g.label))
    .join(" · ");
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

function brandDivider(color: string): HTMLSpanElement {
  const divider = document.createElement("span");
  divider.textContent = "│";
  divider.style.flexShrink = "0";
  divider.style.color = color;
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
  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "0") return null;
  return `split ${normalized}`;
}

function formatShareKvQuant(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  return `KV ${value.trim().toUpperCase()}`;
}

function formatShareSpecType(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  return `SPEC-TYPE ${value.trim().toUpperCase()}`;
}

function formatShareSpecDraftNMax(value: string | number | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  return `DRAFT-N-MAX ${value}`;
}

function formatShareSpecDraftNMin(value: string | number | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === 0 || value === "0") return null;
  return `DRAFT-N-MIN ${value}`;
}

type ParamChipKind = "config" | "split";

interface ParamChip {
  text: string;
  kind: ParamChipKind;
}

function brandConfigLabel(text: string, mutedColor: string): HTMLSpanElement {
  const label = document.createElement("span");
  label.textContent = text;
  label.style.fontFamily = "monospace";
  label.style.fontSize = "9px";
  label.style.fontWeight = "400";
  label.style.letterSpacing = "0.04em";
  label.style.color = mutedColor;
  label.style.opacity = "1";
  label.style.whiteSpace = "nowrap";
  label.style.flexShrink = "0";
  label.style.lineHeight = "1.2";
  return label;
}

function brandBadgeLabel(text: string, color: string, bgAlpha = 0.14): HTMLSpanElement {
  const label = document.createElement("span");
  label.textContent = text;
  label.style.fontFamily = "monospace";
  label.style.fontSize = "10px";
  label.style.fontWeight = "700";
  label.style.letterSpacing = "0.05em";
  label.style.color = color;
  label.style.background = color.startsWith("#")
    ? `rgba(${Number.parseInt(color.slice(1, 3), 16)}, ${Number.parseInt(color.slice(3, 5), 16)}, ${Number.parseInt(color.slice(5, 7), 16)}, ${bgAlpha})`
    : color;
  label.style.border = `1px solid ${color}`;
  label.style.borderRadius = "4px";
  label.style.padding = "2px 7px";
  label.style.whiteSpace = "nowrap";
  label.style.flexShrink = "0";
  label.style.lineHeight = "1.2";
  return label;
}

function brandKvQuantLabel(text: string): HTMLSpanElement {
  return brandBadgeLabel(text, NV_GREEN, 0.14);
}

function brandModelQuantLabel(text: string): HTMLSpanElement {
  return brandBadgeLabel(text, FUSION_SHARE_CYAN, 0.12);
}

function brandSplitLabel(text: string, variant: FusionShareVariant): HTMLSpanElement {
  const label = document.createElement("span");
  label.textContent = text;
  label.style.fontFamily = "monospace";
  label.style.fontSize = "9px";
  label.style.fontWeight = "700";
  label.style.letterSpacing = "0.04em";
  label.style.borderRadius = "4px";
  label.style.padding = "2px 7px";
  label.style.whiteSpace = "nowrap";
  label.style.flexShrink = "0";
  label.style.lineHeight = "1.2";
  if (variant === "white") {
    label.style.background = "#0a0c10";
    label.style.color = "#f4f6f8";
    label.style.border = "1px solid #0a0c10";
  } else {
    label.style.background = "#f5c400";
    label.style.color = "#0a0c10";
    label.style.border = "1px solid #b89200";
  }
  return label;
}

function collectShareLaunchConfigRow1(launchConfig: FusionShareLaunchConfig | undefined): ParamChip[] {
  if (!launchConfig) return [];

  const chips: ParamChip[] = [];
  const ctx = formatShareCtx(launchConfig.ctx);
  if (ctx) chips.push({ text: `CTX ${ctx}`, kind: "config" });

  const batchPair = formatShareBatchPair(launchConfig.batch, launchConfig.ubatch);
  if (batchPair) chips.push({ text: batchPair, kind: "config" });

  const flashAttn = formatShareFlashAttn(launchConfig.flashAttn);
  if (flashAttn) chips.push({ text: flashAttn, kind: "config" });

  const splitMode = formatShareSplitMode(launchConfig.splitMode);
  if (splitMode) chips.push({ text: splitMode, kind: "split" });

  return chips;
}

function collectShareLaunchConfigRow2(launchConfig: FusionShareLaunchConfig | undefined): ParamChip[] {
  if (!launchConfig) return [];

  const chips: ParamChip[] = [];
  const specType = formatShareSpecType(launchConfig.specType);
  if (specType) chips.push({ text: specType, kind: "config" });

  const specDraftNMax = formatShareSpecDraftNMax(launchConfig.specDraftNMax);
  if (specDraftNMax) chips.push({ text: specDraftNMax, kind: "config" });

  const specDraftNMin = formatShareSpecDraftNMin(launchConfig.specDraftNMin);
  if (specDraftNMin) chips.push({ text: specDraftNMin, kind: "config" });

  return chips;
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

function appendParamChips(
  parent: HTMLElement,
  chips: ParamChip[],
  palette: ParamsRowPalette,
  variant: FusionShareVariant,
  kvQuant?: string | null,
): void {
  let hasContent = false;
  if (kvQuant) {
    parent.appendChild(brandKvQuantLabel(kvQuant));
    hasContent = true;
  }
  chips.forEach((chip) => {
    if (hasContent) parent.appendChild(brandDivider(palette.divider));
    if (chip.kind === "split") {
      parent.appendChild(brandSplitLabel(chip.text, variant));
    } else {
      parent.appendChild(brandConfigLabel(chip.text, palette.muted));
    }
    hasContent = true;
  });
}

function createParamsChipRow(
  chips: ParamChip[],
  palette: ParamsRowPalette,
  variant: FusionShareVariant,
  kvQuant?: string | null,
): HTMLElement | null {
  if (!kvQuant && chips.length === 0) return null;

  const box = document.createElement("div");
  box.style.display = "inline-flex";
  box.style.alignItems = "center";
  box.style.flexWrap = "nowrap";
  box.style.gap = "6px";
  box.style.padding = "4px 10px";
  box.style.border = `1px solid ${palette.border}`;
  box.style.borderRadius = "6px";
  box.style.maxWidth = "100%";
  box.style.overflow = "hidden";
  box.style.background = palette.boxBg;
  appendParamChips(box, chips, palette, variant, kvQuant);
  return box;
}

function createLaunchParamsSection(
  launchConfig: FusionShareLaunchConfig | undefined,
  palette: ParamsRowPalette,
  variant: FusionShareVariant,
): HTMLElement | null {
  const kvQuant = formatShareKvQuant(launchConfig?.kvQuant);
  const row1Chips = collectShareLaunchConfigRow1(launchConfig);
  const row2Chips = collectShareLaunchConfigRow2(launchConfig);
  const row1 = createParamsChipRow(row1Chips, palette, variant, kvQuant);
  const row2 = row2Chips.length > 0 ? createParamsChipRow(row2Chips, palette, variant) : null;
  if (!row1 && !row2) return null;

  const section = document.createElement("div");
  section.style.display = "flex";
  section.style.flexDirection = "column";
  section.style.gap = "3px";
  section.style.width = "100%";
  section.style.minWidth = "0";
  if (row1) section.appendChild(row1);
  if (row2) section.appendChild(row2);
  return section;
}

function createHwTopoBand(
  text: string,
  colors: CaptureColors,
  width: number,
): HTMLElement {
  const band = document.createElement("div");
  band.className = "fusion-share-hw-topo-band";
  band.style.width = `${width}px`;
  band.style.height = `${FUSION_SHARE_EXPORT_HW_TOPO_HEIGHT}px`;
  band.style.display = "flex";
  band.style.alignItems = "center";
  band.style.marginTop = "6px";
  band.style.padding = "0 2px";
  band.style.boxSizing = "border-box";
  band.style.overflow = "hidden";

  const label = document.createElement("span");
  label.textContent = text;
  label.style.fontFamily = "'JetBrains Mono', 'Roboto Mono', monospace";
  label.style.fontSize = "8px";
  label.style.fontWeight = "600";
  label.style.letterSpacing = "0.05em";
  label.style.color = colors.subtitle;
  label.style.webkitTextFillColor = colors.subtitle;
  label.style.lineHeight = "1.2";
  label.style.whiteSpace = "nowrap";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.flex = "1";
  label.style.minWidth = "0";
  band.appendChild(label);
  return band;
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
function createFrameCaptureStage(
  source: HTMLElement,
  colors: CaptureColors,
  variant: FusionShareVariant,
  hwTopo?: string,
): FrameCaptureStage {
  const padTop = FUSION_SHARE_EXPORT_FRAME_PAD_TOP;
  const padX = FUSION_SHARE_EXPORT_FRAME_PAD_X;
  const padBottom = FUSION_SHARE_EXPORT_FRAME_PAD_BOTTOM;
  const bezelHeight = FUSION_SHARE_EXPORT_BEZEL_HEIGHT_PX;
  const innerWidth = FUSION_SHARE_EXPORT_WIDTH - padX * 2;

  const stage = document.createElement("div");
  stage.className = "fusion-share-capture-stage";
  stage.setAttribute("data-fusion-share-capture", "");
  stage.setAttribute("data-fusion-share-exclude", "");
  applyShareCaptureTheme(stage, variant);
  stage.style.setProperty("--ui-text-scale", "1");
  stage.style.width = `${FUSION_SHARE_EXPORT_WIDTH}px`;
  stage.style.height = `${FUSION_SHARE_EXPORT_FRAME_HEIGHT}px`;
  stage.style.padding = `${padTop}px ${padX}px ${padBottom}px ${padX}px`;
  stage.style.background = colors.panelAccent;
  stage.style.display = "block";
  stage.style.overflow = "visible";
  stage.style.boxSizing = "border-box";

  const frame = source.cloneNode(true) as HTMLElement;
  applyShareCaptureTheme(frame, variant);
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
  const topoText = hwTopo?.trim();
  if (topoText) {
    stage.appendChild(createHwTopoBand(topoText, colors, innerWidth));
  }
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
const FUSION_CAPTURE_HERO_FONT_PX = 40;

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
    display.style.height = `${FUSION_SHARE_CAPTURE_PHOSPHOR_HEIGHT_PX}px`;
    display.style.minHeight = `${FUSION_SHARE_CAPTURE_PHOSPHOR_HEIGHT_PX}px`;
    display.style.maxHeight = `${FUSION_SHARE_CAPTURE_PHOSPHOR_HEIGHT_PX}px`;
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
  label.style.color = FUSION_SHARE_IDENTITY_TEXT;
  label.style.webkitTextFillColor = FUSION_SHARE_IDENTITY_TEXT;
  label.style.lineHeight = "1.2";
  label.style.flexShrink = "0";
  label.style.whiteSpace = "nowrap";
  return label;
}

function brandMutedCaption(text: string, mutedColor = FUSION_SHARE_IDENTITY_MUTED): HTMLSpanElement {
  const label = document.createElement("span");
  label.textContent = text;
  label.style.fontFamily = "monospace";
  label.style.fontSize = "8px";
  label.style.fontWeight = "500";
  label.style.letterSpacing = "0.04em";
  label.style.color = mutedColor;
  label.style.webkitTextFillColor = mutedColor;
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

function createHeaderShell(meta: FusionShareMeta, variant: FusionShareVariant): HTMLElement {
  const colors = resolveCaptureColors(variant);
  const paramsPalette: ParamsRowPalette = {
    muted: colors.subtitle,
    divider: colors.divider,
    border: colors.border,
    boxBg: variant === "white" ? "rgba(255, 255, 255, 0.28)" : "rgba(255, 255, 255, 0.06)",
  };
  const paramsSection = createLaunchParamsSection(meta.launchConfig, paramsPalette, variant);

  const shell = document.createElement("div");
  shell.className = "fusion-share-capture-brand-shell";
  shell.setAttribute("data-fusion-share-exclude", "");
  shell.setAttribute("data-fusion-share-capture", "");
  applyShareCaptureTheme(shell, variant);
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
  shell.style.background = paramsSection ? colors.panelAccent : FUSION_SHARE_IDENTITY_BG;
  shell.style.overflow = "hidden";
  shell.style.borderBottom = `1px solid ${colors.border}`;

  const providerName = meta.providerName?.trim();
  const providerBuildVersion = meta.providerBuildVersion?.trim();
  const profileLabel = meta.profileLabel?.trim();
  const cudaVersion = meta.cudaVersion?.trim();
  const modelName = meta.modelName?.trim();
  const modelQuant = meta.modelQuant?.trim();
  const hasIdentityLine =
    providerName || providerBuildVersion || profileLabel || cudaVersion || modelName || modelQuant;

  if (hasIdentityLine) {
    const identityRow = document.createElement("div");
    identityRow.style.display = "flex";
    identityRow.style.alignItems = "center";
    identityRow.style.gap = "8px";
    identityRow.style.minWidth = "0";
    identityRow.style.width = "100%";
    identityRow.style.overflow = "hidden";
    identityRow.style.whiteSpace = "nowrap";
    identityRow.style.background = FUSION_SHARE_IDENTITY_BG;
    identityRow.style.color = FUSION_SHARE_IDENTITY_TEXT;
    identityRow.style.flex = paramsSection ? "0 0 auto" : "1";
    identityRow.style.padding = paramsSection ? "6px 12px 5px" : "6px 12px";
    identityRow.style.boxSizing = "border-box";

    if (providerName) {
      identityRow.appendChild(brandIdentityLabel(providerName));
      if (providerBuildVersion) {
        identityRow.appendChild(brandMutedCaption(providerBuildVersion));
      }
    } else if (providerBuildVersion) {
      identityRow.appendChild(brandMutedCaption(providerBuildVersion));
    }
    if (profileLabel) {
      if (providerName || providerBuildVersion) {
        identityRow.appendChild(brandDivider(FUSION_SHARE_IDENTITY_DIVIDER));
      }
      identityRow.appendChild(brandIdentityLabel(profileLabel));
    }
    if (cudaVersion) {
      identityRow.appendChild(brandCudaBadge(cudaVersion));
    }

    if (modelName || modelQuant) {
      if (providerName || providerBuildVersion || profileLabel || cudaVersion) {
        identityRow.appendChild(brandDivider(FUSION_SHARE_IDENTITY_DIVIDER));
      }

      if (modelName) {
        const modelLine = document.createElement("span");
        modelLine.textContent = modelName;
        modelLine.style.fontFamily = "monospace";
        modelLine.style.fontSize = "11px";
        modelLine.style.fontWeight = "600";
        modelLine.style.color = FUSION_SHARE_IDENTITY_TEXT;
        modelLine.style.webkitTextFillColor = FUSION_SHARE_IDENTITY_TEXT;
        modelLine.style.lineHeight = "1.2";
        modelLine.style.flex = "1";
        modelLine.style.minWidth = "0";
        modelLine.style.overflow = "hidden";
        modelLine.style.textOverflow = "ellipsis";
        modelLine.style.whiteSpace = "nowrap";
        identityRow.appendChild(modelLine);
      }

      if (modelQuant) {
        identityRow.appendChild(brandModelQuantLabel(modelQuant));
      }
    }

    shell.appendChild(identityRow);
  }

  if (paramsSection) {
    const paramsRow = document.createElement("div");
    paramsRow.style.flex = "1";
    paramsRow.style.display = "flex";
    paramsRow.style.alignItems = "flex-start";
    paramsRow.style.minWidth = "0";
    paramsRow.style.width = "100%";
    paramsRow.style.padding = "4px 12px 5px";
    paramsRow.style.boxSizing = "border-box";
    paramsRow.style.overflow = "hidden";
    paramsRow.style.background = colors.paramsBandBg;
    paramsSection.style.maxWidth = "100%";
    paramsSection.style.flexShrink = "1";
    paramsSection.style.minWidth = "0";
    paramsRow.appendChild(paramsSection);
    shell.appendChild(paramsRow);
  }

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

  ctx.fillStyle = FUSION_SHARE_IDENTITY_BG;
  ctx.fillRect(0, 0, width, canvas.height);
  ctx.fillStyle = FUSION_SHARE_IDENTITY_TEXT;
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

async function renderFusionSharePngOnce(
  meta: FusionShareMeta,
  variant: FusionShareVariant = "white",
): Promise<Blob> {
  const sourceFrame = document.querySelector(FUSION_SHARE_FRAME_SELECTOR);
  if (!(sourceFrame instanceof HTMLElement)) {
    throw new Error("VRAM display frame not found");
  }

  const rect = sourceFrame.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    throw new Error("VRAM display frame is not visible");
  }

  const colors = resolveCaptureColors(variant);
  const pixelRatio = FUSION_SHARE_EXPORT_PIXEL_RATIO;
  const targetFrameW = FUSION_SHARE_EXPORT_WIDTH * pixelRatio;
  const targetFrameH = FUSION_SHARE_EXPORT_FRAME_HEIGHT * pixelRatio;
  const targetHeaderW = FUSION_SHARE_EXPORT_WIDTH * pixelRatio;
  const targetHeaderH = FUSION_SHARE_EXPORT_HEADER_HEIGHT * pixelRatio;
  const targetFooterW = FUSION_SHARE_EXPORT_WIDTH * pixelRatio;
  const targetFooterH = FUSION_SHARE_EXPORT_FOOTER_HEIGHT * pixelRatio;

  const themeLock = lockDocumentThemeForCapture(variant);
  const { stage, frame } = createFrameCaptureStage(sourceFrame, colors, variant, meta.hwTopo);
  const headerShell = createHeaderShell(meta, variant);
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
      backgroundColor: colors.panelAccent,
      canvasWidth: targetHeaderW,
      canvasHeight: targetHeaderH,
    });

    if (!canvasHasVisiblePixels(headerCanvas)) {
      headerCanvas = drawHeaderFallbackCanvas(targetHeaderW, pixelRatio);
    } else if (headerCanvas.width !== targetHeaderW || headerCanvas.height !== targetHeaderH) {
      headerCanvas = cropCanvas(headerCanvas, targetHeaderW, targetHeaderH, colors.panelAccent);
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
    themeLock.restore();
    restoreForecastPadding(paddingRestore);
    restorePrimedSurfaces(primedSurfaces);
    restoreCaptureChrome(hidden);
    restoreFrameOverflow(overflowRestore);
    unmountCaptureShell(headerShell);
    unmountCaptureShell(footerShell);
    unmountCaptureShell(stage);
  }
}

export async function renderFusionSharePng(
  meta: FusionShareMeta = {},
  variant: FusionShareVariant = "white",
): Promise<Blob> {
  try {
    return await renderFusionSharePngOnce(meta, variant);
  } catch (first) {
    await waitForPaint(2);
    return await renderFusionSharePngOnce(meta, variant);
  }
}

export async function copyFusionSharePngToClipboard(
  meta: FusionShareMeta = {},
  variant: FusionShareVariant = "white",
): Promise<void> {
  const pngPromise = renderFusionSharePng(meta, variant);
  await writeClipboardPngPromise(pngPromise);
}

export function downloadFusionSharePng(
  blob: Blob,
  alias?: string,
  variant: FusionShareVariant = "white",
): void {
  const slug = alias
    ? alias.replace(/[^\w.-]+/g, "_").replace(/^_|_$/g, "").slice(0, 40)
    : "fusion";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `blackwell-ops-${slug}-${variant}-${stamp}.png`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function toastFusionShare(message: string, type: "success" | "error"): void {
  window.__blackopsToasts?.addToast(message, type);
}