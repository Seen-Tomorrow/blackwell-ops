// Config tab shell — routes between sub-tabs. The PARAMETERS editor lives in
// ParamConfigPanel; this file keeps only the tab bar, the sub-tab switch, and
// the self-contained PATHS (model paths) panel.

import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProviderConfig, ModelPathEntry, PathDiskUsage, UpdateOfferings } from "../lib/types";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import ProvidersConfig from "./ProvidersConfig";
import SecretsConfig from "./SecretsConfig";
import RecoveryConfig from "./RecoveryConfig";
import UpdatesConfig from "./UpdatesConfig";
import DistributionDevPanel from "./DistributionDevPanel";
import ParamConfigPanel from "./ParamConfigPanel";
import TabPageHeader from "./TabPageHeader";
import {
  cyclePowerUserState,
  isEditorUnlocked,
  loadPowerUserState,
  savePowerUserState,
  loadConfigDevPreviewAsUser,
  type PowerUserState,
} from "../lib/storage";
import {
  consumePendingConfigSubTab,
  dispatchPowerUserChanged,
  dispatchAppEvent,
  EVENTS,
  type NavigateConfigDetail,
} from "../lib/events";
import type { SetupGuideState } from "../hooks/useSetupGuide";
import { isDevBuild } from "../lib/build";
import {
  resolveConfigActor,
  type ConfigActor,
} from "../lib/systemParams";

type ConfigSubTab = "providers" | "params" | "paths" | "secrets" | "recovery" | "updates" | "distribution";

interface ConfigPageProps {
  providers?: ProviderConfig[];
  setupGuide: SetupGuideState;
  updateOfferings?: UpdateOfferings | null;
  onRefreshUpdateOfferings?: () => void | Promise<void>;
  onBinaryUpdatesChange?: (hasUpdates: boolean) => void;
  /** Amber nav pulse — also badges UPDATES sub-tab. */
  hasBinaryUpdates?: boolean;
}

