import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { VramManifest } from "../lib/types";

interface VramDiagnosticsProps {
  modelPath: string | null;
  manifest: VramManifest | null;
}

interface FitScanPoint {
  label: string;
  vram_mib: number;
}

function calcTotals(components?: { model_mib: number; ctx_mib: number; compute_mib: number }[]) {
  if (!components?.length) return { model: 0, kv: 0, compute: 0 };
  return components.reduce(
    (s, c) => ({
      model: s.model + (c.model_mib || 0),
      kv: s.kv + (c.ctx_mib || 0),
      compute: s.compute + (c.compute_mib || 0),
    }),
    { model: 0, kv: 0, compute: 0 }
  );
}

function hasDelta(formula: number, real: number): boolean {
  if (!real || formula <= 0) return false;
  return Math.abs((real - formula) / formula) > 0.05;
}

const cellBase = "text-[8px] font-mono text-center whitespace-nowrap";
const headerBase = "text-[7px] font-mono text-black/40 tracking-wider text-center whitespace-nowrap";
const fmt = (v: number) => v.toFixed(2);

export default function VramDiagnostics({ modelPath, manifest }: VramDiagnosticsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [splitPoints, setSplitPoints] = useState<Record<string, number>>({});
  const [basePointMib, setBasePointMib] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem("BlackOps-vram-diag-collapsed") === "true") setCollapsed(true);
    } catch {}
  }, []);

  // Load FIT scan points for split mode data — independent of manifest
  const loadFitScanPoints = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const points: FitScanPoint[] | null = await invoke("get_fit_scan_points", { modelPath: path });
      if (!points?.length) return;

      const baseMib = points.find(p => p.label === "base")?.vram_mib ?? null;
      setBasePointMib(baseMib);

      const splitData: Record<string, number> = {};
      for (const label of ["split_layer", "split_row", "split_tensor"]) {
        const pt = points.find(p => p.label === label && p.vram_mib > 100);
        if (pt) {
          splitData[label.replace("split_", "")] = pt.vram_mib;
        }
      }
      setSplitPoints(splitData);
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!modelPath) {
      setSplitPoints({});
      setBasePointMib(null);
      return;
    }
    loadFitScanPoints(modelPath);
  }, [modelPath, loadFitScanPoints]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem("BlackOps-vram-diag-collapsed", String(next)); } catch {}
      return next;
    });
  }, []);

  // Data from manifest directly — no localStorage
  const hasValidation = manifest?.validatedVramMib != null && manifest.validatedVramMib > 0;
  const maxGpus = manifest?.validatedComponentsMib?.length ?? 0;

  const totals = calcTotals(manifest?.validatedComponentsMib);

  // Helper: cell value for a GPU component
  const gpuCell = (idx: number, field: "model_mib" | "ctx_mib" | "compute_mib") => {
    const c = manifest?.validatedComponentsMib?.[idx];
    return c ? fmt(c[field] / 1024) : "\u2014";
  };

  // Helper: Estimate|Real cell pair for a row
  const frPair = (formulaGb: number, realGb: number) => (
    <>
      <td className={`${cellBase} text-black/60 pr-3`}>{fmt(formulaGb)}</td>
      <td className={`${cellBase} pl-1`} style={{ color: hasDelta(formulaGb, realGb) ? "#B45309" : "rgba(0,0,0,0.7)" }}>
        {fmt(realGb)}
      </td>
    </>
  );

  // Empty cell pair placeholder
  const emptyPair = (
    <>
      <td className={`${cellBase} text-black/30 pr-3`}>—</td>
      <td className={`${cellBase} text-black/30 pl-1`}>—</td>
    </>
  );

  // Empty GPU cells placeholder
  const emptyGpus = Array.from({ length: maxGpus }).map((_, i) => (
    <td key={i} className={`${cellBase} text-black/30`}>—</td>
  ));

  // Split mode cell — shows total GB + delta from baseline (returns content only, wrapped in <td> by caller)
  const splitCellContent = (mode: "layer" | "row" | "tensor") => {
    const val = splitPoints[mode];
    if (!val) return "\u2014";
    const gb = val / 1024;
    const delta = basePointMib ? ((val - basePointMib) / 1024) : null;
    const deltaColor = delta && delta > 0 ? "#B45309" : "rgba(0,0,0,0.5)";
    return (
      <span>
        {fmt(gb)}{delta !== null ? <span style={{ color: deltaColor }}> ({delta > 0 ? "+" : ""}{fmt(delta)})</span> : ""}
      </span>
    );
  };

  const hasAnyData = hasValidation || Object.keys(splitPoints).length > 0;

  return (
    <div className="w-full bg-neutral-200 text-black">
      <button
        onClick={toggleCollapsed}
        className="w-full flex items-center justify-between px-4 py-2 hover:bg-neutral-300/50 transition-colors"
      >
        <span className="text-[9px] font-mono tracking-widest uppercase">Memory Forecast Diagnostics</span>
        <span className="text-[10px] font-mono">{collapsed ? "\u25B6" : "\u25BC"}</span>
      </button>

      {!collapsed && (
        <div className="px-4 py-3">
          {!modelPath ? (
            <div className="text-[8px] font-mono text-black/50 italic">Select a model first</div>
          ) : !hasAnyData ? (
            <div className="text-[8px] font-mono text-black/50 italic">Run ESTIMATE to compare formula vs reality</div>
          ) : (
            <div className="space-y-1">
              {/* ── Refresh button for split data ── */}
              {modelPath && Object.keys(splitPoints).length > 0 ? (
                <div className="flex items-center justify-end px-2 py-1">
                  <button onClick={() => loadFitScanPoints(modelPath)} disabled={loading} className="text-[8px] font-mono text-black/40 hover:text-black/70 transition-colors disabled:opacity-30" title="Refresh split mode measurements">
                    {loading ? "⟳" : "↻"} Refresh split data
                  </button>
                </div>
              ) : null}

              <table className="w-full border-collapse" cellPadding={2} cellSpacing={0}>
                {/* ── Header rows ── */}
                <thead>
                  <tr>
                    <th rowSpan={2} className={`${headerBase} text-left pr-3`}>Component</th>
                    <th colSpan={(maxGpus + 2)} className={`${headerBase} border-b border-black/15 pb-0.5`}>Regular</th>
                    <th colSpan={3} className={`${headerBase} text-purple-700 border-b border-black/15 pb-0.5 pl-3`}>Split Modes</th>
                  </tr>
                  <tr>
                    {/* Regular sub-headers */}
                    <th className={`${headerBase} pr-2`}>Estimate</th>
                    <th className={`${headerBase} pl-1 pb-0.5`}>Real</th>
                    {Array.from({ length: maxGpus }).map((_, i) => (
                      <th key={`r-${i}`} className={headerBase}>GPU{i}</th>
                    ))}
                    {/* Split mode sub-headers */}
                    <th className={`${headerBase} pr-2 pl-3`}>Layer</th>
                    <th className={`${headerBase} pl-1 pb-0.5`}>Row</th>
                    <th className={headerBase}>Tensor</th>
                  </tr>
                </thead>

                {/* ── Data rows ── */}
                <tbody>
                  {/* Weights */}
                  <tr>
                    <td className={`${cellBase} text-left font-semibold text-black/70 pr-3`}>Weights</td>
                    {hasValidation ? frPair(manifest!.vramWeightsGb, totals.model / 1024) : emptyPair}
                    {Array.from({ length: maxGpus }).map((_, i) => (
                      <td key={i} className={cellBase}>{gpuCell(i, "model_mib")}</td>
                    ))}
                    <td className={`${cellBase} text-black/20`}>—</td>
                    <td className={cellBase}>—</td>
                    <td className={cellBase}>—</td>
                  </tr>

                  {/* KV Cache */}
                  <tr>
                    <td className={`${cellBase} text-left font-semibold text-black/70 pr-3`}>KV Cache</td>
                    {hasValidation ? frPair(manifest!.vramKvGb, totals.kv / 1024) : emptyPair}
                    {Array.from({ length: maxGpus }).map((_, i) => (
                      <td key={i} className={cellBase}>{gpuCell(i, "ctx_mib")}</td>
                    ))}
                    <td className={`${cellBase} text-black/20`}>—</td>
                    <td className={cellBase}>—</td>
                    <td className={cellBase}>—</td>
                  </tr>

                  {/* Overhead */}
                  <tr>
                    <td className={`${cellBase} text-left font-semibold text-black/70 pr-3`}>Overhead</td>
                    {hasValidation ? frPair(manifest!.vramOverheadGb, totals.compute / 1024) : emptyPair}
                    {Array.from({ length: maxGpus }).map((_, i) => (
                      <td key={i} className={cellBase}>{gpuCell(i, "compute_mib")}</td>
                    ))}
                    <td className={`${cellBase} text-black/20`}>—</td>
                    <td className={cellBase}>—</td>
                    <td className={cellBase}>—</td>
                  </tr>

                  {/* ── Total row ── */}
                  <tr className="border-t border-black/20">
                    <td className={`${cellBase} text-left font-bold text-black/60 pr-3 pt-1`}>Total</td>
                    {hasValidation ? (
                      <>
                        <td className={`${cellBase} text-black/70 pr-3 pt-1`}>{fmt(manifest!.formulaVramTotalGb)}</td>
                        <td className={`${cellBase} pl-1 pt-1`} style={{ color: "#B45309" }}>{fmt(manifest!.validatedVramMib! / 1024)}</td>
                      </>
                    ) : emptyPair}
                    {Array.from({ length: maxGpus }).map((_, i) => {
                      const c = manifest?.validatedComponentsMib?.[i];
                      return (
                        <td key={i} className={`${cellBase} text-black/60 pt-1`}>
                          {c ? fmt((c.model_mib + c.ctx_mib + c.compute_mib) / 1024) : "—"}
                        </td>
                      );
                    })}
                    <td className={`${cellBase} pl-3 pt-1`}>{splitCellContent("layer")}</td>
                    <td className={cellBase}>{splitCellContent("row")}</td>
                    <td className={cellBase}>{splitCellContent("tensor")}</td>
                  </tr>

                  {/* ── Scale Factor row ── */}
                  <tr>
                    <td className={`${cellBase} text-left text-black/50 pr-3`}>Scale</td>
                    {hasValidation ? (
                      <>
                        <td colSpan={2} className={`${cellBase} pt-1`} style={{ color: "#B45309" }}>
                          {(manifest!.validatedVramMib! / 1024 / manifest!.formulaVramTotalGb).toFixed(3)}x
                        </td>
                      </>
                    ) : (
                      <>
                        <td className={cellBase}>—</td>
                        <td className={cellBase}>—</td>
                      </>
                    )}
                    {emptyGpus}
                    <td className={`${cellBase} pt-1 pl-3 text-black/20`}>—</td>
                    <td className={cellBase}>—</td>
                    <td className={cellBase}>—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
