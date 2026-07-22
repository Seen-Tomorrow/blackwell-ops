import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { CpuInfo, GpuInfo, SystemInfo } from "../lib/types";
import { useDisplayTexture } from "../context/DisplayTextureContext";
import { useTelemetry } from "../context/TelemetryContext";
import { useGpuControl } from "../hooks/useGpuControl";
import {
  loadHwMonitorCpuCoresOpen,
  saveHwMonitorCpuCoresOpen,
} from "../lib/storage";
import CpuCoreGrid from "./CpuCoreGrid";
import GpuOverclockPanel from "./GpuOverclockPanel";
import GpuTopologyCard from "./GpuTopologyCard";

const TEL_WIDGET_SURFACE = "phosphor-display-surface";

function MemTotals({ gpus, systemInfo }: { gpus: GpuInfo[]; systemInfo: SystemInfo | null }) {
  const totalPowerW = gpus.reduce((s, g) => s + (g.power_draw || 0), 0);
  const totalPowerLimitW = gpus.reduce((s, g) => s + (g.power_limit || 0), 0);
  const powerPct = totalPowerLimitW > 0 ? (totalPowerW / totalPowerLimitW) * 100 : 0;
  const totalVramGb = gpus.reduce((s, g) => s + (g.memory_total_manufactured || g.memory_total), 0) / 1024;
  const usedVramGb = gpus.reduce((s, g) => s + g.memory_used, 0) / 1024;
  const ramTotalGb = (systemInfo?.total_memory_manufactured_mib || systemInfo?.total_memory_mib || 0) / 1024;
  const ramUsedGb = systemInfo
    ? (systemInfo.total_memory_mib - systemInfo.available_memory_mib) / 1024
    : 0;
  const vramPct = totalVramGb > 0 ? (usedVramGb / totalVramGb) * 100 : 0;
  const ramPct = ramTotalGb > 0 ? (ramUsedGb / ramTotalGb) * 100 : 0;

  return (
    <div className="launch-rail-tel__totals-stack">
      {gpus.length > 0 && (
        <div className={`launch-rail-tel__total-cell launch-rail-tel__total-cell--power ${TEL_WIDGET_SURFACE}`}>
          <span className="launch-rail-tel__total-label">Total GPU power</span>
          <span className="launch-rail-tel__total-value launch-rail-tel__total-value--power">
            {totalPowerW.toFixed(0)}
            <span className="launch-rail-tel__total-denom"> W</span>
            {totalPowerLimitW > 0 && (
              <span className="launch-rail-tel__total-denom"> / {totalPowerLimitW.toFixed(0)} W</span>
            )}
          </span>
          {totalPowerLimitW > 0 && (
            <div className="launch-rail-tel__total-track">
              <div
                className={`launch-rail-tel__total-fill launch-rail-tel__total-fill--power${
                  powerPct > 88 ? " launch-rail-tel__total-fill--warn" : ""
                }`}
                style={{ width: `${Math.min(powerPct, 100)}%` }}
              />
            </div>
          )}
        </div>
      )}
      <div className="launch-rail-tel__totals">
      <div className={`launch-rail-tel__total-cell ${TEL_WIDGET_SURFACE}`}>
        <span className="launch-rail-tel__total-label">Total VRAM used</span>
        <span className="launch-rail-tel__total-value launch-rail-tel__total-value--vram">
          {usedVramGb.toFixed(1)}
          <span className="launch-rail-tel__total-denom"> / {totalVramGb.toFixed(0)} GB</span>
        </span>
        <div className="launch-rail-tel__total-track">
          <div
            className={`launch-rail-tel__total-fill launch-rail-tel__total-fill--vram${vramPct > 88 ? " launch-rail-tel__total-fill--warn" : ""}`}
            style={{ width: `${Math.min(vramPct, 100)}%` }}
          />
        </div>
      </div>
      {ramTotalGb > 0 && (
        <div className={`launch-rail-tel__total-cell ${TEL_WIDGET_SURFACE}`}>
          <span className="launch-rail-tel__total-label">Total RAM used</span>
          <span className="launch-rail-tel__total-value launch-rail-tel__total-value--ram">
            {ramUsedGb.toFixed(1)}
            <span className="launch-rail-tel__total-denom"> / {ramTotalGb.toFixed(0)} GB</span>
          </span>
          <div className="launch-rail-tel__total-track">
            <div
              className={`launch-rail-tel__total-fill launch-rail-tel__total-fill--ram${ramPct > 88 ? " launch-rail-tel__total-fill--warn" : ""}`}
              style={{ width: `${Math.min(ramPct, 100)}%` }}
            />
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

function cpuAvgBarClass(avg: number): string {
  if (avg > 85) return "launch-rail-tel__cpu-avg-fill--critical";
  if (avg > 60) return "launch-rail-tel__cpu-avg-fill--high";
  return "launch-rail-tel__cpu-avg-fill--normal";
}

function CpuStrip({
  cpu,
  coresOpen,
  onToggleCores,
}: {
  cpu: CpuInfo;
  coresOpen: boolean;
  onToggleCores: () => void;
}) {
  const avg = Math.round(cpu.avg_usage_percent);

  const onHeadKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggleCores();
    }
  };

  const stopToggleBubble = (event: MouseEvent) => {
    event.stopPropagation();
  };

  return (
    <div
      className={`launch-rail-tel__cpu ${TEL_WIDGET_SURFACE}${
        coresOpen ? " launch-rail-tel__cpu--cores-open" : ""
      }`}
    >
      <div
        className="launch-rail-tel__cpu-head launch-rail-tel__cpu-head--toggle"
        role="button"
        tabIndex={0}
        onClick={onToggleCores}
        onKeyDown={onHeadKeyDown}
        onMouseDown={stopToggleBubble}
        title={coresOpen ? "Hide per-core grid" : "Show per-core grid"}
        aria-pressed={coresOpen}
      >
        <div className="min-w-0 flex-1">
          <p className="launch-rail-tel__cpu-name" title={cpu.name}>
            {cpu.name}
          </p>
          <p className="launch-rail-tel__cpu-meta">
            {cpu.cores}C/{cpu.threads}T · {cpu.max_clock_mhz} MHz
          </p>
        </div>
        <div className="launch-rail-tel__cpu-head-right">
          <span
            className={`launch-rail-tel__cpu-cores-badge${
              coresOpen ? " launch-rail-tel__cpu-cores-badge--on" : ""
            }`}
          >
            CORES {coresOpen ? "ON" : "OFF"}
          </span>
          <div className="launch-rail-tel__cpu-avg">
            <span className="launch-rail-tel__cpu-avg-val">{avg}</span>
            <span className="launch-rail-tel__cpu-avg-unit">%</span>
          </div>
        </div>
      </div>
      <div className="launch-rail-tel__cpu-avg-track">
        <div
          className={`launch-rail-tel__cpu-avg-fill ${cpuAvgBarClass(avg)}`}
          style={{ width: `${Math.min(avg, 100)}%` }}
        />
      </div>
      {coresOpen ? <CpuCoreGrid cpu={cpu} /> : null}
    </div>
  );
}

export default function LaunchRailTelemetry() {
  const { gpus, cpu, systemInfo } = useTelemetry();
  const { texture: displayTexture } = useDisplayTexture();
  const [cpuCoresOpen, setCpuCoresOpen] = useState(loadHwMonitorCpuCoresOpen);
  /** User cores pref while OC is open — restored on OC collapse. */
  const coresPrefBeforeOcRef = useRef(loadHwMonitorCpuCoresOpen());
  const [ocExpanded, setOcExpanded] = useState(false);

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
  } = useGpuControl();

  const toggleCpuCores = useCallback(() => {
    setCpuCoresOpen((prev) => {
      const next = !prev;
      saveHwMonitorCpuCoresOpen(next);
      if (!ocExpanded) coresPrefBeforeOcRef.current = next;
      return next;
    });
  }, [ocExpanded]);

  const handleOcExpandedChange = useCallback((open: boolean) => {
    setOcExpanded(open);
    if (open) {
      // Free vertical room at high zoom — temp collapse cores (keep user pref).
      coresPrefBeforeOcRef.current = loadHwMonitorCpuCoresOpen();
      setCpuCoresOpen(false);
    } else {
      setCpuCoresOpen(coresPrefBeforeOcRef.current);
    }
  }, []);

  return (
    <div
      className="launch-rail-tel h-full min-h-0 flex flex-col"
      data-display-texture={displayTexture}
      data-oc-expanded={ocExpanded ? "true" : "false"}
    >
      <div className="launch-rail-tel__header">
        <div className="launch-rail-tel__header-left">
          <span className="launch-rail-tel__pulse" aria-hidden="true" />
          <span className="launch-rail-tel__title">HW MONITOR</span>
        </div>
      </div>

      {/* No scrollbar chrome — wheel/trackpad still scrolls when zoom packs the rail */}
      <div className="launch-rail-tel__body min-h-0 flex-1">
        <MemTotals gpus={gpus} systemInfo={systemInfo} />
        {cpu && (
          <CpuStrip
            cpu={cpu}
            coresOpen={cpuCoresOpen}
            onToggleCores={toggleCpuCores}
          />
        )}

        {gpus.length > 0 && (
          <>
            <div className="launch-rail-tel__gpu-stack" data-gpu-topology>
              {gpus.map((gpu) => (
                <GpuTopologyCard
                  key={gpu.index}
                  gpu={gpu}
                  oc={getOverlay(gpu.index)}
                  selected={isOcTarget(gpu.index)}
                  busy={busy}
                  compact
                  onSelect={() => handleSelectGpu(gpu.index)}
                />
              ))}
            </div>

            <GpuOverclockPanel
              layout="rail"
              ocActive={ocActive}
              ocMode={ocMode}
              syncGroupCount={syncGroup.length}
              syncGroupName={syncGroup[0]?.name ?? ""}
              selectedGpuIndex={selectedGpuIndex}
              sliderDevice={sliderDevice}
              activePreset={activePreset}
              busy={busy}
              elevated={elevated}
              devicesCount={devices.length}
              initialLoading={initialLoading}
              error={error}
              status={status}
              onModeChange={handleModeChange}
              onPatchPreset={patchActivePreset}
              onApply={handleApply}
              onResetAll={handleResetAll}
              onResetGpu={handleResetGpu}
              onSetDriverModel={handleSetDriverModel}
              onExpandedChange={handleOcExpandedChange}
            />
          </>
        )}

        {!cpu && gpus.length === 0 && (
          <p className="launch-rail-tel__empty text-[8px] font-mono text-stealth-muted/50 px-2 py-4 text-center">
            Scanning hardware…
          </p>
        )}
      </div>
    </div>
  );
}