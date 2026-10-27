import { memo, useCallback, useEffect, useState, type CSSProperties } from "react";
import { useTelemetry } from "../../context/TelemetryContext";
import { useGpuControl } from "../../hooks/useGpuControl";
import {
  loadHwMonitorCpuCoresOpen,
  loadHwMonitorDensity,
  loadHwMonitorDim,
  saveHwMonitorCpuCoresOpen,
  saveHwMonitorDensity,
  saveHwMonitorDim,
  type HwMonitorDensity,
} from "../../lib/storage";
import GpuOverclockPanel from "../GpuOverclockPanel";
import HwCpu from "./HwCpu";
import HwGpu from "./HwGpu";
import HwTotals from "./HwTotals";
import { usePciePeaks } from "./usePciePeaks";

export type HwMonitorPlacement = "rail" | "below";

const DIM_MIN = 0.2;

/**
 * Hardware monitor shell.
 *
 * Placement decides the SHAPE (rail = vertical column, below = horizontal strip
 * under the display); density decides how much each widget renders. The two are
 * orthogonal — every widget reads `data-density` from this root, and the compact
 * branches drop whole rows in JSX instead of hiding them with CSS.
 *
 * The OC panel is an overlay owned by this header chip in both placements, so no
 * part of the monitor is reserved for it and the rail keeps its full height.
 */
function HwMonitor({ placement }: { placement: HwMonitorPlacement }) {
  const { gpus, cpu, systemInfo } = useTelemetry();
  const [density, setDensity] = useState<HwMonitorDensity>(loadHwMonitorDensity);
  const [dim, setDim] = useState(loadHwMonitorDim);
  const [cpuCoresOpen, setCpuCoresOpen] = useState(loadHwMonitorCpuCoresOpen);
  const [ocOpen, setOcOpen] = useState(false);
  const compact = density === "compact";
  const hasGpus = gpus.length > 0;
  const peaks = usePciePeaks(gpus);
  const {
    ocMode,
    syncGroup,
    selectedGpuIndex,
    sliderDevice,
    activePreset,
    busy,
    elevated,
    devices,
    initialLoading,
    error,
    status,
    ocActive,
    getOverlay,
    isOcTarget,
    handleModeChange,
    patchActivePreset,
    handleApply,
    handleResetAll,
    handleResetGpu,
    handleSetDriverModel,
    handleSelectGpu,
  } = useGpuControl({ pollDevices: ocOpen });

  const toggleDensity = useCallback(() => {
    setDensity((prev) => {
      const next: HwMonitorDensity = prev === "full" ? "compact" : "full";
      saveHwMonitorDensity(next);
      return next;
    });
  }, []);

  const toggleCores = useCallback(() => {
    setCpuCoresOpen((prev) => {
      const next = !prev;
      saveHwMonitorCpuCoresOpen(next);
      return next;
    });
  }, []);

  const changeDim = useCallback((value: number) => {
    const next = Math.min(1, Math.max(DIM_MIN, value));
    setDim(next);
    saveHwMonitorDim(next);
  }, []);

  useEffect(() => {
    if (!ocOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOcOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ocOpen]);

  const ocPanelProps = {
    ocActive,
    ocMode,
    syncGroupCount: syncGroup.length,
    syncGroupName: syncGroup[0]?.name ?? "",
    selectedGpuIndex,
    sliderDevice,
    activePreset,
    busy,
    elevated,
    devicesCount: devices.length,
    initialLoading,
    error,
    status,
    onModeChange: handleModeChange,
    onPatchPreset: patchActivePreset,
    onApply: handleApply,
    onResetAll: handleResetAll,
    onResetGpu: handleResetGpu,
    onSetDriverModel: handleSetDriverModel,
  };

  return (
    <div
      className="hw-mon"
      data-placement={placement}
      data-density={density}
      data-oc-open={ocOpen ? "true" : "false"}
      style={{ "--hw-monitor-dim": dim } as CSSProperties}
    >
      <div className="hw-mon__header">
        <div className="hw-mon__identity">
          <span className="hw-mon__pulse" aria-hidden="true" />
          <span className="hw-mon__title">HW MONITOR</span>
        </div>
        <div className="hw-mon__controls">
          {hasGpus && (
            <button
              type="button"
              className={`hw-mon__chip hw-mon__chip--oc${ocOpen ? " hw-mon__chip--on" : ""}${
                ocActive && !ocOpen ? " hw-mon__chip--alert" : ""
              }`}
              onClick={() => setOcOpen((v) => !v)}
              aria-expanded={ocOpen}
              title={
                ocOpen
                  ? "Close the GPU overclock panel"
                  : ocActive
                    ? "Overclock is applied — open the GPU overclock panel"
                    : "Open the GPU overclock panel"
              }
            >
              OC
            </button>
          )}
          <button
            type="button"
            className="hw-mon__chip"
            onClick={toggleDensity}
            aria-pressed={compact}
            title={
              compact
                ? "Widget density: COMPACT — click for full readings (clocks, PCIe)"
                : "Widget density: FULL — click for compact widgets (no clocks or PCIe rows)"
            }
          >
            {compact ? "CMPT" : "FULL"}
          </button>
          <label
            className="hw-mon__dim"
            title={`HW monitor dim — ${Math.round(dim * 100)}% (widgets only; header stays full)`}
          >
            <span className="hw-mon__dim-label">DIM</span>
            <input
              type="range"
              className="hw-mon__dim-slider"
              min={20}
              max={100}
              step={1}
              value={Math.round(dim * 100)}
              onChange={(e) => changeDim(Number(e.target.value) / 100)}
              aria-label="HW monitor dim"
            />
          </label>
        </div>
      </div>

      {ocOpen && hasGpus && (
        <div className="hw-mon__oc" role="region" aria-label="GPU overclock">
          <GpuOverclockPanel layout="rail" defaultExpanded {...ocPanelProps} />
        </div>
      )}

      <div className="hw-mon__body">
        <HwTotals gpus={gpus} systemInfo={systemInfo} />
        {cpu && (
          <HwCpu cpu={cpu} coresOpen={cpuCoresOpen} compact={compact} onToggleCores={toggleCores} />
        )}
        {gpus.map((gpu) => (
          <HwGpu
            key={gpu.index}
            gpu={gpu}
            oc={getOverlay(gpu.index)}
            selected={isOcTarget(gpu.index)}
            busy={busy}
            compact={compact}
            peak={peaks[gpu.index]}
            onSelect={() => handleSelectGpu(gpu.index)}
          />
        ))}
        {!cpu && !hasGpus && <p className="hw-mon__empty">Scanning hardware…</p>}
      </div>
    </div>
  );
}

/*
 * Memoized on purpose: the monitor is mounted under `EngineConfigPanel`, which re-renders on
 * every fusion tick (~40 Hz). Without this, the whole HW subtree re-rendered 40×/s for data
 * that changes 4×/s — measured as 125 ms/s of extra main-thread JS (158 vs 33 with the
 * monitor closed). Context updates (the actual telemetry) still re-render it normally.
 */
export default memo(HwMonitor);

