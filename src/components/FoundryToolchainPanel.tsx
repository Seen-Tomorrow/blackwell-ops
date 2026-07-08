import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { useTauriListen } from "../hooks/useTauriListen";
import { ENV_ORDER, TOOLCHAIN_RELEASE_URL, type Env } from "../lib/foundry_constants";
import type { ToolchainPackId } from "../lib/foundry_constants";

interface ProfileCheck {
  id: string;
  label: string;
  cuda: string;
  vs_label: string;
  ready: boolean;
  missing: string[];
}

export interface ToolchainPackOffer {
  id: ToolchainPackId;
  label: string;
  archive_name: string;
  compressed_size_label: string;
  uncompressed_size_label: string;
  description: string;
  recommended: boolean;
}

export interface ToolchainInstallInfo {
  app_root: string;
  extract_target: string;
  toolchain_dir: string;
  release_url: string;
  archive_parts: string[];
  compressed_size_label: string;
  uncompressed_size_label: string;
  packs: ToolchainPackOffer[];
  manifest_present: boolean;
  runtime_ready: boolean;
  profiles_ready: number;
  profiles_total: number;
  all_ready: boolean;
  profile_checks: ProfileCheck[];
}

interface ToolchainDownloadEvent {
  pack: string;
  phase: string;
  message: string;
  percent: number | null;
  downloaded_bytes: number;
  total_bytes: number;
}

interface FoundryToolchainPanelProps {
  /** Compact: ready state is one line; incomplete still shows full guide. */
  compact?: boolean;
  /** Onboarding checklist — emphasize Full pack + allow skip. */
  onboarding?: boolean;
  /** When set (e.g. Foundry confirm), onReadyChange reflects only this profile. */
  requiredProfile?: Env;
  onReadyChange?: (ready: boolean) => void;
  onInstallStatusChange?: (status: { foundryReady: boolean; runtimeReady: boolean }) => void;
  onSkip?: () => void;
}

function profileReadyForBuild(
  checks: ProfileCheck[],
  requiredProfile?: Env,
): boolean {
  if (!requiredProfile) {
    return checks.length > 0 && checks.every((c) => c.ready);
  }
  const key = requiredProfile.toLowerCase();
  return checks.find((c) => c.id.toLowerCase() === key)?.ready ?? false;
}

