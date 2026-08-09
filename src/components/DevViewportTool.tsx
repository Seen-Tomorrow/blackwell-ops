/**
 * DEV-only: preset viewport sizes for layout checks.
 *
 * Presets are **physical** panel sizes (what users call 1080p / 4K).
 * Applied via Tauri PhysicalSize so on-glass size is independent of Windows
 * display scale (100% / 125% / 150%…). CSS / shell then see
 * logical = physical ÷ scaleFactor — the real density that user gets.
 *
 * App zoom (--ui-text-scale) is separate: leave at 100% while using this tool
 * so you don't double-scale on top of Windows DPI.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type DevViewportBand = "marginal" | "ok" | "ideal";

export type DevViewportPreset = {
  id: string;
  /** Short chip label (e.g. 1920). */
  label: string;
  /** Physical width (device pixels on glass). */
  width: number;
  /** Physical height (device pixels on glass). */
  height: number;
  /** Aspect ratio. */
  blurb: string;
  /** Product floor: &lt;1080 unsupported (not listed); 1080 marginal; 1440+ ok; 4K ideal. */
  band: DevViewportBand;
};

/**
 * Physical desktop sizes worth testing.
 * Unsupported (&lt;1080p) omitted — product floor is 1080 marginal / 1440 recommended.
 */
export const DEV_VIEWPORT_PRESETS: DevViewportPreset[] = [
  { id: "fhd", label: "1920", width: 1920, height: 1080, blurb: "16:9", band: "marginal" },
  { id: "1600", label: "1600", width: 1600, height: 900, blurb: "16:9", band: "marginal" },
  { id: "1440w", label: "1440", width: 1440, height: 900, blurb: "16:10", band: "marginal" },
  { id: "qhd", label: "2560", width: 2560, height: 1440, blurb: "16:9", band: "ok" },
  { id: "uw", label: "3440", width: 3440, height: 1440, blurb: "21:9", band: "ok" },
  { id: "4k", label: "3840", width: 3840, height: 2160, blurb: "16:9", band: "ideal" },
];

type PxSize = { width: number; height: number };

type LiveMetrics = {
  /** Physical window (device px) — matches preset target. */
  physical: PxSize;
  /** Logical / CSS (≈ physical ÷ scale) — what layout uses. */
  logical: PxSize;
  /** Windows display scale (1 = 100%, 1.5 = 150%). */
  scale: number;
};

async function readLiveMetrics(): Promise<LiveMetrics | null> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const size = await win.innerSize(); // physical
    const scale = await win.scaleFactor();
    const physical = {
      width: Math.round(size.width),
      height: Math.round(size.height),
    };
    return {
      physical,
      logical: {
        width: Math.round(size.width / scale),
        height: Math.round(size.height / scale),
      },
      scale,
    };
  } catch {
    // Browser / non-Tauri fallback — treat CSS as both.
    const w = Math.round(window.innerWidth);
    const h = Math.round(window.innerHeight);
    const scale = window.devicePixelRatio || 1;
    return {
      physical: { width: Math.round(w * scale), height: Math.round(h * scale) },
      logical: { width: w, height: h },
      scale,
    };
  }
}

/** Set window to exact on-glass size (device pixels). DPI does not change the footprint. */
async function applyWindowPhysicalSize(width: number, height: number): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const { PhysicalSize } = await import("@tauri-apps/api/dpi");
    await getCurrentWindow().setSize(new PhysicalSize(width, height));
  } catch (err) {
    console.warn("[DevViewportTool] setSize failed:", err);
    throw err;
  }
}

type PopoverPos = { top: number; left: number };

