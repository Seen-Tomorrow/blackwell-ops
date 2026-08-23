import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { CpuInfo, GpuInfo, SystemInfo } from "../lib/types";
import { useDisplayTexture } from "../context/DisplayTextureContext";
import { useTelemetry } from "../context/TelemetryContext";
import { useGpuControl } from "../hooks/useGpuControl";
import {
  loadHwMonitorCpuCoresOpen,
  loadHwMonitorDim,
  saveHwMonitorCpuCoresOpen,
  saveHwMonitorDim,
} from "../lib/storage";
import CpuCoreGrid from "./CpuCoreGrid";
import GpuOverclockPanel from "./GpuOverclockPanel";
import GpuTopologyCard from "./GpuTopologyCard";

const TEL_WIDGET_SURFACE = "phosphor-display-surface";

function MemTotals({
  gpus,
  systemInfo,
  children,
}: {
  gpus: GpuInfo[];
  systemInfo: SystemInfo | null;
  children?: ReactNode;
}) {
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
      {children}
    </div>
  );
}

function cpuAvgBarClass(avg: number): string {
  if (avg > 85) return "launch-rail-tel__cpu-avg-fill--critical";
  if (avg > 60) return "launch-rail-tel__cpu-avg-fill--high";
  return "launch-rail-tel__cpu-avg-fill--normal";
}

/** Live MHz (PDH) first; base is WMI MaxClockSpeed (often sticky). */
function formatCpuClock(cpu: CpuInfo): string {
  const cur = cpu.current_clock_mhz ?? 0;
  const base = cpu.max_clock_mhz ?? 0;
  if (cur > 0 && base > 0 && Math.abs(cur - base) > 25) {
    return `${cur} MHz`;
  }
  if (cur > 0) return `${cur} MHz`;
  if (base > 0) return `${base} MHz`;
  return "— MHz";
}

