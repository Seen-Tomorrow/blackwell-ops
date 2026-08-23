/**
 * DEV overlay under the CTX hero rail — forecast ribbon + LEARNED pips + hover.
 * Does not edit CustomSliderParam. Mount only from CockpitCtxStrip when DEV.
 */

import { useMemo, useState, type PointerEvent } from "react";
import {
  ribbonCssGradient,
  ribbonTooltip,
  sampleRibbonStops,
} from "./ctxForecastRibbonMath";

export type CtxForecastRibbonPlace = "track" | "marks";

export type CtxForecastRibbonProps = {
  min: number;
  max: number;
  forecastCurve: Array<{ ctx: number; gb: number }>;
  forecastFreeGb: number;
  learnedMarks?: number[];
  ctxValues?: (string | number)[];
  /** track = fill the hero rail; marks = thin strip at tick bottoms. */
  place?: CtxForecastRibbonPlace;
  onHover?: (text: string | null) => void;
};

export default function CtxForecastRibbon({
  min,
  max,
  forecastCurve,
  forecastFreeGb,
  learnedMarks = [],
  ctxValues = [],
  place = "marks",
  onHover,
}: CtxForecastRibbonProps) {
  const [hover, setHover] = useState<{ pct: number; text: string } | null>(null);

  const stops = useMemo(
    () => sampleRibbonStops(min, max, forecastFreeGb, forecastCurve),
    [min, max, forecastFreeGb, forecastCurve],
  );
  const gradient = useMemo(() => ribbonCssGradient(stops), [stops]);


  if (stops.length < 2 || !(max > min)) return null;

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const ctx = min + pct * (max - min);
    const nearest = stops.reduce((best, s) =>
      Math.abs(s.ctx - ctx) < Math.abs(best.ctx - ctx) ? s : best,
    );
    const text = ribbonTooltip(nearest.ctx, nearest.gb, forecastFreeGb, learnedMarks);
    setHover({ pct: pct * 100, text });
    onHover?.(text);
  };

  return (
    <div
      className={`ctx-forecast-ribbon ctx-forecast-ribbon--${place}`}
      onPointerMove={onMove}
      onPointerLeave={() => {
        setHover(null);
        onHover?.(null);
      }}
    >
      <div className="ctx-forecast-ribbon__rail" style={{ background: gradient }} />
      {hover && place !== "track" ? (
        <span className="ctx-forecast-ribbon__tip font-mono" style={{ left: `${hover.pct}%` }}>
          {hover.text}
        </span>
      ) : null}
    </div>
  );
}