export default function FoundryToolchainPanel({
  compact = false,
  onboarding = false,
  requiredProfile,
  onReadyChange,
  onInstallStatusChange,
  onSkip,
}: FoundryToolchainPanelProps) {
  const [info, setInfo] = useState<ToolchainInstallInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloadPack, setDownloadPack] = useState<ToolchainPackId | null>(null);
  const [downloadPhase, setDownloadPhase] = useState<string | null>(null);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setActionError(null);
    try {
      const data = await invoke<ToolchainInstallInfo>("foundry_get_toolchain_install_info");
      setInfo(data);
      onReadyChange?.(profileReadyForBuild(data.profile_checks, requiredProfile));
      onInstallStatusChange?.({
        foundryReady: data.all_ready,
        runtimeReady: data.runtime_ready,
      });
    } catch (e) {
      setActionError(String(e));
      onReadyChange?.(false);
    } finally {
      setLoading(false);
    }
  }, [onReadyChange, onInstallStatusChange, requiredProfile]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useTauriListen<ToolchainDownloadEvent>("toolchain-download-event", (payload) => {
    setDownloadPack(payload.pack as ToolchainPackId);
    setDownloadPhase(payload.phase);
    setDownloadMessage(payload.message);
    setDownloadPercent(payload.percent);
    if (payload.phase === "complete") {
      setDownloadPack(null);
      setDownloadPhase(null);
      void refresh();
    } else if (payload.phase === "error") {
      setActionError(payload.message);
      setDownloadPack(null);
      setDownloadPhase(null);
    }
  }, [refresh]);

  const handleDownload = useCallback(async (pack: ToolchainPackId) => {
    setActionError(null);
    setDownloadPack(pack);
    setDownloadPhase("downloading");
    setDownloadMessage("Starting…");
    setDownloadPercent(0);
    try {
      await invoke("foundry_download_toolchain", { pack });
    } catch (e) {
      setActionError(String(e));
      setDownloadPack(null);
      setDownloadPhase(null);
    }
  }, []);

  const handleOpenRelease = useCallback(async () => {
    setActionError(null);
    try {
      await open(info?.release_url ?? TOOLCHAIN_RELEASE_URL);
    } catch (e) {
      setActionError(`Failed to open release page: ${e}`);
    }
  }, [info?.release_url]);

  const handleCopyPath = useCallback(async () => {
    if (!info?.extract_target) return;
    setActionError(null);
    try {
      await navigator.clipboard.writeText(info.extract_target);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setActionError(`Failed to copy path: ${e}`);
    }
  }, [info?.extract_target]);

  const handleOpenFolder = useCallback(async () => {
    setActionError(null);
    try {
      await invoke("foundry_open_toolchain_install_folder");
    } catch (e) {
      setActionError(String(e));
    }
  }, []);

  const downloading = downloadPhase === "downloading" || downloadPhase === "extracting";

  if (loading && !info) {
    return (
      <div className="text-[8px] font-mono text-stealth-muted/60">
        Checking portable toolchain…
      </div>
    );
  }

  if (!info) {
    return (
      <div className="text-[8px] font-mono text-red-400/80">
        {actionError ?? "Toolchain status unavailable."}
      </div>
    );
  }

  const checkByEnv = Object.fromEntries(
    info.profile_checks.map((c) => [c.id.toLowerCase(), c]),
  ) as Partial<Record<Env, ProfileCheck>>;

  const buildReady = profileReadyForBuild(info.profile_checks, requiredProfile);
  const requiredCheck = requiredProfile
    ? checkByEnv[requiredProfile]
    : undefined;

  if (buildReady && compact) {
    return (
      <div className="text-[8px] font-mono text-nv-green">
        {requiredCheck
          ? `✓ Portable toolchain ready (${requiredCheck.vs_label} + CUDA ${requiredCheck.cuda})`
          : `✓ Portable toolchain ready — all ${info.profiles_total} build profiles`}
      </div>
    );
  }

  const statusLabel = info.all_ready
    ? "READY (FULL)"
    : info.runtime_ready
      ? "RUNTIME (bare min)"
      : `${info.profiles_ready}/${info.profiles_total} PROFILES`;

  const statusClass = info.all_ready
    ? "text-nv-green border-nv-green/40 bg-nv-green/10"
    : info.runtime_ready
      ? "text-telemetry-cyan border-telemetry-cyan/40 bg-telemetry-cyan/10"
      : "text-yellow-400 border-yellow-400/40 bg-yellow-400/10";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">
          Foundry Toolchain
        </span>
        <span className={`text-[7px] font-mono px-1.5 py-0.5 rounded-sm border ${statusClass}`}>
          {statusLabel}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        {ENV_ORDER.map((env) => {
          const check = checkByEnv[env];
          const ready = check?.ready ?? false;
          return (
            <span
              key={env}
              title={
                ready
                  ? `${check?.label} ready`
                  : check?.missing.join("\n") ?? "Not checked"
              }
              className={`text-[7px] font-mono px-1.5 py-0.5 rounded-sm border ${
                ready
                  ? "text-nv-green/90 border-nv-green/30"
                  : "text-stealth-muted/70 border-stealth-border/50"
              }`}
            >
              {ready ? "✓" : "○"} {check?.label ?? env.toUpperCase()}
            </span>
          );
        })}
      </div>

      {info.all_ready ? (
        <p className="text-[8px] font-mono text-nv-green leading-relaxed">
          Portable VS Build Tools, Windows SDK, and CUDA toolkits are installed. Foundry builds can use any profile.
        </p>
      ) : (
        <div className="foundry-toolchain-install-guide border border-yellow-400/30 bg-yellow-400/5 rounded-sm p-2.5 space-y-2">
          <p className="foundry-toolchain-install-guide__title text-[8px] font-mono text-yellow-400/90 font-bold uppercase tracking-wide">
            {onboarding ? "One-click toolchain" : "Install portable toolchain"}
          </p>

          {info.runtime_ready && !info.all_ready && (
            <p className="text-[8px] font-mono text-telemetry-cyan/90 leading-relaxed">
              Bare-minimum CUDA runtime DLLs (cublas + cudart) are present — bundled engines can run on any machine. Install the Full pack only if you plan to use Foundry auto-builds.
            </p>
          )}

          <div className="space-y-2">
            {info.packs.map((pack) => (
              <div
                key={pack.id}
                className={`rounded-sm border px-2 py-2 space-y-1.5 ${
                  pack.recommended
                    ? "border-nv-green/40 bg-nv-green/5"
                    : "border-stealth-border/50 bg-black/20"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[8px] font-mono text-white/90 font-bold uppercase">
                    {pack.label}
                  </span>
                  {pack.recommended && (
                    <span className="text-[6px] font-mono px-1 py-0.5 rounded-sm border border-nv-green/50 text-nv-green">
                      RECOMMENDED
                    </span>
                  )}
                  <span className="text-[7px] font-mono text-stealth-muted">
                    {pack.compressed_size_label} download · {pack.uncompressed_size_label} extracted
                  </span>
                </div>
                <p className="text-[8px] font-mono text-white/70 leading-relaxed">
                  {pack.description}
                </p>
                <button
                  type="button"
                  onClick={() => void handleDownload(pack.id)}
                  disabled={downloading || (pack.id === "full" && info.all_ready) || (pack.id === "runtime" && info.runtime_ready)}
                  className={`foundry-toolchain-btn ${
                    pack.recommended ? "foundry-toolchain-btn--action" : "foundry-toolchain-btn--neutral"
                  }`}
                >
                  {downloading && downloadPack === pack.id
                    ? downloadPhase === "extracting"
                      ? "EXTRACTING…"
                      : `DOWNLOADING${downloadPercent != null ? ` ${downloadPercent}%` : "…"}`
                    : pack.id === "runtime" && info.runtime_ready
                      ? "RUNTIME INSTALLED"
                      : pack.id === "full" && info.all_ready
                        ? "FULL INSTALLED"
                        : `DOWNLOAD ${pack.archive_name.toUpperCase()}`}
                </button>
              </div>
            ))}
          </div>

          {downloading && downloadMessage && (
            <div className="space-y-1">
              <p className="text-[7px] font-mono text-stealth-muted">{downloadMessage}</p>
              {downloadPercent != null && downloadPhase === "downloading" && (
                <div className="h-1 rounded-sm bg-black/40 overflow-hidden">
                  <div
                    className="h-full bg-nv-green/80 transition-all duration-300"
                    style={{ width: `${downloadPercent}%` }}
                  />
                </div>
              )}
            </div>
          )}

          <details className="text-[8px] font-mono text-white/60">
            <summary className="cursor-pointer text-stealth-muted hover:text-white/80">
              Manual install (.7z)
            </summary>
            <ol className="foundry-toolchain-install-guide__body list-decimal list-inside space-y-1 mt-1.5 text-white/65 leading-relaxed">
              <li>Download from the GitHub release into the app folder below.</li>
              <li>Right-click the .7z → 7-Zip (or WinRAR / PeaZip / 7-Zip File Manager) → Extract Here.</li>
              <li className="text-[7px] opacity-70">The one-click download uses the bundled 7z from bin/ (always available).</li>
              <li>Confirm <span className="text-nv-green">toolchain\manifest.json</span> exists, then Re-check.</li>
            </ol>
          </details>

          <div className="rounded-sm border border-stealth-border/50 bg-black/30 px-2 py-1.5 space-y-0.5">
            <div className="text-[7px] font-mono text-stealth-muted uppercase">App folder</div>
            <div className="text-[8px] font-mono text-telemetry-cyan break-all">{info.extract_target}</div>
            {!info.manifest_present && (
              <div className="text-[7px] font-mono text-red-400/80">
                manifest.json not found yet
              </div>
            )}
          </div>

          <div className="foundry-toolchain-install-guide__actions flex flex-wrap gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={() => void handleOpenRelease()}
              className="foundry-toolchain-btn foundry-toolchain-btn--link"
            >
              OPEN RELEASE PAGE
            </button>
            <button
              type="button"
              onClick={() => void handleCopyPath()}
              className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
            >
              {copied ? "COPIED" : "COPY PATH"}
            </button>
            <button
              type="button"
              onClick={() => void handleOpenFolder()}
              className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
            >
              OPEN FOLDER
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading || downloading}
              className="foundry-toolchain-btn foundry-toolchain-btn--action"
            >
              {loading ? "CHECKING…" : "RE-CHECK"}
            </button>
            {onboarding && onSkip && !info.all_ready && (
              <button
                type="button"
                onClick={onSkip}
                disabled={downloading}
                className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
              >
                SKIP FOR NOW
              </button>
            )}
          </div>
        </div>
      )}

      {actionError && (
        <p className="text-[7px] font-mono text-red-400/80 break-all">{actionError}</p>
      )}
    </div>
  );
}