export default function ConfigPage({
  providers: externalProviders,
  setupGuide,
  updateOfferings,
  onRefreshUpdateOfferings,
  onBinaryUpdatesChange,
  hasBinaryUpdates = false,
}: ConfigPageProps) {
  const [subTab, setSubTab] = useState<ConfigSubTab>(() => consumePendingConfigSubTab() ?? "providers");
  const [selectedProviderId, setSelectedProviderId] = useState<string>(DEFAULT_PROVIDER_ID);
  const [allProviders, setAllProviders] = useState<ProviderConfig[]>(externalProviders || []);
  // Power-user tri-state — synced with Layout.tsx header toggle
  const [powerUserState, setPowerUserState] = useState<PowerUserState>(loadPowerUserState);
  const editorUnlocked = isEditorUnlocked(powerUserState);
  const factoryExportEnabled = isDevBuild();
  /** DEV: preview CONFIG as user (restricted) vs unrestricted. */
  const [devPreviewAsUser, setDevPreviewAsUser] = useState(loadConfigDevPreviewAsUser);
  const configActor: ConfigActor = useMemo(
    () =>
      resolveConfigActor({
        editorUnlocked,
        isDev: isDevBuild(),
        devPreviewAsUser,
      }),
    [editorUnlocked, devPreviewAsUser],
  );

  useEffect(() => {
    const handler = () => setPowerUserState(loadPowerUserState());
    window.addEventListener(EVENTS.powerUserChanged, handler);
    return () => window.removeEventListener(EVENTS.powerUserChanged, handler);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<NavigateConfigDetail>).detail;
      if (detail?.subTab) setSubTab(detail.subTab);
    };
    window.addEventListener(EVENTS.navigateConfig, handler);

    return () => window.removeEventListener(EVENTS.navigateConfig, handler);
  }, []);

  useEffect(() => {
    if (setupGuide.active && setupGuide.phase === "paths") {
      setSubTab("paths");
    }
  }, [setupGuide.active, setupGuide.phase]);

  const handleEditorToggle = useCallback(() => {
    setPowerUserState(prev => {
      const next = cyclePowerUserState(prev);
      savePowerUserState(next);
      dispatchPowerUserChanged();
      return next;
    });
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden" data-config-page>
      <TabPageHeader title="CONFIG" />
      <div className="px-4 py-1 config-section-bar flex items-center gap-1">
        <button onClick={() => setSubTab("providers")} className={`app-nav-tab px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${subTab === "providers" ? "app-nav-tab-active" : ""}`}>PROVIDERS &amp; FOUNDRY</button>
        <button onClick={() => setSubTab("params")} className={`app-nav-tab px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${subTab === "params" ? "app-nav-tab-active" : ""}`}>PARAMETERS</button>
        <button onClick={() => setSubTab("paths")} data-onboarding="paths-tab" className={`app-nav-tab px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${subTab === "paths" ? "app-nav-tab-active" : ""}`}>PATHS</button>
        <button
          onClick={() => setSubTab("updates")}
          className={`relative app-nav-tab px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${subTab === "updates" ? "app-nav-tab-active" : ""}`}
          title={hasBinaryUpdates ? "Runtime / app packs available" : undefined}
        >
          UPDATES
          {hasBinaryUpdates && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-yellow-400 rounded-full animate-pulse" aria-hidden />
          )}
        </button>
        {factoryExportEnabled && (
          <button onClick={() => setSubTab("distribution")} className={`app-nav-tab px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${subTab === "distribution" ? "app-nav-tab-active" : ""}`}>DISTRIBUTION</button>
        )}
        <button onClick={() => setSubTab("secrets")} className={`app-nav-tab px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${subTab === "secrets" ? "app-nav-tab-active" : ""}`}>SECRETS</button>
        <button onClick={() => setSubTab("recovery")} className={`app-nav-tab px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${subTab === "recovery" ? "app-nav-tab-active" : ""}`}>RECOVERY</button>
       </div>

       {subTab === "providers" ? (
         <div className="flex-1 flex flex-col overflow-hidden min-h-0">
           <ProvidersConfig providers={allProviders} onProvidersChange={setAllProviders} />
         </div>
       ) : subTab === "updates" ? (
         <div className="flex-1 flex flex-col overflow-hidden min-h-0">
           <UpdatesConfig
             offerings={updateOfferings ?? null}
             onRefreshOfferings={onRefreshUpdateOfferings}
             onBinaryUpdatesChange={onBinaryUpdatesChange}
           />
         </div>
       ) : subTab === "distribution" && factoryExportEnabled ? (
         <div className="flex-1 flex flex-col overflow-hidden min-h-0">
           <DistributionDevPanel />
         </div>
       ) : subTab === "paths" ? (
         <ModelPathsPanel />
       ) : subTab === "secrets" ? (
         <SecretsConfig />
       ) : subTab === "recovery" ? (
         <RecoveryConfig />
       ) : (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <ParamConfigPanel
            providers={allProviders}
            selectedProviderId={selectedProviderId}
            setSelectedProviderId={setSelectedProviderId}
            onProvidersChange={setAllProviders}
            editorUnlocked={editorUnlocked}
            configActor={configActor}
            factoryExportEnabled={factoryExportEnabled}
            devPreviewAsUser={devPreviewAsUser}
            setDevPreviewAsUser={setDevPreviewAsUser}
            powerUserState={powerUserState}
            setPowerUserState={setPowerUserState}
            onEditorToggle={handleEditorToggle}
          />
        </div>
       )}

    </div>
  );
}

// ── Model Paths Panel ────────────────────────────────────────────────

function displayModelPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  }
  if (path.startsWith("\\\\?\\")) {
    return path.slice("\\\\?\\".length);
  }
  return path;
}

function normalizeModelPathKey(path: string): string {
  return displayModelPath(path).replace(/[/\\]+$/, "").toLowerCase();
}

