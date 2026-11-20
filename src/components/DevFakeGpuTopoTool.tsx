/**
 * DEV-only: GPU topology override (visible real count + synthetic extras).
 * Session only. Forecast / assign / split see the merged list as real units.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { useTelemetry } from "../context/TelemetryContext";
import {
  DEV_FAKE_GPU_CATALOG,
  DEV_FAKE_GPU_COUNT_MAX,
  clearDevFakeGpus,
  getDevFakeGpuPlan,
  getDevLastRealGpuCount,
  getDevRealVisibleLimit,
  setDevFakeGpuPlan,
  setDevRealVisibleLimit,
  subscribeDevFakeGpuExtra,
  type DevFakeGpuPlan,
} from "../lib/devFakeGpuTopo";

/** Presets the ballast can leave free on a card. */
const BALLAST_TARGETS_GB = [8, 12, 16, 24, 32, 48, 72] as const;

interface BallastStatus {
  running: boolean;
  supported: boolean;
  device: number;
  target_mib: number;
  nvml_free_mib: number;
  note: string;
}

type Draft = {
  extras: DevFakeGpuPlan;
  /** null = all NVML cards */
  realLimit: number | null;
};

function snap(): Draft {
  return {
    extras: getDevFakeGpuPlan(),
    realLimit: getDevRealVisibleLimit(),
  };
}

function extraTotal(p: DevFakeGpuPlan): number {
  return Object.values(p).reduce((s, n) => s + (n || 0), 0);
}

