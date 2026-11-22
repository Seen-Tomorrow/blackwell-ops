/**
 * DEV-only: GPU topology override (visible real count + synthetic extras).
 * Session only. Forecast / assign / split see the merged list as real units.
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
/** Free size a card gets when it is armed without picking a number. */
const BALLAST_DEFAULT_MIB = 24 * 1024;

interface BallastDeviceStatus {
  device: number;
  targetMib: number;
  nvmlFreeMib: number;
  alive: boolean;
}

interface BallastStatus {
  running: boolean;
  devices: BallastDeviceStatus[];
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
  /** Armed cards: device index -> MiB that must stay free. One entry per ballasted card. */
  const [armed, setArmed] = useState<Record<number, number>>({});
  const [ballastBusy, setBallastBusy] = useState(false);
  const [ballastError, setBallastError] = useState<string | null>(null);
  const [applied, setApplied] = useState<Draft>(snap);
  const [draft, setDraft] = useState<Draft>(snap);
  const ballastSeeded = useRef(false);
  const nvmlCount = Math.max(getDevLastRealGpuCount(), 1);
  const extraN = extraTotal(applied.extras);
  const realCapped = applied.realLimit != null;
  const active = extraN > 0 || realCapped;
  const visibleN = gpus.length;

  useEffect(() => {
    return subscribeDevFakeGpuExtra(() => setApplied(snap()));
  }, []);

  useEffect(() => {
    if (open) {
      setDraft(snap());
      // The first status read of a fresh open may reveal a ballast started earlier or from a shell.
      ballastSeeded.current = false;
    }
  }, [open]);

  // The ballast lives in another process; poll its status while the modal is open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await invoke<BallastStatus>("vram_ballast_status");
        if (cancelled) return;
        setBallast(next);
        if (!ballastSeeded.current) {
          ballastSeeded.current = true;
          if (next.running && next.devices.length > 0) {
            setArmed(Object.fromEntries(next.devices.map((d) => [d.device, d.targetMib])));
          }
        }
      } catch {
        if (!cancelled) setBallast(null);
      }
    };
    void tick();
    const timer = window.setInterval((): void => {
      void tick();
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open]);

  const armDevice = useCallback((device: number, targetMib?: number) => {
    setArmed((prev) => {
      const next = { ...prev };
      if (targetMib != null) {
        next[device] = targetMib;
      } else if (next[device] != null) {
        delete next[device];
      } else {
        next[device] = BALLAST_DEFAULT_MIB;
      }
      return next;
    });
  }, []);

  const holdBallast = useCallback(async () => {
    const devices = Object.keys(armed)
      .map(Number)
      .sort((a, b) => a - b)
      .map((device) => ({ device, targetMib: armed[device] }));
    if (devices.length === 0) return;
    setBallastBusy(true);
    setBallastError(null);
    try {
      const next = await invoke<BallastStatus>("vram_ballast_start", { devices });
      setBallast(next);
    } catch (e) {
      setBallastError(String(e));
    } finally {
      setBallastBusy(false);
    }
  }, [armed]);

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

  const armedDevices = Object.keys(armed)
    .map(Number)
    .sort((a, b) => a - b);
  const ballastDevices = ballast?.devices ?? [];
  const ballastHoldLabel =
    armedDevices.length === 0
      ? "HOLD"
      : armedDevices.length === 1
        ? `HOLD GPU-${armedDevices[0]}`
        : `HOLD ${armedDevices.length} GPUs`;
  const ballastStatusLine = ballastBusy
    ? "working…"
    : ballast?.running
      ? ballastDevices
          .map((d) => {
            const delta = d.nvmlFreeMib - d.targetMib;
            return `GPU-${d.device} free ${d.nvmlFreeMib} / ${d.targetMib} MiB (${delta >= 0 ? "+" : ""}${delta})`;
          })
          .join("  ·  ")
      : (ballast?.note ?? "idle");

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
                Holds raw VRAM in a separate process, leaving the chosen FREE size on each real card.
                Arm the cards, pick one free size per card, then HOLD. Not a model.
              </div>
              {Array.from({ length: nvmlCount }, (_, i) => {
                const target = armed[i];
                const live = ballastDevices.find((d) => d.device === i && d.alive);
                return (
                  <div
                    key={`ballast-gpu-${i}`}
                    className="dev-fake-gpu-modal__presets dev-fake-gpu-modal__presets--tight"
                  >
                    <button
                      type="button"
                      className={`dev-fake-gpu-modal__preset dev-fake-gpu-modal__ballast-gpu${
                        target != null ? " dev-fake-gpu-modal__preset--armed" : ""
                      }`}
                      onClick={() => armDevice(i)}
                      disabled={ballastBusy}
                      title={
                        target != null
                          ? `GPU-${i} armed (${Math.round(target / 1024)} GB free) - click to drop it`
                          : `Arm GPU-${i} for the ballast`
                      }
                    >
                      GPU-{i}
                    </button>
                    {BALLAST_TARGETS_GB.map((gb) => {
                      const isArmed = target === gb * 1024;
                      const isHeld = live != null && live.targetMib === gb * 1024;
                      return (
                        <button
                          key={`ballast-${i}-${gb}`}
                          type="button"
                          className={`dev-fake-gpu-modal__preset${
                            isHeld
                              ? " dev-fake-gpu-modal__preset--active"
                              : isArmed
                                ? " dev-fake-gpu-modal__preset--armed"
                                : ""
                          }`}
                          onClick={() => armDevice(i, gb * 1024)}
                          disabled={ballastBusy}
                          title={`Leave ${gb} GB free on GPU-${i}`}
                        >
                          {gb}G
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              <div className="dev-fake-gpu-modal__presets">
                <button
                  type="button"
                  className="dev-fake-gpu-modal__btn dev-fake-gpu-modal__btn--primary"
                  onClick={() => void holdBallast()}
                  disabled={ballastBusy || armedDevices.length === 0}
                  title="Start (or restart) the ballast on every armed card"
                >
                  {ballastHoldLabel}
                </button>
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
              <div className="dev-fake-gpu-modal__card-meta">{ballastStatusLine}</div>
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
