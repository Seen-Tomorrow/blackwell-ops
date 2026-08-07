/**
 * DEV-only: inject +1 / +2 / +4 / +6 synthetic GPUs into telemetry topo
 * ("NVIDIA RTX PRO 6000 Fake edition") for layout / future forecast tests.
 * Popover portaled (header DEV stack clips overflow).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DEV_FAKE_GPU_EXTRA_OPTIONS,
  getDevFakeGpuExtra,
  setDevFakeGpuExtra,
  subscribeDevFakeGpuExtra,
  type DevFakeGpuExtra,
} from "../lib/devFakeGpuTopo";

type PopoverPos = { top: number; left: number };

export default function DevFakeGpuTopoTool() {
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState<DevFakeGpuExtra>(() => getDevFakeGpuExtra());
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeDevFakeGpuExtra(() => setExtra(getDevFakeGpuExtra())), []);

  const placePopover = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const pad = 6;
    const popW = 200;
    let left = r.right - popW;
    left = Math.max(pad, Math.min(left, window.innerWidth - popW - pad));
    const top = Math.min(r.bottom + 4, window.innerHeight - pad - 40);
    setPos({ top, left });
  }, []);

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
    const onResize = () => placePopover();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open, placePopover]);

  const pick = (n: DevFakeGpuExtra) => {
    setDevFakeGpuExtra(n);
    setOpen(false);
  };

  const btnLabel = extra > 0 ? `+${extra}G` : "GPU+";

  const popover =
    open && pos
      ? createPortal(
          <div
            ref={popoverRef}
            className="dev-fake-gpu-popover font-mono"
            role="dialog"
            aria-label="Fake GPU topology extras"
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              zIndex: 9999,
            }}
          >
            <div className="dev-fake-gpu-popover__head">
              <span className="dev-fake-gpu-popover__title">FAKE GPU TOPO</span>
            </div>
            <p className="dev-fake-gpu-popover__hint">
              +N × RTX PRO 6000 Fake edition · session only
            </p>
            <div className="dev-fake-gpu-popover__list" role="listbox">
              {DEV_FAKE_GPU_EXTRA_OPTIONS.map((n) => {
                const selected = n === extra;
                const label = n === 0 ? "OFF (real only)" : `+${n}`;
                return (
                  <button
                    key={n}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`dev-fake-gpu-popover__row${
                      selected ? " dev-fake-gpu-popover__row--active" : ""
                    }`}
                    onClick={() => pick(n)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="relative flex flex-1 min-h-0 self-stretch">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`app-header-dev-tools__btn app-chrome-control-btn w-full ${
          extra > 0
            ? "text-cyan-300 hover:text-cyan-200"
            : "text-white/45 hover:text-white/70"
        }`}
        title={
          extra > 0
            ? `DEV: +${extra} synthetic RTX PRO 6000 — click to change`
            : "DEV: inject fake GPUs (+1/+2/+4/+6) for multi-GPU layout / forecast tests"
        }
      >
        {btnLabel}
      </button>
      {popover}
    </div>
  );
}