function cpuClockTitle(cpu: CpuInfo): string {
  const cur = cpu.current_clock_mhz ?? 0;
  const base = cpu.max_clock_mhz ?? 0;
  if (cur > 0 && base > 0) {
    return `Live ~${cur} MHz (PDH % performance × base) · base ${base} MHz`;
  }
  if (cur > 0) return `Live ~${cur} MHz`;
  if (base > 0) return `Base ${base} MHz (live PDH unavailable)`;
  return "CPU clock unavailable";
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
  const liveMhz = cpu.current_clock_mhz ?? 0;
  const baseMhz = cpu.max_clock_mhz ?? 0;
  // Cores open → hero readout is live frequency; closed → average usage %.
  const heroVal = coresOpen
    ? liveMhz > 0
      ? String(liveMhz)
      : baseMhz > 0
        ? String(baseMhz)
        : "—"
    : String(avg);
  const heroUnit = coresOpen ? "MHz" : "%";
  const heroTitle = coresOpen
    ? cpuClockTitle(cpu)
    : `Average utilization ${avg}%`;

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
          <p className="launch-rail-tel__cpu-meta" title={cpuClockTitle(cpu)}>
            {cpu.cores}C/{cpu.threads}T
            {coresOpen
              ? avg >= 0
                ? ` · ${avg}%`
                : ""
              : ` · ${formatCpuClock(cpu)}`}
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
          <div
            className={`launch-rail-tel__cpu-avg${
              coresOpen ? " launch-rail-tel__cpu-avg--mhz" : ""
            }`}
            title={heroTitle}
          >
            <span className="launch-rail-tel__cpu-avg-val">{heroVal}</span>
            <span className="launch-rail-tel__cpu-avg-unit">{heroUnit}</span>
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

export default function LaunchRailTelemetry({
  layout = "rail",
}: {
  layout?: "rail" | "below";
} = {}) {
  const { gpus, cpu, systemInfo } = useTelemetry();
  const { texture: displayTexture } = useDisplayTexture();
  const below = layout === "below";
  const [cpuCoresOpen, setCpuCoresOpen] = useState(() =>
    loadHwMonitorCpuCoresOpen()
  );
  /** User cores pref while OC is open — restored on OC collapse. */
  const coresPrefBeforeOcRef = useRef(loadHwMonitorCpuCoresOpen());
  const [ocExpanded, setOcExpanded] = useState(false);
  /** below: OC panel expands from the badge, no overlay. */
  const [ocPopoverOpen, setOcPopoverOpen] = useState(false);
  /** Opacity of HW body + OC (not launch block). 1 = full, 0.2 = min dim. */
  const [hwDim, setHwDim] = useState(loadHwMonitorDim);
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
    if (below) {
      if (!open) setOcPopoverOpen(false);
      return;
    }
    if (open) {
      // Free vertical room at high zoom — temp collapse cores (keep user pref).
      coresPrefBeforeOcRef.current = loadHwMonitorCpuCoresOpen();
      setCpuCoresOpen(false);
    } else {
      setCpuCoresOpen(coresPrefBeforeOcRef.current);
    }
  }, [below]);

  useEffect(() => {
    if (!ocPopoverOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOcPopoverOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ocPopoverOpen]);


  const onHwDimChange = useCallback((value: number) => {
    const next = Math.min(1, Math.max(0.2, value));
    setHwDim(next);
    saveHwMonitorDim(next);
  }, []);

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

  const hasGpus = gpus.length > 0;

  // below: badge expands the OC panel in-place above the totals stack.
  const ocBadge =
    below && hasGpus ? (
      <div className="launch-rail-tel__oc-slot">
        {ocPopoverOpen ? (
          <div className="launch-rail-tel__oc-popover" role="region" aria-label="GPU overclock">
            <GpuOverclockPanel
              layout="rail"
              {...ocPanelProps}
              defaultExpanded
              onExpandedChange={handleOcExpandedChange}
            />
          </div>
        ) : null}
        <button
          type="button"
          className={`launch-rail-tel__oc-badge ${TEL_WIDGET_SURFACE}${
            ocActive ? " launch-rail-tel__oc-badge--active" : ""
          }${ocPopoverOpen ? " launch-rail-tel__oc-badge--open" : ""}`}
          onClick={() => setOcPopoverOpen((v) => !v)}
          aria-expanded={ocPopoverOpen}
          title={ocActive ? "OVERCLOCK ACTIVE — collapse OC panel" : "Expand OC panel"}
        >
          <span className="launch-rail-tel__oc-badge-label">OC · OVERCLOCK</span>
          <span className="launch-rail-tel__oc-badge-hint">
            {ocPopoverOpen
              ? "tap to collapse"
              : ocActive
                ? "ACTIVE · tap to tune"
                : "tap to tune"}
          </span>
        </button>
      </div>
    ) : null;

  const gpuStack = (
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
  );

  // rail: OC stays the pinned footer under the scroll area.
  const ocPin = !below && hasGpus ? (
    <div className="launch-rail-tel__oc-pin shrink-0">
      <GpuOverclockPanel
        layout="rail"
        {...ocPanelProps}
        onExpandedChange={handleOcExpandedChange}
      />
    </div>
  ) : null;

  const emptyState = !cpu && gpus.length === 0 ? (
    <p className="launch-rail-tel__empty text-[8px] font-mono text-stealth-muted/50 px-2 py-4 text-center">
      Scanning hardware…
    </p>
  ) : null;

  return (
    <div
      className={`launch-rail-tel min-h-0 flex flex-col${
        layout === "below" ? " launch-rail-tel--below" : " h-full"
      }`}
      data-display-texture={displayTexture}
      data-hw-layout={layout}
      data-oc-expanded={ocExpanded || ocPopoverOpen ? "true" : "false"}
      style={{ "--hw-monitor-dim": hwDim } as CSSProperties}
    >
      <div className="launch-rail-tel__header">
        <div className="launch-rail-tel__header-left">
          <span className="launch-rail-tel__pulse" aria-hidden="true" />
          <span className="launch-rail-tel__title">HW MONITOR</span>
        </div>
        <label
          className="launch-rail-tel__dim"
          title={`HW monitor dim — ${Math.round(hwDim * 100)}% (expanded OC stays full; launch block unaffected)`}
        >
          <span className="launch-rail-tel__dim-label">DIM</span>
          <input
            type="range"
            className="launch-rail-tel__dim-slider"
            min={20}
            max={100}
            step={1}
            value={Math.round(hwDim * 100)}
            onChange={(e) => onHwDimChange(Number(e.target.value) / 100)}
            aria-label="HW monitor dim"
          />
        </label>
      </div>

      {/*
        Dim is CSS via --hw-monitor-dim on widgets (not this body). Expanded OC
        is exempt — parent opacity cannot be undone by children.
        Rail: OC pin stays flex-shrink-0 under scroll.
      */}
      <div className="launch-rail-tel__body min-h-0 flex-1">
        {below ? (
          <div className="launch-rail-tel__below-grid">
            <MemTotals gpus={gpus} systemInfo={systemInfo}>
              {ocBadge}
            </MemTotals>
            {cpu && (
              <div className="launch-rail-tel__cpu-col">
                <CpuStrip
                  cpu={cpu}
                  coresOpen={cpuCoresOpen}
                  onToggleCores={toggleCpuCores}
                />
              </div>
            )}
            {emptyState}
            {gpuStack}
          </div>
        ) : (
          <>
            <div className="launch-rail-tel__scroll min-h-0 flex-1">
              <MemTotals gpus={gpus} systemInfo={systemInfo} />
              {cpu && (
                <CpuStrip
                  cpu={cpu}
                  coresOpen={cpuCoresOpen}
                  onToggleCores={toggleCpuCores}
                />
              )}

              {gpuStack}

              {emptyState}
            </div>

            {ocPin}
          </>
        )}
      </div>
    </div>
  );
}