export default function DevFakeGpuTopoTool() {
  const { gpus } = useTelemetry();
  const [open, setOpen] = useState(false);
  const [ballast, setBallast] = useState<BallastStatus | null>(null);
  const [ballastDevice, setBallastDevice] = useState(0);
  const [ballastBusy, setBallastBusy] = useState(false);
  const [ballastError, setBallastError] = useState<string | null>(null);
  const [applied, setApplied] = useState<Draft>(snap);
  const [draft, setDraft] = useState<Draft>(snap);
  const nvmlCount = Math.max(getDevLastRealGpuCount(), 1);
  const extraN = extraTotal(applied.extras);
  const realCapped = applied.realLimit != null;
  const active = extraN > 0 || realCapped;
  const visibleN = gpus.length;

  useEffect(() => {
    return subscribeDevFakeGpuExtra(() => setApplied(snap()));
  }, []);

  useEffect(() => {
    if (open) setDraft(snap());
  }, [open]);

  // The ballast lives in another process; poll its status while the modal is open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await invoke<BallastStatus>("vram_ballast_status", {
          deviceIndex: ballastDevice,
        });
        // Explicitly typed above; the catch below only clears the readout.
        if (!cancelled) setBallast(next);
      } catch {
        if (!cancelled) setBallast(null);
      }
    };
    void tick();
    const timer = window.setInterval((): void => {
      void tick();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, ballastDevice]);

  const startBallast = useCallback(
    async (targetFreeMib: number) => {
      setBallastBusy(true);
      setBallastError(null);
      try {
        const next = await invoke<BallastStatus>("vram_ballast_start", {
          targetFreeMib,
          deviceIndex: ballastDevice,
        });
        setBallast(next);
      } catch (e) {
        setBallastError(String(e));
      } finally {
        setBallastBusy(false);
      }
    },
    [ballastDevice],
  );

  const stopBallast = useCallback(async () => {
    setBallastBusy(true);
    setBallastError(null);
    try {
      const next = await invoke<BallastStatus>("vram_ballast_stop");
      setBallast(next);
    } catch (e) {
      setBallastError(String(e));
    } finally {
      setBallastBusy(false);
    }
  }, []);

  const bumpSku = useCallback((id: string, delta: number) => {
    setDraft((prev) => {
      const cur = Math.max(0, Math.floor(Number(prev.extras[id]) || 0));
      const next = Math.max(0, Math.min(DEV_FAKE_GPU_COUNT_MAX, cur + delta));
      return { ...prev, extras: { ...prev.extras, [id]: next } };
    });
  }, []);

  const bumpReal = useCallback((delta: number) => {
    setDraft((prev) => {
      const base = prev.realLimit ?? nvmlCount;
      const next = Math.max(1, Math.min(nvmlCount, base + delta));
      return { ...prev, realLimit: next >= nvmlCount ? null : next };
    });
  }, [nvmlCount]);

  const apply = useCallback(() => {
    setDevFakeGpuPlan(draft.extras);
    setDevRealVisibleLimit(draft.realLimit);
    setApplied(snap());
    setOpen(false);
  }, [draft]);

  const clear = useCallback(() => {
    clearDevFakeGpus();
    setDraft({ extras: {}, realLimit: null });
    setApplied({ extras: {}, realLimit: null });
    setOpen(false);
  }, []);

  const draftExtras = extraTotal(draft.extras);
  const draftReal = draft.realLimit ?? nvmlCount;
  const btnLabel = !active
    ? "GPU+"
    : realCapped
      ? `${applied.realLimit}R${extraN > 0 ? `+${extraN}` : ""}`
      : `+${extraN}G`;

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
                GPU TOPO (DEV)
              </h3>
              <p className="dev-fake-gpu-modal__hint">
                Visible list is first-class: forecast, assign, split, VRAM. Session only.
                Launch/OC still only touch real NVML cards.
              </p>
            </div>

            <div className="dev-fake-gpu-modal__card" style={{ marginBottom: "0.45rem" }}>
              <div className="dev-fake-gpu-modal__card-name">Visible real GPUs</div>
              <div className="dev-fake-gpu-modal__card-meta">
                NVML {nvmlCount} · keep first N (safe 1-GPU) · extras append after
              </div>
              <div className="dev-fake-gpu-modal__stepper">
                <button
                  type="button"
                  className="dev-fake-gpu-modal__step"
                  disabled={draftReal <= 1}
                  onClick={() => bumpReal(-1)}
                  aria-label="Fewer real GPUs"
                >
                  −
                </button>
                <span className="dev-fake-gpu-modal__count tabular-nums">{draftReal}</span>
                <button
                  type="button"
                  className="dev-fake-gpu-modal__step"
                  disabled={draftReal >= nvmlCount}
                  onClick={() => bumpReal(1)}
                  aria-label="More real GPUs"
                >
                  +
                </button>
              </div>
            </div>

            <div className="dev-fake-gpu-modal__grid">
              {DEV_FAKE_GPU_CATALOG.map((sku) => {
                const n = Math.max(0, Math.floor(Number(draft.extras[sku.id]) || 0));
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
                        onClick={() => bumpSku(sku.id, -1)}
                        aria-label={`Fewer ${sku.short}`}
                      >
                        −
                      </button>
                      <span className="dev-fake-gpu-modal__count tabular-nums">{n}</span>
                      <button
                        type="button"
                        className="dev-fake-gpu-modal__step"
                        disabled={n >= DEV_FAKE_GPU_COUNT_MAX}
                        onClick={() => bumpSku(sku.id, 1)}
                        aria-label={`More ${sku.short}`}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="dev-fake-gpu-modal__card" style={{ marginTop: "0.45rem" }}>
              <div className="dev-fake-gpu-modal__card-name">VRAM BALLAST (DEV)</div>
              <div className="dev-fake-gpu-modal__card-meta">
                Holds raw VRAM in a separate process, leaving the chosen FREE size on a real card.
                Not a model; the tune then measures against that remainder.
              </div>
              <div className="dev-fake-gpu-modal__presets" style={{ marginTop: "0.35rem" }}>
                <span className="dev-fake-gpu-modal__presets-label">GPU</span>
                {Array.from({ length: Math.max(nvmlCount, 1) }, (_, i) => (
                  <button
                    key={`ballast-gpu-${i}`}
                    type="button"
                    className={`dev-fake-gpu-modal__preset${
                      ballastDevice === i ? " dev-fake-gpu-modal__preset--active" : ""
                    }`}
                    onClick={() => setBallastDevice(i)}
                    disabled={ballastBusy || !!ballast?.running}
                  >
                    GPU-{i}
                  </button>
                ))}
              </div>
              <div className="dev-fake-gpu-modal__presets">
                <span className="dev-fake-gpu-modal__presets-label">FREE</span>
                {BALLAST_TARGETS_GB.map((gb) => {
                  const active = !!ballast?.running && ballast.device === ballastDevice
                    && ballast.target_mib === gb * 1024;
                  return (
                    <button
                      key={`ballast-${gb}`}
                      type="button"
                      className={`dev-fake-gpu-modal__preset${
                        active ? " dev-fake-gpu-modal__preset--active" : ""
                      }`}
                      onClick={() => void startBallast(gb * 1024)}
                      disabled={ballastBusy}
                      title={`Leave ${gb} GB free on GPU-${ballastDevice}`}
                    >
                      {gb} GB
                    </button>
                  );
                })}
                {ballast?.running && (
                  <button
                    type="button"
                    className="dev-fake-gpu-modal__preset"
                    onClick={() => void stopBallast()}
                    disabled={ballastBusy}
                  >
                    RELEASE
                  </button>
                )}
              </div>
              <div className="dev-fake-gpu-modal__card-meta">
                {ballastBusy
                  ? "working…"
                  : ballast?.note
                    ? ballast.note
                    : "idle"}
              </div>
              {ballastError && (
                <div className="dev-fake-gpu-modal__card-meta cfg-warn">{ballastError}</div>
              )}
            </div>

            <div className="dev-fake-gpu-modal__presets">
              <span className="dev-fake-gpu-modal__presets-label">Quick</span>
              <button
                type="button"
                className="dev-fake-gpu-modal__preset"
                onClick={() => setDraft({ extras: {}, realLimit: 1 })}
              >
                1 real
              </button>
              <button
                type="button"
                className="dev-fake-gpu-modal__preset"
                onClick={() => setDraft({ extras: {}, realLimit: null })}
              >
                all real
              </button>
              <button
                type="button"
                className="dev-fake-gpu-modal__preset"
                onClick={() => setDraft({ extras: { pro6000: 4 }, realLimit: null })}
              >
                +4×PRO
              </button>
              <button
                type="button"
                className="dev-fake-gpu-modal__preset"
                onClick={() => setDraft({ extras: { rtx5090: 4 }, realLimit: null })}
              >
                +4×5090
              </button>
              <button
                type="button"
                className="dev-fake-gpu-modal__preset"
                onClick={() => setDraft({ extras: { rtx4090: 2 }, realLimit: null })}
              >
                +2×4090
              </button>
            </div>

            <div className="dev-fake-gpu-modal__foot">
              <span className="dev-fake-gpu-modal__total">
                {draftExtras === 0 && draft.realLimit == null
                  ? `Real GPUs only (${nvmlCount})`
                  : `${draftReal} real + ${draftExtras} extra → ${draftReal + draftExtras} visible`}
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
        className="app-header-dev-tools__btn app-chrome-control-btn w-auto"
        title={
          active
            ? `DEV: ${visibleN} visible GPU(s) — open topo builder`
            : "DEV: GPU topo — hide reals / add extras (forecast + layout)"
        }
      >
        {btnLabel}
      </button>
      {modal}
    </div>
  );
}
