/**
 * DEV-only: configurable fake multi-GPU topo (real SKU names + VRAM).
 * Modal grid: set counts per card (e.g. 4× RTX 5090 32G). Session only.
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  DEV_FAKE_GPU_CATALOG,
  DEV_FAKE_GPU_COUNT_MAX,
  clearDevFakeGpus,
  getDevFakeGpuPlan,
  setDevFakeGpuPlan,
  subscribeDevFakeGpuExtra,
  type DevFakeGpuPlan,
} from "../lib/devFakeGpuTopo";

function planSnapshot(): DevFakeGpuPlan {
  return getDevFakeGpuPlan();
}

export default function DevFakeGpuTopoTool() {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<DevFakeGpuPlan>(planSnapshot);
  const [draft, setDraft] = useState<DevFakeGpuPlan>(planSnapshot);
  const total = Object.values(plan).reduce((s, n) => s + (n || 0), 0);

  useEffect(() => {
    return subscribeDevFakeGpuExtra(() => setPlan(planSnapshot()));
  }, []);

  useEffect(() => {
    if (!open) return;
    setDraft(planSnapshot());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const bump = useCallback((id: string, delta: number) => {
    setDraft((prev) => {
      const cur = Math.max(0, Math.floor(Number(prev[id]) || 0));
      const next = Math.max(0, Math.min(DEV_FAKE_GPU_COUNT_MAX, cur + delta));
      return { ...prev, [id]: next };
    });
  }, []);

  const apply = useCallback(() => {
    setDevFakeGpuPlan(draft);
    setPlan(planSnapshot());
    setOpen(false);
  }, [draft]);

  const clear = useCallback(() => {
    clearDevFakeGpus();
    setDraft({});
    setPlan({});
    setOpen(false);
  }, []);

  const draftTotal = Object.values(draft).reduce((s, n) => s + (n || 0), 0);
  const btnLabel = total > 0 ? `+${total}G` : "GPU+";

  const modal = open
    ? createPortal(
        <div
          className="dev-fake-gpu-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            className="dev-fake-gpu-modal font-mono"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dev-fake-gpu-title"
          >
            <div className="dev-fake-gpu-modal__head">
              <h3 id="dev-fake-gpu-title" className="dev-fake-gpu-modal__title">
                FAKE GPU TOPO
              </h3>
              <p className="dev-fake-gpu-modal__hint">
                Real product names + VRAM · append after NVML · session only · layout / forecast
              </p>
            </div>

            <div className="dev-fake-gpu-modal__grid">
              {DEV_FAKE_GPU_CATALOG.map((sku) => {
                const n = Math.max(0, Math.floor(Number(draft[sku.id]) || 0));
                return (
                  <div key={sku.id} className="dev-fake-gpu-modal__card">
                    <div className="dev-fake-gpu-modal__card-name" title={sku.name}>
                      {sku.short}
                    </div>
                    <div className="dev-fake-gpu-modal__card-meta">
                      {(sku.vramMib / 1024).toFixed(0)} GB · {sku.gen}
                    </div>
                    <div className="dev-fake-gpu-modal__stepper">
                      <button
                        type="button"
                        className="dev-fake-gpu-modal__step"
                        disabled={n <= 0}
                        onClick={() => bump(sku.id, -1)}
                        aria-label={`Fewer ${sku.short}`}
                      >
                        −
                      </button>
                      <span className="dev-fake-gpu-modal__count tabular-nums">{n}</span>
                      <button
                        type="button"
                        className="dev-fake-gpu-modal__step"
                        disabled={n >= DEV_FAKE_GPU_COUNT_MAX}
                        onClick={() => bump(sku.id, 1)}
                        aria-label={`More ${sku.short}`}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="dev-fake-gpu-modal__presets">
              <span className="dev-fake-gpu-modal__presets-label">Quick</span>
              <button
                type="button"
                className="dev-fake-gpu-modal__preset"
                onClick={() => setDraft({ rtx5090: 4 })}
              >
                4×5090
              </button>
              <button
                type="button"
                className="dev-fake-gpu-modal__preset"
                onClick={() => setDraft({ rtx4090: 2 })}
              >
                2×4090
              </button>
              <button
                type="button"
                className="dev-fake-gpu-modal__preset"
                onClick={() => setDraft({ rtx6000ada: 2 })}
              >
                2×Ada48
              </button>
              <button
                type="button"
                className="dev-fake-gpu-modal__preset"
                onClick={() => setDraft({ pro6000: 8 })}
              >
                8×PRO
              </button>
              <button
                type="button"
                className="dev-fake-gpu-modal__preset"
                onClick={() => setDraft({ rtx5090: 2, rtx6000ada: 2 })}
              >
                mixed
              </button>
            </div>

            <div className="dev-fake-gpu-modal__foot">
              <span className="dev-fake-gpu-modal__total">
                {draftTotal === 0 ? "Real GPUs only" : `+${draftTotal} synthetic`}
              </span>
              <div className="dev-fake-gpu-modal__actions">
                <button type="button" className="dev-fake-gpu-modal__btn" onClick={clear}>
                  CLEAR
                </button>
                <button
                  type="button"
                  className="dev-fake-gpu-modal__btn dev-fake-gpu-modal__btn--ghost"
                  onClick={() => setOpen(false)}
                >
                  CANCEL
                </button>
                <button
                  type="button"
                  className="dev-fake-gpu-modal__btn dev-fake-gpu-modal__btn--primary"
                  onClick={apply}
                >
                  APPLY
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="relative flex flex-shrink-0 self-stretch">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`app-header-dev-tools__btn app-chrome-control-btn w-auto ${
          total > 0
            ? "text-cyan-300 hover:text-cyan-200"
            : "text-white/45 hover:text-white/70"
        }`}
        title={
          total > 0
            ? `DEV: +${total} synthetic GPU(s) — open topo builder`
            : "DEV: fake multi-GPU topo (real SKU names + VRAM)"
        }
      >
        {btnLabel}
      </button>
      {modal}
    </div>
  );
}