function dedupeModelPaths(paths: ModelPathEntry[]): ModelPathEntry[] {
  const out: ModelPathEntry[] = [];
  for (const entry of paths) {
    const key = normalizeModelPathKey(entry.path);
    const idx = out.findIndex((e) => normalizeModelPathKey(e.path) === key);
    if (idx >= 0) {
      if (entry.isDefault) {
        out[idx] = { ...out[idx], isDefault: true };
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function ModelPathsPanel() {
  const [paths, setPaths] = useState<ModelPathEntry[]>([]);
  const [diskUsage, setDiskUsage] = useState<PathDiskUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [pathError, setPathError] = useState<string | null>(null);

  const loadPaths = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([
        invoke<ModelPathEntry[]>("list_model_paths"),
        invoke<PathDiskUsage[]>("get_disk_usage"),
      ]);
      setPaths(dedupeModelPaths(p));
      setDiskUsage(d);
    } catch (e) {
      console.error("Failed to load model paths:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPaths(); }, [loadPaths]);

  const handleAddPath = useCallback(async () => {
    try {
      setPathError(null);
      const selected: string | null = await invoke("open_folder_dialog", { title: "Select Model Folder" });
      if (selected) {
        await invoke("add_model_path", { path: selected, label: null });
        loadPaths();
        dispatchAppEvent(EVENTS.modelPathsChanged);
      }
    } catch (e) {
      console.error("Failed to add model path:", e);
      setPathError(typeof e === "string" ? e : "Failed to add model path");
    }
  }, [loadPaths]);

  const handleRemovePath = useCallback(async (path: string) => {
    if (paths.length <= 1) {
      setPathError("Add another folder before removing the last model path.");
      return;
    }
    try {
      setPathError(null);
      await invoke("remove_model_path", { path });
      loadPaths();
      dispatchAppEvent(EVENTS.modelPathsChanged);
    } catch (e) {
      const msg = typeof e === "string" ? e : "Failed to remove model path";
      console.error("Failed to remove model path:", msg);
      setPathError(msg);
    }
  }, [loadPaths, paths.length]);

  const handleSetDefault = useCallback(async (path: string) => {
    try {
      await invoke("set_default_model_path", { path });
      loadPaths();
      dispatchAppEvent(EVENTS.modelPathsChanged);
    } catch (e) {
      console.error("Failed to set default model path:", e);
    }
  }, [loadPaths]);

  const getUsage = useCallback((path: string): PathDiskUsage | undefined => {
    return diskUsage.find(d => d.path === path);
  }, [diskUsage]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-[10px] font-mono text-stealth-muted animate-pulse">LOADING PATHS...</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-stealth-border flex items-center justify-between">
        <h2 className="text-xs font-mono text-nv-green tracking-wider">MODEL PATHS</h2>
        <button
          onClick={handleAddPath}
          data-onboarding="add-folder"
          className="px-3 py-1 text-[9px] font-mono border border-nv-green/60 text-nv-green hover:bg-nv-green/15 transition-colors"
        >
          + ADD FOLDER
        </button>
      </div>

      {pathError && (
        <div className="px-4 py-2 border-b border-telemetry-red/30 bg-telemetry-red/5 text-[9px] font-mono text-telemetry-red">
          {pathError}
        </div>
      )}

      {/* Path list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {paths.length === 0 && (
          <div className="text-center py-8 text-[10px] font-mono text-stealth-muted">
            NO PATHS CONFIGURED — ADD A FOLDER TO GET STARTED
          </div>
        )}

        {paths.map((entry) => {
          const usage = getUsage(entry.path);
          return (
            <div key={entry.path}
              className={`border rounded-sm p-3 transition-colors ${entry.isDefault ? "border-nv-green/40 bg-nv-green/5" : "border-stealth-border bg-stealth-surface/50"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {entry.isDefault && (
                      <span className="text-[8px] font-mono text-nv-green bg-nv-green/15 px-1.5 py-0.5 rounded-sm">DEFAULT</span>
                    )}
                    <span className="text-[10px] font-mono text-white truncate">{entry.label || entry.path}</span>
                  </div>
                  <div className="text-[9px] font-mono text-stealth-muted truncate">{displayModelPath(entry.path)}</div>
                  {usage && (
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className="text-[8px] font-mono text-stealth-muted/70">
                        {usage.fileCount} models · {formatBytes(usage.totalGgufBytes)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {!entry.isDefault && (
                    <button onClick={() => handleSetDefault(entry.path)}
                      title="Set as default for download"
                      className="px-2 py-0.5 text-[8px] font-mono border border-yellow-400/30 text-yellow-400/70 hover:bg-yellow-400/10 transition-colors">
                      SET AS DEFAULT FOR DOWNLOAD
                    </button>
                  )}
                  <button
                    onClick={() => handleRemovePath(entry.path)}
                    disabled={paths.length <= 1}
                    title={
                      paths.length <= 1
                        ? "Add another folder before removing the last model path"
                        : "Remove this path"
                    }
                    className={`px-2 py-0.5 text-[8px] font-mono border border-red-400/30 text-red-400/70 transition-colors ${
                      paths.length <= 1
                        ? "opacity-30 cursor-not-allowed"
                        : "hover:bg-red-400/10"
                    }`}
                  >
                    REMOVE
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer hint */}
      <div className="px-4 py-2 border-t border-stealth-border text-[8px] font-mono text-stealth-muted/50">
        {paths.length === 0
          ? "ADD AT LEAST ONE FOLDER — CATALOG STAYS EMPTY UNTIL A PATH IS SET"
          : paths.length === 1
            ? `DOWNLOADS GO TO ${paths.find(p => p.isDefault)?.label || "DEFAULT PATH"} · ADD ANOTHER FOLDER TO ENABLE REMOVE`
            : `DOWNLOADS GO TO ${paths.find(p => p.isDefault)?.label || "DEFAULT PATH"} · CATALOG MERGES ALL PATHS`}
      </div>
    </div>
  );
}
