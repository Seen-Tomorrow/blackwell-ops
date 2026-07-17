/**
 * CONFIG → UPDATES — App / Full install / plugin engine catalog.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  BinaryUpdateInfo,
  DownloadTask,
  PluginCatalogResponse,
  PluginProfileOffering,
  ProviderConfig,
  UpdateChannelOffering,
  UpdateOfferings,
} from "@/lib/types";
import { DEFAULT_PROVIDER_ID } from "@/lib/types";
import { BINARY_UPDATES_ENABLED } from "@/lib/foundry_constants";
import { useDownloadTasks } from "@/hooks/useDownloadTasks";
import { useTauriListen } from "@/hooks/useTauriListen";
import DownloadProgressRow from "./DownloadProgressRow";
import { dispatchAppEvent, EVENTS } from "@/lib/events";
import { ReleaseNotesBody } from "@/lib/releaseNotes";
import { cudaArchOptimizedLabel, resolveProfileCudaArchitectures } from "@/lib/cudaArchUtils";

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

type RowStatus = "idle" | "busy" | "error" | "done";

interface AppRow {
  id: string;
  channel: string;
  label: string;
  summary: string;
  installed: string;
  latest: string;
  sizeBytes: number;
  available: boolean;
  recommended: boolean;
  releaseNotes: string | null;
}

interface EngineGroupCard {
  id: string;
  label: string;
  summary: string;
  plugin: boolean;
  profiles: PluginProfileOffering[];
}

function pluginBusy(pluginId: string, tasks: DownloadTask[]): boolean {
  return tasks.some(
    (t) => t.taskKind === "provider" && (t.hfAuthor === pluginId || t.quantType?.startsWith(`${pluginId}:`)),
  );
}

function profileActionLabel(row: PluginProfileOffering, isCore = false): string {
  if (!row.packAvailable) {
    return isCore ? "Via Full install" : "Unavailable";
  }
  if (!row.installed) return "Install";
  if (row.updateAvailable) return "Update";
  return "Current";
}

function profileActionEnabled(row: PluginProfileOffering): boolean {
  return row.packAvailable && (!row.installed || row.updateAvailable);
}

function formatPackVersion(v: string): string {
  const t = v.trim();
  if (!t) return "";
  return t.startsWith("v") || t.startsWith("V") ? t : `v${t}`;
}

/** Release-style installed tag only; drop foundry/git noise like `1 (57f6b93)`. */
function formatInstalledTag(v: string | null | undefined): string {
  if (!v?.trim()) return "";
  const n = v.trim();
  if (/\(|disk-scanned|unknown|bundled|local/i.test(n)) return "";
  const bare = n.replace(/^v/i, "");
  if (!/^\d+(\.\d+)*/.test(bare)) return "";
  return n.startsWith("v") || n.startsWith("V") ? n : `v${n}`;
}

function archHint(row: PluginProfileOffering): string {
  const codes = row.cudaArchitectures?.filter(Boolean) ?? [];
  if (codes.length === 0) return "";
  return cudaArchOptimizedLabel(codes) ?? "";
}

export default function UpdatesConfig({
  offerings: offeringsProp,
  onRefreshOfferings,
  onBinaryUpdatesChange,
}: {
  offerings: UpdateOfferings | null;
  onRefreshOfferings?: () => void | Promise<void>;
  onBinaryUpdatesChange?: (hasUpdates: boolean) => void;
}) {
  const [offerings, setOfferings] = useState<UpdateOfferings | null>(offeringsProp);
  const [catalog, setCatalog] = useState<PluginCatalogResponse | null>(null);
  const [coreProfiles, setCoreProfiles] = useState<PluginProfileOffering[]>([]);
  const [loading, setLoading] = useState(false);
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [globalError, setGlobalError] = useState<string | null>(null);

  const appTasks = useDownloadTasks("app");
  const providerTasks = useDownloadTasks("provider");
  const activeTasks = useMemo(
    () =>
      [...appTasks, ...providerTasks].filter((t) =>
        ["queued", "downloading", "paused", "scanning"].includes(t.status),
      ) as DownloadTask[],
    [appTasks, providerTasks],
  );

  useEffect(() => {
    setOfferings(offeringsProp);
  }, [offeringsProp]);

  const refreshAll = useCallback(async () => {
    if (!BINARY_UPDATES_ENABLED) return;
    setLoading(true);
    setGlobalError(null);
    try {
      const [off, cat, coreUpdates, providers] = await Promise.all([
        invoke<UpdateOfferings>("get_update_offerings"),
        invoke<PluginCatalogResponse>("get_plugin_catalog"),
        invoke<BinaryUpdateInfo[]>("check_binary_updates", { providerId: DEFAULT_PROVIDER_ID }),
        invoke<ProviderConfig[]>("list_providers").catch(() => [] as ProviderConfig[]),
      ]);
      setOfferings(off);
      setCatalog(cat);
      await onRefreshOfferings?.();

      const coreProv = providers.find((p) => p.id === DEFAULT_PROVIDER_ID);
      const coreRows: PluginProfileOffering[] = coreUpdates.map((u) => {
        const bi =
          coreProv?.buildInfoPerEnv?.[u.profile] ??
          coreProv?.bundledBuildInfoPerEnv?.[u.profile] ??
          coreProv?.foundryBuildInfoPerEnv?.[u.profile];
        const arches = coreProv
          ? resolveProfileCudaArchitectures(coreProv, bi)
          : (bi?.cudaArchitectures ?? []);
        const hasBin = !!(
          coreProv?.binaryPathPerEnv?.[u.profile] ||
          coreProv?.bundledBinaryPathPerEnv?.[u.profile] ||
          coreProv?.foundryBinaryPathPerEnv?.[u.profile]
        );
        const packOk = u.packAvailable ?? !!u.latestVersion;
        return {
          profile: u.profile,
          profileLabel: u.profileLabel,
          packAvailable: packOk,
          packVersion: packOk && u.latestVersion ? formatPackVersion(u.latestVersion) : "",
          sizeBytes: 0,
          installed: hasBin || !!u.installedVersion,
          installedVersion: formatInstalledTag(u.installedVersion) || null,
          updateAvailable: u.available,
          cudaArchitectures: arches,
          cudaVersion: bi?.cudaVersion ?? null,
        };
      });
      setCoreProfiles(coreRows);

      // Header/CONFIG highlight: app channel update OR versioned upgrade of installed engines.
      // Optional plugins not yet installed stay in the catalog UI without lighting the badge.
      const catalogPending = cat.plugins.some((p) =>
        p.profiles.some((r) => r.updateAvailable),
      );
      const corePending = coreRows.some((r) => r.updateAvailable);
      onBinaryUpdatesChange?.(catalogPending || corePending || !!off.anyAvailable);
    } catch (e) {
      setGlobalError(typeof e === "string" ? e : "Failed to check updates (offline?)");
    } finally {
      setLoading(false);
    }
  }, [onRefreshOfferings, onBinaryUpdatesChange]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const onDone = () => {
      void refreshAll();
    };
    window.addEventListener(EVENTS.updateOfferingsRefresh, onDone);
    return () => window.removeEventListener(EVENTS.updateOfferingsRefresh, onDone);
  }, [refreshAll]);

  // After provider pack extract+activate, refresh catalog (enqueue alone is not enough).
  const onProviderPackDone = useCallback(() => {
    setRowStatus((s) => {
      const n = { ...s };
      for (const k of Object.keys(n)) {
        if (k.startsWith("engine:")) n[k] = "done";
      }
      return n;
    });
    dispatchAppEvent(EVENTS.reloadProviders);
    void refreshAll();
  }, [refreshAll]);

  useTauriListen<{ type?: string; taskKind?: string }>("download-event", (payload) => {
    if (payload?.type === "completed" && payload?.taskKind === "provider") {
      onProviderPackDone();
    }
  });

  useTauriListen<{ status?: string }>("binary-update:download-complete", () => {
    onProviderPackDone();
  });

  // Detect provider task finishing via poll (covers missed events).
  const prevProviderActive = useRef(0);
  useEffect(() => {
    const active = providerTasks.filter((t) =>
      ["queued", "downloading", "paused", "scanning"].includes(t.status),
    ).length;
    const completed = providerTasks.filter((t) => t.status === "completed").length;
    if (prevProviderActive.current > 0 && active === 0 && completed > 0) {
      onProviderPackDone();
    }
    prevProviderActive.current = active;
  }, [providerTasks, onProviderPackDone]);

  const appRows: AppRow[] = useMemo(() => {
    const list: AppRow[] = [];
    const current = offerings?.currentVersion ?? "?";
    if (!offerings) return list;

    for (const off of [offerings.appOnly, offerings.fullBundle] as UpdateChannelOffering[]) {
      list.push({
        id: `app:${off.channel}`,
        channel: off.channel,
        label: off.label,
        summary: off.summary,
        installed: `v${current}`,
        latest: off.available ? `v${off.version}` : `v${current}`,
        sizeBytes: off.sizeBytes,
        available: off.available,
        recommended: offerings.recommended === off.channel,
        releaseNotes: off.releaseNotes,
      });
    }
    return list;
  }, [offerings]);

  const engineCards: EngineGroupCard[] = useMemo(() => {
    const cards: EngineGroupCard[] = [];
    if (coreProfiles.length > 0) {
      const anyCorePack = coreProfiles.some((p) => p.packAvailable);
      cards.push({
        id: DEFAULT_PROVIDER_ID,
        label: "GGML Master",
        summary: anyCorePack
          ? "Core engine — CORE_* profile packs when published; otherwise refresh via Full install."
          : "Core engine — ships inside Full NSIS (CORE_*Setup). Separate CORE_ggml-master packs only when published.",
        plugin: false,
        profiles: coreProfiles,
      });
    }
    for (const plugin of catalog?.plugins ?? []) {
      cards.push({
        id: plugin.id,
        label: plugin.displayName,
        summary: plugin.description,
        plugin: true,
        profiles: plugin.profiles,
      });
    }
    return cards;
  }, [catalog, coreProfiles]);

  const handleAppInstall = useCallback(async (channel: string, rowId: string) => {
    setRowStatus((s) => ({ ...s, [rowId]: "busy" }));
    setRowError((e) => {
      const n = { ...e };
      delete n[rowId];
      return n;
    });
    try {
      await invoke("install_app_update", { channel });
      setRowStatus((s) => ({ ...s, [rowId]: "done" }));
    } catch (err) {
      const msg = typeof err === "string" ? err : "Download failed";
      setRowStatus((s) => ({ ...s, [rowId]: "error" }));
      setRowError((e) => ({ ...e, [rowId]: msg }));
    }
  }, []);

  const handleProfilesInstall = useCallback(
    async (providerId: string, profiles: string[], rowKey: string) => {
      setRowStatus((s) => ({ ...s, [rowKey]: "busy" }));
      setRowError((e) => {
        const n = { ...e };
        delete n[rowKey];
        return n;
      });
      try {
        for (const profile of profiles) {
          await invoke("download_binary_update", { providerId, profile });
        }
        // Stay busy until download-event / task poll sees complete (see listeners above).
        setRowStatus((s) => ({ ...s, [rowKey]: "busy" }));
      } catch (err) {
        const msg = typeof err === "string" ? err : "Download failed";
        setRowStatus((s) => ({ ...s, [rowKey]: "error" }));
        setRowError((e) => ({ ...e, [rowKey]: msg }));
      }
    },
    [],
  );

  if (!BINARY_UPDATES_ENABLED) {
    return (
      <div className="flex-1 p-4 text-[10px] font-mono config-muted">
        Release updates are disabled in this build.
      </div>
    );
  }

  const renderAppCard = (row: AppRow) => {
    const isFull = row.channel === "full_bundle";
    const accent = isFull ? "border-nv-green/30" : "border-yellow-400/30";
    const titleColor = isFull ? "text-nv-green" : "text-yellow-400";
    const rowBusy = activeTasks.some((t) => t.taskKind === "app") || rowStatus[row.id] === "busy";
    const updateAccent = row.available
      ? "ring-1 ring-yellow-400/40 border-yellow-400/45 bg-yellow-400/[0.06]"
      : accent;

    return (
      <div
        key={row.id}
        className={`config-form-panel rounded-sm border p-4 space-y-3 ${updateAccent}`}
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[10px] font-mono font-bold uppercase tracking-wider ${titleColor}`}>
                {row.label}
              </span>
              <span className="text-[7px] font-mono px-1 py-0.5 rounded-sm border border-nv-green/30 text-nv-green/80 uppercase tracking-wider">
                CORE
              </span>
              {row.available && (
                <span className="text-[7px] font-mono px-1.5 py-0.5 rounded-sm border border-yellow-400/50 bg-yellow-400/15 text-yellow-300 uppercase tracking-wider">
                  Update available
                </span>
              )}
            </div>
            <p className="text-[9px] font-mono config-muted leading-relaxed max-w-xl">{row.summary}</p>
          </div>
          <div className="text-right shrink-0 text-[9px] font-mono config-muted">
            {row.installed} →{" "}
            <span className={row.available ? "text-yellow-400/90 font-bold" : "text-white/60"}>{row.latest}</span>
            {row.sizeBytes > 0 ? ` · ${formatSize(row.sizeBytes)}` : ""}
          </div>
        </div>
        {row.releaseNotes && (
          <details>
            <summary className="text-[8px] font-mono text-stealth-muted/55 cursor-pointer uppercase tracking-wider">
              Release notes
            </summary>
            <div className="mt-2 pt-2 border-t border-white/[0.06]">
              <ReleaseNotesBody text={row.releaseNotes} />
            </div>
          </details>
        )}
        {rowError[row.id] && <p className="text-[9px] font-mono text-telemetry-red">{rowError[row.id]}</p>}
        <button
          type="button"
          disabled={rowBusy || !row.available}
          onClick={() => void handleAppInstall(row.channel, row.id)}
          className={`text-[9px] font-mono uppercase tracking-wider px-3 py-1.5 rounded-sm border disabled:opacity-35 ${
            row.available
              ? isFull
                ? "value-chip-active border-nv-green/40"
                : "border-yellow-400/40 text-yellow-400 hover:bg-yellow-400/10"
              : "value-chip border-white/10 text-stealth-muted/45"
          }`}
        >
          {row.available ? `Download ${row.label}` : "Up to date"}
        </button>
      </div>
    );
  };

  const renderEngineCard = (card: EngineGroupCard) => {
    const rowKey = `engine:${card.id}`;
    const busy = pluginBusy(card.id, activeTasks) || rowStatus[rowKey] === "busy";
    const frontier = card.profiles.find((p) => p.profile === "frontier");
    const stable = card.profiles.find((p) => p.profile === "stable");
    const bothProfiles = card.profiles.filter((p) => profileActionEnabled(p)).map((p) => p.profile);
    const anyAction = card.profiles.some((p) => profileActionEnabled(p));
    const anyUpdate = card.profiles.some((p) => p.updateAvailable);
    const anyInstallable = card.profiles.some((p) => p.packAvailable && !p.installed);
    const cardAccent = anyUpdate
      ? "border-yellow-400/45 ring-1 ring-yellow-400/35 bg-yellow-400/[0.05]"
      : anyInstallable
        ? "border-yellow-400/20"
        : card.plugin
          ? "border-white/12"
          : "border-nv-green/25";

    const renderProfilePill = (row: PluginProfileOffering | undefined) => {
      if (!row) return null;
      const size = formatSize(row.sizeBytes);
      const instTag = formatInstalledTag(row.installedVersion);
      const packTag = row.packAvailable && row.packVersion ? formatPackVersion(row.packVersion) : "";
      const arch = archHint(row);
      return (
        <div
          className={`flex items-start justify-between gap-2 text-[9px] font-mono config-muted rounded-sm px-1 py-0.5 ${
            row.updateAvailable ? "bg-yellow-400/10" : ""
          }`}
        >
          <span className="text-white/70 shrink-0 flex items-center gap-1.5">
            {row.profileLabel}
            {row.updateAvailable && (
              <span className="text-[7px] font-mono px-1 py-0.5 rounded-sm border border-yellow-400/50 text-yellow-300 uppercase tracking-wider">
                upd
              </span>
            )}
          </span>
          <span className="text-right leading-relaxed">
            {row.installed ? (
              <span className={row.updateAvailable ? "text-yellow-300/90" : "text-nv-green/80"}>
                installed
                {instTag ? (
                  <span className="text-stealth-muted/60"> · shipped {instTag}</span>
                ) : null}
                {row.updateAvailable && packTag ? (
                  <span className="text-yellow-400/90"> → pack {packTag}</span>
                ) : null}
              </span>
            ) : (
              <span className="text-stealth-muted/55">not installed</span>
            )}
            {packTag && !row.updateAvailable && !row.installed ? (
              <span className="text-stealth-muted/45">
                {" "}
                · pack {packTag}
                {size ? ` · ${size}` : ""}
              </span>
            ) : null}
            {packTag && !row.updateAvailable && row.installed && !instTag ? (
              <span className="text-stealth-muted/45">
                {" "}
                · pack {packTag}
                {size ? ` · ${size}` : ""}
              </span>
            ) : null}
            {!row.packAvailable && !card.plugin ? (
              <span className="block text-[8px] text-stealth-muted/45 mt-0.5">
                no CORE pack — use Full install
              </span>
            ) : null}
            {arch ? (
              <span className="block text-[8px] text-stealth-muted/50 mt-0.5">{arch}</span>
            ) : null}
            {row.cudaVersion ? (
              <span className="block text-[8px] text-stealth-muted/45">CUDA {row.cudaVersion}</span>
            ) : null}
          </span>
        </div>
      );
    };

    const actionBtnClass = (row: PluginProfileOffering) => {
      if (row.updateAvailable) {
        return "border-yellow-400/50 text-yellow-300 bg-yellow-400/10 hover:bg-yellow-400/15 disabled:opacity-35";
      }
      if (row.packAvailable && !row.installed) {
        return "border-yellow-400/30 text-yellow-400/90 hover:bg-yellow-400/10 disabled:opacity-35";
      }
      return "border-white/20 text-white/80 hover:bg-white/5 disabled:opacity-35";
    };

    return (
      <div key={card.id} className={`config-form-panel rounded-sm border p-4 space-y-3 ${cardAccent}`}>
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono text-white/90">{card.label}</span>
            {card.plugin ? (
              <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm border border-white/15 text-stealth-muted/70 uppercase tracking-wider">
                PLUGIN
              </span>
            ) : (
              <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm border border-nv-green/35 text-nv-green/85 uppercase tracking-wider">
                CORE
              </span>
            )}
            {anyUpdate && (
              <span className="text-[7px] font-mono px-1.5 py-0.5 rounded-sm border border-yellow-400/50 bg-yellow-400/15 text-yellow-300 uppercase tracking-wider">
                Update available
              </span>
            )}
          </div>
          <p className="text-[9px] font-mono config-muted leading-relaxed">{card.summary}</p>
        </div>

        <div className="space-y-1 rounded-sm border border-white/[0.06] bg-black/20 px-2.5 py-2">
          {renderProfilePill(frontier)}
          {renderProfilePill(stable)}
        </div>

        {rowError[rowKey] && <p className="text-[9px] font-mono text-telemetry-red">{rowError[rowKey]}</p>}

        <div className="flex flex-wrap gap-2">
          {frontier && (
            <button
              type="button"
              disabled={busy || !profileActionEnabled(frontier)}
              onClick={() => void handleProfilesInstall(card.id, ["frontier"], rowKey)}
              className={`text-[9px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border ${actionBtnClass(frontier)}`}
              title={
                !frontier.packAvailable && !card.plugin
                  ? "Core engines refresh via Full install unless CORE_ggml-master packs are published"
                  : undefined
              }
            >
              {profileActionLabel(frontier, !card.plugin)} Frontier
            </button>
          )}
          {stable && (
            <button
              type="button"
              disabled={busy || !profileActionEnabled(stable)}
              onClick={() => void handleProfilesInstall(card.id, ["stable"], rowKey)}
              className={`text-[9px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border ${actionBtnClass(stable)}`}
              title={
                !stable.packAvailable && !card.plugin
                  ? "Core engines refresh via Full install unless CORE_ggml-master packs are published"
                  : undefined
              }
            >
              {profileActionLabel(stable, !card.plugin)} Stable
            </button>
          )}
          {frontier && stable && bothProfiles.length > 1 && (
            <button
              type="button"
              disabled={busy || !anyAction}
              onClick={() => void handleProfilesInstall(card.id, bothProfiles, rowKey)}
              className="text-[9px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border border-yellow-400/35 text-yellow-400/90 hover:bg-yellow-400/10 disabled:opacity-35"
            >
              {bothProfiles.every((p) => {
                const row = card.profiles.find((x) => x.profile === p);
                return row && !row.installed;
              })
                ? "Install"
                : "Update"}{" "}
              Both
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0 max-w-2xl">
          <h2 className="text-xs font-mono theme-accent-text tracking-widest">UPDATES</h2>
          <p className="text-[10px] font-mono config-muted mt-1 leading-relaxed">
            App refresh updates the plugin catalog. Install engines here — they appear in PROVIDERS after download.
            Foundry build still works for installed plugins.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={loading}
          className="value-chip text-[9px] font-mono tracking-wider uppercase px-3 py-1 rounded-sm disabled:opacity-40"
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {activeTasks.length > 0 && (
        <div className="px-4 py-2.5 space-y-1.5 border-b border-white/[0.06] bg-black/15">
          {activeTasks.map((t) => (
            <DownloadProgressRow key={t.id} task={t} compact />
          ))}
        </div>
      )}

      {globalError && <p className="px-4 py-2 text-[10px] font-mono text-telemetry-red">{globalError}</p>}

      <div className="flex-1 overflow-auto px-4 py-4 space-y-6">
        <section className="space-y-3">
          <h3 className="text-[10px] font-mono theme-accent-text tracking-wider uppercase">Application</h3>
          {appRows.length > 0 ? (
            <div className="grid gap-3 lg:grid-cols-2">{appRows.map(renderAppCard)}</div>
          ) : (
            <p className="text-[10px] font-mono config-muted">No app catalog yet.</p>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-[10px] font-mono theme-accent-text tracking-wider uppercase">Engine catalog</h3>
          {engineCards.length > 0 ? (
            <div className="grid gap-3 lg:grid-cols-2">{engineCards.map(renderEngineCard)}</div>
          ) : (
            <p className="text-[10px] font-mono config-muted">
              No plugin catalog yet — ship an App update with runtime/catalog/plugins.json.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}