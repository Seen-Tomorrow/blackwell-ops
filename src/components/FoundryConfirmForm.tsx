import React from "react";
import type { ProviderConfig } from "../lib/types";
import { useTelemetry } from "../context/TelemetryContext";
import { getEnvColors } from "../lib/foundry_constants";

interface FoundryConfirmFormProps {
  provider: ProviderConfig;
  environment: "vanguard" | "stable" | "fresh";
  prUrl: string;
  setPrUrl: (v: string) => void;
  cmakeFlags: string;
  setCmakeFlags: (v: string) => void;
  maxCores: number | null;
  setMaxCores: (v: number | null) => void;
  showEngineWarning: boolean;
  engineListText: string;
  onClose: () => void;
  onMinimize: () => void;
  onConfirmBuild: () => void;
  onEngineWarningProceed: () => void;
  onEngineWarningCancel: () => void;
}

export default function FoundryConfirmForm({
  provider,
  environment,
  prUrl,
  setPrUrl,
  cmakeFlags,
  setCmakeFlags,
  maxCores,
  setMaxCores,
  showEngineWarning,
  engineListText,
  onClose,
  onMinimize,
  onConfirmBuild,
  onEngineWarningProceed,
  onEngineWarningCancel,
}: FoundryConfirmFormProps) {
  const { cpu } = useTelemetry();
  const cpuThreads = cpu?.threads ?? 0;
  const cpuPhysical = cpu?.cores ?? 0;

  const envColors = (base: string): string => {
    return getEnvColors(environment)[base as keyof ReturnType<typeof getEnvColors>] || "";
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[60vw] max-w-[720px] border border-yellow-400/40 bg-stealth-panel rounded-sm shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-stealth-border">
          <h3 className="text-xs font-mono text-yellow-400 tracking-wider">REACTOR FOUNDRY</h3>
        </div>

        <div className="px-4 py-5 space-y-4">
          <p className="text-[10px] font-mono text-stealth-muted uppercase tracking-wider">
            Ready to build?
          </p>

          {/* Provider info card */}
          <div className="border border-stealth-border/60 bg-black/30 rounded-sm p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-yellow-400">{provider.id}</span>
              <span className="text-[9px] font-mono text-stealth-muted">&mdash;</span>
              <span className="text-[10px] font-mono text-white truncate">{provider.display_name}</span>
            </div>

            {provider.git_url && (
              <p className="text-[8px] font-mono text-telemetry-cyan/70 break-all">
                {provider.git_url} @{provider.branch || "main"}
              </p>
            )}

            <div className="flex items-center gap-2 pt-1">
              <span className="text-[8px] font-mono text-stealth-muted uppercase">Environment:</span>
              <span className={`px-2 py-0.5 text-[9px] font-mono border rounded-sm ${envColors("border")}`}>
                {environment.toUpperCase()}
              </span>
            </div>

            {/* PR input */}
            <div className="pt-1">
              <label className="text-[8px] font-mono text-stealth-muted uppercase block mb-1.5">
                Apply PR patch (optional)
              </label>
              <input
                type="text"
                placeholder="https://github.com/owner/repo/pull/N"
                className="w-full px-2 py-1.5 text-[8px] font-mono bg-black/50 border border-stealth-border rounded-sm text-white placeholder:text-stealth-muted/40 focus:border-purple-400/60 outline-none transition-colors"
                value={prUrl}
                onChange={(e) => setPrUrl(e.target.value)}
              />
            </div>

            {/* CMake flags */}
            <div className="pt-1">
              <label className="text-[8px] font-mono text-stealth-muted uppercase block mb-1.5">
                CMake flags (optional, power-user)
              </label>
              <textarea
                placeholder="-DGGML_CUDA=ON -DLLAMA_AVX2=OFF ..."
                rows={3}
                className="w-full px-2 py-1.5 text-[8px] font-mono bg-black/50 border border-stealth-border rounded-sm text-white placeholder:text-stealth-muted/40 focus:border-purple-400/60 outline-none transition-colors resize-y"
                value={cmakeFlags}
                onChange={(e) => setCmakeFlags(e.target.value)}
              />
            </div>

            {/* Build cores */}
            {cpuThreads > 0 && (
              <div className="pt-1">
                <label className="text-[8px] font-mono text-stealth-muted uppercase block mb-1.5">
                  Max build threads
                </label>
                <p className="text-[7px] font-mono text-yellow-400/60 mb-2 leading-relaxed">
                  Your CPU has {cpuThreads} threads ({cpuPhysical} physical). Leaving 2+ free keeps the system responsive while building.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {[4, 6, 8, 10, 12, 14, 16].map((n) => (
                    <button key={n} onClick={() => setMaxCores(n)}
                      className={`px-2 py-0.5 text-[9px] font-mono border rounded-sm transition-all ${
                        maxCores === n
                          ? "bg-nv-green/30 border-nv-green/60 text-nv-green"
                          : "border-stealth-border text-stealth-muted hover:text-white hover:border-stealth-border/80"
                      }`}>
                      {n}
                    </button>
                  ))}
                  <button onClick={() => setMaxCores(null)}
                    className={`px-2 py-0.5 text-[9px] font-mono border rounded-sm transition-all ${
                      maxCores === null
                        ? "bg-nv-green/30 border-nv-green/60 text-nv-green"
                        : "border-stealth-border text-stealth-muted hover:text-white hover:border-stealth-border/80"
                    }`}>
                    ALL ({cpuThreads})
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Engine warning overlay */}
          {showEngineWarning && (
            <div className="border border-red-400/30 bg-red-400/[0.05] rounded-sm p-3 space-y-2">
              <p className="text-[10px] font-mono text-red-400 font-bold">⚠ RUNNING ENGINES DETECTED</p>
              <pre className="text-[8px] font-mono text-white/70 whitespace-pre-wrap">{engineListText}</pre>
              <p className="text-[9px] font-mono text-stealth-muted">
                These engines will be stopped before the build starts. Click STOP ENGINES & PROCEED to continue, or CANCEL to handle manually.
              </p>
            </div>
          )}

          {!showEngineWarning && (
            <p className="text-[8px] font-mono text-yellow-400/70">
              This will compile llama.cpp from source. The build may take several minutes. Inference engines must be stopped before building.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-stealth-border">
          {showEngineWarning ? (
            <>
              <button onClick={onEngineWarningCancel}
                className="px-3 py-1 text-[9px] font-mono border border-red-400/60 text-red-400 hover:bg-red-500/20 transition-colors">
                CANCEL — HANDLE MANUALLY
              </button>
              <button onClick={onEngineWarningProceed}
                className="px-4 py-1 text-[9px] font-mono border rounded-sm bg-red-400/20 border-red-400/60 text-red-400 hover:bg-red-500/30 transition-all">
                STOP ENGINES & PROCEED
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose}
                className="px-3 py-1 text-[9px] font-mono border border-red-400/60 text-red-400 hover:bg-red-500/20 transition-colors">
                CLOSE
              </button>
              <button onClick={onMinimize}
                className="px-3 py-1 text-[9px] font-mono border border-stealth-border text-stealth-muted hover:text-white transition-colors">
                MINIMIZE TO STATUS BAR
              </button>
              <button onClick={onConfirmBuild}
                className={`px-4 py-1 text-[9px] font-mono border rounded-sm transition-all ${envColors("border")}`}>
                YES — BUILD
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}