import { useEffect, useRef } from "react";
import { barStep } from "../../lib/hwReadouts";

/**
 * Meter fill — animates `transform` (compositor-only) and only when the move is visible.
 *
 * The tween is the expensive part on an iGPU: while it runs, the compositor produces a
 * frame every vsync (~60 fps) for the whole 120 ms. Idle jitter (µW power noise, per-core
 * wobble) retargeted bars every tick, so the compositor never idled — measured as 1→6→10 %
 * iGPU spikes on a machine doing nothing, identical in compact and full because one
 * animating bar costs a full-window composite anyway.
 *
 * So: snap changes below `animateDeltaPct`, glide the rest. The gate is set to one visual
 * step (0.5 % / 5 %) — i.e. every change a bar can *show* glides; only between-step noise
 * snaps, and the quantizer below already removes most of that. Raising it trades motion
 * for compositor frames: at 4 Hz a 120 ms tween keeps the compositor busy ~half the time,
 * which on a 4K iGPU is a few percent of GPU for as long as anything is moving.
 *
 * `stepPct` is the bar's visual resolution — half a percent for a wide meter, ~5 % for a
 * 20 px core bar.
 */
export default function HwFill({
  percent,
  fill,
  className,
  stepPct = 0.5,
  animateDeltaPct = 0.5,
}: {
  percent: number;
  /** `data-fill` tone token. */
  fill: string;
  className: string;
  stepPct?: number;
  animateDeltaPct?: number;
}) {
  const target = barStep(percent, stepPct);
  const prev = useRef(target);
  const animate = Math.abs(target - prev.current) >= animateDeltaPct;
  /*
   * Commit the seen value AFTER paint, never during render. Writing a ref while rendering is
   * impure, and StrictMode (DEV) renders twice: the second pass saw a zero delta, wrote
   * `transition: none`, and killed the tween the first pass had just started. Measured via
   * CDP: every fill computed `none 0s` while the DOM was updating at 4 Hz — which reads as
   * "the panel only updates twice a second" even though nothing was being dropped.
   */
  useEffect(() => {
    prev.current = target;
  }, [target]);

  return (
    <div
      className={className}
      data-fill={fill}
      style={{
        transform: `scaleX(${target / 100})`,
        transition: animate ? undefined : "none",
      }}
    />
  );
}
