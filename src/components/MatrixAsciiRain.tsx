/**
 * Classic Matrix falling ASCII rain (canvas).
 * Adapted from https://codepen.io/Lubnevsky/pen/poZgWmM — sized to parent,
 * palette from CSS vars so DISPLAY dark vs light/clean (and theme accents) drive
 * background + glyph shades without compositor CSS animations.
 */
import { useEffect, useRef } from "react";
import { useDisplayTexture } from "../context/DisplayTextureContext";
import { useTheme } from "../context/ThemeContext";
import { displayFaceFor, type DisplayTexture } from "../lib/displayTexture";

const CHARACTERS =
  "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'";

const DRAW_MS = 50;
const FADE_ALPHA = 0.125;

function resolveCssColor(el: HTMLElement, cssVar: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;top:0;pointer-events:none;";
  probe.style.color = `var(${cssVar}, ${fallback})`;
  el.appendChild(probe);
  const color = getComputedStyle(probe).color;
  el.removeChild(probe);
  return color || fallback;
}

function cssToRgba(cssColor: string, alpha: number): string {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return `rgba(0, 0, 0, ${alpha})`;
  probe.fillStyle = "#000";
  probe.fillStyle = cssColor.trim() || "#000";
  const normalized = probe.fillStyle;
  if (normalized.startsWith("#")) {
    const hex = normalized.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    const n = parseInt(full, 16);
    if (!Number.isFinite(n)) return `rgba(0, 0, 0, ${alpha})`;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const m = normalized.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
}

function readRainPalette(el: HTMLElement): { bg: string; fg: string; fade: string } {
  const bg = resolveCssColor(el, "--matrix-rain-bg", "#030805");
  const fg = resolveCssColor(el, "--matrix-rain-fg", "#4ade80");
  const fade = cssToRgba(bg, FADE_ALPHA);
  return { bg, fg, fade };
}

export type MatrixAsciiRainProps = {
  className?: string;
  /** Override display profile; defaults to live DisplayTexture context. */
  texture?: DisplayTexture;
  /** Opacity of the whole layer (panel sits above). */
  opacity?: number;
};

/**
 * Full-bleed canvas rain. Parent must be `position: relative` (or absolute).
 * Pauses when document hidden or element not intersecting — cheap on iGPU vs CSS loops.
 */
export default function MatrixAsciiRain({
  className = "",
  texture: textureProp,
  opacity = 1,
}: MatrixAsciiRainProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { texture: ctxTexture } = useDisplayTexture();
  const { theme } = useTheme();
  const texture = textureProp ?? ctxTexture;
  const light = displayFaceFor(theme.id, texture) !== "crt";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    let drops: number[] = [];
    let columns = 0;
    let fontSizePx = 14;
    let colStep = 14;
    let running = true;
    let visible = true;
    let timer: number | null = null;
    let palette = readRainPalette(canvas);

    const rebuildColumns = (w: number) => {
      // ~⅓ of the classic 12–18px rain (CodePen-scale) — denser field, quieter face
      fontSizePx = Math.max(4, Math.min(6, Math.round(w / 216)));
      colStep = fontSizePx + 1;
      columns = Math.max(12, Math.floor(w / colStep));
      const next: number[] = new Array(columns);
      for (let i = 0; i < columns; i++) {
        next[i] = drops[i] ?? Math.floor(Math.random() * 40);
      }
      drops = next;
    };

    const resize = () => {
      const rect = parent.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      const dpr = Math.min(1.25, window.devicePixelRatio || 1);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rebuildColumns(w);
      palette = readRainPalette(canvas);
      ctx.fillStyle = palette.bg;
      ctx.fillRect(0, 0, w, h);
    };

    const draw = () => {
      if (!running || !visible) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w < 2 || h < 2) return;

      palette = readRainPalette(canvas);
      ctx.fillStyle = palette.fade;
      ctx.fillRect(0, 0, w, h);

      ctx.fillStyle = palette.fg;
      ctx.font = `${fontSizePx}px ui-monospace, "Cascadia Mono", "Consolas", monospace`;

      for (let i = 0; i < drops.length; i++) {
        const ch = CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)]!;
        const x = i * colStep;
        const y = drops[i]! * fontSizePx;
        ctx.fillText(ch, x, y);

        if (y > h && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i]!++;
      }
    };

    const startTimer = () => {
      if (timer != null) return;
      timer = window.setInterval(draw, DRAW_MS);
    };

    const stopTimer = () => {
      if (timer == null) return;
      window.clearInterval(timer);
      timer = null;
    };

    const onVis = () => {
      if (document.visibilityState === "hidden") {
        stopTimer();
      } else if (visible && running) {
        startTimer();
      }
    };

    const ro = new ResizeObserver(() => resize());
    ro.observe(parent);
    resize();

    const io = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting);
        if (visible && document.visibilityState !== "hidden") startTimer();
        else stopTimer();
      },
      { threshold: 0.01 },
    );
    io.observe(canvas);

    document.addEventListener("visibilitychange", onVis);
    if (document.visibilityState !== "hidden") startTimer();

    return () => {
      running = false;
      stopTimer();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [texture, light]);

  return (
    <canvas
      ref={canvasRef}
      className={`matrix-ascii-rain${light ? " matrix-ascii-rain--light" : " matrix-ascii-rain--dark"}${
        className ? ` ${className}` : ""
      }`}
      data-matrix-rain
      data-display-profile={light ? "light" : "dark"}
      aria-hidden
      style={{ opacity }}
    />
  );
}
