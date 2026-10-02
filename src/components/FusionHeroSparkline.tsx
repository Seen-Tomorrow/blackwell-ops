import { memo, useId, useMemo, useRef } from "react";

const MAX_SAMPLES = 48;
const VB_W = 120;
const VB_H = 18;
const PAD_Y = 2;

/**
 * Dense TG waveform under the hero numeral.
 * Samples live tok/s; auto-scales to recent peak so quiet models still draw shape.
 *
 * Memoized: both props are primitives, so this leaf only re-renders when tok/s
 * actually moves — unlike its ancestors, which carry fresh object props and would
 * gain nothing from memo().
 */
const FusionHeroSparkline = memo(function FusionHeroSparkline({
  value,
  active,
}: {
  value: number;
  active: boolean;
}) {
  const gradId = useId().replace(/:/g, "");
  const histRef = useRef<number[]>([]);
  const lastSampleRef = useRef<number | null>(null);
  const versionRef = useRef(0);

  // Sample during render rather than in an effect. The effect form pushed to the ref
  // and then setState()d to make the new path visible, which turned every parent
  // render into two — and this leaf sits on the 25 ms fusion tick.
  //
  // Guarded on the value so a parent re-render at the same tok/s appends no duplicate
  // sample; that also makes it StrictMode-safe, where the effect form double-fired.
  if (lastSampleRef.current !== value) {
    lastSampleRef.current = value;
    const v = value > 0 && Number.isFinite(value) ? value : 0;
    const next = histRef.current.slice();
    next.push(v);
    if (next.length > MAX_SAMPLES) next.splice(0, next.length - MAX_SAMPLES);
    histRef.current = next;
    versionRef.current += 1;
  }

  const { lineD, areaD, hasInk } = useMemo(() => {
    const samples = histRef.current;
    if (samples.length < 2) {
      return { lineD: "", areaD: "", hasInk: false };
    }
    const peak = Math.max(1, ...samples);
    const n = samples.length;
    const pts = samples.map((v, i) => {
      const x = (i / Math.max(n - 1, 1)) * VB_W;
      const y = VB_H - PAD_Y - (Math.min(v, peak) / peak) * (VB_H - PAD_Y * 2);
      return [x, y] as const;
    });
    const line = pts
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
      .join(" ");
    const last = pts[pts.length - 1];
    const first = pts[0];
    const area = `${line} L${last[0].toFixed(2)},${VB_H} L${first[0].toFixed(2)},${VB_H} Z`;
    const hasInk = samples.some((v) => v > 0);
    return { lineD: line, areaD: area, hasInk };
    // Recomputed only when a sample was actually appended.
  }, [versionRef.current]);

  return (
    <svg
      className={`fusion-hero-spark${active ? " fusion-hero-spark--active" : ""}${hasInk ? " fusion-hero-spark--ink" : ""}`}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {areaD && <path className="fusion-hero-spark__area" d={areaD} fill={`url(#${gradId})`} />}
      {lineD && (
        <path
          className="fusion-hero-spark__line"
          d={lineD}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
});

export default FusionHeroSparkline;
