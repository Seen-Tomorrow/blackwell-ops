import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { ENV_ORDER, TOOLCHAIN_RELEASE_URL, type Env } from "../lib/foundry_constants";

interface ProfileCheck {
  id: string;
  label: string;
  cuda: string;
  vs_label: string;
  ready: boolean;
  missing: string[];
}

export interface ToolchainInstallInfo {
  app_root: string;
  extract_target: string;
  toolchain_dir: string;
  release_url: string;
  archive_parts: string[];
  compressed_size_label: string;
  uncompressed_size_label: string;
  manifest_present: boolean;
  profiles_ready: number;
  profiles_total: number;
  all_ready: boolean;
  profile_checks: ProfileCheck[];
}

interface FoundryToolchainPanelProps {
  /** Compact: ready state is one line; incomplete still shows full guide. */
  compact?: boolean;
  /** When set (e.g. Foundry confirm), onReadyChange reflects only this profile. */
  requiredProfile?: Env;
  onReadyChange?: (ready: boolean) => void;
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
  requiredProfile,
  onReadyChange,
}: FoundryToolchainPanelProps) {
  const [info, setInfo] = useState<ToolchainInstallInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setActionError(null);
    try {
      const data = await invoke<ToolchainInstallInfo>("foundry_get_toolchain_install_info");
      setInfo(data);
      onReadyChange?.(profileReadyForBuild(data.profile_checks, requiredProfile));
    } catch (e) {
      setActionError(String(e));
      onReadyChange?.(false);
    } finally {
      setLoading(false);
    }
  }, [onReadyChange, requiredProfile]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">
          Foundry Toolchain
        </span>
        <span
          className={`text-[7px] font-mono px-1.5 py-0.5 rounded-sm border ${
            info.all_ready
              ? "text-nv-green border-nv-green/40 bg-nv-green/10"
              : "text-yellow-400 border-yellow-400/40 bg-yellow-400/10"
          }`}
        >
          {info.all_ready ? "READY" : `${info.profiles_ready}/${info.profiles_total} PROFILES`}
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
            One-time manual install
          </p>
          <ol className="foundry-toolchain-install-guide__body list-decimal list-inside space-y-1.5 text-[8px] font-mono text-white/75 leading-relaxed">
            <li>
              Open the{" "}
              <span className="text-telemetry-cyan">Foundry Toolchain</span> release and download all{" "}
              {info.archive_parts.length} parts ({info.compressed_size_label}).
            </li>
            <li>
              Put <span className="foundry-toolchain-install-guide__emph text-white/90">{info.archive_parts.join(", ")}</span> in the same folder (below is fine).
            </li>
            <li>
              Right-click <span className="foundry-toolchain-install-guide__emph text-white/90">toolchain.7z.001</span> → 7-Zip →{" "}
              <span className="foundry-toolchain-install-guide__emph text-white/90">Extract Here</span> into the app folder below.
              Needs <span className="foundry-toolchain-install-guide__emph text-white/90">{info.uncompressed_size_label}</span> free disk space.
            </li>
            <li>
              After extract you must have{" "}
              <span className="text-nv-green">toolchain\manifest.json</span> inside the app folder — then click Re-check.
            </li>
          </ol>

          <div className="rounded-sm border border-stealth-border/50 bg-black/30 px-2 py-1.5 space-y-0.5">
            <div className="text-[7px] font-mono text-stealth-muted uppercase">Extract into this folder (app root)</div>
            <div className="text-[8px] font-mono text-telemetry-cyan break-all">{info.extract_target}</div>
            <div className="text-[7px] font-mono text-stealth-muted/70 pl-2">
              └── toolchain\manifest.json
            </div>
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
              OPEN GIT RELEASE PAGE
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
              disabled={loading}
              className="foundry-toolchain-btn foundry-toolchain-btn--action"
            >
              {loading ? "CHECKING…" : "RE-CHECK"}
            </button>
          </div>
        </div>
      )}

      {actionError && (
        <p className="text-[7px] font-mono text-red-400/80 break-all">{actionError}</p>
      )}
    </div>
  );
}