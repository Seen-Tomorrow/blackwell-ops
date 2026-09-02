import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FoundrySourcePreview, FoundryWorkCacheStatus, ProviderConfig } from "../lib/types";
import { useTelemetry } from "../context/TelemetryContext";
import { ENV_META, type Env } from "../lib/foundry_constants";
import FoundryToolchainPanel from "./FoundryToolchainPanel";
import FoundryWindowShell from "./FoundryWindowShell";
import {
  CUDA_ARCH_BUILD_OPTIONS,
  DEFAULT_CUDA_ARCH_CODES,
  formatCudaArchitecturesCmakeLine,
  orderCudaArchCodes,
} from "../lib/cudaArchUtils";

interface FoundryConfirmFormProps {
  provider: ProviderConfig;
  environment: Env;
  prUrl: string;
  setPrUrl: (v: string) => void;
  buildProfile: string;
  setBuildProfile: (v: string) => void;
  generator: string;
  setGenerator: (v: string) => void;
  selectedArchs: string[];
  setSelectedArchs: Dispatch<SetStateAction<string[]>>;
  maxCores: number | null;
  setMaxCores: (v: number | null) => void;
  /** Also cmake --target llama-cli + llama-quantize (offline tools; not used by the app). */
  includeExtraTools: boolean;
  setIncludeExtraTools: (v: boolean) => void;
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
  buildProfile,
  setBuildProfile,
  generator,
  setGenerator,
  selectedArchs,
  setSelectedArchs,
  maxCores,
  setMaxCores,
  includeExtraTools,
  setIncludeExtraTools,
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

  const [toolchainReady, setToolchainReady] = useState(false);
  const [sourcePreview, setSourcePreview] = useState<FoundrySourcePreview | null>(null);
  const [sourcePreviewLoading, setSourcePreviewLoading] = useState(true);
  const [workCache, setWorkCache] = useState<FoundryWorkCacheStatus | null>(null);
  const [workCacheClearing, setWorkCacheClearing] = useState(false);
  const envMeta = ENV_META[environment];
  const orderedArchs = orderCudaArchCodes(selectedArchs);
  const archCmakePreview = formatCudaArchitecturesCmakeLine(orderedArchs);

