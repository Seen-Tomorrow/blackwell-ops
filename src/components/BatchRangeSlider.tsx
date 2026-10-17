/**
 * Batch / uBatch — one dual-thumb slider, one shared log scale.
 *
 * Left thumb = UB (micro-batch), right thumb = B (batch). The band between
 * them is the batch window. LATENCY / FAST / MAX marks snap both thumbs to a
 * known pair; FAST is the template default. Colors follow the CTX slider
 * language: electric blue → accent → amber.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UserEditedTemplateParam } from "../lib/types";
import {
  THROUGHPUT_STOPS,
  defaultValueOf,
  detectThroughput,
  formatParamValue,
  pickPercent,
  sortedParamValues,
  throughputDefs,
} from "../lib/engineSurfaces";

interface BatchRangeSliderProps {
  defs: UserEditedTemplateParam[];
  config: Record<string, unknown>;
  onChange: (key: string, value: string | number) => void;
}

type ThumbId = "batch" | "ubatch";

export default function BatchRangeSlider({ defs, config, onChange }: BatchRangeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ThumbId | null>(null);
  const [dragging, setDragging] = useState<ThumbId | null>(null);

  const throughput = throughputDefs(defs);
  const batchDef = defs.find((def) => def.key === "batch");
  const ubatchDef = defs.find((def) => def.key === "ubatch");

  const batchValues = useMemo(
    () => (batchDef ? sortedParamValues(batchDef).map(Number).filter(Number.isFinite) : []),
    [batchDef],
  );
  const ubatchValues = useMemo(
    () => (ubatchDef ? sortedParamValues(ubatchDef).map(Number).filter(Number.isFinite) : []),
    [ubatchDef],
  );

  const batch = Number(config.batch ?? (batchDef ? defaultValueOf(batchDef) : 0));
  const ubatch = Number(config.ubatch ?? (ubatchDef ? defaultValueOf(ubatchDef) : 0));

  const { min, max } = useMemo(() => {
    const ubMin = ubatchValues.length ? Math.min(...ubatchValues) : 64;
    const bMax = batchValues.length ? Math.max(...batchValues) : 32768;
    const lo = Math.max(1, Math.min(ubMin, batchValues[0] ?? ubMin));
    return { min: lo, max: Math.max(lo + 1, bMax) };
  }, [batchValues, ubatchValues]);

  const ratioOf = useCallback(
    (value: number) => {
      const lo = Math.log2(min);
      const hi = Math.log2(max);
      const ratio = (Math.log2(Math.max(min, value)) - lo) / (hi - lo);
      return Math.min(1, Math.max(0, ratio));
    },
    [min, max],
  );

  const nearest = useCallback(
    (ratio: number, values: number[]) => {
      let best = values[0] ?? min;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const value of values) {
        const dist = Math.abs(ratioOf(value) - ratio);
        if (dist < bestDist) {
          bestDist = dist;
          best = value;
        }
      }
      return best;
    },
    [ratioOf, min],
  );

  const presets = useMemo(() => {
    if (!batchDef || !ubatchDef) return [];
    return THROUGHPUT_STOPS.map((stop) => {
      const batchValue = stop.defaults
        ? Number(defaultValueOf(batchDef))
        : Number(pickPercent(batchDef, stop.batch ?? 0));
      const ubatchValue = stop.defaults
        ? Number(defaultValueOf(ubatchDef))
        : Number(pickPercent(ubatchDef, stop.ubatch ?? 0));
      return { ...stop, batchValue, ubatchValue };
    }).filter(
      (preset) => Number.isFinite(preset.batchValue) && Number.isFinite(preset.ubatchValue),
    );
  }, [batchDef, ubatchDef]);

  const active = detectThroughput(throughput, config);
  const activeLabel =
    active === "custom"
      ? "CUSTOM"
      : THROUGHPUT_STOPS.find((stop) => stop.id === active)?.label ?? "CUSTOM";

  const ratioFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const startDrag = useCallback((kind: ThumbId, e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = kind;
    setDragging(kind);
    trackRef.current?.setPointerCapture(e.pointerId);
  }, []);

  const moveDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const kind = dragRef.current;
      if (!kind) return;
      const ratio = ratioFromClientX(e.clientX);
      if (kind === "batch") {
        const next = nearest(ratio, batchValues);
        const floor = batchValues.find((value) => value >= ubatch)
          ?? batchValues[batchValues.length - 1]
          ?? next;
        onChange("batch", Math.max(next, floor));
      } else {
        const next = nearest(ratio, ubatchValues);
        let ceiling = ubatchValues[0] ?? next;
        for (const value of ubatchValues) {
          if (value <= batch) ceiling = value;
        }
        onChange("ubatch", Math.min(next, ceiling));
      }
    },
    [ratioFromClientX, nearest, batchValues, ubatchValues, batch, ubatch, onChange],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(null);
    const el = trackRef.current;
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }, []);

  useEffect(() => {
    const stop = () => {
      dragRef.current = null;
      setDragging(null);
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  if (!batchDef || !ubatchDef || batchValues.length === 0 || ubatchValues.length === 0) {
    return null;
  }

  const ubPct = ratioOf(ubatch) * 100;
  const batchPct = ratioOf(batch) * 100;
  const collide = Math.abs(batchPct - ubPct) < 4;

  return (
    <div className="cockpit-instrument cockpit-instrument--batch">
      <div className="cockpit-instrument__head">
        <span className="cockpit-instrument__label">BATCH</span>
        <span className="cockpit-instrument__state">{activeLabel}</span>
      </div>
      <div className="cockpit-batch__stage">
        <div className="cockpit-batch__hero">
          <span className="cockpit-batch__hero-label">BATCH</span>
          <span className="cockpit-batch__hero-value">{formatParamValue(batch)}</span>
          <span className="cockpit-batch__hero-sep" aria-hidden>
            //
          </span>
          <span className="cockpit-batch__hero-label">uBATCH</span>
          <span className="cockpit-batch__hero-sub">{formatParamValue(ubatch)}</span>
        </div>
        <div
          className="cockpit-batch__track"
          ref={trackRef}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="cockpit-batch__rail" aria-hidden />
          <div
            className="cockpit-batch__band"
            style={{ left: `${ubPct}%`, width: `${Math.max(0, batchPct - ubPct)}%` }}
            aria-hidden
          />
          {presets.map((preset) => {
            const pct = ratioOf(preset.batchValue) * 100;
            const isActive = active === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                className="cockpit-batch__mark-wrap"
                style={{ left: `${pct}%` }}
                onClick={() => {
                  onChange("batch", preset.batchValue);
                  onChange("ubatch", preset.ubatchValue);
                }}
                title={preset.blurb}
                aria-label={`Set ${preset.label} batch`}
              >
                <span
                  className={`cockpit-batch__mark cockpit-batch__mark--${preset.id}${
                    isActive ? " cockpit-batch__mark--active" : ""
                  }`}
                  aria-hidden
                />
                <span
                  className={`cockpit-batch__mark-label${
                    isActive ? " cockpit-batch__mark-label--active" : ""
                  }`}
                >
                  {preset.label}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            className={`cockpit-batch__thumb cockpit-batch__thumb--ub${
              collide ? " cockpit-batch__thumb--collide" : ""
            }${dragging === "ubatch" ? " cockpit-batch__thumb--dragging" : ""}`}
            style={{ left: `${ubPct}%` }}
            onPointerDown={(e) => startDrag("ubatch", e)}
            title={`uBatch ${ubatch}`}
            aria-label="uBatch"
          >
            UB
          </button>
          <button
            type="button"
            className={`cockpit-batch__thumb cockpit-batch__thumb--b${
              collide ? " cockpit-batch__thumb--collide" : ""
            }${dragging === "batch" ? " cockpit-batch__thumb--dragging" : ""}`}
            style={{ left: `${batchPct}%` }}
            onPointerDown={(e) => startDrag("batch", e)}
            title={`Batch ${batch}`}
            aria-label="Batch"
          >
            B
          </button>
        </div>
        <div className="cockpit-batch__hint">DRAG UB / B · CLICK A MARK TO SNAP</div>
      </div>
    </div>
  );
}
