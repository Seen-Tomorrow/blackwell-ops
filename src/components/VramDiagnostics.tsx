import { useState, useCallback, useEffect } from "react";

interface VramDiagnosticsProps {
  modelPath: string | null;
}

interface StoredValidationData {
  validatedVramMib: number;
  validatedComponentsMib?: {
    model_mib: number;
    ctx_mib: number;
    compute_mib: number;
  }[];
  formulaVramTotalGb: number;
  vramWeightsGb: number;
  vramKvGb: number;
  vramOverheadGb: number;
}

type ModeKey = "regular" | "moe_optimal";

function loadModeData(modelPath: string, mode: ModeKey): StoredValidationData | null {
  try {
    const key = `BlackOps-vram-validate:${modelPath}:${mode}`;
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function calcTotals(data: StoredValidationData | null) {
  if (!data?.validatedComponentsMib?.length) return { model: 0, kv: 0, compute: 0 };
  return data.validatedComponentsMib.reduce(
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
const fmt = (v: number) => v.toFixed(1);

export default function VramDiagnostics({ modelPath }: VramDiagnosticsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [regular, setRegular] = useState<StoredValidationData | null>(null);
  const [moeOptimal, setMoeOptimal] = useState<StoredValidationData | null>(null);
  const [updateKey, setUpdateKey] = useState(0);

  useEffect(() => {
    try {
      if (localStorage.getItem("BlackOps-vram-diag-collapsed") === "true") setCollapsed(true);
    } catch {}
  }, []);

  useEffect(() => {
    if (!modelPath) {
      setRegular(null);
      setMoeOptimal(null);
      return;
    }
    setRegular(loadModeData(modelPath, "regular"));
    setMoeOptimal(loadModeData(modelPath, "moe_optimal"));
  }, [modelPath, updateKey]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!modelPath || (detail && detail !== modelPath)) return;
      setRegular(loadModeData(modelPath, "regular"));
      setMoeOptimal(loadModeData(modelPath, "moe_optimal"));
    };
    window.addEventListener("vram-validated", handler);
    return () => window.removeEventListener("vram-validated", handler);
  }, [modelPath]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem("BlackOps-vram-diag-collapsed", String(next)); } catch {}
      return next;
    });
  }, []);

  const hasAnyData = regular || moeOptimal;
  const maxGpus = Math.max(
    regular?.validatedComponentsMib?.length ?? 0,
    moeOptimal?.validatedComponentsMib?.length ?? 0
  );

  const regTotals = calcTotals(regular);
  const moeTotals = calcTotals(moeOptimal);

  // Helper: cell value for a mode's GPU component
  const gpuCell = (data: StoredValidationData | null, idx: number, field: "model_mib" | "ctx_mib" | "compute_mib") => {
    const c = data?.validatedComponentsMib?.[idx];
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
            <div className="text-[8px] font-mono text-black/50 italic">Run ESTIMATED to compare formula vs reality</div>
          ) : (
            <table className="w-full border-collapse" cellPadding={2} cellSpacing={0}>
              {/* ── Header rows ── */}
              <thead>
                <tr>
                  <th rowSpan={2} className={`${headerBase} text-left pr-3`}>Component</th>
                  <th colSpan={(maxGpus + 2)} className={`${headerBase} border-b border-black/15 pb-0.5`}>Regular</th>
                  <th colSpan={(maxGpus + 2)} className={`${headerBase} text-orange-700 border-b border-black/15 pb-0.5 pl-3`}>MOE_optimal</th>
                </tr>
                <tr>
                  {/* Regular sub-headers */}
                  <th className={`${headerBase} pr-2`}>Estimate</th>
                  <th className={`${headerBase} pl-1 pb-0.5`}>Real</th>
                  {Array.from({ length: maxGpus }).map((_, i) => (
                    <th key={`r-${i}`} className={headerBase}>GPU{i}</th>
                  ))}
                  {/* MOE sub-headers */}
                  <th className={`${headerBase} pr-2 pl-3`}>Estimate</th>
                  <th className={`${headerBase} pl-1 pb-0.5`}>Real</th>
                  {Array.from({ length: maxGpus }).map((_, i) => (
                    <th key={`m-${i}`} className={headerBase}>GPU{i}</th>
                  ))}
                </tr>
              </thead>

              {/* ── Data rows ── */}
              <tbody>
                {/* Weights */}
                <tr>
                  <td className={`${cellBase} text-left font-semibold text-black/70 pr-3`}>Weights</td>
                  {regular ? frPair(regular.vramWeightsGb, regTotals.model / 1024) : emptyPair}
                  {Array.from({ length: maxGpus }).map((_, i) => (
                    <td key={i} className={cellBase}>{gpuCell(regular, i, "model_mib")}</td>
                  ))}
                  {moeOptimal ? frPair(moeOptimal.vramWeightsGb, moeTotals.model / 1024) : emptyPair}
                  {Array.from({ length: maxGpus }).map((_, i) => (
                    <td key={i} className={cellBase}>{gpuCell(moeOptimal, i, "model_mib")}</td>
                  ))}
                </tr>

                {/* KV Cache */}
                <tr>
                  <td className={`${cellBase} text-left font-semibold text-black/70 pr-3`}>KV Cache</td>
                  {regular ? frPair(regular.vramKvGb, regTotals.kv / 1024) : emptyPair}
                  {Array.from({ length: maxGpus }).map((_, i) => (
                    <td key={i} className={cellBase}>{gpuCell(regular, i, "ctx_mib")}</td>
                  ))}
                  {moeOptimal ? frPair(moeOptimal.vramKvGb, moeTotals.kv / 1024) : emptyPair}
                  {Array.from({ length: maxGpus }).map((_, i) => (
                    <td key={i} className={cellBase}>{gpuCell(moeOptimal, i, "ctx_mib")}</td>
                  ))}
                </tr>

                {/* Overhead */}
                <tr>
                  <td className={`${cellBase} text-left font-semibold text-black/70 pr-3`}>Overhead</td>
                  {regular ? frPair(regular.vramOverheadGb, regTotals.compute / 1024) : emptyPair}
                  {Array.from({ length: maxGpus }).map((_, i) => (
                    <td key={i} className={cellBase}>{gpuCell(regular, i, "compute_mib")}</td>
                  ))}
                  {moeOptimal ? frPair(moeOptimal.vramOverheadGb, moeTotals.compute / 1024) : emptyPair}
                  {Array.from({ length: maxGpus }).map((_, i) => (
                    <td key={i} className={cellBase}>{gpuCell(moeOptimal, i, "compute_mib")}</td>
                  ))}
                </tr>

                {/* ── Total row ── */}
                <tr className="border-t border-black/20">
                  <td className={`${cellBase} text-left font-bold text-black/60 pr-3 pt-1`}>Total</td>
                  {regular ? (
                    <>
                      <td className={`${cellBase} text-black/70 pr-3 pt-1`}>{fmt(regular.formulaVramTotalGb)}</td>
                      <td className={`${cellBase} pl-1 pt-1`} style={{ color: "#B45309" }}>{fmt(regular.validatedVramMib / 1024)}</td>
                    </>
                  ) : emptyPair}
                  {Array.from({ length: maxGpus }).map((_, i) => {
                    const c = regular?.validatedComponentsMib?.[i];
                    return (
                      <td key={i} className={`${cellBase} text-black/60 pt-1`}>
                        {c ? fmt((c.model_mib + c.ctx_mib + c.compute_mib) / 1024) : "—"}
                      </td>
                    );
                  })}
                  {moeOptimal ? (
                    <>
                      <td className={`${cellBase} text-black/70 pr-3 pl-3 pt-1`}>{fmt(moeOptimal.formulaVramTotalGb)}</td>
                      <td className={`${cellBase} pl-1 pt-1`} style={{ color: "#B45309" }}>{fmt(moeOptimal.validatedVramMib / 1024)}</td>
                    </>
                  ) : emptyPair}
                  {Array.from({ length: maxGpus }).map((_, i) => {
                    const c = moeOptimal?.validatedComponentsMib?.[i];
                    return (
                      <td key={i} className={`${cellBase} text-black/60 pt-1`}>
                        {c ? fmt((c.model_mib + c.ctx_mib + c.compute_mib) / 1024) : "—"}
                      </td>
                    );
                  })}
                </tr>

                {/* ── Scale Factor row ── */}
                <tr>
                  <td className={`${cellBase} text-left text-black/50 pr-3`}>Scale</td>
                  {regular ? (
                    <>
                      <td colSpan={2} className={`${cellBase} pt-1`} style={{ color: "#B45309" }}>
                        {(regular.validatedVramMib / 1024 / regular.formulaVramTotalGb).toFixed(3)}x
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={cellBase}>—</td>
                      <td className={cellBase}>—</td>
                    </>
                  )}
                  {emptyGpus}
                  {moeOptimal ? (
                    <>
                      <td colSpan={2} className={`${cellBase} pt-1 pl-3`} style={{ color: "#B45309" }}>
                        {(moeOptimal.validatedVramMib / 1024 / moeOptimal.formulaVramTotalGb).toFixed(3)}x
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={cellBase}>—</td>
                      <td className={cellBase}>—</td>
                    </>
                  )}
                  {emptyGpus}
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
