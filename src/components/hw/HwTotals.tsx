import type { GpuInfo, SystemInfo } from "../../lib/types";
import { hwTotals } from "../../lib/hwReadouts";
import HwFill from "./HwFill";

/** Same display face as the rest of the HUD — chrome comes from hw-monitor.css. */
const SURFACE = "phosphor-display-surface";

type TotalTone = "power" | "vram" | "ram";

function TotalCell({
  tone,
  label,
  shortLabel,
  value,
  denom,
  percent,
}: {
  tone: TotalTone;
  label: string;
  shortLabel: string;
  value: string;
  denom: string;
  percent: number;
}) {
  return (
    <div className={`hw-cell hw-cell--${tone} ${SURFACE}`}>
      <div className="hw-cell__row">
        <span className="hw-cell__label">
          <span className="hw-cell__label-full">{label}</span>
          <span className="hw-cell__label-short">{shortLabel}</span>
        </span>
        <span className={`hw-cell__value hw-cell__value--${tone}`}>
          {value}
          <span className="hw-cell__denom">{denom}</span>
        </span>
      </div>
      <div className="hw-cell__track">
        <HwFill className="hw-cell__fill" fill={tone} percent={percent} />
      </div>
    </div>
  );
}

export default function HwTotals({
  gpus,
  systemInfo,
}: {
  gpus: GpuInfo[];
  systemInfo: SystemInfo | null;
}) {
  const totals = hwTotals(gpus, systemInfo);

  return (
    <div className="hw-totals">
      {gpus.length > 0 && (
        <TotalCell
          tone="power"
          label="TOTAL GPU POWER"
          shortLabel="GPU PWR"
          value={totals.powerW.toFixed(0)}
          denom={
            totals.powerLimitW > 0
              ? ` / ${totals.powerLimitW.toFixed(0)} W`
              : " W"
          }
          percent={totals.powerPct}
        />
      )}
      <div className="hw-totals__pair">
        <TotalCell
          tone="vram"
          label="TOTAL VRAM USED"
          shortLabel="VRAM"
          value={totals.vramUsedGb.toFixed(1)}
          denom={` / ${totals.vramTotalGb.toFixed(0)} GB`}
          percent={totals.vramPct}
        />
        {totals.ramTotalGb > 0 && (
          <TotalCell
            tone="ram"
            label="TOTAL RAM USED"
            shortLabel="RAM"
            value={totals.ramUsedGb.toFixed(1)}
            denom={` / ${totals.ramTotalGb.toFixed(0)} GB`}
            percent={totals.ramPct}
          />
        )}
      </div>
    </div>
  );
}
