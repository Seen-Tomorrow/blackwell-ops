import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DownloadTask, UpdateChannelOffering, UpdateOfferings } from "@/lib/types";
import DownloadProgressRow from "./DownloadProgressRow";
import { useDownloadTasks } from "@/hooks/useDownloadTasks";

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

interface OfferingCardProps {
  offering: UpdateChannelOffering;
  recommended: boolean;
  enginesMissing: boolean;
  onInstall: (channel: string) => void;
  busy: boolean;
}

function OfferingCard({
  offering,
  recommended,
  enginesMissing,
  onInstall,
  busy,
}: OfferingCardProps) {
  const isFull = offering.channel === "full_bundle";
  const accent = isFull ? "border-nv-green/40" : "border-yellow-400/40";
  const titleColor = isFull ? "text-nv-green" : "text-yellow-400";
  // labels come from backend (App update / Full install)

  return (
    <div
      className={`rounded-sm border bg-black/30 p-2 space-y-1.5 ${accent} ${
        recommended ? "ring-1 ring-white/10" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[8px] font-mono font-bold uppercase tracking-wider ${titleColor}`}>
              {offering.label}
            </span>
            {recommended && (
              <span className="text-[6px] font-mono uppercase tracking-wider text-white/50 border border-white/15 px-1 rounded-sm">
                suggested
              </span>
            )}
            {enginesMissing && isFull && (
              <span className="text-[6px] font-mono uppercase tracking-wider text-red-300/90 border border-red-400/30 px-1 rounded-sm">
                engines needed
              </span>
            )}
          </div>
          <p className="text-[7px] font-mono text-white/55 leading-relaxed mt-0.5">
            {offering.summary}
          </p>
        </div>
        {offering.available && (
          <span className="shrink-0 text-[7px] font-mono text-stealth-muted/50">
            v{offering.version}
            {offering.sizeBytes > 0 ? ` · ${formatSize(offering.sizeBytes)}` : ""}
          </span>
        )}
      </div>
      {offering.available ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onInstall(offering.channel)}
          className={`w-full rounded-sm border px-2 py-1 text-[7px] font-mono uppercase tracking-wider transition-colors disabled:opacity-40 ${
            isFull
              ? "border-nv-green/40 text-nv-green hover:bg-nv-green/10"
              : "border-yellow-400/40 text-yellow-400 hover:bg-yellow-400/10"
          }`}
        >
          Download {offering.label}
        </button>
      ) : (
        <p className="text-[7px] font-mono text-stealth-muted/40">Up to date on this channel</p>
      )}
    </div>
  );
}

interface AppUpdateMenuProps {
  offerings: UpdateOfferings | null;
  onRefresh?: () => void;
}

export default function AppUpdateMenu({ offerings, onRefresh }: AppUpdateMenuProps) {
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

  const handleInstall = useCallback(
    async (channel: string) => {
      setError(null);
      try {
        await invoke("install_app_update", { channel });
        setOpen(false);
      } catch (err) {
        const msg = typeof err === "string" ? err : "Update failed";
        setError(msg);
        console.error("App update install failed:", err);
      }
    },
    [],
  );

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

  if (!offerings?.anyAvailable && !activeTask) {
    return null;
  }

  if (activeTask) {
    return (
      <div className="w-[240px] flex-shrink-0">
        <DownloadProgressRow task={activeTask} compact />
      </div>
    );
  }

  const enginesMissing = !offerings?.enginesAvailable;

  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          onRefresh?.();
        }}
        className="app-header-update-btn text-[7px] font-mono tracking-wider text-yellow-400 hover:text-yellow-300 transition-colors cursor-pointer whitespace-nowrap"
      >
        UPDATE
      </button>
      {open && offerings && (
        <div className="absolute top-full right-0 mt-1 w-[320px] z-[9999] rounded-sm border border-yellow-400/35 bg-[#080812] shadow-2xl p-2.5 space-y-2">
          <div className="space-y-0.5">
            <div className="text-[8px] font-mono text-yellow-400 tracking-wider uppercase">
              Updates available
            </div>
            <p className="text-[7px] font-mono text-white/45 leading-relaxed">
              Comparing as v{offerings.currentVersion}
              {enginesMissing
                ? " · no engine runtimes detected — Full Bundle recommended"
                : " · engines ready — App-Only is usually enough"}
            </p>
          </div>
          <OfferingCard
            offering={offerings.appOnly}
            recommended={offerings.recommended === "app_only"}
            enginesMissing={enginesMissing}
            onInstall={handleInstall}
            busy={!!activeTask}
          />
          <OfferingCard
            offering={offerings.fullBundle}
            recommended={offerings.recommended === "full_bundle"}
            enginesMissing={enginesMissing}
            onInstall={handleInstall}
            busy={!!activeTask}
          />
          {error && (
            <p className="text-[7px] font-mono text-red-400/80">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}