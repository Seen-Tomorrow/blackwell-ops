/**
 * CPU EXPERTS scenario — the forecast layout for a `-cmoe` launch with an expert cache.
 *
 * This is a placement, not a spill: the expert weights are in host RAM by design and the cache is
 * VRAM the launch reserves. The layout prints the live device/host split and, when a previous
 * OVERDRIVE calibration exists for this shape, what it measured (PP/TG before → after, age).
 */
import type { VramManifest } from "../lib/types";
import type { OverdriveRecord } from "../lib/moeOverdriveRun";

export interface CpuExpertsScenarioProps {
  manifest: VramManifest;
  /** Cache from the live config; the record wins when it exists. */
  cacheMib: number;
  record: OverdriveRecord | null;
  /** Re-run the OVERDRIVE calibration for this shape. */
  onRecalibrate?: () => void;
}

function gib(gb: number): string {
  return `${gb.toFixed(1)} GiB`;
}

function mib(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function tps(value: number | null | undefined): string {
  return value != null && value > 0 ? value.toFixed(1) : "—";
}

function gain(before: number | null | undefined, after: number | null | undefined): string {
  if (before == null || after == null || before <= 0) return "";
  const pct = (after / before - 1) * 100;
  return ` (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)`;
}

function age(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 90) return "just now";
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 172800) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export default function CpuExpertsScenario({
  manifest,
  cacheMib,
  record,
  onRecalibrate,
}: CpuExpertsScenarioProps) {
  const usedAllocations = manifest.gpuAllocations.filter((alloc) => alloc.projectedLoadGb > 0.1);
  const freeGb = usedAllocations.reduce((sum, alloc) => sum + Math.max(0, alloc.vramAvailableGb), 0);
  // The record is keyed by the launch identity, which does not include the cache size; a record
  // from another cache is a different shape and must not lend its t/s to this one.
  const shapeRecord = record && record.cache_mib === cacheMib ? record : null;
  const cache = cacheMib;
  const hostGb =
    manifest.ramTotalGb > 0
      ? manifest.ramTotalGb
      : (shapeRecord?.host_mib_after ?? shapeRecord?.host_mib_before ?? 0) / 1024;
  const tgBefore = shapeRecord?.tps_before ?? null;
  const tgAfter = shapeRecord?.tps_after ?? null;
  const ppBefore = shapeRecord?.pp_tps_before ?? null;
  const ppAfter = shapeRecord?.pp_tps_after ?? null;

  return (
    <div className="vram-cpu-experts" data-fits={manifest.fits ? "1" : "0"}>
      <div className="vram-cpu-experts__head">
        <span className="vram-cpu-experts__title">CPU EXPERTS{cache > 0 ? " + CACHE" : ""}</span>
        <span className="vram-cpu-experts__state">
          {manifest.fits ? "fits on the device" : "over device free — recalibrate"}
        </span>
      </div>

      <div className="vram-cpu-experts__grid">
        <div className="vram-cpu-experts__cell">
          <span className="vram-cpu-experts__lab">DEVICE</span>
          <span className="vram-cpu-experts__val">{gib(manifest.vramTotalGb)}</span>
          <span className="vram-cpu-experts__sub">of {gib(freeGb)} free · non-expert + KV + cache</span>
        </div>
        <div className="vram-cpu-experts__cell">
          <span className="vram-cpu-experts__lab">HOST</span>
          <span className="vram-cpu-experts__val">{gib(hostGb)}</span>
          <span className="vram-cpu-experts__sub">expert pool · by design, not a spill</span>
        </div>
        <div className="vram-cpu-experts__cell">
          <span className="vram-cpu-experts__lab">CACHE</span>
          <span className="vram-cpu-experts__val">{mib(cache)}</span>
          <span className="vram-cpu-experts__sub">MiB · {shapeRecord ? age(shapeRecord.measured_at) : "no calibration yet"}</span>
        </div>
      </div>

      <div className="vram-cpu-experts__measured">
        {shapeRecord ? (
          <>
            <span className="vram-cpu-experts__measured-lab">MEASURED</span>
            <span>
              TG {tps(tgBefore)} → <b>{tps(tgAfter)}</b> t/s{gain(tgBefore, tgAfter)}
            </span>
            <span className="vram-cpu-experts__sep">·</span>
            <span>
              PP {tps(ppBefore)} → <b>{tps(ppAfter)}</b> t/s
            </span>
            <span className="vram-cpu-experts__sep">·</span>
            <span className="vram-cpu-experts__age">{age(shapeRecord.measured_at)}</span>
          </>
        ) : (
          <span>No calibration for this shape — run OVERDRIVE to measure the cache.</span>
        )}
        {onRecalibrate ? (
          <button
            type="button"
            className="vram-cpu-experts__recal"
            onClick={() => onRecalibrate()}
            title="Re-run the OVERDRIVE calibration for this shape"
          >
            RECALIBRATE
          </button>
        ) : null}
      </div>

      <div className="vram-cpu-experts__note">
        No OFFLOADING warning: the host weights are the chosen expert placement.
      </div>
    </div>
  );
}