function formatScale(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/**
 * Compact DEV control for the header stack (SETUP / CLR / FAKE / VIEW).
 * Popover is portaled to document.body — parent `.app-header-dev-tools` clips overflow.
 */
export default function DevViewportTool() {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveMetrics | null>(null);
  const [pos, setPos] = useState<PopoverPos | null>(null);
  /** Physical size before first preset this session. */
  const nativeRef = useRef<PxSize | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const refreshLive = useCallback(async () => {
    const m = await readLiveMetrics();
    if (m) setLive(m);
  }, []);

  const placePopover = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const pad = 6;
    const popW = 280;
    const estH = Math.min(window.innerHeight * 0.7, 480);
    let left = r.right - popW;
    left = Math.max(pad, Math.min(left, window.innerWidth - popW - pad));
    let top = r.bottom + 4;
    if (top + estH > window.innerHeight - pad && r.top - 4 - estH >= pad) {
      top = Math.max(pad, r.top - 4 - estH);
    } else {
      top = Math.min(top, window.innerHeight - pad - 80);
    }
    setPos({ top, left });
  }, []);

  useEffect(() => {
    void refreshLive();
    const onResize = () => {
      void refreshLive();
      if (open) placePopover();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [refreshLive, open, placePopover]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    placePopover();
  }, [open, placePopover]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const applyPreset = useCallback(async (preset: DevViewportPreset | "native") => {
    setBusy(true);
    setError(null);
    try {
      if (preset === "native") {
        const n = nativeRef.current;
        if (n) {
          await applyWindowPhysicalSize(n.width, n.height);
        }
        setActiveId(null);
        nativeRef.current = null;
        setOpen(false);
        return;
      }

      if (!nativeRef.current) {
        const m = await readLiveMetrics();
        if (m) nativeRef.current = m.physical;
      }
      // Physical = named panel size on glass (4K → half of 7680×2160 @ any DPI).
      await applyWindowPhysicalSize(preset.width, preset.height);
      setActiveId(preset.id);
      setOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      console.error("[DevViewportTool] apply failed:", err);
    } finally {
      setBusy(false);
      void refreshLive();
    }
  }, [refreshLive]);

  const active = DEV_VIEWPORT_PRESETS.find((p) => p.id === activeId) ?? null;
  const btnLabel = active ? active.label : "VIEW";

  const scaleLabel = live ? formatScale(live.scale) : "—";
  const livePhys = live
    ? `${live.physical.width}×${live.physical.height}`
    : "—";
  const liveLog = live
    ? `${live.logical.width}×${live.logical.height}`
    : "—";

  const popover =
    open && pos
      ? createPortal(
          <div
            ref={popoverRef}
            className="dev-viewport-popover font-mono"
            role="dialog"
            aria-label="Viewport presets"
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              zIndex: 9999,
            }}
          >
            <div className="dev-viewport-popover__head">
              <span className="dev-viewport-popover__title">VIEWPORT</span>
              <span
                className="dev-viewport-popover__live"
                title="Windows display scale (live)"
              >
                scale {scaleLabel}
              </span>
            </div>
            <p className="dev-viewport-popover__hint">
              Physical on glass · CSS = phys ÷ scale · app zoom 100% for tests.
              Floor: 1080 marginal · 1440+ recommended · &lt;1080 not listed.
            </p>
            <p className="dev-viewport-popover__hint dev-viewport-popover__hint--metrics">
              now phys {livePhys} · CSS {liveLog}
            </p>
            <div className="dev-viewport-popover__list" role="listbox">
              {DEV_VIEWPORT_PRESETS.map((p) => {
                const selected = p.id === activeId;
                const cssW = live ? Math.round(p.width / live.scale) : p.width;
                const cssH = live ? Math.round(p.height / live.scale) : p.height;
                const bandLabel =
                  p.band === "ideal" ? "ideal" : p.band === "ok" ? "ok" : "marginal";
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={busy}
                    className={`dev-viewport-popover__row dev-viewport-popover__row--${p.band}${
                      selected ? " dev-viewport-popover__row--active" : ""
                    }`}
                    onClick={() => {
                      void applyPreset(p);
                    }}
                    title={`Physical ${p.width}×${p.height} → CSS ~${cssW}×${cssH} @ ${scaleLabel} · ${bandLabel}`}
                  >
                    <span className="dev-viewport-popover__size">
                      {p.width}×{p.height}
                      <span className="dev-viewport-popover__aspect"> · {p.blurb}</span>
                      <span className={`dev-viewport-popover__band dev-viewport-popover__band--${p.band}`}>
                        {" "}
                        · {bandLabel}
                      </span>
                    </span>
                    <span className="dev-viewport-popover__blurb">
                      CSS ~{cssW}×{cssH} @ {scaleLabel}
                    </span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              disabled={busy || !nativeRef.current}
              className="dev-viewport-popover__native"
              onClick={() => {
                void applyPreset("native");
              }}
              title={
                nativeRef.current
                  ? `Restore physical ${nativeRef.current.width}×${nativeRef.current.height}`
                  : "No preset applied yet — nothing to restore"
              }
            >
              NATIVE
              {nativeRef.current
                ? ` · ${nativeRef.current.width}×${nativeRef.current.height} phys`
                : " · —"}
            </button>
            {error ? <p className="dev-viewport-popover__error">{error}</p> : null}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="relative flex flex-shrink-0 self-stretch">
      <button
        ref={btnRef}
        type="button"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        className={`app-header-dev-tools__btn app-chrome-control-btn w-auto ${
          active
            ? "text-cyan-300 hover:text-cyan-200"
            : "text-white/45 hover:text-white/70"
        }`}
        title={
          active
            ? `Physical ${active.width}×${active.height} — click for list / NATIVE (app zoom 100% recommended)`
            : "DEV: physical viewport presets (on-glass size; Windows scale applied to CSS)"
        }
      >
        {busy ? "…" : btnLabel}
      </button>
      {popover}
    </div>
  );
}
