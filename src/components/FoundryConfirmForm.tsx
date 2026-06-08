import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProviderConfig } from "../lib/types";
import { useTelemetry } from "../context/TelemetryContext";
import { getEnvColors, ENV_META, type Env } from "../lib/foundry_constants";

interface ProfileCheck {
  id: string;
  label: string;
  cuda: string;
  vs_label: string;
  ready: boolean;
  missing: string[];
}

interface FoundryConfirmFormProps {
  provider: ProviderConfig;
  environment: Env;
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

  const [toolchainCheck, setToolchainCheck] = useState<ProfileCheck | null>(null);
  const envMeta = ENV_META[environment];

  useEffect(() => {
    let mounted = true;
    invoke<ProfileCheck[]>("foundry_check_toolchain")
      .then((checks) => {
        if (!mounted) return;
        setToolchainCheck(checks.find((c) => c.id === environment) ?? null);
      })
      .catch(() => { if (mounted) setToolchainCheck(null); });
    return () => { mounted = false; };
  }, [environment]);

  const toolchainReady = toolchainCheck?.ready ?? false;

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

            <div className="flex items-center gap-2 pt-1 flex-wrap">
              <span className="text-[8px] font-mono text-stealth-muted uppercase">Environment:</span>
              <span className={`px-2 py-0.5 text-[9px] font-mono border rounded-sm ${envColors("border")}`}>
                {envMeta.label}
              </span>
              <span className="cuda-badge text-[7px] font-mono px-1.5 py-0.5 rounded-sm">CUDA {envMeta.cuda}</span>
              <span className="value-chip text-[7px] font-mono px-1.5 py-0.5 rounded-sm opacity-80">{envMeta.vs}</span>
            </div>

            {toolchainCheck && (
              <div className={`pt-1 text-[8px] font-mono ${toolchainReady ? "text-nv-green" : "text-red-400"}`}>
                {toolchainReady
                  ? `✓ Portable toolchain ready (${toolchainCheck.vs_label} + CUDA ${toolchainCheck.cuda})`
                  : `✗ Toolchain incomplete — run scripts/populate-foundry-toolchain.ps1`}
                {!toolchainReady && toolchainCheck.missing.length > 0 && (
                  <div className="text-[7px] text-stealth-muted mt-1 truncate" title={toolchainCheck.missing.join("\n")}>
                    Missing: {toolchainCheck.missing[0]}
                  </div>
                )}
              </div>
            )}

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
              <label className="text-[8px] font-mono text-stealth-muted uppercase block mb-1">
                CMake flags (optional)
              </label>
              <p className="text-[7px] font-mono text-yellow-400/70 mb-1.5 leading-tight">
                These flags <span className="font-bold text-yellow-400">REPLACE</span> the provider defaults for this build.
              </p>
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
              <p className="text-[10px] font-mono text-red-400 font-bold">⚠ ENGINES ON THIS PROFILE</p>
              <pre className="text-[8px] font-mono text-white/70 whitespace-pre-wrap">{engineListText}</pre>
              <p className="text-[9px] font-mono text-stealth-muted">
                BUILD will stop only these <span className="font-bold">{envMeta.label}</span> engines for <span className="font-bold">{provider.display_name}</span>.
                Engines on other profiles keep running. Click <span className="font-bold">STOP ENGINES &amp; PROCEED</span> or CANCEL to handle manually first.
              </p>
            </div>
          )}

          {!showEngineWarning && (
            <div className="border border-stealth-border/50 bg-black/20 rounded-sm p-3">
              <p className="text-[10px] font-mono text-nv-green font-bold mb-1">
                ✓ PROFILE-ISOLATED BUILD
              </p>
              <p className="text-[9px] font-mono text-white/80">
                Builds run in isolated work trees. Only engines using the <span className="font-bold">{envMeta.label}</span> profile for this provider would be stopped — other profiles and providers keep running.
              </p>
              <p className="text-[8px] font-mono text-stealth-muted mt-1">
                Minimize to the dock and continue your usual workflow while the build runs.
              </p>
            </div>
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
                disabled={toolchainCheck !== null && !toolchainReady}
                className={`px-4 py-1 text-[9px] font-mono border rounded-sm transition-all ${envColors("border")} disabled:opacity-40 disabled:cursor-not-allowed`}>
                YES — BUILD
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}