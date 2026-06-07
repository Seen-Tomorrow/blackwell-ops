import { useEffect, useMemo, useRef, useState } from "react";
import type { GpuInfo, StackEntry } from "../../lib/types";
import type { LabSample } from "./useTelemetryLabBuffer";
import { useTelemetry } from "../../context/TelemetryContext";
import { useFusionData } from "../../hooks/useFusionData";
import Sparkline from "./Sparkline";
import { useTelemetryLabBuffer } from "./useTelemetryLabBuffer";

type Badge = "LIVE" | "DEMO" | "HYBRID";

interface TelemetryLabProps {
  stack: StackEntry[];
}

function parseGpuIndices(gpu: string): number[] {
  return gpu
    .split(/[,\s|]+/)
    .map((s) => parseInt(s.replace(/\D/g, ""), 10))
    .filter((n) => !Number.isNaN(n));
}

function LabSection({
  id,
  title,
  badge,
  blurb,
  children,
}: {
  id: string;
  title: string;
  badge: Badge;
  blurb: string;
  children: React.ReactNode;
}) {
  const badgeClass =
    badge === "LIVE"
      ? "text-nv-green bg-nv-green/10 border-nv-green/30"
      : badge === "HYBRID"
        ? "text-telemetry-cyan bg-telemetry-cyan/10 border-telemetry-cyan/30"
        : "text-telemetry-amber bg-telemetry-amber/10 border-telemetry-amber/30";

  return (
    <section
      id={id}
      className="theme-surface rounded-sm overflow-hidden"
    >
      <header className="theme-surface-header px-4 py-2.5 border-b border-stealth-border flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[11px] font-mono text-white tracking-wider">{title}</h3>
          <p className="text-[9px] font-mono text-stealth-muted/70 mt-0.5 leading-relaxed">{blurb}</p>
        </div>
        <span className={`text-[8px] font-mono px-2 py-0.5 rounded-sm border flex-shrink-0 ${badgeClass}`}>
          {badge}
        </span>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function phaseStyle(phase: string): string {
  if (phase === "PP") return "text-telemetry-cyan border-telemetry-cyan/40 bg-telemetry-cyan/10";
  if (phase === "TG") return "text-nv-green border-nv-green/40 bg-nv-green/10";
  if (phase === "LOADING") return "text-telemetry-amber border-telemetry-amber/40 bg-telemetry-amber/10";
  return "text-stealth-muted border-stealth-border theme-surface-header";
}

function Oscilloscope({ samples, gpus }: { samples: ReturnType<typeof useTelemetryLabBuffer>["samples"]; gpus: GpuInfo[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = 640;
  const height = 140;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || samples.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#050805";
    ctx.fillRect(0, 0, width, height);

    // grid
    ctx.strokeStyle = "rgba(118,185,0,0.08)";
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 28) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const traces: { values: number[]; color: string; label: string }[] = [
      { values: samples.map((s) => s.totalPower), color: "#FFB800", label: "PWR" },
      ...gpus.map((g, i) => ({
        values: samples.map((s) => s.gpuUtil[i] ?? 0),
        color: i % 2 === 0 ? "#76B900" : "#00e5ff",
        label: `U${g.index}`,
      })),
      { values: samples.map((s) => s.fusionTps), color: "#ff6b9d", label: "TPS" },
      { values: samples.map((s) => s.cpuAvg), color: "#a78bfa", label: "CPU" },
    ];

    traces.forEach((trace, ti) => {
      const vals = trace.values;
      const max = Math.max(...vals, 1);
      ctx.strokeStyle = trace.color;
      ctx.lineWidth = 1.25;
      ctx.globalAlpha = 0.55 + (ti === 0 ? 0.35 : 0);
      ctx.beginPath();
      vals.forEach((v, i) => {
        const x = (i / (vals.length - 1)) * (width - 8) + 4;
        const y = height - 8 - (v / max) * (height - 16);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    // phosphor fade overlay
    const grad = ctx.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0, "rgba(118,185,0,0.04)");
    grad.addColorStop(1, "rgba(0,0,0,0.15)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }, [samples, gpus]);

  return (
    <div>
      <canvas ref={canvasRef} width={width} height={height} className="w-full rounded-sm border border-stealth-border" />
      <div className="flex flex-wrap gap-3 mt-2">
        {[
          { c: "#FFB800", l: "TOTAL PWR" },
          { c: "#76B900", l: "GPU UTIL" },
          { c: "#00e5ff", l: "GPU UTIL (alt)" },
          { c: "#ff6b9d", l: "FUSION TPS" },
          { c: "#a78bfa", l: "CPU AVG" },
        ].map((t) => (
          <span key={t.l} className="text-[8px] font-mono flex items-center gap-1 text-stealth-muted/70">
            <span className="w-2 h-2 rounded-full" style={{ background: t.c }} />
            {t.l}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function TelemetryLab({ stack }: TelemetryLabProps) {
  const { gpus, cpu, systemInfo } = useTelemetry();
  const { engines, getEngine } = useFusionData();
  const [demoTick, setDemoTick] = useState(0);
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef<LabSample[]>([]);

  const fusionTps = useMemo(() => {
    let max = 0;
    for (const e of engines) {
      max = Math.max(max, e.genTps || 0, e.prefillTpsSession || 0);
    }
    return max;
  }, [engines]);

  const { samples, ewmaTemps, thermalEta } = useTelemetryLabBuffer(gpus, cpu, fusionTps);

  useEffect(() => {
    const id = window.setInterval(() => setDemoTick((t) => t + 1), 500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (recording && samples.length > 0) {
      recordingRef.current = [...recordingRef.current.slice(-500), samples[samples.length - 1]];
    }
  }, [samples, recording]);

  const runningEngines = useMemo(
    () => stack.filter((s) => s.status === "RUNNING" || s.status === "LOADING"),
    [stack],
  );

  const engineByGpu = useMemo(() => {
    const map = new Map<number, { alias: string; vramMib: number; color: string }[]>();
    const colors = ["#76B900", "#00e5ff", "#FFB800", "#ff6b9d", "#a78bfa"];
    runningEngines.forEach((eng, ei) => {
      const indices = parseGpuIndices(eng.gpu);
      const share = indices.length > 0 ? (eng.vram_mib ?? 0) / indices.length : 0;
      indices.forEach((idx) => {
        const list = map.get(idx) ?? [];
        list.push({ alias: eng.alias, vramMib: share, color: colors[ei % colors.length] });
        map.set(idx, list);
      });
    });
    return map;
  }, [runningEngines]);

  const isLoading = runningEngines.some((s) => s.status === "LOADING");
  const ramUsedMib = systemInfo
    ? systemInfo.total_memory_mib - systemInfo.available_memory_mib
    : 0;
  const ramUsedPct = systemInfo && systemInfo.total_memory_mib > 0
    ? (ramUsedMib / systemInfo.total_memory_mib) * 100
    : 0;

  const catalogNav = [
    { id: "lab-sparklines", label: "01 SPARKLINES" },
    { id: "lab-vram-stack", label: "02 VRAM STACK" },
    { id: "lab-fusion", label: "03 FUSION ROW" },
    { id: "lab-phase", label: "04 PHASE" },
    { id: "lab-power", label: "05 POWER CAP" },
    { id: "lab-correlation", label: "06 CPU×GPU" },
    { id: "lab-ram", label: "07 RAM" },
    { id: "lab-nvme", label: "08 NVMe" },
    { id: "lab-fan", label: "09 FAN/CLK" },
    { id: "lab-scope", label: "10 SCOPE" },
    { id: "lab-nvlink", label: "11 NVLink" },
    { id: "lab-thermal", label: "12 THERMAL" },
    { id: "lab-recorder", label: "13 RECORDER" },
  ];

  const downloadRecording = () => {
    const blob = new Blob(
      [recordingRef.current.map((s) => JSON.stringify(s)).join("\n")],
      { type: "application/x-ndjson" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `telemetry-lab-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col min-h-0 gap-3">
      <div className="flex-shrink-0 border border-yellow-400/30 bg-yellow-400/5 rounded-sm px-4 py-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xs font-mono text-yellow-400 tracking-wider">TELEMETRY LAB</h2>
            <p className="text-[9px] font-mono text-stealth-muted/80 mt-1 max-w-2xl">
              Power-user idea catalogue — isolated module, zero hooks into catalog/config/fusion pipeline.
              Regular users still see standard TELEMETRY when admin is locked.
            </p>
          </div>
          <div className="flex items-center gap-2 text-[8px] font-mono">
            <span className="px-2 py-0.5 rounded-sm border text-nv-green border-nv-green/30 bg-nv-green/10">LIVE</span>
            <span className="px-2 py-0.5 rounded-sm border text-telemetry-cyan border-telemetry-cyan/30 bg-telemetry-cyan/10">HYBRID</span>
            <span className="px-2 py-0.5 rounded-sm border text-telemetry-amber border-telemetry-amber/30 bg-telemetry-amber/10">DEMO</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-3">
          {catalogNav.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="text-[8px] font-mono px-2 py-0.5 rounded-sm border border-stealth-border text-stealth-muted hover:text-nv-green hover:border-nv-green/40 transition-colors"
            >
              {item.label}
            </a>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pb-6">
        <LabSection
          id="lab-sparklines"
          title="01 — Rolling sparklines"
          badge="LIVE"
          blurb="Ring buffer (~30s). Power, VRAM %, GPU util per device."
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {gpus.map((gpu, gi) => (
              <div key={gpu.index} className="theme-surface-row rounded-sm p-3">
                <p className="text-[9px] font-mono text-white mb-2 truncate">GPU-{gpu.index} · {gpu.name}</p>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <p className="text-[7px] font-mono text-stealth-muted/60 mb-1">POWER W</p>
                    <Sparkline values={samples.map((s) => s.gpuPower[gi] ?? 0)} color="#FFB800" fill />
                    <p className="text-[9px] font-mono text-telemetry-amber mt-1">{gpu.power_draw.toFixed(0)}W</p>
                  </div>
                  <div>
                    <p className="text-[7px] font-mono text-stealth-muted/60 mb-1">VRAM %</p>
                    <Sparkline values={samples.map((s) => s.gpuVramPct[gi] ?? 0)} color="#76B900" fill />
                    <p className="text-[9px] font-mono text-nv-green mt-1">
                      {gpu.memory_total > 0 ? ((gpu.memory_used / gpu.memory_total) * 100).toFixed(0) : 0}%
                    </p>
                  </div>
                  <div>
                    <p className="text-[7px] font-mono text-stealth-muted/60 mb-1">UTIL %</p>
                    <Sparkline values={samples.map((s) => s.gpuUtil[gi] ?? 0)} color="#00e5ff" fill />
                    <p className="text-[9px] font-mono text-telemetry-cyan mt-1">{gpu.utilization_gpu}%</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </LabSection>

        <LabSection
          id="lab-vram-stack"
          title="02 — Engine-attributed VRAM"
          badge="HYBRID"
          blurb="Live VRAM bar + engine slices from stack (vram_mib split across GPU mask)."
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {gpus.map((gpu) => {
              const enginesOnGpu = engineByGpu.get(gpu.index) ?? [];
              const engineMib = enginesOnGpu.reduce((s, e) => s + e.vramMib, 0);
              const totalMib = gpu.memory_total || 1;
              const osMib = Math.max(0, gpu.memory_used - engineMib);
              const osPct = (osMib / totalMib) * 100;
              let cursor = osPct;
              return (
                <div key={gpu.index} className="theme-surface-row rounded-sm p-3">
                  <div className="flex justify-between text-[9px] font-mono mb-2">
                    <span className="text-white">GPU-{gpu.index}</span>
                    <span className="text-stealth-muted">{(gpu.memory_used / 1024).toFixed(1)} GB used</span>
                  </div>
                  <div className="h-3 theme-bar-track rounded-sm overflow-hidden flex">
                    <div style={{ width: `${Math.min(osPct, 100)}%` }} className="h-full bg-white/15" title="OS + other" />
                    {enginesOnGpu.map((eng) => {
                      const w = (eng.vramMib / totalMib) * 100;
                      const el = (
                        <div
                          key={eng.alias}
                          style={{ width: `${Math.min(w, 100 - cursor)}%`, background: eng.color }}
                          className="h-full opacity-80"
                          title={`${eng.alias} ~${(eng.vramMib / 1024).toFixed(1)} GB`}
                        />
                      );
                      cursor += w;
                      return el;
                    })}
                  </div>
                  <div className="flex flex-wrap gap-2 mt-2">
                    <span className="text-[8px] font-mono text-stealth-muted/60">OS/other</span>
                    {enginesOnGpu.map((eng) => (
                      <span key={eng.alias} className="text-[8px] font-mono" style={{ color: eng.color }}>
                        {eng.alias}
                      </span>
                    ))}
                    {enginesOnGpu.length === 0 && (
                      <span className="text-[8px] font-mono text-stealth-muted/40 italic">no running engines on this GPU</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </LabSection>

        <LabSection
          id="lab-fusion"
          title="03 — Hardware + inference row"
          badge="HYBRID"
          blurb="Per-slot fusion metrics beside live GPU power/VRAM (when engines support fusion)."
        >
          {runningEngines.length === 0 ? (
            <p className="text-[10px] font-mono text-stealth-muted/50 italic">Launch an engine to populate this row.</p>
          ) : (
            <div className="space-y-2">
              {runningEngines.map((eng) => {
                const fusion = getEngine(eng.idx);
                const gpuIdx = parseGpuIndices(eng.gpu)[0] ?? 0;
                const gpu = gpus.find((g) => g.index === gpuIdx);
                const tps = fusion?.genTps || fusion?.prefillTpsSession || 0;
                const watts = gpu?.power_draw ?? 0;
                const eff = watts > 0 ? (tps / watts).toFixed(2) : "—";
                return (
                  <div key={eng.idx} className="theme-surface-row grid grid-cols-12 gap-2 items-center rounded-sm px-3 py-2 text-[9px] font-mono">
                    <span className="col-span-2 text-nv-green truncate">{eng.alias}</span>
                    <span className="col-span-1 text-stealth-muted">GPU{gpuIdx}</span>
                    <span className="col-span-2 text-telemetry-amber">{watts.toFixed(0)}W</span>
                    <span className="col-span-2 text-white">{gpu ? `${(gpu.memory_used / 1024).toFixed(1)}G` : "—"}</span>
                    <span className="col-span-2 text-telemetry-cyan">{fusion ? `${tps.toFixed(1)} t/s` : "no fusion"}</span>
                    <span className="col-span-3 text-stealth-muted/70">{eff} tok/W · {fusion?.phase ?? "—"}</span>
                  </div>
                );
              })}
            </div>
          )}
        </LabSection>

        <LabSection
          id="lab-phase"
          title="04 — Phase detector"
          badge="LIVE"
          blurb="Fused lifecycle from Fusion brain — IDLE / PP / TG per slot."
        >
          <div className="flex flex-wrap gap-2">
            {runningEngines.length === 0 ? (
              <span className={`text-[10px] font-mono px-3 py-1.5 rounded-sm border ${phaseStyle("IDLE")}`}>SYSTEM IDLE</span>
            ) : (
              runningEngines.map((eng) => {
                const fusion = getEngine(eng.idx);
                const phase = eng.status === "LOADING" ? "LOADING" : (fusion?.phase ?? "IDLE");
                return (
                  <div key={eng.idx} className={`text-[10px] font-mono px-3 py-1.5 rounded-sm border ${phaseStyle(phase)}`}>
                    {eng.alias} · {phase}
                    {fusion && phase === "PP" && (
                      <span className="ml-2 opacity-70">{Math.round((fusion.prefillProgress ?? 0) * 100)}%</span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </LabSection>

        <LabSection
          id="lab-power"
          title="05 — Power budget headroom"
          badge="LIVE"
          blurb="Draw vs limit — time-at-cap proxy from recent samples."
        >
          <div className="grid grid-cols-2 gap-3">
            {gpus.map((gpu, gi) => {
              const pct = gpu.power_limit > 0 ? (gpu.power_draw / gpu.power_limit) * 100 : 0;
              const recent = samples.slice(-20).map((s) => s.gpuPower[gi] ?? 0);
              const atCap = gpu.power_limit > 0
                ? recent.filter((p) => p >= gpu.power_limit * 0.95).length
                : 0;
              const headroom = Math.max(0, gpu.power_limit - gpu.power_draw);
              return (
                <div key={gpu.index} className="theme-surface-row rounded-sm p-3">
                  <div className="flex justify-between text-[9px] font-mono mb-2">
                    <span>GPU-{gpu.index}</span>
                    <span className={pct > 95 ? "text-telemetry-amber" : "text-white"}>{pct.toFixed(0)}% of cap</span>
                  </div>
                  <div className="h-2 theme-bar-track rounded-sm overflow-hidden">
                    <div
                      className={`h-full ${pct > 95 ? "bg-telemetry-amber" : "bg-nv-green"}`}
                      style={{ width: `${Math.min(pct, 100)}%` }}
                    />
                  </div>
                  <p className="text-[8px] font-mono text-stealth-muted/60 mt-2">
                    {headroom.toFixed(0)}W headroom · {atCap}/20 samples near cap
                  </p>
                </div>
              );
            })}
          </div>
        </LabSection>

        <LabSection
          id="lab-correlation"
          title="06 — CPU × GPU correlation"
          badge="LIVE"
          blurb="Side-by-side: CPU core heat strip + GPU util — spot CPU-bound load (spill / loader threads)."
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <p className="text-[8px] font-mono text-stealth-muted/60 mb-2">CPU CORES (live)</p>
              {cpu ? (
                <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${Math.min(cpu.threads, 16)}, 1fr)` }}>
                  {cpu.core_usages.map((u, i) => (
                    <div key={i} className="h-5 theme-bar-track rounded-sm overflow-hidden" title={`core ${i}: ${u.toFixed(0)}%`}>
                      <div
                        className={`h-full ${u > 80 ? "bg-orange-600" : u > 40 ? "bg-white/25" : "bg-white/10"}`}
                        style={{ width: `${Math.min(u, 100)}%` }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[9px] font-mono text-stealth-muted/40">waiting for CPU sample…</p>
              )}
              <p className="text-[8px] font-mono text-stealth-muted/50 mt-2">AVG {cpu ? Math.round(cpu.avg_usage_percent) : 0}%</p>
            </div>
            <div>
              <p className="text-[8px] font-mono text-stealth-muted/60 mb-2">GPU UTIL (live)</p>
              <div className="space-y-2">
                {gpus.map((g) => (
                  <div key={g.index} className="flex items-center gap-2">
                    <span className="text-[8px] font-mono text-stealth-muted w-10">G{g.index}</span>
                    <div className="flex-1 h-4 theme-bar-track rounded-sm overflow-hidden">
                      <div className="h-full bg-telemetry-cyan/80" style={{ width: `${g.utilization_gpu}%` }} />
                    </div>
                    <span className="text-[8px] font-mono text-white w-8">{g.utilization_gpu}%</span>
                  </div>
                ))}
              </div>
              <p className="text-[8px] font-mono text-stealth-muted/50 mt-2 italic">
                High CPU + low GPU → likely host offload or I/O bound
              </p>
            </div>
          </div>
        </LabSection>

        <LabSection
          id="lab-ram"
          title="07 — System RAM pressure"
          badge="HYBRID"
          blurb="Used/available from sysinfo (live). Commit & pagefile bars are simulated placeholders."
        >
          {systemInfo ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <p className="text-[8px] font-mono text-stealth-muted">USED</p>
                  <p className="text-sm font-mono text-white">{(ramUsedMib / 1024).toFixed(1)} GB</p>
                </div>
                <div>
                  <p className="text-[8px] font-mono text-stealth-muted">AVAILABLE</p>
                  <p className="text-sm font-mono text-electric-blue">{(systemInfo.available_memory_mib / 1024).toFixed(1)} GB</p>
                </div>
                <div>
                  <p className="text-[8px] font-mono text-stealth-muted">MFG</p>
                  <p className="text-sm font-mono text-nv-green">{(systemInfo.total_memory_manufactured_mib / 1024).toFixed(0)} GB</p>
                </div>
              </div>
              <div>
                <p className="text-[8px] font-mono text-stealth-muted/60 mb-1">PHYSICAL USE {ramUsedPct.toFixed(0)}%</p>
                <div className="h-2 theme-bar-track rounded-sm overflow-hidden">
                  <div className="h-full bg-electric-blue/70" style={{ width: `${Math.min(ramUsedPct, 100)}%` }} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 opacity-60">
                <div>
                  <p className="text-[8px] font-mono text-telemetry-amber/80 mb-1">COMMIT CHARGE (demo)</p>
                  <div className="h-1.5 theme-bar-track rounded-sm"><div className="h-full bg-telemetry-amber/50 w-[62%]" /></div>
                </div>
                <div>
                  <p className="text-[8px] font-mono text-telemetry-amber/80 mb-1">PAGE FILE (demo)</p>
                  <div className="h-1.5 theme-bar-track rounded-sm"><div className="h-full bg-telemetry-amber/50 w-[18%]" /></div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-[9px] font-mono text-stealth-muted/40">loading system info…</p>
          )}
        </LabSection>

        <LabSection
          id="lab-nvme"
          title="08 — NVMe / model I/O pulse"
          badge="DEMO"
          blurb="Animated read pulse when any engine is LOADING — real disk counters need a new scan command."
        >
          <div className="flex items-center gap-4">
            <div className={`w-3 h-3 rounded-full ${isLoading ? "bg-nv-green animate-pulse" : "bg-stealth-muted/30"}`} />
            <div className="flex-1">
              <p className="text-[9px] font-mono text-white mb-2">
                {isLoading ? "MODEL LOAD ACTIVE" : "IDLE — no LOADING engines"}
              </p>
              <div className="h-2 theme-bar-track rounded-sm overflow-hidden">
                <div
                  className="h-full bg-nv-green transition-all duration-300"
                  style={{
                    width: isLoading
                      ? `${40 + Math.sin(demoTick * 0.8) * 30 + 30}%`
                      : `${5 + demoTick % 3}%`,
                  }}
                />
              </div>
              <p className="text-[8px] font-mono text-stealth-muted/50 mt-1">
                demo {(1200 + Math.sin(demoTick) * 400).toFixed(0)} MB/s read
              </p>
            </div>
          </div>
        </LabSection>

        <LabSection
          id="lab-fan"
          title="09 — Fan RPM & SM clock"
          badge="DEMO"
          blurb="NVIDIA blocked mem temps; fan/clock via NVML would be a small backend add-on. Simulated motion for layout."
        >
          <div className="grid grid-cols-2 gap-3">
            {gpus.map((gpu, gi) => {
              const fan = Math.round(1800 + gpu.utilization_gpu * 12 + Math.sin(demoTick + gi) * 80);
              const clock = Math.round(1800 + gpu.utilization_gpu * 8 + Math.cos(demoTick * 0.5 + gi) * 120);
              return (
                <div key={gpu.index} className="theme-surface-row rounded-sm p-3 text-[9px] font-mono">
                  <p className="text-white mb-2">GPU-{gpu.index}</p>
                  <p className="text-stealth-muted">FAN <span className="text-telemetry-cyan">{fan}</span> RPM</p>
                  <p className="text-stealth-muted mt-1">SM CLK <span className="text-nv-green">{clock}</span> MHz</p>
                </div>
              );
            })}
          </div>
        </LabSection>

        <LabSection
          id="lab-scope"
          title="10 — Multi-trace oscilloscope"
          badge="LIVE"
          blurb="Shared time axis — power, per-GPU util, fusion TPS, CPU avg from ring buffer."
        >
          <Oscilloscope samples={samples} gpus={gpus} />
        </LabSection>

        <LabSection
          id="lab-nvlink"
          title="11 — NVLink / P2P topology"
          badge="DEMO"
          blurb="Animated interconnect when multi-GPU — real P2P status needs nvidia-smi topo -m backend."
        >
          {gpus.length < 2 ? (
            <p className="text-[9px] font-mono text-stealth-muted/50">Need 2+ GPUs for topology demo.</p>
          ) : (
            <div className="theme-surface-inset relative h-32 rounded-sm">
              <svg className="absolute inset-0 w-full h-full" viewBox="0 0 400 120">
                {gpus.slice(0, 4).map((g, i, arr) => {
                  const x = 60 + i * (280 / Math.max(arr.length - 1, 1));
                  const y = 60;
                  return (
                    <g key={g.index}>
                      {i < arr.length - 1 && (
                        <line
                          x1={x + 20}
                          y1={y}
                          x2={x + (280 / Math.max(arr.length - 1, 1)) - 20}
                          y2={y}
                          stroke="#76B900"
                          strokeWidth="2"
                          strokeDasharray="6 4"
                          opacity={0.4 + Math.sin(demoTick + i) * 0.2}
                        />
                      )}
                      <rect x={x - 24} y={y - 18} width="48" height="36" rx="2" fill="#111810" stroke="#1a2e1a" />
                      <text x={x} y={y + 4} textAnchor="middle" fill="#76B900" fontSize="10" fontFamily="monospace">
                        G{g.index}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <p className="absolute bottom-2 left-3 text-[8px] font-mono text-stealth-muted/50">
                dashed links pulse with demo traffic · util {gpus[0]?.utilization_gpu ?? 0}%
              </p>
            </div>
          )}
        </LabSection>

        <LabSection
          id="lab-thermal"
          title="12 — Thermal inertia / ETA"
          badge="LIVE"
          blurb="EWMA-smoothed core temp + rough minutes-to-90°C heuristic from power draw."
        >
          <div className="grid grid-cols-2 gap-3">
            {gpus.map((gpu, gi) => (
              <div key={gpu.index} className="theme-surface-row rounded-sm p-3 text-[9px] font-mono">
                <p className="text-white">GPU-{gpu.index} · {gpu.temperature_gpu}°C raw</p>
                <p className="text-stealth-muted mt-1">EWMA {ewmaTemps[gi]?.toFixed(1) ?? "—"}°C</p>
                <p className="text-stealth-muted mt-1">
                  ETA →90°C:{" "}
                  <span className={thermalEta[gi] < 30 ? "text-telemetry-amber" : "text-nv-green"}>
                    {thermalEta[gi] >= 999 ? "stable" : `~${thermalEta[gi]} min`}
                  </span>
                </p>
              </div>
            ))}
          </div>
        </LabSection>

        <LabSection
          id="lab-recorder"
          title="13 — Session recorder"
          badge="HYBRID"
          blurb="Record ring-buffer samples to JSONL for offline replay / bench compare."
        >
          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={() => {
                if (recording) {
                  setRecording(false);
                } else {
                  recordingRef.current = [];
                  setRecording(true);
                }
              }}
              className={`px-3 py-1.5 text-[9px] font-mono rounded-sm border transition-colors ${
                recording
                  ? "border-telemetry-red/50 text-telemetry-red bg-telemetry-red/10"
                  : "border-nv-green/40 text-nv-green hover:bg-nv-green/10"
              }`}
            >
              {recording ? "● REC STOP" : "○ REC START"}
            </button>
            <button
              type="button"
              onClick={downloadRecording}
              disabled={recordingRef.current.length === 0}
              className="px-3 py-1.5 text-[9px] font-mono rounded-sm border border-stealth-border text-stealth-muted hover:text-white disabled:opacity-30"
            >
              DOWNLOAD JSONL ({recordingRef.current.length} samples)
            </button>
            <span className="text-[8px] font-mono text-stealth-muted/50">
              {recording ? "appending live samples…" : "idle"}
            </span>
          </div>
        </LabSection>
      </div>
    </div>
  );
}