  useEffect(() => {
    let cancelled = false;
    setSourcePreviewLoading(true);
    void invoke<FoundrySourcePreview>("foundry_preview_source", {
      providerId: provider.id,
      environment,
    })
      .then((preview) => {
        if (!cancelled) setSourcePreview(preview);
      })
      .catch(() => {
        if (!cancelled) setSourcePreview(null);
      })
      .finally(() => {
        if (!cancelled) setSourcePreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider.id, environment]);

  const refreshWorkCache = useCallback(() => {
    void invoke<FoundryWorkCacheStatus>("foundry_work_cache_status", {
      providerId: provider.id,
      profileId: environment,
    })
      .then(setWorkCache)
      .catch(() => setWorkCache(null));
  }, [provider.id, environment]);

  useEffect(() => {
    refreshWorkCache();
  }, [refreshWorkCache]);

  const handleClearWorkCache = useCallback(async () => {
    if (workCacheClearing) return;
    const warm = workCache?.cmakeCachePresent;
    const sizeHint = workCache?.sizeLabel ? ` (${workCache.sizeLabel})` : "";
    if (
      !window.confirm(
        warm
          ? `Clear CMake build cache for ${provider.id} / ${environment.toUpperCase()}${sizeHint}?\n\nNext build will be a full cold compile (~4–15 min depending on arch count).`
          : `No warm CMake cache for build-${environment}. Clear work/ anyway${sizeHint}?`,
      )
    ) {
      return;
    }
    setWorkCacheClearing(true);
    try {
      await invoke("foundry_clear_work_cache", {
        providerId: provider.id,
        profileId: environment,
      });
      refreshWorkCache();
    } catch (err) {
      console.error("[Foundry] Clear work cache failed:", err);
    } finally {
      setWorkCacheClearing(false);
    }
  }, [workCacheClearing, workCache?.cmakeCachePresent, workCache?.sizeLabel, provider.id, environment, refreshWorkCache]);

  const previewToneClass =
    sourcePreview?.banner_tone === "amber"
      ? "foundry-source-banner--amber"
      : sourcePreview?.banner_tone === "cyan"
        ? "foundry-source-banner--cyan"
        : sourcePreview?.banner_tone === "green"
          ? "foundry-source-banner--green"
          : "foundry-source-banner--muted";

  const toggleArch = (code: string) => {
    setSelectedArchs((prev) => {
      const set = new Set(prev);
      if (set.has(code)) {
        if (set.size <= 1) return prev;
        set.delete(code);
      } else {
        set.add(code);
      }
      return orderCudaArchCodes([...set]);
    });
  };

  const footer = showEngineWarning ? (
    <>
      <button onClick={onEngineWarningCancel}
        className="fnd-confirm-btn--danger px-3 py-1 font-mono transition-colors">
        CANCEL — HANDLE MANUALLY
      </button>
      <button onClick={onEngineWarningProceed}
        className="fnd-confirm-btn--danger-solid px-4 py-1 font-mono rounded-sm transition-all">
        STOP ENGINES & PROCEED
      </button>
    </>
  ) : (
    <>
      <button onClick={onClose}
        className="fnd-confirm-btn--danger px-3 py-1 font-mono transition-colors">
        CLOSE
      </button>
      <button type="button" onClick={onMinimize} className="foundry-minimize-btn">
        MINIMIZE TO STATUS BAR
      </button>
      <button
        type="button"
        onClick={onConfirmBuild}
        disabled={!toolchainReady}
        className="foundry-confirm-build-btn"
      >
        PROCEED TO CONFIGURE
      </button>
    </>
  );

  return (
    <FoundryWindowShell
      title="REACTOR FOUNDRY"
      tone="amber"
      variant="confirm"
      onMinimize={onMinimize}
      footer={footer}
    >
      <div className="foundry-confirm-body">
        <p className="fnd-confirm-lead type-body font-mono uppercase tracking-wider m-0">
          Ready to build?
        </p>

        {sourcePreviewLoading ? (
          <div className="foundry-source-banner foundry-source-banner--muted px-3 py-2.5 rounded-sm border animate-pulse">
            <p className="fnd-banner-title type-label font-mono tracking-wider uppercase opacity-70 m-0">
              Checking source revision vs installed binary…
            </p>
          </div>
        ) : sourcePreview ? (
          <div className={`foundry-source-banner px-3 py-2.5 rounded-sm border ${previewToneClass}`}>
            <p className="fnd-banner-title type-body font-mono font-bold tracking-wider uppercase leading-snug m-0">
              {sourcePreview.status === "up_to_date" ? "Already up to date" : "Source check"}
            </p>
            <p className="fnd-banner-msg type-label font-mono leading-relaxed mt-1.5 mb-0">{sourcePreview.message}</p>
            {(sourcePreview.local_commit || sourcePreview.remote_commit || sourcePreview.installed_commit) && (
              <p className="fnd-banner-commits type-micro font-mono opacity-75 mt-2 mb-0 leading-relaxed">
                {sourcePreview.local_commit ? `local ${sourcePreview.local_commit}` : "local —"}
                {" · "}
                {sourcePreview.remote_commit ? `remote ${sourcePreview.remote_commit}` : "remote —"}
                {" · "}
                {sourcePreview.installed_commit
                  ? `binary ${sourcePreview.installed_commit}`
                  : sourcePreview.installed_version
                    ? `binary ${sourcePreview.installed_version}`
                    : "binary —"}
              </p>
            )}
          </div>
        ) : null}

        {/*
          Wide shell: left = target + toolchain + arch/generator; right = cmake flags + PR + threads.
          Uses horizontal room instead of a single tall narrow stack.
        */}
        <div className="foundry-confirm-grid">
          <div className="foundry-confirm-col">
            <div className="foundry-confirm-panel space-y-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="fnd-confirm-provider__id type-body font-mono shrink-0">{provider.id}</span>
                <span className="fnd-confirm-provider__dash type-label font-mono shrink-0">&mdash;</span>
                <span className="fnd-confirm-provider__name type-body font-mono truncate">{provider.display_name}</span>
              </div>

              {provider.git_url && (
                <p className="fnd-confirm-git type-tiny font-mono break-all m-0">
                  {provider.git_url} @{provider.branch || "main"}
                </p>
              )}

              <div className="flex items-center gap-2 pt-1 flex-wrap">
                <span className="fnd-confirm-field-label type-tiny font-mono uppercase">Environment:</span>
                <span className="foundry-env-badge px-2 py-0.5 type-label font-mono rounded-sm">
                  {envMeta.label}
                </span>
                <span className="cuda-badge type-micro font-mono px-1.5 py-0.5 rounded-sm">CUDA {envMeta.cuda}</span>
                <span className="value-chip fnd-meta-chip type-micro font-mono px-1.5 py-0.5 rounded-sm opacity-80">{envMeta.vs}</span>
              </div>

              <div className="pt-1">
                <FoundryToolchainPanel
                  compact
                  requiredProfile={environment}
                  onReadyChange={setToolchainReady}
                />
              </div>

              <div className="foundry-cmake-cache-row fnd-cache-row rounded-sm px-2 py-1.5 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="fnd-cache-title type-tiny font-mono uppercase tracking-wider m-0">
                      CMake work cache
                    </p>
                    <p className="fnd-cache-body type-tiny font-mono leading-relaxed mt-0.5 mb-0">
                      {workCache?.cmakeCachePresent ? (
                        <span className="fnd-cache-state--warm">
                          WARM — build-{environment} (incremental — fastest)
                        </span>
                      ) : (
                        <span className="fnd-cache-state--cold">
                          COLD — full compile (flags/arch changed, or no cache)
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleClearWorkCache()}
                    disabled={workCacheClearing}
                    title={
                      workCache
                        ? `This profile: ${workCache.sizeLabel} · All profiles for ${provider.id}: ${workCache.workTotalLabel}`
                        : undefined
                    }
                    className="foundry-clear-cache-btn fnd-cache-btn shrink-0 px-2 py-1 font-mono border rounded-sm transition-colors disabled:opacity-50"
                  >
                    {workCacheClearing
                      ? "CLEARING…"
                      : `CLEAR CACHE${
                          workCache
                            ? ` · ${workCache.sizeBytes > 0 ? workCache.sizeLabel : "0 B"}`
                            : ""
                        }`}
                  </button>
                </div>
                <p className="fnd-cache-note type-micro font-mono config-muted leading-snug m-0">
                  On failed config/build, CLEAR CACHE and start over
                </p>
              </div>
            </div>

            <div className="foundry-confirm-panel">
              <p className="foundry-confirm-section-label">CUDA GPU architectures</p>
              <p className="foundry-confirm-hint">
                Pick only the HW you own — each arch adds compile time (~5 min one vs ~15 min all three).
              </p>
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {CUDA_ARCH_BUILD_OPTIONS.map((opt) => {
                  const active = selectedArchs.includes(opt.code);
                  return (
                    <button
                      key={opt.code}
                      type="button"
                      onClick={() => toggleArch(opt.code)}
                      className={`foundry-arch-chip px-2 py-1 text-left rounded-sm transition-all max-w-[12rem]${
                        active ? " foundry-arch-chip--active" : ""
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="fnd-arch-label type-label font-mono font-bold">
                          {opt.label}
                        </span>
                        <span className="cuda-badge type-hairline font-mono px-1 py-0 rounded-sm">sm_{opt.code}</span>
                      </div>
                      <div className="fnd-arch-hint type-micro font-mono opacity-75 leading-tight mt-0.5">{opt.hint}</div>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setSelectedArchs([...DEFAULT_CUDA_ARCH_CODES])}
                  className={`foundry-arch-chip px-2 py-1 type-tiny font-mono rounded-sm transition-all self-stretch${
                    orderedArchs.length === DEFAULT_CUDA_ARCH_CODES.length
                      ? " foundry-arch-chip--active"
                      : ""
                  }`}
                >
                  ALL (ship)
                </button>
              </div>
              {archCmakePreview && (
                <p className="type-micro font-mono foundry-cuda-arch-inline m-0">{archCmakePreview}</p>
              )}
            </div>

            <div className="foundry-confirm-panel">
              <p className="foundry-confirm-section-label">CMake generator</p>
              <p className="foundry-confirm-hint">
                Ninja is faster (recommended). Visual Studio is the stable fallback. Saved on start.
              </p>
              <select
                value={generator}
                onChange={(e) => setGenerator(e.target.value)}
                className="foundry-build-profile-textarea w-full px-2 py-1.5 font-mono"
              >
                <option value="">AUTO (pack default — Ninja)</option>
                <option value="ninja">NINJA (fast, Multi-Config)</option>
                <option value="visual-studio">VISUAL STUDIO (stable)</option>
              </select>
            </div>

            <div className="foundry-confirm-panel">
              <label className="flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeExtraTools}
                  onChange={(e) => setIncludeExtraTools(e.target.checked)}
                  className="fnd-checkbox mt-0.5 shrink-0"
                />
                <span className="min-w-0">
                  <span className="fnd-extra-label type-tiny font-mono uppercase block">
                    Also build CLI + quantize
                  </span>
                  <span className="fnd-extra-note type-micro font-mono leading-snug block mt-0.5">
                    Off by default (faster). Product always builds <span className="fnd-extra-note__bin">llama-server</span>,{" "}
                    <span className="fnd-extra-note__bin">llama-fit-params</span>, and{" "}
                    <span className="fnd-extra-note__bin">llama-bench</span>. Enable for offline{" "}
                    <span className="fnd-extra-note__bin">llama-cli</span> / <span className="fnd-extra-note__bin">llama-quantize</span>{" "}
                    (not used by the app runtime).
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="foundry-confirm-col">
            <div className="foundry-confirm-panel">
              <p className="foundry-confirm-section-label">Build profile (CMake flags)</p>
              <p className="foundry-confirm-hint">
                Base flags + architectures are merged on build. Server/tests/examples/native stay pinned. Saved on start.
              </p>
              <textarea
                placeholder={"-DGGML_CUDA=ON\n-DGGML_AVX512=ON\n-DGGML_NATIVE=OFF"}
                rows={8}
                className="foundry-build-profile-textarea w-full px-2 py-1.5 min-h-[8rem]"
                value={buildProfile}
                onChange={(e) => setBuildProfile(e.target.value)}
                spellCheck={false}
              />
            </div>

            <div className="foundry-confirm-panel">
              <label className="foundry-pr-label block mb-1.5">
                Apply PR patch (optional)
              </label>
              <input
                type="text"
                placeholder="https://github.com/owner/repo/pull/N"
                className="foundry-pr-input w-full px-2 py-1.5 outline-none transition-colors"
                value={prUrl}
                onChange={(e) => setPrUrl(e.target.value)}
              />
            </div>

            {cpuThreads > 0 && (
              <div className="foundry-confirm-panel">
                <p className="foundry-confirm-section-label">Max build threads</p>
                <p className="foundry-confirm-hint">
                  CPU has {cpuThreads} threads ({cpuPhysical} physical). Leave 2+ free to keep the system responsive.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {[4, 6, 8, 10, 12, 14, 16].map((n) => (
                    <button key={n} onClick={() => setMaxCores(n)}
                      className={`fnd-cores-btn px-2 py-0.5 font-mono border rounded-sm transition-all ${
                        maxCores === n
                          ? "fnd-cores-btn--active"
                          : "fnd-cores-btn--idle"
                      }`}>
                      {n}
                    </button>
                  ))}
                  <button onClick={() => setMaxCores(null)}
                    className={`fnd-cores-btn px-2 py-0.5 font-mono border rounded-sm transition-all ${
                      maxCores === null
                        ? "fnd-cores-btn--active"
                        : "fnd-cores-btn--idle"
                    }`}>
                    ALL ({cpuThreads})
                  </button>
                </div>
              </div>
            )}

            {showEngineWarning ? (
              <div className="fnd-engine-warn rounded-sm p-3 space-y-2">
                <p className="fnd-engine-warn__title type-body font-mono font-bold m-0">⚠ ENGINES ON THIS PROFILE</p>
                <pre className="fnd-engine-warn__list type-tiny font-mono whitespace-pre-wrap m-0">{engineListText}</pre>
                <p className="fnd-engine-warn__note type-label font-mono m-0">
                  BUILD will stop only these <span className="font-bold">{envMeta.label}</span> engines for <span className="font-bold">{provider.display_name}</span>.
                  Engines on other profiles keep running. Click <span className="font-bold">STOP ENGINES &amp; PROCEED</span> or CANCEL to handle manually first.
                </p>
              </div>
            ) : (
              <div className="fnd-profile-isolated rounded-sm p-3">
                <p className="fnd-profile-isolated__title type-body font-mono font-bold mb-1 mt-0">
                  ✓ PROFILE-ISOLATED BUILD
                </p>
                <p className="fnd-profile-isolated__body type-label font-mono m-0">
                  Builds are isolated per selected provider &amp; profile — other providers/engines keep running.
                </p>
                <p className="fnd-profile-isolated__note type-tiny font-mono mt-1 mb-0">
                  Minimize to status bar and continue your usual workflow while the build runs.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </FoundryWindowShell>
  );
}