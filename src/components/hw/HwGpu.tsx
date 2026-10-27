import type { ReactNode } from "react";
import type { GpuInfo } from "../../lib/types";
import type { GpuOcOverlay } from "../../hooks/useGpuControl";
import { formatGpuDriverVersion } from "../../lib/benchHwTopo";
import { hwReservedMib } from "../../services/vram/shared";
import {
  pcieReadout,
  powerFill,
  tempTone,
  throttleHot,
  throttleText,
  utilFill,
} from "../../lib/hwReadouts";
import HwFill from "./HwFill";

const SURFACE = "phosphor-display-surface";

interface HwGpuProps {
  gpu: GpuInfo;
  /** OC overlay for applied offsets/clocks — undefined until the control hook lands. */
  oc?: GpuOcOverlay;
  selected: boolean;
  busy: boolean;
  /** Compact drops the clocks and PCIe rows, and the power bar goes thin. */
  compact: boolean;
  peak?: { rx: number; tx: number };
  onSelect: () => void;
}

function Cell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="hw-gpu__cell">
      <span className="hw-gpu__label">{label}</span>
      {children}
    </div>
  );
}

export default function HwGpu({
  gpu,
  oc,
  selected,
  busy,
  compact,
  peak,
  onSelect,
}: HwGpuProps) {
  const usedVramGb = gpu.memory_used / 1024;
  const totalVramGb = (gpu.memory_total_manufactured || gpu.memory_total) / 1024;
  const reservedGb = hwReservedMib(gpu.driver_model) / 1024;
  const freeVramGb = Math.max(0, totalVramGb - usedVramGb - reservedGb);
  const powerPercent = gpu.power_limit > 0 ? (gpu.power_draw / gpu.power_limit) * 100 : 0;

  const driverVer = formatGpuDriverVersion(gpu.driver_version);
  const throttle = throttleText(gpu.throttle_reasons);
  const hot = throttleHot(gpu.throttle_reasons);

  // Compact hides these rows, so it never builds their readouts at all.
  const clocks = compact
    ? null
    : {
        core: oc ? oc.coreClockMhz : null,
        coreOffset: oc && oc.coreOffsetMhz > 0 ? oc.coreOffsetMhz : 0,
        mem: oc ? oc.memClockMhz * 2 : null,
        memOffset: oc && oc.memOffsetMhz > 0 ? oc.memOffsetMhz * 2 : 0,
      };
  const pcie = compact ? null : pcieReadout(gpu, peak);

  return (
    <button
      type="button"
      className={`hw-gpu ${SURFACE}`}
      data-selected={selected ? "true" : "false"}
      data-compact={compact ? "true" : "false"}
      disabled={busy}
      onClick={onSelect}
      aria-pressed={selected}
      title={`GPU ${gpu.index} — click to target the overclock panel`}
    >
      <div className="hw-gpu__head">
        <div className="hw-gpu__head-top">
          <span className="hw-gpu__name" title={gpu.name}>
            {gpu.name}
          </span>
          <span
            className="hw-gpu__temp"
            data-tone={tempTone(gpu.temperature_gpu)}
            title={`GPU temperature ${gpu.temperature_gpu}°C`}
          >
            {gpu.temperature_gpu > 0 ? `${gpu.temperature_gpu}°C` : "—"}
          </span>
        </div>
        <p className="hw-gpu__meta">
          <span
            className="hw-gpu__thr"
            title={throttle ? `NVML throttle: ${throttle}` : "No active throttle"}
          >
            <span className="hw-gpu__label">THR</span>{" "}
            <span className="hw-gpu__thr-text" data-hot={hot ? "true" : "false"}>
              {throttle ?? "—"}
            </span>
          </span>
          <span className="hw-gpu__meta-text">
            GPU-{gpu.index}
            {driverVer ? ` · drv ${driverVer}` : ""}
          </span>
          {selected ? (
            <span
              className="hw-gpu__target"
              data-active={oc?.profileActive ? "true" : "false"}
            >
              OC TARGET
            </span>
          ) : null}
        </p>
      </div>

      <div className="hw-gpu__body">
        {clocks && (
          <div className="hw-gpu__pair">
            <Cell label="CORE">
              <p className="hw-gpu__value hw-gpu__value--readout">
                {clocks.core != null ? (
                  <>
                    {clocks.core}
                    {clocks.coreOffset > 0 && (
                      <span className="hw-gpu__offset"> +{clocks.coreOffset}</span>
                    )}
                    {" MHz"}
                  </>
                ) : (
                  <span className="hw-gpu__empty">—</span>
                )}
              </p>
            </Cell>
            <Cell label="MEM">
              <p className="hw-gpu__value hw-gpu__value--readout">
                {clocks.mem != null ? (
                  <>
                    {clocks.mem}
                    {clocks.memOffset > 0 && (
                      <span className="hw-gpu__offset"> +{clocks.memOffset}</span>
                    )}
                    {" MT/s"}
                  </>
                ) : (
                  <span className="hw-gpu__empty">—</span>
                )}
              </p>
            </Cell>
          </div>
        )}

        <div className="hw-gpu__pair">
          <Cell label="GPU UTIL">
            <p className="hw-gpu__value hw-gpu__value--readout">
              {gpu.utilization_gpu}%
            </p>
            <div className="hw-gpu__track">
              <HwFill
                className="hw-gpu__fill"
                fill={utilFill("gpu", gpu.utilization_gpu)}
                percent={gpu.utilization_gpu}
              />
            </div>
          </Cell>
          <Cell label="MEM % · USED / FREE">
            <p className="hw-gpu__value hw-gpu__value--readout hw-gpu__value-row">
              <span>{gpu.utilization_memory}%</span>
              <span className="hw-gpu__vdiv" aria-hidden="true" />
              <span
                className="hw-gpu__mem-gb"
                title={`VRAM used ${usedVramGb.toFixed(1)} GB · free ${freeVramGb.toFixed(1)} GB`}
              >
                {usedVramGb.toFixed(1)}
                <span className="hw-gpu__dim"> / </span>
                {freeVramGb.toFixed(1)}
                <span className="hw-gpu__dim"> GB</span>
              </span>
            </p>
            <div className="hw-gpu__track">
              <HwFill
                className="hw-gpu__fill"
                fill={utilFill("mem", gpu.utilization_memory)}
                percent={gpu.utilization_memory}
              />
            </div>
          </Cell>
        </div>

        <div className="hw-gpu__power">
          <div className="hw-gpu__power-head">
            <span className="hw-gpu__label">POWER</span>
            <span className="hw-gpu__power-val">
              <span className="hw-gpu__power-watt">{gpu.power_draw.toFixed(0)}W</span>
              <span className="hw-gpu__dim">
                {" / "}
                {gpu.power_limit.toFixed(0)}W
                {oc && oc.configPowerLimitW !== Math.round(gpu.power_limit) && (
                  <span className="hw-gpu__power-target"> →{oc.configPowerLimitW}W</span>
                )}
              </span>
            </span>
          </div>
          <div className="hw-gpu__power-track">
            <HwFill
              className="hw-gpu__power-fill"
              fill={powerFill(powerPercent)}
              percent={powerPercent}
            />
          </div>
          {pcie && (
            <div className="hw-gpu__io">
              <span className="hw-gpu__label hw-gpu__io-label">PCIE</span>
              <span className="hw-gpu__io-link" title={pcie.title}>
                {pcie.gen != null ? `Gen${pcie.gen}` : "—"}
                {pcie.width != null ? ` · x${pcie.width}` : ""}
              </span>
              <span className="hw-gpu__io-reads">
                <span className="hw-gpu__io-rate">
                  RX {pcie.rx}
                  <span className="hw-gpu__peak"> // {pcie.peakRx}</span>
                </span>
                <span className="hw-gpu__io-rate">
                  TX {pcie.tx}
                  <span className="hw-gpu__peak"> // {pcie.peakTx}</span>
                </span>
              </span>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
