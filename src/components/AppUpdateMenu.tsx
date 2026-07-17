import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DownloadTask, UpdateOfferings } from "@/lib/types";
import DownloadProgressRow from "./DownloadProgressRow";
import { useDownloadTasks } from "@/hooks/useDownloadTasks";
import { BINARY_UPDATES_ENABLED } from "@/lib/foundry_constants";
import { dispatchNavigateConfig } from "@/lib/events";
import { ReleaseNotesBody } from "@/lib/releaseNotes";

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

interface AppUpdateMenuProps {
  offerings: UpdateOfferings | null;
  hasBinaryUpdates?: boolean;
  onRefresh?: () => void;
}

/** Header quick-settings: lean App update + link to Config UPDATES catalog. */
export default function AppUpdateMenu({
  offerings,
  hasBinaryUpdates = false,
  onRefresh,
}: AppUpdateMenuProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const appDownloads = useDownloadTasks("app");
  const activeTask = appDownloads.find((t) =>
    t.status === "queued" ||
    t.status === "downloading" ||
    t.status === "paused" ||
    t.status === "scanning",
  ) as DownloadTask | undefined;

  const appOffering = offerings?.appOnly;
  const anyAppUpdate = !!appOffering?.available;
  const highlight = anyAppUpdate || hasBinaryUpdates || !!activeTask;

  const handleInstall = useCallback(async () => {
    setError(null);
    try {
      await invoke("install_app_update", { channel: "app_only" });
      setOpen(false);
    } catch (err) {
      const msg = typeof err === "string" ? err : "Update failed";
      setError(msg);
      console.error("App update install failed:", err);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!BINARY_UPDATES_ENABLED) {
    return null;
  }

  if (activeTask && !open) {
    return (
      <div className="w-[200px] flex-shrink-0 max-w-[28vw]">
        <DownloadProgressRow task={activeTask} compact />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          onRefresh?.();
        }}
        className={`app-header-update-btn app-chrome-control-btn px-1.5 text-[8px] font-mono tracking-wider uppercase transition-colors leading-none relative ${
          highlight
            ? "text-yellow-400 hover:text-yellow-300"
            : "text-stealth-muted/70 hover:text-white/70"
        }`}
        title={
          highlight
            ? "Updates available — App pack here; engine packs in UPDATES catalog"
            : "App update (engine packs in Config → UPDATES)"
        }
      >
        UPDATE
        {highlight && (
          <span
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse"
            aria-hidden
          />
        )}
      </button>

      {open && (
        <div className="app-update-menu-popover absolute top-full right-0 mt-1.5 w-[320px] z-[9999] rounded-sm border border-yellow-400/30 shadow-2xl p-3 space-y-3">
          <div className="space-y-0.5">
            <div className="text-[10px] font-mono theme-accent-text tracking-wider uppercase">
              {anyAppUpdate ? "App update available" : "App update"}
            </div>
            <p className="text-[9px] font-mono config-muted leading-relaxed">
              {offerings
                ? `Running v${offerings.currentVersion}${
                    !offerings.enginesAvailable ? " · no engines on disk" : ""
                  }`
                : "Checking GitHub…"}
            </p>
          </div>

          {appOffering ? (
            <div
              className={`rounded-sm border p-2.5 space-y-2 ${
                appOffering.available
                  ? "border-yellow-400/35 bg-yellow-400/[0.04]"
                  : "border-white/10 bg-black/20"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-yellow-400">
                    {appOffering.label}
                  </span>
                  <p className="text-[9px] font-mono config-muted leading-relaxed">
                    {appOffering.summary}
                  </p>
                </div>
                {appOffering.available && (
                  <span className="shrink-0 text-[9px] font-mono text-yellow-400/85 tabular-nums">
                    v{appOffering.version}
                    {appOffering.sizeBytes > 0 ? ` · ${formatSize(appOffering.sizeBytes)}` : ""}
                  </span>
                )}
              </div>

              {appOffering.available ? (
                <button
                  type="button"
                  disabled={!!activeTask}
                  onClick={() => void handleInstall()}
                  className="w-full value-chip-active text-[9px] font-mono uppercase tracking-wider px-2 py-1.5 rounded-sm disabled:opacity-40"
                >
                  Download App update
                </button>
              ) : (
                <p className="text-[9px] font-mono config-muted">Up to date on this channel</p>
              )}

              {appOffering.releaseNotes && (
                <details className="group">
                  <summary className="text-[8px] font-mono text-stealth-muted/60 cursor-pointer hover:text-white/55 uppercase tracking-wider">
                    Release notes
                  </summary>
                  <div className="mt-1.5 pt-1.5 border-t border-white/[0.06] max-h-32 overflow-y-auto">
                    <ReleaseNotesBody text={appOffering.releaseNotes} />
                  </div>
                </details>
              )}
            </div>
          ) : (
            <p className="text-[9px] font-mono config-muted py-1">
              No release data yet. Try again when online.
            </p>
          )}

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              dispatchNavigateConfig({ subTab: "updates" });
            }}
            className="w-full text-left rounded-sm border border-white/12 bg-white/[0.03] px-2.5 py-2 text-[9px] font-mono text-white/65 hover:border-yellow-400/30 hover:text-yellow-400/90 transition-colors uppercase tracking-wider"
            title="Config → UPDATES — Full install, engine packs, full catalog"
          >
            Updates catalog →
          </button>

          {error && <p className="text-[9px] font-mono text-telemetry-red">{error}</p>}
        </div>
      )}
    </div>
  );
}